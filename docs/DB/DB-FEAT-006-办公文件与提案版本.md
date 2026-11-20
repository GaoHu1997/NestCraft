# DB-FEAT-006：办公文件与提案版本（设计，未迁移）

- 关联：[CR-038](../PRD/CR-038-办公类型项目文档协作.md)／[LLD-FEAT-006](../LLD/LLD-FEAT-006-办公项目文档协作.md)／STORY-065～067。
- 继承 CR-028：原件与完整正文存文件，数据库只管结构化身份／修订／状态／索引。原型用内存对应结构，**没有写真实数据库或原件**。

## CR-043 增量（设计，未建表）

- 目录记录：OfficeFolder(id, projectId, parentId, name, normalizedName)，parentId为空代表根；父子必须同项目，无悬空或循环。OfficeFile增folderId，文件/文件夹同父目录共同校验normalizedName唯一。跨目录同名合法，引用依然用fileId而非文件名。
- 不新增真实执行/配置权威。原型文件树与文件草稿按项目保存；公共AI上下文按(projectId,sessionId)保存messages/input/queue/run/proposal/history/generation，文件和草稿不随会话切换被覆盖。迟到事件验证scope/session/generation后才处理。
- 只新增明确的仿真夹具，原历史内容放历史目录保留；新项目不自动加载。真实目录、路径规范、符号链接与权限必须在正式实现中复验，本轮不迁移。

## 1. 记录与约束

| 实体 | 关键字段（拟议） | 约束 |
| --- | --- | --- |
| OfficeFile | id, projectId, relativePath, displayName, format, role(source/draft/result), capabilities, currentRevision | projectId必须为work；路径归一化、同项目同目录名称唯一；来源只读；不新增office项目枚举替换work |
| OfficeRevision | fileId, revision, contentHash, byteSize, fileRef, actor, savedAt, sourceRevision | 唯一(fileId,revision)，revision单调；不可变快照，不以DB存第二份完整可编辑正文 |
| OfficeDraft | fileId, baseRevision, baseHash, editGeneration, draftRef, dirty, saveState | 同窗口／文件独立缓冲；保存失败保留；跨窗口提交须CAS |
| SourceRef | ownerRequestId, projectId, fileId, revision, hash, locator, accessDecisionRef | locator是格式化对象，不信任任意绝对路径；授权实时复检，引用不是授权 |
| OfficeRequest | id, projectId, sessionId, generation, action, parameters, sourceSnapshotRef, state, cancelAt, error | 复用会话/受管运行身份，不新增runner；迟到结果须当前generation与state匹配 |
| OfficeProposal | id, requestId, targetFileId或候选ID, baseRevision, baseEditGeneration, expectedEditGeneration, changesRef, state | 变化存候选文件/差异资源；不自建真实目标文件直到接受保存 |
| ProposalDecision | proposalId, changeId, proposalRevision, decision, actor, decidedAt | 唯一(proposalId,changeId,proposalRevision)；新差异版本不得继承旧审批 |
| OfficeExport | id, fileId, revision, targetFormat, targetFileRef, checkState, exportState, error, exportedHash | 检查通过≠导出成功，未产真实文件不得成功；失败不可改源成果 |

索引：项目内文件名称／最近保存时间、fileId版本、项目会话未结束请求、pending提案。全文检索复用既有切片索引能力，权限仍以原系统为准；成果页按role及已提交revision查询，不持有可编辑正文副本。

## 2. 一致性与异常

- 新候选／原件副本首次保存使用空基线create契约，原子拒绝同名后分配fileId/revision=1；失败不新增成果。已保存文件才走带baseRevision/hash的更新契约。
- 同一提案逐项接受推进expectedEditGeneration而不改冻结baseEditGeneration；重复项返回既有决定，不重复应用。非本提案编辑仍触发冲突。
- 导出若明确选择旧保存版本则绑定该revision/hash，只警告不含draft/pending；不能把新草稿未处理项一律作为旧版导出的失败项。
- 保存包含文件写入意图、临时文件和DB提交记录；崩溃恢复时先对账hash和意图，不重复晋升版本或覆盖更新文件。
- 新生成提案是候选，不增加正式成果计数；全拒绝／取消／失败不晋升。接受进入draft；保存提交后才进入成果视图。
- 人改缓冲也增加editGeneration，解决“磁盘revision不变但编辑已变”的竞争。撤销/恢复同样改变代次。
- 重试生成新generation，保留原失败记录。相同幂等键拒绝重复执行或返回既有结果。
- 文档移出授权目录、来源撤权、解析失败、locator失效均返回显式状态；不得恢复旧权限。
- 历史恢复写新draft/新revision；不更新旧revision内容。项目删除行为继承现有只移除管理记录语义，原件清理不在本批。

## 3. 迁移与验证边界

本轮不执行DDL、不建真实表、不迁移旧文件。后续编码前对现有SQLite表名、会话结构、迁移序号做真实核验；先备份再增量迁移，恢复测试验证旧数据可读。新增字段向后兼容及磁盘空间策略由实施阶段试验确定。

设计演示验证：同名跨项目可区分、旧基线拒写、取消迟到隔离、重复保存不增版、全拒绝不生成成果、导出失败保原件。真实锁、原子替换、目录越界、空间不足及崩溃对账均未执行，见 [测试计划](../Test/TEST-CR038-办公项目设计验证.md)。
