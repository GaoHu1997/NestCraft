# LLD-CR055-FEAT008-ENGINE：引擎候选实验与后续适配门禁

- 日期2026-11-22；FEAT-008／CR-055／[STORY-036](../Plan/Story/STORY-036-知识库正式实现.md)。
- 来源：用户同意“先做Tantivy与当前SQLite同文件组隔离对照”，只在隔离cfg(test)模块试验新依赖；本批不修改正式Cargo/运行配置或原件/授权，不切生产。
- 实验方案先于隔离代码，主代理归档其当前采用边界。该文件后续适配部分为**待评审方案，不代表已实现或迁移通过**。
- 唯一实际测量与状态源：[实验与独立审查报告](../Test/REPORT-CR055-检索引擎对照与独立审查.md)。上位仍为[CR-055](../PRD/CR-055-大规模编码与知识库性能.md)和[快照执行方案](LLD-CR055-FEAT008-快照执行设计.md)。

## 1. 本批已验证的候选结构

1. 使用固定发行Tantivy0.26.0(MIT)，实验依赖与锁单独保存；现有SQLite仍是正式默认路径。
2. 复用受检源打开/SafeRoot、原字节SHA256+FNV、严格解码、保留EOL的流式Chunker、2048字节primary与512字节suffix、本项目normalize和四字段词项，不让自然QueryParser解释用户语法。
3. 每实验库一个索引，primary/suffix和完整来源Meta均STORED，词项只INDEXED；默认LZ4/16KiB store blocks。1个indexing线程、50MBwriter预算，压缩/维护另有线程；预算不当进程硬限额。
4. commit+排空merge后取得Searcher's snapshot，校验成员/存储数量、原件stat与全部Meta/primary ranges，sync实验members/published文件后报完成。**published文件不是正式SQLite CAS/fence。**
5. 旧/新Searcher和格式校验只做局部模型；真实权限/CAS/资源/lease/旧代GC没有在这个adapter里实现，不把实验guard当真实授权。

## 2. 实测采用结论

相同完整文本组：67.216437MB原件、313file，索引162.861056MB→18.581377MB；268.436250MB原件、1250file，639.496192MB→74.231189MB。全正文/前瞻保留有重建证据。

构建是57.413/39.861秒与219.113/124.180秒的观察值，SQLite缺setup、Tantivy含额外校验且线程/预算不同，**不写严格同构提速百分比**。大组common-word适配器常规median4715.4105→3.20815ms，中文30.6592→1.25565ms，均不含IPC/UI；五个query的count/limit一致，不证明任意Unicode/返回文档/排名等价。

RSS采样27.47→79.77MB、private14.97→69.30MB（大组），额外内存成本明确。固定语料高度重复，不能外推到生产或10GiB。

独立审查允许的结论为：**值得继续候选适配，不准立即生产迁移**。这不是另造倒排底层，而是复用成熟库与保留宿主协议。新小型UTF16LE/BE完整文件链已补跑，不代替GB/随机source坐标验证。

## 3. 后续单Feature适配工作包（未实施）

### A. 先闭合语义与身份

- 实际持久化并在查询前校验engineSchemaVersion/tokenizerVersion/parserVersion/chunkerVersion/encodingVersion/contextVersion/optionsHash。
- stableFileId、libraryId、generation、parseGeneration、sourceSHA及canonical/source坐标不从客户端字段重建；新代文档不能clone不自洽旧Meta。修改文本后重新计算sourceHash/range/行号。
- 明确非ASCII大小写/Unicode61与WhitespaceTokenizer差异，测试Ω/ω、组合符、特殊字符、中文短语、单字与混合Han；既有literal语义不静默降级。
- 处理TopK候选与literal核验、同分顺序、overflow/incomplete；不以词项COUNT冒充literal全量命中，不因过滤后空结果说库没有匹配。
- 跑完整UTF16LE/BE文件、source/canonical精确定位、坏编码；已测小样本不是正式容量验收。填充密集另库，验证实际路由与统计隔离，而不只测空index。

### B. 再接宿主协议

- SQLite继续保管库/权限/稳定文件目录与任务控制，不直接把跨库过滤放到已算全局IDF之后冒充隔离；需要逐库统计则逐库index/searcher。
- 构建新代只在未公布目录中运行；所有文件/Meta/source验证、同步成功后才走原SQLite control CAS(sourceFence/baseEpoch/root/启用)，失败保旧active可搜。不能让Tantivy commit自动等于宿主已公布。
- 取消请求要有持久线性化、退出后释放槽、取消先成功不得公布；公布先成功只返回cancel-too-late，不回滚已确认代。
- AI search snippet/read输出前仍完整原件hash并复检授权，Tantivy docstore不代替源新鲜度验证。
- Searcher绑定同一generation/member；opaque cursor绑定engine/version、ordinal/offset与实例/库，lease/GC/Destroyed/配额保持，不自动回退新代。
- 物理磁盘低水位、逻辑和真实index临时+旧新代峰值、真实全部worker内存与并发上限，不把50MBwriter预算当全进程保证。

### C. 最后测迁移与同构性能

- 初次构建、增量重建、旧源外改/删、撤权、并发取消、重启、index缺失/损坏、磁盘满和回退都要过；保留当前SQLite路径，不能迁移失败丢原件或授权。
- 统一两侧输入/语义、资源档位、计时setup→公布与验证工作，再测异质中文/真实目标机和1/10GiB。不得用当前压缩比例预测所有库。
- 新可见状态若出现，必须先补UI设计与滚动义务；本批没有UI变更，UI-SCROLL-001暂不适用不等于后续可以忽略。
- 正式依赖分发需保MIT/AUTHORS和逐项依赖许可；不直接发布实验EXE。

## 4. 回退与完成线

当前未换默认引擎，实验失败不影响原件与业务数据。正式接入必须在新的受检Feature包完成上述门禁后进入灰度/默认切换，不用数据实验“有收益”代替代码/权限/数据验收。

本批仅对照与决策完成，整个Story/CR-055仍验证中。后续完成线是：语义/身份、真实协议、故障迁移、目标负载与同构资源测量逐项通过，并独立审查无阻断；未知或未测不得改标完成。
