# RESEARCH-009：AI 可用的搜索工具（本地全量 + 联网 Web 搜索）调研

- 日期：2026-11-25；负责人：lead；来源：用户反馈「平台好像没有提供本地搜索工具给 AI 使用，看看 GitHub 上有没有可以内置到平台、给 AI 使用的」，并追加澄清「除了本地所有，还有联网所有，web 搜索」。
- **v2 修订说明**：v1 只覆盖「当前项目目录的 grep/glob」，方向过窄，已作废。v2 按用户澄清扩展为两类：**本地所有内容搜索 + 联网 Web 搜索（含网页抓取）**。
- **v3 决策更新（2026-11-25）**：用户确认四点——① 本地范围＝**用户授权的若干本地目录/磁盘**，且**按对话/会话时授权**；② 联网搜索优先**可内置、不需要 API key**；③ 不做预建全盘索引（按授权目录实时搜索）；④ 网页需**解析为 AI 阅读友好的正文**。据此定稿见 §8。
- 方法：核查本仓库现有工具目录、依赖与本地数据域；直读候选项目 GitHub 元数据、README/许可；未克隆、未编译、未运行、未接入正式依赖。web_search 因 HTTP402 不可用，改用 GitHub API / raw 文件直读。
- 关联：沿用 [RESEARCH-005](RESEARCH-005-大规模检索开源实现与性能取舍.md) 对 ripgrep／Tantivy／Zoekt 的既有判断。
- 本文为调研结论，不是需求基线，也不构成编码授权；正式开发须另立 PRD／Story 并取得明确编码授权。

## 1. 结论先行

1. **用户判断成立且范围更宽**：平台给 AI 的 25 个工具里（`src-tauri/src/commands/ai_tools.rs:194`）**没有任何联网搜索/抓取工具**；本地侧只有 `fs_read`（读单个项目文件）与 `knowledge_search`（只搜已授权知识库），**没有项目级内容/文件名检索，也没有跨目录/全盘的本地搜索**。
2. **联网 Web 搜索不必引入第三方 MCP server，可直接内置**：平台已有 `ureq` HTTP 客户端（用于更新、MCP HTTP、模型探测、天气、生图等），实现 `web_search`（调搜索 API）与 `web_fetch`（抓网页正文）**无需新增底层 HTTP 依赖**。Tavily/Exa/Brave 的官方「搜索 MCP」本质是轻量 API 包装（MIT，TS），可只借鉴其工具契约，不必落地其运行时。
3. **本地搜索按数据域统一为一个能力组**：项目文件/代码用 ripgrep 库 crate（`grep`/`ignore`/`globset`，MIT/Unlicense）；知识库沿用现有 `knowledge_search`（Tantivy）；办公文件/PDF 复用平台已有预览运行时提取正文；「全盘/任意目录」快速查找在 Windows 可用 Everything SDK（闭源免费，MFT 索引）或自建轻量索引。
4. **推荐把「搜索」做成平台级可配置能力**：联网搜索后端可插拔（Tavily / Exa / Brave / SearXNG / DuckDuckGo 降级），本地搜索范围可配置（项目根 / 用户授权目录 / 全盘索引），与现有「模型供应商」配置思路一致。

## 2. 现状核查（本仓库事实）

- 工具目录：`ai_tools.rs:194` `workbench_tools()`，`TOOL_COUNT = 25`（`ai_tools.rs:192`）。**无 `web_search` / `web_fetch` / `grep` / `glob` / `find` / 全盘搜索**。
- 本地相关：
  - `fs_read`（`ai_tools.rs:379`）：单文件只读，相对项目根，>1 MiB 拒绝。
  - `knowledge_search` / `knowledge_read`（`ai_tools.rs:402`）：仅已授权知识库内检索（Tantivy）。
