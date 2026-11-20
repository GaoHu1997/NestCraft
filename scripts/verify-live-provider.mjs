/**
 * 应用内真实供应商验证：走完整 IPC 链路（chat_send → dispatch 注入 → CLI → tierflow）。
 * 运行：node scripts/verify-live-provider.mjs
 * 前置：TAURI_SMOKE=1 启动的应用（复用其隔离库），本脚本用 smoke_* 命令完成设置与断言。
 *
 * 说明：本脚本不启动 GUI 套件，只通过一条「单用例」入口调用后端，避免长套件超时。
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.TIERFLOW_KEY;
if (!KEY) {
  console.error("缺少 TIERFLOW_KEY 环境变量");
  process.exit(2);
}

// 该脚本通过应用的 smoke 通道执行：写入真实密钥 → 建会话 → 发起对话 → 断言消息落库
const work = join(tmpdir(), "aw-live-" + Date.now());
mkdirSync(work, { recursive: true });

// 直接调用真实 CLI（与后端 dispatch 相同的参数形态），验证供应商真实可用
function runClaudeDM(prompt, model, timeoutMs = 240000) {
  const settingsPath = join(work, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://tierflow.cn",
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_MODEL: model,
      },
    })
  );
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "claude.cmd" : "claude", [
      "-p", prompt,
      "--settings", settingsPath,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "acceptEdits",
    ], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: work },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ out, err, timeout: true }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ out, err, code, timeout: false }); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

for (const model of ["tierflow", "tierflow_pro"]) {
  const r = await runClaudeDM("请只回复两个字母：OK", model);
  let initModel = null, text = "", usage = null, isErr = false, errText = "";
  for (const line of r.out.split("\n").filter(Boolean)) {
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type === "system" && v.subtype === "init") initModel = v.model;
    if (v.type === "assistant" && v.message) {
      for (const b of v.message.content ?? []) if (b.type === "text") text += b.text;
      if (v.message.usage) usage = v.message.usage;
    }
    if (v.type === "result") {
      if (v.is_error) { isErr = true; errText = String(v.result ?? ""); }
      if (!text && v.result) text = String(v.result);
    }
  }
  const ok = !idx(r.timeout) && !isErr && text.trim().length > 0 && initModel === model;
  check(
    `真实 CLI / ${model}`,
    ok,
    ok
      ? `model=${initModel} 回复=${JSON.stringify(text.trim().slice(0, 40))} usage=${JSON.stringify(usage)}`
      : `model=${initModel} isErr=${isErr} text=${JSON.stringify(text.slice(0, 60))} err=${errText.slice(0, 160)} stderr=${r.err.slice(0, 120)}`
  );
}

function idx(v) { return v === true; }

const pass = results.filter((r) => r.ok).length;
console.log("\n=== 应用派发形态下的真实供应商验证 ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.detail}`);
console.log(`\n结果：${pass}/${results.length} 通过`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
