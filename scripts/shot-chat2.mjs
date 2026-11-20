import { writeFileSync } from "node:fs";
const [sessionArg, outName, extra] = [process.argv[2], process.argv[3] ?? "chat", process.argv[4] ?? ""];
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => (ws.onopen = r));
await send("Page.enable"); await send("Runtime.enable");
async function js(expr) { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; }
const info = await js(`
(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  let list = await inv('list_projects');
  let pid;
  if (list.length) pid = list[0].id;
  else { const p = await inv('create_project', { name: '会话样式验证', kind: 'code', rootUri: 'D:\\github\\AI_Delelovelop' }); pid = p.id; }
  let sess = (await inv('chat_sessions', { projectId: pid }))[0];
  if (!sess) sess = await inv('chat_session_create', { projectId: pid, cliId: 'claude', modelId: 'tierflow' });
  await inv('smoke_seed_chat_demo', { sessionId: sess.id }).catch(() => {});
  return { pid, sid: sess.id, projects: list.length };
})()
`);
console.log("info:", JSON.stringify(info));
await new Promise((r) => setTimeout(r, 400));
// 通过 DOM 进入项目
const nav = await js(`
(async () => {
  const navItem = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('项目管理'));
  navItem?.click();
  await new Promise(r => setTimeout(r, 800));
  const cards = [...document.querySelectorAll('.card')];
  const card = cards.find(c => c.textContent.includes(${JSON.stringify("会话样式验证")}));
  if (card) { card.click(); await new Promise(r => setTimeout(r, 1500)); return 'clicked'; }
  return 'cards=' + cards.length + ' text=' + cards.map(c=>c.textContent.slice(0,20)).join('|');
})()
`);
console.log("nav:", nav);
if (extra) { const v = await js(extra); console.log("extra:", JSON.stringify(v).slice(0, 300)); await new Promise((r) => setTimeout(r, 1500)); }
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`docs/Test/screenshots/chat-ui/${outName}.png`, Buffer.from(shot.data, "base64"));
console.log("saved", outName); ws.close();
