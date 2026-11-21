# DB-CR047：工作包义务与检查点

- 版本：r3，2026-11-21；状态：方案独立逻辑评审通过，未迁移／未读写真实数据库。
- 来源：[CR047工作包](../LLD/LLD-CR047-单特性工作包与覆盖门禁.md)，承接[调度闭环细化](../LLD/LLD-R004-调度闭环实施细化.md)。复用[DB-FEAT019](DB-FEAT-019-任务执行数据设计.md)与[DB-CR031](DB-CR031-事件审批与产物记录.md)。
- 范围：业务任务工作包／义务、外部检查点和父续行意图的逻辑数据增量。普通sessionTurn不强加业务Feature、Story、AC；本次不新增生产效果评分库。

## 1. 权威和通用约束

源正文、完整义务清单、检查点与报告使用受管不可变文件；DB存身份、版本、有限清单、引用／hash及当前有效性。文件／DB采用CR031 file_commit封存协议，不能把未登记孤儿文件交给下游。Markdown仍为需求权威，数据库包不是第二可编辑需求正文。

每表含projectId，复合FK限定项目和归属；逻辑ID可跨版本复用但每修订不可覆盖。hash带算法版本，unknown为NULL＋原因。源文件删除不级联删除历史。实体引用采用RESTRICT／归档；大正文不塞metadata。以下新增表名、字段是待实现契约，物理schema版本须读取真实迁移登记后分配。

## 2. WorkPackage与ObligationManifest

| 记录 | 字段与约束 |
| --- | --- |
| execution_work_package | id、revision、projectId、batchId、featureId、workLevel、scopeManifestUri/hash、sourceManifestUri/hash、obligationManifestUri/hash、validationPlanUri/hash、authorizationRef、packageHash、state prepared/confirmed/invalidated/archived、invalidatedReason、createdAt；PK(id,revision)，UNIQUE(projectId,packageHash) |
| execution_work_package_story | packageId/revision/projectId、storyId、featureId、requirementSnapshotId、sourceHash、scopeDisposition execute/deferred/cancelled/notReady、reasonRef；PK(packageId,revision,storyId)，snapshot通过同project／batch／story复合FK定位execution_requirement_snapshot；story归属由源快照确认，不能仅信索引 |
| execution_obligation | packageId/revision/projectId、obligationId、ownerStoryId、kind ac/ui/lld/db/rule/boundary、sourceLocator、sourceHash、applicability required/optional/notApplicable、applicabilityBasisRef、methodRef、manifestItemHash；PK(packageId,revision,obligationId)，同包Story复合FK；notApplicable必须来源允许及理由 |
| execution_obligation_mapping | packageId/revision/projectId、obligationId、taskId、implementationRef可空、validationItemId、mappingHash；PK(packageId,revision,obligationId,taskId,validationItemId)，任务与包同Feature／Story，禁止跨包AC充数 |
| execution_source_binding | packageId/revision/projectId、sourceId、kind、canonicalLocator、fileIdentity、contentHash、sourceRevision可空、snapshotUri/hash、scopeManifestHash、readStatus、consistencyMode pinnedSnapshot/currentReserved、observedAt；PK(packageId,revision,sourceId)；只存可信SourceResolver产生的事实 |
| execution_source_validation | id/projectId、packageId/revision、binding可空、phase confirm/start/effect/resume/publish、manifestHash、reservationEvidenceUri/hash可空、outcome passed/changed/missing/unstable/denied/unsupported、checkedAt；非运行确认可无binding，运行时完整binding，历史append-only |

包内容和源清单不可原地更新，只有state／失效原因随事件更新。confirmed表示曾完整冻结，不代表所有派生Plan当前仍有效；包结构／身份／封存完整性损坏或共同授权撤销才整包invalidated且不可转回confirmed。单个局部源变化按§2.1使相交Plan失效并为受影响工作生成新包修订，不把整包全部Plan一律失效。包级source manifest只聚合精确来源，不伪装单Story requirement snapshot；每个包Story行各有同batch的单Story快照。确认事务校验包Story集合及全部快照同Feature并完整写引用才可confirmed。Task.snapshotId必须等于对应execute行的requirementSnapshotId，增加该复合候选键及FK；deferred／cancelled／notReady也保留来源快照但不创建Task。报告解释未执行义务，不声称全部Feature完成。

