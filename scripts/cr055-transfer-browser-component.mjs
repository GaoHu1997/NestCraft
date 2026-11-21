/**
 * UI-CR055-FEAT009-v1.3 软件侧浏览器验证：真实 Chrome 渲染生产 React 传输面板。
 * 范围：组件 DOM/CSS/滚动行为/主题/窄屏；不启动 Tauri、不调用真实 IPC、不是完整应用视觉对照。
 * 滚动证据不使用 --hide-scrollbars 或测试专用隐藏样式。
 */
import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const OUT = 'docs/Test/screenshots/cr055-transfer-software';
fs.mkdirSync(OUT, { recursive: true });
const tmp = 'docs/tmp';
fs.mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: ['scripts/cr055-transfer-page.tsx'], outfile: `${tmp}/transfer-page.bundle.mjs`, bundle: true,
  platform: 'browser', format: 'esm', jsx: 'automatic', tsconfig: 'tsconfig.json', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.resolve('src') },
});
const bundle = fs.readFileSync(`${tmp}/transfer-page.bundle.mjs`, `utf8`).replace(/<\/script>/g, `<\\/script>`);
const css = [fs.readFileSync('src/theme/tokens.css', 'utf8'), fs.readFileSync('src/modules/knowledge/knowledge-performance.css', 'utf8')].join('\n');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>原件传输任务面板（组件级）</title><style>
html,body{margin:0;background:var(--bg);color:var(--ink);font:13px var(--font)}
#host{width:760px;margin:24px auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md)}
${css}
</style></head><body><div id="host"><div id="root"></div></div><script type="module">${bundle}</script></body></html>`;
fs.writeFileSync(`${tmp}/transfer-page.html`, html);

const task = (over = {}) => ({ id: 't-' + Math.random().toString(36).slice(2), libraryId: 'lib-1', kind: 'import', phase: 'copying', processedBytes: '0', totalBytes: '1000', sha256: null, noteId: null, relativeUri: null, error: null, indexPending: false, cancelRequested: false, currentFile: 'b.zip', fileIndex: 1, fileTotal: 1, completedFiles: [], failedFiles: [], ...over });
const record = (taskOver = {}, over = {}) => ({ task: task(taskOver), scope: 'lib-1:file-a', kind: taskOver.kind ?? 'import', target: '', notified: false, expired: false, ...over });
const files = n => Array.from({ length: n }, (_, i) => ({ name: `文件${i + 1}.zip`, relativeUri: `a/f${i + 1}.zip`, noteId: `n${i + 1}`, bytes: String(1073741824 * (i + 1)), sha256: 'a'.repeat(64) }));

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
const render = input => page.evaluate(value => window.renderTransfer(value), input);
const text = () => page.locator('.kp-transfer').innerText();
try {
  await page.setContent(html, { waitUntil: `load` });
  await page.waitForSelector('#root', { state: 'attached' });
  await page.waitForFunction(() => typeof window.renderTransfer === 'function');

  // picking
  await render({ tasks: [record({ phase: 'picking', currentFile: null })] });
  assert.ok((await text()).includes('等待选择原件'));
  assert.ok(await page.locator('.kp-transfer-row button', { hasText: '取消…' }).isVisible());
  await page.screenshot({ path: `${OUT}/01-picking.png` });
  checks.push('picking：等待选择原件 + 取消，无伪造进度');

  // copying 多文件
  await render({ tasks: [record({ phase: 'copying', fileTotal: 3, fileIndex: 2, completedFiles: files(1), processedBytes: '1234567890', totalBytes: '4294967296' })] });
  const copyText = await page.locator('.kp-transfer-row').innerText();
  assert.ok(copyText.includes('第 2 / 3 个文件 · 已完成 1 / 3'));
  assert.ok(copyText.includes('当前文件已处理 1,234,567,890 / 4,294,967,296 字节（28%）'));
  assert.equal(await page.locator('.kp-transfer-bar[role="progressbar"]').getAttribute('aria-valuenow'), '42');
  const width = await page.locator('.kp-transfer-bar i').evaluate(el => el.style.width);
  assert.equal(width, '42%');
  await page.screenshot({ path: `${OUT}/02-copying-multifile.png` });
  checks.push('copying：整体进度 42%（文件序号+已完成数+当前文件占比），当前文件字节独立展示');

  // 未知总量
  await render({ tasks: [record({ phase: 'copying', currentFile: 'big.log', processedBytes: '734003200', totalBytes: null })] });
  assert.ok((await text()).includes('总大小未知'));
  assert.equal(await page.locator('.kp-transfer-row').first().getAttribute('data-indeterminate'), 'true');
  assert.equal(await page.locator('.kp-transfer-bar[aria-valuenow]').count(), 0);
  await page.screenshot({ path: `${OUT}/03-unknown-total.png` });
  checks.push('未知总量：不定进度，不编造百分比');

  // completed + indexPending（含多文件明细与刷新入口）
  await render({ tasks: [record({ phase: 'completed', indexPending: true, currentFile: null, relativeUri: 'b.zip', completedFiles: files(3) })] });
  const doneText = await text();
  assert.ok(doneText.includes('已完成 · 索引待建立'));
  assert.ok(doneText.includes('已导入 3 个原件'));
  assert.ok(doneText.includes('共 6,442,450,944 字节'));
  assert.ok(doneText.includes('原件已导入，全文索引待建立'));
  assert.ok(await page.locator('.kp-transfer-row button', { hasText: '刷新当前目录' }).isVisible());
  assert.ok(!doneText.includes('索引已完成') && !doneText.includes('可全文检索'));
  assert.equal(await page.locator('.kp-transfer-files li').count(), 3);
  await page.screenshot({ path: `${OUT}/04-completed-pending-index.png` });
  checks.push('completed：多文件汇总字节、索引待建立、SHA 明细、刷新目录；不声称索引完成');

  // 部分失败
  await render({ tasks: [record({ phase: 'failed', fileTotal: 3, fileIndex: 3, completedFiles: files(2), failedFiles: [{ name: '发布包.zip', error: 'TRANSFER_TARGET_EXISTS' }], error: 'TRANSFER_TARGET_EXISTS' })] });
  const partial = await text();
  assert.ok(partial.includes('部分失败'));
  assert.ok(partial.includes('已完成 2 / 3'));
  assert.ok(partial.includes('同名文件已存在'));
  assert.ok(partial.includes('部分成功不回滚'));
  assert.equal(await page.locator('.kp-transfer-files.bad li').count(), 1);
  assert.ok(await page.locator('.kp-transfer-row button', { hasText: '重试失败项' }).isVisible());
  await page.screenshot({ path: `${OUT}/05-partial-failure.png` });
  checks.push('failed：部分成功保留 2 / 3 与失败明细，只重试失败项');

  // 过期
  await render({ tasks: [record({ phase: 'copying' }, { expired: true })] });
  const expired = await text();
  assert.ok(expired.includes('结果已过期'));
  assert.ok(expired.includes('TRANSFER_NOT_FOUND'));
  assert.ok(expired.includes('不把旧快照当成进行中或成功'));
  assert.ok(!expired.includes('取消…'));
  await page.screenshot({ path: `${OUT}/06-expired.png` });
  checks.push('expired：TRANSFER_NOT_FOUND 显示结果已过期，不再提供取消');

  // 取消确认 + 已请求取消
  await render({ tasks: [record({ phase: 'copying', processedBytes: '10' })], confirmCancel: 't1' });
  // confirmCancel 需要匹配 task.id；用固定 id 再渲染一次
  await render({ tasks: [record({ id: 't1', phase: 'copying', processedBytes: '10' })], confirmCancel: 't1' });
  assert.ok((await text()).includes('取消导入？'));
  assert.ok((await text()).includes('不会留下半成品'));
  await page.screenshot({ path: `${OUT}/07-cancel-confirm.png` });
  await render({ tasks: [record({ phase: 'copying', cancelRequested: true, processedBytes: '10' })] });
  assert.ok((await page.locator('.kp-transfer-row button', { hasText: '已请求取消…' }).isVisible()));
  checks.push('取消：确认文案与“已请求取消…”等待终态');

  // 导出完成（完整原件语义）
  await render({ tasks: [record({ kind: 'export', phase: 'completed', currentFile: null, relativeUri: 'big.log', totalBytes: '5368709120', processedBytes: '5368709120', sha256: 'f'.repeat(64) }, { kind: 'export' })] });
  const exportText = await text();
  assert.ok(exportText.includes('完整原件已写出'));
  assert.ok(exportText.includes('不是当前阅读窗口片段'));
  assert.ok(await page.locator('.kp-transfer-row button', { hasText: '复制校验值' }).isVisible());
  await page.screenshot({ path: `${OUT}/08-export-completed.png` });
  checks.push('export completed：声明完整原件，不拼接窗口，可复制校验值');

  // UI-SCROLL-001：队列溢出后的显示/隐藏与隔离
  await render({ tasks: Array.from({ length: 6 }, () => record({ phase: 'copying', processedBytes: '500', totalBytes: '1000' })) });
  const queue = page.locator('.kp-transfer-queue');
  assert.ok(await queue.evaluate(el => el.scrollHeight > el.clientHeight + 8), '队列内容溢出');
  assert.equal(await queue.evaluate(el => el.classList.contains('scrollbar-active')), false, '初始隐藏');
  const beforeWidth = await page.locator('#host').evaluate(el => el.clientWidth);
  await queue.evaluate(el => el.scrollTop = 60);
  await page.waitForTimeout(100);
  assert.ok(await queue.evaluate(el => el.classList.contains('scrollbar-active')), '滚动显示');
  await page.screenshot({ path: `${OUT}/09-scroll-active.png` });
  await page.waitForTimeout(400);
  await queue.evaluate(el => el.scrollTop = 120);
  await page.waitForTimeout(300);
  assert.ok(await queue.evaluate(el => el.classList.contains('scrollbar-active')), '连续滚动保持');
  await page.waitForTimeout(850);
  assert.equal(await queue.evaluate(el => el.classList.contains('scrollbar-active')), false, '停止≈700ms 隐藏');
  await page.screenshot({ path: `${OUT}/10-scroll-idle.png` });
  assert.equal(await page.locator('#host').evaluate(el => el.clientWidth), beforeWidth, '面板宽度不变');
  checks.push('UI-SCROLL-001：队列初始隐藏、滚动显示、连续滚动保持、停止≈700ms 隐藏、宽度不变（真实 Chrome，未隐藏滚动条）');

  // 深色 + 窄屏
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${OUT}/11-dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.getElementById('host').style.width = 'auto'; document.getElementById('host').style.margin = '8px'; });
  await page.screenshot({ path: `${OUT}/12-narrow.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  checks.push('深色与 390×844 窄视口无页面横向溢出');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');

  assert.deepEqual(errors, []);
  const result = { kind: 'production React component in real Chrome; no Tauri IPC, no app shell, not a design/software paired visual pass', count: checks.length, checks, errors, screenshots: OUT };
  fs.writeFileSync('docs/Test/cr055-transfer-component-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  fs.writeFileSync('docs/Test/cr055-transfer-component-browser-failure.json', JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }





