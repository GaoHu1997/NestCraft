/**
 * 干净界面截图：关设置 → 工作台 → AI 侧栏（含 token 统计） → 需求/任务/编码。
 */
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "docs/Test/evidence-2026-11-24/screens";
mkdirSync(OUT, { recursive: true });
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
const report = [];
const step = async (name, js, wait = 1200) => {
  try { const v = await evalJs(js); await sleep(wait); await shot(name); report.push({ name, ok: true, detail: String(v ?? "").slice(0, 240) }); }
  catch (e) { report.push({ name, ok: false, detail: String(e).slice(0, 300) }); try { await shot(name + "-err"); } catch {} }
};

// 1) 关掉任何模态：找右上角 X（含 aria-label 或 SVG 图标的按钮），或 ESC
await step("23-modal-closed", `(() => {
  const modals = [...document.querySelectorAll('.modal, [role=dialog]')];
  if (!modals.length) return 'no-modal';
  for (const m of modals) {
    const btns = [...m.querySelectorAll('button')];
    // 优先 aria-label 含「关闭」或 class 含 close 的
    let b = btns.find(x => /关闭|close/i.test(x.getAttribute('aria-label') || '') || /close/i.test(x.className));
    if (!b) b = btns[btns.length - 1];
    if (b) { b.click(); return 'clicked ' + (b.getAttribute('aria-label') || b.className || 'last'); }
  }
  return 'no-button';
})()`, 900);
// 2) 确保在工作台
await step("24-workbench", `(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(e => /工作台/.test(e.textContent||''));
  if (b) b.click();
  return 'ok';
})()`, 1500);
// 3) AI 侧栏：找右侧展开按钮
await step("25-chat-panel", `(() => {
  const cands = [...document.querySelectorAll('button')].filter(e => /AI|侧栏|助手/.test((e.getAttribute('aria-label')||'') + ' ' + (e.title||'') + ' ' + (e.textContent||'')));
  if (!cands.length) {
    // 若已展开则直接返回
    if (document.querySelector('.nc-chat, .chat-panel, .chat-column')) return 'already-open';
    throw new Error('无AI侧栏入口');
  }
  cands[0].click();
  return 'clicked:' + (cands[0].getAttribute('aria-label')||cands[0].title||cands[0].textContent||'').slice(0,30);
})()`, 1500);
// 4) 读取统计条文字（token 证据）
await step("26-chat-stats", `(() => {
  const t = document.body.innerText;
  const m = t.match(/[\\d.]+[kK]?\\s*tok[^\\n]*/g) || [];
  const rounds = t.match(/\\d+\\s*轮/g) || [];
  const ctx = t.match(/上下文[^\\n]{0,20}/g) || [];
  return 'tok=' + JSON.stringify(m.slice(0,4)) + ' rounds=' + JSON.stringify(rounds.slice(0,2)) + ' ctx=' + JSON.stringify(ctx.slice(0,2));
})()`, 600);
// 5) 需求页
await step("27-requirements", `(() => { const b=[...document.querySelectorAll('.nc-tab, button, a, .tab')].find(e=>(e.textContent||'').trim()==='需求'); if(!b) throw new Error('无需求页签'); b.click(); return 'ok'; })()`, 1600);
// 6) 任务页
await step("28-tasks", `(() => { const b=[...document.querySelectorAll('.nc-tab, button, a, .tab')].find(e=>(e.textContent||'').trim()==='任务'); if(!b) throw new Error('无任务页签'); b.click(); return 'ok'; })()`, 1600);
// 7) 编码页
await step("29-code", `(() => { const b=[...document.querySelectorAll('.nc-tab, button, a, .tab')].find(e=>(e.textContent||'').trim()==='编码'); if(!b) throw new Error('无编码页签'); b.click(); return 'ok'; })()`, 1600);

const md = ["# 干净界面截图", "", `- 时间：${new Date().toLocaleString("zh-CN")}`, "", "| 步骤 | 结果 | 说明 |", "| --- | --- | --- |",
  ...report.map(r => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/")} |`)].join("\n");
writeFileSync(`${OUT}/../screens-report-3.md`, md);
console.log(md);
ws.close();
