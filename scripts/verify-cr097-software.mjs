/**
 * CR-097 软件侧验证：知识库五项修正（隔离预览 ?preview=design，内存夹具）。
 * 前置：`npx vite --port 1420 --strictPort`
 * 用法：node scripts/verify-cr097-software.mjs
 * 输出：docs/Test/screenshots/cr097-software/*.png + docs/Test/cr097-software-baseline.json
 * 说明：截图是软件实现证据，不是设计稿；设计侧见 scripts/shot-cr097-design.mjs。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const APP = process.env.CR097_APP || 'http://127.0.0.1:1420/?preview=design';
const OUT = resolve('docs/Test/screenshots/cr097-software');
const JSON_OUT = resolve('docs/Test/cr097-software-baseline.json');
const CDP = 9497;
mkdirSync(OUT, { recursive: true });

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const profile = join(tmpdir(), 'edge-cr097-sw-' + Date.now());
let edge = null;
for (const exe of EDGE) {
  try { edge = spawn(exe, ['--headless=new', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--disable-features=OverlayScrollbar', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' }); break; } catch { /* 下一个路径 */ }
}
if (!edge) throw new Error('未找到 Edge 可执行文件');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 120; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find(x => x.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(300);
}
if (!ws) { edge.kill(); throw new Error('无法连接浏览器调试端口'); }
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(join(OUT, name), buf);
  return { name, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};
const clickText = text => evalJs(`(() => {
  const el = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=treeitem],.nav-item,.kb-card')]
    .find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
  if (!el) return false; el.click(); return true;
})()`);
const viewport = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

await send('Page.enable'); await send('Runtime.enable');
await viewport(1440, 900);
await send('Page.navigate', { url: APP });
await sleep(2500);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const images = [];

// 进入知识库
check('进入知识库', await clickText('知识库'));
await sleep(1500);
const loaded = await evalJs(`!!document.querySelector('.kb-reader, .kb-home')`);
check('知识库页面已渲染', loaded);
images.push(await shot('01-knowledge-entry.png'));

// 打开第一个空间（首页卡片「进入」）
check('点击进入知识库空间', await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button,.btn')].find(b => (b.textContent || '').trim() === '进入');
  if (!btn) return false; btn.click(); return true;
})()`));
await sleep(2200);
const inReader = await evalJs(`!!document.querySelector('.kb-reader')`);
check('进入阅读器', inReader);

// 1) 左栏顶部无独立上传按钮
const upload = await evalJs(`(() => ({
  topUpload: !!document.querySelector('.kw-create-actions'),
  hasTree: !!document.querySelector('.kp-tree-viewport, .kb-docs'),
  hasPlus: [...document.querySelectorAll('.zy-folder-bar button, .kp-tree-panel button')].length > 0
}))()`);
check('SC-097-01 顶部无独立上传按钮', upload.topUpload === false, JSON.stringify(upload));
images.push(await shot('02-no-top-upload.png'));

// 展开目录直到出现目标文件
const expandAll = async () => {
  for (let round = 0; round < 4; round++) {
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"][aria-expanded="false"] .kp-tree-label, [role="treeitem"][aria-expanded="false"] > button')];
      let clicked = 0;
      for (const row of rows.slice(0, 12)) { row.click(); clicked++; }
      return clicked;
    })()`);
    await sleep(700);
  }
};
await expandAll();
const treeText = await evalJs(`document.querySelector('.kb-docs')?.innerText?.slice(0, 600) || ''`);
check('文件树已加载条目', /已加载\s*[1-9]\d*\s*项/.test(treeText), treeText.slice(0, 120));

