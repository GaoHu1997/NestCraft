# UI-CR097-v1：知识库阅读与文件交互修正（设计）

- 版本：`UI-CR097-v1`（2026-11-26，设计待评审；**未实现**）
- 来源与授权：[CR-097](../../PRD/CR-097-知识库阅读与文件交互五项修正.md)；用户 2026-11-26 五条反馈。本轮只做设计，无编码授权。
- 唯一归属：[EPIC-005](../../Plan/Epic/EPIC-005-知识阅读与项目授权.md) → [FEAT-009](../../Plan/Feature/FEAT-009-知识库目录与正文阅读.md) → [STORY-114](../../Plan/Story/STORY-114-知识库阅读与文件交互修正.md)
- 可操作设计稿：[docs/UI/knowledge-fix-cr097/index.html](../knowledge-fix-cr097/index.html)（独立打开；公开原型入口仍为 `docs/UI/仿真原型UI.html`，本稿为内部评审资源）
- 设计验证：[REPORT-CR097 设计验证](../../Test/REPORT-CR097-知识库修正设计验证.md)／基线 `docs/Test/cr097-design-baseline.json`／截图 `docs/Test/screenshots/cr097/`

## 1. 场景覆盖

| 场景 | 演示内容 | 覆盖状态 | 证据 |
| --- | --- | --- | --- |
| SC-097-01 左栏顶部无上传按钮 | `kb-side-top` 下只有首页／空间选择与搜索；顶部无独立「上传」按钮；「空间目录 +」仍含上传；提示条说明入口位置 | 浅色、深色 | `01-upload-light.png`、`02-upload-dark.png` |
| SC-097-02 Office / PDF 预览 | 组件缺失状态卡（准备组件／重试／下载原件）、转换中（进度＋取消）、预览就绪（实际页数＋只读）、PDF 直接预览 | 浅色三态＋深色 PDF | `03`～`06` |
| SC-097-03 图片查看器 | 顶部工具条（文件名、百分比、−／＋、适应窗口、100%、关闭）；图片居中可缩放平移；底部操作提示 | 浅色默认与放大 | `07-image-default-light.png`、`08-image-zoomed-light.png` |
| SC-097-04 Markdown 阅读页 | 右上「编辑／更多」默认隐藏（透明、不可点、不可聚焦）、悬停浮现；长文可滚到底；滚动条按需出现；390 窄屏 | 浅色隐藏／悬停／滚动、深色悬停、390 窄屏 | `09`～`13` |
| SC-097-05 语义模型目录位置 | 设置→数据与存储：数据根、模型目录 `<数据根>\semantic-model`、迁移记录、知识库侧显示一致 | 浅色、深色 | `14-model-light.png`、`15-model-dark.png` |

不适用：Office 转换器自身的安装引导界面不在知识库内（准备方式见 CR-097 D2）；旧 `.doc/.ppt/.xls` 明确不支持，不设计预览状态。

## 2. 交互规则

- **上传入口**：移除左栏顶部独立按钮；上传保留在「空间目录 +」与目录行「+」菜单、拖拽。不减少功能。
- **格式分流**：`.pdf` 直接预览；Office 需本机受管组件；缺失 → 状态卡；转换中 → 进度／取消；成功 → 分页只读；旧版格式 → 明确不支持。状态卡文案说明“未伪造正文”。
- **图片查看器**：点击正文图片打开；初始适应窗口（100%）；±10%；滚轮缩放；拖拽平移；范围 10%–800%；Esc／关闭返回并回焦原图；不写回原件。
- **右上操作组**：默认 `visibility:hidden; opacity:0; pointer-events:none`；`.doc-head:hover`、`:focus-within`、`body.sim-hover` 时可见；`@media (hover:none)` 常显。工具栏不得遮挡正文（浮在头部行内，不覆盖文字）。
- **正文滚动**：`doc-scroll` 承接 `flex:1; min-height:0; overflow:auto`，其祖先整链需 `min-height:0`；本稿以此演示“可滚到底”。

## 3. UI-SCROLL-001（滚动条按需显示）

适用 [UI-CR049 滚动条按需显示](UI-CR049-滚动条按需显示.md)：

- 适用区域：SC-097-04 正文阅读区（`doc-scroll`）、左栏文件树、图片查看器外的容器。
- 规则：默认隐藏外观；实际滚动时仅目标容器显示；停止滚动约 700ms 后隐藏；悬停／聚焦不单独唤醒；不改变正文宽度、不丢草稿与选区。
- 设计稿采用共享 `workbench-v4/scrollbar.js`（`.scrollbar-active` 机制），截图 `11-md-scrolling-light.png` 为滚动中的动态证据。
- 软件实现须在同一场景复验初始隐藏、滚动显示、停止隐藏；不得用 `--hide-scrollbars` 或测试专用样式替代。

## 4. 资源与指纹

- 设计稿：`docs/UI/knowledge-fix-cr097/index.html`（自包含 HTML，引用 `workbench-v4/tokens.css` 与 `base.css`、`scrollbar.js`）。
- 截图 15 张与每张 sha256 前 16 位见 [cr097-design-baseline.json](../../Test/cr097-design-baseline.json)；断言 17/17 通过、0 JS 异常。
- 视口：1440×900（主）+ 390×844（SC-097-04 窄屏）；主题：浅／深。

## 5. 与软件对照计划（实现后执行）

| 场景 | 设计版本 | 软件实现位置（预期） | 对照要求 |
| --- | --- | --- | --- |
| SC-097-01 | UI-CR097-v1 | `src/modules/knowledge/Reader.tsx` | 同视口同数据截图：顶部无上传按钮、+ 菜单有上传 |
| SC-097-02 | UI-CR097-v1 | `kb_preview.rs`、`PagedDocumentPreview.tsx` | 四态截图：缺失／转换中／就绪／PDF |
| SC-097-03 | UI-CR097-v1 | `Reader.tsx`、复用 `AttachmentImages.tsx` | 默认与放大、拖拽、Esc 回焦 |
| SC-097-04 | UI-CR097-v1 | `ZyDocEditor.tsx`、`Reader.tsx`、`knowledge-cr045.css` | 隐藏／悬停、滚动三帧（初始／滚动中／停止）、390 窄屏 |
| SC-097-05 | UI-CR097-v1 | `lib.rs`、`kb_semantic.rs`、`storage_layout.rs` | 目录显示与迁移结果、旧位置不再使用 |

## 6. 已知偏离与待确认

- D1 上传入口形态、D2 Office 组件准备方式、D3 图片查看器是否多图切换，均待用户答复（见 CR-097 §7）。设计稿按推荐形态（保留目录上传、组件可准备、单图缩放）呈现。
- 本稿为设计预期；软件截图不能替代本稿，本稿也不代表软件已实现。

## 7. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| UI-CR097-v1 | 2026-11-26 | 建立五场景设计稿、UI-SCROLL-001 适用说明与对照计划；未实现 |
