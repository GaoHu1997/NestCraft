//! CR-092 / FEAT-026：记忆工具（供 ai_tools 调用）与 UI 命令。
//!
//! 数据访问走 `memory_store`，业务规则走 `memory`。工具侧 scope 由 projectId 派生，
//! 授权沿用知识工具语义（global 归 owner；project:<id> 需项目可见）。预算见 LLD-FEAT-026 §5。

use crate::commands::memory::{self, Extracted};
use crate::commands::memory_store::{self, MemoryItem};
use rusqlite::Connection;
use serde_json::{json, Value};

const LIST_MAX: usize = 20;
const SNIPPET_MAX: usize = 200;
const SAVE_MAX_BYTES: usize = 1024;

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn req_str(args: &Value, key: &str) -> Result<String, String> {
    opt_str(args, key).ok_or_else(|| format!("缺少必填参数：{key}"))
}

fn opt_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|v| v as usize)
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// 工具参数 → scope：projectId 优先（project:<id>），否则显式 scope，再否则 global。
pub fn scope_from_args(args: &Value) -> String {
    match opt_str(args, "projectId") {
        Some(pid) => format!("project:{pid}"),
        None => opt_str(args, "scope").unwrap_or_else(|| "global".into()),
    }
}

fn norm_scope(scope: Option<String>) -> String {
    match scope {
        Some(s) if memory::valid_scope(&s) => s,
        _ => "global".into(),
    }
}

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    f(conn)
}

pub fn item_json(it: &MemoryItem) -> Value {
    json!({
        "id": it.id, "scope": it.scope, "kind": it.kind, "memKey": it.mem_key,
        "content": it.content, "sourceType": it.source_type, "sourceRef": it.source_ref,
        "trust": it.trust, "importance": it.importance, "confidence": it.confidence,
        "status": it.status, "supersededBy": it.superseded_by, "accessCount": it.access_count,
        "lastAccessAt": it.last_access_at, "createdAt": it.created_at, "updatedAt": it.updated_at
    })
}

// ==================== 工具实现（供 ai_tools::run_tool 调用） ====================

pub fn tool_search(args: &Value) -> Result<Value, String> {
    let query = opt_str(args, "query").unwrap_or_default();
    let scope = scope_from_args(args);
    let kind = opt_str(args, "kind");
    let limit = opt_usize(args, "limit").unwrap_or(10).clamp(1, LIST_MAX);
    with_conn(|conn| {
        let items = memory_store::list(conn, Some(&scope), kind.as_deref(), Some("active"), 500)?;
        let needle = query.to_lowercase();
        let mut hits: Vec<Value> = Vec::new();
        for it in items {
            if !needle.is_empty() && !it.content.to_lowercase().contains(&needle) {
                continue;
            }
            let _ = memory_store::touch_access(conn, &it.id);
            hits.push(json!({
                "id": it.id, "kind": it.kind, "content": clip(&it.content, SNIPPET_MAX),
                "trust": it.trust, "importance": it.importance, "sourceType": it.source_type
            }));
            if hits.len() >= limit {
                break;
            }
        }
        Ok(json!({ "scope": scope, "query": query, "hits": hits, "count": hits.len() }))
    })
}

pub fn tool_save(args: &Value) -> Result<Value, String> {
    let content = req_str(args, "content")?;
    let kind = req_str(args, "kind")?;
    if !memory::is_valid_kind(&kind) {
        return Err(format!("kind 非法：{kind}（应为 fact|preference|goal|event|decision|relation）"));
    }
    if content.len() > SAVE_MAX_BYTES {
        return Err(format!("content 超过 {SAVE_MAX_BYTES} 字节上限"));
    }
    let scope = scope_from_args(args);
    if !memory::valid_scope(&scope) {
        return Err(format!("scope 非法：{scope}"));
    }
    let importance = opt_usize(args, "importance").unwrap_or(3).clamp(1, 5) as i64;
    let trust = opt_str(args, "trust").unwrap_or_else(|| "own".into());
    let item = Extracted {
        kind,
        mem_key: opt_str(args, "memKey"),
        content,
        importance,
        trust,
    };
    with_conn(|conn| {
        let report = memory::merge(conn, &scope, &[item], "manual", None)?;
        let _ = memory::rebuild_profile(conn, &scope);
        Ok(json!({ "scope": scope, "report": report }))
    })
}

pub fn tool_list(args: &Value) -> Result<Value, String> {
    let scope = scope_from_args(args);
    let kind = opt_str(args, "kind");
    let status = opt_str(args, "status").or_else(|| Some("active".into()));
    let limit = opt_usize(args, "limit").unwrap_or(20).clamp(1, LIST_MAX);
    with_conn(|conn| {
        let items = memory_store::list(conn, Some(&scope), kind.as_deref(), status.as_deref(), limit)?;
        let arr: Vec<Value> = items.iter().map(item_json).collect();
        Ok(json!({ "scope": scope, "items": arr, "count": arr.len() }))
    })
}

