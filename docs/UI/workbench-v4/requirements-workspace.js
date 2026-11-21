/* UI-CR045-v1 · 仅可操作设计资源。D为合成夹具，不读取磁盘、不接模型/派发后端。main.js之后加载。 */
(function () {
  "use strict";
  const { D, store, esc, icon } = UI;
  const Screens = window.Screens, actions = window.__actions;
  const projects = new Map();
  const kindNames = { vision: "愿景", epic: "Epic", feature: "Feature", story: "Story", model: "模型" };
  const identity = (project, kind, id) => JSON.stringify([project, kind, id]);
  const button = (act, label, extra = "", cls = "btn sm") => `<button class="${cls}" data-act="${act}" ${extra}>${label}</button>`;

  // 仅演示安全阅读策略，不是正式软件的Markdown安全保证。链接默认不导航，不加载外部资源。
  function safeMarkdown(text) {
    const template = document.createElement("template");
    template.innerHTML = UI.md(String(text || ""));
    template.content.querySelectorAll("script,iframe,object,embed,img,svg,style,link,video,audio,form").forEach(el => el.remove());
    template.content.querySelectorAll("*").forEach(el => {
      Array.from(el.attributes).forEach(attr => { if (/^on/i.test(attr.name) || ["style", "src", "srcdoc"].includes(attr.name)) el.removeAttribute(attr.name); });
      if (el.tagName === "A") { el.removeAttribute("href"); el.setAttribute("title", "设计阅读：外部与本地链接不执行"); }
    });
    return template.innerHTML;
  }
  function headings(html, prefix) {
    let n = 0;
    const toc = [];
    const body = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_, level, attrs, title) => {
      const id = prefix + "-h" + n++;
      toc.push({ id, level: Number(level), title: title.replace(/<[^>]*>/g, "") });
      return `<h${level} id="${id}">${title}</h${level}>`;
    });
    return { body, toc };
  }
  function state(project) {
    if (!projects.has(project)) projects.set(project, { tabs: [], active: null, mode: "document", treeHidden: false, tocHidden: false, query: "", collapsed: new Set(), treeScroll: 0, tocScroll: 0, mapZoom: 1, mapCollapsed: new Set(), mapScroll: [0, 0], taskView: "tree" });
    return projects.get(project);
  }
  function inventory(p) {
    const list = D.requirements.filter(r => r.project === p.id);
    const realVision = list.find(r => r.kind === "vision") || (Array.isArray(D.visions) ? D.visions.find(v => v.project === p.id) : null) || (D.vision && D.vision.project === p.id ? D.vision : null);
    const vision = realVision || state(p.id).vision || { id: "SCENARIO-VISION", kind: "vision", project: p.id, title: p.name + " · 情景愿景", summary: p.desc || "项目目标未提供", body: `# ${p.name} · 情景愿景\n\n> 情景愿景（合成）：D未提供真实愿景实体或源文件。以下只按D.projects中的项目目标展示，不冒充仓库愿景事实。\n\n## 项目目标\n\n${p.desc || "D中的项目目标未提供；待补充。"}\n\n## 阅读范围\n\n本项目已有需求、验收条件与其它字段全部来自同一D合成夹具。全文预览不会因搜索、折叠、选中或派发资格而过滤。\n\n## 来源边界\n\n无真实愿景文件读取接口；人员、状态、执行器、费用及运行记录均为仿真，不代表生产或正式软件实测。`, scenario: true };
    if(!realVision)state(p.id).vision=vision;
    const all = [vision, ...list.filter(r => r !== realVision)];
    return { vision, all };
  }
  function key(p, node) { return identity(p.id, node.kind, node.id); }
  function current(p, s) {
    const data = inventory(p);
    s.tabs = s.tabs.filter(t => data.all.some(r => key(p, r) === t.key));
    if (!s.tabs.length) s.tabs.push({ key: key(p, data.vision), kind: "vision", id: data.vision.id, scroll: 0 });
    if (!s.tabs.some(t => t.key === s.active)) s.active = s.tabs[0].key;
    const tab = s.tabs.find(t => t.key === s.active);
    return { data, tab, node: data.all.find(r => key(p, r) === tab.key) };
  }
  function capture() {
    const root = document.querySelector(".req-workspace");
    if (!root) return;
    const s = state(root.dataset.project), active = s.tabs.find(t => t.key === root.dataset.active);
    const reader = root.querySelector(".req-reader"), tree = root.querySelector(".req-tree-scroll"), toc = root.querySelector(".req-toc-list"), map = root.querySelector(".req-map-scroll");
    if (reader) { if (root.dataset.mode === "preview") s.previewScroll = reader.scrollTop; else if (active) active.scroll = reader.scrollTop; }
    const openDetails = Array.from(root.querySelectorAll(".req-source-field")).flatMap((el, i) => el.open ? [i] : []);
    if (root.dataset.mode === "preview") s.previewDetails = openDetails; else if (active) active.openDetails = openDetails;
    if (tree) s.treeScroll = tree.scrollTop;
    if (toc) s.tocScroll = toc.scrollTop;
    if (map) s.mapScroll = [map.scrollLeft, map.scrollTop];
  }
  function afterRender() {
    const root = document.querySelector(".req-workspace");
    if (!root) return;
    const s = state(root.dataset.project), tab = s.tabs.find(t => t.key === root.dataset.active);
    const reader = root.querySelector(".req-reader"), tree = root.querySelector(".req-tree-scroll"), toc = root.querySelector(".req-toc-list"), map = root.querySelector(".req-map-scroll");
    const opened = new Set(root.dataset.mode === "preview" ? s.previewDetails || [] : tab?.openDetails || []);
    root.querySelectorAll(".req-source-field").forEach((el, i) => { el.open = opened.has(i); });
    if (reader) reader.scrollTop = root.dataset.mode === "preview" ? s.previewScroll || 0 : tab?.scroll || 0;
    if (tree) tree.scrollTop = s.treeScroll;
    if (toc) toc.scrollTop = s.tocScroll;
    if (map) { map.scrollLeft = s.mapScroll[0]; map.scrollTop = s.mapScroll[1]; }
    [["req-workspace-tree", ".req-tree-pane"], ["req-workspace-toc", ".req-toc-pane"]].forEach(([act, selector]) => {
      const pane = root.querySelector(selector), trigger = root.querySelector(`[data-act="${act}"]`);
      if (trigger) trigger.setAttribute("aria-expanded", String(Boolean(pane && getComputedStyle(pane).display !== "none")));
    });
  }
  const oldProject = Screens.project;
  Screens.project = id => { capture(); const html = oldProject(id); requestAnimationFrame(afterRender); return html; };
  function openNode(project, kind, id) {
    capture();
    const p = D.projects.find(p => p.id === project);
    if (!p) return;
    const s = state(project), node = inventory(p).all.find(r => r.id === id && (!kind || r.kind === kind));
    if (!node) { UI.toast("需求源未提供或已移除"); return; }
    const k = key(p, node);
    if (!s.tabs.some(t => t.key === k)) s.tabs.push({ key: k, id: node.id, kind: node.kind, scroll: 0 });
    s.active = k;
    if (s.mode !== "map") s.mode = "document";
    store.selectedReq = node.scenario ? null : node.id; store.reqMenu = null;
    UI.render();
  }
  function fieldValue(value) { return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : value == null ? "未提供" : String(value); }
  function documentHtml(node, depth = 0) {
    if (!node) return `<div class="req-empty"><b>源未提供</b><p>无可读取实体，不生成虚构正文。</p></div>`;
    const source = node.scenario ? "情景愿景 · 按D项目目标合成" : "D同源合成实体 · 非真实文件读取";
    const body = node.body ?? node.content ?? node.markdown;
    const label = (D.statusMeta[node.status] || {}).label || node.status || "未提供";
    return `<section class="req-entity" data-entity-id="${esc(node.id)}" data-depth="${depth}">
      <div class="req-entity-meta"><span>${esc(kindNames[node.kind] || node.kind)}</span><span>${esc(node.id)}</span><span>${esc(label)}</span></div>
      <h1>${esc(node.title || node.id)}</h1><p class="req-source">${esc(source)}</p>
      ${body != null ? safeMarkdown(String(body).replace(/^\s*#\s+[^\n]*(?:\n|$)/, "")).replace(/<h1>/g, "<h2>").replace(/<\/h1>/g, "</h2>") : `<h2>需求描述</h2><p>${esc(node.summary || "正文未提供。D只有结构字段；不冒充完整源文件。")}</p><p class="req-source">实体源Markdown未接入；以下完整展示当前D字段。</p>`}
      ${node.error ? `<p class="req-error">读取失败：${esc(node.error)}；其它条目继续展示。此为实体提供的状态。</p>` : ""}
      ${Array.isArray(node.acs) ? `<h2>可观察验收条件</h2>${node.acs.length ? node.acs.map(a => `<div class="req-ac"><b>${esc(a.id)}</b><p>${esc(a.text || "验收正文未提供")}</p><span class="caption">状态：${esc(a.state || "未提供")} · 合成</span></div>`).join("") : `<p>当前实体没有验收条目。</p>`}` : ""}
      <h2>完整实体字段（合成）</h2><dl class="req-fields">${Object.entries(node).map(([name, value]) => `<dt>${esc(name)}</dt><dd>${["body", "content", "markdown"].includes(name) ? `<details class="req-source-field"><summary>源字段（合成）· ${String(value || "").length} 字符，展开查看</summary><pre>${esc(fieldValue(value))}</pre></details>` : `<pre>${esc(fieldValue(value))}</pre>`}</dd>`).join("")}</dl>
    </section>`;
  }
  function ordered(all) {
    const rows = [], seen = new Set();
    function walk(n, depth, chain) {
      if (seen.has(n)) return;
      seen.add(n); rows.push({ node: n, depth });
      all.filter(c => c.parent === n.id && !chain.has(c.id)).forEach(c => walk(c, depth + 1, new Set([...chain, c.id])));
    }
    all.filter(n => n.kind === "vision").forEach(n => walk(n, 0, new Set([n.id])));
    all.filter(n => n.kind !== "vision" && !n.parent).forEach(n => walk(n, 1, new Set([n.id])));
    all.forEach(n => walk(n, 1, new Set([n.id]))); // 孤立/循环节点仍全文展示，不静默漏掉。
    return rows;
  }
  function treeRows(p, s, all) {
    const rows = ordered(all), query = s.query.trim().toLowerCase();
    const visible = rows.filter(({ node }) => !query || (node.id + " " + node.title + " " + (node.summary || "")).toLowerCase().includes(query));
    const hiddenParents = new Set();
    return visible.map(({ node: n, depth }) => {
      if (!query && (hiddenParents.has(n.parent) || s.collapsed.has(n.parent))) { hiddenParents.add(n.id); return ""; }
      const kids = all.filter(c => c.parent === n.id), on = s.active === key(p, n);
      return `<div class="req-tree-row ${on ? "on" : ""}" style="--req-depth:${query ? 0 : depth}" role="treeitem" aria-selected="${on}" ${kids.length ? `aria-expanded="${!s.collapsed.has(n.id)}"` : ""}>
        ${kids.length ? button("req-workspace-collapse", icon(s.collapsed.has(n.id) ? "chevronRight" : "chevronDown", "ico-14"), `data-id="${esc(n.id)}" aria-label="折叠或展开${esc(n.title)}"`, "req-tree-caret") : '<span class="req-tree-caret"></span>'}
        <button class="req-tree-open" data-act="req-workspace-open" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}" title="${esc(n.title)}"><span class="req-kind ${esc(n.kind)}">${esc(kindNames[n.kind] || n.kind)}</span><span class="ellipsis">${esc(n.title)}</span><small>${esc(n.id)}</small></button>
        ${n.kind === "vision" ? "" : button("req-menu", icon("dots", "ico-14"), `data-id="${esc(n.id)}" aria-label="${esc(n.title)}更多操作"`, "req-row-more")}
      </div>`;
    }).join("") || '<p class="req-empty">没有匹配条目；全文预览仍包含全部实体。</p>';
  }
  function mapHtml(p, s, data) {
    const all = data.all;
    function branch(n, chain) {
      const children = all.filter(c => c.parent === n.id && !chain.has(c.id));
      if (n.kind === "vision") children.push(...all.filter(c => c.kind !== "vision" && !c.parent));
      const shut = s.mapCollapsed.has(key(p, n));
      return `<li><div class="req-map-node ${s.active === key(p, n) ? "on" : ""}">${button("req-workspace-open", `<small>${esc(kindNames[n.kind] || n.kind)} · ${esc(n.id)}</small><b>${esc(n.title)}</b>`, `data-id="${esc(n.id)}" data-kind="${esc(n.kind)}"`, "req-map-open")}${children.length ? button("req-map-collapse", icon(shut ? "plus" : "minimize", "ico-14"), `data-key="${esc(key(p, n))}" aria-label="折叠或展开节点"`, "req-map-fold") : ""}</div>${children.length && !shut ? `<ul>${children.map(c => branch(c, new Set([...chain, c.id]))).join("")}</ul>` : ""}</li>`;
    }
    const reachable = new Set();
    function reach(n) { if (reachable.has(n)) return; reachable.add(n); all.filter(c => c.parent === n.id).forEach(reach); }
    all.filter(n => !n.parent || n.kind === "vision").forEach(reach);
    const orphaned = all.filter(n => !reachable.has(n));
    return `<section class="req-map-area"><div class="req-map-controls"><b>思维导图</b>${button("req-map-zoom", "−", 'data-delta="-0.1" aria-label="缩小"') }<span>${Math.round(s.mapZoom * 100)}%</span>${button("req-map-zoom", "+", 'data-delta="0.1" aria-label="放大"')}${button("req-map-reset", "重置")}${button("req-map-all", "全部展开", 'data-collapse="false"')}${button("req-map-all", "折叠分支", 'data-collapse="true"')}</div><div class="req-map-scroll"><div class="req-map-scale" style="zoom:${s.mapZoom}"><ul class="req-map-tree">${branch(data.vision, new Set([data.vision.id]))}${orphaned.map(n => branch(n, new Set([n.id]))).join("")}<li><div class="req-map-unavailable"><b>数据模型</b><span>真实模型接口／数据未接入</span><small>不生成模型或关系；AI模型配置不是业务数据模型。</small></div></li></ul></div></div><div class="req-map-help">点击节点在下方贯通详情阅读；节点选择、缩放与折叠按项目保留。此图来自同源合成需求。</div></section>`;
  }
  function requirementsWorkspace(p) {
    const s = state(p.id), { data, tab, node } = current(p, s);
    const liveId=JSON.stringify(['requirement',p.id,node.kind,node.id]);
    const raw=node.body??node.content??node.markdown;
    const editableBody=typeof raw==='string'?LiveDoc.render(liveId,raw,{write:(text,expected)=>{const current=node.body??node.content??node.markdown;if(current!==expected)return {ok:false,conflict:true,error:'源版本已变，停止覆盖。'};if(node.body!=null)node.body=text;else if(node.content!=null)node.content=text;else node.markdown=text;node.designSynced=false;return {ok:true};},onChange:text=>{const root=document.querySelector('.req-workspace');if(root?.dataset.project!==p.id)return;const rows=text.split('\n').filter(l=>/^#{1,6}\s/.test(l));root.querySelector('.req-toc-list').innerHTML=rows.map((l,n)=>'<button class="req-toc-link" data-act="live-req-anchor" data-index="'+n+'">'+esc(l.replace(/^#+\s/,''))+'</button>').join('');}}):null;
    const content = s.mode === "preview" ? ordered(data.all).map(({ node, depth }) => documentHtml(node, depth)).join("") : documentHtml(node);
    const doc = headings(content, "req-" + p.id + "-" + (s.mode === "preview" ? "all" : node.id));
    const chosen = s.mode === "map" ? "map" : s.mode === "preview" ? "preview" : "document";
    return `<div class="req-workspace ${s.treeHidden ? "req-tree-hidden" : ""} ${s.tocHidden ? "req-toc-hidden" : ""} ${s.treeOpened ? "req-tree-forced" : ""} ${s.tocOpened ? "req-toc-forced" : ""}" data-project="${esc(p.id)}" data-active="${esc(tab.key)}" data-mode="${s.mode}" data-ui-version="UI-CR045-v1">
      <nav class="req-rail" aria-label="需求工作区">${[["document", "fileText", "文档"], ["preview", "eye", "全文"], ["map", "workflow", "导图"]].map(([mode, ic, label]) => button("req-workspace-mode", icon(ic) + `<span>${label}</span>`, `data-mode="${mode}" aria-label="${mode === "preview" ? "全文预览" : mode === "map" ? "思维导图" : "需求文档"}"`, "rail-btn " + (chosen === mode ? "on" : ""))).join("")}<div class="rail-sep"></div>${button("req-workspace-tree", icon("panelLeft") + '<span>需求树</span>', 'aria-label="切换需求树"', "rail-btn")}${button("req-workspace-toc", icon("panelRight") + '<span>目录</span>', 'aria-label="切换章节目录"', "rail-btn")}</nav>
      <aside class="req-tree-pane" data-pane="requirements-tree" data-default="320" data-min="200" data-max="480"><div class="req-tree-head"><b>需求文档</b>${button("req-new", icon("plus", "ico-14"), 'data-kind="epic" data-parent="" aria-label="新增Epic"', "icon-btn")}</div><label class="req-search">${icon("search", "ico-14")}<input class="input" id="req-workspace-search" placeholder="搜索编号、标题" value="${esc(s.query)}"></label><div class="req-tree-scroll" role="tree">${treeRows(p, s, data.all)}</div><div class="req-tree-foot">${data.all.length} 个同源实体 · 合成<br>搜索与折叠不影响全文预览</div></aside>
      <section class="req-document-pane" data-pane="requirements-main" data-min="320"><div class="req-tabs" role="tablist" aria-label="内部需求文档Tab">${s.tabs.map(t => { const r = data.all.find(n => key(p, n) === t.key); return `<div class="req-tab ${s.active === t.key ? "on" : ""}"><button role="tab" aria-selected="${s.active === t.key}" data-act="req-workspace-tab" data-key="${esc(t.key)}" title="${esc(r.title)}"><em class="req-tab-key">${esc(r.kind === "vision" ? "愿景" : r.id)}</em><span class="req-tab-title">${esc(r.title)}</span></button>${button("req-workspace-close", icon("x", "ico-14"), `data-key="${esc(t.key)}" aria-label="关闭${esc(r.title)}"`, "req-tab-close")}</div>`; }).join("")}</div>
      <div class="req-toolbar">${button("req-workspace-mode", icon("eye", "ico-14") + "全文预览", 'data-mode="preview"', "btn sm " + (s.mode === "preview" ? "primary" : ""))}${button("req-workspace-mode", icon("workflow", "ico-14") + "思维导图", 'data-mode="map"', "btn sm " + (s.mode === "map" ? "primary" : ""))}<span class="spacer"></span>${node.kind === "vision" ? '<span class="caption">情景/源愿景阅读</span>' : button("req-edit", icon("edit", "ico-14") + "元信息", `data-id="${esc(node.id)}"`) }${node.kind !== "vision" ? button("req-dispatch", icon("play", "ico-14") + "派发预检", `data-id="${esc(node.id)}"`) : ""}</div>
      ${s.mode === "map" ? mapHtml(p, s, data) : ""}<article class="req-reader doc-body" aria-label="${s.mode === "preview" ? "全部需求全文" : "当前需求详情"}">${s.mode === "preview" ? `<header class="req-preview-intro"><h1>全项目需求 · 全文预览</h1><p>${data.all.length} 个实体，含全部AC与字段；不按派发资格过滤。D为合成夹具，非真实源文件全文读取。</p></header>` : ""}${s.mode==="document"&&editableBody?editableBody:doc.body}</article></section>
      <aside class="req-toc-pane" data-pane="requirements-toc" data-default="240" data-min="160" data-max="360"><div class="req-toc-head"><b>${s.mode === "preview" ? "全文目录" : "本页目录"}</b><span>${doc.toc.length}</span></div><div class="req-toc-list">${doc.toc.map(h => button("req-workspace-anchor", h.title, `data-anchor="${esc(h.id)}" style="--toc-level:${h.level}"`, "req-toc-link")).join("") || '<p class="caption">无章节</p>'}</div><div class="req-tree-foot">新设计待实现<br>仅仿真，无真实文件读取</div></aside>
    </div>`;
  }
  function activeState() { return state(store.projectId); }
  actions["req-workspace-open"] = el => openNode(store.projectId, el.dataset.kind, el.dataset.id);
  actions["select-req"] = actions["req-detail"] = el => openNode(store.projectId, null, el.dataset.id);
  Screens.reqDetailModal = id => openNode(store.projectId, null, id); // 阅读统一贯通，不留第二套阅读模态。
  actions["req-workspace-mode"] = el => { capture(); activeState().mode = el.dataset.mode; UI.render(); };
  actions["req-workspace-tree"] = () => { capture(); const s = activeState(); const pane = document.querySelector(".req-tree-pane"); const visible = pane && getComputedStyle(pane).display !== "none"; s.treeHidden = Boolean(visible); s.treeOpened = !visible; UI.render(); };
  actions["req-workspace-toc"] = () => { capture(); const s = activeState(); const pane = document.querySelector(".req-toc-pane"); const visible = pane && getComputedStyle(pane).display !== "none"; s.tocHidden = Boolean(visible); s.tocOpened = !visible; UI.render(); };
  actions["req-workspace-tab"] = el => { capture(); activeState().active = el.dataset.key; if (activeState().mode !== "map") activeState().mode = "document"; UI.render(); };
  actions["req-workspace-close"] = el => {
    capture(); const s = activeState(), i = s.tabs.findIndex(t => t.key === el.dataset.key); if (i < 0) return;
    s.tabs.splice(i, 1); if (s.active === el.dataset.key) s.active = s.tabs[Math.max(0, i - 1)]?.key || null;
    // 关闭最后一页回默认愿景，不删除任何实体。
    UI.render();
  };
  actions["req-workspace-collapse"] = el => { capture(); const set = activeState().collapsed; set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id); UI.render(); };
  actions["req-workspace-anchor"] = el => {
    const root = document.querySelector(".req-workspace"), reader = root?.querySelector(".req-reader"), target = document.getElementById(el.dataset.anchor);
    if (reader && target && reader.contains(target)) { reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 16; capture(); }
  };
  actions["req-map-zoom"] = el => { capture(); const s = activeState(); s.mapZoom = Math.max(0.5, Math.min(1.8, Math.round((s.mapZoom + Number(el.dataset.delta)) * 10) / 10)); UI.render(); };
  actions["req-map-collapse"] = el => { capture(); const set = activeState().mapCollapsed; set.has(el.dataset.key) ? set.delete(el.dataset.key) : set.add(el.dataset.key); UI.render(); };
  actions["req-map-reset"] = () => { capture(); const s = activeState(); s.mapZoom = 1; s.mapCollapsed.clear(); s.mapScroll = [0, 0]; UI.render(); };
  actions["req-map-all"] = el => { capture(); const s = activeState(), p = D.projects.find(p => p.id === store.projectId); s.mapCollapsed = new Set(el.dataset.collapse === "true" ? inventory(p).all.filter(n => n.kind !== "vision").map(n => key(p, n)) : []); UI.render(); };
  const oldJump = actions["jump-req"];
  actions["jump-req"] = (el, event) => { oldJump(el, event); openNode(el.dataset.project, null, el.dataset.id); };
  const oldSave = actions["req-save"];
  actions["req-save"] = (el, event) => { oldSave(el, event); if (!document.getElementById("dialog")?.open && store.selectedReq) openNode(store.projectId, null, store.selectedReq); };
  actions["task-workspace-view"] = el => { const s = activeState(); s.taskView = el.dataset.view; store.taskWorkspaceView = s.taskView; UI.render(); requestAnimationFrame(() => document.querySelector(s.taskView === "detail" ? ".task-detail-pane" : ".task-list-pane")?.scrollIntoView({ block: "nearest", inline: "nearest" })); };
  // 唯一rail模板驻留后置资源，同步注册再调用；兼容旧screens-project缓存，不依赖新增导出。
  Screens.taskWorkspace = (p, content) => {
    if (/class="[^"]*\btask-workspace\b/.test(content)) return content;
    const view = state(p.id).taskView;
    return `<div class="task-workspace" data-task-view="${view}" data-project="${esc(p.id)}" data-ui-scene="SC-045-05" data-ui-version="UI-CR045-v1">
      <nav class="req-rail" aria-label="任务工作区">
        <button class="rail-btn ${view === "tree" ? "on" : ""}" data-act="task-workspace-view" data-view="tree" aria-label="派发树">${icon("workflow")}<span>派发树</span></button>
        <button class="rail-btn ${view === "detail" ? "on" : ""}" data-act="task-workspace-view" data-view="detail" aria-label="任务详情">${icon("fileText")}<span>详情</span></button>
      </nav><section class="task-content-pane">${content}</section>
    </div>`;
  };
  const oldTasks = Screens.tasksTab;
  Screens.tasksTab = p => {
    store.taskWorkspaceView = state(p.id).taskView;
    return Screens.taskWorkspace(p, oldTasks(p));
  };
  document.addEventListener("input", e => { if (e.target.id === "req-workspace-search") { capture(); activeState().query = e.target.value; UI.render(); } });
  document.addEventListener("scroll", e => { if (e.target?.closest?.(".req-workspace")) capture(); }, true);
  document.addEventListener("toggle", e => { if (e.target?.matches?.(".req-source-field")) capture(); }, true);
  document.addEventListener("click", capture, true);
  Screens.requirementsWorkspace = requirementsWorkspace;
  window.RequirementsWorkspace = Object.freeze({ version: "UI-CR045-v1", afterRender, capture, openNode, safeMarkdown, getState: project => state(project) });
  UI.render();
})();
