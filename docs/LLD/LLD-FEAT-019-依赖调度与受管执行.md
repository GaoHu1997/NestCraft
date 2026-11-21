# LLD-FEAT-019：依赖调度与受管执行

> CR-031现行r2：[可靠性契约](LLD-CR031-受管执行可靠性契约.md)和[数据](../DB/DB-CR031-事件审批与产物记录.md)明确根Task领取Attempt/fence，同Task子Agent仅Job/Invocation并有独立generation，不改根fence；paused/retry_wait/可恢复blocked保activeKey，停止确认只允许按策略释放物理资源。executionSettled/sessionSettled与UI deliveryPending正交，内部Parent结果有限等待；[CR026 Plan编译](LLD-CR026-有效执行计划与能力编译.md)真存储是G-PLAN硬前置。M1宿主MCP→Tauri人工审批路线见[需求分包/里程碑](../PRD/CR-031-受管执行可靠性需求与实施分解.md)，具体CLI组合仍未核验；[测试](../Test/TEST-CR031-受管执行可靠性验证.md)补普通会话/NULL/activeKey/子代次回归。旧隔离、租约、真实验收要求继续，不把文档修正记软件实现。

- 关联：[FEAT-019](../Plan/Feature/FEAT-019-依赖调度与受管执行.md)、[STORY-040](../Plan/Story/STORY-040-依赖与资源约束自动调度.md)、[STORY-041](../Plan/Story/STORY-041-CLI隔离执行与故障恢复.md)、[PRD-002](../PRD/PRD-002-需求派发与自主执行.md)、[ADR-003](ADR-003-任务执行权威与调度边界.md)。
- 状态：2026-11-19 选定设计，正式 runner/DAG/租约/隔离未实现。本轮不 spawn CLI、不创建 worktree、不执行迁移。

## 1. 当前基础与架构

既有 Rust 会话桥可复用进程数组参数/JSONL 解析经验；现有 RUNNING 仅 sessionId→中止信号，SDK 内存安装队列也非研发调度。SQLite 已有 WAL 与 foreign_keys，但新增任务表不存在。Grok 参数尽力适配不能判已验证任务能力。

拟采用独立本地 Rust runner + SQLite 执行存储 + Tauri 受管客户端。runner 维护调度器、进程监督、权限执行、verifier、集成队列；UI 仅展示/发送控制，不承担持续任务时钟。一个本机 DB 一个调度协调者，本机命名互斥及受限 ACL 控制端点防双 runner；DB 领取仍防并发客户端/worker。runMode 为 independentRunner 或 applicationBound，能力不足不冒充常驻。

## 2. DAG 与状态机（STORY-040）

业务树只展开范围；`DependencyEdge` 为前置任务或外部产物→后继任务，包含 requiredArtifactKey、verificationGate、expectedRevision、consumedRevision（消费后填）、requiredBaseline。对候选边拓扑校验，自依赖/环拒绝。内部实现 step 固定为 prepare→implement→verify→integrate（需要时）→deliver；跨任务依赖等待 artifact gate，不盲等 Story「已完成」。

任务状态和原因分别保存：

| 原状态/条件 | 目标 | 条件与动作 |
| --- | --- | --- |
| queued、retry_wait 到期 | waiting_dependency | 缺有效前置或消费基线；记录具体门槛 |
| queued、waiting_dependency 且 gate 已满足 | waiting_resource | 锁或槽未满足；不启动进程 |
| 等待态、门槛/锁/槽有效 | preparing | 原子领取租约、锁、槽并生成 attempt/fence |
| preparing 且启动二次检验通过 | running | worktree 准备完、adapter 和权限生效才 spawn |
| running 正常结束 | verifying | exit 0 不是 succeeded；交给 verifier |
| verifying 通过且需集成 | integrating | 进入串行集成队列 |
| verifying/ integrating 技术门槛完成 | succeeded | 有有效产物、证据和差异审查，交付 outbox |
| 暂时故障、上限内且旧进程已停 | retry_wait | 持久化新 retryAt，不忙循环 |
| 验证失败可修复且上限内 | queued | 记录 repairRound，新 attempt，不改变 AC |
| 需人工决定/安全能力缺失/不能确认停止 | blocked | 原状态与原因保留，不自动重跑 |
| 暂停请求且停止/检查点完成 | paused | 可安全恢复才释放资源 |
| 取消请求且停止确认完成 | cancelled | 保留历史，前置 gate 不放行 |
| 超限或不可恢复错误 | failed | 保留失败证据，独立节点继续 |

