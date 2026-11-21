# DB-FEAT-008：知识原件切片与全文索引

> CR-055 v2候选扩展（2026-11-21）：[目录与索引发布增量](DB-CR055-性能目录与索引发布设计.md)登记directory/control/job/库代实体与查询/GC协议。既有文件/修订/权限/定位模型继续；原§3/§5当前FTS同事务替换仍用于有界小增量。大对象拟改库代影子表发布，不能把staging/retired词项混入active BM25；旧大源失效时同库全文暂不可用是G-SEARCH待决，**确认前不生效、不迁移、不视为软件已实现**。逻辑大清单按块持久化与流式核验，不要求单个JSON/数组入内存。CR055模式启用后，原§3查询中的`f.publishedGeneration=c.parseGeneration`及文件`g.state='published'`判当前方式由`active库代 → kb_index_member → parseGeneration`替代，FTS/TOC/关系/read共用；源currentRevision独立核新鲜度。旧published字段只可作非权威兼容投影，启用前仍按原协议。小更新同事务改member/FTS/epoch，影子切换不逐文件改5万指针；共享chunk由所有member/在途引用决定回收。正式DDL须按实际P0表集与迁移版本合并校验，不能将两份候选DDL直接拼接执行。

- 版本：DB-CR030-v1；状态：候选物理数据设计，**没有运行以下 DDL、建表、读取真实库或迁移数据**。
- 依据：[CR-030](../PRD/CR-030-本地知识索引与按需引用.md)、[FEAT-008](../Plan/Feature/FEAT-008-项目知识授权与只读检索.md)；继承 [CR-028 存储边界](../PRD/CR-028-文件与数据库按职责存储.md)、[DB-FEAT-001](DB-FEAT-001-知识授权与工作台数据设计.md#cr-028文件与数据库分工现行增量)，仅细化知识原件／派生数据，不修改需求正文、模型设计或会话业务权威。
- 唯一行为方案：[LLD-FEAT-008](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md)；AC：[STORY-036 08～13](../Plan/Story/STORY-036-知识库正式实现.md#cr-030本地知识索引与按需引用)、[STORY-009 08～11](../Plan/Story/STORY-009-知识库项目授权与AI检索.md#cr-030本地知识索引与按需引用)、[STORY-014 08～10](../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-030本地知识索引与按需引用)；[测试映射](../Test/TEST-CR030-本地知识索引闭环验证.md)。

## 1. 数据权威、范围与命名

| 数据 | 介质／权威 | 允许重建与编辑边界 |
| --- | --- | --- |
| 托管原件 | 受管文件，完整原格式字节 | 不因解析失败、清索引或移除绑定删除；物理删除另需授权 |
| 外部绑定原件 | 用户指定受检目录文件 | 本应用只读；绑定不是托管备份，不从派生材料回写 |
| 文件身份／修订／操作登记 | 既有 workbench.db 中新增结构记录 | 业务元数据，不从FTS猜身份或从路径hash恢复 |
| 大解析正文／结构与定位清单 | UTF-8不可变派生文件＋清单/hash | 无直接编辑入口，可按源hash和解析版本重建；不是第二可编辑权威 |
| 有限 chunk text／搜索词项／FTS | 同一 SQLite 的派生材料 | 单片≤4096UTF-8 bytes，服务只读；FTS词项是搜索副本，不维护独立编辑正文 |
| 授权、会话、引用／预算／游标账本 | 既有授权/会话与本次结构记录 | 事务权威，不随索引重建消失，不默认恢复权限 |
| 有出处的节点／显式链接 | 解析清单及数据库派生边 | 替换源代即失效，不产生无来源语义关系 |

仅知识库文件使用以下 `libraryId` 必填模型；项目附件继续现有项目范围登记，不强行混入知识库。所有复合外键带 libraryId，不凭全局 fileId 猜所属范围。原件目录和派生目录不得把真实资料加入源码Git。

身份为 `fileId`，修订为正整数 `sourceRevision`，解析代为不可变 `parseGeneration`，库查询代为单调 `indexEpoch`，竞争写入代为单调 `fence`，授权代为 `grantRevision`。`grantRevision`明确指下述单例`kb_access_epoch.revision`，不是现有grant行已具备的字段。它们互不替代：索引重建不是源修订，grant不是索引缓存。新 SHA-256 用 `sha256:<64 lowercase hex>`，旧FNV仍保留旧事实标识，不能回写冒充SHA。

现有[project_library_grant](../../src-tauri/src/db.rs#L82-L90)没有revision列，且[撤权](../../src-tauri/src/commands/knowledge.rs#L343-L360)删除grant行。候选迁移新增单例访问epoch，不复制grant、不在每个grant行上实现会被DELETE重置的版本。保存／撤权（包括删除后重授）、停用／移除库、知识工具有效范围或schema改变，必须与对应业务修改在同一SQLite事务内`epoch++`；无需改业务值的无操作可保持不变。读取仍以原grant为唯一允许来源，epoch只用于保守使旧游标／引用／准备响应失效。应用重启也推进访问epoch、使旧请求失效；不可只读旧epoch后继续运行。

## 2. 核心实体与约束

以下SQL是**面向未来迁移评审的候选DDL示例**，基于已存在的 `knowledge_library/project/session` 表。实际迁移编号、库版本、FTS5/JSON/原生解析组件能力与平台验证须在获编码授权后确定；不能直接贴到生产库执行。

```sql
PRAGMA foreign_keys = ON;
-- WAL / synchronous 与 SQLite backup API 在正式迁移、耐久测试中核定。
CREATE TABLE kb_access_epoch (
  singletonId INTEGER PRIMARY KEY CHECK(singletonId=1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  updatedAt INTEGER NOT NULL
);
-- 迁移只初始化epoch；不新增grant、不清空现有授权。initialUpdatedAt由宿主绑定。
INSERT INTO kb_access_epoch(singletonId,revision,updatedAt) VALUES(1,1,:initialUpdatedAt);
CREATE TABLE kb_library_state (
  libraryId TEXT PRIMARY KEY REFERENCES knowledge_library(id),
  partitionNo INTEGER NOT NULL UNIQUE CHECK(partitionNo > 0),
  indexEpoch INTEGER NOT NULL DEFAULT 0 CHECK(indexEpoch >= 0),
  tokenizerVersion TEXT NOT NULL,
  dictionaryHash TEXT NOT NULL,
  monitorState TEXT NOT NULL CHECK(monitorState IN ('healthy','unknown','reconciling')),
  monitorEpoch INTEGER NOT NULL DEFAULT 0 CHECK(monitorEpoch >= 0),
  reconciledAt INTEGER,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE kb_file (
  libraryId TEXT NOT NULL REFERENCES kb_library_state(libraryId),
  fileId TEXT NOT NULL,
  sourceMode TEXT NOT NULL CHECK(sourceMode IN ('managed-import','bound-directory')),
  displayName TEXT NOT NULL,
  sourceRef TEXT NOT NULL,
  sourceIdentityRef TEXT, -- 受检平台文件身份；未知不能靠hash合并对象
  currentSourceRevision INTEGER,
  publishedGeneration TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','active','missing','corrupt','removed','identity_conflict')),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(libraryId,fileId),
  FOREIGN KEY(libraryId,fileId,currentSourceRevision)
    REFERENCES kb_revision(libraryId,fileId,sourceRevision),
  FOREIGN KEY(libraryId,fileId,publishedGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration)
);
CREATE UNIQUE INDEX kb_file_active_ref ON kb_file(libraryId,sourceRef)
  WHERE state != 'removed';
CREATE TABLE kb_revision (
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  sourceRevision INTEGER NOT NULL CHECK(sourceRevision > 0),
  sourceHash TEXT,
  byteSize INTEGER NOT NULL CHECK(byteSize >= 0),
  mime TEXT NOT NULL,
  format TEXT NOT NULL,
  sourceRef TEXT NOT NULL,
  storageState TEXT NOT NULL CHECK(storageState IN ('pending','stored','missing','corrupt','failed')),
  freshness TEXT NOT NULL CHECK(freshness IN ('verified','stale','unknown')),
  statFingerprint TEXT, -- 提示/对账用，不当字节完整性证据
  lastVerifiedAt INTEGER,
  errorCode TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(libraryId,fileId,sourceRevision),
  FOREIGN KEY(libraryId,fileId) REFERENCES kb_file(libraryId,fileId),
  CHECK(storageState != 'stored' OR sourceHash IS NOT NULL)
);
CREATE TABLE kb_generation (
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  parseGeneration TEXT NOT NULL,
  sourceRevision INTEGER NOT NULL,
  sourceHash TEXT NOT NULL,
  parserVersion TEXT NOT NULL,
  chunkerVersion TEXT NOT NULL,
  tokenizerVersion TEXT NOT NULL,
  dictionaryHash TEXT NOT NULL,
  optionsHash TEXT NOT NULL,
  attemptId TEXT NOT NULL,
  leaseFence INTEGER NOT NULL CHECK(leaseFence > 0),
  state TEXT NOT NULL CHECK(state IN ('queued','parsing','sealed','published','retired','stale','failed','cancelled')),
  coverage TEXT CHECK(coverage IN ('text_ready','metadata_only','unsupported','failed')), -- queued/parsing时NULL=尚未知
  artifactRef TEXT,
  artifactHash TEXT,
  canonicalBytes INTEGER NOT NULL DEFAULT 0 CHECK(canonicalBytes >= 0),
  manifestRef TEXT,
  manifestHash TEXT,
  expectedChunkCount INTEGER NOT NULL DEFAULT 0 CHECK(expectedChunkCount >= 0),
  errorCode TEXT,
  createdAt INTEGER NOT NULL,
  sealedAt INTEGER,
  publishedAt INTEGER,
  PRIMARY KEY(libraryId,fileId,parseGeneration),
  UNIQUE(libraryId,fileId,attemptId),
  FOREIGN KEY(libraryId,fileId,sourceRevision)
    REFERENCES kb_revision(libraryId,fileId,sourceRevision),
  CHECK(state NOT IN ('sealed','published') OR (manifestRef IS NOT NULL AND manifestHash IS NOT NULL)),
  CHECK(state != 'published' OR (coverage IS NOT NULL AND coverage IN ('text_ready','metadata_only')))
);
CREATE UNIQUE INDEX kb_generation_one_published ON kb_generation(libraryId,fileId)
  WHERE state = 'published';
CREATE TABLE kb_chunk (
  chunkKey INTEGER PRIMARY KEY,
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  parseGeneration TEXT NOT NULL,
  chunkId TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('body','metadata')),
  startByte INTEGER NOT NULL CHECK(startByte >= 0),
  endByte INTEGER NOT NULL CHECK(endByte >= startByte),
  text TEXT NOT NULL,
  textHash TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  locatorJson TEXT NOT NULL,
  titleTerms TEXT NOT NULL,
  headingTerms TEXT NOT NULL,
  bodyTerms TEXT NOT NULL,
  bigramTerms TEXT NOT NULL,
  UNIQUE(libraryId,fileId,parseGeneration,ordinal),
  UNIQUE(libraryId,fileId,parseGeneration,chunkId),
  FOREIGN KEY(libraryId,fileId,parseGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration),
  CHECK(length(CAST(text AS BLOB)) <= 4096),
  CHECK((kind='body' AND endByte>startByte) OR
        (kind='metadata' AND startByte=0 AND endByte=0 AND text=''))
);
CREATE TABLE kb_outline_node (
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  parseGeneration TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  parentNodeId TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('heading','page','sheet','slide','topic')),
  locatorJson TEXT NOT NULL,
  PRIMARY KEY(libraryId,fileId,parseGeneration,nodeId),
  UNIQUE(libraryId,fileId,parseGeneration,ordinal),
  FOREIGN KEY(libraryId,fileId,parseGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration),
  FOREIGN KEY(libraryId,fileId,parseGeneration,parentNodeId)
    REFERENCES kb_outline_node(libraryId,fileId,parseGeneration,nodeId)
);
CREATE TABLE kb_relation (
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  parseGeneration TEXT NOT NULL,
  relationId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contains','parent_of','explicit_link')),
  fromLocatorJson TEXT NOT NULL,
  sourceEvidenceJson TEXT NOT NULL,
  targetFileId TEXT,
  targetGeneration TEXT,
  targetLocatorJson TEXT,
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','unresolved','external')),
  PRIMARY KEY(libraryId,fileId,parseGeneration,relationId),
  FOREIGN KEY(libraryId,fileId,parseGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration),
  FOREIGN KEY(libraryId,targetFileId) REFERENCES kb_file(libraryId,fileId),
  FOREIGN KEY(libraryId,targetFileId,targetGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration)
);
CREATE TABLE kb_index_lease (
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  ownerId TEXT,
  fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
  expiresAt INTEGER,
  PRIMARY KEY(libraryId,fileId),
  FOREIGN KEY(libraryId,fileId) REFERENCES kb_file(libraryId,fileId)
);
CREATE TABLE kb_scan_run (
  scanRunId TEXT PRIMARY KEY,
  libraryId TEXT NOT NULL REFERENCES kb_library_state(libraryId),
  state TEXT NOT NULL CHECK(state IN ('queued','scanning','indexing','completed','partial','failed','cancelled','interrupted')),
  fence INTEGER NOT NULL CHECK(fence > 0),
  cancelRequested INTEGER NOT NULL DEFAULT 0 CHECK(cancelRequested IN (0,1)),
  inventoryComplete INTEGER NOT NULL DEFAULT 0 CHECK(inventoryComplete IN (0,1)),
  countsJson TEXT NOT NULL, -- 固定schema，仅计数，不存正文；语义见下文
  errorCode TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  endedAt INTEGER,
  UNIQUE(libraryId,scanRunId)
);
CREATE UNIQUE INDEX kb_scan_one_active ON kb_scan_run(libraryId)
  WHERE state IN ('queued','scanning','indexing');
CREATE TABLE kb_operation (
  libraryId TEXT NOT NULL,
  operationId TEXT NOT NULL,
  scanRunId TEXT,
  fileId TEXT NOT NULL,
  sourceRevision INTEGER,
  attemptId TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('import','parse','publish','reconcile','derived_cleanup')),
  state TEXT NOT NULL CHECK(state IN ('intent','running','file_sealed','registered','done','failed','cancelled')),
  fileManifestRef TEXT,
  fence INTEGER,
  retryCount INTEGER NOT NULL DEFAULT 0 CHECK(retryCount >= 0),
  errorCode TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(libraryId,operationId),
  FOREIGN KEY(libraryId,fileId) REFERENCES kb_file(libraryId,fileId),
  FOREIGN KEY(libraryId,scanRunId) REFERENCES kb_scan_run(libraryId,scanRunId)
);
CREATE INDEX kb_revision_state ON kb_revision(libraryId,storageState,freshness);
CREATE INDEX kb_generation_state ON kb_generation(libraryId,state,createdAt);
CREATE INDEX kb_operation_pending ON kb_operation(libraryId,state,updatedAt);
```

循环引用按空指针登记file→插revision/generation→短事务CAS更新指针顺序落地；不得先指向未存在记录。示例默认外键 NO ACTION，**不级联删除原件／历史**。归档／删除派生generation先清当前指针和FTS引用，再通过受权清理清单处理，无引用也不表示允许删源文件。

`kb_scan_run`使没有fileId的空库／目录不可读也有记录：创建库级run后盘点，每个file操作可关联scanRunId，入库、取消和fence检查同批。`countsJson`固定包含`schemaVersion/discovered/inventoryChanged/inventoryUnchanged/inventoryMissing/outcomeTextReady/outcomeMetadataOnly/outcomeUnsupported/outcomeFailed/pending`非负整数；inventory分类互斥、outcome另一个轴，不把它们混加。每个操作只在幂等状态转换时在同事务更新计数，恢复用同run的operations／原件状态对账重算，不累计旧worker重复回调。只有inventoryComplete且pending=0才可completed/partial；已盘点的失败/未支持不等于未发现的0文件。取消run递增其fence、cancelRequested=1并终结未完成file attempt；重启活动run标interrupted并保留现有计数，显式重试建立新run，只重试合格项；不偷偷后台续跑或把partial清成成功。正常已发布的未变化文件保留，已检测变更的旧代仍stale。

服务校验补足DDL不能表达的约束：hash算法和格式；JSON结构/字节上限；manifest固定保存coverage、warnings、extractedParts、skippedParts和locatorPrecision，并绑定generation/hash，不把未提取部件或未知位置藏成成功；sourceHash必须等于所引用revision；当前指针所属源修订必须一致；published须stored＋可靠新鲜度＋sealed清单有效；词典/分词版本与该库有效版本一致；chunk正文恰为派生文件对应byte range；全部范围连续覆盖且textHash正确；metadata行无正文；定位precision不撒谎；relation同库目标必须当前且有出处。SQL FK并不证明实际文件存在／未越界／已受权。

## 3. 库内 FTS5 分区与示例

每个 `partitionNo` 由DB单调分配，表名严格由宿主生成 `kb_fts_l<正整数>`；不将模型传入的 libraryId／query拼到SQL标识符。所有分表仍位于同一个workbench.db，由同一个迁移/派生发布服务维护。

**FTS只含该库当前已发布可搜索材料**；未发布／取消／过期／保留历史generation的词项不写FTS，因此不会通过IDF/文档长度影响当前排序。metadata-only使用kind=metadata行，title/metadata可索引、body为空；unsupported文件仅有受权元数据发现，不冒充正文。

```sql
-- 示例：仅针对已登记 partitionNo=1 的库；不是全库共用FTS。
CREATE VIRTUAL TABLE kb_fts_l1 USING fts5(
  fileId UNINDEXED, parseGeneration UNINDEXED,
  title_terms, heading_terms, body_terms, bigram_terms,
  tokenize = 'unicode61 remove_diacritics 0'
);
-- FTS rowid = kb_chunk.chunkKey；FTS本身不支持普通FK，由发布服务核验。
-- 主检索的 :match 仅由固定词项pipeline生成，用户query永不直接解释为MATCH语法。
SELECT c.chunkId, c.locatorJson,
       bm25(kb_fts_l1,0,0,8,4,1,0.2) AS localRank
FROM kb_fts_l1
JOIN kb_chunk c ON c.chunkKey = kb_fts_l1.rowid
JOIN kb_file f ON f.libraryId=c.libraryId AND f.fileId=c.fileId
JOIN kb_generation g ON g.libraryId=c.libraryId AND g.fileId=c.fileId
  AND g.parseGeneration=c.parseGeneration
WHERE kb_fts_l1 MATCH :match
  AND c.libraryId=:authorizedLibraryId
  AND f.publishedGeneration=c.parseGeneration
  AND g.state='published'
ORDER BY localRank ASC,c.fileId ASC,c.ordinal ASC
LIMIT :boundedCandidates;
```

- 词项由本地最大匹配词典＋版本化归一化生成ASCII `w<hex>`，bigram为 `b<hex>`；四列为派生搜索材料。每次query同pipeline，literal构造、绑定参数，不接受FTS操作符／任意SQL。规则、单字受限派生扫描和精确/辅助召回分层见[LLD §5](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md#5-中文全文检索及分库统计)。
- FTS5 BM25值越小排序越前，初值权重8/4/1/0.2；没有正值cutoff。辅助召回单独标识。跨已授权库按库内名次 reciprocal rank `1/(60+rank)` 合并，file/chunk稳定破同分；不向AI返回未授权统计或全局IDF。
- 不采用全库FTS再在外层WHERE按授权过滤：虽然行被过滤，全库词频仍可能影响授权结果分数／排序。库内分表与“查询前＋返回前”的grant复检缺一不可。
- 单字候选扫描限定授权库当前 `kb_chunk.text`，每页1000行／4MiB、记录continuation；超限标incomplete，不扫描原件。归一化结果必须映射回canonical定位，不能把hex词项offset当正文offset。
- 不用FTS自动snippet/highlight对已编码词项做用户正文高亮；命中映射由词项→canonical byte span生成，返回原文安全转义片段。跨词界／辅助命中要做派生正文核验。
- 发布／失效／清理的FTS DELETE与INSERT由同一个SQLite事务和dispatcher执行，不在异步通知里补写。SQL全文rebuild只能从受检当前generation派生，不重新加入历史材料。更新词典时整库build暂存、一次事务换当前词项/版本并递增epoch，不能发布混合词典库。

## 4. 游标、预算与上下文账本

游标选定随机opaque token＋服务端账本，不同时维护其它签名游标方案。token使用256bit CSPRNG随机值，对外无业务字段；DB只存tokenHash。有效性由宿主身份和账本绑定复检，不由token声称权限。

```sql
CREATE TABLE kb_round_budget (
  roundId TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project(id),
  sessionId TEXT NOT NULL REFERENCES session(id),
  scopeHash TEXT NOT NULL,
  grantRevision INTEGER NOT NULL CHECK(grantRevision >= 0),
  limitBytes INTEGER NOT NULL CHECK(limitBytes > 0),
  usedBytes INTEGER NOT NULL DEFAULT 0 CHECK(usedBytes >= 0),
  reservedBytes INTEGER NOT NULL DEFAULT 0 CHECK(reservedBytes >= 0),
  controlRemainingBytes INTEGER NOT NULL DEFAULT 512 CHECK(controlRemainingBytes >= 0 AND controlRemainingBytes <= 512),
  state TEXT NOT NULL CHECK(state IN ('active','exhausted','closed','revoked')),
  expiresAt INTEGER NOT NULL,
  CHECK(usedBytes+reservedBytes+controlRemainingBytes <= limitBytes)
);
CREATE TABLE kb_cursor_ledger (
  cursorHash TEXT PRIMARY KEY,
  roundId TEXT NOT NULL REFERENCES kb_round_budget(roundId),
  projectId TEXT NOT NULL REFERENCES project(id),
  sessionId TEXT NOT NULL REFERENCES session(id),
  toolSchemaVersion TEXT NOT NULL,
  toolName TEXT NOT NULL,
  queryDigest TEXT NOT NULL,
  selectorDigest TEXT NOT NULL,
  grantRevision INTEGER NOT NULL,
  indexVectorJson TEXT NOT NULL,
  sourceVectorJson TEXT NOT NULL,
  nextPositionJson TEXT NOT NULL,
  maxPageBytes INTEGER NOT NULL CHECK(maxPageBytes > 0 AND maxPageBytes <= 8192),
  state TEXT NOT NULL CHECK(state IN ('fresh','consumed','expired','revoked')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  expiresAt INTEGER NOT NULL
);
CREATE TABLE kb_response_receipt (
  roundId TEXT NOT NULL REFERENCES kb_round_budget(roundId),
  requestId TEXT NOT NULL,
  requestDigest TEXT NOT NULL,
  cursorHash TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed','retry_requires_reselect','failed','revoked')),
  reservedBytes INTEGER NOT NULL DEFAULT 0 CHECK(reservedBytes >= 0 AND reservedBytes <= 8192),
  responseRef TEXT,
  responseHash TEXT,
  responseBytes INTEGER NOT NULL CHECK(responseBytes >= 0 AND responseBytes <= 8192),
  grantRevision INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(roundId,requestId)
);
CREATE TABLE kb_context_reference (
  referenceId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES session(id),
  projectId TEXT NOT NULL REFERENCES project(id),
  libraryId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  sourceRevision INTEGER NOT NULL,
  parseGeneration TEXT,
  rangesJson TEXT NOT NULL,
  locatorJson TEXT NOT NULL,
  sourceHash TEXT NOT NULL,
  grantRevision INTEGER NOT NULL,
  toolSchemaVersion TEXT NOT NULL,
  nativeThreadRef TEXT, -- 来自既有上下文编译器，未知不能证明驻留
  contextEpoch INTEGER CHECK(contextEpoch >= 0),
  residencyState TEXT NOT NULL DEFAULT 'unknown' CHECK(residencyState IN ('resident','ejected','unknown')),
  availability TEXT NOT NULL CHECK(availability IN ('current','stale','denied','needs_reselect','missing')),
  FOREIGN KEY(libraryId,fileId,sourceRevision)
    REFERENCES kb_revision(libraryId,fileId,sourceRevision),
  FOREIGN KEY(libraryId,fileId,parseGeneration)
    REFERENCES kb_generation(libraryId,fileId,parseGeneration)
);
CREATE TABLE kb_legacy_reference_state (
  sessionId TEXT NOT NULL REFERENCES session(id),
  legacyReferenceId TEXT NOT NULL,
  historyLocator TEXT NOT NULL, -- 既有message/refsJson中的稳定引用，不存第二份正文
  availability TEXT NOT NULL CHECK(availability IN ('needs_reselect','denied','missing')),
  replacementReferenceId TEXT REFERENCES kb_context_reference(referenceId),
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(sessionId,legacyReferenceId)
);
CREATE INDEX kb_cursor_expiry ON kb_cursor_ledger(state,expiresAt);
CREATE INDEX kb_reference_scope ON kb_context_reference(projectId,sessionId,availability);
```

这些是结构化事务记录，不复制完整办公正文；较大response封存在受管临时派生文件，以引用/hash登记。它也必须授权复检并纳入恢复清单，不暴露文件路径给模型。scopeHash绑定实际宿主session的project，不靠分别FK(project)/FK(session)证明二者属于同一项目；服务建立账本及消费每次比对现行session归属，服务器会话没有项目授权就拒知识内容。

- 设计预算基线：单次**完整序列化JSON envelope≤8192 UTF-8 bytes**，单宿主输入轮累计知识响应≤32768 bytes；search最多5项/摘要各400Unicode scalars。round由宿主创建，子代理/重试共用父账本；重要额度是拟议可逆技术默认，未虚构用户费用承诺。
- usedBytes计实际JSON bytes（包括usage、locator、摘要／大纲／关系、引用）；实际序列化计数核对并在短事务CAS提交，预算预留失败就不返回内容；响应若跨字数/字节护栏，减少完整项或安全截正文并生成cursor，不截locator或假eof。
- context去重以**既有上下文编译器**的nativeThreadRef/contextEpoch/residencyState为唯一驻留依据；kb_context_reference上述三字段仅为可校验投影，不创造第二套驻留源。只有同线程／同contextEpoch且resident并完全匹配file/revision/generation/range/schema/grant才可只传reference。unknown/ejected、summary淘汰、线程重建／重启全部重新读取计bytes；prepared receipt不能证明模型收到正文。tokens不可精确时null/unknown，字节预算不是整个模型窗口或费用硬限。
- cursor绑定round/project/session/query/selector、完整授权集及grantRevision、indexVector、sourceVector、maxPageBytes、到期；不能改filter/query重绑，不能跨项目／新轮使用。10分钟为拟议默认；新库generation发布即epoch变化，旧游标明确失效。
- 每轮在32768 bytes总量内预留512 bytes控制响应；普通预留必须满足 `usedBytes+reservedBytes+controlRemainingBytes<=limitBytes`。最终预算错误使用该控制额度并相应增加usedBytes、减少controlRemainingBytes，随后closed停止继续派发；不允许无限错误响应越过总额。完整JSON装不下时在调用前拒绝，不能截断locator或envelope。
- 每个新请求prepared receipt及其reservedBytes与round.reservedBytes同事务建立，requestDigest绑定tool schema/query/selector/scope/版本向量。已知失败可CAS释放该receipt预留；成功将cursor消费、reserved转used与receipt committed同事务提交。重投同requestId或投递状态不明一律retry_requires_reselect：中止旧请求并关闭该轮、保草稿，不重放正文、不续页、不把duplicate当成功。已用bytes不退回，关闭时才释放未消费预留；同ID异参统一拒绝。
- 应用／宿主重启时，单事务推进kb_access_epoch、所有旧active/exhausted round置closed并清reservedBytes、旧cursor revoked、prepared receipt置retry_requires_reselect并清其预留；usedBytes和receipt审计保留。不恢复旧round／游标／自动模型请求，只显示人类历史和草稿，重新选择后才建宿主新轮。因此本版不声称跨重启reservation续接。若无法证明旧线程是否收到正文，停止旧线程并显式新建，不能以新轮掩盖投递未知。
- 实际引用历史可保留denied/stale状态供所有者追溯，不当新的可发送缓存；legacy无版本引用统一needs_reselect，不能通过兼容工具自动变为全文。涉及清空不了的原生CLI线程必须停止并显式新建，数据表状态改变不等于线程内容已经消除。

## 5. 发布、失效与崩溃对账不变量

| 边界 | 原件／派生文件 | 数据库与可见性 | 恢复／拒绝规则 |
| --- | --- | --- | --- |
| import intent提交后未封存 | 只有临时片段 | pending，无可读原件 | operation清单内补验；未耐久就failed，不报告导入成功 |
| 原件封存后未登记stored | 文件有完整hash/清单 | pending | 对账已登记受管操作，验证后补stored；不复制第二份或删源 |
| parse封存前崩溃 | 产物不完整 | parsing，无FTS | 更高fence接管，有限新attempt；旧worker不继续发布 |
| parse sealed后发布前崩溃 | 完整不可变产物 | sealed暂存，不是current | source/hash/fence/取消复检后重新发布；旧source即stale |
| publish事务中故障 | 不可变产物保留 | SQLite全回滚或全commit | 校对published指针、chunk count/hash、FTS行/词项与links清单；不以指针单项假成功 |
| source变更／缺失 | 外部源已变／不可访问 | 立即stale/missing、删旧当前FTS、epoch++ | AI拒旧代；解析失败仍保历史，不能继续返旧正文 |
| 监控断档／积压 | 源新鲜度未知 | monitorState unknown、旧请求失效 | 对账＋监控基线重新可靠前AI拒；不能靠stat不变恢复current |
| 取消／两个writer | 任意旧封存产物 | fence单调，cancelled不能published | B更高fence胜出，A迟到回调/清理均拒绝 |
| grant变化／工具关闭 | 无需删原件 | grantRevision++、cursor/response/context失效 | 查询前和返回前同范围复检，已发历史不声称收回 |
| 清派生索引 | 原件和业务登记保留 | 重建FTS/chunks/links，epoch++ | 授权/历史不能从FTS恢复；物理原件删除不在本轮 |

publication比较 `(currentSourceRevision,sourceHash,previousPublishedGeneration,lease owner/fence/expiry,scanRun fence/cancel)`；sealed阶段chunks/outline/relations已一次性入暂存且不可见，publish仅校验manifest/范围/计数/hash，**不重复INSERT相同generation主键**。同事务先把旧published代retired（源变则stale），再删其FTS、按新暂存chunk插FTS、新代published并切指针/epoch；满足one_published唯一约束。outline/relations/read查询一律经published指针，不能泄露sealed暂存。部分解析失败只影响该文件，不清掉其他已发布代；已变文件拒旧current，相同source重建失败保上一完整代。

hash校验与数据库事务不保证文件系统和DB跨介质原子；source核验见[LLD §6](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md#6-新鲜度授权与读取边界)。检索只查询派生表，原件SHA仅核验本次输出涉及的受权文件；source stat监视不是完整性证明，未知监控不允许静默给AI旧结果。

## 6. 定位、迁移、备份和清理

- canonical位置统一UTF-8 byte区间 `[startByte,endByte)`，0-based；必须是Unicode scalar边界。JSON locator带`schemaVersion/kind/precision/sourceRevision`，真实page/slide/paragraph/record ordinal从1开始，sheet/cell/native node严格来自源。DOCX没有可靠page不填写；PDF必须枚举真实page tree；取不到坐标标unknown。完整locator装不下响应就返回明确错误／不返回该项，不能截断来源证据。
- chunk manifest核验正文范围覆盖、无重叠／无缝隙、真实分隔符、Unicode和hash；真实重复单元格不得按内容去重。header等元数据不混入正文byte区间。mapping中归一化span只能辅助搜索，不能替代源定位。
- 无sourceRevision/hash的legacy引用继续保留既有message.refsJson／历史正文，kb_legacy_reference_state仅记录其稳定historyLocator与needs_reselect/denied/missing状态；不插入要求非空修订/hash的新kb_context_reference，也不补0/未知hash伪装版本。重新搜索选择后新建版本化reference并可关联replacementReferenceId，旧历史事实不改写。
- 旧noteId映射设计为 `(libraryId,legacyNoteId) → fileId/迁移状态`，保留旧路径及旧hash算法标签，不以路径hash作为新身份。同名/同内容不可自动合并，身份不确定保identity_conflict；旧全文ref为needs_reselect。
- 正式迁移先检查真实schema/source再定版本；停相关writer，SQLite backup API取得一致库（或全部停写/关闭并处理WAL），备份托管原件与派生manifest/hash清单。绑定目录不能冒称已包含托管备份，备份恢复时逐源重新验证新鲜度。
- 重建生成新派生代，完成份额/文本/FTS/定位/链接对账后事务发布；不会重新授权。FTS损坏可按原件/清单重建；授权或文件身份账本损坏先拒并从受审一致备份恢复，不默认全开。
- 清理只接收受管manifest列出的失效派生/临时对象；必须检查不为current、无有效引用/响应/cursor、无活动lease、所属范围/fence一致；DB登记cleanup intent后文件与DB分步对账。清理范围不含原件/外部绑定源/授权/会话/验收历史；保留期和自动清理未确认前不自动物理删除。
- 有新原件/会话/授权写入后优先向前修复，不用旧备份覆盖；回退禁新工具和writer，保留新业务记录，不恢复全文旁路。200MiB文件等容量护栏、总库容量/磁盘低水位/保留期限为待确认项，不能把示例DDL当用户授权这些产品行为。

## 7. 本轮自查与后续验证

仅检查候选schema、复合范围与行为不变量；没有执行SQL或性能测试。正式必须验证FTS5编译、literal短词、未授权库统计不影响授权排序、原件字节/耐久保存、两writer/fencing、所有异步故障点、source监控断档、cursor/预算原子性、legacy和原生线程拒绝、备份/WAL/派生清理。测试计划为[TEST-CR030](../Test/TEST-CR030-本地知识索引闭环验证.md)，实际本轮结果由[REPORT-CR030](../Test/REPORT-CR030-知识索引设计验证.md)登记；不得把文档存在写成schema已上线。

## 8. P0 落地记录（2026-11-21，CR-030-D1）

本节登记 CR-030-D1 P0 实际执行的迁移与表结构（已运行、已测试），与 §2 候选 DDL 的差异均为登记偏差。实现：`src-tauri/src/commands/kb_index.rs`、`db.rs::migrate`；验证见 [REPORT-CR030-D1](../Test/REPORT-CR030-D1-切片与全文索引实现.md)。

实际执行 DDL（幂等，`migrate_cr030_knowledge_index`，末尾 `INSERT OR IGNORE INTO schema_version=2`）：

```sql
CREATE TABLE IF NOT EXISTS kb_library_state (
    libraryId TEXT PRIMARY KEY REFERENCES knowledge_library(id),
    partitionNo INTEGER NOT NULL UNIQUE CHECK(partitionNo > 0),
    indexEpoch INTEGER NOT NULL DEFAULT 0 CHECK(indexEpoch >= 0),
    tokenizerVersion TEXT NOT NULL DEFAULT 'local-bigram-hex-v1',
    updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_chunk (
    chunkKey INTEGER PRIMARY KEY,
    libraryId TEXT NOT NULL,
    noteId TEXT NOT NULL,
    relativeUri TEXT NOT NULL,
    parseGeneration TEXT NOT NULL,
    sourceHash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    kind TEXT NOT NULL CHECK(kind IN ('body','metadata')),
    startByte INTEGER NOT NULL CHECK(startByte >= 0),
    endByte INTEGER NOT NULL CHECK(endByte >= startByte),
    text TEXT NOT NULL,
    title TEXT NOT NULL,
    heading TEXT NOT NULL,
    startLine INTEGER NOT NULL,
    endLine INTEGER NOT NULL,
    UNIQUE(libraryId,noteId,parseGeneration,ordinal)
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_note ON kb_chunk(libraryId, noteId, parseGeneration);
```

- 相对 §2 候选集的 P0 差异（偏差登记）：仅建 `kb_library_state`+`kb_chunk`；kb_access_epoch/kb_file/kb_revision/kb_generation/kb_outline_node/kb_relation/kb_index_lease/kb_scan_run/kb_operation/游标预算账本全部延后。`kb_chunk` 相对评审确认的最小列集**增设 `relativeUri TEXT NOT NULL`**：knowledge_note_index 仍仅登记 Markdown（前端 noteCount 语义不变），非 md 文件（切片文本+metadata_only）的命中显示与 fail-closed 校验落在 chunk 行。`monitorState/monitorEpoch/dictionaryHash` 等列延后；tokenizerVersion 落库为 `local-bigram-hex-v1`（无词典 P0）。
- FTS 虚表不在本迁移创建：每库一张 `kb_fts_l<partitionNo>`（partitionNo 由 kb_library_state 单调分配、宿主生成表名、绝不拼输入），在该库首次发布时（分配 partitionNo 的事务内）`CREATE VIRTUAL TABLE IF NOT EXISTS … USING fts5(title_terms, heading_terms, body_terms, bigram_terms, tokenize='unicode61 remove_diacritics 0')`；普通 FTS5 表（应用侧 INSERT 词项行，rowid=chunkKey），不用 external content（按评审 D2 结论，分歧已在 LLD §11.1 说明）。词项格式 `w<utf8hex>`/`b<utf8hex>` 空格分隔 ASCII；bm25 权重 (8.0,4.0,1.0,0.2)。
- 退役语义：发布/重建在**同一 SQLite 事务**内先 `DELETE FROM kb_fts_lN WHERE rowid IN (SELECT chunkKey FROM kb_chunk WHERE …)` 再 `DELETE FROM kb_chunk`（词项删除从 kb_chunk 存储行取精确值，禁止手工重建词项）；任一步失败整事务回滚（trigger 注入测试验证）。发布事务内 `indexEpoch++`，chunk.parseGeneration=发布时 epoch；检索按每篇 `MAX(CAST(parseGeneration))` 只取当前代。测试固定跑 `INSERT INTO t(t) VALUES('integrity-check')`。
- 迁移验证：幂等重跑通过；CHECK（kind/partitionNo）与 FK（kb_library_state→knowledge_library）生效；schema_version=2 落库。metadata-only 行 `sourceHash=''`（空串，非字节摘要——未读原件字节），读取路径按 kind 拒绝正文。
- 未在本迁移执行的项（按设计保留为后续）：FTS5 编译探针已在单测通过（bundled rusqlite）；存量数据回填不在迁移做，由检索前惰性回填按库内联完成（实测 120 文件 813ms）。

## 变更记录

| 版本／日期 | 变更与依据 | 状态 |
| --- | --- | --- |
| DB-CR030-v1／2026-11-19 | 推荐方案的知识原件/不可变代/切片/分库FTS/授权游标预算与恢复闭环；只设计 | 新建候选设计，未实施／未迁移／未验收 |
| DB-CR030-D1／2026-11-21 | CR-030-D1 P0 正式编码：kb_library_state/kb_chunk/kb_fts_lN 实际落地；§8 登记 DDL、退役/代际语义与偏差（kb_chunk 增 relativeUri；其余表延后） | 已迁移、已测试（cargo test 119/120，唯一失败属并行会话 r6 avatar）；待用户验收 |
