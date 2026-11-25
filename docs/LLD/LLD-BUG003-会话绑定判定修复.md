# LLD-BUG003：会话绑定判定修复方案

- 关联：[BUG-003](../PRD/BUG-003-会话被误判为待重建上下文.md)、[CR-069](../PRD/CR-069-平台主代理运行时与受管执行接入.md)、[CR-037](LLD-CR037-主代理协作契约.md)、[CR-068](../PRD/CR-068-界面评审差异与会话可用性补正.md)
- 覆盖 AC：AC-BUG003-01～05
- 状态：**已实现，技术验证通过，待验收**（2026-11-25 用户授权完整修复；设计 UI-BUG003-v1 先行登记；结果见 [REPORT-BUG003](../Test/REPORT-BUG003-会话绑定误判诊断.md)）
- 基线：`HEAD 3dcf819` + 工作区未提交差异

## 1. 当前实现与断点

| 环节 | 现状 | 断点 |
| --- | --- | --- |
| 后端派生 | `chat_binding::derive_view`（`chat_binding.rs:565-601`）只按普通会话/引用/消息数判定 | 不区分 `runner`，平台会话被套用 CLI 原生绑定语义 |
| 调用 | `chat.rs:126-135` 传入 `session_role` 等，未传 `runner` | 即使列已查出（`s.row.runner`，`chat.rs:157`）也未参与判定 |
| 发送 | `chat_send` 已先按 `runner` 分流（`chat.rs:593-606`） | 后端不会拦平台会话；拦截来自前端读到的派生视图 |
| 前端 | `ChatPanel.tsx:288-292`、`973-985`、`1221-1229` | 无条件信任 `binding`，平台会话因此锁输入并弹确认 |
| CLI 首轮 | `settle_turn` 写 turn 行与引用 | 首轮中断则无 turn、无引用，仍报 `REF_MISSING`，未区分原因 |

## 2. 选定方案

### 2.1 后端：派生视图按通道分流（最小改动）

`derive_view` 增加第一个参数 `runner: &str`；`runner == "platform"` 直接返回 `None`。

```rust
pub fn derive_view(
    session_role: &str,
    runner: &str,
    cli_id: &str,
    thread_ref: Option<&str>,
    /* …其余不变… */
) -> Option<SessionBindingView> {
    if session_role != "ordinary" { return None; }
    // BUG-003：平台通道不使用 CLI 原生线程，CLI 绑定状态不适用。
    if runner == "platform" { return None; }
    /* …既有逻辑… */
}
```

调用点 `chat.rs:126-135` 传入 `row.get::<_, Option<String>>(23)?.unwrap_or("cli")` 得到的 runner（与 `SessionMeta.runner` 同源），避免两处取值不一致。

**不改** `resolve_binding`：`chat_send` 已在任何绑定解析之前按 `runner` 分流，平台会话不会走到它；保留现状可让 CLI 语义零回归。仅在 `chat_binding.rs` 文件头补一句边界说明。

### 2.2 前端：双保险

```ts
const binding =
  cur?.sessionRole === "executor" || cur?.runner === "platform"
    ? null
    : cur?.binding ?? null;
```

理由：后端改动生效前，旧库/旧缓存仍可能带 `binding=freshPending`；前端按 `runner` 兜底可避免升级瞬间仍锁输入。不新增任何可见控件。

### 2.3 CLI 首轮未结算：新增原因码区分

- 新增原因码 `REF_NOT_ESTABLISHED`，加入 `REASON_CODES`（`chat_binding.rs:23-34`），文案：`尚无原生线程引用（首轮未完成或历史来自旧版本）`。
- `derive_view` 在 `cli_supported(cli_id)` 且 `last_outcome.is_none()`（即该会话不存在任何 `execution_session_turn`）时使用该码；已有结算记录仍用 `REF_MISSING`。
  - 依据：`SESSION_COLUMNS` 已用子查询取最新 turn 的 `outcome`/`reasonCode`（`chat.rs:163-164`），`last_outcome == None` 等价于「无 turn 行」，无需新增查询列。
- `reason_text`、前端 `REASON_TEXT`（`ChatPanel.tsx:80-91`）同步。
- 前端仍以 `freshPending` 处理：不改变「不静默 fresh」，只把原因说准。

### 2.4 文案与出路（不改变流程）

