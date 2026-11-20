# DB-CR027：设计资料索引与模型记录

- 关联：[CR-027](../PRD/CR-027-Code项目设计资料与按需加载.md)、[LLD-CR027](../LLD/LLD-CR027-设计资料与按需工具契约.md)、STORY-016/018/060。
- 状态：**仅数据库设计，未建表/迁移/读写正式库**。沿用同一应用SQLite及既有project身份/外键/授权；不创建另一数据库，不把数据库模型混入供应商AI`model`表。

## 1. 权威来源与兼容

| 资料 | 权威 | 索引/预览 |
| --- | --- | --- |
| PRD | 项目`docs/PRD/*.md`正文 | SQLite派生索引；编辑走文件CAS |
| 方案 | 项目`docs/LLD/*.md`正文 | SQLite派生索引；不在DB复制可编辑全文 |
| UI | 项目唯一`docs/UI/仿真原型UI.html`与相对资源 | 路径/hash/说明索引，隔离托管 |
| 数据库设计模型 | 同一应用SQLite中的`design_model`及不可变版本 | 一模型一菜单，生成Markdown/字段说明供AI分段读 |

**本次局部变更**：用户允许模型放数据库，故新模型采用DB权威。历史[DB-FEAT-001](DB-FEAT-001-知识授权与工作台数据设计.md)的`model_design`文件权威只保留历史及一次受控导入来源；导入须展示来源/差异、确认后生成新模型记录，原文只读追溯；导出Markdown只是派生，不双向并发编辑。

## 2. 拟议逻辑表（尚无迁移脚本）

### design_asset_index（派生，不是文档正文源）

| 字段 | 含义/类型/约束 |
| --- | --- |
| id | TEXT稳定资源ID，PK；不是文件名 |
| project_id | TEXT NOT NULL，FK既有project.id |
| category | TEXT CHECK prd/ui/solution/model |
| locator | TEXT受管相对路径或模型ID定位，不接受任意绝对路径 |
| source_revision/content_hash | TEXT NOT NULL，源版本与真实SHA-256；文件由宿主计算，模型绑定版本 |
| title/summary | TEXT，非敏感简短元数据，summary≤160字 |
| summary_revision/summary_status | 摘要来源版本及current/pending/stale；源变更不能冒充摘要仍current |
| outline_json/links_json | 受限大纲和Story/AC关联ID，不存整篇正文 |
| index_generation/sync_state/parse_error | 索引代次、synced/pending/conflict、可脱敏解析失败原因 |

唯一键`(project_id,category,locator)`，过滤索引`(project_id,category,index_generation)`；重名ID/越界拒绝，不用INSERT IGNORE隐藏冲突。未授权连索引标题/数量也不返回。构建临时索引→校验→事务切换代次，失败保留上代并标失效。

### design_model（数据库设计模型，不是AI配置model）

| 字段 | 含义/类型/约束 |
| --- | --- |
| id/project_id | TEXT PK / NOT NULL FK project.id |
| current_revision | INTEGER NOT NULL，CAS更新；绑定本模型不可变版本 |
| logical_name | TEXT NOT NULL，规范标识符，同项目UNIQUE |
| lifecycle | TEXT active/archived，归档/删除不直接级联丢历史 |
| created_at/updated_at | UTC时间，展示转本地 |

### design_model_revision

| 字段 | 含义/类型/约束 |
| --- | --- |
| model_id/revision | 复合PK，FK design_model.id；revision正整数 |
| content_hash | TEXT NOT NULL，规范化snapshot_json的SHA-256 |
| title/summary | TEXT，模型名称/用途，随版本维护 |
| snapshot_json | TEXT NOT NULL、JSON有效；表/字段/主外键/唯一/检查/索引/关系/说明/Story/AC关联完整设计快照 |
| sync_state | TEXT pending/synced/conflict；无有效配套差异确认不标synced |
| base_revision/source_ref | 上版/导入来源引用，用于差异与历史，不能包含私密凭证 |
| created_at/actor_ref | UTC及负责主体ID；不是敏感会话正文 |

字段快照包含`name/type/nullable/default/constraints/description`；关系使用稳定模型/字段ID，不仅靠显示名。类型表与业务数据库目标类型明确映射，未知类型拒绝；同项目引用、重复字段、PK/UNIQUE/FK/索引/关联有效性在事务前验证。重命名或删除被引用字段须带完整配套差异，不自动断链。

版本不可变。事务内读取current_revision、核对base_revision、插入新版本、CAS更新模型头和派生索引；冲突回滚并保留GUI草稿。设计记录**不执行SQL、建表或业务迁移**。

## 3. 权限、读取与引用

- 复用项目范围与既有授权；AI只读工具每次查宿主身份/授权修订，locator只是定位不是权限。禁止模型参数任意换projectId/rootUri。
- GUI写权限与AI读权限分开；两只读工具不获得模型/文件写权。未保存本机草稿不自动给AI。
- PRD/方案read返回源MD分段；模型read依据版本快照生成指定字段/关系说明，不再建第二可编辑MD源；UI默认说明，大HTML仅按需范围。
- 引用复用既有ContextRef/执行引用记录设计，扩展对象、源版本/hash、范围、授权修订、同步状态。审计只记ID/范围/结果/字节或已知tokens，未知NULL；不默认再存全文。

## 4. 迁移与恢复（计划，未执行）

1. 在非生产副本备份现有SQLite/文件，建新表且不改供应商model、旧需求/会话、授权或运行表；应用扩展须有schemaVersion兼容门槛。
2. 旧模型如有源文档，先解析为待确认预览；重复ID、非法FK/类型或无法识别时拒绝自动导入，不覆盖用户源稿。确认后导入一个稳定模型并登记历史来源/hash。
3. 文件/DB不是真跨介质事务：文件CAS保存成功而索引失败显示pending，用受管日志/outbox向前重建；不能恢复旧索引后冒充新文件已同步。
4. 回退不删除用户新模型：保持新表数据备份并关闭不兼容入口；如需回滚结构必须单独迁移方案与授权。模型归档保留不可变版本和运行引用，引用中的旧修订不能由当前源覆写。
5. 验证重复模型/字段、跨项目FK、断链重命名、CAS冲突、回滚、损坏索引重建、撤权、UTF-8分段、旧版兼容；本次未执行真实SQLite验证。

## 5. 本次原型边界

合成预约、用户、时段三模型在同一aux快照中，仅验证一模型一菜单、字段/表名编辑、重名/基本FK与UNIQUE校验、失败完整草稿恢复和待同步提示。不是完整ER编辑器/类型推导/迁移器，不证明正式DB约束或跨介质事务已实现；实测范围见[REPORT-019](../Test/REPORT-019-设计资料四入口与按需加载验证.md)。
