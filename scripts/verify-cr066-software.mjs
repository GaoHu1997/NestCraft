/**
 * CR-066 正式软件行为验证（隔离设计预览：真实 React 组件 + mock IPC）。
 * 前置：npm run preview（4173），Chrome headless --remote-debugging-port=9334。
 * 输出：docs/Test/screenshots/cr066-software/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr066-software";
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
    /* 截图失败不中断断言流程：截图是证据，不是判定依据。 */
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
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(4500);

// 打开 code 项目 → 需求 tab
const opened = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects.find(x => x.kind === "code") || projects[0];
  return { id: p.id, name: p.name, all: projects.map(x => ({ id: x.id, name: x.name, kind: x.kind })) };
})()`);
console.log("projects", JSON.stringify(opened));

await evaluate(`(() => {
  const cards = [...document.querySelectorAll(".proj-card")];
  const el = cards.find(e => (e.textContent || "").includes(${JSON.stringify(opened.id)})) || cards[0];
  el?.click();
  return !!el;
})()`);
await wait(2500);

// 需求 tab
await evaluate(`(() => {
  const tab = [...document.querySelectorAll(".pw-tab")].find(e => /需求/.test(e.textContent || ""));
  tab && tab.click();
  return !!tab;
})()`);
await wait(2500);
await shot("c66s-01-requirements");

const docMode = await evaluate(`(() => ({
  tree: !!document.querySelector(".req-tree-pane"),
  reader: !!document.querySelector(".req-reader"),
  kinds: [...new Set([...document.querySelectorAll(".req-tree-open .req-kind")].map(e => e.textContent.trim()))],
  toolbarTexts: [...document.querySelectorAll(".req-toolbar button")].map(b => (b.textContent || "").trim()),
  railLabels: [...document.querySelectorAll(".req-rail button")].map(b => (b.getAttribute("aria-label") || "").trim()),
}))()`);
console.log("doc-mode", JSON.stringify(docMode));
assert("文档模式显示需求树与正文", docMode.tree && docMode.reader, docMode);
assert("Vision 与 Epic/Feature/Story 同级命名", docMode.kinds.includes("Vision") && docMode.kinds.includes("Epic"), docMode.kinds);
assert("顶部工具栏无重复预览/导图入口", !docMode.toolbarTexts.some(t => /全文预览|思维导图/.test(t)), docMode.toolbarTexts);
assert("左侧轨道含预览与导图", docMode.railLabels.some(t => /全文预览/.test(t)) && docMode.railLabels.some(t => /思维导图/.test(t)), docMode.railLabels);

/* 预览模式：无左树，右侧目录可折叠。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "全文预览");
  btn && btn.click();
  return true;
})()`);
await wait(1200);
await shot("c66s-02-preview");
const previewState = await evaluate(`(() => ({
  tree: !!document.querySelector(".req-tree-pane"),
  treeToggle: !![...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "切换需求树"),
  toc: !!document.querySelector(".req-toc-pane"),
  tocTitle: document.querySelector(".req-toc-head b")?.textContent?.trim() || null,
  tocItems: document.querySelectorAll(".req-toc-item").length,
  foldCaret: document.querySelectorAll(".req-toc-caret[data-act], .req-toc-caret").length,
}))()`);
console.log("preview", JSON.stringify(previewState));
assert("预览模式无左侧需求树", !previewState.tree && !previewState.treeToggle, previewState);
assert("预览模式保留右侧全文目录", previewState.toc && /全文目录/.test(previewState.tocTitle || ""), previewState);

