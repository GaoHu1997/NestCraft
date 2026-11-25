# CR-093：AI 本地与联网搜索工具

- 状态：**已实现（技术验证通过，待用户验收）** — 用户 2026-11-26 明确授权开发并已落地；验证见 [REPORT-CR093](../Test/REPORT-CR093-AI搜索工具验证.md)。
- 来源：用户 2026-11-25 反馈「平台没有提供搜索工具给 AI 使用」，并逐步澄清：本地范围＝**会话授权的若干本地目录/磁盘**；联网优先**可内置、不需要 API key**；不做整机全盘预索引；网页需**解析成 AI 阅读友好正文**；最终选 **S3（默认免 key 抓取 DDG/Bing）+ 设置可配 Tavily 等后端，未配置用默认**。
- 关联：调研 [RESEARCH-009（v3）](../调研/RESEARCH-009-AI本地搜索工具与代码检索.md)；拟建 Feature FEAT-027、Story STORY-110～113。

## 1. 背景与目标

平台给 AI 的 25 个工具（`src-tauri/src/commands/ai_tools.rs:194`）里：本地仅 `fs_read`（读单个项目文件）、`knowledge_search`（只搜知识库）；**没有任何联网搜索/抓取工具**；也没有项目/目录级的内容与文件名检索。AI 想「找一段代码、一个文件、查网上资料」只能逐个猜读，效率低、费 token。

**目标**：为 AI 提供一组「本地 + 联网」搜索工具，开箱免 key 可用、可配置增强，并沿用现有安全与授权模型。

## 2. 范围

### 包含
- 本地搜索工具：`fs_grep`（内容正则检索）、`fs_glob`（文件名/路径匹配），范围＝**会话授权目录白名单**。
- 联网搜索工具：`web_search`（默认免 key 抓 DuckDuckGo，Bing 备用；可配置 Tavily 等后端）、`web_fetch`（抓网页→正文→Markdown）。
- 设置页「搜索」配置：后端选择与地址/密钥、超时、结果上限、本地搜索授权目录管理、工具开关。
- 工具注册与注入：接入平台 runtime 与 CLI workbench MCP（沿用现有机制）。

### 不包含
- 整机全盘预索引、（用户已排除）。
- 随包内置 SearXNG（用户选 S3，不打包 Python 服务）。
- 强制商业搜索 API（默认免 key，商业 API 为可选增强）。
- 修改现有 `fs_read` / `knowledge_search` 的既有行为（新工具与其互补）。

## 3. 功能需求

### 3.1 本地搜索（FR-L）
- **FR-L1 `fs_grep`**：入参 `pattern`（regex）、`path?`（授权目录内子路径）、`glob?`（文件过滤）、`caseSensitive?`、`contextLines?`、`maxResults?`。遍历授权目录（尊重 .gitignore、跳过隐藏/二进制），返回 `文件:行:内容` 列表与命中计数；受结果条数/总字节上限；超大文件跳过。
- **FR-L2 `fs_glob`**：入参 `pattern`（glob）、`path?`、`caseSensitive?`、`maxResults?`。返回匹配的文件相对/绝对路径清单，不读正文。
- **FR-L3 授权目录**：用户按对话/会话授权若干本地目录或磁盘（类似知识库授权的交互）。工具仅在授权目录内搜索；未授权/越界一律拒绝。授权可在会话内设置，支持「记住到项目」（可选）。
- **FR-L4 安全**：canonicalize + 前缀校验防目录穿越与符号链接越界；拒绝读取应用私密数据目录；结果/字节/文件大小上限与二进制跳过。

### 3.2 联网搜索（FR-W）
- **FR-W1 `web_search`**：入参 `query`、`count?`（默认 10，上限可配）、`freshness?`、`site?`、`backend?`。默认后端＝**内置 DuckDuckGo HTML 抓取（Bing 备用）**，免 key；返回 `[{title,url,snippet,source}]`，标注来源与抓取时间。
- **FR-W2 后端可配置**：设置中可添加/选择后端（Tavily 等，填 API base URL + 密钥）。**规则：配置了且可用 → 用配置后端；未配置或失败 → 回退默认 DDG 抓取**，并在结果中提示已回退。后端抽象接口，便于后续加 Exa/Brave。
- **FR-W3 `web_fetch`**：入参 `url`、`format?`（`markdown`/`text`）、`maxChars?`。抓取网页 → 正文提取 → 转 Markdown（AI 友好），超长按 `maxChars` 截断并标注。仅 http/https；非 HTML（如 PDF/二进制）给出明确说明或降级。
- **FR-W4 安全**：限制协议、大小、超时；**拒绝 localhost/私网/内网地址（SSRF 防护）**，可配置白名单；正文清洗去脚本；结果标注为外部数据，不当作指令。

