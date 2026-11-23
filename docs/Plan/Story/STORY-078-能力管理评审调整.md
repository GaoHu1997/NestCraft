# STORY-078：能力管理评审调整（CR-059 F）

- 类型：用户故事（需求／设计）＋缺陷调查
- 所属 Feature：[FEAT-013 统一设置入口与菜单](../Feature/FEAT-013-统一设置入口与菜单.md)
- 来源与确认依据：用户 2026-11-22 设置中心评审意见（[CR-059 §1 F](../../PRD/CR-059-设置中心评审调整.md)），附图3（MCP STDIO 表单基准）。
- 负责人 / 优先级 / 状态 / 依赖：主代理 / P1 / **验证中（2026-11-23 已实现，待用户验收）** / 依赖受管技能目录与 MCP DB（STORY-031 既有机制）；跨 agent 扫描路径清单已落到 `capabilities.rs`。
- 目标：作为使用者，我希望从本地文件夹或其他 agent 一键导入 Skill/MCP 且副本归我所有，MCP 表单参数齐全，工具列表按来源树形展示并如实标注生效状态。

## 本次包含 / 不包含

- 包含：F1～F7 需求基线与可操作设计稿；Skill 文件夹选择导入、跨 agent 扫描导入；MCP 扫描导入与图3表单（命令/额外参数每行一个/环境变量 KEY=value）；受管副本规则；Tools 树形列表与来源分组；BUG-CR059-01 根因结论与「明示未接入」呈现。
- 不包含：正式软件实现；内置工具注入会话的执行契约（待用户对 CR-059 §7 问题 3 决策后另立方案）；读取其他 agent 登录态/隐私数据；SSE/WebSocket 传输。

## 验收标准

| 编号 | 给定 / 当 / 则 |
| --- | --- |
| AC-STORY-078-01 | 给定 Skill 页，当点击「添加技能」，则弹层提供「选择文件夹…」；选中含 SKILL.md 的文件夹后自动识别名称/说明/正文并预览；确认后整目录复制到受管技能目录，外部源删除不影响副本；无 SKILL.md 时报错并提示结构要求。 |
| AC-STORY-078-02 | 给定 Skill 页，当点击「导入」，则扫描本机其他 agent 技能目录并列出来源/名称/说明/已导入标记；勾选批量导入为受管副本；同名已导入项禁选；扫描不执行任何指令。 |
| AC-STORY-078-03 | 给定 MCP 页，当点击「导入」，则扫描其他 agent 的 MCP 配置并列出服务器/传输/来源，勾选导入到受管配置；敏感 env 按受管密钥写入不回显；保留 JSON 文件导入为次级入口。 |
| AC-STORY-078-04 | 给定 MCP 添加表单（STDIO），当对照图3，则字段为：类型下拉（STDIO/HTTP）、名称（必填）、命令（单行完整命令行）、额外参数（textarea 每行一个）、环境变量（textarea 每行一个 KEY=value）；footer 只有取消/保存；解析按 shell 词法＋逐行规则，非法行报行号。 |
| AC-STORY-078-05 | 给定 MCP HTTP 表单，当切换类型，则显示 URL＋认证方式（OAuth/静态令牌/无认证）＋Bearer＋loopback 自签名开关（沿用 STORY-031 已确认设计）。 |
| AC-STORY-078-06 | 给定 Tools 页，当查看列表，则为树形：根节点＝提供方（NestCraft 内置/各 MCP 服务器/各 CLI 原生），展开为 tool 行（名称/风险/说明/开关）；不再是平铺表格；无「今日调用」列。 |
| AC-STORY-078-07 | 给定 MCP 来源根节点，当尚未发现工具，则显示「尚未发现工具」与去测试连接入口；CLI 原生工具集只读并标注由 CLI 自身管理。 |
| AC-STORY-078-08 | 给定 NestCraft 内置 18 项工具，当实现完成后，则全部经 workbench MCP 通道真实注入会话、开关真实生效（用户决策：AI 必须可以使用工具）；原有 6 项按 LLD-CR059-FEAT013 §2 契约实现（fs_read/knowledge_*/ssh_exec），ssh_exec 高风险保持 needsApproval 审批门禁不绕过；实现落地前设计稿与软件均如实标「待实现」（BUG-CR059-01），不虚构已生效。 |
| AC-STORY-078-09 | 给定上述弹层与列表超高内容，当滚动，则滚动条按需显隐（UI-SCROLL-001，UI-CR049-v1），停止 700ms 隐藏，表单输入不丢失。 |

## UI 准入（涉及界面）

