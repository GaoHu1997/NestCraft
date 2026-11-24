/**
 * 真实 Tauri 应用截图（WebView2 CDP）：遍历核心界面并落盘。
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333 --remote-allow-origins=*"
 * 输出：docs/Test/evidence-2026-11-24/screens/
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/evidence-2026-11-24/screens";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page");
if (!page) throw new Error("未找到页面目标");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise(r => { ws.onopen = r; });

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS 异常：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("SHOT", name);
}

await send("Page.enable");
await send("Runtime.enable");

const report = [];
const step = async (name, js, waitMs = 900) => {
  try {
    const v = await evalJs(js);
    await sleep(waitMs);
    await shot(name);
    report.push({ name, ok: true, detail: String(v ?? "").slice(0, 200) });
  } catch (e) {
    report.push({ name, ok: false, detail: String(e).slice(0, 300) });
    try { await shot(name + "-error"); } catch {}
  }
};

// 点击含指定文字的按钮/元素
const clickText = (text) => `(() => {
  const all = [...document.querySelectorAll('button,a,[role=button],.nav-item')];
  const el = all.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
  if (!el) throw new Error('找不到：' + ${JSON.stringify(text)});
  el.click();
  return (el.textContent || '').trim().slice(0, 40);
})()`;

await step("01-home", "(() => { const t = document.body.innerText; return 'len=' + t.length + ' | ' + t.slice(0, 120).replace(/\\n/g, ' / '); })()");
await step("02-projects", clickText("项目管理"));
await step("03-knowledge", clickText("知识库"));
await step("04-servers", clickText("服务器管理"));
await step("05-settings-open", "(() => { const b = document.querySelector('.nc-avatar, [aria-label=\"设置与账户\"], .nc-side-user'); if (!b) throw new Error('找不到设置入口'); b.click(); return 'clicked'; })()", 1200);
await step("06-settings-tabs", "(() => { const t = [...document.querySelectorAll('.modal, .settings, [role=dialog]')].map(e => (e.textContent||'').slice(0,200)); return t.join(' || ').slice(0, 300); })()");
await step("07-settings-close", "(() => { const m = document.querySelector('.modal, [role=dialog]'); if (!m) throw new Error('无弹窗'); const b = [...m.querySelectorAll('button')].find(e => /关闭|取消|完成|×/.test(e.textContent||'') || e.getAttribute('aria-label')?.includes('关闭')); if (!b) throw new Error('无关闭按钮'); b.click(); return 'closed'; })()", 900);
await step("08-back-workbench", clickText("工作台"));
await step("09-theme", "(() => { const b = [...document.querySelectorAll('button')].find(e => /主题|深色|浅色|dark|light/i.test(e.getAttribute('aria-label')||'') || /主题|深色|浅色/.test(e.title||'')); if (!b) return 'no-theme-button'; b.click(); return 'clicked'; })()", 1000);
await step("10-scroll", "(() => { const el = document.querySelector('.main .nc-scroll, .main, .chat-body'); if (!el) return 'no-scroll-target'; el.scrollTop = 300; el.dispatchEvent(new Event('scroll')); return 'scrolled ' + el.scrollHeight; })()", 500);

const md = ["# 真实应用截图记录", "", `- 时间：${new Date().toLocaleString("zh-CN")}`, "", "| 步骤 | 结果 | 说明 |", "| --- | --- | --- |",
  ...report.map(r => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/")} |`)].join("\n");
writeFileSync(`${OUT}/../screens-report.md`, md);
console.log(md);
ws.close();
