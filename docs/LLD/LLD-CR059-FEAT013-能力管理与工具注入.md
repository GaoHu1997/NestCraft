# LLD-CR059-FEAT013：能力管理评审调整实现方案（含 BUG-CR059-01 注入契约）

- 关联：[CR-059](../PRD/CR-059-设置中心评审调整.md) F／[STORY-078](../Plan/Story/STORY-078-能力管理评审调整.md)／[UI-CR059-v2](../UI/文档/UI-CR059-设置中心评审调整.md)；唯一父项 FEAT-013。
- 状态：**2026-11-23 已按本方案实现到正式软件（用户「漏实现的需求你需要补实现」＝编码授权），验证中、待验收**。用户 2026-11-22 已定案修复方向（「ai 必须可以使用工具，否则工具还有什么用」）；实现结果与未验证项见 [REPORT-CR059-补实现验证](../Test/REPORT-CR059-补实现验证.md)。
- 并行边界：CR-060（STORY-079/FEAT-023）已落地内置 workbench MCP 通道（`src-tauri/src/commands/ai_tools.rs`、dispatch.rs 注入、capability 启停）。本方案**复用该通道扩展 6 个工具**，不新建第二套 MCP 服务器；实现时须与 CR-060 负责方协调 ai_tools.rs 的文件归属（同一文件不得双写），并修正其源码中误标的「CR-059」注释为 CR-060。

## 1. 要解决的问题

Tools 页原有 6 项内置工具（fs.read、knowledge.list/search/read/read_many、ssh-exec）只是 capability 表启停开关，派发链路从未把它们传给 CLI——AI 识别不到（BUG-CR059-01）。用户决策：必须真实可用。

## 2. 选定方案：扩展 workbench 工具目录

在 `ai_tools.rs` 的 `workbench_tools()` ToolDef 目录追加 6 项（沿用既有结构：name/description/schema/registry_id），`run_tool` 增加对应分支。注册表 `BUILTIN_TOOLS` 已有这 6 项（capabilities.rs），registry_id 不变，**无需 DB 迁移**；停用即从 tools/list 消失且 call_tool 拒绝（既有机制直接覆盖）。

### 2.1 工具映射与输入 Schema

| MCP 工具名 | registry_id | 输入 | 复用后端 | 边界 |
| --- | --- | --- | --- | --- |
| fs_read | fs.read | `{ path: string }`（相对项目根） | `fs::fs_read_file(root_uri, path)` | root_uri 取会话绑定项目（ToolContext.project_id → projects 表 rootUri）；ensure_under 路径保护沿用；>1MiB 返回 LEGACY_FILE_TOO_LARGE 提示用窗口接口；无绑定项目时报错不猜测 |
| knowledge_list | knowledge.list | `{}` | `knowledge::kb_grants(project_id)` | 只列当前项目已授权且启用的库；未授权库不出现 |
| knowledge_search | knowledge.search | `{ query: string, libIds?: string[] }` | `knowledge::kb_search` 前置授权过滤 | libIds 省略＝全部已授权库；传入未授权/停用库 ID 一律拒绝（逐库复检，沿用 AI gateway 只读语义）；有界结果条数沿用 search_bounded |
| knowledge_read | knowledge.read | `{ libId: string, noteId: string }` | `knowledge::kb_read` 前置授权复检 | 每次调用复检 project_library_grant.readAllowed 与库启用；撤权即时生效 |
| knowledge_read_many | knowledge.read_many | `{ items: [{libId, noteId}] }`（≤20 条） | 同上逐条 | 单条失败不中断整批，逐条返回错误；总量上限防滥用 |
| ssh_exec | ssh-exec | `{ hostId: string, command: string }` | `servers::server_ai_exec`（＝server_exec 风险路径） | 主机必须已连接＋已授权；高风险命令返回 `{ needsApproval, requestId }`，**不自动批准**；用户在服务器工作台审批后经 server_exec_approved 执行；审批 10 分钟有效、断连失效（既有机制） |

### 2.2 审批交互契约（ssh_exec）

- MCP 是请求/响应模型，无法挂起等待 GUI 审批：高风险时工具**立即返回** needsApproval＋requestId＋风险提示文本，AI 应把审批请求转述给用户；用户在既有服务器审批 UI 确认后，AI 可调用新增只读查询 `ssh_exec_status`（可选，二期）或等待用户告知后重试。
- 一期最小闭环：needsApproval 返回即结束本次调用；不新增绕过路径、不轮询阻塞 MCP 进程。普通风险命令直接执行（与 server_exec 一致）。
- 冒烟模式（TAURI_SMOKE=1）不注入内置 MCP（CR-060 既有约定），6 项随之不注入，冒烟链路确定性不变。

### 2.3 中文名映射（AI 侧栏呈现，UI-CR060 机制扩展）

fs_read→「工作台·读文件」、knowledge_list→「工作台·知识清单」、knowledge_search→「工作台·知识检索」、knowledge_read→「工作台·读知识」、knowledge_read_many→「工作台·批量读知识」、ssh_exec→「工作台·服务器命令」。映射表与注册表一致性单测沿用 CR-060 的两侧不漂移校验。

## 3. 其余 F 项实现要点（STORY-078 AC-01～07）

