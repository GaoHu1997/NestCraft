# DB-FEAT-001：知识授权与工作台数据设计

- 状态：下文 CR-005～012 为历史逻辑设计，并非全部物理表已经落地；CR-015 已实现本地 SQLite 与文件正文基础，实际代码见 [db.rs](../../src-tauri/src/db.rs)。2026-11-19 CR-028 增量为现行存储分工设计，新增原件登记／恢复字段未实施，本批不建表、不迁移、不访问真实数据库。
- 关联：[需求汇总](../需求汇总.md)、[PRD-001](../PRD/PRD-001-个人Agent界面需求.md#cr-005项目知识授权与统一-ai-工作台)、[STORY-009](../Plan/Story/STORY-009-知识库项目授权与AI检索.md)、[STORY-010](../Plan/Story/STORY-010-需求树与详细文档预览.md)、[STORY-011](../Plan/Story/STORY-011-AI侧栏上下文与会话.md)、[STORY-012](../Plan/Story/STORY-012-统一配置与CLI能力适配.md)。
- 决策：[ADR-001](../LLD/ADR-001-文档正文与统一能力网关.md)；接口/权限以 [LLD CR-005](../LLD/LLD-FEAT-001-仿真原型.md#cr-005项目知识授权需求树与统一-ai-工作台v24-设计基线) 为准。

## 1. 权威数据与文件组织

| 数据 | 权威来源 | 投影/用途 |
| --- | --- | --- |
| 愿景/Epic/Feature/Story 正文、状态、AC、父项、确认与验收依据 | 项目 Markdown 文档 | SQLite requirement_index，为树/查找和汇总重建 |
| 知识笔记正文及版本 | 受管知识源 | note_index / 全文检索；引用携带源版本 |
| 项目与知识库授权 | SQLite project_library_grant | 每次工具/上下文读取实时检查 |
| 模型/MCP/Skill/Tools 配置 | SQLite settings registry，密钥为外部 secretRef | 生成一次执行能力快照/CLI临时配置 |
| 会话、消息、结构化引用与草稿 | SQLite sessions/messages | 历史恢复与同项目范围 |
| 附件内容 | 项目受管附件目录，外部路径不得直接由模型读取 | SQLite attachments 保存关联/解析状态 |

正式产品本地 SQLite 放工作台应用数据目录，不放项目源码或需求正文目录；附件、临时配置与缓存也不默认入 Git。具体应用数据绝对路径在实现阶段由目标平台决定，本文不伪造现存目录。知识源路径只交给受管服务，CLI 不持有原始路径凭证。

正式需求 front matter 的最小契约示例（现有 Markdown 无 front matter 可导入为兼容投影；不因本设计改写历史编号）：

```yaml
id: STORY-010
type: story
parent: FEAT-003
status: 设计中
owner: lead
priority: P0
schemaVersion: 1
```

正文仍保存可执行 AC、确认依据、验收/验证、阻塞及链接；数据库绝不另存一个可编辑的 Story 正文副本。

## 2. 实体与约束（逻辑字段，尚无建表脚本）

通用：ID 用 TEXT 稳定标识；时间 INTEGER UTC 毫秒；revision 非负整数；布尔用 INTEGER 0/1；JSON 字段有 schemaVersion 并在服务校验，不能用任意 JSON 代替授权约束。

| 实体 | 核心字段、类型与含义 | 约束/索引 |
| --- | --- | --- |
| project | id TEXT PK，name TEXT，type TEXT，rootUri TEXT，createdAt INTEGER | type∈code/work；rootUri 规范化；历史不跨项目 |
| requirement_index | projectId TEXT，entityId TEXT，type TEXT，parentId TEXT?，title TEXT，status TEXT，owner TEXT，sourceUri TEXT，contentHash TEXT，sourceRevision TEXT，indexedAt INTEGER | PK(projectId,entityId)；UNIQUE(projectId,sourceUri)；INDEX(projectId,parentId/status)；父类型/无环服务校验；仅派生、不写正文 |
| knowledge_library | id TEXT PK，name TEXT，sourceKind TEXT，sourceRef TEXT，revision INTEGER，enabled INTEGER | sourceKind∈managed-directory/connector；sourceRef 对用户权限受限；无 public 默认 |
| knowledge_note_index | libraryId TEXT，noteId TEXT，title TEXT，relativeUri TEXT，contentHash TEXT，sourceRevision TEXT，updatedAt INTEGER | PK(libraryId,noteId)；UNIQUE(libraryId,relativeUri)；外键 library；搜索索引分库，不泄露全库统计 |
| project_library_grant | projectId TEXT，libraryId TEXT，readAllowed INTEGER，revision INTEGER，updatedAt INTEGER，actor TEXT | PK(projectId,libraryId)；FK project/library；无记录或 readAllowed=0 均拒绝；INDEX(libraryId,readAllowed)；授权事务提交后使缓存/令牌失效 |
| model_config | id TEXT PK，provider TEXT，baseUrl TEXT，modelId TEXT，secretRef TEXT，reasoningJson TEXT，enabled INTEGER，revision INTEGER | secretRef 不含明文；provider/model 组合有稳定引用；schema校验 |
| cli_adapter | id TEXT PK，version TEXT，enabled INTEGER，installState TEXT，capabilityMatrixJson TEXT，verifiedAt INTEGER? | CLI ID 唯一；矩阵按版本+运行模式，未知标未验证 |
| capability_config | id TEXT PK，kind TEXT，sourceRef TEXT，schemaJson TEXT，risk TEXT，enabled INTEGER，secretRef TEXT?，revision INTEGER | kind∈tool/resource/prompt/skill/client-command；同名显示来源；INDEX(kind,enabled)；权限拒绝优先 |
| setting_default | scope TEXT，key TEXT，valueRef TEXT，revision INTEGER | PK(scope,key)；scope 为 global/project ID，默认CLI与会话CLI分离；引用有效性校验 |
| session | id TEXT PK，projectId TEXT?，serverId TEXT?，title TEXT，cliId TEXT，modelRef TEXT，nativeThreadRef TEXT?，draft TEXT，createdAt/updatedAt INTEGER，status TEXT | CHECK恰一个范围键非空；INDEX(projectId,updatedAt)/INDEX(serverId,updatedAt)；不能换CLI冒充原线程 |
| message | id TEXT PK，sessionId TEXT，role TEXT，content TEXT，contextRefsJson TEXT，createdAt INTEGER，configRevision INTEGER | FK session；INDEX(sessionId,createdAt)；不存秘密；知识来源标版本/授权状态，撤权正文不再用于模型输入 |
| attachment | id TEXT PK，sessionId TEXT，projectId TEXT?，displayName TEXT，storageRef TEXT，mime TEXT，byteSize INTEGER，contentHash TEXT，status TEXT，errorCode TEXT? | INDEX(sessionId,status)；状态selected/uploading/parsing/ready/failed/removed；大小非负；storageRef不得任意路径；本地File名称不当路径 |
| context_reference | id TEXT PK，sessionId TEXT，kind TEXT，objectId TEXT，libraryId TEXT?，sourceRevision TEXT，availability TEXT | FK session；INDEX(sessionId,availability)；恢复/发送/打开重新授权，不沿用历史成功 |
| execution_snapshot | id TEXT PK，sessionId TEXT，cliId/modelRef TEXT，configRevision INTEGER，grantRevision INTEGER，capabilitiesJson TEXT，state TEXT | 不存密钥；安全撤销立即失效；旧审批不恢复为可执行 |

同用户管理知识库和项目权限，不扩展多租户角色体系。服务器会话引用现有服务器设计边界，仅定义 serverId 范围，不在本轮新增认证表或真实主机凭证。

## 3. 一致性与并发

1. 保存需求：校验 ID/父关系/目录范围 → 比对基线 hash → 备份可恢复源版本 → 原子写 Markdown → 更新投影事务。投影失败显示待同步并重建，不用数据库旧值覆盖文件。状态变更也走相同源写入流程。
2. 搜索：先解析当前托管会话的项目 → 取授权库集合 → 在允许分区查询。全文索引只是派生数据；撤权即使索引仍存在也不可命中/计数/读取。
3. 授权：事务修改 grant 与 revision；运行中撤权取消相关提案、清掉可发送引用正文/缓存、吊销短期令牌。历史展示不假称内容已收回；旧 CLI 线程无法清理时停止并另建。
4. 配置：注册表是唯一源；生成受管短期配置需带引用和版本。运行模型快照不被中途换模型，安全开关最新值优先。适配器不得写入用户原生配置。
5. 附件与历史：上传中/失败不作为 ready；恢复重新校验对象、权限和解析状态。项目附件不可恢复到其他项目；删除会话不越界删除共用原文件，本轮不实施自动清理。

## 4. 迁移、备份与恢复

- 当前不存在业务数据库。第一次真实实现先备份现有项目 Markdown/知识源，再创建 schema 与索引；导入项目与稳定实体 ID，缺少父关系记录导入错误，不能猜测已确认。
- 既有库授权初始化为全部无授权，所有者显式勾选后才开放；没有“为了兼容默认全开”的窗口。
- 导入后校验数量、ID唯一性、父链、内容 hash 和许可范围；随机抽查树/预览与源文档，执行跨项目拒绝测试后启用真实网关。
- 版本迁移通过schemaVersion管理；迁移前备份数据库及受管文件。迁移中停写，不承诺双写旧权限模式；迁移失败恢复备份并停用网关/适配器，保持 fail-closed。
- 索引可删除重建，**授权不是可从检索索引推导的数据**；授权表损坏时停止知识调用并从受审备份恢复，不能默认公开。正文先写后投影失败采用向前重建。
- 回退不得重开绕过授权的直连工具。不可逆物理删除不属于本轮；后续若引入，另行确认、备份和描述处置。

## CR-006：Git 派生状态与会话基线

关联 [STORY-013](../Plan/Story/STORY-013-文件Git页签与AI分支上下文.md)。复用project/session/execution_snapshot，新增project_ui_preference(projectId PK, leftTab file/git, updatedAt)，执行快照附repoId/worktreeId/branch/headOid/gitRevision，消息附当时Git上下文。

`project_git_snapshot` 可缓存 repoId、worktreeId、rootUri、branch?、headOid?、status（loading/ready/no-repo/detached/error）、dirty、remote/upstream、readAt。该表仅是当前工作目录的派生快照，**Git仓库自身是权威**；不能独立改数据库branch来切仓库。恢复会话不写回历史branch。发送/批准写操作重读HEAD，外部变化使旧基线失效。UI偏好恢复不扩权、不修改真实仓库。

本轮字段仅原型内存，无真实库/迁移；后续增表/列先备份DB，缺少旧消息Git基线时标未知，不回填main或虚构SHA，旧提案默认不能执行。回退停用新Git执行能力，保留仓库和用户未提交文件，不运行reset/clean等破坏性恢复。真实Git读取/冲突/网络与凭证验证另按Story AC执行。

## CR-009：草稿、设计模型与成组调整

关联 [STORY-016～018](../需求汇总.md)。复用项目/需求源文档和执行快照；设计稿/模型设计是设计文档，不是运行数据库表，原型仍内存。

| 逻辑实体 | 字段/约束与权威 |
| --- | --- |
| design_resource | projectId/id PK、kind(page/model)、sourceUri、sourceHash、linkedStoryIds；设计稿manualEditable=false，仅受控AIpatch；源目录受项目限制 |
| model_design | projectId/id PK、sourceUri、tables/fields/constraints投影、linkedStoryIds/AC；模型正文为权威，投影只读；名称/类型/PK/FK/引用校验，不执行SQL |
| adjustment_draft | projectId/targetId PK、kind、baseRevision/baseHash、draftContent、syncState；未提交草稿独立于已同步基线，待同步阻止开发验收；不能覆盖用户未提交改动 |
| change_set | id PK、projectId、source、baseRevision、changesJson(op/path/before/after)、feedback、gitSnapshot、createdAt；服务器计算实际差异，零diff不请求AI |
| adjustment_proposal | id PK、changeSetId、targets(baseHash/patches)、writeAllowList、requirementImpact/requiredApprovals、status、configRevision；整包权限/hash/HEAD/模型和依赖校验，唯一应用ID保证幂等 |
| adjustment_audit | id PK、proposalId、actor、time、action、affectedIds、before/afterRevision；批准/拒绝/失效留痕，不存秘密，未影响对象不生成伪变更 |

- 字段类型沿用TEXT稳定ID、INTEGER UTC时间/revision、受schema校验的JSON；projectId/targetId与source范围强约束，变动path不能任意本机路径；INDEX(projectId,syncState)、INDEX(changeSetId/status)。
- 手工草稿可展示待同步但不能冒充已同步权威；批准之前构造新对象副本，校验设计/模型/需求关联全部完整。缺必要需求patch或任一冲突整包拒绝，不先应用部分。
- 正式多Markdown写回使用事务日志/临时备份和同批次版本：全部写回成功才发布索引/新基线，失败按日志恢复，保留用户草稿；索引重建不能把未同步草稿当已确认需求。
- 删除活跃需求保留审计/基线记录，有子项或引用先拒绝，不默认级联；归档历史不伪装完成。恢复提案不能恢复过期权限或旧分支。
- 尚未建真实表/迁移。真实实现先备份，旧实体导入已同步基线，草稿独立；未有基线的旧提案默认不能执行。回退停用提交执行，不删除用户正文/真实Git修改或回到绕过权限路径。

## CR-010：项目位置与逆向任务

关联 [STORY-019](../Plan/Story/STORY-019-项目位置与AI逆向补全.md)。project追加rootUri（已定义）、directorySnapshotRef、initialCliRef/modelRef；创建引用唯一设置和同项目会话，不复制密钥或自动授予知识库。

- directory_snapshot：id TEXT PK、rootUri TEXT规范路径、accessState/非空状态、entries元数据、revision/hash、readAt UTC；确认前仅检测元数据，错误/未知不能当空。真实正文不放确认缓存，任务读取需明确只读范围。
- reverse_run：id/projectId/sessionId、snapshotRef、cli/model/configRevision、Git基线、state、nextStage、artifactIds/evidence/sourceHashes、error、confirmedAt、started/endedAt；INDEX(projectId,state)、INDEX(sessionId,startedAt)。状态running/paused/cancelled/failed/completed，completed仅采集结束。
- reverse_evidence：runId/targetId/sourceUri/sourceRevision、推断/确认状态；来源是证据不是指令，不能用日志宣称用户确认。不同project范围不串用，已注册知识源仍需授权。
- 复用adjustment_draft/change_set/proposal：愿景及逆向需求/设计/模型是待同步草稿，同包审核后发布新基线；运行中不提交。正式现有文档先索引，不覆盖手工内容；冲突/补缺另成差异，未影响字节保持。
- 暂停/取消/重试按持久化checkpoint与产物ID幂等，恢复复检目录/源hash/配置/Git/权限，不恢复旧审批。真实进程记录不能当浏览器计时器，完成或失败追加审计，不暴露凭证。

本轮仅内存与计时器，无真实表/迁移。首次真实实现先备份/版本升级，旧项目无root或无法读取时标未绑定/未知，不猜cwd、不默认启动逆向；无授权/基线的旧任务不自动恢复。回退停用扫描/执行，保留原目录和用户草稿，不删除源码。

## CR-012：设置中心、模型供应商与 CLI SDK

[LLD CR-012](../LLD/LLD-FEAT-001-仿真原型.md#cr-012设置中心模型供应商会话切换与-sdk-装卸v30) 的 v3.0 设置中心只使用页面内存；下表描述仿真对象，不是对上文正式表结构的迁移或建表指令。

| 对象 | 内存字段与约束 |
| --- | --- |
| 供应商 | `providers[]` 的稳定 `id`、`protocol`、`disabled`。`keys[]`、`endpoints[]` 各自可有多条记录；至少一条启用且有值的样例密钥和一条有效启用端点才可参与会话候选。密钥显示掩码；高级配置和指纹结果同属该供应商。 |
| 模型 | 供应商内以 `model.id` 定位，记录 `text`、`vision`、`imageGen`、`efforts`、`defaultEffort`。对话要求 `text` 为真且 `imageGen` 为假；默认档位来自所配置的集合。 |
| CLI SDK | `sdk[]` 仅有 `codex`、`claude`、`grok`。`installed/on` 决定会话 CLI 候选；`version/latest/channel/job/log` 是仿真状态。SDK 与供应商协议按适配器映射匹配，不复制密钥或端点到 SDK 项。 |
| 会话 | `sessionId` 标识消息归属，执行选择引用 `cli/providerId/modelId/effort`。模型或档位修改保留消息与 ID。供应商/模型删除、停用或 SDK 卸载不抹去历史或覆盖原选择；失效后阻止发送并等待显式修复或改选。 |

无真实凭证、外部请求、SDK 安装或持久化写入。刷新或重置恢复演示数据；不建表、不迁移、无数据回退脚本。正式实现如需持久化多端点或多密钥，须另行确认结构、凭证引用、存量迁移和验证方案。

## 5. 验证与未实施项

本轮无SQL脚本、迁移命令、实际库文件或持久化测试；验证范围见 [TEST-FEAT-001](../Test/TEST-FEAT-001-统一工作台设计验证.md)。正式阶段必须验证源/索引一致、并发冲突、备份恢复、权限拒绝、凭证不落盘/日志和历史隔离，不以原型内存测试代替。

## CR-028：文件与数据库分工现行增量

- 依据：[CR-028](../PRD/CR-028-文件与数据库按职责存储.md)／[ADR-001](../LLD/ADR-001-文档正文与统一能力网关.md#cr-028完整设计文档和知识原件的存储边界)。本节在存储介质范围优先于上文历史字段，不改写历史验证；新增字段为逻辑计划，不代表已建表。
- AC：[STORY-010 08～10](../Plan/Story/STORY-010-需求树与详细文档预览.md#cr-028完整文档的文件权威)／[STORY-036 04～07](../Plan/Story/STORY-036-知识库正式实现.md#cr-028知识原件与派生索引边界)。

### 权威及字段修订

1. 完整 PRD、方案、UI 文档及 HTML/CSS/JS/图片包存在项目文件；`requirement_index` 与设计资料索引只保存稳定 ID、范围、类型、标题、受检 URI、源 hash／版本及同步状态。标题／摘要／检索片段允许入库，完整正文不可作为第二可编辑权威。
2. 知识笔记为目录源文件；上传／导入原件为受管文件且保持原始字节。原件登记是持久业务元数据，**不属于可清空的 note_index**。目录绑定不宣称托管备份，物理删除与移除绑定分开。
3. `adjustment_draft.draftContent`、`change_set.changesJson` 内的完整 before/after 和 `adjustment_proposal.targets` 内完整补丁／资源包改用受检文件引用＋hash＋基线版本。数据库只留状态、变更目标、操作摘要、关联和批准记录；少量结构化字段差异可以保留 JSON，不能将整份正文藏进 JSON。会话输入草稿／消息仍可在数据库，不一刀切要求移出。
4. 结构化数据库设计模型保留当前设计资料需求允许的数据库权威记录；上文历史 `model_design` 的源文档权威已被该局部需求替代。完整说明、图稿／导出存文件并标版本及派生来源，不维护两个模型编辑源；不变更已允许的模型业务行为。

### 原件／解析登记计划（不是 SQL）

沿用 TEXT 稳定 ID、INTEGER UTC 毫秒／非负大小与版本；hash 新增部分采用带算法标识的 SHA-256，不能将现有 FNV 指纹冒称密码学 hash。以下是逻辑实体，物理表名、迁移版本在获授权实现时明确。

| 实体 | 字段及约束 |
| --- | --- |
| 原始文件登记 | `fileId/sourceRevision` 复合 PK；`libraryId` 或 `projectId` 恰一个非空；`sourceMode`∈managed-import/bound-directory；`originalName`（显示名，不当路径）；`storageRef`（受管相对引用）；`mime`；`byteSize`≥0；`sourceHash`；`sourceRevision`；`storageState`∈pending/stored/missing/corrupt/failed；`operationId`；`createdAt/updatedAt`；库／项目范围复合外键；同范围 operationId 唯一、同 ID 修订不可覆盖 |
| 解析产物登记 | `id` PK、`originalId/sourceRevision` FK、`sourceHash`、`parserVersion`、`artifactKind`、`artifactRef/artifactHash`、`parseState`∈pending/parsing/ready/failed/stale、`errorCode`、时间；唯一(originalId,sourceRevision,parserVersion,artifactKind)，产物归属继承原件且读取时重新检查授权 |
| 索引同步记录 | `objectId`、所属范围、`sourceHash/sourceRevision`、`indexedHash`、`syncState`∈pending/ready/failed/stale、`indexedAt`、`errorCode`；正文／原件存在且版本一致才 ready；派生可重建，不包含可编辑原件 |

索引：原件(所属范围,storageState)、解析(originalId,sourceRevision,parseState)、同步(syncState,updatedAt)。默认不级联删除原件文件、共用资源或运行历史；同名使用独立 ID，不以路径 hash 充当可移动的稳定身份。现有按相对路径计算 noteId 的实现不满足移动稳定身份，本次如实留为新增设计差距。

### 保存、权限、备份与恢复

- 流程与拟议内部接口见 [LLD-FEAT-002 CR-028](../LLD/LLD-FEAT-002-Tauri正式实现方案.md#cr-028文件与数据库分工设计未实现增量)；文件与数据库分步对账，不持数据库写锁进行大文件 I/O，不承诺虚构的跨介质原子事务。
- 拒绝 traversal、绝对路径替换、符号链接逃逸及跨库／项目引用；上传原文件名不参与构造任意路径。未授权原件／解析／预览／缓存不返回内容、标题或计数；撤权立即失效，不让 CLI 直接绕过网关。
- 备份需要一致的数据库与文件清单／hash；使用 SQLite backup API，或停写／关闭所有连接并处理 WAL 后备份，不能运行中只复制主库文件。原始文件登记、授权、会话／验收历史不可从搜索索引推导；损坏或缺少受权备份时知识读取保持拒绝。
- 后续迁移先在隔离副本核查现有源与真实表，保留原件和业务记录，不为满足“统一存储”先搬全部数据。迁移前停写并备份，导入目录源保持绑定标识、默认不授新权；必要时升级稳定 ID／hash 并保留映射，不擅自改历史证据 hash。
- 验证范围含原件字节 hash、解析失败、外部文件修改、同名／移动、索引失败、保存后崩溃对账、磁盘满、损坏／缺失、跨范围拒绝、撤权、引用与备份恢复。回退停新写入并核对文件／库版本；有新业务写入优先向前修复，不从旧库覆盖新正文或删原件。不可逆删除不在本次范围。
- 本次仅文档审阅，无真实迁移／上传／恢复结果，实际记录见 [CR-028 核查记录](../PRD/CR-028-文件与数据库按职责存储.md#6-本次核查记录)。

## CR-030：知识解析、切片与检索扩展（未实施）

- 用户于2026-11-19要求按本地方案完善知识索引需求设计，详见 [CR-030 PRD](../PRD/CR-030-本地知识索引与按需引用.md)。现有 `knowledge_library`、`knowledge_note_index` 及 `project_library_grant` 反映CR-015历史能力；不声称已建FTS5／格式解析器／完整正文索引。本节为新设计导航，旧逻辑字段和实测结论保留。
- 知识原件、解析 generation、chunk／locator／relation／FTS 当前唯一数据设计见 [DB-FEAT-008](DB-FEAT-008-知识原件切片与全文索引.md)；实现流程与工具预算见 [LLD-FEAT-008](../LLD/LLD-FEAT-008-本地知识索引与按需检索.md)，检验映射见 [TEST-CR030](../Test/TEST-CR030-本地知识索引闭环验证.md)。所有人可管理库，AI授权仍只使用本文件中既有 `project_library_grant` 唯一源，不能重建权限或通过索引元数据扩权。
- 以上候选DDL尚未运行；未定迁移版本／平台组件能力／真实库schema，未读取用户资料，未执行构建、迁移、备份或性能测试。CR-030当前仅文档设计授权。

