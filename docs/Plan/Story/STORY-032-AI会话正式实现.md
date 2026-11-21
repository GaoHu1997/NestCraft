# STORY-032：AI会话正式实现

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-011 会话历史与后台任务](../Feature/FEAT-011-会话历史与后台任务.md)
- 来源与确认依据：CR-005/011/012 + CR-015；逻辑对照会话 GUI 参考（REF-002-1）
- 关联：FEAT-010（引用）、FEAT-012（用量）；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望在项目/服务器内通过选择 CLI 与模型进行流式 AI 会话，支持引用、历史与用量统计。
- 本次包含：会话 CRUD 与项目隔离、流式 delta/thinking/工具卡渲染、引用浮层（文件/知识/能力/@与/）、附件元信息、CLI/模型/档位切换（运行快照锁定）、分支 chip、用量行、草稿持久化。
- 不包含：交互式工具审批（非交互适配器，审批由 permission-mode 决定）、子代理事件、附件正文上传。
- 验收标准：
  - AC-STORY-032-01：发送后事件按 delta/thinking/toolUse/toolResult/usage/done 推进并渲染；停止可中断。
  - AC-STORY-032-02：知识引用经授权网关注入（未授权拒绝并提示），引用 chip 可移除。
  - AC-STORY-032-03：运行中禁止修改会话执行配置（后端拒绝+前端提示回滚）。
  - AC-STORY-032-04：会话与消息持久化，重启后可恢复历史与草稿。
- 方案：LLD-FEAT-002 §3.1；实现位置 src-tauri/src/commands/chat.rs、src/modules/chat
- 验证结果：编译与类型检查通过；真实 CLI 流式待冒烟（依赖已安装 CLI）。
- 验收结论及依据：待验收

## CR-037 普通侧栏原生续接

本增量设计中，既有 AC-01～04 的历史记录保留。用户明确要求 AI 侧栏会话也可以续接，范围见 [CR-037](../../PRD/CR-037-主代理协调与答疑.md#34-可靠性与恢复)。

- **AC-STORY-032-05** 普通会话首轮持久化适配器确认的原生引用后，切工作台视图、关闭再打开侧栏、从历史重开或应用重启，下一轮仍属原 NestCraft 会话。验证适配器实际收到并确认同一原生引用，项目／主机、CLI 和后端身份兼容。已持久化历史和草稿按归属恢复。旧轮、已停止或授权已变化的完成事件不能改写当前原生绑定。普通续接只更新普通 `sessionTurn` 与会话数据，不生成业务运行、业务产物或验收记录。
- **AC-STORY-032-06** 引用缺失、过期、不兼容或授权撤销时，按权限显示历史和具体阻塞原因并保留草稿。允许重建时，用户确认后才开始新上下文，界面保留连续性断点。权限复检失败则阻塞。显式切换 CLI 沿 [STORY-011 AC-05](STORY-011-AI侧栏上下文与会话.md#验收标准) 另建会话。

方案、界面与验证见 [LLD-CR037 §5](../../LLD/LLD-CR037-主代理协作契约.md#5-持久化补读与续行)、[侧栏场景](../../UI/文档/UI-CR037-协作场景覆盖.md)、[数据](../../DB/DB-FEAT-001-知识授权与工作台数据设计.md#3-一致性与并发)、[测试](../../Test/TEST-CR037-主代理协调与答疑.md)。正式用例 notRun。

## CR-037 侧栏原生续接实现记录（2026-11-21）

- 授权：用户 2026-11-21「我更正了需求和设计，你需要对照进行开发和调整」，范围仅 AC-05/06；FEAT-011 单特性执行会话内完成。
- 状态：AC-05 / AC-06 技术验证通过，待用户验收。逐项结论、绑定状态机/CAS 要点、三 CLI 实测矩阵、设计-软件成对对照与未验证项见 [REPORT-CR037-侧栏原生续接实现](../../Test/REPORT-CR037-侧栏原生续接实现.md)。
- 实现位置：`src-tauri/src/commands/chat_binding.rs`（新增，绑定/CAS/判定/fresh 确认）、`chat.rs`（resume 通道、done 新载荷、切 CLI 门控）、`dispatch.rs`（按会话稳定线程存储目录）、`db.rs`（绑定列 + execution_session_turn + grant revision 迁移）、`knowledge.rs`（授权 revision 同事务递增）、`src/api/index.ts`、`src/modules/chat/{ChatPanel,MessageList,chat.css}`（三态 UI）。
- 设计：UI-CR037-SR1（[chat-resume-design](../../UI/chat-resume-design/index.html)）先于软件落盘并登记于 [UI-CR037 §6](../../UI/文档/UI-CR037-协作场景覆盖.md#6-侧栏续接三态设计登记ui-cr037-sr12026-11-21)。
- 验证：cargo test 96/96；`npm run build` 通过；IPC 冒烟最终运行 115/115（本段 12/12 全过）；SMOKE_KEEP_DB 跨应用重启续接通过；真实 claude 2.1.318 / codex 0.166.0 原生续接实测通过；grok 1.0.77 按授权登记 UNSUPPORTED_CLI（新发现其适配器 `--print --json` 对真实 CLI 无效的既有缺陷，见 REPORT §7）。
- 未动事项：STORY-046 AC-09～12 / STORY-042 AC-11～12 受管协调部分因 runner 引擎不存在保持阻塞；UI 交互自检 16 项失败为前序壳重构遗留（与 CR-053 基线一致），非本批引入。
