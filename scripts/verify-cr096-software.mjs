/**
 * CR-096 软件侧验证：AI 会话字号与聊天区视觉校正（隔离预览 ?preview=design，内存夹具）。
 * 前置：`npx vite --port 1420 --strictPort`
 * 用法：node scripts/verify-cr096-software.mjs
 * 输出：docs/Test/screenshots/cr096-software/*.png + docs/Test/cr096-software-baseline.json
 * 说明：截图是软件实现证据，不是设计稿；设计侧见 scripts/cr096-design-check.mjs。
 * 边界：隔离预览渲染真实 React 组件与真实 CSS；真实 Tauri WebView 与真实 CLI 会话未在本脚本覆盖。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const APP = process.env.CR096_APP || 'http://127.0.0.1:1420/?preview=design';
const OUT = resolve('docs/Test/screenshots/cr096-software');
const JSON_OUT = resolve('docs/Test/cr096-software-baseline.json');
await mkdir(OUT, { recursive: true });

const profile = await (async () => {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'cr096-sw-'));
})();
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

let ws, seq = 0; const pending = new Map(), errors = [];
try {
  let port;
  for (let i = 0; i < 120 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { await delay(200); }
  }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(x => x.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const cdp = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => j(Error(method + ' timeout')), 25000);
    pending.set(id, m => { clearTimeout(t); m.error ? j(Error(JSON.stringify(m.error))) : r(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expr, label) => {
    for (let i = 0; i < 150; i++) { if (await js(expr)) return true; await delay(100); }
    throw Error('timeout: ' + (label || expr));
  };
  const viewport = (width, height, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const clickText = text => js(`(() => {
    const el = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],.nav-item,article')]
      .filter(e => e.getClientRects().length)
      .find(e => ((e.getAttribute('aria-label') || '') === ${JSON.stringify(text)}) || ((e.textContent || '').trim() === ${JSON.stringify(text)}) || ((e.textContent || '').includes(${JSON.stringify(text)}) && (e.textContent || '').length < 40));
    if (!el) return false; el.click(); return true;
  })()`);
  const shot = async (name, sel) => {
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    let clip;
    if (sel) {
      clip = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 1 };
      })()`);
    }
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    await writeFile(join(OUT, name), Buffer.from(r.data, 'base64'));
    return name;
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await viewport(1440, 900);
  await cdp('Page.navigate', { url: APP });
  await wait('document.readyState === "complete"', 'document');
  await delay(2500);

  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const images = [];

  // 进入项目模块 → 打开一个项目（隔离夹具含合成会话）
  const opened = await clickText('项目管理');
  check('进入项目管理', opened);
  await delay(1200);
  const projectOpened = await js(`(() => {
    const card = document.querySelector('article.proj-card, .proj-card, [data-project-card]');
    if (card) { card.click(); return 'card'; }
    const btn = [...document.querySelectorAll('button,.btn')].find(b => /打开|进入/.test(b.textContent || ''));
    if (btn) { btn.click(); return 'button'; }
    return 'none';
  })()`);
  check('打开项目', projectOpened !== 'none', String(projectOpened));
  await delay(2000);

  // 打开 AI 会话（侧栏或工作台）
  await wait(`!!document.querySelector('.chat-panel') || !!document.querySelector('.pw-ai-toggle')`, 'chat panel host');
  const chatVisible = await js(`!!document.querySelector('.chat-msgs, .chat-panel')`);
  check('会话区已渲染', chatVisible);

  // R1：助手正文与用户气泡字号一致
  const r1 = await js(`(() => {
    const user = document.querySelector('.chat-msg.user .chat-bubble-user, .chat-bubble-user');
    const text = document.querySelector('.chat-msgs .chat-msg.assistant .chat-md');
    const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
    return { userPx: px(user), assistantPx: px(text), hasUser: !!user, hasAssistant: !!text };
  })()`);
  check('R1 正文与用户气泡同为 12.5px', r1.userPx === 12.5 && r1.assistantPx === 12.5 && r1.userPx === r1.assistantPx, JSON.stringify(r1));

  // R3：消息区背景与面板一致
  const r3 = await js(`(() => {
    const msgs = document.querySelector('.chat-msgs.chat-zcode-messages, .chat-msgs');
    const panel = msgs ? msgs.closest('.chat-panel') : null;
    const bg = el => el ? getComputedStyle(el).backgroundColor : null;
    // 设计意图：消息区不再定义独立底色，透明即继承面板；与面板同色也视为一致。
    const same = bg(msgs) === bg(panel) || bg(msgs) === 'rgba(0, 0, 0, 0)';
    return { msgsBg: bg(msgs), panelBg: bg(panel), same };
  })()`);
  check('R3 消息区背景与面板一致', r3.same, JSON.stringify(r3));

  // R4：帽子贴卡片顶、灰底、铺满
  const r4 = await js(`(() => {
    const card = document.querySelector('.chat-composer');
    const hat = document.querySelector('.chat-hat');
    if (!card || !hat) return { missing: true };
    const c = card.getBoundingClientRect(), h = hat.getBoundingClientRect();
    const cs = getComputedStyle(card);
    return {
      gapTop: Math.round(h.top - c.top), cardPaddingTop: cs.paddingTop, cardBorderTop: cs.borderTopWidth,
      radio: cs.borderRadius, hatBg: getComputedStyle(hat).backgroundColor, cardBg: cs.backgroundColor,
      widthRatio: Math.round((h.width / c.width) * 100), hatIsFirst: card.firstElementChild === hat,
    };
  })()`);
  check('R4 帽子贴顶（仅隔边框）且灰底', r4.gapTop === 1 && parseFloat(r4.cardPaddingTop) === 0 && r4.hatBg !== r4.cardBg && r4.widthRatio >= 98 && r4.hatIsFirst, JSON.stringify(r4));
  check('R4 卡片圆角 12px', parseFloat(r4.radio) === 12, String(r4.radio));

  // R2：轮次概览卡片——用真实指针移动触发（React onMouseEnter 由 mouseover 模拟，
  // 直接 dispatch mouseenter 不会触发，会得到 fixed 元素默认 (0,0) 的假通过结果）。
  const tickRect = await js(`(() => {
    const item = document.querySelector('.chat-turn-nav-item');
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check('R2 刻度条渲染', !!tickRect, JSON.stringify(tickRect));
  if (tickRect) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tickRect.x, y: tickRect.y, button: 'none' });
    await delay(250);
  }
  const r2 = await js(`(() => {
    const nav = document.querySelector('.chat-turn-nav');
    const item = nav ? nav.querySelector('.chat-turn-nav-item') : null;
    const label = item ? item.querySelector('.chat-turn-nav-label') : null;
    if (!item || !label) return { nav: !!nav, label: false };
    const cs = getComputedStyle(label);
    const b = label.getBoundingClientRect();
    const t = item.getBoundingClientRect();
    return {
      items: nav.querySelectorAll('.chat-turn-nav-item').length,
      fontPx: parseFloat(cs.fontSize), maxWidth: cs.maxWidth, position: cs.position,
      visible: cs.visibility === 'visible' && parseFloat(cs.opacity) > 0,
      idx: label.querySelector('.chat-turn-nav-idx')?.textContent ?? null,
      summary: label.querySelector('.chat-turn-nav-summary')?.textContent ?? null,
      w: Math.round(b.width), h: Math.round(b.height),
      left: Math.round(b.left), top: Math.round(b.top),
      inViewport: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0 && b.bottom <= window.innerHeight,
      clearOfTick: b.right <= t.left + 1,
      nearTick: Math.abs((b.top + b.height / 2) - (t.top + t.height / 2)) <= Math.max(t.height, 8),
    };
  })()`);
  check('R2 概览卡片真实悬停可见且 12px／两行', r2.visible === true && r2.fontPx === 12 && !!r2.idx && !!r2.summary && r2.w <= 232, JSON.stringify(r2));
  check('R2 卡片贴刻度左侧、垂直对齐且在视口内', r2.inViewport === true && r2.clearOfTick === true && r2.nearTick === true, JSON.stringify({ inViewport: r2.inViewport, clearOfTick: r2.clearOfTick, nearTick: r2.nearTick }));

  images.push(await shot('01-chat-default.png'));
  images.push(await shot('02-composer-hat.png', '.chat-composer-wrap'));
  // 浮框是 fixed 元素，按容器裁剪截不到：取刻度与卡片的并集区域，2x 便于核对文字。
  const navClip = await js(`(() => {
    const nav = document.querySelector('.chat-turn-nav');
    const label = document.querySelector('.chat-turn-nav-label');
    if (!nav || !label) return null;
    const a = nav.getBoundingClientRect(), b = label.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    const x = Math.max(0, Math.min(a.left, b.left) - 12), y = Math.max(0, Math.min(a.top, b.top) - 12);
    return { x, y, width: Math.max(a.right, b.right) - x + 12, height: Math.max(a.bottom, b.bottom) - y + 12, scale: 2 };
  })()`);
  if (navClip) {
    const png = await cdp('Page.captureScreenshot', { format: 'png', clip: navClip });
    await writeFile(join(OUT, '03-turnnav.png'), Buffer.from(png.data, 'base64'));
    images.push('03-turnnav.png');
  }
  // 移开指针，恢复常态再继续工作台检查。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' });
  await delay(150);

  // R5：工作台页签隐藏 AI 侧栏开关
  const switched = await js(`(() => {
    const tab = [...document.querySelectorAll('[role=tab],.pw-tab')].find(e => /工作台/.test(e.textContent || '') && e.getClientRects().length);
    if (!tab) return false; tab.click(); return true;
  })()`);
  await delay(1500);
  const r5 = await js(`(() => {
    const btn = document.querySelector('.pw-ai-toggle');
    return { switched: ${'true'}, present: !!btn, visible: btn ? btn.getClientRects().length > 0 : false, onWorkbench: [...document.querySelectorAll('.pw-pane[role="tabpanel"]')].some(e => !e.hidden && e.getClientRects().length > 0) };
  })()`);
  check('R5 工作台页签不显示 AI 侧栏开关', r5.present === false || r5.visible === false, JSON.stringify(r5));
  images.push(await shot('04-workbench.png'));

  // AC-07：浮框/刻度容器不遮挡消息正文操作（容器放行指针，仅刻度接收）
  const ac07 = await js(`(() => {
    const nav = document.querySelector('.chat-turn-nav');
    if (!nav) return { missing: true };
    const cs = getComputedStyle(nav);
    const probe = document.elementFromPoint(nav.getBoundingClientRect().left + 20, nav.getBoundingClientRect().top + 10);
    return { navPointerEvents: cs.pointerEvents, hitTestInsideNav: probe ? probe.className && String(probe.className).slice(0, 40) : null, swallowed: !!probe && nav.contains(probe) && !probe.closest('.chat-turn-nav-item') };
  })()`);
  check('AC-07 刻度容器放行指针、不吞正文操作', ac07.navPointerEvents === 'none' && !ac07.swallowed, JSON.stringify(ac07));

  // AC-11：视觉调整不丢草稿与光标（悬停浮框、切主题后仍保持）
  const ac11 = await js(`(async () => {
    const ta = document.querySelector('textarea.chat-ta');
    if (!ta) return { missing: true };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '草稿保持检查 ABC');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(3, 3);
    const before = { value: ta.value, caret: ta.selectionStart };
    const nav = document.querySelector('.chat-turn-nav-item');
    if (nav) { const r = nav.getBoundingClientRect(); nav.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 })); }
    document.documentElement.setAttribute('data-theme', 'dark');
    await new Promise(r => setTimeout(r, 200));
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise(r => setTimeout(r, 150));
    const after = { value: ta.value, caret: ta.selectionStart, focused: document.activeElement === ta };
    return { before, after, kept: before.value === after.value && before.caret === after.caret && after.focused };
  })()`);
  check('AC-11 草稿、光标与聚焦保持', ac11.kept === true, JSON.stringify(ac11));

  // AC-09：工作台布局下重测 R1/R3/R4，确认与侧栏布局一致
  const wb = await js(`(() => {
    const sc = document.querySelector('.chat-msgs');
    const panel = sc ? sc.closest('.chat-panel') : null;
    const card = document.querySelector('.chat-composer');
    const hat = document.querySelector('.chat-hat');
    const bg = el => el ? getComputedStyle(el).backgroundColor : null;
    const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
    const c = card && hat ? card.getBoundingClientRect() : null;
    const h = card && hat ? hat.getBoundingClientRect() : null;
    return {
      workbenchActive: [...document.querySelectorAll('.pw-pane[role="tabpanel"]')].some(e => !e.hidden && e.getClientRects().length > 0) && !document.querySelector('.pw-ai-toggle'),
      userPx: px(document.querySelector('.chat-bubble-user')),
      assistantPx: px(sc && sc.querySelector('.chat-msg.assistant .chat-md')),
      bgOk: bg(sc) === bg(panel) || bg(sc) === 'rgba(0, 0, 0, 0)',
      hatGap: c && h ? Math.round(h.top - c.top) : null,
      radius: card ? getComputedStyle(card).borderRadius : null,
    };
  })()`);
  check('AC-09 工作台布局与侧栏一致（字号／背景／帽子／圆角）', wb.workbenchActive === true && wb.userPx === 12.5 && wb.assistantPx === 12.5 && wb.bgOk === true && wb.hatGap === 1 && parseFloat(wb.radius) === 12, JSON.stringify(wb));

  // AC-10：UI-SCROLL-001 动态证据——滚动显示、停止约 700ms 后隐藏
  // 先压矮视口，确保消息区真的溢出（无溢出时机制按设计不显示滑块，不能据此判失败）。
  await viewport(1440, 460);
  await delay(600);
  const ac10 = await js(`(async () => {
    const sc = document.querySelector('.chat-msgs');
    if (!sc) return { missing: true };
    const overflow = sc.scrollHeight > sc.clientHeight;
    const before = sc.classList.contains('scrollbar-active');
    sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 60);
    await new Promise(r => setTimeout(r, 150));
    const during = sc.classList.contains('scrollbar-active');
    await new Promise(r => setTimeout(r, 1100));
    const after = sc.classList.contains('scrollbar-active');
    return { overflow, before, during, after, pass: overflow && before === false && during === true && after === false };
  })()`);
  await viewport(1440, 900);
  await delay(400);
  check('AC-10 滚动条滚动显示、停止后隐藏', ac10.pass === true, JSON.stringify(ac10));

  // 暗色主题：字体一致、背景随主题、帽子贴顶、浮框可读
  const darkMode = await js(`(() => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    return root.getAttribute('data-theme');
  })()`);
  await delay(500);
  const dark = await js(`(() => {
    const msgs = document.querySelector('.chat-msgs');
    const panel = msgs ? msgs.closest('.chat-panel') : null;
    const card = document.querySelector('.chat-composer');
    const hat = document.querySelector('.chat-hat');
    const bgs = el => el ? getComputedStyle(el).backgroundColor : null;
    const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
    const c = card && hat ? Math.round(hat.getBoundingClientRect().top - card.getBoundingClientRect().top) : null;
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      msgsBg: bgs(msgs), panelBg: bgs(panel),
      inheritsOrSame: bgs(msgs) === bgs(panel) || bgs(msgs) === 'rgba(0, 0, 0, 0)',
      assistantPx: px(msgs && msgs.querySelector('.chat-msg.assistant .chat-md')),
      userPx: px(document.querySelector('.chat-bubble-user')),
      hatGap: c,
    };
  })()`);
  check('暗色 字体一致且背景随主题、帽子贴顶', dark.inheritsOrSame === true && dark.assistantPx === 12.5 && dark.userPx === 12.5 && dark.hatGap === 1, JSON.stringify(dark));
  images.push(await shot('05-dark.png', '.chat-composer-wrap'));
  // 还原主题
  await js(`(() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify(darkMode === 'dark' ? 'light' : 'dark')}); })()`);
  await delay(300);

  // 窄屏 390：刻度容器与浮框不越界
  await viewport(390, 844, true);
  await delay(700);
  const narrow = await js(`(() => {
    const nav = document.querySelector('.chat-turn-nav');
    if (!nav) return { missing: true };
    const r = nav.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), inViewport: r.left >= 0 && r.right <= window.innerWidth, vw: window.innerWidth };
  })()`);
  check('窄屏 390 刻度容器在视口内', narrow.inViewport === true, JSON.stringify(narrow));
  images.push(await shot('06-narrow.png'));
  await viewport(1440, 900);

  const payload = {
    app: APP, at: new Date().toISOString(), checks, images, errors,
    raw: { r1, r3, r4, r2, r5, ac07, ac10, ac11, wb, dark, narrow, workbenchSwitched: switched },
    passed: checks.filter(c => c.ok).length, total: checks.length,
  };
  await writeFile(JSON_OUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ passed: payload.passed, total: payload.total, checks: checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail && !c.ok ? ' :: ' + c.detail : ''}`), errors }, null, 2));
  if (payload.passed !== payload.total) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
