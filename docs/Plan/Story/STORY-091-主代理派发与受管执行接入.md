# STORY-091：主代理派发与受管执行接入

- 类型：用户故事
- 所属 Feature：[FEAT-025 平台主代理运行时](../Feature/FEAT-025-平台主代理运行时.md)
- 所属 PRD：[CR-069](../../PRD/CR-069-平台主代理运行时与受管执行接入.md)
- 来源与确认依据：用户「把活派给其他 CLI，其他 CLI 有问题再找它」；本项目 [CR-037](../../PRD/CR-037-主代理协调与答疑.md) 已确认大管家角色。**当前仅需求与设计。**
- 负责人 / 优先级 / 状态 / 依赖：主代理 / 高 / 待确认 / 依赖 STORY-089／087、FEAT-019 已实现的 `create_batch`／`create_plan`／`claim_task`（存储与状态机）、FEAT-018 的范围解析设计。
- 目标：作为项目使用者，我希望主代理把编码类工作交出去并给我一个可追踪的任务标识，以便它不自己改代码，我能看到进度和责任链。

## 本次包含

1. 新增工具 `dispatch_work`：输入工作包，输出 `batchId`／`taskIds`。
2. 派发前校验：项目归属、Feature 绑定与源 hash、Story 范围与父链、幂等键与请求摘要、基线 hash。
3. 调用既有 `create_batch`（`execution.rs:619-726`）创建批次与任务，**不复制**其逻辑。
4. 可选创建执行计划（`create_plan`，`execution.rs:2213-2283`）并返回 `planId`；计划不含授权，授权另行由用户确认。
5. 结果回传：向主代理返回结构化摘要（批次、任务数、可执行性、阻塞原因）。
6. 明确「派发成功 ≠ 执行完成」：返回的 `batchId` 只表示已受管接纳。

## 本次不包含

- 真实 spawn worker 进程（M1）。
- 自动领取执行（`execution_dispatch_once` 仍为 M0 模拟，`execution.rs:1708-1710`）。
- 自动验收、自动集成、自动发布。
- 跨 Feature 一次派发。
- 多级子代理委派。

## 关键约束：派发不等于绕过授权

`dispatch_work` **只能创建状态为 `queued` 的受管记录**，不能：

- 创建带授权的计划（`authorize_plan` 不在白名单内）；
- 推进任务状态（`transition_task` 不在白名单内）；
- 领取任务（`claim_task` 不在白名单内）。

```text
主代理可做：create_batch / create_plan（无授权）
主代理不可做：authorize_plan / claim_task / transition_task / dispatch_once
```

这条界限保证「主代理提出工作」与「用户授权执行」分离，与项目既有「协调者不能自行裁决授权与验收」一致（[CR-037 §3.3](../../PRD/CR-037-主代理协调与答疑.md)）。

## 输入契约

| 字段 | 必填 | 说明 | 校验 |
| --- | --- | --- | --- |
| `projectId` | 是 | 项目 | 必须存在于 `project` 表 |
| `featureId` | 条件 | 执行特性 | 若会话为执行会话则必须等于绑定 Feature |
| `storyIds` | 是 | 目标 Story 列表 | 非空；每个必须存在于 `requirement_index` 且 `type='story'` 或 `'bug'` |
| `baselineHash` | 是 | 需求基线 | 非空；建议取 `document_hash` 或组合 hash |
| `idempotencyKey` | 是 | 幂等键 | 同键同摘要返回原批次；同键异摘要拒绝（`execution.rs:637-643`） |
| `requestDigest` | 是 | 请求摘要 | 用于幂等比对 |
| `dependencies` | 否 | 依赖边 | 后继／前置必须都在本批次（`execution.rs:699-705`） |
| `phase` | 否 | 计划阶段 | 默认 `prepare`；必须是 `prepare/implement/verify/integrate/deliver`（`execution.rs:2214-2219`） |
| `selectedCli` | 条件 | 目标执行器 | 创建计划时必填；必须已安装且启用 |
| `modelRef` | 条件 | 目标模型 | 创建计划时必填 |

