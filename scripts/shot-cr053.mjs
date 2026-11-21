/**
 * CR-053 软件截图（真实应用窗口，经 CDP）。
 * 前置：真实应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 启动（dev server）。
 * 运行：node scripts/shot-cr053.mjs
 * 输出：docs/Test/screenshots/cr053-sw/s01..s08
 * 注意：截图为真实 WebView2 窗口内容，非设计稿替代。
 */
import { mkdirSync, writeFileSync, mkdir, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "docs/Test/screenshots/cr053-sw";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
if (!page) throw new Error("未找到应用页面目标；请确认应用已带 9333 调试端口启动");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  // 滚动到命令工具分组使其完整可见；等待 850ms 让滚动条按 UI-SCROLL-001 停止后隐藏
  await js(`(() => {
    const scroller = document.querySelector('.set-scroll');
    const g = document.querySelector('.set-shell-group');
    if (scroller && g) scroller.scrollTop = Math.max(0, g.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 10);
  })()`);
  await sleep(850);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
  console.log("saved", name);
}

/** 派发真实点击（React 需要完整事件序列）。 */
async function clickEl(el) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: el.x, y: el.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.x, y: el.y, button: "left", clickCount: 1 });
}

/** 在设置弹窗内按可见文本找元素中心坐标（真实点击用；取文本最短的最内层元素，避免命中容器）。 */
async function clickByText(text, scopeSelector = 'dialog[aria-label="设置与账户"]') {
  const r = await js(`(() => {
    const scope = document.querySelector(${JSON.stringify(scopeSelector)}) || document.body;
    const all = [...scope.querySelectorAll('*')];
    const matches = all
      .filter((n) => (n.textContent ?? "").includes(${JSON.stringify(text)}) && n.getBoundingClientRect().width > 0)
      .sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
    const n = matches[0];
    if (!n) return null;
    const rect = n.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: n.tagName, cls: String(n.className).slice(0, 40), text: (n.textContent ?? "").slice(0, 30) };
  })()`);
  if (!r) throw new Error(`找不到可点击元素：${text}`);
  await clickEl(r);
}

async function invoke(cmd, args) {
  return js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
}

