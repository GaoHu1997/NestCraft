# LLD-BUG006：拖动侧栏分隔条蓝色框修复方案

- 关联需求／Story／AC：[BUG-006](../PRD/BUG-006-拖动侧栏分隔条偶发出现蓝色焦点框.md)、[STORY-116](../Plan/Story/STORY-116-拖动侧栏分隔条蓝色框修复.md)、AC-BUG006-01～06（以 BUG-006 §4 为单源）。
- 本次解决的问题：正式软件中所有 `.pane-handle` 在键盘模态后拖动／聚焦时，被全局 `:focus-visible` 画上 2px 主色外描边，形成 14px 宽、贯穿全高的蓝色框，偏离 SC-045-08。
- 执行身份：`projectId=AI_Delelovelop`、`featureId=FEAT-001`（单 Feature 会话）；授权＝用户 2026-11-26「授权正式编码」，范围限本缺陷。
- 状态：已实现，技术验证通过，待验收（真实 WebView2／用户目视未验）。

## 1. 当前实现、复用点与影响范围

| 项 | 事实 |
| --- | --- |
| 共享机制 | `src/components/pane-resize.tsx` 的 `usePaneWidth` / `ResizeHandle`，`src/components/pane-resize.css` 的 `.pane-handle`（6px、全高、`role=separator`、`tabIndex=0`） |
| 设计基准 | [UI-CR045-v1.1 SC-045-08](../UI/文档/UI-CR045-文档工作区与可调栏.md)：细分割线＋6px 可命中把手，hover/focus primary，不新增厚卡片或宽装饰；[UI-CR100-v1](../UI/文档/UI-CR100-AI侧栏窄容器适配.md) 侧栏宽度档 |
| 原型对应 | `docs/UI/workbench-v4/pane-resize.js`／`pane-resize.css`（同一契约，独立实现） |
| 受影响模块 | 所有挂载 `ResizeHandle` 的页面（`src/App.tsx` 管理导航／AI 侧栏，以及 workbench、chat、knowledge、office、servers、projects、settings 等复用点），共用同一个 CSS class |
| 明确不改 | `pane-resize.tsx` 的手势、焦点转移、键盘调宽；`src/theme/base.css` 全局 `:focus-visible`；宽度偏好与限幅；其它 Feature 的组件；任何 Rust／配置／构建产物 |
| 数据库 | 不适用：仅前端 CSS 轮廓，无实体、字段、约束或迁移 |

## 2. 根因与选定方案

根因链：`pointerdown → element.focus()`（`pane-resize.tsx:270`）→ 浏览器 `:focus-visible` 启发式命中 → 全局 `:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px }`（`src/theme/base.css:33`）覆盖同为 (0,1,0) 特异度的 `.pane-handle { outline: none }`（`src/components/pane-resize.css:4`）→ 2px 外描边 + `.pane-handle:focus-visible::after` 的 2px 主色握把线 → 三条蓝线与 14px 框。

**选定方案（最小、可逆、只改 CSS）**：在把手自身用更高特异度显式声明所有焦点态都不画外描边：

```css
/* BUG-006 / UI-BUG006-v1：6px 命中区外不画任何焦点环；键盘焦点与拖动只由 2px 握把线指示。 */
.pane-handle:focus, .pane-handle:focus-visible { outline: none; }
```

- `.pane-handle:focus-visible` 特异度 (0,2,0) > 全局 `:focus-visible` (0,1,0)，与装载顺序无关，稳定压过覆盖；`outline: none` 同时抑制 UA 原生焦点环。
- 键盘焦点可辨性由既有 `.pane-handle:hover::after, .pane-handle:focus-visible::after, .pane-handle.is-resizing::after { background: var(--primary) }` 提供（2px 主色线），不删全局 `:focus-visible`，其它控件不受影响（继承 CR-068 结论）。
- 拖动期间 `.pane-dragging * { user-select: none !important }` 与 pointer capture、限幅、双击重置、方向键均保持原样。

**备选与取舍**：

| 备选 | 不选理由 |
| --- | --- |
| 删除 `src/theme/base.css` 全局 `:focus-visible` | 破坏全平台键盘可访问性，CR-068 已明确否决 |
| 去掉 `pointerdown` 里的 `element.focus()` | 拖动后无法直接按方向键微调；且焦点环仍可能由 Tab 触发，未治本 |
| 给把手加 `outline: none !important` | `!important` 无必要（特异度已足够），且会压掉未来合法的显式覆盖 |
| 用 JS 在拖动时增删 class／`data-*` | 增加状态与卸载清理，收益低于 CSS 一行修复 |

## 3. 核心流程与契约

- 输入：鼠标／触控 pointerdown 于 `.pane-handle`，或键盘 Tab 聚焦／方向键。
- 输出：宽度变化与 `::after` 2px 主色指示；**不产生任何命中区外的 outline／border／box-shadow 轮廓**。
- 错误与边界：`pane-resize.tsx` 既有 `pointercancel`、`lostpointercapture`、`blur`、`visibilitychange`、卸载清理不变；≤600px 隐藏把手不变；深色主题 `--primary: #5b8dff` 下同样不画外描边。
- 接口：无新增 API／事件／存储；CSS 类名不新增（仅复用 `:focus-visible`）。

## 4. UI / 滚动条 / 权限 / 兼容性

