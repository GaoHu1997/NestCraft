// CR-103：软件侧真实组件验证（真实 ChatQueuePanel 源码片段 + 真实 chat-actions.css
// + 真实 UI-SCROLL-001 共享滚动机制，隔离页面，不接真实业务）。
// 覆盖 CR-103 AC-CR103-01～06 的组件级呈现：单行紧凑、行内操作、元信息内联、
// 编辑态例外、列表限高滚动（滚动条按需显示）、折叠态仅头部一行。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const OUT = 'docs/Test/screenshots/cr103-software';
await mkdir(OUT, { recursive: true });

// 真实源码：从 ChatPanel.tsx 截取 ChatQueuePanel（组件内部函数，未导出，逐字截取；兼容 CRLF）。
const panel = await readFile('src/modules/chat/ChatPanel.tsx', 'utf8');
const docMark = panel.indexOf('待发队列面板（CR-103）');
const endMark = panel.indexOf('function panelRequestFromToolInput');
assert.ok(docMark > 0 && endMark > docMark, 'ChatQueuePanel source slice not found');
const start = panel.lastIndexOf('/**', docMark);
const end = panel.lastIndexOf('/**', endMark);
const slice = panel.slice(start, end).replace(/\r\n/g, '\n');
const transpiled = ts.transpileModule(slice, { fileName: 'ChatQueuePanel.tsx', reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } });
assert.deepEqual((transpiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);

// 真实 UI-SCROLL-001 共享机制（按需显示滚动条的唯一实现，应用启动时安装）。
const sbSource = await readFile('src/components/scrollbar.ts', 'utf8');
const sbJs = ts.transpileModule(sbSource, { fileName: 'scrollbar.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const css = await readFile('src/modules/chat/chat-actions.css', 'utf8');

const mkRow = (text, refs = 0, atts = 0) => ({ sid: 's', text, refs: Array.from({ length: refs }, (_, i) => ({ id: `r${i}` })), atts: Array.from({ length: atts }, (_, i) => ({ id: `a${i}` })), model: 'm', cliId: null, permissionId: 'default', scope: 'project' });
const longText = '开三个子代理 codex/claude/grok 分别给出 1-10 的一个随机数，统计给我（引用：AGENTS.md、PRD-001；附件：截图.png），并要求他们在各自目录里先阅读 AGENTS.md 再开始，最后把三份结果汇总成一张表格输出到群里供评审使用';
const rowsMany = Array.from({ length: 7 }, (_, i) => mkRow(`第 ${i + 1} 条排队消息：这是用于验证列表限高滚动的合成文本，不进入真实业务`, i % 2, i % 3));

const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'">
<title>CR-103 software queue</title>
<link rel="stylesheet" href="../../src/theme/tokens.css"><link rel="stylesheet" href="../../src/theme/base.css">
<style>${css.replace(/\0/g, '')}
body{margin:0;padding:16px;background:var(--base,#f6f7f8);font-family:system-ui,sans-serif}
.case{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:14px}
.cap{font:11px/1.4 system-ui;color:var(--muted,#8a919c);margin-bottom:6px}
.w720{width:720px}.w390{width:390px}
</style></head><body>
<div id="host"></div>
<script src="../../node_modules/react/umd/react.development.js"></script>
<script src="../../node_modules/react-dom/umd/react-dom.development.js"></script>
<script>
const module={exports:{}};const exports=module.exports;
const {useState}=React;
function require(id){
  if(id==='react')return React;
  throw new Error('unexpected require '+id);
}
${transpiled.outputText.replace(/\bexports\./g, 'module.exports.')}
const __sb=0;
${sbJs}
installScrollbarReveal();
const FX=__FIXTURES__;
const one=[FX.short], longRow=[FX.long], many=FX.many;
const host=document.getElementById('host');
function mount(id,caption,rows,opts){
  const wrap=document.createElement('div');wrap.className='case '+(opts&&opts.narrow?'w390':'w720');
  if(opts&&opts.dark)wrap.style.background='var(--paper)';
  const cap=document.createElement('div');cap.className='cap';cap.textContent=id+' · '+caption;wrap.appendChild(cap);
  const slot=document.createElement('div');slot.id=id;wrap.appendChild(slot);
  host.appendChild(wrap);
  const props={rows,paused:!!(opts&&opts.paused),folded:!!(opts&&opts.folded),
    onToggleFold:()=>{window.__foldToggled=(window.__foldToggled||0)+1;window.__fold[id]=!window.__fold[id];renderAll();},
    onRemove:i=>{window.__removed=(window.__removed||[]).concat([[id,i]]);},
    onEdit:(i,t)=>{window.__edited=(window.__edited||[]).concat([[id,i,t]]);},
    onSendNow:i=>{window.__sent=(window.__sent||[]).concat([[id,i]]);},
    onTogglePause:()=>{window.__pauseToggled=(window.__pauseToggled||0)+1;}};
  window.__props=window.__props||{};window.__props[id]=props;
  window.__fold[id]=!!(opts&&opts.folded);
  ReactDOM.createRoot(slot).render(React.createElement(ChatQueuePanel,props));
}
window.__fold={};
function renderAll(){Object.keys(window.__props).forEach(id=>{const p=window.__props[id];p.folded=!!window.__fold[id];ReactDOM.createRoot(document.getElementById(id)).render(React.createElement(ChatQueuePanel,p));});}
mount('c1','单条短消息（默认展开）',one);
mount('c2','单条长消息：截断省略＋引用/附件小标',longRow);
mount('c3','暂停态＋7 条：列表限高滚动',many,{paused:true});
mount('c4','折叠态：仅头部一行',many,{folded:true});
mount('c5','窄档 390：单行截断＋行内操作',longRow,{narrow:true});
mount('c6','窄档 390 折叠态',many,{narrow:true,folded:true});
</script></body></html>`;

const page = html
  .replace('__FIXTURES__', JSON.stringify({ short: mkRow('开三个子代理 codex/claude/grok 分别给出 1-10 的一个随机数，统计给我'), long: mkRow(longText, 2, 1), many: rowsMany }))
  .replace('require__SB()', 'function(){return{};}');
const pagePath = join(process.cwd(), 'docs/tmp/cr103-software-fixture.html');
await writeFile(pagePath, page);

// ---- headless Chrome via CDP（与 cr074/cr101 同一模式） ----
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const profile = await mkdtemp(join(tmpdir(), 'cr103-'));
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => { try { require('node:fs').accessSync(p); return true; } catch { return false; } });
let chrome, ws, seq = 0; const pending = new Map(), errors = [], result = { time: new Date().toISOString(), scope: 'software component (real ChatQueuePanel slice + real css + real scrollbar.ts)', checks: [], shots: [] };
const ok = (name, detail) => result.checks.push({ name, pass: true, detail });
try {
  assert.ok(chromePath, 'Chrome not found');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let port; for (let i = 0; i < 100 && !port; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await delay(100); } }
  assert.ok(port, 'Chrome failed to start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(x => x.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', ({ data }) => { const m = JSON.parse(data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; const t = setTimeout(() => j(Error(method + ' timeout')), 60000); pending.set(id, m => { clearTimeout(t); m.error ? j(Error(JSON.stringify(m.error))) : r(m.result); }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shot = async (name, selector) => { await frame(); let clip; if (selector) { clip = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`); } const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); result.shots.push(name + '.png'); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1400, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(pagePath).href });
  for (let i = 0; i < 100; i++) { if (await js('!!document.getElementById("c1") && !!document.querySelector("#c1 .chat-queue-panel")')) break; await delay(80); }
  await frame();
  assert.equal(await js('document.querySelectorAll(".chat-queue-panel").length'), 6); ok('six cases mounted', 'c1..c6');

  // AC-01 单行条目：文本单行 + 操作同行 + 面板高度不随长度变化
  const geom = await js(`(()=>{
    const q=s=>document.querySelector(s);
    const text=q('#c1 .chat-queue-text'), acts=q('#c1 .chat-queue-actions');
    const tx=text.getBoundingClientRect(), ac=acts.getBoundingClientRect();
    const h1=q('#c1 .chat-queue-panel').getBoundingClientRect().height;
    const h2=q('#c2 .chat-queue-panel').getBoundingClientRect().height;
    return {sameRow: Math.abs(tx.top-ac.top)<2, h1, h2, heightStable: Math.abs(h1-h2)<2,
      textOverflow: getComputedStyle(text).textOverflow, whiteSpace: getComputedStyle(text).whiteSpace};
  })()`);
  assert.equal(geom.whiteSpace, 'nowrap'); ok('AC-01 text nowrap', geom.whiteSpace);
  assert.ok(geom.sameRow, JSON.stringify(geom)); ok('AC-01 actions same row as text', 'delta <2px');
  assert.ok(geom.heightStable, `h1=${geom.h1} h2=${geom.h2}`); ok('AC-01 panel height stable regardless of text length', `short=${geom.h1}px long=${geom.h2}px`);

  // AC-01 截断省略：长消息文本实际被截断（scrollWidth > clientWidth 且 overflow hidden）
  const trunc = await js(`(()=>{const t=document.querySelector('#c2 .chat-queue-text');return {sw:t.scrollWidth,cw:t.clientWidth,oe:getComputedStyle(t).textOverflow,ell:!!t.textContent};})()`);
  assert.ok(trunc.sw > trunc.cw, JSON.stringify(trunc)); assert.equal(trunc.oe, 'ellipsis'); ok('AC-01 long text truncated with ellipsis', `scrollWidth ${trunc.sw} > clientWidth ${trunc.cw}`);

  // AC-02 元信息内联：小标与文本同行，不新增行
  const meta = await js(`(()=>{const m=document.querySelector('#c2 .chat-queue-meta');const t=document.querySelector('#c2 .chat-queue-text');
    return {sameRow:Math.abs(m.getBoundingClientRect().top-t.getBoundingClientRect().top)<2,text:m.textContent,title:m.querySelector('span').title};})()`);
  assert.ok(meta.sameRow); assert.equal(meta.text, '🔗2📎1'); ok('AC-02 meta inline same row', meta.text + ' / title=' + meta.title);

  // AC-03 编辑态例外：点编辑仅该条展开，其余保持单行
  await js(`document.querySelector('#c2 .chat-queue-actions button').click()`);
  await frame();
  const edit = await js(`(()=>{const items=document.querySelectorAll('#c2 .chat-queue-item');const e=items[0];
    return {editingClass:e.className,hasTextarea:!!e.querySelector('textarea'),itemCount:items.length,
      othersSingle:[...items].slice(1).every(li=>getComputedStyle(li.querySelector('.chat-queue-text')||li).whiteSpace!=='nowrap'?false:true)};})()`);
  assert.ok(edit.editingClass.includes('editing')); assert.ok(edit.hasTextarea); ok('AC-03 editing item expands', edit.editingClass);
  await js(`(() => {const btns=document.querySelectorAll('#c2 .chat-queue-edit-actions button');btns[1].click();})()`); await frame();
  assert.equal(await js(`document.querySelectorAll('#c2 .chat-queue-edit').length`), 0); ok('AC-03 cancel restores single line', 'edit box removed');

  // AC-04 列表限高滚动 + UI-SCROLL-001：7 条时列表自身滚动；滚动时共享机制着色，停止 700ms 后移除
  const scroll = await js(`(()=>{const l=document.querySelector('#c3 .chat-queue-list');return {mh:parseFloat(getComputedStyle(l).maxHeight),sh:l.scrollHeight,ch:l.clientHeight,scrollable:l.scrollHeight>l.clientHeight};})()`);
  assert.ok(scroll.scrollable, JSON.stringify(scroll)); assert.equal(scroll.mh, 130); ok('AC-04 list capped at 130px and scrollable', `maxHeight 130, scrollHeight ${scroll.sh}`);
  await js(`(()=>{const l=document.querySelector('#c3 .chat-queue-list');l.scrollTop=40;l.dispatchEvent(new Event('scroll'));})()`);
  await frame();
  assert.ok(await js(`document.querySelector('#c3 .chat-queue-list').classList.contains('scrollbar-active')`)); ok('AC-04/UI-SCROLL-001 scrollbar revealed while scrolling', '.scrollbar-active via shared scrollbar.ts');
  await delay(850);
  assert.ok(!(await js(`document.querySelector('#c3 .chat-queue-list').classList.contains('scrollbar-active')`))); ok('AC-04/UI-SCROLL-001 scrollbar hidden 700ms after stop', 'class removed');

  // AC-06 折叠态：仅头部一行，列表与底注不渲染（条件渲染，隐藏不销毁由卸载实现）；切换回调触发
  const fold = await js(`(()=>{const p=document.querySelector('#c4 .chat-queue-panel');
    const head=p.querySelector('.chat-queue-head').getBoundingClientRect();
    return {folded:p.className.includes('folded'),ph:p.getBoundingClientRect().height,headH:head.height,
      listRendered:!!p.querySelector('.chat-queue-list'),
      noteRendered:!!p.querySelector('.chat-queue-note'),
      pauseText:p.querySelector('.chat-queue-pause').textContent};})()`);
  assert.ok(fold.folded); assert.ok(!fold.listRendered && !fold.noteRendered); ok('AC-06 folded renders head row only', JSON.stringify(fold));
  assert.ok(fold.ph < 40, `panel ${fold.ph}px`); ok('AC-06 folded panel = head row only (≈29px)', `${fold.ph}px`);
  await js(`document.querySelector('#c4 .chat-queue-fold').click()`); await frame();
  assert.ok(await js(`!!document.querySelector('#c4 .chat-queue-list')`)); ok('AC-06 expand restores list', 'via real toggle handler');
  await js(`document.querySelector('#c4 .chat-queue-fold').click()`); await frame(); // 还原折叠态供截图
  assert.ok(!(await js(`!!document.querySelector('#c4 .chat-queue-list')`))); ok('AC-06 re-fold restores folded state', 'list unmounted again');

  // 截图（浅色组件全览 / 单案例放大）
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 2400, deviceScaleFactor: 1, mobile: false });
  await frame();
  await shot('01-all-cases-light', undefined);
  await shot('02-default-one-item', '#c1');
  await shot('03-long-truncated-meta', '#c2');
  await shot('04-paused-scroll-list', '#c3');
  await shot('05-folded', '#c4');
  await shot('06-narrow-390', '.w390');

  // 深色主题
  await js(`document.documentElement.dataset.theme='dark'`); await frame();
  await shot('07-all-cases-dark', undefined);
  await js(`document.documentElement.dataset.theme='light'`);

  assert.deepEqual(errors, []); ok('zero JS exceptions', String(errors.length));
} finally {
  try { chrome && chrome.kill(); } catch {}
  result.exceptions = errors;
  await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}
const failed = result.checks.filter(c => !c.pass);
console.log(JSON.stringify({ passed: result.checks.length, failed: failed.length, shots: result.shots, errors }, null, 2));
process.exit(failed.length || errors.length ? 1 : 0);
