# LLD-FEAT-002：Tauri 正式实现方案

- 关联：[CR-015](../PRD/CR-015-启动Tauri正式实现.md)、[ADR-002](ADR-002-Tauri技术栈选型.md)、[ADR-001](ADR-001-文档正文与统一能力网关.md)、[DB-FEAT-001](../DB/DB-FEAT-001-知识授权与工作台数据设计.md)、[UI-FEAT-001](../UI/文档/UI-FEAT-001-界面设计.md)（CR-014 白蓝视觉基线）。
- 状态：已实现（首轮全模块落地）；验证见 [REPORT-008](../Test/REPORT-008-Tauri正式实现验证.md)。该历史状态不代表后来 UI-CR036／042／043 或品牌新版已完整实现。

## 0. BUG-013：全量按现行设计修复（2026-11-20）

用户已明确正式开发授权，并扩大到「不只是我提出来的，其他的也需要检查」。本次允许修改正式 `src/`、相关 `src-tauri/` 命令／资源与测试，按已有有效设计对齐；不改用户可视设计、原型数据，不更换 identifier／crate 身份、不迁移或删除用户数据，不提交／推送／发布。当前失败与验证纠正见 [REPORT-BUG013](../Test/REPORT-BUG013-全量设计对齐.md)。

- 有效基线：公开入口 → workbench-v4；公共 UI-CR036-v4、品牌 UI-BRAND-001-v2、AI UI-CR042-v1、办公 UI-CR043-v1，未替代的权限／知识／数据约束继续有效。资源实际 SHA-256 将锁定在本次基线清单，不能只凭旧文档 hash 放行。
- 全局壳：顶栏 56px、帆船承载 30px／图片 24px、中英文独立排版，工作空间导航与下方对象页签依当前原型；复用既有模块与真实 route。默认工作台统计采用真实可得来源，无后台 Run 核心时显示无数据，不造运行成绩。
- AI：保留统一 ChatPanel 数据层，使用设计的 composer 结构、图标与字号；textarea 在上，内底部依次＋／CLI／权限／模型＋档位／图标发送，统计与页脚在外；模型浮层固定尺寸、供应商左列、搜索与思考滑杆；同 scope 单一 activeOverlay 负责开闭、互斥、外点／Escape 与合理焦点恢复。侧栏开关与 320–620px 拖宽、设计页侧栏由项目工作区统一接线。
- 消息与安全：不把普通办公会话自动注入研发夹具；演示只能明确作用域且显式载入，原生权限未验证不通过改按钮名冒充生效。发送失败保留草稿，异步返回绑定 project/session/request generation；定位事件只分发一次，高亮使用真实 line.from 字符偏移；步骤不可将未返回工具标为成功；统计未知不猜测。
- 其他模块：项目卡片／需求树／设计／任务／编码／办公／知识／服务器／设置逐场景核对，保留既有真实 IPC。缺失功能必须记录归属与 AC，不能用空按钮／静态卡片或样例假执行替代。设计已有错误／禁用状态可复用；没有状态稿的部分保持具体阻塞，不擅自删控件。
- 分工：主代理维护共享 App／route／API、基线／方案／记录与集成；侧栏、项目、设置、知识／服务器、办公制作按文件独占派发。三份独立只读审查后实施；必要设计变更先三票评判，照稿修软件不需要改正确设计。
- 验证：先 tsc／build／cargo，之后隔离 mockIPC（未知命令拒绝、无回退真实服务）或独立测试库＋本地 127.0.0.1 临时 SSH 服务器。禁止再次运行真实用户 SSH 的终端、监控、审批执行用例。逐场景同主题／视口／字体／样例／状态保存设计与软件成对证据，功能通过不替代视觉验收；未验证项保留。


## 1. 总体架构

```
┌─ 前端 React 18 + TS（src/）────────────────────┐
│ App.tsx 全局壳：左导航（项目/知识库/服务器）+   │
│ 顶栏（返回、页签、深浅切换）+ 设置中心弹框      │
│ modules/: projects / chat / git / editor /     │
│           servers / knowledge / settings       │
│ api/index.ts：invoke 封装 + 类型契约           │
└──────────────┬─────────────────────────────────┘
               │ tauri invoke / ipc Channel
┌──────────────┴─────────────────────────────────┐
│ 后端 Rust（src-tauri/src/）                     │
│ db.rs      SQLite 迁移与共享连接（WAL）         │
│ models.rs  前后端共享结构（camelCase serde）    │
│ commands/  general projects fs gitcmd providers│
│            sdk capabilities chat servers       │
│            knowledge                           │
│ ssh/       russh 连接管理/终端/exec/SFTP        │
└─────────────────────────────────────────────────┘
```

