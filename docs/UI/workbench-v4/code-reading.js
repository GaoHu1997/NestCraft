/* UI-CR048-v2：编码文件直接编辑/自动保存，仅原型内存。保留CR-045文件/Git与页签。 */
(function () {
  'use strict';
  const { D, store, esc, icon } = UI, actions = window.__actions;
  const sessions = new Map();
  const state = project => { if (!sessions.has(project)) sessions.set(project, { tabs:[], file:null, files:new Map(), rail:'files' }); return sessions.get(project); };
  const isMd = file => /\.(md|markdown)$/i.test(file);
  const modelId = (project,file) => JSON.stringify(['code',project,file]);
  function buffer(project,file) {
    const s = state(project);
    if (!s.files.has(file)) s.files.set(file,{ saved:D.files[file], draft:D.files[file], missing:typeof D.files[file] !== 'string', mode:'edit', selection:[0,0] });
    return s.files.get(file);
  }
  function syncStore(project,file) { const b=buffer(project,file); store.codeFile=file; store.codeRail=state(project).rail; store.codeEdit=true; store.editingFile=file; store.codeDraft=b.draft === b.saved ? null : b.draft; }
  function capture() { const root=document.querySelector('.code-reading-shell'); if(!root)return; const b=buffer(root.dataset.project,root.dataset.file), m=LiveDoc.get(modelId(root.dataset.project,root.dataset.file)); if(m)b.draft=m.text; }
  const originalCode=Screens.codeTab;
  Screens.codeTab = p => {
    if(p.kind==='work'||p.id!=='PRJ-1042')return originalCode(p);
    capture(); const s=state(p.id);
    if(!s.file)s.file=store.codeFile&&typeof D.files[store.codeFile]==='string'?store.codeFile:Object.keys(D.files)[0];
    if(!s.file)return originalCode(p);
    const file=s.file,b=buffer(p.id,file); if(!s.tabs.includes(file))s.tabs.push(file); syncStore(p.id,file);
    const t=document.createElement('template');t.innerHTML=originalCode(p);
    const root=t.content.querySelector('.code-shell');if(!root)return t.innerHTML;
    root.classList.add('code-reading-shell');root.dataset.project=p.id;root.dataset.file=file;root.dataset.uiVersion='UI-CR048-v2';
    root.querySelector('.editor-tabs').innerHTML=s.tabs.map(f=>`<div class="code-file-tab ${f===file?'on':''}"><button class="etab ${f===file?'active':''}" data-act="open-file" data-file="${esc(f)}">${esc(f.split('/').pop())}</button><button class="code-file-close" data-act="code-reading-close" data-file="${esc(f)}" aria-label="关闭${esc(f)}">${icon('x','ico-14')}</button></div>`).join('')+`<span class="spacer"></span><span class="caption">${esc(D.git.branch)} · 仿真</span>`;
    const main=root.querySelector('.code-main'),bar=root.querySelector('.editor-bar');
    bar.innerHTML=`<span class="path ellipsis">${esc(file)}</span><span class="spacer"></span><span class="caption">${isMd(file)?'Markdown · 所见即所得':'代码编辑器'}</span>`;
    main.querySelectorAll('.code,textarea').forEach(el=>el.remove());
    const body=b.missing?'<div class="code-reading-error">文件未提供，不允许将空缓冲覆盖未知文件。</div>':LiveDoc.render(modelId(p.id,file), b.draft,{
      source:!isMd(file), write:(text,expected)=>{ if(D.files[file]!==expected)return {ok:false,conflict:true,error:'外部版本已改变，停止自动覆盖。'}; D.files[file]=text;b.saved=text;b.draft=text;return {ok:true}; },
      onChange:text=>{b.draft=text;}, readOnly:false
    });
    main.insertAdjacentHTML('beforeend','<div class="code-reading-note">直接修改 · 停笔自动保存 · 合成样例仅存页面内存，不写项目磁盘</div>'+body);
    return t.innerHTML;
  };
  function open(file,line) { LiveDoc.flush();capture();const s=state(store.projectId);s.file=file;s.rail='files';syncStore(store.projectId,file);UI.render();if(line)requestAnimationFrame(()=>{const m=LiveDoc.get(modelId(store.projectId,file));if(m?.source){const lines=m.text.split('\n'),n=Math.max(1,Math.min(lines.length,Number(line))),offset=lines.slice(0,n-1).join('\n').length+(n>1?1:0);m.editor.focus();m.editor.setSelectionRange(offset,offset);m.editor.scrollTop=Math.max(0,(n-3)*22);}}); }
  actions['open-file']=el=>open(el.dataset.file,el.dataset.line);
  actions['code-reading-line']=el=>open(el.dataset.file||store.codeFile,el.dataset.line||1);
  actions['code-edit']=()=>{};
  actions['code-save']=()=>LiveDoc.save(modelId(store.projectId,store.codeFile));
  actions['code-rail']=el=>{capture();state(store.projectId).rail=el.dataset.rail;store.codeRail=el.dataset.rail;UI.render();};
  actions['code-reading-close']=el=>{LiveDoc.flush();const s=state(store.projectId),i=s.tabs.indexOf(el.dataset.file);if(i>=0)s.tabs.splice(i,1);if(s.file===el.dataset.file)s.file=s.tabs[Math.max(0,i-1)]||Object.keys(D.files)[0];syncStore(store.projectId,s.file);UI.render();};
  const oldNew=actions['file-new-save'];actions['file-new-save']=(el,event)=>{const f=document.getElementById('nf-path')?.value.trim();oldNew(el,event);if(f&&!document.getElementById('dialog')?.open)open(f);};
  window.CodeReading={version:'UI-CR048-v2',capture,afterRender:()=>LiveDoc.hydrate(),open,getState:state};
  UI.render();
})();
