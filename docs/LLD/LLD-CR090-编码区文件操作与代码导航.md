# LLD-CR090：编码区文件操作与代码导航（第一版）实现方案

- 关联需求：CR-090（编码区文件操作与代码导航）；Story：STORY-101（文件树操作）、STORY-102（页签与打开交互）、STORY-103（定义跳转与面包屑）；归属 Feature：FEAT-007。
- 设计基准确认后按 UI-CR090-v1 实施；设计稿就绪前只允许做不触及界面的部分（Rust 命令、符号索引算法）。
- 日期：2026-11-25；负责人：lead；本轮授权依据：用户 2026-11-25「可以，做吧，但是需要开子代理并行开发」。

## 1. 本次要解决的问题

编码区当前只具备"文件树浏览 + 单文件编辑"：无文件增删改、无打开方式配置、无页签重排、无任何代码导航。本轮补齐到"能像 IDE 一样读代码"的最小闭环，**不引入 LSP**。

明确不在本轮：跳转到实现类、查找引用、类型层级、代码补全、悬停文档、多分屏、调试与重构。这些需要完整 LSP 通道（见 §9 未决项），单独立 CR。

## 2. 当前实现与复用点

| 现有能力 | 位置 | 复用方式 |
| --- | --- | --- |
| 编码页签壳（rail/树/编辑器） | `src/modules/projects/Workspace.tsx:1042`（`CodePane`） | 不改结构，只加状态与菜单入口 |
| 文件树（分页 + 虚拟滚动 + 搜索） | `src/modules/editor/FileTree.tsx` | 增加右键菜单、行内输入、操作回调 |
| 页签条 | `src/modules/editor/EditorTabs.tsx` | 增加拖拽排序、预览态样式 |
| 编辑器与页签状态 | `src/modules/editor/index.tsx`（`CodeArea`，615 行） | 增加 preview 标记、`openAt`、面包屑与跳转扩展 |
| 文件打开定位 | `index.tsx` 的 `locateTarget` / `onLocate` | 复用其"打开并高亮行"能力 |
| 目录分页 API | `src/api/editor-performance.ts:directoryPage` | 操作成功后局部 `load(dir, true)` 刷新 |
| 根目录越界校验 | `src-tauri/src/commands/fs.rs:ensure_under` | 新命令复用同一校验 |
| 确认弹窗 / toast / 空态 | `src/components/ui.tsx`（`Confirm`、`useToast`、`Empty`） | 直接复用 |
| 图标 | `src/components/icons.tsx` | 复用，不新增图标族 |

现有 UI 组件里**没有菜单/右键菜单**，需新增一个轻量 `ContextMenu`（不引入依赖）。

## 3. 模块拆分与文件归属（并行开发边界）

| 工作包 | 负责人 | 允许新增/修改 | 依赖 |
| --- | --- | --- | --- |
| WP-A 后端命令 | rust-fs | `src-tauri/src/commands/fs_ops.rs`（新）、`fs.rs`（两处精确改）、`lib.rs`（注册） | 无，可先做 |
| WP-B 文件树操作 | 前端 B | `src/modules/editor/FileTree.tsx`、新增 `src/modules/editor/FileContextMenu.tsx`、`src/modules/editor/file-ops.ts`、`src/api/fs-ops.ts`、`CodeArea.css`（追加） | WP-A 的命令签名、设计稿 |
| WP-C 页签与打开交互 | 前端 C | `src/modules/editor/EditorTabs.tsx`、`index.tsx`（页签/打开相关片段）、`CodeArea.css`（追加） | 设计稿 |
| WP-D 代码导航 | 前端 D | 新增 `src/modules/editor/navigation/*`（`modifier.ts`、`symbols.ts`、`goto.ts`、`GotoPopup.tsx`、`Breadcrumbs.tsx`、`history.ts`）、`index.tsx`（挂扩展、快捷键） | 设计稿、`symbols.ts` |
| 集成 | lead | 冲突裁决、`npm run build`、`cargo test`、文档收尾 | 全部 |

**冲突规避**：`CodeArea.css` 与 `index.tsx` 会被 B/C/D 同时改，因此约定：
- CSS 一律**追加到文件末尾**，各自用独立前缀类名：B 用 `.cda-menu*`、C 用 `.cda-tab-*`（拖拽相关 `.cda-tab-drop`）、D 用 `.cda-nav-*` / `.cda-crumb*`。
- `index.tsx` 的改法：B 只加操作回调与状态；C 只改页签渲染与 open 逻辑；D 只加扩展装配与快捷键。合入时由 lead 逐段核对。

## 4. 接口契约

### 4.1 Rust 命令（WP-A）

```rust
#[tauri::command] pub fn fs_create_file(root_uri: String, rel_path: String) -> Result<(), String>
#[tauri::command] pub fn fs_create_dir(root_uri: String, rel_path: String) -> Result<(), String>
#[tauri::command] pub fn fs_rename(root_uri: String, from_rel: String, to_rel: String) -> Result<(), String>
#[tauri::command] pub fn fs_delete_path(root_uri: String, rel_path: String) -> Result<(), String>
#[tauri::command] pub fn fs_path_exists(root_uri: String, rel_path: String) -> Result<bool, String>
```

