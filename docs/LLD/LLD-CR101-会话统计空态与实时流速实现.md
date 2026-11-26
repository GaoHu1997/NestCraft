# LLD-CR101：会话统计空态显隐与生成中实时流速实现方案

- 关联需求：[CR-101](../PRD/CR-101-会话统计空态显隐与生成中实时流速.md)（R-CR101-1～14）／AC 单源 [STORY-022 CR-101 增量](../Plan/Story/STORY-022-按需子智能体与用量统计.md#cr-101增量统计空态与生成中实时流速)。
- 唯一 Feature 身份：`projectId=AI_Delelovelop / featureId=FEAT-012`。
- 工作层级：需求、设计与**正式实现均已完成**（2026-11-26 用户明确「授权修改代码」）。已落地 `StatsBar.tsx`／`stats-bar.css`／`sessionRuntime.ts`／`ChatPanel.tsx`，验证见 [实现与验证](../Test/REPORT-CR101-实现与验证.md)；真实流式节奏与真实桌面端仍未验证。
- 现行源：[UI-CR101-v1](../UI/文档/UI-CR101-会话统计空态与实时流速.md)、[UI-CR074-v1](../UI/文档/UI-CR074-AI会话双布局统一.md)、[UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)、[CR-074](CR-074-AI会话双布局统一与交互校正.md)。

## 1. 当前实现与受影响模块

| 模块 | 现状职责 | 本 CR 要动的位置 |
| --- | --- | --- |
| `src/modules/chat/StatsBar.tsx` | 归一化字段、三组渲染、详情浮层 | `statsPresentation` 的判空与分组；渲染改为「组级可见 + 字段级省略」 |
| `src/modules/chat/stats-bar.css` | 统计条布局与详情正文滚动 | 空态不再依赖占位；不新增滚动容器 |
| `src/modules/chat/chat.css:319` | `.chat-stats.is-empty { visibility:hidden }` | 由「不可见占位」改为「不渲染」，该规则随之失效（保留不删） |
| `src/modules/chat/ChatPanel.tsx:1332-1350` | `statsData` 投影轮／步／TPS／Token／上下文 | 追加运行期实时流速字段投影；不改消息、附件、队列业务 |
| `src/modules/chat/sessionRuntime.ts` | 运行期计时与 token 累计（`timingKnown`、`lastOutTokens`、`lastGenMs`） | 追加实时流速派生字段，不改变既有字段语义 |
| 流式接收处（`ChatPanel` 的 delta 处理路径） | 追加增量到 assembled 正文 | 只统计输出增量与解码计时，不改正文写入 |
| `docs/UI/workbench-v4/cr074.js`、`cr074.css` | 设计侧统计条 | **本轮已改**：组级判空与字段级省略、实时值演示 |

明确不改：模型／供应商、上下文策略、工具权限、消息呈现、历史、子智能体详情、审批与队列、后端统计口径（`chat_stats.rs` 不动）。

## 2. 选定方案

### 2.1 判空与分组：一个纯函数，两处复用

把展示规则收敛为无副作用的纯函数，输出「可见组 + 组内片段」，软件与设计稿同构：

```ts
type StatFragment = { key: string; text: string };          // 已含单位，绝不含 "—"
type StatGroup = { id: "session" | "tokens" | "context"; label: string; fragments: StatFragment[] };
type StatsView = { groups: StatGroup[] };                    // groups 为空 ⇒ 整条不渲染

function statsView(data: StatsData): StatsView
```

规则映射：

| 规则 | 实现约束 |
| --- | --- |
| R-CR101-1 | `groups.length === 0` 时组件返回 `null`（不输出容器），不留 padding／min-height |
| R-CR101-2 | 每组独立判定：该组至少一个片段有可信值才进入 `groups` |
| R-CR101-3 | 未知字段不生成片段，分隔符由「已有片段的连接」决定，不预置空位 |
| R-CR101-4 | 可信 `0` 生成片段（`0 轮`、`0 tok`、`0%`），与 `null` 严格区分 |
| R-CR101-5 | 判空不使用 `msgs`；`msgs` 仅进入会话详情头部 |
| R-CR101-6 | 详情入口由 `groups` 驱动：某组不在 `groups` 中则无入口，且不可用键盘或程序化方式打开其浮层 |

各组片段顺序（沿用 CR-074）：会话＝`轮`→`步`→`tok/s`；Token＝`总量 tok`→`缓存 %`；上下文＝`圆环＋百分比`。

**文案（R-CR101-14，2026-11-26 追加）**：统计条 Token 组缓存项写两字「缓存」（`6.1M tok · 缓存 95%`），详情浮层仍写完整「缓存命中」。软件侧涉及两处，须与实现同批修改：[StatsBar.tsx:148](../../src/modules/chat/StatsBar.tsx#L148) 改「缓存」，[StatsBar.tsx:158](../../src/modules/chat/StatsBar.tsx#L158) 保留「缓存命中」。同时 [cr074-feat012-stats-format.mjs](../../scripts/cr074-feat012-stats-format.mjs) 中 `缓存命中 93%`／`缓存命中 0%` 的统计条断言会随之失效，必须同步更新而不是删除断言；`src/smoke/ui-suite.ts:609` 断言的「缓存命中」位于详情浮层，详情保留该词，故不受影响。

### 2.2 实时流速采集与消费（有界滑动窗口估算）

算法对齐本机 DSH 运行环境中已启用的统计行插件（`dsh-token-total` 的 `StreamingRateSampler`）；调研结论与本机版本见 [实现与验证 §7](../Test/REPORT-CR101-实现与验证.md#7-实时流速算法重写2026-11-26-追加用户按这个算法重写实时流速)。

```
delta/thinking/toolUse ──► liveEstimatedTokens += priorTokens(文本)
                                        │   （非 ASCII 0.6／ASCII 0.3 token/字；思考与工具参数都计入）
                                        ▼
        每 1000ms tick ──► sampler.observe(liveEstimatedTokens × liveTokenScale, now)
                                        │
                              ┌─────────┴──────────┐
                    窗口 200–2000ms          积压检测 / 下降重锚
                    · 分子只取窗口内增长        · 增长 > max(跨度,50ms)×1.5 tok/ms → 重锚不发
                    · 重复帧不推进窗口          · 估算值下降 → 重锚
                              └─────────┬──────────┘
                       一阶低通：weight = min(1, 距上次发布/1000)
                                        ▼
              sampler.ratePerSecond() ──► ChatPanel.statsData.liveTps ──► statsView 会话组片段
                                        │
本轮闭合 ──► 先用 provider outputTokens 校准 liveTokenScale（钳 0.5～2）
          ──► 清空 sampler 与估算；权威 tps 可用 → 显示权威；不可用 → 片段省略
```

强约束：

1. 分子**只取窗口内观察到的增长**，绝不用累计值；窗口开启前产生的文本不得计入。
2. 分母为窗口跨度，受 **≥200ms** 与 **≤2000ms** 双边界约束；短于下限不发布，超过上限丢弃旧样本。
3. 估算值不变的帧**不推进窗口**，否则读数会无端向整段平均下沉。
4. 增长斜率超过 `max(跨度, 50ms) × 1.5 tok/ms`（1500 tok/s）判为 UI 积压帧（切标签页、主线程卡顿批量推帧），重锚而不发布；该检查必须在窗口下限之前执行。
5. 估算值下降（重试、块被整体替换）重锚；校准尺度变化只清窗口、保留已发布值。
6. 从未测得读数时返回 `null`，展示层回落到权威值，**绝不填 0**。
7. 终态先校准、再清空 `liveEstimatedTokens`／`liveSampler`／`liveStart`，禁止冻结过期值。
8. 实时值只在当前会话当前步骤有效，不跨会话、不写库、不参与去重统计。

### 2.3 与权威 TPS 的关系

| 时机 | 会话组 `tok/s` 片段 |
| --- | --- |
| 生成中，实时值可用 | 实时值（详情标注「生成中实时」） |
| 生成中，实时值不可用（尚未首 delta 或分母非法） | 省略该片段 |
| 闭合后，权威 TPS 可用 | 权威值（详情标注「本轮闭合测量」） |
| 闭合后，权威 TPS 不可用 | 省略该片段（不回落到实时值） |
| 历史重开 | 只用权威值（实时值不持久化，Q-CR101-01） |

### 2.4 稳定窗口（RISK-CR101-02）

统计条一旦显示，若随后短暂变为「无可信数据」，需保留最后一次已显示状态直到该会话切换或本轮结束，避免生成/刷新期间闪烁。实现为组件内一个 `lastNonEmptyView` 记忆位，不写入全局状态、不影响判空函数纯度。

## 3. 接口与数据

- **无新增 IPC 命令**：轮／步继续走既有 `chat_session_stats`；实时流速完全在前端运行期派生。
- **无新增持久字段**：不写 `metaJson`、不改表结构、无迁移。Q-CR101-01 若将来要求回显，另行登记 DB 设计。
- **权限**：不新增权限点；实时值只读当前会话内存态。
- **兼容**：`StatsData` 现有字段全部保留，`steps?`、`statsSource`、`timingSource` 语义不变；仅新增可选 `liveTps?: number | null`、`liveActive?: boolean`。

## 4. 允许改动文件（后续执行包，本包未动）

```text
src/modules/chat/StatsBar.tsx          # 判空、分组、渲染
src/modules/chat/stats-bar.css         # 空态与片段间距；不得新增滚动容器
src/modules/chat/ChatPanel.tsx         # 仅 statsData 与流式增量计数
src/modules/chat/sessionRuntime.ts     # 仅实时流速派生字段
scripts/cr101-stats-view.mjs           # 纯函数与 SSR 定向回归
docs/Test/REPORT-CR101-*.md            # 验证记录
```

不改：`chat_stats.rs` 及任何后端口径、`MessageList`、`chat.css` 共享分段、模型与历史模块、其他 Feature 文件。

## 5. 验证与回退

| 项 | 方式 |
| --- | --- |
| 判空与字段省略 | 纯函数表驱动用例：全空／单组有值／组内部分有值／可信零／零分母／非法值 |
| 整条不渲染 | SSR 断言：全空时容器节点数为 0，且无 `padding`／`min-height` 残留；无入口、无法打开浮层 |
| 实时流速 | 合成流式序列（含首 delta 前、分母 0、输出 0、终态清除）断言不出现 `NaN`／`Infinity`／冻结值 |
| 权威替换 | 闭合后权威可用／不可用两条路径 |
| 视觉 | 浅／深、1440×900、390×844、侧栏 320／372／480 成对对照；实时刷新需连续帧证据 |
| 滚动 | UI-SCROLL-001 动态序列：初始隐藏 → 滚动显示 → 停止 700ms 隐藏；空态不新增 `overflow:hidden` |
| 回退 | 纯前端展示层，回退为删除新增片段生成逻辑并恢复原三组渲染；无数据迁移、无不可逆操作 |

## 6. 未决项与风险

- **Q-CR101-02 节流频率与精度**：采用可逆默认值，实现阶段以真实流式节奏复核；调整须同步更新 UI-CR101-v1。
- **RISK-CR101-01 CLI 通道无闭合步骤**：启用本规则后该通道轮／步仍省略，这是数据缺口而非回归，需另建上游桥接工作包。
- **RISK-CR101-03 与 CR-074 历史证据**：CR-074 的 30 项格式脚本包含「缺步骤显示 `— 步`」与「全破折号占位」断言，本 CR 会使其预期失效；实现时须同步更新该脚本，不能靠改测试绕过验收。
- **RISK-CR101-04 实时值误导**：实时值在低输出阶段可能剧烈波动；详情必须标注口径，统计条不做视觉夸张。

## 7. 变更记录

| 日期 | 原因 | 影响 |
| --- | --- | --- |
| 2026-11-26 | CR-101 需求建立 | 新增本方案、允许改动清单与 13 条规则映射；未改任何源码 |
| 2026-11-26 | R-CR101-14 文案收敛（用户要求「缓存命中换成缓存」） | Token 组统计条改两字「缓存」、详情保留「缓存命中」；补充软件侧两处改动位置与既有格式断言同步项；未改任何源码 |
