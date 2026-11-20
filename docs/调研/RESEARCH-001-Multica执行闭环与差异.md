# RESEARCH-001：Multica执行闭环机制研究与本项目差异

- 日期：2026-11-19。来源用户明确要求详细研究Multica并结合调整需求/设计/方案；研究只读，未运行参考平台、npm、daemon、真实CLI或生产业务。
- 固定源码：[multica-ai/multica@32fc2ad9a4129755cc0a946f518b8a9ae34476ac](https://github.com/multica-ai/multica/tree/32fc2ad9a4129755cc0a946f518b8a9ae34476ac)。旧CR016研究快照608c…不能代表本次主线。
- 方法：主读取官网/许可证、下载固定公开源码到本地不入库参考区，两独立只读代理分别核查配置能力和Run生命周期；源码行号是对应提交证据，不是本机CLI实测。
- 本报告是外部机制研究，不是复制代码许可或本项目执行方案。采用方案以[LLD-CR026](../LLD/LLD-CR026-有效执行计划与能力编译.md)为准，不在方案中保留参考品牌。

## 1. 全链条

Issue/Comment/Chat/Autopilot/Wakeup明确触发 → Agent身份及配置 → agent_task_queue Run →匹配Runtime/daemon事务领取 → 工作区/原生配置/Skills/MCP准备 → backend.Execute → sequenced transcript/cumulative usage → completed/failed/cancelled →讨论/原Agent retry/阶段交接。Issue与Run是不同对象，已完成一次运行不代表业务完成。

[运行概览](https://multica.ai/docs/how-multica-works)、[Runs](https://multica.ai/docs/tasks)、[事务领取 task.go3753–3836](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/service/task.go#L3753-L3836)、[领取SQL816–877](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/agent.sql#L816-L877)。同Issue+Agent串行，同Issue不同Agent可并发；Agent和Runtime各有并发上限、在线与心跳条件，不靠浏览器时钟。

## 2. 配置解析和冻结点

Agent保存身份、职责、runtime、model、thinking、skills、Access、custom_env/args及MCP。CLI只是Runtime执行工具，不是Agent身份。按官方设计，描述是展示，不进入执行prompt；职责instructions/skills才进入每次执行。

**不是入队时完整冻结配置。** 入队主要存agent/runtime/trigger/workflow/context引用；claim重新GetAgent读取当前Model/Thinking/RuntimeConfig/env/args/MCP/skills。交给daemon后的payload不随修改原地变，但启动前还解析本机配置。对我们“授权前冻结计划”的诉求，这是必须补强的差异。

[Agent概念](https://multica.ai/docs/agents)、[入队SQL351–405](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/agent.sql#L351-L405)、[claim配置2982–3171](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/handler/daemon.go#L2982-L3171)。

## 3. 权限四层不能混

Agent Access是‘谁可触发’，不是文件/shell/network限制。private/public_to检查originator与成员范围，管理/查看也不自动授权invoke。

官方明确默认Run具有daemon系统用户完整权限，真实HOME/XDG/本机CLI凭据可达，不保证文件沙箱。per-run workdir/CODEX_HOME/task token分别减冲突或限制平台API身份，不是阻止文件和网络旁路。隔离建议独立账户、容器或VM。

[Security model](https://multica.ai/docs/security-model)、[Access源码13–166](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/handler/agent_access.go#L13-L166)。我们的invoke权限、批次执行授权、CLI原生策略和OS/网络隔离必须分别定义与验证。

## 4. CLI差异

| CLI | 固定源码方式 | 不宜照搬 |
|---|---|---|
| Claude | stream-json，固定bypassPermissions，禁AskUserQuestion，model/effort参数，managed MCP配置 | 不是自动从Task生成最小工具白名单；原生Args可能重复model，不可只凭字段说实际模型固定 |
| Codex | app-server JSON-RPC，thread/turn模型档位；自动批准命令、文件、permissions与MCP elicitation | 默认danger-full-access；Windows explicit native sandbox是例外，不是跨平台全局隔离 |
| Grok | xAI Grok Build CLI、agent --always-approve、ACP stdio，session模型设置 | 不是本项目同名Grok SDK就兼容；须包/二进制/协议/版本核实 |

[Claude1163–1238](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/agent/claude.go#L1163-L1238)、[Codex2975–3038](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/agent/codex.go#L2975-L3038)、[Grok192–234](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/agent/grok.go#L192-L234)。thinking不兼容可能清空退Runtime默认并warn，catalog失败可能透传；我们的必要冻结档位应阻塞/重检，不默降。[daemon8097–8127](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/daemon.go#L8097-L8127)。

## 5. Skills和MCP

Skills是SKILL.md及支持文件，经各CLI原生目录发现，不是工具授权；外部Skill不被统一审核/签名/沙箱。Codex还链接本机用户技能，因此Agent勾选集合不等于全部可发现集合。

Skill ref hash不完全表示授权内容冻结：缓存缺失时workspace/builtin bundle可以返回比claim更新的内容，验证source/id与新bundle自洽；plugin路径有旧ref校验例外。本项目须固定精确内容/附件与授权，不能把下载缓存hash当预检冻结。

[MCP运行合并26–78](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/runtime_mcp.go#L26-L78)会保留本机Runtime MCP底层，再workspace/Agent覆盖；nil/null可原生继承。Claude strict只约束最终合并配置，不是我们精确Task工具白名单。部分外部集成确有toolkit/account交集，但不能外推所有shell/原生工具/MCP都受相同限制。

[Skill准备7557–7580](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/daemon.go#L7557-L7580)、[Skill原生投送985–1049](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/execenv/context.go#L985-L1049)、[Codex用户技能14–41](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/execenv/codex_user_skills.go#L14-L41)。

## 6. 重试/停止/恢复

manual rerun新Run保留sourceAgent/trigger/squad/workflow身份，安全同Runtime才resume；fresh新上下文和目录。自动retry可使用Agent当前Runtime，换Runtime清session；同Agent不等于原CLI/model/权限/Skill/MCP原样。默认基础设施有限retry，auth/quota/config/model不自动无限重试。

[重试6093–6203](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/service/task.go#L6093-L6203)、[retry SQL532–604](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/agent.sql#L532-L604)。

取消通知/轮询取消runCtx、等待执行flush及ack，usage仍上报。Runtime heartbeat判断运行存活；准备有claim/lease，running不统一每Run续租；daemon重启把旧Run失败后retry。cleanup_unconfirmed fence保护存在，但部分provider实现、新manual rerun可跨fence，不证明全CLI旧进程已死。未查到统一PauseTask/ResumeTask，wakeup pause是停未来触发。我们保持全writer stopPending→停止证据，不确认不重跑。

[cleanup SQL1–61](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/task_cleanup.sql#L1-L61)、[startup recovery1300–1315](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/agent.sql#L1300-L1315)。

## 7. 交接、依赖和交付

workflow状态移动触发新handler；done/rejected是给Agent的指令，不由Run结束自动推进。workflow_step拒绝旧阶段写回，但仍不等价需求/设计/AC与产物hash门槛。

Squad只唤醒leader协作指派，不把全员同时启动或提高并发。子Issue done/cancelled都可算closed，stage关闭唤醒父Agent复查，不是成功产物依赖。CI finished含success/failure/error，不能当passed。

[Workflow](https://multica.ai/docs/workflows)、[Squad](https://multica.ai/docs/squads)、[子关闭条件576–710](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/service/issue_wakeup_condition.go#L576-L710)、[CI结束287–368](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/service/issue_wakeup_condition.go#L287-L368)。

worktree保存分支/提交/leftover ref、冲突交付检查和一次repair turn是可恢复Git产物保护，不是通用AC验证/成功ArtifactRevision DAG或平台自动合入主分支。PR merged可触发业务状态，不等于平台执行merge或全部需求验收。

[worktree交付540–633](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/internal/daemon/execenv/local_worktree.go#L540-L633)、[Complete SQL1086–1108](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/server/pkg/db/queries/agent.sql#L1086-L1108)。Codex原生多代理默认关闭，父结束时Run终结可能丢未完子结果；我们平台必须跟踪子计划/结果/用量，不能照搬父线程结束语义。[固定文档204–208](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/apps/docs/content/docs/daemon-runtimes.mdx#L204-L208)。

## 8. 与本项目结合的具体决策

借：Agent/Runtime/Run分离、显式触发、持久队列/领取身份、有效配置诊断、原Agent重试与fresh、阶段binding、成员回写、序号日志/累计usage及终结spool、工作目录保护。

补强：管理默认→任务明确覆盖→项目与用户授权→版本能力交集的Resolver；确认前具体化/冻结Plan；Task原权威中记录Attempt planRef；Skills精确hash；MCP精确发现工具而非本机merge；原生工具/宿主工具/网关三层强制边界；撤权实时复检；原计划retry不套新默认；换组合新授权；只读评审/子计划不能扩父权；有效产物/当前AC验证后交付待验收。

不扩：团队多租户、云托管、31CLI、渠道、外部账户共享或生产发布；不复制默认高权限和受限UI代码。当前正式软件与CLI未授权，只有独立DEMO设计与策略检查。

## 9. 许可与实证限制

[Multica License](https://github.com/multica-ai/multica/blob/32fc2ad9a4129755cc0a946f518b8a9ae34476ac/LICENSE#L1-L90)是Apache正文加附加条件，商业嵌入/公开托管及UI品牌移除需对应许可，EE另有商业条款。不能按纯Apache直接搬到栖造改名。因此本轮只研究机制，不复制其源码/界面。

web_search接口402余额不可用，已改直接官方HTTP及固定源码阅读；部分官网页面超时，使用同提交MDX核对，不编造未读结果。未执行实际CLI版本探针、进程停止、沙箱/MCP行为实验，源码和官网不是我们当前机器安全能力证据。原模型/组件检查也不能替代原App完整闭环或正式软件验收。