- 全部经 `ensure_under` 校验；拒绝绝对路径越界、`..` 逃逸、符号链接目标、根目录自身删除。
- `fs_create_file` 用 `create_new` 防竞态，已存在返回「已存在同名文件」。
- `fs_delete_path` 只删文件与**空目录**，非空返回「目录非空」。
- 错误字符串中文、可直接展示。

### 4.2 前端 API（WP-B，`src/api/fs-ops.ts`）

```ts
export const createFile = (rootUri: string, relPath: string) => invoke<void>("fs_create_file", { rootUri, relPath });
export const createDir  = (rootUri: string, relPath: string) => invoke<void>("fs_create_dir", { rootUri, relPath });
export const renamePath = (rootUri: string, fromRel: string, toRel: string) => invoke<void>("fs_rename", { rootUri, fromRel, toRel });
export const deletePath = (rootUri: string, relPath: string) => invoke<void>("fs_delete_path", { rootUri, relPath });
export const pathExists = (rootUri: string, relPath: string) => invoke<boolean>("fs_path_exists", { rootUri, relPath });
```

风格与 `editor-performance.ts` 一致（camelCase 参数，Tauri 自动映射 snake_case）。

### 4.3 文件树契约（WP-B）

```ts
// FileTree 新增 props（保持向后兼容，全部可选）
interface FileTreeProps {
  rootUri: string;
  onOpenFile: (path: string) => void;
  /** 单击是否直接打开（默认 false：单击选中、双击打开） */
  singleClickOpen?: boolean;
  /** 预览打开（单击时以预览页签打开） */
  previewOpen?: boolean;
  /** 树内已被外部删除/改名后由父级刷新 */
  revision?: number;
}

// FileContextMenu 由 FileTree 内部持有，不暴露给父级
type FileAction = "newFile" | "newDir" | "rename" | "delete" | "refresh" | "open";
```

操作流：
1. 右键行（或空白处 → 根目录）→ `ContextMenu`，按节点类型给项（文件：打开/重命名/删除；目录：新建文件/新建文件夹/重命名/删除/刷新；空白：新建/刷新）。
2. 新建 → 目标目录下插入行内 input（`editing = { kind: "new"|"rename", parent, name }`）；Enter 提交、Esc 取消、失焦取消（新建）或提交（重命名，与 IDEA 一致）。
3. 提交 → `createFile/createDir/renamePath`；成功后 `load(parentDir, true)` 局部刷新并选中新节点；失败 → toast + 保持编辑态。
4. 删除 → `Confirm` 二次确认显示完整相对路径 → `deletePath` → 刷新父目录；若该文件在页签中打开，通知编辑区关闭该页签（`onPathRemoved(path)` 回调，由 C 工作包实现）。
5. 校验：空名、`/ \ : * ? " < > |`、首尾空格、`.`/`..`、重名（`pathExists` 预检 + 后端兜底）。

### 4.4 页签与打开（WP-C）

```ts
interface EditorTab { path: string; dirty: boolean; preview: boolean }
// EditorTabs 新增
onReorder?: (from: number, to: number) => void;
// CodeArea 打开语义
openFile(path: string, opts?: { preview?: boolean; focus?: boolean }): void
openAt(path: string, line: number, col?: number): void   // 跳转/面包屑共用
```

- 预览页签：斜体、无脏标记时被下一次预览替换；双击页签、或在其内编辑、或显式 `openFile(path,{preview:false})` 即固定。
- 拖拽：Pointer Events（不用 HTML5 DnD，WebView 下不可靠），4px 阈值、拖动中半透明、目标位置显示 2px 插入线、松手 `onReorder`。
- 关闭脏页签：`Confirm`（保存/不保存/取消 → 简化为"放弃修改并关闭"/"取消"，与现有 `discardTarget` 逻辑合并）。

### 4.5 代码导航（WP-D）

```ts
// modifier.ts —— window 级 Ctrl 状态（capture 监听，blur 复位，排除 Alt/Shift）
export function isNavGesture(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean;
export function onNavModifier(fn: (held: boolean) => void): () => void;

// symbols.ts —— 轻量符号索引（语法级，不做类型推导）
interface SymbolDef { name: string; kind: "class"|"function"|"method"|"const"|"interface"|"type"|"enum"; path: string; line: number; col: number }
interface ImportRef { local: string; source: string; imported: string | null }
export function buildIndex(rootUri: string, files: string[]): Promise<SymbolIndex>;
export function resolveAt(text: string, path: string, offset: number): Promise<SymbolDef[]>;   // 0/1/N 个目标
export function outlineOf(text: string): { name: string; kind: string; line: number }[];      // 面包屑数据

// goto.ts —— 跳转编排
export function gotoDefinition(view: EditorView, at?: number): Promise<void>;   // 0/1/N 分支
export function pushHistory(path: string, line: number, col: number): void;
export function goBack(): boolean; export function goForward(): boolean;
```