- 场景/状态：[UI-CR059 §2](../../UI/文档/UI-CR059-设置中心评审调整.md) SC-059-13～18。
- 可视设计资源与版本：`docs/UI/workbench-v4/`，版本 UI-CR059-v1，hash 见设计文档 §6。
- 覆盖检查：文件夹选择/识别失败/扫描空态/同名冲突/导入成功/STDIO 与 HTTP 表单/树形展开收起/未发现工具/只读来源。
- 确认/执行授权：需求／设计授权；**无正式编码授权**。
- 先设计后软件记录：当前仅设计。
- 对照计划：实现后与图3同条件成对截图＋导入副本独立性验证（删源后仍可用）＋CR-049 动态滚动证据。

## 方案

- LLD：[LLD-CR059-FEAT013-能力管理与工具注入](../../LLD/LLD-CR059-FEAT013-能力管理与工具注入.md)（扫描路径清单、复制与冲突策略、命令词法解析、树形数据契约、BUG-CR059-01 注入契约：6 项工具映射/Schema/审批门禁）。
- DB：capability 表复用（registry_id 不变，无迁移）；来源标注沿用 sourceRef。
- 实现落点（2026-11-23）：
  - 后端 `capabilities.rs`：`skill_folder_preview`（只读识别 SKILL.md）、`skill_import_folder`（临时目录→改名，跳过符号链接与 >512 KiB 单文件）、`skill_scan_sources`（只读 `~/.claude/skills`、`~/.codex/skills`、`~/.zcode/skills`、`~/.agents/skills`）、`mcp_scan_sources`（`~/.claude.json` mcpServers、`~/.codex/config.toml` 的 `[mcp_servers.*]`、`~/.zcode/mcp.json`）、`mcp_import_source`（按来源重新解析后走既有 `mcp_save` 校验）。
  - 后端 `ai_tools.rs`：工具目录 13→19，新增 `fs_read`／`knowledge_list`／`knowledge_search`／`knowledge_read`／`knowledge_read_many`／`ssh_exec`，registry_id 沿用既有 6 项；knowledge 系逐次复检 `authorized_libraries` 授权（撤权即时生效）。
  - 前端 `SettingsSkill.tsx`（文件夹添加＋扫描导入＋手动填写）、`SettingsMcp.tsx`（图3表单＋扫描导入＋JSON 次级入口）、`SettingsTool.tsx`（按提供方树形，去掉「今日调用」）。

## 验证结果

- 设计稿侧：见 [REPORT-CR059](../../Test/REPORT-CR059-设置中心评审设计验证.md)。
- BUG-CR059-01 根因调查：已完成（结论见 CR-059 §3.3）；**2026-11-23 已修复**：6 项内置工具经 workbench MCP 通道真实注入，工具目录由 13 增至 19，`tools/list` 与 `tools/call` 均按 capability 启停过滤。
  - 单测 `commands::ai_tools::tests::registry_and_tool_catalog_stay_in_sync`：19 条工具与注册表 registry_id 一一对应，其中 6 项不带 `workbench.` 前缀。
  - 单测 `ssh_exec_high_risk_returns_approval_without_request_id`：`rm -rf` 只返回 `needsApproval:true` 且 `requestId` 为 null，不伪造可批准请求号、不自动执行。
  - 单测 `knowledge_items_validation_rejects_oversized_batches`：超过 20 条批量读取被拒。
  - `node scripts/verify-ai-tools-ui.mjs`：前端 19 条中文名映射与后端逐条一致。
- 正式软件验证：
  - `npx tsc --noEmit` 通过、`npm run build` 通过。
  - `cargo test --offline --lib -- --test-threads=1`：329 passed / 0 failed / 6 ignored。
  - **未验证**：真实磁盘上的文件夹导入与「删源后副本仍可用」、跨 agent 扫描的真实目录内容、MCP 图3表单的 GUI 视觉对照、ssh_exec 在真实主机上的审批闭环。

## 验收结论及依据

待验收：正式软件已按设计实现，构建、后端全量回归与工具映射断言通过；真实磁盘导入副本独立性、跨 agent 扫描真实内容、GUI 视觉对照与 ssh_exec 真机审批闭环未验证。

## 阻塞、遗留事项和下一步

- CR-059 §7 四项决策已于 2026-11-22 第二轮全部落定（兜底实时跟随/文案统一/AI 必须可用工具/知识库核查无更新）。
- ai_tools.rs 的 CR-059/CR-060 注释归属仍混用（同文件承载两批工具），本次未统一改写注释，登记为遗留。
- 遗留（需用户决策）：`ssh_exec` 在 stdio 工具进程中无法把审批请求桥接到 GUI 审批表，当前实现为「高风险只返回审批说明、由用户在服务器工作台手动执行」。若要求 AI 触发后 GUI 直接出现待批卡片，需要新增跨进程审批通道，属独立需求。