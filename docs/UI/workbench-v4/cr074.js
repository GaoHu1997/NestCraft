/* UI-CR074-v1：同一会话组件的两种布局；纯设计演示，禁止接入真实调用。 */
window.CR074 = (() => {
  const { D, store, esc, render } = UI;
  const ranks = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const names = { off:'Off', minimal:'Minimal', low:'Low', medium:'Medium', high:'High', xhigh:'XHigh', max:'Max' };
  const aliases = { '关闭':'off', '低':'low', '中':'medium', '高':'high', '极高':'xhigh', '最高':'max', none:'off' };
  const key = value => aliases[String(value).toLowerCase()] || String(value).toLowerCase();
  const effortLabel = value => names[key(value)] || String(value);
  function efforts(model) {
    if (!model?.thinking) return [];
    // 只排序该模型声明的集合；不按添加顺序，不创造不支持的档位，不改 wire 映射。
    const source = Array.isArray(model.levels) ? model.levels : model.efforts ? Object.keys(model.efforts) : [];
    return [...new Set(source)].sort((a,b) => {
      const ra = ranks.indexOf(key(a)), rb = ranks.indexOf(key(b));
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    });
  }
  const svg = (path, cls = 'ico-14') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const spark = svg('<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z"/>');
  const thinkFlag = m => `<span class="m-cap think ${m.thinking ? 'on' : 'off'}" title="思考：${m.thinking ? '支持' : '不支持'}" aria-label="思考：${m.thinking ? '支持' : '不支持'}">${spark}</span>`;
  const compact = n => n >= 1e6 ? `${Number((n/1e6).toFixed(1))}M` : n >= 1000 ? `${Number((n/1000).toFixed(1))}K` : String(n);
  const capacity = m => Number(m.context) > 0 ? compact(Number(m.context)) : m.ctx || '—';
  const known = value => value != null && value !== '' && !/未知|未计|^—$/.test(String(value));
  /* CR-101：可信值判定。0 是可信数据、null/''/未知占位不是；判空只看它，不看消息条数。 */
  const UNKNOWN = /未知|未计|未上报|^—$/;
  const statHas = value => {
    if (value == null) return false;
    const text = String(value).trim();
    return text !== '' && !UNKNOWN.test(text);
  };
  const statJoin = parts => parts.filter(Boolean).join(' · ');
  /* CR-101：组级可见 + 字段级省略。返回按组组织的片段，未知字段不产生片段、不留「—」占位。 */
  function statsView(s = {}) {
    const t = s.tokens || {}, c = s.context || {};
    const view = {};
    // 会话组：轮与步是计数段（空格相连），TPS 是独立片段（· 相连）；生成中优先实时值。
    // 实时值始终是 token 密度估算，统一带 `~` 前缀（软件侧 CR-101 采用同一规则）。
    const counts = [statHas(s.rounds) ? `${s.rounds} 轮` : '', statHas(s.steps) ? `${s.steps} 步` : ''].filter(Boolean).join(' ');
    const speed = s.liveActive === true && statHas(s.liveTps) ? `~${String(s.liveTps).trim().replace(/^~+/, '')}`
      : statHas(s.tps) ? s.tps : '';
    const session = statJoin([counts, speed]);
    if (session) view.session = { text: session, live: !!(s.liveActive === true && statHas(s.liveTps)) };
    // Token 组：完整总量、已知部分、缓存各自独立，缺一项只省略该项。
    // 完整总量未知但已有部分字段时显示「已知 N tok」，不冒充完整累计。
    // 统计条用「缓存」两字省空间；详情浮层仍写完整「缓存命中」。
    const totalText = statHas(t.total) ? tokenLabel(t.total).replace(/^— tok$/, '')
      : statHas(t.partial) ? `已知 ${tokenLabel(t.partial).replace(/^— tok$/, '')}` : '';
    const tokens = statJoin([totalText, statHas(t.cacheHit) ? `缓存 ${t.cacheHit}` : '']);
    if (tokens) view.tokens = { text: tokens };
    // 上下文组：只有当前窗口占用可信才显示圆环组，不拿累计 token 或上限冒充。
    if (statHas(c.used)) view.context = { text: String(c.used).trim() };
    return view;
  }
  function tokenLabel(value) {
    if (!statHas(value)) return '— tok';
    const text = String(value).replace(/,/g,'').replace(/\s*tok(?:ens)?$/i,'').trim();
    if (!text) return '— tok';
    const hit = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text);
    if (hit) return compact(Number(hit[1]) * ({k:1e3,m:1e6}[hit[2].toLowerCase()] || 1)) + ' tok';
    return /tok$/i.test(String(value).trim()) ? String(value).trim() : '— tok';
  }
  function ring(value) {
    const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(String(value ?? '').trim());
    const percent = match ? Math.max(0,Math.min(100,Number(match[1]))) : null;
    return `<svg class="ico ai-context-ring" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-opacity=".2" stroke-width="2.2"/>${percent == null ? '' : `<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2.2" pathLength="100" stroke-dasharray="${percent} 100" transform="rotate(-90 10 10)"/>`}</svg>`;
  }
  function statsRow(wrap) {
    const s = D.ai.stats || {};
    const view = statsView(s);
    // CR-101 R1：三组全无可信数据时整条不渲染——不留占位、不出现只能打开空白详情的入口。
    if (!Object.keys(view).length) return '';
    const gauge = svg('<path d="M4 17a9 9 0 1 1 16 0"/><path d="m12 12 4-4"/>');
    const database = svg('<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3M5 15c0 1.7 3.1 3 7 3s7-1.3 7-3"/>');
    const cells = [
      view.session ? wrap('session','会话统计',`${gauge}${esc(view.session.text)}`) : '',
      view.tokens ? wrap('tokens','Token 用量',`${database}${esc(view.tokens.text)}`) : '',
      view.context ? wrap('context',`上下文已用 ${esc(view.context.text)}`,`${ring(view.context.text)}${esc(view.context.text)}`) : '',
    ].filter(Boolean).join('');
    return `<div class="ai-stats" ${s.simulated ? 'title="合成设计数据，非真实计量"' : ''}>${cells}</div>`;
  }
  function refreshHistory() {
    const host = document.querySelector('.ai-history');
    if (!host) return;
    const doc = new DOMParser().parseFromString(AIPanel.historyRail({inline:host.classList.contains('wb-hist')}),'text/html');
    const list = host.querySelector('.ai-history-list'), next = doc.querySelector('.ai-history-list');
    list.innerHTML = next.innerHTML;
    const count = host.querySelector('.ah-title .caption');
    if (count) count.textContent = doc.querySelector('.ah-title .caption').textContent;
    const reset = host.querySelector('.ahs-all');
    reset.disabled = !String(store.aiHistQuery || '').trim();
  }
  let timer, composing = false;
  function scheduleHistory() {
    clearTimeout(timer);
    timer = setTimeout(() => { store.aiHistLimit = 20; store.aiHistState = 'idle'; refreshHistory(); },250);
  }
  document.addEventListener('compositionstart', e => {
    if (e.target.id === 'ai-history-q') { composing = true; clearTimeout(timer); }
  },true);
  document.addEventListener('compositionend', e => {
    if (e.target.id !== 'ai-history-q') return;
    composing = false; store.aiHistQuery = e.target.value; scheduleHistory();
  },true);
  document.addEventListener('input', e => {
    if (e.target.id === 'ai-hist-rename-input') { store.aiHistEditValue = e.target.value; return; }
    if (e.target.id !== 'ai-history-q') return;
    store.aiHistQuery = e.target.value; // 原始草稿保留空格，规范化只用于查询。
    if (!composing && !e.isComposing) scheduleHistory();
  },true);
  function closeHistoryMenu() {
    if (!store.aiHistMenu) return;
    store.aiHistMenu = null;
    document.querySelectorAll('.ai-hist-menu').forEach(x => x.remove());
    document.querySelectorAll('.ai-hist-more-btn').forEach(x => x.setAttribute('aria-expanded','false'));
  }
  document.addEventListener('pointerdown', e => {
    const owner = e.target.closest('.ai-hist-menu-wrap');
    if (store.aiHistMenu && !owner?.querySelector('.ai-hist-menu')) closeHistoryMenu();
    // 只去掉菜单，不重绘页面、不拦外点、不抢搜索或输入框焦点。
  },true);
  document.addEventListener('scroll', e => {
    if (e.target?.matches?.('.ai-history-list')) closeHistoryMenu();
  },true);
  function attachActions() {
  const actions = window.__actions;
  if (!actions) return;
  actions['ai-model-provider'] = el => { store.aiModelBrowse = el.dataset.name; store.aiModelQuery = ''; render(); };
  actions['ai-model-set'] = el => {
    const cat = D.ai.modelCatalog;
    cat.current.provider = el.dataset.provider || store.aiModelBrowse || cat.current.provider;
    cat.current.model = el.dataset.name;
    const choices = efforts(AIPanel.currentModel());
    if (!choices.includes(cat.current.level)) cat.current.level = choices.find(x => key(x) === 'high') || choices[0] || '—';
    render();
  };
  const modelAction = actions['ai-model'];
  actions['ai-model'] = el => { store.aiModelBrowse = D.ai.modelCatalog.current.provider; modelAction(el); };
  actions['ai-level'] = el => { D.ai.modelCatalog.current.level = efforts(AIPanel.currentModel())[Number(el.value)]; render(); };
  actions['ai-level-label'] = el => {
    if (store.aiBusy || store.aiRuntimeBusy || !efforts(AIPanel.currentModel()).includes(el.dataset.level)) return;
    D.ai.modelCatalog.current.level = el.dataset.level; render();
  };
  actions['ai-history-all'] = () => {
    clearTimeout(timer); composing = false; store.aiHistQuery = ''; store.aiHistLimit = 20; store.aiHistState = 'idle';
    const input = document.getElementById('ai-history-q'); if (input) input.value = '';
    refreshHistory();
  };
  }
  document.addEventListener('DOMContentLoaded', attachActions, {once:true});
  return {version:'UI-CR101-v1',efforts,effortLabel,thinkFlag,capacity,statsRow,statsView,tokenLabel,refreshHistory};
})();
