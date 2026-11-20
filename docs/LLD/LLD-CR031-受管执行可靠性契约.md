# LLD-CR031：受管执行可靠性契约

- 关联：[需求与唯一WP实施分解](../PRD/CR-031-受管执行可靠性需求与实施分解.md)、[数据契约](../DB/DB-CR031-事件审批与产物记录.md)、[测试](../Test/TEST-CR031-受管执行可靠性验证.md)、[审查与闭环](../Test/REPORT-CR031-需求设计审查.md)。
- 继承：[CR026计划与能力编译](LLD-CR026-有效执行计划与能力编译.md)、[派发/事件](LLD-FEAT-018-需求派发与任务追踪.md)、[runner/租约/恢复](LLD-FEAT-019-依赖调度与受管执行.md)、[验证/集成/交付](LLD-FEAT-020-自动验证与交付.md)、[设计资料按需读取](LLD-CR027-设计资料与按需工具契约.md)、[存储分工](../PRD/CR-028-文件与数据库按职责存储.md)。
- AC唯一源：[STORY-021](../Plan/Story/STORY-021-多会话历史与后台任务.md)18/19、[022](../Plan/Story/STORY-022-按需子智能体与用量统计.md)14/15、[041](../Plan/Story/STORY-041-CLI隔离执行与故障恢复.md)09/10、[042](../Plan/Story/STORY-042-自动验证集成与有限返工.md)09/10、[043](../Plan/Story/STORY-043-批次交付与验收依据.md)09/10、[054](../Plan/Story/STORY-054-Agent规则与分层授权工作包.md)06/07、[058](../Plan/Story/STORY-058-任务能力白名单编译与实时复检.md)09/10。
- 文档修订：r2，2026-11-19，依据用户在审查后“继续”修正契约；方案待评审，正式能力未实现/未验收。逻辑schemaVersion=1仍是未发布初稿的修订，不冒称已有生产兼容；若实施时已经发布旧格式，必须另升版本并做兼容迁移。
- 工作边界：只文档；未运行CLI、正式测试、构建、迁移或业务，未修改原型。新增UI状态仍需[有效可视稿](../UI/文档/UI-CR031-执行可靠性场景覆盖.md)；该清单不是可视版本。

## 1. 权威与统一运行身份

### 1.1 权威与模块边界

需求/AC/设计正文在文件；配置、授权、运行事务在同一SQLite；完整报告/ResultEnvelope/Finding/长日志为受管文件，DB只存有限摘要、URI/hash和结构关系。既有Task/Step/Attempt、DAG、锁、effect、证据、集成、outbox保留，不新建平行业务Run表或可编辑Plan库存。

runner内部职责为AdapterGateway、EventJournal、CompletionDelivery、ApprovalGate、ResultValidator、CaptureStore、StageReview、RuleResolver。Tauri和CLI仅是受管客户端/执行载体。现`commands/chat.rs`/`dispatch.rs`可提取协议解析经验，不能把其内存运行表直接升级为任务权威。

### 1.2 InvocationBinding：两个来源，一套明确结构

所有运行对象使用同一个**嵌套**字段`binding: InvocationBinding`，不再在正文、例子中混用部分平铺字段。`InvocationBinding`字段全部必须出现，可空项必须显式null：

```json
{
  "projectId": "project-demo",
  "invocationId": "inv-root-demo",
  "origin": "sessionTurn",
  "attemptId": null,
  "sessionTurnId": "turn-demo",
  "rootInvocationId": "inv-root-demo",
  "parentInvocationId": null,
  "executionFence": 3,
  "invocationGeneration": 1,
  "parentGeneration": null
}
```

- `origin=task`：attemptId非空、sessionTurnId=null，从既有Attempt解析唯一Task/Step；executionFence等于当前Task fencingToken。
- `origin=sessionTurn`：sessionTurnId非空、attemptId=null，对应已有项目会话的一次受权输入；executionFence等于该turn当前invocationFence。**不创建Story/Task/Step/Attempt**。无项目的服务器/全局会话不伪造project；其旧功能保留，但本批项目执行协议不宣称已经覆盖它们。
- 根调用：rootInvocationId=id，parentInvocationId/parentGeneration=null；同一Attempt或同一sessionTurn至多一个根。普通会话原生线程token另由受管引用保存，不把调用身份当原生续接证据。
- 子调用：rootInvocationId沿根，parentInvocationId/parentGeneration绑定直接父调用及其代次；origin、attemptId/sessionTurnId、executionFence与根一致。每个子调用有自己的invocationId、generation、Agent、Job和冻结子Plan。禁止创建兄弟Attempt后递增同一Task fence。
- `executionFence`隔离整个根运行的重试/接管；`invocationGeneration`隔离该调用的停止/重启。记录中的binding为不可变快照，执行时逐级检查根fence、当前调用与全部祖先generation/stop状态。停止一个子调用只提升其generation，后代旧binding因祖先链失效；兄弟和父不失效。根重试创建新Attempt或新sessionTurn，旧根全树失效，不改历史对象归属。

