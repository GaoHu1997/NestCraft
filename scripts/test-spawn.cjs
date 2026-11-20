// 决定性测试：模拟 chat 后端的 spawn 方式（cmd.exe /d /s /c + 管道 stdin + shutdown）
const { spawn } = require("child_process");
const path = String.raw`D:\github\AI_Delelovelop\mockbin\claude.cmd`;
const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"];
const cmdline = `"${path}" ` + args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
console.log("cmdline:", cmdline);
const child = spawn("cmd.exe", ["/d", "/s", "/c", cmdline], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += "[ERR]" + d));
child.on("close", (code) => {
  console.log("exit:", code);
  console.log("输出前 3 行:", out.trim().split("\n").slice(0, 3).join("\n").slice(0, 300));
  process.exit(0);
});
child.stdin.write("你好\n", () => {
  child.stdin.end();
});
setTimeout(() => {
  console.log("5s 输出长度:", out.length);
  if (out.length === 0) {
    console.log("复现挂起：mock 未收到 stdin EOF 或未输出");
  }
  process.exit(2);
}, 5000);
