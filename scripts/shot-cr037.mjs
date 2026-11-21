/**
 * CR-037 软件截图（真实应用窗口，经 CDP）：断点卡 / blocked 横幅 / fresh 确认弹窗。
 * 前置：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 启动（隔离冒烟库）。
 * 运行：node scripts/shot-cr037.mjs
 * 输出：docs/Test/screenshots/cr037-sidebar/sw-*.png 与 design-*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr037-sidebar";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"))
  ?? list.find((p) => p.type === "page");
if (!page) throw new Error("未找到应用页面目标；请确认应用已带 9333 调试端口启动");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  await sleep(600);
  const data = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data.data, "base64"));
  console.log("saved", name);
}

/** 通过 invoke 准备数据（隔离冒烟库，不触碰真实库）。 */
async function invoke(cmd, args) {
  return js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
}

// 若 WebView 停在设计稿页，先回到应用
if (!page.url.includes("localhost:1420")) {
  await send("Page.navigate", { url: "http://localhost:1420/" });
  await sleep(3000);
}

// ---------- 准备三个状态的会话（mock CLI，办公项目作用域） ----------
const projects = await invoke("list_projects");
const office = projects.find((p) => p.name === "市场研究资料") ?? projects[0];
console.log("projects:", projects.map((p) => p.name).join(","));

await invoke("smoke_mock_resume", { mode: "confirm" });

// 直接在页面内完成创建与发送（复用前端 api 封装的 chatSend 逻辑）
const prepared = await js(`(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const projectId = ${JSON.stringify(office ? office.id : null)};
  const mod = await import("/src/api/index.ts");
  const sendWait = async (sid, text) => {
    const events = [];
    await mod.chatSend({ sessionId: sid, content: text, refs: [], attachments: [] }, (ev) => events.push(ev));
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (events.some((e) => e.type === "done" || e.type === "error")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return events;
  };
  const out = {};
  // s1：断点卡（confirm→confirm→silent-new）
  await inv("smoke_mock_resume", { mode: "confirm" });
  const s1 = await mod.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model" });
  await sendWait(s1.id, "第一轮");
  await sendWait(s1.id, "第二轮");
  await inv("smoke_mock_resume", { mode: "silent-new" });
  await sendWait(s1.id, "第三轮");
  await inv("smoke_mock_resume", { mode: "confirm" });
  out.s1 = s1.id;
  // s2：blocked（confirm→stale）
  const s2 = await mod.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "claude", modelId: "smoke-model" });
  await sendWait(s2.id, "阻塞会话第一轮");
  await new Promise((r) => setTimeout(r, 3200));
  await inv("smoke_mock_resume", { mode: "stale" });
  await sendWait(s2.id, "阻塞会话第二轮（应被拒）");
  await inv("smoke_mock_resume", { mode: "confirm" });
  out.s2 = s2.id;
  // s3：freshPending（grok 首轮后未确认）
  const s3 = await mod.chatSessionCreate({ ...(projectId ? { projectId } : {}), cliId: "grok", modelId: "smoke-model" });
  await sendWait(s3.id, "grok 首轮");
  out.s3 = s3.id;
  const m1 = await mod.chatSessionGet(out.s1);
  const m2 = await mod.chatSessionGet(out.s2);
  const m3 = await mod.chatSessionGet(out.s3);
  out.states = [m1.binding?.state, m2.binding?.state, m3.binding?.state];
  // 历史行按标题定位：显式写标题（等价于面板 finalize 的首轮命名）
  await mod.chatSessionUpdate({ id: out.s1, title: "第一轮" });
  await mod.chatSessionUpdate({ id: out.s2, title: "阻塞会话第一轮" });
  await mod.chatSessionUpdate({ id: out.s3, title: "grok 首轮" });
  return out;
})()`);
console.log("prepared:", JSON.stringify(prepared));
if (!prepared || prepared.states.join(",") !== "native,blocked,freshPending") {
  throw new Error("状态准备失败：" + JSON.stringify(prepared));
}

// ---------- 刷新页面使侧栏重新拉取会话 ----------
await send("Page.reload");
await sleep(2500);

// 进入办公项目工作区（点击项目卡片）
await js(`(() => {
  const card = Array.from(document.querySelectorAll('.card')).find(c => (c.textContent||'').includes('市场研究资料'));
  if (card) card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  else { const side = document.querySelector('.nc-side-project'); if (side) side.click(); }
})()`);
await sleep(1800);

// 打开 AI 侧栏（若为抽屉式则找触发按钮）
await js(`(() => {
  const btn = document.querySelector('[data-act="chat-open"], [aria-label*="AI"], [data-chat-overlay-trigger="history"]');
  const hist = document.querySelector('[data-act="chat-history-toggle"]');
  if (hist) hist.click();
})()`);
await sleep(800);
await js(`console.log("scope", document.querySelector(".chat-panel")?.dataset.aiScope)`);

const scope = await js(`document.querySelector(".chat-panel")?.dataset.aiScope ?? ""`);
console.log("chat scope:", scope);

// 打开历史浮层并点击目标会话（按标题文本定位：首轮消息即会话标题）
async function openSession(title, label) {
  const opened = await js(`(() => {
    if (!document.querySelector('.chat-history')) {
      const hist = document.querySelector('button[aria-label="会话历史"]');
      if (hist) hist.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    return !!document.querySelector('.chat-history');
  })()`);
  await sleep(700);
  const clicked = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.chat-hist-item'));
    const target = rows.find(r => (r.querySelector('.chat-hist-title')?.textContent || '').trim() === ${JSON.stringify(title)});
    if (!target) return 'not-found:' + rows.map(r => r.querySelector('.chat-hist-title')?.textContent).join('|');
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked';
  })()`);
  console.log("open", label, "overlay=" + opened, clicked);
  await sleep(900);
}

await shot("sw-00-office-sidebar");

await openSession("第一轮", "s1-断点卡");
await shot("sw-01-breakpoint-card");
// 深色
await invoke("set_theme", { theme: "dark" });
await js(`document.documentElement.dataset.theme='dark'`);
await shot("sw-02-breakpoint-dark");
await invoke("set_theme", { theme: "light" });
await js(`document.documentElement.dataset.theme='light'`);

await openSession("阻塞会话第一轮", "s2-blocked");
await shot("sw-03-blocked-banner");

await openSession("grok 首轮", "s3-freshPending");
// 点击「确认重建…」打开确认弹窗
await js(`(() => {
  const btn = Array.from(document.querySelectorAll('.chat-block-btn')).find(b => (b.textContent||'').includes('确认重建'));
  if (btn) btn.click();
})()`);
await sleep(700);
await shot("sw-04-fresh-confirm");
await js(`(() => {
  const cancel = Array.from(document.querySelectorAll('.modal button')).find(b => (b.textContent||'').trim()==='取消');
  if (cancel) cancel.click();
})()`);
await sleep(300);

// ---------- 设计稿对照截图（同一 WebView 打开设计稿文件） ----------
await send("Page.navigate", { url: "file:///D:/github/AI_Delelovelop/docs/UI/chat-resume-design/index.html" });
await sleep(1200);
await shot("design-01-light");
await js(`setTheme('dark')`);
await shot("design-02-dark");
await js(`setTheme('light'); setBp('dead')`);
await shot("design-03-breakpoint-dead");
// 390 窄视口：用 Emulation 覆盖
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(600);
await shot("design-04-390");
await send("Emulation.clearDeviceMetricsOverride");
await sleep(400);
console.log("done");
process.exit(0);
