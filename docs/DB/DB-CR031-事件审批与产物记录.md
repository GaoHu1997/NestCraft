# DB-CR031：事件审批与产物记录

- 关联：[CR-031需求/WP](../PRD/CR-031-受管执行可靠性需求与实施分解.md)、[LLD-CR031 r2](../LLD/LLD-CR031-受管执行可靠性契约.md)、[TEST-CR031](../Test/TEST-CR031-受管执行可靠性验证.md)、[审查闭环](../Test/REPORT-CR031-需求设计审查.md)。
- 继承：[DB-FEAT-019](DB-FEAT-019-任务执行数据设计.md)、[DB-FEAT-001](DB-FEAT-001-知识授权与工作台数据设计.md)、[CR026计划](../LLD/LLD-CR026-有效执行计划与能力编译.md)、[CR028存储分工](../PRD/CR-028-文件与数据库按职责存储.md)。
- 文档r2，2026-11-19，按审查修正；只设计，未读写正式workbench.db、未写迁移源码、未运行测试/迁移/业务。逻辑schemaVersion=1未发布草稿；物理user_version实施时读取实际迁移登记后分配。已有源数据/历史验收不覆盖。

## 1. 权威与明确的数据模型

### 1.1 存储分工

需求/AC/设计和完整报告、日志、ResultEnvelope、Finding正文用文件；同一SQLite保存授权、不可变Plan、运行状态、有限清单、URI/hash及可重建投影。现session/message保留，交错历史依据新事件；旧消息无法证明顺序标legacyApproximate。不要创建第二任务Run表、配置库存、权限账本或可编辑需求正文。

原Task/Step/Attempt、依赖/锁/槽、effect/budget、artifact/evidence/integration/report/document_outbox继续权威。普通会话不能为使用这些机制而伪造Story/Task/Attempt；其技术运行由sessionTurn和根Invocation定位。所有引用限定项目；服务器/全局会话未有project的，不伪加项目权限，本批不扩其协议。

### 1.2 两个来源及根/子关系

`execution_session_turn`：id/projectId/sessionId、requestId/requestDigest/actorRef/operation、ordinal、sourceTurnId可空、planId/revision/hash、turnRevision、invocationFence、ownerId/leaseUntil、stopGeneration/autoResumeSuppressed、activityRevision、executionSettled BOOL、resultWaiting BOOL、resultReceiveDeadlineAt可空、promptEndedAt/executionSettledAt、partialResultStatus、createdAt。UNIQUE(projectId,sessionId,ordinal)、UNIQUE(projectId,actorRef,operation,requestId)；session FK复核实际project，sourceTurn同session。它是一次受权输入记录，没有业务Task状态/DAG/验收；重试新turn而不清旧账。

`execution_invocation`：id/projectId、origin CHECK task/sessionTurn、attemptId可空、sessionTurnId可空、rootInvocationId、parentInvocationId可空、parentGeneration可空、executionFence、invocationGeneration、sourceInvocationId可空、planId/revision/hash、agentId可空、state CHECK admitted/running/waiting/settled/failed/cancelled/interrupted/blocked、activityRevision、executionSettled BOOL、resultWaiting BOOL、resultReceiveDeadlineAt可空、stopGeneration/autoResumeSuppressed、createdAt/endedAt。

- CHECK origin=task时attempt非空/sessionTurn空；sessionTurn时反之；origin两支都要求非空根ID、fence/generation正整数。根：root=id且parent/parentGeneration为空；子：parent/parentGeneration非空、root!=id。
- **只有根**对(projectId,attemptId)或(projectId,sessionTurnId)建立`WHERE parentInvocationId IS NULL AND origin=...`部分唯一。子调用允许共享父Attempt/sessionTurn，不给子新建Attempt，不递增Task fence。
- 根task binding经attempt→task/step复合FK检验；session根绑定turn。每个Invocation具有UNIQUE(id,projectId)、UNIQUE(id,projectId,rootInvocationId)，父/root同project且同origin/attempt/turn/fence由插入事务验证，检环。rootPlan固定，子Plan只缩权并沿父预算；root id不可变。
- generation是当前调用的控制代次；事件/审批等保存发出时generation快照。身份FK只指稳定id/project，**不可让历史记录FK指向随停止变化的当前generation**。执行入口/CAS比较根fence、调用及逐级祖先当前generation/停止状态，旧事件可auditOnly，不能更新作用、gate或新锁。
- 子重试先停其树，创建新invocation及新sourceInvocationId，不修改根Task.currentAttemptId/fencingToken；根重试按原新Attempt/sessionTurn流程，全树旧binding失效。

