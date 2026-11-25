// CR-082 设计稿截图：工作台页签由纯图标改为「电脑图标 + 工作台」文字。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const OUT = 'docs/Test/screenshots/cr082-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr082-'));
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
  await wait('document.readyState==="complete" && !!window.UI && !!window.AIPanel');
  await clickText('项目管理'); await delay(700);
  await js(`(()=>{const c=document.querySelector('article.proj-card')||document.querySelector('.proj-card');if(!c)throw Error('no project card');c.click();})()`); await delay(1000);
  await wait('!!document.querySelector(".ws-tab.ws-tab-icon")');
  await js(`document.querySelector('.ws-tab.ws-tab-icon').click()`); await delay(400);
  const probe = await js(`(()=>{const t=document.querySelector('.ws-tab.ws-tab-icon');const s=t.querySelector('svg');const sp=t.querySelector('span');const r=t.getBoundingClientRect();const rs=s?.getBoundingClientRect();const rp=sp?.getBoundingClientRect();const cs=getComputedStyle(t);return {text:(t.textContent||'').trim(),label:t.getAttribute('aria-label'),selected:t.getAttribute('aria-selected'),tabW:Math.round(r.width),tabH:Math.round(r.height),svgW:rs?Math.round(rs.width):null,svgH:rs?Math.round(rs.height):null,gap:cs.gap,padding:cs.padding,hasSpan:!!sp,spanText:sp?sp.textContent.trim():null,iconUse:s?.querySelector('use')?.getAttribute('href'),svgCenterY:rs?Math.round(rs.y+rs.height/2):null,spanCenterY:rp?Math.round(rp.y+rp.height/2):null};})()`);
  await shot('01-workbench-tab-active', '.ws-tabs');
  await shot('02-project-header', '.ws-page, .page, body');
  await js(`(()=>{const b=document.querySelector('.ws-tab[data-tab="requirements"]');if(b)b.click();})()`); await delay(500);
  await shot('03-other-tab-active', '.ws-tabs');
  await writeFile(join(OUT,'result.json'), JSON.stringify({ shots:['01-workbench-tab-active','02-project-header','03-other-tab-active'], probe, errors }, null, 2));
  console.log(JSON.stringify({ ok: errors.length===0, probe, errors }, null, 2));
} catch (e) { console.error(e.stack); process.exitCode = 1; } finally { ws?.close(); chrome.kill(); }
