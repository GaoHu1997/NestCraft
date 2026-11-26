// CR-102：通过 CDP 驱动真实组件挂载页截图（含详情区滚动条滚动中/静止两帧动态证据）。
// 前置：vite dev (1420) + headless Edge --remote-debugging-port=9339。
import { writeFileSync, mkdirSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9339/json/list")).json();
const page = list.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
};
await new Promise(r => (ws.onopen = r));

const outDir = "docs/Test/screenshots";
mkdirSync(outDir, { recursive: true });

async function shot(url, file, expand = false, scrollProbe = false) {
  await send("Page.navigate", { url });
  await new Promise(r => setTimeout(r, 2500));
  if (expand) {
    await send("Runtime.evaluate", { expression: "document.querySelectorAll('.chat-retry-line').forEach(d=>d.open=true)" });
    await new Promise(r => setTimeout(r, 400));
  }
  let probe = null;
  if (scrollProbe) {
    // 详情区滚动中：scroll 事件触发 .scrollbar-active（700ms 后移除）
    const r1 = await send("Runtime.evaluate", { expression: `
      (async () => {
        const pres = [...document.querySelectorAll('.chat-retry-detail pre')];
        const pre = pres.find(p => p.scrollHeight > p.clientHeight);
        if (!pre) return 'no-scrollable-pre(' + pres.length + ')';
        pre.scrollTop = 40; pre.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 120));
        return pre.classList.contains('scrollbar-active') ? 'active' : 'inactive';
      })()`, awaitPromise: true });
    probe = { during: r1.result.value };
    await send("Page.captureScreenshot", { format: "png" }).then(r => writeFileSync(`${outDir}/${file.replace('.png', '-scroll-active.png')}`, Buffer.from(r.data, "base64")));
    await new Promise(r => setTimeout(r, 900));
    const r2 = await send("Runtime.evaluate", { expression: `(document.querySelector('.chat-retry-detail pre.scrollbar-active') ? 'active' : 'idle-hidden')` });
    probe.after = r2.result.value;
    await send("Page.captureScreenshot", { format: "png" }).then(r => writeFileSync(`${outDir}/${file.replace('.png', '-scroll-idle.png')}`, Buffer.from(r.data, "base64")));
    return probe;
  }
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${file}`, Buffer.from(r.data, "base64"));
  return "ok";
}

const B = "http://localhost:1420/cr102-harness.html";
console.log("light-wide:", await shot(B, "cr102-app-light-wide.png", false));
console.log("light-wide-details:", await shot(B, "cr102-app-light-wide-details.png", true));
console.log("dark-wide:", await shot(`${B}?theme=dark`, "cr102-app-dark-wide.png", true));
console.log("narrow:", await shot(`${B}?w=360`, "cr102-app-narrow-360.png", true));
console.log("scroll-probe:", JSON.stringify(await shot(`${B}`, "cr102-app-light-wide.png", true, true)));
ws.close();
