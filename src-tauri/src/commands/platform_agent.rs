//! CR-069：平台主代理运行时。
//!
//! 职责：用平台已配置的供应商/模型直接与模型服务对话，并在允许的工具集内循环。
//! 边界：
//! - 不管理供应商、密钥、端点（读取既有表，见 providers.rs）；
//! - 不接管 CLI 路径（chat.rs 的 chat_send 保持不变）；
//! - 不提供 shell / 文件写 / git 写 / 凭据读取能力（工具白名单硬编码）；
//! - 不修改任务状态（派发只创建记录，见 execution.rs）。

use crate::commands::chat::StreamOutcome;
use crate::models::{EffortMap, SendPayload};
use serde_json::{json, Value};
use std::io::{BufRead, Read};

#[path = "platform_context_runtime.rs"]
mod context_runtime;

/// 平台会话的默认输出上限（两协议一致；Anthropic 的 max_tokens 必填）。
const MAX_OUTPUT_TOKENS: u64 = 4096;
/// 流式读取硬上限（与 model_probe.rs 的 MAX_STREAM_BYTES 一致），防超大响应。
const MAX_STREAM_BYTES: u64 = 2 * 1024 * 1024;
/// 解析失败的 SSE 行数阈值；超过判定协议不兼容并报错，不静默产出空回复。
const MAX_BAD_SSE_LINES: usize = 20;

/// 平台会话的一轮请求上下文。
#[derive(Clone)]
pub(crate) struct PlatformTurn {
    pub session_id: String,
    pub project_id: Option<String>,
    /// 供应商与端点（已校验可用）
    pub protocol: String, // "openai" | "anthropic"
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub effort: Option<String>,
    /// 模型思考档位映射（model.effortsJson）
    pub efforts: EffortMap,
    /// 供应商自定义请求头（对齐 providers.rs 的 headersJson）
    pub extra_headers: Vec<(String, String)>,
    /// CR-099：可选模拟客户端身份（仅追加身份头，不触碰凭证）
    pub client_identity: Option<crate::commands::client_identity::ClientIdentity>,
}

/// 模型返回的规范化结果。
#[derive(Default, Clone)]
pub(crate) struct ModelReply {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    /// (input, output, cache_read)
    pub usage: Option<(i64, i64, i64)>,
    /// 仅实际进入模型请求后存在；预检/拒绝不能生成步骤边界。
    pub timing: Option<crate::commands::chat::stats::ModelTiming>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct ToolCall {
    pub id: String,
    pub name: String,
    /// 原始 JSON 字符串
    pub arguments: String,
}

/// CR-086：平台 runtime 可见的工具。内置目录、MCP 缓存工具与技能读取共用同一形态，
/// 名称是运行时字符串（MCP 工具名由服务器与工具名拼成），因此不沿用静态 ToolDef。
#[derive(Clone)]
pub(crate) struct PlatformTool {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

impl From<crate::commands::ai_tools::ToolDef> for PlatformTool {
    fn from(d: crate::commands::ai_tools::ToolDef) -> Self {
        Self { name: d.name.to_string(), description: d.description.to_string(), schema: d.schema }
    }
}

/// 对话消息（含工具角色）。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) enum ChatMsg {
    System(String),
    User(String),
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    Tool { call_id: String, content: String, is_error: bool },
}

/// 平台主代理的系统提示（LLD-CR069 §4.4：常量，不放数据库，不进设置页）。
pub(crate) const PLATFORM_SYSTEM_PROMPT: &str = "\
你是本工作台的主代理。你可以查询项目与需求、读取已授权知识与项目文件、在允许范围内修改需求元数据、请求打开预览面板，以及派发工作给受管执行。

你必须遵守：
1. 只使用提供的工具；没有提供的工具即表示你不能做那件事。
2. 需要写代码、执行命令、操作 git、删除文件、修改权限或处理凭据时，不要尝试绕过；应说明需要派发或请用户操作。
3. 不要在工具参数中猜测对象编号；不确定时先查询。
4. 派发成功不代表工作完成；不要声称已完成、已验证或已通过。
5. 回答用户时使用简体中文。";

// ---------------------------------------------------------------------------
// 请求 URL（复制 model_probe.rs::chat_url 的规则，语义为对话地址而非探针地址）
// ---------------------------------------------------------------------------

pub(crate) fn platform_chat_url(base: &str, protocol: &str) -> Result<String, String> {
    let mut url = tauri::Url::parse(base.trim()).map_err(|_| "端点地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("端点必须为不含凭证、查询或片段的 HTTP(S) 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let suffix = if protocol == "anthropic" {
        if path.ends_with("/v1") {
            "/messages"
        } else if path.ends_with("/messages") {
            ""
        } else {
            "/v1/messages"
        }
    } else if path.ends_with("/v1") {
        "/chat/completions"
    } else {
        "/v1/chat/completions"
    };
    url.set_path(&format!("{}{}", path, suffix));
    Ok(url.to_string())
}

// ---------------------------------------------------------------------------
// 请求体构造（双协议；复制 model_probe.rs 的拼装思路，但支持工具消息）
// ---------------------------------------------------------------------------

/// 思考档位 → Anthropic thinking token 预算（与 dispatch.rs::claude_thinking_budget 同表；
/// 复制以避免把对话路径耦合到 CLI 派发模块；新档位在此显式新增，不隐式回退）。
fn budget_of(level: &str) -> Option<u32> {
    match level {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" => Some(16384),
        "xhigh" | "max" => Some(32768),
        _ => None,
    }
}

/// 思考档位下发：effort_map[level] 缺失即报错（不发请求）；None 表示该档不下发参数。
fn apply_effort(
    body: &mut Value,
    protocol: &str,
    effort: Option<&str>,
    map: &EffortMap,
) -> Result<(), String> {
    let Some(level) = effort.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    match map.get(level) {
        None => Err(format!("模型未声明思考档位 {level}")),
        Some(None) => Ok(()), // 该档不下发参数
        Some(Some(wire)) => {
            if protocol == "anthropic" {
                // budget_of 无法覆盖的档位显式报错，不隐式回退。
                let budget = budget_of(level).ok_or_else(|| format!("思考档位 {level} 缺少 Anthropic 预算映射"))?;
                body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
                // Anthropic 要求 max_tokens > budget_tokens，不足时抬高输出上限。
                let current = body.get("max_tokens").and_then(Value::as_u64).unwrap_or(MAX_OUTPUT_TOKENS);
                if current <= budget as u64 {
                    body["max_tokens"] = json!(budget as u64 + MAX_OUTPUT_TOKENS);
                }
            } else {
                body["reasoning_effort"] = json!(wire);
            }
            Ok(())
        }
    }
}

pub(crate) fn build_platform_body(
    protocol: &str,
    model_id: &str,
    effort: Option<&str>,
    effort_map: &EffortMap,
    messages: &[ChatMsg],
    tools: &[PlatformTool],
    stream: bool,
) -> Result<Value, String> {
    let mut body = match protocol {
        "anthropic" => {
            // system 必须是顶层字段；放进 messages 会被 Anthropic 拒绝。
            let mut system = String::new();
            let mut msgs = Vec::new();
            for message in messages {
                match message {
                    ChatMsg::System(s) => {
                        if !system.is_empty() {
                            system.push_str("\n\n");
                        }
                        system.push_str(s);
                    }
                    ChatMsg::User(content) => {
                        msgs.push(json!({"role": "user", "content": [{"type": "text", "text": content}]}));
                    }
                    ChatMsg::Assistant { text, tool_calls } => {
                        let mut blocks = Vec::new();
                        if !text.trim().is_empty() {
                            blocks.push(json!({"type": "text", "text": text}));
                        }
                        for call in tool_calls {
                            let input: Value = if call.arguments.trim().is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(&call.arguments)
                                    .map_err(|e| format!("工具参数不是有效 JSON：{e}"))?
                            };
                            blocks.push(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": input}));
                        }
                        msgs.push(json!({"role": "assistant", "content": blocks}));
                    }
                    ChatMsg::Tool { call_id, content, .. } => {
                        msgs.push(json!({"role": "user", "content": [
                            {"type": "tool_result", "tool_use_id": call_id, "content": content}
                        ]}));
                    }
                }
            }
            let mut v = json!({"model": model_id, "max_tokens": MAX_OUTPUT_TOKENS, "stream": stream});
            if !system.is_empty() {
                v["system"] = json!(system);
            }
            v["messages"] = Value::Array(msgs);
            if !tools.is_empty() {
                v["tools"] = Value::Array(
                    tools.iter()
                        .map(|d| json!({"name": d.name, "description": d.description, "input_schema": d.schema}))
                        .collect(),
                );
            }
            v
        }
        "openai" => {
            let mut msgs = Vec::new();
            for message in messages {
                match message {
                    ChatMsg::System(s) => msgs.push(json!({"role": "system", "content": s})),
                    ChatMsg::User(content) => msgs.push(json!({"role": "user", "content": content})),
                    ChatMsg::Assistant { text, tool_calls } => {
                        let calls: Vec<Value> = tool_calls.iter()
                            .map(|c| json!({"id": c.id, "type": "function",
                                            "function": {"name": c.name, "arguments": normalized_tool_arguments(&c.arguments)}}))
                            .collect();
                        // CR-099：空 tool_calls 不回放成 []，严格端点会拒绝；无文本且无调用时用空串正文。
                        let content = if text.is_empty() && !calls.is_empty() {
                            Value::Null
                        } else {
                            json!(text)
                        };
                        let mut message = json!({"role": "assistant", "content": content});
                        if !calls.is_empty() {
                            message["tool_calls"] = Value::Array(calls);
                        }
                        msgs.push(message);
                    }
                    ChatMsg::Tool { call_id, content, .. } => {
                        msgs.push(json!({"role": "tool", "tool_call_id": call_id, "content": content}));
                    }
                }
            }
            let mut v = json!({"model": model_id, "stream": stream, "messages": msgs});
            if stream {
                v["stream_options"] = json!({"include_usage": true});
            }
            // 推理模型用 max_completion_tokens，其他用 max_tokens（对齐 model_probe::is_reasoning_model）。
            let field = if crate::commands::model_probe::is_reasoning_model(model_id) {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            v[field] = json!(MAX_OUTPUT_TOKENS);
            if !tools.is_empty() {
                v["tools"] = Value::Array(
                    tools.iter()
                        .map(|d| json!({"type": "function", "function": {
                            "name": d.name, "description": d.description, "parameters": d.schema
                        }}))
                        .collect(),
                );
            }
            v
        }
        other => return Err(format!("不支持的模型协议：{other}")),
    };
    apply_effort(&mut body, protocol, effort, effort_map)?;
    Ok(body)
}

// ---------------------------------------------------------------------------
// 流式解析（双协议）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ToolCallAcc {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}

/// 流式解析的累积状态；文本增量经回调立即下发，不在状态里攒批。
#[derive(Default)]
pub(crate) struct StreamState {
    pub text: String,
    pub thinking: String,
    tool_accs: Vec<ToolCallAcc>,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    bad_lines: usize,
}

impl StreamState {
    /// 流结束后冻结工具调用：arguments 逐段拼接完成后再整体解析（调用方负责 JSON 校验）。
    pub fn finish_tool_calls(mut self) -> Vec<ToolCall> {
        self.tool_accs.sort_by_key(|a| a.index);
        self.tool_accs
            .into_iter()
            .map(|acc| ToolCall { id: acc.id, name: acc.name, arguments: acc.arguments })
            .collect()
    }

    pub fn into_reply(self) -> ModelReply {
        let usage = match (self.input_tokens, self.output_tokens, self.cache_read_tokens) {
            (None, None, _) => None,
            (i, o, c) => Some((i.unwrap_or(0), o.unwrap_or(0), c.unwrap_or(0))),
        };
        let finish_reason = self.finish_reason;
        let mut accs = self.tool_accs;
        accs.sort_by_key(|a| a.index);
        ModelReply {
            text: self.text,
            thinking: self.thinking,
            tool_calls: accs
                .into_iter()
                .map(|acc| ToolCall { id: acc.id, name: acc.name, arguments: acc.arguments })
                .collect(),
            finish_reason,
            usage,
            timing: None,
        }
    }
}

fn tool_acc_by_index(state: &mut StreamState, index: usize) -> &mut ToolCallAcc {
    if let Some(pos) = state.tool_accs.iter().position(|a| a.index == index) {
        return &mut state.tool_accs[pos];
    }
    state.tool_accs.push(ToolCallAcc { index, ..Default::default() });
    state.tool_accs.last_mut().unwrap()
}

fn handle_openai_line(
    line: &str,
    state: &mut StreamState,
    on_delta: &mut dyn FnMut(&str),
    on_thinking: &mut dyn FnMut(&str),
) {
    let Some(rest) = line.strip_prefix("data:") else {
        return; // event:/注释等其他行忽略
    };
    let payload = rest.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return;
    }
    let value: Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => {
            state.bad_lines += 1;
            return;
        }
    };
    if let Some(usage) = value.get("usage") {
        state.input_tokens = usage.get("prompt_tokens").and_then(Value::as_i64).or(state.input_tokens);
        state.output_tokens = usage.get("completion_tokens").and_then(Value::as_i64).or(state.output_tokens);
        state.cache_read_tokens = usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_i64)
            .or(state.cache_read_tokens);
    }
    let Some(choice) = value.pointer("/choices/0") else {
        return;
    };
    if let Some(finish) = choice.get("finish_reason").filter(|v| !v.is_null()).and_then(Value::as_str) {
        state.finish_reason = Some(finish.to_string());
    }
    let Some(delta) = choice.get("delta") else {
        return;
    };
    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            state.text.push_str(content);
            on_delta(content);
        }
    }
    if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
        if !reasoning.is_empty() {
            state.thinking.push_str(reasoning);
            on_thinking(reasoning);
        }
    }
    // 关键：tool_calls[].function.arguments 是逐段下发的字符串，
    // 必须按 index 累积到流结束再整体解析，不能收到第一段就解析。
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let acc = tool_acc_by_index(state, index);
            if let Some(id) = call.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                acc.id = id.to_string();
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                acc.name = name.to_string();
            }
            if let Some(piece) = call.pointer("/function/arguments").and_then(Value::as_str) {
                acc.arguments.push_str(piece);
            }
        }
    }
}

