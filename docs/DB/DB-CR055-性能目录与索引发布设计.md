# DB-CR055-v2：性能目录与索引发布设计

> v3现行变化：用户已选重建期间持续快照搜索，§3整库检索暂停不采用。快照统计不再声称等于实时源统计；AI正文必须匹配受保护原件完整hash。当前小增量表只保证单请求读事务一致，持久历史库代必须真实保留FTS/member/chunk才可承诺，详见[执行增量](../LLD/LLD-CR055-v3-执行授权与快照语义.md)。源/权限/取消/目录与发布原子性等未被替代义务继续；以下记录保留v2评审历史。

- 日期：2026-11-21；归属FEAT-008／[STORY-036](../Plan/Story/STORY-036-知识库正式实现.md)；状态：候选技术设计经独立复审通过；G-SEARCH等产品门禁未确认，未运行DDL或迁移。
- 关联：[CR-055](../PRD/CR-055-大规模编码与知识库性能.md)、[主方案](../LLD/LLD-CR055-大规模编码与知识库性能方案.md)、[工作包与契约](../LLD/LLD-CR055-工作包与接口契约.md)。扩展既有[知识数据设计](DB-FEAT-008-知识原件切片与全文索引.md)，不建立第二权限源或另一个可编辑正文。
- 变更范围：仅目录投影、后台任务及派生索引发布。未确认的检索可用性取舍见§3，未满足对应门禁不得迁移。

## 1. 稳定目录与版本

原件、授权、文件身份／修订及任务记录仍在现有业务SQLite。新增或扩展逻辑实体如下，正式迁移编号由执行包在编码授权后分配；这里给约束而非可执行生产脚本。

| 实体 | 键／字段 | 索引／约束 |
| --- | --- | --- |
| kb_directory_entry | `(libraryId,entryId)`；parentId、fileId可空、kind、displayName、sortKey、sortVersion、sourceRevision、state | `(libraryId,parentId,kindRank,sortKey,entryId)`keyset索引；活动路径唯一；父子同库FK，拒环；文件/目录身份与路径分离 |
| kb_directory_state | `(libraryId,parentId)`；directoryRevision、scanState、scanAttempt、lastReconciledAt | 更新子项与父directoryRevision在同一事务；unknown/offline不清原条目 |
| kb_index_control | libraryId；activeGeneration、indexEpoch、sourceSetRevision、tokenizerVersion、fence、searchState | 每库一行；searchState=`ready|initializing|rebuild_pending|failed`；只通过单writer CAS更新 |
| kb_index_generation | `(libraryId,generationId)`；partitionNo、tableSuffix、baseIndexEpoch、baseSourceSetRevision、tokenizerVersion、manifestHash、state、byteCount、rowCount、attemptId、fence | state=`building|sealed|active|retired|cancelled|failed`；每库最多1个active及1个building/sealed；表名仅从后端数值ID派生 |
| kb_index_member | `(libraryId,indexGeneration,fileId)`；sourceRevision、parseGeneration、sourceHash、coverage、artifactManifestHash | 同库复合FK到源修订/解析代；每库代每fileId唯一，分批构建；搜索/TOC/关系/read的当前解析代统一从activeGeneration联到本映射 |
| kb_index_job | `(libraryId,attemptId)`；phase、progress、sourceBytes、outputBytes、error、heartbeat、fence、cancelRequested | 任务不能凭UI状态发布；发布前必须对应sealed代；重试新attempt，不能复活旧代 |
| kb_source_change | `(libraryId,sequence)`；fileId、sourceRevision、changeKind、observedAt | sequence单调，推动sourceSetRevision；来源事实优先，索引未就绪也登记 |
| kb_read_lease | 运行内存句柄，绑定scope/library/generation/revision/expiry | 单窗口最多32，TTL60s；不保留长DB事务；重启全失效；GC前核在途引用 |

