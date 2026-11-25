# STORY-098：会话框顶部运行栏（CLI／助理 · 分支 · worktree）

- 类型：用户故事（界面调整）；唯一父项 [FEAT-025 平台主代理运行时](../Feature/FEAT-025-平台主代理运行时.md)；关联 [FEAT-010](../Feature/FEAT-010-AI上下文与能力引用.md) 输入区、[FEAT-019](../Feature/FEAT-019-依赖调度与受管执行.md) worktree 执行。
- PRD：[CR-079](../../PRD/CR-079-会话框顶部运行栏.md)；设计：[UI-CR079-v1](../../UI/文档/UI-CR079-会话框顶部运行栏.md)。
- 来源与确认依据：2026-11-24 用户提供参考截图，要求会话框上方加浅灰帽子栏放 CLI／助理切换、右侧显示当前 git 分支（无则不显示）、最右 worktree 复选框；CLI 才有 CLI 切换，助理只有权限且按 runtime 选项。用户确认：worktree 先做界面开关＋提示；助理用平台专属权限档位。
- 负责人／优先级／状态：lead／中／**已实现，待验收**（2026-11-25 用户「修改代码」授权）／依赖运行通道（CR-069）、git 分支快照（STORY-013）、worktree 执行（后续）。

## 本次包含 / 不包含

- 包含：输入框上方“帽子”运行栏；CLI／助理分段切换；右侧当前 git 分支 chip（无则不显示）；最右 worktree 复选框（界面开关＋提示）；CLI 模式显示 CLI 切换与 CLI 权限，助理模式隐藏 CLI 切换、仅显示平台专属权限档位。
- 不包含：正式源码本批修改；真实 git worktree 创建/执行隔离；新持久化；改动模型/工具/上下文/审批规则。

## 验收标准

见 [CR-079 §3 AC-CR079-01～07](../../PRD/CR-079-会话框顶部运行栏.md#3-验收标准设计与实现共用)（设计与实现共用，不重复维护）。

## 方案与准入

- UI 准入：采用 UI-CR079-v1，场景见 [UI 文档 §2](../../UI/文档/UI-CR079-会话框顶部运行栏.md)。已按稿实现：`ComposerHat.tsx`、`composer-hat.css`、`Composer.tsx`、`ModelPicker.tsx`、`ChatPanel.tsx`。
- 实现位置：`src/modules/chat/ComposerHat.tsx`、`composer-hat.css`、`Composer.tsx`、`ModelPicker.tsx`、`ChatPanel.tsx`。worktree 真实执行另立执行层工作包。
- UI-SCROLL-001：帽子栏非滚动容器，继承共享规则。
- 验收结论：**已实现，待用户验收**。隔离预览验证通过（[REPORT-CR079](../../Test/REPORT-CR079-会话框顶部运行栏.md)：帽子栏、圆角卡片、分支查看、worktree、助理平台权限、模型可选；0 JS 异常；tsc/build 通过）。真实 Tauri、真实 git/worktree 执行与完整成对视觉未验证。

## 阻塞、遗留事项和下一步

- 待用户验收；真实 worktree 执行隔离作为执行层工作包后续接入。
- worktree 真实执行隔离属后续执行层，本 Story 只交付界面开关与提示，不能称工作区已隔离。

## 实现记录（2026-11-25）

- 用户「修改代码」授权后按 UI-CR079-v1 实现；改动仅限 `ComposerHat.tsx`、`composer-hat.css`、`Composer.tsx`、`ModelPicker.tsx`、`ChatPanel.tsx`。
- 验证：`tsc --noEmit` exit 0、`npm run build` exit 0、隔离预览 9 项检查通过 0 异常，截图 `docs/Test/screenshots/cr079-software/`。
- 既有边界保留：有消息的会话不能原地切运行通道（需新会话）；分支列表只读查看；worktree 真实执行未接入。
- 2026-11-25 增量：用户「大管家这个名字很奇怪，换个名字和图标」。平台通道更名「助理」、图标 bot→sparkles，悬停说明与权限弹层标题（助理权限）及原型文档统一；协调者角色「大管家」（CR-037）不变。详见 [REPORT-CR079](../../Test/REPORT-CR079-会话框顶部运行栏.md)。
