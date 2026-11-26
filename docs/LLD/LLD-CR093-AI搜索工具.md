# LLD-CR093：AI 本地与联网搜索工具实现方案

- 关联需求：[CR-093](../PRD/CR-093-AI本地与联网搜索工具.md)；调研 [RESEARCH-009](../调研/RESEARCH-009-AI本地搜索工具与代码检索.md)。拟建 FEAT-027 / STORY-110～113。
- 本次实现范围：4 个内置 AI 工具（fs_grep / fs_glob / web_search / web_fetch）、授权目录与联网后端配置、设置·搜索界面、安全防护。用户 2026-11-25 明确授权开发。

## 1. 现状与复用点

- 工具目录 `src-tauri/src/commands/ai_tools.rs`（`workbench_tools()`，25→29 项）；平台 runtime（`platform_agent.rs`）与 CLI 的 `workbench` MCP 都经 `run_tool` 分发，**实现一次即两端共用**（沿用 CR-086）。
- 路径安全复用 `src-tauri/src/commands/fs.rs` 的 `ensure_under`（canonicalize + 前缀校验）。
- HTTP 底座复用现有 `ureq`（更新/MCP/模型探测/天气/生图均在用），不新增底层 HTTP 依赖。
- 配置存 `setting_default`（scope/key/value）；密钥存 `data_dir/secrets/search.json`（受管密钥文件，不进 setting_default、不进日志）。
- 内置工具注册表 `capabilities.rs` `BUILTIN_TOOLS`（23→27），设置·Tools 按 registry_id 启停。

## 2. 选定方案

### 2.1 本地搜索（fs_grep / fs_glob）——CR-104 会话级授权

- 遍历：`ignore` crate 的 `WalkBuilder`（ripgrep 同源，尊重 .gitignore、默认跳过隐藏/二进制）；`follow_links(false)` 防符号链接逃逸。
- 内容匹配：`regex` crate（大小写可选）；文件名匹配：`globset`。
- **默认范围＝会话绑定项目的根目录**（`project.rootUri` canonical），无需任何前置授权；会话额外目录存在 `setting_default(scope='session:<sessionId>', key='search.extraDirs')`，仅本会话有效。
- **权限档位收紧**：会话 `permissionMode='plan'` 时只保留项目根，额外目录不生效；`default/agent/auto/full` 使用项目根 + 额外目录。档位随 `session.permissionMode` 持久化（CR-104）。
- 越界：`path` 为绝对路径且不在任何可用根内，返回「搜索范围外」错误并指向 AI 侧栏「搜索授权」；相对路径相对项目根解析，`..`/符号链接经 canonicalize + `starts_with` 前缀校验拒绝。
- 结果附带 `searchRoots`（实际搜索根），便于模型与用户核对范围。
- 上限：单文件 ≤ 4 MiB、结果数上限（grep 默认 200/上限 1000；glob 默认 500/上限 5000）、二进制跳过（首 8KB 含 NUL 判定）。

### 2.2 联网搜索（web_search）
- 后端默认 `default`：抓 `html.duckduckgo.com/html/` 解析结果（`result__a`/`result__snippet`），失败回退 Bing（`b_algo`）。
- 可选 `tavily`：POST `{base}/search`（配置地址+密钥）；无密钥或失败 → 回退默认并在结果 `note` 提示。
- 结果结构 `{results:[{title,url,snippet,source}], backend, note, fetchedAt}`；结果标注为外部数据。
- 配置键：`search.web.backend`、`search.web.tavily.baseUrl`、`search.web.timeoutSec`、`search.web.maxResults`、`search.webFetch.enabled`；Tavily 密钥存 `secrets/search.json`（键 `search.tavily`）。

### 2.3 网页抓取（web_fetch）
- `ureq` 抓取（限时、限 8 MiB）；`content-type` 为 html 或正文以 `<` 开头时用 `htmd` 转 Markdown；文本/JSON 直出；其它类型报不支持。
- `maxChars`（默认 20000，上限 200000）截断并标注 `truncated`。

### 2.4 安全
- SSRF：仅 http/https；拒绝 `localhost`/`.local`/`0.0.0.0`/`::1` 及字面 IPv4 私网（127/10/192.168/172.16-31/169.254/0）。**未做 DNS 解析防重绑定**（限制见 §5）。
- 本地路径：只在授权目录内遍历；`path` 子路径 canonicalize 校验；不读应用数据目录（工具默认不指向）。
- 密钥：只写入受管密钥文件；`search_config_get` 只返回 `hasTavilyKey` 布尔，不返回明文；不写日志。

