# LLD-CR073：项目管理与需求工作区界面修正实现方案

- 关联需求、Story 与本次设计范围：[CR-073](../PRD/CR-073-项目管理与需求工作区界面修正.md)；[STORY-096](../Plan/Story/STORY-096-项目管理与需求工作区界面修正.md) AC-01～12；[UI-CR073](../UI/文档/UI-CR073-项目管理与需求工作区修正.md)。
- 状态：方案完成，**未授权编码**。本文档只描述预期实现，不代表已修改正式软件。
- 负责人：lead。

## 1. 当前实现与受影响模块

| 区域 | 现状实现 | 本方案影响 |
| --- | --- | --- |
| 图标悬浮层 | `IconPopover` 用 `createPortal` 渲染 `.icon-pop-mask`（`position:fixed; inset:0`，居中），`.icon-pop` 宽 460、`max-height: calc(100dvh - 48px)` | 改为锚定定位 + 限高 420px |
| 编辑项目弹窗 | `ProjectFormModal`：名称单列；图标只读预览；负责人/描述/成员 `disabled` 占位 | 名称与图标同行、图标可点；删除成员；两字段可编辑 |
| 窗口页签 | `.nc-window-tab` `max-width:230px`；`.nc-tab-focus` 为 flex 居中，标题裸文本 | 标题包一层省略容器 |
| 需求工作区 | `.req-workspace` 为 `rail | tree | document-pane | toc` 四列；页签条在 `.req-document-pane` 内 | 增加顶部跨列页签区，正文列与目录列下移 |
| 左轨 | `.req-rail` 含模式切换 + 需求树开关 + 目录开关 | 只留模式切换 |
| 需求树/目录底注 | `.req-tree-foot` 两处（树、目录），树底部含刷新按钮 | 删除；刷新移到标题行 |
| 导图 | `RequirementMindmapPane`：`.req-map-scroll` 仅原生滚动；`selectedVisible` 渲染只读 `.req-map-detail` | 加拖拽平移、Ctrl 滚轮缩放、右侧编辑面板 |
| 导图新增/编辑 | `onAddChild`/`onEdit` 抛给 `Workspace.tsx` 打开 `CreateNodeModal`/`DocEditModal` | 改为面板内联，复用同一表单组件 |
| 设计页 | `DesignPane` 对非 `.md` 一律 `<pre>` 展示并注明「交互 UI 预览尚未接入」 | `.html` 走沙箱 iframe 预览 |
| 设计页左轨 | `design-rail` 含四分区 + 关联需求 + 目录开关 | 只留四分区 |

不改边界：`src/api/index.ts` 的图标白名单与成对保存契约、需求 front matter 解析规则、`renderMarkdown` 资源限制策略、Git 与 AI 侧栏。

## 2. 选定方案

### 2.1 图标悬浮层：锚定 + 限高

1. `IconPopover` 增加 `anchorRef?: React.RefObject<HTMLElement>`（可选）。提供时按锚点矩形计算位置，不提供时保留居中行为（知识库等其他调用点不受影响，可后续复用）。
2. 定位算法（`useLayoutEffect` 内计算，`ResizeObserver` + `scroll`/`resize` 监听重算）：
   - `spaceBelow = viewportH - rect.bottom - 12`，`spaceAbove = rect.top - 12`；
   - 期望高度 `desired = min(420, viewportH - 80)`；
   - 若 `spaceBelow >= min(desired, 320)` 或 `spaceBelow >= spaceAbove` → 下方 `top = rect.bottom + 8`；否则 `top = rect.top - height - 8`；
   - `left = clamp(rect.left, 12, viewportW - width - 12)`；宽度 `width = min(460, viewportW - 24)`；
   - 最终 `top` 再夹紧到 `[12, viewportH - height - 12]`。
