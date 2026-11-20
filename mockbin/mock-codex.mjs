// mock codex CLI：按 exec --json 事件协议输出。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.9.9-mock");
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "mock-codex-thread" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "思考摘要内容" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex mock 回复" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 4 } }),
];
process.stdout.write(lines.join("\n") + "\n");
