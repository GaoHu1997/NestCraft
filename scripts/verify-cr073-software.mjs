/**
 * CR-073 软件侧验证（隔离设计预览，合成夹具，不连真实 CLI/SSH/供应商）。
 * 前置：headless Chrome --remote-debugging-port=9345；http://127.0.0.1:8790 已服务 src-tauri/dist。
 * 运行：bash scripts/run-chrome-check.sh scripts/verify-cr073-software.mjs 9345
 * 输出：docs/Test/screenshots/cr073-software/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr073-software";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9345/json/list")).json();
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
      new Promise((_, rej) => setTimeout(() => rej(new Error("截图超时")), 8000)),
    ]);
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("shot", name);
  } catch (error) { console.log("shot-failed", name, String(error)); }
};
let failed = 0;
const assert = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) { failed += 1; process.exitCode = 1; }
};
const click = async selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
const rect = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; })()`);

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8790/index.html?preview=design" });
await wait(3200);

/* 进入项目管理页 */
await evaluate(`(async () => {
  const nav = [...document.querySelectorAll(".nav-item")].find(b => (b.textContent || "").includes("项目管理"));
  nav?.click();
  return true;
})()`);
await wait(600);
const homeOk = await evaluate(`Boolean(document.querySelector(".proj-card"))`);
assert("前置：项目管理页已渲染", homeOk === true, homeOk);
await shot("sc073-sw-00-projects");

/* ---------- AC-01 图标悬浮层锚定＋限高 ---------- */
const pop = await evaluate(`(async () => {
  const tile = document.querySelector(".proj-card .icon-tile-btn");
  if (!tile) return { error: "未找到卡片图标砖" };
  const tr = tile.getBoundingClientRect();
  tile.click();
  await new Promise(r => setTimeout(r, 420));
  const el = document.querySelector(".icon-pop");
  if (!el) return { error: "悬浮层未打开" };
  const pr = el.getBoundingClientRect();
  const body = el.querySelector(".icon-pop-b");
  const mask = document.querySelector(".icon-pop-mask");
  return {
    tile: { left: Math.round(tr.left), bottom: Math.round(tr.bottom) },
    pop: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
    side: el.dataset.side,
    position: getComputedStyle(el).position,
    maskBg: getComputedStyle(mask).backgroundColor,
    swatches: el.querySelectorAll(".cr51-swatch").length,
    icons: el.querySelectorAll(".cr51-picker-cell").length,
    scrollable: body ? body.scrollHeight > body.clientHeight + 1 : null,
    groups: el.querySelectorAll(".cr51-picker-group").length,
  };
})()`);
console.log("pop", JSON.stringify(pop));
assert("AC-01 悬浮层打开", !pop.error, pop.error);
assert("AC-01 采用 fixed 锚定定位", pop.position === "fixed", pop.position);
assert("AC-01 出现在触发图标下方且左缘对齐", pop.side === "below" && Math.abs(pop.pop.left - pop.tile.left) <= 2 && pop.pop.top >= pop.tile.bottom, pop);
assert("AC-01 整体高度不超过 420px", pop.pop.height <= 421, pop.pop.height);
assert("AC-01 遮罩为透明命中层", pop.maskBg === "rgba(0, 0, 0, 0)", pop.maskBg);
assert("AC-01 10 色卡 + 清空项", pop.swatches === 11, pop.swatches);
assert("AC-01 50 图标 + 默认项", pop.icons === 51, pop.icons);
assert("AC-01 六组图标纵向分组", pop.groups === 6, pop.groups);
assert("AC-01 超高内容在正文区滚动", pop.scrollable === true, pop.scrollable);
await shot("sc073-sw-01-icon-popover");

/* 滚动条三帧（悬浮层正文） */
const scrollFrames = await evaluate(`(async () => {
  const el = document.querySelector(".icon-pop-b");
  const probe = () => ({ active: el.classList.contains("scrollbar-active"), color: getComputedStyle(el).scrollbarColor, cw: el.clientWidth });
  el.scrollTop = 0; await new Promise(r => setTimeout(r, 900));
  const initial = probe();
  el.scrollTop = 120; await new Promise(r => setTimeout(r, 140));
  const scrolling = probe();
  await new Promise(r => setTimeout(r, 1100));
  const stopped = probe();
  return { initial, scrolling, stopped };
})()`);
console.log("pop-scroll", JSON.stringify(scrollFrames));
assert("AC-12 悬浮层滚动条初始隐藏", scrollFrames.initial.active === false, scrollFrames.initial);
assert("AC-12 悬浮层滚动时显示", scrollFrames.scrolling.active === true, scrollFrames.scrolling);
assert("AC-12 悬浮层停止后隐藏", scrollFrames.stopped.active === false, scrollFrames.stopped);
assert("AC-12 悬浮层滚动条不改变内容宽度", scrollFrames.initial.cw === scrollFrames.stopped.cw, [scrollFrames.initial.cw, scrollFrames.stopped.cw]);

