#!/usr/bin/env node
// BUG-004 契约校验：运行态不派生绑定、首轮失败证据放行重试、运行中禁止重建。
// 只读取源码文本，不启动应用、不连接数据库；结果用于 REPORT-BUG004。
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
const chat = read("src-tauri/src/commands/chat.rs");
const tsx = read("src/modules/chat/ChatPanel.tsx");

// 1. derive_view 接收运行态并在 platform 之后早退
check("derive_view 含 running 参数", /pub fn derive_view\([\s\S]{0,200}running: bool/.test(rs));
check("运行中早退返回 None", /if running \{\s*return None;/.test(rs));
check("platform 早退仍在 running 之前", /runner == "platform"[\s\S]{0,400}if running/.test(rs));

// 2. 首轮失败证据
check("derive_view 识别 CREATE_FAILED", /last_reason == Some\("CREATE_FAILED"\)/.test(rs));
check("failure_turn 写 CREATE_FAILED 证据", /record_turn_row_tx\(&tx, session_id, turn_id, "create", "archived"[\s\S]{0,120}"CREATE_FAILED"\)/.test(chat));
check("resolve_binding 含 create_failed 参数", /pub fn resolve_binding\([\s\S]{0,260}create_failed: bool/.test(rs));
check("create_failed 放行 create", /if create_failed \{\s*return BindingDecision::Send \{ mode: "create", requested: None \};/.test(rs));
check("chat_send 查询 CREATE_FAILED", /CREATE_FAILED/.test(chat) && /create_failed/.test(chat));

// 3. 运行中禁止重建
check("confirm_fresh 检查运行态", /chat_status\(session_id\.to_string\(\)\)[\s\S]{0,120}本轮仍在运行/.test(rs));

// 4. 前端按运行态兜底（复现 ChatPanel 求值表达式）
const bindingOf = (sessionRole, runner, running, binding) =>
  sessionRole === "executor" || runner === "platform" || running ? null : binding ?? null;
check("运行中忽略残留 binding", bindingOf("ordinary", "cli", true, { state: "freshPending" }) === null);
check("非运行 CLI 保留真实 binding", bindingOf("ordinary", "cli", false, { state: "freshPending" })?.state === "freshPending");
check("平台会话忽略残留 binding", bindingOf("ordinary", "platform", false, { state: "freshPending" }) === null);
check("执行会话不派生", bindingOf("executor", "cli", false, { state: "native" }) === null);
check("ChatPanel 求值含 running", /runner === "platform" \|\| running \? null/.test(tsx));

// 5. 既有 BUG-003 行为仍在
check("platform 早退仍在", /runner == "platform"[\s\S]{0,80}return None;/.test(rs));
check("REF_NOT_ESTABLISHED 分支仍在", /REF_NOT_ESTABLISHED/.test(rs));
check("未把 STOPPED 等错误原因放行", !/last_reason == Some\("STOPPED"\)/.test(rs));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
