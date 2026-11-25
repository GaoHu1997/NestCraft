/**
 * CR-073 设计稿自检（workbench-v4）。
 * 前置：headless Chrome 带 --remote-debugging-port，且本地静态服务器 http://127.0.0.1:8765 已启动。
 * 运行：bash scripts/run-chrome-check.sh scripts/shot-cr073-design.mjs 9337
 * 输出：docs/Test/screenshots/cr073-design/*.png + 断言 PASS/FAIL
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr073-design";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9337/json/list")).json();
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
  await wait(240);
  try {
    const r = await Promise.race([
      send("Page.captureScreenshot", { format: "png" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("截图超时")), 8000)),
    ]);
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("shot", name);
  } catch (error) {
    console.log("shot-failed", name, String(error));
  }
};
let failed = 0;
const assert = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) { failed += 1; process.exitCode = 1; }
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8765/workbench-v4/index.html" });
await wait(2200);

/* 打开预约项目（唯一有完整样例的项目）。 */
const opened = await evaluate(`(() => {
  const p = UI.D.projects.find(x => /预约/.test(x.name)) || UI.D.projects[0];
  UI.openWindow("project", p.id, p.name);
  UI.store.projectTab = "requirements";
  UI.render();
  return { id: p.id, name: p.name };
})()`);
console.log("project", JSON.stringify(opened));
await wait(400);

/* ---------- 项 1：图标悬浮层锚定 + 限高 ---------- */
const pop1 = await evaluate(`(async () => {
  UI.closeDialog?.();
  UI.store.homePage = "projects";
  UI.store.active = "home";
  UI.render();
  await new Promise(r => setTimeout(r, 220));
  const tile = document.querySelector(".proj-card [data-c070-open]");
  if (!tile) return { error: "未找到项目卡片图标砖" };
  const r = tile.getBoundingClientRect();
  tile.click();
  await new Promise(res => setTimeout(res, 180));
  const pop = document.querySelector(".icon-pop");
  if (!pop) return { error: "悬浮层未打开" };
  const pr = pop.getBoundingClientRect();
  const mask = document.querySelector(".icon-pop-mask");
  const maskBg = mask ? getComputedStyle(mask).backgroundColor : null;
  return {
    tileRect: { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) },
    popRect: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
    side: pop.dataset.side,
    maskBg,
    hasSwatches: document.querySelectorAll(".icon-pop .swatch").length,
    hasIcons: document.querySelectorAll(".icon-pop .picker-cell").length,
    bodyScrollable: (() => { const b = document.querySelector(".icon-pop-b"); return b ? b.scrollHeight > b.clientHeight + 1 : false; })(),
  };
})()`);
console.log("pop1", JSON.stringify(pop1));
assert("AC-01 悬浮层已打开", !pop1.error, pop1.error);
assert("AC-01 锚定在触发图标下方", pop1.side === "below" && Math.abs(pop1.popRect.left - pop1.tileRect.left) <= 2, pop1.side);
assert("AC-01 高度不超过 420px", pop1.popRect.height <= 421, pop1.popRect.height);
assert("AC-01 遮罩为透明命中层", pop1.maskBg === "rgba(0, 0, 0, 0)" || pop1.maskBg === "transparent", pop1.maskBg);
assert("AC-01 10 色卡 + 清空态", pop1.hasSwatches === 11, pop1.hasSwatches);
assert("AC-01 图标网格完整（50 + 默认）", pop1.hasIcons === 51, pop1.hasIcons);
assert("AC-01 超高内容在正文区滚动", pop1.bodyScrollable === true, pop1.bodyScrollable);
await shot("sc073-01-icon-popover");

/* 取消不落库 */
const cancel = await evaluate(`(() => {
  const before = JSON.stringify(UI.D.projects.map(p => [p.id, p.icon, p.iconColor]));
  document.querySelector('.icon-pop [data-c070-act="icon"]')?.click();
  document.querySelector('.icon-pop [data-c070-act="close"]')?.click();
  const after = JSON.stringify(UI.D.projects.map(p => [p.id, p.icon, p.iconColor]));
  return { same: before === after, open: Boolean(document.querySelector(".icon-pop")) };
})()`);
assert("AC-01 取消不落库", cancel.same === true && cancel.open === false, cancel);

