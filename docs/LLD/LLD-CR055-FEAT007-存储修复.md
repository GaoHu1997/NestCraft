# LLD-CR055-FEAT007：存储修复设计 r1

- 身份：projectId=`NestCraft-workspace-D-github-AI_Delelovelop`，唯一Feature=FEAT-007，STORY-034 CR055-01～05；writer=`impl-editor-storage`。
- 授权：本轮明确正式开发；旧impl-editor已停止Rust/API写入，仅继续前端。我的文件范围为commands/fs.rs、fs_performance.rs、fs_document.rs、fs_document_tests.rs、必要fs_*模块、src/api/editor-performance.ts及本设计/存储报告；不写editor前端、knowledge/lib/mod/db/Cargo。
- 基线：采用[CR055-v3](LLD-CR055-v3-执行授权与快照语义.md)、[工作包快照/保存/资源契约](LLD-CR055-工作包与接口契约.md)、[测试口径](../Test/TEST-CR055-性能基准与故障验收.md)。GB首期source-byte只读窗口/搜索/原件操作，普通/百万行完整编辑保留；随机行功能不虚报。
- 状态：**存储修复关键设计准入通过（R01/R02关闭）；BE-E01～07源码修复仍未完成**。编译/运行测试由lead统一调度，本writer不自行cargo/build。

## 1. BE-E01/02：持久保存与可恢复提交

建议保留已存在的Windows受保护handle rename作为**可恢复的两步提交**，不声称原path始终原子：原path→确定backup，再独占temp→原path；应用内命中相同实体的读/旧写在此阶段返回SAVE_IN_PROGRESS。外部非本应用读者可能在两步间看到路径短暂不存在，这是明确技术边界，已报lead请求路线确认。若要求任何外部读者也始终看到旧/新原path，则此路线不可宣称满足，需另设计并验证真正原子replace；禁止偷偷打开分享删除绕开锁降低CAS。

持久目录使用Tauri app_data_dir/editor-operations，不用项目正文/SQLite新表；注册owner仅需给初始化路径/Destroyed hook。操作记录是版本化JSON快照（临时记录sync→原子文件替换；或追加日志完整行sync，采用后者以避免日志记录自身替换窗口），每条含单调seq及链式SHA，损坏尾记录不当成功。每个requestId独占日志文件；读取有总上限，终态压缩不在本次提交热路径执行。

intent绑定：requestId（客户端UUID，进程重启仍保持）、operationId、submittedRevision（冻结EditorState的UUID）、expectedSourceHash、targetEncodedBytes（含BOM）、targetSHA256（原件编码实际字节）、encoding、rootCanonical/rootFileId、parentFileId、sourceFileId、精确target/temp/backup路径、tempFileId、window label/instance nonce、process nonce。源文件互斥键为卷ID＋fileID，硬链接别名共享；新文件需单独协议，首期本接口只保存已存在文件。

阶段：intent→staging→sealed→committing→old_moved→replaced→durability→committed，另有cancelled/failed/needs_recovery。只有temp长度/SHA/块数和submitted声明完全相等才能sealed；write_all出现任何错误即poisoned，不允许再次append/commit。temp从create_new起read/write/DELETE share0同一句柄贯穿hash/rename/sync，不关闭按路径重开。

prepare时intent先持久化，再创建独占temp并登记其identity；BOM写失败毒化。append每块≤64KiB UTF8传入，按encoding转换有界，连续seq和已确认offset；最近重发块摘要相同则幂等，其他重复/乱序/超total拒绝。seal由服务端流式校验实际文件长度、SHA、总块数；前端事先对冻结Text有界计算目标字节/SHA，不在每键热路径做全文串化或大ArrayBuffer。