- 存储遵循 ADR-001：需求/知识正文为项目与知识源目录中的 Markdown 文件（唯一事实来源）；SQLite 存投影索引、授权、配置、会话。数据库位于 `app_data_dir/workbench.db`，密钥在 `app_data_dir/secrets.json` / `server-secrets.json`（仅掩码与引用出后端）。
- 前后端契约集中在 `src/api/index.ts`（TS）与 `src-tauri/src/models.rs`（Rust），命名一一对应；新增命令必须同时更新两处与 `lib.rs` 注册表。

## 2. 模块与命令清单

| 模块 | 前端目录 | 后端命令（前缀） | 参考移植点 |
| --- | --- | --- | --- |
| 项目与需求 | `modules/projects` | `list/create/delete_project`、`read_requirements`、`read/write_doc`、`fs_*` | 需求树 = 项目 `docs/Plan/**` front matter（id/type/parent/status）扫描重建 `requirement_index` 投影 |
| AI 会话 | `modules/chat` | `chat_sessions/session_*/messages/send/abort` | 会话 GUI 参考：流式事件（delta/thinking/toolUse/toolResult/usage/done）、CLI spawn stdin/stdout JSONL 桥 |
| Git 管理 | `modules/git` | `git_status/stage/unstage/discard/commit/diff_file/branches/switch_branch/log/commit_files/fetch/pull_ff_only/push/branch_state` | Git 面板参考：porcelain v1 -z 解析、for-each-ref ahead/behind、\x1f 分隔 log 格式、三段面板交互 |
| 编码区 | `modules/editor` | `fs_list_dir/list_tree/read/write/delete_file/search` | openidea 参考：懒加载文件树、页签脏标记、CodeMirror 6 按扩展名语言配置 |
| 服务器 | `modules/servers` | `server_list/save/delete/connect/disconnect/term_*/tree/read_file/exec/exec_approved/exec_reject/metrics` | TermX 机制（无许可证，未复制代码）：连接管理、xterm+Channel 终端桥、/proc 监控采样、高风险命令审批 |
| 知识库 | `modules/knowledge` | `kb_list/save/delete/scan/tree/read/search/grants/grant_set/gateway` | CR-015历史实现：三栏、LIKE搜索、授权判定；正文仅Markdown目录。增量设计见CR-030，未实现 |
| 设置中心 | `modules/settings` | `provider_*`、`model_candidates`、`fingerprint_check`、`sdk_*`、`skill_*`、`mcp_*`、`tool_*` | 思考等级插件：efforts 档位表/候选过滤；CLI 管理插件：npm 任务状态机；skill/mcp 面板：命名校验/重复名拒绝/工具发现 |

## 3. 关键机制设计

### 3.1 AI 会话 CLI 桥（commands/chat.rs）

- `chat_send`：读取会话执行配置（cli/model/effort）→ 校验CLI已安装启用→按启动快照组装提示→持久化user消息→spawn CLI→解析JSONL→推送事件→落assistant/tool/usage。上文CR-015实现基线通过`knowledge::gateway_read`把引用的整篇正文写入`<knowledge>`；**CR-030新增AC后未来知识上下文必须按权限内版本切片和响应／轮预算发送，不能把本段历史事实当成该新增约束已实现。**技能与附件仍遵循各自已登记契约。
- 适配器：claude（`-p --output-format stream-json --verbose --include-partial-messages --permission-mode acceptEdits [--model]`）；codex（`exec --json --skip-git-repo-check [-m] [-c model_reasoning_effort]`，stdin `-`）；grok（`--print --json`，尽力而为，失败如实报错）。
- 运行快照：`RUNNING` 注册表在发送期间锁定会话，`chat_session_update` 对运行中会话拒绝修改 cli/provider/model/effort（CR-012）；`chat_abort` 经 watch channel 杀进程。
- 已知限制（如实）：非交互模式下工具审批由 permission-mode 决定，`approvalRequest`/`subagent` 事件与 `chat_approve_tool` 为预留契约；流式期间交错顺序持久化为近似（user → assistant 全文 → tool_use → tool_result）。

