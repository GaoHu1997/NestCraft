/* 核心：状态、图标、Markdown、外壳、窗口与弹层。纯设计稿仿真，不联网、不调用真实 CLI。 */
window.UI = (function () {
  "use strict";
  const D = window.DEMO;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    folder: '<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.5l2 2H19a2 2 0 0 1 2 2v8.8A2.2 2.2 0 0 1 18.8 20H5.2A2.2 2.2 0 0 1 3 17.8z"/>',
    folderOpen: '<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.5l2 2H19a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-2.2 8.2A2 2 0 0 1 16.9 20H5.2A2.2 2.2 0 0 1 3 17.8z"/>',
    book: '<path d="M4 19.2A2.2 2.2 0 0 1 6.2 17H20"/><path d="M6.2 2H20v20H6.2A2.2 2.2 0 0 1 4 19.8V4.2A2.2 2.2 0 0 1 6.2 2z"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    refresh: '<path d="M20 11.5A8 8 0 1 0 18 17"/><path d="M20 4v7.5h-7.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    alert: '<path d="M12 9v4.5M12 17h.01"/><path d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M18 21a6.5 6.5 0 0 0-2-4.7"/>',
    sparkles: '<path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8z"/><path d="M18.5 15.5 19.2 17l1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z"/>',
    terminal: '<path d="m4.5 17 6-5-6-5"/><path d="M12.5 19H20"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    filePdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13.5h2a1.5 1.5 0 0 1 0 3h-2zM13.5 13.5h1.2a2 2 0 0 1 0 4h-1.2z"/>',
    fileSheet: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h8M11 13v4M14 13v4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    csv: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h3M8 17h3M14 13h2M14 17h2"/>',
    git: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8" r="2.6"/><path d="M6 8.6v6.8M18 10.6v1a4.4 4.4 0 0 1-4.4 4.4H8.6"/>',
    code: '<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>',
    database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2"/>',
    send: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.8 21l-4.3-7.5L3 9.2z"/>',
    paperclip: '<path d="m20.5 12.5-8.2 8.2a4.8 4.8 0 0 1-6.8-6.8l8.2-8.2a3.2 3.2 0 0 1 4.6 4.6l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.3-7.3"/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    history: '<rect x="3" y="4" width="13.5" height="16" rx="2.5"/><path d="M6.5 8.5h6.5M6.5 12h6.5M6.5 15.5h4"/><path d="M20.5 7.5v9.5a3 3 0 0 1-3 3H6.5"/>',
    gauge: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5.2-3.6"/><circle cx="12" cy="12" r="1.6"/>',
    eye: '<path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8V16h7.2v-2.2A6 6 0 0 0 12 3z"/>',
    steps: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 5.6 1.4 1.4L7.4 4.5"/><circle cx="4.6" cy="12" r="1.2"/><circle cx="4.6" cy="18" r="1.2"/>',
    dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    filter: '<path d="M3 5h18M6.5 12h11M10 19h4"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
    upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 3h4v4"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
    box: '<path d="m21 8-9-5-9 5v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2 12h2M20 12h2M4.5 19.5 6 18M18 6l1.5-1.5"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
    branch: '<path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    inbox: '<path d="M4 13 6 5h12l2 8"/><path d="M4 13v6h16v-6h-5l-1.5 3h-3L9 13z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>',
    message: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 18-4z"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    drag: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    bookOpen: '<path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v14c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-14c-4.5 0-6.5.5-8 2z"/><path d="M12 6.5v14"/>',
    printer: '<path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 16h10v5H7z"/>',
    minimize: '<path d="M5 12h14"/>',
    maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    restore: '<path d="M9 5V3h12v12h-2"/><rect x="3" y="9" width="12" height="12" rx="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="m8 8 8 8M16 8l-8 8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    save: '<path d="M4 3h13l4 4v14H3V3z"/><path d="M7 3v6h9V3M7 21v-8h10v8"/>',
    undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
    redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>',
    arrowRight: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    arrowDown: '<path d="M12 5v14m-7-7 7 7 7-7"/>',
    folderPlus: '<path d="M3 7V5h6l2 2h10v13H3zM12 10v7m-3-3.5h6"/>',
    filePlus: '<path d="M14 3H5v18h14V8l-5-5v5h5M12 11v7m-3-3.5h6"/>',
    fileWord: '<path d="M14 3H5v18h14V8l-5-5v5h5M8 12l2 6 2-5 2 5 2-6"/>',
    fileSlides: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><rect x="8" y="12" width="8" height="6" rx="1"/>',
    fileCode: '<path d="M14 3H5v18h14V8l-5-5v5h5m-9 4-2 3 2 3m4-6 2 3-2 3"/>',
    fileArchive: '<path d="M14 3H5v18h14V8l-5-5v5h5M10 3v9m-1 0h2v5H9z"/>',
    filterOff: '<path d="M3 5h18M7 12h10M10 19h4M3 3l18 18"/>',
    sort: '<path d="M7 4v16m-3-3 3 3 3-3M13 5h8M13 10h6M13 15h4"/>',
    expand: '<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>',
    collapse: '<path d="M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
    alignLeft: '<path d="M4 4v16M8 6h12M8 12h8M8 18h12"/>',
    alignCenter: '<path d="M12 3v18M4 6h16M7 12h10M4 18h16"/>',
    alignRight: '<path d="M20 4v16M4 6h12M8 12h8M4 18h12"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3-4-6-9-6z"/><path d="M7 8h.01M12 6h.01M17 8h.01M6 13h.01"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    loader: '<path d="M12 3a9 9 0 1 1-9 9"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM8 12l3 3 5-6"/>',
    unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2.6"/>',
    gitMerge: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><circle cx="18" cy="20" r="2"/><path d="M18 6v12M6 6v3a7 7 0 0 0 7 7h5"/>',
    gitCommit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
    command: '<path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2z"/>',
    workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9"/>',
    bot: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 17h8"/>',
    wrench: '<path d="M14 4a6 6 0 0 0-7 8L3 17a2.8 2.8 0 0 0 4 4l5-5a6 6 0 0 0 8-7l-4 4-5-5z"/>'
  };
  const iconAliases = { project: "folder", knowledge: "book", library: "book", directory: "folder", fileExcel: "fileSheet", filePpt: "fileSlides", fileDoc: "fileWord", warning: "alert", success: "checkCircle", delete: "trash", externalLink: "external", windowMinimize: "minimize", windowMaximize: "maximize", windowRestore: "restore", windowClose: "close" };
  function icon(name, cls) {
    const canonical = Object.prototype.hasOwnProperty.call(P, name) ? name : iconAliases[name];
    const missing = !canonical;
    return `<svg class="ico ${esc(cls || "")}${missing ? " icon-missing" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${missing ? `role="img" aria-label="缺失图标：${esc(name)}" data-missing-icon="${esc(name)}"` : 'aria-hidden="true"'}>${missing ? `<title>缺失图标：${esc(name)}</title>` : ""}<use href="./icon-sprite.svg#${canonical || "error"}"></use></svg>`;
  }
  function cliLogo(id, size) {
    const known = ["claude", "codex", "grok"].includes(id);
    const px = [14, 16, 18, 20, 24, 28, 32, 48].includes(Number(size)) ? Number(size) : 20;
    const status = known ? "官方资源加载中；失败标记未就绪" : id === "dsh" ? "无可核验的独立官方 CLI 标志 · not available" : "官方图标资源未就绪";
    return `<span class="cli-logo cli-brand ${known ? "asset-pending" : "asset-unavailable"}" style="width:${px}px;height:${px}px" title="${esc(id + " · " + status)}" aria-label="${esc(id + " · " + status)}" data-cli-brand="${esc(id)}">${known ? `<img src="./brand-icons/${id}.svg" alt="${esc(id)} 官方品牌标志" data-cli-asset="${esc(id)}">` : icon("error", "ico-14")}<span class="sr-only">${esc(status)}</span></span>`;
  }
  const fileIcon = type => icon(type === "pdf" ? "filePdf" : type === "xlsx" ? "fileSheet" : type === "png" ? "image" : type === "csv" ? "csv" : "fileText", "ico-14");

  /* ---------------- Markdown ---------------- */
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function md(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0, list = null, inCode = false, code = [], table = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeTable = () => { if (table) { out.push("</tbody></table>"); table = null; } };
    const flushCode = () => { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = []; inCode = false; };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line.trim())) { if (inCode) flushCode(); else { closeList(); closeTable(); inCode = true; } i++; continue; }
      if (inCode) { code.push(line); i++; continue; }
      if (!line.trim()) { closeList(); closeTable(); i++; continue; }
      if (/^\|.*\|$/.test(line.trim())) {
        closeList();
        const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        if (!table) { out.push("<table><thead><tr>" + cells.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>"); table = true; i += 2; continue; }
        out.push("<tr>" + cells.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>");
        i++; continue;
      } else closeTable();
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
      if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }
      if (/^[-*]\s+/.test(line)) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`); i++; continue; }
      if (/^\d+[.)]\s+/.test(line)) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(line.replace(/^\d+[.)]\s+/, ""))}</li>`); i++; continue; }
      if (/^---+$/.test(line.trim())) { closeList(); out.push("<hr/>"); i++; continue; }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
      i++;
    }
    if (inCode) flushCode();
    closeList(); closeTable();
    return out.join("\n");
  }
  function toc(text) {
    return String(text || "").split("\n").map(l => /^(#{2,3})\s+(.*)$/.exec(l)).filter(Boolean)
      .map(m => ({ level: m[1].length, title: m[2].replace(/[`*]/g, "") }));
  }

  /* ---------------- 状态 ---------------- */
  const store = {
    theme: localStorage.getItem("wb4-theme") || "light",
    windows: [{ id: "home", kind: "home", viewStates: {} }],
    windowState: "normal",
    active: "home",
    homePage: "workbench",
    projectFilter: "all",
    projQuery: "",
    projectModal: null,
    reqMenu: null,
    reqDialog: null,
    reqDetail: null,
    dispatchNode: null,
    projectId: "PRJ-1042",
    projectTab: "requirements",
    selectedReq: "STORY-0102",
    collapsed: ["EPIC-02"],
    treeQuery: "",
    designTab: "prd",
    designEdit: false,
    designToc: true,
    taskId: "RUN-2095",
    codeRail: "files",
    codeFile: "src/booking/service.ts",
    codeEdit: false,
    codeDraft: null,
    gitBranch: "feature/booking-idempotency",
    gitMessage: "",
    gitSection: "changes",
    kbId: "KB-01",
    kbDoc: "KD-011",
    kbQuery: "",
    kbGrant: null,
    serverId: "SRV-01",
    termInput: "",
    termLog: null,
    termTab: "shell1",
    settingsOpen: false,
    settingsTab: "general",
    providerEdit: null,
    providerOpen: null,
    endpointsOpen: false,
    providerTab: "config",
    modelEdit: null,
    modelOpen: null,
    keyEdit: null,
    sdkOpen: null,
    sdkTab: "cli",
    cliOpen: "claude",
    skillDialog: null,
    mcpDialog: null,
    aiOpen: true,
    aiWidth: 372,
    aiHistory: false,
    aiTop: null,
    aiBgOpen: null,
    aiStepsOpen: true,
    aiModelQuery: "",
    aiMenu: null,
    aiMenuQuery: "",
    aiStats: null,
    aiMenuTab: "add",
    aiMessages: D.ai.sessions[0].messages.slice(),
    aiSession: D.ai.sessions[0].id,
    aiBusy: false,
    aiGen: 0,
    aiPermission: "全自动",
    aiCli: "claude",
    aiInput: "",
    aiStick: true,
    officeDoc: "",
    termServer: null,
    dirPick: "",
    dirReturn: null,
    reqMenuPos: { x: 0, y: 0 },
    aiModelMenu: false,
    aiPermissionMenu: false,
    aiCliMenu: false,
    aiQueue: [],
    aiPop: null,
    editingFile: null,
    aiSubagents: false,
    aiBackground: false,
    aiContext: false,
    aiTokens: false,
    userMenu: false
  };
  document.documentElement.setAttribute("data-theme", store.theme);

  const toast = (msg, iconName) => {
    const wrap = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `${icon(iconName || "check", "ico-14")}<span>${esc(msg)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .2s"; setTimeout(() => el.remove(), 220); }, 2400);
  };

  const activeWindow = () => store.windows.find(w => w.id === store.active) || store.windows[0];
  // CR044: view-only cache. Business inventories, files, runs and conversation bodies stay at their original owners.
  const objectViews = new Map();
  const viewKeys = {
    home: ["homePage", "projectFilter", "projQuery"],
    project: ["projectId", "projectTab", "selectedReq", "collapsed", "treeQuery", "designTab", "designEdit", "designDraft", "designToc", "taskId", "taskTreeCollapsed", "codeRail", "codeFile", "codeEdit", "codeDraft", "editingFile", "gitBranch", "gitMessage", "gitSection", "officeDoc", "aiOpen", "aiHistory", "aiStepsOpen", "aiSession", "aiInput", "aiStick", "aiPermission", "aiCli"],
    library: ["kbId", "kbDoc", "kbQuery"],
    server: ["serverId", "serverSelected", "termInput", "termTab"]
  };
  const initialViews = Object.fromEntries(Object.entries(viewKeys).map(([kind, keys]) => [kind, Object.fromEntries(keys.map(k => [k, structuredClone(store[k])]))]));
  const scrollSelectors = ["#content", ".tree-wrap", ".tree-scroll", ".doc-body", ".code", ".file-tree", ".kb-docs", ".kb-article-body", "#term-body", ".srv-tree", "#ai-scroll", ".office-tree", ".office-document"];
  let renderedWindowId = null, restoreView = false;
  function captureView(w, captureDom) {
    if (!w) return;
    if (captureDom) {
      const code = $("#code-editor"), design = $("#design-editor"), term = $("#term-input");
      if (code && store.codeEdit) store.codeDraft = code.value;
      if (design && store.designEdit) store.designDraft = design.value;
      if (term) store.termInput = term.value;
    }
    const v = w.viewStates || (w.viewStates = {});
    (viewKeys[w.kind] || []).forEach(k => { v[k] = structuredClone(store[k]); });
    if (captureDom) v.scroll = Object.fromEntries(scrollSelectors.map(sel => { const el = $(sel); return [sel, el ? [el.scrollTop, el.scrollLeft] : v.scroll?.[sel] || [0, 0]]; }));
    if (w.kind !== "home") objectViews.set(w.id, v);
  }
  function applyView(w) {
    const v = w.viewStates || {};
    (viewKeys[w.kind] || []).forEach(k => { store[k] = structuredClone(v[k]); });
    if (w.kind === "project") {
      store.projectId = w.refId;
      const session = D.ai.sessions.find(s => s.id === store.aiSession);
      if (session) store.aiMessages = session.messages;
    }
    if (w.kind === "library") store.kbId = w.refId;
    if (w.kind === "server") store.serverId = w.refId;
    store.reqMenu = null; store.aiMenu = null; store.aiPop = null; store.aiTop = null;
  }
  function switchWindow(id) {
    const next = store.windows.find(w => w.id === id);
    if (!next) return;
    captureView(activeWindow(), renderedWindowId === store.active);
    store.active = id;
    if (window.OfficeAI) window.OfficeAI.activate(next);
    applyView(next);
    renderedWindowId = null; restoreView = true;
    document.body.classList.remove("nav-open");
    render();
  }
  function openWindow(kind, refId, title, locate) {
    if (!["project", "library", "server"].includes(kind)) return;
    const id = kind + ":" + refId;
    let w = store.windows.find(x => x.id === id);
    if (!w) {
      const cached = objectViews.get(id);
      const v = cached || structuredClone(initialViews[kind]);
      if (!cached && kind === "project") { v.projectId = refId; v.selectedReq = D.requirements.find(r => r.project === refId && r.kind === "story")?.id || null; v.collapsed = []; v.treeQuery = ""; v.codeDraft = null; v.codeEdit = false; v.designDraft = null; v.designEdit = false; v.aiInput = ""; }
      if (!cached && kind === "library") { v.kbId = refId; v.kbDoc = D.knowledge.docs[refId]?.[0]?.id || null; v.kbQuery = ""; }
      if (!cached && kind === "server") { v.serverId = refId; v.termServer = refId; v.termInput = ""; }
      w = { id, kind, refId, title, viewStates: v, reopened: Boolean(cached) };
      store.windows.push(w);
    }
    switchWindow(id);
    if (locate) { Object.entries(locate).forEach(([k, v]) => { if (viewKeys[kind].includes(k)) store[k] = structuredClone(v); }); render(); }
    return w;
  }
  function closeWindow(id, skipOfficeGuard, confirmed) {
    if (id === "home") return;
    const w = store.windows.find(x => x.id === id);
    if (!w) return;
    if (store.active === id) captureView(w, true);
    const v = w.viewStates || {};
    const running = w.kind === "project" && (D.tasks.some(t => t.project === w.refId && ["running", "verifying", "waiting"].includes(t.status)) || (window.Office && window.Office.model.getProject(w.refId)?.run?.state === "running"));
    const draft = v.codeEdit || v.codeDraft != null || v.designEdit || v.designDraft != null;
    if (!confirmed && (draft || running || !w.viewStates)) {
      openDialog(dlgShell("关闭对象 Tab？", w.title || w.refId, `<p>${draft ? "存在未保存编辑；视图草稿会留在本页对象缓存中，不写入文件。" : !w.viewStates ? "草稿状态未知，不按无草稿处理。" : "该项目仍有运行或等待状态。"}</p><p>仅关闭此 Tab，不删除文件、不停止会话或任务；重新打开恢复缓存。刷新／退出原型仍会丢失内存，请先保存需要的内容。</p>`, `<button class="btn" data-act="close-dialog">取消，保留 Tab</button><button class="btn primary" data-act="close-window-confirm" data-id="${esc(id)}">保留状态并关闭 Tab</button>`, "modal-sm"));
      return;
    }
    // Do not invoke the legacy no-draft branch: it stops an Office run as a side effect.
    if (!skipOfficeGuard && window.Office && D.projects.find(p => p.id === w.refId)?.kind === "work" && window.Office.model.dirtyFiles(w.refId).length && !window.Office.beforeClose(id)) return;
    objectViews.set(id, w.viewStates);
    const idx = store.windows.findIndex(x => x.id === id);
    store.windows.splice(idx, 1);
    if (store.active === id) {
      const next = store.windows[Math.max(0, idx - 1)] || store.windows[0];
      store.active = next.id;
      if (window.OfficeAI) window.OfficeAI.activate(next);
      applyView(next); renderedWindowId = null; restoreView = true;
    }
    render();
  }
  function windowControl(action) {
    if (action === "maximize") store.windowState = store.windowState === "maximized" ? "normal" : "maximized";
    else if (action === "minimize") store.windowState = "minimized";
    else if (action === "restore") store.windowState = "normal";
    else if (action === "close") store.windowState = "closed";
    render();
    toast("窗口" + ({ minimized: "最小化", maximized: "最大化", closed: "关闭", normal: "还原" }[store.windowState]) + "（仅原型仿真，不操作浏览器）", "info");
  }

  function topContext() {
    const w = activeWindow();
    if (w.kind === "home") return store.homePage === "knowledge" ? "知识库" : store.homePage === "servers" ? "服务器管理" : store.homePage === "projects" ? "项目管理" : "工作台";
    if (w.kind === "project") { const p = D.projects.find(x => x.id === w.refId); return p ? "项目管理 / " + p.name : "项目"; }
    if (w.kind === "library") { const l = D.knowledge.libraries.find(x => x.id === w.refId); return l ? "知识库 / " + l.name : "知识库"; }
    if (w.kind === "server") return "服务器管理";
    return "工作台";
  }
  function navItem(page, iconName, label, count) {
    const active = store.active === "home" && store.homePage === page;
    return `<button class="nav-item ${active ? "active" : ""}" data-act="nav" data-page="${page}">${icon(iconName)}<span class="label">${label}</span>${count != null && count !== "" ? `<span class="count">${count}</span>` : ""}</button>`;
  }
  function topbar() {
    const dark = store.theme === "dark";
    return `<header class="topbar" data-window-state="${esc(store.windowState)}">
      ${activeWindow().kind === "home" ? `<button class="icon-btn nav-toggle" data-act="nav-toggle" aria-label="管理导航">${icon("menu")}</button>` : ""}
      <div class="brand"><span class="brand-mark"><img src="../brand-assets-v2/logo-sail.png" alt=""></span>
        <span class="brand-copy"><b>栖造</b><span>NESTCRAFT</span></span></div>
      <span class="top-sep"></span>
      <div class="top-context"><span class="chip-workspace">${icon("grid", "ico-14")} 个人工作台</span><span class="muted">/</span><span>${esc(topContext())}</span></div>
      <div class="top-spacer window-drag-guide" data-act="window-drag-guide" title="窗口拖动热区（浏览器原型只展示引导；双击模拟最大化／还原）" aria-label="窗口拖动热区"><span>拖动窗口 · 仿真</span></div>
      <div class="top-actions">
        <button class="searchbox" data-act="search-focus">${icon("search", "ico-14")}<span>搜索项目、需求、文档</span><kbd>Ctrl K</kbd></button>
        <button class="icon-btn" data-act="theme" title="切换主题">${icon(dark ? "sun" : "moon")}</button>
        <button class="icon-btn" data-act="notify" title="通知">${icon("bell")}</button>
        <button class="avatar" data-act="open-settings" title="${esc(D.user.name)}">${esc(D.user.initials)}</button>
      </div>
      <span class="top-sep window-sep"></span>
      <div class="window-controls" aria-label="窗口控制（仿真）">
        <button class="window-control" data-act="window-minimize" title="最小化（仿真）" aria-label="最小化（仿真）">${icon("minimize")}</button>
        <button class="window-control" data-act="window-maximize" title="${store.windowState === "maximized" ? "还原" : "最大化"}（仿真）" aria-label="${store.windowState === "maximized" ? "还原" : "最大化"}（仿真）">${icon(store.windowState === "maximized" ? "restore" : "maximize")}</button>
        <button class="window-control window-close" data-act="window-close" title="关闭窗口（仿真）" aria-label="关闭窗口（仿真）">${icon("close")}</button>
      </div>
    </header>`;
  }
  function sidebar() {
    const p = D.projects.find(x => x.id === store.projectId) || D.projects[0];
    const running = D.tasks.filter(t => t.status === "running" || t.status === "verifying").length;
    return `<aside class="sidebar">
      <div class="nav-group">
        <div class="nav-label">工作空间</div>
        ${navItem("workbench", "home", "工作台")}
        ${navItem("projects", "folder", "项目管理", D.projects.length)}
        ${navItem("knowledge", "book", "知识库", D.knowledge.libraries.length)}
        ${navItem("servers", "server", "服务器管理", D.servers.length)}
      </div>
      <div class="nav-group">
        <div class="nav-label">当前项目</div>
        <button class="side-project" data-act="open-project" data-id="${p.id}">
          <span class="p-avatar proj-avatar ${p.tone}">${esc(p.key.slice(0, 2))}</span>
          <span class="p-meta"><b>${esc(p.name)}</b><span>${esc(p.branch || "工作区")}</span></span>
        </button>
      </div>
      <div class="nav-group">
        <div class="nav-label">快捷入口</div>
        ${navItem("tasks", "play", "运行队列", running)}
        ${navItem("design", "layers", "设计资料")}
      </div>
      <div class="side-foot">
        <button class="side-user merged" data-act="open-settings" title="设置与账户">
          <span class="avatar teal">${esc(D.user.initials)}</span>
          <span class="u-meta"><b>${esc(D.user.name)}</b><span>${esc(D.user.role)} · 设置与账户</span></span>
          <span class="u-gear">${icon("settings", "ico-14")}</span>
        </button>
      </div>
    </aside>`;
  }
  function tabbar() {
    const home = store.windows.find(w => w.id === "home");
    const tabs = [home, ...store.windows.filter(w => w.kind !== "home")].filter(Boolean);
    return `<nav class="tabbar" aria-label="首页与打开的对象">
      ${tabs.map(w => {
        const label = w.id === "home" ? "首页" : (w.title || w.refId);
        return `<div class="wtab ${w.id === "home" ? "home-tab" : "object-tab"} ${store.active === w.id ? "active" : ""}">
          <button class="wtab-focus" data-act="switch-window" data-id="${esc(w.id)}" aria-current="${store.active === w.id ? "page" : "false"}" title="${esc(label)}${w.reopened ? " · 已恢复对象视图" : ""}">${icon(w.id === "home" ? "home" : w.kind === "project" ? "folder" : w.kind === "library" ? "book" : "server", "ico-14")}<span class="ellipsis">${esc(label)}</span></button>
          ${w.id === "home" ? "" : `<button class="w-close" data-act="close-window" data-id="${esc(w.id)}" aria-label="关闭 ${esc(label)}">${icon("close", "ico-14")}</button>`}
        </div>`;
      }).join("")}
    </nav>`;
  }

  function openDialog(html, cls) {
    const dlg = $("#dialog");
    const marker = /data-dialog-class="([^"]*)"/.exec(html || "");
    dlg.className = (cls && cls.trim()) || (marker && marker[1]) || "";
    dlg.innerHTML = html;
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
  }
  function closeDialog() { const dlg = $("#dialog"); if (dlg.open) dlg.close(); else dlg.removeAttribute("open"); dlg.innerHTML = ""; store.reqMenu = null; }
  function openSubDialog(html, cls) {
    const dlg = $("#dialog2");
    const marker = /data-dialog-class="([^"]*)"/.exec(html || "");
    dlg.className = "sub-dialog " + ((cls && cls.trim()) || (marker && marker[1]) || "");
    dlg.innerHTML = html;
    if (!dlg.open) dlg.showModal();
  }
  function closeSubDialog() { const dlg = $("#dialog2"); if (dlg.open) dlg.close(); dlg.innerHTML = ""; }
  function closeTopDialog() { const sub = $("#dialog2"), main = $("#dialog"); if (sub && sub.open) closeSubDialog(); else if (main.open) closeDialog(); }
  const dlgShell = (title, sub, body, footer, cls) => `<span data-dialog-class="${esc(cls || "")}" hidden></span><div class="dlg-h"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div><button class="icon-btn" data-act="close-dialog">${icon("x")}</button></div>
    <div class="dlg-b">${body}</div>${footer ? `<div class="dlg-f">${footer}</div>` : ""}`;

  function render() {
    const ae = document.activeElement;
    const focusId = ae && ae.id ? ae.id : null;
    const selStart = focusId && ae.selectionStart != null ? ae.selectionStart : null;
    const content = $(".content");
    const scrollTop = content ? content.scrollTop : 0;
    const win = activeWindow();
    if (renderedWindowId === win.id) captureView(win, true);
    if (window.OfficeAI) window.OfficeAI.activate(win);
    const screens = window.Screens || {};
    let main = "";
    if (win.kind === "home") main = screens.home ? screens.home(store.homePage) : "";
    else if (win.kind === "project") main = screens.project ? screens.project(win.refId) : "";
    else if (win.kind === "library") main = screens.library ? screens.library(win.refId) : "";
    else if (win.kind === "server") main = screens.server ? screens.server(win.refId) : "";
    const isOffice = win.kind === "project" && D.projects.find(p => p.id === win.refId)?.kind === "work" && Boolean(window.Office);
    const showAI = win.kind === "project" && (isOffice ? window.Office.isOpen(win.refId) : store.aiOpen);
    if (window.Office) window.Office.onRender(isOffice);
    document.body.classList.toggle("ai-open", showAI);
    document.body.classList.toggle("object-detail", win.kind !== "home");
    if (win.kind !== "home") document.body.classList.remove("nav-open");
    $("#app").innerHTML = topbar() + tabbar() +
      `<div class="body">${win.kind === "home" ? sidebar() : ""}<div class="main"><div class="workarea"><div class="content ${win.kind === "project" ? "workspace" : ""}" id="content">${main}</div>${showAI && window.AIPanel ? AIPanel.render() : ""}</div></div></div>` +
      (["minimized", "closed"].includes(store.windowState) ? `<div class="window-simulation" role="status"><b>${store.windowState === "closed" ? "窗口已模拟关闭" : "窗口已模拟最小化"}</b><span>浏览器、对象状态与任务均未关闭</span><button class="btn primary" data-act="window-restore">${icon("restore", "ico-14")}还原原型</button></div>` : "");
    const newContent = $("#content");
    if (newContent) newContent.scrollTop = restoreView ? (win.viewStates?.scroll?.["#content"]?.[0] || 0) : scrollTop;
    if (restoreView) Object.entries(win.viewStates?.scroll || {}).forEach(([sel, pos]) => { const el = $(sel); if (el) { el.scrollTop = pos[0]; el.scrollLeft = pos[1]; } });
    if (store.designEdit && store.designDraft != null && $("#design-editor")) $("#design-editor").value = store.designDraft;
    if (win.kind === "server" && $("#term-input")) $("#term-input").value = store.termInput || "";
    renderedWindowId = win.id; restoreView = false;
    captureView(win, false);
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { /* noop */ } } }
    if (window.AIPanel && window.AIPanel.afterRender) window.AIPanel.afterRender();
    const oldMenu = document.getElementById("req-menu");
    if (oldMenu) oldMenu.remove();
    if (store.reqMenu && window.Screens && Screens.reqMenuHtml) document.body.insertAdjacentHTML("beforeend", Screens.reqMenuHtml());
    if (store.aiMenu) renderAIMenu();
  }

  function renderReqMenu() {
    const host = document.getElementById("req-menu");
    if (host) host.outerHTML = window.Screens.reqMenuHtml();
  }
  function renderAIMenu() {
    const host = document.getElementById("ai-menu");
    if (host) host.outerHTML = window.AIPanel.menuHtml();
  }

  return { D, $, $$, esc, icon, iconNames: Object.keys(P), iconAliases, cliLogo, fileIcon, md, toc, store, render, openWindow, switchWindow, closeWindow, windowControl, activeWindow, toast, openDialog, openSubDialog, closeDialog, closeSubDialog, closeTopDialog, dlgShell, renderReqMenu, renderAIMenu };
})();