- 联网能力底座（`src-tauri` 已用 `ureq`）：`updater.rs`、`capabilities.rs`（MCP HTTP）、`model_probe.rs`、`providers.rs`、`weather.rs`（Open-Meteo）、`image_gen.rs`。**HTTP 能力齐备，缺的是「搜索工具」本身**。
- 依赖（`Cargo.toml`）：`walkdir`、`tantivy = 0.26.0`、`ureq`、`pdfjs-dist`（前端）、Office 转换运行时。无 `grep`/`ignore`/`globset` 直接依赖。
- 本地数据域：项目文件（`fs.rs` 管）、知识库（`knowledge.rs`）、办公文件（预览）、需求文档（`requirements`）、会话历史（标题搜索）。各域检索能力分散，**没有统一的「本地搜索」工具面**。

## 3. 候选对比

### 3.1 联网 Web 搜索 / 抓取

| 候选 | 形态 | 许可证 | 需要 Key/服务 | 与平台契合度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Tavily**（tavily-ai/tavily-mcp） | 商业 API（官方 MCP 为 MIT 包装，search/extract/map/crawl） | MIT（MCP 包装） | 需 Tavily API key + 额度 | ★★★★★ AI 优化结果、自带正文提取；平台 ureq 直连即可 | **首选后端之一** |
| **Exa**（exa-labs/exa-mcp-server） | 商业 API（MIT 包装，web search + crawl） | MIT | 需 Exa API key | ★★★★ 语义/神经搜索强 | 备选后端 |
| **Brave Search**（brave/brave-search-mcp-server） | 商业 API（MIT 包装） | MIT | 需 Brave Search API key | ★★★★ 独立索引、隐私友好 | 备选后端 |
| **SearXNG**（searxng/searxng） | 自建/公共元搜索引擎，JSON API | **AGPL-3.0**（Python 服务） | 自建或公共实例，无商业 key | ★★★ 免费、聚合多引擎；但公共实例不稳定、自建要 Python 服务 | 可选（自建/自托管时） |
| DuckDuckGo（HTML/Instant） | 免 key 抓取 | 网站条款 | 无 key（易限流） | ★★ 可作无 key 降级 | 降级兜底 |
| **MCP fetch server**（modelcontextprotocol/servers，含 fetch） | MCP 参考实现，网页抓取→正文 | 仓库 NOASSERTION（分目录许可，fetch 通常 MIT） | 无 | ★★★★ 抓取正文思路可借鉴 | 借鉴 `web_fetch` 设计 |

> 结论：**联网搜索首选「平台内置 `web_search` + `web_fetch`，后端可配置」**。默认后端可预置一个（如 Tavily 或 Brave），无 key/失败时降级 DuckDuckGo 或明确提示；SearXNG 作为「自托管/高级」选项（AGPL 只约束其自身服务，平台只是通过 HTTP 调用其 JSON 接口，不作为平台内嵌代码分发）。

### 3.2 本地搜索（本地所有内容）

| 候选 | 形态 | 许可证 | 平台适配 | 结论 |
| --- | --- | --- | --- | --- |
| **ripgrep 库 crate**（`grep`/`ignore`/`globset`/`regex`） | Rust 库，编译进应用 | MIT OR Unlicense | ★★★★★ 内容检索 + 文件名 glob；纯 Rust、跨平台、复用现有路径安全 | **本地内容检索首选** |
| **Everything**（voidtools） | Windows 闭源免费 + SDK DLL | 闭源（免费使用 SDK） | ★★★★ 全盘文件名秒级（NTFS MFT）；但依赖 Windows、闭源 DLL、x64/arm64 | 全盘文件名搜索（Windows）可选 |
| **fsearch**（cboxdoerfer/fsearch） | C/GTK3，文件名索引 | GPL-2.0 | ★★ Unix/Linux only，GPL 不利闭源内嵌 | 仅机制参考，不内嵌 |
| **Recoll** | C++/Xapian 全文索引（跨平台开源） | GPL-2.0 | ★★ 全文索引较重、GPL | 仅机制参考 |
| **fd** | Rust CLI | MIT/Apache | ★★★ 文件查找；仅需 `globset`+`walkdir` 自足 | 参考交互，不作依赖 |
| **Zoekt** | Go 服务，trigram 索引 | Apache-2.0 | ★★ 大规模多仓库索引，索引 3～3.5× | 大规模代码索引可选（见 RESEARCH-005） |
| **Tantivy** | Rust 库 | MIT | ★★ 已用于知识库排名检索 | 维持知识库用途 |
| 平台已有 Office/PDF 预览运行时 | 本机转换 + pdf.js | 沿用 | ★★★★ 可提取正文做「本地文档搜索」 | 复用，不新增选型 |

