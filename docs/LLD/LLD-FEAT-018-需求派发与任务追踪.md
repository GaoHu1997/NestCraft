# LLD-FEAT-018：需求派发与任务追踪

> CR-031现行细化：采用[受管执行可靠性契约](LLD-CR031-受管执行可靠性契约.md)的身份、能力握手、交错事件、项目序号/cursor和完成ACK，以及[数据增量](../DB/DB-CR031-事件审批与产物记录.md)。本文旧`task_events_read.afterSeq`仍按全局seq，CR-031新cursor不可与其混用；全局序号被其它项目占用不算缺口。需求/AC及唯一WP实施顺序见[CR-031](../PRD/CR-031-受管执行可靠性需求与实施分解.md)，[验证](../Test/TEST-CR031-受管执行可靠性验证.md)；只方案，正式接口未实现。

- 关联：[FEAT-018](../Plan/Feature/FEAT-018-需求派发与项目任务追踪.md)、[STORY-038](../Plan/Story/STORY-038-多粒度需求派发与执行准入.md)、[STORY-039](../Plan/Story/STORY-039-项目任务工作区与追溯.md)、[PRD-002](../PRD/PRD-002-需求派发与自主执行.md)、[ADR-003](ADR-003-任务执行权威与调度边界.md)。
- 状态：设计方案首版，2026-11-19；正式命令与任务 UI 未实现，本轮仅独立评审稿。

## 1. 当前实现与影响边界

Tauri 2 / React 18 / TypeScript / Vite、Rust / rusqlite 是既有技术栈。`src/modules/projects` 和 `commands/projects.rs` 提供项目与 Markdown 需求扫描；`requirement_index` 为派生投影。当前 code 工作区只有需求/设计/编码，没有任务工作区。`commands/chat.rs` 的 RUNNING 仅保护运行中的会话，不是任务唯一约束。

正式实现拟新增任务服务/命令与项目任务页面，扩展 API 类型和 lib.rs 注册；复用项目身份、正文阅读、设置引用和全局主题。不修改会话消息为任务权威，不将业务树转第二份可编辑 DB 正文。本轮不改上述源代码、冻结原型或正式数据库。

## 2. 范围解析与准入（STORY-038）

输入 scope `{kind: story|feature|epic|allEligible, rootIds: string[]}` 与 projectId。rootIds 来自当前需求选择；allEligible 的根为空时显式指当前项目需求根，不遍历其他项目。服务从受检项目 Markdown 重建 id/type/parent 图，检查 duplicate/orphan/cycle，再展开叶子 Story；只靠 UI 传 ID 不能扩大项目权限。

逐条检验：需求确认记录、稳定编号/归属、AC、可执行且同基线设计、无待同步草稿、未完成/取消；执行规划所需资源/能力/预算材料齐全。设计可执行至少包含接口/数据结论、受影响范围、验证命令或手工门槛与错误路径；状态标签不代替内容检验。

