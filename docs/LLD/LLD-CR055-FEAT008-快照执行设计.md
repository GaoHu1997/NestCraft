# LLD-CR055-FEAT008-SNAPSHOT-v1：快照执行设计

- 执行身份：`NestCraft-workspace-D-github-AI_Delelovelop / FEAT-008`；子包owner=`impl-kb-snapshot`，继承impl-knowledge，主writer及注册/API owner仍为impl-knowledge。
- 授权：用户明确正式开发；本子包只写新模块[快照模块](../../src-tauri/src/commands/kb_snapshot.rs)、本文和[报告](../Test/REPORT-CR055-FEAT008-快照.md)。不自行cargo/build、不修改其他源码。
- 现行依据：[v3执行语义](LLD-CR055-v3-执行授权与快照语义.md)、[DB历史及v3覆盖](../DB/DB-CR055-性能目录与索引发布设计.md)、[工作包](LLD-CR055-工作包与接口契约.md)、[TEST](../Test/TEST-CR055-性能基准与故障验收.md)。用户已选人类重建期间持续快照搜索与GB只读；不实施停库检索路线。
- 准入：本文核心实体/协议须perf-architecture独立通过后编码；UI状态由impl-reader先补稿冻结，后台子包不改布局。UI-SCROLL-001由Reader承接，本模块无滚动容器。

## 1. 实体与不变性

同一SQLite新增独立`kb_snap_control`、`kb_snap_generation`、`kb_snap_member`、`kb_snap_chunk`、`kb_snap_job`。FTS表`kb_snap_fts_{generation numeric ID}`仅宿主生成，不拼用户输入。与P0的kb_chunk/kb_library_state/kb_fts表完全隔离。

- control每库一行，activeGeneration可空，epoch、sourceFence单调；原件业务写入由主writer在同一相应事务调用invalidate_source_tx，使sourceFence递增，不删除人类active快照。
- generation记录libraryId、state、baseEpoch、baseFence、sourceRoot、startedAt/completedAt、manifestDigest、fileCount/chunkCount、字节数、tokenizerVersion、唯一taskId。building/sealed绝不可查询，active和retired不可原地改内容。
- member主键(libraryId,generation,noteId)，含relativeUri/title、parseGeneration、sourceSHA256、sourceFNV1a64、sourceSize、源stat/identity指纹、coverage、chunkCount。旧noteId优先复用登记；metadata文件也完整hash，不能把文件名hash当源hash。
- chunk主键chunkKey全局唯一，另唯一(libraryId,noteId,parseGeneration,ordinal)，存canonical UTF8文本、canonical半开字节范围、行号、heading/kind。FTS rowid=chunkKey；同文件未变可跨库代共享parse产物。每个FTS仅含该库代member允许的chunk。
- 搜索→命中引用→read统一经generation/member选择parseGeneration，不查询P0 MAX代，不把旧epoch贴新结果。当前原件版本与snapshot version独立。
- 首期不新增Office/PDF正文解析、全篇Markdown AST/关系图；保留md/markdown/txt/log/text/json/csv文本正文，其余metadata-only。heading由有界当前行前缀识别，超长标题省略展示但正文不丢；不宣称完整跨块Markdown排版已实现。

## 2. 真正有界的构建

初版每次生成完整不可变库代FTS；无原地小增量快照修改。相同源SHA＋解析/分词版本复用上代parse块，不重解析，但仍按受保护原件流式hash确认；新FTS插入量O(全库索引)，明确耗时与磁盘写放大。

