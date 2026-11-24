/**
 * 进入工作台页签（会话中心）并抓 token 统计。
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

// 直接点「工作台」导航项（真实 click()，非坐标）
const r1 = await evalJs(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(e=>/工作台/.test(e.textContent||'')); if(!b) return 'NO'; b.click(); return 'clicked'; })()`);
console.log("NAV:", r1);
await sleep(1800);
await shot("35-workbench-tab");

// 该页应有会话中心三栏；读取 token 相关文字
const t1 = await evalJs("document.body.innerText.slice(0, 900)");
console.log("TEXT:", String(t1).replace(/\n/g, " | ").slice(0, 700));

// 检查工作台内是否有会话可点
const sess = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.nc-list-row, .chat-history-row, .session-row, [class*=history] li, [class*=history] button')];
  return JSON.stringify(rows.slice(0, 6).map(r => (r.textContent || '').trim().slice(0, 60)));
})()`);
console.log("SESSIONS:", sess);

// 点击第一个历史会话
try {
  const arr = JSON.parse(sess);
  if (arr.length) {
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.nc-list-row, .chat-history-row, .session-row, [class*=history] li, [class*=history] button')];
      if (rows[0]) rows[0].click();
      return 'ok';
    })()`);
    await sleep(2000);
  }
} catch {}
await shot("36-session-opened");

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

// 也抓一张项目工作台的完整界面
await shot("37-final");
ws.close();
