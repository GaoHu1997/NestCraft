# UI-CR026：任务执行配置闭环

## 当前采用 UI-CR026-v4（CR035新壳集成）

并行CR035把公共入口切换到workbench-v4后，本轮保留新壳，不回退导航。当前运行资源为workbench-v4/execution-plan-model.js与execution-closure.js/css；直接读取该壳既有DEMO.settings，Run仍写既有DEMO.tasks，不引入第二任务或可编辑库存。旧task-workbench里的13组端到端/95原状态机属于切换前已验证历史，不代替当前稿。

当前原型实测12/12闭环：设置→明确DEMO配置→就绪需求预检→冻结Run→改默认不改旧值→工具撤权/越界拒绝→失败与fresh保预算→新组合再授权关联旧Run→独立只读phase→交付与明确验收。当前模型42/42；无真实CLI/SDK/软件/OS隔离执行。当前记录见[REPORT-CR026](../../Test/REPORT-CR026-执行计划闭环设计验证.md)，截图为cr026-v4-*。

操作：[打开唯一原型](../仿真原型UI.html)→打开预约服务→需求页下方“载入独立执行计划DEMO”→“派发闭环样例”；设置页底部“任务执行配置”修改现有Agent默认/Tool/Skill/MCP。旧展示Run没有历史Plan则明确缺失，不用当前默认补造。阶段推进是明确离线仿真按钮，不宣称后台真实执行；真实产物验证/进程监督/自动子委派仍待正式实现。


- 版本UI-CR026-v1；当前新设计待软件实现，本轮只制作可操作设计资源，不改正式软件。
- 关联[CR026](../../PRD/CR-026-统一任务执行计划与能力闭环.md)、STORY057/058/059和[方案](../../LLD/LLD-CR026-有效执行计划与能力编译.md)。[公开入口](../仿真原型UI.html)，内部task-workbench保持，不另造独立demo页。
- 授权：2026-11-19用户要求研究后结合调整需求/设计/方案形成闭环。整体栖造主题、原项目导航、AI输入与图例目录、管理CLI/SDK两tab原样保护，不搬参考平台UI代码/品牌。

## 页面与状态

| 场景 | 当前入口及增量 | 覆盖 |
|---|---|---|
| C26-01 | 智能体管理CLI卡模型/难度/类型/权限后补“任务能力默认范围”，明确模板不是授权 | 工具/Skill/MCP精确ID/声明与发现、读写/知识范围、默认继承来源、未知/禁用 |
| C26-02 | 原需求派发预检新增逐任务执行计划卡，不取消旧范围/排除/预算预检 | CLI/Runtime/模型档位/权限/能力/来源、自动/显式、变更/继承解析、ready/blocked |
| C26-03 | 卡内可展开能力清单，Tool/Skill/MCP/原生工具分组；修复/管理入口往返 | 未发现、必需缺失、未经授权/不支持、被裁剪与具体原因，不仅toast |
| C26-04 | 确认只冻结原Task/Run，不新state岛；Task详情加“本次实际配置”展开卡 | PlanID/hash、具体执行值、版本/授权来源、原配置对比、历史只读 |
| C26-05 | Task配置卡中“工具调用DEMO”只检查政策/参数，不真的调用工具 | 白名单允许/拒绝、路径越界/网络目标/撤权/Skill不提权、当前授权复检 |
| C26-06 | 原Run重试弹窗增加“按原冻结计划重试”及当前失效项 | default变更不套新值；原权限撤销/版本失效/stopPending阻塞、fresh只是新上下文 |
| C26-07 | 原配置变更/交接入口预检新计划，与sourceRun link | 换CLI/model/权限/能力重新授权，拒绝不改原Run；阶段只读评审与父子交集 |
| C26-08 | 原交付/产物/证据详情加实际Plan/阶段/能力清单来源 | Run结束不完成、依赖仅有效产物、取消不算成功、当前AC/产物版本验收 |
| C26-09 | 真实目录配置来源/空未知/环境失效/视口与键盘 | 模型供应商改动新预检同步、已选失效保留；1440/1920/390浅深、焦点、返回 |

## 视觉及具体互动

保留原预检弹窗主标题/原范围/排除/授权政策，新增白底细线12px圆角execution-card，标题13px，字段12px、说明11px，左右两列≥220px自动窄屏单列；状态用既有success/warn/error语义，原CLI Logo与模型供应商标识，不用大JSON框替代用户配置。

