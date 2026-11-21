/* UI-CR052：页签条溢出统一规则。
   规则：页签条一律不出现横向滚动条；放不下时在末尾显示「更多」图标，点击后悬浮下拉列出全部页签。
   现有页签条：对象窗口 .tabbar、项目页签 .ws-tabs、需求内部文档 .req-tabs、办公打开文件 .office-open-tabs。
   仅设计资源，不接真实业务；页签选中/关闭仍走原有 data-act。 */
(function () {
  "use strict";
  const { icon, esc } = UI;
  const BARS = [
    { sel: ".tabbar", kind: "window", tab: ":scope > .wtab" },
    { sel: ".ws-tabs", kind: "project", tab: ":scope > .ws-tab", wrap: "ws-tab-scroll" },
    { sel: ".req-tabs", kind: "requirement", tab: ":scope > .req-tab" },
    { sel: ".office-open-tabs", kind: "office", tab: ":scope > .office-open-tab" }
  ];
  const confOf = bar => BARS.find(b => bar.matches(b.sel));

  /* 页签区宿主：项目页签条尾部有固定 AI 入口，需要把页签包进独立容器。 */
  function hostOf(bar, conf) {
    if (!conf.wrap) return bar;
    let host = bar.querySelector(":scope > ." + conf.wrap);
    if (!host) {
      host = document.createElement("div");
      host.className = conf.wrap;
      const tabs = [...bar.querySelectorAll(conf.tab)];
      if (!tabs.length) return bar;
      tabs[0].before(host);
      tabs.forEach(t => host.appendChild(t));
    }
    return host;
  }

  const tabsOf = (host, conf) => [...host.querySelectorAll(conf.tab)];

  function info(conf, el) {
    if (conf.kind === "window") {
      const btn = el.querySelector(".wtab-focus");
      return { label: btn?.querySelector(".ellipsis")?.textContent || btn?.textContent || "", on: el.classList.contains("active") };
    }
    if (conf.kind === "requirement") {
      const btn = el.querySelector("button[role=tab]");
      return {
        key: btn?.querySelector(".req-tab-key")?.textContent || "",
        label: btn?.querySelector(".req-tab-title")?.textContent || "",
        on: el.classList.contains("on")
      };
    }
    if (conf.kind === "office") {
      return { label: el.querySelector("button")?.textContent?.replace(/●/g, "").trim() || "", on: el.classList.contains("selected") };
    }
    return { label: el.textContent || "", on: el.getAttribute("aria-selected") === "true" };
  }

  function activate(conf, el) {
    const btn = conf.kind === "window" ? el.querySelector(".wtab-focus") : el.querySelector("button");
    btn?.click();
  }

  /* 内联 SVG：不依赖 icon-sprite 外部引用，file:// 与 http 下都能渲染。 */
  const MORE_ICON = '<svg class="ico ico-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function ensureMore(host) {
    let more = host.querySelector(":scope > .tab-more");
    if (!more) {
      more = document.createElement("button");
      more.className = "tab-more";
      more.type = "button";
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-label", "显示全部页签");
      more.innerHTML = MORE_ICON;
      host.appendChild(more);
    }
    return more;
  }

  /* 放不下时保留尽可能多的页签，选中页签优先：其余收进下拉。 */
  function layout(bar) {
    const conf = confOf(bar);
    if (!conf) return;
    bar.classList.add("tab-bar-overflow");
    const host = hostOf(bar, conf);
    host.classList.add("tab-bar-overflow");
    if (host !== bar) host.classList.add("tab-host-overflow");
    const tabs = tabsOf(host, conf);
    const more = ensureMore(host);
    if (!tabs.length) { more.style.display = "none"; return; }

    tabs.forEach(t => { t.hidden = false; });
    more.style.display = "none";
    bar.classList.remove("is-overflow");

    const avail = host.clientWidth;
    const widths = tabs.map(t => t.offsetWidth);
    const total = widths.reduce((s, w) => s + w, 0);
    if (total <= avail) return;

    more.style.display = "grid";
    bar.classList.add("is-overflow");
    const usable = Math.max(0, avail - 26);
    const active = tabs.findIndex(t => info(conf, t).on);
    const keep = new Set();
    let used = 0;
    if (active >= 0 && widths[active] <= usable) { keep.add(active); used += widths[active]; }
    for (let i = 0; i < tabs.length; i++) {
      if (keep.has(i)) continue;
      if (used + widths[i] > usable) break;
      keep.add(i); used += widths[i];
    }
    tabs.forEach((t, i) => { t.hidden = !keep.has(i); });
    const hidden = tabs.length - keep.size;
    more.dataset.hiddenCount = String(hidden);
    more.setAttribute("aria-label", hidden ? `显示全部页签（另有 ${hidden} 个）` : "显示全部页签");
  }

  let pop = null, popTabs = [], popConf = null;

  function closePop() {
    if (pop) pop.remove();
    pop = null; popTabs = []; popConf = null;
    document.querySelectorAll(".tab-more[aria-expanded=true]").forEach(b => b.setAttribute("aria-expanded", "false"));
  }

  function openPop(bar, more) {
    closePop();
    const conf = confOf(bar);
    const tabs = tabsOf(hostOf(bar, conf), conf);
    if (!tabs.length) return;
    const div = document.createElement("div");
    div.className = "tab-more-pop";
    div.id = "tab-more-pop";
    div.setAttribute("role", "menu");
    div.innerHTML = `<div class="tab-more-pop-h">共 ${tabs.length} 个页签</div>` + tabs.map((t, i) => {
      const it = info(conf, t);
      return `<button class="tab-more-item ${it.on ? "on" : ""}" role="menuitem" data-index="${i}">
        ${it.key ? `<span class="tab-more-key">${esc(it.key)}</span>` : ""}
        <span class="ellipsis">${esc(it.label)}</span>
      </button>`;
    }).join("");
    document.body.appendChild(div);
    const r = more.getBoundingClientRect();
    const w = div.offsetWidth, h = div.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    div.style.left = left + "px";
    div.style.top = top + "px";
    pop = div; popTabs = tabs; popConf = conf;
    more.setAttribute("aria-expanded", "true");
  }

  function syncAll() {
    document.querySelectorAll(".tabbar, .ws-tabs, .req-tabs, .office-open-tabs").forEach(bar => {
      if (confOf(bar)) layout(bar);
    });
  }

  document.addEventListener("click", e => {
    const more = e.target.closest(".tab-more");
    if (more) {
      const bar = more.closest(".tabbar, .ws-tabs, .req-tabs, .office-open-tabs");
      if (more.getAttribute("aria-expanded") === "true") closePop();
      else if (bar) openPop(bar, more);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    const pick = e.target.closest(".tab-more-item");
    if (pick) {
      const tabs = popTabs, conf = popConf, target = tabs[Number(pick.dataset.index)];
      closePop();
      if (target) activate(conf, target);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (pop && !e.target.closest(".tab-more-pop")) closePop();
  }, true);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && pop) { closePop(); e.stopPropagation(); }
  }, true);

  window.addEventListener("resize", () => { closePop(); syncAll(); });

  function afterRender() {
    syncAll();
    requestAnimationFrame(syncAll);
  }

  const pane = window.PaneResize;
  if (pane && typeof pane.afterRender === "function") {
    const original = pane.afterRender;
    pane.afterRender = function () { original.apply(this, arguments); afterRender(); };
  }
  window.addEventListener("load", afterRender);
  setTimeout(afterRender, 0);
  window.TabOverflow = Object.freeze({ version: "UI-CR052-v1", afterRender, syncAll });
  afterRender();
})();
