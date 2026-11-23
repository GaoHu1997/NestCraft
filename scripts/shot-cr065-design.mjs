/**
 * CR-064 设计稿截图与断言（workbench-v4）。
 * 前置：chrome --headless=new --remote-debugging-port=9333 about:blank
 * 运行：node scripts/shot-cr065-design.mjs
 * 输出：docs/Test/screenshots/cr065-design/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr065-design";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page");
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
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
  await wait(180);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///D:/github/AI_Delelovelop/docs/UI/workbench-v4/index.html" });
await wait(1800);

await evaluate(`(() => {
  const UI = window.UI;
  const p = UI.D.projects.find(x => /预约/.test(x.name)) || UI.D.projects[0];
  UI.openWindow("project", p.id, p.name);
  UI.store.aiOpen = true;
  UI.store.aiHistory = true;
  UI.store.aiHistLimit = 20;
  UI.store.aiHistQuery = "";
  UI.store.aiHistMenu = null;
  UI.store.aiSession = UI.D.ai.sessions[0].id;
  UI.render();
  return true;
})()`);
await wait(300);

const base = await evaluate(`(() => {
  const active = document.querySelector(".ai-session.active");
  const cs = active ? getComputedStyle(active) : null;
  return {
    activeBorder: cs ? cs.borderTopWidth + "/" + cs.borderTopStyle : null,
    activeBg: cs ? cs.backgroundColor : null,
    marks: {
      spin: document.querySelectorAll(".ai-hist-spin").length,
      good: document.querySelectorAll(".ai-hist-dot.dot-good").length,
      bad: document.querySelectorAll(".ai-hist-dot.dot-bad").length,
      warn: document.querySelectorAll(".ai-hist-dot.dot-warn").length,
      blank: document.querySelectorAll(".ai-hist-mark").length,
    },
    stateText: document.querySelectorAll(".ai-session .s-state").length,
    newButton: [...document.querySelectorAll(".ai-history button")].some(b => (b.textContent || "").includes("新会话")),
    footer: !!document.querySelector(".ai-history-f"),
    reset: (() => { const b = document.querySelector(".ahs-all"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
    rows: document.querySelectorAll(".ai-history .ai-session").length,
  };
})()`);
console.log("base", JSON.stringify(base));
await shot("c65-01-list-states");

// 搜索 → 重置可用
await evaluate(`(() => { UI.store.aiHistQuery = "会话"; UI.render(); return true; })()`);
const reset = await evaluate(`(() => { const b = document.querySelector(".ahs-all"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()`);
console.log("reset-in-search", JSON.stringify(reset));
await shot("c65-02-search-reset");
await evaluate(`(() => { UI.store.aiHistQuery = ""; UI.render(); return true; })()`);

// 行内「…」菜单
const menu = await evaluate(`(() => {
  const btn = document.querySelector(".ai-hist-more-btn");
  if (btn) btn.click();
  return {
    open: !!document.querySelector(".ai-hist-menu"),
    items: [...document.querySelectorAll(".ai-hist-menu button")].map(b => (b.textContent || "").trim()),
  };
})()`);
console.log("menu", JSON.stringify(menu));
await shot("c65-03-menu");

// 原位重命名（不弹框）
const rename = await evaluate(`(async () => {
  let item = [...document.querySelectorAll(".ai-hist-menu button")].find(b => (b.textContent || "").includes("重命名"));
  if (!item) { document.querySelector(".ai-hist-more-btn")?.click(); item = [...document.querySelectorAll(".ai-hist-menu button")].find(b => (b.textContent || "").includes("重命名")); }
  if (item) item.click();
  await new Promise(r => setTimeout(r, 200));
  const input = document.getElementById("ai-hist-rename-input");
  return {
    input: !!input,
    focused: document.activeElement === input,
    dialog: !!document.querySelector("dialog[open]"),
    value: input ? input.value : null,
  };
})()`);
console.log("rename-inline", JSON.stringify(rename));
await shot("c65-04-rename-inline");

const renameSaved = await evaluate(`(async () => {
  const input = document.getElementById("ai-hist-rename-input");
  if (!input) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "重命名后的会话标题");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return {
    inputGone: !document.getElementById("ai-hist-rename-input"),
    titleShown: [...document.querySelectorAll(".ai-session b")].some(b => (b.textContent || "").includes("重命名后的会话标题")),
    editId: window.UI?.store?.aiHistEditId ?? null,
  };
})()`);
console.log("rename-saved", JSON.stringify(renameSaved));
await shot("c65-04b-rename-saved");

// 置顶（演示数据初始已有一条置顶，这里切换并再切回）
const pin = await evaluate(`(() => {
  const before = UI.D.ai.sessions.filter(s => s.pinned).length;
  UI.render();
  const btn = document.querySelector(".ai-hist-more-btn");
  if (btn) btn.click();
  const pinItem = [...document.querySelectorAll(".ai-hist-menu button")].find(b => (b.textContent || "").includes("置顶"));
  if (pinItem) pinItem.click();
  const after = UI.D.ai.sessions.filter(s => s.pinned).length;
  UI.render();
  const btn2 = document.querySelector(".ai-hist-more-btn");
  if (btn2) btn2.click();
  const pinItem2 = [...document.querySelectorAll(".ai-hist-menu button")].find(b => (b.textContent || "").includes("置顶"));
  if (pinItem2) pinItem2.click();
  const restored = UI.D.ai.sessions.filter(s => s.pinned).length;
  return { before, after, restored, pinIcon: document.querySelectorAll(".ai-hist-pin-ico").length };
})()`);
console.log("pin", JSON.stringify(pin));
await shot("c65-05-pinned");

// 分叉
const fork = await evaluate(`(() => {
  const before = UI.D.ai.sessions.length;
  const btn = document.querySelector(".ai-hist-more-btn");
  if (btn) btn.click();
  const forkItem = [...document.querySelectorAll(".ai-hist-menu button")].find(b => (b.textContent || "").includes("分叉"));
  if (forkItem) forkItem.click();
  const first = UI.D.ai.sessions[0];
  return { before, after: UI.D.ai.sessions.length, title: first.title, active: first.id === UI.store.aiSession };
})()`);
console.log("fork", JSON.stringify(fork));
await shot("c65-06-forked");

// 深色（先等 toast 自动消失，避免遮挡列表）
await wait(4200);
await evaluate(`(() => { document.documentElement.dataset.theme = "dark"; UI.store.aiHistQuery = "会话"; UI.render(); return true; })()`);
await shot("c65-07-dark");

// 390 窄屏
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await wait(350);
const narrow = await evaluate(`(() => {
  document.documentElement.dataset.theme = "light";
  const btn = [...document.querySelectorAll("button.pane-toggle")].find(b => b.textContent.trim() === "AI 侧栏");
  if (btn) btn.click();
  UI.store.aiOpen = true;
  UI.store.aiHistory = true;
  UI.store.aiHistQuery = "";
  UI.render();
  const h = document.querySelector(".ai-history");
  const r = h?.getBoundingClientRect();
  return { open: !!h, width: r ? Math.round(r.width) : null, viewport: window.innerWidth, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 };
})()`);
console.log("narrow", JSON.stringify(narrow));
await shot("c65-08-narrow");

ws.close();