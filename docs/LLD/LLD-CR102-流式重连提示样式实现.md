# LLD-CR102：流式重连提示样式实现

- 关联：[CR-102](../PRD/CR-102-会话流式重连提示样式修正.md)／[UI-CR102-v1](../UI/文档/UI-CR102-流式重连提示样式.md)／[STORY-062 CR-102 增量](../Plan/Story/STORY-062-会话答复呈现与文件定位.md)。
- 授权：用户 2026-11-26 明确「授权开发」；设计基线 UI-CR102-v1（sha256 前16 92ec5bf37ebd56af）。

## 1. 现状（只读核对，代码事实）

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `src-tauri/src/commands/chat.rs` `parse_cli_line` 通用 `(_, "error")` 分支（约 2249 行） | codex 内核 JSONL 的 `{"type":"error","message":"Reconnecting… 1/5 (unexpected status 502 …, url: …, request id: …)"}` 帧被原样转发为 `{type:"error", message}` | 内核自动重连（非终态）被当成终态错误 |
| `src/modules/chat/ChatPanel.tsx:1015` | `case "error": void finalize(turn, ev.message)` | 任何 error 事件直接终止整轮并推错误卡 |
| `src/modules/chat/MessageList.tsx` `role==="error"` 分支（约 863 行） | `.chat-card.error` 粉块 + `content` 整段原文 + 「重试」按钮 | 用户截图的样式问题本体 |
| `ChatPanel.tsx:1011-1014`、`src/api/index.ts:901` | 平台层自有重试 `retrying` 事件（`attempt/maxAttempts/delayMs/reason`，max=2）渲染为 system 行 | 文案与内核重连不统一，非设计新样式 |
| `src-tauri/src/commands/chat.rs:1776` `retry_reason` | 平台层失败原因识别 | 复用其思路做内核错误摘要 |

内核语义（关键）：codex 的 `Reconnecting… n/5` 是**进行中**的自动重连通知，重连成功后内核继续输出；真正放弃时会另发终态 error。因此「Reconnecting 帧」必须从终态 error 中分离出来。

## 2. 选定方案

### 2.1 后端（`chat.rs`）

1. 新增 `fn split_reconnect(message: &str) -> Option<(i64, i64, &'static str/String)>`：识别 `Reconnecting… n/m …`（大小写不敏感、省略号宽容），提取 `attempt/max`；对括号内原文做中文摘要映射：
   - 含 `502/503/504/bad gateway/unavailable` → `上游暂时不可用（<code>）`；
   - 含 `timeout/timed out` → `请求超时`；含 `429/rate limit` → `请求过于频繁（429）`；
   - 其余 → `连接中断`。
2. `parse_cli_line` 的 codex `error` 分支先过 `split_reconnect`：命中且 `attempt < max` → 发 `{type:"retrying", attempt, maxAttempts:max, delayMs:null, reason:<摘要>, detail:<原文>}`，**不**发 `type:"error"`（不终止本轮）；`attempt == max` 或未命中 → 维持现有 `type:"error"` 透传（终态错误卡由现行链路承担）。
3. 平台层 `retrying` 事件（`chat.rs:819`）补充 `detail`（`fail.message` 已有摘要，直接带上），字段语义与内核重连统一。
4. 不改 `retry_reason`、不改平台重试次数/退避、不改错误卡。

### 2.2 前端

1. `src/api/index.ts`：`retrying` 事件类型改为 `{ attempt; maxAttempts; delayMs: number|null; reason; detail?: string|null }`。
2. `ChatPanel.tsx`：
   - `retrying` 分支改为**每轮单实例 upsert**（id `retrying-<sid>-<generation>`），消息字段：`kind:"retrying"`、`content=reason`，新增 `UiMessage` 可选字段 `retryAttempt/retryMax/retryDetail/retryRecovered`；
   - 在收到任一后续非 retrying 事件（delta/thinking/toolUse/toolResult/planUpdate/subagent/done 之前）时，把未恢复的 retrying 消息转为 `kind:"recovered"`、`content="途中上游中断，已自动重试 n 次后恢复"`（SC-102-04；设计稿默认留痕）；
   - `error` 终态路径不动（AC-CR102-03 由现行错误卡满足）。
