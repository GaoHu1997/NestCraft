/**
 * CR-067 设计稿截图与断言（workbench-v4）。
 * 前置：bash scripts/run-chrome-check.sh 已启动 headless Chrome（端口 9333）
 * 运行：bash scripts/run-chrome-check.sh scripts/shot-cr067-design.mjs
 * 输出：docs/Test/screenshots/cr067-design/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr067-design";
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
  await wait(200);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const url = "file:///D:/github/AI_Delelovelop/docs/UI/workbench-v4/index.html";
await send("Page.navigate", { url });
await wait(2000);

const errors = [];
await send("Log.enable").catch(() => {});
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
});

// 打开编码项目的编码页并切到 Git 管理（真实点击左侧 Git 按钮，避免被 code-reading 会话状态覆盖）
const prep = await evaluate(`(() => {
  const UI = window.UI;
  const p = UI.D.projects.find(x => x.kind === "code" && x.id === "PRJ-1042") || UI.D.projects.find(x => x.kind === "code");
  UI.openWindow("project", p.id, p.name);
  UI.store.projectTab = "code";
  UI.render();
  const btn = document.querySelector('[data-act=code-rail][data-rail=git]');
  if (btn) btn.click();
  return { project: p.id, rail: UI.store.codeRail, clicked: Boolean(btn) };
})()`);
console.log("prep", JSON.stringify(prep));
await wait(400);
await shot("c67-01-git-panel");

const base = await evaluate(`(() => {
  const panel = document.querySelector(".gitp2");
  if (!panel) return { error: "no .gitp2" };
  const card = document.querySelector(".gitp2-card.changes");
  const cs = card ? getComputedStyle(card) : null;
  const top = document.querySelector(".gitp2-top");
  const topBtns = [...document.querySelectorAll(".gitp2-top-btn")].map(b => (b.textContent || "").trim());
  const cards = [...document.querySelectorAll(".gitp2-card")].map(c => ({
    cls: c.className,
    title: (c.querySelector(".gitp2-title") || {}).textContent,
    h: Math.round(c.getBoundingClientRect().height),
  }));
  const rows = [...document.querySelectorAll(".gitp2-row")].map(r => ({
    st: (r.querySelector(".gitp2-st") || {}).textContent,
    path: (r.querySelector(".gitp2-path") || {}).textContent,
    hint: (r.querySelector(".gitp2-hint") || {}).textContent,
  }));
  return {
    repo: (document.querySelector(".gitp2-repo") || {}).textContent,
    topBtns,
    accelDot: !!document.querySelector(".gitp2-dot"),
    cards,
    cardBorder: cs ? cs.borderTopWidth + " " + cs.borderStyle : null,
    cardRadius: cs ? cs.borderRadius : null,
    rows,
    groupHeads: [...document.querySelectorAll(".gitp2-group-h")].map(g => (g.textContent || "").replace(/\\s+/g, " ").trim()),
    branchHeads: [...document.querySelectorAll(".gitp2-tree-h")].map(h => (h.textContent || "").replace(/\\s+/g, " ").trim()),
    currentBranch: (document.querySelector(".gitp2-branch.current .gitp2-branch-name") || {}).textContent,
    commitCount: document.querySelectorAll(".gitp2-commit-row").length,
    graphDots: document.querySelectorAll(".gitp2-dot").length,
    graphSvgs: document.querySelectorAll(".gitp2-graph svg").length,
    refLabels: [...document.querySelectorAll(".gitp2-ref")].map(r => r.textContent),
    dates: [...document.querySelectorAll(".gitp2-commit-date")].map(d => d.textContent),
    filters: {
      author: !!document.getElementById("git-history-author"),
      branch: !!document.getElementById("git-history-branch"),
      range: !!document.getElementById("git-history-range"),
    },
    branchSearch: !!document.getElementById("git-branch-q"),
    commitBtn: (() => { const b = document.querySelector('[data-act=git-commit]'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
    splitCaret: !!document.querySelector('[data-act=git-commit-menu]'),
    commitHint: (document.querySelector(".gitp2-commit-hint") || {}).textContent,
  };
})()`);
console.log("base", JSON.stringify(base, null, 1));

// 1) 滚动条按需显示（CR-049 / UI-SCREOLL-001）：初始隐藏 → 滚动出现 → 停止隐藏
const scrollCheck = await evaluate(`(async () => {
  const el = document.querySelector(".gitp2-changes");
  const active0 = el ? el.classList.contains("scrollbar-active") : null;
  if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll", { bubbles: true })); }
  await new Promise(r => setTimeout(r, 60));
  const active1 = el ? el.classList.contains("scrollbar-active") : null;
  await new Promise(r => setTimeout(r, 900));
  const active2 = el ? el.classList.contains("scrollbar-active") : null;
  return { before: active0, during: active1, after: active2 };
})()`);
console.log("scrollbar", JSON.stringify(scrollCheck));

// 2) 填写提交信息 → 提交按钮可用
const commitState = await evaluate(`(() => {
  const ta = document.getElementById("git-message");
  ta.value = "feat(booking): 幂等键与响应快照";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await wait(250);
const afterType = await evaluate(`(() => {
  const b = document.querySelector('[data-act=git-commit]');
  return { disabled: b.disabled, hint: (document.querySelector(".gitp2-commit-hint") || {}).textContent, caret: !!document.querySelector('[data-act=git-commit-menu]') };
})()`);
console.log("commit-after-type", JSON.stringify(afterType));
await shot("c67-02-commit-ready");

// 3) 提交下拉菜单
const menuState = await evaluate(`(() => {
  const caret = document.querySelector('[data-act=git-commit-menu]');
  if (caret) caret.click();
  return [...document.querySelectorAll(".gitp2-menu-item")].map(b => (b.textContent || "").trim());
})()`);
console.log("commit-menu", JSON.stringify(menuState));
await shot("c67-03-commit-menu");
await evaluate(`(() => { UI.store.gitCommitMenuOpen = false; UI.render(); return true; })()`);

// 4) 全部暂存 / 全部取消暂存
const stageAll = await evaluate(`(() => {
  const btn = document.querySelector('[data-act=git-stage-all]');
  if (btn) btn.click();
  return {
    unstaged: document.querySelectorAll('[data-act=git-unstage-all]').length,
    checked: document.querySelectorAll(".gitp2-row-check:checked").length,
  };
})()`);
console.log("stage-all", JSON.stringify(stageAll));
await evaluate(`(() => { const b = document.querySelector('[data-act=git-unstage-all]'); if (b) b.click(); return true; })()`);

// 5) 分支树展开／折叠
const branchTree = await evaluate(`(() => {
  document.querySelector('[data-act=git-branch-collapse]').click();
  return {
    localOpen: UI.store.gitOpenGroups.local,
    remoteOpen: UI.store.gitOpenGroups.remote,
  };
})()`);
console.log("collapse", JSON.stringify(branchTree));
await wait(200);
await shot("c67-04-branches-collapsed");
await evaluate(`(() => { document.querySelector('[data-act=git-branch-expand]').click(); return true; })()`);
await wait(200);
const expanded = await evaluate(`(() => ({
  locals: document.querySelectorAll(".gitp2-tree-kids .gitp2-branch").length,
  remoteGroups: document.querySelectorAll(".gitp2-tree-h.nest").length,
}))()`);
console.log("expanded", JSON.stringify(expanded));
await wait(200);
await shot("c67-05-branches-expanded");

// 6) 分支搜索过滤
const branchFilter = await evaluate(`(() => {
  const q = document.getElementById("git-branch-q");
  q.value = "capacity";
  q.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await wait(250);
const filtered = await evaluate(`(() => ({
  rows: [...document.querySelectorAll(".gitp2-branch .gitp2-branch-name")].map(n => n.textContent),
  empty: !!document.querySelector(".gitp2-empty"),
}))()`);
console.log("branch-filter", JSON.stringify(filtered));
await shot("c67-06-branch-search");

// 7) 历史筛选 + 提交展开
await evaluate(`(() => {
  const q = document.getElementById("git-branch-q");
  q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true }));
  const a = document.getElementById("git-history-author");
  a.value = "周野"; a.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await wait(250);
const authorFilter = await evaluate(`(() => [...document.querySelectorAll(".gitp2-commit-meta .author")].map(x => x.textContent))()`);
console.log("author-filter", JSON.stringify(authorFilter));
await shot("c67-07-history-author-filter");

await evaluate(`(() => {
  const a = document.getElementById("git-history-author");
  a.value = ""; a.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await wait(250);
const expandCommit = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".gitp2-commit-row")];
  const withFiles = rows.find(r => r.dataset.sha === "a1f7c2d") || rows[0];
  withFiles.click();
  return { sha: withFiles.dataset.sha };
})()`);
await wait(250);
const filesShown = await evaluate(`(() => ({
  files: [...document.querySelectorAll(".gitp2-file-path")].map(p => p.textContent),
  nums: [...document.querySelectorAll(".gitp2-file-nums")].map(p => p.textContent),
}))()`);
console.log("commit-expand", JSON.stringify({ ...expandCommit, ...filesShown }));
await shot("c67-08-commit-expanded");

// 8) 国内加速弹层
const accel = await evaluate(`(() => {
  document.querySelector('[data-act=git-accel]').click();
  const pop = document.querySelector(".gitp2-pop");
  return {
    open: !!pop,
    label: pop ? (pop.querySelector("b") || {}).textContent : null,
    switchOn: pop ? (pop.querySelector(".switch") || {}).getAttribute?.("aria-checked") : null,
    url: (document.getElementById("git-accel-url") || {}).value,
  };
})()`);
console.log("accel", JSON.stringify(accel));
await shot("c67-09-accel-popover");

// 9) 密钥配置弹层
const cred = await evaluate(`(() => {
  UI.store.gitAccelOpen = false; UI.render();
  document.querySelector('[data-act=git-cred]').click();
  const pop = document.querySelector(".gitp2-pop");
  return {
    open: !!pop,
    hosts: [...document.querySelectorAll(".gitp2-pop .gitp2-branch-name")].map(h => h.textContent),
    masks: [...document.querySelectorAll(".gitp2-pop .gitp2-branch-track")].map(h => h.textContent),
    tokenType: (document.getElementById("git-cred-token") || {}).type,
  };
})()`);
console.log("cred", JSON.stringify(cred));
await shot("c67-10-cred-popover");

// 10) 管理远程弹框
await evaluate(`(() => { UI.store.gitCredOpen = false; UI.render(); return true; })()`);
const remotes = await evaluate(`(() => {
  document.querySelector('[data-act=git-remotes]').click();
  const dlg = document.getElementById("dialog");
  return {
    open: dlg.open,
    title: (dlg.querySelector("h2") || {}).textContent,
    fields: [...dlg.querySelectorAll("input")].map(i => i.id),
    listed: [...dlg.querySelectorAll(".gitp2-branch-name")].map(x => x.textContent),
  };
})()`);
console.log("remotes", JSON.stringify(remotes));
await shot("c67-11-remotes-modal");
await evaluate(`(() => { UI.closeTopDialog(); return true; })()`);

// 11) 深色主题（data-theme 只在模块初始化时写入，切换需显式设置属性）
const dark = await evaluate(`(() => {
  document.documentElement.setAttribute("data-theme", "dark");
  UI.store.theme = "dark"; UI.render();
  const card = document.querySelector(".gitp2-card");
  const cs = card ? getComputedStyle(card) : null;
  return { theme: document.documentElement.dataset.theme, cardBg: cs ? cs.backgroundColor : null,
    panelBg: getComputedStyle(document.querySelector(".gitp2")).backgroundColor,
    titleColor: getComputedStyle(document.querySelector(".gitp2-title")).color };
})()`);
console.log("dark", JSON.stringify(dark));
await wait(300);
await shot("c67-12-dark");
await evaluate(`(() => { document.documentElement.setAttribute("data-theme", "light"); UI.store.theme = "light"; UI.render(); return true; })()`);

// 12) 窄侧栏（260px 默认栏宽下的面板）
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
await wait(400);
const narrow = await evaluate(`(() => {
  const panel = document.querySelector(".gitp2");
  const cs = panel ? getComputedStyle(panel) : null;
  const row = document.querySelector(".gitp2-row");
  const rcs = row ? getComputedStyle(row) : null;
  return {
    width: cs ? Math.round(panel.getBoundingClientRect().width) : null,
    rowCols: rcs ? rcs.gridTemplateColumns : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);
console.log("narrow", JSON.stringify(narrow));
await shot("c67-13-narrow");

// 13) 空工作区（全部勾选后取消）——校验空态
const emptyState = await evaluate(`(() => {
  UI.D.git.changes = [];
  UI.render();
  const empty = document.querySelector(".gitp2-empty");
  const commitBtn = document.querySelector('[data-act=git-commit]');
  return {
    emptyText: empty ? empty.textContent : null,
    commitDisabled: commitBtn ? commitBtn.disabled : null,
    hint: (document.querySelector(".gitp2-commit-hint") || {}).textContent,
    aiDisabled: (() => { const b = document.querySelector('[data-act=git-gen]'); return b ? b.disabled : null; })(),
  };
})()`);
console.log("empty", JSON.stringify(emptyState));
await shot("c67-14-clean");

console.log("errors", JSON.stringify(errors));
