/**
 * BUG-006 验证：拖动侧栏分隔条时，把手命中区之外不得出现蓝色焦点框。
 *
 * 用法：
 *   node scripts/verify-bug006.mjs --target=software --phase=before
 *   node scripts/verify-bug006.mjs --target=design   --phase=before
 *   node scripts/verify-bug006.mjs --target=software --phase=after
 *   node scripts/verify-bug006.mjs --target=design   --phase=after
 *
 * 前置（software）：`npx vite --port 1420 --strictPort`，隔离预览 ?preview=design 渲染真实 React/CSS。
 * 前置（design）：直接以 file:// 打开唯一公开入口 docs/UI/仿真原型UI.html。
 *
 * 证据：docs/Test/screenshots/bug006-<target>-<phase>/*.png
 *       docs/Test/bug006-<target>-<phase>.json（机读断言与状态）
 * 判定：把 6px 命中区之外的「连续满高蓝色竖线」或「横向蓝色边」视为多画的轮廓/焦点环；
 *       相邻内容里的零散浅蓝像素不算。静态截图只作证据，动态显隐另按 UI-SCROLL-001 回归。
 * 边界：headless Chrome 的软件截图是实现证据，设计截图是预期基准；
 *       真实 Tauri WebView2 / 系统强调色未在本脚本覆盖。
 */
import { writeFile, mkdir, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const target = args.target === 'design' ? 'design' : 'software';
const phase = args.phase === 'after' ? 'after' : 'before';
const theme = args.theme === 'dark' ? 'dark' : 'light';
const suffix = theme === 'dark' ? '-dark' : '';
const APP = args.url || (target === 'design'
  ? pathToFileURL(resolve('docs/UI/仿真原型UI.html')).href
  : 'http://localhost:1420/?preview=design');
const OUT = resolve(`docs/Test/screenshots/bug006-${target}${suffix}-${phase}`);
const JSON_OUT = resolve(`docs/Test/bug006-${target}${suffix}-${phase}.json`);
await mkdir(OUT, { recursive: true });

/** 最小 PNG 解码（8bit RGB/RGBA，非隔行），用于客观统计蓝色轮廓像素。 */
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, colorType = 2;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
  }
  const bpp = colorType === 6 ? 4 : 3, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rows = [];
  let prev = Buffer.alloc(stride), o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++], cur = Buffer.from(raw.subarray(o, o + stride));
    o += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    rows.push(cur); prev = cur;
  }
  return { w, h, bpp, rows };
}

/** 饱和蓝（#2b6cf6 / #4170f0 及其抗锯齿边缘），排除相邻 UI 的浅蓝底。 */
const strongBlue = (R, G, B) => R <= 130 && G <= 185 && B >= 190 && B - R >= 70 && B - G >= 35;

/** 统计命中区外的蓝色轮廓：连续满高竖线（frameLines）或横向边（wideRows）。 */
function analyzeBlue(png, handleBox) {
  const { bpp, rows, w, h } = png;
  const colCount = new Array(w).fill(0);
  let total = 0, outside = 0;
  const wideRows = [];
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    let outsideInRow = 0;
    for (let x = 0; x < w; x++) {
      const R = r[x * bpp], G = r[x * bpp + 1], B = r[x * bpp + 2];
      if (!strongBlue(R, G, B)) continue;
      total++;
      if (x < handleBox.x0 - 1 || x > handleBox.x1 + 1) {
        outside++; outsideInRow++; colCount[x]++;
      }
    }
    if (outsideInRow >= 6) wideRows.push({ y, count: outsideInRow });
  }
  const frameLines = [];
  for (let x = 0; x < w; x++) {
    if (colCount[x] > h * 0.5 && (x < handleBox.x0 - 1 || x > handleBox.x1 + 1)) frameLines.push({ x, count: colCount[x] });
  }
  return { total, outside, frameLines, wideRows: wideRows.length, size: [w, h] };
}

