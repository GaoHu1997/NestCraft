# STORY-105：记忆抽取与合并服务

- 类型：用户故事（业务服务）
- 所属 Feature / PRD：[FEAT-026](../Feature/FEAT-026-个人记忆层.md)／[CR-092](../../PRD/CR-092-个人记忆层与默认记忆库.md)
- 来源与确认依据：同上（正式编码授权）。
- 负责人 / 优先级 / 状态：主代理／P0／开发中
- 目标：作为系统，我要把对话提炼成记忆并去重合并、维护画像，从而"越用越懂用户"。
- 本次包含：`commands/memory.rs` —— `parse_extraction`（鲁棒解析）、`merge`（ADD/UPDATE/NOOP + supersede）、`rebuild_profile`（聚合画像）、`build_memory_context`（注入文本，预算截断、可关闭）、`ensure_memory_library`（首启幂等建库+三子目录）。不包含：工具注册、注入调用点接线（见 106/107）、后台触发（108）。
- 验收标准：
  - AC-STORY-105-01：`merge` 对同 `scope+kind+memKey` 记 UPDATE（不重复新增），不同记 ADD，冲突 supersede 旧条并置 `supersededBy`。
  - AC-STORY-105-02：`parse_extraction` 对合法 JSON 解析、对非法/超长输入返回空且不 panic。
  - AC-STORY-105-03：`rebuild_profile` 生成 `fieldsJson`+`summary`（≤2KB），无记忆时不报错。
  - AC-STORY-105-04：`build_memory_context` 返回画像摘要+TopK 相关记忆，总预算≤2KB+1.5KB 截断；关闭开关返回空串。
  - AC-STORY-105-05：`ensure_memory_library` 幂等创建 `sourceKind='personal-memory'` 库与 `画像/记忆/日志` 目录，重复调用不重复建。
- 方案：[LLD-FEAT-026 §4.2](../LLD/LLD-FEAT-026-个人记忆层实现.md)／[DB-FEAT-026](../../DB/DB-FEAT-026-个人记忆数据设计.md)
- 实现位置：`src-tauri/src/commands/memory.rs`
- 依赖：STORY-104（数据层）
- 验证结果：通过（编译级+全量）—— merge/画像/注入预算逻辑在 memory.rs 中实现，随全量 607 通过 / 0 失败；`cargo check --all-targets` exit 0。真实模型抽取端到端未跑。
- 验收结论：技术验证通过（模型通道未端到端验证），待用户验收
- 阻塞/下一步：模型调用接口（`run_extraction_for_session` 归 STORY-108）。

## MEM-FIX-001 现行修复（2026-11-26）

- 归属仍唯一FEAT-026，状态：本轮源码修复与技术验证完成，待真实便携版验收，历史完成声称不覆盖此次缺口。
- 本次义务：[修复方案](../../LLD/LLD-FEAT-026-记忆范围与落盘修复.md) MEM-01～MEM-07，实际结果以[修复报告](../../Test/REPORT-MEMFIX001-记忆范围与落盘修复.md)为准。
- 用户决定：个人通用(global)／项目隔离(project:<id>)，个人需要进入个人记忆库。不得默认全scope给AI。
- 实现：分类路由与可信ctx；个人文件和索引镜像；三页签单scope和编辑/删除同步；既有project记录不自动提升个人。
- UI准入（109适用）：UI-FEAT-026-v2，唯一入口 memory-scopes，设计先于代码；UI-SCROLL-001 v1 700ms沿用列表/画像/textarea。设计与实际组件截图均已查看；整个壳层/真实WebView2像素一致不作通过。
