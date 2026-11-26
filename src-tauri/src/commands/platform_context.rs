//! CR-071：平台会话的完整历史、预算与派生摘要。
//! 原 message 是事实来源；此模块只改变发送投影，不提升历史授权、不读取凭据。

use super::platform_agent::{ChatMsg, ToolCall};
use crate::models::SessionMeta;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const RECENT_TURNS: usize = 4;
pub(crate) const MAX_SUMMARY_BYTES: usize = 4096;
pub(crate) const MAX_PAGE_BYTES: usize = 4096;
pub(crate) const MAX_SUMMARY_REQUESTS: usize = 4;
pub(crate) const CONTEXT_TOOLS: [&str; 4] = ["context_status", "search_context", "read_context", "compress_context"];

pub(crate) fn hash(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_context_state (
            sessionId TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), updatedAt INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_context_block (
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            sourceIdsJson TEXT NOT NULL, sourceHash TEXT NOT NULL, summaryJson TEXT NOT NULL,
            level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3), parentIdsJson TEXT NOT NULL,
            scopeHash TEXT NOT NULL, modelId TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','superseded')), createdAt INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_context_block_session
            ON session_context_block(sessionId,status,createdAt,id);
         CREATE TABLE IF NOT EXISTS session_context_turn (
            userMessageId TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
            sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            transcriptJson TEXT NOT NULL, scopeHash TEXT NOT NULL, sourceHash TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL
         );",
    ).map_err(|e| e.to_string())?;
    let has_hash:i64=conn.query_row("SELECT COUNT(*) FROM pragma_table_info('session_context_turn') WHERE name='sourceHash'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if has_hash==0 {conn.execute_batch("ALTER TABLE session_context_turn ADD COLUMN sourceHash TEXT NOT NULL DEFAULT ''; ").map_err(|e|e.to_string())?;}
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct ContextBudget {
    pub window: usize,
    pub max_output: Option<usize>,
    pub unknown: bool,
}

impl ContextBudget {
    pub fn from_model(window: Option<i64>, output: Option<i64>) -> Self {
        Self {
            window: window.filter(|n| *n > 0).map(|n| n as usize).unwrap_or(32768),
            max_output: output.filter(|n| *n > 0).map(|n| n as usize),
            unknown: window.filter(|n| *n > 0).is_none(),
        }
    }

    pub fn load(conn: &Connection, provider: &str, model: &str) -> Result<Self, String> {
        let (window, output) = conn.query_row(
            "SELECT contextWindow,maxTokens FROM model WHERE providerId=?1 AND modelId=?2",
            params![provider, model],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
        ).map_err(|_| "模型上下文配置不存在".to_string())?;
        Ok(Self::from_model(window, output))
    }

    pub fn output(body: &Value) -> usize {
        body.get("max_completion_tokens").or_else(|| body.get("max_tokens"))
            .and_then(Value::as_u64).unwrap_or(4096) as usize
    }

    pub fn estimated_input(body: &Value) -> usize { body.to_string().len().saturating_add(256) }

    pub fn check(&self, body: &Value) -> Result<(), String> {
        let output = Self::output(body);
        if self.max_output.is_some_and(|max| output > max) {
            return Err("CONTEXT_OUTPUT_LIMIT：所选档位超过模型最大输出".into());
        }
        if Self::estimated_input(body).saturating_add(output) > self.window {
            return Err("CONTEXT_BUDGET_EXCEEDED：请减少本次引用或新建会话".into());
        }
        Ok(())
    }

    pub fn pressure(&self, body: &Value, percent: usize) -> bool {
        let input = Self::estimated_input(body);
        let available = self.window.saturating_sub(Self::output(body));
        input.saturating_mul(100) > available.saturating_mul(percent)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ScopeStamp {
    pub session_id: String,
    pub project_id: Option<String>,
    pub value: String,
}

pub(crate) fn scope_stamp(conn: &Connection, session: &SessionMeta) -> Result<ScopeStamp, String> {
    let (project, feature, source, role): (Option<String>, Option<String>, Option<String>, String) = conn.query_row(
        "SELECT projectId,featureId,featureSourceHash,sessionRole FROM session WHERE id=?1",
        [&session.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).map_err(|_| "会话不存在".to_string())?;
    if project != session.project_id || feature != session.feature_id || source != session.feature_source_hash || role != session.session_role {
        return Err("CONTEXT_SCOPE_CHANGED：会话身份已变化".into());
    }
    if let Some(id) = feature.as_deref() {
        let current = super::chat::resolve_execution_feature(conn, project.as_deref(), Some(id))?;
        if current.feature_source_hash != source { return Err("CONTEXT_SOURCE_CHANGED：特性源已变化".into()); }
    }
    let root: Option<String> = match project.as_deref() {
        Some(id) => Some(conn.query_row("SELECT rootUri FROM project WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "会话所属项目不存在".to_string())?),
        None => None,
    };
    let mut grants = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT l.id,l.sourceRef,l.revision,l.enabled,COALESCE(g.readAllowed,0),COALESCE(g.revision,0)
         FROM knowledge_library l LEFT JOIN project_library_grant g ON g.libraryId=l.id AND g.projectId=?1 ORDER BY l.id",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([project.as_deref().unwrap_or("")], |r| Ok((
        r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, i64>(2)?,
        r.get::<_, i64>(3)?,r.get::<_, i64>(4)?,r.get::<_, i64>(5)?,
    ))).map_err(|e| e.to_string())?;
    for row in rows { grants.push(row.map_err(|e| e.to_string())?); }
    let mut skills = Vec::new();
    let mut stmt = conn.prepare("SELECT name,enabled,sourceRef FROM capability WHERE kind='skill' ORDER BY name,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?,r.get::<_, Option<String>>(2)?)))
        .map_err(|e| e.to_string())?;
    for row in rows { skills.push(row.map_err(|e| e.to_string())?); }
    let mut all_grants = Vec::new();
    let mut stmt = conn.prepare("SELECT projectId,libraryId,readAllowed,revision FROM project_library_grant ORDER BY projectId,libraryId")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))
        .map_err(|e| e.to_string())?;
    for row in rows { all_grants.push(row.map_err(|e| e.to_string())?); }
    let mut roots = Vec::new();
    let mut stmt = conn.prepare("SELECT id,rootUri FROM project ORDER BY id").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
    for row in rows { roots.push(row.map_err(|e| e.to_string())?); }
    let value = hash(&json!({"session":session.id,"project":project,"feature":feature,"source":source,
        "role":role,"root":root,"roots":roots,"grants":grants,"allGrants":all_grants,"skills":skills}).to_string());
    Ok(ScopeStamp { session_id: session.id.clone(), project_id: project, value })
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SourceMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub meta_json: Option<String>,
    pub refs_json: Option<String>,
}

#[derive(Clone)]
pub(crate) struct HistoryTurn {
    pub user_id: String,
    pub source: Vec<SourceMessage>,
    pub messages: Vec<ChatMsg>,
}

impl HistoryTurn {
    pub fn ids(&self) -> Vec<String> { self.source.iter().map(|m| m.id.clone()).collect() }
}

fn call_from_source(m: &SourceMessage) -> Result<ToolCall, String> {
    let meta: Value = serde_json::from_str(m.meta_json.as_deref().unwrap_or("{}"))
        .map_err(|_| "历史工具元数据损坏".to_string())?;
    let id = meta.get("toolId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("历史工具缺少ID")?;
    let arguments = match meta.get("input") {
        Some(Value::String(s)) => s.clone(), Some(v) => v.to_string(), None => String::new(),
    };
    Ok(ToolCall { id: id.into(), name: m.content.clone(), arguments })
}

pub(crate) fn validate_pairs(messages: &[ChatMsg]) -> Result<(), String> {
    let mut outstanding = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for msg in messages {
        match msg {
            ChatMsg::Assistant { tool_calls, .. } => {
                if !outstanding.is_empty() { return Err("历史工具交换缺少结果".into()); }
                for call in tool_calls {
                    if call.id.is_empty() || !seen.insert(call.id.clone()) { return Err("历史工具ID重复或为空".into()); }
                    outstanding.insert(call.id.clone());
                }
            }
            ChatMsg::Tool { call_id, .. } => {
                if !outstanding.remove(call_id) { return Err("历史包含孤立工具结果".into()); }
            }
            ChatMsg::User(_) | ChatMsg::System(_) if !outstanding.is_empty() => return Err("历史工具交换被消息截断".into()),
            _ => {},
        }
    }
    if !outstanding.is_empty() { return Err("历史工具交换缺少结果".into()); }
    Ok(())
}

fn legacy_messages(source: &[SourceMessage]) -> Result<Vec<ChatMsg>, String> {
    let mut result = Vec::new();
    let mut calls = Vec::new();
    for m in source {
        if m.role == "tool_use" {
            let call = call_from_source(m)?;
            if matches!(call.name.as_str(), "fs_read" | "knowledge_read" | "knowledge_search" | "knowledge_read_many") {
                return Err("CONTEXT_SOURCE_UNKNOWN：旧工具资料缺少来源指纹，请新建会话".into());
            }
            calls.push(call);
        }
    }
    for m in source {
        match m.role.as_str() {
            "user" => {
                if let Some(refs) = &m.refs_json {
                    let refs: Vec<Value> = serde_json::from_str(refs).map_err(|_| "历史引用损坏".to_string())?;
                    if refs.iter().any(|r| matches!(r.get("kind").and_then(Value::as_str), Some("knowledge" | "file" | "skill"))) {
                        return Err("CONTEXT_SOURCE_UNKNOWN：旧引用缺少来源指纹，请新建会话".into());
                    }
                }
                result.push(ChatMsg::User(m.content.clone()));
            }
            "assistant" => result.push(ChatMsg::Assistant { text: m.content.clone(), tool_calls: Vec::new() }),
            _ => {},
        }
    }
    if !calls.is_empty() {
        result.push(ChatMsg::Assistant { text: String::new(), tool_calls: calls });
        // CR-099：被拒调用按 AC-02 不写 tool_use，只留错误结果；回放时跳过无对应 tool_use 的结果，
        // 不让历史中的拒绝提示把整段上下文判为「孤立工具结果」。
        let known: std::collections::BTreeSet<String> = result.iter().flat_map(|m| match m {
            ChatMsg::Assistant { tool_calls, .. } => tool_calls.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            _ => Vec::new(),
        }).collect();
        for m in source.iter().filter(|m| m.role == "tool_result") {
            let meta: Value = serde_json::from_str(m.meta_json.as_deref().unwrap_or("{}")).map_err(|_| "历史工具结果损坏".to_string())?;
            let call_id = meta.get("toolId").and_then(Value::as_str).ok_or("历史工具结果缺少ID")?;
            if !known.contains(call_id) { continue; }
            result.push(ChatMsg::Tool {
                call_id: call_id.into(),
                content: m.content.clone(), is_error: meta.get("isError").and_then(Value::as_bool).unwrap_or(false),
            });
        }
    } else if source.iter().any(|m| m.role == "tool_result") {
        return Err("历史包含孤立工具结果".into());
    }
    validate_pairs(&result)?;
    Ok(result)
}

fn validate_transcript(messages: &[ChatMsg]) -> Result<(),String> {
    if messages.iter().enumerate().any(|(i,m)|matches!(m,ChatMsg::System(_)) || (i>0 && matches!(m,ChatMsg::User(_)))) {
        return Err("回放不得注入system或额外user角色".into());
    }
    validate_pairs(messages)
}

fn transcript_hash(source: &[SourceMessage],messages: &[ChatMsg]) -> Result<String,String> {
    Ok(hash(&serde_json::to_string(&(source,messages)).map_err(|e|e.to_string())?))
}

pub(crate) fn load_history(conn: &Connection, scope: &ScopeStamp) -> Result<Vec<HistoryTurn>, String> {
    load_history_before(conn,scope,None)
}

pub(crate) fn load_history_before(conn: &Connection, scope: &ScopeStamp, exclude_user: Option<&str>) -> Result<Vec<HistoryTurn>, String> {
    let mut stmt = conn.prepare("SELECT id,role,content,metaJson,refsJson FROM message WHERE sessionId=?1 ORDER BY createdAt,rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&scope.session_id], |r| Ok(SourceMessage {
        id:r.get(0)?,role:r.get(1)?,content:r.get(2)?,meta_json:r.get(3)?,refs_json:r.get(4)?,
    })).map_err(|e| e.to_string())?;
    let mut groups: Vec<Vec<SourceMessage>> = Vec::new();
    for row in rows {
        let m = row.map_err(|e| e.to_string())?;
        if m.role == "user" { groups.push(Vec::new()); }
        if let Some(group) = groups.last_mut() { group.push(m); }
    }
    let mut result = Vec::new();
    for source in groups {
        let user_id = source[0].id.clone();
        if exclude_user == Some(user_id.as_str()) { continue; }
        let stored: Option<(String,String,String)> = conn.query_row(
            "SELECT transcriptJson,scopeHash,sourceHash FROM session_context_turn WHERE sessionId=?1 AND userMessageId=?2",
            params![scope.session_id,user_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(|e| e.to_string())?;
        let messages = match stored {
            Some((text, stamp,source_stamp)) => {
                if stamp != scope.value { return Err("CONTEXT_SOURCE_CHANGED：历史资料授权或来源已变化，请新建会话".into()); }
                let transcript: Vec<ChatMsg> = serde_json::from_str(&text).map_err(|_| "平台历史回放损坏".to_string())?;
                validate_transcript(&transcript)?;
                if transcript_hash(&source,&transcript)?!=source_stamp {return Err("CONTEXT_SOURCE_CHANGED：回放与原消息不一致".into());}
                let messages = if matches!(transcript.first(),Some(ChatMsg::User(_))) { transcript }
                    else { let mut messages = vec![ChatMsg::User(source[0].content.clone())]; messages.extend(transcript); messages };
                validate_pairs(&messages)?;
                messages
            }
            None => legacy_messages(&source)?,
        };
        result.push(HistoryTurn { user_id, source, messages });
    }
    Ok(result)
}

pub(crate) fn save_transcript(conn: &Connection, scope: &ScopeStamp, user_id: &str, messages: &[ChatMsg]) -> Result<(), String> {
    validate_transcript(messages)?;
    let belongs: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM message WHERE id=?1 AND sessionId=?2 AND role='user')",
        params![user_id,scope.session_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !belongs { return Err("回放消息不属于当前会话".into()); }
    let mut stmt=conn.prepare("SELECT id,role,content,metaJson,refsJson FROM message WHERE sessionId=?1
        AND rowid>=(SELECT rowid FROM message WHERE id=?2)
        AND rowid<COALESCE((SELECT MIN(rowid) FROM message WHERE sessionId=?1 AND role='user' AND rowid>(SELECT rowid FROM message WHERE id=?2)),9223372036854775807)
        ORDER BY createdAt,rowid").map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![scope.session_id,user_id],|r|Ok(SourceMessage{id:r.get(0)?,role:r.get(1)?,content:r.get(2)?,meta_json:r.get(3)?,refs_json:r.get(4)?})).map_err(|e|e.to_string())?;
    let source=rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let source_hash=transcript_hash(&source,messages)?;
    conn.execute("INSERT INTO session_context_turn(userMessageId,sessionId,transcriptJson,scopeHash,sourceHash,createdAt) VALUES(?1,?2,?3,?4,?5,?6)",
        params![user_id,scope.session_id,serde_json::to_string(messages).map_err(|e| e.to_string())?,scope.value,source_hash,crate::models::now_ms()])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Summary {
    pub goal: String,
    pub constraints: Vec<String>,
    pub decisions: Vec<String>,
    pub progress: Vec<String>,
    pub evidence: Vec<String>,
    pub unresolved: Vec<String>,
}

impl Summary {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > MAX_SUMMARY_BYTES { return Err("摘要过大".into()); }
        let summary: Self = serde_json::from_str(text).map_err(|_| "摘要必须是完整的六字段JSON".to_string())?;
        if summary.goal.trim().is_empty() { return Err("摘要目标为空".into()); }
        if [&summary.constraints,&summary.decisions,&summary.progress,&summary.evidence,&summary.unresolved]
            .iter().any(|a| a.len() > 64 || a.iter().any(|s| s.len() > 2048)) { return Err("摘要字段超限".into()); }
        Ok(summary)
    }
    pub fn text(&self) -> String { serde_json::to_string(self).unwrap_or_default() }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Block {
    pub id: String,
    pub source_ids: Vec<String>,
    pub source_hash: String,
    pub summary: Summary,
    pub level: usize,
    pub parent_ids: Vec<String>,
    pub scope_hash: String,
    pub model_id: String,
}

pub(crate) fn source_hash(history: &[HistoryTurn], ids: &[String]) -> Result<String, String> {
    let wanted: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    if wanted.len() != ids.len() || ids.is_empty() { return Err("摘要范围为空或ID重复".into()); }
    let mut digest=Sha256::new();
    let mut found=BTreeSet::new();
    digest.update(b"CR070-source-v1");
    for t in history {
        let mut selected=false;
        for m in &t.source {
            if wanted.contains(m.id.as_str()) {
                let bytes=serde_json::to_vec(m).map_err(|e|e.to_string())?;
                digest.update((bytes.len() as u64).to_le_bytes());digest.update(bytes);
                found.insert(m.id.as_str());selected=true;
            }
        }
        if selected {
            let bytes=serde_json::to_vec(&t.messages).map_err(|e|e.to_string())?;
            digest.update((bytes.len() as u64).to_le_bytes());digest.update(bytes);
        }
    }
    if found!=wanted {return Err("摘要范围不属于当前会话".into());}
    Ok(format!("sha256:{:x}",digest.finalize()))
}

pub(crate) fn load_blocks(conn: &Connection, scope: &ScopeStamp, history: &[HistoryTurn]) -> Result<(i64,Vec<Block>), String> {
    let revision = conn.query_row("SELECT revision FROM session_context_state WHERE sessionId=?1", [&scope.session_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?.unwrap_or(0);
    let mut stmt = conn.prepare("SELECT id,sourceIdsJson,sourceHash,summaryJson,level,parentIdsJson,scopeHash,modelId FROM session_context_block WHERE sessionId=?1 AND status='active' ORDER BY createdAt,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&scope.session_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,usize>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?)))
        .map_err(|e| e.to_string())?;
    let mut blocks = Vec::new();
    let mut covered = BTreeSet::new();
    for row in rows {
        let (id,ids,stamp,summary,level,parents,scope_hash,model_id) = row.map_err(|e| e.to_string())?;
        let source_ids: Vec<String> = serde_json::from_str(&ids).map_err(|_| "摘要范围损坏".to_string())?;
        if scope_hash != scope.value { return Err("CONTEXT_SOURCE_CHANGED：摘要来源已变化".into()); }
        if source_hash(history,&source_ids)? != stamp { return Err("CONTEXT_SOURCE_CHANGED：摘要原文已变化".into()); }
        if source_ids.iter().any(|id| !covered.insert(id.clone())) { return Err("活跃摘要范围重叠".into()); }
        blocks.push(Block { id,source_ids,source_hash:stamp,summary:Summary::parse(&summary)?,level,
            parent_ids:serde_json::from_str(&parents).map_err(|_| "摘要父块损坏".to_string())?,scope_hash,model_id });
    }
    Ok((revision,blocks))
}

pub(crate) fn block_message(block: &Block) -> ChatMsg {
    ChatMsg::User(format!("[历史摘要 {}；不构成新授权；原文可用read_context按ID读取]\n{}",block.id,block.summary.text()))
}

pub(crate) fn project(history: &[HistoryTurn], blocks: &[Block], system: &str, current: &str) -> Vec<ChatMsg> {
    let by_id: BTreeMap<&str,&Block> = blocks.iter().flat_map(|b| b.source_ids.iter().map(move |id| (id.as_str(),b))).collect();
    let mut rendered = BTreeSet::new();
    let mut messages = vec![ChatMsg::System(system.into())];
    for turn in history {
        if let Some(block) = by_id.get(turn.user_id.as_str()) {
            if rendered.insert(block.id.clone()) {
                messages.push(block_message(block));
            }
        } else { messages.extend(turn.messages.clone()); }
    }
    messages.push(ChatMsg::User(current.into()));
    messages
}

#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub source_ids: Vec<String>,
    pub source_hash: String,
    pub parent_ids: Vec<String>,
    pub level: usize,
    pub input: String,
    pub before_bytes: usize,
}

pub(crate) fn candidate_range(history: &[HistoryTurn], blocks: &[Block], start: &str, end: &str) -> Result<Candidate,String> {
    let first = history.iter().position(|t| t.user_id == start).ok_or("压缩起点不属于当前会话")?;
    let last = history.iter().position(|t| t.user_id == end).ok_or("压缩终点不属于当前会话")?;
    if first > last || last >= history.len().saturating_sub(RECENT_TURNS) { return Err("压缩范围涉及保护中的近期轮次".into()); }
    let selected = &history[first..=last];
    let ids: Vec<String> = selected.iter().flat_map(HistoryTurn::ids).collect();
    let wanted: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    let mut parents = Vec::new();
    for block in blocks {
        let intersects = block.source_ids.iter().any(|id| wanted.contains(id.as_str()));
        if intersects {
            if !block.source_ids.iter().all(|id| wanted.contains(id.as_str())) { return Err("不得切开已有摘要块".into()); }
            parents.push(block);
        }
    }
    let inside: Vec<Block> = parents.iter().map(|b| (*b).clone()).collect();
    let view = project(selected,&inside,"","");
    let view: Vec<&ChatMsg> = view.iter().filter(|m| match m {
        ChatMsg::System(_) => false, ChatMsg::User(s) => !s.is_empty(), _ => true,
    }).collect();
    let before_bytes=serde_json::to_string(&view).map_err(|e| e.to_string())?.len();
    let input=json!({"sourceIds":ids,"messages":view}).to_string();
    let level = parents.iter().map(|b| b.level).max().map(|n| (n+1).min(3)).unwrap_or(1);
    Ok(Candidate { source_hash:source_hash(history,&ids)?,source_ids:ids,
        parent_ids:parents.iter().map(|b| b.id.clone()).collect(),level,before_bytes,input })
}

pub(crate) fn next_candidate(history: &[HistoryTurn], blocks: &[Block]) -> Option<Candidate> {
    let old = history.len().saturating_sub(RECENT_TURNS);
    let covered: BTreeSet<&str> = blocks.iter().flat_map(|b| b.source_ids.iter().map(String::as_str)).collect();
    if let Some(first) = (0..old).find(|i| !covered.contains(history[*i].user_id.as_str())) {
        let mut last = first;
        while last+1 < old && last-first < 3 && !covered.contains(history[last+1].user_id.as_str()) { last += 1; }
        return candidate_range(history,blocks,&history[first].user_id,&history[last].user_id).ok();
    }
    let mut ordered: Vec<&Block> = blocks.iter().filter(|b| history.iter().take(old).any(|t| b.source_ids.contains(&t.user_id))).collect();
    ordered.sort_by_key(|b| history.iter().position(|t| b.source_ids.contains(&t.user_id)).unwrap_or(usize::MAX));
    if ordered.len() < 2 { return None; }
    let first = history.iter().position(|t| ordered[0].source_ids.contains(&t.user_id))?;
    let last = history.iter().rposition(|t| ordered[1].source_ids.contains(&t.user_id))?;
    candidate_range(history,blocks,&history[first].user_id,&history[last].user_id).ok()
}

pub(crate) fn make_block(candidate: &Candidate, summary: Summary, scope: &ScopeStamp, model_id: &str) -> Result<Block,String> {
    if summary.text().len() >= candidate.before_bytes { return Err("CONTEXT_NO_SHRINK：摘要没有实际缩减".into()); }
    let block = Block { id:crate::models::new_id("ctx"),source_ids:candidate.source_ids.clone(),source_hash:candidate.source_hash.clone(),
        summary,level:candidate.level,parent_ids:candidate.parent_ids.clone(),scope_hash:scope.value.clone(),model_id:model_id.into() };
    if serde_json::to_string(&vec![block_message(&block)]).map_err(|e| e.to_string())?.len() >= candidate.before_bytes {
        return Err("CONTEXT_NO_SHRINK：摘要投影没有实际缩减".into());
    }
    Ok(block)
}

pub(crate) fn replace_blocks(blocks: &mut Vec<Block>, new: &Block) {
    blocks.retain(|b| !new.parent_ids.contains(&b.id));
    blocks.push(new.clone());
}

/// 调用方持有事务；与 user insert 一同提交，网络期间不得调用。
pub(crate) fn apply_blocks(conn: &Connection, session: &SessionMeta, expected: &ScopeStamp, revision: i64,
    desired: &[Block], drafts: &[Block]) -> Result<i64,String> {
    apply_blocks_before(conn,session,expected,revision,desired,drafts,None)
}

pub(crate) fn apply_blocks_before(conn: &Connection, session: &SessionMeta, expected: &ScopeStamp, revision: i64,
    desired: &[Block], drafts: &[Block], exclude_user: Option<&str>) -> Result<i64,String> {
    if scope_stamp(conn,session)?.value != expected.value { return Err("CONTEXT_SOURCE_CHANGED：提交前来源已变化".into()); }
    let history = load_history_before(conn,expected,exclude_user)?;
    let (current,existing) = load_blocks(conn,expected,&history)?;
    if current != revision { return Err("CONTEXT_REVISION_CHANGED：摘要状态已变化".into()); }
    if drafts.is_empty() { return Ok(current); }
    let keep: BTreeSet<&str> = desired.iter().map(|b| b.id.as_str()).collect();
    let all_parents: BTreeSet<&str> = drafts.iter().flat_map(|b| b.parent_ids.iter().map(String::as_str)).collect();
    for old in &existing {
        if !keep.contains(old.id.as_str()) && !all_parents.contains(old.id.as_str()) { return Err("不能无替代地移除摘要".into()); }
        if let Some(same) = desired.iter().find(|b| b.id == old.id) {
            if serde_json::to_value(same).unwrap() != serde_json::to_value(old).unwrap() { return Err("不能覆盖既有摘要内容".into()); }
        }
    }
    let mut active_ids = BTreeSet::new();
    for block in desired {
        if block.source_ids.iter().any(|id| !active_ids.insert(id)) { return Err("活跃摘要范围重叠".into()); }
    }
    let mut staged = existing.clone();
    for block in drafts {
        if block.scope_hash != expected.value || source_hash(&history,&block.source_ids)? != block.source_hash { return Err("CONTEXT_SOURCE_CHANGED：原文已变化".into()); }
        if !(1..=3).contains(&block.level) || staged.iter().any(|b| b.id==block.id) { return Err("摘要层级或ID无效".into()); }
        Summary::parse(&block.summary.text())?;
        let first = history.iter().find(|t| block.source_ids.contains(&t.user_id)).ok_or("摘要没有完整轮次")?;
        let last = history.iter().rfind(|t| block.source_ids.contains(&t.user_id)).ok_or("摘要没有完整轮次")?;
        let candidate = candidate_range(&history,&staged,&first.user_id,&last.user_id)?;
        if candidate.source_ids != block.source_ids || candidate.parent_ids != block.parent_ids || candidate.level != block.level { return Err("摘要范围或父块无效".into()); }
        if block.summary.text().len() >= candidate.before_bytes { return Err("CONTEXT_NO_SHRINK".into()); }
        replace_blocks(&mut staged,block);
    }
    let canonical = |items: &[Block]| { let mut rows: Vec<_> = items.iter().map(|b| (b.id.clone(),serde_json::to_value(b).unwrap())).collect(); rows.sort_by(|a,b| a.0.cmp(&b.0)); rows };
    if canonical(&staged) != canonical(desired) { return Err("摘要投影不等于提交计划".into()); }
    let now = crate::models::now_ms();
    conn.execute("INSERT OR IGNORE INTO session_context_state VALUES(?1,0,?2)",params![expected.session_id,now]).map_err(|e| e.to_string())?;
    let changed = conn.execute("UPDATE session_context_state SET revision=revision+1,updatedAt=?3 WHERE sessionId=?1 AND revision=?2",
        params![expected.session_id,revision,now]).map_err(|e| e.to_string())?;
    if changed != 1 { return Err("CONTEXT_REVISION_CHANGED".into()); }
    for old in &existing {
        if !keep.contains(old.id.as_str()) {
            conn.execute("UPDATE session_context_block SET status='superseded' WHERE sessionId=?1 AND id=?2",
                params![expected.session_id,old.id]).map_err(|e| e.to_string())?;
        }
    }
    for block in drafts {
        let status = if keep.contains(block.id.as_str()) { "active" } else { "superseded" };
        conn.execute("INSERT INTO session_context_block(id,sessionId,sourceIdsJson,sourceHash,summaryJson,level,parentIdsJson,scopeHash,modelId,status,createdAt)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![block.id,expected.session_id,
            serde_json::to_string(&block.source_ids).unwrap(),block.source_hash,block.summary.text(),block.level as i64,
            serde_json::to_string(&block.parent_ids).unwrap(),block.scope_hash,block.model_id,status,now]).map_err(|e| e.to_string())?;
    }
    Ok(revision+1)
}

pub(crate) fn byte_page(text: &str, offset: usize, limit: usize) -> Result<Value,String> {
    if offset > text.len() || limit == 0 || limit > MAX_PAGE_BYTES { return Err("原文分页参数超限".into()); }
    let mut start = offset;
    while start > 0 && !text.is_char_boundary(start) { start -= 1; }
    let mut end = start.saturating_add(limit).min(text.len());
    while end > start && !text.is_char_boundary(end) { end -= 1; }
    if end == start && start < text.len() { return Err("分页长度不足以读取一个UTF-8字符".into()); }
    Ok(json!({"content":&text[start..end],"offset":start,"nextOffset":if end<text.len(){Some(end)}else{None},"untrusted":true}))
}

pub(crate) fn result_ref(user_id: &str,call_id: &str)->String {
    format!("ctxr-{}",hash(&json!([user_id,call_id]).to_string()).trim_start_matches("sha256:"))
}

pub(crate) fn read_context(history: &[HistoryTurn], blocks: &[Block], id: &str, offset: usize, limit: usize) -> Result<Value,String> {
    if id.is_empty() || id.len()>128 || id.contains(['/', '\\']) { return Err("原文ID无效".into()); }
    let text = history.iter().flat_map(|t| &t.source).find(|m| m.id == id).map(|m| m.content.clone())
        .or_else(||history.iter().find_map(|t|t.source.iter().find(|m|m.role=="tool_result" &&
            serde_json::from_str::<Value>(m.meta_json.as_deref().unwrap_or("{}")).ok().and_then(|v|v.get("toolId").and_then(Value::as_str).map(|call|result_ref(&t.user_id,call)==id)).unwrap_or(false))
            .map(|m|m.content.clone())))
        .or_else(|| blocks.iter().find(|b| b.id==id).map(|b| history.iter().flat_map(|t| &t.source)
            .filter(|m| b.source_ids.contains(&m.id)).map(|m| format!("[{} {}]\n{}",m.id,m.role,m.content)).collect::<Vec<_>>().join("\n\n")))
        .ok_or("原文ID不属于当前会话")?;
    let mut page = byte_page(&text,offset,limit)?;
    page["id"] = json!(id);
    Ok(page)
}

pub(crate) fn search_context(history: &[HistoryTurn], blocks: &[Block], query: &str) -> Result<Value,String> {
    if query.trim().is_empty() || query.len()>256 { return Err("历史搜索关键词为空或超限".into()); }
    let needle = query.to_lowercase();
    let mut candidates: Vec<(String,String)> = history.iter().flat_map(|t| &t.source).map(|m| (m.id.clone(),m.content.clone())).collect();
    candidates.extend(blocks.iter().map(|b| (b.id.clone(),b.summary.text())));
    let mut hits = Vec::new();
    for (id,text) in candidates {
        if let Some(position)=text.to_lowercase().find(&needle) {
            let excerpt=byte_page(&text,position.saturating_sub(80).min(text.len()),256)?;
            let hit=json!({"id":id,"excerpt":excerpt["content"],"offset":excerpt["offset"]});
            hits.push(hit);
            if json!({"hits":hits}).to_string().len()>MAX_PAGE_BYTES { hits.pop(); break; }
            if hits.len()==10 { break; }
        }
    }
    Ok(json!({"hits":hits,"untrusted":true}))
}

pub(crate) fn tool_defs() -> Vec<super::ai_tools::ToolDef> {
    let definitions = [
        ("context_status","查看当前会话上下文预算与可压缩旧范围",json!({}),vec![]),
        ("search_context","在当前会话原文和有效摘要中搜索",json!({"query":{"type":"string","maxLength":256}}),vec!["query"]),
        ("read_context","分页读取当前会话消息或摘要块对应原文",json!({"id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":4096}}),vec!["id"]),
        ("compress_context","只压缩context_status返回的旧完整轮次，保留出处与未决事项，不生成授权",json!({"startId":{"type":"string"},"endId":{"type":"string"},"summary":{"type":"object"}}),vec!["startId","endId","summary"]),
    ];
    definitions.into_iter().map(|(name,description,properties,required)| super::ai_tools::ToolDef {
        name,registry_id:name,description,schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),risk:"low",
    }).collect()
}

#[cfg(test)]
#[path = "platform_context_tests.rs"]
mod tests;
