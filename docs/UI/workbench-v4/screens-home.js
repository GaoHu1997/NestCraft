/* 工作台、项目管理、需求页。 */
(function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell, md, projTile } = UI;
  const Screens = window.Screens = window.Screens || {};

  const statusTag = s => { const m = D.statusMeta[s] || { label: s, tone: "gray" }; return `<span class="tag ${m.tone}">${esc(m.label)}</span>`; };
  const statusLine = s => { const m = D.statusMeta[s] || { label: s, tone: "gray" }; return `<span class="status ${m.tone}">${esc(m.label)}</span>`; };
  const projectById = id => D.projects.find(p => p.id === id) || D.projects[0];
  const reqById = id => D.requirements.find(r => r.id === id);
  const childrenOf = id => D.requirements.filter(r => r.parent === id);
  const storiesOf = pid => D.requirements.filter(r => r.kind === "story" && r.project === pid);
  const tasksOf = pid => D.tasks.filter(t => t.project === pid);
  const projStats = p => { const s = storiesOf(p.id); return { total: s.length, done: s.filter(x => x.status === "completed").length, running: tasksOf(p.id).filter(t => t.status === "running" || t.status === "verifying").length }; };
  const subtree = id => { const out = [reqById(id)]; childrenOf(id).forEach(c => out.push(...subtree(c.id))); return out; };
  const descendantStories = id => subtree(id).filter(r => r.kind === "story");
  const WAITING = ["pending", "blocked", "unsynced"];
  const KIND_LABEL = { epic: "EPIC", feature: "FEATURE", story: "STORY" };

  /* ================= 工作台 ================= */
  function workbenchPage() {
    const active = D.tasks.filter(t => !["succeeded", "failed", "pending"].includes(t.status));
    const waiting = D.requirements.filter(r => WAITING.includes(r.status));
    const done = D.requirements.filter(r => r.status === "completed");
    return `<div class="page">
      <div class="page-h"><div class="titles"><h1 class="page-title">工作台</h1>
        <p class="page-sub">今天需要处理什么、哪些运行还在跑，都集中这里。</p></div>
        <div class="page-actions"><button class="btn" data-act="nav" data-page="projects">${icon("folder", "ico-14")}全部项目</button></div></div>
      <div class="stats">
        <div class="stat"><div class="k">${icon("play", "ico-14")}运行中</div><div class="v c-blue">${active.filter(t => t.status !== "waiting").length}<small>个</small></div></div>
        <div class="stat"><div class="k">${icon("alert", "ico-14")}等待依赖</div><div class="v c-amber">${active.filter(t => t.status === "waiting").length}<small>个</small></div></div>
        <div class="stat"><div class="k">${icon("check", "ico-14")}已完成需求</div><div class="v c-green">${done.length}<small>条</small></div></div>
        <div class="stat"><div class="k">${icon("clock", "ico-14")}待我处理</div><div class="v">${waiting.length}<small>项</small></div></div>
      </div>
      <div class="grid-2">
        <section class="card"><div class="card-h"><h3>${icon("play", "ico-14")}活动运行 <span class="sub">${active.length} 条</span></h3><button class="btn xs" data-act="nav" data-page="tasks">查看全部</button></div>
          <div class="list">${active.length ? active.map(t => `<button class="list-row" data-act="open-task-global" data-id="${t.id}" data-project="${t.project}">
            ${cliTile(t.cli, 28)}
            <span style="flex:1;min-width:0"><b style="display:block;font-size:12.5px;font-weight:550" class="ellipsis">${esc(t.title)}</b><span class="caption">${esc(t.id)} · ${esc(t.story)}</span></span>
            <span class="status ${t.status === "running" ? "blue running" : t.status === "verifying" ? "violet" : t.status === "waiting" ? "amber" : "green"}">${t.status === "running" ? "运行中" : t.status === "verifying" ? "验证中" : t.status === "waiting" ? "等待依赖" : "已交付"}</span>
            <span class="caption num" style="width:44px;text-align:right">${t.progress}%</span></button>`).join("") : emptyBlock("没有进行中的运行", "派发需求后在此查看进度。")}</div>
        </section>
        <section class="card"><div class="card-h"><h3>${icon("inbox", "ico-14")}待我处理 <span class="sub">${waiting.length} 项</span></h3></div>
          <div class="list">${waiting.map(r => `<button class="list-row" data-act="jump-req" data-id="${r.id}" data-project="${r.project}">
            <span class="kind ${r.kind}" style="width:62px"><span class="k-dot"></span>${KIND_LABEL[r.kind]}</span>
            <span style="flex:1;min-width:0"><b style="display:block;font-size:12.5px;font-weight:550" class="ellipsis">${esc(r.title)}</b><span class="caption">${esc(r.id)} · ${esc(projectById(r.project).name)}</span></span>
            ${statusTag(r.status)}</button>`).join("") || emptyBlock("没有待处理项", "所有需求都已进入可执行状态。")}</div>
        </section>
      </div>
      <div class="grid-2" style="margin-top:16px">
        <section class="card"><div class="card-h"><h3>${icon("check", "ico-14")}最近完成</h3></div>
          <div class="list">${done.slice(0, 4).map(r => `<button class="list-row" data-act="jump-req" data-id="${r.id}" data-project="${r.project}">
            <span class="tag green">已完成</span><span style="flex:1;min-width:0" class="ellipsis">${esc(r.title)}</span><span class="caption">${esc(r.id)}</span></button>`).join("")}</div>
        </section>
        <section class="card"><div class="card-h"><h3>${icon("book", "ico-14")}最近更新的知识</h3></div>
          <div class="list">${D.knowledge.docs["KB-01"].slice(0, 3).map(d => `<button class="list-row" data-act="kb-jump" data-kb="KB-01" data-doc="${d.id}">
            ${UI.fileIcon(d.type)}<span style="flex:1;min-width:0" class="ellipsis">${esc(d.title)}</span><span class="caption">${esc(d.updated)}</span></button>`).join("")}</div>
        </section>
      </div>
      <div class="page-foot"><span>DEMO 夹具 · 数据均为虚构</span><span>最近同步：今天 14:32</span></div>
    </div>`;
  }

  function emptyBlock(title, desc) {
    return `<div class="empty" style="padding:28px 16px"><b>${esc(title)}</b><p>${esc(desc)}</p></div>`;
  }
  function cliTile(cli, size) { return UI.cliLogo(cli, size); }

  /* ================= 项目管理 ================= */
  function projectsPage() {
    const q = (store.projQuery || "").trim().toLowerCase();
    const filter = store.projectFilter || "all";
    const rows = D.projects.filter(p => (filter === "all" || p.kind === filter) && (!q || (p.name + p.owner + p.desc + p.tags.join("")).toLowerCase().includes(q)));
    return `<div class="page">
      <div class="page-h">
        <div class="titles"><h1 class="page-title">项目管理</h1>
          <p class="page-sub">双击卡片或点击「打开」进入项目；点击编辑修改项目信息。</p></div>
        <div class="page-actions">
          <div class="seg" role="tablist"><button aria-selected="${filter === "all"}" data-act="project-filter" data-kind="all">全部</button><button aria-selected="${filter === "code"}" data-act="project-filter" data-kind="code">编码</button><button aria-selected="${filter === "work"}" data-act="project-filter" data-kind="work">办公</button></div>
          <button class="btn primary" data-act="project-new">${icon("plus", "ico-14")}新建项目</button>
        </div>
      </div>
      <div class="proj-toolbar">
        <label class="search">${icon("search", "ico-14")}<input class="input" id="proj-search" data-act="proj-search" placeholder="搜索项目、负责人或标签" value="${esc(store.projQuery || "")}"></label>
        <span class="spacer"></span>
        <span class="caption">${rows.length} 个项目</span>
      </div>
      <div class="proj-grid">
        ${rows.map(p => { const s = projStats(p); const pct = s.total ? Math.round(s.done / s.total * 100) : 0; return `<article class="card proj-card" data-act="open-project" data-id="${p.id}">
          <div class="proj-card-h">
            <button type="button" class="icon-tile-btn" data-c070-open="${p.id}" data-c070-kind="project" title="选择图标与颜色" aria-label="选择项目图标与颜色">${projTile(p)}</button>
            <div class="proj-card-t"><b>${esc(p.name)}</b><span>${esc(p.id)} · ${p.kind === "code" ? "编码" : "办公"}</span></div>
            <button class="icon-btn" data-act="project-edit" data-id="${p.id}" title="编辑项目">${icon("edit")}</button>
          </div>
          <p class="proj-card-desc">${esc(p.desc)}</p>
          <div class="proj-card-tags">${p.tags.map(t => `<span class="tag gray">${esc(t)}</span>`).join("")}${s.running ? `<span class="tag blue">${s.running} 个运行</span>` : ""}</div>
          <div class="proj-card-progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="num">${s.done}/${s.total}</span></div>
          <div class="proj-card-f">
            <span class="row" style="gap:6px"><span class="avatar" style="width:20px;height:20px;font-size:9px">${esc(p.ownerInitials)}</span><span class="caption">${esc(p.owner)}</span></span>
            <span class="caption">${esc(p.updated)}</span>
            <button class="btn xs" data-act="open-project" data-id="${p.id}">打开</button>
          </div>
        </article>`; }).join("") || `<div class="card"><div class="empty" style="padding:48px"><b>没有匹配的项目</b><p>换一个关键词或切换类型。</p></div></div>`}
      </div>
      <div class="page-foot"><span>全部为虚构样例，不读取真实目录</span><span>共 ${D.projects.length} 个项目</span></div>
    </div>`;
  }

  function projectModal(mode, id) {
    const p = mode === "edit" ? Object.assign({}, projectById(id), store.projectFormDraft || {}) : Object.assign({ id: "", key: "", name: "", kind: "code", owner: D.user.name, desc: "", path: "" }, store.projectDraft || {});
    if (store.projectPathDraft) p.path = store.projectPathDraft;
    store.projectModal = { mode, id };
    /* CR-073（用户第 2、4 项）：项目名称与图标砖同一行，图标砖可点击直接改；
       移除「成员」字段（个人本地工具现阶段无联合办公场景）；负责人／描述为可填写字段。
       CR-070 的「编辑弹窗不含图标折叠区」继续成立：入口是图标砖悬浮层，不是折叠区。 */
    const tileBtn = mode === "edit"
      ? `<button type="button" class="icon-tile-btn project-name-tile" data-c070-open="${esc(p.id)}" data-c070-kind="project" title="点击修改图标与颜色" aria-label="点击修改项目图标与颜色">${projTile({ icon: p.icon || null, iconColor: p.iconColor || null, kind: p.kind }, "", "ico-20")}</button>`
      : `<span class="project-name-tile" title="创建项目后可在卡片上修改图标">${projTile({ icon: p.icon || null, iconColor: p.iconColor || null, kind: p.kind }, "", "ico-20")}</span>`;
    const body = `<div class="form-grid">
      <div class="form-row"><label>项目名称</label><div class="project-name-row">${tileBtn}<input class="input" id="pf-name" value="${esc(p.name)}" placeholder="例如：活动签到">${mode === "edit" ? "" : `<span class="caption">创建后可修改图标</span>`}</div></div>
      <div class="form-row two"><div><label>项目标识</label><input class="input" id="pf-key" value="${esc(p.key)}" placeholder="BOOKING"></div><div><label>类型</label><select class="select" id="pf-kind"><option value="code" ${p.kind === "code" ? "selected" : ""}>编码项目</option><option value="work" ${p.kind === "work" ? "selected" : ""}>办公项目</option></select></div></div>
      <div class="form-row"><label>负责人</label><input class="input" id="pf-owner" value="${esc(p.owner)}" placeholder="填写负责人"></div>
      <div class="form-row"><label>项目描述</label><textarea class="textarea" id="pf-desc" rows="3" placeholder="一句话说明项目目标">${esc(p.desc)}</textarea></div>
      <div class="form-row"><label>本地目录</label><div class="input-with-btn"><input class="input" id="pf-path" value="${esc(p.path || "")}" placeholder="尚未选择"><button class="btn" type="button" data-act="dir-pick">${icon("folder", "ico-14")}浏览…</button></div><small>从本机目录树选择，不手工输入路径。</small></div>
    </div>`;
    openDialog(dlgShell(mode === "edit" ? "编辑项目" : "新建项目", mode === "edit" ? esc(p.id) : "创建后会出现在项目卡片列表中", body,
      `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="project-save" data-mode="${mode}" data-id="${esc(p.id)}">${mode === "edit" ? "保存" : "创建项目"}</button>`, "modal-lg"));
  }

  /* CR-070：项目图标/色卡选择移至图标砖悬浮层（cr070.js）。
     CR-073：编辑弹窗内图标砖同样触发该悬浮层；project-save 保留原字段保存行为，
     icon/iconColor 由悬浮层成对写入，此处不再读图标草稿。 */
  function captureProjectForm() {
    const field = id => document.getElementById(id)?.value;
    store.projectFormDraft = { name: field('pf-name'), key: field('pf-key'), kind: field('pf-kind'), owner: field('pf-owner'), desc: field('pf-desc'), path: field('pf-path') };
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-act='project-save']")) captureProjectForm();
  }, true);
  function dirPicker() {
    const folders = ["work", "work/booking-service", "work/ops-console", "work/research-booking", "work/nestcraft-site", "work/archive", "projects", "projects/demo"];
    const body = `<div class="dir-picker">
      <div class="dir-crumb">${icon("folder", "ico-14")}<span>此电脑</span><span class="sep">›</span><span>D:</span><span class="sep">›</span><span>work</span></div>
      <div class="dir-list">${folders.map(f => `<button class="dir-row" data-act="dir-choose" data-path="D:/${f}">${icon("folder", "ico-14")}<span>${esc(f.split("/").pop())}</span><span class="caption">${esc("D:/" + f)}</span></button>`).join("")}</div>
      <div class="caption">选择文件夹后点击「选择此文件夹」；本原型不访问真实磁盘。</div>
    </div>`;
    openDialog(dlgShell("选择本地目录", "仅选择路径，不读取文件内容", body,
      `<span class="left caption" id="dir-current">尚未选择</span><button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="dir-confirm">选择此文件夹</button>`, "modal-sm"));
  }

  /* ================= 项目工作区 ================= */
  function projectPage(id) {
    const p = projectById(id);
    if (p.kind === "work" && window.Office) return window.Office.renderPage(p);
    const stories = storiesOf(p.id);
    if (!reqById(store.selectedReq) || reqById(store.selectedReq).project !== p.id) store.selectedReq = stories[0] ? stories[0].id : null;
    const tabs = [["requirements", "需求", stories.length], ["design", "设计", p.id === "PRJ-1042" ? 4 : 0], ["tasks", "任务", tasksOf(p.id).length], ["code", p.kind === "code" ? "编码" : "文档", null]];
    const body = store.projectTab === "design" ? Screens.designTab(p)
      : store.projectTab === "tasks" ? Screens.tasksTab(p)
      : store.projectTab === "code" ? Screens.codeTab(p)
      : (Screens.requirementsWorkspace ? Screens.requirementsWorkspace(p) : requirementsTab(p));
    return `<div class="page ws-page">
      <div class="ws-tabs" role="tablist">
        ${tabs.map(([k, label, n]) => `<button class="ws-tab" role="tab" aria-selected="${store.projectTab === k}" data-act="project-tab" data-tab="${k}">${label}${n != null ? `<span class="n">${n}</span>` : ""}</button>`).join("")}
        <span class="spacer"></span>
        <button class="icon-btn ai-toggle-btn ${store.aiOpen ? "on" : ""}" data-act="ai-toggle" title="${store.aiOpen ? "收起 AI 侧栏" : "展开 AI 侧栏"}" aria-label="AI 侧栏">${icon("aiBot")}</button>
      </div>
      ${body}
    </div>`;
  }

  /* ---------------- 需求 ---------------- */
  function reqRow(node, depth) {
    const kids = childrenOf(node.id);
    const collapsed = store.collapsed.includes(node.id);
    const sel = store.selectedReq === node.id;
    const tag = node.kind === "story" ? statusTag(node.status) : `<span class="tag gray">${descendantStories(node.id).length} Story</span>`;
    return `<div class="tree-row ${node.kind} ${sel ? "selected" : ""}" style="--depth:${depth}" data-act="select-req" data-id="${node.id}">
      ${kids.length ? `<button class="caret" data-act="toggle-req" data-id="${node.id}" aria-label="展开">${icon(collapsed ? "chevronRight" : "chevronDown", "ico-14")}</button>` : `<span style="width:18px;flex:0 0 auto"></span>`}
      <span class="t-dot" style="background:${node.kind === "epic" ? "var(--violet)" : node.kind === "feature" ? "var(--primary)" : "var(--teal)"}"></span>
      <span class="t-id">${esc(node.id)}</span>
      <span class="t-title" data-act="req-detail" data-id="${node.id}">${esc(node.title)}</span>
      ${tag}
      <button class="row-more" data-act="req-menu" data-id="${node.id}" aria-label="更多操作">${icon("dots")}</button>
    </div>${kids.length && !collapsed ? kids.map(k => reqRow(k, depth + 1)).join("") : ""}`;
  }

  function requirementsTab(p) {
    const roots = D.requirements.filter(r => r.kind === "epic" && r.project === p.id);
    const all = storiesOf(p.id);
    const q = (store.treeQuery || "").trim();
    const list = q ? all.filter(r => (r.id + r.title).toLowerCase().includes(q.toLowerCase())) : null;
    return `<section class="req-scope">
      <div class="scope-toolbar">
        <label class="search">${icon("search", "ico-14")}<input class="input" id="tree-search" data-act="tree-search" placeholder="搜索编号或标题" value="${esc(store.treeQuery)}"></label>
        <span class="spacer"></span>
        <span class="caption">${all.length} 条 Story · ${all.filter(s => s.status === "completed").length} 已完成</span>
        <button class="btn sm" data-act="req-new" data-parent="" data-kind="epic">${icon("plus", "ico-14")}新增 Epic</button>
      </div>
      <div class="tree tree-full" role="tree">
        ${list ? (list.length ? list.map(n => `<div class="tree-row" data-act="select-req" data-id="${n.id}"><span style="width:18px"></span><span class="t-id">${esc(n.id)}</span><span class="t-title" data-act="req-detail" data-id="${n.id}">${esc(n.title)}</span>${statusTag(n.status)}<button class="row-more" data-act="req-menu" data-id="${n.id}">${icon("dots")}</button></div>`).join("") : `<div class="empty" style="padding:28px"><b>没有匹配</b><p>试试编号或关键词。</p></div>`)
          : (roots.length ? roots.map(n => reqRow(n, 0)).join("") : `<div class="empty" style="padding:32px"><b>还没有需求</b><p>从 Epic 开始拆解。</p></div>`)}
      </div>
    </section>`;
  }

  function reqMenuHtml() {
    const node = reqById(store.reqMenu);
    if (!node) return "";
    const canAdd = node.kind !== "story";
    const childLabel = node.kind === "epic" ? "新增特性" : "新增用户故事";
    return `<div class="req-menu" id="req-menu" role="menu" style="left:${store.reqMenuPos.x}px;top:${store.reqMenuPos.y}px">
      ${canAdd ? `<button class="menu-item" data-act="req-new" data-parent="${node.id}" data-kind="${node.kind === "epic" ? "feature" : "story"}">${icon("plus", "ico-14")}${childLabel}</button>` : ""}
      <button class="menu-item" data-act="req-edit" data-id="${node.id}">${icon("edit", "ico-14")}编辑</button>
      <button class="menu-item" data-act="req-dispatch" data-id="${node.id}">${icon("play", "ico-14")}派发${node.kind === "story" ? "" : "范围"}</button>
      <div class="menu-sep"></div>
      <button class="menu-item danger" data-act="req-delete" data-id="${node.id}">${icon("trash", "ico-14")}删除</button>
    </div>`;
  }

  function reqDetailModal(id) {
    const r = reqById(id);
    if (!r) return;
    const stories = r.kind === "story" ? [r] : descendantStories(r.id);
    const acs = r.acs || [];
    const body = `<div class="req-detail-modal">
      <div class="row between"><span class="kind ${r.kind}"><span class="k-dot"></span>${KIND_LABEL[r.kind]}</span>${statusLine(r.status)}</div>
      <h2>${esc(r.title)}</h2>
      <p class="caption">${esc(r.id)} · ${esc(r.summary || "")}</p>
      <dl class="facts">
        <dt>负责人</dt><dd>${esc(r.owner || "未分配")}</dd>
        <dt>工作量</dt><dd>${esc(r.estimate || "—")}</dd>
        <dt>最近更新</dt><dd>${esc(r.updated || "—")}</dd>
        ${r.kind === "story" ? `<dt>执行器</dt><dd>${esc(r.cli)} / ${esc(r.model)}</dd><dt>前置</dt><dd>${r.deps && r.deps.length ? r.deps.join("、") : "无"}</dd><dt>验证</dt><dd>${esc(r.tests || "未执行")}</dd>` : `<dt>子项</dt><dd>${stories.length} 条 Story</dd>`}
      </dl>
      ${acs.length ? `<div><h3 class="mini-title">可观察验收 <span class="muted">${acs.filter(a => a.state === "passed").length}/${acs.length} 通过</span></h3>
        <div class="ac-list">${acs.map(a => `<div class="ac ${a.state === "passed" ? "passed" : ""}"><span class="ac-box">${a.state === "passed" ? icon("check", "ico-14") : ""}</span><span class="ac-text"><span class="ac-id">${esc(a.id)}</span><br>${esc(a.text)}</span></div>`).join("")}</div></div>` : ""}
      ${r.blocked ? `<div class="note-box">${icon("alert", "ico-14")} ${esc(r.blocked)}</div>` : ""}
    </div>`;
    openDialog(dlgShell("需求详情", esc(r.id), body, `<span class="left caption">${stories.length} 条关联 Story</span><button class="btn" data-act="close-dialog">关闭</button><button class="btn" data-act="req-edit" data-id="${r.id}">${icon("edit", "ico-14")}编辑</button><button class="btn primary" data-act="req-dispatch" data-id="${r.id}">${icon("play", "ico-14")}派发</button>`, "modal-md"));
  }

  function reqFormModal(mode, id, parent, kind) {
    const node = mode === "edit" ? reqById(id) : null;
    const k = node ? node.kind : (kind || "story");
    const parentNode = parent ? reqById(parent) : null;
    const body = `<div class="form-grid">
      <div class="form-row two"><div><label>类型</label><select class="select" id="rf-kind" ${mode === "edit" ? "disabled" : ""}><option value="epic" ${k === "epic" ? "selected" : ""}>史诗 Epic</option><option value="feature" ${k === "feature" ? "selected" : ""}>特性 Feature</option><option value="story" ${k === "story" ? "selected" : ""}>用户故事 Story</option></select></div>
        <div><label>状态</label><select class="select" id="rf-status">${Object.keys(D.statusMeta).map(s => `<option value="${s}" ${node && node.status === s ? "selected" : ""}>${D.statusMeta[s].label}</option>`).join("")}</select></div></div>
      <div class="form-row"><label>标题</label><input class="input" id="rf-title" value="${esc(node ? node.title : "")}" placeholder="一句话说明价值"></div>
      <div class="form-row"><label>摘要</label><textarea class="textarea" id="rf-summary" rows="2">${esc(node ? (node.summary || "") : "")}</textarea></div>
      <div class="form-row two"><div><label>负责人</label><input class="input" id="rf-owner" value="${esc(node ? node.owner || "" : "")}"></div><div><label>工作量</label><input class="input" id="rf-estimate" value="${esc(node ? node.estimate || "" : "")}" placeholder="2 人日"></div></div>
      ${k === "story" ? `<div class="form-row"><label>可观察验收（每行一条）</label><textarea class="textarea mono" id="rf-acs" rows="4">${esc((node && node.acs ? node.acs : []).map(a => a.text).join("\n"))}</textarea><small>保存后按 AC-01、AC-02 顺序生成。</small></div>` : ""}
      <div class="form-row"><label>${parentNode ? "所属" : "归属"}</label><input class="input" value="${esc(parentNode ? parentNode.id + " · " + parentNode.title : projectById(store.projectId).name)}" readonly></div>
    </div>`;
    openDialog(dlgShell(mode === "edit" ? "编辑需求" : "新增需求", esc(projectById(store.projectId).name), body,
      `<button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="req-save" data-mode="${mode}" data-id="${esc(id || "")}" data-parent="${esc(parent || "")}">${mode === "edit" ? "保存" : "创建"}</button>`, "modal-md"));
  }

  function reqDeleteModal(id) {
    const r = reqById(id);
    const count = subtree(id).length;
    openDialog(dlgShell("删除需求", "删除后不可恢复（设计稿内）", `<div class="note-box">确定删除「${esc(r.title)}」？${count > 1 ? `其下 ${count - 1} 个子项会一并删除。` : ""}</div>`,
      `<button class="btn" data-act="close-dialog">取消</button><button class="btn danger" data-act="req-delete-confirm" data-id="${esc(id)}">删除</button>`, "modal-sm"));
  }

  function openDispatch(id) {
    const node = reqById(id) || storiesOf(store.projectId)[0];
    if (!node) { toast("当前范围没有可派发的需求"); return; }
    const stories = node.kind === "story" ? [node] : descendantStories(node.id);
    const ready = stories.filter(s => s.status === "ready");
    const excluded = stories.filter(s => s.status !== "ready");
    const body = `<div class="pf-summary"><div><div class="big">${ready.length}</div><div class="lbl">将派发</div></div>
      <div><div class="big">${excluded.length}</div><div class="lbl">范围外</div></div>
      <div style="flex:1"><div class="lbl">冻结范围</div><div style="font-size:12px">${esc(node.kind === "story" ? node.id : node.id + " 范围内可执行 Story")}</div></div></div>
      <div class="preflight">${ready.map(s => `<div class="pf-item"><span class="pf-id">${esc(s.id)}</span><span class="pf-main"><b>${esc(s.title)}</b><span>${esc(s.cli)} / ${esc(s.model)} · ${s.acs ? s.acs.length : 0} 条 AC · 依赖 ${s.deps && s.deps.length ? s.deps.join("、") : "无"}</span></span><span class="tag blue">待执行</span></div>`).join("") || `<div class="empty" style="padding:24px"><b>没有可派发的 Story</b><p>当前范围内没有「已就绪」的条目。</p></div>`}</div>
      ${excluded.length ? `<div><div class="caption" style="margin-bottom:6px">范围外（不派发）</div>${excluded.map(s => `<div class="pf-item excluded"><span class="pf-id">${esc(s.id)}</span><span class="pf-main"><b>${esc(s.title)}</b><span>${esc((D.statusMeta[s.status] || {}).label || s.status)}</span></span></div>`).join("")}</div>` : ""}
      <div class="note-box">${icon("alert", "ico-14")} 确认为本机仿真：创建 Run 与推进状态为演示，不调用真实 CLI。</div>`;
    openDialog(dlgShell("派发预检", "先冻结范围，再确认派发；不会自动补入范围外的必要前置。", body,
      `<span class="left caption">${ready.length} 个 Story 将创建运行</span><button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-act="confirm-dispatch" data-id="${node.id}" ${ready.length ? "" : "disabled"}>${icon("play", "ico-14")}确认派发</button>`, "modal-wide"));
  }

  Screens.home = page => page === "knowledge" ? Screens.knowledgePage() : page === "servers" ? Screens.serversPage() : page === "projects" ? projectsPage() : workbenchPage();
  Screens.project = projectPage;
  Screens.reqMenuHtml = reqMenuHtml;
  Screens.reqDetailModal = reqDetailModal;
  Screens.reqFormModal = reqFormModal;
  Screens.reqDeleteModal = reqDeleteModal;
  Screens.openDispatch = openDispatch;
  Screens.projectModal = projectModal;
  Screens.dirPicker = dirPicker;
  Screens.statusTag = statusTag;
  Screens.statusLine = statusLine;
  Screens.reqById = reqById;
  Screens.storiesOf = storiesOf;
  Screens.tasksOf = tasksOf;
  Screens.projStats = projStats;
  Screens.projectById = projectById;
  Screens.cliTile = cliTile;
})();

