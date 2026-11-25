# DB-CR072：项目管理／知识库／服务器扩展字段

- 状态：已实现（2026-11-24），待验收。实现：`src-tauri/src/db.rs` 的 `migrate_cr072`（幂等 ALTER）；命令见 projects/knowledge/servers。
- 关联：CR-072 / [STORY-095](../Plan/Story/STORY-095-三页管理界面数据接入与设计对齐.md) / [LLD-CR072](../LLD/LLD-CR072-三页管理界面数据接入实现.md)。
- 位置：`src-tauri/src/db.rs` 在 `migrate()` 末尾调用新增 `migrate_cr072(conn)`；纯增量、幂等，不改既有列、不删数据。

## 1. project（复用现有表，新增列）

| 列 | 类型 | 约束/默认 | 含义 |
|---|---|---|---|
| owner | TEXT | NOT NULL DEFAULT '' | 负责人显示名 |
| description | TEXT | NOT NULL DEFAULT '' | 项目描述 |
| tagsJson | TEXT | NOT NULL DEFAULT '[]' | 项目标签数组（JSON 字符串数组） |

保留 id/name/type/rootUri/icon/iconColor/createdAt/updatedAt 不变。

**派生（不落库，`list_projects` 查询时计算）**
- `storyTotal` / `storyDone`：`requirement_index WHERE projectId=? AND type='story'` 的总数与 `status='completed'` 数。
- `runningCount`：`execution_task WHERE projectId=? AND status NOT IN ('succeeded','failed','cancelled','blocked','paused')` 计数；表不存在或空为 0。

## 2. knowledge_library（新增列）

| 列 | 类型 | 约束/默认 |
|---|---|---|
| owner | TEXT | NOT NULL DEFAULT '' |
| description | TEXT | NOT NULL DEFAULT '' |

## 3. server_host（新增列：指标缓存）

| 列 | 类型 | 可空 | 含义 |
|---|---|---|---|
| os | TEXT | 是 | 系统标识（采样记录） |
| lastSeenAt | INTEGER | 是 | 最近一次采样时间(ms) |
| cpuPct | REAL | 是 | 最近 CPU 平均使用率(%) |
| memPct | REAL | 是 | 最近内存使用率(%) |
| diskPct | REAL | 是 | 最近磁盘使用率(%)（如有） |

写入口：`server_metrics` 采样成功后写回 os/lastSeenAt/cpuPct/memPct/diskPct；`server_list` 返回这些缓存值。未连接或未采样为空 → 前端显示「—/未知」，不虚构。

## 4. 迁移与回退

- `migrate_cr072`：用 `PRAGMA table_info(<table>)` 读取现有列，缺列才 `ALTER TABLE ADD COLUMN`；重复执行幂等。
- 回退：新增列均可空或有默认，旧代码忽略即可，无需删列；存量数据不改。

## 5. 索引

无需新增索引：`requirement_index` 以 (projectId, entityId) 为主键前缀，`execution_task` 已有 `idx_execution_task_queue(projectId, status, …)`，满足按 projectId 的聚合。

## 6. 验证

- 迁移幂等：连续启动两次不报错、列不重复。
- 回填：新建项目空的 owner/描述/标签为 ''/'[]'；列表派生统计与实际 requirement_index/execution_task 一致。
