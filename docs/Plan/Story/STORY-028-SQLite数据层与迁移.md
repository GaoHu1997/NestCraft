# STORY-028：SQLite数据层与迁移

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-013 统一设置入口与菜单](../Feature/FEAT-013-统一设置入口与菜单.md)
- 来源与确认依据：CR-015；ADR-001/DB-FEAT-001 为设计基线
- 关联：ADR-001 / DB-FEAT-001；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望配置、授权、会话与索引持久保存在本地 SQLite，以便重启后不丢失工作状态。
- 本次包含：db.rs 迁移（project/requirement_index/knowledge_library/project_library_grant/provider+key+endpoint+model/cli_sdk/capability/mcp_server/session/message/setting_default/project_ui_preference/server_host）；密钥受管文件。
- 不包含：需求正文写库（正文仅 Markdown）、多用户、迁移工具界面。
- 验收标准：
  - AC-STORY-028-01：首次启动自动建库建表（WAL），app_data_dir 下生成 workbench.db。
  - AC-STORY-028-02：密钥明文仅存受管 JSON，DB 与日志只出现掩码。
- 方案：DB-FEAT-001 §2；实现位置 src-tauri/src/db.rs
- 验证结果：迁移 SQL 编译通过；运行时建库验证待 tauri dev 冒烟。
- 验收结论及依据：待验收
