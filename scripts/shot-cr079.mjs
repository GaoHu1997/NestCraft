// CR-079 设计稿截图：会话框顶部“帽子”运行栏（CLI/大管家、分支、worktree）。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const OUT = 'docs/Test/screenshots/cr079-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr079-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws, seq = 0; const pending = new Map(), errors = [];
try {
  let port; for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); } catch { await delay(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(x => x.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', ({ data }) => { const m = JSON.parse(data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; const t = setTimeout(() => j(Error(method+' timeout')), 20000); pending.set(id, m => { clearTimeout(t); m.error ? j(Error(JSON.stringify(m.error))) : r(m.result); }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async e => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const wait = async e => { for (let i = 0; i < 120; i++) { if (await js(e)) return; await delay(100); } throw Error('timeout '+e); };
  const clickText = t => js(`(()=>{const a=[...document.querySelectorAll('button,a,[role=button],article[aria-label],[role=tab]')].filter(e=>e.getClientRects().length);const e=a.find(e=>(e.getAttribute('aria-label')||'')===${JSON.stringify(t)})||a.find(e=>(e.textContent||'').trim()===${JSON.stringify(t)})||a.find(e=>(e.textContent||'').includes(${JSON.stringify(t)})&&e.textContent.length<40);if(!e)throw Error('missing '+${JSON.stringify(t)});e.click();})()`);
  const shot = async (name, sel) => { await frame(); let clip; if (sel) clip = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16,scale:1};})()`); const r = await cdp('Page.captureScreenshot', { format:'png', ...(clip?{clip}:{}) }); await writeFile(join(OUT, name+'.png'), Buffer.from(r.data,'base64')); return name; };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(join(process.cwd(),'docs/UI/仿真原型UI.html')).href });
  await wait('document.readyState==="complete" && !!window.UI && !!window.AIPanel && !!window.CR079');
  await clickText('项目管理'); await delay(700);
  await js(`(()=>{const c=document.querySelector('article.proj-card')||document.querySelector('.proj-card');if(!c)throw Error('no project card');c.click();})()`); await delay(1000);
  await js(`(()=>{const t=document.querySelector('.ws-tab.ws-tab-icon[aria-label="工作台"]');if(t) t.click();})()`); await delay(500);
  if(!(await js('!!document.querySelector(".ai-hat")'))){
    await js(`(()=>{const b=[...document.querySelectorAll('[data-act],[aria-label]')].find(e=>/AI|会话|侧栏/.test((e.getAttribute('aria-label')||'')+(e.title||'')));if(b)b.click();})()`); await delay(500);
  }
  await wait('!!document.querySelector(".ai-hat")');
  const hats = await shot('01-hat-cli-workbench', '.ai-composer-wrap');
  const width = await js(`(()=>{const h=document.querySelector('.ai-hat').getBoundingClientRect(),c=document.querySelector('.ai-composer').getBoundingClientRect();return {deltaL:Math.round(h.left-c.left),deltaR:Math.round(c.right-h.right),hatW:Math.round(h.width),comW:Math.round(c.width)};})()`);
  await js(`document.querySelector('.ai-hat-branch').click()`); await wait('!!document.querySelector(".ai-branch-menu")');
  const branches = await js(`[...document.querySelectorAll('.ai-branch-item')].map(b=>b.textContent.trim())`);
  const branchShot = await shot('05-branch-menu');
  await js(`document.querySelector('.ai-branch-item[data-branch]')?.click()`); await frame();
  // 切到大管家
  await js(`document.querySelector('[data-act="ai-runner-set"][data-id="platform"]').click()`); await frame();
  const butler = await js(`(()=>{const h=document.querySelector('.ai-hat');return {hat:!!h, cliChip:!!document.querySelector('[data-act="ai-cli"]'), perm:document.querySelector('.ai-chip.perm')?.textContent.trim()};})()`);
  await shot('02-hat-butler', '.ai-composer-wrap');
  // 打开权限弹层（大管家档位）
  await js(`document.querySelector('.ai-chip.perm').click()`); await wait('!!document.querySelector("[data-ai-popup=perm]")');
  await shot('03-butler-permission', '[data-ai-popup=perm]');
  // worktree 勾选
  await js(`document.querySelector('[data-ai-popup-close=perm]')?.click();const c=document.querySelector('[data-act="ai-worktree"]');c.checked=true;c.dispatchEvent(new Event("change",{bubbles:true}));`); await frame();
  const wt = await js(`document.querySelector('[data-act="ai-worktree"]').checked`);
  await shot('04-worktree-checked', '.ai-composer-wrap');
  await writeFile(join(OUT,'result.json'), JSON.stringify({ shots:[hats,'02-hat-butler','03-butler-permission','04-worktree-checked',branchShot], width, branches, butler, worktreeChecked: wt, errors }, null, 2));
  console.log(JSON.stringify({ ok: errors.length===0, width, branches, butler, worktreeChecked: wt, errors }, null, 2));
} catch (e) { console.error(e.stack); process.exitCode = 1; } finally { ws?.close(); chrome.kill(); }
