# UI-COVERAGE-017：统一入口存量场景覆盖

> CR-024目录继承说明（2026-11-19）：当前唯一公开入口为 [仿真原型UI.html](../仿真原型UI.html)，规范／说明及资料索引已集中归类，内部运行页及资源保留原位。正文旧“固定／永久位置”和验证语境保留当时事实；本次一次公开入口归类以 [CR-024](../../PRD/CR-024-UI目录整理与唯一入口.md) 优先，不改设计／业务或冻结证据。

- 日期：2026-11-19（Asia/Shanghai）；版本：UI-BASELINES-017-v1.1；负责人：cr017-baselines；集成负责人：lead / cr017-ui。
- 范围：仅新增只读存量设计基线与本覆盖登记，不修改统一入口、任务交互、调度器、主索引、正式代码或冻结原型。
- 规则：已读取 [AGENTS §6.3.1](../../../AGENTS.md#631-设计先行与视觉一致性界面开发强制准入)。UI为唯一视觉/交互基准；软件/技术方案不能反向决定设计；纯设计不授权软件实现；有菜单不等于完整可视覆盖。
- 依据：[UI-FEAT-001 CR-014](UI-FEAT-001-界面设计.md#4-cr-014-工作台界面与导航调整现行)、[PRD-001](../../PRD/PRD-001-个人Agent界面需求.md)、[CR-015](../../PRD/CR-015-启动Tauri正式实现.md)、指定 Story 024/025/026/029/030/035/036。已核对 [存量缺口登记](UI-BASELINE-001-设计与实现覆盖核对.md)。
- 状态：32项只读资源首版已生成并静态验证；用户设计待评审；**统一入口最小挂接由原UI代理完成，挂接后的实际展示和正式软件视觉对照本代理均未执行**。本表不声称全软件覆盖或视觉一致。

## 1. 唯一入口与资源调用

唯一设计浏览入口：[当前统一工作台](../仿真原型UI.html)。主代理/原UI代理仅需加载 [baseline-scenes.js](../task-workbench/baseline-scenes.js) 并在同一设计浏览器选择 sceneId、插入 `WorkbenchDesignBaselines.render(sceneId)` 的只读HTML；**不得 iframe / 执行冻结原型创建第二套需求state**。本代理不编辑入口或挂接代码。

经典IIFE固定API：

| API | 返回/边界 |
| --- | --- |
| `globalThis.WorkbenchDesignBaselines.list(module?)` | scene对象数组；省略参数返回32项，`settings`聚合供应商/SDK/基础与能力，`history`仅已替代历史；provider/models/server/host/code/git/ai等有别名 |
| `get(id)` | 对应冻结scene对象或null；字段 `id/title/module/status/version/sourceUri/imageUri/description` |
| `render(id)` | 安全、只读HTML：完整字段/状态原型或本地设计图，包含标题/状态/版本/来源/范围/未核验说明；未知ID显示设计缺失；不产生需求数据/计时器/事件/网络调用 |

所有本地URL按当前script.src基址解析为绝对file URL；无fetch、模块导入、iframe、事件handler、data-action或业务命令。表单全为disabled/readonly；保存/取消/安装/卸载/重检/批准拒绝等动作区已画预期按钮视觉与位置，**全部是disabled type=button的只读设计样例，不是可执行业务操作**。局部样式只使用 `var(--...)` 设计令牌，不读取软件动态CSS；主代理已从有效CR014设计冻结 [theme-tokens.css](../task-workbench/theme-tokens.css)，本代理不编辑该文件。

已读取并确认仓库已有 [CR-018授权与范围](../../PRD/CR-018-统一设计稿AI侧栏与输入菜单.md) 和 [UI-CR019-v1 r2新完整AI设计](UI-CR019-AI会话完整交互设计.md)。CR018开关/输入机制保留，CR019替代其部分简化头部/统计交互；本资源不覆盖这些新变更，不将cr017-ui指认为CR018负责人。任务新交互仍由lead/cr017-ui按各自所有权维护。原设计图里的Tab计数与shell序号不继承，当前CR017所有Tab仅名称、无数字规则优先；图注已明确。

资源整体SHA-256：`83d397271c68282fd3ea1f1f233cb41c0fec854c580887604dc3232481b7f5de`（本次首版最终字节）。旧设计图下面用SHA-256前16位标识，完整文件可按链接重新计算；新HTML使用此JS版本及sceneID定位，不把相同文件hash当相同页面。

## 2. 状态、继承与授权口径

| 逐页状态 | 本次含义 |
| --- | --- |
| 当前实现基线 | 已授权、尚未被新稿替代的CR014视觉/字段/布局约束被继承；**不是已验证当前软件符合它**。原截图仅其捕获状态，不扩大为全状态覆盖 |
| 新设计待实现 | 按原已授权范围补齐的完整只读HTML字段/状态资源；设计稿可供挂接，用户未验收、软件未对照，不能声称功能已实现 |
| 设计缺失 | 必需授权/完整可视策略仍缺；禁止对应软件开发，不能用占位、软件当前行为或其它页面放行 |
| 已替代历史 | 已被CR017/CR018替代的相关导航/交互仅追溯，未替代的字段/布局约束仍保留，不形成第二入口 |

CR014图片来自**先前可操作设计原型**，不是当前软件截图，允许继承其未替代约束。CR017的四Tab无数字、CLI Logo、任务闭环和CR018侧栏开关/输入外观仍由当前任务交互资源承担；本次不重新实现它们。不能把品牌选定、共享令牌、静态路径存在、原型自己截图或功能测试通过当作软件一致证据。

## 3. 四个关键领域：20项完整资源

所有行本轮核验为：本地source/image存在、scene可生成安全只读HTML；未做统一入口点击、软件截图或功能实现验证。继承图统一原视口1440×900浅色；新HTML按CR014白蓝变量设计、含700px以下顺序回落样式，**深色/窄屏实际展示未核验**，不能仅凭CSS声称通过。

资源栏“HTML”表示 [baseline-scenes.js](../task-workbench/baseline-scenes.js) 内对应完整只读表单/状态场景，不是说明卡或菜单名称。

| Feature / Story / AC | sceneID / 页面 | 可视resource与版本/Hash | 授权与状态覆盖 | 拟对应实现位置 / 逐页状态 |
| --- | --- | --- | --- | --- |
| FEAT-014；STORY-024 AC01～04；STORY-026 AC12；STORY-029 | BASE-PROVIDER-LIST / 主供应商行卡 | [原主卡图](../../Test/screenshots/cr014-12-settings-models.png)；CR014-v3.1；`3b4a27cdda5534e0` | CR012/014/015；主卡、状态点、启用/编辑/删除、四分类；非所有异常交互 | `src/modules/settings`；当前实现基线（未软件对照） |
| 同上；STORY-024 AC05、08～10；STORY-029 AC02/03 | BASE-PROVIDER-PARAMETERS / 完整参数 | HTML＋[原参数图](../../Test/screenshots/cr014-13-provider-provider.png)；新稿v1.1；图`f48db20210b9c466` | 显示名称、协议、多密钥/掩码/默认/模型分配、添加密钥展开、多端点/启停/备注；补齐旧截图滚动下未显示字段 | `src/modules/settings`；新设计待实现 |
| STORY-024 AC06；STORY-026 AC12；STORY-029 AC01 | BASE-PROVIDER-MODELS / 模型完整展开 | HTML＋[原展开图](../../Test/screenshots/cr014-14-model-expanded.png)；新稿v1.1；图`af1256459ef5d47a` | ID/名称、文本/视觉/生图互斥、思考集合/wire、默认强度、上下文/输出；折叠/保存中/非法默认/获取结果 | `src/modules/settings`；新设计待实现 |
| STORY-024 AC07；STORY-026 AC12 | BASE-PROVIDER-ADVANCED / 高级 | HTML＋[原高级图](../../Test/screenshots/cr014-13-provider-advanced.png)；新稿v1.1；图`3cc73b931c3bdf6e` | 请求头、请求伪装；原授权超时/并发/重试/代理/方言字段、空/重复/秘密错误文案 | `src/modules/settings`；新设计待实现 |
| STORY-024 AC07；STORY-026 AC12 | BASE-PROVIDER-FINGERPRINT / 指纹 | HTML＋[原指纹图](../../Test/screenshots/cr014-13-provider-fingerprint.png)；新稿v1.1；图`8b427bb6bad3ce46` | 逐模型检测项、未开始/检测中/通过/无法判定/失败；结果不自动更改能力 | `src/modules/settings`；新设计待实现 |
| STORY-024 AC02/03/05/10；STORY-029 AC01～03 | BASE-PROVIDER-INVALID / 参数与删除异常 | HTML；新稿v1.1 | 完整参数字段保留；空名称/空密钥/端点错误/禁用/删除确认/取消/保存失败/失效会话；不静默回落 | `src/modules/settings`；新设计待实现 |
| FEAT-015；STORY-025 AC01/02/08～10；STORY-026 AC13 | BASE-SDK-LIST / SDK三CLI主卡 | [原SDK图](../../Test/screenshots/cr014-12-settings-sdk.png)；CR014-v3.1；`11a060e5ebe6244b` | registry、三CLI版本/状态、内置只读提示；未安装与有更新；原Logo只保留布局约束，标识采用CR017现存资源 | `src/modules/settings`；当前实现基线 |
| STORY-025 AC01/02/06/09；STORY-030 AC02/03 | BASE-SDK-EXPANDED / 版本卡完整展开 | HTML；新稿v1.1；现存本地CLI SVG | 三CLI各自当前/目标版本、渠道、路径、启用、未安装候选、卸载影响；不安装或探测 | `src/modules/settings`；新设计待实现 |
| STORY-025 AC03～07；STORY-030 AC01～03 | BASE-SDK-JOBS / 作业状态 | HTML；新稿v1.1 | 保留完整版本配置；queued/running/done/failed/cancelled、安装/更新/卸载确认、阶段日志、重试/取消/上次版本保留 | `src/modules/settings`；新设计待实现 |
| FEAT-008/009；STORY-026 AC02；STORY-036 | BASE-KNOWLEDGE-LIST / 库管理 | [原库列表图](../../Test/screenshots/cr014-02-knowledge-list.png)；CR014-v3.1；`778a4168a77ad0b3` | 库列表、说明、授权摘要、打开/授权层级；不恢复已取消“快速目录” | `src/modules/knowledge`；当前实现基线 |
| STORY-036 授权范围/AC03 | BASE-KNOWLEDGE-CREATE / 建库编辑 | HTML；新稿v1.1 | 名称、本地Markdown目录源、受管引用/可读状态、说明、启用、默认无授权；加载/未选/不可访问/扫描中失败/取消/成功 | `src/modules/knowledge`；新设计待实现 |
| STORY-009 AC；STORY-036 AC01 | BASE-KNOWLEDGE-GRANTS / 项目授权 | HTML；新稿v1.1 | 项目勾选、原/新授权版本、取消/撤权/无权/保存失败；空授权拒绝，已显示内容不可收回 | `src/modules/knowledge`；新设计待实现 |
| STORY-014/026 AC03；STORY-036 AC03 | BASE-KNOWLEDGE-READER / 三栏 | [原阅读图](../../Test/screenshots/cr014-03-knowledge-doc.png)；CR014-v3.1；`654ffcc84e139a77` | 空间/搜索/目录树、正文标题一次、右TOC同源；正常选中文档状态 | `src/modules/knowledge`；当前实现基线 |
| STORY-036 AC01～03；PRD CR007 | BASE-KNOWLEDGE-STATES / 三栏异常 | HTML；新稿v1.1 | 完整三栏保留；加载/未选/空库/搜索无结果/读取失败/撤权/无标题/重复锚点说明，不残留旧正文 | `src/modules/knowledge`；新设计待实现 |
| FEAT-016/017；STORY-026 AC10；STORY-035 | BASE-SERVERS-LIST / 主机列表 | [原主机列表图](../../Test/screenshots/cr014-09-servers.png)；CR014-v3.1；`45ecaa29ecb0e9a7` | 主机名称/地址/资源/连接/逐主机授权/进入；详细表单另有完整资源 | `src/modules/servers`；当前实现基线 |
| STORY-035 主机CRUD范围/AC01 | BASE-HOST-PASSWORD / 新建密码主机 | HTML；新稿v1.1 | 名称/地址/端口/用户名/环境/密码类型/掩码/凭证引用/默认不连接不授权/主机校验未知；必填/端口/认证错误/取消/失败 | `src/modules/servers`；新设计待实现 |
| 同上 | BASE-HOST-KEY / 编辑SSH主机 | HTML；新稿v1.1 | 密钥文件/私钥文本类型、文件引用/口令/私钥占位、完整公共字段及校验；无真实PEM，取消保留旧配置 | `src/modules/servers`；新设计待实现 |
| STORY-026 AC10；STORY-035 AC02 | BASE-SERVER-WORKBENCH / 完整终端 | [原终端设计图](../../Test/screenshots/cr014-10-server-workbench.png)；CR014-v3.1；`e5ef591434391a6a` | SSH/shell、文件树、终端、系统/逐核/内存监控与AI授权；正常DEMO连接，不证明SSH/SFTP | `src/modules/servers`；当前实现基线 |
| FEAT-017；STORY-035 AC01/03；PRD风险边界 | BASE-SERVER-STATES / 失败与审批 | HTML；新稿v1.1 | 三栏失败/未连、终端禁用、目录不可用、授权/工具停用；完整审批目标/动作/风险/时间/到期/请求状态/复检，拒绝/断开/撤权失效 | `src/modules/servers`；新设计待实现 |
| STORY-035明确排除known_hosts | GAP-HOST-VERIFICATION / 主机校验 | 缺口只读字段清单；v1，不是可开发方案 | 算法/指纹/凭据/信任策略未确定；不得自动信任。完整首次/不匹配/已记录信任设计与授权缺失 | 未预测实现；**设计缺失，禁止对应开发** |

## 4. 其它12项继承或补稿

这些与新任务交互可并列在同一资源浏览器。旧图中三Tab、原品牌或尚未替代区域须按此处描述裁定，不整页倒灌成当前任务设计。

| Feature / Story / AC | sceneID / 资源 | 版本 / Hash | 状态覆盖 / 授权 / 拟实现位置 | 逐页状态 |
| --- | --- | --- | --- | --- |
| FEAT-001；STORY-026 AC01 | BASE-PROJECTS-LIST；[项目列表](../../Test/screenshots/cr014-01-projects.png) | CR014-v3.1 / `4fee1571284ae882` | 编码/办公项目列表，正常；新品牌应用替换未包含；`src/modules/projects` | 当前实现基线 |
| FEAT-003；STORY-026 AC04/05 | HISTORY-REQUIREMENTS；[原需求树](../../Test/screenshots/cr014-04-requirements.png) | CR014-v3.1 / `14ca35d0a1f16ecb` | 原三级树/编号/行图标未替代约束保留；CR017无数字Tab/派发闭环由当前稿掌管；`src/modules/projects` | 已替代历史（相关交互） |
| FEAT-003；STORY-026 AC06 | BASE-REQUIREMENTS-PREVIEW；[连续正文](../../Test/screenshots/cr014-05-preview.png) | CR014-v3.1 / `65d26dcdd2ffc796` | h1/h2/h3、右TOC、独立AI；正常预览，不能照软件去掉AI；`src/modules/projects` | 当前实现基线 |
| FEAT-004；STORY-026 AC07、STORY-018 | BASE-DESIGN-MODEL；HTML＋[原设计工作区](../../Test/screenshots/cr014-06-design.png) | 新稿v1.1 / 图`2a578c62a603b65a` | 逐表描述/字段/类型/PK/FK/备注/表目录/待同步；原图只作设计工作区结构参考，HTML补模型字段；`src/modules/projects` | 新设计待实现 |
| FEAT-007；STORY-026 AC08/034 | BASE-FILES-EDITOR；[文件编辑区](../../Test/screenshots/cr014-07-code.png) | CR014-v3.1 / `c095988311e5be59` | 文件树/页签/行号/满高AI正常态，原Tab不能覆盖新任务Tab；`src/modules/editor` | 当前实现基线 |
| FEAT-007；STORY-026 AC09/033 | BASE-FILES-GIT；[Git三段](../../Test/screenshots/cr014-08-git.png) | CR014-v3.1 / `2e55b2347720b90f` | 未提交/固定提交框/分支/历史、暂存差异/分支语义继承；`src/modules/git` | 当前实现基线 |
| FEAT-010/011/012；STORY-024 AC08～12、STORY-011/020/021/032 | BASE-CHAT-STATES；HTML | 新稿v1.1 / JS整体hash | 历史未读、同宽引用/关键词/能力、工具请求结果/审批、模型档位、运行/失效/撤权/未知用量；CR018输入外观不被替代；`src/modules/chat` | 新设计待实现 |
| FEAT-006；STORY-008/PRD CR004 | BASE-OFFICE-MATERIALS；HTML | 新稿v1.1 / JS整体hash | 资料列表、Word/PDF/MD阅读、表格sheet、幻灯片预览版式，未选/解析失败/生成预览/批准拒绝；无实际Office导出；`src/modules/editor`与办公相关范围 | 新设计待实现 |
| FEAT-013；STORY-026 AC11 | BASE-SETTINGS-GENERAL；[基础设置](../../Test/screenshots/cr014-11-settings-general.png) | CR014-v3.1 / `30520aebd01c32df` | 用户/外观/代码样式正常画面；`src/modules/settings` | 当前实现基线 |
| FEAT-013/014；STORY-026 AC14/031 | BASE-CAPABILITIES；[Tool页](../../Test/screenshots/cr014-12-settings-tool.png) | CR014-v3.1 / `313967515827d733` | Tool完整页/风险/开关；只该图不代表Skill/MCP；`src/modules/settings` | 当前实现基线 |
| FEAT-013；STORY-026 AC14/031 | BASE-SKILL；[Skill页](../../Test/screenshots/cr014-12-settings-skill.png) | CR014-v3.1 / `a0a7406cfc9f6160` | Skill完整页正常/开关/创建规范继承；创建错误未独立截图；`src/modules/settings` | 当前实现基线 |
| FEAT-013；STORY-026 AC14/031 | BASE-MCP；[MCP页](../../Test/screenshots/cr014-12-settings-mcp.png) | CR014-v3.1 / `c730dd3bc590f890` | MCP完整页正常/开关/创建/连接规范继承；真实连接不验证，错误未独立截图；`src/modules/settings` | 当前实现基线 |

## 5. 尚未核验与缺口（不放行对应开发）

1. **已知明确设计缺口**：主机known_hosts/算法指纹/首次信任/不匹配/替换流程。STORY-035原范围排除该能力，本次只显示未知与阻止，不把现有忽略校验实现当正确设计；需lead核对授权后补完整可视稿。
2. **统一入口挂接后展示未核验**：本代理未改现有入口，因此不能声称已在当前浏览器可点开全部32场景。原UI代理按上方API挂接后需逐场景检查，缺显示则标缺口，不退回简化卡片。
3. **深色、390px与1920px新HTML未实际截图**：有令牌和响应式定义，但尚无截图证据；进入相应软件视觉开发前必须看稿并登记适用主题/视口。旧继承图只证明其原视口画面存在。
4. **存量非核心异常仍非独立完整图**：Skill/MCP创建弹框错误、Git无仓库/脏切换/失败菜单、办公真实格式/长文/解析错误的全部版式，以及其它未列在本表的页面/弹框，未进行全量可视覆盖；旧有效规范可继续继承，但要逐项核对并补可查看状态，不能以本表列名放行全部软件。
5. **软件设计成对对照未执行**：没有软件截图、叠加或diff；本轮只有先前设计图与新只读HTML。不得把本轮静态API/路径检查、旧原型截图、共享主题或先前15项UI功能检查改写为全软件一致。
6. 当前任务新交互、Tab不带数字、CLI Logo、单入口与任务/需求联动由cr017-ui/lead按本轮所有权负责；AI侧栏新变更按CR018/CR019正式登记维护，本资源不覆盖、不重新分配负责人，也不把继承画面旧导航当新稿。

## 6. 本轮实际静态核验与边界

- 操作：`node --check docs/UI/task-workbench/baseline-scenes.js`；Node VM只读载入该IIFE，注入当前script绝对file URL，再调用list/get/render。
- 结果：**32个scene、26个渲染本地img资源，全部sourceUri/imageUri与HTML引用资源存在；58个动作区按钮均disabled且type=button；无iframe、script、inline事件handler或data-action；每个render有只读/未验证声明，旧图Tab数字与shell序号明确排除继承；语法通过。** 不写任何现有文件、不加载运行旧原型。
- 追加覆盖登记核验：32个sceneID全部出现在本表、本轮全部本地Markdown资源链接存在；四类状态合法、模块过滤/get/render可用、未知场景ID安全显示设计缺失。动作区补稿按本轮1.1版本核验，未执行浏览器视觉对照。
- JS资源hash见§1；表中先前设计图hash由真实文件字节SHA-256计算。
- 过程失败：首次PowerShell内联JS的双引号/正则引发shell解析失败（退出1），不是资源语法失败；改用here-string后原语法和32场景静态检查通过。未隐瞒或降低检查条件。
- 未执行：浏览器展示截图/点击、统一入口挂接、正式软件对照、真实CLI/网络/数据库/安装。没有新测试文件、主索引或应用代码变更。未生成assets，因为已存在原设计图和现存CLI标识足够作为本首版资源；新表单是本JS内完整HTML。
- 交付：将路径/API通知lead与cr017-ui，由它们负责最小挂接、冻结设计主题、逐页总览登记与展示核验。用户设计待评审、正式软件视觉对比未执行。

## 7. CR-030：本地知识索引场景增量（UI-CR030-v1）

- 日期：2026-11-19；版本：UI-CR030-v1；唯一入口仍[仿真原型UI.html](../仿真原型UI.html)，运行资源位于同一`task-workbench`，不另建应用／第二状态源。
- 授权／状态：用户明确授权调整知识索引需求与设计，但未授权正式软件。新设计待评审；每行状态“新设计待实现”只描述设计基线，不代表软件已实现或软件视觉通过。
- 依据：[CR-030 PRD](../../PRD/CR-030-本地知识索引与按需引用.md)、[STORY-036 AC-08～13](../../Plan/Story/STORY-036-知识库正式实现.md#cr-030本地知识索引与按需引用)、[STORY-009 AC-08～11](../../Plan/Story/STORY-009-知识库项目授权与AI检索.md#cr-030本地知识索引与按需引用)、[STORY-014 AC-08～10](../../Plan/Story/STORY-014-服务器列表与知识库三栏阅读.md#cr-030本地知识索引与按需引用)。沿用UI-COVERAGE-017的库管理→详情三栏→所属管理返回，不改导航或右TOC非AI约束。

| Feature / Story / AC | 场景与唯一夹具状态源 | 覆盖与失败结果 | 资源／证据／实现状态 |
| --- | --- | --- | --- |
| FEAT-008/009；STORY-036 AC-08/09/13 | `CR030-KB-01` 管理/格式 | 同页展示bound-directory与managed-import样例；每种后缀显示能力矩阵、parse/index独立状态、增量原因及来源修订。CSV首行仅显式选表头；Excel缓存不计算；扫描件metadata_only、旧DOC unsupported、错误码明确 | UI-CR030 / DEMO，新设计待实现 |
| STORY-036 AC-09/10/12 | `CR030-KB-02` 变更/代际 | changed→stale→queued→parsing→published；解析失败partial保原件，取消/两个writer旧generation拒发，重试新attempt，索引失败可重建；freshness unknown时AI失败关闭 | UI-CR030 / 合成故障，不是真实I/O／事务测试 |
| STORY-036 AC-11；STORY-009 AC-08 | `CR030-KB-03` 中文全文命中 | literal词／短词夹具以同一版本pipeline检索；最多5项、每项400码点，定位回真实格式单位；搜索成功空态与FTS不可用错误分开 | UI-CR030 / 固定文本夹具，不是真实FTS／相关度验证 |
| STORY-009 AC-09/10 | `CR030-KB-04` AI候选和发送预检 | 当前project同源grant候选→选择切片→去重→显示序列化字节额度；源变／grant rev失效／旧整篇标签needs_reselect／额度不足均保草稿、不实际发送 | UI-CR030 / 同一模拟授权fixture；模型不调用、token未知 |
| STORY-014 AC-08/09 | `CR030-KB-05` 三栏来源定位 | 点击命中后当前文件／修订／位置／正文／结构目录一致；DOCX无页定位unknown，扫描PDF不造页文本；返回库管理后同一库原选择保留，失效源不留旧正文 | UI-CR030 / 覆盖正文与页面；不等于真实格式解析／来源定位 |
| STORY-014 AC-10 | `CR030-KB-06` 键盘／响应式 | 1440、390及适用320视口；浅/深主题、筛选、Esc、返回、focus和live错误；不横溢／不覆盖品牌与AI功能 | UI-CR030 / CDP证据待执行或以REPORT实际结果登记；视觉待用户评审 |

**本轮准入范围**：只涉及同一入口知识库管理、库内三栏、AI片段候选／发送预检及其局部加载／空／partial／stale／unknown／failed／denied／budget exhausted状态。授权编辑仍由原project-library grants界面唯一保存，夹具只读复用它，不建第二授权状态。AI候选读取该grant源与固定chunk版本，不改CR-018/019输入、会话、计量或设置。固定样例只是可操作评审数据，不请求真实文件、CLI、模型、网络或业务DB。

**本次实际验证**：UI-CR030-v1的7个运行资源hash见[最终资源清单](../../Test/cr030-ui-resource-hashes.json)，[设计模型12/12](../../Test/cr030-model-final.log)及[浏览器11/11](../../Test/cr030-browser-final.log)通过。真实FTS／解析、两writer／数据库、文件耐久、原生线程驻留及软件视觉仍未验证；这只放行设计评审，不是软件实现准入或用户验收。CR-033已替代详情返回导航为固定首页／窗口，本知识模块通过同一上下文窄回调接入，保留其设计，不恢复旧workspace-back。本表旧“所属管理返回”仅指可回首页相应管理页，不要求被替代按钮重新出现。

样例能力与真实计划分开：CSV只演示record定位／首行保留数据，实际表头选项与解析器未实现；中文搜索是literal固定字符串，不声称已运行版本化词典／FTS；取消迟到是单进程generation行为，不声称跨进程writer测试。本轮实际视口1440/390浅深，320列为未来适用项未执行。逐项正式13AC和真实后端均notRun，详见[本次报告](../../Test/REPORT-CR030-知识索引设计验证.md)。

**放行条件**：本轮入口已实际点击验证且有自动截图，不因此声称整个存量UI覆盖；资源后续变化需重新检查。正式软件仍需完整场景版本、对应权威数据／工具契约及另行明确编码授权，再执行同条件设计／软件成对对照。

