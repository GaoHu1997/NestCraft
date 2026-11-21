# LLD-FEAT-008：本地知识索引与按需检索

> CR-055 v2候选增量（2026-11-21，仅设计）：[性能数据设计](../DB/DB-CR055-性能目录与索引发布设计.md)细化大规模处理。本文件§3.3/§6的严格新鲜度、按库BM25、授权及小增量原事务保留；超过旧删除＋新插入载荷上限的对象，拟以独立库代影子FTS＋短指针CAS替代大事务，变化文件仅重解析但FTS构建为O(全库)。若旧大源失效，候选G-SEARCH使同库全文暂不可用而不是WHERE过滤旧词项。**用户未确认G-SEARCH前，替代条款不激活、不得实施或视为已实现**；要求同库持续可搜必须另设排名设计并复审。大manifest/结构/映射须分页落盘，§3.1的逻辑JSON清单不要求一次载入；AI命中源完整hash仍保留，时钟按[TEST-CR055](../Test/TEST-CR055-性能基准与故障验收.md)分层，不能用300ms省略校验。CR055模式启用后，§3.3的文件published指针查询由`activeIndexGeneration → kb_index_member → parseGeneration`统一替代，搜索/outline/relations/read/引用均不得绕过member；kb_file.currentSourceRevision仍用于源新鲜度。旧published字段只可兼容投影，启用前仍按原协议。封存base摘要与小增量epoch/审计链分离，避免每次更新重算全库清单。原历史/§11 P0事实不改写。

