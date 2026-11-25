// CR-081 设计验证：设置 → 通用「数据存储」分区（隔离静态服务 + headless Edge CDP）。
// 用法：node scripts/shot-cr081.mjs
// 输出：docs/Test/screenshots/cr081/*.png + docs/Test/cr081-design-baseline.json
// 只验证设计稿本身；不代表正式软件已与设计逐像素对照。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = resolve('docs/UI');
const OUT = resolve('docs/Test/screenshots/cr081');
const PORT = 8141;
const CDP = 9452;
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
const base = `http://127.0.0.1:${PORT}/workbench-v4/index.html`;

const profile = join(tmpdir(), 'edge-cr081-' + Date.now());
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
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
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
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: base });
await sleep(1200);

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
const clickText = (text) => evalJs(`(() => {
  const el = [...document.querySelectorAll('button,a,[role=button],[role=tab],.nav-item,.s-item')]
    .find(e => (e.textContent || '').trim() === ${JSON.stringify(text)} || (e.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) return false; el.click(); return true;
})()`);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

check('打开设置', await evalJs(`(() => {
  const el = document.querySelector('[data-act="open-settings"]');
  if (!el) return false; el.click(); return true;
})()`));
await sleep(500);
const generalText = await evalJs(`document.querySelector('.set-scroll')?.innerText || ''`);
check('通用页出现「数据存储」分区', generalText.includes('数据存储'));
check('显示「数据存储位置」字段', generalText.includes('数据存储位置'));
check('说明默认安装目录 data', generalText.includes('安装目录') && generalText.includes('data'));
check('列出分类目录', ['db', 'chat', 'knowledge', 'skills', 'secrets', 'logs', 'index'].every((k) => generalText.includes(k)));
check('提示重启生效', generalText.includes('重启'));
check('知识库目录说明可见', generalText.includes('knowledge/库名'));
const images = [];
images.push(await shot('01-settings-general-storage.png'));

check('点击「选择目录」有反馈', await clickText('选择目录'));
await sleep(400);
const afterPick = await evalJs(`document.querySelector('.set-scroll')?.innerText || ''`);
check('选择后写入演示路径', afterPick.includes('NestCraft-data'));
images.push(await shot('02-data-dir-picked.png'));

check('无 JS 异常', errors.length === 0, errors.join('; '));
const passed = checks.filter((c) => c.ok).length;
writeFileSync(resolve('docs/Test/cr081-design-baseline.json'), JSON.stringify({
  designVersion: 'UI-CR081-v1',
  viewport: '1440x900',
  checks, passed, total: checks.length, images, errors,
}, null, 2));

ws.close(); edge.kill(); server.close();
console.log(`${passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.ok) console.log('FAIL:', c.name, c.detail);
if (passed !== checks.length) process.exitCode = 1;