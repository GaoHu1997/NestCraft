/* CR-043 · 共享 AIPanel 的办公数据适配；继承 CR-042 公共侧栏，仅合成内存状态，不联网、不读真实文件。 */
window.OfficeAI = (function () {
  "use strict";
  const { D, store, esc, icon } = UI;
  const codeAI = D.ai, projects = new Map(), codeState = {};
  const defaults = { aiHistory: false, aiTop: null, aiBgOpen: null, aiStepsOpen: true, aiMenu: null, aiMenuQuery: "", aiStats: null, aiMenuTab: "add", aiBusy: false, aiGen: 0, aiPermission: "默认模式", aiCli: "claude", aiInput: "", aiStick: true, aiQueue: [], aiPop: null, aiModelQuery: "", aiModelMenu: false, aiPermissionMenu: false, aiCliMenu: false, aiSubagents: false, aiBackground: false, aiContext: false, aiTokens: false };
  const keys = [...Object.keys(defaults), "aiMessages", "aiSession", "aiOpen"];
  let pid = null, serial = 0;
  const clone = x => structuredClone(x);
  const selected = p => p.data.sessions.find(s => s.id === p.sessionId);
  const snapshot = target => { keys.forEach(k => { target[k] = store[k]; }); return target; };
  const apply = source => keys.forEach(k => { store[k] = source[k]; });
  const filePath = (projectId, f) => Office.model.filePath ? Office.model.filePath(projectId, f.id) : f.name;
  const stats = rounds => ({ simulated: true, rounds, duration: "未计时（仿真）", modelTime: "未调用", toolTime: "未计时", ttft: "未知", tps: "—", tokens: { total: "—", cacheHit: "—", uncached: "未知", cacheRead: "未知", output: "未知" }, context: { used: "—", detail: "仅本项目与本会话；没有真实模型用量", system: "未知", tools: "未知", messages: "未知" } });
  function references(projectId) {
    const p = Office.model.getProject(projectId);
    return p.files.filter(f => !(p.scenario === "no-permission" && f.source)).map(f => {
      const r = Office.model.readReference(projectId, { fileId: f.id, location: { kind: "document" } });
      return { file: f, path: filePath(projectId, f), citation: r.ok ? { fileId: r.fileId, name: r.name, location: r.location, revision: r.revision, fingerprint: r.fingerprint } : null, excerpt: r.ok ? r.text : "", readable: r.ok };
    });
  }
  function summary(ref) {
    return String(ref?.excerpt || "暂无可引用的正文；需检查源格式与权限").replace(/\s+/g, " ").slice(0, 150);
  }
  function session(projectId, n, seeded) {
    const p = D.projects.find(x => x.id === projectId), refs = references(projectId);
    const selectedId = Office.model.getProject(projectId).selectedId;
    const first = refs.find(x => x.readable && x.file.id === selectedId) || refs.find(x => x.readable);
    const second = refs.find(x => x.readable && x.file.type === "xlsx") || refs.find(x => x.readable && x !== first) || first;
    const id = "OFFICE-" + projectId + "-" + (++serial);
    const messages = !seeded ? [] : n === 0 ? [
      { role: "user", time: "09:20", text: `整理${p.name}当前资料，给出简报摘要和下一步核对事项。` },
      { role: "assistant", time: "09:21", text: `**${p.name} · 资料简报**\n\n${first ? `先从《${first.file.name}》确认讨论范围：${summary(first)}` : "当前项目尚无可读资料，请先添加文件。"}\n\n| 当前资料 | 阅读与交付用途 |\n| --- | --- |\n${refs.slice(0, 4).map(r => `| ${r.file.name.replace(/\|/g, "／")} | ${r.readable ? r.file.type === "xlsx" ? "核对口径、公式与合计" : r.file.type === "pptx" ? "核对汇报结构与结论" : "提取要点并保留来源" : "格式或权限待检查"} |`).join("\n")}\n\n**建议顺序**\n1. 核对数据口径与资料版本。\n2. 将有来源的结论与待验证判断分开。\n3. 确认受众后生成候选，再逐项审阅与保存。\n\n合成业务情景，未访问真实资料；尚未发送文件给模型。`, sources: [first, second].filter((r, i, a) => r?.citation && a.indexOf(r) === i).map(r => r.citation), tools: first ? [{ name: "office.inspect", state: "完成", arg: first.path, detail: "合成文件结构检查 · 原件未修改" }] : [] }
    ] : [
      { role: "user", time: "10:05", text: `把${p.name}资料整理为三页汇报，保留证据和待确认项。` },
      { role: "assistant", time: "10:06", text: `**汇报结构建议**\n\n- 第 1 页：范围与背景。${first ? `依据《${first.file.name}》：${summary(first)}` : "等待选择资料。"}\n- 第 2 页：资料证据。${second ? `优先复核《${second.file.name}》中的口径与结论。` : "尚无可引用证据。"}\n- 第 3 页：行动与待确认事项。明确负责人、下一次复核节点；未核验的数字不作为结论。\n\n当前仅完成合成结构整理。生成文件前，请确认来源、受众和发送范围；候选不会覆盖原件，接受后仍需保存。`, sources: first?.citation ? [first.citation] : [], officeAction: { kind: "ppt", purpose: `整理${p.name}三页评审汇报` }, tools: [{ name: "office.outline", state: "完成", arg: "三页汇报结构", detail: "只拟定结构 · 未生成或发送文件" }] }
    ];
    const s = { id, title: seeded ? p.name + (n ? " · 汇报结构" : " · 资料简报") : "新会话", status: seeded ? "success" : "read", updated: seeded ? "今天 · 仿真" : "刚刚", tokens: "用量未知", duration: "未计时", messages, goal: "核对本项目来源，整理可审阅的报告与汇报；保留待确认事项。", steps: seeded ? [{ title: "确认当前项目资料范围", state: "done", meta: "合成场景" }, { title: n ? "拟定汇报结构与证据位置" : "整理简报与资料口径", state: "done", meta: "合成场景" }, { title: "确认来源后生成并人工审阅", state: "todo" }] : [] };
    s.state = { ...clone(defaults), aiSession: id, aiMessages: messages, aiOpen: true };
    s.data = { stats: stats(seeded ? 1 : 0), subagents: seeded ? [{ cli: "claude", title: n ? "汇报结构核对（合成）" : "资料口径核对（合成）", model: codeAI.modelCatalog.current.model, duration: "未计时", tokens: "用量未知", status: "已完成" }] : [], background: seeded && first ? [{ jobId: id + "-inspect", cmd: "office.inspect " + first.path, state: "已结束", exit: "0", duration: "未计时", output: "合成结构检查已结束。未启动真实命令，未写入原件。" }] : [], feedback: [], current: clone(codeAI.modelCatalog.current) };
    s.office = null;
    return s;
  }
  function ensure(projectId) {
    if (!projects.has(projectId)) {
      const seeded = Office.model.getProject(projectId).loaded;
      const sessions = seeded ? [session(projectId, 0, true), session(projectId, 1, true)] : [session(projectId, 0, false)];
      projects.set(projectId, { sessionId: sessions[0].id, data: { sessions, permissions: codeAI.permissions, modelCatalog: { providers: codeAI.modelCatalog.providers, levels: codeAI.modelCatalog.levels, current: sessions[0].data.current } } });
      if (Office.captureSession) sessions[0].office = Office.captureSession(projectId);
    }
    return projects.get(projectId);
  }
  function save() {
    if (!pid) { snapshot(codeState); return; }
    const p = ensure(pid), s = selected(p);
    snapshot(s.state); s.messages = store.aiMessages;
    s.data = { stats: D.ai.stats, subagents: D.ai.subagents, background: D.ai.background, feedback: D.ai.feedback || [], current: D.ai.modelCatalog.current };
    if (Office.captureSession) s.office = Office.captureSession(pid);
  }
  function load(projectId) {
    const p = ensure(projectId), s = selected(p);
    D.ai = p.data;
    Object.assign(D.ai, { stats: s.data.stats, subagents: s.data.subagents, background: s.data.background, feedback: s.data.feedback });
    D.ai.modelCatalog.current = s.data.current;
    // Inventory remains global; only the current selection belongs to this conversation.
    D.ai.modelCatalog.providers = codeAI.modelCatalog.providers;
    D.ai.modelCatalog.levels = codeAI.modelCatalog.levels;
    apply(s.state);
    if (Office.restoreSession) Office.restoreSession(projectId, s.office);
    store.aiOpen = Office.isOpen(projectId);
  }
  function activate(win) {
    const next = win.kind === "project" && D.projects.find(p => p.id === win.refId)?.kind === "work" ? win.refId : null;
    if (next !== pid) { save(); pid = next; if (pid) load(pid); else { D.ai = codeAI; apply(codeState); } }
    if (pid) {
      store.aiOpen = Office.isOpen(pid);
      D.ai.stats.rounds = store.aiMessages.filter(m => m.role === "user").length;
    }
  }
  function switchSession(id) {
    if (!pid) return false;
    const p = ensure(pid); if (!p.data.sessions.some(s => s.id === id)) return true;
    save(); p.sessionId = id; load(pid); store.aiHistory = false; UI.render(); return true;
  }
  function newSession() {
    if (!pid) return false;
    save(); const p = ensure(pid), s = session(pid, 0, false); p.data.sessions.unshift(s); p.sessionId = s.id;
    load(pid); UI.toast("已新建会话，原会话已保留在历史中"); UI.render(); return true;
  }
  function referenceItems() {
    if (!pid) return null;
    const files = references(pid).map(r => ({ icon: "fileText", name: r.path, meta: "当前项目文件" + (r.readable ? "" : " · 不可读取"), insert: "@" + r.path }));
    const libraries = D.knowledge.libraries.filter(l => l.allProjects || (l.grantedTo || []).includes(pid));
    const docs = libraries.flatMap(l => (D.knowledge.docs[l.id] || []).map(d => ({ icon: "book", name: d.title, meta: "已授权知识 · " + l.name + " / " + d.path, insert: "@" + d.title })));
    const conv = D.ai.sessions.map(s => ({ icon: "message", name: s.title, meta: "当前项目会话", insert: "@" + s.title }));
    return [...files, ...conv, ...docs];
  }
  function filePicker() {
    const items = referenceItems() || [];
    UI.openDialog(UI.dlgShell("选择文件或对话", "仅当前项目文件、已授权知识与本项目会话；引用不代表发送授权。", `<div class="stack-sm">${items.map(x => `<button class="menu-item" data-act="officeai-insert" data-text="${esc(x.insert)}">${icon(x.icon, "ico-14")}<span class="mi-main"><b>${esc(x.name)}</b><span>${esc(x.meta)}</span></span></button>`).join("") || '<p class="caption">暂无可引用资料，请先添加本项目文件。</p>'}</div>`, '<button class="btn" data-act="close-dialog">取消</button>', "modal-md"));
  }
  function captureRequest() {
    // Keep a stable backing object. Late callbacks address the captured project/session,
    // never whichever global projection happens to be visible when the timer fires.
    const projectId = pid, sessionId = store.aiSession, ai = D.ai;
    const s = ai.sessions.find(x => x.id === sessionId), backing = pid ? s.state : codeState;
    snapshot(backing);
    const current = () => pid === projectId && store.aiSession === sessionId;
    const state = new Proxy(backing, { get: (o, k) => current() ? store[k] : o[k], set: (o, k, v) => { o[k] = v; if (current()) store[k] = v; return true; } });
    return { projectId, sessionId, ai, session: s, state, current, refs: projectId ? references(projectId) : [], selectedId: projectId ? Office.model.getProject(projectId).selectedId : null };
  }
  function response(context, text) {
    const p = Office.model.getProject(context.projectId), intent = /ppt|幻灯|汇报/i.test(text) ? "ppt" : /word|docx|生成.*报告|写.*报告/i.test(text) ? "word" : /润色|改写/.test(text) ? "polish" : /分析.*表|表格分析/.test(text) ? "sheet" : "read";
    const refs = context.refs.filter(r => r.readable && (r.file.id === context.selectedId || text.includes(r.file.name))).slice(0, 3);
    if (!refs.length && context.refs.some(r => r.readable)) refs.push(context.refs.find(r => r.readable));
    if (p.scenario === "model-unavailable") return { failed: true, text: "所选模型当前不可用（合成故障）。输入与来源已保留；可在模型设置中检查，恢复正常场景后重发。", tools: [{ name: "office.check", state: "失败", arg: "模型可用性", detail: "未调用远程模型，未生成或改写文件" }] };
    const valid = refs.filter(r => Office.model.readReference(context.projectId, r.citation).ok);
    if (!valid.length) return { failed: true, text: "当前没有可读取的项目来源。请先添加资料，或恢复源权限／检查扫描 PDF 的文本条件后重试；不会改用其他项目或代码文件。", tools: [{ name: "office.sources", state: "待确认", arg: "当前项目资料", detail: "来源为空或不可读取 · 未发送" }] };
    context.session.steps = [{ title: "核对当前项目与引用范围", state: "done", meta: "合成检查" }, { title: "整理意图与资料摘要", state: "done", meta: "未调用模型" }, { title: "确认来源后执行并审阅候选", state: "todo" }];
    return { text: `**已整理本次${intent === "read" ? "解读" : "交付"}请求**\n\n${valid.map(r => `- 《${r.file.name}》：${summary(r)}`).join("\n")}\n\n${intent === "read" ? "建议先核对上述来源的事实与版本，再区分已确认结论和待验证问题。" : "建议按背景、证据与行动组织内容；表格数据沿用原口径，未核验内容明确标为待确认。"}\n\n这一步仅整理合成资料与执行计划。请确认来源、用途和发送范围后${intent === "read" ? "查看完整解读" : "生成候选"}；接受只进入草稿，原件不会被覆盖。`, sources: valid.map(r => r.citation), officeAction: { kind: intent, purpose: text, refs: valid.map(r => ({ fileId: r.file.id, location: r.citation.location })) }, tools: [{ name: "office.sources", state: "完成", arg: valid.map(r => r.path).join("、"), detail: "当前项目来源检查 · 仅内存合成资料 · 尚未发送" }] };
  }
  function messageExtra(m) {
    if (!pid) return "";
    const scope = `data-project="${esc(pid)}" data-session="${esc(store.aiSession)}"`;
    return `${(m.sources || []).map(c => `<button class="office-citation" data-act="officeai-source" ${scope} data-id="${esc(c.fileId)}" data-location="${esc(JSON.stringify(c.location || { kind: "document" }))}" data-revision="${esc(c.revision)}" data-fingerprint="${esc(c.fingerprint || "")}">${icon("link", "ico-14")}${esc(c.name)}</button>`).join("")}${m.officeAction ? `<div class="acts"><button class="btn sm" data-act="officeai-confirm" ${scope} data-message="${store.aiMessages.indexOf(m)}">确认来源与${m.officeAction.kind === "read" ? "解读范围" : "生成范围"}</button></div>` : ""}`;
  }
  document.addEventListener("click", e => {
    const el = e.target.closest('[data-act^="officeai-"]'); if (!el || !pid) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (el.dataset.project && (el.dataset.project !== pid || el.dataset.session !== store.aiSession)) return;
    if (el.dataset.act === "officeai-insert") { UI.closeDialog(); AIPanel.insert(el.dataset.text); }
    else if (el.dataset.act === "officeai-source") Office.actions.citation(pid, el);
    else if (el.dataset.act === "officeai-confirm") {
      const action = store.aiMessages[Number(el.dataset.message)]?.officeAction; if (!action) return;
      const p = Office.model.getProject(pid), f = p.files.find(f => f.id === p.selectedId);
      Office.aiDialog(pid, action.kind, { action: action.kind, title: action.kind === "ppt" ? "项目汇报" : "资料简报", purpose: action.purpose, audience: "项目评审会", pages: 3, model: "cloud", consent: false, targetId: f?.id || null, refs: action.refs || (f ? [{ fileId: f.id, location: p.location || { kind: "document" } }] : []) });
    }
  }, true);
  /* CR-054：工作台以只读方式读取办公项目的会话集合与当前会话，避免出现第二套数据源。
     访问器不改变状态，也不触发 load/save。 */
  function sessionsOf() { return pid ? ensure(pid).data.sessions : []; }
  function currentSessionId() { return pid ? ensure(pid).sessionId : null; }
  return { activate, isActive: () => Boolean(pid), projectId: () => pid, switchSession, newSession, referenceItems, filePicker, captureRequest, response, messageExtra,
    sessionsOf, currentSessionId,
    extra: projectId => projectId && Office.renderActivity ? Office.renderActivity(projectId) : "",
    panelAttrs: () => pid ? ` data-ai-scope="work" data-project="${esc(pid)}" data-mobile="${esc(Office.getView(pid).mobile)}"` : "" };
})();
