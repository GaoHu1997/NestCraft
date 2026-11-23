# DB-CR055-FORMAL-v2：正式索引引擎持久协议

- 归属：FEAT-008／CR-055／STORY-036；用户授权继续正式开发、修复并闭环。原件与授权业务数据不因索引切换被迁移/删除。
- 当前方案：[正式适配工作包](../LLD/LLD-CR055-FEAT008-正式适配工作包.md)。源码通过R1～R8及R4增量独立审查后集成；实际验证/状态以正式集成报告为准，不把实验或隔离树回归写成用户库验收。

## 1. 复用表与加列

SQLite仍为control/member/job及chunkKey/range/ordinal定位的权威。`kb_snap_generation`幂等增加：

| 字段 | 作用与旧值 |
| --- | --- |
| engineKind | 默认`sqlite`识别旧代；新代`tantivy`，未知值拒绝，不猜最新 |
| engineSchemaVersion | 旧SQLite默认1；新引擎按受检schema版本验证 |
| enginePath | 与DB旁受管库hash／numeric generation推导路径一致，不授权客户端任意路径 |
| engineFormat／engineOptionsHash | 记录格式和规则版本，未知值在检索/读取/引用入口拒绝 |
| engineSealHash | **SQLite CAS事务中可信锚定完整封存清单SHA**；新T无锚不能读，不允许只在派生store内自证 |

旧SQLite正文、v1/v2 context、member与旧游标继续可读，旧行不会被新引擎格式重新解释。Tantivy新代SQLite只存定位元信息，不把完整正文再双存到SQLite；primary/suffix及自洽来源Meta在压缩store，输出仍核对SQL同代成员。

## 2. 发布与取消

先独立构建不可查目录，完成原字节SHA/FNV、严格UTF8/UTF16解码或受检兼容parse复用、索引commit、完整成员/store/范围验证与封存同步。最终短SQL事务比较baseEpoch/sourceFence/root/启用/持久cancel，写可信seal锚并切active与任务completed。文件commit不是宿主公布。

取消先落库不得公布；公布先完成才报告取消过晚。失败或源变保旧active；线程退出前不释放后台槽。启动把非终态标中断，旧active保持，不恢复旧授权，不覆盖原件。

## 3. 受管实体与回收状态

`kb_snap_managed_entity`保存libraryId/generation/entityId、cleanupPath、deleteComplete及新列`cleanupStage`（旧行默认`pending`，幂等迁移）。

1. 创建时持有祖先/目录实体句柄；ownership初始化失败只回滚本次实体，不能删除替换对象。Reader/Writer/cache持续pin受管祖先与文件，路径检查不能代替真实句柄。
2. 回收只认非active、无租约的SQL登记实体。先记录tombstone路径，再no-replace handle rename，**持久标记`renameConfirmed`后**才开始物理删除。
3. 删除后`deleteComplete`未落库就中断：重试confirmed且tombstone明确不存在时只SQL收尾，**不回退原路径replacement**。pending双缺失不能猜已删除，未知stage拒绝。rename确认写库前的失败保tombstone原内容可重试。
4. 父链与实体ID检查、DELETE句柄及no-replace规则不放宽；旧新索引回收不能删原件。只在autocommit执行回收确认，避免把“删除前确认”留在未提交外层事务。

R4确定性测试以SQL trigger在确认/完成标记处失败、真实Windows删除后换新Connection恢复，验证replacement/原件/active不变、GC collected和limit2重建可用，已先复现旧逻辑失败再修。真实断电/目录durability仍未实测。

## 4. 读取与授权能力

引擎分派绑定generation/member/parse/sourceHash及完整版本；同请求Searcher、cursor和引用不得换代。AI游标另保存签发grant revision，撤权后再授权不能复活旧能力；人类旧代lease与AI能力分开。

所有输出项（包括metadata）在正文源hash完成后的最终读事务重新验证grant/启用/root/成员/代际。AI snippet/read完整源SHA、真实原件保护句柄到handoff不省略；压缩正文不能代替freshness验证。

候选截断前先按score及业务stable note/ordinal/key处理同分，最多101后只物化100并标不完整；词项COUNT不是literal全文数量。源byte与canonicalUTF8坐标不等价，严格BOM/UTF16/CRLF不换单位冒充定位。

最后缓存优化不变更DB协议：每逻辑获取仍从当前SQL核engine/schema/path/seal锚/digest及同代成员，不永久缓存授权或sourceVerified。warm复用持有的Reader/真实文件实体，但批量fresh READ_DATA检查当前DACL、逐文件实体匹配，批前后核祖先、完整inventory与tinyseal SHA，冷路径仍全文件hash。缓存global失效epoch有界不wrap，forget/remove即使miss也推进；cold IO之后ticket不同不能迟到重插，已握Arc不等于租约/权限可续活。实际DACL仅撤READ_DATA而属性仍可读的拒读及WRITE mapping存活测试通过，不能仅由share flags推定等价。见[缓存终审](../Test/REVIEW-CR055-缓存热路径终审.md)。

## 5. 资源、回退与运行边界

物理配额计SQLite/WAL/SHM＋全部受管Tantivy目录/旧新代/临时合并，不能只计store；逻辑配额独立。writer50MB是预算，不是进程硬峰值；segment/Reader/cache/lease/cursor有各自数量/TTL约束。单次commit不可抢占，真实取消/峰值需另测，常量不当测量成绩。

保留显式SQLite重建命令，回退是在同任务/CAS核心新建SQLite代并公布，不恢复整个旧DB备份，不丢新业务变更。旧索引读取和新引擎首次构建无需自动迁移私人库，本批程序只在隔离临时DB执行迁移测试。

发布分发仍须核许可证（htmlescape原始LICENSE/NOTICE待审），本次不是安装包发布或永久法务放行。真实WebView/目标机/1～10GiB/P95/断电未因单测或小组性能被宣称通过。
