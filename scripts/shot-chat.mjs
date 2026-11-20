/**
 * 打开指定会话并截图（真实应用窗口）。
 * 运行：node scripts/shot-chat.mjs <sessionId> <输出名> [额外JS]
 */
import { writeFileSync } from "node:fs";

const sessionId = process.argv[2];
const outName = process.argv[3] ?? "chat";
const extra = process.argv[4] ?? "";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
}

// 直达项目工作区（会话在需求页签右侧）
const navigated = await js(`
(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const s = await inv('chat_session_get', { id: ${JSON.stringify(sessionId)} });
  // 通过 DOM 点击进入项目（复用应用路由，避免直接改内部状态）
  const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('项目管理'));
  if (nav) nav.click();
  await new Promise(r => setTimeout(r, 600));
  const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('会话样式验证'));
  if (card) card.click();
  await new Promise(r => setTimeout(r, 1200));
  return { projectId: s.projectId, clicked: !!card };
})()
`);
console.log("navigate:", JSON.stringify(navigated));

await new Promise((r) => setTimeout(r, 2500));
if (extra) {
  const v = await js(extra);
  console.log("extra:", JSON.stringify(v).slice(0, 300));
  await new Promise((r) => setTimeout(r, 1200));
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`docs/Test/screenshots/chat-ui/${outName}.png`, Buffer.from(shot.data, "base64"));
console.log("saved", outName);
ws.close();
