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
  if (/^(set_setting|set_theme|provider_(save|delete|set_disabled)|sdk_(set_enabled|run_job)|skill_(save|delete|set_enabled|import_folder)|mcp_(save|delete|set_enabled|import_source)|tool_set_enabled)$/.test(cmd)) {
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
  /** CR-051：内置图标 id（项目与知识库共用 50 个白名单）；null 按类型推导显示。 */
  icon: string | null;
  /** CR-051 r6：背景色卡 id（10 色之一）；null 按类型默认，旧项目保持原显示。 */
  iconColor: string | null;
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
/**
 * CR-051：icon / iconColor 参数缺省（undefined）=保持不变；null=清空回默认；
 * 字符串=50 个内置图标之一 / 10 个色卡之一（非法 id 服务端拒绝）。
 */
export const updateProject = (id: string, name: string, rootUri?: string, icon?: string | null, iconColor?: string | null) =>
  invoke<Project>("update_project", {
    id,
    name,
    rootUri: rootUri ?? null,
    ...(icon === undefined ? {} : { icon: icon === null ? "" : icon }),
    ...(iconColor === undefined ? {} : { iconColor: iconColor === null ? "" : iconColor }),
  });
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

/** CR-067：提交历史筛选（服务端执行，避免只在已加载页内过滤）。 */
export interface GitLogFilters {
  all?: boolean;
  /** CR-067：指定单分支/引用查询（优先于 all）。 */
  branch?: string;
  author?: string;
  since?: string;
}

/** CR-067：一个远程（名称 + fetch 地址）。 */
export interface RemoteEntry {
  name: string;
  url: string;
}

/** CR-067：国内加速配置。 */
export interface AccelConfig {
  enabled: boolean;
  url: string;
}

/** CR-067：密钥列表项，只含元信息，不含令牌。 */
export interface CredentialHostEntry {
  host: string;
  username: string;
  savedAt: string;
}

/** 当前仓库远端主机的令牌配置状态（不回传令牌）。 */
export interface GitCredentialStatus {
  host: string | null;
  credential: boolean;
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
export const gitLog = (repoPath: string, limit?: number, skip?: number, filters?: GitLogFilters) =>
  invoke<CommitEntry[]>("git_log", {
    repoPath,
    limit,
    skip,
    all: filters?.all,
    branch: filters?.branch,
    author: filters?.author,
    since: filters?.since,
  });
export const gitCommitFiles = (repoPath: string, hash: string) =>
  invoke<CommitFileEntry[]>("git_commit_files", { repoPath, hash });
export const gitFetch = (repoPath: string) => invoke<void>("git_fetch", { repoPath });
export const gitPullFfOnly = (repoPath: string) => invoke<void>("git_pull_ff_only", { repoPath });
export const gitPush = (repoPath: string) => invoke<void>("git_push", { repoPath });
export const gitBranchState = (repoPath: string) => invoke<GitStatus>("git_branch_state", { repoPath });

/* ---------- CR-067：远程 / 国内加速 / 按主机令牌 ---------- */

export const gitRemotes = (repoPath: string) => invoke<RemoteEntry[]>("git_remotes", { repoPath });
export const gitRemoteSave = (repoPath: string, name: string, url: string) =>
  invoke<void>("git_remote_save", { repoPath, name, url });
export const gitRemoteRemove = (repoPath: string, name: string) =>
  invoke<void>("git_remote_remove", { repoPath, name });
export const gitAccelGet = () => invoke<AccelConfig>("git_accel_get");
export const gitAccelSet = (enabled: boolean, url: string) =>
  invoke<AccelConfig>("git_accel_set", { enabled, url });
export const gitCredentialsList = () => invoke<CredentialHostEntry[]>("git_credentials_list");
/** 令牌只上行；返回条目不含令牌，列表与界面都不回显。 */
export const gitCredentialsSave = (host: string, token: string, username?: string) =>
  invoke<CredentialHostEntry>("git_credentials_save", { input: { host, token, username } });
export const gitCredentialsDelete = (host: string) =>
  invoke<void>("git_credentials_delete", { host });
export const gitCredentialStatus = (repoPath: string) =>
  invoke<GitCredentialStatus>("git_credential_status", { repoPath });

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
  /** CR-059：'' 沿用供应商默认；Chat/Responses → OpenAI 端点，Anthropic → Anthropic 端点。 */
  protocol: string;
  /** CR-059：该密钥可用模型（空 = 全部）。 */
  models: string[];
  /** CR-059：范围来源 auto / manual。 */
  scopeSource: string | null;
  /** CR-059：最近一次探测完成时间（毫秒）。 */
  probedAt: number | null;
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
  /** CR-059：供应商内展示与候选顺序。 */
  sortOrder: number;
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
  keys: {
    id?: string;
    alias?: string;
    secret?: string;
    enabled: boolean;
    protocol?: string;
    models?: string[];
    scopeSource?: string | null;
  }[];
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
    sortOrder?: number | null;
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
/** CR-059：单个模型的思考档位解析结果。 */
export interface EffortResolution {
  modelId: string;
  efforts: EffortMap;
  defaultEffort: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** vendor / knowledge / vendor+knowledge / none */
  source: string;
  note: string | null;
}
export const providerResolveEfforts = (providerId: string, modelIds: string[]) =>
  invoke<EffortResolution[]>("provider_resolve_efforts", { providerId, modelIds });

/** CR-059：按密钥探测模型范围的结果。served=null 表示未取到清单（保留原范围）。 */
export interface KeyProbeOutcome {
  keyId: string;
  alias: string | null;
  served: string[] | null;
  error: string | null;
}
export const providerProbeKeyScopes = (providerId: string) =>
  invoke<KeyProbeOutcome[]>("provider_probe_key_scopes", { providerId });

/** CR-059：生图配置。 */
export interface ImageCandidate {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  /** Anthropic 端点无 images 接口；false 时不可用。 */
  supported: boolean;
}
export interface ImageDefaults {
  size: string;
  quality: string;
  n: number;
  timeoutMin: number;
}
export interface ImageGenConfig {
  enabled: boolean;
  order: string[];
  defaults: ImageDefaults;
  outputDir: string;
  candidates: ImageCandidate[];
  unavailable: string[];
}
export const imageGenGet = () => invoke<ImageGenConfig>("image_gen_get");
export const imageGenSave = (config: ImageGenConfig) => invoke<void>("image_gen_save", { config });

export const fingerprintCheck = (providerId: string) =>
  invoke<{ results: { endpointId: string; url: string; status: string }[] }>("fingerprint_check", { providerId });

// ---------- CR-058 模型检测十九针探针 ----------

export type ProbeStatus = "pass" | "warn" | "fail" | "skip" | "na";
export interface ProbeItemState {
  code: string;
  name: string;
  status: ProbeStatus;
  ms: number;
  note: string;
}
export interface ProbeProgressEvent {
  type: "probe";
  index: number;
  code: string;
  name: string;
  phase: "running" | "settled";
  status?: ProbeStatus;
  ms?: number;
  note?: string;
}
export interface ProbeReport {
  type: "report";
  historyId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelDisplayName: string;
  protocol: string;
  score: number;
  grade: string;
  verdict: string;
  channel: string;
  summary: string;
  durationMs: number;
  items: ProbeItemState[];
}
export interface ProbeHistoryItem {
  id: string;
  providerName: string;
  modelId: string;
  modelDisplayName: string;
  protocol: string;
  score: number;
  grade: string;
  verdict: string;
  channel: string;
  summary: string;
  durationMs: number;
  items: ProbeItemState[];
  createdAt: number;
}
export const modelProbeRun = (providerId: string, modelId: string, onEvent: (ev: ProbeProgressEvent) => void) =>
  import("@tauri-apps/api/core").then(({ invoke: inv, Channel }) => {
    const ch = new Channel<ProbeProgressEvent>();
    ch.onmessage = onEvent;
    return inv<ProbeReport>("model_probe_run", { providerId, modelId, channel: ch });
  });
export const modelProbeHistoryList = () => invoke<ProbeHistoryItem[]>("model_probe_history_list");

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
/** CR-059 D5/E4：只读缓存快照（不 spawn npm），用于首帧渲染。 */
export interface SdkSnapshot { states: SdkState[]; checkedAt: number }
export const sdkSnapshot = () => invoke<SdkSnapshot>("sdk_snapshot");
/** CR-059 D5/E4：单项检测；force=false 且缓存新鲜（TTL 10 分钟）时由后端短路。 */
export const sdkDetectOne = (sdkId: string, force = false) =>
  invoke<SdkState>("sdk_detect_one", { sdkId, force });
export const sdkRunJob = (sdkId: string, kind: "install" | "uninstall", version?: string) =>
  invoke<string>("sdk_run_job", { sdkId, kind, version });
export const sdkJob = (jobId: string) => invoke<SdkJob | null>("sdk_job", { jobId });
export const sdkCancel = (jobId: string) => invoke<void>("sdk_cancel", { jobId });
export const sdkVersions = (sdkId: string) => invoke<string[]>("sdk_versions", { sdkId });
export const sdkSetEnabled = (sdkId: string, enabled: boolean) =>
  invoke<void>("sdk_set_enabled", { sdkId, enabled });
export const sdkCliCandidates = () => invoke<SdkState[]>("sdk_cli_candidates");

// ---------- CR-053：CLI 命令工具（Shell） ----------

export interface ShellCandidate {
  kind: "pwsh" | "windows-powershell" | "git-bash" | string;
  label: string;
  path: string | null;
  version: string | null;
  /** fixed（固定位置）| path（PATH 兜底） */
  source: string;
  available: boolean;
  detail: string | null;
}

export interface ShellSetting {
  mode: "auto" | "pwsh" | "windows-powershell" | "git-bash" | string;
  path: string | null;
  savedAt: number | null;
}

export interface ShellSettingView {
  setting: ShellSetting;
  /** 非 auto 且保存路径当前不存在（标红、禁用保存的依据）。 */
  missing: boolean;
}

export const cliShellCandidates = (cliId: string) =>
  invoke<ShellCandidate[]>("cli_shell_candidates", { cliId });
export const cliShellGet = (cliId: string) => invoke<ShellSettingView>("cli_shell_get", { cliId });
/** path 仅在非 auto 时提供；服务端复核失败会抛错，不会静默改回 auto。 */
export const cliShellSave = (cliId: string, mode: string, path?: string | null) =>
  invoke<ShellSetting>("cli_shell_save", { cliId, mode, path: path ?? null });

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
  authStatus: "unauthenticated" | "pending" | "authenticated" | "expired" | "revoked" | "error" | string;
  authRevision: number;
  authMode: "oauth" | "bearer" | "none" | string;
  allowInsecureLocalTls: boolean;
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
/** CR-059 F1：只读识别所选技能文件夹（是否有 SKILL.md、名称/说明/正文）。 */
export interface SkillFolderPreview {
  path: string;
  valid: boolean;
  name: string;
  slug: string;
  description: string;
  body: string;
}
export const skillFolderPreview = (path: string) => invoke<SkillFolderPreview>("skill_folder_preview", { path });
/** CR-059 F1/F3：整目录复制到受管技能目录（外部源删除不影响副本）。 */
export interface SkillImportResult { slug: string; copied: number; skipped: string[] }
export const skillImportFolder = (path: string, slug?: string) =>
  invoke<SkillImportResult>("skill_import_folder", { path, slug });
/** CR-059 F2：只读扫描其他 agent 的技能目录。 */
export interface SkillScanItem {
  agent: string; source: string; name: string; slug: string;
  description: string; imported: boolean; error: string | null;
}
export interface SkillScanGroup { agent: string; root: string; exists: boolean; items: SkillScanItem[] }
export const skillScanSources = () => invoke<SkillScanGroup[]>("skill_scan_sources");
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
  authMode?: "oauth" | "bearer" | "none";
  /** 仅写入受管密钥；保存后不回显。 */
  authToken?: string;
  allowInsecureLocalTls?: boolean;
}) => invoke<string>("mcp_save", { draft });
export const mcpDelete = (id: string) => invoke<void>("mcp_delete", { id });
export const mcpSetEnabled = (id: string, enabled: boolean) => invoke<void>("mcp_set_enabled", { id, enabled });
export const mcpDiscoverTools = (serverId: string) => invoke<McpToolInfo[]>("mcp_discover_tools", { serverId });
export const mcpAuthStart = (serverId: string) => invoke<{ status: string; authorizationUrl: string }>("mcp_auth_start", { serverId });
export const mcpAuthStatus = (serverId: string) => invoke<string>("mcp_auth_status", { serverId });
export const mcpAuthLogout = (serverId: string) => invoke<void>("mcp_auth_logout", { serverId });
/** CR-059 F4：只读扫描其他 agent 的 MCP 配置（env 只回键名，不回值）。 */
export interface McpScanItem {
  agent: string; source: string; name: string; transport: string;
  command: string | null; args: string[]; envKeys: string[]; url: string | null;
  imported: boolean; error: string | null;
}
export interface McpScanGroup { agent: string; root: string; exists: boolean; items: McpScanItem[] }
export const mcpScanSources = () => invoke<McpScanGroup[]>("mcp_scan_sources");
/** CR-059 F4：把扫描到的来源导入为受管配置（重名由后端拒绝）。 */
export const mcpImportSource = (agent: string, name: string) =>
  invoke<string>("mcp_import_source", { agent, name });

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
  /** CR-065：置顶时刻（毫秒）；0 表示未置顶。 */
  pinnedAt?: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** CR-047：执行会话绑定唯一特性；普通会话为空。 */
  featureId?: string | null;
  featureTitle?: string | null;
  featureSourceHash?: string | null;
  /** ordinary（普通聊天）| executor（单特性执行会话）。 */
  sessionRole?: "ordinary" | "executor";
  /** CR-037：原生绑定派生视图（无原引用，仅脱敏指纹）；执行会话/未绑定会话为 null。 */
  binding?: SessionBinding | null;
  /** CR-069：会话运行通道；cli=外部 CLI 进程作答，platform=平台主代理直答。缺省按 cli 处理。 */
  runner?: "cli" | "platform";
}

