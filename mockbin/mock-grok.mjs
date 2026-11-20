// mock grok CLI：通用 --print --json 回退路径。
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.1.2-mock");
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ text: "grok 通用回退回复" }) + "\n");
