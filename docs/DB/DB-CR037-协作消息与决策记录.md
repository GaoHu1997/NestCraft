# DB-CR037：协作消息与决策记录

- 关联：[CR-037 需求](../PRD/CR-037-主代理协调与答疑.md)、[协作契约](../LLD/LLD-CR037-主代理协作契约.md)、[测试](../Test/TEST-CR037-主代理协调与答疑.md)。
- 继承：[事件审批与产物记录](DB-CR031-事件审批与产物记录.md) 的 InvocationBinding 列与事务规则、[任务执行数据](DB-FEAT-019-任务执行数据设计.md) 的 artifact/evidence/attempt 权威、[CR028 存储分工](../PRD/CR-028-文件与数据库按职责存储.md)。
- 状态：设计首版，2026-11-19；新增表与迁移均未实施，本批不读写正式 `workbench.db`。逻辑 schemaVersion=1 为未发布草案。

## 1. 存储分工与权威

需求/AC/设计正文、完整报告与长日志继续用文件；协作消息正文若超过 8KiB 存受管文件，表内只留摘要与 URI/hash。SQLite 保存消息、决策、回执、返工链及其状态。

不新建第二套运行权威：消息不决定任务状态，任务状态仍由既有 `execution_task`/`execution_attempt` 与验证证据决定。消息只记录「谁在什么时候就什么问题说了什么、处理结果如何」。

所有表带 `projectId`，运行相关记录带完整 InvocationBinding 列（与 DB-CR031 §1.3 一致），用复合外键限定同项目。

## 2. 实体字段

| 表 | 主要字段与约束 |
| --- | --- |
| `execution_collab_message` | id PK、projectId、messageId（对外稳定键）、kind CHECK question/answer/escalation/decision/progress/candidate_done/review_result/rework、senderRole CHECK coordinator/worker/user/system、senderRef、invocationId/origin/attemptId/sessionTurnId/rootInvocationId/parentInvocationId/executionFence/invocationGeneration/parentGeneration、parentMessageId可空 FK、subject、bodyUri/bodyHash/bodyBytes、sourceRefsJson、affectedScopeJson、state CHECK pending/answered/escalated/decided/closed/archived、deadlineAt可空、createdAt/updatedAt；UNIQUE(projectId,messageId) |
| `execution_decision_gate` | id PK、projectId、gateKey、invocationId及Binding列、messageId FK、kind CHECK technical/business、state CHECK open/answered/escalated/resolved/timed_out/archived、responsibleRole、responsibleRef、openedAt、deadlineAt、resolvedAt可空、resolutionMessageId可空 FK、resolutionBasisJson（依据引用与修订）、createdAt/updatedAt；UNIQUE(projectId,gateKey)，同一分支同类型至多一个 open |
| `execution_collab_receipt` | id PK、projectId、messageId FK、consumerScope、consumerKind CHECK coordinator/worker/ui/history、noticeHash、receivedAt、appliedAt可空、handlingOutcome CHECK applied/duplicate/unprocessed/archivedOnly、handlingRevision、stopGeneration可空；UNIQUE(projectId,consumerScope,messageId) |
| `execution_collab_cursor` | id PK、projectId、consumerScope PK部分唯一、streamEpoch、lastSeq、authorizationRevision、protocolVersion、updatedAt；过期游标返回 CURSOR_EXPIRED |
| `execution_rework_link` | id PK、projectId、originMessageId FK（退回指令）、parentInvocationId、childInvocationId、childGeneration、fromArtifactRevisionId可空 FK、toArtifactRevisionId可空 FK、acRefsJson、scopeLimitJson、roundNo、maxRounds、budgetReservationId可空、state CHECK requested/admitted/running/submitted/accepted/exhausted/cancelled、createdAt/updatedAt；UNIQUE(projectId,parentInvocationId,childInvocationId,roundNo) |
| `execution_review_record` 既有表增量 | 不重建表；保留原人工评审／验收与 CR-031 stageQuality 字段，增加 `reviewKind=coordinatorTechnical` 子类型。该类型要求 origin=task、invocationId及完整Binding、artifactRevisionId FK、acManifestHash、designHash、consumedBaseline（适用集成时非空）、conclusion CHECK pass/rework/pending_human/blocked、reviewerRef、basisJson、evidenceRefsJson、decidedAt、validity CHECK current/invalidated、invalidatedReason可空、revision、createdAt。candidateArtifactRevisionId仅为旧接口名称，映射同一artifactRevisionId，不新增第二产物列 |

