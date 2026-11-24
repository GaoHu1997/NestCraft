/**
 * 进项目工作台 → 展开 AI 侧栏 → 抓 token 统计与会话历史。
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
await send("Page.enable"); await send("Runtime.enable");

// 首页 → 打开计算器项目
await evalJs(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(e=>/项目管理/.test(e.textContent||'')); if(b) b.click(); return 'ok'; })()`);
await sleep(1400);
await evalJs(`(() => { const rows=[...document.querySelectorAll('.nc-list-row, .project-card, .card')]; const el=rows.find(r=>/计算器/.test(r.textContent||'')); if(el) el.click(); return 'ok'; })()`);
await sleep(2000);
await shot("38-project-workbench-clean");

// 展开 AI 侧栏：找所有可见按钮中 aria-label=AI 侧栏
const info = await evalJs(`(() => {
  const bs = [...document.querySelectorAll('button')].map(b => {
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label')||'', title: b.title||'', x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(b => b.w > 0 && /AI 侧栏|展开 AI|收起 AI/.test(b.label + b.title));
  return JSON.stringify(bs);
})()`);
console.log("AI_BTNS:", info);
try {
  const arr = JSON.parse(info);
  if (arr.length) {
    const b = arr[0];
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await sleep(2200);
  }
} catch {}
await shot("39-ai-sidebar-open");

const stats = await evalJs(`(() => {
  const t = document.body.innerText;
  return JSON.stringify({
    tok: (t.match(/[\\d.,]+\\s*[kK]?\\s*tok[^\\n]{0,14}/gi) || []).slice(0, 6),
    rounds: (t.match(/\\d+\\s*轮/g) || []).slice(0, 3),
    ctx: (t.match(/上下文[^\\n]{0,16}/g) || []).slice(0, 3),
  });
})()`);
console.log("STATS:", stats);
writeFileSync(`${OUT}/../stats-observed.json`, stats ?? "{}");
ws.close();