/* 保存成对写入 */
const save = await evaluate(`(async () => {
  const tile = document.querySelector(".proj-card [data-c070-open]");
  tile.click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('.icon-pop [data-c070-act="color"][data-id="rose"]').click();
  document.querySelector('.icon-pop [data-c070-act="icon"][data-id="rocket"]').click();
  document.querySelector('.icon-pop [data-c070-act="save"]').click();
  await new Promise(r => setTimeout(r, 200));
  const p = UI.D.projects.find(x => x.icon === "rocket");
  return p ? { id: p.id, icon: p.icon, iconColor: p.iconColor } : { error: "未写入" };
})()`);
assert("AC-01 保存成对写入 icon+iconColor", save.icon === "rocket" && save.iconColor === "rose", save);

/* ---------- 项 2/4：编辑项目弹窗 ---------- */
const modal = await evaluate(`(async () => {
  const p = UI.D.projects[0];
  window.Screens.projectModal("edit", p.id);
  await new Promise(r => setTimeout(r, 220));
  const row = document.querySelector(".project-name-row");
  const tile = document.querySelector(".project-name-row .icon-tile-btn");
  const nameInput = document.getElementById("pf-name");
  const members = document.getElementById("pf-members");
  const labels = [...document.querySelectorAll("#dialog .form-row > label")].map(l => l.textContent.trim());
  const owner = document.getElementById("pf-owner");
  const desc = document.getElementById("pf-desc");
  const rr = row?.getBoundingClientRect(), tr = tile?.getBoundingClientRect(), nr = nameInput?.getBoundingClientRect();
  return {
    sameRow: Boolean(rr && tr && nr) && Math.abs((tr.top + tr.height / 2) - (nr.top + nr.height / 2)) <= 6,
    tileLeftOfName: Boolean(tr && nr) && tr.right <= nr.left + 2,
    hasMembers: Boolean(members),
    labels,
    ownerEditable: owner ? !owner.disabled : null,
    descEditable: desc ? !desc.disabled : null,
    ownerPlaceholder: owner?.placeholder,
    descPlaceholder: desc?.placeholder,
  };
})()`);
console.log("modal", JSON.stringify(modal));
assert("AC-02 名称与图标同一行", modal.sameRow === true && modal.tileLeftOfName === true, modal);
assert("AC-02 图标砖可点击（编辑态）", await evaluate(`Boolean(document.querySelector(".project-name-row button.icon-tile-btn"))`) === true);
assert("AC-04 无成员字段", modal.hasMembers === false && !modal.labels.includes("成员"), modal.labels);
assert("AC-03 负责人可填写", modal.ownerEditable === true, modal.ownerEditable);
assert("AC-03 描述可填写", modal.descEditable === true, modal.descEditable);
assert("AC-03 无「未接入存储」文案", !String(modal.ownerPlaceholder).includes("未接入") && !String(modal.descPlaceholder).includes("未接入"), [modal.ownerPlaceholder, modal.descPlaceholder]);
await shot("sc073-02-project-edit-modal");

/* 弹窗内点图标打开悬浮层（top layer 不被遮挡） */
const inDialog = await evaluate(`(async () => {
  document.querySelector(".project-name-row .icon-tile-btn").click();
  await new Promise(r => setTimeout(r, 200));
  const pop = document.querySelector("dialog .icon-pop") || document.querySelector(".icon-pop");
  const inDlg = Boolean(pop && pop.closest("dialog"));
  const pr = pop?.getBoundingClientRect();
  return { open: Boolean(pop), inDialog: inDlg, rect: pr ? { top: Math.round(pr.top), height: Math.round(pr.height), width: Math.round(pr.width) } : null };
})()`);
assert("AC-02 弹窗内点图标可打开悬浮层", inDialog.open === true, inDialog);
assert("AC-02 悬浮层挂在 dialog 内（不被遮挡）", inDialog.inDialog === true, inDialog.inDialog);
await shot("sc073-02b-icon-popover-in-dialog");