/** CR-037：binding.state = native（已绑定原线程）| fresh（已确认重建）| freshPending（待确认）| blocked（不可续接）。 */
export interface SessionBinding {
  state: "native" | "fresh" | "freshPending" | "blocked" | string;
  reasonCode: string | null;
  refFingerprint: string | null;
  expectedRevision: number;
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
  | { type: "subagent"; id: string; task: string; status: string; cli?: string | null; model?: string | null; durationMs?: number | null; tokens?: number | null; output?: string | null; parentId?: string | null; taskId?: string | null; content?: string | null; kind?: string | null; toolName?: string | null; isError?: boolean | null }
  | { type: "retrying"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "error"; message: string }
  /** CR-037：done 不再携带原 sessionRef；判定结果 + 脱敏指纹，前端据此更新绑定状态。 */
  | {
      type: "done";
      turnId?: string;
      nativeResumed?: boolean;
      freshContext?: boolean;
      blocked?: boolean;
      reasonCode?: string | null;
      refFingerprint?: string | null;
    };

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

/** CR-063：会话历史分页结果（游标为 updatedAt + id）。 */
export interface SessionPage {
  items: SessionMeta[];
  total: number;
  hasMore: boolean;
  nextCursor: { pinnedAt: number; updatedAt: number; id: string } | null;
}

/** CR-063/CR-065：游标分页 + 当前作用域标题搜索；limit 缺省 20，后端钳制到 1..100。 */
export const chatSessionsPage = (args: {
  projectId?: string;
  serverId?: string;
  keyword?: string;
  cursorPinnedAt?: number;
  cursorUpdatedAt?: number;
  cursorId?: string;
  limit?: number;
}) =>
  invoke<SessionPage>("chat_sessions_page", {
    projectId: args.projectId ?? null,
    serverId: args.serverId ?? null,
    keyword: args.keyword ?? null,
    cursorPinnedAt: args.cursorPinnedAt ?? null,
    cursorUpdatedAt: args.cursorUpdatedAt ?? null,
    cursorId: args.cursorId ?? null,
    limit: args.limit ?? null,
  });

/** CR-065：置顶/取消置顶；不改变 updatedAt。 */
export const chatSessionPin = (id: string, pinned: boolean) =>
  invoke<SessionMeta>("chat_session_pin", { id, pinned });

/** CR-065：分叉会话（复制消息上下文，不继承原生线程绑定）。 */
export const chatSessionFork = (id: string) =>
  invoke<SessionMeta>("chat_session_fork", { id });
export const chatSessionCreate = (args: {
  projectId?: string;
  serverId?: string;
  cliId?: string;
  providerId?: string;
  modelId?: string;
  effort?: string;
  /** CR-047：显式绑定执行特性；绑定后不可更改。 */
  featureId?: string;
  /** CR-069：新会话运行通道；缺省 cli（与后端 migrate_session_runner 默认一致）。 */
  runner?: "cli" | "platform";
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
  /** CR-069：切换运行通道；仅无消息且未运行的会话允许，后端校验。 */
  runner?: "cli" | "platform";
}) => invoke<void>("chat_session_update", args);
export const chatSessionDelete = (id: string) => invoke<void>("chat_session_delete", { id });
export const chatMessages = (sessionId: string) => invoke<ChatMessage[]>("chat_messages", { sessionId });
/** CR-037 AC-06：fresh 重建确认；CAS 失配（已有新轮）会抛错，前端刷新后重试。 */
export const chatSessionConfirmFresh = (sessionId: string, expectedBindingRevision: number, reasonCode?: string | null) =>
  invoke<void>("chat_session_confirm_fresh", { sessionId, expectedBindingRevision, reasonCode: reasonCode ?? null });
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

/** CR-059 二期：内置 AI 工具（ssh_exec）的跨进程待审批命令。 */
export interface PendingApproval {
  id: string;
  hostId: string;
  hostName: string | null;
  command: string;
  risk: string;
  createdAt: number;
}
export const serverPendingApprovals = () => invoke<PendingApproval[]>("server_pending_approvals");
/** 批准时命令在主应用侧执行，结果写回审批记录，供 AI 通过 ssh_exec_status 读取。 */
export const serverDecideApproval = (requestId: string, decision: "approve" | "reject") =>
  invoke<{ status: string; executed?: boolean; result?: unknown }>("server_decide_approval", { requestId, decision });
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
  /** CR-051：内置图标 id（8 个白名单之一）；null 按 sourceKind 推导显示。 */
  icon: string | null;
  /** CR-051 r6：背景色卡 id（10 色之一）；null 默认青绿。 */
  iconColor: string | null;
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
/** CR-051：icon 传 null=清空回来源默认；其余须为共用 50 个内置 id 之一（非法 id 服务端拒绝）。 */
export const kbSetIcon = (id: string, icon: string | null) => invoke<void>("kb_set_icon", { id, icon });

/** CR-051 r6：iconColor 传 null=清空回默认青绿；其余须为 10 个色卡之一。 */
export const kbSetIconColor = (id: string, iconColor: string | null) => invoke<void>("kb_set_icon_color", { id, iconColor });

/** CR-051 r6：自定义头像（本机文件引用 + hash）；未设置或引用失效时返回 null。 */
export interface AvatarImage { path: string | null; hash: string | null }
export const getAvatarImage = () => invoke<AvatarImage>("get_avatar_image");
/** 保存裁剪后的头像副本：≤200KB、PNG/JPG/WebP；返回新的引用与 hash。 */
export const setAvatarImage = (dataUrl: string, originalName?: string) =>
  invoke<AvatarImage>("set_avatar_image", { dataUrl, originalName: originalName ?? null });
export const clearAvatarImage = () => invoke<void>("clear_avatar_image");
/** 图片与风格同事务保存，空图片恢复内置。 */
export const saveAvatar = (dataUrl: string, style: string) => invoke<AvatarImage>("save_avatar", { dataUrl, style });
export const kbSetAppearance = (id: string, icon: string | null, iconColor: string | null) => invoke<void>("kb_set_appearance", { id, icon, iconColor });
/** CR-051 r6：读取已应用头像的 data URL（弹窗重开时继续拖动/缩放）；未设置或引用失效返回 null。 */
export const avatarImageData = () => invoke<string | null>("avatar_image_data");
/** CR-051 r6：本机头像路径 → WebView 可显示的 asset URL；data URL 与空值原样返回。
 *  经 __TAURI_INTERNALS__.convertFileSrc 转换（设计预览通道对该函数有 mock）。 */
export function avatarPhotoSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^data:/i.test(path)) return path;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string) => string } }).__TAURI_INTERNALS__;
  try {
    return internals?.convertFileSrc ? internals.convertFileSrc(path) : path;
  } catch {
    return path;
  }
}
/** CR-051：头像风格偏好（a–e，缺省 b）。 */
export const getAvatarStyle = () => invoke<string>("get_avatar_style");
export const setAvatarStyle = (style: string) => invoke<void>("set_avatar_style", { style });
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
export type KbTransferPhase = "queued" | "picking" | "copying" | "completed" | "failed" | "cancelled";

