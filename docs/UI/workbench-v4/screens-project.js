/* 项目工作区：设计、任务、编码。 */
(function () {
  "use strict";
  const { D, esc, icon, store, toast, openDialog, closeDialog, dlgShell, md, toc } = UI;
  const Screens = window.Screens;

  /* ================= 设计 ================= */
  const DESIGN_TABS = [
    ["prd", "PRD", "fileText", "产品需求文档"],
    ["ui", "UI", "layers", "界面与交互说明"],
    ["lld", "方案", "code", "技术实现方案"],
    ["db", "模型", "database", "数据模型设计"]
  ];
  function designTab(p) {
    if (p.id !== "PRJ-1042") {
      return `<div class="card"><div class="empty" style="padding:64px 24px"><span class="e-icon">${icon("layers", "ico-20")}</span><b>该项目还没有设计资料</b><p>预约服务（PRJ-1042）已有完整样例。</p><button class="btn primary" data-act="open-project" data-id="PRJ-1042">查看预约服务设计</button></div></div>`;
    }
    const key = DESIGN_TABS.some(([k]) => k === store.designTab) ? store.designTab : "prd";
    const doc = D.design[key];
    const liveId=JSON.stringify(['design',p.id,key]);
    const liveText=LiveDoc.get(liveId)?.text??doc.body;
    const heads = toc(liveText);
    return `<div class="design-shell">
      <nav class="design-rail" aria-label="设计资料">
        ${DESIGN_TABS.map(([k, label, ic, tip]) => `<button class="rail-btn ${key === k ? "on" : ""}" data-act="design-tab" data-tab="${k}" aria-label="${esc(tip)}" data-tip="${esc(tip)}">${icon(ic)}<span>${label}</span></button>`).join("")}
        <div class="rail-sep"></div>
        <button class="rail-btn" data-act="toast" data-msg="演示：关联需求已在右侧文档信息中" data-tip="关联需求">${icon("link")}<span>关联</span></button>
        <button class="rail-btn" data-act="design-toc" data-tip="${store.designToc ? "收起目录" : "展开目录"}">${icon(store.designToc ? "panelRight" : "panelLeft")}<span>目录</span></button>
      </nav>
      <section class="design-main">
        <div class="design-topbar">
          <span class="path">${icon("file", "ico-14")}<span class="ellipsis">docs/${key === "lld" ? "LLD" : key === "db" ? "DB" : key.toUpperCase()}/${esc(doc.name)}</span></span>
          <span class="tag gray">${esc(doc.version)}</span>
          <span class="spacer"></span>
          <span class="caption hide-narrow">更新于 ${esc(doc.updated)}</span>
          <span class="caption">所见即所得 · 自动保存</span>
          <button class="btn sm hide-narrow" data-act="design-export">${icon("download", "ico-14")}导出</button>
        </div>
        ${LiveDoc.render(liveId,liveText,{write:(text,expected)=>{if(doc.body!==expected)return {ok:false,conflict:true,error:'设计来源版本已改变，内容保留。'};doc.body=text;doc.updated='刚刚 · 仿真';doc.pendingSync=true;return {ok:true};},onChange:text=>{ const root=document.querySelector('.design-shell'); if(!root)return;if(root.querySelector('.toc-list'))root.querySelector('.toc-list').innerHTML='<div class="toc-label">本页目录</div>'+toc(text).map((h,n)=>'<button class="toc-item" data-act="live-design-anchor" data-index="'+n+'">'+esc(h.title)+'</button>').join('');const badge=root.querySelector('.toc-info .tag');if(badge)badge.textContent='待同步';}})}
      </section>
      ${store.designToc ? `<aside class="design-toc">
        <div class="toc-info">
          <div class="row between"><b>文档信息</b><span class="tag ${doc.pendingSync?"amber":"green"}">${doc.pendingSync?"待同步":"已同步"}</span></div>
          <div class="meta-row"><span>版本</span><b>${esc(doc.version)}</b></div>
          <div class="meta-row"><span>更新</span><b>${esc(doc.updated)}</b></div>
          <div class="meta-row"><span>关联 Story</span><b>3 条</b></div>
          <div class="meta-row"><span>负责人</span><b>林澈</b></div>
          <button class="btn sm" style="width:100%" data-act="toast" data-msg="演示：同步设计依据">${icon("refresh", "ico-14")}同步设计依据</button>
        </div>
        <div class="toc-list"><div class="toc-label">本页目录</div>
          ${heads.length ? heads.map(h => `<button class="toc-item ${h.level === 3 ? "lv3" : ""}" data-act="toast" data-msg="演示：跳转到章节">${esc(h.title)}</button>`).join("") : '<span class="caption">无章节</span>'}
        </div>
      </aside>` : ""}
    </div>`;
  }

  /* ================= 任务 ================= */
  const taskStatus = { running: ["运行中", "blue"], verifying: ["验证中", "violet"], pending: ["待验收", "amber"], succeeded: ["已交付", "green"], failed: ["失败", "red"], waiting: ["等待依赖", "amber"] };
  const kidsOf = t => D.tasks.filter(x => x.parentId === t.id);
  const collapsed = id => (store.taskTreeCollapsed || []).includes(id);

  /* 一次派发 = 一棵树：根是协调者，子是其调用的各 CLI 工作代理。 */
  function taskTree(list) {
    const roots = list.filter(t => !t.parentId);
    const rows = [];
    const walk = (t, depth) => {
      rows.push({ t, depth });
      if (collapsed(t.id)) return;
      kidsOf(t).forEach(c => walk(c, depth + 1));
    };
    roots.forEach(r => walk(r, 0));
    return rows;
  }

  function tasksTab(p) {
    const content = tasksContent(p);
    return typeof Screens.taskWorkspace === "function" ? Screens.taskWorkspace(p, content) : content;
  }

  function tasksContent(p) {
    const list = Screens.tasksOf(p.id);
    if (!list.length) return `<div class="card"><div class="empty" style="padding:64px 24px"><span class="e-icon">${icon("play", "ico-20")}</span><b>该项目还没有运行</b><p>在需求页派发后，运行会出现在这里。</p><button class="btn primary" data-act="project-tab" data-tab="requirements">去派发需求</button></div></div>`;
    const dispatchRoots = list.filter(t => !t.parentId);
    const running = list.filter(t => t.status === "running" || t.status === "verifying").length;
    const waiting = list.filter(t => t.status === "waiting").length;
    const done = list.filter(t => t.status === "succeeded" || t.status === "pending").length;
    const workers = list.filter(t => t.parentId).length;
    const sel = list.find(t => t.id === store.taskId) || dispatchRoots[0] || list[0];
    const rows = taskTree(list);
    return `<div class="task-shell">
      <div class="task-stats">
        ${[[dispatchRoots.length, "派发批次", "play"], [workers, "子任务", "git"], [running, "执行中", "zap"], [waiting, "等待依赖", "clock"], [done, "已交付 / 待验收", "check"]].map(([v, k, ic]) => `<div class="ts"><span class="k">${icon(ic, "ico-14")}${k}</span><b>${v}</b></div>`).join("")}
      </div>
      <div class="task-body">
        <section class="task-list-pane">
          <div class="pane-h"><h3>派发树 <span class="sub">${esc(p.name)} · 每次派发一棵</span></h3>
            <div class="row"><button class="btn sm" data-act="task-tree-all" data-mode="expand">展开全部</button><button class="btn sm" data-act="task-tree-all" data-mode="collapse">收起子项</button></div></div>
          <div class="task-table-wrap">
            <table class="table task-table task-tree-table">
              <thead><tr><th>任务 / 执行器</th><th>状态</th><th class="right">耗时</th></tr></thead>
              <tbody>${rows.map(({ t, depth }) => {
                const st = taskStatus[t.status] || ["未知", "gray"];
                const kids = kidsOf(t);
                const isRoot = depth === 0;
                const sum = isRoot ? kids.length : 0;
                return `<tr class="clickable task-node depth-${depth} ${store.taskId === t.id ? "is-selected" : ""}" data-act="open-task" data-id="${t.id}">
                <td><div class="cell-main">${
                  isRoot
                    ? (sum
                      ? `<button class="tree-toggle ${collapsed(t.id) ? "is-collapsed" : ""}" data-act="tree-toggle" data-id="${t.id}" title="${collapsed(t.id) ? "展开" : "收起"}">${icon("chevronDown", "ico-14")}</button>`
                      : `<span class="tree-toggle placeholder"></span>`)
                    : `<span class="tree-gutter"><span class="tree-elbow"></span></span>`
                }${Screens.cliTile(t.cli, isRoot ? 28 : 24)}<span class="cell-title"><b class="ellipsis">${esc(t.title)}${isRoot ? "" : ` <span class="task-pct">${t.progress}%</span>`}</b><span>${esc(t.id)} · ${isRoot ? (sum ? `协调者 · ${sum} 个子任务` : "协调者直接执行") : `${esc(t.cli.toUpperCase())} · 工作代理`}</span></span></div></td>
                <td><span class="status ${st[1]} ${t.status === "running" ? "running" : ""}">${st[0]}</span></td>
                <td class="right muted num">${esc(t.duration)}</td></tr>`; }).join("")}</tbody>
            </table>
          </div>
        </section>
        ${taskDetail(sel)}
      </div>
    </div>`;
  }

  function taskDetail(t) {
    if (!t) return "";
    const st = taskStatus[t.status] || ["未知", "gray"];
    const kids = kidsOf(t);
    const parent = t.parentId ? D.tasks.find(x => x.id === t.parentId) : null;
    const childTable = kids.length ? `<div class="dispatch-block">
        <div class="row between" style="margin-bottom:8px"><b style="font-size:12px">本次派发的子任务</b><span class="caption">${kids.length} 个执行器任务</span></div>
        <div class="dispatch-table">${kids.map(k => { const ks = taskStatus[k.status] || ["未知", "gray"]; return `<button class="dispatch-row" data-act="open-task" data-id="${k.id}">
          ${Screens.cliTile(k.cli, 24)}
          <span class="dr-main"><b class="ellipsis">${esc(k.title)}</b><span class="caption ellipsis">${esc(k.mission || k.story)}</span></span>
          <span class="tag ${ks[1]}">${ks[0]}</span>
          <span class="dr-meta num">${esc(k.progress)}% · ${esc(k.duration)}</span>
        </button>`; }).join("")}</div>
      </div>` : "";
    return `<aside class="task-detail-pane" id="task-detail">
      <div class="task-detail-h">${Screens.cliTile(t.cli, 34)}<div style="min-width:0"><div class="row" style="gap:8px"><b class="ellipsis">${esc(t.title)}</b><span class="tag ${st[1]}">${st[0]}</span></div><div class="caption">${esc(t.id)} · ${esc(t.story)} · 第 ${t.round} 轮 · ${t.parentId ? "工作代理" : "协调者"}</div></div>
        <button class="icon-btn" data-act="toast" data-msg="演示：更多操作">${icon("dots")}</button></div>
      <div class="task-detail-b stack-sm">
        ${parent ? `<button class="breadcrumb-back" data-act="open-task" data-id="${parent.id}">${icon("chevronDown", "ico-14")}所属派发 · ${esc(parent.title)}</button>` : ""}
        ${t.mission ? `<div class="mission-box">${icon("target", "ico-14")}<span>${esc(t.mission)}</span></div>` : ""}
        ${t.reason ? `<div class="note-box">${icon("alert", "ico-14")} ${esc(t.reason)}</div>` : ""}
        ${childTable}
        ${window.CR037?.taskCard(t) || ""}
        <div class="run-steps">${t.steps.map(s => `<div class="step ${s.state === "active" ? "active" : s.state}"><div class="s-line"><span class="s-dot">${s.state === "done" ? icon("check", "ico-14") : ""}</span><span class="s-bar"></span></div><div><div class="s-name">${esc(s.name)}</div><div class="s-time">${esc(s.time)}</div></div></div>`).join("")}</div>
        <div class="divider"></div>
        <div><div class="row between" style="margin-bottom:6px"><b style="font-size:12px">产物</b><span class="caption">${t.artifacts.length} 个文件</span></div>
          ${t.artifacts.length ? `<div class="artifacts">${t.artifacts.map(a => `<div class="artifact">${icon("file", "ico-14")}<span class="fname">${esc(a.name)}</span><span class="${a.change.includes("+") ? "plus" : "muted"}">${esc(a.change)}</span></div>`).join("")}</div>` : `<div class="caption" style="padding:8px 0">暂无产物；失败不覆盖原记录。</div>`}</div>
        <div><div class="row between" style="margin-bottom:6px"><b style="font-size:12px">运行日志</b><span class="caption">本机仿真</span></div>
          <div class="log">${t.logs.map(([time, msg], idx) => `<div class="ln ${idx === t.logs.length - 1 && t.status === "failed" ? "err" : ""}"><span class="t">${esc(time)}</span><span>${esc(msg)}</span></div>`).join("")}</div></div>
        <div class="row" style="gap:16px;color:var(--muted);font-size:11px"><span>${icon("zap", "ico-14")} ${esc(t.usage.tokens)} tokens</span><span>${esc(t.usage.cost)}</span><span>${t.usage.commands} 条命令</span></div>
        <div class="actions row" style="padding-top:2px">
          ${t.status === "running" ? `<button class="btn sm" data-act="task-pause" data-id="${t.id}">${icon("pause", "ico-14")}暂停</button>` : ""}
          ${t.status === "failed" ? `<button class="btn sm primary" data-act="retry-task" data-id="${t.id}">${icon("refresh", "ico-14")}重试原运行</button>` : ""}
          ${t.status === "pending" ? `<button class="btn sm primary" data-act="task-accept" data-id="${t.id}">${icon("check", "ico-14")}验收通过</button>` : ""}
          <button class="btn sm" data-act="task-transcript" data-id="${t.id}">查看记录</button>
        </div>
      </div>
    </aside>`;
  }

  /* ================= 编码 ================= */
  const KEYWORDS = /\b(import|from|export|const|let|var|async|await|function|return|if|else|for|of|new|type|interface|class|extends|default|true|false|null|undefined|this|typeof|catch|try|throw)\b/;
  function highlight(code) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += `<span class="tk-c">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="tk-s">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="tk-n">${esc(m[3])}</span>`;
      else if (m[4]) out += KEYWORDS.test(m[4]) ? `<span class="tk-k">${esc(m[4])}</span>` : esc(m[4]);
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  function codeTab(p) {
    if (p.kind === "work") return officeTab(p);
    if (p.id !== "PRJ-1042") return `<div class="card"><div class="empty" style="padding:64px 24px"><span class="e-icon">${icon("code", "ico-20")}</span><b>该项目的编码样例尚未准备</b><p>当前只有预约服务（PRJ-1042）提供完整文件与 Git 样例。</p><button class="btn primary" data-act="open-project" data-id="PRJ-1042">打开预约服务编码区</button></div></div>`;
    const code = store.codeDraft != null && store.codeFile === store.editingFile ? store.codeDraft : (D.files[store.codeFile] || "");
    return `<div class="code-shell">
      <nav class="code-rail" aria-label="编码导航">
        <button class="rail-btn ${store.codeRail === "files" ? "on" : ""}" data-act="code-rail" data-rail="files" data-tip="资源管理">${icon("folder")}</button>
        <button class="rail-btn ${store.codeRail === "git" ? "on" : ""}" data-act="code-rail" data-rail="git" data-tip="Git 管理">${icon("git")}</button>
        <div class="rail-sep"></div>
        <button class="rail-btn" data-act="toast" data-msg="演示：打开外部编辑器" data-tip="外部编辑器">${icon("external")}</button>
      </nav>
      <section class="code-panel">
        ${store.codeRail === "git" ? gitPanel() : filesPanel()}
      </section>
      <section class="code-main">
        <div class="editor-tabs">${Object.keys(D.files).slice(0, 4).map(f => `<button class="etab ${store.codeFile === f ? "active" : ""}" data-act="open-file" data-file="${esc(f)}">${esc(f.split("/").pop())}</button>`).join("")}<span class="spacer"></span><span class="caption">${esc(D.git.branch)}</span></div>
        <div class="editor-bar"><span class="path">${esc(store.codeFile)}</span><span class="spacer"></span>
          ${store.codeEdit ? `<button class="btn xs primary" data-act="code-save">保存</button><button class="btn xs" data-act="code-cancel">取消</button>` : `<button class="btn xs" data-act="code-edit">${icon("edit", "ico-14")}编辑</button>`}
          <button class="btn xs ghost" data-act="toast" data-msg="演示：文件历史">${icon("history", "ico-14")}</button></div>
        ${store.codeEdit ? `<textarea class="editor-input mono" id="code-editor" data-act="code-input">${esc(code)}</textarea>`
          : `<div class="code"><div class="gutter">${code.split("\n").map((_, i) => `<div>${i + 1}</div>`).join("")}</div><div class="lines">${highlight(code)}</div></div>`}
      </section>
    </div>`;
  }

  function filesPanel() {
    const files = Object.keys(D.files);
    const changes = D.git.changes;
    const tree = {};
    files.forEach(f => { const parts = f.split("/"); let node = tree; parts.slice(0, -1).forEach(p => { node[p] = node[p] || {}; node = node[p]; }); node[parts[parts.length - 1]] = f; });
    const render = (obj, depth) => Object.keys(obj).sort().map(k => {
      const v = obj[k];
      if (typeof v === "string") { const ch = changes.find(c => c.file === v); return `<button class="file-row ${store.codeFile === v ? "active" : ""}" style="padding-left:${8 + depth * 12}px" data-act="open-file" data-file="${esc(v)}">${icon(v.endsWith(".md") ? "fileText" : "code", "ico-14")}<span class="ellipsis">${esc(k)}</span>${ch ? `<span class="fbadge ${ch.state}">${ch.state}</span>` : ""}</button>`; }
      return `<div class="file-folder" style="padding-left:${8 + depth * 12}px">${icon("chevronDown", "ico-14")}<span>${esc(k)}</span></div>` + render(v, depth + 1);
    }).join("");
    return `<div class="panel-h"><b>资源管理</b><button class="icon-btn" data-act="file-new" title="新建文件">${icon("plus")}</button></div><div class="file-tree">${render(tree, 0)}</div>`;
  }

  /* CR-067：Git 管理面板按参考图一比一重构。
     结构：顶栏（仓库药丸 + 国内加速／密钥配置／刷新）→ 三张卡片
     （未提交变更 2 份、分支 1 份、提交历史 2 份）。全部为设计仿真。 */
  function gitPanel() {
    const g = D.git;
    const q = (store.gitBranchQuery || "").trim().toLowerCase();
    const locals = g.branches.locals.filter(b => !q || b.name.toLowerCase().includes(q));
    const remotes = g.branches.remotes
      .map(r => ({ ...r, branches: r.branches.filter(b => !q || b.name.toLowerCase().includes(q)) }))
      .filter(r => r.branches.length > 0);
    const openLocal = store.gitOpenGroups?.local !== false;
    const openRemote = Boolean(store.gitOpenGroups?.remote);
    const staged = g.changes.filter(c => c.staged);
    const unstaged = g.changes.filter(c => !c.staged);
    const canCommit = staged.length > 0 && String(store.gitMessage || "").trim() !== "";
    const hint = staged.length === 0 ? "先勾选文件加入暂存区"
      : String(store.gitMessage || "").trim() === "" ? "填写提交信息后可提交"
        : `将提交 ${staged.length} 个已暂存文件`;
    const q2 = (store.gitHistoryAuthor || "").trim().toLowerCase();
    const branchFilter = store.gitHistoryBranch || "";
    const commits = g.commits.filter(c =>
      (!q2 || c.author.toLowerCase().includes(q2)) &&
      (!branchFilter || (c.refs || []).some(r => r.includes(branchFilter)) || branchFilter === "HEAD"));
    const graph = buildGraph(commits);
    const band = graphWidth(graph) * 14 + 4;

    const refBadge = r => {
      const t = String(r).trim();
      const isHead = /^HEAD/.test(t);
      const isTag = t.startsWith("tag:");
      const isRemote = /^origin\//.test(t) && !/HEAD/.test(t);
      const cls = isHead ? "head" : isTag ? "tag" : isRemote ? "remote" : "local";
      const text = isTag ? t.slice(4).trim() : t;
      return `<span class="gitp2-ref ${cls}">${esc(text)}</span>`;
    };

    const changeRow = (c, stagedRow) => `<div class="gitp2-row">
      <input class="gitp2-row-check" type="checkbox" ${stagedRow ? "checked" : ""} aria-label="${stagedRow ? "取消暂存" : "暂存"} ${esc(c.file)}" data-act="git-stage" data-file="${esc(c.file)}">
      <span class="gitp2-st ${c.staged ? c.state : "Q"}">${esc(c.state)}</span>
      <span class="gitp2-path" title="${esc(c.file)}" data-act="git-diff" data-file="${esc(c.file)}">${esc(c.file)}</span>
      <span class="gitp2-hint">${stagedRow ? "git reset" : "git add"}</span>
    </div>`;

    const branchRow = (b, display) => `<div class="gitp2-branch ${b.current ? "current" : ""}" data-act="toast" data-msg="演示：切换到 ${esc(b.name)}">
      <span class="gitp2-branch-mark">${b.current ? icon("check", "ico-14") : icon("branch", "ico-14")}</span>
      <span class="gitp2-branch-name" title="${esc(b.name)}">${esc(display || b.name)}</span>
      <span class="gitp2-branch-track">${b.ahead || b.behind ? `↓${b.behind || 0} ↑${b.ahead || 0}` : ""}</span>
    </div>`;

    const commitRow = (c, i) => {
      const open = store.gitOpenCommit === c.sha;
      const files = (g.commitFiles || {})[c.sha] || [];
      return `<div class="gitp2-commit-row" data-act="git-commit-toggle" data-sha="${c.sha}" style="--graph-w:${band}px">
        <span class="gitp2-graph">${commitGraphSvg(graph[i], band, c.parents.length > 1)}</span>
        <div class="gitp2-commit-main">
          <div class="gitp2-commit-subject"><span class="txt">${esc(c.msg)}</span>
            <span class="gitp2-refs">${(c.refs || []).map(refBadge).join("")}</span></div>
          <div class="gitp2-commit-meta"><span class="author">${esc(c.author)}</span></div>
        </div>
        <div class="gitp2-commit-side"><span class="gitp2-commit-date">${esc(c.time)}</span></div>
        ${open ? `<div class="gitp2-files">${files.length ? files.map(f => `<div class="gitp2-file-row">
            <span class="gitp2-st ${f.state}">${esc(f.state)}</span>
            <span class="gitp2-file-path" title="${esc(f.path)}">${esc(f.path)}</span>
            <span class="gitp2-file-nums">+${f.add} −${f.del}</span>
          </div>`).join("") : `<span class="gitp2-note">该提交没有可显示的文件变更</span>`}</div>` : ""}
      </div>`;
    };

    return `<div class="gitp2">
      <div class="gitp2-top">
        <span class="gitp2-repo" title="${esc(g.repoPath)}"><span>${esc(g.repoPath)}</span></span>
        <div class="gitp2-top-acts">
          <button class="gitp2-top-btn" data-act="git-accel" aria-expanded="${Boolean(store.gitAccelOpen)}" title="国内加速"><span class="ico-zap">${icon("zap", "ico-14")}</span><span>国内加速</span>${g.accel.on ? `<span class="gitp2-accel-dot"></span>` : ""}</button>
          <button class="gitp2-top-btn" data-act="git-cred" aria-expanded="${Boolean(store.gitCredOpen)}" title="密钥配置"><span class="ico-key">${icon("key", "ico-14")}</span><span>密钥配置</span></button>
          <button class="gitp2-refresh" data-act="git-refresh" title="刷新" aria-label="刷新">${icon("refresh", "ico-14")}</button>
        </div>
        ${store.gitAccelOpen ? gitAccelPop() : ""}
        ${store.gitCredOpen ? gitCredPop() : ""}
      </div>

      <div class="gitp2-scroll">
        <section class="gitp2-card changes" aria-label="未提交变更">
          <div class="gitp2-head">
            <h2 class="gitp2-title">未提交变更</h2>
            ${g.changes.length ? `<span class="gitp2-count">${g.changes.length}</span>` : ""}
            <div class="gitp2-tools">
              <button class="gitp2-act" data-act="git-pull" title="fetch --all --prune">${icon("download", "ico-14")}提取</button>
              <button class="gitp2-act" data-act="git-update" title="pull --ff-only">${icon("download", "ico-14")}更新当前分支</button>
              <button class="gitp2-act" data-act="git-push" title="push（不使用强制推送）">${icon("upload", "ico-14")}推送当前分支</button>
            </div>
          </div>
          <div class="gitp2-body">
            <div class="gitp2-changes">
              ${g.changes.length === 0 ? `<p class="gitp2-empty">没有未提交的变更</p>` : ""}
              ${staged.length ? `<div>
                <div class="gitp2-group-h">已暂存 <span class="n">${staged.length}</span>
                  <button class="gitp2-link" data-act="git-unstage-all">全部取消暂存</button></div>
                ${staged.map(c => changeRow(c, true)).join("")}
              </div>` : ""}
              ${unstaged.length ? `<div>
                <div class="gitp2-group-h">未暂存 <span class="n">${unstaged.length}</span>
                  <button class="gitp2-link accent" data-act="git-stage-all">全部暂存</button></div>
                ${unstaged.map(c => changeRow(c, false)).join("")}
              </div>` : ""}
            </div>
            <div class="gitp2-commit">
              <textarea class="gitp2-commit-input" id="git-message" data-act="git-msg" rows="2" placeholder="提交信息（feat: …）">${esc(store.gitMessage || "")}</textarea>
              <div class="gitp2-commit-acts">
                <button class="gitp2-act" data-act="git-gen" ${g.changes.length ? "" : "disabled"} title="${g.changes.length ? "按已暂存改动生成提交信息（仿真）" : "没有变更可生成"}">${icon("sparkles", "ico-14")}AI 生成</button>
                <div class="gitp2-split">
                  <button class="gitp2-act primary" data-act="git-commit" ${canCommit ? "" : "disabled"}>提交</button>
                  <button class="gitp2-act primary caret" data-act="git-commit-menu" aria-label="更多提交操作" aria-expanded="${Boolean(store.gitCommitMenuOpen)}" ${canCommit ? "" : "disabled"}>▾</button>
                  ${store.gitCommitMenuOpen ? `<div class="gitp2-menu" role="menu">
                    <button class="gitp2-menu-item" role="menuitem" data-act="git-commit">提交</button>
                    <button class="gitp2-menu-item" role="menuitem" data-act="git-commit-push">提交并推送</button>
                  </div>` : ""}
                </div>
              </div>
              <div class="gitp2-commit-hint">${esc(hint)}</div>
            </div>
          </div>
        </section>

        <section class="gitp2-card branches" aria-label="分支">
          <div class="gitp2-head">
            <h2 class="gitp2-title">分支</h2>
            <label class="gitp2-search">${icon("search", "ico-14")}<input id="git-branch-q" data-act="git-branch-q" value="${esc(store.gitBranchQuery || "")}" placeholder="搜索分支" aria-label="搜索分支"></label>
            <div class="gitp2-tools">
              <button class="gitp2-link" data-act="git-branch-expand">全部展开</button>
              <button class="gitp2-link" data-act="git-branch-collapse">全部折叠</button>
              <button class="gitp2-link" data-act="git-remotes">管理远程</button>
              <button class="gitp2-act" data-act="git-branch-new">${icon("plus", "ico-14")}新建分支</button>
            </div>
          </div>
          <div class="gitp2-body scroll">
            ${q && !locals.length && !remotes.length ? `<p class="gitp2-empty">无匹配分支</p>` : ""}
            <div>
              <div class="gitp2-tree-h" data-act="git-group" data-group="local" role="button" aria-expanded="${openLocal}">
                <span class="gitp2-tree-caret">${icon(openLocal ? "chevronDown" : "chevronRight", "ico-12")}</span>
                <span>本地</span><span class="n">${locals.length}</span>
              </div>
              ${openLocal ? `<div class="gitp2-tree-kids">${locals.map(b => branchRow(b)).join("")}</div>` : ""}
            </div>
            <div>
              <div class="gitp2-tree-h" data-act="git-group" data-group="remote" role="button" aria-expanded="${openRemote}">
                <span class="gitp2-tree-caret">${icon(openRemote ? "chevronDown" : "chevronRight", "ico-12")}</span>
                <span>远程</span><span class="n">${remotes.reduce((n, r) => n + r.branches.length, 0)}</span>
              </div>
              ${openRemote ? `<div class="gitp2-tree-kids">${remotes.map(r => `
                <div>
                  <div class="gitp2-tree-h nest" data-act="git-remote-group" data-remote="${esc(r.remote)}" role="button">
                    <span class="gitp2-tree-caret">${icon("chevronDown", "ico-12")}</span><span>${esc(r.remote)}</span><span class="n">${r.branches.length}</span>
                  </div>
                  <div class="gitp2-tree-kids">${r.branches.map(b => branchRow(b, b.short)).join("")}</div>
                </div>`).join("")}</div>` : ""}
            </div>
          </div>
        </section>

        <section class="gitp2-card history" aria-label="提交历史">
          <div class="gitp2-history-head">
            <h2 class="gitp2-title">提交历史</h2>
            <div class="gitp2-filters">
              <input class="gitp2-filter-input" id="git-history-author" data-act="git-history-author" value="${esc(store.gitHistoryAuthor || "")}" placeholder="提交人" aria-label="提交人">
              <select class="gitp2-filter-select" id="git-history-branch" data-act="git-history-branch" aria-label="所有分支">
                <option value="">所有分支</option>
                ${g.branches.locals.map(b => `<option value="${esc(b.name)}" ${branchFilter === b.name ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
              </select>
              <select class="gitp2-filter-select" id="git-history-range" data-act="git-history-range" aria-label="时间范围">
                ${[["all", "全部"], ["day", "最近 24 小时"], ["week", "最近 7 天"]].map(([v, t]) => `<option value="${v}" ${(store.gitHistoryRange || "all") === v ? "selected" : ""}>${t}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="gitp2-body scroll">
            ${commits.length === 0 ? `<p class="gitp2-empty">没有符合条件的提交</p>` : commits.map(commitRow).join("")}
            <div class="gitp2-more"><button class="gitp2-act" data-act="git-more">加载更多</button></div>
          </div>
        </section>
      </div>
    </div>`;
  }

  /* 提交图谱：与软件同一套车道算法（前向单趟，2:1:2 段内共享坐标系）。 */
  function buildGraph(commits) {
    const lanes = [], rows = [];
    const take = () => { const f = lanes.indexOf(null); if (f >= 0) return f; lanes.push(null); return lanes.length - 1; };
    commits.forEach(c => {
      const incoming = [];
      lanes.forEach((h, i) => { if (h === c.sha) incoming.push(i); });
      const lane = incoming.length ? incoming[0] : take();
      while (lanes.length <= lane) lanes.push(null);
      if (!incoming.length) incoming.push(lane);
      const top = lanes.slice();
      incoming.forEach(i => { lanes[i] = null; });
      const outs = [];
      (c.parents || []).forEach((p, pos) => {
        let target;
        if (pos === 0) { target = lane; while (lanes.length <= target) lanes.push(null); }
        else { const wait = lanes.indexOf(p); target = wait >= 0 ? wait : take(); }
        lanes[target] = p;
        if (!outs.includes(target)) outs.push(target);
      });
      const edges = [];
      for (let i = 0; i < Math.max(top.length, lanes.length); i++) {
        const above = top[i] ?? null, below = lanes[i] ?? null;
        if (above === null) continue;
        if (below === above && i !== lane) { edges.push({ kind: "through", from: i, to: i }); continue; }
        edges.push({ kind: "in", from: i, to: lane });
      }
      outs.forEach(t => edges.push({ kind: "out", from: lane, to: t }));
      rows.push({ lane, edges });
    });
    return rows;
  }
  function graphWidth(rows) {
    return rows.reduce((w, r) => Math.max(w, r.lane + 1, ...r.edges.map(e => Math.max(e.from, e.to) + 1)), 1);
  }
  const LANE_COLORS = ["#4c6bf5", "#2f9e44", "#e8590c", "#9c36b5", "#0c8599", "#d6336c", "#f08c00", "#5f3dc4"];
  function laneColor(n) { return LANE_COLORS[((n % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]; }
  function commitGraphSvg(row, width, merge) {
    if (!row) return "";
    const pitch = 14, band = 44, mid = band / 2;
    const cx = l => l * pitch + pitch / 2 + 2;
    const bend = (from, fromY, to, toY) => {
      const x0 = cx(from), x1 = cx(to);
      if (x0 === x1) return `M ${x0} ${fromY} L ${x1} ${toY}`;
      const m = (toY - fromY) / 2;
      return `M ${x0} ${fromY} C ${x0} ${fromY + m} ${x1} ${toY - m} ${x1} ${toY}`;
    };
    const paths = row.edges.map(e => {
      const [fromY, toY] = e.kind === "through" ? [0, band] : e.kind === "in" ? [0, mid] : [mid, band];
      const color = laneColor(e.kind === "out" ? e.to : e.from);
      return `<path d="${bend(e.from, fromY, e.to, toY)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }).join("");
    const color = laneColor(row.lane);
    const dot = `<span class="gitp2-dot" style="left:${cx(row.lane)}px;color:${color};background:${merge ? "transparent" : color}"></span>`;
    return `<svg width="${width}" height="100%" viewBox="0 0 ${width} ${band}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${paths}</svg>${dot}`;
  }

  function gitAccelPop() {
    const a = D.git.accel;
    return `<div class="gitp2-pop" style="right:120px;top:44px" role="dialog" aria-label="国内加速">
      <div class="gitp2-pop-h">${icon("zap", "ico-14")}<b>国内加速</b></div>
      <p class="gitp2-pop-note">仅对 GitHub 的读取操作生效：按前缀把 <span class="mono">https://github.com/</span> 重写到镜像，写入与私有仓库仍走直连。</p>
      <label class="gitp2-switch-row"><span class="switch" role="switch" aria-checked="${a.on}" data-act="git-accel-toggle" tabindex="0"></span>启用加速</label>
      <div class="gitp2-field"><label for="git-accel-url">镜像前缀</label>
        <input id="git-accel-url" value="${esc(a.url)}" data-act="git-accel-url" placeholder="https://gh-proxy.com/">
        <span class="gitp2-err"></span></div>
      <div class="gitp2-pop-f"><button class="gitp2-act primary" data-act="git-accel-save">保存</button><button class="gitp2-act" data-act="git-accel-cancel">取消</button></div>
    </div>`;
  }

  function gitCredPop() {
    return `<div class="gitp2-pop" style="right:64px;top:44px" role="dialog" aria-label="密钥配置">
      <div class="gitp2-pop-h">${icon("key", "ico-14")}<b>密钥配置</b></div>
      <p class="gitp2-pop-note">按远端主机保存访问令牌，本机所有仓库共用；列表只显示掩码，保存后不回显原值。</p>
      ${D.git.credentialHosts.length ? D.git.credentialHosts.map(h => `<div class="gitp2-branch">
        <span class="gitp2-branch-mark">${icon("globe", "ico-14")}</span>
        <span class="gitp2-branch-name">${esc(h.host)}</span>
        <span class="gitp2-branch-track">••••••••</span></div>`).join("") : `<p class="gitp2-empty">尚未保存任何主机的令牌</p>`}
      <div class="gitp2-field" style="margin-top:8px"><label for="git-cred-host">主机</label>
        <input id="git-cred-host" value="github.com" data-act="git-cred-host" placeholder="github.com"></div>
      <div class="gitp2-field"><label for="git-cred-token">访问令牌</label>
        <input id="git-cred-token" type="password" value="" data-act="git-cred-token" placeholder="粘贴 Personal Access Token">
        <span class="gitp2-err"></span></div>
      <div class="gitp2-pop-f"><button class="gitp2-act primary" data-act="git-cred-save">保存</button><button class="gitp2-act" data-act="git-cred-cancel">取消</button></div>
    </div>`;
  }

  function codeDiffModal(file) {
    const c = D.git.changes.find(x => x.file === file);
    if (!c) return;
    openDialog(dlgShell("变更详情", esc(file), `<div class="diff">${D.git.diff.split("\n").map(l => `<div class="dl ${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l) || " "}</div>`).join("")}</div>`,
      `<span class="left caption">${c.state === "A" ? "新增" : "修改"} · +${c.add} −${c.del}</span><button class="btn" data-act="close-dialog">关闭</button>`, "modal-lg"));
  }

  function officeTab(p) {
    const docs = D.office[p.id] || [];
    const doc = docs.find(d => d.name === store.officeDoc) || docs[0];
    return `<div class="code-layout">
      <section class="card"><div class="card-h" style="height:42px;padding:0 12px"><h3 style="font-size:13px">文档 <span class="sub">${docs.length} 份</span></h3><span class="spacer"></span><button class="icon-btn" data-act="toast" data-msg="演示：新建文档">${icon("plus")}</button></div>
        <div class="file-tree">${docs.map(d => `<button class="file-row ${doc && doc.name === d.name ? "active" : ""}" data-act="open-office" data-name="${esc(d.name)}">${icon("fileText", "ico-14")}<span class="ellipsis">${esc(d.name)}</span></button>`).join("")}</div>
      </section>
      <section class="card"><div class="editor-h"><span class="path">${esc(doc ? doc.name : "")}</span><span class="spacer"></span><span class="caption">${doc ? "更新于 " + esc(doc.updated) : ""}</span></div>
        <article class="doc-body" style="max-width:none">${doc ? md(doc.body) : ""}</article></section>
    </div>`;
  }

  Screens.designTab = designTab;
  Screens.tasksTab = tasksTab; // rail由后加载requirements-workspace的唯一包装器提供，任务正文不复制。
  Screens.codeTab = codeTab;
  Screens.codeDiffModal = codeDiffModal;
})();





