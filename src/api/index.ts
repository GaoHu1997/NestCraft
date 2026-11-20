/**
 * Tauri invoke 封装与类型（与 src-tauri/src/models.rs 对应）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

let _invoke: Invoke | null = null;

/** 初始化 invoke（Tauri 环境）或浏览器 mock（占位，未接后端时给出可见错误）。 */
export function setupInvoke() {
  // 动态导入避免浏览器直开时崩溃
  if (window.__TAURI_INTERNALS__) {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      _invoke = invoke as Invoke;
    });
  }
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    await new Promise((r) => setTimeout(r, 50));
    if (window.__TAURI_INTERNALS__) {
      const { invoke: inv } = await import("@tauri-apps/api/core");
      _invoke = inv as Invoke;
    }
  }
  if (!_invoke) {
    throw new Error("未在 Tauri 环境中运行（未找到 __TAURI_INTERNALS__）。请使用 npm run tauri dev 启动。");
  }
  const raw = await _invoke(cmd, args);
  if (/^(set_setting|set_theme|provider_(save|delete|set_disabled)|sdk_(set_enabled|run_job)|skill_(save|delete|set_enabled)|mcp_(save|delete|set_enabled)|tool_set_enabled)$/.test(cmd)) {
    window.dispatchEvent(new CustomEvent("app:settings-changed", { detail: { command: cmd } }));
  }
  if (/^(create_project|update_project|delete_project)$/.test(cmd)) {
    window.dispatchEvent(new CustomEvent("app:projects-changed", { detail: { command: cmd } }));
  }
  return raw as T;
}

// ---------- 通用 ----------

export const ping = () => invoke<string>("ping");
export const appDataDir = () => invoke<string>("app_data_dir");
export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string | null) => invoke<void>("set_setting", { key, value });
export const getTheme = () => invoke<string>("get_theme");
export const setThemeCmd = (theme: string) => invoke<void>("set_theme", { theme });

// ---------- 软件更新（CR-046） ----------

export interface UpdateAsset {
  url: string;
  mirrors: string[];
  sha256: string;
  size: number;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  installer?: UpdateAsset | null;
  portable?: UpdateAsset | null;
}

export type UpdateKind = "installed" | "portable" | "unsupported";

export interface UpdateEnvironment {
  kind: UpdateKind;
  current_version: string;
  exe_path: string;
  updatable: boolean;
}

export interface UpdateCheckResult {
  current_version: string;
  update_available: boolean;
  manifest: UpdateManifest | null;
  asset: UpdateAsset | null;
  message: string;
}

export interface UpdateStatus {
  phase: "idle" | "downloading" | "verifying" | "ready" | "applying" | "unsupported" | string;
  done: number;
  total: number;
  speed: number;
  message: string;
  staged_file: string | null;
  kind: UpdateKind | string;
  version: string | null;
}

export const updateEnvironment = () => invoke<UpdateEnvironment>("update_environment");
export const updateCheck = () => invoke<UpdateCheckResult>("update_check");
export const updateDownload = (expectedVersion: string, expectedSha256: string) =>
  invoke<string>("update_download", { expectedVersion, expectedSha256 });
export const updateStatus = () => invoke<UpdateStatus>("update_status");
export const updateApply = (expectedSha256: string | null) =>
  invoke<void>("update_apply", { expectedSha256 });

// ---------- 项目 ----------