coverage是投影：从完整义务集合、映射、当前有效evidence计算，不在obligation行另存一个可编辑passed。必需且允许执行的义务缺method／task映射拒绝ready；自然语言义务完整性另有审阅依据，不以字段齐全冒充语义完整。

## 2.1 同包局部失效

`execution_namespace_fact`是冻结的发现事实，不是当前锁：projectId、packageId/revision、namespaceFactId、kind absentPath/directoryMembership、canonicalScope、directoryIdentity、candidateRelativePath可空、membersManifestUri/hash可空、factHash、discoveryRevision、observedAt；PK(projectId,packageId,packageRevision,namespaceFactId)，FK到同包。absentPath必须有候选路径且事实标不存在；directoryMembership必须有成员manifest，均由可信Resolver生成，源不稳定不得登记confirmed包。事实正文／成员清单采用§5.2 workPackage组件`namespaceManifest`封存，component+sourceId（namespaceFactId）固定归属。source_dependency两种来源分别设置显式复合FK：sourceId→execution_source_binding同包候选键，namespaceFactId→本表主键，CHECK恰一非空；expectedHash必须在事务内匹配受检源contentHash或factHash。

namespaceFactId在同包修订内稳定且不可变，事实改变新包修订／新事实，不覆盖旧行。临时reservation evidence只证明某次临界区保留范围和期间，引用这组冻结事实hash与发现版本；不能把外部证据JSON当FK目标或把旧不存在性事实当当前锁。新增规则通过规范scope／候选路径查受影响namespace依赖，随后原Plan失效。sourceSubsetHash规范化包含factId、包修订、kind、scope、directoryIdentity、发现版本、factHash及受检manifestHash；确认／启动／作用前服务端重检事实确属本Plan适用路径与义务。FK仅证明记录存在和同包，不代替scope适用性；未知ID、跨包／旧修订／错scope／hash不符均拒绝，不能因同包另有一个合法事实而替换。

新增`execution_plan_source_dependency`：projectId、planId/revision、packageId/revision、dependencyId、sourceId可空、namespaceFactId可空（恰一来源）、obligationIdsManifestUri/hash、normalizedScopeManifestUri/hash、impactKind local/shared、expectedHash、validity current/invalidated、reason/eventId。PK(planId,planRevision,dependencyId)，复合FK确保引用该包来源或其命名空间不存在性事实；每个Plan在确认时冻结完整实际必需源及依赖集合，sourceSubsetHash写入Plan。完整性审阅验证不能漏依赖，无法确定影响范围按shared处理，不猜测不相关。

变更以规范目录段／文件身份／义务归属与计划读写作用域相交计算：局部A规则或A专属设计只失效引用A或范围相交的Plan；根规则、共享接口／共同设计／权限变更影响全部实际依赖者。发现新增规则按namespaceFact作用域计算，不能仅按旧sourceId查。失效事务写dependency validity、原Plan失效事件及相交证据／消费链失效；运行者安全停止。未受影响B维持原Plan／包revision与hash，不偷偷换引用；其来源和集合保护、授权、依赖产物仍须在每次准入复检。B消费过A产物时不再是独立者，按消费链失效。

包状态与Plan有效性正交：不以package.state=confirmed直接放行，必须全部必需dependency current和原G-PLAN等门禁通过。源A改变后的新工作使用新包修订；旧包仍作为B的合法冻结来源及历史。整包结构／共同授权失效则所有Plan均失效。

## 2.2 源变更重确认：关联新批次和替代Task

明确选择**新批次＋替代Task**，不修改DB-FEAT019中UNIQUE(batchId,storyId)、Task.snapshotId和快照不可变原则。W/r1属于X，A变化时B继续原X/旧Plan；重确认创建新批次Y及W/r2，只有受影响且新获授权的A为execute，B在新包为deferred并引用existingTaskId=B1（同项目／Feature／Story复核），绝不再建B Task。新批次为各包Story创建自己的快照SA2/SB2，保留旧SA1/SB1；新Task A2绑定Y/SA2，旧A1不换snapshot。旧已封产物可显式按受权输入导入，但不自动继承验收。

