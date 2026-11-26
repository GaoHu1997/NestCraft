# STORY-116：拖动侧栏分隔条不再出现蓝色焦点框

- 类型：缺陷（共享可调栏 UI 视觉偏离）
- 所属 Feature：[FEAT-001 工作台框架与可操作评审](../Feature/FEAT-001-工作台框架与可操作评审.md)（唯一父项；CR-045 全栏可调共享机制）
- 所属 PRD：[BUG-006](../../PRD/BUG-006-拖动侧栏分隔条偶发出现蓝色焦点框.md)（AC 唯一事实来源）
- 来源与确认依据：用户 2026-11-26 附图反馈「偶发移动侧栏出现这个蓝色框，需要修复」。
- 负责人／优先级／状态：主代理／P1（视觉伪影、影响全部可调栏）／**待验收**（技术验证通过，用户目视与真实 WebView2 未验）
- 依赖：UI-CR045-v1.1 SC-045-08（现行把手基准）、UI-CR100-v1（侧栏窄容器）、唯一原型入口 `docs/UI/仿真原型UI.html`
- 目标：作为使用软件的人，我希望拖动侧栏宽度时不出现贯穿全高的蓝色框，以便分隔条只保留既定的细线反馈、不干扰侧栏内容。
- 本次包含：`.pane-handle` 在静止／键盘聚焦／拖动中／拖动结束四状态下不画外描边；键盘焦点仍可辨；设计稿版本与覆盖登记；软件按稿修正；成对视觉证据。
- 不包含：分隔条尺寸／配色／宽度偏好／键盘步长业务调整；全局 `:focus-visible` 删除；其它 Feature 组件；提交／推送／发布／替换便携版 exe。

## 确认与授权

| 项 | 内容 |
| --- | --- |
| 用户原话 | 「偶发移动侧栏出现这个蓝色框，需要修复」；随后「继续」 |
| 澄清（2026-11-26，用户明确选择） | 出现位置＝**正式软件**；操作＝**拖动分隔条改宽度**；工作层级＝**授权正式编码** |
| 编码授权原话 | 「授权正式编码」（选项文字，由用户在澄清问题中明确选择），范围限本缺陷 |
| 执行身份 | `projectId=AI_Delelovelop`、`featureId=FEAT-001`；本会话只含本 Feature 内的本 Story，不扩到其它 Feature |
| 允许修改文件 | `docs/PRD/BUG-006*`、`docs/Plan/Story/STORY-116*`、`docs/LLD/LLD-BUG006*`、`docs/UI/文档/UI-BUG006*`、`docs/UI/文档/设计资源索引.html`、`docs/UI/workbench-v4/pane-resize.css`、`docs/Test/REPORT-BUG006*`、`docs/Test/bug006-*.json`、`docs/Test/screenshots/bug006-*/`、`scripts/verify-bug006.mjs`、`docs/README.md`、`docs/需求汇总.md`、`docs/Plan/Feature/FEAT-001*`、`docs/UI/文档/UI-CR045*`、`src/components/pane-resize.css` |
| 保护的既有改动 | 工作区内其它代理的未提交改动一律不覆盖（尤其 `src/**`、`src-tauri/**` 中非本次目标文件） |

## 验收标准

