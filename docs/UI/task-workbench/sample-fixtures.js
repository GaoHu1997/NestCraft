/* UI-CR022-v1 / STORY053：虚构预约业务夹具；不是生产记录、不是实测。 */
(function(root){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const rules=`# repo AGENTS / Story 规则摘录（DEMO引用，不替代仓库规则）

需求与设计确认不自动授权正式编码。先读规则、需求和已有设计，再在明确授权范围工作。
Story只属于一个Feature，包含可观察AC。运行退出不等于技术交付，技术交付不等于用户验收。
变更需求/设计后旧证据可能失效；不得把失败、未知实测或样例输出写成通过。
只读知识授权不授予写文件、执行命令或访问未授权目录。无真实密钥、生产连接和发布。
`;
  const contract=`# 预约接口约定

## 场景与归属
虚构场景：社区活动预约服务，项目DEMO-PROJECT-01。演示者“林澈”提交活动时段预约；所有人员、预约号、消息及时间为夹具，不是生产记录。

## 请求与幂等
POST /demo/bookings（仅文本约定，不发HTTP）。请求含activityId=DEMO-ACTIVITY-01、slotId=DEMO-SLOT-01、attendeeEmail=visitor@example.invalid、idempotencyKey=DEMO-REQUEST-01。
重复同一idempotencyKey返回同一bookingId，不能扣减两次名额。时段容量2，夹具已有1名额，创建后剩余0。

## 响应字段
bookingId=DEMO-BOOKING-001，status=confirmed，remaining=0，source=fixture。容量满时status=rejected，error.code=SLOT_FULL，不创建预约；取消仅改变已有预约status=cancelled并归还一次名额。

## 权限与失败处理
请求邮箱只是安全演示地址；不发邮件。知识引用只读且按项目授权。未授权返回DEMO_PERMISSION_DENIED；越界路径返回DEMO_PATH_REJECTED。网络超时夹具仅用于有限重试，不进行真实请求。

## 验收与未知
AC：重复请求只产生一个预约号；满员拒绝不改变容量；取消幂等；无权不能读取文档。真实并发、延时、实际token与费用均未知。任务成功必须附当前冻结需求/设计/AC修订证据，待用户验收。
`;
  const guide=`# 研发交付指南

## 需求确认
预约服务用于虚构社区活动，不是生产记录。确认报名、满额拒绝、取消和幂等范围；不包含付款、短信、真实邮箱或生产发布。
保留DEMO-PROJECT-01研发项目、DEMO-WORK-01办公项目，文档与预约接口约定同源。${rules}
## 技术交付
DEMO契约先交付，前后端消费同一修订后并行；集成串行。失败前置不能释放后代，独立审计可继续。日志、代码片段、SHA与CLI版本都为样例。
交付包列出冻结范围、逐AC结果、失败尝试、接口约定、恢复办法和未知实测，不覆盖用户草稿。

## 评审与验收
评审核对幂等与容量、取消回补、只读授权和秘密零落盘。验收只接受当前有效产物；默认终点“待验收”，本页不代替用户批准。

## 故障夹具与恢复
network-retry：一次暂时故障；retry-exhausted：持续故障到限；verify-rework：验证失败一次；demo-offline：主机离线；空库demo-empty；读取失败及撤权在知识管理演示。不接真实安装、SSH或外部目录。
`;
  const readme=`# 预约服务 · 离线工作区样例

${contract}
## 交付操作
在需求页派发合格DEMO故事，任务页观察依赖/有限重试；设计页保存草稿后明确同步。编码文件可保存本机草稿，Git按钮仅更改本机样例。交付指南位于知识库demo-handbook中的guide；接口约定位于contract。

${rules}`;
  const metrics={source:'CR022固定夹具；未连接/未授权时未知',cpuCores:[16,24,32,24],memory:{totalMiB:8192,usedMiB:3072,freeMiB:4096,buffCacheMiB:1024,availableMiB:5120,sharedMiB:64},disk:{totalGiB:80,usedGiB:33.6},load:[0.36,0.28,0.22],uptimeDays:12};
  const cpuPct=()=>metrics.cpuCores.reduce((a,b)=>a+b,0)/metrics.cpuCores.length;
  const memoryPct=()=>metrics.memory.usedMiB/metrics.memory.totalMiB*100;
  const terminal=()=>{const m=metrics.memory,gi=v=>(v/1024).toFixed(2)+'Gi';return {help:'支持 uptime / free -h / df -h；固定夹具，不执行shell',uptime:`up ${metrics.uptimeDays} days · load ${metrics.load.join(', ')}`,'free -h':`              total    used    free   shared  buff/cache  available\nMem:          ${gi(m.totalMiB)}  ${gi(m.usedMiB)}  ${gi(m.freeMiB)}  ${gi(m.sharedMiB)}     ${gi(m.buffCacheMiB)}     ${gi(m.availableMiB)}\n样例：used/total=${memoryPct().toFixed(1)}%；未读取/proc`,'df -h':`/dev/demo ${metrics.disk.totalGiB}G ${metrics.disk.usedGiB}G ${(metrics.disk.usedGiB/metrics.disk.totalGiB*100).toFixed(0)}%`};};
  const workspace={
    fixtureVersion:'UI-CR022-v1',projects:[{id:'DEMO-PROJECT-01',name:'预约服务',kind:'code',owner:'林澈',description:'社区活动预约：幂等、容量、取消回补及交付追溯'},{id:'DEMO-WORK-01',name:'市场研究资料',kind:'work',owner:'陈雨',description:'预约场景调研与办公产物预览'}],
    files:[{name:'README.md',text:readme,baseline:'# 预约服务\n',staged:false},{name:'src/booking.ts',text:`// 虚构预约样例；不联网，不写正式源码\nexport const fixtureBooking = { bookingId: 'DEMO-BOOKING-001', status: 'confirmed', remaining: 0, source: 'fixture' };\n// 幂等键DEMO-REQUEST-01重放返回同一预约；满额拒绝不扣减。`,baseline:'export const booking = {};',staged:false},{name:'AGENTS.md',text:rules,baseline:rules,staged:false}],
    branches:['main','feature/booking'],branch:'main',commits:[],designs:{},
    libraries:[{id:'demo-handbook',name:'研发手册',description:'预约的交付指南、只读授权与接口约定',noteIds:['guide','contract'],sourceRef:'docs/knowledge/handbook',enabled:true,revision:1,scan:'ready'},{id:'demo-empty',name:'待整理资料',description:'空知识库导航样例，扫描结果0篇不是读取失败',noteIds:[],sourceRef:'docs/knowledge/empty',enabled:true,revision:1,scan:'empty'}],
    notes:[{id:'guide',title:'研发交付指南',path:'流程/交付.md',text:guide},{id:'contract',title:'预约接口约定',path:'接口/预约.md',text:contract}],
    servers:[{id:'demo-staging',name:'预约服务 · 测试',host:'ops@192.0.2.24',address:'192.0.2.24',username:'ops',port:22,group:'测试',auth:'password',credentialRef:'DEMO-CREDENTIAL-PASSWORD',online:true,connected:false,authorized:false,output:'尚未连接本机主机样例。'},{id:'demo-offline',name:'归档 · 开发',host:'ops@198.51.100.28',address:'198.51.100.28',username:'ops',port:22,group:'开发',auth:'key-file',credentialRef:'DEMO-KEY-FILE-01',online:false,connected:false,authorized:false,output:'主机样例离线。'}],
    office:[{name:'研究计划.md',text:'# 虚构预约场景研究计划\n\n比较活动名额、幂等和取消提示，不采集真实报名者。所有结论为夹具；真实效果未知。'},{name:'会议纪要.docx',text:'会议纪要（结构预览样例，非真实Office文件）\n范围：虚构预约、容量2、重复请求不重复扣减；不含付款与通知。\n来源：DEMO-WORK-01调研夹具；结论待人工评审。'}],
    skills:[{name:'拆解需求',slug:'requirement-split',description:'按预约业务拆分唯一归属Story与可观察AC',content:rules,on:true},{name:'代码审查',slug:'booking-review',description:'检查幂等、容量和秘密零落盘',content:'# 预约代码审查\n\n核对重复请求、取消回补、无权拒绝与失败证据。只给建议，不执行正式修改。',on:true}],
    mcp:[{name:'workspace-files',transport:'stdio',command:'DEMO-COMMAND',args:'["DEMO-DIRECTORY/project"]',env:'{"DEMO_MODE":"offline"}',on:true},{name:'knowledge-gateway',transport:'http',url:'https://knowledge.demo.invalid/mcp',on:true}],tools:[{name:'文件读取',risk:'low',description:'只读当前DEMO受管目录',on:true},{name:'构建验证',risk:'medium',description:'TaskRuntime验证权限演示；不运行正式构建',on:true},{name:'ssh-exec-demo',risk:'high',description:'高风险逐次审批，仅说明不执行',on:false}],profile:{name:'林澈',email:'demo@example.invalid'}
  };
  const stock={providers:[{id:'DEMO-PROVIDER-01',name:'预约文本供应商 · DEMO',protocol:'anthropic',enabled:true,keys:[{label:'主凭证',ref:'DEMO-CREDENTIAL-01',on:true,default:true,models:'DEMO-TEXT-01'},{label:'备用凭证',ref:'DEMO-CREDENTIAL-02',on:true,default:false,models:'全部模型'}],endpoints:[{protocol:'anthropic',url:'https://api.demo.invalid/v1',on:true},{protocol:'anthropic',url:'https://backup.demo.invalid/v1',on:true}],models:[{id:'DEMO-TEXT-01',name:'预约推理模型',text:true,vision:true,imageGen:false,efforts:{off:'off',low:'low',medium:'medium',high:'high'},defaultEffort:'medium',contextWindow:'128K',maxTokens:'16K'}],headers:[{name:'X-DEMO-Client',value:'offline-review'}],spoof:'off',timeout:30,concurrency:2,retries:1,proxy:'',fingerprints:{}}],sdks:[{id:'claude',version:'DEMO-v1.0',target:'DEMO-v1.1',installed:true,enabled:true,path:'DEMO-CLI/claude'},{id:'codex',version:'DEMO-v1.0',target:'DEMO-v1.1',installed:true,enabled:true,path:'DEMO-CLI/codex'},{id:'grok',version:null,target:'DEMO-v1.1',installed:false,enabled:false,path:null}],registry:'https://registry.demo.invalid/',jobs:[],grants:{'DEMO-PROJECT-01':['demo-handbook'],'DEMO-WORK-01':[]},grantRevision:1};
  const sources=[
    {kind:'repository-rule-excerpt',path:'AGENTS.md',sha256:'2685D393FBF91F9E62FC5D74B49358E11286A53C4CD03B5D6BC458FC40BC62D7',adopted:'2026-11-19 CR024目录归类后出处复核',quote:'默认工作边界（强制）：用户未明确要求“写代码、实现功能、修改正式软件、按设计开发”等编码动作时，所有产品诉求、界面调整、优化和问题反馈均只按需求／设计调整处理。',fields:['repo规则摘要（不是替代正文）']},
    {kind:'repository-story-excerpt',path:'docs/Plan/Story/STORY-029-模型供应商配置正式实现.md',sha256:'3EE573F8CA04611F8F8DE1171172033BBDD94002059E0BD78CB995A9BE26C003',quote:'text 与 imageGen 互斥、默认档位必须来自已配置档位，违反时报错不落库。'},
    {kind:'repository-story-excerpt',path:'docs/Plan/Story/STORY-030-CLI-SDK管理正式实现.md',sha256:'0CE498C08DDB0D69117270C29FEBED5168529BEC104A9D58BED1324DCDFA528F',quote:'单 SDK 同时仅一个任务，重复发起被拒绝（409 语义）。'},
    {kind:'repository-story-excerpt',path:'docs/Plan/Story/STORY-031-Skill-MCP-Tool能力管理正式实现.md',sha256:'BDF6281259E8ACB62437912FD8915D78BB2BCBB70885156DD21598F009716C9E',quote:'MCP 重复名拒绝；stdio 缺 command、http 缺 url 报错。'},
    {kind:'repository-story-excerpt',path:'docs/Plan/Story/STORY-035-服务器管理正式实现.md',sha256:'4AF0E2CCCFAF84F01132773A202E4835434EF8097FA9B202DAB5079C8465C73C',quote:'连接失败保留原因与重试入口；列表连接状态如实显示。',excluded:'不包含known_hosts；none不是本次需求'},
    {kind:'repository-story-excerpt',path:'docs/Plan/Story/STORY-036-知识库正式实现.md',sha256:'8D8797CF46BC4877D3320B7E11A03773BF36AFAF1C950DD1D95E5A4308A4E9A0',quote:'撤权后 gateway_search/read 立即拒绝，已显示内容不受影响。'},
    {kind:'fictional-business-fixture',version:'UI-CR022-v1',fields:['项目与人员','预约号/邮箱/域名/IP','知识正文业务内容','主机指标与终端输出','供应商/模型/CLI版本'],note:'全部虚构；不采集生产或私人记录。安全邮箱.invalid，IP RFC5737，秘密只占位。'},
    {kind:'synthetic-failure',version:'UI-CR022-v1',fields:['网络/验证/扫描/发现错误','作业与授权DEMO'],note:'固定故障与执行仿真，不是真实调用记录。'},
    {kind:'unknown-measurement',fields:['真实SSH/安装/连通','实际并发与延迟','真实token/费用','正式软件视觉一致性'],value:'未实测/未知'}
  ];
  root.WorkbenchSampleFixtures=Object.freeze({sources:()=>copy(sources),version:'UI-CR022-v1',createWorkspace:()=>copy(workspace),createStock:()=>copy(stock),metrics:()=>copy(metrics),cpuPct,memoryPct,terminal,contract,guide,rules});
})(window);