> 结论：**本地内容检索用 ripgrep 库 crate**；**全盘文件名快速搜索**在 Windows 优先评估 Everything SDK，跨平台则用「walkdir 扫描 + 持久索引缓存」的轻量自建；知识库/办公文档复用现有运行时与 `knowledge_search`。

## 4. 推荐方案（供评审，非实现）

### 4.1 目标：「搜索」成为平台级工具组

统一暴露一组 AI 可调用工具，覆盖本地 + 联网：

- **联网**
  - `web_search(query, count?, freshness?, backend?)`：调可配置搜索后端，返回标题/URL/摘要/时间，可选正文片段。
  - `web_fetch(url, format?)`：抓取网页并转正文（HTML→text/markdown），复用 `ureq`；可接 Jina Reader 做远程转换或本地清洗。
- **本地**（范围可配置）
  - `fs_grep(pattern, path?, glob?, projectId?, maxResults?)`：目录/项目内正则内容检索（ripgrep `grep`+`ignore` 库）。
  - `fs_glob(pattern, path?, projectId?, maxResults?)`：文件名/路径匹配（`globset`+`ignore`）。
  - `local_find(query, roots?)`（可选，全盘/多目录）：Everything SDK（Windows）或自建索引，返回路径清单。
  - 复用 `knowledge_search`（知识库）、办公/PDF 正文提取后纳入本地检索。
- **统一「搜索设置」**：联网后端 + API key + 预算/超时 + 结果上限；本地搜索根（项目根 / 用户授权目录列表 / 全盘开关）+ 忽略规则 + 索引开关。与「模型供应商」配置页同构。

### 4.2 安全与边界（重要）

- `fs_read` 现限定「项目根内、防穿越、大小上限」。扩展到多目录/全盘时，必须新增**显式授权目录白名单**，禁止默认扫全盘、禁止读应用私密数据目录（参考 `platform_agent.rs` 对数据目录的保护），并对结果做条数/字节/文件大小上限与二进制跳过。
- `web_fetch` 需限制协议（http/https）、大小、超时，防 SSRF/内网探测（拒绝 localhost/私网地址，除非用户显式允许）；正文清洗防脚本注入。
- 联网搜索涉及外部 API 与费用：默认关闭或需用户填 key；结果标注来源与外部数据属性，不把网页当指令（沿用 host 的 untrusted 处理）。

### 4.3 与现有能力的关系

- 平台已有 MCP 通道（CR-086），可把第三方搜索 MCP server 作为「用户自配」能力；但**平台内置**应优先用原生 `ureq` 直连，避免额外运行时与信任面。
- 知识库检索（Tantivy）、项目文件 `fs_read` 保留，新增工具与它们互补，不重复。

## 5. 许可证与分发

- 联网：Tavily/Exa/Brave 的 MCP 均为 **MIT**（仅借鉴工具契约，不复制其 TS 运行时）；SearXNG **AGPL-3.0**（若自建服务，独立进程经 HTTP 调用，不分发其代码即不传染平台；需在文档注明）。MCP fetch server 许可按目录核（fetch 通常 MIT）。
- 本地：ripgrep **MIT/Unlicense**；Everything SDK **闭源免费**（按其 SDK 条款，注意再分发限制）；fsearch/Recoll **GPL**（不作内嵌）。
- 所有实际引入版本须实现前固定并核验传递依赖，保留版权/许可声明（参照 `src-tauri/third-party/` 机制）。

## 6. 未验证与限制

