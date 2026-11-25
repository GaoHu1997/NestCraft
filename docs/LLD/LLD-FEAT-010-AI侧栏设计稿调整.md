# LLD-FEAT-010：AI 侧栏设计稿调整

- 关联：[FEAT-010](../Plan/Feature/FEAT-010-AI上下文与能力引用.md)、[STORY-047](../Plan/Story/STORY-047-统一设计稿AI侧栏与输入菜单.md)、[CR-018](../PRD/CR-018-统一设计稿AI侧栏与输入菜单.md)。
- 选定方案日期：2026-11-19；编码前记录。已有壳与样式足够，无需新外部源码调研或依赖。

## 当前实现与变更方式

已有历史原型和正式应用具备会话面板；本轮只沿用其信息结构和交互，不重新规划产品，不修改它们的源码。当前统一设计稿由静态 HTML、主题令牌、经典脚本组成；原任务 UI 读取 TaskReviewScheduler，TaskReviewApp 提供只读快照，但原会话展示尚未完整带入，尤其设计页缺少AI。增加独立 `ai-sidebar.js` 与 `ai-sidebar.css` 局部展示适配层，由静态壳加载；只小幅修改 HTML 挂载和版式，不重写 app.js 或 scheduler.js，不修改正式 src / src-tauri 或冻结 prototype。

用户后续明确纠正：已有AI侧栏只需改样式，侧栏可以打开/关闭，设计页需补齐。顶栏开关与右上关闭按钮改变布局占位，不销毁会话；关闭主区扩展，重开保留消息、草稿及引用，设计UI/模型与同项目其他页签共用。此纠正在本次实现前发给UI负责代理。

侧栏脚本读取已有查看上下文和样例配置；其聊天草稿、引用、菜单与回显仅演示内存。原需求/Task/Run 是业务源，AI 演示不建立可编辑副本、不自动派发或修改验收。项目与服务器 scope 不同，切换不串草稿。可以通过现有 DOM 变化通知更新上下文，但不启动第二个任务时钟；不得每次原页面渲染重建输入框造成失焦。

## 视觉与交互

- 桌面右侧约380～420px，顶端轻标题条、居中空状态、底部圆角输入面。主区适配收窄，不遮挡原任务详情；窄屏顺序回落，输入区域保持可访问。
- 输入面圆角22～26px，细边线与轻阴影。textarea无独立边框，顶部保留文字留白，底部+按钮、受限演示权限/CLI、项目当前样例分支、模型/思考及圆形发送/停止图标。
- +打开等宽菜单，分组标题、16px线性图标、中文名称/次级英文标识/右侧说明，行高约40px、hover浅灰。按侧栏宽度折行，菜单高度取可用视口与侧栏限制，内部滚动。
- 文件引用、本机模型选择等已具备样例源的入口可展示选择层；未接入目标/压缩/导出/反馈等明确说明演示边界，不模拟真实成功。
- 发送只有本地演示消息/回显，始终标明无真实AI调用；停止只停止本机回显，不取消需求Run。空消息禁用，Enter发送、Shift+Enter换行、IME保护；Escape/点击外部关闭菜单并恢复焦点。
- 空态、发送中、停止、未接入提示与无有效模型配置均有可读说明。色彩复用主题令牌，深色无需改全局主题；降低动画偏好保留。

## 数据、安全与兼容

无需数据库或迁移。默认本机内存，不记录真实凭证、源文件正文或服务响应。附件若实现仅元信息并明确未解析。权限控制不连接执行层，按钮不能升级现有执行权限。仍支持file协议、页面CSP禁止外部连接。知识库保持原三栏；列表页面不显示AI工作区。

## 分工、验证与交付

UI代理仅负责当前设计目录中的HTML挂载、独立侧栏脚本/CSS及操作说明；共享正式文档和最终集成测试由主代理负责。回退仅撤去新资源引用/挂载，原任务状态机不变。无提交、推送或生产发布。