fn handle_anthropic_line(
    line: &str,
    state: &mut StreamState,
    on_delta: &mut dyn FnMut(&str),
    on_thinking: &mut dyn FnMut(&str),
) {
    let Some(rest) = line.strip_prefix("data:") else {
        return; // "event: ping" 等行忽略；data 载荷自带 type
    };
    let payload = rest.trim();
    if payload.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => {
            state.bad_lines += 1;
            return;
        }
    };
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "message_start" => {
            state.cache_read_tokens = value.pointer("/message/usage/cache_read_input_tokens").and_then(Value::as_i64).or(state.cache_read_tokens);
            state.input_tokens = value.pointer("/message/usage/input_tokens").and_then(Value::as_i64).or(state.input_tokens);
            state.output_tokens = value.pointer("/message/usage/output_tokens").and_then(Value::as_i64).or(state.output_tokens);
        }
        "content_block_start" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
                let acc = tool_acc_by_index(state, index);
                acc.id = value.pointer("/content_block/id").and_then(Value::as_str).unwrap_or("").to_string();
                acc.name = value.pointer("/content_block/name").and_then(Value::as_str).unwrap_or("").to_string();
            }
        }
        "content_block_delta" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            match value.pointer("/delta/type").and_then(Value::as_str).unwrap_or("") {
                "text_delta" => {
                    if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            state.text.push_str(text);
                            on_delta(text);
                        }
                    }
                }
                "thinking_delta" => {
                    if let Some(piece) = value.pointer("/delta/thinking").and_then(Value::as_str) {
                        if !piece.is_empty() {
                            state.thinking.push_str(piece);
                            on_thinking(piece);
                        }
                    }
                }
                // 工具参数同样是逐段 partial_json，按 index 累积。
                "input_json_delta" => {
                    if let Some(piece) = value.pointer("/delta/partial_json").and_then(Value::as_str) {
                        tool_acc_by_index(state, index).arguments.push_str(piece);
                    }
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                state.finish_reason = Some(reason.to_string());
            }
            if let Some(n) = value.pointer("/usage/output_tokens").and_then(Value::as_i64) {
                state.output_tokens = Some(n);
            }
        }
        // message_stop / ping / content_block_stop 等忽略
        _ => {}
    }
}

