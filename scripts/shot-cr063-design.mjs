/**
 * CR-063 设计稿截图（workbench-v4，唯一当前原型）。
 * 前置：chrome --headless=new --remote-debugging-port=9333 打开 workbench-v4/index.html
 * 运行：node scripts/shot-cr063-design.mjs
 * 输出：docs/Test/screenshots/cr063-design/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr063-design";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page" && p.url.includes("workbench-v4"))
  ?? list.find(p => p.type === "page");
if (!page) throw new Error("未找到设计稿页面目标");

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

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async (name) => {
  await wait(180);
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
// 重新加载，确保本次改动的 CSS/JS 生效（file:// 下缓存不会自动失效）
await send("Page.navigate", { url: page.url });
await wait(1500);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await wait(200);

// 打开预约服务项目并展开 AI 侧栏 + 历史浮层
await evaluate(`(() => {
  const UI = window.UI;
  const p = UI.D.projects.find(x => /预约/.test(x.name)) || UI.D.projects[0];
  UI.openWindow("project", p.id, p.name);
  UI.store.aiOpen = true;
  UI.store.aiHistory = true;
  UI.store.aiHistLimit = 20;
  UI.store.aiHistQuery = "";
  UI.store.aiSession = UI.D.ai.sessions[0].id;
  UI.render();
  return { project: p.name, total: UI.D.ai.sessions.length, current: UI.store.aiSession };
})()`);

const base = await evaluate(`(() => {
  const l = document.querySelector(".ai-history-list");
  return { rows: document.querySelectorAll(".ai-history .ai-session").length, caption: document.querySelector(".ai-history-h .caption")?.textContent, more: !!document.querySelector(".ai-hist-more"), end: !!document.querySelector(".ai-hist-end"), pinned: !!document.querySelector(".ai-hist-pinned"), scrollable: l ? l.scrollHeight > l.clientHeight : false };
})()`);
console.log("base", JSON.stringify(base));
await shot("c63-01-batch-20");

// 继续加载：模拟滚到底并点击按钮
await evaluate(`(() => {
  const l = document.querySelector(".ai-history-list"); if (l) l.scrollTop = l.scrollHeight;
  document.querySelector(".ai-hist-more")?.click();
  return true;
})()`);
const more1 = await evaluate(`(() => ({ rows: document.querySelectorAll(".ai-history .ai-session").length, caption: document.querySelector(".ai-history-h .caption")?.textContent }))()`);
console.log("after more", JSON.stringify(more1));
await shot("c63-02-load-more-40");

// 搜索命中未加载会话（关键词只出现在归档深部）
await evaluate(`(() => {
  UI.store.aiHistQuery = "退出码";
  UI.store.aiHistLimit = 20;
  UI.store.aiHistFocus = false;
  UI.render();
  return true;
})()`);
const search = await evaluate(`(() => ({
  rows: document.querySelectorAll(".ai-history .ai-session").length,
  caption: document.querySelector(".ai-history-h .caption")?.textContent,
  titles: Array.from(document.querySelectorAll(".ai-history .ai-session b")).map(x => x.textContent),
  idx: Array.from(document.querySelectorAll(".ai-history .ai-session")).map(el => UI.D.ai.sessions.findIndex(s => s.id === el.dataset.id))
}))()`);
console.log("search", JSON.stringify(search));
await shot("c63-03-search-hit");

// 搜索无匹配
await evaluate(`(() => { UI.store.aiHistQuery = "不存在的会话关键词xyz"; UI.render(); return true; })()`);
const noMatch = await evaluate(`(() => ({ empty: document.querySelector(".ai-hist-empty")?.textContent?.trim(), rows: document.querySelectorAll(".ai-history .ai-session").length }))()`);
console.log("no-match", JSON.stringify(noMatch));
await shot("c63-04-search-empty");

// 全部：清空关键词
await evaluate(`(() => { UI.store.aiHistQuery = ""; UI.store.aiHistLimit = 20; UI.render(); return true; })()`);

// 当前会话钉住：把当前会话切到归档尾部，再重置为首批
await evaluate(`(() => {
  const list = UI.D.ai.sessions;
  UI.store.aiSession = list[list.length - 1].id;
  UI.store.aiHistLimit = 20;
  UI.store.aiHistQuery = "";
  UI.render();
  return UI.store.aiSession;
})()`);
const pinned = await evaluate(`(() => ({ pinned: !!document.querySelector(".ai-hist-pinned"), tag: document.querySelector(".ai-hist-pinned .ahp-tag")?.textContent, rows: document.querySelectorAll(".ai-history .ai-session").length }))()`);
console.log("pinned", JSON.stringify(pinned));
await shot("c63-05-pinned-current");

// 已到全部（limit 等于总数）
await evaluate(`(() => {
  UI.store.aiSession = UI.D.ai.sessions[0].id;
  UI.store.aiHistLimit = UI.D.ai.sessions.length;
  UI.store.aiHistQuery = "";
  UI.render();
  return true;
})()`);
const all = await evaluate(`(() => ({ end: !!document.querySelector(".ai-hist-end"), more: !!document.querySelector(".ai-hist-more"), caption: document.querySelector(".ai-history-h .caption")?.textContent }))()`);
console.log("all", JSON.stringify(all));
await shot("c63-06-all-loaded");

// 继续加载文字按钮：滚到列表末尾
await evaluate(`(() => {
  UI.store.aiHistLimit = 20; UI.store.aiHistQuery = ""; UI.store.aiHistState = "idle"; UI.render();
  const l = document.querySelector(".ai-history-list"); if (l) l.scrollTop = l.scrollHeight;
  return { more: !!document.querySelector(".ai-hist-more"), text: document.querySelector(".ai-hist-more")?.textContent?.trim(), bordered: (() => { const m = document.querySelector(".ai-hist-more"); return m ? getComputedStyle(m).borderStyle : null; })() };
})()`).then(v => console.log("more-button", JSON.stringify(v)));
await shot("c63-11-more-button");

// 首批加载中
await evaluate(`(() => { UI.store.aiHistState = "first"; UI.render(); return true; })()`);
await shot("c63-12-loading-first");

// 追加加载中（按钮禁用/文字）
await evaluate(`(() => {
  UI.store.aiHistState = "more"; UI.render();
  const l = document.querySelector(".ai-history-list"); if (l) l.scrollTop = l.scrollHeight;
  return { text: document.querySelector(".ai-hist-more")?.textContent?.trim(), disabled: document.querySelector(".ai-hist-more")?.getAttribute("aria-disabled") };
})()`).then(v => console.log("loading-more", JSON.stringify(v)));
await shot("c63-13-loading-more");

// 加载失败 + 重试
await evaluate(`(() => { UI.store.aiHistState = "error"; UI.render(); return { error: !!document.querySelector(".ai-hist-error"), retry: !!document.querySelector("[data-act=ai-history-retry]") }; })()`).then(v => console.log("error", JSON.stringify(v)));
await shot("c63-14-load-error");

// 首批失败（0 行）：错误块与空态互斥，不得同时出现
const firstFail = await evaluate(`(() => {
  UI.store.aiHistQuery = "不存在的会话关键词xyz"; UI.store.aiHistState = "error"; UI.render();
  return { error: !!document.querySelector(".ai-hist-error"), empty: !!document.querySelector(".ai-hist-empty"), rows: document.querySelectorAll(".ai-history .ai-session").length };
})()`);
console.log("first-fail", JSON.stringify(firstFail));
await evaluate(`(() => { UI.store.aiHistQuery = ""; UI.store.aiHistState = "idle"; UI.render(); return true; })()`);

// 搜索中
await evaluate(`(() => { UI.store.aiHistQuery = "会话"; UI.store.aiHistState = "search"; UI.render(); return true; })()`);
await shot("c63-15-search-loading");

// 删除确认（行内删除入口 + 确认弹窗）
await evaluate(`(() => {
  UI.store.aiHistQuery = ""; UI.store.aiHistState = "idle"; UI.render();
  const del = document.querySelector(".ai-history .ai-hist-del");
  if (del) del.click();
  return { dialog: !!document.querySelector("dialog[open]"), hasDel: !!del };
})()`).then(v => console.log("delete", JSON.stringify(v)));
await shot("c63-16-delete-confirm");
await evaluate(`(() => { UI.closeDialog(); UI.render(); return true; })()`);

// 深色 + 搜索态
await evaluate(`(() => {
  document.documentElement.dataset.theme = "dark";
  UI.store.aiHistLimit = 20;
  UI.store.aiHistQuery = "会话";
  UI.render();
  return true;
})()`);
await shot("c63-07-dark-search");

// 窄屏 390
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await wait(350); // 让窄屏 resize 处理先执行（设计稿会在 <960 时收起 AI 侧栏）
// 窄屏下 AI 侧栏被 pane-resize 收起，需点击「AI 侧栏」切换按钮打开
await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button.pane-toggle")].find(b => b.textContent.trim() === "AI 侧栏");
  if (btn) btn.click();
  return !!btn;
})()`);
await wait(120);
await evaluate(`(() => {
  document.documentElement.dataset.theme = "light";
  UI.store.aiOpen = true;
  UI.store.aiHistory = true;
  UI.store.aiHistQuery = "";
  UI.store.aiHistLimit = 20;
  UI.render();
  return true;
})()`);
await wait(150);
const narrow = await evaluate(`(() => {
  if (!UI.store.aiOpen) { UI.store.aiOpen = true; UI.render(); }
  const panel = document.querySelector(".ai-panel");
  const hist = document.querySelector(".ai-history");
  const pr = panel?.getBoundingClientRect();
  const hr = hist?.getBoundingClientRect();
  const pc = panel ? getComputedStyle(panel) : null;
  const hc = hist ? getComputedStyle(hist) : null;
  return {
    open: UI.store.aiOpen, hist: UI.store.aiHistory,
    bodyAi: document.body.classList.contains("ai-open"),
    panels: document.querySelectorAll(".ai-panel").length,
    histEls: document.querySelectorAll(".ai-history").length,
    rows: document.querySelectorAll(".ai-history .ai-session").length,
    panelRect: pr && { x: pr.x, y: pr.y, w: pr.width, h: pr.height, display: pc.display, position: pc.position },
    panelHidden: panel.hidden,
    panelClass: panel.className,
    panelAttrs: panel.getAttributeNames(),
    histRect: hr && { x: hr.x, y: hr.y, w: hr.width, h: hr.height, display: hc.display, position: hc.position, left: hc.left, right: hc.right, width: hc.width, z: hc.zIndex, opacity: hc.opacity }
  };
})()`);
console.log("narrow", JSON.stringify(narrow));
await shot("c63-08-narrow-390");

// 滚动条：静止 vs 滚动中
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const reopened = await evaluate(`(() => {
  const UI = window.UI;
  const p = UI.D.projects.find(x => /预约/.test(x.name)) || UI.D.projects[0];
  UI.openWindow("project", p.id, p.name);
  document.documentElement.dataset.theme = "light";
  UI.store.aiOpen = true; UI.store.aiHistory = true; UI.store.aiHistQuery = ""; UI.store.aiHistLimit = 20;
  UI.render();
  return { aw: UI.activeWindow()?.id ?? null, hist: UI.store.aiHistory, list: !!document.querySelector(".ai-history-list"), rows: document.querySelectorAll(".ai-history .ai-session").length };
})()`);
console.log("reopen", JSON.stringify(reopened));
await wait(800);
const idle = await evaluate(`(() => { const l = document.querySelector(".ai-history-list"); return { active: l?.classList.contains("scrollbar-active") ?? null, scrollTop: l?.scrollTop ?? null }; })()`);
console.log("scroll-idle", JSON.stringify(idle));
await shot("c63-09-scroll-idle");
await evaluate(`(() => { const l = document.querySelector(".ai-history-list"); l.scrollTop = 220; l.dispatchEvent(new Event("scroll")); return true; })()`);
const active = await evaluate(`(() => { const l = document.querySelector(".ai-history-list"); return { active: l?.classList.contains("scrollbar-active") ?? null }; })()`);
console.log("scroll-active", JSON.stringify(active));
await shot("c63-10-scroll-active");
await wait(850);
const afterIdle = await evaluate(`(() => { const l = document.querySelector(".ai-history-list"); return { active: l?.classList.contains("scrollbar-active") ?? null }; })()`);
console.log("scroll-after-idle", JSON.stringify(afterIdle));

const errors = await evaluate(`(() => (window.__designErrors || []).length)`);
console.log("errors", JSON.stringify(errors));
ws.close();