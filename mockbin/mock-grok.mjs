// mock grok CLI：对齐产品代码的 `--output-format streaming-json` 帧协议
// （CR-064/BUG-002 后产品不再走通用 {text:...} 回退，mock 必须输出真实帧结构）。
// 帧：{"type":"text","data":...} / {"type":"thought","data":...} /
//     {"type":"usage","usage":{...}} / {"type":"end","stopReason":"end_turn"}。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.1.2-mock");
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
// 流式输出三帧：thinking + delta + end（与真实 grok streaming-json 同构）。
process.stdout.write(JSON.stringify({ type: "thought", data: "grok 思考中" }) + "\n");
process.stdout.write(JSON.stringify({ type: "text", data: "grok streaming 回复" }) + "\n");
process.stdout.write(JSON.stringify({ type: "usage", usage: { input_tokens: 11, output_tokens: 7 } }) + "\n");
process.stdout.write(JSON.stringify({ type: "end", stopReason: "end_turn" }) + "\n");