约束要点（CR-041 文档修订，未迁移）：

- 所有可变协作记录（message／gate／receipt／cursor／rework／review）显式具有非空 `revision`，初值1、成功更新递增；命令携带 `expectedRevision`。receipt.handlingRevision 只表示处理版本，不能替代记录CAS修订。
- 审查字段按 reviewKind 条件校验：coordinatorTechnical 必须有同项目／同 Task 的候选产物与审查依据；stageQuality 的 designGate 继续允许无产物且必须有真实需求设计快照；人工验收仍要求有效产物、workflowRevision、decision/reason、actorAuthorizationRef与当前证据。不得因协调者技术通过生成业务验收。详见 [DB-CR031 §8.1](DB-CR031-事件审批与产物记录.md#81-stagereviewfinding)。
- message 增加 `createdProjectSeq`（引用同事务登记的消息创建事件）；cursor.lastSeq 表示既有项目事件高水位，不用时间戳猜顺序。补读从事件流重放消息与状态变化，过滤后的空页仍返回扫描高水位，权限／epoch／裁剪规则继承 CR-031。
- rework 增加 `sourceInvocationId`（被退回调用）及 `reworkScope CHECK(root,child)`；childInvocationId 是旧名称，表示准入后的替代调用。requested阶段替代调用可空，admitted起必须非空。child级要求同项目、同根／原Attempt／根fence；root级要求同项目同Task，但使用新Attempt／新rootInvocationId，sourceInvocationId追溯旧根，不套同根约束。parentInvocationId按原Binding定义为直接调用父，根级为空，不混作退回者身份；退回者由originMessageId定位。`UNIQUE(projectId,originMessageId)` 保证原退回指令幂等；子级返工不得修改根fence。

- 消息的 `state` 与决策关口 `state` 分开：一条消息可以是 `answered` 但关口仍 `open`（例如答复被判定无依据）。
- `execution_review_record.conclusion=pass` 不能单独放行依赖；必须同时满足既有证据门槛（DB-FEAT-019 的 artifact validity、evidence outcome、integration 结果）。
- 返工链与既有 `execution_attempt`/`execution_artifact_revision` 关联，不复制产物正文。
- 依据 JSON 只存引用（文件路径 + hash + 修订），不内嵌整份文档。
- 时间 UTC epoch ms；hash 为 `sha256:<64hex>`；JSON 需 `json_valid` 与结构版本检查。

## 3. 事务与幂等

- 消息登记与对应事件写入同一事务；跨媒体（文件正文 + 行记录）用先写文件后登记、失败可对账的顺序，不做跨介质原子承诺。
- 消费回执与投影更新同事务提交，提交后才允许 ACK；重投同 `noticeHash` 幂等。
- 关口创建与消息关联同事务，避免出现有消息无关口或有关口无来源。
- 返工准入在短 `BEGIN IMMEDIATE` 内校验轮次、预算预留与旧进程停止确认；任一不满足整体回滚。
- 状态更新按实体采用条件更新（有state时比较 `projectId/id/state/revision`，无state时比较 `projectId/id/revision`），影响行数为0视为过期，不覆盖。
- 有效答复、关口关闭、关联消息状态、处理回执和续行登记在同一短事务中校验绑定与 expectedRevision 并递增修订；超时／取消使用同一CAS门槛。超时／取消先胜出后，迟到答复只能归档，不关闭过期关口、不创建续行。技术答复不能关闭业务关口，用户决定仍校验真实授权主体。

## 4. 查询与索引

- 按分支查未关闭问题：`execution_decision_gate(projectId, state, deadlineAt)`。
- 按消费者补读：复用 `execution_event(projectId,projectSeq)` 与 cursor.lastSeq；消息定位用 `execution_collab_message(projectId,createdProjectSeq)`。
- 按候选修订查审查历史：`execution_review_record(projectId,artifactRevisionId,validity)`，按 reviewKind 区分审查与验收。
- 按父调用查返工链：`execution_rework_link(projectId, parentInvocationId, roundNo)`。

## 5. 保留、裁剪与迁移

- 已关闭问题与决策保留用于追溯；裁剪只归档正文到受管文件，不删除记录与回执防重键。
- 迁移顺序：先建表与索引，再启用写入路径，最后开放界面读取；回退时停止写入、保留数据，不删已有记录。
- 本轮无迁移脚本、无真实表变更。