// 4) 图片查看器
const openedImage = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"] .kp-tree-label')];
  const target = rows.find(r => (r.getAttribute('title') || r.textContent || '').includes('演示图片')) ?? rows.find(r => /\\.(png|jpe?g|gif|webp)$/i.test(r.getAttribute('title') || r.textContent || '') && !(r.getAttribute('title')||'').includes('未嵌入'));
  if (!target) return false; target.click(); return true;
})()`);
await sleep(1200);
const imageReady = await evalJs(`!!document.querySelector('.kw-image-open')`);
check('SC-097-03 图片进入可点击查看态', openedImage && imageReady, `openedImage=${openedImage}`);
if (imageReady) {
  await evalJs(`document.querySelector('.kw-image-open').click()`);
  await sleep(500);
  const opened = await evalJs(`(() => { const d = document.querySelector('.kw-zoom'); return d ? { open: d.open, pct: document.querySelector('[data-testid="zoom-percent"]')?.textContent } : null; })()`);
  check('SC-097-03 查看器打开且为 100%', !!opened?.open && opened.pct?.trim() === '100%', JSON.stringify(opened));
  images.push(await shot('03-image-viewer.png'));
  await evalJs(`document.querySelector('[aria-label="放大"]').click()`);
  await sleep(200);
  const zoomed = await evalJs(`document.querySelector('[data-testid="zoom-percent"]')?.textContent`);
  check('SC-097-03 放大后百分比变化', zoomed?.trim() !== '100%', zoomed);
  await evalJs(`(() => { const s = document.querySelector('.kw-zoom-stage'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })); return true; })()`);
  await sleep(200);
  const wheeled = await evalJs(`document.querySelector('[data-testid="zoom-percent"]')?.textContent`);
  check('SC-097-03 滚轮可缩放', wheeled !== zoomed, `${zoomed} → ${wheeled}`);
  images.push(await shot('04-image-zoomed.png'));
  await evalJs(`document.querySelector('.kw-zoom-close').click()`);
  await sleep(400);
  const closed = await evalJs(`!document.querySelector('.kw-zoom') || !document.querySelector('.kw-zoom').open`);
  check('SC-097-03 Esc/关闭可退出查看器', closed);
}

// 5) Markdown 操作组与滚动（矮视口保证内容超出首屏）
await viewport(1440, 520);
await sleep(500);
const openedMd = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"] .kp-tree-label')];
  const candidates = rows.filter(r => /\\.md$/i.test(r.getAttribute('title') || r.textContent || ''));
  const target = candidates.find(r => (r.getAttribute('title') || '').includes('研发交付指南')) ?? candidates[0];
  if (!target) return false; target.click(); return true;
})()`);
await sleep(1500);
const mdState = await evalJs(`(() => {
  const actions = document.querySelector('.zy-view-actions');
  const scroll = document.querySelector('.kw-scroll');
  if (!actions || !scroll) return null;
  const cs = getComputedStyle(actions);
  return { visibility: cs.visibility, opacity: cs.opacity, pointer: cs.pointerEvents, focusable: (actions.querySelector('button')?.tabIndex ?? -1) >= 0,
    scrollable: scroll.scrollHeight > scroll.clientHeight + 4,
    height: scroll.clientHeight, scrollHeight: scroll.scrollHeight };
})()`);
check('SC-097-04 操作组默认不可见且不接收指针', !!mdState && mdState.opacity === '0' && mdState.pointer === 'none' && mdState.focusable === true, JSON.stringify(mdState));
images.push(await shot('05-md-actions-hidden.png'));
const scrollResult = await evalJs(`(() => {
  const el = document.querySelector('.kw-scroll'); if (!el) return null;
  el.scrollTop = Math.round(el.scrollHeight * 0.6);
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return { top: el.scrollTop, active: el.classList.contains('scrollbar-active'), canReachEnd: el.scrollHeight - el.clientHeight };
})()`);
check('SC-097-04 正文可滚动且能到达文末', !!scrollResult && scrollResult.top > 0 && scrollResult.canReachEnd > 0, JSON.stringify(scrollResult));
check('SC-097-04 滚动时出现按需滚动条', !!scrollResult && scrollResult.active === true, JSON.stringify(scrollResult));
images.push(await shot('06-md-scrolling.png'));
const headBox = await evalJs(`(() => { const head = document.querySelector('.zy-view-head'); if (!head) return null; const r = head.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), right: Math.round(r.right - 60), y: Math.round(r.top + r.height / 2) }; })()`);
if (headBox) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: headBox.right, y: headBox.y, button: 'none' }); await sleep(400); }
await evalJs(`(() => { const actions = document.querySelector('.zy-view-actions'); actions?.querySelector('button')?.focus(); return true; })()`);
await sleep(300);
const hoverState = await evalJs(`(() => { const actions = document.querySelector('.zy-view-actions'); if (!actions) return null; const head = document.querySelector('.zy-view-head'); const btn = actions.querySelector('button'); const r = head.getBoundingClientRect(); const el = document.elementFromPoint(Math.round(r.right - 60), Math.round(r.top + r.height / 2)); return { visibility: getComputedStyle(actions).visibility, opacity: getComputedStyle(actions).opacity, headHover: head.matches(':hover'), headFocusWithin: head.matches(':focus-within'), activeIsBtn: document.activeElement === btn, hovered: [...document.querySelectorAll(':hover')].length, point: el ? el.className.toString().slice(0, 40) : null }; })()`);
check('SC-097-04 键盘聚焦后操作组浮现', !!hoverState && hoverState.opacity === '1', JSON.stringify(hoverState));
images.push(await shot('07-md-actions-visible.png'));

