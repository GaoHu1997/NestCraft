# LLD-CR026：有效执行计划与能力编译

## 当前采用 UI-CR026-v4（CR035新壳集成）

并行CR035把公共入口切换到workbench-v4后，本轮保留新壳，不回退导航。当前运行资源为workbench-v4/execution-plan-model.js与execution-closure.js/css；直接读取该壳既有DEMO.settings，Run仍写既有DEMO.tasks，不引入第二任务或可编辑库存。旧task-workbench里的13组端到端/95原状态机属于切换前已验证历史，不代替当前稿。

当前原型实测12/12闭环：设置→明确DEMO配置→就绪需求预检→冻结Run→改默认不改旧值→工具撤权/越界拒绝→失败与fresh保预算→新组合再授权关联旧Run→独立只读phase→交付与明确验收。当前模型42/42；无真实CLI/SDK/软件/OS隔离执行。当前记录见[REPORT-CR026](../Test/REPORT-CR026-执行计划闭环设计验证.md)，截图为cr026-v4-*。

操作：[打开唯一原型](../UI/仿真原型UI.html)→打开预约服务→需求页下方“载入独立执行计划DEMO”→“派发闭环样例”；设置页底部“任务执行配置”修改现有Agent默认/Tool/Skill/MCP。旧展示Run没有历史Plan则明确缺失，不用当前默认补造。阶段推进是明确离线仿真按钮，不宣称后台真实执行；真实产物验证/进程监督/自动子委派仍待正式实现。


- 关联[CR026](../PRD/CR-026-统一任务执行计划与能力闭环.md)、STORY057～059、原FEAT018/019/020；仅需求与可操作设计，正式软件/DB/CLI未修改。
- UI规范单独定义视觉，不让本方案反覆盖CR019/023与用户导航。公开入口为docs/UI/仿真原型UI.html，内部资源不变。

## 1. 架构与唯一来源

ConfigCatalog是逻辑统一目录，不是另建可编辑库存。现管理SdkCatalogue/management.profiles、供应商模型编辑目录、Tools/Skills/MCP/知识授权各保留唯一编辑权威；ConfigBroker按稳定ID规范化只读快照。AI模型旧M.providers不再与供应商设置形成独立长期来源：读取供应商目录，通过明确迁移/alias记录保持历史引用，不静默替换用户已选模型。无法映射显示失效待重选，现记录和草稿不删除。

TaskPolicyResolver输入任务覆盖/模板/项目默认/当前工作层级和授权/ConfigBroker快照，返回逐字段来源和ready/blocked/needsConfirmation。PolicyCompiler把允许能力编译成CLI原生/宿主工具/MCP/文件网络策略；runner未来只按不可变Plan执行并进行撤权复检。Task/Run执行权威继续原模型，Markdown是需求正文权威；会话Todo/Goal不是业务验收。

## 2. 数据与优先级

AgentTemplateRef：id/revision/cliId/defaultModelRef/defaultEffort/permissionIntent/allowedCapabilities/requiredSkills/mcpToolRefs/workScopes/routeTypes/minDifficulty；当前CLI四卡是默认执行模板，不等于只有四个Agent身份；未来多角色模板可复用同一CLI，但本轮不擅加新Agent Gallery。

TaskExecutionRequest：taskId/storyId/workLevel/workKind/difficulty/source/manualOrAuto/templateRef?/explicitOverrides/requiredCapabilities/requiredSkills/requiredMcpTools/projectRef/requirementDesignAcHashes。

ConfigCatalogSnapshot：revision/contentFingerprint/sdkEntries/providerModels/tools/skills/mcpServices+discoveredTools/knowledgeGrants/runtimeEntries/policies。每实体stableId/revision/source/capabilityEvidence，启用不等于已验证；凭据只有secretRef。

ExecutionPlan：id/revision/hash/source:'demo'|真实受管来源、taskId/phase/selectedExecutor{kind:cli|builtin|human,cliId?,sdkVersion,adapterVersion,runtimeId}/model{providerId,modelId,remoteModelId,protocol,effort,nativeMapping}/permission{intent,effective,nativeArgs,toolPolicy,fsPolicy,networkPolicy,approvalPolicy}/allowedTools/skills{contentHash,attachmentsHash}/mcpTools{serviceRef,toolRef,schemaHash}/knowledgeGrantRefs/workspaceRefs/budget/retryPolicy/acceptancePolicy/fieldOrigins/configSnapshotRefs/authorizationRefs/blockedReasons。

逐字段优先级：Task明确覆盖 > Template默认 > Project默认 > 已确认System默认；每一inherit必须继续解析，找不到就blocked。权限和能力的‘请求值’不等于最终值：组织/项目/模板可用能力上限/用户本批授权/Runtime与adapter证据共同裁剪，只允许交集。必要能力被裁掉阻塞而非静默降级任务目标。

显式CLI不可用不自动换；自动模式可按事前允许的回退和门槛选择内置/主代理，但结果必须预检确认。内置通道不可用也阻塞，不把未集成DSH假成可运行。工作类型由任务明确字段或待确认语义建议给出，关键词只是建议来源不是授权。

## 3. Model与Runtime解析

原生型号remoteModelId与界面名分开，兼容协议、启用端点/凭据引用范围、model/effort/服务档位支持须通过当前SDK/Runtime证据。模型无effort不跳过权限版本验证。不能清无效档位默认回落。身份Access控制‘谁能触发’，不等于文件/shell/MCP操作权限。