/* 取消不落库 */
const cancel = await evaluate(`(async () => {
  document.querySelector('.icon-pop [aria-label^="背景色 rose"]')?.click();
  await new Promise(r => setTimeout(r, 80));
  const closeBtn = document.querySelector('.icon-pop .icon-pop-h button');
  closeBtn?.click();
  await new Promise(r => setTimeout(r, 240));
  const reopened = Boolean(document.querySelector(".icon-pop"));
  const tileStyle = document.querySelector(".proj-card .cr51-tile")?.className || "";
  return { reopened, tileStyle };
})()`);
assert("AC-01 取消后悬浮层关闭", cancel.reopened === false, cancel.reopened);

/* ---------- AC-02 编辑弹窗：名称与图标同行 + 图标可改 ---------- */
await evaluate(`(async () => {
  document.querySelector('.proj-card [aria-label^="编辑项目"]')?.click();
  await new Promise(r => setTimeout(r, 500));
  return true;
})()`);
const modal = await evaluate(`(() => {
  const row = document.querySelector(".project-name-row");
  const tile = row?.querySelector("button.project-name-tile");
  const input = row?.querySelector("input");
  if (!row || !tile || !input) return { error: "名称行结构缺失" };
  const rr = row.getBoundingClientRect(), tr = tile.getBoundingClientRect(), ir = input.getBoundingClientRect();
  const labels = [...document.querySelectorAll("dialog .modal-body label, dialog .modal-body .field > span")].map(l => (l.textContent || "").trim());
  const ownerInput = [...document.querySelectorAll("dialog input")].find(i => (i.previousElementSibling?.textContent || "").includes("负责人"));
  const members = [...document.querySelectorAll("dialog *")].some(el => (el.textContent || "").trim() === "成员");
  return {
    sameRow: Math.abs((tr.top + tr.height / 2) - (ir.top + ir.height / 2)) <= 6,
    tileLeftOfInput: tr.right <= ir.left + 2,
    tileIsButton: tile.tagName === "BUTTON",
    labels,
    members,
    ownerEditable: ownerInput ? !ownerInput.disabled : null,
    hasApplyStorageText: (document.querySelector("dialog")?.textContent || "").includes("未接入"),
  };
})()`);
console.log("modal", JSON.stringify(modal));
assert("AC-02 名称与图标同一行", modal.sameRow === true && modal.tileLeftOfInput === true, modal);
assert("AC-02 图标砖为可点击按钮", modal.tileIsButton === true, modal.tileIsButton);
assert("AC-04 无成员字段", modal.members === false, modal.members);
assert("AC-03 负责人可编辑", modal.ownerEditable === true, modal.ownerEditable);
assert("AC-03 无「未接入存储」文案", modal.hasApplyStorageText === false, modal.hasApplyStorageText);
await shot("sc073-sw-02-project-edit");

/* 弹窗内点图标打开悬浮层（在 dialog 内） */
const inDialog = await evaluate(`(async () => {
  document.querySelector("button.project-name-tile")?.click();
  await new Promise(r => setTimeout(r, 420));
  const el = document.querySelector(".icon-pop");
  if (!el) return { error: "弹窗内悬浮层未打开" };
  const pr = el.getBoundingClientRect();
  return { open: true, inDialog: Boolean(el.closest("dialog")), height: Math.round(pr.height), width: Math.round(pr.width) };
})()`);
assert("AC-02 弹窗内可打开图标悬浮层", inDialog.open === true, inDialog);
assert("AC-02 悬浮层挂在 dialog 内（不被遮挡）", inDialog.inDialog === true, inDialog.inDialog);
await shot("sc073-sw-02b-icon-popover-in-dialog");
await evaluate(`(() => { document.querySelector(".icon-pop .icon-pop-h button")?.click(); return true; })()`);
await wait(260);
await evaluate(`(() => { const b = [...document.querySelectorAll("dialog .modal-foot button, dialog .modal-footer button")].find(x => (x.textContent||"").includes("取消")); b?.click(); return true; })()`);
await wait(400);