const profile = await mkdtemp(join(tmpdir(), 'bug006-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1680,1000', 'about:blank',
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
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const SEL = '[data-bug006="1"]';

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: APP });
  await wait('document.readyState === "complete"', 'document');
  await delay(target === 'design' ? 1800 : 2800);

  // 设计原型默认首页即有可调侧栏；软件隔离预览需进入项目并切到非工作台页签，
  // 才能拿到按真实 usePaneWidth 渲染的独立 AI 侧栏（沿用 CR-100 的取证路径）。
  if (target === 'software') {
    await js(`(() => {
      const el = [...document.querySelectorAll('button,a,[role=tab],.nav-item')]
        .filter(e => e.getClientRects().length)
        .find(e => (e.textContent || '').includes('项目管理'));
      if (el) el.click();
    })()`);
    await delay(1200);
    await js(`(() => {
      const card = document.querySelector('article.proj-card, .proj-card, [data-project-card]');
      if (card) { card.click(); return; }
      const btn = [...document.querySelectorAll('button,.btn')].find(b => /打开|进入/.test(b.textContent || ''));
      if (btn) btn.click();
    })()`);
    await delay(1800);
    await js(`(() => {
      const tab = [...document.querySelectorAll('[role=tab],button')]
        .filter(e => e.getClientRects().length)
        .find(e => (e.textContent || '').trim() === '需求');
      if (tab) tab.click();
    })()`);
    await delay(1200);
  }

  // 深色主题与软件/原型一致：html[data-theme='dark']。在固定把手前设置，避免应用挂载时覆盖。
  if (theme === 'dark') {
    await js(`document.documentElement.dataset.theme = 'dark'`);
    await delay(150);
  }

  await wait(`[...document.querySelectorAll('.pane-handle')].some(e => e.getClientRects().length && e.getBoundingClientRect().height > 200)`, 'pane handle');

  // 固定标记同一个把手：避免多个 .pane-handle 同时存在时，样式与截图取自不同元素。
  const handle = await js(`(() => {
    const el = [...document.querySelectorAll('.pane-handle')]
      .filter(e => e.getClientRects().length && e.getBoundingClientRect().height > 200)
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    if (!el) return null;
    el.setAttribute('data-bug006', '1');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cls: el.className, side: el.classList.contains('right') ? 'right' : 'left' };
  })()`);
  if (!handle) throw Error('no visible .pane-handle');

  const PAD = 12;
  const clip = {
    x: Math.max(0, handle.x - PAD), y: Math.max(0, handle.y - PAD),
    width: handle.width + PAD * 2, height: Math.min(handle.height + PAD * 2, 1000 - Math.max(0, handle.y - PAD)),
    scale: 1,
  };
  const handleBox = { x0: handle.x - clip.x, x1: handle.x - clip.x + handle.width };

  const styleOf = () => js(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL)});
    if (!el) return null;
    const s = getComputedStyle(el), a = getComputedStyle(el, '::after');
    return {
      active: document.activeElement === el,
      activeCls: document.activeElement ? document.activeElement.className : null,
      focusVisible: el.matches(':focus-visible'),
      outline: [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset].join(' '),
      outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset,
      grip: a.backgroundColor,
      dragging: document.body.classList.contains('pane-dragging'),
      isResizing: el.classList.contains('is-resizing'),
    };
  })()`);

  const capture = async name => {
    await frame();
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip });
    const buf = Buffer.from(r.data, 'base64');
    await writeFile(join(OUT, name + '.png'), buf);
    return analyzeBlue(decodePNG(buf), handleBox);
  };

  const mouse = (type, x, y, buttons) => cdp('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: 1,
  });
  const key = (type, keyName, code, vk) => cdp('Input.dispatchKeyEvent', {
    type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });

  const states = [];
  const record = async (name, extra = {}) => {
    const style = await styleOf();
    const px = await capture(name);
    states.push({ name, style, pixels: px, ...extra });
  };

  // S0 静止：未交互。
  await record('S0-idle');

  // S1 键盘模态后聚焦把手：模拟用户先打字/Tab，再抓分隔条（BUG-006 的偶发条件）。
  await key('rawKeyDown', 'Tab', 'Tab', 9);
  await key('keyUp', 'Tab', 'Tab', 9);
  await js(`(() => { const el = document.querySelector(${JSON.stringify(SEL)}); if (el) el.focus({ preventScroll: true }); })()`);
  await delay(120);
  await record('S1-keyboard-focus');

  // S2 拖动中 / S3 拖动结束：真实 pointer 事件（CDP mouse 会合成 pointerdown/move/up）。
  const cx = handle.x + handle.width / 2, cy = handle.y + Math.min(60, handle.height / 2);
  const hit = await js(`(() => {
    const e = document.elementFromPoint(${cx}, ${cy});
    return e ? (e.tagName + '.' + (e.className || '')) : null;
  })()`);
  await mouse('mousePressed', cx, cy, 1);
  await mouse('mouseMoved', cx - 40, cy, 1);
  await delay(120);
  let fallback = false;
  if (!(await js(`document.body.classList.contains('pane-dragging')`))) {
    // file:// 原型下 CDP 合成指针可能未激活 pointer capture；用等价 PointerEvent 触发同一处理路径。
    fallback = true;
    await js(`(() => {
      const el = document.querySelector(${JSON.stringify(SEL)});
      if (!el) return;
      const orig = el.setPointerCapture;
      el.setPointerCapture = () => {};
      el.__bug006Restore = () => { el.setPointerCapture = orig; };
      const mk = (type, x, y, buttons) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
        button: 0, buttons, clientX: x, clientY: y,
      });
      el.dispatchEvent(mk('pointerdown', ${cx}, ${cy}, 1));
      el.dispatchEvent(mk('pointermove', ${cx - 40}, ${cy}, 1));
    })()`);
    await delay(120);
  }
  await record('S2-dragging', { hit, fallback });
  if (fallback) {
    await js(`(() => {
      const el = document.querySelector(${JSON.stringify(SEL)});
      if (!el) return;
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX: ${cx - 40}, clientY: ${cy} }));
      el.__bug006Restore?.();
    })()`);
  }
  await mouse('mouseReleased', cx - 40, cy, 0);
  await delay(180);
  await record('S3-after-drag');

  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const frameFree = s => s.pixels.frameLines.length === 0 && s.pixels.wideRows === 0;
  for (const s of states) {
    check(`${s.name} 把手外无蓝色轮廓线`, frameFree(s), JSON.stringify(s.pixels));
    check(`${s.name} outline 为 none`, s.style.outlineStyle === 'none' || s.style.outlineWidth === '0px', s.style.outline);
  }
  check('拖动中已激活 pane-dragging / is-resizing', states[2].style.dragging || states[2].style.isResizing, JSON.stringify(states[2].style));
  check('键盘聚焦仍可辨（grip 为主色）', /rgb\(/.test(states[1].style.grip) && states[1].style.grip !== 'rgba(0, 0, 0, 0)', states[1].style.grip);
  check('无 JS 异常', errors.length === 0, errors.join(' | '));

  const result = {
    issue: 'BUG-006', target, phase, theme, url: APP, time: new Date().toISOString(),
    viewport: [1680, 1000], handle, clip, handleBox,
    designVersion: 'UI-BUG006-v1',
    checks, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length,
    states, errors,
  };
  await writeFile(JSON_OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ target, phase, passed: result.passed, failed: result.failed, checks }, null, 2));
  if (result.failed) process.exitCode = 1;
} catch (err) {
  console.error('verify-bug006 failed:', err);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill();
}
