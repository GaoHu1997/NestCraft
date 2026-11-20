# LLD-CR019：AI会话与权限设计契约

> CR-031正式执行细化见[受管执行可靠性契约](LLD-CR031-受管执行可靠性契约.md)及[数据增量](../DB/DB-CR031-事件审批与产物记录.md)：会话交错事件/部分失败、ACK与已读分离、子代理身份和结构化交付、最终参数审批。原计量、权限事实和busy约束继续，本文内存DEMO不能证明新增正式能力；新增可见状态先按[UI覆盖](../UI/文档/UI-CR031-执行可靠性场景覆盖.md)补稿。归属与实施顺序见[CR-031](../PRD/CR-031-受管执行可靠性需求与实施分解.md)，本轮不改原型或正式软件。

- 关联：[CR-019](../PRD/CR-019-AI会话完整控制与统计设计.md)、[UI-CR019-v1](../UI/文档/UI-CR019-AI会话完整交互设计.md)、STORY-021/022/024/025/047/048/049。
- 本轮纯设计制作，不修改软件、SQLite、真实CLI或OS策略。视觉只依有效UI稿，不能用本技术契约降低交互完整性。

## 1. 当前事实、资源与边界

统一稿独立AI脚本已有内存会话/草稿/引用，但任务目标、子智能体、用量、模型两栏、权限均未完整迁入。原app.js/scheduler.js维护独立需求/运行权威，不重写、不修改。只更新ai-sidebar.js/css，可新建ai-session-model.js并在index.html按顺序引入。正式src/src-tauri/历史prototype冻结。

设计数据独立命名DEMO，读取原TaskReviewApp只读快照与aux资料投影；不复制成另一份可编辑需求/任务源。新增会话任务是SessionTodo，不冒充项目Task/Run。跨页签共用scope，跨项目/主机隔离；关闭不销毁输入和会话；原任务80ms渲染不抢输入焦点。

## 2. 数据形态

- Session：id/scope/title/draft/refs/messages/cliId/providerId/modelId/effort/permissionId/permissionRevision/activeLaunchSpec/running/awaitingUser/pendingDecision（id/text/revision/status/answer/history）/eventRevision/readRevision/outcome/todos/goal/agents/requestIds。
- SessionTodo：id/taskName/status（pending/running/completed/failed/cancelled/awaiting_user）/taskId?，标题是独立总结，不截消息。
- Goal：id/text/status（active/paused/cancelled）/revision/history；修改/暂停/删除保留历史，取消确认不生效。
- Agent：id/rootSessionId/taskName/status/startMs/endMs?/requestIds/output；elapsed=结束或当前演示时钟减开始，未知时间用null。
- UsageRequest：requestId/rootSessionId/ownerSessionId/parentSessionId?/source:'demo'|'measured'|'estimated'|'unknown'/uncachedInput/cacheRead/cacheWrite/output/modelMs/toolMs/ttftMs/generationMs/steps。每requestId全树一次，不再加已聚合子usage。
- ContextSnapshot：sessionId/used/limit/system/toolDefinitions/messages/source/revision，仅父当前窗口，不累计子窗口。
- SdkCapability：cliId/name/logo/installed/enabled/version?/protocols/permissionProfiles/nativeEvidence/approvalTransport/isolationVerified/nativeToolRestrictionsVerified/sandboxAvailableVerified/effortCapabilities/managedRestrictions/capabilityRevision/verificationSource；已安装与启用字段分开，不能仅因任务执行器存在就叫已安装。
- Provider/Model：稳定id，enabled/protocol/usableEndpoint/usableKey(仅布尔不存真实密钥)，model.id/name/contextLimit/text/vision/imageOnly/efforts/effortMapping/defaultEffort。模型菜单与配置演示共用一个源，不随意硬编码候选。

本轮数据内存；未来Session/Usage/Capability字段须在正式DB迁移故事中落库，本轮不写DB或真实凭证。

## 3. 计量与状态规则

