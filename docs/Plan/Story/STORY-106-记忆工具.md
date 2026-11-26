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

## MEM-FIX-001 现行修复（2026-11-26）

- 归属仍唯一FEAT-026，状态：本轮源码修复与技术验证完成，待真实便携版验收，历史完成声称不覆盖此次缺口。
- 本次义务：[修复方案](../../LLD/LLD-FEAT-026-记忆范围与落盘修复.md) MEM-01～MEM-07，实际结果以[修复报告](../../Test/REPORT-MEMFIX001-记忆范围与落盘修复.md)为准。
- 用户决定：个人通用(global)／项目隔离(project:<id>)，个人需要进入个人记忆库。不得默认全scope给AI。
- 实现：分类路由与可信ctx；个人文件和索引镜像；三页签单scope和编辑/删除同步；既有project记录不自动提升个人。
- UI准入（109适用）：UI-FEAT-026-v2，唯一入口 memory-scopes，设计先于代码；UI-SCROLL-001 v1 700ms沿用列表/画像/textarea。设计与实际组件截图均已查看；整个壳层/真实WebView2像素一致不作通过。
