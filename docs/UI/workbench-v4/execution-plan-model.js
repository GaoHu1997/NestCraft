/* UI-CR026-v1：纯DEMO政策推演。客户端指纹/证据不是可信安全签名，不执行任何宿主能力。 */
(function(root){
'use strict';
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function fingerprint(x){let h=2166136261;for(const c of stable(x)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return 'DEMO-'+(h>>>0).toString(16).padStart(8,'0');}
const list=x=>Array.isArray(x)?x:[],id=x=>x?.id||x?.stableId||x?.cliId;
const find=(xs,key)=>list(xs).find(x=>id(x)===key);
const available=x=>!!x&&x.enabled!==false&&x.revoked!==true;
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x),nonempty=x=>typeof x==='string'&&x.trim().length>0;
const count=x=>Number.isSafeInteger(x)&&x>=0;
const ranks={plan:0,read:0,agent:1,write:1,full:2},difficulties=['low','medium','high','extreme'];
// 明确DEMO supported才可推演；screenshot版本/客户端真安全自报均不能证明原生能力。
const evidence=x=>available(x)&&x?.capabilityEvidence?.status==='supported'&&(x.capabilityEvidence.source==='demo'||(!x.capabilityEvidence.source&&x.source==='demo'))&&x.capabilityEvidence.revision!==undefined;
const evidenceRef=x=>({id:id(x),revision:x?.revision??null,source:x?.source??null,capabilityEvidence:clone(x?.capabilityEvidence)});
const lock=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(lock);Object.freeze(x);}return x;};
function normalizedPath(path){
 if(!nonempty(path)||/[\x00-\x1f\x7f]/.test(path)||/^[\\/]|^[a-z]:/i.test(path)||/[<>:"|?*%]/.test(path))return null;
 const p=path.replaceAll('\\','/');const parts=p.split('/');
 if(parts.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))return null;
 return p;
}
const safePath=p=>normalizedPath(p)!==null;
function rootPath(path){if(typeof path!=='string')return null;return normalizedPath(path.replace(/[/\\]\*\*$/,'').replace(/[/\\]$/,''));}
function within(path,roots,platform='windows'){
 const p=normalizedPath(path);if(!p)return false;
 const norm=x=>platform==='windows'?x.toLowerCase():x;
 return list(roots).some(raw=>{const r=rootPath(raw);return r!==null&&(norm(p)===norm(r)||norm(p).startsWith(norm(r)+'/'));});
}
function bindingOK(entity,expected){const b=entity?.capabilityEvidence?.bindings;return record(b)&&Object.entries(expected).every(([key,value])=>value!==undefined&&b[key]===value);}
function currentHash(x,field){return x?.['current'+field[0].toUpperCase()+field.slice(1)]??x?.[field];}
function permissionArgs(cli,effective,tools,mcp,sdk,runtime,fail){
 const permissionName=effective==='full'?'full':effective==='write'?'write':'read',support=sdk?.capabilityEvidence?.supports||{};
 if(!list(support.permissions).includes(permissionName)){fail('PERMISSION_MAPPING_UNKNOWN','SDK没有此权限的显式DEMO原生映射');return [];}
 if(sdk?.kind==='builtin'){
  if(!list(support.nativeArgs).includes('builtin-policy'))fail('BUILTIN_POLICY_UNKNOWN','内置通道受管政策未知');
  return [];
 }
 if(cli==='codex'){
  if(effective==='full')return ['--dangerously-bypass-approvals-and-sandbox'];
  const sandbox=effective==='write'?'workspace-write':'read-only';
  if(!list(runtime?.capabilityEvidence?.supports?.sandboxPolicies).includes(sandbox))fail('SANDBOX_UNKNOWN','当前Runtime原生沙箱能力未声明支持');
  return ['--sandbox',sandbox,'-c','approval_policy="never"'];
 }
 if(cli==='claude'){
  if(effective==='full')return ['--permission-mode','bypassPermissions'];
  if(support.nativeToolRestrictions!==true||support.mcpControl!==true)fail('NATIVE_TOOL_UNKNOWN','Claude内置工具和MCP控制未明确验证为DEMO支持');
  const builtins=effective==='write'?['Read','Glob','Grep','Edit','Write']:['Read','Glob','Grep'];
  for(const t of tools.filter(x=>x.channel==='native'))if(!builtins.includes(t.nativeName))fail('NATIVE_TOOL_UNKNOWN','原生工具未包含在此模式的最小工具集合：'+id(t));
  // 未授权MCP全禁；选择MCP需独立受管gateway，不能依赖环境全局merge。
  const args=['--permission-mode',effective==='write'?'acceptEdits':'plan','--tools',builtins.join(',')];
  if(mcp.length){if(runtime?.capabilityEvidence?.supports?.mcpGateway!==true)fail('MCP_GATEWAY_UNKNOWN','精确MCP工具隔离gateway未声明支持');args.push('--strict-mcp-config','--mcp-config','DEMO-plan-scoped-mcp-config');}
  else args.push('--disallowedTools','mcp__*');
  return args;
 }
 fail('PERMISSION_MAPPING_UNKNOWN','执行器原生权限未知，不借用其它CLI参数');return [];
}
function resolveCore(request={},registry={},extraBounds=[]){
 const blockedReasons=[],fieldOrigins={},fail=(code,message)=>blockedReasons.push({code,message});
 if(!record(request)||!record(registry))return {version:'UI-CR026-v1',source:'demo',status:'blocked',blockedReasons:[{code:'INPUT_INVALID',message:'任务请求与目录必须对象'}]};
 const q=clone(request),r=clone(registry),mode=q.mode||'explicit';
 for(const name of ['templates','sdkEntries','runtimeEntries','providerModels','tools','skills','mcpServices','knowledgeGrants'])if(!Array.isArray(r[name]))fail('CATALOG_INVALID','目录必须显式数组：'+name);
 for(const key of ['requiredCapabilities','requiredSkills','requiredMcpTools','requiredKnowledgeGrants','allowedFallbacks'])if(q[key]!==undefined&&(!Array.isArray(q[key])||q[key].some(x=>!nonempty(x))))fail('REQUEST_INVALID','任务声明必须ID数组：'+key);
 if(q.allowFallback!==undefined&&typeof q.allowFallback!=='boolean'||q.parentAuthorization!==undefined&&!record(q.parentAuthorization))fail('REQUEST_INVALID','回退/父授权参数非法');
 if(q.phase!==undefined&&!['main','review','develop','verify','integrate','deliver'].includes(q.phase))fail('PHASE_INVALID','阶段未知');
 if(!['explicit','auto'].includes(mode))fail('MODE_INVALID','选择模式未知');
 if(q.difficulty!==undefined&&!difficulties.includes(q.difficulty))fail('DIFFICULTY_INVALID','任务难度未知');
 let t=find(r.templates,q.templateRef)||find(r.templates,q.explicitOverrides?.cliId)||find(r.templates,r.defaultTemplateRef);
 if(q.templateRef&&!find(r.templates,q.templateRef))fail('TEMPLATE_UNKNOWN','明确模板不存在，不回落默认');
 if(mode==='auto'&&q.workKind&&!q.explicitOverrides?.cliId){const routed=list(r.templates).find(p=>available(p)&&list(p.routeTypes||p.taskTypes).includes(q.workKind));if(routed)t=routed;}
 const values={},levels=[['Task',q.explicitOverrides||{}],['Template',t?.defaults||t||{}],['Project',q.projectDefaults||r.projectDefaults||{}],['System',r.systemConfirmed?r.systemDefaults||{}:{}]];
 const keys=['cliId','modelRef','effort','serviceTier','runtimeId','permissionIntent','toolRefs','skillRefs','mcpToolRefs','knowledgeGrantRefs','workspaceRefs','budget','retryPolicy'];
 if(!record(q.explicitOverrides||{}))fail('OVERRIDE_INVALID','任务覆盖必须对象');
 for(const key of keys){const origin=levels.find(([,v])=>v[key]!==undefined&&v[key]!==''&&v[key]!=='inherit');if(origin){values[key]=clone(origin[1][key]);fieldOrigins[key]={source:origin[0],revision:origin[1].revision??r.revision??'unknown',value:clone(values[key])};}}
 for(const key of ['toolRefs','skillRefs','mcpToolRefs','knowledgeGrantRefs','workspaceRefs'])if(values[key]!==undefined&&(!Array.isArray(values[key])||values[key].some(x=>!nonempty(x))))fail('LIST_INVALID',key+'必须明确ID/范围数组');
 const executor=find(r.sdkEntries,values.cliId),template=t;
 const routeOK=(s,p,explicit=false)=>available(s)&&s.installed===true&&evidence(s)&&available(p)&&p.cliId===values.cliId&&(explicit||!q.workKind||list(p.routeTypes||p.taskTypes).includes(q.workKind))&&(!p.minDifficulty||(difficulties.includes(p.minDifficulty)&&difficulties.includes(q.difficulty)&&difficulties.indexOf(q.difficulty)>=difficulties.indexOf(p.minDifficulty)));
 if(!routeOK(executor,template,mode==='explicit')&&mode==='auto'&&q.allowFallback===true){
  const next=list(r.templates).find(p=>list(q.allowedFallbacks).includes(p.cliId)&&available(p)&&evidence(find(r.sdkEntries,p.cliId))&&find(r.sdkEntries,p.cliId)?.installed===true&&(!p.minDifficulty||(difficulties.includes(q.difficulty)&&difficulties.indexOf(q.difficulty)>=difficulties.indexOf(p.minDifficulty))));
  if(next){const fallback={from:values.cliId,to:next.cliId,reason:'事前允许的自动回退；须确认具体结果'};const result=resolveCore({...q,mode:'explicit',templateRef:id(next),explicitOverrides:{...q.explicitOverrides,cliId:next.cliId}},r,extraBounds);result.fallback=fallback;result.hash=fingerprint({...result,hash:undefined,id:undefined});result.id='PLAN-'+result.hash;return result;}
 }
 if(!routeOK(executor,template,mode==='explicit'))fail('EXECUTOR_UNAVAILABLE','指定执行器、模板或DEMO支持证据不可用/难度不足；显式不受工作类型归属限制');
 const runtime=find(r.runtimeEntries,values.runtimeId),model=find(r.providerModels,values.modelRef);
 if(!available(runtime)||runtime.online!==true||!evidence(runtime))fail('RUNTIME_UNKNOWN','Runtime离线或受管DEMO支持证据未知');
 if(!nonempty(values.runtimeId)||!nonempty(runtime?.instanceId)||!list(runtime?.cliIds).includes(values.cliId)||!list(executor?.runtimeIds).includes(values.runtimeId))fail('RUNTIME_BINDING_INVALID','SDK/CLI与Runtime实例不匹配');
 if(!executor?.sdkVersion||!executor?.adapterVersion||!bindingOK(executor,{sdkVersion:executor?.sdkVersion,adapterVersion:executor?.adapterVersion}))fail('SDK_VERSION_UNKNOWN','SDK/adapter版本及其能力证据绑定未知');
 if(!bindingOK(runtime,{runtimeId:values.runtimeId,instanceId:runtime?.instanceId,cliId:values.cliId}))fail('RUNTIME_BINDING_INVALID','Runtime实例/执行器能力证据不匹配');
 if(!available(model)||!model?.providerId||!model?.remoteModelId||!model?.protocol||!model?.endpointRef||!model?.secretRef||!evidence(model)||!bindingOK(model,{providerId:model?.providerId,endpointRef:model?.endpointRef,secretRef:model?.secretRef,remoteModelId:model?.remoteModelId}))fail('MODEL_INVALID','供应商/端点/secretRef或模型支持证据失效/不匹配');
 if(!list(executor?.protocols).includes(model?.protocol))fail('PROTOCOL_UNSUPPORTED','SDK不支持选定协议');
 for(const [collection,ref,code] of [['providers',model?.providerId,'PROVIDER_INVALID'],['endpoints',model?.endpointRef,'ENDPOINT_INVALID'],['secrets',model?.secretRef,'SECRET_INVALID']])if(r[collection]!==undefined){const entity=find(r[collection],ref),b=model?.capabilityEvidence?.bindings,revisionKey=collection==='providers'?'providerRevision':collection==='endpoints'?'endpointRevision':'secretRevision';if(!available(entity)||(entity.providerId&&entity.providerId!==model?.providerId)||b?.[revisionKey]!==entity?.revision)fail(code,'当前配置引用或证据修订失效/归属冲突：'+ref);}
 const effort=values.effort,declared=list(model?.efforts),defaultOK=['default','off'].includes(effort)&&(declared.includes(effort)||model?.defaultEffortSupported===true);
 if(!defaultOK&&(!nonempty(effort)||!declared.includes(effort)))fail('EFFORT_UNKNOWN','思考档位未明确解析或不支持，不清非法档位默回');
 if(!list(executor?.capabilityEvidence?.supports?.efforts).includes(effort))fail('EFFORT_CLI_UNKNOWN','CLI当前DEMO证据未声明此档位/default/off支持');
 if(values.serviceTier!==undefined&&(!nonempty(values.serviceTier)||!list(model?.serviceTiers).includes(values.serviceTier)))fail('TIER_UNKNOWN','服务档位不支持，不能默降');
 const policies=r.policies||{},currentParent=r.parentAuthorization||policies.parentAuthorization,bounds=[policies.organization,policies.project,policies.authorization,template?.limits,runtime?.limits,executor?.limits,q.parentAuthorization,currentParent,...extraBounds].filter(Boolean);
 if(q.parentAuthorization&&(!available(currentParent)||!nonempty(q.parentAuthorization.id)||currentParent.id!==q.parentAuthorization.id||q.parentAuthorization.source!=='demo'||currentParent.source!=='demo'))fail('PARENT_AUTH_UNKNOWN','父授权缺当前声明/身份不一致，不能只信旧请求grant');
 if(!template?.limits||!runtime?.limits||!executor?.limits)fail('LIMIT_UNKNOWN','模板/Runtime/SDK可兑现上限缺失');
 if(!policies.organization||!policies.project||!policies.authorization)fail('AUTH_UNKNOWN','组织、项目或本批授权缺失');
 if(bounds.some(b=>!available(b)||b.permission===undefined))fail('AUTH_REVOKED','有效上限/授权已撤销或未知');
 const allowed=(key,ref)=>bounds.every(b=>list(b[key]).includes(ref));
 const selectedTools=[...new Set(list(values.toolRefs))],allowedTools=[];
 for(const ref of selectedTools){const x=find(r.tools,ref);if(available(x)&&evidence(x)&&nonempty(x.schemaHash)&&currentHash(x,'schemaHash')===x.schemaHash&&['host','native'].includes(x.channel)&&record(x.parameterPolicy)&&allowed('toolRefs',ref))allowedTools.push(clone(x));}
 const mcpTools=[];
 for(const ref of [...new Set(list(values.mcpToolRefs))]){const services=list(r.mcpServices).filter(s=>list(s.discoveredTools).some(x=>id(x)===ref)),service=services[0],tool=find(service?.discoveredTools,ref);if(services.length===1&&available(service)&&service.discovery==='discovered'&&service.revision!==undefined&&available(tool)&&evidence(tool)&&nonempty(tool.schemaHash)&&currentHash(tool,'schemaHash')===tool.schemaHash&&record(tool.parameterPolicy)&&allowed('mcpToolRefs',ref))mcpTools.push({...clone(tool),channel:'mcp',serviceRef:id(service),serviceRevision:service.revision,serviceConfigHash:service.configHash||fingerprint(service),discoveryRevision:service.discoveryRevision??service.revision});else fail('MCP_UNDISCOVERED','MCP服务/schema来源或精确授权失效：'+ref);}
 const skills=[];
 for(const ref of [...new Set([...list(values.skillRefs),...list(q.requiredSkills)])]){const x=find(r.skills,ref);if(!available(x)||!nonempty(x.source)||!x.contentHash||!x.attachmentsHash||x.revision===undefined||currentHash(x,'contentHash')!==x.contentHash||currentHash(x,'attachmentsHash')!==x.attachmentsHash||!allowed('skillRefs',ref)){fail('SKILL_INVALID','Skill来源/内容/附件/hash或授权失效：'+ref);continue;}skills.push(clone(x));}
 const intent=values.permissionIntent,rank=ranks[intent];
 if(rank===undefined)fail('PERMISSION_UNKNOWN','权限意图未解析');
 const upper=Math.min(...bounds.map(b=>ranks[b.permission]??-1));
 let effective=rank===2?'full':rank===1?'write':'read';
 if(upper<0||rank>upper)fail('PERMISSION_UNPROVEN','权限请求超出有效上限，禁止默降后假装支持');
 if(q.phase==='review'){if(rank===2)fail('REVIEW_FULL_DENIED','评审不能继承全自动；需明确新只读阶段计划');effective='read';}
 if(effective==='full'&&(!(runtime?.capabilityEvidence?.supports?.isolated===true)||policies.authorization?.fullApproved!==true))fail('FULL_UNAPPROVED','full需要明确隔离DEMO证据和本批显式批准，不默降write');
 if(effective==='read'){for(let i=allowedTools.length-1;i>=0;i--)if(allowedTools[i].effect!=='read')allowedTools.splice(i,1);for(let i=mcpTools.length-1;i>=0;i--)if(mcpTools[i].effect!=='read')mcpTools.splice(i,1);}
 const allTools=()=>[...allowedTools,...mcpTools];
 for(const cap of [...list(q.requiredCapabilities),...list(q.requiredMcpTools),...skills.flatMap(x=>list(x.requiredCapabilities))])if(!allTools().some(x=>id(x)===cap))fail('CAPABILITY_MISSING','必需能力不在权限/父子有效交集：'+cap);
 const grants=list(values.knowledgeGrantRefs).filter(ref=>available(find(r.knowledgeGrants,ref))&&allowed('knowledgeGrantRefs',ref));
 for(const ref of list(q.requiredKnowledgeGrants))if(!grants.includes(ref))fail('KNOWLEDGE_MISSING','必需知识grant不可用：'+ref);
 const budget=values.budget;if(!count(budget)||bounds.some(b=>!count(b.budget)||budget>b.budget)||(q.parentAuthorization&&count(q.parentAuthorization.remainingBudget)&&budget>q.parentAuthorization.remainingBudget)||(currentParent&&(!count(currentParent.remainingBudget)||budget>currentParent.remainingBudget)))fail('BUDGET_INVALID','预算非法或超过授权/父剩余预算');
 const retryPolicy=values.retryPolicy||{maxRetries:0};if(!record(retryPolicy)||!count(retryPolicy.maxRetries)||Object.keys(retryPolicy).some(k=>!['maxRetries','maxRepairRounds','timeoutMs'].includes(k))||Object.entries(retryPolicy).some(([k,v])=>!count(v))||bounds.some(b=>b.maxRetries!==undefined&&(!count(b.maxRetries)||retryPolicy.maxRetries>b.maxRetries)))fail('RETRY_INVALID','重试参数非法或超过策略上限');
 if(!list(values.workspaceRefs).length||list(values.workspaceRefs).some(p=>rootPath(p)===null))fail('WORKSPACE_UNKNOWN','工作区路径未知/非法');
 else if(list(values.workspaceRefs).some(p=>bounds.some(b=>!within(rootPath(p),b.paths,r.pathPlatform||'windows'))))fail('WORKSPACE_DENIED','原工作区范围超过当前模板/组织项目/父授权路径');
 const nativeArgs=permissionArgs(values.cliId,effective,allowedTools,mcpTools,executor,runtime,fail);
 const permission={intent,effective,nativeArgs,approvalPolicy:values.cliId==='codex'?'never':'native-restricted',bounds:clone(bounds),inheritEnvironmentMcp:false,policyNotice:'仅明确DEMO能力编译，不证明真实CLI/OS安全'};
 const referenced={sdk:evidenceRef(executor),runtime:{...evidenceRef(runtime),instanceId:runtime?.instanceId},model:evidenceRef(model),providerRefs:Object.fromEntries(['providers','endpoints','secrets'].filter(k=>r[k]!==undefined).map(k=>[k,clone(find(r[k],k==='providers'?model?.providerId:k==='endpoints'?model?.endpointRef:model?.secretRef))]))};
 const plan={version:'UI-CR026-v1',source:'demo',fingerprintNotice:'DEMO-FNV一致性指纹，非安全SHA/签名/可信授权',evidenceNotice:'仅DEMO政策推演；真实CLI/隔离能力未验证',taskId:q.taskId||q.id,phase:q.phase||'main',sourceRun:q.sourceRun||null,request:q,templateRef:id(template),templateSnapshot:clone(template),selectedExecutor:{kind:executor?.kind||'cli',cliId:values.cliId,sdkVersion:executor?.sdkVersion,adapterVersion:executor?.adapterVersion,runtimeId:values.runtimeId,instanceId:runtime?.instanceId},model:model?{id:id(model),providerId:model.providerId,remoteModelId:model.remoteModelId,protocol:model.protocol,endpointRef:model.endpointRef,secretRef:model.secretRef,effort,serviceTier:values.serviceTier}:null,permission,allowedTools,skills,mcpTools,knowledgeGrantRefs:grants,workspaceRefs:values.workspaceRefs||[],budget,retryPolicy,fieldOrigins,bindingSnapshots:referenced,configSnapshotRef:fingerprint(r),requirementDesignAcHashes:q.requirementDesignAcHashes||{},blockedReasons,excludedTools:selectedTools.filter(ref=>!allowedTools.some(x=>id(x)===ref)),fallback:null};
 plan.status=blockedReasons.length?'blocked':'ready';plan.hash=fingerprint(plan);plan.id='PLAN-'+plan.hash;return plan;
}
function resolve(request={},registry={}){return resolveCore(request,registry);}
function planDigest(plan){const body=clone(plan);for(const k of ['id','hash','frozen','authorizationRefs'])delete body[k];return fingerprint(body);}
function revalidate(plan,r={}){
 const reasons=[],reject=(code,message)=>reasons.push({code,message});let current=null;
 if(!record(plan)||plan.status!=='ready'||!record(r)||!record(plan.selectedExecutor)||!record(plan.model)||!record(plan.permission)||!record(plan.fieldOrigins)||!Array.isArray(plan.allowedTools)||!Array.isArray(plan.mcpTools)||!Array.isArray(plan.skills)||!Array.isArray(plan.knowledgeGrantRefs)||!record(plan.bindingSnapshots)||!record(plan.templateSnapshot)||!record(plan.retryPolicy))reject('PLAN_BLOCKED','计划/当前目录结构无效');
 else{
  if(planDigest(plan)!==plan.hash)reject('PLAN_CHANGED','计划内容与DEMO指纹不一致');
  const template=find(r.templates,plan.templateRef),e=find(r.sdkEntries,plan.selectedExecutor.cliId),rt=find(r.runtimeEntries,plan.selectedExecutor.runtimeId),m=find(r.providerModels,plan.model?.id);
  if(!available(template))reject('TEMPLATE_REVOKED','原执行模板已撤销/删除');
  for(const [label,now,frozen] of [['SDK',e,plan.bindingSnapshots?.sdk],['Runtime',rt,plan.bindingSnapshots?.runtime],['Model',m,plan.bindingSnapshots?.model]]){
   const value=label==='Runtime'?{...evidenceRef(now),instanceId:now?.instanceId}:evidenceRef(now);
   if(!available(now)||!evidence(now)||stable(value)!==stable(frozen))reject('BINDING_CHANGED',label+'身份/版本/能力证据修订或来源改变');
  }
  if(e?.installed!==true||e?.sdkVersion!==plan.selectedExecutor.sdkVersion||e?.adapterVersion!==plan.selectedExecutor.adapterVersion)reject('EXECUTOR_INVALID','原SDK版本/安装状态失效');
  if(!rt?.online||rt?.instanceId!==plan.selectedExecutor.instanceId)reject('RUNTIME_INVALID','原Runtime实例不可用');
  if(!m||['providerId','remoteModelId','protocol','endpointRef','secretRef'].some(k=>m[k]!==plan.model[k]))reject('MODEL_INVALID','原供应商/模型/端点/凭据引用发生变化');
  for(const [collection,frozen] of Object.entries(plan.bindingSnapshots?.providerRefs||{}))if(stable(find(r[collection],id(frozen)))!==stable(frozen))reject('MODEL_REFERENCE_CHANGED','原配置引用/版本变化：'+collection);
  const overrides=Object.fromEntries(Object.entries(plan.fieldOrigins||{}).map(([k,v])=>[k,clone(v.value)]));
  const pinned={...clone(template||{}),id:plan.templateRef,cliId:plan.selectedExecutor.cliId,defaults:overrides};
  const q={...clone(plan.request),mode:'explicit',templateRef:plan.templateRef,explicitOverrides:overrides};
  current=resolveCore(q,{...r,templates:[pinned]},[plan.templateSnapshot?.limits].filter(Boolean));reasons.push(...current.blockedReasons);
  for(const x of [...plan.allowedTools,...plan.mcpTools]){const now=[...current.allowedTools,...current.mcpTools].find(z=>id(z)===id(x));if(!now||stable(now)!==stable(x))reject('TOOL_REVOKED','原工具/schema/发现来源变化或撤权：'+id(x));}
  for(const x of plan.skills){const now=find(r.skills,id(x));if(!now||stable(now)!==stable(x))reject('SKILL_CHANGED','原Skill版本/source/正文/附件声明变化：'+id(x));}
  for(const ref of plan.knowledgeGrantRefs)if(!current.knowledgeGrantRefs.includes(ref))reject('KNOWLEDGE_REVOKED','知识grant撤销：'+ref);
 }
 return {ok:reasons.length===0,reasons,source:'demo',currentBounds:current?.permission?.bounds||[]};
}
function freeze(plan,authorization={}){
 if(!plan||plan.status!=='ready'||authorization.confirmed!==true||!nonempty(authorization.id)||!nonempty(authorization.planHash))throw Error('未就绪或缺明确计划hash授权');
 if(authorization.planHash!==plan.hash||planDigest(plan)!==plan.hash)throw Error('计划已变化，请重新确认');
 return lock({...clone(plan),authorizationRefs:[{id:authorization.id,source:'demo',planHash:plan.hash}],frozen:true});
}
function validValue(value,rule){
 if(!record(rule)||!['string','boolean','integer','number','array','object'].includes(rule.type)||Object.keys(rule).some(k=>!['type','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','items','properties','required','additionalProperties','description','title'].includes(k)))return false;
 if(rule.type==='string'&&typeof value!=='string'||rule.type==='boolean'&&typeof value!=='boolean'||rule.type==='integer'&&!Number.isSafeInteger(value)||rule.type==='number'&&(typeof value!=='number'||!Number.isFinite(value))||rule.type==='array'&&!Array.isArray(value)||rule.type==='object'&&!record(value))return false;
 if(rule.enum&&!list(rule.enum).some(x=>stable(x)===stable(value))||Object.hasOwn(rule,'const')&&stable(value)!==stable(rule.const))return false;
 if(typeof value==='number'&&(rule.exclusiveMinimum!==undefined&&value<=rule.exclusiveMinimum||rule.exclusiveMaximum!==undefined&&value>=rule.exclusiveMaximum))return false;
 if(typeof value==='string'&&rule.pattern!==undefined){try{if(typeof rule.pattern!=='string'||!new RegExp(rule.pattern).test(value))return false;}catch(_){return false;}}
 if(Array.isArray(value)&&(rule.minItems!==undefined&&value.length<rule.minItems||rule.uniqueItems&&new Set(value.map(stable)).size!==value.length))return false;
 if(typeof value==='number'&&(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
 if(typeof value==='string'&&(rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength))return false;
 if(Array.isArray(value)&&(rule.maxItems!==undefined&&value.length>rule.maxItems||rule.items&&value.some(v=>!validValue(v,rule.items))))return false;
 if(record(value)&&(Object.keys(value).some(k=>!Object.hasOwn(rule.properties||{},k))||list(rule.required).some(k=>!Object.hasOwn(value,k))||Object.entries(value).some(([k,v])=>!validValue(v,rule.properties?.[k]))))return false;
 return true;
}
function authorizeCall(plan,tool,args={},registry){
 const check=revalidate(plan,registry),deny=message=>({ok:false,decision:'deny',reasons:[{message}],source:'demo'});if(!check.ok)return {ok:false,decision:'deny',reasons:check.reasons,source:'demo'};
 const x=[...plan.allowedTools,...plan.mcpTools].find(x=>id(x)===(typeof tool==='string'?tool:id(tool)));if(!x)return deny('工具不在冻结白名单');
 const p=x.parameterPolicy;if(!record(args)||!record(p))return deny('参数对象/策略未知');
 if(Object.keys(args).some(k=>!list(p.allowedKeys).includes(k))||[...list(p.requiredKeys),...list(p.schema?.required)].some(k=>args[k]===undefined))return deny('参数不在schema允许范围或缺必需字段');
 const rules=p.properties||p.schema?.properties||{};
 for(const [key,value] of Object.entries(args)){const generic=['path','target','command','grantRef'].includes(key);if(value===null||value===undefined||(rules[key]?!validValue(value,rules[key]):!generic))return deny('参数类型或完整边界未声明：'+key);}
 const bounds=[...plan.permission.bounds,...check.currentBounds],platform=registry.pathPlatform||'windows';
 for(const key of [...new Set(['path',...list(p.pathKeys)])])if(args[key]!==undefined&&(typeof args[key]!=='string'||!within(args[key],p.paths,platform)||!within(args[key],plan.workspaceRefs,platform)||bounds.some(b=>!within(args[key],b.paths,platform))))return deny('路径越界/非规范/当前范围撤权：'+key);
 for(const key of [...new Set(['target',...list(p.targetKeys)])])if(args[key]!==undefined&&(typeof args[key]!=='string'||!list(p.networkTargets).includes(args[key])||bounds.some(b=>!list(b.networkTargets).includes(args[key]))))return deny('网络目标未经精确授权：'+key);
 for(const key of [...new Set(['command',...list(p.commandKeys)])])if(args[key]!==undefined&&(typeof args[key]!=='string'||!list(p.commands).includes(args[key])||bounds.some(b=>!list(b.commands).includes(args[key]))))return deny('命令不在白名单：'+key);
 for(const key of [...new Set(['grantRef',...list(p.grantKeys)])])if(args[key]!==undefined&&(!plan.knowledgeGrantRefs.includes(args[key])||!bounds.every(b=>list(b.knowledgeGrantRefs).includes(args[key]))))return deny('知识grant不在父子/当前有效声明交集：'+key);
 if(p.knowledgeGrantRefs&&(!nonempty(args.grantRef)||!list(p.knowledgeGrantRefs).includes(args.grantRef)))return deny('知识通道缺精确grant声明');
 return {ok:true,decision:'allow',reasons:[{message:'冻结白名单与当前授权交集允许；仅DEMO，未执行'}],source:'demo'};
}
function retry(plan,registry,options={}){
 if(!record(options)||options.stopPending||['running','stopPending','cleanupUnknown'].includes(options.status))return {ok:false,reasons:[{message:'旧writer停止未证明或参数错误'}]};
 const c=revalidate(plan,registry);if(!c.ok)return c;
 const used=options.used??0,retries=options.retries??0;
 if(!count(used)||!count(retries)||options.fresh!==undefined&&typeof options.fresh!=='boolean'||used>=plan.budget||retries>=plan.retryPolicy.maxRetries)return {ok:false,reasons:[{message:'原预算/重试上限耗尽或参数非法'}]};
 return {ok:true,plan:clone(plan),planRef:plan.id,context:options.fresh?'fresh':'resume',used,retries:retries+1,source:'demo'};
}
root.TaskExecutionPlanModel=Object.freeze({version:'UI-CR026-v1',resolve,freeze,revalidate,authorizeCall,retry,clone,fingerprint,stable,safePath});
})(typeof window==='undefined'?globalThis:window);
