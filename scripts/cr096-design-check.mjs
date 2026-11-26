// CR-096 设计稿验证：实际渲染唯一原型入口，逐项校验 5 处校正并截图。
// 仅读设计资源；不启动正式软件、不改源码。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const OUT = 'docs/Test/screenshots/cr096-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr096-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws, seq = 0; const pending = new Map(), errors = [];
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { await delay(100); }
  }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(x => x.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => j(Error(method + ' timeout')), 20000);
    pending.set(id, m => { clearTimeout(t); m.error ? j(Error(JSON.stringify(m.error))) : r(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async e => {
    const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const wait = async e => { for (let i = 0; i < 120; i++) { if (await js(e)) return; await delay(100); } throw Error('timeout ' + e); };
  const clickText = t => js(`(()=>{const a=[...document.querySelectorAll('button,a,[role=button],article[aria-label],[role=tab]')].filter(e=>e.getClientRects().length);const e=a.find(e=>(e.getAttribute('aria-label')||'')===${JSON.stringify(t)})||a.find(e=>(e.textContent||'').trim()===${JSON.stringify(t)})||a.find(e=>(e.textContent||'').includes(${JSON.stringify(t)})&&e.textContent.length<40);if(!e)throw Error('missing '+${JSON.stringify(t)});e.click();})()`);
  const shot = async (name, sel) => {
    await frame();
    let clip;
    if (sel) clip = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:r.width+16,height:r.height+16,scale:1};})()`);
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    return name;
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(join(process.cwd(), 'docs/UI/仿真原型UI.html')).href });
  await wait('document.readyState==="complete" && !!window.UI && !!window.AIPanel');

  // 进入项目 → 打开会话区
  await clickText('项目管理'); await delay(600);
  await js(`(()=>{const c=document.querySelector('article.proj-card')||document.querySelector('.proj-card');if(!c)throw Error('no project card');c.click();})()`); await delay(900);
  if (!(await js('!!document.querySelector(".ai-scroll, #wb-scroll")'))) {
    await js(`(()=>{const b=[...document.querySelectorAll('[data-act],[aria-label]')].find(e=>/AI|会话|侧栏/.test((e.getAttribute('aria-label')||'')+(e.title||'')));if(b)b.click();})()`); await delay(600);
  }
  await wait('!!document.querySelector("#ai-scroll, #wb-scroll")');

  const results = {};
  const probe = async label => {
    const r = {};
    // R1：助手正文与用户气泡字号
    r.R1 = await js(`(()=>{
      const sc=document.querySelector('#ai-scroll, #wb-scroll');
      const user=sc&&sc.querySelector('.msg-user-block');
      const text=sc&&sc.querySelector('.msg.assistant .text');
      const px=el=>el?parseFloat(getComputedStyle(el).fontSize):null;
      return { userPx: px(user), assistantPx: px(text), equal: px(user)===px(text) && px(text)===12.5 };
    })()`);
    // R3：消息区背景应与面板一致（无独立灰底）
    r.R3 = await js(`(()=>{
      const sc=document.querySelector('#ai-scroll, #wb-scroll');
      const panel=sc?sc.closest('.ai-panel, .wb-conv, .wb-page, aside, section'):null;
      const bg=el=>el?getComputedStyle(el).backgroundColor:null;
      return { scrollBg: bg(sc), sameAsPanel: panel? bg(sc)===bg(panel): null, panelBg: bg(panel) };
    })()`);
    // R4：帽子无白条——帽子顶边与卡片顶边重合，帽子为灰底、铺满宽度
    r.R4 = await js(`(()=>{
      const sc=document.querySelector('#ai-scroll, #wb-scroll');
      const scope=sc?sc.closest('.wb-conv, .ai-panel')||document:document;
      const card=scope.querySelector('.ai-composer');
      const hat=scope.querySelector('.ai-hat');
      if(!card||!hat) return { missing:true };
      const c=card.getBoundingClientRect(), h=hat.getBoundingClientRect();
      const cs=getComputedStyle(card);
      return { gapTop: Math.round(h.top-c.top), hatBg: getComputedStyle(hat).backgroundColor, cardBg: cs.backgroundColor, cardPadTop: cs.paddingTop, cardBorderTop: cs.borderTopWidth, hatIsFirstChild: card.firstElementChild===hat, hatWidthRatio: Math.round(h.width/c.width*100) };
    })()`);
    // R2：轮次概览浮框存在且可读
    r.R2 = await js(`(()=>{
      const nav=document.querySelector('.c96-turnnav');
      if(!nav) return { missing:true };
      const item=nav.querySelector('.c96-turnnav-item');
      const label=item?item.querySelector('.c96-turnnav-label'):null;
      const summary=label?label.querySelector('.c96-turnnav-summary'):null;
      return { items: nav.querySelectorAll('.c96-turnnav-item').length, labelFontPx: label?parseFloat(getComputedStyle(label).fontSize):null, maxWidth: label?getComputedStyle(label).maxWidth:null, summaryText: summary?summary.textContent.trim():null };
    })()`);
    // R5：工作台页签下侧栏开关不可见；其它页签可见
    r.R5 = await js(`(()=>{
      const btn=document.querySelector('.pw-ai-toggle, .ai-toggle-btn');
      const onWb=document.body.classList.contains('wb-active');
      if(!btn) return { onWorkbench:onWb, present:false, visible:false, ok:onWb };
      return { onWorkbench:onWb, present:true, display:getComputedStyle(btn).display, visible: btn.getClientRects().length>0, ok: onWb ? btn.getClientRects().length===0 : btn.getClientRects().length>0 };
    })()`);
    results[label] = r;
  };

  await probe('sidebar');

  // 切到工作台页签，再测一次：布局不同，R4/R5 需分别核实
  const switched = await js(`(()=>{const t=[...document.querySelectorAll('[role=tab],button')].find(e=>/工作台/.test(e.textContent||'')&&e.getClientRects().length);if(!t)return false;t.click();return true;})()`);
  if (switched) { await delay(900); await wait('!!document.querySelector("#wb-scroll, #ai-scroll")'); await probe('workbench'); }

  // 诊断：浮框与实际裁剪容器的几何关系
  const diag = await js(`(()=>{
    const l=document.querySelector('.c96-turnnav-label');
    const nav=document.querySelector('.c96-turnnav');
    if(!l||!nav) return {missing:true};
    // 走真实交互路径：派发 mouseenter 触发 CR096 的 fixed 定位，再显示以记录几何
    l.closest('.c96-turnnav-item').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
    l.style.opacity='1'; l.style.visibility='visible';
    const cs0=getComputedStyle(l);
    let anc=[], el=l.parentElement;
    while(el && el!==document.body){ const st=getComputedStyle(el); if(st.transform!=='none'||st.filter!=='none'||st.perspective!=='none'||st.contain!=='none'||st.willChange!=='auto') anc.push({cls:el.className,tf:st.transform,ct:st.contain,wc:st.willChange}); el=el.parentElement; }
    const lb=l.getBoundingClientRect(), nb=nav.getBoundingClientRect();
    const cs=getComputedStyle(l);
    const item0=l.closest('.c96-turnnav-item');
    const ib0=item0.getBoundingClientRect();
    const idx=document.querySelector('.c96-turnnav-idx');
    const ib=idx?idx.getBoundingClientRect():null;
    return { item:{left:Math.round(ib0.left),right:Math.round(ib0.right),top:Math.round(ib0.top),h:Math.round(ib0.height)}, labelPos:{position:cs0.position,left:cs0.left,top:cs0.top}, ancestors:anc, label:{w:Math.round(lb.width),h:Math.round(lb.height),left:Math.round(lb.left),top:Math.round(lb.top),bottom:Math.round(lb.bottom)}, idx:{top:ib?Math.round(ib.top):null,h:ib?Math.round(ib.height):null,text:idx?idx.textContent:null}, nav:{w:Math.round(nb.width),left:Math.round(nb.left),right:Math.round(nb.right),top:Math.round(nb.top),bottom:Math.round(nb.bottom),scrollTop:nav.scrollTop,scrollH:nav.scrollHeight,clientH:nav.clientHeight}, navOverflowX:getComputedStyle(nav).overflowX, navOverflowY:getComputedStyle(nav).overflowY, labelBg:cs.backgroundColor, labelMaxW:cs.maxWidth, navScrollW:nav.scrollWidth, navClientW:nav.clientWidth, insideNav: lb.left>=nb.left-1 && lb.right<=nb.right+1 };
  })()`);
  results.diag = diag;
  const shots = [];
  shots.push(await shot('01-chat-workbench', '#ai-scroll, #wb-scroll'));

  // 悬停浮框：CSS :hover 无法直接触发，临时置为可见以记录真实尺寸与文本
  await js(`(()=>{const l=document.querySelector('.c96-turnnav-label');if(l){l.closest('.c96-turnnav-item').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));l.style.opacity='1';l.style.visibility='visible';}})()`);
  // 裁剪范围取刻度 + 浮框的并集，否则只会截到刻度条窄边
  const labelClip = await js(`(()=>{
    const nav=document.querySelector('.c96-turnnav');
    const label=document.querySelector('.c96-turnnav-label');
    if(!nav||!label) return null;
    const a=nav.getBoundingClientRect(), b=label.getBoundingClientRect();
    const x=Math.max(0, Math.min(a.left,b.left)-16), y=Math.max(0, Math.min(a.top,b.top)-16);
    return { x, y, width: Math.max(a.right,b.right)-x+16, height: Math.max(a.bottom,b.bottom)-y+16, scale:2 };
  })()`);
  if (labelClip) {
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: labelClip });
    await writeFile(join(OUT, '02-turnnav-label.png'), Buffer.from(r.data, 'base64'));
    shots.push('02-turnnav-label');
  }
  await js(`(()=>{const l=document.querySelector('.c96-turnnav-label');if(l){l.style.opacity='';l.style.visibility='';}})()`);
  shots.push(await shot('03-composer-hat', '.ai-composer-wrap'));

  // 暗色主题：正文/背景/帽子在深色下仍需一致
  await js(`(()=>{document.documentElement.setAttribute('data-theme','dark');})()`);
  await delay(400);
  const dark = await js(`(()=>{
    const sc=document.querySelector('#ai-scroll, #wb-scroll');
    const card=sc&&sc.closest('.wb-conv, .ai-panel')||document;
    const hat=document.querySelector('.ai-hat'), composer=card.querySelector('.ai-composer');
    const px=el=>el?parseFloat(getComputedStyle(el).fontSize):null;
    return { scrollBg:getComputedStyle(sc).backgroundColor, hatBg:hat?getComputedStyle(hat).backgroundColor:null, assistantPx:px(sc.querySelector('.msg.assistant .text')), userPx:px(sc.querySelector('.msg-user-block')), hatGap: hat&&composer? Math.round(hat.getBoundingClientRect().top-composer.getBoundingClientRect().top):null };
  })()`);
  results.dark = dark;
  // 浮框在暗色下同样可读
  await js(`(()=>{const l=document.querySelector('.c96-turnnav-label');if(l){l.closest('.c96-turnnav-item').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));l.style.opacity='1';l.style.visibility='visible';}})()`);
  shots.push(await shot('04-turnnav-dark', '.c96-turnnav-label'));
  await js(`(()=>{const l=document.querySelector('.c96-turnnav-label');if(l){l.style.opacity='';l.style.visibility='';}})()`);
  await js(`(()=>{document.documentElement.setAttribute('data-theme','light');})()`);
  await delay(300);

  // 窄屏 390：消息区与浮框不越界
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(600);
  const narrow = await js(`(()=>{
    const nav=document.querySelector('.c96-turnnav');
    if(!nav) return {missing:true};
    const nb=nav.getBoundingClientRect();
    return { navLeft:Math.round(nb.left), navRight:Math.round(nb.right), inViewport: nb.left>=0 && nb.right<=390 };
  })()`);
  results.narrow = narrow;
  shots.push(await shot('05-narrow', '#ai-scroll, #wb-scroll'));

  await writeFile(join(OUT, 'result.json'), JSON.stringify({ results, shots, errors, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ results, shots, errors }, null, 2));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
