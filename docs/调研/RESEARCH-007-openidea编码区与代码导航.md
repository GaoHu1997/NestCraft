# RESEARCH-007：openidea 编码区（左侧菜单／编辑区／代码导航）实现调研与差距

- 日期：2026-11-25；负责人：lead；来源：用户要求「调研 openidea 的编码项目左侧菜单和编辑区怎么做，还有 ctrl+鼠标左键进入代码、跳转到实现类等，再看看我们现在的差距」。
- 对象：`D:\github\openidea`（Tauri 2 + React 19 + CodeMirror 6 + Rust 核心的 IntelliJ 风格 IDE），`package.json` 版本 0.1.33，本地 HEAD `707b1f7`（fork 自 `github.com/GaoHu1997/openidea`，上游 `l0ng-ai/openidea`，Apache-2.0）。
- 方法：只读源码，逐文件实读主链路并记录 `路径:行号`；另派两个只读子任务分别核对 Rust 侧 LSP 链路与本项目现状。**没有运行 openidea，没有在本机验证其交互，没有复制任何代码。**
- 关联：编码区归属 [FEAT-007](../Plan/Feature/FEAT-007-文件草稿与分支上下文.md)／[STORY-034](../Plan/Story/STORY-034-编码区正式实现.md)；最初的参考来源见 [CR-015](../PRD/CR-015-启动Tauri正式实现.md)（"编码区 ← openidea（文件树、行号编辑器）"）与 [ADR-002](../LLD/ADR-002-Tauri技术栈选型.md)。本轮**只出调研结论，不改需求、设计或软件**。

## 1. 结论先行

1. openidea 的"左侧菜单"不是一个文件树组件，而是一套**工具窗口（Tool Window）体系**：贡献式注册 → Islands 网格布局 → 图标条（stripe）拖拽重排／徽标／更多菜单 → 面板头（视图下拉、页签、头部动作、⋮ 选项）→ 命名布局快照。Project 树只是这套体系里的一个窗口（`order: 0`，左侧第一个）。
2. 编辑区是**可分屏的页签容器 + CodeMirror 6 宿主**：预览页签（斜体）、固定页签、脏点、拖拽排序、拖出成新窗口、拖到边缘分屏、双击推广／最大化、上下两条基于符号大纲的面包屑、独立的导航历史（Ctrl+Alt+←/→）。
3. `Ctrl+点击` 不是 CodeMirror 默认能力，而是自建的三段式：**window 级修饰键状态**（`navigationModifier`）→ **悬停探测 + 下划线装饰**（`linkPlugin`）→ **点击走 `gotoTargets("definition")`**，并支持鼠标中键无修饰键跳转、`Ctrl+Alt+左键` 直跳实现。
4. 代码导航全部落在 **LSP** 上：`textDocument/definition|implementation|references|typeHierarchy`，能力由 server `initialize` 的 capabilities 门控（而非静态配置）。**只有定义/声明在 server 不可用时有语法树兜底；"跳转到实现"没有兜底**，没有 LSP 就明确报错。
5. 关于数量级：openidea 前端 TS/TSX 约 **10.5 MB / 1500+ 文件**（editor 1.8 MB／241 文件、features 7.2 MB／981 文件），Rust `crates/` 约 **13.9 万行**；本项目 `src/` 约 **1.8 MB／126 文件**。差距不只是功能项，还有体系与测试密度（openidea 仅 editor 目录就有 101 个测试文件）。
6. 我们的编码区当初就是照 openidea 的**「文件树 + 行号编辑器」**这两个部件落的（CR-015／ADR-002），因此**骨架同源、能力断代**：编辑器同用 CodeMirror 6（重大利好，扩展可对齐），但缺工具窗口体系、缺文件操作、缺一切语义导航。
7. 建议补齐顺序：**先文件树操作与页签体验（不依赖外部进程）→ 再 LSP 客户端与定义跳转 → 最后实现/引用/类型层级与 gutter 标记**。任何一步都要先补 UI 设计（AGENTS.md §6.3.1），且这是产品投入决策，不是顺手迭代。

## 2. 总体架构（前端）