### 1.3 Binding列与约束：具体表必须声明

LLD使用嵌套InvocationBinding；DB列为`projectId,invocationId,origin,attemptId,sessionTurnId,rootInvocationId,parentInvocationId,executionFence,invocationGeneration,parentGeneration`。下文各运行表显式列出，不能用“默认task必填，某段覆盖”的约定代替实际schema。

当前实体记录这些列与Invocation身份关系一致；历史事件/审批快照容许旧fence/generation，但仅能归档。所有运行表UNIQUE(id,projectId,invocationId)，同调用agent/job/toolCall等引用用复合FK绑定项目和invocation。nullable attempt只作来源字段，所有去重核心键用非空invocationId，禁止`UNIQUE(nullableAttempt,...)`假防重。非运行project事件/被拒请求可executionClass=project并全部binding列为空，CHECK不允许半个binding。

普通会话效果、预算沿原execution_effect/budget_ledger扩展origin+binding，原task/step/batch引用可空并受origin CHECK；业务artifact/evidence/integration/report仍task专属。普通会话使用受管文件/附件登记（resourceId/revision/hash）和result_manifest，不借result_item插假业务artifact。

## 2. 通用类型、权限和事务约束

ID TEXT，时间UTC ms INTEGER，revision/seq计数非负，fence/generation正整数，BOOL CHECK0/1；线格式限制JS安全整数。hash=sha256前缀与64hex，hashRuleVersion单列；unknown计量为NULL+status。JSON需json_valid/schema检查、UTF-8字节上限：event payload8KiB，summary4KiB，有限清单按LLD上限。大正文不能藏进summaryJson。

每表UNIQUE(id,projectId)，当前Task关联也有适当复合候选键。历史关联RESTRICT/归档，不级联删已发生作用或审批；源文档不存在不删除执行证据。授权与根/子scope交集需受管服务检查，FK只约束结构不证明OS隔离。

SQLite WAL、foreign_keys=ON、有限busy timeout。短BEGIN IMMEDIATE包状态竞争/CAS；不在写事务等待人、CLI、网络、计算大文件hash或写大文件。作用前条件复检在可信入口与OS/网关执行，不能把SQL原子性说成文件/网络原子性。

## 3. 请求、事件、快照和顺序

| 表 | 明确字段/关键约束 |
| --- | --- |
| execution_event扩展原表 | 原seq全局PK、eventId UNIQUE、projectId、projectSeq、streamEpoch、eventClass=invocation/project、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration（project事件全空）、commandReceiptId可空、agentId/jobId/processId可空、eventType、sourceEventKey、sourceAdapterId/sourceEpoch/sourceSeq可空、nativeTimestamp可空、planId/revision/hash可空、disposition、payloadJson/payloadUri/hash、payloadBytes、createdAt；UNIQUE(projectId,projectSeq)、UNIQUE(projectId,sourceEventKey) |
| execution_event_stream | projectId PK/FK、streamEpoch、nextProjectSeq、retentionFloor、checkpointId可空、revision |
| execution_event_checkpoint | id/projectId、streamEpoch、throughProjectSeq、stateHash、snapshotUri/hash、summaryJson、createdAt、fileState |
| execution_command_receipt | id/projectId、actorRef/operation/requestId/requestDigest、executionClass、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration（未接纳/非运行可全空）、status accepted/rejected、admittedAt可空、completionEventId可空、errorCode、responseSummaryJson、createdAt；UNIQUE(projectId,actorRef,operation,requestId) |