/* 保存图标后弹窗重绘且保留其它字段 */
const keep = await evaluate(`(async () => {
  document.querySelector('.icon-pop [data-c070-act="icon"][data-id="target"]').click();
  document.querySelector('.icon-pop [data-c070-act="save"]').click();
  await new Promise(r => setTimeout(r, 240));
  const p = UI.D.projects[0];
  const tileHtml = document.querySelector(".project-name-row")?.innerHTML || "";
  return { icon: p.icon, dialogOpen: document.getElementById("dialog")?.open, nameValue: document.getElementById("pf-name")?.value };
})()`);
assert("AC-02 弹窗内保存图标生效并保持弹窗", keep.icon === "target" && keep.dialogOpen === true, keep);

/* 关闭弹窗，避免影响后续 */
await evaluate(`(() => { document.querySelector("#dialog [data-act='close-dialog']")?.click(); return true; })()`);
await wait(200);

/* ---------- 项 3/3b：负责人/描述保存 ---------- */
const ownerSave = await evaluate(`(async () => {
  const p = UI.D.projects[0];
  window.Screens.projectModal("edit", p.id);
  await new Promise(r => setTimeout(r, 180));
  document.getElementById("pf-owner").value = "测试负责人";
  document.getElementById("pf-desc").value = "测试描述内容";
  document.querySelector("[data-act='project-save']").click();
  await new Promise(r => setTimeout(r, 220));
  const saved = UI.D.projects.find(x => x.id === p.id);
  return { owner: saved.owner, desc: saved.desc };
})()`);
assert("AC-03 负责人/描述保存生效", ownerSave.owner === "测试负责人" && ownerSave.desc === "测试描述内容", ownerSave);

/* ---------- 项 5：窗口页签单行省略 ---------- */
const tabs = await evaluate(`(async () => {
  const long = "超长项目名称用于验证页签省略行为".repeat(4);
  UI.D.projects.push({ ...UI.D.projects[0], id: "PRJ-LONG", name: long, key: "LONG" });
  UI.openWindow("project", "PRJ-LONG", long);
  await new Promise(r => setTimeout(r, 260));
  const tab = [...document.querySelectorAll(".nc-window-tab, .wtab")].find(el => el.textContent.includes("超长项目名称"));
  if (!tab) return { error: "未找到长名页签" };
  const label = tab.querySelector(".ellipsis") || tab.querySelector(".nc-tab-focus span") || tab.querySelector(".wtab-focus span");
  const cs = label ? getComputedStyle(label) : null;
  const tr = tab.getBoundingClientRect(), cr = tab.querySelector(".nc-tab-close, .w-close")?.getBoundingClientRect();
  return {
    whiteSpace: cs?.whiteSpace, overflow: cs?.overflow, textOverflow: cs?.textOverflow,
    tabWidth: Math.round(tr.width), tabHeight: Math.round(tr.height),
    closeWidth: cr ? Math.round(cr.width) : null,
    truncated: label ? label.scrollWidth > label.clientWidth + 1 : null,
  };
})()`);
console.log("tabs", JSON.stringify(tabs));
assert("AC-05 页签标题单行不换行", tabs.whiteSpace === "nowrap", tabs.whiteSpace);
assert("AC-05 页签标题以省略号截断", tabs.textOverflow === "ellipsis" && tabs.truncated === true, tabs);
assert("AC-05 页签高度未撑高", tabs.tabHeight <= 40, tabs.tabHeight);
await shot("sc073-05-window-tab-ellipsis");

