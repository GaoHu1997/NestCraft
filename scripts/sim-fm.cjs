const fs = require("fs");
const path = require("path");
const base = path.join(process.env.APPDATA, "com.agentworkbench.app", "smoke", "proj-demo", "docs", "Plan");
const files = [
  path.join(base, "Vision", "VISION-DEMO.md"),
  path.join(base, "Epic", "EPIC-001-DEMO.md"),
  path.join(base, "Feature", "FEAT-001-DEMO.md"),
  path.join(base, "Story", "STORY-001-DEMO.md"),
];
function parseFM(text) {
  const map = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return map;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  console.log(path.basename(f), JSON.stringify(parseFM(t)), "| head:", JSON.stringify(t.slice(0, 50)));
}
// 模拟 Rust 的 strip_prefix("---\n") 行为：要求紧跟 "---" 后是 \n
const t = fs.readFileSync(files[1], "utf8");
console.log("epic 以 ---\\n 开头？", t.startsWith("---\n"), "| 以 ---\r\n 开头？", t.startsWith("---\r\n"));