- 本轮**未克隆、未编译、未运行**任何候选；性能、体积、Windows/Tauri 兼容性均未实测。
- 各商业搜索 API 的价格、额度、结果质量、地区可用性未核验；SearXNG 公共实例稳定性与 JSON API 政策未实测。
- Everything SDK 的闭源 DLL 分发/架构适配、以及「全盘索引」的隐私与性能未评估。
- 本地搜索扩展到项目根之外的安全模型（授权目录、SSRF/穿越防护）需在 LLD 中逐项定义并测试。

## 7. 决策点（需用户确认）

1. **「本地所有」的范围**：A) 平台内各数据域（项目/知识库/办公/需求/会话）；B) 用户显式授权的若干本地目录/磁盘；C) 整机全盘（Windows 走 Everything SDK，跨平台自建索引）。可组合。
2. **联网搜索后端**：默认预置哪一个（Tavily / Exa / Brave），还是先做「可配置 + 无 key 降级 DuckDuckGo」？
3. **是否要全盘/多目录索引**（`local_find`），还是先做「项目/授权目录」的 grep/glob。
4. 是否接受新增 `html2text`/`readability` 类正文提取依赖，或改用远程 Jina Reader 减少本地依赖。

## 8. v3 决策定稿与「免 API」联网方案（2026-11-25）

### 8.1 四点已定

- **本地范围**：用户授权的若干本地目录/磁盘；**按对话/会话授权**，不预建整机索引。实现为「会话级授权目录白名单 + 实时遍历检索」，复用 `fs_read` 的 canonicalize 防穿越、大小/结果上限；无需 Everything 全盘索引。
- **不做**：整机全盘预索引、`local_find` 常驻索引（用户第 3 点已排除）。
- **网页解析**：`web_fetch` 输出 AI 阅读友好的 Markdown/纯文本。

### 8.2 「不需要 API key、可内置」的联网搜索候选（用户第 2 点）

| 方式 | 代表 | 免 key | 形态/可内置性 | 许可 | 稳定性/风险 |
| --- | --- | --- | --- | --- | --- |
| **抓公共搜索引擎结果页** | DuckDuckGo `html.duckduckgo.com/html/`（主）、Bing、Mojeek | 是 | 纯 Rust：`ureq` 抓 HTML + `scraper` 解析 + `htmd` 转正文；**可编译进 Tauri** | 站点内容/ToS；无代码许可问题 | 中低：页面结构变化、反爬、限流、可能验证码；需 UA/限速/失败降级 |
| **免 key 元搜索库** | deedy5/ddgs（聚合 DDG/Bing/等多源） | 是 | Python 库 | MIT | 需 Python 运行时，不能直接编译进 Tauri；可借鉴其多源与降级策略 |
| **自托管元搜索** | SearXNG | 是 | Python 服务，需单独部署 | AGPL-3.0 | 中高（自建可控），但需运行环境；平台经 HTTP JSON 调用 |
| **自托管元搜索** | benbusby/whoogle-search | 是 | Python 自托管 | MIT | **仓库已 archived（停止维护）**，不宜作为长期依赖 |
| **开放索引 API** | MarginaliaSearch（`api.marginalia.nu`） | 是 | HTTP JSON | NOASSERTION（源码） | 覆盖偏小众文本站，通用性低 |
| **百科 API** | Wikipedia / Wikidata | 是 | HTTP JSON | CC/自由 | 仅百科域，非通用 Web |
| 官方搜索 API（对照） | Tavily / Exa / Brave | **需 key** | HTTP JSON | MIT 包装 | 高稳定，但违背「不需要 API」 |

**结论**：真正「免 key 且能编译进 Tauri」的通用 Web 搜索，现实可行的是**抓取公共搜索引擎结果页**（首选 DuckDuckGo HTML，Bing 备用），用 `ureq`+`scraper`+`htmd` 在 Rust 侧实现。代价是稳定性/合规风险（结构变化、反爬、ToS），必须做限速、UA、失败降级与「结果标注来源」。因此推荐：**默认内置免 key 抓取 + 设置里可切换自建 SearXNG 地址或官方 API key 作增强**，既满足「开箱不用配」，又留稳定通道。

### 8.3 定稿方案骨架（供评审，非实现）

