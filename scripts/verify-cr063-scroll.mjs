/** CR-063 软件侧滚动条四帧证据（隔离设计预览）。前置：vite preview 4173、Chrome 9334。 */
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
const shot = async name => {
  await wait(120);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:4173/?preview=design" });
await wait(4000);

await evaluate(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projects = await invoke("list_projects");
  const p = projects[0];
  for (let i = 0; i < 30; i++) await invoke("chat_session_create", { projectId: p.id });
  const el = [...document.querySelectorAll(".nc-side-project")].find(n => (n.textContent || "").includes(p.name));
  if (el) el.click();
  await new Promise(r => setTimeout(r, 800));
  const hist = document.querySelector("[data-chat-overlay-trigger='history']");
  if (hist) hist.click();
  await new Promise(r => setTimeout(r, 900));
  return true;
})()`);

const idle = await evaluate(`(() => { const l = document.querySelector(".chat-history-list"); return { active: l?.classList.contains("scrollbar-active") ?? null, scrollable: l ? l.scrollHeight > l.clientHeight : null }; })()`);
console.log("idle", JSON.stringify(idle));
await shot("c63-sw-09-scroll-idle");

const active = await evaluate(`(() => {
  const l = document.querySelector(".chat-history-list");
  l.scrollTop = 260;
  l.dispatchEvent(new Event("scroll"));
  return { active: l.classList.contains("scrollbar-active"), top: l.scrollTop };
})()`);
console.log("scrolling", JSON.stringify(active));
await shot("c63-sw-10-scroll-active");

await wait(850);
const after = await evaluate(`(() => { const l = document.querySelector(".chat-history-list"); return { active: l.classList.contains("scrollbar-active"), top: l.scrollTop }; })()`);
console.log("after-idle", JSON.stringify(after));
await shot("c63-sw-11-scroll-after-idle");

// 继续滚动一次，确认可重复出现
const again = await evaluate(`(() => { const l = document.querySelector(".chat-history-list"); l.scrollTop = 500; l.dispatchEvent(new Event("scroll")); return { active: l.classList.contains("scrollbar-active") }; })()`);
console.log("scrolling-again", JSON.stringify(again));
await shot("c63-sw-12-scroll-again");

ws.close();