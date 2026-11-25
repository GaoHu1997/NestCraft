/* CR-045 · 仅设计：button rect 锚定；main.js 后加载，不替换原 action handler。 */
(function () {
  "use strict";
  if (!window.AIPanel || window.AIAnchors) return;
  const { store, D } = UI;
  const kinds = { "ai-cli": "cli", "ai-permission": "perm", "ai-model": "model" };
  const configActions = new Set([...Object.keys(kinds), "ai-cli-set", "ai-perm-set", "ai-model-provider", "ai-model-set", "ai-level"]);
  const busy = () => Boolean(store.aiBusy || store.aiRuntimeBusy);
  /* 锚点查找：默认在 AI 侧栏内。CR-054 工作台借用同一套浮层时，其按钮带 data-wb-anchor，
     且此时 AI 面板处于借用态（不可见），因此优先命中工作台里可见的按钮，浮层才贴到用户点的位置。 */
  const anchor = kind => {
    const wb = document.querySelector(`.wb-composer [data-wb-anchor="${kind}"]`);
    if (wb && wb.getClientRects().length) return wb;
    return document.querySelector(`:is(.ai-panel, .wb-conv) [data-ai-anchor="${kind}"]`);
  };
  const popup = () => document.querySelector(":is(.ai-panel, .wb-conv) [data-ai-popup]");
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  let frame = 0, observer = null, transaction = null;

  function viewport() {
    const v = window.visualViewport;
    return { left: (v?.offsetLeft || 0) + 8, top: (v?.offsetTop || 0) + 8,
      right: (v?.offsetLeft || 0) + (v?.width || window.innerWidth) - 8,
      bottom: (v?.offsetTop || 0) + (v?.height || window.innerHeight) - 8 };
  }
  function position() {
    frame = 0;
    const pop = popup(), button = pop && anchor(pop.dataset.aiPopup);
    if (!pop || !button) return;
    const rect = button.getBoundingClientRect(), bounds = viewport();
    if (!rect.width || !rect.height || rect.bottom < bounds.top || rect.top > bounds.bottom || rect.right < bounds.left || rect.left > bounds.right) {
      pop.style.visibility = "hidden";
      return;
    }
    pop.style.visibility = "";
    // 先以真实视口限制宽/高并测量浮层，再按按钮可用上下空间翻转、滚动。
    pop.style.maxWidth = Math.max(1, bounds.right - bounds.left) + "px";
    pop.style.maxHeight = Math.max(1, bounds.bottom - bounds.top) + "px";
    const size = pop.getBoundingClientRect();
    const left = clamp(pop.dataset.aiPopup === "model" ? rect.right - size.width : rect.left,
      bounds.left, bounds.right - size.width);
    const above = Math.max(0, rect.top - 6 - bounds.top), below = Math.max(0, bounds.bottom - rect.bottom - 6);
    const up = size.height <= above || (size.height > below && above >= below);
    pop.style.maxHeight = Math.max(1, up ? above : below) + "px";
    const finalSize = pop.getBoundingClientRect();
    pop.style.left = left + "px";
    pop.style.top = clamp(up ? rect.top - 6 - finalSize.height : rect.bottom + 6,
      bounds.top, bounds.bottom - finalSize.height) + "px";
    pop.dataset.aiPlacement = up ? "top" : "bottom";
    pop.dataset.aiPositioned = "true";
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(position); }

  function locator(el) {
    if (!el) return null;
    if (el.id) return { id: el.id };
    if (el.dataset.aiAnchor) return { kind: el.dataset.aiAnchor };
    if (el.dataset.act) return { act: el.dataset.act, name: el.dataset.name, idValue: el.dataset.id };
    return null;
  }
  function resolve(ref) {
    if (!ref) return null;
    if (ref.kind) return anchor(ref.kind);
    if (ref.id) return document.getElementById(ref.id);
    return Array.from(document.querySelectorAll(":is(.ai-panel, .wb-conv) [data-act]")).find(el =>
      el.dataset.act === ref.act && el.dataset.name === ref.name && el.dataset.id === ref.idValue);
  }
  function focus(el) { if (el && !el.disabled) el.focus({ preventScroll: true }); }
  function finish(tx) {
    if (transaction !== tx) return;
    transaction = null;
    // 外点在 main 执行原目标后才清理 DOM，不 preventDefault、不截断外点传播。
    if (!store.aiPop && popup()) {
      popup().remove();
      document.querySelectorAll(":is(.ai-panel, .wb-conv) [data-ai-anchor]").forEach(el => el.setAttribute("aria-expanded", "false"));
    }
    if (tx.outside) return;
    if (tx.open && store.aiPop === tx.kind) {
      const pop = popup();
      focus(pop?.querySelector("input:not(:disabled), button:not(:disabled)") || pop);
    } else if (tx.restore) focus(anchor(tx.kind));
    else if (tx.ref) focus(resolve(tx.ref));
    schedule();
  }
  function prepare(tx) { transaction = tx; queueMicrotask(() => finish(tx)); }

  document.addEventListener("click", e => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const panel = target.closest(":is(.ai-panel, .wb-conv)"), pop = popup(), previous = pop?.dataset.aiPopup;
    const el = target.closest("[data-act]"), action = el?.dataset.act, kind = kinds[action];
    const close = target.closest("[data-ai-popup-close]");
    if (close && panel) {
      prepare({ kind: close.dataset.aiPopupClose, restore: true });
      store.aiPop = null;
      return;
    }
    // 原 handler 仍唯一负责仿真选值。运行中/失效候选只阻止该已失效控件，不接触真实权限。
    if (panel && configActions.has(action) && (busy() || el.disabled || (kind && anchor(kind)?.disabled))) {
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    if (panel && kind) {
      prepare({ kind, open: store.aiPop !== kind, restore: store.aiPop === kind });
      store.aiTop = null; store.aiHistory = false;
      return;
    }
    if (panel && action === "ai-menu-open") {
      store.aiPop = null; store.aiTop = null; store.aiHistory = false;
    }
    if (!previous) return;
    if (!target.closest("[data-ai-popup]")) {
      prepare({ kind: previous, outside: true });
      store.aiPop = null;
    } else prepare({ kind: previous, restore: action === "ai-cli-set" || action === "ai-perm-set", ref: locator(el || document.activeElement) });
  }, true);

  document.addEventListener("keydown", e => {
    const pop = popup();
    if (!pop || e.key !== "Escape" || document.querySelector("dialog[open]") || store.reqMenu) return;
    // main 的 Escape 保持单一关闭路径；这里只登记随后恢复的真实控件。
    prepare({ kind: pop.dataset.aiPopup, restore: true });
  }, true);
  document.addEventListener("input", e => {
    if (e.target?.closest?.("[data-ai-popup]")) {
      if (busy() && e.target.dataset.act === "ai-level") { e.stopImmediatePropagation(); return; }
      prepare({ ref: locator(e.target) });
    }
  }, true);

  const originalAfterRender = AIPanel.afterRender;
  AIPanel.afterRender = function (...args) {
    originalAfterRender.apply(this, args);
    observer?.disconnect();
    const pop = popup();
    if (pop && (busy() || store.aiMenu || store.aiTop || store.aiHistory)) {
      store.aiPop = null;
      pop.remove();
      document.querySelectorAll(":is(.ai-panel, .wb-conv) [data-ai-anchor]").forEach(el => el.setAttribute("aria-expanded", "false"));
    }
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      document.querySelectorAll(":is(.ai-panel, .wb-conv), :is(.ai-panel, .wb-conv) [data-ai-anchor], :is(.ai-panel, .wb-conv) [data-ai-popup], :is(.ai-panel, .wb-conv) .model-grid").forEach(el => observer.observe(el));
    }
    position();
  };
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  window.addEventListener("pagehide", () => { observer?.disconnect(); if (frame) cancelAnimationFrame(frame); });
  window.addEventListener("pageshow", () => AIPanel.afterRender());
  window.AIAnchors = { reposition: schedule, anchor };
  AIPanel.afterRender();
})();