沿用kb_file／kb_revision／kb_generation的复合身份、源hash、解析版本。**CR055发布模式采用库代membership作为唯一当前解析代入口**：在同一短读快照取得activeGeneration/epoch，再以`(libraryId,indexGeneration,fileId)`查sourceRevision/parseGeneration；FTS命中、outline、relations、read_chunks和引用生成均经过同一映射。kb_file.currentSourceRevision仍独立决定原件最新修订/新鲜度，不能因旧member存在就读旧正文为当前。

原设计`kb_file.publishedGeneration`及文件级`g.state='published'`不再作为此模式的查询权威；parse generation的sealed只证明不可变产物可供引用，其是否当前由active库代member决定。旧字段若为兼容保留，仅作非权威投影；旧读取命令必须在启用CR055 schemaVersion后重定向到member，禁止先切库索引却仍从旧文件指针读正文。启用前沿原设计；条件替代关系在原LLD/DB入口登记。

影子构建中FTS、member、outline/relations所指产物均分批暂存；最终发布只切库指针，无需在同一事务逐个更新50,000个file的published指针。小更新在同一有界事务改对应member、FTS和indexEpoch。代际封存的`manifestHash`定义为sealedBaseDigest，不为每次小修改重算全库；active变化由`baseDigest + monotonic indexEpoch + auditChainDigest`表示，审计链每项含前摘要、受影响member前后摘要/FTS载荷摘要与requestId，在同一事务追加。全量覆盖复核在后台验证，不占小更新事务。

member和不可变parse产物允许跨库代复用；GC必须确认所有active/retired在途库代member与显式历史引用都不再引用后才回收chunk/outline/relations，不能仅看文件级旧published状态。目录变动只更新相关父目录；批量初次枚举用staging目录代，完成再切目录指针。源离线、权限失败、watch溢出先标unknown并对账，不据不完整枚举删除文件。

旧noteId按`libraryId,旧noteId → fileId`建立兼容映射，碰撞标identity_conflict；相同内容或相同文件名不能合并身份。源移动依平台身份／明确操作登记确认，不能仅靠hash猜测。

## 2. 选定的索引物理路线

**候选选定：小增量有界原事务，大变更完整库代影子FTS。**不用“staging混入现有FTS再WHERE过滤”方案，因为其词频统计会影响BM25。

所有FTS表仍是本机同一SQLite中的库级独立表。保留当前按库统计、按已授权库合并的排名语义。表名例`kb_fts_l{partitionNo}_g{generationId}`只由宿主分配数字生成，调用者不可提供SQL标识符。

### 2.1 小增量路径

1. 元信息/源版本核对及流式解析在DB锁外；结果写不可见暂存文件/切片。
2. 根据**旧删除＋新插入的chunk数、term字节、正文块字节**判档，而非只看新原件大小。初始候选上限64个chunk、合计256KiB索引载荷；删GB旧文件不能因新文件很小走此路径。
3. 单writer验证file revision、fence、tokenizerVersion及activeGeneration；一个事务删除旧词项、插入新词项与块、更新当前代指针/清单以及indexEpoch。原子性与现行CR030一致。
4. 事务耗时预算为P95≤50ms候选，并记录max；它是需实测的验收线，不声称sqlite进度回调可强行中断所有I/O。发现超过预算的对象转大变更队列，事务失败回滚，不发布一半。
5. 影子构建期间同库小增量**不写active代**，只登记变更并排队；不同库可由单writer轮转。这是保证影子切换不覆盖已提交小更新的简单串行化策略。

### 2.2 大变更／初次建库路径