const tocFold = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".req-toc-item")];
  const carets = items.filter(i => i.querySelector("button.req-toc-caret"));
  const epic = items.find(i => (i.querySelector(".req-kind")?.textContent || "").trim() === "Epic");
  const caret = epic?.querySelector("button.req-toc-caret");
  const before = items.length;
  if (!caret) return { found: false, foldable: carets.length, before };
  caret.click();
  return { found: true, foldable: carets.length, before };
})()`);
await wait(600);
const tocAfter = await evaluate(`(() => ({ after: document.querySelectorAll(".req-toc-item").length }))()`);
console.log("toc-fold", JSON.stringify({ ...tocFold, ...tocAfter }));
assert("目录存在可折叠子章节", tocFold.foldable > 0, tocFold);
assert("折叠后其下级条目隐藏", tocFold.found && tocAfter.after < tocFold.before, { before: tocFold.before, after: tocAfter.after });
/* 展开回来，保证后续断言在完整目录上进行。 */
await evaluate(`(() => {
  const epic = [...document.querySelectorAll(".req-toc-item")].find(i => (i.querySelector(".req-kind")?.textContent || "").trim() === "Epic");
  epic?.querySelector("button.req-toc-caret")?.click();
  return true;
})()`);
await wait(500);
await shot("c66s-03-toc-folded");

/* 断言 2d：预览目录是 Vision／Epic／Feature／Story 四级结构，并含模型分支。 */
const previewOutline = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".req-toc-item")];
  const rows = items.map(item => ({
    level: Number(item.style.getPropertyValue("--toc-level")) || 0,
    kind: item.querySelector(".req-kind")?.textContent?.trim() || null,
    title: (item.querySelector(".ellipsis")?.textContent || "").trim(),
  }));
  return {
    count: rows.length,
    kinds: [...new Set(rows.map(r => r.kind))],
    levels: [...new Set(rows.map(r => r.level))].sort(),
    hasModel: rows.some(r => r.kind === "模型"),
    sample: rows.slice(0, 8),
  };
})()`);
console.log("preview-outline", JSON.stringify(previewOutline));
assert("预览目录含 Vision/Epic/Feature/Story 四级", ["Vision", "Epic", "Feature", "Story"].every(k => previewOutline.kinds.includes(k)), previewOutline.kinds);
assert("预览目录层级不深于四级", previewOutline.levels.every(l => l <= 4), previewOutline.levels);
assert("预览目录含模型分支", previewOutline.hasModel === true, previewOutline);

