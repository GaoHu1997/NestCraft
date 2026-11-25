# DB-CR078：日程表与用量聚合

- 状态：**设计，未实现**（2026-11-24）。无编码授权。
- 关联：CR-078 / [STORY-097](../Plan/Story/STORY-097-概览页日程与用量.md) / [LLD-CR078](../LLD/LLD-CR078-概览页日程与用量实现.md) / [UI-CR078](../UI/文档/UI-CR078-概览页日程与用量.md)。
- 位置：实现时在 `src-tauri/src/db.rs` 的 `migrate()` 末尾新增 `migrate_cr078(conn)`，纯增量、幂等。

## 1. 结论

| 需求 | 数据设计 |
| --- | --- |
| 日程（可跨天） | **新建表** `schedule_event` |
| 待办 | **新建表** `schedule_todo`（与日程同属「当天的事项」，但独立于日程，不混用一张表） |
| 节假日 / 传统节日 / 节气 / 农历 / 黄历 | **无需数据库**：本地算法 + 内置表（农历信息表 1900–2100、调休 2025–2027），随包发布，不联网 |
| 用量统计 | **不新建表、不改列**：复用 `message.metaJson.usage` 与 `session` 的 `cliId / providerId / modelId / runner`，用 SQL 聚合；按需新增**索引** |
| 天气缓存（v3 新增能力） | **不新建表**：复用 `setting_default`，键 `weather.last`，值为 JSON `{city, temp, low, high, text, code, updatedAt, lat, lon}` |

## 2. schedule_event（新建）

| 列 | 类型 | 约束 / 默认 | 含义 |
| --- | --- | --- | --- |
| id | TEXT | PRIMARY KEY | 事件 ID（前端生成或 `ev_` + ULID） |
| title | TEXT | NOT NULL | 标题，≤80 字（应用层校验） |
| startDate | TEXT | NOT NULL | 开始日期 `YYYY-MM-DD` |
| endDate | TEXT | NOT NULL | 结束日期 `YYYY-MM-DD`，应用层与 CHECK 双重保证 `endDate >= startDate` |
| allDay | INTEGER | NOT NULL DEFAULT 1 | 1 全天 / 0 具体时间 |
| startTime | TEXT | NOT NULL DEFAULT '' | `HH:mm`，全天为空 |
| endTime | TEXT | NOT NULL DEFAULT '' | `HH:mm`，全天为空 |
| note | TEXT | NOT NULL DEFAULT '' | 备注，≤200 字 |
| color | TEXT | NOT NULL DEFAULT 'blue' CHECK (color IN ('blue','green','amber','violet','rose')) | 颜色 |
| createdAt | INTEGER | NOT NULL | 创建时间 ms |
| updatedAt | INTEGER | NOT NULL | 更新时间 ms |
| deletedAt | INTEGER | 可空 | 软删除；列表查询过滤 `deletedAt IS NULL` |

索引：`idx_schedule_event_range ON schedule_event(startDate, endDate) WHERE deletedAt IS NULL`——月历按 `[月初, 月末]` 区间查询 `startDate <= :end AND endDate >= :start`。

跨月查询：UI 切月时查询该月可视 6 周（含前后补齐日期）的范围，一次取回。

## 3. schedule_todo（新建）

| 列 | 类型 | 约束 / 默认 | 含义 |
| --- | --- | --- | --- |
| id | TEXT | PRIMARY KEY | |
| date | TEXT | NOT NULL | 所属日期 `YYYY-MM-DD` |
| title | TEXT | NOT NULL | ≤80 字 |
| done | INTEGER | NOT NULL DEFAULT 0 | 0 未完成 / 1 完成 |
| createdAt / updatedAt | INTEGER | NOT NULL | |
| deletedAt | INTEGER | 可空 | 软删除 |

索引：`idx_schedule_todo_date ON schedule_todo(date) WHERE deletedAt IS NULL`。

不做重复待办、不做跨天待办（需求明确不做）。

## 4. 用量聚合（复用既有数据）

### 4.1 数据来源（已存在，本轮实读）

| 来源 | 位置 | 写入时机 |
| --- | --- | --- |
| CLI 会话每轮用量 | `message.metaJson.usage = {inputTokens, outputTokens, cacheReadTokens}`（role='assistant'） | CLI 每轮流结束 |
| 平台主代理 / 子智能体步骤 | `message.metaJson.sessionStats.closedSteps[].usage = [in, out, cache]`（role='user'） | `chat_stats.rs::save_turn` |
| 会话归属 | `session.cliId / providerId / modelId / runner` | 会话创建 |

