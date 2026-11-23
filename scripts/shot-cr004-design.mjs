/** UI-FEAT-004 同步批次设计稿截图（浅/深/窄）。 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/UI/sync-batches";
mkdirSync(OUT, { recursive: true });
const list = await (await fetch("http://127.0.0.1:9444/json/list")).json();
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

const url = "file:///D:/github/AI_Delelovelop/docs/UI/sync-batches/index.html";
async function shoot(name, width, height, dark) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Page.navigate", { url });
  await wait(900);
  if (dark) {
    await send("Runtime.evaluate", { expression: "document.documentElement.setAttribute('data-theme','dark')" });
    await wait(250);
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, "base64"));
  console.log("shot", name);
}
await shoot("shot-light-1440", 1440, 900, false);
await shoot("shot-dark-1440", 1440, 900, true);
await shoot("shot-light-390", 390, 844, false);
ws.close();