- 版本：LLD-CR030-v1；状态：设计中，待评审；本轮没有解析器、FTS5、迁移、正式工具或真实性能结果。
- 依据：[CR-030](../PRD/CR-030-本地知识索引与按需引用.md)；唯一业务归属 [FEAT-008](../Plan/Feature/FEAT-008-项目知识授权与只读检索.md)，阅读关联 [FEAT-009](../Plan/Feature/FEAT-009-知识库目录与正文阅读.md)。
- AC 唯一源：[STORY-036 AC-08～13](../Plan/Story/STORY-036-知识库正式实现.md#cr-030本地知识索引与按需引用)、[STORY-009 AC-08～11](../Plan/Story/STORY-009-知识库项目授权与AI检索.md#cr-030本地知识索引与按需引用)、[STORY-014 AC-08～10](../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-030本地知识索引与按需引用)；本文不重复维护 AC 正文。
- 数据唯一设计：[DB-FEAT-008](../DB/DB-FEAT-008-知识原件切片与全文索引.md)；视觉唯一基准：[UI-CR030](../UI/文档/UI-CR030-知识索引与按需引用.md)，公开入口仍为 [仿真原型UI.html](../UI/仿真原型UI.html)；[测试计划](../Test/TEST-CR030-本地知识索引闭环验证.md)、[实际设计验证](../Test/REPORT-CR030-知识索引设计验证.md)。
- 授权边界：只调整需求／方案／数据／演示设计与设计验证，不改正式源码、依赖、运行配置、构建产物或真实业务数据；设计确认不是正式编码授权。

## 1. 现状、问题与本次取舍

已读取的代码事实，不是本次运行验收：

| 现状 | 依据 | 本次需要承接的差距 |
| --- | --- | --- |
| `.md` 扫描先删整库索引，读正文后仅存标题／相对路径／FNV 指纹 | [knowledge.rs:19–67](../../src-tauri/src/commands/knowledge.rs#L19-L67) | 原件稳定身份、增量 SHA-256、失败不清掉有效代、可恢复发布 |
| 标题未命中时逐篇读原文件找一行，结果没有全文相关度 | [knowledge.rs:260–313](../../src-tauri/src/commands/knowledge.rs#L260-L313) | 检索只查询已发布派生数据，分库全文排序，不全库重读原件 |
| `gateway_read/read_many` 返回整篇正文 | [knowledge.rs:412–457](../../src-tauri/src/commands/knowledge.rs#L412-L457) | 受限切片和引用范围、游标与预算，不能仅改工具名字继续全文注入 |
| SQLite/WAL 与项目授权已有基础；单连接全局锁 | [db.rs:12–25](../../src-tauri/src/db.rs#L12-L25)、[db.rs:61–90](../../src-tauri/src/db.rs#L61-L90) | 保留一个业务数据库，解析／文件 I/O 不持 DB 写锁，短事务及独立读快照 |
| Rust 端已有打包 SQLite，但没有本轮解析组件 | [Cargo.toml:17–32](../../src-tauri/Cargo.toml#L17-L32) | 获编码授权后才固定原生库版本与许可、验证 FTS5 编译能力 |

选定机制：**原件文件权威 → 本地确定性解析 → 不可变派生正文／定位清单 → 有限切片 → 同一 SQLite 内按库分区的 FTS5 → 授权搜索 → 按需读取切片 → 带版本引用 → 发送前再复检**。

- 不调用模型、云 API、OCR、外部 Java/Python 运行时、Office 安装或额外转换命令。所需 ZIP/XML/PDF/表格解析与词典算法作为应用内原生库／资源交付，不要求用户手动安装工具。
- SQLite FTS5 是唯一全文检索机制；按库分表用于统计隔离，不是增加第二数据库。原始正文和关系都不是另一套可编辑知识源。
- 不建设向量索引、自动语义关系提取或专用图数据库。显式链接和格式自身的父子关系足够支持有限关联导航。
- 原件保管、文件与 DB 分步对账继续 [CR-028](../PRD/CR-028-文件与数据库按职责存储.md)；不是把所有业务数据搬出数据库。

## 2. 格式、提取覆盖与可用性

解析接口固定返回 `format/parserVersion/coverage/blocks/locators/warnings/errorCode`。文件扩展名只作提示，必须结合签名／内部结构验证；未知结构不按成功处理。`coverage` 为 `text_ready / metadata_only / unsupported / failed`；保存状态与索引状态分开。即使只存元数据，也记录原件完整字节和格式边界。

| 格式 | 应用内确定性提取与定位 | 明确不承诺 |
| --- | --- | --- |
| MD、TXT | 受检编码解码，MD 标题／段落／列表／代码文本／显式链接；原文件 byte span 与行号可映射 | 不执行 HTML／代码，不抓外链；TXT 没标题就无标题目录 |
| CSV | RFC 4180 规则解析引用、逗号、跨行单元格；记录 `recordOrdinal/cellColumn`，表头只按明确选项识别 | 不以物理行号伪造跨行记录号；不猜列语义 |
| DOCX | OOXML 段落、列表、表格、页眉／页脚、脚注／尾注／备注的可支持文本；保留 `partUri/paragraphOrdinal/tableCell` | 未完成的组件明确列为 coverage warning；不由段落数推导页面，不追踪外部模板或执行宏 |
| PPTX | 按 presentation 真实幻灯片顺序提取文本框、表格和备注；`slideOrdinal/shapeId/notesPart` | 不从视觉位置猜阅读顺序；声明 XML 顺序，不高保真还原版式／图表语义 |
| XLSX、XLS、XLSB、ODS | Calamine 等可编入应用的只读表格库，工作表实际名称／顺序、单元格地址、类型、缓存值与可获得公式文本 | **cached value 不是重计算结果**；无缓存显示未计算／仅公式文本，不用 0 填补，不运行宏、不加载外部工作簿，不声称高保真 Excel 渲染 |
| PDF 文本层 | 原生 PDF 后端枚举 page tree，逐真实 page 读取文本对象，记录 1-based `pageOrdinal`，保留实际 page label（可空） | 提取顺序、字体编码、表格、公式可能有 warnings；无可靠字体映射失败或 partial，不捏造页码／坐标；不做 OCR、图像描述 |
| XMind | 识别 ZIP 中已知版本的 JSON/XML 内容结构，提取 sheet/topic 的 native ID、文本、备注、父子与显式连接 | 每种支持版本要有固定夹具；未知版本 unsupported，不把图形距离当关系 |
| FreeMind `.mm`、OPML | XML 节点文本／备注、native ID 或确定性结构路径、父子关系 | XML DTD/外部实体禁用；无 native ID 时 ID 只稳定于该修订，不承诺跨编辑不变 |
| 图片、扫描版 PDF | 文件名、格式、大小及本地可安全读取元数据；PDF 混合页逐页标 text/metadata-only | **metadata_only**，没有像素正文、OCR、自动描述；扫描页不能伪造为全文可搜索 |
| 旧 `.doc` 及其它未列格式 | 原件保管与 unsupported 原因 | 不静默调用外部转换、不把读取失败当空文档；不声称旧 Word 正文已解析 |

编码默认接受 UTF-8（可有 BOM）及 BOM 明确的 UTF-16；其它编码必须由用户明确选择受支持编码再解析，未知／坏序列返回 `ENCODING_REQUIRED`，不以替换字符静默丢内容。ZIP/XML 资源设展开大小／数量／层数护栏，禁路径穿越和递归附件执行。解析覆盖清单列出已提取部件、跳过部件和原因，正文部分可用不等于整个文档无损转换。

metadata-only 对象可以按名称和元数据发现，结果注明 `contentUnavailable`；`read_chunks` 不返回虚构正文。人类原件打开是单独的受权 GUI 操作，不赋予 AI 任意文件路径。

## 3. 原件与不可变代际

### 3.1 身份与文件布局

- `fileId` 为库内稳定 ID，`sourceRevision` 为该对象不可覆盖的修订；SHA-256 带算法标识。路径／同名／相同内容不等于同一身份。
- 托管导入：通过已授权文件句柄保存原格式字节到应用数据目录，名字仅显示；绑定目录：原件由外部所有者管理，不默认复制、不宣称已备份。
- 移动：已受管移动或可靠文件身份匹配可延续 ID；外部删除＋新建／身份不确定时等待核对，不能靠内容 hash 将两个同内容文件合并。旧 noteId 映射保留，旧无版本引用要求重新选择。
- 派生正文为 UTF-8 `content.txt`，结构及位置为 `structure.json`，清单含 sourceHash、parser/chunker/tokenizer/dictionary/schema 版本、字节数及 artifactHash；不可变路径按 `fileId/sourceRevision/parseGeneration` 组织。本轮没有创建业务目录。

### 3.2 保存与解析状态机

`登记 pending → 写临时原件 → durable 封存 → stored 登记 → queued → parsing → sealed → published`；解析结果可为 text_ready 或 metadata_only，unsupported/failed 都独立保留。封存、解析成功和发布成功是三件不同的事。

1. DB 短事务先写带 operationId 的操作意图；文件写入流计算大小／SHA-256，完成 `flush + sync` 与同卷原子封存，平台耐久能力须正式验证。不能宣称普通 rename 就解决断电与跨介质一致。
2. 原件封存成功但登记中断时，恢复仅对账已登记操作，验证封存清单／hash 后补 stored；无封存／损坏／磁盘满保留失败，不扫全盘猜记录、不删除用户原件。
3. 解析 worker 取得文件级 lease 和单调 fencing token，从同一原件快照生成临时派生文件，结尾复核 sourceHash 与 revision。解析过程中源已变化则 `SOURCE_CHANGED`，产物不能发布。
4. generation 封存后对其清单校验覆盖、切片、定位、链接和所有 hash；DB 暂存行仍不是当前可检索状态，FTS 不纳入这些行。
5. 取消递增 fencing token、标 cancelled 并使该 attempt 失效；同 operationId 幂等，同 generation 不能重新 resurrect。暂时 I/O 错误最多自动重试 2 次的设计默认，损坏／不支持／越权不自动重试；人工重试创建新 attempt/generation，不抹历史错误。

### 3.3 发布原子性与两个 writer

发布输入包含 `expectedSourceRevision/sourceHash/previousPublishedGeneration/leaseFence`。在一个 SQLite `BEGIN IMMEDIATE` 短事务内：

1. 比对原件仍 stored、源修订、当前 published 指针、lease owner/fence/expiry、所属scanRun的fence/取消、库／工具停用状态；任一不等返回冲突，不执行半发布。
2. sealed阶段已经一次性暂存该generation的chunks／outline／relations并完成manifest校验；publish只重新校验数量/hash/范围，不再INSERT相同主键行。先把旧published generation转retired（源已变则stale），再删其当前FTS材料，校验并为新代暂存chunk写FTS。
3. 同事务将新generation置published、更新文件 publishedGeneration与库 indexEpoch，写publish operation结果、使旧游标失效；一次 commit 对外发布。partial UNIQUE(one published)因此不会冲突。读快照只见全旧或全新，不见“r2 正文＋r1 目录／关系”；大纲／关系查询必须经published指针，不能直接读sealed暂存行。
4. 失败整事务回滚；若是相同原件的纯重建，原有效代可继续用。**源已变更／缺失／监控失效时旧代只能保留为历史，不能继续作为 current 的 AI 内容。**
5. writer B 在 A 失联后领取更高 fence；A 迟到的封存／发布／取消回调均被 CAS 拒绝，不能覆盖 B。文件清理也必须验证 fence、引用与路径，不能由迟到 worker 执行。

已检测的源变化先在独立短事务标 stale、从当前 FTS 删除旧材料、递增库 epoch，再排新解析；不等待新解析成功才隐藏过期内容。历史派生行可保留，不能污染当前 FTS 的 BM25 统计。重建只重建派生项，不重建授权、原件身份、会话和验收历史。

## 4. 切片、定位与关系

### 4.1 无丢失切片

- canonical 提取正文是未做搜索归一化的 UTF-8 文本。**全部偏移是 canonical 文件的 0-based UTF-8 byte offset，区间为 `[startByte,endByte)`，必须位于 Unicode scalar 边界**；不是 JS UTF-16 index，不是原 Office ZIP 的字节地址。
- canonical 与源位置映射独立：直接文本可以有 original byte span／行；Office 为 XML part／段落／单元格；PDF 为真实 page；思维导图为 sheet/topic/path。`locator.kind/precision/sourceRevision` 必须明确，取不到 native offset／坐标就 `unknown`，不得制造页码、字符坐标或节点 ID。
- canonical 块按原文格式顺序流式拼接，保留表格行／单元格／章节分隔符；任何提取归并必须在 coverage／mapping 说明，禁止只保存前若干字当全文。
- chunker 优先章节／段落，禁止跨 PDF page、sheet、slide、mindmap node 的自然定位边界。每片默认 ≤4096 UTF-8 bytes，长单块按安全字符边界续分。**正文片段不重叠**；manifest 证明范围连续覆盖 canonical 正文，合并时只按 ordinal 拼接，不重复加入标题或前后 overlap。
- 相同文本在两个真实单元格／节点是两个有定位的块，不因文本相同去掉业务内容；同一块重复解析靠 `(generation,ordinal)` 与范围约束拒绝。边界标签／title/context 是元数据，不混进正文 offset。
- FTS 可保存有限 chunk text 与词项用于检索，不提供直接编辑接口；大解析正文仍在只读派生文件，所有派生材料可从原件同版本重建。原件是权威，不从 chunk 拼接回写原文件。

### 4.2 有出处的显式关系

支持 `contains / parent_of / explicit_link`，每条附 `fromGeneration/fromLocator/原始链接文本或格式nativeEdgeId`，不是模型推断的语义三元组。文件树关系与思维导图父子边分别命名，不混为内容语义。

只解析同库受检链接；跨库／外网仅显示“外部链接，未读取”给所有者，不自动抓取或传给 AI。同库遍历本轮固定 **depth=1、最多10条**，只返回已授权且 current 的目标 ID／locator；坏链接／未知锚点标 unresolved，不跳其它同名文件。源代替换使相关边失效，target 修订变化后再解析目标锚点；关系导航和来源打开重复校验权限／版本。

## 5. 中文全文检索及分库统计

### 5.1 固定本地 pipeline

选定 `tokenizerVersion=local-zh-v1`：应用内许可明确的版本化中文词典＋最大正向匹配（先最长词，等长按词典固定顺序，最多8个汉字）；未登录字按单字输出。词典 hash/版本随 generation 记录，变更须重建该库全部词项并原子切换，查询不混用两个版本。

1. 展示正文保持原样；搜索副本做 NFC、全角 ASCII 折叠、Latin 小写、明确标点分隔，不做繁简转换／同义扩展。归一化映射保留到 canonical byte span，不能用归一化偏移给原文定位。
2. 中文连续片段按词典匹配；Latin／数字按明确字符边界；词项 UTF-8 编码后转 ASCII hex，并加 `w` 前缀，用空格分隔送 FTS5 `unicode61`。另生成中文相邻字符 bigram，编码加 `b` 前缀，放辅助列。无需依赖 FTS 默认词法来猜中文词界，也不把自带 bigram 称为语义模型。
3. 索引与查询使用同一版本 pipeline。用户 query 是 **literal**，`AND/OR/NEAR`、引号、`*`、冒号不解释为查询语言；通过宿主构造受检词项表达式、绑定参数，用户文本不拼 SQL／表名。
4. 主检索为全部去重词项 AND；未知词／跨词界可走全部 bigram AND 辅助召回，并对派生原文核验对应归一化文字／词项，去掉偶然分散组合。辅助召回另标 `retrievalMode=bigram`，不冒充精确短语或同义检索。
5. 查询只有一个 Unicode 字符时，先使用已索引的单字词项；再在**当前授权库的 DB 派生 chunk text** 做受限候选子串扫描（每页最多1000行、最大4MiB、可中断）。不读原件、不无界扫描；超护栏返回 `partial/incompleteReason/nextCursor`，不是“全库无结果”。两字及稀有组合用 bigram；不用 trigram 的三字符限制掩盖短词缺口。
6. query 默认最多128 Unicode scalars，最多16个主词项；过长／控制字符非法明确拒绝。候选最多100片，返回最多5项；检索按全文切片而非只搜标题／前200字。

### 5.2 排序与泄露控制

每库只使用自己已发布且可搜索的 FTS 表；title_terms／heading_terms／body_terms／bigram_terms 的 BM25 权重初值 `8/4/1/0.2`。FTS5 的 `bm25()` **通常负值且越小越相关，ORDER BY bm25 ASC**；不套正值阈值，不以 `score>0` 过滤全部命中。本轮不设未经数据校准的统一相关度 cutoff。

精确词项召回为第一层，辅助召回为第二层；库内按 BM25、fileId、chunkOrdinal 稳定排序。跨已授权库合并用确定性 reciprocal rank（常数60），只合并各库名次，不比较不同库 raw BM25，输出名次／命中字段而非未授权统计或全局 IDF。加入／更改未授权库不能改变已授权库的词项统计和结果次序。分页绑定完整授权库集合、query、过滤与各库 indexEpoch，任何变化需重新搜索。

`status/format/library` 是受检结构过滤，不由模型传 SQL。metadata-only 可出现在名称查询中，但注明没有正文；stale／failed 不能当正文命中。被拒库不计总量、摘要、索引大小或扫描次数。

## 6. 新鲜度、授权与读取边界

- 绑定目录采用源监控＋启动对账＋人工重新扫描；通知不是事实，size/mtime 不变不能证明字节未变。库级`kb_scan_run`记录包括空库在内的盘点、批取消、fence与固定计数schema；file operations关联同库scanRunId。inventory changed/unchanged/missing与outcome text/metadata/unsupported/failed两轴分计，不混加；计数在操作幂等状态转换事务中更新，partial／interrupted不报“全部完成”。重启scan run终结为interrupted，显式重试新run，不自动复活旧回调。
- 注册监控与建立基线之间的事件要补偿，事件积压／丢失／无支持平台／重启后未对账标 `freshness=unknown`，授权 AI 内容请求 fail-closed 返回 `INDEX_FRESHNESS_UNKNOWN`；所有者可查看明确 stale 历史，不向 AI 静默继续提供。
- 搜索候选来自 DB，不遍历／解析所有原件。对本次最终输出正文的最多5个绑定源文件，受权后验证**这些文件**的完整 SHA-256 与当前 generation；`read_chunks` 同理仅验证涉及的源对象。hash 读取不等于重解析，不生成 token；仍有选中大文件 I/O 成本，性能不能描述为0。
- 普通 stat／监控缓存不足以省略绑定源的该次内容校验。托管不可变原件可依据受限 writer、耐久清单及派生文件完整性复用验证；检测任何外部写入迹象使其 stale。完整源 hash 与派生 hash 不能混为一项。
- 内容核验返回 `verifiedAt/sourceHash/freshness`，只证明该次所选文件快照；**不能承诺所有未检测修改都不存在**。支持的 Windows 绑定读取应持拒绝写／删除共享的源句柄完成核验与响应入队，结束后释放；无法建立等价线性化点的平台／运行模式不得声称强实时一致，须保持 unknown 拒 AI 或仅提供托管模式，待真实能力验证。
- 内容准备前及**返回／发送前**均查询最新库启用、grant revision、tool schema／开关、publishedGeneration、indexEpoch 与监控状态；撤权与最终提交响应共享短暂授权线性化边界。授权 epoch 改变时丢弃准备结果，不返标题／摘要／正文；已经发出的历史不能收回。`grantRevision`是新增单例`kb_access_epoch.revision`：现有grant表没有revision且撤权DELETE，故不从grant行推测版本；授权仍以原grant表为唯一来源。授权保存／撤销／重授、停库／移除、知识工具范围/schema变化在原业务修改同事务推进epoch，保守使所有旧知识账本失效；迁移只初始化epoch不新增授权。
- 项目身份／session／round／执行范围由宿主注入，模型不得自报 projectId 或任意 path。原件／派生文件／FTS／搜索摘要／关系／缓存／human打开来源都由同一定位与授权服务检查。
- 真实 CLI 若能经原生文件、shell 或其它 MCP 旁路读取知识源，要有执行层强制隔离；当前配置提示词不是隔离证据。未具备该能力时不启动需隔离的知识任务。

## 7. 拟议只读工具与游标

这些是未来契约，不代表已注册工具／IPC。共同输入只含库稳定 ID、文件 ID、当前版本、受检 selector 和不透明 cursor；`additionalProperties=false`。完整 locator 只作为来源证据，不接受其为读取路径。共同输出为 `schemaVersion/status/items/citations/truncated/eof/nextCursor/usage`，错误没有旧正文。

| 工具 | 本轮输入与默认输出 | 边界 |
| --- | --- | --- |
| `knowledge.list` | 可选已授权库筛选；最多20项库/对象元数据，无正文 | 不泄露未授权库及数量；metadata-only／失败／新鲜度清楚 |
| `knowledge.search` | literal query、格式／状态过滤、可选已授权库；最多5条，每摘要≤400 Unicode scalars | 全文索引查找；含命中 chunk ID、完整 locator、源修订/hash、索引epoch／召回模式；无命中与错误/扫描不完整分开 |
| `knowledge.read_chunks` | `fileId/sourceRevision/parseGeneration/chunkIds`（最多10个）或 cursor | 严格按当前代读取、每项有范围；不展开全文，超大单块安全续分，余下内容用游标 |
| `knowledge.outline` | 当前文件版本；每页最多20项标题／page/sheet/slide/topic 概览 | locator 不可截断；无可靠标题／位置给 unknown，不由摘要杜撰 |
| `knowledge.relations` | 当前文件/节点版本；depth固定1、最多10条 | 只有有出处的显式关系，目标逐项受权，不自动加载目标正文 |

采用**一个方案：随机 opaque token＋SQLite 服务端游标账本**。宿主生成256bit CSPRNG token，仅保存 token SHA-256；token不携带路径／权限。账本绑定 `session/project/round/queryDigest/selectorDigest/grantRevision/toolSchema/各库indexEpoch/源版本/nextPosition/byteBudget/expiry`，10分钟为可逆默认。模型不可增大页限或重绑 query；续读仅接受 cursor 和向下收窄的 maxBytes。

游标消费与预算预留用短事务 CAS；成功只消费一次。每个新请求在同一事务建立prepared receipt与预留，使用receipt状态防重；进程仍存活时确定失败可同事务回收该预留。**重投同requestId或投递状态不明一律`retry_requires_reselect`，中止该知识请求／关闭该轮，保留用户草稿，不重放正文、不继续新页，也不能把duplicate当成功。**宿主检查该轮是否已进入原生模型线程；无法证明时停止旧线程、显式新建，再重新搜索选择。已消耗bytes不退还，也不通过重投获得免费reference。

超时、撤权、源/索引/过滤变化一律失效；opaque字符串不存在／伪造统一拒绝。**应用／宿主进程重启后关闭所有旧active/exhausted round、revoked旧cursor与prepared receipt、清该closed round预留但保留usedBytes和审计，访问epoch++，不恢复游标或续接旧预算轮。**只恢复人类历史及草稿的显示；重新选择知识创建宿主新轮，且不得自动重启原模型请求。故本版不需跨重启按request恢复reservation，也不声称自动恢复exactly-once投递。

错误码：`NOT_FOUND_OR_DENIED / SOURCE_CHANGED / INDEX_PENDING / INDEX_FRESHNESS_UNKNOWN / CURSOR_INVALID / RETRY_REQUIRES_RESELECT / INVALID_QUERY / INVALID_SELECTOR / BUDGET_EXCEEDED / UNSUPPORTED_FORMAT / METADATA_ONLY / PARSE_FAILED / READ_FAILED`。内部日志记录受权对象与真实原因，对外统一不可访问错误不泄露对象是否存在。

## 8. 字节预算、去重与旧引用兼容

1. 本轮拟议默认：**单次完整 JSON 响应 UTF-8≤8192 bytes，单宿主输入轮累计知识响应≤32768 bytes**；search最多5项、摘要各≤400 Unicode scalars。数值是可逆设计护栏，非用户事先确认的性能／费用／token承诺，确认后才成为正式配置基线。
2. 预算包含 metadata、summary、outline、relations、citations、locator、usage 和 JSON envelope；序列化后实际计数，usage中的字节数字采用稳定重序列化核对。locator必须完整；装不下整项就不返回该项，截正文只在字符边界并带 `[startByte,endByte)`、`truncated=true/eof=false/nextCursor`。最小合法 envelope也装不下则明示预算耗尽，不伪造 eof。
3. 轮由宿主创建，子代理／重试继承同一预算账本，不能自报新 round 绕限。引用历史不证明模型仍有正文；去重以**既有上下文编译器**维护的`nativeThreadRef/contextEpoch/residencyState`为唯一驻留依据，新引用表只存其受检投影，不新建独立上下文事实源。只有thread/contextEpoch、file/revision/generation/range/schema/grant完全匹配且state=resident，才只传reference。ejected/unknown、摘要淘汰、线程重建或重启全部重新读取并按实际bytes计，不伪报免费命中；投递不明按retry_requires_reselect终止，不能据prepared receipt标resident。
4. 原先长工具结果被摘要时，只能使用本地受限摘录和来源；摘要也计轮预算，不能把整篇隐藏在工具meta、system、附件或历史里。预算约束只控制知识输入，不等于整个模型窗口或费用的硬封顶；总输入还需与现行上下文编译器按实际历史／工具定义／用户输入和输出预留复检。tokens未知明确 `null/unknown`，不造精确token、不当0。
5. 旧 `knowledge.read`/`read_many` 仅保留版本化兼容适配：转 outline／明确选择的受限首段或 `read_chunks`，沿同一次预算，输出明确 `compatMode/truncated/nextCursor`，从不循环自动拼成整篇。无版本旧引用保留于既有消息refsJson／历史引用记录，以legacy映射标needs_reselect；不向要求sourceRevision/hash非空的新表填伪值。重新搜索选择成功才创建新版本化记录，不把旧noteId直接全文注入。
6. 引用保存完整 fileId/libraryId/sourceRevision/sourceHash/parseGeneration/range/locator/grantRevision；恢复／打开／发送都复检。源更新需要重新选择引用，不把r1范围悄悄移到r2。撤权清候选、已准备正文、缓存和待审操作；已展示历史标不可再用。原生线程无法确认清理该正文时停止旧线程并显式创建新会话，不能靠一句“忽略”保证收回。
7. 缓存必须在内容生成前及返回前授权复检，key含上述版本、范围、工具schema、授权和新鲜度；缓存命中不等于0token，不重复入上下文才避免重复正文。
8. 每轮32768 bytes内预留512 bytes控制响应额度，普通内容不得占用；最终预算错误/剩余提示也计入该轮。控制响应发出后账本closed，宿主停止继续派发知识工具，不能靠无限错误响应越限。若请求的单次maxBytes连最小完整envelope也不足，调用前拒绝，不构造半个JSON；本机UI提示不是向模型隐藏新增正文的通道。
9. 发送预检任一引用stale/denied/needs_reselect时保留草稿和失效列表，不默认删掉失效项后发送部分上下文；用户明确移除或重选后重新预检。工具返回少量内容与用户确认“允许缺资料发送”不是同一件事。

## 9. 工作包、准入和恢复

| 包 | 输入／范围 | 产物／完成门槛 | 依赖 |
| --- | --- | --- | --- |
| K1 身份与存储 | CR028原件边界、稳定ID、目录/托管模式 | 隔离库/文件中的耐久保存、SHA-256、操作幂等和对账测试；无自动删源 | 明确编码授权、容量/保留策略关键项已确认 |
| K2 解析与定位 | 已登记受检源、格式夹具 | 各格式coverage、immutable清单、定位、无丢字无重复、零模型/网络/外部程序；不支持单独报 | K1；原生组件版本/许可/平台验证 |
| K3 代际与FTS | 固定tokenizer/dictionary/chunker、schema | FTS5能力检测、分库索引、CAS/fencing、失败回滚、中文和短词；旧代统计排除 | K2；DB故障恢复测试 |
| K4 按需网关 | 宿主身份、授权、当前代 | opaque账本、UTF8预算、去重、legacy引用失效、返回前撤权复检与CLI旁路拒绝 | K3；现有上下文编译/执行隔离 |
| K5a 可视承接 | 有效UI-CR030场景/版本 | 管理/导入/增量状态/过滤/定位/引用/错误/恢复/窄屏；同条件设计软件成对证据 | 上述独立合格包；UI覆盖准入 |
| K5b 完整闭环 | 全部已确认AC、隔离样例 | 导入→检索→切片→引用→更新→过期拒绝→重建→重新引用→撤权→恢复；备份故障和性能证据 | K1～K4、K5a；用户验收依据 |

迁移不在本轮执行：先停相关writer并备份SQLite（含WAL一致性）和原件／受管派生清单；检查旧noteId映射、现有grant，默认不增权；建新派生表/库内FTS，先离线重建再核验发布。旧无版本引用标needs_reselect；不能直接把旧全文历史当新缓存。回退先禁新工具／writer，保留新原件、授权和会话；有新业务写入时向前修复，不恢复旧库覆盖新正文，不回落到全文旁路。失效／缺损授权保持拒绝。

设计DoR还须明确原生库版本/许可、目标平台绑定源线性化能力、格式夹具覆盖、容量/总量/保留期限/异常UI版本和正式编码授权；缺项不是“后续小优化”。本轮仅三文档方案整理，正式测试全部未执行。

## 10. 性能目标、未决项与风险

- 待实测目标：在明确Windows设备、SSD、10,000文档/约100,000切片固定夹具上，**纯DB检索**暖缓存p95≤300ms；该目标不含所选大源SHA-256核验和解析耗时。分别报告冷启动、hash I/O、首次导入/增量、峰值内存/索引体积、中文召回；不先宣称毫秒检索或固定节省比例。
- 单文件200MiB、展开最大512MiB／10,000成员／层数16、worker并发2、自动重试2次是**待确认的拟议技术护栏**，不是用户已确认产品容量；额度耗尽保留原件和失败原因。总库容量、磁盘低水位、备份保留期会改变产品行为，须需求阶段决定。
- 图片/扫描件metadata-only、旧doc unsupported 是本轮边界，不通过本地小模型或隐藏外部命令绕过。某PDF字体／旧表格结构仍可能failed；“列格式”不是已经支持，正式上线需对应夹具与失败行为结果。
- 词典分词＋bigram不能得到同义／语义召回；匹配质量和排序参数必须用冻结query集校准，调整版本使游标/索引失效。单字扫描不完整要显式说明，不能以受限扫描假报全覆盖。
- 外部绑定源存在通知丢失和读取竞争；只保证受检快照，不承诺没有未检测修改。不能验证严格读取的平台先不开放该模式AI，不因为管理页能打开就宣称隔离可信。
- UI纯演示不能证明实际SQLite/字节硬限/监控/线程清理／权限／故障恢复；实际证据统一记录到[REPORT-CR030](../Test/REPORT-CR030-知识索引设计验证.md)，未来按[测试计划](../Test/TEST-CR030-本地知识索引闭环验证.md)逐项补测。

## 11. P0 实现记录（2026-11-21，CR-030-D1）

本节登记 CR-030-D1（切片 + SQLite FTS5，不引入向量）正式编码后的实际落地与设计偏差。实现位置：`src-tauri/src/commands/kb_index.rs`（切片/词项/发布/检索/网关）、`knowledge.rs`（三入口/搜索/网关命令）、`knowledge_files.rs::indexable_text`、`db.rs`（迁移接线）、`chat.rs`（注入）；验证与数字见 [REPORT-CR030-D1](../Test/REPORT-CR030-D1-切片与全文索引实现.md)、[IPC 冒烟](../Test/smoke-report-cr030-d1.md)。

### 11.1 实际落地表集与 FTS 形态

- P0 最小表集：`kb_library_state(libraryId PK REFERENCES knowledge_library, partitionNo UNIQUE>0, indexEpoch, tokenizerVersion, updatedAt)` + `kb_chunk(chunkKey INTEGER PK, libraryId, noteId, relativeUri, parseGeneration, sourceHash, ordinal, kind('body'|'metadata'), startByte, endByte, text, title, heading, startLine, endLine, UNIQUE(libraryId,noteId,parseGeneration,ordinal))`；迁移 `migrate_cr030_knowledge_index`（CREATE IF NOT EXISTS，末尾 `INSERT OR IGNORE schema_version=2`），不动 knowledge_library。复用 knowledge_note_index 作文件登记（仍仅 Markdown，前端 noteCount 语义不变）。
- FTS 表形态按评审 D2 结论执行：**普通 FTS5 表（应用侧 INSERT 词项行，rowid=chunkKey，退役按 kb_chunk 存储行取精确 rowid 集 DELETE），不用 external content**——两评审分歧（D1 建议外挂内容表 vs D2 应用侧写入）按 D2 执行；每库一张 `kb_fts_l<partitionNo>`（partitionNo 由 kb_library_state 单调分配、宿主代码生成表名、绝不拼输入），四列 title/heading/body/bigram_terms，bm25 权重 (8.0,4.0,1.0,0.2) ASC，detail=full；FTS 表在该库首次发布时（分配 partitionNo 处）创建，不在启动迁移建；测试固定执行 `integrity-check`。FTS5 运行时探针（实现会话第一条 cargo test）通过。
- 评审 D1 建议的 FTS 列名与 kb_chunk 列名不匹配的 snippet 隐患，通过「检索 JOIN kb_chunk 取 text/title/heading 生成片段（归一化 1:1 字符映射定位）」消除，不使用 FTS5 snippet 函数。

### 11.2 实际切片与词项参数

- 切片范围：md/markdown + txt/log/text/json/csv 走切片（read_text 既有能力，零新增解析器）；pdf/docx/xlsx/图片/未知 = metadata_only（kind='metadata'，text 空、startByte=endByte=0，文件名/路径可搜，AI read 显式 `METADATA_ONLY` 拒绝）。文本读取失败沿用既有显式失败语义（invalid UTF-8 阻断扫描，不静默降级）。
- 参数：目标块 2048 UTF-8 bytes、硬顶 4096、无重叠连续覆盖、标题面包屑进 heading 列（不进正文 offset）、受保护区间（围栏代码状态机、MD 表格）整段保护 + 超长强制续分、相邻小块合并（coalesceTiny，仅相邻区间）；**不做 CRLF 归一化**——offset=同一次 read_text 内容的原始字节（gateway_read 可按相同路径重建），行号按该内容计。
- Validator 最小集（byte 口径）：①0 块拒绝降级（空文件/空内容落 metadata 兜底块）；②单块 >2×目标降级；③maxLen>硬顶先续分（bug 检出），续分后仍超限才失败；④<50 bytes 非尾块占比>1/4 且>2 降级；⑤全员远小于目标（<1/4 目标且≥4 块）哨兵降级。md 两层链：主导标题层级（DominantHeadingLevel）→段落递归→字符边界 force-split；txt/json/csv 一层（段落/行）→force-split。
- 词项管线（无词典 P0 简化）：unicode61 不切中文，词项 hex 化——四列存 `w<utf8hex>`（拉丁/数字/其它文字整词）/`b<utf8hex>`（Han 相邻二字组）空格分隔 ASCII；CJK 判定用 Han 区间表（U+4E00–9FFF、U+3400–4DBF、U+F900–FAFF、扩展 B–F），分隔符=空白/标点/符号类别，按 char 边界处理；归一化=全角 ASCII 折叠+拉丁小写（1:1 字符映射，保证片段定位回原文）；**单字查询走受限扫描路径（护栏 1000 行/4MiB + incomplete 标记），不用 `单字*` 前缀**；bigram AND 命中统一经归一化原文子串核验去掉偶然分散组合（同时拦截 hex 同形碰撞）。索引与查询同一 Rust 函数同一版本，`tokenizerVersion='local-bigram-hex-v1'` 落库。

### 11.3 发布、检索与网关的实际行为

- 三个既有入口同步扩展：saved_note→publish_note 同事务追加切片+chunk/词项替换+indexEpoch++；upload_selected 文本格式同路径 publish；kb_scan 文件 I/O 与切片在事务外完成、单短事务发布整库 chunk/FTS/epoch++。失败沿用 index_error 语义，不静默回退读原件。
- 代际：发布事务内 indexEpoch++，chunk.parseGeneration=发布 epoch；检索经每篇 `MAX(CAST(parseGeneration))` 子查询只取当前代 + 删除式退役（历史代行不保留，登记偏差 §11.4）；gateway 校验 chunk.sourceHash ↔ note_index.contentHash，否则 `SOURCE_CHANGED`。
- 惰性回填：kb_search/gateway_search 对无状态库（kb_library_state 缺失或 epoch=0）先按库内联完整重建再检索；失败该库显式退出本轮（eprintln + 不参与），其它库正常；锁序=MUTATION 先于 DB 连接（与保存路径一致，防死锁）。实测首搜回填 120 文件=813ms（<2s，暂不后台化）。
- 搜索只查派生索引不读原件；维持每文件一条命中（多 chunk 取最高分）；人类 kb_search ≤100 条（KnowledgeHit 结构不变，snippet=最高分 chunk ≤400 码点片段）；AI gateway_search ≤5 条、metadata 命中登记 `contentUnavailable:true`、单字护栏登记 `incomplete:true`；跨已授权库按确定性 RRF（常数 60）合并，不比较跨库 raw BM25。登记表路径 fail-closed 校验保留（穿越路径使该库搜索显式失败）。
- gateway_read 有界契约：AI knowledge.read 改结构化响应（整块 ≤4096 + 完整出处 + nextCursor=`noteId:下一ordinal:sourceHash`）；续读校验 hash/授权/越界；maxBytes 仅向下收窄；单次完整 JSON ≤8192 bytes（fit_response 字符边界收缩，metadata 永不截断，最小 envelope 装不下显式 `BUDGET_EXCEEDED`）；人类 kb_read 保持整篇不动；chat.rs 注入换片段读取，模板加 libraryId/revision/range 属性，同轮同 (noteId,ordinal) 去重，MAX_REF_TEXT 64KiB 保留为最终硬拒。

### 11.4 已知偏差（相对 §3–§8 完整设计）

1. 无版本化中文词典/最大正向匹配（`w` 仅拉丁/数字/其它文字整词）；无 NFC/繁简转换（归一化=全角折叠+小写）。
2. 代际账本简化：无 kb_generation/kb_file/kb_revision/lease/fence/CAS（单连接单写者）；历史代不保留（删除式退役）；relation/outline/游标账本/scan_run/预算轮账本/每轮 32KiB 累计全部延后。
3. nextCursor 为 ordinal 粒度：maxBytes/预算收缩后块内剩余不可续读（byte 粒度游标随 K4 实施）。
4. 每轮 32KiB 累计账本与新鲜度监控（freshness unknown/绑定源 SHA-256 终读校验）本轮不做；gateway 校验=chunk.sourceHash↔contentHash+游标 hash。
5. kb_chunk 增设 relativeUri 列（设计列集之外）：为保持 note_index 仅登记 Markdown 而落 chunk 行，供命中显示与 fail-closed 校验。

## 12. CR-055 v4–v9 索引物理优化（2026-11-22 实施记录）

依据用户 2026-11-22「索引空间/时间要达标，修改吧」与[10GiB 基准](../Test/BENCH-CR055-真实索引基准.md)，对 FTS 词项与表形态做了五轮实测优化。完整取舍与未决项见[索引发布设计 §8](../DB/DB-CR055-性能目录与索引发布设计.md)。

| 变更 | 之前 | 之后 | 依据 |
| --- | --- | --- | --- |
| 词项编码 | `hex_term`（`%02x`，汉字二字组 6 字节 → 13 字节） | `index_term` 直出 UTF-8 字面 | 去 hex 是空间下降的主要来源之一 |
| tokenizer 版本 | `local-bigram-hex-v1` | `local-utf8-v2` | 新旧词项不同构，必须升版 |
| FTS 内容存储 | 普通 fts5（自带 `%_content` 副本） | `content=''` + `contentless_delete=1` | 去掉一份词项副本，同时保留按 rowid 删除 |
| 详细度 | 默认（full） | **`detail=full`**（曾试 `detail=column`，已撤回） | `detail=column` 下 `bm25()` 恒为 0，相关性排序静默失效，且多 token 词项会触发 phrase 报错 |
| 批次 | 64 行 / 256 KiB | 512 行 / 2 MiB，单行独立 64 KiB 护栏 | 批次数下降约 8× |
| 词项计算 | 每 chunk 重算 title/heading | 按 `relative + U+001F + title + heading` 缓存 | 同文件内 title/heading 词项相同 |
| 段合并 | `automerge=2` | `automerge=8`，发布前 `optimize` 一次（失败写 `kb_snap_job.error`） | 逐段频繁合并是主要时间开销之一 |
| 检索文本 | 每 chunk 存 `text + 512 字节 lookahead` | 归一化结果与原文完全相同时存空串（读取回退） | 减少重复（实测命中率低，保留为无损优化） |

### 12.1 版本闸门（升级安全）

升级后既有索引的词项与当前查询不同构，若不处理会静默 0 命中。已加两处闸门并在发布路径保持可重建：

- 快照路径：`kb_snap_generation.tokenizerVersion` 不匹配 → `SNAPSHOT_REBUILD_REQUIRED`。
- 旧 P0 检索路径：`kb_library_state.tokenizerVersion` 不匹配 → `INDEX_REBUILD_REQUIRED`。
- **发布路径不拒绝**：`ensure_partition_tx` 只保证表存在、**不改版本**（它被单篇替换路径共用）；单篇替换由 `require_current_tokenizer_tx` 显式拒绝；只有整库替换在全部词项重写后才把版本刷成当前值。否则旧库会“先被拒绝、又无法发布”，永远无法重建。

### 12.2 实测结论

空间（库大小 ÷ 已处理源字节）：基线 **7.5×** → `detail=column` 时期 **3.68–3.72×** → 当前 `detail=full` **3.92×**。时间（release）按 v7/v9 进度外推约 130–180 分钟，未达标。

**2× 空间预算在现行参数下不可达**：`SEARCH_OVERLAP=512` 是 128 字符查询的最小 lookahead，FTS 词项本身约 1.16× 源。要进一步降必须改方案参数（lookahead 改读取时拼接、chunk 目标 4096、或索引不自包含正文），均需评审确认。

### 12.3 未验证

真实 Tauri IPC 端到端、10GiB 完整完工时间与最终库大小、旧库升级后“单篇保存被拒 → 用户重建索引”的完整 UX、非拉丁脚本在应用层的端到端检索。
## 变更记录

| 版本／日期 | 依据／范围 | 结果 |
| --- | --- | --- |
| LLD-CR030-v1／2026-11-19 | 用户要求推荐方式调整需求／设计、逻辑闭环；复用现有知识与阅读Story | 新方案文档，设计中；无编码／迁移／运行授权，未实现与验收 |
| LLD-CR030-D1／2026-11-21 | 用户 2026-11-21「我更正了需求和设计，你需要对照进行开发和调整」=编码授权；CR-030-D1 切片+FTS5 P0 | §11 P0 实现记录：表集/FTS 形态（应用侧写入，按评审 D2）/切片参数/词项管线/三入口/有界网关/惰性回填落地；cargo test 119/120（唯一失败属并行会话 r6 avatar）；npm build 被并行会话 r6 前端阻塞；偏差与遗留登记 §11.4；待用户验收 |