检查新脚本语法、STORY-047专属离线浏览器交互和截图；重跑CR-016/017状态机及CR-017浏览器闭环，检查文档链接和最终变更。1440×900、1920×1080、390×844与深色检查。自动验证不替代用户最终视觉验收。

## CR-076 聊天输入与答复呈现

用户授权先实现、后回填。覆盖 [STORY-062 增量](../Plan/Story/STORY-062-会话答复呈现与文件定位.md#cr-076-聊天输入与答复呈现) 和既有输入引用入口。参考输入触发、会话、附件及命令注册包版本为 `0.2.2-rc.5`，实现继续复用本项目组件及令牌。

- [Composer](../../src/modules/chat/Composer.tsx) 以 `scope:session` 保存引用和附件草稿，文本沿用会话草稿接口。附件和引用可在当前应用运行内恢复。临时会话落定后迁移草稿。[ChatPanel](../../src/modules/chat/ChatPanel.tsx#L983) 发送接受时先用内存草稿、会话元数据、空串的顺序取得当前文本，解决仅发图片且未登记文本时误判为已编辑的问题。文本比对与引用、附件的数组身份校验共同保护等待期间的修改。`/goal` 通过 `onCreateGoal` 进入目标流程。
- MCP 菜单按服务名命中时保留该服务全部工具，按工具名命中时仅保留对应服务的匹配工具。三条键盘路径共用 [可见候选助手](../../src/modules/chat/Composer.tsx#L53-L55)，动态排除 disabled、闭合 details 与没有布局矩形的行；不自动展开、启动服务或执行工具。选择后的结构化command引用与原始消息请求文本保持不变。第1轮浏览器结果见 [集成验证](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第1轮2026-11-24)。
- [AttachmentImages](../../src/modules/chat/AttachmentImages.tsx) 先解码 PNG、JPEG、WebP，再提交 Base64、MIME、名称及大小。每消息最多 8 张、单张最多 10 MiB。宿主验证后写入临时文件，经 Codex `--image` 用于首次、续接和重试，并清理临时文件。Claude、Grok、Platform 暂无已接入的图片发送路径。消息单图在解码后用原图尺寸计算 [UI-CR034 定义的缩略框](../UI/文档/UI-CR034-会话答复呈现与文件定位.md#cr-076-聊天输入与答复呈现)，多图用 CSS 排列固定方块。草稿外框使用限定于chat-draft-image的60px border-box，内图填满；不能把内图60px加边框后62px当成符合外框规格。消息单图/多图选择器不受此修改。原生预览新打开时，在showModal之后只聚焦本dialog关闭按钮（局部ref、preventScroll），不在已打开时反复抢焦点；关闭恢复来源缩略按钮。保存下载原始data URL，复制位图编码为PNG，编码字节可不同但像素应保持。第10轮预览采用40px stage留白、图上限1600px/圆角16px、浅黑24%/深黑50%无模糊蒙层和原prominent三层阴影；右上20px位置36px圆形关闭、16px确切矢量。复制与保存保留原函数，入口置于图片右键或Shift+F10／ContextMenu的dialog内局部菜单，而非固定caption/footer。菜单12px视口夹紧、键盘上下/HomeEnd/Enter/Tab和ShiftTab、分层Escape，组合标志/229保护原生键盘click；不更新全局菜单或权限。首次聚焦关闭按钮，打开菜单不再次showModal抢焦点；卸载只恢复connected/visible来源，避免跨视图抢焦点。第3轮历史结果见 [验证报告](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第3轮2026-11-2425)，当前入口回归/成对视觉见 [第10轮](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第10轮2026-11-25)。
- 输入与菜单搜索分别跟踪组合生命周期，原生组合标志或229也独立阻止快捷键选择/提交。Composer组合时保留草稿但暂不改变触发区，compositionend再以最终caret/text检测；作用域变化清ref。搜索输入节点不重建，方向键不移焦；不preventDefault阻断输入法。附件拒绝类型/空文件/超10MiB/解码失败或超过8张时，已接受附件、文字、选区保持，可移除后清错误。第8轮功能证据见 [验证报告](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第8轮2026-11-25)，系统IME仍未测。
- [限定输入表面](../../src/modules/chat/composer-reference.css)只重绑28px卡面、soft阴影、28px加号与34px发送浅深色/disabled opacity，保持textarea和现有控制条所有结构/高度/字号。引用菜单loading aria-busy、error alert；成功且所有渲染候选和goal无匹配时显示综合status，不在loading/error时假称空结果。第11轮状态和局部表面证据见 [报告](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第11轮2026-11-25)。第12轮进一步采用14px/24px、docked36px底限/336px十四行上限、rows1与原node自动增长；顶部8px/间距12px、控件row2/8/6px及窄卡8px间距。Composer提供可选renderControls(add/send)而保留旧controls路径，ModelPicker将左控件与右侧model/send明确成组，配置弹层仍为fragment同级并portal到body；唯一ChatPanel调用原参数不改。源在[第12轮](../Test/REPORT-CR076-会话任务与目标置顶验证.md#自动续接第12轮2026-11-25)核验字体/限高/右组换行/原弹层锚点和原生编辑；exact其他SVG/完整原参考host和未验状态仍列入[完整清单](../Test/CR076-验收清单.md)，不是可豁免优化项。
- [事件契约](../../src/api/index.ts) 增加 `toolUpdate`，按 `toolId` 更新累计命令输出。`toolResult` 可带 `exitCode`。`planUpdate.items` 为完整 `{text,status}` 快照，状态为 `pending`、`in_progress` 或 `completed`。`[]` 清空。FEAT-011 管理计划和目标投影及 ChatPanel 集成。
- [CLI 与会话存储](../../src-tauri/src/commands/chat.rs) 复用 [ChatMessage 结构](../DB/DB-CR069-会话运行通道与派发记录.md)。图片编码在用户行的 `metaJson.attachments[]`，与旧元信息行兼容。调用行带 `toolId` 和 `input`，结果行带 `toolId`、`isError` 和可选 `exitCode`。Claude 结果保留字符串或序列化内容块。计划快照以空内容 `system` 行记录，`metaJson` 含 `kind=planUpdate` 和 `items`。按 `createdAt, rowid` 回读，无需迁移。
- [MessageList](../../src/modules/chat/MessageList.tsx) 以用户消息划分轮次，在轮内配对工具，交错结果按原位置展示。单条工具直接使用ToolBlock，连续2条及以上才套工具组details；当前显示降级只取静止、非streaming的真实assistant尾条，error另保留；工作/工具/system尾不向前找正文，不在过程内重复最终copy。已有copy闭包保留且只作用于该目标，绝不由此推导成功或retry/fork授权。完整目标级动作契约见[核对报告](../Test/REPORT-CR076-回复动作契约核对.md)，完整动作仍未接通。命令详情保持完整原始command，并在同一原生details内展示其他输入字段JSON（包括cwd、timeout、env、嵌套对象、数组、false/0/null），不按值过滤。无效JSON保留原文fallback；输出和退出码保持原始结果。内部计划行由视图过滤。滚动采用 [UI-CR049-v1](../UI/文档/UI-CR049-滚动条按需显示.md)。

验证包括生产构建、CLI 合成帧与 SQLite 回读、原生 argv 和临时文件寿命、浏览器交互，以及同场景设计与软件动态对照。回退沿用既有消息表和旧附件兼容路径。

### 2026-11-25 消息呈现纠正

用户以四图明确要求代码先行后回填；本轮只属于FEAT-010，不修改输入运行栏、任务目标或后端。现行视觉见[消息v2](../UI/文档/UI-CR034-会话答复呈现与文件定位.md#2026-11-25-消息呈现-v2)，结果见[报告](../Test/REPORT-CR076-消息呈现纠正.md)。

- [展示规则](../../src/modules/chat/messagePresentation.ts)是无IO、无持久化的纯投影：按明确工具身份分类；按toolId计调用，结果单側不再记执行；仅从输入字段和patch头取得修改文件并做词法去重。不检查磁盘、不从输出猜文件、不编成功。未知和失败保留提示。
- 原buildBlocks/buildTurns负责真实顺序和紧邻配对，未替换。消息渲染按投影组织语义摘要与原生details；原始工具名、命令、non-command参数、output和exitCode均在原位可展开检查。保留旧附件、引用、文件定位及最终copy目标降级规则。
- 工作总栏时长使用本轮用户到最后记录的时间跨度；悬停提示说明估算，不代表真实执行耗时。运行计时仅在可见页面开启，同轮用户手动折叠状态保持；没有有效时间值不显示假0秒。
- [消息局部CSS](../../src/modules/chat/message-zcode.css)只作用chat-zcode-messages，移除旧轨道与彩色标签；正文／摘要分别定义宽窄阅读层级。Markdown仅新增table-scroll原生横向滚动wrapper，保持既有安全过滤和定位。邻接[许可](../../src/modules/chat/message-zcode.LICENSE)／[归属](../../src/modules/chat/message-zcode.NOTICE)保留。
- 已有消息表、metaJson字段及事件契约复用，**DB无需变更**；本轮不接新权限、队列、任务执行或reply-level重试／分叉。回退限定移除新展示引用和恢复本轮呈现增量，不回退并行输入代码或历史数据。
- 相关回归为纯展示13项、实际组件展开／折叠／浅深宽窄／交错信息／子智能体身份和实际滚动；完整像素与原生环境仍按报告列未验证，不能降低验收门槛。
- 2026-11-25 输入菜单增量（对齐 DSH）：`+` 菜单改为「添加/指令」两段紧凑行（图标＋名称＋英文＋右侧说明、当前行高亮）；`+ 文件` 经新增 Rust `pick_local_files`（`OpenFileDialog` 多选、任意类型）取得**绝对路径**并插入输入框，不上传；`目标` 作为 `/goal` 命令插入 `/goal `；`@` 项目文件由 `fsListTree(depth6)` 平铺改为单层 `fsListDir` **逐层进入/返回上级**。数据契约新增只读命令返回 `Vec<String>` 绝对路径（不落盘），无 DB 迁移、无附件上传通道。见[报告](../Test/REPORT-CR076-输入菜单与目录.md)。
- 2026-11-25 消息呈现增量：Markdown 代码块 DOM 后处理包 `.chat-code-block`（语言标签＋复制＋自动换行）；每轮从改文件类工具输入经 `changedInputPaths` 派生「本轮改动 N 文件」折叠摘要，点击走 `requestLocate`。均前端派生、只读工具输入，无新增数据契约。见[报告](../Test/REPORT-CR076-消息呈现第二批.md)。
- 2026-11-25 消息呈现第三批（并行）：图片多图画廊（附件预览抽 `ImageGallery`，正文 Markdown 图片复用）；回到底部＋按 sessionKey 的 scrollTop 内存记忆；思考流式单行摘要；`MessageList` 新增可选 `sessionKey/onRetryTurn/onEditUserMessage`；ChatPanel 经既有 `api.chatSend` 实现编辑重发/错误重试（新回合追加，不替换历史），内存队列面板；新增只读 Rust `chat_action_status`（配额/待发/运行时退出无数据源时返回 null，UI 不显示）；`TurnNavigator` 右侧回合导航（接入 MessageList，`data-turn-id`+滚动高亮）。无 DB 迁移、无新依赖。见[报告](../Test/REPORT-CR076-消息呈现第三批-并行.md)。
- 2026-11-25 未读点修复（B 方案）：`chat.rs` 在轮次结算后写 `session.unread`（成功→success、失败→failed；停止/持久化失败不改写），新增 `apply_session_unread`/`set_session_unread`；`ChatPanel` 正在查看则立即清空为已读；`db.rs` 注释补 success/failed。复用既有 `session.unread` 列，无迁移。见[报告](../Test/REPORT-CR076-会话未读修复.md)。
