# LLD-CR078：概览页日程与用量实现

- 状态：**v8 待验收（仅限本轮已核查场景）**（2026-11-25）；用户明确「授权，设计+软件一起做」。2026-11-24 无编码授权 / 设计未实现为初版历史，不是当前边界。
- 关联：[CR-078](../PRD/CR-078-概览页日程与用量.md) / [STORY-097](../Plan/Story/STORY-097-概览页日程与用量.md)（唯一父项 FEAT-001）/ [UI-CR078-v8](../UI/文档/UI-CR078-概览页日程与用量.md) / [DB-CR078](../DB/DB-CR078-日程表与用量聚合.md)。

## 0. v8 实现与验证约束（AC-23～27）

以下为本轮现行增量，后文 v1～v7 的更名、数据域、天气、box-shadow 与历史断言按版本追溯；未被替代的事件 / 待办、用量规则继续适用。

1. **先设计后软件**：lead 维护可操作 `cr078.js` / `cr078.css` 及 UI-CR078-v8 覆盖、版本 / SHA-256 与总览，先实际查看并登记准入，再改 `src/modules/overview/OverviewHome.tsx` / `overview.css`。设计验证、软件验证、同条件视觉对照分别留证，不以原型自身通过推定正式软件通过。cr078-docs 仅维护约定六份文档；算法 / 后端 / UI 资源及测试归 lead，不擅自重构其他模块。
2. **日期头**：移除前端 WeatherBar 展示，右侧首节点从 `.date-header` 开始；左侧宽 96px、头部固定 222px、宜 / 忌竖排两列；`grid-template-rows: minmax(0, 1fr)` 约束行高、竖排文本 `align-self: stretch` 固定列宽并 `overflow: hidden`，超长时折成多列而不撑高，完整文本保存在 `title`，右侧大号日数 / 农历月日 / 干支生肖；保留日期、值日、节日、调休与下方日程 / 待办区域。数据来源为当前选中日期的既有计算，参考图数值不硬编码。不删除后端天气、配置或 `weather.last`，不新增联网与定位权限。
3. **事件不删减**：仅移除右侧「+新增」创建按钮；保留标题新建、日期格 `+`、右侧事件列表、行编辑 / 删除、`+N` 选日查看全部、跨天事件与待办页签。编辑继续回填原值并以 `form.id` 调用 `schedule_event_save` upsert，不新增重复事件；待办 Enter / 失焦保存、Esc 取消、空值保护沿用。§3.1 的详情列表内滚继续适用。
4. **描边叠层**：选中格中性背景不变；使用绝对定位、内嵌四边、`z-index:3; pointer-events:none` 的 `selected::after`，事件条带 `z-index:1`，替代 §8 的 inset box-shadow 方案。验证有条带时四边完整、条带 click / Enter 编辑不被遮挡，浅 / 深与窄屏均须视觉判读；只检查声明或元素坐标不能证明视觉一致。
5. **算法复用**：`LUNAR_INFO` 1900–2100；节气按 Meeus 低阶太阳黄经、北京时间中午取日、年度 Map 缓存；年柱以立春分界、月柱按节令 / 五虎遁、日柱 `(jd + 50) mod 60`；宜忌仅近似，`WORK_OFF` 仅 2025–2027。本轮不更换算法；须重跑 15 项算法断言和 2025–2027 全部 72 节气，不沿用旧报告的通过结论。
6. **DB 决策**：复用 [DB-CR078 §2～4.5](../DB/DB-CR078-日程表与用量聚合.md) 的日程 / 待办表、按 id 更新及用量聚合契约。本轮只改展示 / 创建入口 / 描边，**无需新增或变更表、列、索引、迁移、后端命令**；不执行历史 §迁移回退中的删表动作。DB 文档初版「设计未实现」不代表本轮重建数据库。真实 SQLite / 迁移未测事实仍登记，不以夹具代替持久化证据。
7. **用量回归**：固定 28 周 `HEAT_DAYS` 与周期筛选独立；CSS 模型堆叠柱 / SVG 命中率折线、模型显示名称合并与排行同色继续适用，不改存储语义或聚合范围。Q-078-01 失败指标、Q-078-02 子用量完整性等既有边界继续保留。

