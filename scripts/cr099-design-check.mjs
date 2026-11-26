/* CR-099 设计稿验证：在唯一原型入口上核对 11 项 AC 的可视与可操作结果。
   只读设计资源，不改正式软件。截图输出到 docs/Test/screenshots/cr099-design/。 */
import { chromium } from 'file:///C:/Users/gaohu/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const OUT = 'docs/Test/screenshots/cr099-design';
fs.mkdirSync(OUT, { recursive: true });
const ROOT = 'docs/UI/workbench-v4';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const checks = [];
page.on('pageerror', e => errors.push(e.message));

const entry = pathToFileURL(path.resolve(ROOT + '/index.html')).href;
const go = async settings => {
  await page.goto(`${entry}?settings=${settings}`);
  await page.waitForSelector('.settings-dialog', { timeout: 8000 });
  await page.waitForTimeout(350);
};
const shot = async name => { await page.screenshot({ path: `${OUT}/${name}.png` }); };

try {
  /* ---------- 1. 左栏收敛为 5 项，能力管理四 tab ---------- */
  await go('general');
  const navLabels = await page.locator('.settings-dialog .set-nav-list .s-item').allInnerTexts();
  assert.deepEqual(navLabels.map(t => t.trim()), ['通用', '模型管理', '模型检测', 'SDK 与 CLI', '能力管理']);
  checks.push('AC-11a 左栏 5 项');
  await shot('01-nav-five');

  /* ---------- 2. 通用：粘附条不穿模（滚动中段正文不出现在条上方） ---------- */
  const scrollBox = page.locator('.settings-dialog .set-scroll');
  const barBox = await page.locator('.c91-bar').boundingBox();
  await scrollBox.evaluate(el => { el.scrollTop = 520; });
  await page.waitForTimeout(240);
  const barAfter = await page.locator('.c91-bar').boundingBox();
  assert.ok(Math.abs(barBox.y - barAfter.y) < 1.5, `粘附条位置随滚动变化：${barBox.y} → ${barAfter.y}`);
  // 粘附条下缘以上不应出现分组内容：取条底边以上 1px 处做命中测试。
  const leak = await page.evaluate(() => {
    const bar = document.querySelector('.c91-bar');
    const rect = bar.getBoundingClientRect();
    const probeY = Math.round(rect.top) - 2;
    if (probeY < 0) return null;
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), probeY);
    return hit ? (hit.closest('.c91-group, .c91-row') ? hit.className : null) : null;
  });
  assert.equal(leak, null, `粘附条上方出现正文内容：${leak}`);
  checks.push('AC-01 粘附条不被滚动内容穿透');
  await shot('02-general-scrolled');

  /* ---------- 3. 通用：模拟客户端身份开关 + 二选一 ---------- */
  const idRow = page.locator('.c95-identity');
  await idRow.scrollIntoViewIfNeeded();
  const toggle = page.locator('[data-c95="identity-toggle"]');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  const presetDisabled = await page.locator('[data-c95="identity-preset"]').first().isDisabled();
  assert.equal(presetDisabled, true, '关闭时身份应禁用');
  await toggle.click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-c95="identity-toggle"]').getAttribute('aria-checked'), 'true');
  const checked = await page.locator('[data-c95="identity-preset"][aria-checked="true"]').innerText();
  assert.match(checked.trim(), /Codex/);
  await page.locator('[data-c95="identity-preset"][data-v="claude"]').click();
  await page.waitForTimeout(200);
  assert.match((await page.locator('[data-c95="identity-preset"][aria-checked="true"]').innerText()).trim(), /Claude/);
  const hint = await page.locator('.c95-identity-hint').innerText();
  assert.match(hint, /不改变凭证、账号与计费/);
  checks.push('AC-02 身份开关与二选一（含不伪造凭证说明）');
  await shot('03-identity');

  /* ---------- 4. 模型管理：入口位置、顺序、外观与既有保持一致 ---------- */
  await go('models');
  const headNew = await page.locator(".settings-dialog .set-head [data-act='provider-new']").count();
  assert.equal(headNew, 0, '头部仍存在新增供应商');

  const addBtn = page.locator('.c95-provider-actions [data-act="provider-new"]');
  assert.equal(await addBtn.count(), 1, '列表下方缺少新增供应商');
  const addBox = await addBtn.boundingBox();
  const lastCard = await page.locator('.settings-dialog .provider-sort-list .provider-card').last().boundingBox();
  assert.ok(addBox.y > lastCard.y + lastCard.height - 1, '新增供应商未位于列表下方');

  // 必须沿用既有文字按钮 .text-add，而不是自造样式。
  assert.ok((await addBtn.getAttribute('class') || '').includes('text-add'), '新增供应商未复用既有文字按钮样式');
  const addCss = await addBtn.evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, font: cs.fontSize, color: cs.color };
  });
  assert.equal(addCss.bg, 'rgba(0, 0, 0, 0)', `新增供应商不应有底色：${addCss.bg}`);
  assert.equal(addCss.border, '0px', `新增供应商不应有边框：${addCss.border}`);
  checks.push('AC-03 新增供应商在列表下方、复用既有文字按钮外观');

  /* ---------- 4a. 新增只开草稿：不进列表、不计入数量 ---------- */
  const countBefore = (await page.locator('.c85-count').innerText()).trim();
  await addBtn.click();
  await page.waitForTimeout(420);
  // 草稿出现，但供应商数据与列表数量都没变。
  const draft = page.locator('[data-c99-draft]');
  assert.equal(await draft.count(), 1, '点击新增未出现草稿卡');
  assert.equal(await page.locator('.settings-dialog .provider-sort-list .provider-card').count(), 2, '草稿不应进入上方供应商列表');
  assert.equal((await page.locator('.c85-count').innerText()).trim(), countBefore, '草稿不应改变「N 个在用供应商」计数');
  const providerCount = await page.evaluate(() => (window.UI?.D?.settings?.providers || []).length);
  assert.equal(providerCount, 3, `草稿不应写入供应商数据：当前 ${providerCount}`);
  // 位置：草稿在「新增供应商」下方、停用折叠之后。
  const btnBox = await addBtn.boundingBox();
  const draftBox = await draft.first().boundingBox();
  assert.ok(draftBox.y > btnBox.y + btnBox.height - 1, '草稿卡未在新增按钮下方');
  const foldForDraft = page.locator('[data-c95="toggle-disabled"]');
  if (await foldForDraft.count()) {
    assert.ok(draftBox.y > (await foldForDraft.boundingBox()).y, '草稿卡应在停用折叠之后');
  }
  checks.push('AC-04a 新增只开草稿，不写入数据、不改计数、不进列表');
  await shot('04a-models-draft');

  /* ---------- 4b. 草稿卡两个页签：供应商配置 + 模型配置 ---------- */
  const draftTabs = await draft.first().locator('.pm-tabs button').allInnerTexts();
  assert.deepEqual(draftTabs.map(t => t.trim()), ['供应商配置', '模型配置'], `草稿页签不符：${draftTabs.join('/')}`);
  await draft.first().locator('[data-c95="draft-tab"][data-tab="models"]').click();
  await page.waitForTimeout(320);
  const modelsPanel = page.locator('#c99-draft-panel');
  assert.ok(await modelsPanel.count(), '模型配置面板缺失');
  assert.match(await modelsPanel.innerText(), /个模型/, '模型配置面板缺少模型计数');
  assert.equal(await modelsPanel.locator('[data-c95="draft-model-add"]').count(), 1, '缺少手动添加模型入口');
  assert.equal(await modelsPanel.locator('[data-c95="draft-need-save"]').count() >= 1, true, '缺少获取模型入口');
  await shot('04b-models-draft-modeltab');
  // 手动加一个模型，验证草稿可编辑模型
  await modelsPanel.locator('[data-c95="draft-model-add"]').click();
  await page.waitForTimeout(320);
  assert.match(await page.locator('#c99-draft-panel').innerText(), /1 个模型/, '草稿模型未加入');
  checks.push('AC-04c 草稿卡含供应商配置与模型配置两个页签');

  /* ---------- 4d. 填名称后保存，才出现在上方列表 ---------- */
  // 当前停在模型页签，切回供应商配置再填名称。
  await draft.first().locator('[data-c95="draft-tab"][data-tab="config"]').click();
  await page.waitForTimeout(320);
  await draft.first().locator('#c99-draft-name').fill('中转网关');
  await draft.first().locator('#c99-draft-id').fill('PRV-99');
  await page.waitForTimeout(200);
  await draft.first().locator('[data-c95="save-draft"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-c99-draft]').count(), 0, '保存后草稿应消失');
  const listNames = await page.locator('.settings-dialog .provider-sort-list .provider-card .pinfo b').allInnerTexts();
  assert.ok(listNames.includes('中转网关'), `保存后未进入上方列表：${listNames.join('/')}`);
  assert.match(await page.locator('.c85-count').innerText(), /3 个在用供应商/, '保存后计数未更新');
  // 草稿里手动加的模型要随保存一起落到数据里。
  const savedModels = await page.evaluate(() => {
    const p = (window.UI?.D?.settings?.providers || []).find(x => x.id === 'PRV-99');
    return p ? p.models.length : -1;
  });
  assert.equal(savedModels, 1, `草稿中的模型未随保存提交：${savedModels}`);
  checks.push('AC-04b 保存后才进入上方列表并更新计数，草稿模型一并提交');
  await shot('04d-models-saved');
  // 清理：删除刚保存的供应商，回到原始夹具
  await page.locator('.settings-dialog .provider-sort-list .provider-card').last().locator('[data-act="provider-delete"]').click();
  await page.waitForTimeout(400);

  /* ---------- 5. 顺序：在用列表 → 停用折叠 → 新增供应商 ---------- */
  const foldBtn = page.locator('[data-c95="toggle-disabled"]');
  assert.equal(await foldBtn.count(), 1, '缺少查看停用供应商入口');
  assert.match(await foldBtn.innerText(), /查看停用供应商（1）/);
  const foldBox = await foldBtn.boundingBox();
  assert.ok(foldBox.y > lastCard.y + lastCard.height - 1, '停用折叠未在在用列表下方');
  assert.ok(foldBox.y + foldBox.height < addBox.y + 1, '停用折叠应在新增供应商上方');
  assert.ok((await foldBtn.getAttribute('class') || '').includes('text-add'), '折叠按钮未复用既有文字按钮样式');
  checks.push('AC-05a 顺序为在用列表 → 停用折叠 → 新增供应商');

  /* ---------- 6. 停用卡沿用原样式与原开关 ---------- */
  assert.equal(await page.locator('.c95-disabled-list .provider-card').isVisible().catch(() => false), false, '停用列表默认应隐藏');
  await foldBtn.click();
  await page.waitForTimeout(240);
  const stopped = page.locator('.c95-disabled-list .provider-card');
  assert.equal(await stopped.count(), 1, '展开后未显示停用供应商');
  // 停用卡必须是原型原卡片：有遮罩开关、状态标签、删除按钮，且不是被重绘的简化卡。
  assert.equal(await stopped.first().locator('.switch').count(), 1, '停用卡缺少原开关');
  assert.equal(await stopped.first().locator('[data-act="provider-delete"]').count(), 1, '停用卡缺少原删除入口');
  assert.equal(await stopped.first().locator('.status').count(), 1, '停用卡缺少原状态标签');
  assert.equal(await stopped.first().locator('.drag-handle').count(), 1, '停用卡缺少原拖动手柄');
  const stoppedCss = await stopped.first().locator('.provider-h').evaluate(el => {
    const cs = getComputedStyle(el);
    return { padding: cs.padding, gap: cs.gap };
  });
  const activeCss = await page.locator('.settings-dialog .provider-sort-list .provider-card .provider-h').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { padding: cs.padding, gap: cs.gap };
  });
  assert.deepEqual(stoppedCss, activeCss, `停用卡头部样式与在用卡不一致：${JSON.stringify(stoppedCss)} vs ${JSON.stringify(activeCss)}`);
  checks.push('AC-05b 停用卡沿用原卡片与原开关，样式未改');
  await shot('05-models-disabled-open');

  // 原开关可直接把停用供应商启用回列表。
  await stopped.first().locator('.switch').click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.settings-dialog .provider-sort-list .provider-card').count(), 3, '原开关未能把停用供应商启用回列表');
  assert.equal(await page.locator('[data-c95="toggle-disabled"]').count(), 0, '无停用项时不应再显示折叠入口');
  checks.push('AC-05c 停用态可直接用原开关启用');
  await shot('05c-models-re-enabled');
  // 复位，避免影响后续断言
  await page.locator('.settings-dialog .provider-sort-list .provider-card').last().locator('.switch').click();
  await page.waitForTimeout(320);

  /* ---------- 7. 端点输入框左缘对齐 ---------- */
  await page.locator('.settings-dialog .provider-sort-list .provider-card').first().locator('[data-act="provider-expand"]').first().click();
  await page.waitForTimeout(300);
  const inputs = page.locator('.c85-endpoint .input');
  const n = await inputs.count();
  assert.ok(n >= 2, `端点输入框数量不足：${n}`);
  const xs = [];
  for (let i = 0; i < n; i++) {
    const b = await inputs.nth(i).boundingBox();
    const visible = await inputs.nth(i).isVisible();
    if (visible) xs.push(Math.round(b.x));
  }
  assert.ok(new Set(xs).size === 1, `端点输入框左缘不一致：${xs.join(',')}`);
  checks.push('AC-06 端点输入框左缘对齐');
  await shot('06-endpoints-aligned');

  /* ---------- 8. 模型检测：无插入式提示、归因并入结果区 ---------- */
  await go('probe');
  await page.selectOption('#probe-provider', { index: 1 });
  await page.waitForTimeout(260);
  await page.selectOption('#probe-model', { index: 1 });
  await page.waitForTimeout(260);
  const beforeBox = await page.locator('.c85-result').boundingBox();
  const rowsBefore = await page.locator('.probe-rows').boundingBox();
  await page.locator('[data-act="probe-run"]').click();
  await page.waitForTimeout(700);
  const runningBox = await page.locator('.c85-result').boundingBox();
  assert.ok(Math.abs(beforeBox.y - runningBox.y) < 2, `点检测后结果区发生位移：${beforeBox.y} → ${runningBox.y}`);
  assert.equal(await page.locator('.probe-run-hint').count(), 0, '仍存在会插行的提示');
  checks.push('AC-07 检测中不插入提示、结果区不位移');
  await shot('07-probe-running');

  // 等检测完成（20 针 × 280ms + 380ms 启动）
  await page.waitForSelector('.c95-result-text', { timeout: 20000 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.probe-attr').count(), 0, '仍存在独立归因卡');
  const resultText = await page.locator('.c95-result-text').first().innerText();
  // 用户要求：「存在不通过项」整段移除，这里只展示归因到哪个模型。
  assert.ok(!/存在不通过项/.test(resultText), `不应再出现「存在不通过项」：${resultText}`);
  assert.ok(!/P\d+\s/.test(resultText), `不应逐条列出探针编号：${resultText}`);
  assert.match(resultText, /指纹归因/, `缺少归因结论：${resultText}`);
  const noteCss = await page.locator('.c95-result-text').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow };
  });
  assert.equal(noteCss.border, '0px', `归因不应有边框：${noteCss.border}`);
  assert.equal(noteCss.bg, 'rgba(0, 0, 0, 0)', `归因不应有底色：${noteCss.bg}`);
  assert.ok(noteCss.shadow === 'none', `归因不应有阴影：${noteCss.shadow}`);
  const resultContainsNote = await page.evaluate(() => !!document.querySelector('.c85-result .c95-result-text'));
  assert.equal(resultContainsNote, true, '归因未并入结果区');
  checks.push('AC-08 归因只讲指纹落到哪个模型，无「存在不通过项」、无独立框');

  // 历史回看同构：同样只显示归因
  await page.locator('[data-act="probe-history"]').click();
  await page.waitForTimeout(300);
  await page.locator('.probe-hist-item').first().click();
  await page.waitForTimeout(400);
  const histText = await page.locator('.c95-result-text').first().innerText();
  assert.ok(!/存在不通过项/.test(histText), `历史回看仍含「存在不通过项」：${histText}`);
  assert.match(histText, /指纹归因/, `历史回看缺少归因：${histText}`);
  assert.match(histText, /最像|不指认/, `历史回看未给出归因结论：${histText}`);
  checks.push('AC-08b 历史回看同样只展示归因');
  await shot('08b-probe-history-attribution');

  /* ---------- 9. 能力管理四 tab ---------- */
  await go('abilities');
  const tabs = await page.locator('.c95-ab-tabs button').allInnerTexts();
  assert.deepEqual(tabs.map(t => t.trim()), ['Skill', 'MCP', 'Tools', '搜索']);
  assert.equal(await page.locator('.settings-dialog .set-nav-list .s-item[aria-selected="true"]').innerText().then(t => t.trim()), '能力管理');
  checks.push('AC-11b 能力管理四 tab');
  await shot('09-abilities-skill');
  for (const [id, label] of [['mcp', 'MCP'], ['tools', 'Tools'], ['search', '搜索']]) {
    await page.locator(`[data-c95="ability-tab"][data-tab="${id}"]`).click();
    await page.waitForTimeout(260);
    assert.match((await page.locator('.c95-ab-tabs button[aria-selected="true"]').innerText()).trim(), new RegExp(label));
    await shot(`09-abilities-${id}`);
  }
  // 搜索页：后端切换显示 Tavily 字段
  await page.locator('[data-c95="search-backend"][data-v="tavily"]').click();
  await page.waitForTimeout(220);
  assert.equal(await page.locator('#c95-tavily-url').count(), 1);
  await shot('09-abilities-search-tavily');

  /* ---------- 10. CLI 权限挡位按 CLI 定义、无「未核验」 ---------- */
  await go('cli');
  const cards = page.locator('.s85-cli-card');
  const cardCount = await cards.count();
  assert.ok(cardCount >= 2, `CLI 卡数量不足：${cardCount}`);
  let checkedCli = 0;
  for (let i = 0; i < cardCount; i++) {
    const card = cards.nth(i);
    const cliId = await card.getAttribute('data-s85-cli');
    const expander = card.locator('[data-s85="cli-expand"]').first();
    if (await expander.isDisabled()) continue;
    await expander.click();
    await page.waitForTimeout(320);
    const select = card.locator('[data-s85="permission"]');
    if (await select.count() === 0) continue;
    const opts = (await select.locator('option').allInnerTexts()).map(t => t.trim());
    assert.ok(!opts.some(t => /未核验/.test(t)), `${cliId} 权限仍含未核验项：${opts.join('/')}`);
    const expected = { claude: 5, codex: 5, grok: 3 }[cliId];
    if (expected) assert.equal(opts.length, expected, `${cliId} 权限档位数不符：${opts.length}`);
    // 说明文字只出现一条，不重复
    assert.equal(await card.locator('.c95-perm-desc').count(), 1, `${cliId} 权限说明重复或缺失`);
    checkedCli++;
    // 展开模型下拉，检查为空时是否给出原因（AC-09）
    const routeBar = card.locator('[data-s85="route-toggle"]');
    if (await routeBar.count()) {
      await routeBar.first().click();
      await page.waitForTimeout(260);
      const modelSel = card.locator('.s85-model-grid select').first();
      if (await modelSel.count()) {
        const values = await modelSel.locator('option').evaluateAll(os => os.filter(o => o.value).length);
        const noteCount = await card.locator('.c95-model-empty').count();
        if (values === 0) assert.equal(noteCount, 1, `${cliId} 模型为空但未给原因`);
        else assert.equal(noteCount, 0, `${cliId} 有候选时不应显示空态原因`);
      }
    }
    await shot(`10-cli-${cliId}`);
  }
  assert.ok(checkedCli >= 2, '至少应检查两个 CLI');
  checks.push('AC-09/AC-10 权限按 CLI 定义且无未核验、模型空态有原因');

  /* ---------- 11. 深色与窄屏 ---------- */
  await go('abilities');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(260);
  await shot('11-abilities-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(320);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, '窄屏出现横向溢出');
  // 窄屏左栏横排后，每个按钮的文字框不得超过自身外框（防重叠）。
  const overlap = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.settings-dialog .s-item')];
    return items.map(el => {
      const r = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      return t.right > r.right + 0.5 || t.left < r.left - 0.5 ? { label: el.textContent.trim(), box: r.width, text: t.width } : null;
    }).filter(Boolean);
  });
  assert.deepEqual(overlap, [], `窄屏左栏文字溢出：${JSON.stringify(overlap)}`);
  checks.push('AC-12b 窄屏左栏无文字重叠');
  checks.push('AC-12a 深色与窄屏无横向溢出');
  await shot('12-abilities-narrow');

  assert.deepEqual(errors, [], `页面异常：${errors.join(' | ')}`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(ROOT + '/cr099.js')).digest('hex');
  const cssHash = crypto.createHash('sha256').update(fs.readFileSync(ROOT + '/cr099.css')).digest('hex');
  fs.writeFileSync('docs/Test/cr099-design.json', JSON.stringify({ version: 'UI-CR099-v1', hash, cssHash, checks, errors, screenshots: OUT }, null, 2));
  console.log(JSON.stringify({ version: 'UI-CR099-v1', hash, cssHash, checks, errors, screenshots: OUT }, null, 2));
} finally {
  await browser.close();
}
