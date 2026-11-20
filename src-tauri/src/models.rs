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