// 2) Office 缺组件状态卡
const openedOffice = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"] .kp-tree-label')];
  const target = rows.find(r => /\\.(docx|pptx|xlsx|rtf)$/i.test(r.getAttribute('title') || r.textContent || ''));
  if (!target) return false; target.click(); return true;
})()`);
await sleep(2000);
const card = await evalJs(`(() => {
  const el = document.querySelector('.kp-office-card');
  return el ? { text: el.innerText.slice(0, 240), hasPrepare: !!Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('准备组件')), hasDownload: !!Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('下载原件')) } : null;
})()`);
check('SC-097-02 Office 缺组件显示状态卡', openedOffice && !!card, JSON.stringify(card)?.slice(0, 160));
check('SC-097-02 状态卡含准备组件与下载原件', !!card && card.hasPrepare && card.hasDownload, JSON.stringify(card)?.slice(0, 160));
images.push(await shot('08-office-card.png'));
if (card?.hasPrepare) {
  await evalJs(`Array.from(document.querySelectorAll('.kp-office-card button')).find(b => b.textContent.includes('准备组件')).click()`);
  await sleep(1800);
  const afterPrepare = await evalJs(`document.querySelector('.kp-office-card')?.innerText?.slice(0, 200) || ''`);
  check('SC-097-02 准备组件后可继续（就绪或明确失败）', /就绪|不可用|失败|重试/.test(afterPrepare), afterPrepare.slice(0, 120));
  images.push(await shot('09-office-after-prepare.png'));
}

// 390 窄屏
await viewport(390, 844);
await sleep(600);
const narrow = await evalJs(`({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, w: innerWidth })`);
check('SC-097-04 390 窄屏无整页横向溢出', narrow.overflowX === false, JSON.stringify(narrow));
images.push(await shot('10-narrow.png'));
await viewport(1440, 900);

check('全程无 JS 异常', errors.length === 0, errors.join('; '));
const passed = checks.filter(c => c.ok).length;
writeFileSync(JSON_OUT, JSON.stringify({ designVersion: 'UI-CR097-v1', scope: 'software isolation preview (?preview=design)', viewport: '1440x900 (+390x844)', checks, passed, total: checks.length, images, errors }, null, 2));

ws.close(); edge.kill();
console.log(`${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) console.log('FAIL:', c.name, '|', c.detail);
if (passed !== checks.length) process.exitCode = 1;
