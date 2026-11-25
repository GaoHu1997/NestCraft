# DB-CR089：知识库语义向量索引

- 归属 FEAT-009／CR-089；[需求](../PRD/CR-089-知识库图谱与本地语义.md)／[方案](../LLD/LLD-CR089-知识库图谱与语义实现.md)。
- 状态：**已实现（2026-11-25）**，建表在 `src-tauri/src/db.rs` 的 `migrate()`。
- 性质：**派生数据**。正文仍是文件真相；本表可整表删除并重建，不影响原件、正文、链接与 AI 授权。

## 表结构

```sql
CREATE TABLE IF NOT EXISTS kb_embed (
  libraryId    TEXT NOT NULL,
  noteId       TEXT NOT NULL,
  chunkKey     TEXT NOT NULL,     -- 与切块一致（file:ordinal 之类，实现层定义）
  sourcePath   TEXT NOT NULL,
  revision     TEXT NOT NULL,     -- 编码时的源修订，用于失效判断
  modelId      TEXT NOT NULL,     -- 例如 bge-small-zh-v1.5
  modelVersion TEXT NOT NULL,     -- 模型+量化+分词器组合版本
  dim          INTEGER NOT NULL,  -- 512
  vector       BLOB NOT NULL,     -- int8 量化，长度=dim
  preview      TEXT NOT NULL,     -- 片段摘要（≤200 字），仅用于展示
  updatedAt    INTEGER NOT NULL,
  PRIMARY KEY (libraryId, noteId, chunkKey)
);
CREATE INDEX IF NOT EXISTS kb_embed_library ON kb_embed(libraryId, noteId);
```

## 一致性

| 事件 | 处理 |
| --- | --- |
| Markdown 保存 | 同事务删除该 note 旧行 → 重新切块编码写入（编码失败不回滚正文保存，只标记语义索引待重建） |
| 文件删除/移动 | 删除旧 note 行；移动后按新路径重编码 |
| 模型升级/替换 | `modelVersion` 不匹配的行视为无效，后台重建 |
| 索引损坏 | 删除表或按库删除后全量重建（可取消、有进度） |

## 迁移与回退

- 仅新增表，无历史数据迁移；`db::migrate()` 中 `CREATE TABLE IF NOT EXISTS`。
- 回退：`DROP TABLE kb_embed` 并关闭语义开关，检索自动回落关键词（`semantic: unavailable`），其余功能不受影响。
- 向量不参与权限判定；AI 授权仍以 `project_library_grant` 与库启用状态为准。