3. `MessageList.tsx`：在 `context-breakpoint` 分支前新增两个渲染分支：
   - `kind==="retrying"`：`.chat-retry-line`（`<details>`）：`summary` = 旋转 `⟳` + `正在重试 n/m · <reason>`（tabular-nums）+「详情」；展开区结构化明文（原因、接口原文、request id、完整原文）+「复制错误详情」；无任何底色；
   - `kind==="recovered"`：同结构，`✓`（ok 色）+ 恢复文案；
   - 不渲染进行中的「立即重试」按钮（见 §4 偏差 1）。
4. `chat.css`：新增 `.chat-retry-line`（透明背景、无边框、`--muted` 13px、动作 `--accent` 文字链）、`.chat-retry-detail pre`（`--mono` 12px、`--muted`、左 2px `--line-2` 细线、max-height 170px、超高自身滚动、`overflow-wrap:anywhere`）、`@keyframes` 复用 `chat-spin`、`prefers-reduced-motion` 静止、`.chat-retry-recovered`（`--ok` ✓）。滚动条按 UI-CR049：`scrollbar-width:thin`，静止透明、滚动显 `--muted-2` 系活动色、700ms 隐藏、悬停不唤醒（若 chat.css 已有共享按需显隐工具类则复用，不重复实现）。

## 3. 允许改动文件清单（本次授权范围）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/commands/chat.rs` | `split_reconnect` 新增 + codex error 分支分流 + 平台 retrying 带 detail + 单元测试 |
| `src/api/index.ts` | retrying 事件类型扩展 |
| `src/modules/chat/ChatPanel.tsx` | retrying upsert + recovered 转换 |
| `src/modules/chat/MessageList.tsx` | 两个渲染分支 |
| `src/modules/chat/chat.css` | 新样式块 |
| 文档 | CR-102/STORY-062/需求汇总/设计索引状态回写、本 LLD、Test 报告 |

不改：重试策略与次数、错误卡视觉、`retry_reason`、其他通道（claude/grok）解析、DB 结构。

## 4. 已采用假设与偏差（待用户可推翻）

1. **进行中不设「立即重试」**：内核重连发生在子进程流内部，平台无「跳过等待立即重连」的通道；中途手动重启等价打断重发，超出本 CR 安全范围。手动重试入口保留在终态错误卡（现状已有）。设计默认②据此记录偏差。
2. **成功留痕采用默认**：恢复后留一行灰色小字（设计稿 SC-102-04 默认），未收到用户相反意见前实现。
3. 摘要映射表为代理细化（502/503/504、timeout、429、默认连接中断），纯展示层。
4. `delayMs` 内核重连未知，置 `null`，行内不显示等待时长；平台重试保留「n ms 后重试」入详情。

## 5. 验证方法

1. `cargo test --lib`（新增 `split_reconnect` 单元测试：502 样例、timeout、无状态码、非重连错误不命中）。
2. `tsc --noEmit` + `npm run build` exit 0。
3. 定向组件/合成事件测试：模拟 codex `Reconnecting… 1/5 (502 …)` 帧 → 后端发 retrying → 前端显示无色块行；后续 delta → 转 recovered；`attempt=5` → 仍走错误卡。
4. 软件侧成对视觉对照：实际组件渲染 retrying/recovered/error 三态，与 [session-reconnect-design](../UI/session-reconnect-design/index.html) 浅/深、桌面/390 成对截图；展开详情滚动条按需显示留动态证据（录屏或滚动序列截图）。
5. 未验证项如实记录（真实上游 5xx、真实 Tauri WebView、历史回放不含 retrying 行）。

## 6. 实现记录（2026-11-26，已落地）

- 已按本方案实现，结果见 [REPORT-CR102](../Test/REPORT-CR102-流式重连提示样式实现与验证.md)：cargo chat 模块 53/53（含新增测试）、tsc/build exit 0、组件定向回归 7/7（`scripts/cr102-retry-line.mjs`）、真实组件浅/深/窄成对截图与详情区滚动条动态证据（`active→idle-hidden`）通过。
- 实现中发现并修正一处方案缺口：`retrying/recovered` 消息若留在过程块内，会被 `ExecutionProcess` 的过程折叠（`chat-turn-process`，默认关闭）藏住。已在 `MessageList.tsx` 把这两类消息从过程块过滤并提升到回合主流程（用户消息→过程折叠→**重连行/恢复留痕**→最终答复/错误卡），与本 CR「用户必须看到重试状态」的目标一致，允许文件清单不变。
- 进行中「立即重试」维持 §4 偏差 1：未实现，手动重试保留在终态错误卡。