运行态暂停/取消先写 controlRequest（不新增虚假终态），发送停止信号；未确认停止保持原态+stopPending，禁止新 writer。blocked 可在同一冻结授权内明确消除暂时配置问题后受控重检；范围/策略变化必须重新授权。终态不可原地改 running，再执行创建新授权尝试/批次且不违反唯一约束。

## 3. 资源、槽与可消费基线

调度候选按 priority DESC、queuedAt ASC、taskId 稳定排序。短 `BEGIN IMMEDIATE` 事务检查 gate、租约、预算预留，获取所有资源锁与并发槽后才提交领取；失败整体不持有部分锁，不形成死锁。锁由规范化项目根+路径前缀、Git集成分支、迁移/外部目标等构成，大小写/符号链接/目录祖先重叠需统一解析；祖先写范围与子路径写范围互斥，读锁与写锁冲突，多个读可共存。

maxConcurrency 为冻结授权上限，同时受全局上限、CLI/供应商容量与资源限制；验证/集成占用的槽类型分别声明，不能暗中释放所有槽使进程数越界。租约过期但进程可能存活，写锁置 recovering 不自动转交。声明资源无法强制控制时不启动对应任务；不能以 UI 「冲突提示」代替实际保护。

gate 判定由有效证据+requiredArtifact 修订+当前可消费基线共同决定。串行集成成功后发布 consumedBaseline；下游从此基线建立/更新 worktree，记录 consumedRevision。不能直接读前置未验证工作目录或盲复制文件。前置修订失效会传播后继重评，正在运行者先安全停；独立分支继续。静止且有最终 blocked 节点时按交付聚合，不永远显示 running。

## 4. CLI 能力准入与隔离（STORY-041）

能力登记键 `{cliId,cliVersion,adapterVersion,runMode,platform,modelId,effort}`，值为 verified/unsupported/unverified，并有证据/有效期限/配置 fingerprint。会话安装可用不是任务组合已验证。

| CLI | 当前事实 | 正式任务准入需额外证明 |
| --- | --- | --- |
| Claude CLI | 既有非交互 JSONL 会话桥 | 版本固定、模型/effort映射、结构化结束、受管工具权限/知识范围、停止整个进程树、可信 usage 与预算能力 |
| Codex CLI | 既有 exec JSON 会话桥 | 同上；确认运行模式/沙箱与权限映射能兑现当前策略 |
| Grok CLI | 既有 --print --json 尽力尝试 | 参数/事件/模型/权限全部未验证；默认不得用作需受管能力的自动任务 |

策略编译成受管 launch spec：exe 的可信规范路径、参数数组、受控 cwd/environment、短期配置、allowed capabilities、secretRefs。不拼 shell、不继承未经审查的全局 CLI 配置，不修改用户原生配置。实际选定 CLI/模型/effort 必须在允许集且达到 requiredCapabilities/minimumDifficulty；失败不切换。供应商/CLI接口表变化需新适配验证，不猜测参数。

每任务独立本地分支/worktree，分支和路径由 taskId 规范生成，保留用户未提交变更；安全边界另采用受限本机执行账户/平台沙箱、路径 ACL、受管工具/网络入口及知识网关。Windows Job Object 用于进程树监督/限制，**不是文件或网络权限隔离的证明**。防直接读取其他库、凭证存储和其他任务路径；不能兑现任一必要隔离约束时 CAPABILITY_UNVERIFIED/PERMISSION_DENIED 阻塞。

秘密经受控句柄/短期环境引用注入，日志/上下文/事件脱敏；CLI 原生凭据是否可用也必须在授权与隔离策略中声明。知识撤权实时校验并停止受影响任务、清理上下文，不从已有快照恢复撤销的权限。

## 5. 租约、心跳与副作用防重

