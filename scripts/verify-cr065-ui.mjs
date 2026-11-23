/**
 * CR-065 软件侧行为验证（隔离设计预览：真实 ChatPanel + mock IPC）。
 * 前置：npm run preview（4173），Chrome headless --remote-debugging-port=9334。
 * 输出：docs/Test/screenshots/cr065-software/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr065-software";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
const page = list.find(p => p.type === "page" && String(p.url).includes("4173")) || list.find(p => p.type === "page");
if (!page) throw new Error("未找到浏览器页面目标");
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
  await wait(200);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(4500);

// 1) 造 48 条会话，并给最近 3 条设置未读状态
const seeded = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects[0];
  const target = await invoke("chat_session_create", { projectId: p.id });
  await invoke("chat_session_update", { id: target.id, title: "补充失败步骤的退出码说明" });
  const ids = [];
  for (let i = 0; i < 44; i++) ids.push((await invoke("chat_session_create", { projectId: p.id })).id);
  // 最近三条：成功未读 / 失败未读 / 待处理
  await invoke("chat_session_update", { id: ids[ids.length - 1], unread: "green" });
  await invoke("chat_session_update", { id: ids[ids.length - 2], unread: "red" });
  await invoke("chat_session_update", { id: ids[ids.length - 3], unread: "yellow" });
  const all = await invoke("chat_sessions", { projectId: p.id });
  return { projectId: p.id, name: p.name, total: all.length, targetId: target.id };
})()`);
console.log("seeded", JSON.stringify(seeded));

// 2) 打开项目 + 历史
await evaluate(`(async () => {
  const name = ${JSON.stringify(seeded.name)};
  const el = [...document.querySelectorAll(".nc-side-project")].find(n => (n.textContent || "").includes(name));
  if (el) el.click();
  await new Promise(r => setTimeout(r, 800));
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (hist) hist.click();
  await new Promise(r => setTimeout(r, 900));
  return true;
})()`);

const base = await evaluate(`(() => {
  const active = document.querySelector(".chat-hist-item.active");
  const cs = active ? getComputedStyle(active) : null;
  return {
    overlay: !!document.querySelector(".chat-history"),
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
    rows: document.querySelectorAll(".chat-hist-item").length,
    activeBorder: cs ? cs.borderTopWidth + "/" + cs.borderTopStyle : null,
    activeBg: cs ? cs.backgroundColor : null,
    stateText: document.querySelectorAll(".chat-hist-state").length,
    footer: !!document.querySelector(".chat-history-foot") || !!document.querySelector(".chat-hist-token"),
    stats: !!document.querySelector(".chat-stats"),
    statsHeight: document.querySelector(".chat-stats")?.getBoundingClientRect().height ?? null,
    footLine: !!document.querySelector(".chat-foot"),
    dots: {
      good: document.querySelectorAll(".chat-hist-dot.dot-good").length,
      bad: document.querySelectorAll(".chat-hist-dot.dot-bad").length,
      warn: document.querySelectorAll(".chat-hist-dot.dot-warn").length,
      blank: document.querySelectorAll(".chat-hist-mark").length,
    },
    moreBtn: document.querySelectorAll(".chat-hist-more-btn").length,
    reset: (() => { const b = document.querySelector(".chat-hist-all"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
  };
})()`);
console.log("base", JSON.stringify(base));
await shot("c65-sw-01-list");

// 3) 搜索 → 重置启用 → 点击重置
const search = await evaluate(`(async () => {
  const input = document.querySelector("#chat-history-q");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "退出码"); input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  const reset = document.querySelector(".chat-hist-all");
  const hit = { count: document.querySelector(".chat-history-count")?.textContent ?? null, enabled: reset ? !reset.disabled : null, rows: document.querySelectorAll(".chat-hist-item").length };
  reset?.click();
  await new Promise(r => setTimeout(r, 800));
  return { ...hit, afterReset: document.querySelector(".chat-history-count")?.textContent ?? null, resetDisabled: document.querySelector(".chat-hist-all")?.disabled ?? null };
})()`);
console.log("search-reset", JSON.stringify(search));

// 4) 「…」菜单
const menu = await evaluate(`(async () => {
  const btn = document.querySelector(".chat-hist-more-btn");
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 200));
  const items = [...document.querySelectorAll(".chat-hist-menu button")].map(b => (b.textContent || "").trim());
  return { open: !!document.querySelector(".chat-hist-menu"), items };
})()`);
console.log("menu", JSON.stringify(menu));
await shot("c65-sw-02-menu");

// 5) 原位重命名
const rename = await evaluate(`(async () => {
  const item = [...document.querySelectorAll(".chat-hist-menu button")].find(b => (b.textContent || "").includes("重命名"));
  if (item) item.click();
  await new Promise(r => setTimeout(r, 200));
  const input = document.getElementById("chat-hist-rename");
  const state = { input: !!input, focused: document.activeElement === input, dialog: !!document.querySelector(".modal") };
  if (!input) return state;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "重命名后的会话标题"); input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { ...state, inputGone: !document.getElementById("chat-hist-rename"), titleShown: [...document.querySelectorAll(".chat-hist-title")].some(t => (t.textContent || "").includes("重命名后的会话标题")) };
})()`);
console.log("rename", JSON.stringify(rename));
await shot("c65-sw-03-rename");

// 6) 置顶
const pin = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const direct = await invoke("chat_session_pin", { id: ${JSON.stringify(seeded.targetId)}, pinned: true })
    .then(m => m.pinnedAt).catch(e => "ERR:" + String(e));
  const row = document.querySelector(".chat-hist-item");
  const btn = row?.querySelector(".chat-hist-more-btn");
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 200));
  const pinItem = [...document.querySelectorAll(".chat-hist-menu button")].find(b => (b.textContent || "").includes("置顶"));
  if (pinItem) pinItem.click();
  await new Promise(r => setTimeout(r, 1200));
  const first = document.querySelector(".chat-hist-item");
  return {
    direct,
    menuOpened: !!pinItem,
    firstPinned: !!first?.querySelector(".chat-hist-pin"),
    firstTitle: first?.querySelector(".chat-hist-title")?.textContent?.slice(0, 30) ?? null,
    iconCount: document.querySelectorAll(".chat-hist-pin").length,
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
  };
})()`);
console.log("pin", JSON.stringify(pin));
await shot("c65-sw-04-pinned");

// 7) 分叉（分叉后会自动切到新会话并收起浮层）
const fork = await evaluate(`(async () => {
  const btn = document.querySelector(".chat-hist-item .chat-hist-more-btn");
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 200));
  const forkItem = [...document.querySelectorAll(".chat-hist-menu button")].find(b => (b.textContent || "").includes("分叉"));
  if (forkItem) forkItem.click();
  await new Promise(r => setTimeout(r, 1000));
  const closed = !document.querySelector(".chat-history");
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (closed && hist) hist.click();
  await new Promise(r => setTimeout(r, 900));
  const firstTitle = document.querySelector(".chat-hist-title")?.textContent ?? null;
  return { closed, firstTitle, count: document.querySelector(".chat-history-count")?.textContent ?? null };
})()`);
console.log("fork", JSON.stringify(fork));
await shot("c65-sw-05-fork");

// 8) 删除（重新打开历史 → 菜单 → 删除）
const del = await evaluate(`(async () => {
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (!document.querySelector(".chat-history") && hist) hist.click();
  await new Promise(r => setTimeout(r, 700));
  const btn = document.querySelector(".chat-hist-item .chat-hist-more-btn");
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 200));
  const delItem = [...document.querySelectorAll(".chat-hist-menu button")].find(b => (b.textContent || "").includes("删除"));
  if (delItem) delItem.click();
  await new Promise(r => setTimeout(r, 300));
  const modal = document.querySelector(".modal");
  return { modal: !!modal, text: modal?.innerText?.slice(0, 100) ?? null };
})()`);
console.log("delete", JSON.stringify(del));
await shot("c65-sw-06-delete");

// 9) 390 窄屏
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await wait(400);
const narrow = await evaluate(`(async () => {
  const dlg = document.querySelector(".modal");
  if (dlg) { const c = [...dlg.querySelectorAll("button")].find(b => (b.textContent || "").includes("取消")); c?.click(); }
  await new Promise(r => setTimeout(r, 300));
  let hist = document.querySelector("[data-chat-overlay-trigger='history']");
  const panel = document.querySelector(".chat-panel");
  if (!panel || panel.hasAttribute("hidden") || panel.offsetParent === null) {
    const ai = [...document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "AI 侧栏");
    ai?.click();
    await new Promise(r => setTimeout(r, 900));
    hist = document.querySelector("[data-chat-overlay-trigger='history']");
  }
  if (!document.querySelector(".chat-history") && hist) hist.click();
  await new Promise(r => setTimeout(r, 800));
  const h = document.querySelector(".chat-history");
  const r = h?.getBoundingClientRect();
  return { open: !!h, width: r ? Math.round(r.width) : null, viewport: window.innerWidth, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 };
})()`);
console.log("narrow", JSON.stringify(narrow));
await shot("c65-sw-07-narrow");

ws.close();