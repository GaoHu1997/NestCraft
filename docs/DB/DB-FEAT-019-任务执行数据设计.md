# DB-FEAT-019：任务执行数据设计

> 2026-11-21设计增量：[DB-CR047§2.2](DB-CR047-工作包义务与检查点.md#22-源变更重确认关联新批次和替代task)规定源变化重确认创建关联新批次／替代Task，仅受影响Story执行，旧快照和Task归属不可变、独立兄弟继续；新增替代关系与Task.budgetRootTaskId，沿同一逻辑根预算累计，不清零。本文UNIQUE(batchId,storyId)及原Task.snapshotId约束保持，增量r3独立逻辑评审通过，未迁移。

> CR-031现行r2以[事件审批与产物记录](DB-CR031-事件审批与产物记录.md)细化：完整InvocationBinding/普通sessionTurn、根调用每Attempt唯一而子Job共享父Attempt、子generation不改Task fence/currentAttemptId；暂停/可恢复blocked保activeKey，资源锁另判；原seq全局主键与项目cursor、内部Parent结果与外部通知、最终参数/effect去重和报告封存。本文Attempt/Task为业务根权威，子工作不得创建同Task并行Attempt。普通会话的资源/effect/budget按r2明确扩来源，不造Task；完整正文文件职责沿CR-028。[需求/WP与G-PLAN](../PRD/CR-031-受管执行可靠性需求与实施分解.md)、[契约](../LLD/LLD-CR031-受管执行可靠性契约.md)、[测试](../Test/TEST-CR031-受管执行可靠性验证.md)；只文档，表/迁移均未实施。

- 关联：[PRD-002](../PRD/PRD-002-需求派发与自主执行.md)、FEAT-018～020 / STORY-038～043、[ADR-003](../LLD/ADR-003-任务执行权威与调度边界.md)。
- 状态：2026-11-19 数据设计首版；**2026-11-23 已实施 M0 子集**（`execution_batch/task/step/attempt/dependency/event/checkpoint/work_package/work_package_story/obligation/obligation_mapping`，见 `src-tauri/src/commands/execution.rs` 与 [验证记录](../Test/REPORT-CR047-执行账本M0与写入保护验证.md)）；资源锁、槽、产物、证据、集成、交付与 outbox 仍为计划，未迁移、未真实执行。
- 共用范围：FEAT-018 使用批次/快照/活动任务/投影；FEAT-019 使用 DAG/步骤/租约/资源/effects；FEAT-020 使用产物/证据/集成/交付/outbox。不创建三份重复数据正文。

## 1. 权威、复用和存储边界

复用 [DB-FEAT-001](DB-FEAT-001-知识授权与工作台数据设计.md) 与现行 `src-tauri/src/db.rs` 中 project、requirement_index、配置、session、知识授权。Markdown 为需求/AC/Story状态权威，requirement_index 可重建；新执行数据为运行权威，不可从正文重建成成功记录，也不保存第二套可编辑需求正文。

选择同一本机 SQLite 的版本化 `execution_*` 表；runner 为单调度协调者，多客户端短事务读取/写入，WAL、foreign_keys=ON、busy timeout 有上限。长 CLI/网络/文件操作不持 DB 写事务。实际字段采用 camelCase 线格式，数据库物理命名以下为计划，落地时统一 migrations 与模型映射。

数据库、真实日志/快照/凭据不自动纳入项目 Git。元数据存 DB，大日志/产物与脱敏不可变快照存 app_data_dir/executions/<project>/<batch>/<task>/ 受管目录，URI 必须受检且 hash 可验；不开放任意系统文件读取。secretRef 只是引用，明文不进入表/日志/普通快照。

CR-028 现行分工见 [存储需求](../PRD/CR-028-文件与数据库按职责存储.md)／[共用数据约束](DB-FEAT-001-知识授权与工作台数据设计.md#cr-028文件与数据库分工现行增量)：完整 PRD／UI／方案、交付报告正文、证据资源与原始文档用文件；DB 只存状态、结构化清单／策略、结果摘要及受检 URI/hash。`payloadJson`、`designManifestJson`、`commandOrStepsJson`、`expected/actual` 等允许保存必要结构化元数据和简短结果，不能内嵌整份文档／资源包／长日志；大内容使用文件引用。索引可重建，不可据此恢复授权／执行成功历史。本文为设计，完整报告字段已消除双正文歧义，本次没有真实表变更或迁移。

## 2. 字段约定与关系

ID TEXT（稳定随机 ID），hash TEXT（带算法/规则版本的 SHA-256），时间 INTEGER（UTC epoch ms），计数与版本 INTEGER 非负；revision 为单调本地运行版本，artifactRevision 另为明确产物修订（hash/真实 HEAD）。URI TEXT 是受检引用。JSON TEXT 仅存版本化不可变策略/清单，使用 json_valid CHECK；必要查询字段单列。unknown usage/cost 使用 NULL + source/status，不用 0 代替。

关系：project→batch→task→step→attempt；task→snapshot；task/外部产物→dependency→task；attempt→artifact revision→verification evidence；task→integration item→verified baseline；batch→delivery report→acceptance/outbox；resource requirement→lock/slot。各新表含 projectId，使用复合外键限制跨项目引用；正式 requirement_index 不做删除级联父，保留源文档移动/删除后的历史快照。

## 3. 实体字段计划

| 表 | 主要字段、含义及约束 |
| --- | --- |
| execution_policy_snapshot | id PK, projectId FK, version, policyHash, authorizationRef, actorRef, createdAt, policyJson（允许CLI/模型、最低能力/难度、并发、预算、重试/返工、restartPolicy、集成允许集、验收规则）；UNIQUE(projectId,policyHash)，不可原地编辑 |
| execution_batch | id PK, projectId FK, scopeKind CHECK story/feature/epic/allEligible, scopeHash, snapshotHash, policyId FK, idempotencyKey, requestDigest, status CHECK running/succeeded/partial/failed/cancelled, pausedSummary, createdAt, updatedAt, closedAt, revision；UNIQUE(projectId,idempotencyKey) |
| execution_requirement_snapshot | id PK, projectId FK, batchId FK, storyId（Markdown稳定编号）, sourceUri, requirementHash, designManifestJson, designHash, acManifestJson, acHash, baselineRevision, baselineHash, snapshotUri/hash, confirmationRef, createdAt；UNIQUE(batchId,storyId)，清单冻结不可编辑 |
| execution_task | id PK, projectId FK, batchId FK, snapshotId FK UNIQUE, storyId, baselineHash, status, priority, queuedAt, revision, currentStepId可空, currentAttemptId可空, fencingToken INTEGER DEFAULT 0, activeKeyHeld BOOL, finalBlocked BOOL, controlRequestJson可空, stopPending BOOL, blockedReason/code可空, originalStatus可空, retryAt可空, repairRound, createdAt/updatedAt/closedAt；status采用LLD状态集合 |
| execution_step | id PK, projectId FK, taskId FK, ordinal INTEGER, kind CHECK prepare/implement/verify/integrate/deliver, status, validationPlanHash可空, inputManifestHash, outputArtifactKey可空, retryCount, repairRound；UNIQUE(taskId,ordinal) |
| execution_attempt | id PK, projectId FK, taskId FK, stepId FK, ordinal, taskFence, ownerId, runnerEpoch, status（claimed/running/ended/interrupted）, leaseUntil, heartbeatAt, processPid/startIdentity可空, selectedCli/model/effort与adapterFingerprint, launchedSpecHash, startedAt/endedAt, exitCode可空, errorClass/code可空, checkpointId可空, logUri/logHash, usageStatus CHECK known/unknown/estimated/demo, usageJson/costMinor/currency可空；UNIQUE(stepId,ordinal)，taskFence必须当前令牌 |
| execution_dependency | id PK, projectId FK, predecessorTaskId可空 FK, externalArtifactId/revision可空 FK, successorTaskId FK, requiredArtifactKey, verificationGateJson/hash, expectedRevision可空, requiredBaseline可空, consumedRevision可空, gateState；前置任务与外部产物恰好一个，拒绝 self，图环由事务内应用校验 |
| execution_resource_requirement | id PK, projectId FK, taskId FK, resourceKey（规范根/路径/集成分支/迁移目标）, mode CHECK read/write/exclusive, ancestorScope, createdAt；UNIQUE(taskId,resourceKey,mode) |
| execution_resource_lock | id PK, projectId FK, resourceKey, mode, taskId/attemptId FK, ownerId, taskFence, leaseUntil, recovering BOOL；读写/祖先重叠冲突由同一领取事务查询，独占同键另有部分唯一索引；未停旧进程不能删锁 |
| execution_slot | id PK, scopeKey（global/project/cli/provider）, slotNo INTEGER, capacityPolicyHash, taskId/attemptId可空 FK, ownerId/taskFence可空, leaseUntil可空；UNIQUE(scopeKey,slotNo)，所有必须槽事务同时占用 |
| execution_checkpoint | id PK, projectId FK, taskId/attemptId FK, taskFence, stepCursor, artifactManifestHash, sideEffectCursor, worktreeUri, branchRef, headRevision, checkpointUri/hash, createdAt；不存秘密，不等于可盲重放证明 |
| execution_effect | id PK, projectId FK, taskId/attemptId FK, taskFence, effectKey, kind, inputDigest, state CHECK intent/applied/confirmed/unknown, outputRevision可空, reconciliationJson可空, createdAt/updatedAt；UNIQUE(projectId,effectKey)，输入不匹配拒绝复用 |
| execution_artifact | id PK, projectId FK, taskId FK, artifactKey, kind, createdAt；UNIQUE(taskId,artifactKey)，逻辑产物元数据 |
| execution_artifact_revision | id PK, projectId FK, artifactId FK, attemptId FK, taskFence, revision TEXT, contentHash, uri, codeHead可空, consumedBaseline, designHash/acHash, validity CHECK candidate/verified/invalidated, invalidatedReason可空, createdAt；UNIQUE(artifactId,revision)，修订不可覆盖 |
| execution_verification_evidence | id PK, projectId FK, taskId/attemptId FK, artifactRevisionId FK, acId, acHash, designHash, consumedBaseline, planHash, environmentFingerprint, method, commandOrStepsJson, expected, actual, outcome CHECK passed/failed/notRun/notApplicable, applicabilityReason可空, exitCode可空, reviewerRef可空, startedAt/endedAt, logUri/logHash, validity, invalidatedReason；旧证据不删除 |
| execution_integration_item | id PK, projectId FK, taskId FK, artifactRevisionId FK, targetRef, expectedHead, candidateRef/head可空, verifiedHead可空, state, taskFence, ordinal, validationPlanHash, createdAt/updatedAt；UNIQUE(projectId,targetRef,ordinal)，实操取集成锁 |
| execution_verified_baseline | id PK, projectId FK, targetRef, revision, previousRevision可空, integrationItemId FK, evidenceManifestHash, createdAt；UNIQUE(projectId,targetRef,revision)，当前指针以CAS更新，不公布未验证HEAD |
| execution_event | seq INTEGER PRIMARY KEY（全局递增）, eventId TEXT UNIQUE, projectId FK, batchId/taskId/stepId/attemptId可空 FK, eventType, taskRevision, taskFence可空, sourceEventKey UNIQUE, payloadJson, createdAt；迟到事件可审计但不变更当前权威 |
| execution_delivery_report | id PK, projectId FK, batchId FK, reportRevision, scopeHash, evidenceManifestHash, reportSummaryJson/reportUri/reportHash（完整报告正文为文件；JSON仅结构化结果摘要）, technicalStatus, acceptanceStatus, releaseStatus, validity, createdAt；UNIQUE(batchId,reportRevision)，报告修订不可覆盖 |
| execution_acceptance_record | id PK, projectId FK, deliveryId FK, storyId, artifactRevision/ acHash, decision, mode CHECK manual/preauthorizedAutomatic, actorAuthorizationRef, objectiveRuleHash可空, decidedAt, recordHash；无真实授权不能写入有效通过 |
| execution_document_outbox | id PK, projectId FK, deliveryId FK, storyId, targetUri, expectedDocumentHash, proposedHash, appliedDocumentHash可空, intentHash, state CHECK pending/applied/conflict/confirmed/failed, errorCode可空, createdAt/updatedAt；UNIQUE(deliveryId,storyId,intentHash) |
| execution_budget_ledger | id PK, projectId FK, batchId/taskId/attemptId FK, policyHash, unit, reservationId, amount非负可空, state CHECK reserved/consumed/released/unknown, measurementSource, costMinor/currency可空, createdAt；UNIQUE(attemptId,reservationId,state)，unknown不得作为零账单 |

currentStepId/currentAttemptId 的回指在 task/step/attempt 创建后同一事务设置，FK可延后检查；step/attempt 必须通过(taskId,projectId)复合 FK避免跨任务冒用。外部产物只引用同项目受权有效存档产物，跨项目依赖本轮不自动开放。project/session 被引用时采取 RESTRICT 或受控归档，不级联删除运行/验收历史；会话可选引用使用 SET NULL，不影响任务存在。

## 4. 关键约束与索引

- 每张新子表提供 UNIQUE(id,projectId)，复合 FK绑定项目；batch/task/snapshot再绑定所属batch，attempt绑定step/task，证据绑定任务产物。新关联删除默认 RESTRICT，保持追溯。
- 活动任务防重计划：`CREATE UNIQUE INDEX ... ON execution_task(projectId,storyId,baselineHash) WHERE activeKeyHeld=1`。baselineHash包含需求/设计/AC/代码基线和hash规则版本，不包含授权者以免换策略绕重复。
- activeKeyHeld 对 queued/waiting/preparing/running/verifying/integrating/retry_wait/paused/可恢复blocked 保持1；只有终态或已finalBlocked且旧writer停止确认、资源清理完才置0。状态CHECK与事务不允许运行但activeKeyHeld=0；stopPending/recovering时不能释放唯一门槛或锁。finalBlocked返回执行需新授权而非修改旧终结历史。
- idempotencyKey 与 requestDigest共同判请求一致，同键冲突不覆盖原批次；batch/task/edges/事件创建一个事务，活动约束冲突全部回滚。
- 独占同键锁部分唯一；读写兼容与祖先范围不能仅依赖字符串唯一索引，领取事务先规范路径并检查全部冲突，锁/槽/预算/attempt整体提交，任何失败不保留部分资源。
- 领取与回调使用 `WHERE taskId=? AND revision=? AND ownerId=? AND fencingToken=?` 条件更新，影响行数为0即过期拒绝。租约过期不能自动删写锁或恢复副作用。
- dependency FK之外检查前置/后继同项目、非self，插边事务拓扑检环；不能仅靠UI检环。artifact gate从当前validity/evidenceManifest/可消费baseline计算，不信任单个 gateState缓存。
- 查询索引：task(projectId,status,priority,queuedAt)、task(batchId,status)、dependency(successorTaskId)、dependency(predecessorTaskId)、attempt(taskId,ordinal)、attempt(leaseUntil,status)、lock(resourceKey,mode)、event(projectId,seq)、evidence(artifactRevisionId,acId,validity)、integration(projectId,targetRef,state,ordinal)、outbox(state,updatedAt)。
- 计数/额度/ordinal/fencing/revision CHECK≥0，BOOL CHECK IN(0,1)，所有JSON做结构版本及json_valid；通过证据缺必需revision/hash时拒绝，notApplicable必须理由，unknown账单必须保持NULL。

## 5. 事务、投影与证据一致性

runner 事务内领取、更新状态、提交事件和产物引用；UI读取不可变快照及有序事件补流，不编辑权威运行状态。日志文件先临时落盘再原子封存并记录hash；文件落盘成功而DB未登记则恢复对账，不能虚构成功。源文件只读快照、requirement_index可重建；运行数据不可从当前Markdown推导旧成功。

证据修订改变用失效事件/validity和失效原因保留历史，当前gate立即不再满足；后继安全停止和重评。report按证据清单hash幂等生成，新修订新报告。

文档 outbox 是跨DB/文件的可恢复协议，不宣称跨介质原子事务：预留expectedHash→检查正文→原子替换且留版本→登记appliedHash→更新索引→确认。文件已写而DB未确认时用deliveryId/目标hash对账；hash冲突保留旧与提案，等待受权同步，不强制覆盖用户修改。

## 6. 迁移、备份、兼容与恢复计划

**仅计划，不新增/执行真实迁移。**未来脚本落项目实际迁移机制（当前为 db.rs migrate）；正式落地时不得靠无版本 CREATE IF NOT EXISTS 掩盖结构变化。

1. 明确新schema version与runner/UI最低协议版本；停止领取、进入draining并确认旧writer停止，旧UI不能写未知执行表。
2. 使用 SQLite backup API 或完成 checkpoint/关闭所有连接后安全备份 DB；不能运行中只拷 workbench.db 忽略WAL。同时备份受管产物/日志/快照清单，秘密另走受权凭据备份，不复制进普通证据包。
3. 在隔离副本事务新增表/索引/FK/schema_version；不改或删除既有需求/会话/配置数据，不自动生成旧任务成功记录。失败rollback，旧库保持可用。
4. 执行 foreign_key_check/integrity_check、旧表数量/hash对比、租约争抢/活动唯一约束/事件/恢复测试；通过后新runner启动并握手版本。
5. 兼容窗口：旧程序继续读取旧表仅在执行服务禁用且无未知schema写操作时允许；旧runner不得领取新队列。活动任务运行期间禁止降级DB或只还原元数据。
6. 回退：drain/停止/确认所有writer后，只有尚未产生新外部副作用且备份版本完整时可恢复备份与对应产物清单；产生新执行结果后优先向前修复/只禁用新入口，不能通过还原旧库重放已发生副作用。无法对账置blocked，人工查明。
7. 主机重启先核对runner epoch、attempt进程身份、checkpoint、effect state与实际HEAD；确认无旧writer后才按restartPolicy恢复。备份不能恢复为仍有效租约，fence/owner必须作废并新领取。

本轮没有生产数据迁移、备份或恢复实际结果；相关正式验证全部未执行。真实操作的备份路径、版本和证据需在后续授权报告登记。

## CR-017：闭环协作与状态联动增量（仅设计）

新增 [STORY-044](../Plan/Story/STORY-044-统一设计入口与CLI任务标识.md)、[STORY-045](../Plan/Story/STORY-045-需求运行评审与验收状态联动.md)、[STORY-046](../Plan/Story/STORY-046-任务续接重试与条件唤醒闭环.md) 的数据需要；本轮不建表/迁移。

| 逻辑实体/增量 | 字段与约束 |
| --- | --- |
| execution_attempt增量 | sourceAttemptId、continuityMode(safeResume/fresh)、nativeContextRef、worktreeRevision、workflowStepRevision、retryRequestId；selectedCli/model始终冻结，UNIQUE(projectId,retryRequestId)；旧Run不可改为另一个执行器 |
| execution_comment | id/projectId/storyId/taskId/runId可空、actor、text、workflowRevision、createdAt、deliveryState；允许将同需求讨论提交当前受权Run，不把文本当需求范围/权限授权，事件去重 |
| execution_workflow_snapshot | id/projectId、revision、stepsJson、allowedHandlers、returnTargets、policyHash；配置修订不可中途偷换，Run绑定版本，阶段移动后旧Run拒绝推进 |
| execution_review_record | id/projectId/storyId/runId、workflowRevision、artifactRevision/acHash/designHash、decision/reason/actorAuthorizationRef、createdAt；reject理由必填，approve需当前有效证据，不伪造真实验收 |
| execution_wakeup_rule | id/projectId/storyId、workflowRevision、kind/conditionJson、targetCli/handler、instruction、enabled、maxFires/fireCount、expiresAt/onTimeout、revision；范围受权、终结需求停用、有限触发 |
| execution_wakeup_receipt | ruleId/triggerId、observedFacts、sourceEventId、runId、outcome、time；UNIQUE(ruleId,triggerId)，历史不可覆盖，旧阶段不创建新writer |
| execution_requirement_transition | id/projectId/storyId、sourceRunId/decisionId、expectedDocumentHash、from/toStage、reason、workflowRevision、time、syncState；业务写回继续outbox-CAS，失败保留冲突不强制覆盖 |
| execution_parent_projection | parentId/projectId、sourceRevision、fullChildIds、completed/cancelled/pending/blocked、aggregateStatus；仅派生可重建，不替代父/子需求正文或整体验收依据 |

手动重试/评审退回先记录原Run结束及当前reportRevision，再创建新Attempt与新fence，不清零预算或覆盖历史。新尝试来源与阶段绑定可查询，活动唯一约束/停旧writer规则继续生效。规则触发、评论、handoff需要事务内检验需求版本/权限，UI点击并非执行权限。DEMO内存及localStorage仅评审状态，正式数据安全与恢复仍未验证。

## 7. 安全、保留与验收

执行目录/DB/control IPC 限本机身份，知识与秘密保持原网关授权；projectId必须由受管服务复核，不靠前端过滤。错误事件脱敏，不暴露未授权路径。保留终态日志/证据/报告、租约历史和授权摘要，清理需核对引用且按用户授权，不能删除失败历史省空间。

共同验证见 [TEST-FEAT-018](../Test/TEST-FEAT-018-任务系统设计验证.md)，涵盖唯一约束/FK/租约/副作用对账/迁移回退和正文权威。当前只设计，未验收。2026-11-19 CR-016 建立首版。

## CR-026本轮设计闭环交付

沿用原Task/Run/Attempt与CR028文件正文、CR031事件记录，不建第二任务或设置库存。[计划契约](../LLD/LLD-CR026-有效执行计划与能力编译.md)新增以下结构化计划，只有设计未迁移。

| 记录 | 字段与约束 |
|---|---|
| execution_plan | id/projectId/taskId/phase/sourceRunId、planHash/hashRuleVersion、requirement/design/acHash、configRefs、authorizationRef、selectedCli/sdkVersion/adapterVersion/runtimeId/modelRef/effort、permissionPolicyHash/capabilityManifestHash/budgetPolicyRef；不可变，复合外键同project，UNIQUE(projectId,planHash) |
| execution_plan_origin | planId+fieldPath主键、sourceKind/task/template/project/system、sourceId/revision、resolvedValue摘要；完整敏感值不入表 |
| execution_capability_manifest | planId、Tool/schema/参数策略、Skill内容与附件URI/hash、MCP服务+精确发现tool/schema、知识grant/version；秘密只有secretRef，正文在受管文件 |
| execution_plan_authorization | id/planHash/actorRef/source/revision/scope/expiresAt/revokedAt；撤权事实独立于冻结Plan，实时复检 |
| execution_attempt增量 | planId/planHash、sourceAttemptId/contextMode、budgetLedgerRef；原计划retry不重置预算，新组合显式授权新Plan，历史不覆 |
| execution_phase_run | taskId/phase/planId/parentPlanId/sourceArtifactRevision/status；评审只读能力与父剩余预算交集，不写业务验收通过 |
| execution_delivery_report增量 | planRefs/phasePlanRefs/actualConfigManifestHash；完整报告继续文件，DB只摘要/URI/hash |

迁移设计：备份并核旧 schema → 新增表与nullable引用 → 旧Run标legacy-plan-missing（不能从当前默认伪造）→ 新确认事务写Plan+Task/Attempt → 验证同项目外键/幂等/撤权/恢复。回退停新领取、保留只读历史，不删计划或把新Run回旧无计划执行；正式迁移及恢复测试未执行。