/* 导图模式。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "思维导图");
  btn && btn.click();
  return true;
})()`);
await wait(1500);
await shot("c66s-04-map");

const mapState = await evaluate(`(() => {
  const area = document.querySelector(".req-map-area");
  const reader = document.querySelector(".req-reader");
  const visible = el => !!el && !!el.offsetParent;
  const paths = [...document.querySelectorAll(".req-map-edges path")];
  const nodes = [...document.querySelectorAll(".req-map-node")].map(n => ({
    id: n.dataset.nodeId,
    kind: [...n.classList].find(c => ["vision","epic","feature","story","bug","model"].includes(c)),
    x: n.offsetLeft,
  }));
  const areaRect = area?.getBoundingClientRect();
  const workspaceRect = document.querySelector(".req-workspace")?.getBoundingClientRect();
  const tabs = document.querySelector(".req-tabs")?.getBoundingClientRect().height || 0;
  const toolbar = document.querySelector(".req-toolbar")?.getBoundingClientRect().height || 0;
  const outlinePane = document.querySelector(".req-map-outline-pane")?.getBoundingClientRect();
  return {
    hasArea: !!area, readerVisible: visible(reader),
    pathCount: paths.length,
    nodeCount: nodes.length,
    kinds: [...new Set(nodes.map(n => n.kind))],
    visionX: nodes.find(n => n.kind === "vision")?.x ?? null,
    epicXs: nodes.filter(n => n.kind === "epic").map(n => n.x),
    outlineRows: document.querySelectorAll(".req-map-outline .req-tree-row").length,
    outlineTitle: document.querySelector(".req-map-outline-pane .req-tree-head b")?.textContent?.trim() || null,
    outlineOnLeft: outlinePane && areaRect ? outlinePane.right <= areaRect.left + 2 : false,
    areaHeight: areaRect ? Math.round(areaRect.height) : 0,
    workspaceHeight: workspaceRect ? Math.round(workspaceRect.height) : 0,
    /* 页签条与工具栏在导图区内部，导图区应占满工作区剩余高度。 */
    gap: areaRect && workspaceRect ? Math.round(workspaceRect.height - areaRect.height) : null,
  };
})()`);
console.log("map", JSON.stringify(mapState));
assert("导图模式整块为导图（无下方正文）", mapState.hasArea && !mapState.readerVisible, mapState);
assert("导图占满主区剩余空间", mapState.gap !== null && Math.abs(mapState.gap) <= 2, mapState);
assert("导图目录位于画布左侧", mapState.outlineOnLeft, mapState);
assert("存在父子连线", mapState.pathCount > 0, mapState.pathCount);
assert("包含 Vision/Epic/Feature/Story 节点", ["vision","epic","feature","story"].every(k => mapState.kinds.includes(k)), mapState.kinds);
assert("子级位于父级右侧", mapState.epicXs.length > 0 && mapState.visionX !== null && mapState.epicXs.every(x => x > mapState.visionX), mapState);
assert("左侧为导图目录", /导图目录/.test(mapState.outlineTitle || "") && mapState.outlineRows > 0, mapState);

/* 点击节点 → 右侧悬浮详情。 */
const detail = await evaluate(`(() => {
  const target = document.querySelector(".req-map-node.epic") || document.querySelector(".req-map-node");
  target?.querySelector(".req-map-node-hit")?.click();
  return { clicked: target?.dataset.nodeId ?? null };
})()`);
await wait(800);
await shot("c66s-05-map-detail");
const detailState = await evaluate(`(() => {
  const d = document.querySelector(".req-map-detail");
  const area = document.querySelector(".req-map-area");
  const dr = d?.getBoundingClientRect(), ar = area?.getBoundingClientRect();
  return {
    exists: !!d,
    onRight: dr && ar ? dr.left >= ar.left + ar.width - dr.width - 2 : false,
    title: d?.querySelector("h3")?.textContent?.trim() || null,
    meta: d?.querySelectorAll(".req-map-detail-meta dt").length || 0,
    hasDocButton: d ? [...d.querySelectorAll("button")].some(b => /在文档中打开/.test(b.textContent || "")) : false,
  };
})()`);
console.log("detail", JSON.stringify(detailState));
assert("点击节点出现右侧悬浮详情框", detailState.exists && detailState.onRight, detailState);
assert("详情框含元信息与文档入口", detailState.meta >= 3 && detailState.hasDocButton, detailState);

/* 节点内新增下级。 */
const addButtons = await evaluate(`(() => {
  const label = sel => { const el = document.querySelector(sel); return el ? (el.getAttribute("aria-label") || "") : null; };
  return {
    vision: label(".req-map-node.vision [aria-label^='在']"),
    epic: label(".req-map-node.epic [aria-label^='在']"),
    feature: label(".req-map-node.feature [aria-label^='在']"),
    story: label(".req-map-node.story [aria-label^='在']"),
  };
})()`);
console.log("add-buttons", JSON.stringify(addButtons));
assert("Vision 节点可新增 Epic", /新增Epic/.test(addButtons.vision || ""), addButtons.vision);
assert("Epic 节点可新增 Feature", /新增Feature/.test(addButtons.epic || ""), addButtons.epic);
assert("Feature 节点可新增 Story", /新增Story/.test(addButtons.feature || ""), addButtons.feature);
assert("Story 节点无下级新增", !/新增/.test(addButtons.story || ""), addButtons.story);

/* 目录点击定位。 */
const locate = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".req-map-outline .req-tree-row")];
  const deep = rows[rows.length - 1];
  const btn = deep?.querySelector(".req-tree-open");
  btn?.click();
  return { id: btn?.dataset.id ?? null, rows: rows.length };
})()`);
await wait(900);
const locateAfter = await evaluate(`(() => ({
  selected: !!document.querySelector(".req-map-node.on"),
  scrollLeft: document.querySelector(".req-map-scroll")?.scrollLeft ?? 0,
}))()`);
console.log("locate", JSON.stringify({ ...locate, ...locateAfter }));
assert("目录点击可定位并选中画布节点", locateAfter.selected, locateAfter);
await shot("c66s-06-outline-locate");

/* 先恢复全部展开，保证后续断言在完整导图上进行。 */
await evaluate(`(() => {
  const expand = [...document.querySelectorAll(".req-map-controls button")].find(b => (b.textContent || "").includes("全部展开"));
  expand && expand.click();
  return true;
})()`);
await wait(600);

/* 等导图区完成布局（有实际高度）再做几何断言，避免拿到未布局的 0 值。 */
await evaluate(`(() => new Promise(resolve => {
  const tick = () => {
    const area = document.querySelector(".req-map-area");
    area && area.getBoundingClientRect().height > 0 ? resolve(true) : setTimeout(tick, 100);
  };
  tick();
}))()`);
await wait(400);

