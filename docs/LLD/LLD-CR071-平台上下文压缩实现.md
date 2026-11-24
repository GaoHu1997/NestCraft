# LLD-CR071-v2：平台上下文压缩施工方案

- v1为开发前基准；v2记录施工中再次评审的细化：回放原文hash/角色校验、大工具结果可逆引用、完整副作用工具配对、既有工具总开关及隔离连接测试。上述变更先补源方案再接入代码，不新增依赖或跨Feature权限。源码已实现，实际验证见REPORT-CR071；不是视觉或真实模型质量验收。

- 唯一 Feature：[FEAT-025](../Plan/Feature/FEAT-025-平台主代理运行时.md)；需求 [CR-071](../PRD/CR-071-平台会话分层上下文与安全找回.md)；Story 094/093；数据 [DB-CR071](../DB/DB-CR071-平台会话摘要与回放.md)；设计 [UI-CR071](../UI/文档/UI-CR071-长会话上下文设计.md)。
- 基线 `3661390`，执行分支 `feature/feat025-context-compression`；2026-11-24 用户明确授权执行者自评通过后开发。本方案是执行基准，不以实现倒灌设计。

## 1. 实读复用与变更清单

| 文件／已读位置 | 复用／改动 |
| --- | --- |
| platform_agent.rs:159～264 | 双协议 build_platform_body；预算以最终 body 为准；Anthropic system 顶层与推理模型字段保持 |
| platform_agent.rs:665～781 | 拆前置准备与已接纳执行，防 Err 被转换为 Ok 导致草稿清空；删除旧的纯文本历史读取，换完整回放视图 |
| platform_agent.rs:784～886 | 复用 ureq/SSE；新增带预算和部分输出的请求包装，字节上限溢出／缺结束帧／error 帧不能被静默当成功 |
| platform_agent.rs:890～1007 | 平台工具循环接内部上下文工具、每轮预算与累计 usage；配对拒绝／重复结果也归档 tool_use |
| chat.rs:48、build_prompt、checked_file_ref、insert_assistant_messages | 复用互斥、引用编译、项目文件/重叠知识授权及消息持久化；checked_file_ref仅提可见性供平台读工具复检，CLI chat_send 后半段不动 |
| db.rs:281、commands/mod.rs | 追加 platform_context::migrate 与模块，默认 runner 不动 |
| 新 platform_context.rs / platform_context_tests.rs | 所有会话上下文数据、纯函数、摘要块与隔离状态测试 |
| 新 platform_context_runtime.rs / platform_context_agent_tests.rs | 平台接入的准备／事务／内部工具与双协议mock；前者是platform_agent的私有子模块，不新增对外命令 |

不得改 Cargo.toml/package.json/.gitignore、CR-068、供应商权威、业务工具目录数量或执行引擎。业务工具列表与调用均复检既有总开关 `aiTools.enabled`（复用dispatch::ai_tools_enabled_from_setting，仅提可见性）及per-tool capability；平台内部上下文工具不向CLI/MCP注入。业务22项目录不变。

## 2. 数据与身份

用 SQLite 新增三个局部表（DB-CR071）：`session_context_state`（CAS revision）、`session_context_block`（不可变源范围及分层摘要）、`session_context_turn`（原多模型轮次的有序消息回放）。都挂 session 删除级联，不更改旧 message 行。

`HistoryTurn`：userId、消息 ID 列表、原行／回放 hash、完整 ChatMsg 数组、序号、来源指纹。新回放在成功／失败结算时与原消息同一事务写入；sourceHash绑定原消息组及transcript，恢复时拒绝System角色和非首位User注入，原文/回放漂移失败关闭。老数据没有精确回放时从 toolId 完整配对构造保守顺序，不声称等同丢失的原时间线。

大工具结果采用可逆投影：超过4096 bytes的完整结果仍归档在原tool_result；模型仅收到稳定会话/轮次/调用绑定的引用、大小与头部摘录。read_context/search_context可分页访问本轮内存原文及已归档原文。调用配对保持、原文不删，不把恢复内容升级成system；每次请求仍重新预算。源hash逐消息/逐回放增量计算，避免重复展开大工具正文。

`ScopeStamp`：session/project/role/feature/sourceHash/root；来源 hash 汇总知识库启用与 revision、项目授权 revision、Skill 启停。每次准备、提交、搜索、恢复与模型续请求检查该快照；新历史遇到不同来源指纹返回 `CONTEXT_SOURCE_CHANGED`，不带旧资料发到模型。保守策略会使部分非敏感历史也需新建会话，这是选择失败关闭的可用性代价。

legacy：已声明知识引用逐库复检；文件引用复用 `build_prompt` 的受检路径；无法证明来源的旧知识／文件工具交换拒绝恢复。新上下文工具结果携带来源／范围，不赋予授权；源 hash 变化使旧摘要失效而不是悄悄沿用。

## 3. 预算与保护

`ContextBudget::from_model(contextWindow,maxTokens)`：真实窗口合法时采用；未知用本地 32768 限额并记录 unknown。完整请求体 UTF-8 byte length＋256 封装余量作输入保守估计（不宣称精确 token）；请求实际 max_tokens/max_completion_tokens 作输出预留。思考预算导致输出超窗口或模型最大输出则返回错误，不隐式改档位。

软阈值 70%、目标 50%；不小于硬保护量。最近 4 个完整历史轮次、系统、当前用户与未结束工具交换常驻。超过软阈值在输入视图上选旧区间；每发送最多 4 次内部摘要调用。达到硬限制仍不足则 `CONTEXT_BUDGET_EXCEEDED`，不截原文、不自动换模型。

