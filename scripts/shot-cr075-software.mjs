/** CR-075 软件侧验证：隔离设计预览（?preview=design，内存 IPC 夹具）+ headless Edge CDP。
 * 用法：先 `npx vite --port 1420 --strictPort`，再 `node scripts/shot-cr075-software.mjs`
 * 输出：docs/Test/screenshots/cr075-software/*.png + docs/Test/cr075-software-baseline.json
 * 说明：夹具只作用于内存，不发 SSH、不写库；截图是软件实现证据，不是设计稿。
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const APP = process.env.CR075_APP || "http://127.0.0.1:1420/?preview=design";
const OUT = resolve("docs/Test/screenshots/cr075-software");
const JSON_OUT = resolve("docs/Test/cr075-software-baseline.json");
const CDP = 9452;
mkdirSync(OUT, { recursive: true });

const profile = join(tmpdir(), "edge-cr075-sw-" + Date.now());
spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*",
  `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--disable-features=OverlayScrollbar",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 100; i++) {
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

const jsErrors = [];
let currentStep = "boot";
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    jsErrors.push(`[${currentStep}] ${m.params.exceptionDetails?.text} ${m.params.exceptionDetails?.exception?.description || ""}`.trim());
  }
});

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 700));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("SHOT", name);
};
const viewport = (width, height, mobile = false) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });

const clickText = (text, sel = "button,a,[role=button],[role=tab]") => evalJs(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const visible = all.filter(e => e.offsetParent !== null || e.getClientRects().length);
  const el = visible.find(e => (e.textContent || '').trim() === ${JSON.stringify(text)}) || visible.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) throw new Error('找不到 ' + ${JSON.stringify(text)});
  el.click(); return true;
})()`);
const click = (selector) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('找不到 ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const setInput = (selector, value) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('找不到 ' + ${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, detail === undefined ? "" : detail);
};

await viewport(1440, 900);
await send("Page.navigate", { url: APP });
for (let i = 0; i < 80; i++) {
  const ready = await evalJs(`!!document.querySelector('.nc-nav, .nc-nav-item, nav')`).catch(() => false);
  if (ready) break;
  await sleep(300);
}
await sleep(1200);

/* ---------- 列表 ---------- */
currentStep = "list";
await clickText("服务器管理");
await sleep(900);
await shot("01-list-1440");

const list = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.srv-card')];
  return {
    cards: cards.length,
    logos: [...document.querySelectorAll('.srv-os img')].map(i => i.getAttribute('src')),
    connectButtons: [...document.querySelectorAll('.srv-card button')].map(b => (b.textContent || '').trim()).filter(t => /连接|断开/.test(t)),
    subtitle: !!document.querySelector('.srv-sub'),
    foot: !!document.querySelector('.srv-page-foot'),
    counts: [...document.querySelectorAll('.srv-card-stats b')].map(b => b.textContent.trim()).slice(0, 3),
    addresses: [...document.querySelectorAll('.srv-card-addr')].map(e => e.textContent.trim()),
  };
})()`);
check("列表渲染 3 张主机卡片", list.cards === 3, JSON.stringify({ cards: list.cards }));
check("卡片使用官方系统标识", list.logos.some((s) => /\/brand\/os\/ubuntu\.svg$/.test(s)) && list.logos.some((s) => /debian\.svg$/.test(s)), JSON.stringify(list.logos));
check("列表无连接/断开按钮", list.connectButtons.length === 0, JSON.stringify(list.connectButtons));
check("列表无副标题与页脚说明", !list.subtitle && !list.foot, JSON.stringify({ subtitle: list.subtitle, foot: list.foot }));
check("地址显示 user@host:port", list.addresses.includes("ops@192.0.2.24:22"), JSON.stringify(list.addresses));

/* ---------- 新增弹窗 ---------- */
await clickText("添加主机");
await sleep(600);
await shot("02-add-default");

const dlg = await evalJs(`(() => {
  const dialog = document.querySelector('dialog.modal[open]');
  const foot = dialog.querySelector('.modal-foot');
  const body = dialog.querySelector('.modal-body');
  const r = dialog.getBoundingClientRect();
  return {
    height: Math.round(r.height),
    footerBottom: Math.round(foot.getBoundingClientRect().bottom),
    dialogBottom: Math.round(r.bottom),
    bodyScroll: Math.round(body.scrollHeight),
    text: (dialog.textContent || '').replace(/\\s+/g, ' ').trim(),
    hasTest: !!dialog.querySelector('.srv-test button'),
  };
})()`);
check("弹窗按内容高度且底栏贴合", Math.abs(dlg.footerBottom - dlg.dialogBottom) <= 3, JSON.stringify({ height: dlg.height, footerBottom: dlg.footerBottom, dialogBottom: dlg.dialogBottom }));
check("弹窗无说明性文案且含测试连接", dlg.hasTest && !/免认证（无凭据）|连接后可|高风险命令逐次审批|留空沿用已保存密码，不读取/.test(dlg.text), dlg.text.slice(0, 200));

/* ---------- 测试连接成功 ---------- */
await setInput("#srv-name", "预发布 · web");
await setInput("#srv-host", "192.0.2.60");
await setInput("#srv-username", "deploy");
await setInput("#srv-password", "demo-secret");
await sleep(150);
await clickText("测试连接");
await sleep(120);
await shot("03-test-connecting");
const testing = await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); return (d.textContent || '').includes('测试中'); })()`);
check("测试连接有进行中状态", testing, String(testing));
await sleep(900);
await shot("04-test-success");
const okText = await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); const el = d && d.querySelector('.srv-test-result'); return el ? el.textContent.trim() : null; })()`);
check("测试连接成功显示系统", /连接成功 · .*Ubuntu/.test(okText || ""), okText);

await clickText("保存");
await sleep(1200);
const afterSave = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.srv-card')];
  const last = cards[cards.length - 1];
  return { count: cards.length, name: last && last.querySelector('.srv-card-name b')?.textContent.trim(), logo: last && last.querySelector('.srv-os img')?.getAttribute('src'), os: last && last.querySelector('.srv-card-foot span')?.textContent.trim() };
})()`);
check("保存后列表新增主机并带系统标识", afterSave.count === 4 && /Ubuntu/.test(afterSave.os || "") && /ubuntu\.svg$/.test(afterSave.logo || ""), JSON.stringify(afterSave));