/* ---------- 项 6/8：需求工作区 ---------- */
const layout = await evaluate(`(async () => {
  UI.store.projectTab = "requirements";
  UI.store.active = "project:" + UI.D.projects[0].id;
  UI.render();
  await new Promise(r => setTimeout(r, 320));
  const ws = document.querySelector(".req-workspace");
  const main = document.querySelector(".req-main");
  const top = document.querySelector(".req-topbar");
  const tabsEl = document.querySelector(".req-topbar .req-tabs") || document.querySelector(".req-tabs");
  const tree = document.querySelector(".req-tree-pane");
  const toc = document.querySelector(".req-toc-pane");
  const body = document.querySelector(".req-body");
  const rail = document.querySelector(".req-rail");
  if (!ws || !main || !top || !tabsEl) return { error: "结构缺失" };
  const r = el => el ? el.getBoundingClientRect() : null;
  const wr = r(ws), mr = r(main), tr = r(tabsEl), treeR = r(tree), tocR = r(toc), bodyR = r(body);
  return {
    railButtons: [...rail.querySelectorAll("button")].map(b => (b.getAttribute("aria-label") || b.textContent).trim()),
    tabsLeft: Math.round(tr.left), tabsRight: Math.round(tr.right),
    mainLeft: Math.round(mr.left), mainRight: Math.round(mr.right),
    treeRight: treeR ? Math.round(treeR.right) : null,
    treeTop: treeR ? Math.round(treeR.top) : null,
    tabsTop: Math.round(tr.top),
    tocHeadTop: toc ? Math.round(r(toc.querySelector(".req-toc-head")).top) : null,
    bodyTop: bodyR ? Math.round(bodyR.top) : null,
    tabsInTopbar: Boolean(document.querySelector(".req-topbar .req-tabs")),
    treeFullHeight: treeR ? Math.round(treeR.height) >= Math.round(wr.height) - 2 : null,
    foots: document.querySelectorAll(".req-tree-foot").length,
    treeButtons: [...(tree?.querySelectorAll(".req-tree-head button") || [])].map(b => b.getAttribute("aria-label")),
    tocButtons: [...(toc?.querySelectorAll(".req-toc-head button") || [])].map(b => b.getAttribute("aria-label")),
  };
})()`);
console.log("layout", JSON.stringify(layout));
assert("AC-06 页签在 req-topbar 内（跨正文+目录）", layout.tabsInTopbar === true, layout.tabsInTopbar);
assert("AC-06 页签左边界不覆盖需求树", layout.tabsLeft >= (layout.treeRight ?? 0) - 2, [layout.tabsLeft, layout.treeRight]);
assert("AC-06 页签右边界到目录右缘", Math.abs(layout.tabsRight - layout.mainRight) <= 2, [layout.tabsRight, layout.mainRight]);
assert("AC-06 目录标题位于页签区之下", layout.tocHeadTop !== null && layout.tocHeadTop >= layout.tabsTop, [layout.tocHeadTop, layout.tabsTop]);
assert("AC-06 需求树保持整列高度", layout.treeFullHeight === true, layout.treeFullHeight);
assert("AC-09 左轨只保留三个阅读方式", layout.railButtons.length === 3, layout.railButtons);
assert("AC-09 底部说明全部移除", layout.foots === 0, layout.foots);
assert("AC-09 刷新在「+」左侧", JSON.stringify(layout.treeButtons) === JSON.stringify(["刷新需求源", "新增Epic", "隐藏需求树"]), layout.treeButtons);
assert("AC-09 目录开关在标题行", (layout.tocButtons || []).includes("隐藏目录"), layout.tocButtons);
await shot("sc073-06-requirements-document");

