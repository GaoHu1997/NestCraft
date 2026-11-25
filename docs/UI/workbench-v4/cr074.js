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
  function tokenLabel(value) {
    if (!known(value)) return '— tok';
    const text = String(value).replace(/,/g,'').replace(/\s*tok(?:ens)?$/i,'');
    const hit = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text);
    return hit ? compact(Number(hit[1]) * ({k:1e3,m:1e6}[hit[2].toLowerCase()] || 1)) + ' tok' : '— tok';
  }
  function ring(value) {
    const match = /^(\d+(?:\.\d+)?)%$/.exec(String(value));
    const percent = match ? Math.max(0,Math.min(100,Number(match[1]))) : null;
    return `<svg class="ico ai-context-ring" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-opacity=".2" stroke-width="2.2"/>${percent == null ? '' : `<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2.2" pathLength="100" stroke-dasharray="${percent} 100" transform="rotate(-90 10 10)"/>`}</svg>`;
  }
  function statsRow(wrap) {
    const s = D.ai.stats || {}, t = s.tokens || {}, c = s.context || {};
    if (!(Number(s.rounds) > 0 || known(t.total) && !/^0(?:\s+tok)?$/.test(String(t.total)))) return '<div class="ai-stats is-empty" aria-hidden="true"></div>';
    // 步数口径待确认；只有夹具明确给值才显示数，未知保留—，不能借消息数推断。
    const steps = Number.isInteger(s.steps) && s.steps >= 0 ? s.steps : '—';
    const gauge = svg('<path d="M4 17a9 9 0 1 1 16 0"/><path d="m12 12 4-4"/>');
    const database = svg('<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3M5 15c0 1.7 3.1 3 7 3s7-1.3 7-3"/>');
    return `<div class="ai-stats" ${s.simulated ? 'title="合成设计数据，非真实计量"' : ''}>
      ${wrap('session','会话统计',`${gauge}${known(s.rounds) ? esc(s.rounds) : '—'} 轮 ${steps} 步 · ${known(s.tps) ? esc(s.tps) : '— tok/s'}`)}
      ${wrap('tokens','Token 用量',`${database}${esc(tokenLabel(t.total))} · 缓存命中 ${known(t.cacheHit) ? esc(t.cacheHit) : '—'}`)}
      ${wrap('context',`上下文已用 ${known(c.used) ? c.used : '未知'}`,`${ring(c.used)}${known(c.used) ? esc(c.used) : '—'}`)}
    </div>`;
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
  return {version:'UI-CR074-v1',efforts,effortLabel,thinkFlag,capacity,statsRow,tokenLabel,refreshHistory};
})();
