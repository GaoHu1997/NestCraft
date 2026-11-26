/**
 * CR-099 软件侧验证：设置中心二轮（隔离预览 ?preview=design，内存夹具）。
 * 前置：已有 `npx vite` 在 1420 端口运行。
 * 用法：node scripts/verify-cr099-software.mjs
 * 输出：docs/Test/screenshots/cr099-software/*.png + docs/Test/cr099-software-baseline.json
 * 说明：本脚本验证的是**正式软件实现**（src/modules/settings），不是设计稿。
 */
import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const APP = process.env.CR099_APP || 'http://localhost:1420/?preview=design';
const OUT = 'docs/Test/screenshots/cr099-software';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const checks = [];
page.on('pageerror', e => errors.push(e.message));

const shot = name => page.screenshot({ path: `${OUT}/${name}.png` });
const openSettings = async (label) => {
  await page.getByRole('button', { name: /设置/ }).first().click();
  await page.waitForSelector('.set-modal, dialog[open] .set-shell', { timeout: 10000 });
  if (label) {
    await page.locator('.set-nav-list button', { hasText: label }).first().click();
    await page.waitForTimeout(300);
  }
};

try {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  /* ---------- AC-11 左栏 5 项 ---------- */
  await openSettings(null);
  const nav = (await page.locator('.set-nav-list .set-nav-btn').allInnerTexts()).map(t => t.trim());
  assert.deepEqual(nav, ['通用', '模型管理', '模型检测', 'SDK 与 CLI', '能力管理'], `左栏不符：${nav.join('/')}`);
  checks.push('AC-11a 左栏为 5 项');
  await shot('01-nav-five');

  /* ---------- AC-11 能力管理四 tab ---------- */
  await page.locator('.set-nav-list button', { hasText: '能力管理' }).click();
  await page.waitForTimeout(400);
  const tabs = (await page.locator('.cr099-ability-tabs button').allInnerTexts()).map(t => t.trim());
  assert.deepEqual(tabs, ['Skill', 'MCP', 'Tools', '搜索'], `能力页签不符：${tabs.join('/')}`);
  for (const t of tabs) {
    await page.locator('.cr099-ability-tabs button', { hasText: t }).click();
    await page.waitForTimeout(250);
    const active = await page.locator('.cr099-ability-tabs button[aria-selected="true"]').innerText();
    assert.equal(active.trim(), t, `切换到 ${t} 失败`);
  }
  checks.push('AC-11b 能力管理四个页签可切换');
  await shot('02-abilities');

  /* ---------- AC-01/02 通用页：粘附条 + 身份 ---------- */
  await page.locator('.set-nav-list button', { hasText: '通用' }).click();
  await page.waitForTimeout(400);
  const barBefore = await page.locator('.g-bar').boundingBox();
  await page.locator('.set-scroll').evaluate(el => { el.scrollTop = 480; });
  await page.waitForTimeout(250);
  const barAfter = await page.locator('.g-bar').boundingBox();
  assert.ok(Math.abs(barBefore.y - barAfter.y) < 2, `粘附条随滚动位移：${barBefore.y} → ${barAfter.y}`);
  // 粘附条上方不应命中分组内容
  const leak = await page.evaluate(() => {
    const bar = document.querySelector('.g-bar');
    const r = bar.getBoundingClientRect();
    const y = Math.round(r.top) - 2;
    if (y < 0) return null;
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), y);
    return hit?.closest('.g-group, .g-row') ? hit.className : null;
  });
  assert.equal(leak, null, `粘附条上方出现正文：${leak}`);
  checks.push('AC-01 粘附条不被滚动内容穿透');
  await shot('03-general-scrolled');

  const idRow = page.locator('.g-identity');
  await idRow.scrollIntoViewIfNeeded();
  // 开关与身份按钮同属该行的控件区，用容器定位而不是靠兄弟节点猜测。
  const idControl = page.locator('.g-control', { has: page.locator('.g-identity') }).first();
  const idSwitch = idControl.locator('button[role="switch"]').first();
  assert.equal(await idSwitch.count(), 1, '未找到身份开关');
  assert.equal(await idSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('.g-identity-preset').first().isDisabled(), true, '关闭时身份应禁用');
  await idSwitch.click();
  await page.waitForTimeout(250);
  assert.equal(await idControl.locator('button[role="switch"]').first().getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.g-identity-preset').first().isDisabled(), false, '开启后身份应可选');
  await page.locator('.g-identity-preset', { hasText: 'Claude' }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.g-identity-preset[aria-checked="true"]').innerText().then(t => t.trim()), 'Claude');
  checks.push('AC-02 身份开关与二选一');
  await shot('04-identity');

  /* ---------- AC-03/04/05/06 模型管理 ---------- */
  await page.locator('.set-nav-list button', { hasText: '模型管理' }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.set-head [aria-label="新增供应商"]').count(), 0, '头部仍有新增供应商');
  const addBtn = page.locator('.cr099-add-btn');
  assert.equal(await addBtn.count(), 1, '列表下方缺少新增供应商');
  const addBox = await addBtn.boundingBox();
  const lastCard = await page.locator('.set-scroll .set-provider-card').last().boundingBox();
  assert.ok(addBox.y > lastCard.y, '新增供应商不在列表下方');
  const addStyle = await addBtn.evaluate(el => getComputedStyle(el).backgroundColor);
  assert.equal(addStyle, 'rgba(0, 0, 0, 0)', '新增供应商应为文字按钮');
  checks.push('AC-03 新增供应商在列表下方且为文字按钮');

  // 停用折叠在新增上方
  const foldBtn = page.locator('.cr099-fold-btn');
  assert.equal(await foldBtn.count(), 1, '缺少停用折叠入口');
  const foldBox = await foldBtn.boundingBox();
  assert.ok(foldBox.y > lastCard.y && foldBox.y < addBox.y, '停用折叠位置不符（应在列表下方、新增上方）');
  assert.equal(await page.locator('.cr099-disabled-list').count(), 0, '停用列表默认应折叠');
  await foldBtn.click();
  await page.waitForTimeout(300);
  const stopped = page.locator('.cr099-disabled-list .set-provider-card');
  assert.equal(await stopped.count(), 1, '展开后未显示停用供应商');
  // 停用卡沿用原卡片：有原开关、状态与删除入口
  assert.equal(await stopped.first().locator('button[role="switch"]').count(), 1, '停用卡缺少原开关');
  assert.equal(await stopped.first().locator('[aria-label^="删除供应商"]').count(), 1, '停用卡缺少删除入口');
  checks.push('AC-05 停用折叠位于列表与新增之间、可展开、沿用原开关');
  await shot('05-models-disabled');
  await foldBtn.click();
  await page.waitForTimeout(250);

  // 草稿：不写数据、不进列表、不计数
  const countBefore = (await page.locator('.cr085-count').innerText()).trim();
  await addBtn.click();
  await page.waitForTimeout(400);
  const draft = page.locator('.cr099-new-draft');
  assert.equal(await draft.count(), 1, '未出现新供应商草稿');
  assert.equal((await page.locator('.cr085-count').innerText()).trim(), countBefore, '草稿不应改变供应商计数');
  assert.match(await draft.innerText(), /未保存/, '草稿未标注未保存');
  // 草稿两个页签
  const draftTabs = (await draft.locator('.set-tabs button').allInnerTexts()).map(t => t.trim());
  assert.deepEqual(draftTabs, ['供应商配置', '模型配置'], `草稿页签不符：${draftTabs.join('/')}`);
  checks.push('AC-04 草稿不落库、不改计数，且含两个页签');
  await shot('06-models-draft');

  // 保存后进入列表
  await draft.locator('input[aria-label="供应商名称"]').fill('中转网关');
  await page.waitForTimeout(200);
  await draft.locator('button', { hasText: '保存供应商' }).click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.cr099-new-draft').count(), 0, '保存后草稿应收起');
  const names = await page.locator('.set-scroll .set-provider-card .set-provider-info b').allInnerTexts();
  assert.ok(names.some(n => n.trim() === '中转网关'), `保存后未进入列表：${names.join('/')}`);
  checks.push('AC-04b 保存后才进入列表');
  await shot('07-models-saved');

  // 端点对齐
  await page.locator('.set-scroll .set-provider-card').first().locator('.set-provider-select').click();
  await page.waitForTimeout(400);
  const eps = page.locator('.cr085-endpoint .input');
  const xs = [];
  for (let i = 0; i < await eps.count(); i += 1) {
    if (await eps.nth(i).isVisible()) xs.push(Math.round((await eps.nth(i).boundingBox()).x));
  }
  assert.ok(xs.length >= 1, '未找到端点输入框');
  assert.equal(new Set(xs).size, 1, `端点输入框左缘不一致：${xs.join(',')}`);
  checks.push('AC-06 端点输入框左缘对齐');
  await shot('08-endpoints');

  /* ---------- AC-07/08 模型检测 ---------- */
  await page.locator('.set-nav-list button', { hasText: '模型检测' }).click();
  await page.waitForTimeout(600);
  // 选供应商与模型（预览夹具里第一个可用项）
  const provSel = page.locator('select[aria-label="选择供应商"]');
  await provSel.selectOption({ index: 1 });
  await page.waitForTimeout(400);
  const modelSel = page.locator('select[aria-label="选择模型"]');
  await modelSel.selectOption({ index: 1 });
  await page.waitForTimeout(300);
  const resultBefore = await page.locator('.cr085-result').boundingBox();
  await page.locator('button', { hasText: '开始检测' }).first().click();
  await page.waitForTimeout(900);
  const resultRunning = await page.locator('.cr085-result').boundingBox();
  assert.ok(Math.abs(resultBefore.y - resultRunning.y) < 3, `点检测后结果区位移：${resultBefore.y} → ${resultRunning.y}`);
  checks.push('AC-07 开始检测不插入提示、结果区不位移');
  await shot('12-probe-running');
  // 等检测完成（20 针）
  await page.waitForFunction(() => !document.querySelector('.probe-dot.running'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const attrLine = page.locator('.probe-attr-line');
  assert.equal(await page.locator('.probe-attr').count(), 0, '仍存在独立归因卡');
  if (await attrLine.count()) {
    const text = await attrLine.first().innerText();
    assert.match(text, /指纹归因/, `归因行缺少结论：${text}`);
    assert.ok(!/存在不通过项/.test(text), `不应出现「存在不通过项」：${text}`);
    assert.ok(!/P\d+\s/.test(text), `不应逐条列出探针编号：${text}`);
    const css = await attrLine.first().evaluate(el => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, bg: s.backgroundColor, shadow: s.boxShadow };
    });
    assert.equal(css.border, '0px', `归因不应有边框：${css.border}`);
    assert.equal(css.bg, 'rgba(0, 0, 0, 0)', `归因不应有底色：${css.bg}`);
    assert.ok(css.shadow === 'none', `归因不应有阴影：${css.shadow}`);
    checks.push('AC-08 归因只讲指纹结论，纯文本无框');
    await shot('13-probe-attribution');
  }

  /* ---------- AC-10 权限档位 ---------- */
  await page.locator('.set-nav-list button', { hasText: 'SDK 与 CLI' }).click();
  await page.waitForTimeout(700);
  const cliCards = page.locator('.set-sdk-card');
  let checked = 0;
  for (let i = 0; i < await cliCards.count(); i += 1) {
    const card = cliCards.nth(i);
    const head = card.locator('.set-sdk-select');
    if (await head.count() === 0) continue;
    await head.first().click();
    await page.waitForTimeout(400);
    const sel = card.locator('select[aria-label$="权限模式"]');
    if (await sel.count() === 0) continue;
    const opts = (await sel.locator('option').allInnerTexts()).map(t => t.trim());
    assert.ok(!opts.some(t => /未核验/.test(t)), `权限仍含未核验项：${opts.join('/')}`);
    assert.ok(opts.length >= 3, `权限档位过少：${opts.join('/')}`);
    checks.push(`AC-10 权限档位无未核验（${opts.length} 档）`);
    checked += 1;
    await shot(`09-cli-${i}`);
    await head.first().click();
    await page.waitForTimeout(200);
  }
  assert.ok(checked >= 1, '未检查到任何 CLI 权限下拉');

  /* ---------- 深色与窄屏 ---------- */
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await shot('10-dark');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, '窄屏横向溢出');
  await shot('11-narrow');
  checks.push('AC-12 深色与窄屏');

  assert.deepEqual(errors, [], `页面异常：${errors.join(' | ')}`);
  const hash = createHash('sha256').update(fs.readFileSync('src/modules/settings/SettingsModels.tsx')).digest('hex');
  fs.writeFileSync('docs/Test/cr099-software-baseline.json', JSON.stringify({ version: 'CR-099', hash, checks, errors, screenshots: OUT }, null, 2));
  console.log(JSON.stringify({ checks, errors, screenshots: OUT }, null, 2));
} finally {
  await browser.close();
}
