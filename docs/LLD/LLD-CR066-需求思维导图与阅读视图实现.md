# LLD-CR066：需求思维导图与阅读视图实现

- 关联需求：[CR-066](../PRD/CR-066-需求思维导图与阅读视图重构.md)；归属 [FEAT-003](../Plan/Feature/FEAT-003-需求维护与交付验收.md)／[STORY-010](../Plan/Story/STORY-010-需求树与详细文档预览.md#cr-066需求思维导图与阅读视图重构)；设计：[UI-CR066-v1](../UI/文档/UI-CR066-需求思维导图与阅读视图.md)。
- 数据库：本轮**无数据结构变更**。需求正文、编号、父子关系沿用既有 Markdown 文件权威与 `requirement_index` 派生索引，DB 不适用。

## 1. 当前实现与受影响模块

改动前（CR-045 遗留）：需求工作区三种阅读方式共用一个正文容器，导图是「上方 44% 高的 `.req-map-area` 树形列表 + 下方正文」的拼接；导图节点是 `ul/li` 树，没有连线、没有目录、没有悬浮详情，也没有页内新增；「愿景」中文命名；预览与导图模式下都并排需求树；顶部工具栏重复提供「全文预览／思维导图」按钮；预览正文所有实体一律 H1，目录没有父子层级。

| 模块 | 文件 | 改动 |
| --- | --- | --- |
| 导图几何 | `src/modules/projects/requirementMindmap.ts`（新增） | 层级布局、贝塞尔连线、节点宽度估算、层级标签、子级收集 |
| 导图面板 | `src/modules/projects/RequirementMindmapPane.tsx`（新增） | 画布、节点、连线 SVG、导图目录、右侧悬浮详情、页内新增、缩放折叠 |
| 阅读容器 | `src/modules/projects/RequirementsReading.tsx` | 三种方式分离、Vision 命名、顶部去重、目录折叠、预览分级 |
| 样式 | `src/modules/projects/projects.css` | 导图区、节点、连线、详情框、导图目录、目录折叠、窄屏回落 |
| 设计资源 | `docs/UI/workbench-v4/requirements-mindmap.js`、`requirements-workspace.js`、`requirements-workspace.css`、`data.js` | 同构实现与夹具 |

## 2. 选定方案

### 2.1 导图几何（`requirementMindmap.ts`）

- **数据源**：`ReadingSource[]`（含完整源清单）→ `MindmapSourceNode { id, kind, parentId, title }`。`id` 取 `entityId`，缺失时回落到 `source.key`。
- **层级**：`Vision → Epic → Feature → Story/Bug`。`mindmapChildren(node)` 取 `parentId === node.id` 的直接子项；Vision 额外收纳 `parentId` 为空的条目，避免丢失需求。
- **布局**（`layoutMindmap`）：递归 `place(node, depth, x)`。父节点宽度由 `mindmapNodeWidth(title)` 估算（中文 13px／西文 7px，另加 66px 内边距与 72px 三枚图标位，夹在 200～320px）。子节点横向偏移 `父宽 + 58px`；纵向依次排开（间距 16px），父节点 y 取首末子节点中点居中。节点高度固定 46px。
- **连线**：`mindmapEdgePath(from, to)` 生成 `M x1 y1 C … x2 y2` 三次贝塞尔，控制点水平外推 `max(24, Δx/2)`。
- **关系缺失**：`broken = kind !== "vision" && !!parentId && !集合中有 parentId`，渲染为虚线红框，不丢弃。

### 2.2 导图面板（`RequirementMindmapPane.tsx`）

- 画布用 `position:relative` 容器 ＋ 绝对定位节点 ＋ 同尺寸 `<svg>` 叠底层画连线；缩放通过外层 `.req-map-scaled` 的 `width/height` 乘以 zoom 实现（不用 CSS `zoom`，避免不同引擎下 offset 计算不一致），内层 `.req-map-inner` 保持原始尺寸。
- 目录与画布共用 `mindmapChildren` 与同一 `collapsed` 集合，保证两者层级永远一致。
- 目录点击定位：按 `target.offsetLeft * zoom` 换算后 `scrollTo` 到画布中心。
- 详情框为 `position:absolute; right:0; top:0; bottom:0`，覆盖在画布右侧（悬浮语义），窄屏时改为底部覆盖。
- 新增：节点上按类型给出可新增的下级类型（`MINDMAP_CHILD_KIND`），点击调用既有的 `onAddChild(node)`（与需求树「更多操作 → 新增特性／用户故事」同一条链路），成功后整体重载。

### 2.3 阅读容器（`RequirementsReading.tsx`）

- `isMap` / `isPreview` / `showTree = !isMap && !isPreview` 决定导航组成：文档＝需求树＋本页目录；预览＝无左树＋全文目录；导图＝导图目录（由面板自带）＋无右侧目录。
- 顶部工具栏移除「全文预览」「思维导图」按钮，只保留说明文字与当前文档操作。
- 预览分级：`PREVIEW_HEADING = { vision: "h2", epic: "h3", feature: "h4", story: "h5", bug: "h5", file: "h2" }`；文档方式仍用 H1。`ReadingHtml` 增加 `baseLevel` 参数，源文件内的 H1 相对实体标题下沉一级，保证不与实体标题同级。
- 目录折叠：`tocCollapsed: Set<string>` 存被折叠标题 id；`tocVisible` 用「隐藏层级」扫描过滤——处于折叠父级之下且层级更深的后续条目隐藏，遇同级或更高级条目恢复；`tocHasKids` 判定是否有下级，决定是否显示折叠按钮。

## 3. 关键取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 缩放实现 | 外层尺寸乘算 + 内层固定尺寸 | CSS `zoom` 在不同引擎下 `offsetLeft` 语义不一致，会破坏目录定位；乘算方式可精确换算滚动位置 |
| 连线绘制 | SVG 叠层 | 与节点同坐标系，缩放时无需重算路径；`pointer-events:none` 不挡节点点击 |
| 导图与文档容器关系 | 导图区作为 `.req-workspace` 直接子元素，正文容器 `hidden` | 保证画布占满剩余高度（页签条与工具栏移入导图区内部），避免旧「上导图下正文」残留 |
| 详情框位置 | 覆盖式悬浮（absolute）而非并排 | 用户明确要求「悬浮框」；并排会永久占用 320px 画布宽度 |
| 新增范围 | 只允许一级下级（Vision→Epic→Feature→Story） | 与 CR-045 既有新建规则一致，避免跨级新增破坏层级 |
| 预览是否保留需求树 | 移除 | 用户明确「不同的菜单」，各自独立导航；预览由右侧全文目录承担定位 |
| 目录折叠的数据源 | 复用渲染后的标题层级 | 预览分级修好后目录天然有父子层级，不需要另建目录树数据结构 |

## 3.1 r2 增补（2026-11-23 同日追加三点）

### 3.1.1 折叠控件移到连线连接处

| 项 | 做法 |
| --- | --- |
| 位置 | 折叠按钮是父节点右边缘的独立控件（`left = node.x + node.width`, `top = node.y + node.height/2`，18px 圆形，`margin:-9px` 居中于连线起点） |
| 显隐 | 基础规则 `opacity:0; pointer-events:none`；`.req-map-inner:hover` 时显示；已折叠分支（`aria-expanded="false"`）常驻可见 |
| 节点卡片 | 只保留「新增下级」「在文档中打开」（模型节点为「打开模型文档」），不再有折叠按钮，避免图标重叠 |

节点卡片不再承载折叠动作后，`mindmapNodeWidth` 的图标位从 72px 调整为 50px（两个图标）。

### 3.1.2 预览四级全量与四级目录

- 正文分级：`PREVIEW_HEADING = { vision:"h2", epic:"h3", feature:"h4", story:"h5", bug:"h5", file:"h2" }`，`ReadingHtml` 增加 `baseLevel` 使源文件内 H1 相对实体标题下沉一级。
- 目录主体由**实体树**生成（`previewOutline`），不再是正文标题序列：Vision→Epic→Feature→Story 四级，模型作为项目级分支列在末尾；每项带 `hasKids` 标记，折叠状态按实体 id 存在 `tocCollapsed`。
- 文档方式仍用 `toc`（正文标题层级）与本页目录。

### 3.1.3 模型融入

- 新增 `src/modules/projects/requirementModels.ts`：`readDesignModels(rootUri)` 读 `docs/DB/*.md`（`fsListTree` 深度 20，与设计工作区一致），从首行标题 `# DB-xxx：标题` 解析稳定身份；读不到时用路径占位并标注未读取，不伪造标题。
- 导图：模型作为 `kind:"model"` 的节点加入集合，`mindmapChildren` 在 Vision 下额外收纳模型（项目级独立分支），与 Vision 之间画**虚线**关联边（`MindmapEdge.dashed`），节点用虚线边框。
- 预览：正文末尾追加「数据库／领域设计模型」段落，逐个列出标题、编号与源文件，并提供跳转到「设计 → 数据库」页签的入口（`Workspace.tsx` 的 `designFocus` ＋ `DesignPane.focus`）。
- 模型不是 Story 的第二父项，也不按名称猜需求关联；无 `docs/DB/` 时列表为空。

## 4. 兼容性与风险

- **命名改动范围**：仅显示层。`kind` 取值仍是 `vision`，编号规则不变，后端协议不变。
- **预览正文的 DOM 层级变化**：实体标题由 H1 变为 H2～H5，依赖文档内锚点的链接仍按 id 定位，不受影响；`ReadingHtml` 的锚点重写逻辑不变。
- **导图在大项目下的性能**：节点数 = 需求条目数（当前项目 18 个）。布局为 O(n)，SVG 路径与节点同量级；未做虚拟化，若单项目超过千级条目需另评估。
- **Epic 归位**：源文件未声明 `parent` 的 Epic 依既有解析规则挂到项目 Vision 下。这是既有行为，CR-066 未改变，只在导图中显式呈现为 Vision→Epic 连线。

## 5. 实现步骤与验证

1. 先改可操作设计资源（`workbench-v4`）并跑设计断言（25 项）；
2. 再按稿实现正式软件（`requirementMindmap.ts` → `RequirementMindmapPane.tsx` → `RequirementsReading.tsx` → `projects.css`）；
3. `npm run build`（含 `tsc --noEmit`）通过；
4. 跑软件行为断言（27 项，含 UI-SCROLL-001 滚动条四帧与 700px 窄屏回落）；
5. 保存设计与软件的成对截图，实际结果见 [REPORT-CR066](../Test/REPORT-CR066-需求思维导图与阅读视图验证.md)。

## 6. 未决项与假设

- **假设**：导图「适应窗口」按画布可用区等比缩放，下限 40%（低于 50% 会导致节点不可读，故下限取 40%、上限 100%）。
- **未验证**：真实 Tauri 端到端（本次用 `?preview=design` 隔离夹具验证 React 组件行为）；深色主题下的导图配色；真实项目下 Epic 缺失 `parent` 时的归位显示。
- **后续**：CR-029 的数据库／领域设计模型分支仍未接入模型接口，本轮继续按缺口记录，不合成假分支。