- 联网：`web_search`（默认 DDG HTML 抓取，Bing 备用，可选 SearXNG/官方 API）+ `web_fetch`（`ureq` 抓取 → 正文提取 → `htmd` 转 Markdown）。`htmd` 为 Apache-2.0、Rust、2026-11 活跃、千万级下载，适合作正文转换。
- 本地：`fs_grep` + `fs_glob`（ripgrep 库 crate：`grep`/`ignore`/`globset`），范围＝会话授权目录白名单，实时遍历，不建索引。
- 复用：知识库 `knowledge_search`；办公/PDF 现有预览运行时提取正文后可纳入 `fs_grep` 范围。
- 安全：授权目录 canonicalize 白名单；`web_fetch` 限制 http/https、大小、超时，拒绝内网/私网地址（防 SSRF），正文清洗。
- 新的待确认：是否接受「抓取公共搜索引擎」作为免 key 默认（有 ToS/稳定性风险）；`htmd` 正文转换是否接受新增该 Rust 依赖。

## 9. SearXNG 能否内置到平台（2026-11-25 追问）

**事实（已读官方文档，版本 2026.11.23）**：SearXNG 是 Python 应用，官方部署方式为 Docker 容器 / 安装脚本 / 源码 step-by-step（uWSGI 或 Granian）；无官方独立可执行文件。搜索 JSON 需在 `settings.yml` 的 `search:` 段启用 `format: json`，否则请求返回 403，且「许多公共实例已禁用这些格式」。

**「内置」的两种含义**：
1. 编译进同一 Rust 二进制 —— **不可能**（SearXNG 是 Python/Flask，非 Rust 库）。
2. 随安装包整体分发、并在本机自动拉起一个 SearXNG 服务，平台通过本地 HTTP `format=json` 调用 —— **技术上可行**，但代价大。

**可行路径（真·随包内置，方案 S1）**：用 Tauri 2 的 `externalBin`（sidecar）机制打包一个「SearXNG 单文件可执行」——用 PyInstaller / PyOxidizer 或 embedded Python 把 SearXNG + uWSGI/Granian + 模板/静态资源 + 预置 `settings.yml`（启用 json）打成每平台 sidecar；应用启动时 spawn，监听 `127.0.0.1` 随机端口，平台用 `ureq` 调 `/search?format=json`。

**代价（需产品承担）**：
- 体积：Python 运行时 + 依赖（lxml/flask/pyyaml 等）+ SearXNG ≈ 数百 MB，且需为 Windows/macOS/Linux 各打一套、各架构（x64/arm64）。
- 工程：子进程生命周期、端口、配置、HTTPS/limiter/captcha、首次启动解包与升级；PyInstaller 打包 Flask 模板/静态资源易漏。
- **许可（AGPL-3.0）**：随包**分发** SearXNG（尤其修改版）须提供对应源码、许可声明，并允许用户替换；若只是「用户自建实例、平台填地址调用」，平台不构成分发，义务轻得多。

**三个可选方案**：
- **S1 随包内置 SearXNG 服务**：开箱即用、免 key、多引擎聚合；代价＝上述体积/跨平台/维护/AGPL。建议做成**可选安装包或首次启动按需下载**，不塞进主安装包。
- **S2 只做 SearXNG 客户端**：平台内置「SearXNG 后端」配置项，用户填自建/局域网实例地址（用户自行 Docker/pip 部署）。零打包成本、许可最干净；缺点是需要用户有一个实例。
- **S3 不用 SearXNG，Rust 轻量抓取**：SearXNG 的「免 key」本质同样是抓各引擎结果页；平台直接用 `ureq`+`scraper` 抓 DuckDuckGo/Bing，体积小、纯 Rust、无需 Python。缺点＝无多引擎聚合与隐私代理。

**推荐**：若目标是「桌面端开箱即用免 key 搜索」，**S3（Rust 轻量抓取）**性价比最高；若一定要 SearXNG 的多引擎/隐私能力，选 **S2**（客户端可配置），确有「零部署」硬需求再评估 **S1**（可选组件）。三者可组合：S1/S2 作主后端，S3 作无实例时的降级。
