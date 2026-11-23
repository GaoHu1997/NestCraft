# DB-CR032：同步基线与语义追踪

- 关联：[CR-032](../PRD/CR-032-需求设计与代码双向变更及高保真逆向.md)、[LLD](../LLD/LLD-CR032-双向变更与高保真逆向.md)、STORY-017/018/019。
- 状态：仅逻辑数据设计，未建表／迁移／读取真实库。2026-11-19 18:26用户确认恢复端只有产品源码；**不持久化恢复语义包或全文归档，不从历史DB／索引提供恢复输入**。文件名“语义追踪”指正常同步与本次输出的事实引用，不是提前留存原始需求辅助恢复。**2026-11-23 已实施 M0 子集**：`sync_baseline`、`sync_batch`、`sync_target_journal` 三表与基线／批次／对账／条件写回命令（见 `src-tauri/src/commands/sync.rs` 与 [验证记录](../Test/REPORT-CR032-双向同步M0验证.md)）；事实抽取、逆向管线与三方合并仍未实现。

## 1. 正常持久化与重建模式隔离

| 对象 | 正常系统职责 | 删除文档重建时 |
| --- | --- | --- |
| 现行需求／PRD／LLD文件 | 业务正文权威 | 禁止读；只有评价端保留独立评价副本 |
| [DB-CR027模型版本](DB-CR027-设计资料索引与模型记录.md) | 结构化模型单权威，导出MD走受控导入 | 禁止读，不从旧模型辅助源码还原 |
| 当前产品源码 | 实现事实manifest，含允许的dirty源码 | 唯一业务输入；不复制测试／独立schema／配置 |
| 共同基线／审批／journal | 正常同步、冲突与恢复执行的结构化状态 | 历史记录禁止生成身份读取 |
| 本轮新事实图／输出映射 | 从唯一源码输入派生的证据与输出索引 | 可以新建，不能偷偷读上轮历史映射 |
| 质量报告／评价基准 | 证据文件与元数据引用，评价身份隔离 | 报告不反向喂生成端；评价原文不是恢复输入 |

同一应用SQLite可存正常状态，但纯源码重建使用空临时任务上下文，不获得旧库／缓存权限。不在JSON、注释、字符串或摘要隐藏原PRD／LLD。此前B/C恢复资源表／语义包／归档扩展建议从本次设计删除。

## 2. 拟议逻辑记录

### sync_baseline（仅正常增量）
- `id TEXT PK`、`project_id TEXT NOT NULL FK project.id`；同项目复合唯一／外键阻止跨项目引用。
- `branch_ref/head_commit TEXT NULL`、`code_manifest_ref/hash TEXT NOT NULL`，SHA-256，不能仅HEAD忽略dirty源码。
- `source_refs_json`只存资源ID／源修订／hash，不存完整正文；`coverage CHECK(complete-in-scope,partial,unknown)`；`published_batch_id`引用已reconciled批次。
- 不可变基线，项目头CAS更新。审批／授权不能由源码推造；纯源码生成身份禁止读取此表。

### sync_batch（复用现有调整批次，不并建第二业务提案）
- 稳定ID／project FK；`origin CHECK(document,code,recovery)`、同项目`causation_id`、`idempotency_key UNIQUE(project_id,key)`。
- `base_id`仅正常增量可引用共同基线；纯源码recovery必须为NULL，禁止引用历史baseline／run／proposal／trace。批次绑定当前reverse_run_policy，写入和执行边界强制验证该模式条件，不仅靠模型约定或后续读策略；`input_manifest_hash`、`proposal_ref/hash`和当前授权修订必填。
- `requirement_decision_ref/coding_grant_ref`独立引用真实记录；源码不能提供“历史已批准”；需编码任务执行前必须有有效codingGrant。
- `state CHECK(prepared,applied_pending_reconcile,reconciled,rejected,conflict,failed,cancelled)`，UTC与主体ID；租约／fencing复用runner设计。
- CR-041补充：正常文档增量复用既有需求快照，增加 `confirmed_document_snapshot_ref/hash`、`document_consistency CHECK(pending,consistent,conflict)`、`code_reconcile_state CHECK(not_required,pending,verified,failed)`。只有全部document/model目标应用并对账、确认来源与当前hash一致才可consistent；对应代码工作用该快照及旧code_manifest准入，不要求code先verified。部分落盘或后续漂移须pending/conflict并阻止新执行。
- 发布SyncBaseline仍需本批全部必要目标对账及适用代码验证／逆向核对完成；document_consistency=consistent本身不发布共同基线、不验收。recovery模式的confirmed_document_snapshot_ref及历史base_id必须为空，不借新字段向纯源码生成端提供历史资料。

