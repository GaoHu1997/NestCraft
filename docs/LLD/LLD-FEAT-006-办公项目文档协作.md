# LLD-FEAT-006：办公项目文档协作方案

- 关联：[CR-038](../PRD/CR-038-办公类型项目文档协作.md)／[FEAT-006](../Plan/Feature/FEAT-006-办公资料解读与产物预览.md)／STORY-065～067。
- 工作层级：需求／交互设计及仿真验证。以下正式契约为拟议方案，不是已经实现的接口；本轮不安装编辑引擎、不调用真实CLI、不改软件。
- UI唯一基准：[UI-CR038-v1](../UI/文档/UI-CR038-办公项目文档协作.md)；[数据模型](../DB/DB-FEAT-006-办公文件与提案版本.md)；[测试](../Test/TEST-CR038-办公项目设计验证.md)。

## 1. 当前事实与复用边界

- 正式 [ProjectHome.tsx:73](../../src/modules/projects/ProjectHome.tsx#L73) 已按kind决定入口；新建也在 [89–93](../../src/modules/projects/ProjectHome.tsx#L89-L93) 区分code/work。这只证明类型入口存在，不证明文档编辑能力完成。
- CR-038调整前，原型通用projectPage未区分work导航，officeTab仅渲染MD；新增work条件分支承接原需求，不重构code、服务器、知识或设置。
- 原型在 `workbench-v4/` 添加专属办公模型、渲染与局部样式；固定公开入口不动。新增条件以当前窗口refId找project.kind，不依赖残留全局projectTab判断类型；work未知／旧页签统一回文档。
- CR-038曾用办公专属简化侧栏；[CR-043](../PRD/CR-043-办公文件树与统一AI侧栏.md)明确替代为与code共用AIPanel渲染器、完整控件和样式。办公只提供作用域数据与工具结果，不复制aside/composer/history。消息、输入、候选按项目＋会话保存，异步回调绑定scope/session/generation；共享模型和能力库存不等于共享私有资料。
- CR-043文件树采用Folder(id,projectId,parentId,name)和File.folderId，null父节点代表项目根。同父内文件与目录共用名称空间、归一化大小写冲突拒绝；跨目录同名允许，fileId及版本仍稳定。搜索是树的投影，不修改目录；折叠状态按项目保存，清空搜索恢复。原型只内存创建，不执行真实mkdir。
- [UI-CR040](../UI/文档/UI-CR043-办公文件树与统一侧栏.md)为本批覆盖基准，其余CR-038规则继承；[验证](../Test/REPORT-CR043-办公文件树与统一侧栏.md)登记共用侧栏同条件对照和既有功能回归。

## 2. 正式能力分层（待实施）

`项目范围 → 文件身份与版本 → 格式能力适配 → 手工编辑／AI候选 → 审阅 → 安全保存 → 成果／导出`。

- 每种格式声明 `canRead/canEdit/canWrite/canRender/canExport`、支持的对象／公式／格式、引擎版本、已测兼容性。预览、解析、编辑、写回、导出五者不得混同。
- 手工与AI使用同一对象变更模型，AI没有绕开文件权限与版本检查的“直接写原件”入口。
- 能力缺失返回结构化限制（例如 unsupported_formula、scanned_no_ocr、encrypted、export_unavailable），UI显示恢复路径；不得偷偷变换文件格式。
- 底层引擎／CLI／SDK暂不选定。完整可视编辑和AI工具调用是两层能力，后端可读写不等于前端已可编辑；开源核心、商业扩展、分发和网络服务条款须按确切版本逐项评估。
- 先完成MD和基本对象操作闭环，再用固定兼容样本验证DOCX/XLSX/PPTX/PDF。不能为了有多格式入口而省略原格式往返与独立查看器测试。

## 3. 文件、草稿与保存事务

### 3.1 文件权威

原件／草稿快照／接受版本是文件；SQLite保存身份、修订、来源、状态与受检引用。不同项目就算同名也使用不同FileRef。原件为只读基线，手动编辑默认创建副本。成果只是已保存文件版本的投影，不另维护可编辑正文。

文档编辑器缓冲以 `(projectId, fileId, baseRevision)` 为键；打开多文件与切窗口不得用单一全局draft覆盖。关闭带脏缓冲须逐项选择，保存失败时不能先关闭。恢复历史版本创建新draft，不回滚历史编号。

### 3.2 拟议保存请求

更新成果输入：可信会话projectId、fileId、baseRevision、expectedContentHash、draftRef、idempotencyKey。输出：成功新revision/hash 或 `stale/read_only/permission_denied/disk_full/format_invalid` 等可恢复错误。

首次创建成果另用create契约：projectId、candidateId、draftRef、targetRelativePath／displayName、sourceRefs、idempotencyKey，baseRevision/hash均为空，不用虚构既有fileId。事务中原子拒绝目标同名，成功分配fileId和revision=1；原件的编辑副本走相同路径。候选与草稿在提交前仅有临时身份，失败仍可改名重试且不占成果记录；重投同一幂等键返回同一成果。

执行顺序：复验范围与真实路径（防目录穿越／符号链接越界）→ 确认基线一致与独占提交权 → 写同目录临时文件 → 格式校验 → 比较基线并原子替换／新增目标 → 写入版本记录与审计。文件和DB不跨资源假装单事务，用写入意图和恢复对账解决“文件已提交／索引未更新”；必要时返回待对账而非再覆盖原件。相同幂等键与内容只产生一次新版本，无变化保存不增版本。

## 4. AI请求与资料边界

请求冻结：projectId、sessionId、requestId、generation、sourceRefs（fileId/revision/hash/locator）、目标类型／用途／标题／受众、选区、允许动作、模型与网络说明。发起时和读取时都复检权限；来源快照清楚显示，取消勾选不继续使用旧来源。

- 知识检索沿用现行授权网关，只读；不能借文件选择器或历史会话绕过授权。
- 源文出现命令只作为资料，不能自动转换成工具指令。
- 远程模型仅发送已确认的必要片段，记录发送范围。撤权后旧来源候选失效，历史已送信息无法声称撤回。
- 模型不可用不影响本地编辑；不暗换模型／CLI或付费模式。CR-043明确创建work项目只校验位置与项目权限，不调用AI配置准入；既有配置可引用但不是必填。用户主动AI请求时再走现有统一配置、能力和发送范围校验，失败不阻断本地创建／阅读／手工编辑。
- 状态：prepared → reading → generating → checking → review；另有failed／cancelled。停下后旧generation的回调丢弃；重试保留输入并创建新代次，旧记录可查。运行完成不意味着文件已保存或已验收。
- 这套office请求是已有会话受管调用的业务投影，不新增通用runner、研发Task树或独立审批权威。

## 5. 修改提案与冲突

每个提案绑定目标baseRevision及来源快照，内容为一组有稳定ID的对象变更（段落／单元格／幻灯片对象）。初始全部pending，用户逐项accept/reject。接受只修改缓冲，不写原件；拒绝不产生变化。全部拒绝时关闭候选不生成成果。

应用前同时检测已保存版本与当前编辑缓冲代次。提案保留冻结baseEditGeneration，并另维护expectedEditGeneration：本提案成功应用一项时原子推进其预期代次，使下一项可继续接受；重复接受同一项返回原决定不重复应用。人工输入／撤销／其它提案改变缓冲时仍触发冲突，不能无条件跟随当前代次。冲突时不得仅因磁盘版本没变而覆盖人工新编辑。重新比较或生成新提案后，旧accepted决定不得自动迁移到新内容；保留两份需新文件名并拒绝同名覆盖。保存前不能混入仍pending的变更。

引用定位：Markdown用标题路径/段落锚，DOCX用对象ID/段序（没有真实页码不造页码），XLSX用sheetId与range，PPTX用slideId/objectId，PDF用page；文件更新使位置不可用时明确“来源已变化”，不跳到另一处冒充原证据。

## 6. 成果检查与导出

只对指定不可变的保存版本revision/hash检查来源有效性、目标格式能力、缺字体／溢出版面／公式错误、目标权限与空间。若用户明确选择已有保存版本，当前draft的dirty或pending不阻断旧版本导出，但必须显示“不含当前未保存／待处理修改”；默认导出当前编辑意图时，先要求处理pending并保存，不隐式选择旧版本。同名默认建议新名，不默认覆盖。导出先临时文件、格式有效性与打开验证，再提交导出记录。失败保留已保存成果及参数，部分文件成功时逐一列明。

原型没有实际Office引擎：导出检查可模拟通过／失败，但原生下载禁用且给明确原因。不能将HTML/MD改后缀作为Office文件。未来正式成功必须附真实文件hash和校验结果，界面“生成完毕”不算交付。

## 6bis. 第一批正式实现边界（2026-11-20，编码授权批）

用户明确授权后，本批落地的实现契约（后续批次在其上扩展，不推翻）：

- **存储分层**：文件树/文件/草稿/样例在前端内存模型（`src/modules/office/office-model.ts`，按 projectId 隔离，变更经 `officeNotify` 广播）；`project` 表只承载项目记录。内存数据重启即失，界面以「仿真样例」常驻标注，不提供会被理解为跨进程持久的保存语义（评审 C 条件）。预置两个演示项目经一次性设置位（`office.demo.seeded`）seed；rootUri 容器目录由 `app_data_ensure_dir` 创建（app_data 内、拒绝 traversal）。
- **引用注入契约**：办公文件引用以 `kind="file"`、`objectId="office:<fileId>"`、`content=<发送时快照>`（≤12000 字）传递；后端 `build_prompt` 对携带 content 的引用注入 `<office-source path="display">正文</office-source>`，无 content 时维持 `<file-ref>` 行为。发送时冻结快照，符合 §4 请求冻结要求。
- **步骤数据源契约**：步骤=本会话真实 toolUse/toolResult 事件（`sessionRuntime.recordToolUse/recordToolResult`），会话载入时从持久化工具消息 `rebuildStepsFromPairs` 重建；无工具调用不显示步骤框；「推进演示」仅 demo 会话（显式 seed，评审 C 条件：不静默注入用户会话）；真实失败步骤显示"失败"＋错误摘要，不虚构退出码（评审 A 条件）。
- **定位总线**：`src/modules/locate.ts` 统一分发 file/requirement/knowledge/office-file 定位；file 定位在编码区打开文件并滚动高亮目标行（一次性标记，文档再编辑即清除）；office-file 定位选中树节点。
- **能力判定**：模型"支持思考" ⇔ efforts 存在有效下发拼写（非 null）档位（评审 C 修正口径），不新增 schema 字段。
- **后续仍待授权**：work_file/proposal 持久化表、Office 原生格式解析与写回、AI 提案/逐项审阅/保存事务、导出检查（§3/§5/§6 仍为拟议方案，本批未实现，界面不做伪成功）。

## 7. 本批设计验证与未来实施

- 本批：纯内存状态机 + 离线浏览器，明确DEMO，不读取真实文件；Chrome独立临时profile，不重建正式应用；覆盖入口／类型隔离、编辑与保存、审阅与拒绝、冲突、停止/重试、成果和导出。
- 状态样例单独显式选择，不自动重置用户已有草稿，全部新样例为合成业务情景。
- 正式实施顺序（未授权）：能力试验与许可 → 文件版本/路径隔离 → 手工编辑/保存 → AI候选和审阅 → 原生导出与兼容测试。每阶段按已确认UI版本对照，不以一轮构建通过代替。
- 恢复：原型只回退本批资源至快照，不删除用户文件；正式持久化先备份项目与DB，具体迁移脚本须另行设计与授权。
- 开放项：具体引擎、最大文件/对象规模、性能阈值、完整Office格式保真、签名发行及包体均待试验，不在本批做采购或可用性承诺。
