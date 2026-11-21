/* UI-CR050 方案 E：全部窗口下拉。
   切换与关闭仍走原有 data-act（switch-window / close-window），本文件只负责浮层。
   仅设计资源；不联网、不写正式存储。 */
(function () {
  "use strict";
  const { icon, esc } = UI;
  let pop = null;

  function close() {
    if (pop) pop.remove();
    pop = null;
    document.querySelectorAll('.tabbar-all[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
  }

  function open(btn) {
    close();
    const bar = btn.closest(".tabbar");
    if (!bar) return;
    const tabs = [...bar.querySelectorAll(".wtab")];
    const host = document.getElementById("app") || document.body;
    const div = document.createElement("div");
    div.className = "tabs-menu";
    div.setAttribute("role", "menu");
    div.innerHTML = `<div class="tabs-menu-h">全部窗口 · ${tabs.length}</div>` + tabs.map((t, i) => {
      const label = t.querySelector(".wtab-focus .ellipsis")?.textContent || "";
      const on = t.classList.contains("active");
      return `<button class="tabs-menu-item ${on ? "on" : ""}" role="menuitem" data-index="${i}">
        ${on ? icon("check", "ico-14") : `<span class="tabs-menu-dot" aria-hidden="true"></span>`}
        <span class="ellipsis">${esc(label)}</span>
      </button>`;
    }).join("");
    host.appendChild(div);

    const r = btn.getBoundingClientRect();
    const w = div.offsetWidth, h = div.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    div.style.left = left + "px";
    div.style.top = top + "px";
    btn.setAttribute("aria-expanded", "true");
    pop = div;
  }

  document.addEventListener("click", e => {
    const btn = e.target.closest(".tabbar-all");
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      if (pop) close(); else open(btn);
      return;
    }
    const item = e.target.closest(".tabs-menu-item");
    if (item) {
      e.preventDefault(); e.stopPropagation();
      const bar = document.querySelector(".tabbar");
      const target = bar && bar.querySelectorAll(".wtab")[Number(item.dataset.index)];
      close();
      target?.querySelector(".wtab-focus")?.click();
      return;
    }
    if (pop && !e.target.closest(".tabs-menu")) close();
  }, true);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && pop) {
      close();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener("resize", close);

  window.WindowTabs = Object.freeze({ close });
})();