运行source去重：adapterId+sourceEpoch+invocationId+generation+sourceFrameId（同toolCall可有请求/结果多个帧，不能只用toolCallId）。同键不同payloadHash拒绝；同键同内容不重投影/计量。projectSeq在同一写事务按项目分配，rollback不推进；原global seq跨项目跳号正常，线格式journalSeq=旧seq、新seq=projectSeq。

accepted receipt+event与根/子绑定原子登记；每promptEnded以(projectId,commandReceiptId,eventType)部分唯一且receipt非空。ExecutionEvent携带activityRevision（静止事件必须），`invocation.executionSettled`按invocation/generation/activityRevision唯一，`session.settled`为project事件按sessionId/activityRevision唯一。session聚合由受管事务重查该会话全部根，不允许旧活动修订覆盖新工作。

快照同一一致性读返回投影/high-water/floor/epoch/授权修订和未ACK投递数；查询page推进到最后完整事件。cursor过期/裁剪/epoch改变明确CURSOR_EXPIRED；v1只对有整项目权限的受管UI开放连续流，session/agent/job显示过滤在客户端，模型或子代理不获全项目流。局部权限流不在v1伪造空payload/跳号补连续。

裁剪前封存检查点；可归档token流但不得由快照重建授权、effect和成功历史。细粒度事件号不重用，旧afterSeq仍全局含义。完整长历史走文件分页。

## 4. Agent、Job、Process与子资源

| 表 | 明确字段/关系 |
| --- | --- |
| execution_session_binding | id/projectId、sessionId、rootInvocationId、rootAgentId可空、scopeKind、sourceSessionRevision、createdAt/archivedAt；UNIQUE(projectId,sessionId,rootInvocationId)，非空定位避免NULL唯一漏洞 |
| execution_agent | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、sessionBindingId可空、parentAgentId可空、rootAgentId、templateRef/revision、planId/revision/hash、parentPlanRef可空、effectiveGrantHash、budgetRootRef、state、activityRevision、stopGeneration/autoResumeSuppressed、createdAt/endedAt |
| execution_job | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId、ownerType/ownerId、kind cliChild/toolBackground/capture/review、state queued/running/stopping/succeeded/failed/cancelled/interrupted/blocked、revision/stopPending/stopGeneration、resultManifestId可空、createdAt/startedAt/endedAt/errorCode |
| execution_process | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、jobId可空、agentId、pid/startIdentity/runnerEpoch/processTreeId/supervisorId/launchSpecHash、ownerId、state starting/running/stopping/stopped/unknown、stopRequestedAt/stopConfirmedAt、identityEvidenceRef、createdAt/endedAt |
| execution_child_resource_claim | id/projectId、rootInvocationId、invocationId、invocationGeneration、parentResourceLockId（普通会话为其受管根资源锁）、normalizedScopeKey/mode、state held/releasing/released、createdAt/releasedAt；领取同事务检查祖先/兄弟范围冲突；只能是根锁覆盖子集 |
| execution_attempt增量 | planRef/hash、capabilityManifestHash、rootInvocationId、commandReceiptId、activityRevision、executionSettled、resultWaiting/deadlineAt、stopGeneration/autoResumeSuppressed、nativeContextRef、lastCommittedProjectSeq、partialResultStatus；process旧字段只读兼容投影，不双写 |

同一Task仅根Attempt领取递增taskFence，兄弟child invocation共享根attempt但不同generation/Job。子resourceClaim释放不能删除parentResourceLock或Task.activeKey；父写同子占用范围须等待或按计划串行；不具备实际隔离证据时不启动并行写。普通会话也要根资源互斥；将原resource_lock的owner来源扩成taskAttempt/sessionTurn互斥引用与根invocation，不新增第二锁服务。

父/根Agent链同项目无环，父计划缩权在创建子Plan时验证；预算在原ledger原子预留至rootBudgetRef，不复制独立总额。多个并行子调用不改变根当前Attempt指针。

Process唯一(supervisorId,runnerEpoch,pid,startIdentity)，回调比binding，PID不单独作身份。stopConfirmed需监督器证明无writer；进程已spawn但登记失败立即停止并保留恢复intent。Job无Process可为内部消费/存储，不虚构PID。

