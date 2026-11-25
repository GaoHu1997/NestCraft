// CR-079：验证 CLI 模式模型可选（含弹层候选），并截图。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const OUT = 'docs/Test/screenshots/cr079-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr079m-'));
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
  const shot = async name => { await frame(); const r = await cdp('Page.captureScreenshot', { format:'png' }); await writeFile(join(OUT, name+'.png'), Buffer.from(r.data,'base64')); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(join(process.cwd(),'docs/UI/仿真原型UI.html')).href });
  await wait('document.readyState==="complete" && !!window.UI && !!window.AIPanel');
  await js(`(()=>{const p=UI.D.projects.find(x=>x.kind==='code')||UI.D.projects[0];UI.openWindow('project',p.id,p.name);UI.store.projectTab='workbench';UI.render();})()`); await delay(800);
  await wait('!!document.querySelector(".ai-chip.model")');
  const st = await js(`(()=>{const b=document.querySelector('.ai-chip.model');return {disabled:b.disabled, text:b.textContent.replace(/\\s+/g,' ').trim(), title:b.title, cli:!!document.querySelector('[data-act="ai-cli"]')};})()`);
  await js(`document.querySelector('.ai-chip.model').click()`); await wait('!!document.querySelector("[data-ai-popup=model]")');
  const pop = await js(`(()=>{const p=document.querySelector('[data-ai-popup=model]');return {providers:[...p.querySelectorAll('.provider-row')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()), models:[...p.querySelectorAll('.model-row .mr-name')].map(x=>x.textContent.trim()), levels:[...p.querySelectorAll('.level-labels button')].map(x=>x.textContent.trim())};})()`);
  await shot('06-cli-model-picker');
  await writeFile(join(OUT,'model-result.json'), JSON.stringify({ trigger: st, popup: pop, errors }, null, 2));
  console.log(JSON.stringify({ ok: !st.disabled && pop.models.length > 0 && errors.length === 0, trigger: st, popup: pop, errors }, null, 2));
} catch (e) { console.error(e.stack); process.exitCode = 1; } finally { ws?.close(); chrome.kill(); }
