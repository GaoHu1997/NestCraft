# LLD-FEAT-020：自动验证与交付

> CR-031现行细化：[可靠性契约](LLD-CR031-受管执行可靠性契约.md)补严格ResultEnvelope、只读阶段Finding、日志完整性和报告文件/DB封存对账，[DB增量](../DB/DB-CR031-事件审批与产物记录.md)固定关系与事务。结构合法不等于产物技术成功，沿用本文AC/证据/串行集成/待验收门槛；完整报告用文件，DB只存同修订摘要/URI/hash，继承CR-028。唯一实施顺序与AC来源见[CR-031](../PRD/CR-031-受管执行可靠性需求与实施分解.md)，[验证设计](../Test/TEST-CR031-受管执行可靠性验证.md)；本次未执行正式验证。

- 关联：[FEAT-020](../Plan/Feature/FEAT-020-自动验证与结果交付.md)、[STORY-042](../Plan/Story/STORY-042-自动验证集成与有限返工.md)、[STORY-043](../Plan/Story/STORY-043-批次交付与验收依据.md)、[PRD-002](../PRD/PRD-002-需求派发与自主执行.md)、[ADR-003](ADR-003-任务执行权威与调度边界.md)。
- 状态：2026-11-19 设计首版；正式自动验证/集成/交付未实现。本轮不调用真实命令、AI、Git 合并、迁移或发布。

## 1. 当前事实与复用

现有构建入口 `npm run build`（tsc + vite）、`cargo build --manifest-path src-tauri/Cargo.toml`；当前项目没有声明通用 npm test/lint 脚本，不臆造已可用。新任务面向不同项目，验证命令应来自目标项目已确认设计/测试，不硬套本项目命令。既有 `commands/gitcmd.rs` 可复用参数数组与本地 Git 读取机制，不代表已授权自动集成或具备串行队列。

拟新增 verifier、revision/evidence store、integration queue、delivery/outbox；复用正文 hash/CAS、项目身份、Git差异读取和运行事件；不改 AC 正文为 DB 可编辑副本。

## 2. 验证门槛与证据（STORY-042）

派发时冻结 `ValidationPlan`：每个 AC 对应具体验证类型（自动命令/人工审查/API/文档）、命令数组与 cwd、隔离环境引用、预期与通过判定、必要/可选属性、不适用条件、日志/证据位置和安全限制。缺少重要 AC 验证方法视设计不可执行；主观 UI/业务审阅不能用 AI 自评自动通过。

CLI exit 0 仅转 verifying。verifier 检查目标产物存在且范围受权，再执行冻结验证计划与最终 diff 审查。证据对象 `{evidenceId,taskId,attemptId,artifactId,artifactRevision,acId,acHash,designHash,consumedBaseline,validationPlanHash,environmentFingerprint,method,commandOrSteps,expected,actual,outcome,exitCode?,startedAt,endedAt,logUri,logHash,reviewerRef?}`；outcome=passed/failed/notRun/notApplicable，人工待审为 notRun + waitingReview，不能归 passed。

任务技术成功条件：所有必需产物存在且修订确定、全部必需 AC 验证有效、最终差异不越界/不含秘密、适用集成回归通过。不适用仅在原计划明确允许且有理由时成立，不能新引入理由逃避失败。交付终点尚需人工验收时技术成功≠Story已完成。

证据有效性键为 artifactRevision + acHash + designHash + consumedBaseline + validationPlanHash + environmentFingerprint。任一关键输入改变生成失效事件、保留旧证据及失效原因、安排重新验证；不能删除历史或借旧通过释放 gate。产物公布仅允许当前 lease/fence，失败尝试证据可留历史但不可标当前有效。

## 3. 有限返工

验证失败按可修复实现错误/环境故障/权限配置/需求不清分类：实现可修复且 repairRound<maxRepairRounds、预算够时自动生成下一修复尝试，输入冻结需求/AC、有效诊断和当前差异；不得改需求/AC、扩大范围、提权或切引擎。临时环境故障进入 FEAT-019 的 transport retry，次数分别记录但累计消耗总预算。认证、额度、配置、权限、主观决策直接 blocked/failed，不让模型无限试错。

每次修复形成新产物 revision，使旧证据失效；即使仅改一行，受影响测试和集成仍需重新执行。达到上限或安全检查不通过终结失败并报告具体 AC、次数、最新差异和负责人/下一步。修复解决不了的验收项不降格为可选优化。

## 4. 串行集成与下游消费

`IntegrationItem` 绑定 task、输入分支与 HEAD、artifactRevision、预期目标 HEAD、允许 localIntegrationTarget 和验证计划。一个项目/目标基线持独占 integration 锁，一次处理一个 item：

