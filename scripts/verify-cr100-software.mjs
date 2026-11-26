/**
 * CR-100 软件侧验证：AI 侧栏按实际容器宽度适配（隔离预览 ?preview=design，内存夹具）。
 * 前置：`npx vite --port 1420 --strictPort`
 * 用法：node scripts/verify-cr100-software.mjs
 * 输出：docs/Test/screenshots/cr100-software/*.png + docs/Test/cr100-software-baseline.json
 * 说明：截图是软件实现证据，不是设计稿；设计侧见 scripts/cr100-design-check.mjs。
 * 边界：隔离预览渲染真实 React 组件与真实 CSS；真实 Tauri WebView 未在本脚本覆盖。
 */
import { writeFile, mkdir, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 本机 vite 只监听 IPv6 的 localhost（127.0.0.1 会 ERR_CONNECTION_REFUSED），故默认用 localhost。
const APP = process.env.CR100_APP || 'http://localhost:1420/?preview=design';
const OUT = resolve('docs/Test/screenshots/cr100-software');
const JSON_OUT = resolve('docs/Test/cr100-software-baseline.json');
await mkdir(OUT, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), 'cr100-sw-'));
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
  const viewport = (width, height, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const clickText = text => js(`(() => {
    const el = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],.nav-item,article')]
      .filter(e => e.getClientRects().length)
      .find(e => ((e.getAttribute('aria-label') || '') === ${JSON.stringify(text)}) || ((e.textContent || '').trim() === ${JSON.stringify(text)}) || ((e.textContent || '').includes(${JSON.stringify(text)}) && (e.textContent || '').length < 40));
    if (!el) return false; el.click(); return true;
  })()`);
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shot = async (name, sel) => {
    await frame();
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
    await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    return name;
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  // 关键：宽窗口 + 窄侧栏，而不是手机视口
  await viewport(1680, 1000);
  await cdp('Page.navigate', { url: APP });
  await wait('document.readyState === "complete"', 'document');
  await delay(2500);

  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

  await clickText('项目管理'); await delay(1200);
  const projectOpened = await js(`(() => {
    const card = document.querySelector('article.proj-card, .proj-card, [data-project-card]');
    if (card) { card.click(); return 'card'; }
    const btn = [...document.querySelectorAll('button,.btn')].find(b => /打开|进入/.test(b.textContent || ''));
    if (btn) { btn.click(); return 'button'; }
    return 'none';
  })()`);
  check('打开项目', projectOpened !== 'none', String(projectOpened));
  await delay(2000);
  // 项目默认进入工作台布局（会话嵌在工作台内），本用例验证的是独立 AI 侧栏，
  // 因此切到非工作台页签，让 side 栏按真实 usePaneWidth 宽度渲染。
  await js(`(() => {
    const tab = [...document.querySelectorAll('[role=tab],button')]
      .filter(e => e.getClientRects().length)
      .find(e => (e.textContent || '').trim() === '需求');
    if (tab) tab.click();
  })()`);
  await delay(1500);
  await wait(`!!document.querySelector('.chat-panel')`, 'chat panel');
  const sidebarHost = () => js(`(() => {
    const host = document.querySelector('aside.nc-chat-host');
    return host ? { hidden: host.hasAttribute('hidden'), width: Math.round(host.getBoundingClientRect().width) } : null;
  })()`);
  const hostState = await sidebarHost();
  check('侧栏容器已展开', !!hostState && !hostState.hidden && hostState.width > 300, JSON.stringify(hostState));

  // 软件侧栏宽度由 pane 内联样式与 --pane-width 控制；用例直接设宽度并同步变量，
  // 与真实拖拽最终生效属性一致（width + --pane-width），便于固定条件取证。
  const setWidth = async width => {
    await js(`(() => {
      const panel = document.querySelector('.chat-panel');
      const host = panel.closest('aside');
      if (!panel) throw Error('missing chat-panel');
      if (host) {
        if (window.__cr100HostStyle === undefined) window.__cr100HostStyle = host.getAttribute('style') || '';
        host.style.setProperty('width', ${width} + 'px', 'important');
        host.style.setProperty('--pane-width', ${width} + 'px');
      }
      panel.style.setProperty('width', '100%', 'important');
      panel.style.setProperty('max-width', 'none', 'important');
    })()`);
    await delay(300); await frame();
  };

  const probe = () => js(`(() => {
    const panel = document.querySelector('.chat-panel');
    const pr = panel.getBoundingClientRect();
    const hat = panel.querySelector('.chat-hat');
    const seg = panel.querySelector('.chat-hat-seg');
    const branch = panel.querySelector('.chat-hat-branch');
    const wt = panel.querySelector('.chat-hat-worktree');
    const msgs = panel.querySelector('.chat-msgs');
    const composer = panel.querySelector('.chat-composer');
    const nav = panel.querySelector('.chat-turn-nav');
    const rect = el => el ? el.getBoundingClientRect() : null;
    const inside = (r, p) => !!r && r.left >= p.left - 0.5 && r.right <= p.right + 0.5;
    const cs = getComputedStyle(panel);
    const hr = rect(hat), cr = rect(composer);
    return {
      panelWidth: Math.round(pr.width),
      containerType: cs.containerType,
      containerName: cs.containerName,
      hatInside: inside(hr, pr),
      hatOverflowPx: hr ? Math.round(hr.right - pr.right) : null,
      segVisible: !!seg && seg.getClientRects().length > 0 && inside(rect(seg), pr),
      branchVisible: !!branch && branch.getClientRects().length > 0,
      branchFits: branch ? inside(rect(branch), pr) : null,
      worktreeVisible: !!wt && wt.getClientRects().length > 0 && inside(rect(wt), pr),
      composerInside: inside(cr, pr),
      msgsOverflowX: msgs ? msgs.scrollWidth - msgs.clientWidth : null,
      panelOverflowX: panel.scrollWidth - panel.clientWidth,
      navWidth: nav ? Math.round(rect(nav).width) : null,
      msgPaddingLeft: msgs ? getComputedStyle(msgs).paddingLeft : null,
    };
  })()`);

  const widths = [320, 372, 480, 620];
  const results = {};
  for (const width of widths) {
    await setWidth(width);
    results[width] = await probe();
    await shot(`width-${width}`, '.chat-panel');
  }
  // 默认宽度对照：恢复宿主原始内联宽度（React 由 layout.effective 写入，删掉会塌陷到 1px）。
  await js(`(() => {
    const host = document.querySelector('.chat-panel')?.closest('aside');
    if (!host) return;
    if (!window.__cr100HostStyle) window.__cr100HostStyle = host.getAttribute('style') || '';
    host.setAttribute('style', window.__cr100HostStyle);
    const p = document.querySelector('.chat-panel');
    p.style.removeProperty('width'); p.style.removeProperty('max-width');
  })()`);
  await delay(300); await frame();
  results.default = await probe();
  await shot('width-default', '.chat-panel');

  for (const width of widths) {
    const r = results[width];
    check(`${width}:面板宽度生效`, Math.abs(r.panelWidth - width) <= 2, r.panelWidth);
    check(`${width}:容器查询生效`, r.containerType === 'inline-size', r.containerType);
    check(`${width}:运行栏不越界`, r.hatInside, r.hatOverflowPx);
    check(`${width}:CLI/助理切换可见`, r.segVisible, r.segVisible);
    check(`${width}:worktree 可见`, r.worktreeVisible, r.worktreeVisible);
    check(`${width}:分支 chip 不越界`, r.branchFits !== false, r.branchFits);
    check(`${width}:输入卡不越界`, r.composerInside, r.composerInside);
    check(`${width}:消息区无横向溢出`, r.msgsOverflowX <= 1, r.msgsOverflowX);
    check(`${width}:面板无横向溢出`, r.panelOverflowX <= 1, r.panelOverflowX);
  }
  // 窄档缩进确实生效（对比 620 与 320）
  check('320 比 620 缩进更小', parseFloat(results[320].msgPaddingLeft) < parseFloat(results[620].msgPaddingLeft), `${results[320].msgPaddingLeft} vs ${results[620].msgPaddingLeft}`);
  check('窄档轮次刻度收窄', results[320].navWidth === null || results[320].navWidth <= 40, results[320].navWidth);

  const failed = checks.filter(c => !c.ok);
  const report = { widths, results, checks, failed: failed.length, jsErrors: errors.length, errors };
  await writeFile(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed, jsErrors: errors.length }, null, 2));
  if (failed.length || errors.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
