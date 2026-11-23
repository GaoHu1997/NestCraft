# LLD-CR060：AI 内置工作台工具集实现方案
- 关联：[CR-060](../PRD/CR-060-AI内置工作台工具集.md) / [FEAT-023](../Plan/Feature/FEAT-023-AI内置工作台工具集.md) / [STORY-079](../Plan/Story/STORY-079-AI内置工作台工具集.md) / UI [UI-CR060](../UI/文档/UI-CR060-AI侧栏工具调用呈现.md)
- 本次设计范围：应用自带 MCP stdio 服务器、12 个工具处理器、派发注入、能力注册、需求文档写入器、前端工具名映射。

## 1. 当前实现与复用点

- AI 轮次由外部 CLI 子进程执行（chat.rs `spawn_cli`/`parse_cli_line`）；派发层 dispatch.rs `apply_capabilities` 已能把 `mcp_server` 表中启用的用户 MCP 注入 claude（`--strict-mcp-config --mcp-config <file>` + `--allowedTools mcp__<name>`）与 codex（`mcp_servers.*` TOML）；工具由 CLI 执行，软件只透传 toolUse/toolResult 事件。**内置工具沿用同一通道，不新建执行机制。**
- 复用的业务逻辑（均为可直调函数，`#[tauri::command]` 不含 AppHandle 的直接调用）：
  - `projects::create_project` / `projects::read_requirements`（重扫投影）/ `projects::write_doc`（原子写）/ `projects::update_project_inner`（改 pub）。
  - `knowledge::kb_grant_set`（授权写路径 revision+1）；`kb_save` 抽出 `kb_save_inner(conn, name, source_ref)` 供无 AppHandle 场景复用。
  - `servers::server_save` 抽出路径参数版内函数（密钥文件路径显式传入，不再从 AppHandle 推导）。
- 明确不改的边界：会话/消息流（chat.rs 解析与落库）、用户自配 MCP（mcp_server 表）语义、CR-045 知识内容写入边界、FEAT-017 服务器执行审批链、删除类命令。

## 2. 选定方案

### 2.1 MCP stdio 服务器（新模块 `src-tauri/src/commands/ai_tools.rs`）

- 入口：`main.rs` 在 Tauri 启动前检查 `--app-mcp-stdio`；命中则 `ai_tools::run_stdio_server(args)` 后 `process::exit(0)`，GUI 不启动。
- 参数：`--app-data-dir <dir>`（必填；与主应用同一数据目录）、`--project-id <id>`（可选，会话绑定项目，供 `get_context` 与默认项目参数使用）。
- 初始化：`db::init(<dir>/workbench.db)`（幂等迁移）后对共享连接设 `PRAGMA busy_timeout=5000`（WAL 多进程共库）。
- 协议：MCP stdio 传输 = 逐行 JSON-RPC 2.0。stdin 每行一条请求；stdout 每行一条响应、立即 flush；日志只走 stderr（严禁污染 stdout）。
- 方法实现：
  - `initialize` → `{protocolVersion: <回显请求版本>, capabilities: {tools: {}}, serverInfo: {name: "workbench", version: CARGO_PKG_VERSION}}`。
  - `notifications/*` → 不响应。
  - `tools/list` → 读 capability 表（kind='tool'，name 形如 `workbench.<tool>`，enabled=1）过滤静态工具目录，返回 `{name, description, inputSchema}`。
  - `tools/call` → 按 name 分发到处理器；返回 `{content: [{type: "text", text: <结果 JSON 串>}], isError}`；未知工具/参数错误/业务错误一律 `isError=true` 且 text 为中文错误信息。
  - `ping` → `{}`。
  - 其他 method → JSON-RPC error（method not found）。
- 健壮性：单请求处理包 `catch_unwind`（panic 转 isError，循环不退出）；stdin EOF 即退出进程。
- 信任边界：本模式与主应用同权限（本地桌面单用户），任何本地进程理论上可直驱——等同直接读写 workbench.db 的既有暴露面，不新增鉴权（LLD-FEAT-002 同口径）；登记为已接受风险。

