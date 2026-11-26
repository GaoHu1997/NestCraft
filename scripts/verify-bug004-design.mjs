// BUG-004 设计验证：CLI 首轮运行态与失败重试设计稿（隔离静态服务 + headless Edge CDP）。
// 用法：node scripts/verify-bug004-design.mjs
// 输出：docs/Test/screenshots/bug004-design/*.png + docs/Test/bug004-design-baseline.json
// 只验证设计稿本身；不代表正式软件已与设计逐像素对照。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = resolve('docs/UI');
const OUT = resolve('docs/Test/screenshots/bug004-design');
const PORT = 8198;
const CDP = 9498;
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
    if (url.pathname.endsWith('/')) p = join(p, 'index.html');
    res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(p));
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${PORT}/chat-binding-bug004/index.html`;

const profile = join(tmpdir(), 'edge-bug004-' + Date.now());
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions',
  '--window-size=1440,1000', 'about:blank',
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
const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++seq;
  pending.set(id, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolvePromise(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pageUrl });
await sleep(900);

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const summary = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.card')];
  const titles = cards.map(c => c.querySelector('h2')?.textContent.trim() ?? '');
  const failCard = cards[1];
  const rows = document.querySelectorAll('.legend tbody tr').length;
  const tableText = document.querySelector('.legend table')?.textContent ?? '';
  return {
    cardCount: cards.length,
    titles,
    failHasConfirm: !!failCard?.querySelector('.banner') || [...(failCard?.querySelectorAll('button') ?? [])].some(b => /确认重建/.test(b.textContent ?? '')),
    failHasSend: /发送/.test(failCard?.textContent ?? ''),
    rows,
    tableHasCreateFailed: /CREATE_FAILED/.test(tableText),
    tableHasRunning: /运行中/.test(tableText),
    darkSupported: !!document.documentElement.dataset.theme,
  };
})()`);

check('设计稿有 3 个场景卡', summary.cardCount === 3, String(summary.cardCount));
check('包含运行中场景', /运行中/.test(summary.titles[0] ?? ''));
check('包含首轮失败场景', /失败/.test(summary.titles[1] ?? ''));
check('失败场景无「确认重建」入口', summary.failHasConfirm === false);
check('失败场景保留可发送入口', summary.failHasSend === true);
check('对照表 6 行', summary.rows === 6, String(summary.rows));
check('对照表含 CREATE_FAILED', summary.tableHasCreateFailed);
check('对照表含运行中', summary.tableHasRunning);
check('无 JS 异常', errors.length === 0, errors.join(';'));
await shot('design-light.png');

await evaluate(`document.getElementById('themeBtn').click();`);
await sleep(300);
const darkTheme = await evaluate(`document.documentElement.dataset.theme`);
check('深色切换生效', darkTheme === 'dark', darkTheme);
await shot('design-dark.png');

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
await sleep(300);
const narrow = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.card')];
  return { allVisible: cards.every(c => c.getBoundingClientRect().width > 300), overflowX: document.documentElement.scrollWidth > window.innerWidth + 2 };
})()`);
check('390 窄屏卡片可用', narrow.allVisible === true);
check('390 窄屏无横向溢出', narrow.overflowX === false);
await shot('design-narrow-390.png');

const sha = createHash('sha256').update(readFileSync(join(ROOT, 'chat-binding-bug004/index.html'))).digest('hex');
const failed = checks.filter((c) => !c.ok);
writeFileSync(resolve('docs/Test/bug004-design-baseline.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  file: 'docs/UI/chat-binding-bug004/index.html',
  sha256: sha,
  checks,
  passed: checks.length - failed.length,
  failed: failed.length,
  jsErrors: errors,
}, null, 2));

ws.close(); edge.kill(); server.close();
console.log(`\n设计稿 sha256=${sha}`);
console.log(failed.length === 0 ? `ALL PASS (${checks.length}/${checks.length})` : `${failed.length} FAILED (${checks.length - failed.length}/${checks.length})`);
process.exit(failed.length === 0 ? 0 : 1);