- AC-BUG006-01～06 见 [BUG-006 §4](../../PRD/BUG-006-拖动侧栏分隔条偶发出现蓝色焦点框.md#4-验收标准ac事实来源)，不在此重复维护。
- 逐项结果见 [REPORT-BUG006](../../Test/REPORT-BUG006-拖动侧栏分隔条蓝色框修复验证.md)。

## 方案与设计

- [LLD-BUG006](../../LLD/LLD-BUG006-拖动侧栏分隔条蓝色框修复.md)：根因、选定方案、义务清单、验证与回退。
- 数据库：不适用（仅前端 CSS 轮廓，无持久化变更）。
- 现行 UI 基准：[UI-BUG006-v1](../../UI/文档/UI-BUG006-拖动侧栏分隔条无蓝色焦点框.md)；继承 [UI-CR045-v1.1](../../UI/文档/UI-CR045-文档工作区与可调栏.md) SC-045-08、[UI-CR100-v1](../../UI/文档/UI-CR100-AI侧栏窄容器适配.md)。

### UI 准入（§6.3.1）

| 项 | 登记 |
| --- | --- |
| 受影响场景／状态 | 所有 `.pane-handle` 实例；静止／hover／键盘聚焦／拖动中／拖动结束／焦点残留；浅／深主题；AI 侧栏 320-620、管理导航 176-320；≤600px 隐藏态 |
| 可视设计资源与版本 | [UI-BUG006-v1](../../UI/文档/UI-BUG006-拖动侧栏分隔条无蓝色焦点框.md)，唯一入口 [仿真原型UI.html](../../UI/仿真原型UI.html)，资源 `workbench-v4/pane-resize.css` SHA256 `5c9f538006965f4d6758b7b6ed8aa238f10fe57d9fb00235ff1b0adb0b01131a` |
| 覆盖核对 | 设计侧改前 11/11、改后 11/11 通过；四状态成对截图与像素断言见 `docs/Test/screenshots/bug006-design-before|after/`；不适用项：无新增页面／弹窗／菜单／权限态／空数据态，本缺陷只改把手轮廓；无滚动区域新增 |
| 确认／执行授权 | 用户 2026-11-26「需要修复」＋澄清「授权正式编码」；设计稿先更新（`UI-BUG006-v1`）并验证通过后，才修改 `src/components/pane-resize.css` |
| 先设计后软件记录 | 设计 CSS 更新 → 设计侧 `--phase=after` 11/11 → 软件 CSS 修改 → 软件侧 `--phase=after` 取证（时间顺序见 REPORT-BUG006） |
| 对照验证计划 | 同 1680×1000、100% 缩放、浅色主题、同一四状态、同一裁剪几何；设计／软件各出 4 张 PNG＋JSON 像素断言；差异先编号再处理 |
| 偏离处理 | 改前软件偏离有效设计（蓝色框），按 §6.3.1 修软件去符合设计；未把软件现状回填成新设计 |

## 实现位置

- 设计资源：`docs/UI/workbench-v4/pane-resize.css`（新增 `.pane-handle:focus, .pane-handle:focus-visible { outline: none; }` 与注释）
- 正式软件：`src/components/pane-resize.css`（同规则，特异度 (0,2,0) 压过全局 `:focus-visible` (0,1,0)）
- 未改：`src/components/pane-resize.tsx`（保留 `focus()` 与键盘调宽）、`src/theme/base.css`（保留全局键盘焦点环）、任何 TSX／Rust 文件。

## 验证结果

| AC | 方式 | 结论 | 证据 |
| --- | --- | --- | --- |
| AC-BUG006-01 | `verify-bug006.mjs` 软件浅／深四状态 | **通过**：改前 S1 `outline=solid 2px rgb(43,108,246)` ＋ 3 条贯穿 887px 的蓝线；改后 `outline-style=none`、`frameLines=[]`、`wideRows=0` | `bug006-software-before.json`、`bug006-software-after.json`、`bug006-software-dark-after.json` |
| AC-BUG006-02 | 键盘聚焦 grip 计算值＋diff 审查 | **通过**：grip 浅 `rgb(43,108,246)`／深 `rgb(91,141,255)`；全局 `:focus-visible` 未删 | 同上 JSON |
| AC-BUG006-03 | 拖动态断言 | **部分通过**：`pane-dragging`／`is-resizing`、宽度变化、0 JS 异常、无文本选中蓝块；双击／方向键／pointercancel 清理未专项回归（RISK-BUG006-03） | `bug006-software-after.json` |
| AC-BUG006-04 | 浅／深成对取证＋共享 class 代码事实 | **部分通过**：浅／深各 11/11；各宽度档与其余复用页面、≤600px 未逐页截图（RISK-BUG006-02） | `bug006-*-dark-after.json`、REPORT §4 |
| AC-BUG006-05 | 设计／软件成对 PNG＋JSON | **部分通过**：机读成对证据齐备、改前偏离已编号并修复；人工目视对照未执行（并入 AC-06） | `screenshots/bug006-design-after/`、`screenshots/bug006-software-after/` |
| AC-BUG006-06 | 真实 Tauri WebView2＋用户目视验收 | **未执行，待用户验收** | — |
| 构建 | `npm run build`（含 `tsc --noEmit`） | **通过**：exit 0，仅既存 chunk 体积／动态导入警告 | [REPORT-BUG006](../../Test/REPORT-BUG006-拖动侧栏分隔条蓝色框修复验证.md) §2 |

## 验收结论及依据

- 技术验证通过、待用户验收；未标记「已完成」。依据：用户未验收，且当前模型不能判读必需视觉（§7.2.1：保持该项阻塞并交合格验证者，不以 DOM／几何代验）。

## 阻塞、遗留事项和下一步

1. **RISK-BUG006-01**：真实 Tauri WebView2／系统强调色下的焦点环表现未验证（影响 AC-06）；归属用户验收；下一步＝在正式软件中拖动侧栏复看并给出验收结论。
2. **RISK-BUG006-02**：各宽度档、其余复用页面与 ≤600px 隐藏态未逐页截图（影响 AC-04）；归属主代理；下一步＝如需全量覆盖，扩展脚本按页面／宽度档枚举。
3. **RISK-BUG006-03**：双击／方向键／pointercancel／卸载清理未专项回归（影响 AC-03）；归属主代理；下一步＝沿用 CR-045 既有验证或补专项脚本，本次未改 TSX。
4. **RISK-BUG006-04**：截图色值 `#4170F0` 与 `--primary #2b6cf6` 差异来源未证实，且人工目视视觉对照未做（影响 AC-05/06）；归属用户验收；差异不进入修复判据。
5. **RISK-BUG006-05**：设计侧 `file://` 下 CDP 合成指针未触发拖动，改用等价 `PointerEvent`（脚本已登记 fallback）；归属主代理；下一步＝如需真实指针路径，改用本地 HTTP 提供原型后重跑。

以上逐项详见 [REPORT-BUG006 §6](../../Test/REPORT-BUG006-拖动侧栏分隔条蓝色框修复验证.md)。用户目视对照通过后，由用户或指定验收者给出结论，再更新状态。
