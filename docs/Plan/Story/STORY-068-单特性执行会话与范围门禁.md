---
id: STORY-068
type: Story
parent: FEAT-019
status: 设计中
---
# STORY-068：单特性执行会话与范围门禁

- 类型：用户故事。
- 所属 Feature：[FEAT-019](../Feature/FEAT-019-依赖调度与受管执行.md)，唯一父项。
- 来源／确认：2026-11-20用户明确「一个会话最多只能执行一个特性的需求」，要求调研后考虑平台补充；[CR-047](../../PRD/CR-047-单特性执行与需求设计防遗漏.md)。仅研究／规则／需求／方案授权，不编码。
- 负责人／优先级／状态：主代理／P0／设计中；单Feature原则直接确认，具体运行方案待评审，正式门禁未实现。
- 目标：作为研发使用者，我希望每个执行会话只实现一个明确Feature，跨域请求在协调层拆分并有独立执行身份，使长上下文和委派不会悄悄扩大实施目标。
- 依赖：STORY-054受检工作包、STORY-059恢复、STORY-058授权/能力复检、STORY-055证据门禁；不创建第二套Task/Run权威。
- 本阶段落实范围（2026-11-20用户「我们本来就是按照特性派发的任务」）：先在既有按特性派发上补会话Feature身份、不可变归属、发送/历史/恢复复检与错误提示。完整ScopeBinding的工作包、子代理强制、覆盖证据门禁仍按AC01～06在后续受检工作包实现；不能因本阶段标签与绑定完成就宣称全部6条AC通过。

## 范围

包含不可变project/feature/workPackage身份、协调与执行权限分层、同Feature子调用、跨Feature请求拒绝/拆分、恢复身份复检、限定集成的追溯。一次批次可含多Feature，但每Feature独立执行会话；该会话内可逐Story小步推进。不包含自动获得编码授权、任意CLI OS隔离、平台聊天全局禁用、真实runner/模型/生产变更、默认新建未来框架。

## 验收标准

| 编号 | 给定／当／则 | 验证方式 |
| --- | --- | --- |
| AC-STORY-068-01 | 给定受检执行工作包，当创建/续接执行会话，则绑定唯一projectId/featureId/包版本，Story必须属于该Feature；缺身份、错项目、非法归属或无编码授权不能进入实现。 | 服务端契约／独立模拟接口 |
| AC-STORY-068-02 | 给定批次涉及多个Feature，当协调请求实施，则协调会话只读拆分/排依赖，形成各Feature独立执行包；不可在同编码会话或未受检子代理中跨Feature写入。 | 批次拆分与委派继承测试 |
| AC-STORY-068-03 | 给定Feature A执行中收到Feature B变更，当提交任务/动作或子调用，则拒绝范围不符并保A草稿/进度，提示B需对应包；“继续”、换CLI/模型、fresh或复用shared文件不解除约束。 | 负向范围注入／恢复测试 |
| AC-STORY-068-04 | 给定一个Feature有多Story或依赖其他Feature产物，当执行，则在本Feature逐Story推进，只消费有效外部产物；依赖缺失阻塞，不顺手修改其他Feature。 | 父子集合／依赖修订测试 |
| AC-STORY-068-05 | 给定限定集成会话与已交付候选，当验证/集成，则只处理冻结候选及约定动作；发现跨域修复回责任Feature独立包，无受检修复范围不继续编码。 | 集成范围／差异审查 |
| AC-STORY-068-06 | 给定token预算不足、上下文压缩、断线或模型失败，当恢复，则核对外部检查点/工作包/当前源及writer状态，Feature不变、授权不从摘要重建；缺项/源变化/未知副作用阻塞。 | checkpoint故障注入／迟到回调 |

## 方案、设计与数据

- [LLD-CR047](../../LLD/LLD-CR047-单特性工作包与覆盖门禁.md)：单执行身份与调用时复检，复用原ExecutionPlan、InvocationBinding、租约/fence和授权链。
- DB：会话表已增量增加 `featureId/featureTitle/featureSourceHash/sessionRole` 与索引，旧记录迁移为 ordinary、Feature 为空；会话更新白名单不含 Feature 字段，绑定不可改。完整工作包/checkpoint 表仍属后续，不在本阶段。
- UI：已补 [UI-CR047](../../UI/文档/UI-CR047-单特性执行会话与范围提示.md) 与可操作原型：派发预检显示唯一特性、Epic 不合并、会话头与历史显示归属。**其余执行包/错范围/恢复核对场景仍未做可视稿，不得扩展开发**。
- 实现位置：`src-tauri/src/commands/chat.rs`、`src-tauri/src/db.rs`、`src-tauri/src/models.rs`、`src/api/index.ts`、`src/modules/chat/ChatPanel.tsx`、`SessionHistory.tsx`、`src/modules/projects/Workspace.tsx`、`src/smoke/design-preview.ts`；本轮无提交/PR。

## 本阶段验证与验收

- 软件原型 GUI（1280×720）：FEAT-011 派发预检显示唯一特性与 Story 集合；点击创建后会话头显示 `FEAT · FEAT-011`；历史显示“单特性 · FEAT-011”；EPIC-01 预检显示范围但不提供合并创建。
- 软件 GUI（`?preview=design`）：同样路径实际创建执行会话，header 标签与历史归属显示；关闭前未进行完整深浅／窄屏视觉判读。
- `cargo test --offline --lib`：62/62 通过，含 Feature 正常／错误项目／非 Feature／孤立父链与会话表增量迁移两项新回归；`npm run build` 通过。
- 已实现仅 AC-STORY-068-01 的**会话绑定与创建校验**这一部分，以及 068-03 的“换 Feature 不能改绑定”基础；068-02/04/05/06 的跨域子调用硬拦截、限定集成、外部检查点恢复等**仍未实现**，不能记该 Story 完成或全部 AC 通过。
- 原生 Tauri 真实数据目录、真实派发 runner、跨 Feature 工具调用及视觉对照未验证；下一步在独立 FEAT-019 执行会话中继续，不在 CR047 其它部分混做。
- 2026-11-23 增量：执行账本 M0（批次／任务／依赖／租约／fence／检查点／工作包义务）已实现；派发时把会话 `featureId` 注入工作台 MCP，`write_requirement_doc` 已拒绝跨 Feature 或无父项新建；恢复预检 `inspectRecovery` 与受控恢复 `resumeTask` 已实现（检查点／fence／租约／停止确认引用），但没有真实进程停止证据。068-02 的工具侧硬拦截仅覆盖该工具，068-04／05 与 CLI 原生写入仍不通过，068-06 只覆盖受管记录层。[验证记录](../../Test/REPORT-CR047-执行账本M0与写入保护验证.md)
