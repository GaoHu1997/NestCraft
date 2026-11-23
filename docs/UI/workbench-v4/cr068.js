/* CR-068：纯设计演示的数据源与输入解析，不联网、不接真实业务。 */
window.CR068 = (() => {
  const { D, store, esc } = UI;
  const wire = value => /anthropic/i.test(value || '') ? 'Anthropic' : 'OpenAI';
  function parseCapacity(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const hit = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text);
    const n = hit ? Number(hit[1]) * ({k:1000,m:1000000}[hit[2].toLowerCase()] || 1) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw Error('容量须为正整数，支持 K/M（如 128K、1M）；留空表示未知');
    return n;
  }
  function catalog(cli = store.aiCli) {
    const protocol = cli === 'claude' ? 'Anthropic' : 'OpenAI';
    return D.settings.providers.filter(p => p.enabled).map(p => ({
      id:p.id, name:p.name, enabled:true,
      models:p.models.filter(m => m.on !== false && (m.modalities || []).includes('文本') && !(m.modalities || []).includes('生图') &&
        p.endpoints.some(e => e.on !== false && e.url && wire(e.protocol) === protocol) &&
        p.keys.some(k => k.on && (wire(k.protocol || p.protocol) === protocol) && (!(k.models || []).length || k.models.includes(m.id))))
        .map(m => ({ ...m, name:m.name, modelId:m.id, ctx:m.context ? (m.context/1000)+'K' : '—', vision:(m.modalities || []).includes('图片'), image:false, available:true, protocol }))
    })).filter(g => g.models.length);
  }
  // 候选由设置清单实时派生，不再维护第二份硬编码模型目录。
  Object.defineProperty(D.ai.modelCatalog, 'providers', { configurable:true, get:() => catalog() });
  const permissionSets = {
    claude:[['默认模式','default · 逐次审批，需审批通道'],['规划模式','plan · 规划；不是 OS 沙箱'],['代理模式','acceptEdits · 自动允许编辑，其他操作仍审批'],['自动审核','auto · 需核验版本、模型和审核策略'],['完全访问','bypassPermissions · 跳过审批，非 OS 沙箱']],
    codex:[['默认模式','on-request + workspace-write · 请求审批'],['规划模式','read-only + never · 只读边界，非原生计划'],['代理模式','workspace-write + never · 工作区写入，不请求审批'],['自动审核','approvalsReviewer 独立于 sandbox，待通道核验'],['完全访问','danger-full-access · 需原生审批和风险确认']],
    grok:[['默认模式','ACP 权限请求 · 默认逐次确认，等待审批桥'],['代理模式','ACP 允许范围必须按实际请求核验'],['完全访问','/always-approve on · 全部允许，需审批能力核验']]
  };
  Object.defineProperty(D.ai, 'permissions', { configurable:true, get:() => (permissionSets[store.aiCli] || []).map(([name,desc],i) => ({
    name,desc:desc + (store.aiCli === 'grok' || i>2 ? '（正式通道未验证）' : '（设计演示）'),icon:'shield',available:store.aiCli !== 'grok' && i<3
  })) });
  document.addEventListener('input', e => {
    const t=e.target, p=D.settings.providers.find(p=>p.id===store.providerOpen), m=p?.models.find(m=>m.id===(store.modelOpen||store.modelEdit));
    if (!m) return;
    if (t.dataset.effortMap) { m.mappings={...m.mappings,[t.dataset.effortMap]:t.value}; return; }
    if (t.id === 'm-ctx' || t.id === 'm-max') {
      try { parseCapacity(t.value); t.setCustomValidity(''); } catch(err) { t.setCustomValidity(err.message); }
    }
  });
  // 切开关/档位前保留已填写容量和映射；显示隐藏不丢草稿。
  document.addEventListener('click', e => {
    const t=e.target.closest('[data-act]');
    if (!t || !['model-thinking','model-level','model-modality'].includes(t.dataset.act)) return;
    const p=D.settings.providers.find(p=>p.id===store.providerOpen), m=p?.models.find(m=>m.id===(store.modelOpen||store.modelEdit));
    if (!m) return;
    for (const [id,key] of [['m-ctx','context'],['m-max','maxOutput']]) { const el=document.getElementById(id); if(el)try{m[key]=parseCapacity(el.value);}catch{} }
    const name=document.getElementById('m-name'); if(name)m.name=name.value;
  },true);
  setInterval(() => {
    if (!store.aiBusy) return;
    const seconds=Math.max(0,Math.floor((Date.now()-(store.aiWorkStartedAt||Date.now()))/1000));
    store.aiWorkElapsed=seconds+' 秒';
    document.querySelectorAll('[data-act="ai-working-tick"]').forEach(el=>el.textContent=store.aiWorkElapsed);
  },1000);
  function showSaveError(providerId, message) {
    store.saveErrors = { ...store.saveErrors, [providerId]: message };
    const card = document.querySelector('[data-provider-card="' + CSS.escape(providerId) + '"]');
    if (!card) return;
    let error = card.querySelector('.provider-save-error');
    if (!error) { error = document.createElement('div'); error.className = 'provider-save-error note-box'; error.setAttribute('role','alert'); card.querySelector('.pm-body').prepend(error); }
    error.textContent = message + '；修改未提交，请修正或重试。';
  }
  function setDiscovery(providerId, phase, message) {
    store.modelDiscovery = { ...store.modelDiscovery, [providerId]: {phase,message} };
    const p = D.settings.providers.find(p => p.id === providerId);
    if (p) Screens.modelPickDialog(p);
  }
  document.addEventListener('click', e => {
    const retry = e.target.closest('[data-cr068-retry]');
    if (retry) { e.preventDefault(); e.stopImmediatePropagation(); setDiscovery(retry.dataset.cr068Retry,'loading'); const id=retry.dataset.cr068Retry; setTimeout(()=>{if(document.getElementById('dialog2').open)setDiscovery(id,'ready');},220); return; }
    const save = e.target.closest('[data-act="provider-save"]');
    if (save && store.mockSaveFailure === save.dataset.id) {
      e.preventDefault(); e.stopImmediatePropagation();
      showSaveError(save.dataset.id, '供应商保存失败（设计故障夹具）');
    }
  },true);
  return {parseCapacity,catalog,setDiscovery,showSaveError,version:'UI-CR068-v2'};
})();
