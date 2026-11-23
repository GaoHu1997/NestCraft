/**
 * CR-067 正式软件验证（隔离设计预览：真实 React 组件 + mock IPC）。
 * 前置：npm run preview（4173）、Chrome headless --remote-debugging-port=9334。
 * 输出：docs/Test/screenshots/cr067-software/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr067-software";
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
  await wait(220);
  try {
    const r = await Promise.race([
      send("Page.captureScreenshot", { format: "png" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("截图超时")), 8000)),
    ]);
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("shot", name);
  } catch (error) {
    console.log("shot-failed", name, String(error));
  }
};
const assert = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) process.exitCode = 1;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const errors = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
  }
});

await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(4500);

// 打开编码项目
const opened = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects.find(x => x.kind === "code") || projects[0];
  return { id: p.id, name: p.name };
})()`);
console.log("project", JSON.stringify(opened));
await evaluate(`(() => {
  const cards = [...document.querySelectorAll(".proj-card")];
  const el = cards.find(e => (e.textContent || "").includes(${JSON.stringify(opened.id)})) || cards[0];
  el?.click(); return !!el;
})()`);
await wait(2000);

// 切到编码 → Git 管理
await evaluate(`(() => {
  const tab = [...document.querySelectorAll(".pw-tab")].find(e => /编码/.test(e.textContent || ""));
  tab && tab.click(); return !!tab;
})()`);
await wait(1800);
const railClicked = await evaluate(`(() => {
  const btn = document.querySelector('.rail-btn[aria-label="Git 管理"]');
  btn && btn.click(); return !!btn;
})()`);
await wait(1600);
console.log("rail-clicked", railClicked);
await shot("c67s-01-panel");

const base = await evaluate(`(() => {
  const panel = document.querySelector(".gita");
  if (!panel) return { error: "no .gita panel" };
  const card = document.querySelector(".gita-card.changes");
  const cs = card ? getComputedStyle(card) : null;
  const pr = panel.getBoundingClientRect();
  return {
    panelW: Math.round(pr.width), panelH: Math.round(pr.height),
    topBtns: [...document.querySelectorAll(".gita-top-btn")].map(b => (b.textContent || "").trim()),
    cards: [...document.querySelectorAll(".gita-card")].map(c => ({
      cls: c.className.replace(/gita-card ?/, ""),
      title: (c.querySelector(".gita-title") || {}).textContent,
      h: Math.round(c.getBoundingClientRect().height),
    })),
    border: cs ? cs.borderTopWidth + " " + cs.borderStyle + " " + cs.borderRadius : null,
    rows: [...document.querySelectorAll(".gita-row")].map(r => ({
      st: (r.querySelector(".gita-st") || {}).textContent,
      path: (r.querySelector(".gita-path") || {}).textContent,
      hint: (r.querySelector(".gita-hint") || {}).textContent,
    })),
    groups: [...document.querySelectorAll(".gita-group-h")].map(g => (g.textContent || "").replace(/\\s+/g, " ").trim()),
    treeHeads: [...document.querySelectorAll(".gita-tree-h")].map(h => (h.textContent || "").replace(/\\s+/g, " ").trim()),
    currentBranch: (document.querySelector(".gita-branch.current .gita-branch-name") || {}).textContent,
    commits: document.querySelectorAll(".gita-commit-row").length,
    graphs: document.querySelectorAll(".gita-graph svg").length,
    dots: document.querySelectorAll(".gita-dot").length,
    refs: [...document.querySelectorAll(".gita-ref")].map(r => r.textContent),
    dates: [...document.querySelectorAll(".gita-commit-date")].map(d => d.textContent),
    filters: {
      author: !!document.querySelector('input[aria-label="提交人"]'),
      branch: !!document.querySelector('select[aria-label="所有分支"]'),
      range: !!document.querySelector('select[aria-label="时间范围"]'),
    },
    commitBtn: (() => { const b = [...document.querySelectorAll(".gita-split .gita-act")].find(x => (x.textContent || "").trim() === "提交"); return b ? { disabled: b.disabled } : null; })(),
    caret: !!document.querySelector('.gita-split .caret'),
    hint: (document.querySelector(".gita-commit-hint") || {}).textContent,
    repoPill: (document.querySelector(".gita-repo") || {}).textContent,
  };
})()`);
console.log("base", JSON.stringify(base, null, 1));

assert("软件面板存在", !base.error, base.error);
assert("顶栏含国内加速/密钥配置", (base.topBtns || []).some(t => t.includes("国内加速")) && (base.topBtns || []).some(t => t.includes("密钥配置")), base.topBtns);
assert("三张卡片顺序与标题", JSON.stringify((base.cards || []).map(c => c.title)) === JSON.stringify(["未提交变更", "分支", "提交历史"]), (base.cards || []).map(c => c.title));
assert("卡片 2:1:2 高度", (base.cards || []).length === 3 && base.cards[0].h >= base.cards[1].h && base.cards[2].h >= base.cards[1].h, (base.cards || []).map(c => c.h));
assert("变更行含状态/路径/git add", (base.rows || []).length > 0 && (base.rows || []).every(r => r.st && r.path && /^git /.test(r.hint || "")), (base.rows || []).slice(0, 3));
assert("分组含全部暂存/全部取消暂存", (base.groups || []).some(g => /全部暂存|全部取消暂存/.test(g)), base.groups);
assert("分支树本地/远程", (base.treeHeads || []).some(t => /本地/.test(t)) && (base.treeHeads || []).some(t => /远程/.test(t)), base.treeHeads);
assert("当前分支高亮", !!base.currentBranch, base.currentBranch);
assert("提交历史含图谱与点", base.graphs > 0 && base.dots > 0 && base.commits > 0, { commits: base.commits, graphs: base.graphs, dots: base.dots });
assert("refs 徽章存在", (base.refs || []).length > 0, base.refs);
assert("绝对时间列", (base.dates || []).every(d => /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(d)), base.dates);
assert("三个筛选控件", base.filters.author && base.filters.branch && base.filters.range, base.filters);
assert("提交拆分按钮与门禁", !!base.caret && base.commitBtn && base.commitBtn.disabled === true, { commitBtn: base.commitBtn, caret: base.caret, hint: base.hint });

// 先全部暂存（未暂存时提交本就应禁用），再验证门禁随「已暂存 + 已填信息」放行
const staged = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".gita-link")].find(b => (b.textContent || "").trim() === "全部暂存");
  btn && btn.click();
  await new Promise(r => setTimeout(r, 1200));
  return {
    checked: document.querySelectorAll(".gita-row-check:checked").length,
    unstagedAll: [...document.querySelectorAll(".gita-link")].some(b => (b.textContent || "").trim() === "全部取消暂存"),
    hint: (document.querySelector(".gita-commit-hint") || {}).textContent,
  };
})()`);
console.log("stage-all", JSON.stringify(staged));
assert("全部暂存生效", staged.checked > 0, staged);
await shot("c67s-04-staged-all");

// 填写提交信息 → 按钮启用
const afterType = await evaluate(`(() => {
  const ta = document.querySelector(".gita-commit-input");
  if (!ta) return { error: "no textarea" };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "feat(booking): 幂等键与响应快照");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return { value: ta.value };
})()`);
await wait(600);
const commitReady = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".gita-split .gita-act")].find(x => (x.textContent || "").trim() === "提交");
  return { disabled: b ? b.disabled : null, hint: (document.querySelector(".gita-commit-hint") || {}).textContent };
})()`);
console.log("commit-ready", JSON.stringify({ ...afterType, ...commitReady }));
assert("填写后提交可用", commitReady.disabled === false, commitReady);
await shot("c67s-02-commit-ready");

// 提交下拉菜单（点击后等 React 提交渲染再读取）
const menu = await evaluate(`(async () => {
  const caret = document.querySelector(".gita-split .caret");
  caret && caret.click();
  await new Promise(r => setTimeout(r, 400));
  return [...document.querySelectorAll(".gita-menu-item")].map(b => (b.textContent || "").trim());
})()`);
console.log("commit-menu", JSON.stringify(menu));
assert("提交菜单两项", JSON.stringify(menu) === JSON.stringify(["提交", "提交并推送"]), menu);
await shot("c67s-03-commit-menu");
await evaluate(`(async () => { document.querySelector(".gita-split .caret")?.click(); await new Promise(r => setTimeout(r, 300)); return true; })()`);

// 分支折叠/展开
const branchTree = await evaluate(`(() => {
  const click = label => {
    const b = [...document.querySelectorAll(".gita-link")].find(x => (x.textContent || "").trim() === label);
    b && b.click();
    return !!b;
  };
  click("全部折叠");
  return true;
})()`);
await wait(500);
const collapsed = await evaluate(`(() => ({
  kids: document.querySelectorAll(".gita-tree-kids").length,
}))()`);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".gita-link")].find(x => (x.textContent || "").trim() === "全部展开");
  b && b.click(); return true;
})()`);
await wait(500);
const expanded = await evaluate(`(() => ({
  branches: document.querySelectorAll(".gita-branch").length,
  remoteGroups: document.querySelectorAll(".gita-tree-h.nest").length,
}))()`);
console.log("branch-tree", JSON.stringify({ collapsed, expanded }));
assert("全部折叠收起树", collapsed.kids === 0, collapsed);
assert("全部展开显示分支", expanded.branches > 0, expanded);
await shot("c67s-05-branches-expanded");

// 提交历史筛选（提交人）
const filtered = await evaluate(`(async () => {
  const input = document.querySelector('input[aria-label="提交人"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "林澈");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1000));
  return [...document.querySelectorAll(".gita-commit-meta .author")].map(a => a.textContent);
})()`);
console.log("author-filter", JSON.stringify(filtered));
assert("提交人筛选后只剩该作者", filtered.length > 0 && filtered.every(a => a.includes("林澈")), filtered);
await shot("c67s-06-author-filter");

// 清空筛选 + 展开提交
await evaluate(`(async () => {
  const input = document.querySelector('input[aria-label="提交人"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return true;
})()`);
const expandedCommit = await evaluate(`(async () => {
  const row = document.querySelector(".gita-commit-row");
  row && row.click();
  await new Promise(r => setTimeout(r, 900));
  return {
    files: [...document.querySelectorAll(".gita-file-path")].map(p => p.textContent),
    nums: [...document.querySelectorAll(".gita-file-nums")].map(p => p.textContent),
  };
})()`);
console.log("commit-expand", JSON.stringify(expandedCommit));
assert("提交展开显示文件", (expandedCommit.files || []).length > 0, expandedCommit);
await shot("c67s-07-commit-expanded");

// 国内加速弹层
const accel = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".gita-top-btn")].find(b => (b.textContent || "").includes("国内加速"));
  btn && btn.click();
  await new Promise(r => setTimeout(r, 500));
  const pop = document.querySelector('.gita-pop[aria-label="国内加速"]');
  return {
    open: !!pop,
    url: (document.getElementById("gita-accel-url") || {}).value,
    switchOn: (pop?.querySelector('[role="switch"]') || {}).getAttribute?.("aria-checked"),
  };
})()`);
console.log("accel", JSON.stringify(accel));
assert("国内加速弹层打开", accel.open, accel);
await shot("c67s-08-accel");

// 启用加速并保存
const accelSaved = await evaluate(`(async () => {
  const sw = document.querySelector('.gita-pop [role="switch"]');
  sw && sw.click();
  await new Promise(r => setTimeout(r, 250));
  const save = [...document.querySelectorAll(".gita-pop .gita-act")].find(b => (b.textContent || "").trim() === "保存");
  save && save.click();
  await new Promise(r => setTimeout(r, 700));
  return {
    dot: !!document.querySelector(".gita-accel-dot"),
    popOpen: !!document.querySelector('.gita-pop[aria-label="国内加速"]'),
    enabled: await window.__TAURI_INTERNALS__.invoke("git_accel_get"),
  };
})()`);
console.log("accel-saved", JSON.stringify(accelSaved));
assert("保存后启用并显示绿点", accelSaved.dot === true && accelSaved.enabled?.enabled === true, accelSaved);

// 密钥配置弹层
const cred = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".gita-top-btn")].find(b => (b.textContent || "").includes("密钥配置"));
  btn && btn.click();
  await new Promise(r => setTimeout(r, 600));
  const pop = document.querySelector('.gita-pop[aria-label="密钥配置"]');
  return {
    open: !!pop,
    tokenType: (document.getElementById("gita-cred-token") || {}).type,
    empty: !!pop?.querySelector(".gita-empty"),
  };
})()`);
console.log("cred", JSON.stringify(cred));
assert("密钥弹层打开且令牌为密码框", cred.open && cred.tokenType === "password", cred);
await shot("c67s-09-cred");

// 保存令牌 → 只显示掩码
const credSaved = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const token = document.getElementById("gita-cred-token");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(token, "ghp_preview_only_token");
  token.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const save = [...document.querySelectorAll(".gita-pop .gita-act")].find(b => (b.textContent || "").trim() === "保存");
  save && save.click();
  await new Promise(r => setTimeout(r, 900));
  const pop = document.querySelector('.gita-pop[aria-label="密钥配置"]');
  const list = await invoke("git_credentials_list");
  return {
    rows: [...document.querySelectorAll(".gita-pop .gita-cred-host")].map(h => h.textContent),
    masks: [...document.querySelectorAll(".gita-pop .gita-cred-mask")].map(h => h.textContent),
    list,
    tokenCleared: (document.getElementById("gita-cred-token") || {}).value === "",
    bodyHasToken: (pop?.textContent || "").includes("ghp_preview_only_token"),
  };
})()`);
console.log("cred-saved", JSON.stringify(credSaved));
assert("列表显示主机与掩码", (credSaved.rows || []).length > 0 && (credSaved.masks || []).every(m => m.startsWith("•")), credSaved.rows);
assert("列表接口不返回令牌", !JSON.stringify(credSaved.list).includes("ghp_preview_only_token"), credSaved.list);
assert("保存后输入框清空且界面不含令牌", credSaved.tokenCleared && credSaved.bodyHasToken === false, { tokenCleared: credSaved.tokenCleared, bodyHasToken: credSaved.bodyHasToken });
await shot("c67s-10-cred-saved");

// 管理远程
await evaluate(`(async () => {
  const close = [...document.querySelectorAll(".gita-pop .gita-act")].find(b => (b.textContent || "").trim() === "取消");
  close && close.click();
  await new Promise(r => setTimeout(r, 300));
  return true;
})()`);
const remotes = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll(".gita-link")].find(b => (b.textContent || "").trim() === "管理远程");
  btn && btn.click();
  await new Promise(r => setTimeout(r, 700));
  const dlg = document.querySelector("dialog[open]");
  return {
    open: !!dlg,
    title: (dlg?.querySelector("h2") || {}).textContent,
    fields: [...(dlg?.querySelectorAll("input") || [])].map(i => i.id),
    listed: [...(dlg?.querySelectorAll(".gita-cred-host") || [])].map(x => x.textContent),
  };
})()`);
console.log("remotes", JSON.stringify(remotes));
assert("管理远程弹框", remotes.open && remotes.fields.includes("gita-remote-name"), remotes);
await shot("c67s-11-remotes");
await evaluate(`(() => { const b = [...document.querySelectorAll("dialog[open] .btn")].find(x => (x.textContent || "").includes("关闭")); b && b.click(); return true; })()`);
await wait(500);

// 滚动条（UI-SCROLL-001）：挑一个真正内容超高的滚动容器
const scroll = await evaluate(`(async () => {
  const candidates = [...document.querySelectorAll(".gita-scroll, .gita-changes, .gita-body.scroll")];
  const el = candidates.find(e => e.scrollHeight > e.clientHeight + 4);
  if (!el) return { error: "no overflowing scroll region", sizes: candidates.map(e => [e.className, e.scrollHeight, e.clientHeight]) };
  const before = el.className.includes("scrollbar-active");
  el.scrollTop = Math.max(1, el.scrollHeight - el.clientHeight);
  el.dispatchEvent(new Event("scroll", { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const during = el.className.includes("scrollbar-active");
  await new Promise(r => setTimeout(r, 900));
  const after = el.className.includes("scrollbar-active");
  return { cls: el.className, sh: el.scrollHeight, ch: el.clientHeight, before, during, after };
})()`);
console.log("scrollbar", JSON.stringify(scroll));
assert("滚动条按需显示", scroll.before === false && scroll.during === true && scroll.after === false, scroll);

// 深色主题
const dark = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  await invoke("set_theme", { theme: "dark" }).catch(() => null);
  document.documentElement.dataset.theme = "dark";
  await new Promise(r => setTimeout(r, 500));
  const card = document.querySelector(".gita-card");
  return { theme: document.documentElement.dataset.theme, cardBg: card ? getComputedStyle(card).backgroundColor : null };
})()`);
console.log("dark", JSON.stringify(dark));
await wait(400);
await shot("c67s-12-dark");
await evaluate(`(() => { document.documentElement.dataset.theme = "light"; return true; })()`);
await wait(400);

// 窄侧栏
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
await wait(700);
const narrow = await evaluate(`(() => {
  const panel = document.querySelector(".gita");
  const row = document.querySelector(".gita-row");
  return {
    w: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    rows: row ? getComputedStyle(row).gridTemplateColumns : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);
console.log("narrow", JSON.stringify(narrow));
assert("窄侧栏无横向溢出", narrow.overflowX === false, narrow);
await shot("c67s-13-narrow");

console.log("errors", JSON.stringify(errors));
assert("无 JS 异常", errors.length === 0, errors);
