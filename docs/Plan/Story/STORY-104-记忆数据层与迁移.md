# STORY-104：记忆数据层与迁移

- 类型：用户故事（基础设施）
- 所属 Feature / PRD：[FEAT-026](../Feature/FEAT-026-个人记忆层.md)／[CR-092](../../PRD/CR-092-个人记忆层与默认记忆库.md)
- 来源与确认依据：用户 2026-11-25「按推荐全部执行，一次做完，开子代理并行开发」（正式编码授权）。
- 负责人 / 优先级 / 状态：主代理／P0／开发中
- 目标：作为系统，我要有可持久化原子记忆与用户画像的数据结构，并能在旧库上安全升级。
- 本次包含：`memory_item`/`memory_profile` 建表与索引、`migrate_feat026` 幂等迁移（挂 `db::init`）、`commands/memory_store.rs` CRUD 函数（见 LLD §4.1）。不包含：抽取/合并业务、工具、注入、界面。
- 验收标准：
  - AC-STORY-104-01：`memory_item`/`memory_profile` 与索引按 DB-FEAT-026 创建成功；重复初始化不报错（幂等）。
  - AC-STORY-104-02：旧库升级不修改 `message`/`session`/`knowledge_*` 等原表结构，`cargo test` 覆盖迁移幂等。
  - AC-STORY-104-03：`insert/get/list/find_by_key/update_content/soft_delete/hard_delete/supersede/touch_access/upsert_profile/get_profile/counts` 均可用，`list` 支持 scope/kind/status 过滤与 limit。
- 方案：[LLD-FEAT-026 §3/§4.1](../LLD/LLD-FEAT-026-个人记忆层实现.md)／[DB-FEAT-026](../../DB/DB-FEAT-026-个人记忆数据设计.md)
- 实现位置：`src-tauri/src/commands/memory_store.rs`、`src-tauri/src/db.rs`、`src-tauri/src/commands/mod.rs`
- 验证结果：通过 —— `memory_store.rs` 4 项单测（迁移幂等 / 软删过滤 / scope 隔离 / supersede 链）+ `cargo test --lib` 全量 607 通过 / 0 失败；`cargo check --all-targets` exit 0。
- 验收结论：技术验证通过，待用户验收
- 阻塞/下一步：无；为 B/C/D/E 的地基，先落。