```text
main.tsx
└─ workbench/                工作台骨架
   ├─ ToolWindows.tsx        工具窗口：stripe 图标条 + Islands 网格 + 面板头
   ├─ EditorArea.tsx         空编辑器占位、编辑器 island
   ├─ contributions.ts       贡献注册表（toolWindows / editorKinds / menus / decorations…）
   └─ MainMenu / TitleBar / StatusBar / Notifications / quickSwitch…
├─ features/                 按功能切分（project-tree / search / vcs / code-insight / debugger / …）
│  └─ 每个 feature 的 index.ts 里 activate() 注册工具窗口、动作、菜单
├─ editor/                   编辑器域
   ├─ core/cm/               CodeMirror 扩展（语言、折叠、查找、多光标、sticky scroll…）
   ├─ core/view/             EditorArea / TextEditorHost / FindBar / 面包屑
   ├─ core/model/            tabs / document / navHistory / slot
   ├─ lsp/                   LSP 客户端（completion / hover / navigation / diagnostics / …）
   └─ navigation/            gotoTest / superMethod / implementationGutter
├─ ui/                       设计系统（Tree、Tabs、Menu、Popup、Icon…）
└─ platform/                 IPC（Tauri command）、keymap、settings、i18n、project
```

关键设计取向：**feature 通过注册表挂载，不直接改工作台**；工具窗口、动作、菜单、状态栏项、文件装饰都是贡献点。新增一个左侧面板 = 新增 `registerToolWindow` 调用，不用碰 `ToolWindows.tsx`。

## 3. 左侧菜单：工具窗口体系

### 3.1 贡献式注册

注册项（`src/workbench/contributions.ts`，实例见 `src/features/project-tree/index.ts:130-140`）：

| 字段 | 作用 |
| --- | --- |
| `id` / `title` / `icon` | 标识、标题、图标（`Icon name` 走统一图标集） |
| `anchor` | `left` / `right` / `bottom`，决定停靠边 |
| `secondary` | 进"分割区"（IDEA 的 Left Bottom / Bottom Right） |
| `order` | 同区排序（Project=0、Commit=1、Pull Requests=2、Structure=20） |
| `component` | 面板正文（`lazyComponent` 代码分割） |
| `headerActions` / `headerMenu` / `titleMenu` | 头部动作按钮、⋮ 选项菜单、标题下拉（视图切换） |
| `headerContent` + `tabsReplaceTitle` | 头部换成页签条（Commit、Pull Requests 用） |
| `useBadge` | 图标条上的计数徽标（Commit 显示变更数） |
| `stripe` | `"onUse"`：第一次打开才出现在图标条上 |
| `requiresProject` | 无项目时是否出现 |

左侧默认集合：**Project**（`order 0`）、**Commit**（`order 1`，徽标=变更数，`src/features/vcs/index.ts:81-96`）、**Pull Requests**（`order 2`，`onUse`，`src/features/github/index.ts:307-317`）、**Structure** 与 **Bookmarks**（`order 20`，`secondary` → 左下分割区，`src/features/search/index.ts:138-157`）。

### 3.2 布局与尺寸（Islands）

`ToolWindowLayout`（`src/workbench/toolwindows/ToolWindows.tsx:949-1035`）：

```text
┌ stripe ┬─ grid ────────────────────────────────────────┬ stripe ┐
│ 按钮    │ SidePanel(left) │ gap │ 编辑器 island │ gap │ SidePanel(right) │
│         │ ──────────────── gap ───────────────                         │
│         │ SidePanel(bottom)                                            │
└─────────┴──────────────────────────────────────────────────────────────┘
```

- 由 **CSS Grid + CSS 变量**（`--tw-left` / `--tw-right` / `--tw-bottom`、`--gap-*`）布局，`syncTracks()`（`:829-837`）写变量，窗口缩放不跑脚本。
- 主/分割区比例用 `flex-grow`，`SplitHandle`（`:703-775`）拖动时直接改，松手后存比例（`MIN_SPLIT`/`MAX_SPLIT`）。
- 边宽拖拽 `GapHandle`（`:843-929`）：拖动只改变量，松手才写 store；**拖过最小宽度一半即折叠**（`next === 0` → `hideToolWindow`），左侧最小 140px，编辑器保底 200×60。
- 图标条宽度 `StripeHandle`（`:186-261`）：32～96px，低于 44px 只显示图标，支持键盘 ←/→ 步进。
- 支持 Widescreen 布局（底部窗口插到左右之间）与专注模式隐藏所有条。

### 3.3 图标条（Stripe）交互

