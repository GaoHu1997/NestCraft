# WP-CR055-FEAT008-FORMAL：检索引擎正式适配与闭环

- 日期：2026-11-22；projectId=`NestCraft-workspace-D-github-AI_Delelovelop`；featureId=`FEAT-008`，关联[STORY-036](../Plan/Story/STORY-036-知识库正式实现.md)、[CR-055](../PRD/CR-055-大规模编码与知识库性能.md)。
- 授权：用户本次“继续，一次搞完”，承接已授权开发与[Tantivy实验/后续门禁](LLD-CR055-FEAT008-引擎候选实验与适配门禁.md)。本批进入正式适配的源码实现、隔离迁移/构建/回归，不自动启动私人知识库迁移、不发布/推送。
- 工作层级：主代理协调/验证；独立FEAT-008执行上下文在隔离副本实现；独立CLI复审后主代理按preimage SHA集成，保护原工作区用户改动。
- 允许改动：Cargo依赖/锁固定Tantivy0.26.0、commands内索引/核验/知识搜索模块；必要的最小注册/migration；测试与相关LLD/DB资料。禁止其它Feature、编辑器/Reader布局、生产数据与配置面板。
- UI：沿用现有任务phase/错误/快照/取消字段和调用接口，不新增控件；没有UI变化时UI-SCROLL-001不适用。若必须增加用户可见交互，先单列设计缺口，不能先改软件后补稿。

## 2026-11-23 受检采用与当前状态

正式候选先经独立首审发现R1～R8，再经修复/复审最后R4三文件增量PASS，已由主代理集成到当前ROOT。只合Feature overlay及一行SQLite回退注册，不覆盖db/chat等共享改动；[终审与集成过程](../Test/REVIEW-CR055-正式适配终审.md)保存失败→修复→PASS。[现行持久协议](../DB/DB-CR055-正式引擎持久协议.md)补齐可信engineSealHash与cleanupStage，不使用旧实验store自证或路径级检查。

当前原工作区debug/release完整回归均319/0/6ignored，普通非测试release构建和前端类型/构建均exit0；最新同语料完整测量结果见[集成报告](../Test/REPORT-CR055-正式适配集成验证.md)。隔离候选304/0/6不是当前ROOT回归数字。此采用不是部署运行或用户验收，真实WebView/断电/目标机/GB/P95未测，分发许可证门禁保留。

已完成必要语义/身份/授权/CAS/取消/回收/同分/游标修复；未变文件先完整源hash再可信SQL/store分页复用，不重新decode，只有变更/规则不兼容才重新parse，仍会重建新引擎词项，不声称索引构建O(变化量)。详见独立审查R8及真实计数回归。新代默认Tantivy0.26.0；旧SQLite代仍可读/可显式重建回退，不覆整个业务数据库。

### 最后缓存性能专项采用

初版完整测量大组中文AI核验13.814秒，重复获取受管文件/祖先probe是明确热点。第一版held-only缓存因DACL访问语义和cold/forget竞争未准入，未合ROOT；最终批fresh READ_DATA＋global失效ticket和真实mapping/DACL/barrier回归通过独立[缓存终审](../Test/REVIEW-CR055-缓存热路径终审.md)，已按三前像/后像受保护合入。保所有SQL可信封存、完整源proof和最终metadata/body授权fence，不改CAS/持久GC协议。

最后两组同版本只读三样本中位：大组人类中文33.432ms、AI完整核验731.513ms，小组19.590/448.501ms；不是P95/严格配对倍率。正式空间大组633.422→153.378MB（包含控制/定位），不是缓存压缩；总建库时间大组主体271.404/270.312秒，cache-v1一次after289.888秒更慢的负结果保留，v2未重新构建不说修复建库退化。主体/缓存两个集成版本和ROOT最终验证分别记。最后ROOT自身debug/release均341/0/8ignored、普通release应用构建与类型检查exit0，完整小组原件/primary/只读verified probe通过，本批技术闭环完成待用户验收；不自动结束整个Story/CR。

## 1. 目标与不变项

将实验的压缩正文+成熟倒排变成宿主协议的一部分，而不是仅换搜索函数：

