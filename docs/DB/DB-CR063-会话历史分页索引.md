# DB-CR063：会话历史分页索引

- 版本：**v2**（2026-11-22 评审 I-05 修订：单一复合索引无法覆盖实际查询分支）。
- 关联：[CR-063](../PRD/CR-063-会话历史分批加载与全项目搜索.md) / [LLD-CR063](../LLD/LLD-CR063-会话历史分批加载与全项目搜索实现.md) / [STORY-082](../Plan/Story/STORY-082-会话历史分批加载与搜索.md)（AC-01、AC-07）。
- 结论：**无表结构变更**，仅新增三个查询索引。

## 1. 现状

`session` 表字段（既有，不修改）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 会话 id |
| `projectId` | TEXT NULL | 所属项目；全局会话为 NULL |
| `serverId` | TEXT NULL | 所属服务器；无则为 NULL |
| `title` | TEXT NOT NULL | 会话标题，搜索目标 |
| `updatedAt` | INTEGER NOT NULL | 最近更新时间，主排序键 |
| 其他 | — | `cliId/providerId/modelId/effort/draft/unread/createdAt/featureId…`，本 CR 不涉及 |

现有索引：`idx_session_feature(projectId, featureId, updatedAt)`（CR-047 执行会话查询使用），保留不动。

## 2. 变更

```sql
-- project-only（生产主路径）与全局作用域（projectId IS NULL 前缀定位）
CREATE INDEX IF NOT EXISTS idx_session_project_updated
  ON session(projectId, updatedAt DESC, id DESC);

-- server-only
CREATE INDEX IF NOT EXISTS idx_session_server_updated
  ON session(serverId, updatedAt DESC, id DESC);

-- project + server 同时等值
CREATE INDEX IF NOT EXISTS idx_session_scope_updated
  ON session(projectId, serverId, updatedAt DESC, id DESC);
```

### 2.1 为什么是三个而不是一个

- `ORDER BY updatedAt DESC, id DESC` 要由索引直接满足，索引里 `updatedAt` 之前的列必须全部是等值条件。
- 实际查询分支中，`App.tsx` 只传 `projectId`（不传 `serverId`），生产主路径是 **project-only**；单一 `(projectId, serverId, updatedAt, id)` 中 `serverId` 处于中间且无等值条件，SQLite 仍要做 `TEMP B-TREE` 排序。
- server-only 不能使用以 `projectId` 为前缀的索引。
- 全局作用域 `projectId IS NULL AND serverId IS NULL` 可用 `idx_session_project_updated` 的 `projectId IS NULL` 前缀定位，`serverId IS NULL` 作为残余过滤；允许存在排序（全局会话数量很小）。
- `title LIKE '%kw%'` 前后缀通配，无法走 B-tree；在作用域内顺序过滤即可，不引入 FTS。

### 2.2 迁移

- 函数：`migrate_cr063_session_page_index(conn)`，执行三条 `CREATE INDEX IF NOT EXISTS`，幂等。
- 位置：`src-tauri/src/db.rs` 既有迁移调用链，在 `migrate_session_feature_binding` 之后。
- 无数据回填、无双写、无兼容窗口；旧版本读取不受影响。

### 2.3 回退

```sql
DROP INDEX IF EXISTS idx_session_project_updated;
DROP INDEX IF EXISTS idx_session_server_updated;
DROP INDEX IF EXISTS idx_session_scope_updated;
```

只影响查询计划，不丢数据。回退后功能仍正确，仅大数据量下排序变慢。

## 3. 查询形态

```sql
SELECT <SESSION_COLUMNS>
FROM session s
WHERE <scope> [AND s.title LIKE ? ESCAPE '\']
  [AND (s.updatedAt < ?c OR (s.updatedAt = ?c AND s.id < ?cid))]
ORDER BY s.updatedAt DESC, s.id DESC
LIMIT ?n + 1;

SELECT COUNT(*) FROM session s WHERE <scope> [AND s.title LIKE ? ESCAPE '\'];
```

## 4. 验证

| 编号 | 项 | 方式 | 预期 |
| --- | --- | --- | --- |
| D-01 | 索引存在且幂等 | 连续执行迁移两次，查 `sqlite_master` | 三条各一条，无报错 |
| D-02 | project-only 查询计划 | `EXPLAIN QUERY PLAN` | 使用 `idx_session_project_updated`，**无** `TEMP B-TREE` |
| D-03 | project+server 查询计划 | 同上 | 使用 `idx_session_scope_updated`，**无** `TEMP B-TREE` |
| D-04 | server-only 查询计划 | 同上 | 使用 `idx_session_server_updated`，**无** `TEMP B-TREE` |
| D-05 | 全局作用域查询计划 | 同上 | 使用 `idx_session_project_updated`；允许残余过滤与排序（如出现 `TEMP B-TREE` 需记录，不视为失败） |
| D-06 | 无表结构变化 | 迁移前后 `PRAGMA table_info(session)` | 一致 |
| D-07 | 回退可用 | 执行 `DROP INDEX` 后功能仍通过，再重建 | 通过 |

> D-02～D-05 必须实测并把实际计划贴入 [REPORT-CR063](../Test/REPORT-CR063-会话历史分批加载与搜索验证.md)；未实测前不得在交付中宣称“索引生效”。