1. 记录baseIndexEpoch、baseSourceSetRevision、tokenizerVersion和fence，分配新generation；读取有效源集合的版本化清单。
2. 仅重解析变化文件，未变化文件复用已验证的不可变chunk；但**整个库的FTS行必须写入新影子表**。复杂度为O(当前库全部有效索引字节)，不是O(变化量)；不承诺GB文件每次保存后即时全文可搜。
3. 影子表构建每批≤64chunk且≤256KiB索引载荷，单writer轮转。切片、词项编码、SQL参数等所有副本在预算内；不能先生成单文件完整Vec<Chunk>或整个terms字符串。
4. 构建期间源变化登记到change log，当前attempt标obsolete。**任何会使active词项过期的旧源修改/删除/新鲜度失效，不论大小，必须在接受该事件的同一短事务写sourceSetRevision、失效epoch/fence并将searchState置rebuild_pending，返回新的检索结果前复检；不能因小更新被排队而继续查含过期词项的active表。**纯新增且未污染active词项时可继续原代明确覆盖范围。合并短时间变更后新attempt重建，不强行无限追平；持续变化时保持rebuild_pending，展示原因并允许暂停/取消。旧attempt最多保留一个用于清理，不能无限累积影子代。
5. 完成后流式核对清单：每个源revision/hash与parser/chunker/tokenizer版本、连续源范围、rowCount、产物摘要和集合覆盖。sealed不代表可查。
6. 发布事务仅CAS`activeGeneration,indexEpoch,sourceSetRevision,fence,tokenizerVersion`及新旧generation状态；任何base/fence变化则拒绝，不在事务里重做哈希、插入FTS或删除旧表。
7. 返回成功前再按权限规则复核。查询在短读快照中取得activeGeneration/epoch，单次SQL只访问该表。完成查询后立即释放DB读事务；跨页通过opaque租约校验版本，epoch改变返回失效。
8. 已在途查询可完成读取旧表，但结果返回前核对generation/fence/freshness，版本变化丢弃并返回`INDEX_CHANGED`；旧代仅供受限历史查看，AI不得自动使用过期结果。

## 3. 大变更时可用性取舍（G-SEARCH）

问题：旧GB文件变更／删除后，要立即剔除其词项且不污染同库BM25；同步删除数百万FTS行违反有界事务。只用WHERE过滤失效文件不能修正旧统计。

本设计建议最小保真策略：小事务设置该库`searchState=rebuild_pending`，使该库全文检索暂不可用，后台构建排除失效源的新库代；新代就绪后恢复。**其它库继续检索，同库文件树/元信息/原件窗口阅读继续可用**；该库AI正文读取和排名按freshness门禁拒绝，不以旧代伪装最新。已显示的所有者历史可保留但标历史，不能被作为当前AI引用。

- 这是**产品行为取舍，用户未确认**，必须作为G-SEARCH门禁。它不算“同库全文检索在后台重建期间仍可用”通过，也不能用无响应阻塞代替明确状态。
- 初次索引、单个坏新文件可不发布其新版本，若原active代没有需立即移除的失效词项，其它已发布文件仍可搜；但旧文件发生需剔除的大变更时，整库全文暂不可用。主方案“坏文件不拖垮整库”仅适用于没有污染active统计的新增/失败任务，不能扩大解释。
- 用户若要求此期间同库未变文件也实时可搜、严格当前库BM25、有界写事务三者同时满足，则本最小路线不准开发；须另作可扣除文档统计的排名／分段索引设计，核对语义与召回后重新评审。
- G-SEARCH未确认不阻塞独立C1编码性能设计、知识目录分页设计，但阻塞K1大索引发布实施和整项CR055软件验收。

## 4. 查询／权限／新鲜度

- 所有者索引结果时钟与AI校验响应时钟分开；索引查询不得为每次搜索扫描全库原件。AI读取命中的受限文件遵守既有严格hash复核；5GiB完整哈希允许后台耗时，但不能以stat偷换。
- 知识库启停/撤权仍由现有grant与access epoch决定；并发读连接不是独立授权来源。返回前复检当前epoch，撤权使未投递批次和缓存句柄失效。
- 单字检索保留现行受限路径及incomplete。全量中文单字倒排作为另一个需版本化/容量评估的设计包，不把当前1000块护栏结果当完整召回。
- 一个库rebuild_pending时结果明确列入`excludedLibraries`与原因；混库结果不可悄悄少库仍称完整搜索。所有库不可用时返回`INDEX_NOT_READY`，不是空命中。

