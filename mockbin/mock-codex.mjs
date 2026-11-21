// mock codex CLI：按 exec --json 事件协议输出。
// CR-037：解析 exec resume <id> 子命令；场景由 MOCK_RESUME 控制（confirm=回显同 id /
// silent-new=新线程 / stale=no rollout exit 1 / refuse=exit 0 无 thread.started）。默认 confirm。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.9.9-mock");
  process.exit(0);
}
const mode = (process.env.MOCK_RESUME || "confirm").trim().toLowerCase();
const resumeIndex = args.indexOf("resume");
const resumeRef =
  resumeIndex >= 0 && args[resumeIndex + 1] && !args[resumeIndex + 1].startsWith("-") ? args[resumeIndex + 1] : null;
if (mode === "stale" && resumeRef) {
  console.error("ERROR: no rollout found for thread id " + resumeRef);
  process.exit(1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (mode === "refuse" && resumeRef) {
  const refused = [
    JSON.stringify({ type: "error", message: "resume refused by mock" }),
    JSON.stringify({ type: "turn.failed" }),
  ];
  process.stdout.write(refused.join("\n") + "\n");
  process.exit(0);
}
const threadId = !resumeRef
  ? "mock-codex-thread"
  : mode === "silent-new"
    ? `mock-codex-new-${Math.random().toString(16).slice(2, 10)}`
    : resumeRef;
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: threadId }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "思考摘要内容" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex mock 回复" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 4 } }),
];
process.stdout.write(lines.join("\n") + "\n");
