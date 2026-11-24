/**
 * 补充截图：设置内各页签 + 项目内 AI 侧栏/需求/任务等关键界面。
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/evidence-2026-11-24/screens";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise(r => { ws.onopen = r; });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64")); console.log("SHOT", name); };
await send("Page.enable"); await send("Runtime.enable");

const report = [];
const step = async (name, js, waitMs = 1000) => {
  try { const v = await evalJs(js); await sleep(waitMs); await shot(name); report.push({ name, ok: true, detail: String(v ?? "").slice(0, 240) }); }
  catch (e) { report.push({ name, ok: false, detail: String(e).slice(0, 300) }); try { await shot(name + "-error"); } catch {} }
};
const clickText = (t, sel = "button,a,[role=button],.nav-item,.settings-nav-item,li") => `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = all.find(e => (e.textContent || '').trim() === ${JSON.stringify(t)}) || all.find(e => (e.textContent || '').trim().includes(${JSON.stringify(t)}));
  if (!el) throw new Error('找不到：' + ${JSON.stringify(t)});
  el.click(); return (el.textContent || '').trim().slice(0, 40);
})()`;

// 打开设置（顶栏头像按钮 aria-label="设置与账户"）
await step("11-settings-again", "(() => { const b = document.querySelector('[aria-label=\"设置与账户\"]') || document.querySelector('.nc-avatar'); if (!b) throw new Error('无设置入口'); b.click(); return 'opened'; })()", 1200);
await step("12-settings-models", clickText("模型管理"), 1200);
await step("13-settings-probe", clickText("模型检测"), 1200);
await step("14-settings-sdk", clickText("SDK 与 CLI"), 1200);
await step("15-settings-tools", clickText("能力 · Tools"), 1200);
// 关闭：X 图标按钮
await step("16-settings-closed", "(() => { const m = document.querySelector('.modal, [role=dialog]'); if (!m) throw new Error('无弹窗'); const b = m.querySelector('button[aria-label*=\"关闭\"], .settings-close, button.close') || [...m.querySelectorAll('button')].find(e => (e.textContent||'').trim() === '×' || (e.textContent||'').trim() === '✕'); if (!b) throw new Error('无关闭按钮'); b.click(); return 'closed'; })()", 1000);
// 进入项目 → 工作台 / 需求 / 任务 / 编码
await step("17-project-open", "(() => { const rows = [...document.querySelectorAll('.nc-list-row, .project-card, .card')]; const el = rows.find(r => /计算器/.test(r.textContent||'')); if (!el) throw new Error('无项目行'); el.click(); return (el.textContent||'').trim().slice(0,50); })()", 1500);
await step("18-project-workbench", "(() => document.body.innerText.slice(0, 200).replace(/\\n/g,' / '))()");
await step("19-project-requirements", clickText("需求"), 1500);
await step("20-project-tasks", clickText("任务"), 1500);
await step("21-project-code", clickText("编码"), 1500);
await step("22-ai-sidebar", "(() => { const b = [...document.querySelectorAll('button')].find(e => /AI|助手|侧栏/.test((e.getAttribute('aria-label')||'') + (e.title||''))); if (!b) throw new Error('无AI入口'); b.click(); return 'clicked'; })()", 1200);

const md = ["# 补充截图记录", "", `- 时间：${new Date().toLocaleString("zh-CN")}`, "", "| 步骤 | 结果 | 说明 |", "| --- | --- | --- |",
  ...report.map(r => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/")} |`)].join("\n");
writeFileSync(`${OUT}/../screens-report-2.md`, md);
console.log(md);
ws.close();