### 3.3 设置与配置（FR-C）
- **FR-C1 搜索设置分组**：联网后端列表（内置 DDG 默认；可加 Tavily 地址/密钥）、默认后端、超时、结果数上限、`web_fetch` 开关。
- **FR-C2 本地授权**：会话/项目级授权目录管理（添加/移除目录、查看当前授权范围）。
- **FR-C3 工具开关**：`fs_grep`/`fs_glob`/`web_search`/`web_fetch` 进入「能力·Tools」注册表（`capabilities.rs` BUILTIN_TOOLS），默认可开关；注册表与工具目录双向校验不漂移。
- **FR-C4 密钥安全**：后端密钥只写入受管密钥存储（沿用现有 keys 机制），不出现在返回值/日志。

### 3.4 机制整合（FR-I）
- **FR-I1**：新工具与现有 `workbench_tools()` 并列注册（工具数 25→29），平台 system prompt/工具列表自动可见。
- **FR-I2**：复用平台已有 `ureq` HTTP 底座（无需新增底层 HTTP 依赖）。
- **FR-I3**：CLI 通道（workbench MCP）与平台 runtime 共用同一实现（沿用 CR-086 统一供给）。

## 4. 技术方案要点（供 LLD 展开，非实现）

- **本地**：新增依赖 `grep`/`ignore`/`globset`（ripgrep 库 crate，`Unlicense OR MIT`）；工具落 `ai_tools.rs`，路径校验复用 `fs.rs`。
- **联网**：`ureq` 抓取 + `scraper`（HTML 解析，MIT）+ `htmd`（HTML→Markdown，Apache-2.0）做正文转换；后端抽象 `trait SearchBackend`（duckduckgo_html 默认 / tavily / 预留）。
- **配置存储**：后端配置与密钥存既有设置/受管密钥体系（参考供应商配置）；授权目录存会话/项目表。
- **工具注册**：`ai_tools.rs` 增 4 个 ToolDef + run_tool 分支；`capabilities.rs` BUILTIN_TOOLS 增 4 项；前端「能力·Tools」「设置·搜索」按既有组件扩展。

## 5. 验收标准（AC）

- **AC-093-01**：未配置任何密钥时，`web_search` 能通过默认抓取返回结构化结果（title/url/snippet）且标注来源。
- **AC-093-02**：在设置填入 Tavily（地址+密钥）后，`web_search` 优先走 Tavily；Tavily 失败时回退默认抓取并提示，不报错中断。
- **AC-093-03**：`web_fetch` 对普通网页返回 AI 友好 Markdown，超长按 `maxChars` 截断并标注。
- **AC-093-04**：`web_fetch`/`web_search` 拒绝 localhost、私网/内网地址（SSRF），协议非 http/https 拒绝。
- **AC-093-05**：`fs_grep` 在授权目录内正确返回 `文件:行:内容`，结果数/字节上限生效，二进制/超大文件跳过。
- **AC-093-06**：`fs_glob` 正确返回匹配路径清单。
- **AC-093-07**：未授权目录、越界路径（`../`、符号链接逃逸）一律拒绝并返回可读错误。
- **AC-093-08**：四个工具在平台 runtime 与 CLI workbench MCP 均可见、可调用；可在「能力·Tools」启停。
- **AC-093-09**：设置页可管理联网后端（默认/自定义地址密钥）、超时、结果数、本地授权目录。
- **AC-093-10**：密钥不出现在工具返回值、日志或错误信息中。

## 6. 未决问题

1. 本地授权目录是「会话级一次性」还是「记住到项目」？默认建议：会话级 + 可勾选记住。
2. 默认抓取是否同时启用 Bing 备用（增加一次请求）？建议：DDG 失败再走 Bing。
3. 后端清单首期是否只做 Tavily，还是同时预留 Exa/Brave 配置项（不做实现）？建议：只做 Tavily + 预留扩展位。
4. 抓取公共引擎的 ToS/频率限制提示文案与限流阈值需确定。

## 7. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-25 | 建立 CR-093；依据用户四点决策与 S3 选择形成需求与方案骨架，状态待确认，未实现。 |
| 2026-11-26 | 用户授权开发；实现 4 个内置工具、设置·搜索页、授权目录与联网后端配置；技术验证通过（cargo test 603/0/11、npm build exit 0），状态改为已实现待验收。 |