/* ---------- 编辑私钥主机 ---------- */
await evalJs(`(() => { const cards = [...document.querySelectorAll('.srv-card')]; const el = cards.find(c => /构建机/.test(c.textContent)); el.querySelector('button[aria-label^="编辑"]').click(); return true; })()`);
await sleep(600);
await shot("05-edit-key");
const keyForm = await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); return { key: !!d.querySelector('#srv-keypath'), pass: !!d.querySelector('#srv-password'), placeholder: d.querySelector('#srv-keypath')?.getAttribute('placeholder') }; })()`);
check("编辑私钥主机展示私钥字段", keyForm.key && !keyForm.pass && /已保存/.test(keyForm.placeholder || ""), JSON.stringify(keyForm));

/* ---------- 测试连接失败 ---------- */
// 改了地址就必须重新填凭据（防把已保存凭据发往新主机），所以先补私钥路径。
await setInput("#srv-keypath", "~/.ssh/id_ed25519_demo");
await setInput("#srv-host", "198.51.100.28");
await sleep(120);
await clickText("测试连接");
await sleep(900);
await shot("06-test-fail");
const failText = await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); const el = d && d.querySelector('.srv-test-result'); return el ? el.textContent.trim() : null; })()`);
check("不可达主机测试失败且不伪造成功", /连接失败|超时/.test(failText || "") && !/成功/.test(failText || ""), failText);

