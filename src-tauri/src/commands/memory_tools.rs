//! FEAT-026 / MEM-FIX-001: owner UI 与 AI 的可信项目身份分离。
use crate::commands::memory::{self, Extracted};
use crate::commands::memory_store::{self, MemoryItem};
use rusqlite::Connection;
use serde_json::{json, Value};

fn text<'a>(args:&'a Value,key:&str)->Option<&'a str> { args.get(key).and_then(Value::as_str).map(str::trim).filter(|v|!v.is_empty()) }
fn required(args:&Value,key:&str)->Result<String,String> { text(args,key).map(str::to_string).ok_or_else(||format!("缺少必填参数：{key}")) }
fn limit(args:&Value)->usize { args.get("limit").and_then(Value::as_u64).unwrap_or(10).clamp(1,20) as usize }
fn with_conn<T>(f:impl FnOnce(&Connection)->Result<T,String>)->Result<T,String> { let guard=crate::db::conn()?;f(guard.as_ref().ok_or("db not initialized")?) }

/// project_id来自宿主ToolContext，不允许模型参数覆盖。None读个人+当前项目，写默认当前项目。
fn resolve_scope(conn:&Connection,requested:Option<&str>,project_id:Option<&str>,write:bool)->Result<Option<String>,String> {
    match requested {
        Some("personal"|"global") => Ok(Some("global".into())),
        None if !write => Ok(None),
        None if project_id.is_none() => Ok(Some("global".into())),
        Some("project")|None => {
            let id=project_id.ok_or("MEMORY_ACCESS_DENIED：无项目会话不能访问项目记忆")?;
            ensure_project(conn,id)?;
            Ok(Some(format!("project:{id}")))
        },
        Some(scope) if scope.starts_with("project:") => {
            let id=scope.trim_start_matches("project:");
            if project_id!=Some(id) { return Err("MEMORY_ACCESS_DENIED：只能访问当前项目记忆".into()); }
            ensure_project(conn,id)?; Ok(Some(scope.into()))
        },
        Some(_) => Err("MEMORY_SCOPE_INVALID：请选择 personal 或 project".into()),
    }
}
fn ensure_project(conn:&Connection,id:&str)->Result<(),String> {
    if !conn.query_row("SELECT EXISTS(SELECT 1 FROM project WHERE id=?1)",[id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? { return Err("MEMORY_ACCESS_DENIED：项目不存在".into()); }
    Ok(())
}
fn owner_scope(conn:&Connection,scope:Option<&str>)->Result<String,String> {
    match scope {
        None|Some("personal"|"global") => Ok("global".into()),
        Some(s) if s.starts_with("project:") => { ensure_project(conn,&s[8..])?;Ok(s.into()) },
        _=>Err("MEMORY_SCOPE_INVALID".into()),
    }
}
fn validate_item_access(conn:&Connection,item:&MemoryItem,project:Option<&str>)->Result<(),String> {
    resolve_scope(conn,Some(&item.scope),project,true).map(|_|())
}
fn visible_items(conn:&Connection,scope:Option<String>,project:Option<&str>,kind:Option<&str>,status:Option<&str>)->Result<Vec<MemoryItem>,String> {
    if let Some(scope)=scope { return memory_store::list(conn,Some(&scope),kind,status,1000); }
    let mut items=memory_store::list(conn,Some("global"),kind,status,1000)?;
    if let Some(pid)=project { ensure_project(conn,pid)?;items.extend(memory_store::list(conn,Some(&format!("project:{pid}")),kind,status,1000)?); }
    items.sort_by(|a,b|a.trust.eq("external").cmp(&b.trust.eq("external")).then(b.updated_at.cmp(&a.updated_at)));
    Ok(items)
}
fn require_enabled_personal_library(conn:&Connection)->Result<(),String> {
    let enabled:Option<i64>=conn.query_row("SELECT enabled FROM knowledge_library WHERE sourceKind='personal-memory' ORDER BY createdAt,id LIMIT 1",[],|r|r.get(0)).ok();
    if enabled==Some(0) { return Err("MEMORY_LIBRARY_UNAVAILABLE：个人记忆库已停用".into()); }
    Ok(())
}
fn finish(conn:&Connection,scope:&str)->Result<(),String> {
    memory::rebuild_profile(conn,scope)?;
    if scope=="global" { memory::sync_personal(conn)?; }
    Ok(())
}
fn validate_content(content:&str,importance:Option<i64>)->Result<(),String> {
    if content.trim().is_empty()||content.len()>2048 { return Err("记忆不能为空或超过2048字节".into()); }
    if importance.is_some_and(|n|!(1..=5).contains(&n)) { return Err("重要度必须1～5".into()); }
    Ok(())
}
pub fn item_json(item:&MemoryItem)->Value { serde_json::to_value(item).unwrap_or(Value::Null) }

/// AI入口：所有工具共用可信ctx，猜其它项目id亦不能delete。
pub fn run_tool(ctx:&crate::commands::ai_tools::ToolContext,name:&str,args:&Value)->Result<Value,String> {
    with_conn(|conn| {
        require_enabled_personal_library(conn)?;
        // 禁止把模型提供的projectId当作授权。
        if let Some(given)=text(args,"projectId") {
            if ctx.project_id.as_deref()!=Some(given) { return Err("MEMORY_ACCESS_DENIED：projectId与当前会话不一致".into()); }
        }
        let project=ctx.project_id.as_deref();
        match name {
            "memory_search"|"memory_list" => {
                let scope=resolve_scope(conn,text(args,"scope"),project,false)?;
                let query=if name=="memory_search" { required(args,"query")?.to_lowercase() } else { String::new() };
                let status=text(args,"status").unwrap_or("active");
                let items=visible_items(conn,scope,project,text(args,"kind"),Some(status))?;
                let hits:Vec<_>=items.into_iter().filter(|it|query.is_empty()||it.content.to_lowercase().contains(&query)||it.mem_key.as_ref().is_some_and(|k|k.to_lowercase().contains(&query)))
                    .take(limit(args)).map(|mut it| { it.content=it.content.chars().take(200).collect();item_json(&it) }).collect();
                Ok(json!({"items":hits,"hits":hits,"count":hits.len(),"visibleScopes":if let Some(p)=project {vec!["global".to_string(),format!("project:{p}")]} else {vec!["global".into()]}}))
            },
            "memory_save" => {
                let scope=resolve_scope(conn,text(args,"scope"),project,true)?.ok_or("MEMORY_SCOPE_INVALID")?;
                let content=required(args,"content")?; let kind=required(args,"kind")?;
                let importance=args.get("importance").and_then(Value::as_i64).unwrap_or(3);
                validate_content(&content,Some(importance))?;
                if content.len()>1024 { return Err("content超过1024字节".into()); }
                if !memory::is_valid_kind(&kind) { return Err("记忆kind非法".into()); }
                let item=Extracted {kind,mem_key:text(args,"memKey").map(str::to_string),content,importance,trust:"own".into(),memory_scope:if scope=="global" {"personal".into()} else {"project".into()} };
                let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
                let report=memory::merge(&tx,&scope,&[item],"manual",None)?;
                memory::rebuild_profile(&tx,&scope)?;
                tx.commit().map_err(|e|e.to_string())?;
                if scope=="global" { memory::sync_personal(conn)?; }
                Ok(json!({"saved":true,"scope":scope,"synced":scope=="global","report":report}))
            },
            "memory_forget" => {
                let id=required(args,"id")?;
                let item=memory_store::get(conn,&id)?.ok_or("记忆不存在")?;
                validate_item_access(conn,&item,project)?;
                memory_store::soft_delete(conn,&id)?;finish(conn,&item.scope)?;
                Ok(json!({"deleted":true,"id":id,"scope":item.scope}))
            },
            "profile_get" => {
                let scope=resolve_scope(conn,Some(text(args,"scope").unwrap_or("personal")),project,false)?.ok_or("MEMORY_SCOPE_INVALID")?;
                Ok(json!(memory_store::get_profile(conn,&scope)?))
            },
            _=>Err("未知记忆工具".into()),
        }
    })
}

// owner UI 可选择任何现有项目，但AI不可调用这些owner IPC绕过ctx。
#[tauri::command]
pub fn memory_list_items(scope:Option<String>,kind:Option<String>,status:Option<String>,limit:Option<usize>)->Result<Value,String> {
    with_conn(|conn| { let scope=owner_scope(conn,scope.as_deref())?;let items=memory_store::list(conn,Some(&scope),kind.as_deref(),status.as_deref(),limit.unwrap_or(500).clamp(1,1000))?;Ok(json!({"scope":scope,"items":items})) })
}
#[tauri::command]
pub fn memory_get_item(id:String)->Result<Value,String> { with_conn(|conn|memory_store::get(conn,&id)?.map(|it|item_json(&it)).ok_or("记忆不存在".into())) }
#[tauri::command]
pub fn memory_update_item(id:String,content:String,importance:Option<i64>)->Result<Value,String> {
    validate_content(&content,importance)?;
    with_conn(|conn| { let item=memory_store::get(conn,&id)?.ok_or("记忆不存在")?;memory_store::update_content(conn,&id,&content,importance)?;finish(conn,&item.scope)?;Ok(json!({"updated":true,"id":id,"scope":item.scope})) })
}
#[tauri::command]
pub fn memory_delete_item(id:String,hard:Option<bool>)->Result<Value,String> {
    with_conn(|conn|{let item=memory_store::get(conn,&id)?.ok_or("记忆不存在")?;if hard.unwrap_or(false) {memory_store::hard_delete(conn,&id)?;}else{memory_store::soft_delete(conn,&id)?;}finish(conn,&item.scope)?;Ok(json!({"deleted":true,"id":id,"scope":item.scope}))})
}
#[tauri::command]
pub fn memory_get_profile(scope:Option<String>)->Result<Value,String> { with_conn(|conn|{let scope=owner_scope(conn,scope.as_deref())?;Ok(json!(memory_store::get_profile(conn,&scope)?))}) }
#[tauri::command]
pub fn memory_update_profile(scope:Option<String>,fields_json:Option<String>,summary:Option<String>)->Result<Value,String> {
    with_conn(|conn| {let scope=owner_scope(conn,scope.as_deref())?;let p=memory_store::get_profile(conn,&scope)?;let fields=fields_json.unwrap_or(p.fields_json);serde_json::from_str::<Value>(&fields).map_err(|_|"fieldsJson非法")?;let summary=summary.unwrap_or(p.summary);if summary.len()>2048 {return Err("画像摘要超过2048字节".into());}memory_store::upsert_profile(conn,&scope,&fields,&summary)?;if scope=="global" {memory::sync_personal(conn)?;}Ok(json!({"updated":true,"scope":scope}))})
}
#[tauri::command]
pub fn memory_stats(scope:Option<String>)->Result<Value,String> { with_conn(|conn|{let scope=owner_scope(conn,scope.as_deref())?;memory_store::counts(conn,&scope)}) }
#[tauri::command]
pub fn memory_ensure_library()->Result<Value,String> { with_conn(|conn|{let root=crate::storage_layout::root()?;let id=memory::ensure_memory_library(conn,&root)?;let count=memory::sync_personal_at(conn,&root)?;Ok(json!({"libraryId":id,"synced":true,"fileCount":count}))}) }
#[tauri::command]
pub async fn memory_resediment_session(session_id:String)->Result<Value,String> { let id=session_id.clone();let report=tauri::async_runtime::spawn_blocking(move ||memory::run_extraction_for_session(&id)).await.map_err(|_|"抽取任务中断")??;Ok(json!({"sessionId":session_id,"report":report})) }

#[cfg(test)]
mod tests {
    use super::*;
    fn conn()->Connection {let c=Connection::open_in_memory().unwrap();memory_store::ensure_schema(&c).unwrap();c.execute_batch("CREATE TABLE project(id TEXT PRIMARY KEY);INSERT INTO project VALUES('a'),('b');").unwrap();c}
    fn item(scope:&str)->MemoryItem {MemoryItem{id:"m".into(),scope:scope.into(),kind:"fact".into(),mem_key:None,content:"fixture".into(),source_type:"manual".into(),source_ref:None,trust:"own".into(),importance:3,confidence:0.7,status:"active".into(),superseded_by:None,access_count:0,last_access_at:None,created_at:1,updated_at:1}}
    #[test] fn personal_scope_not_overridden_by_current_project(){let c=conn();assert_eq!(resolve_scope(&c,Some("personal"),Some("a"),true).unwrap(),Some("global".into()));assert_eq!(resolve_scope(&c,Some("project"),Some("a"),true).unwrap(),Some("project:a".into()));}
    #[test] fn other_projects_and_unknown_scope_rejected(){let c=conn();assert!(resolve_scope(&c,Some("project:b"),Some("a"),false).is_err());assert!(resolve_scope(&c,Some("project"),None,false).is_err());assert!(resolve_scope(&c,Some("all"),Some("a"),false).is_err());}
    #[test] fn read_only_personal_and_current_project(){let c=conn();for s in ["global","project:a","project:b"]{let mut i=item(s);i.id=s.into();memory_store::insert(&c,&i).unwrap();}let rows=visible_items(&c,None,Some("b"),None,Some("active")).unwrap();assert_eq!(rows.len(),2);assert!(rows.iter().all(|it|it.scope!="project:a"));}
    #[test] fn guessed_id_cannot_forget_other_project(){let c=conn();assert!(validate_item_access(&c,&item("project:a"),Some("b")).is_err());assert!(validate_item_access(&c,&item("project:a"),None).is_err());assert!(validate_item_access(&c,&item("global"),Some("b")).is_ok());}
}