1. 新代使用固定Tantivy0.26.0；旧SQLite代仍可读取及查询，新代失败不改变旧active。原件、授权、稳定身份仍由原系统管理。
2. 每库独立索引，库内相关性统计隔离；跨库仍沿用既有确定性合并，不把统一全局IDF伪称逐库排名。
3. 同一请求选择generation/member/parse/sourceHash，搜索/正文/引用/游标只能使用同一代，未知schema/tokenizer/parser/encoding/context版本明确失败；不盲回退最新。
4. 压缩store保留primary/suffix/来源元信息，可重建全文；canonicalUTF8与source-byte分开；源SHA永远原字节，BOM/UTF16/CRLF严格检查。
5. 不让自然QueryParser解释用户字面查询；保中文、多字、单字/混合Han、非ASCII大小写与特殊字符。候选限额/过滤/去重必须诚实标incomplete。
6. AI输出前真实授权版本复检、完整源哈希及句柄保护仍执行，docstore不代替原件freshness证明。

## 2. 选定集成边界（执行者可细化，不降低目标）

- SQLite保留control/member/job及必要chunk定位元信息；generation持久标记engineKind/engineSchemaVersion/index位置及tokenizer等版本，默认旧行归SQLite。避免把正文既存SQLite又存Tantivy以制造假空间收益。
- 新代目录为应用受管、库/代ID导出的路径，不拼用户路径；先独立build/commit/validate/sync，最后短SQLite事务CAS(baseEpoch/fence/root/启用/取消)公布。Tantivycommit不是宿主已公布。
- 每代不可变，不在旧active目录原地修改。取消/坏文件/磁盘满/发布冲突保旧active；终态任务可查询，不丢worker名额；启动识别非终态材料并保旧代。
- engine adapter在search/read-hit/read-chunk/read-cursor/reference/verified网关接通；同一代Searcher有真实生命周期/租约。GC只有无租约/无引用的retired/失败代才能清理，路径验证后不删除原件。
- 保留旧SQLite引擎的构建/读取能力用于测试和回退，新代选择Tantivy；回退是重新构建旧引擎代并CAS公布，不能覆旧备份数据库丢新业务变更。
- 不触发用户私人数据的自动重建；必要加列为幂等向前schema迁移，旧行/旧引用仍可用，实际迁移验证只在临时DB。

## 3. 稳定义务账

| 编号 | 必需结果 | 验证方式 |
| --- | --- | --- |
| F008-01 | schema/tokenizer/options/source身份完整，旧代可读不混格式 | 临时旧DB迁移两次、旧SQLite到新代/retired/cursor、未知版本拒绝、新Meta重建 |
| F008-02 | literal/中文/单字/Unicode/候选截断/库统计正确 | Ω/ω、组合符、引号AND、跨片四字节128scalar、mixed singleHan、路径only、海量候选、密集双库 |
| F008-03 | 所有读取/引用/游标经过同代adapter与实际授权源校验 | actual verified::search/read/read_many入口的撤权/禁库/外改/删除、JSON缩片续读、UTF16/BOM/CRLF |
| F008-04 | 持久取消/时间竞争/发布CAS/崩溃恢复不改旧active | 取消前/commit后公布前/公布后、fence外改、重启、丢sidecar、坏index、磁盘超限回归 |
| F008-05 | worker/reader/store/旧新代磁盘与内存预算有界 | 1writer预算、lease/GC、真实索引目录+SQLite+WAL计数、低水位/超额失败，句柄释放 |
| F008-06 | 旧SQLite回退与新代正式入口接通 | kb_index_start注册命令同实现核心、legacy库/active代/新库操作、回退重建测试，不依赖cfg(test)adapter |
| F008-07 | 完整同语料实际MB/GB和秒，非引擎core替代全链路 | 313/1250文件完整run、相同setup→validate→公布口径、源清单、query/读核验分列、异质中文与1GiB酌情 |
| F008-08 | 集成当前src、独立review无未解决阻断、状态准确 | source前后SHA、完整diff、debug/release回归、必要frontend兼容、报告与Story/DB同步 |

## 4. 测量与完成边界

沿用两组保留的完整真实文件313/67,216,437字节、1250/268,436,250字节，manifest不变。原实验数只作历史，不替代正式adapter测量。新系统占用=SQLite控制/定位/成员与日志+全部Tantivy文件/临时/旧代，分别列；1MB=1e6字节，不把主库或核心store当总量。

测试原则：不关闭sync、不跳源hash/权限、不伪称OS冷；构建phase完整计时、query/额外全文校验分列。1GiB或10GiB没有实际跑完就标未验证，不能从短组乘算。固定目标机/正式P95/真实断电/整应用视觉无法在此机器证明时如实保留未验证，不冒充DoD。

本批目标是闭合正式后端适配的技术准入与可执行验证，未通过必需语义/权限/生命周期项就继续修复，不让实验收益替它放行。独立审查认可/集成回归通过之后才交付“本批后端适配可验收”，不宣称所有CR-055能力或用户验收完成。