/* ---------- 改地址但留空凭据时必须要求重新填写 ---------- */
await setInput("#srv-keypath", "");
await sleep(120);
await clickText("测试连接");
await sleep(400);
const guardError = await evalJs(`(() => {
  const d = document.querySelector('dialog.modal[open]');
  return { err: d.querySelector('.srv-field-err')?.textContent.trim() ?? null, result: d.querySelector('.srv-test-result')?.textContent.trim() ?? null };
})()`);
check("改地址后留空凭据不放行测试", /私钥/.test(guardError.err || "") && !guardError.result, JSON.stringify(guardError));
await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); [...d.querySelectorAll('button')].find(b => b.textContent.trim() === '取消').click(); return true; })()`);
await sleep(400);

/* ---------- 工作台自动连接 ---------- */
currentStep = "workbench";
await evalJs(`(() => { const card = [...document.querySelectorAll('.srv-card')].find(c => /预约服务/.test(c.textContent)); card.click(); return true; })()`);
const firstFrame = await evalJs(`(() => { const b = document.querySelector('.wb-term-body'); const t = document.querySelector('.term-host'); const r = b ? b.getBoundingClientRect() : null; return { body: r ? [Math.round(r.width), Math.round(r.height)] : null, term: t ? [t.clientWidth, t.clientHeight] : null }; })()`);
await sleep(220);
await shot("07-workbench-connecting");
const wbConnecting = await evalJs(`(() => { const s = document.querySelector('.srv-wb-conn'); return { text: s && s.textContent.trim(), state: !!document.querySelector('.srv-conn-state') }; })()`);
check("进入工作台自动连接中", /正在连接/.test(wbConnecting.text || ""), JSON.stringify({ ...wbConnecting, firstFrame }));

await sleep(1500);
await shot("08-workbench-connected");
const wbConnected = await evalJs(`(() => {
  const s = document.querySelector('.srv-wb-conn');
  return {
    text: s && s.textContent.trim(),
    terminal: !!document.querySelector('.wb-term-body'),
    buttons: [...document.querySelectorAll('.srv-wb-head button, .wb-center button')].map(b => (b.textContent || '').trim()).filter(t => /连接|断开/.test(t)),
    logo: document.querySelector('.srv-wb-os img')?.getAttribute('src'),
  };
})()`);
check("工作台已连接且无连接/断开按钮", /已连接/.test(wbConnected.text || "") && wbConnected.terminal && wbConnected.buttons.length === 0, JSON.stringify(wbConnected));
check("工作台顶栏使用官方系统标识", /ubuntu\.svg$/.test(wbConnected.logo || ""), wbConnected.logo);

/* ---------- 关闭页签自动断开 ---------- */
currentStep = "closeTab";
const connectedBefore = await evalJs(`(async () => {
  const list = await window.__TAURI_INTERNALS__.invoke('server_list', {});
  return list.find(h => /预约服务/.test(h.name))?.connected ?? null;
})()`).catch(() => "unavailable");
await evalJs(`(() => { const tab = document.querySelector('.nc-window-tab.active'); const close = tab && tab.querySelector('.nc-tab-close'); if (!close) throw new Error('找不到页签关闭按钮'); close.click(); return true; })()`);
await sleep(500);
const confirmText = await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); return d ? d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null; })()`);
check("关闭页签先给保留状态的确认", /关闭对象 Tab/.test(confirmText || ""), confirmText);
await clickText("保留状态并关闭 Tab");
await sleep(1400);
const connectedAfter = await evalJs(`(async () => {
  const list = await window.__TAURI_INTERNALS__.invoke('server_list', {});
  return list.find(h => /预约服务/.test(h.name))?.connected ?? null;
})()`).catch(() => "unavailable");
check("关闭工作台页签自动断开", connectedBefore === true && connectedAfter === false, JSON.stringify({ connectedBefore, connectedAfter }));

/* ---------- 工作台连接失败 ---------- */
currentStep = "workbenchFail";
await clickText("服务器管理");
await sleep(600);
await evalJs(`(() => { const card = [...document.querySelectorAll('.srv-card')].find(c => /归档/.test(c.textContent)); card.click(); return true; })()`);
await sleep(1200);
await shot("13-workbench-fail");
const wbFail = await evalJs(`(() => {
  const vis = sel => [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null) ?? null;
  const head = vis('.srv-wb-conn');
  const state = vis('.srv-conn-state');
  return {
    head: head && head.textContent.trim(),
    stateText: state ? state.textContent.replace(/\\s+/g, ' ').trim() : null,
    retry: !!(state && [...state.querySelectorAll('button')].find(b => b.textContent.trim() === '重试')),
    connectButtons: [...document.querySelectorAll('.srv-wb-head button, .wb-center button, .wb-monitor button')].filter(e => e.offsetParent !== null).map(b => (b.textContent || '').trim()).filter(t => /^(连接|断开)$/.test(t)),
    monitor: vis('.mon-offline')?.textContent.trim() ?? null,
  };
})()`);
check("连接失败只提供重试且无连接/断开按钮", /连接失败/.test(wbFail.head || "") && wbFail.retry && wbFail.connectButtons.length === 0, JSON.stringify(wbFail));
check("未连接时监控不铺陈旧数据", wbFail.monitor === "无数据", String(wbFail.monitor));
await evalJs(`(() => { const tab = document.querySelector('.nc-window-tab.active'); tab.querySelector('.nc-tab-close').click(); return true; })()`);
await sleep(400);
await clickText("保留状态并关闭 Tab");
await sleep(900);

