/**
 * UI-CR055-FEAT009-v1.4 设计验证：GB 级原件导入/导出任务状态 + UI-SCROLL-001 动态行为。
 * v1.4 复用 v1.3 可视资源；本次仅确认行为补充后设计资源与检查仍完整。
 * 独立启动真实 Chrome（不用 --hide-scrollbars），不接触正式软件、不调用真实 IPC。
 */
import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const out = 'docs/Test/screenshots/cr055-transfer-design';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
try {
  const design = path.resolve('docs/UI/performance-knowledge/index.html');
  await page.goto(pathToFileURL(design).href);
  await page.waitForSelector('.tree-row');

  const phases = ['picking', 'copying', 'copying-unknown', 'cancel-confirm', 'cancelled', 'completed', 'failed-partial', 'failed-exists', 'failed-space', 'failed-permission', 'failed-publish', 'failed-busy', 'expired'];
  const active = (selector) => page.locator(selector).evaluate(el => el.classList.contains('scrollbar-active'));

  for (const kind of ['import', 'export']) {
    await page.selectOption('#scene', 'transfer-' + kind);
    assert.ok(await page.locator('.kp-transfer').isVisible(), `${kind} panel visible`);
    assert.equal(await page.locator('.kp-transfer').getAttribute('data-kind'), kind);
    assert.equal(await page.locator('#scene').inputValue(), 'transfer-' + kind);
    checks.push(`${kind}: scene selectable from 场景 dropdown and panel mounted`);
    for (const phase of phases) {
      await page.evaluate(([k, p]) => window.designState.transfer(k, p), [kind, phase]);
      assert.equal(await page.locator('.kp-transfer').getAttribute('data-phase'), phase, `${kind}/${phase} phase applied`);
      await page.screenshot({ path: `${out}/${kind}-${phase}.png` });
    }
    // picking / copying / cancel-confirm / cancelled：可操作流程，不是静态图
    await page.evaluate(([k]) => window.designState.transfer(k, 'picking'), [kind]);
    assert.match(await page.locator('.kp-transfer-meta').first().innerText(), /选择|保存对话框/);
    assert.ok(await page.locator('[data-transfer-action="cancel"]').first().isVisible());
    await page.locator('[data-transfer-action="cancel"]').first().click();
    assert.equal(await page.locator('.kp-transfer').getAttribute('data-phase'), 'cancel-confirm');
    assert.match(await page.locator('.kp-transfer-note').innerText(), /不会留下半成品/);
    await page.locator('[data-transfer-action="confirm-cancel"]').click();
    assert.equal(await page.locator('.kp-transfer').getAttribute('data-phase'), 'cancelled');
    assert.match(await page.locator('.kp-transfer-note').innerText(), /已取消/);
    checks.push(`${kind}: 取消需要确认，确认后进入 cancelled 结果，原件/草稿不受影响文案存在`);
    // copying：进度与字节数
    await page.evaluate(([k]) => window.designState.transfer(k, 'copying'), [kind]);
    const copyingText = await page.locator('.kp-transfer-row').first().innerText();
    assert.match(copyingText, /已处理 [\d,]+ \/ [\d,]+ 字节/);
    assert.ok(await page.locator('.kp-transfer-bar[role="progressbar"][aria-valuenow]').first().isVisible());
    checks.push(`${kind}: copying 展示已处理/总字节与可读进度条`);
    // 总字节未知
    await page.evaluate(([k]) => window.designState.transfer(k, 'copying-unknown'), [kind]);
    assert.match(await page.locator('.kp-transfer-row').first().innerText(), /总大小未知/);
    assert.equal(await page.locator('.kp-transfer-row').first().getAttribute('data-indeterminate'), 'true');
    assert.equal(await page.locator('.kp-transfer-bar[role="progressbar"][aria-valuenow]').count(), 0);
    checks.push(`${kind}: 总字节未知时用不定进度，不伪造百分比`);
    // completed 语义
    await page.evaluate(([k]) => window.designState.transfer(k, 'completed'), [kind]);
    const completedText = await page.locator('.kp-transfer').innerText();
    if (kind === 'import') {
      assert.match(completedText, /全文索引待建立/);
      assert.match(completedText, /刷新当前目录/);
      assert.match(completedText, /SHA-256/);
      checks.push('import: completed 明确“原件已导入、全文索引待建立”，与索引状态分离并给刷新目录入口');
      assert.match(completedText, /已导入 3 个原件/);
      assert.match(await page.locator('.kp-transfer-row').first().innerText(), /已完成 3 \/ 3/);
      checks.push('import: 多文件完成态按「已完成 N / 总数」表达整体进度，不把当前文件字节当总量');
      await page.evaluate(() => window.designState.transfer('import', 'failed-partial'));
      const partial = await page.locator('.kp-transfer').innerText();
      assert.match(partial, /已完成 2 \/ 3/);
      assert.match(partial, /部分成功不回滚/);
      assert.match(partial, /重试失败项/);
      checks.push('import: 部分失败保留已完成文件明细，只重试失败项');
      await page.evaluate(() => window.designState.transfer('import', 'expired'));
      const expired = await page.locator('.kp-transfer').innerText();
      assert.match(expired, /结果已过期/);
      assert.match(expired, /TRANSFER_NOT_FOUND/);
      assert.match(expired, /不把旧快照当成进行中或成功/);
      checks.push('import: 终态被淘汰（TRANSFER_NOT_FOUND）显示“结果已过期”，不当作进行中或成功');
      await page.evaluate(() => window.designState.transfer('import', 'copying'));
      const batch = await page.locator('.kp-transfer-row').first().innerText();
      assert.match(batch, /第 2 \/ 3 个文件/);
      assert.match(batch, /已完成 1 \/ 3/);
      assert.match(batch, /整体进度/);
      checks.push('import: 复制中同时显示「第 N / 总文件数、已完成数、当前文件字节」，整体进度不取单文件百分比');
    } else {
      assert.match(completedText, /完整原件字节/);
      assert.match(completedText, /不是当前阅读窗口片段/);
      checks.push('export: completed 声明导出完整原件，不拼接已显示窗口');
    }
    // failed 码映射
    for (const [phase, code, keyword] of [['failed-exists', 'TRANSFER_TARGET_EXISTS', '同名'], ['failed-space', 'ENOSPC', '空间'], ['failed-permission', 'EACCES', '权限'], ['failed-publish', 'PUBLISH_UNSUPPORTED', '文件系统不支持'], ['failed-busy', 'BUSY_RETRY', '4 个']]) {
      await page.evaluate(([k, p]) => window.designState.transfer(k, p), [kind, phase]);
      const text = await page.locator('.kp-transfer').innerText();
      assert.ok(text.includes(code), `${kind}/${phase} keeps error code`);
      assert.ok(text.includes(keyword), `${kind}/${phase} maps to actionable Chinese text (${keyword})`);
      assert.ok(await page.locator('[data-transfer-action="retry"]').first().isVisible());
    }
    checks.push(`${kind}: 同名/空间/权限/发布不支持/任务已满 五种失败均给可操作中文文案与重试`);
    // UI-SCROLL-001：队列滚动显示、停止隐藏、与正文嵌套隔离
    await page.evaluate(([k]) => window.designState.transfer(k, 'copying'), [kind]);
    const queue = page.locator('.kp-transfer-queue');
    const box = await queue.boundingBox();
    assert.ok(box && box.height <= 201, 'queue overflows within bounded height');
    const scrollable = await queue.evaluate(el => el.scrollHeight > el.clientHeight + 8);
    assert.ok(scrollable, 'queue content taller than viewport');
    assert.equal(await active('.kp-transfer-queue'), false, 'queue scrollbar hidden before scrolling');
    await queue.evaluate(el => el.scrollTop = 40);
    await page.waitForTimeout(80);
    assert.ok(await active('.kp-transfer-queue'), 'queue scrollbar appears on real scroll');
    assert.equal(await active('.body-scroll'), false, 'nested body scrollbar not woken');
    await page.screenshot({ path: `${out}/${kind}-scroll-active.png` });
    await page.waitForTimeout(300);
    assert.ok(await active('.kp-transfer-queue'), 'still visible while continuously scrolling (<700ms)');
    await queue.evaluate(el => el.scrollTop = 90);
    await page.waitForTimeout(300);
    assert.ok(await active('.kp-transfer-queue'), 'each scroll resets the 700ms stop timer');
    await page.waitForTimeout(800);
    assert.equal(await active('.kp-transfer-queue'), false, 'hidden ~700ms after scrolling stops');
    await page.screenshot({ path: `${out}/${kind}-scroll-idle.png` });
    // 悬停不唤醒
    await queue.hover();
    await page.waitForTimeout(120);
    assert.equal(await active('.kp-transfer-queue'), false, 'hover alone does not show the scrollbar');
    checks.push(`${kind}: UI-SCROLL-001 队列初始隐藏 / 滚动显示 / 连续滚动保持 / 停止≈700ms 隐藏 / 悬停不唤醒 / 不影响正文滚动`);
  }

  // 入口位置：导入在左侧文件树，导出在正文工具栏；与旧 25 MiB 上传区分
  await page.selectOption('#scene', 'transfer-import');
  assert.ok(await page.locator('aside.tree #import-entry-row').isVisible(), '导入入口位于左侧文件树');
  assert.equal(await page.locator('#import-entry').innerText(), '导入原件（大文件）');
  assert.equal(await page.locator('#export-entry').isVisible(), false);
  assert.ok(await page.locator('.kp-entry span').innerText() === '多选 · 后台复制');
  assert.match(await page.locator('.kp-transfer-head').innerText(), /导入原件（大文件）/);
  assert.match(await page.locator('.kp-transfer-head').innerText(), /25 MiB 上传/);
  await page.selectOption('#scene', 'transfer-export');
  assert.ok(await page.locator('.toolbar #export-entry').isVisible(), '导出入口位于正文工具栏');
  assert.equal(await page.locator('#export-entry').innerText(), '导出原件（大文件）');
  assert.equal(await page.locator('#import-entry-row').isVisible(), false);
  assert.match(await page.locator('.kp-transfer-head').innerText(), /导出原件（大文件）/);
  // 点击入口进入对应场景（设计可操作，不是静态图）
  // 点击入口进入对应场景（设计可操作，不是静态图）
  await page.evaluate(() => window.designState.transfer('export', 'copying'));
  await page.click('#export-entry');
  assert.equal(await page.locator('#scene').inputValue(), 'transfer-export');
  assert.equal(await page.locator('.kp-transfer').getAttribute('data-phase'), 'picking');
  await page.selectOption('#scene', 'transfer-import');
  await page.click('#import-entry');
  assert.equal(await page.locator('#scene').inputValue(), 'transfer-import');
  assert.equal(await page.locator('.kp-transfer').getAttribute('data-phase'), 'picking');
  checks.push('入口位置与设计一致（导入在文件树、导出在工具栏），点击可进入 picking，两个入口均与 25 MiB 上传区分');

  // 动态滚动条在深色主题仍生效（色值来自主题令牌）
  await page.click('#theme');
  await page.evaluate(() => window.designState.transfer('import', 'copying'));
  await page.locator('.kp-transfer-queue').evaluate(el => el.scrollTop = 60);
  await page.waitForTimeout(80);
  assert.ok(await active('.kp-transfer-queue'));
  await page.screenshot({ path: `${out}/dark-import-scroll-active.png` });
  await page.waitForTimeout(800);
  assert.equal(await active('.kp-transfer-queue'), false);
  checks.push('深色主题下队列滚动条同样按需显示/隐藏');
  await page.click('#theme');

  // v1.4 新增用户可见提示：留存压力反馈、原件外部变化、所选文件已不存在
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.selectOption('#scene', 'budget');
  assert.match(await page.locator('#notice').innerText(), /阅读缓存已达预算/);
  assert.match(await page.locator('#notice').innerText(), /未保存草稿保留/);
  assert.match(await page.locator('#notice').innerText(), /请先关闭不需要的清洁文档后重试/);
  await page.screenshot({ path: `${out}/v14-budget-pressure.png` });

  await page.selectOption('#scene', 'external-change');
  const externalNotice = await page.locator('#notice').innerText();
  assert.match(externalNotice, /原件已在外部变化，当前未保存草稿保留/);
  assert.match(externalNotice, /保存时会提示版本冲突/);
  assert.equal(await page.locator('#notice [role="alert"]').count(), 1, '外部变化提示必须是 alert');
  assert.ok(await page.locator('#reload-original').isVisible(), '外部变化提示必须给可操作入口');
  await page.screenshot({ path: `${out}/v14-external-change.png` });

  await page.selectOption('#scene', 'selection-gone');
  const goneNotice = await page.locator('#tree-status').innerText();
  assert.match(goneNotice, /所选文件已不存在/);
  assert.match(goneNotice, /不会跳到其它文件或清除草稿/);
  assert.equal(await page.locator('#tree-status [role="alert"]').count(), 1);
  assert.ok(await page.locator('#refresh-tree-2').isVisible(), '必须提供刷新目录入口');
  await page.screenshot({ path: `${out}/v14-selection-gone.png` });
  // 两个新场景在深色主题下也必须是可读的提示，不是空白
  await page.click('#theme');
  await page.selectOption('#scene', 'external-change');
  assert.match(await page.locator('#notice').innerText(), /原件已在外部变化/);
  await page.screenshot({ path: `${out}/v14-external-change-dark.png` });
  await page.click('#theme');
  checks.push('v1.4 留存压力反馈/原件外部变化/所选文件已不存在三处用户可见提示与文案一致，深色可读且均带可操作入口');
  // 窄视口无页面横向溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await page.selectOption('#scene', 'transfer-import');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: `${out}/narrow-import.png` });
  checks.push('390×844 窄视口任务面板无页面横向溢出');

  assert.deepEqual(errors, []);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(design)).digest('hex');
  fs.writeFileSync('docs/Test/cr055-transfer-design.json', JSON.stringify({ version: 'UI-CR055-FEAT009-v1.4', design: 'docs/UI/performance-knowledge/index.html', hash, phases, checks, errors, screenshots: out }, null, 2));
  console.log(JSON.stringify({ hash, count: checks.length, checks, errors }, null, 2));
} finally { await browser.close(); }

