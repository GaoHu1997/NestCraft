// mock claude CLI：按 stream-json 协议输出；--version 返回 mock 版本。
// 仅用于 IPC 冒烟测试（mockbin/），不参与生产逻辑。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("9.9.9-mock");
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const lines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "mock-claude-session" }),
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
    session_id: "mock-claude-session",
  }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "a.txt 的内容" }] } }),
  JSON.stringify({
    type: "result",
    result: "你好，来自 mock claude。",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    session_id: "mock-claude-session",
  }),
];
process.stdout.write(lines.join("\n") + "\n");
