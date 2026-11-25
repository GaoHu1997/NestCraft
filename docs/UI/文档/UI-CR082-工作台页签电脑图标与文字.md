# UI-CR082-v1：工作台页签＝电脑图标 + 文字「工作台」

- 状态：**已实现到设计稿与正式软件**（设计先行，随后同步软件）
- 日期／版本：2026-11-25，UI-CR082-v1
- 来源：[CR-082](../../PRD/CR-082-工作台页签电脑图标与文字.md)；修订 [UI-CR054-v1](UI-CR054-会话中心工作台.md) 的页签形态与 [STORY-071](../../Plan/Story/STORY-071-工作台页签与三栏布局.md#cr-082增量) AC-071-01／02d
- 可视入口：[唯一业务原型](../仿真原型UI.html) → 打开任一项目 → 页签条最前「🖥 工作台」

## 1. 唯一视觉基准与设计差异

| 项 | 采用值 |
| --- | --- |
| 页签内容 | 电脑（显示器）图标 + 文字「工作台」 |
| 图标符号 | `monitor`（24×24、1.6px 描边、round cap/join）：外框 `rect x=3 y=4.5 w=18 h=12 rx=2`，支架 `M12 16.5v4`，底座 `M9 20.5h6` |
| 页签内图标尺寸 | 16px（原型类 `ico-16`；软件 `Icon size={16}`） |
| 图标与文字间距 | 6px |
| 文字 | 13px，沿用项目页签 `.ws-tab`（原型）／`.pw-tab`（软件）既有字号与字重；选中 600 |
| 页签高度 | 44px（原型 `cr036.css` 覆盖值／软件 `projects.css`） |
| 水平 padding | 原型 `0 12px`；软件 `0 14px`（各自沿用相邻文字页签口径） |
| 选中下划线 | 原型 `left/right: 8px`；软件 `left/right: 10px`（沿用 `.pw-tab` 既有规则，不再单独覆盖） |
| 可读名称 | `aria-label`／`title`＝「工作台」，`role=tab`、`aria-selected` 不变 |

相对 UI-CR054 的差异仅此一处：**去掉“纯图标、不显示文字”的形态**，其余三栏、右栏、会话区与页签序列不变。

## 2. 受影响场景与覆盖检查

| 场景 | 覆盖 | 证据 |
| --- | --- | --- |
| 编码项目页签条（工作台/需求/设计/任务/编码） | ✅ 选中态与未选中态 | `docs/Test/screenshots/cr082-design/01-workbench-tab-active.png`、`03-other-tab-active.png` |
| 办公项目页签条（工作台/文档/成果） | ✅ 同一渲染分支（`TABS.work`） | 原型与软件共用 `workbench` 分支，无独立代码路径 |
| 深色主题 | ✅ | `docs/Test/screenshots/cr082-software/03-workbench-tab-dark-1440.png` |
| 390 窄屏（CR-052 溢出下拉） | ✅ 无横向滚动、页签可读 | `docs/Test/screenshots/cr082-software/04-workbench-tab-390.png` |
| 图标缺失回退 | ✅ 软件 `Icon` 对未登记名称输出 `data-icon-missing` 警告；`monitor` 已加入 `ICON_NAMES` 与 sprite | `src/components/icons.tsx`、`public/ui/icon-sprite.svg` |
| 滚动条 UI-SCROLL-001 | 不适用：本次未新增或变更任何滚动容器；页签条横向溢出按 CR-052 走「更多」下拉，不启用横向滚动 | 见 §2 390 场景探针 `docOverflowX=0`、`hostOverflow=0` |

## 3. 资源版本与指纹

采用资源（SHA-256 前 16 位，2026-11-25 实测）：

| 资源 | 指纹 |
| --- | --- |
| `docs/UI/workbench-v4/core.js`（`monitor` 符号 + `P` 注册表） | `3c8f565383b387c9` |
| `docs/UI/workbench-v4/icon-sprite.svg`（`monitor` 符号） | `41edbe035dc7dcf2` |
| `docs/UI/workbench-v4/workbench.js`（页签渲染为图标＋文字） | `c0555fa40c25b289` |
| `docs/UI/workbench-v4/workbench.css`（页签排版） | `52b202c893bb378c` |
| `docs/UI/workbench-v4/index.html`（未改动，仅记录基线） | `ee97f6d0dc9cf27e` |
| `public/ui/icon-sprite.svg`（软件图标库） | `41edbe035dc7dcf2` |
| `src/modules/projects/Workspace.tsx`（页签渲染） | `b5e856cfcd9c3bee` |
| `src/modules/workbench/workbench.css`（页签排版） | `09cb406f9c6df336` |
| `src/components/icons.tsx`（`monitor` 登记） | `d3dd2332b2b37ed3` |

## 4. 设计/软件对照

| 对照项 | 设计稿（原型） | 正式软件（隔离预览） | 结论 |
| --- | --- | --- | --- |
| 文本 | 「工作台」 | 「工作台」 | 一致 |
| 图标 | `#monitor`，16×16 | `data-icon="monitor"`，16×16 | 一致 |
| 间距 | `gap:6px` | `gap:6px` | 一致 |
| 垂直对齐 | 图标中心 118 = 文字中心 118 | 图标中心 117.5 = 文字中心 117.5 | 一致（≤1px） |
| 页签高度 | 44px | 44px | 一致 |
| 选中下划线 | 8px 内缩（原型口径） | 10px 内缩（软件 `.pw-tab` 口径） | 允许差异：两侧各自沿用既有文字页签口径，均与同条相邻页签一致 |
| 可读名称 | `aria-label`／`title`「工作台」 | 同 | 一致 |

## 5. 验证

- 设计侧：`node docs/Test/cr054-prototype-check.mjs` → 15 条通过（含改判后的 C1／C15）；C16「包含文件链接」失败为原型会话夹具既有差异，与本次页签改动无交集（详见 [REPORT-CR082](../../Test/REPORT-CR082-工作台页签图标与文字验证.md#4-未验证与边界)）。
- 设计截图：`node scripts/shot-cr082.mjs` → `docs/Test/screenshots/cr082-design/`（3 张 + `result.json`），0 JS 异常。
- 软件侧：`node scripts/verify-cr082-software.mjs`（前置 `npx vite --port 1420 --strictPort`）→ 10/10 通过、0 JS 异常，截图 4 张 + `docs/Test/cr082-software-baseline.json`。
- 构建：`npm run build`（`tsc --noEmit` + `vite build`）exit 0。

## 6. 未验证与限制

- 真实 Tauri 窗口（App 进程内）未截取：当前环境无可用的应用窗口调试端口；隔离设计预览（`?preview=design`）使用同一 React 组件与样式，已覆盖结构与几何。
- 办公项目页签条未单独截图：与编码项目共用同一渲染分支与样式，仅页签序列不同。
