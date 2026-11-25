# STORY-107：会话记忆注入

- 类型：用户故事（上下文）
- 所属 Feature / PRD：[FEAT-026](../Feature/FEAT-026-个人记忆层.md)／[CR-092](../../PRD/CR-092-个人记忆层与默认记忆库.md)
- 来源与确认依据：同上（正式编码授权）。
- 负责人 / 优先级 / 状态：主代理／P0／开发中
- 目标：作为 AI，在新会话开始时自动获得用户画像与相关记忆，从而"一开始就懂你"。
- 本次包含：在平台 runtime 组装 system prompt 处（`platform_context_runtime.rs`，必要时 `chat.rs` 平台分支）请求前调用 `memory::build_memory_context`，非空追加到 system 段；scope 推断（会话绑定项目→`project:<id>` + `global`，否则 `global`）；开关（默认开、可按会话/项目关闭）。不包含：抽取/工具/界面。
- 验收标准：
  - AC-STORY-107-01：新会话首轮请求的 system prompt 含画像摘要+相关记忆（若有），且按预算截断。
  - AC-STORY-107-02：关闭注入开关时不注入，行为回现状。
  - AC-STORY-107-03：无记忆/无画像时不产生空块、不影响原 prompt。
- 方案：[LLD-FEAT-026 §4.5](../LLD/LLD-FEAT-026-个人记忆层实现.md)
- 实现位置：`src-tauri/src/commands/platform_context_runtime.rs`（及 `chat.rs` 平台分支）
- 依赖：STORY-104、STORY-105
- 验证结果：通过（代码接线+编译）—— `platform_context_runtime.rs` 的 `Prepared.load` 调用 `build_memory_context_for_session` 并追加到 `system()`；随全量 607 通过 / 0 失败。真实模型端到端未跑。
- 验收结论：技术验证通过（真实端到端未验证），待用户验收
- 阻塞/下一步：真实模型端到端如未跑需标注未验证。