执行计划卡头：任务名＋实际执行器Logo/模型简述＋状态；内含基本执行、权限与能力、解析来源三折叠分组。用户能改task选择模式auto/explicit与覆盖CLI/model/permission/能力范围，并看到预检变化原因；‘inherit’必须显示其具体解析结果与来源。Preview只读原始目录、仅task draft可编辑，进入管理修改默认回原预检需重检。SDK未装/型号不兼容/必需能力不可用显示精确行，确认不可用，不悄回其它组合。

管理卡在原权限段后补能力默认清单，保留模型/难度/类型/权限原序与CLI/SDK两tab。能力默认是可用/请求模板，不是当前任务授权；Tool、Skill、MCP各显示稳定名称/范围/启用/发现/版本。Skill需要的能力独立展示，MCP服务只可选发现工具，整体全选不让未发现工具进入允许集；没有数据显示空/未知及到原管理入口，不虚造已探测。

Task卡头标“本次冻结配置 · Plan…”，操作原计划查看/改用新计划预检/原计划重试。对照当前模板发生变化，但实际配置仍旧Plan；触发状态与当前授权失效分开。工具DEMO输入选择已声明工具与相对路径/网络目标，结果给allow/deny+依据/来源，不真实运行CLI/文件命令或HTTP。

新计划预检与阶段交接沿原模态，确认后才新Run/phasePlan引用；取消保留原配置，历史Plan不可编辑。交付报告列各执行阶段与Plan/来源/产物证据，不提供绕验收按钮。

## 同源数据与制作接口

TaskExecutionDesign作为现task可操作设计的扩展，不维护第二个TaskStore。主代理负责app.js/scheduler.js/stock-design.js/ai-sidebar.js及资源接入和共享docs；制作代理仅新execution-plan-model.js（纯解析与政策检查）、task-execution-design.js/css与cr026模型/browser测试。不允许两人覆盖同文件。

制作需要TaskExecutionPlanModel的resolve(request,registry)、freeze(plan,authorization)、authorizeCall(plan,tool,args,currentRegistry)、revalidate(plan,currentRegistry)以及克隆/指纹；界面TaskExecutionDesign提供getRegistry/renderPreflight(preview)/captureConfirmedPlans(taskIds)/renderTask(task)/renderRetry(task)/renderDelivery(batch)与事件处理。主通过既有app/S hooks把计划放到原preflight.frozen[].executionPlan、task.frozen.executionPlan、attempt.executionPlanRef，不能只在独立展示对象伪装已贯通。

ConfigBroker从既有AiSessionDesign.getConfig SDK/management和WorkbenchStockDesign.getExecutionCatalog的真实供应商/能力/授权目录读取；新只读Snapshot不是新编辑库存。主补Stock API（providers、skills、mcp、tools、knowledgeGrants）和SDK/管理更新事件。prototype资料入口临时hash校验仅DEMO指纹，真实服务端SHA/CAS未实现。

所有版本/能力证据须有DEMO/截图/未知来源。用于完整仿真环境可明确加载现有安全夹具并标只DEMO，但不自动覆盖用户记录/草稿，也不将图例SDK版本当实测。正式CLI/隔离与软件视觉未验证。

## 验证

至少实走管理修改→原预检具体计划→确认原Task→默认变更原Plan不变→撤权拒绝工具→原计划失效/新计划确认→只读评审交接→原交付Plan一致。另查未经许可MCP合并、SkillHash内容漂移、未知档位不默降、CLI显式不可回退、暂停/旧进程不确定、取消不放行依赖。

原AI25/管理14/工作台18与95模型基线按本轮影响重新测试，旧通过不代新版；当新安全准入使旧模拟步骤变化时修改fixture/真实UI操作，不隐藏控件或削弱门槛过测试。最终截图先实际检查再登记资料索引，设计技术通过仍待用户视觉验收。

## CR-026本轮设计闭环交付

操作：从[公开原型](../仿真原型UI.html)打开预约项目→需求派发→明确载入闭环DEMO目录→逐任务计划确认；智能体管理CLI卡展开能力默认；Task详情看冻结计划/工具DEMO/原计划重试/新组合授权/只读评审，原报告追溯实际Plan。

主已按1440/390浅深实测13组原链条，42模型及95原状态机/AI模型通过，[报告](../../Test/REPORT-CR026-执行计划闭环设计验证.md)与截图是本轮证据。内部自动委派默认未授权关闭，不伪造内置DSH；原生工具不在浏览器执行。视觉待用户评审，正式软件未改。
