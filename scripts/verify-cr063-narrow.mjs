/** CR-063 390×844 窄屏软件行为（AC-13 收窄后：只验软件）。前置：vite preview 4173、Chrome 9334。 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr063-software";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
const page = list.find(p => p.type === "page" && String(p.url).includes("4173")) || list.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(4000);

const state = await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects[0];
  for (let i = 0; i < 8; i++) await invoke("chat_session_create", { projectId: p.id });
  const el = [...document.querySelectorAll(".nc-side-project")].find(n => (n.textContent || "").includes(p.name));
  if (el) el.click();
  await new Promise(r => setTimeout(r, 800));
  let hist = document.querySelector("[data-chat-overlay-trigger='history']");
  // 窄屏下 AI 侧栏默认收起：面板在 DOM 但仍 hidden，需先点底部「AI 侧栏」
  const panel = document.querySelector(".chat-panel");
  const panelHidden = !panel || panel.hasAttribute("hidden") || panel.offsetParent === null;
  if (panelHidden) {
    const ai = [...document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "AI 侧栏");
    if (ai) ai.click();
    await new Promise(r => setTimeout(r, 900));
    hist = document.querySelector("[data-chat-overlay-trigger='history']");
  }
  if (hist) hist.click();
  await new Promise(r => setTimeout(r, 900));
  const overlay = document.querySelector(".chat-history");
  const rect = overlay?.getBoundingClientRect();
  return {
    overlay: !!overlay,
    width: rect ? Math.round(rect.width) : null,
    viewport: window.innerWidth,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    count: document.querySelector(".chat-history-count")?.textContent ?? null,
    hasSearch: !!document.querySelector("#chat-history-q"),
    rows: document.querySelectorAll(".chat-hist-item").length,
    panels: document.querySelectorAll(".chat-panel").length,
    triggers: [...document.querySelectorAll("[data-chat-overlay-trigger]")].map(e => e.getAttribute("data-chat-overlay-trigger")),
    tailButtons: [...document.querySelectorAll("button")].map(b => (b.textContent || "").trim()).filter(Boolean).slice(-10),
  };
})()`);
console.log("narrow", JSON.stringify(state));
const r = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/c63-sw-13-narrow-390.png`, Buffer.from(r.data, "base64"));
console.log("shot c63-sw-13-narrow-390");

ws.close();