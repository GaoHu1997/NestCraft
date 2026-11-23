# CR-060：AI 内置工作台工具集（AI 侧栏直接操作软件）

- 状态：**需求/设计/实现已完成并通过自动化验证（2026-11-22：cargo test 通过含新增单测、npm run build 通过、MCP 服务器进程级协议验证通过）；真实模型驱动的端到端操作演示待验收**。
- 来源：用户 2026-11-22 指令：「项目自身还需要提供一系列的mcp或者是tool给ai使用。比如创建项目/史诗/特性/用户故事/知识库/服务器等一系列配置。也就是说用户告诉ai要干嘛，就能帮用户在软件中操作。注意是在本平台的ai侧栏等地方。授权从需求/设计/编码操作都完成，不要打扰我，一切都按照推荐的来。我只要结果和报告。」
- 关联：[FEAT-023 AI内置工作台工具集](../Plan/Feature/FEAT-023-AI内置工作台工具集.md)（唯一父项）、[STORY-079](../Plan/Story/STORY-079-AI内置工作台工具集.md)、[UI-CR060](../UI/文档/UI-CR060-AI侧栏工具调用呈现.md)、[LLD-CR060](../LLD/LLD-CR060-AI内置工作台工具集实现.md)；复用 [DB-FEAT-001 既有存储设计](../DB/DB-FEAT-001-知识授权与工作台数据设计.md)（无新增表）。

## 1. 背景与目标

平台 AI 侧栏的会话由外部 CLI（claude / codex / grok）执行。派发层（LLD-FEAT-002 §3.1.1）已能把用户在「设置-能力」中配置的 MCP 服务器注入 CLI，但软件自身的业务能力——创建项目、编写需求文档（Epic / Feature / Story）、创建知识库与授权、登记服务器主机等——都没有以工具形式提供给 AI。用户想说一句「帮我建一个某某项目并配上知识库」，AI 却只能产出文字，用户仍要自己去界面逐项点按。

目标：把软件自身的核心配置操作实现为**内置 MCP 工具集（服务名 `workbench`）**，在 AI 侧栏会话中自动注入给 CLI，让用户用自然语言指挥 AI 直接在软件中完成操作；工具执行结果以真实工具调用步骤呈现在 AI 侧栏，可审计、可停用。

## 2. 本次范围／不做事项

**包含**

1. 应用自带 MCP stdio 服务器模式：以本应用二进制 `--app-mcp-stdio` 启动（不启动 GUI），实现 MCP stdio JSON-RPC（initialize / tools/list / tools/call / ping），与主应用共用同一 SQLite（WAL）与数据目录。
2. 内置工具集（12 个，均带输入 Schema 与中文描述；`workbench_` 前缀）：

| 工具 | 风险 | 作用 |
| --- | --- | --- |
| workbench_get_context | 低 | 返回当前会话绑定项目上下文（projectId/name/kind/rootUri）与项目总数，AI 判断当前工作目标 |
| workbench_list_projects | 低 | 项目清单 |
| workbench_create_project | 中 | 创建项目（name/kind=code\|work/rootUri；复用 UI 同名校验与目录校验） |
| workbench_update_project | 中 | 更新项目名称/根目录/图标（运行中禁换根等规则与 UI 一致） |
| workbench_get_requirements | 低 | 需求树（vision→epic→feature→story/bug；projectId 省略时取当前项目） |
| workbench_read_requirement_doc | 低 | 按 entityId 或 sourceUri 读取需求文档正文 |
| workbench_write_requirement_doc | 中 | 创建/更新需求文档：按 kind 自动落入 Vision/Epic/Feature/Story 目录、自动分配 `VISION-/EPIC-/FEAT-/STORY-/BUG-` 编号（沿用 3 位补零惯例）、生成 front matter（id/type/parent/title/status/owner）、临时文件+rename 原子写入；带 entityId 则为更新 |
| workbench_list_kbs | 低 | 知识库清单及对当前项目的授权状态 |
| workbench_create_kb | 中 | 创建受管知识库（数据目录下自动建受管目录），可选授权给项目（默认当前项目） |
| workbench_set_kb_grant | 中 | 设置项目-知识库授权（与 UI 授权语义一致，写路径 revision+1） |
| workbench_list_servers | 低 | 服务器主机清单（不返回任何密钥） |
| workbench_save_server | 中 | 新建/更新服务器主机配置；密码/密钥路径写入受管密钥文件（与 UI 同规则） |

3. 派发注入：AI 侧栏会话派发时自动把内置 `workbench` MCP 服务器随既有 MCP 配置注入 claude（`--mcp-config` + `--allowedTools mcp__workbench`）与 codex（`mcp_servers.workbench` TOML）。
4. 开关与治理：全局开关 `aiTools.enabled`（设置键，默认开）；每个工具在「设置-工具」页显示为内置工具行（风险等级/启用开关），停用后该工具从 `tools/list` 消失。
5. AI 侧栏呈现：真实 `mcp__workbench__*` 工具调用按现行步骤/工具消息设计展示，工具名映射为中文（如「工作台·创建项目」），成功/失败状态与耗时照常。
6. 冒烟确定性：`TAURI_SMOKE=1` 时不注入内置 MCP（mock CLI 不实现 MCP，保持冒烟链路确定性）。

**不做事项**

