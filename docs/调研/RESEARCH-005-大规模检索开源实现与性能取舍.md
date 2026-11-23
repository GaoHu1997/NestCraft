# RESEARCH-005：大规模检索开源实现与性能取舍

- 日期：2026-11-22；负责人lead；来源：用户要求查看GitHub同场景项目，能有好效果则直接复用，而非无限自行优化。
- 范围：代表性全文检索引擎／代码搜索／笔记知识库／大文本编辑实现。**不是“遍历所有GitHub项目”**。
- 方法：固定提交的选定源码与许可证、官方示例、公开基准原始JSON与统计方法；没有在本机运行这些引擎，没有完成迁移，没有把公开成绩当本应用成绩。
- 本项目已完成的真实同文件组对照：[完整配对与标准](../Test/REPORT-CR055-完整配对优化与性能标准.md)；原始数据[汇总](../Test/cr055-paired-results.json)。
- 源版本与下载完整性：[固定材料身份清单](../Test/cr055-reference-source-identity.json)。只下载指定模块／文档，**不是全仓源码克隆或所有版本核验**。

## 1. 结论先行

**有必要解决性能问题，但不应继续无限微调当前自行拼装的索引链路。**代表性开源项目表明，大文本扫描、带排名的全文检索和百万行编辑都已有成熟实现；不能再说“所有方案都做不到”或“3.5～3.9倍就是理论下限”。

推荐顺序：

1. 大知识库带排名检索：优先做 **Tantivy 的同语料、保正确性隔离试验**；成功则直接依赖成熟库，不把检索底层复制成自维护分叉。
2. 代码全文/原件流式搜索：优先复用 **ripgrep 的成熟搜索库／受管二进制**与 VS Code 的适配模式；不拿它替代索引排名或AI原件核验。
3. 多仓库多分支代码索引：**Zoekt** 是可评估方向，但不是当前Rust知识库的小成本替换，且它同样接受较大的索引空间换低延迟。
4. 编码区：保留已用 **CodeMirror 6**，修集成、缓存和输入扩展；不再另造编辑器或为“成熟”盲换Monaco。
5. **不照抄 Joplin 的中文基本搜索回退**：其官方文档自己提示大集合可能慢，且该路径排名不如FTS；有许可证义务需按模块核验。

**直接复用可以，盲拷整个仓库不合适。**优先把成熟引擎作为依赖，宿主只写授权／版本／数据接口；保留许可、版权和必要NOTICE。没有许可证明、只有截图或同名项目不能当可复制代码。

## 2. 官方公开性能与我们有什么不同

### 2.1 ripgrep：大文件扫描有明确秒数

