#!/usr/bin/env node
// BUG-003 契约校验：前后端原因码集合一致、前端 binding 求值对平台会话不派生状态。
// 只读取源码文本，不启动应用、不连接数据库；结果用于 REPORT-BUG003。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const rs = read("src-tauri/src/commands/chat_binding.rs");
const tsx = read("src/modules/chat/ChatPanel.tsx");

// 1. 后端原因码（REASON_CODES 数组）
const codesBlock = /pub const REASON_CODES: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rs);
const backendCodes = codesBlock ? [...codesBlock[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]) : [];
check("后端 REASON_CODES 可解析", backendCodes.length >= 10, `${backendCodes.length} 项`);
check("后端包含 REF_NOT_ESTABLISHED", backendCodes.includes("REF_NOT_ESTABLISHED"));

// 2. reason_text 文案映射
const textBlock = /pub fn reason_text[\s\S]*?\n}/.exec(rs);
const textCodes = textBlock ? [...textBlock[0].matchAll(/"([A-Z_]+)" =>/g)].map((m) => m[1]) : [];
const missingText = backendCodes.filter((c) => !textCodes.includes(c));
check("每个原因码都有中文文案", missingText.length === 0, missingText.join(",") || "全覆盖");

// 3. 前端 REASON_TEXT 覆盖后端全部原因码
const reasonBlock = /const REASON_TEXT: Record<string, string> = \{([\s\S]*?)\n\};/.exec(tsx);
const frontCodes = reasonBlock ? [...reasonBlock[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]) : [];
const missingFront = backendCodes.filter((c) => !frontCodes.includes(c));
check("前端原因码与后端一致", missingFront.length === 0, missingFront.length ? `缺 ${missingFront.join(",")}` : `${frontCodes.length} 项一致`);

// 4. 平台会话不派生绑定：复现 ChatPanel 的求值表达式（BUG-004 追加运行态兜底）
const derive = (sessionRole, runner, binding, running = false) =>
  sessionRole === "executor" || runner === "platform" || running ? null : binding ?? null;
check("平台会话忽略残留 binding", derive("ordinary", "platform", { state: "freshPending" }) === null);
check("CLI 会话保留 binding", derive("ordinary", "cli", { state: "freshPending" })?.state === "freshPending");
check("执行会话不派生", derive("executor", "cli", { state: "native" }) === null);
check("运行中会话忽略残留 binding", derive("ordinary", "cli", { state: "freshPending" }, true) === null);

// 5. 后端派生分支存在（文本级证据，不作为功能通过依据）
check("derive_view 含 platform 早退", /runner == "platform"/.test(rs));
check("derive_view 含 REF_NOT_ESTABLISHED 分支", /last_outcome\.is_none\(\)[\s\S]{0,80}REF_NOT_ESTABLISHED/.test(rs));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