### 1.3 子代理组织、资源与预算

选定**子Agent挂父Attempt的Job/Invocation模式**。同一Task内所有子调用共享根Attempt归属，但不共享invocationId。Task.currentAttemptId和Task.fencingToken只由根调度领取/接管改变。`UNIQUE(projectId,attemptId)`只能用于根调用的部分唯一索引，不能加在全部Invocation上。

根仍持有Task资源锁/activeKey；子工作区在根允许范围内独立隔离，子Plan范围不能超父交集，兄弟写范围重叠必须串行或拒绝。runner登记child resourceClaim，领取时检查同根父/兄弟冲突；父在委派范围上同样受约束，不能一边让子写、一边直接覆盖。claim是原资源锁下的受管子占用，不能给子赋权读写根范围之外。若适配器/OS不能兑现子工作区边界，不启用写子代理并行。

子重试先确认该子进程树退出，再新建invocationId并记录sourceInvocationId、沿同根剩余预算；不修改Task fence，父/兄弟结果仍有效。根重试必须先确认整树停止。必须独立业务Task的工作只通过原派发/快照/依赖流程建立，不能由parentAgent链隐式扩入授权。

Plan编译复用CR026，普通会话/子调用仅增加origin/来源引用；分阶段评审用PhasePlan。每次子预算预留在同一根ledger短事务中扣占可用额度，兄弟不能分别复制同一剩余额度；结果到达再按原计量结算，unknown不作零。

## 2. 版本与有限线格式

### 2.1 通用规则

- 时间UTC epoch ms；安全整数；hash为`sha256:<64个小写hex>`并有hashRuleVersion。重复JSON键、非有限数、未配对Unicode代理字符、未知必需字段/枚举拒绝；扩展仅在注册的extensions中。
- 建议技术初值：物理帧256KiB、逻辑重组最多1MiB、JSON深度16、普通事件payload最多8KiB。事件分页同时受500项与**协商帧字节上限减信封开销**限制；不因页默认值突破帧。大内容走受管文件分页，不把整个历史塞入帧。
- requestId在`projectId+actorRef+operation`内幂等，requestDigest不同拒绝；运行幂等再绑定invocation/sourceCallKey，不依赖nullable attemptId。actor由端点会话验证，不接受前端或模型自报身份。

### 2.2 对象定义

下表中的binding是§1.2完整对象，不是可省略的字段宏；JSON Schema定义时必须引用同一个`$defs.InvocationBinding`，DB需使用对应明确列和复合约束。

| 对象 | 有限字段/约束 |
| --- | --- |
| AdapterHello | schemaVersion, protocolVersion, supportedVersions, adapterId/version, cliId/version, platform, runMode, limits, capabilities[], evidenceRefs[]；可信adapter生成 |
| CapabilityEvidence | id, combinationFingerprint, capability, status=verified/unsupported/unverified, evidenceUri/hash, verifiedAt?, expiresAt?, verifierVersion；未核验不虚填时间/证据 |
| CommandReceipt | id, projectId, actorRef, operation, requestId/digest, executionClass=invocation/project, binding可空, status=accepted/rejected, admittedAt?, responseSummary,error?；已接纳运行必须binding，拒绝/项目控制可null |
| ExecutionEvent | eventId, projectId, eventClass=invocation/project, binding可空, seq, journalSeq, eventType, commandReceiptId可空, sourceEventKey, sourceSeq?, nativeTimestamp?, planRef可空, disposition=current/auditOnly, payload, createdAt；运行事件必binding且项目一致 |
| CompletionNotice | completionId, binding, ownerType=session/agent/task, ownerId, terminalEventId/terminalSeq, outcome=succeeded/failed/cancelled/interrupted/blocked, resultManifestRef?, stopGeneration, createdAt；只通知，非状态权威 |
| ApprovalRequest | approvalId, binding, agentId, toolCallId, finalArgsHash, hashRuleVersion, planRef, authorizationRevision, bindingHash, expiresAt,state,revision；显示摘要来自同一封存FinalCall |
| RuleBinding | ruleId, sourceRef, sourceRevision, contentHash, sourceTrust, layer=baseline/onDemand/gate, applicability, enforcement=remind/block/repair, requiredCapabilityRefs |