### 2.2 工具目录与处理器（12 个）

静态目录 `WORKBENCH_TOOLS: [(mcp_name, registry_id, 中文描述, inputSchema, risk)]`；registry_id 采用既有惯例 `workbench.<tool>`。处理器要点：

| 工具 | 处理逻辑 |
| --- | --- |
| get_context | `--project-id` 查 project 表返回 {projectId,name,kind,rootUri} + 项目总数；未绑定返回 {projectId:null, projects总数} |
| list_projects | `list_projects` 直调返回全量 |
| create_project | `create_project(name, kind, root_uri)` 直调（重名/目录校验复用 UI 语义） |
| update_project | 取共享连接调 `update_project_inner`（icon/iconColor 经 JSON null/字符串解析为 Option<Option<&str>> 语义） |
| get_requirements | `read_requirements(project_id)` 直调；project_id 缺省取 `--project-id` |
| read_requirement_doc | 参数 entityId（在 requirement_index 查 sourceUri）或 sourceUri 直读；返回正文 |
| write_requirement_doc | 见 §2.3 需求文档写入器 |
| list_kbs | `kb_list` 直调 + 对缺省项目的授权状态联查 project_library_grant |
| create_kb | 在 `<data_dir>/knowledge-managed/<净化名>` 建目录（重名追加短随机后缀）→ `kb_save_inner` → 可选 `kb_grant_set`（默认授权当前项目）→ 返回 libraryId |
| set_kb_grant | `kb_grant_set` 直调 |
| list_servers | 直接 SQL（id/name/host/port/username/authType/groupTag），**不含 secretRef** |
| save_server | `server_save` 抽出的内函数（data_dir 显式传入）；校验与 UI 同源 |

错误处理约定：所有处理器返回 `Result<serde_json::Value, String>`；错误消息中文、可操作（与 UI 命令同文案口径），模型可据此修正重试。

### 2.3 需求文档写入器（write_requirement_doc）

- 目录映射：vision→`docs/Plan/Vision/`、epic→`docs/Plan/Epic/`、feature→`docs/Plan/Feature/`、story|bug→`docs/Plan/Story/`。
- 编号分配：扫描该目录（+`docs/Plan/` 根）既有 .md 的文件名与 front matter `id`，取同前缀（`VISION-|EPIC-|FEAT-|STORY-|BUG-`）最大数字 +1，3 位补零（>999 自然增长）；只增不减，不改既有编号。
- 文件名：`<ID>-<净化title>.md`（去除 `\/:*?"<>|` 与首尾空白）；同名冲突时在末尾追加 `-<短随机>`。
- front matter（与 projects.rs `parse_front_matter` / requirement_sources 扫描器约定一致）：
  ```markdown
  ---
  id: EPIC-012
  type: epic
  parent: VISION-001
  title: 标题
  status: 待确认
  owner: <可选>
  ---
  ```
- parent 校验：先 `read_requirements`（触发重扫）后检查 parentEntityId 存在，不存在即拒绝（消息列出可用父项编号样例）。
- 更新模式：传入 entityId 且命中现有文档 → 原文件覆写（保留原 id/type/parent），title/content/status/owner 可更新；未传 entityId → 新建。
- 写入后调用 `read_requirements` 刷新投影并返回 `{entityId, sourceUri, mode}`。

### 2.4 派发注入（dispatch.rs）

