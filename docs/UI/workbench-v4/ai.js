/* AI 侧栏：UI-CR056-v1 当前设计基线。无标题头、可拖拽、历史浮层、@// 菜单、会话目标/任务、CLI/权限/模型、统计、子智能体与后台任务。
   继承 CR-042 的浮层与步骤结构，补齐输入上下文菜单、目标/任务状态、稳定消息身份、CLI/权限能力证据和模型思考档位联动。 */
window.AIPanel = (function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell } = UI;

  const activeSession = () => D.ai.sessions.find(s => s.id === store.aiSession) || D.ai.sessions[0];
  const statusDot = s => s === "success" ? '<span class="sdot green"></span>' : s === "failed" ? '<span class="sdot red"></span>' : s === "pending" ? '<span class="sdot amber"></span>' : '<span class="sdot none"></span>';
  const statusText = s => s === "success" ? "成功" : s === "failed" ? "失败" : s === "pending" ? "待处理" : "已读";

  function message(m, idx, format = text => UI.md(text).replace(/^<p>|<\/p>$/g, "")) {
    if (m.role === "continuity-break") {
      const cli = D.settings.clis.find(item => item.id === m.cli)?.name || m.cli;
      return `<div class="cr037-break" role="note"><b>原生上下文断点</b><span>${esc(cli)} · ${esc(m.previousRef || "原引用缺失")} → ${esc(m.sessionRef)}</span><span>以上聊天记录保留。后续请求从新上下文开始。</span></div>`;
    }
    if (Array.isArray(m.blocks)) {
      const block = b => b.type === "thinking" ? `<details class="msg-think"><summary><span>${b.status === "streaming" ? "思考中…" : "思考"}</span><span class="caption">${esc(String(b.text || "").length)} 字</span></summary><div class="mt-body">${esc(b.text || "")}</div></details>`
        : b.type === "tool" ? `<details class="tool msg-tool-block"><summary><span class="mono">${esc(b.name)}</span><span class="caption">${esc(b.status || "结果未返回")}</span></summary><div class="t-arg">${esc(b.args || "")}</div><pre class="t-detail">${esc(b.result ?? "暂无输出")}</pre></details>`
        : b.type === "text" ? `<div class="text">${format(b.text || "")}</div>` : "";
      return `<div class="msg assistant"><div class="msg-body">${m.blocks.map(block).join("")}<div class="msg-time">${esc(m.time || "")}</div></div></div>`;
    }
    const tools = (m.tools || []).map(t => `<div class="tool">
      <span class="t-ico">${icon(t.name === "fs.read" ? "file" : t.name === "fs.write" ? "edit" : t.name === "code-search" ? "search" : "terminal", "ico-14")}</span>
      <span class="t-main"><span class="t-head"><span class="t-name">${esc(t.name)}</span><span class="t-state ${t.state === "完成" ? "done" : "run"}">${esc(t.state)}</span></span>
        <div class="t-arg">${esc(t.arg)}</div><div class="t-detail">${esc(t.detail)}</div></span></div>`).join("");
    const approval = m.approval ? `<div class="approval"><b>${esc(m.approval.title)}</b><p>${esc(m.approval.detail)}</p>
      <div class="acts"><button class="btn primary" data-act="ai-approve" data-idx="${idx}">允许一次</button><button class="btn" data-act="ai-deny" data-idx="${idx}">拒绝</button><button class="btn ghost" data-act="ai-show-cmd" data-idx="${idx}">查看命令</button></div></div>` : "";
    if (m.role === "user") return `<div class="msg user"><div class="msg-body"><div class="msg-user-block">${esc(m.text)}</div><div class="msg-time">${esc(m.time)}</div></div></div>`;
    return `<div class="msg assistant"><div class="msg-body"><div class="msg-time">${esc(m.time)}</div>
      ${m.thinking ? `<details class="msg-think"><summary><span class="mt-mark">${icon("sparkles", "ico-12")}</span><span>思考</span><span class="mt-meta">${m.thinkMs ? "持续 " + esc(m.thinkMs) : esc(m.thinking.length) + " 字"}</span></summary><div class="mt-body">${esc(m.thinking)}</div></details>` : ""}
      <div class="text">${format(m.text)}</div>${tools}${approval}${window.OfficeAI ? OfficeAI.messageExtra(m) : ""}
      <div class="msg-acts"><button class="msg-act" data-act="ai-copy" data-idx="${idx}">${icon("copy", "ico-12")}复制</button></div></div></div>`;
  }

  /** 运行态：logo 粒子打散重组 + 工作中… + 运行时长（C56-06A） */
  function workingRow() {
    return `<div class="msg assistant working"><div class="msg-body"><div class="msg-working" role="status" aria-live="polite">
      <span class="mw-logo" aria-hidden="true">${cliLogo(store.aiCli, 16)}</span>
      <span class="mw-label">工作中…</span><span class="mw-time" data-act="ai-working-tick">${esc(store.aiWorkElapsed || "0 秒")}</span>
    </div></div></div>`;
  }

  /* ---------------- 历史：覆盖在 AI 侧栏左侧的浮层，不参与布局 ----------------
     CR-063：默认加载最近 20 条，末尾「继续加载」文字按钮追加，支持当前作用域标题搜索。
     CR-064：状态只看左侧标识（运行 spinner / 成功绿点 / 失败红点 / 待处理橘点 / 已读空）；
     选中只用背景色、无边框、不写「当前」；底部显示当前会话 token；搜索旁为「重置」；
     行内「…」菜单：复制会话 ID / 分叉 / 置顶 / 重命名 / 删除。 */
  const HIST_PAGE = 20;
  function sessionMark(s) {
    if ((D.ai.runningIds || []).includes(s.id)) return { kind: "running", label: "运行中" };
    if (s.id === store.aiSession) return { kind: "none", label: "已读" };
    if (s.status === "success") return { kind: "unread-success", label: "未读 · 成功" };
    if (s.status === "failed") return { kind: "unread-failed", label: "未读 · 失败" };
    if (s.status === "pending") return { kind: "unread-pending", label: "待处理" };
    return { kind: "none", label: "已读" };
  }
  function historyRail() {
    const kw = String(store.aiHistQuery || "").trim();
    const lower = kw.toLowerCase();
    // 置顶优先；其余保持数组顺序（正式实现由后端按 pinnedAt DESC, updatedAt DESC 排序）
    const ordered = [...D.ai.sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const matched = lower ? ordered.filter(s => String(s.title || "").toLowerCase().includes(lower)) : ordered;
    const limit = Math.max(HIST_PAGE, Number(store.aiHistLimit) || HIST_PAGE);
    const shown = matched.slice(0, limit);
    const hasMore = shown.length < matched.length;
    const current = D.ai.sessions.find(s => s.id === store.aiSession);
    const pinned = !lower && current && !shown.some(s => s.id === current.id) ? current : null;
    const state = store.aiHistState || "idle";
    const mark = s => {
      const m = sessionMark(s);
      if (m.kind === "running") return `<span class="ai-hist-spin" role="status" aria-label="运行中" title="运行中"></span>`;
      if (m.kind === "none") return `<span class="ai-hist-mark" aria-hidden="true"></span>`;
      const cls = m.kind === "unread-success" ? "good" : m.kind === "unread-failed" ? "bad" : "warn";
      return `<span class="ai-hist-dot dot-${cls}" role="img" aria-label="${esc(m.label)}" title="${esc(m.label)}"></span>`;
    };
    const menu = s => store.aiHistMenu === s.id ? `<div class="ai-hist-menu" role="menu" data-act="ai-hist-menu-noop">
        <button role="menuitem" data-act="ai-hist-copy-id" data-id="${s.id}">${icon("copy", "ico-13")}复制会话 ID</button>
        <button role="menuitem" data-act="ai-hist-fork" data-id="${s.id}"${(D.ai.runningIds || []).includes(s.id) ? ' disabled title="会话运行中，结束或停止后再分叉"' : ""}>${icon("branch", "ico-13")}分叉会话</button>
        <button role="menuitem" data-act="ai-hist-pin" data-id="${s.id}">${icon("arrowUp", "ico-13")}${s.pinned ? "取消置顶" : "置顶"}</button>
        <button role="menuitem" data-act="ai-hist-rename" data-id="${s.id}">${icon("edit", "ico-13")}重命名</button>
        <button role="menuitem" class="danger" data-act="ai-del" data-id="${s.id}">${icon("trash", "ico-13")}删除</button>
      </div>` : "";
    const row = (s, extra = "") => {
      const editing = store.aiHistEditId === s.id;
      const title = editing
        ? `<input id="ai-hist-rename-input" class="ai-hist-rename-input" data-act="ai-hist-edit-noop" value="${esc(store.aiHistEditValue ?? s.title)}" maxlength="200" aria-label="重命名会话标题">`
        : `<b class="ellipsis">${s.pinned ? icon("arrowUp", "ico-12 ai-hist-pin-ico") : ""}${esc(s.title)}</b>`;
      return `<div class="ai-session ${s.id === store.aiSession ? "active" : ""}${extra ? " pinned-row" : ""}${editing ? " editing" : ""}" role="button" tabindex="0" data-act="ai-switch" data-id="${s.id}" aria-current="${s.id === store.aiSession ? "true" : "false"}">
        ${mark(s)}<span class="s-main">${title}<span>${esc(s.updated)} · ${esc(s.tokens)} · ${esc(s.duration)}</span>${s.sessionRole === "executor" && s.featureId ? `<span class="ai-hist-scope" title="执行特性：${esc(s.featureTitle || s.featureId)}">单特性 · ${esc(s.featureId)}</span>` : ""}</span><span class="ai-hist-menu-wrap"><button class="ai-hist-more-btn" data-act="ai-hist-menu" data-id="${s.id}" title="更多操作" aria-label="更多操作：${esc(s.title)}" aria-haspopup="menu" aria-expanded="${store.aiHistMenu === s.id}">${icon("more", "ico-14")}</button>${menu(s)}</span></div>`;
    };
    const empty = lower
      ? `<div class="ai-hist-empty">没有匹配的会话<button class="link-btn" data-act="ai-history-all">清除搜索</button></div>`
      : `<div class="ai-hist-empty">暂无历史会话</div>`;
    const tail = state === "more"
      ? `<div class="ai-hist-more loading" role="status" aria-live="polite">加载中…</div>`
      : hasMore
        ? `<button class="ai-hist-more" data-act="ai-history-more">继续加载 · 还剩 ${matched.length - shown.length} 条</button>`
        : `<div class="ai-hist-end">已到全部</div>`;
    const errorRow = state === "error"
      ? `<div class="ai-hist-error" role="alert">加载失败，已加载内容保留<button class="link-btn" data-act="ai-history-retry">重试</button></div>`
      : "";
    const loadingFirst = state === "first" ? `<div class="ai-hist-loading" role="status" aria-live="polite">加载中…</div>` : "";
    const searching = state === "search" ? `<div class="ai-hist-loading" role="status" aria-live="polite">搜索中…</div>` : "";
    const body = state === "first"
      ? loadingFirst
      : `${errorRow}${searching}${pinned ? row(pinned, true) : ""}${shown.map(s => row(s)).join("")}${shown.length ? tail : ""}${!shown.length && !pinned && state !== "search" && state !== "error" ? empty : ""}`;
    return `<aside class="ai-history" data-ai-overlay="history" data-pane="ai-history" data-pane-default="296" data-pane-min="240" data-pane-max="420" role="dialog" aria-label="会话历史">
      <div class="ai-history-h"><span class="ah-title">${icon("history", "ico-14")}<b>会话历史</b><span class="caption" title="已加载 / 全部">${state === "first" ? "…" : `${shown.length} / ${matched.length}`}</span></span><button class="icon-btn" data-act="ai-history-close" aria-label="关闭会话历史">${icon("x", "ico-14")}</button></div>
      <div class="ai-history-search"><span class="ahs-ico">${icon("search", "ico-14")}</span><input id="ai-history-q" type="search" autocomplete="off" value="${esc(store.aiHistQuery || "")}" placeholder="搜索本项目会话标题" aria-label="搜索本项目会话标题"><button class="ahs-all" data-act="ai-history-all"${lower ? "" : " disabled"} title="${lower ? "清空搜索并重新查询" : "当前没有搜索词"}" aria-label="清空搜索并重新查询">重置</button></div>
      <div class="ai-history-list">${body}</div>
    </aside>`;
  }

  /* ---------------- 顶部下拉：子智能体 / 后台任务 ---------------- */
  function agentDrop() {
    return `<div class="ai-drop ai-drop-agents" role="dialog" aria-label="子智能体">
      <div class="drop-h"><b>子智能体</b><span class="caption">${D.ai.subagents.length} 个 · 仅本会话</span></div>
      <div class="drop-list">${D.ai.subagents.length ? D.ai.subagents.map(a => `<div class="agent-row" role="button" tabindex="0" data-act="ai-agent-open" data-agent-id="${esc(a.id)}" title="查看子智能体：${esc(a.title)}" aria-label="查看子智能体 ${esc(a.title)}，只读">
        ${cliLogo(a.cli, 24)}<span class="ar-main"><b class="ellipsis">${esc(a.title)}</b><span>${esc(a.model)} · ${esc(a.duration)} · ${esc(a.tokens)}</span></span>
        <span class="tag ${a.status === "失败" ? "red" : a.status === "待确认" ? "amber" : "green"}">${esc(a.status)}</span>
        ${window.CR037?.agentLink(a) || ""}<span class="ar-open">${icon("chevronRight", "ico-12")}</span></div>`).join("") : '<div class="drop-empty">本会话没有子智能体。</div>'}</div>
      <div class="drop-f">合成演示 · 点击行查看只读详情；记录仅本次运行可见</div>
    </div>`;
  }

  function backgroundDrop() {
    const running = D.ai.background.filter(b => b.state === "运行中");
    const ended = D.ai.background.filter(b => b.state !== "运行中");
    const row = b => `<div class="bg-row ${store.aiBgOpen === b.jobId ? "open" : ""}" data-id="${esc(b.jobId)}">
      <button class="bg-head" data-act="ai-bg-toggle" data-id="${esc(b.jobId)}" aria-expanded="${store.aiBgOpen === b.jobId}">
        <span class="bg-dot ${b.state === "运行中" ? "run" : String(b.exit) === "0" ? "ok" : "fail"}"></span>
        <span class="bg-main"><b class="mono ellipsis">${esc(b.cmd)}</b><span>${esc(b.state)} · 退出码 ${esc(b.exit)} · ${esc(b.duration)}</span></span>
        <span class="chev">${icon("chevronDown", "ico-13")}</span>
      </button>
      ${store.aiBgOpen === b.jobId ? `<div class="bg-detail"><span class="caption">jobId ${esc(b.jobId)} · 本机命令记录（演示）</span><pre class="mono">${esc(b.output || "暂无输出")}</pre></div>` : ""}
    </div>`;
    return `<div class="ai-drop ai-drop-bg" role="dialog" aria-label="后台任务">
      <div class="drop-h"><b>后台任务</b><span class="caption">仅本会话 · 关闭页面即停止</span></div>
      <div class="drop-list">
        <div class="bg-group"><div class="bg-group-h"><span>进行中 ${running.length}</span></div>${running.length ? running.map(row).join("") : '<div class="drop-empty">没有进行中的命令。</div>'}</div>
        <div class="bg-group"><div class="bg-group-h"><span>已结束 ${ended.length}</span><button class="link-btn" data-act="bg-clear" ${ended.length ? "" : "disabled"}>清空已结束</button></div>${ended.length ? ended.map(row).join("") : '<div class="drop-empty">没有已结束的记录。</div>'}</div>
      </div>
      <div class="drop-f">只清展示，不终止任务 · 不写入项目验收</div>
    </div>`;
  }

  function aiTopPop() {
    if (store.aiTop === "agents") return agentDrop();
    if (store.aiTop === "bg") return backgroundDrop();
    return "";
  }

  /* ---------------- 输入菜单 ---------------- */
  function menuItems() {
    const q = (store.aiMenuQuery || "").toLowerCase();
    const officeRefs = window.OfficeAI && OfficeAI.referenceItems();
    if (officeRefs && (store.aiMenu === "at" || (store.aiMenu === "add" && store.aiMenuTab === "at"))) return officeRefs.filter(x => !q || (x.name + x.meta).toLowerCase().includes(q));
    const files = Object.keys(D.files).map(f => ({ icon: "fileText", name: f, meta: "项目文件", insert: "@" + f }));
    const docs = Object.values(D.knowledge.docs).flat().map(d => ({ icon: "book", name: d.title, meta: "知识库 · " + d.path, insert: "@" + d.title }));
    const conv = D.ai.sessions.map(s => ({ icon: "message", name: s.title, meta: "对话", insert: "@" + s.title }));
    const skills = D.settings.skills.map(s => ({ icon: "layers", name: s.name, meta: "Skill · /" + s.slug, insert: "/" + s.slug }));
    const mcps = D.settings.mcp.map(m => ({ icon: "box", name: m.name, meta: "MCP · " + m.transport, insert: "/" + m.name }));
    const tools = D.settings.tools.map(t => ({ icon: "zap", name: t.name, meta: "Tool · " + t.risk + "风险", insert: "/" + t.name }));
    if (store.aiMenu === "at" || (store.aiMenu === "add" && store.aiMenuTab === "at")) return [...files, ...conv, ...docs, ...skills, ...mcps, ...tools].filter(x => !q || (x.name + x.meta).toLowerCase().includes(q));
    if (store.aiMenu === "slash") return [...skills, ...mcps, ...tools].filter(x => !q || (x.name + x.meta).toLowerCase().includes(q));
    return [];
  }

  function menuHtml() {
    const at = store.aiMenu === "at";
    const slash = store.aiMenu === "slash";
    const items = menuItems();
    return `<div class="ai-menu" id="ai-menu">
      ${at || slash ? `<div class="ai-menu-q">${at ? "@" : "/"}<input id="ai-menu-q" data-act="ai-menu-q" value="${esc(store.aiMenuQuery || "")}" placeholder="${at ? "筛选文件、对话、知识、Skill/MCP/Tool" : "筛选 Skill / MCP / Tool"}"></div>` : ""}
      ${!at && !slash ? `<div class="ai-menu-tabs"><button class="${store.aiMenuTab === "add" ? "on" : ""}" data-act="ai-menu-tab" data-tab="add">添加</button><button class="${store.aiMenuTab === "cmd" ? "on" : ""}" data-act="ai-menu-tab" data-tab="cmd">指令</button></div>` : ""}
      <div class="ai-menu-list">
        ${!at && !slash && store.aiMenuTab === "add" ? `
          <button class="menu-item" data-act="ai-pick" data-kind="file">${icon("fileText", "ico-14")}文件<span class="mi meta">引用本地或项目文件</span></button>
          <button class="menu-item" data-act="ai-pick" data-kind="goal">${icon("target", "ico-14")}目标<span class="mi meta">设置或查看长期任务目标</span></button>
          <button class="menu-item" data-act="ai-pick" data-kind="plan">${icon("list", "ico-14")}计划<span class="mi meta">进入或退出计划模式</span></button>
          <button class="menu-item" data-act="ai-pick" data-kind="feedback">${icon("message", "ico-14")}反馈<span class="mi meta">发送关于当前会话的反馈</span></button>
        ` : ""}
        ${!at && !slash && store.aiMenuTab === "cmd" ? `
          <button class="menu-item" data-act="ai-permission">${icon("shield", "ico-14")}权限<span class="mi meta">${esc(store.aiPermission)} · 切换审批策略</span></button>
          <button class="menu-item" data-act="ai-model">${icon("cpu", "ico-14")}模型<span class="mi meta">${esc(D.ai.modelCatalog.current.model)}</span></button>
          <button class="menu-item" data-act="ai-export">${icon("download", "ico-14")}下载日志<span class="mi meta">导出当前会话为 ZIP</span></button>
        ` : ""}
        ${(at || slash) ? (items.length ? items.map(x => `<button class="menu-item" data-act="ai-insert" data-text="${esc(x.insert)}">${icon(x.icon, "ico-14")}<span class="mi-main"><b>${esc(x.name)}</b><span>${esc(x.meta)}</span></span></button>`).join("") : `<div class="empty" style="padding:20px"><b>没有匹配</b><p>换个关键词。</p></div>`) : ""}
      </div>
    </div>`;
  }

  /* ---------------- 模型能力 ---------------- */
  const visibleModels = p => (p?.models || []).filter(m => !m.image && !(m.modalities || []).includes("生图"));
  const runtimeBusy = () => Boolean(store.aiBusy || store.aiRuntimeBusy);
  const usableCli = c => Boolean(c.installed && c.enabled !== false && c.available !== false);
  const usableModel = m => m.on !== false && m.enabled !== false && m.available !== false;
  function currentProvider() {
    const cat = D.ai.modelCatalog;
    return (cat.providers || []).find(p => p.name === cat.current.provider);
  }
  function currentModel() {
    const cat = D.ai.modelCatalog, p = currentProvider(), list = visibleModels(p);
    const m = list.find(m => m.name === cat.current.model);
    if (m) return p.enabled === false || p.available === false ? { ...m, available: false } : m;
    return { name: cat.current.model || "未配置", ctx: "—", vision: false, thinking: false, available: false };
  }
  function anchorSlot(kind, button) {
    return `<div class="ai-anchor-slot ai-anchor-${kind}">${button}${store.aiPop === kind ? popups() : ""}</div>`;
  }
  function capCtx(m) {
    return `<span class="m-cap ctx" title="上下文 ${esc(m.ctx || "未知")}" aria-label="上下文 ${esc(m.ctx || "未知")}">${icon("gauge", "ico-13")}<b>${esc(m.ctx || "—")}</b></span>`;
  }
  function capFlag(kind, on, label, ico) {
    return `<span class="m-cap ${kind} ${on ? "on" : "off"}" title="${esc(label)}：${on ? "支持" : "不支持"}" aria-label="${esc(label)}：${on ? "支持" : "不支持"}">${icon(ico, "ico-13")}</span>`;
  }

  /* ---------------- 底部弹层：CLI / 权限 / 模型 ---------------- */
  function popups() {
    if (store.aiPop === "cli") {
      const installed = D.settings.clis.filter(c => c.installed);
      return `<div class="ai-pop ai-pop-cli" id="ai-popup-cli" data-ai-popup="cli" role="dialog" aria-label="切换 CLI" tabindex="-1">
        <div class="pop-h">切换 CLI<button class="icon-btn" data-ai-popup-close="cli" aria-label="关闭 CLI 选择">${icon("x", "ico-14")}</button></div>
        ${installed.length ? installed.map(c => `<button class="menu-item ${store.aiCli === c.id ? "on" : ""}" data-act="ai-cli-set" data-id="${c.id}" ${runtimeBusy() || !usableCli(c) ? 'disabled aria-disabled="true"' : ""}>${cliLogo(c.id, 18)}<span class="mi-main"><b>${esc(c.name)}</b><span>${esc(c.version)}${c.badge ? " · " + c.badge : ""}${!usableCli(c) ? " · 不可用" : ""}</span></span>${store.aiCli === c.id ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`).join("") : '<div class="drop-empty">没有已安装且可用的 CLI，请在配置管理中检查。</div>'}
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="open-settings" data-tab="cli">${icon("sliders", "ico-14")}CLI 配置管理</button>
      </div>`;
    }
    if (store.aiPop === "perm") {
      return `<div class="ai-pop ai-pop-perm" id="ai-popup-perm" data-ai-popup="perm" role="dialog" aria-label="权限模式" tabindex="-1">
        <div class="pop-h">权限模式<button class="icon-btn" data-ai-popup-close="perm" aria-label="关闭权限选择">${icon("x", "ico-14")}</button></div>
        ${(D.ai.permissions || []).map(p => `<button class="menu-item perm ${store.aiPermission === p.name ? "on" : ""}" data-act="ai-perm-set" data-name="${esc(p.name)}" ${runtimeBusy() || p.available === false || p.enabled === false ? 'disabled aria-disabled="true"' : ""}>${icon(p.icon, "ico-14")}<span class="mi-main"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span>${store.aiPermission === p.name ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`).join("") || '<div class="drop-empty">没有可用的权限模式。</div>'}
      </div>`;
    }
    if (store.aiPop === "model") {
      const cat = D.ai.modelCatalog, p = currentProvider(), models = visibleModels(p), cm = currentModel();
      const q = (store.aiModelQuery || "").toLowerCase();
      const filtered = models.filter(m => !q || m.name.toLowerCase().includes(q));
      return `<div class="ai-pop ai-pop-model" id="ai-popup-model" data-ai-popup="model" role="dialog" aria-label="选择模型" tabindex="-1">
        <div class="pop-h">模型 <span class="caption">${esc(cat.current.provider)} · ${esc(cm.name)}</span><button class="icon-btn" data-ai-popup-close="model" aria-label="关闭模型选择">${icon("x", "ico-14")}</button></div>
        <label class="search">${icon("search", "ico-14")}<input class="input" id="ai-model-q" data-act="ai-model-q" value="${esc(store.aiModelQuery || "")}" placeholder="搜索模型…"></label>
        <div class="model-grid" data-ai-resize-root="model">
          <div class="model-providers" data-pane="ai-model-providers" data-pane-default="112" data-pane-min="96" data-pane-max="180">${(cat.providers || []).map(pp => { const n = visibleModels(pp).filter(usableModel).length; return `<button class="provider-row ${pp.name === cat.current.provider ? "on" : ""}" data-act="ai-model-provider" data-name="${esc(pp.name)}" ${runtimeBusy() || !n || pp.enabled === false || pp.available === false ? 'disabled aria-disabled="true"' : ""}><span class="ellipsis">${esc(pp.name)}</span><span class="count">${n}</span></button>`; }).join("")}</div>
          <div class="model-list" data-pane-center-min="160">${filtered.length ? filtered.map(m => `<button class="model-row ${m.name === cm.name ? "on" : ""}" data-act="ai-model-set" data-name="${esc(m.name)}" ${runtimeBusy() || !usableModel(m) || p?.enabled === false || p?.available === false ? 'disabled aria-disabled="true"' : ""}>
            <span class="mr-name ellipsis">${esc(m.name)}</span>
            <span class="mr-caps">${capCtx(m)}${capFlag("vision", !!m.vision, "视觉", "eye")}${capFlag("think", !!m.thinking, "思考", "bulb")}</span>
          </button>`).join("") : `<div class="empty" style="padding:16px"><b>${models.length ? "没有匹配" : "没有可用模型"}</b><p>${models.length ? "换关键词，或检查供应商配置。" : "检查供应商配置；不回退到生图模型。"}</p></div>`}</div>
        </div>
        <div class="model-level ${cm.thinking ? "" : "disabled"}"><div class="row between"><b>思考等级</b><span class="caption">${cm.thinking ? esc(cat.current.level) : "该模型未声明思考档位"}</span></div>
          ${cm.thinking ? `<input type="range" min="0" max="3" step="1" value="${cat.levels.indexOf(cat.current.level)}" data-act="ai-level" class="range" aria-label="思考等级" ${runtimeBusy() || !usableModel(cm) ? "disabled" : ""}>
          <div class="level-labels">${cat.levels.map(l => `<span>${l}</span>`).join("")}</div>` : '<div class="level-note">不支持思考档位，选择其它模型后可调整。</div>'}
        </div>
      </div>`;
    }
    return "";
  }

  /* ---------------- 统计：输入框下方，弹层右对齐各自控件 ---------------- */
  function statPop(kind) {
    const s = D.ai.stats;
    if (kind === "session") return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="会话统计"><div class="pop-h">会话统计</div><div class="stat-rows">
      <div><span>轮次</span><b>${s.rounds} 轮 ${esc(s.duration || "108 秒")}</b></div><div><span>模型用时</span><b>${esc(s.modelTime)}</b></div><div><span>工具调用用时</span><b>${esc(s.toolTime)}</b></div><div><span>首 token 平均（TTFT）</span><b>${esc(s.ttft)}</b></div><div><span>输出速度（TPS）</span><b>${esc(s.tps)}</b></div></div></div>`;
    if (kind === "tokens") return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="Token 用量"><div class="pop-h">Token 用量 <span class="caption">${esc(s.tokens.total)}</span></div><div class="stat-rows">
      <div><span>缓存命中</span><b>${esc(s.tokens.cacheHit)}</b></div><div><span>未缓存输入</span><b>${esc(s.tokens.uncached)}</b></div><div><span>缓存读取</span><b>${esc(s.tokens.cacheRead)}</b></div><div><span>输出</span><b>${esc(s.tokens.output)}</b></div></div></div>`;
    return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="上下文"><div class="pop-h">上下文 <span class="caption">已用 ${esc(s.context.used)} · ${esc(s.context.detail)}</span></div><div class="stat-rows">
      <div><span>系统提示词</span><b>${esc(s.context.system)}</b></div><div><span>工具定义</span><b>${esc(s.context.tools)}</b></div><div><span>对话消息</span><b>${esc(s.context.messages)}</b></div></div></div>`;
  }

  function statWrap(kind, label, content) {
    return `<span class="ai-stat-wrap"><button class="s" data-act="ai-stat" data-stat="${kind}" aria-label="${esc(label)}" aria-expanded="${store.aiPop === kind}">${content}</button>${store.aiPop === kind ? statPop(kind) : ""}</span>`;
  }

  function statsRow() {
    const s = D.ai.stats;
    const total = D.ai.stats.tokens.total;
    // CR-065：无数据时不显示内容，但保留占位高度，避免输入区位移
    const hasData = Number(s.rounds) > 0 || (total && total !== "0" && total !== "—");
    if (!hasData) return `<div class="ai-stats is-empty" aria-hidden="true"></div>`;
    return `<div class="ai-stats">
      ${statWrap("session", "会话统计", `${icon("sessionStats", "ico-14")}${s.rounds} 轮 · ${esc(s.tps)}`)}
      ${statWrap("tokens", "Token 用量", `${icon("tokenUsage", "ico-14")}${s.simulated ? esc(total) : (Number(String(total).replace(/[^0-9.]/g, "")) / 1e6).toFixed(2) + "M"} · 命中 ${esc(s.tokens.cacheHit)}`)}
      ${statWrap("context", "上下文", `${icon("contextUsage", "ico-14")}上下文 ${esc(s.context.used)}`)}
    </div>`;
  }

  /* ---------------- 分步骤执行：与消息区等宽的折叠框 ---------------- */
  function stepsBlock() {
    const steps = activeSession().steps || [];
    if (!steps.length) return "";
    const done = steps.filter(x => x.state === "done").length;
    const running = steps.some(x => x.state === "running");
    const failed = steps.some(x => x.state === "failed");
    const allDone = done === steps.length;
    const state = running ? "进行中" : failed ? "有失败" : allDone ? "已完成" : "等待继续";
    return `<section class="ai-steps ${store.aiStepsOpen ? "open" : "collapsed"}" aria-label="执行步骤">
      <button class="steps-h" data-act="ai-steps-toggle" aria-expanded="${store.aiStepsOpen}">
        ${icon("steps", "ico-14")}<b>执行步骤</b><span class="steps-count">${done}/${steps.length}</span><span class="steps-state ${running ? "run" : failed ? "fail" : allDone ? "done" : ""}">${state}</span>
        <span class="spacer"></span><span class="steps-chev">${icon("chevronDown", "ico-14")}</span>
      </button>
      ${store.aiStepsOpen ? `<div class="steps-list">${steps.map(st => `<div class="ai-step ${st.state}">
        <span class="ai-step-ico">${st.state === "done" ? icon("check", "ico-13") : st.state === "running" ? '<span class="ai-step-spin" aria-hidden="true"></span>' : st.state === "failed" ? icon("alert", "ico-13") : icon("clock", "ico-13")}</span>
        <span class="ai-step-title">${esc(st.title)}</span>
        <span class="ai-step-meta">${esc(st.state === "done" ? "已完成" + (st.meta ? " · " + st.meta : "") : st.state === "running" ? "执行中" : st.state === "failed" ? "失败" + (st.meta ? " · " + st.meta : "") : "未开始")}</span>
      </div>`).join("")}</div>` : ""}
      <div class="steps-f"><span class="caption">合成演示 · 不调用真实模型</span><button class="link-btn" data-act="ai-step-advance">推进演示</button></div>
    </section>`;
  }

  function advanceStep() {
    const steps = activeSession().steps || [];
    const i = steps.findIndex(x => x.state === "running");
    if (i >= 0) {
      steps[i].state = "done";
      steps[i].meta = "1.4s";
      if (steps[i + 1]) { steps[i + 1].state = "running"; steps[i + 1].meta = "进行中"; }
    } else {
      const next = steps.find(x => x.state === "todo");
      if (next) next.state = "running";
      else { toast("步骤已全部完成"); return; }
    }
    UI.render();
  }

  function cliLogo(id, size) { return UI.cliLogo(id, size); }

  /* ---------------- CR-062：子智能体只读详情 ---------------- */
  const currentAgent = () => D.ai.subagents.find(a => a.id === store.aiAgent) || null;
  const agentState = s => s === "失败" ? "red" : s === "运行中" || s === "待确认" ? "amber" : s === "已停止" ? "gray" : "green";
  const AGENT_KIND = { status: "状态", text: "说明", tool: "工具调用", result: "工具结果", output: "产出" };

  function agentView(a) {
    const tone = agentState(a.status);
    const events = a.events || [];
    return `<aside class="ai-panel ai-agent-view" aria-label="子智能体只读详情" style="width:${store.aiWidth}px">
      <div class="ai-resize" data-act="ai-resize" title="拖动调整宽度"></div>
      <div class="ai-top ai-agent-top">
        <button class="icon-btn" data-act="ai-agent-back" title="返回主会话" aria-label="返回主会话">${icon("arrowLeft")}</button>
        <nav class="ai-crumb" aria-label="会话位置">
          <button class="ai-crumb-link" data-act="ai-agent-back" title="返回主会话">主会话</button>
          <span class="ai-crumb-sep" aria-hidden>/</span>
          <span class="ai-crumb-current ellipsis" title="${esc(a.title)}">${esc(a.title)}</span>
        </nav>
        <span class="spacer"></span>
        <span class="ai-agent-state st-${tone}" role="status"><span class="ai-agent-dot dot-${tone}"></span>${esc(a.status)}</span>
      </div>
      <div class="ai-agent-meta">
        ${cliLogo(a.cli, 16)}<span class="am-cli">${esc(a.cli || "CLI 未知")}</span>
        <span class="sep">·</span><span>${esc(a.model || "模型未知")}</span>
        <span class="sep">·</span><span>${esc(a.duration || "耗时未知")}</span>
        <span class="sep">·</span><span>${esc(a.tokens || "tokens 未知")}</span>
        ${a.taskId ? `<span class="ai-agent-task">任务 ${esc(a.taskId)}</span>` : ""}
      </div>
      <div class="ai-scroll ai-agent-timeline" id="ai-scroll">
        <div class="ai-agent-note">${icon("eye", "ico-13")}子智能体记录仅本次运行可见；未上报的内容保持未知，不补造。</div>
        ${events.length ? events.map(ev => `<div class="ai-agent-ev ${ev.isError ? "ev-error" : ""}">
          <span class="ev-ico">${icon(ev.kind === "tool" ? "terminal" : ev.kind === "result" ? "check" : ev.kind === "status" ? "loader" : ev.kind === "output" ? "checkCircle" : "message", "ico-13")}</span>
          <div class="ev-main">
            <div class="ev-head"><span class="ev-kind">${AGENT_KIND[ev.kind] || "记录"}</span>
              ${ev.status ? `<span class="ev-status st-${agentState(ev.status)}">${esc(ev.status)}</span>` : ""}
              ${ev.toolName ? `<code class="ev-tool">${esc(ev.toolName)}</code>` : ""}
            </div>
            ${ev.text ? `<div class="ev-text ${ev.kind === "tool" || ev.kind === "result" ? "mono" : ""}">${esc(ev.text)}</div>` : ""}
          </div></div>`).join("") : `<div class="ai-agent-empty"><b>暂无过程记录</b><p>${esc(a.output || "该子智能体尚未上报正文或工具调用。")}</p></div>`}
      </div>
      <div class="ai-agent-readonly">${icon("eye", "ico-13")}<span>子智能体由主会话派发，这里只读；输入与发送在主会话进行。</span><button class="btn sm" data-act="ai-agent-back">返回主会话</button></div>
    </aside>`;
  }

  function render() {
    const agent = currentAgent();
    if (store.aiAgent && agent) return agentView(agent);
    if (store.aiAgent && !agent) store.aiAgent = null;
    const msgs = store.aiMessages;
    const cli = D.settings.clis.find(c => c.id === store.aiCli) || { id: "", name: "未配置 CLI" };
    const cm = currentModel(), busy = runtimeBusy();
    const cliDisabled = busy || !D.settings.clis.some(usableCli);
    const permDisabled = busy || !(D.ai.permissions || []).some(p => p.available !== false && p.enabled !== false);
    const modelDisabled = busy || !(D.ai.modelCatalog.providers || []).some(p => p.enabled !== false && p.available !== false && visibleModels(p).some(usableModel));
    return `<aside class="ai-panel"${window.OfficeAI ? OfficeAI.panelAttrs() : ""} aria-label="AI 会话" style="width:${store.aiWidth}px">
      <div class="ai-resize" data-act="ai-resize" title="拖动调整宽度"></div>
      ${store.aiHistory ? historyRail() : ""}
      <div class="ai-top">
        <button class="icon-btn" data-act="ai-history" title="会话历史" aria-label="会话历史" aria-expanded="${store.aiHistory}">${icon("history")}</button>
        <div class="ai-drop-wrap" ${D.ai.subagents.length ? "" : "hidden"}>
          <button class="ai-count" data-act="ai-subagents" aria-expanded="${store.aiTop === "agents"}">${icon("users", "ico-14")}${D.ai.subagents.length} 子智能体${icon("chevronDown", "ico-12")}</button>
          ${store.aiTop === "agents" ? aiTopPop() : ""}
        </div>
        <div class="ai-drop-wrap" ${D.ai.background.length ? "" : "hidden"}>
          <button class="ai-count" data-act="ai-background" aria-expanded="${store.aiTop === "bg"}">${icon("terminal", "ico-14")}${D.ai.background.length} 后台任务${icon("chevronDown", "ico-12")}</button>
          ${store.aiTop === "bg" ? aiTopPop() : ""}
        </div>
        ${!window.OfficeAI?.isActive() ? '<button class="ai-cr037-trigger" data-act="ai-cr037" title="打开 CR-037 协作续接演示">CR-037</button>' : ""}
        <span class="spacer"></span>
        ${activeSession()?.sessionRole === "executor" && activeSession()?.featureId ? `<span class="ai-scope-tag" title="执行特性：${esc(activeSession().featureTitle || activeSession().featureId)}；本会话仅实现该特性" aria-label="执行特性 ${esc(activeSession().featureId)}，单特性执行会话">FEAT · <b>${esc(activeSession().featureId)}</b></span>` : ""}
        <button class="icon-btn" data-act="ai-new" title="新会话" aria-label="新会话">${icon("plus")}</button>
      </div>
      <div class="ai-fade"></div>
      <div class="ai-scroll" id="ai-scroll">
        ${msgs.length ? msgs.map((m, i) => message(m, i)).join("") : `<div class="ai-empty"><span class="mark">${icon("sparkles", "ico-20")}</span><b>新会话</b><p>说清目标与范围，我会先核对证据再动手。</p></div>`}
        ${store.aiBusy ? workingRow() : ""}
        ${store.aiQueue.length ? `<div class="ai-queued">${icon("clock", "ico-14")}已排队 ${store.aiQueue.length} 条，当前完成后发送</div>` : ""}
        ${window.OfficeAI ? OfficeAI.extra(OfficeAI.projectId()) : ""}
        ${window.CR037?.chatCard() || ""}
      </div>
      <div class="ai-composer-wrap">
        <div class="ai-plan-dock">${stepsBlock()}</div>
        ${store.aiMenu ? menuHtml() : ""}
        <div class="ai-composer">
          <textarea id="ai-input" placeholder="${window.OfficeAI && OfficeAI.isActive() ? "描述办公意图，/ 调用指令，@ 项目资料或对话" : "描述你想构建的内容，/ 调用指令，@ 文件或对话"}">${esc(store.aiInput)}</textarea>
          <div class="ai-tools">
            <button class="ai-chip icon-only" data-act="ai-menu-open" data-tab="add" title="添加" aria-label="添加">${icon("plus")}</button>
            ${anchorSlot("cli", `<button class="ai-chip cli" id="ai-anchor-cli" data-ai-anchor="cli" data-act="ai-cli" aria-haspopup="dialog" aria-controls="ai-popup-cli" aria-expanded="${store.aiPop === "cli"}" ${cliDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : cliDisabled ? "没有可用 CLI" : "切换 CLI：" + esc(cli.name)}" aria-label="切换 CLI：${esc(cli.name)}">${cliLogo(cli.id, 16)}</button>`)}
            ${anchorSlot("perm", `<button class="ai-chip perm" id="ai-anchor-perm" data-ai-anchor="perm" data-act="ai-permission" aria-haspopup="dialog" aria-controls="ai-popup-perm" aria-expanded="${store.aiPop === "perm"}" ${permDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : "权限模式"}" aria-label="权限模式">${icon("shield")}${esc(store.aiPermission)}</button>`)}
            ${anchorSlot("model", `<button class="ai-chip model" id="ai-anchor-model" data-ai-anchor="model" data-act="ai-model" aria-haspopup="dialog" aria-controls="ai-popup-model" aria-expanded="${store.aiPop === "model"}" ${modelDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : modelDisabled ? "没有可用模型" : !usableModel(cm) ? "当前模型失效，请重新选择" : "选择模型"}" aria-label="选择模型">${esc(cm.name)}${cm.available === false ? "（不可用）" : ""} · ${esc(cm.thinking ? D.ai.modelCatalog.current.level : "无思考档位")}</button>`)}
            <button class="ai-send" data-act="ai-send" title="${store.aiBusy && !store.aiInput.trim() ? "停止" : "发送"}" aria-label="${store.aiBusy && !store.aiInput.trim() ? "停止" : "发送"}">${icon(store.aiBusy && !store.aiInput.trim() ? "stop" : "arrowUp", "ico-18")}</button>
          </div>
        </div>
        ${statsRow()}
      </div>
    </aside>`;  }

  function afterRender() {
    const sc = document.getElementById("ai-scroll");
    if (sc && store.aiStick !== false) sc.scrollTop = sc.scrollHeight;
    // CR-063：搜索输入保持焦点与光标；继续加载后恢复列表滚动位置，避免视觉跳动。
    const q = document.getElementById("ai-history-q");
    if (q && store.aiHistFocus) {
      q.focus();
      const n = q.value.length;
      try { q.setSelectionRange(n, n); } catch { /* type=search 在部分环境不支持选区，忽略 */ }
    }
    const hl = document.querySelector(".ai-history-list");
    if (hl && store.aiHistScroll) { hl.scrollTop = store.aiHistScroll; store.aiHistScroll = 0; }
  }

  function switchSession(id) {
    if (window.OfficeAI && OfficeAI.switchSession(id)) return;
    const s = D.ai.sessions.find(x => x.id === id);
    if (!s) return;
    window.CR037?.beforeSwitchSession(s);
    store.aiSession = id;
    store.aiAgent = null;
    store.aiMessages = s.messages.length ? s.messages : [];
    s.status = "read";
    store.aiHistory = false;
    store.aiHistLimit = 20; store.aiHistQuery = ""; store.aiHistFocus = false;
    render && UI.render();
  }

  function newSession(feature) {
    if (window.OfficeAI && OfficeAI.newSession()) return;
    store.aiAgent = null;
    const cur = activeSession();
    cur.messages = store.aiMessages.slice();
    cur.tokens = cur.tokens || "0";
    const id = "S-" + Date.now().toString().slice(-6);
    const session = { id, title: feature ? `执行 ${feature.id} · ${feature.title}` : "新会话", status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: [] };
    if (feature) { session.featureId = feature.id; session.featureTitle = feature.title; session.sessionRole = "executor"; }
    D.ai.sessions.unshift(session);
    store.aiSession = id;
    store.aiMessages = [];
    store.aiInput = "";
    toast("已新建会话，原会话已保留在历史中");
    UI.render();
  }

  function reply(text, extra, context) {
    const now = new Date();
    const time = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const state = context ? context.state : store, s = context ? context.session : activeSession();
    state.aiBusy = false;
    s.status = extra && extra.failed ? "failed" : "success";
    s.updated = "刚刚";
    const msg = { role: "assistant", time, text, ...(extra || {}) };
    state.aiMessages.push(msg);
    s.messages = state.aiMessages;
    const next = state.aiQueue.shift(), gen = state.aiGen;
    if (!context || context.current()) UI.render();
    if (next) setTimeout(() => {
      if (gen !== state.aiGen || (context && state.aiSession !== context.sessionId)) return;
      sendMessage(next, context);
    }, 300);
  }

  function sendMessage(text, captured) {
    const context = captured || (window.OfficeAI ? OfficeAI.captureRequest() : null);
    const state = context ? context.state : store, s = context ? context.session : activeSession();
    const now = new Date();
    const time = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    state.aiMessages.push({ role: "user", time, text });
    state.aiInput = "";
    state.aiBusy = true;
    state.aiWorkStartedAt = Date.now(); state.aiWorkElapsed = "0 秒";
    state.aiStick = true;
    s.status = "pending";
    s.messages = state.aiMessages;
    if (s.title === "新会话") s.title = text.slice(0, 32);
    const gen = ++state.aiGen;
    if (!context || context.current()) UI.render();
    setTimeout(() => {
      if (gen !== state.aiGen || (context && state.aiSession !== context.sessionId)) return;
      if (context && context.projectId) {
        const result = OfficeAI.response(context, text);
        reply(result.text, result, context);
      } else reply("收到。这是仿真会话：我会先核对当前运行与 AC 证据，再给出下一步；真实模型、文件写入与命令执行均未接入。", {
        tools: [{ name: "fs.read", arg: "docs/Plan/Story/STORY-0102.md", state: "完成", detail: "读取 1.2 KB · 3 条 AC" }]
      }, context);
    }, 900);
  }

  function send() {
    if (window.CR037?.send()) return;
    const text = (store.aiInput || "").trim();
    if (!text) {
      if (store.aiBusy) { store.aiGen++; store.aiBusy = false; activeSession().status = "failed"; UI.render(); toast("已停止本次生成"); }
      return;
    }
    if (store.aiBusy) {
      if ((D.settings.general.sendMode || "queue") === "queue") store.aiQueue.push(text);
      else { store.aiGen++; store.aiBusy = false; toast("已立即发送（打断当前生成）", "send"); sendMessage(text); return; }
      store.aiInput = "";
      UI.render();
      return;
    }
    sendMessage(text);
  }

  function approve(idx, allow) {
    const m = store.aiMessages[idx];
    if (!m || !m.approval) return;
    if (allow) {
      store.aiMessages.splice(idx, 1, { ...m, approval: null, tools: (m.tools || []).concat([{ name: "fs.write", arg: "tests/capacity-rollback.spec.ts", state: "完成", detail: "+42 行 · 已写入本机工作区" }]) });
      toast("已允许一次：仅本机仿真，不执行真实命令");
    } else {
      store.aiMessages.splice(idx, 1, { ...m, approval: null });
      toast("已拒绝本次写入");
    }
    activeSession().messages = store.aiMessages.slice();
    UI.render();
  }

  function insert(text) {
    const cur = store.aiInput;
    store.aiInput = /(^|\s)[@\/][^\s@\/]*$/.test(cur) ? cur.replace(/(^|\s)[@\/][^\s@\/]*$/, (m, p1) => p1 + text) : (cur + " " + text).trim();
    store.aiMenu = null;
    store.aiMenuQuery = "";
    UI.render();
    const el = document.getElementById("ai-input");
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  return { message, workingRow, statsRow, agentDrop, backgroundDrop, render, afterRender, send, approve, insert, switchSession, newSession, menuHtml, advanceStep, cliLogo, activeSession, currentModel, visibleModels };
})();