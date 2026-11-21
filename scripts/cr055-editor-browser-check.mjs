import {build} from 'esbuild';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), {chromium}=require('C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright');
const output=path.resolve('scripts/cr055-editor-evidence');fs.mkdirSync(output,{recursive:true});
await build({entryPoints:['scripts/cr055-editor-browser.tsx'],bundle:true,format:'iife',platform:'browser',outfile:path.join(output,'browser.js'),define:{'process.env.NODE_ENV':'"production"'},minify:false});
const html='<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><script src="/browser.js"></script></body></html>';
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}const file=url.pathname==='/browser.js'?path.join(output,'browser.js'):url.pathname==='/browser.css'?path.join(output,'browser.css'):url.pathname==='/ui/icon-sprite.svg'?path.resolve('public/ui/icon-sprite.svg'):null;if(!file){res.statusCode=404;res.end();return}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/svg+xml');res.end(fs.readFileSync(file))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const checks=[];function check(name,value){assert.ok(value,name);checks.push(name)}
try{
 await page.goto(url+'/?lines=1000');await page.getByRole('treeitem',{name:'million.ts',exact:true}).click();await page.waitForSelector('.cm-content');await page.waitForFunction(()=>window.editorHarness.view()?.state.doc.lines===1000);
 check('tree DOM remains bounded',await page.locator('.cda-virtual-row').count()<60);
 await page.screenshot({path:path.join(output,'software-normal.png')});
 await page.evaluate(()=>{const v=window.editorHarness.view();v.dispatch({changes:{from:0,insert:'// changed\n'},userEvent:'input.type'});v.focus()});
 await page.waitForFunction(()=>window.editorHarness.counts().saveCount>=1);
 check('automatic save acknowledged',await page.locator('.cda-editor-bar [role=status]').innerText()==='已保存');
 await page.getByRole('button',{name:'窗口预览',exact:true}).click();check('explicit window preview visible',await page.locator('.cda-window-text').isVisible());await page.getByRole('button',{name:'返回编辑',exact:true}).click();check('preview return keeps edited text',await page.evaluate(()=>window.editorHarness.view().state.doc.sliceString(0,10).includes('changed')));
 await page.evaluate(()=>{window.editorHarness.failSave(true);const v=window.editorHarness.view();v.dispatch({changes:{from:0,insert:'conflict'},userEvent:'input.type'})});
 await page.waitForSelector('.cda-perf-notice.error');check('failed save preserves buffer',await page.evaluate(()=>window.editorHarness.view().state.doc.sliceString(0,8)==='conflict'));
 await page.screenshot({path:path.join(output,'software-conflict.png')});await page.evaluate(()=>window.editorHarness.failSave(false));await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cda-editor-bar [role=status]')?.textContent==='已保存');
 await page.evaluate(()=>{const v=window.editorHarness.view();v.dispatch({selection:{anchor:6,head:11}});v.scrollDOM.scrollTop=100});await page.waitForTimeout(80);
 check('real editor scrollbar active',await page.locator('.cm-scroller').evaluate(el=>el.classList.contains('scrollbar-active')));await page.screenshot({path:path.join(output,'software-scroll-active.png')});await page.waitForTimeout(760);check('real editor scrollbar hides after 700ms',await page.locator('.cm-scroller').evaluate(el=>!el.classList.contains('scrollbar-active')));check('real editor selection retained',await page.evaluate(()=>window.editorHarness.view().state.selection.main.from===6 && window.editorHarness.view().state.selection.main.to===11));await page.screenshot({path:path.join(output,'software-scroll-idle.png')});
 await page.getByRole('button',{name:'搜索文件内容',exact:true}).click();await page.getByRole('textbox',{name:'搜索文件内容',exact:true}).fill('item');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForSelector('.cda-hit');await page.getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>window.editorHarness.counts().searchCancelled);check('search cancellation reaches producer API',true);
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(output,'software-dark.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'software-narrow.png')});check('narrow no page horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 check('single save writer',await page.evaluate(()=>window.editorHarness.counts().maxWrites===1));
 fs.writeFileSync(path.join(output,'browser-functional.json'),JSON.stringify({kind:'actual frontend components / isolated IPC, not native Tauri',browser:browser.version(),checks,errors},null,2));
 await page.setViewportSize({width:1440,height:900});const start=Date.now();await page.goto(url+'/?lines=1000000');await page.getByRole('treeitem',{name:'million.ts',exact:true}).click();await page.waitForFunction(()=>window.editorHarness.view()?.state.doc.lines===1000000,null,{timeout:120000});const openedMs=Date.now()-start;
 const micro=await page.evaluate(()=>window.editorHarness.micro(200));fs.writeFileSync(path.join(output,'million-micro.json'),JSON.stringify(micro,null,2));
 const frames=await page.evaluate(()=>window.editorHarness.frames(1000));await page.screenshot({path:path.join(output,'software-million.png')});
 const report={kind:'actual CodeArea browser benchmark; isolated IPC, not native disk performance',browser:browser.version(),machine:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemory:os.totalmem()},openedMsIncludingPageLoad:openedMs,micro,frames,errors,limitations:['One browser run, not five independent sessions','RAF proxy is not compositor presentation evidence','Native IPC/disk locks/GB files and 16GiB target hardware not tested','Synthetic IPC fixture has extra source-string memory, no process-tree memory claim']};
 fs.writeFileSync(path.join(output,'million-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({functionalChecks:checks.length,...report},null,2));
 assert.equal(errors.length,0,'browser errors');
}finally{await browser.close();await new Promise(r=>server.close(r));}
