# DB-CR069：会话运行通道与派发记录

- 关联：[CR-069](../PRD/CR-069-平台主代理运行时与受管执行接入.md)／[LLD-CR069](../LLD/LLD-CR069-平台主代理运行时实现.md)／[STORY-089](../Plan/Story/STORY-089-平台主代理会话与模型调用.md)／[STORY-091](../Plan/Story/STORY-091-主代理派发与受管执行接入.md)。
- 状态：设计定稿，**未迁移、未执行**。

## 1. 权威与复用边界

本需求**不新建**任务、批次、计划、消息的任何表。全部复用：

| 数据 | 归属 | 位置 |
| --- | --- | --- |
| 会话与消息 | FEAT-011／FEAT-021 | `db.rs:209-233` |
| 供应商／端点／密钥／模型 | FEAT-014 | `db.rs:120-165` 区段（`provider` / `provider_key` / `provider_endpoint` / `model`） |
| 能力启停（tool/skill/mcp） | FEAT-013 | `db.rs:178-191`（`capability`） |
| 执行批次／任务／依赖／步骤 | FEAT-019 | `execution.rs:99-357`（`ensure_schema`） |
| 执行计划与授权 | FEAT-019 | 同上，`execution_plan` / `execution_plan_authorization` |
| 工作包与义务 | FEAT-018／047 | 同上 |

**本需求唯一的 schema 变更**是 `session.runner`。

## 2. `session.runner` 字段

### 2.1 定义

| 项 | 值 |
| --- | --- |
| 表 | `session` |
| 列名 | `runner` |
| 类型 | `TEXT` |
| 约束 | `NOT NULL DEFAULT 'cli'`，`CHECK (runner IN ('cli','platform'))` |
| 语义 | `cli`＝既有 CLI 子进程通道；`platform`＝平台主代理直接作答 |
| 索引 | `idx_session_runner ON session(projectId, runner, updatedAt)` |

### 2.2 迁移语句

```sql
ALTER TABLE session ADD COLUMN runner TEXT NOT NULL DEFAULT 'cli'
    CHECK (runner IN ('cli','platform'));

UPDATE session SET runner='cli'
  WHERE runner IS NULL OR runner NOT IN ('cli','platform');

CREATE INDEX IF NOT EXISTS idx_session_runner
    ON session(projectId, runner, updatedAt);
```

### 2.3 兼容与回退

| 情形 | 行为 |
| --- | --- |
| 旧库升级 | 全部既有行得到 `cli`，行为与升级前完全一致 |
| 新库建表 | 建表语句包含该列；`migrate_session_runner` 幂等跳过 |
| 回退到旧版本 | 旧版本 SELECT 不查该列，可正常运行；列保留但被忽略 |
| 取值非法 | `CHECK` 拒绝写入；读取侧仍以 `unwrap_or("cli")` 兜底 |

**回退不需要 DROP COLUMN**。SQLite 的 `DROP COLUMN` 对带索引与约束的表支持有限，且无必要——多一列不影响旧代码。

### 2.4 为什么不做单独的 runner 配置表

**否决方案**：新建 `session_runner` 表以 `sessionId` 为外键。

否决理由：

1. 会话与通道是一对一且不可分割的属性，拆表只会增加 JOIN。
2. 既有 `sessionRole`（`db.rs:475` 添加）已经采用同表列的方式表达会话身份，保持一致。
3. 拆表后删除会话需要额外级联处理，而现有 `message` 已用 `ON DELETE CASCADE`（`db.rs:225`），新增表容易遗漏。

## 3. 派发记录：不新增表

`dispatch_work` 直接调用 `execution::create_batch`（`execution.rs:619-726`），因此派发产生的数据落在既有表：

| 表 | 产生内容 |
| --- | --- |
| `execution_batch` | 1 行，`idempotencyKey`＋`requestDigest` 保证幂等 |
| `execution_task` | N 行（每 Story 一行），初始 `status='queued'` |
| `execution_step` | 每任务 3 行（`prepare`/`implement`/`verify`），见 `execution.rs:681-695` |
| `execution_dependency` | 0..M 行，取决于输入依赖边 |
| `execution_event` | 由 `write_event` 写入状态变更事件（`execution.rs:576-606`） |
| `execution_plan` | 可选；仅当允许创建计划时 |

**不记录「这是主代理发起的」额外字段**。理由：

- 需要来源追溯时应通过 `execution_event` 的 actor 或后续审计增量表达，不在本需求临时加列；
- 现有 `CreateBatchInput`（`execution.rs:366-376`）没有来源字段，加字段会改变 FEAT-019 的既有契约，超出本需求范围。

**本条为已知限制**：首版无法从数据区分「主代理发起」与「用户手工发起」的批次。若产品需要，应作为 FEAT-018 的独立增量并补设计，不在本 CR 内隐式实现。

## 4. 消息记录

平台会话的消息仍写入既有 `message` 表（`db.rs:223-233`）：

| 角色 | 内容 | metaJson |
| --- | --- | --- |
| `user` | 用户输入（含编译后的引用上下文） | `refsJson` 记录引用 |
| `assistant` | 模型文本 | `thinking`、`usage`、`thinkingMs`（沿用 `chat.rs:1966-1973`） |
| `tool_use` | 工具名 | `{"toolId":..,"input":..}`（沿用 `chat.rs:1979-1984`） |
| `tool_result` | 工具结果文本 | `{"toolId":..,"isError":..}`（沿用 `chat.rs:1985-1990`） |

**不新增 `role` 取值**。否则前端 `fromChatMessage` 与既有渲染分支需要同步扩展，扩大改动面。

## 5. 不变量

以下不变量必须有测试覆盖（见 [TEST-CR069](../Test/TEST-CR069-平台主代理运行时验证.md)）：

1. `session.runner` 取值只能是 `cli` 或 `platform`。
2. 旧库升级后所有既有会话 `runner='cli'`。
3. 迁移可重复执行，不报错、不改数据。
4. 派发使用相同 `idempotencyKey`＋相同 `requestDigest` 时不产生第二个 `execution_batch`。
5. 相同 `idempotencyKey`＋不同 `requestDigest` 时拒绝，且原批次不变。
6. `dispatch_work` 产生的任务 `status` 只能是 `queued`（不得出现 `running`）。
7. 平台会话的 `message` 行数与本轮工具调用次数一致（每个 tool_call 对应一组 `tool_use`＋`tool_result`）。

## 6. 容量与性能

| 关注点 | 现状 | 本需求影响 |
| --- | --- | --- |
| `message` 表行数 | 每轮工具调用增加 2N 行 | 工具上限 24 次/轮 → 单轮最多 +48 行；有界 |
| `session` 表 | 加一列 | 忽略不计 |
| 每轮 `capability` 查询 | 新增 1 次/轮 | 最多 8 次/轮；SQLite 本地查询，代价可忽略 |
| `execution_task` | 每批 N 行 | 复用既有；无新增索引需求 |

**未做**：未对 `message` 加新索引。现有 `idx_message_session ON message(sessionId, createdAt)`（`db.rs:233`）已覆盖按会话读取。

## 7. 备份与恢复

无独立备份需求：本次只加列，且既有备份策略覆盖整个 SQLite 文件。迁移失败时（例如 CHECK 与既有脏数据冲突），迁移函数返回错误，应用启动失败并保留原库——**不自动删除或重建数据库**。

## 8. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-23 | 建立；仅 `session.runner` 一处 schema 变更 | 用户要求出需求／设计／方案 |