所有agent/job/process/toolCall/result/capture都绑定invocation；非运行项目事件来源字段为空且不能携带工具执行/产物成功来绕过校验。sourceEventKey的运行定位用invocationId+generation+sourceFrameId，项目事实用receipt/configRevision等稳定键。

### 2.3 事件实例

```json
{
  "schemaVersion": 1,
  "eventId": "evt-demo-17",
  "projectId": "project-demo",
  "eventClass": "invocation",
  "binding": {
    "projectId": "project-demo", "invocationId": "child-demo", "origin": "task",
    "attemptId": "attempt-demo", "sessionTurnId": null,
    "rootInvocationId": "root-demo", "parentInvocationId": "root-demo",
    "executionFence": 7, "invocationGeneration": 1, "parentGeneration": 1
  },
  "seq": 17,
  "journalSeq": 932,
  "eventType": "tool.result",
  "commandReceiptId": "receipt-demo",
  "sourceEventKey": "adapter:epoch:child-demo:g1:frame8",
  "planRef": {"id": "plan-child", "revision": 1, "hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "createdAt": 1795074000000,
  "disposition": "current",
  "payload": {"toolCallId": "tool-demo", "outcome": "failed", "captureRef": "capture-demo", "captureIntegrity": "truncated"}
}
```

事件有限集包括command.accepted/rejected、invocation.started/promptEnded/executionSettled/interrupted、session.settled、message.started/textBatch/thinkingBatch/ended、tool.requested/started/result、approval.pending/resolved/superseded/consumed、agent/job/process.state、control.requested/stopConfirmed、result.candidate/validated/rejected、capture.sealed/failed、rule.bound/triggered/invalidated、review.finding/closed、delivery.sealed、notification.acked。继承Task/证据/集成/document.sync事件，旧未发布`attempt.sessionSettled`不继续作为新协议字段。

## 3. Plan前置、接纳和静止语义

### 3.1 启动前置

真实M1启动须有CR026 ConfigBroker/Resolver、原子确认和不可变Plan持久化，不可用DEMO/fake Plan替代；见PRD §5.1的G-PLAN。契约fixture可先开发验证M0，不因此宣称M1已交付。

`requestId去重 → 读取冻结Plan/当前授权 → 可信IPC握手 → 组合能力证据核验 → 根领取/绑定子调用或sessionTurn → receipt与accepted事件同事务 → 准备隔离工作区 → 二次复检 → spawn → 事件持久化后投递`。不在DB事务做网络/大文件I/O。

组合键包含CLI/adapter/runtime版本、平台、运行模式、协议、模型/effort与所需能力。CLI安装成功不是能力证明。证据变化阻止受影响运行；不静默换CLI/model/runtime。当前Claude/Codex会话桥有基础但人工审批/原生工具限制/原生续接/整树停止等组合仍未核验；Grok通用参数也未核验。初版明确选择见§6.4，不把它记成已验证。

### 3.2 接纳、提示结束、执行静止、投递独立

| 事实 | 定义 | 与业务成功的关系 |
| --- | --- | --- |
| accepted | 输入已持久接纳；未必spawn | 不证明完成 |
| promptEnded | 某CommandReceipt提示结束，reason=completed/error/cancelled/interrupted，partial/result引用 | 子仍可活动 |
| executionSettled | 该根/子调用及其适用后代无活进程、排队执行、已安排续行、待批或正在处理的内部结果消费；阻塞/暂停且无可执行工作可静止 | 不证明Task成功；显式等待原因独立保存 |
| sessionSettled | 该项目会话所有活动根调用executionSettled且无待接纳输入，按session activityRevision做CAS的派生聚合 | 不给会话伪造Task验收 |
| deliveryPending | 给UI/历史消费者的外部通知尚未耐久确认 | 与executionSettled、sessionSettled正交；UI离线不保持假running |

子结果先由runner内部稳定consumer持久登记`child_result_receipt`及等待后继处理事项。UI订阅不是父Agent结果接收者。父仅在必需子结果结构/业务门槛满足后推进Task；内部消费暂时失败进入resultWaiting，使用冻结Plan的resultReceiveDeadlineMs与投递重试预算，不能无限续租假running。到期变blocked/RESULT_DELIVERY_BLOCKED，执行工作已静止可executionSettled=true，Task不成功；恢复内部消费须重检原Plan/停止代次，不重跑已完成子命令。若用户停止，内部结果只归档，不排队模型续行。

