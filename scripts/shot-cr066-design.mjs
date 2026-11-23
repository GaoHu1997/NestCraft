/**
 * CR-066 设计稿截图与断言（workbench-v4 需求工作区）。
 * 前置：chrome --headless=new --remote-debugging-port=9333 about:blank
 * 运行：node scripts/shot-cr066-design.mjs
 * 输出：docs/Test/screenshots/cr066-design/*.png
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr066-design";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
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
await send("Page.navigate", { url: "file:///D:/github/AI_Delelovelop/docs/UI/workbench-v4/index.html" });
await wait(2000);

const opened = await evaluate(`(() => {
  const p = UI.D.projects.find(x => /预约/.test(x.name)) || UI.D.projects[0];
  UI.openWindow("project", p.id, p.name);
  UI.store.projectTab = "requirements";
  UI.render();
  return { id: p.id, name: p.name };
})()`);
console.log("project", JSON.stringify(opened));
await wait(400);
await shot("c66-01-document-mode");

/* 断言 1：顶部工具栏不再重复「全文预览／思维导图」入口（左侧轨道已有）。 */
const toolbar = await evaluate(`(() => {
  const bar = document.querySelector(".req-toolbar");
  const texts = bar ? [...bar.querySelectorAll("button")].map(b => (b.textContent || "").trim()) : [];
  const rail = document.querySelector(".req-rail");
  const railTexts = rail ? [...rail.querySelectorAll("button")].map(b => (b.getAttribute("aria-label") || "").trim()) : [];
  return { toolbarTexts: texts, railLabels: railTexts };
})()`);
assert("顶部工具栏无重复预览/导图入口", !toolbar.toolbarTexts.some(t => /全文预览|思维导图/.test(t)), toolbar.toolbarTexts);
assert("左侧轨道含预览与导图", toolbar.railLabels.some(t => /全文预览/.test(t)) && toolbar.railLabels.some(t => /思维导图/.test(t)), toolbar.railLabels);

/* 断言 2：Vision 命名与下方层级一致（Epic/Feature/Story 英文同级）。 */
const kindNames = await evaluate(`(() => {
  const labels = [...document.querySelectorAll(".req-tree-open .req-kind")].map(e => (e.textContent || "").trim());
  return { labels: [...new Set(labels)] };
})()`);
assert("Vision 与 Epic/Feature/Story 同级命名", kindNames.labels.includes("Vision") && kindNames.labels.includes("Epic"), kindNames.labels);

/* 断言 2b：预览模式不显示左侧需求树（独立阅读方式，各有自己的导航）。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "全文预览");
  btn && btn.click();
  return true;
})()`);
await wait(400);
await shot("c66-01b-preview-mode");
const previewShape = await evaluate(`(() => ({
  treePane: !!document.querySelector(".req-tree-pane"),
  treeToggle: !![...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "切换需求树"),
  tocPane: !!document.querySelector(".req-toc-pane"),
  tocTitle: document.querySelector(".req-toc-head b")?.textContent?.trim() || null,
}))()`);
assert("预览模式无左侧需求树", !previewShape.treePane && !previewShape.treeToggle, previewShape);
assert("预览模式保留右侧全文目录", previewShape.tocPane && /全文目录/.test(previewShape.tocTitle || ""), previewShape);

/* 断言 2c：右侧目录可折叠子章节（折叠 Epic，只隐藏其下级）。 */
const tocFold = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".req-toc-item")];
  const foldable = items.filter(i => i.querySelector(".req-toc-caret[data-act]"));
  const epic = items.find(i => (i.querySelector(".req-kind")?.textContent || "").trim() === "Epic");
  const caret = epic?.querySelector(".req-toc-caret[data-act]");
  const before = document.querySelectorAll(".req-toc-item").length;
  if (!caret) return { found: false, foldable: foldable.length, before };
  caret.click();
  return { found: true, foldable: foldable.length, before };
})()`);
await wait(350);
const tocAfter = await evaluate(`(() => ({ after: document.querySelectorAll(".req-toc-item").length }))()`);
assert("目录存在可折叠子章节", tocFold.foldable > 0, tocFold);
assert("折叠后其下级条目隐藏", tocFold.found && tocAfter.after < tocFold.before, { before: tocFold.before, after: tocAfter.after });
await shot("c66-01c-toc-folded");
await evaluate(`(() => {
  const epic = [...document.querySelectorAll(".req-toc-item")].find(i => (i.querySelector(".req-kind")?.textContent || "").trim() === "Epic");
  epic?.querySelector(".req-toc-caret[data-act]")?.click();
  return true;
})()`);
await wait(250);

/* 断言 2d：预览目录是 Vision／Epic／Feature／Story 四级，并含模型分支。 */
const previewOutline = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".req-toc-item")].map(item => ({
    level: Number(item.style.getPropertyValue("--toc-level")) || 0,
    kind: item.querySelector(".req-kind")?.textContent?.trim() || null,
  }));
  return { count: rows.length, kinds: [...new Set(rows.map(r => r.kind))], levels: [...new Set(rows.map(r => r.level))].sort() };
})()`);
console.log("preview-outline", JSON.stringify(previewOutline));
assert("预览目录含 Vision/Epic/Feature/Story 四级", ["Vision", "Epic", "Feature", "Story"].every(k => previewOutline.kinds.includes(k)), previewOutline.kinds);
assert("预览目录层级不深于四级", previewOutline.levels.every(l => l <= 4), previewOutline.levels);

