/* UI-CR048-v2：正文目录定位与办公导航前自动保存，仅设计内存。 */
(function(){
  function jump(root,index){const el=document.querySelector(root)?.querySelectorAll('.live-doc h1,.live-doc h2,.live-doc h3,.live-doc h4,.live-doc h5,.live-doc h6')[Number(index)];el?.scrollIntoView({block:'start'});}
  window.__actions['live-design-anchor']=el=>jump('.design-shell',el.dataset.index);
  window.__actions['live-req-anchor']=el=>jump('.req-workspace',el.dataset.index);
  document.addEventListener('click',e=>{
    if(!e.target.closest('[data-act^="office-"]'))return;
    const pid=Office.activeId();if(!pid)return;
    for(const id of Office.model.dirtyFiles(pid))Office.model.save(pid,id);
  },true);
})();
