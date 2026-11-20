import { writeFileSync } from "node:fs";
const [outName, extra] = [process.argv[2] ?? "chat", process.argv[3] ?? ""];
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => (ws.onopen = r));
await send("Page.enable"); await send("Runtime.enable");
async function js(expr) { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; }
await send("Page.reload", { ignoreCache: false });
await new Promise((r) => setTimeout(r, 4000));
const nav = await js(`
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(500);
  const cards = [...document.querySelectorAll('.card')];
  const card = cards.find(c => c.textContent.includes('会话样式验证'));
  if (!card) return 'no card; cards=' + cards.length;
  card.click();
  await wait(2000);
  return 'entered; tabs=' + [...document.querySelectorAll('.segment button')].map(b=>b.textContent).join(',');
})()
`);
console.log("nav:", nav);
if (extra) { const v = await js(extra); console.log("extra:", JSON.stringify(v).slice(0, 400)); await new Promise((r) => setTimeout(r, 1800)); }
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`docs/Test/screenshots/chat-ui/${outName}.png`, Buffer.from(shot.data, "base64"));
console.log("saved", outName); ws.close();
