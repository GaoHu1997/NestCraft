# LLD-CR064：修正 grok CLI 适配器实现方案
- 关联：[CR-064](../PRD/CR-064-修正grok-CLI适配器.md)（BUG-002）/ [FEAT-015](../Plan/Feature/FEAT-015-CLISDK装卸与会话可用性.md) / [STORY-083](../Plan/Story/STORY-083-修正grok-CLI适配器.md)
- 设计范围：grok 启动参数、思考档位、MCP 注入、认证环境变量。

## 1. 当前实现与实测差异

| 位置 | 当前 | 实测应有 | 性质 |
| --- | --- | --- | --- |
| `chat.rs` grok 分支 | `--print --json` | `--output-format streaming-json`（prompt 走 stdin） | **致命**：`--json` 不存在，子进程立即失败 |
| `dispatch.rs` `apply_capabilities` | `_ => {}`（grok 无注入） | 写 `.grok/config.toml` 的 `[mcp_servers.*]` | 漏实现 |
| `chat.rs` 参数组装 | 无 effort 传递 | `--reasoning-effort <effort>` | 漏实现 |
| `dispatch.rs` grok 分支 | 仅 `OPENAI_BASE_URL`/`OPENAI_API_KEY` | 追加 `XAI_API_KEY` | 变量名不匹配 |

## 2. 选定方案

### 2.1 启动参数（修 BUG-002）

`chat.rs` grok 分支改为：

```
grok --output-format streaming-json [--model <id>] [--reasoning-effort <effort>]
```

- 不传 `-p`：prompt 经既有 `write_stdin` 写入 stdin（实测 grok 无子命令时读 stdin）。
- 保留 `--model` 行为。
- `effort` 仅在非空且 `!= "off"` 时传递（与 codex 分支同一约定）。

### 2.2 思考档位

按会话 `effort` 透传 `--reasoning-effort`（grok 别名 `--effort`，用主名）。**不做档位映射**：grok 自有取值集合，透传后由其校验；非法值会在子进程启动时报错，属透明失败。

对比三个 CLI 的实现路径（同一语义、不同承载）：

| CLI | 承载方式 |
| --- | --- |
| claude | `--settings` 内 `env.MAX_THINKING_TOKENS`（token 预算映射） |
| codex | `-c model_reasoning_effort="<effort>"`（TOML 覆盖） |
| grok | `--reasoning-effort <effort>`（命令行参数） |

### 2.3 MCP 注入（GROK_HOME 会话隔离配置）

**实测否决的方案**：初版设计写会话工作目录的 `.grok/config.toml`（项目级）。实测 `grok mcp doctor` 报
`folder untrusted (repo-local (project-scoped) server not started for an untrusted folder)`——
grok 对 repo-local MCP 要求文件夹受信任，未信任时注入的服务器**被静默忽略**；且向用户项目目录写配置属侵入性改动。

**选定方案**：`GROK_HOME` 指向按会话稳定的隔离目录（与 claude 的 `CLAUDE_CONFIG_DIR`、codex 的 `CODEX_HOME` 同一机制），
配置写在该目录的 `config.toml`。实测 `grok inspect` 将其识别为 `workbench (stdio) config`（非 repo-local），
**无需文件夹信任**；`grok mcp doctor` 结果：`✓ command found / ✓ server started / ✓ handshake OK / ✓ 12 tools discovered`。

新增纯函数 `grok_mcp_config_toml(servers: &[McpRow]) -> String`，生成：

```toml
# 由应用生成：会话级 MCP 配置（CR-064）。会话结束会删除本文件。
[mcp_servers.workbench]
command = "C:\\path\\to\\agent-workbench.exe"
args = ["--app-mcp-stdio", "--app-data-dir", "...", "--project-id", "..."]

[mcp_servers.user-mcp]
command = "node"
args = ["server.js"]
```

要点：
- 仅 stdio 传输（HTTP/SSE 本轮不支持，跳过）。
- 复用既有 `toml_str` / `toml_key` 转义函数（与 codex 分支同源，避免两套转义规则）。
- 产物路径记入 `DispatchConfig.grok_mcp_file: Option<PathBuf>`（仅供诊断）；该目录与 claude/codex profile 同性质，
  **按会话稳定保留、不随 Drop 删除**——与既有 `profile_dir` 一致（删除会破坏会话连续性预期）。
- 不写用户 `~/.grok`，不写用户项目目录。

写入策略：
1. `resolve` 的 grok 分支先设 `GROK_HOME = stable_profile_dir(app, "grok", session_id)`。
2. `apply_capabilities` 的 grok 分支在该目录写 `config.toml`（目录专属本会话，可覆盖上一轮）。
3. 无 stdio 服务器时不创建目录、不写文件。

### 2.4 认证环境变量

grok 分支追加 `XAI_API_KEY`（同 `secret`），保留既有 `OPENAI_BASE_URL` / `OPENAI_API_KEY`（兼容 OpenAI 兼容端点）。`strip_prefixes` 追加 `XAI_`，防止宿主环境串号。

## 3. 数据设计结论（DB）

**无数据库变更。** 不改任何表结构；MCP 配置为会话期临时文件（文件系统），不入库。`.grok/config.toml` 属派发临时产物，不纳入用户数据。

## 4. 实现步骤与验证

1. `chat.rs`：grok 分支参数修正 + effort 传递。
2. `dispatch.rs`：`grok_mcp_config_toml` 纯函数；`apply_capabilities` 增 grok 分支；`DispatchConfig` 增 `grok_mcp_dir`；`cleanup` 增目录清理；`resolve` 传入 cwd。
3. 单测：
   - `grok_mcp_config_toml` 生成的 TOML 含 `[mcp_servers.workbench]` 与正确 command/args、转义正确；
   - 已存在 `config.toml` 时不覆盖（返回警告）；
   - 目录创建与清理只作用于本次创建的目录；
   - grok 参数组装含 `--output-format streaming-json`、含/不含 effort 两种情况。
4. 真实 CLI 验证：用本机 grok 1.0.77 验证（a）参数不再报错、（b）`grok inspect` 能识别生成的 `.grok/config.toml`。
5. 回归：`cargo test` 全量、`npm run build`。

## 5. 未决项、假设与风险

- 假设：grok 的 `streaming-json` 事件结构与既有 `parse_cli_line` 的解析约定存在差异。**本轮只保证会话可启动与 MCP 可用**；事件解析的完整适配（工具事件、用量）需真实登录后的端到端验证，若结构不符将另开 CR 对齐。已在 Story AC 中显式列为未验证项，不谎报通过。
- 风险：`--reasoning-effort` 的合法取值随模型变化，透传非法值会导致子进程报错；采用透明失败（错误回传用户），不做猜测性映射。
- 风险：会话工作目录若为只读（如受限目录），MCP 配置写入失败；按「明确报错」处理，不静默降级。
- 已知限制：grok 单轮通道无原生续接（既有登记不变）。

## 6. 变更记录

| 日期 | CR | 变更 |
| --- | --- | --- |
| 2026-11-22 | CR-064 | 修正 grok 启动参数；新增 MCP 注入、思考档位、XAI_API_KEY |