### 4.2 来源判定

- `session.runner = 'cli'` → 来源 `cli`，供应商 / 模型取 `session.providerId / modelId`，CLI 标识取 `session.cliId`。
- `session.runner = 'platform'` → 来源 `platform`。
- 子智能体：`message.metaJson.parentToolUseId` 非空的消息 → 来源 `subagent`（与 CR-062 一致）。

### 4.3 聚合策略

**不在写入时维护汇总表**，而是读时 SQL 聚合（SQLite `json_extract`），理由：现有数据已经落库、无需回填、不会因双写不一致。

```sql
-- 日 / 小时 / 模型 / 供应商 维度；range 为 [from, to) 的 createdAt 毫秒区间
SELECT
  date(createdAt/1000, 'unixepoch', 'localtime') AS day,
  strftime('%H', createdAt/1000, 'unixepoch', 'localtime') AS hour,
  COALESCE(json_extract(metaJson,'$.usage.inputTokens'),0)     AS inputTokens,
  COALESCE(json_extract(metaJson,'$.usage.outputTokens'),0)    AS outputTokens,
  COALESCE(json_extract(metaJson,'$.usage.cacheReadTokens'),0) AS cacheTokens
FROM message WHERE role='assistant' AND createdAt >= :from AND createdAt < :to;
```

性能：`message` 已有 `idx_message_session(sessionId, createdAt)`，但按时间跨会话查询缺索引。**新增** `idx_message_createdAt ON message(createdAt)`（幂等）。数据量级：单机个人工具，按 90 天聚合远小于万级消息，可接受；若后续变慢再考虑物化视图（不在本期）。

查询窗口（v5）：日粒度要服务「活跃热力图固定 28 周」，所以实际查询区间取 `min(range.from, today-195d) .. range.to+1d`；**周期起点之前**的行只累加 `days[]`（热力图），不进入 `totals`、`hours[]`、`models[]`、`providers[]`。这不改变表结构与索引，只改聚合时的分桶判断。

模型维度聚合键（v5）：`models[]` 与 `hours[i].models[]` 均以 `COALESCE(session.modelId,'未记录模型')` 的**显示名称**为键，同名跨来源合并成一行 / 一段，来源不同则 `source='mixed'`；每小时内按 `input+output` 降序。原按 `(modelId, source)` 分行会让同一模型在趋势图里出现多条、颜色无法与排行对应。

### 4.4 缺省规则（对应 PRD §2.1-C-7）

- `metaJson` 无 `usage` 或字段缺失 → 该消息**不计入**任何指标（不按字符数估算）。
- 某模型 / 供应商在周期内全部消息都缺 usage → 排行显示「未上报」，不画占比条。
- 缓存命中率 = `cacheTokens / (inputTokens + cacheTokens)`；分母为 0 显示「—」。
- 请求量 = 有 `usage` 的 assistant 消息数；失败数取 `metaJson.error` 非空的消息数（无则 0，不编造 12.1%）。

### 4.5 命令契约（供 LLD 引用）

| 命令 | 入参 | 出参 |
| --- | --- | --- |
| `schedule_event_list` | `{from: "YYYY-MM-DD", to: "YYYY-MM-DD"}` | `ScheduleEvent[]` |
| `schedule_event_save` | `ScheduleEvent`（含 id 则更新，不含则创建） | `ScheduleEvent` |
| `schedule_event_delete` | `{id}` | `{ok}` |
| `schedule_todo_list` | `{date}` | `Todo[]` |
| `schedule_todo_save` / `schedule_todo_toggle` / `schedule_todo_delete` | — | — |
| `usage_stats` | `{range: "today"\|"3d"\|"7d"\|"1m"\|"3m"\|"custom", from?, to?}` | `{totals, days[], hours[24], models[], providers[], asOf}` |

## 5. 迁移与回退

- `migrate_cr078`：建两张表 + 三个索引（`IF NOT EXISTS`），可重复执行。天气缓存走既有 `setting_default`，无需迁移。
- 回退：两张新表为独立数据，删除表即回退；`idx_message_createdAt` 为只读索引，`DROP INDEX` 即回退。不影响既有表与列。
- 升级前无需备份（纯新增）；降级到旧版后日程 / 待办数据留存于库中不被读取，`weather.last` 键被忽略。

## 6. 不做

- 不建用量汇总表 / 物化视图。
- 不存黄历 / 节气计算结果。
- 不做日历订阅（ICS）、不做重复日程规则表。
