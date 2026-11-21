/** CR-037 软件端 390 窄视口截图（blocked 横幅）。前置同 shot-cr037.mjs。 */
import { writeFileSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420")) ?? list.find((p) => p.type === "page");
if (!page) throw new Error("未找到应用页面目标");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res2, rej) => {
    const i = ++id;
    pending.set(i, { res: res2, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res: resolveFn, rej } = pending.get(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : resolveFn(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const d = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`docs/Test/screenshots/cr037-sidebar/${name}.png`, Buffer.from(d.data, "base64"));
  console.log("saved", name);
};

if (!page.url.includes("localhost:1420")) {
  await send("Page.navigate", { url: "http://localhost:1420/" });
  await sleep(3000);
}
await js(`(() => { const card = Array.from(document.querySelectorAll('.card')).find(c => (c.textContent||'').includes('市场研究资料')); if (card) card.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
await sleep(1800);
await js(`(() => { if (!document.querySelector('.chat-history')) { const h = document.querySelector('button[aria-label="会话历史"]'); if (h) h.dispatchEvent(new MouseEvent('click', { bubbles: true })); } })()`);
await sleep(700);
const clicked = await js(`(() => {
  const rows = Array.from(document.querySelectorAll('.chat-hist-item'));
  const target = rows.find(r => (r.querySelector('.chat-hist-title')?.textContent || '').trim() === '阻塞会话第一轮');
  if (!target) return 'nf:' + rows.length;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'ok';
})()`);
console.log("open blocked:", clicked);
await sleep(900);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(1000);
// 窄视口下 AI 侧栏为抽屉：点击右下角「AI 侧栏」展开
await js(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('AI 侧栏'));
  if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return !!btn;
})()`);
await sleep(1200);
await shot("sw-05-blocked-390");
await send("Emulation.clearDeviceMetricsOverride");
process.exit(0);
