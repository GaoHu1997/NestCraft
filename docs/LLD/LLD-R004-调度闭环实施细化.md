# LLD-R004：调度闭环实施细化

- 版本：r3，2026-11-21；状态：方案独立逻辑评审通过；负责人：lead。
- 直接依据：用户“完善设计并开子智能体进行方案评审，直到通过”。仅设计与评审授权，无正式编码／软件测试／发布授权。
- 继承[调度主方案](LLD-FEAT-019-依赖调度与受管执行.md)、[CR031可靠性契约](LLD-CR031-受管执行可靠性契约.md)、[CR026执行计划](LLD-CR026-有效执行计划与能力编译.md)、[CR037协作](LLD-CR037-主代理协作契约.md)、[CR047工作包](LLD-CR047-单特性工作包与覆盖门禁.md)。本文件是上述协议的实施细化，不定义第二套运行状态或业务验收标准。
- 数据细化：[工作包与检查点](../DB/DB-CR047-工作包义务与检查点.md)；既有运行表继续以[DB-CR031](../DB/DB-CR031-事件审批与产物记录.md)为准。验证：[故障与效果评估](../Test/TEST-R004-调度闭环故障与效果评估.md)。评审：[逐轮记录](../Test/REPORT-R004-调度闭环方案评审.md)。

## 1. 评审对象和范围

本次形成可以交给各Feature独立执行上下文的技术工作包、输入输出契约、状态竞争处理、故障验收映射和效果评估协议。复用原Story／AC，不新增业务层级，不把待评审性能目标变成承诺。

架构评审通过条件：本次范围内没有未解决的P0／P1设计问题，其他必须修复的问题均有可核验修订；关键路径每项有明确所有者、输入、结果、失败出口和原AC映射。评审者可以拒绝，不按票数决定正确性，不以主代理要求“通过”为依据。真实CLI／沙箱能力、可操作UI和软件实验是实施放行门禁，尚未执行不能填通过。