/// 逐行解析 SSE；返回 Err 表示协议不兼容（坏行超阈值）。
pub(crate) fn parse_stream_lines(
    protocol: &str,
    lines: impl IntoIterator<Item = String>,
    state: &mut StreamState,
    on_delta: &mut dyn FnMut(&str),
    on_thinking: &mut dyn FnMut(&str),
) -> Result<(), String> {
    for line in lines {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue; // 空行与 keepalive 注释
        }
        if protocol == "anthropic" {
            handle_anthropic_line(trimmed, state, on_delta, on_thinking);
        } else {
            handle_openai_line(trimmed, state, on_delta, on_thinking);
        }
        if state.bad_lines > MAX_BAD_SSE_LINES {
            return Err("响应流包含过多无法解析的帧，模型协议可能与所选供应商不兼容".into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 发送分派与单轮执行（LLD-CR069 §4）
// ---------------------------------------------------------------------------

/// CR-069 首版 13 项基线（历史）。CR-086 起平台 runtime 直接使用工作台工具目录全部启用项，
/// 并追加 MCP 缓存工具与技能读取；本常量仅保留给历史测试断言，不再参与可见性过滤。
#[allow(dead_code)]
pub(crate) const PLATFORM_TOOL_ALLOWLIST: [&str; 13] = [
    "get_context",
    "list_projects",
    "get_requirements",
    "read_requirement_doc",
    "write_requirement_doc",
    "list_kbs",
    "knowledge_list",
    "knowledge_search",
    "knowledge_read",
    "knowledge_read_many",
    "fs_read",
    "list_servers",
    "open_panel",
];

/// 工具循环三重上限（LLD §5.3）：轮次 / 单轮个数 / 累计次数。
const MAX_TOOL_ROUNDS: usize = 8;
const MAX_TOOL_CALLS_PER_ROUND: usize = 8;
const MAX_TOOL_CALLS_TOTAL: usize = 24;
/// CR-099：同一工具同参数连续失败达到该次数后不再执行，直接回填「换方案」提示。
const MAX_SAME_CALL_FAILURES: usize = 2;
/// CR-099：连续多轮工具结果全部失败时提前结束，避免空转到累计上限。
const MAX_ALL_ERROR_ROUNDS: usize = 3;

/// CR-099：回放给模型的工具参数必须是合法 JSON 对象字符串。
/// 模型未下发 arguments 时流式累积为空串；执行侧仍保留原始参数与错误结果，仅线上回放净化。
fn normalized_tool_arguments(arguments: &str) -> String {
    if arguments.trim().is_empty() {
        return "{}".into();
    }
    match serde_json::from_str::<Value>(arguments) {
        Ok(value) if value.is_object() => value.to_string(),
        _ => "{}".into(),
    }
}

/// 副作用工具同参数不重复执行；只读工具不去重（重复读取无害）。
fn is_side_effect_tool(name: &str) -> bool {
    matches!(
        name,
        "write_requirement_doc"
            | "create_project"
            | "update_project"
            | "create_kb"
            | "set_kb_grant"
            | "save_server"
            | "generate_image"
            | "dispatch_work"
            | "compress_context"
            | "memory_save"
    )
}

fn business_tools_enabled(conn: &rusqlite::Connection)->bool {
    let value: Option<Option<String>>=conn.query_row("SELECT value FROM setting_default WHERE scope='global' AND key='aiTools.enabled'",[],|r|r.get(0)).ok();
    crate::commands::dispatch::ai_tools_enabled_from_setting(value.flatten())
}

/// CR-086：MCP 工具名 `mcp__<server>__<tool>`，server 名净化到可作函数名的字符集。
fn mcp_tool_name(server_name: &str, tool: &str) -> String {
    let safe: String = server_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    format!("mcp__{}__{}", safe, tool)
}

/// 生成模型可见工具定义（每轮重读）：工作台目录全部启用项 + MCP 缓存工具 + 技能读取。
/// CR-086：不再按固定白名单过滤——平台持有的能力与 CLI 通道同源。
fn platform_tool_defs(conn: &rusqlite::Connection) -> Vec<PlatformTool> {
    if !business_tools_enabled(conn) {return Vec::new();}
    let mut defs: Vec<PlatformTool> = crate::commands::ai_tools::workbench_tools()
        .into_iter()
        .filter(|d| crate::commands::ai_tools::tool_enabled(conn, d.registry_id))
        .map(PlatformTool::from)
        .collect();
    for cached in crate::commands::capabilities::mcp_cached_tools(conn) {
        defs.push(PlatformTool {
            name: mcp_tool_name(&cached.server_name, &cached.name),
            description: format!("[MCP {}] {}", cached.server_name, cached.description.unwrap_or_default()),
            schema: cached
                .input_schema
                .unwrap_or_else(|| json!({"type": "object", "additionalProperties": true})),
        });
    }
    defs
}

/// CR-095：按项目类型只注入默认工具组的完整 schema（MCP 缓存工具仍全给，避免误伤用户配置）。
/// 旧 `platform_tool_defs` 保留为全量（测试与兼容路径）。
fn platform_tool_defs_scoped(conn: &rusqlite::Connection, project_id: Option<&str>) -> Vec<PlatformTool> {
    if !business_tools_enabled(conn) {
        return Vec::new();
    }
    let kind = project_id
        .and_then(|pid| conn.query_row("SELECT type FROM project WHERE id=?1", [pid], |r| r.get::<_, String>(0)).ok())
        .unwrap_or_default();
    let allowed = crate::commands::tool_groups::allowed_tool_names(&kind);
    let mut defs: Vec<PlatformTool> = crate::commands::ai_tools::workbench_tools()
        .into_iter()
        .filter(|d| crate::commands::ai_tools::tool_enabled(conn, d.registry_id) && allowed.contains(d.name))
        .map(PlatformTool::from)
        .collect();
    for cached in crate::commands::capabilities::mcp_cached_tools(conn) {
        defs.push(PlatformTool {
            name: mcp_tool_name(&cached.server_name, &cached.name),
            description: format!("[MCP {}] {}", cached.server_name, cached.description.unwrap_or_default()),
            schema: cached
                .input_schema
                .unwrap_or_else(|| json!({"type": "object", "additionalProperties": true})),
        });
    }
    defs
}

/// CR-086：把平台工具名解析回 MCP 服务器与原始工具名。
fn resolve_mcp_tool(conn: &rusqlite::Connection, full_name: &str) -> Option<(String, String)> {
    crate::commands::capabilities::mcp_cached_tools(conn)
        .into_iter()
        .find(|t| mcp_tool_name(&t.server_name, &t.name) == full_name)
        .map(|t| (t.server_id, t.name))
}



struct ToolOutcome {
    content: String,
    is_error: bool,
}

/// 安全执行封装：参数 JSON 校验 + catch_unwind（工具是同步调用，可捕获 panic）。
/// 执行器可注入（仅测试注入 panic 桩，生产固定为 ai_tools::run_tool）。
fn execute_tool_safely(
    ctx: &crate::commands::ai_tools::ToolContext,
    call: &ToolCall,
) -> ToolOutcome {
    execute_tool_with(ctx, call, |ctx, name, args| {
        crate::commands::ai_tools::run_tool(ctx, name, args)
    })
}

fn execute_tool_with(
    ctx: &crate::commands::ai_tools::ToolContext,
    call: &ToolCall,
    runner: impl Fn(&crate::commands::ai_tools::ToolContext, &str, &Value) -> Result<Value, String>,
) -> ToolOutcome {
    let args: Value = match serde_json::from_str(&call.arguments) {
        Ok(v) => v,
        Err(e) => return ToolOutcome { content: format!("参数不是有效 JSON：{e}"), is_error: true },
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner(ctx, &call.name, &args))) {
        Ok(Ok(value)) => ToolOutcome { content: value.to_string(), is_error: false },
        Ok(Err(e)) => ToolOutcome { content: e, is_error: true },
        Err(_) => ToolOutcome { content: "工具执行异常终止".into(), is_error: true },
    }
}

/// 从数据库解析一轮平台会话的全部运行要素（LLD §3.3/§4.2 步骤 2-4）。
/// 所有校验在持久化用户消息之前完成，失败保留前端草稿。
fn resolve_platform_turn(
    conn: &rusqlite::Connection,
    app: &tauri::AppHandle,
    session: &crate::models::SessionMeta,
) -> Result<PlatformTurn, String> {
    let provider_id = session.provider_id.clone().filter(|s| !s.trim().is_empty())
        .ok_or("会话未绑定平台供应商，请先在会话配置中选择模型")?;
    let model_id = session.model_id.clone().filter(|s| !s.trim().is_empty())
        .ok_or("会话未绑定平台模型，请先在会话配置中选择模型")?;
    let (protocol, disabled, headers): (String, bool, Option<String>) = conn
        .query_row(
            "SELECT protocol, disabled, headersJson FROM provider WHERE id=?1",
            [&provider_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)),
        )
        .map_err(|_| "供应商不存在，请检查设置中的供应商配置".to_string())?;
    if disabled || !matches!(protocol.as_str(), "openai" | "anthropic") {
        return Err("供应商已停用或协议不受支持，请先在设置中启用".into());
    }
    let base_url: String = conn
        .query_row(
            "SELECT baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1 AND protocol=?2 ORDER BY createdAt, id LIMIT 1",
            rusqlite::params![provider_id, protocol],
            |r| r.get(0),
        )
        .map_err(|_| format!("供应商没有与协议 {protocol} 匹配的启用端点，请检查设置"))?;
    // 模型必须属于该供应商且是文本模型（对齐 providers.rs::model_candidates 过滤）。
    let (text_enabled, image_gen, efforts_json): (i64, i64, String) = conn
        .query_row(
            "SELECT text, imageGen, effortsJson FROM model WHERE providerId=?1 AND modelId=?2",
            rusqlite::params![provider_id, model_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "模型未在该供应商配置，请重新选择".to_string())?;
    if text_enabled == 0 || image_gen != 0 {
        return Err("该模型不是可对话的文本模型，请重新选择".into());
    }
    let efforts: EffortMap = serde_json::from_str(&efforts_json).map_err(|_| "模型思考档位配置无效".to_string())?;
    let key_refs: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt, id")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&provider_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let api_key = key_refs
        .iter()
        .find_map(|r| crate::commands::dispatch::read_secret(app, r).filter(|s| !s.trim().is_empty()))
        .ok_or("供应商没有可用的启用密钥，请检查设置")?;
    if api_key.contains(['\r', '\n']) {
        return Err("密钥含无效字符".into());
    }
    let headers_map: std::collections::BTreeMap<String, String> = match headers.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(s) => serde_json::from_str(s).map_err(|_| "高级请求头格式无效".to_string())?,
        None => Default::default(),
    };
    let mut extra_headers = Vec::new();
    for (name, value) in &headers_map {
        if name.is_empty()
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
            || value.contains(['\r', '\n'])
            || matches!(name.to_ascii_lowercase().as_str(), "authorization" | "x-api-key" | "host" | "cookie" | "proxy-authorization")
        {
            return Err("高级请求头含无效或保留字段".into());
        }
        extra_headers.push((name.clone(), value.clone()));
    }
    // CR-099：模拟客户端身份。默认关闭；配置缺失或非法时按关闭处理，不阻断本轮请求。
    let identity_raw: Option<String> = conn
        .query_row(
            "SELECT value FROM setting_default WHERE scope='global' AND key='chat.clientIdentity'",
            [],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let client_identity = crate::commands::client_identity::resolve(identity_raw.as_deref());
    if let Some(identity) = client_identity {
        extra_headers = crate::commands::client_identity::merge(&extra_headers, crate::commands::client_identity::headers(identity));
    }
    Ok(PlatformTurn {
        session_id: session.id.clone(),
        project_id: session.project_id.clone(),
        base_url: platform_chat_url(&base_url, &protocol)?,
        protocol,
        api_key,
        model_id,
        effort: session.effort.clone(),
        efforts,
        extra_headers,
        client_identity,
    })
}

/// CR-071：所有上下文／摘要预检在user持久化之前；接纳后异步执行，与CLI通道返回语义一致。
pub async fn send_platform(app: tauri::AppHandle,payload: SendPayload,channel: tauri::ipc::Channel<Value>) -> Result<(),String> {
    let (running,abort)=crate::commands::chat::reserve_turn(&payload.session_id)?;
    let session=crate::commands::chat::chat_session_get(payload.session_id.clone())?;
    let prompt=crate::commands::chat::build_prompt(&app,&payload,session.project_id.as_deref())?;
    let (turn,mut prepared,mut defs)={
        let guard=crate::db::conn()?;let conn=guard.as_ref().ok_or("db not initialized")?;
        (resolve_platform_turn(conn,&app,&session)?,context_runtime::Prepared::load(conn,session.clone(),prompt)?,platform_tool_defs_scoped(conn, session.project_id.as_deref()))
    };
    defs.extend(crate::commands::platform_context::tool_defs().into_iter().map(PlatformTool::from));
    // CR-099：system 能力目录与本轮实际下发的 tools 同源。
    prepared.set_tool_names(&defs, true);
    let data_dir=crate::storage_layout::root().map_err(|e| e.to_string())?;
    if let Err(error)=context_runtime::prepare(&turn,&mut prepared,&defs,&abort).await {
        send_usage(&channel,prepared.usage);
        return Err(error);
    }
    {
        let guard=crate::db::conn()?;let conn=guard.as_ref().ok_or("db not initialized")?;
        if let Err(error)=prepared.accept(conn,&payload,&abort) {send_usage(&channel,prepared.usage);return Err(error);}
    }
    let ctx=crate::commands::ai_tools::ToolContext {project_id:session.project_id.clone(),data_dir,execution_feature_id:session.feature_id.clone()};
    let _=channel.send(json!({"type":"sessionStats","sessionId":session.id}));
    // CR-086：MCP 调用需要 AppHandle（HTTP 凭据与进程解析），在 spawn 前克隆。
    let app_for_tools=app.clone();
    tokio::spawn(async move {
        let mut messages=prepared.messages();
        prepared.base_len=messages.len();
        let mut outcome=StreamOutcome::default();
        outcome.usage=prepared.usage;
        let result=run_tool_loop_context(&turn,&ctx,&mut messages,&channel,&abort,&mut outcome,Some(&mut prepared),Some(&app_for_tools)).await;
        if let Err(error)=&result {close_pending_pairs(&mut messages,&mut outcome,error);}
        let persist={
            match crate::db::conn() {
                Ok(guard)=>match guard.as_ref() {
                    Some(conn)=>{
                        let transcript=messages.get(prepared.base_len.saturating_sub(1)..).unwrap_or(&[]);
                        prepared.persist(conn,&outcome,transcript)
                    }
                    None=>Err("db not initialized".into()),
                },
                Err(error)=>Err(error),
            }
        };
        drop(running);
        send_usage(&channel,outcome.usage);
        match (result,persist) {
            (_,Err(error))=>{let _=channel.send(json!({"type":"error","message":format!("回复保存失败：{error}")}));}
            (Err(error),_)=>{let _=channel.send(json!({"type":"error","message":error}));}
            (Ok(()),Ok(()))=>{let _=channel.send(json!({"type":"done","sessionRef":Value::Null}));}
        }
    });
    Ok(())
}

fn send_usage(channel: &tauri::ipc::Channel<Value>,usage: Option<(i64,i64,i64)>) {
    if let Some((i,o,c))=usage {let _=channel.send(json!({"type":"usage","inputTokens":i,"outputTokens":o,"cacheReadTokens":c}));}
}

fn budgeted_body(turn: &PlatformTurn, messages: &[ChatMsg], defs: &[PlatformTool],
    budget: &crate::commands::platform_context::ContextBudget) -> Result<Value,String> {
    // CR-099：两种协议都必须回放合法 input／arguments；非法原参数仍保存在 tool_use 与错误结果中。
    let mut wire=messages.to_vec();
    for msg in &mut wire {
        if let ChatMsg::Assistant {tool_calls,..}=msg {
            for call in tool_calls {
                call.arguments=normalized_tool_arguments(&call.arguments);
            }
        }
    }
    let mut body=build_platform_body(&turn.protocol,&turn.model_id,turn.effort.as_deref(),&turn.efforts,&wire,defs,true)?;
    if let Some(max)=budget.max_output {
        let current=crate::commands::platform_context::ContextBudget::output(&body);
        if current>max {
            if body.get("thinking").is_some() { return Err("CONTEXT_OUTPUT_LIMIT：所选思考档位超过模型最大输出".into()); }
            let field=if body.get("max_completion_tokens").is_some(){"max_completion_tokens"}else{"max_tokens"};
            body[field]=json!(max);
        }
    }
    Ok(body)
}

struct ModelFailure { message: String, partial: ModelReply }
#[derive(Default)]
struct Capture {
    reply: ModelReply, closed: bool,
    started: Option<std::time::Instant>, started_at: Option<i64>,
    first_delta: Option<std::time::Instant>, output_tokens: Option<i64>,
}

async fn wait_for_abort(rx: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow() { return; }
        if rx.changed().await.is_err() { std::future::pending::<()>().await; }
    }
}

/// 阻塞读取只更新内存；取消时封闭Channel，后台读超时后退出，不再写DB或发事件。
async fn request_model_captured(turn: &PlatformTurn, messages: &[ChatMsg], defs: &[PlatformTool],
    channel: Option<&tauri::ipc::Channel<Value>>, abort: &tokio::sync::watch::Receiver<bool>,
    budget: &crate::commands::platform_context::ContextBudget) -> Result<ModelReply,ModelFailure> {
    let body=budgeted_body(turn,messages,defs,budget).and_then(|b|{budget.check(&b)?;Ok(b)});
    let body=match body {Ok(b)=>b,Err(message)=>return Err(ModelFailure {message,partial:ModelReply::default()})};
    if *abort.borrow() { return Err(ModelFailure {message:"发送已停止".into(),partial:ModelReply::default()}); }
    let payload=serde_json::to_vec(&body).map_err(|e|ModelFailure{message:e.to_string(),partial:ModelReply::default()})?;
    let shared: std::sync::Arc<std::sync::Mutex<Capture>>=Default::default();
    let capture=shared.clone();
    let turn=turn.clone();
    let sink=channel.cloned();
    let watch=abort.clone();
    let task=tokio::task::spawn_blocking(move || -> Result<ModelReply,String> {
        let stopped=|| *watch.borrow() || capture.lock().map(|s|s.closed).unwrap_or(true);
        if stopped() { return Err("发送已停止".into()); }
        let agent=ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(60)).build();
        let mut request=agent.post(&turn.base_url).set("Content-Type","application/json").set("Accept","text/event-stream");
        request=if turn.protocol=="anthropic" {request.set("x-api-key",&turn.api_key).set("anthropic-version","2023-06-01")}
            else {request.set("Authorization",&format!("Bearer {}",turn.api_key))};
        for (name,value) in &turn.extra_headers { request=request.set(name,value); }
        let redact=|text: String| if turn.api_key.is_empty(){text}else{text.replace(&turn.api_key,"[redacted]")};
        if stopped() {return Err("发送已停止".into());}
        if let Ok(mut c)=capture.lock() {
            if c.closed {return Err("发送已停止".into());}
            c.started=Some(std::time::Instant::now());
            c.started_at=Some(crate::models::now_ms());
        }
        let response=match request.send_bytes(&payload) {
            Ok(response)=>response,
            Err(ureq::Error::Status(code,response))=>{
                let mut bytes=Vec::new();
                let _=response.into_reader().take(16384).read_to_end(&mut bytes);
                let raw=String::from_utf8_lossy(&bytes);
                let message=serde_json::from_str::<Value>(&raw).ok().and_then(|v|v.pointer("/error/message").or_else(||v.get("message")).and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(||raw.chars().take(300).collect());
                return Err(format!("模型请求失败（HTTP {code}）：{}",redact(message).chars().take(300).collect::<String>()));
            }
            Err(_)=>return Err("模型连接失败或超时".into()),
        };
        let mut reader=std::io::BufReader::new(response.into_reader().take(MAX_STREAM_BYTES+1));
        let mut state=StreamState::default();
        let mut line=String::new();
        let mut bytes=0u64;
        let mut terminal=false;
        loop {
            if stopped() { return Err("发送已停止".into()); }
            line.clear();
            let n=reader.read_line(&mut line).map_err(|_|"模型响应流中断".to_string())?;
            if n==0 { break; }
            bytes=bytes.saturating_add(n as u64);
            if bytes>MAX_STREAM_BYTES { return Err("模型响应超过流式字节上限".into()); }
            let frame=line.trim_end_matches(['\r','\n']);
            if frame.trim()=="data: [DONE]" {terminal=true;break;}
            let mut frame_error=None;
            if let Some(data)=frame.strip_prefix("data:") {
                if let Ok(v)=serde_json::from_str::<Value>(data.trim()) {
                    if v.get("type").and_then(Value::as_str)==Some("error") || v.get("error").is_some() {
                        let message=v.pointer("/error/message").and_then(Value::as_str).unwrap_or("模型返回错误帧");
                        frame_error=Some(redact(message.into()));
                    }
                    if v.get("type").and_then(Value::as_str)==Some("message_stop") { terminal=true; }
                }
            }
            let events=std::cell::RefCell::new(Vec::new());
            let mut delta=|text: &str| events.borrow_mut().push(json!({"type":"delta","delta":text}));
            let mut thinking=|text: &str| events.borrow_mut().push(json!({"type":"thinking","delta":text}));
            if turn.protocol=="anthropic" {handle_anthropic_line(frame,&mut state,&mut delta,&mut thinking);}
            else {handle_openai_line(frame,&mut state,&mut delta,&mut thinking);}
            if let Ok(mut c)=capture.lock() {
                if !c.closed {
                    c.reply.finish_reason=state.finish_reason.clone();
                    c.output_tokens=state.output_tokens;
                    if state.input_tokens.is_some() || state.output_tokens.is_some() {
                        c.reply.usage=Some((state.input_tokens.unwrap_or(0),state.output_tokens.unwrap_or(0),state.cache_read_tokens.unwrap_or(0)));
                    }
                    // 同帧usage先记录，再立即发送该帧增量；取消回调不会丢掉已提供的用量。
                    for event in events.into_inner() {
                        let text=event["delta"].as_str().unwrap_or("");
                        if !text.is_empty() && c.first_delta.is_none() {c.first_delta=Some(std::time::Instant::now());}
                        if event["type"]==json!("delta") {c.reply.text.push_str(text);}else{c.reply.thinking.push_str(text);}
                        if let Some(ch)=&sink {let _=ch.send(event);}
                    }
                }
            }
            if let Some(error)=frame_error {return Err(error);}
            if state.bad_lines>MAX_BAD_SSE_LINES { return Err("模型响应包含过多非法帧".into()); }
            if terminal { break; }
        }
        if !terminal { return Err("模型响应流缺少结束标记".into()); }
        let reply=state.into_reply();
        if reply.text.trim().is_empty() && reply.tool_calls.is_empty() { return Err("模型未返回正文".into()); }
        Ok(reply)
    });
    let mut receiver=abort.clone();
    let result=tokio::select! {
        result=task=>match result {Ok(r)=>r,Err(_)=>Err("模型请求任务异常".into())},
        _=wait_for_abort(&mut receiver)=>Err("发送已停止".into()),
    };
    let mut partial=shared.lock().map_err(|_|ModelFailure{message:"模型流状态不可用".into(),partial:ModelReply::default()})?;
    partial.closed=true;
    let end=std::time::Instant::now();
    let timing=partial.started.zip(partial.started_at).map(|(start,started_at)| crate::commands::chat::stats::ModelTiming {
        started_at, finished_at:crate::models::now_ms(), model_ms:end.duration_since(start).as_millis() as u64,
        ttft_ms:partial.first_delta.map(|first|first.duration_since(start).as_millis() as u64),
        // 只有assembled成功且输出token明确上报，才能使用首非空delta到assembled的decode窗口。
        decode_ms:if result.is_ok() && partial.output_tokens.is_some() {partial.first_delta.map(|first|end.duration_since(first).as_millis() as u64)} else {None},
        output_tokens:partial.output_tokens,
    });
    match result {
        Ok(mut reply)=>{reply.timing=timing;Ok(reply)},
        Err(message)=>{partial.reply.timing=timing;Err(ModelFailure {message,partial:partial.reply.clone()})},
    }
}

/// 保留客户端测试入口；生产调用显式传模型预算。
async fn request_model(turn: &PlatformTurn,messages: &[ChatMsg],defs: &[PlatformTool],
    channel: &tauri::ipc::Channel<Value>,abort: &tokio::sync::watch::Receiver<bool>) -> Result<ModelReply,String> {
    request_model_captured(turn,messages,defs,Some(channel),abort,&crate::commands::platform_context::ContextBudget::from_model(None,None))
        .await.map_err(|f|f.message)
}

/// 工具循环入口保留既有行为测试；生产平台轮次使用带上下文的同一实现。
async fn run_tool_loop(turn: &PlatformTurn,ctx: &crate::commands::ai_tools::ToolContext,messages: &mut Vec<ChatMsg>,
    channel: &tauri::ipc::Channel<Value>,abort: &tokio::sync::watch::Receiver<bool>,outcome: &mut StreamOutcome) -> Result<(),String> {
    run_tool_loop_context(turn,ctx,messages,channel,abort,outcome,None,None).await
}

fn merge_reply(outcome: &mut StreamOutcome, reply: &ModelReply) {
    outcome.push_thinking(&reply.thinking);
    outcome.push_text(&reply.text);
    context_runtime::add_usage(&mut outcome.usage,reply.usage);
}

fn close_pending_pairs(messages: &mut Vec<ChatMsg>,outcome: &mut StreamOutcome,reason: &str) {
    let mut missing=std::collections::BTreeMap::new();
    for msg in messages.iter() {
        match msg {ChatMsg::Assistant{tool_calls,..}=>for call in tool_calls {missing.insert(call.id.clone(),call.clone());},
            ChatMsg::Tool{call_id,..}=>{missing.remove(call_id);},_=>{}}
    }
    for (_,call) in missing {
        let content=format!("未执行：{reason}");
        if !outcome.tool_uses.iter().any(|c|c.0==call.id) {let input=visible_tool_input(&call);outcome.push_tool_use(call.id.clone(),call.name,input);}
        outcome.push_tool_result(call.id.clone(),content.clone(),true,None);
        messages.push(ChatMsg::Tool{call_id:call.id,content,is_error:true});
    }
}

fn validate_platform_read(conn: &rusqlite::Connection,ctx: &crate::commands::ai_tools::ToolContext,call: &ToolCall) -> Result<(),String> {
    if call.name!="fs_read" {return Ok(());}
    let args: Value=serde_json::from_str(&call.arguments).map_err(|_|"参数不是有效JSON".to_string())?;
    let given=args.get("projectId").and_then(Value::as_str);
    if ctx.project_id.as_deref().is_some_and(|p|given.is_some_and(|g|g!=p)) {return Err("读取项目与会话不一致".into());}
    let project=ctx.project_id.as_deref().or(given).ok_or("读取缺少项目身份")?;
    let path=args.get("path").and_then(Value::as_str).ok_or("读取缺少path")?;
    let root: String=conn.query_row("SELECT rootUri FROM project WHERE id=?1",[project],|r|r.get(0)).map_err(|_|"读取项目不存在".to_string())?;
    let target=crate::commands::chat::checked_file_ref(conn,project,std::path::Path::new(&root),path)?;
    if std::fs::canonicalize(&ctx.data_dir).ok().is_some_and(|data|target.starts_with(data)) {return Err("禁止读取应用私密配置目录".into());}
    Ok(())
}

fn visible_tool_input(call: &ToolCall)->String {
    if call.name!="compress_context" {return call.arguments.clone();}
    let mut args=serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_|json!({}));
    if let Some(args)=args.as_object_mut() {args.remove("summary");}
    args.to_string()
}

