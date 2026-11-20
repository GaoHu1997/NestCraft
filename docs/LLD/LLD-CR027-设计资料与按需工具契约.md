# LLD-CR027：设计资料与按需工具契约

- 关联：[CR-027](../PRD/CR-027-Code项目设计资料与按需加载.md)、STORY-016/018/060；现行UI为[UI-CR027-v1](../UI/文档/UI-CR027-设计资料四入口.md)，[DB-CR027](../DB/DB-CR027-设计资料索引与模型记录.md)。
- 状态：设计方案，**工具/IPC/SQLite扩展/真实HTML托管均未实现**；本批仅离线演示，不注册宿主工具，不修改正式源码、依赖或运行配置。

## 1. 事实、复用与局部变更

- 既有ADR采用Markdown正文、SQLite索引/授权/配置/会话：[ADR-001](ADR-001-文档正文与统一能力网关.md)。PRD/方案继续这一权威安排。
- 正式[项目命令:238–250](../../src-tauri/src/commands/projects.rs#L238-L250)的`read_doc/write_doc`读取/写回全正文，接口未具备本次AI读取的项目绑定、片段预算、基线CAS，不直接暴露给AI。正式[设计工作区:424–433](../../src/modules/projects/Workspace.tsx#L424-L433)扫描UI根层MD，与CR-024唯一HTML入口/子目录文档不兼容，后续需在编码授权后照新稿修订。
- 正式[提示编译:323–359](../../src-tauri/src/commands/chat.rs#L323-L359)的知识引用存在全文注入；现有ContextRef不是带版本/范围的按需读取。新工具是未来契约，不把只增加名字当作这些行为已经修复。
- 复用原项目身份、文档/文件读写与Markdown安全渲染、权限网关、模型/调整草稿实体、分支/HEAD与差异包机制，不新建需求树、AI会话源、执行计划库存或第二数据库。
- **CR-027局部权威变更**：数据库设计模型采用同一SQLite中专用版本化设计记录，不复用供应商AI`model`表；旧DB设计的`model_design`文件权威仅继承为历史/受控导入来源。导出Markdown是只读派生，不与数据库形成双向同时编辑。

## 2. 人类工作区与保存

- 保持外层需求/设计/任务/编码和返回。设计区内部PRD/UI/方案/数据库设计，默认PRD；主内容 + 224px右菜单嵌于AI左侧主区，不修改AI的400/380px规则。
- 主区宽度≤720px时右菜单收起为主区内部抽屉；正文工具栏按钮开关，Escape关闭并回到入口，不跨入AI。沿用原窄屏AI顺序回落。
- PRD/方案默认Markdown阅读，章节定位；编辑有独立草稿、即时dirty状态、放弃确认、失败保留；不同资源草稿不互相覆盖。
- UI默认打开项目唯一入口内容，保持相对资源基址与项目隔离。正式托管策略：宿主解析项目内入口/相对依赖；在隔离WebView中禁宿主IPC、文件任意读取、父页导航、网络/弹窗/下载，HTML仅作为不可信设计资源。允许脚本的本地仿真不能拿到宿主权限；**该正式托管适配尚未实现**。本原型直接绘制合成预约首页，不递归嵌本工作台、不另造公开入口；不宣称已读取真实HTML文件。
- Markdown正式渲染复用marked + DOMPurify，HTML/链接/资源均检查协议与根目录，不执行文档脚本。本次离线小型渲染器仅支持演示标题、段落、引用、列表、表格、代码和粗体，全部先转义，不冒充完整编辑器实现。
- GUI文件编辑先持有baseHash、受管相对路径、项目/分支/HEAD与授权修订；保存冲突拒绝并保留草稿。文件临时写入/rename不等于跨文件+DB真事务，索引失败显示待重建，不伪同步。
- 模型保存创建不可变版本，父记录CAS更新currentRevision；验证名称、字段、类型、约束、同项目FK/索引和关联。涉及Story/AC变化继承原差异提案/整包确认，不凭保存自动同步/完成Story。
- 原型复用同一aux命名空间`projectDesignResources`，旧草稿不搬走/覆盖；保存合成资料后仅用原状态机把关联Story设计标待同步，正文/AC、Run与AI不变；原“返回关联需求/显式同步设计依据”评审路径保留。显式同步仅原DEMO，不当真实配套差异包已实现。

## 3. 两个拟议只读工具

宿主在调用边界注入`projectId/sessionId/workLevel/grantRevision/executionPlanRef`，模型参数**不包含任意路径、rootUri或可自报的projectId**。正式名称为拟议`project_design_list`、`project_design_read`，不是现有已注册工具。

### 3.1 project_design_list

```ts
input = {
  category?: 'prd' | 'ui' | 'solution' | 'model',
  query?: string,             // 编号、标题、受管定位和摘要；不隐式全文读取
  linkedStoryId?: string,
  cursor?: string,            // opaque；绑定过滤、索引代次、授权、项目
  limit?: number
}
output = {
  schemaVersion: 1, indexRevision: string,
  items: [{
    id: string, category: string, title: string,
    locator: string,           // 项目相对文件地址或model://project/id，不当授权
    summary: string, summaryRevision: string, summaryStatus: 'current'|'pending'|'stale',
    sourceRevision: string, contentHash: string,
    syncState: 'synced'|'pending'|'conflict',
    linkedStoryIds: string[], linkedAcIds: string[],
    outline: [{id:string,title:string,startLine?:number}],
    bodyLoaded: false
  }], nextCursor?: string, truncated: boolean
}
```

- 默认8项、最多20项，摘要每项不超过160字、outline最多12个标题，响应UTF-8硬限8KiB；返回分页游标，不自动追完。**可逆方案默认值，不是用户承诺的固定产品额度**。
- 索引在本机解析/缓存文件元数据：优先front matter的title/summary，缺少时取首标题和受限“目标/范围”摘要，不请求LLM一次读全库。长摘要/大纲按需后续页；重名保留稳定ID与相对路径，禁止靠文件名合并。
- 摘要/索引随源修订失效；不能给r2正文配r1摘要却声称current。失败保留上代并标stale/pending，不以空列表掩盖加载失败。

### 3.2 project_design_read

```ts
input = {
  id: string,
  sourceRevision: string,
  selector?: { headingId?:string, startLine?:number, maxLines?:number,
               fieldNames?:string[], includeRelations?:boolean },
  cursor?: string,
  maxBytes?: number
}
output = {
  schemaVersion: 1, id: string, locator: string,
  sourceRevision: string, contentHash: string,
  format: 'markdown'|'model-description'|'ui-description'|'html-source',
  range: {startLine?:number,endLine?:number,fieldNames?:string[]},
  content: string, truncated: boolean, nextCursor?:string, eof:boolean,
  citation: {id:string,locator:string,sourceRevision:string,range:object},
  usage: {tokens:number|null,measurement:'measured'|'estimate'|'unknown',bytes:number}
}
```

- 默认当前选中的小章节/80行，最多160行且单次8KiB；模型默认字段/约束摘要，显式指定才读相应关系；UI默认页面/资源说明，`html-source`须明确需要，不递归打包依赖。
- selector互斥规则：headingId与起始行不可混用；模型字段选择不与文件行选择混用；续读cursor不可同时重新指定selector。范围必须有效，过大返回截断与游标，长单行按UTF-8安全字符边界续读，不能丢余段。
- 源版本必须来自当前list；变化返回`SOURCE_CHANGED`，不给混合片段。每次read包括复用缓存都复查授权；缓存命中仍占当前编译输入，不等于0token。
- 错误：`NOT_FOUND_OR_DENIED`（对外不区分是否存在）、`SOURCE_CHANGED`、`INDEX_PENDING`、`READ_FAILED`、`INVALID_RANGE`、`BUDGET_EXCEEDED`、`UNSUPPORTED_FORMAT`。错误不返回旧正文冒充成功；不增加批量全文`read_many`或AI写接口。

### 3.3 离线演示与生产契约区别

`ProjectDesignResources.list/read`只使用合成夹具，默认8项/片段8行，演示简单数值游标及`demo-rN`，返回未知token。版本变化后静态夹具摘要标`stale-fixture`。未实现opaque签名cursor、真实hash/CAS、授权绑定、字节/模型token硬预算与真实文件/DB读取；不以该DEMO放行正式安全验收。

## 4. AI按需流程、缓存与预算

1. 默认提示只含“该项目有设计资料，可使用这两个只读工具按需查找”的短发现信息和当前任务/项目身份；不把目录内容/全文塞system或每轮消息。
2. AI根据目标list某分类/关键词/关联Story，选必要资料；按版本read需要章节/模型字段；只有不足时追加片段，不硬性全读PRD+UI+方案+全数据库。
3. 引用保存对象ID、版本/hash、范围、授权修订。子代理只传任务所需引用/片段，宿主重新缩权复检；换项目或撤权立即失效。
4. 缓存键为项目+对象+源版本+范围+授权修订+工具schema；源改动或授权变化立即失效。无新增内容不重复注入，只记录引用；摘要保留来源，不能把摘要冒充完整正文。
5. 编译前预算按system+所选工具定义+当前历史/摘要+用户输入+**实际载入片段**计，再预留模型输出与安全余量。默认按小片段逐次读取；模型计量未知时用保守字节上限和unknown说明，不按0放行。
6. 建议检索上限来自配置和当前模型可用窗口的交集，不在本批强加固定4096tokens/3篇等用户未确认额度。父子任务/重试沿同一受管预算，不用开启新上下文绕过止损。
7. 原生文件/shell/MCP若仍能旁路读其他目录，必须由真实CLI适配/沙箱兑现；没有证据只标未知，不宣称两个工具自动隔离所有渠道。

## 5. 后续实现顺序与验证（需另行授权）

1. 先通过UI版本与受影响状态准入；实现受管文档索引和模型版本记录，补兼容解析与冲突提示。
2. 实现GUI文件/模型读写与CAS，隔离UI托管，保留已有提交调整/关联需求入口。
3. 注册两只读工具并接ContextRef分段引用；不复用任意绝对路径全文IPC或默认知识全文注入。
4. 验证跨项目/撤权/缓存失效/游标绑定/大文件与UTF-8边界/未知token/源变更；按[DB方案](../DB/DB-CR027-设计资料索引与模型记录.md)验证迁移与恢复。
5. 同主题、视口、数据和状态逐页面设计/软件成对视觉对照后交付；仅本次原型测试不得代替。

## 6. 已知差异与并行边界

- 软件根层MD扫描、全文引用、无版本ContextRef与设计方案有差异，保持正式能力“未实现/待编码”，不改源码。
- 独立调研最初发现两份CR-025；并行执行计划随后已顺延CR-026，本批**CR-027**，只改自身编号，不覆盖对方文件或冻结证据。
- 已有功能布局/AI样式与配置以各有效稿继承，本批不全量核对/声称全软件视觉统一。设计验证与遗留见[REPORT-019](../Test/REPORT-019-设计资料四入口与按需加载验证.md)。
