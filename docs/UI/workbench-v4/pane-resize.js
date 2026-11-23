/* CR045：原型会话内栏宽偏好；不读写业务文件。 */
(function () {
  "use strict";
  const { store, activeWindow } = UI;
  const widths = new Map(), visibility = new Map();
  let drag = null, observer = null, frame = 0;
  const specs = [
    { root: ".body", center: ".main", fixed: 0, min: 480, panes: [[".sidebar", "管理导航", "left", 224, 176, 320]] },
    { root: ".workarea", center: ".content", fixed: 0, min: 320, panes: [[".ai-panel", "AI 侧栏", "right", 372, 320, 620]] },
    { root: ".req-workspace", center: ".req-document-pane", fixed: 56, min: 320, panes: [[".req-tree-pane", "需求文件", "left", 320, 200, 480], [".req-toc-pane", "需求目录", "right", 240, 160, 360]] },
    { root: ".design-shell", center: ".design-main", fixed: 56, min: 320, panes: [[".design-toc", "设计目录", "right", 240, 160, 360]] },
    { root: ".code-shell", center: ".code-main", fixed: 56, min: 320, panes: [[".code-panel", "文件与 Git", "left", 260, 180, 480]] },
    { root: ".task-body", center: ".task-list-pane", fixed: 0, min: 320, panes: [[".task-detail-pane", "任务详情", "right", 360, 240, 520]] },
    { root: ".knowledge-workspace", center: "[data-pane=kb-document]", fixed: 0, min: 320, panes: [["[data-pane=kb-tree]", "知识文件", "left", 260, 180, 480], ["[data-pane=kb-toc]", "知识目录", "right", 220, 160, 360]] },
    { root: ".kb-reader", center: ".kb-article", fixed: 0, min: 320, panes: [[".kb-nav", "知识文件", "left", 260, 180, 480], [".kb-toc", "知识目录", "right", 220, 160, 360]] },
    { root: ".srv-shell", center: ".srv-term", fixed: 0, min: 320, panes: [[".srv-files", "服务器文件", "left", 248, 180, 480], [".srv-monitor", "监控", "right", 300, 220, 440]] },
    { root: ".office-layout", center: ".office-main", fixed: 0, min: 320, panes: [[".office-files", "办公文件", "left", 260, 180, 480]] },
    { root: "div.settings-dialog", center: ".set-body", fixed: 0, min: 320, panes: [[".set-nav", "设置分类", "left", 224, 176, 320]] },
    { root: ".office-presentation", center: ".office-slide-area", fixed: 0, min: 240, panes: [[".office-thumbnails", "幻灯片缩略图", "left", 124, 96, 220]] },
    { root: ".ai-pop-model .model-grid", center: ".model-list", fixed: 0, min: 160, panes: [[".model-providers", "模型供应商", "left", 112, 96, 180]] },
    { root: ".ai-panel", center: null, fixed: 0, min: 0, overlay: true, panes: [[".ai-history", "会话历史", "left", 296, 240, 420]] }
  ];
  const records = new Map();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function scope(root, name) {
    const w = activeWindow();
    const page = root === ".workarea" || root === ".ai-panel" ? "ai" : root === "div.settings-dialog" ? "settings" : w.kind === "project" ? store.projectTab : w.kind === "home" ? "management" : w.kind;
    return `${w.id}:${page}:${root}:${name}`;
  }
  function stop() {
    if (!drag) return;
    const old = drag; drag = null;
    try { if (old.handle.hasPointerCapture(old.id)) old.handle.releasePointerCapture(old.id); } catch (_) { /* removed handle */ }
    document.body.classList.remove("pane-dragging");
  }
  function resize(record, value) {
    widths.set(record.key, clamp(value, record.min, record.max));
    if (record.name === "AI 侧栏") store.aiWidth = widths.get(record.key);
    refresh();
  }
  function handleFor(record) {
    const h = document.createElement("div");
    h.className = "pane-handle " + record.side;
    h.tabIndex = 0; h.setAttribute("role", "separator");
    h.setAttribute("aria-orientation", "vertical"); h.setAttribute("aria-label", `调整${record.name}宽度`);
    h.title = "拖动调整宽度；方向键调整，双击恢复默认";
    h.addEventListener("pointerdown", e => {
      if (e.button !== 0 || record.pane.classList.contains("pane-collapsed")) return;
      e.preventDefault(); e.stopPropagation(); stop();
      drag = { record, handle: h, x: e.clientX, value: record.effective, id: e.pointerId, window: activeWindow().id };
      h.setPointerCapture(e.pointerId); document.body.classList.add("pane-dragging");
    });
    h.addEventListener("pointermove", e => {
      if (!drag || drag.handle !== h || drag.id !== e.pointerId) return;
      if (drag.window !== activeWindow().id || !h.isConnected) { stop(); return; }
      resize(record, drag.value + (e.clientX - drag.x) * (record.side === "right" ? -1 : 1));
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => h.addEventListener(type, stop));
    h.addEventListener("dblclick", e => { e.preventDefault(); resize(record, record.default); });
    h.addEventListener("keydown", e => {
      const step = e.shiftKey ? 20 : 10;
      let value;
      if (e.key === "Home") value = record.min;
      if (e.key === "End") value = record.max;
      if (e.key === "ArrowLeft") value = record.effective + (record.side === "right" ? step : -step);
      if (e.key === "ArrowRight") value = record.effective + (record.side === "right" ? -step : step);
      if (value != null) { e.preventDefault(); e.stopPropagation(); resize(record, value); }
    });
    record.pane.appendChild(h); record.handle = h;
  }
  function addToggle(group, record) {
    const button = document.createElement("button");
    button.className = "pane-toggle"; button.type = "button";
    /* CR-065：折叠按钮只留箭头图标，避免与底部状态文字争空间 */
    button.textContent = "›";
    button.setAttribute("aria-label", `展开${record.name}`);
    button.title = `展开${record.name}`;
    button.addEventListener("click", e => {
      e.stopPropagation();
      visibility.set(record.key, !record.open);
      refresh();
    });
    group.controls.appendChild(button); record.toggle = button;
  }
  function refreshGroup(group) {
    const available = group.spec.overlay ? window.innerWidth : group.root.getBoundingClientRect().width;
    if (!available || !group.root.isConnected) return;
    const fixed = available <= 600 ? Math.min(group.spec.fixed, 48) : group.spec.fixed;
    let budget = Math.max(0, available - fixed - Math.min(group.spec.min, available - fixed));
    group.records.forEach(r => {
      const preferred = widths.get(r.key) ?? (r.name === "AI 侧栏" ? store.aiWidth || r.default : r.default);
      r.open = group.spec.overlay ? true : visibility.get(r.key) ?? budget >= r.min;
      const fits = !group.spec.overlay && r.open && budget >= r.min;
      r.overlay = !group.spec.overlay && r.open && !fits;
      r.effective = clamp(preferred, Math.min(r.min, Math.max(0, available - fixed - 16)), Math.min(r.max, r.overlay || group.spec.overlay ? available - fixed - 16 : Math.max(r.min, budget)));
      if (r.open && !r.overlay && !group.spec.overlay) budget -= r.effective;
      r.pane.classList.toggle("pane-collapsed", !r.open);
      r.pane.classList.toggle("pane-overlay", r.overlay);
      /* CR-063：窄屏下 overlay 浮层交给 CSS 媒体查询（fixed 全宽抽屉）。
         内联 absolute + right:100% 会把浮层推到视口外，导致窄屏看不到历史列表。 */
      if (group.spec.overlay && available <= 960) {
        r.pane.style.removeProperty("position");
        r.pane.style.removeProperty("width");
        r.pane.style.removeProperty("max-width");
      } else {
        r.pane.style.setProperty("--pane-width", r.effective + "px");
        r.pane.style.setProperty("width", r.effective + "px", "important");
        if (group.spec.overlay) r.pane.style.setProperty("position", "absolute", "important");
        r.pane.style.setProperty("max-width", "none", "important");
      }
      r.pane.style.setProperty("min-width", "0", "important");
      r.pane.dataset.paneWidth = String(Math.round(r.effective));
      r.handle.setAttribute("aria-valuemin", String(r.min));
      r.handle.setAttribute("aria-valuemax", String(Math.min(r.max, r.overlay || group.spec.overlay ? available - fixed - 16 : r.effective + budget)));
      r.handle.setAttribute("aria-valuenow", String(Math.round(r.effective)));
      if (r.toggle) {
        r.toggle.setAttribute("aria-expanded", String(r.open));
        r.toggle.textContent = r.open ? "›" : "‹";
        r.toggle.title = `${r.open ? "收起" : "展开"}${r.name}`;
        r.toggle.setAttribute("aria-label", `${r.open ? "收起" : "展开"}${r.name}`);
      }
    });
      if (group.spec.overlay) return;
    if (getComputedStyle(group.root).display === "grid" || group.spec.fixed) {
      const columns = [];
      Array.from(group.root.children).forEach(child => {
        if (child === group.controls) return;
        const r = group.records.find(x => x.pane === child);
        if (r) columns.push(r.open && !r.overlay ? r.effective + "px" : "0px");
        else if (child === group.center || /main|article|term/.test(child.className)) columns.push("minmax(0,1fr)");
        else if (/rail/.test(child.className)) columns.push(fixed + "px");
        else if (!child.classList.contains("pane-controls")) columns.push("minmax(0,1fr)");
      });
      group.root.style.setProperty("grid-template-columns", columns.join(" "), "important");
    }
  }
  const groups = [];
  function refresh() { groups.forEach(refreshGroup); }
  function afterRender() {
    stop();
    if (observer) observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    groups.length = 0; records.clear();
    specs.forEach(spec => document.querySelectorAll(spec.root).forEach(root => {
      const found = spec.panes.map(p => ({ p, pane: root.querySelector(p[0]) })).filter(x => x.pane && x.pane.parentElement === root);
      if (!found.length) return;
      root.classList.add("pane-container");
      root.querySelectorAll(":scope > .pane-controls").forEach(x => x.remove());
      const controls = document.createElement("div"); controls.className = "pane-controls"; root.appendChild(controls);
      const group = { spec, root, center: spec.center ? root.querySelector(spec.center) : null, records: [], controls };
      found.forEach(({ p, pane }) => {
        pane.querySelectorAll(":scope > .pane-handle, :scope > .ai-resize").forEach(x => x.remove());
        const [, name, side, initial, min, max] = p;
        const record = { key: scope(spec.root, name), name, side, default: initial, min, max, pane, effective: initial, group };
        pane.classList.add("resizable-pane"); pane.dataset.paneSide = side;
        handleFor(record); if (!spec.overlay) addToggle(group, record); group.records.push(record); records.set(record.key, record);
      });
      groups.push(group);
    }));
    refresh();
    observer = new ResizeObserver(() => { if (frame) cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = 0; refresh(); }); });
    groups.forEach(group => observer.observe(group.root));
  }
  window.addEventListener("resize", refresh);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("blur", stop);
  window.PaneResize = { afterRender, refresh, widths, records };
  afterRender();
})();
