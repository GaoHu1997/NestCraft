# STORY-117：本地搜索会话级授权

- 类型：用户故事（行为变更）
- 所属 Feature／PRD：[FEAT-027 AI 搜索工具](../Feature/FEAT-027-AI搜索工具.md)／[CR-104 本地搜索授权会话化](../../PRD/CR-104-本地搜索授权会话化.md)
- 来源与确认依据：用户 2026-11-26 反馈「本地搜索工具应按会话上的授权来，而不是单独授权」；指定只读调研 PI-Desktop／ZCode／DSH Desktop 后，明确要求采用参考项目的会话级授权；同日「授权开发（含同步 PRD/UI/LLD）」。
- 负责人 / 优先级 / 状态：lead；高；**验证中（实现完成，待技术验证收尾与用户验收）**。
- 目标：作为使用 AI 会话的用户，我希望本地搜索默认继承会话的项目范围、项目外目录按会话授权，而不是先去设置页单独配置白名单。
- 本次包含：默认项目根、会话额外目录、规划模式收紧、删除设置页授权卡片、AI 侧栏搜索授权入口、会话权限档位持久化。
- 不包含：联网搜索改动；平台会话逐次审批卡；全盘索引。

## 验收标准

- AC-104-01：新会话绑定项目后直接调用 `fs_grep`，无需任何授权即可返回项目根内结果，结果带实际搜索根。
- AC-104-02：「设置 · 搜索」不再出现「本地搜索授权目录」卡片；联网配置仍可读取与保存。
- AC-104-03：AI 侧栏「搜索授权」可为当前会话添加/移除额外目录，添加后本会话立即可搜，其他会话不受影响。
- AC-104-04：`path` 指向项目根与会话授权目录之外时返回明确错误并指向授权入口；`../` 与符号链接逃逸被拒绝。
- AC-104-05：`permissionMode='plan'` 的会话只搜项目根；`default`/`agent` 会话正常使用额外目录。
- AC-104-06：会话权限档位重启后保持（`session.permissionMode` 持久化）。
- AC-104-07：未绑定项目且无会话授权时错误可读，不再出现旧「请到设置·搜索授权」文案。
- AC-104-08：`web_search`/`web_fetch` 行为不受影响。

## 方案与实现

- 方案：[LLD-CR093](../../LLD/LLD-CR093-AI搜索工具.md) §2.1／§2.5／§3.1／§6.1；数据：[DB-CR104](../../DB/DB-CR104-会话搜索授权与权限档位.md)；界面：[UI-CR104](../../UI/文档/UI-CR104-搜索授权会话化.md)。
- 实现位置：`src-tauri/src/commands/search_tools.rs`、`ai_tools.rs`、`dispatch.rs`、`platform_agent.rs`、`db.rs`、`chat.rs`、`models.rs`、`lib.rs`；`src/api/index.ts`、`src/modules/settings/SettingsSearch.tsx`、`src/modules/chat/ChatPanel.tsx`、`Composer.tsx`、`SessionSearchGrant.tsx`。

## 验证结果

- 待本轮技术验证记录（见 [REPORT-CR104](../../Test/REPORT-CR104-本地搜索会话级授权验证.md)）。
- 未验证前不得标「已完成」；真实 Tauri 窗口、真实 CLI 会话内工具调用与视觉对照需按报告逐项登记。