每个accepted提示唯一promptEnded绑定commandReceiptId。invocationSettled事件按invocationId/generation/activityRevision唯一；sessionSettled按sessionId/activityRevision唯一，服务端在写入时重查所有根。新的受权输入提高活动修订，旧事件不能关掉新工作。没有消费者时外部outbox可pending/paused，不能阻止已完成执行静止。

## 4. 事件持久化、补读与通知

接纳顺序用于交错恢复，sourceSeq/nativeTimestamp保留原来源；不声称并行进程的全局真实因果顺序。文本可250ms或不超过事件payload预算成批，I/O失败/崩溃标部分或尾段未知，不承诺每token零丢失。关键控制/审批/终结事务提交后才响应。

继承execution_event.seq全局主键作为journalSeq，项目内projectSeq映射线格式seq。同事务分配projectSeq，rollback不推进。旧afterSeq接口保留全局含义，新opaque cursor绑定project、streamEpoch、授权修订、lastSeq与协议版本。

一致读快照返回stateHash、lastSeq、floor、epoch、活动状态/审批、停止代次和deliveryPending；补读从该高水位开始，允许重复，按eventId去重。缺口先停投影并有限补读；cursor过期/epoch改变返回CURSOR_EXPIRED重取快照。v1只给有整项目读取权限的受管UI整项目事件流，session/job过滤在客户端；模型、子代理和部分权限主体不得获整项目流。未来局部流需独立范围/序号契约，不能发无权事件号补连续。

裁剪先封存检查点与保留边界，细粒度片段可归档；授权/审批/effect/完成receipt/证据不从投影猜测，默认不自动删。长正文和日志分页，不把快照当全量长日志。

终结事实、terminal event、外部completion outbox和内部child result enqueue在同一事务记录。外部消费以completionId+consumerScope幂等，receipt持久后才ACK；ACK不等用户已读、不放业务gate。通知集合冻结，后加窗口查快照，不重新执行。noticeHash不同拒绝；停止/旧binding只archivedOnly。投递重试耗尽显示deliveryPending，执行outcome不改成失败。内部结果消费和外部UI投递使用不同consumerKind，前者受§3.2期限和父Task门槛约束。

## 5. 资源、停止、恢复

### 5.1 分开的fence与锁

所有作用要求根executionFence、当前invocationGeneration、祖先代次、owner/lease、Plan和实时授权同时有效。子只能提交候选结果，由runner按根状态评估；不能因拥有子Plan直接公布Task成功或释放根锁。停止子调用只取消子树待审批和子resourceClaim/Job，父/兄弟及Task.activeKey不变。根停止须确认整树无writer。

### 5.2 activeKey不等于物理写锁

`controlRequested → stopping(stopPending) → stopConfirmed → paused/cancelled/interrupted`。Job Object/监督器确认无writer、网关拒新调用、待审取消，才可释放对应物理锁/并发槽；EOF、kill返回、lease过期均不证明整树已停。

| Task状态/控制 | 资源锁 | activeKeyHeld |
| --- | --- | --- |
| stopPending/STOP_UNCONFIRMED | 保留并置recovering | 1 |
| paused、retry_wait、可恢复blocked（含可继续的人工停止） | 停止/检查点/作用对账确认后按策略可释放；恢复须重新领取 | **保持1**，拒绝同Story/baseline新派发 |
| succeeded/failed/cancelled不可恢复终态，或明确finalBlocked | 旧writer全停、作用/产物清理核对完成后释放 | 条件全部满足才0，旧Task不再resume |

人工“停止”必须在控制请求中明确pause或cancel；不得靠autoResumeSuppressed推断业务终态。activeKey阻止重复业务任务，资源锁保护物理写范围，两者不能一起无条件清空。普通会话无业务activeKey，session发送串行/资源冲突仍由根调用约束。

### 5.3 对账与重试

进程身份为pid+startIdentity+runnerEpoch+processTreeId+launchSpecHash，权威由监督器提供。接管先drain/旧owner失效、锁recovering → 确认原树退出 → 对账effect/checkpoint/worktree/HEAD/manifest/file intent → 证明已应用补记，证明未应用且仍受权才新调用执行，未知blocked。根重试新Attempt（任务）或新sessionTurn记录（会话，关联sourceTurnId），历史不可改running；同根子重试按§1.3，不提高Task fence。

