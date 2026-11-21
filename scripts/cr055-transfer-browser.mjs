import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const OUT='docs/Test/screenshots/cr055-transfer-software';fs.mkdirSync(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const counts={},model={total:50000,mode:'ready',epoch:42,tasks:new Map(),index:null,transfers:new Map(),transferStatusCalls:0,transferCancelCalls:0,queryDelay:false,windowReads:[],cancelledSearches:[],lastLibrary:'',fixtureNote:null,notes:[],docs:new Map()};window.__readerTest={counts,model};
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
  if(cmd==='kb_transfer_import'||cmd==='kb_transfer_export'){
   const kind=cmd==='kb_transfer_import'?'import':'export';
   const task={id:a.taskId,libraryId:a.libraryId,kind,phase:'picking',processedBytes:'0',totalBytes:null,sha256:null,noteId:a.noteId||null,relativeUri:null,error:null,indexPending:false,cancelRequested:false,currentFile:null,fileIndex:0,fileTotal:0,completedFiles:[],failedFiles:[]};
   model.transfers.set(task.id,task);return {...task};
  }
  if(cmd==='kb_transfer_status'){
   model.transferStatusCalls++;
   const task=model.transfers.get(a.taskId);
   if(!task||task.__evicted)throw new Error('TRANSFER_NOT_FOUND: task evicted');
   return {...task};
  }
  if(cmd==='kb_transfer_cancel'){
   model.transferCancelCalls++;
   const task=model.transfers.get(a.taskId);
   task.cancelRequested=true;
   return {...task};
  }
  if(cmd==='kb_search_document_cancel'||cmd==='kb_close_document')return null;
  return base(cmd,a);
 }
 let internals;
 Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,get(){return internals},set(value){internals=value;const initial=value.invoke;const wrap=fn=>(cmd,a={},...rest)=>handle(cmd,a,(command,args)=>fn(command,args,...rest));let wrapped=initial?wrap(initial):undefined;Object.defineProperty(value,'invoke',{configurable:true,get(){return wrapped},set(fn){wrapped=wrap(fn)}})}});
});
const shot = async name => { await page.screenshot({ path: OUT + '/' + name + '.png' }); };
const text = async selector => (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ');
const model = () => page.evaluate(() => window.__readerTest.model);
try {
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForSelector('.nc-app');
  await page.locator('.nav-item').filter({ hasText: '知识库' }).first().click();
  await page.locator('.kb-card .kb-actions .primary').first().click();
  await page.waitForSelector('.kp-tree-entry');
  await page.waitForSelector('.kp-markdown[aria-busy="false"]');
  checks.push('生产 React 知识库页面加载完成（隔离 IPC 夹具，不是原生 Tauri）');

  // 1. 导入入口 → picking 面板
  await page.locator('.kp-entry button', { hasText: '导入原件（大文件）' }).click();
  await page.waitForSelector('.kp-transfer');
  assert.ok((await page.locator('.kp-transfer').innerText()).includes('等待选择原件'));
  assert.ok((await page.locator('.kp-transfer-row button', { hasText: '取消…' }).count()) === 1);
  await shot('01-import-picking');
  checks.push('导入入口启动 kb_transfer_import，picking 显示“等待选择原件”且可取消，无伪造进度');

  // 2. copying：多文件整体进度 + 当前文件字节
  await page.evaluate(() => {
    const t = [...window.__readerTest.model.transfers.values()][0];
    Object.assign(t, { phase: 'copying', fileTotal: 3, fileIndex: 2, currentFile: 'b.zip', processedBytes: '1234567890', totalBytes: '4294967296', completedFiles: [{ name: 'a.zip', relativeUri: 'a/a.zip', noteId: 'n1', bytes: '1073741824', sha256: 'a'.repeat(64) }] });
  });
  await page.waitForTimeout(450);
  const row = page.locator('.kp-transfer-row').first();
  assert.ok((await row.innerText()).includes('第 2 / 3 个文件 · 已完成 1 / 3'), '批次进度可见');
  assert.ok((await row.innerText()).includes('当前文件已处理 1,234,567,890 / 4,294,967,296 字节'), '当前文件字节可见');
  assert.equal(await row.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '42');
  await shot('02-import-copying');
  checks.push('copying 同时展示“第 N / 总文件数、已完成数、当前文件字节”，整体进度 42% 来自文件数与当前文件占比');

  // 3. 取消确认 + 取消竞态（cancel 返回 copying，随后 completed 生效）
  await page.locator('.kp-transfer-row button', { hasText: '取消…' }).click();
  assert.ok((await page.locator('.kp-transfer-note[role="alert"]').innerText()).includes('不会留下半成品'));
  await page.locator('.kp-transfer-row button', { hasText: '确认取消' }).click();
  await page.waitForTimeout(120);
  assert.ok((await page.locator('.kp-transfer-row').first().innerText()).includes('已请求取消'), 'cancel 返回 copying 后显示已请求取消');
  assert.equal((await model()).transferCancelCalls, 1);
  await page.evaluate(() => {
    const t = [...window.__readerTest.model.transfers.values()][0];
    Object.assign(t, { phase: 'completed', indexPending: true, cancelRequested: false, currentFile: null, relativeUri: 'a/b.zip', processedBytes: '0', totalBytes: null, completedFiles: [{ name: 'a.zip', relativeUri: 'a/a.zip', noteId: 'n1', bytes: '1073741824', sha256: 'a'.repeat(64) }, { name: 'b.zip', relativeUri: 'a/b.zip', noteId: 'n2', bytes: '2147483648', sha256: 'b'.repeat(64) }, { name: 'c.zip', relativeUri: 'a/c.zip', noteId: 'n3', bytes: '3221225472', sha256: 'c'.repeat(64) }] });
  });
  await page.waitForTimeout(450);
  const completed = await page.locator('.kp-transfer-row').first().innerText();
  assert.ok(completed.includes('已完成 · 索引待建立'), 'completed 状态标签');
  assert.ok(completed.includes('已导入 3 个原件'), '按完成文件数展示');
  assert.ok(completed.includes('共 6,442,450,944 字节'), '按 BigInt 汇总字节');
  assert.ok((await page.locator('.kp-transfer-note.good').innerText()).includes('原件已导入，全文索引待建立'));
  assert.ok((await page.locator('.kp-transfer-note.good').innerText()).includes('全文检索要等索引任务完成'));
  const afterComplete = (await model()).kb_scan_start ?? 0;
  assert.ok(afterComplete > 0, '导入完成后刷新当前目录');
  await shot('03-import-completed-pending-index');
  checks.push('completed+indexPending 明确“原件已导入、全文索引待建立”，按完成文件汇总字节并刷新当前目录');

  // 4. 终态后停止轮询
  const settledCalls = (await model()).transferStatusCalls;
  await page.waitForTimeout(900);
  assert.equal((await model()).transferStatusCalls, settledCalls, '终态后不再轮询');
  checks.push('completed 后 300ms 轮询停止（900ms 内状态调用次数不变）');
  await page.locator('.kp-transfer-row button', { hasText: '关闭' }).click();

  // 5. 大文件导出 → 部分失败明细
  await page.locator('.kp-tree-viewport').evaluate(e => e.scrollTop = 0);
  await page.getByRole('button', { name: 'large.log', exact: true }).click();
  await page.waitForSelector('.kp-window-source');
  await page.locator('.kw-toolbar button', { hasText: '导出原件（大文件）' }).click();
  await page.waitForSelector('.kp-transfer-row');
  await page.evaluate(() => {
    const t = [...window.__readerTest.model.transfers.values()].pop();
    Object.assign(t, { phase: 'failed', fileTotal: 3, fileIndex: 3, currentFile: '发布包.zip', completedFiles: [{ name: '年度归档.zip', relativeUri: 'a/年.zip', noteId: 'n1', bytes: '1000', sha256: 'a'.repeat(64) }, { name: '素材包.zip', relativeUri: 'a/素.zip', noteId: 'n2', bytes: '2000', sha256: 'b'.repeat(64) }], failedFiles: [{ name: '发布包.zip', error: 'TRANSFER_TARGET_EXISTS' }], error: 'TRANSFER_TARGET_EXISTS' });
  });
  await page.waitForTimeout(450);
  const failedRow = page.locator('.kp-transfer-row').last();
  assert.ok((await failedRow.innerText()).includes('部分失败'));
  assert.ok((await failedRow.innerText()).includes('已完成 2 / 3'));
  assert.ok((await failedRow.innerText()).includes('发布包.zip'));
  assert.ok((await failedRow.innerText()).includes('同名文件已存在'));
  assert.ok((await page.locator('.kp-transfer-row button', { hasText: '重试失败项' }).count()) === 1);
  await shot('04-export-partial-failure');
  checks.push('导出 5GiB 原件走传输任务；部分失败展示已完成 2 / 3 与 failedFiles 明细，并只提供重试失败项入口');
  await page.locator('.kp-transfer-row button', { hasText: '关闭' }).click();

  // 6. TRANSFER_NOT_FOUND → 结果已过期并停止轮询
  await page.locator('.kp-entry button', { hasText: '导入原件（大文件）' }).click();
  await page.waitForSelector('.kp-transfer-row');
  await page.evaluate(() => { const t = [...window.__readerTest.model.transfers.values()].pop(); t.__evicted = true; });
  await page.waitForTimeout(500);
  const expiredRow = page.locator('.kp-transfer-row').last();
  assert.ok((await expiredRow.innerText()).includes('结果已过期'));
  assert.ok((await expiredRow.innerText()).includes('TRANSFER_NOT_FOUND'));
  const expiredCalls = (await model()).transferStatusCalls;
  await page.waitForTimeout(800);
  assert.equal((await model()).transferStatusCalls, expiredCalls, '过期后停止轮询');
  assert.ok((await page.locator('.kw-error-text').count()) === 0, '过期不当作普通错误横幅');
  await shot('05-expired');
  checks.push('TRANSFER_NOT_FOUND 显示“结果已过期”并停止轮询，不冒充失败/进行中，不弹错误横幅');
  await page.locator('.kp-transfer-row button', { hasText: '关闭' }).click();

  // 7. 切文件停止轮询、切回恢复；旧任务不串到新作用域
  await page.locator('.kp-entry button', { hasText: '导入原件（大文件）' }).click();
  await page.waitForSelector('.kp-transfer-row');
  const scoped = (await model()).transferStatusCalls;
  await page.locator('.kp-tree-viewport').evaluate(e => e.scrollTop = 0);
  await page.getByRole('button', { name: /合成资料 0000[1-9]\.md/ }).first().click();
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.kp-transfer').count(), 0, '切文件后旧任务不显示');
  const away = (await model()).transferStatusCalls;
  await page.waitForTimeout(700);
  assert.equal((await model()).transferStatusCalls, away, '切文件后停止轮询');
  await page.getByRole('button', { name: 'large.log', exact: true }).click();
  await page.waitForSelector('.kp-transfer');
  await page.waitForTimeout(500);
  assert.ok((await model()).transferStatusCalls > away, '切回后恢复轮询');
  checks.push('切文件后旧任务不进入新作用域且停止轮询，切回后恢复同一任务');
  checks.push('作用域隔离：state 差异 ' + (away - scoped >= 0 ? '正常' : '异常'));

  // 8. 队列溢出时 UI-SCROLL-001：滚动显示、停止 700ms 隐藏、不唤醒正文
  for (let i = 0; i < 4; i++) await page.locator('.kp-entry button', { hasText: '导入原件（大文件）' }).click();
  await page.waitForTimeout(200);
  const queue = page.locator('.kp-transfer-queue');
  assert.ok(await queue.evaluate(el => el.scrollHeight > el.clientHeight + 8), '队列内容溢出');
  assert.equal(await queue.evaluate(el => el.classList.contains('scrollbar-active')), false, '初始隐藏');
  const widthBefore = await page.locator('.kw-scroll').evaluate(el => el.clientWidth);
  await queue.evaluate(el => el.scrollTop = 60);
  await page.waitForTimeout(100);
  assert.ok(await queue.evaluate(el => el.classList.contains('scrollbar-active')), '滚动显示');
  assert.equal(await page.locator('.kw-scroll').evaluate(el => el.classList.contains('scrollbar-active')), false, '不唤醒正文滚动条');
  await shot('06-transfer-scroll-active');
  await page.waitForTimeout(400);
  await queue.evaluate(el => el.scrollTop = 100);
  await page.waitForTimeout(300);
  assert.ok(await queue.evaluate(el => el.classList.contains('scrollbar-active')), '连续滚动保持');
  await page.waitForTimeout(850);
  assert.equal(await queue.evaluate(el => el.classList.contains('scrollbar-active')), false, '停止约700ms隐藏');
  assert.equal(await page.locator('.kw-scroll').evaluate(el => el.clientWidth), widthBefore, '正文宽度不变');
  await shot('07-transfer-scroll-idle');
  checks.push('UI-SCROLL-001：传输队列初始隐藏、滚动显示、连续滚动保持、停止≈700ms 隐藏、正文滚动条不唤醒、正文宽度不变');

  // 9. 深色与窄屏
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await shot('08-transfer-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('09-transfer-narrow');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  checks.push('传输面板深色与 390×844 窄视口无页面横向溢出');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');

  assert.deepEqual(errors, []);
  const counts = await page.evaluate(() => window.__readerTest.counts);
  fs.writeFileSync('docs/Test/cr055-transfer-browser.json', JSON.stringify({ kind: 'production React with isolated IPC fixtures, not native Tauri or real GB disk', checks, count: checks.length, errors, calls: counts }, null, 2));
  console.log(JSON.stringify({ count: checks.length, checks, errors, calls: counts }, null, 2));
} catch (error) {
  await shot('failure');
  fs.writeFileSync('docs/Test/cr055-transfer-browser-failure.json', JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }

