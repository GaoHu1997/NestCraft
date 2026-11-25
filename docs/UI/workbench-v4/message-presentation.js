"use strict";
var MessagePresentation = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/modules/chat/messagePresentation.ts
  var messagePresentation_exports = {};
  __export(messagePresentation_exports, {
    changedInputPaths: () => changedInputPaths,
    classifyTool: () => classifyTool,
    formatMessageDuration: () => formatMessageDuration,
    normalizeMessagePath: () => normalizeMessagePath,
    presentAgent: () => presentAgent,
    presentToolInput: () => presentToolInput,
    summarizeTools: () => summarizeTools,
    toolFailed: () => toolFailed,
    workDurationMs: () => workDurationMs
  });
  var EXPLORE = /* @__PURE__ */ new Set(["read", "readfile", "readtextfile", "fileread", "grep", "glob", "search", "websearch", "webfetch", "fetch", "listdir", "listdirectory", "listfiles"]);
  var RUN = /* @__PURE__ */ new Set(["bash", "shell", "command", "commandexecution", "executecommand", "execcommand", "runshellcommand", "shellcommand", "pwsh", "powershell"]);
  var CHANGE = /* @__PURE__ */ new Set(["write", "writefile", "filewrite", "edit", "editfile", "fileedit", "applypatch", "patch"]);
  function classifyTool(name) {
    const identity = (name ?? "").split(/__|[./:]/).pop().replace(/[-_\s]/g, "").toLowerCase();
    return EXPLORE.has(identity) ? "explore" : RUN.has(identity) ? "run" : CHANGE.has(identity) ? "change" : null;
  }
  function toolFailed(item) {
    return item.pair.result?.isError === true || item.pair.resultMsg?.exitCode != null && item.pair.resultMsg.exitCode !== 0 || !item.pair.result && item.pair.useMsg?.exitCode != null && item.pair.useMsg.exitCode !== 0;
  }
  function presentToolInput(raw) {
    if (raw === null) return { inputText: null, command: null, parametersText: null };
    try {
      const value = JSON.parse(raw);
      const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
      const command = typeof object?.command === "string" ? object.command : null;
      return {
        inputText: JSON.stringify(value, null, 2),
        command,
        parametersText: command !== null && object ? JSON.stringify(Object.fromEntries(Object.entries(object).filter(([key]) => key !== "command")), null, 2) : null
      };
    } catch {
      return { inputText: raw, command: null, parametersText: null };
    }
  }
  function normalizeMessagePath(path) {
    const slashed = path.trim().replace(/\\/g, "/");
    const root = slashed.match(/^[A-Za-z]:\//)?.[0] ?? (slashed.startsWith("//") ? slashed.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//" : slashed.startsWith("/") ? "/" : "");
    const parts = [];
    for (const part of slashed.slice(root.length).split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (part !== ".." || !root) parts.push(part);
    }
    return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
  }
  function changedInputPaths(raw) {
    if (raw === null) return [];
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      input = raw;
    }
    const paths = /* @__PURE__ */ new Set();
    const add = (value) => {
      if (typeof value === "string" && value.trim()) paths.add(normalizeMessagePath(value));
    };
    const visit = (value) => {
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
  function summarizeTools(items) {
    const calls = /* @__PURE__ */ new Map();
    const results = /* @__PURE__ */ new Set();
    for (const item of items) {
      if (item.part !== "result") calls.set(item.pair.toolId, item);
      else results.add(item.pair.toolId);
    }
    for (const id of calls.keys()) results.delete(id);
    let explore = 0, run = 0, unresolved = 0, unknown = 0;
    const files = /* @__PURE__ */ new Set();
    let category = null;
    const failed = items.some(toolFailed);
    const settled = [...calls.values()].every((item) => item.pair.result !== null && !toolFailed(item));
    for (const item of calls.values()) {
      const kind = classifyTool(item.pair.name);
      if (kind === "change") {
        category = "change";
        const paths = changedInputPaths(item.pair.inputJson);
        if (!paths.length) unresolved++;
        paths.forEach((path) => files.add(path));
      } else if (kind === "run") {
        run++;
        if (category !== "change") category = "run";
      } else if (kind === "explore") {
        explore++;
        if (category === null) category = "explore";
      } else unknown++;
    }
    if (!category) {
      const categories = items.map((item) => classifyTool(item.pair.name));
      category = categories.includes("change") ? "change" : categories.includes("run") ? "run" : categories.includes("explore") ? "explore" : null;
    }
    const parts = [];
    if (explore) parts.push(`${settled ? "\u5DF2\u67E5\u9605" : "\u67E5\u9605"} ${explore} \u9879`);
    if (run) parts.push(`${settled ? "\u5DF2\u6267\u884C" : "\u6267\u884C"} ${run} \u547D\u4EE4`);
    if (files.size) parts.push(settled ? `\u5DF2\u4FEE\u6539 ${files.size} \u6587\u4EF6` : `\u4FEE\u6539\u6D89\u53CA ${files.size} \u6587\u4EF6`);
    if (unresolved) parts.push(`\u4FEE\u6539\u64CD\u4F5C ${unresolved} \u9879`);
    if (unknown) parts.push(`\u5DE5\u5177\u8BB0\u5F55 ${unknown} \u9879`);
    if (results.size) parts.push(`\u5DF2\u8FD4\u56DE ${results.size} \u9879\u7ED3\u679C`);
    if (failed) parts.push("\u6709\u5931\u8D25");
    return { text: parts.join("\uFF0C") || `\u5DE5\u5177\u8BB0\u5F55 ${items.length} \u9879`, category, failed };
  }
  function workDurationMs(start, end) {
    return start != null && end != null && Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  }
  function formatMessageDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1e3));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return `${hours ? `${hours} \u5C0F\u65F6 ` : ""}${hours || minutes ? `${minutes} \u5206 ` : ""}${seconds % 60} \u79D2`;
  }
  function presentAgent(sourceLabel) {
    const source = sourceLabel ?? "";
    const type = /\bExplore\b/i.test(source) ? "Explore" : "\u5B50\u667A\u80FD\u4F53";
    const statuses = /* @__PURE__ */ new Set();
    if (/(?:等待中|待处理|等待|\bwaiting\b|\bpending\b|\bqueued\b)/i.test(source)) statuses.add("\u7B49\u5F85\u4E2D");
    if (/(?:执行中|进行中|运行中|\brunning\b|\bin_progress\b)/i.test(source)) statuses.add("\u8FD0\u884C\u4E2D");
    if (/(?:已完成|\bcompleted\b|\bdone\b)/i.test(source)) statuses.add("\u5DF2\u5B8C\u6210");
    if (/(?:失败|\bfailed\b|\berror\b)/i.test(source)) statuses.add("\u5931\u8D25");
    if (/(?:已停止|\bstopped\b|\bcancelled\b|\bcanceled\b)/i.test(source)) statuses.add("\u5DF2\u505C\u6B62");
    return { type, status: statuses.size === 1 ? [...statuses][0] : "\u72B6\u6001\u672A\u77E5" };
  }
  return __toCommonJS(messagePresentation_exports);
})();
