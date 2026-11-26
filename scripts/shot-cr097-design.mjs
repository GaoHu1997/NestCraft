// CR-097 设计验证：知识库五项修正设计稿（隔离静态服务 + headless Edge CDP）。
// 用法：node scripts/shot-cr097-design.mjs
// 输出：docs/Test/screenshots/cr097/*.png + docs/Test/cr097-design-baseline.json
// 只验证设计稿本身；不代表正式软件已与设计逐像素对照。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = resolve('docs/UI');
const OUT = resolve('docs/Test/screenshots/cr097');
const PORT = 8196;
const CDP = 9496;
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
    if (url.pathname.endsWith('/')) p = join(p, 'index.html');
    const body = readFileSync(p);
    res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const page = (qs) => `http://127.0.0.1:${PORT}/knowledge-fix-cr097/index.html?${qs}`;

const profile = join(tmpdir(), 'edge-cr097-' + Date.now());
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--disable-features=OverlayScrollbar',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const t = list.find((x) => x.type === 'page');
    if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(300);
}
if (!ws) { edge.kill(); server.close(); throw new Error('无法连接浏览器调试端口'); }
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(join(OUT, name), buf);
  return { name, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};
const viewport = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
};
const navigate = async (qs, w = 1440, h = 900) => {
  await viewport(w, h);
  await send('Page.navigate', { url: page(qs) });
  await sleep(900);
};

await send('Page.enable'); await send('Runtime.enable');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const images = [];

// ---------- SC-097-01 左栏顶部无上传按钮 ----------
await navigate('scene=upload&theme=light');
const up = await evalJs(`(() => ({
  hasTopUpload: !!document.querySelector('.kw-create-actions, .top-upload, .side-top button.upload'),
  treeUpload: document.body.innerText.includes('空间目录'),
  callout: document.body.innerText.includes('顶部「上传」按钮已移除'),
  js: !!window.__cr097
}))()`);
check('SC-097-01 顶部无独立上传按钮', up.hasTopUpload === false, JSON.stringify(up));
check('SC-097-01 空间目录与上传说明可见', up.treeUpload && up.callout);
images.push(await shot('01-upload-light.png'));
await navigate('scene=upload&theme=dark');
images.push(await shot('02-upload-dark.png'));

// ---------- SC-097-02 Office / PDF 预览 ----------
await navigate('scene=office&office=missing&theme=light');
const om = await evalJs(`document.body.innerText`);
check('SC-097-02 组件缺失状态卡', om.includes('需要本机转换组件') && om.includes('准备组件') && om.includes('下载原件') && om.includes('重试'));
images.push(await shot('03-office-missing-light.png'));
await navigate('scene=office&office=converting&theme=light');
const oc = await evalJs(`document.body.innerText`);
check('SC-097-02 转换中显示进度与取消', oc.includes('正在转换') && oc.includes('取消转换'));
images.push(await shot('04-office-converting-light.png'));
await navigate('scene=office&office=ready&theme=light');
const orr = await evalJs(`document.body.innerText`);
check('SC-097-02 预览就绪显示实际页数', orr.includes('第 1 / 12 页') && orr.includes('只读'));
images.push(await shot('05-office-ready-light.png'));
await navigate('scene=office&office=ready&pdf=1&theme=dark');
const opdf = await evalJs(`document.body.innerText`);
check('SC-097-02 PDF 直接预览无需组件', opdf.includes('PDF 直接预览') && !opdf.includes('需要本机转换组件'));
images.push(await shot('06-office-pdf-dark.png'));