### 4.1 activeKey与资源锁释放矩阵

沿DB-FEAT019约束：paused/retry_wait/可恢复blocked、可继续人工pause都activeKeyHeld=1；stopPending/recovering也=1。资源锁/槽只有对应树停止且checkpoint/effect安全后按策略可释放。业务activeKey仅在succeeded/failed/cancelled不可恢复终态或明确finalBlocked，且整树停止、资源清理和不可resume都成立才0。停止请求必须带pause/cancel意图，不能以autoResumeSuppressed自动清activeKey。

活动唯一键(projectId,storyId,baselineHash WHERE activeKeyHeld=1)继续防暂停后重派。普通会话不持业务activeKey，运行冲突由根资源锁/会话串行约束保护。根重试新Attempt/fence，子重试新Invocation/sourceInvocationId，根锁不被子释放。

## 5. 完成投递与内部子结果消费

| 表 | 字段/约束 |
| --- | --- |
| execution_completion_outbox | id=completionId/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、ownerType/ownerId、jobId可空、terminalEventId/terminalProjectSeq、outcome、resultManifestId可空、stopGeneration、noticeHash、requiredConsumerSetHash、state pending/delivering/acked/paused、retryCount/nextDeliveryAt/lastErrorCode、createdAt/updatedAt；UNIQUE(projectId,ownerType,ownerId,terminalEventId) |
| execution_completion_consumer | id/projectId、consumerKind ui/history/internalParent、ownerType/ownerId、consumerScope、actorBindingRef、enabled、revision、createdAt/archivedAt；UNIQUE(projectId,ownerType,ownerId,consumerScope) |
| execution_completion_requirement | completionId/projectId、consumerId、consumerSetRevision、state required/revoked、createdAt；PK(completionId,consumerId)，首次投递冻结集合，不只存一个不可还原hash |
| execution_completion_inbox_receipt | id/projectId、completionId/consumerId、noticeHash、receivedAt/appliedAt/ackRecordedAt、handlingOutcome applied/archivedOnly/duplicate、projectionRevision、stopGeneration；UNIQUE(projectId,completionId,consumerId) |
| execution_child_result_receipt | id/projectId、parentInvocationId/parentGeneration、childInvocationId/childGeneration、resultManifestId、terminalEventId、state queued/processing/accepted/blocked/archivedOnly、isRequired BOOL、deadlineAt、retryCount、errorCode、createdAt/acceptedAt；UNIQUE(projectId,parentInvocationId,childInvocationId,childGeneration,terminalEventId)，同根关系事务验证 |

terminal state/event、outbox与必要内部child result enqueue原子提交。外部消费者receipt与其投影更新同事务，之后ACK；相同hash重放幂等，不重复提醒/计量，不改业务gate或用户已读。UI不持久事务时由runner inbox代登记，不能在收到内存消息时提前ACK。

**执行静止与投递分离**：executionSettled在无活动进程/排队执行/安排续行/待审/正在消费内部结果时成立；有blocked结果等待但无可执行工作可静止并显示resultWaiting。deliveryPending由外部outbox未ACK派生，不阻止executionSettled/sessionSettled。没有UI消费者时pending保留，后打开读快照不会重跑命令。

内部Parent consumer由runner稳定创建，不依赖UI在线。其receipt在完成子manifest检查和父待续行登记的同一事务accepted；若父manualStop/旧binding，只archivedOnly不排队续行。暂时失败按原预算退避；到冻结Plan.resultReceiveDeadlineMs则blocked/RESULT_DELIVERY_BLOCKED，父不能技术成功；显式安全重检可再消费同结果，不重新执行子工作。外部通知pending本身不造成父gate阻塞。

required消费者集合变化不隐式重新唤醒业务；撤销者记录revoked并留审计，不能悄删receipt防重记录。审批/作用/业务验收不以ACK代替。

## 6. 最终参数、审批与effect

