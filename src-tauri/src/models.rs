//! 前后端共享数据结构。字段命名 camelCase 以直接映射 TS 类型。
//!
//! 设计依据 docs/DB/DB-FEAT-001 与 docs/LLD/LLD-FEAT-002。

use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4().simple())
}

// ---------- 项目 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: String, // code | work
    pub root_uri: String,
    /// CR-051：内置图标 id（50 个共享白名单之一）；NULL 按类型推导（code→code、work→briefcase）。
    pub icon: Option<String>,
    /// CR-051 r6：背景色卡 id（10 色之一）；NULL 按类型默认（code→blue、work→amber），旧项目不改显示。
    pub icon_color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 需求树节点（派生投影，来自项目 Markdown 文档 front matter）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RequirementNode {
    pub entity_id: String,
    pub kind: String, // vision | epic | feature | story | bug
    pub parent_id: Option<String>,
    pub title: String,
    pub status: Option<String>,
    pub owner: Option<String>,
    pub source_uri: String,
    pub children: Vec<RequirementNode>,
}

// ---------- 文件树 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,       // 绝对路径
    pub is_dir: bool,
    pub size: Option<u64>,
}

// ---------- Git ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub state: String, // ready | no-repo | detached | error
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: Option<String>,   // A|M|D|R|C|T|U
    pub unstaged: Option<String>, // A|M|D|T|U
    pub untracked: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    pub kind: String, // local | remote
    pub current: bool,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub short: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

// ---------- Git 侧栏配置（CR-067） ----------

/// 一个远程（名称 + fetch 地址）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub url: String,
}

/// 国内加速配置：开关 + 镜像前缀（前缀以 `/` 结尾，与 github.com 地址拼接）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccelConfig {
    pub enabled: bool,
    pub url: String,
}

/// 密钥列表项：只含元信息，**不含令牌**。前端据此渲染主机与掩码。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHostEntry {
    pub host: String,
    pub username: String,
    pub saved_at: String,
}

/// 受管密钥文件中的 Git 令牌记录（仅后端使用，不序列化给前端）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredGitCredential {
    pub username: String,
    pub token: String,
    pub saved_at: String,
}

// ---------- 模型供应商（CR-012 语义） ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub protocol: String, // anthropic | openai
    pub disabled: bool,
    pub headers_json: Option<String>,
    pub fingerprint_json: Option<String>,
    pub keys: Vec<ProviderKey>,
    pub endpoints: Vec<ProviderEndpoint>,
    pub models: Vec<ModelConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub id: String,
    pub alias: Option<String>,
    pub masked: String,
    pub enabled: bool,
    /// CR-059：该密钥请求使用的协议（'' 沿用供应商默认；Chat/Responses → OpenAI 端点，Anthropic → Anthropic 端点）。
    #[serde(default)]
    pub protocol: String,
    /// CR-059：该密钥可用的模型（空 = 全部，后续新增自动覆盖）。
    #[serde(default)]
    pub models: Vec<String>,
    /// CR-059：范围来源（auto / manual / None）。
    #[serde(default)]
    pub scope_source: Option<String>,
    /// CR-059：最近一次探测完成的毫秒时间戳。
    #[serde(default)]
    pub probed_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEndpoint {
    pub id: String,
    pub protocol: String,
    pub base_url: String,
    pub enabled: bool,
}

/// 思考档位表：off/low/.../max -> 实际下发拼写；null 表示该档不下发参数。
pub type EffortMap = std::collections::BTreeMap<String, Option<String>>;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub text: bool,
    pub vision: bool,
    pub image_gen: bool,
    pub efforts: EffortMap,
    pub default_effort: Option<String>,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
    /// CR-059：模型在该供应商内的展示与候选顺序。
    #[serde(default)]
    pub sort_order: i64,
}

/// 会话可选择的模型候选（过滤规则见 LLD-FEAT-002 §模型候选）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub provider_id: String,
    pub provider_name: String,
    pub protocol: String,
    pub model_row_id: String,
    pub model_id: String,
    pub display_name: String,
    pub vision: bool,
    pub default_effort: Option<String>,
    pub efforts: EffortMap,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
}

// ---------- SDK ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SdkState {
    pub id: String, // codex | claude | grok
    pub package: String,
    pub enabled: bool,
    pub install_state: String, // installed | not-installed | checking | error
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SdkJob {
    pub id: String,
    pub sdk_id: String,
    pub kind: String, // install | uninstall | refresh
    pub phase: String, // queued | running | done | failed | cancelled | timeout
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------- 能力（Skill / MCP / Tool） ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub source_ref: String, // 受管目录中的 SKILL.md 路径
    pub builtin: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String, // stdio | http
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub tools: Vec<McpToolInfo>,
    #[serde(default)]
    pub auth_status: String,
    #[serde(default)]
    pub auth_revision: i64,
    /// http 认证方式：oauth | bearer | none。stdio 不使用。
    #[serde(default)]
    pub auth_mode: String,
    /// 仅本机 loopback：显式信任自签名证书（默认关闭）。
    #[serde(default)]
    pub allow_insecure_local_tls: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub risk: String, // low | medium | high
    pub enabled: bool,
    pub builtin: bool,
}

