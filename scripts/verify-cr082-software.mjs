/** CR-082 软件侧验证：工作台页签＝电脑（显示器）图标 + 文字「工作台」。
 * 用法：先 `npx vite --port 1420 --strictPort`，再 `node scripts/verify-cr082-software.mjs`
 * 页面：http://127.0.0.1:1420/?preview=design（内存合成夹具，不读真实项目数据）
 * 输出：docs/Test/screenshots/cr082-software/*.png + docs/Test/cr082-software-baseline.json
 * 说明：截图是软件实现证据，不是设计稿；设计侧证据见 scripts/shot-cr082.mjs。
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const APP = process.env.CR082_APP || "http://127.0.0.1:1420/?preview=design";
const OUT = resolve("docs/Test/screenshots/cr082-software");
const JSON_OUT = resolve("docs/Test/cr082-software-baseline.json");
const CDP = 9462;
mkdirSync(OUT, { recursive: true });

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
const profile = join(tmpdir(), "edge-cr082-sw-" + Date.now());
let edgeProc = null;
for (const exe of EDGE) {
  try {
    edgeProc = spawn(exe, [
      "--headless=new", `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*",
      `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--disable-features=OverlayScrollbar",
      "--window-size=1440,900", "about:blank",
    ], { stdio: "ignore" });
    break;
  } catch { /* 换下一个路径 */ }
}
if (!edgeProc) throw new Error("未找到 Edge 可执行文件");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 120; i++) {
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

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, detail === undefined ? "" : detail);
};

/* 探针：页签结构、图标与文字几何、页签条溢出 */
const probeTab = () => evalJs(`(() => {
  const tab = document.querySelector('.pw-tab.wb-tab-icon');
  if (!tab) return null;
  const icon = tab.querySelector('.ui-icon');
  const span = tab.querySelector('span');
  const bar = document.querySelector('.pw-top');
  const host = document.querySelector('.pw-top .tab-overflow-host');
  const rt = tab.getBoundingClientRect();
  const ri = icon && icon.getBoundingClientRect();
  const rs = span && span.getBoundingClientRect();
  const cs = getComputedStyle(tab);
  return {
    text: (tab.textContent || '').trim(),
    ariaLabel: tab.getAttribute('aria-label'),
    title: tab.getAttribute('title'),
    selected: tab.getAttribute('aria-selected'),
    iconName: icon && icon.getAttribute('data-icon'),
    iconMissing: icon && icon.getAttribute('data-icon-missing'),
    iconW: ri ? Math.round(ri.width) : null,
    iconH: ri ? Math.round(ri.height) : null,
    tabW: Math.round(rt.width),
    tabH: Math.round(rt.height),
    gap: cs.gap,
    display: cs.display,
    iconCenterY: ri ? +(ri.y + ri.height / 2).toFixed(1) : null,
    textCenterY: rs ? +(rs.y + rs.height / 2).toFixed(1) : null,
    barOverflowX: host ? host.scrollWidth - host.clientWidth : (bar ? bar.scrollWidth - bar.clientWidth : null),
    hasMoreBtn: !!document.querySelector('.pw-top .tab-more'),
    tabs: [...document.querySelectorAll('.pw-tab')].map(t => (t.textContent || '').trim() || t.getAttribute('aria-label')),
  };
})()`);

await viewport(1440, 900);
await send("Page.navigate", { url: APP });
for (let i = 0; i < 100; i++) {
  const ready = await evalJs(`!!document.querySelector('.nav-item, nav')`).catch(() => false);
  if (ready) break;
  await sleep(300);
}
await sleep(1500);

