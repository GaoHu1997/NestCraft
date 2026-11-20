/* CR-014 外壳：PingCode 风格白蓝主题、全局导航常驻、知识库三栏、服务器工作台。
   载入顺序：index.html 内联脚本 → cr014-project.js → cr014-settings.js → 本文件。 */
(() => {
 'use strict';
 if (window.__cr014ShellLoaded) return;
 if (typeof render !== 'function' || typeof state === 'undefined') return;
 window.__cr014ShellLoaded = true;

 const icon = k => (typeof ic === 'function' ? ic(k) : '');
 const isGlobalPage = r => r.page === 'projects' || r.page === 'servers' || (r.page === 'knowledge' && !r.libraryId);

 /* ── 全局导航：列表页常驻，只有进入项目/知识库/主机内部才换成局部页面 ── */
 function sidebar(active) {
  return `<aside class="sidebar" data-global-navigation>
   <a class="brand" href="#projects"><span class="brandmark">${icon('agent')}</span><span>Agent 工作台<small>个人工作区</small></span></a>
   <div class="nav-label">工作区</div>
   <nav class="nav" aria-label="工作区">${navLink('项目管理', 'projects', 'folder', active === 'projects')}${navLink('知识库', 'knowledge', 'book', active === 'knowledge')}${navLink('服务器管理', 'servers', 'server', active === 'servers')}</nav>
   <div class="sidefoot"><button type="button" class="profile-entry" data-action="open-settings" aria-haspopup="dialog" aria-label="设置与账户"><span class="avatar">林</span><span class="profile-text"><strong>林澈</strong><small>本地演示 · 设置</small></span>${icon('settings')}</button></div>
  </aside>`;
 }

 function topBar(r) {
  const parent = r.p ? 'projects' : r.s ? 'servers' : r.libraryId ? 'knowledge' : '';
  const back = parent ? `<a class="cr014-back" data-parent-route="${parent}" href="#${parent}">${icon('back')}返回${r.p ? '项目列表' : r.s ? '服务器列表' : '知识库列表'}</a>` : '';
  const name = r.p?.name ?? r.s?.name ?? (r.libraryId ? (state.libraries.find(l => l.id === r.libraryId)?.name ?? '知识库') : ({ projects: '项目管理', knowledge: '知识库', servers: '服务器管理' })[r.page]);
  return `<div class="top"><div class="crumb">${back}<strong>${esc(name ?? '')}</strong></div><div class="top-actions">${themeButton()}<span class="tag demo">v3.0 · 本地仿真</span></div></div>`;
 }

 render = function () {
  current = getRoute();
  const active = current.page === 'projects' ? 'projects' : current.page === 'servers' ? 'servers' : current.page === 'knowledge' ? 'knowledge' : '';
  const global = isGlobalPage(current) || current.page === 'invalid';
  const content = current.page === 'invalid'
   ? `<div class="page">${title('无法打开')}${empty(current.message ?? '路由无效。')}</div>`
   : ({ projects, knowledge, servers, project, server })[current.page](current);
  app.innerHTML = `<div class="shell ${global ? '' : 'local-shell'}">${global ? sidebar(active) : ''}<main class="main" id="main">${topBar(current)}${content}</main></div>`;
  const terminal = app.querySelector('.terminal pre'); if (terminal) terminal.scrollTop = terminal.scrollHeight;
  const chat = app.querySelector('.chatlog'); if (chat) chat.scrollTop = chat.scrollHeight;
  syncSettingsDialog();
 };

 /* ── 项目管理列表：编码/办公 ── */
 const typeLabel = t => t === 'code' ? '编码' : '办公';
 projects = function () {
  const n = state.projects.length;
  return `<div class="page">${title('项目管理', '管理编码与办公项目，继续最近的工作。', btn('新建项目', 'new-project', 'primary', '', 'plus'))}<div class="metrics">${[['全部项目', n, 'folder'], ['编码项目', state.projects.filter(p => p.type === 'code').length, 'code'], ['办公项目', state.projects.filter(p => p.type === 'work').length, 'layers']].map(([label, value, iconName]) => `<div class="metric">${icon(iconName)}<div><small>${label}</small><strong>${value}</strong></div></div>`).join('')}</div><div class="toolbar"><label class="search">${icon('search')}<input aria-label="搜索项目" id="project-query" placeholder="搜索项目或负责人" value="${esc(state.query)}"></label><div class="segment" aria-label="项目类型">${[['all', '全部'], ['code', '编码'], ['work', '办公']].map(([id, name]) => btn(name, 'filter', '', `data-id="${id}" aria-pressed="${state.filter === id}"`)).join('')}</div></div><div id="project-results">${projectCards()}</div></div>`;
 };

 projectCards = function () {
  const q = state.query.trim().toLowerCase();
  const items = state.projects.filter(p => (state.filter === 'all' || state.filter === p.type) && `${p.name} ${p.owner} ${p.description}`.toLowerCase().includes(q));
  return items.length ? `<div class="grid">${items.map(p => { const to = `project/${p.id}`; return `<article class="card"><div class="cardtop"><span class="tileicon ${p.type === 'work' ? 'violet' : ''}">${icon(p.type === 'work' ? 'layers' : 'code')}</span>${tag(typeLabel(p.type), p.type === 'work' ? 'violet' : 'good')}</div><h2>${link(p.name, to)}</h2><p>${esc(p.description || '暂无项目简介')}</p><div class="data"><span>${icon('user')} ${esc(p.owner)}</span><time>${esc(p.date)}</time></div><div class="cardfoot"><small>${p.type === 'code' ? `${esc(p.iteration)} · ${p.stories.length} 个用户故事` : `${p.files.filter(f => !f.source).length} 份资料 · ${p.files.filter(f => f.source).length} 个产物`}</small>${link('打开', to, 'btn', 'arrow')}</div></article>`; }).join('')}</div>` : empty('没有匹配的项目。请修改搜索词或项目类型。');
 };

 /* ── 知识库：列表留在全局壳内，不跳转页面 ── */
 knowledge = function (r = {}) {
  if (r.libraryId) return knowledgeReader(r);
  return `<div class="page">${title('知识库', '所有者资料目录；项目授权后仅供只读检索。', btn('新建知识库', 'new-library', 'primary', '', 'plus'))}
   <div class="cr014-kb-list" data-library-list>${state.libraries.map((lib, i) => `<article class="card cr014-kb-card" data-library="${lib.id}">
    <div class="cardtop"><span class="tileicon">${icon('book')}</span><div class="actions">${tag('只读')}${tag(`${lib.notes.length} 篇`)}</div></div>
    <h2>${link(lib.name, `knowledge/${lib.id}`)}</h2>
    <p>${esc(lib.description)}</p>
    <p class="muted">已授权：${lib.projects.map(id => esc(getProject(id)?.name)).join('、') || '无 · 默认不可用'}</p>
    <div class="cardfoot"><small>样例版本 · 进入后阅读正文</small><div class="actions">${btn('项目授权', 'library-grants', '', `data-index="${i}"`)}${link('打开', `knowledge/${lib.id}`, 'btn', 'arrow')}</div></div>
   </article>`).join('') || empty('暂无知识库。')}</div></div>`;
 };

 /** 正文若以与标题相同的 H1 开头，去掉重复标题，只由外层渲染一次。 */
 function stripLeadingTitle(note) {
  const text = note.text ?? '';
  const match = text.match(/^[ \t]*#[ \t]+(.+)\r?\n/);
  if (match && match[1].trim() === String(note.title ?? '').trim()) return text.slice(match[0].length);
  return text;
 }

 function readerView(lib) {
  state.readers ??= {};
  return state.readers[lib.id] ??= { selected: lib.notes.find(n => n.id === 'reading')?.id ?? lib.notes[0]?.id, query: '', folders: {} };
 }

 knowledgeReader = function ({ libraryId, noteId }) {
  const lib = state.libraries.find(l => l.id === libraryId);
  if (!lib) return `<div class="page">${title('知识库不可访问', '库不存在或路由无效。', link('返回知识库', 'knowledge', 'btn'))}${empty('没有可读取的知识库。')}</div>`;
  const view = readerView(lib);
  if (noteId) view.selected = noteId;
  const note = lib.notes.find(n => n.id === view.selected);
  const source = note ? { ...note, text: stripLeadingTitle(note) } : null;
  const query = view.query.trim().toLowerCase();
  const notes = lib.notes.filter(n => `${n.title} ${n.path} ${n.text}`.toLowerCase().includes(query));
  const model = source ? readingModel(lib, source) : null;
  const filteredEmpty = !!query && !notes.length;
  const available = !!note && !filteredEmpty;
  const body = filteredEmpty ? empty('搜索无匹配，未显示旧正文作为结果。') : source ? model.html : empty(lib.notes.length ? '所选文件不存在，未读取正文。' : '知识库暂无文件。');
  return `<div class="cr014-doc" data-knowledge-reader="${lib.id}">
   <aside class="cr014-doc-side" data-knowledge-pane="files">
    <button type="button" class="cr014-space" data-action="parent-route" data-to="knowledge">${icon('book')}<span>${esc(lib.name)}</span>${icon('right')}</button>
    <label class="cr014-search">${icon('search')}<input id="knowledge-query" aria-label="搜索知识库文件" value="${esc(view.query)}" placeholder="在知识库中搜索"></label>
    <div class="cr014-doc-caption">目录<button type="button" class="cr014-mini" data-action="library-grants" data-index="${state.libraries.indexOf(lib)}" aria-label="项目授权">${icon('shield')}</button></div>
    <div class="cr014-doc-tree" data-knowledge-folders>${knowledgeTree(lib, view, notes)}</div>
   </aside>
   <main class="cr014-doc-main" data-knowledge-pane="content">
    <div class="cr014-doc-tools"><span class="cr014-doc-path">${esc(note?.path ?? '')}</span><div class="actions"><button type="button" class="cr014-tool" data-action="parent-route" data-to="knowledge" aria-label="在浏览器中打开知识库列表">${icon('arrow')}返回列表</button></div></div>
    <article class="cr014-doc-body" data-note-id="${available ? note.id : ''}">
     <h1>${esc(available ? note.title : lib.name)}</h1>
     ${available ? `<div class="cr014-doc-meta">${esc(note.version)} · 样例资料 · 只读${note.links.length ? ` · <span>${note.links.length} 篇关联</span>` : ''}</div>` : ''}
     ${body}
     ${available && note.links.length ? `<div class="cr014-doc-links"><strong>同库关联资料</strong><div class="actions">${note.links.filter(id => lib.notes.some(n => n.id === id)).map(id => btn(lib.notes.find(n => n.id === id).title, 'knowledge-file', '', `data-library="${lib.id}" data-note="${id}"`)).join('')}</div></div>` : ''}
    </article>
   </main>
   <aside class="cr014-doc-toc" data-knowledge-pane="toc"><div class="cr014-doc-caption">目录</div><nav aria-label="文件内容目录">${available && model.headings.length ? model.headings.map(h => `<button type="button" data-action="knowledge-heading" data-target="${h.id}" data-level="${h.level}" style="--lvl:${h.level}" aria-current="false">${esc(h.text)}</button>`).join('') : `<p class="cr014-muted">暂无目录</p>`}</nav></aside>
  </div>`;
 };

 /* ── 服务器：列表留在全局壳内 ── */
 servers = function () {
  return `<div class="page">${title('服务器管理', '查看连接状态、运行指标与 AI 授权。', btn('新增演示主机', 'new-server', 'primary', '', 'plus'))}
   <div class="cr014-srv-list" aria-label="服务器列表">${state.servers.map(s => `<article class="card cr014-srv-card" data-server="${s.id}">
    <div class="cr014-srv-id"><span class="tileicon">${icon('server')}</span><div><h2>${link(s.name, `server/${s.id}`)}</h2><code>${esc(s.host)}</code></div></div>
    <div class="cr014-srv-state"><div class="actions">${tag(s.env, s.env === '生产' ? 'warn' : '')}${tag(s.online ? '在线' : '离线', s.online ? 'good' : '')}${tag(s.connection === 'connected' ? '已连接' : s.connection === 'connecting' ? '连接中' : s.connection === 'error' ? '连接失败' : '未连接', s.connection === 'connected' ? 'good' : '')}</div><p class="muted">${esc(s.spec)} · 最近连接 ${esc(s.last || '无')}</p></div>
    <div class="cr014-srv-usage"><span>CPU ${percent(s.cpu)}</span><span>内存 ${percent(s.mem)}</span><span>磁盘 ${percent(s.disk)}</span></div>
    <div class="actions">${switcher('AI 授权', 'auth', s.authorized, `data-id="${s.id}"`)}${link('进入工作台', `server/${s.id}`, 'btn', 'arrow')}</div>
   </article>`).join('') || empty('暂无服务器。可新增演示主机。')}</div></div>`;
 };

 const remoteEntries = () => (typeof remoteFiles !== 'undefined' ? remoteFiles : [['/etc/os-release', ''], ['/var/log/gateway.log', ''], ['/opt/app/README.md', '']]);
 const srvFiles = [
  ['bin.usr-is-merged', 'folder'], ['boot', 'folder'], ['cdrom', 'folder'], ['dev', 'folder'], ['etc', 'folder'],
  ['home', 'folder', [['nncs', 'folder', [['.aaat', 'folder'], ['projects', 'folder'], ['.bashrc', 'file'], ['.claude.json', 'file'], ['lesshst', 'file']]]]],
  ['opt', 'folder'], ['root', 'folder'], ['srv', 'folder'], ['tmp', 'folder'], ['usr', 'folder'], ['var', 'folder']
 ];
 function fileTree(nodes, depth = 0) {
  return nodes.map(([name, kind, children]) => {
   const pad = `style="--lvl:${depth}"`;
   if (kind === 'folder' && children) return `<details class="cr014-tree-node" open><summary ${pad}>${icon('folder')}<span>${esc(name)}</span></summary><div class="cr014-tree-children">${fileTree(children, depth + 1)}</div></details>`;
   return `<div class="cr014-tree-row" ${pad}>${icon(kind === 'folder' ? 'folder' : 'file')}<span>${esc(name)}</span></div>`;
  }).join('');
 }
 function cores(s) {
  const total = s.cores ?? 16, out = [];
  for (let i = 0; i < total; i++) out.push(Math.min(99, Math.max(0, Math.round((Number(s.cpu) || 0) * 0.12 + ((i * 7) % 5)))));
  return out;
 }
 function shownCores(s) { const all = cores(s); return s.coresExpanded ? all : all.slice(0, 6); }

 server = function ({ s }) {
  s.pane ??= 'monitor';
  const connected = s.connection === 'connected';
  const reason = typeof access === 'function' ? access(s) : '';
  const label = connected ? '已连接' : s.connection === 'connecting' ? '连接中' : s.connection === 'error' ? '连接失败' : '未连接';
  const cpu = Number(s.cpu) || 0, mem = Number(s.mem) || 0;
  const memTotal = 30.7, memUsed = (memTotal * mem / 100).toFixed(1);
  const monitor = `<div class="cr014-monitor">
    <section class="cr014-mon-card"><div class="cr014-mon-title">${icon('server')}<strong>${esc(s.host.split('@').at(-1) ?? s.host)}</strong></div>
      <dl class="cr014-mon-kv"><dt>系统</dt><dd>${esc(s.spec)}</dd><dt>主机名</dt><dd>${esc(s.id)}scn</dd><dt>IP</dt><dd>${esc(s.host.split('@').at(-1)?.split(':')[0] ?? s.host)}</dd><dt>架构</dt><dd>GNU/Linux</dd><dt>启动</dt><dd>2026-07-09 21:26</dd><dt>运行时长</dt><dd>2 天 21 小时</dd></dl></section>
    <section class="cr014-mon-card"><div class="cr014-mon-title"><span>性能</span><div class="actions">${tag(cpu < 70 ? '正常' : '偏高', cpu < 70 ? 'good' : 'warn')}</div></div>
      <div class="cr014-cpu"><small>CPU 使用率（总览）</small><strong>${cpu.toFixed(1)}<em>%</em></strong><span class="cr014-muted">${cores(s).length} 核心 · 均 ${(cpu / 100).toFixed(1)}%</span>
        <div class="cr014-spark" aria-hidden="true">${Array.from({ length: 40 }, (_, i) => `<i style="height:${12 + ((i * 13 + cpu) % 26)}%"></i>`).join('')}</div></div>
      <div class="cr014-cores">${shownCores(s).map((v, i) => `<div class="cr014-core"><small>c${i}</small><span class="cr014-bar"><i style="width:${Math.max(2, v)}%"></i></span><em>${v}%</em></div>`).join('')}${cores(s).length > 6 ? `<button type="button" class="cr014-core-toggle" data-action="cr014-cores">${s.coresExpanded ? '收起核心列表' : `展开剩余 ${cores(s).length - 6} 个核心（共 ${cores(s).length}）`}</button>` : ''}</div></section>
    <section class="cr014-mon-card"><div class="cr014-mon-title"><span>内存使用</span><small class="cr014-muted">${memUsed} / ${memTotal} GB</small></div><strong class="cr014-big">${mem.toFixed(1)}<em>%</em></strong><span class="cr014-bar wide"><i style="width:${mem}%"></i></span></section>
   </div>`;
  return `<div class="cr014-term" data-server-workbench="${s.id}">
   <div class="cr014-term-tabs"><button type="button" class="cr014-term-tab back" data-action="parent-route" data-to="servers" aria-label="返回服务器列表">${icon('back')}</button><button type="button" class="cr014-term-tab" data-action="cr014-server-pane" data-pane="files">SSH</button><button type="button" class="cr014-term-tab active" aria-current="page">● shell 1</button><span class="cr014-term-tab muted">+</span><div class="cr014-term-actions">${connected ? btn('断开', 'disconnect', '') : s.connection === 'connecting' ? btn('取消连接', 'disconnect', '') : btn('连接', 'connect', 'primary', '', 'terminal')}</div></div>
   <div class="cr014-term-body">
    <aside class="cr014-term-files" data-server-pane="files"><div class="cr014-term-caption">文件<button type="button" class="cr014-mini" data-action="cr014-sftp" aria-label="打开 SFTP 浏览器">${icon('folder')}</button></div><div class="cr014-crumb">/ home / <strong>nncs</strong></div><div class="cr014-tree">${fileTree(srvFiles)}</div>${connected ? `<div class="cr014-remote-files">${remoteEntries().map(([name], i) => btn(name, 'remote-file', 'cr014-filebtn', `data-index="${i}" aria-pressed="${s.remote === i}"`)).join('')}</div>` : ''}</aside>
    <main class="cr014-term-main"><div class="terminal"><pre aria-live="polite">${esc(s.output ?? (connected ? 'Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-134-generic x86_64)\n\n * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n\n本终端为本地仿真，不连接真实主机。' : '未连接到演示主机。'))}</pre>${connected ? `<form data-form="terminal"><input maxlength="100" name="command" aria-label="终端命令" placeholder="help / uptime / free -h"><button type="submit">运行</button></form>` : ''}</div>
      <div class="cr014-quick">${['docker ps', '服务状态', '实时日志', 'free -h', 'top', 'disk', 'ports', 'conn'].map(c => `<button type="button" class="cr014-chip" data-action="terminal-quick" data-cmd="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      ${s.connection === 'error' ? '<p class="notice bad">主机离线，连接超时。</p>' : ''}${connected && s.remote != null ? `<div class="cr014-term-file"><strong>${esc(remoteEntries()[s.remote]?.[0] ?? '')}</strong><pre class="wrap">${esc(remoteEntries()[s.remote]?.[1] ?? '')}</pre></div>` : ''}
    </main>
    <aside class="cr014-term-side"><div class="cr014-term-tabs sub"><button type="button" class="cr014-term-tab ${s.pane === 'monitor' ? 'active' : ''}" data-action="cr014-server-pane" data-pane="monitor">实时监控</button><button type="button" class="cr014-term-tab ${s.pane === 'ai' ? 'active' : ''}" data-action="cr014-server-pane" data-pane="ai">AI 助手</button></div>${s.pane === 'ai' ? `<div class="cr014-term-ai">${assistantPanel(`server:${s.id}`, s.name, ['/巡检', '/日志分析', '模拟重启服务'], reason)}</div>` : monitor}</aside>
   </div>
   <div class="cr014-term-foot"><span class="dot ${connected ? 'good' : ''}"></span><span>${esc(label)}</span><span class="cr014-muted">${esc(s.host)}</span>${switcher('AI 授权', 'auth', s.authorized, `data-id="${s.id}"`)}</div>
  </div>`;
 };

 Object.assign(actions, {
  'parent-route': b => { location.hash = b.dataset.to || 'projects'; },
  'cr014-server-pane': b => { const s = current.s; if (!s) return; s.pane = b.dataset.pane === 'ai' ? 'ai' : 'monitor'; render(); },
  'cr014-cores': () => { const s = current.s; if (!s) return; s.coresExpanded = !s.coresExpanded; render(); },
  'terminal-quick': b => { const form = app.querySelector('form[data-form=terminal]'); if (!form) { notify('请先连接演示主机。'); return; } const input = form.querySelector('[name=command]'); input.value = b.dataset.cmd ?? ''; form.requestSubmit?.() ?? form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); },
  'cr014-sftp': () => { const s = current.s; if (!s) return; notify(s.connection === 'connected' ? 'SFTP 为本地仿真目录，已在左侧列出。' : '请先连接演示主机。'); }
 });

 // 演示首台在线主机默认已连接，便于直接查看工作台；连接/断开与授权校验逻辑不变。
 const firstOnline = state.servers.find(s => s.online);
 if (firstOnline && firstOnline.connection == null) firstOnline.connection = 'connected';

 if (typeof prototypeV24 === 'object' && prototypeV24) {
  prototypeV24.cr014 = { version: 'CR-014', theme: () => themeName(), shell: () => window.__cr014ShellLoaded === true };
 }

 render();
})();