## 5. 内存、磁盘与旧代清理

端到端内存账本统一使用[工作包§6](../LLD/LLD-CR055-工作包与接口契约.md#6-保存脏状态与内存)：进程树1GiB候选为总额，索引worker256MiB包含其中；输入队列、输出队列、decoder、parser状态、chunk、hex词项、SQL绑定、SQLite页缓存、IPC序列化及副本都在此预算中。

- 流式解析遇文档级表格/围栏/索引须允许持久暂存，不无限保留直到闭合；元信息清单和长行索引也分页，不为50,000文件一次构造完整前端对象。
- 任一流水线阶段输出将突破配额时停止上游拉取；consumer取消释放其credit，worker退出才释放内存槽。无法流式的格式不能进入GB级正文路径，返回能力限制。
- 磁盘同时计：业务DB/WAL、当前FTS、影子FTS、旧代、派生文本/清单、导入临时原件、恢复残件。每库最多一个影子代和一个待清理旧代；旧代未回收空间不足时暂停新建库代。
- 词项hex编码和FTS膨胀比例不可按原件固定1倍估计。基线试验记录实际放大率，用采样估计作预检，并持续检查真实输出与空闲空间；候选低水位max(2GiB,卷容量5%)，达到即中止构建并保留active代，阈值在G-PRODUCT确认，不偷偷删原件。
- 每次提交后PASSIVE checkpoint由同一writer调度，避免额外并行checkpointer；记录WAL峰值/读事务寿命。长查询分页／中断，不持一个跨UI生命周期快照。
- retired代GC先确认无在途引用，分批删除FTS行和独占chunk，单批仍受载荷预算；FTS merge的实际写放大须测。清空后才DROP空表；不在发布事务里DROP大表，不在前台调用VACUUM。若剩余大页回收无法保证预算，暂停该清理并报告空间压力，不能假称已回收。

## 6. 崩溃恢复与迁移

| 故障点 | 必须结果 |
| --- | --- |
| 原件已提交、索引未提交 | 原件成功与索引失败分别登记；保原件，不为重建回滚用户写入 |
| 影子构建中断 | 非active代永不被查询；恢复先核attempt/fence/源清单，不自动继续过期任务 |
| 指针切换前崩溃 | 旧active代仍是唯一当前代；sealed代待核验；rebuild_pending不会被误改ready |
| 指针切换后、GC前崩溃 | 新active代保持；旧代只待清理，不能重新成为当前代 |
| 构建时撤权／禁库 | 权限立即阻止返回；构建可取消，fence失效；重启不恢复已撤权grant |
| 目录离线/watch丢事件 | 状态unknown并对账，不把源集合当空清库 |
| 磁盘满/WAL扩大 | 失败只清本attempt且无引用临时件；保原件、active代、草稿和任务结果 |

迁移步骤：冻结本Feature写者→SQLite backup一致性快照＋原件清单→新增控制与目录表→旧ID映射校验→后台构建初始新代→覆盖/授权/查询抽样与总量校验→单库切换→观察→按预算清旧派生数据。切换失败保旧业务数据，按失效规则明确不可搜，不回落逐篇扫原件。

回退：停本Feature新worker，撤销新入口路由，保留已保存原件/草稿/业务变更；新Schema可保持兼容只读，后续向前修复。不能恢复旧DB覆盖新授权或新原件。正式回退演练未执行，必须在TEST故障矩阵逐项记录。

## 7. 与现行设计的关系

本增量待评审，不静默覆盖[原LLD发布流程](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md#33-发布原子性与两个-writer)／[原DB设计](DB-FEAT-008-知识原件切片与全文索引.md)。小增量沿原单事务发布；大变更影子库代与G-SEARCH须在确认后登记采用关系，schemaVersion和迁移版本明确后才能写代码。旧P0实现仍保持其真实限制，本文不是其实施报告。

## 8. v4 索引物理优化（2026-11-22 用户授权修改）

用户 2026-11-22 明确要求“索引空间/时间要达标，修改吧”。触发依据是[10GiB 真实基准](../Test/BENCH-CR055-真实索引基准.md)：105 分钟未完成、索引库 21.74 GB。按“库大小 ÷ 已处理源字节”的同一口径（已处理约 2.9 GB）折算为**约 7.5×**，且仍在增长；此前文档把它写成“21.74 GB = 2.17× 源”是拿中途库大小比全量源，口径错误，已更正。

### 8.1 实测根因

| 根因 | 机制 | 量级 |
| --- | --- | --- |
| 词项十六进制编码 | `hex_term` 把每个词项按字节转 `%02x`，汉字二字组 6 字节变 13 字节 ASCII，拉丁词恰好 2×+1 | FTS 词项体积约 2× 以上 |
| 正文双份 | `kb_snap_chunk` 同时存 `text` 与 `searchText`（归一化结果），后者近似重复 | 约 2× 正文 |
| 批次过小 | `MAX_BATCH_ROWS=64` / `MAX_BATCH_BYTES=256 KiB` | 事务与 fsync 次数过多 |
| 重复归一化 | 每个 chunk 都重算 title/heading 词项，同一文件内完全相同 | 每文件线性浪费 |

### 8.2 变更

1. **词项改用原始 UTF-8 字面**：`tokens()` 产出汉字二字组与拉丁整词的原文字面，不再 hex 编码。FTS5 使用 `unicode61`，空格即 token 分隔，因此写入 `数据 据库` 与查询传同形 token 的 AND 语义与 hex 版等价。token 内容只来自 `is_han` 与 `is_alphanumeric`，不含 FTS5 语法字符（双引号、星号、括号、冒号、尖号、加号、减号），不引入查询注入面。
2. **`TOKENIZER_VERSION` 升为 `local-utf8-v2`**：既有词项为 hex 形式的索引不再被复用，阅读与检索不会混用两种编码。
3. **FTS 表改为 contentless**：`content=''` 后 FTS5 不再保存一份词项副本（`%_content`）；`contentless_delete=1` 保留按 rowid 删除能力，GC 与整代回收路径不变；`detail=full` 保留列信息与位置列表。**`detail=column` 曾被采用，但独立复审实测在 `content='` 下 `bm25()` 恒返回 0**，相关性排序会静默失效，且 `unicode61` 把某个词项切成多 token 时 FTS5 会当成 phrase 直接报错（`detail!=full` 不支持），因此改回 `detail=full`，只保留 contentless 的收益。代价是不支持 UPDATE（本方案不做单行 UPDATE）。
4. **批次放大**：`MAX_BATCH_ROWS` 64 → 512，`MAX_BATCH_BYTES` 256 KiB → 2 MiB；单行上限仍独立校验（`INDEX_FIELD_TOO_LARGE`），取消检查在每批之前。
5. **每文件词项复用**：title/heading 词项在同一文件各 chunk 间相同，按 `(title, heading)` 缓存；`terms_for_chunk` 拆成 `title_terms_for`／`heading_terms_for`／`body_terms_for` 三个可复用入口。
6. **`searchText` 去重**：归一化结果与原文逐字节相同时存空串，读取侧 `CASE WHEN searchText='' THEN text ELSE searchText END` 回退，`searchEndByte` 口径不变。
7. **FTS 合并延后**：`automerge` 2 → 8，构建结束时对已发布代执行一次 `optimize`。逐段频繁合并在 10GiB 基准中是主要时间开销之一。

### 8.3 实测结果（release 与 debug 分别记录）

见[10GiB 真实基准](../Test/BENCH-CR055-真实索引基准.md)。摘要：

- 空间：基线约 **7.5×**（同一口径重算）→ 去 hex + contentless + `detail=column` 时约 **3.68×**；因 `bm25()` 失效而改回 `detail=full` 后，最终以 v8 基准实测为准（见基准文档，位置列表恢复会回升）。
- 实测空间构成：正文 ≈1.02×、检索 lookahead ≈0.47×、FTS 词项与索引 ≈1.16×、其它 ≈1.03×。
- 时间：debug 外推约 390 分钟 → release 外推约 130 分钟（约 3×，含构建口径差异，不合并口径）。
- **未达标**：2× 空间预算与可接受的 10GiB 完工时间均未达到。

### 8.4 2026-11-22 重新核对：无证据证明空间下限

前轮“FTS 已接近下限、索引不能低于约3.5倍、2倍不可能”的结论撤回。旧报告混用了 GB/GiB，部分源大小是按文件数折算，且整库未完成、未进行同数据的完整 before/after，不能证明理论下限。

512 字节是最长128个四字节字符连续查询的上下文上界，并不要求数据库保存整篇正文的第二份；是否跨多个短片段覆盖完整，还要回归验证。实际体积取决于正文、前瞻、词项、数据库页利用率、旧代和 WAL。原件完整哈希与权限核验不变。

用户现已明确授权“继续优化，允许调整方案”，只要不改变产品检索/权限/保存语义，缓存、预编译 SQL、布局参数与索引物理设计等可在独立 FEAT-008 工作包内自主验证，无须反复让用户选择纯技术细节。

本批采用同一真实固定文件组、同一 release 和 SQLite 同步配置完成前后对照，精确记录原始字节、索引与 WAL、全部阶段耗时；完整索引发布成功前不记完工成绩。过程与性能标准见[完整配对优化与性能标准](../Test/REPORT-CR055-完整配对优化与性能标准.md)。

候选方向（尚未证明收益）：

| 候选 | 可能收益 | 必须验证 |
| --- | --- | --- |
| 复用预编译 SQL／批内 statement | 减少逐块 SQL 解析与分配 | 同步设置不变；正确文件归属；完整 before/after |
| 减少重复进度事务 | 减少日志刷盘 | 真实进度、短事务、取消、fence/CAS 均保持 |
| 前瞻只保存 suffix、按 contextVersion 读取 | 消除正文重复，兼容旧 parse | 新旧格式、retired lease、游标、精确位置与召回 |
| 调整片段大小／数据库页布局 | 减少行数与页空闲 | 全文检索、前瞻与响应预算；不能按比例臆测收益 |

### 8.5 不改变的部分

- 快照代、成员/分块键、`chunkKey` 稳定性（解析复用测试继续有效）、`bm25` 四列权重 8/4/1/0.2（由 `detail=full` 保证，`detail=column` 下实测失效）、命中核验 `needles`、双时钟与 AI 全哈希核验均不变。
- 查询仍是字面 AND 语义，不解释 AND/OR/NEAR/星号。
- **升级后必须重建索引**：`TOKENIZER_VERSION` 升为 `local-utf8-v2` 后，既有库的词项与当前查询不同构。检索入口（快照路径与旧 P0 路径各一处）已加版本闸门：不匹配时返回 `SNAPSHOT_REBUILD_REQUIRED` / `INDEX_REBUILD_REQUIRED` 并要求重建，不再静默 0 命中；发布路径不设闸门并会把 `tokenizerVersion` 刷成当前值，否则旧库将永远无法重建。
- 不新增依赖、不引入自定义 tokenizer。

### 8.5 回退

`TOKENIZER_VERSION` 与词项编码同时决定可复用性，回退需同时恢复旧常量与旧编码并重建索引；只改其一会导致查询命中不到既有索引。回退不涉及原件与授权数据。