| 表/增量 | 明确字段/约束 |
| --- | --- |
| execution_tool_call | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId、toolId/schemaHash、planId/revision/hash、authorizationRevision/ruleManifestHash、operationId/semanticInputDigest、retryOfToolCallId/supersedesCallId可空、sourceCallKey、finalCallUri/hash、finalArgsHash/hashRuleVersion/bindingHash/targetManifestHash、state prepared/pendingApproval/running/ended/cancelled/blocked、revision、createdAt/endedAt；UNIQUE(projectId,invocationId,invocationGeneration,sourceCallKey)，operation FK/guard与重试条件见下文 |
| execution_tool_approval | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId/toolCallId、approvalOrdinal、supersedesId可空、planId/revision/hash、authorizationRevision/ruleManifestHash、finalArgsHash/hashRuleVersion/bindingHash/scopeFingerprint、stopGeneration、state pending/approved/denied/expired/cancelled/superseded、revision/expiresAt、decisionActorRef/authorizationRef/requestId/digest、decidedAt/consumedAt/executeEffectKey可空、createdAt/updatedAt；UNIQUE(projectId,toolCallId,approvalOrdinal) |
| 原execution_effect增量 | 保留effectKey/inputDigest/state intent/applied/confirmed/unknown；加入invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、operationId/semanticInputDigest、retryOfEffectId可空、reconciliationOutcome=unreconciled/confirmedNotApplied/confirmedApplied/unknown、reconciliationEvidenceUri/hash可空、toolCallId/approvalId可空、finalArgsHash/authorizationRevision/resultEventId；任务来源原task引用非空，会话来源为空；UNIQUE(projectId,effectKey)，同operation guard/FK见下文 |

同toolCall最多一条pending或approved且未消费的活动审批（部分唯一）；已消费审批不能清空consumedAt。过期重审可为同一不可变toolCall建立更大ordinal并引用supersedesId，但每个toolCall最多一个effect intent，`UNIQUE(projectId,toolCallId)`作用键映射；已执行/已消费作用不能通过新approvalOrdinal重复执行。参数/Plan/binding变化须新toolCall/sourceCallKey并记录supersedesCallId，原调用terminal，不能更新hash保批准。

原effect ledger增量：`operationId NOT NULL,semanticInputDigest,retryOfEffectId可空,reconciliationOutcome CHECK unreconciled/confirmedNotApplied/confirmedApplied/unknown,reconciliationEvidenceUri/hash可空`；tool_call另含operationId/semanticInputDigest/retryOfToolCallId可空。effect.state仍原intent/applied/confirmed/unknown，confirmed须有对账结论与证据：confirmedNotApplied为已证未应用（不计成功），confirmedApplied为已证已应用；不能因intent/ACK而推定未应用。

同effect ledger内部的`execution_operation_guard`仅协调执行领取：projectId/operationId组合PK、semanticInputDigest、activeEffectId可空、revision、state ready/inFlight/applied/unknown、updatedAt；它不是第二成功/费用账本，作用结果仍原effect与证据权威。所有effect.operationId FK绑定guard且语义摘要相同；通过同一BEGIN事务CAS只有一个activeEffect，不能按新toolCall/approval ID绕过。已消费后作用前失败只保留旧effect，监督器确认旧writer停止并对账confirmedNotApplied后，可新建retryOfToolCallId/retryOfEffectId关联的新call、新批准、新effect，沿**同operationId/semanticInputDigest**及原预算；领取guard前检查全部前序effect均confirmedNotApplied。guard applied时返回已应用的原结果，不再执行；unknown或旧writer未停则blocked，不置ready。仅有证据的confirmedNotApplied解除旧inFlight供新尝试，旧批准不清消费。改变语义参数需新operationId与授权确认，不能说成原操作重试。

effect的retryOf关系同project/operation、严格单向且无环；查询索引effect(projectId,operationId,createdAt)，guard可从原effect/对账重建，但重建不能把未知设ready。恢复必须把guard activeEffect与ledger共同对账，receipt或UI通知均不能释放该guard。

pending没有decidedAt/actor；approved/denied需真实主体/授权记录；其它自动终态需reason/event。consumedAt非空要求state=approved且effectKey非空；未消费effectKey为空；expiresAt>createdAt。FinalCall绑定完整InvocationBinding及规则hash，JCS算法见LLD §6。原始参数文件限有权主体读取，事件只有脱敏摘要。