// ---------- 打开应用首页 → 设置 → SDK → CLI 管理 → 展开 Claude ----------
await js(`window.dispatchEvent(new HashChangeEvent('hashchange'))`).catch(() => {});
await sleep(300);
await clickByText("设置与账户", "body");
await sleep(500);
await clickByText("SDK 与 CLI", 'nav[aria-label="设置分类"]');
await sleep(1200); // SettingsSdk 挂载时执行真实 sdk 检测
// CLI 管理 / SDK 管理 页签
await js(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const t = tabs.find(b => (b.textContent ?? "").trim() === "CLI 管理");
  if (t) t.click();
})()`);
// 等 CLI 卡片渲染（sdkList 真实检测返回后才出现）
for (let i = 0; i < 40; i++) {
  const ok = await js(`document.querySelectorAll('.set-sdk-select').length >= 3`);
  if (ok) break;
  await sleep(400);
}
if ((await js(`document.querySelectorAll('.set-sdk-select').length`)) < 3) throw new Error("CLI 卡片未渲染");
// 展开 Claude 卡片（若已展开则跳过，避免重复点击折叠）
const expanded = await js(`(() => {
  const btn = [...document.querySelectorAll('.set-sdk-select')].find(b => (b.textContent ?? "").includes("Claude Code"));
  return btn?.getAttribute("aria-expanded");
})()`);
if (expanded !== "true") {
  await clickByText("Claude Code", 'dialog[aria-label="设置与账户"]');
}
await sleep(200);
// 等待 Shell 候选加载完成（fieldset 出现）
for (let i = 0; i < 30; i++) {
  const ready = await js(`!!document.querySelector('.set-shell-group fieldset.set-shell-opts')`);
  if (ready) break;
  await sleep(300);
}
const ready = await js(`!!document.querySelector('.set-shell-group fieldset.set-shell-opts')`);
if (!ready) throw new Error("Shell 候选未加载完成");

// ---------- S-01 默认（浅色，Claude 展开，均为自动） ----------
await shot("s01-default-light.png");

// ---------- S-02 指定 PowerShell 7（真实鼠标点击候选 label；未保存） ----------
await clickByText("PowerShell 7", 'dialog[aria-label="设置与账户"]');
await sleep(300);
await shot("s02-pwsh-light.png");

// ---------- S-05 已保存（保存 → toast + 已保存） ----------
await clickByText("保存");
await sleep(600); // toast 持续 3200ms
await shot("s05-saved-light.png");
await sleep(2900); // 等 toast 消失

// ---------- S-03 路径失效（保存的 pwsh 指向临时路径，删除后重新检测） ----------
const missDir = join(tmpdir(), "cr053-missing");
try { rmSync(missDir, { recursive: true, force: true }); } catch {}
mkdirSync(join(missDir), { recursive: true });
writeFileSync(join(missDir, "pwsh.exe"), "fake");
await invoke("cli_shell_save", { cliId: "claude", mode: "pwsh", path: missDir + "\\pwsh.exe" });
rmSync(join(missDir, "pwsh.exe"), { force: true });
// 点「重新检测」刷新 get → missing=true；候选行标红
const groupRect = await js(`(() => {
  const groups = [...document.querySelectorAll('.set-shell-group')];
  const g = groups[0];
  const btn = [...g.querySelectorAll('button')].find(b => (b.textContent ?? "").includes("重新检测"));
  const rect = btn.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
await clickEl(groupRect);
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const missing = await js(`(() => {
    const opt = [...document.querySelectorAll('.set-shell-group .set-shell-opt')].find(o => o.classList.contains('bad'));
    return !!opt;
  })()`);
  if (missing) break;
}
await sleep(200);
await shot("s03-missing-light.png");
// 恢复 auto
await invoke("cli_shell_save", { cliId: "claude", mode: "auto", path: null });
await js(`(() => {
  const groups = [...document.querySelectorAll('.set-shell-group')];
  const btn = [...groups[0].querySelectorAll('button')].find(b => (b.textContent ?? "").includes("重新检测"));
  btn.click();
})()`);
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const bad = await js(`!!document.querySelector('.set-shell-group .set-shell-opt.bad')`);
  if (!bad) break;
}

// ---------- S-04 检测中（点击重新检测后立即截图；检测需真实拉起进程 1-3s） ----------
await js(`(() => {
  const groups = [...document.querySelectorAll('.set-shell-group')];
  const btn = [...groups[0].querySelectorAll('button')].find(b => (b.textContent ?? "").includes("重新检测"));
  btn.click();
})()`);
await sleep(120);
await shot("s04-checking-light.png");
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const busy = await js(`document.querySelector('.set-shell-group')?.getAttribute('aria-busy') === 'true'`);
  if (!busy) break;
}

// ---------- S-06 深色（持久化设置 + 直接应用 DOM 主题，与 store.toggleTheme 等效） ----------
await invoke("set_theme", { theme: "dark" });
await js(`document.documentElement.dataset.theme = 'dark'`);
await sleep(600);
await shot("s06-default-dark.png");

// ---------- S-07 1024 宽 ----------
await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(600);
await shot("s07-width-1024.png");

// ---------- S-08 390 单列 ----------
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
await sleep(700);
await shot("s08-narrow-390.png");

// ---------- 还原 ----------
await send("Emulation.clearDeviceMetricsOverride");
await js(`document.documentElement.dataset.theme = 'light'`);
await invoke("set_theme", { theme: "light" });
await invoke("cli_shell_save", { cliId: "claude", mode: "auto", path: null }).catch(() => {});
console.log("done");
process.exit(0);
