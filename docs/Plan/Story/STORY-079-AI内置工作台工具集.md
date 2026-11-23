# STORY-079：AI 内置工作台工具集
- 类型：用户故事（含实现）
- 所属 Feature / PRD：[FEAT-023](../Feature/FEAT-023-AI内置工作台工具集.md) / [CR-060](../../PRD/CR-060-AI内置工作台工具集.md)
- 来源与确认依据：用户 2026-11-22 指令（原话登记于 CR-060 §7），明确授权需求/设计/编码一体完成、按推荐方案执行。
- 负责人 / 优先级 / 状态 / 依赖：主代理 / 高 / 验证中（自动化验证通过，端到端演示待验收）/ 依赖既有派发层与四域业务命令。
- 目标：作为使用 AI 侧栏的用户，我希望告诉 AI「创建项目/史诗/特性/用户故事/知识库/服务器等配置」后 AI 直接在软件中完成操作，以便省去逐界面手工配置。
- 本次包含 / 不包含：见 [CR-060 §2](../../PRD/CR-060-AI内置工作台工具集.md)。
- 验收标准：
  - AC-STORY-079-01（派发注入）：给定启用内置工具的 AI 侧栏会话，当派发 claude 时，则 MCP 配置含内置 `workbench` 服务器（command=应用自身、args 含 `--app-mcp-stdio` 与 `--app-data-dir`、会话绑定项目时含 `--project-id`）且 `--allowedTools` 含 `mcp__workbench`；codex 时 `mcp_servers.workbench` TOML 注入；`aiTools.enabled=0` 或 `TAURI_SMOKE=1` 时不注入。
  - AC-STORY-079-02（MCP 协议与进程级验证）：给定 `--app-mcp-stdio` 子进程，当发送 initialize / tools/list / tools/call / ping JSON-RPC，则响应符合 MCP stdio 约定；tools/list 只返回 capability 表中启用的 workbench 工具；未知工具与参数错误返回 `isError=true`；进程级脚本（真子进程）完成 initialize→create_project→list_projects 全链路。
  - AC-STORY-079-03（项目域工具）：create_project 复用 UI 校验（重名拒绝、根目录必须可访问）；update_project 改名/换根/图标生效且运行中禁换根；list_projects/get_context 返回正确数据且不含密钥类信息。
  - AC-STORY-079-04（需求文档工具）：write_requirement_doc 按 kind 落入正确目录并自动分配编号（沿用 3 位补零、只增不减）、front matter 字段完整（id/type/parent/title/status/owner）；parent 不存在时拒绝；带 entityId 更新不新建文件；get_requirements / read_requirement_doc 能读回新节点。
  - AC-STORY-079-05（知识库域工具）：create_kb 在数据目录建受管目录与库记录并按参数授权；set_kb_grant 授权/撤权生效（撤权后 AI 知识网关拒绝读取）；list_kbs 返回授权状态。
  - AC-STORY-079-06（服务器域工具）：save_server 新建/更新主机，password 密钥只写入受管密钥文件、不出现在 SQLite、返回值与日志；list_servers 不含密钥；校验规则（端口/认证类型/必填）与 UI 一致。
  - AC-STORY-079-07（能力页治理）：设置-工具页显示 12 个内置 workbench 工具行（风险等级正确、可停用）；停用后 tools/list 不再返回该工具。
  - AC-STORY-079-08（AI 侧栏呈现）：`mcp__workbench__*` 工具调用在步骤与工具消息中显示中文名（如「工作台·创建项目」），状态/耗时/结果照常；对照 [UI-CR060](../../UI/文档/UI-CR060-AI侧栏工具调用呈现.md)。
  - AC-STORY-079-09（回归）：cargo test 全部通过（含新增单测）；npm run build 通过；冒烟套件在 `TAURI_SMOKE=1` 下关键用例不回归（内置 MCP 不注入）。
  - AC-STORY-079-10（端到端演示，待验收）：给定真实 CLI 与模型密钥，当用户在 AI 侧栏下达配置指令，则 AI 真实调用工具完成创建且软件界面可见。外部依赖（真实模型）由用户验收阶段执行。
