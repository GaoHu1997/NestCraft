# LLD-CR055-FEAT008：执行记录

- 执行身份：projectId=`NestCraft-workspace-D-github-AI_Delelovelop`（仓库开发身份，非业务DB）；唯一featureId=FEAT-008；Story036 CR055-01～06；WP-K1/K2。
- 授权：用户2026-11-21 15:35“执行吧，进行开发”；本执行上下文由主代理分配知识后端唯一writer。不得更改编辑器/Reader源码。共享mod.rs/lib.rs/db.rs仅按各Feature明确请求最小集成；不改Cargo依赖；不自行运行cargo/build。
- 现有未提交改动已保留：knowledge.rs、knowledge_files.rs、kb_index.rs、db.rs、lib.rs、mod.rs等含其他已实现工作，本次针对性增加，不重置。

## 首批接口与数据边界

新增`knowledge-performance.ts`独立IPC适配，不改既有index.ts。新增kb_performance模块负责目录分页/后台目录盘点/状态/取消/已索引搜索。所有新请求绑定Tauri调用窗口＋libraryId；AI网关不增加任何写入能力。

- `kb_list_children(libraryId,parentId,cursor,limit,requestId)`：200项且256KiB上限，按目录修订keyset分页；未盘点pending/真实taskId，失败显式，不把loading算ready。
- `kb_scan_start`、`kb_task_status`、`kb_task_cancel`：真实后台任务仅directory覆盖，不称全文索引完成；两worker限并发，单层流式read_dir，分批落metadata，完成后切目录代，取消不发布半树。
- `kb_search_indexed`、`kb_search_cancel`：只查现存派生FTS，不内联首次全库重建，SQLite interrupt取消，保原排名与单字incomplete；freshness未知明确输出，不声称源完整SHA复核。
- 原件窗口协议提案已送主代理审查：独立只读原件字节窗口，明确source-byte坐标，UTF8/UTF16解码；不冒充已审canonical/行定位能力，不替代旧编辑接口。批准前不编码该路径。

目录数据库新增`kb_perf_file`（稳定登记与旧noteId别名）、`kb_perf_entry`（分代目录快照）、`kb_perf_directory`（active代与状态）、`kb_perf_task`（任务结果/取消/恢复）。仍在当前业务SQLite，不存原件BLOB，不更改现有FTS表或排名。新连接由db持久记录实际DB路径，知识专用有限连接在阻塞worker内使用，文件I/O不持全局db::conn Mutex。

原件存储仍为用户受管库目录；不搬迁/删除用户原件。metadata快照无原件正文。重启把未终结目录任务标interrupted并保留旧active快照；新扫描生成新attempt，不冒充自动继续旧任务。

## 尚待批准／不得实施

G-SEARCH未获同意，不实施整库全文暂停、不改BM25语义；GB级发布路线只研究并送主代理独立审查。小增量也需明确删除/插入载荷限额与源版本正确性才实施，不凭提高1MiB/25MiB/10000常量支持目标。

## 后续已核准增量

主代理转达用户已选择：同库保持可搜，明确显示索引快照版本；变化原件未经完整核验不得发AI；单GB文件先分块阅读/搜索/导入导出。因此不采用v2整库检索暂停路线。专门同FEAT008 writer impl-kb-snapshot只写新kb_snapshot模块及其测试，先经perf-architecture核准后实现库级新快照后台构建／原子切换；本writer负责既有文件和注册/API集成。

perf-architecture已批准附加source-byte窗口能力子集：UTF8/UTF16源字节半开区间、坏序列拒绝、BOM/代理对/CRLF精确、64KiB读取/256KiB JSON上限、同版受保护句柄、窗口＋库＋受检根作用域及60sTTL/关窗清理。它不是canonical随机行／编辑能力的替代。已实现文档分步字面全文搜索（4MiB请求预算/50命中/真实取消/跨块匹配），尚须实际测试与前端联调。

AI验证计划：旧P0同一parse代按ordinal和连续原始UTF8范围计算预期SHA，完整核原件SHA及旧FNV；新快照使用原件sourceSHA而非canonical SHA。搜索snippet和read/read_many均检查，源/父目录保护保持到响应物化，再复检启用/根/grant/明确代际；人类searchIndexed明确humanOnly。先物化DB短快照再读原件，不持全局DB Mutex。

