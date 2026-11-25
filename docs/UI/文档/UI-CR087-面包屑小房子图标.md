# UI-CR087-v1：顶部面包屑第一段＝小房子图标

- 状态：**已实现到设计稿与正式软件**
- 日期／版本：2026-11-25，UI-CR087-v1
- 来源：[CR-087](../../PRD/CR-087-面包屑小房子图标.md)
- 可视入口：[唯一业务原型](../仿真原型UI.html) → 任意页面 → 顶栏面包屑最前

## 1. 采用值

| 项 | 值 |
| --- | --- |
| 图标符号 | `home`（既有符号，24×24、1.6px 描边） |
| 图标尺寸 | 14px（原型 `ico-14`；软件 `Icon size={14}`） |
| 第一段内容 | 仅图标，无文字 |
| 可读名称 | `role="img"` + `aria-label`／`title`＝「个人工作台」 |
| 颜色 | `--ink-2`（与页面名同级；分隔符与当前页仍按既有 `--muted`／`--ink-2` 口径） |
| 容器 | 原型保留 `chip-workspace` 胶囊（`--surface-3`、圆角、`padding 4px 8px`）；软件顶栏沿用无底色文本上下文 |

## 2. 受影响场景

| 场景 | 覆盖 | 证据 |
| --- | --- | --- |
| 首页面包屑（🏠 / 概览） | ✅ | `docs/Test/screenshots/cr087-design/02-home-context.png`、`cr087-software/02-home-context-1440.png` |
| 项目页面包屑（🏠 / 预约服务） | ✅ | `cr087-software/03-project-context-1440.png` |
| 完整顶栏观感 | ✅ | `cr087-design/01-home-topbar.png`、`cr087-software/04-project-topbar-1440.png` |
| 深色主题 | ✅ | `cr087-software/05-project-context-dark-1440.png` |
| 390 窄屏 | ✅ 沿用既有隐藏规则 | `cr087-software/06-narrow-390.png` |
| 滚动条 UI-SCROLL-001 | 不适用：本次未新增或变更任何滚动容器 | — |

## 3. 资源指纹（SHA-256 前 16 位）

| 资源 | 指纹 |
| --- | --- |
| `docs/UI/workbench-v4/core.js`（顶栏面包屑渲染） | `dce49e47476dc752` |
| `src/App.tsx`（`.nc-context` 第一段） | `5bece1b2337cc137` |
| `src/theme/workbench.css`（`.nc-context-home`） | `1d0ae600e39ad3f8` |

## 4. 设计与软件差异

| 项 | 设计稿 | 软件 | 结论 |
| --- | --- | --- | --- |
| 图标 | `#home` 14px | `data-icon="home"` 14px | 一致 |
| 文字 | 无 | 无 | 一致 |
| 可读名称 | 个人工作台 | 个人工作台 | 一致 |
| 底色 | 胶囊 `--surface-3` | 无底色 | **既有差异**：两侧各自沿用 CR-044 定型的容器样式，本次只替换第一段内容，未改动容器 |

## 5. 验证

- 设计稿：`node scripts/shot-cr087.mjs` → 探针 `iconUse=#home`、`iconW=14`、`chipText=""`、`chipLabel=个人工作台`、0 JS 异常。
- 软件：`node scripts/verify-cr087-software.mjs` → **9/9 通过、0 JS 异常**；`npm run build` exit 0。
- 说明：本机 vite dev server 出现依赖优化卡死（1420 IPv4 拒绝／IPv6 挂起），改用 `npm run build` 产物 + `scripts/cr087-serve-dist.mjs` 静态托管取证，页面与组件与开发态一致。

## 6. 未验证

- 真实 Tauri 窗口内截图（无可用应用调试端口）。
- 1120 与 720 两个断点的目视对照：规则未改，仅确认 390 行为不变。
