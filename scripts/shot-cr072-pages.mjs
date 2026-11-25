/** CR-072：通过 CDP 对隔离设计预览三页截图。用法：node shot-cr072-pages.mjs <url> <outDir> 项目管理 知识库 服务器管理 */
import { mkdirSync, writeFileSync } from "node:fs";
const [, , baseUrl, outDir, ...labels] = process.argv;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9444/json/list")).json();
      const p = list.find((x) => x.type === "page");
      if (p) return p;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP 目标未就绪");
}
const page = await getTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.data, "base64")); console.log("SHOT", name); };
const clickText = (t) => `(() => { const all = [...document.querySelectorAll('button,a,[role=button],[role=tab],.nav-item')]; const el = all.find(e => (e.textContent||'').trim() === ${JSON.stringify(t)}) || all.find(e => (e.textContent||'').trim().includes(${JSON.stringify(t)})); if (!el) throw new Error('找不到 '+${JSON.stringify(t)}); el.click(); return (el.textContent||'').trim().slice(0,30); })()`;
await send("Page.navigate", { url: baseUrl });
await sleep(3000);
const report = [];
await shot("01-home");
for (let i = 0; i < labels.length; i++) {
  try { const v = await evalJs(clickText(labels[i])); await sleep(1300); await shot(`0${i + 2}-${["projects", "knowledge", "servers"][i]}`); report.push({ label: labels[i], ok: true, detail: String(v) }); }
  catch (e) { report.push({ label: labels[i], ok: false, detail: String(e) }); try { await shot(`0${i + 2}-error`); } catch {} }
}
try { report.push({ text: await evalJs("document.body.innerText.slice(0,800)") }); } catch {}
console.log(JSON.stringify(report, null, 2));
process.exit(0);