- `resolve()` 增加 `project_id: Option<&str>` 入参（chat.rs 唯一调用点传入会话 projectId）。
- 新函数 `built_in_workbench_row(data_dir: &Path, project_id: Option<&str>, enabled: bool) -> McpRow`：command=`std::env::current_exe()`，args=`["--app-mcp-stdio","--app-data-dir",<dir>] (+ ["--project-id",<pid>])`；纯函数便于单测。
- enabled 计算（resolve 内）：`TAURI_SMOKE` 未设置 且 setting `aiTools.enabled` != "0"（缺省=开）。
- 注入位置：`apply_capabilities` 开头将该行并入 servers（stdio 通道）；claude 分支 `allowed` 追加 `mcp__workbench`（服务内 tools/list 已按 capability 表过滤）；codex 分支沿用既有 stdio TOML 模板（`default_tools_approval_mode` 与用户自配 MCP 一致）。grok 分支当时未实现 MCP 注入（**已于 CR-064 修正**：改为 GROK_HOME 会话隔离配置，见 LLD-CR064；此前「grok 不支持 MCP」的表述有误，grok 原生支持 MCP）。
- 冒烟确定性：`TAURI_SMOKE=1` 不注入（mock CLI 不实现 MCP，保持既有冒烟断言稳定）。

### 2.5 能力注册与前端映射

- capabilities.rs `BUILTIN_TOOLS` 追加 12 条 `(workbench.<tool>, 中文描述, risk, "config")` → 设置-工具页自动呈现、`tool_set_enabled` 直接生效（MCP 服务实时读取）。
- 前端（`sessionRuntime.ts` 新增 `toolDisplayName` 导出；`ChatPanel`/`MessageList`/`rebuildStepsFromPairs` 采用）：`mcp__workbench__<tool>` → 「工作台·<中文名>」（映射表 12 条），未命中原样显示。仅显示文案，事件/统计逻辑不动。

## 3. 数据设计结论（DB）

**无新增表、无迁移。** 复用 [DB-FEAT-001](../DB/DB-FEAT-001-知识授权与工作台数据设计.md)：`project` / `requirement_index`（投影，写入后重扫刷新）/ `knowledge_library` / `project_library_grant` / `server_host` / `capability`（工具注册与启停，既有表新增数据行）/ `setting_default`（`aiTools.enabled`）。MCP 子进程与主应用共用同一 SQLite（WAL + busy_timeout=5000）；密钥仍只入受管 `server-secrets.json`（不进 SQLite/日志/返回值）。知识笔记内容表完全不动（CR-045 边界）。

## 4. 实现步骤与验证

1. `ai_tools.rs`：协议循环 + 工具目录 + 处理器 + 需求写入器（单测：协议往返、ID 分配、front matter、四域处理器内存库行为、禁用过滤）。
2. `main.rs` 入口 + `dispatch.rs` 注入（单测：三态注入、args 断言）。
3. `knowledge.rs`/`servers.rs` 内函数抽取（既有单测保持通过）。
4. `capabilities.rs` 注册 + 前端映射（npm build + 映射单测）。
5. 进程级验证脚本 `scripts/verify-ai-tools.mjs`：spawn 真实二进制 `--app-mcp-stdio`，跑 initialize→tools/list→tools/call(create_project)→tools/call(list_projects)→ping，断言全链路。
6. 回归：`cargo test` 全量、`npm run build`；`TAURI_SMOKE` 冒烟关键用例抽查。

## 5. 未决项、假设与风险

- 假设：claude/codex CLI 对 `mcp__<server>`（整服务放行）语法支持与既有单工具放行一致（既有代码已按服务名放行用户 MCP，风险低）。
- **更正（2026-11-22，CR-064）**：本文件原记「grok CLI 适配器不支持 MCP 注入」为错误结论——grok 原生支持 MCP（`mcp` 子命令 + `GROK_HOME`/项目级配置）。实为我方未实现，已在 CR-064 补齐。
- 风险：codex MCP 工具审批行为跟随用户自配 MCP 的既有模板（`default_tools_approval_mode="approve"`）；若真实环境发现被审批卡住，按既有模板调整，不单独造轮子。登记为观察项。
- 风险：SQLite 跨进程并发写（主应用 + MCP 子进程）——WAL + busy_timeout 覆盖；极端 busy 错误以 isError 返回，模型可重试。
- 已接受风险：stdio 模式无额外鉴权（§2.1 信任边界口径）。
- 观察项：真实模型对工具的调用质量（参数正确性）属 AC-10 待验收范围，不在本次自动化断言内。
