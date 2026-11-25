# STORY-106：记忆工具

- 类型：用户故事（AI 工具）
- 所属 Feature / PRD：[FEAT-026](../Feature/FEAT-026-个人记忆层.md)／[CR-092](../../PRD/CR-092-个人记忆层与默认记忆库.md)
- 来源与确认依据：同上（正式编码授权）。
- 负责人 / 优先级 / 状态：主代理／P0／开发中
- 目标：作为 AI，我要能检索、写入、列出、遗忘记忆并读取用户画像，从而在对话中主动"记住"和"想起"。
- 本次包含：`commands/memory_tools.rs` 的 5 个工具实现；`ai_tools.rs` 注册 5 个 `ToolDef`、`TOOL_COUNT` 25→30、`run_tool` 分发、`REG_LABELS`；授权（scope 由 projectId 派生）、预算、审计；`mod.rs` 声明模块。不包含：注入（107）、后台抽取（108）、界面（109）。
- 验收标准：
  - AC-STORY-106-01：`memory_search/save/list/forget/profile_get` 注册进 `workbench_tools`，MCP 与平台 runtime 均可见，可单独停用。
  - AC-STORY-106-02：`memory_save` 走合并逻辑（同 key 更新不重复）。
  - AC-STORY-106-03：`memory_search`/`memory_list` 有界（≤20 条、片段≤200 字），库启用/授权复检，未授权返回 `KB_ACCESS_DENIED` 风格错误。
  - AC-STORY-106-04：`memory_forget` 软删，`profile_get` 返回画像；写类记审计。
- 方案：[LLD-FEAT-026 §4.3/§4.4/§5](../LLD/LLD-FEAT-026-个人记忆层实现.md)
- 实现位置：`src-tauri/src/commands/memory_tools.rs`、`src-tauri/src/commands/ai_tools.rs`、`src-tauri/src/commands/mod.rs`
- 依赖：STORY-104、STORY-105
- 验证结果：通过 —— `registry_and_tool_catalog_stay_in_sync` 通过（5 个 memory 工具与 catalog/BUILTIN_TOOLS 同步）、授权与预算逻辑随全量 607 通过 / 0 失败；`cargo check --all-targets` exit 0。
- 验收结论：技术验证通过，待用户验收
- 阻塞/下一步：无。