停止代次、Plan撤权优先于自动恢复；迟到结果/approval/规则/审查只能归档。fence只是数据库条件，不提供OS物理隔离或外部副作用exactly-once。

## 6. 最终参数审批与首版正向路径

### 6.1 FinalCall

有限对象明确为`{schemaVersion, binding:InvocationBinding, agentId, toolCallId, toolId, toolSchemaHash, operation, args, planRef, authorizationRevision, ruleManifestHash, processIdentityRef:null|Ref, cwdIdentity, targets[], networkTargets[], effectClass}`。不另发未绑定的attemptId/taskFence。所有字段参与FinalCall规范化hash；凭据只有secretRef，完整对象封存文件，UI同对象产生脱敏摘要。

`schema校验 →原输入deny检查 → 可信扩展/适配归一化 → 最终deny与范围检查 → 冻结FinalCall → 审批 → 当前根/子/祖先代次与授权/期限/目标复检 → 原子消费批准并写effect intent → 实际作用`。

JCS RFC8785后UTF-8 SHA256；hashRuleVersion=final-call-jcs-v1，重复键/坏Unicode/不安全数拒绝。路径由可信根、符号链接/大小写/目录身份规范化，既有文件写入绑定expectedHash；网络绑定host/port与实际连接范围/重定向，未知限制拒绝。bindingHash包含FinalCall hash、调用ID、Plan/授权/规则修订、期限与scope，不能跨调用复用。

### 6.2 审批与一次消费

pending→approved/denied/expired/cancelled/superseded；approved未消费仍可过期/撤权/取消；approved消费后保留consumedAt/effectKey不可重置。所有终态不可变回approved，重检创建新approval。

原始requestId/最终参数相同重试只查询原toolCall和effect，不新起作用。审批决定端验证本机用户身份和当前授权；回复含approvalId/expectedRevision/bindingHash/decision/requestId，批准调用不是工具执行者自签。无传输时拒绝所需组合，已pending断线保留至Plan.approvalDeadlineMs、到期取消，不自动批准。

文件hash/内容先在事务外以受控不可变句柄验证；短BEGIN IMMEDIATE只比较可信摘要、绑定版本、expiresAt、祖先代次/根lease/当前授权，CAS消费批准+唯一effect intent+事件。实际作用前再做TOCTOU，失败不清consumedAt，按下面恢复契约处理。文件/网络动作不在DB事务内，不声称跨介质原子。

逻辑作用使用稳定`operationId`（在受管服务分配并参与FinalCall.args）与`semanticInputDigest`，摘要包含工具/schema、动作种类、资源身份/预期版本和目标内容hash，排除每次变化的toolCall/approval/binding ID；各尝试FinalCall hash仍包含完整Binding，不能混用两个摘要。`operationId`不是新的授权，每次尝试仍须Plan/权限/预算及新FinalCall审批。每个toolCall最多一个effect，已消费不得重审后再次执行同toolCall。

批准消费→作用前失败或崩溃时，监督器先确认旧writer停止，受管对账保存`reconciliationOutcome=confirmedNotApplied/confirmedApplied/unknown`和可复核证据；仅全部前序effect均confirmedNotApplied时，才在同一operation guard短事务内创建**新toolCall/sourceCallKey、新批准、新effect**，带retryOfToolCallId/retryOfEffectId并沿原operationId与semanticInputDigest，计入原尝试/修复预算。参数、目标语义变化不能复用operationId，须新操作和授权重检；同参数但需重试也不能复用旧consumed批准。guard对同operationId只允许一个inFlight作用；若已confirmedApplied则只返回原结果，unknown或旧writer未确认则blocked，不能以改ID绕过去。旧批准/intent/对账证据永久保留，不复位消费，不承诺通用exactly-once。

Host/MCP/脚本桥都走门禁；脚本内新的工具作用独立检查，外层审批不自动授全部内层工具。原生CLI工具无法拦截/隔离时禁用必要组合，不靠提示词。

### 6.3 真实Plan门槛

G-PLAN由WP-01/02承接CR026实际配置只读目录、Resolver、server-side hash、原子confirm、不可变Plan/授权引用和CapabilityManifest存储，先通过“改默认不改旧Plan、撤权拒启动、原Plan重试不换配置”。对应原STORY-057/058/059仍是源，未落地时只能M0契约fixture，不能进入真实M1。

### 6.4 首版采用的审批路线（设计选择，未验证）

