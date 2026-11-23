/* UI-CR045-v1 · 仅可操作设计资源。D为合成夹具，不读取磁盘、不接模型/派发后端。main.js之后加载。 */
(function () {
  "use strict";
  const { D, store, esc, icon } = UI;
  const Screens = window.Screens, actions = window.__actions;
  const projects = new Map();
  /* UI-CR066：Vision 与下方 Epic/Feature/Story 同名同级，统一用英文层级名。 */
  const kindNames = { vision: "Vision", epic: "Epic", feature: "Feature", story: "Story", model: "模型" };
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
    /* UI-CR066 r2：数据库／领域设计模型作为项目级独立分支进入同一实体集合。 */
    const models = (Array.isArray(D.designModels) ? D.designModels : []).filter(m => m.project === p.id)
      .map(m => ({ id: m.id, kind: "model", project: p.id, title: m.title, summary: m.summary || "", relPath: m.relPath, status: "running" }));
    const all = [vision, ...list.filter(r => r !== realVision), ...models];
    return { vision, all, models };
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
    /* UI-CR066：目录点击后把画布滚动到目标节点；只在导图模式执行。 */
    if (root.dataset.mode === "map" && window.RequirementsMindmap) window.RequirementsMindmap.locateSelected();
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
  /* UI-CR066 r2：预览按 Vision H2／Epic H3／Feature H4／Story H5 分级；模型单独成段。 */
  const PREVIEW_HEADING = { vision: "h2", epic: "h3", feature: "h4", story: "h5", bug: "h5", model: "h3" };
  function documentHtml(node, depth = 0, preview = false) {
    if (!node) return `<div class="req-empty"><b>源未提供</b><p>无可读取实体，不生成虚构正文。</p></div>`;
    const source = node.kind === "model" ? "设计夹具 · 数据库／领域设计模型" : node.scenario ? "情景愿景 · 按D项目目标合成" : "D同源合成实体 · 非真实文件读取";
    const body = node.body ?? node.content ?? node.markdown;
    const label = (D.statusMeta[node.status] || {}).label || node.status || "未提供";
    return `<section class="req-entity" data-entity-id="${esc(node.id)}" data-depth="${depth}">
      <div class="req-entity-meta"><span>${esc(kindNames[node.kind] || node.kind)}</span><span>${esc(node.id)}</span><span>${esc(label)}</span></div>
      ${(() => { const H = preview ? (PREVIEW_HEADING[node.kind] || "h2") : "h1"; return `<${H}>${esc(node.title || node.id)}</${H}>`; })()}<p class="req-source">${esc(source)}</p>
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
    /* UI-CR066：整块为标准思维导图，右侧悬浮详情框；旧「上导图下正文」布局不再使用。 */
    return window.RequirementsMindmap.mapHtml(p, s, data);
  }
  /** UI-CR066：目录按标题层级折叠子章节，折叠状态按项目保留。 */
  function tocRows(s, doc) {
    const collapsed = s.tocCollapsed || (s.tocCollapsed = new Set());
    const heads = doc.toc;
    const visible = [];
    const hiddenParents = [];
    heads.forEach((head, index) => {
      const level = head.level;
      while (hiddenParents.length && hiddenParents[hiddenParents.length - 1].level >= level) hiddenParents.pop();
      if (hiddenParents.length) return;
      visible.push({ head, index });
      if (collapsed.has(index)) hiddenParents.push({ level, index });
    });
    return { visible, collapsed, heads };
  }
  function tocHtml(s, doc) {
    const { visible, collapsed, heads } = tocRows(s, doc);
    if (!heads.length) return '<p class="caption">无章节</p>';
    return visible.map(({ head, index }) => {
      const hasKids = heads.slice(index + 1).some(next => next.level > head.level);
      const shut = collapsed.has(index);
      return `<div class="req-toc-item" style="--toc-level:${head.level}">
        ${hasKids ? button("req-toc-fold", icon(shut ? "chevronRight" : "chevronDown", "ico-14"), `data-index="${index}" aria-expanded="${!shut}" aria-label="${shut ? "展开" : "折叠"}${esc(head.title)}"`, "req-toc-caret") : '<span class="req-toc-caret"></span>'}
        ${button("req-workspace-anchor", head.title, `data-anchor="${esc(head.id)}"`, "req-toc-link")}
      </div>`;
    }).join("");
  }

  /* UI-CR066 r2：预览目录按 Vision／Epic／Feature／Story 四级实体树组织，模型为项目级分支。 */
  function previewTocHtml(s, data) {
    const collapsed = s.tocCollapsed || (s.tocCollapsed = new Set());
    const kids = new Map();
    data.all.forEach(node => { if (node.parent) kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]); });
    const rows = [];
    const walk = (node, depth) => {
      rows.push({ node, depth });
      (kids.get(node.id) ?? []).forEach(child => walk(child, depth + 1));
    };
    const vision = data.all.find(node => node.kind === "vision");
    if (vision) walk(vision, 0);
    data.all.filter(node => node.kind !== "vision" && !node.parent && node.id !== vision?.id).forEach(node => walk(node, 1));
    data.all.filter(node => node.kind === "model").forEach(node => rows.push({ node, depth: 1 }));
    /* 被折叠条目的下级整体隐藏；遇同级或更高级条目恢复。 */
    const visible = [];
    let hiddenDepth = -1;
    rows.forEach(({ node, depth }) => {
      if (hiddenDepth >= 0 && depth > hiddenDepth) return;
      hiddenDepth = -1;
      visible.push({ node, depth });
      if (collapsed.has(node.id)) hiddenDepth = depth;
    });
    return visible.map(({ node, depth }) => {
      /* hasKids：其后第一个层级更深的条目，且中途不出现同级或更高级条目。 */
      let hasKids = false;
      const start = rows.findIndex(row => row.node.id === node.id);
      for (let i = start + 1; i < rows.length; i++) {
        if (rows[i].depth <= depth) break;
        if (rows[i].depth === depth + 1) { hasKids = true; break; }
      }
      const shut = collapsed.has(node.id);
      return `<div class="req-toc-item" style="--toc-level:${depth + 1}">
        ${hasKids ? button("req-toc-fold", icon(shut ? "chevronRight" : "chevronDown", "ico-14"), `data-id="${esc(node.id)}" aria-expanded="${!shut}" aria-label="${shut ? "展开" : "折叠"}${esc(node.title)}"`, "req-toc-caret") : '<span class="req-toc-caret"></span>'}
        <button class="req-toc-link" data-act="req-toc-goto" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}">
          <span class="req-kind ${esc(node.kind)}">${esc(node.kind === "model" ? "模型" : (kindNames[node.kind] || node.kind))}</span>
          <span class="ellipsis">${esc(node.title || node.id)}</span>
        </button>
      </div>`;
    }).join("");
  }

  function requirementsWorkspace(p) {
    const s = state(p.id), { data, tab, node } = current(p, s);
    const liveId=JSON.stringify(['requirement',p.id,node.kind,node.id]);
    const raw=node.body??node.content??node.markdown;
    const editableBody=typeof raw==='string'?LiveDoc.render(liveId,raw,{write:(text,expected)=>{const current=node.body??node.content??node.markdown;if(current!==expected)return {ok:false,conflict:true,error:'源版本已变，停止覆盖。'};if(node.body!=null)node.body=text;else if(node.content!=null)node.content=text;else node.markdown=text;node.designSynced=false;return {ok:true};},onChange:()=>{/* UI-CR066：目录随正文重算，交给统一渲染，避免绕过目录折叠逻辑直接改 innerHTML。 */ const root=document.querySelector('.req-workspace');if(root?.dataset.project!==p.id)return;}}):null;
    const previewContent = ordered(data.all).map(({ node, depth }) => documentHtml(node, depth, true)).join("")
      + (data.models && data.models.length ? `<section class="req-entity req-model-entity"><h2>数据库／领域设计模型</h2><p class="req-source">模型是项目级独立分支，与 Vision／Epic／Feature／Story 是关联关系，不是 Story 的第二父项。</p>${data.models.map(m => `<div class="req-model-item"><div class="req-entity-meta"><span>模型</span><span>${esc(m.id)}</span></div><h3>${esc(m.title)}</h3><p class="req-source">项目源文件：${esc(m.relPath)}</p></div>`).join("")}</section>` : "");
    const content = s.mode === "preview" ? previewContent : documentHtml(node);
    const doc = headings(content, "req-" + p.id + "-" + (s.mode === "preview" ? "all" : node.id));
    const chosen = s.mode === "map" ? "map" : s.mode === "preview" ? "preview" : "document";
    const isMap = s.mode === "map";
    const isPreview = s.mode === "preview";
    /* UI-CR066：预览与导图都不再显示左侧需求树——两者是独立阅读方式，各有自己的导航：
       预览用右侧目录，导图用「导图目录」。需求树只在「文档」模式出现。 */
    const showTree = !isMap && !isPreview;
    return `<div class="req-workspace ${s.treeHidden ? "req-tree-hidden" : ""} ${s.tocHidden ? "req-toc-hidden" : ""} ${s.treeOpened ? "req-tree-forced" : ""} ${s.tocOpened ? "req-toc-forced" : ""}" data-project="${esc(p.id)}" data-active="${esc(tab.key)}" data-mode="${s.mode}" data-ui-version="UI-CR066-v1">
      <nav class="req-rail" aria-label="需求工作区">${[["document", "fileText", "文档"], ["preview", "eye", "全文"], ["map", "workflow", "导图"]].map(([mode, ic, label]) => button("req-workspace-mode", icon(ic) + `<span>${label}</span>`, `data-mode="${mode}" aria-label="${mode === "preview" ? "全文预览" : mode === "map" ? "思维导图" : "需求文档"}"`, "rail-btn " + (chosen === mode ? "on" : ""))).join("")}<div class="rail-sep"></div>${showTree ? button("req-workspace-tree", icon("panelLeft") + '<span>需求树</span>', 'aria-label="切换需求树"', "rail-btn") : ""}${isMap ? "" : button("req-workspace-toc", icon("panelRight") + '<span>目录</span>', 'aria-label="切换章节目录"', "rail-btn")}</nav>
      ${isMap ? `<aside class="req-tree-pane req-map-outline-pane" data-pane="requirements-tree" data-default="280" data-min="200" data-max="480"><div class="req-tree-head"><b>导图目录</b></div><div class="req-tree-scroll req-map-outline" role="tree" aria-label="思维导图目录">${window.RequirementsMindmap.outlineHtml(p, s, data)}</div><div class="req-tree-foot">目录与画布同源<br>点击条目定位并选中节点</div></aside>` : showTree ? `<aside class="req-tree-pane" data-pane="requirements-tree" data-default="320" data-min="200" data-max="480"><div class="req-tree-head"><b>需求文档</b>${button("req-new", icon("plus", "ico-14"), 'data-kind="epic" data-parent="" aria-label="新增Epic"', "icon-btn")}</div><label class="req-search">${icon("search", "ico-14")}<input class="input" id="req-workspace-search" placeholder="搜索编号、标题" value="${esc(s.query)}"></label><div class="req-tree-scroll" role="tree">${treeRows(p, s, data.all)}</div><div class="req-tree-foot">${data.all.length} 个同源实体 · 合成<br>搜索与折叠不影响全文预览</div></aside>` : ""}
      <section class="req-document-pane" data-pane="requirements-main" data-min="320"><div class="req-tabs" role="tablist" aria-label="内部需求文档Tab">${s.tabs.map(t => { const r = data.all.find(n => key(p, n) === t.key); return `<div class="req-tab ${s.active === t.key ? "on" : ""}"><button role="tab" aria-selected="${s.active === t.key}" data-act="req-workspace-tab" data-key="${esc(t.key)}" title="${esc(r.title)}"><em class="req-tab-key">${esc(r.kind === "vision" ? "Vision" : r.id)}</em><span class="req-tab-title">${esc(r.title)}</span></button>${button("req-workspace-close", icon("x", "ico-14"), `data-key="${esc(t.key)}" aria-label="关闭${esc(r.title)}"`, "req-tab-close")}</div>`; }).join("")}</div>
      <div class="req-toolbar">${isMap ? `<span class="caption">思维导图：Vision → Epic → Feature → Story</span>` : isPreview ? `<span class="caption">全项目需求全文</span>` : ""}<span class="spacer"></span>${node.kind === "vision" ? '<span class="caption">情景/源愿景阅读</span>' : button("req-edit", icon("edit", "ico-14") + "元信息", `data-id="${esc(node.id)}"`)}${node.kind !== "vision" ? button("req-dispatch", icon("play", "ico-14") + "派发预检", `data-id="${esc(node.id)}"`) : ""}</div>
      ${isMap ? mapHtml(p, s, data) : `<article class="req-reader doc-body" aria-label="${isPreview ? "全部需求全文" : "当前需求详情"}">${isPreview ? `<header class="req-preview-intro"><h1>全项目需求 · 全文预览</h1><p>${data.all.length} 个实体，含全部AC与字段；不按派发资格过滤。D为合成夹具，非真实源文件全文读取。</p></header>` : ""}${s.mode==="document"&&editableBody?editableBody:doc.body}</article>`}</section>
      ${isMap ? "" : `<aside class="req-toc-pane" data-pane="requirements-toc" data-default="240" data-min="160" data-max="360"><div class="req-toc-head"><b>${isPreview ? "全文目录" : "本页目录"}</b><span>${isPreview ? data.all.length : doc.toc.length}</span></div><div class="req-toc-list">${isPreview ? previewTocHtml(s, data) : tocHtml(s, doc)}</div><div class="req-tree-foot">${isPreview ? "Vision → Epic → Feature → Story 四级" : "目录可折叠子章节"}<br>点击定位到对应位置</div></aside>`}
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
  actions["req-toc-fold"] = el => {
    capture(); const s = activeState(); const set = s.tocCollapsed || (s.tocCollapsed = new Set());
    /* 预览目录按实体 id 折叠；文档目录按标题序号折叠。 */
    const key = el.dataset.id ?? Number(el.dataset.index);
    set.has(key) ? set.delete(key) : set.add(key);
    UI.render();
  };
  /* 预览目录跳到对应实体段落。 */
  actions["req-toc-goto"] = el => {
    capture();
    const root = document.querySelector(".req-workspace"), reader = root?.querySelector(".req-reader");
    if (!reader) return;
    const target = reader.querySelector(`[data-entity-id="${CSS.escape(el.dataset.id)}"]`);
    const node = target?.querySelector("h1,h2,h3,h4,h5");
    if (target && node) { reader.scrollTop += node.getBoundingClientRect().top - reader.getBoundingClientRect().top - 16; capture(); }
  };
  actions["req-map-zoom"] = el => { capture(); const s = activeState(); s.mapZoom = Math.max(0.5, Math.min(1.8, Math.round((s.mapZoom + Number(el.dataset.delta)) * 10) / 10)); UI.render(); };
  actions["req-map-reset"] = () => { capture(); const s = activeState(); s.mapZoom = 1; s.mapScroll = [0, 0]; UI.render(); };
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
  window.RequirementsWorkspace = Object.freeze({
    version: "UI-CR066-v1", afterRender, capture, openNode, safeMarkdown,
    getState: project => state(project),
    /* UI-CR066：思维导图目录与画布共用同一份实体集合，避免两套关系来源。 */
    inventoryById: projectId => {
      const p = D.projects.find(item => item.id === projectId);
      return p ? inventory(p) : null;
    }
  });
  UI.render();
})();
