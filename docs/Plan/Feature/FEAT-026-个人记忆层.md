# FEAT-026：个人记忆层

> CR-092（2026-11-25）：新建本 Feature，子项 STORY-104～109，实现「默认个人记忆库 + 对话沉淀 + 画像注入 + 记忆工具 + 记忆管理界面」。**开发中**（正式编码授权）。D1 内置独立记忆库、D2 会话结束抽取+手动兜底、D3 平台当前模型、D4 全局个人为主、D5 默认开启注入，均采用 [RESEARCH-008](../../调研/RESEARCH-008-个人记忆层与默认个人知识库方案建议.md) 推荐。见[需求](../../PRD/CR-092-个人记忆层与默认记忆库.md)／[方案](../../LLD/LLD-FEAT-026-个人记忆层实现.md)／[数据](../../DB/DB-FEAT-026-个人记忆数据设计.md)。

- 类型：Feature
- 所属 Epic：[EPIC-009 个人记忆与助手成长](../Epic/EPIC-009-个人记忆与助手成长.md)
- 目标用户与价值：AI 在长期使用中自动记住用户的事实、偏好、目标与决策，逐渐形成画像，从而"越来越懂我"，全程本地且用户可控。
- 范围与边界：内置「个人记忆库」（`sourceKind='personal-memory'`，目录 `data/knowledge/memory/`）；`memory_item`/`memory_profile` 派生表；抽取→合并→落盘管道；会话结束后台抽取 + 手动沉淀；新会话注入画像摘要与相关记忆；`memory_search/save/list/forget/profile_get` 5 个工具；记忆管理界面。不含云端 embedding、独立向量库、多租户。
- 负责人：主代理。优先级 P0（P1 界面随本批一并交付）。
- 当前状态：待验收（技术验证通过：`cargo check --all-targets` exit 0、`cargo test --lib` 607/0、`npm run build` exit 0；平台会话自动抽取已接线，CLI 自动抽取、真实 Tauri 端到端、设计稿视觉对照未完成。见 [REPORT-FEAT-026](../../Test/REPORT-FEAT-026-个人记忆层验证.md)）。
- 整体验收：见 [PRD-CR092](../../PRD/CR-092-个人记忆层与默认记忆库.md) 的 AC；关闭记忆注入/删除记忆后系统行为回到现状。

## 子项

- [STORY-104 记忆数据层与迁移](../Story/STORY-104-记忆数据层与迁移.md)：`memory_item`/`memory_profile` 表、迁移、store CRUD。
- [STORY-105 记忆抽取与合并服务](../Story/STORY-105-记忆抽取与合并服务.md)：LLM 抽取、Mem0 式合并、画像聚合。
- [STORY-106 记忆工具](../Story/STORY-106-记忆工具.md)：5 个 `memory_*` 工具注册进 `workbench_tools`，授权/预算/审计。
- [STORY-107 会话记忆注入](../Story/STORY-107-会话记忆注入.md)：新会话注入画像摘要 + 相关记忆 TopK。
- [STORY-108 会话结束后台抽取任务](../Story/STORY-108-会话结束后台抽取任务.md)：异步抽取 job + 手动"沉淀本会话"。
- [STORY-109 记忆管理界面](../Story/STORY-109-记忆管理界面.md)：记忆库页签、列表/画像/编辑/删除/搜索。

## 关联与证据

- [PRD-CR092](../../PRD/CR-092-个人记忆层与默认记忆库.md)／[LLD-FEAT-026](../../LLD/LLD-FEAT-026-个人记忆层实现.md)／[DB-FEAT-026](../../DB/DB-FEAT-026-个人记忆数据设计.md)／[UI](../../UI/文档/UI-FEAT-026-记忆管理界面.md)／[方案调研](../../调研/RESEARCH-008-个人记忆层与默认个人知识库方案建议.md)。