本轮不改变页面交互或视觉资源，不声称UI设计完成；受影响场景继续由[UI-CR031](../UI/文档/UI-CR031-执行可靠性场景覆盖.md)和[CR047 UI缺口](LLD-CR047-单特性工作包与覆盖门禁.md#ui缺口未制作不能编码)约束。UI后续实现单独通过设计版本／状态覆盖门禁。后端纯契约工作可在另有编码授权后先开展，不借此启用缺UI审批的M1真实路径。

## 2. 权威与实施包

运行权威只有原Task→Step→Attempt→Invocation；调度器不能编辑AC，模型不能签验收。工作包是冻结来源和义务的受管记录，普通聊天不因持久化而变Task；本轮只新增业务任务工作包数据细化，普通sessionTurn既有身份／协议保持。

CR031 WP01～07是跨职责阶段，下面是其在单Feature上下文内的执行切片，不替换原里程碑：

| 切片／唯一Feature | 原Story与职责 | 允许实现位置（计划） | 输入→输出／依赖 |
| --- | --- | --- | --- |
| R4-P18／FEAT-018 | STORY-038／054／057；源清单、义务、预检、确认冻结 | 后端计划的`execution/plan`、`execution/source`及相应命令；共享迁移由本包提交自身增量 | 可信配置＋授权源＋完整AC→不可变包、Plan、授权引用；CR031 WP01/02 |
| R4-E19／FEAT-019 | STORY-040／041／058／059／068；身份、准入、领取、监督、审批、检查点 | `execution/runtime`、`execution/gateway`、`execution/store`；提取既有chat／dispatch适配经验，普通聊天迁移不得顺带改 | 已冻结包＋验证计划→持久运行、候选引用与停止／恢复证据；依赖P18与D20冻结验证契约，WP02/03/04 |
| R4-D20／FEAT-020 | STORY-042／043／055；ValidationPlan、证据、验证、有限修复、集成、报告 | `execution/validation`、`execution/delivery`；验证命令仅限冻结允许集 | 包和AC→冻结验证计划（可先于runner）；执行后候选→证据／返工请求／报告；WP05 |
| R4-C19／FEAT-019 | STORY-046；父子派发、答疑、消息消费、原产出者续接 | 原协作服务与runtime接口 | 已通过M1的执行基础＋D20的Finding→同根子调用和耐久续行；M2 |
| R4-V12／FEAT-012 | STORY-022；子代理展示与后代用量归因 | 既有chat展示及投影消费者；无调度写权 | Invocation／usage事件→准确展示；不得把UI列表作为父子状态权威；WP06适用部分 |
| R4-H11／FEAT-011 | STORY-021；交错日志、部分结果、外部投递展示 | 会话历史投影消费者 | 持久事件／capture→历史与恢复提示；不新增Task；WP06适用部分 |
| R4-G／协调集成 | 不新增Feature、不得写业务实现 | 受检产物、文档核验及授权集成验证 | 检查各包接口／证据；发现缺陷返回责任Feature，WP07 |

每包实现前另登记具体文件清单、源hash、AC范围、有效UI版本和编码授权。上表新目录是职责建议，尚不存在不冒称实现；共享schema／API必须先形成冻结契约版本，各责任包提交自己的增量，由协调者只核验，不允许多个writer同时覆盖共享文件。普通会话的F-004-01及源索引F-004-02先按原Feature复现；它们不作为本轮已修复问题。

## 3. 最小可执行路径与准入

里程碑唯一源为[CR031 M0／M1／M2](../PRD/CR-031-受管执行可靠性需求与实施分解.md#52-首版交付矩阵和审批选择)。M1目标仍是受管gateway对隔离文件有限写入，不擅自扩为任意shell／完整自主研发。

M0验证契约、临时DB和fake adapter，所有记录标fixture，不能进入真实队列。M1选择现有计划指定的首个CLI验证目标；组合实际能力未核验时保持阻塞，不以其它CLI或高权限绕过。M2a先单执行者＋已授权只读检查者；M2b再两个隔离writer和串行集成。它们只是M2的验收切片，不改其授权范围。

每次真实启动的必要门禁：

- G-AUTH：工作层级／项目／Feature／Story／文件／工具／运行模式／费用及次数上限有有效授权。
- G-SOURCE：完整义务、规则及输入源可读、有固定版本；适用UI有有效稿；重要自然语言义务经指定审阅者复核覆盖，不能靠正则自动认全。
- G-PLAN：真实不可变Plan＋工作包＋CapabilityManifest＋ValidationPlan＋授权引用同源，客户端不能自报verified。
- G-CAP：当前CLI／adapter／平台／模式／模型组合证明原生工具约束、gateway、审批请求期限、进程树停止、结果采集和必要隔离；必要能力unknown拒绝。
- G-RUN：幂等、资源、槽、根预算、源有效性及当前撤权再次校验；process supervisor已就绪，才能spawn。
- G-DELIVER：按FEAT-020全部必需当前证据／差异／适用集成通过，再交技术报告；业务验收另行记录。

参数必须在Plan冻结：最大根／子调用数、总transport retry与repair额度、执行／无输出／工具／审批／结果消费／决策等待期限、最大并发、capture上限、restartPolicy。正整数及上下界由受管服务检查，不采用“0代表无限”。审批期限不得超过已证transport可等待期限；费用未知不能承诺硬金额封顶，若授权要求硬金额限额则拒绝相应组合。心跳5秒／租约30秒仅沿原方案的待测试初值，不能用stdout自动延长业务截止时间。

## 4. 工作包编译、版本和确认竞争

预检顺序：解析完整Story/AC与适用UI／LLD／DB／AGENTS／Skill→确定性集合检查→语义覆盖审阅→可信配置解析→能力和权限交集→验证计划→Preview。Preview仅准备资料与可清理的预检草稿，无Task／执行副作用，返回previewId、requestDigest、sourceManifestHash、planHash候选、validationPlanHash、obligationManifestHash、允许执行范围、blockedReasons、expiresAt。

来源正文仍在文件；索引仅发现候选，不作为发送／恢复的版本证明。确认前由受管SourceResolver重新读取实际源，校验规范根、稳定文件身份和正文hash，准备不可变快照；文件读取／hash不在DB写事务内。源在读取过程中变动则重试有限次数后SOURCE_UNSTABLE，缺源或权限不足拒绝。所有确认的字节必须与封存快照一致。

不能承诺文件系统与DB原子。SourceResolver先根据授权根、写范围与适用规则发现规则计算保留范围，再取得该范围的命名空间／目录成员保留，最后在保留内重新枚举、读取并封存来源。保留证明包含discoveryRevision、目录身份、适用规则候选路径集合、已存在源、必需的不存在性事实及scope hash；必须同时禁止会影响集合的新增／删除／移动／父目录替换，以及既有文件写入／替换。仅锁已打开文件、异步watcher或合作式应用锁均不足以标currentReserved。保留以规范路径顺序获取，冲突全量释放后有限重试；保留内复枚举与预检不同则SOURCE_CHANGED，不边改集合边确认。确认临界区保持到受管事务提交相同sourceManifestHash才释放。无法提供集合保护的来源只能作为明确授权的固定快照输入，不能被标成“当前实时源已锁定”；若原任务／规则要求当前源强一致则CAPABILITY_UNVERIFIED，不自动降为快照。远端源仅接受明确授权不可变版本，不以网页URL当版本。

提交前重查权限修订、Preview有效期、依赖和完整义务清单；同事务写scope快照、包、Plan／验证引用、确认授权、业务Task和receipt。领取时才创建根Attempt／Invocation和租约；**预检／确认不spawn，也不抢先建立第二根Attempt**。随后启动／工具动作／恢复／发布均重检适用源；缓存只能复用相同修订与权限的已封存字节。每Plan冻结完整sourceSubsetHash及规范scope依赖，变化按[DB-CR047§2.1](../DB/DB-CR047-工作包义务与检查点.md#21-同包局部失效)传播到相交Plan／证据／实际消费链：局部A变化不使同包独立B更换冻结引用或误停；根规则与共享源作用于全部依赖者，影响不明按共享处理。confirmed包不是当前有效性的证明；先停受影响writer再重新预检，不用原计划替换hash。源变化的重确认固定走[DB-CR047§2.2](../DB/DB-CR047-工作包义务与检查点.md#22-源变更重确认关联新批次和替代task)：Preview明确展示旧任务终结与新任务范围、替代来源和累计剩余预算；停树／effects确认后同事务终结旧受影响Task、创建关联新批次及替代Task／新快照。未受影响Story只作为新包deferred引用，仍在原批次运行，不重复创建。任务替代不重置原预算和计数，范围／AC／额度变化均需相应真实确认，不能修改不可变快照绕唯一键。

为了避免将版本校验窗口说成全时保证，动作前同样取得适用源读保留和目标身份校验，在动作提交／作用期间维持；长运行无需长时间锁全部源，源变化后阻断后续受管作用。不能提供受管旁路控制时，不承诺这项强保证并拒绝所需组合。

## 5. 命令契约和事务边界

沿现有命令语义，以下是逻辑接口，不擅自注册第二套公开工具。所有请求包含schemaVersion、requestId、projectId、expectedRevision及受管认证主体，digest用规范JSON和明确hash版本生成；秘密只用引用。相同幂等键不同digest返回IDEMPOTENCY_CONFLICT。

| 操作 | 核心输入／结果 | 原子记录与失败出口 |
| --- | --- | --- |
| plan.preview | scope、workLevel、候选组合、源引用、预算请求→Preview | 不创建执行；缺项列明确错误，非空建议不等授权 |
| plan.confirm | previewId／expectedHashes／confirmationRef→Task／Plan／receipt引用 | 源读保留＋当前权限＋同事务确认；过期／变更拒绝，不按新默认悄重算 |
| invocation.delegate | 父binding、childRequestId、子目标／源／范围／结果要求／组合→child binding／Plan／Job | 父有效、缩权、同Feature、根ledger预留、资源claim、调用上限一起验证；不递增Task fence |
| task.control | Task／Invocation目标、pause或cancel、expectedRevision→controlReceipt／stopPending | 先封锁新作用／取消待批／停止代次，再停止整树；无停止证据不得释放资源 |
| result.submit | binding、sealed manifest引用、输入hash→candidate receipt | 文件已封存才登记；错误结构有限修复，旧代次只归档；不直接succeeded |
| child.result.consume | 内部receiptId／当前父代次→accepted／blocked／archivedOnly | receipt accepted与父待续行意图同事务；UI在线与否无关 |
| review.requestRepair | Finding引用／testedRevision／requestId→repair引用或拒绝 | 校验实际消费、原产出者、同根预算、旧树已停；verifier／环境错误不触发代码返工 |
| task.recovery_resume | 原Task／检查点／源与计划预期版本→重检结果 | 未知作用／旧树未停／源失效拒绝；恢复通知不重跑已完成子命令 |

命令回执持久保存原接纳／拒绝结果，重试只重放回执。被拒请求在条件修好后要发新requestId，旧同ID不能由rejected变accepted。UI与模型不能自报actor、状态、passed或更改finalArgsHash。起进程前写launch intent和唯一身份；spawn后登记失败由监督器停止整树并对账，不能把数据库失败当没执行。

## 6. 子调用排队、投递与停止竞争

### 6.1 有限调度与作用域

父可以停在waiting，等待子仍不等执行静止。同Task子调用沿父根Attempt／fence，独立Invocation／generation／Job；跨业务Task走既有显式派发，跨Feature进入独立上下文，不能通过childRequest隐式扩范围。

子派发幂等采用父InvocationId＋parentGeneration＋childRequestId，消耗根的maxChildInvocations总额度（重试／返工也计入，另保总repair计数）。超限拒绝且不生成占位运行。首版不启用子再递归委派，子Plan不含delegate能力；未来放开须新方案／授权，不靠默认深度无限递归。

资源不足时Job可queued、Invocation为admitted，不提前领取物理写claim／槽；先保存待执行请求与预算预留，到实际领取时同事务获取全部claim／槽并重检权限。排队有冻结deadline，到期blocked并按实际未执行证据释放预留，不释放父activeKey。父持根资源锁是容器所有权，父自身写入仍需不与子claim冲突。

容量分两类，均沿原execution_slot按scopeKey区分：modelCallSlot限制正在执行的父／子／模型检查调用，liveProcessSlot限制仍存活的受管进程树根（每树内部进程数另由监督器上限控制）。普通waiting标签不能释放任何槽。仅当父轮已结束且CLI已退出，或适配器提供可核验停驻证据（禁止生成／工具／自动续行）时，才能释放modelCallSlot；停驻CLI仍占liveProcessSlot，stopPending未证停止同样占用。同步父等子时须预留父存活容量和子需要容量；无法证明停驻或容量不足的同步组合准入拒绝。可用的顺序模式必须先结束父轮并确认进程退出，再执行子，父恢复重新领取两类所需槽。等待中新输入只持久排队，经相同领取复检后执行，不穿透子占用。Plan冻结两类容量和停驻能力，不把原maxConcurrency语义偷偷改成无限存活进程。

### 6.2 耐久续行与合并

内部child receipt已由DB-CR031定义。结果封存＋终结事件＋child receipt＋外部outbox同事务；内部消费校验manifest和输入修订后，写父待续行意图与accepted同事务。父的活动修订和stopGeneration作为CAS前提。

待续行意图存既有execution_job，kind扩展`continuation`。Job所属Invocation就是被续行的父P，完整Binding复制P；Binding的parentInvocationId仍表示P的直接父（P是根时为null）。续行目标另用targetInvocationId=P、targetGeneration，绝不复用parentInvocationId。新增expectedActivityRevision、cohortRevision、continuationKey、deadline等控制字段；领取关联claimedCommandReceiptId（FK到execution_command_receipt），不使用不明Run引用。父的每次模型轮次新建command receipt和实际process记录，沿P的Invocation／generation及根Attempt／fence，不造第二根；原生线程是否续接由适配器确认。普通sessionTurn同样沿其根身份，不造Task。

queued且未领取的同父意图可合并receipt集合并增加cohortRevision；领取时封存输入，后来结果进入下一意图。receipt只有一个同父generation的有效意图归属，实际消费与分配分开持久记录。父活跃时只登记，不启动第二父模型调用。父提示结束后按Plan／预算／源／停止代次和两类容量复检。

活动修订变化返回STALE_ACTIVITY并进入事务重评，不永久空转CAS：重新读取当前父轮、用户输入、source／Plan及待消费集合；同generation且新输入没有取消／取代该结果时，生成重评记录和新的输入清单，在同事务更新queued意图expectedActivityRevision／cohortRevision，再正常竞争领取。新输入明确取代／取消时，以对应受权command receipt为依据归档；若新轮已经消费，必须有input-consumption关联才标consumed，不能凭文本推测。源／授权改变或语义是否仍适用不明时blocked，保留accepted结果并等待受权决定。领取后不能改输入；前一轮结束时已排下一意图也走此重评，避免活动修订变化丢结果。

子结果是否valid与是否delivered分开；内部消费失败到deadline后RESULT_DELIVERY_BLOCKED，executionSettled可true但业务gate不通过。重试消费只处理原结果，不重新启动子工作。

### 6.3 控制优先

停止事务先提升控制代次、禁止新claim／作用、取消未消费审批、使未领取续行意图归档，再请求监督器停树。并发的领取／结果／审批消费均检查同一当前代次，败者拒绝或归档。已经领取但尚未spawn的意图在spawn前复检；已spawn则纳入停止集合。task_control被接纳不是停止完成，停止后保持stopPending直到已证无writer。

恢复时重新识别pid＋startIdentity＋runnerEpoch＋treeId，对账effects和续行意图。无法判断某次父续行是否已发出时标unknown并停止接管，不把新invocationId当避免重复的办法。新Attempt／fence不能直接领取旧意图：旧Job／receipt保历史，按[DB-CR047§5.1](../DB/DB-CR047-工作包义务与检查点.md#51-根恢复后的显式成果承接)重验封存结果和当前授权／源／基线，为新根建立带来源的recovery input与新续行意图。导入只是只读输入准入，不自动继承旧verified／审批／lease，不重跑已完成子命令；输入已失效则明确重验或返工。原Task预算和operation guard跨恢复保持，不能靠导入或换ID重复应用作用。pause保activeKey；cancel只有整树停止／对账／清理后才能终态释放。只读检查也要真实工具限制，不能依赖提示词。

## 7. 验证与返工的闭环责任

D20在执行前编译ValidationPlan，每个必需义务对应验证方法、环境、输入、证据和判定；人工／模型／builtin明确选定并计入预算。缺可用验证者则阻塞相应范围，不临时增加付费模型。

CLI结束转验证。schema合法只表示结果可读，verifier还检查产物存在、允许范围、修订、必需证据和适用集成。候选失败先分类candidate_defect／verifier_error／environment_error／source_changed／authorization_error；只有第一类且有证据、预算和轮次才定向修复。schema repair、implementation repair、rule repair沿原总repair额度分项计数；transport retry不伪装返工，但都消耗总预算。

返工绑定testedRevision→resultManifest→producerInvocation→受管原生绑定；同Task子返工新Invocation，根Attempt不变；根返工新Attempt且先停整树。旧原生引用不兼容时仅按冻结fresh策略重建或阻塞。新修订显式使相关证据和消费者失效；独立兄弟保留。检查者不可直接写产物、审批工具或代业务验收。

串行集成严格复用FEAT-020的目标HEAD CAS、受管候选分支、集成回归及verifiedBaseline发布。没有集成授权只交独立成果；测试通过但无法集成不假交付整体成功。文档写回只走原CAS outbox，技术报告到待验收，不自改原AC或Feature完成。

## 8. 效果评估：离线实验而非自学习路由

首版运行路由只采用已确认规则；历史收益仅生成建议，不参与自动切换或预算提升。实验配置、逐次观测、分组报告均为受管报告文件及原report/capture引用，不新增生产路由评分表。无业务Task的研究试验只放隔离实验目录，不伪造生产Task／费用账单。

采用相同任务快照、允许模型集合、环境、验证器和全组预算比较A单执行者、B执行＋只读检查、C受限并行。初步30个任务分6类、每组每任务3次只是先导实验设计；运行前必须另冻结具体taskSetHash、种子／顺序、预算数值和独立验收者。运行前固定全部计划task×repeat集合。预算约束交付率=该集合内验收成功次数／计划总次数，因策略预算耗尽未开始的项计未交付；质量非退化与策略采用只能比较这个相同预注册集合。另报已开始样本的条件成功率用于诊断，不拿它替代前者。外部取消／基础设施整体故障按预注册规则将匹配的整个比较块标不可判定并保留原记录，重新比较须所有策略重跑同块且另计成本，禁止择优删掉单策略失败。全组预算不足以完成全部样本也不能只挑成功任务补齐；已开始、未开始及原因全部报告。

全任务成功率与逐AC通过率分别报告；每成功任务成本为组内全部开销／真实验收成功数（零成功不生成有效比值）。usage缺失标unknown，该组金额比较不可判定，不按0补齐；排队、执行、审批、人类等待分别报告，总时延包含全部等待。恢复分安全继续、正确阻塞、违规重放。禁止用平均值掩盖共享文件／串行类退化。

先导实验只产出效果建议。扩大并发的证据门禁：故障集零错误放行／零违规重放，任务成功率不退化且同类别成本或时延有可复现改善；具体统计阈值和改善幅度在正式比较前冻结，不在看到结果后调整，也不保证30个样本足以证明。未冻结门槛或样本不足只能报描述性结果，不自动变产品策略。

## 9. 实施阻断项与退出条件

| 门禁／责任 | 当前事实 | 如何关闭 |
| --- | --- | --- |
| G-CODE／用户授权 | 本轮无正式编码授权 | 后续明确授权相应Feature及允许文件；本次评审不代签 |
| G-CLI／E19 | 首组合受管写入／整树停止／隔离未实证 | 隔离测试按矩阵取得verified证据；未知拒绝 |
| G-UI／各页面责任Feature | C31-01～06及完整CR047覆盖仍有可视缺口 | 在唯一原型内补有效版本、实际检查和总览登记，含UI-SCROLL-001 |
| G-MIGRATION／数据责任包 | execution_*草案未实施，现有execution_session_turn已有普通续接用途 | 读取真实schema并明确兼容映射／版本，不直接覆盖同名表；副本迁移、FK、旧数据保护、恢复证据 |
| G-EVAL／D20 | 没有真实效果基线或统计阈值 | 单独授权实验、冻结参数、完成逐次记录后再评估 |

这些是外部或实施门禁，不能用“有条件通过”把本次内部设计缺陷隐藏为门禁。本次评审通过只关闭本文件及配套数据／测试设计的逻辑问题；以上门禁保持未通过。实施可先做已授权的M0，不允许据文档直接开启M1／M2。