Runtime选择在确认前确定ID及范围/平台/运行模式；离线可等同绑定Runtime恢复，不能悄转机器。要求真正隔离但无法证明则阻塞，不把工作目录/worktree/HOME隔离当安全边界。默认不继承未审的原生CLI全局配置/环境MCP；短期独立配置与最小secretRefs由runner受控注入，日志脱敏。

## 4. 能力编译

- Host Tool：具体toolId/schemaHash+参数策略。每次校验scope、path、network、effect风险和当前撤权，不支持只名白名单无限shell。
- CLI built-ins：经版本证据生成可用工具集合与路径/网络控制。Claude --tools限制内置，--allowedTools只免审批，MCP另控；Codex原生沙箱和审批策略需平台证明。Grok未证组合不放行。
- Skill：固定SKILL正文和附件hash、source/revision/requiredCapabilities。内容是方法/上下文不是授权，不信由文本请求自动提权；必需工具缺失阻塞。
- MCP：只所选服务内已发现且准许的精确工具。托管gateway只暴露计划白名单，阻断未审的本机MCP merge/默认继承；单靠strict配置也不等价安全策略。每call验证工具、参数、当前授权，未知discovery/schema拒绝。
- Knowledge：按项目grant访问精确文档范围，冻结引用不恢复已撤销权限，shell/fs旁路必须被实际隔离政策拦住。

工具允许范围最大是用户/项目/组织授权，子计划还与父有效能力及剩余预算交集。每个子任务单独Plan和计量归属，父等待子结果与验证完成，不能仅父主线程结束就交付。

## 5. 确认、冻结、重试和交接

预检只生成Preview，显示具体配置/来源/裁剪/阻塞原因；确认重读配置、授权及需求基线hash防竞态，原子记录Plan+授权+Run，幂等相同输入复用不同输入拒绝。正式hash服务端SHA256/CAS，DEMO指纹只能做一致性比较，不声称客户端安全签名。

Run及每Attempt保存PlanRef/planHash/capabilityManifestHash；领取/启动/每工具调用还复查撤权与失效，不把当前默认配置覆盖旧Plan。修复暂态且原计划仍获授权可原Plan retry；fresh只重建上下文，不修改配置/预算。更换SDK/model/runtime/权限/skills属于新计划再预检并link sourceRun，不伪造跨CLI原生session续接。

阶段交接单独PhasePlan，默认只读评审不继承开发写权限。原进程stopPending/cleanup未知保持写锁，不启动新writer。凭新显式重试也不能绕无法证明旧进程停止的限制。

原Task状态/DAG/有效产物门槛继续；wakeups或子关闭只能触发复检，不直接当依赖成功。交付携带每Run/phase/工具策略与产物证据来源，当前有效AC/设计/产物才能验收；技术结束、验收完成、发布分开。

## 6. 原型接入与边界

新增纯设计execution-plan-model.js与task-execution-design.js/css，接到原需求预检/Task详情/Retry/Handoff/交付而不另造任务状态岛。原scheduler可接受resolvedPlan字段并冻结到原Task/Attempt，原app预检从ConfigBroker读取用户管理目录；原Task/Run remains state authority，不额外可编辑requirements。

管理CLI/SDK仍2tabs；必要默认能力范围在现卡下扩展，不自由重做。现供应商/能力界面编辑及时影响新Plan，旧已确认Run则保留冻结值；预检/任务页面提供改配置来源返回路径。

设计DEMO可使用明确虚构/截图源的目录与验证证据，但不得把启用/版本样例标实测。本轮NativeLaunchSpec只展示不spawn、不读生产secret，不执行真实SDK/HTTP/SSH/Git。测试只设计模型和浏览器，不软件构建。

## 7. 正式实施顺序（未授权，不执行）

先ConfigBroker/只读Resolver与Schema → 原子预检确认及不可变Plan存储 → 单执行器适配/能力网关 → Run/attempt冻结和撤权 → 受控子委派/阶段交接 → 产物验证/交付/恢复。每阶段明确代码授权后按已确认UI实现，不凭设计验收自动编码。

复用DB-FEAT019 task/batch/attempt/locks/outbox，新增ExecutionPlan/PlanOrigin/CapabilityManifest/AuthorizationRef/PhasePlanRef，不迁移当前库。权限源在可信服务端，不接受客户端自报verified=true或任意argv。

## CR-026本轮设计闭环交付

原型接口已落地：TaskExecutionCatalog.snapshot从现管理/供应商/能力读取，显式loadDemo只添加缺失示例不覆用户草稿；TaskExecutionPlanModel解析/冻结/参数与当前撤权验证；原Scheduler.preflight/dispatch将Plan置原frozen，Attempt记录planRef/hash；retryTask保原计划/预算；approveExecutionPlan确认后记录planHistory并在新Attempt引用activeExecutionPlan；executeReviewPlan在当前有效产物上生成独立只读phaseRun，业务仍待验收。

真实CLI适配/OS隔离/秘密注入/后台进程停止/可信SHA-CAS未实施。原型FNV仅一致性检测，不能当授权安全签名。默认内部子委派关闭；父能力交集和剩余预算已有模型验证，但不声称自动子代理真实运行。原S的demo.integrate是平台验证/集成步骤授权，不等于给CLI开放任意git工具；CLI工具计划与平台集成门槛分开。