建议初始技术参数：心跳 5 秒、租约 30 秒、停止宽限 10 秒；这些是待真实环境验证的可配置实现参数，不是用户成本授权。领取事务将 task.fencingToken 单调加一，attempt 绑定 owner/leaseUntil/processIdentity（PID+启动时间+runner epoch）。任何 state/lock/checkpoint/产物提交必须同时满足 owner、attemptId、fence 和未到期租约；迟到事件仅审计，不更新新尝试。

过期后进入恢复流程：暂停调度该写资源→确认原 runner/进程身份→受控停止整树→确认无旧 writer→对账 checkpoint/effect ledger→标旧 attempt interrupted→新 fence 新 attempt。仅 PID 不足防重用，必须校验进程启动身份；无法证明停止时 blocked，绝不自动并发双写。

副作用登记 effectKey、attemptId/fence、intent/applied/confirmed、输入摘要、输出修订。执行前登记意图，执行后对账，崩溃中间态检查实际 worktree/HEAD/目标结果；无法判定已发生的外部副作用不重放。fencing 可拦 DB 回调，不能拦失控旧 OS 进程，物理停止确认不可省略。远端/生产副作用默认不进入允许集。

## 6. 故障、预算和生命周期

暂时网络/短服务故障且可证明无重复副作用时有限退避，遵守 retryAfter；重试次数和累计时间/预算取冻结上限。认证、硬额度、配置、权限、业务决策或不支持组合直接停止对应分支；不把所有 429 一律当暂时故障，区分限流与额度。代码验证失败由 FEAT-020 控制 repairRound，与 transport retry 分开计数，但都消耗预算。

预算每次领取预留、完成释放/结算；同时有 wall-time/attempt/concurrency 硬限额。可信 usage 支持的指标如实保存，缺失为 null/unknown，估算不可充当真实账单；若任务要求成本硬封顶而 adapter/供应商不能强制，则拒绝或用户另明确授权可控非费用门槛，不自行改预算语义。

| 事件 | 独立 runner 模式 | 应用生命周期模式（如提供） |
| --- | --- | --- |
| 关闭主窗口 | UI 脱离；runner 继续领取/执行；重新打开从 DB 对账 | 不以关窗承诺常驻；关闭前明确暂停/停止策略 |
| UI 主进程退出 | runner 独立存活；不将退出 UI 当任务取消 | 停领取，停止整树确认、checkpoint 后退出；异常退出下次恢复 |
| 显式退出 runner | 持久化 draining；停领取，终止/确认旧 writer，保留恢复材料再退出 | 同上 |
| runner 崩溃 | 新协调者先停止/确认遗留 writer，fence 作废后恢复；不凭租约自动重跑 | 下次启动同样对账 |
| 主机重启 | 旧 epoch 进程已不存在仍对账副作用；restartPolicy=resumeSafe 才自动恢复安全任务，pause 则保持暂停，未知副作用 blocked | 必须重新启动应用后对账，不宣称系统后台已恢复 |

独立 runner 自启/ACL/IPC 版本在正式实现时验证；本轮没有安装常驻服务，离线计时器暂停/刷新不是真实生命周期证据。

## 7. 控制 invoke 与 runner 协议计划

共用信封与事件格式见 [LLD-FEAT-018 §6](LLD-FEAT-018-需求派发与任务追踪.md)。拟新增：

| 命令 | 输入 | 输出/约束 |
| --- | --- | --- |
| task_control | projectId, taskId/batchId, action=pause/resume/cancel, expectedRevision, requestId | accepted, controlRequestId, resultingRevision, stopPending；幂等，CAS，服务复核授权 |
| task_runner_status | projectId | runMode, connected, draining, runnerEpoch, protocolVersion, heartbeatAt, recoveryState |
| task_recovery_inspect | projectId, taskId | oldAttempt, processIdentity摘要, checkpoint, effectReconciliation, reason；只读 |
| task_recovery_resume | projectId, taskId, expectedRevision, authorizationRef, requestId | 重检结果；无法确认旧进程停止或策略改变时拒绝，不提供强制忽略按钮 |
| task_capability_check | projectId, frozenPolicyHash | verified/unsupported/unverified组合与拒绝门槛；不在本轮运行真实探测 |

