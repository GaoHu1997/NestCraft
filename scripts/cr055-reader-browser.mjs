import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const OUT='docs/Test/screenshots/cr055-reader-software';fs.mkdirSync(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const counts={},model={total:50000,mode:'ready',epoch:42,tasks:new Map(),index:null,queryDelay:false,windowReads:[],cancelledSearches:[],lastLibrary:'',fixtureNote:null,notes:[],docs:new Map()};window.__readerTest={counts,model};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const idOf=(args)=>args.libraryId||args.id;
 const flat=ns=>ns.flatMap(n=>[n,...flat(n.children||[])]);
 async function handle(cmd,a,base){
  if(cmd.startsWith('kb_'))counts[cmd]=(counts[cmd]||0)+1;
  if(cmd==='kb_file_info'&&a.noteId==='CR055-WINDOW')return {noteId:a.noteId,title:'large.log',relativeUri:'synthetic/large.log',sizeBytes:5368709120,kind:'text',mime:'text/plain',previewSupported:false,editable:false};
  if(cmd==='kb_list_children'){
   model.lastLibrary=a.libraryId;
   if(!model.fixtureNote){const body='# 产品协作指南\n\n'+Array.from({length:260},(_,i)=>'## 标题 '+i+'\n\n完整正文与 **安全排版**，当前段落 '+i+'。\n\n[稍后定义的引用][ref]\n\n').join('')+'\n[ref]: #h-标题-200\n';model.fixtureNote=await base('kb_create_markdown',{id:a.libraryId,parentRelativeUri:'',name:'CR055性能测试.md',content:body});model.notes=flat(await base('kb_tree',{id:a.libraryId})).filter(n=>!n.isDir)}
   if(model.mode==='error')return {items:[],directoryRevision:'r1',nextCursor:null,complete:false,scanState:'failed',taskId:null,error:'合成目录读取失败'};
   if(model.mode==='empty')return {items:[],directoryRevision:'r1',nextCursor:null,complete:true,scanState:'ready',taskId:null,error:null};
   if(model.mode==='pending'){let task=model.tasks.get('directory');if(!task){task={id:'directory',libraryId:a.libraryId,parentId:'',kind:'directory',phase:'scanning',processedEntries:1240,processedBytes:'0',totalBytes:null,cancelRequested:false,error:null,completedCoverage:'none',updatedAt:Date.now()};model.tasks.set(task.id,task)}return {items:[],directoryRevision:'r1',nextCursor:null,complete:false,scanState:'pending',taskId:task.id,error:null}}
   const start=Number(a.cursor||0),limit=Math.min(200,a.limit||200),items=[];
   for(let i=start;i<Math.min(model.total,start+limit);i++){
    if(i===0){const n=model.fixtureNote;items.push({id:n.noteId,noteId:n.noteId,title:n.title,relativeUri:n.relativeUri,isDir:false,sizeBytes:'60000',sourceRevision:'s1',hasChildren:false})}
    else if(i===1)items.push({id:'CR055-WINDOW',noteId:'CR055-WINDOW',title:'large.log',relativeUri:'synthetic/large.log',isDir:false,sizeBytes:'5368709120',sourceRevision:'s-large',hasChildren:false});
    else items.push({id:'fixture-'+i,noteId:'fixture-'+i,title:'合成资料 '+String(i).padStart(5,'0')+'.md',relativeUri:'synthetic/'+i+'.md',isDir:false,sizeBytes:'1024',sourceRevision:'s1',hasChildren:false});
   }
   return {items,directoryRevision:'r1',nextCursor:start+limit<model.total?String(start+limit):null,complete:start+limit>=model.total,scanState:'ready',taskId:null,error:null};
  }
  if(cmd==='kb_scan_start'){model.mode='pending';model.tasks.delete('directory');const task={id:'directory',libraryId:a.libraryId,parentId:a.parentId||'',kind:'directory',phase:'scanning',processedEntries:1240,processedBytes:'0',totalBytes:null,cancelRequested:false,error:null,completedCoverage:'none',updatedAt:Date.now()};model.tasks.set(task.id,task);return {...task}}
  if(cmd==='kb_task_status')return {...model.tasks.get(a.taskId)};
  if(cmd==='kb_task_cancel'){const task=model.tasks.get(a.taskId);Object.assign(task,{phase:'cancelled',cancelRequested:true});return {...task}}
  if(cmd==='kb_search_indexed'){if(a.query==='slow')await sleep(700);const n=model.fixtureNote;return {hits:a.query==='none'?[]:[{libraryId:a.libraryId,libraryName:'合成库',noteId:n.noteId,title:a.query==='slow'?'迟到旧结果':a.query,relativeUri:n.relativeUri,snippet:'受检快照片段'}],indexEpoch:String(model.epoch),humanOnly:true,coverage:{state:'ready',incomplete:a.query==='partial',freshness:'unknown',metadataOnlyCount:0}}}
  if(cmd==='kb_search_cancel'){model.cancelledSearches.push(a.requestId);return null}
  if(cmd==='kb_index_start'){const t={id:'index-'+Date.now(),libraryId:a.libraryId,kind:'index',phase:'building',processedFiles:1240,processedBytes:'65536',totalBytes:null,cancelRequested:false,error:null,coverage:'none',snapshotEpoch:null,updatedAt:Date.now()};model.index=t;return {...t}}
  if(cmd==='kb_index_status')return {...model.index};
  if(cmd==='kb_index_cancel'){Object.assign(model.index,{phase:'cancelled',cancelRequested:true});return {...model.index}}
  if(cmd==='kb_open_document'){const doc={docId:'doc-'+Date.now(),fileId:a.fileId,revision:'source-r1',sizeBytes:'5368709120',encoding:'utf-8',mode:'window-readonly',offsetSpace:'source-byte'};doc.initialWindow={docId:doc.docId,revision:doc.revision,text:'首窗口正文\n'+('安全文本\n').repeat(500),sourceStartByte:'0',sourceEndByte:'65536',nextOffset:'65536',eof:false,offsetSpace:'source-byte'};model.docs.set(doc.docId,doc);return doc}
  if(cmd==='kb_read_window'){model.windowReads.push(a.offset);return {docId:a.docId,revision:a.revision,text:'源字节 '+a.offset+' 的真实组件窗口夹具',sourceStartByte:a.offset,sourceEndByte:String(Number(a.offset)+65536),nextOffset:String(Number(a.offset)+65536),eof:false,offsetSpace:'source-byte'}}
  if(cmd==='kb_search_document'){await sleep(60);return {docId:a.docId,revision:a.revision,hits:[{sourceStartByte:'700000',sourceEndByte:'700010',excerpt:'远离当前DOM窗口的命中'}],nextOffset:null,incomplete:false,eof:true,scannedBytes:'5368709120',offsetSpace:'source-byte'}}
  if(cmd==='kb_search_document_cancel'||cmd==='kb_close_document')return null;
  return base(cmd,a);
 }
 let internals;
 Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,get(){return internals},set(value){internals=value;const initial=value.invoke;const wrap=fn=>(cmd,a={},...rest)=>handle(cmd,a,(command,args)=>fn(command,args,...rest));let wrapped=initial?wrap(initial):undefined;Object.defineProperty(value,'invoke',{configurable:true,get(){return wrapped},set(fn){wrapped=wrap(fn)}})}});
});
const shot=async name=>{await page.screenshot({path:OUT+'/'+name+'.png'})};
try{
 await page.goto('http://localhost:18426/?preview=design');await page.waitForSelector('.nc-app');
 await page.locator('.nav-item').filter({hasText:'知识库'}).first().click();await page.locator('.kb-card .kb-actions .primary').first().click();
 await page.waitForSelector('.kp-tree-entry');await page.waitForSelector('.kp-markdown[aria-busy="false"]');assert.ok(await page.locator('.kp-tree-entry').count()<40);checks.push('production React paged tree and worker document loaded');await shot('01-ready');
 assert.ok(await page.locator('.kp-markdown h2').count()===260);assert.ok(await page.locator('.kb-toc-item').count()<40);assert.equal(await page.locator('.kp-markdown a[href="#h-标题-200"]').count(),260);checks.push('worker preserves cross-block reference links and derives virtual TOC once');
 await page.locator('.kp-tree-viewport').evaluate(e=>e.scrollTop=2000);await page.waitForTimeout(100);assert.ok(await page.locator('.kp-tree-viewport').evaluate(e=>e.classList.contains('scrollbar-active')));await shot('02-scroll-active');await page.waitForTimeout(800);assert.equal(await page.locator('.kp-tree-viewport').evaluate(e=>e.classList.contains('scrollbar-active')),false);await shot('03-scroll-idle');checks.push('real React virtual scroller obeys 700ms visibility');
 await page.locator('.kp-tree-viewport').evaluate(e=>e.scrollTop=0);await page.getByRole('button',{name:'编辑',exact:true}).last().click();const editor=page.locator('.kw-editor:not([hidden]) textarea');await editor.fill('长期保留草稿\n中文输入');await editor.press('Control+End');await editor.type(' undo-probe');await page.getByRole('button',{name:'保存',exact:true}).last().click();await page.waitForTimeout(150);assert.equal(await page.locator('.kw-editor:not([hidden]) textarea').count(),1);await editor.press('Control+z');assert.ok(!(await editor.inputValue()).endsWith('undo-probe'));checks.push('save does not unmount editor or erase native undo');
 await page.getByRole('button',{name:'阅读',exact:true}).last().click();await page.locator('input[aria-label="搜索已索引文件或正文"]').fill('slow');await page.waitForTimeout(350);await page.locator('input[aria-label="搜索已索引文件或正文"]').fill('new');await page.waitForTimeout(1100);assert.ok((await page.locator('.kb-search-hit b').allTextContents()).includes('new'));assert.ok(!(await page.locator('.kb-search-hit b').allTextContents()).includes('迟到旧结果'));assert.ok(await page.evaluate(()=>window.__readerTest.model.cancelledSearches.length>0));checks.push('search stale response rejected and real cancel command sent');await shot('04-snapshot');
 await page.getByRole('button',{name:'清除',exact:true}).click();await page.getByRole('button',{name:'重建全文索引',exact:true}).click();await page.getByRole('button',{name:'取消索引任务',exact:true}).click();await page.waitForTimeout(100);assert.ok((await page.locator('.kp-task-panel').innerText()).includes('已有快照保持'));checks.push('index task cancellation preserves old snapshot and never claims publication');await shot('05-index-cancelled');
 await page.locator('.kp-tree-viewport').evaluate(e=>e.scrollTop=0);await page.getByRole('button',{name:'large.log',exact:true}).click();await page.waitForSelector('.kp-window-source');await page.getByRole('button',{name:'下一片段',exact:true}).click();await page.waitForTimeout(100);assert.equal(await page.locator('.kp-window-source').getAttribute('data-source-start'),'65536');await page.getByLabel('搜索整个文件',{exact:true}).fill('远离');await page.getByRole('button',{name:'全文搜索',exact:true}).click();await page.waitForSelector('.kp-window-hit');await page.locator('.kp-window-hit').click();await page.waitForTimeout(100);assert.equal(await page.locator('.kp-window-source').getAttribute('data-source-start'),'700000');checks.push('5GiB declared fixture uses bounded source-byte windows and whole-file search outside current DOM');await shot('06-window');
 // Load every real page through the rendered control, never inject the private model.
 const began=performance.now();for(let i=0;i<255;i++){const done=await page.locator('.kp-tree-tools span').innerText();if(done.includes('50000'))break;await page.locator('.kp-tree-viewport').evaluate(e=>e.scrollTop=e.scrollHeight);await page.waitForTimeout(10);await page.locator('.kp-more').click();}
 assert.ok((await page.locator('.kp-tree-tools span').innerText()).includes('50000'));assert.ok(await page.locator('.kp-tree-entry').count()<40);checks.push('50000 entries fetched in 200-item pages with bounded DOM');const pageLoad50000Ms=performance.now()-began;await shot('07-50000-tree');
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await shot('08-dark');await page.setViewportSize({width:390,height:844});await shot('09-narrow');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('dark and narrow real component layout');
 assert.deepEqual(errors,[]);fs.writeFileSync('docs/Test/cr055-reader-browser.json',JSON.stringify({kind:'production React with isolated IPC fixtures, not native or GB disk benchmark',checks,count:checks.length,pageLoad50000Ms,errors,calls:await page.evaluate(()=>window.__readerTest.counts)},null,2));console.log(JSON.stringify({checks,errors,pageLoad50000Ms},null,2));
}catch(error){await shot('failure');fs.writeFileSync('docs/Test/cr055-reader-browser-failure.json',JSON.stringify({checks,errors,error:String(error)},null,2));throw error}finally{await browser.close()}
