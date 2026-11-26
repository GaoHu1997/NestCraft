# LLD-CR097：知识库阅读与文件交互五项修正实现方案

- 关联：[CR-097](../PRD/CR-097-知识库阅读与文件交互五项修正.md)／[STORY-114](../Plan/Story/STORY-114-知识库阅读与文件交互五项修正.md) AC-01～12／[UI-CR097-v1](../UI/文档/UI-CR097-知识库阅读与文件交互修正.md)
- 授权：用户 2026-11-26 确认「授权编码，按设计稿实现」；Office 组件「首次使用时联网下载受管组件」；图片「单图缩放 + 同目录多图左右切换」。
- 唯一 Feature：FEAT-009（本会话只实现该 Feature 内 STORY-114）。
- 范围：`src/modules/knowledge/**`、`src/api/knowledge-preview.ts`、`src-tauri/src/commands/{kb_preview,kb_semantic,kb_office}.rs`、`src-tauri/src/{lib.rs,storage_layout.rs,commands/mod.rs}`。不触碰并发代理在改的 `chat.rs`／`memory.rs`／`platform_agent.rs`／`overview/**`。

## 1. 现状与受影响模块

| 项 | 现状 | 本方案改动 |
| --- | --- | --- |
| 上传入口 | `Reader.tsx` 的 `kw-create-actions` 独立按钮 | 删除该行；保留 `PagedKnowledgeTree` 的目录 `+` 菜单与拖拽 |
| PDF／Office | `kb_preview.rs` 对非 PDF 一律走 `soffice()`；缺失即 `CONVERTER_UNAVAILABLE` | PDF 路径不变（本就不转换）；新增受管组件检测／下载／安装与状态卡 |
| 语义模型 | `app_data_dir()/semantic-model` | 数据根 `<data>/semantic-model` + 旧位置幂等迁移 |
| 图片 | `figure.kw-image` 300/560px 两态 | 新增 `ImageZoomViewer` 灯箱：缩放／平移／同目录多图切换 |
| Markdown 操作组 | `.zy-view-actions` 常显 | 默认隐藏、悬停／聚焦浮现、触摸常显 |
| 正文滚动 | `<div hidden>` 截断 `flex` 链 | 改为 `.kw-doc-pane`（`display:flex; flex-direction:column; flex:1; min-height:0`） |

## 2. 选定方案

### 2.1 上传入口（AC-01/02）

删除 `Reader.tsx` 中 `<div className="kw-create-actions">…</div>` 一行；对应 `.kw-create-actions` 样式保留（其他入口不依赖该 DOM）。不新增按钮、不改目录菜单。

### 2.2 格式分流与 Office 状态卡（AC-03/04/05）

- 后端新增 `commands/kb_office.rs`：
  - `SOFFICE_VERSION = "26.2.7"`，MSI `sha256 = 480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59`；
  - 候选源：南京大学镜像、TDF 官方（与 `scripts/prepare-office-runtime.mjs` 同源同哈希）；
  - `soffice_path()`：`NESTCRAFT_SOFFICE` → `<data>/office/LibreOffice/program/soffice.exe` → 资源目录／exe 同级 → `Program Files` → `PATH`；
  - `kb_office_state() -> { installed, dir, version }`；
  - `kb_office_prepare()`：下载 MSI 到 `<data>/office/.cache/`，`accelerated_fetch` 校验 SHA-256，再 `msiexec /a <msi> /qn TARGETDIR=<data>/office/LibreOffice` 行政解包（不安装、不改文件关联），进度事件 `kb-office-progress`，失败事件 `kb-office-error`；
  - 仅 Windows 支持；其他平台返回 `OFFICE_UNSUPPORTED_PLATFORM`。
- `kb_preview::soffice()` 增加数据根候选（复用 `kb_office::soffice_path()`），保持既有安全校验（宏、外链、私有临时目录）不变。
- 前端 `PagedDocumentPreview`：`CONVERTER_UNAVAILABLE` 时渲染 `OfficeConverterCard`（设计 SC-097-02）：说明、`准备组件`（调用 prepare 并显示进度）、`重试`、`下载原件`；准备完成后自动重试一次（`generation + 1`）。

### 2.3 语义模型统一到数据根（AC-06/07）