| 状态 | 标题 | 原因 | 主按钮 |
| --- | --- | --- | --- |
| platform | 不显示 | — | — |
| cli 无 turn 无引用 | 上下文待确认重建 | 尚无原生线程引用（首轮未完成或历史来自旧版本） | 确认重建… |
| cli 已结算无引用 | 上下文待确认重建 | 引用缺失（历史无原生绑定） | 确认重建… |
| blocked | 原线程不可续接，已暂停发送 | 既有原因码 | 重建上下文… |

## 3. 影响面

- 后端：`chat_binding.rs`（签名、原因码、单测）、`chat.rs`（调用点一行）。
- 前端：`ChatPanel.tsx`（binding 求值、REASON_TEXT 增一项）。
- 数据：无迁移；不写、不清任何 `nativeThreadRef`；平台会话仍不写 `execution_session_turn`。
- 其他调用方：`derive_view` 仅 `chat.rs` 一处调用（已核对），签名变更影响面可控。

## 4. 实施步骤与顺序

1. 更新 UI 说明与原型场景（SC-069-08，见 §6），登记版本；未完成不得改软件。
2. 后端签名与原因码 + 调用点；补单测。
3. 前端 binding 求值与文案。
4. 隔离预览验证（平台会话无横幅、CLI 中断态显示新文案、正常续接不变）。
5. 真实库只读复核（不写用户库）。
6. 更新 BUG/README/需求汇总/验证记录。

## 5. 测试设计

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| U1 平台不派生 | `derive_view("ordinary","platform","codex",None,1,None,None,10)` | `None` |
| U2 CLI 首轮未结算 | `derive_view("ordinary","cli"/"codex","codex",None,0,None,None,10)` | `freshPending` + `REF_NOT_ESTABLISHED` |
| U3 CLI 已结算无引用 | 同上但 `last_outcome=Some("archived")` | `freshPending` + `REF_MISSING` |
| U4 原生续接 | `thread_ref=Some(..)` | `native`，行为不变 |
| U5 阻塞 | `last_outcome=Some("blocked")` + 有引用 | `blocked`，原因不变 |
| U6 用户已确认 fresh | `confirmed_turn_id=Some("fresh-1")` | `fresh` |
| U7 执行会话 | `session_role="executor"` | `None`（含 platform 分支不回归） |
| U8 前端 | 平台会话有 10 条消息 | 无横幅、输入不锁、可发第二轮 |
| U9 回归 | 正常 claude/codex 连续两轮 | 第二轮 `resume`，不出现横幅 |

真实环境验证（需授权后另做）：平台会话隔离 IPC 连发两轮；CLI 首轮中断后第二轮显示新原因；真实 Tauri 窗口视觉。

## 6. UI 准入（§6.3.1）

- 受影响场景：`SC-069-08 平台会话的绑定状态呈现`（不显示 CLI 横幅）、`SC-069-09 CLI 首轮未完成的原因文案`。
- 设计资源：**UI-BUG003-v1**，[chat-binding-bug003/index.html](../UI/chat-binding-bug003/index.html)，`sha256=d0e2215ed2c7a71aed131b2ac97c101f943bdbe5e099cac5ab09864b697036f6`；截图 [design-light.png](../Test/screenshots/bug003-design/design-light.png)。已登记于 [UI-CR069 §SC-069-08／09](../UI/文档/UI-CR069-平台主代理会话准入.md) 与 [设计资源索引](../UI/文档/设计资源索引.html#bug003)。
- 覆盖：A CLI 已续接、B 平台正常态、C 首轮未完成、D 已结算无引用，附文案对照表；深色／390／软件对照在实现后补。
- 滚动条：本次只涉及横幅显示/隐藏与一行文案，不新增滚动容器，`UI-SCROLL-001` 记为不适用（附依据）。

## 7. 回退与风险

- 回退：`derive_view` 恢复旧签名与判定；前端去掉 `runner` 兜底；无数据回滚需求。
- 风险：新增原因码若未同步前端，会显示原始码 `REF_NOT_ESTABLISHED`；以单测 + 前端常量核对覆盖。
- 风险：老会话（CR-037 之前）会显示新原因码；文案已包含「历史来自旧版本」，不误导。

## 8. 未决项

1. 是否把「首轮未完成」与「旧版本历史」拆成两个原因码（当前合并，避免码表膨胀）。
2. 平台会话是否需要独立的「上下文来源」说明入口（本次不做）。