// ---------- 会话 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub project_id: Option<String>,
    pub server_id: Option<String>,
    pub title: String,
    pub cli_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub draft: String,
    pub unread: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    /// CR-047：执行会话绑定的唯一特性；普通会话为空。
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub feature_title: Option<String>,
    /// 派发时特性源修订（来自 requirement_index.contentHash）；源变化只提示待核验。
    #[serde(default)]
    pub feature_source_hash: Option<String>,
    /// ordinary | executor；历史记录默认 ordinary。
    #[serde(default = "ordinary_session_role")]
    pub session_role: String,
    /// CR-037：原生绑定派生视图；执行会话与无绑定普通会话为 None。不含原引用。
    #[serde(default)]
    pub binding: Option<SessionBindingView>,
    /// CR-065：置顶时刻（毫秒）；0 表示未置顶。
    #[serde(default)]
    pub pinned_at: i64,
    /// CR-069：会话运行通道。'cli' 走既有 CLI 进程；'platform' 由平台主代理作答。
    #[serde(default = "default_runner")]
    pub runner: String,
}

fn default_runner() -> String { "cli".into() }

fn ordinary_session_role() -> String { "ordinary".into() }

/// CR-063/CR-065：会话历史分页游标，与 ORDER BY pinnedAt DESC, updatedAt DESC, id DESC 对应。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionCursor {
    pub pinned_at: i64,
    pub updated_at: i64,
    pub id: String,
}

/// CR-063：会话历史分页结果；total 为同作用域 + 同关键词的匹配总数。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub items: Vec<SessionMeta>,
    pub total: i64,
    pub has_more: bool,
    pub next_cursor: Option<SessionCursor>,
}

/// CR-037：侧栏原生绑定派生视图（不含原引用，只有脱敏指纹与状态）。
/// state: native（已绑定原线程）| fresh（已确认重建）| freshPending（待确认）| blocked（不可续接）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingView {
    pub state: String,
    pub reason_code: Option<String>,
    pub ref_fingerprint: Option<String>,
    pub expected_revision: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String, // user | assistant | tool_use | tool_result | system
    pub content: String,
    pub meta_json: Option<String>,
    pub refs_json: Option<String>,
    pub git_context_json: Option<String>,
    pub created_at: i64,
}

/// 会话流式事件（经 Tauri Channel 推送）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ChatEvent {
    Delta { delta: String },
    Thinking { delta: String },
    ToolUse { tool_id: String, name: String, input_json: String },
    ToolResult { tool_id: String, content: String, is_error: bool },
    ApprovalRequest { request_id: String, tool_name: String, input_json: String, risk: String },
    Usage { input_tokens: i64, output_tokens: i64, cache_read_tokens: i64 },
    Subagent { id: String, task: String, status: String },
    Retrying { attempt: i64, max_attempts: i64, delay_ms: i64, reason: String },
    Error { message: String },
    Done { session_ref: Option<String> },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SendPayload {
    pub session_id: String,
    pub content: String,
    pub refs: Vec<ContextRef>,
    pub attachments: Vec<AttachmentMeta>,
    /// None 保持历史适配行为；显式模式由后端白名单解析，不接受 argv/隔离自报。
    #[serde(default)]
    pub permission_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    pub kind: String, // file | requirement | knowledge | session | command | skill
    pub object_id: String,
    pub display: String,
    pub library_id: Option<String>,
    /// 办公文件引用携带的合成内容快照（objectId 形如 office:<fileId>），发送时冻结（CR-043）
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub name: String,
    pub mime: Option<String>,
    pub byte_size: Option<i64>,
}

// ---------- 服务器 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerHost {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String, // password | key
    pub group_tag: Option<String>,
    pub connected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    pub hostname: String,
    pub os: String,
    pub uptime: String,
    pub cpu_cores: Vec<f64>,
    pub cpu_avg: f64,
    pub mem_total_mb: i64,
    pub mem_used_mb: i64,
    pub load1: f64,
}

/// 终端输出事件
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TermEvent {
    Data { data: String },
    Exit { message: String },
}

// ---------- 知识库 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeLibrary {
    pub id: String,
    pub name: String,
    pub source_kind: String,
    pub source_ref: String,
    pub enabled: bool,
    pub note_count: i64,
    pub revision: i64,
    /// CR-051：内置图标 id（与项目共用 50 个白名单）；NULL 按 sourceKind 推导。
    pub icon: Option<String>,
    /// CR-051 r6：背景色卡 id（10 色之一）；NULL 默认青绿。
    pub icon_color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub note_id: String,
    pub title: String,
    pub relative_uri: String,
    pub is_dir: bool,
    pub children: Vec<NoteNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub note_id: String,
    pub title: String,
    pub relative_uri: String,
    pub content: String,
    /// Actual-byte FNV-1a64 revision token; not a cryptographic digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// The file is saved even when updating the derived index fails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    pub library_id: String,
    pub library_name: String,
    pub note_id: String,
    pub title: String,
    pub relative_uri: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGrant {
    pub library_id: String,
    pub library_name: String,
    pub project_id: Option<String>,
    pub read_allowed: bool,
}
