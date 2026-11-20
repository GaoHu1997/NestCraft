# LLD-CR032：双向变更与高保真逆向

- 关联：[CR-032](../PRD/CR-032-需求设计与代码双向变更及高保真逆向.md)、[STORY-017](../Plan/Story/STORY-017-需求实体手动维护与提交调整.md#cr-032需求差异驱动代码变更)、[STORY-018](../Plan/Story/STORY-018-设计模型与需求一致调整.md#cr-032设计变更驱动代码与增量回填)、[STORY-019](../Plan/Story/STORY-019-项目位置与AI逆向补全.md#cr-032删除文档后的高保真恢复)。
- 用户确认：2026-11-19 18:26（Asia/Shanghai），逆向只有产品源码，没有其他资料；目标是层级／规则／AC／设计语义接近，不要求原文措辞。此前三模式建议撤下；不留语义包或归档、不把原文／ID映射隐藏于源码。
- 状态：设计方案，未实现／未运行逆向实验；量化阈值待试测后确认，正式编码另需授权。

## 1. 当前事实与复用

[projects.rs:100–156](../../src-tauri/src/commands/projects.rs#L100-L156)只是已有MD需求索引；[projects.rs:238–250](../../src-tauri/src/commands/projects.rs#L238-L250)只有无共同基线的单文档读写；[Workspace.tsx:407–453](../../src/modules/projects/Workspace.tsx#L407-L453)是UI／DB阅读，不是双向变更或源码重建。现有简易hash不作为正式证据hash，tmp/rename不作为跨介质事务。

复用项目／文件服务、差异提案、模型版本、受管任务执行、[CR-027按需资料](LLD-CR027-设计资料与按需工具契约.md)、[CR-031执行恢复](LLD-CR031-受管执行可靠性契约.md)。不建第二runner／需求树／授权源，已有设计足以确定方向，不引入无关框架。多语言解析器选择在明确目标项目栈后决定，不预先声称支持全部语言／反射／生成代码。

## 2. 共同基线和三种上下文职责

- 业务权威是PRD、Story／AC、LLD／UI／DB设计；代码是实现事实。正常增量对账可持有文档hash／模型revision、代码manifest和审批引用，但这些记录不决定业务授权。
- 正常文档→代码可以读取已确认文档并指导编码；正常代码→文档可用现有稿做冲突保护，**事实抽取仍只从产品源码取证**。
- 删除文档后的重建是独立执行模式：生成身份不能读取任何旧基线、索引、映射、文档或正向会话。常规同步记录存在不意味着该模式可以读它们。

拟议结构：
```ts
type SyncBaseline = {
  id: string; projectId: string;
  branchRef: string | null; headCommit: string | null;
  codeManifestHash: string;
  sourceRefs: Array<{id: string; revision: string; hash: string}>;
  reconciledBatchId: string; coverage: 'complete-in-scope'|'partial'|'unknown';
};
type ReverseSourcePolicy = {
  inputKind: 'product-source-only'; manifestHash: string;
  forbidden: Array<'test'|'standalone-schema'|'document'|'config'|'database'|
    'archive'|'semantic-package'|'history'|'cache'|'evaluation-baseline'>;
  priorContextAllowed: false; networkEnrichmentAllowed: false;
};
```

manifest包含受管dirty源码，不能只绑HEAD。稳定ID用于常规差异与输出追踪，不能为纯源码恢复提前埋入特殊标记。行号是快照证据；多对多业务／符号关系仅从当前输入推导，目录不直接充当Epic。

## 3. 文档驱动代码的增量流程

1. GUI／外部受管源变更按hash去重，净零／无语义排版变更无代码任务；文件缺失不同于取消实体，墓碑不自动复活。
2. 解析真实before／after，读取必要PRD／AC／设计，列矛盾与含糊分解；映射未知不冒充无影响。
3. 模型导出MD变化先三方导入评审，确认后新模型版本仍唯一权威，不执行SQL、不覆盖用户文件。
4. 提案列必要可写目标、原新片段、影响和测试／迁移计划；阅读依赖不扩大写白名单。
5. 需求设计确认且本批document/model目标完整应用并对账后，复用既有RequirementSnapshot冻结 `confirmedDocumentSnapshotRef`（资源ID／revision／hash及真实确认引用）；它不是新的共同SyncBaseline。派发绑定本批syncBatchId、新文档快照与旧代码manifest，校验无未确认／冲突／部分落盘文档、有效编码授权和UI／DB准入；仅“代码待对账”不能挡住该批代码工作，也不能放行验收。后续文档漂移使快照失效，必须重检。这里测试属于实现验证，不是逆向输入。
6. 实现验证后只从新源码提取事实反向核对，文档局部补正仍待确认，全部对账后发布新基线，不自动验收／生产发布。

## 4. 纯源码高精度管线

### 4.1 输入防偷渡

生成端只收冻结manifest列出的实际产品程序源码。允许源码中真实使用的类型／实体／校验／权限／查询／DDL结构；不复制测试、独立schema、迁移资料、配置、文档、包、数据库或Git历史。缺依赖源码／配置／外部服务事实标未知，不联网补知识或读取本机旧缓存。

源码识别按职责／语义，不按扩展名或目录名放行：测试搬到src、JSON改成代码常量、原文塞注释或字符串都不能成为恢复辅助输入。原有注释只作待核对线索，行为证据优先；正向禁止为提升分数特殊嵌入原文、稳定ID映射或追踪payload。

### 4.2 确定性事实抽取

- AST／符号：模块、类型、字段、函数、接口／事件、路由和依赖引用。
- 行为：校验、权限判断、条件／分支、状态转换、错误／边界、主要调用和持久化操作。
- 数据：源码声明的结构／类型／关系与实际校验／存储约束。不能从ORM猜独立数据库default／索引／CHECK，不能把未执行的定义当线上事实。
- 覆盖：反射／动态配置、生成代码、缺库、解析失败、跨服务未知逐项标partial，不用静态图伪装运行全覆盖。

事实节点保存结构值、源码路径／符号／快照hash、证据区间和observed／inferred／unknown／conflicting标签；关系保留calls／reads／writes／validates／authorizes／transitions。模型自评置信度不能代替可复核证据。

### 4.3 从事实到业务层级

1. 以入口、角色判断、业务对象与端到端调用链归纳业务能力，禁止一目录一Epic。无法证明角色名称／动机时标候选，不补造业务背景。
2. 从行为图生成可观察Story和候选AC，覆盖主流程、分支、边界、异常、禁止性规则；这些是重建验收规格，不是历史已验证结果。
3. 以用户成果而非技术目录聚合Feature／Epic，并对多种可能分组列不确定性。自生成树合法不等于与原树接近，必须独立评分。
4. 同一事实图渲染PRD业务规格、LLD实现机制和DB结构，做跨文档字段／规则／引用一致性与证据完整性验证；不分别自由生成互相矛盾的材料。
5. 语义生成拆有界业务片段、逐段复查证据和漏项，最后跨域合并。未知不能为了“完整”被合理猜测填满。

### 4.4 增量与不可逆边界

正常增量比两次源码事实图，纯重构只补LLD／定位，行为变化才产生PRD／AC候选；三方合并保护人工稿，缺陷／未授权能力不自动升级需求，代码删除不自动取消业务。纯源码重建没有旧文档／ID／映射，不能装作精确恢复原号；输出内一致ID可以生成，但不是原ID。

原始业务动机、非目标、未实现需求和历史取舍未编码时不能保证恢复。即使合理归纳出另一棵树，也必须如实报告原层级相似度和全原资料覆盖，不用“代码无法证明”掩盖总体漏项。当前源码有缺陷时只能给现状／差异，不推造过去授权或验收。

## 5. 写回、崩溃与防回环

prepared → applied_pending_reconcile → reconciled，另有rejected／conflict／failed／cancelled。先核全部hash／模型revision／项目／权限／分支，冲突整包拒绝；跨介质写入用journal／outbox逐项记baseHash／newHash／暂存引用和状态，不能宣称ACID。

中断对账：目标等于newHash可认本批已应用，等于baseHash可安全重试，第三方hash立即冲突，不能回滚覆盖人工新稿。全部目标就绪才发布一致基线，直接文件观察者可能见阶段变化，必须标pending。索引失败从现行源重建，不倒灌旧正文。

batchId＋causationId＋内容hash／消费manifest去重，同因果同内容事件免重复；人工新变化仍生成新事件。取消、撤权、旧回调不推进新基线，无关字节／验收历史不动。独立源码重建的输入策略禁止读历史journal，即使正常同步曾保留它。

## 6. 实施分包（均未执行）

| 包 | 产物 | 依赖／放行 |
| --- | --- | --- |
| WP-01 | 纯产品源码策略、manifest、隔离读取、支持栈与事实图 | 不含测试／独立schema／资料；未知覆盖与读入审计 |
| WP-02 | 文档真实diff、必要实现与测试影响、独立授权准入 | WP-01；需求设计一致性，模型单权威 |
| WP-03 | 源码→Story／AC→Feature／Epic→PRD／LLD／DB与增量提案 | WP-01；事实溯源、人工稿／有效UI保护 |
| WP-04 | CAS／journal、失败对账和回环控制 | WP-02/03；第三方修改／崩溃／幂等测试 |
| WP-05 | 纯源码无泄漏往返评测及分层结果 | 评价原文独立持有、生成端无历史；先试测后定阈值 |

[DB](../DB/DB-CR032-同步基线与语义追踪.md)／[测试](../Test/TEST-CR032-双向变更与逆向保真验证.md)／[UI缺口](../UI/文档/UI-CR032-双向变更与还原场景覆盖.md)。新增UI缺可视版本先补稿，正式编码另需授权。没有模型实测数据，不承诺任意系统95%精度；纯源码目标已确认，阈值需独立试测再定，不默认引入额外输入以达标。

变更记录：2026-11-19 CR-032；18:26收紧为用户确认的纯产品源码与语义／结构目标，撤下辅助恢复包，不改变CR-027/028权威和CR-031授权。
