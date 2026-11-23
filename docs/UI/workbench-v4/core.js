/* 核心：状态、图标、Markdown、外壳、窗口与弹层。纯设计稿仿真，不联网、不调用真实 CLI。 */
window.UI = (function () {
  "use strict";
  /* CR-051 规则 6：file:// 直接打开原型时外部 sprite 的 <use> 整片失效（现状截图已证实）。
     按设计说明的「内联 sprite」实施方式，这里注入与 icon-sprite.svg 同步的内联副本，
     icon() 改用同文档引用（#id），http 与 file:// 下都可见。
     icon-sprite.svg 仍是唯一维护来源；修改符号后必须重新生成本段
     （本段来源 hash：dc7f286bc750，与 UI-CR051 原型同步记录一致）。 */
  const SPRITE_INLINE = `<title>UI-ICON-001-v1</title>
<symbol id="home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/></symbol>
<symbol id="grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
<symbol id="folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.5l2 2H19a2 2 0 0 1 2 2v8.8A2.2 2.2 0 0 1 18.8 20H5.2A2.2 2.2 0 0 1 3 17.8z"/></symbol>
<symbol id="folderOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.5l2 2H19a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-2.2 8.2A2 2 0 0 1 16.9 20H5.2A2.2 2.2 0 0 1 3 17.8z"/></symbol>
<symbol id="book" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.2A2.2 2.2 0 0 1 6.2 17H20"/><path d="M6.2 2H20v20H6.2A2.2 2.2 0 0 1 4 19.8V4.2A2.2 2.2 0 0 1 6.2 2z"/></symbol>
<symbol id="server" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></symbol>
<symbol id="settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/></symbol>
<symbol id="search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
<symbol id="plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12M18 6 6 18"/></symbol>
<symbol id="chevronDown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="chevronRight" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></symbol>
<symbol id="chevronLeft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></symbol>
<symbol id="chevronUp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></symbol>
<symbol id="arrowLeft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></symbol>
<symbol id="arrowUp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></symbol>
<symbol id="play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13l10.5-6.5z"/></symbol>
<symbol id="pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5v14M15 5v14"/></symbol>
<symbol id="refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5A8 8 0 1 0 18 17"/><path d="M20 4v7.5h-7.5"/></symbol>
<symbol id="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></symbol>
<symbol id="alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4.5M12 17h.01"/><path d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></symbol>
<symbol id="clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
<symbol id="user" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></symbol>
<symbol id="users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M18 21a6.5 6.5 0 0 0-2-4.7"/></symbol>
<symbol id="sparkles" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8z"/><path d="M18.5 15.5 19.2 17l1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z"/></symbol>
<symbol id="terminal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 17 6-5-6-5"/><path d="M12.5 19H20"/></symbol>
<symbol id="file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></symbol>
<symbol id="fileText" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></symbol>
<symbol id="filePdf" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13.5h2a1.5 1.5 0 0 1 0 3h-2zM13.5 13.5h1.2a2 2 0 0 1 0 4h-1.2z"/></symbol>
<symbol id="fileSheet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h8M11 13v4M14 13v4"/></symbol>
<symbol id="image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></symbol>
<symbol id="csv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h3M8 17h3M14 13h2M14 17h2"/></symbol>
<symbol id="git" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8" r="2.6"/><path d="M6 8.6v6.8M18 10.6v1a4.4 4.4 0 0 1-4.4 4.4H8.6"/></symbol>
<symbol id="code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/></symbol>
<symbol id="database" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></symbol>
<symbol id="layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></symbol>
<symbol id="cpu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2"/></symbol>
<symbol id="send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.8 21l-4.3-7.5L3 9.2z"/></symbol>
<symbol id="paperclip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m20.5 12.5-8.2 8.2a4.8 4.8 0 0 1-6.8-6.8l8.2-8.2a3.2 3.2 0 0 1 4.6 4.6l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.3-7.3"/></symbol>
<symbol id="panelRight" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></symbol>
<symbol id="panelLeft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></symbol>
<symbol id="history" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13.5" height="16" rx="2.5"/><path d="M6.5 8.5h6.5M6.5 12h6.5M6.5 15.5h4"/><path d="M20.5 7.5v9.5a3 3 0 0 1-3 3H6.5"/></symbol>
<symbol id="gauge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5.2-3.6"/><circle cx="12" cy="12" r="1.6"/></symbol>
<symbol id="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="bulb" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8V16h7.2v-2.2A6 6 0 0 0 12 3z"/></symbol>
<symbol id="steps" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 5.6 1.4 1.4L7.4 4.5"/><circle cx="4.6" cy="12" r="1.2"/><circle cx="4.6" cy="18" r="1.2"/></symbol>
<symbol id="dots" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></symbol>
<symbol id="edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
<symbol id="trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></symbol>
<symbol id="filter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18M6.5 12h11M10 19h4"/></symbol>
<symbol id="download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></symbol>
<symbol id="upload" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/></symbol>
<symbol id="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></symbol>
<symbol id="key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 3h4v4"/></symbol>
<symbol id="external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></symbol>
<symbol id="box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></symbol>
<symbol id="link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></symbol>
<symbol id="bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></symbol>
<symbol id="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2 12h2M20 12h2M4.5 19.5 6 18M18 6l1.5-1.5"/></symbol>
<symbol id="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></symbol>
<symbol id="branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></symbol>
<symbol id="stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></symbol>
<symbol id="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
<symbol id="globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></symbol>
<symbol id="zap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></symbol>
<symbol id="inbox" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13 6 5h12l2 8"/><path d="M4 13v6h16v-6h-5l-1.5 3h-3L9 13z"/></symbol>
<symbol id="list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></symbol>
<symbol id="target" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/></symbol>
<symbol id="message" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 18-4z"/></symbol>
<symbol id="more" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></symbol>
<symbol id="menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
<symbol id="drag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/></symbol>
<symbol id="sliders" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/></symbol>
<symbol id="bookOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v14c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-14c-4.5 0-6.5.5-8 2z"/><path d="M12 6.5v14"/></symbol>
<symbol id="printer" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 16h10v5H7z"/></symbol>
<symbol id="minimize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></symbol>
<symbol id="maximize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1"/></symbol>
<symbol id="restore" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5V3h12v12h-2"/><rect x="3" y="9" width="12" height="12" rx="1"/></symbol>
<symbol id="close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12M18 6 6 18"/></symbol>
<symbol id="error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 8 8 8M16 8l-8 8"/></symbol>
<symbol id="info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></symbol>
<symbol id="help" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/></symbol>
<symbol id="copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></symbol>
<symbol id="save" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h13l4 4v14H3V3z"/><path d="M7 3v6h9V3M7 21v-8h10v8"/></symbol>
<symbol id="undo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/></symbol>
<symbol id="redo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/></symbol>
<symbol id="arrowRight" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-7-7 7 7-7 7"/></symbol>
<symbol id="arrowDown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14m-7-7 7 7 7-7"/></symbol>
<symbol id="folderPlus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5h6l2 2h10v13H3zM12 10v7m-3-3.5h6"/></symbol>
<symbol id="filePlus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5M12 11v7m-3-3.5h6"/></symbol>
<symbol id="fileWord" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5M8 12l2 6 2-5 2 5 2-6"/></symbol>
<symbol id="fileSlides" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><rect x="8" y="12" width="8" height="6" rx="1"/></symbol>
<symbol id="fileCode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5m-9 4-2 3 2 3m4-6 2 3-2 3"/></symbol>
<symbol id="fileArchive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5M10 3v9m-1 0h2v5H9z"/></symbol>
<symbol id="filterOff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18M7 12h10M10 19h4M3 3l18 18"/></symbol>
<symbol id="sort" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16m-3-3 3 3 3-3M13 5h8M13 10h6M13 15h4"/></symbol>
<symbol id="expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/></symbol>
<symbol id="collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6"/></symbol>
<symbol id="layout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></symbol>
<symbol id="atDesk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="5" r="2.3"/><path d="M8.5 7.6v5.4M8.5 9.4h4.2M5.6 13h6.2"/><rect x="13" y="9" width="6.6" height="5" rx=".9"/><path d="M16.3 14v2M3.5 16h17M5.5 16v3M18.5 16v3"/></symbol>
<symbol id="alignLeft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16M8 6h12M8 12h8M8 18h12"/></symbol>
<symbol id="alignCenter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4 6h16M7 12h10M4 18h16"/></symbol>
<symbol id="alignRight" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v16M4 6h12M8 12h8M4 18h12"/></symbol>
<symbol id="palette" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3-4-6-9-6z"/><path d="M7 8h.01M12 6h.01M17 8h.01M6 13h.01"/></symbol>
<symbol id="checkCircle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/></symbol>
<symbol id="loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 1-9 9"/></symbol>
<symbol id="shieldCheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM8 12l3 3 5-6"/></symbol>
<symbol id="unlock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2.6"/></symbol>
<symbol id="gitMerge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><circle cx="18" cy="20" r="2"/><path d="M18 6v12M6 6v3a7 7 0 0 0 7 7h5"/></symbol>
<symbol id="gitCommit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/></symbol>
<symbol id="command" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2z"/></symbol>
<symbol id="workflow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9"/></symbol>
<symbol id="bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="14" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 17h8"/></symbol>
<symbol id="wrench" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4a6 6 0 0 0-7 8L3 17a2.8 2.8 0 0 0 4 4l5-5a6 6 0 0 0 8-7l-4 4-5-5z"/></symbol>
<!-- CR-051 新增符号（7）：24×24、1.6px 描边、round cap/join，与设计稿 icon-system 内联 sprite path 一致。 -->
<symbol id="fileMarkdown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="m7.9 12.2 1.6 2.9 1.6-2.9 1.6 2.9 1.6-2.9"/><path d="M12 16.4v3.2M10.4 18 12 19.6l1.6-1.6"/></symbol>
<symbol id="fileHtml" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M9.6 12.6 7.6 15l2 2.4M14.4 12.6 16.4 15l-2 2.4M12.9 11.8l-1.8 6.4"/></symbol>
<symbol id="fileAudio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><circle cx="9.4" cy="17.6" r="1.6"/><circle cx="14.6" cy="16.4" r="1.6"/><path d="M11 17.6v-5.2l5.2-1.2v5.2"/></symbol>
<symbol id="fileVideo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M10 13v5l4.2-2.5z"/></symbol>
<symbol id="fileUnknown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M9.4 12.4h5.2v5.2H9.4z" stroke-dasharray="1.8 2.2"/></symbol>
<symbol id="briefcase" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.4" width="18" height="12.4" rx="2"/><path d="M9 7.4V6.2A2.2 2.2 0 0 1 11.2 4h1.6A2.2 2.2 0 0 1 15 6.2v1.2"/><path d="M3 12.6h18"/><path d="M10.4 12.6v2h3.2v-2"/></symbol>
<symbol id="library" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5h3.4v14.6H4zM9 4.5h3.4v14.6H9z"/><path d="m14.6 5.4 3.2.9-3 12.8-2.3-.6z"/><path d="M3 20.4h18"/></symbol>
  <symbol id="building" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3" width="15" height="18" rx="1.6"/><path d="M8.5 7h2M13.5 7h2M8.5 11h2M13.5 11h2M8.5 15h2M13.5 15h2M10 21v-3.5h4V21"/></symbol>
  <symbol id="calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8 13h2.5M13.5 13H16M8 17h2.5"/></symbol>
  <symbol id="clipboard" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3.2h6v1.3M8.5 10h7M8.5 14h7M8.5 18h4"/></symbol>
  <symbol id="presentation" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="18" height="11.5" rx="1.6"/><path d="M12 15v5M8 20.5l4-5.5 4 5.5"/><path d="m7 11 3-3 2.5 2 3.5-3.5"/></symbol>
  <symbol id="mail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4.2 7 7.8 5.8L19.8 7"/></symbol>
  <symbol id="idBadge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10.5" r="2"/><path d="M6.5 16a2.8 2.8 0 0 1 5 0M14 9.5h4M14 12.5h4M14 15.5h3"/></symbol>
  <symbol id="chartBar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><rect x="6" y="12" width="3" height="6" rx="0.8"/><rect x="10.5" y="8" width="3" height="10" rx="0.8"/><rect x="15" y="4" width="3" height="14" rx="0.8"/></symbol>
  <symbol id="chartLine" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m5 16 4.5-4 3.5 2 5.5-7"/><circle cx="19" cy="6.5" r="1.3"/></symbol>
  <symbol id="chartPie" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M14 3.4A9 9 0 0 1 20.6 10H14z"/></symbol>
  <symbol id="wallet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.2"/></symbol>
  <symbol id="receipt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/></symbol>
  <symbol id="cart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.2 10.5h10.6l2.2-8H6"/><circle cx="9.5" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/></symbol>
  <symbol id="tag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.4"/></symbol>
  <symbol id="scale" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M8 21h8M4 7h16"/><path d="M6 7 3 14h6zM18 7l3 7h-6z"/></symbol>
  <symbol id="megaphone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5A1.5 1.5 0 0 1 4.5 9H7l9-3.5v13L7 15H4.5A1.5 1.5 0 0 1 3 13.5z"/><path d="M7 15v3a2 2 0 0 0 4 0v-1.2M19 9.5a3 3 0 0 1 0 5"/></symbol>
  <symbol id="camera" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.6-2.2h6.8L17 8h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 8z"/><circle cx="12" cy="13.5" r="3.4"/></symbol>
  <symbol id="music" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="16.5" cy="16" r="2.4"/></symbol>
  <symbol id="video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="12.5" height="12" rx="2"/><path d="m15.5 10.8 5.5-2.8v7.8l-5.5-2.8z"/></symbol>
  <symbol id="mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></symbol>
  <symbol id="newspaper" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h13v15H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M17 8h2.5A1.5 1.5 0 0 1 21 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17"/><path d="M7 9h7M7 12h7M7 15h4"/></symbol>
  <symbol id="pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.2-1L19 8.2a2.1 2.1 0 0 0-3-3L5.2 16z"/><path d="m14.5 6.5 3 3M5.2 16 4 20"/></symbol>
  <symbol id="brush" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20c2.5 0 4-1.5 4-4l8-8 2 2-8 8c0 2.5-3.5 2-6 2z"/><path d="m16 6 2-2 2 2-2 2z"/></symbol>
  <symbol id="rocket" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c4 2.4 6 6.4 6 10.8L15 16H9l-3-2.2C6 9.4 8 5.4 12 3z"/><circle cx="12" cy="9.5" r="2"/><path d="m9 16-1.5 4.5L11 18M15 16l1.5 4.5L13 18"/></symbol>
  <symbol id="bug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 9a3.5 3.5 0 0 1 7 0v5a3.5 3.5 0 0 1-7 0z"/><path d="M8.5 11H5M19 11h-3.5M8.5 14H5M19 14h-3.5M7.5 8 5.5 6M16.5 8l2-2M7.5 18l-2 2M16.5 18l2 2"/></symbol>
  <symbol id="puzzle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v3a2 2 0 1 0 4 0V3h2v6h-3a2 2 0 1 0 0 4h3v8h-8v-3a2 2 0 1 0-4 0v3H3v-8h3a2 2 0 1 0 0-4H3V3h6z"/></symbol>
  <symbol id="flag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12.5l-2.2 4.5 2.2 4.5H5"/></symbol>
  <symbol id="compass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></symbol>
  <symbol id="flask" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.2 15h9.6"/></symbol>
  <symbol id="robot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 4v4M9 4h6"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M9.5 16.5h5"/></symbol>
  <symbol id="cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/></symbol>
  <symbol id="school" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-5 9 5-9 5z"/><path d="M7 11.5V17c0 1.5 2.2 2.5 5 2.5s5-1 5-2.5v-5.5M21 9v6"/></symbol>
  <symbol id="heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.3-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.7-7 9-7 9z"/></symbol>
  <symbol id="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></symbol>
  <symbol id="hand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.7-2.3L4 15.2a1.6 1.6 0 0 1 2.4-2.1L8 15"/></symbol>
<symbol id="sessionStats" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5h16"/><path d="M7.5 19.5v-6"/><path d="M12 19.5V8"/><path d="M16.5 19.5v-9"/></symbol>
<symbol id="tokenUsage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="6" width="15" height="12" rx="2"/><path d="M8 10h8"/><path d="M8 13.5h5"/></symbol>
<symbol id="contextUsage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="4.5" width="10" height="8" rx="1.5"/><path d="M4.5 9.5v6A1.5 1.5 0 0 0 6 17h8.5"/></symbol>
<symbol id="aiMark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 19 7.4 5l3.9 14"/><path d="M5.1 14.2h4.6"/><path d="M14.3 5h4.4"/><path d="M16.5 5v14"/><path d="M14.3 19h4.4"/></symbol>
<symbol id="aiBot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="7.5" width="15" height="10.5" rx="3"/><path d="M12 7.5V4.8"/><circle cx="12" cy="3.7" r="1"/><path d="M9.2 11.2v1.8"/><path d="M14.8 11.2v1.8"/><path d="M9.5 15.3h5"/></symbol>`;
  if (!document.getElementById("cr051-inline-sprite")) {
    document.body.insertAdjacentHTML("afterbegin",
      `<svg id="cr051-inline-sprite" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">${SPRITE_INLINE}</svg>`);
  }
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
    sessionStats: '<path d="M4 19.5h16"/><path d="M7.5 19.5v-6"/><path d="M12 19.5V8"/><path d="M16.5 19.5v-9"/>',
    tokenUsage: '<rect x="4.5" y="6" width="15" height="12" rx="2"/><path d="M8 10h8"/><path d="M8 13.5h5"/>',
    contextUsage: '<rect x="7" y="4.5" width="10" height="8" rx="1.5"/><path d="M4.5 9.5v6A1.5 1.5 0 0 0 6 17h8.5"/>',
    aiMark: '<path d="M3.5 19 7.4 5l3.9 14"/><path d="M5.1 14.2h4.6"/><path d="M14.3 5h4.4"/><path d="M16.5 5v14"/><path d="M14.3 19h4.4"/>',
    aiBot: '<rect x="4.5" y="7.5" width="15" height="10.5" rx="3"/><path d="M12 7.5V4.8"/><circle cx="12" cy="3.7" r="1"/><path d="M9.2 11.2v1.8"/><path d="M14.8 11.2v1.8"/><path d="M9.5 15.3h5"/>',
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
    atDesk: '<circle cx="8.5" cy="5" r="2.3"/><path d="M8.5 7.6v5.4M8.5 9.4h4.2M5.6 13h6.2"/><rect x="13" y="9" width="6.6" height="5" rx=".9"/><path d="M16.3 14v2M3.5 16h17M5.5 16v3M18.5 16v3"/>',
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
    wrench: '<path d="M14 4a6 6 0 0 0-7 8L3 17a2.8 2.8 0 0 0 4 4l5-5a6 6 0 0 0 8-7l-4 4-5-5z"/>',
    fileMarkdown: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="m7.9 12.2 1.6 2.9 1.6-2.9 1.6 2.9 1.6-2.9"/><path d="M12 16.4v3.2M10.4 18 12 19.6l1.6-1.6"/>',
    fileHtml: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M9.6 12.6 7.6 15l2 2.4M14.4 12.6 16.4 15l-2 2.4M12.9 11.8l-1.8 6.4"/>',
    fileAudio: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><circle cx="9.4" cy="17.6" r="1.6"/><circle cx="14.6" cy="16.4" r="1.6"/><path d="M11 17.6v-5.2l5.2-1.2v5.2"/>',
    fileVideo: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M10 13v5l4.2-2.5z"/>',
    fileUnknown: '<path d="M14 3H5v18h14V8l-5-5v5h5"/><path d="M9.4 12.4h5.2v5.2H9.4z" stroke-dasharray="1.8 2.2"/>',
    briefcase: '<rect x="3" y="7.4" width="18" height="12.4" rx="2"/><path d="M9 7.4V6.2A2.2 2.2 0 0 1 11.2 4h1.6A2.2 2.2 0 0 1 15 6.2v1.2"/><path d="M3 12.6h18"/><path d="M10.4 12.6v2h3.2v-2"/>',
    library: '<path d="M4 4.5h3.4v14.6H4zM9 4.5h3.4v14.6H9z"/><path d="m14.6 5.4 3.2.9-3 12.8-2.3-.6z"/><path d="M3 20.4h18"/>'
  };
  const iconIds = new Set([...SPRITE_INLINE.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  const iconAliases = { project: "folder", knowledge: "book", directory: "folder", fileExcel: "fileSheet", filePpt: "fileSlides", fileDoc: "fileWord", warning: "alert", success: "checkCircle", delete: "trash", externalLink: "external", windowMinimize: "minimize", windowMaximize: "maximize", windowRestore: "restore", windowClose: "close", markdown: "fileMarkdown", html: "fileHtml" };
  function icon(name, cls) {
    const canonical = iconIds.has(name) ? name : iconAliases[name];
    const missing = !canonical;
    return `<svg class="ico ${esc(cls || "")}${missing ? " icon-missing" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${missing ? `role="img" aria-label="缺失图标：${esc(name)}" data-missing-icon="${esc(name)}"` : 'aria-hidden="true"'}>${missing ? `<title>缺失图标：${esc(name)}</title>` : ""}<use href="#${canonical || "error"}"></use></svg>`;
  }
  /* 品牌标志资源版本：SVG 内容变更时递增，使浏览器缓存失效（避免旧画布尺寸继续生效）。 */
  const BRAND_ASSET_VERSION = { grok: 2 };
  function cliLogo(id, size) {
    const known = ["claude", "codex", "grok"].includes(id);
    const px = [14, 16, 18, 20, 24, 28, 32, 48].includes(Number(size)) ? Number(size) : 20;
    const status = known ? "官方资源加载中；失败标记未就绪" : id === "dsh" ? "无可核验的独立官方 CLI 标志 · not available" : "官方图标资源未就绪";
    const ver = BRAND_ASSET_VERSION[id] ? `?v=${BRAND_ASSET_VERSION[id]}` : "";
    return `<span class="cli-logo cli-brand ${known ? "asset-pending" : "asset-unavailable"}" style="width:${px}px;height:${px}px" title="${esc(id + " · " + status)}" aria-label="${esc(id + " · " + status)}" data-cli-brand="${esc(id)}">${known ? `<img src="./brand-icons/${id}.svg${ver}" alt="${esc(id)} 官方品牌标志" data-cli-asset="${esc(id)}">` : icon("error", "ico-14")}<span class="sr-only">${esc(status)}</span></span>`;
  }
  /* CR-051：扩展名 → 图标符号 + 类型色令牌（与 UI-CR051 §5.2 映射表唯一来源一致）。 */
  const FILE_TYPE_META = {
    md: { i: "fileMarkdown", c: "var(--fic-md)" }, markdown: { i: "fileMarkdown", c: "var(--fic-md)" }, mdx: { i: "fileMarkdown", c: "var(--fic-md)" },
    txt: { i: "fileText", c: "var(--fic-text)" }, log: { i: "fileText", c: "var(--fic-text)" }, ini: { i: "fileText", c: "var(--fic-text)" }, conf: { i: "fileText", c: "var(--fic-text)" }, rtf: { i: "fileText", c: "var(--fic-text)" },
    pdf: { i: "filePdf", c: "var(--fic-pdf)" },
    doc: { i: "fileWord", c: "var(--fic-word)" }, docx: { i: "fileWord", c: "var(--fic-word)" }, odt: { i: "fileWord", c: "var(--fic-word)" },
    xls: { i: "fileSheet", c: "var(--fic-sheet)" }, xlsx: { i: "fileSheet", c: "var(--fic-sheet)" }, ods: { i: "fileSheet", c: "var(--fic-sheet)" },
    csv: { i: "csv", c: "var(--fic-sheet)" }, tsv: { i: "csv", c: "var(--fic-sheet)" },
    ppt: { i: "fileSlides", c: "var(--fic-slides)" }, pptx: { i: "fileSlides", c: "var(--fic-slides)" }, odp: { i: "fileSlides", c: "var(--fic-slides)" },
    png: { i: "image", c: "var(--fic-image)" }, jpg: { i: "image", c: "var(--fic-image)" }, jpeg: { i: "image", c: "var(--fic-image)" }, gif: { i: "image", c: "var(--fic-image)" }, webp: { i: "image", c: "var(--fic-image)" }, svg: { i: "image", c: "var(--fic-image)" },
    ts: { i: "fileCode", c: "var(--fic-code)" }, js: { i: "fileCode", c: "var(--fic-code)" }, py: { i: "fileCode", c: "var(--fic-code)" }, json: { i: "fileCode", c: "var(--fic-code)" }, yaml: { i: "fileCode", c: "var(--fic-code)" }, yml: { i: "fileCode", c: "var(--fic-code)" }, css: { i: "fileCode", c: "var(--fic-code)" },
    html: { i: "fileHtml", c: "var(--fic-code)" }, htm: { i: "fileHtml", c: "var(--fic-code)" },
    zip: { i: "fileArchive", c: "var(--fic-archive)" }, "7z": { i: "fileArchive", c: "var(--fic-archive)" }, rar: { i: "fileArchive", c: "var(--fic-archive)" }, tar: { i: "fileArchive", c: "var(--fic-archive)" }, gz: { i: "fileArchive", c: "var(--fic-archive)" },
    mp3: { i: "fileAudio", c: "var(--fic-audio)" }, wav: { i: "fileAudio", c: "var(--fic-audio)" }, m4a: { i: "fileAudio", c: "var(--fic-audio)" }, flac: { i: "fileAudio", c: "var(--fic-audio)" },
    mp4: { i: "fileVideo", c: "var(--fic-video)" }, mov: { i: "fileVideo", c: "var(--fic-video)" }, mkv: { i: "fileVideo", c: "var(--fic-video)" }, webm: { i: "fileVideo", c: "var(--fic-video)" }
  };
  function fileMeta(type) {
    const t = String(type || "").toLowerCase().replace(/^\./, "");
    return FILE_TYPE_META[t] || { i: "fileUnknown", c: "var(--fic-unknown)" };
  }
  function fileIcon(type, cls) {
    const m = fileMeta(type);
    return `<svg class="ico ${esc(cls || "ico-14")}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:${m.c}" aria-hidden="true"><use href="#${m.i}"></use></svg>`;
  }
  /* CR-051：品牌帆船头像（5 种容器风格由 body[data-avatar-style] 承载）。
     r6：默认 B；store.avatarPhoto 有值时显示自定义照片（容器按当前风格，等比裁剪填充）。 */
  const AVATAR_IMG = "../brand-assets-v2/logo-sail.png";
  const AVATAR_LABELS = { a: "A 原彩透明", b: "B 薄荷承载", c: "C 圆角方砖", d: "D 墨青实底", e: "E 双色光环" };
  const avatarImg = (alt, photo) => {
    const p = photo === undefined ? (store && store.avatarPhoto) || null : photo;
    return p
      ? `<img src="${esc(p)}" alt="${esc(alt || "")}" class="has-photo" draggable="false">`
      : `<img src="${AVATAR_IMG}" alt="${esc(alt || "")}" draggable="false">`;
  };
  const avatarHtml = (cls, alt) => `<span class="avatar ${esc(cls || "")}${store && store.avatarPhoto ? " has-photo" : ""}">${avatarImg(alt, store && store.avatarPhoto)}</span>`;
  /* CR-051 r2/r6：项目与知识库共用 50 个图标（6 组）与 10 个背景色卡；旧 12/8 白名单值均为其子集，
     旧项目/旧库按既有 tone 原样显示，不做批量映射（手动切换后才写入新组合）。 */
  const ICON_GROUPS = [
    { name: "通用", hint: "类型 / 技术 / 资料 / 目标", icons: ["code", "terminal", "globe", "database", "layers", "box", "wrench", "gauge", "bulb", "target", "sparkles", "book", "bookOpen", "library", "shield", "users"] },
    { name: "办公", hint: "组织 / 计划 / 沟通", icons: ["briefcase", "building", "calendar", "clipboard", "presentation", "mail", "idBadge"] },
    { name: "商业", hint: "数据 / 财务 / 经营", icons: ["chartBar", "chartLine", "chartPie", "wallet", "receipt", "cart", "tag", "scale"] },
    { name: "内容", hint: "市场 / 媒体 / 创作", icons: ["megaphone", "camera", "music", "video", "mic", "newspaper", "pen", "brush"] },
    { name: "产品", hint: "研发 / 上线 / 探索", icons: ["rocket", "bug", "puzzle", "flag", "compass", "flask", "robot", "cloud"] },
    { name: "生活", hint: "学习 / 收藏 / 关怀", icons: ["school", "heart", "star"] }
  ];
  const PROJECT_ICON_IDS = ICON_GROUPS.flatMap(g => g.icons);
  const KB_ICON_IDS = PROJECT_ICON_IDS;
  const ICON_COLORS = [
    { id: "blue", soft: "#eaf1ff", strong: "#2b6cf6", darkSoft: "#1e2a44", darkStrong: "#8db3ff" },
    { id: "teal", soft: "#e8f7f3", strong: "#0b7d70", darkSoft: "#17302b", darkStrong: "#4fd1c5" },
    { id: "violet", soft: "#f0edfd", strong: "#6f5bd6", darkSoft: "#262238", darkStrong: "#b9a8ff" },
    { id: "amber", soft: "#fff4e2", strong: "#b76a00", darkSoft: "#2b2416", darkStrong: "#e0a04a" },
    { id: "green", soft: "#e7f8ef", strong: "#1a9d5a", darkSoft: "#16281d", darkStrong: "#4ccb83" },
    { id: "rose", soft: "#fdeef1", strong: "#c2345a", darkSoft: "#331a20", darkStrong: "#ff9ab0" },
    { id: "indigo", soft: "#eef0ff", strong: "#4356c9", darkSoft: "#1e2144", darkStrong: "#97a3ff" },
    { id: "orange", soft: "#fff0e6", strong: "#c2410c", darkSoft: "#331b12", darkStrong: "#f0906a" },
    { id: "slate", soft: "#eef1f5", strong: "#52627a", darkSoft: "#242a33", darkStrong: "#a7b6c8" },
    { id: "sand", soft: "#f8f1e3", strong: "#8a6420", darkSoft: "#2b2519", darkStrong: "#d8b06a" }
  ];
  const ICON_COLOR_LABELS = { blue: "蓝", teal: "青绿", violet: "紫", amber: "琥珀", green: "绿", rose: "玫瑰", indigo: "靛蓝", orange: "橘", slate: "石板", sand: "沙金" };
  const TONE_TILE = {
    blue: ["var(--tile-blue)", "var(--fic-project-code)"],
    violet: ["var(--tile-violet)", "var(--violet)"],
    amber: ["var(--tile-amber)", "var(--fic-project-work)"],
    green: ["var(--tile-green)", "var(--success)"]
  };
  function registeredIcon(id) { return id && iconIds.has(id) ? id : null; }
  function registeredColor(id) { return id && ICON_COLORS.some(c => c.id === id) ? id : null; }
  /** 色卡 id → [承载底, 图形色]（CSS 变量对，浅深主题各自取值）；未登记 id 返回 null。 */
  function iconColorPair(id) {
    const c = registeredColor(id);
    return c ? ["var(--c51c-" + c + "-soft)", "var(--c51c-" + c + "-strong)"] : null;
  }
  function projIconId(p) { return registeredIcon(p && p.icon) || (p && p.kind === "work" ? "briefcase" : "code"); }
  function projTile(p, cls, icoCls) {
    // r3：手动切换才写入 iconColor；旧项目（无 iconColor）沿用既有 tone 原样显示。
    const [bg, fg] = iconColorPair(p && p.iconColor) || TONE_TILE[(p && p.tone) || "blue"] || TONE_TILE.blue;
    return `<span class="proj-icon-tile ${esc(cls || "")}" style="background:${bg};color:${fg}" aria-hidden="true">${icon(projIconId(p), icoCls || "ico-20")}</span>`;
  }
  function kbIconId(lib, fallback) { return registeredIcon(lib && lib.icon) || fallback || "library"; }
  /** 知识库图标砖色卡：自选优先，未设置回默认青绿（色卡缺失回默认色，不允许只改底色）。 */
  function kbTileColor(lib) { return iconColorPair(lib && lib.iconColor) || iconColorPair("teal"); }

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
  // CR-046：更新徽标的设计演示状态。URL 参数 update=hidden|available|downloading|ready|applying 便于逐状态截图；
  // 缺省 available 让打开唯一入口即可看到「更新」入口并点按演示；显式 update=hidden 表示无可用更新、不占位。
  // 原型只仿真状态变化，不联网、不替换程序。
  const updateParam = new URLSearchParams(window.location.search).get("update");
  const themeParam = new URLSearchParams(window.location.search).get("theme");
  const avatarParam = new URLSearchParams(window.location.search).get("avatar");
  const updatePhaseList = ["available", "downloading", "ready", "applying"];
  const store = {
    theme: ["light", "dark"].includes(themeParam) ? themeParam : (localStorage.getItem("wb4-theme") || "light"),
    // CR-051：头像风格 a–e；r6 默认 B。URL 参数 avatar= 便于逐风格截图（演示用途）。
    avatarStyle: ["a", "b", "c", "d", "e"].includes(avatarParam) ? avatarParam : (localStorage.getItem("wb4-avatar-style") || "b"),
    avatarDraft: null,
    // r2：自定义头像照片（data URL，仅内存演示；正式软件存本机文件引用，不上传网络）。
    avatarPhoto: null,
    projectIconDraft: null,
    updatePhase: updateParam === "hidden" ? "hidden" : updatePhaseList.includes(updateParam) ? updateParam : "available",
    updateProgress: updateParam === "downloading" ? 42 : updateParam === "ready" ? 100 : 0,
    updateVersion: "0.2.0",
    updateTimer: null,
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
    /* CR-067：Git 面板演示状态（筛选、展开组、弹层、展开的提交）。 */
    gitBranchQuery: "",
    gitHistoryAuthor: "",
    gitHistoryBranch: "",
    gitHistoryRange: "all",
    gitOpenGroups: { local: true, remote: false },
    gitOpenCommit: null,
    gitCommitMenuOpen: false,
    gitAccelOpen: false,
    gitCredOpen: false,
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
    /** CR-059 r4：任务模型路由的单行折叠态与当前选中标签（`<cliId>` → bool / `fallback`|槽索引）。 */
    cliRouteOpen: {},
    cliRouteSel: {},
    skillDialog: null,
    mcpDialog: null,
    aiOpen: true,
    aiWidth: 372,
    aiHistory: false,
    /** CR-063：历史会话分批加载（每批 20 条）、全项目标题搜索与「全部」模式。 */
    aiHistLimit: 20,
    aiHistQuery: "",
    aiHistFocus: false,
    aiHistScroll: 0,
    /** CR-063：idle | first（首批加载中）| more（追加中）| search（搜索中）| error（失败）。 */
    aiHistState: "idle",
    /** CR-064：当前展开「…」菜单的会话 id；null 表示未展开。 */
    aiHistMenu: null,
    /** CR-064：正在原位重命名的会话 id 与输入值。 */
    aiHistEditId: null,
    aiHistEditValue: "",
    aiTop: null,
    /** CR-062：当前查看的子智能体 id；null 表示主会话视图。 */
    aiAgent: null,
    aiBgOpen: null,
    aiStepsOpen: false,
    aiModelQuery: "",
    aiMenu: null,
    aiMenuQuery: "",
    aiStats: null,
    aiMenuTab: "add",
    aiMessages: D.ai.sessions[0].messages.slice(),
    aiSession: D.ai.sessions[0].id,
    aiBusy: false,
    aiGen: 0,
    aiPermission: "默认模式",
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
  document.body.dataset.avatarStyle = store.avatarStyle;

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
    project: ["projectId", "projectTab", "selectedReq", "collapsed", "treeQuery", "designTab", "designEdit", "designDraft", "designToc", "taskId", "taskTreeCollapsed", "codeRail", "codeFile", "codeEdit", "codeDraft", "editingFile", "gitBranch", "gitMessage", "gitSection", "gitBranchQuery", "gitHistoryAuthor", "gitHistoryBranch", "gitHistoryRange", "gitOpenGroups", "gitOpenCommit", "officeDoc", "aiOpen", "aiHistory", "aiStepsOpen", "aiSession", "aiInput", "aiStick", "aiPermission", "aiCli"],
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
  /* ---------------- 更新徽标（CR-046） ---------------- */
  // 纯文字胶囊：更新 = 绿色，重启 = 橙色；下载中沿圆角边框生长进度，进度值来自 store.updateProgress。
  const UB = { w: 54, h: 22, pad: 1.4, radius: 5 };
  function updateRingPath() {
    const { w, h, pad, radius: r } = UB;
    const x0 = pad, y0 = pad, x1 = w - pad, y1 = h - pad, mid = (x0 + x1) / 2;
    return `M ${mid} ${y0} H ${x1 - r} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} V ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} H ${mid}`;
  }
  function updateRingPerimeter() {
    const { w, h, pad, radius: r } = UB;
    return 2 * (w - 2 * pad - 2 * r) + 2 * (h - 2 * pad - 2 * r) + 2 * Math.PI * r;
  }
  function updateBadge() {
    const phase = store.updatePhase;
    if (phase === "hidden") return "";
    const restart = phase === "ready" || phase === "applying";
    const busy = phase === "downloading" || phase === "applying";
    const pct = Math.max(0, Math.min(100, store.updateProgress || 0));
    const perimeter = updateRingPerimeter();
    const label = restart ? "重启" : "更新";
    const title = phase === "available" ? `发现新版本 v${store.updateVersion}，点击下载`
      : phase === "downloading" ? `正在下载更新 ${Math.round(pct)}%`
      : phase === "ready" ? "更新已下载并通过校验，点击重启并安装"
      : "正在重启并安装更新…";
    const aria = phase === "available" ? `发现新版本 v${store.updateVersion}，点击下载更新`
      : phase === "downloading" ? "正在下载更新"
      : phase === "ready" ? "更新已就绪，点击重启并安装"
      : "正在重启并安装更新";
    return `<button class="update-badge" data-act="update" data-phase="${phase}" title="${esc(title)}" aria-label="${esc(aria)}"${busy ? ' disabled aria-busy="true"' : ""}>
      <span class="ub"><svg class="ub-frame" viewBox="0 0 ${UB.w} ${UB.h}" aria-hidden="true"><path class="ub-track" d="${updateRingPath()}"/><path class="ub-bar" d="${updateRingPath()}" style="stroke-dasharray:${perimeter.toFixed(2)};stroke-dashoffset:${(perimeter * (1 - pct / 100)).toFixed(2)}"/></svg>
      <span class="ub-lb">${label}</span><span class="ub-loading" aria-hidden="true"><span class="ub-spinner"></span></span></span>
    </button>`;
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
        ${updateBadge()}
        <button class="icon-btn" data-act="theme" title="切换主题">${icon(dark ? "sun" : "moon")}</button>
        <button class="icon-btn" data-act="notify" title="通知">${icon("bell")}</button>
        <span class="avatar-frame top-avatar">
          <button class="avatar" data-act="open-settings" title="${esc(D.user.name)}" aria-label="用户头像，打开设置">${avatarImg()}</button>
          <button class="avatar-edit" type="button" data-act="avatar-edit" aria-label="更换头像" title="更换头像">${icon("camera", "ico-14")}</button>
        </span>
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
          ${projTile(p, "sm", "ico-14")}
          <span class="p-meta"><b>${esc(p.name)}</b><span>${esc(p.branch || "工作区")}</span></span>
        </button>
      </div>
      <div class="nav-group">
        <div class="nav-label">快捷入口</div>
        ${navItem("tasks", "play", "运行队列", running)}
        ${navItem("design", "layers", "设计资料")}
      </div>
      <div class="side-foot">
        <span class="avatar-frame side-avatar">
          <button class="side-user merged" data-act="open-settings" title="设置与账户">
            <span class="avatar">${avatarImg()}</span>
            <span class="u-meta"><b>${esc(D.user.name)}</b><span>${esc(D.user.role)}</span></span>
            <span class="u-gear">${icon("settings", "ico-14")}</span>
          </button>
          <button class="avatar-edit" type="button" data-act="avatar-edit" aria-label="更换头像" title="更换头像">${icon("camera", "ico-14")}</button>
        </span>
      </div>
    </aside>`;
  }
  /* UI-CR050（方案 E）：窗口页签条按需出现。
     只有首页、没有打开对象时不渲染整条；打开对象后在内容区顶部出现 40px 胶囊条，
     首页与对象同规格，末尾「全部窗口」下拉兜底溢出；首页固定不可关闭。 */
  function tabbar() {
    const home = store.windows.find(w => w.id === "home");
    const objects = store.windows.filter(w => w.kind !== "home");
    if (!home || !objects.length) return "";
    const tab = (w, isHome) => {
      const label = isHome ? "首页" : (w.title || w.refId);
      const iconName = isHome ? "home" : w.kind === "project" ? "folder" : w.kind === "library" ? "book" : "server";
      const current = store.active === w.id;
      return `<div class="wtab ${isHome ? "home-tab" : "object-tab"} ${current ? "active" : ""}" role="presentation">
        <button class="wtab-focus" data-act="switch-window" data-id="${esc(w.id)}" role="tab" aria-selected="${current}" aria-current="${current ? "page" : "false"}" title="${esc(label)}${w.reopened ? " · 已恢复对象视图" : ""}">${icon(iconName, "ico-14")}<span class="ellipsis">${esc(label)}</span></button>
        ${isHome ? "" : `<button class="w-close" data-act="close-window" data-id="${esc(w.id)}" aria-label="关闭 ${esc(label)}">${icon("close", "ico-12")}</button>`}
      </div>`;
    };
    return `<nav class="tabbar" aria-label="窗口页签">
      ${tab(home, true)}
      <span class="wtab-sep" aria-hidden="true"></span>
      ${objects.map(w => tab(w, false)).join("")}
      <button class="tabbar-all" data-act="window-tabs-menu" aria-haspopup="menu" aria-expanded="false" title="全部窗口">
        ${icon("layers", "ico-14")}<span class="tabbar-all-label">全部窗口</span><span class="tabbar-all-n">${objects.length + 1}</span>
      </button>
    </nav>`;
  }

  function openDialog(html, cls) {
    const dlg = $("#dialog");
    const marker = /data-dialog-class="([^"]*)"/.exec(html || "");
    dlg.className = (cls && cls.trim()) || (marker && marker[1]) || "";
    dlg.innerHTML = html;
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
    if (window.PaneResize) window.PaneResize.afterRender();
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
    const selEnd = selStart != null ? ae.selectionEnd : null;
    const selDirection = selStart != null ? ae.selectionDirection : null;
    const editorScroll = selStart != null ? [ae.scrollTop, ae.scrollLeft] : null;
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
    /* CR-054：工作台需要借用 AI 侧栏承载 CLI/权限/模型/添加 浮层（浮层锚点在 .ai-panel 内），
       此时即使 aiOpen=false 也要渲染面板；由 ai.css 的 wb-borrow-ai 规则只显示浮层所需部分。 */
    const wbBorrow = win.kind === "project" && store.projectTab === "workbench" && Boolean(store.aiPop || store.aiMenu);
    const showAI = win.kind === "project" && (isOffice ? window.Office.isOpen(win.refId) : (store.aiOpen || wbBorrow));
    if (window.Office) window.Office.onRender(isOffice);
    document.body.classList.toggle("ai-open", showAI);
    document.body.classList.toggle("object-detail", win.kind !== "home");
    if (win.kind !== "home") document.body.classList.remove("nav-open");
    const windowTabs = tabbar();
    document.body.classList.toggle("has-window-tabs", Boolean(windowTabs));
    document.body.classList.toggle("no-window-tabs", !windowTabs);
    $("#app").innerHTML = topbar() +
      `<div class="body">${win.kind === "home" ? sidebar() : ""}<div class="main">${windowTabs}<div class="workarea"><div class="content ${win.kind === "project" ? "workspace" : ""}" id="content">${main}</div>${showAI && window.AIPanel ? AIPanel.render() : ""}</div></div></div>` +
      (["minimized", "closed"].includes(store.windowState) ? `<div class="window-simulation" role="status"><b>${store.windowState === "closed" ? "窗口已模拟关闭" : "窗口已模拟最小化"}</b><span>浏览器、对象状态与任务均未关闭</span><button class="btn primary" data-act="window-restore">${icon("restore", "ico-14")}还原原型</button></div>` : "");
    const newContent = $("#content");
    if (newContent) newContent.scrollTop = restoreView ? (win.viewStates?.scroll?.["#content"]?.[0] || 0) : scrollTop;
    if (restoreView) Object.entries(win.viewStates?.scroll || {}).forEach(([sel, pos]) => { const el = $(sel); if (el) { el.scrollTop = pos[0]; el.scrollLeft = pos[1]; } });
    if (store.designEdit && store.designDraft != null && $("#design-editor")) $("#design-editor").value = store.designDraft;
    if (win.kind === "server" && $("#term-input")) $("#term-input").value = store.termInput || "";
    renderedWindowId = win.id; restoreView = false;
    captureView(win, false);
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (editorScroll && typeof el.setSelectionRange === "function") {
          try { el.setSelectionRange(selStart, selEnd, selDirection); } catch { /* input type does not support selection */ }
          [el.scrollTop, el.scrollLeft] = editorScroll;
        }
      }
    }
    if (window.PaneResize) window.PaneResize.afterRender();
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

  return { D, $, $$, esc, icon, iconNames: [...iconIds], iconAliases, cliLogo, fileIcon, fileMeta, avatarImg, avatarHtml, AVATAR_LABELS, projIconId, projTile, kbIconId, kbTileColor, iconColorPair, registeredIcon, registeredColor, ICON_GROUPS, ICON_COLORS, ICON_COLOR_LABELS, PROJECT_ICON_IDS, KB_ICON_IDS, md, toc, store, render, openWindow, switchWindow, closeWindow, windowControl, activeWindow, toast, openDialog, openSubDialog, closeDialog, closeSubDialog, closeTopDialog, dlgShell, renderReqMenu, renderAIMenu };
})();





