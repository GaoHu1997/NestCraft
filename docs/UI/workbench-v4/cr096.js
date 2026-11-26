/* UI-CR096-v1（设计稿）：AI 会话字号与聊天区视觉校正——轮次概览浮框。
   仅设计原型，不改正式软件。R1/R3/R4/R5 由 cr096.css 承担；本文件补齐 R2：
   现有原型没有“右侧每轮概览”，这里新增可查看、可点击、可滚动的轮次刻度条与浮框卡片。

   约束：
   - 纯前端演示：只读当前会话 messages 派生轮次，不写业务数据、不触发发送；
   - 浮框内容为「第 N 轮」＋摘要两行，摘要来自该轮用户输入（真实夹具文本，不造数）；
   - UI-SCROLL-001：刻度条容器原生 overflow-y:auto，静止透明；滚动时由共享
     scrollbar.js 加 .scrollbar-active，本文件不切换宽度/display 来隐藏；
   - 指针事件只在刻度按钮自身，容器其余区域放行，避免遮挡消息正文操作。

   挂载策略：原型每次 UI.render 会重建 DOM 子树，直接包装 UI.render 不稳定；
   改用 MutationObserver 观察会话滚动容器，DOM 变更后按需重建刻度条而不是常驻重排。 */
window.CR096 = (function () {
  "use strict";
  const { store } = UI;
  const SCROLL_SELECTOR = "#ai-scroll, #wb-scroll";

  function esc(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  /* 从当前会话消息派生轮次：以用户消息为一轮起点，助手消息并入最近一轮。 */
  function turns(scroll) {
    if (scroll) {
      const rows = Array.from(scroll.querySelectorAll(".msg.user"));
      if (rows.length) {
        return rows.map((row, i) => {
          const raw = (row.querySelector(".msg-user-block")?.textContent || "").replace(/\s+/g, " ").trim();
          return { id: "t" + i, n: i + 1, label: raw || "（无文字消息）" };
        });
      }
      return [];
    }
    const session = window.AIPanel && AIPanel.activeSession ? AIPanel.activeSession() : null;
    const msgs = (session && Array.isArray(session.messages)) ? session.messages : (store.aiMessages || []);
    const list = [];
    msgs.forEach(m => {
      if (m.role === "user") {
        const text = String(m.text || "").replace(/\s+/g, " ").trim();
        list.push({ id: "t" + list.length, n: list.length + 1, label: text || "（无文字消息）" });
      }
    });
    return list;
  }

  function itemHtml(t, active) {
    return `<button type="button" class="c96-turnnav-item${active ? " is-active" : ""}" data-c96-turn="${t.id}" aria-label="第 ${t.n} 轮：${esc(t.label)}"${active ? ' aria-current="true"' : ""}>`
      + `<span class="c96-turnnav-tick" aria-hidden="true"></span>`
      + `<span class="c96-turnnav-label" role="tooltip"><span class="c96-turnnav-idx">第 ${t.n} 轮</span><span class="c96-turnnav-summary">${esc(t.label)}</span></span>`
      + `</button>`;
  }

  /* 浮框定位：容器是 overflow:auto 的窄条会裁切浮框，故浮框用 fixed；
     这里按刻度按钮的真实屏幕坐标算位置，并做左右/上下视口回落，避免出屏。
     注意：浮框默认 opacity/visibility 隐藏，直接量尺寸在首帧可能拿到 0，
     所以量宽高前先临时置为可布局状态，量完还原，再写坐标。 */
  function placeLabel(item) {
    const label = item.querySelector(".c96-turnnav-label");
    if (!label) return;
    const prevOpacity = label.style.opacity;
    const prevVisibility = label.style.visibility;
    label.style.opacity = "1";
    label.style.visibility = "visible";
    const r = item.getBoundingClientRect();
    const box = label.getBoundingClientRect();
    const w = Math.max(120, Math.round(box.width) || 232);
    const h = Math.max(40, Math.round(box.height) || 60);
    const gap = 10;
    // 优先贴刻度左侧；左侧空间不足时改到右侧，再不行就夹到视口内。
    // 刻度按钮 r.right 是它的右边缘，浮框要完全落在其左侧。
    let left = r.left - w - gap;
    if (left < 8) {
      const rightSide = r.right + gap;
      left = rightSide + w <= window.innerWidth - 8 ? rightSide : Math.max(8, window.innerWidth - w - 8);
    }
    // 垂直以刻度中线对齐，并限制在视口内。
    let top = r.top + r.height / 2 - h / 2;
    top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - h - 8)));
    label.style.left = Math.round(left) + "px";
    label.style.top = Math.round(top) + "px";
    label.style.opacity = prevOpacity;
    label.style.visibility = prevVisibility;
  }

  /* 滚动时高亮当前所在轮次（只读视觉反馈，不改滚动位置）。 */
  function bindActive(nav, scroll) {
    const update = () => {
      const rows = Array.from(scroll.querySelectorAll(".msg.user"));
      if (!rows.length) return;
      const top = scroll.getBoundingClientRect().top;
      let current = 0;
      rows.forEach((row, i) => { if (row.getBoundingClientRect().top - top <= 48) current = i; });
      nav.querySelectorAll(".c96-turnnav-item").forEach((item, i) => {
        const on = i === current;
        item.classList.toggle("is-active", on);
        if (on) item.setAttribute("aria-current", "true"); else item.removeAttribute("aria-current");
      });
    };
    update();
    if (!scroll.__cr096Scroll) {
      scroll.addEventListener("scroll", () => {
        const owner = scroll.parentElement?.querySelector(".c96-turnnav");
        if (owner) update();
      }, { passive: true });
      scroll.__cr096Scroll = true;
    }
  }

  /* 挂载：消息区有用户轮次时，在滚动容器的定位父级内加刻度条。 */
  function mount() {
    const scroll = document.querySelector(SCROLL_SELECTOR);
    if (!scroll) return;
    const host = scroll.parentElement;
    if (!host) return;
    const list = turns(scroll);
    const existing = host.querySelector(".c96-turnnav");
    if (!list.length) { existing?.remove(); return; }
    if (existing && existing.dataset.count === String(list.length)) return;
    existing?.remove();
    if (window.getComputedStyle(host).position === "static") host.style.position = "relative";
    const nav = document.createElement("nav");
    nav.className = "c96-turnnav";
    nav.dataset.count = String(list.length);
    nav.setAttribute("aria-label", "回合导航");
    nav.innerHTML = list.map((t, i) => itemHtml(t, i === list.length - 1)).join("");
    host.appendChild(nav);
    nav.addEventListener("click", event => {
      const btn = event.target.closest("[data-c96-turn]");
      if (!btn) return;
      const rows = Array.from(scroll.querySelectorAll(".msg.user"));
      const target = rows[Number(btn.dataset.c96Turn.replace("t", ""))];
      if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      nav.querySelectorAll(".c96-turnnav-item").forEach(item => item.classList.toggle("is-active", item === btn));
    });
    // 浮框 fixed 定位：悬停/聚焦时按真实坐标摆放，避免被窄滚动条容器裁切。
    nav.querySelectorAll(".c96-turnnav-item").forEach(item => {
      const place = () => placeLabel(item);
      item.addEventListener("mouseenter", place);
      item.addEventListener("focus", place);
    });
    bindActive(nav, scroll);
  }

  /* 观察整个 app：任何 render 后子树重建都会触发一次轻量挂载判断。 */
  function observe() {
    const root = document.getElementById("app") || document.body;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        try { mount(); } catch (error) { console.warn("[CR-096] 轮次概览挂载失败", error); }
      });
    };
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe, { once: true });
  else observe();

  return { turns, mount };
})();