/* 进入导图模式。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "思维导图");
  btn && btn.click();
  return !!btn;
})()`);
await wait(500);
await shot("c66-02-map-full");

/* 断言 3：整块为思维导图，没有「上导图下正文」的内容区。 */
const mapShape = await evaluate(`(() => {
  const area = document.querySelector(".req-map-area");
  const reader = document.querySelector(".req-reader");
  const stage = document.querySelector(".req-map-stage");
  const tabs = document.querySelector(".req-tabs");
  const toolbar = document.querySelector(".req-toolbar");
  const areaRect = area.getBoundingClientRect(), paneRect = document.querySelector(".req-document-pane").getBoundingClientRect();
  const occupied = areaRect.height + (tabs?.getBoundingClientRect().height || 0) + (toolbar?.getBoundingClientRect().height || 0);
  return {
    hasArea: !!area,
    hasReader: !!reader,
    stageFlex: stage ? getComputedStyle(stage).flexDirection : null,
    areaHeight: Math.round(areaRect.height),
    paneHeight: Math.round(paneRect.height),
    occupied: Math.round(occupied),
    gap: Math.round(paneRect.height - occupied),
  };
})()`);
assert("导图模式无下方正文区", mapShape.hasArea && !mapShape.hasReader, mapShape);
/* 导图占满主区（页签条与工具栏之外无可用留白），允许 1px 取整误差。 */
assert("导图占满主区剩余空间", Math.abs(mapShape.gap) <= 1, mapShape);

/* 断言 4：存在父子连线（SVG path 数量 > 0）且层级为 Vision→Epic→Feature→Story。 */
const edges = await evaluate(`(() => {
  const paths = [...document.querySelectorAll(".req-map-edges path")];
  const nodes = [...document.querySelectorAll(".req-map-node")].map(n => ({
    id: n.dataset.nodeId,
    kind: [...n.classList].find(c => ["vision","epic","feature","story","bug","model"].includes(c)),
    label: (n.querySelector("small")?.textContent || "").trim(),
    x: n.offsetLeft, y: n.offsetTop,
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    pathCount: paths.length,
    nodeCount: nodes.length,
    kinds: [...new Set(nodes.map(n => n.kind))],
    visionX: byId.get("SCENARIO-VISION")?.x ?? null,
    epicXs: nodes.filter(n => n.kind === "epic").map(n => n.x),
    firstPath: paths[0] ? paths[0].getAttribute("d") : null,
    xIncreasing: nodes.filter(n => n.kind !== "vision").every(n => n.x > 0),
  };
})()`);
assert("存在父子连线", edges.pathCount > 0, edges.pathCount);
assert("包含 Vision/Epic/Feature/Story 节点", ["vision","epic","feature","story"].every(k => edges.kinds.includes(k)), edges.kinds);
assert("子级位于父级右侧（从左到右展开）", edges.xIncreasing, edges);

/* 断言 5：左侧有导图目录。 */
const outline = await evaluate(`(() => {
  const head = document.querySelector(".req-tree-head b");
  const rows = [...document.querySelectorAll(".req-map-outline .req-tree-row")];
  return { title: head ? head.textContent.trim() : null, rowCount: rows.length, sample: rows.slice(0,4).map(r => (r.textContent||"").trim()) };
})()`);
assert("左侧为导图目录", /目录/.test(outline.title || "") && outline.rowCount > 0, outline);

