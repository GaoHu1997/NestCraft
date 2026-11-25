# LLD-CR086：平台能力统一供给实现方案

- 关联：[CR-086](../PRD/CR-086-平台能力统一供给.md)、[FEAT-025](../Plan/Feature/FEAT-025-平台主代理运行时.md)、[STORY-089](../Plan/Story/STORY-089-平台主代理会话与模型调用.md)
- 覆盖 AC：AC-CR086-01～06
- 状态：**已实现，技术验证通过，待验收**

## 1. 现状与断点

| 能力 | 现状 | 断点 |
| --- | --- | --- |
| Tool | `platform_tool_defs` 用 `PLATFORM_TOOL_ALLOWLIST`（13 项）过滤 | 生图、建项目、建知识库、存服务器、派发被排除；模型看不到 |
| Skill | CLI 仅 `--add-dir`；平台 system 无技能 | 两边都无法按需读正文 |
| MCP | CLI 经 `mcp_servers` 注入；平台无客户端调用 | 平台完全不能用用户配置的 MCP |

## 2. 选定方案

### 2.1 工具形态统一

`ai_tools::ToolDef` 的名称是 `&'static str`，无法承载动态 MCP 工具名。平台侧新增：

```rust
pub(crate) struct PlatformTool { name: String, description: String, schema: Value }
impl From<ai_tools::ToolDef> for PlatformTool { ... }
```

`build_platform_body` / `budgeted_body` / `request_model_captured` / `request_model` / `platform_context_runtime::prepare` 统一改用 `&[PlatformTool]`；`ai_tools.rs` 不动。

### 2.2 平台工具 = 目录 ∩ 启用 + MCP + 技能

```rust
fn platform_tool_defs(conn) -> Vec<PlatformTool> {
    if !business_tools_enabled(conn) { return vec![]; }
    workbench_tools().filter(enabled).map(PlatformTool::from)
      + mcp_cached_tools(conn)  // 名称 mcp__<server>__<tool>
}
```

- 可见性判定改为「本轮下发的 `defs` 是否包含该名称」，不再查白名单。
- `enabled` 判定：内置工具查 `capability`，MCP 工具查发现缓存，二者之外一律拒绝。
- `PLATFORM_TOOL_ALLOWLIST` 保留为历史基线常量（`#[allow(dead_code)]`），仅供旧测试追溯。

### 2.3 技能统一

- `capabilities::read_skill_text(conn, name)`：查 `capability(kind='skill')`，校验启用、`sourceRef` 规范化后必须位于 `storage_layout::category("skills")` 之内，正文 ≤256KB。
- `ai_tools` 新增第 23 个工具 `read_skill`（`workbench.read_skill`）：无 `name` 返回技能清单，有 `name` 返回正文。CLI 经 workbench MCP 直接可用。
- 平台系统提示由 `Prepared::system()` 追加「可用技能」列表（名称 + 描述截断 240 字），正文仍按需读取，避免长技能撑爆上下文。

### 2.4 MCP 接入

- 工具定义：读 `mcp_server.toolsJson`（发现缓存），不启动进程；`McpToolInfo` 增加 `input_schema`（`#[serde(default)]`，兼容旧缓存），无 schema 时给宽松对象。
- 调用：`capabilities::mcp_call_tool(app, server_id, tool, args)`
  - stdio：启动独立短会话 → `initialize` → `notifications/initialized` → `tools/call` → 读响应 → 结束进程；单次 120s 超时。
  - http：复用 `mcp_http_agent` / `mcp_http_rpc` / `mcp_http_bearer`，沿用 `Mcp-Session-Id`。
  - 结果提取：`content[].text` 拼接，否则返回 result JSON。
- 循环路由：名称能回解到缓存 MCP 工具的，走 MCP 调用；否则走内置 `run_tool`。失败以 `ToolOutcome{is_error:true}` 回填。
- `AppHandle` 在 `send_platform` 的 spawn 前克隆传入；测试路径传 `None`，MCP 调用返回「当前运行环境不支持」而不是 panic。

### 2.5 名称与冲突

`mcp__<server>__<tool>`，server 名仅保留 ASCII 字母数字、`_`、`-`，其余替换为 `_`。回解时按同一函数重算并比对，避免名称歧义。

## 3. 影响面

- 受影响文件：`models.rs`、`capabilities.rs`、`ai_tools.rs`、`platform_agent.rs`、`platform_context_runtime.rs`、`platform_context_agent_tests.rs`、`src/modules/chat/sessionRuntime.ts`（工具中文名）。
- 平台会话可见工具由 13 项变为 23 项（含写类）；`aiTools.enabled` 与单工具停用仍然是硬闸。
- CLI 工具数 22 → 23；MCP 注入格式不变。
- 数据库无结构变更；`mcp_server.toolsJson` 只是序列化字段扩展，旧数据向后兼容。

## 4. 测试

| 用例 | 期望 |
| --- | --- |
| `cr086_tool_defs_cover_full_catalog_and_read_skill` | 含 `generate_image`、`create_project`、`read_skill`；停用单个工具后消失，其余不受影响 |
| `cr086_mcp_tool_names_are_namespaced` | 空格转 `_`、连字符保留 |
| `registry_and_tool_catalog_stay_in_sync` | 能力注册表与工具目录 23 项一一对应 |
| `t090_02_allowlist_excludes_forbidden_tools` | 历史常量不变 |
| 既有 platform/context 测试 | 全量通过，不改语义 |

## 5. 未决与风险

1. MCP 工具依赖「发现缓存」：未在设置里发现过的服务器在平台通道不可见（已登记，避免每轮启动进程）。
2. HTTP MCP 需要有效凭据；凭据失效时表现为工具错误，不影响整轮。
3. 平台现在可调用写类工具，风险由 `aiTools.enabled`、单工具停用与各工具自身校验承担；`ssh_exec` 仍走既有审批门禁。