消费流程：事务外校验不可变FinalCall文件及可信hash → 短事务读同项目/调用的Plan/根lease/fence、当前与祖先代次、授权、期限 → 比对摘要和DB修订 → CAS已批未消费+唯一effect intent+事件 → 事务后作用前再次TOCTOU/权限检查。冲突0行拒绝；已effect查原结果，不重跑。作用前失败不清批准消费；副作用是否发生按effect对账，不靠ACK或批准状态判断。

原Plan允许的无人工审批调用也写policyDecision来源/授权修订并按相同effect去重执行，不伪造人类批准。M1正向路径使用实际人工批准，不能拿这一无审批分支替代。无审批传输、平台旁路未知时拒绝组合；撤权取消未消费批准、阻断新调用并停止受影响writer，未确认前锁保持。

## 7. 结果、捕获与文件封存

| 表/增量 | 明确字段/约束 |
| --- | --- |
| execution_result_manifest | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId、planId/revision/hash、baseRevision可空、schemaVersion、envelopeUri/hash/bytes、summary、claimedStatus candidate/failed/cancelled/interrupted/blocked、structureStatus pending/valid/rejected、referenceStatus pending/valid/invalid、validity candidate/verified/invalidated、validationErrorCode/detailsUri/hash、repairCause/round、manifestHash、createdAt/sealedAt/fileState；UNIQUE(projectId,invocationId,invocationGeneration,manifestHash) |
| execution_result_item | resultId/projectId/invocationId、ordinal、kind artifactRevision/managedFile/evidence/finding/capture/unresolved、referencedId/revision可空、code/summary可空；UNIQUE(resultId,kind,ordinal)，同调用关系FK与按kind验证 |
| execution_capture | id/projectId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId/jobId可空、stream stdout/stderr/tool/result、sourceRef/captureOrdinal、state recording/sealing/sealed/failed、integrity complete/truncated/captureFailed/unknown、sourceCoverage live/legacy、uri/hash可空、capturedBytes/sourceBytesKnown/elidedBytes、maxBytes/headBytes/tailBytes、lastCommittedProjectSeq、redactionPolicyHash/captureErrorCode、fileState pending/available/partial/missing/corrupt、createdAt/endedAt；UNIQUE(projectId,invocationId,invocationGeneration,stream,sourceRef,captureOrdinal)，sourceRef非空 |
| execution_file_commit | id/projectId、kind capture/result/finding/report/checkpoint、ownerObjectId/revision、intentHash、temporaryUri/finalUri、expectedHash/bytes和actualHash/bytes可空、state pending/fileSealed/registered/conflict/failed、errorCode、createdAt/updatedAt；UNIQUE(projectId,kind,ownerObjectId,revision) |
| artifact_revision/evidence原表增量 | resultManifestId/sourceInvocationId、captureId可空、fileState、captureIntegrity；task/attempt归属沿根，候选子产物附来源，不直接变verified |
| delivery_report增量 | reportUri/hash/bytes/fileState、result/capture/reviewManifestHash、summarySchemaVersion/reportSummaryJson、sealedAt；原batch/reportRevision与验收状态不改 |

manifest schema/ref有效只证明结构与定位；任务verified继续verifier/AC/集成门槛；普通sessionTurn的verified表示受管结果核验，不设置Story或业务gate，必须有resultClass=sessionResult/taskDelivery区分显示。子候选结果交父聚合，不能直接完成Task。停止/旧代次可保存manifest为历史invalidated，不能current。

outputs的artifactRevision只允许task origin并核对artifact归属；managedFile引用已有受管文件/附件实体的稳定resourceId，不允许任意URI。sessionTurn不能引用业务evidence/Finding；必要检查可放capture/普通结果诊断，任务显式派发后另建真实业务证据，不从聊天成功推导。

Capture complete需EOF/flush-close-readback与hash完整，truncated明确head/tail/省略范围，captureFailed带错误且partial文件不标全量，unknown/legacy不推complete。capturedBytes≤maxBytes，head+tail≤maxBytes，未知elidedBytes=NULL。8KiB事件只存引用和短片段，64KiB显示从文件分页并守帧限。