3. 高度约束：`.icon-pop` 的 `max-height` 由内联 style 给出（`desired`），`.icon-pop-b` 继续 `overflow-y:auto` 承担滚动；**禁止** `overflow:hidden` 截断。
4. 交互不变：遮罩改为透明命中层（`background: transparent`）或直接使用 document 级 `mousedown` 外部点击关闭（现状已监听 `document.mousedown`，可去掉遮罩底色但保留点击外部关闭）。为保持「点外部关闭」与视觉轻量，采用：无底色全屏命中层 + `pointer-events` 仅用于关闭判定。
5. 动画：`transform-origin` 依翻转方向设置，`opacity/scale` 120ms；`prefers-reduced-motion` 下禁用。
6. 窄屏：`viewportW < 520` 时改为 `position: fixed; left/right: 12px; bottom: 12px` 的底部弹层，`max-height: min(420px, 70dvh)`。

### 2.2 编辑项目弹窗

1. 新增一行 `.project-name-row`：左侧 `IconPopoverTrigger`（复用卡片上的触发器组件）包 `ProjectIconTile`，右侧 `Field label="项目名称"`。
2. 触发器打开本次弹窗内的 `IconPopover`（受控 state `iconTarget`），`anchorRef` 指向图标砖；保存调用 `api.updateProject(id, name, undefined, icon, iconColor)` 后刷新本地 `project` 状态，不关闭编辑弹窗。
3. 新建项目时图标砖显示类型默认、点击提示「创建后可修改」（不打开悬浮层，因为项目 id 尚未生成）。
4. 删除 `<Field label="成员">` 整行；`ProjectFormModal` 不再出现 `members`。
5. 负责人/描述：受控 `owner`/`description`，随保存一起提交；当 `api.Project` 未含字段（旧后端）时，字段显示只读并给出「当前版本暂不可编辑」说明（由 `"owner" in project` 判定，不伪造可编辑）。
6. 布局：名称行高度与图标砖对齐（`align-items: center`），图标砖 `flex: 0 0 auto`，输入框 `flex: 1 1 auto; min-width: 0`。

### 2.3 窗口页签省略

1. `App.tsx` 页签按钮内：`<span className="nc-tab-label ellipsis">{title}</span>`，图标 `flex:0 0 auto`。
2. CSS：`.nc-tab-label { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`；`.nc-tab-focus { justify-content:flex-start; }`（当前居中会在省略时产生左右跳动）；`.nc-tab-close { flex:0 0 28px; }`。
3. 保持 `max-width:230px`、`min-width:0`；`title` 已在按钮上，补 `aria-label` 与完整文本。

### 2.4 需求工作区顶部跨列页签区

结构目标（文档 / 全文 / 导图三模式一致）：

```
.req-workspace (grid)
├── .req-rail            (col 1, row 1..2)
├── .req-main            (col 2, row 1..2)  ← 新的中间容器
│   ├── .req-topbar      (跨 正文列 + 目录列)
│   └── .req-body (grid: 正文列 + 目录列)
│       ├── .req-document-pane / .req-map-area
│       └── .req-toc-pane
└── .req-tree-pane       (col 2 或独立列，row 1..2，位于 rail 与 req-main 之间)
```

实际列序：`rail | tree | req-main(正文 + toc)`。页签条 `.req-topbar` 位于 `req-main` 内，因此天然只覆盖正文与目录两列，**不覆盖需求树**，与用户选择一致。

1. 新增 `.req-main` 容器；原 `.req-document-pane` 与 `.req-toc-pane` 移入 `.req-body`。
2. `.req-topbar` 承载：内部文档页签条 + 工具栏（编辑、派发预检、模式说明），高度按「页签 28px + 工具栏 40px」或合并为单行（设计稿决定，见 UI-CR073 §2.2）。
3. `.req-toc-pane` 顶部不再有独立 40px 标题行穿过页签；标题行 `req-toc-head` 保留但整体下移（自然在 `.req-body` 顶部）。
4. 导图模式：`.req-map-area` 进入 `.req-body` 主列；`props.header`（页签与工具栏）上移到 `.req-topbar`，避免导图区内部再嵌一层页签。
5. 窄屏：`@container (max-width:950px)` 时目录浮层 `top` 由 `80px` 改为基于 `.req-body` 顶部定位（`position:absolute` 相对 `.req-main`，`top` 为页签区高度）。

### 2.5 需求树与目录导航迁移

