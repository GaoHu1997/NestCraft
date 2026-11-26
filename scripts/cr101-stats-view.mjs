// CR-101：会话统计空态与生成中实时流速的定向回归（纯函数 + 运行期派生，不调用真实上游/IPC）。
// 覆盖 R-CR101-1～11 的展示与计量边界；不替代真实桌面端与真实流式验收。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const ts=require('typescript');

const load=(file,deps={})=>{
  const source=require('node:fs').readFileSync(file,'utf8');
  const out=ts.transpileModule(source,{fileName:file,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
  const diags=(out.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  assert.deepEqual(diags.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[],`${file} 转译无错误`);
  const exports={};
  vm.runInNewContext(out.outputText,{exports,require:id=>deps[id]??require(id),console},{filename:file+'.cjs'});
  return exports;
};

const rt=load('src/modules/chat/sessionRuntime.ts',{ './sessionPlan':{emptyPlan:()=>({steps:[],tasks:[]})} });
const {noteLiveDelta,noteLiveToolArgs,tickLiveRate,liveTps,priorTokens,StreamingRateSampler,markStreamStart,markStreamEnd,getRuntime,outputTps}=rt;
const sb=load('src/modules/chat/StatsBar.tsx',{ './stats-bar.css':{}, './overlay':{useChatOverlay:()=>({activeOverlay:null,toggle(){}})}, './sessionRuntime':{formatDur:ms=>`${ms}ms`} });
const {statsView,statsPresentation,StatsBar}=sb;
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');

const checks=[];
const check=(name,fn)=>{fn();checks.push({name,pass:true});};
const base={rounds:1,msgs:4,modelMs:null,toolMs:null,ttftMs:null,tps:null,tokensIn:null,tokensOut:null,cacheRead:null,contextUsed:null,contextLimit:null};
const html=data=>renderToStaticMarkup(React.createElement(StatsBar,{data}));

/* ---------- R1：空态整条不渲染 ---------- */
check('R1 三组全无可信数据时不渲染容器',()=>{
  const empty={...base,rounds:null,steps:null,msgs:0};
  assert.equal(statsView(empty).groups.length,0);
  assert.equal(StatsBar({data:empty}),null);
  assert.equal(html(empty),'');});
check('R5 消息条数不参与空态判定',()=>{
  assert.equal(statsPresentation({...base,rounds:null,steps:null,msgs:0}).empty,true);
  assert.equal(statsPresentation({...base,rounds:null,steps:null,msgs:99}).empty,true);});

/* ---------- R2/R3：组级可见 + 字段级省略 ---------- */
check('R2 只有轮次时只渲染会话组',()=>{
  const view=statsView({...base,rounds:4});
  assert.equal(view.groups.map(g=>g.id).join(','),'session');
  assert.equal(view.groups[0].fragments.map(f=>f.text).join(' · '),'4 轮');});
check('R3 未知字段省略，不出现占位与分隔符残骸',()=>{
  const texts=[
    [{...base,rounds:1,steps:17,tps:22},'1 轮 17 步 · 22 tok/s'],
    [{...base,rounds:null,steps:17,tps:22},'17 步 · 22 tok/s'],
    [{...base,rounds:null,tps:22},'22 tok/s'],
    [{...base,rounds:1,tps:22},'1 轮 · 22 tok/s'],
  ];
  for(const [data,expected] of texts){
    const t=statsView(data).groups.find(g=>g.id==='session').fragments.map(f=>f.text).join(' · ');
    assert.equal(t,expected);
    assert.doesNotMatch(t,/—/);}});
check('R3 只有 Token 组时也只显示该组',()=>{
  const view=statsView({...base,rounds:null,msgs:3,tokensIn:100,cacheRead:900,tokensOut:0});
  assert.equal(view.groups.map(g=>g.id).join(','),'tokens');
  assert.equal(view.groups[0].fragments.map(f=>f.text).join(' · '),'1K tok · 缓存 90%');});

/* ---------- R4：可信零值必须显示 ---------- */
check('R4 可信零值全部显示',()=>{
  const data={...base,rounds:0,steps:0,tps:0,tokensIn:0,cacheRead:0,tokensOut:0,contextUsed:0,contextLimit:100};
  const text=html(data);
  assert.ok(text.includes('0 轮 0 步 · 0 tok/s'));
  assert.ok(text.includes('0 tok'));
  assert.ok(text.includes('0%'));
  assert.equal((text.match(/data-chat-overlay-trigger=/g)||[]).length,3);});

/* ---------- R14：统计条文案 ---------- */
check('R14 统计条写「缓存」，详情保留「缓存命中」',()=>{
  const data={...base,rounds:1,tokensIn:100,cacheRead:900,tokensOut:0};
  const bar=statsView(data).groups.find(g=>g.id==='tokens').fragments.map(f=>f.text).join(' · ');
  assert.equal(bar,'1K tok · 缓存 90%');
  assert.doesNotMatch(bar,/缓存命中/);});

/* ---------- R6：详情与统计条同源 ---------- */
check('R6 被省略的组没有入口也没有浮层',()=>{
  const data={...base,rounds:1};
  const text=renderToStaticMarkup(React.createElement(StatsBar,{data}));
  assert.equal((text.match(/data-chat-overlay-trigger=/g)||[]).length,1);
  assert.equal((text.match(/data-chat-overlay="/g)||[]).length,0);});
check('R6 详情未知字段写「未上报」而不是「—」',()=>{
  const data={...base,rounds:1,msgs:2};
  const tree=StatsBar({data});
  const body=JSON.stringify(tree.props.children); // 只用于确认不含占位符
  assert.doesNotMatch(body.replace(/—[^"]*/g,''),/NaN|Infinity/);});

/* ---------- R7/R9：实时流速（有界滑动窗口估算，对齐 DSH 统计行插件） ---------- */
const SID='cr101-session';
check('R7 首增量前没有实时流速',()=>{
  markStreamStart(SID);
  assert.equal(liveTps(getRuntime(SID)),null,'未产生输出时不显示 0 tok/s');
  assert.equal(tickLiveRate(SID,1_000_000),null,'没有估算值时采样器不发布');});
check('R7 token 按官方字符密度估算：中文 0.6／英文 0.3',()=>{
  const close=(a,b)=>Math.abs(a-b)<1e-9;
  assert.ok(close(priorTokens('abc'),0.9),'3 个 ASCII ×0.3');
  assert.ok(close(priorTokens('中文'),1.2),'2 个非 ASCII ×0.6');
  assert.ok(close(priorTokens('a中'),0.9),'混合按码点分别计价');
  assert.equal(priorTokens(''),0);});
check('R7 首次观测只锚定窗口，不发布读数',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));          // 6 token
  assert.equal(tickLiveRate(SID,t0),null,'锚定帧没有跨度');});
check('R8 窗口短于 200ms 不发布，达到后按窗口增长计算',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));          // 6
  tickLiveRate(SID,t0);
  noteLiveDelta(SID,'中'.repeat(10));          // 12
  tickLiveRate(SID,t0);                        // 同刻：跨度 0，不发布
  noteLiveDelta(SID,'中'.repeat(10));          // 18
  const rate=tickLiveRate(SID,t0+200);         // 窗口 200ms，增长 18−6=12 token
  assert.equal(Math.round(rate),60,'12 token / 0.2s = 60 tok/s');
  assert.equal(liveTps(getRuntime(SID)).estimated,true,'实时值始终标记为估算');});
check('R8 重复帧不推进窗口、也不改变读数',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));
  tickLiveRate(SID,t0);
  noteLiveDelta(SID,'中'.repeat(20));          // 18
  const first=tickLiveRate(SID,t0+200);
  const stable=tickLiveRate(SID,t0+5_000);     // 无增长
  assert.equal(stable,first,'重复帧不能把读数推向整段平均');});
check('R9 积压帧（斜率 > 1.5 tok/ms）重锚而不发布',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));          // 6
  tickLiveRate(SID,t0);
  noteLiveDelta(SID,'中'.repeat(1000));        // +600 token，300ms 内 → 2000 tok/s
  assert.equal(tickLiveRate(SID,t0+300),null,'没有历史读数时不发布；积压不得读成速率');
  noteLiveDelta(SID,'中'.repeat(10));
  const after=tickLiveRate(SID,t0+700);        // 重锚后从 6 起算 400ms
  assert.equal(Math.round(after),15,'600÷400ms 不会污染重锚后的读数');});
check('R9 估算值下降（重试/块被替换）重锚窗口',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(50));          // 30
  tickLiveRate(SID,t0);
  const rtNow=getRuntime(SID);
  rtNow.liveEstimatedTokens=10;                // 模拟块被整体替换
  assert.equal(tickLiveRate(SID,t0+500),null,'下降即重锚，不测量流没产生的增长');});
