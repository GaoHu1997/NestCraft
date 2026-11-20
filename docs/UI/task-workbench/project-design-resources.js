/* UI-CR027-v1：仅离线设计资源；所有正文/模型是合成预约夹具，不读真实文件或数据库。 */
(() => {
  'use strict';
  const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tabs = [['prd','PRD'],['ui','UI'],['solution','方案'],['model','数据库设计']];
  const btn = (label, action, id='', extra='') => `<button type="button" class="btn sm" data-resource-action="${action}" data-resource-id="${e(id)}" ${extra}>${e(label)}</button>`;
  const fixture = () => ({ docs:[
    {id:'demo-prd-booking',kind:'prd',title:'预约服务需求',path:'docs/PRD/PRD-预约服务.md',summary:'预约创建、容量检查、取消规则与验收边界。',revision:1,text:'# 预约服务需求\n\n## 用户目标\n用户可以选择服务与时间，确认预约，并查看自己的预约状态。\n\n## 预约流程\n1. 选择服务和可用时间。\n2. 填写联系人信息并确认。\n3. 容量检查通过后返回预约编号。\n\n## 业务规则\n- 同一时间段不能超出服务容量。\n- 未开始的预约可以取消；已结束的预约不可取消。\n- 请求重复提交时返回同一业务结果。\n\n## 异常与验收\n**容量不足**：保留输入，并提示重新选择时间。\n**权限不足**：不显示他人的预约记录。\n\n| 场景 | 可观察结果 |\n| --- | --- |\n| 创建成功 | 显示预约编号及状态 |\n| 重复请求 | 不创建重复预约 |'},
    {id:'demo-prd-cancel',kind:'prd',title:'预约取消补充',path:'docs/PRD/PRD-预约取消.md',summary:'取消时限、幂等处理、状态反馈和拒绝场景。',revision:1,text:'# 预约取消补充\n\n## 取消条件\n仅预约拥有者可以取消未开始的预约。\n\n## 状态反馈\n取消成功展示已取消状态；重复取消返回原结果。\n\n## 拒绝场景\n开始时间已过或没有权限时，不修改原记录。'},
    {id:'demo-lld-booking',kind:'solution',title:'预约服务实现方案',path:'docs/LLD/LLD-预约服务.md',summary:'创建与取消接口、事务容量保护、幂等键及验证方案。',revision:1,text:'# 预约服务实现方案\n\n> 合成技术夹具 · 尚未实现。\n\n## 模块划分\n页面、预约服务与存储适配层分离。\n\n## 创建接口\n`POST /bookings` 接收服务、时间段、联系人和幂等键。\n\n## 事务与幂等\n容量检查与预约创建在同一事务完成。幂等键按用户隔离。\n\n## 错误处理\n容量冲突返回明确的冲突状态；校验失败不写入记录。\n\n## 验证策略\n- 覆盖容量并发冲突与重复提交。\n- 覆盖未授权访问和取消边界。\n\n```text\n页面 → 预约服务 → 容量检查 → 事务提交\n```'},
    {id:'demo-lld-cancel',kind:'solution',title:'取消与状态流转方案',path:'docs/LLD/LLD-取消状态.md',summary:'取消接口、状态转移约束及错误映射。',revision:1,text:'# 取消与状态流转方案\n\n> 合成技术夹具 · 尚未实现。\n\n## 状态流转\n预约只允许从 confirmed 转移到 cancelled。\n\n## 取消接口\n`POST /bookings/:id/cancel` 先核验拥有者和开始时间。\n\n## 回归验证\n拒绝过期取消、跨用户操作和非法状态流转。'}
  ], models:[
    {id:'demo-model-bookings',kind:'model',title:'预约 bookings',name:'bookings',summary:'预约主体：拥有者、服务、时间、状态与幂等键。',revision:1,fields:'id|integer|PK|预约主键\nuser_id|integer|NOT NULL / FK users.id|预约拥有者\nservice_id|integer|NOT NULL|服务编号\nstarts_at|datetime|NOT NULL|开始时间\nstatus|text|NOT NULL / CHECK|confirmed 或 cancelled\nidempotency_key|text|UNIQUE(user_id, idempotency_key)|用户范围幂等键'},
    {id:'demo-model-users',kind:'model',title:'用户 users',name:'users',summary:'用户身份与预约归属；不存放真实个人信息。',revision:1,fields:'id|integer|PK|用户主键\ndisplay_name|text|NOT NULL|显示名称\ncreated_at|datetime|NOT NULL|创建时间'},
    {id:'demo-model-slots',kind:'model',title:'时段 service_slots',name:'service_slots',summary:'服务时段、容量约束与可用数量。',revision:1,fields:'id|integer|PK|时段主键\nservice_id|integer|NOT NULL|服务编号\nstarts_at|datetime|NOT NULL|时段开始\ncapacity|integer|CHECK >= 0|可预约容量'}
  ], ui:{id:'demo-ui-entry',kind:'ui',title:'预约服务仿真原型',path:'docs/UI/仿真原型UI.html',summary:'预约服务入口页面，覆盖服务选择、确认、成功与容量不足。',revision:1}, drafts:{} });
  let host, data, kind='prd', selected={}, mode='read', menuOpen=false, scene='normal', feedback='', dialogInvoker;
  const records = () => kind==='model' ? data.models : data.docs.filter(d=>d.kind===kind);
  const active = () => records().find(d=>d.id===selected[kind]) || records()[0];
  const raw = d => data.drafts[d.id] ?? (d.kind==='model'?d.fields:d.text);
  const dirty = d => (Object.hasOwn(data.drafts,d.id) && raw(d)!==(d.kind==='model'?d.fields:d.text)) || (d.kind==='model' && Object.hasOwn(data.drafts,d.id+':name') && data.drafts[d.id+':name']!==d.name);
  function md(text) {
    let html='', headings=[], list=false, code=false, table=false;
    const inline = s => e(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    const closeList = () => {if(list){html+='</ul>';list=false;}};
    const closeTable = () => {if(table){html+='</tbody></table>';table=false;}};
    for(const line of text.split('\n')) {
      if(line.startsWith('```')) {closeList();closeTable();html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
      if(code){html+=e(line)+'\n';continue;}
      const h=line.match(/^(#{1,6})\s+(.+)$/);
      if(h){closeList();closeTable();const id='resource-heading-'+headings.length;headings.push({id,title:h[2]});html+=`<h${h[1].length} id="${id}" tabindex="-1">${inline(h[2])}</h${h[1].length}>`;}
      else if(/^\|/.test(line)) {closeList();if(/^\|\s*[-:]/.test(line))continue;const cells=line.split('|').slice(1,-1);if(!table){html+='<table class="data-table"><tbody>';table=true;}html+='<tr>'+cells.map(c=>`<td>${inline(c.trim())}</td>`).join('')+'</tr>';}
      else if(/^\s*(?:-|\d+\.)\s+/.test(line)){closeTable();if(!list){html+='<ul>';list=true;}html+='<li>'+inline(line.replace(/^\s*(?:-|\d+\.)\s+/,''))+'</li>';}
      else {closeList();closeTable();if(line.startsWith('> '))html+='<blockquote>'+inline(line.slice(2))+'</blockquote>';else if(line.trim())html+='<p>'+inline(line)+'</p>';}
    }
    closeList();closeTable();if(code)html+='</code></pre>';return {html,headings};
  }
  function menu(d, headings=[]) {
    return `<nav class="resource-menu panel ${menuOpen?'is-open':''}" aria-label="${kind==='model'?'模型菜单':'文档菜单'}"><div class="panel-head"><h3>${kind==='model'?'模型菜单':'文档菜单'}</h3>${btn('关闭','menu-close')}</div><div class="panel-body"><p class="resource-caption">${kind==='model'?'一个模型 · 一个菜单项':'当前项目 · '+(kind==='prd'?'docs/PRD/':'docs/LLD/')}</p>${records().map(x=>`<button type="button" class="resource-item ${x.id===d?.id?'selected':''}" data-resource-action="select" data-resource-id="${e(x.id)}" aria-current="${x.id===d?.id?'page':'false'}"><strong>${e(x.title)}</strong><small>${e(x.summary)}</small>${dirty(x)?'<small class="resource-dirty">● 未保存草稿</small>':''}</button>`).join('')||'<p>暂无资料</p>'}${headings.length?'<div class="resource-toc"><h4>当前文档章节</h4>'+headings.map(h=>btn(h.title,'heading',h.id)).join('')+'</div>':''}<div class="resource-tools"><h4>供 AI 按需读取</h4><p>先索引，后片段；未保存草稿不自动提供给 AI。</p>${btn('查看资料索引 / 工具演示','catalogue')}<small>仅DEMO，未接真实AI或数据库。</small></div></div></nav>`;
  }
  function status() {if(scene==='normal'||scene==='readonly'||scene==='save-error')return '';const content={loading:'正在加载项目设计资料…',empty:'当前分类暂无资料；不会展示其他项目正文。',error:'资料加载失败；请重试，现有草稿保持。',denied:'无权读取当前项目设计资料；不展示标题或正文。'}[scene];return `<div class="empty" role="${scene==='error'?'alert':'status'}"><h3>${content}</h3>${scene==='error'?btn('重试','retry'):''}</div>`;}
  function documentBody(d, model) {
    const readonly=scene==='readonly';
    return `<section class="resource-document panel"><div class="panel-head"><div><h3>${e(d.title)}</h3><small>${e(d.path)} · r${d.revision} · ${dirty(d)?'● 未保存':'已保存样例'}</small></div><div class="actions">${btn(mode==='read'?'编辑 Markdown':'阅读文档','mode',mode==='read'?'edit':'read',readonly?'disabled':'')}${mode==='edit'?btn('保存文档','save','',readonly?'disabled':'')+btn('放弃草稿','discard','',dirty(d)?'':'disabled'):''}${btn('文档菜单','menu','','aria-expanded="'+menuOpen+'"')}</div></div>${readonly?'<p class="note">只读状态：无编辑权限；仍可阅读与按章节定位。</p>':''}<div class="resource-doc-content">${mode==='edit'?`<label class="sr-only" for="resource-editor">Markdown正文</label><textarea id="resource-editor" class="resource-editor" spellcheck="false" ${readonly?'readonly':''}>${e(raw(d))}</textarea><details><summary>Markdown即时预览</summary><article id="resource-preview" class="resource-markdown">${model.html}</article></details>`:`<article class="resource-markdown">${model.html}</article>`}</div></section>`;
  }
  function modelBody(d) {return `<section class="resource-document panel"><div class="panel-head"><div><h3>${e(d.title)}</h3><small>数据库记录 · model://${e(host.ui.projectId)}/${e(d.id)} · r${d.revision}</small></div><div class="actions">${btn(mode==='read'?'编辑模型':'查看模型','mode',mode==='read'?'edit':'read',scene==='readonly'?'disabled':'')}${btn('模型菜单','menu','','aria-expanded="'+menuOpen+'"')}</div></div><div class="panel-body stack"><p class="note">正式方案：保存数据库设计记录，不执行建表或迁移。此页仅本机样例。</p>${mode==='edit'?`<label>表名<input id="resource-model-name" value="${e(data.drafts[d.id+':name']??d.name)}" ${scene==='readonly'?'readonly':''}></label><label>字段：名称 | 类型 | 约束 | 说明（逐行）<textarea id="resource-editor" class="resource-editor" ${scene==='readonly'?'readonly':''}>${e(raw(d))}</textarea></label><div class="actions">${btn('保存模型','save')}${btn('放弃草稿','discard','',dirty(d)?'':'disabled')}</div>`:`<h4>${e(d.name)}</h4><div class="resource-table-wrap"><table class="data-table"><thead><tr><th>字段</th><th>类型</th><th>约束</th><th>说明</th></tr></thead><tbody>${d.fields.split('\n').map(l=>'<tr>'+l.split('|').map(c=>'<td>'+e(c)+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`}</div></section>`;}
  function updateDraftIndicators(d) {
    const stamp=document.querySelector('.resource-document .panel-head small');
    if(stamp)stamp.textContent=(d.path||'model://'+host.ui.projectId+'/'+d.id)+' · r'+d.revision+' · '+(dirty(d)?'● 未保存草稿':'已保存样例');
    const discard=document.querySelector('.resource-document [data-resource-action=discard]');if(discard)discard.disabled=!dirty(d);
    const item=document.querySelector(`.resource-item[data-resource-id="${d.id}"]`);if(item){item.querySelector('.resource-dirty')?.remove();if(dirty(d))item.insertAdjacentHTML('beforeend','<small class="resource-dirty">● 未保存草稿</small>');}
  }
  function validateModel(d) {
    const name=data.drafts[d.id+':name']??d.name, rows=raw(d).split('\n').map(l=>l.split('|'));
    if(!/^[A-Za-z_]\w*$/.test(name)||!rows.every(r=>r.length===4&&/^[A-Za-z_]\w*$/.test(r[0])&&['integer','text','boolean','datetime'].includes(r[1])&&r[3].trim()))return false;
    const names=rows.map(r=>r[0]);if(new Set(names).size!==names.length)return false;
    if(data.models.some(m=>m.id!==d.id&&m.name===name))return false;
    for(const other of data.models.filter(m=>m.id!==d.id)){for(const line of other.fields.split('\n')){const fk=line.split('|')[2]?.match(/FK\s+(\w+)\.(\w+)/);if(fk&&fk[1]===d.name&&(name!==d.name||!names.includes(fk[2])))return false;}}
    for(const r of rows){const unique=r[2].match(/UNIQUE\(([^)]+)\)/);if(unique&&!unique[1].split(',').every(k=>names.includes(k.trim())))return false;}
    for(const r of rows){const fk=r[2].match(/FK\s+(\w+)\.(\w+)/);if(fk){const target=data.models.find(m=>m.name===fk[1]);if(!target||!target.fields.split('\n').some(l=>l.split('|')[0]===fk[2]))return false;}}
    return true;
  }
  function uiBody() {return `<section class="resource-prototype panel"><div class="panel-head"><div><h3>页面设计预览</h3><small>docs/UI/仿真原型UI.html · 预约项目页面</small></div>${btn('查看资料索引','catalogue')}</div><div class="booking-prototype"><header><strong>预约服务</strong><span>首页 / 我的预约</span></header><div class="booking-hero"><span class="tag blue">可操作原型</span><h2>安排下一次服务</h2><p>选择服务和时间，确认后即可查看预约。</p></div><form id="resource-booking"><label>选择服务<select name="service"><option>产品咨询 · 30 分钟</option><option>项目评审 · 60 分钟</option></select></label><label>选择时间<select name="time"><option>周五 09:30</option><option>周五 14:00</option></select></label><label>联系人<input name="contact" placeholder="演示名称" required maxlength="40"></label><label>演示结果<select name="result"><option value="success">预约成功</option><option value="capacity">容量不足（合成故障）</option></select></label><button class="btn primary" type="submit">确认预约（演示）</button><p id="resource-booking-result" role="status"></p></form><div class="booking-footer">仅演示业务首页；不发送请求、不写入预约数据库。</div></div></section>`;}
  function linkedReview() {
    const r=host.linkedRequirement();if(!r)return '<p class="note">暂无关联Story；不自动建立或同步需求。</p>';
    return `<details class="resource-review-controls"><summary>关联需求 / 原设计同步（DEMO）</summary><label>关联Story<select id="design-story">${host.stories().map(x=>`<option value="${e(x.id)}" ${x.id===r.id?'selected':''}>${e(x.id+' · '+x.title)}</option>`).join('')}</select></label><p>${r.synchronized&&!data.pendingSync?'原设计已同步':'设计资料待同步，不可据此派发开发/验收'}。只演示原状态机，真实配套差异与CAS写回尚未实现。</p><div class="actions"><button type="button" class="btn sm" data-action="locate-requirement" data-id="${e(r.id)}">返回关联需求</button>${btn('确认同步设计依据（DEMO）','sync')}</div></details>`;
  }
  function render() {
    if(!host)return '';const d=active(),model=d&&kind!=='model'?md(raw(d)):{headings:[]};
    return `<div class="project-design-resources" data-resource-version="UI-CR027-v1"><div class="resource-header"><nav class="resource-tabs" role="tablist" aria-label="项目设计分类">${tabs.map(([id,label])=>`<button type="button" class="resource-tab" role="tab" data-action="ui-design-kind" data-kind="${id}" aria-selected="${kind===id}" tabindex="${kind===id?0:-1}">${label}</button>`).join('')}</nav><span class="resource-caption">项目设计资料</span></div><div class="resource-feedback" role="status">${e(feedback)}</div>${status()||`<div class="resource-layout ${kind==='ui'?'ui-entry':''}">${kind==='ui'?uiBody():d?(kind==='model'?modelBody(d):documentBody(d,model))+menu(d,mode==='read'?model.headings:[]):'<div class="empty">暂无资料</div>'}</div>`}${scene==='denied'?'':linkedReview()}<details class="resource-review-controls"><summary>设计状态与边界演示</summary><label>状态夹具<select id="resource-scene">${[['normal','正常'],['loading','加载'],['empty','空资料'],['error','读取失败'],['denied','无权限'],['readonly','只读'],['save-error','保存失败']].map(([s,label])=>`<option value="${s}" ${s===scene?'selected':''}>${label}</option>`).join('')}</select></label><p>合成数据，不读取仓库文件。状态切换保留草稿，不改变需求、任务、AI会话或权限。</p></details></div>`;
  }
  function list({category,query='',cursor=0,limit=8}={}) {
    if(scene==='denied')return {error:'FORBIDDEN'};
    const all=[...data.docs,...data.models,data.ui].filter(d=>(!category||category===d.kind)&&(d.title+d.summary+(d.path||'')).includes(query));
    limit=Math.min(8,Math.max(1,Number(limit)||8));cursor=Math.max(0,Number(cursor)||0);
    return {source:'synthetic-design-demo',items:all.slice(cursor,cursor+limit).map(d=>({id:d.id,category:d.kind,title:d.title,locator:d.path||'model://'+host.ui.projectId+'/'+d.id,summary:d.summary,summaryRevision:'demo-r1',summaryStatus:d.revision===1?'current':'stale-fixture',revision:'demo-r'+d.revision,bodyLoaded:false})),nextCursor:cursor+limit<all.length?cursor+limit:null};
  }
  function read({id,revision,startLine=1,maxLines=8}={}) {
    if(scene==='denied')return {error:'FORBIDDEN'};
    const d=[...data.docs,...data.models,data.ui].find(d=>d.id===id);if(!d)return {error:'NOT_FOUND'};
    if(revision!=='demo-r'+d.revision)return {error:'STALE_REVISION',revision:'demo-r'+d.revision};
    const text=d.kind==='model'?d.fields:d.kind==='ui'?'UI入口：'+d.path+'\n页面：预约服务首页\n状态：服务选择、确认、成功、容量不足':d.text,lines=text.split('\n');
    if(!Number.isInteger(startLine)||!Number.isInteger(maxLines)||startLine<1||startLine>lines.length||maxLines<1)return {error:'INVALID_RANGE'};
    maxLines=Math.min(8,maxLines);const end=Math.min(lines.length,startLine+maxLines-1);
    return {id,revision,source:'synthetic-design-demo',range:[startLine,end],content:lines.slice(startLine-1,end).join('\n'),truncated:end<lines.length,nextLine:end<lines.length?end+1:null,tokenCount:'未计量（不冒充真实Token）'};
  }
  function catalogue() {
    if(scene==='denied'){feedback='无权读取设计资料索引。';host.render();return;}
    const dialog=document.querySelector('#review-dialog');if(dialog.open)return;dialogInvoker=document.activeElement;
    document.querySelector('#dialog-content').innerHTML=`<div class="dialog-header"><h2 id="dialog-title">设计资料索引 · 按需读取（DEMO）</h2></div><div class="dialog-body resource-catalogue"><p>工具草案：<code>project_design_list</code> 仅返回索引；<code>project_design_read</code> 读取指定版本片段。这里是离线模拟，未向真实AI注入。</p><pre id="resource-index-output">${e(JSON.stringify(list(),null,2))}</pre><label>选择读取对象<select id="resource-read-id">${[...data.docs,...data.models,data.ui].map(d=>`<option value="${e(d.id)}">${e(d.title)}</option>`).join('')}</select></label><div class="actions">${btn('仅读取前 8 行 / 字段','read-demo')}</div><pre id="resource-read-output">尚未加载正文</pre><p>生产契约要求重新核验项目范围与权限、分段预算、版本缓存和失效；未保存草稿不读、不自动加载关联全量。</p></div><div class="dialog-footer">${btn('关闭','catalogue-close')}</div>`;
    dialog.showModal();
  }
  function attach(h) {
    host=h;host.aux.projectDesignResources||={};host.aux.projectDesignResources[host.ui.projectId]||=fixture();data=host.aux.projectDesignResources[host.ui.projectId];
    if(host.ui.designKind!=='model'&&host.ui.designKind!=='solution')host.ui.designKind='prd';kind=host.ui.designKind;
    document.addEventListener('click',event=> {
      const old=event.target.closest('[data-action="ui-design-kind"]');if(old&&document.querySelector('.project-design-resources')){event.preventDefault();event.stopImmediatePropagation();kind=old.dataset.kind;host.ui.designKind=kind;mode='read';menuOpen=false;feedback='';host.render();document.querySelector(`[data-action="ui-design-kind"][data-kind="${kind}"]`)?.focus();return;}
      const b=event.target.closest('[data-resource-action]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();const action=b.dataset.resourceAction,id=b.dataset.resourceId,d=active();
      if(action==='select'){selected[kind]=id;mode='read';menuOpen=false;feedback='';}
      else if(action==='mode'){mode=id;feedback='';}
      else if(action==='menu'||action==='menu-close'){menuOpen=action==='menu';}
      else if(action==='heading'){const heading=document.getElementById(id);heading?.scrollIntoView({block:'center'});heading?.focus({preventScroll:true});return;}
      else if(action==='save'){
        if(scene==='readonly'||scene==='denied'){feedback='无编辑权限，草稿保持。';}
        else if(scene==='save-error'){feedback='保存失败：模拟存储不可用，草稿保留，可重试。';}
        else if(d.kind==='model'&&!validateModel(d)){feedback='模型格式无效：检查名称、类型、重名字段和FK引用；未写入。';}
        else {const before=structuredClone(d),draft=raw(d),nameDraft=data.drafts[d.id+':name'];if(d.kind==='model'){d.fields=draft;d.name=nameDraft??d.name;d.title=({bookings:'预约',users:'用户',service_slots:'时段'}[d.name]||'模型')+' '+d.name;}else d.text=draft;d.revision++;delete data.drafts[d.id];delete data.drafts[d.id+':name'];if(!host.saveAux()){Object.assign(d,before);data.drafts[d.id]=draft;if(nameDraft!==undefined)data.drafts[d.id+':name']=nameDraft;feedback='快照保存失败；完整草稿保留在本页内存，不冒充已落盘。';}else {data.pendingSync=true;feedback='已保存本机设计样例 · 新修订 r'+d.revision+'；关联需求设计待同步，未修改其正文/AC，未授权开发。';mode='read';host.markPending();}}
      }
      else if(action==='discard'){const dialog=document.querySelector('#review-dialog');dialogInvoker=b;document.querySelector('#dialog-content').innerHTML=`<h2 id="dialog-title">放弃未保存草稿？</h2><p>只放弃当前文档或模型草稿，不影响其他资料与AI草稿。</p><div class="actions">${btn('保留草稿','catalogue-close')}${btn('确认放弃','discard-confirm',d.id)}</div>`;dialog.showModal();return;}
      else if(action==='discard-confirm'){delete data.drafts[id];delete data.drafts[id+':name'];const persisted=host.saveAux();document.querySelector('#review-dialog').close();feedback=persisted?'当前草稿已放弃。':'当前页已放弃草稿，但快照写入失败；刷新可能恢复旧草稿。';}
      else if(action==='sync'){if(scene==='denied'||scene==='readonly'){feedback='当前权限不允许确认同步。';}else if([...data.docs,...data.models].some(x=>dirty(x))){feedback='仍有未保存草稿；请先处理，不能声明已同步。';}else{const result=host.confirmSync();if(result.ok){data.pendingSync=false;host.saveAux();feedback='已明确确认原状态机的设计依据同步（DEMO）；不是正式差异写回或编码授权。';}else feedback=result.error;}}
      else if(action==='retry'){scene='normal';feedback='已重新加载本机样例。';}
      else if(action==='catalogue'){catalogue();return;}
      else if(action==='read-demo'){const target=[...data.docs,...data.models,data.ui].find(x=>x.id===document.querySelector('#resource-read-id').value);document.querySelector('#resource-read-output').textContent=JSON.stringify(read({id:target.id,revision:'demo-r'+target.revision}),null,2);return;}
      else if(action==='catalogue-close'){document.querySelector('#review-dialog').close();dialogInvoker?.focus();return;}
      host.render();
    },true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menuOpen&&!document.querySelector('#review-dialog').open){event.preventDefault();event.stopImmediatePropagation();menuOpen=false;host.render();document.querySelector('[data-resource-action=menu]')?.focus();}},true);
    document.addEventListener('input',event=>{const d=active();if(!d)return;if(event.target.id==='resource-editor'){data.drafts[d.id]=event.target.value;const preview=document.querySelector('#resource-preview');if(preview)preview.innerHTML=md(raw(d)).html;updateDraftIndicators(d);}if(event.target.id==='resource-model-name'){data.drafts[d.id+':name']=event.target.value;updateDraftIndicators(d);}});
    document.addEventListener('change',event=>{if(event.target.id==='resource-scene'){scene=event.target.value;feedback='';host.render();}});
    document.addEventListener('submit',event=>{if(event.target.id!=='resource-booking')return;event.preventDefault();event.stopImmediatePropagation();document.querySelector('#resource-booking-result').textContent=event.target.elements.result.value==='capacity'?'容量不足：请重新选择时间；输入已保留（合成故障）。':'预约已确认 · DEMO-BOOKING-01（仿真，不是真实预约）';},true);
    window.addEventListener('pagehide',()=>host.saveAux());
  }
  window.ProjectDesignResources=Object.freeze({attach,render,list,read,version:'UI-CR027-v1'});
})();
