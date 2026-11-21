/**
 * BUG-013：仅由 main 在显式 ?preview=design 下、createRoot 前安装的隔离夹具。
 * 本文件的唯一数据来源是公开 workbench-v4 的合成设计样例；不是实测记录。
 * 无 fetch、真实磁盘、存储、CLI、SSH、Git 或模型调用，关闭页面即丢弃全部修改。
 * 主入口/API/设计资源由其负责人维护；本文件不自动启动，也不读取应用数据。
 */
import type {
  Project, RequirementNode, RequirementSources, FileNode, SearchHit, Provider, ProviderDraft, ModelConfig,
  ModelCandidate, DiscoveredModel, SdkState, SdkJob, SkillEntry, McpServer, McpToolInfo,
  ToolEntry, SessionMeta, ChatMessage, ChatEvent, ContextRef, ServerHost, HostMetrics,
  ExecResult, KnowledgeLibrary, NoteNode, NoteContent, KnowledgeFileInfo, KnowledgeFileData,
  KnowledgeUploadResult, KnowledgeHit, LibraryGrant,
  GitStatus, GitChange, BranchEntry, CommitEntry, CommitFileEntry,
} from "../api/index";
import { PROJECT_ICON_IDS, KB_ICON_IDS, ICON_COLORS } from "@/components/icon-tiles";
import type { DocBlock, OfficeFile, OfficeProjectState } from "../modules/office/office-model";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown | Promise<unknown>;
type PreviewWindow = Window & { __DESIGN_PREVIEW__?: boolean };
type Internals = {
  invoke: (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;
  runCallback: (id: number, data: unknown) => void;
  callbacks: Map<number, unknown>;
  convertFileSrc: (path: string, protocol?: string) => string;
};

const STAMP = Date.UTC(2026, 10, 20, 6, 32);
const LABEL = "合成设计夹具 · 未执行真实操作";
const MASK = "mock-****（不可执行）";
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=";
const MAX_TEXT = 1_000_000;
const calls = new Map<string, number>();
let installed: Internals | null = null;
let installing: Promise<void> | null = null;

/** 只返回命令计数的副本，不记录参数、正文、密钥或用户输入。包括未知命令。 */
export function getPreviewCalls(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries([...calls.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

function fail(message: string): never { throw new Error(`[DESIGN_PREVIEW] ${message}`); }
function object(value: unknown, label = "参数"): Args {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) fail(`${label}必须为对象`);
  return value as Args;
}
function text(value: unknown, label: string, empty = false, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) fail(`${label}为空、类型错误或超过长度限制`);
  return value;
}
function str(args: Args, key: string, empty = false): string { return text(args[key], key, empty); }
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label}必须为布尔值`);
  return value;
}
function integer(value: unknown, fallback: number, min = 0, max = 1000): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail("数字参数超出夹具限制");
  return value;
}
function array(value: unknown, label: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须为有界数组`);
  return value;
}
function strings(value: unknown, label: string): string[] { return array(value, label).map(v => text(v, label)); }
function copy<T>(value: T): T { return structuredClone(value); }
function keyOf(value: string): string { return value.trim().normalize("NFC").toLowerCase(); }
function name(value: unknown, capability = false): string {
  const s = text(value, "名称", false, 100).normalize("NFC");
  if (/[.\s]$/.test(s) || /[\\/:*?"<>|\u0000-\u001f]/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) || [".", ".."].includes(s.trim())) fail("名称包含非法字符、尾空格或保留名");
  const result = s.trimStart();
  if (capability && !/^[A-Za-z0-9_-]{1,32}$/.test(result)) fail("能力名称只允许 1–32 位英文、数字、下划线和短横线");
  return result;
}
function unique<T>(items: T[], next: string, getName: (item: T) => string, except?: T): void {
  if (items.some(item => item !== except && keyOf(getName(item)) === keyOf(next))) fail("同名条目已存在；夹具拒绝覆盖");
}
function lookup<T>(items: T[], id: string, getId: (item: T) => string, label: string): T {
  const item = items.find(x => getId(x) === id);
  if (!item) fail(`${label}不存在或不属于当前作用域`);
  return item;
}
/** 明确拒绝磁盘路径、URL、NUL 和 traversal；只允许 /demo 下的规范绝对路径。 */
function absolute(raw: unknown): string {
  const p = text(raw, "演示路径", false, 500).normalize("NFC").replace(/\\/g, "/");
  if (!p.startsWith("/demo/") || /[:\u0000-\u001f]/.test(p) || p.split("/").includes("..")) fail("只允许 /demo/... 内存路径，拒绝真实路径和目录逃逸");
  return p.split("/").filter((part, i) => i === 0 || (part && part !== ".")).join("/").replace(/\/$/, "");
}
function within(root: string, raw: unknown, allowRoot = false): string {
  const p = text(raw, "path", true, 500).replace(/\\/g, "/");
  if (p.split("/").includes("..")) fail("拒绝跨目录路径");
  const full = absolute(p.startsWith("/") ? p : `${root}/${p}`);
  if (full !== root && !full.startsWith(`${root}/`)) fail("路径不属于当前项目或知识库");
  if (full === root && !allowRoot) fail("不能将目录根当作文件");
  return full === root ? "" : full.slice(root.length + 1);
}
function demoUrl(value: unknown): string {
  const raw = text(value, "演示端点", false, 500);
  let url: URL;
  try { url = new URL(raw); } catch { return fail("端点必须为演示 HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.endsWith(".invalid") || url.username || url.password || url.search || url.hash) fail("仅接受 *.invalid 演示域，无认证参数；不会连接任何端点");
  return url.href.replace(/\/$/, "");
}
function json(value: unknown, label: string): Args {
  if (value == null || value === "") return {};
  try { return object(JSON.parse(text(value, label)), label); } catch { return fail(`${label}不是有效 JSON 对象`); }
}
function safeSetting(key: string, value: string): string {
  return /secret|token|password|credential|api.?key/i.test(key) ? MASK : value;
}

interface Disk { files: Map<string, string>; dirs: Set<string> }
function disk(): Disk { return { files: new Map(), dirs: new Set([""]) }; }
function put(d: Disk, path: string, content: string): void {
  if (d.dirs.has(path)) fail("同名目录已存在");
  const parts = path.split("/"); parts.pop();
  while (parts.length) {
    const parent = parts.join("/");
    if (d.files.has(parent)) fail("父路径是文件，不能创建子节点");
    parts.pop();
  }
  const parentParts = path.split("/"); parentParts.pop();
  while (parentParts.length) { d.dirs.add(parentParts.join("/")); parentParts.pop(); }
  d.files.set(path, content);
}
function listing(d: Disk, root: string, rel: string, depth = 1): FileNode[] {
  if (!d.dirs.has(rel)) fail("内存目录不存在");
  const prefix = rel ? `${rel}/` : "";
  const selected = [...d.dirs].filter(p => p !== rel).map(p => ({ path: p, isDir: true }))
    .concat([...d.files.keys()].map(p => ({ path: p, isDir: false })))
    .filter(n => n.path.startsWith(prefix) && n.path.slice(prefix.length).split("/").length <= depth);
  return selected.map(n => ({ name: n.path.split("/").pop()!, path: `${root}/${n.path}`, isDir: n.isDir, size: n.isDir ? null : new TextEncoder().encode(d.files.get(n.path)!).length }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path, "zh-CN"));
}
function read(d: Disk, rel: string): string {
  const body = d.files.get(rel);
  if (body === undefined) fail("内存文件不存在；绝不回退到真实磁盘");
  return body;
}

/** 在调用期间才创建状态；单纯 import 本文件不会装 mock 或注入样例。 */
function createFixture() {
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${String(++seq).padStart(5, "0")}`;
  const now = () => STAMP + seq * 1000;
  const projects: Project[] = [
    { id: "PRJ-1042", name: "预约服务", kind: "code", rootUri: "/demo/booking-service", icon: null, iconColor: null, createdAt: STAMP - 23 * 86400000, updatedAt: STAMP },
    { id: "PRJ-1031", name: "运维控制台", kind: "code", rootUri: "/demo/ops-console", icon: null, iconColor: null, createdAt: STAMP - 18 * 86400000, updatedAt: STAMP - 1000 },
    { id: "PRJ-1018", name: "市场研究资料", kind: "work", rootUri: "/demo/research-booking", icon: null, iconColor: null, createdAt: STAMP - 14 * 86400000, updatedAt: STAMP - 2000 },
    { id: "PRJ-1009", name: "品牌与官网", kind: "work", rootUri: "/demo/nestcraft-site", icon: null, iconColor: null, createdAt: STAMP - 11 * 86400000, updatedAt: STAMP - 3000 },
  ];
  const projectById = (id: string) => lookup(projects, id, p => p.id, "项目");
  const projectByRoot = (root: unknown) => lookup(projects, absolute(root), p => p.rootUri, "项目根");
  const disks = new Map<string, Disk>();
  const projectDisk = (p: Project) => { const d = disks.get(p.id); if (!d) fail("项目内存文件尚未初始化"); return d; };
  const settings = new Map<string, string>(Object.entries({
    theme: "light", "user.name": "林澈", "user.email": "lin.che@example.invalid", "user.role": "研发负责人", "user.timezone": "Asia/Shanghai",
    "editor.theme": "light", "editor.fontSize": "13", "editor.tabSize": "2", "editor.wrap": "false", "editor.font": "JetBrains Mono",
    "server.port": "22", "server.defaultUser": "ops", "server.auth": "key", "server.confirmDanger": "true", "server.keepAlive": "30",
    "chat.sendMode": "queue", npmRegistry: "https://registry.demo.invalid", "office.demo.seeded": "BUG013-preview-only",
    "design.preview.provenance": LABEL,
  }));

  const efforts = { off: null, low: "low", medium: "medium", high: "high", max: "max" };
  function model(providerId: string, modelId: string, displayName: string, contextWindow: number | null, vision: boolean, thinking = true, imageGen = false): ModelConfig {
    return { id: `${providerId}:${modelId}`, providerId, modelId, displayName, text: !imageGen, vision, imageGen,
      efforts: thinking ? { ...efforts } : {}, defaultEffort: thinking ? "high" : null, contextWindow, maxTokens: imageGen ? null : 32768 };
  }
  const providers: Provider[] = [
    { id: "PRV-MAGPIE", name: "MagpieGateway", protocol: "anthropic", disabled: false, headersJson: '{"X-Demo-Client":"offline-review"}', fingerprintJson: null,
      keys: [{ id: "KEY-MAGPIE-01", alias: "主凭证（仿真）", masked: MASK, enabled: true }, { id: "KEY-MAGPIE-02", alias: "备用（仿真）", masked: MASK, enabled: true }],
      endpoints: [{ id: "EP-MAGPIE-01", protocol: "anthropic", baseUrl: "https://magpie.demo.invalid", enabled: true }, { id: "EP-MAGPIE-02", protocol: "openai", baseUrl: "https://magpie.demo.invalid/v1", enabled: false }],
      models: [model("PRV-MAGPIE", "gpt-6-astra-ar", "GPT 6 Astra AR", 922000, true), model("PRV-MAGPIE", "gpt-6-astra", "GPT 6 Astra", 922000, true),
        model("PRV-MAGPIE", "gpt-6.1-sol-ar", "GPT-6.1 Sol AR", 922000, true), model("PRV-MAGPIE", "gpt-6.1-sol", "GPT 6.1 Sol", 922000, true),
        model("PRV-MAGPIE", "gpt-6-luna", "GPT-6 Luna", 922000, true), model("PRV-MAGPIE", "gpt-5.6-sol", "GPT-5.6 Sol", 922000, true),
        model("PRV-MAGPIE", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1000000, false)] },
    { id: "PRV-TIERFLOW", name: "TierFlow", protocol: "openai", disabled: false, headersJson: null, fingerprintJson: null,
      keys: [{ id: "KEY-TIER-01", alias: "主凭证（仿真）", masked: MASK, enabled: true }, { id: "KEY-TIER-02", alias: "备用（仿真）", masked: MASK, enabled: false }],
      endpoints: [{ id: "EP-TIER-01", protocol: "openai", baseUrl: "https://tierflow.demo.invalid/v1", enabled: true }],
      models: [model("PRV-TIERFLOW", "tierflow-pro", "TierFlow Pro", 200000, true), model("PRV-TIERFLOW", "tierflow-lite", "TierFlow Lite", 128000, false), model("PRV-TIERFLOW", "tierflow-image", "TierFlow Image", null, false, false, true)] },
    { id: "PRV-LOCAL", name: "本地网关", protocol: "openai", disabled: false, headersJson: null, fingerprintJson: null,
      keys: [{ id: "KEY-LOCAL-01", alias: "演示", masked: MASK, enabled: true }], endpoints: [{ id: "EP-LOCAL-01", protocol: "openai", baseUrl: "https://local.demo.invalid/v1", enabled: true }],
      models: [model("PRV-LOCAL", "local-qwen-72b", "Qwen 72B", 32000, false, false)] },
  ];
  const provider = (id: string) => lookup(providers, id, p => p.id, "供应商");
  function candidates(): ModelCandidate[] {
    return providers.filter(p => !p.disabled && p.keys.some(k => k.enabled) && p.endpoints.some(e => e.enabled)).flatMap(p =>
      p.models.filter(m => m.text && !m.imageGen).map(m => ({ providerId: p.id, providerName: p.name, protocol: p.protocol, modelRowId: m.id, modelId: m.modelId,
        displayName: m.displayName, vision: m.vision, defaultEffort: m.defaultEffort, efforts: copy(m.efforts), contextWindow: m.contextWindow, maxTokens: m.maxTokens })));
  }
  const sdks: SdkState[] = [
    { id: "claude", package: "@anthropic-ai/claude-code", enabled: true, installState: "installed", version: "2.1.318-demo", path: "/demo/sdk/claude" },
    { id: "codex", package: "@openai/codex", enabled: true, installState: "installed", version: "0.166.0-demo", path: "/demo/sdk/codex" },
    { id: "grok", package: "@xai-official/grok", enabled: true, installState: "installed", version: "0.1.2-demo", path: "/demo/sdk/grok" },
  ];
  const sdk = (id: string) => lookup(sdks, id, s => s.id, "SDK");
  const jobs = new Map<string, SdkJob>();
  const jobTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  function stopJob(id: string): void { for (const timer of jobTimers.get(id) ?? []) clearTimeout(timer); jobTimers.delete(id); }

  const skills: SkillEntry[] = [
    { id: "skill:requirement-split", name: "requirement-split", description: "需求拆解：业务成果、用户故事与可观察 AC", enabled: true, sourceRef: "/demo/skills/requirement-split/SKILL.md", builtin: false },
    { id: "skill:code-review", name: "code-review", description: "代码审查：幂等、事务与凭证边界", enabled: true, sourceRef: "/demo/skills/code-review/SKILL.md", builtin: false },
    { id: "skill:release-check", name: "release-check", description: "发布检查：范围、回退与证据", enabled: false, sourceRef: "/demo/skills/release-check/SKILL.md", builtin: false },
  ];
  const skillBodies = new Map(skills.map(s => [s.name, `# ${s.name}\n\n${LABEL}\n\n${s.description}\n\n- 核对范围与来源。\n- 未授权行为不得执行。\n- 不将仿真结果写成验收结论。\n`]));
  const tools: ToolEntry[] = [
    { id: "tool:fs.read", name: "fs.read", description: "读取内存演示文件", risk: "low", enabled: true, builtin: true },
    { id: "tool:fs.write", name: "fs.write", description: "仅修改内存文件", risk: "medium", enabled: true, builtin: true },
    { id: "tool:code-search", name: "code-search", description: "内存文本检索", risk: "low", enabled: true, builtin: true },
    { id: "tool:local-exec", name: "local-exec", description: "高风险命令占位；不执行", risk: "high", enabled: false, builtin: true },
    { id: "tool:ssh-exec", name: "ssh-exec", description: "远程命令占位；不连接", risk: "high", enabled: false, builtin: true },
    { id: "tool:web-fetch", name: "web-fetch", description: "网络能力禁用；不发请求", risk: "medium", enabled: false, builtin: true },
  ];
  const mcps: McpServer[] = [
    { id: "MCP-FS", name: "filesystem", transport: "stdio", command: "demo-mcp-fs", args: ["--root", "/demo/booking-service"], env: { DEMO_TOKEN: MASK }, url: null, enabled: true, authStatus: "unauthenticated", authRevision: 0, authMode: "oauth", allowInsecureLocalTls: false,
      tools: [{ name: "read_file", description: "合成文件读取" }, { name: "list_directory", description: "合成目录列表" }] },
    { id: "MCP-KNOWLEDGE", name: "knowledge-gateway", transport: "http", command: null, args: [], env: {}, url: "https://knowledge.demo.invalid/mcp", enabled: true, authStatus: "unauthenticated", authRevision: 0, authMode: "oauth", allowInsecureLocalTls: false,
      tools: [{ name: "knowledge.list", description: "已授权库" }, { name: "knowledge.search", description: "授权内检索" }, { name: "knowledge.read", description: "授权内读取" }] },
    { id: "MCP-BROWSER", name: "browser", transport: "stdio", command: "demo-mcp-browser", args: [], env: {}, url: null, enabled: false, authStatus: "unauthenticated", authRevision: 0, authMode: "oauth", allowInsecureLocalTls: false, tools: [] },
  ];

  const libraries: KnowledgeLibrary[] = [
    { id: "KB-01", name: "研发手册", sourceKind: "directory", sourceRef: "/demo/knowledge/dev", enabled: true, noteCount: 0, revision: 1, icon: null, iconColor: null },
    { id: "KB-02", name: "竞品与用户研究", sourceKind: "directory", sourceRef: "/demo/knowledge/research", enabled: true, noteCount: 0, revision: 1, icon: null, iconColor: null },
    { id: "KB-03", name: "运维手册", sourceKind: "directory", sourceRef: "/demo/knowledge/ops", enabled: true, noteCount: 0, revision: 1, icon: null, iconColor: null },
  ];
  const library = (id: string) => lookup(libraries, id, l => l.id, "知识库");
  // CR-051：头像风格偏好（隔离内存演示，缺省 a）。
  let avatarStyle = "b";
// CR-051 r6：自定义头像（本机引用）；smoke 只存内存字符串，不写磁盘。
let avatarImage: { path: string; hash: string } | null = null;
  const notes = new Map<string, NoteContent[]>(); // 仅已保存 Markdown，未保存草稿不进入索引或 AI 网关。
  interface KnowledgeAsset { noteId: string; title: string; relativeUri: string; kind: KnowledgeFileInfo["kind"]; mime: string; bytes?: Uint8Array; text?: string }
  const assets = new Map<string, KnowledgeAsset[]>();
  const knowledgeDirs = new Map<string, Set<string>>();
  const encoder = new TextEncoder();
  // 与后端 FNV-1a64 相同：逐实际 UTF-8/原件字节计算；不是 contentHash 或密码学校验。
  function knowledgeHash(bytes: Uint8Array): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
  }
  function knowledgeText(value: unknown): string {
    const body = text(value, "content", true, 1024 * 1024);
    if (encoder.encode(body).byteLength > 1024 * 1024 || body.includes("\0")) fail("知识文本必须是 1 MiB 内无 NUL 的 UTF-8 文本；未修改内存原文");
    return body;
  }
  function enabledLibrary(id: string): KnowledgeLibrary {
    const l = library(id); if (!l.enabled) fail("知识库已禁用，拒绝访问"); return l;
  }
  function knowledgeName(value: unknown): string {
    const raw = text(value, "文件名", false, 120), n = raw.normalize("NFC");
    const device = n.split(".")[0].trimEnd().toUpperCase();
    if (raw !== raw.trim() || encoder.encode(n).byteLength > 240 || n.startsWith(".nestcraft-kb-save-") || /[. ]$/.test(n) || /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/.test(n) || ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].includes(device) || /^(COM|LPT)[1-9¹²³]$/.test(device) || n === "." || n === "..") fail("知识文件名非法，不得包含路径、保留名或首尾空白");
    return n;
  }
  function knowledgeRelative(value: unknown): string {
    const raw = text(value, "parentRelativeUri", true, 500);
    if (!raw) return "";
    if (raw.includes("\\")) fail("知识库父路径必须是使用 / 的相对 URI");
    const path = raw;
    const parts = path.split("/");
    if (parts.length > 9 || parts.some(part => !part || part === "." || part === "..")) fail("知识库父路径必须为受检相对路径，拒绝绝对路径或目录逃逸");
    parts.forEach(knowledgeName);
    return path.normalize("NFC");
  }
  function knowledgeParent(l: KnowledgeLibrary, value: unknown): string {
    const parent = knowledgeRelative(value);
    if (!knowledgeDirs.get(l.id)?.has(parent)) fail("知识库父目录不存在；不会级联创建或读取真实磁盘");
    return parent;
  }
  function addKnowledgeParents(id: string, rel: string): void {
    const dirs = knowledgeDirs.get(id)!;
    const parts = rel.split("/"); parts.pop();
    while (parts.length) { dirs.add(parts.join("/")); parts.pop(); }
  }
  function knowledgeTarget(l: KnowledgeLibrary, parent: string, fileName: string): string {
    const rel = parent ? `${parent}/${fileName}` : fileName;
    const keys = [...(knowledgeDirs.get(l.id) ?? []), ...(notes.get(l.id) ?? []).map(n => n.relativeUri), ...(assets.get(l.id) ?? []).map(n => n.relativeUri)];
    if (keys.some(path => keyOf(path) === keyOf(rel))) fail("同名文件或目录已存在；夹具拒绝覆盖");
    if (keys.length >= 2000) fail("知识夹具节点超过 2000 项限制");
    return rel;
  }
  function markdownTitle(fileName: string, content: string): string {
    return /^#\s+(.+)$/m.exec(content)?.[1].trim() || fileName.replace(/\.(md|markdown)$/i, "");
  }
  function refreshKnowledge(l: KnowledgeLibrary): void { l.noteCount = notes.get(l.id)?.length ?? 0; l.revision++; }
  const grants = new Map<string, Set<string>>([
    ["PRJ-1042", new Set(["KB-01", "KB-02"])], ["PRJ-1031", new Set()], ["PRJ-1018", new Set(["KB-02"])], ["PRJ-1009", new Set()],
  ]);
  const noteSeeds: Record<string, [string, string, string, string][]> = {
    "KB-01": [
      ["KD-011", "研发交付指南", "流程/交付.md", "## 派发前\n确认需求、设计版本与 AC。\n\n## 执行中\n失败保留记录，高风险行为逐次审批。\n\n## 交付\n技术验证不等于用户验收。"],
      ["KD-012", "预约接口约定", "接口/预约.md", "## 请求\nPOST /demo/bookings\n\n## 规则\n同一幂等键只生成一个 bookingId；满额返回 SLOT_FULL；取消只回补一次；只读角色写请求返回 403。"],
      ["KD-013", "评审清单", "流程/评审.md", "- [ ] 冻结范围与设计\n- [ ] 同条件视觉对照\n- [ ] 未输出秘密\n- [ ] 未验证项如实标记"],
      ["KD-015", "发布检查表", "发布/检查表.md", "- [ ] 范围和版本确认\n- [ ] 回退负责人确认\n\n夹具未连接发布系统。"],
      ["KD-016", "常见故障与恢复", "运维/故障.md", "## 并发失败\n返回可读错误，不泄漏内部堆栈。\n\n## 重试\n使用同一幂等键，避免重复预约。"],
      ["KD-017", "术语表", "概念/术语.md", "容量：活动可预约人数。\n有效预约：报名减取消。\n待验收：技术交付尚待使用者确认。"],
    ],
    "KB-02": [
      ["KD-021", "预约类产品对比", "对比/预约.md", "时段显示剩余名额；满额不隐藏活动；取消入口可找到；并发失败可重试。\n\n这里只是合成情景，未开展外部产品调研。"],
      ["KD-022", "访谈纪要 · 组织者", "访谈/组织者-01.md", "组织者（虚构）希望能清楚查看剩余名额和取消回补。没有采集真实访谈。"],
      ["KD-023", "访谈纪要 · 参与者", "访谈/参与者-02.md", "参与者（虚构）希望重复点击返回原预约，取消入口明确。"],
      ["KD-024", "研究结论 v2", "结论/研究.md", "四场活动容量 80，报名 64，取消 8，有效预约 56，剩余 24，利用率 70%。与项目报告、台账和汇报同源。"],
      ["KD-025", "样本与限制", "结论/限制.md", "仅四场合成活动。未采集真实人员、效果、延迟或费用，不得外推业务承诺。"],
    ],
    "KB-03": [], // 保留设计空树：默认无项目授权，不编造“15篇实测文档”。
  };
  for (const l of libraries) {
    knowledgeDirs.set(l.id, new Set([""])); assets.set(l.id, []);
    notes.set(l.id, (noteSeeds[l.id] ?? []).map(([noteId, title, relativeUri, body]) => {
      const content = `# ${title}\n\n> ${LABEL}\n\n${body}\n`;
      addKnowledgeParents(l.id, relativeUri);
      return { noteId, title, relativeUri, content, hash: knowledgeHash(encoder.encode(content)) };
    }));
    l.noteCount = notes.get(l.id)!.length;
  }
  // 同设计 D 的路径/身份仅用作元信息；摘要不是 PDF/Office/图片原件，绝不造预览。
  // KD-014 的旧 type=pdf/path=.md 冲突仍不回填，避免以图标猜测真实能力。
  assets.get("KB-01")!.push(
    { noteId: "KD-018", title: "架构评审记录（原件未嵌入）", relativeUri: "架构/评审-2026-11.pdf", kind: "pdf", mime: "application/pdf" },
    { noteId: "KD-019", title: "发布记录（原件未嵌入）", relativeUri: "发布/记录.xlsx", kind: "attachment", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { noteId: "KD-020", title: "预约流程图（原件未嵌入）", relativeUri: "架构/预约流程.png", kind: "image", mime: "image/png" },
    { noteId: "KD-026", title: "预约样本数据（合成）", relativeUri: "数据/预约样本.csv", kind: "text", mime: "text/csv", text: "activity,slot,remaining,booked\n社区读书会,A-01,2,18\n社区读书会,A-02,0,20\n亲子手工,B-01,5,15" },
    { noteId: "KD-CR045-TEXT", title: "演示文本（合成）", relativeUri: "演示样例/演示文本.txt", kind: "text", mime: "text/plain", text: "纯文本安全源码演示\n<script>alert('不执行')</script>\n" },
    { noteId: "KD-CR045-JSON", title: "演示配置（合成）", relativeUri: "演示样例/演示配置.json", kind: "text", mime: "application/json", text: '{\n  "source": "synthetic-demo",\n  "enabled": true,\n  "markup": "<script>never execute</script>"\n}' },
    { noteId: "KD-CR045-IMAGE", title: "演示图片（合成1×1 PNG；非知识原图）", relativeUri: "演示样例/演示图片.png", kind: "image", mime: "image/png", bytes: Uint8Array.from(atob(IMAGE.split(",")[1]), c => c.charCodeAt(0)) },
    { noteId: "KD-CR045-HTML", title: "HTML附件（元信息；不执行）", relativeUri: "演示样例/主动内容.html", kind: "attachment", mime: "text/html" },
    { noteId: "KD-CR045-SVG", title: "SVG附件（元信息；不执行）", relativeUri: "演示样例/主动内容.svg", kind: "attachment", mime: "image/svg+xml" },
  );
  assets.get("KB-02")!.push({ noteId: "KD-027", title: "问卷结果（原件未嵌入）", relativeUri: "问卷/结果.xlsx", kind: "attachment", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  for (const [id, files] of assets) for (const file of files) addKnowledgeParents(id, file.relativeUri);
  knowledgeDirs.get("KB-01")!.add("待整理（合成空目录）");
  function note(libId: string, noteId: string): NoteContent {
    enabledLibrary(libId);
    const n = lookup(notes.get(libId) ?? [], noteId, n => n.noteId, "已保存 Markdown 笔记");
    n.hash = knowledgeHash(encoder.encode(n.content));
    return n;
  }
  function knowledgeFile(l: KnowledgeLibrary, id: string): NoteContent | KnowledgeAsset {
    const file = [...(notes.get(l.id) ?? []), ...(assets.get(l.id) ?? [])].find(n => n.noteId === id);
    if (!file) fail("知识文件不存在或不属于当前库；拒绝任意路径或未保存草稿");
    return file;
  }
  function knowledgeInfo(l: KnowledgeLibrary, id: string): KnowledgeFileInfo {
    const file = knowledgeFile(l, id), markdown = "content" in file;
    const body = markdown ? file.content : file.text;
    const bytes = body !== undefined ? encoder.encode(body) : "bytes" in file ? file.bytes : undefined;
    const kind = markdown ? "markdown" : file.kind;
    const previewSupported = kind === "markdown" || (kind === "text" && body !== undefined) || (kind === "image" && bytes !== undefined);
    return { noteId: file.noteId, title: file.title, relativeUri: file.relativeUri,
      sizeBytes: bytes?.byteLength ?? 0, // 未嵌入原件的占位大小为 0，标题明示缺原件；不捏造原件字节数。
      modifiedAt: STAMP, kind, mime: markdown ? "text/markdown" : file.mime, previewSupported, editable: markdown,
      ...(bytes ? { hash: knowledgeHash(bytes) } : {}) };
  }
  function knowledgeData(l: KnowledgeLibrary, id: string): KnowledgeFileData {
    const info = knowledgeInfo(l, id), file = knowledgeFile(l, id);
    if (info.kind === "markdown" && "content" in file) return { info, text: file.content };
    if (info.kind === "text" && "text" in file && file.text !== undefined) return { info, text: file.text };
    if (info.kind === "image" && "bytes" in file && file.bytes) return { info, base64: btoa(Array.from(file.bytes, b => String.fromCharCode(b)).join("")) };
    return { info }; // PDF/Office/主动格式及无原件图片只元信息，不假正文、不生成可执行资源。
  }
  function noteTree(libId: string): NoteNode[] {
    enabledLibrary(libId);
    const roots: NoteNode[] = [], folders = new Map<string, NoteNode>();
    const dirs = [...(knowledgeDirs.get(libId) ?? [])].filter(Boolean).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "zh-CN"));
    for (const rel of dirs) {
      const parent = rel.split("/").slice(0, -1).join("/");
      const folder: NoteNode = { noteId: `${libId}:dir:${rel}`, title: rel.split("/").pop()!, relativeUri: rel, isDir: true, children: [] };
      folders.set(rel, folder); (parent ? folders.get(parent)!.children : roots).push(folder);
    }
    for (const n of [...(notes.get(libId) ?? []), ...(assets.get(libId) ?? [])]) {
      const parent = n.relativeUri.split("/").slice(0, -1).join("/");
      (parent ? folders.get(parent)!.children : roots).push({ noteId: n.noteId, title: n.title, relativeUri: n.relativeUri, isDir: false, children: [] });
    }
    return roots;
  }
  function searchNotes(ids: string[], query: string): KnowledgeHit[] {
    const q = keyOf(query); if (!q) return [];
    return ids.flatMap(id => {
      const l = library(id); if (!l.enabled) return [];
      return (notes.get(id) ?? []).filter(n => keyOf(`${n.title}\n${n.content}`).includes(q)).map(n => ({ libraryId: id, libraryName: l.name,
        noteId: n.noteId, title: n.title, relativeUri: n.relativeUri, snippet: n.content.slice(0, 220) }));
    }).slice(0, 100);
  }
  function authorized(pid: unknown): string[] {
    if (pid == null) return [];
    const p = projectById(text(pid, "projectId"));
    return [...(grants.get(p.id) ?? [])].filter(id => library(id).enabled);
  }
  function gateway(a: Args): unknown {
    const ids = authorized(a.projectId), data = json(a.argsJson, "argsJson"), tool = str(a, "tool");
    if (tool === "knowledge.list") return { libraries: ids.map(id => { const l = library(id); return { id: l.id, name: l.name, noteCount: l.noteCount }; }) };
    if (tool === "knowledge.search") return { hits: searchNotes(ids, str(data, "query")), denied: ids.length === 0 };
    const get = (item: Args) => {
      const libId = str(item, "libraryId"); if (!ids.includes(libId)) fail("知识库未授权给当前项目，拒绝读取");
      return note(libId, str(item, "noteId"));
    };
    if (tool === "knowledge.read") return { content: get(data).content };
    if (tool === "knowledge.read_many") return { notes: array(data.notes, "notes", 20).map(n => { const body = get(object(n)); return { noteId: body.noteId, content: body.content }; }) };
    return fail(`未知知识工具 ${tool}；没有真实服务回退`);
  }

  // 报告、台账、汇报和会话使用同一个数据常量，不使用随机数或独立假统计。
  const activityRows = [["读书分享", "20", "18", "2", "16", "4"], ["手作体验", "20", "16", "1", "15", "5"], ["摄影入门", "20", "14", "3", "11", "9"], ["公益讲座", "20", "16", "2", "14", "6"]];
  const activitySummary = "四场活动总容量 80，报名 64，取消 8，有效预约 56，剩余 24，利用率 70%";
  const brandRows = [["首页主视觉", "2", "2", "0"], ["功能截图", "6", "4", "2"], ["快速开始", "4", "2", "2"]];
  const brandSummary = "物料计划 12 份，已复核 8 份，待复核 4 份";
  const officeStates = new Map<string, OfficeProjectState>();
  function officeContent(p: Project): { path: string; content: string | DocBlock[]; readonly: boolean }[] {
    const research = p.id === "PRJ-1018", summary = research ? activitySummary : brandSummary;
    const title = research ? "社区活动预约调研报告" : "栖造品牌发布方案";
    return [
      { path: `01 源资料/${title}.docx`, readonly: true, content: [
        { t: "h", level: 1, text: title }, { t: "p", text: LABEL },
        { t: "h", level: 2, text: research ? "一、研究目标" : "一、品牌定位" },
        { t: "p", text: research ? "比较人工登记与自助预约，先解决名额不透明、取消不回补和重复报名。" : "栖造 / NestCraft，以项目组织文档、任务和 AI，青绿色帆船用于品牌识别。" },
        { t: "h", level: 2, text: "二、样例口径" }, { t: "p", text: summary },
        { t: "h", level: 2, text: "三、建议与边界" }, { t: "bullets", items: ["先核对来源与版本，再整理候选结论。", "没有真实访谈、模型调用、效果测量或发布。", "接受候选只进入草稿，保存与导出另行核查。"] },
      ] },
      { path: `02 数据分析/${research ? "活动预约台账" : "发布物料台账"}.xlsx`, readonly: true, content: [
        { t: "h", level: 2, text: research ? "活动汇总" : "物料汇总" },
        { t: "table", head: research ? ["活动", "容量", "报名", "取消", "有效预约", "剩余"] : ["物料", "计划数量", "已复核", "待复核"],
          rows: research ? [...copy(activityRows), ["合计", "80", "64", "8", "56", "24"]] : [...copy(brandRows), ["合计", "12", "8", "4"]],
          formula: research ? { B6: "=SUM(B2:B5)", C6: "=SUM(C2:C5)", D6: "=SUM(D2:D5)", E6: "=SUM(E2:E5)", F6: "=SUM(F2:F5)" } : { B5: "=SUM(B2:B4)", C5: "=SUM(C2:C4)", D5: "=SUM(D2:D4)" } },
        { t: "p", text: LABEL },
      ] },
      { path: `03 交付成果/${research ? "预约方案评审" : "品牌发布评审"}.pptx`, readonly: false, content: [{ t: "slides", pages: [
        { title, bullets: [LABEL, "2026 年 11 月 · 评审组"] }, { title: "同源口径", bullets: [summary, research ? "来源：活动预约台账.xlsx / 活动汇总" : "来源：发布物料台账.xlsx / 物料汇总"] },
        { title: "先核对，再交付", bullets: ["结论与未确认项分开。", "来源、受众和候选逐项审阅。", "未导出真实 Office 文件。"] },
      ] }] },
      { path: `01 源资料/${research ? "研究资料摘要" : "品牌视觉检查单"}.pdf`, readonly: true, content: [{ t: "pdf", pages: [
        { title: "范围与方法", text: `${summary}。${LABEL}。` }, { title: "使用说明", text: "仅展示合成内容，不代表真实 PDF 解析、OCR 或导出。" },
      ] }] },
      { path: `01 源资料/会议与访谈/${research ? "本周研究进展" : "发布周会纪要"}.md`, readonly: false,
        content: `# ${research ? "本周研究进展" : "发布周会纪要"}\n\n> ${LABEL}\n\n## 当前口径\n${summary}。\n\n## 待处理\n- [ ] 核对来源版本\n- [ ] 确认评审范围\n\n林澈与陈雨均为虚构角色。\n` },
      { path: "01 源资料/历史资料/来源与限制.md", readonly: true, content: `# 来源与限制\n\n${LABEL}\n\n本批全部为合成数据，没有访问真实调查、凭据或应用会话。\n` },
    ];
  }
  function officeText(content: string | DocBlock[]): string {
    if (typeof content === "string") return content;
    return content.map(b => {
      switch (b.t) {
        case "h": return `${"#".repeat(b.level)} ${b.text}`;
        case "p": return b.text;
        case "bullets": return b.items.map(s => `- ${s}`).join("\n");
        case "table": return [b.head, ...b.rows].map(row => row.join("\t")).join("\n");
        case "slides": return b.pages.map(page => `${page.title}\n${page.bullets.join("\n")}`).join("\n---\n");
        case "pdf": return b.pages.map(page => `${page.title}\n${page.text}`).join("\n---\n");
      }
    }).join("\n\n");
  }

  type ReqSeed = [string, RequirementNode["kind"], string | null, string, string, string];
  const reqSeeds: Record<string, ReqSeed[]> = {
    "PRJ-1042": [
      ["EPIC-01", "epic", null, "可预约的社区活动", "开发中", "参与者预约时段，容量不能超卖，取消只回补一次。"],
      ["FEAT-011", "feature", "EPIC-01", "预约主流程", "开发中", "冻结接口、容量、幂等与错误分支。"],
      ["STORY-0101", "story", "FEAT-011", "冻结预约接口约定", "已完成", "重复幂等键只生成一个 bookingId，满额返回 SLOT_FULL。"],
      ["STORY-0102", "story", "FEAT-011", "时段容量与库存校验", "开发中", "20 次请求抢 2 个名额，成功数不超过 2。扣减与预约在同一事务内。"],
      ["STORY-0103", "story", "FEAT-011", "幂等下单与重复请求", "待验收", "同一用户相同幂等键 24 小时内返回同一响应。"],
      ["STORY-0104", "story", "FEAT-011", "满额拒绝与可读提示", "已就绪", "满额、并发冲突与超时提示可区分，不显示内部堆栈。"],
      ["STORY-0105", "story", "FEAT-011", "取消预约与名额回补", "待确认", "重复取消不能重复回补。"],
      ["FEAT-012", "feature", "EPIC-01", "通知与提醒", "阻塞", "等待消息通道确认，夹具不发送通知。"],
      ["STORY-0201", "story", "FEAT-012", "预约成功站内信", "阻塞", "预约确认后可找到取消入口。"],
      ["STORY-0202", "story", "FEAT-012", "取消通知与回执", "待确认", "通知失败可以重投；演示不发送。"],
      ["EPIC-02", "epic", null, "运营看板与审计", "开发中", "占用、导出与审计可追踪。"],
      ["FEAT-021", "feature", "EPIC-02", "预约看板", "开发中", "容量、占用与剩余使用同一数据源。"],
      ["STORY-0301", "story", "FEAT-021", "时段占用看板", "验证中", "日期刷新、空态与窄屏列可观察。"],
      ["STORY-0302", "story", "FEAT-021", "导出预约明细", "待同步", "导出行数与筛选结果一致，未真实导出。"],
      ["FEAT-022", "feature", "EPIC-02", "权限与审计", "已完成", "只读运营与审计不记录凭据。"],
      ["STORY-0401", "story", "FEAT-022", "只读运营角色", "已完成", "只读角色写请求返回 403。"],
      ["STORY-0402", "story", "FEAT-022", "操作审计日志", "已完成", "关键操作有来源，不泄漏凭据。"],
    ],
    "PRJ-1031": [
      ["EPIC-11", "epic", null, "多主机巡检与受限执行", "开发中", "多主机连接与逐次审批；本夹具不连接 SSH。"],
      ["FEAT-111", "feature", "EPIC-11", "连接与分组", "已完成", "环境分组、认证引用与连接失败回显。"],
      ["STORY-1101", "story", "FEAT-111", "主机分组与标签", "已完成", "同一主机一个分组。"],
      ["STORY-1102", "story", "FEAT-111", "连接保活与失败回显", "已完成", "失败原因与重试入口保留。"],
      ["FEAT-112", "feature", "EPIC-11", "只读巡检", "开发中", "采样失败显示未知。"],
      ["STORY-1103", "story", "FEAT-112", "巡检指标采集", "开发中", "合成指标不能冒充服务器实测。"],
      ["STORY-1104", "story", "FEAT-112", "高风险命令逐次审批", "阻塞", "每次生成独立审批，不记忆放行。"],
    ],
    "PRJ-1018": [
      ["EPIC-21", "epic", null, "预约场景调研与结论", "开发中", activitySummary],
      ["FEAT-211", "feature", "EPIC-21", "竞品与访谈", "开发中", "只使用合成业务情景，保留来源和样本限制。"],
      ["STORY-2101", "story", "FEAT-211", "竞品对比结论", "已完成", "来源与观察边界可核对。"],
      ["STORY-2102", "story", "FEAT-211", "访谈纪要整理", "待验收", "人物为虚构角色，没有个人联系方式。"],
      ["STORY-2103", "story", "FEAT-211", "研究结论与边界", "已就绪", "合成样本不得外推为真实研究结论。"],
    ],
    "PRJ-1009": [
      ["EPIC-31", "epic", null, "品牌与官网落地", "已完成", brandSummary],
      ["FEAT-311", "feature", "EPIC-31", "标志与命名", "已完成", "栖造 / NestCraft 与青绿帆船。"],
      ["STORY-3101", "story", "FEAT-311", "图形标志定稿", "已完成", "浅深主题轮廓清晰，最小 24px。"],
      ["STORY-3102", "story", "FEAT-311", "官网信息架构", "已完成", "首页、能力、定价与文档四段。"],
    ],
  };
  function seedProject(p: Project): void {
    const d = disk(); disks.set(p.id, d);
    put(d, "README.md", `# ${p.name}\n\n> ${LABEL}\n\n所有路径位于 ${p.rootUri}，不访问真实磁盘。\n`);
    const seeds: ReqSeed[] = [[`VISION-${p.id.slice(4)}`, "vision", null, `${p.name}愿景`, "已确认", "以当前项目为作用域，内容、身份与统计均为合成测试。"], ...(reqSeeds[p.id] ?? [])];
    for (const [id, kind, parent, title, status, body] of seeds) {
      const dir = kind === "vision" ? "" : `${kind === "epic" ? "Epic" : kind === "feature" ? "Feature" : "Story"}/`;
      put(d, `docs/Plan/${dir}${id}-${title}.md`, `---\nid: ${id}\ntype: ${kind}\nparent: ${parent ?? ""}\ntitle: ${title}\nstatus: ${status}\nowner: 林澈\n---\n\n# ${id}：${title}\n\n> ${LABEL}\n\n## 目标\n${body}\n\n## 验收标准\n- AC-${id}-01：${body}\n\n## 验证记录\n仅合成状态展示，未执行真实测试或用户验收。\n`);
    }
    for (const dir of ["PRD", "LLD", "UI", "DB"]) {
      put(d, `docs/${dir}/${dir}-${p.id.slice(4)}-${p.name}.md`, `# ${dir}：${p.name}\n\n> ${LABEL}\n\n## 范围\n${p.kind === "work" ? p.id === "PRJ-1018" ? activitySummary : brandSummary : "容量、幂等、权限与可复核交付。"}\n\n## 数据与边界\n仅本项目内存文件，不访问生产、个人或应用数据。\n\n## 未验证\n真实执行、原生权限、格式保真与视觉验收均未验证。\n`);
    }
    // 可直接阅读的内存 HTML 仅作项目设计附件；无脚本、外链与真实业务执行。
    put(d, "docs/UI/index.html", `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${p.id} 合成UI附件</title><body><h1>${p.id} 设计附件</h1><p>${LABEL}</p></body></html>`);
    if (p.kind === "code") {
      put(d, "src/booking/capacity.ts", `/** ${LABEL} */\nexport function reserveCapacity(remaining: number, requested: number): number {\n  if (requested < 1 || requested > remaining) {\n    throw new Error("SLOT_FULL");\n  }\n  return remaining - requested;\n}\n`);
      put(d, "src/booking/service.ts", `/** ${LABEL} */\nimport { reserveCapacity } from "./capacity";\nexport const demoRemaining = reserveCapacity(20, 2);\n`);
      put(d, "tests/capacity.spec.ts", `// ${LABEL}；仅文本，不运行此文件。\n// 20 次请求抢 2 个名额：成功数不得超过 2。\n// 取消只回补一次，重复幂等键返回原记录。\n`);
      put(d, ".env.example", "DEMO_API_KEY=MOCK_NOT_A_SECRET\nDEMO_ENDPOINT=https://api.demo.invalid\n");
    } else if (reqSeeds[p.id]) {
      for (const f of officeContent(p)) put(d, f.path, officeText(f.content));
      d.dirs.add("01 源资料/历史资料");
    }
  }
  projects.forEach(seedProject);
  function requirements(p: Project): RequirementNode[] {
    const all: RequirementNode[] = [];
    for (const [rel, body] of projectDisk(p).files) {
      if (!rel.startsWith("docs/Plan/") || !rel.endsWith(".md")) continue;
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1]; if (!fm) continue;
      const field = (k: string) => new RegExp(`^${k}:[ \\t]*([^\\r\\n]*)`, "m").exec(fm)?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
      const kind = field("type"), entityId = field("id");
      if (!["vision", "epic", "feature", "story", "bug"].includes(kind) || !entityId) fail("需求 front matter 缺少有效 id/type");
      if (all.some(n => n.entityId === entityId)) fail("当前项目需求编号重复");
      all.push({ entityId, kind: kind as RequirementNode["kind"], parentId: field("parent") || null, title: field("title") || entityId,
        status: field("status") || null, owner: field("owner") || null, sourceUri: `${p.rootUri}/${rel}`, children: [] });
    }
    const index = new Map(all.map(n => [n.entityId, n]));
    for (const n of all) {
      const seen = new Set([n.entityId]); let parent = n.parentId;
      while (parent) { if (seen.has(parent)) fail("需求父子形成循环"); seen.add(parent); parent = index.get(parent)?.parentId ?? null; }
      if (n.parentId) { const pnode = index.get(n.parentId); if (!pnode) fail("需求父项不存在"); pnode.children.push(n); }
    }
    return all.filter(n => !n.parentId);
  }
  function docTarget(uri: unknown): { p: Project; d: Disk; rel: string } {
    const full = absolute(uri), p = projects.find(p => full.startsWith(`${p.rootUri}/`));
    if (!p) fail("文档不属于已注册演示项目");
    return { p, d: projectDisk(p), rel: within(p.rootUri, full) };
  }

  const sessions: SessionMeta[] = [];
  const messages = new Map<string, ChatMessage[]>();
  const session = (id: string) => lookup(sessions, id, s => s.id, "会话");
  function append(s: SessionMeta, role: ChatMessage["role"], content: string, meta: Args | null = null, refs: ContextRef[] | null = null): ChatMessage {
    const list = messages.get(s.id)!;
    const m: ChatMessage = { id: `${s.id}:msg:${list.length + 1}`, sessionId: s.id, role, content, metaJson: meta ? JSON.stringify({ ...meta, simulated: true, provenance: LABEL }) : null,
      refsJson: refs ? JSON.stringify(refs) : null, gitContextJson: null, createdAt: STAMP + list.length * 60000 };
    list.push(m); s.messageCount = list.length; s.updatedAt = m.createdAt;
    return m;
  }
  function newSession(a: Args, id = uid("SESSION")): SessionMeta {
    const projectId = a.projectId == null ? null : projectById(str(a, "projectId")).id;
    const serverId = a.serverId == null ? null : text(a.serverId, "serverId");
    if (serverId) lookup(hosts, serverId, h => h.id, "主机");
    let featureId: string | null = null, featureTitle: string | null = null, featureSourceHash: string | null = null;
    if (a.featureId != null) {
      featureId = str(a, "featureId");
      if (!projectId) fail("执行会话必须指定所属项目");
      const flattenRequirements = (nodes: RequirementNode[]): RequirementNode[] => nodes.flatMap(node => [node, ...flattenRequirements(node.children)]);
      const node = flattenRequirements(requirements(projects.find(p => p.id === projectId)!)).find(r => r.entityId === featureId);
      if (!node || node.kind !== "feature") fail("执行特性不存在、不属于该项目或不是特性");
      const epic = flattenRequirements(requirements(projects.find(p => p.id === projectId)!)).find(r => r.entityId === node.parentId);
      if (!epic || epic.kind !== "epic") fail("执行特性缺少所属Epic；源关系不完整");
      featureTitle = node.title; featureSourceHash = `preview:${featureId}`;
    }
    const providerId = a.providerId == null ? "PRV-MAGPIE" : str(a, "providerId");
    const selectedModel = a.modelId == null ? provider(providerId).models.find(m => m.text && !m.imageGen) : provider(providerId).models.find(m => m.modelId === a.modelId);
    // 指定供应商但未指定模型时从该供应商取默认，不能跨供应商套用 deepseek id。
    const defaultModel = a.providerId == null && a.modelId == null ? "deepseek-v4.1-flash" : selectedModel?.modelId ?? null;
    const selectedEffort = a.effort == null ? (a.modelId == null && a.providerId == null ? "high" : selectedModel?.defaultEffort ?? null) : str(a, "effort");
    const s: SessionMeta = { id, projectId, serverId, title: "新会话", cliId: a.cliId == null ? "claude" : str(a, "cliId"),
      providerId, modelId: a.modelId == null ? defaultModel : str(a, "modelId"),
      effort: selectedEffort, draft: "", unread: null, createdAt: now(), updatedAt: now(), messageCount: 0,
      featureId, featureTitle, featureSourceHash: featureId ? `preview:${featureId}` : null, sessionRole: featureId ? "executor" : "ordinary" };
    validateSession(s); sessions.push(s); messages.set(s.id, []); return s;
  }
  function validateSession(s: SessionMeta): void {
    if (s.cliId) sdk(s.cliId);
    if (s.modelId && !s.providerId) fail("选择模型时必须指定供应商");
    if (s.providerId) {
      const p = provider(s.providerId);
      if (s.modelId) {
        const m = lookup(p.models, s.modelId, m => m.modelId, "供应商模型");
        if (!m.text || m.imageGen) fail("生图模型不允许进入聊天候选");
        if (s.effort && !(s.effort in m.efforts)) fail("该模型不支持所选思考档位");
      }
    }
  }

  const hosts: ServerHost[] = [
    { id: "SRV-01", name: "预约服务 · 测试", host: "192.0.2.24", port: 22, username: "ops", authType: "key", groupTag: "测试", connected: false },
    { id: "SRV-02", name: "构建机 · CI", host: "203.0.113.51", port: 22, username: "ci", authType: "key", groupTag: "CI", connected: false },
    { id: "SRV-03", name: "归档 · 开发", host: "198.51.100.28", port: 22, username: "ops", authType: "none", groupTag: "开发", connected: false },
  ];
  const host = (id: string) => lookup(hosts, id, h => h.id, "主机");
  const hostDisks = new Map<string, Disk>();
  for (const h of hosts) {
    const d = disk();
    put(d, "var/log/booking.log", `DEMO 2026-11-20 booking confirmed; no real host queried\n`);
    put(d, "srv/booking/README.md", `# ${h.name}\n\n${LABEL}\n`);
    put(d, "srv/booking/.env.example", "DEMO_API_KEY=MOCK_NOT_A_SECRET\n"); hostDisks.set(h.id, d);
  }
  function hostPath(h: ServerHost, path: unknown): string {
    const raw = text(path, "服务器内存路径", true, 500).replace(/\\/g, "/");
    return within(`/demo/servers/${h.id}`, raw.startsWith("/demo/") ? raw : raw.replace(/^\/+/, ""), true);
  }
  const metrics: Record<string, HostMetrics> = {
    "SRV-01": { hostname: "DEMO-booking-test", os: "Ubuntu 24.04 LTS（合成）", uptime: "12 天 6 小时（仿真）", cpuCores: [16, 24, 32, 24], cpuAvg: 24, memTotalMb: 8192, memUsedMb: 3174, load1: 0.36 },
    "SRV-02": { hostname: "DEMO-build-ci", os: "Debian 12（合成）", uptime: "3 天 2 小时（仿真）", cpuCores: [62, 58, 44, 71], cpuAvg: 58.75, memTotalMb: 32768, memUsedMb: 12698, load1: 3.12 },
    "SRV-03": { hostname: "DEMO-archive", os: "Ubuntu 22.04（合成）", uptime: "未知（未实测）", cpuCores: [], cpuAvg: 0, memTotalMb: 0, memUsedMb: 0, load1: 0 },
  };
  const terminals = new Map<string, { hostId: string; channel: ReturnType<typeof channelWriter> }>();
  const approvals = new Map<string, { hostId: string; expires: number }>();

  // 每个项目三条会话；id、消息引用和文件均来自同一项目，不加载旧 runtime 子代理。
  for (const p of projects) for (let i = 0; i < 3; i++) {
    const s = newSession({ projectId: p.id }, `S-${p.id.slice(4)}-0${i + 1}`);
    s.createdAt = STAMP - i * 3600000; s.updatedAt = STAMP - i * 3600000;
    s.title = p.kind === "work" ? `${p.name} · ${["资料简报", "汇报结构", "来源与待确认项"][i]}` : p.id === "PRJ-1042"
      ? ["让 STORY-0102 容量校验通过 AC-02 / AC-03", "核对预约接口与重复请求", "复核失败分支与来源边界"][i]
      : ["巡检指标与失败回显", "主机分组与连接边界", "逐次审批与未验证项"][i];
    const file = p.kind === "work" ? officeContent(p)[0].path : "src/booking/capacity.ts";
    const body = read(projectDisk(p), file);
    const refs: ContextRef[] = [{ kind: "file", objectId: `${p.rootUri}/${file}`, display: file }];
    const toolId = `${s.id}:tool:read`;
    append(s, "system", `${LABEL}。所有人员、会话、工具、统计与文件均为测试仿真，不是实际执行记录。`);
    append(s, "user", p.kind === "work" ? `整理${p.name}当前资料，给出简报与下一步核对事项。` : `先核对${p.name}当前需求与容量边界，不重复已验证的演示项。`, null, refs);
    append(s, "tool_use", "DEMO fs.read", { toolId, input: JSON.stringify({ path: `${p.rootUri}/${file}`, simulated: true }) });
    append(s, "tool_result", `${LABEL}\n\n${body.slice(0, 650)}`, { toolId, isError: false });
    const summary = p.kind === "work" ? p.id === "PRJ-1018" ? activitySummary : brandSummary : "容量扣减失败应返回 SLOT_FULL，重复取消只回补一次。";
    append(s, "assistant", `**${p.name} · ${i === 1 ? "汇报结构" : "当前资料"}**\n\n${summary}。\n\n来源：${p.rootUri}/${file}:3:1\n\n1. 核对项目与来源版本。\n2. 区分已确认内容与待验证判断。\n3. 人工审阅候选后再保存。\n\n![内联测试像素，非外部图片](${IMAGE})\n\n${LABEL}；真实 CLI、模型、费用与验收均未发生。`,
      { thinking: `先核对 ${p.id} 的同源文件与边界，不读取其他项目。这里只是合成思考文本。`, usage: { inputTokens: 240, outputTokens: 120, cacheReadTokens: 0 } }, refs);
    s.unread = i === 2 ? "failed" : null;
    if (i === 2) append(s, "assistant", "合成故障情景：来源版本待确认。本次未写文件、未运行命令；请先复核范围。", { isError: true });
    s.updatedAt = STAMP - i * 3600000;
  }

  interface GitMemory { branch: string; branches: string[]; changes: GitChange[]; baseline: Map<string, string>; commits: CommitEntry[]; commitFiles: Map<string, CommitFileEntry[]> }
  const gitStates = new Map<string, GitMemory>();
  function seedGit(p: Project): GitMemory {
    const branch = p.id === "PRJ-1042" ? "feature/booking-idempotency" : "main";
    const commits: CommitEntry[] = [0, 1, 2].map(i => {
      const hash = `${p.id.slice(4)}${String(100 + i).padStart(36, "0")}`;
      return { hash, short: hash.slice(0, 7), authorName: "林澈（虚构）", authorEmail: "lin.che@example.invalid", date: new Date(STAMP - i * 86400000).toISOString(),
        parents: [], subject: ["补充容量事务与幂等边界（合成）", "冻结预约接口约定（合成）", "初始化项目文档（合成）"][i], body: LABEL, refs: i === 0 ? [branch] : [] };
    });
    const state: GitMemory = { branch, branches: [...new Set([branch, "main", "feature/booking-idempotency"])], changes: [], baseline: new Map(projectDisk(p).files), commits, commitFiles: new Map() };
    if (p.kind === "code") {
      const path = "src/booking/capacity.ts";
      state.baseline.set(path, read(projectDisk(p), path).replace('throw new Error("SLOT_FULL");', 'throw new Error("CAPACITY_UNKNOWN");'));
      state.changes.push({ path, oldPath: null, staged: null, unstaged: "M", untracked: false });
    }
    for (const c of commits) state.commitFiles.set(c.hash, [{ path: "README.md", oldPath: null, status: "M", insertions: 3, deletions: 0 }]);
    gitStates.set(p.id, state); return state;
  }
  projects.forEach(seedGit);
  const git = (p: Project) => { if (p.kind !== "code") fail("办公夹具不是 Git 仓库"); return gitStates.get(p.id)!; };
  function gitStatus(p: Project): GitStatus {
    if (p.kind !== "code") return { repoRoot: p.rootUri, state: "no-repo", branch: null, headOid: null, upstream: null, ahead: null, behind: null, changes: [] };
    const g = git(p); return { repoRoot: p.rootUri, state: "ready", branch: g.branch, headOid: g.commits[0]?.hash ?? null,
      upstream: `origin/${g.branch}`, ahead: 1, behind: 0, changes: copy(g.changes) };
  }
  function markFileChange(p: Project, path: string, deleted = false): void {
    if (p.kind !== "code") return;
    const g = git(p), found = g.changes.find(c => c.path === path), tracked = g.baseline.has(path);
    const c: GitChange = found ?? { path, oldPath: null, staged: null, unstaged: null, untracked: !tracked };
    c.unstaged = deleted ? "D" : tracked ? "M" : "?";
    if (!found) g.changes.push(c);
  }
  function writeProject(p: Project, rel: string, content: string): void {
    const d = projectDisk(p), previous = d.files.get(rel), dirsBefore = new Set(d.dirs);
    put(d, rel, content);
    try { if (rel.startsWith("docs/Plan/")) requirements(p); }
    catch (e) { if (previous === undefined) d.files.delete(rel); else d.files.set(rel, previous); d.dirs = dirsBefore; throw e; }
    p.updatedAt = now(); markFileChange(p, rel);
  }
  function deleteProjectFile(p: Project, rel: string): void {
    const d = projectDisk(p), previous = read(d, rel); d.files.delete(rel);
    try { if (rel.startsWith("docs/Plan/")) requirements(p); } catch (e) { d.files.set(rel, previous); throw e; }
    markFileChange(p, rel, true);
  }

  function channelWriter(value: unknown) {
    let id: number | undefined;
    if (typeof value === "string" && /^__CHANNEL__:\d+$/.test(value)) id = Number(value.slice("__CHANNEL__:".length));
    else if (value && typeof value === "object") {
      const rawId = (value as { id?: unknown }).id;
      if (typeof rawId === "number") id = rawId;
    }
    const internals = window.__TAURI_INTERNALS__ as Internals | undefined;
    if (!Number.isSafeInteger(id) || !internals || typeof internals.runCallback !== "function" || !internals.callbacks.has(id!)) fail("Channel 不可模拟；拒绝发送，预置消息仍可展示，绝不调用真实后端");
    let index = 0, closed = false;
    return {
      emit(data: unknown) { if (!closed) internals.runCallback(id!, { index: index++, message: data }); },
      close() { if (!closed) { closed = true; internals.runCallback(id!, { index, end: true }); } },
    };
  }
  const turns = new Map<string, { aborted: boolean }>();
  async function chatSend(a: Args): Promise<null> {
    const payload = object(a.payload, "payload"), s = session(str(payload, "sessionId"));
    if (turns.has(s.id)) fail("本会话已有合成发送正在进行");
    if (turns.size >= 8) fail("夹具最多同时模拟 8 个发送");
    validateSession(s);
    if (s.cliId && (sdk(s.cliId).installState !== "installed" || !sdk(s.cliId).enabled)) fail("SDK 未安装或已禁用（合成状态）");
    if (s.providerId && !candidates().some(m => m.providerId === s.providerId && m.modelId === s.modelId)) fail("供应商或模型当前不可用（合成状态）");
    const content = text(payload.content, "content", false, 20000), refs = array(payload.refs, "refs", 30).map(r => copy(object(r))) as unknown as ContextRef[];
    const attachments = array(payload.attachments, "attachments", 10);
    for (const item of attachments) { const att = object(item); name(att.name); integer(att.byteSize, 0, 0, 20_000_000); }
    const p = s.projectId ? projectById(s.projectId) : null;
    const excerpts: string[] = [];
    for (const ref of refs) {
      if (!["file", "requirement", "knowledge", "session", "command", "skill"].includes(ref.kind)) fail("未知引用种类");
      text(ref.display, "引用展示", false, 500); text(ref.objectId, "引用 id", false, 500);
      if (ref.kind === "file") {
        if (!p) fail("文件引用必须绑定项目");
        if (ref.objectId.startsWith("office:")) {
          const f = lookup(officeStates.get(p.id)?.files ?? [], ref.objectId.slice(7), f => f.id, "办公来源");
          excerpts.push(officeText(f.draft ?? f.content));
        } else excerpts.push(read(projectDisk(p), within(p.rootUri, ref.objectId)));
      } else if (ref.kind === "requirement") {
        if (!p) fail("需求引用必须绑定项目");
        const flatten = (nodes: RequirementNode[]): RequirementNode[] => nodes.flatMap(n => [n, ...flatten(n.children)]);
        const n = lookup(flatten(requirements(p)), ref.objectId, n => n.entityId, "需求引用");
        excerpts.push(read(projectDisk(p), within(p.rootUri, n.sourceUri)));
      } else if (ref.kind === "knowledge") {
        if (!ref.libraryId || !authorized(s.projectId).includes(ref.libraryId)) fail("知识库未授权给此项目");
        excerpts.push(note(ref.libraryId, ref.objectId).content);
      } else if (ref.kind === "session") {
        const other = session(ref.objectId); if (other.projectId !== s.projectId || other.serverId !== s.serverId) fail("拒绝跨作用域会话引用");
        excerpts.push((messages.get(other.id) ?? []).map(m => m.content).join("\n").slice(0, 4000));
      } else if (ref.kind === "skill") {
        const entry = lookup(skills, ref.objectId, x => x.name, "Skill"); if (!entry.enabled) fail("Skill 已禁用");
      } // command 只保留引用，不执行任意文本，也不联网。
    }
    const ch = channelWriter(a.channel), turn = { aborted: false }; turns.set(s.id, turn);
    append(s, "user", content, { attachments: attachments.map(v => ({ name: object(v).name })), simulated: true }, refs);
    const toolId = uid(`${s.id}:demo-tool`), toolName = "DEMO inspect-memory", input = JSON.stringify({ projectId: s.projectId, refs: refs.map(r => r.objectId), simulated: true });
    const result = `${LABEL}\n${excerpts.length ? excerpts.map(body => body.slice(0, 180)).join("\n\n") : "已核对当前会话的合成作用域。没有读取外部文件。"}`;
    const thinking = "先核对本项目同源数据与授权，再整理可审阅内容。模型并未执行。";
    const answer = `**合成回复 · ${p?.name ?? "会话"}**\n\n${p?.id === "PRJ-1018" ? activitySummary : p?.id === "PRJ-1009" ? brandSummary : "先核对需求、接口和失败边界，未确认项不报完成"}。\n\n${refs.length ? `引用：${refs.map(r => r.display).join("、")}。` : "没有附加文件引用。"}\n\n${LABEL}；本次不生成真实产物、不运行 CLI、不发送资料给模型。`;
    const inputTokens = Math.ceil((content.length + result.length) / 4), outputTokens = Math.ceil(answer.length / 4);
    const events: ChatEvent[] = [{ type: "thinking", delta: thinking }, { type: "toolUse", toolId, name: toolName, inputJson: input },
      { type: "toolResult", toolId, content: result, isError: false }, { type: "delta", delta: answer.slice(0, Math.ceil(answer.length / 2)) },
      { type: "delta", delta: answer.slice(Math.ceil(answer.length / 2)) }, { type: "usage", inputTokens, outputTokens, cacheReadTokens: 0 }];
    let sentTool = false, sentResult = false, delta = "";
    try {
      for (const event of events) {
        await new Promise<void>(resolve => setTimeout(resolve, 45));
        if (turn.aborted || !sessions.includes(s)) break;
        ch.emit(event);
        if (event.type === "toolUse") { sentTool = true; append(s, "tool_use", toolName, { toolId, input }); }
        if (event.type === "toolResult") { sentResult = true; append(s, "tool_result", result, { toolId, isError: false }); }
        if (event.type === "delta") delta += event.delta;
      }
      if (turn.aborted || !sessions.includes(s)) {
        if (sentTool && !sentResult && sessions.includes(s)) append(s, "tool_result", "合成请求已取消，未返回结果。", { toolId, isError: true });
        if (delta && sessions.includes(s)) append(s, "assistant", delta, { thinking, cancelled: true });
        ch.emit({ type: "error", message: "合成请求已取消；没有真实执行。" } satisfies ChatEvent);
      } else {
        append(s, "assistant", answer, { thinking, usage: { inputTokens, outputTokens, cacheReadTokens: 0 }, estimate: "字符数/4（合成）" }, refs);
        s.draft = ""; s.unread = "success";
        ch.emit({ type: "done", turnId: `DEMO:${s.id}`, nativeResumed: false, freshContext: false, blocked: false, reasonCode: null, refFingerprint: null } satisfies ChatEvent);
      }
      return null;
    } finally { turns.delete(s.id); ch.close(); }
  }

  const handlers: Record<string, Handler> = Object.create(null) as Record<string, Handler>;
  function on(command: string, handler: Handler): void { handlers[command] = handler; }
  on("ping", () => "pong");
  on("app_data_dir", () => "/demo/app-data");
  on("app_data_ensure_dir", a => { const rel = str(a, "rel"); if (rel.startsWith("/") || /^[a-z]:/i.test(rel)) fail("目录参数必须为相对演示路径"); return absolute(`/demo/app-data/${rel}`); });
  on("get_setting", a => settings.get(str(a, "key")) ?? null);
  on("set_setting", a => { const key = text(a.key, "key", false, 200); if (a.value === null) settings.delete(key); else settings.set(key, safeSetting(key, str(a, "value", true))); return null; });
  on("get_theme", () => new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : (settings.get("theme") ?? "light"));
  on("set_theme", a => { const theme = str(a, "theme"); if (!["light", "dark", "system"].includes(theme)) fail("未知主题"); settings.set("theme", theme); return null; });
  // CR-046：更新徽标隔离夹具。URL ?update=hidden|available|downloading|ready|applying 控制初始状态；
  // 只返回合成状态，不联网、不落盘、不替换程序。
  const updateParam = new URLSearchParams(window.location.search).get("update");
  const updatePhaseNames = ["hidden", "available", "downloading", "ready", "applying"];
  let previewUpdatePhase = updateParam && updatePhaseNames.includes(updateParam) ? updateParam : "available";
  let previewUpdateProgress = previewUpdatePhase === "downloading" ? 42 : previewUpdatePhase === "ready" ? 100 : 0;
  const previewUpdateVersion = "0.2.0";
  const previewUpdateSha = "a".repeat(64);
  const previewUpdateManifest = {
    version: previewUpdateVersion,
    notes: "合成更新夹具，不下载真实文件",
    pub_date: "2026-11-21",
    installer: { url: "https://example.com/setup.exe", mirrors: [], sha256: previewUpdateSha, size: 104857600 },
    portable: { url: "https://example.com/portable.exe", mirrors: [], sha256: previewUpdateSha, size: 104857600 },
  };
  const previewUpdateStatus = () => ({
    phase: previewUpdatePhase,
    done: previewUpdateProgress,
    total: 100,
    speed: 0,
    message: previewUpdatePhase === "ready" ? "更新已下载并通过校验，重启后安装" : "",
    staged_file: previewUpdatePhase === "ready" || previewUpdatePhase === "applying" ? "/demo/app-data/update/update-staged.exe" : null,
    kind: "portable",
    version: previewUpdatePhase === "available" ? null : previewUpdateVersion,
  });
  on("update_environment", () => ({ kind: "portable", current_version: "0.1.0", exe_path: "/demo/NestCraft.exe", updatable: true }));
  on("update_status", () => previewUpdateStatus());
  on("update_check", () => previewUpdatePhase === "available"
    ? { current_version: "0.1.0", update_available: true, manifest: previewUpdateManifest, asset: previewUpdateManifest.portable, message: "" }
    : { current_version: "0.1.0", update_available: false, manifest: null, asset: null, message: "当前已是最新版本" });
  on("update_download", async () => {
    previewUpdatePhase = "downloading";
    previewUpdateProgress = 0;
    for (let step = 1; step <= 10; step++) {
      await new Promise(resolve => setTimeout(resolve, 80));
      previewUpdateProgress = step * 10;
    }
    previewUpdatePhase = "ready";
    previewUpdateProgress = 100;
    return "/demo/app-data/update/update-staged.exe";
  });
  on("update_apply", async () => {
    previewUpdatePhase = "applying";
    await new Promise(resolve => setTimeout(resolve, 1200));
    return null;
  });
  on("smoke_should_run", () => false); // 绝不触发真实 smoke runner。
  on("smoke_report_write", a => { text(a.content, "诊断正文"); return null; }); // 不落盘，不记录正文。
  on("list_projects", () => copy(projects));
  on("pick_project_directory", () => `/demo/new-project-${++seq}`);
  function validProjectRoot(raw: unknown, except?: Project): string {
    const root = absolute(raw);
    if (["/demo/app-data", "/demo/knowledge", "/demo/sdk", "/demo/skills", "/demo/servers"].some(r => root === r || root.startsWith(`${r}/`) || r.startsWith(`${root}/`))) fail("项目根与保留的演示作用域冲突");
    if (projects.some(p => p !== except && (p.rootUri === root || root.startsWith(`${p.rootUri}/`) || p.rootUri.startsWith(`${root}/`)))) fail("项目根不能与另一项目重叠");
    return root;
  }
  on("create_project", a => {
    const n = name(a.name); unique(projects, n, p => p.name); const kind = str(a, "kind"); if (kind !== "code" && kind !== "work") fail("未知项目类型");
    const p: Project = { id: uid("PRJ-DEMO"), name: n, kind, rootUri: validProjectRoot(a.rootUri), icon: null, iconColor: null, createdAt: now(), updatedAt: now() };
    projects.push(p); grants.set(p.id, new Set()); seedProject(p); seedGit(p); return copy(p);
  });
  on("update_project", a => {
    const p = projectById(str(a, "id")), n = name(a.name); unique(projects, n, x => x.name, p);
    const oldRoot = p.rootUri, nextRoot = a.rootUri == null ? oldRoot : validProjectRoot(a.rootUri, p);
    p.name = n; p.rootUri = nextRoot; p.updatedAt = now();
    // CR-051：icon / iconColor 缺省=保持；null=清空回默认；字符串须命中 50 图标 / 10 色卡白名单。
    if (a.iconColor !== undefined) {
      const color = a.iconColor == null || a.iconColor === "" ? null : String(a.iconColor);
      if (color && !ICON_COLORS.some(sw => sw.id === color)) fail(`非法背景色卡 id：${color}`);
      p.iconColor = color;
    }
    if (a.icon !== undefined) {
      const value = a.icon == null || a.icon === "" ? null : String(a.icon);
      if (value && !PROJECT_ICON_IDS.includes(value)) fail(`非法项目图标 id：${value}`);
      p.icon = value;
    }
    if (oldRoot !== nextRoot) for (const s of sessions.filter(s => s.projectId === p.id)) for (const m of messages.get(s.id) ?? []) {
      m.content = m.content.split(oldRoot).join(nextRoot); if (m.refsJson) m.refsJson = m.refsJson.split(oldRoot).join(nextRoot); if (m.metaJson) m.metaJson = m.metaJson.split(oldRoot).join(nextRoot);
    }
    return copy(p);
  });
  on("delete_project", a => {
    const p = projectById(str(a, "id")); if (sessions.some(s => s.projectId === p.id && turns.has(s.id))) fail("有活动合成会话，先停止再删除项目");
    for (const s of [...sessions].filter(s => s.projectId === p.id)) { messages.delete(s.id); sessions.splice(sessions.indexOf(s), 1); }
    projects.splice(projects.indexOf(p), 1); disks.delete(p.id); grants.delete(p.id); gitStates.delete(p.id); officeStates.delete(p.id); return null;
  });
  on("read_requirements", a => copy(requirements(projectById(str(a, "projectId")))));
  on("read_requirement_sources", a => {
    const p = projectById(str(a, "projectId")), indexed = new Map<string, RequirementNode>();
    const visit = (nodes: RequirementNode[]) => { for (const n of nodes) { indexed.set(n.sourceUri, { ...n, children: [] }); visit(n.children); } };
    const warnings: string[] = [];
    try { visit(requirements(p)); } catch { warnings.push("合成需求索引无效；仍列出全部 Plan 文件，未静默漏掉源正文"); }
    const result: RequirementSources = { rootUri: p.rootUri, warnings, sources: [...projectDisk(p).files.keys()]
      .filter(rel => rel.startsWith("docs/Plan/") && /\.(md|markdown)$/i.test(rel))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map(rel => {
        const sourceUri = `${p.rootUri}/${rel}`, n = indexed.get(sourceUri);
        return { sourceUri, node: n ?? null, error: null, warning: n ? null : "未进入需求索引的合成 Plan 文件；正文仍可受限读取" };
      }) };
    return copy(result);
  });
  on("read_doc", a => { const { d, rel } = docTarget(a.sourceUri); return read(d, rel); });
  on("write_doc", a => { const { p, rel } = docTarget(a.sourceUri); writeProject(p, rel, str(a, "content", true)); return null; });
  on("fs_list_dir", a => { const p = projectByRoot(a.rootUri); return listing(projectDisk(p), p.rootUri, within(p.rootUri, a.relPath ?? "", true)); });
  on("fs_list_tree", a => { const p = projectByRoot(a.rootUri); return listing(projectDisk(p), p.rootUri, "", integer(a.maxDepth, 8, 1, 20)); });
  on("fs_read_file", a => { const p = projectByRoot(a.rootUri); return read(projectDisk(p), within(p.rootUri, a.path)); });
  on("fs_write_file", a => { const p = projectByRoot(a.rootUri); writeProject(p, within(p.rootUri, a.path), str(a, "content", true)); return null; });
  on("fs_delete_file", a => { const p = projectByRoot(a.rootUri); deleteProjectFile(p, within(p.rootUri, a.path)); return null; });
  on("fs_search", a => {
    const p = projectByRoot(a.rootUri), q = keyOf(str(a, "query")), hits: SearchHit[] = [], limit = integer(a.limit, 50, 1, 500);
    for (const [path, body] of projectDisk(p).files) body.split(/\r?\n/).forEach((lineText, i) => { if (hits.length < limit && keyOf(lineText).includes(q)) hits.push({ path: `${p.rootUri}/${path}`, lineNo: i + 1, lineText }); });
    return hits;
  });

  on("provider_list", () => copy(providers));
  on("model_candidates", () => candidates());
  on("provider_save", a => {
    const d = object(a.draft, "draft") as unknown as ProviderDraft;
    const existing = d.id ? provider(text(d.id, "id")) : undefined, n = name(d.name); unique(providers, n, p => p.name, existing);
    if (!["openai", "anthropic"].includes(d.protocol)) fail("未知供应商协议");
    const id = existing?.id ?? uid("PRV-DEMO");
    const headers = json(d.headersJson, "headersJson");
    const next: Provider = { id, name: n, protocol: d.protocol, disabled: bool(d.disabled, "disabled"),
      headersJson: Object.keys(headers).length ? JSON.stringify(Object.fromEntries(Object.keys(headers).map(k => [k, /authorization|key|token|secret/i.test(k) ? MASK : "offline-review"]))) : null,
      fingerprintJson: existing?.fingerprintJson ?? null,
      keys: array(d.keys, "keys", 20).map((value, i) => { const k = object(value); return { id: k.id == null ? `${id}:key:${i + 1}` : str(k, "id"), alias: k.alias == null ? null : text(k.alias, "alias", true, 100), masked: MASK, enabled: bool(k.enabled, "enabled") }; }),
      endpoints: array(d.endpoints, "endpoints", 20).map((value, i) => { const e = object(value); const protocol = str(e, "protocol"); if (!["openai", "anthropic"].includes(protocol)) fail("未知端点协议"); return { id: e.id == null ? `${id}:endpoint:${i + 1}` : str(e, "id"), protocol, baseUrl: demoUrl(e.baseUrl), enabled: bool(e.enabled, "enabled") }; }),
      models: array(d.models, "models", 80).map((value, i) => {
        const m = object(value), em = object(m.efforts, "efforts");
        if (Object.values(em).some(v => v !== null && typeof v !== "string")) fail("思考档位映射必须为文本或 null");
        const effort = m.defaultEffort == null ? null : str(m, "defaultEffort"); if (effort && !(effort in em)) fail("默认思考档位未定义");
        return { id: m.id == null ? `${id}:model:${i + 1}` : str(m, "id"), providerId: id, modelId: str(m, "modelId"), displayName: str(m, "displayName"),
          text: bool(m.text, "text"), vision: bool(m.vision, "vision"), imageGen: bool(m.imageGen, "imageGen"), efforts: copy(em) as ModelConfig["efforts"], defaultEffort: effort,
          contextWindow: m.contextWindow == null ? null : integer(m.contextWindow, 0, 1, 10_000_000), maxTokens: m.maxTokens == null ? null : integer(m.maxTokens, 0, 1, 1_000_000) };
      }),
    };
    for (const values of [next.keys.map(k => k.id), next.endpoints.map(e => e.id), next.models.map(m => m.id), next.models.map(m => m.modelId)]) if (new Set(values).size !== values.length) fail("供应商嵌套条目编号或模型名重复");
    if (existing) providers[providers.indexOf(existing)] = next; else providers.push(next); return id;
  });
  on("provider_delete", a => { const p = provider(str(a, "id")); providers.splice(providers.indexOf(p), 1); return null; });
  on("provider_set_disabled", a => { provider(str(a, "id")).disabled = bool(a.disabled, "disabled"); return null; });
  on("provider_discover_models", a => {
    const p = provider(str(a, "providerId")); if (p.disabled) fail("供应商已禁用（合成）");
    const result: DiscoveredModel[] = p.models.map(m => ({ modelId: m.modelId, displayName: m.displayName, contextWindow: m.contextWindow, vision: m.vision, thinking: Object.keys(m.efforts).length > 0 }));
    return result; // 确定性内存目录；不读取端点，不声称网络发现通过。
  });
  on("fingerprint_check", a => { const p = provider(str(a, "providerId")); return { results: p.endpoints.map(e => ({ endpointId: e.id, url: e.baseUrl, status: "DEMO_NOT_CHECKED（未联网）" })) }; });

  on("sdk_list", () => copy(sdks));
  on("sdk_cli_candidates", () => copy(sdks.filter(s => s.enabled && s.installState === "installed")));
  on("sdk_versions", a => { const s = sdk(str(a, "sdkId")); return [s.version ?? "1.0.0-demo", "1.0.1-demo"]; });
  on("sdk_set_enabled", a => { sdk(str(a, "sdkId")).enabled = bool(a.enabled, "enabled"); return null; });
  on("sdk_run_job", a => {
    const s = sdk(str(a, "sdkId")), kind = str(a, "kind"); if (!["install", "uninstall"].includes(kind)) fail("未知 SDK 任务类型");
    if ([...jobs.values()].some(j => j.sdkId === s.id && ["queued", "running"].includes(j.phase))) fail("此 SDK 已有活动任务");
    if (jobs.size >= 64) fail("SDK 演示任务上限 64；刷新页面后重置");
    const version = a.version == null ? s.version ?? "1.0.1-demo" : text(a.version, "version", false, 80);
    if (!/^[A-Za-z0-9.+_-]+$/.test(version)) fail("SDK 版本包含非法字符");
    const id = uid("SDKJOB"), j: SdkJob = { id, sdkId: s.id, kind, phase: "queued", error: null, logs: [LABEL, "任务排队：不调用包管理器。"], createdAt: now(), updatedAt: now() };
    jobs.set(id, j);
    const start = setTimeout(() => { if (j.phase === "queued") { j.phase = "running"; j.logs.push("合成状态推进中。 "); j.updatedAt += 50; } }, 50);
    const finish = setTimeout(() => {
      if (j.phase !== "running" && j.phase !== "queued") return;
      s.installState = kind === "install" ? "installed" : "not-installed"; s.version = kind === "install" ? version : null; s.path = kind === "install" ? `/demo/sdk/${s.id}` : null;
      j.phase = "done"; j.updatedAt += 200; j.logs.push("合成任务结束，未安装/卸载任何真实软件。"); stopJob(id);
    }, 200);
    const timeout = setTimeout(() => { if (["queued", "running"].includes(j.phase)) { j.phase = "timeout"; j.error = "内存任务超时（合成）"; stopJob(id); } }, 1000);
    jobTimers.set(id, [start, finish, timeout]); return id;
  });
  on("sdk_job", a => { const j = jobs.get(str(a, "jobId")); return j ? copy(j) : null; });
  on("sdk_cancel", a => { const id = str(a, "jobId"), j = jobs.get(id); if (!j) fail("SDK 任务不存在"); if (["queued", "running"].includes(j.phase)) { stopJob(id); j.phase = "cancelled"; j.logs.push("内存任务已取消。 "); } return null; });

  on("skill_list", () => copy(skills));
  on("skill_read", a => { const n = name(a.name, true); lookup(skills, n, s => s.name, "Skill"); return skillBodies.get(n)!; });
  on("skill_save", a => {
    const d = object(a.draft), n = name(d.name, true); unique(skills, n, s => s.name);
    const entry: SkillEntry = { id: uid("SKILL"), name: n, description: str(d, "description", true), enabled: true, sourceRef: `/demo/skills/${n}/SKILL.md`, builtin: false };
    const content = str(d, "content", true); skills.push(entry); skillBodies.set(n, `# ${n}\n\n> ${LABEL}\n\n${content}`); return null;
  });
  on("skill_delete", a => { const s = lookup(skills, name(a.name, true), s => s.name, "Skill"); if (s.builtin) fail("内置能力不能删除"); skills.splice(skills.indexOf(s), 1); skillBodies.delete(s.name); return null; });
  on("skill_set_enabled", a => { lookup(skills, name(a.name, true), s => s.name, "Skill").enabled = bool(a.enabled, "enabled"); return null; });
  on("tool_list", () => copy(tools));
  on("tool_set_enabled", a => { lookup(tools, str(a, "name"), t => t.name, "Tool").enabled = bool(a.enabled, "enabled"); return null; });
  on("mcp_list", () => copy(mcps));
  on("mcp_save", a => {
    const d = object(a.draft), old = d.id == null ? undefined : lookup(mcps, str(d, "id"), m => m.id, "MCP"), n = name(d.name, true); unique(mcps, n, m => m.name, old);
    const transport = str(d, "transport"); if (transport !== "stdio" && transport !== "http") fail("未知 MCP transport");
    const env = object(d.env, "env"); if (Object.keys(env).some(k => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))) fail("MCP 环境变量名无效");
    const next: McpServer = { id: old?.id ?? uid("MCP"), name: n, transport, command: transport === "stdio" ? str(d, "command") : null,
      args: strings(d.args, "args"), env: Object.fromEntries(Object.keys(env).map(k => [k, MASK])), url: transport === "http" ? demoUrl(d.url) : null,
      enabled: bool(d.enabled, "enabled"), tools: old ? copy(old.tools) : [], authStatus: old?.authStatus ?? "unauthenticated", authRevision: old?.authRevision ?? 0,
      authMode: transport === "http" ? (str(d, "authMode") === "bearer" ? "bearer" : str(d, "authMode") === "none" ? "none" : "oauth") : "oauth",
      allowInsecureLocalTls: transport === "http" && bool(d.allowInsecureLocalTls, "allowInsecureLocalTls") };
    if (old) mcps[mcps.indexOf(old)] = next; else mcps.push(next); return next.id;
  });
  on("mcp_delete", a => { const m = lookup(mcps, str(a, "id"), m => m.id, "MCP"); mcps.splice(mcps.indexOf(m), 1); return null; });
  on("mcp_set_enabled", a => { lookup(mcps, str(a, "id"), m => m.id, "MCP").enabled = bool(a.enabled, "enabled"); return null; });
  on("mcp_discover_tools", a => { const m = lookup(mcps, str(a, "serverId"), m => m.id, "MCP"); if (!m.enabled) fail("MCP 已禁用"); if (!m.tools.length) m.tools = [{ name: "demo.inspect", description: "合成工具目录；未启动进程或网络" }]; return copy(m.tools) satisfies McpToolInfo[]; });

  on("chat_sessions", a => { if (a.projectId != null) projectById(str(a, "projectId")); return copy(sessions.filter(s => s.projectId === (a.projectId ?? null)).sort((a, b) => b.updatedAt - a.updatedAt)); });
  on("chat_session_create", a => copy(newSession(a)));
  on("chat_session_get", a => copy(session(str(a, "id"))));
  on("chat_session_update", a => {
    const s = session(str(a, "id")); if (turns.has(s.id) && ["cliId", "providerId", "modelId", "effort"].some(k => k in a)) fail("合成发送中不能修改执行配置");
    const next = copy(s);
    for (const k of ["title", "draft", "cliId", "providerId", "modelId", "effort", "unread"] as const) if (a[k] !== undefined) {
      if (a[k] === null && k !== "title" && k !== "draft") next[k] = null;
      else { const v = text(a[k], k, k !== "title", k === "draft" ? 20000 : 500); if (k === "title" || k === "draft") next[k] = v; else next[k] = v || null; }
    }
    validateSession(next); Object.assign(s, next, { updatedAt: now() }); return null;
  });
  on("chat_session_delete", a => { const s = session(str(a, "id")); if (turns.has(s.id)) fail("先停止活动合成会话再删除"); sessions.splice(sessions.indexOf(s), 1); messages.delete(s.id); return null; });
  on("chat_messages", a => { const s = session(str(a, "sessionId")); return copy(messages.get(s.id)!); });
  on("chat_status", a => { const s = session(str(a, "id")); return turns.has(s.id); });
  on("chat_send", chatSend);
  on("chat_abort", a => { const s = session(str(a, "sessionId")); const turn = turns.get(s.id); if (turn) turn.aborted = true; return null; });
  on("chat_approve_tool", () => fail("没有真实工具审批；预置工具结果与发送均为内存仿真"));

  on("kb_list", () => copy(libraries));
  on("kb_save", a => {
    const n = name(a.name); unique(libraries, n, l => l.name); const root = absolute(a.sourceRef);
    if (!root.startsWith("/demo/knowledge/")) fail("知识源必须位于 /demo/knowledge/...，不读取磁盘");
    if (libraries.some(l => l.sourceRef === root || l.sourceRef.startsWith(`${root}/`) || root.startsWith(`${l.sourceRef}/`))) fail("知识库源不能重叠");
    const id = uid("KB"); libraries.push({ id, name: n, sourceKind: "directory", sourceRef: root, enabled: true, noteCount: 0, revision: 1, icon: null, iconColor: null }); notes.set(id, []); assets.set(id, []); knowledgeDirs.set(id, new Set([""])); return id;
  });
  on("kb_delete", a => { const l = library(str(a, "id")); libraries.splice(libraries.indexOf(l), 1); notes.delete(l.id); assets.delete(l.id); knowledgeDirs.delete(l.id); for (const set of grants.values()) set.delete(l.id); return null; });
  // CR-051：库图标（与项目共用 50 个白名单）、色卡（10 色）与头像风格（a–e）。
  on("kb_set_icon", a => {
    const l = library(str(a, "id"));
    const raw = a.icon;
    const value = raw == null || raw === "" ? null : String(raw);
    if (value && !KB_ICON_IDS.includes(value as (typeof KB_ICON_IDS)[number])) fail(`非法知识库图标 id：${value}`);
    l.icon = value; l.revision++;
    return null;
  });
  on("kb_set_icon_color", a => {
    const l = library(str(a, "id"));
    const raw = a.iconColor;
    const value = raw == null || raw === "" ? null : String(raw);
    if (value && !ICON_COLORS.some(sw => sw.id === value)) fail(`非法背景色卡 id：${value}`);
    l.iconColor = value; l.revision++;
    return null;
  });
  on("get_avatar_image", () => (avatarImage ? { ...avatarImage } : { path: null, hash: null }));
  on("avatar_image_data", () => avatarImage?.path?.startsWith("data:") ? avatarImage.path : null);
  on("set_avatar_image", a => {
    const dataUrl = String(a.dataUrl ?? "");
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) fail("头像只支持 PNG、JPG 或 WebP");
    const bytes = Math.floor((dataUrl.split(",")[1] ?? "").length * 0.75);
    if (bytes > 200 * 1024) fail(`头像图片不能超过 200KB（当前 ${bytes} 字节）`);
    avatarImage = { path: "smoke://avatar/current.png", hash: String(bytes) };
    return { ...avatarImage };
  });
  on("clear_avatar_image", () => { avatarImage = null; return null; });
  on("save_avatar", a => { const value=String(a.style); if(!["a","b","c","d","e"].includes(value)) fail("头像风格无效"); const data=String(a.dataUrl ?? ""); avatarImage=data ? {path:data,hash:String(data.length)} : null; avatarStyle=value; return avatarImage ?? {path:null,hash:null}; });
  on("kb_set_appearance", a => { const l=library(str(a,"id")); const icon=a.icon==null||a.icon===""?null:String(a.icon); const color=a.iconColor==null||a.iconColor===""?null:String(a.iconColor); if(icon&&!KB_ICON_IDS.includes(icon)) fail("非法图标"); if(color&&!ICON_COLORS.some(c=>c.id===color)) fail("非法色卡"); l.icon=icon;l.iconColor=color;return null; });
  on("get_avatar_style", () => avatarStyle);
  on("set_avatar_style", a => {
    const value = String(a.style);
    if (!["a", "b", "c", "d", "e"].includes(value)) fail("头像风格必须是 a、b、c、d、e 之一");
    avatarStyle = value;
    return null;
  });
  on("kb_scan", a => { const l = enabledLibrary(str(a, "id")); refreshKnowledge(l); return l.noteCount; });
  on("kb_tree", a => noteTree(str(a, "id")));
  on("kb_read", a => copy(note(str(a, "libId"), str(a, "noteId"))));
  on("kb_create_folder", a => {
    const l = enabledLibrary(str(a, "id")), parent = knowledgeParent(l, a.parentRelativeUri);
    const rel = knowledgeTarget(l, parent, knowledgeName(a.name));
    knowledgeDirs.get(l.id)!.add(rel); l.revision++;
    return { noteId: `${l.id}:dir:${rel}`, title: rel.split("/").pop()!, relativeUri: rel, isDir: true, children: [] } satisfies NoteNode;
  });
  on("kb_create_markdown", a => {
    const l = enabledLibrary(str(a, "id")), parent = knowledgeParent(l, a.parentRelativeUri), fileName = knowledgeName(a.name);
    if (!/\.(md|markdown)$/i.test(fileName)) fail("新建仅允许 .md 或 .markdown 文件；前端在首保存前补扩展名");
    const rel = knowledgeTarget(l, parent, fileName), content = knowledgeText(a.content);
    const created: NoteContent = { noteId: uid("KD"), title: markdownTitle(fileName, content), relativeUri: rel, content, hash: knowledgeHash(encoder.encode(content)) };
    notes.get(l.id)!.push(created); refreshKnowledge(l);
    return copy(created); // 此命令只在首保存调用：新草稿此前不存在，也不改 grant。
  });
  on("kb_save_markdown", a => {
    const l = enabledLibrary(str(a, "id")), existing = note(l.id, str(a, "noteId")), expected = str(a, "expectedHash");
    if (expected !== knowledgeHash(encoder.encode(existing.content))) fail("基线 hash 冲突：原文已改变；未覆盖内存文件，当前草稿应保留");
    const content = knowledgeText(a.content);
    existing.content = content; existing.hash = knowledgeHash(encoder.encode(content));
    existing.title = markdownTitle(existing.relativeUri.split("/").pop()!, content); refreshKnowledge(l);
    return copy(existing); // 同步 compare-and-swap，在 await 前结束，两个同基线保存只有首个通过。
  });
  on("kb_upload_files", a => {
    const l = enabledLibrary(str(a, "id")); knowledgeParent(l, a.parentRelativeUri);
    // 安全确定性取消：不打开本机 picker，也不接受 sourcePath、File、URL 或额外字节。
    return { cancelled: true, items: [] } satisfies KnowledgeUploadResult;
  });
  on("kb_file_info", a => copy(knowledgeInfo(enabledLibrary(str(a, "id")), str(a, "noteId"))));
  on("kb_read_file", a => copy(knowledgeData(enabledLibrary(str(a, "id")), str(a, "noteId"))));
  on("kb_export_file", a => {
    knowledgeFile(enabledLibrary(str(a, "id")), str(a, "noteId"));
    return { cancelled: true, exported: false }; // 不弹真实 Save As，不创建 Blob/链接、不下载原件或假附件。
  });
  on("kb_search", a => searchNotes(strings(a.libIds, "libIds"), str(a, "query")));
  on("kb_grants", a => {
    const pid = a.projectId == null ? null : projectById(str(a, "projectId")).id;
    const result: LibraryGrant[] = libraries.map(l => ({ libraryId: l.id, libraryName: l.name, projectId: pid, readAllowed: pid !== null && (grants.get(pid)?.has(l.id) ?? false) })); return result;
  });
  on("kb_grant_set", a => { const p = projectById(str(a, "projectId")), l = library(str(a, "libraryId")), allowed = bool(a.readAllowed, "readAllowed"); const set = grants.get(p.id) ?? new Set<string>(); if (allowed) set.add(l.id); else set.delete(l.id); grants.set(p.id, set); return null; });
  on("kb_gateway", gateway);

  on("git_status", a => gitStatus(projectByRoot(a.repoPath)));
  on("git_branch_state", a => gitStatus(projectByRoot(a.repoPath)));
  function gitPaths(p: Project, a: Args): GitChange[] {
    const g = git(p), paths = strings(a.paths, "paths");
    if (paths.includes(".") || paths.includes("*")) return g.changes;
    const rels = paths.map(path => within(p.rootUri, path));
    return rels.map(path => lookup(g.changes, path, c => c.path, "Git 改动"));
  }
  on("git_stage", a => { const p = projectByRoot(a.repoPath); for (const c of gitPaths(p, a)) { c.staged = c.unstaged ?? c.staged; c.unstaged = null; c.untracked = false; } return null; });
  on("git_unstage", a => { const p = projectByRoot(a.repoPath); for (const c of gitPaths(p, a)) { c.unstaged = c.staged ?? c.unstaged; c.staged = null; c.untracked = !git(p).baseline.has(c.path); } return null; });
  on("git_discard", a => {
    const p = projectByRoot(a.repoPath), g = git(p), d = projectDisk(p);
    const selected = [...gitPaths(p, a)], before = new Map(d.files);
    for (const c of selected) { const body = g.baseline.get(c.path); if (body === undefined) d.files.delete(c.path); else put(d, c.path, body); }
    try { requirements(p); } catch (e) { d.files = before; throw e; }
    g.changes = g.changes.filter(c => !selected.includes(c)); return null;
  });
  on("git_commit", a => {
    const p = projectByRoot(a.repoPath), g = git(p), message = text(a.message, "message", false, 4000), selected = g.changes.filter(c => c.staged);
    if (!selected.length) fail("没有暂存的内存改动");
    const hash = `${p.id.slice(4)}${String(++seq).padStart(36, "0")}`;
    g.commits.unshift({ hash, short: hash.slice(0, 7), authorName: "林澈（虚构）", authorEmail: "lin.che@example.invalid", date: new Date(now()).toISOString(), parents: g.commits[0] ? [g.commits[0].hash] : [], subject: `${message.split("\n")[0]}（合成）`, body: LABEL, refs: [g.branch] });
    g.commitFiles.set(hash, selected.map(c => ({ path: c.path, oldPath: c.oldPath, status: c.staged!, insertions: null, deletions: null })));
    for (const c of selected) { const body = projectDisk(p).files.get(c.path); if (body === undefined) g.baseline.delete(c.path); else g.baseline.set(c.path, body); }
    g.changes = g.changes.filter(c => !selected.includes(c)); return hash;
  });
  on("git_diff_file", a => { const p = projectByRoot(a.repoPath), g = git(p), path = within(p.rootUri, a.path); bool(a.staged, "staged"); return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${(g.baseline.get(path) ?? "").split("\n").join("\n-")}\n+${(projectDisk(p).files.get(path) ?? "").split("\n").join("\n+")}\n`; });
  on("git_branches", a => { const g = git(projectByRoot(a.repoPath)); const result: BranchEntry[] = g.branches.map(n => ({ name: n, kind: "local", current: n === g.branch, ahead: 1, behind: 0 })); result.push({ name: "origin/main", kind: "remote", current: false, ahead: null, behind: null }); return result; });
  on("git_switch_branch", a => { const g = git(projectByRoot(a.repoPath)), n = text(a.name, "branch", false, 100); if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(n) || n.includes("..") || n.endsWith("/")) fail("分支名无效"); const create = bool(a.create, "create"); if (create) { if (g.branches.includes(n)) fail("同名分支已存在"); g.branches.push(n); } else if (!g.branches.includes(n)) fail("分支不存在"); g.branch = n; return null; });
  on("git_log", a => { const g = git(projectByRoot(a.repoPath)), skip = integer(a.skip, 0, 0, 10000), limit = integer(a.limit, 50, 1, 500); return copy(g.commits.slice(skip, skip + limit)); });
  on("git_commit_files", a => { const g = git(projectByRoot(a.repoPath)), hash = str(a, "hash"); lookup(g.commits, hash, c => c.hash, "合成提交"); return copy(g.commitFiles.get(hash) ?? []); });
  for (const command of ["git_fetch", "git_pull_ff_only", "git_push"]) on(command, a => { git(projectByRoot(a.repoPath)); return null; }); // 计数可复核的 no-op，无远端。

  on("server_list", () => copy(hosts));
  on("server_save", a => {
    const d = object(a.draft), old = d.id == null ? undefined : host(str(d, "id")), n = name(d.name); unique(hosts, n, h => h.name, old);
    const address = str(d, "host"); if (!/^(192\.0\.2|198\.51\.100|203\.0\.113)\.(\d{1,3})$/.test(address) && !/^[a-z0-9.-]+\.invalid$/i.test(address)) fail("主机只能使用文档 IP 或 *.invalid；不保存真实主机凭据");
    if (/^\d/.test(address) && Number(address.split(".").pop()) > 255) fail("文档 IP 无效");
    const authType = str(d, "authType"); if (!["key", "password", "none"].includes(authType)) fail("未知认证方式");
    const h: ServerHost = { id: old?.id ?? uid("SRV"), name: n, host: address, port: integer(d.port, 22, 1, 65535), username: name(d.username, true), authType: authType as ServerHost["authType"], groupTag: d.groupTag == null ? null : str(d, "groupTag", true), connected: false };
    if (old) { if (old.connected) fail("先断开内存主机再修改"); hosts[hosts.indexOf(old)] = h; } else { hosts.push(h); hostDisks.set(h.id, disk()); }
    // secret/keyPath 从不读取、不存储、不返回。
    return h.id;
  });
  on("server_delete", a => { const h = host(str(a, "id")); if (h.connected) fail("先断开合成连接再删除"); hosts.splice(hosts.indexOf(h), 1); hostDisks.delete(h.id); return null; });
  on("server_connect", a => { host(str(a, "hostId")).connected = true; return null; }); // 仅内存布尔状态，不发 SSH。
  on("server_disconnect", a => { const h = host(str(a, "hostId")); h.connected = false; for (const [id, term] of terminals) if (term.hostId === h.id) { term.channel.emit({ type: "exit", message: LABEL }); term.channel.close(); terminals.delete(id); } return null; });
  on("server_metrics", a => { const h = host(str(a, "hostId")); return copy(metrics[h.id] ?? { hostname: "DEMO-new-host", os: "未知（合成）", uptime: "未知", cpuCores: [], cpuAvg: 0, memTotalMb: 0, memUsedMb: 0, load1: 0 }); });
  on("server_tree", a => { const h = host(str(a, "hostId")); return listing(hostDisks.get(h.id)!, `/demo/servers/${h.id}`, hostPath(h, a.path)); });
  on("server_read_file", a => { const h = host(str(a, "hostId")); return read(hostDisks.get(h.id)!, hostPath(h, a.path)); });
  on("server_term_open", a => { const h = host(str(a, "hostId")); if (!h.connected) fail("先启用内存合成连接"); integer(a.cols, 80, 1, 500); integer(a.rows, 24, 1, 300); if (terminals.size >= 8) fail("最多 8 个内存终端"); const channel = channelWriter(a.channel), id = uid("TERM"); terminals.set(id, { hostId: h.id, channel }); channel.emit({ type: "data", data: `\r\n${LABEL}\r\n输入只回显，不运行任何命令。\r\nDEMO> ` }); return id; });
  function terminal(a: Args) { const h = host(str(a, "hostId")), t = terminals.get(str(a, "termId")); if (!h.connected || !t || t.hostId !== h.id) fail("终端不属于当前内存主机"); return t; }
  on("server_term_input", a => { terminal(a).channel.emit({ type: "data", data: str(a, "data", true).replace(/[\u001b\u0000]/g, "") }); return null; });
  on("server_term_resize", a => { terminal(a); integer(a.cols, 80, 1, 500); integer(a.rows, 24, 1, 300); return null; });
  on("server_term_close", a => { const id = str(a, "termId"), t = terminals.get(id); if (!t) fail("内存终端不存在"); t.channel.emit({ type: "exit", message: LABEL }); t.channel.close(); terminals.delete(id); return null; });
  on("server_exec", a => {
    const h = host(str(a, "hostId")); if (!h.connected) fail("主机未合成连接"); const command = text(a.command, "command", false, 2000);
    if (/rm\s|shutdown|reboot|mkfs|sudo|\||;|&&|>|curl|wget/i.test(command)) { const requestId = uid("APPROVAL"); approvals.set(requestId, { hostId: h.id, expires: Date.now() + 60000 }); return { needsApproval: true, requestId, risk: "high" } satisfies ExecResult; }
    return { needsApproval: false, exitCode: 0, output: `${LABEL}\n命令未执行；仅展示确定性内存响应。` } satisfies ExecResult;
  });
  on("server_exec_approved", a => { const id = str(a, "requestId"), approval = approvals.get(id); if (!approval) fail("审批不存在或已消费"); approvals.delete(id); if (Date.now() > approval.expires || !host(approval.hostId).connected) fail("审批过期或合成连接已断开"); return { needsApproval: false, exitCode: 0, output: `${LABEL}\n审批已在内存消费，命令仍未执行。` } satisfies ExecResult; });
  on("server_exec_reject", a => { const id = str(a, "requestId"); if (!approvals.delete(id)) fail("审批不存在或已消费"); return null; });

  return {
    async dispatch(command: string, raw?: InvokeArgs): Promise<unknown> {
      const handler = handlers[command]; if (!handler) fail(`未知命令 ${command}；已拒绝，无真实 IPC/API 回退`);
      const a = raw === undefined ? {} : object(raw);
      const result = await handler(a);
      if (result === undefined) fail(`命令 ${command} 返回 undefined；拒绝模糊成功与回退`);
      return result;
    },
    /** 只在显式预览安装时注入空白办公模型；不覆盖已有快照或草稿。 */
    async seedOffice(): Promise<void> {
      const office = await import("../modules/office/office-model");
      for (const p of projects.filter(p => p.kind === "work")) {
        const state = office.st(p.id);
        if (state.files.length || state.folders.length || state.loaded) { officeStates.set(p.id, state); continue; }
        const folders = new Map<string, string>();
        function ensureFolder(path: string): string | null {
          if (!path) return null;
          const found = folders.get(path); if (found) return found;
          const parts = path.split("/"), n = parts.pop()!;
          const parentId = ensureFolder(parts.join("/")), id = `OFD-${p.id}-${folders.size + 1}`;
          folders.set(path, id); state.folders.push({ id, projectId: p.id, parentId, name: n }); return id;
        }
        for (const [i, f] of officeContent(p).entries()) {
          const parts = f.path.split("/"), n = parts.pop()!, folderId = ensureFolder(parts.join("/"));
          const file: OfficeFile = { id: `OFF-${p.id}-${i + 1}`, projectId: p.id, folderId, name: n, readonly: f.readonly, content: copy(f.content), draft: null,
            versions: f.path.endsWith(".pptx") ? 1 : 0, history: f.path.endsWith(".pptx") ? [{ number: 1, content: copy(f.content), savedAt: STAMP }] : [], provenance: LABEL, updated: STAMP };
          state.files.push(file);
        }
        state.loaded = true; state.seq = 100; state.selectedFileId = state.files[0]?.id ?? null; state.selectedFolderId = state.files[0]?.folderId ?? null;
        officeStates.set(p.id, state);
      }
      office.officeNotify();
    },
  };
}

/**
 * 无模块级副作用。main 必须 await 本函数后再 setupInvoke/createRoot。
 * URL 是唯一 opt-in；禁止在真实 Tauri 上安装，以免把真实数据伪装成夹具。
 * 官方 v2.12.5 的签名是 mockWindows(current, ...others)，对应仅 ['main'] 窗口集合。
 */
export async function installDesignPreview(): Promise<void> {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).getAll("preview").length !== 1 || new URLSearchParams(window.location.search).get("preview") !== "design") fail("仅显式 URL ?preview=design 可以安装设计夹具");
  if (installed) {
    if (window.__TAURI_INTERNALS__ !== installed) fail("已安装夹具的 IPC 被替换，拒绝重复安装");
    return;
  }
  if (installing) return installing;
  if (window.__TAURI_INTERNALS__ != null || (window as Window & { isTauri?: boolean }).isTauri === true) fail("不能在真实或已有 Tauri 环境中安装设计夹具");
  installing = (async () => {
    const { mockIPC, mockWindows } = await import("@tauri-apps/api/mocks");
    const fixture = createFixture();
    mockIPC((command, args) => fixture.dispatch(command, args), { shouldMockEvents: true });
    mockWindows("main");
    const internals = window.__TAURI_INTERNALS__ as Internals;
    const mockedInvoke = internals.invoke;
    const events = new Set(["plugin:event|listen", "plugin:event|emit", "plugin:event|unlisten"]);
    // shouldMockEvents 内部的 switch 对未知事件命令会返回 undefined；在外层收紧。
    internals.invoke = async (command, args, options) => {
      calls.set(command, (calls.get(command) ?? 0) + 1);
      if (command.startsWith("plugin:event|") && !events.has(command)) fail(`未知事件命令 ${command}；已拒绝，无真实回退`);
      const value = await mockedInvoke(command, args, options);
      if (command === "plugin:event|unlisten" && value === undefined) return null; // 官方 void，显式成功。
      if (value === undefined) fail(`命令 ${command} 返回 undefined；已拒绝`);
      return value;
    };
    // 不使用 mockConvertFileSrc 的 asset.localhost URL，避免哪怕意外的外部资源请求。
    internals.convertFileSrc = () => IMAGE;
    installed = internals;
    Object.defineProperty(window as PreviewWindow, "__DESIGN_PREVIEW__", { value: true, writable: false, configurable: false, enumerable: true });
    await fixture.seedOffice();
  })();
  try { await installing; } finally { installing = null; }
}