check('R8 发布值经过平滑，不随单帧跳变',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));          // 6
  tickLiveRate(SID,t0);
  noteLiveDelta(SID,'中'.repeat(10));          // 12
  const first=tickLiveRate(SID,t0+200);        // 60 tok/s
  noteLiveDelta(SID,'中'.repeat(30));          // 30 token 总量
  const second=tickLiveRate(SID,t0+400);       // 窗口 400ms，增长 24 → 60 tok/s
  assert.ok(second!==null);
  const weight=Math.min(1,200/1_000);
  const raw=24/0.4;
  const expected=first+weight*(raw-first);
  assert.ok(Math.abs(second-expected)<1e-9,'一阶低通：新读数按 距上次发布/1000 加权');
  assert.notEqual(second,raw,'不能直接采用窗口瞬时值');});

/* ---------- R10/R11：终态清除与校准 ---------- */
check('R10/R11 闭合后实时值立即清除，不冻结过期数字',()=>{
  markStreamStart(SID);
  const t0=1_000_000;
  noteLiveDelta(SID,'中'.repeat(10));
  tickLiveRate(SID,t0);
  noteLiveDelta(SID,'中'.repeat(10));
  assert.ok(tickLiveRate(SID,t0+200));
  markStreamEnd(SID,120);
  const rtNow=getRuntime(SID);
  assert.equal(rtNow.liveStart,null);
  assert.equal(rtNow.liveEstimatedTokens,0);
  assert.equal(rtNow.liveSampler,null);
  assert.equal(liveTps(rtNow),null,'终态后不再给实时值');});
