/** CR-082 软件页签条放大截图（交付用对照图）。
 * 用法：先 `npx vite --port 1420 --strictPort`，再 `node scripts/shot-cr082-software-tab.mjs`
 * 输出：docs/Test/screenshots/cr082-software/tab-zoom-1440.png（3× 像素密度）
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const APP = process.env.CR082_APP || "http://127.0.0.1:1420/?preview=design";
const OUT = resolve("docs/Test/screenshots/cr082-software");
mkdirSync(OUT, { recursive: true });
const CDP = 9463;
const profile = join(tmpdir(), "edge-cr082-zoom-" + Date.now());
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
let proc = null;
for (const exe of EDGE) {
  try {
    proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
    break;
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 120 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"); } catch {}
  if (!page) await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 3, mobile: false });
await send("Page.navigate", { url: APP });
for (let i = 0; i < 100; i++) { if (await evalJs(`!!document.querySelector('.nav-item, nav')`).catch(() => false)) break; await sleep(300); }
await sleep(1500);
await evalJs(`(() => { const b=[...document.querySelectorAll('button,a')].find(e=>(e.textContent||'').trim()==='项目管理'); if(b) b.click(); return true; })()`);
await sleep(900);
await evalJs(`(() => { const r=document.querySelector('.nc-list-row, .proj-card, [data-project]'); if(r) r.click(); return true; })()`);
await sleep(1200);
await evalJs(`(() => { const t=document.querySelector('.pw-tab.wb-tab-icon'); if(t && t.getAttribute('aria-selected')!=='true') t.click(); return true; })()`);
await sleep(600);
const clip = await evalJs(`(() => { const el=document.querySelector('.pw-top'); const r=el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`);
const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: clip.x - 2, y: clip.y - 2, width: Math.min(560, clip.width) + 4, height: clip.height + 4, scale: 1 }, captureBeyondViewport: true });
writeFileSync(join(OUT, "tab-zoom-1440.png"), Buffer.from(shot.data, "base64"));
console.log(JSON.stringify({ ok: true, clip }, null, 2));
ws.close(); proc.kill();