1. `.req-rail` 只保留三个模式按钮（文档/全文/导图）+ 分隔线（分隔线后为空则一并移除）。
2. `req-tree-head` 变为：`<b>需求文档</b>` + 刷新图标按钮 + `+` 按钮（刷新在 `+` 左侧）。
3. `req-toc-head` 变为：`<b>{全文目录|本页目录}</b>` + 计数 + 显隐开关（`PaneToggle`），开关放在标题行右侧。
4. 删除两处 `.req-tree-foot` 节点（树底部说明+刷新、目录底部说明）。
5. `PaneToggle` 复用现组件：需求树开关作用于 `treePane`，目录开关作用于 `tocPane`；隐藏后通过标题行开关恢复（开关自身在面板内，隐藏后面板不可见 → 需要保留一个恢复入口：将树/目录开关同时保留在 `.req-topbar` 工具栏右侧作为兜底入口，仅当对应面板隐藏时显示「显示需求树／显示目录」按钮）。

> 说明：这是本次唯一的方案取舍。若只把开关放进标题行，面板关闭后将无入口恢复。方案取「标题行内开关（面板可见时）+ 顶部工具栏兜底按钮（面板隐藏时）」，两者控制同一 `PaneToggle` 状态。

### 2.6 导图：平移、缩放、右侧编辑面板

1. **平移**：
   - `canvasRef` 上注册 `pointerdown`（仅当 `event.target` 命中 `.req-map-scroll` 或 `.req-map-scaled`/`.req-map-inner`/`svg` 等非节点区域）；
   - `setPointerCapture`，记录起点与 `scrollLeft/scrollTop`；`pointermove` 时 `if (distance > 4) dragging = true` 并写回 `scrollLeft/Top`；
   - `pointerup` 清除；`dragging` 时 `cursor: grabbing`；拖拽不触发 `onSelect`。
2. **缩放**：`wheel` 监听（`{ passive: false }`），`if (!(e.ctrlKey || e.metaKey)) return;` → `preventDefault()`；按 `-deltaY` 计算步进（每 100 一点 ≈ 0.1），夹在 `[0.5, 1.8]`，按 0.1 取整；以指针相对画布中心为锚点，缩放后修正 `scrollLeft/Top` 保持指针下内容不漂移。
3. **编辑面板**：
   - 抽出 `NodeEditorPanel`（受控 props：`node | draft`、`mode: "edit" | "create"`、`parent`、`onSave`、`onCancel`）；
   - 复用 `Workspace.tsx` 现有 `NodeFields` 表单与 `frontMatter`/`patchFrontMatter`/`acSection`/`writeAcSection` 工具函数（保持校验与 AC 编号规则单一来源）；
   - 面板宽度 320px（沿用 `.req-map-detail` 宽度），内容滚动遵守 UI-SCROLL-001；
   - 保存：编辑 → 读最新磁盘内容并比对基线（沿用 `DocEditModal` 的冲突检测），写回；新建 → 沿用编号分配逻辑（`CreateNodeModal` 的 max+1 与目录存在性检查）。
4. **新建下级占位**：
   - `onAddChild(node)` 改为在导图状态中置 `draft = { parentId, kind }`，画布渲染一个临时节点（虚线边框 + 「未保存」标记），右侧面板切换为 create 表单；
   - 取消：清除 `draft`，不落盘；保存：分配编号 → 写文件 → `onReload()` → 选中新节点；
   - 占位节点不参与折叠计数与目录（或：目录临时显示并标记「草稿」，采用前者以避免出现无效目录项）。
5. `RequirementMindmapPane` 需新增 props：`onRequestCreate(parent)`、`onRequestEdit(source)`、`editor`（面板状态与回调），或改为在 `RequirementsReading` 统一持有 draft 状态再下发。

### 2.7 设计页 HTML 预览

1. `DesignPane` 判断：`/\.html?$/i.test(current)` → 预览分支。
2. 读取文件文本后，用 `URL.createObjectURL(new Blob([text], { type: "text/html" }))`（或 `srcDoc`）注入 `<iframe sandbox="allow-same-origin? no" />`：
   - **必须**不包含 `allow-scripts`；本方案不使用 `allow-same-origin`（`srcdoc` 场景下同时用 `allow-scripts` 才有风险；这里二者都不用）；
   - 采用 `srcDoc` 更简单，避免 objectURL 生命周期管理；
   - 外层加 `title`、`loading` 状态、`onError`/超时提示；
   - 若文档依赖相对资源（CSS/图片），沙箱内相对路径会失效 → 面板顶部给出说明「预览不加载外部与相对资源」并提供「源码」切换。
