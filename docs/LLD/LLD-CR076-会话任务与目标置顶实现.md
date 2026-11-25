# LLD-CR076 会话任务与目标置顶实现

本工作包承接 [CR-076](../PRD/CR-076-会话任务与目标置顶.md) 与 [STORY-048](../Plan/Story/STORY-048-会话任务折叠与目标管理.md#cr-076-正式实现)。用户授权代码先行，设计与技术契约按本次交付补齐。现行视觉入口为 [可操作原型](../UI/仿真原型UI.html)，其中任务与目标资源由集成负责人登记版本及对照证据。

## 会话投影与消息记录

- [ChatPanel](../../src/modules/chat/ChatPanel.tsx) 在输入区上方挂载 [TodoPanel 与 GoalBar](../../src/modules/chat/ChatDock.tsx)。消息流中的工具记录由 [MessageList](../../src/modules/chat/MessageList.tsx) 按 `toolId` 关联。只有调用与结果在消息序列相邻时合为一块；有交错正文或其他工具时，调用卡留原调用位置并提示“结果见下方”，结果卡留原结果位置，完整输出只出现在结果卡中。命令执行输出增量更新未终结调用记录，最终结果携带错误及可用退出码。正文和思考仅合并相邻同类段，不能用配对重排时间顺序。
- [会话计划 reducer](../../src/modules/chat/sessionPlan.ts) 接受 `turn`、`toolUse`、`toolResult`、`planUpdate`。`turn` 清理临时配对并保留当前计划。Claude 以 `toolId` 绑定首次调用与结果，只有成功的 `TaskCreate`、`TaskUpdate`、`TodoWrite` 可以改变清单。创建使用结果中的真实任务 ID。修改和删除命中该 ID。缺少返回 ID、失败、重复或孤立结果忽略。`TodoWrite` 与 Codex `planUpdate` 用完整清单替换当前 Todo，空数组清空该清单。
- [Rust 适配器](../../src-tauri/src/commands/chat.rs) 顺序写入会话记录。Codex `todo_list` 数据归一为 `planUpdate`，复用 `message` 的 `role=system`、空 `content` 与 `metaJson={kind:"planUpdate",items:[...]}`。工具调用复用 `toolId`、序列化的 `input` 及可选 `toolOutput`，结果复用 `isError` 并附可选 `exitCode`。应用按 `createdAt,rowid` 回放，内部计划行在渲染前过滤。无需 SQL schema 或索引迁移。存量消息继续按原有 schema 读取，旧版本未持久化的计划数据无法补推。
- [会话运行时](../../src/modules/chat/sessionRuntime.ts) 按 `sid` 保存投影、折叠状态和目标。读快照时校验作用域、会话身份和请求代次。当前会话还有本地执行时优先显示实时记录。删除会话时移除运行时和输入草稿。保留普通工具计时及历史状态统计。
- 目标编辑独立记录组合生命周期和原生isComposing/229；组合中不把确认/取消键交给应用层，不preventDefault阻断IME。开始/关闭编辑清ref，组合结束后普通Enter完整保存、Escape原回焦取消；不改目标身份/修订/清除历史。第8轮浏览器组合兼容事件通过，不代表系统IME实测。
- 目标使用当前会话的唯一身份。编辑同一目标保留身份并增加修订记录，清除或完成后再创建会获得新身份。切换目标身份时局部编辑器和确认弹窗卸载。目标状态保存在当前进程内，项目执行状态与后端任务调度仍由既有系统管理。
- 确认清除会卸载目标条和确认框，不能把焦点交还已卸载的按钮。[GoalBar 的清除回调](../../src/modules/chat/ChatDock.tsx#L124) 通知当前面板；[面板](../../src/modules/chat/ChatPanel.tsx#L253-L276) 在 commit 后消费一次性 `sid + scope` 请求，确认仍是可见的来源会话，仅聚焦本面板的输入 textarea，使用 `preventScroll`，不改草稿或选区。取消确认不触发此恢复。实际浏览器结果见 [集成复核](../Test/REPORT-CR076-会话任务与目标置顶验证.md#2026-11-24-晚间集成复核)。

- 复用 [DB-CR069 的 `message` 表和索引](../DB/DB-CR069-会话运行通道与派发记录.md#6-容量与性能)。首次发送或通过 `/goal` 建会话时，从项目的 `new` 草稿按最新值迁移到新会话。异步接受发送或入队后，仅在来源文字仍匹配时清空已发送文字，清除附件和引用另需匹配发送时的数组身份。取消排队或派发失败时，将恢复内容与目标会话现有草稿合并。

## 目标面板局部视觉契约（第6轮）

任务圆角16px、目标条圆角12px，沿用既定列表180px/编辑120px上限及目标36px高度。目标操作区直接子级padding0、gap8px，每按钮28×28px；以限定选择器隔离旧chat.css内边距，不能删旧规则改变其他调用。长目标保存完整原文，折叠显示省略不截断数据。当前创建与行内编辑、圆角和操作区的实际限定证据见 [第6轮报告](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第6轮2026-11-25)。第10轮解析到原始elevation定义，当前卡面采用浅rgba(252,253,254,.7)/深rgba(48,49,54,.64)、blur40px saturate150%，0.5px l1描边加0 3px 8px/.03和0 0 16px/.02柔光，局部superellipse1.5。尺寸与文字状态后缀不变；[第10轮](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第10轮2026-11-25)验证局部卡面和长编辑滚动，整卡文字/图标完整参考仍待签署。

状态图标局部插槽16px不变；进行中14px双环（r9.5/stroke2/track0.25），1.5秒旋转与dash同时间线相位、监听卸载清理；reduce偏好使用静止弧。其他态10px透明容器内6px实心点，浅深色局部映射，不改全局主题。限定透明背景隔离旧chat-task-dot样式。状态/aria-label/任务顺序不变。[第9轮局部对照](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第9轮2026-11-25)只证明标记，不签整卡面。

## UI-SCROLL-001 义务

继承 [UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md) 与 [历史资源指纹](../Test/cr049-design-baseline.json)。基线 `scrollbar.js` 的 SHA-256 为 `78c43b2fc7badcfb1ad7fd7dc5436879f9f14a357a7f39ca0b32aa511f233fc3`。本次适用消息历史、展开任务列表、目标编辑 textarea、创建目标弹窗与 Composer textarea。采用 [滚动事件监听](../../src/components/scrollbar.ts)、[全局滚动样式](../../src/theme/base.css) 和 [容器约束](../../src/modules/chat/chat-dock.css)。

在同主题、视口、缩放和夹具下操作两端对应区域，记录初始、实际滚动、持续滚动超过 700ms、停止后隐藏、静止 hover/focus、嵌套隔离和无溢出。编辑器同时记录文字、光标、选区、滚动位置及占位。功能测试和视觉结果独立登记到 [REPORT-CR076](../Test/REPORT-CR076-会话任务与目标置顶验证.md)。

## 验证与回退

定向模型回归覆盖真实返回 ID、会话和轮次边界、失败与重复、清空、回放和目标生命周期。集成验证检查普通工具详情、输入与附件队列、消息历史、原生 CLI 事件及同条件设计对照。若回退，按本次代码范围回退前后端映射。已有元数据行不需要删库，回退版本对内部计划行的显示兼容性需要复核。