/* 面板开关与恢复入口 */
const toggles = await evaluate(`(async () => {
  document.querySelector("[data-act='req-workspace-tree']").click();
  await new Promise(r => setTimeout(r, 240));
  const hidden = document.querySelector(".req-workspace").classList.contains("req-tree-hidden");
  const restore = [...document.querySelectorAll(".req-pane-restore button")].map(b => b.getAttribute("aria-label"));
  const restored = restore.length > 0;
  document.querySelector(".req-pane-restore [data-act='req-workspace-tree']")?.click();
  await new Promise(r => setTimeout(r, 220));
  const shown = !document.querySelector(".req-workspace").classList.contains("req-tree-hidden");
  return { hidden, restore, restored, shown };
})()`);
assert("AC-09 需求树可隐藏", toggles.hidden === true, toggles.hidden);
assert("AC-09 隐藏后有恢复入口", toggles.restored === true && toggles.restore.includes("显示需求树"), toggles.restore);
assert("AC-09 可从恢复入口重新显示", toggles.shown === true, toggles.shown);

/* 全文预览模式同样结构 */
const previewMode = await evaluate(`(async () => {
  document.querySelector("[data-act='req-workspace-mode'][data-mode='preview']").click();
  await new Promise(r => setTimeout(r, 320));
  const tabs = document.querySelector(".req-topbar .req-tabs");
  const toc = document.querySelector(".req-toc-pane .req-toc-head");
  const m = document.querySelector(".req-main").getBoundingClientRect();
  const t = tabs?.getBoundingClientRect();
  return { hasTabsInTop: Boolean(tabs), tabsRight: t ? Math.round(t.right) : null, mainRight: Math.round(m.right), tocHead: toc?.textContent.trim().slice(0, 8), mode: document.querySelector(".req-workspace").dataset.mode };
})()`);
assert("AC-06 全文预览页签结构一致", previewMode.hasTabsInTop === true && Math.abs(previewMode.tabsRight - previewMode.mainRight) <= 2, previewMode);
await shot("sc073-06b-requirements-preview");

/* ---------- 项 7：导图拖拽/缩放/编辑面板/新建复用 ---------- */
const mapInfo = await evaluate(`(async () => {
  document.querySelector("[data-act='req-workspace-mode'][data-mode='map']").click();
  await new Promise(r => setTimeout(r, 360));
  const canvas = document.querySelector(".req-map-scroll");
  const node = document.querySelector(".req-map-node:not(.req-map-draft)");
  if (!canvas) return { error: "画布缺失" };
  const cr = canvas.getBoundingClientRect();
  return {
    hasCanvas: true,
    cursor: getComputedStyle(canvas).cursor,
    hasControlsHint: Boolean(document.querySelector(".req-map-controls .caption")),
    nodeId: node?.dataset.nodeId,
    canvasRect: { left: Math.round(cr.left), top: Math.round(cr.top), width: Math.round(cr.width), height: Math.round(cr.height) },
  };
})()`);
console.log("map", JSON.stringify(mapInfo));
assert("AC-07 画布默认抓手光标", mapInfo.cursor === "grab", mapInfo.cursor);
await shot("sc073-07-mindmap");

/* 拖拽平移：派发 pointer 事件 */
const panResult = await evaluate(`(async () => {
  const canvas = document.querySelector(".req-map-scroll");
  const r = canvas.getBoundingClientRect();
  const before = [canvas.scrollLeft, canvas.scrollTop];
  const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 91, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true });
  const blank = [r.left + 30, r.top + 30];
  canvas.dispatchEvent(new PointerEvent("pointerdown", opts(...blank)));
  for (let i = 1; i <= 6; i++) document.dispatchEvent(new PointerEvent("pointermove", opts(blank[0] - i * 12, blank[1] - i * 8)));
  document.dispatchEvent(new PointerEvent("pointerup", opts(blank[0] - 72, blank[1] - 48)));
  await new Promise(res => setTimeout(res, 120));
  const after = [canvas.scrollLeft, canvas.scrollTop];
  const panning = canvas.classList.contains("is-panning");
  return { before, after, moved: after[0] !== before[0] || after[1] !== before[1], panning };
})()`);
console.log("pan", JSON.stringify(panResult));
assert("AC-07 空白处拖拽可平移画布", panResult.moved === true, panResult);