1. **Skill 文件夹添加**：前端系统目录选择对话框（Tauri dialog plugin）→ 后端新命令 `skill_import_folder(path)`：校验 SKILL.md 存在、解析 front matter name/description、slug 冲突拒绝、整目录递归复制到 app_data_dir/skills/<slug>/（含附属资源；跳过符号链接与超 2MiB 单文件并报告）、capability 登记 sourceRef 指向副本。外部源删除不影响（副本独立）。
2. **Skill 扫描导入**：新命令 `skill_scan_sources()` 只读枚举固定路径清单（~/.claude/skills、~/.codex/skills、~/.zcode 插件 skills；路径不存在跳过），返回来源/名称/说明/已导入标记；导入复用 skill_import_folder。不执行任何指令、不读凭据。
3. **MCP 扫描导入**：新命令 `mcp_scan_sources()` 只读解析 ~/.claude.json（mcpServers）、~/.codex/config.toml（[mcp_servers]）、~/.zcode/mcp.json；传输仅 stdio/http（streamable-http 归 http），SSE/WebSocket 标记不支持；env 敏感值经既有受管密钥写入，列表不回显；导入走 mcpSave 同名校验。JSON 文件导入保留为次级入口（既有 readFile 逻辑）。
4. **MCP 图3表单**：前端重构 SettingsMcp 表单（类型/名称/命令/额外参数 textarea/env textarea）；命令按 shell 词法拆分（引号/转义规则在实现时以单测固化），额外参数逐行追加，env 逐行按首个 = 拆分、非法行报行号；保存仍走 buildDraft 既有校验与重复名拒绝。HTTP 分支沿用 STORY-031 已确认字段不回退。
5. **Tools 树形**：SettingsTool 改树形（根＝提供方）；内置组数据源 tool_list（18 项，含 pending 标记直至 6 项注入落地）；MCP 组来自最近工具发现缓存；CLI 原生组为静态只读目录（标注由 CLI 管理）。移除今日调用列。

## 4. 影响范围与不改边界

- 改：ai_tools.rs（+6 ToolDef/分支/映射）、capabilities.rs（仅注释修正与 pending 标记口径）、SettingsSkill/SettingsMcp/SettingsTool.tsx、api/index.ts（新命令绑定）、lib.rs（命令注册）。
- 不改：派发注入机制（CR-060 已建）、MCP OAuth（STORY-031）、知识库授权模型、服务器审批门禁、DB schema（capability 表复用）。
- 风险：ai_tools.rs 与 CR-060 并行写冲突——实现前由集成负责人确认文件归属与合并顺序；ssh_exec 审批 UX 一期为「返回审批请求」而非挂起，需用户验收该交互。

## 5. 验证计划（实现后）

- 单测：6 工具 Schema/注册表映射一致性；fs_read 越界拒绝；knowledge 未授权/停用/撤权拒绝；read_many 部分失败；ssh_exec 高风险返回 needsApproval 且不执行、审批过期/断连拒绝。
- 进程级：沿用 verify-ai-tools.mjs 扩展 6 项 tools/list 与停用消失断言。
- 端到端：真实 CLI 会话中 AI 调用 fs_read/knowledge_search 成功；ssh_exec 高风险走审批；设计/软件同条件成对截图＋CR-049 动态滚动证据（UI-CR059 §3）。
- 副本独立性：导入 Skill/MCP 后删除外部源，重启应用仍可用。

## 5.1 实现结果（2026-11-23）

本方案的 6 项工具已落地，`ai_tools.rs` 工具目录由 13 增至 19，`TOOL_COUNT` 同步更新，`registry_id` 沿用 `capabilities.rs` 既有 6 项（不改注册表、无 DB 迁移）：

| MCP 工具名 | registry_id | 实现要点 |
| --- | --- | --- |
| fs_read | fs.read | 直接复用 `fs::fs_read_file(root_uri, path)`，继承 `ensure_under` 路径保护与 1 MiB 上限 |
| knowledge_list | knowledge.list | `kb_grants(projectId)` 后过滤 `read_allowed` |
| knowledge_search | knowledge.search | 显式 `libIds` 逐项比对 `authorized_libraries`，任一未授权整次拒绝；省略＝全部已授权 |
| knowledge_read | knowledge.read | 每次调用复检 `authorized_libraries`（撤权即时生效），再走 `kb_read` |
| knowledge_read_many | knowledge.read_many | 逐条复检授权；单条失败进 `errors`，不中断整批；上限 20 条 |
| ssh_exec | ssh-exec | 复用 `classify_command_risk`；高风险**只返回 `needsApproval:true` 与说明**，不伪造 requestId、不执行；普通命令走 `exec_ai_command_blocking`（进程内 SSH 连接表） |

与 §2.2 的偏离（需用户确认取舍）：原方案设想「返回 requestId，用户在主应用审批后执行」。但 stdio 工具进程与主应用是**两个进程**，`servers.rs` 的 `PENDING` 审批表是进程内静态表，跨进程不可达；伪造一个主应用无法识别的 requestId 会让 AI 以为可批准而实际无入口。因此一期实现为「高风险返回说明，由用户在服务器工作台手动执行」，不伪装审批闭环。若要 AI 触发后 GUI 直接出现待批卡片，需要新增跨进程审批通道（例如把待批请求写入共享 SQLite 并由主应用轮询），属独立需求。

## 6. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-22 | 建立方案；BUG-CR059-01 修复方向定案为复用 workbench 通道注入 6 项 | 用户 2026-11-22 第二轮答复 |