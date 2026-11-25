# DB-CR086：知识库链接索引

- 归属 FEAT-009／[STORY-014 CR-086](../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-088-obsidian-式链接与反链)；[方案](../LLD/LLD-CR088-知识库链接与反链实现.md)。
- 性质：**派生索引**，不是事实来源。正文文件为唯一真相；本表可随时删除重建，不影响原件、正文与 AI 授权。
- 状态：**已实现（2026-11-25）**，建表在 `src-tauri/src/db.rs` 的 `migrate()`；实际用法见 [LLD §0](../LLD/LLD-CR088-知识库链接与反链实现.md)。

## 表结构（建议）

```sql
CREATE TABLE kb_link (
  libraryId      TEXT NOT NULL,
  sourceNoteId   TEXT NOT NULL,      -- 源笔记稳定 ID
  sourcePath     TEXT NOT NULL,      -- 源相对路径（便于重建与展示）
  sourceRevision TEXT NOT NULL,      -- 写入时的源内容修订（FNV/SHA）
  ordinal        INTEGER NOT NULL,   -- 同一文件内出现顺序，保证稳定排序
  rawTarget      TEXT NOT NULL,      -- 原始写法：name / path/name / name#标题
  targetPath     TEXT,               -- 归一后的相对路径；NULL=未解析
  targetNoteId   TEXT,               -- 解析到的稳定 ID；NULL=未解析/歧义
  heading        TEXT,               -- 锚点标题原文（可空）
  state          TEXT NOT NULL,      -- resolved | unresolved | ambiguous
  PRIMARY KEY (libraryId, sourceNoteId, ordinal)
);
CREATE INDEX kb_link_target ON kb_link(libraryId, targetNoteId);
CREATE INDEX kb_link_state  ON kb_link(libraryId, sourceNoteId, state);
```

- 反链查询：`SELECT ... FROM kb_link WHERE libraryId=? AND targetNoteId=? ORDER BY sourcePath, ordinal`。
- 出链查询：按 `sourceNoteId` 全取。
- 未解析/歧义不单独建表，用 `state` 区分；歧义候选由解析函数实时返回，不落库，避免缓存过期。

## 一致性

| 事件 | 处理 |
| --- | --- |
| Markdown 保存成功 | 同事务内删除该 `sourceNoteId` 的旧行，重新解析写入 |
| 文件重命名/移动 | 事务内更新受影响源文件的链接文本并重算其索引；同时更新 `targetPath` 命中的行 |
| 文件删除/移出库 | 删除其作为源的记录；作为目标的记录标为 `unresolved` |
| 索引损坏/版本升级 | 后台全量重建（分页扫描 Markdown，仅文本解析） |

## 迁移与回退

- 新增表，不改既有表结构；启动时 `CREATE TABLE IF NOT EXISTS`，无需数据迁移。
- 回退：删除该表并关闭反链页签即可，正文与原件零影响。
- 不写入原件、不改权限；不参与 AI 检索与授权判定（AI 仍按现有内容索引与 grant 规则）。