1. 校验允许集、非保护分支、非远端操作；检查目标 HEAD 与预期一致且工作树无用户未提交污染。
2. 在受管候选工作区创建本地候选集成，不在用户主工作树覆盖修改；副作用 ledger 写 intent 后执行。
3. 自动解决仅授权范围内明确的实现冲突；语义冲突/业务决定不能强行处理，进入阻塞/有限返工。
4. 候选集成后执行冻结集成回归和最终 diff 审查，失败保留候选/差异/日志，不提升发布基线。
5. 通过后 CAS 提升允许的本地集成基线（预期 HEAD 不变才可），发布新的 verifiedBaselineRevision；记录真实 HEAD/操作时刻，禁止伪造。
6. 后继从该验证基线准备/更新自己的独立 worktree，冻结 consumedRevision。失效修订传播重评，旧运行安全停止后才重建。

若未授权本地集成，直接交独立验证产物并标未集成；只有不依赖该集成基线的任务可继续。依赖未集成基线的后继 blocked，批次如实 partial/failed。独立产物验证通过不等于集成验证通过。

集成尝试失败恢复在受管候选工作区进行，保留原分支/HEAD和失败证据；不强推、不重置用户主分支、不默认推送/生产发布。外部未授权分支变化返回 BASELINE_CHANGED，重新授权/确认而非盲目覆盖。

## 5. 批次结果、文档写回与验收（STORY-043）

