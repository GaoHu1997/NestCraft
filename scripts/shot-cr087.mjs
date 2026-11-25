// CR-087 设计稿截图：顶部面包屑第一段由「个人工作台」文字改为小房子（home）图标。
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const OUT = 'docs/Test/screenshots/cr087-design';
await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'cr087-'));
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
  const shot = async (name, sel) => { await frame(); let clip; if (sel) clip = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.max(0,r.x-6),y:Math.max(0,r.y-6),width:Math.min(r.width+12, innerWidth),height:r.height+12,scale:1};})()`); const r = await cdp('Page.captureScreenshot', { format:'png', ...(clip?{clip}:{}) }); await writeFile(join(OUT, name+'.png'), Buffer.from(r.data,'base64')); return name; };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(join(process.cwd(),'docs/UI/仿真原型UI.html')).href });
  await wait('document.readyState==="complete" && !!window.UI');
  await delay(600);

  const probe = () => js(`(()=>{
    const ctx = document.querySelector('.top-context');
    const chip = document.querySelector('.chip-workspace');
    const use = chip && chip.querySelector('use');
    const r = chip ? chip.getBoundingClientRect() : null;
    const cs = chip ? getComputedStyle(chip) : null;
    return {
      contextText: ctx ? (ctx.textContent||'').replace(/\\s+/g,' ').trim() : null,
      chipText: chip ? (chip.textContent||'').trim() : null,
      chipLabel: chip ? chip.getAttribute('aria-label') : null,
      chipTitle: chip ? chip.getAttribute('title') : null,
      chipRole: chip ? chip.getAttribute('role') : null,
      iconUse: use ? use.getAttribute('href') : null,
      iconW: chip && chip.querySelector('svg') ? Math.round(chip.querySelector('svg').getBoundingClientRect().width) : null,
      chipW: r ? Math.round(r.width) : null,
      chipH: r ? Math.round(r.height) : null,
      hasGridIcon: !!(chip && chip.querySelector('use[href="#grid"]')),
      bg: cs ? cs.backgroundColor : null
    };
  })()`);

  const home = await probe();
  await shot('01-home-topbar', '.topbar');
  await shot('02-home-context', '.top-context');

  // 打开一个项目，检查面包屑第二段仍是页面名
  await js(`(()=>{const b=[...document.querySelectorAll('button,a,[role=button]')].find(e=>(e.textContent||'').trim()==='项目管理');if(b)b.click();})()`);
  await delay(700);
  await js(`(()=>{const c=document.querySelector('article.proj-card')||document.querySelector('.proj-card');if(c)c.click();})()`);
  await delay(1000);
  const project = await probe();
  await shot('03-project-context', '.top-context');

  await writeFile(join(OUT,'result.json'), JSON.stringify({ home, project, errors }, null, 2));
  console.log(JSON.stringify({ ok: errors.length===0, home, project, errors }, null, 2));
} catch (e) { console.error(e.stack); process.exitCode = 1; } finally { ws?.close(); chrome.kill(); }