#### 3.1.1 供应商注入与能力注入（2026-11-19 补充，CR-015 细化）

设置中配置的供应商必须真正生效，而不是仅存库。每次派发按「会话快照 → 供应商 → CLI 适配器」生成**子进程环境与临时配置**：

| CLI | 注入方式 | 关键字段 |
| --- | --- | --- |
| claude | 子进程环境 + 临时 settings 文件 | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（密钥）、`ANTHROPIC_MODEL`；清理继承的 `ANTHROPIC_*` 防止串号 |
| codex | `-c` 参数 + 临时 `CODEX_HOME`（auth.json/config.toml） | 自定义 `model_provider`（base_url + `wire_api`）、`CODEX_API_KEY` 环境 |
| grok | 子进程环境 | `OPENAI_BASE_URL`、`OPENAI_API_KEY`、模型名 |

其余约束：
- 协议映射：供应商 `protocol=anthropic` 走 Anthropic 兼容；`openai` 走 OpenAI 兼容。CLI 与协议不匹配时明确拒绝，不静默换模型。
- 密钥只进子进程环境或受管临时目录，不写入命令行、不落日志；临时目录用后即删。
- 能力注入：启用的 MCP 服务器生成受管 MCP 配置（claude 用 `--mcp-config` 临时 JSON；codex/grok 用各自配置），启用的 Skill 目录通过项目/用户级技能目录暴露；禁用项不得注入。
- 上下文注入：例如 codex 的 `AGENTS.md` 通过 `-c project_doc_max_bytes`/`developer_instructions` 传递，项目根作为 cwd。
- 可观察性：派发时记录实际使用的 provider/model/baseUrl 主机名（不含密钥）与会话快照修订号，供 UI 展示与排障。

**实测结论（2026-11-19，真实 CLI）**：

| 结论 | 证据 |
| --- | --- |
| claude 忽略进程环境 `ANTHROPIC_BASE_URL`，只认 `--settings` 的 env 段 | 仅设环境变量时 CLI 仍请求原生服务；改用 `--settings` 后网关命中 |
| `--strict-mcp-config` 必需 | 非严格模式下 CLI 会合并用户全局 MCP，受管名单失效 |
| `--allowedTools mcp__<name>` 放行 MCP 工具 | init 事件里 `tools` 出现 `mcp__<server>__<tool>` |
| `--add-dir <skills>` 可让 CLI 加载技能 | init 事件 `skills` 含自定义技能名 |
| codex 0.166 只支持 `wire_api="responses"`（`chat` 已移除） | 传 chat 直接报错拒绝启动 |
| codex 的 `base_url` 不应带 `/v1`（其自行拼 `/responses`） | 带 /v1 时请求 `/v1/responses` 返回 404 |
| codex MCP 需 `default_tools_approval_mode="approve"` | exec 非交互，未预放行的 MCP 调用一律失败 |
| claude 思考档位只能经 `MAX_THINKING_TOKENS` 环境变量 | headless 无 /think 命令 |

验证脚本：`scripts/verify-dispatch.mjs`（本地 mock 网关 + 真实 CLI，5/5 通过）。


### 3.2 知识授权网关（commands/knowledge.rs，CR-015历史基线）

- `authorized_libraries(project_id)` 每次调用实时查 `project_library_grant`；无项目身份或无记录 → 空集合（默认拒绝）。
- `gateway_list/search/read/read_many` 与 `kb_gateway` 是CR-015现有边界；当前scan仅索引MD元数据，search逐篇读原件字符串匹配，read返回整篇。此处描述现状，不等于达到CR-030全文索引或有界AI读取。
- 笔记路径解析经 canonicalize 且必须位于库根之内（防 traversal/符号链接逃逸）。
- **CR-030新增方案与实施门槛**见 [LLD-FEAT-008](LLD-FEAT-008-本地知识索引与按需检索.md)、[DB-FEAT-008](../DB/DB-FEAT-008-知识原件切片与全文索引.md)及 [PRD](../PRD/CR-030-本地知识索引与按需引用.md)。它们尚未实现；本模块表中的原命令仍是现状，不得被当作已提供FTS或片段契约。