所有模型请求（生成摘要、主回答、工具回填后、恢复后）调用同一预算检查。上游 usage 为唯一计费来源；摘要费用与回复费用累计后发一次 usage，避免前端按轮次去重导致丢计／重复计量。预检失败已产生的摘要 usage 也发出，但不持久化用户消息。

## 4. 摘要计划与提交

1. 加载原轮次／活跃块，校验来源与 hash，生成 `system + blocks + raw-tail + user` 视图。
2. 一级候选由未覆盖的旧完整轮次组成，源数据作为不可信资料发送到同一已选模型；不带任何业务工具；内部输出不发文本／thinking Channel。
3. 摘要字段 goal/constraints/decisions/progress/evidence/unresolved。JSON 严格解析，各字段仅 string／string[]；最大 4096 UTF-8 bytes；摘要不可为空或比被替代视图大；范围由宿主确定，模型不能跳出候选。
4. 旧一级／二级块可合并上层块；覆盖 ID/hash 与父块存储，最多三层。三级块可在同层重整（仍为三级），须净缩减并保留所有父块/源ID，不能无限增长层级。若没有可压缩区间仍超硬限制则失败，不无限递归。
5. 网络期间仅使用内存草案。发送预算满足后才检查 snapshot revision、源 hash、scope；同一事务置新块 active、父块 superseded、revision+1。任何失败不写半个计划。取消在提交前必须阻止写入；已提交正确块保持原文可恢复。
6. 块加载只使用 active 与仍有效的源映射；失效块不覆盖原记录。重启再次校验，禁止把数据库中任意摘要当系统提示。

## 5. 内部上下文工具

代码定义 `context_status`、`search_context`、`read_context`、`compress_context`。固定四项，平台可见，不增业务 MCP 注册表。完整工具 JSON 用现有 ToolDef 构造；上下文工具仍计入 8/8/24 循环上限。

- status：估计窗口／输入／输出预留、unknown、可压缩源范围与 active blocks（无密钥）。
- search：query≤256 bytes、最多 10 条、总摘录≤4096 bytes；范围仅当前会话原文与有效摘要。
- read：id 可为消息 ID／block ID，byte offset≥0、limit≤4096，UTF-8 安全切片并回 nextOffset；不得接受 path/sessionId/projectId。
- compress：模型提供宿主可选的旧范围 ID 与结构化 summary；重新校验保护区、sourceHash、scope、净缩减和状态 CAS，不能压最新用户或当前工具交换。自动预检摘要为主要入口，本工具允许模型在长任务中提前维护范围。

返回为低信任 tool_result，不注入 system。历史检索本身不成为新授权，恢复不永久膨胀下一轮全部历史。重复恢复／压缩受次数及预算限制；压缩幂等可识别 sourceHash。

## 6. 发送与归档

`send_platform`：reserve→load session/provider→build_prompt→load history/scope→prepare context（可能内部摘要）→commit+insert user→execute loop→transaction persist messages+transcript→Done。

前置错误返回 Err；持久化 user 之后的错误通过 Error 通知，不被重新判为未接纳。request 包装保存已收到文本和 usage；watch abort 用 select 停止等待，后台阻塞读有界 timeout 并禁止继续 Channel 回传，已有文本作为部分输出归档，不发 Done。工具配对／记录在拒绝与幂等拦截时也完整。

平台专属有序 transcript 存 context_turn；不复制第二套业务消息，不修改旧测试／CLI StreamOutcome 默认语义。新 metadata 与 assistant/tool rows 在同一事务，不在失败后留下“回复已保存”假结论。

## 7. UI 与授权准入

本增量不新建软件界面、按钮／弹窗／说明长文案，继承 UI-CR069-v2 和原消息／工具步骤／错误呈现。内部压缩不回显；原文搜索／恢复走已有工具步骤。UI-CR071 给出可操作状态夹具与版本；无法用官方浏览器取得必需视觉证据时保持对应项未验证，不改 frontend 样式，不绕过宿主访问拒绝。

工作包：唯一 projectId=`AI_Delelovelop` featureId=`FEAT-025`，Story092 AC01～10＋Story093 AC01～12＋UI-SCROLL-001-v1。源码/方案变化重新核对。完整 AC 不因预算或服务错误删掉。

## 8. 分步验证与恢复

1. 迁移、完整回放、预算：内存 DB 与纯函数测试；`cargo check --all-targets`、`cargo test --offline --lib platform_context::`、全量 lib。
2. 摘要、层级、CAS／净缩减、分页／来源权限：独立 Connection 测试，任何失败不进入下一阶段。
3. 双协议本地 TCP mock：自动摘要→回答、分帧 tool arguments、usage累计、401／非法摘要／无净缩减／source冲突／stream中断／abort／工具结果膨胀。
4. 无生产数据与外网付费测试。新增测试不改旧断言；全量遇到既有 DB 并行竞争保留失败日志并用独立连接／串行复查，不加 ignore。
5. 最终检 diff／依赖/默认值/CR-068/文档链接与父子。本轮不自动 merge、push、release。

回退：不 DROP 新表，旧应用忽略新状态；原 message 完整保留。源更换后旧摘要不能放行；保留用户历史，不删除／重建真实数据库。

## 9. 评审与检查点

源正文采用本 v1；两轮评审见 REVIEW-CR071。此前检索代理服务 HTTP400 未提供结论，本轮是主执行者分轮自评，不是假独立审计。检查点记在 REPORT-CR071：基线/分支、工作层级、授权、源 hash、AC 已做/待做/失败/未验证与下一步；不把任务状态当客观测试结果。
