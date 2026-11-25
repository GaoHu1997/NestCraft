/* UI-CR085-v1. 纯内存设计，凭证为不可执行合成夹具，不联网、不调用软件。 */
window.CR085Settings = (() => {
  const {D, store, esc, icon, toast, openSubDialog, dlgShell} = UI;
  const A = window.__actions, L = Screens.cr085Legacy;
  const snapshots = new Map(), modelSnapshots = new Map();
  const copy = x => structuredClone(x);
  const pNow = () => D.settings.providers.find(p => p.id === store.providerOpen);
  const refresh = () => Screens.refreshSettings();
  const mask = v => v ? (v.length < 9 ? v[0] + '••••' + v.at(-1) : v.slice(0, 4) + '••••' + v.slice(-4)) : '未填写';
  D.settings.providers.forEach((p, pi) => {
    p.endpoints.forEach(e => e.on = Boolean(e.url.trim()));
    p.keys.forEach((k, ki) => { k.value = `demo-not-a-real-key-${pi + 1}-${ki + 1}-${String(k.masked).slice(-4)}`; k.masked = mask(k.value); });
    snapshots.set(p.id, copy(p));
  });
  // 能力夹具明确来源，自动获取时只回填已知模态，不按名字猜测。
  D.settings.endpointSignals['tierflow-reasoner'].modalities = ['文本'];
  D.settings.endpointSignals['tierflow-vision'].modalities = ['文本', '图片'];
  D.settings.thinkKnowledge.find(k => k.id === 'tierflow-pro').modalities = ['文本', '图片'];
  function clean(html, kind) {
    const t = document.createElement('template'); t.innerHTML = html;
    const selectors = ['.f-label > span','.set-actions > .caption','.model-form-actions > .caption','.key-pop-note','.key-pop-h','.pm-f > .caption','.probe-head > div:first-child','.probe-run-hint','.route-note','.cli-load-note'];
    selectors.forEach(s => t.content.querySelectorAll(s).forEach(n => n.remove()));
    t.content.querySelectorAll('small, .modal-h p, .dlg-sub').forEach(n => n.remove());
    if(kind === 'model') t.content.querySelectorAll('.model-form > .caption,.model-form > div > .caption, summary > .caption,.model-toolbar > .caption').forEach(n => n.remove());
    return t.innerHTML;
  }
  function keyEditor(p,k,i) {
    const edit = store.c85Key;
    if(!edit || edit.idx !== i) return '';
    if(edit.mode === 'value') return `<div class="key-form c85-key-editor"><div class="two-col"><div><label for="c85-alias">别名</label><input class="input" id="c85-alias" value="${esc(edit.label)}"></div><div><label for="c85-secret">密钥</label><input class="input mono" type="password" id="c85-secret" value="${esc(edit.value)}" autocomplete="off"></div></div><div class="row key-form-actions"><button class="btn sm" data-c85="key-cancel">取消</button><button class="btn sm primary" data-c85="key-save" data-idx="${i}">保存</button></div></div>`;
    if(edit.mode === 'scope') return `<div class="key-form"><label>可用模型</label><div class="mini-cards">${p.models.map(m => `<button class="mini-card ${edit.models.includes(m.id)?'on':''}" aria-pressed="${edit.models.includes(m.id)}" data-c85="scope-pick" data-model="${esc(m.id)}">${esc(m.name)}</button>`).join('') || '<span>暂无模型</span>'}</div><div class="row key-form-actions"><button class="link-btn" data-c85="scope-all">全部模型</button><span class="spacer"></span><button class="btn sm" data-c85="key-cancel">取消</button><button class="btn sm primary" data-c85="scope-save" data-idx="${i}">保存</button></div></div>`;
    return '';
  }
  function keyRow(p,k,i) {
    return `<div class="key-item"><div class="key-row c85-key-row"><button class="cb ${k.on?'on':''}" role="checkbox" aria-checked="${k.on}" aria-label="启用 ${esc(k.label)}" data-act="provider-key-toggle" data-idx="${i}">${k.on?icon('check','ico-14'):''}</button><span class="c85-key-identity"><b title="${esc(k.label)}">${esc(k.label || '未命名')}</b><span class="mono key-mask">${esc(mask(k.value))}</span><button class="icon-btn" data-c85="copy-key" data-idx="${i}" aria-label="复制密钥明文" title="复制密钥明文">${icon('copy','ico-14')}</button></span><span class="key-actions"><button class="link-btn" data-c85="protocol" data-idx="${i}" aria-haspopup="menu">${esc(k.protocol || '默认协议')}${icon('chevronDown','ico-12')}</button><button class="link-btn" data-c85="scope" data-idx="${i}">${k.models?.length?`${k.models.length} 个模型`:'全部模型'}</button><button class="link-btn" data-c85="edit-key" data-idx="${i}">编辑</button><button class="link-btn danger" data-c85="delete-key" data-idx="${i}">删除</button></span></div>${keyEditor(p,k,i)}</div>`;
  }
  function config(p) {
    return `<div class="pm-section"><div class="row between"><b>API 密钥</b><button class="btn xs" data-act="provider-key-detect">自动探测</button></div><div class="key-list">${p.keys.map((k,i)=>keyRow(p,k,i)).join('')}<button class="text-add c85-add-key" data-c85="add-key">${icon('plus','ico-14')}添加密钥</button></div></div><div class="pm-section c85-provider-identity"><div class="${p.isNew?'':'c85-readonly'}"><label for="pm-id">供应商 ID</label><input class="input mono" id="pm-id" value="${p.isNew?esc(p.requestedId||''):esc(p.id)}" placeholder="自动生成" ${p.isNew?'':'disabled'}></div><div><label for="pm-name">供应商名称</label><input class="input" id="pm-name" value="${esc(p.name)}"></div></div><div class="pm-section"><label>默认协议</label><div class="seg-cards" role="radiogroup" aria-label="供应商默认协议">${['Chat','Responses','Anthropic'].map(x=>`<button class="seg-card ${p.protocol===x?'on':''}" role="radio" aria-checked="${p.protocol===x}" data-act="provider-protocol-card" data-v="${x}">${x}</button>`).join('')}</div></div><div class="pm-section"><label>API 地址</label>${['OpenAI','Anthropic'].map(w=>{
      const ep=p.endpoints.find(e=>e.protocol===w), shown=Boolean(ep?.url)||store.c85Endpoints?.[p.id+':'+w];
      return `<div class="c85-endpoint">${shown?`<label class="endpoint-proto">${w}</label><input class="input mono" data-c85-endpoint="${w}" value="${esc(ep?.url||'')}" placeholder="${w==='OpenAI'?'https://api.example.invalid/v1':'https://api.example.invalid'}" aria-label="${w} API 地址">`:`<button class="link-btn" data-c85="show-endpoint" data-wire="${w}" aria-expanded="false">${icon('plus','ico-14')}${w} 地址</button>`}</div>`;
    }).join('')}</div>`;
  }
  function providers() {
    return `<div class="c85-count">${D.settings.providers.length} 个供应商</div><div class="provider-sort-list">${D.settings.providers.map(p=>{
      const open=store.providerOpen===p.id, tab=store.providerTab||'config';
      return `<div class="provider-card ${open?'open':''}" data-provider-card="${esc(p.id)}"><div class="provider-h"><button class="drag-handle" data-drag-provider="${esc(p.id)}" aria-label="排序 ${esc(p.name)}" title="拖动排序 · Alt+↑/↓">${icon('drag','ico-14')}</button><span class="pinfo" data-act="provider-expand" data-id="${esc(p.id)}" role="button" tabindex="0"><b>${esc(p.name)}</b><span>${esc(p.protocol)} · ${p.keys.length} 个密钥 · ${p.endpoints.filter(e=>e.url.trim()).length} 个端点 · ${p.models.length} 个模型</span></span><button class="switch" data-act="provider-toggle" data-id="${esc(p.id)}" aria-checked="${p.enabled}" aria-label="启用供应商"></button><button class="icon-btn" data-act="provider-delete" data-id="${esc(p.id)}" title="删除供应商">${icon('trash')}</button><button class="icon-btn" data-act="provider-expand" data-id="${esc(p.id)}" aria-expanded="${open}" aria-label="${open?'折叠':'展开'}供应商">${icon(open?'chevronUp':'chevronDown')}</button></div>${open?`<div class="provider-inline"><div class="pm-tabs">${[['config','供应商配置'],['models','模型配置']].map(([v,l])=>`<button class="${tab===v?'on':''}" data-act="provider-tab" data-tab="${v}">${l}</button>`).join('')}</div><div class="pm-body">${tab==='models'?clean(L.providerModels(p),'model'):config(p)}</div><div class="pm-f"><span class="spacer"></span><button class="btn" data-act="provider-discard" data-id="${esc(p.id)}">放弃修改</button><button class="btn primary" data-act="provider-save" data-id="${esc(p.id)}">保存供应商</button></div></div>`:''}</div>`;
    }).join('')}</div>`;
  }
  function probe() {
    const t=document.createElement('template');t.innerHTML=clean(L.probeSection(),'probe');
    t.content.querySelectorAll('#probe-model option[value]').forEach(o=>{const p=D.settings.providers.find(p=>p.id===store.probe.providerId),m=p?.models.find(m=>m.id===o.value);if(m)o.textContent=m.name;});
    const result=t.content.querySelector('.probe-result'), st=Screens.probeState(), r=st.result;
    if(result){result.className='probe-result c85-result';result.innerHTML=`<div class="c85-result-grid"><div><span class="c85-result-label" data-fixed-label="status">状态</span><b>${st.phase==='running'?'检测中':r?'已检测':'待检测'}</b></div><div><span class="c85-result-label" data-fixed-label="score">评分</span><b>${r?esc(r.score):'—'} <small>/ 100</small></b></div><div><span class="c85-result-label" data-fixed-label="grade">等级</span><b>${r?esc(r.grade):'—'}</b></div><div><span class="c85-result-label" data-fixed-label="verdict">真伪</span><b>${r?esc(r.verdict):'—'}</b></div><div><span class="c85-result-label" data-fixed-label="channel">渠道</span><b>${r?esc(r.channel):'—'}</b></div><div><span class="c85-result-label" data-fixed-label="duration">耗时</span><b>${r?esc(r.duration):'—'}</b></div></div><div class="c85-result-summary">${esc(st.phase==='running'?`已检测 ${st.done} / 20`:r?.summary||'')}</div>${st.phase==='running'?`<progress class="c85-probe-progress" max="20" value="${st.done}" aria-label="检测进度"></progress>`:''}`;}
    return t.innerHTML;
  }
  function content(tab){
    if(tab==='models')return providers();
    if(tab==='probe')return probe();
    const other=window.CR085Sdk?.content(tab)??window.CR085Capabilities?.content(tab);
    return other??clean(L.content(tab),tab);
  }
  function preserve(){
    const p=pNow();if(!p)return;
    const name=document.getElementById('pm-name');if(name)p.name=name.value;
    const id=document.getElementById('pm-id');if(p.isNew&&id)p.requestedId=id.value;
    document.querySelectorAll('[data-c85-endpoint]').forEach(input=>{const w=input.dataset.c85Endpoint;let e=p.endpoints.find(e=>e.protocol===w);if(!e){e={protocol:w,url:'',on:false};p.endpoints.push(e);}e.url=input.value;e.on=Boolean(input.value.trim());});
  }
  function modalKey(){const p=pNow();openSubDialog(dlgShell('添加密钥','',`<div class="two-col"><div><label for="c85-new-alias">别名</label><input class="input" id="c85-new-alias"></div><div><label for="c85-new-value">密钥</label><input class="input mono" type="password" id="c85-new-value" autocomplete="off"></div></div>`,`<button class="btn" data-act="close-sub">取消</button><button class="btn primary" data-c85="new-key-save" data-id="${esc(p.id)}">保存</button>`));}
  function closePop(){document.querySelector('.c85-protocol-pop')?.remove();}
  function protocolPop(el,i){
    closePop();const p=pNow(), k=p.keys[i], opts=['','Chat','Responses','Anthropic'];
    const pop=document.createElement('div');pop.className='c85-protocol-pop';pop.setAttribute('role','menu');
    pop.innerHTML=opts.map(v=>{const w=v==='Anthropic'?'Anthropic':'OpenAI',available=!v||p.endpoints.some(e=>e.protocol===w&&e.url.trim());return `<button role="menuitemradio" aria-checked="${(k.protocol||'')===v}" data-c85="pick-protocol" data-idx="${i}" data-v="${v}" ${available?'':'disabled'}>${esc(v||'默认协议')}</button>`;}).join('');
    document.getElementById('dialog').append(pop);const r=el.getBoundingClientRect(),width=Math.min(208,innerWidth-16);pop.style.width=width+'px';pop.style.left=Math.max(8,Math.min(r.right-width,innerWidth-width-8))+'px';pop.style.top=(r.bottom+pop.offsetHeight+4<innerHeight?r.bottom+4:Math.max(8,r.top-pop.offsetHeight-4))+'px';pop.querySelector('button:not([disabled])')?.focus();
  }
  document.addEventListener('input',e=>{if(e.target.matches('[data-c85-endpoint],#pm-name,#pm-id'))preserve();if(store.c85Key?.mode==='value'&&e.target.id==='c85-alias')store.c85Key.label=e.target.value;if(store.c85Key?.mode==='value'&&e.target.id==='c85-secret')store.c85Key.value=e.target.value;});
  document.addEventListener('scroll',e=>{if(e.target!==document.querySelector('.c85-protocol-pop'))closePop();},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.querySelector('.c85-protocol-pop')){e.preventDefault();e.stopImmediatePropagation();closePop();}},true);
  document.addEventListener('click',async e=>{
    const el=e.target.closest('[data-c85]');
    if(!el){if(!e.target.closest('.c85-protocol-pop'))closePop();return;}
    e.preventDefault();e.stopImmediatePropagation();preserve();const p=pNow(),i=Number(el.dataset.idx),k=p?.keys[i],a=el.dataset.c85;
    if(a==='show-endpoint'){store.c85Endpoints={...store.c85Endpoints,[p.id+':'+el.dataset.wire]:true};refresh();document.querySelector(`[data-c85-endpoint="${el.dataset.wire}"]`)?.focus();}
    if(a==='add-key')modalKey();
    if(a==='new-key-save'){const value=document.getElementById('c85-new-value').value.trim(),label=document.getElementById('c85-new-alias').value.trim();if(!value)return toast('请填写密钥','alert');p.keys.push({label,value,masked:mask(value),on:true,models:[],protocol:''});UI.closeSubDialog();refresh();}
    if(a==='edit-key'){store.c85Key={idx:i,mode:'value',label:k.label,value:k.value};refresh();}
    if(a==='key-save'){Object.assign(k,{label:store.c85Key.label,value:store.c85Key.value,masked:mask(store.c85Key.value)});store.c85Key=null;refresh();}
    if(a==='key-cancel'){store.c85Key=null;refresh();}
    if(a==='scope'){store.c85Key={idx:i,mode:'scope',models:[...(k.models||[])]};refresh();}
    if(a==='scope-pick'){const list=store.c85Key.models,id=el.dataset.model;store.c85Key.models=list.includes(id)?list.filter(x=>x!==id):list.concat(id);refresh();}
    if(a==='scope-all'){store.c85Key.models=[];refresh();}
    if(a==='scope-save'){k.models=[...store.c85Key.models];k.manualScope=true;k.autoScope=false;store.c85Key=null;refresh();}
    if(a==='protocol')protocolPop(el,i);
    if(a==='pick-protocol'){k.protocol=el.dataset.v;closePop();refresh();}
    if(a==='copy-key'){const active=document.activeElement;try{await navigator.clipboard.writeText(k.value);toast('密钥已复制');}catch{const field=document.createElement('textarea');field.value=k.value;field.style.cssText='position:fixed;left:-10000px;top:0';document.getElementById('dialog').append(field);field.focus();field.select();const ok=document.execCommand('copy');field.remove();active?.focus({preventScroll:true});toast(ok?'密钥已复制':'复制失败，请允许剪贴板访问',ok?undefined:'alert');}}
    if(a==='delete-key')openSubDialog(dlgShell('删除密钥','',`<p>删除「${esc(k.label||'未命名密钥')}」？</p>`,`<button class="btn" data-act="close-sub">取消</button><button class="btn danger" data-c85="delete-confirm" data-idx="${i}">删除</button>`));
    if(a==='delete-confirm'){p.keys.splice(i,1);UI.closeSubDialog();refresh();}
  },true);
  const oldRefresh=Screens.refreshSettings;
  Screens.refreshSettings=()=>{
    const body=document.querySelector('.set-scroll');if(!body)return oldRefresh();
    const scroll=body.scrollTop,active=document.activeElement,key=active?.id||null,start=active?.selectionStart,end=active?.selectionEnd;
    body.innerHTML=content(store.settingsTab);body.scrollTop=scroll;
    const next=key&&document.getElementById(key);if(next){next.focus({preventScroll:true});if(typeof start==='number'&&next.setSelectionRange)next.setSelectionRange(start,end);}
  };
  const expand=A['provider-expand'];A['provider-expand']=el=>{preserve();store.c85Endpoints={};store.c85Key=null;closePop();expand(el);const p=pNow();if(p&&!snapshots.has(p.id))snapshots.set(p.id,copy(p));};
  A['provider-new']=()=>{const id='draft-'+Date.now();D.settings.providers.push({id,name:'',protocol:'Chat',enabled:true,keys:[],endpoints:[],models:[],availableModels:[],isNew:true});store.providerOpen=id;store.providerEdit=id;store.providerTab='config';refresh();};
  const save=A['provider-save'];A['provider-save']=el=>{preserve();const p=pNow();if(!p)return;if(!p.name.trim())return toast('请填写供应商名称','alert');if(p.isNew){const input=document.getElementById('pm-id').value.trim();const id=input||'PRV-'+crypto.randomUUID().slice(0,8);if(D.settings.providers.some(x=>x!==p&&x.id===id))return toast('供应商 ID 已存在','alert');p.id=id;delete p.isNew;store.providerOpen=id;el.dataset.id=id;}save(el);if(!store.providerOpen)snapshots.set(p.id,copy(p));};
  A['provider-discard']=el=>{const p=pNow(),s=snapshots.get(el.dataset.id);if(s)Object.assign(p,copy(s));else D.settings.providers=D.settings.providers.filter(x=>x!==p);store.providerOpen=null;store.modelOpen=null;refresh();};
  const tab=A['provider-tab'];A['provider-tab']=el=>{preserve();store.c85Key=null;tab(el);};
  const modelSelect=A['model-select'];A['model-select']=(el,e)=>{const p=pNow(),m=p?.models.find(m=>m.id===el.dataset.id);if(m&&!modelSnapshots.has(p.id+'/'+m.id))modelSnapshots.set(p.id+'/'+m.id,copy(m));modelSelect(el,e);};
  A['model-discard']=()=>{const p=pNow(),m=p?.models.find(m=>m.id===store.modelOpen),s=m&&modelSnapshots.get(p.id+'/'+m.id);if(s)Object.assign(m,copy(s));store.modelOpen=null;refresh();};
  function modalities(){const p=pNow();if(!p)return;p.models.forEach(m=>{const signal=D.settings.endpointSignals[m.id],knowledge=D.settings.thinkKnowledge.find(k=>k.id===m.id),known=signal?.modalities||knowledge?.modalities;if(known&&!m.modalitiesManual){m.modalities=[...known];m.visionUnknown=false;} });refresh();}
  const modalityAction=A['model-modality'];A['model-modality']=el=>{const m=pNow()?.models.find(m=>m.id===store.modelEdit);if(m)m.modalitiesManual=true;modalityAction(el);};
  ['model-auto-level','model-auto-level-all'].forEach(a=>{const old=A[a];A[a]=(...args)=>{old(...args);modalities();};});
  const pick=Screens.modelPickDialog;Screens.modelPickDialog=p=>{pick(p);const d=document.getElementById('dialog2');d.querySelectorAll('.modal-h p,.caption:not(.model-pick-row .caption),.discovery-status p').forEach(n=>n.remove());};
  const image=Screens.imageGenDialog;Screens.imageGenDialog=()=>{image();const d=document.getElementById('dialog2');d.querySelectorAll('.caption,.note-box,.modal-h p').forEach(n=>n.remove());};
  const param=new URLSearchParams(location.search).get('settings');if(param)Screens.openSettings(param);
  return {version:'UI-CR085-v1',content,mask,preserve,clean};
})();
