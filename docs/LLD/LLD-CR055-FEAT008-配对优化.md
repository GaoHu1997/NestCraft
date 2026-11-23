# LLD-CR055-FEAT008-PAIRED-v1：完整配对优化与旧格式兼容

- 身份：`NestCraft-workspace-D-github-AI_Delelovelop / FEAT-008`，关联[CR-055](../PRD/CR-055-大规模编码与知识库性能.md)／[STORY-036](../Plan/Story/STORY-036-知识库正式实现.md)。
- 授权：2026-11-22用户明确继续优化、允许调整方案、须报告实际数据。本批只改后台索引和已有读取定位，不改UI、依赖、运行配置、授权或原件数据，不发布/推送。
- 执行：外部CLI在隔离源副本完成实现，主代理只读评审最终diff后按before SHA集成；没有让两个writer写原文件。设计记录先于隔离编码，原始隔离资料保留，本文在集成交付时归档。
- 当前结论：本单文件补丁独立复审通过、原工作区debug/release全量回归通过；两个小型完整配对组测量完成。**不是整个CR-055、10GiB性能或产品验收完成。**
- 唯一正式源码：[kb_snapshot.rs](../../src-tauri/src/commands/kb_snapshot.rs)。

## 1. 复用边界与选定方案

沿用SQLite schema和现有文件/解析身份，不新增DDL，不改tokenizer、片段目标2048、512字节lookahead、BM25四列权重8/4/1/0.2、`detail=full`、contentless、源SHA256/FNV、同库排名、权限或fence/CAS。

1. 旧v1 `searchText` 存全文+suffix或空串fallback，新v2只存suffix。搜索与hit读取统一按已存member.contextVersion解释：v1非空直接searchText，空串text；v2 text+suffix；未知格式明确失败。普通读取只primary但校验已知格式。旧chunks不重写，复用parse仍要求完整版本相同。
2. read_piece实际起止行使用偏移前缀、当前slice、前一primary末CR推进；JSON缩片后重算末行。源byte与canonicalUTF8坐标仍分开，UTF16源hash不改。
3. DiskGuard按250ms或累计32MiB写载荷触发物理DB/WAL/SHM及卷低水位检查，覆盖parse/copy；optimize后CAS前force复检。保持逻辑配额；这是软护栏，不承诺单个系统I/O硬上限。
4. 两条INSERT在短事务内prepare_cached一次循环绑定，FTS SQL每flush一次；常用重复SELECT缓存。PendingRow仍依赖Builder owner，保留文件边界flush，不跨文件延迟写。
5. 主动工作约125ms切批、原子取消逐行复检、数据库fence/启用在批前及发布事务内验证；member与完成进度同事务；重复hashing/parsing阶段按250ms节流，不用单纯心跳伪造进展。
6. 文件边界显式清词项cache，heading变化时重算，避免不同文件同title继承路径词项。当前分词仍会分配，不声称“零分配”。

## 2. 稳定义务与验证

| 编号 | 对应要求 | 本批验证 |
| --- | --- | --- |
| P008-01 | CR055-02／源hash+parse版本、literal/FTS | 真实v1全文+suffix/空串、v2、未知格式、span/BM25；旧chunks不变 |
| P008-02 | CR055-03／不可混代、旧代租约与GC、取消CAS | v1 retired lease、旧cursor跨newv2和GC、回收后明确过期；现有取消/源改不发布 |
| P008-03 | CR055-05／坐标、授权与完整hash | CRLF37字节续页实际行、suffix跨行、UTF16源hash及撤权/外改既有回归 |
| P008-04 | CR055-06／资源、故障不开放半代 | parse/copy完成hash后仍由写载荷探盘拒配额；force/time测试；最终force源码审阅 |
| P008-05 | CR055-02、06／短事务、正确owner | 批量INSERT/文件缓存隔离、未删文件边界；125ms/250ms常量不当作真实最大时延 |
| P008-06 | 用户要求实际MB/GB/秒 | 同release同完整文件组before/after，小组各3次、大组各1次，原始manifest对齐，全部active发布成功 |

## 3. UI、DB与兼容性

UI-SCROLL-001不适用：本批不增改UI或滚动区域，不声称视觉一致。数据库复用原表与已存contextVersion，不迁移原件/授权，不把未知格式猜成新格式。SQLite同步参数不降级以制造提速。

prepare缓存曾导致旧库无快照控制表的错误提前退出；已恢复active_snapshot原query_row的缺表兼容并新增测试。失败日志保留在隔离交付，不把失败记为既有环境问题。

## 4. 集成身份与证据

before源SHA=`c062c18ece42468a57e8e02bd113dd1363ce7cffcf862b8a9ddf082644de3068`，受检after(LF)SHA=`748d85166d90f5ccd74d3c8f09da686415c4b2c587e0296e46cf2454d25ac16b`。Git集成产生CRLF、原始SHA=`4c93ddeb97266569afdda3d0ee2b90f856091b2426817763c012cfb29600185e`；归一化后逐字节完全相同，不是忽略未知diff。

独立只读复审 task `task-a65da936-95a9-4b2f-b3ea-c1b7549dc28b` 同意集成，且明确旧P2未全部解决。[集成debug日志](../Test/cr055-paired-integrated-debug.log)与[release日志](../Test/cr055-paired-integrated-release.log)均216 passed／0 failed／2 ignored、exit0。新旧实例/格式、行号、BM25、磁盘用例在当前版本有成功记录。

## 5. 真实优化程度与口径

见唯一[完整配对报告](../Test/REPORT-CR055-完整配对优化与性能标准.md)／[原始汇总JSON](../Test/cr055-paired-results.json)。

- 313文件67.216437MB：构建阶段60.498→48.392秒；主DB162.861056MB不变。
- 1250文件268.436250MB：245.014→208.835秒；主DB639.496192MB不变。
- 这是速度改善，不是空间改善；不把未运行的1GB/10GB数据乘算成真实成绩。
- after新增test-only阶段/WAL采样和收尾检索/sourcehash/page/checkpoint，外层wall含额外校验，非完全同构仪表；不猜测扣成本，不拿它当S-INDEX/P95。
- OS缓存未清，before旧harness未记PRAGMA和实测内存，memoryMeasuredExternally旧true不采信。最终mainDB用结束/checkpoint口径，WAL报告点不当连续峰值。

## 6. 剩余与下一方向

原四项存量P2：AI网关不识别kbsnapcursor、路径needle复核缺失、混合单字Han约束丢弃、旧P0候选限额完整性提示，继续留账，不以此补丁通过冒充全部软件通过。

下一次底层候选试验应优先复用已有成熟库，而非继续臆测下限。可在保持当前原件/授权/解析身份的条件下，用隔离可插拔索引适配器和同一固定语料对照，独立验证排名、中文召回、版本/崩溃/取消后再决定采用。**本批不接入新引擎**，不把公开性能当本机结果。

完整10GiB/GB单文件、16GiB目标机、真实Tauri/整应用视觉、连续内存/WAL峰值、heartbeat/取消动态、optimize增长超配额故障仍未验证；软件状态保持验证中/待进一步验收，不标整个Story完成。