- 方案：[LLD-CR060](../../LLD/LLD-CR060-AI内置工作台工具集实现.md)；UI [UI-CR060](../../UI/文档/UI-CR060-AI侧栏工具调用呈现.md)；DB 复用 [DB-FEAT-001](../../DB/DB-FEAT-001-知识授权与工作台数据设计.md)（无新增表，结论登记于 LLD §6）。
- UI 准入（涉及界面时）：
  - 受影响场景：AI 侧栏工具步骤/工具消息的工具名显示（新增映射规则）；设置-工具页新增内置工具行（数据行新增，布局不变）；其余界面无变化（原因：本次不改任何页面结构、交互流程与视觉样式）。
  - 可视设计资源与版本：[UI-CR060-AI侧栏工具调用呈现](../../UI/文档/UI-CR060-AI侧栏工具调用呈现.md)（含步骤名映射表与场景清单）；原型 `docs/UI/workbench-v4/` 无需改动（演示步骤不含真实 MCP 工具名，展示规则与现行 UI-CR056 步骤设计一致）。
  - 覆盖检查：滚动条规范 [UI-SCROLL-001/CR-049](../../UI/文档/UI-CR049-滚动条按需显示.md) ——本次无新增/调整滚动区域，不适用（未改任何容器布局）。
  - 确认/执行授权：用户 2026-11-22 指令授权需求/设计/编码一体完成（登记于 CR-060 §7）。
  - 先设计后软件记录：UI-CR060 与本 Story 的 UI 准入节先于编码落稿；实现按 §7 实现位置执行。
  - 对照计划：构建通过 + 设置-工具页与 AI 侧栏步骤显示的实际运行截图对照（见验证结果；真实模型端到端截图归 AC-10 待验收）。
- 实现位置 / 提交或 PR：
  - 后端：`src-tauri/src/commands/ai_tools.rs`（MCP stdio 服务器 + 12 工具处理器）、`src-tauri/src/main.rs`（stdio 模式入口）、`src-tauri/src/commands/dispatch.rs`（注入）、`src-tauri/src/commands/capabilities.rs`（内置工具注册）、`src-tauri/src/commands/knowledge.rs` / `servers.rs`（可复用内函数抽取）、`src-tauri/src/commands/chat.rs`（resolve 传 project 上下文）。
  - 前端：`src/modules/chat/sessionRuntime.ts` + `MessageList.tsx`（工具中文名映射）。
- 验证结果：见文末「验证结果登记」。
- 验收结论及依据：待验收（自动化验证通过；AC-10 需真实模型环境由用户验收）。
- 阻塞、遗留事项和下一步：AC-10 端到端演示待用户在真实模型环境验收；如需扩展删除类/供应商域工具，按 CR 变更流程补充。

## 验证结果登记（2026-11-22）

| AC | 方式 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| 01 派发注入 | cargo 单测（dispatch 注入三态：默认开/开关关/冒烟模式） | 见 AC-01 | 通过（含断言 args/allowedTools/TOML） | 通过 |
| 02 MCP 协议 | 进程内单测 + 真子进程脚本（scripts/verify-ai-tools.mjs） | 见 AC-02 | initialize/tools/list/tools/call/ping 全通过；create_project→list_projects 全链路成功 | 通过 |
| 03 项目域 | cargo 单测（内存库） | 见 AC-03 | 重名拒绝/非法目录拒绝/更新生效/换根禁令生效 | 通过 |
| 04 需求文档 | cargo 单测（临时目录） | 见 AC-04 | 编号递增、front matter 完整、目录正确、parent 校验、更新不新建 | 通过 |
| 05 知识库域 | cargo 单测（内存库+临时目录） | 见 AC-05 | 建库/授权/撤权生效，撤权后网关拒绝 | 通过 |
| 06 服务器域 | cargo 单测（内存库+临时密钥文件） | 见 AC-06 | 密钥仅入受管文件；校验与 UI 一致 | 通过 |
| 07 能力页治理 | cargo 单测（tool_list 含 workbench 工具）+ 构建 | 见 AC-07 | tool_list 返回 12 个内置工具，含风险与开关 | 通过 |
| 08 侧栏呈现 | npm run build + 前端单测（映射函数） | 见 AC-08 | 中文名映射正确，未知工具名回退安全 | 通过 |
| 09 回归 | cargo test 全量 + npm run build | 见 AC-09 | 全部通过 | 通过 |
| 10 端到端 | 真实模型环境人工验收 | 见 AC-10 | 未执行（外部依赖） | 待验收 |

环境与证据：Windows 本机；`cargo test`（src-tauri）、`npm run build`、`node scripts/verify-ai-tools.mjs` 输出见执行记录（docs/tmp/ 下当次日志不入库，结论如上）；执行时间 2026-11-22。
