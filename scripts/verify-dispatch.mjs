/**
 * CLI 派发注入的端到端验证（不依赖 GUI）：
 * 用与后端 dispatch 相同的参数形态真实启动 CLI，断言网关/MCP/Skill 是否真的生效。
 * 运行：node scripts/verify-dispatch.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GW = process.env.GW ?? "http://127.0.0.1:18080";
const GW_KEY = process.env.GW_KEY ?? "gw-test-key-123456";
const results = [];
const ok = (name, detail) => results.push({ name, ok: true, detail });
const bad = (name, detail) => results.push({ name, ok: false, detail });

/** Windows 上 CLI 是 .cmd shim，需要 shell 解析。 */
function run(cmd, args, env, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? cmd + ".cmd" : cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
    });
    child.on("error", (e) => reject(new Error(`spawn ${cmd} 失败：${e.message}`)));
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ out, err, code: null, timeout: true }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ out, err, code, timeout: false }); });
    child.stdin.write("reply with OK only\n");
    child.stdin.end();
  });
}

async function gatewayRecord() {
  const r = await fetch(GW + "/__record");
  return r.json();
}

const work = join(tmpdir(), "aw-verify-" + Date.now());
mkdirSync(join(work, "skills", "demo-skill"), { recursive: true });
writeFileSync(
  join(work, "skills", "demo-skill", "SKILL.md"),
  "---\nname: demo-skill\ndescription: 冒烟验证技能\n---\n# demo-skill\n输出 SKILL-LOADED。\n"
);
const mcpPath = join(work, "mcp.json");
writeFileSync(
  mcpPath,
  JSON.stringify({
    mcpServers: {
      smokemcp: {
        command: "node",
        args: [new URL("../mockbin/mock-mcp.mjs", import.meta.url).pathname.replace(/^\//, "")],
      },
    },
  })
);
const settingsPath = join(work, "settings.json");
writeFileSync(
  settingsPath,
  JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: GW,
      ANTHROPIC_AUTH_TOKEN: GW_KEY,
      ANTHROPIC_MODEL: "mock-model-anthropic",
    },
  })
);

// ---------- 1. claude：供应商 + MCP + Skill 全注入 ----------
{
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "acceptEdits",
    "--model", "mock-model-anthropic",
    "--settings", settingsPath,
    "--strict-mcp-config",
    "--mcp-config", mcpPath,
    "--allowedTools", "mcp__smokemcp",
    "--add-dir", join(work, "skills"),
  ];
  const before = (await gatewayRecord().catch(() => ({ calls: [] }))).calls.length;
  const r = await run("claude", args, { CLAUDE_CONFIG_DIR: work });
  const after = await gatewayRecord().catch(() => ({ calls: [] }));
  const newCalls = after.calls.slice(before);
  const hits = newCalls.filter((c) => c.path.includes("/v1/messages"));
  const init = r.out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((v) => v?.type === "system" && v?.subtype === "init");

  if (hits.length > 0) ok("claude 供应商注入", `网关收到 ${hits.length} 次 /v1/messages，key 校验=${hits.every((h) => h.keyOk)}`);
  else bad("claude 供应商注入", `网关未收到请求；stderr=${r.err.slice(0, 200)}`);

  const mcpConnected = (init?.mcp_servers ?? []).some((s) => s.name === "smokemcp" && s.status === "connected");
  const mcpTools = (init?.tools ?? []).filter((t) => String(t).startsWith("mcp__smokemcp"));
  if (mcpConnected && mcpTools.length >= 2) ok("claude MCP 注入", `已连接，工具=${mcpTools.join(",")}`);
  else bad("claude MCP 注入", `mcp_servers=${JSON.stringify(init?.mcp_servers)} tools=${JSON.stringify(mcpTools)}`);

  const skills = init?.skills ?? [];
  if (skills.includes("demo-skill")) ok("claude Skill 注入", `已加载：${skills.slice(0, 3).join(",")}`);
  else bad("claude Skill 注入", `skills 列表未含 demo-skill：${JSON.stringify(skills.slice(0, 6))}`);

  if (init?.model === "mock-model-anthropic") ok("claude 模型生效", `init.model=${init.model}`);
  else bad("claude 模型生效", `init.model=${init?.model}`);
}

// ---------- 2. codex：-c 覆盖注入 ----------
{
  const builtins = join(process.env.USERPROFILE ?? process.env.HOME ?? work, ".aw-verify-codex-home");
  mkdirSync(builtins, { recursive: true });
  writeFileSync(join(builtins, "config.toml"), "");
  const args = [
    "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
    "-c", 'model="mock-model-openai"',
    "-c", 'model_provider="agent_workbench"',
    "-c", 'model_providers.agent_workbench.name="agent-workbench"',
    "-c", `model_providers.agent_workbench.base_url=${JSON.stringify(GW)}`,
    "-c", 'model_providers.agent_workbench.env_key="AGENT_WORKBENCH_PROVIDER_KEY"',
    "-c", 'model_providers.agent_workbench.wire_api="responses"',
    "-c", 'windows.sandbox="elevated"',
    "-",
  ];
  const before = (await gatewayRecord().catch(() => ({ calls: [] }))).calls.length;
  const r = await run("codex", args, {
    CODEX_HOME: builtins,
    AGENT_WORKBENCH_PROVIDER_KEY: GW_KEY,
    OPENAI_BASE_URL: GW,
    OPENAI_API_KEY: GW_KEY,
  });
  const after = await gatewayRecord().catch(() => ({ calls: [] }));
  const newCalls = after.calls.slice(before);
  const hits = newCalls.filter((c) => c.path.includes("/responses"));
  if (hits.length > 0) ok("codex 供应商注入", `网关收到 ${hits.length} 次 chat/completions，key=${hits.every((h) => h.keyOk)}`);
  else bad("codex 供应商注入", `网关未收到；code=${r.code} stderr=${r.err.slice(0, 300)} stdout=${r.out.slice(0, 200)}`);
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.ok).length;
console.log("\n=== CLI 派发注入验证 ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.detail}`);
console.log(`\n结果：${pass}/${results.length} 通过`);
try { rmSync(work, { recursive: true, force: true }); } catch {}
process.exit(results.every((r) => r.ok) ? 0 : 1);