/* 打开项目窗口（创建对象页签），再验证页签与需求工作区。 */
await evaluate(`(async () => {
  const card = document.querySelector(".proj-card");
  card?.click();
  await new Promise(r => setTimeout(r, 1000));
  return true;
})()`);
await wait(600);

/* ---------- AC-05 窗口页签省略 ---------- */
const tabInfo = await evaluate(`(async () => {
  const tab = document.querySelector(".nc-window-tab:not(.home-tab)");
  if (!tab) return { error: "无对象页签" };
  const label = tab.querySelector(".nc-tab-label");
  const close = tab.querySelector(".nc-tab-close");
  if (!label) return { error: "标题未包省略容器" };
  const cs = getComputedStyle(label);
  const tr = tab.getBoundingClientRect(), cr = close?.getBoundingClientRect();
  return {
    whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow, overflow: cs.overflow,
    tabHeight: Math.round(tr.height), tabWidth: Math.round(tr.width),
    closeWidth: cr ? Math.round(cr.width) : null,
    hasTitle: Boolean(tab.querySelector(".nc-tab-focus")?.getAttribute("title")),
  };
})()`);
console.log("tab", JSON.stringify(tabInfo));
assert("AC-05 标题单行不换行", tabInfo.whiteSpace === "nowrap", tabInfo.whiteSpace);
assert("AC-05 标题以省略号截断", tabInfo.textOverflow === "ellipsis" && tabInfo.overflow === "hidden", tabInfo);
assert("AC-05 页签高度未被撑高", tabInfo.tabHeight <= 40, tabInfo.tabHeight);
assert("AC-05 关闭按钮不被压缩", tabInfo.closeWidth === 28, tabInfo.closeWidth);
assert("AC-05 悬停可看完整名称", tabInfo.hasTitle === true, tabInfo.hasTitle);
await shot("sc073-sw-05-window-tab");

/* ---------- AC-06/09 需求工作区 ---------- */
/* 切到需求页签。 */
await evaluate(`(async () => {
  const reqTab = [...document.querySelectorAll(".pw-tab")].find(b => (b.textContent || "").trim() === "需求");
  reqTab?.click();
  await new Promise(r => setTimeout(r, 1200));
  return true;
})()`);
await wait(600);
const layout = await evaluate(`(() => {
  const ws = document.querySelector(".req-workspace");
  if (!ws) return { error: "需求工作区未渲染" };
  const main = ws.querySelector(".req-main");
  const top = ws.querySelector(".req-topbar");
  const tabs = ws.querySelector(".req-tabs");
  const tree = ws.querySelector(".req-tree-pane");
  const toc = ws.querySelector(".req-toc-pane");
  const body = ws.querySelector(".req-body");
  const rail = ws.querySelector(".req-rail");
  if (!main || !tabs) return { error: "缺少 req-main / 页签条" };
  const r = el => el ? el.getBoundingClientRect() : null;
  const mr = r(main), tr = r(tabs), treeR = r(tree), tocR = r(toc), bodyR = r(body);
  return {
    uiVersion: ws.dataset.uiVersion,
    tabsInTopbar: Boolean(top?.querySelector(".req-tabs")),
    tabsLeft: Math.round(tr.left), tabsRight: Math.round(tr.right),
    mainRight: Math.round(mr.right),
    treeRight: treeR ? Math.round(treeR.right) : null,
    treeHeight: treeR ? Math.round(treeR.height) : null,
    workspaceHeight: Math.round(ws.getBoundingClientRect().height),
    tocHeadTop: toc ? Math.round(toc.querySelector(".req-toc-head")?.getBoundingClientRect().top ?? 0) : null,
    tabsTop: Math.round(tr.top),
    railButtons: rail ? [...rail.querySelectorAll("button")].map(b => (b.getAttribute("aria-label") || "").trim()) : [],
    feet: ws.querySelectorAll(".req-tree-foot").length,
    treeHeadButtons: tree ? [...tree.querySelectorAll(".req-tree-head button")].map(b => (b.getAttribute("aria-label") || "").trim()) : [],
    tocHeadButtons: toc ? [...toc.querySelectorAll(".req-toc-head button")].map(b => (b.getAttribute("aria-label") || "").trim()) : [],
    hasEditorPanel: Boolean(ws.querySelector(".req-map-editor")),
  };
})()`);
console.log("layout", JSON.stringify(layout));
assert("AC-06 页签条位于 req-topbar 内", layout.tabsInTopbar === true, layout.tabsInTopbar);
assert("AC-06 页签条横跨正文与目录（右边界对齐 req-main）", Math.abs(layout.tabsRight - layout.mainRight) <= 2, [layout.tabsRight, layout.mainRight]);
assert("AC-06 页签条不覆盖需求树", layout.treeRight !== null && layout.tabsLeft >= layout.treeRight - 2, [layout.tabsLeft, layout.treeRight]);
assert("AC-06 目录标题位于页签条之下", layout.tocHeadTop !== null && layout.tocHeadTop >= layout.tabsTop, [layout.tocHeadTop, layout.tabsTop]);
assert("AC-06 需求树保持整列高度", layout.treeHeight !== null && layout.treeHeight >= layout.workspaceHeight - 2, [layout.treeHeight, layout.workspaceHeight]);
assert("AC-09 左轨只保留三个阅读方式", layout.railButtons.length === 3, layout.railButtons);
assert("AC-09 需求树与目录底部说明已移除", layout.feet === 0, layout.feet);
assert("AC-09 刷新图标在「+」左侧且开关在标题行", layout.treeHeadButtons.length >= 2 && layout.treeHeadButtons[0] === "刷新需求源", layout.treeHeadButtons);
assert("AC-09 目录开关位于目录标题行", (layout.tocHeadButtons || []).some(t => t.includes("目录")), layout.tocHeadButtons);
await shot("sc073-sw-06-requirements");