新增`execution_task_replacement`：id/projectId、sourceTaskId、targetTaskId、sourceBatchId、targetBatchId、sourcePackageId/revision、targetPackageId/revision、requestId/digest、authorizationRef、budgetRootTaskId、reason sourceChanged、createdAt；UNIQUE(projectId,sourceTaskId)，UNIQUE(projectId,targetTaskId)，同request幂等键＋digest，复合FK核对同项目／Feature／Story且旧新batch不同，替代链严格无环。重复重确认返回同一替代关系；目标再变化只能从当前target创建下一关系，不从同旧Task分叉两次。包Story增加existingTaskId可空，同包execute要求为空，deferred且因已有任务排除时必填并验证身份。

重确认接纳前：旧A1置可恢复blocked并保activeKey→停止所有旧writer、取消待审／续行、对账effects和资源→新Preview与源保留就绪→短事务CAS旧Task修订／停止确认／effects已确定、重查新授权与剩余预算→将A1终结cancelled(reason=supersededByReconfirmation)、activeKey释放并记录替代关系→创建Y/W2/新快照/Plan/A2及receipt。上述DB变化同事务提交；失败全部回滚，旧A1仍blocked且不可重派。未知作用或旧writer未停拒绝，不能依靠新baseline不同绕开旧任务保护。取消仅指旧执行任务，不取消业务Story。B既有状态／计划／工作区不变，若存在A产物消费依赖则B也属于受影响集合，不能列为独立B。

预算沿原逻辑工作链：execution_task新增budgetRootTaskId（首次Task指自身，替代Task沿最初源，延后FK同事务），原ledger的rootBudgetRef保持同一逻辑预算根；剩余额度按原已消费＋预留＋未知计量核算，repair／retry／子调用总计数也不清零。新授权仅确认变化范围，不默认新增额度；若用户显式追加额度，记录独立授权与额度调整事件，历史已用仍计入累计。未知计量继续按原硬限额策略阻塞，不从新Task账面0推余额。

原批次X按历史A1取消和B实际状态聚合，新批次Y只聚合A2；报告显示替代关系和当前有效范围，不把A1与A2重复算两次成功，也不提前把B算成Y成果。业务Story／Feature完成仍依当前有效证据和真实验收。全包结构损坏不能走局部替代路径直接保其它Plan，须先验证共同基线。

## 3. 绑定到既有身份

ExecutionPlan增加workPackageId/revision/hash、obligationManifestHash、validationPlanHash。ExecutionTask保持原snapshotId，不新增第二Task；增加workPackageRef后检查task.storyId包含在同包execute集合且同feature。多个Story可共用一个Feature包，但根Task依旧各有Attempt／fence；同Task子Plan只能缩小原包的允许范围，不能修改父包或新建业务Story。

执行Session增加完整ScopeBinding引用，executor只能绑定一个Feature；普通聊天保持原role和nullable Feature。reviewer／integrator权限分别来自PhasePlan，不能改role获得写权。现有session列兼容映射由真实schema核对，不能重建session丢历史。

冻结确认时：SourceResolver获得来源读保留／封存证明→短事务校验授权修订／expectedPreviewHash→写snapshot、package、Plan、ValidationPlan引用、授权确认、Task、receipt／事件→commit后释放来源保留；进程启动由后续领取负责。文件封存与DB不跨介质原子；失败留下file_commit待对账，不启动Task。

## 4. 外部检查点

复用execution_checkpoint，不新增记忆库。补充workPackageRef/hash、obligationManifestHash、planHash、validationPlanHash、rootInvocationId、invocationId、invocationGeneration、parentGeneration、executionFence、stopGeneration、lastCommittedProjectSeq、sourceManifestHash、artifactManifestHash、evidenceManifestHash、pendingActionsManifestHash、unknownEffectIds、worktreeIdentity、headRevision、dirtyDiffUri/hash、checkpointUri/hash、fileState、createdAt。