Tauri→runner 经受限本机管道传版本化请求（requestId/projectId/actor/policyHash/expectedRevision），runner 重查 DB 与权限，不信任前端状态。事件追加 task.claimed/state、attempt.heartbeat/interrupted、resource.wait、runner.recovering；完整字段见共用事件信封。错误包括 LEASE_LOST、STALE_REVISION、STOP_UNCONFIRMED、SIDE_EFFECT_UNKNOWN、RUNNER_UNAVAILABLE 和能力/预算错误，均不携带秘密。

## CR-017：原运行续接、阶段交接与条件唤醒

关联 [STORY-046](../Plan/Story/STORY-046-任务续接重试与条件唤醒闭环.md)。运行记录属于Story和执行任务，而非当前查看会话。每次Run/Attempt冻结selectedCli/model、上下文/工作区、workflowStepRevision和需求/AC/设计版本；主动改负责人不改旧记录。只分配不启动；交接先受控停止需停止的旧writer，再创建新的允许阶段Run，独立评审也只读同revision。

人工重试从sourceAttempt出发，`requestId/sourceAttemptId/fresh/contextRevision/expectedWorkflowRevision/reason`参与幂等；原CLI组合复检，不随当前负责人换引擎。原上下文安全且同环境时可续接，否则明示fresh新上下文，不能伪造跨CLI原生线程。失败/取消/被退回Run保留结束记录，新尝试使用新fence，重试/返工/预算沿冻结上限计算，不能清零逃逸；基线或权限变化需要重新确认。当前任务聚合可变，历史Run/报告revision不可覆写。

运行补充消息记录 `commentId/storyId/sourceRunId/actor/workflowRevision/createdAt` 并进入该Run的受权输入；运行结束只保留讨论，是否再次启动由显式策略决定。不能把评论当修改AC/权限授权。文本是资料，执行层限制注入范围。

Runtime离线显示绑定环境与等待状态；恢复同允许组合并复检，配置/权限失败指向统一设置修复，再重检，不静默换机器或CLI。不要用UI可选组合代替adapter矩阵。与正常资源等待区分离线/配置错误，终止不可恢复问题不能永久假运行。

条件规则包含 `ruleId/storyId/workflowRevision/kind/condition/targetCli/instruction/maxFires/expiresAt/onTimeout/enabled`，支持评论事件、另一Story状态+有效产物、子阶段屏障、时钟与模拟CI。规则创建/启停/触发/删除/到期均审计，triggerId幂等，运行中同目标合并消息或待处理事件，不创建第二writer；次数/周期/链路上限阻止自激循环。done/cancel需求停规则；旧阶段条件不推进新状态。取消子项不能作为成功产物屏障，唤醒后仍校验gate/权限/预算。

正式拟新增 `task_run_retry`、`task_comment_append`、`task_workflow_handoff`、`task_wakeup_mutate/list/history`，输入均绑定project/Story/Run/expectedRevision/授权与requestId；这是产品内部待实现接口，不创建宿主定时任务。本轮纯state `retryTask/comment/assign/configure/wakeup` 和仿真时钟只验证交互模型。

## 8. 数据、验证与实施计划

共用 [DB-FEAT-019 §3–6](../DB/DB-FEAT-019-任务执行数据设计.md)，复用旧 project/配置/知识授权但新增任务表、锁、租约、effects；本轮不迁移。共同 [UI-FEAT-018 §4、6](../UI/文档/UI-FEAT-018-任务工作台交互设计.md)、[TEST-FEAT-018 §3–4](../Test/TEST-FEAT-018-任务系统设计验证.md) 覆盖 AC-STORY-040/041。

授权后依次实现存储状态/CAS→独立 runner 协议/监督→DAG/gate/锁槽→adapter矩阵/执行层隔离→恢复/预算/生命周期→集成联测。先在本地隔离仓库验证，不做真实付费/通知/生产副作用。恢复备份策略见 DB §6；未决 CLI版本、隔离证明和预算来源缺失时正式准入关闭。2026-11-19 初版，不引入本轮新依赖。

## CR-026本轮设计闭环交付

