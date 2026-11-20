/**
 * 通过 WebView2 CDP 对真实应用窗口截图（不修改产品代码）。
 * 运行：node scripts/shot.mjs <输出文件> [等待毫秒] [截图前执行JS]
 */
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "shot.png";
const waitMs = Number(process.argv[3] ?? 1500);
const preJs = process.argv[4] ?? "";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
if (!page) {
  console.error("未找到应用页面");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");
if (preJs) {
  const r = await send("Runtime.evaluate", { expression: preJs, awaitPromise: true, returnByValue: true });
  console.log("preJs =>", JSON.stringify(r.result?.value ?? r.result?.description ?? "").slice(0, 300));
}
await new Promise((r) => setTimeout(r, waitMs));
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out);
ws.close();
