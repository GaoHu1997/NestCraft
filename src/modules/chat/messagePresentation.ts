/*
 * Conversation presentation adapted from ZCode (Copyright 2026 Z.AI Co., Ltd),
 * Apache-2.0. See message-zcode.LICENSE and message-zcode.NOTICE.
 * Modified for NestCraft: explicit tool-name mapping, call/result chronology,
 * truthful partial/failure statistics, input-only paths and source-only status.
 */

export type ToolCategory = "explore" | "run" | "change" | null;
export interface PresentationTool {
  part: "call" | "result" | "both";
  pair: {
    toolId: string;
    name: string | null;
    inputJson: string | null;
    result: { content: string; isError: boolean } | null;
    useMsg: { streaming?: boolean; exitCode?: number | null } | null;
    resultMsg: { exitCode?: number | null } | null;
  };
}

const EXPLORE = new Set(["read", "readfile", "readtextfile", "fileread", "grep", "glob", "search", "websearch", "webfetch", "fetch", "listdir", "listdirectory", "listfiles"]);
const RUN = new Set(["bash", "shell", "command", "commandexecution", "executecommand", "execcommand", "runshellcommand", "shellcommand", "pwsh", "powershell"]);
const CHANGE = new Set(["write", "writefile", "filewrite", "edit", "editfile", "fileedit", "applypatch", "patch"]);

/** Only known identities classify; an unknown custom tool is not a read or edit. */
export function classifyTool(name: string | null): ToolCategory {
  const identity = (name ?? "").split(/__|[./:]/).pop()!.replace(/[-_\s]/g, "").toLowerCase();
  return EXPLORE.has(identity) ? "explore" : RUN.has(identity) ? "run" : CHANGE.has(identity) ? "change" : null;
}

export function toolFailed(item: PresentationTool): boolean {
  return item.pair.result?.isError === true || (item.pair.resultMsg?.exitCode != null && item.pair.resultMsg.exitCode !== 0) || (!item.pair.result && item.pair.useMsg?.exitCode != null && item.pair.useMsg.exitCode !== 0);
}

export function presentToolInput(raw: string | null): { inputText: string | null; command: string | null; parametersText: string | null } {
  if (raw === null) return { inputText: null, command: null, parametersText: null };
  try {
    const value: unknown = JSON.parse(raw);
    const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const command = typeof object?.command === "string" ? object.command : null;
    return {
      inputText: JSON.stringify(value, null, 2),
      command,
      parametersText: command !== null && object ? JSON.stringify(Object.fromEntries(Object.entries(object).filter(([key]) => key !== "command")), null, 2) : null,
    };
  } catch {
    return { inputText: raw, command: null, parametersText: null };
  }
}

/** Lexical normalization only: does not read the filesystem or invent a cwd. */
export function normalizeMessagePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  const root = slashed.match(/^[A-Za-z]:\//)?.[0] ?? (slashed.startsWith("//") ? slashed.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//" : slashed.startsWith("/") ? "/" : "");
  const parts: string[] = [];
  for (const part of slashed.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
}

/** Read only explicit file-path fields or patch headers, never output prose. */
export function changedInputPaths(raw: string | null): string[] {
  if (raw === null) return [];
  let input: unknown;
  try { input = JSON.parse(raw); } catch { input = raw; }
  const paths = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) paths.add(normalizeMessagePath(value)); };
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[1]);
      for (const match of value.matchAll(/^\*\*\* Move to: (.+)$/gm)) add(match[1]);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:file_path|filepath|filePath|path|target_file|targetFile)$/i.test(key)) add(child);
        else if (/^(?:files|edits|changes|patch|input|patch_text)$/i.test(key)) visit(child);
      }
    }
  };
  visit(input);
  return [...paths];
}

export function summarizeTools(items: readonly PresentationTool[]): { text: string; category: ToolCategory; failed: boolean } {
  const calls = new Map<string, PresentationTool>();
  const results = new Set<string>();
  for (const item of items) {
    if (item.part !== "result") calls.set(item.pair.toolId, item);
    else results.add(item.pair.toolId);
  }
  // Results whose call was shown earlier must not be counted as new commands.
  for (const id of calls.keys()) results.delete(id);
  let explore = 0, run = 0, unresolved = 0, unknown = 0;
  const files = new Set<string>();
  let category: ToolCategory = null;
  const failed = items.some(toolFailed);
  const settled = [...calls.values()].every(item => item.pair.result !== null && !toolFailed(item));
  for (const item of calls.values()) {
    const kind = classifyTool(item.pair.name);
    if (kind === "change") {
      category = "change";
      const paths = changedInputPaths(item.pair.inputJson);
      if (!paths.length) unresolved++;
      paths.forEach(path => files.add(path));
    } else if (kind === "run") { run++; if (category !== "change") category = "run"; }
    else if (kind === "explore") { explore++; if (category === null) category = "explore"; }
    else unknown++;
  }
  if (!category) {
    const categories = items.map(item => classifyTool(item.pair.name));
    category = categories.includes("change") ? "change" : categories.includes("run") ? "run" : categories.includes("explore") ? "explore" : null;
  }
  const parts: string[] = [];
  if (explore) parts.push(`${settled ? "已查阅" : "查阅"} ${explore} 项`);
  if (run) parts.push(`${settled ? "已执行" : "执行"} ${run} 命令`);
  if (files.size) parts.push(settled ? `已修改 ${files.size} 文件` : `修改涉及 ${files.size} 文件`);
  if (unresolved) parts.push(`修改操作 ${unresolved} 项`);
  if (unknown) parts.push(`工具记录 ${unknown} 项`);
  if (results.size) parts.push(`已返回 ${results.size} 项结果`);
  if (failed) parts.push("有失败");
  return { text: parts.join("，") || `工具记录 ${items.length} 项`, category, failed };
}

export function workDurationMs(start?: number, end?: number): number | null {
  return start != null && end != null && Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function formatMessageDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours} 小时 ` : ""}${hours || minutes ? `${minutes} 分 ` : ""}${seconds % 60} 秒`;
}

export function presentAgent(sourceLabel?: string | null): { type: "Explore" | "子智能体"; status: string } {
  const source = sourceLabel ?? "";
  const type = /\bExplore\b/i.test(source) ? "Explore" : "子智能体";
  // Unreported lifecycle values stay unknown; streaming/output is not completion.
  const statuses = new Set<string>();
  if (/(?:等待中|待处理|等待|\bwaiting\b|\bpending\b|\bqueued\b)/i.test(source)) statuses.add("等待中");
  if (/(?:执行中|进行中|运行中|\brunning\b|\bin_progress\b)/i.test(source)) statuses.add("运行中");
  if (/(?:已完成|\bcompleted\b|\bdone\b)/i.test(source)) statuses.add("已完成");
  if (/(?:失败|\bfailed\b|\berror\b)/i.test(source)) statuses.add("失败");
  if (/(?:已停止|\bstopped\b|\bcancelled\b|\bcanceled\b)/i.test(source)) statuses.add("已停止");
  return { type, status: statuses.size === 1 ? [...statuses][0] : "状态未知" };
}
