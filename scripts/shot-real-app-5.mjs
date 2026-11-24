/**
 * 展开 AI 侧栏并抓取 token 统计证据。
 */
import { writeFileSync } from "node:fs";
const OUT = "docs/Test/evidence-2026-11-24/screens";
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise(r => { ws.onopen = r; });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async n => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, "base64")); console.log("SHOT", n); };
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
await send("Page.enable"); await send("Runtime.enable");

// 回到工作台（工作台页签有历史会话，便于展示 token 统计）
await evalJs(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(e=>/工作台/.test(e.textContent||'')); if(b) b.click(); return 'ok'; })()`);
await sleep(1500);

// 展开 AI 侧栏
const btn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label')||'') === 'AI 侧栏');
  if (!b) return 'NO';
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
})()`);
console.log("AI_BTN:", btn);
if (btn && btn !== 'NO') {
  const p = JSON.parse(btn);
  await clickAt(p.x, p.y);
  await sleep(2000);
}
await shot("33-ai-sidebar-open");

// 读取统计条
const stats = await evalJs(`(() => {
  const t = document.body.innerText;
  return JSON.stringify({
    tok: (t.match(/[\\d.,]+\\s*[kK]?\\s*tok[^\\n]{0,14}/gi) || []).slice(0, 6),
    rounds: (t.match(/\\d+\\s*轮/g) || []).slice(0, 3),
    ctx: (t.match(/上下文[^\\n]{0,16}/g) || []).slice(0, 3),
    cacheLine: (t.match(/缓存[^\\n]{0,16}/g) || []).slice(0, 3),
  });
})()`);
console.log("STATS:", stats);
writeFileSync(`${OUT}/../stats-observed.json`, stats ?? "{}");

// 打开会话历史
const hist = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => /历史/.test((e.getAttribute('aria-label')||'') + (e.title||'')));
  if (!b) return 'NO_HIST';
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label: b.getAttribute('aria-label') || b.title });
})()`);
console.log("HIST:", hist);
if (hist && hist !== 'NO_HIST') {
  const p = JSON.parse(hist);
  await clickAt(p.x, p.y);
  await sleep(1200);
  await shot("34-session-history");
}
ws.close();
