/** CR-087 软件侧验证：顶部面包屑第一段由「个人工作台」文字改为小房子（home）图标。
 * 用法：先 `npx vite --port 1420 --strictPort`，再 `node scripts/verify-cr087-software.mjs`
 * 页面：http://127.0.0.1:1420/?preview=design（内存合成夹具）
 * 输出：docs/Test/screenshots/cr087-software/*.png + docs/Test/cr087-software-baseline.json
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const APP = process.env.CR087_APP || "http://127.0.0.1:1420/?preview=design";
const OUT = resolve("docs/Test/screenshots/cr087-software");
const JSON_OUT = resolve("docs/Test/cr087-software-baseline.json");
const CDP = 9472;
mkdirSync(OUT, { recursive: true });

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
const profile = join(tmpdir(), "edge-cr087-" + Date.now());
let proc = null;
for (const exe of EDGE) {
  try {
    proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
    break;
  } catch { /* 换下一个 */ }
}
if (!proc) throw new Error("未找到 Edge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 120 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => x.type === "page"); } catch {}
  if (!page) await sleep(300);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");

const jsErrors = [];
let step = "boot";
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") jsErrors.push(`[${step}] ${m.params.exceptionDetails?.text} ${m.params.exceptionDetails?.exception?.description || ""}`.trim());
});

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
};
const shot = async (name, sel) => {
  let clip;
  if (sel) clip = await evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.max(0,r.x-6),y:Math.max(0,r.y-6),width:Math.min(r.width+12, innerWidth),height:r.height+12,scale:1};})()`);
  const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  writeFileSync(join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("SHOT", name);
};
const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const clickText = (text) => evalJs(`(() => {
  const all = [...document.querySelectorAll('button,a,[role=button]')];
  const vis = all.filter(e => e.getClientRects().length);
  const el = vis.find(e => (e.textContent||'').trim() === ${JSON.stringify(text)}) || vis.find(e => (e.textContent||'').includes(${JSON.stringify(text)}));
  if (!el) throw new Error('找不到 ' + ${JSON.stringify(text)});
  el.click(); return true;
})()`);

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, detail === undefined ? "" : detail);
};

const probe = () => evalJs(`(() => {
  const ctx = document.querySelector('.nc-context');
  if (!ctx) return null;
  const home = ctx.querySelector('.nc-context-home');
  const icon = home && home.querySelector('.ui-icon');
  const r = ctx.getBoundingClientRect();
  const ri = icon && icon.getBoundingClientRect();
  return {
    text: (ctx.textContent || '').replace(/\\s+/g, ' ').trim(),
    containsOldText: (ctx.textContent || '').includes('个人工作台'),
    homeExists: !!home,
    homeRole: home ? home.getAttribute('role') : null,
    homeLabel: home ? home.getAttribute('aria-label') : null,
    homeTitle: home ? home.getAttribute('title') : null,
    homeColor: home ? getComputedStyle(home).color : null,
    ctxColor: getComputedStyle(ctx).color,
    iconName: icon ? icon.getAttribute('data-icon') : null,
    iconMissing: icon ? icon.getAttribute('data-icon-missing') : null,
    iconW: ri ? Math.round(ri.width) : null,
    iconH: ri ? Math.round(ri.height) : null,
    ctxW: Math.round(r.width),
    ctxH: Math.round(r.height),
    contextVisible: getComputedStyle(ctx).display !== 'none',
  };
})()`);

await viewport(1440, 900);
await send("Page.navigate", { url: APP });
for (let i = 0; i < 100; i++) { if (await evalJs(`!!document.querySelector('.nc-context, .nc-topbar')`).catch(() => false)) break; await sleep(300); }
await sleep(1200);

/* ---------- 首页 ---------- */
step = "home";
const home = await probe();
check("面包屑存在", !!home, home && home.text);
check("不再显示「个人工作台」文字", home && !home.containsOldText, home && home.text);
check("第一段为 home 图标", home && home.homeExists && home.iconName === "home" && !home.iconMissing, home && JSON.stringify({ icon: home.iconName, missing: home.iconMissing }));
check("图标 14px", home && home.iconW === 14 && home.iconH === 14, home && JSON.stringify({ w: home.iconW, h: home.iconH }));
check("可读名称仍为「个人工作台」", home && home.homeRole === "img" && home.homeLabel === "个人工作台" && home.homeTitle === "个人工作台", home && JSON.stringify({ role: home.homeRole, label: home.homeLabel, title: home.homeTitle }));
check("图标颜色与面包屑主体同级（--ink-2，未被 muted 覆盖）", home && home.homeColor === home.ctxColor, home && JSON.stringify({ icon: home.homeColor, ctx: home.ctxColor }));
await shot("01-home-topbar-1440");
await shot("02-home-context-1440", ".nc-context");

/* ---------- 打开项目：第二段仍是对象名 ---------- */
step = "project";
await clickText("项目管理");
await sleep(900);
await evalJs(`(() => { const r=document.querySelector('.nc-list-row, .proj-card, [data-project]'); if(!r) throw new Error('项目列表为空'); r.click(); return true; })()`);
await sleep(1200);
const project = await probe();
const projectLabel = await evalJs(`(() => { const t=document.querySelector('.nc-window-tab.active .nc-tab-label'); return t ? t.textContent.trim() : null; })()`);
check("项目页仍为 home 图标 + 分隔符 + 项目名", project && project.iconName === "home" && project.text.replace(/\s+/g, "") === `/${projectLabel}`, project && JSON.stringify({ text: project.text, tab: projectLabel }));
await shot("03-project-context-1440", ".nc-context");
await shot("04-project-topbar-1440");

/* ---------- 深色 ---------- */
step = "dark";
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`);
await sleep(500);
const dark = await probe();
check("深色下图标仍可见且仍为 home", dark && dark.iconName === "home", dark && JSON.stringify({ color: dark.homeColor, icon: dark.iconName }));
await shot("05-project-context-dark-1440", ".nc-context");

/* ---------- 390 窄屏：既有规则隐藏整个上下文 ---------- */
step = "narrow";
await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true; })()`);
await viewport(390, 844, true);
await sleep(700);
const narrow = await evalJs(`(() => {
  const ctx = document.querySelector('.nc-context');
  return { display: ctx ? getComputedStyle(ctx).display : null, docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
})()`);
check("390 按既有规则隐藏上下文且无横向溢出", narrow.display === "none" && narrow.docOverflowX <= 1, JSON.stringify(narrow));
await shot("06-narrow-390");
await viewport(1440, 900);
await sleep(300);

const result = { generatedAt: new Date().toISOString(), app: APP, checks, jsErrors };
const HASHED = ["src/App.tsx", "src/theme/workbench.css", "public/ui/icon-sprite.svg"];
result.hashes = Object.fromEntries(HASHED.map((f) => [f, createHash("sha256").update(readFileSync(resolve(f))).digest("hex")]));
writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
const passed = checks.filter((c) => c.pass).length;
console.log(JSON.stringify({ passed, failed: checks.length - passed, errors: jsErrors.length }, null, 2));
ws.close(); proc.kill();
