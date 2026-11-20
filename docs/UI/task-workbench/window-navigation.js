/* UI-CR033-v1：固定管理首页 + 独立窗口导航设计；本稿仅页面仿真，不创建系统窗口或真实业务。 */
(() => {
  'use strict';
  const e = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KINDS = { project: '项目', knowledge: '知识库', server: '服务器' };
  const HOME_LABEL = { projects: '项目管理', knowledge: '知识库', servers: '服务器管理' };
  const TERMINAL = ['succeeded', 'failed', 'cancelled', 'blocked'];
  let host = null, records = [], active = null, homeUI = null, stripSignature = '';

  const keyOf = (kind, id) => `${kind}:${id}`;
  const find = key => records.find(r => r.key === key);
  const kindLabel = kind => KINDS[kind] || '窗口';
  function titleOf(kind, id) {
    const items = kind === 'project' ? host.projects() : kind === 'knowledge' ? host.libraries() : host.servers();
    return items.find(x => x.id === id)?.name || id;
  }
  function newUI(kind, id) {
    const base = host.defaultUI();
    const copy = { ...base, collapsed: new Set(base.collapsed || []) };
    if (kind === 'project') return Object.assign(copy, { page: 'project', projectId: id, tab: 'requirements', selectedRequirement: 'DEMO-EPIC-01' });
    if (kind === 'knowledge') return Object.assign(copy, { page: 'knowledge-lib', libId: id, note: null, knowledgeQuery: '', libraryViews: {} });
    return Object.assign(copy, { page: 'server', serverId: id });
  }
  function stash() { if (active) active.ui = host.getUI(); else homeUI = host.getUI(); }
  function apply(next) { host.setUI(next); }

  function focusDeferred(selector) {
    requestAnimationFrame(() => {
      const target = document.querySelector(selector);
      if (target) target.focus({ preventScroll: true });
      else document.querySelector(`.sidebar [aria-current="page"], .mobile-nav [aria-current="page"]`)?.focus({ preventScroll: true });
    });
  }

  function open(kind, id) {
    if (!host || !KINDS[kind] || !id) return;
    stash();
    const key = keyOf(kind, id);
    let record = find(key);
    if (!record) {
      record = { key, kind, id, title: titleOf(kind, id), ui: newUI(kind, id) };
      records.push(record);
    }
    active = record;
    apply(record.ui);
    host.render();
    focusDeferred(`[data-action="ui-window-focus"][data-id="${CSS.escape(key)}"]`);
  }

  function activate(key) {
    if (!host) return;
    if (active?.key === key) { host.render(); return; }
    stash();
    const record = find(key);
    if (!record) return;
    active = record;
    apply(record.ui);
    host.render();
    focusDeferred(`[data-action="ui-window-focus"][data-id="${CSS.escape(key)}"]`);
  }

  function homeTo(page) {
    if (!host) return;
    stash();
    active = null;
    if (page) homeUI.page = page;
    apply(homeUI);
    host.render();
    focusDeferred('[data-action="ui-window-home"]');
  }
  function home() { homeTo(null); }

  function facts(record) {
    const aux = host.getAux();
    const drafts = [];
    if (record.kind === 'project') {
      for (const name of Object.keys(aux.fileDrafts || {})) drafts.push(`文件草稿 ${name}`);
      const design = aux.projectDesignResources?.[host.state().projectId];
      for (const key of Object.keys(design?.drafts || {})) drafts.push(`设计资料草稿 ${key}`);
    }
    const running = record.kind === 'project'
      ? host.state().tasks.filter(t => !TERMINAL.includes(t.status)).length
      : 0;
    return { drafts, running };
  }

  function requestClose(key) {
    if (!host) return;
    const record = find(key || active?.key);
    if (!record) return;
    const { drafts, running } = facts(record);
    if (!drafts.length && !running) { close(record.key); host.toast(`已关闭「${kindLabel(record.kind)} · ${record.title}」窗口`); return; }
    const lines = [];
    if (drafts.length) lines.push(`<li><strong>${drafts.length} 处未保存草稿</strong>将随窗口关闭丢弃，不会自动保存：${drafts.map(e).join('、')}</li>`);
    if (running) lines.push(`<li><strong>${running} 个运行中的任务会继续在后台执行</strong>；关闭窗口不会停止、取消或重置任务。</li>`);
    const body = `<p>关闭「${kindLabel(record.kind)} · ${e(record.title)}」只影响本窗口的页面状态；管理首页和其他窗口保持原状态。</p><ul class="window-close-list">${lines.join('')}</ul><p class="muted">演示稿不执行真实保存、任务终止或连接关闭。</p>`;
    const footer = `<button type="button" class="btn sm" data-action="close-dialog">取消</button><button type="button" class="btn sm danger" data-action="ui-window-close-confirm" data-id="${e(record.key)}">关闭窗口</button>`;
    host.openDialog('关闭窗口？', body, footer, 'window-close');
  }

  function discardDrafts(record) {
    const aux = host.getAux();
    if (record.kind !== 'project') return;
    aux.fileDrafts = {};
    const design = aux.projectDesignResources?.[host.state().projectId];
    if (design?.drafts) design.drafts = {};
    host.saveAux();
  }

  function close(key, options = {}) {
    if (!host) return;
    const record = find(key);
    if (!record) return;
    if (options.discard) discardDrafts(record);
    records = records.filter(r => r !== record);
    if (active === record) { active = null; apply(homeUI); }
    host.render();
    focusDeferred('[data-action="ui-window-home"]');
  }

  function reset() {
    records = []; active = null; stripSignature = '';
    if (host) homeUI = host.getUI();
  }

  function renderStrip() {
    const strip = document.querySelector('#window-strip');
    if (!strip) return;
    strip.hidden = records.length === 0;
    const homeLabel = HOME_LABEL[homeUI.page] || '管理首页';
    const signature = `${records.map(r => r.key + '|' + r.title).join('~')}#${active?.key || 'home'}#${homeLabel}`;
    if (signature === stripSignature) return;
    stripSignature = signature;
    strip.innerHTML = `<span class="window-strip-caption">窗口</span>` +
      `<span class="window-chip${active ? '' : ' is-active'}"><button type="button" data-action="ui-window-home" aria-current="${active ? 'false' : 'page'}">首页 · ${e(homeLabel)}</button></span>` +
      records.map(r => `<span class="window-chip${active?.key === r.key ? ' is-active' : ''}"><button type="button" data-action="ui-window-focus" data-id="${e(r.key)}" aria-current="${active?.key === r.key ? 'page' : 'false'}"><span class="window-chip-kind">${kindLabel(r.kind)}</span><strong>${e(r.title)}</strong></button><button type="button" class="window-chip-close" data-action="ui-window-close" data-id="${e(r.key)}" aria-label="关闭窗口 ${e(r.title)}">×</button></span>`).join('');
  }

  function renderBar() {
    const bar = document.querySelector('#window-bar');
    if (!bar) return;
    bar.hidden = !active;
    if (!active) return;
    document.querySelector('#window-kind').textContent = kindLabel(active.kind);
    document.querySelector('#window-title').textContent = active.title;
    document.querySelector('#window-id').textContent = active.id;
    const closeButton = document.querySelector('#window-close');
    if (closeButton) { closeButton.dataset.id = active.key; closeButton.setAttribute('aria-label', `关闭窗口 ${active.title}`); }
  }

  function sync() {
    if (!host) return;
    const mode = active ? 'window' : 'home';
    document.documentElement.dataset.workspaceMode = mode;
    document.documentElement.style.setProperty('--window-strip-h', records.length ? '40px' : '0px');
    renderStrip();
    renderBar();
    if (document.querySelector('#view')) document.querySelector('#view').dataset.windowKey = active?.key || '';
  }

  function attach(h) {
    host = h;
    homeUI = h.getUI();
    records = []; active = null; stripSignature = '';
  }

  window.WindowNav = Object.freeze({
    attach, open, activate, home, homeTo, requestClose, close, sync, reset,
    active: () => active ? { key: active.key, kind: active.kind, id: active.id, title: active.title } : null,
    list: () => records.map(r => ({ key: r.key, kind: r.kind, id: r.id, title: r.title })),
    mode: () => active ? 'window' : 'home',
    version: 'UI-CR033-v1'
  });
})();