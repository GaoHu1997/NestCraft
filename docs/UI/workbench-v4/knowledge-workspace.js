/* CR-045 · 可操作知识工作区设计。只操作 DEMO 内存；不访问文件系统/网络。
 * Load after main.js, before pane-resize.js. Inventories and existing bodies are never reseeded.
 */
(function () {
  "use strict";
  if (!window.UI || !window.__actions || window.KnowledgeWorkspace) return;
  const { D, esc, icon, store, toast } = UI;
  const states = new Map();
  const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
  const allDocs = lib => D.knowledge.docs[lib] || [];
  const getDoc = (lib, id) => allDocs(lib).find(d => d.id === id);
  const asset = "../brand-assets-v2/logo-sail.png";
  let serial = 0;
  function state(id) {
    if (!states.has(id)) states.set(id, {
      drafts: new Map(), current: null, collapsed: new Set(), folderInput: null,
      menu: null, upload: null, confirm: null, notice: "", scroll: new Map(),
      treeOpen: false, tocOpen: false, selectedFolder: "", imageZoom: false
    });
    return states.get(id);
  }
  function currentLib() { return store.kbId; }
  function currentState() { return state(currentLib()); }
  function typeOf(d) { return String(d?.type || String(d?.path || "").split(".").pop() || "unknown").toLowerCase(); }
  function isMD(d) { return ["md", "markdown"].includes(typeOf(d)); }
  function isText(d) { return ["txt", "text", "json", "csv", "log", "yaml", "yml"].includes(typeOf(d)); }
  function isImage(d) { return ["png", "jpeg", "jpg", "gif", "webp"].includes(typeOf(d)); }
  function contentOf(d) { return d && owns(D.knowledge.content, d.id) && typeof D.knowledge.content[d.id] === "string" ? D.knowledge.content[d.id] : null; }
  function parentOf(path) { return String(path || "").split("/").slice(0, -1).join("/"); }
  function join(parent, name) { return parent ? parent + "/" + name : name; }
  function idFor(prefix) {
    let id;
    do { id = prefix + "-CR045-" + (++serial); } while (Object.values(D.knowledge.docs).some(ds => ds.some(d => d.id === id)) || owns(D.knowledge.content, id));
    return id;
  }
  function directories(lib) {
    const result = new Set();
    const add = path => {
      const bits = String(path || "").split("/").filter(Boolean);
      bits.forEach((_, i) => result.add(bits.slice(0, i + 1).join("/")));
    };
    allDocs(lib).forEach(d => add(parentOf(d.path)));
    (D.knowledge.folders?.[lib] || []).forEach(f => add(typeof f === "string" ? f : f.path));
    return result;
  }
  function nameError(name) {
    if (!name.trim()) return "名称不能为空。";
    if (name !== name.trim()) return "名称首尾不能有空白，输入已保留。";
    if (name.length > 120) return "名称不能超过 120 个字符。";
    if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name)) return "不能含路径分隔符、保留符号或末尾点号。";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "这是系统保留名称，请更换。";
    return "";
  }
  function pathTaken(lib, path, except) {
    const key = path.normalize("NFC").toLocaleLowerCase();
    return allDocs(lib).some(d => d.id !== except && String(d.path).normalize("NFC").toLocaleLowerCase() === key) || [...directories(lib)].some(p => p.normalize("NFC").toLocaleLowerCase() === key);
  }
  function markdownName(name) { return /\.(md|markdown)$/i.test(name) ? name : name + ".md"; }
  /* CR-051：文件树图标改用 core 的 14 类扩展名映射（符号 + 类型色令牌）；未知扩展名显示 fileUnknown，不阻止上传。 */
  function fileIcon(d) {
    const t = typeOf(d);
    const fallback = isMD(d) ? "md" : isImage(d) ? "png" : t;
    return UI.fileIcon(fallback, "ico-14");
  }
  const fico = (d, cls) => `<span style="color:${UI.fileMeta(isMD(d) ? "md" : isImage(d) ? "png" : typeOf(d)).c}">${UI.fileIcon(isMD(d) ? "md" : isImage(d) ? "png" : typeOf(d), cls || "ico-14")}</span>`;
  // Safe, deliberately small Markdown viewer: no HTML, external fetch, image load,
  // clickable arbitrary URL, active content, or local path from user input.
  function inline(text) {
    return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function safeMarkdown(text) {
    const rows = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const headings = [], output = []; let code = null, list = false;
    const endList = () => { if (list) { output.push("</ul>"); list = false; } };
    rows.forEach(line => {
      if (/^\s*```/.test(line)) { endList(); if (code) { output.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>"); code = null; } else code = []; return; }
      if (code) { code.push(line); return; }
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) { endList(); const id = "kw-heading-" + headings.length; headings.push({ id, level: h[1].length, title: h[2].replace(/[`*]/g, "") }); output.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`); }
      else if (/^[-*]\s+/.test(line)) { if (!list) { output.push("<ul>"); list = true; } output.push("<li>" + inline(line.replace(/^[-*]\s+/, "")) + "</li>"); }
      else { endList(); if (/^>\s?/.test(line)) output.push("<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>"); else if (line.trim()) output.push("<p>" + inline(line) + "</p>"); }
    });
    endList(); if (code) output.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
    return { html: output.join("\n"), headings };
  }
  function view(lib, st) {
    const draft = st.drafts.get(st.current);
    const doc = getDoc(lib, draft?.docId || st.current);
    return { draft, doc, text: draft ? draft.body : contentOf(doc), mode: draft?.mode || "read" };
  }
  function dirty(draft) { return draft && (draft.isNew || draft.body !== draft.baseBody || draft.title !== draft.baseTitle); }
  function renderAgain(focus) {
    const st = currentState(), article = document.querySelector(".knowledge-workspace .kw-scroll"), tree = document.querySelector(".knowledge-workspace .kb-docs");
    if (article && article.dataset.kwCurrent) st.scroll.set(article.dataset.kwCurrent, article.scrollTop);
    const treeTop = tree?.scrollTop || 0;
    UI.render();
    const body = document.querySelector(".knowledge-workspace .kw-scroll"), nextTree = document.querySelector(".knowledge-workspace .kb-docs");
    if (body) body.scrollTop = st.scroll.get(st.current) || 0;
    if (nextTree) nextTree.scrollTop = treeTop;
    if (focus) { const input = document.getElementById(focus); if (input) { input.focus(); if (input.select && focus === "kw-folder-name") input.select(); } }
  }
  function fileButton(lib, d, st, search) {
    const edit = st.drafts.get(d.id);
    return `<button class="kw-file ${st.current === d.id ? "active" : ""}" data-act="kb-doc" data-id="${esc(d.id)}" title="${esc(d.path)}" aria-current="${st.current === d.id ? "page" : "false"}">${fileIcon(d)}<span class="kw-file-label"><b>${esc(d.title || d.path.split("/").pop())}</b><small>${esc(search ? d.path : typeOf(d).toUpperCase())}${dirty(edit) ? " · 未保存草稿" : ""}</small></span></button>`;
  }
  function folderEditor(parent, depth, st) {
    const f = st.folderInput;
    if (!f || f.parent !== parent) return "";
    return `<div class="kw-folder-editor" style="--kw-depth:${depth}"><span style="color:var(--fic-folder);display:inline-flex">${icon("folder", "ico-14")}</span><div><input id="kw-folder-name" class="input" aria-label="新文件夹名称" aria-invalid="${Boolean(f.error)}" aria-describedby="kw-folder-help" value="${esc(f.name)}" placeholder="文件夹名"><small id="kw-folder-help" class="${f.error ? "kw-error-text" : ""}">${esc(f.error || "Enter 确认 · Escape 取消")}</small></div><button class="icon-btn" data-act="kw-folder-cancel" aria-label="取消新建文件夹">${icon("x", "ico-14")}</button></div>`;
  }
  function treeHtml(lib, st) {
    const q = String(store.kbQuery || "").trim().toLocaleLowerCase(), docs = allDocs(lib), folders = directories(lib);
    const folderRow = (path, depth, searching) => {
      const collapsed = st.collapsed.has(path), open = st.menu?.path === path;
      return `<div class="kw-folder-row ${st.selectedFolder === path ? "selected" : ""}" style="--kw-depth:${depth}" data-folder="${esc(path)}">
        <button class="kw-folder-toggle" data-act="kw-folder-toggle" data-path="${esc(path)}" aria-expanded="${!collapsed}" title="${esc(path)}">${icon(collapsed ? "chevronRight" : "chevronDown", "ico-14")}<span style="color:var(--fic-folder);display:inline-flex">${icon(collapsed ? "folder" : "folderOpen", "ico-14")}</span><span class="ellipsis">${esc(searching ? path : path.split("/").pop())}</span></button>
        <span class="kw-row-actions ${open ? "visible" : ""}"><button class="icon-btn" data-act="kw-folder-menu" data-path="${esc(path)}" aria-label="在 ${esc(path)} 新建" aria-haspopup="menu" aria-expanded="${open}">${icon("plus", "ico-14")}</button><button class="icon-btn" data-act="kw-folder-menu" data-path="${esc(path)}" aria-label="${esc(path)} 更多操作" aria-haspopup="menu">${icon("more", "ico-14")}</button></span>
        ${open ? `<div class="kw-folder-menu" role="menu"><button role="menuitem" data-act="kw-new-md" data-parent="${esc(path)}">${icon("filePlus", "ico-14")}新建下级 MD</button><button role="menuitem" data-act="kw-new-folder" data-parent="${esc(path)}">${icon("folderPlus", "ico-14")}新建下级文件夹</button></div>` : ""}</div>`;
    };
    if (q) {
      const hits = docs.filter(d => (String(d.title) + " " + String(d.path)).toLocaleLowerCase().includes(q) || ((isMD(d) || isText(d)) && (contentOf(d) || "").toLocaleLowerCase().includes(q)));
      const dirs = [...folders].filter(p => p.toLocaleLowerCase().includes(q));
      return `<div class="kw-search-summary">${hits.length} 个文件 · ${dirs.length} 个目录 <button data-act="kw-search-clear">清除</button></div>${dirs.map(p => folderRow(p, 0, true) + folderEditor(p, 1, st)).join("")}${hits.map(d => fileButton(lib, d, st, true)).join("")}${hits.length + dirs.length ? "" : `<div class="kw-empty"><b>没有命中</b><p>搜索不会清除折叠状态、正文或草稿。</p></div>`}`;
    }
    const walk = (parent, depth) => {
      const dirs = [...folders].filter(p => parentOf(p) === parent).sort((a, b) => a.localeCompare(b, "zh-CN"));
      const files = docs.filter(d => parentOf(d.path) === parent);
      return folderEditor(parent, depth, st) + dirs.map(path => folderRow(path, depth, false) + (st.collapsed.has(path) ? "" : `<div class="kw-tree-children">${walk(path, depth + 1) || `<div class="kw-empty-folder" style="--kw-depth:${depth + 1}">空目录 · 行尾＋添加内容</div>`}</div>`)).join("") + files.map(d => `<div style="--kw-depth:${depth}">${fileButton(lib, d, st, false)}</div>`).join("");
    };
    return `<div class="kw-root-row"><button data-act="kw-root" title="选择知识库根目录"><span style="color:var(--fic-folder);display:inline-flex">${icon("folderOpen", "ico-14")}</span>库根目录</button><button class="icon-btn" data-act="kw-new-folder" data-parent="" aria-label="在库根目录新建文件夹">${icon("folderPlus", "ico-14")}</button><button class="icon-btn" data-act="kw-collapse-all" aria-label="收起全部目录">${icon("collapse", "ico-14")}</button></div>${walk("", 0)}${!docs.length && !folders.size && !st.folderInput ? `<div class="kw-empty"><b>知识库为空</b><p>本人可以直接新建或演示上传。AI 项目尚未获授权不影响管理。</p></div>` : ""}`;
  }
  const uploads = [
    { key: "md", name: "演示说明.md", type: "md", title: "演示说明", bytes: 180, body: "# 演示说明\n\n此正文是 CR-045 合成上传夹具，不来自本机文件。\n\n## 使用范围\n\n仅在设计稿内存演示阅读、编辑与保存。" },
    { key: "image", name: "演示图片.png", type: "png", title: "演示图片", bytes: null, image: true },
    { key: "text", name: "演示文本.txt", type: "txt", title: "演示文本", bytes: 80, body: "纯文本安全源码演示\n<script>alert('不执行')</script>\n" },
    { key: "json", name: "演示配置.json", type: "json", title: "演示配置", bytes: 100, body: '{\n  "source": "synthetic-demo",\n  "enabled": true,\n  "markup": "<script>never execute</script>"\n}' },
    { key: "csv", name: "演示台账.csv", type: "csv", title: "演示台账", bytes: 80, body: 'name,status\n"演示条目",draft\n"=not-a-formula",text' },
    { key: "pdf", name: "演示报告.pdf", type: "pdf", title: "演示报告", bytes: null },
    { key: "office", name: "演示附件.docx", type: "docx", title: "演示附件", bytes: null },
    { key: "zip", name: "演示归档.zip", type: "zip", title: "演示归档", bytes: null }
  ];
  function uploadHtml(st) {
    if (!st.upload) return "";
    const u = st.upload;
    return `<section class="kw-upload" aria-label="纯仿真上传选择"><div class="row between"><b>上传演示 · 预置样例</b><button class="icon-btn" data-act="kw-upload-close" aria-label="取消上传演示">${icon("x", "ico-14")}</button></div><p>没有打开本机文件选择器，也不读文件或网络。选择项仅进入 DEMO 内存；附件不含原件字节。</p><p>目标：${esc(u.parent || "库根目录")} · 同名拒绝，不覆盖</p><div class="kw-upload-options">${uploads.map(f => `<label><input type="checkbox" data-kw-upload="${f.key}" ${u.selected.has(f.key) ? "checked" : ""}>${fileIcon(f)}<span>${esc(f.name)}</span></label>`).join("")}</div>${u.error ? `<p class="kw-error-text" role="alert">${esc(u.error)}</p>` : ""}<button class="btn sm primary" data-act="kw-upload-confirm">添加选中演示项</button></section>`;
  }
  function confirmHtml(st) {
    if (!st.confirm) return "";
    return `<div class="kw-confirm" role="alert"><b>${st.confirm.kind === "load-latest" ? "放弃当前草稿并读取最新原文？" : "放弃未保存草稿？"}</b><span>此操作不可撤销；不修改已保存原文。</span><div class="row"><button class="btn sm danger" data-act="kw-discard-confirm">确认放弃</button><button class="btn sm" data-act="kw-discard-keep">保留草稿</button></div></div>`;
  }
  function errorPanel(draft) {
    return `<div id="kw-save-error" class="kw-save-error" ${draft?.error ? "" : "hidden"} role="alert">${esc(draft?.error || "")}</div>`;
  }
  function formatInfo(d) {
    const t = typeOf(d);
    const mismatch = String(d.path || "").split(".").pop().toLowerCase() !== t && !(isMD(d) && /\.(md|markdown)$/i.test(d.path || ""));
    return `<dl class="kw-info"><dt>类型 / MIME</dt><dd>${esc(t.toUpperCase())} / ${esc(mime(t))}</dd><dt>路径</dt><dd class="mono">${esc(d.path)}</dd><dt>大小</dt><dd>${esc(d.size || "未嵌入原件，未知")}</dd><dt>更新</dt><dd>${esc(d.updated || "—")}</dd><dt>来源</dt><dd>${esc(d.source || "既有合成 inventory；不是本机实测文件")}</dd>${mismatch ? `<dt>字段核验</dt><dd class="kw-error-text">旧夹具类型与扩展名不一致；保留原记录，不自动改为可编辑 MD。</dd>` : ""}</dl>`;
  }
  function mime(t) {
    return ({ md: "text/markdown", markdown: "text/markdown", txt: "text/plain", text: "text/plain", csv: "text/csv", json: "application/json", png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip" })[t] || "application/octet-stream";
  }
  function preview(d, st, text) {
    if (!d) return `<div class="kw-empty kw-welcome"><span>${icon("bookOpen", "ico-20")}</span><h2>${st.selectedFolder ? esc(st.selectedFolder) : "开始整理知识资料"}</h2><p>从左侧选择文件；新 MD 直接在这里编辑，首次保存才会出现在目录树。</p><button class="btn primary" data-act="kw-new-md" data-parent="${esc(st.selectedFolder)}">${icon("filePlus", "ico-14")}新建 MD</button></div>`;
    if (isMD(d)) return text === null ? `<div class="kw-empty"><h2>正文未提供</h2><p>既有样例缺少正文，不以标题伪造内容，也不能保存空串覆盖未知原件。</p></div>` : `<div class="kw-markdown doc-body">${safeMarkdown(text).html || `<p class="caption">空正文（已提供空字符串，不是读取失败）。</p>`}</div>`;
    if (isText(d)) return `<div class="kw-type-note">UTF-8 ${esc(typeOf(d).toUpperCase())} · 安全源码阅读；不执行 HTML、公式或脚本，CSV 不是电子表格引擎。</div>${text === null ? `<div class="kw-empty"><b>文本正文未提供</b><p>无法从元信息推断正文。</p></div>` : `<pre class="kw-source"><code>${esc(text)}</code></pre>`}`;
    if (isImage(d)) return `<div class="kw-type-note">${d.demoImage ? "合成上传项；使用合法本地品牌图形演示图片预览，不来自本机文件。" : "此文件的原图未嵌入；以下使用合法本地品牌资产演示预览，不冒充该文件原图。"}</div><figure class="kw-image ${st.imageZoom ? "zoomed" : ""}"><img src="${asset}" alt="栖造帆船图形：本仓库合法本地演示资产，并非知识原件"><figcaption>本地设计资产：brand-assets-v2/logo-sail.png · 与 ${esc(d.path)} 原件无关</figcaption><button class="btn sm" data-act="kw-image-zoom">${st.imageZoom ? "恢复适应" : "放大演示图"}</button><p class="caption kw-image-error" hidden>本地演示资产加载失败，不伪造预览成功。</p></figure>`;
    const pdf = typeOf(d) === "pdf", active = ["html", "htm", "svg"].includes(typeOf(d));
    return `<div class="kw-original"><span class="kw-original-icon">${fileIcon(d)}</span><h2>${esc(d.title)}</h2><p>${pdf ? "PDF 原件 / 环境边界" : active ? "主动内容仅保留元信息" : "原件附件 / 元信息"}</p><p>${pdf ? "设计稿没有嵌入 PDF 字节，也未接入安全原生 PDF 查看器。既有 Markdown 摘要不是 PDF，不能当作 PDF 预览。" : active ? "不内嵌执行 HTML / SVG、脚本或任意本地资源。" : "Office / ZIP / 其它附件不提供原生编辑或假正文预览；不解压、不执行宏，不继承 AI 写权限。"}</p>${formatInfo(d)}<button class="btn" data-act="kw-download-boundary">${icon("download", "ico-14")}下载原件（未接入）</button><p class="caption">下载仅展示边界提示，不生成空白文件、假 PDF 或假 Office。</p></div>`;
  }
  function liveId(lib,key) { return JSON.stringify(['knowledge',lib,key]); }
  function docHtml(lib, st, v) {
    const { draft, doc, text, mode }=v, editing=mode==='edit', readable=draft || (isMD(doc)&&text!==null);
    const key=st.current, id=liveId(lib,key), title=draft?.title||doc?.title||'知识工作区';
    const headGlyph=(doc||draft)?fico(doc||(draft?{type:'md'}:null),'ico-20'):'';
    const live=readable?LiveDoc.render(id,text,{
      readOnly:!editing,
      write:(body)=> { const d=state(lib).drafts.get(key); if(!d)return {ok:false,error:'没有可写缓冲'}; d.body=body;return saveDraft(lib,key,d); },
      onChange:body=>{const d=state(lib).drafts.get(key);if(d)d.body=body; updateTOC(lib,key,body);},
      onSaved:()=>{const root=document.querySelector('.knowledge-workspace');if(root?.dataset.library===lib){root.querySelector('.kb-docs').innerHTML=treeHtml(lib,state(lib));}}
    }):preview(doc,st,text);
    return '<div class="kw-document-head"><button class="icon-btn kw-tree-mobile" data-act="kw-toggle-tree" aria-label="打开知识文件树">'+icon('panelLeft','ico-14')+'</button><span class="kw-doc-ico">'+headGlyph+'</span><div class="crumb"><span>'+esc(title)+'</span></div><span class="spacer"></span>'+(readable?'<div class="seg" role="tablist" aria-label="文档视图"><button data-act="kw-mode" data-mode="read" aria-selected="'+(!editing)+'">阅读</button><button data-act="kw-mode" data-mode="edit" aria-selected="'+editing+'">编辑</button></div>':'')+'</div>'+
      '<div class="kw-toolbar"><span class="ellipsis">'+esc(doc?.path||draft?.parent||'库根目录')+'</span><span class="spacer"></span><span class="caption">'+(readable?(editing?'所见即所得 · 自动保存':'只读阅读 · 防止误改'):'原件阅读')+'</span>'+(draft?.isNew?'<button class="btn sm" data-act="kw-cancel">放弃未创建文档</button>':'')+'</div>'+
      '<div class="kw-memory-note">合成设计 · 自动保存仅更新页面样例，不写磁盘。阅读视图不可修改正文；切入编辑后直接在排版内输入。</div>'+errorPanel(draft)+confirmHtml(st)+
      '<div class="kw-scroll kb-article-body" data-kw-scroll data-kw-current="'+esc(key||'')+'">'+(draft?.isNew?'<div class="kw-editor"><label for="kw-title">文件名 · Enter或失焦确认后自动创建</label><input id="kw-title" class="kw-title input" value="'+esc(draft.title)+'" placeholder="未命名.md"></div>':'')+live+
      (draft?.conflict?'<section class="kw-conflict"><h3>外部版本已改变，停止自动覆盖</h3><p>当前内容与新版本均保留，不能用重试强行覆盖。</p><details><summary>查看最新内容</summary><pre>'+esc(draft.conflict.body)+'</pre></details><button class="btn sm" data-act="kw-load-latest">载入最新原文…</button></section>':'')+'</div>';
  }
  function updateTOC(lib,key,text) {
    const root=document.querySelector('.knowledge-workspace');if(root?.dataset.library!==lib||state(lib).current!==key)return;
    const pane=root.querySelector('.kw-toc');pane.querySelectorAll('.kw-toc-item').forEach(el=>el.remove());
    const heads=safeMarkdown(text).headings;
    const head=pane.querySelector('.kw-toc-head');head.insertAdjacentHTML('afterend',heads.map((h,n)=>'<button class="kw-toc-item" data-act="kw-toc" data-heading="live-heading-'+n+'">'+esc(h.title)+'</button>').join(''));
    LiveDoc.get(liveId(lib,key))?.editor.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el,n)=>el.id='live-heading-'+n);
  }
  function sidebarHtml(lib, st, v) {
    const { draft, doc, text } = v, mdMode = Boolean(draft || (doc && isMD(doc)));
    const sections = mdMode && text !== null ? safeMarkdown(text).headings : [];
    return `<div class="kw-toc-head"><b>${mdMode ? "本页目录" : "文件信息"}</b><button class="icon-btn kw-toc-mobile" data-act="kw-toggle-toc" aria-label="关闭目录面板">${icon("x", "ico-14")}</button></div>${mdMode ? sections.map(h => `<button class="kw-toc-item" style="--kw-level:${h.level}" data-act="kw-toc" data-heading="${h.id}">${esc(h.title)}</button>`).join("") || `<p class="caption">${text === null ? "正文未提供，无目录。" : "当前正文没有标题。"}</p>` : doc ? formatInfo(doc) : `<p class="caption">选择文件后显示信息。</p>`}
      <div class="kw-side-section"><b>本人资料管理</b><p>不受 AI 项目授权有无限制。授权只控制 AI 的只读检索，不授予写入或执行。</p><button class="btn sm" data-act="kb-grant-open" data-id="${esc(lib.id)}">${icon("shield", "ico-14")}AI 授权管理</button></div>
      ${draft ? `<div class="kw-side-section"><b>保存边界演示</b><p>仅模拟故障和外改，不触碰真实文件。</p><button class="btn sm" data-act="kw-demo-failure">下一次保存失败</button><button class="btn sm" data-act="kw-demo-conflict" ${draft.isNew ? "disabled" : ""}>模拟外部修改冲突</button>${draft.failNext ? `<small>已设置下一次保存失败</small>` : ""}</div>` : ""}<p class="kw-safety-note">正文链接仅显示文字；不自动读取外链图片。AI 索引解析／FTS5 未接入。</p>`;
  }
  function render(libId) {
    const lib = D.knowledge.libraries.find(l => l.id === libId);
    if (!lib) return `<div class="page"><div class="empty"><h2>知识库不存在</h2><p>不回落到另一个库。</p></div></div>`;
    const st = state(libId);
    if (!st.current || (!st.drafts.has(st.current) && !getDoc(libId, st.current))) st.current = getDoc(libId, store.kbDoc)?.id || allDocs(libId)[0]?.id || null;
    if (getDoc(libId, st.current)) store.kbDoc = st.current;
    const v = view(libId, st), draftTabs = [...st.drafts.entries()];
    return `<div class="kb-reader knowledge-workspace ${st.treeOpen ? "kw-show-tree" : ""} ${st.tocOpen ? "kw-show-toc" : ""}" data-library="${esc(libId)}" data-design-version="UI-CR048-v2">
      <aside class="kb-nav kw-tree" data-pane="kb-tree"><div class="kb-nav-h"><b>${icon("book", "ico-14")}${esc(lib.name)}</b><div class="meta">${allDocs(libId).length} 个文件 · ${lib.allProjects ? "AI：所有项目" : "AI：" + (lib.grantedTo || []).length + " 个项目授权"}</div><button class="icon-btn kw-tree-mobile" data-act="kw-toggle-tree" aria-label="关闭知识文件树">${icon("x", "ico-14")}</button></div>
        <div class="kw-create-actions"><button class="btn sm" data-act="kw-upload-open">${icon("upload", "ico-14")}上传（演示）</button><button class="btn sm primary" data-act="kw-new-md" data-parent="">${icon("filePlus", "ico-14")}新建 MD</button></div>${uploadHtml(st)}<label class="search">${icon("search", "ico-14")}<input class="input" id="kb-search" data-act="kb-search" aria-label="搜索知识文件或已提供文本" placeholder="搜索文件或正文" value="${esc(store.kbQuery)}"></label>
        <div class="kb-docs">${treeHtml(libId, st)}</div><div class="kw-tree-footer"><button class="btn sm" data-act="kb-grant-open" data-id="${esc(libId)}">${icon("shield", "ico-14")}AI 授权管理</button><small>本人可管理 · AI 权限另行授权</small></div></aside>
      <article class="kb-article kw-document" data-pane="kb-document">${draftTabs.length ? `<nav class="kw-draft-tabs" aria-label="保留的编辑草稿">${draftTabs.map(([key, d]) => `<button data-act="kw-draft-select" data-id="${esc(key)}" aria-selected="${st.current === key}">${icon("edit", "ico-14")}${esc(d.title || "未命名 MD")}${dirty(d) ? " *" : ""}${d.isNew ? "（未落盘）" : ""}</button>`).join("")}</nav>` : ""}${st.notice ? `<div class="kw-notice" role="status">${esc(st.notice)}<button data-act="kw-notice-close" aria-label="关闭消息">${icon("x", "ico-14")}</button></div>` : ""}${docHtml(libId, st, v)}</article>
      <aside class="kb-toc kw-toc" data-pane="kb-toc">${sidebarHtml(lib, st, v)}</aside></div>`;
  }
  function select(id) {
    const st = currentState(), lib = currentLib();
    if (!st.drafts.has(id) && !getDoc(lib, id)) return;
    const old = document.querySelector(".knowledge-workspace .kw-scroll");
    if (old && st.current) st.scroll.set(st.current, old.scrollTop);
    st.current = id; st.confirm = null; st.imageZoom = false; st.treeOpen = false;
    if (getDoc(lib, id)) store.kbDoc = id;
    const doc = getDoc(lib, st.drafts.get(id)?.docId || id);
    if (doc) st.selectedFolder = parentOf(doc.path);
    renderAgain();
  }
  function newMarkdown(parent) {
    const st = currentState();
    const key = idFor("DRAFT");
    st.drafts.set(key, { isNew: true, docId: null, parent, title: "", body: "", baseBody: "", baseTitle: "", mode: "edit", error: "", conflict: null, saveState: "待创建" });
    st.current = key; st.menu = null; st.upload = null; st.confirm = null; st.treeOpen = false;
    st.notice = "新文档只在中间编辑区与草稿栏，尚未进入文件树；切换会保留草稿。";
    renderAgain("kw-title");
  }
  function setMode(mode) {
    LiveDoc.flush();
    const lib=currentLib(),st=currentState(),doc=getDoc(lib,st.current);
    let d=st.drafts.get(st.current);
    if(!d&&doc&&isMD(doc)) {
      const body=contentOf(doc);if(body===null)return;
      d={isNew:false,docId:doc.id,parent:parentOf(doc.path),title:doc.title,body,baseBody:body,baseTitle:doc.title,basePath:doc.path,error:'',conflict:null};st.drafts.set(doc.id,d);
    }
    if(d){d.mode=mode;renderAgain();}
  }
  function saveDraft(lib,key,draft) {
    const st=state(lib);draft.error='';
    if(draft.isNew&&!draft.nameConfirmed)return {ok:false,error:'待命名：Enter或失焦确认合法文件名后自动创建。'};
    draft.error=nameError(draft.title);
    const filename=draft.isNew?markdownName(draft.title):null;
    if(!draft.error&&draft.isNew&&pathTaken(lib,join(draft.parent,filename)))draft.error='同目录重名，未创建、不覆盖；输入保留。';
    if(!draft.error&&draft.parent&&!directories(lib).has(draft.parent))draft.error='父目录已不存在，内容保留。';
    if(!draft.error&&draft.failNext){draft.failNext=false;draft.error='模拟写入失败，正文保留；恢复后可重试。';}
    if(!draft.error&&!draft.isNew){const doc=getDoc(lib,draft.docId),latest=contentOf(doc);if(!doc||latest===null||latest!==draft.baseBody||doc.path!==draft.basePath){draft.conflict={body:latest??'最新原文不可读'};draft.error='外部版本冲突，停止覆盖；双方内容保留。';}}
    if(draft.conflict&&!draft.error)draft.error='冲突尚未解决，拒绝覆盖。';
    if(draft.error)return {ok:false,error:draft.error,conflict:Boolean(draft.conflict)};
    let doc=getDoc(lib,draft.docId);
    if(draft.isNew){const path=join(draft.parent,filename);doc={id:idFor('KD'),path,title:draft.title.replace(/\.(md|markdown)$/i,''),type:'md',source:'CR-048合成内存文档'};D.knowledge.docs[lib]||=[];D.knowledge.docs[lib].push(doc);draft.isNew=false;draft.docId=doc.id;draft.title=doc.title;draft.basePath=path;st.collapsed.delete(draft.parent);}
    D.knowledge.content[doc.id]=draft.body;doc.updated='刚刚 · 仿真';doc.size=new TextEncoder().encode(draft.body).length+' B（合成正文）';
    draft.baseBody=draft.body;draft.baseTitle=draft.title;return {ok:true};
  }
  function save() { const lib=currentLib(),st=currentState();LiveDoc.save(liveId(lib,st.current)); }
  function confirmName() { const st=currentState(),d=st.drafts.get(st.current);if(!d?.isNew)return;d.nameConfirmed=true;const r=saveDraft(currentLib(),st.current,d);if(r.ok){const m=LiveDoc.get(liveId(currentLib(),st.current));if(m){m.saved=d.body;m.state='已自动保存';} }renderAgain(); }
  function discard() {
    const st = currentState(), draft = st.drafts.get(st.current);
    if (!draft) return;
    LiveDoc.remove(liveId(currentLib(),st.current)); st.drafts.delete(st.current);
    st.current = draft.isNew ? allDocs(currentLib())[0]?.id || null : draft.docId;
    st.confirm = null; st.notice = "已取消编辑；已保存原文和文件树未改动。"; renderAgain();
  }
  function folderSubmit() {
    const lib = currentLib(), st = currentState(), f = st.folderInput;
    if (!f) return;
    f.error = nameError(f.name);
    const path = join(f.parent, f.name);
    if (!f.error && f.parent && !directories(lib).has(f.parent)) f.error = "父目录已不存在，输入已保留。";
    if (!f.error && pathTaken(lib, path)) f.error = "同一目录已有这个名称；输入已保留。";
    if (f.error) { renderAgain("kw-folder-name"); return; }
    if (!D.knowledge.folders) D.knowledge.folders = {};
    if (!D.knowledge.folders[lib]) D.knowledge.folders[lib] = [];
    D.knowledge.folders[lib].push({ path, source: "CR-045 合成内存目录" });
    st.collapsed.delete(f.parent); st.selectedFolder = path; st.folderInput = null;
    st.notice = "已创建合成空目录，Enter 确认只操作内存；行尾＋可添加下级内容。"; renderAgain();
  }
  function uploadConfirm() {
    const lib = currentLib(), st = currentState(), u = st.upload;
    if (!u) return;
    const files = uploads.filter(f => u.selected.has(f.key));
    if (!files.length) { u.error = "请先选择演示项。"; renderAgain(); return; }
    if (u.parent && !directories(lib).has(u.parent)) { u.error = "目标目录已不存在，未添加任何项。"; renderAgain(); return; }
    const duplicate = files.find(f => pathTaken(lib, join(u.parent, f.name)));
    if (duplicate) { u.error = duplicate.name + " 已存在；本批不覆盖、不部分添加，勾选已保留。"; renderAgain(); return; }
    const added = files.map(f => ({ id: idFor("KD"), title: f.title, path: join(u.parent, f.name), type: f.type, size: f.bytes === null ? "原件未嵌入，未知" : new TextEncoder().encode(f.body || "").length + " B（合成正文）", updated: "刚刚 · 仿真", source: "CR-045 预置演示项；非本机上传", demoImage: Boolean(f.image) }));
    if (!D.knowledge.docs[lib]) D.knowledge.docs[lib] = [];
    added.forEach((d, i) => { D.knowledge.docs[lib].push(d); if (owns(files[i], "body")) D.knowledge.content[d.id] = files[i].body; });
    st.upload = null; st.collapsed.delete(u.parent); st.notice = "已添加 " + added.length + " 个演示项；没有文件选择器、文件复制或网络请求。";
    select(added[0].id);
  }
  Object.assign(window.__actions, {
    "kb-jump": el => {
      const lib = el.dataset.kb, id = el.dataset.doc;
      const library = D.knowledge.libraries.find(item => item.id === lib);
      if (!library || !getDoc(lib, id)) { toast("引用的知识文件不存在，不跳转其他库", "alert"); return; }
      const st = state(lib); st.current = id; st.confirm = null;
      UI.closeDialog(); UI.openWindow("library", lib, library.name, { kbDoc: id });
    },
    "kb-doc": el => select(el.dataset.id),
    "kw-new-md": el => newMarkdown(el.dataset.parent || ""),
    "kw-mode": el => setMode(el.dataset.mode),
    "kw-save": save,
    "kw-cancel": () => { const st = currentState(), d = st.drafts.get(st.current); if (dirty(d)) { st.confirm = { kind: "discard" }; renderAgain(); } else discard(); },
    "kw-discard-keep": () => { currentState().confirm = null; renderAgain(); },
    "kw-discard-confirm": () => {
      const st = currentState();
      if (st.confirm?.kind === "load-latest") { const d = st.drafts.get(st.current), doc = getDoc(currentLib(), d?.docId); if (!doc || contentOf(doc) === null) { st.notice = "最新原文不可读，仍保留当前草稿。"; st.confirm = null; renderAgain(); return; } }
      discard();
    },
    "kw-load-latest": () => { currentState().confirm = { kind: "load-latest" }; renderAgain(); },
    "kw-draft-select": el => select(el.dataset.id),
    "kw-folder-menu": el => { const st = currentState(); st.menu = st.menu?.path === el.dataset.path ? null : { path: el.dataset.path }; renderAgain(); },
    "kw-folder-toggle": el => { const st = currentState(), p = el.dataset.path; st.selectedFolder = p; st.collapsed.has(p) ? st.collapsed.delete(p) : st.collapsed.add(p); st.menu = null; renderAgain(); },
    "kw-new-folder": el => { const st = currentState(), p = el.dataset.parent || ""; st.folderInput = { parent: p, name: "", error: "" }; st.collapsed.delete(p); st.menu = null; store.kbQuery = ""; renderAgain("kw-folder-name"); },
    "kw-folder-cancel": () => { currentState().folderInput = null; renderAgain(); },
    "kw-collapse-all": () => { const st = currentState(); st.collapsed = new Set(directories(currentLib())); st.menu = null; renderAgain(); },
    "kw-root": () => { currentState().selectedFolder = ""; renderAgain(); },
    "kw-upload-open": () => { const st = currentState(); st.upload = st.upload ? null : { parent: st.selectedFolder, selected: new Set(), error: "" }; st.menu = null; renderAgain(); },
    "kw-upload-close": () => { currentState().upload = null; renderAgain(); },
    "kw-upload-confirm": uploadConfirm,
    "kw-search-clear": () => { store.kbQuery = ""; renderAgain("kb-search"); },
    "kw-demo-failure": () => { const d = currentState().drafts.get(currentState().current); if (d) d.failNext = true; renderAgain(); },
    "kw-demo-conflict": () => { const st = currentState(), d = st.drafts.get(st.current); if (!d || d.isNew) return; d.conflict = { demo: true, body: d.baseBody + "\n\n> 模拟其他编辑者追加，不写入原文。" }; d.error = "模拟版本冲突：不会覆盖基线或当前草稿。"; renderAgain(); },
    "kw-end-conflict": () => { currentState().notice="外部冲突必须载入最新或保留副本，不能重试覆盖。";renderAgain(); },
    "kw-download-boundary": () => { currentState().notice = "原件下载未接入：没有创建/下载文件，也未打开真实保存对话框。"; renderAgain(); },
    "kw-image-zoom": () => { currentState().imageZoom = !currentState().imageZoom; renderAgain(); },
    "kw-notice-close": () => { currentState().notice = ""; renderAgain(); },
    "kw-toggle-tree": () => { const st = currentState(); st.treeOpen = !st.treeOpen; st.tocOpen = false; renderAgain(); },
    "kw-toggle-toc": () => { const st = currentState(); st.tocOpen = !st.tocOpen; st.treeOpen = false; renderAgain(); },
    "kw-toc": el => {
      const st = currentState(), draft = st.drafts.get(st.current), heading = el.dataset.heading;
      const live=LiveDoc.get(liveId(currentLib(),st.current));
      if(live){const n=Number(heading.split("-").pop());const el=live.editor.querySelectorAll("h1,h2,h3,h4,h5,h6")[n];if(el){el.scrollIntoView({block:"start"});return;}}
      const target = document.querySelector(".knowledge-workspace .kw-scroll #" + heading);
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" }); st.tocOpen = false;
        document.querySelector(".knowledge-workspace")?.classList.remove("kw-show-toc");
      } else toast("当前正文无此标题", "info");
    }
  });
  // Local inputs are captured independently of core's view cache, keeping drafts
  // across object switches without modifying shared core or the real filesystem.
  document.addEventListener("input", event => {
    const el = event.target;
    if (!el.closest?.(".knowledge-workspace")) return;
    const st = currentState();
    if (el.id === "kw-folder-name" && st.folderInput) st.folderInput.name = el.value;
    if (el.id === "kw-title" || el.id === "kw-body") {
      const draft = st.drafts.get(st.current); if (!draft) return;
      draft[el.id === "kw-title" ? "title" : "body"] = el.value;
      const label = document.getElementById("kw-dirty-label"); if (label) label.textContent = dirty(draft) ? "未保存" : "与原文一致";
    }
  });
  document.addEventListener("focusout",event=>{if(event.target.id==="kw-title"&&!event.target.closest(".live-doc-host"))confirmName();});
  document.addEventListener("change", event => {
    const key = event.target.dataset?.kwUpload, u = currentState().upload;
    if (!key || !u || !event.target.closest(".knowledge-workspace")) return;
    event.target.checked ? u.selected.add(key) : u.selected.delete(key);
  });
  document.addEventListener("keydown", event => {
    if (!event.target.closest?.(".knowledge-workspace")) return;
    const st = currentState();
    if(event.target.id === "kw-title" && event.key === "Enter" && !event.isComposing){event.preventDefault();confirmName();return;}
    if (event.target.id === "kw-folder-name" && (event.key === "Enter" || event.key === "Escape") && !event.isComposing) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Enter") folderSubmit(); else { st.folderInput = null; renderAgain(); }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && st.drafts.has(st.current)) { event.preventDefault(); event.stopImmediatePropagation(); save(); return; }
    if (event.key === "Escape" && (st.menu || st.upload || st.confirm || st.treeOpen || st.tocOpen)) {
      event.preventDefault(); event.stopImmediatePropagation(); st.menu = null; st.upload = null; st.confirm = null; st.treeOpen = false; st.tocOpen = false; renderAgain();
    }
  }, true);
  document.addEventListener("click", event => {
    if (UI.activeWindow().kind !== "library") return;
    const st = currentState();
    if (st.menu && !event.target.closest?.(".kw-folder-menu, [data-act=kw-folder-menu]")) { st.menu = null; document.querySelectorAll(".kw-folder-menu").forEach(el => el.remove()); }
  });
  document.addEventListener("error", event => {
    const img = event.target;
    if (!img.matches?.(".kw-image img")) return;
    img.hidden = true; const error = img.closest(".kw-image")?.querySelector(".kw-image-error"); if (error) error.hidden = false;
  }, true);
  window.KnowledgeWorkspace = { render, safeMarkdown, nameError, version: "UI-CR048-v2" };
  window.Screens.library = render;
  if (UI.activeWindow().kind === "library") UI.render();
})();