批次聚合只看冻结范围内 executionTask。若有 preparing/running/verifying/integrating 或在边界内可继续的 queued/wait/retry 任务为 running；不可满足且无可运行节点的等待需终结 blocked 并进入静止聚合。全部 succeeded→succeeded；全部 cancelled→cancelled；至少一项 succeeded 与 failed/cancelled/最终 blocked 混合→partial；无 succeeded 且非全部 cancelled→failed。用户暂时暂停的批次保留 running + pausedSummary，不伪称失败或已完成。CR-037 决策关口在有限等待期内属于可恢复等待，即使根 Task 标 blocked 也保留 running＋waitingSummary；到期且无其他可推进／期限内等待节点后才进入上述静止聚合，具体身份与恢复规则见 [LLD-CR037 §6](LLD-CR037-主代理协作契约.md#6-超期阻塞与恢复)。

交付 `DeliveryReport` 包含 scope/policy hash、逐 task/Story/AC结果、需求/设计版本、产物/消费/集成修订、尝试次数与日志、差异审查、未执行与不适用、阻塞/遗留编号、操作/回退说明、实际环境和时间。succeeded 仍可能仅是技术交付；报告分别列 technicalStatus、documentStatus、acceptanceStatus、releaseStatus。无真实提交/费用/发布时标未生成/未知/未发布。

usage 数值只来自可信原始 adapter 数据并记录 source；unknown 为 null，不能按零合计出「总费用」。估算单列 unit/currency/source/confidence，仿真数据有 demo 标记且不进入真实成本聚合。

写回流程：运行 DB 成功交付→outbox 产生受权 writeback intent→读取受检 Story 当前 hash→仅将允许状态及实现/验证引用原子写入正文（不改 AC）→更新 requirement_index→outbox confirmed。任一冲突标 documentSync=conflict/pending，任务报告仍保留；失败不从 DB 覆盖正文。文件先成功后 DB 故障，下次通过已应用 deliveryId/文件hash 对账补记，不二次重复插入验收文本。

默认 technicalDelivery 写回待验收，不改 Feature/Epic 为已完成。automaticAcceptance 只在事前明确授权、冻结客观规则全部通过、证据当前有效且 DoD 齐全时写已完成，并保存授权者/规则 hash/时间/依据。用户/指定验收者人工验收同样保存真实记录，不允许代理虚构签名。后续需求变更保留历史验收事实但新增当前失效/待重验记录。

## 6. Invoke、事件与数据契约计划

共用信封见 [LLD-FEAT-018 §6](LLD-FEAT-018-需求派发与任务追踪.md)，以下命令待实现：

| 命令 | 输入 | 输出/边界 |
| --- | --- | --- |
| task_evidence_list | projectId, taskId, revision?, includeHistory | 证据/outcome/有效性/失效原因，默认当前修订 |
| task_artifact_get | projectId, artifactId, revision | 受权元数据与差异/受检文件引用，不任意读取系统路径 |
| task_delivery_get | projectId, batchId, reportRevision? | 批次报告、scope/AC映射、接受状态和同步状态 |
| task_delivery_export | projectId, batchId, expectedReportRevision | 受管本地报告路径/hash；不上传、无外部通知 |
| task_acceptance_record | projectId, storyId, deliveryId, expectedDocumentHash, decision, actorAuthorizationRef | 真实用户/指定验收者授权记录及CAS写回；不是AI可自签入口 |
| task_writeback_retry | projectId, deliveryId, expectedDocumentHash, requestId | 重检一致性后幂等写回；冲突不得强制覆盖 |

自动 verifier/集成/automaticAcceptance 由 runner 内部执行，不提供允许前端伪造 passed 的命令。事件 `evidence.updated/invalidated`、`artifact.published`、`integration.state/baselinePublished`、`delivery.ready`、`document.sync`、`acceptance.recorded` 绑定 revision/fence；凭证不入事件。

数据共用 [DB-FEAT-019 §3–6](../DB/DB-FEAT-019-任务执行数据设计.md)：artifact_revision、verification_evidence、integration_item、delivery_report、acceptance_record、document_outbox；新增表仅计划，无本轮迁移。UI 共用 [UI-FEAT-018 §5–6](../UI/文档/UI-FEAT-018-任务工作台交互设计.md)，测试映射见 [TEST-FEAT-018](../Test/TEST-FEAT-018-任务系统设计验证.md)。

## CR-017：需求、Run、评审验收与父项状态联动

关联 [STORY-045](../Plan/Story/STORY-045-需求运行评审与验收状态联动.md)。业务阶段/运行状态分别权威，UI并列：分配/排队时保持需求原阶段；实际准备/执行到开发中；verify/integrate到验证中；返工回开发；外部阻塞带原阶段/原因；技术交付到待验收；当前证据人工或预授权客观验收后已完成。取消Run恢复该Story可执行/待处理阶段，不默默取消需求；明确取消需求才停其所有活动运行/规则。

评审/验收记录绑定 `storyRevision/workflowRevision/artifactRevision/acHash/designHash/decision/reason/actorAuthorizationRef`。通过需当前有效产物、全部必要检查与无阻塞；退回理由必填，按实现/设计/需求问题回适当阶段，新Run受原权限/预算上限。评审是阶段质量关口，不等同需求验收；DEMO按钮不代表真实用户签名。旧Run/证据/验收与报告保存历史，修改需求/AC/设计或消费基线使当前记录失效，不能在迟到结果中把新阶段推进完成。

Feature/Epic聚合完整适用子Story集合而非本次batch：未覆盖草稿继续待处理；取消数量/原因单列，不默默消失；所有适用子项有当前验收依据且整体验收满足才完成。既有已验收子项沿原revision计入，后续变化保留历史但当前失效。UI `requirementSummary` 提供状态和子项计数，正式缓存可重建，不第二份业务事实。

正式拟新增 `task_review_record` / `requirement_acceptance_record`；乐观并发比较Story文档hash与workflowRevision，旧阶段返回STALE_WORKFLOW/STALE_EVIDENCE，不能强行覆写或仅凭exit0通过。批次报告标技术、评审、验收、发布四状态，重试/退回产生新报告revision，旧报告不是当前验收依据。跨DB/文件继续outbox/CAS恢复，不宣称一次内存赋值等价正式事务。

闭环必须实测从需求新增→确认/设计→分配/派发→运行/等待→原Run重试→评审退回再验证→待验收→验收完成→父项汇总→证据定位回同Story；每个失败/等待都有修复入口，不能停在只显示待验收的卡片。

## 7. 实施、验证与交付边界

正式授权后：冻结验证计划→受管 verifier/证据存储→修订失效与有限返工→本地集成队列/消费基线→报告与幂等 outbox→真实验收接口→完整流程回归。共享接口/DB 由集成负责人统一；不得并行覆写同一目标分支。

本轮可审查文档与独立仿真，不能证明真实构建/CLI结果、事务恢复、实际集成、账单或安全边界。REPORT 由主代理记录实际命令、环境、结果和未验证项。正式部署恢复依 DB §6；本轮无需部署/迁移/生产恢复说明，不虚构发布。2026-11-19 首版；未知 CLI计量、隔离证据与用户授权在真正派发前建立。

## CR-026本轮设计闭环交付

[CR026统一计划契约](LLD-CR026-有效执行计划与能力编译.md)贯通配置单源、逐任务预检、确认冻结、实时撤权、原计划retry/fresh、新组合再授权、独立只读阶段和实际交付配置来源。原DAG/产物/验收继续，新增Plan/manifest关系见[DB-FEAT019](../DB/DB-FEAT-019-任务执行数据设计.md#cr-026本轮设计闭环交付)。只操作设计资源，正式执行能力仍待实现；[实际记录](../Test/REPORT-CR026-执行计划闭环设计验证.md)不代替CR031真实门禁验证。
