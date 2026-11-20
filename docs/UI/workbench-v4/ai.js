/* AI 侧栏：无标题头、可拖拽、历史浮层、@// 菜单、CLI/权限/模型、统计、子智能体与后台任务。
   CR-042：顶部智能体/后台改为下拉悬浮框；历史为覆盖式浮层；模型能力图标与生图过滤；
   三统计移到输入框下方并右对齐各自控件；分步骤执行显示等宽折叠框。 */
window.AIPanel = (function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell } = UI;

  const activeSession = () => D.ai.sessions.find(s => s.id === store.aiSession) || D.ai.sessions[0];
  const statusDot = s => s === "success" ? '<span class="sdot green"></span>' : s === "failed" ? '<span class="sdot red"></span>' : s === "pending" ? '<span class="sdot amber"></span>' : '<span class="sdot none"></span>';
  const statusText = s => s === "success" ? "成功" : s === "failed" ? "失败" : s === "pending" ? "待处理" : "已读";

  function message(m, idx) {
    const tools = (m.tools || []).map(t => `<div class="tool">
      <span class="t-ico">${icon(t.name === "fs.read" ? "file" : t.name === "fs.write" ? "edit" : t.name === "code-search" ? "search" : "terminal", "ico-14")}</span>
      <span class="t-main"><span class="t-head"><span class="t-name">${esc(t.name)}</span><span class="t-state ${t.state === "完成" ? "done" : "run"}">${esc(t.state)}</span></span>
        <div class="t-arg">${esc(t.arg)}</div><div class="t-detail">${esc(t.detail)}</div></span></div>`).join("");
    const approval = m.approval ? `<div class="approval"><b>${esc(m.approval.title)}</b><p>${esc(m.approval.detail)}</p>
      <div class="acts"><button class="btn primary" data-act="ai-approve" data-idx="${idx}">允许一次</button><button class="btn" data-act="ai-deny" data-idx="${idx}">拒绝</button><button class="btn ghost" data-act="ai-show-cmd" data-idx="${idx}">查看命令</button></div></div>` : "";
    if (m.role === "user") return `<div class="msg user"><span class="who">${esc(D.user.initials)}</span><div class="bubble"><div class="m-name">${esc(D.user.name)} · ${esc(m.time)}</div><div class="text">${esc(m.text)}</div></div></div>`;
    return `<div class="msg assistant"><span class="who">AI</span><div class="bubble"><div class="m-name">${esc(D.ai.modelCatalog.current.model)} · ${esc(m.time)}</div>
      <div class="text">${UI.md(m.text).replace(/^<p>|<\/p>$/g, "")}</div>${tools}${approval}${window.OfficeAI ? OfficeAI.messageExtra(m) : ""}</div></div>`;
  }

  /* ---------------- 历史：覆盖在 AI 侧栏左侧的浮层，不参与布局 ---------------- */
  function historyRail() {
    return `<aside class="ai-history" role="dialog" aria-label="会话历史">
      <div class="ai-history-h"><span class="ah-title">${icon("history", "ico-14")}<b>会话历史</b><span class="caption">${D.ai.sessions.length}</span></span><button class="icon-btn" data-act="ai-history-close" aria-label="关闭会话历史">${icon("x", "ico-14")}</button></div>
      <div class="ai-history-list">${D.ai.sessions.map(s => `<button class="ai-session ${s.id === store.aiSession ? "active" : ""}" data-act="ai-switch" data-id="${s.id}" aria-current="${s.id === store.aiSession ? "true" : "false"}">
        ${statusDot(s.status)}<span class="s-main"><b class="ellipsis">${esc(s.title)}</b><span>${esc(s.updated)} · ${esc(s.tokens)} · ${esc(s.duration)}</span></span><span class="s-state">${esc(statusText(s.status))}</span></button>`).join("")}</div>
      <div class="ai-history-f"><button class="btn sm" style="width:100%" data-act="ai-new">${icon("plus", "ico-14")}新会话</button></div>
    </aside>`;
  }

  /* ---------------- 顶部下拉：子智能体 / 后台任务 ---------------- */
  function agentDrop() {
    return `<div class="ai-drop ai-drop-agents" role="dialog" aria-label="子智能体">
      <div class="drop-h"><b>子智能体</b><span class="caption">${D.ai.subagents.length} 个 · 仅本会话</span></div>
      <div class="drop-list">${D.ai.subagents.length ? D.ai.subagents.map(a => `<div class="agent-row">
        ${cliLogo(a.cli, 24)}<span class="ar-main"><b class="ellipsis">${esc(a.title)}</b><span>${esc(a.model)} · ${esc(a.duration)} · ${esc(a.tokens)}</span></span>
        <span class="tag ${a.status === "失败" ? "red" : a.status === "待确认" ? "amber" : "green"}">${esc(a.status)}</span></div>`).join("") : '<div class="drop-empty">本会话没有子智能体。</div>'}</div>
      <div class="drop-f">合成演示 · 不调用真实 CLI</div>
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
  const visibleModels = p => (p.models || []).filter(m => !m.image && !(m.modalities || []).includes("生图"));
  function currentProvider() {
    const cat = D.ai.modelCatalog;
    return cat.providers.find(p => p.name === cat.current.provider) || cat.providers[0];
  }
  function currentModel() {
    const list = visibleModels(currentProvider());
    return list.find(m => m.name === D.ai.modelCatalog.current.model) || list[0] || { name: "未配置", ctx: "—", vision: false, thinking: false };
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
      return `<div class="ai-pop ai-pop-cli">
        <div class="pop-h">切换 CLI</div>
        ${installed.map(c => `<button class="menu-item ${store.aiCli === c.id ? "on" : ""}" data-act="ai-cli-set" data-id="${c.id}">${cliLogo(c.id, 18)}<span class="mi-main"><b>${esc(c.name)}</b><span>${esc(c.version)}${c.badge ? " · " + c.badge : ""}</span></span>${store.aiCli === c.id ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`).join("")}
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="open-settings" data-tab="cli">${icon("sliders", "ico-14")}CLI 配置管理</button>
      </div>`;
    }
    if (store.aiPop === "perm") {
      return `<div class="ai-pop ai-pop-perm">
        <div class="pop-h">权限模式</div>
        ${D.ai.permissions.map(p => `<button class="menu-item perm ${store.aiPermission === p.name ? "on" : ""}" data-act="ai-perm-set" data-name="${esc(p.name)}">${icon(p.icon, "ico-14")}<span class="mi-main"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span>${store.aiPermission === p.name ? `<span class="check">${icon("check", "ico-14")}</span>` : ""}</button>`).join("")}
      </div>`;
    }
    if (store.aiPop === "model") {
      const cat = D.ai.modelCatalog, p = currentProvider(), models = visibleModels(p), cm = currentModel();
      const q = (store.aiModelQuery || "").toLowerCase();
      const filtered = models.filter(m => !q || m.name.toLowerCase().includes(q));
      return `<div class="ai-pop ai-pop-model" role="dialog" aria-label="选择模型">
        <div class="pop-h">模型 <span class="caption">${esc(cat.current.provider)} · ${esc(cm.name)}</span></div>
        <label class="search">${icon("search", "ico-14")}<input class="input" id="ai-model-q" data-act="ai-model-q" value="${esc(store.aiModelQuery || "")}" placeholder="搜索模型…"></label>
        <div class="model-grid">
          <div class="model-providers">${cat.providers.map(pp => { const n = visibleModels(pp).length; return `<button class="provider-row ${pp.name === cat.current.provider ? "on" : ""}" data-act="ai-model-provider" data-name="${esc(pp.name)}"><span class="ellipsis">${esc(pp.name)}</span><span class="count">${n}</span></button>`; }).join("")}</div>
          <div class="model-list">${filtered.length ? filtered.map(m => `<button class="model-row ${m.name === cm.name ? "on" : ""}" data-act="ai-model-set" data-name="${esc(m.name)}">
            <span class="mr-name ellipsis">${esc(m.name)}</span>
            <span class="mr-caps">${capCtx(m)}${capFlag("vision", !!m.vision, "视觉", "eye")}${capFlag("think", !!m.thinking, "思考", "bulb")}</span>
          </button>`).join("") : '<div class="empty" style="padding:16px"><b>没有匹配</b><p>换关键词，或检查供应商配置。</p></div>'}</div>
        </div>
        <div class="model-level ${cm.thinking ? "" : "disabled"}"><div class="row between"><b>思考等级</b><span class="caption">${cm.thinking ? esc(cat.current.level) : "该模型未声明思考档位"}</span></div>
          ${cm.thinking ? `<input type="range" min="0" max="3" step="1" value="${cat.levels.indexOf(cat.current.level)}" data-act="ai-level" class="range" aria-label="思考等级">
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
    return `<div class="ai-stats">
      ${statWrap("session", "会话统计", `${icon("refresh", "ico-14")}${s.rounds} 轮 · ${esc(s.tps)}`)}
      ${statWrap("tokens", "Token 用量", `${icon("database", "ico-14")}${s.simulated ? esc(total) : (Number(String(total).replace(/[^0-9.]/g, "")) / 1e6).toFixed(2) + "M"} · 命中 ${esc(s.tokens.cacheHit)}`)}
      ${statWrap("context", "上下文", `${icon("cpu", "ico-14")}上下文 ${esc(s.context.used)}`)}
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

  function render() {
    const msgs = store.aiMessages;
    const cli = D.settings.clis.find(c => c.id === store.aiCli) || D.settings.clis[0];
    const cm = currentModel();
    return `<aside class="ai-panel"${window.OfficeAI ? OfficeAI.panelAttrs() : ""} aria-label="AI 会话" style="width:${store.aiWidth}px">
      <div class="ai-resize" data-act="ai-resize" title="拖动调整宽度"></div>
      ${store.aiHistory ? historyRail() : ""}
      <div class="ai-top">
        <button class="icon-btn" data-act="ai-history" title="会话历史" aria-label="会话历史" aria-expanded="${store.aiHistory}">${icon("history")}</button>
        <div class="ai-drop-wrap">
          <button class="ai-count" data-act="ai-subagents" aria-expanded="${store.aiTop === "agents"}">${icon("users", "ico-14")}${D.ai.subagents.length} 子智能体${icon("chevronDown", "ico-12")}</button>
          ${store.aiTop === "agents" ? aiTopPop() : ""}
        </div>
        <div class="ai-drop-wrap">
          <button class="ai-count" data-act="ai-background" aria-expanded="${store.aiTop === "bg"}">${icon("terminal", "ico-14")}${D.ai.background.length} 后台任务${icon("chevronDown", "ico-12")}</button>
          ${store.aiTop === "bg" ? aiTopPop() : ""}
        </div>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="ai-new" title="新会话" aria-label="新会话">${icon("plus")}</button>
      </div>
      <div class="ai-fade"></div>
      <div class="ai-scroll" id="ai-scroll">
        ${msgs.length ? msgs.map(message).join("") : `<div class="ai-empty"><span class="mark">${icon("sparkles", "ico-20")}</span><b>新会话</b><p>说清目标与范围，我会先核对证据再动手。</p></div>`}
        ${store.aiBusy ? `<div class="msg assistant"><span class="who">AI</span><div class="bubble"><div class="m-name">${esc(D.ai.modelCatalog.current.model)}</div><div class="text muted">正在读取上下文并生成…</div></div></div>` : ""}
        ${store.aiQueue.length ? `<div class="ai-queued">${icon("clock", "ico-14")}已排队 ${store.aiQueue.length} 条，当前完成后发送</div>` : ""}
        ${stepsBlock()}
        ${window.OfficeAI ? OfficeAI.extra(OfficeAI.projectId()) : ""}
      </div>
      <div class="ai-composer-wrap">
        ${store.aiMenu ? menuHtml() : ""}
        ${store.aiPop && store.aiPop !== "session" && store.aiPop !== "tokens" && store.aiPop !== "context" ? popups() : ""}
        <div class="ai-composer">
          <textarea id="ai-input" placeholder="${window.OfficeAI && OfficeAI.isActive() ? "描述办公意图，/ 调用指令，@ 项目资料或对话" : "描述你想构建的内容，/ 调用指令，@ 文件或对话"}">${esc(store.aiInput)}</textarea>
          <div class="ai-tools">
            <button class="ai-chip icon-only" data-act="ai-menu-open" data-tab="add" title="添加" aria-label="添加">${icon("plus")}</button>
            <button class="ai-chip cli" data-act="ai-cli" title="切换 CLI：${esc(cli.name)}" aria-label="切换 CLI：${esc(cli.name)}">${cliLogo(cli.id, 16)}</button>
            <button class="ai-chip perm" data-act="ai-permission" title="权限模式" aria-label="权限模式">${icon("shield")}${esc(store.aiPermission)}</button>
            <button class="ai-chip model" data-act="ai-model" title="选择模型" aria-label="选择模型">${esc(cm.name)} · ${esc(cm.thinking ? D.ai.modelCatalog.current.level : "无思考档位")}</button>
            <button class="ai-send" data-act="ai-send" title="${store.aiBusy && !store.aiInput.trim() ? "停止" : "发送"}" aria-label="${store.aiBusy && !store.aiInput.trim() ? "停止" : "发送"}">${icon(store.aiBusy && !store.aiInput.trim() ? "stop" : "arrowUp", "ico-18")}</button>
          </div>
        </div>
        ${statsRow()}
        <div class="ai-foot"><span>Enter 发送 · Shift+Enter 换行</span><span>${esc(cli.name)} · ${esc(store.aiPermission)}</span></div>
      </div>
    </aside>`;  }

  function afterRender() {
    const sc = document.getElementById("ai-scroll");
    if (sc && store.aiStick !== false) sc.scrollTop = sc.scrollHeight;
  }

  function switchSession(id) {
    if (window.OfficeAI && OfficeAI.switchSession(id)) return;
    const s = D.ai.sessions.find(x => x.id === id);
    if (!s) return;
    store.aiSession = id;
    store.aiMessages = s.messages.length ? s.messages : [];
    s.status = "read";
    store.aiHistory = false;
    render && UI.render();
  }

  function newSession() {
    if (window.OfficeAI && OfficeAI.newSession()) return;
    const cur = activeSession();
    cur.messages = store.aiMessages.slice();
    cur.tokens = cur.tokens || "0";
    const id = "S-" + Date.now().toString().slice(-6);
    D.ai.sessions.unshift({ id, title: "新会话", status: "read", updated: "刚刚", tokens: "0", duration: "0s", messages: [] });
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

  return { render, afterRender, send, approve, insert, switchSession, newSession, menuHtml, advanceStep, cliLogo, activeSession, currentModel, visibleModels };
})();