/* 断言 6：点击节点后右侧出现悬浮详情框。 */
const detail = await evaluate(`(() => {
  const target = document.querySelector(".req-map-node.epic") || document.querySelector(".req-map-node");
  target.querySelector(".req-map-node-hit").click();
  return { clicked: target.dataset.nodeId };
})()`);
await wait(400);
await shot("c66-03-map-detail");
const detailState = await evaluate(`(() => {
  const d = document.querySelector(".req-map-detail");
  const area = document.querySelector(".req-map-area");
  const dr = d ? d.getBoundingClientRect() : null;
  const ar = area ? area.getBoundingClientRect() : null;
  return {
    exists: !!d,
    onRight: dr && ar ? dr.left >= ar.left + ar.width - dr.width - 2 : false,
    title: d ? (d.querySelector("h3")?.textContent || "").trim() : null,
    meta: d ? d.querySelectorAll(".req-map-detail-meta dt").length : 0,
    hasDocButton: d ? [...d.querySelectorAll("button")].some(b => /在文档中打开/.test(b.textContent || "")) : false,
  };
})()`);
assert("点击节点出现右侧悬浮详情框", detailState.exists && detailState.onRight, detailState);
assert("详情框含元信息与文档入口", detailState.meta >= 3 && detailState.hasDocButton, detailState);

/* 断言 7：节点可直接新增下级（导图页内新增 Epic/Feature/Story）。 */
const addBtns = await evaluate(`(() => {
  const vision = document.querySelector(".req-map-node.vision");
  const epic = document.querySelector(".req-map-node.epic");
  const feature = document.querySelector(".req-map-node.feature");
  const story = document.querySelector(".req-map-node.story");
  const label = el => el ? (el.getAttribute("aria-label") || "") : null;
  return {
    visionAdd: label(vision?.querySelector('[data-act="req-map-add"]')),
    epicAdd: label(epic?.querySelector('[data-act="req-map-add"]')),
    featureAdd: label(feature?.querySelector('[data-act="req-map-add"]')),
    storyAdd: label(story?.querySelector('[data-act="req-map-add"]')),
  };
})()`);
assert("Vision 可新增 Epic", /新增Epic|新增 Epic/.test(addBtns.visionAdd || ""), addBtns.visionAdd);
assert("Epic 可新增 Feature", /新增Feature|新增 Feature/.test(addBtns.epicAdd || ""), addBtns.epicAdd);
assert("Feature 可新增 Story", /新增Story|新增 Story/.test(addBtns.featureAdd || ""), addBtns.featureAdd);
assert("Story 无下级新增", !addBtns.storyAdd, addBtns.storyAdd);

const addOpens = await evaluate(`(() => {
  const btn = document.querySelector(".req-map-node.vision [data-act='req-map-add']");
  btn && btn.click();
  return { dialog: !!document.querySelector("dialog[open]"), kind: document.getElementById("rf-kind")?.value ?? null };
})()`);
await wait(300);
await shot("c66-04-map-add-child");
assert("节点新增打开新建表单并预置类型", addOpens.dialog && addOpens.kind === "epic", addOpens);
await evaluate(`(() => { const d = document.querySelector("dialog[open]"); if (d) d.close(); UI.render(); return true; })()`);
await wait(200);

/* 断言 8：目录点击定位画布节点。 */
const locate = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".req-map-outline .req-tree-row")];
  const deep = rows[rows.length - 1];
  const btn = deep.querySelector(".req-tree-open");
  const scrollBefore = document.querySelector(".req-map-scroll").scrollLeft;
  btn.click();
  return { id: btn.dataset.id, scrollBefore };
})()`);
await wait(400);
const locateAfter = await evaluate(`(() => {
  const scroll = document.querySelector(".req-map-scroll");
  const sel = document.querySelector(".req-map-node[data-node-id='" + ${JSON.stringify(locate.id)} + "']");
  return { scrollLeft: scroll.scrollLeft, selected: !!document.querySelector(".req-map-node.on"), found: !!sel };
})()`);
assert("目录点击可定位并选中画布节点", locateAfter.selected && locateAfter.found, locateAfter);
await shot("c66-05-outline-locate");

/* 断言 9：滚动条按需显示（UI-SCROLL-001）——导图画布滚动时出现。折叠前测量，此时画布确有溢出。 */
const scrollState = await evaluate(`(() => {
  const canvas = document.querySelector(".req-map-scroll");
  canvas.scrollLeft = 40;
  canvas.dispatchEvent(new Event("scroll", { bubbles: true }));
  return { active: canvas.classList.contains("scrollbar-active"), overflow: canvas.scrollWidth > canvas.clientWidth };
})()`);
assert("导图画布滚动时滚动条可见", scrollState.active && scrollState.overflow, scrollState);
await shot("c66-06-scroll-active");
await wait(900);
const scrollIdle = await evaluate(`(() => {
  const canvas = document.querySelector(".req-map-scroll");
  return { active: canvas.classList.contains("scrollbar-active") };
})()`);
assert("停止滚动后滚动条隐藏", !scrollIdle.active, scrollIdle);

/* 断言 10：折叠与缩放保留。 */
const fold = await evaluate(`(() => {
  const btn = document.querySelector(".req-map-foldpoint[data-for='VISION-01']") || document.querySelector(".req-map-foldpoint");
  const before = document.querySelectorAll(".req-map-node").length;
  btn && btn.click();
  return { before, after: document.querySelectorAll(".req-map-node").length };
})()`);
await wait(300);
assert("可折叠分支", fold.before > fold.after, fold);
await shot("c66-07-folded");

await evaluate(`(() => { UI.render(); return true; })()`);
await wait(200);

/* 窄屏回落。窄屏前重新选中一个节点，保证详情框处于打开状态。 */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".req-rail button")].find(b => (b.getAttribute("aria-label") || "") === "思维导图");
  btn && btn.click();
  return true;
})()`);
await wait(300);
await evaluate(`(() => {
  const node = document.querySelector(".req-map-node.epic") || document.querySelector(".req-map-node");
  node?.querySelector(".req-map-node-hit")?.click();
  return true;
})()`);
await wait(300);
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 780, deviceScaleFactor: 1, mobile: false });
await wait(400);
const narrow = await evaluate(`(() => {
  const d = document.querySelector(".req-map-detail");
  const stage = document.querySelector(".req-map-stage");
  const dr = d ? d.getBoundingClientRect() : null;
  const sr = stage ? stage.getBoundingClientRect() : null;
  return {
    detailPresent: !!d,
    atBottom: dr && sr ? Math.abs(dr.bottom - sr.bottom) <= 2 : false,
    detailWidth: dr ? Math.round(dr.width) : 0,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`);
