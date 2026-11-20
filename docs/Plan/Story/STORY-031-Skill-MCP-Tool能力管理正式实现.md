# STORY-031：Skill-MCP-Tool能力管理正式实现

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-013 统一设置入口与菜单](../Feature/FEAT-013-统一设置入口与菜单.md)
- 来源与确认依据：CR-014 AC-14 + CR-015；逻辑对照 skill/mcp 面板参考（REF-002-8）
- 关联：CR-014 AC-14；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望全局统一管理 Skill/MCP/Tool（不按项目区分），含创建、启停、工具发现。
- 本次包含：Skill 受管目录+SKILL.md、命名正则与重复名拒绝；MCP stdio/http 配置与最小 JSON-RPC 客户端 tools/list 发现；内置 Tool 注册表与风险等级；设置中心三个页签 UI。
- 不包含：MCP 工具调用执行链（会话侧，后续故事）、OAuth。
- 验收标准：
  - AC-STORY-031-01：Skill 名称不符合 ^[a-z0-9]+(-[a-z0-9]+)*$ 或重复名时报错，不产生目录。
  - AC-STORY-031-02：MCP 重复名拒绝；stdio 缺 command、http 缺 url 报错。
  - AC-STORY-031-03：测试连接返回工具清单或明确错误。
- 方案：LLD-FEAT-002 §2；实现位置 src-tauri/src/commands/capabilities.rs
- 验证结果：编译通过；MCP 发现待真实服务器冒烟。
- 验收结论及依据：待验收