pub fn tool_forget(args: &Value) -> Result<Value, String> {
    let id = req_str(args, "id")?;
    with_conn(|conn| {
        memory_store::soft_delete(conn, &id)?;
        Ok(json!({ "id": id, "deleted": true }))
    })
}

pub fn tool_profile_get(args: &Value) -> Result<Value, String> {
    let scope = scope_from_args(args);
    with_conn(|conn| {
        let profile = memory_store::get_profile(conn, &scope)?;
        let fields: Value = serde_json::from_str(&profile.fields_json).unwrap_or(json!({}));
        Ok(json!({
            "scope": profile.scope, "summary": profile.summary,
            "fields": fields, "fieldsJson": profile.fields_json, "revision": profile.revision
        }))
    })
}

// ==================== Tauri 命令（供前端调用） ====================

#[tauri::command]
pub fn memory_list_items(
    scope: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let scope = norm_scope(scope);
    let limit = limit.unwrap_or(100).clamp(1, 1000);
    with_conn(|conn| {
        let items = memory_store::list(conn, Some(&scope), kind.as_deref(), status.as_deref(), limit)?;
        let arr: Vec<Value> = items.iter().map(item_json).collect();
        Ok(json!({ "scope": scope, "items": arr, "count": arr.len() }))
    })
}

#[tauri::command]
pub fn memory_get_item(id: String) -> Result<Value, String> {
    with_conn(|conn| match memory_store::get(conn, &id)? {
        Some(it) => Ok(item_json(&it)),
        None => Err(format!("记忆不存在：{id}")),
    })
}

#[tauri::command]
pub fn memory_update_item(id: String, content: String, importance: Option<i64>) -> Result<Value, String> {
    with_conn(|conn| {
        memory_store::update_content(conn, &id, &content, importance)?;
        if let Some(item) = memory_store::get(conn, &id)? {
            let _ = memory::rebuild_profile(conn, &item.scope);
        }
        Ok(json!({ "id": id, "updated": true }))
    })
}

#[tauri::command]
pub fn memory_delete_item(id: String, hard: Option<bool>) -> Result<Value, String> {
    with_conn(|conn| {
        let item = memory_store::get(conn, &id)?;
        let hard = hard.unwrap_or(false);
        if hard {
            memory_store::hard_delete(conn, &id)?;
        } else {
            memory_store::soft_delete(conn, &id)?;
        }
        if let Some(item) = item {
            let _ = memory::rebuild_profile(conn, &item.scope);
        }
        Ok(json!({ "id": id, "deleted": true, "hard": hard }))
    })
}

#[tauri::command]
pub fn memory_get_profile(scope: Option<String>) -> Result<Value, String> {
    let scope = norm_scope(scope);
    with_conn(|conn| {
        let profile = memory_store::get_profile(conn, &scope)?;
        Ok(json!({
            "scope": profile.scope,
            "fieldsJson": profile.fields_json,
            "summary": profile.summary,
            "revision": profile.revision
        }))
    })
}

#[tauri::command]
pub fn memory_update_profile(
    scope: Option<String>,
    fields_json: Option<String>,
    summary: Option<String>,
) -> Result<Value, String> {
    let scope = norm_scope(scope);
    with_conn(|conn| {
        let current = memory_store::get_profile(conn, &scope)?;
        let fields = fields_json.unwrap_or(current.fields_json);
        let summary = summary.unwrap_or(current.summary);
        memory_store::upsert_profile(conn, &scope, &fields, &summary)?;
        Ok(json!({ "scope": scope, "updated": true }))
    })
}

#[tauri::command]
pub fn memory_stats(scope: Option<String>) -> Result<Value, String> {
    let scope = norm_scope(scope);
    with_conn(|conn| memory_store::counts(conn, &scope))
}

#[tauri::command]
pub fn memory_ensure_library() -> Result<Value, String> {
    let root = crate::storage_layout::root()?;
    with_conn(|conn| {
        let id = memory::ensure_memory_library(conn, &root)?;
        Ok(json!({ "libraryId": id }))
    })
}

/// 手动沉淀：同步执行；失败返回错误由前端提示（不伪装成功）。
#[tauri::command]
pub fn memory_resediment_session(session_id: String) -> Result<Value, String> {
    match memory::run_extraction_for_session(&session_id) {
        Ok(report) => Ok(json!({ "sessionId": session_id, "report": report })),
        Err(error) => Err(error),
    }
}
