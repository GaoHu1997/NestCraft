/* CR-038 v1 · kind=work 专属可操作设计。全部数据驻内存，不接模型、目录或 Office 引擎。 */
window.Office = (function () {
  "use strict";
  const U = window.UI, { esc, icon } = U;
  const model = window.OfficeModel.create(U.D.projects, U.D.office);
  const views = new Map();
  let pendingClose = null, resize = null, lastProject = null;
  const scenarioNames = { normal: "正常", "import-failed": "导入失败", "save-failed": "保存失败", "version-conflict": "版本冲突", "model-unavailable": "模型不可用", "no-permission": "源无权限", "scanned-pdf": "扫描 PDF" };
  const saveNames = { saved: "已保存", dirty: "未保存草稿", saving: "保存中", failed: "保存失败 · 草稿保留", conflict: "版本冲突 · 草稿保留" };
  const actionNames = { read: "解读资料", word: "生成 Word", ppt: "生成 PPT", polish: "润色所选内容", sheet: "分析选中表格" };
  const btn = (act, text, attrs, cls) => `<button type="button" class="btn ${cls || "sm"}" data-act="office-${act}" ${attrs || ""}>${text}</button>`;
  const attr = (name, value) => `data-${name}="${esc(value)}"`;
  const field = (id, label, control, help) => `<div class="office-field"><label for="${id}">${label}</label>${control}${help ? `<small>${help}</small>` : ""}</div>`;
  const input = (id, value, extra) => `<input class="input" id="${id}" value="${esc(value || "")}" ${extra || ""}>`;
  const textarea = (id, value, extra) => `<textarea class="textarea" id="${id}" ${extra || ""}>${esc(value || "")}</textarea>`;
  const activeId = () => { const w = U.activeWindow(); return w.kind === "project" && U.D.projects.find(p => p.id === w.refId)?.kind === "work" ? w.refId : null; };
  function view(pid) {
    if (!views.has(pid)) { const p = model.getProject(pid); views.set(pid, { tab: "documents", query: "", aiOpen: true, aiWidth: 372, mobile: "document", openFiles: p.selectedId ? [p.selectedId] : [], editing: {}, locations: {}, notice: "", aiError: "", aiInput: "", history: false,
      treeSelectedId: p.selectedId, collapsedFolders: p.folders.filter(f => f.name === "历史资料").map(f => f.id), form: null, importForm: null, folderForm: null, saveTokens: {}, exportResult: null, exportInput: null }); }
    return views.get(pid);
  }
  const pstate = pid => model.getProject(pid);
  function rerender() { U.render(); }
  function notice(pid, result) { view(pid).notice = result.ok ? result.message || "" : result.message; return result; }
  function locationName(loc) {
    if (!loc || loc.kind === "document") return "全文";
    if (loc.kind === "page") return "第 " + (loc.index + 1) + " 页";
    if (loc.kind === "cell") return "工作表 " + (loc.sheet + 1) + " · " + String.fromCharCode(65 + loc.col) + (loc.row + 1);
    return "第 " + (loc.index + 1) + " 段";
  }
  function openFile(pid, fid, loc) {
    const r = model.select(pid, fid, loc || view(pid).locations[fid]); if (!r.ok) return notice(pid, r);
    const v = view(pid); if (!v.openFiles.includes(fid)) v.openFiles.push(fid);
    if (loc) v.locations[fid] = loc;
    v.treeSelectedId = fid; let parent = model.getFile(pid, fid)?.folderId; while (parent) { v.collapsedFolders = v.collapsedFolders.filter(x => x !== parent); parent = pstate(pid).folders.find(x => x.id === parent)?.parentId; } v.mobile = "document"; v.tab = "documents"; rerender();
    if (loc?.kind === "paragraph") document.getElementById("office-paragraph-" + loc.index)?.scrollIntoView({ block: "center" });
    return r;
  }
  function isOpen(pid) { return view(pid).aiOpen; }
  function setAIOpen(pid, value) { view(pid).aiOpen = Boolean(value); if (window.innerWidth < 960) view(pid).mobile = value ? "ai" : "document"; }
  function sourceLabel(f) { return f.source ? "来源 · 只读" : f.draft != null ? "草稿" : "成果"; }
  function fileList(pid) {
    const p = pstate(pid), v = view(pid), q = v.query.trim().toLowerCase();
    const sorted = items => items.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    const shownFiles = p.files.filter(f => !q || model.filePath(pid, f.id).toLowerCase().includes(q));
    const visibleFolders = new Set();
    const addParents = id => { while (id) { visibleFolders.add(id); id = p.folders.find(f => f.id === id)?.parentId; } };
    shownFiles.forEach(f => addParents(f.folderId));
    p.folders.filter(f => !q || model.folderPath(pid, f.id).toLowerCase().includes(q)).forEach(f => addParents(f.id));
    const folderNode = (f, depth) => {
      const open = q || !v.collapsedFolders.includes(f.id), selected = v.treeSelectedId === f.id;
      return '<li role="treeitem" aria-level="' + depth + '" aria-expanded="' + Boolean(open) + '" aria-selected="' + selected + '"><div class="office-tree-row folder ' + (selected ? 'selected' : '') + '" style="--tree-depth:' + (depth - 1) + '"><button class="office-tree-toggle" data-act="office-folder-toggle" data-id="' + f.id + '" aria-label="' + (open ? '折叠' : '展开') + esc(f.name) + '">' + icon(open ? 'chevronDown' : 'chevronRight', 'ico-14') + '</button><button class="office-tree-label" data-act="office-folder" data-id="' + f.id + '" title="' + esc(model.folderPath(pid, f.id)) + '">' + icon(open ? 'folderOpen' : 'folder', 'ico-14') + '<span>' + esc(f.name) + '</span></button></div>' + (open ? '<ul role="group">' + children(f.id, depth + 1) + '</ul>' : '') + '</li>';
    };
    const fileNode = (f, depth) => '<li role="treeitem" aria-level="' + depth + '" aria-selected="' + (v.treeSelectedId === f.id) + '"><div class="office-tree-row ' + (v.treeSelectedId === f.id ? 'selected' : '') + '" style="--tree-depth:' + (depth - 1) + '"><span class="office-tree-spacer"></span><button class="office-tree-label" data-act="office-file" data-id="' + f.id + '" title="' + esc(model.filePath(pid, f.id)) + '">' + U.fileIcon(f.type) + '<span>' + esc(f.name) + '</span>' + (f.draft != null ? '<i class="office-dirty-dot" aria-label="未保存">●</i>' : f.versions.length ? '<small>v' + f.versions.length + '</small>' : '') + '</button></div></li>';
    const children = (parentId, depth) => sorted(p.folders.filter(f => f.parentId === parentId && visibleFolders.has(f.id))).map(f => folderNode(f, depth)).join('') + sorted(shownFiles.filter(f => (f.folderId || null) === parentId)).map(f => fileNode(f, depth)).join('');
    return '<aside class="office-files" aria-label="项目文件树"><div class="panel-h"><b>文件</b><div class="row"><button class="icon-btn" data-act="office-folder-new" aria-label="新建文件夹" title="新建文件夹">' + icon('folder', 'ico-14') + '</button><button class="icon-btn" data-act="office-new" aria-label="新建文件" title="新建文件">' + icon('plus', 'ico-14') + '</button><button class="icon-btn" data-act="office-import" aria-label="添加资料" title="添加资料">' + icon('upload', 'ico-14') + '</button></div></div><label class="office-search search" for="office-search">' + icon('search', 'ico-14') + '<input id="office-search" aria-label="搜索文件或路径" placeholder="搜索文件或路径" value="' + esc(v.query) + '"></label><div class="office-tree-scroll"><button class="office-root-row ' + (v.treeSelectedId === "root" ? "selected" : "") + '" data-act="office-folder" data-id="" title="项目根目录">' + icon('folderOpen', 'ico-14') + '<b>' + esc(U.D.projects.find(x => x.id === pid)?.name || "项目文件") + '</b></button><ul class="office-file-tree" role="tree" aria-label="办公目录与文件">' + children(null, 1) + '</ul>' + (!shownFiles.length && !visibleFolders.size ? '<p class="office-empty-note">' + (q ? '没有匹配文件或目录' : '目录为空，创建文件夹或添加资料开始') + '</p>' : '') + '</div><div class="office-files-foot"><span>仿真样例 · ' + p.files.length + ' 文件 / ' + p.folders.length + ' 文件夹</span>' + (!p.loaded ? btn('samples', '载入演示样例', '', 'ghost sm') : '') + '</div></aside>';
  }
  function paragraphHtml(text) {
    const match = /^(#{1,3})\s+([^\n]+)([\s\S]*)$/.exec(text);
    if (match) return `<h${match[1].length}>${esc(match[2])}</h${match[1].length}>${match[3] ? `<p>${esc(match[3].trim())}</p>` : ""}`;
    return `<p>${esc(text)}</p>`;
  }
  function editor(pid, file) {
    const v = view(pid), p = pstate(pid), editing = v.editing[file.id] === true && !file.source, content = model.current(file), loc = p.location || v.locations[file.id] || {};
    if (p.scenario === "no-permission" && file.source) return `<div class="office-empty"><h2>无法读取源资料</h2><p>当前演示状态为“源无权限”。原件保留，AI 也不能绕过权限读取。</p>${btn("recover", "恢复正常状态")}</div>`;
    if (file.type === "unsupported") return `<div class="office-empty"><h2>此格式尚不支持预览</h2><p>可能是未支持、损坏或加密的原件。本轮保留导入记录，不会降为纯文本覆盖。</p>${btn("import", "重新添加可读资料")}</div>`;
    if (file.type === "xlsx") {
      const sheetIndex = Math.min(content.sheets.length - 1, Number(loc.sheet) || 0), sheet = content.sheets[sheetIndex], row = Math.min(sheet.cells.length - 1, Number(loc.row) || 0), col = Number(loc.col) || 0;
      const columns = Math.max(3, ...sheet.cells.map(r => r.length));
      return `<div class="office-sheet"><div class="office-formula"><span class="office-cell-name">${String.fromCharCode(65 + col)}${row + 1}</span><label for="office-formula">fx</label>${input("office-formula", sheet.cells[row]?.[col] || "", `${editing ? "" : "readonly"} aria-label="公式条：${String.fromCharCode(65 + col)}${row + 1}"`)}</div>
        <div class="office-sheet-scroll"><table aria-label="${esc(sheet.name)}" class="office-grid"><thead><tr><th></th>${Array.from({ length: columns }, (_, c) => `<th>${String.fromCharCode(65 + c)}</th>`).join("")}</tr></thead><tbody>${sheet.cells.map((cells, r) => `<tr><th>${r + 1}</th>${Array.from({ length: columns }, (_, c) => `<td><button data-act="office-cell" data-sheet="${sheetIndex}" data-row="${r}" data-col="${c}" class="${r === row && c === col ? "selected" : ""}" aria-label="${String.fromCharCode(65 + c)}${r + 1}: ${esc(cells[c] || "空白")}">${esc(model.cellValue(sheet.cells, r, c)) || "&nbsp;"}</button></td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="office-sheet-tabs">${content.sheets.map((s, i) => btn("sheet", esc(s.name), `${attr("index", i)} aria-pressed="${sheetIndex === i}"`, sheetIndex === i ? "sm selected" : "sm")).join("")}</div><p class="office-format-note">${editing ? "在公式条编辑所选单元格；切换文件自动保留草稿。" : "只读查看；创建副本后可编辑。"}仅演示 SUM(A1:A3) 矩形范围求和；不运行宏，不是完整计算引擎。</p></div>`;
    }
    if (file.type === "pptx") {
      const index = Math.max(0, Math.min(content.slides.length - 1, Number(loc.index) || 0)), slide = content.slides[index];
      if (!slide) return '<div class="office-empty"><h2>暂无已接受页面</h2><p>接受候选页后在这里编辑。</p></div>';
      return `<div class="office-presentation"><nav class="office-thumbnails" aria-label="幻灯片缩略图">${content.slides.map((s, i) => `<button data-act="office-page" data-index="${i}" class="office-thumbnail ${i === index ? "selected" : ""}" aria-label="第${i + 1}页 ${esc(s.title)}"><small>${i + 1}</small><b>${esc(s.title)}</b><span>${esc(s.body.slice(0, 48))}</span></button>`).join("")}</nav><div class="office-slide-area"><article class="office-slide office-paper">${editing ? `${field("office-slide-title", "本页标题", input("office-slide-title", slide.title))}${field("office-slide-body", "本页正文", textarea("office-slide-body", slide.body, 'rows="8"'))}` : `<div class="office-slide-kicker">${index + 1} / ${content.slides.length} · 合成演示内容</div><h1>${esc(slide.title)}</h1><p>${esc(slide.body)}</p>`}</article><p class="office-format-note">逐页标题／正文可编辑；不承诺动画、母版或复杂布局保真。</p></div></div>`;
    }
    if (file.type === "pdf") {
      const index = Math.max(0, Math.min(content.pages.length - 1, Number(loc.index) || 0));
      return `<div class="office-pdf"><div class="office-pagination">${btn("page", "上一页", `data-index="${index - 1}" ${index === 0 ? "disabled" : ""}`)}<span>第 ${index + 1} / ${content.pages.length} 页 · 只读</span>${btn("page", "下一页", `data-index="${index + 1}" ${index === content.pages.length - 1 ? "disabled" : ""}`)}</div>
      ${p.scenario === "scanned-pdf" ? `<div class="office-empty"><h2>扫描 PDF：未接入 OCR</h2><p>仅能识别页数元数据，不能提取或编造正文。请换用可复制文字的 PDF。</p>${btn("recover", "恢复文字 PDF 样例")}</div>` : `<article class="office-paper office-pdf-page"><span class="office-paper-meta">只读分页仿真 · 第 ${index + 1} 页</span>${paragraphHtml(content.pages[index])}</article>`}</div>`;
    }
    const parts = model.paragraphs(content);
    if (editing && file.type === "md") return `<div class="office-md-edit">${field("office-md-editor", "Markdown 源文草稿", textarea("office-md-editor", content, 'spellcheck="false" rows="24"'))}<p class="office-format-note">源文与预览使用同一草稿；保存前不会变为成果版本。</p></div>`;
    return `<div class="office-document-scroll"><article class="office-paper ${editing ? "editing" : ""}"><div class="office-paper-meta">${file.type.toUpperCase()} · ${file.source ? "原件只读" : "编辑副本"} · 中文正文</div>${parts.map((part, i) => `<section id="office-paragraph-${i}" class="office-paragraph ${loc.kind === "paragraph" && loc.index === i ? "selected" : ""}">${editing ? `<label class="office-block-label" for="office-block-${i}">第 ${i + 1} 段${/^#/.test(part) ? " · 标题" : ""}</label><textarea id="office-block-${i}" data-office-block="${i}" class="office-prose-edit" rows="${Math.min(10, Math.max(2, part.split("\n").length + 1))}">${esc(part)}</textarea>` : `<button class="office-anchor" data-act="office-paragraph" data-index="${i}" aria-label="选择第 ${i + 1} 段用于 AI">§${i + 1}</button>${paragraphHtml(part)}`}</section>`).join("") || `<p>空白文档。点击编辑开始写作。</p>`}${editing ? btn("add-paragraph", "+ 添加段落") : ""}</article></div>`;
  }
  function documentPane(pid) {
    const p = pstate(pid), v = view(pid), f = p.files.find(x => x.id === p.selectedId);
    if (!f) return `<main class="office-main office-empty"><span class="office-empty-mark">${icon("fileText")}</span><h1>从一份资料开始</h1><p>添加资料供阅读，或新建一份文档。编辑副本与 AI 候选只有保存成功后才进入成果。</p><div class="office-row">${btn("import", "添加资料", "", "primary")}${btn("new", "新建文档")}</div>${!p.loaded ? btn("samples", "载入演示样例", "", "ghost") : ""}<small>样例为明确合成夹具，不读取用户目录。</small></main>`;
    const editable = !["pdf", "unsupported"].includes(f.type), editing = v.editing[f.id] === true;
    const status = saveNames[f.saveState] || "";
    return `<main class="office-main"><div class="office-open-tabs" aria-label="打开的文件">${v.openFiles.filter(id => p.files.some(x => x.id === id)).map(id => { const d = p.files.find(x => x.id === id); return `<div class="office-open-tab ${id === f.id ? "selected" : ""}"><button data-act="office-file" data-id="${id}">${esc(d.name)}${d.draft != null ? " ●" : ""}</button><button data-act="office-close-file" data-id="${id}" aria-label="关闭 ${esc(d.name)}">${icon("x", "ico-14")}</button></div>`; }).join("")}</div>
      <div class="office-editor-toolbar"><span class="office-format ${f.type}">${f.type.toUpperCase()}</span><b class="office-file-title" title="${esc(model.filePath(pid, f.id))}">${esc(f.name)}</b><span class="office-save-status ${f.saveState}" role="status">${esc(status)}</span><span class="spacer"></span>
        ${editable ? f.source ? btn("copy", "创建编辑副本") : `${btn("edit", editing ? "阅读预览" : "编辑")}${btn("save", f.saveState === "failed" || f.saveState === "conflict" ? "重试保存" : "保存", f.draft == null || f.saveState === "saving" ? "disabled" : "", "primary sm")}` : '<span class="caption">只读</span>'}
        ${btn("versions", "版本", f.versions.length ? "" : "disabled")}</div>
      <details class="office-provenance"><summary>${sourceLabel(f)} · 来源与格式边界</summary><p>${esc(f.provenance)}</p><p>该视图是设计仿真；Office 原生解析、复杂格式往返与写入均未实现。</p></details>
      ${f.error ? `<div class="office-error" role="alert">${esc(f.error)} ${btn("recover", "恢复正常状态")}${btn("copy", "保留两份")}</div>` : ""}
      ${editor(pid, f)}
      <div class="office-document-foot"><span>当前引用：${esc(locationName(p.location))}</span>${btn("ai-form", "解读", 'data-kind="read"', "ghost sm")}${btn("ai-form", "生成 Word", 'data-kind="word"', "ghost sm")}${btn("ai-form", "生成 PPT", 'data-kind="ppt"', "ghost sm")}${btn("export", "导出检查", "", "ghost sm")}</div></main>`;
  }
  function resultsPane(pid) {
    const p = pstate(pid), files = p.files.filter(f => f.versions.length);
    return `<main class="office-main office-results"><div class="office-results-head"><h1>项目成果</h1><p>同一文件的已保存版本。接受 AI 建议只入草稿，不会自动出现在这里。</p></div>${files.length ? `<div class="office-result-list">${files.map(f => `<article class="office-result"><span class="office-format ${f.type}">${f.type.toUpperCase()}</span><div><h2>${esc(f.name)}</h2><p>v${f.versions.length} · ${esc(f.updated)} · ${f.citations.length} 个来源 · 待人工核对${f.draft != null ? " · 有未保存草稿" : ""}</p></div><div class="office-row">${btn("file", "打开", attr("id", f.id))}${btn("versions", "版本", attr("id", f.id))}${btn("export", "导出检查", attr("id", f.id))}</div></article>`).join("")}</div>` : `<div class="office-empty"><h2>还没有已保存成果</h2><p>先编辑或审阅候选，再点击保存。全部拒绝的 AI 候选不会产生新成果。</p>${btn("tab", "回到文档", 'data-tab="documents"', "primary")}</div>`}</main>`;
  }
  function renderPage(project) {
    const pid = project.id, v = view(pid), p = pstate(pid);
    lastProject = pid;
    return `<div class="page ws-page office-page" data-project="${esc(pid)}" data-mobile="${v.mobile}"><div class="ws-tabs" role="tablist" aria-label="办公项目页签">
      <button class="ws-tab" role="tab" aria-selected="${v.tab === "documents"}" data-act="office-tab" data-tab="documents">文档</button><button class="ws-tab" role="tab" aria-selected="${v.tab === "results"}" data-act="office-tab" data-tab="results">成果<span class="n">${p.files.filter(f => f.versions.length).length}</span></button><span class="spacer"></span>
      <button class="icon-btn ai-toggle-btn ${v.aiOpen ? "on" : ""}" data-act="office-ai-toggle" aria-label="${v.aiOpen ? "收起" : "展开"}项目 AI" title="项目内 AI">${icon("panelRight")}</button></div>
      <div class="office-session-note"><span title="合成业务情景；未读取真实文件、未调用模型，刷新会丢失内存修改">DEMO · 合成仿真样例</span><details class="office-scenario-menu"><summary>演示状态</summary><label for="office-scenario">选择场景<select id="office-scenario" aria-label="演示状态">${Object.entries(scenarioNames).map(([key, label]) => `<option value="${key}" ${p.scenario === key ? "selected" : ""}>${label}</option>`).join("")}</select></label></details></div>
      <nav class="office-mobile-nav" aria-label="办公主区切换">${[["files", "文件"], ["document", "正文"], ["ai", "AI"]].map(([key, label]) => btn("mobile", label, `data-pane="${key}" aria-pressed="${v.mobile === key}"`, v.mobile === key ? "sm selected" : "sm")).join("")}</nav>
      ${v.notice ? `<div class="office-notice" role="status">${esc(v.notice)}${btn("notice-close", "知道了", "", "ghost sm")}</div>` : ""}
      <div class="office-layout">${fileList(pid)}${v.tab === "results" ? resultsPane(pid) : documentPane(pid)}</div></div>`;
  }
  function citeButton(c) { return `<button class="office-citation" data-act="office-citation" data-id="${esc(c.fileId)}" data-location="${esc(JSON.stringify(c.location))}" data-revision="${esc(c.revision)}" data-fingerprint="${esc(c.fingerprint)}">${icon("link", "ico-14")}${esc(c.name)} · ${esc(locationName(c.location))}</button>`; }
  function renderActivity(pid) {
    const p = pstate(pid), v = view(pid), r = p.run, proposal = p.proposal;
    const readResult = r?.result;
    return `<div class="office-activity" data-project="${esc(pid)}">
      ${!r ? "" : `<section class="office-run" aria-live="polite"><p class="office-run-request"><b>${esc(actionNames[r.input.action])}</b><br>${esc(r.input.purpose)} · 面向${esc(r.input.audience)}</p><ol class="office-run-steps">${["读取资料", "生成草稿", "检查结果"].map((label, i) => `<li class="${r.step > i ? "done" : r.step === i && r.status === "running" ? "active" : ""}">${r.step > i ? "✓" : i + 1} ${label}</li>`).join("")}</ol>
        <p class="office-run-state">${r.status === "running" ? "执行中（有界仿真）" : r.status === "failed" ? "执行失败" : r.status === "stopped" ? "已停止 · 未写入结果" : "已完成仿真检查 · 待人工审阅"}</p>
        ${r.error ? `<div class="office-error" role="alert">${esc(r.error)}${btn("settings", "模型设置")}${btn("recover", "恢复正常状态")}</div>` : ""}
        <details class="office-run-details" ${r.status === "running" ? "open" : ""}><summary>执行详情 · 仿真推进</summary><p>为便于设计验证，每次只推进一个阶段；不调用真实模型，不运行研发流程。</p>${r.log.map(line => `<p>${esc(line)}</p>`).join("")}${r.status === "running" ? `<div class="office-row">${btn("run-next", "演示：推进下一步", "", "primary sm")}${btn("run-stop", "停止")}</div>` : ["failed", "stopped"].includes(r.status) ? btn("run-retry", "原输入重试（重新确认）") : ""}</details></section>`}
      ${readResult ? `<section class="office-answer"><h3>资料解读</h3><p>${esc(readResult.summary)}</p>${readResult.excerpts.map(x => `<blockquote>${esc(x.text)}</blockquote>${citeButton(x.citation)}`).join("")}<p class="office-caveat">${esc(readResult.caveat)}</p></section>` : ""}
      ${proposal ? `<section class="office-proposal"><div class="office-row"><h3>候选修改</h3><span class="tag blue">只入草稿</span></div><p>${esc(proposal.name)}</p>${proposal.items.some(i => i.decision === "pending") && !model.isProposalFresh(pid) ? `<div class="office-error">编辑基线已变化，旧提案禁止写入。${btn("recompare", "重新比较")}${btn("regenerate", "重新生成")}</div>` : ""}
        ${proposal.items.map(item => `<article class="office-diff" data-item="${item.id}"><header><b>${proposal.type === "pptx" ? "第 " + (item.index + 1) + " 页" : "修改 " + (item.index + 1)}</b><span>${item.decision === "accepted" ? "已接受 → 草稿" : item.decision === "rejected" ? "已拒绝" : "待决定"}</span></header><div class="office-before"><small>原内容</small><p>${esc(typeof item.before === "object" ? item.before.title + "\n" + item.before.body : item.before || "新内容（原文件不变）")}</p></div><div class="office-after"><small>建议内容</small><p>${esc(typeof item.after === "object" ? item.after.title + "\n" + item.after.body : item.after)}</p></div>${item.decision === "pending" ? `<div class="office-row">${btn("accept", "接受此项", attr("item", item.id), "primary sm")}${btn("reject", "拒绝此项", attr("item", item.id))}</div>` : ""}</article>`).join("")}
        <div class="office-citations"><b>结果来源</b>${proposal.citations.map(citeButton).join("")}</div>
        ${proposal.items.some(i => i.decision === "pending") ? btn("reject-all", "拒绝其余建议", "", "ghost sm") : '<p class="office-caveat">审阅已结束。接受项还需保存；全拒绝不会新增成果。</p>'}${btn("regenerate", "重新生成", "", "ghost sm")}</section>` : ""}
      ${v.aiError ? `<div class="office-error" role="alert">${esc(v.aiError)}</div>` : ""}</div>
      `;
  }
  function dialog(title, subtitle, body, footer, cls) {
    U.openDialog(`<div class="dlg-h"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-btn" data-act="office-dialog-close" aria-label="关闭弹窗">${icon("x")}</button></div><div class="dlg-b office-dialog-body">${body}<p id="office-form-error" class="office-error" role="alert" hidden></p></div><div class="dlg-f">${footer}</div>`, "office-dialog " + (cls || "modal-md"));
  }
  function formError(result, focusId) { const e = document.getElementById("office-form-error"); if (e) { e.hidden = false; e.textContent = result.message; } if (focusId) document.getElementById(focusId)?.focus(); }
  function folderDialog(pid) {
    const parentId = pstate(pid).selectedFolderId;
    view(pid).folderForm = { parentId, name: "" };
    dialog("新建文件夹", "只在当前项目的设计样例中创建，不修改磁盘。", '<div class="office-form"><p class="caption">父目录：' + esc(model.folderPath(pid, parentId) || '项目根目录') + '</p>' + field('office-folder-name', '文件夹名称', input('office-folder-name', '', 'placeholder="例如：12月汇报" maxlength="100" autofocus')) + '</div>', btn('dialog-close', '取消') + btn('folder-submit', '创建文件夹', '', 'primary'), 'modal-sm');
  }
  function importDialog(pid, mode) {
    const v = view(pid); if (!v.importForm || v.importForm.mode !== mode) v.importForm = { mode, name: "", type: "md", content: "", folderId: pstate(pid).selectedFolderId };
    const f = v.importForm;
    dialog(mode === "import" ? "添加资料" : "新建文档", mode === "import" ? "命名／格式／内容表单仿真，不读取真实用户目录。" : "新建到当前项目草稿，保存后成为成果。",
      `<div class="office-form"><p class="caption">目标目录：${esc(model.folderPath(pid, f.folderId) || "项目根目录")}</p>${field("office-import-name", "文件名称", input("office-import-name", f.name, 'placeholder="例如：项目简报.docx" maxlength="100"'))}${field("office-import-type", "文件格式", `<select id="office-import-type" class="select">${model.formats.filter(t => mode === "import" || !["pdf", "unsupported"].includes(t)).map(t => `<option value="${t}" ${f.type === t ? "selected" : ""}>${t === "unsupported" ? "未支持／损坏／加密格式" : t.toUpperCase()}</option>`).join("")}</select>`)}${field("office-import-content", "初始内容（仿真）", textarea("office-import-content", f.content, 'rows="7"'), "表格用 Tab 分列、换行分行；PPT 每页首行为标题，用单独一行 --- 分页；PDF 同样用 --- 分页。DOCX 输入标题和段落。")}</div>`, `${btn("dialog-close", "取消")}${btn("import-submit", mode === "import" ? "确认添加" : "创建草稿", "", "primary")}`);
  }
  function defaultForm(pid, action) {
    const p = pstate(pid), v = view(pid), f = p.files.find(x => x.id === p.selectedId);
    return { action, title: action === "ppt" ? "项目汇报" : "资料简报", purpose: U.store.aiInput || "整理资料并形成可审阅的汇报", audience: "项目评审会", pages: 3, model: "cloud", consent: false, targetId: f?.id || null,
      refs: f ? [{ fileId: f.id, location: p.location || { kind: "document" } }] : [] };
  }
  function aiDialog(pid, action, initial) {
    const v = view(pid), p = pstate(pid);
    if (initial) v.form = structuredClone(initial);
    else if (!v.form || v.form.action !== action) v.form = defaultForm(pid, action);
    const f = v.form; f.consent = false;
    dialog(actionNames[f.action] || "AI 协作", "仅当前办公项目 · 先选择来源，明确范围与用途。",
      `<div class="office-form">${field("office-ai-purpose", "用途", input("office-ai-purpose", f.purpose))}${field("office-ai-audience", "受众", input("office-ai-audience", f.audience))}${["word", "ppt", "polish"].includes(f.action) ? field("office-ai-title", "成果标题", input("office-ai-title", f.title)) : ""}${f.action === "ppt" ? field("office-ai-pages", "页数（2–8 页）", input("office-ai-pages", f.pages, 'type="number" min="2" max="8"')) : ""}
      <fieldset class="office-sources"><legend>资料来源（仅 ${esc(pid)}）</legend>${p.files.map(doc => { const ref = f.refs.find(x => x.fileId === doc.id); return `<label><input type="checkbox" data-office-ref="${doc.id}" ${ref ? "checked" : ""}><span><b>${esc(doc.name)}</b><small>${ref ? esc(locationName(ref.location)) : "全文"} · ${sourceLabel(doc)}</small></span></label>`; }).join("") || '<p>当前项目没有资料。先添加或创建文档。</p>'}</fieldset>
      ${field("office-ai-model", "执行模型", `<select class="select" id="office-ai-model"><option value="cloud" ${f.model === "cloud" ? "selected" : ""}>云模型（仅模拟发送）</option><option value="local" ${f.model === "local" ? "selected" : ""}>本地模型（仅模拟执行）</option></select>`)}
      <div class="office-consent"><p><b>本地保存 ≠ 模型不联网</b><br>正式云模型将收到上面勾选的文件／片段。此设计稿不会真实发送；变更范围需重新确认。</p><label><input type="checkbox" id="office-ai-consent">我同意将上述勾选资料范围发送给所选云模型（仿真确认）</label></div></div>`, `${btn("dialog-close", "取消")}${btn("ai-start", "确认并执行（仿真）", "", "primary")}`);
  }
  function saveFile(pid, fid, done) {
    const start = model.beginSave(pid, fid); if (!start.ok) { notice(pid, start); rerender(); return start; }
    view(pid).saveTokens[fid] = start.token; rerender();
    // 有界微任务：一次“保存”完成，不让日常操作额外确认；无定时器。
    queueMicrotask(() => { const result = model.finishSave(pid, fid, start.token); delete view(pid).saveTokens[fid]; if (result.ok) view(pid).notice = "已保存到本会话成果 v" + result.version + "。刷新仍会丢失，不是真实磁盘写入。"; else notice(pid, result); if (done) done(result); rerender(); });
    return start;
  }
  function versionsDialog(pid, fid) {
    const f = model.getFile(pid, fid); if (!f) return;
    dialog("成果版本", f.name + " · 恢复只生成新草稿，不改写历史。", `<div class="office-version-list">${f.versions.slice().reverse().map(ver => `<article><div class="office-row"><h3>v${ver.number}</h3><span>${esc(ver.savedAt)}</span><span>${esc(ver.check)}</span></div><details><summary>查看此版本内容</summary><pre>${esc(typeof ver.content === "string" ? ver.content : JSON.stringify(ver.content, null, 2))}</pre></details>${btn("restore", "恢复为新草稿", `${attr("id", fid)} ${attr("version", ver.id)}`)}</article>`).join("") || '<p>尚无已保存成果版本。</p>'}</div>`, btn("dialog-close", "关闭"));
  }
  function exportDialog(pid, fid) {
    const f = model.getFile(pid, fid); if (!f) return;
    const v = view(pid); v.exportInput = { fileId: fid, name: f.name, format: f.type, location: "演示导出目录", useSaved: false }; v.exportResult = null;
    dialog("导出前检查", "本轮仅演示状态检查；未接入导出引擎。", `<div class="office-form">${field("office-export-name", "导出文件名", input("office-export-name", f.name))}${field("office-export-format", "目标格式", `<select id="office-export-format" class="select">${model.formats.filter(x => x !== "unsupported").map(t => `<option ${t === f.type ? "selected" : ""} value="${t}">${t.toUpperCase()}</option>`).join("")}</select>`)}${field("office-export-location", "保存位置（仅命名仿真）", input("office-export-location", "演示导出目录"))}<p>当前已保存版本：${f.versions.length ? "v" + f.versions.length : "无"}</p><label class="office-check-label"><input type="checkbox" id="office-export-saved">明确使用已保存版本，不包含未保存草稿</label></div><div id="office-export-result"></div>`, `${btn("dialog-close", "关闭")}${btn("export-check", "运行导出检查", "", "primary")}${btn("download", "下载不可用", 'disabled title="未接入导出引擎"')}`);
  }
  function showExportResult(pid) {
    const v = view(pid), result = model.exportCheck(pid, v.exportInput.fileId, v.exportInput); v.exportResult = result;
    document.getElementById("office-export-result").innerHTML = `<div class="office-export-checks">${result.checks.map(c => `<p class="${c.ok ? "pass" : "warn"}"><b>${c.ok ? "✓" : "!"} ${esc(c.label)}</b><span>${esc(c.detail)}</span></p>`).join("")}</div><p>同名默认不覆盖。建议名称：<b>${esc(result.suggestion)}</b> ${btn("export-suggestion", "采用建议名称")}</p><p class="office-caveat">未接入导出引擎，没有生成或下载任何文件。修改条件后可重新检查。</p>`;
  }
  function guardClose(pid, finish, fid) {
    const dirty = fid ? model.getFile(pid, fid)?.draft != null ? [fid] : [] : model.dirtyFiles(pid);
    if (!dirty.length) { if (!fid) model.stopRun(pid); finish(); return true; }
    pendingClose = { pid, finish, files: dirty, fid };
    dialog("有未保存的编辑", "这些草稿仅在本会话内存中，关闭前请选择。", `<p>${dirty.map(id => esc(model.getFile(pid, id).name)).join("、")}</p><p>保存成功后再关闭；保存失败时保留草稿与窗口。</p>`, `${btn("dialog-close", "继续编辑")}${btn("close-discard", "不保存并关闭")}${btn("close-save", "保存并关闭", "", "primary")}`);
    return false;
  }
  function beforeClose(windowId) {
    const w = U.store.windows.find(x => x.id === windowId); if (!w || U.D.projects.find(p => p.id === w.refId)?.kind !== "work") return true;
    if (!model.dirtyFiles(w.refId).length) { model.stopRun(w.refId); return true; }
    guardClose(w.refId, () => U.closeWindow(windowId, true)); return false;
  }
  const actions = {
    "folder-new"(pid) { folderDialog(pid); },
    "folder-submit"(pid) { const form = view(pid).folderForm; const r = model.createFolder(pid, document.getElementById('office-folder-name').value, form.parentId); if (!r.ok) { formError(r, 'office-folder-name'); return; } const v = view(pid); v.collapsedFolders = v.collapsedFolders.filter(id => id !== form.parentId); v.treeSelectedId = r.folderId; U.closeDialog(); rerender(); },
    "folder-toggle"(pid, el) { const v = view(pid), id = el.dataset.id; v.collapsedFolders = v.collapsedFolders.includes(id) ? v.collapsedFolders.filter(x => x !== id) : v.collapsedFolders.concat(id); rerender(); },
    folder(pid, el) { const id = el.dataset.id || null; model.selectFolder(pid, id); view(pid).treeSelectedId = id || 'root'; rerender(); },
    tab(pid, el) { view(pid).tab = el.dataset.tab; view(pid).mobile = "document"; rerender(); },
    file(pid, el) { openFile(pid, el.dataset.id); },
    mobile(pid, el) { const v = view(pid); v.mobile = el.dataset.pane; if (v.mobile === "ai") v.aiOpen = true; rerender(); },
    "ai-toggle"(pid) { const v = view(pid); v.aiOpen = !v.aiOpen; if (window.innerWidth < 960) v.mobile = v.aiOpen ? "ai" : "document"; rerender(); },
    "notice-close"(pid) { view(pid).notice = ""; rerender(); },
    import(pid) { importDialog(pid, "import"); }, new(pid) { view(pid).importForm = null; importDialog(pid, "new"); },
    "import-submit"(pid) { const f = view(pid).importForm, r = f.mode === "import" ? model.importDocument(pid, f) : model.createDocument(pid, f); if (!r.ok) { formError(r, "office-import-name"); return; } U.closeDialog(); view(pid).importForm = null; if (f.mode === "new") view(pid).editing[r.fileId] = true; openFile(pid, r.fileId); },
    samples(pid) { notice(pid, model.loadSamples(pid)); const p = pstate(pid); if (p.selectedId) openFile(pid, p.selectedId); else rerender(); },
    copy(pid) { const p = pstate(pid), r = model.copyDocument(pid, p.selectedId); if (!r.ok) { notice(pid, r); rerender(); return; } view(pid).editing[r.fileId] = true; openFile(pid, r.fileId); },
    edit(pid) { const p = pstate(pid); view(pid).editing[p.selectedId] = !view(pid).editing[p.selectedId]; rerender(); },
    save(pid) { saveFile(pid, pstate(pid).selectedId); },
    "save-finish"(pid) { const id = pstate(pid).selectedId, token = view(pid).saveTokens[id]; if (token) notice(pid, model.finishSave(pid, id, token)); rerender(); },
    recover(pid) { model.setScenario(pid, "normal"); view(pid).notice = "演示状态已恢复正常；原草稿和候选仍保留，可重试。"; rerender(); },
    paragraph(pid, el) { const p = pstate(pid); openFile(pid, p.selectedId, { kind: "paragraph", index: Number(el.dataset.index) }); },
    page(pid, el) { const p = pstate(pid); openFile(pid, p.selectedId, { kind: "page", index: Number(el.dataset.index) }); },
    sheet(pid, el) { const p = pstate(pid); openFile(pid, p.selectedId, { kind: "cell", sheet: Number(el.dataset.index), row: 0, col: 0 }); },
    cell(pid, el) { const p = pstate(pid); openFile(pid, p.selectedId, { kind: "cell", sheet: Number(el.dataset.sheet), row: Number(el.dataset.row), col: Number(el.dataset.col) }); document.getElementById("office-formula")?.focus(); },
    "add-paragraph"(pid) { const p = pstate(pid), f = model.getFile(pid, p.selectedId); model.edit(pid, f.id, model.current(f) + "\n\n新段落"); rerender(); },
    "ai-form"(pid, el) { view(pid).aiOpen = true; aiDialog(pid, el.dataset.kind || "read"); },
    "ai-start"(pid) { const v = view(pid); const r = model.startRun(pid, v.form); if (!r.ok) { formError(r, r.code === "CONSENT" ? "office-ai-consent" : "office-ai-purpose"); return; } v.aiError = ""; U.closeDialog(); v.aiOpen = true; if (window.innerWidth < 960) v.mobile = "ai"; rerender(); },
    "run-next"(pid) { const r = model.advanceRun(pid, pstate(pid).run?.id); view(pid).aiError = r.ok ? "" : r.message; rerender(); },
    "run-stop"(pid) { model.stopRun(pid); rerender(); },
    "run-retry"(pid) { const r = model.retryRun(pid); if (r.ok) aiDialog(pid, r.input.action, r.input); else { view(pid).aiError = r.message; rerender(); } },
    accept(pid, el) { const p = pstate(pid), r = model.decide(pid, p.proposal?.id, el.dataset.item, "accepted"); view(pid).aiError = r.ok ? "" : r.message; if (r.ok) { const v = view(pid); if (!v.openFiles.includes(r.fileId)) v.openFiles.push(r.fileId); v.treeSelectedId = r.fileId; v.editing[r.fileId] = false; } rerender(); },
    reject(pid, el) { const p = pstate(pid); model.decide(pid, p.proposal?.id, el.dataset.item, "rejected"); rerender(); },
    "reject-all"(pid) { model.rejectRemaining(pid); rerender(); },
    recompare(pid) { const r = model.recompare(pid); view(pid).aiError = r.ok ? "已重新比较，保留人工内容；请重新审阅新的差异。" : r.message; rerender(); },
    regenerate(pid) { const p = pstate(pid); model.rejectRemaining(pid); const input = p.run?.input || defaultForm(pid, "word"); aiDialog(pid, input.action, input); },
    citation(pid, el) { const loc = JSON.parse(el.dataset.location); const r = model.readReference(pid, { fileId: el.dataset.id, location: loc, revision: el.dataset.revision ? Number(el.dataset.revision) : undefined, fingerprint: el.dataset.fingerprint || undefined }); if (!r.ok) { view(pid).aiError = r.message; rerender(); return; } openFile(pid, el.dataset.id, loc); },
    history(pid) { view(pid).history = !view(pid).history; rerender(); },
    versions(pid, el) { versionsDialog(pid, el.dataset.id || pstate(pid).selectedId); },
    restore(pid, el) { const fid = el.dataset.id, version = el.dataset.version; const restore = () => { const r = model.restoreVersion(pid, fid, version); if (!r.ok) { formError(r); return; } U.closeDialog(); view(pid).editing[fid] = true; openFile(pid, fid); }; if (model.getFile(pid, fid).draft != null) { pendingClose = { pid, restore }; dialog("替换当前草稿？", "历史版本保持不变，但当前未保存草稿将被所选版本替换。", '<p>若需要保留当前编辑，请先取消并保存或创建副本。</p>', `${btn("dialog-close", "取消")}${btn("restore-confirm", "确认恢复为新草稿", "", "primary")}`); } else restore(); },
    "restore-confirm"() { pendingClose?.restore?.(); pendingClose = null; },
    export(pid, el) { exportDialog(pid, el.dataset.id || pstate(pid).selectedId); },
    "export-check"(pid) { showExportResult(pid); },
    "export-suggestion"(pid) { const v = view(pid); v.exportInput.name = v.exportResult.suggestion; document.getElementById("office-export-name").value = v.exportInput.name; showExportResult(pid); },
    "dialog-close"() { U.closeDialog(); pendingClose = null; },
    "close-file"(pid, el) { const fid = el.dataset.id; guardClose(pid, () => { const v = view(pid); v.openFiles = v.openFiles.filter(x => x !== fid); const next = v.openFiles[v.openFiles.length - 1]; if (next) model.select(pid, next); U.closeDialog(); rerender(); }, fid); },
    "close-save"() { const c = pendingClose; if (!c) return; for (const fid of c.files) { const r = model.save(c.pid, fid); if (!r.ok) { formError(r); rerender(); return; } } pendingClose = null; U.closeDialog(); c.finish(); },
    "close-discard"() { const c = pendingClose; if (!c) return; if (c.fid) model.discardFileDraft(c.pid, c.fid); else model.discardDrafts(c.pid); pendingClose = null; U.closeDialog(); c.finish(); },
    settings() { U.closeDialog(); window.Screens.openSettings("models"); },
    resize() {}
  };
  function updateEditor(pid, el) {
    const p = pstate(pid), f = model.getFile(pid, p.selectedId); if (!f) return;
    let content = model.current(f), changed = false;
    if (el.id === "office-md-editor") { content = el.value; changed = true; }
    else if (el.dataset.officeBlock != null) { content = Array.from(document.querySelectorAll("[data-office-block]")).map(block => block.value).join("\n\n"); changed = true; }
    else if (["office-slide-title", "office-slide-body"].includes(el.id)) { const i = Number(p.location?.index) || 0; content.slides[i][el.id === "office-slide-title" ? "title" : "body"] = el.value; changed = true; }
    else if (el.id === "office-formula" && !el.readOnly) { const loc = p.location || { sheet: 0, row: 0, col: 0 }; content.sheets[loc.sheet || 0].cells[loc.row || 0][loc.col || 0] = el.value; changed = true; }
    if (changed) { const r = model.edit(pid, f.id, content); if (!r.ok) { notice(pid, r); return; } const updated = model.getFile(pid, f.id); const status = document.querySelector(".office-save-status"); if (status) { status.textContent = saveNames[updated.saveState]; status.className = "office-save-status " + updated.saveState; } const save = document.querySelector('[data-act="office-save"]'); if (save) save.disabled = updated.draft == null; }
  }
  document.addEventListener("click", e => {
    const el = e.target.closest('[data-act^="office-"]'); if (!el || el.disabled) return;
    e.stopImmediatePropagation(); const pid = activeId() || lastProject;
    const action = el.dataset.act.slice(7); if (actions[action]) actions[action](pid, el, e);
  }, true);
  document.addEventListener("input", e => {
    const el = e.target, pid = activeId(); if (!pid || !el.closest(".office-page, .office-ai, .office-dialog")) return;
    const v = view(pid);
    // 修正输入后撤下上一条表单错误；再次提交仍重新执行完整校验。
    const error = document.getElementById("office-form-error");
    if (error && el.closest(".office-dialog")) error.hidden = true;
    if (el.id === "office-search") { v.query = el.value; rerender(); }
    else if (el.id === "office-ai-input") v.aiInput = el.value;
    else if (el.id.startsWith("office-import-") && v.importForm) v.importForm[el.id.slice(14)] = el.value;
    else if (el.id.startsWith("office-ai-") && v.form) { const key = el.id.slice(10); v.form[key] = key === "consent" ? el.checked : el.value; if (key !== "consent") { v.form.consent = false; const check = document.getElementById("office-ai-consent"); if (check) check.checked = false; } }
    else if (el.id.startsWith("office-export-") && v.exportInput) v.exportInput[el.id === "office-export-saved" ? "useSaved" : el.id.slice(14)] = el.type === "checkbox" ? el.checked : el.value;
    else updateEditor(pid, el);
  }, true);
  document.addEventListener("change", e => {
    const el = e.target, pid = activeId(); if (!pid) return;
    if (el.id === "office-scenario") { model.setScenario(pid, el.value); rerender(); }
    else if (el.dataset.officeRef && view(pid).form) { const f = view(pid).form; f.refs = f.refs.filter(r => r.fileId !== el.dataset.officeRef); if (el.checked) { const p = pstate(pid); f.refs.push({ fileId: el.dataset.officeRef, location: p.selectedId === el.dataset.officeRef && p.location ? p.location : { kind: "document" } }); } f.consent = false; document.getElementById("office-ai-consent").checked = false; }
    else if (el.id === "office-formula") rerender();
  }, true);
  document.addEventListener("keydown", e => {
    const pid = activeId(); if (!pid) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !document.getElementById("dialog").open) { e.preventDefault(); e.stopImmediatePropagation(); saveFile(pid, pstate(pid).selectedId); }
    if (e.key === "Escape" && !document.getElementById("dialog").open && view(pid).mobile === "ai") { view(pid).mobile = "document"; rerender(); }
    if (e.target.matches('[data-act="office-resize"]') && ["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); view(pid).aiWidth = Math.min(560, Math.max(300, view(pid).aiWidth + (e.key === "ArrowLeft" ? 20 : -20))); rerender(); }
  }, true);
  document.addEventListener("mousedown", e => { if (e.target.closest('[data-act="office-resize"]')) { resize = activeId(); e.preventDefault(); } });
  document.addEventListener("mousemove", e => { if (!resize) return; const v = view(resize); v.aiWidth = Math.min(560, Math.max(300, window.innerWidth - e.clientX)); const panel = document.querySelector(".office-ai"); if (panel) panel.style.width = v.aiWidth + "px"; });
  document.addEventListener("mouseup", () => { resize = null; });
  window.addEventListener("beforeunload", e => { if (Array.from(views.keys()).some(pid => model.dirtyFiles(pid).length)) { e.preventDefault(); e.returnValue = ""; } });
  return { model, renderPage, renderActivity, isOpen, setAIOpen, beforeClose, activeId, getView: pid => structuredClone(view(pid)), openFile, aiDialog, importDialog, saveFile, actions,
    captureSession: pid => ({ model: model.captureConversation(pid), form: structuredClone(view(pid).form), aiError: view(pid).aiError }),
    restoreSession: (pid, snapshot) => { model.restoreConversation(pid, snapshot?.model); view(pid).form = structuredClone(snapshot?.form || null); view(pid).aiError = snapshot?.aiError || ""; },
    render: rerender, onRender: isWork => { document.body.classList.toggle("office-active", isWork); document.body.dataset.officePane = isWork ? view(activeId()).mobile : ""; } };
})();