修订r2（独立审查，2026-11-19）：每个聚合指标返回value/knownValue/coverage（已知项数/应有项数）/sources/sourceStatus，sourceStatus可为measured/estimated/demo/unknown/mixed。任一必要项未知时总量不得显示为完整值：加和字段显示“已知≥X，部分未知”或整体—；混合实测/估算/DEMO明确“混合来源”，不称真实账单。事件数0的空会话与有事件但未知耗费分别显示，unknown来源的数值不能升级成实测。

聚合选rootSessionId下已知requestId，去重后总token=uncachedInput+cacheRead+cacheWrite+output（互斥规范字段）。cacheHit=cacheRead/(uncachedInput+cacheRead+cacheWrite)，只有所需输入分项全部已知且分母大于0时显示完整比例；有缺失则—或标“已知样本缓存比例”，不能用不完整分母假报缓存命中。provider若input已含缓存需在适配器先规范，不能重复累加。模型与工具时间分别加所属事件，但有缺失时同样显示覆盖与部分未知。

TTFT平均只用首token时间有效的请求集合，并标样本覆盖；明确无输出的请求不纳入TTFT。TPS只能用output与generationMs同时已知、generationMs>0的同一请求集合计算sum output / sum generationSeconds，不可分别筛选分子分母。若只覆盖部分请求显示“已知样本TPS”与样本数，不能作为整会话TPS；未知或无有效样本显示—。字段为null/未知时不填0，不产生NaN/Infinity。

Context分项和=used，percent=used/limit（limit未知/0不显示比例），只是父当前窗口；任一分项未知时完整used/比例标未知，已知部分可显示≥值并解释。样例不要复制参考图不一致的分项。所有样例明显DEMO，不表述真实费用。会话未读判断eventRevision>readRevision；success绿、failure红、awaiting_user黄，进入设置readRevision，后台新事件再加revision；只运行而未终结不假绿。

本机模拟新建不取消原Session timer，回调targetSessionId冻结；只停本会话回显。原任务与需求快照不得因SessionTodo/Goal动作变化。只有侧栏可见且目标会话本次消息已实际展示时才令readRevision=eventRevision；关闭侧栏、仅展开历史、后台回调或未展示新消息不得清未读。重新打开当前会话后先渲染，再标已读。

## 4. CLI与模型配置规则

档位由resolveEffort(cliId,detectedVersion,modelId,uiEffort,modelMapping,cliCapabilities)独立解析。UI的High/Xhigh/Max不是可以原样下发的原生参数；必须有对应CLI+版本+模型的已声明映射及native能力，未知/不支持映射拒绝且保留选择与草稿，默认档位可省参数。LaunchSpec包含解析后的nativeEffortArgv/effortCapabilityRevision/verificationSource，原生值不由前端标签自由拼接；本轮样例能力仍明确DEMO，不称真实版本已核验。

当前SDK仅Codex/Claude/Grok；截图其它CLI是风格资料不扩平台。候选=Sdk支持且installed&&enabled，卸载即时移出且原选择保留、禁发，不静默切换。运行/待处理权限确认时CLI/模型/权限禁改；新会话与历史仍可查看。

非空换CLI弹确认，确认创建新会话并让用户选择兼容模型与权限，原历史/回调不变。模型只列兼容协议、供应商可用、有示例有效端点/凭据布尔、文本且非图像专用；选择保持弹层与会话id，effort只能该模型声明项。失效保留ID、禁止发送。

## 5. 权限原生事实与设计矩阵