/* ---------- 打开项目 ---------- */
currentStep = "open-project";
await clickText("项目管理");
await sleep(1000);
const opened = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.nc-list-row, .proj-card, [data-project]')].filter(e => e.getClientRects().length);
  if (!rows.length) throw new Error('项目列表为空');
  rows[0].click();
  return (rows[0].textContent || '').trim().slice(0, 40);
})()`);
await sleep(1200);
await evalJs(`(() => { const t = document.querySelector('.pw-tab.wb-tab-icon'); if (t && t.getAttribute('aria-selected') !== 'true') t.click(); return true; })()`);
await sleep(700);

currentStep = "probe-light";
const light = await probeTab();
check("工作台页签存在并可读", !!light, JSON.stringify(light && { text: light.text, ariaLabel: light.ariaLabel }));
check("页签显示文字「工作台」", light && light.text === "工作台", light && light.text);
check("页签使用电脑（显示器）图标 monitor", light && light.iconName === "monitor" && !light.iconMissing, light && JSON.stringify({ icon: light.iconName, missing: light.iconMissing }));
check("图标 16px 且与文字同行居中", light && light.iconW === 16 && light.iconH === 16 && Math.abs(light.iconCenterY - light.textCenterY) <= 1, light && JSON.stringify({ w: light.iconW, h: light.iconH, ic: light.iconCenterY, tc: light.textCenterY }));
check("图标与文字间距 6px", light && light.gap === "6px", light && light.gap);
check("页签高度与其他项目页签一致 44px", light && light.tabH === 44, light && String(light.tabH));
check("页签条无横向溢出", light && light.barOverflowX !== null && light.barOverflowX <= 1, light && String(light.barOverflowX));
await shot("01-workbench-tab-1440");

/* ---------- 切到其他页签的未选中态 ---------- */
currentStep = "inactive";
await evalJs(`(() => { const t = [...document.querySelectorAll('.pw-tab')].find(x => (x.textContent || '').trim() === '编码' || (x.textContent || '').trim() === '文档'); if (t) t.click(); return true; })()`);
await sleep(600);
const inactive = await probeTab();
await shot("02-inactive-workbench-tab-1440");
check("未选中时仍为电脑图标＋文字", inactive && inactive.text === "工作台" && inactive.iconName === "monitor" && inactive.selected === "false", inactive && JSON.stringify({ text: inactive.text, icon: inactive.iconName, selected: inactive.selected }));
await evalJs(`(() => { const t = document.querySelector('.pw-tab.wb-tab-icon'); if (t) t.click(); return true; })()`);
await sleep(500);

/* ---------- 深色 ---------- */
currentStep = "dark";
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);
await sleep(500);
await shot("03-workbench-tab-dark-1440");
const dark = await probeTab();
check("深色下页签图标与文字仍可见", dark && dark.text === "工作台" && dark.iconName === "monitor", dark && JSON.stringify({ text: dark.text, icon: dark.iconName }));

/* ---------- 390 窄屏 ---------- */
currentStep = "narrow";
await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true; })()`);
await viewport(390, 844, true);
await sleep(800);
await shot("04-workbench-tab-390");
const narrow = await evalJs(`(() => {
  const host = document.querySelector('.pw-top .tab-overflow-host');
  const tab = document.querySelector('.pw-tab.wb-tab-icon');
  const more = document.querySelector('.pw-top .tab-more');
  const doc = document.documentElement;
  return {
    hostOverflow: host ? host.scrollWidth - host.clientWidth : null,
    tabText: tab ? (tab.textContent || '').trim() : null,
    tabW: tab ? Math.round(tab.getBoundingClientRect().width) : null,
    moreVisible: more ? getComputedStyle(more).display !== 'none' : null,
    docOverflowX: doc.scrollWidth - doc.clientWidth,
  };
})()`);
check("390 页签条走溢出下拉且不产生横向滚动", narrow && narrow.tabText === "工作台" && narrow.docOverflowX <= 1, JSON.stringify(narrow));
await viewport(1440, 900);
await sleep(400);

const result = { generatedAt: new Date().toISOString(), app: APP, openingProject: opened, checks, jsErrors };
const HASHED = [
  "src/modules/projects/Workspace.tsx",
  "src/modules/workbench/workbench.css",
  "src/components/icons.tsx",
  "public/ui/icon-sprite.svg",
  "src/smoke/ui-suite.ts",
];
result.hashes = Object.fromEntries(HASHED.map((file) => [file, createHash("sha256").update(readFileSync(resolve(file))).digest("hex")]));
writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
const passed = checks.filter((c) => c.pass).length;
console.log(JSON.stringify({ passed, failed: checks.length - passed, errors: jsErrors.length }, null, 2));
ws.close();
edgeProc.kill();