子检查点按invocation+generation定位，taskId／attemptId仍指根来源。新增UNIQUE(projectId,invocationId,invocationGeneration,checkpointOrdinal)，序号由事务分配，不用timestamp唯一；dirtyDiff既保存可重检摘要又封存必要补丁清单，不能只有模型摘要。已做／待做／失败／未验证义务、完整输入和待处理消息引用放检查点文件。

恢复对照当前源、包与授权、旧writer停止证据、工作区／HEAD／dirty diff、effect、待续行意图、证据版本。不能把检查点中的lease或批准恢复为当前有效；新尝试按原协议分配身份。缺文件／hash错误／未知作用不得标恢复成功，保留旧记录。

## 5. 续行意图对原Job的增量

沿DB-CR031 execution_job扩展kind=`continuation`，沿用Job状态queued/running/stopping/succeeded/failed/cancelled/interrupted/blocked。无进程只表示内部待续行工作，不虚构process行。

Job所属Invocation为目标父P，沿P完整Binding；其中parentInvocationId只表示P的直接父，根P时为空。新增控制字段targetInvocationId=P、targetGeneration、expectedActivityRevision、cohortRevision、continuationKey、deadlineAt、sourceEventId、claimedCommandReceiptId可空（FK execution_command_receipt）、consumptionManifestUri/hash可空。UNIQUE(projectId,targetInvocationId,targetGeneration,continuationKey)。普通sessionTurn续行仍无Task，根P续行不造第二根或改变根fence。每次模型轮次以新command receipt＋实际process定位，沿P的Invocation；进程创建与Job本身分开。

`execution_continuation_input`是Job的输入关系：id/projectId、jobId、targetInvocationId/targetGeneration（冗余并以Job同名复合候选键FK校验）、inputKind childReceipt/recoveryInput、receiptId或recoveryInputId恰一非空、cohortRevision、state assigned/consumed/archived、consumedByCommandReceiptId可空、createdAt。每种来源分别建立同目标generation下非archived部分唯一索引，避免nullable联合唯一失效。childReceipt来源的父／根与目标一致；recoveryInput按§5.1显式跨旧根继承，不能冒充同根child receipt。consumed必须有实际调用输入记录，不凭LLM自报填写。

queued意图可在同目标锁／事务下合并未消费输入、增加cohortRevision；领取后集合封存，迟到结果进入下一意图。领取CAS检查targetGeneration、activityRevision、停止状态、父无活动模型调用、剩余预算及两类槽，将Job running、封存输入、新command receipt及关联一起登记；模型作用仍要launch intent和监督器。

活动修订不符时Job保持queued并进入明确reassessment（原因／事件，不新增Job状态）；同一事务核对当前受权输入／源／Plan：仍适用则追加reassessment记录（旧新activityRevision、依据commandReceiptIds、inputManifestHash、outcome rebind/consumed/superseded/blocked）并更新未领取Job预期修订／cohort；新轮已实际消费则凭输入关联标consumed；受权取消／取代则archived；语义不明／源授权失效则Job blocked，保留结果。重评仍受deadline／次数预算，不无限循环。记录存既有execution_event的受限payload及外部manifest引用，不新建平行状态表。

消费结束只标实际处理的输入；失败／不确定按effect和command对账，不将assigned全标consumed。停止将queued意图cancelled、输入关系archived并保存原因；running按停止确认协议结算，不能删Job。重启需先对账，不凭查询旧queued/running/blocked直接重新spawn。

## 5.1 根恢复后的显式成果承接

恢复新Attempt／fence／根P2时，旧P1／Job／child receipt绝不改归属。先确认旧整树停止、effect对账完成，原来可能已发送的父续行必须先判confirmedApplied／confirmedNotApplied／unknown；unknown阻塞，不能一边导入一边重跑未知父调用。