### 3.3 服务器（ssh/ + commands/servers.rs）

- 连接：russh，keepalive 15s×4；密码或密钥认证；`CONNECTIONS` 注册表按 `user@host:port` 管理MutexGuard 不得跨 await（取出后使用）。
- 终端：`channel_open_session → request_pty(xterm-256color) → request_shell`；输出任务独占 Channel，输入走 `handle.data`（不争锁）；resize 以 `stty cols/rows` 输入实现。
- 监控：轮询式 `exec cat /proc/stat|meminfo|loadavg|uptime|hostname` 单命令采样，前端 2.5s 刷新；CPU 每核 usage =（total-idle)/total 单次近似。
- 审批：`RISK_PATTERNS` 命中（rm -rf/mkfs/shutdown 等）→ `needsApproval` + 10 分钟有效 requestId；批准前复查连接状态；拒绝即移除。
- 已知限制：主机指纹未校验（TODO known_hosts）；无断线推送事件，状态以列表刷新为准。

### 3.4 SDK 管理（commands/sdk.rs）

- 三 CLI 常量包名（claude=@anthropic-ai/claude-code、codex=@openai/codex、grok=@xai-official/grok）。
- 安装/卸载 = `npm install/uninstall -g <pkg>[@ver] [--registry]`，任务状态机 queued→running→done|failed|cancelled；单 SDK 同时一个任务；日志环形 800 条；取消 = kill_on_drop + watch。
- 检测 = `npm ls -g --depth=0 --json` + `<cmd> --version` 兜底；会话 CLI 候选 = 已安装且启用（CR-012）。

### 3.5 模型配置（commands/providers.rs）

- 数据：provider（protocol=anthropic|openai）+ keys（明文进 secrets.json，DB 存掩码）+ endpoints（协议+baseUrl）+ models（text/vision/imageGen 互斥校验、efforts 档位表 off..max→wire 拼写或 null、默认档位必须来自已配置档位）。
- `model_candidates` 过滤：供应商启用 + ≥1 启用密钥 + ≥1 协议匹配启用端点 + text 且非 imageGen。
- 指纹检测：ureq 阻塞探测每启用端点 `GET /v1/models`（10s 超时），结果存 fingerprintJson。

### 3.6 Git（commands/gitcmd.rs）

- 全部 `tokio::process` 数组参数调用 git CLI（不拼 shell）；`core.quotepath=false`；Windows CREATE_NO_WINDOW。
- status：porcelain v1 -z 解析 XY 列（冲突塌缩 U）；log：`\x1f`/`\x1e` 分隔 pretty-format；上游 ahead/behind：`rev-list --left-right --count upstream...HEAD`。
- 网络操作仅 fetch/pull(--ff-only)/push，无 force/reset/clean（与 CR-006 边界一致）。

### 3.7 NestCraft-owned HTTP MCP OAuth（后端增量已接入，完整实现未完成）

模型供应商的第三方API密钥与HTTP MCP服务器OAuth是两类凭据：前者继续沿provider_key/secretRef注入模型请求，后者由NestCraft按`mcp_server`端点独立管理；不调用或复制CLI原生`claude mcp login`/`codex mcp login`凭据。参考实现只借provider home与OAuth机制边界，不复制远端issuer、scope或代码。

传输范围：**仅 `stdio` 与 `http`**（`streamable-http` 是 HTTP 传输的规范名，按 http 处理）。SSE 与 WebSocket 传输不支持：SSE 属旧版 HTTP+SSE 规范，参考实现（ZCode／官方 SDK）也把 `type=sse` 标为 legacy 且其现代路径为 Streamable HTTP；本应用后端为 Rust、无等价内置 SDK，故不引入。后端 `mcp_save` 与工具发现对非 stdio/http 一律拒绝。

首期只支持HTTP/streamable-http MCP。NestCraft启动授权时读取受保护资源/授权服务器元数据，生成随机state、PKCE verifier/challenge和本机随机loopback redirect，登记一次性`mcp_auth_attempt`；使用系统浏览器打开授权URL，回调只接受匹配state、服务器ID、redirect和有效期限的请求，成功后交换access/refresh token。token只写现有受管密钥存储并由`authCredentialRef`引用；SQLite不保存token正文、原始回调或client secret。刷新、撤权、端点/元数据变更、凭据缺失都更新显式authStatus并阻止未授权tools/list和派发。

