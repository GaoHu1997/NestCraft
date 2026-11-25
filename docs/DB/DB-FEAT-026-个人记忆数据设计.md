# DB-FEAT-026：个人记忆数据设计（CR-092）

- 归属 [FEAT-026](../Plan/Feature/FEAT-026-个人记忆层.md)，关联 [CR-092](../PRD/CR-092-个人记忆层与默认记忆库.md)／[LLD-FEAT-026](../LLD/LLD-FEAT-026-个人记忆层实现.md)。状态：开发中。
- 原则：**派生数据，可删可重建；原文权威仍在 `message` 与 Markdown 笔记。** 不改动 `message`/`session`/`knowledge_*`/`kb_embed`/`kb_link`/`project_library_grant` 任何字段；新增两表挂在 `db::init` 既有序列后。

## 1. 表与约束

### memory_item（原子记忆）

| 列 | 定义 |
| --- | --- |
| id | TEXT PRIMARY KEY，永不复用 |
| scope | TEXT NOT NULL，`global` 或 `project:<projectId>`（归属与隔离边界） |
| kind | TEXT NOT NULL，`fact`/`preference`/`goal`/`event`/`decision`/`relation` |
| memKey | TEXT，可空；合并键（同 scope+kind+memKey 视为同一事实） |
| content | TEXT NOT NULL，原子记忆正文（一句话事实/偏好） |
| sourceType | TEXT NOT NULL，`message`/`session`/`manual`/`doc` |
| sourceRef | TEXT，messageId/sessionId/noteId，**只存引用不复制正文** |
| trust | TEXT NOT NULL DEFAULT 'own'，`own`/`external`（外部来源低信任，防注入） |
| importance | INTEGER NOT NULL DEFAULT 3，1-5 |
| confidence | REAL NOT NULL DEFAULT 0.7 |
| status | TEXT NOT NULL DEFAULT 'active'，`active`/`superseded`/`deleted` |
| supersededBy | TEXT，被哪条新记忆取代（保留追溯，不物理删） |
| accessCount | INTEGER NOT NULL DEFAULT 0 |
| lastAccessAt | INTEGER |
| createdAt | INTEGER NOT NULL |
| updatedAt | INTEGER NOT NULL |

索引：`idx_mem_scope(libraryId? no → memory_item(scope,kind,status))`、`idx_mem_key(scope,memKey)`、`idx_mem_updated(status,updatedAt DESC)`。

### memory_profile（画像摘要，供快速注入）

| 列 | 定义 |
| --- | --- |
| scope | TEXT PRIMARY KEY（`global` / `project:<id>`） |
| fieldsJson | TEXT NOT NULL DEFAULT '{}'，结构化画像（身份/偏好/目标/习惯/常用技术栈/沟通偏好等，可扩展） |
| summary | TEXT NOT NULL DEFAULT ''，自然语言画像摘要（≤2KB，直接拼进 prompt） |
| revision | INTEGER NOT NULL DEFAULT 0（CAS） |
| updatedAt | INTEGER NOT NULL |

## 2. 创建 SQL（实现落 `migrate_feat026(conn)`，幂等）

```sql
CREATE TABLE IF NOT EXISTS memory_item (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    memKey TEXT,
    content TEXT NOT NULL,
    sourceType TEXT NOT NULL,
    sourceRef TEXT,
    trust TEXT NOT NULL DEFAULT 'own',
    importance INTEGER NOT NULL DEFAULT 3,
    confidence REAL NOT NULL DEFAULT 0.7,
    status TEXT NOT NULL DEFAULT 'active',
    supersededBy TEXT,
    accessCount INTEGER NOT NULL DEFAULT 0,
    lastAccessAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memory_item(scope, kind, status);
CREATE INDEX IF NOT EXISTS idx_mem_key ON memory_item(scope, memKey);
CREATE INDEX IF NOT EXISTS idx_mem_updated ON memory_item(status, updatedAt DESC);

CREATE TABLE IF NOT EXISTS memory_profile (
    scope TEXT PRIMARY KEY,
    fieldsJson TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
);
```

## 3. 复用

- 记忆 Markdown 落盘（`data/knowledge/memory/{画像,记忆,日志}/`）→ 自动进 `knowledge_note_index`/`kb_embed`/`kb_link`，复用 FTS5+语义+图谱检索。
- 内置「个人记忆库」复用 `knowledge_library`，新增 `sourceKind='personal-memory'`（首启幂等创建、enabled=1）；不新增库表列。

## 4. 迁移与回退

- 迁移：`migrate_feat026(conn)` 幂等，挂 `db::init` 既有序列；旧库升级安全，不改原表、不重建 `message`/`session`。
- 回退：关闭记忆工具开关与注入开关 → 系统回到现状；彻底回退 `DROP TABLE memory_item/memory_profile` 并删除内置记忆库登记，Markdown 记忆文件保留为普通笔记。

## 5. 隐私与容量

- 记忆是用户内容，安全等级同 `message`；不进日志、不含密钥。
- 原文不复制进 `memory_item`（只存 `sourceRef`）；画像 `summary` 有界（≤2KB）。
- 删除为软删（status=deleted），可重建派生数据；用户"彻底删除"由 UI 触发物理删对应行。
- 索引与记忆表均本地；不做外部同步、不上传。