CR-041 明确 CR-032 增量派发的“无待同步草稿”指无未确认、冲突或部分落盘的文档目标，不要求待开发的新代码预先与新文档同步。已确认且内部一致的文档快照可与旧代码manifest共同冻结该批输入，获得独立编码授权后才可执行；共同同步基线仍待实现验证及反向对账后发布，见 [LLD-CR032 §3](LLD-CR032-双向变更与高保真逆向.md#3-文档驱动代码的增量流程)。

对范围内前置建立显式 DAG；范围外已有验证产物可登记外部只读依赖，但校验修订/证据/可消费基线。缺少授权或产物时排除受影响任务，向后传播不可满足原因。候选图有环则拒绝整图，返回 cyclePath，不自动删边。预检返回 eligible/excluded/unresolved 与具体原因，不隐藏部分范围。

## 3. 快照与授权

冻结输入 `RequirementSnapshot`：storyId、sourceUri、requirementHash、designRefs[{uri,hash}]、acHash、baselineRevision、授权来源摘要；任务运行上下文使用受检快照，历史文件变动不会偷换执行目标。正文不可变快照只用于运行审计，不提供编辑入口。散列基于源 UTF-8 字节及确定性排序后的 AC/设计清单（SHA-256），hash 规则版本一并冻结。

`ExecutionPolicy` 版本化且不可变：allowedCliModels、selectedExecution、requiredCapabilities、minimumDifficulty/effort、projectRoot/writeScopes、knowledgeGrantsVersion、tool/network allowlist、maxConcurrency、budget（unit/hardLimit/measurementSource）、maxRetries、maxRepairRounds、timeout、restartPolicy、localIntegrationTargets、acceptancePolicy。能力组合有 fingerprint/version，模型与 effort 映射不能猜测；任务实际选定配置记录在尝试中，不静默切换。秘密只存 secretRef，不存明文。

默认 acceptancePolicy 是 technicalDelivery；客观 automaticAcceptance 必须包含事前真实授权来源、规则 hashes 和适用 Story，不能从需求标题推导。maxConcurrency/预算等是预检必填授权项；本轮评审预设数值均标仿真，不成为真实默认成本承诺。

## 4. 原子确认与防重复

1. `task_dispatch_preflight` 只读生成短期 preflightId、摘要和基线 hashes，不创建任务或 spawn。
2. 使用者确认完整 scope/policy 后传 idempotencyKey、preflightId、expectedScopeHash。
3. 服务重读源文件与配置/授权版本，比对 hashes，过期或改变返回 BASELINE_CHANGED；文件变更监视后的二次启动检验仍需存在，不能把预检锁当永久冻结源文件。
4. `BEGIN IMMEDIATE` 内校验同键请求 digest，再检查项目+Story+baselineHash 活动任务唯一约束，一次插入 batch/snapshots/tasks/steps/edges/event；碰撞全量回滚。返回冲突任务列表，要求重检，不自动省略任务组成半批次。
5. 已提交同键同 digest 返回原 batch；同键不同 digest 返回 IDEMPOTENCY_MISMATCH。新增请求或失败重试也不能绕过活动任务约束。授权有效性实际 spawn 前再次由 runner 检查。

数据约束见 [DB-FEAT-019 §4](../DB/DB-FEAT-019-任务执行数据设计.md)。目录读取与 DB 不能跨介质锁定；确认后源漂移使对应任务 blocked，不继续依据未经确认的新目标。

## 5. 工作区投影（STORY-039）

需求 → 设计 → 任务 → 编码。TaskWorkspace 以 batch/task ID 查询运行权威，关联原 Story 源 URI/设计 hash/AC，不维护第二业务层级。列表支持批次、状态、Story/标题、CLI；详情显示 task→step→attempt、前置产物门槛/消费修订、资源锁、权限与配置摘要、日志/差异/报告。

同时展示文档状态与任务运行状态，例如「任务 succeeded；Story 待验收；文档同步完成」；写回冲突显示「技术交付已生成，文档待同步」。任务页只管理既有任务暂停/继续/取消，不新增需求派发按钮。跨会话不丢任务，sessionId 是可选尝试关联。

事件增量采用持久化序号：先查询快照及 lastEventSeq，再订阅并从 afterSeq 补读，按 project+eventId 去重，发现缺口调用 events 补齐；旧 taskRevision/fencing 的事件可保留审计但不更新当前 UI 投影。UI 重连从权威 DB 读取，订阅通道不是唯一存储。

### 5.1 CR-041：派发树身份闭环（待补设计验证）

[CR-039](../PRD/CR-039-任务页派发树与协调视图.md) 的派发树只投影现有 batch→task→step→attempt 与 CR-031 invocation 父子关系。树节点携带明确 nodeKind 和对应稳定ID，调用节点另带 batchId/taskId/attemptId；parentInvocationId 只表达调用层级，不能代替batch归属。重试产生新Attempt／Invocation仍属于原batch；派发统计按batchId去重，历史调用不可冒充新派发。缺父、跨项目、环形关系不猜补，保留异常诊断；读取仍经项目授权复检。单Story样例可展示当前协调根与子工作；跨Story协调根和深层树展示尚待产品决定，不隐式创建批次级协调者。既有可视版本及11项浏览器结果未验证这些边界，补稿后才准入相关界面开发。

## 6. Tauri invoke 与事件接口计划

**以下为待实现接口**，应统一在 `src/api/index.ts`、Rust models 与 lib.rs 注册；不是当前可调用 API。共用响应 `{schemaVersion:1, data, cursor?}`，错误 `{code,message,retryable,details}` 脱敏，时间 UTC epoch ms，camelCase 线格式。

| 命令 | 输入 | 输出/副作用 |
| --- | --- | --- |
| task_dispatch_preflight | projectId, scope, executionPolicyDraft | preflightId, expiresAt, scopeHash, eligibleSnapshots, excluded[{storyId,code,reason}], dependencyPreview, capabilityResults, policySummary；只读 |
| task_dispatch_confirm | projectId, preflightId, expectedScopeHash, idempotencyKey, confirmedPolicyHash | batchId, taskIds, snapshotRevision；事务持久化，不直接 spawn |
| task_batches_list | projectId, status?, cursor?, limit≤100 | 批次列表、稳定游标 |
| task_workspace_list | projectId, batchId?, statuses?, query?, cliId?, cursor?, limit≤100 | 运行任务投影、documentStatus、lastEventSeq |
| task_detail_get | projectId, taskId | snapshot, policySummary, steps, attempts, dependencies, locks, currentRevision, syncState |
| task_events_read | projectId, afterSeq, limit≤500 | 有序事件、nextSeq、hasMore；事件仅受权项目可读 |

控制命令见 LLD-FEAT-019 §7；证据/报告命令见 LLD-FEAT-020 §6。不把 chat_send 当任务启动接口。

事件主题拟为 `task://event`，信封 `{eventId,projectId,batchId,taskId?,stepId?,attemptId?,seq,type,taskRevision,fencingToken?,payload,createdAt}`。类型包括 batch.created/state、task.state/waiting、attempt.started/heartbeat/ended、artifact.published、evidence.updated、integration.state、delivery.ready、document.sync。日志 delta 单独限流，完整日志以受管日志文件及 hash 留证；凭证/未授权知识不得进入事件。

错误码至少覆盖 INVALID_SCOPE、SOURCE_INVALID、BASELINE_CHANGED、INELIGIBLE_STORY、EXTERNAL_DEPENDENCY_UNAUTHORIZED、DEPENDENCY_CYCLE、ACTIVE_TASK_EXISTS、IDEMPOTENCY_MISMATCH、CAPABILITY_UNVERIFIED、PERMISSION_DENIED、BUDGET_UNENFORCEABLE、RUNNER_UNAVAILABLE。不存在对象与无权对象不泄露其他项目详情。

## 7. UI、DB、安全与验证

- 共用 [UI-FEAT-018 §2–4](../UI/文档/UI-FEAT-018-任务工作台交互设计.md)；白蓝/深色令牌只读复用 `src/theme/tokens.css`，不复制历史业务原型。
- 共用 [DB-FEAT-019 §2–5](../DB/DB-FEAT-019-任务执行数据设计.md)：批次/快照/活动任务唯一索引/投影，数据库需要新增结构但本轮不迁移；既有 [DB-FEAT-001](../DB/DB-FEAT-001-知识授权与工作台数据设计.md) project/配置/授权继续复用。
- 项目根/sourceUri canonicalize 并限制目录，拒绝 traversal/符号链接逃逸；上下文白名单由受管层强制，UI 过滤非安全边界。
- 验证入口 [TEST-FEAT-018](../Test/TEST-FEAT-018-任务系统设计验证.md)：AC-STORY-038/039 全量映射，文档检查与仿真测试可进行，真实命令/事务/权限/事件恢复未实现。

## CR-017：统一入口与CLI运行标识

关联 [STORY-044](../Plan/Story/STORY-044-统一设计入口与CLI任务标识.md)、[CR-017](../PRD/CR-017-统一设计入口与需求任务闭环.md)。保留同一个评审入口并整合导航，不新建孤立任务页面或iframe状态岛；所有模块共享项目/需求身份，Tab只名称、数量在概览。CLI Logo通过受检cliId映射，不读当前负责人来覆盖旧Run实际selectedCli；未知fallback明确。图形仅本地资源，版权/许可保留，正式运行组合仍需能力验证。

新增需求维护由源文档服务接收 `expectedDocumentHash/expectedWorkflowRevision`，title/goal/AC/设计引用变更生成新版本并触发旧运行失效；手动状态按钮不能绕过验收门槛。只分配CLI是owner事件，不创建run；派发/主动交接另以原范围和新配置预检确认。新增/删除保持稳定ID、唯一合法父关系，有子项/活动或历史引用时拒绝删除；取消需求保留审计并停其运行/规则。

跨批次前置准入：同project、同requirement/design/AC与workflow版本且已独立授权的活动前置任务，可作为外部任务引用。快照保存externalTaskId和目标基线，不保存其瞬时queued/running/succeeded状态来组成请求摘要；正常进度不造成BASELINE_CHANGED。确认/启动复检引用身份与基线，源任务失效则拒绝或阻塞，不悄悄改绑新任务。无授权活动任务且无有效产物仍排除，不能扩大派发范围。任务依赖producerTaskId绑定已有来源，等待验证/集成与可消费revision后才启动；失败/取消不放行，同目标合法修复后受控恢复。无运行来源的导入工件继续固定externalRevision校验。

统一UI查询 `requirementSummary` 返回当前业务状态、并列runStatus、latestTaskId、子项completed/cancelled/pending/blocked计数与acceptance；业务状态由当前需求/有效证据和活动执行推导，再经受控outbox写回，不把Task状态直接当Story字段。列表/详情/预览/报告都引用同一Story版本。

正式接口增量（待实现）：`requirement_assign{storyId,cliId,modelRef,start:false,expectedRevision}`；`requirement_patch{storyId,patch,expectedDocumentHash,reason,requestId}`；`requirement_summary{storyId}`；`requirement_cancel{storyId,reason,expectedRevision}`。查询无副作用，变更需权限/基线与幂等检验；当前DEMO仅使用纯state API。需求→任务→Run→证据→需求的定位需保持原选择/展开/视图，不触发执行或换分支。

## 8. 实施拆分与恢复计划

正式授权后：先源材料检验与快照类型 → 数据约束与预检/确认事务 → runner 控制桥 → 任务投影与页面 → 事件重放/权限/失败回归。与 FEAT-019 固定 policy/edge/state，FEAT-020 固定 evidence/delivery；共享 API 由集成负责人统一更改。

本轮文档与独立稿可单独交付，无部署/迁移/远端操作；回退只撤销本次 owned 文档或评审资源，不触碰用户工作区。真实迁移恢复按 DB-FEAT-019 §6；未验证 CLI/预算/runner 参数在真实派发前建立，不作为默认已具备能力。

变更记录：2026-11-19，CR-016 首版。采用既有材料与明确契约，不克隆或引入新依赖。

## CR-026本轮设计闭环交付

[CR026统一计划契约](LLD-CR026-有效执行计划与能力编译.md)贯通配置单源、逐任务预检、确认冻结、实时撤权、原计划retry/fresh、新组合再授权、独立只读阶段和实际交付配置来源。原DAG/产物/验收继续，新增Plan/manifest关系见[DB-FEAT019](../DB/DB-FEAT-019-任务执行数据设计.md#cr-026本轮设计闭环交付)。只操作设计资源，正式执行能力仍待实现；[实际记录](../Test/REPORT-CR026-执行计划闭环设计验证.md)不代替CR031真实门禁验证。
