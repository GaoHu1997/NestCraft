# RESEARCH-003：WeKnora 知识库检索机制调研与向量化取舍

- 日期：2026-11-20。来源：用户提问「查看 https://github.com/Tencent/WeKnora，我们是否可以抄他，把我们的知识库也放到向量数据库中，这样 ai 在项目中使用的时候更加丝滑」。
- 性质：**只读调研，不构成实现授权**。本轮未修改任何正式软件源码、依赖、运行配置或构建产物；未运行 WeKnora、未导入其代码。
- 方法：
  1. 主代理实读本仓库现行实现：`src-tauri/src/commands/knowledge.rs`、`src-tauri/src/commands/knowledge_files.rs`、`src-tauri/src/db.rs`、`src-tauri/src/commands/chat.rs`、`src-tauri/Cargo.toml`，以及 [CR-030](../PRD/CR-030-本地知识索引与按需引用.md)、[LLD-FEAT-008](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md)、[DB-FEAT-008](../DB/DB-FEAT-008-知识原件切片与全文索引.md)。
  2. 官方浏览器实读 WeKnora 官方 README、`/docs/03-features/04-chunking`、`/docs/03-features/05-retrieval-engines`、`/docs/02-architecture/04-rag-pipeline`。
  3. 取得 WeKnora v0.9.0 完整源码快照（codeload zip，解压后本地查阅），实读 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`internal/application/repository/retriever/sqlite/repository.go`、`internal/application/service/knowledgebase_search_fusion.go`、`internal/infrastructure/chunker/` 目录清单。
  4. 实读本机 cargo 注册表中 `libsqlite3-sys-0.30.1/build.rs`，确认本仓库 bundle 的 SQLite 编译开关。
- 未执行：未构建、未运行、未安装、未导入 WeKnora；未做任何性能实测；未调用任何 embedding 模型。

## 1. 用户诉求拆解

用户把三件事合在一句话里，需要先分开，否则会照着错误的答案施工：

| 用户说的 | 实际想要的 | 是否同一件事 |
| --- | --- | --- |
| 「抄他」 | 抄 WeKnora 的检索流水线设计 | 部分：它的部署形态不适合我们 |
| 「把知识库放到向量数据库」 | 让 AI 能按语义找到相关片段 | 不必然：向量数据库不是充分条件，也不总是必要条件 |
| 「AI 在项目中使用的时候更加丝滑」 | 检索快、准、不爆上下文、能溯源 | 这是验收标准，前两项只是候选手段 |

**核心判断：让检索变「丝滑」的瓶颈不在「有没有向量数据库」。** 按证据排序，影响最大的是分块、混合召回、预算与引用；向量只是混合召回的一路。

## 2. WeKnora 事实核验（v0.9.0）

### 2.1 是什么，不是什么

| 项 | 事实 | 依据 |
| --- | --- | --- |
| 形态 | Go 后端 + Vue 前端 + Python `docreader` sidecar + PostgreSQL/Redis，Docker Compose 部署 | 官方 README、`docker-compose.yml` |
| 定位 | 企业级知识平台：RAG 问答 + Agent + 自动 Wiki + IM/数据源接入 | 官方 README |
| 版本/许可 | v0.9.0；MIT（含第三方组件清单与例外声明） | `VERSION`、`LICENSE`、`THIRD_PARTY_NOTICES.md` |
| 可否抄 | MIT 允许复制/修改/分发，需保留版权与许可声明；但**其部署架构与本项目形态不同**，抄架构是错的 | `LICENSE` 正文 |

许可证注意：`THIRD_PARTY_NOTICES.md` 记载 OpenCC 词典数据为 Apache-2.0，并明确说明「上游 Go 转换器、`liuzl/da` 与 GPL 许可的 `cedar-go` 代码未被包含」。若我们将来复制它的中文转换相关产物，须重新核对随附数据与代码的边界，不能只看仓库根 `LICENSE`。

### 2.2 真正值得抄的部分（按价值排序）

