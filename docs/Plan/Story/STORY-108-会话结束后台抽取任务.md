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
- 验证结果：**平台会话已接线** —— `persist` 落库后触发后台 `run_extraction_for_session`（失败仅记日志、不阻塞、可经 `memory.extract.enabled` 关闭）；手动命令 `memory_resediment_session` 可用；CLI 会话依赖 AI 主动 `memory_save`（外部进程无完成回调用以触发）。`cargo test --lib` 607/0、`cargo check --all-targets` exit 0；真实模型抽取端到端未跑。
- 验收结论：技术验证通过（平台会话自动；CLI 靠 AI 主动），待用户验收
- 阻塞/下一步：平台模型调用接口以实读为准。
