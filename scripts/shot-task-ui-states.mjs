/** UI-FEAT-019 状态证据：深色与 UI-SCROLL-001 滚动条动态（隔离设计预览）。 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/feat019";
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

// 进入任务页。
await evaluate(`(() => { const c=[...document.querySelectorAll('.proj-card,button,a')].find(n=>(n.textContent||'').includes('预约服务')); if(c) c.click(); })()`);
await wait(1200);
await evaluate(`(() => { const t=[...document.querySelectorAll('.pw-tab,button,[role="tab"]')].find(n=>(n.textContent||'').trim()==='任务'); if(t) t.click(); })()`);
await wait(1400);
// 收起 AI 侧栏。
await evaluate(`(() => { const b=document.querySelector('.pw-ai-toggle'); if(b && b.getAttribute('aria-pressed')==='true') b.click(); })()`);
await wait(700);

// 深色 1440。
await evaluate(`document.documentElement.dataset.theme='dark'`);
await wait(500);
await shoot("software-tasks-dark-1440");

// 滚动条动态：压缩高度让任务列表溢出。
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 600, deviceScaleFactor: 1, mobile: false });
await wait(700);
const scrollable = await evaluate(`(() => {
  const el = document.querySelector('.task-list-pane');
  if (!el) return 'no-list';
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, active: el.classList.contains('scrollbar-active') };
})()`);
console.log("scrollable", JSON.stringify(scrollable));
await shoot("scroll-1-initial");
await evaluate(`(() => {
  const el = document.querySelector('.task-list-pane');
  el.scrollTop = 140;
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
})()`);
await wait(120);
await shoot("scroll-2-scrolling");
await wait(1000);
await shoot("scroll-3-idle");
await evaluate(`document.documentElement.dataset.theme='light'`);
ws.close();