**（1）分块：三级自适应 + 校验回退**

`internal/infrastructure/chunker/` 是一条完整的分块链，不是「按 512 字符切一刀」：

- 文档画像 `profiler.go`：单遍统计标题密度、行长方差、编号小节、换页符、语言（CJK/拉丁比例），据此选择尝试链。
- 三级策略与回退：`heading`（按 Markdown 标题层级切，维护 6 层标题栈产出面包屑）→ `heuristic`（换页符 100 / 编号小节 90 / 章节标记 85 / 全大写行 70 / 分隔线 60 / 页脚 50 / 连续空行 40 的优先级边界）→ `legacy`（递归分隔符 + 受保护区间）。
- **Validator 拒绝规则**才是它比朴素实现可靠的关键：无输出、大文档只切出 1 块、过碎小块超 1/4、最大块超 2× 目标，全部判定失败并降级到下一 Tier。`legacy` 永不返回空。
- 受保护区间：代码块、行内代码、公式、表格、图片/链接永不被从中间切开；超 7500 rune 才强制断行。
- 表头追踪 `header_tracker.go`：大表切块后每块自动重挂列名——这条对「项目里的参数表/接口表」检索质量影响非常直接。
- `ContextHeader`（标题面包屑）**只进 embedding、不进正文**，正文偏移不变式 `End-Start == RuneCount(Content)` 始终成立。这个设计让「检索时带章节语境」和「引用时能精确回原文」不再互斥。
- 父子分块：子块（默认 384）建索引、父块（默认 4096）供回答，父块只入库不入索引。

**（2）混合检索：上层统一 RRF，而不是依赖引擎的 hybrid**

`knowledgebase_search_fusion.go` 实读：`score = vectorWeight/(k+vectorRank) + keywordWeight/(k+keywordRank)`，再除以理论最大值 `(vectorWeight+keywordWeight)/(k+1)` 归一化到 `[0,1]`。默认权重 0.7/0.3。

关键点：**每个结果列表单独排名，chunk 取其在各列表中的最好名次**；只有单路结果时不走 RRF。官方文档明确写「无论引擎自身是否提供混合检索，WeKnora 的混合始终是上层统一的 RRF 融合」。

对我们最有用的一条：**向量分与 BM25 分数不可比，必须按名次融合，不能按分值加权**。BM25 无上界，直接和 cosine 混排会把结果整体压后。

**（3）中文检索：应用侧 bigram，不赌引擎分词器**

SQLite 路径 `tokenizeCJKBigram`：连续汉字按相邻二字切分（单字成块则保留单字），非 CJK 按原样成词，写入 FTS5 contentless 表。这样不依赖 FTS5 默认词法去猜中文词边界。

这与 [LLD-FEAT-008 §5.1](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md) 已设计的「词典分词 + bigram 辅助列」是同一类思路，可互相印证；差异是本项目设计了版本化中文词典，WeKnora 直接用 bigram，工程上更简单、召回更糙。

**（4）引用别名：内部 ID 不进模型上下文**

`internal/modelcontext/` 每次回答建一个请求级 `Registry`，把来源替换为低熵别名（`cN` 知识块 / `wN` 网页 / `dN` 文档 / `bN` 知识库），模型输出 `ref id="cN"` 标签再展开为公开引用；未知别名 fail-closed 直接删。这解决的是「模型复述长 ID/长 URL 会篡改」的实际问题。

**（5）问答流水线的阶段拆分**

`LOAD_HISTORY → QUERY_UNDERSTAND(改写+意图) → CHUNK_SEARCH_PARALLEL → CHUNK_RERANK → CHUNK_MERGE → FILTER_TOP_K → INTO_CHAT_MESSAGE → CHAT_COMPLETION_STREAM`。

其中对我们最该借鉴的是 `QUERY_UNDERSTAND` 的**意图分流**：`NeedsKBRetrieval()` 对 greeting/chitchat 返回 false，闲聊不触发检索。缺少这一层时，每句寒暄都会跑一次全库检索，体感反而更慢。