- UI：现行基准 [UI-BUG006-v1](../UI/文档/UI-BUG006-拖动侧栏分隔条无蓝色焦点框.md)，设计资源先行更新并验证（设计侧 11/11），软件随后按稿实现；设计与软件成对证据见 `docs/Test/screenshots/bug006-design-after/` 与 `bug006-software-after/`。
- **UI-SCROLL-001（[规范](../UI/文档/UI-CR049-滚动条按需显示.md)，v1／CR-049）**：本次变更只作用于 `.pane-handle` 的 `outline`，**没有受影响滚动区域**——未新增／修改任何 `overflow`、`scrollbar-width`、`scrollbar-color` 或滚动容器，不改变正文宽度、不重绘编辑区、不丢失草稿／光标／选区。故本次不产生新的滚动显隐场景，保留 v1 行为；§7.2.1 义务清单中登记为「不适用（附依据）」，回归由现行滚动条验证覆盖，未提供本次动态逐帧显隐证据。
- 权限／安全：无权限模型变化；不读取凭证或个人数据；不新增日志。
- 兼容性：Chromium / WebView2 与 headless Chrome 的 `:focus-visible` 行为一致；不依赖特定系统强调色。真实 Tauri WebView2 未验证（见 §7）。

## 5. 实现步骤与并行边界

1. 只读定位 → 改前设计／软件取证（`scripts/verify-bug006.mjs --phase=before`）——已完成。
2. **设计先行**：更新 `docs/UI/workbench-v4/pane-resize.css`（`UI-BUG006-v1`），运行设计侧 `--phase=after`（11/11 通过），登记版本／hash／场景覆盖与总览入口。
3. 写需求、Story、本 LLD、UI 设计文档（不动正式源码）。
4. **软件实现**：仅修改 `src/components/pane-resize.css`，追加上述规则与注释。
5. 验证：软件侧 `--phase=after` 四状态取证；`npx tsc --noEmit`／`npm run build`；最终 diff 审查；成对设计／软件证据核对。
6. 更新 REPORT、导航、汇总、Story 状态；不提交／不推送／不发布。
- 并行边界：单文件单写者；不与其它代理共享写入目标；工作区中其它未提交改动保持原样。

## 6. §7.2.1 工作包义务清单（稳定编号）

| 编号 | 义务 | 源与版本 | 实现／验证 |
| --- | --- | --- | --- |
| OB-BUG006-01 | AC-BUG006-01 四状态命中区外无蓝色轮廓 | BUG-006 §4 | `src/components/pane-resize.css`；`verify-bug006.mjs` 像素断言 |
| OB-BUG006-02 | AC-BUG006-02 键盘焦点仍可辨、全局 `:focus-visible` 不删 | BUG-006 §4、CR-068 | 不删全局规则；验证 grip 为 `rgb(43,108,246)` |
| OB-BUG006-03 | AC-BUG006-03 拖动手势／选中抑制／限幅／清理回归 | BUG-006 §4、CR-045 §1.8 | 不改 TSX；验证 `pane-dragging` 激活 |
| OB-BUG006-04 | AC-BUG006-04 全实例／主题／宽度档一致 | BUG-006 §4、UI-CR100-v1 | 共享 CSS class 一次修复覆盖全部；不逐页改 |
| OB-BUG006-05 | AC-BUG006-05 设计／软件成对证据、无未解决偏离 | BUG-006 §4、§6.3.1 | 两侧 4 状态 PNG＋JSON；差异结论见 REPORT |
| OB-BUG006-06 | AC-BUG006-06 真实 WebView2／用户目视验收 | BUG-006 §4 | **未执行，保持待验收** |
| OB-BUG006-07 | UI-SCROLL-001 适用性与登记 | [UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)、[CR-049](../PRD/CR-049-滚动条仅在滚动时显示.md) | 见本文件 §4：本次无受影响滚动区域，保留 v1，不静默豁免 |
| OB-BUG006-08 | 设计先行、版本／hash／覆盖／总览登记 | AGENTS §6.3.1、§6.3.2 | UI-BUG006-v1；索引新增条目；唯一入口不变 |
| OB-BUG006-09 | 不包含项：业务行为、其它 Feature、发布 | BUG-006 §5 | diff 审查确认 |
| OB-BUG006-10 | DB 结论 | AGENTS §6.3 | 不适用（仅 CSS 轮廓），无须空白 DB 文档 |

## 7. 验证、交付与回退

- 验证命令与结果：[REPORT-BUG006](../Test/REPORT-BUG006-拖动侧栏分隔条蓝色框修复验证.md)（设计／软件 before-after、`tsc`／`build`、成对像素证据、未验证项）。
- 回退：删除 `src/components/pane-resize.css` 中新增的两行规则即可恢复改前行为；设计侧同理删除 `docs/UI/workbench-v4/pane-resize.css` 的对应行；无数据迁移、无配置变化、无需停机。
- 交付边界：仅代码与文档工作区改动；未提交、未推送、未发布、未替换便携版 exe。

## 8. 未决项、假设与风险

1. 用户截图色值 `#4170F0` 与本仓 `--primary #2b6cf6` 不一致，假设来自 WebView2／系统强调色或截图色彩转换；判据不依赖色值，风险低，真实环境待用户复核。
2. 真实 Tauri WebView2 下的 `:focus-visible` 启发式与系统强调色未验证；headless Chrome 已复现并验证修复。
3. 模型不能目视判读必需视觉：按 §7.2.1 保持 AC-BUG006-06 阻塞并交用户验收，不以像素断言／DOM 检查冒充目视验收。
4. 设计稿资源 `pane-resize.js` 未改（原型 `pointerdown` 不显式 `focus()`，设计侧本来无框）；软件保留 `focus()` 以支持拖动后键盘微调，二者视觉一致。

## 9. 变更记录

| 日期 | 原因 | 影响 |
| --- | --- | --- |
| 2026-11-26 | 用户反馈偶发蓝色框并授权正式编码 | 新增方案、义务清单与修复；先设计后软件 |
