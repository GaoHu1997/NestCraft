/* CR-014：项目工作台视图。经典脚本，在原型的包装器之后载入，不依赖模块或网络。 */
(() => {
 if (typeof project !== 'function' || typeof assistantPanel !== 'function') return;

 const originalAssistant = assistantPanel;
 const originalFiles = files;
 const originalGitPanel = gitPanel;
 const originalGetRoute = typeof getRoute === 'function' ? getRoute : null;
 const originalRefreshChatFloating = typeof refreshChatFloating === 'function' ? refreshChatFloating : null;
 const typeLabel = { Epic: '史诗', Feature: '特性', Story: '用户故事' };
 const storyStates = ['待澄清', '待确认', '已就绪', '设计中', '开发中', '验证中', '待验收', '已完成'];
 const stateOf = n => n.type === 'Story' ? (storyStates[n.status] ?? '待澄清') : n.type === 'Epic' ? '进行中' : '进行中';
 const attr = (name, value) => `${name}="${esc(value)}"`;
 const data = id => attr('data-id', id);
 const textButton = (label, action, attrs = '', tone = '') => `<button type="button" class="cr014p-textbtn ${tone}" data-action="${action}" ${attrs}>${esc(label)}</button>`;
 const iconButton = (label, action, attrs = '', icon = 'plus') => `<button type="button" class="cr014p-iconbtn" data-action="${action}" ${attrs} aria-label="${esc(label)}" title="${esc(label)}">${c14Icon(icon)}</button>`;
 const panelTitle = (title, extra = '') => `<div class="cr014p-panelhead"><div><strong>${esc(title)}</strong></div>${extra}</div>`;
 const emptyBox = (text, cls = '') => `<div class="cr014p-empty ${cls}">${esc(text)}</div>`;
 const grid = (main, ai, extra = '') => `<div class="cr014p-split ${extra}">${main}${ai}</div>`;
 const aiForRequirements = p => assistantPanel(`design:${p.id}`, '项目需求', ['/拆解需求', ...(p.stories.some(x => x.status === 4) ? ['发起 AI 开发'] : [])]);
 const aiForFiles = p => p.type === 'work'
  ? assistantPanel(`office:${p.id}`, p.files.find(f => f.name === p.file)?.name ?? '办公资料', ['解读当前资料', '生成 PPT', '生成 Word'])
  : assistantPanel(`files:${p.id}`, p.files.find(f => f.name === p.file)?.name ?? '项目文件', ['读取当前文件', '/建议修改']);

 const paths = {
  bolt: 'M13.4 2 4.5 13.1h6.2L9.4 22l9.2-12.2h-6.1L13.4 2Z',
  book: 'M4 5.3c0-1.3 1-2.3 2.3-2.3H11v18H6.3C5 21 4 20 4 18.7V5.3Zm8-2.3h4.7C18 3 19 4 19 5.3v13.4c0 1.3-1 2.3-2.3 2.3H12V3Z',
  bookmark: 'M6.2 3h11.6A1.2 1.2 0 0 1 19 4.2V22l-7-4.2L5 22V4.2A1.2 1.2 0 0 1 6.2 3Z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.1a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6ZM11 10h2v8h-2v-8Z',
  chevron: 'm9 5 7 7-7 7',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z',
  edit: 'M4 16.5V20h3.5L18.1 9.4l-3.5-3.5L4 16.5Zm14.8-9.8a1 1 0 0 0 0-1.4l-1.1-1.1a1 1 0 0 0-1.4 0l-1.2 1.2 3.5 3.5 1.2-1.2Z',
  trash: 'M7 7h10l-.7 13H7.7L7 7Zm2-4h6l1 2h4v2H4V5h4l1-2Z',
  file: 'M5 2h9l5 5v15H5V2Zm8 1.5V8h4.5L13 3.5Z',
  folder: 'M3 5h7l2 2h9v12H3V5Z',
  ui: 'M4 4h16v16H4V4Zm2 4h5v8H6V8Zm7 0h5v3h-5V8Zm0 5h5v3h-5v-3Z',
  table: 'M4 5h16v14H4V5Zm2 4v3h5V9H6Zm7 0v3h5V9h-5Zm-7 5v3h5v-3H6Zm7 0v3h5v-3h-5Z',
  refresh: 'M18.7 7.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.1-3.5L14 11h7V4l-2.3 3.3Z',
  external: 'M14 3h7v7h-2V6.4l-7.3 7.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z',
  branch: 'M7 3a3 3 0 1 0 1.5 5.6c1.3 1.7 3.2 2.6 5.5 2.6h3.5A3 3 0 1 0 17 9h-3c-1.6 0-2.8-.5-3.8-1.5A3 3 0 0 0 7 3Zm0 12a3 3 0 1 0 1.5 5.6V14H7Z',
  send: 'm3 4 18 8-18 8 3-8-3-8Zm5 9h7V11H8v2Z'
 };
 function c14Icon(name) {
  const path = paths[name] ?? paths.plus;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
 }

 function projectLocationTab() {
  const hash = location.hash.slice(1);
  const legacy = Number(new URLSearchParams(location.search).get('s'));
  const oldHash = new URLSearchParams(hash).get('s');
  const [page, id, tab] = (oldHash ? paths[Number(oldHash) - 1] || 'projects' : hash || paths[legacy - 1] || 'projects').split('/');
  return page === 'project' && id ? tab ?? '' : '';
 }

 if (originalGetRoute) {
  getRoute = function () {
   const route = originalGetRoute();
   if (route.page !== 'project' || !route.p || route.tab === 'invalid') return route;
   const rawTab = projectLocationTab();
   const mappedTab = rawTab === 'design' ? 'design'
    : rawTab === 'preview' ? 'preview'
    : ['architecture', 'designs'].includes(rawTab) ? 'architecture'
    : ['code', 'files'].includes(rawTab) ? 'code'
    : '';
   if (mappedTab) route.tab = mappedTab;
   return route;
  };
 }

 function hydrateRequirements(p) {
  hydrateAdjustment(p);
  const seen = new Set();
  for (const x of [...p.epics, ...p.features, ...p.stories]) seen.add(x.id);
  return seen;
 }

 function orderedRequirements(p) {
  hydrateRequirements(p);
  const nodes = [
   ...p.epics.map(x => ({ ...x, type: 'Epic' })),
   ...p.features.map(x => ({ ...x, type: 'Feature' })),
   ...p.stories.map(x => ({ ...x, type: 'Story', status: x.status }))
  ];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
   if (!children.has(n.parent ?? '')) children.set(n.parent ?? '', []);
   children.get(n.parent ?? '').push(n);
  }
  const out = [];
  const walk = (n, depth) => {
   out.push({ ...n, depth });
   for (const child of children.get(n.id) ?? []) walk(child, depth + 1);
  };
  const roots = nodes.filter(n => n.type === 'Epic' || !byId.has(n.parent));
  for (const root of roots) walk(root, root.type === 'Epic' ? 0 : Math.max(0, root.depth ?? 0));
  return out;
 }

 function visibleRequirements(p) {
  const all = orderedRequirements(p);
  const byId = new Map(all.map(n => [n.id, n]));
  return all.filter(n => {
   let parent = byId.get(n.parent);
   while (parent) {
    if (p.expanded?.[parent.id] === false) return false;
    parent = byId.get(parent.parent);
   }
    return true;
  });
 }

 function reqIcon(type) {
  const style = type === 'Epic' ? 'epic' : type === 'Feature' ? 'feature' : 'story';
  const icon = type === 'Epic' ? 'bolt' : type === 'Feature' ? 'book' : 'bookmark';
  return `<span class="cr014p-req-icon cr014p-req-icon--${style}" aria-hidden="true">${c14Icon(icon)}</span>`;
 }

 function renderReqRow(p, n) {
  const children = n.type === 'Epic' ? p.features.filter(x => x.parent === n.id).length : n.type === 'Feature' ? p.stories.filter(x => x.parent === n.id).length : 0;
  const expanded = p.expanded?.[n.id] !== false;
  const toggle = n.type === 'Story' ? '<span class="cr014p-tree-spacer"></span>' : `<button type="button" class="cr014p-tree-toggle" data-action="toggle-node" ${data(n.id)} aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'} ${esc(n.id)}">${c14Icon('chevron')}</button>`;
  const childButton = n.type === 'Story' ? '' : iconButton(n.type === 'Epic' ? '新建特性' : '新建用户故事', 'cr014p-child', `${data(n.id)} data-kind="${n.type === 'Epic' ? 'Feature' : 'Story'}"`, 'plus');
  const meta = n.type === 'Story' ? stateOf(n) : `${children} ${n.type === 'Epic' ? '特性' : '用户故事'}`;
  return `<div class="cr014p-req-row" data-node="${esc(n.id)}" style="--depth:${n.depth}">
   ${toggle}${reqIcon(n.type)}
   <button type="button" class="cr014p-req-title" data-action="node-detail" ${data(n.id)}>
    <span class="cr014p-req-id">${esc(n.id)}</span><strong>${esc(n.title)}</strong><small>${esc(meta)}</small>
   </button>
   <div class="cr014p-row-tools" aria-label="${esc(n.id)} 操作">
    ${childButton}
    ${iconButton('编辑', 'edit-requirement', data(n.id), 'edit')}
    ${iconButton('删除', 'delete-requirement', data(n.id), 'trash')}
   </div>
  </div>`;
 }

 project = function ({ p, tab }) {
  hydrateAdjustment(p);
  const path = `project/${p.id}/`;
  const activeTab = tab === 'preview' ? 'design' : tab === 'files' || tab === 'code' ? 'code' : tab;
  const tabs = [['design', '需求'], ['architecture', '设计'], ['code', '编码']];
  const content = tab === 'invalid'
   ? emptyBox('项目页签不存在。')
   : tab === 'preview'
    ? requirementsPreview(p)
    : tab === 'architecture'
     ? architecture(p)
     : tab === 'design'
      ? design(p)
      : files(p);
  return `<div class="workspace cr014p-project" data-cr014-project="${esc(p.id)}">
   <header class="cr014p-ws-title">
    <a class="cr014p-back" href="#projects" aria-label="返回项目">${c14Icon('chevron')}<span>项目</span></a>
    <h1>${esc(p.name)}</h1>
    <span class="cr014p-kind">${p.type === 'code' ? '编码' : '办公'}</span>
    <div class="cr014p-ws-meta"><span>${esc(p.owner)}</span><span>${esc(p.iteration)}</span></div>
    <button type="button" class="cr014p-iconbtn cr014p-info-btn" data-action="cr014p-project-info" aria-label="项目信息" title="项目信息">${c14Icon('info')}</button>
   </header>
   <nav class="cr014p-tabs" aria-label="项目视图">${tabs.map(([id, label]) => `<a href="#${path}${id}" ${activeTab === id ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
   <div class="cr014p-content">${content}</div>
  </div>`;
 };

 design = function (p) {
  const rows = visibleRequirements(p);
  const tree = rows.length ? rows.map(n => renderReqRow(p, n)).join('') : emptyBox('暂无需求。先新建史诗，再逐级拆解。');
  return grid(
   `<section class="cr014p-demand-pane" aria-label="需求树">
    ${panelTitle('需求', `<div class="cr014p-demand-actions">${textButton('预览', 'requirements-preview', '', 'subtle')}<button type="button" class="cr014p-primary" data-action="new-epic">${c14Icon('plus')}<span>新建史诗</span></button></div>`)}
    <div class="cr014p-tree" role="tree" aria-label="史诗、特性和用户故事">${tree}</div>
   </section>`,
   aiForRequirements(p),
   'cr014p-demand-split'
  );
 };

 function storyPreview(n) {
  const sections = [
   ['背景', n.background], ['目标', n.goal], ['范围', n.scope], ['不包含', n.exclusions],
   ['流程与异常', n.flow], ['业务规则', n.rules], ['依赖与关联', n.dependencies], ['设计与交付', n.design]
  ];
  return `${sections.map(([h, v]) => `<section><h4>${h}</h4><p>${esc(v || '—')}</p></section>`).join('')}
   <section><h4>验收标准</h4><ul class="cr014p-ac-list">${(n.ac ?? []).map(a => `<li><span class="cr014p-ac-id">${esc(a.id)}</span><span>${esc(a.text)}</span><em class="${a.ok ? 'ok' : ''}">${a.ok ? '通过' : '未通过'}</em></li>`).join('') || '<li>暂无验收标准</li>'}</ul></section>
   <section><h4>验证记录</h4>${(n.logs ?? []).length ? `<ul class="cr014p-log">${n.logs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">尚未执行验证</p>'}</section>`;
 }

 requirementsPreview = function (p) {
  const nodes = orderedRequirements(p);
  const toc = nodes.map(n => `<button type="button" class="cr014p-toc-item cr014p-toc-${n.type.toLowerCase()}" data-action="preview-locate" ${data(n.id)}><span>${esc(n.id)}</span><small>${esc(n.title)}</small></button>`).join('');
  const body = nodes.map(n => {
   const tagName = n.type === 'Epic' ? 'h1' : n.type === 'Feature' ? 'h2' : 'h3';
   const content = n.type === 'Story' ? storyPreview(n) : `<p class="cr014p-doc-body">${esc(n.body || '—')}</p>`;
   return `<article class="cr014p-doc-section cr014p-doc-${n.type.toLowerCase()}" id="preview-${esc(n.id)}" data-preview-node="${esc(n.id)}" tabindex="-1">
    <div class="cr014p-doc-kicker"><span>${esc(typeLabel[n.type])}</span><span>${esc(stateOf(n))}</span></div>
    <${tagName}>${esc(n.id)} · ${esc(n.title)}</${tagName}>${content}
   </article>`;
  }).join('');
  return grid(
   `<section class="cr014p-preview-pane" aria-label="需求正文预览">
    <div class="cr014p-preview-head">
     <a class="cr014p-back" href="#project/${p.id}/design">${c14Icon('chevron')}<span>需求树</span></a>
     <strong>需求正文</strong><span class="cr014p-preview-count">${nodes.length} 个条目</span>
    </div>
    <div class="cr014p-preview-layout">
     <div class="cr014p-document-scroll"><div class="cr014p-document">${body || emptyBox('暂无需求正文。')}</div></div>
     <nav class="cr014p-toc" aria-label="需求正文目录"><div class="cr014p-toc-head">目录</div>${toc || '<span class="muted">暂无条目</span>'}</nav>
    </div>
   </section>`,
   aiForRequirements(p),
   'cr014p-preview-split'
  );
 };

 function uiMockHtml(p, item) {
  const title = esc(item?.title ?? '界面设计方案');
  const description = esc(item?.content ?? '需求、设计与交付在同一工作台内协作。');
  const requirement = esc(p.stories[0]?.title ?? p.features[0]?.title ?? p.epics[0]?.title ?? '建立项目需求');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
   *{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#26282d;font:14px/1.55 Inter,system-ui,'Microsoft YaHei',sans-serif}.app{min-height:100vh;display:grid;grid-template-columns:184px minmax(0,1fr)}.side{padding:22px 15px;background:#1e2025;color:#d8dbe2}.brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-weight:700;color:#fff}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:#b45336;color:#fff}.nav{display:grid;gap:5px}.nav b,.nav span{padding:9px 10px;border-radius:7px;font-size:13px;font-weight:500}.nav b{background:#353943;color:#fff}.foot{position:absolute;bottom:18px;font-size:11px;color:#8e949f}.main{min-width:0}.top{height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 26px;background:#fff;border-bottom:1px solid #e7e8eb}.top strong{font-size:15px}.top div{display:flex;gap:7px}.pill{padding:4px 9px;border-radius:99px;background:#f2f3f5;color:#676b73;font-size:11px}.page{padding:22px 26px}.head{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:18px}.head h1{margin:0;font-size:25px;letter-spacing:-.02em}.head p{margin:5px 0 0;color:#747983;font-size:12px}.btn{border:0;border-radius:7px;background:#202126;color:#fff;padding:8px 12px;font-weight:600}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.stat{padding:14px 16px;background:#fff;border:1px solid #e8e9ec;border-radius:10px}.stat small{color:#7f848d}.stat strong{display:block;font-size:23px;margin-top:2px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:12px}.card{background:#fff;border:1px solid #e8e9ec;border-radius:10px;overflow:hidden}.cardhead{height:46px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #eceef1}.cardhead strong{font-size:13px}.cardhead button{border:0;background:#f1f2f4;color:#4f535b;border-radius:6px;padding:5px 9px;font-size:11px}.rows{padding:2px 12px}.row{min-height:48px;display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:10px;border-bottom:1px solid #f0f1f3;font-size:12px}.row:last-child{border-bottom:0}.ico{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:#f8e4dc;color:#b45336;font-weight:700}.ico.p{background:#ece5f2;color:#6d4f80}.ico.t{background:#def3f2;color:#287c7b}.row small{color:#9a9ea6}.row em{font-style:normal;padding:3px 7px;border-radius:99px;background:#f2f3f5;color:#71757d;font-size:10px}.ai{background:#24262b;border-color:#24262b;color:#e6e8ec;display:flex;flex-direction:column;min-height:430px}.ai .cardhead{border-color:#383b42;color:#f2f3f5}.dot{width:7px;height:7px;border-radius:50%;background:#58b982;display:inline-block;margin-right:6px}.chat{flex:1;padding:14px;display:grid;gap:10px;align-content:start}.bubble{padding:10px 11px;border-radius:8px;background:#30333a;font-size:12px;color:#c8ccd4}.bubble.me{margin-left:26px;background:#3b3e46;color:#eef0f3}.composer{margin:10px;border:1px solid #444851;border-radius:8px;padding:9px;color:#8f95a1;font-size:11px}.send{float:right;background:#b45336;color:#fff;border-radius:5px;padding:4px 8px}.alert{margin-bottom:10px;padding:10px 12px;border-radius:8px;border:1px solid #f2d2c4;background:#fff7f3;color:#85452e;font-size:12px}
   @media(max-width:720px){.app{grid-template-columns:1fr}.side{display:none}.workspace{grid-template-columns:1fr}.stats{grid-template-columns:1fr}.page{padding:16px}.top{padding:0 16px}}
  </style></head><body><div class="app"><aside class="side"><div class="brand"><span class="mark">✦</span>${esc(p.name)}</div><nav class="nav"><span>项目总览</span><b>需求工作台</b><span>设计资源</span><span>编码空间</span><span>Git 历史</span></nav><div class="foot">本地仿真 · ${esc(p.iteration)}</div></aside><main class="main"><header class="top"><strong>${title}</strong><div><span class="pill">编码项目</span><span class="pill">${esc(p.owner)}</span></div></header><div class="page"><div class="head"><div><h1>${esc(p.name)}</h1><p>${description}</p></div><button class="btn">＋ 新建史诗</button></div><div class="alert">当前为可交互界面稿，数据与操作均为内存样例，不连接真实服务。</div><div class="stats"><div class="stat"><small>史诗</small><strong>${p.epics.length}</strong></div><div class="stat"><small>特性</small><strong>${p.features.length}</strong></div><div class="stat"><small>用户故事</small><strong>${p.stories.length}</strong></div></div><div class="workspace"><section class="card"><div class="cardhead"><strong>需求 / 设计 / 编码</strong><button>预览</button></div><div class="rows"><div class="row"><span class="ico">⚡</span><div><strong>${esc(p.epics[0]?.title ?? '项目交付')}</strong><br><small>${esc(p.epics[0]?.id ?? 'EPIC')}</small></div><em>进行中</em></div><div class="row"><span class="ico p">▣</span><div><strong>${esc(p.features[0]?.title ?? '迭代目标')}</strong><br><small>${esc(p.features[0]?.id ?? 'FEATURE')}</small></div><em>2 项</em></div><div class="row"><span class="ico t">▮</span><div><strong>${requirement}</strong><br><small>${esc(p.stories[0]?.id ?? 'STORY')} · ${esc(p.owner)}</small></div><em>${esc(stateOf({ type: 'Story', status: p.stories[0]?.status ?? 0 }))}</em></div></div></section><aside class="card ai"><div class="cardhead"><strong><span class="dot"></span>AI 协作</strong><span>⌁</span></div><div class="chat"><div class="bubble">已读取当前项目需求。可以从史诗拆解特性，或检查设计稿的一致性。</div><div class="bubble me">把用户故事整理成可验证的验收标准。</div><div class="bubble">建议按“给定 / 当 / 则”补充，并保留未验证状态，避免技术验证代替用户验收。</div></div><div class="composer">输入消息，@ 引用上下文…<span class="send">发送</span></div></aside></div></div></main></div></body></html>`;
 }

 function uiDesign(p) {
  const items = p.designResources ?? [];
  const item = items.find(x => x.id === p.architectureView?.selected) ?? items[0] ?? null;
  const tabs = items.length
   ? `<div class="cr014p-ui-resources">${items.map(x => `<button type="button" data-action="architecture-select" ${data(x.id)} aria-pressed="${x.id === item?.id}">${esc(x.title)}</button>`).join('')}</div>`
   : '<span class="cr014p-muted">项目界面稿</span>';
  return `<section class="cr014p-design-main" aria-label="UI 设计">
   <header class="cr014p-design-head">
    <div><strong>UI 设计</strong><small>根据当前项目数据生成的可视界面稿 · 只读</small></div>
    ${tabs}
    <button type="button" class="cr014p-textbtn bordered" data-action="cr014p-open-ui">${c14Icon('external')}<span>在浏览器中打开</span></button>
   </header>
   <div class="cr014p-ui-canvas">
    <iframe class="cr014p-ui-frame" title="项目 UI 设计稿" sandbox srcdoc="${esc(uiMockHtml(p, item))}"></iframe>
   </div>
  </section>`;
 }

 function fkLabel(p, fk) {
  if (!fk) return '—';
  const [tableId, fieldId] = fk.split('/');
  const table = p.models.find(x => x.id === tableId);
  const field = table?.fields.find(x => x.id === fieldId);
  return table && field ? `${table.name}.${field.name}` : fk;
 }

 function modelDescription(p, model) {
  return p.cr014pModelDrafts?.[model.id]?.description ?? model.description;
 }

 function modelMarkdown(p, id = '') {
  return (id ? p.models.filter(m => m.id === id) : p.models).map(m => {
   const description = modelDescription(p, m);
   return `## ${m.name}\n\n${description}\n\n| 字段名 | 类型 | PK | FK | 备注 |\n| --- | --- | --- | --- | --- |\n${m.fields.map(f => `| ${f.name} | ${f.type} | ${f.pk ? 'PK' : ''} | ${fkLabel(p, f.fk)} | ${String(f.description).replace(/\|/g, '\\|')} |`).join('\n')}`;
  }).join('\n\n');
 }

 function modelDesign(p) {
  const models = p.models ?? [];
  const toc = models.map(m => `<button type="button" data-action="cr014p-model-locate" ${data(m.id)}><strong>${esc(m.name)}</strong><small>${m.fields.length} 字段</small></button>`).join('');
  const blocks = models.map(m => {
   const description = modelDescription(p, m);
   const dirty = description !== m.description;
   return `<article class="cr014p-model-card" id="cr014p-table-${esc(m.id)}" data-model="${esc(m.id)}">
    <header><div><span class="cr014p-model-mark">${c14Icon('table')}</span><strong>${esc(m.name)}</strong><code>${esc(m.id)}</code></div><div class="cr014p-model-actions">
      ${textButton('生成 Markdown', 'cr014p-model-markdown', data(m.id), 'subtle')}
     ${textButton('编辑结构', 'edit-model', data(m.id))}
     ${textButton('删除表', 'delete-model', data(m.id), 'danger')}
    </div></header>
    <label class="cr014p-model-desc"><span>表描述</span><textarea data-cr014p-model-desc ${data(m.id)} maxlength="600" placeholder="说明表的用途、数据来源与边界">${esc(description)}</textarea></label>
    <div class="cr014p-model-desc-foot"><small>描述可编辑，保存后进入待同步草稿；不执行 SQL。</small>${textButton(dirty ? '保存描述' : '已保存', 'cr014p-model-save-desc', `${data(m.id)} ${dirty ? '' : 'disabled'}`, 'primary')}</div>
    <div class="cr014p-table-wrap"><table class="cr014p-fields"><thead><tr><th>字段名</th><th>类型</th><th>PK</th><th>FK</th><th>备注</th></tr></thead><tbody>${m.fields.map(f => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.type)}</td><td>${f.pk ? '<span class="cr014p-pk">PK</span>' : '—'}</td><td>${f.fk ? `<code>${esc(fkLabel(p, f.fk))}</code>` : '—'}</td><td>${esc(f.description)}</td></tr>`).join('')}</tbody></table></div>
    <footer>关联需求：${(m.links ?? []).map(l => `${esc(l.storyId)} / ${esc(l.acId)}`).join('、') || '暂无'} · 数据结构仅作为设计文档供 AI 建表参考</footer>
   </article>`;
  }).join('');
  return `<section class="cr014p-design-main" aria-label="模型设计">
   <header class="cr014p-design-head">
    <div><strong>模型设计</strong><small>逐表查看字段、主外键与说明 · 不执行 SQL</small></div>
    <div class="cr014p-model-global-actions">${models.length ? textButton('全部生成 Markdown', 'cr014p-model-markdown', '', 'bordered') : ''}${p.type === 'code' ? `<button type="button" class="cr014p-primary" data-action="new-model">${c14Icon('plus')}<span>新建表</span></button>` : ''}</div>
   </header>
   <div class="cr014p-model-layout">
    <div class="cr014p-model-scroll">${blocks || emptyBox(p.type === 'code' ? '暂无数据表。新建后会显示描述、字段表与 Markdown。' : '办公项目暂无数据表设计。')}</div>
    <nav class="cr014p-model-toc" aria-label="数据表目录"><div>表目录</div>${toc || '<span class="muted">暂无表</span>'}</nav>
   </div>
  </section>`;
 }

 architecture = function (p) {
  hydrateAdjustment(p);
  p.architectureView ??= { kind: 'design', selected: p.designResources[0]?.id };
  if (!['design', 'model'].includes(p.architectureView.kind)) p.architectureView.kind = 'design';
  const modelMode = p.architectureView.kind === 'model';
  const rail = [
   ['design', 'UI设计', 'ui'],
   ['model', '模型设计', 'table']
  ].map(([id, label, icon]) => `<button type="button" data-action="cr014p-design-mode" data-mode="${id}" data-tip="${label}" aria-label="${label}" aria-pressed="${(id === 'model') === modelMode}">${c14Icon(icon)}</button>`).join('');
  return `<div class="cr014p-design"><aside class="cr014p-design-rail" aria-label="设计视图">${rail}</aside>${modelMode ? modelDesign(p) : uiDesign(p)}</div>`;
 };

 function fileTree(p) {
  const root = { dirs: new Map(), files: [] };
  for (const file of p.files) {
   const parts = file.name.split('/');
   let dir = root;
   for (const part of parts.slice(0, -1)) {
    if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
    dir = dir.dirs.get(part);
   }
   dir.files.push(file);
  }
  const walk = (node, prefix = '') => {
   const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
    const path = `${prefix}${name}/`;
    return `<details class="cr014p-dir" open data-dir="${esc(path)}"><summary>${c14Icon('folder')}<span>${esc(name)}</span></summary><div class="cr014p-dir-body">${walk(child, path)}</div></details>`;
   }).join('');
   const files = node.files.sort((a, b) => a.name.localeCompare(b.name)).map(file => `<button type="button" class="cr014p-file" data-action="cr014p-open-file" data-path="${esc(file.name)}" aria-current="${file.name === p.file}">${c14Icon('file')}<span>${esc(file.name.split('/').at(-1))}</span></button>`).join('');
   return dirs + files;
  };
  return walk(root) || emptyBox('暂无文件。');
 }

 function ensureTabs(p) {
  p.cr014pTabs = (p.cr014pTabs ?? []).filter(name => p.files.some(f => f.name === name));
  if (p.file && !p.cr014pTabs.includes(p.file)) p.cr014pTabs.unshift(p.file);
  if (!p.file && p.files[0]) p.file = p.files[0].name;
  if (p.cr014pTabs.length > 6) p.cr014pTabs = p.cr014pTabs.slice(0, 6);
  return p.cr014pTabs;
 }

 function languageOf(name) {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  return ({ ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', json: 'json', css: 'css', html: 'html', md: 'md', sql: 'sql' })[ext] ?? 'text';
 }

 function highlightedLine(line, lang) {
  if (lang === 'md') {
   if (/^\s{0,3}#{1,6}\s/.test(line)) return `<span class="cr014p-tok-heading">${esc(line)}</span>`;
   if (/^\s*[-*]\s/.test(line)) return `<span class="cr014p-tok-bullet">${esc(line)}</span>`;
   return esc(line).replace(/(`[^`]*`)/g, '<span class="cr014p-tok-string">$1</span>');
  }
  if (lang === 'text') return esc(line) || ' ';
  const token = /(\/\/.*$|\/\*.*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|function|return|export|import|from|default|if|else|for|of|in|new|class|extends|async|await|interface|type|public|private|readonly|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g;
  return line.split(token).map(part => {
   if (!part) return '';
   if (/^\/\//.test(part) || /^\/\*/.test(part)) return `<span class="cr014p-tok-comment">${esc(part)}</span>`;
   if (/^['"`]/.test(part)) return `<span class="cr014p-tok-string">${esc(part)}</span>`;
   if (/^(?:const|let|var|function|return|export|import|from|default|if|else|for|of|in|new|class|extends|async|await|interface|type|public|private|readonly|true|false|null|undefined)$/.test(part)) return `<span class="cr014p-tok-keyword">${esc(part)}</span>`;
   if (/^\d/.test(part)) return `<span class="cr014p-tok-number">${esc(part)}</span>`;
   return esc(part);
  }).join('') || ' ';
 }

 function highlightedCode(text, lang) {
  return text.split('\n').map((line, index) => `<div class="cr014p-code-line"><span class="cr014p-ln" aria-hidden="true">${index + 1}</span><code>${highlightedLine(line, lang)}</code></div>`).join('');
 }

 function editorBody(p, file) {
  if (!file) return emptyBox('从左侧文件树选择一个文件。');
  const lang = languageOf(file.name);
  const editable = ['ts', 'js', 'json', 'css', 'html', 'md', 'sql'].includes(lang);
  if (p.edit === file.name) {
   const count = Math.max(1, String(p.draft ?? file.text ?? '').split('\n').length);
   return `<form class="cr014p-file-edit" data-form="save-file">
    <div class="cr014p-edit-tools"><span>正在编辑 ${esc(file.name)}</span><div><button class="primary" type="submit">保存演示文件</button>${textButton('放弃编辑', 'cancel-edit')}</div></div>
    <div class="cr014p-edit-area"><div class="cr014p-edit-gutter" aria-hidden="true">${Array.from({ length: count }, (_, i) => `<span>${i + 1}</span>`).join('')}</div><textarea class="editor" aria-label="文件内容" name="text" maxlength="5000">${esc(p.draft ?? file.text ?? '')}</textarea></div>
   </form>`;
  }
  return `<div class="cr014p-code-scroll"><pre class="cr014p-code" aria-label="${esc(file.name)} 代码">${highlightedCode(file.text ?? '', lang)}</pre></div>
   ${editable ? `<div class="cr014p-editor-status"><span>${esc(lang.toUpperCase())}</span><span>${String(file.text ?? '').split('\n').length} 行</span><span>UTF-8 · 内存样例</span></div>` : ''}`;
 }

 function fileWorkspace(p) {
  ensureTabs(p);
  const file = p.files.find(f => f.name === p.file);
  const tabs = p.cr014pTabs.map(name => {
   const active = name === p.file;
   return `<div class="cr014p-file-tab ${active ? 'active' : ''}"><button type="button" data-action="cr014p-open-file" data-path="${esc(name)}">${c14Icon('file')}<span>${esc(name.split('/').at(-1))}</span></button><button type="button" class="cr014p-tab-close" data-action="cr014p-close-tab" data-path="${esc(name)}" aria-label="关闭 ${esc(name)}">×</button></div>`;
  }).join('');
  return `<div class="cr014p-code-shell">
   <aside class="cr014p-explorer" aria-label="资源管理器">
    <div class="cr014p-explorer-head"><strong>资源管理器</strong><div class="cr014p-view-switch"><button type="button" aria-pressed="true" data-action="cr014p-explorer" data-mode="files">文件</button><button type="button" aria-pressed="false" data-action="cr014p-explorer" data-mode="git">Git</button></div></div>
    <div class="cr014p-explorer-body">${fileTree(p)}</div>
    <div class="cr014p-explorer-foot"><span>${p.files.length} 个文件</span><span>${p.type === 'code' ? '代码空间' : '办公资料'}</span></div>
   </aside>
   <section class="cr014p-editor" aria-label="代码编辑器">
    <div class="cr014p-tabs-row" role="tablist" aria-label="已打开文件">${tabs || '<span class="cr014p-muted">未打开文件</span>'}</div>
    <div class="cr014p-editor-head"><div><strong>${esc(file?.name ?? '未选择文件')}</strong><small>${file ? `${languageOf(file.name).toUpperCase()} · 只读预览` : '从资源管理器打开文件'}</small></div><div>${file && ['ts', 'md'].includes(languageOf(file.name)) && p.edit !== file.name ? textButton('编辑', 'edit-file', '', 'subtle') : ''}</div></div>
    <div class="cr014p-editor-body">${editorBody(p, file)}</div>
   </section>
   ${aiForFiles(p)}
  </div>`;
 }

 function gitCardHeader(title, count, extra = '') {
  return `<header class="cr014p-git-card-head"><div><strong>${esc(title)}</strong>${count == null ? '' : `<span>${count}</span>`}</div><div>${extra}</div></header>`;
 }

 function gitChangeRow(change) {
  const statusClass = change.status === 'A' ? 'added' : change.status === 'D' ? 'deleted' : 'modified';
  return `<div class="cr014p-git-change" data-cr014p-git-change="${esc(change.path)}">
   <label class="cr014p-git-check" title="${change.staged ? '取消暂存' : '暂存'}"><input type="checkbox" data-action="git-stage" data-path="${esc(change.path)}" aria-label="${change.staged ? '取消暂存' : '暂存'} ${esc(change.path)}" ${change.staged ? 'checked' : ''}><span></span></label>
   <span class="cr014p-status-letter ${statusClass}" title="${esc(change.status)}">${esc(change.status)}</span>
   <button type="button" class="cr014p-git-path" data-action="git-diff" data-path="${esc(change.path)}"><span>${esc(change.path)}</span><small>${change.staged ? '已暂存' : '未暂存'}</small></button>
   <button type="button" class="cr014p-git-row-action" data-action="cr014p-open-git-file" data-path="${esc(change.path)}" aria-label="打开 ${esc(change.path)}" title="打开文件">${c14Icon('external')}</button>
  </div>`;
 }

 function gitBranchRows(p, g, items, kind) {
  if (!items.length) return `<div class="cr014p-git-empty">${kind === 'remote' ? '暂无远程分支' : '暂无本地分支'}</div>`;
  return items.map(branch => {
   const occupied = kind === 'occupied';
   const current = g.branch === branch && g.headType === 'branch';
   return `<div class="cr014p-branch-row" data-cr014p-branch="${esc(branch.toLowerCase())}">
    <div class="cr014p-branch-name">${current ? '<i class="cr014p-current-dot"></i>' : ''}<code>${esc(branch)}</code><small>${occupied ? '其他工作树占用' : kind === 'remote' ? '远程引用 · 只读样例' : current ? '当前分支' : '本地分支'}</small></div>
    ${kind === 'remote' ? textButton('从远端新建', 'git-new-branch', `data-base="${esc(branch)}"`, 'subtle') : occupied ? '<span class="cr014p-muted">不可切换</span>' : current ? '<span class="cr014p-current-badge">当前</span>' : textButton('切换', 'git-switch', `data-branch="${esc(branch)}"`, 'subtle')}
   </div>`;
  }).join('');
 }

 function gitWorkspace(p) {
  const g = hydrateGit(p);
  const branchLabel = typeof gitBranchLabel === 'function' ? gitBranchLabel(p) : (g.branch ?? '未知分支');
  const top = `<div class="cr014p-git-top"><div class="cr014p-git-title"><button type="button" class="cr014p-git-back" data-action="cr014p-explorer" data-mode="files">${c14Icon('chevron')}<span>文件</span></button><strong>Git</strong><span class="cr014p-git-branch-pill">${c14Icon('branch')}<b>${esc(branchLabel)}</b></span></div><div class="cr014p-git-top-actions"><span>${esc(g.remote ?? '无远端')} · ↑${g.ahead ?? 0} / ↓${g.behind ?? 0}</span><button type="button" class="cr014p-iconbtn" data-action="git-refresh" aria-label="刷新 Git 状态" title="刷新 Git 状态">${c14Icon('refresh')}</button></div></div>`;
  if (!g.repository) {
   return `<div class="cr014p-git-workspace">${top}<section class="cr014p-git-card cr014p-git-empty-state"><div class="cr014p-empty">当前项目未初始化 Git。<br>文件仍可浏览；本原型不会执行真实 git init。</div><button type="button" class="cr014p-primary" data-action="git-init">模拟初始化 Git</button></section></div>`;
  }
  const notices = `${g.empty ? '<div class="cr014p-git-notice">空仓库 · 尚无提交</div>' : ''}${g.error ? `<div class="cr014p-git-notice bad">${esc(g.error)} · 状态未知，操作已阻止</div>` : ''}${g.conflicts.length ? `<div class="cr014p-git-notice bad">存在冲突：${g.conflicts.map(esc).join('、')}；不会自动合并</div>` : ''}`;
  const changeRows = g.changes.length ? g.changes.map(gitChangeRow).join('') : '<div class="cr014p-git-empty">工作区没有未提交改动</div>';
  const local = [...g.branches, ...(g.occupiedBranches ?? [])];
  const branchGroups = `<details class="cr014p-branch-group" open><summary><span>${c14Icon('branch')}本地</span><small>${local.length}</small></summary><div>${gitBranchRows(p, g, local, 'local')}</div></details><details class="cr014p-branch-group" open><summary><span>${c14Icon('external')}远程</span><small>${g.remoteBranches.length}</small></summary><div>${gitBranchRows(p, g, g.remoteBranches, 'remote')}</div></details>`;
  const history = (g.history ?? []).map((commit, index) => `<article class="cr014p-history-row" data-commit="${esc(commit.id)}"><div class="cr014p-graph"><i></i></div><div class="cr014p-commit-main"><div class="cr014p-commit-title"><strong>${esc(commit.message)}</strong>${index === 0 ? '<span class="cr014p-ref head">HEAD</span>' : ''}<span class="cr014p-ref">${esc(commit.branch ?? '分支')}</span></div><small><code>${esc(commit.id)}</code><span>${esc(p.owner)}</span><span>${esc(commit.time)}</span></small></div></article>`).join('') || '<div class="cr014p-git-empty">暂无提交历史</div>';
  return `<div class="cr014p-git-workspace">${top}${notices}<div class="cr014p-git-sections">
   <section class="cr014p-git-card cr014p-git-uncommitted" aria-label="未提交">
    ${gitCardHeader('未提交', g.changes.length, g.changes.some(c => !c.staged) ? textButton('全部暂存', 'git-stage-all', '', 'subtle') : '')}
    <div class="cr014p-git-changes">${changeRows}</div>
    <div class="cr014p-commit-box"><textarea id="git-commit-message" name="gitMessage" maxlength="160" aria-label="Git 提交说明" placeholder="说明本次暂存改动">${esc(p.gitMessage ?? '')}</textarea><div class="cr014p-commit-actions"><button type="button" class="cr014p-ai-commit" data-action="cr014p-git-ai">✦ AI 生成</button><button type="button" class="cr014p-primary" data-action="git-commit">提交</button><small>仅内存仿真，不执行真实 Git</small></div></div>
   </section>
   <section class="cr014p-git-card cr014p-git-branches" aria-label="分支">
    ${gitCardHeader('分支', null, `<div class="cr014p-branch-tools"><button type="button" class="cr014p-iconbtn" data-action="cr014p-branch-expand" aria-label="展开全部分支" title="展开全部">⌄</button><button type="button" class="cr014p-iconbtn" data-action="cr014p-branch-collapse" aria-label="折叠全部分支" title="折叠全部">›</button><button type="button" class="cr014p-iconbtn" data-action="git-new-branch" aria-label="新建分支" title="新建分支">${c14Icon('plus')}</button></div>`)}
    <div class="cr014p-branch-search"><input type="search" data-cr014p-branch-search placeholder="搜索本地或远程分支" aria-label="搜索分支"></div>
    <div class="cr014p-branch-body">${branchGroups}</div>
    <div class="cr014p-git-network"><span>远端只读</span>${textButton('提取', 'git-network', 'data-operation="fetch"', 'subtle')}${textButton('更新', 'git-network', 'data-operation="pull"', 'subtle')}${textButton('推送', 'git-network', 'data-operation="push"', 'subtle')}</div>
   </section>
   <section class="cr014p-git-card cr014p-git-history" aria-label="提交历史">
    ${gitCardHeader('提交历史', g.history.length)}
    <div class="cr014p-history-body">${history}</div>
   </section>
  </div></div>`;
 }

 function gitFileWorkspace(p) {
  return `<div class="cr014p-git-shell">${gitWorkspace(p)}${aiForFiles(p)}</div>`;
 }

 files = function (p) {
  if (p.type === 'work') return originalFiles(p);
  return p.cr014pExplorer === 'git' ? gitFileWorkspace(p) : fileWorkspace(p);
 };

 assistantPanel = function (key, label, shortcuts, reason = '') {
  const markup = originalAssistant(key, label, shortcuts, reason);
  const host = document.createElement('div');
  host.innerHTML = markup;
  const pane = host.firstElementChild;
  if (!pane || pane.tagName !== 'ASIDE') return markup;
  const c = typeof chatFor === 'function' ? chatFor(key) : null;
  pane.classList.add('cr014p-ai');

  const direct = selector => [...pane.children].find(el => el.matches(selector)) ?? null;
  const head = direct('.panelhead');
  const body = direct('.panelbody');
  const log = direct('.chatlog');
  const approval = direct('.approval');
  const form = direct('form.composer');
  const adjustment = direct('.adjustment-tools');
  const usage = direct('.usage-line');
  const subagents = direct('.subagent-menu');
  const reverse = direct('[data-reverse-run]');

  if (head) {
   head.classList.add('cr014p-ai-head');
   const heading = head.querySelector('strong');
   if (heading) heading.textContent = 'AI 会话';
   const sessionTools = head.querySelector('.session-tools');
   if (sessionTools) {
    for (const historyButton of [...head.children].filter(el => el.matches('button[data-action="session-history"]'))) sessionTools.append(historyButton);
   }
   const status = document.createElement('span');
   status.className = 'cr014p-ai-session-status';
   status.innerHTML = `<i></i><span>${esc(c?.id ?? '本地会话')}</span>`;
   const tools = sessionTools;
   if (tools) head.insertBefore(status, tools);
   else head.append(status);
  }

  const main = document.createElement('div');
  main.className = 'cr014p-ai-main';
  const critical = body?.querySelector('[data-engine-reason]');
  if (critical) main.append(critical);
  if (reverse) main.append(reverse);
  if (log) {
   log.classList.add('cr014p-ai-log');
   if (c && !c.messages.length) {
    const cli = typeof cliById === 'function' ? cliById(c.cli) : null;
    const model = typeof sessionModel === 'function' ? sessionModel(c) : null;
    log.innerHTML = `<div class="cr014p-ai-empty">
     <div class="cr014p-ai-brandmark">✳</div>
     <strong>${esc(cli?.name ?? 'Agent 工作台')}</strong>
     <span>${esc(cli ? `v${cli.version}` : '本地仿真')}</span>
     <p>${esc(model?.model?.name ?? '选择一个 CLI 与模型开始会话')}</p>
     <small>输入消息，或使用 @ 引用项目上下文</small>
    </div>`;
   }
   main.append(log);
  }
  if (!log && !main.children.length) main.innerHTML = emptyBox('会话内容不可用。');

  const bottom = document.createElement('div');
  bottom.className = 'cr014p-ai-bottom';
  const toolRow = document.createElement('div');
  toolRow.className = 'cr014p-ai-tools';
  toolRow.innerHTML = `<button type="button" data-action="cr014p-ai-tasks" data-key="${esc(key)}"><span>◫</span>任务</button><button type="button" data-action="cr014p-ai-subagents" data-key="${esc(key)}"><span>◌</span>子代理</button><button type="button" data-action="cr014p-ai-edit" data-key="${esc(key)}"><span>✎</span>编辑</button>`;
  bottom.append(toolRow);

  const context = document.createElement('details');
  context.className = 'cr014p-ai-context';
  context.innerHTML = '<summary>上下文、权限与演示能力</summary>';
  const contextBody = document.createElement('div');
  contextBody.className = 'cr014p-ai-context-body';
  if (body) contextBody.append(body);
  const branch = form?.querySelector('.branch-context');
  if (branch) contextBody.append(branch);
  context.append(contextBody);

  const shortcutBox = document.createElement('details');
  shortcutBox.className = 'cr014p-ai-shortcuts';
  shortcutBox.innerHTML = '<summary>演示指令</summary>';
  let shortcutRow = null;
  if (form) shortcutRow = [...form.children].find(el => el.classList.contains('actions') && !el.classList.contains('composerbar')) ?? null;
  if (shortcutRow) shortcutBox.append(shortcutRow);
  const notes = form ? [...form.children].filter(el => el.classList.contains('context-note')) : [];
  for (const note of notes) contextBody.append(note);

  if (form) {
   form.classList.add('cr014p-ai-composer');
   const inputTools = form.querySelector('.input-tools');
   const chips = form.querySelector('[data-attachments]');
   const textarea = form.querySelector('textarea[name=message]');
   const meta = document.createElement('div');
   meta.className = 'cr014p-ai-inputmeta';
   if (inputTools) meta.append(inputTools);
   if (chips) meta.append(chips);
   if (c && typeof sessionUsage === 'function') {
    const usageNow = sessionUsage(c);
    const meter = document.createElement('span');
    meter.className = 'cr014p-context-meter';
    meter.title = `上下文估算 ${usageNow.contextUsed} / ${usageNow.contextDemoLimit} tokens（演示值）`;
    meter.innerHTML = `<span>上下文</span><i><b style="width:${Math.min(100, usageNow.contextPercent)}%"></b></i><em>${usageNow.contextPercent}%</em>`;
    meta.append(meter);
   }
   if (textarea) form.insertBefore(meta, textarea);
   else form.append(meta);
  }

  if (subagents) bottom.append(subagents);
  if (shortcutRow) bottom.append(shortcutBox);
  bottom.append(context);
  // 仅当确有未同步草稿时才占用输入区上方空间，空会话不显示“提交预览/查看差异”。
  let dirty = false;
  try {
   const project = c?.projectId && typeof getProject === 'function' ? getProject(c.projectId) : null;
   dirty = !!project && typeof actualDiff === 'function' && actualDiff(project).length > 0;
  } catch (error) { dirty = false; }
  if (adjustment && dirty) bottom.append(adjustment);
  if (approval) bottom.append(approval);
  if (form) bottom.append(form);
  if (usage) bottom.append(usage);

  while (pane.firstChild) pane.firstChild.remove();
  if (head) pane.append(head);
  pane.append(main, bottom);
  return host.innerHTML;
 };

 function normalizeAiHistoryButton() {
  for (const head of document.querySelectorAll('.cr014p-ai > .cr014p-ai-head')) {
   const tools = head.querySelector('.session-tools');
   if (!tools) continue;
   for (const history of [...head.children].filter(el => el.matches('button[data-action="session-history"]'))) tools.append(history);
  }
 }

 if (originalRefreshChatFloating) {
  refreshChatFloating = function () {
   originalRefreshChatFloating.apply(this, arguments);
   normalizeAiHistoryButton();
  };
 }

 Object.assign(actions, {
  'cr014p-project-info': () => {
   const p = current.p;
   if (!p) return;
   hydrateAdjustment(p);
   openDialog('项目信息', `<div class="cr014p-project-info">
    <div class="cr014p-info-grid"><div><small>项目分类</small><strong>${p.type === 'code' ? '编码' : '办公'}</strong></div><div><small>负责人</small><strong>${esc(p.owner)}</strong></div><div><small>迭代</small><strong>${esc(p.iteration)}</strong></div></div>
    <section><h3>项目说明</h3><p>${esc(p.description || '暂无说明')}</p></section>
    <section><h3>${esc(p.vision.id)} · ${esc(p.vision.title)}</h3><p class="cr014p-preline">${esc(p.vision.body)}</p></section>
    <p class="muted">愿景只在此处维护，不进入需求树。</p>
   </div>`, null);
  },
  'cr014p-child': b => {
   requirementEditor(b.dataset.kind);
   const parent = dlg.querySelector('[name=parent]');
   if (parent) parent.value = b.dataset.id;
  },
  'cr014p-design-mode': b => {
   const p = current.p;
   if (!p || !['design', 'model'].includes(b.dataset.mode)) return;
   hydrateAdjustment(p);
   p.architectureView.kind = b.dataset.mode;
   const list = b.dataset.mode === 'model' ? p.models : p.designResources;
   p.architectureView.selected = list[0]?.id ?? null;
   render();
  },
  'cr014p-open-ui': () => {
   const p = current.p;
   if (!p) return;
   const item = (p.designResources ?? []).find(x => x.id === p.architectureView?.selected) ?? p.designResources?.[0] ?? null;
   const url = URL.createObjectURL(new Blob([uiMockHtml(p, item)], { type: 'text/html' }));
   window.open(url, '_blank', 'noopener,noreferrer');
   setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  'cr014p-model-locate': b => document.getElementById(`cr014p-table-${b.dataset.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  'cr014p-model-markdown': b => {
   const p = current.p;
   if (!p) return;
   const markdown = modelMarkdown(p, b.dataset.id ?? '');
   openDialog('模型 Markdown', `<p class="muted">复制以下内容交给 AI 生成建表方案；本原型不执行 SQL。</p><textarea class="cr014p-markdown" readonly aria-label="模型 Markdown">${esc(markdown)}</textarea>`, null);
   dlg.classList.add('wide');
  },
  'cr014p-model-save-desc': b => {
   const p = current.p;
   const model = p?.models.find(x => x.id === b.dataset.id);
   if (!model) return;
   const description = p.cr014pModelDrafts?.[model.id]?.description ?? model.description;
   const result = saveModel(p.id, model.id, { name: model.name, description, fields: model.fields });
   if (!result.ok) { notify(result.error); return; }
   delete p.cr014pModelDrafts[model.id];
   notify('表描述已保存为待同步草稿。');
   render();
  },
  'cr014p-explorer': b => {
   const p = current.p;
   if (!p || !['files', 'git'].includes(b.dataset.mode)) return;
   p.cr014pExplorer = b.dataset.mode;
   render();
  },
  'cr014p-open-file': b => {
   const p = current.p;
   const path = b.dataset.path;
   if (!p?.files.some(f => f.name === path)) return;
   if (p.edit && p.edit !== path) { notify(`请先保存或放弃 ${p.edit} 的编辑草稿。`); return; }
   p.file = path;
   p.cr014pExplorer = 'files';
   p.cr014pTabs = [path, ...(p.cr014pTabs ?? []).filter(x => x !== path)];
   render();
  },
  'cr014p-close-tab': b => {
   const p = current.p;
   const path = b.dataset.path;
   if (!p) return;
   const index = p.cr014pTabs?.indexOf(path) ?? -1;
   if (index < 0) return;
   p.cr014pTabs.splice(index, 1);
   if (p.file === path) p.file = p.cr014pTabs[index] ?? p.cr014pTabs[index - 1] ?? p.files[0]?.name;
   render();
  },
  'cr014p-open-git-file': b => {
   const p = current.p;
   const path = b.dataset.path;
   if (!p?.files.some(f => f.name === path)) { notify('文件不存在或已删除。'); return; }
   p.cr014pExplorer = 'files';
   p.file = path;
   p.cr014pTabs = [path, ...(p.cr014pTabs ?? []).filter(x => x !== path)];
   render();
  },
  'cr014p-git-ai': () => {
   const p = current.p;
   const g = hydrateGit(p);
   const staged = g.changes.filter(c => c.staged);
   p.gitMessage = staged.length
    ? `更新 ${staged.slice(0, 3).map(c => c.path.split('/').at(-1)).join('、')}${staged.length > 3 ? ` 等 ${staged.length} 个文件` : ''}（仿真）`
    : '整理工作区样例改动（仿真）';
   const area = document.querySelector('#git-commit-message');
   if (area) { area.value = p.gitMessage; area.focus(); }
   notify('已生成内存样例提交说明，可修改后提交。');
  },
  'cr014p-branch-expand': () => document.querySelectorAll('.cr014p-branch-group').forEach(x => { x.open = true; }),
  'cr014p-branch-collapse': () => document.querySelectorAll('.cr014p-branch-group').forEach(x => { x.open = false; }),
  'cr014p-ai-tasks': b => {
   const c = chatFor(b.dataset.key);
   const running = typeof sessionTaskRunning === 'function' && sessionTaskRunning(c);
   openDialog('当前任务', `<p>${esc(c.pending?.summary ?? (running ? '当前会话正在执行仿真任务' : '当前没有运行任务'))}</p>`, null);
  },
  'cr014p-ai-subagents': () => {
   const menu = document.querySelector('.cr014p-ai .subagent-menu');
   if (menu) { menu.open = !menu.open; menu.scrollIntoView({ block: 'nearest' }); }
   else openDialog('子代理', '<p>当前没有子代理。输入包含“并行”的需求/设计/数据库评审请求可启动演示子任务。</p>', null);
  },
  'cr014p-ai-edit': () => document.querySelector('.cr014p-ai textarea[name=message]')?.focus()
 });

 app.addEventListener('input', event => {
  const desc = event.target.closest('[data-cr014p-model-desc]');
  if (desc && current.p) {
   const p = current.p;
   p.cr014pModelDrafts ??= {};
   p.cr014pModelDrafts[desc.dataset.id] ??= {};
   p.cr014pModelDrafts[desc.dataset.id].description = desc.value;
   const card = desc.closest('.cr014p-model-card');
   const save = card?.querySelector('[data-action="cr014p-model-save-desc"]');
   if (save) save.disabled = desc.value === p.models.find(x => x.id === desc.dataset.id)?.description;
   return;
  }
  const search = event.target.closest('[data-cr014p-branch-search]');
  if (!search) return;
  const query = search.value.trim().toLowerCase();
  for (const row of document.querySelectorAll('[data-cr014p-branch]')) row.hidden = !!query && !row.dataset.cr014pBranch.includes(query);
  if (query) document.querySelectorAll('.cr014p-branch-group').forEach(x => { x.open = true; });
 });
})();
