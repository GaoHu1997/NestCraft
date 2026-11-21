// mock claude CLI：按 stream-json 协议输出；--version 返回 mock 版本。
// CR-037：解析 --resume <id>；场景由 MOCK_RESUME 控制（confirm=回显同 id / silent-new=新 id /
// stale=原生报错 exit 1 / refuse=exit 0 但 result.is_error=true）。默认 confirm。
// 仅用于 IPC 冒烟测试（mockbin/），不参与生产逻辑。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("9.9.9-mock");
  process.exit(0);
}
const mode = (process.env.MOCK_RESUME || "confirm").trim().toLowerCase();
const flagIndex = args.indexOf("--resume");
const resumeRef = flagIndex >= 0 ? args[flagIndex + 1] : null;
if (mode === "stale" && resumeRef) {
  console.error("No conversation found with session ID: " + resumeRef);
  process.exit(1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const sid = !resumeRef
  ? "mock-claude-session"
  : mode === "silent-new"
    ? `mock-claude-new-${Math.random().toString(16).slice(2, 10)}`
    : resumeRef;
const lines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: sid }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "你好" },
        { type: "text", text: "，来自 mock claude。" },
        { type: "tool_use", id: "tool-1", name: "fs.read", input: { path: "a.txt" } },
      ],
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    },
    session_id: sid,
  }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "a.txt 的内容" }] } }),
];
if (mode === "refuse" && resumeRef) {
  lines.push(JSON.stringify({
    type: "result",
    result: "resume refused by mock",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    is_error: true,
    session_id: sid,
  }));
} else {
  lines.push(JSON.stringify({
    type: "result",
    result: "你好，来自 mock claude。",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    is_error: false,
    session_id: sid,
  }));
}
process.stdout.write(lines.join("\n") + "\n");