export interface Project {
  id: string;
  name: string;
  kind: "code" | "work";
  rootUri: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequirementNode {
  entityId: string;
  kind: "vision" | "epic" | "feature" | "story" | "bug";
  parentId: string | null;
  title: string;
  status: string | null;
  owner: string | null;
  sourceUri: string;
  children: RequirementNode[];
}

export const listProjects = () => invoke<Project[]>("list_projects");
export const createProject = (name: string, kind: string, rootUri: string) =>
  invoke<Project>("create_project", { name, kind, rootUri });
export const deleteProject = (id: string) => invoke<void>("delete_project", { id });
export const updateProject = (id: string, name: string, rootUri?: string) =>
  invoke<Project>("update_project", { id, name, rootUri: rootUri ?? null });
export const pickProjectDirectory = () => invoke<string | null>("pick_project_directory");
export const readRequirements = (projectId: string) =>
  invoke<RequirementNode[]>("read_requirements", { projectId });
export interface RequirementSource {
  sourceUri: string;
  node: RequirementNode | null;
  error: string | null;
  warning: string | null;
}
export interface RequirementSources {
  rootUri: string;
  sources: RequirementSource[];
  warnings: string[];
}
export const readRequirementSources = (projectId: string) => invoke<RequirementSources>("read_requirement_sources", { projectId });

export const readDoc = (sourceUri: string) => invoke<string>("read_doc", { sourceUri });
export const writeDoc = (sourceUri: string, content: string) => invoke<void>("write_doc", { sourceUri, content });
/** 在 app_data 下确保子目录存在并返回规范绝对路径（办公演示项目容器目录用） */
export const appDataEnsureDir = (rel: string) => invoke<string>("app_data_ensure_dir", { rel });

// ---------- 文件系统 ----------

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

export const fsListDir = (rootUri: string, relPath: string) =>
  invoke<FileNode[]>("fs_list_dir", { rootUri, relPath });
export const fsListTree = (rootUri: string, maxDepth?: number) =>
  invoke<FileNode[]>("fs_list_tree", { rootUri, maxDepth });
export const fsReadFile = (rootUri: string, path: string) => invoke<string>("fs_read_file", { rootUri, path });
export const fsWriteFile = (rootUri: string, path: string, content: string) =>
  invoke<void>("fs_write_file", { rootUri, path, content });
export const fsDeleteFile = (rootUri: string, path: string) => invoke<void>("fs_delete_file", { rootUri, path });
export interface SearchHit {
  path: string;
  lineNo: number;
  lineText: string;
}
export const fsSearch = (rootUri: string, query: string, limit?: number) =>
  invoke<SearchHit[]>("fs_search", { rootUri, query, limit });

// ---------- Git ----------

export interface GitChange {
  path: string;
  oldPath: string | null;
  staged: string | null;
  unstaged: string | null;
  untracked: boolean;
}

export interface GitStatus {
  repoRoot: string;
  state: "ready" | "no-repo" | "detached" | "error";
  branch: string | null;
  headOid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  changes: GitChange[];
}

export interface BranchEntry {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  ahead: number | null;
  behind: number | null;
}

export interface CommitEntry {
  hash: string;
  short: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parents: string[];
  subject: string;
  body: string;
  refs: string[];
}

export interface CommitFileEntry {
  path: string;
  oldPath: string | null;
  status: string;
  insertions: number | null;
  deletions: number | null;
}

export const gitStatus = (repoPath: string) => invoke<GitStatus>("git_status", { repoPath });
export const gitStage = (repoPath: string, paths: string[]) => invoke<void>("git_stage", { repoPath, paths });
export const gitUnstage = (repoPath: string, paths: string[]) => invoke<void>("git_unstage", { repoPath, paths });
export const gitDiscard = (repoPath: string, paths: string[]) => invoke<void>("git_discard", { repoPath, paths });
export const gitCommit = (repoPath: string, message: string) => invoke<string>("git_commit", { repoPath, message });
export const gitDiffFile = (repoPath: string, path: string, staged: boolean) =>
  invoke<string>("git_diff_file", { repoPath, path, staged });
export const gitBranches = (repoPath: string) => invoke<BranchEntry[]>("git_branches", { repoPath });
export const gitSwitchBranch = (repoPath: string, name: string, create: boolean) =>
  invoke<void>("git_switch_branch", { repoPath, name, create });
export const gitLog = (repoPath: string, limit?: number, skip?: number) =>
  invoke<CommitEntry[]>("git_log", { repoPath, limit, skip });
export const gitCommitFiles = (repoPath: string, hash: string) =>
  invoke<CommitFileEntry[]>("git_commit_files", { repoPath, hash });
export const gitFetch = (repoPath: string) => invoke<void>("git_fetch", { repoPath });
export const gitPullFfOnly = (repoPath: string) => invoke<void>("git_pull_ff_only", { repoPath });
export const gitPush = (repoPath: string) => invoke<void>("git_push", { repoPath });
export const gitBranchState = (repoPath: string) => invoke<GitStatus>("git_branch_state", { repoPath });

// ---------- 模型供应商 ----------

export type EffortMap = Record<string, string | null>;

export interface Provider {
  id: string;
  name: string;
  protocol: "anthropic" | "openai";
  disabled: boolean;
  headersJson: string | null;
  fingerprintJson: string | null;
  keys: ProviderKey[];
  endpoints: ProviderEndpoint[];
  models: ModelConfig[];
}

export interface ProviderKey {
  id: string;
  alias: string | null;
  masked: string;
  enabled: boolean;
}

export interface ProviderEndpoint {
  id: string;
  protocol: string;
  baseUrl: string;
  enabled: boolean;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  text: boolean;
  vision: boolean;
  imageGen: boolean;
  efforts: EffortMap;
  defaultEffort: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface ModelCandidate {
  providerId: string;
  providerName: string;
  protocol: string;
  modelRowId: string;
  modelId: string;
  displayName: string;
  vision: boolean;
  defaultEffort: string | null;
  efforts: EffortMap;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface ProviderDraft {
  id?: string;
  name: string;
  protocol: "anthropic" | "openai";
  disabled: boolean;
  headersJson: string | null;
  keys: { id?: string; alias?: string; secret?: string; enabled: boolean }[];
  endpoints: { id?: string; protocol: string; baseUrl: string; enabled: boolean }[];
  models: {
    id?: string;
    modelId: string;
    displayName: string;
    text: boolean;
    vision: boolean;
    imageGen: boolean;
    efforts: EffortMap;
    defaultEffort: string | null;
    contextWindow: number | null;
    maxTokens: number | null;
  }[];
}

export const providerList = () => invoke<Provider[]>("provider_list");
export const providerSave = (draft: ProviderDraft) => invoke<string>("provider_save", { draft });
export const providerDelete = (id: string) => invoke<void>("provider_delete", { id });
export const providerSetDisabled = (id: string, disabled: boolean) =>
  invoke<void>("provider_set_disabled", { id, disabled });
export const modelCandidates = () => invoke<ModelCandidate[]>("model_candidates");
export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  vision: boolean | null;
  thinking: boolean | null;
}
export const providerDiscoverModels = (providerId: string) =>
  invoke<DiscoveredModel[]>("provider_discover_models", { providerId });
export const fingerprintCheck = (providerId: string) =>
  invoke<{ results: { endpointId: string; url: string; status: string }[] }>("fingerprint_check", { providerId });

// ---------- SDK ----------

export interface SdkState {
  id: string;
  package: string;
  enabled: boolean;
  installState: "installed" | "not-installed" | "checking" | "error";
  version: string | null;
  path: string | null;
}

export interface SdkJob {
  id: string;
  sdkId: string;
  kind: string;
  phase: "queued" | "running" | "done" | "failed" | "cancelled" | "timeout";
  error: string | null;
  logs: string[];
  createdAt: number;
  updatedAt: number;
}

export const sdkList = () => invoke<SdkState[]>("sdk_list");
export const sdkRunJob = (sdkId: string, kind: "install" | "uninstall", version?: string) =>
  invoke<string>("sdk_run_job", { sdkId, kind, version });
export const sdkJob = (jobId: string) => invoke<SdkJob | null>("sdk_job", { jobId });
export const sdkCancel = (jobId: string) => invoke<void>("sdk_cancel", { jobId });
export const sdkVersions = (sdkId: string) => invoke<string[]>("sdk_versions", { sdkId });
export const sdkSetEnabled = (sdkId: string, enabled: boolean) =>
  invoke<void>("sdk_set_enabled", { sdkId, enabled });
export const sdkCliCandidates = () => invoke<SdkState[]>("sdk_cli_candidates");

// ---------- 能力 ----------

export interface SkillEntry {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sourceRef: string;
  builtin: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string | null;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
  tools: McpToolInfo[];
}

export interface ToolEntry {
  id: string;
  name: string;
  description: string | null;
  risk: "low" | "medium" | "high";
  enabled: boolean;
  builtin: boolean;
}

export const skillList = () => invoke<SkillEntry[]>("skill_list");
export const skillSave = (draft: { name: string; description: string; content: string }) =>
  invoke<void>("skill_save", { draft });
export const skillDelete = (name: string) => invoke<void>("skill_delete", { name });
export const skillSetEnabled = (name: string, enabled: boolean) =>
  invoke<void>("skill_set_enabled", { name, enabled });
export const skillRead = (name: string) => invoke<string>("skill_read", { name });
export const toolList = () => invoke<ToolEntry[]>("tool_list");
export const toolSetEnabled = (name: string, enabled: boolean) =>
  invoke<void>("tool_set_enabled", { name, enabled });
export const mcpList = () => invoke<McpServer[]>("mcp_list");
export const mcpSave = (draft: {
  id?: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  enabled: boolean;
}) => invoke<string>("mcp_save", { draft });
export const mcpDelete = (id: string) => invoke<void>("mcp_delete", { id });
export const mcpSetEnabled = (id: string, enabled: boolean) => invoke<void>("mcp_set_enabled", { id, enabled });
export const mcpDiscoverTools = (serverId: string) => invoke<McpToolInfo[]>("mcp_discover_tools", { serverId });

// ---------- AI 会话 ----------

export interface SessionMeta {
  id: string;
  projectId: string | null;
  serverId: string | null;
  title: string;
  cliId: string | null;
  providerId: string | null;
  modelId: string | null;
  effort: string | null;
  draft: string;
  unread: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** CR-047：执行会话绑定唯一特性；普通会话为空。 */
  featureId?: string | null;
  featureTitle?: string | null;
  featureSourceHash?: string | null;
  /** ordinary（普通聊天）| executor（单特性执行会话）。 */
  sessionRole?: "ordinary" | "executor";
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  metaJson: string | null;
  refsJson: string | null;
  gitContextJson: string | null;
  createdAt: number;
}

export type ChatEvent =
  | { type: "delta"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "toolUse"; toolId: string; name: string; inputJson: string }
  | { type: "toolResult"; toolId: string; content: string; isError: boolean }
  | { type: "approvalRequest"; requestId: string; toolName: string; inputJson: string; risk: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: "subagent"; id: string; task: string; status: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionRef: string | null };

export interface ContextRef {
  kind: "file" | "requirement" | "knowledge" | "session" | "command" | "skill";
  objectId: string;
  display: string;
  libraryId?: string | null;
  /** 办公文件引用携带的合成内容快照（objectId 形如 office:<fileId>），随提示词注入（CR-043） */
  content?: string | null;
}

export interface AttachmentMeta {
  name: string;
  mime?: string | null;
  byteSize?: number | null;
}

export const chatSessions = (projectId?: string) =>
  invoke<SessionMeta[]>("chat_sessions", { projectId: projectId ?? null });
export const chatSessionCreate = (args: {
  projectId?: string;
  serverId?: string;
  cliId?: string;
  providerId?: string;
  modelId?: string;
  effort?: string;
  /** CR-047：显式绑定执行特性；绑定后不可更改。 */
  featureId?: string;
}) => invoke<SessionMeta>("chat_session_create", args);
export const chatSessionGet = (id: string) => invoke<SessionMeta>("chat_session_get", { id });
export const chatSessionUpdate = (args: {
  id: string;
  title?: string;
  draft?: string;
  cliId?: string;
  providerId?: string;
  modelId?: string;
  effort?: string;
  unread?: string;
}) => invoke<void>("chat_session_update", args);
export const chatSessionDelete = (id: string) => invoke<void>("chat_session_delete", { id });
export const chatMessages = (sessionId: string) => invoke<ChatMessage[]>("chat_messages", { sessionId });
export const chatAbort = (sessionId: string) => invoke<void>("chat_abort", { sessionId });
export const chatStatus = (id: string) => invoke<boolean>("chat_status", { id });
export const chatApproveTool = (requestId: string, decision: string) =>
  invoke<void>("chat_approve_tool", { requestId, decision });
export const chatSend = (
  payload: { sessionId: string; content: string; refs: ContextRef[]; attachments: AttachmentMeta[]; permissionId?: string },
  onEvent: (ev: ChatEvent) => void
) => {
  // Channel 由 @tauri-apps/api/core 的 Channel 提供
  return import("@tauri-apps/api/core").then(({ invoke: inv, Channel }) => {
    const ch = new Channel<ChatEvent>();
    ch.onmessage = onEvent;
    return inv<void>("chat_send", { payload, channel: ch });
  });
};

// ---------- 服务器 ----------

export interface ServerHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "none";
  groupTag: string | null;
  connected: boolean;
}

export interface HostMetrics {
  hostname: string;
  os: string;
  uptime: string;
  cpuCores: number[];
  cpuAvg: number;
  memTotalMb: number;
  memUsedMb: number;
  load1: number;
}

export const serverList = () => invoke<ServerHost[]>("server_list");
export const serverSave = (draft: {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "none";
  secret?: string;
  keyPath?: string;
  groupTag?: string;
}) => invoke<string>("server_save", { draft });
export const serverDelete = (id: string) => invoke<void>("server_delete", { id });
export const serverConnect = (hostId: string) => invoke<void>("server_connect", { hostId });
export const serverDisconnect = (hostId: string) => invoke<void>("server_disconnect", { hostId });
export const serverTermOpen = (
  hostId: string,
  cols: number,
  rows: number,
  onData: (data: string) => void
) => {
  return import("@tauri-apps/api/core").then(({ invoke: inv, Channel }) => {
    const ch = new Channel<{ type: "data" | "exit"; data?: string; message?: string }>();
    ch.onmessage = (ev) => {
      if (ev.type === "data" && ev.data) onData(ev.data);
    };
    return inv<string>("server_term_open", { hostId, cols, rows, channel: ch });
  });
};
export const serverTermInput = (hostId: string, termId: string, data: string) =>
  invoke<void>("server_term_input", { hostId, termId, data });
export const serverTermResize = (hostId: string, termId: string, cols: number, rows: number) =>
  invoke<void>("server_term_resize", { hostId, termId, cols, rows });
export const serverTermClose = (termId: string) => invoke<void>("server_term_close", { termId });
export const serverTree = (hostId: string, path: string) => invoke<FileNode[]>("server_tree", { hostId, path });
export const serverReadFile = (hostId: string, path: string) =>
  invoke<string>("server_read_file", { hostId, path });
export interface ExecResult {
  needsApproval: boolean;
  requestId?: string;
  risk?: string;
  exitCode?: number;
  output?: string;
}
export const serverExec = (hostId: string, command: string) => invoke<ExecResult>("server_exec", { hostId, command });
export const serverExecApproved = (requestId: string) => invoke<ExecResult>("server_exec_approved", { requestId });
export const serverExecReject = (requestId: string) => invoke<void>("server_exec_reject", { requestId });
export const serverMetrics = (hostId: string) => invoke<HostMetrics>("server_metrics", { hostId });

// ---------- 知识库 ----------

export interface KnowledgeLibrary {
  id: string;
  name: string;
  sourceKind: string;
  sourceRef: string;
  enabled: boolean;
  noteCount: number;
  revision: number;
}

export interface NoteNode {
  noteId: string;
  title: string;
  relativeUri: string;
  isDir: boolean;
  children: NoteNode[];
}

export interface NoteContent {
  noteId: string;
  title: string;
  relativeUri: string;
  content: string;
  hash?: string;
  indexError?: string;
}

export interface KnowledgeFileInfo {
  noteId: string;
  title: string;
  relativeUri: string;
  sizeBytes: number;
  modifiedAt?: number;
  kind: "markdown" | "text" | "image" | "pdf" | "attachment";
  mime: string;
  previewSupported: boolean;
  editable: boolean;
  hash?: string;
}

export interface KnowledgeFileData {
  info: KnowledgeFileInfo;
  text?: string;
  base64?: string;
}

export interface KnowledgeUploadResult {
  cancelled: boolean;
  items: { name: string; success: boolean; noteId?: string; relativeUri?: string; error?: string; indexError?: string }[];
}

export interface KnowledgeHit {
  libraryId: string;
  libraryName: string;
  noteId: string;
  title: string;
  relativeUri: string;
  snippet: string;
}

export interface LibraryGrant {
  libraryId: string;
  libraryName: string;
  projectId: string | null;
  readAllowed: boolean;
}

export const kbList = () => invoke<KnowledgeLibrary[]>("kb_list");
export const kbSave = (name: string, sourceRef: string) => invoke<string>("kb_save", { name, sourceRef });
export const kbDelete = (id: string) => invoke<void>("kb_delete", { id });
export const kbScan = (id: string) => invoke<number>("kb_scan", { id });
export const kbTree = (id: string) => invoke<NoteNode[]>("kb_tree", { id });
export const kbRead = (libId: string, noteId: string) => invoke<NoteContent>("kb_read", { libId, noteId });
export const kbCreateFolder = (id: string, parentRelativeUri: string, name: string) =>
  invoke<NoteNode>("kb_create_folder", { id, parentRelativeUri, name });
export const kbCreateMarkdown = (id: string, parentRelativeUri: string, name: string, content: string) =>
  invoke<NoteContent>("kb_create_markdown", { id, parentRelativeUri, name, content });
export const kbSaveMarkdown = (id: string, noteId: string, expectedHash: string, content: string) =>
  invoke<NoteContent>("kb_save_markdown", { id, noteId, expectedHash, content });
export const kbUploadFiles = (id: string, parentRelativeUri: string) =>
  invoke<KnowledgeUploadResult>("kb_upload_files", { id, parentRelativeUri });
export const kbFileInfo = (id: string, noteId: string) => invoke<KnowledgeFileInfo>("kb_file_info", { id, noteId });
export const kbReadFile = (id: string, noteId: string) => invoke<KnowledgeFileData>("kb_read_file", { id, noteId });
export const kbExportFile = (id: string, noteId: string) =>
  invoke<{ cancelled: boolean; exported: boolean }>("kb_export_file", { id, noteId });
export const kbSearch = (libIds: string[], query: string) => invoke<KnowledgeHit[]>("kb_search", { libIds, query });
export const kbGrants = (projectId?: string) => invoke<LibraryGrant[]>("kb_grants", { projectId: projectId ?? null });
export const kbGrantSet = (projectId: string, libraryId: string, readAllowed: boolean) =>
  invoke<void>("kb_grant_set", { projectId, libraryId, readAllowed });
export const kbGateway = (args: { projectId?: string | null; tool: string; argsJson?: string }) =>
  invoke<unknown>("kb_gateway", {
    projectId: args.projectId ?? null,
    tool: args.tool,
    argsJson: args.argsJson ?? null,
  });
