/* UI-CR025-v1：仅合成后台记录，不执行命令，不读取宿主作业。 */
((root)=>{
  'use strict';
  const ended=new Set(['completed','failed','cancelled']),states=new Set([...ended,'running','unknown']);
  const records=s=>s.backgroundTasks||(s.backgroundTasks=[]);
  const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  function record(s,data){
    if(!data||!data.id||data.scope!==s.scope||data.sessionId!==s.id||!states.has(data.status)||data.source!=='demo')return {ok:false,reason:'记录归属或状态无效'};
    const list=records(s);if(list.some(r=>r.id===data.id))return {ok:true,duplicate:true};
    list.push({...data,revision:1,output:String(data.output||''),error:String(data.error||'')});return {ok:true};
  }
  function update(s,id,patch){
    const r=records(s).find(r=>r.id===id);
    if(!r||!patch||patch.scope!==s.scope||patch.sessionId!==s.id||!Number.isSafeInteger(patch.revision)||patch.revision<=r.revision)return {ok:false,reason:'未知记录、错误归属或旧事件'};
    const keys=['scope','sessionId','revision','status','endMs','exitCode','output','error'];
    if(Object.keys(patch).some(k=>!keys.includes(k))||(patch.status&&!states.has(patch.status)))return {ok:false,reason:'无效更新字段'};
    if(ended.has(r.status)&&patch.status&&patch.status!==r.status)return {ok:false,reason:'已结束记录不被迟到事件复活或改判'};
    Object.assign(r,patch);r.output=String(r.output||'');r.error=String(r.error||'');return {ok:true};
  }
  function clearEnded(s){const before=records(s).length;s.backgroundTasks=records(s).filter(r=>!ended.has(r.status));return before-s.backgroundTasks.length;}
  function loadFixture(s,kind){
    s.backgroundTasks=[];const now=Date.now(),n=kind==='ended'?11:kind==='unknown'?1:4;
    for(let i=0;i<n;i++){
      const status=kind==='ended'?'completed':kind==='unknown'?'unknown':['running','completed','completed','failed'][i];
      const command=kind==='unknown'?'node docs/Test/unknown-demo.mjs':i===0&&kind!=='ended'?'node docs/Test/design-background-demo.mjs --scenario long-running':i===3&&kind!=='ended'?'node docs/Test/design-background-demo.mjs --scenario synthetic-failure':`node --check docs/UI/task-workbench/demo-resource-${String(i+1).padStart(2,'0')}.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
      record(s,{id:`${s.id}-BG-${i+1}`,scope:s.scope,sessionId:s.id,source:'demo',tool:'pwsh',command,status,startMs:kind==='unknown'?null:now-(i+1)*11000,endMs:ended.has(status)?now-i*1000:null,exitCode:status==='completed'?0:status==='failed'?1:null,output:status==='completed'?'DEMO：合成检查正常退出；没有执行命令，不代表项目验收。':status==='failed'?'DEMO：合成故障，模拟命令退出1。':'',error:status==='failed'?'合成验证失败（设计夹具）':''});
    }
    return records(s);
  }
  const api=Object.freeze({version:'UI-CR025-v1',records,record,update,clearEnded,loadFixture,isEnded:s=>ended.has(s),known});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BackgroundTaskModel=api;
})(typeof window==='undefined'?globalThis:window);
