# STORY-115：AI 工具调用报错与侧栏窄容器适配

- 类型：缺陷＋界面适配（增量）
- 所属 Feature：[FEAT-025 平台主代理运行时](../Feature/FEAT-025-平台主代理运行时.md)（运行时部分）／FEAT-010 侧栏会话（界面部分）
- 所属 PRD：[CR-100](../../PRD/CR-100-AI工具调用报错与侧栏窄容器适配.md)
- 来源与确认依据：2026-11-26 用户附三张截图反馈 AI 报错，并指出「AI 侧栏模式下样式会被积压，需要适应侧栏的样式」；同轮回复「授权编码」。
- 负责人／优先级／状态：主代理／高／**待验收**（技术验证通过）
- 依赖：无新增外部依赖。

## 目标

作为项目使用者，我希望 AI 会话在工具调用失败或模型拒绝请求时给出可理解、可继续的结果，并且侧栏在任意允许宽度下都能正常阅读与操作，以便我不必为了看清内容而反复放大窗口。

## 本次包含

1. system 能力目录与本轮实际下发工具同源（停用工具不再出现在提示里）。
2. OpenAI／Anthropic 统一净化回放的工具参数；修正 assistant 消息中空 `tool_calls`。
3. 同工具同参数连续失败、连续整轮全错时提前止损；达到上限时先闭合工具交换再标注未完成。
4. 历史回放跳过无对应 tool_use 的拒绝结果。
5. AI 侧栏按面板宽度（320/372/480/620）适配运行栏、消息缩进、轮次刻度、浮层与长内容。

## 不包含

- 提高 8/8/24 上限。
- 修改 CLI 通道、知识库工具实现或会话架构。
- 声称修复 `invalid_request`（只消除已知的不合法回放路径）。

## 验收标准

见 [CR-100 §4](../../PRD/CR-100-AI工具调用报错与侧栏窄容器适配.md) AC-CR100-01～10。

## 方案

- [LLD-CR100](../../LLD/LLD-CR100-AI工具调用报错与侧栏窄容器适配.md)
- [UI-CR100-v1](../UI/文档/UI-CR100-AI侧栏窄容器适配.md)
- 未新增 DB 结构与迁移：本 CR 不改持久化模型，DB 不适用。

## UI 准入

- 受影响场景：SC-100-01～07（见 UI-CR100）。
- 可视设计资源与版本：`docs/UI/workbench-v4/cr100.css`（UI-CR100-v1），装配于唯一入口 `docs/UI/仿真原型UI.html`；排在 `cr096.css` 之后。
- 覆盖检查：宽窗口下 320/372/480/620 × 浅/深 × 侧栏布局，设计断言 38/38。
- 确认/执行授权：2026-11-26 用户「授权编码」。
- 先设计后软件：设计稿与设计验证完成后才修改 `src/**`。
- 对照计划：设计侧 `scripts/cr100-design-check.mjs`、软件侧 `scripts/verify-cr100-software.mjs`，同条件同阈值。
- UI-SCROLL-001：消息区、刻度、分支下拉仍用原生滚动；本版未新增禁用滚动的 `overflow:hidden`。

## 实现位置

- `src-tauri/src/commands/platform_agent.rs`：参数净化、assistant 形状、止损与收尾、`normalized_tool_arguments`。
- `src-tauri/src/commands/platform_context_runtime.rs`：`tool_names`、`system_with_tools`、`set_tool_names`。
- `src-tauri/src/commands/platform_context.rs`：孤儿 tool_result 跳过。
- `src/modules/chat/chat-narrow.css`（新增）、`src/modules/chat/ChatPanel.tsx`（引入顺序）。
- `docs/UI/workbench-v4/cr100.css`（设计稿）、`docs/UI/workbench-v4/index.html`（装配）。

## 验证结果

| AC | 方式 | 结果 | 证据 |
| --- | --- | --- | --- |
| 01 | Rust 单测 ×2 | 通过 | REPORT-CR100 §1 |
| 02 | Rust 单测 | 通过 | 同上 |
| 03 | 代码同源实现 | 成立，未单独断言 | LLD-CR100 §2.3 |
| 04／05／06 | 代码实现 | **未验证**（无多轮失败夹具） | 同上 |
| 07 | Rust 单测 | 通过 | REPORT-CR100 §1 |
| 08～10 | 设计 38/38、软件 40/40 | 通过 | REPORT-CR100 §2、§3 |

## 验收结论及依据

**待验收**。技术验证通过，`invalid_request` 成因未确认，AC-04/05/06 未做端到端验证。

## 阻塞、遗留事项和下一步

1. 需真实失败请求确认 `invalid_request` 根因（下一步：抓取脱敏消息结构）。
2. 建议用真实多轮失败会话校准 2 次／3 轮阈值。
3. 真实 Tauri WebView2 渲染与拖动过程连续帧待实测。
