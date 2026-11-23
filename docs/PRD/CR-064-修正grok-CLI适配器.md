# CR-064：修正 grok CLI 适配器（启动参数 / MCP 注入 / 思考档位 / 认证）

- 状态：**已实现并通过自动化验证（2026-11-22：cargo test 全量通过、npm run build 通过、真实 grok 1.0.77 CLI 参数与 MCP 配置识别验证通过）；真实对话端到端待验收（需 xAI 账号或可用密钥）**。
- 来源：用户 2026-11-22 指出「grok cli 支持 mcp 注入啊，你看看 thinking level 怎么做的」。经查证，此为**我方实现缺陷**，且比用户所指更严重。
- 关联：[FEAT-015 CLI SDK 装卸与会话可用性](../Plan/Feature/FEAT-015-CLISDK装卸与会话可用性.md)（唯一父项）、[STORY-083](../Plan/Story/STORY-083-修正grok-CLI适配器.md)；能力注入沿用 [LLD-CR060](../LLD/LLD-CR060-AI内置工作台工具集实现.md) 的 MCP 通道设计。
- 缺陷编号：**BUG-002**（grok 适配器参数错误导致会话不可用）。

## 1. 背景：实测证据

本机装有真实 grok CLI（`@xai-official/grok@1.0.77`）。逐项实测：

| # | 当前实现 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| A | `grok --print --json`（chat.rs grok 分支） | `error: unexpected argument '--json' found` | **致命**：grok 会话在真实环境**根本无法启动** |
| B | MCP 注入（dispatch.rs `apply_capabilities` 的 `_ => {}`） | grok 有完整 `mcp` 子命令（list/add/remove/enable/disable/doctor），支持 stdio/http/sse 与 `--scope user\|project`；项目级 `./.grok/config.toml` 的 `[mcp_servers.<name>]` 被 `grok inspect` 正确识别 | 我方**漏实现**，非 grok 不支持 |
| C | 思考档位 | grok 有 `--reasoning-effort <EFFORT>`（别名 `--effort`） | 我方**未实现**（claude 走环境变量、codex 走 `-c`，grok 应走命令行参数） |
| D | 认证环境变量 | grok 认 `XAI_API_KEY`；当前注入的是 `OPENAI_API_KEY` | 环境变量名不匹配，自定义供应商可能无法生效 |
| E | Prompt 输入 | `grok` 无子命令时从 **stdin** 读取；`-p/--single <PROMPT>` 为单轮参数 | 当前 stdin 传 prompt 方式**可行**，无需改 |
| F | 输出格式 | `--output-format` 取值 `plain\|json\|streaming-json\|streaming-messages-json`；`streaming-json` 输出 JSONL 事件流 | 需改用 `--output-format streaming-json` |

**更正此前记录**：CR-060 与 LLD-CR060 中「grok CLI 适配器不支持 MCP 注入」的表述**错误**，属我方未实现而误记为上游限制。本 CR 予以更正。

## 2. 本次范围／不做事项

**包含**

1. **修正启动参数**（BUG-002 根因）：`--print --json` → `-p` 语义改为 stdin 输入 + `--output-format streaming-json`。
2. **grok 思考档位**：按会话 effort 传 `--reasoning-effort <effort>`；`off` 不传（沿用该档位不上报的既有约定）。
3. **grok MCP 注入**：把启用的 MCP 服务器（含 CR-060 内置 `workbench`）写入会话工作目录下的 `.grok/config.toml`（`[mcp_servers.<name>]`），并在会话结束/派发清理时移除，避免污染用户项目与 `~/.grok`。
4. **grok 认证环境变量**：追加注入 `XAI_API_KEY`（保留 `OPENAI_*` 以兼容 OpenAI 兼容端点）。
5. 更正 CR-060/LLD-CR060 中关于 grok 的错误表述。

**不做事项**

1. 不改动 claude / codex 适配器行为。
2. 不改 grok 的会话续接策略（单轮 stdin 通道，无 `--resume`；维持既有「grok 不做原生续接」的登记）。
3. 不实现 grok 的 SSE/HTTP MCP 传输注入（仅 stdio，与 codex 同口径；HTTP MCP 在 grok 上暂不支持）。
4. 不改前端；无界面变化。
5. 不引入 grok 特有的 agent/plugin/worktree 等功能。

## 3. 业务流程

1. 用户在 AI 侧栏选择 grok CLI 的会话 → 派发层解析供应商与能力配置。
2. 派发层在**会话工作目录**写入 `.grok/config.toml`（仅含 MCP 服务器段），grok 启动时自动发现并加载。
3. grok 以 `--output-format streaming-json` 输出 JSONL 事件流，软件按既有 CLI 解析链路处理增量与工具事件。
4. 若会话设定了思考档位（非 off），追加 `--reasoning-effort <effort>`。
5. 派发配置 Drop / 清理时删除临时 `.grok/config.toml`（若为本次创建），不残留于用户项目。

## 4. 规则与边界

- **不污染用户目录**：优先写会话工作目录下的 `.grok/config.toml`；若该文件已存在（用户自有配置），**不覆盖**——记录为警告并跳过 MCP 注入，不破坏用户配置。
- 临时文件生命周期与既有 `DispatchConfig` 一致（Drop 时清理）；清理只删除本次创建的目录，不递归删除用户既有 `.grok`。
- 认证：`XAI_API_KEY` 与 `OPENAI_API_KEY` 同值注入；密钥仍只进子进程环境，不进 argv 与日志。
- 思考档位：`off` 不传参（沿用既有约定）；其余档位透传，由 grok 自行校验。
- 失败透明：MCP 配置写入失败应明确报错（不静默降级为「无工具」），让用户知道工具不可用。

## 5. 验收标准

见 [STORY-083](../Plan/Story/STORY-083-修正grok-CLI适配器.md) AC-01～AC-07。

## 6. 待确认问题与决定

| 问题 | 决定（按推荐） |
| --- | --- |
| 用 `-p <prompt>` 还是 stdin | 用 stdin（不改既有写入链路，已验证 grok 支持） |
| MCP 写 user scope 还是 project scope | project（会话工作目录），避免污染 `~/.grok` 影响用户其他项目 |
| 用户已有 `.grok/config.toml` | 不覆盖，警告并跳过（宁可少工具，不破坏用户配置） |
| 是否同时支持 HTTP MCP | 本轮不支持（grok 需 `--scope` + 独立 auth，风险与工作量不成比例），登记为后续 |

## 7. 确认记录

- 2026-11-22 用户原话：「grok cli支持mcp注入啊，你看看 thinking level怎么做的」→ 指出我方缺陷。经实测确认为实现缺陷（且启动参数本身即错误），按缺陷修复流程处理；用户指令已授权修正。
- 修复范围包含用户直接指出的两项（MCP 注入、思考档位）以及实测发现的同源缺陷（启动参数、认证变量），均属同一适配器。

## 8. 变更记录

| 日期 | CR | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-11-22 | CR-064（新建） | 用户指出 grok 支持 MCP；实测发现适配器参数错误 | 修正 grok 启动参数；新增 MCP 注入、思考档位、XAI_API_KEY；更正 CR-060 错误表述 |
