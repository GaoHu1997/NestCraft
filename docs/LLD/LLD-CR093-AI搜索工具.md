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

### 2.1 本地搜索（fs_grep / fs_glob）
- 遍历：`ignore` crate 的 `WalkBuilder`（ripgrep 同源，尊重 .gitignore、默认跳过隐藏/二进制）；`follow_links(false)` 防符号链接逃逸。
- 内容匹配：`regex` crate（大小写可选）；文件名匹配：`globset`。
- 范围：**项目授权目录**——`setting_default(scope=projectId, key='search.authDirs')` 的 JSON 数组；未授权时返回明确提示。可选 `path` 必须是授权目录内子路径（canonicalize 校验）。
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

### 2.5 设置界面
- 新增「设置 · 搜索」页签（`SettingsSearch.tsx`）：联网后端（默认/Tavily+地址+密钥）、超时、结果数、web_fetch 开关；本地授权目录（按项目选择、调用系统目录选择器添加/移除）。
- 工具分组：`builtinToolCategory` 增加 `search` 组，设置·Tools 显示「搜索」分类。
- 新增 Tauri 命令：`search_auth_dirs_get/set`、`search_config_get/set`（lib.rs 注册）。

## 3. 变更文件

- 新增：`src-tauri/src/commands/search_tools.rs`（工具+配置+密钥+2 组命令+单测）、`src/modules/settings/SettingsSearch.tsx`、`src/modules/settings/settings-search.css`。
- 修改：`Cargo.toml`（ignore/globset/regex/htmd）、`commands/mod.rs`（声明模块）、`ai_tools.rs`（+4 ToolDef、+4 标签、+4 分发、TOOL_COUNT 25→29、同步测试断言）、`capabilities.rs`（BUILTIN_TOOLS 23→27）、`lib.rs`（注册 4 命令）、`src/api/index.ts`（SearchConfig 与 4 个接口）、`settings/index.tsx`（新增「搜索」页签）、`SettingsTool.tsx` + `capabilityHelpers.ts`（搜索分组）。

## 4. 验证方法

- Rust：`cargo test --lib`（含 search_tools 的 URL 白名单/解码/去标签/编码/二进制识别单测 + 既有 registry 同步测试）。
- 前端：`npm run build`（`tsc --noEmit` + vite）。
- 手工：默认无 key 的 web_search、配置 Tavily 后优先与回退、web_fetch 转 Markdown、SSRF 拦截、授权目录内 grep/glob、未授权提示、设置页交互。
- 未验证项如实登记（真实联网抓取受反爬/页面结构影响，需实际网络复验）。

## 5. 未决项、假设与限制

- **假设**：授权目录按项目存储即满足「对话时授权」（会话绑定项目）；如需严格会话级（同一项目多会话不同授权），后续可扩为 session 维度。
- SSRF 仅字面主机/私网黑名单，未做 DNS 解析防重绑定；生产如需可加 `resolve` 校验。
- DuckDuckGo/Bing 结果页解析依赖当前 HTML 结构，随站点改版可能失效，需回归；合规上遵守目标站 ToS 与频率限制（限速需在后续加入）。
- 未实测真实 Tavily/DuckDuckGo/Bing 网络请求与真实 Tauri 窗口视觉；本轮以编译与单测为技术验证基线。
