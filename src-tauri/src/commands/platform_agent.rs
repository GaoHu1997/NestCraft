//! CR-069：平台主代理运行时。
//!
//! 职责：用平台已配置的供应商/模型直接与模型服务对话，并在允许的工具集内循环。
//! 边界：
//! - 不管理供应商、密钥、端点（读取既有表，见 providers.rs）；
//! - 不接管 CLI 路径（chat.rs 的 chat_send 保持不变）；
//! - 不提供 shell / 文件写 / git 写 / 凭据读取能力（工具白名单硬编码）；
//! - 不修改任务状态（派发只创建记录，见 execution.rs）。

use crate::models::EffortMap;
use serde_json::{json, Value};

/// 平台会话的默认输出上限（两协议一致；Anthropic 的 max_tokens 必填）。
const MAX_OUTPUT_TOKENS: u64 = 4096;
/// 流式读取硬上限（与 model_probe.rs 的 MAX_STREAM_BYTES 一致），防超大响应。
const MAX_STREAM_BYTES: u64 = 2 * 1024 * 1024;
/// 解析失败的 SSE 行数阈值；超过判定协议不兼容并报错，不静默产出空回复。
const MAX_BAD_SSE_LINES: usize = 20;

/// 平台会话的一轮请求上下文。
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
}

/// 模型返回的规范化结果。
#[derive(Default)]
pub(crate) struct ModelReply {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    /// (input, output, cache_read)
    pub usage: Option<(i64, i64, i64)>,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolCall {
    pub id: String,
    pub name: String,
    /// 原始 JSON 字符串
    pub arguments: String,
}

/// 对话消息（含工具角色）。
#[derive(Clone)]
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
    tools: &[crate::commands::ai_tools::ToolDef],
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
                                            "function": {"name": c.name, "arguments": c.arguments}}))
                            .collect();
                        let content = if text.is_empty() { Value::Null } else { json!(text) };
                        msgs.push(json!({"role": "assistant", "content": content, "tool_calls": calls}));
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
        let a = build_platform_body("anthropic", "m", None, &empty_efforts(), &messages, &[tool.clone()], false).unwrap();
        assert_eq!(a["tools"][0]["name"], json!("get_context"));
        // Anthropic：system 在顶层，messages[0] 是 assistant 的 tool_use，[1] 是工具结果
        assert_eq!(a["messages"][0]["content"][0]["type"], json!("tool_use"));
        assert_eq!(a["messages"][1]["content"][0]["type"], json!("tool_result"));
        assert_eq!(a["messages"][1]["content"][0]["tool_use_id"], json!("call_1"));

        let o = build_platform_body("openai", "gpt-x", None, &empty_efforts(), &messages, &[tool], false).unwrap();
        assert_eq!(o["tools"][0]["type"], json!("function"));
        assert_eq!(o["messages"][1]["tool_calls"][0]["function"]["name"], json!("get_context"));
        assert_eq!(o["messages"][1]["content"], Value::Null);
        assert_eq!(o["messages"][2]["role"], json!("tool"));
        assert_eq!(o["messages"][2]["tool_call_id"], json!("call_1"));
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
}