### 2.5 设置界面与入口（CR-104）
- 「设置 · 搜索」页签只保留联网配置：后端（默认/Tavily+地址+密钥）、超时、结果数、web_fetch 开关；删除「本地搜索授权目录」整卡，底部一行说明指向会话授权入口。
- AI 侧栏输入框「+」菜单 →「指令」新增「搜索授权」，打开会话级授权弹窗（`SessionSearchGrant.tsx`）：项目根只读展示、额外目录列表、添加（系统目录选择器）/移除、空态与规划模式提示。
- 工具分组：`builtinToolCategory` 保留 `search` 组，设置·Tools 显示「搜索」分类。
- Tauri 命令：`search_session_scope_get`、`search_session_dirs_add`、`search_session_dirs_remove`、`search_config_get/set`、`chat_session_set_permission`（lib.rs 注册）。

## 3. 变更文件

- 新增：`src-tauri/src/commands/search_tools.rs`（工具+配置+密钥+2 组命令+单测）、`src/modules/settings/SettingsSearch.tsx`、`src/modules/settings/settings-search.css`。
- 修改：`Cargo.toml`（ignore/globset/regex/htmd）、`commands/mod.rs`（声明模块）、`ai_tools.rs`（+4 ToolDef、+4 标签、+4 分发、TOOL_COUNT 25→29、同步测试断言）、`capabilities.rs`（BUILTIN_TOOLS 23→27）、`lib.rs`（注册 4 命令）、`src/api/index.ts`（SearchConfig 与 4 个接口）、`settings/index.tsx`（新增「搜索」页签）、`SettingsTool.tsx` + `capabilityHelpers.ts`（搜索分组）。

### 3.1 CR-104 变更文件

- 新增：`src/modules/chat/SessionSearchGrant.tsx`、`src/modules/chat/session-search-grant.css`。
- 修改：`search_tools.rs`（`search_roots`/`start_under_root`/会话授权命令、规划模式收紧、`searchRoots` 结果）、`ai_tools.rs`（`ToolContext.session_id`、`--session-id`）、`dispatch.rs`（MCP 行传 `--session-id`）、`platform_agent.rs`（平台 ctx 带会话 id）、`db.rs`（`session.permissionMode` + 迁移）、`chat.rs`（列序、`chat_session_set_permission`、发送时持久化档位）、`models.rs`、`lib.rs`（命令注册）、`src/api/index.ts`、`src/modules/settings/SettingsSearch.tsx`（删授权卡片）、`src/modules/chat/ChatPanel.tsx`、`src/modules/chat/Composer.tsx`。

## 4. 验证方法

- Rust：`cargo test --lib`（含 search_tools 的 URL 白名单/解码/去标签/编码/二进制识别单测 + 既有 registry 同步测试）。
- 前端：`npm run build`（`tsc --noEmit` + vite）。
- 手工：默认无 key 的 web_search、配置 Tavily 后优先与回退、web_fetch 转 Markdown、SSRF 拦截、授权目录内 grep/glob、未授权提示、设置页交互。
- 未验证项如实登记（真实联网抓取受反爬/页面结构影响，需实际网络复验）。

## 5. 未决项、假设与限制

- **CR-104 已取代原假设**：授权改为会话级——默认项目根、额外目录按 `session:<id>` 存储，规划模式只保留项目根；原「按项目存储即等价对话时授权」不再成立。
- 会话权限档位目前只在前端显式选择/发送时写入 `session.permissionMode`；平台助理权限（readonly/limited/full）尚未持久化到同一字段，后续统一时需补迁移与 UI 证据。
- SSRF 仅字面主机/私网黑名单，未做 DNS 解析防重绑定；生产如需可加 `resolve` 校验。
- DuckDuckGo/Bing 结果页解析依赖当前 HTML 结构，随站点改版可能失效，需回归；合规上遵守目标站 ToS 与频率限制（限速需在后续加入）。
- 未实测真实 Tavily/DuckDuckGo/Bing 网络请求与真实 Tauri 窗口视觉；本轮以编译与单测为技术验证基线。

### 6.1 变更记录（CR-104）

| 日期 | 变更 |
| --- | --- |
| 2026-11-26 | 本地搜索授权由「按项目白名单」改为「会话默认项目根 + 会话额外目录 + 规划模式收紧」；设置页删除授权卡片；新增 AI 侧栏搜索授权弹窗与 `session.permissionMode` 持久化。 |

