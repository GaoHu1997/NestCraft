# LLD：CR-070 主界面导航精简与项目/知识库图标悬浮层实现方案

- 关联需求：[CR-070](../PRD/CR-070-主界面导航精简与图标悬浮层.md)；Story：[STORY-092](../Plan/Story/STORY-092-主界面导航精简与图标悬浮层.md)；UI：[UI-CR070-v1](../UI/文档/UI-CR070-导航精简与图标悬浮层.md)。
- 设计版本：UI-CR070-v1，资源指纹见 [cr070-design-baseline.json](../Test/cr070-design-baseline.json)；用户已授权编码（2026-11-24"改完需求/设计/方案之后调整代码"）。
- 本次设计范围：首页侧栏、顶栏、项目卡片与编辑弹窗、知识库卡片；不涉及项目窗口内部、设置中心、会话。

## 1. 当前实现与受影响模块

| 模块 | 文件 | 变更 |
| --- | --- | --- |
| 首页侧栏 | `src/App.tsx:182-204` | 删除"当前项目"分区（`nc-nav-section` 标签、`nc-side-project`/`nc-side-empty`）与"快捷入口"分区（两个快捷按钮）；保留工作空间四项与底部 `nc-side-avatar-frame` |
| 顶栏 | `src/App.tsx:146-170` | 删除 `nc-avatar-frame`（头像按钮 + `AvatarHoverEdit`）；`data-avatar-style` 根属性保留（侧栏/设置仍用） |
| 侧栏派生状态 | `src/App.tsx:141`（`currentProject`）、`openProject` | `currentProject` 不再被侧栏使用后删除；`openProject` 仍被搜索弹窗等使用，保留 |
| 图标悬浮层（新增） | `src/components/icon-tiles.tsx`（新组件 `IconPopover`） | 居中 mask + 弹层；props：`kind`、`target`（对象快照）、`onSave(icon,color)`、`onClose`；内部渲染 10 色卡 + 50 图标 6 组 + 预览 + 取消/保存 |
| 项目卡片 | `src/modules/projects/ProjectHome.tsx:61` | 图标砖包 `IconPopover` 触发按钮（`icon-tile-btn`）；编辑弹窗删 `<details>` 图标折叠区（`iconDraft/colorDraft` 状态与保存逻辑一并删），字段行改为只读预览 |
| 知识库卡片 | `src/modules/knowledge/KnowledgeHome.tsx:127-148` | `LibraryIconDialog` 删除；卡片图标砖包触发按钮开 `IconPopover`，保存走 `api.kbSetAppearance`；"图标"按钮改开悬浮层（保留习惯入口） |
| 样式 | `src/theme/cr051-v6.css` | 新增 `.icon-tile-btn`、`.icon-pop-*` 段；复用 `.cr51-swatch`、`.cr51-picker-group(s)`、`.cr51-tile`、`.cr51-color-*` 既有类 |
| 设计原型 | `docs/UI/workbench-v4/` | 已同步（core/screens/cr070.*）；软件与其对照 |

## 2. 选定方案与关键约束

1. **悬浮层组件**放 `icon-tiles.tsx`（资产同源），React 受控：`useState` 保存 `icon`/`color` 草稿，选择即时预览；"保存"回调上层执行 IPC（项目 `updateProject(id,name,rootUri,icon,color)` 成对传值；知识库 `kbSetAppearance(id,icon,color)`）；关闭/取消丢弃草稿。Escape、mask 按下、关闭按钮均走"取消"。
2. **焦点与滚动**：悬浮层挂 `document.body` portal，打开时聚焦弹层首个按钮；正文区 `overflow-y:auto`，滚动条显隐由已安装的 UI-SCROLL-001 共享机制（`src/components/scrollbar.ts`）自动接管，不新增滚动样式。Escape 处理在 document 捕获阶段注册（同 `tab-overflow.tsx` 模式），与既有弹窗（Modal/avatar 弹窗）并存：仅在悬浮层为最上层打开时消费。
3. **项目保存语义**：编辑弹窗不再带图标草稿；`submit` 仍调 `api.updateProject(id, name, rootUri)` 不传 icon/iconColor（API 契约 undefined=保持不变），图标仅由悬浮层成对写入。新建项目弹窗本就无图标。
4. **知识库默认图标推导**：悬浮层预览与"默认"格回退沿用 `libraryIconId`/`projectIconId` 现有推导，不新增第二套推导。
5. **样式与主题**：颜色全部沿用 cr051-v6 的 `.cr51-color-*`（浅深各自取值）；悬浮层宽度 460px、上限 `calc(100dvh - 48px)`；窄窗（<520px）宽度 100%。
6. **权限与数据**：无新增 IPC、无数据库变更（复用 `projects.icon/iconColor`、`kb.icon/iconColor`）；白名单校验在后端既有命令中，前端不做二次白名单硬编码（沿用 `ICON_GROUPS` 常量渲染）。

## 3. 验证与交付

- 构建：`npx tsc --noEmit`、`npm run build` 必须通过。
- 行为验证（隔离预览 `?preview=design` 或 UI 冒烟）：侧栏无旧分区、顶栏无头像、悬浮层 10 色卡 + 50 图标、保存后卡片/授权弹窗同步、取消不落库。
- 视觉对照：同视口（1440×900、100%）浅/深主题，设计稿（workbench-v4 原型）与软件成对截图，覆盖侧栏、顶栏、项目悬浮层、知识库悬浮层；差异登记后交付。
- UI-SCROLL-001：悬浮层正文滚动三帧（隐藏→滚动显示→停止隐藏）证据；无法取得时如实登记未验证。
- 冒烟回归：`src/smoke/ui-suite.ts` 中 CR-051 断言（`nc-avatar`、`nc-side-project`、知识库图标弹窗选择器）随本次实现同步更新，避免用例漂移报假失败。

## 4. 未决项与假设

- 侧栏精简后"运行队列/设计资料"入口消失：任务/设计仍可从项目窗口页签进入（不改页签）；假设用户接受（需求 §2.2 已明确）。
- 设置中心入口只剩侧栏底部头像：与用户问答确认一致。
- 软件截图对照依赖本机可运行 Tauri 预览；环境受限时以隔离预览取证并登记限制。