/* Ctrl + 滚轮缩放 */
const zoomResult = await evaluate(`(async () => {
  const canvas = document.querySelector(".req-map-scroll");
  const r = canvas.getBoundingClientRect();
  const before = document.querySelector(".req-map-zoom").textContent;
  canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  await new Promise(res => setTimeout(res, 300));
  const after = document.querySelector(".req-map-zoom")?.textContent;
  return { before, after };
})()`);
assert("AC-07 Ctrl+滚轮放大生效", zoomResult.before !== zoomResult.after, zoomResult);

/* 节点点击打开可编辑面板 */
const editor = await evaluate(`(async () => {
  const node = document.querySelector(".req-map-node:not(.req-map-draft) .req-map-node-hit");
  node.click();
  await new Promise(r => setTimeout(r, 300));
  const panel = document.querySelector(".req-map-detail");
  const isEditor = panel?.classList.contains("req-map-editor");
  const fields = [...(panel?.querySelectorAll("[data-field]") || [])].map(el => el.dataset.field);
  const actions = [...(panel?.querySelectorAll("footer button") || [])].map(b => (b.textContent || "").replace(/\\s+/g, ""));
  return { hasPanel: Boolean(panel), isEditor, fields, actions, dialogOpen: Boolean(document.getElementById("dialog")?.open) };
})()`);
console.log("editor", JSON.stringify(editor));
assert("AC-08 右侧面板为编辑表单", editor.isEditor === true && editor.fields.includes("title") && editor.fields.includes("status"), editor);
assert("AC-08 编辑不弹窗", editor.dialogOpen === false, editor.dialogOpen);
await shot("sc073-08-mindmap-edit-panel");

/* 保存编辑 */
const editSave = await evaluate(`(async () => {
  const before = document.querySelector(".req-map-detail .req-map-detail-head b").textContent;
  const input = document.querySelector('.req-map-editor [data-field="title"]');
  input.value = "验收：编辑面板可直接保存";
  document.querySelector("[data-act='req-map-save']").click();
  await new Promise(r => setTimeout(r, 320));
  const node = [...document.querySelectorAll(".req-map-node b")].map(b => b.textContent);
  return { before, hit: node.some(t => t.includes("验收：编辑面板可直接保存")) };
})()`);
assert("AC-08 面板保存写回并刷新画面", editSave.hit === true, editSave);

/* 新建下级复用面板（不弹窗） */
const createFlow = await evaluate(`(async () => {
  document.querySelector('.req-map-node-tools [data-act="req-map-add"]')?.click();
  await new Promise(r => setTimeout(r, 320));
  const draft = document.querySelector(".req-map-draft");
  const panel = document.querySelector(".req-map-editor[data-create-kind]");
  const dialogOpen = Boolean(document.getElementById("dialog")?.open);
  return { hasDraft: Boolean(draft), hasCreatePanel: Boolean(panel), dialogOpen };
})()`);
console.log("create", JSON.stringify(createFlow));
assert("AC-08 新建下级出现占位节点", createFlow.hasDraft === true, createFlow.hasDraft);
assert("AC-08 新建复用右侧面板且不弹窗", createFlow.hasCreatePanel === true && createFlow.dialogOpen === false, createFlow);
await shot("sc073-08b-mindmap-create-panel");

/* 新建保存 */
const createSave = await evaluate(`(async () => {
  const countBefore = UI.D.requirements.length;
  document.getElementById("rmc-title").value = "验收：面板内新建下级";
  document.querySelector("[data-act='req-map-draft-save']").click();
  await new Promise(r => setTimeout(r, 360));
  const created = UI.D.requirements.find(r => r.title === "验收：面板内新建下级");
  return { countBefore, countAfter: UI.D.requirements.length, created: created ? created.id : null, drafts: document.querySelectorAll(".req-map-draft").length };
})()`);
assert("AC-08 新建保存后落库并清除占位", createSave.countAfter === createSave.countBefore + 1 && createSave.drafts === 0, createSave);

