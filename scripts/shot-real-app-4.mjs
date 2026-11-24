/**
 * 用命中测试关闭设置弹窗，并抓 AI 侧栏与 token 统计。
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

// 列出弹窗内所有按钮及其位置，找 X
const info = await evalJs(`(() => {
  const m = document.querySelector('.modal, [role=dialog]');
  if (!m) return 'NO_MODAL';
  const r = m.getBoundingClientRect();
  const btns = [...m.querySelectorAll('button')].map((b, i) => {
    const br = b.getBoundingClientRect();
    return { i, x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2), w: Math.round(br.width), h: Math.round(br.height),
      label: b.getAttribute('aria-label') || '', cls: String(b.className).slice(0,40), txt: (b.textContent||'').trim().slice(0,10) };
  }).filter(b => b.w > 0 && b.h > 0);
  return JSON.stringify({ modal: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}, count: btns.length, topRight: btns.filter(b => b.x > r.x + r.width - 120 && b.y < r.y + 80) });
})()`);
console.log("MODAL_INFO:", info);

// 命中测试：在弹窗右上角区域扫描，找到可点击元素
const hit = await evalJs(`(() => {
  const m = document.querySelector('.modal, [role=dialog]');
  const r = m.getBoundingClientRect();
  const cands = [];
  for (let dx = 20; dx <= 80; dx += 4) {
    for (let dy = 20; dy <= 60; dy += 4) {
      const x = r.right - dx, y = r.top + dy;
      const el = document.elementFromPoint(x, y);
      if (el) {
        const b = el.closest('button');
        if (b && !cands.some(c => c.el === b)) cands.push({ el: b, x, y, label: b.getAttribute('aria-label') || b.className });
      }
    }
  }
  if (!cands.length) return 'NO_BUTTON_FOUND';
  return JSON.stringify({ x: Math.round(cands[0].x), y: Math.round(cands[0].y), label: cands[0].label });
})()`);
console.log("HIT:", hit);

try {
  const pos = JSON.parse(hit);
  await clickAt(pos.x, pos.y);
  await sleep(1000);
  const after = await evalJs("document.querySelector('.modal, [role=dialog]') ? 'STILL_OPEN' : 'CLOSED'");
  console.log("AFTER_CLICK:", after);
} catch (e) { console.log("HIT_PARSE_FAIL", e.message); }

await shot("30-after-close");

// 若还开着，用 ESC
const stillOpen = await evalJs("!!document.querySelector('.modal, [role=dialog]')");
if (stillOpen) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(900);
  console.log("ESC ->", await evalJs("document.querySelector('.modal, [role=dialog]') ? 'STILL_OPEN' : 'CLOSED'"));
  await shot("31-after-esc");
}

// 打开 AI 侧栏
const aiInfo = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')].map(b => ({
    label: (b.getAttribute('aria-label')||''), title: (b.title||''), txt: (b.textContent||'').trim().slice(0,20),
    x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y, w: b.getBoundingClientRect().width
  })).filter(b => b.w > 0 && (/AI|助手|侧栏/.test(b.label + b.title + b.txt)));
  return JSON.stringify(btns.slice(0, 5));
})()`);
console.log("AI_BUTTONS:", aiInfo);
try {
  const arr = JSON.parse(aiInfo);
  if (arr.length) {
    await clickAt(Math.round(arr[0].x + 10), Math.round(arr[0].y + 10));
    await sleep(1800);
  }
} catch {}
await shot("32-chat-sidebar");

const stats = await evalJs(`(() => {
  const t = document.body.innerText;
  return JSON.stringify({
    tok: (t.match(/[\\d.]+\\s*[kK]?\\s*tok[^\\n]{0,12}/g) || []).slice(0, 5),
    rounds: (t.match(/\\d+\\s*轮/g) || []).slice(0, 3),
    ctx: (t.match(/上下文[^\\n]{0,14}/g) || []).slice(0, 3),
    hasChat: !!document.querySelector('.nc-chat, .chat-panel, .chat-column, .nc-chat-panel'),
  });
})()`);
console.log("STATS:", stats);
writeFileSync(`${OUT}/../stats-observed.json`, stats ?? "{}");
ws.close();