/* 断言 8：折叠控件在连线连接处（父节点右边缘），悬浮才显示，不与节点内新增图标冲突。 */
const foldPoint = await evaluate(`(() => {
  const node = document.querySelector(".req-map-node.vision");
  const point = document.querySelector('.req-map-foldpoint[data-for="' + (node?.dataset.nodeId ?? "") + '"]');
  const nodeTools = document.querySelector(".req-map-node.vision .req-map-node-tools");
  const pr = point?.getBoundingClientRect(), nr = node?.getBoundingClientRect();
  const style = point ? getComputedStyle(point) : null;
  const nodeInsideTools = nodeTools ? [...nodeTools.querySelectorAll("button")].some(b => /折叠|展开/.test(b.getAttribute("aria-label") || "")) : false;
  return {
    exists: !!point,
    atEdge: pr && nr ? Math.abs(pr.left + pr.width / 2 - nr.right) <= 4 : false,
    opacity: style ? style.opacity : null,
    pointerEvents: style ? style.pointerEvents : null,
    nodeInsideTools,
    ariaExpanded: point?.getAttribute("aria-expanded") ?? null,
    pointStyleLeft: point?.style.left ?? null,
    pointRect: pr ? { left: Math.round(pr.left), width: Math.round(pr.width) } : null,
    nodeRect: nr ? { left: Math.round(nr.left), right: Math.round(nr.right), width: Math.round(nr.width) } : null,
  };
})()`);
console.log("fold-point", JSON.stringify(foldPoint));
assert("折叠控件位于连线连接处（父节点右边缘）", foldPoint.exists && foldPoint.atEdge, foldPoint);
const foldStyle = await evaluate(`(() => {
  const sheets = [...document.styleSheets];
  const rules = [];
  for (const sheet of sheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) { if (rule.selectorText && /req-map-foldpoint/.test(rule.selectorText)) rules.push(rule.cssText); }
  }
  /* 基础规则是折叠控件的第一条（不含属性选择器与 :hover）。 */
  const base = rules.find(r => r.indexOf("[aria-expanded") < 0 && r.indexOf(":hover") < 0) || "";
  const hover = rules.find(r => /hover/.test(r) && /req-map-foldpoint/.test(r)) || "";
  return { base, baseOpacity: /opacity: 0/.test(base), basePointerNone: /pointer-events: none/.test(base), hasHoverRule: !!hover };
})()`);
console.log("fold-style", JSON.stringify(foldStyle));
assert("折叠控件基础样式默认隐藏且不可点", foldStyle.baseOpacity && foldStyle.basePointerNone, foldStyle);
assert("悬浮时显示折叠控件", foldStyle.hasHoverRule === true, foldStyle);
assert("节点内不再有折叠按钮（不与新增冲突）", foldPoint.nodeInsideTools === false, foldPoint);

/* 断言 8b：模型融入导图（Vision 下独立分支 + 虚线关联）。 */
const models = await evaluate(`(() => {
  const modelNodes = [...document.querySelectorAll(".req-map-node.model")];
  const dashed = [...document.querySelectorAll(".req-map-edges path.dashed")];
  const vision = document.querySelector(".req-map-node.vision");
  const outline = [...document.querySelectorAll(".req-map-outline .req-tree-row")].map(r => (r.textContent || "").trim());
  return {
    modelCount: modelNodes.length,
    dashedCount: dashed.length,
    modelInOutline: outline.some(t => /模型/.test(t)),
    modelRightOfVision: modelNodes.length && vision ? modelNodes[0].offsetLeft > vision.offsetLeft : false,
  };
})()`);
console.log("models", JSON.stringify(models));
assert("导图含数据库／领域设计模型节点", models.modelCount > 0, models);
assert("模型以虚线关联（非父子实线）", models.dashedCount > 0, models);
assert("模型在导图目录中列出", models.modelInOutline === true, models);
assert("模型位于 Vision 右侧（层级分支）", models.modelRightOfVision === true, models);

/* 折叠分支（折叠控件在连线处）。 */
const fold = await evaluate(`(() => {
  const btn = document.querySelector(".req-map-foldpoint");
  const before = document.querySelectorAll(".req-map-node").length;
  btn?.click();
  return { before, ariaExpanded: btn?.getAttribute("aria-expanded") ?? null };
})()`);
await wait(700);
const foldAfter = await evaluate(`(() => ({ after: document.querySelectorAll(".req-map-node").length }))()`);
console.log("fold", JSON.stringify({ ...fold, ...foldAfter }));
assert("可折叠分支", foldAfter.after < fold.before, { ...fold, ...foldAfter });
await shot("c66s-07-folded");