commit先持久写committing意图及backup精确路径、原/temp实体身份与摘要；取得原fileId独占源句柄，完整基线hash（循环检查取消），复检root/祖先/源identity，保持到步骤完成。old→backup后仅更新内存old_moved并提供故障注入点；两rename之间不做journal写/sync、长hash或DB事务，仅必要受保护复验与第二rename。temp→target后再记录replaced；temp.sync_all成功记录durability；最终outcome committed持久后才返回成功/删除backup。崩溃于两rename间凭已耐久committing记录和target/temp/backup身份/hash恢复，不依赖old_moved记录。第二rename失败先在保持保护下恢复旧件到仍为空的target，否则needs_recovery保材料，绝不覆盖竞争者。

请求/响应丢失：save_status(root,requestId)返回同一operation摘要与阶段，不换ID重写。替换线性化之后cancel只设cancelTooLate并返回committing，耐久/outcome完成之前绝不committed；结果不明needs_recovery并保材料。持久outcome成功后重复commit/status返回同committedRevision/hash/bytes，禁止再次改原件。

启动或首次status只对登记操作对账：最终件身份/完整SHA匹配目标且sync可确认，补committed；原件仍baseline且没有replacement则安全cancelled/failed；原path缺失、backup身份和baselineSHA匹配且temp受检，恢复backup到空target（rename replace=false），竞争者已创建目标则拒绝覆盖并needs_recovery。最终件为外部新内容/日志损坏/身份不明全部needs_recovery。恢复不扫描全盘、不猜随机backup、不用仅mtime证明。不同进程nonce可按同root实体＋原requestId查询恢复记录；同一进程label重建不得访问被清掉的旧实例活跃租约。

## 2. API冻结提案

- `saveBegin(rootUri,path,{requestId,submittedRevision,expectedHash,encoding,totalBytes,submittedHash}) -> SaveStatus`
- `saveAppend(rootUri,requestId,seq,text) -> SaveStatus`（不返回全文）
- `saveSeal(rootUri,requestId,expectedChunks) -> SaveStatus`
- `saveCommit(rootUri,requestId) -> SaveStatus`
- `saveStatus(rootUri,requestId) -> SaveStatus`
- `saveAbort(rootUri,requestId) -> SaveStatus`

SaveStatus：`requestId, submittedRevision, phase, nextSeq, writtenBytes, sourceHash?, sourceBytes?, committedRevision?, cancelTooLate, needsRecovery, error?`。phase只在最终持久outcome后为committed；成功状态将使用既有sourceHash/sourceBytes字段便于前端适配。saveId采用requestId同值，不再产生不可恢复的随机第二身份。

新增Tauri命令save_seal/save_status；原save_begin/commit/abort签名更新。通过impl-knowledge统一注册，hook统一由它写lib；本writer仅导出fs::destroyed(label)。API文件由本writer维护，前端文档会话由impl-editor按定稿适配。

## 3. BE-E03/04：取消、实例和实体身份

Session/Owner不可变放Arc外层，Save状态重I/O mutex内部；cancel AtomicBool、phase AtomicU8独立读取。get_save只查registry并比较不可变scope，不锁长I/O；abort直接置cancel，不等待hash；worker每64KiB/写块检查。registry保持活跃条目直到worker真正结束，permit/字节credit随真实生命期释放；不会remove后try_unwrap丢正在commit的任务。

window实例registry使用label→nonce，destroyed先撤销nonce并取消该实例所有docs/saves/searches/directories；旧worker带实例alive AtomicBool，迟到结果不能再次注册。doc关闭/Destroyed取消正在读的句柄，worker结束即释放，空闲租约立即关闭；提交过线性化的保存不回滚，继续持久化或标needs_recovery。跨窗不清错对象。

root scope包含真实volume/fileID，取得root到卷根以及target祖先的持有句柄；不能只靠canonical字符串。所有同real fileID保存互斥，包括硬链接、不同root别名和不同窗口。共享budget/registry锁不等待per-operation I/O锁。

## 4. BE-E05：路径pin与受保护使用