`StripeButton`（`:369-420`）：
- 常态：图标 + 可选名称（IDEA "Show Tool Window Names"）；激活态高亮、聚焦态加环；`aria-pressed`、`aria-keyshortcuts`，tooltip 显示名称 + 快捷键。
- 点击：`toggleToolWindow`；拖拽后紧跟的 click 被 `dragEnded` 抑制（`:273`）。
- 右键：Hide（移出图标条）/ Move To（六个锚点 + Restore Default Layout）/ Show Tool Window Names（`:112-127`）。
- 拖拽重排 `startStripeDrag`（`:305-359`）：**用 Pointer Events 而非 HTML5 DnD**，注释写明"Tauri 原生文件拖放开启后 webview 收不到内部拖拽的 dragover/drop"（`:263-264`）；4px 阈值、克隆 ghost 跟随、落点由 `stripeDropAt` 计算（跨侧、插入位置、分区）、Esc 取消。
- `StripeMore`（`:423-463`）：没有按钮的窗口收进"…"菜单，打开后自动加按钮。
- 键盘：上下/Home/End 在条内移动焦点（`:465-472`）。

### 3.4 面板头

`ToolWindowView`（`:556-688`）：标题（可下拉切换视图）→ 头部页签 → 弹性空隙 → 头部动作（如 Project 的 Locate / Expand All / Collapse All）→ ⋮（该窗口选项 + Move To + Maximize/Restore + Hide）→ 隐藏按钮。双击空白处最大化。

### 3.5 快捷键（IntelliJ Windows 方案）

`src/platform/keymaps/intellij-windows.ts`：`Alt+1` Project、`Alt+2` Bookmarks、`Alt+3` Find、`Alt+7` Structure、`Alt+9` Git、`Alt+0` Commit、`Alt+F12` Terminal、`F12` 跳回上一个工具窗口、`Shift+Esc` 隐藏当前、`Esc` 回编辑器、`Ctrl+Alt+Shift+←/→/↑` 调整尺寸。键位是**数据表**（多套方案：IntelliJ / Eclipse / VS Code，macOS 与 Windows 各一份），动作与键位解耦、可覆盖。

### 3.6 命名布局

`toolwindows/layouts.ts`：把"哪些窗口可见、尺寸、位置"存成命名快照（localStorage），支持保存／恢复／重命名／删除／恢复默认。

## 4. Project 文件树（左侧第一个窗口）

`src/features/project-tree/ProjectView.tsx`（789 行）+ `store.ts` + `model.ts` + `operations.ts` + `contextMenu.ts`。

### 4.1 数据与虚拟化

- 状态在 zustand store：`listings`（目录分页）、`byKey`/`keyOfPath`（派生模型）、`expanded`、`selected`、`lead`、`editing`、`clipboard`、`dropTarget`、`options`、`mode`。
- 树用共享 `Tree` 组件（`src/ui/Tree.tsx`，`@tanstack/react-virtual`），行高固定，只渲染视口。
- 懒加载：`loadDir(path)` / `loadOutline(path)` 按需拉取，`info.pending` 驱动（`:419-421`）。
- 外部变化：`onIdeEvent("fsChanged")` → `applyFsChange` 增量更新，不整树刷新（`index.ts:150-151`）。

### 4.2 打开与选择

- 单击 `onRowClick`（`:531-545`）：目录按选项展开；文件按 `singleClickOpen` 直接打开，否则按 `previewTab` 开**预览页签**（斜体，被下一个预览替换）；带 Shift/Ctrl/Alt 时不打开（交给多选）；双击不重复触发。
- 双击（`:549-551`）：仅在 `singleClickExpand` 时阻止二次折叠。
- 键盘（`:666-713`）：`F4`/`Ctrl+↓` 打开、`Delete` 删除、`Shift+F6` 重命名、`F6` 移动、`Ctrl+C/X/V` 复制剪切粘贴、`Shift+Ctrl+C` 复制绝对路径、`Ctrl+N`/`Alt+Insert` 新建弹层。
- 预览页签与编辑器联动：选中文件时按 `autoscrollToSource` 在编辑器打开/定位（`:488-499`）；`autoscrollFromSource` 时编辑器切换文件树自动定位（`:454-458`）。

### 4.3 视图模式与选项