- `storage_layout::CATEGORIES` 增加 `"semantic-model"`。
- `kb_semantic::install::installed_root()` 默认改为 `storage_layout::category("semantic-model")`（`MODEL_ROOT` 仍可覆盖）。
- `lib.rs` 启动：`set_model_root(dir.join("semantic-model"))` 改为用数据根；新增 `migrate_legacy_model_root(new_dir)`：若旧 `%APPDATA%/NestCraft/semantic-model` 存在，逐文件复制，目标已存在且大小相同则跳过，失败只记日志，不阻塞启动。
- 前端显示沿用 `SemanticModelStatus` 的「模型目录」，来源仍是 `kb_semantic_model_state().dir`，无需改动。

### 2.4 图片查看器（AC-08/09）

- 新增 `src/modules/knowledge/ImageZoomViewer.tsx`：
  - props：`items: {src,name}[]`、`index`、`onIndexChange`、`onClose`、`origin`；
  - `<dialog>` 全屏；工具条：文件名、百分比、`−`／`＋`、`适应窗口`、`100%`、关闭；
  - 滚轮缩放（`10%–800%`）、指针拖拽平移、`ArrowLeft/ArrowRight` 切图、`Esc` 关闭、关闭后 `origin.focus()`；
  - 不做任何写操作。
- `Reader.tsx`：图片分支改为 `<figure class="kw-image"><button class="kw-image-open">…</button></figure>`，点击打开查看器；同目录多图来自 `session.directory.entries` 中同父路径的图片文件。

### 2.5 Markdown 操作组与正文滚动（AC-10/11）

- `zy-doc.css`：`.zy-view-actions{visibility:hidden;opacity:0;pointer-events:none}`；`.zy-view-head:hover .zy-view-actions`、`.zy-view-head:focus-within .zy-view-actions`、`@media (hover:none)` 显示。
- `Reader.tsx`：`<div hidden={docPanel !== "doc"}>` → `<div className={…kw-doc-pane} hidden={…}>`；新增 CSS `.knowledge-workspace .kw-doc-pane{display:flex;flex-direction:column;flex:1;min-height:0}`。
- 不引入 `overflow:hidden`，滚动条沿用 UI-SCROLL-001 既有机制。

## 3. 接口与错误处理

| 命令 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `kb_office_state` | 无 | `{installed, dir, version}` | 平台不支持返回 `installed:false` + `error` |
| `kb_office_prepare` | 无 | `{installed, dir}` | `OFFICE_DOWNLOAD_FAILED`／`OFFICE_EXTRACT_FAILED`／`OFFICE_UNSUPPORTED_PLATFORM` |
| `kb_preview_open`（既有） | 不变 | 不变 | `CONVERTER_UNAVAILABLE` 语义不变（前端按新卡片呈现） |

事件：`kb-office-progress` `{phase,done,total}`、`kb-office-error` `{error}`。

## 4. 数据、权限与兼容

- 无数据库结构变更（DB 不适用）；模型目录与 Office 目录均为文件系统位置调整。
- 迁移为「补齐不覆盖」，可重复执行；旧目录保留不删除，避免误删用户文件。
- Office 安装复用既有下载器与哈希校验，不引入新依赖；新增代码仅用 `std::process::Command`。
- 权限范围不变：知识库仍为本人资料管理，AI 只读授权不变。

## 5. 实施顺序与验证

1. 前端：上传按钮移除、`.kw-doc-pane`、操作组样式、图片查看器 → `npx tsc --noEmit`。
2. 后端：`storage_layout`、`kb_semantic`、`kb_office`、`kb_preview`、`lib.rs`、`mod.rs` → `cargo check --all-targets`。
3. 前端 Office 状态卡与 API。
4. 构建：`npm run build`；定向测试 `cargo test --lib kb_`。
5. 视觉对照：按 UI-CR097-v1 逐场景截图（1440×900 浅/深、390），与设计稿同条件对比；未验证项如实记录。

## 6. 风险与回退

- MSI 解包耗时（约 1–3 分钟）：异步执行 + 进度事件 + 可重试；失败不写入半成品（成功后 `installed` 才为真）。
- `msiexec /a` 在受限环境可能被策略阻止：失败返回明确错误码，界面保留「下载原件」出路。
- 回退：删除 `<data>/office` 与 `semantic-model` 即可恢复「缺组件／缺模型」降级路径，业务数据不受影响。

## 7. 未决项

无（D1～D3 已由用户 2026-11-26 决定）。
