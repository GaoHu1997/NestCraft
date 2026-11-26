# LLD-BUG004：首轮运行态与失败证据修复方案

- 关联：[BUG-004](../PRD/BUG-004-首轮运行中与首轮失败被误判待重建.md)、[BUG-003](LLD-BUG003-会话绑定判定修复.md)、[CR-037](LLD-CR037-主代理协作契约.md)、[CR-068](../PRD/CR-068-界面评审差异与会话可用性补正.md)
- 覆盖 AC：AC-BUG004-01～06
- 状态：**修复中**（2026-11-26 用户授权）
- 基线：`HEAD 1357cd9` + 工作区未提交差异

## 1. 当前实现与断点

| 环节 | 现状 | 断点 |
| --- | --- | --- |
| 派生视图 | `chat_binding::derive_view`（`chat_binding.rs:573`）只按角色/通道/引用/消息数判定 | 不认识「本轮运行中」，运行中的首轮被判待重建 |
| 元数据 | `session_row`（`chat.rs:117`）无运行态输入 | 所有列表/详情读取都可能显示横幅 |
| 首轮失败 | `failure_turn`（`chat.rs:1050`）首轮 create 失败直接返回 | 无 turn 证据，永久 `REF_NOT_ESTABLISHED` |
| 发送前 | `resolve_binding`（`chat_binding.rs:170`）用 `message_count>0` 当历史 | 首轮失败后重发被拒 |
| 重建确认 | `confirm_fresh`（`chat_binding.rs:527`）无运行态保护 | 运行中确认会改修订，本轮结算 LATE |

## 2. 选定方案

### 2.1 运行态不派生

- `chat.rs` 新增 `pub(crate) fn is_running(session_id: &str) -> bool`，基于既有 `RUNNING`（锁顺序仍是 DB → RUNNING，与 `reserve_turn` 一致）。
- `session_row` 先取 `id`，把 `running` 传给 `derive_view`。
- `derive_view` 在 `platform` 分流之后：`if running { return None; }`。运行中不显示任何绑定横幅，也不锁输入；运行结束后自然恢复原有派生结果。

### 2.2 首轮失败留下明确证据

- `failure_turn`：`ordinary && requested_resume.is_none()` 时写 `mode=create、outcome=archived、reasonCode=CREATE_FAILED` 的 turn 行，然后返回 `None`（不新增前端事件，错误卡仍由原路径产生）。
- 只在该轮**没有任何模型输出**时发生（`persist_and_settle` 未执行、assistant 消息未落库），因此证据语义是「确定未建立上下文」。

### 2.3 按证据放行重试

- `derive_view`：无引用且最新 turn 为 `CREATE_FAILED` → 返回 `None`（不显示横幅、可重发）。
- `resolve_binding` 增加参数 `create_failed: bool`：无引用、支持续接的 CLI、`has_history` 为真时，先判 `create_failed` → `Send { mode: "create", requested: None }`；其余仍 `FreshPending + REF_MISSING`。
- `chat_send` 在绑定解析前查询最新 turn 的 reasonCode（新增小查询），传 `create_failed = matches!(reason, Some("CREATE_FAILED"))`。

### 2.4 运行中禁止重建

- `confirm_fresh` 开头检查 `crate::commands::chat::chat_status(session_id)`，为真则返回「本轮仍在运行，无法重建上下文；请等待本轮结束或先停止发送」，不写任何列。

### 2.5 前端

- `ChatPanel.tsx` 的 `binding` 求值增加 `running` 兜底：运行中一律视为无绑定（覆盖旧构建/旧缓存残留），横幅与锁随之消失。

## 3. 影响面

- 后端：`chat_binding.rs`（`derive_view`/`resolve_binding` 签名与逻辑、`confirm_fresh`、单测）、`chat.rs`（`is_running`、`session_row`、`failure_turn`、`chat_send`）。
- 前端：`ChatPanel.tsx` 一行求值。
- 数据：无迁移；`execution_session_turn.reasonCode` 增列值 `CREATE_FAILED`（TEXT 列，无约束变更）。
- 不涉及：平台通道、执行会话、续接协议、兼容键、授权。

## 4. 测试设计

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| U1 运行中 | `derive_view("ordinary","cli",true,...)` | `None` |
| U2 首轮失败证据 | `derive_view(..., last_reason=Some("CREATE_FAILED"), message_count=1)` | `None` |
| U3 已停止无引用 | `last_reason=Some("STOPPED")` | `freshPending + REF_MISSING` |
| U4 重发放行 | `resolve_binding(..., has_history=true, create_failed=true)` | `Send { create }` |
| U5 无证据仍拦 | `create_failed=false` | `FreshPending` |
| U6 运行中重建 | `confirm_fresh` 且 RUNNING 含该会话 | Err，字段不变 |
| U7 回归 | platform / executor / native / fresh / blocked | 与 BUG-003 一致 |
| U8 前端 | 运行中的会话 | 无横幅、输入可用 |

## 5. 验证与回退

- 运行 `cargo test --lib --offline commands::chat_binding`、`npx tsc --noEmit`、`npm run build`。
- 回退：移除 `running` 参数与 `CREATE_FAILED` 分支、恢复 `failure_turn` 原返回、去掉前端 `running` 兜底；无数据回滚需求（新增 reasonCode 不影响旧读取）。

## 6. 未决项

- 首轮失败时是否保留 CLI 部分流式输出：本次不改，避免扩大范围；需要时另立 Story。