/* 断言 8c：点击模型节点 → 详情框 → 「打开模型文档」跳转到「设计 → 数据库」并定位到该文件。 */
const modelOpen = await evaluate(`(async () => {
  const model = document.querySelector(".req-map-node.model");
  model?.querySelector(".req-map-node-hit")?.click();
  await new Promise(r => setTimeout(r, 400));
  const detail = document.querySelector(".req-map-detail");
  const openBtn = detail ? [...detail.querySelectorAll("button")].find(b => /打开模型文档/.test(b.textContent || "")) : null;
  if (!openBtn) return { hasDetail: !!detail, hasButton: false };
  const modelId = model?.dataset.nodeId;
  openBtn.click();
  await new Promise(r => setTimeout(r, 900));
  const designPane = document.querySelector(".design-main");
  const select = document.querySelector(".design-file-select");
  const title = designPane?.querySelector("h1,h2,h3")?.textContent?.trim() || null;
  return {
    hasDetail: !!detail, hasButton: true, modelId,
    onDesignTab: !!designPane && designPane.offsetParent !== null,
    selectedFile: select?.value ?? null,
    selectedText: select?.selectedOptions?.[0]?.textContent ?? null,
    bodyMentionsModel: /模型|DB-/.test(designPane?.textContent || ""),
  };
})()`);
console.log("model-open", JSON.stringify(modelOpen));
assert("模型节点点击后有详情框与「打开模型文档」", modelOpen.hasDetail && modelOpen.hasButton, modelOpen);
assert("「打开模型文档」跳转到设计页签", modelOpen.onDesignTab === true, modelOpen);
assert("跳转到设计页后定位到该模型文件", !!modelOpen.selectedText && /模型|DB-/.test(modelOpen.selectedText), modelOpen);
await shot("c66s-05b-model-open");
await evaluate(`(() => {
  const back = [...document.querySelectorAll(".pw-tab")].find(e => /需求/.test(e.textContent || ""));
  back?.click();
  return true;
})()`);
await wait(600);

/* UI-SCROLL-001：导图画布滚动时滚动条可见，停止后隐藏（不改变正文宽度与编辑状态）。
   先恢复全部展开，确保画布确有溢出；再测窄屏回落。 */
await evaluate(`(() => {
  const expand = [...document.querySelectorAll(".req-map-controls button")].find(b => (b.textContent || "").includes("全部展开"));
  expand?.click();
  return true;
})()`);
await wait(700);
const scrollState = await evaluate(`(() => {
  const canvas = document.querySelector(".req-map-scroll");
  if (!canvas) return { missing: true };
  const overflow = canvas.scrollWidth > canvas.clientWidth;
  canvas.scrollLeft = 60;
  canvas.dispatchEvent(new Event("scroll", { bubbles: true }));
  return { overflow, active: canvas.classList.contains("scrollbar-active") };
})()`);
console.log("scroll", JSON.stringify(scrollState));
assert("导图画布确有横向溢出", scrollState.overflow === true, scrollState);
assert("导图画布滚动时滚动条可见", scrollState.active === true, scrollState);
await wait(900);
const scrollIdle = await evaluate(`(() => {
  const canvas = document.querySelector(".req-map-scroll");
  return { active: canvas?.classList.contains("scrollbar-active") ?? null };
})()`);
assert("停止滚动后滚动条隐藏", scrollIdle.active === false, scrollIdle);

/* 窄屏：详情回落到底部，且无整页横向溢出。 */
await evaluate(`(() => {
  const node = document.querySelector(".req-map-node.epic") || document.querySelector(".req-map-node");
  node?.querySelector(".req-map-node-hit")?.click();
  return true;
})()`);
await wait(500);
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 820, deviceScaleFactor: 1, mobile: false });
await wait(700);
const narrow = await evaluate(`(() => {
  const d = document.querySelector(".req-map-detail");
  const stage = document.querySelector(".req-map-stage");
  const dr = d?.getBoundingClientRect(), sr = stage?.getBoundingClientRect();
  return {
    detailPresent: !!d,
    atBottom: dr && sr ? Math.abs(dr.bottom - sr.bottom) <= 2 : false,
    detailWidth: dr ? Math.round(dr.width) : 0,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`);
console.log("narrow", JSON.stringify(narrow));
assert("窄屏详情回落到底部悬浮", narrow.detailPresent && narrow.atBottom && narrow.overflowX === false, narrow);
await shot("c66s-08-narrow");

console.log("done");