// ---------- SC-097-03 图片查看器 ----------
await navigate('scene=image&theme=light');
const v1 = await evalJs(`(() => ({ open: !document.getElementById('viewer').hidden, pct: document.getElementById('vPct').textContent, foot: document.querySelector('.viewer-foot').textContent }))()`);
check('SC-097-03 查看器默认打开且 100%', v1.open && v1.pct.trim() === '100%');
check('SC-097-03 查看器具备缩放/平移说明', v1.foot.includes('滚轮缩放') && v1.foot.includes('拖拽平移'));
images.push(await shot('07-image-default-light.png'));
await evalJs(`(() => { document.getElementById('vIn').click(); document.getElementById('vIn').click(); document.getElementById('vIn').click(); return true; })()`);
await sleep(150);
const v2 = await evalJs(`document.getElementById('vPct').textContent`);
check('SC-097-03 放大后百分比变化', v2.trim() !== '100%', v2);
images.push(await shot('08-image-zoomed-light.png'));

// ---------- SC-097-04 Markdown 阅读页 ----------
await navigate('scene=md&hover=0&theme=light');
const md0 = await evalJs(`(() => {
  const a = document.querySelector('.doc-actions');
  const el = document.getElementById('docScroll');
  const cs = getComputedStyle(a);
  const btn = a.querySelector('button');
  return { opacity: cs.opacity, visibility: cs.visibility, pointer: cs.pointerEvents, scrollable: el.scrollHeight > el.clientHeight + 4, firstBtnFocusable: btn ? btn.tabIndex >= 0 : false };
})()`);
check('SC-097-04 右上操作组默认透明、不可点（但键盘可达）', md0.opacity === '0' && md0.pointer === 'none' && md0.firstBtnFocusable === true, JSON.stringify(md0));
check('SC-097-04 正文可滚动（超出首屏）', md0.scrollable === true);
images.push(await shot('09-md-actions-hidden-light.png'));
await navigate('scene=md&hover=1&theme=light');
const md1 = await evalJs(`getComputedStyle(document.querySelector('.doc-actions')).opacity`);
check('SC-097-04 悬停后操作组浮现', md1 === '1', md1);
images.push(await shot('10-md-actions-hover-light.png'));
await evalJs(`(() => { const el = document.getElementById('docScroll'); el.scrollTop = 520; el.dispatchEvent(new Event('scroll', { bubbles: false })); return el.scrollTop; })()`);
await sleep(120);
const sc = await evalJs(`(() => { const el = document.getElementById('docScroll'); return { top: el.scrollTop, active: el.classList.contains('scrollbar-active') }; })()`);
check('SC-097-04 滚动生效并出现按需滚动条', sc.top > 0 && sc.active === true, JSON.stringify(sc));
images.push(await shot('11-md-scrolling-light.png'));
await navigate('scene=md&hover=1&theme=dark');
images.push(await shot('12-md-actions-hover-dark.png'));
await navigate('scene=md&hover=1&theme=light', 390, 844);
const narrow = await evalJs(`(() => ({ w: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 1 }))()`);
check('SC-097-04 390 窄屏无整页横向溢出', narrow.overflowX === false, JSON.stringify(narrow));
images.push(await shot('13-md-narrow-light.png'));

// ---------- SC-097-05 语义模型目录位置 ----------
await navigate('scene=model&theme=light');
const model = await evalJs(`document.body.innerText`);
check('SC-097-05 模型目录在数据根 semantic-model 下', model.includes('data\\semantic-model'));
check('SC-097-05 显示迁移记录与数据根', model.includes('数据根') && model.includes('迁移'));
images.push(await shot('14-model-light.png'));
await navigate('scene=model&theme=dark');
images.push(await shot('15-model-dark.png'));

check('全程无 JS 异常', errors.length === 0, errors.join('; '));
const passed = checks.filter((c) => c.ok).length;
writeFileSync(resolve('docs/Test/cr097-design-baseline.json'), JSON.stringify({
  designVersion: 'UI-CR097-v1',
  design: 'docs/UI/knowledge-fix-cr097/index.html',
  viewport: '1440x900 (+390x844 narrow)',
  checks, passed, total: checks.length, images, errors,
}, null, 2));

ws.close(); edge.kill(); server.close();
console.log(`${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) console.log('FAIL:', c.name, c.detail);
if (passed !== checks.length) process.exitCode = 1;