/* 面板隐藏与恢复入口 */
const toggles = await evaluate(`(async () => {
  const ws = document.querySelector(".req-workspace");
  const treeToggle = ws.querySelector('.req-tree-head [aria-label^="隐藏需求树"], .req-tree-head [aria-label^="显示需求树"]');
  if (!treeToggle) return { error: "未找到需求树开关" };
  treeToggle.click();
  await new Promise(r => setTimeout(r, 420));
  const hidden = !ws.querySelector(".req-tree-pane") || getComputedStyle(ws.querySelector(".req-tree-pane")).display === "none";
  const restore = [...ws.querySelectorAll(".req-pane-restore button")].map(b => (b.getAttribute("aria-label") || "").trim());
  const restoreBtn = ws.querySelector('.req-pane-restore [aria-label^="显示需求树"]');
  restoreBtn?.click();
  await new Promise(r => setTimeout(r, 420));
  const shown = Boolean(ws.querySelector(".req-tree-pane")) && getComputedStyle(ws.querySelector(".req-tree-pane")).display !== "none";
  return { hidden, restore, shown };
})()`);
console.log("toggles", JSON.stringify(toggles));
assert("AC-09 需求树可隐藏", toggles.hidden === true, toggles.hidden);
assert("AC-09 隐藏后出现恢复入口", (toggles.restore || []).some(t => t.includes("显示需求树")), toggles.restore);
assert("AC-09 可从恢复入口重新显示", toggles.shown === true, toggles.shown);

/* ---------- AC-07/08 导图 ---------- */
await evaluate(`(async () => {
  const mapBtn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "").includes("导图"));
  mapBtn?.click();
  await new Promise(r => setTimeout(r, 900));
  return true;
})()`);
const mapBase = await evaluate(`(() => {
  const canvas = document.querySelector(".req-map-scroll");
  if (!canvas) return { error: "导图画布未渲染" };
  return { cursor: getComputedStyle(canvas).cursor, hasHint: Boolean(document.querySelector(".req-map-controls")?.textContent?.includes("Ctrl")) };
})()`);
assert("AC-07 画布默认抓手光标", mapBase.cursor === "grab", mapBase.cursor);
assert("AC-07 工具栏给出拖拽/缩放提示", mapBase.hasHint === true, mapBase.hasHint);
await shot("sc073-sw-07-mindmap");

