# STORY-083：修正 grok CLI 适配器
- 类型：缺陷修复（BUG-002）
- 所属 Feature / PRD：[FEAT-015](../Feature/FEAT-015-CLISDK装卸与会话可用性.md) / [CR-064](../../PRD/CR-064-修正grok-CLI适配器.md)
- 来源与确认依据：用户 2026-11-22「grok cli支持mcp注入啊，你看看 thinking level怎么做的」；实测确认实现缺陷，用户指令授权修正。
- 负责人 / 优先级 / 状态 / 依赖：主代理 / 高 / 验证中（自动化与真实 CLI 参数验证通过，真实对话待验收）/ 依赖本机 grok 1.0.77。
- 目标：作为使用 grok CLI 的用户，我希望 grok 会话能正常启动、能拿到启用 MCP 工具（含内置工作台工具集）、能传递思考档位，以便 grok 与其他 CLI 享有同等能力。
- 本次包含 / 不包含：见 [CR-064 §2](../../PRD/CR-064-修正grok-CLI适配器.md)。包含：启动参数修正、思考档位、MCP 注入（仅 stdio）、`XAI_API_KEY`。不包含：claude/codex 改动、grok 原生续接、HTTP/SSE MCP、前端改动。
- 验收标准：
  - AC-STORY-083-01（启动参数）：给定 grok 会话派发，当组装子进程参数，则使用 `--output-format streaming-json`，**不含** `--print --json`；prompt 经 stdin 写入。（真实 CLI 复验：`--json` 报 unexpected argument，`--output-format streaming-json` 被接受）
  - AC-STORY-083-02（思考档位）：给定会话 effort 为 `high`，则参数含 `--reasoning-effort high`；effort 为 `off` 或空，则不传该参数。
  - AC-STORY-083-03（MCP 注入）：给定存在启用的 stdio MCP 服务器（含内置 `workbench`），当派发 grok，则在按会话隔离的 `GROK_HOME` 目录生成 `config.toml`，内容含 `[mcp_servers.<name>]` 的 command 与 args；真实 `grok inspect` 识别为 `config` 来源，`grok mcp doctor` 报告服务器健康且工具可枚举。
  - AC-STORY-083-04（不污染用户环境）：注入不写用户 `~/.grok`，不写用户项目目录（早期项目级方案因需文件夹信任已否决）。
  - AC-STORY-083-05（会话隔离稳定）：`GROK_HOME` 按会话稳定（复用既有 `stable_profile_dir`），重复派发可覆盖同一会话配置，不跨会话串用。
  - AC-STORY-083-06（认证变量）：给定 grok 会话绑定供应商，则子进程环境含 `XAI_API_KEY`（同密钥值），且 `XAI_` 前缀在继承环境中被清理，密钥不进 argv 与日志。
  - AC-STORY-083-07（回归）：cargo test 全量通过；npm run build 通过；claude/codex 既有单测零回归。
  - AC-STORY-083-08（流式事件，未验证）：grok 的 `streaming-json` 事件结构是否与既有解析约定一致——需登录后的真实端到端验证，本轮**明确标记未验证**，不谎报通过。
- 方案：[LLD-CR064](../../LLD/LLD-CR064-修正grok-CLI适配器实现.md)；DB 无变更；UI 不涉及（无界面变化，UI 准入不适用）。
- 实现位置：`src-tauri/src/commands/chat.rs`（grok 参数）、`src-tauri/src/commands/dispatch.rs`（MCP TOML 生成 / effort / 认证变量 / 清理）。
- 验证结果：见文末登记。
- 验收结论及依据：待验收（自动化与真实 CLI 参数验证通过；AC-08 未验证）。
- 阻塞、遗留事项和下一步：grok `streaming-json` 事件解析的真实端到端验证需要 xAI 账号或可用密钥。

## 验证结果登记（2026-11-22）

| AC | 方式 | 实际结果 | 结论 |
| --- | --- | --- | --- |
| 01 启动参数 | 本机 grok 1.0.77 实测 + 单测 | `grok --print --json` → `error: unexpected argument '--json' found`；`--output-format streaming-json` 被接受（仅报未登录） | 通过 |
| 02 思考档位 | 单测断言参数组装 | effort=high 时含 `--reasoning-effort high`；off/空不传 | 通过 |
| 03 MCP 注入 | 单测 + 真实 `grok inspect` + `grok mcp doctor` | 真机结果：`✓ command found / ✓ server started / ✓ handshake OK (protocol 2025-11-25) / ✓ 12 tools discovered`，`Found 1 healthy, 0 failing` | 通过 |
| 04 不污染用户环境 | 真机（GROK_HOME 指向临时目录，工作目录为未信任临时目录） | 未写 `~/.grok`、未写项目目录；无需文件夹信任即可连通 | 通过 |
| 05 会话隔离稳定 | 单测 | 同一 GROK_HOME 重复写入覆盖；无服务器时不创建目录 | 通过 |
| 06 认证变量 | 单测 | 环境含 XAI_API_KEY；strip_prefixes 含 XAI_；不进 argv | 通过 |
| 07 回归 | cargo test 全量 + npm run build | 全部通过 | 通过 |
| 08 流式事件结构 | — | 未验证（需真实账号登录） | 未验证 |

环境与证据：Windows 本机；grok `@xai-official/grok@1.0.77`；`grok --help` / `grok inspect` / `grok mcp doctor` 实机输出；`cargo test`（257 通过）、`npm run build`。执行时间 2026-11-22。

补充：MCP 注入方案经两轮实测收敛——项目级 `.grok/config.toml` 因 grok 要求文件夹受信任而会被静默忽略，最终改用 `GROK_HOME` 会话隔离目录。