## 流式原件操作实施边界

1. 旧导入API先改为64KiB流复制，维持既有限额/返回兼容；新任务API才提供GB级进度、取消和恢复，不只调大常量。
2. 新API原件来源/目标只来自本机picker，不接受任意sourcePath/destinationPath IPC参数。受检根/父链和源文件拒写删共享保持；同名不覆盖。
3. 写保留前缀的独占随机同卷临时件，计算SHA并sync；提交前取消删除本次可证明归属的残件，原件不变。候选NTFS hard_link临时件→目标作为原子no-replace发布，能力不支持明确失败，禁止回落覆盖rename。
4. 临时件封存后重新打开受保护句柄并复核SHA，防关闭写句柄到打开读保护之间内容被替换；发布后仍核目标是相同对象/字节。成功发布后取消不能撤销原件；cleanup临时名失败只报清理警告，不能误报原件未保存或重复导入。
5. task的original完成与全文index完成分开。落盘原件没有被快照发布时明确索引待更新，不能误报已可AI检索；新快照writer按原件mutation fence拒迟到发布。
6. 全FEAT008目录/index/transfer共用后台permit合计至多2，索引模块另限1；不能每模块各自放2。前台受限读取/搜索另有最多2个阻塞操作槽。全局配额不足返回BUSY_RETRY，不建立无限队列。
7. 崩溃时只对账本任务登记的临时件/目标/摘要，未证明发布结果保留needs_recovery，不全盘猜测或删除用户原件。Windows硬链接/断电耐久实际验证不以代码存在冒充通过。

## 当前交接（2026-11-21，cargo147/0由主代理报告）

### 已实现或已登记

- `kb_performance.rs`：目录分页/稳定登记/后台目录盘点/任务状态与取消；`kb_search_indexed`/`kb_search_cancel`不触发旧同步回填，返回humanOnly与coverage；FEAT008目录/索引/传输共享后台permit，前台有限槽。
- `kb_windows.rs`：受保护原件窗口、source-byte UTF-8/UTF-16边界、租约/窗口销毁、4MiB分步字面搜索与真实取消；跨64KiB匹配、JSON预算、连续超过256页槽释放及active/tombstone保护均有Rust测试草案。
- `kb_verified.rs`：AI搜索/读取核验草稿：短读事务epoch与命中物化、原件完整SHA/FNV、根/授权/代际复核、外改/删除拒绝、8KiB envelope/read_many预算；当前挂载/最终cargo覆盖由主代理确认，不能仅凭历史cargo结论外推。
- `knowledge-performance.ts`：目录/任务、人类索引搜索、窗口/大文本搜索、快照IndexTask预留接口。
- `kb_index.rs`：仅开放现有词项算法`ChunkTerms`与`terms_for_chunk`给snapshot writer，未改排名算法。

### 未完成与审查遗留

- `kb_snapshot.rs`尚未挂载/完整交付：完整库级快照、影子FTS、generation membership、原子发布、fence/CAS、恢复/GC及`hit_reference/read_hit_conn`待writer新turn和独立审查后接入。当前不采用旧P0删除原件仍可读派生正文作为新策略证据。
- 原件流式导入/导出尚未开始；当前上传仍存在整包25MiB路径。`kb_transfers.rs`计划64KiB流复制、进度/取消/恢复、临时件、no-replace和耐久状态，但尚未实现。
- `invalidate_source_tx`尚未接入所有用户原件写入/上传/删除/停用/换根；外部源变化依保护读取最终核验，不能宣称后台快照已自动失效。
- source-byte窗口不等于canonical随机行索引/C2完整编辑能力；PDF/Office解析不扩展。
- storage writer `impl-editor-storage`正接管FEAT007；本Feature只共享最小注册，不修改其`fs_*`/API。
- 主代理报告cargo147/0，但最新未注册快照/transfer和未挂载AI路径仍需单独确认；未运行GB吞吐、NTFS no-replace、断电耐久、真实前端联调。

### 下一步约束

先由snapshot writer提供实体API并经perf-architecture只读复审，再挂载；AI接入必须通过显式snapshot generation/member/ref，不用负chunkKey或noteId猜代。原件流式transfer与快照索引共用FEAT008后台配额，不无限排队。所有结果按AC标通过/失败/未执行/不适用，不能把排队或cargo通过冒充索引完成/性能完成。
