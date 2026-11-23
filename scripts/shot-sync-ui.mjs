/** UI-FEAT-004 软件侧视觉检查：任务页 → 同步视图（仿真夹具）。 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/feat004";
mkdirSync(OUT, { recursive: true });
const list = await (await fetch("http://127.0.0.1:9444/json/list")).json();
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};
const shoot = async (name) => {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(2600);

await evaluate(`(() => { const c=[...document.querySelectorAll('.proj-card,button,a')].find(n=>(n.textContent||'').includes('预约服务')); if(c) c.click(); })()`);
await wait(1200);
await evaluate(`(() => { const t=[...document.querySelectorAll('.pw-tab,button,[role="tab"]')].find(n=>(n.textContent||'').trim()==='任务'); if(t) t.click(); })()`);
await wait(1400);
await evaluate(`(() => { const b=document.querySelector('.pw-ai-toggle'); if(b && b.getAttribute('aria-pressed')==='true') b.click(); })()`);
await wait(700);
const opened = await evaluate(`(() => { const b=document.querySelector('[aria-label="同步批次"]'); if(!b) return 'no-sync'; b.click(); return 'clicked-sync'; })()`);
console.log(opened);
await wait(1600);

const text = await evaluate("document.body.innerText.slice(0, 1100)");
console.log("VISIBLE:\n" + text);
await shoot("software-sync-1440");

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await wait(900);
await shoot("software-sync-390");
ws.close();