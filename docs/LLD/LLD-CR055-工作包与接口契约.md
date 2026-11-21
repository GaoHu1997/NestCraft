# LLD-CR055-EXEC-v2：性能工作包与接口契约

> v3现行执行增量（2026-11-21）：用户已明确授权正式开发，并选择持续快照搜索及GB级首期只读窗口，见[执行授权与快照协议](LLD-CR055-v3-执行授权与快照语义.md)。下文v2门禁中的“未获授权”“尚未制作”是评审时历史：G-CODE现已按三个独立Feature上下文授权，两份UI已先验证/登记；G-SEARCH暂停方案不采用，source-byte只读子协议经独立审查通过。未实测的性能/恢复/视觉门槛仍不记通过。实体契约冲突时以v3明确替代的§1～4为准，其余v2义务保留。

- 日期：2026-11-21；负责人：lead；状态：带门禁技术设计包独立复审通过；产品/UI/编码/实测门禁未通过。
- 来源：用户“把方案落实一下，需要开子智能体评审，通过才算完成”。本包落实需求／设计与评审，不修改正式源码；无软件性能通过结论。
- 上位：[CR-055](../PRD/CR-055-大规模编码与知识库性能.md)／[性能主方案](LLD-CR055-大规模编码与知识库性能方案.md)。本包确定技术契约与交付依赖，主方案保留容量、候选预算和现状证据；有冲突时必须登记，不静默替代已确认业务行为。

## 1. 决策与准入分开

