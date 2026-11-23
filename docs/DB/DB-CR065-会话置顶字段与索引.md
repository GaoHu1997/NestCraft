# DB-CR065：会话置顶字段与索引

- 关联：[CR-065](../PRD/CR-065-会话历史状态标识与行操作.md) / [LLD-CR065](../LLD/LLD-CR065-会话历史状态标识与行操作实现.md) / [STORY-084](../Plan/Story/STORY-084-会话历史状态标识与行操作.md)（AC-11）。
- 结论：`session` 表新增 `pinnedAt` 字段；重建 CR-063 的三个分页索引以包含置顶排序键。

## 1. 字段变更

```sql
ALTER TABLE session ADD COLUMN pinnedAt INTEGER NOT NULL DEFAULT 0;
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `pinnedAt` | INTEGER NOT NULL DEFAULT 0 | `0` = 未置顶；非 0 = 置顶时刻（毫秒时间戳） |

- 不改变既有字段；`unread` 仍为 `TEXT`（none|green|red|yellow 及兼容值）。
- 旧行迁移后 `pinnedAt=0`，行为不变。

## 2. 迁移

函数：`migrate_cr064_session_pin(conn)`。

1. `PRAGMA table_info(session)` 检查 `pinnedAt`；缺则 `ALTER TABLE ... ADD COLUMN`（幂等，不重复添加）。
2. 重建索引（旧索引名复用，先删后建）：

```sql
DROP INDEX IF EXISTS idx_session_project_updated;
DROP INDEX IF EXISTS idx_session_server_updated;
DROP INDEX IF EXISTS idx_session_scope_updated;

CREATE INDEX idx_session_project_updated ON session(projectId, pinnedAt DESC, updatedAt DESC, id DESC);
CREATE INDEX idx_session_server_updated  ON session(serverId, pinnedAt DESC, updatedAt DESC, id DESC);
CREATE INDEX idx_session_scope_updated   ON session(projectId, serverId, pinnedAt DESC, updatedAt DESC, id DESC);
```

3. 位置：`db.rs` 迁移链，在 `migrate_cr063_session_page_index` 之后执行。

### 2.1 为什么重建索引

CR-063 的分页排序是 `updatedAt DESC, id DESC`，索引前缀不含 `pinnedAt`。新排序为 `pinnedAt DESC, updatedAt DESC, id DESC`，旧索引无法消除排序临时表，必须把 `pinnedAt` 放在 `updatedAt` 之前。

## 3. 查询形态

```sql
SELECT <SESSION_COLUMNS>
FROM session s
WHERE <scope> [AND s.title LIKE ? ESCAPE '\']
  [AND (s.pinnedAt < ?p
        OR (s.pinnedAt = ?p AND s.updatedAt < ?u)
        OR (s.pinnedAt = ?p AND s.updatedAt = ?u AND s.id < ?id))]
ORDER BY s.pinnedAt DESC, s.updatedAt DESC, s.id DESC
LIMIT ?n + 1;

SELECT COUNT(*) FROM session s WHERE <scope> [AND s.title LIKE ? ESCAPE '\'];
```

## 4. 回退

```sql
DROP INDEX IF EXISTS idx_session_project_updated;
DROP INDEX IF EXISTS idx_session_server_updated;
DROP INDEX IF EXISTS idx_session_scope_updated;
-- 重建 CR-063 版本（不含 pinnedAt）
CREATE INDEX idx_session_project_updated ON session(projectId, updatedAt DESC, id DESC);
CREATE INDEX idx_session_server_updated  ON session(serverId, updatedAt DESC, id DESC);
CREATE INDEX idx_session_scope_updated   ON session(projectId, serverId, updatedAt DESC, id DESC);
-- 字段可保留（默认 0，不影响旧代码）；如需彻底回退：
ALTER TABLE session DROP COLUMN pinnedAt;   -- SQLite 3.35+；执行前确认无读取方
```

仅影响排序与查询计划，不丢数据。

## 5. 验证

| 编号 | 项 | 方式 | 预期 |
| --- | --- | --- | --- |
| D-01 | 字段迁移幂等 | 连续执行迁移两次 | 字段一条，无报错 |
| D-02 | 旧行默认值 | 迁移前插入旧行，迁移后查询 | `pinnedAt=0` |
| D-03 | 三索引重建 | 查 `sqlite_master` | 三个索引均含 `pinnedAt` |
| D-04 | project-only 查询计划 | `EXPLAIN QUERY PLAN` | 用新索引，无 `TEMP B-TREE` |
| D-05 | 置顶排序 | 置顶两条后查询 | 置顶在前、组内按置顶时间倒序 |
| D-06 | 游标翻页 | 置顶 2 条 + 未置顶 23 条，连续分页 | 不重不漏、顺序稳定 |
| D-07 | 回退 | 重建旧索引后功能可用 | 通过 |

> 实现后需把实际查询计划贴入 REPORT-CR064（开发后生成）。