- 模式：Project / Packages / Open Files / All Changed Files（`store.ts:72`），标题下拉切换。
- 选项（`HeaderActions.tsx:22-33`，默认值见 `store.ts:54-60`，全部默认关）：Show Hidden Files、Show Excluded Files、Show Members、Compact Middle Packages、Sort Folders First、Autoscroll to Source、Autoscroll from Source、Open Files with Single Click、Expand Directories with Single Click、Enable Preview Tab；排序 by Name / Type / Modification Time。

### 4.4 文件操作

- 新建/重命名走**行内编辑器** `InlineEditor`（`:140-233`）：自动聚焦、重命名时只选中主名不含扩展名（IDEA 行为）、非法名以 Popup 报错、新建时点别处取消而重命名提交。
- 删除/移动有确认与重构预览（`fileRefactor.ts`、`FileRefactorDialogs.tsx`、`RefactoringPreview.tsx`），可撤销（`Ctrl+Z`，`:681-684`）。
- 拖拽移动（`:553-626`）：pointer 驱动；拖到文件夹=移动（Alt=复制）；拖到编辑器区域=打开（`dragSession` + `FILES_DRAG`）；Esc 取消；拖拽结束在同行仍算点击。
- OS 文件拖入：Tauri `onDragDropEvent` → `nativeDropPoint` 换算坐标 → `importExternal`（`:629-656`）。
- 右键菜单：`contextMenuItems`（`contextMenu.ts`），按节点类型/多选/只读/分组动态生成，支持贡献分组异步准备（`:507-524`）。

### 4.5 装饰与图标

- VCS 装饰：`useFileDecoration(path)` → 颜色、徽标、tooltip、error、faded；`ignored` 着色、`excluded` 图标淡化（`:263-277`）。
- 图标：`fileIconName` / `folderIconName` / `folderKind`（源码根、测试根、资源根等）/ `moduleFolderIcon` / JVM 表现（Spring Boot、可运行标记）（`:117-135`、`:289-298`）。
- 搜索命中高亮：`HighlightedText` + `indices`（`:307-320`）。

### 4.6 Show Members

开启后文件节点下挂该文件的**符号大纲**（`loadOutline` → `outlineRows`），`MemberRow` 显示符号徽标与名称，点击 `revealRange` 直接定位到符号（`:333-352`、`:501-505`）。

## 5. 编辑区

### 5.1 分栏与页签

`src/editor/core/view/EditorArea.tsx`：

- 布局树 `LayoutNode` 递归渲染为 `SplitGroup/SplitPanel`（`:104-118`），可任意横/纵向分割。
- 页签条 `Tabs`（`:308-343`）：预览页签斜体（`italic: t.preview`）、固定页签单独行可选、脏点、颜色/底色来自文件装饰、同名文件加目录消歧（`disambiguateTitles`）、悬停显示完整路径。
- 关闭语义：中键关闭、`Shift+点击` 关闭、`Alt+点击` 关闭其他、双击=预览转正式/最大化。
- 拖拽：页签互拖排序；拖到编辑器四边 25% 区域=分屏，中间=移入（`dropZoneAt`，`:123-138`）；拖出窗口=分离成新窗口（`detachTab`）。
- 页签右键菜单由 `controller.tabMenu` 生成，支持贡献分组。
- 内容：`VirtualBanner`（反编译/库类）、`EditorBanners`、`FindBar`、上下两条面包屑、`TextEditorHost`（挂载 CodeMirror 视图）、非文本编辑器按 `editorKind` 渲染。

### 5.2 编辑器装配

`src/editor/core/view/TextEditorHost.tsx`（37 行）只做挂载：`ctrl.ensureSlot(tabId)` → `slot.mount(el)`。

`src/editor/core/cm/setup.ts` 是基础扩展集，用 `Compartment` 在运行时热替换：`language`、`comments`、`indent`、`readOnly`、`wrap`、`sticky`、`font`、`heavy`（超大文件降级）、`contributions`、`lineNumbers`、`folding`、`caret`、`prefs`、`distractionFree`。其余扩展按需注册：缩进检测（`.editorconfig` → 文件实际缩进 → 代码风格）、语法高亮主题、缩进参考线、彩虹括号、粘性滚动、查找、CodeLens、多光标、列模式、Vim。

### 5.3 面包屑与状态栏

- `CodeBreadcrumbs`（`core/view/StatusItems.tsx`）：**基于符号大纲**生成 `类 › 方法 › 局部` 链，可配置上下位置、按语言禁用；点击跳符号。
- `CaretStatus`：行列、多光标数、选区字符/行数，点击可"跳转到行:列"。

