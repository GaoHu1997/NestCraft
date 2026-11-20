# UI-CR030-v1：知识本地索引、来源定位与按需引用

- 关联：CR-030；关联既有 STORY-036（库与解析/索引）、STORY-009（项目授权与 AI 检索）、STORY-014（库内三栏阅读）。正式 AC 由主代理负责需求文档。
- 状态：新设计待评审，未获软件编码授权。唯一当前可操作入口仍是 [仿真原型UI](../仿真原型UI.html)，挂接于现有知识库管理/阅读与 AI 侧栏，不新增导航入口或第二状态源。
- 实现资源：[knowledge-local-model.js](../task-workbench/knowledge-local-model.js)（确定性夹具模型）、[knowledge-local-design.js](../task-workbench/knowledge-local-design.js)（管理/阅读与钩子）、[knowledge-local-design.css](../task-workbench/knowledge-local-design.css)。最小挂接：[index.html](../task-workbench/index.html)、[app.js](../task-workbench/app.js)、[stock-design.js](../task-workbench/stock-design.js)、[ai-sidebar.js](../task-workbench/ai-sidebar.js)。版本标记 UI-CR030-v1；最终 SHA-256 在主代理集成前复核。
- 确认边界：只授权设计与设计资源调整，未授权正式软件源码、依赖、运行配置、构建或真实资料/模型/外网处理。UI点击、测试和截图仅针对本地合成夹具，不构成用户验收或软件视觉一致性证据。

## 1. 普通路径与状态权威

知识管理仍走 `knowledge` 普通路由，单库阅读仍走 `knowledge-lib` 详情；CR-021 局部返回、库内三栏左目录/搜索、中正文、右标题目录保持。旧库和 `aux.notes` 不被迁移或覆盖；其旧Markdown阅读保留原行为。仅用户在新建对话框明确添加的新库才有 `knowledgeLocal` 合成多格式投影。新库、旧笔记、文件夹、会话、授权和草稿共用现有 `aux` 与唯一 `WorkbenchStockDesign.getExecutionCatalog()` grant；不建立第二套授权库存。

知识本地设计模块接收现有 `aux/ui/saveAux/render/toast`，并只要求两个窄导航回调 `openLibrary(id)` 与 `openProject(id)`。AI侧栏通过 `candidates(projectId, sessionKey, query)`、`pickRef(projectId, refId)`、`preflight(projectId, sessionId, refs)` 使用同一个 model；调用缺失/过期时 fail-closed，不回到全库 aux notes 候选。检索结果只用固定字符串匹配，不声称 SQLite FTS5 已实现或已被实际调用。

管理卡清楚分开：`bound-directory` 是用户目录绑定、原件仍由用户保管，不是托管备份；`managed-import` 演示“原件保存”与“解析”两个状态。后者只选择固定夹具集，不弹系统文件选择器、不收文件、不写原件。新库默认无任何项目授权。授权 UI 复用已有 `grant-open` 流程与 grantRevision；读取当前 grant 始终来自同一目录。

## 2. 文件格式、定位与明示能力边界

| 格式/对象 | 演示夹具状态 | 正文与定位边界 |
|---|---|---|
| md、txt、csv、docx、pptx、xlsx、xls、xlsb、ods | 固定文字/metadata定位夹具 | 设计意向为确定性文本抽取；Excel使用缓存值、不重算公式；不声称表格版式保真 |
| PDF文本层 | 固定文本夹具 | “仿真第2页”仅演示定位字段，不是PDF页识别结果 |
| XMind、FreeMind `.mm`、OPML | 固定文本与显式关系字段 | 关系仅示范显式节点父子/链接，不自动做语义实体抽取或知识图谱推断 |
| 图片、扫描版PDF | `metadata_only` | 只可按文件名元数据查找；无正文读取，拒绝OCR/视觉模型/大模型 |
| 旧 `.doc` | `unsupported` | 显示不支持，不伪称可解析，也不替换/删除原件 |

浏览器、JS只运行本地内存中的固定字符串/模拟状态；无网络、CLI、真实文件读取、数据库或解析进程。DEMO-FNV 指纹只是generation一致性夹具，非密码学hash、可信来源签名或授权证明。

## 3. 管理页处理状态机与发布

