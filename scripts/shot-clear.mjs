import { writeFileSync } from "node:fs";
const outName = process.argv[2] ?? "chat";
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i,{res,rej}); ws.send(JSON.stringify({id:i,method:m,params:p})); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const {res,rej}=pending.get(m.id); pending.delete(m.id); m.error?rej(new Error(JSON.stringify(m.error))):res(m.result); } };
await new Promise((r)=>(ws.onopen=r));
await send("Page.enable"); await send("Runtime.enable");
async function js(x){const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300));return r.result?.value;}
// 滚到会话顶部，看图片与首个工具卡
const v = await js(`
(async () => {
  const box = document.querySelector('.chat-msgs');
  if (!box) return 'no .chat-msgs';
  box.scrollTop = 0;
  await new Promise(r=>setTimeout(r,600));
  const imgs = [...document.querySelectorAll('.chat-md img')];
  const links = [...document.querySelectorAll('.chat-md a')];
  return {
    imgs: imgs.map(i=>({src:(i.getAttribute('src')||'').slice(0,60), w:i.naturalWidth, h:i.naturalHeight, rendered:i.clientWidth})),
    links: links.map(a=>({href:(a.getAttribute('href')||'').slice(0,60), text:a.textContent.slice(0,40)})),
    html: (document.querySelector('.chat-md')?.innerHTML||'').slice(0,400)
  };
})()
`);
console.log(JSON.stringify(v,null,1).slice(0,1400));
const s = await send("Page.captureScreenshot",{format:"png"});
writeFileSync(`docs/Test/screenshots/chat-ui/${outName}.png`, Buffer.from(s.data,"base64"));
console.log("saved", outName); ws.close();