- 不collect全库文件列表；使用受检逐层read_dir递归（深度≤32，目录handle最多33），遇symlink/reparse/非普通项明确失败，不静默忽略。每个文件重新创建短生命周期SafeRoot，只保该父链，防SafeRoot pins随整个库增长。每个条目在DB记录member/源清单，而非内存Vec。
- 原件用files::open_snapshot受保护File，在句柄保持期间第一遍64KiB读取同时SHA256及FNV1a64、字节计数。相同hash复用上代chunk；不同则Seek回0，第二遍流式严格UTF8或BOM UTF16LE/BE解码，坏序列/NUL拒绝，不替换字符。
- 解码固定输入/输出缓冲，不read_line/read_to_end/read_to_string；切片目标2048、硬顶4096 canonical UTF8字节，边界优先换行/空白，单长行仍强制scalar边界分片。CRLF行数、代理对跨缓冲、BOM明确处理；canonical文本去BOM、换行不规范化，源hash始终原字节。
- 中文跨片二字与短语搜索采用**单向向后**最多512 canonical UTF8字节lookahead：每次仅保留当前primary与下一primary，searchText=primary+下一块scalar边界前缀，正文primary连续不重叠。chunk另外存searchText/searchEndByte及primaryEndByte。FTS和literal复核使用同一searchContextVersion；仅后缀命中的候选由下一primary拥有，只有至少一个实际正文match起点落在本primary才归本块（纯标题/heading命中另标metadata定位）。返回SnapshotRef含精确matchStart/matchEnd与受检canonical范围[startByte,searchEndByte)，snippet从该searchText产生；read_hit_conn读取同代受检范围，普通read_chunk_conn仍只读primary连续正文，绝不将后缀伪装成primary范围。跨片重复按parseGeneration+实际match span去重。512字节覆盖至多128个四字节scalar的连续查询，但不承诺多词任意距离共现；全文词项/排序是本模块版本化语义，库内BM25不声称与P0无重叠排名数值完全等价。复用键必须持久包含sourceSHA256、parserVersion、chunkerVersion、encodingPolicyVersion、searchContextVersion、optionsHash；generation绑定tokenizerVersion，FTS始终按目标版本重建，不复用旧词项。
- 词项复用kb_index::terms_for_chunk，每次输入≤4096+512字节，输出有界。chunk/member/FTS写入批次≤64块且估算索引载荷≤256KiB；大字段路径/标题响应限额明确拒绝，不能单字段破预算。所有块/词项SQL副本、decoder与重叠缓冲合计保持常数内存。
- 单snapshot后台worker全局最多1，同库最多1 building，独立knowledge_connection（8MiB cache/250ms busy）。SQLite原生单writer串行短批次，批间让出并查取消，不占db全局Mutex；已有目录worker互不共享无限队列。
- 源清单冻结为逐文件受保护读取版本集合，并在最终验证再次遍历全目录逐项比对member stat/identity与数量。期间已知业务写入使sourceFence变化，CAS拒绝；文件/目录外部变更导致指纹不同则SOURCE_CHANGED，不自动无限重试。无法证明全库在同一物理瞬间存在，snapshot明确扫描区间与freshness=unknown，AI必须完整复核选中文件。

## 3. 发布、取消与持续可搜

- start记录baseEpoch/baseFence/root，create job+generation+FTS。每批均检查持久job取消、fence/root/启用和内存token；源变化中止新代但旧active继续可搜。
- 验证清单采用SQL按noteId keyset分页＋流式摘要，含member源hash/parseGen/coverage/count，不能全量数组。封存后发布只短事务CAS control(baseEpoch/baseFence/root/启用)并切activeGeneration与epoch、退役旧代、任务completed。member/chunk/FTS不在最终事务插删。
- 取消token直接原子写，不等待长索引SQL队列；持久cancel/fence写入和publish事务通过同一数据库事务顺序线性化：取消先落库禁止发布；发布先完成返回completed/cancelTooLate，不回滚已发布代。线程退出前仍占worker槽。
- 旧人类快照FTS统计按其完整源集合，不能过滤变化文件后冒充实时BM25。全部状态返回humanOnly/freshness unknown、snapshot epoch/时间。无active snapshot且有任务时INDEX_PENDING，不能把部分building结果作为当前。
- P0写者只触碰旧表，不能改kb_snap_*；存在active snapshot后人类查询走snapshot，新保存只推进sourceFence并标需要重建，旧快照仍可查。此集成由impl-knowledge负责，本文不越界改注册。

## 4. 查询、引用与有界租约

- search_library(&Connection,libraryId,&ParsedQuery)->Result<Option<(Vec<RawHit>,bool)>,String>：None仅无active snapshot；有active但无命中返回Some(empty)，不回退P0。调用者须在同一短读事务取得snapshot epoch/元信息并物化≤100结果，再释放。
- SnapshotRef由后端按generation+chunkKey解析，含libraryId,noteId,epoch/generation,parseGeneration,sourceHash(SHA256),legacyHash(FNV),relativeUri,startByte/endByte。来源证明不从用户提供的字段重建，AI网关必须取得服务端实际member并由主writer完整hash+权限核验，snippet同样是正文。
- read_chunk_conn接受可选expectedGeneration；有指定旧代时只读该代member/chunk，GC/未知明确SNAPSHOT_EXPIRED，不自动读新noteId。None且无active才允许P0回退；active下note缺失明确NOTE_NOT_IN_SNAPSHOT。块内续读游标含generation/note/ordinal/byteInChunk，真实部分读取不得跳过剩余。
- 单次read≤4KiB及8KiB JSON预算；范围为实际返回canonical区间。初版只提供受检chunk读取，不宣称大纲/关系API已落地，但后续必须消费相同member。
- 跨请求旧代保留：明确lease API acquire/release绑定调用者owner+library+generation，最多全局64租约，每owner32，TTL60s；GC前原子认领retired为collecting并确认无lease，acquire只允许active/retired。正在单次查询的SQLite短读事务由WAL快照保护；跨请求未租约的旧引用可能过期，必须显式失败。
- 主writer可仅采用即时短事务读路径；如果未接真实lease，不得UI宣称长期旧代可续读。window owner由Tauri注入并带实例nonce，Destroyed清lease并取消其自有任务；关闭UI不能误取消另窗口任务。

