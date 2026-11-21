# LLD-CR056：AI 侧栏全面重构实现方案

- 关联需求：[CR-056](../PRD/CR-056-AI侧栏全面重构.md)；UI 基线：[UI-CR056-v1](../UI/文档/UI-CR056-AI侧栏全面重构.md)。
- 工作层级：正式软件实现，授权依据为用户明确要求“从需求/设计/编码统统给我调整一下”。
- 允许修改：`src/modules/chat/**`、`src/api/index.ts`、`src-tauri/src/models.rs`、`src-tauri/src/commands/chat.rs`、直接关联的测试/验证记录和 CR-056 文档；保留其它未提交改动。

## 1. 当前事实与根因

- 输入层已有 `Composer`、`@`/`/` 浮层，但候选缺少统一键盘控制、目标/任务只显示禁用行，光标替换规则和状态来源分散。
- `ModelPicker` 已有供应商/模型两栏，但权限只硬编码允许 `agent`，CLI 切换与非空会话确认分离，能力证据没有成为选择条件。
- `ChatPanel` 收到 `subagent` 事件后把 cli/model/duration/tokens 写成占位字符串，导致用户看到“未上报”而不是稳定身份和未知字段。
- `MessageList` 已区分 `我` 与 `AI`，但 AI 头部使用“模型未上报”，工具和子代理没有统一时间线身份。
- 后端 `chat.rs` 当前 Claude 固定 `acceptEdits`，Codex 只对 `agent` 注入 workspace-write，其他权限模式会被拒绝；本轮只开放后端能真实表达的模式，不用 UI 名称伪装能力。

## 2. 数据与状态

复用已有 Session、Message、Provider、Model、SDK 数据结构。前端新增运行时类型：

- `SessionGoal`: id/text/status/revision/history；只作用于会话。
- `SessionTask`: id/taskName/status/source/startedAt/endedAt/agentId；独立于项目 Task。
- `AgentRecord`: id/parentSessionId/taskName/cli/model/status/start/end/tokens/output/dedupeKey。
- `PermissionCapability`: id/cli/version/permissionId/enabled/reason/capabilityRevision/source。
- `ComposerCompletion`: trigger/query/items/highlightedIndex/anchor；只管理浮层交互。

暂不迁移数据库；目标/任务/运行时 Agent 先以内存 SessionRuntime 维护，消息事件仍通过现有 Channel 持久化。后端扩展字段采用 `serde(default)`，旧会话可读取。

## 3. 关键流程

### 3.1 输入

1. 输入事件读取光标前 token，判定 `@`、`/` 与查询。
2. 请求对应候选，按 query 做 AND 过滤，更新高亮索引。
3. Arrow/Enter/Escape 由候选控制器处理，compositionstart 到 compositionend 期间不发送。
4. 选择候选写入展示 token与结构化引用；发送前再次做 project/session/knowledge 权限复检。

### 3.2 配置

1. `sdkCliCandidates` 过滤 installed+enabled，并保留失效当前值。
2. `modelCandidates` 过滤 text=true、imageGen=false、有效供应商/端点；按 provider 分组。
3. `permissionCapabilities(cliId, version)` 生成菜单，前端只展示后端已声明可执行的模式。
4. 发送前 `chat.rs` 复检 CLI、模型、effort、permissionId、版本和能力 revision；失败保留草稿并返回可读原因。
5. 非空切 CLI 创建新 Session；运行、pending decision 或未结束子代理时所有执行配置锁定。

### 3.3 事件与消息

- `subagent` 事件按 id upsert；第一次事件创建 AgentRecord，后续只更新已知字段，不用占位字符串覆盖未知。
- 终结状态写入 `endedAt`；终结后忽略迟到 running 事件；结果按 `dedupeKey` 去重。
- 子智能体未上报 CLI 时继承本轮 `PendingSend.cliId`，行内 meta 显示“agent-id · CLI”，不再退化为未知。
- MessageList 根据 role/producer metadata 显示身份；AI 模型未知显示“模型信息未知”，同时保留 CLI/供应商字段。
- 工具调用/结果继续按 toolId 配对；步骤只从真实工具/Agent 事件构建。

### 3.4 运行态指示与思考计时

- 运行态指示器 `ThinkingIndicator` 用 canvas 呈现：取 logo 自身像素（alpha > 110）作为粒子集合，脱靶目标为绕中心旋转的粒子云；`scatterAt(u)` 控制 0.10/0.34/0.50/0.84 四个阶段的聚散，旋转 `2π × 1.25 × u^0.92`，周期 2800ms。
- 画布 CSS 尺寸 44px、内部 3× 缓冲（132px），保证打散时仍是可辨的粒子结构；`prefers-reduced-motion` 退化为静态 logo；logo 取不到像素时回退 `<img>`。
- 时长按 `x 秒` / `x 分 x 秒` / `x 时 x 分 x 秒` 呈现，起点为本轮消息 `createdAt`。
- 思考耗时：后端在首段 thinking 时开始 `Instant` 计时，首段正文出现时结束，写入 `metaJson.thinkingMs`；前端在流式期间用同一口径记录并写入消息，重载历史后由 `fromChatMessage` 读回。只有确实有思考内容且时长 > 0 才写入，不产生 0 秒假时长。

### 3.5 供应商失败重试

- 后端识别 429/rate limit/too many requests/resource exhausted 与 502/503/504/temporarily unavailable/service unavailable。
- 最多重试 2 次，退避 750ms、1500ms；每次重试发出 `retrying{attempt,maxAttempts,delayMs,reason}`，前端渲染为时间线系统行。
- 重试耗尽后按最终失败处理，保留错误信息与会话草稿。

## 4. 实现拆分

1. 文档与 UI 基线（已完成）：CR-056 PRD、UI、LLD、测试映射。
2. Composer：统一候选状态与键盘导航；实现目标/任务入口和会话状态条。
3. SessionRuntime/ChatPanel：新增目标/任务/AgentRecord，修复 subagent upsert 和配置锁定。
4. MessageList/StepsBox：稳定 producer 标签、未知字段语义、子代理详情与失败态。
5. ModelPicker：CLI/权限能力矩阵、模型搜索/过滤/思考档位联动。
6. Rust：扩展权限解析到已能真实表达的 CLI 模式，保持未知/未验证模式拒绝；补充事件字段兼容。
7. CSS/滚动：按 UI-CR056 和 UI-SCROLL-001 调整布局与滚动容器。
8. 验证：`npm run build`、`cargo test --offline --lib`，再执行侧栏交互冒烟；记录设计/软件对照和未验证项。

## 5. 风险与边界

- 未核验的真实 CLI 版本、审批通道和 OS 隔离不能在本轮宣称可用；后端仍应拒绝未知模式。
- 目标/任务持久化暂未建立 DB 契约，刷新后不承诺恢复；消息/历史不受影响。
- Office 面板复用 ChatPanel，但专有入口的视觉对照需要单独截图确认。
- 所有侧栏溢出区域执行 UI-SCROLL-001；本轮必须验证消息、历史、模型和引用候选至少四类容器的滚动显隐。
