/** CR-075：服务器列表、主机表单与自动连接工作台设计验证（隔离静态服务 + headless Edge CDP）。
 * 用法：node scripts/shot-cr075.mjs
 * 输出：docs/Test/screenshots/cr075/*.png + docs/Test/cr075-design-baseline.json
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { extname, join, resolve, normalize } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const ROOT = resolve("docs/UI");
const OUT = resolve("docs/Test/screenshots/cr075");
const PORT = 8135;
const CDP = 9446;
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
    if (url.pathname.endsWith("/")) p = join(p, "index.html");
    const body = readFileSync(p);
    res.setHeader("Content-Type", MIME[extname(p)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch {
    res.statusCode = 404; res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const base = `http://127.0.0.1:${PORT}/workbench-v4/index.html`;

const profile = join(tmpdir(), "edge-cr075-" + Date.now());
const edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*",
  `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--disable-features=OverlayScrollbar",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = list.find((x) => x.type === "page");
      if (p) return p;
    } catch {}
    await sleep(300);
  }
  throw new Error("CDP target not ready");
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.text + " " + (m.params.exceptionDetails?.exception?.description || ""));
});
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("SHOT", name);
};
const clickText = (text, sel = "button,a,[role=button],[role=tab],.nav-item") => evalJs(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = all.find(e => (e.textContent || '').trim() === ${JSON.stringify(text)}) || all.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) throw new Error('找不到 ' + ${JSON.stringify(text)});
  el.click(); return true;
})()`);
const click = (selector) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('找不到 ${selector}'); el.click(); return true; })()`);
const setVal = (id, value) => evalJs(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) throw new Error('找不到 ${id}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

const checks = [];
const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), detail }); console.log(pass ? "PASS" : "FAIL", name, detail ?? ""); };
const goto = async (query = "") => {
  await send("Page.navigate", { url: base + query });
  await sleep(1400);
};

try {
  /* ---------- 1440 list ---------- */
  await goto();
  await clickText("服务器管理");
  await sleep(500);
  await shot("01-list-1440");
  const list = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.c075-host')];
    return {
      count: cards.length,
      icons: cards.map(c => { const img = c.querySelector('.c075-os-tile img'); return img ? img.getAttribute('src') : null; }),
      connectButtons: [...document.querySelectorAll('.c075-host button')].map(b => (b.textContent || '').trim()).filter(t => t === '连接' || t === '断开'),
      subtitle: !!document.querySelector('.page-sub'),
      foot: !!document.querySelector('.page-foot'),
      cardHeight: cards[0] ? Math.round(cards[0].getBoundingClientRect().height) : 0
    };
  })()`);
  check("列表有 3 张主机卡片", list.count === 3, JSON.stringify(list));
  check("卡片使用官方系统标识", list.icons.every(Boolean), JSON.stringify(list.icons));
  check("列表无连接/断开按钮", list.connectButtons.length === 0, JSON.stringify(list.connectButtons));
  check("列表无副标题/页脚说明", !list.subtitle && !list.foot, JSON.stringify(list));

  /* ---------- add dialog ---------- */
  await clickText("添加主机");
  await sleep(250);
  await shot("02-add-default");
  const dlg = await evalJs(`(() => {
    const d = document.getElementById('dialog'); const b = d.querySelector('.dlg-b'); const f = d.querySelector('.dlg-f');
    const r = d.getBoundingClientRect();
    return { height: Math.round(r.height), bodyScroll: b.scrollHeight, footerBottom: Math.round(f.getBoundingClientRect().bottom), dialogBottom: Math.round(r.bottom), hasSub: !!d.querySelector('.dlg-h p'), texts: d.innerText };
  })()`);
  check("弹窗按内容高度且底栏贴合", dlg.dialogBottom - dlg.footerBottom <= 12 && dlg.height < 700, JSON.stringify(dlg));
  check("弹窗无说明性副标题/免认证说明", !dlg.hasSub && !/该主机将以无凭据方式连接|服务器接受 none|不保存任何密钥/.test(dlg.texts), dlg.texts.slice(0, 120));

  await setVal("c075-name", "预发布 · web");
  await setVal("c075-host", "192.0.2.60");
  await setVal("c075-port", "22");
  await setVal("c075-username", "deploy");
  await setVal("c075-password", "DEMO-PASSWORD");
  await clickText("测试连接");
  await sleep(120);
  await shot("03-test-connecting");
  const testing = await evalJs(`document.getElementById('c075-test') ? document.getElementById('c075-test').textContent : document.querySelector('.dlg-f .btn[disabled]')?.textContent`);
  check("测试连接有进行中状态", /测试中/.test(testing || ""), testing);
  await sleep(1000);
  await shot("04-test-success");
  const okText = await evalJs(`document.querySelector('.c075-test-result')?.textContent || ''`);
  check("测试连接成功显示系统", /连接成功/.test(okText) && /Ubuntu/.test(okText), okText);

  /* save + verify card */
  await clickText("保存");
  await sleep(400);
  const saved = await evalJs(`(() => ({ count: document.querySelectorAll('.c075-host').length, last: [...document.querySelectorAll('.c075-host-name b')].map(x => x.textContent).pop(), icon: document.querySelectorAll('.c075-host')[3]?.querySelector('.c075-os-tile img')?.getAttribute('src') }))()`);
  check("保存后列表新增主机并带系统标识", saved.count === 4 && /预发布/.test(saved.last || "") && Boolean(saved.icon), JSON.stringify(saved));

  /* ---------- edit key / failure ---------- */
  await click(".c075-host:nth-child(2) [data-c075=edit]");
  await sleep(250);
  await shot("05-edit-key");
  const keyPanel = await evalJs(`({ key: !!document.getElementById('c075-keyPath'), pass: !!document.getElementById('c075-password'), texts: document.getElementById('dialog').innerText })`);
  check("编辑密钥主机展示私钥字段", keyPanel.key && !keyPanel.pass, JSON.stringify({ key: keyPanel.key, pass: keyPanel.pass }));
  await clickText("取消");
  await sleep(150);

  await click(".c075-host:nth-child(3) [data-c075=edit]");
  await sleep(200);
  await clickText("测试连接");
  await sleep(1000);
  await shot("06-test-fail");
  const failText = await evalJs(`document.querySelector('.c075-test-result')?.textContent || ''`);
  check("不可达主机测试失败且不伪造成功", /连接失败/.test(failText), failText);
  await clickText("取消");
  await sleep(150);

  /* ---------- workbench auto connect ---------- */
  await click(".c075-host:nth-child(1)");
  await sleep(120);
  await shot("07-workbench-connecting");
  const connecting = await evalJs(`({ text: document.querySelector('.c075-conn')?.textContent, body: document.querySelector('.c075-term-state')?.innerText || '' })`);
  check("进入工作台自动连接中", /正在连接/.test(connecting.text || "") && /正在连接/.test(connecting.body || ""), JSON.stringify(connecting));
  await sleep(1100);
  await shot("08-workbench-connected");
  const connected = await evalJs(`(() => {
    const head = document.querySelector('.c075-wb-head');
    const btns = [...document.querySelectorAll('.c075-wb button')].map(b => (b.textContent || '').trim()).filter(Boolean);
    return { text: head?.innerText || '', terminal: !!document.getElementById('term-input'), buttons: btns, tabIcon: document.querySelector('.wtab.active img.c075-tab-os')?.getAttribute('src') || null };
  })()`);
  check("工作台已连接且无连接/断开按钮", /已连接/.test(connected.text) && connected.terminal && !connected.buttons.includes("连接") && !connected.buttons.includes("断开"), JSON.stringify(connected));
  check("窗口页签使用系统标识", Boolean(connected.tabIcon), connected.tabIcon);

  /* close tab -> auto disconnect */
  await click(".wtab.active .w-close");
  await sleep(400);
  const disconnected = await evalJs(`Object.keys(UI.store.c075Conn || {}).length`);
  check("关闭工作台页签自动断开", disconnected === 0, String(disconnected));

  /* failure state */
  await click(".c075-host:nth-child(3)");
  await sleep(1100);
  await shot("09-workbench-fail");
  const failWb = await evalJs(`({ text: document.querySelector('.c075-conn')?.textContent, retry: [...document.querySelectorAll('.c075-wb button')].some(b => (b.textContent || '').trim() === '重试'), connect: [...document.querySelectorAll('.c075-wb button')].some(b => (b.textContent || '').trim() === '连接') })`);
  check("连接失败提供重试且无连接开关", /连接失败/.test(failWb.text || "") && failWb.retry && !failWb.connect, JSON.stringify(failWb));

  /* ---------- dark ---------- */
  await click(".wtab.active .w-close");
  await sleep(300);
  await evalJs(`document.documentElement.dataset.theme = 'dark'`);
  await shot("10-list-dark-1440");
  await evalJs(`document.documentElement.dataset.theme = 'light'`);

  /* ---------- 390 ---------- */
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  await shot("11-list-390");
  await clickText("添加主机");
  await sleep(250);
  await shot("12-dialog-390");
  const narrowDlg = await evalJs(`(() => { const d = document.getElementById('dialog'); const r = d.getBoundingClientRect(); const f = d.querySelector('.dlg-f').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, footerVisible: f.bottom <= innerHeight + 1 }; })()`);
  check("390 弹窗不溢出且底栏可见", narrowDlg.left >= 0 && narrowDlg.right <= narrowDlg.vw && narrowDlg.footerVisible, JSON.stringify(narrowDlg));
  await clickText("取消");
  await sleep(150);
  await click(".c075-host:nth-child(1)");
  await sleep(1100);
  await shot("13-workbench-390");
  await click(".wtab.active .w-close");
  await sleep(300);

  /* ---------- UI-SCROLL-001：列表与弹窗动态证据 ---------- */
  const widthBefore = await evalJs(`Math.round(document.querySelector('.c075-host').getBoundingClientRect().width)`);
  await evalJs(`(() => { const el = document.querySelector('#content'); el.scrollTop = 220; return el.scrollTop; })()`);
  await sleep(80);
  await shot("17-scroll-list-active");
  const listScroll = await evalJs(`(() => { const el = document.querySelector('#content'); return { top: el.scrollTop, active: el.classList.contains('scrollbar-active'), width: Math.round(document.querySelector('.c075-host').getBoundingClientRect().width) }; })()`);
  await sleep(900);
  await shot("18-scroll-list-idle");
  const listIdle = await evalJs(`(() => { const el = document.querySelector('#content'); return { active: el.classList.contains('scrollbar-active'), top: el.scrollTop }; })()`);
  check("列表滚动条实际滚动显示、停止隐藏", listScroll.top > 0 && listScroll.active && !listIdle.active, JSON.stringify({ listScroll, listIdle }));
  check("滚动显隐不改变卡片宽度", listScroll.width === widthBefore, `${widthBefore} -> ${listScroll.width}`);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 560, deviceScaleFactor: 1, mobile: true });
  await sleep(200);
  await clickText("添加主机");
  await sleep(200);
  await clickText("私钥");
  await sleep(200);
  await shot("19-dialog-short");
  await evalJs(`(() => { const el = document.querySelector('#dialog .dlg-b'); el.scrollTop = 180; return el.scrollTop; })()`);
  await sleep(80);
  await shot("20-dialog-scroll-active");
  const dlgScroll = await evalJs(`(() => { const el = document.querySelector('#dialog .dlg-b'); return { top: el.scrollTop, active: el.classList.contains('scrollbar-active'), overflow: getComputedStyle(el).overflowY }; })()`);
  await sleep(900);
  const dlgIdle = await evalJs(`document.querySelector('#dialog .dlg-b').classList.contains('scrollbar-active')`);
  check("弹窗正文原生滚动且按需显示", dlgScroll.top > 0 && dlgScroll.active && dlgScroll.overflow === "auto" && !dlgIdle, JSON.stringify({ dlgScroll, dlgIdle }));
  await clickText("取消");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  /* ---------- forced states ---------- */
  await goto("?c075=empty");
  await clickText("服务器管理");
  await sleep(300);
  await shot("14-list-empty");
  check("空状态只有明确入口", await evalJs(`!!document.querySelector('.empty') && !document.querySelector('.page-sub')`), "");

  await goto("?c075=error");
  await clickText("服务器管理");
  await sleep(300);
  await shot("15-list-error");

  await goto("?c075=loading");
  await clickText("服务器管理");
  await sleep(120);
  await shot("16-list-loading");
  check("加载骨架存在", await evalJs(`document.querySelectorAll('.c075-skel').length === 3`), "");

  /* ---------- text / layout assertions ---------- */
  await goto("?c075=empty");
  await clickText("服务器管理");
  await sleep(200);
  const pageText = await evalJs(`document.querySelector('#content')?.innerText || ''`);
  check("页面无连接/终端说明长文案", !/连接、终端与巡检|高风险命令逐次审批|指标来自最近一次连接采样/.test(pageText), pageText.slice(0, 200));
  check("无 JS 异常", errors.length === 0, JSON.stringify(errors.slice(0, 3)));

  const files = ["cr075.js", "cr075.css", "index.html", "core.js"].map((f) => join(ROOT, "workbench-v4", f));
  const logos = ["ubuntu", "debian", "centos", "rockylinux", "almalinux", "fedora", "archlinux", "opensuse", "alpinelinux", "amazon", "oracle", "redhat", "freebsd", "apple", "linux", "windows"].map((n) => join(ROOT, "workbench-v4/os-logos", n + ".svg"));
  const hashes = {};
  for (const f of [...files, ...logos]) hashes[f.replace(ROOT + "\\", "").replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(f)).digest("hex");
  const report = { generatedAt: new Date().toISOString(), viewport: "1440x900 / 390x844", checks, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length, jsErrors: errors, hashes };
  writeFileSync(resolve("docs/Test/cr075-design-baseline.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors: errors.length }, null, 2));
} finally {
  try { edge.kill(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