`mcp_discover_tools`与派发配置必须从NestCraft受管credentialRef读取token；连接结果分别记录`authenticated`与`discovered`，不能用tools/list成功代替授权。Claude/Codex只接收本次生成的HTTP MCP配置，不能读取用户全局MCP或原生OAuth profile；stdio仍沿现有启动参数路径，不伪造OAuth。

#### 3.7.1 认证方式、Streamable HTTP 会话与 TLS 边界（2026-11-21 实测补充）

真实服务核验发现两类缺陷并已修正：

1. **Streamable HTTP 会话**：现代 MCP 服务在 `initialize` 响应中下发 `Mcp-Session-Id`，后续 `notifications/initialized` 与 `tools/list` 必须携带同一会话头；响应可能是 `text/event-stream`。原实现只发 `initialize` 与 `tools/list`、忽略会话头且仅取首条 data 行，对真实服务会失败。现按 `initialize → initialized → tools/list` 顺序执行，并解析 SSE 中的 result/error。
2. **认证方式不止 OAuth**：`mcp_server.authMode ∈ oauth|bearer|none`。`oauth` 走 3.7 的授权与刷新；`bearer` 直接使用服务提供的静态令牌，写入受管密钥（引用 `mcp-bearer:<serverId>`），DB 只存引用与状态；`none` 不发送认证头，仅用于受控服务。静态令牌同样只用于工具发现与派发，不回显。

TLS：客户端默认严格按系统根证书校验。仅当服务地址是 loopback（`127.0.0.1`／`localhost`／`::1`）的 HTTPS，且用户为该服务器显式开启“信任本机自签名证书”时，才对该连接放宽校验；其他主机传入该选项会被拒绝。该选项默认关闭，属本机开发场景的显式取舍，不是通用关闭校验。

实测证据：对 `https://127.0.0.1:27124/mcp`（Obsidian Local REST API + MCP，静态 Bearer）以生产函数执行会话握手后成功发现 16 个工具。该服务提供的是静态令牌而非 OAuth，因此不能作为 OAuth 授权/刷新链路的外部验收证据。

#### 3.7.2 独立安全审计后的加固与未决项（2026-11-21）

已修：

- `mcp_save` 曾在外层 DB `MutexGuard` 存活时再次 `db::conn()`，属不可重入自锁；现在处理受管密钥前显式结束 DB 锁作用域。
- 回调 `state` 参数按字节解码，杜绝非法 `%` 序列在字符边界切片导致 panic；无 state 或不匹配的本地请求不再消耗一次性授权；接受连接设读超时，避免只连接不发送拖住回调线程。
- 资源地址由前缀匹配改为主机精确匹配：明文 HTTP 仅允许 loopback；`localhost.attacker.example` 一类近似域名被拒绝。OAuth 元数据与令牌请求禁用自动重定向，放宽证书的校验器同时拒绝非 loopback `server_name`，避免经重定向绕过。
- 令牌与资源地址绑定（`resource_url`）：端点变化后旧令牌立即失效并回到未授权。
- OAuth 凭据引用按 `attempt_id` 唯一（`mcp-oauth:<serverId>:<attemptId>`）；回调以 `authStatus='pending'` 做 CAS，失败只清理本次引用，不再误删新代次。
- 供应商密钥与 MCP 凭据共用同一把 `secrets.json` 文件锁，避免相互覆盖。
- 前端不再二次 `window.open`（系统浏览器由后端打开），轮询在卸载后可安全收敛。
- 启动回收：进程重启后，DB 中残留的 `pending` attempt 置 `expired`、对应 `mcp_server` 回到 `unauthenticated`（内存 verifier 与 loopback 监听已丢失，不可恢复）。
- 删除或停用服务器：取消其 pending attempt、清空内存待回调状态，并删除该服务器拥有的受管凭据（含 `mcp-bearer:<id>` 与 DB 记录的 credentialRef）。
- refresh 在网络往返后复核 `authStatus` 与 `authCredentialRef`；期间撤权、登出或换端点则丢弃本次刷新结果，不写回旧授权。