本次实际只读核验：[Claude权限模式](https://code.claude.com/docs/en/permissions.md#permission-modes)、[Codex exec参数源码](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)、[Codex exec审批处理源码](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)。Codex官网CLI参考本次403，因此不引用未读取的官网正文。官方main是滚动源码而非本机安装版本，正式执行必须按已检测CLI版本探测能力。

当前正式适配器只读核验：chat.rs的Claude硬编码acceptEdits，Codex exec，Grok尝试print/json；没有菜单权限参数接入，chat_approve也未实现审批通道。这是现状缺口，不修改设计去假装现有实现已满足。

| 产品模式 | Claude映射与前置 | Codex exec映射与前置 | Grok |
| --- | --- | --- | --- |
| default 默认 | --permission-mode default；需要真实审批传输，现非交互宿主无通道时禁用 | exec默认never且拒绝人工审批请求，当前适配不能兑现逐动作人工审批，禁用并要求未来app-server传输 | 未核实，禁用 |
| plan 规划 | --permission-mode plan；仅分析/只读工具语义，不等于OS只读沙箱；正式必须额外读写隔离/工具门 | --sandbox read-only -c approval_policy="never"，拒绝越界而不升级，版本能力核验后可用 | 未核实，禁用 |
| agent 代理 | --permission-mode acceptEdits；自动接受编辑，其他工具仍受规则/审批；无审批时只能已允许工具，不能宣传无限执行 | --sandbox workspace-write -c approval_policy="never"，仅允许已定义沙箱能力；缺OS沙箱支持时禁用 | 未核实，禁用 |
| auto 自动审批 | --permission-mode auto原生存在，但模型/版本/组织策略/分类器前置未实测，默认禁用并说明；dontAsk是拒绝需询问操作，不等价auto | 官方main有AutoReview相关能力，但当前集成版本/参数/审查策略未核实；默认禁用，不用never冒充智能审批 | 未核实，禁用 |
| full 全自动 | --permission-mode bypassPermissions，仅在已验证隔离且托管策略允许并二次确认时配置可用；不是默认 | --dangerously-bypass-approvals-and-sandbox，需隔离核验/托管允许/显式确认；禁用隔离不足 | 未核实，禁用 |

本机设计使用能力样例manifest，plan/agent可在显式载入受限环境DEMO后演示生成参数，但不说真实OS已执行。默认isolationVerified=false、approvalTransport=false、autoVerified=false、nativeToolRestrictionsVerified=false、sandboxAvailableVerified=false；各模式解析应核对所需条件，而非默认已验证。Claude plan/agent还要求nativeToolRestrictionsVerified或已验证managed sandbox/原生allowlist；Codex plan/agent要求sandboxAvailableVerified。外层ToolGate未必能拦截原生CLI内置Bash/MCP等，不能只因前端工具开关就授予能力；缺少限制验证时拒绝，并给可操作的修复/DEMO场景入口。原生模式参数仅为部分控制，不独自承担OS隔离保证。

可通过明确DEMO环境场景模拟限制/隔离已核验，使有效与危险确认可评审；这不视为当前宿主事实。LaunchSpec必须保留nativeToolPolicy、sandboxPolicy、approvalPolicy、capabilityRevision和verificationSource。未来后端的验证状态必须来自受信SDK/宿主探测，不接受前端自报verified=true；运行前再次解析有效配置，工具调用时也要受原生/OS门禁。

### 解析与执行快照契约

resolvePermission(cliId,permissionId,capabilities,host) → {ok,cliId,permissionId,permissionRevision,argv,toolPolicy,sandboxPolicy,approvalPolicy,requirements,reason?,source:'demo'}。

buildLaunchSpec(session,capabilities)先复检installed/enabled/版本/模型协议/档位/权限/native能力/审批通道/隔离/托管限制，失败返回错误且保留草稿；成功返回{cliId,providerId,modelId,effort,permissionId,permissionRevision,argv,scope,source:'demo'}。发送把此LaunchSpec冻结在该轮消息/运行样例里，修改任何配置不得改变旧轮。UI至少可查看生成参数；仅改按钮文字不通过。

未来执行层只能接受稳定permissionId和版本，不接受用户任意argv；后端重解析并拒绝未知字段/冲突，原生参数由白名单生成，不能把用户提示词当权限。切CLI当前权限不支持必须重新选择，禁止静默升级/降级。危险确认取消不改权限，运行中不能升级；暂停不等于可安全改原生线程配置。

## 6. 修订r3：稳定核心预审后的强制条件

2026-11-19独立预审实际用Node内存边界输入复现，以下是已确认契约修正；不运行真实CLI，不开发正式软件。

1. 所有公开解析器先白名单cliId（codex/claude/grok），未知即失败，不能由else落到某个真实CLI参数。SDK支持清单和原生解析器一致，buildLaunchSpec的过滤不能代替resolvePermission自身拒绝。
2. 原生权限证据必须绑定SDK实际版本与独立sdk.capabilityRevision，例如permissionCapabilities.verifiedVersion===sdk.version且证据revision匹配。模型无effort时也要独立核对权限版本，不能靠resolveEffort碰巧拦截。SDK版本改变先使原生工具/沙箱/effort证据失效；全局供应商配置revision与SDK能力revision分开，不因其它模型开关误用版本证据。
3. Claude的--allowedTools是自动允许/免审批规则，不是可用工具白名单，不能据它宣称原生工具受限。[已实际读取的CLI官方参考](https://code.claude.com/docs/en/cli-reference.md#cli-flags)明确应以--tools限制内置工具，且该flag不影响MCP；未授权MCP还需--disallowedTools mcp__*或独立已验证MCP/OS政策。plan示例最小内置集合Read,Glob,Grep；agent示例Read,Glob,Grep,Edit,Write；生成--tools对应集合及未授权MCP拒绝，allowedTools若保留只作自动许可，不能当限制证据。所需flag/版本/目录和原生限制未核验则拒绝。Claude full只是bypass原生审批，不自动关闭OS沙箱；Codex full才明确跳过原生审批和沙箱，UI说明要逐CLI准确。
4. shared sessionBusy至少包括父running、非终结子智能体（运行/暂停待停止确认/awaiting_user等）、pendingDecision与stopPending。selectPermission/selectModel/resolve输入和发送配置都采用同一门禁；子还在跑而父running=false不能更改原配置。新建/历史仍可用，不停止旧会话。设计提供显式完成/停止子任务DEMO操作或独立已完成场景，使锁定和可配置场景都可评审，不能仅改数据逃掉门禁；停止只作用本机样例，不改项目Task或真实CLI。
5. addRequest允许同requestId且同root/owner的流式字段补全/upsert，条数始终1；相同重放不变，不同root/owner归属冲突拒绝。已知字段不同值覆盖须更高修订，否则拒绝；省略字段不抹去已知值，null→已知补全可以完成统计。跨来源部分补全必须保留字段来源或保守标mixed，不能把旧估算输入因新增实测输出变成全条实测。
6. ContextSnapshot绑定providerId/modelId/modelConfigRevision/tokenizer或计量版本/inputRevision。selectModel成功改变模型后更新新容量、递增快照修订，used/分项先失效为null并标待重估，或旧快照明确标上次模型、不能仍当当前窗口；loadScenario依据所选模型容量生成快照，不硬编码922K。contextUsage校验绑定；累计requests与总Token保持，不因换模型清历史。权限改变导致工具定义变化时也应使输入窗口快照重检。

对应UI/TEST已补以上可观察状态。主代理与制作代理在r3资源稳定后重跑边界测试和浏览器；旧r2通过不能覆盖这些反例。

## 7. 分工与验证

主代理维护CR/Story/父项/UI/契约/测试映射/总览与最终报告。设计制作代理只改当前目录ai-sidebar.js/css、新ai-session-model.js、index.html加载及README首段，新增cr019-model-test.mjs/cr019-browser-smoke.mjs与独占截图。不改app.js/scheduler.js、正式源、历史原型、旧测试或其它共享文档。

所有七项是可操作UI资源制作，不是软件开发。固定UI-CR019-v1和C19-01～10后制作，再实际逐场景打开检查、登记总览；正式软件开发未授权/未开始。主代理需读最终资源、跑模型不变量/权限解析、CR019浏览器与CR017闭环、检查截图和文档层级。CR018旧断言若与新需求冲突，只可有依据调整测试而不删安全不变量；可用新CR019替代已被新UI覆盖的名称/布局断言，并在报告说明。
