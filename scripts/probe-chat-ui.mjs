/**
 * 会话答复样式取证：在真实应用内注入各类消息，逐个场景截图。
 * 运行：node scripts/probe-chat-ui.mjs
 */
import { writeFileSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
if (!page) { console.error("未找到应用页面"); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`docs/Test/screenshots/chat-ui/${name}.png`, Buffer.from(s.data, "base64"));
  console.log("saved", name);
}

const projectId = await js(`
(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const list = await inv('list_projects');
  if (list.length) return list[0].id;
  const p = await inv('create_project', { name: '会话样式验证', kind: 'code', rootUri: 'D:\\\\github\\\\AI_Delelovelop' });
  return p.id;
})()
`);
console.log("project:", projectId);

const sessionId = await js(`
(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const s = await inv('chat_session_create', { projectId: ${JSON.stringify(projectId)}, cliId: 'claude', modelId: 'tierflow' });
  return s.id;
})()
`);
console.log("session:", sessionId);

const seeded = await js(`window.__TAURI_INTERNALS__.invoke('smoke_seed_chat_demo', { sessionId: ${JSON.stringify(sessionId)} })`);
console.log("seeded:", JSON.stringify(seeded));

ws.close();