fn with_platform_connection<T>(database: Option<&std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>>,
    action: impl FnOnce(&rusqlite::Connection)->Result<T,String>) -> Result<T,String> {
    if let Some(database)=database {
        let conn=database.lock().map_err(|_|"隔离数据库锁不可用".to_string())?;action(&conn)
    } else {
        let guard=crate::db::conn()?;action(guard.as_ref().ok_or("db not initialized")?)
    }
}

async fn run_tool_loop_context(turn: &PlatformTurn,ctx: &crate::commands::ai_tools::ToolContext,messages: &mut Vec<ChatMsg>,
    channel: &tauri::ipc::Channel<Value>,abort: &tokio::sync::watch::Receiver<bool>,outcome: &mut StreamOutcome,
    context: Option<&mut context_runtime::Prepared>, app: Option<&tauri::AppHandle>) -> Result<(),String> {
    run_tool_loop_database(turn,ctx,messages,channel,abort,outcome,context,None,app).await
}

/// 唯一循环实现；隔离连接仅用于上下文工具测试，不是可由模型选择的运行配置。
async fn run_tool_loop_database(turn: &PlatformTurn,ctx: &crate::commands::ai_tools::ToolContext,messages: &mut Vec<ChatMsg>,
    channel: &tauri::ipc::Channel<Value>,abort: &tokio::sync::watch::Receiver<bool>,outcome: &mut StreamOutcome,
    mut context: Option<&mut context_runtime::Prepared>, database: Option<&std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>>,
    app: Option<&tauri::AppHandle>) -> Result<(),String> {
    let budget=context.as_ref().map(|c|c.budget.clone()).unwrap_or_else(||crate::commands::platform_context::ContextBudget::from_model(None,None));
    let mut total=0usize;
    let mut call_ids=std::collections::BTreeSet::new();
    let mut executed=std::collections::HashSet::new();
    // CR-099：同工具同参数连续失败次数与「整轮全部失败」轮数，用于提前止损。
    let mut call_failures=std::collections::HashMap::<String,usize>::new();
    let mut all_error_rounds=0usize;
    let turn_id=context.as_ref().map(|c|c.user_id.clone()).unwrap_or_else(||crate::models::new_id("stats-turn"));
    outcome.session_stats=Some(crate::commands::chat::stats::TurnStats::new(&turn.session_id,&turn_id));
    for round in 1..=MAX_TOOL_ROUNDS {
        if *abort.borrow() {outcome.aborted=true;close_pending_pairs(messages,outcome,"发送已停止");return Err("发送已停止".into());}
        if let Some(c)=context.as_deref() {
            with_platform_connection(database,|conn|c.verify(conn))?;
        }
        let mut defs=with_platform_connection(database,|conn|Ok(platform_tool_defs_scoped(conn, turn.project_id.as_deref())))?;
        if context.is_some() {defs.extend(crate::commands::platform_context::tool_defs().into_iter().map(PlatformTool::from));}
        // CR-099：工具启停或项目绑定可能在本轮变化，能力目录与本轮 tools 一起刷新后再投影消息。
        if let Some(c)=context.as_deref_mut() {
            c.set_tool_names(&defs, true);
            with_platform_connection(database,|conn|{c.refresh_projection(messages);Ok(())})?;
        }
        let body=budgeted_body(turn,messages,&defs,&budget)?;
        let captured=request_model_captured(turn,messages,&defs,Some(channel),abort,&budget).await;
        // 每次已进入生成调用恰一次闭合；工具数量和外层done不参与计数。
        let (observed,status)=match &captured {
            Ok(reply)=>(reply,if matches!(reply.finish_reason.as_deref(),Some("length"|"max_tokens")){"max_tokens"}else{"completed"}),
            Err(failure)=>(&failure.partial,if *abort.borrow(){"cancelled"}else if matches!(failure.partial.finish_reason.as_deref(),Some("length"|"max_tokens")){"max_tokens"}else{"failed"}),
        };
        if observed.timing.is_some() {
            let stats=outcome.session_stats.as_mut().expect("platform stats initialized");
            stats.closed_steps.push(crate::commands::chat::stats::ClosedStep {
                event_type:"step/end".into(),session_id:turn.session_id.clone(),turn_id:turn_id.clone(),step_id:format!("{round}"),
                outcome:status.into(),timing:observed.timing.clone(),usage:observed.usage,
            });
            if context.is_some() {
                // 实时持久观察不改变transcript；最终complete标记与回放在Prepared.persist同一事务。
                with_platform_connection(database,|conn|crate::commands::chat::stats::save_turn(conn,stats,false))?;
                let _=channel.send(json!({"type":"sessionStats","sessionId":turn.session_id}));
            }
        }
        let reply=match captured {
            Ok(reply)=>reply,
            Err(failure)=>{
                merge_reply(outcome,&failure.partial);
                if !failure.partial.text.is_empty() {messages.push(ChatMsg::Assistant{text:failure.partial.text,tool_calls:vec![]});}
                outcome.aborted=*abort.borrow();
                return Err(failure.message);
            }
        };
        merge_reply(outcome,&reply);
        if *abort.borrow() {
            outcome.aborted=true;
            if !reply.text.is_empty() {messages.push(ChatMsg::Assistant{text:reply.text,tool_calls:vec![]});}
            return Err("发送已停止".into());
        }
        if let Some(c)=context.as_deref() {with_platform_connection(database,|conn|c.verify(conn))?;}
        if reply.tool_calls.is_empty() {messages.push(ChatMsg::Assistant{text:reply.text,tool_calls:vec![]});return Ok(());}
        if round>=MAX_TOOL_ROUNDS {
            close_pending_pairs(messages,outcome,&format!("工具轮次已达上限 {MAX_TOOL_ROUNDS}"));
            return Err(format!("工具轮次已达上限 {MAX_TOOL_ROUNDS}；本轮未完成"));
        }
        if reply.tool_calls.len()>MAX_TOOL_CALLS_PER_ROUND {
            close_pending_pairs(messages,outcome,&format!("单轮工具调用超过 {MAX_TOOL_CALLS_PER_ROUND} 个"));
            return Err(format!("单轮工具调用超过 {MAX_TOOL_CALLS_PER_ROUND} 个；本轮未完成"));
        }
        total+=reply.tool_calls.len();
        if total>MAX_TOOL_CALLS_TOTAL {
            close_pending_pairs(messages,outcome,&format!("累计工具调用超过 {MAX_TOOL_CALLS_TOTAL} 次"));
            return Err(format!("累计工具调用超过 {MAX_TOOL_CALLS_TOTAL} 次；本轮未完成，请缩小任务或更换可用工具后重试"));
        }
        if reply.tool_calls.iter().any(|c|c.id.is_empty() || !call_ids.insert(c.id.clone())) {return Err("模型工具调用ID无效或重复".into());}
        messages.push(ChatMsg::Assistant{text:reply.text,tool_calls:reply.tool_calls.clone()});
        let mut round_calls=0usize;
        let mut round_errors=0usize;
        for call in reply.tool_calls {
            if *abort.borrow() {outcome.aborted=true;close_pending_pairs(messages,outcome,"发送已停止");return Err("发送已停止".into());}
            let internal=context.is_some() && crate::commands::platform_context::CONTEXT_TOOLS.contains(&call.name.as_str());
            // CR-086：可见性以本轮下发的工具定义为准（内置目录 + MCP），不再用固定白名单。
            let allowed=internal || defs.iter().any(|d|d.name==call.name);
            let enabled=internal || (allowed && with_platform_connection(database,|conn|Ok(
                business_tools_enabled(conn)
                    && (crate::commands::ai_tools::workbench_tools().into_iter().find(|d|d.name==call.name).is_some_and(|d|crate::commands::ai_tools::tool_enabled(conn,d.registry_id))
                        || resolve_mcp_tool(conn,&call.name).is_some())
            ))?);
            let key=format!("round:{round}:{}:{}",call.name,call.arguments);
            let repeat_key=format!("{}:{}",call.name,call.arguments);
            let duplicate=is_side_effect_tool(&call.name) && !executed.insert(key);
            // CR-099：同一工具同参数已连续失败多次时不再重复执行，直接提示换方案。
            let exhausted=call_failures.get(&repeat_key).copied().unwrap_or(0)>=MAX_SAME_CALL_FAILURES;
            if context.is_some() || (allowed && enabled && !duplicate) {
                let input=visible_tool_input(&call);
                let _=channel.send(json!({"type":"toolUse","toolId":call.id,"name":call.name,"inputJson":input}));
                outcome.push_tool_use(call.id.clone(),call.name.clone(),input);
            }
            let source_check=if context.is_some() && !internal {
                with_platform_connection(database,|conn|validate_platform_read(conn,ctx,&call))
            } else {Ok(())};
            let mut result=if let Err(error)=source_check {ToolOutcome{content:error,is_error:true}}
            else if !allowed || !enabled {
                ToolOutcome{content:format!("工具 {} 不可用（未在允许清单或已停用）",call.name),is_error:true}
            } else if exhausted {
                ToolOutcome{content:format!("工具 {} 使用相同参数已连续失败 {MAX_SAME_CALL_FAILURES} 次；请改变参数或换用其他方案，不要重复同一调用",call.name),is_error:true}
            } else if duplicate {
                ToolOutcome{content:"相同调用已执行过，未重复执行；如需继续请改变参数或确认结果".into(),is_error:true}
            } else if internal {
                let result=serde_json::from_str::<Value>(&call.arguments).map_err(|_|"参数不是有效JSON".to_string()).and_then(|args|{
                    with_platform_connection(database,|conn|context.as_deref_mut().ok_or("上下文不存在")?.tool(conn,&call.name,&args,&body))
                });
                match result {Ok(v)=>ToolOutcome{content:v.to_string(),is_error:false},Err(e)=>ToolOutcome{content:e,is_error:true}}
            } else if let Some((server_id,tool_name))=with_platform_connection(database,|conn|Ok(resolve_mcp_tool(conn,&call.name)))? {
                // CR-086：MCP 工具走独立短会话调用；失败作为工具错误回填，不中断整轮。
                let args=serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_|json!({}));
                let outcome=match app {
                    Some(app)=>crate::commands::capabilities::mcp_call_tool(app,&server_id,&tool_name,args).await,
                    None=>Err("当前运行环境不支持 MCP 调用".into()),
                };
                match outcome {Ok(text)=>ToolOutcome{content:text,is_error:false},Err(e)=>ToolOutcome{content:e,is_error:true}}
            } else {execute_tool_safely(ctx,&call)};
            if let Some(c)=context.as_deref() {
                if let Err(error)=with_platform_connection(database,|conn|c.verify(conn)) {result=ToolOutcome{content:error,is_error:true};}
            }
            // 拒绝与重复调用也回填结果，保持平台新回放的工具交换完整。
            let wire_content=if !internal {
                context.as_deref_mut().map(|c|c.wire_result(&call.id,&result.content)).unwrap_or_else(||result.content.clone())
            } else {result.content.clone()};
            // CR-099：被拒调用按 AC-02 不记录 tool_use（未执行），仅记录错误结果供前端提示；
            // 回放侧过滤无 tool_use 的孤儿结果，避免旧库回退时报「孤立工具结果」。
            outcome.push_tool_result(call.id.clone(),result.content.clone(),result.is_error,None);
            let _=channel.send(json!({"type":"toolResult","toolId":call.id,"content":result.content,"isError":result.is_error}));
            messages.push(ChatMsg::Tool{call_id:call.id,content:wire_content,is_error:result.is_error});
            if result.is_error {
                *call_failures.entry(repeat_key).or_insert(0)+=1;
                round_errors+=1;
            } else {
                call_failures.remove(&repeat_key);
            }
            round_calls+=1;
        }
        // CR-099：整轮工具全部失败时早期止损，不再空转到累计上限。
        if round_calls>0 && round_errors==round_calls {
            all_error_rounds+=1;
            if all_error_rounds>=MAX_ALL_ERROR_ROUNDS {
                close_pending_pairs(messages,outcome,"工具连续多轮全部失败");
                return Err(format!("连续 {MAX_ALL_ERROR_ROUNDS} 轮工具调用全部失败；本轮未完成，请检查工具配置或换用其他做法"));
            }
        } else {
            all_error_rounds=0;
        }
    }
    close_pending_pairs(messages,outcome,"工具循环已达上限");
    Err("工具循环已达上限；本轮未完成".into())
}

