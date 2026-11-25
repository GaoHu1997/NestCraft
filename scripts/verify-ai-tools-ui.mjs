// CR-059：前端工具名中文映射验证（AC-STORY-076-08）。
// 直接对 sessionRuntime.ts 的映射表做等价断言（与后端 ai_tools.rs TOOL_LABELS 对齐）。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const runtime = readFileSync(join(root, "src/modules/chat/sessionRuntime.ts"), "utf8");
const rust = readFileSync(join(root, "src-tauri/src/commands/ai_tools.rs"), "utf8");

const tsMap = {};
const tsBlock = /const WORKBENCH_TOOL_LABELS: Record<string, string> = \{([\s\S]*?)\};/m.exec(runtime);
if (!tsBlock) throw new Error("未找到前端 WORKBENCH_TOOL_LABELS 映射表");
for (const line of tsBlock[1].split("\n")) {
  const m = /(\w+):\s*"([^"]+)"/.exec(line.trim());
  if (m) tsMap[m[1]] = m[2];
}

const rsBlock = /pub const TOOL_LABELS: \[\(&str, &str\); TOOL_COUNT\] = \[([\s\S]*?)\];/.exec(rust);
if (!rsBlock) throw new Error("未找到后端 TOOL_LABELS 映射表");
const rsMap = {};
for (const line of rsBlock[1].split("\n")) {
  const m = /\("(\w+)",\s*"([^"]+)"\)/.exec(line.trim());
  if (m) rsMap[m[1]] = m[2];
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `：${detail}`}`);
  if (!ok) failed++;
};

check("映射条数一致（22：14 工作台工具 + 6 原有内置 + ssh 审批查询 + 右栏请求 + 派发工作）",
  Object.keys(tsMap).length === 22 && Object.keys(rsMap).length === 22,
  `前端 ${Object.keys(tsMap).length} / 后端 ${Object.keys(rsMap).length}`);
const mismatch = Object.keys(rsMap).filter((k) => tsMap[k] !== rsMap[k]);
check("前后端映射逐条一致", mismatch.length === 0, mismatch.join(", "));
check("显示名以「工作台·」开头", Object.values(tsMap).every((v) => v.startsWith("工作台·")));
check("create_project 映射正确", tsMap.create_project === "工作台·创建项目");
check("write_requirement_doc 映射正确", tsMap.write_requirement_doc === "工作台·写需求文档");
// BUG-CR059-01：原有 6 项内置工具也必须出现在映射表。
for (const required of ["fs_read", "knowledge_list", "knowledge_search", "knowledge_read", "knowledge_read_many", "ssh_exec", "ssh_exec_status", "open_panel"]) {
  check(`${required} 已映射`, tsMap[required] === rsMap[required] && !!tsMap[required], `前端 ${tsMap[required]} / 后端 ${rsMap[required]}`);
}

console.log(failed === 0 ? "\n全部通过：侧栏工具名中文映射" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