固定提交：[5302ffaeb2d8b582603f5c88bf352d4c631cf684](https://github.com/BurntSushi/ripgrep/tree/5302ffaeb2d8b582603f5c88bf352d4c631cf684)。已读[README基准](https://github.com/BurntSushi/ripgrep/blob/5302ffaeb2d8b582603f5c88bf352d4c631cf684/README.md)。

| 官方场景 | 数据与条件 | ripgrep公开耗时 |
| --- | --- | --- |
| Linux源码树正则搜索 | i9-12900K 5.2GHz，`[A-Z]+_SUSPEND`，536行命中 | **0.082秒** |
| 单个约13GB英文字幕文本 | 文件已在系统内存缓存；`Sherlock [A-Z]\\w+`；7,882行命中 | **1.042秒** |
| 同一13GB场景加行号 | 同数据与查询 | **1.664秒** |
| 同一大文件较复杂、缺literal优化的模式 | `[A-Za-z]{30}`；6,749行命中 | **15.569秒** |
| 极高命中数 | `the`；83,499,915行命中 | **6.948秒** |

这不是13GB冷盘读取保证，也不是13GB构建永久索引耗时。默认忽略隐藏／ignored／binary，完整覆盖场景必须显式定义文件集，否则会“快”但漏掉目标文件。命中输出数量、行号、编码与模式会显著影响性能。

已读取 VS Code 的[实际集成代码](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts)：spawn成熟rg进程、流式JSON解析、取消进程、结果上限反馈、编码与ignore参数适配。**这是成熟产品直接使用成熟搜索工具的可读证据，不是本次复制或本机基准。**该文件标MIT，具体集成前须固定产品提交并保留归属。

### 2.2 Tantivy：最接近Rust知识库检索的现成底层

固定源码提交：[0aa896fe29417107ad0bbab502c1a9fd1077f272](https://github.com/quickwit-oss/tantivy/tree/0aa896fe29417107ad0bbab502c1a9fd1077f272)。已读[README](https://github.com/quickwit-oss/tantivy/blob/0aa896fe29417107ad0bbab502c1a9fd1077f272/README.md)、[Cargo配置](https://github.com/quickwit-oss/tantivy/blob/0aa896fe29417107ad0bbab502c1a9fd1077f272/Cargo.toml)、[基础示例](https://github.com/quickwit-oss/tantivy/blob/0aa896fe29417107ad0bbab502c1a9fd1077f272/examples/basic_search.rs)。该源码Cargo版本为0.27.0；**下面公开数据使用0.26，不混称同版本**。

功能包括：BM25、增量删除/重新索引、多线程IndexWriter、有预算的内存arena、压缩文档存储（LZ4/Zstd）、mmap、commit后搜索器不可变快照。支持Windows。中文需要插件或自定义tokenizer，不能凭默认英文示例说满足本项目中文召回。

基础示例里的作者描述：“约500万英语维基文章在作者机器约3分钟建立索引”。**这是示例注释中的作者陈述**，未给该数据的原始字节／具体机器／本机复跑记录，不拿它直接算我们10GiB应该多少秒。

#### 可复核的公开查询延迟

固定benchmark提交：[fd3da9e0840003d548d8bd1daa4f358386811d7a](https://github.com/quickwit-oss/search-benchmark-game/tree/fd3da9e0840003d548d8bd1daa4f358386811d7a)，原始[results.json](https://github.com/quickwit-oss/search-benchmark-game/blob/fd3da9e0840003d548d8bd1daa4f358386811d7a/results.json)、[统计脚本](https://github.com/quickwit-oss/search-benchmark-game/blob/fd3da9e0840003d548d8bd1daa4f358386811d7a/tools/analyze.py)、[说明与环境](https://github.com/quickwit-oss/search-benchmark-game/blob/fd3da9e0840003d548d8bd1daa4f358386811d7a/README.md)。

本次只解析原始JSON，按官方脚本同一“每条query的采样均值→跨query分位数”算法计算，不执行下载脚本。每场景962条query、9,620个样本；单位从微秒换为毫秒。[算出的公开数据摘要](../Test/cr055-public-search-benchmark-summary.json)。

| 公开引擎／版本 | 取前10条排名结果：query均值中位数 | 同场景95分位 | 取前100条+COUNT：中位数 | 同场景95分位 |
| --- | --- | --- | --- | --- |
| Tantivy 0.26 | **0.2677毫秒** | 2.6006毫秒 | **0.4579毫秒** | 7.7595毫秒 |
| Lucene 10.4.0 | 0.2211毫秒 | 1.8193毫秒 | 0.5569毫秒 | 14.1744毫秒 |
| Lucene 10.4.0（文档重排bp） | 0.1670毫秒 | 1.1576毫秒 | 0.4065毫秒 | 10.4956毫秒 |

**不是“Tantivy一律更快”**：前10结果场景Lucene领先，前100+count场景Tantivy优于普通Lucene，重排版又有不同取舍。某一个数字不能当普遍性能结论。

这些是**作者环境**（README报告AMD Ryzen7 9800X3D／Manjaro Linux／Rust1.96／OpenJDK21），英语维基语料、热页缓存、单查询线程。README写预热并按最好若干次选择，JSON实际包含每query十个采样，统计按脚本；文档与样本选择必须一并保留。**不是本应用的P95，不含扫描原件、我们的完整hash/权限验证、Tauri、界面、防抖或构建吞吐。**本机i7-12700/32GiB的数据只能另做同文件组试验得到。

### 2.3 Zoekt：快代码搜索不等于小索引

固定提交：[b55ce727df8cfbed76b8a1420445fd0cf93f3256](https://github.com/sourcegraph/zoekt/tree/b55ce727df8cfbed76b8a1420445fd0cf93f3256)，已读[README](https://github.com/sourcegraph/zoekt/blob/b55ce727df8cfbed76b8a1420445fd0cf93f3256/README.md)及[设计](https://github.com/sourcegraph/zoekt/blob/b55ce727df8cfbed76b8a1420445fd0cf93f3256/doc/design.md)。

- 采用**带位置的trigram倒排索引、分片+mmap**，搜索先用稀有字组过滤，再核验原文/正则；同文件分支复用，支持多库多branch。
- 设计目标是 Android约2G文本等大代码库查询**低于50毫秒**；这是目标，不是本次作者完整基准数或本机实测。
- 同设计文档经验记录：索引大约原文**3倍**，完整分片实践约**3.5倍**。直观说，**若原文有1GB，该文档的经验比例对应约3～3.5GB索引，合计约4～4.5GB磁盘**；这是比例解释，**不是本次测出的1GB→3.5GB**。
- 单片用32bit offsets、目标内容每片约1GB；UTF8按rune位置转换。不是支持任意5GiB单文件的既有证据。
- 它以Go/受管服务为主，符号索引可用ctags并需sandbox；不能不加适配就嵌入当前Rust SQLite业务数据库，也不能拿其code-ranking替代我们的库内BM25语义。

这个例子反而说明：**占更多磁盘换较快查询可以是成熟方案的合理取舍**，2倍空间不是普适标准。

### 2.4 Joplin：成熟产品也明确承认中文大集合的限制

固定提交：[be47a3feb1b70a376ffed6811aa01474caeddc5b](https://github.com/laurent22/joplin/tree/be47a3feb1b70a376ffed6811aa01474caeddc5b)，已读[搜索说明](https://github.com/laurent22/joplin/blob/be47a3feb1b70a376ffed6811aa01474caeddc5b/readme/apps/search.md)及[当前官方帮助](https://joplinapp.org/help/apps/search/)。

FTS4让常规笔记全文索引查询快速；中文、日文、韩文、泰文使用不经FTS的自定义模式。官方明确写“大笔记集合可能慢”，该路径排名也不如FTS；基本搜索可以“极慢”。**没有在这些来源里找到与本项目50,000文件/10GiB一致的完工秒数和空间数据。**

可以借鉴按笔记/文件粒度更新、过滤与索引分层，但不把中文基本扫描拷进大库后称为性能升级。

### 2.5 CodeMirror：百万行能力已有，不能靠换名字优化

已读[官方大文档示例](https://codemirror.net/examples/million/)：加载几百万行，并明确限制parser工作量、非活动编辑器停工，滚到远处时高亮逐步跟进。

这证明其作者给出了大文档路径和可操作演示，**不是5GiB完整编辑、全量语法即时完成的性能承诺**，本次未跑其浏览器benchmark。我们已经使用CodeMirror6，因此优先修集成的每键全文复制、监听器、模型留存与解析，不再造编辑器或盲换Monaco。

## 3. 能不能直接抄

| 实现 | 已读许可 | 建议 |
| --- | --- | --- |
| Tantivy | [MIT](https://github.com/quickwit-oss/tantivy/blob/0aa896fe29417107ad0bbab502c1a9fd1077f272/LICENSE)，归属指向AUTHORS | 可以复用库／示例，保留版权与许可；中文插件和分发依赖另核。优先使用发行依赖，别复制内部倒排代码自维护 |
| ripgrep | [MIT](https://github.com/BurntSushi/ripgrep/blob/5302ffaeb2d8b582603f5c88bf352d4c631cf684/LICENSE-MIT)／Unlicense双许可 | 可复用成熟库／受管binary；保留许可与作者归属；需正确设置过滤、取消与输出预算 |
| VS Code该rg适配文件 | 文件头标MIT | 可借／复用适配思路，集成前固定commit并保留Microsoft归属；本次未复制到软件 |
| Zoekt | [Apache-2.0](https://github.com/sourcegraph/zoekt/blob/b55ce727df8cfbed76b8a1420445fd0cf93f3256/LICENSE) | 可评估服务/CLI，但再分发时核NOTICE/依赖/ctags，接受其存储和部署成本 |
| Joplin | [默认AGPL-3.0-or-later，子目录可另有许可](https://github.com/laurent22/joplin/blob/be47a3feb1b70a376ffed6811aa01474caeddc5b/LICENSE) | 不是“禁止商业用”；复制/组合/分发的义务依具体模块判断，商标和图标未授权，不能当MIT整套拷贝 |
| CodeMirror state | [MIT](https://github.com/codemirror/state/blob/main/LICENSE) | 当前已用依赖，继续正确集成；其它包版本/声明按实际分发核对 |

**复用正确的引擎，不复用不适合的业务假设**：Tantivy示例body未STORED，虽然省空间但不能从store读全文，我们需要的只读快照/AI正文不能因此消失；示例QueryParser会解释查询语言，与本项目literal要求不同，不能原样替换用户查询。必须用适配器保留：库隔离、stableId、源hash/坐标、逐库统计、不混代、授权、完整源核验、可取消与响应上限。

## 4. 是否还有必要继续优化：明确止损策略

### 本项目自己的已测事实

在同机器同真实固定文件组上：

| 原件大小 | 索引前→后 | 构建阶段前→后 |
| --- | --- | --- |
| 67.216437 MB，313文件（各3次中位数） | 162.861056→162.861056 MB | 60.498→48.392秒 |
| 268.436250 MB，1,250文件（各1次） | 639.496192→639.496192 MB | 245.014→208.835秒 |

速度减少约20.0%／14.8%，主DB空间少0字节。当前after大组里：完整hash约1.059秒、解析18.257秒、批插入70.824秒、清单验证57.495秒、其它52.766秒——**只优化检索底层也不会自动消除所有宿主开销**。

### 建议停止的事

- 停止为了“2倍”这个未经冻结的标准反复删能力或试DDL。
- 停止把未完成10GiB采样重复杀掉重跑然后报外推百分比。
- 停止继续造词项存储、排名或语言分词底层；这些成熟库已有。

### 建议继续的一次有界试验

下一实施包只选两个候选：**现有受检SQLite路径** 与 **Tantivy发行版+本项目适配器**，先跑相同67.216/268.436MB完整文件集，测源hash、解析、建索引/提交、查询Top100、读取/源校验、磁盘总量与内存；中文/短语/特殊字符/跨块/禁库撤权/取消/旧快照都要过。

- **若有显著完整链路收益且正确性全过**：采用成熟引擎，保留SQLite管理权限/元信息，不把数据搬迁当“零成本复制”。
- **若引擎自身快，但完整链路无收益**：优化已测出的宿主文件保护／多次I/O／清单校验，不再抠倒排实现。
- **若正确性全过但差异小、已有用户等待目标满足**：停止追加优化，选择维护成本低的实现。
- **若候选都不能满足目标，且profile无可控热点**：回到产品容量／冷暖等待／磁盘与CPU成本取舍，明确放宽/缩小范围，而不是无限尝试或假装达标。

“显著”的验收收益线与允许等待上限应在试验正式验收前确认；不把同一批成绩反过来当其自身通过线。当前门槛仍候选，**不能声称已经批准2倍或某个固定分钟目标**。

## 5. 本轮未做与来源限制

- 没有“看完所有GitHub项目”，只核验以上代表性实现与固定材料。
- 没有在本机运行Tantivy/Zoekt/ripgrep基准、没有接入新依赖到正式软件；公开数据不能代表我们的Windows/中文/真实Tauri性能。
- 没有复核各分发依赖与所有子目录许可证，不宣称整个仓库可无条件复制。
- 搜索接口HTTP402不可用，改用官方URL直读；早期main/master候选404和一次网络失败均未当作“项目不存在”。
- 公开README示例注释可能沿用历史性能或简化设置，采纳实现前固定实际发行版本并同组复验。
- 当前项目的1GiB/10GiB完整索引、GB单文件、16GiB目标机、整应用视觉/IPC/断电/内存仍未因本批小组与调研被标为完成。