| 门禁 | 内容 | 当前状态／责任 |
| --- | --- | --- |
| G-PRODUCT | 容量、验收机器和预算；GB级是否接受只读；超过普通编辑档位如何呈现 | 用户未逐项决定。采用候选值做方案评审，不用它减少现有可编辑文件能力；受影响包不准开发 |
| G-SEARCH | GB旧源失效后同库全文暂不可用、后台影子代恢复；替代方案需独立排名设计 | 用户未确认，详见[数据设计§3](../DB/DB-CR055-性能目录与索引发布设计.md#3-大变更时可用性取舍g-search)；阻塞大索引发布实施，不自动扩大或缩减能力 |
| G-UI | 新加载、部分结果、受限模式、取消及缓存压力状态有可操作UI，采用版本和动态证据齐全 | 本轮仅下文场景矩阵，未制作新可视稿；界面实现禁止开工 |
| G-DB | 本包接口和[数据增量](../DB/DB-CR055-性能目录与索引发布设计.md)评审通过，迁移故障用例固定 | 设计评审中；未运行DDL |
| G-CODE | 对唯一Feature及Story/AC有明确正式编码授权，工作区/HEAD/差异hash冻结 | 未获授权；本包不是执行命令 |
| G-PERF | 固定机器、夹具、测量脚本/原始trace，所有对应AC通过 | 未执行。方案评审通过不代表此门禁通过 |

评审通过的含义：本轮方案无未解决的技术阻断或自相矛盾，未确认产品范围有明确隔离边界，后续可据此制作设计与实施包。不是全部DoR、UI设计通过或产品验收通过。若用户要求本轮直接开发，仍需明确编码范围，并逐Feature按准入执行。

## 2. 单Feature工作包

统一projectId为仓库项目`NestCraft`（设计记录身份，不声称数据库已有该ID）；未来执行前绑定真实项目ID，未绑定不得派发。以下文件为拟议修改范围，现阶段只读。

| 工作包／唯一Feature | Story AC | 实施内容与边界 | 依赖／退出证据 |
| --- | --- | --- | --- |
| WP-055-C1／FEAT-007 | [STORY-034 CR055-01～05](../Plan/Story/STORY-034-编码区正式实现.md#cr-055性能增量验收草案) | 编辑热路径、保存状态、项目树、项目搜索及模型预算；拟议范围`src/modules/editor/`、`commands/fs.rs`及其API；不实现知识库 | 产品/编码/UI门禁；输入trace、计数器证明无每键全文串化、撤销/保存竞争与树导航通过 |
| WP-055-K1／FEAT-008 | [STORY-036 CR055-01～06](../Plan/Story/STORY-036-知识库正式实现.md#cr-055性能增量验收草案) | 元信息目录、增量盘点、流式原件、索引后台化、版本发布和知识API；拟议`commands/knowledge*.rs`、`kb_index.rs`及DB适配；不实现Reader布局 | G-DB与编码门禁；分页完整、发布/取消/外改/撤权/磁盘满故障矩阵、内存与锁等待通过 |
| WP-055-R1／FEAT-009 | [STORY-014 CR055-01～05](../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-055性能增量验收草案) | 知识虚拟树、块阅读、TOC、搜索状态、缓存与输入保护；拟议`src/modules/knowledge/`，不修改授权/发布逻辑 | K1接口固定可先用隔离夹具设计；真实集成需K1通过，且G-UI/编码满足 |
| WP-055-C2／FEAT-007 | STORY-034 CR055-04 | 单大文件模式、稀疏行索引、窗口文档、GB任意编辑的独立技术试验 | G-PRODUCT决定模式，独立设计/数据恢复评审；不在C1里偷偷降为只读 |
| WP-055-K2／FEAT-008 | STORY-036 CR055-04 | PDF/Office各解析器容量与恢复设计 | 不将原件导入等同正文解析；逐格式依既有CR030范围另行完成，不能算K1已完成 |

共享API类型由其提供者Feature拥有：项目文件接口归C1、知识接口归K1；Reader只消费。全局数据库连接改造涉及其他Feature时，K1先通过知识专用适配器释放长锁并使用自己的有限读连接，不在协调会话顺手重构所有命令。共用虚拟行组件若有需要，由C1建立最小无业务组件契约，R1消费，不复制业务权限与模型状态。

每包交接必须包含：真实projectId/featureId、AC全表、允许文件、设计hash、源码hash/差异、失败证据、进程/任务清单、请求版本、未知副作用；无旧writer停止证据不启新writer。主代理只集成已评审产物，不能用当前跨Feature上下文直接编码。

## 3. 接口共同约束

契约为Tauri IPC逻辑schema草案，命令尚未注册。旧API逐个适配，旧全文接口遇大文件返回明确能力错误，不循环拼块绕过预算。

- `scope={kind:project|library,id}`，ID由后端解析到受检根；不允许调用者直接传跨根绝对路径替代scope。
- `requestId`为前端随机128位ID；作用域是窗口会话＋操作类型。后端维护有限活跃表；读取同ID去重只在参数完全相同时成立，参数不同返回`REQUEST_ID_REUSED`。
- `revision`是不透明版本token，编码为字符串；字节偏移和文件大小用十进制字符串传输，避免JavaScript整数/位运算溢出。UI行号1-based，编辑器字符位置以UTF-16 code unit计；canonical字节位置为UTF-8，原文件字节遵循其encoding；转换由版本化块映射完成，不能直接相加。
- 协议v1接受UTF-8（可含BOM）及BOM明确的UTF-16LE/BE，继承CR030格式范围；未知／坏序列返回`ENCODING_REQUIRED`，不静默替换字符。流式解码、源字节到canonical UTF-8再到编辑器UTF-16的映射按§9固定；未验证该编码不得宣称已支持。
- 单次正文响应≤256KiB（包含JSON envelope），单个文本块目标64KiB；单个块不能装下时按字符边界继续游标，不返回半个JSON或伪EOF。元数据目录页≤200项且≤256KiB。
- 每个响应含`schemaVersion,requestId,scope,revision,status`；异步批次加`seq`，从0递增；终态`done|cancelled|failed`只发一次，错误有`code,message,retryable`，日志不含正文与凭据。
- 已发出的UI请求过期，前端不应用；服务端也尽快取消计算。后端取消登记先于worker检查，迟到批次不可发布；任务退出前仍占资源配额，不把“已收到取消”当资源释放。

## 4. 目录与窗口读取契约

### 4.1 list_children

输入：`scope,parentId,cursor?,limit<=200,requestId`。输出：`items[{id,parentId,name,kind,sizeBytes,sourceRevision,hasChildren}],nextCursor?,directoryRevision,complete,scanState`。

- 默认排序`kindRank,sortKey,id`；sortKey由固定locale无关大小写折叠算法产生，带sortVersion；原名显示不变。排序与现有行为差异必须写进G-PRODUCT，不依机器locale造成游标漂移。
- 使用keyset游标，不使用深OFFSET；游标为后端有限缓存中的随机opaque句柄，绑定scope,parentId,目录代、过滤、排序和lastKey，TTL=60s，单窗口最多32个。过期返回`CURSOR_EXPIRED`，不得继续别的目录。
- 任意子项增删/改名变更父目录revision；再次翻页发现版本变化返回`DIRECTORY_CHANGED`，前端按稳定ID保选中并重新获取。冷目录未盘点返回`scanState=pending,complete=false`，真实扫描时间由TEST计入，不用该状态冒充可操作首屏。
- 枚举错误不等于空目录；无证据确认移除不删除记录。超深路径返回明确unsupported原因而非静默漏项；基线树深度≤32，额外更深目录用于限制反馈测试。

### 4.2 open_document / read_window

`open_document(scope,fileId,expectedRevision?,requestId)`先检查类型/大小，返回`docId,revision,byteSize,encoding,mode,capabilities,initialWindow`。`mode=full-model|window-readonly|unsupported`；后两类是否可替代现有编辑由G-PRODUCT决定，不能自动认定授权。

`read_window(docId,revision,selector,maxBytes,requestId)`的selector严格采用§9的判别联合；返回`segments,sourceStartByte,sourceEndByte,canonicalStartByte,canonicalEndByte,nextCursor,eof,lineIndexState`。块可从行中开始，必须标`continuesPreviousLine/continuesNextLine`；10MiB长行仍按字节预算断块。随机行索引未就绪返回`INDEX_PENDING`及进度句柄，不能报空或编造行号。

行索引每1024行一个稀疏检查点，另限制两检查点间最多1MiB字节，防极长行扫描无界；文件变更后整代失效。跨块UTF-8/BOM/CRLF处理保留精确字节与行号，不以字符数推测字节。docId只持受检引用和块缓存，不默认保持整文件内存。

## 5. 搜索、任务与背压

### 5.1 搜索

`search_start(scope,query,requestId,maxResults=100)`返回任务句柄；结果流每批最多50项／64KiB，事件频率≤20Hz；无新结果不空刷。默认延续现有字面量查询语义；目录排除项和可搜格式在UI显式说明，不暗中加入额外ignore减少负载。

结果包含`coverage={snapshotEpoch,indexedFiles,pendingFiles,failedFiles,staleFiles,limited,reason}`, `searchedBytes`, `done`, `nextCursor?`。未完全搜索时“无匹配”只能表达已检索范围；不完整由顶层明确表示，不仅藏在日志。人类搜索和AI输出分别遵守原授权/预算，不能把人类大结果页注入模型。

### 5.2 调度

- 前台读/显式搜索、目录按需、后台索引三队列；保留1个前台执行槽，后台最多2个worker；同一文件写操作串行，所有DB发布经过单writer。
- 最多64个活跃请求、128个待执行任务；在途数据总64MiB，队列满返回`BUSY_RETRY`或背压等待，不无限增长。后台输入每轮最多8个块，每块处理后检查取消；交互有请求时后台停止预取。
- 元数据扫描每100项或20ms让出并查取消；正文每64KiB查取消。单文件任务过大不垄断队列：不同文件轮转。若有持续交互，后台至少每秒一个不超过20ms的CPU片避免完全饥饿，超额I/O异步限流。
- 同一scope的搜索新请求取消旧请求；防抖不替代取消。一般任务空闲等待有30s deadline；长期索引以5s进度心跳和明确阶段超时判断，不把固定30s当5GiB索引总时限。
- 流通道至少需要应用层ACK credit：每请求最多4批未ACK（总≤256KiB），无ACK暂停生产；5s无消费者取消只读请求，后台导入不取消，改将进度合并为最新快照。切窗口可重新订阅任务状态。
- 阻塞OS调用无法合作取消时保持`cancelling`并占配额，不能伪称worker已停止。格式解析器须可中断或隔离子进程，超过退出期限才能终止该任务进程，不结束整个应用。

### 5.3 索引状态

`queued → discovering → parsing → staging → validating → publishing → completed`；任意发布前态可转`cancelling → cancelled`或`failed`。`publishing`内取消与commit以单writer线性化：取消先获取fence则禁止发布；commit先完成则返回`completed,cancelTooLate=true`。不承诺撤销已完成原件写入。

进度区分原件复制、解析、索引发布；未知总量用已处理量，不编造百分比。错误可按文件重试且生成新attempt；同一失败文件不会让其它已发布对象失效。重启只恢复有持久记录的任务，先核原件与fence，不把旧内存回调续接。

## 6. 保存、脏状态与内存

- 活跃编辑交易只记录ChangeSet／docRevision和dirty=true，不调用全文字符串化；保存检查点持EditorState文档引用。撤销抵达已保存检查点可同步清脏；手工改回同文但不是同检查点时后台精确块比较，完成前保持dirty，不冒险报已保存。
- 同文件同时最多1个保存，后续保存请求合并为最新快照；旧快照提交后只确认submittedRevision，新输入不清脏。自动保存的排队/错误遵守CR048，不引入日常保存按钮。
- `save_begin(docId,baseRevision,submittedRevision,requestId,totalBytes)`返回保存句柄；`save_chunk(saveId,seq,offset,bytes)`按序写临时文件、累计校验；`save_commit`验证完整长度/摘要与基线。重复块必须内容一致，乱序或超预算拒绝；保存句柄不能用于另一fileId。
- Windows目标上持有受检文件与父目录身份，提交前复验外部改写；若平台无法证明无竞争窗口，拒写并保草稿，不能将普通rename描述为完整CAS。原子替换、flush、恢复步骤须由实现阶段针对NTFS/杀毒占用/父目录替换故障验证。
- requestId幂等结果登记本次commit outcome；崩溃后结果不明先比临时件/最终件与提交摘要，禁止盲目重写。原件已经保存但索引失败必须分开反馈。
- 进程树总私有内存1GiB候选包含索引worker；256MiB是worker子预算而不是额外加在总额外。缓存、CodeMirror历史、临时副本、WebView与Rust均纳入，不仅统计JS堆。
- 首期清洁模型可LRU淘汰；脏模型和未验证可恢复的撤销历史固定驻留。预算不足停止新完整模型载入并提供已有模式的可用动作；不能为达标清空草稿。磁盘卸载恢复后续另有数据协议与恢复测试，未通过前不启用。

## 7. UI状态覆盖与待制作登记

本节不是可操作UI稿；状态为“设计缺失、不得开发对应界面”。仍使用[唯一入口](../UI/仿真原型UI.html)，后续设计不得另开公开入口。

| 场景 | 页面／状态 | 必须保持／验证 |
| --- | --- | --- |
| SC-055-C1 | 编码树：加载、分页、空、不可读、游标过期、搜索中/无结果/部分结果 | 选中、键盘、滚动锚点、隐藏文件范围、取消真实反馈 |
| SC-055-C2 | 编辑：正常、大文本、模式受限、预算不足、保存中/失败/冲突 | CR048排版编辑与自动保存、IME不卸载、撤销/草稿不丢 |
| SC-055-K1 | 知识库：初次盘点/索引、已有索引、partial、stale、unknown、取消/重试 | 原件与索引状态分离，不以旧数据冒新版本 |
| SC-055-R1 | 知识树/正文/TOC：未加载块定位、跨块选择、复制与搜索 | 全文范围不受DOM挂载限制，标题唯一、无脚本/外链自动执行 |
| SC-055-R2 | GB窗口阅读与附件：索引未就绪、格式不支持、长行、原件导出 | 明确能力、进度、取消与完整性；不假装Office/PDF正文已支持 |
| SC-055-S1 | 上述全部：浅/深、1440×900/390×844、嵌套滚动 | UI-SCROLL-001：实际滚动出现，停止700ms隐藏，悬停不唤醒，正文宽度/草稿保持 |

采用[滚动条规范](../UI/文档/UI-CR049-滚动条按需显示.md)主方案所录版本/hash；UI准入须冻结实际新增资源hash、设计/软件成对动态证据计划。现有UI不因本包“落实”被自动替换。

## 8. 实施试验与停止条件

正式编码授权之后才执行以下最小技术试验，失败不绕过门禁：

1. C1：单百万行文档1000次输入/撤销，证明脏状态无全文热路径；大长行档位和实际功能与参考对齐。
2. K1：10GiB文本库在索引中同时读目录/搜已发布代，测全局锁、发布事务和WAL；若影子代磁盘空间不足，应保旧代并失败，不回落内存全量。
3. R1：稳定块ID与Markdown跨块语义、中文IME、跨块复制/查找与TOC未挂载定位；任何数据遗漏即停止该模式推广。
4. 每个包完成后按[测试设计](../Test/TEST-CR055-性能基准与故障验收.md)报告原始证据；未通过目标不得调整数据或丢弃样本后称通过。

## 9. 同版快照、坐标与源句柄

本节细化§3/4的唯一坐标规则。`read_window.selector`为带kind的判别联合：`{kind:canonical_byte,offset}`或`{kind:line,line1}`，禁止同时传两种。offset为0-based UTF-8 canonical字节，返回半开区间[start,end)，line1为1-based；offset超过已建立映射范围时返回INDEX_PENDING，不猜源字节。

- 原文件字节、canonical UTF-8字节和CodeMirror UTF-16位置为三种独立坐标。文本解码去BOM但保留原换行字符；canonical不执行搜索大小写归一化；编辑器若规范化换行，需额外变更映射。返回每段源字节范围、canonical范围与newline规则；UTF-16代理对不可拆，CRLF跨块仍计一个换行。
- 元数据/偏移字符串范围0～2^63-1，计算显式检查溢出；字节偏移必须在scalar边界，否则`INVALID_BOUNDARY`，不自动悄改选择范围。
- docId绑定`scope,fileId,OSFileIdentity,sourceRevision,encoding,snapshotKind,leaseExpiry`。Windows/本地受支持文件系统采用读句柄拒绝写/删除共享，租约期间原地写/替换必须被OS阻止；已有不兼容写句柄导致打开失败，不返回不稳定快照。平台无法提供该保证则只读派生不可变快照，或明确`SNAPSHOT_UNAVAILABLE`。
- 建立派生快照需要完整复制/解码时，完整准备时间计入测试S-READY，不能在复制之前报“文档已打开”。可先显示loading但不算PERF06首窗口成功。当前受检原件句柄能直接提供UTF-8首块时无需等待全文件hash；此时只证明受保护读取身份，绝不声称已通过AI源完整hash验证。
- 句柄空闲TTL60s；docId过期关闭句柄、取消未完成窗口读取，保留草稿/选择，返回`DOC_EXPIRED`。恢复先重新取得受保护句柄和源版本，不能复用旧revision接着读取新文件；任何版本不明返回`SOURCE_CHANGED`。不以无限持文件锁换“不卡”。
- 已发布canonical产物按generation租约读取，文件不可变；取消、关闭、scope销毁时释放引用。索引GC必须等待引用结束。行索引／大纲／映射写分页文件或DB，绑定同一revision与覆盖范围，不一次装载全文manifest/AST。

## 10. 分块保存的耐久与竞争细则

本节细化§6，不能假设当前编码区旧fs_write_file已经具备这些保证。

1. `save_begin`绑定冻结的submittedRevision、源身份、baseRevision/hash、编码/换行规则、totalBytes、预期最终SHA-256以及scope；编辑器继续输入另生docRevision。暂时无法计算最终摘要时先异步冻结并流式计算，未就绪不进入提交；UI持续响应且显示准备中。
2. 串行锁键为**规范文件身份**（本地卷ID＋file ID；新文件用受检父目录身份＋规范名称），跨项目/窗口指向同一真实文件共用，不能只用projectId/path。保存临时件同卷、独占随机名称并登记operationId；固定`.tmp_write`不可继续用于该协议。
3. append严格连续seq/offset，累计长度不超过totalBytes；重复块按seq与摘要核对，相同则幂等，不同则失败。缺块不可seal，乱序返回错误，不长期缓存任意乱序块。`seal`复核最终长度/全字节SHA、编码/换行以及提交快照身份；sealed后不可append。
4. `commit`须在同一文件互斥下取得独占可提交源保护，释放旧读租约到取得独占之间可能有外改，故**重新完整校验基线**并保持保护至替换完成。Windows受检句柄、父目录身份、替换操作是否能兼容保护由NTFS技术试验确认；无法无竞争实现则拒写而不是减弱CAS。校验／flush时间单列，不能据开始保存显示成功。
5. 耐久顺序：操作意图登记→临时字节完整且`sync`成功→受保护替换→必要目录/平台耐久屏障→commit outcome持久记录。只有所有必要屏障通过才返回`committed`；API能力不能证明断电耐久时保持验证缺口，不宣称已保存强保证通过。
6. `abort`提交线性化前取得取消token则丢弃本次暂存，原件不变；替换已成功但耐久屏障/outcome未全部完成时，不回滚，维持`committing,cancelTooLate=true`并继续完成屏障和登记，**不能提前返回committed**。仅持久outcome确认成功才返回`committed`；屏障或登记结果不能证明时返回`outcome_unknown/needs_recovery`，不自动重写。取消请求直接设置token，不排在索引写队列末尾。索引失败与原件最终commit结果分别返回。
7. `save_status(requestId)`读持久outcome；客户端超时/断线用原ID查状态，禁止换ID盲重写。崩溃恢复核最终件/临时件/基线摘要与operation intent，若都无法证明则保留冲突待处理；不能因结果记录缺失就默认失败或重新覆盖。成功响应携committedRevision，后续输入仍脏。

## 11. 全局资源预算与极端输入

以下为固定评审候选预算，最终G-PRODUCT/基线校准后锁定；总额突破必须停止新载入或背压，不能仅记日志。

| 资源 | 合计预算／范围 | 计入与释放 |
| --- | --- | --- |
| 应用所有自身进程私有内存 | 1GiB，包含WebView、Rust、全部索引worker，不包含外部CLI但另报 | 进程树峰值观测，不把JS heap当总内存 |
| 全部索引worker | 合计256MiB，不是每个256MiB | decoder/parser/chunk/terms/参数/清单/映射/IPC临时副本均计入；SQLite另有硬预算 |
| 全流水线在途载荷 | 合计64MiB，属于上面预算的子集 | producer取得credit才读，序列化放大先预留，consumer释放或任务退出归还 |
| SQLite读写连接页缓存 | 合计64MiB，属于1GiB | 每连接明确预算，最多1写2读；查询临时排序/FTS内存也测，超额任务停止 |
| 知识清洁预览＋代码清洁模型 | 各128MiB，属于1GiB | 按实际估计＋堆验证计字节；不能只数UTF-8正文忽略DOM/EditorState/历史 |
| 活动模型、脏草稿与撤销 | 在剩余总预算内，不能靠删除降内存 | 压力暂停新打开；2/5GiB只读窗口不可转完整模型；100MiB编辑待档位决策 |
| IPC | 每请求最多4批未ACK×64KiB，且仍计全局64MiB | 队列满停产，不能在消息通道堆积不可见副本 |

极端输入规则：标题／路径展示可做省略但原值分页保留；单字段响应超256KiB返回FIELD_TOO_LARGE并可定位原件，不伪造名称。词项/切片沿现有4KiB硬顶，超长词按同一版本化规则处理并显式coverage，不用无限字符串；是否影响现有全文语义先入G-PRODUCT，未定不能假称完整召回。单行/围栏/表格超过块预算写续片与状态，不能等待闭合才释放内存；章节/清单/映射在磁盘分页。图片解码候选每图≤40MP、并发1、像素缓存≤160MiB（属于1GiB），超出显示原件信息和受限原因；逐格式解压限额由K2独立确定，不沿用原件大小推断解压内存。