新增`execution_recovery_input`仅登记旧成果到新根的受管只读输入：id/projectId、sourceResultManifestId、sourceChildReceiptId可空、sourceRootInvocationId、targetRootInvocationId、targetInvocationId、targetGeneration、sourceCheckpointId、validationManifestUri/hash、state candidate/revalidated/blocked/invalidated、createdAt；UNIQUE(projectId,targetRootInvocationId,sourceResultManifestId)。源指旧同项目／Feature／Task逻辑工作链，目标必须是合法后继Attempt；普通会话仅同session来源turn链，不能导入业务artifact或跨源类型。

导入前复检当前授权、精确封存字节、源／义务／输入基线、候选范围、已有消费与effects；通过只表示新根可以读取，不继承旧lease／审批或自动继承verified。历史证据按当前版本重新核验，必要测试重跑；不适用或版本不匹配的成果标blocked/invalidated并按计划重新工作，不能称无损复用。

同一事务记录revalidated输入、旧意图的停止／已被承接审计关系、新目标continuation输入归属和待消费意图。旧Job已停止后保cancelled／interrupted历史，仅追加carriedTo引用；旧receipt原状态不伪改为新根accepted。重投同targetRoot＋sourceResult只复用；连续恢复沿最初sourceResultManifestId和原Task根预算去重，不层层复制账本。新根消费只产生新command，执行副作用仍沿持久operation guard，不以导入ID重放已应用作用。

## 5.2 新封存对象映射

显式扩展原execution_file_commit.kind为`workPackage`，仅用于包相关受管文件，新增受限component枚举scope/sourceManifest/sourceSnapshot/obligationManifest/validationPlan/namespaceManifest。ownerObjectId为预分配packageId，revision为packageRevision；sourceSnapshot以sourceId标识、namespaceManifest以namespaceFactId作为非空sourceId，其他component的sourceId使用固定非空`package`。唯一键扩展为(projectId,kind,ownerObjectId,revision,component,sourceId)，旧kind对应component=`body`／sourceId=`owner`固定值，不改变旧对象语义。

预检可保存只读Preview／封存材料，不建Task、不启动执行。预分配package owner在file_commit intent中以draft身份登记；确认事务写prepared/confirmed package时校验精确owner／revision／component及hash，注册引用后file_commit变registered。文件已封但确认失败／过期时保留未登记草稿，不能被下游消费；按显式保留策略处理，不冒充report。缺文件／不匹配拒绝确认，已登记文件损坏使相交计划／证据失效。所有完整manifest含其组件清单和hash，恢复按该清单对账，不从目录猜文件。

source validation的reservationEvidence另记录namespace scope、directory identity、discoveryRevision、existingSources及negativePathFacts的manifest/hash，证明保留期间的集合与成员关系，不仅证明单文件句柄。不能证明目录新增／移动被覆盖时outcome=unsupported且不得currentReserved。

## 6. 索引、迁移和保留

索引建议：package(projectId,featureId,state)、story(packageId,revision,scopeDisposition)、source(packageId,revision,sourceId)、obligation(packageId,revision,applicability)、mapping(taskId,validationItemId)、checkpoint(invocationId,generation,ordinal)、continuation(targetInvocationId,state,deadlineAt)、continuation_input(receiptId,state)。所有跨表归属既有FK又有服务端事务复核；SQLite NULL不得绕唯一约束。

真实迁移实施前列出现有schema、同名表和版本；尤其execution_session_turn现有普通聊天续接字段并不等于DB-CR031完整拟议结构，必须采用版本化增量／明确映射，禁止CREATE IF NOT EXISTS掩盖冲突或DROP重建。旧会话保留、旧包为空并标legacy，不从聊天猜授权／AC／成功。

按DB-CR031备份DB与文件清单、隔离副本迁移、FK/integrity和旧数据比较；新writer启动前检查最低schema／协议。回退先drain停树，有新副作用后只关闭新入口／向前修复，不能回旧库重放。包、授权、effect、receipt、验收和已引用证据不自动裁剪；技术文本按原capture限额保存，清理须有显式策略和引用检查。

测试引用[TEST-R004](../Test/TEST-R004-调度闭环故障与效果评估.md)。本轮没有迁移脚本、真实表、运行测试或能力验证结论。