### 5.4 导航历史

`core/model/navHistory.ts`：`entries` + `index`，最大 100 条；只有"导航"（文件切换、鼠标点击、查找结果、声明/用法跳转、行跳转）才留下后退记录，打字/方向键/翻页不算；4 行内的后退项合并；`Ctrl+Alt+←/→` 与鼠标侧键（Button4/5）触发。

## 6. Ctrl+鼠标左键跳转（核心）

### 6.1 修饰键 = window 级活状态

`src/platform/navigationModifier.ts`：
- `isNavigationGesture(e)`：主修饰键（macOS ⌘ / 其他 Ctrl）**单独按下**，排除 Alt/Shift 和"另一平台的键"，避免和 `Ctrl+Alt+B`、`Shift+点击` 等手势冲突。
- 在 `window` 上以 capture 监听 `keydown/keyup/mousemove/mousedown` + `blur` 复位，**编辑器没焦点时也生效**；`onNavigationModifier(fn)` 供插件订阅。注释说明了原因：修饰键在窗口外释放收不到 keyup，所以也从指针事件读取。

### 6.2 悬停：下划线 + 声明摘要

`linkPlugin`（`src/editor/lsp/navigation.ts:365-517`）：

1. `mousemove` 记录坐标并 `show(isNavigationGesture(e))`；命中链接/URL/文件路径（`knownLinks`/`textReference`）直接下划线，否则取词。
2. 探测该词是否**真的可跳**：`probeNavigation`（`:347-363`）先看贡献的定义提供者，再问 LSP `definition`，server 不可用时看语法兜底，最后对 HTML/CSS/Vue 试 web 引用。
3. 可跳才加 `cm-lsp-link` 装饰（下划线），并异步取 `hover` 文档，生成**声明摘要 tooltip**（`declarationSummary` + `renderCode`），文档不阻塞下划线。
4. 竞态与缓存：按 `word:from:to` 缓存结论、`probeVersion` 递增丢弃过期结果、3 秒超时**不缓存为"无目标"**（`:443-449`）；文档变更清缓存。
5. 指针落在 tooltip / inlay 上时清状态，避免把悬浮层上的位置当成代码位置（`:484`）。

### 6.3 点击：拦截并跳转

`mousedown`（`:491-514`）：
- 只处理左键/中键；
- 先让 `dispatchMouseShortcut` 处理用户自定义的鼠标键位映射，命中则只置光标；
- `Ctrl+点击` → `preventDefault`、置光标、清下划线、`gotoTargets(view, "definition", pos)`，返回 `true` 阻止 CodeMirror 默认行为（避免多重光标/选区）；
- **中键单击无条件跳转**（IDEA parity），带任何修饰键则放弃。

### 6.4 `gotoTargets` 主链路

`gotoTargets(view, kind, at)`（`:155-228`）：

```text
光标/点击位置
  ├─ (definition) 贡献的定义提供者 / PHP 构造文档
  ├─ LSP: commands.lspGoto(doc, pos, kind)          ← 主路径
  │    失败(isUnavailable) → 网页引用/链接
  │                       → 语法树 declarationFallback（仅 definition/declaration）
  ├─ 空结果 → 链接/路径跳转 → 提示 "Cannot find declaration to go to"
  ├─ 单目标 → navigateTo(loc) = editorService().openFile(path, {selection, focus})
  ├─ 多目标 → 弹出 Choose Declaration/Implementation 列表
  └─ (definition 且目标就是自己) → 直接显示 usages（IDEA 行为）
```

- `navigateTo`（`:65-70`）：统一走编辑器服务 `openFile(path, { selection, focus })`，因此**自动开页签、自动记导航历史、自动定位**。
- 编辑后竞态：`gotoAfterEdits`（`:147-153`）对"编辑后 1.5 秒内返回空"的请求重试最多 3 次、每次 250ms（注释点名 kotlin-language-server 编辑后约 300ms 才更新）。
- 失败提示按 `kind` 区分文案：`Cannot find declaration to go to` / `No implementations found` / `Cannot find type declaration`；server 不可用时追加"no language server is running for this file"（`:72-77`、`:201`）。

### 6.5 多目标选择器