新增fs_guard模块承载Windows受检根/祖先pin、实体identity与guarded_open。从卷根到target逐段open目录（OPEN_REPARSE_POINT＋BACKUP_SEMANTICS，share READ|WRITE，禁止DELETE），读句柄metadata拒reparse/type错误；pin后再次canonicalize并核对根identity/目标范围。目录枚举pin目标目录，搜索遍历每个目录/文件在使用时再pin，实际file open带OPEN_REPARSE_POINT并验file identity/type，不能先checked_path再裸open。

非Windows没有已验证的同等保护时相关受保护命令fail-closed明确SAFE_PLATFORM_UNAVAILABLE，不用symlink检查冒充无竞态。Windows普通读者/编辑文件锁冲突显式FILE_BUSY。

## 5. BE-E06：预准入与JSON

新增fs_resources模块：非阻塞全局task permit（最多8，搜索最多2单独槽）和全局byte credit（64MiB）；后台/目录缓存合计另限48MiB，保留16MiB前台headroom。每条IPC校验小输入后**spawn_blocking之前**拿permit；工作闭包/后台任务真实结束才释放。目录初次扫描先清理过期/LRU清洁目录并预留40MiB背景credit，其中retained entries最多16MiB，其余24MiB覆盖Vec容量、排序临时对象、初页复制与最终JSON。初页在同预约内完成，不再取第二份响应credit；构建结束将credit缩为实际保守retained成本（≤16MiB），其余立即归还。下一页另取≤1MiB前台工作credit，完成/TTL/Destroyed归还缓存credit。第二个冷目录若旧缓存使40MiB预约失败，按LRU逐个淘汰清洁目录再试；游标收到CURSOR_EXPIRED可重试，不丢草稿。状态/取消只设置原子token，不依赖任务槽或bytecredit。

明确回归：已有doc租约＋目录缓存时还能打开另一目录；最大允许目录初页/后续页成功不因自身credit死锁；预算不足在分配/排队之前拒绝。

文档读/append/seal/commit也预拿固定有界工作credit；save/hash用64KiB缓冲，doc缓存上限32有租约持有credit。文本IPC经过Tauri参数解码后立即限制输入长（无法声称修改了Tauri反序列化前全局HTTP/body大小限制），不会将任意长度字符串排队进闭包。

最终WindowData/DirectoryPage/SearchPoll按serde_json实际序列化长度验限；窗口缩到完整字符边界；单Hit超过预算明确FIELD_TOO_LARGE/incomplete，不把一条大Hit塞入4批队列。每批≤64KiB但SearchPoll含全部4批还有envelope，必须对最终总JSON≤256KiB再限，只返回能装下的批次，不把未返回batch当ACK。

## 6. BE-E07：旧接口护栏

旧fs_read_file改受检pin/同版句柄，有界读取/最终JSON，超限LEGACY_FILE_TOO_LARGE要求新窗口协议；旧fs_write_file对新编辑器已管辖（包括读取lease已关闭但Tab仍在）或正在保存的同实体文件返回BASELINE_REQUIRED/SAVE_IN_PROGRESS，不能绕过CAS。未被新编辑器管辖的其它Feature旧小文件写保持兼容：≤1MiB输入，统一受检路径/真实fileID互斥、独占源句柄取当前基线，再走同持久保存核心；这仅保既有无调用者expectedHash语义，不伪称其他Feature已有跨读取期间CAS。不得依赖fs_read_file隐式缓存，其他Feature可能有独立读取入口。需要修改其它Feature调用时先列清单交lead，不跨界编辑。

新编辑器管辖表与doc读取租约分离：open_document登记window nonce/root身份/fileID/path，close_document仅释放读句柄，Tab关闭由新增release_file显式解除，Destroyed清该实例；最多128项有界，不按60s自动撤销对未保存Tab的保护。文件替换后在同文件锁内迁移旧/new fileID管辖引用，硬链接别名仍按真实实体冲突处理。旧write在共同fileID锁内复检管辖，open_document登记也经过该锁，避免check→write间新编辑会话进入。

旧tree/search同样保数量/响应预算和使用时路径边界；不让旧search成为逐文件无界正文读取旁路。允许对旧命令明确返回USE_STREAMING_API而不谎称搜索完整；任何业务兼容影响先报lead。

