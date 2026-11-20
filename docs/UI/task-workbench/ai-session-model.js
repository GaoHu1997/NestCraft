/* UI-CR019-v1-r3：纯设计数据/白名单参数解析。没有真实CLI、网络、文件或数据库执行。 */
(() => {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const known = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const names = {default:'默认模式',plan:'规划模式',agent:'代理模式',auto:'自动审批',full:'全自动'};
  const descriptions = {
    default:'逐操作人工审批；需要宿主审批通道',plan:'只读分析；越界拒绝，不自动升级',
    agent:'工作区编辑；其他操作受工具策略约束',auto:'原生智能审批，须版本/模型/策略核验',full:'跳过审批与沙箱；必须已验证隔离并确认风险'
  };
  function createConfig() {
    const config = {
      revision:1, source:'demo', host:{approvalTransport:false,isolationVerified:false,autoVerified:false,managedRestrictions:true,toolGate:true,sandboxSupported:true},
      sdks:[
        {cliId:'codex',name:'Codex CLI',installed:true,enabled:true,version:'DEMO-verified',protocols:['openai'],nativeEvidence:true,nativeToolRestrictionsVerified:false,sandboxAvailableVerified:false,capabilityRevision:1,verificationSource:'demo-unverified',effortCapabilities:{version:'DEMO-verified',revision:1,verified:true,nativeValues:['low','medium','high','xhigh']}},
        {cliId:'claude',name:'Claude Code',installed:true,enabled:true,version:'DEMO-verified',protocols:['anthropic'],nativeEvidence:true,nativeToolRestrictionsVerified:false,sandboxAvailableVerified:false,capabilityRevision:1,verificationSource:'demo-unverified',effortCapabilities:{version:'DEMO-verified',revision:1,verified:true,nativeValues:['low','medium','high','max']}},
        {cliId:'grok',name:'Grok CLI',installed:false,enabled:true,version:null,protocols:['openai'],nativeEvidence:false,nativeToolRestrictionsVerified:false,sandboxAvailableVerified:false,capabilityRevision:1,verificationSource:'unknown',effortCapabilities:{verified:false,nativeValues:[]}}
      ],
      providers:[
        {id:'demo-openai',name:'OpenAI',protocol:'openai',enabled:true,usableEndpoint:true,usableKey:true,models:[
          {id:'demo-coder',name:'CODER',contextLimit:922000,text:true,vision:true,imageOnly:false,efforts:['Low','Medium','High','Xhigh'],effortMapping:{Low:'low',Medium:'medium',High:'high',Xhigh:'xhigh'},defaultEffort:'High'},
          {id:'demo-general',name:'GENERAL',contextLimit:1000000,text:true,vision:false,imageOnly:false,efforts:[],effortMapping:{},defaultEffort:null},
          {id:'demo-image',name:'IMAGE-ONLY',contextLimit:null,text:false,vision:true,imageOnly:true,efforts:[],effortMapping:{}}
        ]},
        {id:'demo-openai-alt',name:'OpenAI 备用',protocol:'openai',enabled:true,usableEndpoint:true,usableKey:true,models:[
          {id:'demo-audit',name:'AUDIT',contextLimit:128000,text:true,vision:false,imageOnly:false,efforts:['Low','High'],effortMapping:{Low:'low',High:'high'},defaultEffort:'Low'}
        ]},
        {id:'demo-anthropic',name:'Anthropic',protocol:'anthropic',enabled:true,usableEndpoint:true,usableKey:true,models:[
          {id:'demo-reviewer',name:'REVIEWER',contextLimit:200000,text:true,vision:true,imageOnly:false,efforts:['Low','Medium','High','Max'],effortMapping:{Low:'low',Medium:'medium',High:'high',Max:'max'},defaultEffort:'High'}
        ]}
      ]
    };
    for(const sdk of config.sdks)sdk.permissionCapabilities={verified:false,verifiedVersion:sdk.version,revision:sdk.capabilityRevision,flags:sdk.cliId==='claude'?['--permission-mode','--tools','--disallowedTools']:['--sandbox','-c','--dangerously-bypass-approvals-and-sandbox']};
    return config;
  }
  function installedClis(config) { return config.sdks.filter(s=>s.installed===true && s.enabled===true && ['codex','claude','grok'].includes(s.cliId)); }
  function modelCandidates(config,cliId) {
    const sdk=installedClis(config).find(s=>s.cliId===cliId); if(!sdk)return [];
    return config.providers.filter(p=>p.enabled && p.usableEndpoint && p.usableKey && sdk.protocols.includes(p.protocol)).flatMap(p=>p.models.filter(m=>m.text && !m.imageOnly).map(m=>({provider:p,model:m})));
  }
  const supportedCli = cli => ['codex','claude','grok'].includes(cli);
  function sessionBusy(s) { return !!(s.running || s.awaitingUser || s.stopPending || s.pendingDecision?.status==='pending' || (s.agents||[]).some(a=>!['completed','failed','cancelled','succeeded'].includes(a.status))); }
  function finishAgents(s,status='completed') { if(!['completed','cancelled','failed'].includes(status))return {ok:false};for(const a of s.agents||[])if(!['completed','failed','cancelled','succeeded'].includes(a.status)){a.status=status;a.endMs=Date.now();}return {ok:true,source:'demo'}; }
  function makeContext(s,candidate,extra={}) { const model=candidate?.model;return {sessionId:s.id,providerId:s.providerId,modelId:s.modelId,modelConfigRevision:model?.revision||1,tokenizerId:model?.tokenizerId||('demo:'+s.modelId),inputRevision:s.inputRevision||0,permissionRevision:s.permissionRevision,used:null,limit:model?.contextLimit??null,system:null,toolDefinitions:null,messages:null,source:'unknown',revision:(s.context?.revision||0)+1,...extra}; }
  function createSession(scope,id,config,cliId='codex') {
    const candidate=modelCandidates(config,cliId)[0];
    return {id,scope,title:'新会话',draft:'',refs:[],messages:[],cliId,providerId:candidate?.provider.id||null,modelId:candidate?.model.id||null,effort:candidate?.model.defaultEffort||null,permissionId:'plan',permissionRevision:1,inputRevision:0,modelConfigRevision:1,activeLaunchSpec:null,running:false,awaitingUser:false,pendingDecision:null,decisionHistory:[],eventRevision:0,readRevision:0,outcome:null,todos:[],goal:null,goalHistory:[],agents:[],requests:[],context:{sessionId:id,providerId:candidate?.provider.id||null,modelId:candidate?.model.id||null,modelConfigRevision:1,tokenizerId:'demo:'+(candidate?.model.id||null),inputRevision:0,permissionRevision:1,used:null,limit:candidate?.model.contextLimit||null,system:null,toolDefinitions:null,messages:null,source:'unknown',revision:0},error:null};
  }
  function resolvePermission(cliId,permissionId,config,confirmed=false){
 const sdk=config?.sdks?.find(s=>s.cliId===cliId),host=config?.host||{};
 const base={ok:false,cliId,permissionId,argv:[],toolPolicy:null,sandboxPolicy:null,approvalPolicy:null,requirements:[],source:'demo'};const fail=reason=>({...base,reason});
 if(!supportedCli(cliId))return fail('未知CLI，拒绝映射为其它执行器');
 if(!Object.hasOwn(names,permissionId))return fail('未知权限类型，拒绝生成参数');
 if(!sdk?.installed||!sdk.enabled)return fail('SDK未安装或已停用，不能生成执行配置');
 if(cliId==='grok')return fail('Grok原生权限参数未核实，所有模式待核验');
 const proof=sdk.permissionCapabilities;
 if(!sdk.nativeEvidence||!sdk.version||!proof?.verified||proof.verifiedVersion!==sdk.version||proof.revision!==sdk.capabilityRevision)return fail('SDK 版本或能力证据尚未验证或已失效，请重新核验');
 if(!host.managedRestrictions)return fail('托管策略禁止该执行配置');
 if(permissionId==='default')return fail(cliId==='codex'?'Codex exec没有逐操作人工审批传输，不能兑现默认模式':'宿主没有真实人工审批通道，不能兑现default');
 if(permissionId==='auto')return fail('原生auto的版本/模型/组织策略/审批分类器未实测，不能以never或dontAsk冒充');
 const required=cliId==='claude'?['--permission-mode',...(permissionId==='full'?[]:['--tools','--disallowedTools'])]:permissionId==='full'?['--dangerously-bypass-approvals-and-sandbox']:['--sandbox','-c'];
 if(!required.every(f=>proof.flags?.includes(f)))return fail('当前SDK版本未核验所需原生限制参数');
 if(permissionId==='full'){
  if(!host.isolationVerified)return fail('未验证隔离环境，全自动禁用');
  if(!confirmed)return {...base,requiresConfirmation:true,reason:'需要二次确认跳过原生审批的风险'};
  return {...base,ok:true,argv:cliId==='claude'?['--permission-mode','bypassPermissions']:['--dangerously-bypass-approvals-and-sandbox'],toolPolicy:'managed-isolated',nativeToolPolicy:{kind:'bypass-in-demo-isolation'},sandboxPolicy:'external-isolation',approvalPolicy:'bypass',capabilityRevision:sdk.capabilityRevision,verificationSource:sdk.verificationSource,requirements:['隔离已验证样例','托管允许','显式危险确认']};
 }
 if(!host.toolGate)return fail('宿主缺少受管工具边界');
 if(cliId==='claude'&&!sdk.nativeToolRestrictionsVerified)return fail('Claude原生内置工具限制未验证，外层ToolGate不能代替原生限制');
 if(cliId==='codex'&&(!host.sandboxSupported||!sdk.sandboxAvailableVerified))return fail('Codex原生OS沙箱可用性尚未验证');
 const plan=permissionId==='plan',tools=plan?['Read','Glob','Grep']:['Read','Glob','Grep','Edit','Write'];
 return {...base,ok:true,argv:cliId==='claude'?['--permission-mode',plan?'plan':'acceptEdits','--tools',tools.join(','),'--disallowedTools','mcp__*']:['--sandbox',plan?'read-only':'workspace-write','-c','approval_policy="never"'],toolPolicy:plan?'read-only':'managed-workspace-edit',nativeToolPolicy:cliId==='claude'?{kind:'verified-builtins-and-mcp-deny-demo',tools,deniedMcp:['mcp__*']}:{kind:'verified-os-sandbox-demo'},sandboxPolicy:cliId==='claude'?'原生工具集合与MCP拒绝；权限模式不是OS沙箱':plan?'read-only':'workspace-write',approvalPolicy:cliId==='claude'?'未许可操作拒绝执行':'never（越界拒绝，不升级）',capabilityRevision:sdk.capabilityRevision,verificationSource:sdk.verificationSource,requirements:['版本与能力证据匹配','已核验原生工具/沙箱限制DEMO']};
}
  function resolveEffort(cliId,detectedVersion,modelId,uiEffort,modelMapping,cliCapabilities) {
    const cap=cliCapabilities?.effortCapabilities,base={ok:false,nativeEffortArgv:[],effortCapabilityRevision:cap?.revision||0,verificationSource:cliCapabilities?.verificationSource||'unknown'};
    if(!supportedCli(cliId))return {...base,reason:'未知CLI，拒绝思考参数映射'};
    if(!uiEffort)return {...base,ok:true,nativeValue:null};
    if(!cap?.verified||cap.version!==detectedVersion||!cliCapabilities?.nativeEvidence)return {...base,reason:'CLI版本思考能力未核验或版本不匹配'};
    const value=modelMapping?.[uiEffort];
    const modelIds=cliId==='codex'?['demo-coder','demo-audit','demo-general']:cliId==='claude'?['demo-reviewer']:[];
    if(!modelIds.includes(modelId)||!value||!cap.nativeValues?.includes(value))return {...base,reason:'UI档位没有当前CLI+版本+模型的已声明原生映射'};
    return {...base,ok:true,nativeValue:value,nativeEffortArgv:cliId==='codex'?['-c',`model_reasoning_effort="${value}"`]:['--effort',value]};
  }
  function buildLaunchSpec(session,config) {
    if(sessionBusy(session))return {ok:false,reason:'运行或等待用户处理时配置锁定'};
    const candidate=modelCandidates(config,session.cliId).find(x=>x.provider.id===session.providerId && x.model.id===session.modelId);
    if(!candidate)return {ok:false,reason:'所选SDK/供应商/模型已不可用或协议不兼容；保留原选择，请修复'};
    if(session.effort && (!candidate.model.efforts.includes(session.effort)||!candidate.model.effortMapping[session.effort]))return {ok:false,reason:'模型未声明该思考档位或原生映射'};
    const sdk=config.sdks.find(s=>s.cliId===session.cliId),resolvedEffort=resolveEffort(session.cliId,sdk?.version,session.modelId,session.effort,candidate.model.effortMapping,sdk);
    if(!resolvedEffort.ok)return resolvedEffort;
    const permission=resolvePermission(session.cliId,session.permissionId,config,session.fullConfirmedRevision===config.revision);
    if(!permission.ok)return permission;
    const argv=[...(session.cliId==='codex'?['exec']:['-p']),...permission.argv,'--model',candidate.model.name,...resolvedEffort.nativeEffortArgv];
    return {ok:true,cliId:session.cliId,providerId:session.providerId,modelId:session.modelId,effort:session.effort,permissionId:session.permissionId,permissionRevision:session.permissionRevision,capabilityRevision:permission.capabilityRevision,argv,nativeEffortArgv:resolvedEffort.nativeEffortArgv,effortCapabilityRevision:resolvedEffort.effortCapabilityRevision,verificationSource:permission.verificationSource||resolvedEffort.verificationSource,scope:session.scope,toolPolicy:permission.toolPolicy,nativeToolPolicy:permission.nativeToolPolicy||{kind:'bypass-in-demo-isolation'},sandboxPolicy:permission.sandboxPolicy,approvalPolicy:permission.approvalPolicy,requirements:permission.requirements,source:'demo'};
  }
  function selectPermission(session,id,config,confirmed=false) {
    if(sessionBusy(session))return {ok:false,reason:'运行或待处理时不能修改权限'};
    const result=resolvePermission(session.cliId,id,config,confirmed);if(!result.ok)return result;
    session.permissionId=id;session.permissionRevision++;session.inputRevision=(session.inputRevision||0)+1;session.context=makeContext(session,modelCandidates(config,session.cliId).find(x=>x.provider.id===session.providerId&&x.model.id===session.modelId));session.fullConfirmedRevision=confirmed?config.revision:null;return {ok:true,permission:result};
  }
  function selectModel(session,providerId,modelId,config) {
    if(sessionBusy(session))return {ok:false,reason:'运行或待处理时不能修改模型'};
    const candidate=modelCandidates(config,session.cliId).find(x=>x.provider.id===providerId&&x.model.id===modelId);
    if(!candidate)return {ok:false,reason:'模型不可用或与当前CLI协议不兼容'};
    const changed=session.providerId!==providerId||session.modelId!==modelId;session.providerId=providerId;session.modelId=modelId;session.effort=candidate.model.defaultEffort||null;if(changed){session.inputRevision=(session.inputRevision||0)+1;session.modelConfigRevision=candidate.model.revision||1;session.context=makeContext(session,candidate);}return {ok:true};
  }
  function addRequest(session,request){
 if(!request.requestId||request.rootSessionId!==session.id||!request.ownerSessionId)return {ok:false,reason:'请求缺少稳定ID或归属错误'};
 const old=session.requests.find(x=>x.requestId===request.requestId);if(!old){session.requests.push(clone(request));return {ok:true};}
 if(old.rootSessionId!==request.rootSessionId||old.ownerSessionId!==request.ownerSessionId||(request.parentSessionId!==undefined&&old.parentSessionId!==request.parentSessionId))return {ok:false,reason:'请求归属冲突'};
 const oldRevision=old.revision||0,newRevision=request.revision||0;
 for(const [key,value] of Object.entries(request))if(!['source','revision'].includes(key)&&known(old[key])&&known(value)&&old[key]!==value&&newRevision<=oldRevision)return {ok:false,reason:'已知字段覆盖需要更高修订'};
 const next={...old};let changed=false;
 for(const [key,value] of Object.entries(request)){if(value===null&&known(old[key])&&newRevision<=oldRevision)continue;if(JSON.stringify(next[key])!==JSON.stringify(value)){next[key]=clone(value);changed=true;}}
 if(!changed)return {ok:true,replayed:true};
 const retained=Object.keys(old).some(k=>known(old[k])&&!Object.hasOwn(request,k));
 if(retained&&request.source&&old.source!==request.source)next.source='mixed';
 Object.assign(old,next);return {ok:true,updated:true};
}
  function aggregateUsage(session,ledger=session.requests,ownerId=null) {
    const rows=[...new Map(ledger.filter(r=>r.rootSessionId===session.id && (!ownerId||r.ownerSessionId===ownerId)).map(r=>[r.requestId,r])).values()];
    const meta=list=>{const sources=[...new Set(list.map(r=>r.source||'unknown'))];return {sources,sourceStatus:sources.length>1?'mixed':sources[0]||'unknown'};};
    const metric=(fields)=>{const knownFields=rows.flatMap(r=>fields.map(f=>r[f])).filter(known),expected=rows.length*fields.length;return {value:expected&&knownFields.length===expected?knownFields.reduce((a,b)=>a+b,0):null,knownValue:knownFields.length?knownFields.reduce((a,b)=>a+b,0):null,coverage:{known:knownFields.length,expected},...meta(rows)};};
    const metrics={};for(const field of ['uncachedInput','cacheRead','cacheWrite','output','modelMs','toolMs','steps'])metrics[field]=metric([field]);metrics.total=metric(['uncachedInput','cacheRead','cacheWrite','output']);
    const inputMetric=metric(['uncachedInput','cacheRead','cacheWrite']),sampleInputRows=rows.filter(r=>['uncachedInput','cacheRead','cacheWrite'].every(f=>known(r[f]))),sampleInput=sampleInputRows.reduce((a,r)=>a+r.uncachedInput+r.cacheRead+r.cacheWrite,0),sampleRead=sampleInputRows.reduce((a,r)=>a+r.cacheRead,0);
    metrics.cacheHit={value:inputMetric.value>0?metrics.cacheRead.value/inputMetric.value:null,knownValue:sampleInput>0?sampleRead/sampleInput:null,coverage:inputMetric.coverage,...meta(rows)};
    const generated=rows.filter(r=>r.output!==0),pairs=generated.filter(r=>known(r.output)&&known(r.generationMs)&&r.generationMs>0),pairSeconds=pairs.reduce((a,r)=>a+r.generationMs/1000,0);
    metrics.tps={value:pairSeconds>0?pairs.reduce((a,r)=>a+r.output,0)/pairSeconds:null,knownValue:pairSeconds>0?pairs.reduce((a,r)=>a+r.output,0)/pairSeconds:null,coverage:{known:pairs.length,expected:generated.length},...meta(pairs.length?pairs:rows)};
    const firstTokens=generated.filter(r=>known(r.ttftMs));metrics.ttftMs={value:firstTokens.length?firstTokens.reduce((a,r)=>a+r.ttftMs,0)/firstTokens.length:null,knownValue:firstTokens.length?firstTokens.reduce((a,r)=>a+r.ttftMs,0)/firstTokens.length:null,coverage:{known:firstTokens.length,expected:generated.length},...meta(firstTokens.length?firstTokens:rows)};
    const overall=meta(rows);
    return {requestCount:rows.length,rounds:session.messages.filter(m=>m.role==='user').length,steps:rows.length?metrics.steps.value:0,uncachedInput:metrics.uncachedInput.value,cacheRead:metrics.cacheRead.value,cacheWrite:metrics.cacheWrite.value,output:metrics.output.value,total:metrics.total.value,cacheHit:metrics.cacheHit.value,modelMs:metrics.modelMs.value,toolMs:metrics.toolMs.value,ttftMs:metrics.ttftMs.value,tps:metrics.tps.value,metrics,source:overall.sourceStatus,sources:overall.sources,sourceStatus:overall.sourceStatus};
  }
  function contextUsage(session){
 const c=session.context||{},bound=c.sessionId===session.id&&c.providerId===session.providerId&&c.modelId===session.modelId&&c.inputRevision===(session.inputRevision||0)&&c.permissionRevision===session.permissionRevision&&c.modelConfigRevision===(session.modelConfigRevision||1);
 const parts=bound?[c.system,c.toolDefinitions,c.messages]:[null,null,null],coherent=bound&&parts.every(known)&&known(c.used)&&parts.reduce((a,b)=>a+b,0)===c.used;
 return {...clone(c),system:parts[0],toolDefinitions:parts[1],messages:parts[2],used:coherent?c.used:null,knownUsed:parts.filter(known).reduce((a,b)=>a+b,0),coverage:{known:parts.filter(known).length,expected:3},sourceStatus:bound?c.source||'unknown':'unknown',coherent,percent:coherent&&known(c.limit)&&c.limit>0?c.used/c.limit:null,reason:bound?null:'模型或输入窗口已改变，等待重估'};
}
  function recordEvent(session,outcome) { session.eventRevision++;session.outcome=outcome; }
  function markRead(session) { session.readRevision=session.eventRevision; }
  function unreadStatus(session) { return session.eventRevision>session.readRevision?({success:'green',failure:'red',awaiting_user:'yellow'}[session.outcome]||null):null; }
  function updateGoal(session,text) {
    if(!String(text).trim())return {ok:false,reason:'目标不能为空'};
    if(String(text).length>4000)return {ok:false,reason:'目标超过4000字'};
    if(session.goal)session.goalHistory.push(clone(session.goal));
    session.goal={id:session.goal?.id||`${session.id}-goal`,text:String(text).trim(),status:session.goal?.status==='paused'?'paused':'active',revision:(session.goal?.revision||0)+1};return {ok:true};
  }
  function setGoalStatus(session,status,confirmed=false) {
    if(!session.goal)return {ok:false,reason:'没有当前目标'};
    if(!['active','paused','cancelled'].includes(status))return {ok:false,reason:'未知目标状态'};
    if(status==='cancelled'&&!confirmed)return {ok:false,requiresConfirmation:true,reason:'需确认删除目标'};
    session.goalHistory.push(clone(session.goal));session.goal.status=status;session.goal.revision++;return {ok:true};
  }
  function addTodo(session,taskName,status='pending') {
    if(!String(taskName).trim())return {ok:false,reason:'任务名称不能为空'};
    if(!['pending','running','completed','failed','cancelled','awaiting_user'].includes(status))return {ok:false,reason:'未知任务状态'};
    session.todos.push({id:`${session.id}-todo-${session.todos.length+1}`,taskName:String(taskName).trim(),status});return {ok:true};
  }
  function todoSummary(session) { return {completed:session.todos.filter(t=>t.status==='completed').length,running:session.todos.filter(t=>t.status==='running').length,pending:session.todos.filter(t=>['pending','awaiting_user'].includes(t.status)).length,failed:session.todos.filter(t=>t.status==='failed').length,cancelled:session.todos.filter(t=>t.status==='cancelled').length}; }
  function resolveDecision(session,decision,answer='') {
    const p=session.pendingDecision;if(!p||p.status!=='pending')return {ok:false,reason:'没有待处理决策'};
    if(!['confirm','reject','cancel'].includes(decision))return {ok:false,reason:'未知决策'};
    if(decision==='confirm'&&!String(answer).trim())return {ok:false,reason:'请填写资料范围答复'};
    const before=clone(p);session.decisionHistory.push({...before,decision,answer:String(answer).trim()});p.status=decision==='confirm'?'confirmed':decision==='reject'?'rejected':'cancelled';p.answer=String(answer).trim();p.revision++;session.awaitingUser=false;
    session.todos.filter(t=>t.status==='awaiting_user').forEach(t=>t.status=decision==='confirm'?'completed':'cancelled');
    recordEvent(session,decision==='confirm'?'user_confirmed':'cancelled');return {ok:true,decisionId:p.id,revision:p.revision};
  }
  function loadScenario(session,config,kind,now=Date.now()) {
    session.error=null;session.running=false;session.awaitingUser=false;session.todos=[];session.goal=null;session.agents=[];session.requests=[];session.messages=[];
    session.context=makeContext(session,modelCandidates(config,session.cliId).find(x=>x.model.id===session.modelId&&x.provider.id===session.providerId));
    if(['restricted','complete','mixed','isolated','effort-unknown'].includes(kind)){config.sdks.filter(s=>['codex','claude'].includes(s.cliId)).forEach(s=>{s.nativeToolRestrictionsVerified=true;s.sandboxAvailableVerified=true;s.verificationSource='explicit-restricted-demo';s.capabilityRevision++;s.permissionCapabilities.verified=true;s.permissionCapabilities.verifiedVersion=s.version;s.permissionCapabilities.revision=s.capabilityRevision;s.effortCapabilities.revision=s.capabilityRevision;});config.revision++;}
    if(kind==='empty'||kind==='restricted')return;
    if(kind==='effort-unknown'){config.sdks[0].effortCapabilities.verified=false;session.error='当前CLI版本思考能力未知；High等UI标签不能直接下发。';return;}
    if(kind==='no-model'){config.providers.forEach(p=>p.enabled=false);config.revision++;session.error='供应商已停用：所选模型失效，修复配置后重检。';return;}
    if(kind==='sdk-missing'){config.sdks.forEach(s=>s.installed=false);config.revision++;session.error='SDK未安装；原选择保留，不自动换CLI。';return;}
    if(kind==='unknown'){session.messages=[{role:'user',text:'展示未知统计边界'}];session.requests=[{requestId:'unknown-1',rootSessionId:session.id,ownerSessionId:session.id,source:'unknown'}];return;}
    if(kind==='failure'){session.error='会话样例失败：模型认证不可用，需要用户修复。';addTodo(session,'修复供应商认证配置','failed');recordEvent(session,'failure');return;}
    if(kind==='waiting'){session.awaitingUser=true;session.pendingDecision={id:`${session.id}-decision-1`,revision:1,status:'pending',question:'请确认本次资料仅限当前项目授权范围，并说明可以使用的资料边界。此确认不是CLI工具审批，也不授予权限。'};addTodo(session,'确认资料使用边界','awaiting_user');updateGoal(session,'等待用户明确本次资料范围后继续');recordEvent(session,'awaiting_user');return;}
    if(kind==='permission-unknown'){session.cliId='grok';config.sdks.find(s=>s.cliId==='grok').installed=true;config.revision++;session.error='Grok已安装样例，但原生权限未知，所有模式拒绝。';return;}
    if(kind==='isolated'){config.host.isolationVerified=true;config.revision++;session.error='DEMO隔离能力已标记可核验，仅用于危险确认设计评审，不代表当前机器事实。';return;}
    updateGoal(session,'根据用户反馈完善AI会话控制：任务与目标、统计归因、历史子任务和CLI权限契约，并形成完整评审证据。');
    [['补齐会话输入与头部布局','completed'],['核对权限与CLI支持矩阵','running'],['补全用量归因与统计','running'],['检查窄屏浮层交互','running'],['确认最终设计与验收范围','awaiting_user']].forEach(([n,s])=>addTodo(session,n,s));
    session.messages=[{role:'user',text:'补齐任务目标、用量统计和真实权限映射设计。'},{role:'assistant',text:'已拆分独立子任务，统计按requestId归因；所有数字均为显式DEMO，不表示真实CLI运行。'},{role:'user',text:'请保留完整任务名称和未读状态。'}];
    session.agents=[{executor:'DSH',id:`${session.id}-agent-1`,rootSessionId:session.id,taskName:'核对权限与CLI支持矩阵',status:'running',startMs:now-359000,endMs:null,requestIds:['demo-child-1'],output:'核对Codex read-only/workspace-write与Claude plan/acceptEdits；Grok权限仍未知。'},{executor:'claude',id:`${session.id}-agent-2`,rootSessionId:session.id,taskName:'补全用量归因与统计',status:'completed',startMs:now-494000,endMs:now-100000,requestIds:['demo-child-2'],output:'互斥缓存字段聚合，子请求去重，父上下文快照不累计子窗口。'},{executor:'DSH',id:`${session.id}-agent-3`,rootSessionId:session.id,taskName:'检查窄屏浮层交互与键盘可达性',status:'awaiting_user',startMs:null,endMs:null,requestIds:[],output:'等待用户确认窄屏显示；耗时和token未知，不显示为0。'}];
    const req=(id,owner,values)=>({requestId:id,rootSessionId:session.id,ownerSessionId:owner,parentSessionId:owner===session.id?null:session.id,source:'demo',...values});
    session.requests=[req('demo-root-1',session.id,{uncachedInput:57,cacheRead:700000,cacheWrite:80000,output:3000,modelMs:180000,toolMs:100000,ttftMs:11200,generationMs:45000,steps:8}),req('demo-child-1',session.agents[0].id,{uncachedInput:40,cacheRead:450000,cacheWrite:40000,output:3000,modelMs:90000,toolMs:95000,ttftMs:8000,generationMs:50000,steps:5}),req('demo-child-2',session.agents[1].id,{uncachedInput:30,cacheRead:350000,cacheWrite:30000,output:2500,modelMs:89000,toolMs:80000,ttftMs:14400,generationMs:44000,steps:5})];
    session.context=makeContext(session,modelCandidates(config,session.cliId).find(x=>x.model.id===session.modelId&&x.provider.id===session.providerId),{used:111600,system:3000,toolDefinitions:18000,messages:90600,source:'demo'});
    if(kind==='mixed'){session.requests[0].source='measured';session.requests[1].source='estimated';session.requests[1].output=null;session.requests[1].ttftMs=null;session.requests[2].generationMs=null;session.requests[2].cacheWrite=null;session.context.messages=null;session.context.source='estimated';}
  }
  globalThis.AiSessionModel=Object.freeze({clone,names,descriptions,known,sessionBusy,finishAgents,makeContext,createConfig,installedClis,modelCandidates,createSession,resolvePermission,resolveEffort,buildLaunchSpec,selectPermission,selectModel,addRequest,aggregateUsage,contextUsage,recordEvent,markRead,unreadStatus,updateGoal,setGoalStatus,addTodo,todoSummary,resolveDecision,loadScenario});
})();