新库状态从 `pending` 经“增量索引”到 `queued → parsing → ready/partial/error`；用户可以实际推进、取消，并切换“成功/部分失败/发布失败”夹具。managed-import 在 `storage=pending, parse=pending` 时禁止检索；点击保存夹具仅改成 `stored`，解析仍待处理；保存失败与解析失败分开展示。目录绑定明确说明外源所有者责任。

新尝试使用持久于库夹具的单调nextGeneration递增，取消／失败后不复用编号；已发布generation不因开始索引提前推进，staging只在当前job版本与源hash一致时发布。未变化文件保留自己的publishedGeneration，失败／取消不能使旧回调冒充新attempt。该逻辑只证明内存演示，真实文件、SQLite事务及worker fencing未执行。

可逐文件改变状态：`ready`源变更为`stale`、原件`missing/corrupt`、解析`failed/unknown`。源hash/revision变化后旧chunk立即不可选；错误或无权不显示上一正文。增量索引只发布与输入版本匹配的generation。支持摘要统计包括ready、metadata_only、unsupported、failed、stale、missing、corrupt、unknown。

## 4. 搜索、读取、引用与预算闭环

1. 当前知识库或 AI picker 提交中文字面查询（含“预算”等两字短词示例），结果按chunk ID去重，每页≤5结果、每chunk≤400 Unicode code points，附库/fileId/sourceHash/sourceRevision/generation/parserVersion/chunkId、grantRevision及来源定位。未授权对象在AI结果列表与计数均不暴露标题、路径或摘要。
2. metadata-only可以出现在所有者文件列表及搜索结果，但没有可引用chunk。AI候选只收录`ready` chunk；图片/扫描PDF/unsupported不提供正文候选。
3. 游标是进程内顺序DEMO ID，绑定项目、查询／筛选、库集合、generation、源hash、grantRevision、轮次与到期；成功后一次消费。它不是可信安全令牌。查询/授权/generation/源变化时拒绝旧游标，要求从首屏重搜；真实CSPRNG与服务端账本仅在LLD/DB计划中。
4. `knowledge-chunk`引用绑定project当前授权、库ID、file ID、source revision/hash、published generation、chunk ID、grant revision。添加候选、读取和发送预检均重查同一授权/源版本。库停用、撤权、源变、失败或旧整篇引用一律拒绝并提示重搜；不自动回退整篇、不拼接到自然语言默认上下文。
5. 单次读取响应含工具文本不超过8 KiB UTF-8；每个会话轮次内合计≤32 KiB，计数包含搜索列表的标题/定位/json文本和读取片段。结果包含 `bytes/usedBytes/remainingBytes`；超限在发送前拒绝并保留草稿。token估算/上下文百分比/节省比例均未知，不承诺token节省。DEMO预检卡展示实际合成片段、来源定位、单次与本轮bytes；主界面AI只回显，不调用模型。
6. 显式关系读取经过同一chunk引用授权校验；只演示manifest里的`explicit-link`，不把关系边当新增授权，不推导语义知识图谱。

## 5. UI覆盖与状态

| 场景 | 主区行为 | 关键状态/边界 |
|---|---|---|
| 库管理 | 新建对话框选择bound-directory或managed-import固定夹具；原库卡片和新库卡片同列 | 空、保存pending/stored/failed，原件与解析分状态；新库默认未授权 |
| 索引任务 | 管理卡点击增量索引/重建；有明确队列与单步处理、发布 | queued、parsing、ready、partial、failed、cancelled、stale；旧generation不覆盖新源 |
| 文件/搜索 | 进入正常库内三栏，左侧搜索与文件候选，中间片段及只读source location，右侧仍为标题TOC而非AI | loading、空结果、检索失败、metadata_only、unsupported、stale/missing/corrupt/failed/unknown；状态文字+颜色+ARIA，失败清正文 |
| AI引用 | 项目AI侧栏`@`/“知识”候选使用同一授权源；选择后chip显示chunk版本 | 无授权不见标题；撤权/停用/sourceHash/generation/grantRevision变化、legacy整篇ref及预算不足均预检失败 |
| 视口/键盘 | 继承壳与栖造主题；管理/阅读正常路由，窄屏三栏纵向 | 1440/390浅深，键盘提交、Escape关闭/返回焦点，tab/heading可达；无横向溢出 |

## 6. 测试与证据边界