3. 「源码」切换按钮沿用现有 `draft.editing` 思路，独立为 `viewMode: "preview" | "source"`；预览只读，不写文件。
4. `.md` 保持现状；其他类型（`.css/.ts` 等）保持源码展示。

### 2.8 设计页左轨精简

1. 删除 `.design-rail` 中「关联需求」按钮与 `PaneToggle`（目录）。
2. 目录显隐开关移到 `.design-topbar` 右侧（与编辑、导出同排），沿用 `tocPane` 状态。
3. 左轨仅保留 `DESIGN_SECTIONS` 四个按钮。

## 3. 接口与数据

- 无新增 IPC 命令。
- `api.updateProject` 已支持 `owner`/`description`（CR-072 在途改动）；本方案不改变签名，仅在调用处传入。
- 需求写回沿用 `fsReadFile` → 比对 → `fsWriteFile`，无新契约。

## 4. UI / DB / 权限 / 兼容性

- UI：见 [UI-CR073](../UI/文档/UI-CR073-项目管理与需求工作区修正.md)，8 组场景 + 深色/窄屏。
- DB：不适用（复用 CR-072 字段）。
- 权限：无变化；HTML 预览按最小权限沙箱执行，不授予脚本与同源。
- 兼容：已保存图标、项目字段、需求文档格式不变；`IconPopover` 不传 `anchorRef` 时行为回退到居中，保证知识库现有调用不破坏。

## 5. 实现步骤与并行边界

| 步骤 | 内容 | 文件边界 |
| --- | --- | --- |
| S1 | 设计稿：`cr073.css` / `cr073.js` + 定点修改，UI-CR073 登记 | `docs/UI/workbench-v4/**` |
| S2 | 图标悬浮层锚定限高 | `src/components/icon-tiles.tsx`、`src/theme/cr051-v6.css` |
| S3 | 编辑项目弹窗（同行/可改/去成员/可填字段） | `src/modules/projects/ProjectHome.tsx`、`projects.css` |
| S4 | 窗口页签省略 | `src/App.tsx`、`src/theme/cr044.css` |
| S5 | 需求工作区布局重排 + 树/目录导航迁移 | `RequirementsReading.tsx`、`projects.css` |
| S6 | 导图平移/缩放/编辑面板 | `RequirementMindmapPane.tsx`、`Workspace.tsx`（表单复用） |
| S7 | 设计页 HTML 预览 + 左轨精简 | `Workspace.tsx`、`projects.css` |
| S8 | 验证与成对证据 | 见 TEST-CR073 |

并行建议：S2/S3 与 S4 与 S5/S6 与 S7 之间文件不重叠可并行；S5 与 S6 都触碰 `RequirementsReading.tsx`／导图 props，需串行或同一执行者。

## 6. 验证与回退

- 验证：见 [TEST-CR073](../Test/TEST-CR073-项目管理与需求工作区修正验证.md)。构建 `npm run build`（含 `tsc --noEmit`）；受影响页面手工回归；滚动条三帧；导图拖拽/缩放三帧；设计与软件成对截图。
- 回退：界面级；按步骤独立回退。HTML 预览异常时可回退到源码视图（功能内置），无需回滚发布。

## 7. 未决项、假设与变更记录

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| A-073-01 | 需求页签区是否与工具栏合并为单行 | 交由设计稿确定（UI-CR073 §2.2 采两行：页签 28px + 工具栏 40px，与现状高度一致，避免正文可视高度变化） |
| A-073-02 | 设计页目录开关落点 | 取「顶部文档操作区」为默认 |
| A-073-03 | 导图编辑面板是否复用 `NodeFields` | 采用复用，保证校验规则单一来源 |
| A-073-04 | 需求树/目录关闭后的恢复入口 | 采用「标题行开关 + 顶部兜底按钮」 |
| 变更 | 2026-11-24 建立 | — |
