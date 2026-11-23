/** UI-FEAT-019 软件侧视觉检查：设计预览 → 预约服务 → 任务页（仿真夹具）。 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/tmp";
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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(2600);

const opened = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.proj-card, button, a')];
  const card = cards.find(n => (n.textContent || '').includes('预约服务'));
  if (!card) return 'no-project';
  card.click();
  return 'clicked-project';
})()`);
console.log(opened);
await wait(1400);

const tab = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.pw-tab, button, [role="tab"]')];
  const t = tabs.find(n => (n.textContent || '').trim() === '任务');
  if (!t) return 'no-tab';
  t.click();
  return 'clicked-tab';
})()`);
console.log(tab);
await wait(1600);

// 同条件对照：收起 AI 侧栏，避免挤压任务区。
const aiState = await evaluate(`(() => {
  const b = document.querySelector('.pw-ai-toggle');
  if (!b) return 'no-toggle';
  if (b.getAttribute('aria-pressed') === 'true') { b.click(); return 'closed'; }
  return 'already-closed';
})()`);
console.log(aiState);
await wait(900);

const text = await evaluate("document.body.innerText.slice(0, 900)");
console.log("VISIBLE:\n" + text);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(`${OUT}/task-ui-tasks.png`, Buffer.from(shot.data, "base64"));
console.log("saved docs/tmp/task-ui-tasks.png");

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await wait(900);
const narrow = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(`${OUT}/task-ui-tasks-390.png`, Buffer.from(narrow.data, "base64"));
console.log("saved docs/tmp/task-ui-tasks-390.png");
ws.close();