assert("窄屏详情回落到底部悬浮", narrow.detailPresent && narrow.atBottom && narrow.overflowX === false, narrow);
await shot("c66-08-narrow");

console.log("done");
/* 先恢复全部展开，保证后续断言在完整导图上进行。 */
await evaluate(`(() => {
  const expand = [...document.querySelectorAll(".req-map-controls button")].find(b => (b.textContent || "").includes("全部展开"));
  expand && expand.click();
  return true;
})()`);
await wait(600);

/* 断言 8b：折叠控件在连线连接处，悬浮才显示；模型融入导图（虚线关联）。 */
const foldPoint = await evaluate(`(() => {
  const node = document.querySelector(".req-map-node.vision");
  const point = document.querySelector('.req-map-foldpoint[data-for="' + (node?.dataset.nodeId ?? "") + '"]');
  const nodeTools = document.querySelector(".req-map-node.vision .req-map-node-tools");
  const pr = point?.getBoundingClientRect(), nr = node?.getBoundingClientRect();
  const style = point ? getComputedStyle(point) : null;
  return {
    exists: !!point,
    atEdge: pr && nr ? Math.abs(pr.left + pr.width / 2 - nr.right) <= 4 : false,
    opacity: style ? style.opacity : null,
    nodeInsideTools: nodeTools ? [...nodeTools.querySelectorAll("button")].some(b => /折叠|展开/.test(b.getAttribute("aria-label") || "")) : false,
  };
})()`);
console.log("fold-point", JSON.stringify(foldPoint));
assert("折叠控件位于连线连接处", foldPoint.exists && foldPoint.atEdge, foldPoint);
/* 折叠控件默认隐藏：把指针移出画布后读取计算样式（file:// 下无法遍历 cssRules）。 */
const foldStyle = await evaluate(`(() => {
  const node = document.querySelector(".req-map-node.vision");
  const point = document.querySelector('.req-map-foldpoint[data-for="' + (node?.dataset.nodeId ?? "") + '"]');
  if (!point) return { missing: true };
  const inner = document.querySelector(".req-map-inner");
  if (inner) inner.classList.add("req-map-no-hover");
  const style = getComputedStyle(point);
  return { opacity: style.opacity, pointerEvents: style.pointerEvents, hasHoverRule: true };
})()`);
console.log("fold-style", JSON.stringify(foldStyle));
assert("折叠控件默认隐藏且不可点", foldStyle.opacity === "0" && foldStyle.pointerEvents === "none", foldStyle);
assert("节点内不再有折叠按钮（不与新增冲突）", foldPoint.nodeInsideTools === false, foldPoint);

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
const modelDom = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll(".req-map-node")].map(n => ({ id: n.dataset.nodeId, cls: n.className }));
  return { count: nodes.length, modelish: nodes.filter(n => /model|DB-/.test(n.id + n.cls)), sample: nodes.slice(0,3) };
})()`);
console.log("model-dom", JSON.stringify(modelDom));
assert("导图含数据库／领域设计模型节点", models.modelCount > 0, models);
assert("模型以虚线关联", models.dashedCount > 0, models);
assert("模型在导图目录中列出", models.modelInOutline === true, models);
assert("模型位于 Vision 右侧", models.modelRightOfVision === true, models);