export interface KbTransferFile {
  name: string;
  relativeUri: string;
  noteId: string;
  bytes: string;
  sha256: string;
}

export interface KbTransferFailure {
  name: string;
  error: string;
}

/** CR-055 FEAT-008：GB 级原件传输任务。索引与原件是两次独立完成，`indexPending` 只表示原件已落盘。 */
export interface KbTransferTask {
  id: string;
  libraryId: string;
  kind: "import" | "export";
  phase: KbTransferPhase;
  /** 当前文件已复制字节（十进制字符串），多文件任务每个文件归零。 */
  processedBytes: string;
  /** 当前文件源字节；多文件时不代表任务总量。 */
  totalBytes: string | null;
  sha256: string | null;
  noteId: string | null;
  relativeUri: string | null;
  error: string | null;
  indexPending: boolean;
  cancelRequested: boolean;
  currentFile: string | null;
  fileIndex: number;
  fileTotal: number;
  completedFiles: KbTransferFile[];
  failedFiles: KbTransferFailure[];
}

export const kbTransferImport = (libraryId: string, parentUri: string, taskId: string) =>
  invoke<KbTransferTask>("kb_transfer_import", { libraryId, parentUri, taskId });
export const kbTransferExport = (libraryId: string, noteId: string, taskId: string) =>
  invoke<KbTransferTask>("kb_transfer_export", { libraryId, noteId, taskId });