**符号索引规则（第一版，明确精度边界）**
- 只扫 `.ts .tsx .js .jsx .mjs .cjs .py`，跳过 `node_modules/ .git/ dist/ build/ target/`；单文件上限 2 MB、总文件上限 5000。
- 提取声明：`export (default )?(async )?function NAME`、`class NAME`、`(const|let|var) NAME`、`interface NAME`、`type NAME =`、`enum NAME`、Python `def NAME`/`class NAME`。
- 解析引用：`import { a as b } from "…"`、`import x from "…"`、`import * as ns from "…"`、`export { a } from "…"`；相对路径解析成项目内路径（含 `index.ts`/`index.tsx` 与省略扩展名）。
- 解析顺序：同文件声明 → import 映射到目标文件声明 → 全项目同名（≤20 个，超出提示"匹配过多"）。
- 缓存：`Map<path, { mtime, size, defs }>`，页面生命周期内有效；文件保存成功后失效该文件；目录操作后失效该目录下文件。
- **不做**：类型推导、接口实现/重载解析、跨语言、`node_modules` 内定义、TS path alias。

**编辑器集成**
- 下划线：`StateField<DecorationSet>` + `ViewPlugin`，`mousemove` 时若 `isNavGesture` 且 `resolveAt` 命中则加 `.cda-nav-link`（下划线 + pointer），离开移除；`Ctrl` 松开清空（`onNavModifier`）。
- 点击：在 `EditorView.domEventHandlers.mousedown` 中判断 `isNavGesture(e) && e.button === 0` → `preventDefault`（避免误选区/多光标）→ `gotoDefinition`。
- 多目标：`GotoPopup`（绝对定位在光标处，输入过滤、↑↓、Enter、Esc），条目含图标、符号名、`相对路径:行`、该行源码预览。
- 面包屑：`Breadcrumbs` 渲染在路径栏下方，`文件 › 类 › 方法`，点击 `openAt`；文档变更 300ms 防抖重建。
- 导航历史：数组 + 指针，上限 100；`Alt+←/→` 触发；跳转前记录当前位置；同文件 4 行内合并（与 IDEA 一致）。

## 5. 状态与数据

不新增数据库。所有状态是页面内 React state（树的操作状态、页签 preview、索引缓存、导航历史）。刷新或切换项目即丢弃，符合现有编码区"不持久化 UI 状态"的约定。

## 6. 权限与安全

- 所有写入都限定在项目根内（后端 `ensure_under`），前端校验只作体验优化，不作安全依据。
- 删除只做"文件 + 空目录"，不递归；避免一个误操作删掉整个 `src`。
- 不跟随符号链接（沿用 `fs.rs` 现有策略）。
- 错误信息不泄露绝对路径以外的环境信息。

## 7. 性能

- 文件树操作后只刷新受影响目录（`load(parent, true)`），不整树重建。
- 符号索引按需构建（首次 Ctrl+悬停或打开面包屑时），构建中显示"正在索引…"；超过上限时降级为"仅当前文件"。
- 下划线探测按词缓存，同一 tick 不重复解析；文档变更清缓存。
- 面包屑按 300ms 防抖重建，不随每次按键重排 DOM。

## 8. 验证计划

| 项 | 方式 |
| --- | --- |
| Rust 命令 | `cargo test --manifest-path src-tauri/Cargo.toml fs_ops`（子代理负责），覆盖建/改/删/越界/重名 |
| 前端类型与构建 | `npm run build`（tsc --noEmit + vite build）必须 0 错误 |
| 文件树操作 | 手工：新建文件/目录、重名、非法字符、重命名、删除、只读失败、空目录 |
| 页签 | 手工：拖拽排序、预览替换、双击固定、脏页签关闭确认 |
| 跳转 | 手工：同文件、跨文件 import、多目标、无目标、不支持语言；确认跳转不改文件内容 |
| 视觉 | 与 UI-CR090-v1 同视口同主题逐场景对照；滚动条按 UI-CR049 验证（初始隐藏/滚动显示/停止隐藏） |
| 回归 | 编码区已有能力：打开大文件、Markdown 阅读/编辑、Ctrl+S 保存、外部定位跳行、Git 面板 |

## 9. 未决项与假设

1. **完整 LSP 通道**（真语义跳转、实现类、引用、补全）不在本轮；若要做，需单独 ADR 决定"内置 sidecar / 外置 server / 纯前端语法级"三条路线之一，并明确语言白名单与安装策略。
2. **跳转精度**：第一版是语法级符号索引，同名符号可能给出多目标；UI 上不承诺"类型精确"。是否可接受由产品判断（当前按可接受推进，多目标选择器兜底）。
3. **页签关闭语义**：现有实现只有"取消修改"，本轮沿用二选一确认，不新增"保存并关闭"（避免与自动保存冲突）。
4. **文件树拖拽移动**、**分屏**、**查找引用面板** 不在本轮，但结构上不排斥（`onReorder`、`file-ops` 已为后续留口）。