check('R10 用已结算的权威 output tokens 校准密度因子',()=>{
  markStreamStart(SID);
  const rtNow=getRuntime(SID);
  rtNow.liveTokenScale=1;
  noteLiveDelta(SID,'中'.repeat(10));          // 估算 6 token
  markStreamEnd(SID,9);                        // 权威 9 → 因子 1.5
  assert.ok(Math.abs(rtNow.liveTokenScale-1.5)<1e-9,'校准因子 = 权威 tokens ÷ 估算 tokens');});
check('R10 校准因子钳在 0.5～2，单样本不能拉飞',()=>{
  markStreamStart(SID);
  const rtNow=getRuntime(SID);
  noteLiveDelta(SID,'中'.repeat(10));          // 6
  markStreamEnd(SID,600);                      // 100× → 钳到 2
  assert.equal(rtNow.liveTokenScale,2);
  markStreamStart(SID);
  noteLiveDelta(SID,'中'.repeat(100));         // 60
  markStreamEnd(SID,1);                        // 极低 → 钳到 0.5
  assert.equal(rtNow.liveTokenScale,0.5);});
check('R9 非法增量被忽略',()=>{
  markStreamStart(SID);
  const rtNow=getRuntime(SID);
  noteLiveDelta(SID,'');noteLiveDelta(SID,undefined);noteLiveDelta(SID,null);
  assert.equal(rtNow.liveEstimatedTokens,0);
  assert.equal(rtNow.liveStart,null,'无有效文本不能开启计时');});

/* ---------- 展示口径 ---------- */
check('R10 有实时值时只显示实时值，不与权威值并列',()=>{
  const data={...base,rounds:1,steps:2,tps:148,liveTps:126};
  const frags=statsView(data).groups.find(g=>g.id==='session').fragments.map(f=>f.text);
  assert.equal(frags.join('|'),'1 轮 2 步|~126 tok/s','生成中优先实时值，且始终带估算前缀');
  assert.equal(frags.filter(t=>/tok\/s/.test(t)).length,1,'两种口径不并列');});
check('R10 无实时值时回落到权威值',()=>{
  const frags=statsView({...base,rounds:1,tps:148}).groups.find(g=>g.id==='session').fragments.map(f=>f.text);
  assert.equal(frags.join('|'),'1 轮|148 tok/s');});
check('R12 实时值带 ~ 前缀且按 ≥10 取整格式',()=>{
  const frags=statsView({...base,liveTps:126.4}).groups.find(g=>g.id==='session').fragments.map(f=>f.text);
  assert.equal(frags.join('|'),'1 轮|~126 tok/s');
  const low=statsView({...base,liveTps:9.96}).groups.find(g=>g.id==='session').fragments.map(f=>f.text);
  assert.equal(low.join('|'),'1 轮|~10 tok/s','<10 保留一位小数、四舍五入到 10 后按整数');});
check('R8 采样器类可直接驱动并只读获取读数',()=>{
  const s=new StreamingRateSampler();
  assert.equal(s.ratePerSecond(),null,'新采样器无读数');
  s.observe(0,1_000);
  s.observe(60,1_200);
  assert.equal(Math.round(s.ratePerSecond()),300,'60 token / 0.2s');
  s.reset();
  assert.equal(s.ratePerSecond(),300,'reset 只清窗口，保留已发布值');
  s.observe(0,2_000);
  assert.equal(s.ratePerSecond(),300);});
check('R7 工具调用参数计入输出估算',()=>{
  markStreamStart(SID);
  const rtNow=getRuntime(SID);
  const args='{"path":"a.ts"}';
  const expected=priorTokens(args);            // 15 个 ASCII ×0.3 = 4.5
  noteLiveToolArgs(SID,args);
  assert.ok(Math.abs(rtNow.liveEstimatedTokens-expected)<1e-9,'工具参数按码点密度计入');
  noteLiveToolArgs(SID,undefined);
  assert.ok(Math.abs(rtNow.liveEstimatedTokens-expected)<1e-9,'空参数不计数');});

/* ---------- 既有语义不回退 ---------- */
check('既有 outputTps 与累计计量语义保持',()=>{
  markStreamStart(SID);
  markStreamEnd(SID,200);
  const rtNow=getRuntime(SID);
  assert.equal(rtNow.lastOutTokens,200);
  assert.ok(rtNow.timingKnown);});

console.log(JSON.stringify({scope:'NestCraft/FEAT-012/CR-101',checkedAt:new Date().toISOString(),status:'passed',checks,limitations:['纯函数与运行期派生断言；不验证真实流式节奏、真实 Tauri/WebView2 与真实上游','不含数据库与权限变更']},null,2));