`locationItems`（`:97-124`）为每个目标生成：符号名/文件名、`容器 · 相对路径:行`、**该行源码预览**、类型图标；标题形如 `Choose Implementation of foo (3 found)`（`:126-129`），语法兜底时追加 ", based on syntax"。列表支持速度搜索，并可"Open in Find Tool Window"钉成 Find 页签（`:131-137`）。

### 6.6 用法高亮

`fetchHighlights`（`:576-623`）：光标停留 300ms 后请求 `documentHighlights`，区分读/写/文本三类装饰；无 server 时只做**同作用域**局部高亮（`localHighlights`），并在状态栏显示 `N usages of 'x' found (…Escape to remove…)`；`Ctrl+Shift+F7` 粘性高亮、`Ctrl+Alt+↓/↑` 在用法间跳转（`:638-667`）。

## 7. 跳转到实现类

### 7.1 键位与动作

- 键位（`src/platform/keymaps/intellij-windows.ts:23`）：`Ctrl+Alt+B` 和 **`Ctrl+Alt+左键`（`Ctrl+Alt+Button1`）**；类型声明 `Ctrl+Shift+B`；声明 `Ctrl+B`。
- 动作注册（`src/editor/lsp/actions.ts:231-236`）：`navigate.implementation` → `gotoTargets(v, "implementation")`；`navigate.typeDeclaration` → `"typeDefinition"`。
- 鼠标手势靠键位表里的 `Ctrl+Alt+Button1` 映射，与键盘动作共用同一条动作链（`navigationMouse.test.ts` 有专门用例）。

### 7.2 后端

`lspGoto`（`crates/ide-lsp/src/lib.rs:1124`）按 kind 选方法：`goto_method`（`:275-283`）→ `textDocument/implementation`，先查 server 的 `implementationProvider` 能力（`caps.rs:189` 映射表），能力缺失返回结构化错误而不是空结果。多 server 并行合并，任一成功即返回。

### 7.3 Gutter 标记（比快捷键更常用）

`src/editor/navigation/implementationGutter.ts`：
- `↓` = 有实现/被重写，`↑` = 实现了接口/重写了父方法；
- 数据来源：`↓` 走批量 `lspImplementations(request, doc, positions)`（可取消的单次批量请求，返回 `Vec<Vec<Location>>`），`↑` 走类型层级 + 父类型文档符号；
- 只问**视口 ±60 行**内的声明、每批最多 60 个、编辑/滚动后 500ms 防抖、按文档文本缓存、行变化时跟随映射；
- server 未就绪/不支持时按组退避，避免反复打空请求；
- 点击标记：单目标直跳，多目标开选择器，并可钉到 Find 窗口（`openMarkerTargets`）。

### 7.4 限制（重要）

- **实现跳转没有语法兜底**：`navigation.ts:167` 只对 `definition`/`declaration` 走 `declarationFallback`；`implementation`/`typeDefinition` 失败直接报 `No implementations found`。
- 兜底能力本身有限：`syntaxFallback.ts` 开头写明只服务"dumb mode"（server 启动中/索引中），提供定义、局部用法、重命名与局部高亮，**不做全项目解析**。
- 语言覆盖取决于 server：Java 靠 jdtls（另有 `java-usages` 插件扩展引用、`kotlin-bridge` 把 Kotlin 产物挂进 classpath，但**不提供 Kotlin 源码级导航**）；TS 用 vtsls + fallback；Go/opls；Kotlin 用 kotlin-lsp + fallback。

## 8. Rust 侧支撑（摘要）

| crate | 职责 | 关键位置 |
| --- | --- | --- |
| `ide-lsp` | LSP 管理器：按语言懒启动、多 server 合并、能力门控、崩溃退避重启 | `src/lib.rs:162`，goto `:1124`，implementations `:1134`，references `:1196`，typeHierarchy `:2128`，caps `caps.rs:189` |
| `ide-language` | 语言注册表 + tree-sitter 符号抽取；`languages/*.toml` 声明 server 命令/参数/root-markers | `src/lib.rs:26/91`，`syntax/mod.rs:158` |
| `ide-index` | 文件 + 符号索引，blake3 跳过未变文件，模糊搜索（CamelHump、最近文件加权） | `src/lib.rs:67/164/171`，`worker.rs:344` |
| `ide-search` | ripgrep 文本搜索、`files_with_word` 全词扫描（补 LSP 引用范围） | `lib.rs:191`，`words.rs:30` |
| `ide-analysis` | 结构搜索/重复检测（不在跳转链路） | `lib.rs:1-12` |