选定首个**验证目标**为Claude Code非交互stream-json适配＋受管stdio MCP gateway＋Tauri审批主体。它利用现有桥基础；不声明具体版本支持已核验，不因选择它而改变产品CLI默认。WP-01在授权测试环境检测可执行路径/版本、严格MCP配置、可用原生工具限制、工具超时与取消能力，冻结组合证据。所需能力不成立则M1 blocked，不自动改用bypassPermissions、另一CLI或无审批执行。

- 只向CLI暴露本次Plan的MCP工具；第一验证动作是`workspace.apply_text`对隔离项目内明确测试文件进行有限写入，参数固定relativePath、expectedHash（新文件用absent）、content/contentHash、operationId。真实M1用这个实际文件作用验证，不用UI仿真或fake adapter代替。
- gateway在执行前生成FinalCall，**保持工具请求待决且没有文件副作用**；Tauri认证的本机用户查看同一FinalCall摘要/目标/范围并批准或拒绝；批准后runner一次消费并执行写入，返回真实新hash和日志。请求回放/ACK丢失只能返回原结果，文件作用计数不增加。
- CLI原生写入/exec/未审MCP必须禁用或由已证隔离覆盖；允许免原生MCP二次询问只表示让请求到gateway，不能绕宿主审批。否则组合拒绝。审批等待超出CLI transport deadline时失败并取消原待审，迟到批准不执行；相关deadline在Plan冻结且预检核对兼容。
- 用户审批UI依赖现C31-03先补可视版本；宿主停止必须取消pending gateway调用并停止受管树。必验拒绝/超时/撤权/参数变更/重复答案/断线/停止均副作用0，正常批准1次。

M0只做契约和fake环境；M1是单CLI单Story串行受管审批/恢复/验证/报告；M2才启用子代理并行、多CLI与本地候选集成。M1不代表14条AC全范围完成，M2未执行项保持未验收。完整里程碑矩阵由PRD §5.2唯一维护。

## 7. 结构化结果与阶段审查

### 7.1 ResultEnvelope v1

```json
{
  "schemaVersion": 1,
  "resultId": "result-demo",
  "binding": {
    "projectId": "project-demo", "invocationId": "inv-turn-demo", "origin": "sessionTurn",
    "attemptId": null, "sessionTurnId": "turn-demo", "rootInvocationId": "inv-turn-demo",
    "parentInvocationId": null, "executionFence": 3, "invocationGeneration": 1, "parentGeneration": null
  },
  "agentId": "agent-demo",
  "planRef": {"id": "plan-demo", "revision": 1, "hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "status": "candidate",
  "summary": "普通会话已生成受管文件，等待调用方检查",
  "baseRevision": null,
  "outputs": [{"kind": "managedFile", "resourceId": "file-demo", "revision": "r1", "contentHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],
  "verificationEvidenceRefs": [],
  "findingRefs": [],
  "unresolved": [],
  "usage": {"status": "unknown", "inputTokens": null, "outputTokens": null, "sourceRef": null},
  "captureRefs": ["capture-demo"]
}
```

字段必须含binding；outputs按kind区分artifactRevision（任务产物）和managedFile（会话受管文件）。task origin代码交付baseRevision必填且artifact引用受检；sessionTurn可baseRevision=null且不创建业务artifact/evidence/gate，verificationEvidenceRefs和findingRefs为空，检查事实可用capture/受管结果引用。模型不自报succeeded，status=candidate/failed/cancelled/interrupted/blocked。

上限：summary1000字符、outputs100项，证据/Finding/capture各200，unresolved100，完整128KiB。结构→binding/Plan/祖先代次→资源存在/授权/hash→输入基线→候选封存→既有verifier/集成/AC。错误schema/reference/stale分别保存，格式修复与实施返工共享根repair/预算总上限，停后不修复。manifest去重为project+invocationId+generation+manifestHash，重投普通会话不能因attemptId=NULL产生重复。

子输出只作为候选交回父，发布Task有效产物须当前根fence及全部必需检查。结构合法不等于产物成功、集成成功或验收。

### 7.2 StageReview与Finding

只在冻结ValidationPlan声明的阶段审查，不默认额外付费模型；human/builtin/cli reviewer均有真实主体引用，模型评审PhasePlan只读，不能写业务产物、批准调用或代验收。

Finding：`findingId,reviewRecordId,projectId,stage,reviewerRef,phasePlanRef?,subjectKind,requirementSnapshotId?,artifactRevisionId?,acHash,designHash,validationPlanHash,consumedBaseline?,evidenceRefs[],severity=P0..P3,confidence,code,title,bodyUri/hash,state=open/acknowledged/resolved/invalidated`。