## 5. 恢复、资源与GC

- 启动recover_interrupted只在无worker时运行，把非终态job/generation标interrupted；active/retired保持。generation只会在publish事务变active，崩溃不可能看到半代。
- 每库最多active＋1 retired＋1 building，回收落后或lease占用时start返回BUSY_RETRY，不无限堆代。全局1worker，clear过期租约；未发布失败表在下一worker开始时分批清理。禁库/移除库拒绝新返回且构建CAS失败；不删除原件或恢复授权。
- 继承应用全部自身进程私有内存1GiB、全部索引worker合计256MiB上限；本模块仅1worker、8MiB SQLite cache、≤256KiB批载荷＋固定decoder/primary/lookahead缓冲，不因流式写法宣称实测已达标。扫描与metadata完整hash同样计processedBytes，每64KiB检查取消并定时落进度，不能大附件无反馈。
- 默认构建逻辑载荷配额64GiB，同时对真实SQLite主文件＋WAL＋SHM总字节执行独立64GiB软上限（测试Limits可显式调低/调高）；每提交批次检查逻辑配额，每累计32MiB或每文件检查真实空间及卷空闲低水位max(2GiB,卷容量5%)。达到即失败保旧active，不清原件；基准必须按lead明确配额运行，不能无限生成。Windows用受检DB路径的本机卷空间API，无能力平台明确拒绝生产构建而不假称已检查；隔离内存单测可显式关闭空间探测。当前+shadow+retired/WAL均在实际DB总量内，不用逻辑terms字节替代物理空间。SQLite排序临时空间/FTS合并额外开销由统一基准记录，未测不称常数内存证明。
- FTS automerge批次行为不能伪称硬50ms；配置有限automerge，批间取消/让出，真实merge耗时由统一测试记录。GC每批64row：先删退役FTS行/对应member，chunk只在无任何member引用时删；DROP仅空表，最终publish不做GC。
- 源内容哈希必须带算法前缀：新member SHA256＋FNV并存，ChunkView.source_hash用SHA256；P0 FNV绝不改名成SHA。AI核验adapter需按前缀算法匹配，不比较不同算法字符串。

## 6. API与协作

- migrate(&Connection)、recover_interrupted(&Connection)、invalidate_source_tx(&Connection,libraryId)由impl-knowledge接启动/业务写入。
- commands：kb_index_start(window,library_id,request_id)、kb_index_status(window,library_id,task_id)、kb_index_cancel同status；Task字段与phase冻结消息已发impl-reader/impl-knowledge。任务状态为真实阶段，不复用metadata目录完成冒全文。
- 需要主writer最小开放kb_index::ChunkTerms及title/heading/body/bigram字段、terms_for_chunk；不会调用整篇chunk_content/line_spans。
- 注册owner、AI gateway权限/源核验、现有API桥为impl-knowledge；本模块不修改这些文件。

## 7. 具体验证

在本模块内编写：空库/空文件、UTF8/UTF16分缓冲及长行完整覆盖、SHA/FNV已知向量、实际FTS搜索、metadata-only、同源复用、不发布半代、旧快照重建可搜、CAS/取消/sourceFence拒绝、旧代租约/GC/明确过期、成员与parse一致、坏编码/路径/容量失败、恢复。

ignored规模基准按环境变量配置0/1/2/5GiB或任意MiB，默认不生成GB夹具；生成器流式分配固定小块并检查索引配额，记录真实字节/耗时/峰值批载荷，清理仅本测试临时目录。暂不运行cargo/build，由lead统一；实现后报告实际运行结果与未执行项，不把编写单测当通过。
