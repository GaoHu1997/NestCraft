import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
const out='docs/Test/screenshots/cr055-reader-design';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(pathToFileURL(path.resolve('docs/UI/performance-knowledge/index.html')).href);
 await page.waitForSelector('.tree-row');assert.ok(await page.locator('.tree-row').count()<40);checks.push('200 loaded entries render bounded viewport');
 await page.screenshot({path:out+'/01-ready.png'});
 await page.evaluate(()=>window.designState.setLoaded(50000));assert.ok(await page.locator('.tree-row').count()<40);checks.push('50000 synthetic entries bounded DOM');
 await page.locator('.tree-scroll').evaluate(e=>e.scrollTop=1000);await page.waitForTimeout(70);assert.ok(await page.locator('.tree-scroll').evaluate(e=>e.classList.contains('scrollbar-active')));assert.equal(await page.locator('.body-scroll').evaluate(e=>e.classList.contains('scrollbar-active')),false);await page.screenshot({path:out+'/02-scroll-active.png'});await page.waitForTimeout(780);assert.equal(await page.locator('.tree-scroll').evaluate(e=>e.classList.contains('scrollbar-active')),false);await page.screenshot({path:out+'/03-scroll-idle.png'});checks.push('scroll active / 700ms idle / nested isolation');
 for(const state of ['loading','empty','error','partial','cancelled','budget','large','indexing','window']){await page.selectOption('#scene',state);await page.screenshot({path:out+`/state-${state}.png`});checks.push('state '+state)}
 await page.selectOption('#scene','window');await page.click('#window-next');assert.ok((await page.locator('#range').innerText()).startsWith('65536'));await page.click('#window-search');await page.waitForTimeout(450);assert.ok((await page.locator('#window-result').innerText()).includes('非完整结果'));await page.click('#window-stop');assert.ok((await page.locator('#window-result').innerText()).includes('取消'));checks.push('source window paging and bounded whole-file search feedback');
 await page.selectOption('#scene','indexing');await page.click('#index-cancel');assert.ok((await page.locator('#notice').innerText()).includes('快照 v42 仍可查询'));checks.push('index cancellation preserves published snapshot');
 await page.selectOption('#scene','loading');await page.click('#cancel');assert.equal(await page.locator('#scene').inputValue(),'cancelled');checks.push('cancel demonstration');
 await page.selectOption('#scene','ready');await page.click('#edit-mode');await page.locator('[contenteditable]').press('Control+End');await page.keyboard.type('draft-keep');await page.click('#read-mode');await page.click('#edit-mode');assert.ok((await page.locator('[contenteditable]').innerText()).includes('draft-keep'));checks.push('design draft persists through mode switch');
 await page.click('#read-mode');await page.click('#theme');await page.screenshot({path:out+'/04-dark.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/05-narrow.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.click('#drawer');assert.ok(await page.locator('aside.tree').isVisible());await page.screenshot({path:out+'/06-narrow-tree.png'});checks.push('dark and narrow drawer without page overflow');assert.deepEqual(errors,[]);
 const hash=crypto.createHash('sha256').update(fs.readFileSync('docs/UI/performance-knowledge/index.html')).digest('hex');fs.writeFileSync('docs/Test/cr055-reader-design.json',JSON.stringify({version:'UI-CR055-FEAT009-v1',hash,checks,errors,screenshots:out},null,2));console.log(JSON.stringify({hash,checks,errors},null,2));
}finally{await browser.close()}
