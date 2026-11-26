/* AI 侧栏：UI-CR056-v1 当前设计基线。无标题头、可拖拽、历史浮层、@// 菜单、会话目标/任务、CLI/权限/模型、统计、子智能体与后台任务。
   继承 CR-042 的浮层与步骤结构，补齐输入上下文菜单、目标/任务状态、稳定消息身份、CLI/权限能力证据和模型思考档位联动。 */
window.AIPanel = (function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell } = UI;

  const activeSession = () => D.ai.sessions.find(s => s.id === store.aiSession) || D.ai.sessions[0];
  const statusDot = s => s === "success" ? '<span class="sdot green"></span>' : s === "failed" ? '<span class="sdot red"></span>' : s === "pending" ? '<span class="sdot amber"></span>' : '<span class="sdot none"></span>';
  const statusText = s => s === "success" ? "成功" : s === "failed" ? "失败" : s === "pending" ? "待处理" : "已读";

  const finalText = m => Array.isArray(m?.blocks)
    ? (m.blocks.at(-1)?.type === "text" ? m.blocks.at(-1).text || "" : "")
    : m?.text || "";

  function message(m, idx, format = text => UI.md(text).replace(/^<p>|<\/p>$/g, "")) {
    if (m.role === "continuity-break") {
      const cli = D.settings.clis.find(item => item.id === m.cli)?.name || m.cli;
      return `<div class="cr037-break" role="note"><b>原生上下文断点</b><span>${esc(cli)} · ${esc(m.previousRef || "原引用缺失")} → ${esc(m.sessionRef)}</span><span>以上聊天记录保留。后续请求从新上下文开始。</span></div>`;
    }
    const glyph = category => icon(category === "change" ? "edit" : category === "run" ? "terminal" : category === "explore" ? "search" : "tool", "ico-16");
    const brain = '<svg class="message-brain" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5a3 3 0 0 0-5.7-1.3A3.6 3.6 0 0 0 3 8.5a4 4 0 0 0 0 7 3.6 3.6 0 0 0 3.3 5.3A3 3 0 0 0 12 19.5V4.5Zm0 0a3 3 0 0 1 5.7-1.3A3.6 3.6 0 0 1 21 8.5a4 4 0 0 1 0 7 3.6 3.6 0 0 1-3.3 5.3 3 3 0 0 1-5.7-1.3M6 8c2 0 3 1 3 3M5 16c2-1 4 0 4 2m9-10c-2 0-3 1-3 3m4 5c-2-1-4 0-4 2"/></svg>';
    const reasoning = (text, streaming, duration) => `<details class="msg-think"><summary>${brain}<span>${streaming ? "思考中" : "思考"}</span>${duration != null ? `<span class="mt-meta">持续了 ${esc(typeof duration === "number" ? MessagePresentation.formatMessageDuration(duration) : duration)}</span>` : ""}</summary><div class="mt-body">${esc(text)}</div></details>`;
    const copy = text => text && !m.streaming ? `<div class="msg-acts"><button type="button" class="msg-act" data-act="ai-copy" data-idx="${idx}" title="复制这条回复的正文">${icon("copy", "ico-16")}<span>复制</span></button></div>` : "";
    if (m.role === "user") return `<div class="msg user" data-ai-message-index="${idx}"><div class="msg-body"><div class="msg-user-block">${referenceMarkup(m.refs)}${esc(m.text || "")}${imageMarkup(m.images)}</div><div class="msg-time">${esc(m.time || "")}</div></div></div>`;
    if (m.role === "subagent") {
      const agent = MessagePresentation.presentAgent(m.sourceLabel);
      return `<div class="msg assistant"><details class="message-proto-agent"><summary><span class="message-agent-dots ${agent.type === "Explore" ? "explore" : ""}" aria-hidden="true">•••</span><span class="message-agent-type ${agent.type === "Explore" ? "explore" : ""}">${agent.type}</span><span class="message-agent-task">${esc(m.producerTask || "子智能体任务")}</span><span class="message-agent-status">${agent.status}</span></summary><div class="message-agent-detail"><div>${esc(m.producerId || "身份未记录")}</div><div>${esc(m.sourceLabel || "状态未知")}</div>${esc(m.content || "")}</div></details></div>`;
    }
    const blocks = Array.isArray(m.blocks) ? m.blocks.slice() : [
      ...(m.thinking ? [{ type: "thinking", text: m.thinking, duration: m.thinkMs }] : []),
      ...(m.tools || []).map(tool => ({ type: "tool", name: tool.name, status: tool.state, args: tool.arg, result: tool.detail, exitCode: tool.exitCode })),
      ...(m.text ? [{ type: "text", text: m.text }] : [])
    ];
    const activity = m.streaming || blocks.some(b => b.status === "streaming" || b.status === "运行中" || b.status === "running");
    const final = activity ? "" : finalText(m);
    if (final && blocks.at(-1)?.type === "text") blocks.pop();
    const children = [];
    for (const block of blocks) {
      const previous = children.at(-1);
      if (block.type === "tool" && Array.isArray(previous)) previous.push(block);
      else children.push(block.type === "tool" ? [block] : block);
    }
    const failed = b => b.status === "失败" || b.status === "failed" || b.status === "error" || b.isError || (Number.isInteger(b.exitCode) && b.exitCode !== 0);
    const stringifyToolValue = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
    const present = (b, index) => {
      const raw = b.command != null ? { ...(b.args && typeof b.args === "object" ? b.args : {}), command: b.command } : b.args;
      const output = b.result ?? b.output;
      return { part: b.part || "both", pair: { toolId: b.toolId || `prototype-${index}`, name: b.name || null, inputJson: raw == null ? null : typeof raw === "object" ? JSON.stringify(raw) : String(raw), result: output == null ? null : { content: stringifyToolValue(output), isError: failed(b) }, useMsg: { streaming: b.status === "running" || b.status === "运行中" }, resultMsg: Number.isInteger(b.exitCode) ? { exitCode: b.exitCode } : null } };
    };
    const tool = (b, index) => {
      const item = present(b, index), summary = MessagePresentation.summarizeTools([item]);
      const { command, inputText, parametersText } = MessagePresentation.presentToolInput(item.pair.inputJson);
      const output = b.result ?? b.output;
      return `<details class="chat-proto-tool"><summary>${glyph(summary.category)}<span>${esc(summary.text)}</span></summary><div class="chat-proto-tool-body"><div class="chat-proto-tool-meta">${esc(b.name || "工具")} · ${esc(b.status || "结果未返回")}${Number.isInteger(b.exitCode) ? " · 退出码 " + b.exitCode : ""}</div>${command != null ? `<pre>${esc(command)}</pre>` : inputText != null ? `<pre>${esc(inputText)}</pre>` : ""}${parametersText && parametersText !== "{}" ? `<pre title="输入参数">${esc(parametersText)}</pre>` : ""}${output != null ? `<pre>${esc(stringifyToolValue(output) || "（无输出）")}</pre>` : ""}</div></details>`;
    };
    const parts = children.map(entry => {
      if (Array.isArray(entry)) {
        if (entry.length === 1) return tool(entry[0], 0);
        const summary = MessagePresentation.summarizeTools(entry.map(present));
        return `<details class="chat-tool-group"><summary>${glyph(summary.category)}<span>${esc(summary.text)}</span></summary><div class="chat-proto-group-body">${entry.map(tool).join("")}</div></details>`;
      }
      return entry.type === "thinking" ? reasoning(entry.text || "", entry.status === "streaming", entry.duration) : entry.type === "text" ? `<div class="text">${format(entry.text || "")}</div>` : "";
    }).join("");
    const approval = m.approval ? `<div class="approval"><b>${esc(m.approval.title)}</b><p>${esc(m.approval.detail)}</p>
      <div class="acts"><button class="btn primary" data-act="ai-approve" data-idx="${idx}">允许一次</button><button class="btn" data-act="ai-deny" data-idx="${idx}">拒绝</button><button class="btn ghost" data-act="ai-show-cmd" data-idx="${idx}">查看命令</button></div></div>` : "";
    const duration = typeof m.workMs === "number" && m.workMs >= 0 ? ` ${MessagePresentation.formatMessageDuration(m.workMs)}` : "";
    return `<div class="msg assistant" data-ai-message-index="${idx}"><div class="msg-body">${parts ? `<details class="chat-turn-process" ${activity ? "open" : ""}><summary><span>${activity ? "工作中" : "已工作"}${duration}</span>${icon("chevronRight", "ico-16")}${m.failed || blocks.some(failed) ? '<span class="chat-process-status">有失败</span>' : ""}</summary><div class="chat-turn-process-body">${parts}</div></details>` : ""}${final ? `<div class="text">${format(final)}</div>` : ""}${approval}${window.OfficeAI ? OfficeAI.messageExtra(m) : ""}${copy(final)}</div></div>`;
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
  function historyRail({ inline = false } = {}) {
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
    return `<aside class="ai-history ${inline ? "wb-hist" : ""}" data-ai-overlay="${inline ? "inline-history" : "history"}" data-pane="ai-history" data-pane-default="296" data-pane-min="240" data-pane-max="420" role="dialog" aria-label="会话历史">
      <div class="ai-history-h"><span class="ah-title">${icon("history", "ico-14")}<b>会话历史</b><span class="caption" title="已加载 / 全部">${state === "first" ? "…" : `${shown.length} / ${matched.length}`}</span></span>${inline ? "" : `<button class="icon-btn" data-act="ai-history-close" aria-label="关闭会话历史">${icon("x", "ico-14")}</button>`}</div>
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
  const imageDrafts = new WeakMap();
  const refDrafts = new WeakMap();
  const requestStates = new WeakMap();
  const textDrafts = new WeakMap();

  function selectCodeSession(session) {
    const current = activeSession();
    if (current === session && store.aiSession === session.id) return;
    if (current) textDrafts.set(current, store.aiInput || "");
    store.aiSession = session.id;
    store.aiMessages = session.messages ??= [];
    store.aiInput = textDrafts.get(session) || "";
    store.aiMenu = null;
    triggerRange = null;
  }

  function syncRequestState() {
    const request = requestStates.get(activeSession());
    store.aiQueue = request?.queue ?? [];
    store.aiBusy = Boolean(request?.running);
    store.aiWorkStartedAt = request?.startedAt;
    store.aiWorkElapsed = request?.running ? `${Math.floor((Date.now() - request.startedAt) / 1000)} 秒` : "0 秒";
  }
  const draftImages = () => imageDrafts.get(activeSession()) || [];
  const canAttachImages = () => store.aiCli === "codex" && !window.CR069?.isPlatform();
  const imageTypes = ["image/png", "image/jpeg", "image/webp"];
  let triggerRange = null;

  function referenceMarkup(refs, draft = false) {
    if (!refs?.length) return "";
    return `<div class="chat-proto-refs">${refs.map((ref, index) => `<span class="chat-proto-ref"><span class="ellipsis" title="${esc(ref.label)}">${esc(ref.label)}</span>${draft ? `<button type="button" data-act="ai-ref-remove" data-index="${index}" aria-label="移除引用 ${esc(ref.label)}">${icon("x", "ico-12")}</button>` : ""}</span>`).join("")}</div>`;
  }

  // Adapted from @deepseek-ai/dsh-client-ui-attachment (MIT; see chat-dock.LICENSE).
  function thumbnailStyle(image) {
    const { width, height } = image;
    if (!width || !height) return { frame: "", position: "center" };
    const natural = width / height;
    const ratio = Math.min(4, Math.max(.25, natural));
    const boxWidth = Math.min(240, 240 * ratio), boxHeight = Math.min(240, 240 / ratio);
    const scale = Math.min(1, width / boxWidth, height / boxHeight);
    const w = Math.max(44, Math.round(boxWidth * scale)), h = Math.max(44, Math.round(boxHeight * scale));
    return { frame: `width:${w}px;aspect-ratio:${w}/${h}`, position: natural < .25 ? "center top" : natural > 4 ? "left center" : "center" };
  }

  function imageMarkup(images, draft = false) {
    if (!images?.length) return "";
    const single = !draft && images.length === 1;
    return `<div class="${draft ? "chat-composer-images" : "chat-message-images"}" data-multiple="${images.length > 1}">${images.map((image, index) => {
      const style = single ? thumbnailStyle(image) : { frame: "", position: "center" };
      return `<span class="chat-proto-image"><button type="button" data-act="ai-image-view" data-draft="${draft}" data-index="${index}" aria-label="预览图片 ${esc(image.name)}" style="${style.frame}"><img src="${esc(image.data)}" alt="${esc(image.name)}" style="object-position:${style.position}"></button>${draft ? `<button type="button" class="chat-proto-image-remove" data-act="ai-image-remove" data-index="${index}" aria-label="移除图片 ${esc(image.name)}">${icon("x", "ico-12")}</button>` : ""}</span>`;
    }).join("")}</div>`;
  }

  async function addImages(files) {
    if (!canAttachImages() || !files.length) return;
    const session = activeSession();
    if (files.some(file => !imageTypes.includes(file.type))) { toast("请选择 PNG、JPEG 或 WebP 图片", "alert"); return; }
    if (files.some(file => !file.size || file.size > 10 * 1024 * 1024)) { toast("每张图片须大于 0 字节且不超过 10 MiB", "alert"); return; }
    if (files.length + draftImages().length > 8) { toast("每条消息最多添加 8 张图片", "alert"); return; }
    try {
      const images = await Promise.all(files.map(async file => {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("图片读取失败"));
          reader.readAsDataURL(file);
        });
        const img = new Image();
        img.src = data;
        await img.decode().catch(() => { throw new Error("图片解码失败"); });
        return { name: file.name, data, width: img.naturalWidth, height: img.naturalHeight };
      }));
      const current = imageDrafts.get(session) || [];
      if (current.length + images.length > 8) { if (activeSession() === session) toast("每条消息最多添加 8 张图片", "alert"); return; }
      imageDrafts.set(session, [...current, ...images]);
      if (activeSession() === session) UI.render();
    } catch (error) { if (activeSession() === session) toast(error.message, "alert"); }
  }

  function removeImage(index) {
    imageDrafts.set(activeSession(), draftImages().filter((_, i) => i !== index));
    UI.render();
  }

  function imageView(el) {
    const images = el.dataset.draft === "true" ? draftImages() : store.aiMessages[Number(el.closest("[data-ai-message-index]")?.dataset.aiMessageIndex)]?.images;
    const image = images?.[Number(el.dataset.index)];
    if (!image) return;
    const openedSession = activeSession();
    const messageIndex = el.closest("[data-ai-message-index]")?.dataset.aiMessageIndex;
    const dialog = document.createElement("dialog");
    dialog.className = "chat-proto-image-dialog";
    dialog.setAttribute("aria-label", "图片放大");
    dialog.innerHTML = `<div class="chat-proto-image-stage"><div class="chat-proto-image-mask" aria-hidden="true"></div><img class="chat-proto-image-original" tabindex="0" src="${esc(image.data)}" alt="${esc(image.name)}"><button type="button" class="chat-proto-image-close" data-image-close autofocus aria-label="关闭图片"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"><path d="M2.5 2.5L13.5 13.5" stroke="currentColor"/><path d="M13.5 2.5L2.5 13.5" stroke="currentColor"/></svg></button><div class="chat-proto-image-menu" role="menu" aria-label="图片操作" hidden><button type="button" role="menuitem" data-image-copy>${icon("copy", "ico-14")}复制图片</button><button type="button" role="menuitem" data-image-save>${icon("download", "ico-14")}保存图片</button></div></div>`;
    const menu = dialog.querySelector('[role="menu"]'), picture = dialog.querySelector("img"), closeButton = dialog.querySelector("[data-image-close]");
    let composing = false, keyboardComposing = false;
    const imeClick = event => event.detail === 0 && (composing || keyboardComposing);
    dialog.addEventListener("compositionstart", () => { composing = true; });
    dialog.addEventListener("compositionend", () => { composing = false; keyboardComposing = false; });
    dialog.addEventListener("keyup", event => { keyboardComposing = false; event.stopPropagation(); });
    const closeMenu = () => { menu.hidden = true; closeButton.focus({ preventScroll: true }); };
    const openMenu = (event, keyboard = false) => {
      event.preventDefault(); event.stopPropagation();
      const box = picture.getBoundingClientRect();
      menu.hidden = false;
      const size = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(keyboard ? box.left : event.clientX, innerWidth - size.width - 12))}px`;
      menu.style.top = `${Math.max(12, Math.min(keyboard ? box.bottom : event.clientY, innerHeight - size.height - 12))}px`;
      menu.querySelector("button").focus({ preventScroll: true });
    };
    const resize = () => { if (!menu.hidden) closeMenu(); };
    window.addEventListener("resize", resize);
    dialog.addEventListener("close", () => {
      window.removeEventListener("resize", resize);
      dialog.remove();
      if (activeSession() !== openedSession) return;
      const replacement = [...document.querySelectorAll('[data-act="ai-image-view"]')].find(button => button.dataset.draft === el.dataset.draft && button.dataset.index === el.dataset.index && button.closest("[data-ai-message-index]")?.dataset.aiMessageIndex === messageIndex);
      const candidate = el.isConnected ? el : replacement || document.getElementById("ai-input");
      const target = candidate?.getClientRects().length ? candidate : [...document.querySelectorAll('[data-act="ai-toggle"], [data-act="office-ai-toggle"]')].find(button => button.getClientRects().length);
      target?.focus({ preventScroll: true });
    });
    picture.addEventListener("contextmenu", event => openMenu(event));
    dialog.addEventListener("keydown", event => {
      keyboardComposing = composing || event.isComposing || event.keyCode === 229;
      if (keyboardComposing) { event.stopPropagation(); return; }
      if (event.key === "Escape" && event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.target === picture && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) { openMenu(event, true); return; }
      if (!menu.hidden && menu.contains(event.target)) {
        const rows = [...menu.querySelectorAll("button")], index = rows.indexOf(document.activeElement);
        if (event.key === "Escape" || event.key === "Tab" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
          rows[next].focus({ preventScroll: true }); return;
        }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); document.activeElement.click(); return; }
      }
      if (event.key === "Escape") event.stopPropagation();
      if (event.key === "Tab") { event.preventDefault(); closeButton.focus({ preventScroll: true }); }
    });
    dialog.addEventListener("cancel", event => { if (composing || keyboardComposing) event.preventDefault(); else if (!menu.hidden) { event.preventDefault(); closeMenu(); } });
    dialog.addEventListener("click", event => {
      if (event.target === dialog || event.target.classList.contains("chat-proto-image-mask")) dialog.close();
      else if (!menu.hidden && !menu.contains(event.target)) closeMenu();
    });
    closeButton.onclick = event => { if (!imeClick(event)) dialog.close(); };
    dialog.querySelector("[data-image-save]").onclick = event => {
      if (imeClick(event)) return;
      const link = document.createElement("a"); link.href = image.data; link.download = image.name; link.click(); closeMenu();
    };
    dialog.querySelector("[data-image-copy]").onclick = async event => {
      if (imeClick(event)) return;
      closeMenu();
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d").drawImage(picture, 0, 0);
        const png = await new Promise(resolve => canvas.toBlob(resolve));
        if (!png || !navigator.clipboard?.write) throw new Error("clipboard unavailable");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        toast("已复制图片");
      } catch { toast("复制图片失败", "alert"); }
    };
    document.body.append(dialog);
    el.focus({ preventScroll: true });
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }

  function removeRef(index) {
    const session = activeSession();
    refDrafts.set(session, (refDrafts.get(session) || []).filter((_, i) => i !== index));
    UI.render();
  }

  function openMenu(mode) {
    store.aiMenu = mode;
    store.aiMenuQuery = "";
    triggerRange = null;
    UI.render();
    document.getElementById("ai-menu-q")?.focus();
  }

  function resizeInput(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(36, Math.min(336, el.scrollHeight))}px`;
  }
  function inputChanged(el, composing = false) {
    store.aiInput = el.value;
    resizeInput(el);
    store.aiStick = true;
    if (composing) return;
    const end = el.selectionStart, before = el.value.slice(0, end);
    const at = /(?:^|\s)@(?:"([^"\n]*)|([^\s@"]*))$/u.exec(before);
    const slash = /(?:^|[\s(\[{:：，、])\/([^\s/@]*)$/u.exec(before);
    const match = end === el.selectionEnd && (at || (!/(?:\S:\/\/|https?:)\S*$/iu.test(before) && slash));
    if (match) {
      const mode = at ? "at" : "slash";
      const query = match[1] ?? match[2];
      const from = match.index + match[0].indexOf(at ? "@" : "/");
      triggerRange = { session: activeSession(), range: [from, end] };
      refreshSendButton();
      if (store.aiMenu === mode && store.aiMenuQuery === query) return;
      store.aiMenu = mode;
      store.aiMenuQuery = query;
      store.aiPop = null;
      UI.render();
    } else if (store.aiMenu === "at" || store.aiMenu === "slash") openMenu(null);
    else refreshSendButton();
  }

  function refreshSendButton() {
    const button = document.querySelector('.ai-send[data-act="ai-send"]');
    if (!button) return;
    const stop = store.aiBusy && !store.aiInput.trim() && !draftImages().length;
    const label = stop ? "停止" : "发送";
    button.disabled = (!stop && !store.aiInput.trim() && !draftImages().length) || Boolean(draftImages().length && !canAttachImages());
    if (button.title === label) return;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon(stop ? "stop" : "arrowUp", "ico-18");
  }

  function menuItems(mode) {
    const q = (store.aiMenuQuery || "").toLowerCase();
    const projectId = store.projectId;
    const officeRefs = window.OfficeAI?.referenceItems();
    const files = projectId === "PRJ-1042" ? Object.keys(D.files).map(f => ({ icon: "fileText", name: f.split("/").at(-1), meta: f, key: "file:" + f, label: f, insert: "" })) : [];
    const docs = D.knowledge.libraries.filter(l => projectId && (l.allProjects || (l.grantedTo || []).includes(projectId))).flatMap(l => (D.knowledge.docs[l.id] || []).map(d => ({ icon: "book", name: d.title, meta: l.name + " · " + d.path, key: `knowledge:${l.id}:${d.id || d.path}`, insert: "" })));
    const conv = D.ai.sessions.filter(s => (s.projectId ?? "PRJ-1042") === projectId).map(s => ({ icon: "message", name: s.title, meta: "引用仅本项目会话正文", key: "session:" + s.id, insert: "" }));
    const commands = [
      { icon: "target", name: "/goal", meta: "设置或编辑本会话目标", insert: "/goal " },
      ...D.settings.skills.filter(s => s.on).map(s => ({ icon: "layers", name: s.name, meta: "Skill · /" + s.slug, insert: `/${s.slug} `, key: `skill:${s.slug}`, label: `/${s.slug}` })),
      ...D.settings.mcp.filter(m => m.on).map(m => ({
        icon: "box", name: m.name, meta: m.transport,
        tools: (D.settings.toolTree.find(group => group.id === `mcp-${m.name}`)?.tools || []).filter(t => t.on).map(t => {
          const name = `mcp__${m.name}__${t.name}`;
          return { icon: "box", name: t.name, meta: "按消息请求，执行结果以真实事件为准", key: `command:${name}`, label: `/${m.name}/${t.name}`, insert: `请使用已启用的 MCP 工具 ${name} ` };
        })
      })),
      ...D.settings.tools.filter(t => t.on).map(t => ({ icon: "zap", name: t.name, meta: "Tool · " + t.risk + "风险", insert: `请使用已启用工具 ${t.name} `, key: `command:${t.name}`, label: `/${t.name}` }))
    ];
    const items = mode === "at" ? officeRefs || [...files, ...conv, ...docs] : commands;
    const matches = item => `${item.name} ${item.meta} ${item.label || ""}`.toLowerCase().includes(q);
    return items.flatMap(item => {
      if (matches(item)) return [item];
      const tools = item.tools?.filter(matches);
      return tools?.length ? [{ ...item, tools }] : [];
    });
  }

  function menuHtml() {
    const at = store.aiMenu === "at";
    const slash = store.aiMenu === "slash";
    const add = !at && !slash;
    const refGroups = { fileText: "项目文件", message: "本作用域会话", book: "已授权知识" };
    const commandGroups = { layers: "Skill", box: "MCP", zap: "Tool" };
    const items = add ? [] : menuItems(store.aiMenu);
    const row = x => `<button type="button" class="menu-item chat-ref-row" data-act="ai-insert" data-text="${esc(x.insert)}"${x.key ? ` data-ref="${esc(x.key)}" data-label="${esc(x.label || x.name)}"` : ""}>${icon(x.icon, "ico-14")}<span class="mi-main"><b>${esc(x.name)}</b><span>${esc(x.meta)}</span></span></button>`;
    const provider = x => `<details><summary>${esc(x.name)} · ${x.tools.length} 个已发现工具</summary>${x.tools.map(row).join("") || '<div class="ai-menu-group">不可用：未发现工具</div>'}</details>`;
    const groups = Object.entries(at ? refGroups : commandGroups).map(([key, label]) => {
      const rows = items.filter(x => x.icon === key);
      return rows.length ? `<div class="ai-menu-group">${label}</div>${rows.map(key === "box" ? provider : row).join("")}` : "";
    }).join("");
    return `<div class="ai-menu" id="ai-menu" role="dialog" aria-label="${at ? "引用" : slash ? "能力与指令" : "添加与指令"}" data-chat-overlay="${at ? "@" : slash ? "/" : "+"}">
      ${add ? "" : `<div class="ai-menu-q">${at ? "@" : "/"}<input id="ai-menu-q" data-act="ai-menu-q" value="${esc(store.aiMenuQuery || "")}" aria-label="${at ? "筛选引用" : "筛选指令"}" placeholder="${at ? "筛选文件、会话、知识" : "筛选 Skill / MCP / Tool"}"></div>`}
      <div class="ai-menu-list">
        ${add ? `
          <div class="ai-menu-group">添加</div>
          <button class="menu-item chat-menu-row-rich" data-act="ai-pick" data-kind="file"><span class="cmr-ico">${icon("file", "ico-14")}</span><span class="cmr-label">文件<span class="cmr-kw">file</span></span><span class="cmr-desc">插入本地文件完整路径</span></button>
          <button class="menu-item chat-menu-row-rich" data-act="ai-pick" data-kind="image" ${canAttachImages() ? "" : 'disabled title="当前通道暂不支持图片"'}><span class="cmr-ico">${icon("image", "ico-14")}</span><span class="cmr-label">图片<span class="cmr-kw">image</span></span><span class="cmr-desc">${canAttachImages() ? "添加图片附件" : "当前通道不支持图片"}</span></button>
          <button class="menu-item chat-menu-row-rich" data-act="ai-insert" data-text="/goal "><span class="cmr-ico">${icon("target", "ico-14")}</span><span class="cmr-label">目标<span class="cmr-kw">goal</span></span><span class="cmr-desc">/目标 命令，设置或查看长期任务目标</span></button>
          <div class="ai-menu-group">指令</div>
          <button class="menu-item chat-menu-row-rich" data-act="ai-permission"><span class="cmr-ico">${icon("shield", "ico-14")}</span><span class="cmr-label">权限<span class="cmr-kw">permission</span></span><span class="cmr-desc">切换权限预设</span></button>
          <button class="menu-item chat-menu-row-rich" data-act="ai-search-grant"><span class="cmr-ico">${icon("search", "ico-14")}</span><span class="cmr-label">搜索授权<span class="cmr-kw">search</span></span><span class="cmr-desc">为当前会话添加项目外的搜索目录</span></button>
          <button class="menu-item chat-menu-row-rich" data-act="ai-model"><span class="cmr-ico">${icon("cpu", "ico-14")}</span><span class="cmr-label">模型<span class="cmr-kw">model</span></span><span class="cmr-desc">选择本会话使用的模型</span></button>
          <button class="menu-item chat-menu-row-rich" data-act="ai-pick" data-kind="command"><span class="cmr-ico">${icon("command", "ico-14")}</span><span class="cmr-label">能力与指令<span class="cmr-kw">commands</span></span><span class="cmr-desc">进入 / 指令与技能列表</span></button>
          <button class="menu-item chat-menu-row-rich" disabled title="ZIP 导出未接入"><span class="cmr-ico">${icon("download", "ico-14")}</span><span class="cmr-label">下载日志<span class="cmr-kw">export</span></span><span class="cmr-desc">不可用</span></button>
        ` : (items.length ? items.filter(x => x.icon === "target").map(row).join("") + groups : '<div class="caption ai-menu-group">没有匹配</div>')}
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
    return `<span class="m-cap ctx" title="上下文 ${esc(m.ctx || "未知")}" aria-label="上下文 ${esc(m.ctx || "未知")}"><b>${esc(CR074.capacity(m))}</b></span>`;
  }
  function capFlag(kind, on, label, ico) {
    return `<span class="m-cap ${kind} ${on ? "on" : "off"}" title="${esc(label)}：${on ? "支持" : "不支持"}" aria-label="${esc(label)}：${on ? "支持" : "不支持"}">${icon(ico, "ico-13")}</span>`;
  }

  /* ---------------- 底部弹层：CLI / 权限 / 模型 ---------------- */
  function popups() {
    if (store.aiPop === "runner") return window.CR069 ? CR069.runnerPopup() : "";
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
      const isButler = !!(window.CR069 && CR069.isPlatform());
      const list = isButler ? ((window.CR079 && CR079.platformPermissions) || []) : (D.ai.permissions || []);
      const current = isButler ? store.platformPermission : store.aiPermission;
      const act = isButler ? "ai-platform-perm-set" : "ai-perm-set";
      const permTitle = isButler ? "助理权限" : "权限模式";
      return `<div class="ai-pop ai-pop-perm" id="ai-popup-perm" data-ai-popup="perm" role="dialog" aria-label="${permTitle}" tabindex="-1">
        <div class="pop-h">${permTitle}<button class="icon-btn" data-ai-popup-close="perm" aria-label="关闭权限选择">${icon("x", "ico-14")}</button></div>
        ${list.map(p => `<button class="menu-item perm ${current === p.name ? "on" : ""}" data-act="${act}" data-name="${esc(p.name)}" ${runtimeBusy() || p.available === false ? 'disabled aria-disabled="true"' : ""}>${icon(p.icon || "shield", "ico-14")}<span class="mi-main"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span>${current === p.name ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`).join("") || '<div class="drop-empty">没有可用的权限模式。</div>'}
      </div>`;
    }
    if (store.aiPop === "searchgrant") {
      const root = store.projectRoot || "D:\\github\\AI_Delelovelop";
      const dirs = store.aiSearchDirs || [];
      return `<div class="ai-pop ai-pop-search" id="ai-popup-searchgrant" data-ai-popup="searchgrant" role="dialog" aria-label="搜索授权" tabindex="-1">
        <div class="pop-h">搜索授权（本会话）<button class="icon-btn" data-ai-popup-close="searchgrant" aria-label="关闭搜索授权">${icon("x", "ico-14")}</button></div>
        <div class="menu-hint">本地搜索默认包含当前项目根目录，无需授权；此处添加的目录仅本会话有效。</div>
        <div class="menu-item" aria-disabled="true"><span class="mi-main"><b class="mono">${esc(root)}</b><span>项目根 · 默认包含，不可移除</span></span></div>
        <div class="menu-sep"></div>
        ${dirs.length ? dirs.map(d => `<div class="menu-item"><span class="mi-main"><b class="mono">${esc(d)}</b><span>本会话额外授权</span></span><button class="icon-btn" data-act="ai-search-grant-remove" data-dir="${esc(d)}" aria-label="移除该目录">${icon("trash", "ico-14")}</button></div>`).join("") : '<div class="drop-empty">尚未添加额外目录。</div>'}
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="ai-search-grant-add">${icon("plus", "ico-14")}添加目录（仅本会话）</button>
        <div class="menu-hint">规划模式会话只搜索项目根；需要项目外目录时在此添加。</div>
      </div>`;
    }
    if (store.aiPop === "model") {
      const cat = D.ai.modelCatalog, p = (cat.providers || []).find(x => x.name === (store.aiModelBrowse || cat.current.provider)) || (cat.providers || [])[0], models = visibleModels(p), cm = currentModel(), levels = CR074.efforts(cm);
      const q = (store.aiModelQuery || "").toLowerCase();
      const filtered = models.filter(m => !q || m.name.toLowerCase().includes(q));
      return `<div class="ai-pop ai-pop-model" id="ai-popup-model" data-ai-popup="model" role="dialog" aria-label="选择模型" tabindex="-1">
        <div class="pop-h">模型 <span class="caption"><b>${esc(cm.name)}</b> ${esc(cat.current.provider)}</span><button class="icon-btn" data-ai-popup-close="model" aria-label="关闭模型选择">${icon("x", "ico-14")}</button></div>
        <label class="search">${icon("search", "ico-14")}<input class="input" id="ai-model-q" data-act="ai-model-q" value="${esc(store.aiModelQuery || "")}" placeholder="搜索模型…"></label>
        <div class="model-grid" data-ai-resize-root="model">
          <div class="model-providers" data-pane="ai-model-providers" data-pane-default="112" data-pane-min="96" data-pane-max="180">${(cat.providers || []).map(pp => { const n = visibleModels(pp).filter(usableModel).length; return `<button class="provider-row ${pp.name === (store.aiModelBrowse || cat.current.provider) ? "on" : ""}" data-act="ai-model-provider" data-name="${esc(pp.name)}" ${runtimeBusy() || !n || pp.enabled === false || pp.available === false ? 'disabled aria-disabled="true"' : ""}><span class="ellipsis">${esc(pp.name)}</span><span class="count">${n}</span></button>`; }).join("")}</div>
          <div class="model-list" data-pane-center-min="160">${filtered.length ? filtered.map(m => `<button class="model-row ${m.name === cm.name && p?.name === cat.current.provider ? "on" : ""}" data-act="ai-model-set" data-provider="${esc(p.name)}" data-name="${esc(m.name)}" ${runtimeBusy() || !usableModel(m) || p?.enabled === false || p?.available === false ? 'disabled aria-disabled="true"' : ""}>
            <span class="mr-name ellipsis">${esc(m.name)}</span>
            <span class="mr-caps">${capCtx(m)}${capFlag("vision", !!m.vision, "视觉", "eye")}${CR074.thinkFlag(m)}</span>
          </button>`).join("") : `<div class="empty" style="padding:16px"><b>${models.length ? "没有匹配" : "没有可用模型"}</b><p>${models.length ? "换关键词，或检查供应商配置。" : "检查供应商配置；不回退到生图模型。"}</p></div>`}</div>
        </div>
        <div class="model-level ${cm.thinking ? "" : "disabled"}"><div class="row between"><b>思考等级</b><span class="caption">${cm.thinking ? esc(cat.current.level) : "该模型未声明思考档位"}</span></div>
          ${levels.length ? `<input type="range" min="0" max="${levels.length - 1}" step="1" value="${Math.max(0, levels.indexOf(cat.current.level))}" style="--effort-percent:${levels.length > 1 ? Math.max(0, levels.indexOf(cat.current.level)) / (levels.length - 1) * 100 : 0}%" data-act="ai-level" class="range" aria-label="思考等级" ${runtimeBusy() || !usableModel(cm) ? "disabled" : ""}>
          <div class="level-labels">${levels.map(l => `<button data-act="ai-level-label" data-level="${esc(l)}" aria-pressed="${l === cat.current.level}" ${runtimeBusy() ? "disabled" : ""}>${esc(CR074.effortLabel(l))}</button>`).join("")}</div>` : '<div class="level-note">不支持思考档位，选择其它模型后可调整。</div>'}
        </div>
      </div>`;
    }
    return "";
  }

  /* ---------------- 统计：输入框下方，弹层右对齐各自控件 ---------------- */
  function statPop(kind) {
    const s = D.ai.stats;
    /* CR-101 R6/R12：详情与统计条同一判空口径；未知字段写「未上报」，不显示「—」冒充数值；
       TPS 区分「生成中实时值」与「本轮闭合测量」，两种口径不并列、不混算。 */
    const has = value => value != null && String(value).trim() !== '' && !/未知|未计|未上报|^—$/.test(String(value).trim());
    const shown = value => has(value) ? esc(value) : "未上报";
    const live = s.liveActive === true && has(s.liveTps);
    const counts = [has(s.rounds) ? `${esc(s.rounds)} 轮` : "", has(s.steps) ? `${esc(s.steps)} 步` : ""].filter(Boolean).join(" ");
    // CR-101：实时值始终是密度估算，统计条与详情统一带 `~` 前缀；权威结算值不带。
    const liveText = live ? `~${String(s.liveTps).trim().replace(/^~+/, "")}` : "";
    const speed = liveText ? esc(liveText) : has(s.tps) ? esc(s.tps) : "";
    if (kind === "session") return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="会话统计"><div class="pop-h">会话统计</div><div class="stat-rows">
      <div><span>轮次 / 执行步数</span><b>${counts || "未上报"}</b></div><div><span>模型用时</span><b>${shown(s.modelTime)}</b></div><div><span>工具调用用时</span><b>${shown(s.toolTime)}</b></div><div><span>首 token 平均（TTFT）</span><b>${shown(s.ttft)}</b></div><div><span>输出速度（TPS）</span><b>${speed ? `${speed}（${liveText ? "生成中实时估算" : "本轮闭合测量"}）` : "未上报"}</b></div></div></div>`;
    if (kind === "tokens") return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="Token 用量"><div class="pop-h">Token 用量 <span class="caption">${shown(s.tokens.total)}</span></div><div class="stat-rows">
      <div><span>缓存命中</span><b>${shown(s.tokens.cacheHit)}</b></div><div><span>未缓存输入</span><b>${shown(s.tokens.uncached)}</b></div><div><span>缓存读取</span><b>${shown(s.tokens.cacheRead)}</b></div><div><span>输出</span><b>${shown(s.tokens.output)}</b></div></div></div>`;
    return `<div class="ai-pop ai-pop-stat" role="dialog" aria-label="上下文"><div class="pop-h">上下文 <span class="caption">${has(s.context.used) ? `已用 ${esc(s.context.used)} · ${shown(s.context.detail)}` : "未上报"}</span></div><div class="stat-rows">
      <div><span>系统提示词</span><b>${shown(s.context.system)}</b></div><div><span>工具定义</span><b>${shown(s.context.tools)}</b></div><div><span>对话消息</span><b>${shown(s.context.messages)}</b></div></div></div>`;
  }

  function statWrap(kind, label, content) {
    return `<span class="ai-stat-wrap"><button class="s" data-act="ai-stat" data-stat="${kind}" aria-label="${esc(label)}" aria-expanded="${store.aiPop === kind}">${content}</button>${store.aiPop === kind ? statPop(kind) : ""}</span>`;
  }

  function statsRow() {
    return CR074.statsRow(statWrap);
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

  /* CR-074：同一组件，两种布局；输入、模型、统计、步骤与动作不再复制。 */
  function composerBlock(workbench = false) {
    const cli = D.settings.clis.find(c => c.id === store.aiCli) || { id: "", name: "未配置 CLI" };
    const cm = currentModel(), busy = runtimeBusy();
    const platformRunner = !!(window.CR069 && CR069.isPlatform());
    const cliDisabled = busy || platformRunner || !D.settings.clis.some(usableCli);
    const permDisabled = busy || (!platformRunner && !(D.ai.permissions || []).some(p => p.available !== false && p.enabled !== false));
    const modelDisabled = busy;
    const modelUnavailable = !(D.ai.modelCatalog.providers || []).some(p => p.enabled !== false && p.available !== false && visibleModels(p).some(usableModel));
    const images = draftImages();
    const stop = store.aiBusy && !store.aiInput.trim() && !images.length;
    const sendLabel = stop ? "停止" : "发送";
    const sendDisabled = !stop && ((!store.aiInput.trim() && !images.length) || (images.length && !canAttachImages()));
    return `      <div class="ai-composer-wrap ${workbench ? "wb-composer" : ""}">
        <div class="ai-plan-dock">${ChatDock.render(activeSession())}</div>
        ${store.aiMenu ? menuHtml() : ""}
        <div class="ai-composer">
          <div class="ai-hat" role="group" aria-label="运行与工作区">
            <div class="ai-hat-seg" role="tablist" aria-label="运行通道">
              <button type="button" class="ai-hat-opt ${!platformRunner ? "on" : ""}" data-act="ai-runner-set" data-id="cli" ${busy ? "disabled" : ""} title="CLI 进程：由已安装的 CLI 作答，支持原生续接">${icon("terminal", "ico-13")}CLI</button>
              <button type="button" class="ai-hat-opt ${platformRunner ? "on" : ""}" data-act="ai-runner-set" data-id="platform" ${busy ? "disabled" : ""} title="助理：平台主代理直接调用已配置模型作答">${icon("sparkles", "ico-13")}助理</button>
            </div>
            <span class="ai-hat-spacer"></span>
            ${store.gitBranch ? `<div class="ai-hat-branch-wrap"><button type="button" class="ai-hat-branch" data-act="ai-branch" aria-haspopup="menu" aria-expanded="${store.aiBranchMenu ? "true" : "false"}" title="当前分支：${esc(store.gitBranch)}（点击查看其它分支）">${icon("branch", "ico-13")}<span class="ellipsis">${esc(store.gitBranch)}</span>${icon("chevronDown", "ico-12")}</button>${store.aiBranchMenu ? `<div class="ai-branch-menu" role="menu" aria-label="选择分支">${(store.gitBranches || []).map(b => `<button type="button" class="ai-branch-item ${b === store.gitBranch ? "on" : ""}" role="menuitem" data-act="ai-branch-pick" data-branch="${esc(b)}">${b === store.gitBranch ? icon("check", "ico-12") : '<span class="ai-branch-dot"></span>'}<span class="ellipsis">${esc(b)}</span></button>`).join("")}</div>` : ""}</div>` : ""}
            <label class="ai-hat-worktree" title="勾选后当前会话将在独立 git worktree 工作区执行"><input type="checkbox" data-act="ai-worktree" ${store.aiWorktree ? "checked" : ""} ${busy ? "disabled" : ""}><span>worktree</span></label>
          </div>
          ${referenceMarkup(refDrafts.get(activeSession()), true)}
          ${imageMarkup(images, true)}
          ${images.length && !canAttachImages() ? '<div class="chat-proto-image-error" role="alert">当前通道暂不支持图片</div>' : ""}
          <input type="file" id="ai-image-input" hidden multiple accept="${imageTypes.join(",")}">
          <textarea id="ai-input" rows="1" aria-label="会话输入" placeholder="${window.OfficeAI && OfficeAI.isActive() ? "描述办公意图，/ 调用指令，@ 项目资料或对话" : "描述你想构建的内容，/ 调用指令，@ 文件或对话"}">${esc(store.aiInput)}</textarea>
          <div class="ai-tools"><span class="ai-leading-controls">
            <button class="ai-chip icon-only" data-act="ai-menu-open" data-tab="add" title="添加" aria-label="添加">${icon("plus")}</button>
            ${!platformRunner ? anchorSlot("cli", `<button class="ai-chip cli" id="ai-anchor-cli" data-ai-anchor="cli" data-act="ai-cli" aria-haspopup="dialog" aria-controls="ai-popup-cli" aria-expanded="${store.aiPop === "cli"}" ${cliDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : platformRunner ? "平台会话不使用 CLI；可用操作由平台工具白名单决定" : cliDisabled ? "没有可用 CLI" : "切换 CLI：" + esc(cli.name)}" aria-label="切换 CLI：${esc(cli.name)}">${cliLogo(cli.id, 16)}</button>`) : ""}
            ${anchorSlot("perm", `<button class="ai-chip perm" id="ai-anchor-perm" data-ai-anchor="perm" data-act="ai-permission" aria-haspopup="dialog" aria-controls="ai-popup-perm" aria-expanded="${store.aiPop === "perm"}" ${permDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : platformRunner ? "助理运行权限（平台工具白名单与运行策略）" : "权限模式"}" aria-label="权限模式">${icon("shield")}${esc(platformRunner ? store.platformPermission : store.aiPermission)}</button>`)}
            </span><span class="ai-send-group">${anchorSlot("model", `<button class="ai-chip model" id="ai-anchor-model" data-ai-anchor="model" data-act="ai-model" aria-haspopup="dialog" aria-controls="ai-popup-model" aria-expanded="${store.aiPop === "model"}" ${modelDisabled ? 'disabled aria-disabled="true"' : ""} title="${busy ? "运行中配置已锁定" : modelUnavailable ? "当前通道没有可用模型，点击查看原因" : !usableModel(cm) ? "当前模型失效，请重新选择" : "选择模型：" + esc(D.ai.modelCatalog.current.provider + " · " + cm.name + " " + CR074.effortLabel(D.ai.modelCatalog.current.level))}" aria-label="选择模型"><span class="ai-model-name">${esc(D.ai.modelCatalog.current.provider)} · ${esc(cm.name)}${cm.available === false ? "（不可用）" : ""}</span><span class="ai-model-effort">${esc(CR074.efforts(cm).length ? CR074.effortLabel(D.ai.modelCatalog.current.level) : "默认")}</span>${icon("chevronUp", "ico-12")}</button>`)}
            <button class="ai-send" data-act="ai-send" title="${sendLabel}" aria-label="${sendLabel}" ${sendDisabled ? "disabled" : ""}>${icon(stop ? "stop" : "arrowUp", "ico-18")}</button></span>
          </div>
        </div>
        ${statsRow()}
      </div>`;
  }

  function render() {
    const agent = currentAgent();
    if (store.aiAgent && agent) return agentView(agent);
    if (store.aiAgent && !agent) store.aiAgent = null;
    const msgs = store.aiMessages;
    const cli = D.settings.clis.find(c => c.id === store.aiCli) || { id: "", name: "未配置 CLI" };
    const cm = currentModel(), busy = runtimeBusy();
    const platformRunner = !!(window.CR069 && CR069.isPlatform());
    const cliDisabled = busy || platformRunner || !D.settings.clis.some(usableCli);
    const permDisabled = busy || (!platformRunner && !(D.ai.permissions || []).some(p => p.available !== false && p.enabled !== false));
    const modelDisabled = busy;
    const modelUnavailable = !(D.ai.modelCatalog.providers || []).some(p => p.enabled !== false && p.available !== false && visibleModels(p).some(usableModel));
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
       ${composerBlock()}
    </aside>`;  }

  function afterRender() {
    resizeInput(document.getElementById("ai-input"));
    ChatDock.syncStateDots();
    const sc = document.getElementById("ai-scroll") || document.getElementById("wb-scroll");
    if (sc && store.aiStick !== false) sc.scrollTop = sc.scrollHeight;
    // CR-063：搜索输入保持焦点与光标；继续加载后恢复列表滚动位置，避免视觉跳动。
    const hl = document.querySelector(".ai-history-list");
    if (hl && store.aiHistScroll) { hl.scrollTop = store.aiHistScroll; store.aiHistScroll = 0; }
  }

  function switchSession(id) {
    if (window.OfficeAI && OfficeAI.switchSession(id)) return;
    const s = D.ai.sessions.find(x => x.id === id);
    if (!s) return;
    window.CR037?.beforeSwitchSession(s);
    selectCodeSession(s);
    store.aiAgent = null;
    if (!requestStates.get(s)?.running) s.status = "read";
    store.aiHistory = false;
    store.aiHistLimit = 20; store.aiHistQuery = ""; store.aiHistFocus = false;
    render && UI.render();
  }

  function newSession(feature) {
    if (window.OfficeAI && OfficeAI.newSession()) return;
    store.aiAgent = null;
    const cur = activeSession();
    cur.messages = store.aiMessages;
    cur.tokens = cur.tokens || "0";
    const id = "S-" + Date.now().toString().slice(-6);
    const session = { id, title: feature ? `执行 ${feature.id} · ${feature.title}` : "新会话", status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: [] };
    if (feature) { session.featureId = feature.id; session.featureTitle = feature.title; session.sessionRole = "executor"; }
    selectCodeSession(session);
    D.ai.sessions.unshift(session);
    toast("已新建会话，原会话已保留在历史中");
    UI.render();
  }

  function reply(text, extra, request) {
    const { session, messages, current, queue } = request;
    messages.push({ role: "assistant", time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }), text, ...extra });
    session.status = extra?.failed ? "failed" : "success";
    session.updated = "刚刚";
    request.running = false;
    const next = queue.shift();
    if (next) sendMessage(next, request);
    else if (current()) UI.render();
  }

  function sendMessage({ text, refs, images }, request) {
    const { session, current, context, messages } = request;
    messages.push({ role: "user", time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }), text, refs, images });
    session.messages = messages;
    session.status = "pending";
    if (session.title === "新会话") session.title = (text || images[0]?.name || "新会话").slice(0, 32);
    request.running = true;
    request.startedAt = Date.now();
    const generation = ++request.generation;
    if (current()) { store.aiStick = true; UI.render(); }
    setTimeout(() => {
      if (generation !== request.generation) return;
      if (context?.projectId) {
        const result = OfficeAI.response(context, text, refs);
        reply(result.text, result, request);
      } else reply("收到。这是仿真会话：我会先核对当前运行与 AC 证据，再给出下一步；真实模型、文件写入与命令执行均未接入。", {
        tools: [{ name: "fs.read", arg: "docs/Plan/Story/STORY-0102.md", state: "完成", detail: "读取 1.2 KB · 3 条 AC" }]
      }, request);
    }, 900);
  }

  function send() {
    if (window.CR037?.send()) return;
    const text = (store.aiInput || "").trim();
    const session = activeSession(), images = draftImages();
    if (!session) return;
    const activeRequest = requestStates.get(session);
    if (!images.length && /^\/goal(?:\s|$)/u.test(text)) {
      const objective = text.slice(5).trim();
      store.aiInput = "";
      if (objective) {
        session.goal = objective;
        session.goalPaused = false;
        openMenu(null);
        document.getElementById("ai-input")?.focus();
      } else ChatDock.edit();
      return;
    }
    if (!text && !images.length) {
      if (activeRequest?.running) {
        activeRequest.generation++;
        activeRequest.running = false;
        activeRequest.queue.length = 0;
        session.status = "failed";
        UI.render();
        toast("已停止本次生成");
      }
      return;
    }
    if (images.length && !canAttachImages()) return;
    const payload = { text, images, refs: refDrafts.get(session) || [] };
    store.aiInput = "";
    store.aiMenu = null;
    triggerRange = null;
    imageDrafts.delete(session);
    refDrafts.delete(session);
    if (activeRequest?.running && (D.settings.general.sendMode || "queue") === "queue") {
      activeRequest.queue.push(payload);
      UI.render();
      return;
    }
    if (activeRequest?.running) toast("已立即发送（打断当前生成）", "send");
    if (activeRequest) { activeRequest.generation++; activeRequest.queue.length = 0; }
    const context = window.OfficeAI?.captureRequest();
    const request = {
      session, context, messages: store.aiMessages, queue: [], generation: 0,
      current: () => D.ai.sessions.includes(session) && store.aiSession === session.id && (!context || context.current())
    };
    requestStates.set(session, request);
    sendMessage(payload, request);
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
    activeSession().messages = store.aiMessages;
    UI.render();
  }

  function insert(text, reference) {
    const session = activeSession();
    const input = document.getElementById("ai-input");
    const cur = store.aiInput;
    const caret = input?.selectionStart ?? cur.length;
    const [from, to] = triggerRange?.session === session ? triggerRange.range : [caret, input?.selectionEnd ?? caret];
    if (reference) {
      const refs = refDrafts.get(session) || [];
      if (!refs.some(r => r.key === reference.key)) refDrafts.set(session, [...refs, reference]);
    }
    store.aiInput = cur.slice(0, from) + text + cur.slice(to);
    store.aiMenu = null;
    store.aiMenuQuery = "";
    triggerRange = null;
    UI.render();
    const el = document.getElementById("ai-input");
    if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(from + text.length, from + text.length); }
  }

  return { composerBlock, historyRail, message, finalText, workingRow, statsRow, agentDrop, backgroundDrop, render, afterRender, send, approve, insert, switchSession, newSession, menuHtml, cliLogo, activeSession, currentModel, visibleModels, inputChanged, openMenu, addImages, canAttachImages, removeImage, imageView, removeRef, selectCodeSession, syncRequestState };
})();