Tauri 命令层：`src-tauri/src/commands/lsp.rs:73/88/125/308`（goto / implementations / references / type hierarchy），前端经 `bindings.ts` 调用。

## 9. 我们现在的实现

### 9.1 结构

```text
Workspace.tsx（项目三页签：需求/设计/编码）
└─ CodePane（编码页签，Workspace.tsx:1042-1056）
   ├─ code-rail：资源管理 / Git 管理 / 外部编辑器(禁用)   ← 左侧"菜单"
   ├─ FileTree.tsx（260px，可拖宽 180-480，可折叠）
   ├─ EditorTabs.tsx（页签条）
   └─ index.tsx（CodeMirror 6 编辑区 + 阅读/编辑模式）
```

### 9.2 已有能力

- **文件树**：Tauri 分页目录接口（`fs_perf_dir_page`）、自研虚拟滚动（`performance-model.ts` 的 `virtualRange`）、单击打开/折叠、方向键/Home/End/PageUp/Down、树内文件名与内容搜索（流式轮询、可取消、部分覆盖提示）、刷新目录。
- **页签**：多标签、脏点、关闭、溢出走"更多"下拉（不出横向滚动）。
- **编辑器**：CodeMirror 6 `basicSetup`（行号、折叠、查找替换、括号匹配、补全）、按扩展名语言（md/js/jsx/ts/tsx/py/json）、Markdown 阅读/编辑双模式、Ctrl+S、自动保存、编码/BOM/行尾保留、大文件只读窗口、二进制只读提示、外部定位跳行高亮（`locateTarget`）。
- **文件读写**：全走 Tauri command（`fs_perf_open_document` / `read_window` / `save_begin/append/seal/commit` / `dir_page` / `search_*`），编码检测与流式哈希在 `fs_document_read.rs` / `streaming-sha256.ts`。

### 9.3 明确没有

- 工具窗口体系（注册、stripe、拖拽、徽标、布局快照、快捷键、面板头菜单）；
- 文件树右键菜单、新建/重命名/删除/移动、拖拽、git 状态着色、单双击配置、预览页签、Show Members；
- 页签拖拽排序、分屏、拖出窗口、双击最大化；
- 面包屑、导航历史、符号大纲、问题面板；
- **任何语义能力**：LSP 客户端、定义/实现/引用/类型层级跳转、Ctrl+点击、悬停文档、用法高亮、gutter 标记；
- 相应测试与设计稿（现有 `docs/UI/performance-editor` 只覆盖性能状态，不含导航交互）。

## 10. 差距矩阵

| 层 | openidea | 我们 | 差距性质 |
| --- | --- | --- | --- |
| 左侧菜单骨架 | 工具窗口贡献 + Islands 网格 + stripe 拖拽/徽标/更多/命名布局 | `code-rail` 三个固定按钮 | **体系级**，需重做容器 |
| 左侧面板内容 | Project / Commit / PR / Structure / Bookmarks，多面板共存、可拖宽折叠 | 单一文件树 + Git 面板（页签级） | 体系级 |
| 文件树交互 | 单击/双击可配、预览页签、右键菜单、新建/改名/删除/移动、拖拽、OS 拖入、VCS 装饰、Show Members、四种视图模式 | 单击打开、虚拟滚动、树内搜索 | **操作级**，可增量补 |
| 编辑区页签 | 预览/固定/脏点/拖拽排序/四边分屏/拖出窗口/双击最大化/右键菜单 | 多标签/脏点/关闭/溢出更多 | 操作级 |
| 编辑区导航 | 面包屑（符号链）、导航历史、Go to Line、查找条 | 外部定位跳行、Ctrl+S | **能力级**（缺语义来源） |
| 打开/跳转 | 统一 `openFile({selection, focus})` + 导航历史 | `onOpenFile(path)` + 外部定位事件 | 接口级，需统一入口 |
| 语义导航 | 定义/实现/类型声明/引用/类型层级/用法高亮/gutter 标记 | 无 | **能力级（从零）** |
| 后端 | LSP 管理器 + 索引 + 搜索 + 符号服务（Rust 13.9 万行） | 文件读写 + 分页搜索（无语言服务） | 能力级（从零） |
| 工程化 | editor 目录 101 个测试文件、project-tree 17 个 | 少量 smoke | 需同步建立 |