### 2.3 不该抄的部分

| 不抄 | 原因 |
| --- | --- |
| PostgreSQL + Redis + docreader sidecar | 我们是 Tauri 桌面单机应用，用户不应为查自己的笔记装一套服务端 |
| 11 种向量引擎的抽象层（Registry/Composite/Factory/按需 rehydrate） | 那是「一套代码服务多租户多后端」的成本；我们只有一个后端。抄它等于给自己造一个永不使用的插件系统 |
| 多租户 RBAC、IM 渠道、数据源同步、Sandbox | 不在本项目需求范围内 |
| 云端 embedding 为前提的默认配置 | 与本项目本地优先边界冲突（见 §4） |

**WeKnora 自己就证明了向量数据库是可替换后端**：它有 `sqlite` + `sqlite-vec` 的 Lite 路径，单二进制零外部依赖。这说明「要不要向量」和「要不要引入向量数据库」是两个独立问题。

## 3. 本项目现状（实测代码，不是文档描述）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 检索是**全库逐篇读原文件**做子串匹配 | [knowledge.rs:278-300](../../src-tauri/src/commands/knowledge.rs#L278-L300)：遍历库 → 遍历索引条目 → `files::read_text` 读全文（第 290 行）→ `content.lines().find(...)` | O(文件数 × 文件大小) 磁盘扫描；结果无相关度排序；每次搜索都在读盘 |
| 只有 `.md`／`.markdown` 参与搜索 | 同上过滤调 `files::markdown`，实现在 [knowledge_files.rs:30-32](../../src-tauri/src/commands/knowledge_files.rs#L30-L32)（仅这两个扩展名） | 上传的 txt/代码/pdf/xlsx 等虽可保存与列出，但不进搜索候选——这是「AI 查不到项目资料」的直接原因之一 |
| 索引表只有标题/路径/hash，**无切片、无词项** | [db.rs:71-80](../../src-tauri/src/db.rs#L71-L80) `knowledge_note_index` | 无法做分块级召回与引用定位 |
| `gateway_read` 返回**整篇正文** | [knowledge.rs:370-377](../../src-tauri/src/commands/knowledge.rs#L370-L377) | 一次引用就可能把整篇文档灌进上下文 |
| AI 引用走 `r.kind == "knowledge"` → `gateway_read` | [chat.rs:483-497](../../src-tauri/src/commands/chat.rs#L483-L497) | 同上，无字节预算 |
| 授权模型已具备 | `project_library_grant`，无记录即拒绝；`authorized()` 每次读取复检 | 这是既有优势，向量化不能绕过它 |
| 模型表无 embedding 类型 | [db.rs:120-134](../../src-tauri/src/db.rs#L120-L134) 只有 `text/vision/imageGen` | 接向量必须先扩展模型能力与 provider 协议 |
| **FTS5 已编进我们的 SQLite** | `libsqlite3-sys-0.30.1/build.rs` 含 `-DSQLITE_ENABLE_FTS5` | 全文检索零新增依赖即可用，这是最重要的现状事实 |

### 3.1 与既有设计的冲突点（必须先解决）

- [CR-030 §1](../PRD/CR-030-本地知识索引与按需引用.md) 与 [LLD-FEAT-008 §1](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md) 都明确写了**「不建设向量索引、自动语义关系提取或专用图数据库」**。
- [PRD-001](../PRD/PRD-001-个人Agent界面需求.md) 同样把「向量」列为本轮范围外。
- 因此：**引入向量不是「实现细节」，而是需求变更**。按 AGENTS.md §9.1 必须先立 CR 记录变更原因与影响，不能由代理在实现阶段顺手扩范围。

同时要明确：CR-030 设计的切片/FTS5/预算/游标**到现在仍未实现**（LLD 原文：「本轮没有解析器、FTS5、迁移、正式工具或真实性能结果」）。也就是说，「丝滑」的第一层能力其实还没有落地，向量只是第二层。

## 4. 关键取舍：向量化必然引出 embedding 来源问题

这是本轮唯一真正需要用户决策的点，不能由代理默认。

| 方案 | 知识库正文去哪 | 依赖 | 与本项目边界的关系 |
| --- | --- | --- | --- |
| A. 不引向量，只做 FTS5 混合 | 全程本机 | 零新增（FTS5 已编译进） | 完全符合现状设计 |
| B. 本地 embedding（Ollama / llama.cpp 外部进程） | 本机 | 用户需自行安装并运行模型服务 | 符合本地优先，但要处理「服务未启动」的降级 |
| C. 内置 embedding 模型（打包进安装包） | 本机 | 安装包显著增大（数百 MB 起） | 符合隐私，但分发体积与更新成本上升 |
| D. 云端 embedding API | **切片正文发往第三方** | 需网络与密钥 | **与本地优先冲突**，必须显式授权并逐库告知 |

补充事实：本项目知识库指向的是用户本地目录（`sourceKind='managed-directory'`），内容可能是私密项目资料。选 D 意味着用户的项目文档切片会离开本机——这不是技术问题，是产品承诺问题，需要用户明确同意。

## 5. 规模判断：我们需不需要「向量数据库」

按本项目形态推演（非实测，不得当性能承诺）：

- 个人/小团队项目知识库量级通常是**数百到数千文档**，切片后约 **数千到数万条**。
- 这个量级下，向量检索有两种实现：
  1. SQLite 内一列 BLOB + 应用侧暴力余弦（数万条 × 512 维的矩阵乘法是毫秒到几十毫秒级）；
  2. `sqlite-vec` 虚表（C 扩展，单文件引入，WeKnora Lite 路径即用此方案）。
- 两者都**不需要独立向量数据库进程**。Milvus / Qdrant / Weaviate 面向百万到十亿级，为它们引入运维面（端口、容器、备份、版本升级）对桌面应用是净负债。

结论：**「放到向量数据库」这个说法在我们的场景里应替换为「在既有 SQLite 里增加向量列/虚表」**。要不要向量是产品决策；要不要向量数据库是工程决策，答案是不要。

## 6. 建议路径（分阶段，均需另行授权）

### P0：先把「丝滑」的第一层补上（不改需求边界）

复用 CR-030 已确认的设计，不动向量：

1. 切片 + 定位：按格式感知切片，保留原文字节区间与页码/表格位置。
2. FTS5 全文索引：中文走 bigram（可直接参照 WeKnora 的 CJK 分块思路，实现上是几十行），英文数字按字符边界。
3. 检索改为查索引，**不再读原文件**：这是当前最大的体感改善。
4. 切片预算 + 游标：`gateway_read` 从「返回整篇」改为「返回有界片段 + 引用」。
5. 引用带版本：返回 `fileId/revision/range`，源变化后引用失效而不是静默给旧内容。

验收应能观察到：搜索不再全盘读文件；一次引用不再灌入整篇；命中能定位到段落。

### P1：混合召回（需先立 CR）

1. 增加向量通道，与 FTS5 各出一路候选。
2. **按名次做 RRF 融合**（权重与 k 可配），不做分值加权。
3. 融合后可选重排（本地或云端，默认关闭）。

### P2：embedding 来源可插拔

1. 模型表增加 embedding 能力类型；provider 支持 OpenAI 兼容 embedding 协议。
2. 默认「关闭」；用户显式启用并选择本地或云端。
3. 云端时必须逐库告知「切片会发往第三方」并取得确认；未确认则只走 FTS5 通道。
4. 模型未就绪/服务未启动时，检索降级为纯关键词，不报错、不阻塞。

### 明确不做

- 不引入 PostgreSQL / Redis / 独立向量数据库服务。
- 不搬运 WeKnora 的引擎抽象层与多租户能力。
- 不在未确认命中率的情况下承诺「语义检索一定更准」——中文短查询下 bigram+BM25 常常优于弱 embedding 模型，需实测比较。

## 7. 可复制性结论

| 问题 | 结论 |
| --- | --- |
| 法律上能不能抄代码 | 能。MIT，保留版权与许可声明；复制第三方词典数据前另核 Apache-2.0 边界 |
| 技术上有多少可抄 | 分块链（Validator/受保护区间/表头追踪/ContextHeader）、RRF 融合、CJK bigram、引用别名，这五项与语言无关、可直接移植思路 |
| 抄架构值不值 | 不值。它的服务端形态与我们的桌面单机形态不同 |
| 「放到向量数据库」是否等于变丝滑 | 不等于。当前最大瓶颈是「检索要读全盘文件」和「引用灌整篇」，这两点与向量无关 |
| 现在能不能动手 | 不能直接动。向量超出 CR-030 与 PRD-001 现行范围，须先立 CR 并确认 §4 的 embedding 来源 |

## 8. 未验证项与风险

- **未做任何性能实测**：§5 的量级推演与耗时估计是工程判断，不是本机数据。
- **未验证 embedding 模型在中文项目文档上的实际召回收益**：需冻结 query 集做对照，否则「换成向量更好用」只是假设。
- 未运行 WeKnora，其文档中「混合检索提升召回」是官方表述，本项目不据此宣称效果。
- 本项目 FTS5 是否在既有数据库上真正可用（不只是编译开关存在）需实际建表验证；本轮未执行。
- 迁移风险：切片与索引是新增派生数据，原件不动；但若后续引入向量维度，模型替换会导致索引失效，需要代际管理（CR-030 已设计 `indexEpoch`）。

## 9. 用户决策与后续状态（2026-11-20）

用户在阅读本调研后作出两项决策，已登记到 [CR-030 §6](../PRD/CR-030-本地知识索引与按需引用.md#6-本轮状态与变更记录) 的 `CR-030-D1` 行：

| 决策项 | 用户选择 |
| --- | --- |
| 实施顺序 | 先做切片 + SQLite FTS5，**不引入向量** |
| embedding 来源 | **暂不使用向量** |
| 本轮是否编码 | **否**，用户明确「先不写代码」「不改代码」 |

因此：本轮止于调研与需求记录。正式软件未修改，P0 未实现，向量方向已关闭且无待决的隐私取舍。

## 10. 本轮实际验证记录

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 未修改正式软件 | `git status --short -- src src-tauri package.json` | 输出为空，无源码/依赖变更 |
| 参考目录不入库 | `git check-ignore -v docs/参考/README.md docs/参考/WeKnora` | 命中 `.gitignore:2:docs/参考/`，已排除 |
| 本文档链接可达 | 逐条 `Test-Path` 核验 9 个内部链接 | 9/9 存在 |
| 全仓文档检查 | `node docs/Test/design-docs-check.mjs` | **失败**，但 6 条错误全部来自既有 CR-046 文件（缺失 `UI-CR046-右上角更新入口.md` 及 `../../Plan/...` 越级链接），**未出现任何本文相关错误**；统计 DOCS 263 / LOCAL_LINKS 4043 / 层级 1-8-20-68。这是范围外既有问题，本轮未接管、未伪装修复 |
| FTS5 可用性 | 读 `libsqlite3-sys-0.30.1/build.rs` | 确认 `-DSQLITE_ENABLE_FTS5` 已编入；**未实际建表验证** |
| 性能 | 无 | 未执行，本文不含任何实测数字 |

## 变更记录

| 版本/日期 | 依据 | 结果 |
| --- | --- | --- |
| RESEARCH-003 / 2026-11-20 | 用户询问是否可参考 WeKnora 引入向量数据库 | 只读调研完成；未改软件、未授权实现 |
| RESEARCH-003 / 2026-11-20 | 用户确认「先做切片+FTS5，暂不使用向量」「不改代码」 | 决策已登记 CR-030-D1；本轮止于调研，P0 未实现，向量方向关闭 |