专属行为模型测试路径 `docs/Test/cr030-knowledge-design-test.mjs`，真实file://浏览器测试路径 `docs/Test/cr030-browser-smoke.mjs`。浏览器证据计划放 `docs/Test/screenshots/cr030-*`，至少覆盖：多格式管理/索引、三栏搜索命中、源失效拒绝、AI授权片段预检、390px深色。测试只断言状态转移、读写预算、chunk引用一致性与用户操作结果；不使用仅文本存在的静态断言替代行为测试。

## 7. 主代理收敛与已验证版本

本轮共享导航由CR-033更新为固定管理首页＋独立详情窗口；本知识增量通过moduleCtx的openLibrary/openProject接入，保留该新导航，不恢复已被替代的workspace-back。首页可返回库管理、各窗口状态仍独立；本批不主张CR-033完整验收。旧CR-021未替代的知识三栏、右TOC非AI及草稿保护约束仍适用。

主代理行为测试发现并修复取消generation复用、图片在保存重试后误变ready、metadata-only反复被计作changed、失败重建遮蔽有效片段、游标可重复消费、UTF-8额度漏算usage／错误、ID重载碰撞、页内筛选冒充全体筛选等缺口。当前固定夹具维护单调nextGeneration；changedIds仅处理受影响文件，未变化文件保其自己的publishedGeneration，库generation是目录更新epoch，不等于全部文件解析代。固定处理计数只证明DEMO分支，真实解析器调用／两writer事务未测试。

当前切片以合成canonical字符串按≤400 Unicode码点分段，保留换行、UTF-8 startByte/endByte和合成locator；只是有限源文本演示，不是实际Office/PDF定位算法或已证明文档无损抽取。CSV以record定位，DOCX注明版面页码未知；真实结构解析、质量warn及高保真预览未实现。

**纠正§4第3项的安全表述：**演示游标是顺序的DEMO-CURSOR ID并绑定进程内账本、项目/query/filter/generation/grant/round/到期及一次消费；不是不可猜测令牌、不具有密码学安全。真实CSPRNG+SQLite游标、授权返回线性化、监视读锁／原生线程驻留按照LLD/DB执行，当前均notRun。

工具响应的`text`是唯一演示模型输入envelope，序列化字节包含usage、locator和全部正文／元信息；单次8KiB、轮次32KiB内留512控制字节，错误计入且closed后不派发。同轮seen去重仅代表当前内存演示回显；它不能证明真实模型驻留，实际驻留未知需重读计额，投递不明须停止旧轮重新选择。正常发送之后finishRound终结旧预算；返回／切窗口不会自行清零，未发送的失败仍保草稿。

§4/§5所有者搜索展示全部状态；项目AI候选只取当前授权的ready片段，不将metadata-only伪装正文。筛选在分页前执行；右侧“全部文件状态”可选具体格式定位。授权修订变化后重搜命中、清旧选择。阅读结果可以直接加入当前项目AI，候选与发送复检一致；旧库新建／编辑／删除／扫描／授权控件全部保留。

### 本次实际设计证据

- [12项内存行为测试](../../Test/cr030-knowledge-design-test.mjs)／[通过日志](../../Test/cr030-model-final.log)：12/12通过，非真实解析或FTS实现证据。
- [浏览器设计测试](../../Test/cr030-browser-smoke.mjs)／[末轮日志](../../Test/cr030-browser-final.log)：11/11通过，Chrome 158.0.8127.36＋Node24.8.0，file://，1440×900／390×844浅深；页面异常／外部调用0。脚本只在新临时profile运行，未修改私人快照。
- [三栏搜索](../../Test/screenshots/cr030-02-search-1440-light-2026-11-19T11-40-11-188Z.png)、[AI片段预检](../../Test/screenshots/cr030-03-ai-preflight-1440-light-2026-11-19T11-40-11-188Z.png)、[来源失效](../../Test/screenshots/cr030-04-source-stale-1440-light-2026-11-19T11-40-11-188Z.png)、[390深色](../../Test/screenshots/cr030-05-reader-390-dark-2026-11-19T11-40-11-188Z.png)。主代理目视查看搜索／AI预检／390深色，其他截图是自动设计证据，不冒称逐图人审。
- 最终资源hash和全部未验证／并行变化见[REPORT-CR030](../../Test/REPORT-CR030-知识索引设计验证.md)。真实FTS、解析／源hash、存储耐久、权限／预算并发、原生线程恢复、软件视觉成对和性能全部未执行；用户设计验收待进行。

