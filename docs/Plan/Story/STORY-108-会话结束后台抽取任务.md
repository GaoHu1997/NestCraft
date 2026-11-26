# STORY-108：会话结束后台抽取任务

- 类型：用户故事（后台任务）
- 所属 Feature / PRD：[FEAT-026](../Feature/FEAT-026-个人记忆层.md)／[CR-092](../../PRD/CR-092-个人记忆层与默认记忆库.md)
- 来源与确认依据：同上（正式编码授权）。
- 负责人 / 优先级 / 状态：主代理／P1／开发中
- 目标：作为系统，我在会话结束后自动把对话沉淀为记忆，无需用户手动整理。
- 本次包含：`memory::run_extraction_for_session`（取消息→调平台模型抽取→merge→rebuild_profile）；会话结束触发（`lib.rs` 后台线程/异步，失败仅日志、不阻塞、可取消）；手动"沉淀本会话"命令 `memory_resediment_session`。不包含：工具/界面主体。
- 验收标准：
  - AC-STORY-108-01：会话结束后台调用抽取，成功则 `memory_item` 增/改、画像重建；失败仅记日志，不影响会话。
  - AC-STORY-108-02：平台模型通道不可用时返回明确错误并降级，不 panic、不伪装成功；记原因。
  - AC-STORY-108-03：手动 `memory_resediment_session` 触发同一管道。
- 方案：[LLD-FEAT-026 §4.2（run_extraction_for_session）/§4.6/§10](../LLD/LLD-FEAT-026-个人记忆层实现.md)
- 实现位置：`src-tauri/src/commands/memory.rs`、`src-tauri/src/lib.rs`
- 依赖：STORY-104、STORY-105
- 验证结果：**平台与 CLI 会话均已接线** —— 平台 `persist` 与 CLI `persist_and_settle` 落库后均 spawn `run_extraction_for_session`（CLI 全用平台供应商，模型通道可用；失败仅记日志、不阻塞、可经 `memory.extract.enabled` 关闭）；手动命令 `memory_resediment_session` 可用。`cargo test --lib` 607/0、`cargo check --all-targets` exit 0；真实模型抽取端到端未跑。
- 验收结论：技术验证通过（平台+CLI 自动抽取），待用户验收
- 阻塞/下一步：平台模型调用接口以实读为准。

## MEM-FIX-001 现行修复（2026-11-26）

- 归属仍唯一FEAT-026，状态：本轮源码修复与技术验证完成，待真实便携版验收，历史完成声称不覆盖此次缺口。
- 本次义务：[修复方案](../../LLD/LLD-FEAT-026-记忆范围与落盘修复.md) MEM-01～MEM-07，实际结果以[修复报告](../../Test/REPORT-MEMFIX001-记忆范围与落盘修复.md)为准。
- 用户决定：个人通用(global)／项目隔离(project:<id>)，个人需要进入个人记忆库。不得默认全scope给AI。
- 实现：分类路由与可信ctx；个人文件和索引镜像；三页签单scope和编辑/删除同步；既有project记录不自动提升个人。
- UI准入（109适用）：UI-FEAT-026-v2，唯一入口 memory-scopes，设计先于代码；UI-SCROLL-001 v1 700ms沿用列表/画像/textarea。设计与实际组件截图均已查看；整个壳层/真实WebView2像素一致不作通过。
