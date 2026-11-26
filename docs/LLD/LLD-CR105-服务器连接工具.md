# LLD-CR105：AI 服务器连接工具实现方案

- 关联：[CR-105](../PRD/CR-105-AI服务器连接工具.md)
- 本次设计范围：为内置 AI 工具补齐连接生命周期（connect/disconnect），并让 `list_servers` 可见连接状态。

## 当前实现与受影响模块

- 连接状态由 `src-tauri/src/ssh/mod.rs` 的进程内连接表（`CONNECTIONS`／`CONNECTED_HOSTS`）持有，键为 `user@host:port`；`ssh::connect`／`disconnect`／`is_connected`／`get_connection` 为既有 API。
- GUI 路径 `servers.rs::server_connect` 需要用户手动触发；AI 工具路径 `ai_tools.rs::tool_ssh_exec` → `servers.rs::exec_ai_command_blocking` 只复用本进程连接表，主机未连接即报错。
- 工具注册表：`ai_tools.rs::workbench_tools`（`TOOL_COUNT`）；能力目录：`capabilities.rs::BUILTIN_TOOLS`；默认暴露集：`tool_groups.rs` server 组；前端侧栏步骤标签：`src/modules/chat/sessionRuntime.ts`。

## 选定方案

1. `servers.rs` 抽出 `host_auth_from(secrets, host)`，`host_auth`（AppHandle 版）与新增 `host_auth_at_dir`（数据目录版，`storage_layout::root()` 下的同一受管密钥文件）共用，避免两份认证分支漂移。
2. 新增 `connect_ai_command_blocking(host_id)`：共享 SQLite 读主机行 → 已连接幂等返回 → `host_auth_at_dir` 取凭据 → current-thread tokio runtime `block_on(ssh::connect(...))`。与 `exec_ai_command_blocking` 同一模式（stdio 工具进程无 AppHandle、无异步上下文）。
3. 新增 `disconnect_ai_command_blocking(host_id)`：读主机行后 `block_on(ssh::disconnect(...))`，未连接时 `ssh::disconnect` 自身幂等。
4. `ai_tools.rs` 注册两个 ToolDef（risk=medium，registry_id `workbench.ssh_connect`／`workbench.ssh_disconnect`），`run_tool` 增加分支，`TOOL_LABELS` 增加中文名，`TOOL_COUNT` 34→36；`tool_list_servers` 逐台附 `connected = ssh::is_connected(id)`。
5. `capabilities.rs::BUILTIN_TOOLS` 36 项同步登记（设置·工具页可见、可停用；`tool_enabled` 缺行默认启用，存量库无需迁移）。
6. `tool_groups.rs` server 组加入两个新工具名；`code` 类型项目默认含 server 组，平台 runtime 与 CLI 通道经同一目录注入。
7. 前端 `sessionRuntime.ts` 步骤标签映射增加两条中文名。

## 错误处理与安全边界

- 主机不存在：返回 `主机不存在：<id>`；凭据缺失沿用既有文案（`未配置私钥路径` 等）。
- 密钥零暴露：AI 参数中不存在凭据字段；返回值仅含 hostId/name/host/connected；连接失败文案不回显密码（`ssh::connect` 既有约定）。
- 审批模型不变：`ssh_exec` 高风险命令仍写 `tool_approval` 等用户批准；connect/disconnect 为常规 medium 风险操作，与 GUI `server_connect` 权限对齐，不扩大权限。

## 复用机制与取舍

- 连接建立完全复用 `ssh::connect`（含 russh 配置、认证、连接表登记）；不在 AI 侧另建第二套连接实现。
- 备选「在 ssh_exec 内自动补连」被否决：显式连接工具可让 AI 感知连接失败原因（认证失败/网络不通）并让断开成为可控动作，避免隐式副作用。

## 验证

- `cargo check --lib` exit 0；`cargo test --lib` 629 通过 / 0 失败（含 `registry_and_tool_catalog_stay_in_sync`、`server_tools_roundtrip`、平台工具注入 88 项）；`npx tsc --noEmit` exit 0。详见 [REPORT-CR105](../Test/REPORT-CR105-服务器连接工具验证.md)。

## 未决项与假设

- 真实远程主机的连接成功路径未在本环境实测（无可用服务器凭据），依赖 `ssh::connect` 既有已验证实现；用户可在服务器工作台观察 AI 建立的连接（平台 runtime 与 GUI 同进程，连接状态互通；CLI stdio 通道内 AI 连接仅该工具进程可见，属既有进程隔离语义）。
