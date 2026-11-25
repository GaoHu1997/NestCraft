# LLD-CR074：正式执行与义务清单

- projectId：`NestCraft`（本仓库执行身份，非生产项目记录）；协调负责人lead。本会话只做跨Feature协调、文档、集成审查与验证，正式编码由独立Feature执行上下文负责。
- 2026-11-24 用户原话：**“代码改了没。没改需要修改”**。该指令作为本次六项正式编码授权，不扩展为发布、推送、生产数据或其他CR授权。
- 源：[CR-074](../PRD/CR-074-AI会话双布局统一与交互校正.md)、[UI-CR074-v1](../UI/文档/UI-CR074-AI会话双布局统一.md)、[设计指纹](../Test/cr074-design-baseline.json)、[前轮设计验证](../Test/REPORT-CR074-AI会话统一设计验证.md)。采用既有可操作设计，不将软件截图反向替代设计。新授权只覆盖已定义的本次布局/输入/模型/统计/历史场景；设计未覆盖的改变先回设计。
- 编码前基线HEAD：`965fe3182b106d1c0edfdaccfdb20a3911e74e7d`。工作区有CR046/072/073/075及知识性能等未提交变更，全部保护；`ChatPanel`、`Composer`、`sessionRuntime`等已被改动，不得恢复HEAD或整文件覆盖。每个writer先复读当前源、记录本范围指纹，精准编辑，发现未知第三方新写入先停止相关写入并回报。

## 执行边界与准入

| 包／唯一featureId | 完整增量AC | 已定义UI场景 | 独占正式文件／限制 | 验证 |
| --- | --- | --- | --- | --- |
| WP-074-F010／FEAT-010 | STORY062 CR074-01/02 | SC02/03，输入无框、working14px、终态/fallback | ThinkingIndicator.tsx、thinking-indicator.css；输入无框使用限定textarea选择器，不改共享Composer/ChatPanel/chat.css | 尺寸、动效降级、鼠标键盘聚焦；设计/软件截图 |
| WP-074-F014／FEAT-014 | STORY024 CR074-01/02/03 | SC04/05，模型/供应商/档位/空/失效/锁定 | ModelPicker.tsx、新model-picker.css、单独排序测试；发送旁布局用限定CSS，不改Composer/ChatPanel/chat.css | 档位乱序/子集/null映射、自定义、过滤、开关/锁定；同条件截图 |
| WP-074-F012／FEAT-012 | STORY022 CR074-01/02 | SC06，三统计已知/未知/零/详情 | StatsBar.tsx、新stats-bar.css、独立格式测试；可加可选steps，缺可信源显示—，暂不改ChatPanel/后端计量 | 格式、零分母、缓存未知与当前窗口、圆环；同条件截图 |
| WP-074-F011／FEAT-011 | STORY082 CR074-01/02、STORY084 CR074-01 | SC07/08/09，常驻/浮层/菜单/搜索/IME | SessionHistory.tsx、SessionList.tsx及新公共history组件/hook/css；接口保持兼容，暂不改ChatPanel | 外点/Esc/scroll、重命名、IME/光标、20条分页、旧结果 |
| WP-074-F021／FEAT-021 | STORY071 CR074-01/02 | SC01双布局与连续状态 | App.tsx、Workspace.tsx、Workbench.tsx、必要共享会话控制/新布局CSS；ChatPanel限定会话共享/稳定controller段，改前复读保护并行增量；不改四包组件 | 非首行会话/草稿/附件/队列/运行切换，无重复实例/订阅/发送 |

不得让多个writer修改同一共享文件。F021承担双布局会话共享身份，F011公共历史组件保持既有props，使F021无需改F011文件；F014使用既有ModelPicker接口，F012使用可选steps不强行新建计量；F010不改Composer，只限定样式。其他接口需求先消息协商，不越界写入。

## UI-SCROLL-001（每包必读与携带）

采用[UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)和[CR-049](../PRD/CR-049-滚动条仅在滚动时显示.md)，源hash见本批设计指纹。消息、历史、模型供应商/候选、textarea与动态弹层覆盖初始隐藏、实际滚动仅目标显示、连续重置、停止700ms隐藏、嵌套隔离、原生输入与选区保持；悬停/聚焦不唤醒，不禁滚、不改滚动宽度、不丢编辑。现有共享scroll机制复用，子任务不得重写成常显/hover显。每项返回实际证据及未验证范围，不能用class或构建替代动态目视。

## 验证及完成门槛

- 前端沿用React/TypeScript/Vite：主代理最终`tsc --noEmit`和`npm run build`，各包可先定向检查。没有后端改动不机械执行生产或收费上游；必要后端测试仅隔离数据。
- 先设计基线检查、再软件；1440×900浅深/390×844，同一合成数据、状态与缩放，对照输入、working、模型、三统计与历史。真实Tauri不能验证时如实登记，不伪造软件验收。
- 保留正常/空/无匹配/失效/锁定与错误状态，不缩减现行能力。单Feature报告、最终diff审查、集成验证和逐AC结论齐备才可待验收；用户未验收不标已完成。
- **Q-CR074-01步数口径尚未决定**：不可按消息数、计划条数或工具数擅自填真实“步”；先实现完整展示格式并明确—，有可信steps字段才显示。无数据库迁移，本次复用会话、模型与usage。
- 每个独立执行包在自身Story末尾记录实际采用的UI版本、授权、负责文件、验证与遗留；主代理统一更新共享导航，避免文档并写。
