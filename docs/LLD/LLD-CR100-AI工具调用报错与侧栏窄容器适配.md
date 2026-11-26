# LLD-CR100：AI 工具调用报错与侧栏窄容器适配

- 关联需求：[CR-100](../PRD/CR-100-AI工具调用报错与侧栏窄容器适配.md)；AC 以该文档为单源。
- 本次设计范围：平台工具循环的请求合法性与止损；AI 侧栏（含工作台共用实例）的窄容器布局。

## 1. 当前实现与受影响模块

| 模块 | 现状 | 本次改动 |
| --- | --- | --- |
| `src-tauri/src/commands/platform_agent.rs` | 工具循环 8/8/24；参数仅 Anthropic 清洗；assistant 恒带 `tool_calls`；超限直接 `Err` | 统一参数净化；修正 assistant 消息形状；新增重复失败与整轮全错止损；超限先闭合配对 |
| `src-tauri/src/commands/platform_context_runtime.rs` | `system()` 用静态工具分组列全量名 | 新增 `tool_names` + `system_with_tools()`，目录与本轮 tools 同源 |
| `src-tauri/src/commands/platform_context.rs` | `legacy_messages` 要求每个 tool_result 都有 tool_use | 跳过无对应 tool_use 的拒绝结果 |
| `src/modules/chat/chat-narrow.css`（新增） | 窄栏规则分散且多为视口断点 | 以 `.chat-panel` 为容器，补 320/372/480 档 |
| `src/modules/chat/ChatPanel.tsx` | 引入会话样式 | 末尾引入 `chat-narrow.css` 保证层叠顺序 |

## 2. 运行时方案

### 2.1 请求合法性

```rust
fn normalized_tool_arguments(arguments: &str) -> String {
    // 空串 / 非法 JSON / 非对象 → "{}"；合法对象 → 规范化字符串
}
```

- `budgeted_body` 对两种协议统一遍历 assistant 的工具调用做净化（原先只有 Anthropic 分支）。
- 执行侧不改：`execute_tool_safely` 仍用原始参数，非法参数照样回填「参数不是有效 JSON」，便于定位。

### 2.2 assistant 消息形状

- 有调用：`content` 在无文本时为 `null`，并带 `tool_calls`。
- 无调用：不输出 `tool_calls` 字段。

依据：严格 OpenAI 兼容端点会拒绝空 `tool_calls` 数组与异常 `content`。

### 2.3 能力目录同源

- `Prepared::set_tool_names(defs, include_context)` 从本轮 `defs` 生成名称集合。
- 发送前与每轮重算 defs 后各刷新一次，并据此重建消息投影。
- 目录按静态分组渲染（仅保留实际下发项），未命中分组的名称（MCP）单独列「扩展」。

### 2.4 止损与收尾

| 规则 | 阈值 | 行为 |
| --- | --- | --- |
| 同工具同参数连续失败 | 2 次 | 第 3 次起不执行，回填换方案提示 |
| 连续整轮全错 | 3 轮 | 结束本轮，标注未完成 |
| 轮次 / 单轮 / 累计 | 8 / 8 / 24 | 先 `close_pending_pairs`，再返回含「本轮未完成」的原因 |

成功调用会清除该参数的失败计数；上限常量保持不变。

## 3. 侧栏方案

- 以 `.chat-panel` 为 `inline-size` 容器（侧栏与工作台是同一实例，随宿主宽度变化）。
- 320/372/480 三档只调整内边距、缩进、刻度宽度与 chip 最小宽度，不动字号、圆角与配色。
- 浮层只限制最大尺寸，坐标仍由既有锚定与视口夹取负责。
- 长内容在自身区域内换行或滚动，不新增 `overflow:hidden` 禁用滚动（UI-SCROLL-001）。

## 4. 验证

| AC | 方式 | 结果 |
| --- | --- | --- |
| 01 | 单测 `cr099_empty_arguments_are_normalized_for_both_protocols`（编号沿用实现期命名） | 通过 |
| 02 | 单测 `cr099_empty_tool_calls_are_not_replayed` | 通过 |
| 03 | 由本轮 defs 同源实现保证；重算路径共享 | 代码层成立，未单独断言 |
| 04/05 | 由循环分支实现；真实多轮失败未构造夹具 | 未验证 |
| 06 | 三条上限均改为先闭合再返回 | 代码层成立，未构造上限夹具 |
| 07 | 单测 `cr099_rejected_tool_result_does_not_break_history_replay` | 通过 |
| 08～10 | `scripts/cr100-design-check.mjs` 38/38；`scripts/verify-cr100-software.mjs` 40/40 | 通过 |

## 5. 未决项与风险

1. `invalid_request` 是否为本次可疑路径所致，需真实失败请求复现后才能确认；净化只保证请求结构合法。
2. 04/05/06 的阈值（2 次 / 3 轮）是保守默认值，尚未经真实使用校准。
3. 真实 Tauri WebView2 渲染、真实长会话与模型端到端未验证。
4. 设计编号曾计划 CR-099，实际被占用后改用 CR-100；测试函数名保留实现期 `cr099_` 前缀，不影响语义，后续可统一改名。