export const kbTransferStatus = (taskId: string) => invoke<KbTransferTask>("kb_transfer_status", { taskId });
export const kbTransferCancel = (taskId: string) => invoke<KbTransferTask>("kb_transfer_cancel", { taskId });

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

// ---------- 任务执行与同步（FEAT-019 / FEAT-004 / CR-047） ----------

export interface ExecutionTask {
  id: string;
  projectId: string;
  batchId: string;
  storyId: string;
  featureId: string | null;
  status: string;
  revision: number;
  fencingToken: number;
  currentAttemptId: string | null;
  activeKeyHeld: boolean;
  stopPending: boolean;
  finalBlocked: boolean;
  blockedReason: string | null;
}

export interface ExecutionEvent {
  seq: number;
  eventId: string;
  eventType: string;
  taskId: string | null;
  attemptId: string | null;
  taskRevision: number | null;
  taskFence: number | null;
  payloadJson: string | null;
  createdAt: number;
}

export interface SyncBatchSummary {
  id: string;
  origin: string;
  state: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  targetCount: number;
  conflictCount: number;
}

/** 只读：按项目（可选批次）列任务。 */
export const executionTaskList = (projectId: string, batchId?: string | null) =>
  invoke<ExecutionTask[]>("execution_task_list", { projectId, batchId: batchId ?? null });

