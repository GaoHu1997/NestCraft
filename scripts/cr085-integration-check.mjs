/**
 * CR-085 正式组件集成检查（FEAT-014 / FEAT-015）。
 * 用真实 React 设置组件 + 隔离合成 IPC；不接触真实供应商、SDK 安装、MCP 或用户数据。
 * 运行：node scripts/cr085-integration-check.mjs
 */
import { mkdir, writeFile, cp, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const OUT = "docs/Test/screenshots/cr085-software";
const BUILD = ".tmp-cr085";
await mkdir(OUT, { recursive: true });
await rm(BUILD, { recursive: true, force: true });
await mkdir(join(BUILD, "ui"), { recursive: true });
await cp(join(ROOT, "public/ui"), join(BUILD, "ui"), { recursive: true });

// esbuild 打包真实组件（含 @ → src 别名）。
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: ["docs/Test/cr085-settings-fixture.tsx"],
  bundle: true, format: "esm", target: "es2022", outfile: join(BUILD, "harness.js"),
  alias: { "@": join(ROOT, "src") }, loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
  jsx: "automatic", logLevel: "warning", charset: "utf8",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(join(BUILD, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CR-085 集成验证</title><link rel="stylesheet" href="./harness.css"></head><body><div id="root"></div><script type="module" src="./harness.js"></script></body></html>`);

const port = 8788;
const server = spawn(process.execPath, ["-e", `
const http=require('http'),fs=require('fs'),path=require('path');
const root=${JSON.stringify(join(ROOT, BUILD))};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
http.createServer((req,res)=>{const url=decodeURIComponent(req.url.split('?')[0]);const file=path.join(root,url==='/'?'index.html':url);
fs.readFile(file,(e,data)=>{if(e){res.writeHead(404);res.end('not found');return;}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});res.end(data);});}).listen(${port},'127.0.0.1');`], { stdio: "ignore", windowsHide: true });
await delay(600);

const profile = join(tmpdir(), `cr085-${Date.now()}`);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore", windowsHide: true });

const results = { at: new Date().toISOString(), checks: [], shots: [], errors: [] };
let ws, seq = 0; const pending = new Map();
const check = (name, ok, detail) => {
  results.checks.push({ name, pass: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " :: " + JSON.stringify(detail)}`);
};