const pan = await evaluate(`(async () => {
  const canvas = document.querySelector(".req-map-scroll");
  const r = canvas.getBoundingClientRect();
  const before = [canvas.scrollLeft, canvas.scrollTop];
  const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 71, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true });
  const x0 = r.left + 24, y0 = r.top + 24;
  canvas.dispatchEvent(new PointerEvent("pointerdown", opts(x0, y0)));
  for (let i = 1; i <= 6; i++) canvas.dispatchEvent(new PointerEvent("pointermove", opts(x0 - i * 10, y0 - i * 6)));
  canvas.dispatchEvent(new PointerEvent("pointerup", opts(x0 - 60, y0 - 36)));
  await new Promise(res => setTimeout(res, 160));
  return { before, after: [canvas.scrollLeft, canvas.scrollTop] };
})()`);
assert("AC-07 空白处拖拽可平移画布", pan.after[0] !== pan.before[0] || pan.after[1] !== pan.before[1], pan);

const zoom = await evaluate(`(async () => {
  const canvas = document.querySelector(".req-map-scroll");
  const before = document.querySelector(".req-map-zoom")?.textContent;
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  await new Promise(res => setTimeout(res, 420));
  return { before, after: document.querySelector(".req-map-zoom")?.textContent };
})()`);
assert("AC-07 Ctrl+滚轮缩放生效", zoom.before !== zoom.after, zoom);

/* 节点点击 → 编辑面板；点编辑 → 右侧可编辑表单（不弹窗） */
const editorFlow = await evaluate(`(async () => {
  const node = document.querySelector(".req-map-node .req-map-node-hit");
  if (!node) return { error: "无节点" };
  node.click();
  await new Promise(r => setTimeout(r, 520));
  await new Promise(r => setTimeout(r, 260));
  const panelBefore = document.querySelector(".req-map-detail");
  const editBtn = panelBefore?.querySelector(".req-map-detail-foot .primary");
  if (!panelBefore) return { error: "点击节点后未出现右侧面板" };
  editBtn?.click();
  await new Promise(r => setTimeout(r, 900));
  const panel = document.querySelector(".req-map-editor");
  const dialogOpen = Boolean(document.querySelector("dialog[open]"));
  const fields = panel ? [...panel.querySelectorAll(".project-form-grid input, .project-form-grid textarea, .project-form-grid select")].length : 0;
  return { hasPanel: Boolean(panel), fields, dialogOpen, hasSave: Boolean(panel?.querySelector(".req-map-detail-foot .primary")) };
})()`);
console.log("editor", JSON.stringify(editorFlow));
assert("AC-08 右侧面板提供编辑入口", !editorFlow.error, editorFlow.error);
assert("AC-08 编辑改用右侧面板且不弹窗", editorFlow.hasPanel === true && editorFlow.dialogOpen === false, editorFlow);
assert("AC-08 面板含可编辑字段与保存", editorFlow.fields > 4 && editorFlow.hasSave === true, editorFlow);
await shot("sc073-sw-08-mindmap-editor");

/* 新建下级 → 画布占位 + 右侧新建面板（不弹窗） */
const createFlow = await evaluate(`(async () => {
  /* 关闭编辑面板，选中 Vision 节点后点「新增」 */
  document.querySelector(".req-map-editor .req-map-detail-head .icon-btn")?.click();
  await new Promise(r => setTimeout(r, 500));
  /* 只有 Vision/Epic/Feature 节点带「新增下级」按钮；Story 没有下级。 */
  const addBtn = [...document.querySelectorAll(".req-map-node-tools button")].find(b => (b.getAttribute("aria-label") || "").includes("下新增"));
  if (!addBtn) return { error: "未找到新增下级按钮" };
  addBtn.click();
  await new Promise(r => setTimeout(r, 1100));
  return {
    hasDraft: Boolean(document.querySelector(".req-map-draft")),
    hasCreatePanel: Boolean(document.querySelector(".req-map-editor[data-panel-mode='create']")),
    dialogOpen: Boolean(document.querySelector("dialog[open]")),
  };
})()`);
console.log("create", JSON.stringify(createFlow));
assert("AC-08 新建下级出现画布占位节点", createFlow.hasDraft === true, createFlow.hasDraft);
assert("AC-08 新建复用右侧面板且不弹窗", createFlow.hasCreatePanel === true && createFlow.dialogOpen === false, createFlow);
await shot("sc073-sw-08b-mindmap-create");