### sync_target_journal（本次执行恢复，不供源码推理）
- `(batch_id,target_id)`PK，受管目标ID；`kind CHECK(document,model,code,index)`。
- base／new revision与hash、暂存引用、`apply_state CHECK(staged,applied,pending,conflict,compensated)`。
- 等于预期base／new才能继续，第三方hash冲突，不覆盖人工新稿；索引失败重建不回写源。跨介质不宣称ACID。

### source_fact_index／trace_link_index（当前输入派生）
- `(project_id,run_id,fact_id)`PK；事实类型、结构化值、源码snapshot／文件／符号／范围hash、observed／inferred／unknown／conflicting。
- 关系calls／reads／writes／validates／authorizes／transitions；输出需求／AC与源码多对多引用，名称不当稳定业务主键。
- 当前事实图可以生成Story／Feature／Epic并校验一致性；纯源码恢复启动时不得读历史追踪索引，原ID无法得知就新建输出ID并标非原编号。
- 没有测试／schema／文档来源字段可被冒充源码证据，身份按inputPolicy强制过滤，不靠模型自报sourceKind。

### reverse_run_policy／quality_report_ref
- `input_kind`固定product-source-only；输入manifest引用／hash、禁止列表、无历史context／无network补资料标志、解析器／模型／提示版本。
- 原生文件／shell／工具同策略隔离，manifest按职责识别，不以扩展名或src目录名许可隐藏测试／payload。
- 报告引用／hash、评价策略版本、分层结构／规则／AC／技术／DB指标、未知／不可恢复数量；明细正文存报告文件。
- 状态valid／invalid_leakage／partial／failed；缺读取审计或读到禁用输入不得计有效实验。评价基准仅评价身份可见，生成端禁止读。

## 3. 安全与迁移恢复计划

1. 以后获得编码授权后，在独立副本备份和增量迁移，复用既有项目／授权／模型／产物表，不创建新数据库。本次没有SQL脚本／真实库操作。
2. 正常业务存储和纯源码恢复身份分离；读源码不授权读旧文档／DB，读权限不授权隐式留存完整原文。重建上下文只允许本轮源码输入和本轮派生证据。
3. 文件CAS、DB journal／outbox事务、崩溃hash对账；第三方新稿不被补偿覆盖，全部目标同步才发布新基线。
4. 当前派生索引损坏可从本轮允许源码重建；不能从旧索引恢复原始业务意图、授权或验收记录。
5. 清理文件不等于取消业务实体。没有旧墓碑的纯源码重建不能猜历史取消状态；正常增量保留其现有审计，不把它喂给恢复端。
6. 回退不删除新增用户稿／记录，关闭不兼容入口，单独授权结构回退。业务SQL迁移仍由对应特性独立设计和授权，本设计不执行它。
7. 验证同项目FK、CAS／幂等／崩溃、输入职责过滤、历史索引拒读、评价端隔离与输出引用；[测试映射](../Test/TEST-CR032-双向变更与逆向保真验证.md)未执行真实库测试。

变更记录：2026-11-19 CR-032；18:26撤下保留语义包／归档建议，纯源码输入已确认，正常同步与重建权限分开。
