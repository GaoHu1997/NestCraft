# LLD-CR095：平台提示分层实现（P0）

- 归属 [CR-095](../PRD/CR-095-平台提示分层与工具按需.md)／[FEAT-025](../Plan/Feature/FEAT-025-平台主代理运行时.md)。状态：已实现。

## 1. 改动点

| 文件 | 改动 |
| --- | --- |
| `commands/tool_groups.rs`（新） | `TOOL_GROUPS`（core/knowledge/files/project/memory/search/server/media/panel）、`default_group_ids(kind)`、`groups_for(kind)`、`allowed_tool_names(kind)` |
| `commands/mod.rs` | `pub mod tool_groups;` |
| `commands/platform_agent.rs` | 新增 `platform_tool_defs_scoped(conn, project_id)`：按 `project.type` 过滤默认组 + MCP 仍全给；生产两处调用点（主请求、tool loop 重算）改用 scoped；旧 `platform_tool_defs` 保留全量。`is_side_effect_tool` 增 `memory_save` |
| `commands/platform_context_runtime.rs` | `Prepared` 删 `memory_context`、增 `project_kind`/`profile_line`；`load` 查 `project.type` 与 `build_profile_line`；`system()` 重写（角色+一行画像+默认组目录+技能+指引，去 TopK 注入） |
| `commands/memory.rs` | 新增 `build_profile_line(conn, scope)`（≤120 字）；`build_memory_context*` 保留但不再用于注入 |
| `commands/platform_context_agent_tests.rs`、`platform_agent.rs`(tests) | 两处测试改用默认组内工具（`get_context`/`memory_save`），保持原验证意图 |

## 2. 默认工具组

- code：core, knowledge, files, project, memory, search, server
- work：core, knowledge, files, project, memory, search, panel, media
- 未绑定：core, knowledge, memory, search

## 3. 系统提示结构

```
PLATFORM_SYSTEM_PROMPT + CONTEXT_PROMPT
当前项目 / 执行特性
你正在协助{编码/办公/未绑定助理}。
用户画像（简）：<≤120 字>（详细用 profile_get）
本次可用工具组（组内工具可直接调用；未列出不可用）：
- 组label：工具名, 工具名…
可用技能（正文按需 read_skill）：名称：描述…
使用指引：memory_search / profile_get / 知识库工具 / 不猜编号、不写未确认事实
```

## 4. 边界与回退

- 未改工具实现、授权、memory 表结构、CLI 通道。
- 回退：把两处 `platform_tool_defs_scoped` 调用换回 `platform_tool_defs`（全量）即可恢复旧行为；`platform_tool_defs` 仍在。
- 未做 P1：`enable_tool_group` 动态加载（需会话态与工具装配扩展），列为后续。

## 5. 验证

见 [REPORT-CR095](../Test/REPORT-CR095-平台提示分层验证.md)：`cargo test --lib` 607/0/11、`cargo check --all-targets` exit 0。
