/**
 * CR-063 软件侧行为验证（隔离设计预览：真实 ChatPanel + mock IPC）。
 * 前置：npm run dev（1420），Chrome headless --remote-debugging-port=9334 打开 about:blank。
 * 运行：node scripts/verify-cr063-ui.mjs
 * 输出：docs/Test/screenshots/cr063-software/*.png 与控制台断言
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr063-software";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
const page = list.find(p => p.type === "page");
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
  if (m.method === "Runtime.exceptionThrown") console.log("PAGE-EXC", JSON.stringify(m.params.exceptionDetails).slice(0, 700));
  if (m.method === "Runtime.consoleAPICalled") console.log("PAGE-CONSOLE", m.params.type, JSON.stringify((m.params.args || []).map(a => a.value ?? a.description)).slice(0, 400));
  if (m.method === "Log.entryAdded") console.log("PAGE-LOG", m.params.entry.level, String(m.params.entry.text).slice(0, 400));
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const evaluate = async (expression) => {
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
const sleep = wait;

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(5000);

const diag = await evaluate(`(() => ({
  tauri: typeof window.__TAURI_INTERNALS__,
  preview: window.__DESIGN_PREVIEW__ ?? null,
  rootKids: document.getElementById("root")?.children.length ?? -1,
  html: document.documentElement.outerHTML.slice(0, 600),
  scripts: [...document.scripts].map(s => s.src).slice(0, 6),
}))()`);
console.log("diag", JSON.stringify(diag));

// 1) 造 45 条会话：目标会话最早创建（排最后），其余 44 条依次更新
const seeded = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects[0];
  if (!p) throw new Error("预览无项目");
  const target = await invoke("chat_session_create", { projectId: p.id, title: "补充失败步骤的退出码说明" });
  // mock 的 create 不接收 title，用 update 设标题；随后创建的 44 条 updatedAt 更晚，目标自然排到最后（未加载区间）
  await invoke("chat_session_update", { id: target.id, title: "补充失败步骤的退出码说明" });
  for (let i = 0; i < 44; i++) await invoke("chat_session_create", { projectId: p.id });
  const list = await invoke("chat_sessions", { projectId: p.id });
  return { projectId: p.id, name: p.name, total: list.length, targetId: target.id, targetPos: list.findIndex(s => s.id === target.id) };
})()`);
console.log("seeded", JSON.stringify(seeded));

// 2) 打开项目
const opened = await evaluate(`(() => {
  const name = ${JSON.stringify(seeded.name)};
  const pick = [...document.querySelectorAll(".side-project, [data-act], .proj-card, .project-card, .project-row, [class*=project]")]
    .filter(n => (n.textContent || "").includes(name));
  const el = pick[0];
  if (el) { el.click(); return { ok: true, tag: el.tagName, cls: String(el.className).slice(0, 80), pick: pick.length }; }
  return {
    ok: false,
    sideProject: document.querySelector(".side-project")?.outerHTML?.slice(0, 400) ?? null,
    acts: [...document.querySelectorAll("[data-act]")].map(e => (e.getAttribute("data-act") || "") + "|" + (e.textContent || "").trim().slice(0, 16)).slice(0, 40),
  };
})()`);
console.log("open-project", JSON.stringify(opened));
await wait(1200);
await shot("c63-sw-00-project");

// 3) 打开 AI 侧栏（若默认收起）与历史浮层
const openedAI = await evaluate(`(() => {
  let hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (!hist) {
    const aiBtns = [...document.querySelectorAll("button")].filter(b => /AI|助手|会话/.test((b.getAttribute("aria-label") || "") + b.textContent));
    if (aiBtns[0]) aiBtns[0].click();
  }
  return { hasHist: !!hist, aiButtons: [...document.querySelectorAll("button")].filter(b => /AI|助手/.test((b.getAttribute("aria-label") || "") + b.textContent)).length };
})()`);
console.log("open-ai", JSON.stringify(openedAI));
await wait(600);

const afterOpen = await evaluate(`(() => {
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (hist) hist.click();
  return { clicked: !!hist };
})()`);
console.log("click-history", JSON.stringify(afterOpen));
await wait(900);

const first = await evaluate(`(() => ({
  overlay: !!document.querySelector(".chat-history"),
  count: document.querySelector(".chat-history-count")?.textContent ?? null,
  rows: document.querySelectorAll(".chat-hist-item").length,
  more: document.querySelector(".chat-hist-more")?.textContent ?? null,
  hasSearch: !!document.querySelector("#chat-history-q"),
  body: document.body.innerText.slice(0, 200)
}))()`);
console.log("first", JSON.stringify(first));
await shot("c63-sw-01-first-20");

// 4) 继续加载
if (first.more) {
  const more = await evaluate(`(() => {
    const b = document.querySelector(".chat-hist-more");
    if (b) b.click();
    return true;
  })()`);
  await wait(700);
  const second = await evaluate(`(() => ({ count: document.querySelector(".chat-history-count")?.textContent ?? null, rows: document.querySelectorAll(".chat-hist-item").length }))()`);
  console.log("after-more", JSON.stringify(second), more);
  await shot("c63-sw-02-load-more");
}

// 5) 搜索未加载区间会话
const searched = await evaluate(`(async () => {
  const input = document.querySelector("#chat-history-q");
  if (!input) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "退出码");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return {
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
    titles: [...document.querySelectorAll(".chat-hist-item .chat-hist-title")].map(n => n.textContent),
    total: document.querySelectorAll(".chat-hist-item").length,
  };
})()`);
console.log("search", JSON.stringify(searched));
await shot("c63-sw-03-search-hit");

// 6) 清空搜索 → 回首页
const cleared = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".chat-hist-all")][0];
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 700));
  return { count: document.querySelector(".chat-history-count")?.textContent ?? null, rows: document.querySelectorAll(".chat-hist-item").length };
})()`);
console.log("cleared", JSON.stringify(cleared));

// 7) 钉住：切到最旧会话，关闭后重开
const pinnedSetup = await evaluate(`(async () => {
  const input = document.querySelector("#chat-history-q");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "退出码");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  const row = document.querySelector(".chat-hist-item");
  if (row) row.click();
  await new Promise(r => setTimeout(r, 800));
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (hist) hist.click();
  await new Promise(r => setTimeout(r, 900));
  return {
    pinned: !!document.querySelector(".chat-hist-pinned"),
    tag: document.querySelector(".chat-hist-pin-tag")?.textContent ?? null,
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
    rows: document.querySelectorAll(".chat-hist-item").length,
  };
})()`);
console.log("pinned", JSON.stringify(pinnedSetup));
await shot("c63-sw-04-pinned");

// 8) 失败态：让 chat_sessions_page 抛错后重开浮层
const failure = await evaluate(`(async () => {
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (hist) hist.click(); // 关闭
  await new Promise(r => setTimeout(r, 300));
  const internals = window.__TAURI_INTERNALS__;
  const original = internals.invoke;
  window.__c63_original_invoke = original;
  internals.invoke = (cmd, args, opts) => cmd === "chat_sessions_page" ? Promise.reject(new Error("模拟分页失败")) : original(cmd, args, opts);
  const patched = await internals.invoke("chat_sessions_page", { limit: 1 }).then(() => "resolved").catch(e => "rejected:" + e.message);
  if (hist) hist.click(); // 重开 → 触发失败
  await new Promise(r => setTimeout(r, 1200));
  return {
    patched,
    overlay: !!document.querySelector(".chat-history"),
    error: !!document.querySelector(".chat-hist-error"),
    empty: !!document.querySelector(".chat-hist-empty"),
    rows: document.querySelectorAll(".chat-hist-item").length,
    loading: document.querySelector(".chat-hist-loading")?.textContent ?? null,
  };
})()`);
console.log("failure", JSON.stringify(failure));
await shot("c63-sw-05-error");

// 9) 恢复并重试
const recovered = await evaluate(`(async () => {
  window.__TAURI_INTERNALS__.invoke = window.__c63_original_invoke;
  const retry = [...document.querySelectorAll(".chat-hist-error button")][0];
  if (retry) retry.click();
  await new Promise(r => setTimeout(r, 900));
  return {
    error: !!document.querySelector(".chat-hist-error"),
    rows: document.querySelectorAll(".chat-hist-item").length,
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
  };
})()`);
console.log("recovered", JSON.stringify(recovered));
await shot("c63-sw-06-recovered");

// 10) 搜索无结果
const noMatch = await evaluate(`(async () => {
  const input = document.querySelector("#chat-history-q");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "不存在的会话标题xyz");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return { empty: document.querySelector(".chat-hist-empty")?.textContent?.trim() ?? null, rows: document.querySelectorAll(".chat-hist-item").length };
})()`);
console.log("no-match", JSON.stringify(noMatch));
await shot("c63-sw-07-no-match");

// 11) 删除入口 + 确认弹窗
const del = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".chat-hist-all")][0];
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 700));
  const del = document.querySelector(".chat-hist-del");
  if (del) del.click();
  await new Promise(r => setTimeout(r, 300));
  const modal = document.querySelector(".modal");
  return { modal: !!modal, text: modal?.innerText?.slice(0, 120) ?? null };
})()`);
console.log("delete", JSON.stringify(del));
await shot("c63-sw-08-delete-confirm");

ws.close();