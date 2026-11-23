// CR-059：内置 AI 工具集 —— MCP stdio 服务器进程级验证（AC-STORY-076-02）。
// 用真实二进制（--app-mcp-stdio --app-data-dir <tmp>）跑 initialize → tools/list →
// tools/call(create_project) → tools/call(get_requirements→write_requirement_doc) →
// tools/call(list_projects) → ping，断言全链路。用法：node scripts/verify-ai-tools.mjs <exe路径>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("用法：node scripts/verify-ai-tools.mjs <agent-workbench.exe 路径>");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "ai-tools-verify-"));
const projectDir = join(dataDir, "demo-root");
mkdirSync(projectDir, { recursive: true });

const child = spawn(exe, ["--app-mcp-stdio", "--app-data-dir", dataDir], {
  stdio: ["pipe", "pipe", "pipe"],
});
let pending = "";
const replies = new Map();
child.stdout.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  let idx;
  while ((idx = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, idx).trim();
    pending = pending.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null) replies.set(msg.id, msg);
  }
});
let stderrBuf = "";
child.stderr.on("data", (c) => { stderrBuf += c.toString(); });

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时：${method}`)), 15000);
    const wait = setInterval(() => {
      if (replies.has(id)) {
        clearInterval(wait);
        clearTimeout(timer);
        resolve(replies.get(id));
      }
    }, 20);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function callTool(name, args) {
  return request("tools/call", { name, arguments: args }).then((resp) => {
    const result = resp.result;
    if (!result) throw new Error(`tools/call ${name} 无 result：${JSON.stringify(resp)}`);
    const text = result.content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { isError: result.isError === true, value: parsed };
  });
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `：${detail}`}`);
  if (!ok) failed++;
}

try {
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } });
  check("initialize 回显协议版本", init.result?.protocolVersion === "2025-06-18", JSON.stringify(init));
  check("serverInfo.name=workbench", init.result?.serverInfo?.name === "workbench");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list 含 12 个工具", names.length === 12, `实际 ${names.length}: ${names.join(",")}`);
  check("tools/list 元素带 inputSchema", (list.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"));

  const ping = await request("ping", {});
  check("ping 返回空结果", ping.result != null);

  const created = await callTool("create_project", { name: "验证项目", kind: "code", rootUri: projectDir });
  check("create_project 成功", !created.isError && !!created.value?.projectId, JSON.stringify(created.value));

  const projectId = created.value?.projectId;
  const listed = await callTool("list_projects", {});
  check("list_projects 含新项目", !listed.isError && listed.value?.projects?.some((p) => p.id === projectId));

  const ctx = await callTool("get_context", {});
  check("get_context 未绑定项目时提示", !ctx.isError && ctx.value?.projectId === null);

  const epic = await callTool("write_requirement_doc", { kind: "epic", title: "验证史诗", content: "验证内容", projectId });
  check("write_requirement_doc 自动编号 EPIC-001", !epic.isError && epic.value?.entityId === "EPIC-001", JSON.stringify(epic.value));

  const story = await callTool("write_requirement_doc", { kind: "story", title: "验证故事", parentEntityId: epic.value?.entityId, projectId });
  check("write_requirement_doc 父项下 STORY-001", !story.isError && story.value?.entityId === "STORY-001", JSON.stringify(story.value));

  const reqs = await callTool("get_requirements", { projectId });
  const epicNode = (reqs.value?.requirements ?? []).find((n) => n.entityId === "EPIC-001");
  check("get_requirements 读回新节点", !reqs.isError && !!epicNode && epicNode.children?.some((c) => c.entityId === "STORY-001"));

  const dup = await callTool("create_project", { name: "验证项目", kind: "code", rootUri: projectDir });
  check("重名项目被拒绝（isError）", dup.isError, JSON.stringify(dup.value));

  const unknown = await callTool("delete_project", {});
  check("未知/未提供工具被拒绝", unknown.isError);

  const badArgs = await callTool("save_server", { name: "", host: "", port: 0, username: "", authType: "x" });
  check("非法参数被拒绝（isError）", badArgs.isError);
} catch (e) {
  failed++;
  console.error("FAIL 异常：", e?.message ?? e);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  try { child.kill(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

if (stderrBuf.trim()) console.log("（stderr 日志）", stderrBuf.trim().split("\n").slice(0, 3).join(" | "));
console.log(failed === 0 ? "\n全部通过：内置 MCP 工具集进程级验证" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
