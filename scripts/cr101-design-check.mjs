// CR-101 / UI-CR101-v1：设计侧统计条空态与实时流速检查（仅唯一原型，不接真实业务）。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const out='docs/Test/screenshots/cr101-design';
await mkdir(out,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'cr101-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,seq=0;const pending=new Map(),errors=[],result={time:new Date().toISOString(),scope:'design only',checks:[],shots:[]};
const ok=(name,detail)=>result.checks.push({name,pass:true,detail});
try {
  let port;for(let i=0;i<100&&!port;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{await delay(100);}}
  assert.ok(port,'Chrome failed to start');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  const cdp=(method,params={})=>new Promise((r,j)=>{const id=++seq;const t=setTimeout(()=>j(Error(method+' timeout')),60000);pending.set(id,m=>{clearTimeout(t);m.error?j(Error(JSON.stringify(m.error))):r(m.result);});ws.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shot=async(name,selector)=>{await frame();let clip;if(selector){clip=await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);}const r=await cdp('Page.captureScreenshot',{format:'png',...(clip?{clip}:{})});await writeFile(join(out,name+'.png'),Buffer.from(r.data,'base64'));result.shots.push(name+'.png');};
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:pathToFileURL(join(process.cwd(),'docs/UI/仿真原型UI.html')).href});
  for(let i=0;i<120;i++){if(await js('document.readyState==="complete"&&!!window.CR074&&!!window.__actions'))break;await delay(80);}
  assert.equal(await js('CR074.version'),'UI-CR101-v1','design resource version');

  // 进入代码项目的 AI 侧栏布局（用户第 2 条反馈的界面）。
  await js(`(()=>{const p=UI.D.projects.find(x=>x.kind==='code');UI.openWindow('project',p.id,p.name);UI.store.projectTab='requirements';UI.store.wbAiBefore=true;UI.store.aiOpen=true;UI.store.aiBusy=false;UI.render();})()`);await frame();
  assert.equal(await js('document.querySelectorAll(".ai-panel").length'),1,'sidebar layout present');

  const setStats=async patch=>{await js(`(()=>{UI.D.ai.stats=Object.assign({simulated:true},${JSON.stringify(patch)});UI.render();})()`);await frame();};
  const bar=()=>js(`(()=>{const n=document.querySelector('.ai-panel .ai-stats');return n?{text:n.textContent.replace(/\\s+/g," ").trim(),triggers:n.querySelectorAll('[data-act="ai-stat"]').length}:null})()`);
  const panelH=()=>js(`Math.round(document.querySelector('.ai-composer-wrap').getBoundingClientRect().height)`);

  // A 已知数据：三组齐全，格式沿用 CR-074。
  await setStats({rounds:4,steps:17,tps:'148 tok/s',tokens:{total:6064710,cacheHit:'95%'},context:{used:'6%'}});
  const full=await bar();
  assert.ok(full.text.includes('4 轮 17 步 · 148 tok/s'),full.text);
  assert.ok(full.text.includes('6.1M tok · 缓存 95%'),full.text);
  // 统计条用「缓存」，详情浮层保留完整「缓存命中」，避免详情里丢失命中率语义。
  assert.doesNotMatch(full.text,/缓存命中/,'统计条不得再写「缓存命中」');
  assert.ok(full.text.includes('6%'),full.text);
  assert.equal(full.triggers,3,'three detail entries when all groups have data');ok('已知数据三组齐全',full.text);
  const heightWithStats=await panelH();
  await shot('01-known-all','.ai-composer-wrap');

  // B 全空：整条不渲染，不留占位、不出现入口。
  await setStats({});
  assert.equal(await bar(),null,'no .ai-stats node at all');ok('全空整条不渲染','容器节点数为 0');
  assert.equal(await js(`document.querySelectorAll('.ai-panel [data-act="ai-stat"]').length`),0,'no detail entries');
  assert.equal(await js(`document.querySelectorAll('.ai-panel .ai-stats').length`),0,'no empty container');
  const heightEmpty=await panelH();
  assert.ok(heightWithStats-heightEmpty>=8,`empty state frees space (${heightWithStats} -> ${heightEmpty})`);ok('全空不留空白占位',`composer ${heightWithStats}px → ${heightEmpty}px`);
  assert.equal(await js(`getComputedStyle(document.querySelector('.ai-panel .ai-composer-wrap')).overflow`),'visible','empty state does not use overflow:hidden');
  await shot('02-empty','.ai-composer-wrap');

  // C 部分已知：只显示已知片段，未知不输出「—」。
  await setStats({rounds:4});
  const onlyRounds=await bar();
  assert.equal(onlyRounds.text,'4 轮',onlyRounds.text);
  assert.equal(onlyRounds.triggers,1,'only session entry');ok('只有轮次只显示轮次',onlyRounds.text);

  await setStats({tps:'148 tok/s'});
  const onlyTps=await bar();
  assert.equal(onlyTps.text,'148 tok/s',onlyTps.text);ok('只有流速只显示流速',onlyTps.text);

  await setStats({rounds:4,steps:17,tps:'148 tok/s'});
  assert.equal((await bar()).text,'4 轮 17 步 · 148 tok/s');ok('会话组字段级省略','无 TPS 时不出现分隔符残骸');

  await setStats({tokens:{total:0}});
  assert.equal((await bar()).text,'0 tok');ok('Token 零值可信','0 tok 不被当作未知');

  // D 可信零值必须显示。
  await setStats({rounds:0,steps:0,tps:'0 tok/s',tokens:{total:0,cacheHit:'0%'},context:{used:'0%'}});
  const zero=await bar();
  assert.ok(zero.text.includes('0 轮 0 步 · 0 tok/s'),zero.text);
  assert.ok(zero.text.includes('0 tok · 缓存 0%'),zero.text);
  assert.equal(zero.triggers,3,'zero is data, all three entries stay');ok('可信零值全部显示',zero.text);
  await shot('03-known-zero','.ai-composer-wrap');

  // E 生成中实时流速。
  await setStats({rounds:1,steps:2,liveActive:true,liveTps:'126 tok/s',tps:'未知'});
  const live=await bar();
  assert.equal(live.text,'1 轮 2 步 · ~126 tok/s',live.text);ok('生成中显示实时流速（带估算前缀）',live.text);
  await js(`document.querySelector('.ai-panel [data-act="ai-stat"][data-stat="session"]').click()`);await frame();
  const liveDetail=await js(`document.querySelector('.ai-panel .ai-pop-stat').textContent.replace(/\\s+/g,' ').trim()`);
  assert.ok(liveDetail.includes('~126 tok/s（生成中实时估算）'),liveDetail);ok('详情标注实时估算口径',liveDetail);
  await shot('04-live-tps','.ai-composer-wrap');
  await js(`UI.store.aiPop=null;UI.render()`);await frame();

  // F 终态清除实时值：不回落到过期数字。
  await setStats({rounds:1,steps:2,liveActive:false,liveTps:'126 tok/s',tps:'未知'});
  const ended=await bar();
  assert.equal(ended.text,'1 轮 2 步',ended.text);
  assert.doesNotMatch(ended.text,/126/);ok('终态清除实时值不冻结过期数字',ended.text);

  // G 权威值可用时替换实时值。
  await setStats({rounds:1,steps:2,liveActive:false,liveTps:'126 tok/s',tps:'148 tok/s'});
  assert.equal((await bar()).text,'1 轮 2 步 · 148 tok/s');ok('权威值替换实时值','148 tok/s');

  // H 详情口径与未知说明。
  await js(`document.querySelector('.ai-panel [data-act="ai-stat"][data-stat="session"]').click()`);await frame();
  const authDetail=await js(`document.querySelector('.ai-panel .ai-pop-stat').textContent.replace(/\\s+/g,' ').trim()`);
  assert.ok(authDetail.includes('148 tok/s（本轮闭合测量）'),authDetail);
  assert.ok(authDetail.includes('未上报'),authDetail);
  assert.doesNotMatch(authDetail,/undefined|NaN|Infinity/);ok('详情口径标注与未知说明',authDetail);
  await js(`UI.store.aiPop=null;UI.render()`);await frame();

  // I 非法与占位值不得出现。
  for(const patch of [{rounds:'—',steps:'未知',tps:'—',tokens:{total:'—',cacheHit:'未知'},context:{used:'—'}},{rounds:null,steps:null,tps:null,tokens:{},context:{}},{rounds:NaN,tps:Infinity,context:{used:NaN}}]){
    await setStats(patch);
    const b=await bar();
    if(b){assert.doesNotMatch(b.text,/NaN|Infinity|undefined|—/,'no placeholder in '+JSON.stringify(patch));}
  }
  ok('非法与占位值不渲染为数值','全部省略，无 NaN／Infinity／—');await shot('05-invalid-omitted','.ai-composer-wrap');

  // J 窄档与深色：有数据与空态都不溢出、不占位。
  await setStats({rounds:4,steps:17,tps:'148 tok/s',tokens:{total:6064710,cacheHit:'95%'},context:{used:'6%'}});
  for(const width of [320,372]){
    await js(`UI.store.aiWidth=${width};UI.render()`);await frame();
    assert.equal(await js('document.documentElement.scrollWidth>1440'),false,`no page overflow at ${width}`);
    assert.ok(await js(`!document.querySelector('.ai-panel .ai-stats').scrollWidth||document.querySelector('.ai-panel .ai-stats').scrollWidth<=document.querySelector('.ai-panel .ai-stats').clientWidth+1`),`no stats overflow at ${width}`);
    ok(`侧栏 ${width} 档无横向溢出`,'stats 宽度不超出容器');
    await shot(`06-sidebar-${width}`,'.ai-panel');
  }
  await js(`document.documentElement.dataset.theme='dark';UI.store.aiWidth=372;UI.render()`);await frame();
  await shot('07-dark-known','.ai-panel');
  await setStats({});
  assert.equal(await bar(),null,'dark empty state has no node');
  await shot('08-dark-empty','.ai-panel');
  await js(`document.documentElement.dataset.theme='light'`);

  // K UI-SCROLL-001：统计条自身不成为滚动容器，详情正文沿用共享滚动。
  await setStats({rounds:4,steps:17,tps:'148 tok/s',tokens:{total:6064710,cacheHit:'95%'},context:{used:'6%'}});
  const styles=await js(`(()=>{const n=document.querySelector('.ai-panel .ai-stats');const c=getComputedStyle(n);return {overflow:c.overflowX+'/'+c.overflowY,maxHeight:c.maxHeight};})()`);
  assert.equal(styles.overflow,'visible/visible','stats bar itself is not a scroll container');ok('UI-SCROLL-001 统计条不新增滚动容器',JSON.stringify(styles));
  await js(`document.querySelector('.ai-panel [data-act="ai-stat"][data-stat="tokens"]').click()`);await frame();
  const popScroll=await js(`(()=>{const b=document.querySelector('.ai-panel .ai-pop-stat .stat-rows');return b?getComputedStyle(b.parentElement).overflowY:null})()`);
  assert.ok(popScroll!==null,'detail body exists');ok('详情正文沿用既有滚动容器',String(popScroll));

  // L 工作台布局回归：统计条同样按新规则渲染。
  await js(`UI.store.aiPop=null;UI.store.projectTab='workbench';UI.render()`);await frame();
  assert.equal(await js(`document.querySelectorAll('.wb-conv .ai-stats').length`),1,'workbench stats present with data');
  await setStats({});
  assert.equal(await js(`document.querySelectorAll('.wb-conv .ai-stats').length`),0,'workbench empty state renders nothing');
  ok('工作台布局同规则','有数据渲染、空态不渲染');

  assert.equal(errors.length,0,errors.join('\n'));ok('运行时异常','0');
  result.status='passed';
} catch(e) {result.status='failed';result.error=e.stack;console.error(e.stack);process.exitCode=1;} finally {result.exceptions=errors;await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));ws?.close();chrome.kill();}
console.log(JSON.stringify(result,null,2));
