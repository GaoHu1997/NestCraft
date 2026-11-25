/**
 * CR-058 r5 设计稿验证与截图（workbench-v4）：P20 行为指纹与归因面板。
 * 前置：chrome --headless=new --remote-debugging-port=9333 about:blank
 * 运行：node scripts/verify-cr058-r5-design.mjs
 * 输出：docs/Test/screenshots/cr058-r5-design/*.png + 断言结果 stdout
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "docs/Test/screenshots/cr058-r5-design";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(p => p.type === "page");
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
  await wait(200);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log("shot", name);
};
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("PASS", name, detail); }
  else { fail++; console.log("FAIL", name, detail); }
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///D:/github/AI_Delelovelop/docs/UI/workbench-v4/index.html" });
await wait(1800);

// 打开设置 → 模型检测页签
await evaluate(`(() => { window.Screens.openSettings("probe"); return true; })()`);
await wait(400);

// SC-01 初始态：20 针清单、无归因面板、结果区待检测
const idle = await evaluate(`(() => {
  const rows = [...document.querySelectorAll(".probe-row .p-code")].map(x => x.textContent);
  const result = document.querySelector(".probe-result");
  return {
    rowCount: rows.length,
    lastCode: rows[rows.length - 1],
    lastName: [...document.querySelectorAll(".probe-row .p-name")].pop()?.childNodes[0]?.textContent || "",
    attrPanel: !!document.querySelector(".probe-attr"),
    resultClass: result ? result.className : null,
    resultHeight: result ? getComputedStyle(result).height : null,
    title: document.querySelector(".probe-head h3")?.textContent || "",
    caption: document.querySelector(".probe-head .caption")?.textContent || ""
  };
})()`);
check("SC-01 二十针清单", idle.rowCount === 20 && idle.lastCode === "P20", JSON.stringify(idle));
check("SC-01 P20 名称", idle.lastName.includes("行为指纹与归因"), idle.lastName);
check("SC-01 初始无归因面板", !idle.attrPanel);
check("SC-01 待检测态", /idle/.test(idle.resultClass || ""), idle.resultClass);
check("SC-01 结果区固定高度 108px", idle.resultHeight === "108px", idle.resultHeight);
check("SC-01 头部文案 19+1", idle.caption.includes("19+1") || idle.caption.includes("20"), idle.caption);
await shot("sc01-idle");

// SC-02 运行中：选 tierflow-lite（downgraded 夹具），启动后抓运行态
await evaluate(`(() => {
  const st = window.Screens.probeState();
  st.providerId = "PRV-01"; st.modelId = "tierflow-lite";
  window.Screens.refreshSettings ? window.Screens.refreshSettings() : window.UI.render();
  return true;
})()`);
await wait(200);
await evaluate(`(() => { window.Screens.probeRun(); return true; })()`);
await wait(1500);
const running = await evaluate(`(() => {
  const result = document.querySelector(".probe-result");
  return {
    cls: result ? result.className : null,
    height: result ? getComputedStyle(result).height : null,
    count: document.querySelector(".probe-count")?.textContent || "",
    attrPanel: !!document.querySelector(".probe-attr"),
    runningDots: document.querySelectorAll(".probe-dot.running").length
  };
})()`);
check("SC-02 运行态进度", /running/.test(running.cls || "") && /\d+\/20/.test(running.count), JSON.stringify(running));
check("SC-02 运行中无归因面板", !running.attrPanel);
check("SC-02 运行态高度不变", running.height === "108px", running.height);
await shot("sc02-running");

// 等完成（20 针 × 280ms + 380ms ≈ 6s）
await wait(6500);
const done = await evaluate(`(() => {
  const attr = document.querySelector(".probe-attr");
  const cands = [...document.querySelectorAll(".probe-attr-cand")].map(x => ({
    rank: x.querySelector(".a-rank")?.textContent,
    name: x.querySelector(".a-name")?.textContent,
    dist: x.querySelector(".a-dist")?.textContent,
    barWidth: x.querySelector(".a-bar-fill")?.style.width
  }));
  const rows = [...document.querySelectorAll(".probe-row .p-code")].map(x => x.textContent);
  const p20note = [...document.querySelectorAll(".probe-row")].pop()?.querySelector(".p-note")?.textContent || "";
  return {
    hasAttr: !!attr,
    consistencyTag: attr?.querySelector(".tag")?.textContent || "",
    claimed: attr?.querySelector(".probe-attr-claimed")?.textContent || "",
    hint: attr?.querySelector(".probe-attr-hint")?.textContent || "",
    cands,
    note: attr?.querySelector(".probe-attr-note")?.textContent || "",
    rowCount: rows.length,
    p20note,
    score: document.querySelector(".probe-score b")?.textContent || "",
    verdict: [...document.querySelectorAll(".probe-tags .tag")].map(x => x.textContent).join("|"),
    resultHeight: getComputedStyle(document.querySelector(".probe-result")).height
  };
})()`);
check("SC-03 完成后归因面板出现", done.hasAttr);
check("SC-03 一致性三态·不一致", done.consistencyTag.includes("不一致"), done.consistencyTag);
check("SC-03 top-3 候选", done.cands.length === 3, JSON.stringify(done.cands.map(c => c.name)));
check("SC-03 首席候选 glm", (done.cands[0]?.name || "").includes("glm-5.3-flash"), done.cands[0]?.name);
check("SC-03 距离标注", done.cands.every(c => /^d=0\.\d\d$/.test(c.dist || "")), done.cands.map(c => c.dist).join(","));
check("SC-03 概率性措辞", done.hint.includes("最像的已知候选") && done.hint.includes("不构成实锤"), done.hint);
check("SC-03 无实锤断言", !/实锤是|确定是|一定是/.test(done.note + done.hint));
check("SC-03 P20 行在列", done.rowCount === 20 && done.p20note.includes("辅助信号不计分"), done.p20note);
check("SC-03 结果区高度仍 108px", done.resultHeight === "108px", done.resultHeight);
check("SC-03 downgraded 分数 32", done.score === "32", done.score);
await shot("sc03-done-mismatch");

// SC-04 历史回看：MP-01（clean，一致态）
await evaluate(`(() => { window.Screens.probePickHistory("MP-01"); return true; })()`);
await wait(300);
const hist = await evaluate(`(() => {
  const attr = document.querySelector(".probe-attr");
  return {
    tag: attr?.querySelector(".tag")?.textContent || "",
    first: attr?.querySelector(".a-name")?.textContent || "",
    score: document.querySelector(".probe-score b")?.textContent || "",
    rowCount: document.querySelectorAll(".probe-row").length
  };
})()`);
check("SC-04 历史回看归因还原·一致", hist.tag.includes("一致") && !hist.tag.includes("不一致"), hist.tag);
check("SC-04 历史候选 tierflow-pro", hist.first.includes("tierflow-pro"), hist.first);
check("SC-04 历史分数 97", hist.score === "97", hist.score);
await shot("sc04-history-match");

// SC-05 库外无法判定：MP-02（localWarn，unknown 空候选）
await evaluate(`(() => { window.Screens.probePickHistory("MP-02"); return true; })()`);
await wait(300);
const unknown = await evaluate(`(() => {
  const attr = document.querySelector(".probe-attr");
  return {
    tag: attr?.querySelector(".tag")?.textContent || "",
    cands: document.querySelectorAll(".probe-attr-cand").length,
    empty: attr?.querySelector(".probe-attr-empty")?.textContent || "",
    p20dot: [...document.querySelectorAll(".probe-row")].pop()?.querySelector(".probe-dot")?.className || ""
  };
})()`);
check("SC-05 无法判定态", unknown.tag.includes("无法判定"), unknown.tag);
check("SC-05 空候选不指认", unknown.cands === 0 && unknown.empty.includes("不指认"), unknown.empty);
check("SC-05 P20 行 na 状态", /na/.test(unknown.p20dot), unknown.p20dot);
await shot("sc05-unknown");

// SC-06 滚动区域：逐针列表 20 行超高，overflow-y:auto（CR-049 由 scrollbar.js 驱动）
const scroll = await evaluate(`(() => {
  const rows = document.querySelector(".probe-rows");
  const cs = getComputedStyle(rows);
  return { overflowY: cs.overflowY, maxHeight: cs.maxHeight, scrollable: rows.scrollHeight > rows.clientHeight, rowH: rows.scrollHeight };
})()`);
check("SC-06 列表可滚动且 auto", scroll.overflowY === "auto" && scroll.scrollable, JSON.stringify(scroll));

console.log(`\nRESULT: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);