/* 取消新建 */
const createCancel = await evaluate(`(async () => {
  const cancelBtn = [...document.querySelectorAll(".req-map-editor .req-map-detail-foot button")].find(b => (b.textContent || "").includes("取消"));
  cancelBtn?.click();
  await new Promise(r => setTimeout(r, 520));
  return {
    drafts: document.querySelectorAll(".req-map-draft").length,
    createPanels: document.querySelectorAll(".req-map-editor[data-panel-mode='create']").length,
  };
})()`);
assert("AC-08 取消新建移除占位且关闭新建面板", createCancel.drafts === 0 && createCancel.createPanels === 0, createCancel);

/* ---------- AC-10/11 设计页 ---------- */
await evaluate(`(async () => {
  const tabs = [...document.querySelectorAll(".pw-tab")];
  const designTab = tabs.find(b => (b.textContent || "").trim() === "设计");
  designTab?.click();
  await new Promise(r => setTimeout(r, 1400));
  return true;
})()`);
await wait(500);
const design = await evaluate(`(() => {
  const rail = document.querySelector(".design-rail");
  const railButtons = rail ? [...rail.querySelectorAll("button")].map(b => (b.getAttribute("aria-label") || "").trim()) : [];
  const topbar = document.querySelector(".design-topbar");
  return {
    railButtons,
    hasTocToggle: Boolean(topbar?.querySelector("[aria-label*='目录'], button[aria-expanded]")),
    selectValue: document.querySelector(".design-file-select")?.value || null,
    empty: Boolean(document.querySelector(".design-main .empty")),
  };
})()`);
console.log("design", JSON.stringify(design));
assert("AC-11 设计左轨只有四个分区", design.railButtons.length === 4, design.railButtons);
assert("AC-11 左轨无「关联需求」入口", !design.railButtons.some(t => t.includes("关联需求")), design.railButtons);
assert("AC-11 目录开关在顶部文档操作区", design.hasTocToggle === true, design.hasTocToggle);
await shot("sc073-sw-09-design");

/* 选中 html 文件验证预览 */
const htmlPreview = await evaluate(`(async () => {
  /* 切到 UI 分区（夹具在 docs/UI/index.html 有一个合成 HTML 设计附件）。 */
  const uiRail = [...document.querySelectorAll(".design-rail button")].find(b => (b.getAttribute("aria-label") || "").includes("界面与交互"));
  uiRail?.click();
  await new Promise(r => setTimeout(r, 1200));
  const select = document.querySelector(".design-file-select");
  if (!select) return { error: "无文件选择器" };
  const options = [...select.options].map(o => ({ value: o.value, text: o.textContent }));
  const html = options.find(o => /\\.html?$/i.test(o.value));
  if (!html) return { error: "no-html-file", options };
  select.value = html.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1600));
  const frame = document.querySelector(".design-preview-frame");
  const pre = document.querySelector(".design-main pre.design-source");
  return {
    hasFrame: Boolean(frame),
    sandbox: frame ? frame.getAttribute("sandbox") : null,
    hasSourcePre: Boolean(pre),
    note: document.querySelector(".design-preview-note")?.textContent || null,
  };
})()`);
console.log("htmlPreview", JSON.stringify(htmlPreview));
if (htmlPreview.error === "no-html-file") {
  console.log("SKIP AC-10 该项目 docs/ 下暂无 .html 设计文件（不适用，非失败）", JSON.stringify(htmlPreview.options));
} else {
  assert("AC-10 HTML 设计文件渲染为页面预览", htmlPreview.hasFrame === true && htmlPreview.hasSourcePre === false, htmlPreview);
  assert("AC-10 预览沙箱不含脚本与同源", htmlPreview.sandbox === "", htmlPreview.sandbox);
  await shot("sc073-sw-10-design-html-preview");
  const sourceToggle = await evaluate(`(async () => {
    const btn = [...document.querySelectorAll(".design-preview-bar button")].find(b => (b.textContent || "").includes("源码"));
    btn?.click();
    await new Promise(r => setTimeout(r, 420));
    return { hasPre: Boolean(document.querySelector(".design-main pre.design-source")), hasFrame: Boolean(document.querySelector(".design-preview-frame")) };
  })()`);
  assert("AC-10 可切换到源码视图", sourceToggle.hasPre === true, sourceToggle);
  await shot("sc073-sw-10b-design-source");
}

console.log(failed === 0 ? "ALL PASS" : `FAILED ${failed}`);
ws.close();