/* ---------- 深色 + 390 ---------- */
currentStep = "dark";
await clickText("服务器管理");
await sleep(700);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);
await sleep(400);
await shot("09-list-dark-1440");
await clickText("添加主机");
await sleep(600);
await shot("14-dialog-dark-1440");
await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); [...d.querySelectorAll('button')].find(b => b.textContent.trim() === '取消').click(); return true; })()`);
await sleep(300);
await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true; })()`);

currentStep = "narrow";
await viewport(390, 844, true);
await sleep(600);
await shot("10-list-390");
const narrow = await evalJs(`(() => {
  const card = document.querySelector('.srv-card');
  const page = document.querySelector('.srv-page');
  return { scrollW: page.scrollWidth, clientW: page.clientWidth, cardW: card ? Math.round(card.getBoundingClientRect().width) : 0, cols: getComputedStyle(document.querySelector('.srv-cards')).gridTemplateColumns };
})()`);
check("390 列表单列且无横向溢出", narrow.scrollW <= narrow.clientW + 1 && narrow.cardW > 300, JSON.stringify(narrow));

await clickText("添加主机");
await sleep(600);
await shot("11-dialog-390");
const dlg390 = await evalJs(`(() => {
  const d = document.querySelector('dialog.modal[open]');
  const r = d.getBoundingClientRect();
  const foot = d.querySelector('.modal-foot').getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, footerVisible: foot.bottom <= innerHeight + 1 && foot.top >= 0 };
})()`);
check("390 弹窗不溢出且底栏可见", dlg390.left >= 0 && dlg390.right <= dlg390.vw && dlg390.footerVisible, JSON.stringify(dlg390));
await evalJs(`(() => { const d = document.querySelector('dialog.modal[open]'); [...d.querySelectorAll('button')].find(b => b.textContent.trim() === '取消').click(); return true; })()`);
await sleep(300);

/* ---------- 390 工作台 ---------- */
currentStep = "narrowWorkbench";
await evalJs(`(() => { const card = [...document.querySelectorAll('.srv-card')].find(c => /预约服务/.test(c.textContent)); card.click(); return true; })()`);
await sleep(1800);
await shot("12-workbench-390");
const wb390 = await evalJs(`(() => {
  const vis = sel => [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null) ?? null;
  const term = vis('.wb-term-body');
  const shell = vis('.wb-root');
  const page = vis('.srv-wb');
  return {
    termWidth: term ? Math.round(term.getBoundingClientRect().width) : 0,
    shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
    pageWidth: page ? Math.round(page.getBoundingClientRect().width) : 0,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`);
check("390 工作台终端占满且无横向溢出", wb390.termWidth > 300 && wb390.overflowX <= 0, JSON.stringify(wb390));
await evalJs(`(() => { const tab = document.querySelector('.nc-window-tab.active'); tab.querySelector('.nc-tab-close').click(); return true; })()`);
await sleep(400);
await clickText("保留状态并关闭 Tab");
await sleep(600);

await viewport(1440, 900);
await sleep(400);

const result = { generatedAt: new Date().toISOString(), app: APP, checks, jsErrors };

/* 记录本次软件实现的文件指纹，便于"截图对应哪版代码"可复核。 */
const HASHED = [
  "src/modules/servers/HostList.tsx",
  "src/modules/servers/HostForm.tsx",
  "src/modules/servers/Workbench.tsx",
  "src/modules/servers/hostVisual.ts",
  "src/modules/servers/MonitorPane.tsx",
  "src/modules/servers/TerminalPane.tsx",
  "src/modules/servers/servers.css",
  "src/api/index.ts",
  "src/store/app.tsx",
  "src-tauri/src/ssh/mod.rs",
  "src-tauri/src/commands/servers.rs",
  "public/brand/os/ubuntu.svg",
];
result.hashes = Object.fromEntries(
  HASHED.map((file) => [file, createHash("sha256").update(readFileSync(resolve(file))).digest("hex")])
);

writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
const passed = checks.filter((c) => c.pass).length;
console.log(JSON.stringify({ passed, failed: checks.length - passed, errors: jsErrors.length }, null, 2));
process.exit(0);