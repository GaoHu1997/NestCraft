/* CR-014 设置中心：经典脚本，须在原型的全局脚本之后载入。
   仅覆盖 settingsPane 及其设置内部视图，不改动 render、assistantPanel 或路由。 */
(() => {
 'use strict';
 if (window.__cr014SettingsLoaded) return;
 if (typeof state === 'undefined' || typeof settingsPane !== 'function' || typeof actions !== 'object') return;
 window.__cr014SettingsLoaded = true;

 const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
 const pct = value => `${Math.round((Number(value) || 0) * 100)}%`;
 const draftMap = new Map();
 const pendingNewProviders = new Set();
 const fingerprintMap = new Map();
 const providerBaseline = new Map();
 for (const provider of Array.isArray(state.providers) ? state.providers : []) providerBaseline.set(provider.id, clone(provider));
 let lastSettingsTrigger = null;

 const EFFORT_OPTIONS = [
  ['关闭', 'off'], ['低', 'minimal'], ['中', 'low'], ['高', 'medium'],
  ['较高', 'high'], ['极高', 'xhigh'], ['最大', 'max']
 ];
 const EFFORT_DISPLAY = new Map([
  ['关闭', 'off'], ['低', 'minimal'], ['中', 'low'], ['高', 'medium'],
  ['较高', 'high'], ['极高', 'xhigh'], ['最大', 'max']
 ]);
 const EFFORT_VALUES = EFFORT_OPTIONS.map(([value]) => value);
 const API_MODES = [['chat', 'Chat'], ['responses', 'Responses'], ['anthropic', 'Anthropic'], ['gemini', 'Gemini API']];

 function ensureUiSettings() {
  state.uiSettings ??= {};
  const ui = state.uiSettings;
  if (typeof ui.nickname !== 'string') ui.nickname = '林澈';
  if (typeof ui.email !== 'string') ui.email = 'linche@example.local';
  if (typeof ui.avatar !== 'string') ui.avatar = '林';
  if (!['light', 'dark', 'system'].includes(ui.appearance)) ui.appearance = themeName();
  if (!Number.isFinite(ui.fontSize)) ui.fontSize = 13;
  if (![2, 4, 'tab'].includes(ui.indent)) ui.indent = 2;
  if (typeof ui.lineNumbers !== 'boolean') ui.lineNumbers = true;
  if (typeof ui.wrap !== 'boolean') ui.wrap = false;
  return ui;
 }

 function pruneDrafts() {
  const ids = new Set((state.providers ?? []).map(provider => provider.id));
  for (const id of draftMap.keys()) if (!ids.has(id)) draftMap.delete(id);
 }

 function draftFor(provider) {
  let draft = draftMap.get(provider.id);
  if (!draft) {
   draft = { p: clone(provider), dirty: false, error: '', notice: '', addingKey: false, keyForm: { label: '', value: '' }, modelOpen: {} };
   draftMap.set(provider.id, draft);
  }
  return draft;
 }

 function markDirty(draft) {
  draft.dirty = true;
  draft.error = '';
 }

 function apiModeOf(provider) {
  if (provider.apiStyle) return provider.apiStyle;
  return provider.protocol === 'anthropic' ? 'anthropic' : 'chat';
 }

 function applyApiMode(provider, mode) {
  provider.apiStyle = mode;
  provider.protocol = mode === 'anthropic' ? 'anthropic' : 'openai';
 }

 function fmtCapacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  for (const [suffix, multiplier] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) {
   if (number % multiplier === 0) return `${number / multiplier}${suffix}`;
  }
  return String(number);
 }

 function parseCapacity(text) {
  const raw = String(text ?? '').trim().replaceAll(',', '');
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return null;
  const multiplier = match[2] ? ({ k: 1e3, m: 1e6, b: 1e9 })[match[2].toLowerCase()] : 1;
  const number = Number(match[1]) * multiplier;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
 }

 function switchButton(label, action, checked, data = '') {
  return `<button type="button" class="cr014s-switch" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-label="${esc(label)}" data-action="${action}" ${data}><span aria-hidden="true"></span></button>`;
 }

 function actionButton(label, action, data = '', tone = '') {
  return `<button type="button" class="cr014s-btn ${tone}" data-action="${action}" ${data}>${esc(label)}</button>`;
 }

 function iconButton(label, action, data = '', icon = 'plus', tone = '') {
  return `<button type="button" class="cr014s-iconbtn ${tone}" data-action="${action}" ${data} aria-label="${esc(label)}" title="${esc(label)}">${settingsIcon(icon)}</button>`;
 }

 const ICON_PATHS = {
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z',
  edit: 'M4 16.5V20h3.5L18.1 9.4l-3.5-3.5L4 16.5Zm14.8-9.8a1 1 0 0 0 0-1.4l-1.1-1.1a1 1 0 0 0-1.4 0l-1.2 1.2 3.5 3.5 1.2-1.2Z',
  trash: 'M7 7h10l-.7 13H7.7L7 7Zm2-4h6l1 2h4v2H4V5h4l1-2Z',
  copy: 'M8 7h11v13H8V7Zm-2 2H4V4h11v2',
  chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6', up: 'm6 15 6-6 6 6',
  refresh: 'M18.7 7.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.1-3.5L14 11h7V4l-2.3 3.3Z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3h2v10H5V10h2Zm2 0h6V7a3 3 0 0 0-6 0v3Z',
  warning: 'M12 3 2 21h20L12 3Zm0 5 6 11H6l6-11Zm-1 4v4h2v-4h-2Zm0 5v2h2v-2h-2Z'
 };

 function settingsIcon(name) {
  return `<svg class="cr014s-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name] ?? ICON_PATHS.plus}"/></svg>`;
 }

 function generalPane() {
  const ui = ensureUiSettings();
  const modes = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
  return `<div class="cr014s-pane cr014s-general">
   <section class="cr014s-card" aria-labelledby="cr014s-user-title">
    <div class="cr014s-card-head"><div><h3 id="cr014s-user-title">用户信息</h3><p>仅保存在当前页面的内存中，刷新后恢复样例值。</p></div><span class="cr014s-avatar" data-cr014s-avatar-preview>${esc(ui.avatar || ui.nickname.slice(0, 1) || '林')}</span></div>
    <div class="cr014s-formgrid">
     <label class="cr014s-field"><span>昵称</span><input value="${esc(ui.nickname)}" data-cr014s-field="nickname" maxlength="40" autocomplete="nickname"></label>
     <label class="cr014s-field"><span>邮箱</span><input type="email" value="${esc(ui.email)}" data-cr014s-field="email" maxlength="80" autocomplete="email"></label>
     <label class="cr014s-field"><span>头像字母</span><input value="${esc(ui.avatar)}" data-cr014s-field="avatar" maxlength="2" aria-describedby="cr014s-avatar-help"></label>
     <small id="cr014s-avatar-help" class="cr014s-hint">用于本地头像预览，最多两个字符。</small>
    </div>
   </section>
   <section class="cr014s-card" aria-labelledby="cr014s-theme-title">
    <div class="cr014s-card-head"><div><h3 id="cr014s-theme-title">外观设置</h3><p>接入现有主题切换；“跟随系统”会监听系统深浅色变化。</p></div></div>
    <div class="cr014s-segment" role="group" aria-label="外观模式">${modes.map(([mode, label]) => `<button type="button" class="cr014s-segment-item" aria-pressed="${ui.appearance === mode}" data-action="cr014s-theme" data-mode="${mode}">${esc(label)}</button>`).join('')}</div>
   </section>
   <section class="cr014s-card" aria-labelledby="cr014s-code-title">
    <div class="cr014s-card-head"><div><h3 id="cr014s-code-title">代码样式</h3><p>只保存本页的展示偏好，不修改项目文件。</p></div></div>
    <div class="cr014s-formgrid cr014s-code-grid">
     <label class="cr014s-field"><span>字号</span><select data-cr014s-change="code-font">${[12, 13, 14, 15, 16].map(size => `<option value="${size}" ${ui.fontSize === size ? 'selected' : ''}>${size}px</option>`).join('')}</select></label>
     <label class="cr014s-field"><span>缩进</span><select data-cr014s-change="code-indent"><option value="2" ${ui.indent === 2 ? 'selected' : ''}>2 个空格</option><option value="4" ${ui.indent === 4 ? 'selected' : ''}>4 个空格</option><option value="tab" ${ui.indent === 'tab' ? 'selected' : ''}>Tab</option></select></label>
     <div class="cr014s-switch-row"><span>显示行号</span>${switchButton('显示行号', 'cr014s-code-toggle', ui.lineNumbers, 'data-key="lineNumbers"')}</div>
     <div class="cr014s-switch-row"><span>自动换行</span>${switchButton('自动换行', 'cr014s-code-toggle', ui.wrap, 'data-key="wrap"')}</div>
    </div>
   </section>
  </div>`;
 }

 function eligibleModels(provider) {
  return (provider.models ?? []).filter(model => /gpt|claude/i.test(`${model.name} ${model.displayName ?? ''}`));
 }

 function fingerprintKey(provider, model) {
  return `${provider.id}::${model.name}`;
 }

 function sampleFingerprint(provider, model) {
  const family = /claude/i.test(model.name) ? 'Claude 系列' : 'GPT 系列';
  let seed = 0;
  for (const char of `${provider.id}:${model.name}`) seed = (seed * 31 + char.charCodeAt(0)) % 233280;
  const probability = 0.78 + (seed % 170) / 1000;
  const similarity = Math.min(0.96, probability + 0.04 + (seed % 40) / 1000);
  const names = eligibleModels(provider).map(item => item.displayName || item.name);
  const candidates = (names.length ? names : [model.displayName || model.name]).slice(0, 3).map((name, index) => ({
   name,
   probability: Math.max(0.08, probability - index * (0.16 + (seed % 17) / 100))
  }));
  return { family, probability, similarity, candidates, duration: `${720 + (seed % 430)} ms`, checkedAt: when() };
 }

 function providerFingerprintPane14(provider) {
  const models = eligibleModels(provider);
  const running = models.some(model => fingerprintMap.get(fingerprintKey(provider, model))?.state === 'running');
  const rows = models.map(model => {
   const key = fingerprintKey(provider, model);
   const record = fingerprintMap.get(key);
   const busy = record?.state === 'running';
   const done = record?.state === 'done';
   return `<div class="cr014s-fp-row" data-fp-model="${esc(model.name)}">
    <div class="cr014s-fp-head"><div><strong>${esc(model.displayName || model.name)}</strong><small>${esc(/claude/i.test(model.name) ? 'Claude 系列' : 'GPT 系列')} · 固定样例</small></div>${busy ? '<span class="cr014s-badge is-running">检测中</span>' : done ? '<span class="cr014s-badge is-done">已检测</span>' : '<span class="cr014s-badge">未检测</span>'}<button type="button" class="cr014s-btn cr014s-primary" data-action="cr014s-fp-run" data-provider="${provider.id}" data-model-id="${esc(model.id)}" ${busy ? 'disabled' : ''}>${busy ? '检测中…' : done ? '重测' : '检测'}</button></div>
    ${done ? `<details class="cr014s-fp-details"><summary>结果 · 家族概率 ${pct(record.probability)} · 相似度 ${pct(record.similarity)}</summary><div class="cr014s-fp-body">
     <div class="cr014s-fp-metrics"><span>家族概率 <strong>${esc(record.family)} ${pct(record.probability)}</strong></span><span>相似度 <strong>${pct(record.similarity)}</strong></span><span>候选条 <strong>${record.candidates.length}</strong></span><span>耗时 <strong>${esc(record.duration)}</strong></span><span>检测时间 <strong>${esc(record.checkedAt)}</strong></span></div>
     <div class="cr014s-fp-bars">${record.candidates.map(candidate => `<div class="cr014s-fp-bar"><span>${esc(candidate.name)}</span><i><b style="width:${Math.max(3, Math.round(candidate.probability * 100))}%"></b></i><strong>${pct(candidate.probability)}</strong></div>`).join('')}</div>
    </div></details>` : ''}
   </div>`;
  }).join('') || empty('仅 GPT / Claude 系列模型会出现在这里。');
  return `<div class="cr014s-fp-pane">
   <div class="cr014s-sectionhead"><div><h3>指纹检测</h3><p>${models.length} 个可检测模型 · GPT / Claude 系列</p></div><button type="button" class="cr014s-btn cr014s-quiet" data-action="cr014s-fp-all" data-provider="${provider.id}" ${running ? 'disabled' : ''}>检测全部</button></div>
   <p class="cr014s-simnote">固定样例 · 不证明模型真实身份 · 不发起真实请求。通过与否都不自动改写模型能力。</p>
   <div class="cr014s-fp-list">${rows}</div>
  </div>`;
 }

 function settingsPane14(tab) {
  pruneDrafts();
  if (tab === 'general') return generalPane();
  if (tab === 'models') return providerSection14();
  if (tab === 'sdk') return sdkSection14();
  if (tab === 'skill' || tab === 'mcp' || tab === 'tool') return capabilityPane(tab);
  return '';
 }

 function capabilityPane(tab) {
  const group = tab === 'tool' ? 'tools' : tab;
  const items = state[group] ?? [];
  const titles = { skill: 'Skill', mcp: 'MCP', tools: 'Tool' };
  const create = tab === 'skill' ? actionButton('新建 Skill', 'cr014s-skill-new', '', 'cr014s-primary')
   : tab === 'mcp' ? actionButton('新建 MCP', 'cr014s-mcp-new', '', 'cr014s-primary') : '';
  const rows = items.map(item => {
   const risk = tab === 'tool' ? `<span class="cr014s-badge ${item.risk === '高' ? 'is-warn' : item.risk === '中' ? 'is-mid' : ''}">${esc(item.risk ?? '低')}风险</span>` : '';
   const note = tab === 'mcp' ? (item.on ? '模拟已连接' : '未连接') : `${item.count ?? 0} 次调用`;
   return `<div class="cr014s-listrow">
    <div class="cr014s-listmain"><h3>${esc(item.id)}</h3><p>${esc(item.info)} · ${note}</p></div>
    <div class="cr014s-listactions">${risk}${switchButton(`${item.id} 启用`, 'toggle', !!item.on, `data-group="${group}" data-id="${esc(item.id)}"`)}</div>
   </div>`;
  }).join('') || empty(`尚无 ${titles[tab]} 条目。`);
  return `<div class="cr014s-pane cr014s-capability">
   <div class="cr014s-sectionhead"><div><h3>${titles[tab]}</h3><p>${items.length} 项</p></div>${create}</div>
   <div class="cr014s-list">${rows}</div>
   ${tab === 'mcp' ? '<p class="cr014s-simnote">MCP 创建只保存 stdio / HTTP 配置样例，不启动进程、不连接外部服务。</p>' : ''}
  </div>`;
 }

 function providerSection14() {
  pruneDrafts();
  return `<div class="cr014s-pane cr014s-providers">
   <div class="cr014s-sectionhead">
    <div><h3>第三方供应商</h3></div>
    ${actionButton('添加供应商', 'provider-new', '', 'cr014s-primary')}
   </div>
   <div class="cr014s-provider-list" data-provider-list>${state.providers.map(providerCard14).join('') || empty('尚无供应商配置。')}</div>
   <p class="cr014s-simnote">本地仿真：密钥、端点与模型只为界面样例，不保存真实凭证，也不发起网络请求。</p>
  </div>`;
 }

 function providerCard14(provider) {
  const draft = draftMap.get(provider.id);
  const view = draft?.p ?? provider;
  const ready = !view.disabled && providerReady(view);
  const modelCount = (view.models ?? []).filter(model => model.text && !model.imageGen).length;
  const confirm = provider.confirmDelete ? `<div class="cr014s-confirm" role="alertdialog" aria-label="确认删除供应商"><p>删除「${esc(view.name)}」及其 ${(view.models ?? []).length} 个模型条目？使用这些模型的会话会提示模型不可用，历史消息保留。</p><div class="cr014s-actions">${actionButton('确认删除', 'provider-delete-confirm', `data-provider="${provider.id}"`, 'cr014s-danger-solid')}${actionButton('取消', 'provider-delete-cancel', `data-provider="${provider.id}"`, 'cr014s-quiet')}</div></div>` : '';
  return `<article class="cr014s-provider-card ${provider.expanded ? 'is-open' : ''}" data-provider-card="${provider.id}">
   <div class="cr014s-provider-head" data-provider="${provider.id}" data-provider-disabled="${view.disabled}">
    <span class="cr014s-grip" aria-hidden="true" title="拖动排序（仿真）"></span>
    <div class="cr014s-provider-title"><strong>${esc(view.name)}</strong><span class="cr014s-minitag">${esc(view.customLabel || '自定义')}</span>${draft?.dirty ? '<span class="cr014s-unsaved">未保存</span>' : ''}</div>
    <span class="cr014s-dot ${ready ? 'is-ready' : ''}" title="${ready ? '配置可用' : '配置不完整或已停用'}" aria-label="${ready ? '配置可用' : '配置不完整或已停用'}"></span>
    <span class="cr014s-provider-meta">${modelCount} 个对话模型</span>
    <div class="cr014s-provider-actions">
     ${switchButton(`${view.name} 启用`, 'provider-toggle', !view.disabled, `data-provider="${provider.id}"`)}
     <button type="button" class="cr014s-btn cr014s-edit" data-action="provider-edit" data-provider="${provider.id}" aria-expanded="${!!provider.expanded}">${settingsIcon('edit')}编辑</button>
     <button type="button" class="cr014s-btn cr014s-delete" data-action="provider-delete" data-provider="${provider.id}">${settingsIcon('trash')}删除</button>
    </div>
   </div>
   ${confirm}
   ${provider.expanded ? providerEditor14(provider) : ''}
  </article>`;
 }

 function providerEditor14(provider) {
  const draft = draftFor(provider);
  const view = draft.p;
  const tabs = [['provider', '供应商配置'], ['models', '模型配置'], ['advanced', '高级配置'], ['fingerprint', '指纹检测']];
  const tab = tabs.some(([key]) => key === provider.tab) ? provider.tab : 'provider';
  const pane = tab === 'provider' ? providerConfigPane14(view, draft)
   : tab === 'models' ? providerModelsPane14(view, draft)
   : tab === 'advanced' ? providerAdvancedPane14(view, draft)
   : providerFingerprintPane14(view, draft);
  const footer = tab === 'fingerprint' ? ''
   : tab === 'models'
    ? `<footer class="cr014s-editor-foot">${actionButton('放弃修改', 'cr014s-models-discard', `data-provider="${provider.id}"`, 'cr014s-quiet')}<span class="cr014s-foot-note">保存后才会更新会话有效配置</span>${actionButton('保存', 'cr014s-provider-save', `data-provider="${provider.id}"`, 'cr014s-primary')}</footer>`
    : `<footer class="cr014s-editor-foot">${actionButton('取消', 'cr014s-provider-cancel', `data-provider="${provider.id}"`, 'cr014s-quiet')}<span class="cr014s-foot-note">未保存不会污染会话有效配置</span>${actionButton('保存', 'cr014s-provider-save', `data-provider="${provider.id}"`, 'cr014s-primary')}</footer>`;
  return `<div class="cr014s-editor" data-provider-editor="${provider.id}">
   <div class="cr014s-tabs" role="tablist" aria-label="${esc(view.name)} 编辑分类">${tabs.map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === tab}" data-action="provider-tab" data-provider="${provider.id}" data-tab="${key}">${esc(label)}</button>`).join('')}</div>
   <div class="cr014s-editor-body" data-editor-pane="${tab}">${pane}${draft.notice ? `<p class="cr014s-notice" role="status">${esc(draft.notice)}</p>` : ''}${draft.error ? `<p class="cr014s-error" role="alert">${esc(draft.error)}</p>` : ''}</div>
   ${footer}
  </div>`;
 }

 function providerConfigPane14(provider, draft) {
  const mode = apiModeOf(provider);
  const keys = (provider.keys ?? []).map((key, index) => {
   const scoped = Array.isArray(key.models) ? key.models : [];
   const scope = key.scopeOpen ? `<div class="cr014s-keyscope"><p>按模型分配；不勾选表示该密钥可服务全部模型。</p><div class="cr014s-scope-list">${(provider.models ?? []).map(model => `<label class="cr014s-check"><input type="checkbox" data-cr014s-change="key-model" data-provider="${provider.id}" data-index="${index}" data-model-id="${esc(model.id)}" ${scoped.includes(model.id) ? 'checked' : ''}> <span>${esc(model.displayName || model.name)}</span></label>`).join('') || '<span class="cr014s-hint">尚无模型可分配。</span>'}</div></div>` : '';
   return `<div class="cr014s-keywrap" data-key-row="${esc(key.id)}">
    <div class="cr014s-keyrow" role="row">
     <label class="cr014s-check"><input type="checkbox" data-cr014s-change="key-enabled" data-provider="${provider.id}" data-index="${index}" ${key.enabled ? 'checked' : ''} aria-label="启用密钥 ${esc(key.label || index + 1)}"></label>
     <input class="cr014s-input" value="${esc(key.label || '')}" data-cr014s-field="key-label" data-provider="${provider.id}" data-index="${index}" aria-label="密钥名称" maxlength="40">
     <code class="cr014s-mask">${esc(maskKey(key.value))}</code>
     <button type="button" class="cr014s-btn cr014s-quiet" data-action="cr014s-key-copy" data-provider="${provider.id}" data-index="${index}">${settingsIcon('copy')}复制</button>
     <button type="button" class="cr014s-btn cr014s-quiet" data-action="cr014s-key-scope" data-provider="${provider.id}" data-index="${index}" aria-expanded="${!!key.scopeOpen}">按模型分配</button>
     <span class="cr014s-keycount">${scoped.length ? `${scoped.length} 个模型` : '全部模型'}</span>
     ${iconButton('删除密钥', 'key-remove', `data-provider="${provider.id}" data-index="${index}"`, 'trash', 'cr014s-icon-danger')}
    </div>
    ${scope}
   </div>`;
  }).join('') || empty('尚无密钥；没有可用密钥的供应商不会出现在会话候选。');
  const endpoints = (provider.endpoints ?? []).map((endpoint, index) => `<div class="cr014s-endpoint" data-endpoint="${esc(endpoint.id)}">
   <label class="cr014s-check"><input type="checkbox" data-cr014s-change="endpoint-enabled" data-provider="${provider.id}" data-index="${index}" ${endpoint.enabled ? 'checked' : ''} aria-label="启用端点 ${index + 1}"></label>
   <input class="cr014s-input cr014s-endpoint-url" value="${esc(endpoint.url)}" data-cr014s-field="endpoint-url" data-provider="${provider.id}" data-index="${index}" aria-label="API 地址 ${index + 1}" maxlength="160">
   ${iconButton('删除端点', 'endpoint-remove', `data-provider="${provider.id}" data-index="${index}"`, 'trash', 'cr014s-icon-danger')}
  </div>`).join('') || empty('尚无端点；至少保留一条启用端点才能使用该供应商。');
  const keyForm = draft.addingKey ? `<div class="cr014s-keynew">
   <input class="cr014s-input" value="${esc(draft.keyForm.label)}" data-cr014s-field="key-new-label" data-provider="${provider.id}" placeholder="密钥名称" aria-label="新密钥名称" maxlength="40">
   <input class="cr014s-input" value="${esc(draft.keyForm.value)}" data-cr014s-field="key-new-value" data-provider="${provider.id}" placeholder="sk-...（仅内存样例）" aria-label="新密钥值" maxlength="120">
   ${actionButton('添加', 'cr014s-key-create', `data-provider="${provider.id}"`, 'cr014s-primary')}
   ${actionButton('取消', 'cr014s-key-cancel', `data-provider="${provider.id}"`, 'cr014s-quiet')}
  </div>` : '';
  return `<div class="cr014s-config-pane">
   <label class="cr014s-field"><span>显示名称</span><input class="cr014s-input" value="${esc(provider.name)}" data-cr014s-field="provider-name" data-provider="${provider.id}" maxlength="40" aria-label="供应商显示名称"></label>
   <div class="cr014s-block">
    <div class="cr014s-block-head"><div><h4>API 密钥</h4><span>勾选即启用；复制只复制本地样例值。</span></div>${actionButton('添加密钥', 'key-add', `data-provider="${provider.id}"`, 'cr014s-quiet')}</div>
    <div class="cr014s-keytable" role="table" aria-label="API 密钥列表">${keys}</div>
    ${keyForm}
   </div>
   <div class="cr014s-block">
    <div class="cr014s-block-head"><div><h4>API 协议</h4><span>仅切换本地协议标签与模型过滤族。</span></div></div>
    <div class="cr014s-segment" role="group" aria-label="API 协议">${API_MODES.map(([key, label]) => `<button type="button" class="cr014s-segment-item" aria-pressed="${mode === key}" data-action="cr014s-protocol" data-provider="${provider.id}" data-protocol="${key}">${esc(label)}</button>`).join('')}</div>
   </div>
   <div class="cr014s-block">
    <div class="cr014s-block-head"><div><h4>API 地址</h4><span>可配置多条端点，重复启用地址会被拒绝。</span></div>${actionButton('添加端点', 'endpoint-add', `data-provider="${provider.id}"`, 'cr014s-quiet')}</div>
    <div class="cr014s-endpoints">${endpoints}</div>
   </div>
  </div>`;
 }

 function providerModelsPane14(provider, draft) {
  const rows = (provider.models ?? []).map((model, index) => {
   const open = !!draft.modelOpen?.[model.id];
   const levels = Array.isArray(model.efforts) ? model.efforts : [];
   const thinking = levels.length > 0;
   const selectedLevels = EFFORT_OPTIONS.filter(([value]) => levels.includes(value));
   const mapping = selectedLevels.length ? `<details class="cr014s-map"><summary>映射</summary><div class="cr014s-map-body">${selectedLevels.map(([value]) => `<label class="cr014s-wire"><span>${esc(EFFORT_DISPLAY.get(value) ?? value)}</span><input class="cr014s-input" value="${esc(model.effortMap?.[value] ?? '')}" data-cr014s-field="effort-wire" data-provider="${provider.id}" data-index="${index}" data-level="${esc(value)}" placeholder="wire 值（仿真）" maxlength="40"></label>`).join('')}</div></details>` : '';
   return `<article class="cr014s-model ${open ? 'is-open' : ''}" data-model-row="${esc(model.id)}">
    <div class="cr014s-model-main">
     <span class="cr014s-grip" aria-hidden="true" title="拖动排序（仿真）"></span>
     <input class="cr014s-input cr014s-model-id" value="${esc(model.name)}" data-cr014s-field="model-id" data-provider="${provider.id}" data-index="${index}" aria-label="模型 ID" maxlength="80">
     <input class="cr014s-input" value="${esc(model.displayName || model.name)}" data-cr014s-field="model-display" data-provider="${provider.id}" data-index="${index}" aria-label="显示名称" maxlength="80">
     <button type="button" class="cr014s-iconbtn" data-action="cr014s-model-expand" data-provider="${provider.id}" data-index="${index}" data-model-id="${esc(model.id)}" aria-expanded="${open}" aria-label="${open ? '收起模型' : '展开模型'}" title="${open ? '收起模型' : '展开模型'}">${settingsIcon(open ? 'up' : 'down')}</button>
     ${iconButton('删除模型', 'model-row-remove', `data-provider="${provider.id}" data-index="${index}"`, 'trash', 'cr014s-icon-danger')}
    </div>
    ${open ? `<div class="cr014s-model-body">
     <div class="cr014s-model-line"><span class="cr014s-label">输入模态</span><div class="cr014s-chipgroup" role="group" aria-label="输入模态">${[['text', '文本'], ['vision', '图片'], ['imageGen', '生图']].map(([key, label]) => `<button type="button" class="cr014s-chip" aria-pressed="${key === 'text' ? !!model.text : key === 'vision' ? !!model.vision : !!model.imageGen}" data-action="cr014s-model-modality" data-provider="${provider.id}" data-index="${index}" data-modality="${key}">${label}</button>`).join('')}</div><span class="cr014s-hint">文本与生图互斥</span></div>
     <div class="cr014s-model-line"><span class="cr014s-label">思考</span>${switchButton('思考', 'cr014s-model-thinking', thinking, `data-provider="${provider.id}" data-index="${index}" ${model.imageGen ? 'disabled' : ''}`)}<span class="cr014s-hint">关闭后不发送思考档位</span></div>
     <div class="cr014s-effortrow" role="group" aria-label="思考等级多选">${EFFORT_OPTIONS.map(([value]) => `<button type="button" class="cr014s-effort" aria-pressed="${levels.includes(value)}" data-action="cr014s-model-level" data-provider="${provider.id}" data-index="${index}" data-level="${esc(value)}" ${thinking && !model.imageGen ? '' : 'disabled'}>${esc(EFFORT_DISPLAY.get(value) ?? value)}</button>`).join('')}</div>
     ${mapping}
     <div class="cr014s-model-line"><label class="cr014s-field cr014s-inline-field"><span>默认强度</span><select data-cr014s-change="model-default" data-provider="${provider.id}" data-index="${index}" ${thinking ? '' : 'disabled'}><option value="" ${!model.defaultEffort ? 'selected' : ''}>跟随记忆</option>${selectedLevels.map(([value]) => `<option value="${esc(value)}" ${model.defaultEffort === value ? 'selected' : ''}>${esc(EFFORT_DISPLAY.get(value) ?? value)}</option>`).join('')}</select></label></div>
     <div class="cr014s-capacity">
      <label class="cr014s-field"><span>上下文窗口</span><input class="cr014s-input" value="${esc(model.contextWindowText ?? fmtCapacity(model.contextWindow))}" data-cr014s-field="model-context" data-provider="${provider.id}" data-index="${index}" placeholder="如 128K" aria-label="上下文窗口"></label>
      <label class="cr014s-field"><span>最大输出 tokens</span><input class="cr014s-input" value="${esc(model.maxOutputText ?? fmtCapacity(model.maxOutput))}" data-cr014s-field="model-output" data-provider="${provider.id}" data-index="${index}" placeholder="如 16K" aria-label="最大输出 tokens"></label>
      <span class="cr014s-hint">支持 K / M / B 简写</span>
     </div>
    </div>` : ''}
   </article>`;
  }).join('') || empty('尚无模型条目；没有对话模型的供应商不会出现在会话候选。');
  return `<div class="cr014s-models-pane">
   <div class="cr014s-toolbar">
    ${actionButton('恢复默认模型', 'cr014s-models-restore', `data-provider="${provider.id}"`, 'cr014s-quiet')}
    ${actionButton('获取可用模型', 'cr014s-models-fetch', `data-provider="${provider.id}"`, 'cr014s-quiet')}
    ${actionButton('自动获取思考等级', 'cr014s-models-autoeffort', `data-provider="${provider.id}"`, 'cr014s-quiet')}
   </div>
   <p class="cr014s-simnote">本地仿真：以上按钮不会发起真实请求；只恢复本站样例或给出本地建议。</p>
   <div class="cr014s-model-list">${rows}</div>
   <div class="cr014s-actions">${actionButton('新增模型', 'model-row-add', `data-provider="${provider.id}"`, 'cr014s-quiet')}</div>
   <p class="cr014s-hint">生图模型不服务对话；默认档位必须属于已选档位，留空表示“跟随记忆”。</p>
  </div>`;
 }

 function providerAdvancedPane14(provider) {
  const disguise = provider.disguise ?? 'off';
  const headers = (provider.headers ?? []).map((header, index) => `<div class="cr014s-header-row">
   <input class="cr014s-input" value="${esc(header.name)}" data-cr014s-field="header-name" data-provider="${provider.id}" data-index="${index}" placeholder="名称" aria-label="请求头名称 ${index + 1}" maxlength="60">
   <input class="cr014s-input" value="${esc(header.value)}" data-cr014s-field="header-value" data-provider="${provider.id}" data-index="${index}" placeholder="值" aria-label="请求头值 ${index + 1}" maxlength="160">
   ${iconButton('删除请求头', 'header-remove', `data-provider="${provider.id}" data-index="${index}"`, 'trash', 'cr014s-icon-danger')}
  </div>`).join('') || empty('尚无自定义请求头。');
  return `<div class="cr014s-advanced-pane">
   <section class="cr014s-block">
    <div class="cr014s-block-head"><div><h4>请求头</h4><span>名称和值只保存在内存草稿。</span></div>${actionButton('新增请求头', 'header-add', `data-provider="${provider.id}"`, 'cr014s-quiet')}</div>
    <div class="cr014s-headers">${headers}</div>
   </section>
   <section class="cr014s-block">
    <div class="cr014s-block-head"><div><h4>请求伪装</h4><span>分段只改变本地仿真标记。</span></div></div>
    <div class="cr014s-segment" role="group" aria-label="请求伪装">${[['off', '关闭'], ['codex', 'Codex'], ['claude', 'Claude']].map(([key, label]) => `<button type="button" class="cr014s-segment-item" aria-pressed="${disguise === key}" data-action="cr014s-disguise" data-provider="${provider.id}" data-disguise="${key}">${esc(label)}</button>`).join('')}</div>
   </section>
  </div>`;
 }
 function sdkSection14() {
 if (!(typeof state.sdkRegistry === 'string')) state.sdkRegistry = ['https://', 'registry.npmjs.org/'].join('');
 return `<div class="cr014s-pane cr014s-sdk">
  <div class="cr014s-sdk-top">
   <div><h3>SDK 管理</h3></div>
   <div class="cr014s-registry"><label class="cr014s-field"><span>npm registry</span><input class="cr014s-input" value="${esc(state.sdkRegistry)}" data-cr014s-field="sdk-registry" aria-label="npm registry" maxlength="160"></label>${actionButton('全部重新检测', 'sdk-check-all', '', 'cr014s-quiet')}</div>
  </div>
  <div class="cr014s-builtin" aria-label="dsh 子代理内置提示">
   <span class="cr014s-builtin-icon">${settingsIcon('lock')}</span>
   <div><strong>dsh 子代理 v1.0 · 内置</strong><small>随应用提供，只读；不是可安装的第四个 CLI。</small></div>
   <span class="cr014s-badge is-done">内置</span>
  </div>
  <div class="cr014s-sdk-list">${[...state.sdk].sort((a, b) => ({ claude: 0, codex: 1, grok: 2 }[a.id] ?? 9) - ({ claude: 0, codex: 1, grok: 2 }[b.id] ?? 9)).map(sdkCard14).join('')}</div>
  <p class="cr014s-simnote">本地仿真：不执行 npm，不访问 registry，不启动真实 CLI。版本、路径和检测结果均为样例。</p>
 </div>`;
}

 function sdkCard14(sdk) {
  const busy = !!sdk.job;
  const update = sdk.installed && sdk.latest && sdk.latest !== sdk.version;
  const target = sdk.targetVersion || sdk.latest || sdk.version || '';
  const versions = [...new Set([sdk.latest, sdk.version].filter(Boolean))];
  const channels = ['稳定版', '预览版', '本地'];
  const confirm = sdk.confirmUninstall ? `<div class="cr014s-confirm"><p>确认卸载 ${esc(sdk.name)}？会话会立即失去这个 CLI 候选。</p><div class="cr014s-actions">${actionButton('确认卸载', 'sdk-uninstall-confirm', `data-id="${sdk.id}"`, 'cr014s-danger-solid')}${actionButton('取消', 'sdk-uninstall-cancel', `data-id="${sdk.id}"`, 'cr014s-quiet')}</div></div>` : '';
  return `<details class="cr014s-sdk-card" data-sdk="${sdk.id}" data-sdk-installed="${sdk.installed}" ${sdk.expanded ? 'open' : ''}>
   <summary class="cr014s-sdk-summary">
    <span class="cr014s-sdk-logo" data-logo="${sdk.id}" aria-hidden="true">${ic(sdk.id)}</span>
    <span class="cr014s-sdk-title"><strong>${esc(sdk.name)}</strong><small>${esc(sdk.package)}</small></span>
    <span class="cr014s-sdk-version">${sdk.installed ? `v${esc(sdk.version)}` : '未安装'}<b aria-hidden="true">→</b>${sdk.latest ? `v${esc(sdk.latest)}` : '—'}</span>
    ${update ? '<span class="cr014s-badge is-update">有更新</span>' : sdk.installed ? '<span class="cr014s-badge is-done">已安装</span>' : '<span class="cr014s-badge">未安装</span>'}
    <span class="cr014s-sdk-chevron" aria-hidden="true">${settingsIcon('chevron')}</span>
   </summary>
   <div class="cr014s-sdk-body">
    <div class="cr014s-sdk-meta"><span>当前版本 <strong>${sdk.installed ? `v${esc(sdk.version)}` : '未安装'}</strong></span><span class="cr014s-sdk-path">路径 <code>${esc(sdk.path || '尚未安装')}</code></span></div>
    <div class="cr014s-sdk-controls">
     <label class="cr014s-field cr014s-inline-field"><span>目标版本</span><select data-cr014s-change="sdk-target" data-id="${sdk.id}">${versions.map(version => `<option value="${esc(version)}" ${target === version ? 'selected' : ''}>${esc(version)}</option>`).join('') || '<option value="">—</option>'}</select></label>
     <label class="cr014s-field cr014s-inline-field"><span>渠道</span><select data-sdk-channel data-id="${sdk.id}">${channels.map(channel => `<option ${sdk.channel === channel ? 'selected' : ''}>${channel}</option>`).join('')}</select></label>
     <label class="cr014s-field cr014s-inline-field"><span>状态</span>${sdk.installed ? switchButton(`${sdk.name} 启用`, 'sdk-toggle', !!sdk.on, `data-id="${sdk.id}"`) : '<span class="cr014s-hint">未安装</span>'}</label>
    </div>
    <div class="cr014s-actions">
     <button type="button" class="cr014s-btn cr014s-primary" data-action="sdk-install" data-id="${sdk.id}" ${busy ? 'disabled' : ''}>${sdk.installed ? (target && target !== sdk.version ? `更新到 v${esc(target)}` : '重新安装') : '安装'}</button>
     ${sdk.installed ? actionButton('卸载', 'sdk-uninstall', `data-id="${sdk.id}"`, 'cr014s-danger') : ''}
     ${actionButton('重新检测', 'cr014s-sdk-recheck', `data-id="${sdk.id}"`, 'cr014s-quiet')}
    </div>
    <div class="cr014s-sdk-progress" data-sdk-progress="${sdk.id}">${sdk.job ? esc((sdk.log ?? []).at(-1) || '准备中…') : sdk.jobError ? `<span class="cr014s-error">${esc(sdk.jobError)}</span>` : ''}</div>
    ${confirm}
   </div>
  </details>`;
 }

 function currentDraftFor(providerId) {
  const provider = state.providers.find(item => item.id === providerId);
  return provider ? { provider, draft: draftFor(provider) } : null;
 }

 function validateAndCommit(providerId) {
  const found = currentDraftFor(providerId);
  if (!found) return false;
  const { provider, draft } = found;
  draft.p.name = String(draft.p.name ?? '').trim();
  draft.p.models ??= [];
  draft.p.keys ??= [];
  draft.p.endpoints ??= [];
  draft.p.headers ??= [];
  if (!draft.p.name) { draft.error = '供应商显示名称不能为空。'; refreshSettingsPane(); return false; }
  if (state.providers.some(item => item.id !== provider.id && String(item.name).trim() === draft.p.name)) {
   draft.error = '供应商名称已存在。'; refreshSettingsPane(); return false;
  }
  const seenModels = new Set();
  for (const model of draft.p.models) {
   model.name = String(model.name ?? '').trim();
   model.displayName = String(model.displayName ?? '').trim() || model.name;
   if (!model.name) { draft.error = '模型 ID 不能为空。'; refreshSettingsPane(); return false; }
   if (seenModels.has(model.name)) { draft.error = `模型 ID「${model.name}」重复。`; refreshSettingsPane(); return false; }
   seenModels.add(model.name);
   if (model.text && model.imageGen) { draft.error = `模型「${model.name}」不能同时是文本与生图模型。`; refreshSettingsPane(); return false; }
   model.efforts = EFFORT_VALUES.filter(value => (model.efforts ?? []).includes(value));
   if (model.defaultEffort && !model.efforts.includes(model.defaultEffort)) {
    draft.error = `模型「${model.name}」的默认档位必须属于已选档位。`; refreshSettingsPane(); return false;
   }
   for (const key of ['contextWindow', 'maxOutput']) {
    const textKey = `${key}Text`;
    if (typeof model[textKey] === 'string' && model[textKey].trim()) {
     const parsed = parseCapacity(model[textKey]);
     if (parsed == null) { draft.error = `${key === 'contextWindow' ? '上下文窗口' : '最大输出 tokens'}需为正数，可写 128K / 1M / 1B。`; refreshSettingsPane(); return false; }
     model[key] = parsed;
    }
   }
  }
  const urls = new Set();
  for (const endpoint of draft.p.endpoints) {
   endpoint.url = String(endpoint.url ?? '').trim();
   if (endpoint.enabled && !endpoint.url) { draft.error = '启用的 API 地址不能为空。'; refreshSettingsPane(); return false; }
   if (endpoint.enabled && urls.has(endpoint.url)) { draft.error = '同一供应商下存在重复的启用端点。'; refreshSettingsPane(); return false; }
   if (endpoint.enabled) urls.add(endpoint.url);
  }
  draft.p.headers = draft.p.headers.filter(header => String(header.name ?? '').trim() || String(header.value ?? '').trim());
  for (const header of draft.p.headers) {
   if (!String(header.name ?? '').trim()) { draft.error = '请求头名称不能为空。'; refreshSettingsPane(); return false; }
  }
  const saved = clone(draft.p);
  Object.assign(provider, saved);
  pendingNewProviders.delete(providerId);
  provider.confirmDelete = false;
  provider.editorError = '';
  draftMap.delete(providerId);
  state.configRevision++;
  for (const session of allSessions()) if (session.providerId === provider.id) syncSessionConfig(session);
  notify(`${provider.name} 配置已保存（仿真），配置版本 v${state.configRevision}。`);
  refreshSettingsPane();
  render();
  return true;
 }

 function cancelDraft(providerId) {
  const provider = state.providers.find(item => item.id === providerId);
  const pendingNew = pendingNewProviders.delete(providerId);
  if (pendingNew) state.providers = state.providers.filter(item => item.id !== providerId);
  draftMap.delete(providerId);
  if (!pendingNew && provider) {
   provider.expanded = false;
   provider.confirmDelete = false;
   provider.editorError = '';
  }
  refreshSettingsPane();
 }

 function discardDraft(providerId) {
  const provider = state.providers.find(item => item.id === providerId);
  if (!provider) return;
  const fresh = clone(provider);
  const old = draftMap.get(providerId);
  draftMap.set(providerId, {
   p: fresh,
   dirty: false,
   error: '',
   notice: '已放弃未保存的修改。',
   addingKey: false,
   keyForm: { label: '', value: '' },
   modelOpen: old?.modelOpen ?? {}
  });
  refreshSettingsPane();
 }

 function commitProviderName14(el, force = false) {
  if (!el.closest?.('#settings-dialog')) return;
  if (el.matches('[data-cr014s-field="provider-name"]')) {
   const found = currentDraftFor(el.dataset.provider);
   if (!found) return;
   const name = String(el.value ?? '').trim();
   found.draft.p.name = name;
   if (!name) found.draft.error = '供应商显示名称不能为空。';
   else if (state.providers.some(item => item.id !== found.provider.id && String(item.name).trim() === name)) found.draft.error = '供应商名称已存在。';
   else found.draft.error = '';
   found.draft.dirty = true;
   if (force || found.draft.error) refreshSettingsPane();
   return;
  }
  if (el.matches('[data-cr014s-field="model-id"]')) {
   const found = currentDraftFor(el.dataset.provider);
   const model = found?.draft.p.models?.[Number(el.dataset.index)];
   if (!model) return;
   model.name = String(el.value ?? '').trim();
   const duplicate = found.draft.p.models.some(item => item !== model && String(item.name).trim() === model.name);
   if (!model.name) found.draft.error = '模型 ID 不能为空。';
   else if (duplicate) found.draft.error = '该供应商下模型 ID 重复。';
   else found.draft.error = '';
   found.draft.dirty = true;
   if (force || found.draft.error) refreshSettingsPane();
  }
 }

 function settingsInput(el) {
  const field = el.dataset.cr014sField;
  if (!field) return false;
  const ui = ensureUiSettings();
  if (field === 'nickname') { ui.nickname = el.value; return true; }
  if (field === 'email') { ui.email = el.value; return true; }
  if (field === 'avatar') {
   ui.avatar = el.value.slice(0, 2);
   const preview = document.querySelector('#settings-dialog [data-cr014s-avatar-preview]');
   if (preview) preview.textContent = ui.avatar || ui.nickname.slice(0, 1) || '林';
   return true;
  }
  if (field === 'sdk-registry') { state.sdkRegistry = el.value; return true; }
  const found = currentDraftFor(el.dataset.provider);
  if (!found) return true;
  const draft = found.draft;
  const index = Number(el.dataset.index);
  if (field === 'provider-name') { draft.p.name = el.value; markDirty(draft); return true; }
  if (field === 'endpoint-url') { const endpoint = draft.p.endpoints?.[index]; if (endpoint) { endpoint.url = el.value; markDirty(draft); } return true; }
  if (field === 'key-label') { const key = draft.p.keys?.[index]; if (key) { key.label = el.value; markDirty(draft); } return true; }
  if (field === 'key-new-label') { draft.keyForm.label = el.value; return true; }
  if (field === 'key-new-value') { draft.keyForm.value = el.value; return true; }
  if (field === 'model-id') { const model = draft.p.models?.[index]; if (model) { model.name = el.value; markDirty(draft); } return true; }
  if (field === 'model-display') { const model = draft.p.models?.[index]; if (model) { model.displayName = el.value; markDirty(draft); } return true; }
  if (field === 'model-context') { const model = draft.p.models?.[index]; if (model) { model.contextWindowText = el.value; markDirty(draft); } return true; }
  if (field === 'model-output') { const model = draft.p.models?.[index]; if (model) { model.maxOutputText = el.value; markDirty(draft); } return true; }
  if (field === 'effort-wire') { const model = draft.p.models?.[index]; if (model) { model.effortMap ??= {}; model.effortMap[el.dataset.level] = el.value; markDirty(draft); } return true; }
  if (field === 'header-name') { const header = draft.p.headers?.[index]; if (header) { header.name = el.value; markDirty(draft); } return true; }
  if (field === 'header-value') { const header = draft.p.headers?.[index]; if (header) { header.value = el.value; markDirty(draft); } return true; }
  return true;
 }

 function settingsChange(el) {
  const change = el.dataset.cr014sChange;
  const ui = ensureUiSettings();
  if (change === 'code-font') { ui.fontSize = Number(el.value); return true; }
  if (change === 'code-indent') { ui.indent = el.value === 'tab' ? 'tab' : Number(el.value); return true; }
  if (change === 'sdk-target') {
   const sdk = cliById(el.dataset.id);
   if (sdk) sdk.targetVersion = el.value;
   return true;
  }
  if (el.matches('[data-cr014s-field="sdk-registry"]')) { state.sdkRegistry = el.value; return true; }
  if (el.matches('[data-cr014s-field="model-context"],[data-cr014s-field="model-output"]')) {
   const found = currentDraftFor(el.dataset.provider);
   const model = found?.draft.p.models?.[Number(el.dataset.index)];
   if (!model) return true;
   const parsed = parseCapacity(el.value);
   const key = el.matches('[data-cr014s-field="model-context"]') ? 'contextWindow' : 'maxOutput';
   if (parsed == null && String(el.value).trim()) {
    found.draft.error = `${key === 'contextWindow' ? '上下文窗口' : '最大输出 tokens'}需为正数，可写 128K / 1M / 1B。`;
   } else {
    model[key] = parsed ?? undefined;
    model[`${key}Text`] = parsed == null ? '' : fmtCapacity(parsed);
    found.draft.error = '';
   }
   found.draft.dirty = true;
   refreshSettingsPane();
   return true;
  }
  const found = currentDraftFor(el.dataset.provider);
  if (!found) return true;
  const draft = found.draft;
  const index = Number(el.dataset.index);
  if (change === 'key-enabled') { const key = draft.p.keys?.[index]; if (key) key.enabled = el.checked; markDirty(draft); refreshSettingsPane(); return true; }
  if (change === 'endpoint-enabled') { const endpoint = draft.p.endpoints?.[index]; if (endpoint) endpoint.enabled = el.checked; markDirty(draft); refreshSettingsPane(); return true; }
  if (change === 'key-model') {
   const key = draft.p.keys?.[index];
   if (key) {
    const modelId = el.dataset.modelId;
    key.models = Array.isArray(key.models) ? key.models : [];
    key.models = el.checked ? [...new Set([...key.models, modelId])] : key.models.filter(id => id !== modelId);
    markDirty(draft);
    refreshSettingsPane();
   }
   return true;
  }
  if (change === 'model-default') {
   const model = draft.p.models?.[index];
   if (model) {
    if (el.value && !(model.efforts ?? []).includes(el.value)) draft.error = '默认档位必须属于该模型已选档位。';
    else { model.defaultEffort = el.value; draft.error = ''; }
    markDirty(draft);
    refreshSettingsPane();
   }
   return true;
  }
  return false;
 }

 const baseHandleChange = typeof handleChange === 'function' ? handleChange : null;
 handleChange = function (event) {
  const el = event.target;
  if (el?.closest?.('#settings-dialog') && settingsChange(el)) return;
  if (baseHandleChange) return baseHandleChange.call(this, event);
 };

 providerTextInput = function (el) {
  if (!el?.closest?.('#settings-dialog')) return;
  settingsInput(el);
 };

 providerFieldChange = function (el) { settingsInput(el); };
 providerHeaderChange = function (el) { settingsInput(el); };
 providerModelChange = function (el) { settingsInput(el); };
 providerModelEffortChange = function (el) {
  const found = currentDraftFor(el.dataset.provider);
  const model = found?.draft.p.models?.[Number(el.dataset.index)];
  if (!model) return;
  const level = el.dataset.level;
  model.efforts = el.checked ? EFFORT_VALUES.filter(value => value === level || (model.efforts ?? []).includes(value)) : (model.efforts ?? []).filter(value => value !== level);
  if (model.defaultEffort && !model.efforts.includes(model.defaultEffort)) model.defaultEffort = '';
  markDirty(found.draft);
  refreshSettingsPane();
 };
 providerModelDefaultChange = function (el) {
  const found = currentDraftFor(el.dataset.provider);
  const model = found?.draft.p.models?.[Number(el.dataset.index)];
  if (!model) return;
  if (el.value && !(model.efforts ?? []).includes(el.value)) { found.draft.error = '默认档位必须在该模型已勾选的思考等级内。'; refreshSettingsPane(); return; }
  model.defaultEffort = el.value;
  markDirty(found.draft);
  refreshSettingsPane();
 };
 providerKeyPrimaryChange = function () {};

 const baseCloseSettings = typeof settingsClose === 'function' ? settingsClose : null;
 settingsClose = function () {
  const trigger = lastSettingsTrigger;
  if (pendingNewProviders.size) {
   state.providers = state.providers.filter(item => !pendingNewProviders.has(item.id));
   pendingNewProviders.clear();
  }
  draftMap.clear();
  if (baseCloseSettings) baseCloseSettings.apply(this, arguments);
  requestAnimationFrame(() => {
   const want = trigger?.dataset?.settings ?? '';
   const candidates = [...document.querySelectorAll('[data-action="open-settings"]')];
   const target = candidates.find(node => (node.dataset.settings ?? '') === want) ?? candidates[0] ?? document.querySelector('.profile-entry');
   target?.focus?.({ preventScroll: true });
  });
 };

 const baseOpenSettings = actions['open-settings'];
 actions['open-settings'] = function (button) {
  lastSettingsTrigger = button;
  if (baseOpenSettings) return baseOpenSettings(button);
  return settingsOpen(button?.dataset?.settings);
 };

 Object.assign(actions, {
  'cr014s-theme': button => {
   const ui = ensureUiSettings();
   const mode = ['light', 'dark', 'system'].includes(button.dataset.mode) ? button.dataset.mode : 'light';
   ui.appearance = mode;
   if (mode === 'system') {
    let dark = false;
    try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch {}
    applyTheme(dark ? 'dark' : 'light');
   } else applyTheme(mode);
   refreshSettingsPane();
  },
  'cr014s-code-toggle': button => {
   const ui = ensureUiSettings();
   const key = button.dataset.key;
   if (key === 'lineNumbers' || key === 'wrap') ui[key] = !ui[key];
   refreshSettingsPane();
  },
  'provider-new': () => {
   openDialog('新增供应商', `<label>显示名称<input name="name" maxlength="40" required placeholder="例如：自建网关"></label><label>API 协议<select name="protocol"><option value="chat">Chat</option><option value="responses">Responses</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini API</option></select></label>`, form => {
    const name = String(form.get('name') ?? '').trim();
    if (!name) return '请填写供应商显示名称。';
    if (state.providers.some(item => String(item.name).trim() === name)) return '供应商名称已存在。';
    const id = `provider-${seq++}`;
    const provider = { id, name, protocol: form.get('protocol') === 'anthropic' ? 'anthropic' : 'openai', apiStyle: String(form.get('protocol') ?? 'chat'), disabled: false, expanded: true, tab: 'provider', headers: [], timeout: 60, retries: 2, proxy: '', streaming: true, endpoints: [], keys: [], models: [], fingerprint: { state: 'idle', results: [] }, customLabel: '自定义' };
    state.providers.push(provider);
    pendingNewProviders.add(id);
    draftFor(provider).dirty = true;
    notify('已创建供应商草稿；补全端点、密钥与模型并保存后才可用。');
   }, '创建', '新增供应商只写内存草稿，取消不创建。');
  },
  'provider-edit': button => {
   const provider = state.providers.find(item => item.id === button.dataset.provider);
   if (!provider) return;
   const open = !provider.expanded;
   state.providers.forEach(item => { if (item !== provider) item.expanded = false; });
   provider.expanded = open;
   if (open) { draftFor(provider); provider.tab ??= 'provider'; }
   refreshSettingsPane();
  },
  'provider-toggle': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.disabled = !found.draft.p.disabled;
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'provider-delete': button => {
   const provider = state.providers.find(item => item.id === button.dataset.provider);
   if (!provider) return;
   provider.confirmDelete = true;
   refreshSettingsPane();
  },
  'provider-delete-cancel': button => {
   const provider = state.providers.find(item => item.id === button.dataset.provider);
   if (!provider) return;
   provider.confirmDelete = false;
   refreshSettingsPane();
  },
  'provider-delete-confirm': button => {
   const provider = state.providers.find(item => item.id === button.dataset.provider);
   if (!provider) return;
   state.providers = state.providers.filter(item => item.id !== provider.id);
   pendingNewProviders.delete(provider.id);
   draftMap.delete(provider.id);
   state.configRevision++;
   notify(`${provider.name} 已删除；使用其模型的会话会提示模型不可用。`);
   refreshSettingsPane();
   render();
  },
  'provider-tab': button => {
   const provider = state.providers.find(item => item.id === button.dataset.provider);
   if (!provider) return;
   provider.tab = ['provider', 'models', 'advanced', 'fingerprint'].includes(button.dataset.tab) ? button.dataset.tab : 'provider';
   draftFor(provider);
   refreshSettingsPane();
  },
  'cr014s-protocol': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   applyApiMode(found.draft.p, button.dataset.protocol);
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-provider-save': button => validateAndCommit(button.dataset.provider),
  'cr014s-provider-cancel': button => cancelDraft(button.dataset.provider),
  'cr014s-models-discard': button => discardDraft(button.dataset.provider),
  'endpoint-add': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   const url = found.draft.p.protocol === 'anthropic' ? 'https://' + 'api.anthropic.com/v1' : 'https://' + 'api.openai.com/v1';
   if ((found.draft.p.endpoints ?? []).some(endpoint => endpoint.url === url && endpoint.enabled)) { found.draft.error = '同协议族下已存在相同的启用端点。'; refreshSettingsPane(); return; }
   found.draft.p.endpoints ??= [];
   found.draft.p.endpoints.push({ id: `endpoint-${seq++}`, url, enabled: true });
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'endpoint-remove': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.endpoints?.splice(Number(button.dataset.index), 1);
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'key-add': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.addingKey = true;
   found.draft.keyForm = { label: '', value: '' };
   refreshSettingsPane();
  },
  'cr014s-key-cancel': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.addingKey = false;
   found.draft.keyForm = { label: '', value: '' };
   refreshSettingsPane();
  },
  'cr014s-key-create': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   const label = String(found.draft.keyForm.label ?? '').trim();
   const value = String(found.draft.keyForm.value ?? '').trim();
   if (!label) { found.draft.error = '密钥名称不能为空。'; refreshSettingsPane(); return; }
   if (!value) { found.draft.error = '密钥样例值不能为空。'; refreshSettingsPane(); return; }
   found.draft.p.keys ??= [];
   found.draft.p.keys.push({ id: `key-${seq++}`, label, value, enabled: true, primary: !found.draft.p.keys.some(key => key.primary), models: [] });
   found.draft.addingKey = false;
   found.draft.keyForm = { label: '', value: '' };
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'key-remove': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.keys?.splice(Number(button.dataset.index), 1);
   if (found.draft.p.keys?.length && !found.draft.p.keys.some(key => key.primary)) found.draft.p.keys[0].primary = true;
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-key-scope': button => {
   const found = currentDraftFor(button.dataset.provider);
   const key = found?.draft.p.keys?.[Number(button.dataset.index)];
   if (!key) return;
   key.scopeOpen = !key.scopeOpen;
   refreshSettingsPane();
  },
  'cr014s-key-copy': button => {
   const found = currentDraftFor(button.dataset.provider);
   const key = found?.draft.p.keys?.[Number(button.dataset.index)];
   if (!key) return;
   try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(String(key.value ?? '')).then(() => notify('样例密钥已复制到系统剪贴板（本地仿真值）。')).catch(() => notify('浏览权限未允许复制；已保留复制控件。'));
    else notify('当前环境不支持剪贴板；复制控件为本地仿真。');
   } catch { notify('当前环境不支持剪贴板；复制控件为本地仿真。'); }
  },
  'header-add': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.headers ??= [];
   found.draft.p.headers.push({ name: '', value: '' });
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'header-remove': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.headers?.splice(Number(button.dataset.index), 1);
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-disguise': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.disguise = button.dataset.disguise;
   markDirty(found.draft);
   refreshSettingsPane();
  }
 });

 Object.assign(actions, {
  'model-row-add': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   const model = { id: `model-${seq++}`, name: `新模型 ${found.draft.p.models.length + 1}`, displayName: '', text: true, vision: false, imageGen: false, efforts: ['关闭', '低', '中'], defaultEffort: '中', effortMap: {}, contextWindow: 128000, maxOutput: 16000 };
   found.draft.p.models.push(model);
   found.draft.modelOpen[model.id] = true;
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'model-row-remove': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.p.models.splice(Number(button.dataset.index), 1);
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-model-expand': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.modelOpen ??= {};
   found.draft.modelOpen[button.dataset.modelId] = !found.draft.modelOpen[button.dataset.modelId];
   refreshSettingsPane();
  },
  'cr014s-model-modality': button => {
   const found = currentDraftFor(button.dataset.provider);
   const model = found?.draft.p.models?.[Number(button.dataset.index)];
   if (!model) return;
   const modality = button.dataset.modality;
   if (modality === 'imageGen') {
    model.imageGen = !model.imageGen;
    if (model.imageGen) { model.text = false; model.efforts = []; model.defaultEffort = ''; }
   } else if (modality === 'text') {
    model.text = !model.text;
    if (model.text) model.imageGen = false;
   } else if (modality === 'vision') model.vision = !model.vision;
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-model-thinking': button => {
   const found = currentDraftFor(button.dataset.provider);
   const model = found?.draft.p.models?.[Number(button.dataset.index)];
   if (!model) return;
   if ((model.efforts ?? []).length) { model.efforts = []; model.defaultEffort = ''; }
   else { model.efforts = ['低', '中']; model.defaultEffort = '中'; }
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-model-level': button => {
   const found = currentDraftFor(button.dataset.provider);
   const model = found?.draft.p.models?.[Number(button.dataset.index)];
   if (!model) return;
   const level = button.dataset.level;
   const efforts = new Set(model.efforts ?? []);
   if (efforts.has(level)) efforts.delete(level);
   else efforts.add(level);
   model.efforts = EFFORT_VALUES.filter(value => efforts.has(value));
   if (model.defaultEffort && !model.efforts.includes(model.defaultEffort)) model.defaultEffort = '';
   markDirty(found.draft);
   refreshSettingsPane();
  },
  'cr014s-models-restore': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   const baseline = providerBaseline.get(found.provider.id);
   found.draft.p.models = clone(baseline?.models ?? []);
   found.draft.modelOpen = {};
   markDirty(found.draft);
   found.draft.notice = '已恢复初始样例模型；保存前不会影响会话。';
   refreshSettingsPane();
  },
  'cr014s-models-fetch': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   found.draft.notice = '获取可用模型为本地仿真，未发起真实请求；请继续使用现有样例模型。';
   notify('本地仿真：未访问端点，也没有获取真实模型清单。');
   refreshSettingsPane();
  },
  'cr014s-models-autoeffort': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   for (const model of found.draft.p.models) {
    if (model.imageGen) { model.efforts = []; model.defaultEffort = ''; continue; }
    if (!(model.efforts ?? []).length) model.efforts = ['关闭', '低', '中'];
    if (!model.defaultEffort || !model.efforts.includes(model.defaultEffort)) model.defaultEffort = model.efforts.includes('中') ? '中' : model.efforts[0];
   }
   markDirty(found.draft);
   found.draft.notice = '已按本地样例填入思考等级，未校验上游真实支持度；保存前可继续调整。';
   notify('本地仿真：未发起真实请求，思考等级来自样例规则。');
   refreshSettingsPane();
  },
  'cr014s-fp-run': button => {
   const found = currentDraftFor(button.dataset.provider);
   const model = found?.draft.p.models.find(item => item.id === button.dataset.modelId);
   if (!found || !model) return;
   runFingerprint(found.draft.p, [model]);
  },
  'cr014s-fp-all': button => {
   const found = currentDraftFor(button.dataset.provider);
   if (!found) return;
   runFingerprint(found.draft.p, eligibleModels(found.draft.p));
  },
  'sdk-install': button => runSdkJob14(button.dataset.id, '安装'),
  'sdk-uninstall-confirm': button => runSdkJob14(button.dataset.id, '卸载'),
  'cr014s-sdk-recheck': button => {
   const sdk = cliById(button.dataset.id);
   if (!sdk) return;
   sdk.jobError = '';
   sdk.checkedAt = when();
   notify(`${sdk.name} 已仿真重新检测（未执行真实命令）。`);
   refreshSettingsPane();
  },
  'cr014s-skill-new': () => {
   openDialog('新建 Skill', `<label>Skill 名称（命令）<input name="name" maxlength="40" required placeholder="/新技能"></label><label>说明<input name="info" maxlength="120" required placeholder="用途简述"></label><label>版本<input name="version" maxlength="16" value="1.0"></label>`, form => {
    const raw = String(form.get('name') ?? '').trim();
    const info = String(form.get('info') ?? '').trim();
    const version = String(form.get('version') ?? '').trim() || '1.0';
    if (!raw) return '请填写 Skill 名称。';
    if (!info) return '请填写 Skill 说明。';
    const name = raw.startsWith('/') ? raw : `/${raw}`;
    if (state.skill.some(item => item.id.toLowerCase() === name.toLowerCase())) return 'Skill 名称已存在，请换一个。';
    state.skill.push({ id: name, info: `${version} · 自定义`, count: 0, on: true, description: info });
    state.configRevision++;
    notify(`Skill ${name} 已创建（内存仿真）。`);
   }, '创建', '取消不会写入；创建后只在当前页面内存中生效。');
  },
  'cr014s-mcp-new': () => {
   openDialog('新建 MCP', `<label>名称<input name="name" maxlength="40" required placeholder="例如：local-docs"></label><label>传输<select name="transport"><option value="stdio">stdio</option><option value="http">HTTP</option></select></label><label>命令（stdio）<input name="command" maxlength="120" placeholder="例如：npx docs-mcp"></label><label>参数（stdio）<input name="args" maxlength="160" placeholder="可选，空格分隔"></label><label>HTTP 地址<input name="url" maxlength="160" placeholder="HTTP 地址（本地样例）"></label><label>请求头（HTTP）<input name="header" maxlength="120" placeholder="可选，例如 Authorization: Bearer …"></label>`, form => {
    const name = String(form.get('name') ?? '').trim();
    const transport = form.get('transport') === 'http' ? 'http' : 'stdio';
    const command = String(form.get('command') ?? '').trim();
    const args = String(form.get('args') ?? '').trim();
    const url = String(form.get('url') ?? '').trim();
    const header = String(form.get('header') ?? '').trim();
    if (!name) return '请填写 MCP 名称。';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return 'MCP 名称只能包含字母、数字、点、下划线和连字符。';
    if (state.mcp.some(item => item.id.toLowerCase() === name.toLowerCase())) return 'MCP 名称已存在，请换一个。';
    if (transport === 'stdio' && !command) return 'stdio 传输需要填写命令。';
    if (transport === 'http' && !/^https?:\/\//i.test(url)) return 'HTTP 传输需要填写 http(s) 地址。';
    state.mcp.push({ id: name, info: transport === 'stdio' ? 'stdio · 仿真配置' : 'HTTP · 仿真配置', on: true, transport, command, args, url, header, count: 0 });
    state.configRevision++;
    notify(`MCP ${name} 已创建（仿真配置，未启动进程）。`);
   }, '创建', '仅保存配置样例，不启动进程、不连接外部服务；取消不写入。');
  }
 });

 function runFingerprint(provider, models) {
  const list = models.filter(model => /gpt|claude/i.test(model.name));
  list.forEach((model, index) => {
   const key = fingerprintKey(provider, model);
   if (fingerprintMap.get(key)?.state === 'running') return;
   fingerprintMap.set(key, { state: 'running' });
   setTimeout(() => {
    if (!state.providers.some(item => item.id === provider.id)) return;
    const record = sampleFingerprint(provider, model);
    fingerprintMap.set(key, { state: 'done', ...record });
    const box = document.getElementById('settings-dialog');
    if (box?.open && state.settingsTab === 'models') refreshSettingsPane();
   }, 360 + index * 140);
  });
  refreshSettingsPane();
 }

 function runSdkJob14(id, action) {
  const sdk = cliById(id);
  if (!sdk) return;
  if (state.sdk.some(item => item.job)) { notify('另有 CLI 安装/卸载进行中，未并发执行。'); return; }
  const target = action === '安装' ? (sdk.targetVersion || sdk.latest || sdk.version || '0.1.0') : '';
  sdk.job = `${action}中…`;
  sdk.jobError = '';
  sdk.log = [`${action}：解析目标版本${target ? ` ${target}` : ''}`];
  refreshSettingsPane();
  const phases = ['解析目标版本', `npm -g ${action === '安装' ? 'install' : 'uninstall'} ${sdk.package}`, `校验 ${sdk.package}`, `${action}完成`];
  const epoch = state;
  let step = 0;
  const tick = () => {
   if (state !== epoch) return;
   const live = cliById(id);
   if (!live || live.job === null) return;
   step++;
   if (step < phases.length) {
    live.log.push(phases[step]);
    const progress = document.querySelector(`[data-sdk-progress="${id}"]`);
    if (progress) progress.textContent = phases[step];
    setTimeout(tick, 220);
    return;
   }
   live.job = null;
   if (action === '安装') {
    live.installed = true;
    live.version = target;
    live.path = `/usr/local/lib/node_modules/${live.package}`;
    live.on = true;
    live.jobError = '';
    live.targetVersion = target;
   } else {
    live.installed = false;
    live.version = '';
    live.path = '';
    live.on = false;
    live.targetVersion = live.latest || '';
   }
   state.configRevision++;
   for (const session of allSessions()) if (session.cli === id) syncSessionConfig(session);
   notify(action === '安装' ? `${live.name} 已仿真安装 v${live.version}；已加入会话 CLI 候选。` : `${live.name} 已仿真卸载；已移出会话 CLI 候选。`);
   refreshSettingsPane();
   render();
  };
  setTimeout(tick, 240);
 }

 try {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const applySystemTheme = () => { if (ensureUiSettings().appearance === 'system') applyTheme(media.matches ? 'dark' : 'light'); };
  if (media.addEventListener) media.addEventListener('change', applySystemTheme);
  else if (media.addListener) media.addListener(applySystemTheme);
 } catch {}

 if (typeof settingsRoot !== 'undefined' && settingsRoot?.addEventListener) {
  settingsRoot.addEventListener('toggle', event => {
   const card = event.target?.closest?.('[data-sdk]');
   if (!card) return;
   const sdk = cliById(card.dataset.sdk);
   if (sdk) sdk.expanded = card.open;
  }, true);
 }

 settingsPane = settingsPane14;
 providerSection = providerSection14;
 providerCard = providerCard14;
 providerEditor = providerEditor14;
 providerConfigPane = providerConfigPane14;
 providerModelsPane = providerModelsPane14;
 providerAdvancedPane = providerAdvancedPane14;
 providerFingerprintPane = providerFingerprintPane14;
 commitProviderName = commitProviderName14;
 sdkSection = sdkSection14;
 sdkCard = sdkCard14;

 window.cr014Settings = {
  version: 'CR-014',
  getDraft: id => draftMap.get(id)?.p ?? null,
  getFingerprint: id => fingerprintMap.get(id) ?? null,
  validateAndCommit,
  saveProvider: validateAndCommit
 };
})();
