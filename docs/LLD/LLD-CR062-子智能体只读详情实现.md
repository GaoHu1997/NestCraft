# LLD-CR062：子智能体只读详情实现方案

- 关联需求：[CR-062](../PRD/CR-062-AI侧栏子智能体只读详情.md)；设计：[UI-CR062](../UI/文档/UI-CR062-AI侧栏子智能体只读详情.md)；Story：[STORY-080](../Plan/Story/STORY-080-子智能体只读详情.md)。
- 授权依据：2026-11-22 用户明确“一次性做完所有，需求/设计/编码，全部授权你完成”。
- 影响文件：`src/modules/chat/ChatPanel.tsx`、`src/modules/chat/SubagentPanel.tsx`（新增）、`src/modules/chat/MessageList.tsx`、`src/modules/chat/sessionRuntime.ts`、`src/modules/chat/chat.css`、`src/api/index.ts`、`src-tauri/src/commands/chat.rs`。

## 1. 现状与约束

- 侧栏是单个 `Panel`，头部固定为历史、子智能体计数、后台计数、FEAT 标签、绑定胶囊、新建；卸载会丢运行中的 turn、草稿与滚动位置。
- 子智能体只有 `SubagentRow` 摘要；消息流卡片不可展开。
- 后端 `parse_cli_line` 只解析主会话消息；`ChatEvent::Subagent` 变体虽存在但未发送。
- 浮层 Escape 由 `overlay.tsx` 统一消费；新增返回必须低于浮层与弹窗优先级。

## 2. 选定方案

### 2.1 视图栈：主会话隐藏而非卸载

- `ChatPanel` 外层持有 `agentView: { parentId, agentId } | null`。
- 主会话 `Panel` 始终挂载，`visible={!agentView}`，依靠既有 `.chat-panel[hidden] { display: none }` 隐藏；流式事件、队列、轮询、草稿与滚动位置继续保留。
- 子视图 `SubagentPanel` 以同一 `.chat-panel` 容器、同一宽度渲染，切换时栏宽不跳动。
- 这样避免把 30 多个主会话状态复制进子视图，也不引入新的会话实体。

### 2.2 只读详情

- `SubagentPanel` 只读 `getRuntime(parentId).subagents`，每 500ms 复读一次（隐藏期间事件继续写入）；不调用发送、已读、绑定接口。
- 头部：返回图标 + `nav` 面包屑（第一级固定“主会话”）+ 状态点；不渲染计数按钮、FEAT、绑定、新会话。
- 内容：元信息条 + 说明 + 事件时间线；无事件时回退 `output`；记录被清理时显示失效提示。
- 底部：只读提示 + 返回按钮。
- Escape 监听检查 `defaultPrevented` 与 `dialog[open]/[aria-modal]`，保证弹窗与浮层优先。

### 2.3 事件模型

`SubagentRow` 增加：

- `taskId?: string | null`：任务标识，未知不显示。
- `events?: SubagentEvent[]`：`{ at, kind: status|text|tool|result|output, status?, text?, toolName?, isError? }`。

`upsertSubagent`：状态变化追加 status 事件；`content` 追加 text/tool 事件；`output` 变化追加 output 事件；同 kind+text+toolName 的尾部 20 条内重复跳过；上限 200 条。`settleSubagents(sid, stopped)` 在 `finalize` 时把仍 running/待确认 的记录置为“待确认”或“已停止”，只追加一次状态事件。

### 2.4 后端事件

`chat.rs` 的 `parse_cli_line`：

- `assistant` / `user` 消息若带非空 `parent_tool_use_id`，视为子智能体消息：发送 `subagent` 事件（`id=parent_tool_use_id`、`task=首行摘要`、`status=running`、`cli`、`content`、`kind`、`toolName`、`isError`），随后 `return`，不并入主会话正文、工具、工具结果与用量。
- 工具摘要只取 `command/file_path/path/query/pattern/description` 之一并截断 160 字，避免把完整输入（可能含凭证）送进界面；工具结果截断 4000 字。
- 未出现 `parent_tool_use_id` 时行为与现状完全一致；该字段属于协议可选字段，缺失不报错，不声称所有 CLI 版本都支持。

### 2.5 入口

- 顶部子智能体下拉行改为 `button`，点击关闭浮层后打开详情。
- 消息流子智能体卡片新增「查看」按钮，需 `producerId` 存在；无 id 不显示入口。

## 3. 兼容与边界

- 不新增数据库表；不改变会话、任务、统计与权限。
- 旧会话无 `events` 时按空数组处理；旧事件缺字段按未知显示。
- 刷新/重启后详情记录不恢复；UI 明确标注“仅本次运行可见”。
- 不实现多级面包屑、兄弟切换、向子智能体发指令；`parentId` 保留供后续。

## 4. 验证

- `npx tsc --noEmit`、`npm run build`。
- 前端：点击下拉行/卡片进入、返回、Escape、无事件、失效、运行中更新、栏宽不跳。
- 后端：`cargo check`（或 `cargo test --offline --lib`）确认编译；CLI 子代理消息格式未实测，标注未验证。
- 视觉：原型与软件同视口截图对照；滚动按 UI-SCROLL-001 做动态验证；无 Tauri 运行环境时如实标注未验证项。