/* 新建取消 */
const createCancel = await evaluate(`(async () => {
  const countBefore = UI.D.requirements.length;
  document.querySelector('.req-map-node-tools [data-act="req-map-add"]')?.click();
  await new Promise(r => setTimeout(r, 260));
  document.querySelector("[data-act='req-map-draft-close']").click();
  await new Promise(r => setTimeout(r, 260));
  return { countBefore, countAfter: UI.D.requirements.length, drafts: document.querySelectorAll(".req-map-draft").length };
})()`);
assert("AC-08 新建取消不落库且移除占位", createCancel.countAfter === createCancel.countBefore && createCancel.drafts === 0, createCancel);

/* ---------- 项 9/10：设计页 ---------- */
const design = await evaluate(`(async () => {
  UI.store.projectTab = "design";
  UI.store.designTab = "ui";
  UI.store.designUiDoc = "html";
  UI.store.designViewMode = "preview";
  UI.render();
  await new Promise(r => setTimeout(r, 420));
  const rail = document.querySelector(".design-rail");
  const railButtons = [...(rail?.querySelectorAll("button") || [])].map(b => (b.getAttribute("aria-label") || b.textContent).trim());
  const frame = document.querySelector(".design-preview-frame");
  const pre = document.querySelector(".design-main pre.design-source");
  return {
    railButtons,
    hasFrame: Boolean(frame),
    sandbox: frame?.getAttribute("sandbox"),
    hasSourcePre: Boolean(pre),
    hasTocToggle: Boolean(document.querySelector(".design-topbar [data-act='design-toc']")),
    frameHeight: frame ? Math.round(frame.getBoundingClientRect().height) : null,
  };
})()`);
console.log("design", JSON.stringify(design));
assert("AC-10 HTML 设计文件以 iframe 渲染预览", design.hasFrame === true && design.hasSourcePre === false, design);
assert("AC-10 预览沙箱不含脚本与同源", design.sandbox === "", design.sandbox);
assert("AC-11 设计左轨只有四个分区", design.railButtons.length === 4, design.railButtons);
assert("AC-11 目录开关在顶部文档操作区", design.hasTocToggle === true, design.hasTocToggle);
await shot("sc073-09-design-preview");

/* 源码切换 */
const sourceView = await evaluate(`(async () => {
  document.querySelector("[data-act='design-view'][data-view='source']").click();
  await new Promise(r => setTimeout(r, 300));
  return { hasPre: Boolean(document.querySelector(".design-main pre.design-source")), hasFrame: Boolean(document.querySelector(".design-preview-frame")) };
})()`);
assert("AC-10 可切换到源码视图", sourceView.hasPre === true && sourceView.hasFrame === false, sourceView);
await shot("sc073-09b-design-source");

/* ---------- 窄屏与深色 ---------- */
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
const narrow = await evaluate(`(async () => {
  UI.store.designViewMode = "preview";
  UI.store.projectTab = "requirements";
  UI.store.selectedReq = null;
  UI.render();
  await new Promise(r => setTimeout(r, 360));
  const tabs = document.querySelector(".req-topbar .req-tabs")?.getBoundingClientRect();
  const main = document.querySelector(".req-main")?.getBoundingClientRect();
  const tile = document.querySelector(".proj-card [data-c070-open]");
  return { tabsRight: tabs ? Math.round(tabs.right) : null, mainRight: main ? Math.round(main.right) : null, cards: document.querySelectorAll(".proj-card").length };
})()`);
assert("AC-06 1100px 下页签仍横贯正文+目录", narrow.tabsRight !== null && Math.abs(narrow.tabsRight - narrow.mainRight) <= 2, narrow);
await shot("sc073-12-narrow-1100");

await evaluate(`(() => { UI.store.theme = "dark"; UI.render(); return true; })()`);
await wait(360);
await shot("sc073-12-dark");
await evaluate(`(() => { UI.store.theme = "light"; UI.render(); return true; })()`);

console.log(failed === 0 ? "ALL PASS" : `FAILED ${failed}`);
ws.close();
