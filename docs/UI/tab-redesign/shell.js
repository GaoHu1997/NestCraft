/* UI-CR050 候选稿渲染：四版页签条共用同一外壳与样例数据。
   仅设计资源；不联网、不读写正式存储、不接真实业务。 */
(function () {
  "use strict";

  const Q = new URLSearchParams(location.search);
  const PLAN = ["a", "b", "c", "d", "e"].includes(Q.get("plan")) ? Q.get("plan") : "a";
  const THEME = Q.get("theme") === "dark" ? "dark" : "light";
  const FIGURE = Q.get("figure") === "1";
  const TOTAL = Math.max(1, Math.min(9, parseInt(Q.get("tabs") || "1", 10) || 1));
  const OPEN = Math.max(0, Math.min(TOTAL - 1, parseInt(Q.get("open") || "0", 10) || 0));
  const POP = Q.get("pop") === "1";

  const PLANS = {
    a: { name: "方案 A", title: "细线页签", note: "保留现有位置，只换样式：34px、白底、下划线选中，去掉灰条与白块。" },
    b: { name: "方案 B", title: "按需出现", note: "首页不占条；打开对象后页签条才出现在内容区顶部，返回首页即消失。" },
    c: { name: "方案 C", title: "工作区胶囊栏", note: "页签条移入内容区，44px 白底，首页与对象统一为胶囊，右侧留工具区。" },
    d: { name: "方案 D", title: "窗口切换器", note: "删除页签条；顶栏面包屑即切换器，窗口收进右上角下拉。" },
    e: { name: "方案 E", title: "按需胶囊（推荐组合）", note: "取 B 的出现时机 + C 的胶囊形态：首页无条，打开对象后出现 40px 胶囊条。" }
  };

  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/>',
    folder: '<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.5l2 2H19a2 2 0 0 1 2 2v8.8A2.2 2.2 0 0 1 18.8 20H5.2A2.2 2.2 0 0 1 3 17.8z"/>',
    book: '<path d="M4 19.2A2.2 2.2 0 0 1 6.2 17H20"/><path d="M6.2 2H20v20H6.2A2.2 2.2 0 0 1 4 19.8V4.2A2.2 2.2 0 0 1 6.2 2z"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2 12h2M20 12h2M4.5 19.5 6 18M18 6l1.5-1.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    sparkles: '<path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8z"/><path d="M18.5 15.5 19.2 17l1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'
  };
  const ico = (n, cls) => `<svg class="ico ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ICONS.fileText}</svg>`;

  const WINDOWS = [
    { type: "project", name: "预约服务", sub: "feature/booking-idempotency", tone: "blue", key: "BO" },
    { type: "project", name: "运维控制台", sub: "main", tone: "teal", key: "OP" },
    { type: "project", name: "市场研究资料", sub: "工作区", tone: "amber", key: "RE" },
    { type: "project", name: "品牌与官网", sub: "design/brand-v2", tone: "violet", key: "BR" },
    { type: "library", name: "研发手册", sub: "7 篇文档", tone: "blue", key: "研" },
    { type: "library", name: "运维手册", sub: "15 篇文档", tone: "teal", key: "运" },
    { type: "server", name: "预约服务 · 测试", sub: "ops@192.0.2.24", tone: "amber", key: "SR" },
    { type: "server", name: "构建机 · CI", sub: "ci@203.0.113.51", tone: "violet", key: "CI" }
  ];
  const tabList = () => WINDOWS.slice(0, Math.max(0, TOTAL - 1));
  const activeWin = () => (OPEN > 0 ? WINDOWS[OPEN - 1] : null);
  const winIcon = w => (w.type === "project" ? "folder" : w.type === "library" ? "book" : "server");

  /* ---------------- 外壳 ---------------- */
  function topbar() {
    const win = activeWin();
    const crumb = win ? win.name : "工作台";
    const switchable = PLAN === "d";
    let context;
    if (!switchable) {
      context = `<div class="top-context"><span class="chip-workspace">${ico("grid", "ico-14")}个人工作台</span><span class="muted">/</span><span class="ellipsis">${esc(crumb)}</span></div>`;
    } else if (!win) {
      context = `<div class="top-context"><span class="chip-workspace">${ico("grid", "ico-14")}个人工作台</span><span class="muted">/</span><span class="ellipsis">工作台</span></div>`;
    } else {
      context = `<div class="top-context"><span class="chip-workspace">${ico("grid", "ico-14")}个人工作台</span><span class="muted">/</span>
        <button class="win-crumb" data-act="open" data-open="0" title="回到首页">首页</button><span class="muted">/</span>
        <button class="win-switch" data-act="pop" data-pop="win" aria-haspopup="true" aria-expanded="${POP ? "true" : "false"}">
          ${ico(winIcon(win), "ico-14")}<b class="ellipsis">${esc(win.name)}</b>${ico("chevronDown", "ico-12")}
        </button></div>`;
    }
    const winCount = TOTAL > 1
      ? `<button class="win-count ${win ? "on" : ""}" data-act="pop" data-pop="win" title="已打开的窗口">
           ${ico("layers", "ico-14")}<span class="badge">${TOTAL}</span></button>`
      : "";
    return `<header class="topbar">
      <div class="brand"><span class="brand-mark"><img src="../brand-assets-v2/logo-sail.png" alt=""></span>
        <span class="brand-copy"><b>栖造</b><span>NESTCRAFT</span></span></div>
      <span class="top-sep"></span>
      ${context}
      <div class="top-spacer"></div>
      <div class="top-actions">
        ${switchable ? winCount : ""}
        <button class="update-badge">更新</button>
        <button class="icon-btn" data-act="theme" title="切换主题">${ico(THEME === "dark" ? "sun" : "moon")}</button>
        <button class="icon-btn" title="通知">${ico("bell")}</button>
        <button class="avatar" title="林澈">LC</button>
      </div>
    </header>`;
  }

  function sidebar() {
    const item = (page, icon, label, count, on) =>
      `<button class="nav-item ${on ? "active" : ""}">${ico(icon)}<span>${label}</span>${count != null ? `<span class="count">${count}</span>` : ""}</button>`;
    return `<aside class="sidebar">
      <div class="nav-group">
        <div class="nav-label">工作空间</div>
        ${item("workbench", "home", "工作台", null, true)}
        ${item("projects", "folder", "项目管理", 4, false)}
        ${item("knowledge", "book", "知识库", 3, false)}
        ${item("servers", "server", "服务器管理", 3, false)}
      </div>
      <div class="nav-group">
        <div class="nav-label">当前项目</div>
        <button class="side-project"><span class="p-avatar tone-blue">BO</span>
          <span class="p-meta"><b>预约服务</b><span>feature/booking-idempotency</span></span></button>
      </div>
      <div class="nav-group">
        <div class="nav-label">快捷入口</div>
        ${item("tasks", "play", "运行队列", 6, false)}
        ${item("design", "layers", "设计资料", null, false)}
      </div>
      <div class="side-foot">
        <button class="side-user"><span class="avatar teal">LC</span>
          <span class="u-meta"><b>林澈</b><span>研发负责人 · 设置与账户</span></span>
          <span class="u-gear">${ico("settings", "ico-14")}</span></button>
      </div>
    </aside>`;
  }

  const RUNS = [
    ["时段容量与库存校验", "RUN-2095 · STORY-0102", "blue", "运行中", "58%"],
    ["容量扣减加事务边界", "RUN-2096 · STORY-0102", "blue", "运行中", "72%"],
    ["并发失败用例", "RUN-2097 · STORY-0102", "violet", "验证中", "90%"],
    ["差异与凭证审查", "RUN-2098 · STORY-0102", "amber", "等待依赖", "0%"],
    ["时段容量与库存校验（单层派发）", "RUN-2087 · STORY-0102", "blue", "运行中", "64%"]
  ];
  const TODOS = [
    ["STORY", "幂等下单与重复请求", "STORY-0103 · 预约服务", "待验收", "amber"],
    ["FEATURE", "通知与提醒", "FEAT-012 · 预约服务", "阻塞", "red"],
    ["STORY", "预约成功站内信", "STORY-0201 · 预约服务", "阻塞", "red"],
    ["STORY", "导出预约明细", "STORY-0302 · 预约服务", "待同步", "gray"],
    ["STORY", "高风险命令逐次审批", "STORY-1104 · 运维控制台", "阻塞", "red"]
  ];
  const runIcon = i => `<span class="r-ico" style="background:${["#fdeeee", "#e6f7f3", "#fff6e6", "#eef3ff"][i % 4]};color:${["#d93b3b", "#0f9f8f", "#b76a00", "#2b6cf6"][i % 4]}">${ico("sparkles", "ico-14")}</span>`;

  function homeContent() {
    return `<div class="page">
      <div class="page-h">
        <div><h1 class="page-title">工作台</h1><p class="page-sub">今天需要处理什么、哪些运行还在跑，都集中在这里。</p></div>
        <button class="btn">全部项目</button>
      </div>
      <div class="stats">
        ${[["运行中", "6", "个", "play"], ["等待依赖", "2", "个", "clock"], ["已完成需求", "12", "条", "fileText"], ["待我处理", "6", "项", "bell"]]
          .map(([k, v, u, i]) => `<div class="stat"><div class="k">${ico(i, "ico-14")}${k}</div><div class="v"><b>${v}</b><span>${u}</span></div></div>`).join("")}
      </div>
      <div class="cols">
        <div class="card">
          <div class="card-h"><h3>活动运行<span class="sub">8 条</span></h3><button class="ghost">查看全部</button></div>
          ${RUNS.map(([t, m, c, s, p], i) => `<div class="row">${runIcon(i)}<span class="r-main"><b>${t}</b><span>${m}</span></span><span class="status ${c}">${s}</span><span class="pct">${p}</span></div>`).join("")}
        </div>
        <div class="card">
          <div class="card-h"><h3>待我处理<span class="sub">6 项</span></h3><button class="ghost">查看全部</button></div>
          ${TODOS.map(([k, t, m, s, c]) => `<div class="row"><span class="kind ${k === "STORY" ? "story" : ""}"><i></i>${k}</span><span class="r-main"><b>${t}</b><span>${m}</span></span><span class="tag ${c}">${s}</span></div>`).join("")}
        </div>
      </div>
    </div>`;
  }

  const TREE = [
    ["EPIC-02", "预约与容量管理", "史诗", "3 项"],
    ["FEAT-012", "通知与提醒", "特性", "4 项"],
    ["STORY-0102", "时段容量与库存校验", "用户故事", "设计中"],
    ["STORY-0103", "幂等下单与重复请求", "用户故事", "验证中"],
    ["STORY-0201", "预约成功站内信", "用户故事", "待确认"]
  ];
  function objectContent(win) {
    return `<div class="page ws-page">
      <div class="ws-tabs">
        <button class="ws-tab on">需求</button><button class="ws-tab">设计</button><button class="ws-tab">任务</button><button class="ws-tab">编码</button>
      </div>
      <div class="ws-bar"><div class="search">${ico("search", "ico-14")}<input placeholder="搜索需求、编号或负责人"></div>
        <button class="btn">${ico("plus", "ico-14")}新建</button></div>
      <div class="tree">
        ${TREE.map(([id, t, k, m], i) => `<div class="tree-row ${i === 2 ? "sel" : ""}">
          <span class="kind ${k === "史诗" ? "epic" : k === "用户故事" ? "story" : ""}"><i></i>${k === "用户故事" ? "STORY" : k === "特性" ? "FEATURE" : "EPIC"}</span>
          <span class="id">${id}</span><b>${t}</b><span class="meta">${m}</span></div>`).join("")}
      </div>
    </div>`;
  }

  /* ---------------- 页签条 ---------------- */
  const tabName = w => w.name;
  const arrange = (homeLabel, closeFor, cls, withSep) => {
    const tabs = tabList();
    const parts = [];
    parts.push(`<button class="tab home ${OPEN === 0 ? "on" : ""} ${cls}" data-act="open" data-open="0" title="${homeLabel}">
      ${ico("home", "ico-14")}<span class="tab-name">${homeLabel}</span></button>`);
    if (tabs.length) parts.push(`<span class="tab-sep"></span>`);
    tabs.forEach((w, i) => {
      parts.push(`<button class="tab ${OPEN === i + 1 ? "on" : ""}" data-act="open" data-open="${i + 1}" title="${esc(tabName(w))} · ${esc(w.sub)}">
        ${ico(winIcon(w), "ico-14")}<span class="tab-name">${esc(tabName(w))}</span>
        ${closeFor ? `<span class="w-close" data-act="close" data-open="${i + 1}" role="button" aria-label="关闭 ${esc(tabName(w))}">${ico("x", "ico-12")}</span>` : ""}
      </button>`);
    });
    return parts.join("");
  };
  const moreBtn = `<button class="tab-more" data-act="pop" data-pop="tabs" aria-haspopup="true" aria-expanded="${POP ? "true" : "false"}" title="全部页签">${ico("more")}</button>`;
  const showMore = TOTAL >= 9;

  function tabbarA() {
    const tail = TOTAL === 1 ? `<span class="tab-tail">打开对象后在此切换</span>` : "";
    return `<nav class="tabbar" aria-label="首页与打开的对象">${arrange("首页", true, "", false)}${tail}${showMore ? moreBtn : ""}</nav>`;
  }
  function tabbarB() {
    if (TOTAL === 1) return "";
    return `<nav class="tabbar" aria-label="已打开的窗口">${arrange("首页", true, "", false)}${showMore ? moreBtn : ""}</nav>`;
  }
  function tabbarC() {
    const tools = TOTAL === 1
      ? `<span class="hint">打开对象后在此切换</span>`
      : `<button class="tool-btn" data-act="pop" data-pop="tabs" aria-haspopup="true" aria-expanded="${POP ? "true" : "false"}">${ico("layers", "ico-12")}全部窗口<span class="tool-n">${TOTAL}</span></button>`;
    return `<nav class="tabbar" aria-label="工作区页签">
      ${arrange("首页", true, "", true)}
      <div class="tab-tools">${tools}</div>
    </nav>`;
  }

  function tabbarE() {
    if (TOTAL === 1) return "";
    return `<nav class="tabbar" aria-label="工作区页签">
      ${arrange("首页", true, "", true)}
      <div class="tab-tools"><button class="tool-btn" data-act="pop" data-pop="tabs" aria-haspopup="true" aria-expanded="${POP ? "true" : "false"}">${ico("layers", "ico-12")}全部窗口<span class="tool-n">${TOTAL}</span></button></div>
    </nav>`;
  }

  /* ---------------- 弹层 ---------------- */
  function popHtml() {
    if (!POP) return "";
    if (Q.get("poptype") === "tabs" || !Q.get("poptype")) {
      const items = [`<button class="pop-item ${OPEN === 0 ? "on" : ""}" data-act="open" data-open="0">${ico("home", "ico-14")}<span class="ellipsis">首页 · 工作台</span></button>`]
        .concat(WINDOWS.map((w, i) => `<button class="pop-item ${OPEN === i + 1 ? "on" : ""}" data-act="open" data-open="${i + 1}">${ico(winIcon(w), "ico-14")}<span class="ellipsis">${esc(w.name)}</span><span class="k">${esc(w.sub)}</span></button>`));
      return `<div class="pop" id="pop" role="menu"><div class="pop-h">全部页签 · ${TOTAL} 个</div>${items.join("")}</div>`;
    }
    return "";
  }

  /* ---------------- 组合 ---------------- */
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function figureLabel() {
    if (!FIGURE) return "";
    const state = TOTAL === 1 ? "仅首页（未打开对象）" : OPEN === 0 ? `已打开 ${TOTAL - 1} 个对象 · 当前在首页` : `已打开 ${TOTAL - 1} 个对象 · 当前在「${WINDOWS[OPEN - 1].name}」`;
    return `<div class="figure-label"><span>${PLANS[PLAN].name}｜${PLANS[PLAN].title}　·　${state}</span><span class="fl-note">1440 × 396 · 设计稿，非软件截图</span></div>`;
  }

  function demoPanel() {
    if (FIGURE) return "";
    const link = (p) => `<a href="?plan=${p}&tabs=${TOTAL}&open=${Math.min(OPEN, TOTAL - 1)}&theme=${THEME}" class="${PLAN === p ? "on" : ""}">${p.toUpperCase()}</a>`;
    const stateBtn = (n, label) => `<button data-state="${n}" class="${TOTAL === n ? "on" : ""}">${label}</button>`;
    return `<div class="demo-panel">
      <span class="dp-name">${PLANS[PLAN].name} · ${PLANS[PLAN].title}</span>
      <span class="dp-sep"></span>${["a", "b", "c", "d", "e"].map(link).join("")}
      <span class="dp-sep"></span>${stateBtn(1, "仅首页")}${stateBtn(2, "+1 对象")}${stateBtn(5, "+4 对象")}${stateBtn(9, "溢出")}
      <span class="dp-sep"></span><button data-theme="${THEME === "dark" ? "light" : "dark"}">${THEME === "dark" ? "浅色" : "深色"}</button>
      <span class="dp-hint">← → 切换方案</span>
    </div>`;
  }

  function render() {
    document.documentElement.setAttribute("data-theme", THEME);
    document.body.classList.toggle("figure", FIGURE);
    const plan = PLAN;
    const win = activeWin();
    const hideSidebar = win && plan !== "a";
    const tabbar = plan === "a" ? tabbarA()
      : plan === "b" ? (hideSidebar || TOTAL > 1 ? tabbarB() : "")
      : plan === "c" ? tabbarC()
      : plan === "e" ? tabbarE() : "";
    const content = win ? objectContent(win) : homeContent();
    const topTabbar = plan === "a" ? tabbar : "";
    const innerTabbar = plan === "a" ? "" : tabbar;
    document.getElementById("app").innerHTML = figureLabel() +
      `<div class="app" data-plan="${plan}">${topbar()}${topTabbar}
        <div class="body">
          ${plan === "a" || !hideSidebar ? sidebar() : ""}
          <div class="main">${innerTabbar}<div class="content">${content}</div></div>
        </div>
      </div>` + popHtml() + demoPanel();
    positionPop();
  }

  function positionPop() {
    const pop = document.getElementById("pop");
    if (!pop) return;
    const anchor = document.querySelector('[data-act="pop"][aria-expanded="true"], .tab-more');
    const r = anchor ? anchor.getBoundingClientRect() : { left: 20, bottom: 80, right: 120 };
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + "px";
    pop.style.top = (r.bottom + 6) + "px";
  }

  function go(params) {
    const next = new URLSearchParams(location.search);
    Object.entries(params).forEach(([k, v]) => next.set(k, v));
    location.search = next.toString();
  }

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-act], [data-state], [data-theme]");
    if (!t) {
      if (!e.target.closest(".pop") && POP) go({ pop: "0" });
      return;
    }
    if (t.dataset.state) { go({ tabs: t.dataset.state, open: "0", pop: "0" }); return; }
    if (t.dataset.theme) { go({ theme: t.dataset.theme }); return; }
    const act = t.dataset.act;
    if (act === "theme") { go({ theme: THEME === "dark" ? "light" : "dark" }); return; }
    if (act === "open") { go({ open: t.dataset.open, pop: "0" }); return; }
    if (act === "close") {
      e.stopPropagation();
      const n = parseInt(t.dataset.open, 10);
      go({ tabs: Math.max(1, TOTAL - 1), open: OPEN >= n ? Math.max(0, OPEN - 1) : OPEN, pop: "0" });
      return;
    }
    if (act === "pop") {
      e.stopPropagation();
      const isOpen = t.getAttribute("aria-expanded") === "true";
      go({ pop: isOpen ? "0" : "1" });
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const order = ["a", "b", "c", "d", "e"];
    const i = order.indexOf(PLAN) + (e.key === "ArrowRight" ? 1 : -1);
    if (i >= 0 && i < order.length) location.search = `?plan=${order[i]}&tabs=${TOTAL}&open=${OPEN}&theme=${THEME}`;
  });

  render();
})();
