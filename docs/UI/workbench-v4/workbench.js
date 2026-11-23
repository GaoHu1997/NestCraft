/* CR-054 / UI-CR054-v1：项目会话中心工作台（原型同步稿）。
   目的：把独立评审稿的设计落到唯一业务原型，用真实原型数据验证三栏与右栏预览。
   约束：
   - 不新建会话数据源：左栏直接读 D.ai.sessions 与 store.aiSession，证明“项目级共享、不隔离”；
   - 不改既有 AI 侧栏：工作台页签显示工作台自己的三栏，其他页签保持现状；
   - 只读预览：右栏不写入文件、不触发编辑与保存；
   - 不访问网络、不读写磁盘；全部为合成样例。
   挂载方式：包装 Screens.project / Office.renderPage，仅追加“工作台”页签入口，不重写已有视图。 */
window.WorkbenchUI = (function () {
  "use strict";
  const { D, esc, icon, store, toast } = UI;
  const AI = () => window.AIPanel || {};

  /* ---------- 页签定义 ---------- */
  const TABS = {
    code: [["workbench", "工作台"], ["requirements", "需求"], ["design", "设计"], ["tasks", "任务"], ["code", "编码"]],
    work: [["workbench", "工作台"], ["code", "文档"], ["design", "成果"]],
  };
  const HIST_PAGE = 20;

  /* 会话归属：按项目类型取各自的真实会话源。
     编码项目 = D.ai.sessions；办公项目 = OfficeAI 的项目级会话（OFFICE-*）。
     两者都是“该项目唯一的一套会话”，工作台不新建第二套数据源。 */
  function isOfficeProject() { const p = project(); return !!p && p.kind === "work"; }
  function sessions() {
    if (isOfficeProject()) {
      const list = window.OfficeAI && OfficeAI.sessionsOf ? OfficeAI.sessionsOf() : [];
      if (list.length) return list;
    }
    return (D.ai && D.ai.sessions) || [];
  }
  function currentId() {
    if (isOfficeProject() && window.OfficeAI && OfficeAI.currentSessionId) {
      const id = OfficeAI.currentSessionId();
      if (id) return id;
    }
    return store.aiSession || (sessions()[0] && sessions()[0].id);
  }
  function currentSession() { return sessions().find(s => s.id === currentId()) || null; }

  const markDot = kind => `<span class="wb-dot ${kind}" aria-hidden="true"></span>`;

  /* ---------- 右栏预览目标（从真实原型数据派生，不另造样例） ---------- */
  function project() {
    const win = UI.activeWindow && UI.activeWindow();
    const id = (win && win.kind === "project" && win.refId) || store.projectId;
    return (D.projects || []).find(p => p.id === id) || (D.projects || [])[0] || null;
  }

  function codeTargets() {
    const files = Object.keys(D.files || {});
    return files.slice(0, 8).map(f => ({ key: "file:" + f, kind: "file", title: f.split("/").pop(), path: f, meta: [fileMetaOf(f)] }));
  }
  function fileMetaOf(f) {
    const line = String(D.files[f] || "").split("\n").length;
    return `约 ${line} 行`;
  }
  function reqTargets() {
    const all = (D.requirements || []).filter(r => r.kind === "story");
    /* 优先纳入会话中实际出现过的实体，避免只取前 N 条时漏掉可点击目标。 */
    const mentioned = new Set();
    (sessions() || []).forEach(s => (s.messages || []).forEach(m => {
      String(m.text || "").replace(/\b(STORY|FEAT|EPIC|VISION|BUG)-\d{3,4}\b/g, x => mentioned.add(x));
    }));
    const hit = all.filter(r => mentioned.has(r.id));
    const rest = all.filter(r => !mentioned.has(r.id));
    return hit.concat(rest).slice(0, 14).map(r => ({ key: "req:" + r.id, kind: "req", title: `${r.id}：${r.title}`, path: r.id, meta: [r.status === "completed" ? "已完成" : "进行中"], entity: r }));
  }
  function kbTargets() {
    const libs = (D.knowledge && D.knowledge.libraries) || [];
    return libs.slice(0, 4).map(l => ({ key: "kb:" + l.id, kind: "kb", title: l.name, path: `知识库 / ${l.name}`, meta: ["只读", "已授权样例"] }));
  }
  function officeTargets() {
    if (!window.Office || !project()) return [];
    try {
      const st = Office.getView(project().id);
      const p = Office.model.getProject(project().id);
      return (p.files || []).slice(0, 8).map(f => ({ key: "office:" + f.id, kind: "office", title: f.name, path: `${project().name} / ${f.name}`, meta: [(f.type || "").toUpperCase(), "只读预览"], file: f }));
    } catch { return []; }
  }

  function allTargets() {
    const isWork = project() && project().kind === "work";
    return isWork
      ? [].concat(officeTargets(), kbTargets())
      : [].concat(codeTargets(), reqTargets(), kbTargets());
  }
  function targetByKey(key) { return allTargets().find(t => t.key === key) || null; }

  function groups() {
    const isWork = project() && project().kind === "work";
    return isWork
      ? [["成果与文件", officeTargets()], ["知识", kbTargets()]]
      : [["文件", codeTargets()], ["需求", reqTargets()], ["知识", kbTargets()]];
  }

  /* ---------- 右栏状态（仅原型内存） ---------- */
  function aux() {
    if (!store.wbAux || store.wbAux.project !== (project() && project().id)) {
      store.wbAux = { project: project() && project().id, tabs: [], active: null, open: false };
    }
    return store.wbAux;
  }
  function auxOpen(key) {
    const a = aux();
    if (!a.tabs.includes(key)) a.tabs.push(key);
    a.active = key;
    a.open = true;
  }

  /* ---------- 三栏渲染 ---------- */
  /* ---------- 左：会话历史 ----------
     与 AI 侧栏历史浮层（ai.js historyRail / CR-063 分批 / CR-065 状态标识）保持同一套结构与类名：
     .ai-session / .ai-hist-mark|dot|spin / .s-main / .ai-hist-more。
     不复制样式，直接复用 ai.css + cr063.css + cr065.css。 */
  function markOf(s) {
    if ((D.ai.runningIds || []).includes(s.id)) return "running";
    if (s.id === currentId()) return "none";
    if (s.status === "success") return "unread-success";
    if (s.status === "failed") return "unread-failed";
    if (s.status === "pending") return "unread-pending";
    return "none";
  }

  function histMark(s) {
    const m = markOf(s);
    if (m === "running") return `<span class="ai-hist-spin" role="status" aria-label="运行中" title="运行中"></span>`;
    if (m === "none") return `<span class="ai-hist-mark" aria-hidden="true"></span>`;
    const cls = m === "unread-success" ? "good" : m === "unread-failed" ? "bad" : "warn";
    const label = m === "unread-success" ? "未读 · 成功" : m === "unread-failed" ? "未读 · 失败" : "待处理";
    return `<span class="ai-hist-dot dot-${cls}" role="img" aria-label="${label}" title="${label}"></span>`;
  }

  function historyRail() {
    const list = sessions();
    const kw = String(store.wbHistQuery || "").trim().toLowerCase();
    /* 置顶优先；其余保持数组顺序（与 ai.js historyRail 口径一致） */
    const ordered = [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const matched = kw ? ordered.filter(s => String(s.title || "").toLowerCase().includes(kw)) : ordered;
    const limit = Math.max(HIST_PAGE, Number(store.wbHistLimit) || HIST_PAGE);
    const shown = matched.slice(0, limit);
    const hasMore = shown.length < matched.length;
    const cur = list.find(s => s.id === currentId());
    const pinned = !kw && cur && !shown.some(s => s.id === cur.id) ? cur : null;

    const row = (s, extra = "") => {
      const isCur = s.id === currentId();
      return `<div class="ai-session ${isCur ? "active" : ""}${extra ? " pinned-row" : ""}" role="button" tabindex="0" data-act="wb-session" data-id="${esc(s.id)}" aria-current="${isCur}">
        ${histMark(s)}<span class="s-main">
          <b class="ellipsis">${s.pinned ? icon("arrowUp", "ico-12 ai-hist-pin-ico") : ""}${esc(s.title || "未命名会话")}</b>
          <span>${esc(s.updated || "")}${s.tokens && s.tokens !== "—" ? " · " + esc(s.tokens) : ""}${s.duration && s.duration !== "—" ? " · " + esc(s.duration) : ""}</span>
        </span></div>`;
    };

    const empty = kw
      ? `<div class="ai-hist-empty">没有匹配的会话<button class="link-btn" data-act="wb-hist-reset">清除搜索</button></div>`
      : `<div class="ai-hist-empty">暂无历史会话</div>`;
    const tail = hasMore
      ? `<button class="ai-hist-more" data-act="wb-hist-more">继续加载 · 还剩 ${matched.length - shown.length} 条</button>`
      : `<div class="ai-hist-end">已到全部</div>`;

    const body = `${pinned ? row(pinned, true) : ""}${shown.map(s => row(s)).join("")}${shown.length ? tail : ""}${!shown.length && !pinned ? empty : ""}`;

    return `<aside class="wb-hist ai-history" aria-label="会话历史">
      <div class="ai-history-h">
        <span class="ah-title">${icon("history", "ico-14")}<b>会话历史</b><span class="caption" title="已加载 / 全部">${shown.length} / ${matched.length}</span></span>
        <button class="icon-btn" data-act="wb-new" title="新会话" aria-label="新会话">${icon("plus", "ico-14")}</button>
      </div>
      <div class="ai-history-search">
        <span class="ahs-ico">${icon("search", "ico-14")}</span>
        <input id="wb-hist-q" type="search" autocomplete="off" value="${esc(store.wbHistQuery || "")}" placeholder="搜索本项目会话标题" aria-label="搜索本项目会话标题">
        <button class="ahs-all" data-act="wb-hist-reset"${kw ? "" : " disabled"} title="${kw ? "清空搜索" : "当前没有搜索词"}">重置</button>
      </div>
      <div class="ai-history-list">${body}</div>
    </aside>`;
  }

  /* 执行步骤：复用 AI 侧栏 StepsBox 的结构与类名（ai.js stepsBlock / ai.css .ai-steps） */
  function stepsOf(s) {
    const steps = (s && s.steps) || [];
    if (!steps.length) return "";
    const done = steps.filter(x => x.state === "done").length;
    const running = steps.some(x => x.state === "running");
    const failed = steps.some(x => x.state === "failed");
    const allDone = done === steps.length;
    const state = running ? "进行中" : failed ? "有失败" : allDone ? "已完成" : "等待继续";
    const open = store.wbStepsOpen !== false;
    return `<section class="ai-steps ${open ? "open" : "collapsed"}" aria-label="执行步骤">
      <button class="steps-h" data-act="wb-steps-toggle" aria-expanded="${open}">
        ${icon("steps", "ico-14")}<b>执行步骤</b><span class="steps-count">${done}/${steps.length}</span>
        <span class="steps-state ${running ? "run" : failed ? "fail" : allDone ? "done" : ""}">${state}</span>
        <span class="spacer"></span><span class="steps-chev">${icon("chevronDown", "ico-14")}</span>
      </button>
      ${open ? `<div class="steps-list">${steps.map(st => `<div class="ai-step ${st.state}">
        <span class="ai-step-ico">${st.state === "done" ? icon("check", "ico-13") : st.state === "running" ? '<span class="ai-step-spin" aria-hidden="true"></span>' : st.state === "failed" ? icon("alert", "ico-13") : icon("clock", "ico-13")}</span>
        <span class="ai-step-title">${esc(st.title)}</span>
        <span class="ai-step-meta">${esc(st.state === "done" ? "已完成" + (st.meta ? " · " + st.meta : "") : st.state === "running" ? "执行中" : st.state === "failed" ? "失败" + (st.meta ? " · " + st.meta : "") : "未开始")}</span>
      </div>`).join("")}</div>` : ""}
    </section>`;
  }

  /* 消息：复用 AI 侧栏的 .msg 结构与类名（样式全部来自 ai.css）。 */
  /* ---------- 消息里的可点击目标 ----------
     把工具条路径、回复正文里的实体/文件路径转成可点击引用，点击后在右栏定位。
     只转换能命中已知目标的内容，不做全文正则猜测，避免把普通文本误变成链接。 */
  function linkify(text) {
    let html = UI.md(text || "").replace(/^<p>|<\/p>$/g, "");
    const keys = allTargets().map(t => t.key);
    /* 先处理文件/成果路径（更长、更具体），再做实体 ID，
       否则 docs/Plan/Story/STORY-0102.md 会被实体规则先切碎。 */
    for (const t of allTargets()) {
      if (t.kind !== "file" && t.kind !== "office") continue;
      const p = t.path || "";
      if (!p || p.length < 4) continue;
      const safe = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(new RegExp(`(?<![\\w/.-])${safe}(?![\\w/.-])`, "g"),
        `<button class="wb-link" data-act="wb-open" data-key="${esc(t.key)}">${esc(p)}</button>`);
      /* 文件名单独出现时也允许定位（如 STORY-0102.md 未带目录） */
      const base = p.split("/").pop();
      if (base && base !== p && base.length >= 6) {
        const safeBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(`(?<![\\w/.-])${safeBase}(?![\\w/.-])`, "g"),
          `<button class="wb-link" data-act="wb-open" data-key="${esc(t.key)}">${esc(base)}</button>`);
      }
    }
    /* 再处理裸实体 ID（STORY-0102 / EPIC-002 / FEAT-014……） */
    html = html.replace(/\b(STORY|FEAT|EPIC|VISION|BUG)-\d{3,4}\b/g, m => {
      const key = "req:" + m;
      return keys.includes(key) ? `<button class="wb-link" data-act="wb-open" data-key="${esc(key)}">${m}</button>` : m;
    });
    return html;
  }

  /* 会话标题里的实体 ID 也可点击定位（标题常写 STORY-0102 这类目标） */
  function linkifyTitle(text) {
    const keys = allTargets().map(t => t.key);
    return esc(text || "").replace(/\b(STORY|FEAT|EPIC|VISION|BUG)-\d{3,4}\b/g, m =>
      keys.includes("req:" + m)
        ? `<button class="wb-link" data-act="wb-open" data-key="req:${esc(m)}">${esc(m)}</button>`
        : m);
  }

  function messages(s) {
    const msgs = (s && s.messages) || [];
    if (!msgs.length) {
      return `<div class="wb-chat-empty"><b>这条会话还没有消息</b><span>在下方输入即可开始；不会自动新建会话。</span></div>`;
    }
    /* 结构与类名对齐 AI 侧栏 message()：.msg(.user/.assistant) + .msg-body + .msg-time +
       .msg-user-block / .text + .tool，不加「我 / AI」角色前缀（CR-056）。 */
    return msgs.map(m => {
      if (m.role === "user") {
        return `<div class="msg user"><div class="msg-body"><div class="msg-time">${esc(m.time || "")}</div>
          <div class="msg-user-block">${esc(m.text)}</div></div></div>`;
      }
      const tools = (m.tools || []).map(t => {
        const hit = allTargets().find(x => (x.kind === "file" || x.kind === "office") && (t.arg === x.path || (t.arg || "").endsWith(x.path)));
        const arg = hit
          ? `<button class="wb-link" data-act="wb-open" data-key="${esc(hit.key)}">${esc(t.arg)}</button>`
          : esc(t.arg);
        return `<div class="tool">
          <span class="t-ico">${icon(t.name === "fs.read" ? "file" : t.name === "fs.write" ? "edit" : t.name === "code-search" ? "search" : "terminal", "ico-14")}</span>
          <span class="t-main"><span class="t-head"><span class="t-name">${esc(t.name)}</span><span class="t-state ${t.state === "完成" ? "done" : "run"}">${esc(t.state)}</span></span>
            <div class="t-arg">${arg}</div>${t.detail ? `<div class="t-detail">${esc(t.detail)}</div>` : ""}</span></div>`;
      }).join("");
      return `<div class="msg assistant"><div class="msg-body"><div class="msg-time">${esc(m.time || "")}</div>
        <div class="text">${linkify(m.text)}</div>${tools}
        <div class="msg-acts"><button class="msg-act">${icon("copy", "ico-12")}复制</button></div>
      </div></div>`;
    }).join("");
  }

  /* ---------- 输入区：完整复用 AI 侧栏结构 ----------
     + 添加 / CLI / 权限 / 模型 四个 chip、发送按钮与统计行，全部沿用
     ai.js 的 .ai-composer / .ai-tools / .ai-chip / .ai-send / .ai-stats 类名与尺寸，
     不另造一套外观。统计行沿用 statsRow 的三项（会话轮次/Token/上下文）。 */
  function composerBlock() {
    const runtimeBusy = () => Boolean(store.aiBusy || store.aiRuntimeBusy);
    const usableCli = c => Boolean(c.installed && c.enabled !== false && c.available !== false);
    const usableModel = m => m.on !== false && m.enabled !== false && m.available !== false;
    const cli = (D.settings.clis || []).find(c => c.id === store.aiCli) || { id: "", name: "未配置 CLI" };
    const cm = (AI().currentModel && AI().currentModel()) || { name: "未配置", thinking: false };
    const busy = runtimeBusy();
    const cliDisabled = busy || !(D.settings.clis || []).some(usableCli);
    const permDisabled = busy || !(D.ai.permissions || []).some(p => p.available !== false && p.enabled !== false);
    const modelDisabled = busy || !(D.ai.modelCatalog.providers || []).some(p => p.enabled !== false && p.available !== false && (AI().visibleModels(p) || []).some(usableModel));
    const running = busy;
    const canStop = running && !String(store.aiInput || "").trim();

    const stats = `<div class="ai-stats">
      <span class="s">${icon("sessionStats", "ico-14")}${esc(String((D.ai.stats && D.ai.stats.rounds) || 0))} 轮 · ${esc((D.ai.stats && D.ai.stats.tps) || "—")}</span>
      <span class="s">${icon("tokenUsage", "ico-14")}${esc((D.ai.stats && D.ai.stats.tokens && D.ai.stats.tokens.total) || "—")} · 命中 ${esc((D.ai.stats && D.ai.stats.tokens && D.ai.stats.tokens.cacheHit) || "—")}</span>
      <span class="s">${icon("contextUsage", "ico-14")}上下文 ${esc((D.ai.stats && D.ai.stats.context && D.ai.stats.context.used) || "—")}</span>
    </div>`;

    return `<div class="ai-composer-wrap wb-composer">
      <div class="ai-composer">
        <textarea id="wb-input" placeholder="描述你想构建的内容，/ 调用指令，@ 文件或对话">${esc(store.aiInput || "")}</textarea>
        <div class="ai-tools">
          <button class="ai-chip icon-only" data-act="wb-menu-open" title="添加" aria-label="添加">${icon("plus")}</button>
          <button class="ai-chip cli" data-act="wb-cli" data-wb-anchor="cli" aria-haspopup="dialog" aria-expanded="false" ${cliDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : cliDisabled ? "没有可用 CLI" : "切换 CLI：" + esc(cli.name)}" aria-label="切换 CLI：${esc(cli.name)}">${AI().cliLogo(cli.id, 16)}</button>
          <button class="ai-chip perm" data-act="wb-perm" data-wb-anchor="perm" aria-haspopup="dialog" aria-expanded="false" ${permDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : "权限模式"}" aria-label="权限模式">${icon("shield")}${esc(store.aiPermission || "默认模式")}</button>
          <button class="ai-chip model" data-act="wb-model" data-wb-anchor="model" aria-haspopup="dialog" aria-expanded="false" ${modelDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : modelDisabled ? "没有可用模型" : "选择模型"}" aria-label="选择模型">${esc(cm.name)} · ${esc(cm.thinking ? D.ai.modelCatalog.current.level : "无思考档位")}</button>
          <button class="ai-send" data-act="wb-send" title="${canStop ? "停止" : "发送"}" aria-label="${canStop ? "停止" : "发送"}">${icon(canStop ? "stop" : "arrowUp", "ico-18")}</button>
        </div>
      </div>
      ${stats}
    </div>`;
  }

  function conversation() {
    const s = currentSession();
    const p = project();
    const isWork = p && p.kind === "work";
    const running = s && (D.ai.runningIds || []).includes(s.id);
    const title = s ? s.title : "新会话";
    const sub = s ? `${p ? p.name : ""} · ${running ? "运行中" : "已完成"}` : `${p ? p.name : ""} · 尚未开始`;
    return `<section class="wb-conv" aria-label="当前会话">
      <div class="wb-ch">
        <button class="icon-btn wb-drawer-btn" data-act="wb-drawer-left" aria-label="会话历史">${icon("panelLeft", "ico-14")}</button>
        <div class="wb-ct"><b>${linkifyTitle(title)}</b><span>${esc(sub)}</span></div>
        <span class="spacer"></span>
        ${running ? `<span class="wb-pill run">${icon("clock", "ico-12")}运行中</span>` : ""}
        <span class="wb-pill" title="工作台与右侧 AI 栏读取同一会话集合">${icon("message", "ico-12")}项目级共享</span>
        <button class="icon-btn ${aux().open ? "on" : ""}" data-act="wb-aux-toggle" aria-label="辅助栏" aria-expanded="${aux().open}">${icon("panelRight", "ico-14")}</button>
      </div>
      <div class="wb-scroll" id="wb-scroll">
        ${messages(s)}
        ${stepsOf(s)}
      </div>
      ${composerBlock()}
    </section>`;
  }

  function previewBody(t) {
    if (!t) return `<div class="wb-empty">目标不存在。</div>`;
    if (t.kind === "file") {
      const text = String(D.files[t.path] || "");
      const lines = text.split("\n").slice(0, 40);
      return `<div class="wb-path">${icon("file", "ico-12")}<span class="ellipsis">${esc(t.path)}</span></div>
        <h3 class="wb-ptitle">${esc(t.title)}</h3>
        <div class="wb-pmeta"><span class="tag">${esc(t.meta[0])}</span><span class="tag">只读</span></div>
        <pre class="wb-code">${lines.map((l, i) => `<span><span class="ln">${i + 1}</span>${esc(l)}</span>`).join("\n")}</pre>`;
    }
    if (t.kind === "req") {
      const r = t.entity || {};
      return `<div class="wb-path">${icon("fileText", "ico-12")}<span class="ellipsis">${esc(t.path)}</span></div>
        <h3 class="wb-ptitle">${esc(t.title)}</h3>
        <div class="wb-pmeta"><span class="tag">${esc(t.meta[0])}</span><span class="tag">只读</span></div>
        <div class="wb-doc">${UI.md(r.body || r.summary || "该需求在原型中只有标题与状态，未提供正文样例。")}</div>`;
    }
    if (t.kind === "kb") {
      return `<div class="wb-path">${icon("database", "ico-12")}<span class="ellipsis">${esc(t.path)}</span></div>
        <h3 class="wb-ptitle">${esc(t.title)}</h3>
        <div class="wb-pmeta">${t.meta.map(m => `<span class="tag">${esc(m)}</span>`).join("")}</div>
        <div class="wb-doc"><p>知识库正文按现有阅读器能力展示；此处在工作台右栏为只读引用入口。</p></div>
        <p class="wb-note">不扩大授权范围，不读取未授权内容。</p>`;
    }
    if (t.kind === "office") {
      const f = t.file || {};
      const c = f.content;
      let body = "";
      if (f.type === "md" && typeof c === "string") body = UI.md(c);
      else if (f.type === "xlsx" && c && c.sheets) body = `<pre class="wb-code">${(c.sheets[0].cells || []).map(r => r.join(" | ")).join("\n")}</pre>`;
      else if (f.type === "docx" && c) body = `<div class="wb-doc"><p>${esc(c.body || c.title || "无正文样例")}</p></div>`;
      else if (c && c.slides) body = `<div class="wb-doc">${c.slides.map((sl, i) => `<p><b>第 ${i + 1} 页</b> ${esc(sl.title)}</p>`).join("")}</div>`;
      else if (c && c.pages) body = `<div class="wb-doc">${c.pages.map(p => `<p>${esc(p)}</p>`).join("")}</div>`;
      else body = `<div class="wb-doc"><p>该格式在原型中不提供正文预览。</p></div>`;
      return `<div class="wb-path">${icon("briefcase", "ico-12")}<span class="ellipsis">${esc(t.path)}</span></div>
        <h3 class="wb-ptitle">${esc(t.title)}</h3>
        <div class="wb-pmeta">${t.meta.map(m => `<span class="tag">${esc(m)}</span>`).join("")}</div>
        ${body}
        <p class="wb-note">只读预览，不修改原件；真实能力以既有查看器为准。</p>`;
    }
    return `<div class="wb-empty">不支持的类型。</div>`;
  }

  function auxPanel() {
    const a = aux();
    const isWork = project() && project().kind === "work";
    const tabs = a.tabs.map(key => {
      const t = targetByKey(key);
      const name = t ? (t.kind === "file" || t.kind === "office" ? t.title : t.title.split("：")[0]) : key;
      return `<button class="wb-atab" role="tab" aria-selected="${key === a.active}" data-act="wb-aux-tab" data-key="${esc(key)}">
        <span>${esc(name)}</span><span class="wb-ax" data-act="wb-aux-close" data-key="${esc(key)}" role="button" aria-label="关闭">✕</span>
      </button>`;
    }).join("");

    let body;
    if (!a.tabs.length) {
      body = `<div class="wb-empty" style="padding:14px 4px 8px"><b>辅助栏</b>点击会话里的文件、需求或成果，会在这里只读预览。<br>不会修改原文件，也不会切换页签。</div>`
        + groups().map(([g, rows]) => `<div class="wb-group" style="padding-left:4px">${esc(g)}</div><div class="wb-src">${rows.map(t => `<button class="wb-srow" data-act="wb-open" data-key="${esc(t.key)}">${icon("fileText", "ico-12")}<span class="wb-fname">${esc(t.title)}</span><span class="wb-smeta">${esc((t.meta || [])[0] || "")}</span></button>`).join("")}</div>`).join("");
    } else {
      body = previewBody(targetByKey(a.active));
    }

    const t = targetByKey(a.active);
    const openIn = t ? (t.kind === "req" ? "在需求中打开" : (t.kind === "office" || t.kind === "kb") ? "在文档中打开" : "在编码中打开") : (isWork ? "在文档中打开" : "在编码中打开");

    return `<aside class="wb-aux" aria-label="辅助栏">
      <div class="wb-ah"><b>辅助栏</b><span class="tag">只读</span><span class="spacer"></span>
        <button class="icon-btn" data-act="wb-aux-clear" aria-label="关闭全部预览">${icon("close", "ico-14")}</button>
      </div>
      ${requestBar()}
      ${a.tabs.length ? `<div class="wb-atabs" role="tablist">${tabs}</div>` : ""}
      <div class="wb-abody">${body}</div>
      <div class="wb-af">
        <button class="btn sm" data-act="wb-open-in" ${t ? "" : "disabled"}>${icon("external", "ico-12")} ${esc(openIn)}</button>
        <span class="spacer"></span><span class="tag">${isWork ? "办公预览" : "代码预览"}</span>
      </div>
    </aside>`;
  }

  /* ---------- 工作台主体 ---------- */
  function render() {
    const a = aux();
    const drawer = window.innerWidth < 960;
    return `<div class="wb-shell${a.open ? "" : " no-aux"}${store.wbDrawer === "left" ? " drawer-left" : ""}${store.wbDrawer === "right" ? " drawer-right" : ""}">
      ${historyRail()}
      ${conversation()}
      ${auxPanel()}
      <div class="wb-backdrop" data-act="wb-drawer-close"></div>
    </div>`;
  }

  /* 页签条：替换项目页签条，加入工作台。
     工作台为纯图标页签（坐在电脑前的小人），不显示文字，靠 aria-label 与 title 提供可读名称。 */
  function tabsHtml(p) {
    const kind = p && p.kind === "work" ? "work" : "code";
    const list = TABS[kind];
    const active = (store.projectTab === "workbench") ? "workbench" : (kind === "work" ? (store.projectTab === "design" ? "design" : "code") : store.projectTab);
    return list.map(([k, label]) => {
      if (k === "workbench") {
        return `<button class="ws-tab ws-tab-icon" role="tab" aria-selected="${active === k}" data-act="project-tab" data-tab="${k}" aria-label="${esc(label)}" title="${esc(label)}">${icon("atDesk", "ico-18")}</button>`;
      }
      return `<button class="ws-tab" role="tab" aria-selected="${active === k}" data-act="project-tab" data-tab="${k}">${label}</button>`;
    }).join("");
  }

  function isWorkbench() { return store.projectTab === "workbench"; }

  /* 工作台是会话视图本身：进入工作台时收起右侧 AI 栏，避免同一会话出现两个实例。
     离开工作台要恢复用户原来的 AI 栏偏好，因此把该偏好单独记在 wbAiBefore。 */
  function syncAiPanel() {
    const onWb = store.projectTab === "workbench";
    if (onWb) {
      if (store.wbAiBefore === undefined) store.wbAiBefore = store.aiOpen;
      store.aiOpen = false;
    } else if (store.wbAiBefore !== undefined) {
      store.aiOpen = store.wbAiBefore;
      store.wbAiBefore = undefined;
    }
    document.body.classList.toggle("wb-active", onWb);
  }

  /* ---------- AI 请求开栏（CR-054 P2 / STORY-073） ----------
     规则：AI 只能“请求”，由前端决定是否执行；用户手动关闭后，同一轮不得自动重开抢焦点。
     请求来源为结构化面板请求，不做文本嗅探。原型用 aiPanelRequest 演示该协议。 */
  const PANEL_KINDS = {
    "ui-preview": { title: "UI 预览", note: "浏览器预览由用户自配工具或后续独立立项提供；此处只呈现请求与结果占位。" },
    "browser": { title: "浏览器", note: "浏览器能力独立立项，不在本稿实现；此面板仅证明请求通道与只读呈现。" },
    "file": { title: "文件", note: "只读预览当前项目文件。" },
    "requirement": { title: "需求", note: "只读预览需求实体。" },
  };

  /* 用户最近一次主动关闭面板的动作记录，用于“关闭后本轮不重开”。 */
  function panelGuard() {
    if (!store.wbPanelGuard) store.wbPanelGuard = { closedAt: 0, turn: null };
    return store.wbPanelGuard;
  }

  /* 返回是否真正打开；被拒绝时给出原因，供 AI 侧得到可读结果。 */
  function requestPanel(req) {
    const guard = panelGuard();
    if (!req || !req.kind) return { ok: false, code: "invalid_request", message: "缺少面板类型" };
    if (!PANEL_KINDS[req.kind]) return { ok: false, code: "unsupported", message: `不支持的面板类型：${req.kind}` };
    /* 用户关闭优先：用户刚主动关闭过，则不自动重开抢焦点。
       运行中按轮次判定；非运行态按 120 秒时间窗判定，避免“关闭后立刻又被 AI 弹开”。 */
    const running = Boolean(store.aiBusy);
    const turnKey = running ? (store.wbTurnId || "current") : null;
    const sameTurn = running ? (guard.turn === turnKey) : (guard.turn === null);
    if (guard.closedAt && sameTurn && Date.now() - guard.closedAt < 120000) {
      return { ok: false, code: "declined_by_user", message: "用户已在本轮关闭该面板，不自动重开" };
    }
    const a = aux();
    if (req.key && targetByKey(req.key)) {
      a.tabs.push(req.key);
      a.active = req.key;
    }
    a.open = true;
    a.request = { kind: req.kind, title: (req.key && targetByKey(req.key)?.title) || PANEL_KINDS[req.kind].title, note: PANEL_KINDS[req.kind].note, at: Date.now() };
    if (window.innerWidth < 960) store.wbDrawer = "right";
    UI.render();
    return { ok: true, code: "opened", message: `已打开${PANEL_KINDS[req.kind].title}面板` };
  }

  /* 右栏顶部的“AI 请求”条：说明是谁请求打开的，用户可随时关闭 */
  function requestBar() {
    const r = aux().request;
    if (!r) return "";
    return `<div class="wb-req" role="status">
        <span class="wb-req-ico">${icon("sparkles", "ico-12")}</span>
        <span class="wb-req-main"><b>AI 请求打开${esc(r.title)}</b><span>${esc(r.note)}</span></span>
        <button class="wb-req-x" data-act="wb-req-dismiss" aria-label="收起 AI 请求面板">✕</button>
      </div>`;
  }

  /* ---------- 挂载 ---------- */
  function attach() {
    if (!window.Screens || !Screens.project) return;

    /* CR-054 决策 2：两类项目新建窗口时默认进入工作台。
       只在“新建窗口”时改默认值，不覆盖用户已经切换过的页签；
       记在 viewStates 上，随窗口快照保存。 */
    if (window.UI && UI.openWindow) {
      const baseOpen = UI.openWindow;
      UI.openWindow = function (kind, refId, title, locate) {
        const existed = store.windows.some(w => w.id === kind + ":" + refId);
        const ret = baseOpen.apply(UI, arguments);
        if (kind === "project" && !existed && !(locate && locate.projectTab)) {
          const w = store.windows.find(x => x.id === "project:" + refId);
          if (w && w.viewStates) {
            w.viewStates.projectTab = "workbench";
            if (store.projectId === refId) store.projectTab = "workbench";
            UI.render();
          }
        }
        return ret;
      };
    }

    const baseProject = Screens.project;
    Screens.project = function (id) {
      const p = (D.projects || []).find(x => x.id === id);
      syncAiPanel();
      /* 工作台页签：自行渲染整页，其余页签完全沿用原实现 */
      if (store.projectTab === "workbench" && p && p.kind !== "work") {
        return `<div class="page ws-page wb-page">
          <div class="ws-tabs" role="tablist" aria-label="项目页签">${tabsHtml(p)}<span class="spacer"></span>
            <span class="wb-share-note" title="会话集合按项目唯一，工作台与其他页签共用">${icon("message", "ico-12")}项目级共享</span>
          </div>
          ${render()}
        </div>`;
      }
      const html = baseProject(id);
      if (!p) return html;
      /* 其他页签：仅把页签条替换为含“工作台”的版本，视图不动 */
      return html.replace(/<div class="ws-tabs"[^>]*>[\s\S]*?<\/div>\s*(?=<)/, m => {
        if (!m.includes('data-act="project-tab"')) return m;
        const icon = `<span class="spacer"></span>`;
        const aiBtn = /<button class="icon-btn ai-toggle-btn[\s\S]*?<\/button>/.exec(m);
        return `<div class="ws-tabs" role="tablist" aria-label="项目页签">${tabsHtml(p)}<span class="spacer"></span>${aiBtn ? aiBtn[0] : ""}</div>`;
      });
    };

    const officeBase = window.Office && Office.renderPage;
    if (officeBase) {
      Office.renderPage = function (project) {
        /* 办公项目的会话由 OfficeAI 按项目切换；先激活，工作台才能读到该项目的真实会话。 */
        if (window.OfficeAI && OfficeAI.activate) {
          try { OfficeAI.activate({ kind: "project", refId: project.id }); } catch { /* 无 AI 时忽略 */ }
        }
        syncAiPanel();
        const html = officeBase.call(Office, project);
        if (store.projectTab !== "workbench") {
          return html.replace(/<div class="ws-tabs"[^>]*aria-label="办公项目页签">[\s\S]*?<span class="spacer"><\/span>/, m => {
            const aiBtn = /<button class="icon-btn ai-toggle-btn[\s\S]*?<\/button>/.exec(m);
            return `<div class="ws-tabs" role="tablist" aria-label="办公项目页签">${tabsHtml(project)}<span class="spacer"></span>${aiBtn ? aiBtn[0] : ""}`;
          });
        }
        return `<div class="page ws-page wb-page" data-project="${esc(project.id)}">
          <div class="ws-tabs" role="tablist" aria-label="办公项目页签">${tabsHtml(project)}<span class="spacer"></span>
            <span class="wb-share-note">${icon("message", "ico-12")}项目级共享</span>
          </div>
          ${render()}
        </div>`;
      };
    }
  }

  /* 借用 AI 侧栏浮层：浮层锚点与弹层都在 .ai-panel 内，故临时让面板可见，
     关闭后由 syncAiPanel 恢复单实例状态。 */
  function withAiAnchor(_kind, mutate) {
    mutate();
    document.body.classList.toggle("wb-borrow-ai", Boolean(store.aiPop || store.aiMenu));
    UI.render();
  }

  /* ---------- 动作 ---------- */
  const ACTIONS = {
    "project-tab": el => {
      store.projectTab = el.dataset.tab;
      if (el.dataset.tab === "workbench") { store.aiOpen = false; }
      UI.render();
    },
    "wb-session": el => {
      if (isOfficeProject() && window.OfficeAI && OfficeAI.switchSession) {
        OfficeAI.switchSession(el.dataset.id);
        return; /* switchSession 内部会 render */
      }
      store.aiSession = el.dataset.id;
      const s = sessions().find(x => x.id === el.dataset.id);
      if (s) store.aiMessages = (s.messages || []).slice();
      store.wbDrawer = null;
      UI.render();
    },
    "wb-new": () => {
      if (isOfficeProject() && window.OfficeAI && OfficeAI.newSession) {
        OfficeAI.newSession();
        return;
      }
      const n = sessions().length + 1;
      const s = { id: "S-WB-" + n, title: "新会话", status: "read", updated: "刚刚", tokens: "—", duration: "—", messages: [], steps: [] };
      D.ai.sessions.unshift(s);
      store.aiSession = s.id;
      store.aiMessages = [];
      store.aiInput = "";
      toast("已新建会话（仅主动新建时创建）");
      UI.render();
    },
    "wb-aux-toggle": () => {
      const a = aux();
      a.open = !a.open;
      if (a.open && !a.active && a.tabs.length) a.active = a.tabs[0];
      if (window.innerWidth < 960) store.wbDrawer = a.open ? "right" : null;
      UI.render();
    },
    "wb-aux-clear": () => {
      const a = aux();
      a.tabs = []; a.active = null; a.open = false; a.request = null;
      /* 用户主动关闭：记录本轮，AI 不得自动重开抢焦点 */
      const g = panelGuard();
      g.closedAt = Date.now();
      g.turn = store.aiBusy ? (store.wbTurnId || "current") : null;
      store.wbDrawer = null; UI.render();
    },
    "wb-req-dismiss": () => {
      const a = aux();
      a.request = null; a.open = false;
      const g = panelGuard();
      g.closedAt = Date.now();
      g.turn = store.aiBusy ? (store.wbTurnId || "current") : null;
      store.wbDrawer = null; UI.render();
    },
    "wb-aux-tab": el => { aux().active = el.dataset.key; UI.render(); },
    "wb-aux-close": el => {
      const a = aux();
      a.tabs = a.tabs.filter(k => k !== el.dataset.key);
      if (a.active === el.dataset.key) a.active = a.tabs[a.tabs.length - 1] || null;
      if (!a.tabs.length) a.open = false;
      UI.render();
    },
    "wb-open": el => { auxOpen(el.dataset.key); if (window.innerWidth < 960) store.wbDrawer = "right"; UI.render(); },
    "wb-open-in": () => {
      const t = targetByKey(aux().active);
      if (!t) return;
      if (t.kind === "req") store.projectTab = "requirements";
      else if (t.kind === "office" || t.kind === "kb") store.projectTab = project() && project().kind === "work" ? "code" : "code";
      else store.projectTab = "code";
      if (t.kind === "file") { store.codeFile = t.path; store.codeRail = "files"; }
      toast("已跳转到对应页签；工作台内只预览不跳转");
      UI.render();
    },
    "wb-drawer-left": () => { store.wbDrawer = store.wbDrawer === "left" ? null : "left"; UI.render(); },
    "wb-drawer-close": () => { store.wbDrawer = null; UI.render(); },
    "wb-hist-more": () => { store.wbHistLimit = Math.max(HIST_PAGE, Number(store.wbHistLimit) || HIST_PAGE) + HIST_PAGE; UI.render(); },
    "wb-hist-reset": () => { store.wbHistQuery = ""; UI.render(); },
    "wb-steps-toggle": () => { store.wbStepsOpen = store.wbStepsOpen === false; UI.render(); },
    "wb-send": () => {
      toast("原型演示：工作台与 AI 侧栏共用会话，发送请使用右侧 AI 栏");
    },
    /* 输入区四个入口：工作台与 AI 侧栏是同一会话，因此直接借用 AI 侧栏的同一套菜单/设置动作，
       避免出现两套不一致的 CLI/权限/模型选择。
       浮层锚点位于 .ai-panel 内，所以这里临时展开 AI 面板承载浮层；关闭后恢复工作台的单实例状态。 */
    "wb-menu-open": () => { withAiAnchor("add", () => { store.aiMenu = store.aiMenu === "add" ? null : "add"; }); },
    "wb-cli": () => withAiAnchor("cli", () => { store.aiPop = store.aiPop === "cli" ? null : "cli"; }),
    "wb-perm": () => withAiAnchor("perm", () => { store.aiPop = store.aiPop === "perm" ? null : "perm"; }),
    "wb-model": () => withAiAnchor("model", () => { store.aiPop = store.aiPop === "model" ? null : "model"; }),
  };

  return { attach, ACTIONS, TABS, isWorkbench, requestPanel, PANEL_KINDS };
})();