/** 只读：任务事件时间线（按 seq 正序返回）。 */
export const executionEventList = (projectId: string, taskId?: string | null, limit = 100) =>
  invoke<ExecutionEvent[]>("execution_event_list", { projectId, taskId: taskId ?? null, limit });

/** 只读：同步批次摘要。 */
export const syncBatchList = (projectId: string) =>
  invoke<SyncBatchSummary[]>("sync_batch_list", { projectId });

export interface SyncTarget {
  targetId: string;
  kind: string;
  baseHash: string;
  newHash: string;
  applyState: string;
  targetUri: string | null;
}

export interface SyncBatchDetail extends SyncBatchSummary {
  baseId: string | null;
  documentConsistency: string;
  codeReconcileState: string;
  targets: SyncTarget[];
}

export interface SyncDiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

export interface SemanticDelta {
  addedHeadings: string[];
  removedHeadings: string[];
  addedAcs: string[];
  removedAcs: string[];
}

export interface SyncTargetPreview {
  targetId: string;
  targetUri: string | null;
  baseHash: string;
  newHash: string;
  applyState: string;
  currentHash: string | null;
  currentMatchesBase: boolean;
  currentMatchesNew: boolean;
  currentText: string | null;
  stagedText: string | null;
  diff: SyncDiffLine[];
  semantic: SemanticDelta;
  truncated: boolean;
}

