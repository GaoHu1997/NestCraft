/* UI-CR029-v1：只读需求阅读设计；正文补充为合成夹具，不接真实MD/DB/AI。 */
(() => {
  'use strict';
  const e = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const types = {vision:'愿景',epic:'史诗',feature:'特性',story:'用户故事',model:'模型'};
  const labels = {id:'编号',kind:'类型',parent:'唯一父项',title:'名称',status:'源业务状态',confirmed:'需求确认',synchronized:'设计同步',designReady:'设计就绪',requirementHash:'需求修订',designHash:'设计修订',acHash:'AC修订',ac:'验收标准',dependencies:'前置依赖',resources:'资源',integration:'适用集成',executor:'执行器分配（不是设计模型）',capabilities:'能力',writePaths:'写入范围',artifactId:'产物标识',acceptance:'验收状态',revision:'源修订',workflowVersion:'流程版本',comments:'讨论全文',acceptanceHistory:'验收历史',description:'背景与描述',goal:'用户目标',reason:'变更原因',modelRefs:'关联模型'};
  const fields = ['背景与用户价值','目标与成功标准','包含范围','不包含事项','主流程与分支异常','业务规则与权限','负责人与优先级','设计与实现引用','验证与验收结论','变更、阻塞与下一步'];
  const topics = [
    ['冻结预约接口契约','预约创建与取消需要统一输入、响应与错误语义，避免前后端消费不同版本。','界定预约编号、状态、容量和幂等键，形成可验证契约。','阅读当前预约规则 → 固定请求／响应字段 → 记录错误与重复请求场景 → 将契约修订交付后续任务。','同一用户与幂等键重放必须返回同一预约；容量满返回明确拒绝，不发真实请求。'],
    ['实现预约后端','预约请求需要容量与幂等保护，不能重复扣减名额。','按契约创建预约并返回业务状态，拒绝容量冲突。','消费已验证契约 → 核验用户／时段 → 同一事务检查容量与幂等 → 返回结果；失败保留原因，不伪造预约。','用户隔离幂等键；无权读取他人预约；并发／事务能力尚未正式实测。'],
    ['实现预约前端','用户需要清晰输入、确认和异常反馈，不应因容量不足丢失输入。','呈现预约选择、提交与结果页，重复点击不产生不同请求。','消费契约 → 选择活动时段 → 填写演示联系人 → 确认提交 → 展示编号／状态；满员保留输入并可重选。','状态包含加载、成功、容量不足、无权与取消；不发送通知，不采集私人信息。'],
    ['验证预约端到端流程','独立前后端通过不能证明同一预约流程和修订一致。','验证创建、幂等重放、满员拒绝及取消回补的闭环。','消费前后端有效产物 → 运行隔离夹具 → 逐AC记录预期与实际 → 检查修订一致 → 提交验证包。','失败不能计通过，旧产物不能作为当前验收证据；所有此页运行数据是仿真。'],
    ['独立权限审计','预约与知识引用不能泄露其他用户或项目的资料。','核查读写范围、授权与凭证零落盘边界。','读取冻结范围 → 列出授权主体与对象 → 检查越界／撤权拒绝 → 记录差异与风险。','未授权资料不可暴露；演示地址和凭证不可执行；不读取生产或私人数据。'],
    ['校验预约索引方案','容量／用户范围查询需要明确索引约束与验证依据。','审阅预约查询索引及幂等复合唯一性。','读取数据库设计 → 校验查询字段与唯一键 → 核查共享模式资源 → 记录审阅意见与待验证项。','本故事只审阅设计，不创建业务索引、不执行SQL；共享模式任务由已有状态机互斥。'],
    ['校验预约约束方案','预约状态和容量必须有一致约束，避免非法状态转移。','审阅字段、状态约束、关联与幂等范围。','读取模型 → 核查非空／唯一／关系 → 检查取消时限与回补一次 → 记录差异与验证计划。','不自动修改模型／需求；非法状态拒绝；真实数据库迁移未执行。'],
    ['整理运营验收手册','验收者需要区分技术验证、用户验收和真实上线。','汇总当前范围、证据、恢复步骤与未知实测，提供可审阅手册。','消费端到端验证包 → 核对冻结修订与逐AC结果 → 整理失败／恢复 → 提交待验收记录。','不得将仿真成功写成正式已发布；保留取消／未验证／失败与审批历史。'],
    ['尚未确认的提醒诉求','存在提醒想法，但用户未确认触发规则、渠道与权限。','记录待澄清点，不默认发通知或进入派发。','收集诉求 → 标待确认 → 列出渠道与时间决策 → 等用户确认；本页只展示不执行。','提醒规则、真实发送范围与成本未确认；不得因在预览中可见就授权执行。'],
    ['存在未同步设计草稿','当前设计与需求可能不一致，旧草稿不能当已就绪依据。','保留草稿与修订，明确同步前不可作为派发基线。','查看当前需求与草稿 → 比较差异 → 记录待同步原因 → 等明确同步；不会自动改AC。','本样例设计尚未同步；保存设计不等于正式编码授权。'],
    ['已经完成的历史故事','阅读范围应包含历史完成条目，而非只保留可派发故事。','保留历史名称、范围与源完成状态以便追溯。','读取历史正文与元数据 → 呈现源状态 → 列出可核验证据或缺项。','源状态completed是合成历史夹具；没有正式用户验收证据，不补造提交号。'],
    ['已取消的历史诉求','被取消的诉求仍需要保留理由与历史，不应从全量阅读消失。','保留取消状态、影响及追溯。','读取取消项 → 展示取消状态及来源 → 缺少取消理由明确待补充。','此处取消为历史夹具，不等于用户刚取消当前任务，不触发任何真实终止。']
  ];
  const value = v => v == null || v === '' ? '<span class="rr-missing">待补充</span>' : Array.isArray(v) ? (v.length ? '<ul>'+v.map(x=>'<li>'+value(x)+'</li>').join('')+'</ul>' : '<p class="rr-muted">源记录为空（不是通过／不存在风险）</p>') : typeof v === 'object' ? '<dl>'+Object.entries(v).map(([k,x])=>'<dt>'+e(labels[k]||k)+'</dt><dd>'+value(x)+'</dd>').join('')+'</dl>' : typeof v === 'boolean' ? (v?'是':'否') : '<span class="rr-text">'+e(v)+'</span>';
  let host, mode='tree', selected='DEMO-VISION-01', collapsed=new Set(), zoom=1, scene='normal';
  // CR-033：每个项目窗口保留各自的阅读方式、选择、折叠、缩放与状态夹具。
  let readingProject=null; const readingStates=new Map();
  function syncReadingProject(){
    const id=host.projectId?host.projectId():host.state().projectId;
    if(id===readingProject) return;
    if(readingProject) readingStates.set(readingProject,{mode,selected,collapsed,zoom,scene});
    const saved=readingStates.get(id)||{mode:'tree',selected:'DEMO-VISION-01',collapsed:new Set(),zoom:1,scene:'normal'};
    readingProject=id; ({mode,selected,collapsed,zoom,scene}=saved);
  }
  const btn=(text,action,id='',extra='')=>`<button type="button" class="btn sm" data-reading-action="${action}" data-reading-id="${e(id)}" ${extra}>${e(text)}</button>`;
  function narrative(r) {
    const n=topics[Number(r.id.match(/^DEMO-STORY-(\d+)$/)?.[1])-1];
    if(r.kind==='story'&&n&&r.title===n[0]) return [r.description||n[1],r.goal||n[2],'本故事名称限定的预约演示能力及其当前冻结AC；输入／输出与接口契约同源。','不含生产服务、付费调用、通知发送、真实数据库迁移及未经授权的正式源码修改。',n[3],n[4],'演示负责人：林澈；优先级由原需求管理，不在阅读投影擅自更改。','需求与设计hash、产物ID、前置关联见下方源字段；正式文件／提交／LLD链接待登记。','当前验收与历史来自原状态机；真实效果、性能及软件视觉未实测。','变更及阻塞来自原状态机；本机样例内容仅用于阅读设计，不是已实现承诺。'];
    const other={ 'DEMO-EPIC-01':['交付可验证的预约服务','让使用者完成预约、避免重复扣减，并提供可追溯交付。','预约主流程与运营／审计保障。'], 'DEMO-EPIC-02':['待整理的后续诉求','把未确认、未同步及历史需求明确保留，不混为可执行范围。','准入排除与历史记录。'], 'DEMO-FEAT-01':['预约主流程','形成契约、后端、前端与端到端验证的完整能力。','预约创建、幂等、容量和结果反馈。'], 'DEMO-FEAT-02':['运营与审计保障','让权限、索引／约束与验收手册提供可核查保障。','独立权限审计、模型审阅与运营验收。'], 'DEMO-FEAT-03':['准入排除样例','明确需求是否可派发与是否仍需确认，不从阅读中删除。','未确认提醒、未同步设计及完成／取消历史。'] }[r.id];
    return other&&r.title===other[0] ? [r.description||other[1],r.goal||other[1],other[2],'不包含真实上线、消息发送、生产数据或未经授权开发。','按下级故事可观察成果推进；异常和依赖见子项全文。','唯一业务父项；完成／取消／阻塞汇总来自同一状态机。','演示负责人：林澈；实际优先级待登记。','下级Story与同源设计模型；真实源文件链接待登记。','本机业务情景夹具；真实验收未知，不根据父项名称宣告完成。','保留源修订及子项历史；需求确认与正式开发授权分开。'] : fields.map((_,i)=> i===0?r.description:i===1?r.goal:null);
  }
  function snapshot() {
    const state=host.state(), req=state.requirements;
    const vision={id:'DEMO-VISION-01',kind:'vision',title:'可验证、可追溯的预约服务',parent:null,description:'让虚构社区活动的使用者放心预约、取消与核查结果；让研发者按授权把需求、设计、验证与验收串成闭环。',goal:'预约结果一致；拒绝越界与重复扣减；交付证据绑定当前修订。',scope:'仅预约情景设计与已有执行仿真，不含生产发布、支付及真实通知。',revision:1};
    const models=host.models().map(m=>({...m,kind:'model',parent:vision.id,source:'CR-027已保存数据库设计样例；未保存草稿不读'}));
    // 固定合成关联只用于UI评审；不是从名称猜测、也不写入业务父项。
    const demoLinks={'DEMO-FEAT-01':['demo-model-bookings'],'DEMO-FEAT-02':['demo-model-users','demo-model-slots']};
    const all=[vision,...req.map(r=>({...r,modelRefs:r.modelRefs||demoLinks[r.id]||[]})),...models];
    return {all,vision,req:all.filter(r=>['epic','feature','story'].includes(r.kind)),models};
  }
  function body(r,level=6) {
    if(r.kind==='model') return `<p class="rr-source">${e(r.source)} · r${e(r.revision)}</p><p>${e(r.summary)}</p><h${level}>表名与全字段</h${level}><p><code>${e(r.name)}</code></p><div class="rr-table"><table><thead><tr><th>字段</th><th>类型</th><th>约束／关联</th><th>说明</th></tr></thead><tbody>${r.fields.split('\n').map(l=>'<tr>'+l.split('|').map(c=>'<td>'+e(c)+'</td>').join('')+'</tr>').join('')}</tbody></table></div><p>模型以设计记录为权威，关联不是Story的第二父项；不执行SQL。</p>${Object.entries(r).filter(([k])=>!['title','fields','source','summary','name'].includes(k)).map(([k,v])=>`<h${level}>${e(labels[k]||k)}</h${level}>${value(v)}`).join('')}`;
    if(r.kind==='vision') return `<h${level}>目标与用户价值</h${level}>${value(r.description)}<h${level}>成功标准</h${level}>${value(r.goal)}<h${level}>范围与不包含</h${level}>${value(r.scope)}<p class="rr-source">合成愿景 · ${e(r.id)} · r${r.revision} · 不自动代表项目事实或用户已验收</p>`;
    const generated=/^DEMO-(STORY|EPIC|FEAT)-\d+$/.test(r.id)&&narrative(r).some(Boolean);
    let html=`<p class="rr-source">${generated?'新增合成业务叙述补充＋原状态机字段；不是实际项目MD':'仅现有源字段，缺项待补充'} · ${e(r.id)} · r${e(r.revision||1)}</p>`;
    html+=narrative(r).map((v,i)=>`<h${level}>${fields[i]}</h${level}>${value(v)}`).join('');
    html+=`<h${level}>原始完整记录（同源实时字段）</h${level}><dl class="rr-record">${Object.entries(r).filter(([k])=>k!=='title').map(([k,v])=>'<dt>'+e(labels[k]||k)+'</dt><dd>'+value(v)+'</dd>').join('')}</dl>`;
    if(r.kind==='story')html+='<p class="rr-missing">原样例AC仅含编号，正式可执行验收正文仍待补充；不会将编号或DEMO运行当成验收通过。</p>';
    return html;
  }
  function documentView(s) {
    const seen=new Set(); const section=(r,level)=>{if(seen.has(r.id))return '';seen.add(r.id);return `<section class="rr-entity rr-${r.kind}" data-reading-entity="${e(r.id)}"><h${level} id="rr-${e(r.id)}" tabindex="-1"><span>${types[r.kind]||'条目'} · ${e(r.id)}</span>${e(r.title)}</h${level}>${body(r)}${s.req.filter(x=>x.parent===r.id).map(x=>section(x,Math.min(5,level+1))).join('')}</section>`;};
    const rooted=s.req.filter(r=>r.kind==='epic'&&!r.parent);
    const contents=rooted.map(r=>section(r,3)).join('');const orphans=s.req.filter(r=>!seen.has(r.id));
    return `<div class="rr-reader"><nav class="rr-toc" aria-label="完整需求目录"><strong>全文目录</strong>${[s.vision,...s.req].map(r=>btn(types[r.kind]+' · '+r.title,'heading',r.id,`class="rr-toc-item"`)).join('')}</nav><article class="rr-document"><h1>需求全量预览 · ${e(host.project().name)}</h1><p class="rr-lead">${s.req.filter(r=>r.kind==='epic').length} 史诗 · ${s.req.filter(r=>r.kind==='feature').length} 特性 · ${s.req.filter(r=>r.kind==='story').length} 用户故事；包含未确认、完成和取消。全部实体不等于源字段已完整。</p><section data-reading-entity="${s.vision.id}"><h2 id="rr-${s.vision.id}" tabindex="-1"><span>愿景 · ${s.vision.id}</span>${e(s.vision.title)}</h2>${body(s.vision)}</section>${contents}${orphans.length?'<h2>关系待修复（不遗漏全文）</h2><p>孤立、循环或不合法父关系需修复；不按名称猜归属。</p>'+orphans.map(r=>section(r,3)).join(''):''}</article></div>`;
  }
  function mapView(s) {
    const nodes=[], edges=[],seen=new Set();let row=0;
    const place=(r,depth,parent)=>{if(seen.has(r.id))return;seen.add(r.id);const p={...r,x:28+depth*250,y:26+row++*80};nodes.push(p);if(parent)edges.push({a:parent,b:p});if(!collapsed.has(r.id))for(const c of s.req.filter(x=>x.parent===r.id))place(c,depth+1,p);return p;};
    const root=place(s.vision,0);if(!collapsed.has(root.id)) {for(const r of s.req.filter(r=>r.kind==='epic'&&!r.parent))place(r,1,root);for(const r of s.req.filter(r=>!seen.has(r.id)&&!s.req.some(x=>x.id===r.parent&&collapsed.has(x.id)))) {let p=s.req.find(x=>x.id===r.parent),hidden=false,parents=new Set();while(p&&!parents.has(p.id)){parents.add(p.id);if(collapsed.has(p.id)){hidden=true;break;}p=s.req.find(x=>x.id===p.parent);}if(!hidden)place(r,1,root);}for(const m of s.models)place(m,1,root);}
    const relations=[];for(const r of s.req)for(const id of r.modelRefs||[]){const a=nodes.find(n=>n.id===r.id),b=nodes.find(n=>n.id===id);if(a&&b)relations.push({a,b});}
    const width=Math.max(850,...nodes.map(n=>n.x+245)),height=Math.max(420,row*80+30);const active=s.all.find(r=>r.id===selected);
    return `<div class="rr-map-layout"><section class="rr-map-panel"><div class="rr-map-tools">${btn('−','zoom-out')}${btn(Math.round(zoom*100)+'%','zoom-reset')}${btn('+','zoom-in')}${btn('展开全部','expand')}${btn('定位选中','locate')}<span>实线：层级／收纳 · 虚线：模型关联</span></div><div class="rr-map-scroll" tabindex="0" aria-label="思维导图滚动区域"><div style="width:${width*zoom}px;height:${height*zoom}px"><div class="rr-map-canvas" style="width:${width}px;height:${height}px;transform:scale(${zoom})"><svg width="${width}" height="${height}" aria-hidden="true">${edges.map(({a,b})=>`<path d="M${a.x+218},${a.y+29} C${a.x+242},${a.y+29} ${b.x-20},${b.y+29} ${b.x},${b.y+29}"/>`).join('')}${relations.map(({a,b})=>`<path class="rr-relation" d="M${a.x+108},${a.y+58} C${a.x+108},${a.y+88} ${b.x+108},${b.y-35} ${b.x+108},${b.y}"/>`).join('')}</svg>${nodes.map(n=>`<div class="rr-map-node rr-${n.kind}${selected===n.id?' is-selected':''}" style="left:${n.x}px;top:${n.y}px"><button type="button" data-reading-action="select" data-reading-id="${e(n.id)}" aria-pressed="${selected===n.id}" aria-label="${types[n.kind]} ${e(n.id)} ${e(n.title)}"><small>${types[n.kind]} · ${e(n.id)}</small><strong>${e(n.title)}</strong></button>${s.req.some(c=>c.parent===n.id)||n.kind==='vision'?btn(collapsed.has(n.id)?'展开':'折叠','collapse',n.id):''}</div>`).join('')}</div></div></div><p class="rr-muted">${s.all.length} 个实体 · 当前可见 ${nodes.length}；模型未关联时独立收纳，不猜测业务关系。选择后右侧阅读全文。</p></section><aside class="rr-node-detail" aria-label="节点完整详情" tabindex="-1">${active?`<div class="rr-detail-head"><span>${types[active.kind]} · ${e(active.id)}</span><h2>${e(active.title)}</h2></div>${body(active,3)}`:'<h2>节点不存在或已移除</h2><p>请选择有效节点；不展示上一节点正文。</p>'}</aside></div>`;
  }
  function render(tree) {
    syncReadingProject();
    const s=snapshot();
    const notice={loading:'正在加载当前项目需求…',empty:'当前项目暂无需求与模型；不是读取失败。',error:'需求源读取失败；全文未加载，不能标为完整。',denied:'无权读取当前项目需求；不展示标题、数量与正文。'}[scene];
    return `<div class="requirements-reading" data-reading-version="UI-CR029-v1"><nav class="rr-tabs" aria-label="需求阅读方式">${[['tree','需求树'],['preview','预览'],['map','思维导图']].map(([id,label])=>btn(label,'mode',id,`aria-pressed="${mode===id}"`)).join('')}</nav>${notice?`<div class="rr-empty" role="${scene==='error'?'alert':'status'}"><h2>${notice}</h2>${scene==='error'?btn('重试','retry'):''}</div>`:mode==='tree'?tree:mode==='preview'?documentView(s):mapView(s)}<details class="rr-review" data-review-only><summary>需求阅读状态演示（仅设计）</summary><label>状态 <select id="reading-scene">${[['normal','正常'],['loading','加载'],['empty','空项目'],['error','缺源／读取失败'],['denied','无权限']].map(([id,label])=>`<option value="${id}" ${scene===id?'selected':''}>${label}</option>`).join('')}</select></label><p>同源读取已有状态和已保存模型；合成叙述用于排版评审，未知条目缺项明确待补充。不写需求、模型或AI，不覆盖旧草稿。</p></details></div>`;
  }
  function attach(h) {
    host=h;
    syncReadingProject();
    document.addEventListener('click',event=>{const b=event.target.closest('[data-reading-action]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();const id=b.dataset.readingId,action=b.dataset.readingAction;
      if(action==='heading'){const x=document.getElementById('rr-'+id);x?.scrollIntoView({block:'start'});x?.focus({preventScroll:true});return;}
      if(action==='mode'){mode=id;host.render();document.querySelector(`[data-reading-action=mode][data-reading-id=${mode}]`)?.focus({preventScroll:true});return;}
      if(action==='select'){const old=document.querySelector('.rr-map-scroll'),pos=old&&[old.scrollLeft,old.scrollTop];selected=id;host.render();const fresh=document.querySelector('.rr-map-scroll');if(pos&&fresh){fresh.scrollLeft=pos[0];fresh.scrollTop=pos[1];}document.querySelector(`[data-reading-action=select][data-reading-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
      if(action==='collapse')collapsed.has(id)?collapsed.delete(id):collapsed.add(id);
      if(action==='expand')collapsed.clear();
      if(action==='zoom-in')zoom=Math.min(1.5,zoom+.1);
      if(action==='zoom-out')zoom=Math.max(.5,zoom-.1);
      if(action==='zoom-reset')zoom=1;
      if(action==='retry')scene='normal';
      if(action==='locate'){const x=document.querySelector(`[data-reading-action=select][data-reading-id="${CSS.escape(selected)}"]`);x?.scrollIntoView({block:'center',inline:'center'});x?.focus({preventScroll:true});return;}
      const scroll=document.querySelector('.rr-map-scroll'),pos=scroll&&[scroll.scrollLeft,scroll.scrollTop];host.render();if(pos){const fresh=document.querySelector('.rr-map-scroll');if(fresh){fresh.scrollLeft=pos[0];fresh.scrollTop=pos[1];}}
    },true);
    document.addEventListener('change',event=>{if(event.target.id==='reading-scene'){scene=event.target.value;host.render();}});
  }
  window.RequirementsReading=Object.freeze({attach,render,version:'UI-CR029-v1'});
})();