文件封存为intent→临时写→校验→不覆盖发布→DB引用/摘要/event事务。文件已封DB未登记补记，不重跑CLI；DB有引用但坏/缺文件使证据/报告失效，保留历史；孤儿隔离核查不擅删。reportSummary与正文同revision，document_outbox仍原CAS，不由completion ACK写验收。

## 8. 分阶段审查对象与规则数据

### 8.1 StageReview/Finding

原execution_review_record新增reviewKind=stageQuality；此子类型明确扩展subjectKind/requirementSnapshotId/artifactRevisionId/consumedBaseline可空、stage=designGate/artifactDelivery/integratedReview、phasePlanRef可空、reviewerRef（human/builtin/agent）、state、validationPlanHash、evidenceManifestHash及resultManifestId可空。**仅stageQuality的designGate允许原artifactRevision为空**，原人工验收类型继续需有效产物，不能全表一放空绕验收。

`execution_review_finding`：id/projectId/taskId/reviewRecordId、stage、subjectKind、requirementSnapshotId可空、artifactRevisionId可空、acHash/designHash/validationPlanHash、consumedBaseline可空、reviewerRef、severity P0..P3、confidence、code/title/bodyUri/hash、locationManifestJson、state open/acknowledged/resolved/invalidated、resolvedEvidenceRef可空/invalidatedReason、createdAt/updatedAt。

- designGate要求subjectKind=requirementDesignSnapshot、snapshot非空、artifact与consumedBaseline空；用`FK(taskId,projectId,requirementSnapshotId)→execution_task(id,projectId,snapshotId)`（新增对应UNIQUE）验证Task真实快照，再由snapshot FK定位原需求表；不假设snapshot表已有taskId。
- artifactDelivery/integratedReview要求subjectKind=artifactRevision、artifact非空、requirementSnapshotId空；通过artifact_revision→artifact→task关系验证同project/task；integratedReview consumedBaseline非空且指真实候选/验证基线。
- review与finding相同stage/subject引用；FK及条件CHECK实现恰一来源。`execution_finding_evidence`复合关联同project/task证据。设计阶段允许无执行证据但必须有设计快照来源，不以空Finding或空证据自动验收。

修改subject/hash使旧Finding invalidated，新证据与受权复核才能resolved。只读reviewer不能授予写权限、工具审批或用户验收。没有模型评审配置用冻结的human/builtin方式，不暗自新增模型费用。

### 8.2 规则清单与触发

`execution_rule_source`：id/projectId、sourceType=hostBaseline/projectAgents/selectedSkill、canonicalLocator、scopeRoot、sourceRevision/contentHash、trustAuthorizationRef、exists/readStatus、discoveredAt、scanRevision；规则正文仍原受权文件，索引不授予权限。

`execution_rule_binding`：id/projectId、planId/revision/hash、ruleId/sourceId/sourceRevision/contentHash、sourceTrust、layer baseline/onDemand/gate、applicabilityManifestHash（含规范目录/阶段/读写scope）、enforcement、loadedRangeRef、manifestHash、createdAt/invalidatedAt/reason；UNIQUE(projectId,planId,planRevision,ruleId,contentHash)。

`execution_rule_trigger`：id/projectId、bindingId、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、agentId/toolCallId可空、sourceEventId/triggerKey、action remind/block/repair、matchSummary/uri/hash、repairCause/round、rootBudgetRef、outcome recorded/blocked/repairing/repaired/failed/suppressed、errorCode/time；UNIQUE(projectId,bindingId,invocationId,invocationGeneration,triggerKey)。

RuleResolver首版源与目录匹配以LLD §9唯一定义：受信宿主、授权根及范围内AGENTS、已选Skill；不借CR027设计工具读取规则。新建/删除/移动/修改均触发scope相交Plan失效，独立兄弟目录不变；必须源不可读/未接入block，不当空规则。baseline和授权不能被子目录放宽。自然语言冲突需受控修订，不能自动选有利版本。