export const syncBatchGet = (projectId: string, batchId: string) =>
  invoke<SyncBatchDetail>("sync_batch_get", { projectId, batchId });

export const syncTargetPreview = (projectId: string, batchId: string, targetId: string) =>
  invoke<SyncTargetPreview>("sync_target_preview", { projectId, batchId, targetId });

export const syncReconcilePending = (projectId: string) =>
  invoke<{ checked: number; applied: number; pending: number; conflict: number; skipped: number }>(
    "sync_reconcile_pending",
    { projectId },
  );

export interface SyncBaselineView {
  id: string;
  projectId: string;
  branchRef: string | null;
  headCommit: string | null;
  codeManifestRef: string;
  codeManifestHash: string;
  sourceRefs: unknown[];
  coverage: string;
  publishedBatchId: string | null;
  createdAt: number;
}

/** 从已对账批次发布共同基线；未对账或仍有冲突时后端拒绝。 */
export const syncPublishBaseline = (projectId: string, batchId: string) =>
  invoke<SyncBaselineView>("sync_publish_baseline", { projectId, batchId });

export interface ExecutionPlan {
  id: string;
  projectId: string;
  taskId: string;
  phase: string;
  planHash: string;
  hashRuleVersion: string;
  requirementHash: string;
  designHash: string;
  acHash: string;
  authorizationRef: string | null;
  selectedCli: string;
  modelRef: string;
  effort: string | null;
  permissionPolicyHash: string;
  capabilityManifestHash: string;
  createdAt: number;
}

export interface PlanAuthorization {
  id: string;
  planHash: string;
  actorRef: string;
  source: string;
  scope: string;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface PlanCheck {
  plan: ExecutionPlan;
  authorization: PlanAuthorization | null;
  blockers: string[];
  ready: boolean;
}

/** 只读：任务最新执行计划与授权状态；无计划返回 null。 */
export const planTaskStatus = (projectId: string, taskId: string) =>
  invoke<PlanCheck | null>("execution_plan_task_status", { projectId, taskId });

export interface ApprovalView {
  id: string;
  projectId: string;
  planHash: string;
  taskId: string | null;
  toolCallId: string;
  finalArgsHash: string;
  risk: string;
  decision: string;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number | null;
}

/** 只读：项目内未过期且未决定的审批请求。 */
export const approvalPending = (projectId: string) =>
  invoke<ApprovalView[]>("execution_approval_pending", { projectId });
