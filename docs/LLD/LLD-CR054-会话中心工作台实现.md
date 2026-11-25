# LLD-CR054：会话中心工作台正式实现

- 关联：[CR-054](../PRD/CR-054-会话中心工作台.md) / [FEAT-021](../Plan/Feature/FEAT-021-会话中心工作台.md) / [STORY-071](../Plan/Story/STORY-071-工作台页签与三栏布局.md) / [STORY-072](../Plan/Story/STORY-072-右侧预览面板.md) / [STORY-073](../Plan/Story/STORY-073-AI请求面板与工具可视化.md)
- 采用设计：[UI-CR054-v1](../UI/文档/UI-CR054-会话中心工作台.md)（原型同步稿已通过 22 项自检）
- 编码授权：2026-11-23 用户「代码实现没，没实现需要实现」。

## 1. 目标与范围

在正式软件（React + Tauri）中落地：

1. 项目窗口新增「工作台」页签（**CR-082 起为电脑（显示器）图标 `monitor` + 文字「工作台」**），代码与办公两类项目均默认进入；
2. 三栏：左历史会话、中当前会话、右只读辅助栏（默认关闭）；
3. 会话按项目唯一、跨页签共享、切页签不新建不中断；
4. 右栏由「用户点击会话链接」或「AI 请求」打开；
5. 保证同一会话**只有一个 ChatPanel 实例**（不出现双订阅）。

不在本次：浏览器内核、后端 AI→UI 真实事件源、跨项目会话。

## 2. 当前实现与约束（核对结论）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 项目页签为需求/设计/任务/编码（办公为文档/成果） | `src/modules/projects/Workspace.tsx:46-49` | 需新增 `workbench` 路由态 |
| `ChatPanel` 状态全在组件内（sessions、messages、draft） | `src/modules/chat/ChatPanel.tsx:83+` | **不能同时挂两个实例** |
| `sessionRuntime` 以会话 ID 为键的模块级 Map | `src/modules/chat/sessionRuntime.ts` | 运行态可跨视图存活 |
| 项目窗口以 `hidden` 保留挂载 | `src/App.tsx:163-164` | 切项目页签不卸载，会话天然连续 |
| `aiVisible` 为用户偏好，AI 无控制通道 | `src/store/app.tsx` | AI 请求开栏需新增通道 |
| 定位事件会切页签 | `src/App.tsx:71-81` | 工作台内需分流为右栏预览 |

## 3. 选定方案

### 3.1 单实例：工作台即会话视图

工作台页签激活时 **AI 侧栏不渲染**，只保留工作台主区的唯一 `ChatPanel`。否则两个实例会各自订阅 `chat:event`、各自持有 draft 与队列。

实现要点：
- `ProjectWindow` 中 `aiVisible` 生效条件加 `&& tab !== "workbench"`；
- 工作台主区渲染 `ChatPanel variant="workbench"`；
- 离开工作台时恢复用户原本的 AI 栏偏好（记在本地 ref，不写偏好存储）。

### 3.2 组件复用（不复制外观）

| 区域 | 复用 |
| --- | --- |
| 左栏历史 | 新增 `SessionList`，从 `SessionHistory` 的列表部分提取；浮层与左栏共用 |
| 中栏会话 | 直接复用 `ChatPanel`（消息、步骤、Composer、统计） |
| 右栏预览 | 复用现有只读能力（`Reader` / `CodeArea` 只读 / `OfficeViewer`） |
| 页签 | 复用 `tab-overflow`（CR-052） |
| 宽度 | 复用 `usePaneWidth`（CR-045），scope `project:${id}` + `wbHist` / `wbAux` |

### 3.3 新增状态（最小集）

`src/store/app.tsx`：

- `wbAux: Record<projectId, { open: boolean; tabs: AuxTarget[]; active: string | null }>` — 右栏状态，按项目记忆；
- `wbPanelGuard: Record<projectId, { closedAt: number; turn: string | null }>` — 用户关闭优先。

`src/modules/chat/panelRequest.ts` 内部维护请求通道，避免把临时事件塞进全局 store。

### 3.4 AI 请求开栏协议

```ts
export type PanelRequest = { kind: "ui-preview" | "browser" | "file" | "requirement"; key?: string };
export function requestPanel(projectId: string, req: PanelRequest):
  { ok: boolean; code: "opened" | "invalid_request" | "unsupported" | "declined_by_user"; message: string };
```

规则（与原型一致）：

1. 缺 `kind` → `invalid_request`；不在清单 → `unsupported`；
2. 用户在本轮（运行态按 turn，非运行态按 120s 窗口）关闭过 → `declined_by_user`，不重开；
3. 通过 → 打开右栏并记录来源条，返回 `opened`；
4. **不需要人工确认**（CR-054 §6）。

### 3.5 定位分流

工作台激活时，`onLocate` 的 `file` / `requirement` / `knowledge` / `office-file` 一律写入右栏并**不**切页签；其他页签保持现有行为。右栏提供「在编码/需求/文档中打开」显式回退。

### 3.6 页签与默认页签

- `Workspace.tsx` 的 `pwTabList` 增加 `["workbench", "工作台"]`，**CR-082 起**渲染为「`Icon name="monitor"` 16px + `<span>工作台</span>`」按钮（`aria-label`/`title`="工作台"），`gap:6px`，页签高度与下划线沿用 `.pw-tab` 既有口径（44px／10px 内缩）；
- 新建项目窗口时默认 `tab="workbench"`；**已有窗口保留用户上次页签**。

## 4. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/store/app.tsx` | 新增右栏状态与关闭守卫 |
| `src/App.tsx` | 默认 tab、AI 侧栏互斥、定位分流 |
| `src/modules/projects/Workspace.tsx` | 新增 workbench 页签与面板 |
| `src/modules/workbench/Workbench.tsx` | **新增**：三栏容器 |
| `src/modules/workbench/workbench.css` | **新增** |
| `src/modules/chat/panelRequest.ts` | **新增**：AI 请求通道 |
| `src/modules/chat/SessionList.tsx` | **新增**：从 `SessionHistory` 提取的列表 |
| `src/modules/chat/SessionHistory.tsx` | 改为复用 `SessionList` |
| `src/modules/chat/ChatPanel.tsx` | 增加 `variant` prop |
| `src/components/icons.tsx` | 新增 `atDesk`（CR-054）；**CR-082** 新增 `monitor` |
| `src/modules/workbench/workbench.css` | **CR-082**：页签改为图标＋文字，`gap:6px`，去掉最小宽度／光学补偿／下划线覆盖 |
| `public/ui/icon-sprite.svg` | **CR-082**：新增 `monitor` 符号 |
| `src/modules/chat/chat.css` | 列表与工作台形态样式 |

## 5. 验证

- `npm run build`（含 `tsc --noEmit`）；
- 三栏结构、默认页签、**CR-082：页签为电脑图标＋文字「工作台」**（图标 16px、间距 6px、中心对齐、44px 高、未选中／深色／390 不溢出）；
- 左栏与历史浮层同一数据源、切页签不新建、`ChatPanel` DOM 计数为 1；
- CLI/权限/模型点击真实生效；
- 右栏预览与「在…中打开」回退；
- AI 请求四种返回码；
- 滚动条按 UI-SCROLL-001。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 抽 `SessionList` 影响现有历史浮层 | 保持 DOM 与类名不变，仅提取；先跑既有冒烟 |
| 工作台内 `ChatPanel` 宽度受父容器限制 | 传入前先 `clamp(320, 容器宽, 620)` |
| 右栏预览与编辑器共享状态 | 只读复用，不挂载编辑回调 |