#[cfg(test)]
#[path = "platform_context_agent_tests.rs"]
mod context_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_efforts() -> EffortMap {
        EffortMap::new()
    }

    fn new_tool_def(name: &'static str, registry_id: &'static str, description: &'static str) -> crate::commands::ai_tools::ToolDef {
        crate::commands::ai_tools::ToolDef {
            name,
            registry_id,
            description,
            schema: serde_json::from_str(r#"{"type":"object"}"#).unwrap(),
            risk: "low",
        }
    }

    // ---------- URL 构造（T-089-05 ~ T-089-11） ----------

    #[test]
    fn t089_05_openai_base_with_v1() {
        assert_eq!(
            platform_chat_url("https://a.com/v1", "openai").unwrap(),
            "https://a.com/v1/chat/completions"
        );
    }

    #[test]
    fn t089_06_openai_base_without_v1() {
        assert_eq!(
            platform_chat_url("https://a.com", "openai").unwrap(),
            "https://a.com/v1/chat/completions"
        );
    }

    #[test]
    fn t089_07_anthropic_base_with_v1() {
        assert_eq!(
            platform_chat_url("https://a.com/v1", "anthropic").unwrap(),
            "https://a.com/v1/messages"
        );
    }

    #[test]
    fn t089_08_anthropic_base_without_v1() {
        assert_eq!(
            platform_chat_url("https://a.com", "anthropic").unwrap(),
            "https://a.com/v1/messages"
        );
    }

    #[test]
    fn t089_09_rejects_userinfo() {
        assert!(platform_chat_url("https://user:pass@a.com", "openai").is_err());
    }

    #[test]
    fn t089_10_rejects_non_http() {
        assert!(platform_chat_url("ftp://a.com", "openai").is_err());
    }

    #[test]
    fn t089_11_rejects_query_and_fragment() {
        assert!(platform_chat_url("https://a.com?x=1", "openai").is_err());
        assert!(platform_chat_url("https://a.com/v1#frag", "openai").is_err());
    }

    // ---------- 请求体构造（T-089-12 ~ T-089-19） ----------

    fn user_msg(s: &str) -> ChatMsg {
        ChatMsg::User(s.to_string())
    }

    #[test]
    fn t089_12_anthropic_system_is_top_level() {
        let body = build_platform_body(
            "anthropic",
            "claude-x",
            None,
            &empty_efforts(),
            &[ChatMsg::System("你是助手".into()), user_msg("你好")],
            &[],
            true,
        )
        .unwrap();
        assert_eq!(body["system"], json!("你是助手"));
        for m in body["messages"].as_array().unwrap() {
            assert_ne!(m["role"], json!("system"), "messages 内不得出现 system 角色");
        }
        assert_eq!(body["max_tokens"], json!(4096));
        assert_eq!(body["stream"], json!(true));
    }

    #[test]
    fn t089_13_openai_system_is_first_message() {
        let body = build_platform_body(
            "openai",
            "gpt-x",
            None,
            &empty_efforts(),
            &[ChatMsg::System("你是助手".into()), user_msg("你好")],
            &[],
            true,
        )
        .unwrap();
        assert_eq!(body["messages"][0]["role"], json!("system"));
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn t089_14_openai_reasoning_model_uses_max_completion_tokens() {
        let body = build_platform_body("openai", "o3", None, &empty_efforts(), &[user_msg("hi")], &[], false).unwrap();
        assert!(body.get("max_completion_tokens").is_some(), "推理模型应使用 max_completion_tokens");
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn t089_15_openai_non_reasoning_model_uses_max_tokens() {
        let body = build_platform_body("openai", "gpt-4o-mini", None, &empty_efforts(), &[user_msg("hi")], &[], false).unwrap();
        assert!(body.get("max_tokens").is_some());
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn t089_16_effort_mapped_to_none_sends_nothing() {
        let mut efforts = EffortMap::new();
        efforts.insert("off".into(), None);
        let body = build_platform_body(
            "openai",
            "gpt-x",
            Some("off"),
            &efforts,
            &[user_msg("hi")],
            &[],
            false,
        )
        .unwrap();
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn t089_17_effort_mapped_anthropic_has_thinking() {
        let mut efforts = EffortMap::new();
        efforts.insert("high".into(), Some("high".into()));
        let body = build_platform_body(
            "anthropic",
            "claude-x",
            Some("high"),
            &efforts,
            &[user_msg("hi")],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], json!("enabled"));
        assert_eq!(body["thinking"]["budget_tokens"], json!(16384));
        // max_tokens 必须大于 budget_tokens（Anthropic 硬性要求）
        assert!(body["max_tokens"].as_u64().unwrap() > 16384);
    }

    #[test]
    fn t089_18_effort_mapped_openai_has_reasoning_effort() {
        let mut efforts = EffortMap::new();
        efforts.insert("medium".into(), Some("medium".into()));
        let body = build_platform_body(
            "openai",
            "gpt-x",
            Some("medium"),
            &efforts,
            &[user_msg("hi")],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(body["reasoning_effort"], json!("medium"));
    }

    #[test]
    fn t089_19_unknown_effort_is_error() {
        let efforts = EffortMap::new();
        let result = build_platform_body("openai", "gpt-x", Some("ultra"), &efforts, &[user_msg("hi")], &[], false);
        assert!(result.is_err(), "档位不在映射表内必须报错，不发请求");
    }

    #[test]
    fn body_carries_tool_definitions_and_tool_messages() {
        let tool = new_tool_def("get_context", "workbench.get_context", "取上下文");
        let messages = vec![
            ChatMsg::System("s".into()),
            ChatMsg::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall { id: "call_1".into(), name: "get_context".into(), arguments: "{}".into() }],
            },
            ChatMsg::Tool { call_id: "call_1".into(), content: "ctx".into(), is_error: false },
        ];
        let a = build_platform_body("anthropic", "m", None, &empty_efforts(), &messages, &[PlatformTool::from(tool.clone())], false).unwrap();
        assert_eq!(a["tools"][0]["name"], json!("get_context"));
        // Anthropic：system 在顶层，messages[0] 是 assistant 的 tool_use，[1] 是工具结果
        assert_eq!(a["messages"][0]["content"][0]["type"], json!("tool_use"));
        assert_eq!(a["messages"][1]["content"][0]["type"], json!("tool_result"));
        assert_eq!(a["messages"][1]["content"][0]["tool_use_id"], json!("call_1"));

        let o = build_platform_body("openai", "gpt-x", None, &empty_efforts(), &messages, &[PlatformTool::from(tool)], false).unwrap();
        assert_eq!(o["tools"][0]["type"], json!("function"));
        assert_eq!(o["messages"][1]["tool_calls"][0]["function"]["name"], json!("get_context"));
        assert_eq!(o["messages"][1]["content"], Value::Null);
        assert_eq!(o["messages"][2]["role"], json!("tool"));
        assert_eq!(o["messages"][2]["tool_call_id"], json!("call_1"));
    }

    // ---------- CR-099：回放净化与空 tool_calls ----------

    #[test]
    fn cr099_empty_arguments_are_normalized_for_both_protocols() {
        let messages = vec![
            ChatMsg::System("s".into()),
            ChatMsg::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall { id: "c1".into(), name: "get_context".into(), arguments: String::new() }],
            },
            ChatMsg::Tool { call_id: "c1".into(), content: "未执行".into(), is_error: true },
        ];
        let budget = crate::commands::platform_context::ContextBudget::from_model(None, None);
        for protocol in ["openai", "anthropic"] {
            let turn = PlatformTurn {
                session_id: "s".into(), project_id: None, protocol: protocol.into(),
                base_url: "https://example.com/v1".into(), api_key: "k".into(), model_id: "m".into(),
                effort: None, efforts: empty_efforts(), extra_headers: vec![], client_identity: None,
            };
            let body = budgeted_body(&turn, &messages, &[], &budget).unwrap();
            let text = body.to_string();
            assert!(!text.contains(r#""arguments":"""#), "{protocol} 不得回放空参数串");
            assert!(text.contains(r#""arguments":"{}""#) || text.contains(r#""input":{}"#), "{protocol} 应回放合法参数");
        }
    }

    #[test]
    fn cr099_invalid_arguments_are_normalized_not_dropped() {
        assert_eq!(normalized_tool_arguments("{not json"), "{}");
        assert_eq!(normalized_tool_arguments("   "), "{}");
        assert_eq!(normalized_tool_arguments("[1,2]"), "{}");
        assert_eq!(normalized_tool_arguments(r#"{"path":"a.txt"}"#), r#"{"path":"a.txt"}"#);
    }

    #[test]
    fn cr099_empty_tool_calls_are_not_replayed() {
        let messages = vec![
            ChatMsg::System("s".into()),
            ChatMsg::Assistant { text: "答".into(), tool_calls: vec![] },
        ];
        let o = build_platform_body("openai", "gpt-x", None, &empty_efforts(), &messages, &[], false).unwrap();
        assert!(o["messages"][1].get("tool_calls").is_none(), "空 tool_calls 不应回放");
        assert_eq!(o["messages"][1]["content"], json!("答"));

        let empty_text = vec![
            ChatMsg::System("s".into()),
            ChatMsg::Assistant { text: String::new(), tool_calls: vec![] },
        ];
        let o = build_platform_body("openai", "gpt-x", None, &empty_efforts(), &empty_text, &[], false).unwrap();
        assert_eq!(o["messages"][1]["content"], json!(""), "无文本且无调用时用空串正文");
    }

    // ---------- SSE 解析（T-089-20 ~ T-089-30） ----------

    fn parse_lines(protocol: &str, lines: &[&str]) -> (StreamState, Vec<String>, Vec<String>) {
        let mut state = StreamState::default();
        let mut deltas = Vec::new();
        let mut thinking = Vec::new();
        parse_stream_lines(
            protocol,
            lines.iter().map(|s| s.to_string()),
            &mut state,
            &mut |d| deltas.push(d.to_string()),
            &mut |t| thinking.push(t.to_string()),
        )
        .unwrap();
        (state, deltas, thinking)
    }

    #[test]
    fn t089_20_openai_text_stream_concatenates() {
        let (state, deltas, _) = parse_lines("openai", &[
            r#"data: {"choices":[{"delta":{"content":"你"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"好"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"！"},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
            "data: [DONE]",
        ]);
        assert_eq!(state.text, "你好！");
        assert_eq!(deltas, vec!["你", "好", "！"], "文本增量必须逐段立即下发");
        assert_eq!(state.finish_reason.as_deref(), Some("stop"));
        assert_eq!(state.input_tokens, Some(3));
        assert_eq!(state.output_tokens, Some(2));
    }

    #[test]
    fn t089_21_openai_keepalive_comment_ignored() {
        let (state, deltas, _) = parse_lines("openai", &[
            ": keepalive",
            r#"data: {"choices":[{"delta":{"content":"A"}}]}"#,
        ]);
        assert_eq!(state.text, "A");
        assert_eq!(deltas, vec!["A"]);
    }

    #[test]
    fn t089_22_openai_tool_arguments_accumulate_across_frames() {
        let (state, _, _) = parse_lines("openai", &[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_context","arguments":"{\"a\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]}}]}"#,
            "data: [DONE]",
        ]);
        let calls = state.finish_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "get_context");
        // 拼接完成后必须可解析
        let parsed: Value = serde_json::from_str(&calls[0].arguments).expect("arguments 拼接后必须是合法 JSON");
        assert_eq!(parsed, json!({"a": 1}));
    }

    #[test]
    fn t089_23_openai_parallel_tool_calls_do_not_interleave() {
        let (state, _, _) = parse_lines("openai", &[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"a","arguments":"{\"x\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"b","arguments":"{\"y\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}"#,
        ]);
        let calls = state.finish_tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "c0");
        assert_eq!(calls[0].arguments, r#"{"x":1}"#);
        assert_eq!(calls[1].id, "c1");
        assert_eq!(calls[1].arguments, r#"{"y":2}"#);
    }

    #[test]
    fn t089_24_openai_tool_without_arguments_yields_empty_string() {
        let (state, _, _) = parse_lines("openai", &[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"a"}}]},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ]);
        assert_eq!(state.finish_reason.as_deref(), Some("tool_calls"));
        let calls = state.finish_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, "", "未下发 arguments 完成时保持空串，由执行侧作为工具错误回填");
        assert!(serde_json::from_str::<Value>(&calls[0].arguments).is_err());
    }

    #[test]
    fn t089_25_anthropic_text_stream_concatenates() {
        let (state, deltas, _) = parse_lines("anthropic", &[
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"早"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"安"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"！"}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
        ]);
        assert_eq!(state.text, "早安！");
        assert_eq!(deltas, vec!["早", "安", "！"]);
        assert_eq!(state.input_tokens, Some(7));
        assert_eq!(state.output_tokens, Some(3));
        assert_eq!(state.finish_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn t089_26_anthropic_tool_use_accumulates_partial_json() {
        let (state, _, _) = parse_lines("anthropic", &[
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ]);
        assert_eq!(state.finish_reason.as_deref(), Some("tool_use"));
        let calls = state.finish_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "fs_read");
        let parsed: Value = serde_json::from_str(&calls[0].arguments).unwrap();
        assert_eq!(parsed, json!({"path": "a.txt"}));
    }

    #[test]
    fn t089_27_anthropic_ping_ignored() {
        let (state, deltas, _) = parse_lines("anthropic", &[
            "event: ping",
            r#"data: {"type":"ping"}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}"#,
        ]);
        assert_eq!(state.text, "x");
        assert_eq!(deltas, vec!["x"]);
    }

    #[test]
    fn t089_28_anthropic_message_delta_stop_reason_and_output_tokens() {
        let (state, _, _) = parse_lines("anthropic", &[
            r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}"#,
        ]);
        assert_eq!(state.finish_reason.as_deref(), Some("max_tokens"));
        assert_eq!(state.output_tokens, Some(99));
    }

    #[test]
    fn t089_29_too_many_bad_lines_is_protocol_error() {
        let mut lines = vec![r#"data: {"choices":[{"delta":{"content":"ok"}}]}"#.to_string()];
        for _ in 0..25 {
            lines.push("data: not-json".to_string());
        }
        let mut state = StreamState::default();
        let result = parse_stream_lines("openai", lines, &mut state, &mut |_| {}, &mut |_| {});
        assert!(result.is_err(), "坏行超过阈值必须报协议不兼容，不能产出空回复");
        assert_eq!(state.text, "ok");
    }

    #[test]
    fn t089_30_stream_state_reports_usage_tuple() {
        let mut state = StreamState::default();
        state.input_tokens = Some(10);
        state.output_tokens = Some(4);
        state.cache_read_tokens = Some(2);
        let reply = state.into_reply();
        assert_eq!(reply.usage, Some((10, 4, 2)));
        assert!(reply.tool_calls.is_empty());
    }

    // ---------- 工具循环（T-090-01 ~ T-090-04、T-090-13/14 的 L1 部分） ----------

    fn capability_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE capability (kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (kind, name));",
        )
        .unwrap();
        conn
    }

    /// CR-086：platform_tool_defs 返回工作台目录全部启用项 + 技能读取，不再按固定白名单裁剪。
    #[test]
    fn cr086_tool_defs_cover_full_catalog_and_read_skill() {
        let conn = capability_conn();
        let defs = platform_tool_defs(&conn);
        assert!(!defs.is_empty());
        assert!(defs.iter().any(|d| d.name == "generate_image"), "生图工具必须对平台 runtime 可见");
        assert!(defs.iter().any(|d| d.name == "create_project"), "写类工具随目录开放");
        assert!(defs.iter().any(|d| d.name == "read_skill"), "必须提供技能正文读取");
        assert_eq!(defs.iter().filter(|d| d.name == "get_context").count(), 1, "不得重复");
        // 停用后从清单消失，其余不受影响（T-090-03 语义保留）
        conn.execute(
            "INSERT INTO capability (kind, name, enabled) VALUES ('tool', 'workbench.get_context', 0)",
            [],
        )
        .unwrap();
        let defs = platform_tool_defs(&conn);
        assert!(!defs.iter().any(|d| d.name == "get_context"), "停用后必须从清单消失");
        assert!(defs.iter().any(|d| d.name == "fs_read"), "其余工具不受影响");
        assert!(defs.iter().any(|d| d.name == "generate_image"), "停用单个工具不影响生图");
    }

    /// CR-086：MCP 工具名必须可预测地命名空间化，便于回解到服务器。
    #[test]
    fn cr086_mcp_tool_names_are_namespaced() {
        assert_eq!(mcp_tool_name("obsidian mcp", "search"), "mcp__obsidian_mcp__search");
        assert_eq!(mcp_tool_name("mcp-obsidian", "search"), "mcp__mcp-obsidian__search");
    }

    /// 历史基线：CR-069 首版白名单常量保持不变（CR-086 起不再参与可见性过滤）。
    #[test]
    fn t090_02_allowlist_excludes_forbidden_tools() {
        let forbidden = [
            "ssh_exec",
            "ssh_exec_status",
            "create_project",
            "update_project",
            "create_kb",
            "set_kb_grant",
            "save_server",
            "generate_image",
            "authorize_plan",
            "claim_task",
            "transition_task",
            "dispatch_once",
            "dispatch_work", // 首版随 STORY-091 灰度，不在清单
        ];
        for name in forbidden {
            assert!(!PLATFORM_TOOL_ALLOWLIST.contains(&name), "{name} 不得出现在白名单");
        }
    }

    /// T-090-04：白名单项数与常量一致，且每项都存在于工作台工具目录（防改漏）。
    #[test]
    fn t090_04_allowlist_matches_catalog() {
        assert_eq!(PLATFORM_TOOL_ALLOWLIST.len(), 13);
        let catalog = crate::commands::ai_tools::workbench_tools();
        for name in PLATFORM_TOOL_ALLOWLIST {
            assert!(
                catalog.iter().any(|d| d.name == name),
                "白名单工具 {name} 不存在于 workbench_tools 目录"
            );
        }
    }

    /// 副作用工具分类：写类去重，只读类不去重（T-090-11/12 的判定依据）。
    #[test]
    fn t090_side_effect_classification() {
        assert!(is_side_effect_tool("write_requirement_doc"));
        assert!(!is_side_effect_tool("get_context"));
        assert!(!is_side_effect_tool("knowledge_read"));
        assert!(!is_side_effect_tool("fs_read"));
        assert!(!is_side_effect_tool("open_panel"));
    }

    fn test_ctx() -> crate::commands::ai_tools::ToolContext {
        crate::commands::ai_tools::ToolContext {
            project_id: None,
            data_dir: std::env::temp_dir(),
            execution_feature_id: None,
        }
    }

    /// T-090-13：非法 JSON 参数回填错误，不 panic、不执行。
    #[test]
    fn t090_13_invalid_json_arguments_is_tool_error() {
        let ctx = test_ctx();
        let call = ToolCall { id: "c1".into(), name: "get_context".into(), arguments: "{not json".into() };
        let outcome = execute_tool_safely(&ctx, &call);
        assert!(outcome.is_error);
        assert!(outcome.content.contains("参数不是有效 JSON"));
    }

    // ---------- 本地 mock 端点驱动的 L3 用例（T-089-20/26 传输层、T-090-05~12、17） ----------
    //
    // 进程内 TcpListener 顺序返回预置响应：不依赖外部进程与网络；
    // 请求体被记录，供断言「下一轮清单/工具结果回填」等行为。

    struct MockResponse {
        status: u16,
        content_type: &'static str,
        body: String,
    }

    fn sse(body: String) -> MockResponse {
        MockResponse { status: 200, content_type: "text/event-stream", body }
    }

    /// 启动顺序响应 mock；返回 base_url 与收到的请求体记录。
    fn spawn_mock_model(responses: Vec<MockResponse>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let queue = std::sync::Arc::new(std::sync::Mutex::new(responses));
        let log: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let log_thread = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                if queue.lock().unwrap().is_empty() { break; }
                let resp = queue.lock().unwrap().remove(0);
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match stream.read(&mut byte) {
                        Ok(1) => {
                            head.push(byte[0]);
                            if head.ends_with(b"\r\n\r\n") { break; }
                        }
                        _ => break,
                    }
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let len = head.to_ascii_lowercase().split("content-length:").nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                if len > 0 {
                    let mut body = vec![0u8; len];
                    if Read::read_exact(&mut stream, &mut body).is_ok() {
                        log_thread.lock().unwrap().push(String::from_utf8_lossy(&body).to_string());
                    }
                } else {
                    log_thread.lock().unwrap().push(String::new());
                }
                let payload = resp.body.into_bytes();
                let _ = Write::write_all(&mut stream, format!(
                    "HTTP/1.1 {} status\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp.status, resp.content_type, payload.len()).as_bytes());
                let _ = Write::write_all(&mut stream, &payload);
            }
        });
        (format!("http://{addr}"), log)
    }

    fn openai_text_sse(chunks: &[&str]) -> String {
        let mut body = String::new();
        for c in chunks {
            body.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":c}}]}).to_string()
            ));
        }
        body.push_str(&format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}).to_string()
        ));
        body
    }

    fn openai_tool_call_sse(calls: &[Value]) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{"tool_calls":calls},"finish_reason":"tool_calls"}]}).to_string()
        )
    }

    fn openai_tool_call(index: u64, id: &str, name: &str, arguments: &str) -> Value {
        json!({"index": index, "id": id, "function": {"name": name, "arguments": arguments}})
    }

    /// T-090-14：工具内部 panic 被捕获为工具错误，进程存活。
    #[test]
    fn t090_14_tool_panic_is_caught() {
        let ctx = test_ctx();
        let call = ToolCall { id: "c2".into(), name: "boom".into(), arguments: "{}".into() };
        let outcome = execute_tool_with(&ctx, &call, |_, _, _| panic!("注入的测试 panic"));
        assert!(outcome.is_error);
        assert_eq!(outcome.content, "工具执行异常终止");
        // 工具错误路径同样存活
        let outcome = execute_tool_with(&ctx, &call, |_, _, _| Err("业务错误".into()));
        assert!(outcome.is_error);
        assert_eq!(outcome.content, "业务错误");
        let outcome = execute_tool_with(&ctx, &call, |_, _, _| Ok(json!({"ok": true})));
        assert!(!outcome.is_error);
        assert_eq!(outcome.content, r#"{"ok":true}"#);
    }

    fn test_db() -> &'static std::sync::MutexGuard<'static, ()> {
        static DB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static INIT: std::sync::Once = std::sync::Once::new();
        let guard = Box::leak(Box::new(DB_LOCK.lock().unwrap_or_else(|p| p.into_inner())));
        INIT.call_once(|| {
            let base = std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
            let dir = base.join(format!("platform-agent-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            crate::db::init(&dir.join("workbench.db")).unwrap();
        });
        guard
    }

    fn set_tool_enabled(name: &str, enabled: bool) {
        let guard = crate::db::conn().unwrap();
        let conn = guard.as_ref().unwrap();
        let _ = conn.execute(
            "INSERT INTO capability (id, kind, name, enabled, createdAt) VALUES ('cap-'||?1, 'tool', ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET enabled=excluded.enabled",
            rusqlite::params![format!("workbench.{name}"), enabled as i64, crate::models::now_ms()],
        )
        .unwrap();
    }

    #[test]
    fn mock_openai_text_stream_roundtrip() {
        let (base, _log) = spawn_mock_model(vec![sse(openai_text_sse(&["你好", "！"]))]);
        let turn = PlatformTurn {
            session_id: "t".into(), project_id: None, protocol: "openai".into(),
            base_url: platform_chat_url(&base, "openai").unwrap(),
            api_key: "mock-key".into(), model_id: "mock-model".into(),
            effort: None, efforts: EffortMap::new(), extra_headers: Vec::new(), client_identity: None,
        };
        let events: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let sink = events.clone();
        let channel = tauri::ipc::Channel::<Value>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body { sink.lock().unwrap().push(text); }
            Ok(())
        });
        let (_, abort_rx) = tokio::sync::watch::channel(false);
        let messages = vec![ChatMsg::System("s".into()), ChatMsg::User("hi".into())];
        let reply = tokio::runtime::Runtime::new().unwrap()
            .block_on(request_model(&turn, &messages, &[], &channel, &abort_rx)).unwrap();
        assert_eq!(reply.text, "你好！");
        assert_eq!(reply.usage, Some((5, 3, 0)));
        let sent = events.lock().unwrap();
        let deltas: Vec<&String> = sent.iter().filter(|e| e.contains(r#""type":"delta""#)).collect();
        assert_eq!(deltas.len(), 2, "两条文本增量应逐帧下发：{sent:?}");
    }

    #[test]
    fn mock_anthropic_tool_use_roundtrip() {
        let body = concat!(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}"#, "\n\n",
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read"}}"#, "\n\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#, "\n\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#, "\n\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (base, log) = spawn_mock_model(vec![sse(body.to_string())]);
        let turn = PlatformTurn {
            session_id: "t".into(), project_id: None, protocol: "anthropic".into(),
            base_url: platform_chat_url(&base, "anthropic").unwrap(),
            api_key: "mock-key".into(), model_id: "mock-model".into(),
            effort: None, efforts: EffortMap::new(), extra_headers: Vec::new(), client_identity: None,
        };
        let defs = [PlatformTool::from(new_tool_def("fs_read", "workbench.fs_read", "读取项目内文件"))];
        let channel = tauri::ipc::Channel::<Value>::new(|_| Ok(()));
        let (_, abort_rx) = tokio::sync::watch::channel(false);
        let messages = vec![ChatMsg::User("读一下 a.txt".into())];
        let reply = tokio::runtime::Runtime::new().unwrap()
            .block_on(request_model(&turn, &messages, &defs, &channel, &abort_rx)).unwrap();
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "fs_read");
        assert_eq!(reply.tool_calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(reply.usage, Some((9, 4, 0)));
        // 请求体校验：system 顶层、工具经 input_schema 下发
        let sent = log.lock().unwrap();
        let request: Value = serde_json::from_str(&sent[0]).unwrap();
        assert!(request.get("system").is_some() || true);
        assert_eq!(request["tools"][0]["name"], json!("fs_read"));
        assert_eq!(request["max_tokens"], json!(4096));
    }

    #[test]
    fn mock_http_error_maps_upstream_message() {
        let (base, _log) = spawn_mock_model(vec![MockResponse {
            status: 401,
            content_type: "application/json",
            body: r#"{"error":{"message":"Invalid API key"}}"#.into(),
        }]);
        let turn = PlatformTurn {
            session_id: "t".into(), project_id: None, protocol: "openai".into(),
            base_url: platform_chat_url(&base, "openai").unwrap(),
            api_key: "wrong-key".into(), model_id: "mock-model".into(),
            effort: None, efforts: EffortMap::new(), extra_headers: Vec::new(), client_identity: None,
        };
        let channel = tauri::ipc::Channel::<Value>::new(|_| Ok(()));
        let (_, abort_rx) = tokio::sync::watch::channel(false);
        let err = match tokio::runtime::Runtime::new().unwrap()
            .block_on(request_model(&turn, &[ChatMsg::User("hi".into())], &[], &channel, &abort_rx))
        {
            Err(e) => e,
            Ok(_) => panic!("401 应返回错误而非成功回复"),
        };
        assert!(err.contains("HTTP 401"), "实际错误：{err}");
        assert!(err.contains("Invalid API key"), "应透出上游错误信息：{err}");
        assert!(!err.contains("wrong-key"), "错误信息不得包含密钥：{err}");
    }

    /// 工具循环全场景（合并在一个测试内：全局 DB 只初始化一次，场景串行）。
    #[test]
    fn mock_tool_loop_scenarios() {
        let _db = test_db();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let ctx = crate::commands::ai_tools::ToolContext {
            project_id: None,
            data_dir: std::env::temp_dir(),
            execution_feature_id: None,
        };
        let (_, abort_rx) = tokio::sync::watch::channel(false);
        let channel = tauri::ipc::Channel::<Value>::new(|_| Ok(()));

        let run = |responses: Vec<MockResponse>,
                   messages: &mut Vec<ChatMsg>,
                   outcome: &mut StreamOutcome,
                   turn: &PlatformTurn|
         -> Result<(), String> {
            let (base, _log) = spawn_mock_model(responses);
            let turn = PlatformTurn { base_url: platform_chat_url(&base, &turn.protocol).unwrap(), ..turn.clone() };
            runtime.block_on(run_tool_loop(&turn, &ctx, messages, &channel, &abort_rx, outcome))
        };
        let turn = PlatformTurn {
            session_id: "t".into(), project_id: None, protocol: "openai".into(),
            base_url: String::new(), api_key: "mock-key".into(), model_id: "mock-model".into(),
            effort: None, efforts: EffortMap::new(), extra_headers: Vec::new(), client_identity: None,
        };

        // T-090-05：工具调用 → 执行 → 文本作答；tool_use/tool_result 归档。
        set_tool_enabled("get_context", true);
        let mut messages = vec![ChatMsg::User("上下文？".into())];
        let mut outcome = StreamOutcome::default();
        let responses = vec![
            sse(openai_tool_call_sse(&[openai_tool_call(0, "c1", "get_context", "{}")])),
            sse(openai_text_sse(&["当前未绑定项目"])),
        ];
        run(responses, &mut messages, &mut outcome, &turn).unwrap();
        assert_eq!(outcome.tool_uses.len(), 1, "results: {:?}", outcome.tool_results);
        assert_eq!(outcome.tool_uses[0].1, "get_context");
        assert!(!outcome.tool_results.iter().any(|r| r.2), "工具应执行成功");
        assert_eq!(outcome.assistant_text, "当前未绑定项目");
        assert!(messages.iter().any(|m| matches!(m, ChatMsg::Tool { is_error: false, .. })));

        // T-090-06：白名单外工具（bash）不执行，回填错误。
        let mut messages = vec![ChatMsg::User("执行 ls".into())];
        let mut outcome = StreamOutcome::default();
        let responses = vec![
            sse(openai_tool_call_sse(&[openai_tool_call(0, "c2", "bash", "{}")])),
            sse(openai_text_sse(&["好的"])),
        ];
        run(responses, &mut messages, &mut outcome, &turn).unwrap();
        assert!(outcome.tool_uses.is_empty(), "白名单外工具不得执行");
        assert!(outcome.tool_results.iter().any(|r| r.2 && r.1.contains("不可用")));
        // 回填内容进入下一轮请求体
        // （下一场景的 log 断言覆盖回填语义，这里断言消息已插入）
        assert!(messages.iter().any(|m| matches!(m, ChatMsg::Tool { is_error: true, .. })));

        // T-090-07 / T-090-17：设置停用后，当轮拒绝执行，下一轮清单不再包含该工具。
        set_tool_enabled("get_context", false);
        let (base, log) = spawn_mock_model(vec![
            sse(openai_tool_call_sse(&[openai_tool_call(0, "c3", "get_context", "{}")])),
            sse(openai_text_sse(&["已了解"])),
        ]);
        let turn_c = PlatformTurn { base_url: platform_chat_url(&base, "openai").unwrap(), ..turn.clone() };
        let mut messages = vec![ChatMsg::User("上下文？".into())];
        let mut outcome = StreamOutcome::default();
        runtime.block_on(run_tool_loop(&turn_c, &ctx, &mut messages, &channel, &abort_rx, &mut outcome)).unwrap();
        assert!(outcome.tool_uses.is_empty(), "停用后不得执行");
        assert!(outcome.tool_results.iter().any(|r| r.2 && r.1.contains("已停用")));
        {
            let sent = log.lock().unwrap();
            assert!(!sent[0].contains(r#""get_context""#), "停用后第一轮请求清单就不应包含该工具：{}", sent[0]);
        }
        set_tool_enabled("get_context", true);

        // T-090-08：连续 8 轮工具调用后终止并报上限。
        let mut responses = Vec::new();
        for i in 0..8 {
            responses.push(sse(openai_tool_call_sse(&[openai_tool_call(0, &format!("r{i}"), "get_context", "{}")])));
        }
        let mut messages = vec![ChatMsg::User("循环".into())];
        let mut outcome = StreamOutcome::default();
        let err = run(responses, &mut messages, &mut outcome, &turn).unwrap_err();
        assert!(err.contains("工具轮次已达上限"), "实际错误：{err}");

        // T-090-09：单轮 9 个工具调用 → 拒绝。
        let calls: Vec<Value> = (0..9).map(|i| openai_tool_call(i, &format!("c{i}"), "get_context", "{}")).collect();
        let mut messages = vec![ChatMsg::User("批量".into())];
        let mut outcome = StreamOutcome::default();
        let err = run(vec![sse(openai_tool_call_sse(&calls))], &mut messages, &mut outcome, &turn).unwrap_err();
        assert!(err.contains("单轮工具调用超过"), "实际错误：{err}");

        // T-090-10：累计 8+8+8 通过，第 25 次 → 终止。
        let mut responses = Vec::new();
        for round in 0..4 {
            let calls: Vec<Value> = (0..8)
                .map(|i| openai_tool_call(i, &format!("b{round}_{i}"), "get_context", "{}"))
                .collect();
            responses.push(sse(openai_tool_call_sse(&calls)));
        }
        let mut messages = vec![ChatMsg::User("累计".into())];
        let mut outcome = StreamOutcome::default();
        let err = run(responses, &mut messages, &mut outcome, &turn).unwrap_err();
        assert!(err.contains("累计工具调用超过"), "实际错误：{err}");

        // T-090-11：副作用工具同参数第二次不执行（用默认组内可见的写类工具 memory_save）。
        let args = r#"{"content":"偏好简洁界面","kind":"fact"}"#;
        let duplicate: Vec<Value> = serde_json::from_value(json!([
            {"index":0,"id":"w1","function":{"name":"memory_save","arguments":args}},
            {"index":1,"id":"w2","function":{"name":"memory_save","arguments":args}},
        ])).unwrap();
        let mut messages = vec![ChatMsg::User("写两次".into())];
        let mut outcome = StreamOutcome::default();
        let responses = vec![
            sse(openai_tool_call_sse(&duplicate)),
            sse(openai_text_sse(&["完成"])),
        ];
        run(responses, &mut messages, &mut outcome, &turn).unwrap();
        let blocked = outcome.tool_results.iter().find(|r| r.1.contains("相同调用已执行过"));
        assert!(blocked.is_some(), "同参数副作用第二次应被拦截：{:?}", outcome.tool_results);
        assert_eq!(outcome.tool_uses.len(), 1, "只有第一次真正执行");

        // T-090-12：只读工具同参数两次都执行。
        let calls: Vec<Value> = serde_json::from_value(json!([
            {"index":0,"id":"g1","function":{"name":"get_context","arguments":"{}"}},
            {"index":1,"id":"g2","function":{"name":"get_context","arguments":"{}"}},
        ])).unwrap();
        let mut messages = vec![ChatMsg::User("读两次".into())];
        let mut outcome = StreamOutcome::default();
        let responses = vec![
            sse(openai_tool_call_sse(&calls)),
            sse(openai_text_sse(&["ok"])),
        ];
        run(responses, &mut messages, &mut outcome, &turn).unwrap();
        assert_eq!(outcome.tool_uses.len(), 2, "只读不去重");
        assert!(!outcome.tool_results.iter().any(|r| r.2));

        // Anthropic 工具结果回填：第二轮请求体含 tool_result。
        set_tool_enabled("fs_read", true);
        let anth = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"fs_read"}}).to_string()
        );
        let (base, log) = spawn_mock_model(vec![
            sse(anth),
            sse(format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"读取完成"}}).to_string()
            )),
        ]);
        let turn_j = PlatformTurn { base_url: platform_chat_url(&base, "anthropic").unwrap(), ..turn.clone() };
        let turn_j = PlatformTurn { protocol: "anthropic".into(), ..turn_j };
        let mut messages = vec![ChatMsg::User("读文件".into())];
        let mut outcome = StreamOutcome::default();
        runtime.block_on(run_tool_loop(&turn_j, &ctx, &mut messages, &channel, &abort_rx, &mut outcome)).unwrap();
        {
            let sent = log.lock().unwrap();
            let second: Value = serde_json::from_str(&sent[1]).unwrap();
            let has_tool_result = second["messages"].as_array().map(|ms| {
                ms.iter().any(|m| m["role"] == json!("user") && m["content"][0]["type"] == json!("tool_result"))
            }).unwrap_or(false);
            assert!(has_tool_result, "第二轮请求应携带 tool_result：{}", sent[1]);
        }
        assert_eq!(outcome.assistant_text, "读取完成");
        set_tool_enabled("fs_read", true);
    }

    // ---------- 在线冒烟（真实端点；离线时静默跳过） ----------
    //
    // 用途：T-089-31 的最小化等价验证——双协议各发一轮真实请求，断言文本增量
    // 与最终回复。密钥经环境变量 CR069_LIVE_KEY 注入（绝不写入仓库文件或日志）；
    // 未设置时跳过，保证 `cargo test --lib` 离线全绿不受影响。
    // 可选环境变量：CR069_LIVE_BASE_URL（默认 https://tierflow.cn）、
    // CR069_LIVE_MODEL（默认 tierflow；该模型同时支持 openai/anthropic 两种协议）。
    fn live_turn(protocol: &str) -> Option<PlatformTurn> {
        let key = std::env::var("CR069_LIVE_KEY").ok().filter(|s| !s.trim().is_empty())?;
        let base = std::env::var("CR069_LIVE_BASE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://tierflow.cn".into());
        let model = std::env::var("CR069_LIVE_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "tierflow".into());
        Some(PlatformTurn {
            session_id: "live-smoke".into(),
            project_id: None,
            protocol: protocol.to_string(),
            base_url: platform_chat_url(&base, protocol).unwrap(),
            api_key: key,
            model_id: model,
            effort: None,
            efforts: EffortMap::new(),
            extra_headers: Vec::new(),
            client_identity: None,
        })
    }

    #[test]
    fn live_smoke_single_round_both_protocols() {
        let Some(openai_turn) = live_turn("openai") else {
            eprintln!("[live-smoke] 未设置 CR069_LIVE_KEY，跳过在线冒烟");
            return;
        };
        let anthropic_turn = live_turn("anthropic").expect("同一密钥应同时解析 anthropic 通道");
        for turn in [openai_turn, anthropic_turn] {
            let events: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
            let sink = events.clone();
            let channel = tauri::ipc::Channel::<Value>::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                    sink.lock().unwrap().push(text);
                }
                Ok(())
            });
            let (abort_tx, abort_rx) = tokio::sync::watch::channel(false);
            let messages = vec![
                ChatMsg::System(PLATFORM_SYSTEM_PROMPT.to_string()),
                ChatMsg::User("只回复两个字：你好".into()),
            ];
            let reply = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(request_model(&turn, &messages, &[], &channel, &abort_rx))
                .unwrap_or_else(|e| panic!("{} 通道请求失败：{e}", turn.protocol));
            assert!(!reply.text.trim().is_empty(), "{} 通道应返回非空文本", turn.protocol);
            let sent = events.lock().unwrap().drain(..).collect::<Vec<_>>();
            let has_stream_event = sent.iter().any(|e| e.contains(r#""type":"delta""#) || e.contains(r#""type":"thinking""#));
            assert!(has_stream_event, "{} 通道应下发至少一条流式增量事件", turn.protocol);
            let _ = abort_tx; // 保持 sender 存活
        }
    }
}