- designGate：已授权prepare阶段，subjectKind=requirementDesignSnapshot，只绑定冻结需求/设计/AC快照；artifactRevisionId/consumedBaseline为空，不伪造代码产物。派发前只读预检仅诊断，不建虚假Attempt/Finding。
- artifactDelivery：subjectKind=artifactRevision，绑定产物修订/AC/设计，consumedBaseline按该任务实际输入填写或明确不适用。
- integratedReview：绑定产物修订与非空实际verified candidate/consumedBaseline，缺基线拒绝。

各阶段版本变化使Finding invalidated，新证据/受权复核才可resolved；原观点留历史。AC042-10、测试和DB使用同一条件矩阵。StageReview记录本身也保存subjectKind互斥引用，不保留旧必填artifact造成设计阶段插入失败。

## 8. Capture与封存

CaptureMetadata有限对象：`{captureId,binding:InvocationBinding,agentId,jobId:null|id,stream:stdout|stderr|tool|result,sourceRef,state:recording|sealing|sealed|failed,integrity:complete|truncated|captureFailed|unknown,sourceCoverage:live|legacy,uri:null|string,contentHash:null|string,capturedBytes,sourceBytesKnown:null|int,elidedBytes:null|int,maxBytes,headBytes,tailBytes,lastCommittedSeq,startedAt,endedAt:null|time,captureErrorCode:null|string,redactionPolicyHash}`。

建议每capture16MiB、显示分页64KiB并受协商帧限制，事件仅8KiB内摘要/引用；总文件预算从Plan冻结，UTF-8安全边界截断。complete需EOF/flush/close/readback与封存全部成功；限额为truncated，I/O错误为captureFailed，历史缺证据unknown；来源legacy不是完整性。hash指实际脱敏封存字节，不伪装原始未脱敏日志。

`DB file intent → 临时文件写入/flush/close/校验 → 同卷不覆盖封存 → DB登记URI/hash/摘要/事件 → 指针CAS`。DB失败恢复按intent身份/hash补记，不再执行CLI。文件坏/缺使当前证据/报告失效；孤儿文件隔离核对不擅删。完整报告与summary同修订，document_outbox负责Story正文CAS，完成ACK不得改验收/发布。

## 9. 规则来源与适用范围

### 9.1 首版受信来源

1. 宿主随版本发布的可信baseline规则，固定id/version/hash；不得由项目文件降低授权底线。
2. 已授权项目根内的`AGENTS.md`及任务read/writeScopes涉及目录的祖先/子目录同名规则。RuleResolver维护**受管只读规则清单**，规范根/路径、内容hash、trust来源、ruleScope；不执行文件内脚本或外部链接，不自动导入用户HOME/仓库外规则。额外规则源须授权注册。
3. Skill规则仅取CR026已选定并固定hash的内容；普通网页、工具输出或未授权规则文件只作untrustedMaterial，不能加入权限政策。

CR027的project_design_list/read仅服务PRD/UI/方案/模型，本批不扩它们分类。RuleResolver使用独立内部只读发现/读取流程，复用版本/有界片段原则而非假称这些工具能读AGENTS。无新增对模型任意路径工具。

### 9.2 匹配、覆盖、冲突与失效

以规范项目相对目录段匹配，祖先规则覆盖其子树，`src/a`不匹配`src/ab`；符号链接逃逸拒绝。任务scope为目录时先在已授权范围索引所有适用子目录规则位置；只装载当前阶段所需内容，但新路径工具调用前必须补齐该路径祖先链的适用规则和manifest再执行。新路径超Plan scope直接拒绝。

明确同ruleId且规则类型声明可override的非授权规范允许更深目录细化；baseline、权限/预算/工作层级只可收紧，不接受文件声明扩权。自然语言互斥或不可判冲突返回RULE_CONFLICT交原需求/规则修订流程，不让模型默择有利版本。必须规则缺失、读取失败、sourceTrust未知、未接入支持的规则源都为RULE_SOURCE_UNAVAILABLE，不以空集合放行。

源变化按目录scope与Plan read/writeScopes/selectedRuleRefs相交传播：根AGENTS变更使全项目相关Plan待重检；`src/a/AGENTS.md`变化影响覆盖src/a的Plan，独立src/b Plan不失效；同一Plan同时包含a/b则整个该Plan失效，不能局部继续使用旧快照。新增/删除/移动规则与修改同等处理，watcher只提示，启动和每次作用前复检来源hash；撤权立即阻断，hash冻结不恢复权限。每次重检生成新manifest/必要的新Plan，保留旧版本不热替换。