## 7. 故障测试与交付条件

新增测试直接使用真实save核心（非只测rename）：intent后、seal后、old_moved后、replaced后、sync后outcome前、outcome后response前；缺块/乱序/重复块、写部分失败毒化、temp替换拒绝；并发abort/hash和registry配额、label重用/Destroyed/root同路径替换、硬链接fileID串行；check→open父替换；突发任务准入拒绝不先分配；JSON全控制字符/长路径/单Hit/四批envelope；旧GB read/旧无基线write拒绝。

Windows rename/pin/保护语义必须真实测试，不将cfg禁用或mock视为已通过。测试代码由本writer写，lead统一cargo/桌面集成；拿到实际日志后登记本报告并交perf-architecture逐BE复审。所有阻断真实关闭且前后端一致后方可交付。

## 8. BE-E01 材料回收与启动接线（2026-11-22 实施记录）

首审 BE-E01 的剩余缺口是“备份/临时材料没有回收入口”：`commit_core` 有意保留 backup，清理在成功热路径之外，但此前并不存在任何清理路径。

### 8.1 实现

| 项 | 内容 |
| --- | --- |
| `gc_materials(policy)` | 扫描 recovery 目录的 `*.jsonl`，只回收**终态**（`committed`/`failed`/`cancelled`）条目对应的 `.nestcraft-editor-<id>.backup`、`.tmp` 与 journal 本身 |
| `GcPolicy` | `keep_recent_entries = 32`、`keep_within = 7 天`，两者取**并集**保留；`reclaim_all_terminal()` 为显式维护用（0 条 / 0 时长） |
| 终态时间 | 取 journal 文件 mtime。终态行写入后不再追加（`reconcile` 对终态只读），因此 mtime 即终态落盘时间；这样不必给 `Record` 加时间字段——加字段会改变 `row_hash` 链，把既有 journal 判成 `JOURNAL_CORRUPT` |
| 独占语义 | GC 用与 `reconcile` 相同的独占打开（`share_mode(0)`）；拿不到句柄即视为“正在被使用”并跳过，不引入第二种共享语义 |
| 永不自删 | `needs_recovery`、所有非终态、`target` 本体、其它请求 id 的材料 |
| 删除顺序 | 先删材料、后删 journal：journal 是材料的唯一线索，宁可留 journal 下次重试 |
| 启动接线 | `lib.rs` 在 `initialize_recovery` 之后按默认策略静默调用一次，失败不影响启动 |

### 8.2 为什么不在成功热路径清理

提交成功路径已经包含两次 rename 与两次 `sync_all`；再加删除操作会拉长“已替换但尚未确认”的窗口，并把失败模式引入本应最简的路径。保留 + 定期回收把风险移出热路径。

### 8.3 影响

- 已回收的极旧 requestId 之后查询 `fs_perf_save_status_v2` 会得到 `SAVE_NOT_FOUND_OR_BUSY` 而非历史终态；这是保留策略的必然结果，已在代码注释说明，前端未做专门提示。
- 只有 journal 存在的条目才会被回收；journal 被人工删除后残留的 `.tmp/.backup` 不会被发现（无孤儿扫描）。

### 8.4 验证与未验证

9 条真实文件系统测试（提交后回收、取消遗留 temp、六种非终态不回收、`needs_recovery` 不回收、超限淘汰最旧、幂等、只回收指定 id、默认策略保留新条目、入口目录解析）通过；全量回归 205 passed / 0 failed / 2 ignored。

未验证：真实断电时序、跨卷/网络盘、生产共享 RECOVERY 目录的完整扫描（进程级 `RECOVERY` 为 `OnceLock`，测试内并发会与其它测试的独占 `reconcile` 抢同一批句柄）、`gc_materials` 是否应另注册为 Tauri 命令。故障测试中曾发现 GC 用共享读打开 journal 会使并发 `reconcile` 返回 `SAVE_NOT_FOUND_OR_BUSY`，已改为同一独占语义。