未决（不得据现有证据声称安全完成）：

- `mcp_auth_attempt` 仍无 server 外键与单活动 attempt 约束（当前靠应用层状态机保证）。
- dispatch 仍可能用旧 URL 快照配合后读凭据，尚未做同一配置代次的原子快照。
- 协议细节未覆盖：未发送 `MCP-Protocol-Version` 头、未处理 tools 分页、OAuth discovery 未解析 `WWW-Authenticate`、授权与交换未带 `resource` 参数。
- 回调只做单次 `read`，合法分片请求可能被误拒；Windows 下受管密钥文件未建立专用 ACL 证明。
- 真实 OAuth 授权服务器端到端仍未验证；正式软件与设计稿的同条件视觉对照仍未取得。

桌面回调和系统浏览器打开、令牌刷新/撤销及并发锁是本增量的实现前置；无可靠回调或凭据写入失败时保持未授权并返回可重试错误。UI需覆盖未授权、待回调、已授权、过期、撤权、失败、登出和连接发现分离状态后才能修改正式界面。

## 4. UI 体系

- 设计令牌：`src/theme/tokens.css`（与 CR-014 原型同源的浅/深两套变量）；`base.css` 通用组件类；模块 CSS 一律引用变量不写死色值。
- 布局：全局壳（208px 左导航 + 56px 顶栏）；项目工作区（需求=全宽树+右 40% AI；设计=44px 图标栏+文档；编码=图标栏+左栏(文件/Git)+右 AI）；知识库三栏；服务器三栏；设置中心弹框（≤70% 视口）。
- 组件：`components/ui.tsx`（Toast/Modal/Switch/Field/Confirm/Empty/renderMarkdown+DOMPurify/extractToc）。

## 5. 并行实现与文件归属（本轮实际）

主代理实现：后端全部 Rust、前端骨架（theme/components/api/store/App）、projects 模块。
子代理实现（各自只写自己目录）：settings、chat、git+editor、servers、knowledge。
集成验证：tsc 全量、vite build、cargo check/build。

## 6. 未决项与限制（后续故事）

- 设置中心代理未完成前 settings 页签为占位（本轮已由代理补齐，见 REPORT-008 实际结果）。
- 服务器：known_hosts 指纹校验、断线事件推送、SFTP 上传下载进度（未实现）。
- 会话：交互式工具审批（MCP 审批工具桥）、子代理事件、流式交错顺序持久化。
- 需求：CR-009 提交调整/差异提案、CR-010 逆向补全任务（未实现，属后续故事）。
- 发布：tauri bundle 打包（NSIS）与签名未执行；本轮交付以 dev/构建通过为边界。

## CR-028：文件与数据库分工设计（未实现增量）

### 范围与事实