## 11. 补齐路径建议（分层，不代表已授权开发）

### P0：文件树与页签的"操作感"（不依赖外部进程，收益最快）

1. 文件树右键菜单 + 新建/重命名/删除/移动（复用现有 `fs_*` command，补 Rust 侧 rename/move/create）。
2. 单击/双击/预览页签三选项；与编辑器打开入口统一为 `openFile(path, {selection, focus, preview})`。
3. 页签拖拽排序（Pointer Events，注意 webview 内 HTML5 DnD 的坑）。
4. VCS 装饰（颜色/徽标）接现有 Git 数据。

### P1：代码导航第一版（定义跳转 + 面包屑）

1. 选定 LSP 通道：Node sidecar（`vscode-languageserver-node` 客户端思路）或 Rust `tower-lsp`／直接管进程 + JSON-RPC。**要独立 ADR**：语言覆盖、安装来源、离线可用性、进程生命周期、安全边界。
2. 先做**单语言试点**（优先 TypeScript/JavaScript，其次 Python），跑通 `didOpen/didChange/definition/hover/documentSymbol`。
3. 前端照 openidea 的三段式落地：`navigationModifier`（window 级修饰键）→ `linkPlugin`（下划线 + 提示 + 竞态缓存）→ `gotoTargets`（单/多目标、失败文案）。
4. 面包屑与导航历史（Ctrl+Alt+←/→）依赖 `documentSymbol`，可与定义跳转同批交付。

### P2：实现/引用/类型层级与标记

1. `textDocument/implementation|references|typeHierarchy` + 多目标选择器。
2. gutter 继承标记（视口内批量、防抖、缓存、退避）。
3. 用法高亮、Find Usages 面板。

### 不建议照抄

- 工具窗口的完整 IDEA 生态（调试器、数据库、HTTP、Docker…）与本项目"AI 研发工作台"定位不符；只借**容器模型**（注册 + 停靠 + 拖拽 + 布局快照），不必复刻全部窗口。
- 编辑器扩展全量移植（101 个测试文件背后的多光标、列模式、Vim、Emacs 宏…）收益低；按需挑折叠、查找、缩进检测即可。
- LSP 的语法兜底（tree-sitter）在 openidea 里也只覆盖定义/用法，**不要为了"没有 server 也能跳"先做兜底**，那是第二优先级。

## 12. 风险与依赖

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 产品定位 | 编码区是 AI 工作台的辅助，不是主战场；完整 IDE 能力投入大 | 先在 FEAT-007 里明确"编码区目标成熟度"，再决定 P1/P2 范围 |
| LSP 环境 | 用户机器可能没有 jdtls/gopls/tsserver；每个语言都要装、要管版本 | 语言白名单 + 缺失时明确降级文案 + 内置 TS server 候选 |
| 进程与安全 | 拉起的 server 能读项目文件、执行插件 | 明确信任边界（现有 project-trust 可复用）、超时与退避、日志脱敏 |
| Webview 限制 | Tauri 拖放/快捷键与浏览器差异（openidea 专门写注释绕过） | 拖拽统一用 Pointer Events；键位表与动作解耦 |
| 规则约束 | 任何界面新增/调整须先更新 UI 设计（AGENTS.md §6.3.1），并识别滚动条规范（UI-SCROLL-001） | P0 之前先出"编码区交互设计"稿并登记版本 |
| 既有文档 | 本轮不改需求/设计；CR-015 只写了"文件树、行号编辑器" | 若采纳 P0/P1，按 CR 流程补范围与 AC |

## 13. 调研边界

- 只读源码，**未运行 openidea**，未验证其快捷键在 Windows 上的真实手感、未测性能、未验证各语言 LSP 的实际可用性。
- 行号基于本地 HEAD `707b1f7`；上游在演进，引用前应重新核对。
- 未审计 Apache-2.0 之外的传递依赖许可（`THIRD_PARTY_LICENSES.md` 未逐项读）；若将来复制代码，须按 AGENTS.md §6.2 核对许可、保留版权与 NOTICE。
- 本项目现状部分来自对本仓库源码的实读（`src/modules/editor/*`、`src/api/*`、`src-tauri/src/*`），未做 GUI 实测，属"源码事实"而非"行为验收"。
