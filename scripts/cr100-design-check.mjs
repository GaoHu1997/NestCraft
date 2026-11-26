// CR-100 设计稿验证：在真实渲染的唯一原型上，把 AI 面板宽度分别设为 320/372/480/620，
// 断言运行栏不溢出、分支 chip 可牺牲、长内容不撑破、浮层不越出面板，并截图留证。
// 仅读设计资源；不启动正式软件、不改源码。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const OUT = 'docs/Test/screenshots/cr100-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr100-'));
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
  // 宽窗口：验证「整窗很宽、侧栏很窄」这一关键场景，而不是手机视口。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(join(process.cwd(), 'docs/UI/仿真原型UI.html')).href });
  await wait('document.readyState==="complete" && !!window.UI && !!window.AIPanel');

  await clickText('项目管理'); await delay(600);
  await js(`(()=>{const c=document.querySelector('article.proj-card')||document.querySelector('.proj-card');if(!c)throw Error('no project card');c.click();})()`); await delay(900);
  if (!(await js('!!document.querySelector("#ai-scroll, #wb-scroll")'))) {
    await js(`(()=>{const b=[...document.querySelectorAll('[data-act],[aria-label]')].find(e=>/AI|会话|侧栏/.test((e.getAttribute('aria-label')||'')+(e.title||'')));if(b)b.click();})()`); await delay(600);
  }
  await wait('!!document.querySelector("#ai-scroll, #wb-scroll")');

  // 通过原型自身的 PaneResize 宽度通道调整面板（store.aiWidth 是闭包内变量，
  // 直接改内联样式会被重渲染与 refresh 覆盖）。
  const resizeTo = async width => {
    await js(`(()=>{
      if(!window.PaneResize) throw Error('missing PaneResize');
      const all=window.PaneResize.records instanceof Map?[...window.PaneResize.records.values()]:Object.values(window.PaneResize.records||{});
      const rec=all.find(r=>r&&r.name==='AI 侧栏');
      if(!rec) throw Error('missing AI 侧栏 record');
      window.PaneResize.widths.set(rec.key,${width});
      window.PaneResize.refresh();
    })()`);
    await frame();
  };

  const widths = [320, 372, 480, 620];
  const results = {};
  for (const width of widths) {
    await resizeTo(width);
    results[width] = await js(`(()=>{
      const panel=document.querySelector('.ai-panel');
      const pr=panel.getBoundingClientRect();
      const hat=panel.querySelector('.ai-hat');
      const seg=panel.querySelector('.ai-hat-seg');
      const branch=panel.querySelector('.ai-hat-branch');
      const wt=panel.querySelector('.ai-hat-worktree');
      const scroll=panel.querySelector('.ai-scroll');
      const composer=panel.querySelector('.ai-composer');
      const rect=el=>el?el.getBoundingClientRect():null;
      const inside=(r,p)=>!!r&&r.left>=p.left-0.5&&r.right<=p.right+0.5;
      const hr=rect(hat), sr=rect(seg), br=rect(branch), wr=rect(wt), cr=rect(composer);
      const pre=[...panel.querySelectorAll('.chat-proto-tool pre, .msg .text pre')];
      const overflowPre=pre.filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible').length;
      // 面板容器查询是否生效：读容器宽度与名称
      const cs=getComputedStyle(panel);
      return {
        panelWidth: Math.round(pr.width),
        containerType: cs.containerType,
        containerName: cs.containerName,
        hatInside: inside(hr,pr),
        hatOverflow: hr?Math.round(hr.right-pr.right):null,
        segVisible: !!sr && sr.width>0 && inside(sr,pr),
        branchVisible: !!br && br.width>0,
        branchClipped: br?br.scrollWidth>br.clientWidth+1:null,
        worktreeVisible: !!wr && wr.width>0 && inside(wr,pr),
        composerInside: inside(cr,pr),
        scrollOverflowX: scroll?scroll.scrollWidth-scroll.clientWidth:null,
        panelOverflowX: panel.scrollWidth-panel.clientWidth,
        longPreOverflow: overflowPre,
      };
    })()`);
    await shot(`width-${width}`, '.ai-panel');
  }

  // 深色主题下重复最窄与最宽两档
  await js(`(()=>{document.documentElement.setAttribute('data-theme','dark');const p=document.querySelector('.ai-panel');if(p)p.style.width='320px';})()`);
  await frame();
  results.dark320 = await js(`(()=>{const p=document.querySelector('.ai-panel');const r=p.getBoundingClientRect();const s=p.querySelector('.ai-scroll');return{panelWidth:Math.round(r.width),scrollOverflowX:s?s.scrollWidth-s.clientWidth:null,segVisible:!!p.querySelector('.ai-hat-seg')?.getClientRects().length,worktreeVisible:!!p.querySelector('.ai-hat-worktree')?.getClientRects().length};})()`);
  await shot('dark-320', '.ai-panel');
  await js(`document.documentElement.removeAttribute('data-theme')`);

  // 汇总与判定
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  for (const width of widths) {
    const r = results[width];
    check(`${width}:面板宽度生效`, Math.abs(r.panelWidth - width) <= 2, r.panelWidth);
    check(`${width}:容器查询生效`, r.containerType === 'inline-size', r.containerType);
    check(`${width}:运行栏不溢出`, r.hatInside && r.hatOverflow <= 1, r.hatOverflow);
    check(`${width}:CLI/助理切换可见`, r.segVisible, r.segVisible);
    check(`${width}:worktree 可见`, r.worktreeVisible, r.worktreeVisible);
    check(`${width}:输入卡片不越界`, r.composerInside, r.composerInside);
    check(`${width}:消息区无横向溢出`, r.scrollOverflowX <= 1, r.scrollOverflowX);
    check(`${width}:面板无横向溢出`, r.panelOverflowX <= 1, r.panelOverflowX);
    check(`${width}:长 pre 不撑破`, r.longPreOverflow === 0, r.longPreOverflow);
  }
  check('深色 320 无横向溢出', results.dark320.scrollOverflowX <= 1, results.dark320.scrollOverflowX);
  check('深色 320 关键控件可见', results.dark320.segVisible && results.dark320.worktreeVisible, results.dark320);

  const failed = checks.filter(c => !c.ok);
  const report = { widths, results, checks, failed: failed.length, jsErrors: errors.length, errors };
  await writeFile(join(OUT, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed, jsErrors: errors.length }, null, 2));
  if (failed.length || errors.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