依据 [CR-028](../PRD/CR-028-文件与数据库按职责存储.md)，关联 [STORY-010 08～10](../Plan/Story/STORY-010-需求树与详细文档预览.md#cr-028完整文档的文件权威)／[STORY-036 04～07](../Plan/Story/STORY-036-知识库正式实现.md#cr-028知识原件与派生索引边界)。上文“已实现”只指 CR-015 首轮，**本节仅设计、未实现／未验证**。已有 Markdown 文件读写与 DB 投影可复用；原件导入、稳定登记、CAS、安全范围和故障恢复有缺口。本批不修改源码、运行软件或迁移，不新增 UI／依赖／云平台。

完整正文／UI 资源／原始文件的介质分工与字段唯一维护于 [DB-FEAT-001 CR-028](../DB/DB-FEAT-001-知识授权与工作台数据设计.md#cr-028文件与数据库分工现行增量)。业务权限、会话和运行状态仍留数据库；结构化数据库模型延续当前允许的 DB 记录，不把整个文档或文件包转存 TEXT/BLOB/JSON。复用既有 ADR 和 outbox 思路，现有机制足够，无须本批外部调研或新依赖。

### 文件布局（拟议，不表示已创建业务目录）

```text
project-root/
  docs/Plan/、docs/PRD/、docs/LLD/       完整需求、PRD、方案正文
  docs/UI/仿真原型UI.html              唯一公开入口（不改原目录约定）
  docs/UI/<资源目录>/                  UI图片、样式、脚本等
app_data_dir/
  workbench.db                        配置／授权／会话／登记／索引
  knowledge/<library-id>/originals/<file-id>/<revision>/  托管导入原件
  knowledge/<library-id>/derived/<file-id>/<revision>/<parser-version>/
  attachments/<project-id>/<file-id>/<revision>/        项目附件／办公原件
  executions/<project-id>/<batch-id>/<task-id>/         快照、长日志、报告、证据
```

上述受管相对目录为可逆技术默认，所有访问由稳定 ID 和受检定位服务解析。目录绑定模式仍读取用户指定源，不偷偷复制为托管库或删源；创建目录不自动把私有资料加入 Git。外部目录移动、原件缺失、同名／别名须明确登记／核查，不能按文件名猜身份。

### 拟议内部契约与核心流程

本节只定义内部服务行为，命名不代表已注册 IPC 或 AI 工具；不取代并行设计的按需读取契约。宿主解析项目／库身份，不接受 AI 自报身份或任意绝对路径。

- 保存正文输入：`scope/objectId/expectedHash/content/operationId`；输出：`sourceRef/sourceHash/revision/indexState`。先校验身份、路径白名单、当前授权与实际 hash，再留可恢复版本，在同文件系统写临时文件、完成耐久写入并原子替换；同 operationId 不重复写回。冲突保留用户文件和草稿，不能以重建索引覆盖源。
- 导入原件输入：`libraryId/已授权文件输入句柄/originalName/operationId`；输出：`fileId/revision/sourceHash/storageState/parseState`。原始名称仅显示；按独立 ID 存文件，边写边计算大小/hash，完成耐久封存后登记 stored。格式／容量白名单在对应实现设计中确定，不通过当前本地路径字符串开放任意文件读取。
- 解析输入：`fileId/sourceRevision/sourceHash/parserVersion`；从已保存且受权原件生成独立产物；输出产物引用、hash 和 parseState，不覆盖原件。解析失败仍保留 stored，禁止当 ready 使用。
- 登记／恢复：先数据库短事务记录 pending 与 operationId，文件 I/O 不持 DB 写事务；文件封存后登记 stored，再登记派生产物与索引。启动／重试对账只能核查登记过的受管操作，不扫全盘或猜授权；已封存未确认只补登记，未封存保留失败状态，缺损对象阻止读取／验收。非目标临时／用户文件不自动清理。
- 正文写入成功但投影失败：源文件保留新版本，登记 index pending/failed；从源向前重建，不回滚为旧正文。多文件调整仍复用原受控变更包／可恢复日志，不宣称单文件原子替换能证明多文件一致。
- 读取／检索：每次及缓存复用都检查实际权限、所属范围与源修订；按需读文件，索引片段只是派生结果。大文本、完整报告和资源包由文件引用提供，不能通过数据库 JSON 字段偷偷恢复双正文权威。

### 影响、实现顺序及恢复

1. 获正式编码授权后，先细化上传格式／容量及适用可视 UI、异常状态、版本与准入；与现有设计／用户草稿冲突先核查，不先改软件。
2. 明确物理 schema／协议版本和迁移方案；核查项目文档、目录源与现有 DB，不预设当前存在需要搬迁的 BLOB。按授权停写并一致备份 DB（处理 WAL）与受管文件清单／hash。
3. 实现受限文件定位、基线 CAS、耐久写入、操作幂等、原件登记与对账；随后接入派生解析／索引，不同时让多个代理写共享数据层。契约和迁移由集成负责人统一。
4. 在隔离目录／库验证所有新增 AC：字节保留、同名／移动、外部修改、解析／索引失败、磁盘满、保存后崩溃、缺失／损坏、跨项目与撤权、备份恢复。真实权限测试不能用 UI 过滤替代；没有结果不写通过。
5. 回退先停新写入和所有相关 writer，核查版本及副作用；未发生新写入时才可恢复一致备份，否则保留原件／新正文向前修复。不恢复旧授权为默认开放、不删文件或历史来对齐旧库。

实际本批只核查文档与源码事实，未实现／执行以上流程；结果见 [CR-028 核查记录](../PRD/CR-028-文件与数据库按职责存储.md#6-本次核查记录)。