1. **不暴露删除类操作**（删除项目/知识库/服务器/需求文档），删除仍走人工界面确认；AI 不可经工具删除用户数据。
2. **不动知识内容写入边界**：知识笔记/文件内容的创建与编辑维持 CR-045「本人知识文件管理；不加入 AI 写入网关」约束，本次只开放知识库（库级）创建与授权配置。
3. 不暴露供应商与 API 密钥配置工具（密钥不应流经模型上下文）；供应商列表读取也不开放（无本次诉求且含密钥掩码信息）。
4. 不开放服务器连接/终端/远程命令执行——该域已有独立审批链路（FEAT-017 `server_ai_exec` 风险模式+逐次审批），本次不重复建设。
5. ~~grok CLI 适配器不支持 MCP 注入~~ —— **该判断有误，已于 CR-064 更正**：grok 原生支持 MCP，此前是我方适配器未实现（并另有启动参数错误）。grok 的 MCP 注入已在 CR-064 补齐。
6. 不新增数据库表：全部复用 `project` / `requirement_index` / `knowledge_library` / `project_library_grant` / `server_host` / `capability` / `setting_default` 既有结构（DB-FEAT-001）。
7. 不做工具调用结果的界面新面板——步骤与工具消息按现行 AI 侧栏设计（UI-CR056）呈现，仅新增工具名中文映射规则。

## 3. 业务流程

1. 用户在 AI 侧栏发送指令（如「帮我创建一个叫 X 的编码项目，配一个知识库并授权给它，再登记一台服务器」）。
2. 派发层构建 CLI 子进程配置时，把内置 `workbench` MCP 服务器（command=应用自身、args 含 `--app-mcp-stdio`、`--app-data-dir`、可选 `--project-id`）并入 MCP 配置；工具清单经 capability 表过滤。
3. 模型输出 `mcp__workbench__*` 工具调用 → CLI 经 stdio 调用应用自带 MCP 服务器 → 工具处理器复用与 UI 命令同一套校验与存储逻辑执行 → 结果返回模型。
4. 侧栏按现行设计展示工具步骤（中文名、运行/成功/失败、耗时）；失败不中断会话，模型可依据错误信息修正参数重试。
5. 操作结果立即在软件各界面可见（项目清单、需求树、知识库列表、服务器列表），与会话上下文共享同一数据库，无需重启。

## 4. 规则与边界

- 授权语义与 UI 完全一致：重名项目拒绝、项目根必须是可访问目录、端口 1–65535、认证类型白名单、知识授权写路径 revision+1、需求文档 front matter 与目录布局同 `requirement_sources` 扫描器约定。
- 需求文档编号分配只增不减，扫描既有文件 front matter 与文件名取同前缀最大号 +1；不修改既有编号。
- 密钥安全：`workbench_save_server` 的 secret 只进受管密钥文件（server-secrets.json），不落 SQLite、不进返回值与日志；工具返回值不含任何密钥明文。
- 风险治理：12 个工具全部登记进内置工具注册表（capability kind='tool'），用户可逐个停用；全局开关关闭时整个服务器不注入。
- 并发安全：MCP 服务器进程与主应用共用 SQLite（WAL），MCP 模式打开连接即设 busy_timeout，写操作沿用既有单事务语义。

## 5. 验收标准

见 [STORY-079](../Plan/Story/STORY-079-AI内置工作台工具集.md) AC-01～AC-10（派发注入、MCP 协议、四域工具行为、能力页治理、步骤中文映射、回归与进程级端到端）。

## 6. 待确认问题与决定

| 问题 | 决定（按用户授权「按推荐的来」） |
| --- | --- |
| 删除操作是否暴露给 AI | 不暴露（数据安全优先；如需后续以高风险+二次确认形式补充） |
| 需求文档编号格式 | 沿用仓库惯例 3 位补零（STORY-077），超过 999 后自然增长 |
| AI 是否可写知识内容 | 不可以（维持 CR-045 边界，只开放库级配置） |
| 默认开关 | 默认启用，设置键 `aiTools.enabled` 可关 |
| 真实模型端到端演示 | 需真实 CLI 与模型密钥，列为待验收项（AC-10），不阻塞本次交付 |

## 7. 确认记录

- 2026-11-22 用户原话（见「来源」）：明确要求提供 MCP/tool 给 AI 操作软件（项目/史诗/特性/用户故事/知识库/服务器等配置），作用域为本平台 AI 侧栏等处；「授权从需求/设计/编码操作都完成，不要打扰我，一切都按照推荐的来。我只要结果和报告」→ 本 CR 及 FEAT-023/STORY-079 按推荐方案直接推进需求、设计、实现与验证，未逐项询问。
- 范围取舍依据「推荐」原则：只做创建/读取/更新类配置操作，删除类与密钥写入类不暴露（安全推荐）；工具命名、开关、注入方式按既有架构推荐落地。

## 8. 变更记录

| 日期 | CR | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-11-22 | CR-060（新建） | 用户新诉求：AI 需能直接操作软件 | 新增内置 MCP 工具集；AI 侧栏步骤中文名映射；能力注册表新增 12 个内置工具行 |
| 2026-11-22 | CR-059 → CR-060（编号顺延） | 仓库中另有并行工作流的 `docs/PRD/CR-059-设置中心评审调整.md`（未登记索引、仍在进行中），按「一个编号只对应一个实体」顺延本次成果 | 仅编号与文件名变更；实现、范围、验收标准与结论均不变；本次文档内所有交叉引用同步更新 |