[CR026统一计划契约](LLD-CR026-有效执行计划与能力编译.md)贯通配置单源、逐任务预检、确认冻结、实时撤权、原计划retry/fresh、新组合再授权、独立只读阶段和实际交付配置来源。原DAG/产物/验收继续，新增Plan/manifest关系见[DB-FEAT019](../DB/DB-FEAT-019-任务执行数据设计.md#cr-026本轮设计闭环交付)。只操作设计资源，正式执行能力仍待实现；[实际记录](../Test/REPORT-CR026-执行计划闭环设计验证.md)不代替CR031真实门禁验证。

## 9. 2026-11-21调研后的实施优先级与效果验证建议

### 9.1 来源、现状与权威

用户2026-11-21要求研究任务派发／子智能体调度的优化方向与闭环，并进一步授权“完善设计并开子智能体进行方案评审，直到通过”。已形成[闭环实施细化](LLD-R004-调度闭环实施细化.md)、[工作包数据](../DB/DB-CR047-工作包义务与检查点.md)、[故障与效果评估](../Test/TEST-R004-调度闭环故障与效果评估.md)及[逐轮评审](../Test/REPORT-R004-调度闭环方案评审.md)，当前r3经两位子智能体三轮独立评审通过。本节保留研究建议摘要，具体增量以该细化契约为准，原CR-026／031／037／047及Story仍为需求与运行协议来源。未获得正式编码授权；不新增Feature、Story、AC、平行任务表或调度框架，不改变既有软件验收状态。开发分包及M0／M1／M2放行以[CR-031](../PRD/CR-031-受管执行可靠性需求与实施分解.md#52-首版交付矩阵和审批选择)为唯一来源。

本次代码读取表明：正式任务页仍声明runner API未接入；当前派发模块主要是CLI配置注入。普通会话已具备原生引用确认与CAS绑定，Feature执行会话已有身份和索引hash检查；不能再概括为“全部会话均不支持续接”或“没有任何Feature身份”。上述基础不等于Task／DAG／租约／子调用／验证／交付已经实现，也不能把开发宿主的调度工具算成本产品能力。

受管任务执行优先完成执行、质量、效果反馈三层闭环。沿既有Rust／Tauri／SQLite职责落地，不增加与任务账本竞争的模型侧状态权威。

### 9.2 落地顺序：先可验收单链，再受限协作

| 阶段 | 研究后的收敛建议 | 不可省略的前置与原责任 |
| --- | --- | --- |
| 事实基线 | 先复现executor连续两次发送的fresh确认交叉问题；核对外部源修改但索引未刷新的发送行为 | 静态发现尚未复现；会话问题回原责任Feature，源与工作包归本Feature，不能以调研名义修正式软件 |
| M0 | 以最小fake adapter验证不可变计划、命令回执、顺序事件、effect intent、状态机和故障对账 | 明确fake，不能放行真实CLI；原WP与Feature分包不变 |
| M1 | 单CLI、单Story、单writer从真实工作包到审批执行、产物验证、有限修复和待验收报告 | G-PLAN、实际组合能力、有效UI审批稿、真实停止与旁路约束全部先满足；验证与报告由FEAT-020承接 |
| M2的第一协作增量 | 一个执行者＋一个已授权的只读检查者，使用封存产物修订及结构化Finding | 检查方式／模型费用事先纳入ValidationPlan与预算；不读可变工作树，不给检查者审批或业务验收权 |
| M2并行增量 | 两个独立writer验证冲突、依赖、失败保留和串行候选集成，再考虑提高并发 | 同Task共享根Attempt但有独立Invocation／generation／claim；跨Feature独立上下文；实际隔离与有效消费基线必须可证 |

以上为开发与交付顺序，不是运行顺序。每次真实M1启动前，Plan、授权、CapabilityManifest和ValidationPlan均已完整冻结，停止确认、审批失效和原生工具旁路约束均须可执行；不能先运行再补验证标准或停止机制。M1只覆盖单Story验证分支，多代理定向返工和候选集成保持M2，不把M1通过扩为全量AC通过。

### 9.3 委派策略：必要性、硬准入、收益排序

1. 主代理首先提出必要性：能否形成独立产物、是否独立于关键串行路径、是否已有充足上下文与验证方法。简单任务直接执行；共享文件或强串行任务优先单writer。
2. 需要委派时，执行层先过滤父授权、Feature与文件范围、已验证组合能力、现行最低难度、预算和资源冲突。产品门槛是待实施契约，不代表开发宿主配置已落地。
3. 在合格候选中，才根据任务类别、历史完整验收率、延迟、全量成本和集成风险排序。样本不足、模型／适配器版本变化、usage缺失均标未知；历史排名不能替代能力证据。
4. 选择在Plan冻结前完成。原计划重试不因模型自评或排名变化静默换CLI／模型／权限；变化沿原重新确认流程。
5. 派发记录保留必要性、所需能力、独立产物、预计收益与实际结果。初版用可解释策略、受限并发，不自动学习或递归扩张；调整策略先离线验证，再按现行授权采用。

工作包继续采用现有Plan／InvocationBinding，最少可核验目标、不包含项、project／feature／story／AC、层级与授权、输入版本、写范围、产物与验证、组合与预算、父调用和幂等键。必需义务不得因上下文预算静默删掉；详细正文按受权引用加载。UI任务显式保留UI-SCROLL-001及有效设计版本，不以模型“已读”代替覆盖账本。

### 9.4 完成、结果投递与恢复

沿[CR-031](LLD-CR031-受管执行可靠性契约.md#32-接纳提示结束执行静止投递独立)区分accepted、promptEnded、executionSettled、deliveryPending。子结果由内部耐久consumer收录，父忙时合并通知，重复投递不重复执行；停止根后旧结果只归档。UI离线不保持假运行，内部消费到期则明确阻塞。

接纳事务和effect intent保证可对账，不宣称数据库与OS／网络跨介质exactly-once。原生续接只恢复历史；业务恢复还需外部检查点、版本、HEAD／差异、权限、剩余预算和effect对账。旧writer未证实停止或副作用unknown时不能启动替代writer。暂停／retry_wait／可恢复blocked继续保activeKey，物理资源释放另依停止证据判断。

产物候选、验证、定向返工、修订失效、集成和验收直接引用[FEAT-020方案](LLD-FEAT-020-自动验证与交付.md)和[CR-037协作契约](LLD-CR037-主代理协作契约.md#4-技术审查与返工)，不在本节维护第二套状态。transport retry、格式修复与实现返工分别计数且共享原根预算。模型自报完成、多个检查者赞同或进程退出0不能直接发布成功。

### 9.5 效果反馈与候选验证实验

先用固定任务集建立单代理基线，再比较“执行＋只读检查”和受限并行。任务集应含单点修复、串行变更、独立实现、资料验证、依赖失效及恢复，固定源／AC／设计／验证器／初始环境／允许组合／总预算。初期每类5项共30项仅为先导样本建议，不代表统计充分或已确认目标；模型随机性须重复运行，报告分层结果与样本量。

至少记录：全部必需AC通过的任务比例、首次通过率、错误完成次数、全量成本／验收成功任务数、端到端时延、人工介入与返工、恢复正确性和协作额外开销。失败、超时、取消、协调、检查、重试和恢复都计入成本；成功数为零不生成比值，费用未知不填零。安全恢复区分安全继续、正确阻塞、违规重放；正确阻塞未知副作用不能为了指标被强行重试。

候选实验复用原测试映射：重复派发、接纳后启动前崩溃、作用后回执前崩溃、父轮结束子仍运行、多个子同时完成、停根后迟到结果／审批、残留writer、源改动证据失效、写范围冲突、exit0但遗漏AC、内部消费失败与外部UI离线、预算耗尽。当前全部未执行，不增补为已通过AC。真实写入前必须通过安全相关故障门禁，不能推迟到并行阶段。

只有同类任务中质量底线不下降、成本或时延有可复现改善，才建议扩大并发；具体幅度先测本项目基线再确认，不预设无依据的性能提升百分比。失败类型与策略版本关联，离线提出改进，经既有确认流程采用和回退，执行中不得自改验收器／成本上限。

### 9.6 UI、数据和本次验证边界

本轮没有修改UI或数据库结构：UI继续使用原设计入口及CR-031／037／047覆盖要求，新增可见策略字段或状态在进入开发前必须补可操作稿并登记；本节不是UI开发准入。数据复用Plan／Attempt／Invocation／event／effect／artifact／evidence／outbox设计；效果统计的持久字段与保留期限待实际实施包细化，不先创建平行账本。

本节经过一次独立只读方案核验，已补运行前置、冻结前排序、检查者权限、根子身份、内外投递、统计分母等六项约束。只完成研究／文档核验，没有软件验证、组合能力实测或收益实验，不改变任何Story的验收结论。