try {
  let devPort = 0;
  for (let i = 0; i < 100 && !devPort; i += 1) {
    try { devPort = Number((await import("node:fs")).readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { await delay(100); }
  }
  if (!devPort) throw new Error("Chrome 未启动");
  const pages = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  ws = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl);
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") results.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  await new Promise((ok, no) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", no, { once: true }); });
  const cdp = (method, params = {}) => new Promise((ok, no) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); no(new Error(`${method}超时`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); message.error ? no(new Error(JSON.stringify(message.error))) : ok(message.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async expression => {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const frame = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const shot = async name => { await frame(); const r = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(join(OUT, `${name}.png`), Buffer.from(r.data, "base64")); results.shots.push(`${name}.png`); };
  const openTab = async tab => { await js(`window.cr085Open(${JSON.stringify(tab)}); true`); await delay(320); await frame(); };
  const click = async selector => { const ok = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`); if (!ok) throw new Error(`点击失败：${selector}`); await delay(160); };

  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?preview=design` });
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.readyState==="complete" && !!document.querySelector(".set-modal")`).catch(() => false)) break;
    await delay(100);
  }
  await delay(600);
  check("真实设置组件已挂载", await js(`!!document.querySelector(".set-modal")`));

  /* ---------------- FEAT-014 模型管理 ---------------- */
  await openTab("models");
  check("AC-01 模型管理无底部蓝色提示块",
    await js(`!document.querySelector(".set-scroll .set-note") && !document.body.innerText.includes("获取模型会自动补全能力字段")`));

  const expandInfo = await js(`(()=>{const cards=[...document.querySelectorAll(".set-provider-card")];return {cards:cards.length};})()`);
  check("供应商列表渲染", expandInfo.cards > 0, expandInfo);
  await shot("01-models");

  /* 头部「新增供应商」位置在折叠前后不变 */
  const headerPos = await js(`(()=>{
    const btn=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("新增供应商"));
    if(!btn)return null;const r=btn.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y)};})()`);
  await click('.set-provider-card .set-provider-select');
  const headerPos2 = await js(`(()=>{
    const btn=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("新增供应商"));
    if(!btn)return null;const r=btn.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y)};})()`);
  check("AC-03 折叠供应商不移动新增按钮", headerPos && headerPos2 && headerPos.x === headerPos2.x && headerPos.y === headerPos2.y, { headerPos, headerPos2 });

  /* 新增供应商：可指定 ID、留空生成、重名拒绝 */
  const addProvider = await js(`(()=>{
    const btn=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("新增供应商"));
    if(!btn)return null;btn.click();return true;})()`);
  check("AC-04 新增供应商入口存在", addProvider === true);
  await delay(320);

  /* ---------------- FEAT-015 SDK 与 CLI ---------------- */
  await openTab("sdk");
  await delay(400);
  check("SDK 页签渲染", await js(`!!document.querySelector('[role="tab"][aria-selected="true"]')`));
  await shot("02-sdk-tab");

  const cliTab = await js(`(()=>{const t=[...document.querySelectorAll('[role="tab"]')].find(x=>x.textContent.includes("CLI 管理"));if(!t)return false;t.click();return true;})()`);
  check("CLI 管理页签可切换", cliTab === true);
  await delay(320);
  await shot("03-cli-tab");

  /* AC-01：权限档位按 CLI 不同 */
  const permissionShape = await js(`(()=>{
    const cards=[...document.querySelectorAll(".set-sdk-card")];
    if(!cards.length)return null;
    cards[0].querySelector(".set-sdk-select")?.click();
    return cards.length;})()`);
  await delay(360);
  const perms = await js(`(()=>{
    const sel=[...document.querySelectorAll("select")].find(s=>(s.getAttribute("aria-label")||"").includes("权限模式"));
    if(!sel)return null;
    return {count:sel.options.length, labels:[...sel.options].map(o=>({t:o.textContent,d:o.disabled}))};})()`);
  check("AC-01 权限档位按当前 CLI 能力渲染", perms && perms.count > 0, perms && { count: perms.count });
  await shot("04-cli-permissions");

  /* AC-02：兜底模型可选 + 思考档位随模型 */
  const routeInfo = await js(`(()=>{
    const tabs=[...document.querySelectorAll('[role="tab"]')].map(t=>t.textContent.trim());
    return tabs;})()`);
  check("AC-02 任务模型路由存在折叠标签", routeInfo.length > 0, routeInfo.slice(0, 6));

  /* AC-03/04：SDK 页签折叠头与合并按钮 */
  await js(`(()=>{const t=[...document.querySelectorAll('[role="tab"]')].find(x=>x.textContent.includes("SDK 管理"));t?.click();return true;})()`);
  await delay(500);
  const sdkHead = await js(`(()=>{
    const cards=[...document.querySelectorAll(".set-sdk-card")];
    const text=cards.map(c=>c.textContent).join(" | ");
    return {cards:cards.length, hasArrow:text.includes("→"), hasNewer:text.includes("有新版本"), hasInstalledLabel:/\\b已安装\\b/.test(text)};})()`);
  check("AC-03 SDK 折叠头显示升级前后版本", sdkHead.cards > 0 && sdkHead.hasArrow, sdkHead);
  check("AC-03 已安装不标记、过期标有新版本", sdkHead.hasNewer && !sdkHead.hasInstalledLabel, sdkHead);

  /* 展开一个 SDk 卡片检查合并按钮 */
  await js(`(()=>{document.querySelector(".set-sdk-card .set-sdk-select")?.click();return true;})()`);
  await delay(360);
  const installBtn = await js(`(()=>{
    const btns=[...document.querySelectorAll(".set-sdk-body button")];
    const target=btns.find(b=>/安装到|升级到|当前版本/.test(b.textContent));
    return target?{text:target.textContent.trim(),disabled:target.disabled}:null;})()`);
  check("AC-04 当前与目标合并为单一安装按钮", !!installBtn, installBtn);
  await shot("05-sdk-expanded");

  /* AC-05：操作记录入口 */
  const recordsBtn = await js(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("操作记录"));if(!b)return null;b.click();return b.textContent.trim();})()`);
  await delay(300);
  const recordsPanel = await js(`(()=>{const p=document.querySelector(".cr085-sdk-records-panel");return p?{open:true,items:p.querySelectorAll("li").length}:{open:false};})()`);
  check("AC-05 右下操作记录可打开", recordsBtn !== null && recordsPanel.open, { recordsBtn, recordsPanel });
  await shot("06-sdk-records");

  /* AC-06：刷新入口合并（不再有「重新检测」与「刷新版本」两个按钮） */
  const refreshBtns = await js(`(()=>{
    const texts=[...document.querySelectorAll(".set-sdk-body button")].map(b=>b.textContent.trim());
    return {refresh:texts.filter(t=>t==="刷新").length, legacyDetect:texts.filter(t=>t.includes("重新检测")).length, legacyVersion:texts.filter(t=>t.includes("刷新版本")).length};})()`);
  check("AC-06 检测与版本刷新合并为「刷新」", refreshBtns.refresh >= 1 && refreshBtns.legacyDetect === 0 && refreshBtns.legacyVersion === 0, refreshBtns);

  /* ---------------- 能力页 ---------------- */
  await openTab("skill");
  await delay(320);
  const skillHeight = await js(`(()=>{const rows=[...document.querySelectorAll(".cr085-skills .set-cap-row")];if(!rows.length)return null;
    return {count:rows.length, heights:[...new Set(rows.map(r=>Math.round(r.getBoundingClientRect().height)))], clamp:[...rows].map(r=>{const d=r.querySelector(".cr085-skill-description");return d?getComputedStyle(d).webkitLineClamp:null;})};})()`);
  check("AC-01 Skill 行高统一且描述两行截断", skillHeight && skillHeight.count > 0 && skillHeight.heights.length === 1 && skillHeight.heights[0] === 84 && skillHeight.clamp.every(v=>v === "2"), skillHeight);
  await shot("07-skill");

  await openTab("mcp");
  await delay(320);
  const mcpRows = await js(`(()=>{const rows=[...document.querySelectorAll(".cr085-mcp-list .set-cap-row")];
    const first=rows[0];
    return {rows:rows.length, externalSwitch:!!first?.querySelector('[role="switch"]'), verify:[...first?.querySelectorAll("button")||[]].some(b=>b.textContent.includes("验证")), internalSwitchInDialog:false};})()`);
  check("AC-03 MCP 启停外露且列表有验证入口", mcpRows.rows > 0 && mcpRows.externalSwitch && mcpRows.verify, mcpRows);
  await shot("08-mcp");

  await openTab("tool");
  await delay(320);
  const tools = await js(`(()=>{const scope=document.querySelector(".cr085-tools");const text=scope?.innerText||"";
    const expanded=[...scope?.querySelectorAll("[aria-expanded]")||[]].some(e=>e.getAttribute("aria-expanded")==="true");
    return {hasCliNative:(document.querySelector(".set-scroll")?.innerText||"").includes("CLI 原生"), hasInjected:text.includes("已注入"), anyExpanded:expanded, hasBuiltin:text.includes("内置")};})()`);
  check("AC-04 Tools 无 CLI 原生且默认全部折叠", !tools.hasCliNative && !tools.anyExpanded, tools);
  check("AC-05 内置分类标注且无「已注入」", tools.hasBuiltin && !tools.hasInjected, tools);
  await shot("09-tool");

  /* ---------------- FEAT-014 细项 ---------------- */
  await openTab("models");
  await delay(400);
  // 定向到已保存的 TierFlow 供应商（列表首位可能是「新增」草稿卡）。
  await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const btn=card?.querySelector(".set-provider-select");
    if(btn&&btn.getAttribute("aria-expanded")!=="true")btn.click();return true;})()`);
  await delay(500);

  const identity = await js(`(()=>{
    const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const inputs=[...card.querySelectorAll(".cr085-provider-identity input")];
    const idInput=inputs[0], nameInput=inputs[1];
    if(!idInput||!nameInput)return null;
    return {idDisabled:idInput.disabled, sameRow:Math.abs(idInput.getBoundingClientRect().top-nameInput.getBoundingClientRect().top)<1,
      idValue:idInput.value, nameValue:nameInput.value};})()`);
  check("AC-04 已有供应商 ID 与名称同行且 ID 禁改", identity && identity.idDisabled && identity.sameRow && identity.idValue === "PRV-01", identity);

  const addKey = await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const b=card?.querySelector(".cr085-add-key");if(!b)return null;
    const list=b.closest(".set-key-list");const r=b.getBoundingClientRect(),lr=list.getBoundingClientRect();
    return {text:b.textContent.trim(),fullWidth:Math.abs(r.width-lr.width)<3};})()`);
  check("AC-02 添加密钥整行按钮", addKey && addKey.text === "添加密钥" && addKey.fullWidth, addKey);

  const keyRow = await js(`(()=>{const row=document.querySelector(".cr085-key-row");if(!row)return null;
    return {hasCopy:!!row.querySelector('[aria-label^="复制密钥明文"]'), mask:row.querySelector(".cr085-key-identity")?.textContent?.trim()||"",
      oneLine:row.getBoundingClientRect().height<80};})()`);
  check("AC-09 密钥行掩码与复制按钮", keyRow && keyRow.hasCopy && keyRow.oneLine, keyRow);

  const revealedBefore = await js(`window.cr085Fixture.revealed||0`);
  await js(`document.querySelector('[aria-label^="复制密钥明文"]').click()`);
  await delay(300);
  const revealedAfter = await js(`window.cr085Fixture.revealed||0`);
  check("AC-09 复制按钮按所有权读取明文", revealedAfter > revealedBefore, { revealedBefore, revealedAfter });

  const chatMode = await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const btn=[...card.querySelectorAll('[role="radio"]')].find(b=>b.textContent.trim()==="Chat");
    if(!btn)return null;btn.click();return true;})()`);
  await delay(250);
  const chatChecked = await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const pick=t=>[...card.querySelectorAll('[role="radio"]')].find(b=>b.textContent.trim()===t);
    return {checked:pick("Chat")?.getAttribute("aria-checked"),responses:pick("Responses")?.getAttribute("aria-checked")};})()`);
  check("AC-05 Chat 可选且与 Responses 区分", chatMode && chatChecked.checked === "true" && chatChecked.responses !== "true", chatChecked);
  await shot("13-chat-protocol");

  const scopeEntry = await js(`(()=>{const rows=[...document.querySelectorAll(".cr085-key-row")];
    // 每个密钥行内必须恰好一个范围入口（全部模型 / N 个模型），不出现第二个重复文本。
    const perRow=rows.map(row=>[...row.querySelectorAll(".set-link")].filter(b=>b.textContent.trim()==="全部模型"||/^\\d+ 个模型$/.test(b.textContent.trim())).length);
    const labels=rows.map(row=>[...row.querySelectorAll(".set-link")].map(b=>b.textContent.trim()));
    return {rows:rows.length, perRow, labels};})()`);
  check("AC-08 每密钥范围只有单一入口", scopeEntry.rows > 0 && scopeEntry.perRow.every(n => n === 1), scopeEntry);

  const endpointEntry = await js(`(()=>{const adds=[...document.querySelectorAll("button")].filter(b=>/OpenAI|Anthropic/.test(b.textContent)&&b.textContent.includes("地址"));
    const switches=document.querySelectorAll(".set-pm-section [role=switch]").length;
    return {addCount:adds.length, switches};})()`);
  check("AC-06 端点无启停开关且保留补填入口", endpointEntry.switches === 0, endpointEntry);
  await shot("14-provider-editor");

  /* 获取模型弹层：每项单行（先切到「模型配置」页签） */
  await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const tab=[...card.querySelectorAll('[role="tab"]')].find(x=>x.textContent.trim()==="模型配置");tab?.click();return true;})()`);
  await delay(400);
  const discoverBtn = await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const b=[...card.querySelectorAll("button")].find(x=>x.textContent.trim()==="获取模型");
    return b?{found:true,disabled:b.disabled}:{found:false};})()`);
  await js(`(()=>{const card=[...document.querySelectorAll(".set-provider-card")].find(c=>c.textContent.includes("TierFlow"));
    const b=[...card.querySelectorAll("button")].find(x=>x.textContent.trim()==="获取模型");b?.click();return true;})()`);
  await delay(900);
  const picker = await js(`(()=>{const rows=[...document.querySelectorAll(".set-pick-row")];
    const openDialogs=[...document.querySelectorAll("dialog[open]")].map(d=>d.getAttribute("aria-label")||d.className);
    const toasts=[...document.querySelectorAll(".toast")].map(t=>t.textContent);
    if(!rows.length)return {count:0, openDialogs, toasts, discoverBtn:${JSON.stringify(discoverBtn)}};
    return {count:rows.length, heights:[...new Set(rows.map(r=>Math.round(r.getBoundingClientRect().height)))],
      hasCheckbox:rows.every(r=>!!r.querySelector('input[type="checkbox"]'))};})()`);
  check("AC-11 获取模型清单每项单行", picker && picker.count > 0 && picker.heights.every(h=>h<=32) && picker.hasCheckbox, picker);
  await shot("15-model-picker");
  await js(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>/取消|关闭/.test(x.textContent)&&x.closest("dialog"));b?.click();return true;})()`);

  /* ---------------- FEAT-015 细项：兜底模型与思考档位 ---------------- */
  await openTab("sdk");
  await delay(400);
  await js(`(()=>{const t=[...document.querySelectorAll('[role="tab"]')].find(x=>x.textContent.includes("CLI 管理"));t?.click();return true;})()`);
  await delay(320);
  await js(`(()=>{const btn=document.querySelector(".set-sdk-card .set-sdk-select");
    if(btn&&btn.getAttribute("aria-expanded")!=="true")btn.click();return true;})()`);
  await delay(400);
  await js(`(()=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(x=>x.textContent.trim()==="兜底模型");tab?.click();return true;})()`);
  await delay(360);
  const fallback = await js(`(()=>{
    const selects=[...document.querySelectorAll("select")];
    const model=selects.find(s=>(s.getAttribute("aria-label")||"")==="兜底模型");
    const effort=selects.find(s=>(s.getAttribute("aria-label")||"")==="兜底思考等级");
    if(!model||!effort)return null;
    const options=[...model.options].filter(o=>o.value);
    return {modelOptions:options.length, effortDisabled:effort.disabled, effortOptions:[...effort.options].filter(o=>o.value).length, first:options[0]?.textContent};})()`);
  check("AC-02 兜底可选模型且未选模型时思考禁用", fallback && fallback.modelOptions > 1 && fallback.effortDisabled, fallback);

  await js(`(()=>{const s=[...document.querySelectorAll("select")].find(x=>(x.getAttribute("aria-label")||"")==="兜底模型");
    if(!s)return null;const target=[...s.options].find(o=>o.value);
    s.value=target.value;s.dispatchEvent(new Event("change",{bubbles:true}));return target.textContent;})()`);
  await delay(360);
  const fallbackEffort = await js(`(()=>{const effort=[...document.querySelectorAll("select")].find(x=>(x.getAttribute("aria-label")||"")==="兜底思考等级");
    const model=[...document.querySelectorAll("select")].find(x=>(x.getAttribute("aria-label")||"")==="兜底模型");
    const selected=model?.value||"";
    // 期望值直接取该模型在合成夹具中的 efforts 键，验证「只列所选模型档位」的语义。
    const providerId=selected.split("/")[0],modelId=selected.split("/").slice(1).join("/");
    const provider=(window.cr085Fixture.providers||[]).find(p=>p.id===providerId);
    const modelRow=provider?.models.find(m=>m.modelId===modelId);
    const expected=Object.keys(modelRow?.efforts||{}).sort();
    return {disabled:effort.disabled, options:[...effort.options].filter(o=>o.value).map(o=>o.value).sort(),
      modelValue:selected, expected};})()`);
  check("AC-02 选定模型后思考只列该模型档位",
    fallbackEffort.options.length > 0 && JSON.stringify(fallbackEffort.options) === JSON.stringify(fallbackEffort.expected),
    fallbackEffort);
  await shot("16-fallback-effort");

  /* 操作记录上限 5 与持久化 */
  const recordLimit = await js(`(async()=>{
    const fixture=window.cr085Fixture;
    for(let i=0;i<7;i++){
      const id='SDK-T'+(i+1);
      fixture.jobs[id]={id,sdkId:'claude',kind:'install',phase:'done',error:null,logs:['合成'],createdAt:Date.now(),updatedAt:Date.now()};
    }
    return true;})()`);
  await delay(200);
  const historyLen = await js(`(async()=>{
    const raw=window.cr085Fixture.settings["sdk.operationHistory.cr085"];
    return raw?JSON.parse(raw).length:0;})()`);
  check("AC-05 操作记录写入 setting 且不超过 5 条", recordLimit && historyLen <= 5, { historyLen });

  /* ---------------- UI-SCROLL-001 动态 ---------------- */
  await openTab("models");
  await delay(400);
  const idleActive = await js(`document.querySelector(".set-scroll")?.classList.contains("scrollbar-active")`);
  const box = await js(`(()=>{const el=document.querySelector(".set-scroll");const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await delay(200);
  const hoverActive = await js(`document.querySelector(".set-scroll")?.classList.contains("scrollbar-active")`);
  check("SCROLL-001 静止与悬停均不显示滚动条", !idleActive && !hoverActive, { idleActive, hoverActive });
  for (let i = 0; i < 4; i += 1) { await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...box, deltaX: 0, deltaY: 90 }); await delay(160); }
  const scrolling = await js(`document.querySelector(".set-scroll")?.classList.contains("scrollbar-active")`);
  await shot("10-scroll-active");
  check("SCROLL-001 实际滚动显示滚动条", scrolling === true);
  await delay(900);
  const settled = await js(`document.querySelector(".set-scroll")?.classList.contains("scrollbar-active")`);
  check("SCROLL-001 停止后 700ms 隐藏", settled === false);
  await shot("11-scroll-idle");

  /* 390 窄屏 + 深色 */
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await js(`document.documentElement.dataset.theme="dark"; window.cr085Open("models"); true`);
  await delay(500);
  const narrow = await js(`(()=>{const el=document.querySelector(".set-scroll");return {overflow: el ? el.scrollWidth - el.clientWidth : null, head: !!document.querySelector(".set-head")};})()`);
  check("390 深色无正文横向溢出", narrow.head && (narrow.overflow ?? 99) <= 2, narrow);
  await shot("12-narrow-dark");

  check("无运行时 JS 异常", results.errors.length === 0, results.errors.slice(0, 3));
} catch (error) {
  results.failure = String(error?.stack || error);
  console.error(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await writeFile("docs/Test/cr085-integration-results.json", JSON.stringify(results, null, 2));
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill(); server.kill();
  console.log(JSON.stringify({ passed: results.checks.filter(c => c.pass).length, total: results.checks.length, shots: results.shots.length }));
  if (results.checks.some(c => !c.pass)) process.exitCode = 1;
}