// CR-101：软件侧真实组件验证（真实 StatsBar + 真实样式，隔离页面，不接真实业务）。
// 重点验证 SSR 无法证明的两件事：空态在真实布局里不占位，以及 :empty 防御与滚动不受影响。
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const OUT='docs/Test/screenshots/cr101-software';
await mkdir(OUT,{recursive:true});

const source=await readFile('src/modules/chat/StatsBar.tsx','utf8');
const transpiled=ts.transpileModule(source,{fileName:'StatsBar.tsx',reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}});
assert.deepEqual((transpiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
const css=await readFile('src/modules/chat/stats-bar.css','utf8');
const shared=await readFile('src/modules/chat/chat.css','utf8');

const fixtures={
  known:{rounds:4,steps:17,tps:148,msgs:6,tokensIn:272907,cacheRead:5703936,tokensOut:63007,contextUsed:66700,contextLimit:1000000},
  empty:{rounds:null,steps:null,msgs:0},
  partial:{rounds:4,msgs:3},
  zero:{rounds:0,steps:0,tps:0,msgs:0,tokensIn:0,cacheRead:0,tokensOut:0,contextUsed:0,contextLimit:1000},
  live:{rounds:1,steps:2,msgs:2,liveTps:126.4,liveEstimated:true},
  liveBeatsAuthority:{rounds:1,steps:2,msgs:2,liveTps:98,tps:148},
  invalid:{rounds:NaN,steps:Infinity,tps:-1,msgs:1,tokensIn:NaN,cacheRead:-1,contextUsed:Infinity},
};
const html=`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'">
<title>CR-101 software stats</title>
<link rel="stylesheet" href="../../src/theme/tokens.css"><link rel="stylesheet" href="../../src/theme/base.css">
<style>${css.replace(/\0/g,'')}
body{margin:0;padding:16px;background:#fafbfc;font-family:system-ui,sans-serif}
.row{display:flex;gap:16px;margin-bottom:14px}
.case{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:10px;width:320px}
.cap{font:11px/1.4 system-ui;color:#8a919c;margin-bottom:6px}
.slot{min-height:0}
</style></head><body>
<div id="host"></div>
<script src="../../node_modules/react/umd/react.development.js"></script>
<script src="../../node_modules/react-dom/umd/react-dom.development.js"></script>
<script>
const module={exports:{}};const exports=module.exports;
const FORMAT=ms=>ms<1000?ms+'ms':ms<60000?(ms/1000).toFixed(1)+'s':Math.floor(ms/60000)+'m'+String(Math.round(ms%60000/1000)).padStart(2,'0')+'s';
function require(id){
  if(id==='react')return React;
  if(id==='./stats-bar.css')return {};
  if(id==='./overlay')return {useChatOverlay:()=>({activeOverlay:window.__open||null,toggle:(k)=>{window.__toggled=k;}})};
  if(id==='./sessionRuntime')return {formatDur:FORMAT};
  throw new Error('unexpected require '+id);
}
${transpiled.outputText.replace(/\bexports\./g,'module.exports.')}
const StatsBarC=module.exports.StatsBar;
const FX=__FIXTURES__;
const CASES=[['known','已知数据（三组）'],['empty','全空（应不渲染）'],['partial','只有轮次'],['zero','可信零值'],['live','生成中实时估算'],['liveBeatsAuthority','生成中优先实时值'],['invalid','非法值（应省略）'],['blank','完全不挂载（高度基准）']];
const host=document.getElementById('host');
const wrap=document.createElement('div');wrap.className='row';host.appendChild(wrap);
const slots={};
for(const [key,label] of CASES){
  const card=document.createElement('div');card.className='case';
  const cap=document.createElement('div');cap.className='cap';cap.textContent=label;card.appendChild(cap);
  const slot=document.createElement('div');slot.className='slot';slot.id='slot-'+key;card.appendChild(slot);
  wrap.appendChild(card);slots[key]=slot;
}
const root=ReactDOM.createRoot(document.createElement('div'));
let ready=0;
for(const [key] of CASES){
  if(key==='blank')continue;
  ReactDOM.createRoot(slots[key]).render(React.createElement(StatsBarC,{data:FX[key]}));
  ready++;
}
window.__mounted=ready;
</script></body></html>`.replace('__FIXTURES__',JSON.stringify(fixtures));
await mkdir('docs/tmp',{recursive:true});
await writeFile('docs/tmp/cr101-software-fixture.html',html);

const profile=await mkdtemp(join(tmpdir(),'cr101-sw-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,seq=0;const pending=new Map(),errors=[],result={time:new Date().toISOString(),scope:'software component (isolated page)',checks:[],shots:[]};
const ok=(name,detail)=>result.checks.push({name,pass:true,detail});
try{
  let port;for(let i=0;i<120&&!port;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{await delay(100);}}
  assert.ok(port,'Chrome failed to start');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  const cdp=(method,params={})=>new Promise((r,j)=>{const id=++seq;const t=setTimeout(()=>j(Error(method+' timeout')),60000);pending.set(id,m=>{clearTimeout(t);m.error?j(Error(JSON.stringify(m.error))):r(m.result);});ws.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:'file:///'+join(process.cwd(),'docs/tmp/cr101-software-fixture.html').replace(/\\/g,'/')});
  for(let i=0;i<120;i++){if(await js('document.readyState==="complete"&&!!window.__mounted'))break;await delay(100);}
  await js('new Promise(r=>setTimeout(r,400))');

  const bar=key=>js(`(()=>{const s=document.getElementById('slot-'+${JSON.stringify(key)});const n=s.querySelector('.chat-stats');return n?{text:n.textContent.replace(/\\s+/g,' ').trim(),triggers:n.querySelectorAll('[data-chat-overlay-trigger]').length}:null})()`);
  const h=key=>js(`Math.round(document.getElementById('slot-${key}').getBoundingClientRect().height)`);

  // 1 已知数据
  const known=await bar('known');
  assert.ok(known&&known.text.includes('4 轮 17 步 · 148 tok/s'),JSON.stringify(known));
  assert.ok(known.text.includes('tok · 缓存 ')&&!known.text.includes('缓存命中'),known.text);
  assert.equal(known.triggers,3);
  ok('已知数据三组齐全且文案为「缓存」',known.text);

  // 2 全空：真实 DOM 不渲染，且与"完全不挂载"等高
  assert.equal(await bar('empty'),null,'空态不渲染统计条');
  assert.equal(await js(`document.querySelectorAll('#slot-empty *').length`),0,'空态不产生任何节点');
  const hEmpty=await h('empty'),hBlank=await h('blank');
  assert.equal(hEmpty,hBlank,`空态高度应等于不挂载基准（${hEmpty} vs ${hBlank}）`);
  ok('空态在真实布局中不占位',`空态 ${hEmpty}px = 基准 ${hBlank}px`);
  const hKnown=await h('known');
  assert.ok(hKnown>hEmpty,`有数据时才占位（${hKnown} > ${hEmpty}）`);
  ok('有数据时才出现统计行',`${hKnown}px > ${hEmpty}px`);

  // 3 只有轮次
  const partial=await bar('partial');
  assert.equal(partial.text,'4 轮',partial.text);
  assert.equal(partial.triggers,1);
  ok('只有轮次时只显示轮次与一个入口',partial.text);

  // 4 可信零值
  const zero=await bar('zero');
  assert.ok(zero.text.includes('0 轮 0 步 · 0 tok/s'),zero.text);
  assert.ok(zero.text.includes('0 tok'),zero.text);
  assert.equal(zero.triggers,3);
  ok('可信零值全部显示',zero.text);

  // 5 生成中实时（密度估算，带 ~，按 ≥10 取整）
  const live=await bar('live');
  assert.equal(live.text,'1 轮 2 步 · ~126 tok/s',live.text);
  ok('生成中实时估算带 ~ 前缀且取整',live.text);

  // 6 生成中优先实时值，权威值不并列
  const beat=await bar('liveBeatsAuthority');
  assert.equal(beat.text,'1 轮 2 步 · ~98 tok/s',beat.text);
  assert.doesNotMatch(beat.text,/148/,'实时值在场时不显示权威结算值');
  assert.equal((beat.text.match(/tok\/s/g)||[]).length,1,'两种口径不并列');
  ok('实时值优先且不与权威值并列',beat.text);

  // 7 非法值不产生数值
  const invalid=await bar('invalid');
  if(invalid){assert.doesNotMatch(invalid.text,/NaN|Infinity|undefined|—/);}
  ok('非法值不渲染为数值',invalid?invalid.text:'（整条省略）');

  // 8 :empty 防御与滚动不受影响
  const guard=await js(`(()=>{const d=document.createElement('div');d.className='chat-stats cr074-stats';document.body.appendChild(d);const disp=getComputedStyle(d).display;d.remove();return disp})()`);
  assert.equal(guard,'none','空容器被 :empty 隐藏，不留占位');
  const ov=await js(`(()=>{const c=getComputedStyle(document.querySelector('#slot-known .chat-stats'));return c.overflowX+'/'+c.overflowY})()`);
  assert.equal(ov,'visible/visible','统计条自身不是滚动容器');
  ok('UI-SCROLL-001：空态防御与滚动不变',`empty→${guard}；overflow→${ov}`);

  // 9 截图
  const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(OUT,name+'.png'),Buffer.from(r.data,'base64'));result.shots.push(name+'.png');};
  await shot('01-all-cases');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:true});
  await shot('02-narrow-cases');

  assert.equal(errors.length,0,errors.join('\n'));ok('运行时异常','0');
  result.status='passed';
}catch(e){result.status='failed';result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{result.exceptions=errors;result.fingerprints={StatsBar:createHash('sha256').update(source).digest('hex'),'stats-bar.css':createHash('sha256').update(css).digest('hex')};await writeFile(join(OUT,'result.json'),JSON.stringify(result,null,2));ws?.close();chrome.kill();}
console.log(JSON.stringify(result,null,2));
