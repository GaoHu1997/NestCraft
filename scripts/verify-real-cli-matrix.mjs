/**
 * 真实 CLI × tierflow 三协议验证：claude(anthropic) / codex(openai) / grok(openai)。
 *
 * 参数形态与后端 dispatch.rs 的注入一致：
 * - claude：--settings 的 env 段（claude 不读进程环境 ANTHROPIC_BASE_URL）
 * - codex：model_providers 配置项 + OPENAI_* 环境变量
 * - grok：OpenAI 兼容端点 + OPENAI_* 环境变量
 *
 * 运行：TIERFLOW_KEY=... node scripts/verify-real-cli-matrix.mjs
 * 本脚本不发仓库外请求，只按调用方提供的密钥访问指定网关。
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.TIERFLOW_KEY;
if (!KEY) {
  console.error("缺少 TIERFLOW_KEY");
  process.exit(2);
}
const BASE = process.env.TIERFLOW_BASE || "https://tierflow.cn";
const work = join(tmpdir(), "aw-realcli-" + Date.now());
mkdirSync(work, { recursive: true });
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}, timeoutMs = 180000, stdinText = null) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
      shell: isWin,
    });
    if (stdinText !== null && child.stdin) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      try {
        // 整树停止意图：Windows 用 taskkill /T 覆盖子进程
        if (isWin) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
        else child.kill("SIGKILL");
      } catch {}
      resolve({ out, err, code: null, timeout: true });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code, timeout: false });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out, err: String(e), code: null, timeout: false, spawnError: true });
    });
  });
}

const results = [];
const record = (cli, name, ok, detail) => results.push({ cli, name, ok, detail: detail.slice(0, 300) });

/* ---------- claude：--settings env 段 ---------- */
async function testClaude() {
  const settings = join(work, "claude-settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: "tierflow" },
    })
  );
  const r = await run("claude", [
    "-p", "请只回复两个字母：OK",
    "--settings", settings,
    "--model", "tierflow",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "acceptEdits",
  ], { env: { ...process.env, CLAUDE_CONFIG_DIR: work } });

  let model = null,
    text = "",
    usage = null;
  for (const line of r.out.split("\n").filter(Boolean)) {
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type === "system" && v.subtype === "init") model = v.model;
    if (v.type === "assistant" && v.message?.content) {
      for (const c of v.message.content) if (c.type === "text") text += c.text;
    }
    if (v.type === "result" && v.usage) usage = v.usage;
  }
  const ok = /OK/i.test(text) && !/来自 mock claude/.test(text) && !!model;
  record("claude", "真实调用返回模型回复", ok,
    ok ? `model=${model} 回复=${JSON.stringify(text.trim().slice(0, 40))} tokens=${usage?.input_tokens ?? "?"}`
       : `model=${model} 回复=${JSON.stringify(text.slice(0, 80))} err=${r.err.slice(0, 120)} code=${r.code}`);
}

/* ---------- codex：model_providers 配置 ---------- */
async function testCodex() {
  // CODEX_HOME 不能落在系统临时目录：codex 拒绝在临时目录创建 PATH 助手二进制。
  // 用工作区下的独立目录，避免触碰用户真实的 ~/.codex。
  const home = join(process.cwd(), ".tmp-realcli", "codex-home");
  mkdirSync(home, { recursive: true });
  // 实测：codex 自己拼接 /responses，base_url 必须带 /v1；不带时网关回 405。
  const cfg = [
    `model = "tierflow"`,
    `model_provider = "aw_tierflow"`,
    ``,
    `[model_providers.aw_tierflow]`,
    `name = "tierflow"`,
    `base_url = "${BASE}/v1"`,
    `env_key = "OPENAI_API_KEY"`,
    ``,
  ].join("\n");
  writeFileSync(join(home, "config.toml"), cfg);

  const r = await run(
    "codex",
    ["exec", "--skip-git-repo-check", "-"],
    {
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: KEY },
      cwd: work,
    },
    120000,
    "请只回复两个字母：OK"
  );
  const text = (r.out || "").trim();
  const ok = /OK/i.test(text) && !r.timeout && !/来自 mock/i.test(text);
  record("codex", "真实调用返回模型回复", ok,
    ok ? `回复=${JSON.stringify(text.slice(-40))}` : `code=${r.code} err=${r.err.slice(0, 200)}`);
}

/* ---------- grok：xAI 兼容端点 ---------- */
async function testGrok() {
  // 实测（grok 1.0.77）：
  // - 端点变量是 GROK_XAI_API_BASE_URL（不读 OPENAI_BASE_URL）；
  // - base 必须带 /v1（CLI 自己拼 /chat/completions，不带时网关 405）；
  // - 提示词走 stdin（`grok -p -`），比 argv 免引号转义；
  // - GROK_NO_AUTO_UPDATE=1 避免更新横幅挂住 headless 运行。
  // 依据：docs/参考/repos/dsh-maestro-codex/src/channels/grok.ts 的 grokEnv/grokArgs。
  const r = await run(
    "grok",
    ["-p", "-", "--output-format", "plain"],
    {
      env: {
        ...process.env,
        OPENAI_BASE_URL: "",
        OPENAI_API_KEY: "",
        XAI_API_KEY: KEY,
        GROK_XAI_API_BASE_URL: `${BASE}/v1`,
        GROK_NO_AUTO_UPDATE: "1",
      },
      cwd: work,
    },
    120000,
    "请只回复两个字母：OK"
  );
  const text = (r.out || "").trim();
  const ok = /OK/i.test(text) && !r.timeout;
  record("grok", "真实调用返回模型回复", ok,
    ok ? `回复=${JSON.stringify(text.slice(-40))}`
       : `code=${r.code} timeout=${r.timeout} err=${r.err.slice(0, 200)} out=${text.slice(-100)}`);
}

await testClaude();
await testCodex();
await testGrok();

console.log("\n=== 真实 CLI × tierflow 矩阵 ===");
for (const x of results) {
  console.log(`${x.ok ? "PASS" : "FAIL"} | ${x.cli} | ${x.name} | ${x.detail}`);
}
const pass = results.filter((x) => x.ok).length;
console.log(`\n结果：${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
