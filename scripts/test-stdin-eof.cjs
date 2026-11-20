// 验证：.cmd 批处理 + 管道 stdin + end 后，node 子进程能否收到 EOF
const { spawn } = require("child_process");
const cmdPath = String.raw`D:\github\AI_Delelovelop\mockbin\claude.cmd`;
const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"];
// node 会自行处理 .cmd 的 cmd.exe 转发与参数转义
const child = spawn(cmdPath, args, { stdio: ["pipe", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.on("close", (code) => {
  console.log("exit:", code);
  console.log("stdout 行数:", out.trim() ? out.trim().split("\n").length : 0, "前 200:", out.slice(0, 200));
  console.log("stderr 前 200:", err.slice(0, 200));
  process.exit(0);
});
child.stdin.write("你好\n");
child.stdin.end();
setTimeout(() => {
  console.log("6s 无退出。stdout 长度:", out.length, "stderr:", err.slice(0, 200));
  console.log("=> 复现挂起：stdin EOF 未传导或 node 未启动");
  child.kill();
  process.exit(2);
}, 6000);