### 0.1 UI-SCROLL-001 义务与责任

- 必读源：[CR-049](../PRD/CR-049-滚动条仅在滚动时显示.md)、[UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)；复用 `src/components/scrollbar.ts` 与 `src/theme/base.css`，不新增全局 Hook / 配置 / 插件 / 替代滚动引擎。
- 适用区域：详情正文及事件 / 待办列表、新建 / 编辑动态弹窗、窄屏长页、用量排行与实际溢出编辑区；无溢出时用内容量确认不适用。嵌套 / 动态容器单独登记。跨文档 / 跨域 iframe、原生系统控件不是本轮承诺范围，不据此豁免当前 DOM 容器。
- 默认 thumb / track / corner 透明且保留原生宽度；仅位置实际变化唤醒该容器，连续移动重置计时，停止 700ms 隐藏（代理可逆默认值，非用户指定）。hover / focus、无位移 wheel 不唤醒；静止祖先保持隐藏。浅 / 深沿用源色板；不通过 `display` / 宽度切换、禁滚或新增 overflow 实现，永久隐藏横条继续隐藏。
- lead 负责本轮动态实测与配对证据：初始 / 滚动 / 连续 / 停止、嵌套隔离、滚轮 / 触控 / 键盘 / 拖滑块、布局 / scroll position / 草稿 / 光标 / 选区 / 撤销 / 自动保存保持。不得使用 `--hide-scrollbars` 或测试隐藏 CSS；静态截图、class / 色值、TypeScript / build 通过不能代替。

### 0.2 验证映射与交接

| AC | UI / LLD / DB → 软件 | 必需证据与责任 |
| --- | --- | --- |
| 23 / 24 | UI-v8 日期头 / 切日 → 本节 2 / 5、DB 无变更 → OverviewHome / 既有 calendar | lead：日期 2026-11-24 及多日期联动、15 项 + 72 节气、内容与布局视觉对照 |
| 25 | UI-v8 两创建入口及列表 / 弹窗 → 本节 3 / 6、DB §4.5 → OverviewHome | lead：新建 / 编辑 / 删除 / +N / 待办回归、同 id 不重复；真实落库另记未验证 |
| 26 | UI-v8 选中格 → 本节 4、DB 不适用 → overview.css / OverviewHome | lead：浅 / 深、跨天条带、四边描边与点击编辑的配对截图及操作 |
| 27 / 15 / 16 | UI-CR049-v1 → §0.1、DB 不适用 → 共享滚动控制及受影响容器 | lead：1440×900 / 1280×720 / 390×844、短视口动态序列、嵌套 / 输入保持 |

有效资产 hash、执行时间、环境、逐项通过 / 失败 / 未执行 / 不适用及差异由 [REPORT-CR078](../Test/REPORT-CR078-概览页日程与用量设计验证.md) 登记。软件预览需与设计同主题 / 缩放 / 样例数据，选中日期 2026-11-24；v7 的 110/110、49/49 与旧截图只属历史。真实 Tauri、SQLite、完整原生输入、缺失状态等没有本轮证据时保持未验证。本链路是执行义务，不宣称引擎 / CI 已硬拦截或永久零遗漏。

### 0.3 本轮证据与运行配置说明