### 9.3 三层与有限修复

baseline少量常驻、onDemand按适用范围/阶段加载、gate在runner与工具调用处确定性校验。RuleManifest含sourceRef/hash/适用理由/已加载范围/输入修订；缺底线不准入。规则内容只影响方法和约束，不能新增操作授权。

trigger记录binding/rule/version/cause/预算/结果，重复triggerId幂等。rule、schema、implementation修复共用根总额度，局部上限取更小者；新输入/子调用不能重置计数。无进展、涉及改AC/权限、能力不足、用户停止或预算耗尽均停止有限循环。流式regex/AST不是首版要求，更不能视作OS隔离证明。

## 10. 接口与错误

查询受服务端项目授权；模型不自报project/actor/verified。请求ID、版本、bindings由可信入口校验。拟议接口：adapter_inspect(planRef)；execution_snapshot_get(projectId,viewScope)；execution_events_read/subscribe(cursor,limit)；execution_completion_ack(completionId,consumerScope,requestId)；execution_approval_decide(approvalId,revision,bindingHash,decision,requestId)；execution_result_get(resultId,revision)；execution_capture_read(captureId,hash,selector,cursor,maxBytes)；execution_review_get(reviewRecordId,revision)。恢复复用原task_recovery接口，普通会话增加origin定位而不假造taskId。

错误分类：PROTOCOL_VERSION_UNSUPPORTED/PROTOCOL_MALFORMED/FRAME_TOO_LARGE拒绝协议；CAPABILITY_UNVERIFIED/UNSUPPORTED、PLAN_STALE、G_PLAN_NOT_READY拒启动；NOT_FOUND_OR_DENIED、AUTHORIZATION_REVOKED不泄漏资源；IDEMPOTENCY_MISMATCH、STALE_REVISION/FENCE/INVOCATION_GENERATION拒旧作用；CURSOR_EXPIRED/EVENT_GAP重取快照；APPROVAL_CHANNEL_UNAVAILABLE/BINDING_CHANGED/EXPIRED/ALREADY_CONSUMED拒执行；TARGET_CHANGED、STOP_UNCONFIRMED、SIDE_EFFECT_UNKNOWN保持必要锁并blocked；RESULT_SCHEMA_INVALID/REFERENCE_INVALID/STALE、RESULT_DELIVERY_BLOCKED按有限修复/等待；CAPTURE_FAILED/TRUNCATED/FILE_MISSING/HASH_MISMATCH/STORAGE_QUOTA_EXCEEDED准确标签；RULE_SOURCE_UNAVAILABLE/CONFLICT/VERSION_CHANGED、REPAIR_LIMIT_REACHED、REVIEW_STALE停止受影响步骤。

非终态必须有期限、明确外部解除条件或用户暂停；无可推进活动仍最终阻塞按既有聚合处理，不假running。诊断脱敏，不能返秘密或无权对象信息。

## 11. 实施、迁移与回退

唯一WP-01～07与M0/M1/M2范围在PRD §5；不新增第二计划。新增binding、根/子代次、activityRevision、静止/投递分离的具体列与索引在DB-CR031。

先真实Plan门槛，再单适配器能力证据、存储、门禁、受管执行与报告；UI在对应可视状态齐备后接入。M0 fixture、M1真执行和M2扩展分开报告，不把局部通过计全部AC。

迁移读实际schema版本、drain并停止writer、备份DB与文件清单、隔离副本验证后启用。原消息顺序不可证明保留legacy，不补造批准/成功；旧未发布schema仍是设计，若实现端已有旧版本必须显式迁移。旧runner禁止写新队列；旧afterSeq与新cursor不混用。回退先停/对账，有新作用后向前修复，不回滚库清掉effect/receipt重跑。任何恢复不得恢复为有效旧lease/批准。

## 12. 验证与修订记录

r2按审查修正普通会话binding/NULL去重、根子fence、activeKey、Plan前置、宿主MCP正向审批、静止/投递分离、分阶段Finding与规则来源。补充回归由TEST-CR031维护；历史审查保留，闭环结论仅指文档。

本次未读取真实DB/凭据，未运行CLI、软件测试、迁移或视觉对照。未来以真实副作用计数、状态与资源锁、权限拒绝、持久恢复及成对UI证据证明实现；文档字段齐全或JSON可解析不能替代行为验收。