repairCause分别schema/implementation/rule，共用根预算和总repair计数，子新Invocation或重试不清零；重复触发不另开循环，停后仅suppressed。原budget_ledger扩展非空rootBudgetRef、invocation绑定和reservationId，唯一键改(projectId,invocationId,invocationGeneration,reservationId,state)且root层原子预留，避免session空Attempt去重失效。

## 9. 事务、兼容、迁移与恢复

| 事务 | 原子事实 | 事务外动作/禁止 |
| --- | --- | --- |
| 接纳 | receipt、冻结Plan、invocation/活动修订、accepted事件 | 握手/文件准备/启动复检 |
| event | source去重、projectSeq、event、必要状态CAS | 广播，重复容许 |
| 子调用派发 | parent/root/Plan缩权、预算预留、child invocation/claim/Job | 创建隔离工作区；不新建同Task Attempt |
| 终结 | 运行终结、部分结果/manifest、terminal event、outbox及内部结果enqueue | 不因通知重试重新执行 |
| 审批消费 | 真实授权/最终参数摘要/代次/期限CAS、effect intent、事件 | TOCTOU和实际文件/网络作用 |
| 停止 | 调用代次、autoResumeSuppressed、stopPending、待审取消、事件 | 整树停止；确认后资源释放，activeKey依§4.1另判 |
| 内部结果 | receipt、父待续行登记或blocked/archivedOnly、状态事件 | 模型续行要原授权有效且未停止；UI投递无关 |
| 文件登记 | 已封存URI/hash、file_commit、owner摘要/event | 真实写入/flush/hash/rename不持DB写事务 |

首版真实迁移前必须完成CR026 Plan唯一存储与授权来源；M0允许fixture，不能假称G-PLAN已通过。停止领取/整树确认后使用SQLite backup API或checkpoint关闭连接一致备份，文件清单同版，秘密另受权处理。读真实schema分配版本，在副本新增字段/约束/FK/索引，旧消息/配置不覆盖；历史projectSeq只表示保存顺序，不伪交错；未知能力unverified、usage NULL、旧批准不自动approved、历史终结不创建会唤醒的通知。

旧Invocation一对一字段若尚未实现不迁移；若实施时已有旧schema，显式回填根、确认不存在假子Attempt才能迁移，无法解释的旧子身份标unknown/blocked，不能静默归新父。历史fence/generation保留快照，不随新current值回填伪造有效。

副本验证FK/integrity、根部分唯一、NULL来源负例、子并行不踩根fence、普通会话effect预算、activeKey、审批争抢、文件封存窗口、UI离线/内部消费失败、规则scope传播。通过后新runner握手并先恢复对账再领取；旧写端不能忽略新安全字段继续写。

有新外部作用后优先禁新入口/向前修复，不通过还原旧库抹effect/receipt。回退先drain确认所有writer，只有无新作用且DB+文件清单一致才可整体恢复。恢复不恢复有效旧lease/可消费批准。未知作用、旧writer未确认、坏文件继续blocked，保留历史与人工处理入口。

## 10. 索引、授权和验证边界

建议查询索引：event(projectId,projectSeq)、receipt(projectId,operation,requestId)、invocation(projectId,rootInvocationId,state)、job(invocationId,state)、process(rootInvocationId,state)、child_claim(rootInvocationId,state,normalizedScopeKey)、outbox(projectId,state,nextDeliveryAt)、child_receipt(parentInvocationId,state,deadlineAt)、approval(invocationId,state,expiresAt)、result(invocationId,invocationGeneration,manifestHash)、capture(invocationId,stream,createdAt)、file_commit(state,updatedAt)、rule_source(projectId,scopeRoot)、finding(taskId,stage,state)。

每次资源读取/事件/审批/capture缓存复用均授权复检，路径和URI非凭证，NOT_FOUND_OR_DENIED不泄漏存在。所有普通会话/子调用必须在实际列、索引、FK和服务端校验一起实现，不能以注释补nullable来源漏洞。

本次仅r2文档修订，未执行schema/行为/OS安全/迁移或软件视觉测试；正式能力保持设计中。文档闭环不等于实现验收。