最终结果由 lead 执行，文档子任务直接核对 result.json 及四资产 SHA-256：设计 `2026-11-25T15:56:59Z` 108/108 / 31 图，软件 `2026-11-25T15:57:11Z` 55/55 / 21 图，均 0 异常；有效 hash、配对截图与未测范围单源见 [REPORT §0f](../Test/REPORT-CR078-概览页日程与用量设计验证.md#0f-v8-验证登记2026-11-25)。15 项算法样本在本轮设计脚本内通过，但 v7 全量算法一致性与全部 72 节气独立矩阵未重跑；原生触控 / 滑块拖动、真实 Tauri IPC / SQLite 未测。待验收仅限本轮已核查场景，不能宣称 Story 完成。

≤520px 标题新建按钮裁切曾发现，已在设计 / 软件侧同步将月历头部设为可换行、height auto / min-height 50，导航按钮 26px、标题 14px 并调整 margin；390 配对截图与双侧重跑已核查，不再列作未修限制。

另由 lead 修正 `vite.config.ts` 的 `server.watch.ignored`，增加 `**/docs/**`、`**/.tmp-*/**`，用于 Windows Vite 扫描 docs 导致预览卡死；lead 报告 CPU 累计 378s / 首页约 17s，重启后就绪 576ms。此项为预览运行配置修正，不是 UI 或 DB 变更、不修改构建产物；文档子任务未复测性能，也未修改此文件。当前版本 TypeScript / build 独立输出未在此子任务中复核，不沿用旧 exit 0。

## 1. 本次要解决的问题

主菜单「工作台」首页当前是需求 / 运行看板（`src/modules/WorkbenchHome.tsx`），用户要求更名「概览」并把内容重建为「日程」与「用量」两个 Tab。涉及：导航文案与图标、页面重建、两个新数据域（日程 / 待办、用量聚合）。

## 2. 当前实现与受影响模块

| 模块 | 现状 | 本次动作 |
| --- | --- | --- |
| `src/App.tsx:25-30` `NAV_ITEMS` | `{page:"workbench", label:"工作台", icon:"grid"}` | label → `概览`，icon → `layout`（已在 `ICON_NAMES`） |
| `src/App.tsx:137,154` 面包屑 / 窗口标题回退 | 回退文案「工作台」 | → 「概览」 |
| `src/App.tsx:239-246` `HomeWindow` | `<WorkbenchHome />` | → `<OverviewHome />` |
| `src/modules/WorkbenchHome.tsx` | 四统计 + 四卡 | **删除**（文件移除；无其他引用） |
| `src/components/icons.tsx` | `calendar` / `tokenUsage` / `layout` 均已注册 | 无需改 |
| `src-tauri/src/db.rs` | — | 新增 `migrate_cr078` |
| `src-tauri/src/commands/mod.rs` | — | 注册 `schedule` / `usage_stats` 模块 |
| `src/api/index.ts` | — | 新增类型与 invoke 封装 |

不改：`Route` 类型与 `page: "workbench"` 路由键；项目窗口内「工作台」页签（CR-054 会话中心，另一概念）；`src/smoke/*` 既有套件。

## 3. 选定方案

### 3.1 前端结构

```
src/modules/overview/
  OverviewHome.tsx        // 页壳：标题 + 两 Tab（本地 state，默认 schedule）
  ScheduleTab.tsx         // 月历 + 详情栏两栏
  calendar/
    lunar.ts              // 农历信息表 + toLunar（照搬原型算法，TS 化）
    terms.ts              // 太阳黄经 + termDatesOfYear（按年缓存）
    almanac.ts            // 干支 / 值日 / 宜忌 / 节日 / 调休表
  UsageTab.tsx            // 六卡 + 热力图 + 趋势 + 排行
  overview.css            // 对应 cr078.css
```

- 月历：6 周 × 7 格；周行 = 周号 + 7 格，条带层绝对定位叠在底部（`left:36px; right:0; bottom:4px`），车道算法与原型 `layoutWeek` 一致。
- 详情栏（UI-CR078-v2）：两栏 `align-items: stretch`，右栏高度由月历卡决定；黄历块下方「日程 / 待办」两个页签（本地 state `dayTab`），面板区 `flex:1; min-height:0; overflow-y:auto`（仅日程条数超过月历高度时内滚），走共享滚动条。
- 热力图（v4 / v5）：`heatGrid(heatDays)` 输出 `{cells, cols}`——列数固定 28，末格对齐到本周周日、向左逐列回溯；**数据源是固定近 28 周窗口（`HEAT_DAYS`），不随周期筛选变化**（v4 只固定了列数，选「近 7 天」时 28 列里仅 2 列有色，v5 修正）。空位 `.is-blank` 白框带边线，有数据格五档色阶；月份标签与格子共用同一 `grid-template-columns`。
- 趋势图（v5）：纯 CSS 堆叠柱（`flex-direction: column-reverse`，DOM 顺序即自下而上、按该模型 token 降序）+ SVG `polyline`（`preserveAspectRatio="none"`、`vector-effect="non-scaling-stroke"`）；不引入图表库。堆叠维度是**模型显示名称**（`hours[i].models`），每段颜色取 `MODEL_COLORS[按模型排行名次]`，与排行条、图例同源。悬停浮层由 `mousemove` 命中 `.ov-bar` / `.c078-bar` 决定，`left` 百分比夹在 12%–88%、`top: 4px`，最多列 6 个模型 + 「其余 N 个模型」，高度恒定不越界。
- 热力图：完整矩阵 CSS grid，`grid-template-rows: repeat(7,14px)` + `grid-template-columns: repeat(cols,14px)`，每格显式定位（v2）。

### 3.2 后端

- `commands/schedule.rs`：`schedule_event_list / save / delete`、`schedule_todo_*`。校验：标题非空且 ≤80、`endDate >= startDate`、颜色白名单、日期格式 `YYYY-MM-DD`（正则 + 解析复核）。
- `commands/usage_stats.rs`：`usage_stats(range, from?, to?)`，SQL 聚合（见 DB-CR078 §4.3），返回 `totals / days[ ] / hours[24] / models[ ] / providers[ ] / asOf`。时间桶用 `localtime`。v5 契约补充：①`models[ ]` 与 `hours[i].models[ ]` 均以**模型显示名称**为 key（同名跨来源合并，`source = "mixed"`，并回填首个非空 `cliId` / `providerId`）；②`hours[i].models[ ]` 每项 `{name, inputTokens, outputTokens, cacheTokens, requests}`，按 `input+output` 降序；③`days[ ]` 语义改为**固定近 `HEAT_DAYS`（28×7）天**的日粒度，供热力图使用；查询窗口取「周期起点 / 热力图起点」较早者，周期外的行只进 `days`、不进 `totals` 与模型 / 小时 / 供应商聚合（循环内 `r.day < from_day` 直接 `continue`）。
- `commands/weather.rs`（**新增联网能力，PRD Q-078-03～05 已决策**）：`weather_current()` → 先读 `setting_default[weather.last]` 立即返回 `{cached:true}`，再后台 `locate()`（Tauri geolocation 插件 → 失败回退 IP 定位 `https://ipapi.co/json/` 或同类）→ `fetch` 天气（Open-Meteo 免密钥 `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto`）→ 反解城市（定位结果自带或 Open-Meteo 不提供则用 IP 定位的 city）→ 写缓存 → `emit("weather-updated")`。错误分类：`LocationDenied / LocationFailed / NetworkFailed / ParseFailed`，前端据此显示降级态。需在 `tauri.conf.json` 与 Capabilities 放行对应域名（Open-Meteo、IP 定位域名）；定位插件需在 Capability 声明 `geolocation:allow-getCurrentPosition`。
- 错误处理：日期解析失败返回 `Err("日期格式无效")`；范围 `to <= from` 返回 `Err("结束不能早于开始")`；用量查询失败不阻塞页面，前端显示「读取失败」+ 重试；天气任何失败都不阻塞日程页。

### 3.3 农历 / 节气 / 黄历的实现要点（照原型算法 TS 化）

- 农历：`LUNAR_INFO` 1900–2100，`lunarOf(date)` 逐日偏移；除夕 = 次日为另一农历年正月初一。
- 节气：`sunLongitude` Meeus 低阶近似，采样北京时间当日 12:00；`termDate(y, k)` 从 3/21 起按日搜索到次年 4/20；`termDatesOfYear(y)`：k=0..18 传 y，k=19..23 传 y−1，过滤 `getFullYear()===y`；按年 `Map` 缓存。
- 干支：年柱以立春为界；月支按节气序、五虎遁定干；日柱 `(jd + 50) mod 60`。
- 宜忌：`建除满平定执破危成收开闭` 口诀表；**界面文案不写「权威」**。
- 调休：`WORK_OFF` 内置 2025–2027。

设计稿已用 15 项算法断言 + 2025–2027 全部 72 个节气核对（[REPORT-CR078](../Test/REPORT-CR078-概览页日程与用量设计验证.md)），实现时**必须把同一组断言移植为 Rust / TS 单测**。

### 3.4 UI-SCROLL-001 义务清单

| 容器 | 实现文件 | 验证 |
| --- | --- | --- |
| 页面正文（矮视口日程页整体超高） | `OverviewHome.tsx` 页面容器 | 1100×520 三帧：静止隐藏 → 滚动显示 → 700ms 后隐藏；月历卡宽度前后一致 |
| 详情栏面板 `.ov-day-panel` | `OverviewHome.tsx` + `overview.css` | 仅日程条数超过月历高度时超高；用 ≥12 条夹具三帧 |
| 排行榜列表 | `UsageTab.tsx` | 同上（行数 ≥ 20 夹具） |
| 窄屏页面正文 | 页面容器 | 390 长页三帧 |

复用 `src/components/scrollbar.ts` + `src/theme/base.css`，不新增常显样式。

## 4. 实现步骤与并行边界

1. DB：`migrate_cr078` + 两表 + 索引（单测：幂等、CHECK 生效）。
2. 后端：`schedule.rs`（含日期校验单测）→ `usage_stats.rs`（含缺省规则单测：无 usage 不计、分母 0 → None）。
3. 前端算法：`lunar.ts / terms.ts / almanac.ts` + **移植原型 15 项断言为 vitest**。
4. 前端页面：`OverviewHome` → `ScheduleTab` → `UsageTab`；`App.tsx` 三处文案 + 图标；删除 `WorkbenchHome.tsx`。
5. 样式：按 `cr078.css` 迁移，类名前缀 `ov-`。
6. 验证：`npx tsc --noEmit`、`npm run build`、`cargo test --lib`、软件侧隔离预览断言（照 `docs/Test/cr078-design-check.mjs` 改写为软件版）、成对截图（1440 浅 / 深、1100 滚动三帧、390）。

单 Feature（FEAT-001）单 Story（STORY-097）；步骤 1–2 与 3 可并行，4 依赖 2、3。

## 5. 兼容性与回退

- 路由键不变，旧书签 / 跳转不受影响。
- 删除 `WorkbenchHome.tsx` 前确认无其他 import（当前仅 `App.tsx`）。
- DB 纯新增，回退 = 删表 / 删索引。
- 农历表覆盖 1900–2100；超出范围返回 `null`，界面显示公历不报错。

## 6. 未决项与假设

- **Q-078-03～05 已决策**（2026-11-25）：Open-Meteo 免密钥；系统定位优先 + IP 兜底；允许仅用于天气的联网，设置提供「关闭天气」开关。实现时：`tauri.conf.json` 放行 `api.open-meteo.com` 与 IP 定位域名；Capability 声明 `geolocation:allow-getCurrentPosition`；设置 → 通用新增「天气」开关（`setting_default[weather.enabled]`，默认开）。
- 假设：调休表随版本更新，不联网；用户接受 2025–2027 之外不显示调休。

- **Q-078-01**：用量「失败数」是否要真实统计（当前 `metaJson.error` 是否稳定写入未核实）→ 实现时核实，无法核实则只显示请求量不显示失败率。
- **Q-078-02**：子智能体用量是否已完整写入 `closedSteps[].usage`（CR-074 报告称「真实上游闭合来源尚未接入」）→ 若缺源，排行按缺省规则显示「未上报」，不编造。
- 假设：调休表随版本更新，不联网；用户接受 2025–2027 之外不显示调休。

## 7. 变更记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-24 | v1 设计稿与方案建立，未实现。 |
| 2026-11-25 | v6：选中日期态改「中性浅底 + 主色描边」、补日程编辑（详见 §8）。 |

## 9. v7 增量（2026-11-25 三次反馈：月/年切换按钮与年月快速选择）

- **表头结构**：`.ov-cal-h` 改 `position: relative`，左侧改 `.ov-cal-nav` 容纳 4 个 `.ov-nav-btn`（28×28、圆角 7px、描边 + 悬停）与可点击 `.ov-cal-title`。年 / 月步进改用单字符 `« ‹ › »`，不再用两个 chevron 图标拼「上一年 / 下一年」。
- **年月选择器**：`pickerOpen` / `pickerYear` 状态；点标题打开（同时把 `pickerYear` 重置为当前视图年）。面板 `.ov-picker` 绝对定位在表头下方（宽 236px），顶部 `‹ YYYY年 ›` 步进、下方 4 列 × 3 行 12 个月按钮；当前视图月 `.is-active`（主色实底白字）、今天所在月 `.is-current`（淡蓝底）。点月份 `setView` 跳转并关闭；点 `.ov-picker-mask` 或按 Esc 关闭（`useEffect` 挂 keydown）。
- **「今天」**：原「本月」文案改「今天」，回当前年 + 当前月并选中今天，同时关闭选择器。
- **后端**：无改动（纯前端视图状态与样式）。
- **验证**：设计稿 110/110、软件侧 49/49 断言通过；截图 `02b-year-month-picker`（设计）/ `02d-year-month-picker`（软件）。

## 8. v6 增量（2026-11-25 二次反馈）

- **选中态**：`.ov-cell.selected` 由 `background: var(--primary-soft)` 改为 `background: var(--surface-2); box-shadow: inset 0 0 0 2px var(--primary)`。原因：软件 `.ov-band.c-blue` 原用 `--primary-soft`，与选中格底色完全同值 → 选中格与蓝色条带糊在一起；改中性底色 + 主色描边后与五种条带色（`--primary-soft` / `--success-soft` / `--warning-soft` / `--violet-soft` / `--danger-soft`）均可区分。设计稿 `cr078.css` 同步。
- **日程编辑**：`OverviewHome.tsx` 的 `form` 状态扩展为可携带 `id` 与各字段；新增 `openNew` / `openEdit`；新建与编辑共用弹窗，编辑时回填原值并以 `form.id` 保存。后端 `schedule_event_save` 已按 id upsert（存在则 UPDATE），故无需改后端与接口。详情栏日程行新增 `.ov-ev-edit`（铅笔）入口，月历条带 `.ov-band` 亦可点击编辑（`role=button` + Enter 键）。
- **待办编辑**：待办行新增 `.ov-todo-edit-btn`（铅笔）→ 切换为 `.ov-todo-edit` 行内输入；Enter / 失焦保存、Esc 取消（`todoCancelRef` 防误存）、空值不覆盖；保存走既有 `schedule_todo_save`（同样按 id upsert）。勾选与新增不变。
- **历史验证归属 v7（非 v6 / v8 结果）**：设计稿 110/110、软件侧 49/49 断言通过（新增「选中底色≠蓝色条带」「编辑弹窗回填」「同 id 更新不新增条目」「待办行内编辑保存」「年月选择器」），0 运行时异常；`npx tsc --noEmit` / `npm run build` exit 0。