## 验收标准

- AC-STORY-091-01：给定合规工作包，当主代理调用 `dispatch_work`，则创建 1 个批次与 N 个 `queued` 任务，返回批次与任务标识；任务状态为 `queued`。
- AC-STORY-091-02：给定相同 `idempotencyKey` 与相同 `requestDigest` 重复调用，则返回原批次，不创建第二个批次。
- AC-STORY-091-03：给定相同 `idempotencyKey` 但不同 `requestDigest`，则拒绝并说明幂等键冲突（对齐 `execution.rs:638-640`）。
- AC-STORY-091-04：给定 `storyIds` 含不存在的编号，则拒绝整次派发，不产生部分批次。
- AC-STORY-091-05：给定依赖边引用不在本批次的 Story，则拒绝并指出哪个 Story（对齐 `execution.rs:701-705`）。
- AC-STORY-091-06：给定依赖形成环，则拒绝整图并回滚（对齐 `execution.rs:722`、`729-777`）。
- AC-STORY-091-07：给定会话为执行会话且 `featureId` 与绑定不一致，则拒绝派发。
- AC-STORY-091-08：给定工作包合规，则创建的批次状态为 `running`、任务为 `queued`，且**没有**任何任务进入 `running`（因为派发不启动执行）。
- AC-STORY-091-09：给定主代理尝试通过其他工具推进任务状态或领取任务，则工具不可用（不在白名单）。
- AC-STORY-091-10：给定派发成功，则返回内容明确区分「已接纳」与「已完成」，不出现「已完成」「已通过」等表述。
- AC-STORY-091-11：给定创建计划时 `selectedCli` 未安装，则拒绝创建计划并说明；批次本身可保留（计划失败不回滚批次，需在返回中说明）。
- AC-STORY-091-12：给定派发后用户在主代理继续对话，则主代理可读取任务状态（只读），但不修改任务状态。

## 方案

[LLD-CR069](../../LLD/LLD-CR069-平台主代理运行时实现.md) §7（派发工具）。
数据见 [DB-CR069](../../DB/DB-CR069-会话运行通道与派发记录.md) §3。
验证见 [TEST-CR069](../../Test/TEST-CR069-平台主代理运行时验证.md) §5。
UI 见 [UI-CR069](../../UI/文档/UI-CR069-平台主代理会话准入.md)。

## UI 准入

- 受影响场景：任务页派发树显示主代理发起的批次（现有 `TasksPane` 已只读展示 `execution_task_list`，见 `Workspace.tsx:576-618`）。
- 复用判断：若完全复用现有只读任务页与派发树，**不需要新设计**；但当前 `TasksPane` 已用真实数据源，需核对显示是否已覆盖「主代理发起」这一来源标注。
- 若需新增「来源＝主代理」标识，**需补设计**。

## 实现位置（预期）

- `src-tauri/src/commands/platform_agent.rs`：`dispatch_work` 工具定义与校验。
- 复用 `src-tauri/src/commands/execution.rs` 的 `create_batch`、`create_plan`、`read_batch`、`read_plan`。
- 复用 `src-tauri/src/commands/projects.rs` 的 `read_requirements`（`386-398`）做 Story 存在性与父链校验。
- 复用 `src-tauri/src/commands/sdk.rs:541-560` 校验 `selectedCli` 已安装。

## 验证结果

| AC | 方式 | 预期 | 实际 | 证据 | 时间 |
| --- | --- | --- | --- | --- | --- |
| AC-01～12 | 未执行 | — | 未执行（无编码授权） | — | — |

## 验收结论及依据

待验收（未实现）。

## 阻塞、遗留事项和下一步

1. 阻塞：无正式编码授权。
2. 阻塞：M1 真实执行未接通，派发后任务停留在 `queued`；用户需理解这是「已接纳未执行」。
3. 待决定：`dispatch_work` 是否允许创建计划（当前设计为可选）。
4. 待决定：默认 `max_tasks` 与是否允许多 Story 批次。
5. 下一步：先实现批次创建与校验（不依赖 M1），再评估是否开放计划创建。
