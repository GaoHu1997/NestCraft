//! MEM-FIX-001: global 记忆的本地 Markdown 镜像。项目记忆永不进入个人库。
//! 与 knowledge 共用 SafeRoot/hash-CAS 文件操作，不重入 db::conn()。
use super::{files, enabled_root, scan_notes};
use crate::commands::memory_store;
use rusqlite::Connection;
use std::collections::BTreeMap;

const MARKER: &str = "<!-- nestcraft-personal-memory-v1 -->";

pub(crate) fn sync(conn: &Connection, library: &str) -> Result<usize, String> {
    // 普通知识操作先取 MUTATION 再取 DB；此处调用者持 DB，所以只 try_lock，避免锁顺序死锁。
    let _mutation = files::MUTATION.try_lock().map_err(|_| "MEMORY_SYNC_BUSY：知识文件正在修改，请刷新重试".to_string())?;
    sync_locked(conn,library)
}

// 仅knowledge已持MUTATION的owner文件操作调用，避免再取同一锁。
pub(super) fn sync_locked(conn:&Connection,library:&str)->Result<usize,String> {
    let kind: String = conn.query_row("SELECT sourceKind FROM knowledge_library WHERE id=?1 AND enabled=1", [library], |r| r.get(0)).map_err(|_| "MEMORY_LIBRARY_UNAVAILABLE".to_string())?;
    if kind != "personal-memory" { return Err("MEMORY_LIBRARY_INVALID".into()); }
    let mut root = enabled_root(conn, library)?;
    let mut wanted = BTreeMap::new();
    // 无 1000 条截断，否则漏项会被误删。
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM memory_item WHERE scope='global' AND status='active' ORDER BY id").map_err(|e|e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    for id in ids {
        let Some(item) = memory_store::get(conn, &id)? else { continue };
        files::validate_name(&format!("nc-memory-{id}.md"))?;
        let metadata = serde_json::json!({"id":item.id,"scope":"global","kind":item.kind,"sourceType":item.source_type,"sourceRef":item.source_ref,"importance":item.importance,"trust":item.trust,"updatedAt":item.updated_at});
        wanted.insert(format!("记忆/nc-memory-{id}.md"), format!("{MARKER}\n# 个人记忆 · {id}\n\n{}\n\n## 来源与范围\n```json\n{metadata}\n```\n", item.content));
    }
    let profile = memory_store::get_profile(conn, "global")?;
    wanted.insert("画像/nc-memory-profile.md".into(),format!("{MARKER}\n# 个人画像\n\n{}\n\n## 结构化字段\n```json\n{}\n```\n",profile.summary,profile.fields_json));
    let existing_entries = files::entries(&mut root)?;
    for (rel, text) in &wanted {
        let existing = existing_entries.iter().any(|e|e.rel == *rel && !e.is_dir);
        if existing {
            let (previous, hash) = files::read_text(&mut root, rel)?;
            if !previous.starts_with(MARKER) { return Err(format!("MEMORY_SYNC_CONFLICT：已有非受管笔记 {rel}，未覆盖")); }
            if previous != *text { files::save_markdown(&mut root, rel, &hash, text)?; }
        } else {
            let (parent,name) = rel.rsplit_once('/').ok_or("MEMORY_PATH_INVALID")?;
            files::create_markdown(&mut root,parent,name,text)?;
        }
    }
    // 只清理本模块自己生成的文件；用户笔记不动。软删和硬删均从活跃库移除。
    for entry in files::entries(&mut root)? {
        if entry.is_dir || wanted.contains_key(&entry.rel) { continue; }
        if !entry.rel.starts_with("记忆/nc-memory-") || !entry.rel.ends_with(".md") { continue; }
        let (text,_) = files::read_text(&mut root,&entry.rel)?;
        if text.starts_with(MARKER) { files::delete_entry(&mut root,&entry.rel)?; }
    }
    scan_notes(conn, library, &mut root)?;
    // 删除/修改后的旧向量不可继续召回。无模型时保留关键词通道，不伪称语义已就绪。
    let has_embed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='kb_embed' AND type='table')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if has_embed {
        conn.execute("DELETE FROM kb_embed WHERE libraryId=?1 AND NOT EXISTS (SELECT 1 FROM knowledge_note_index n WHERE n.libraryId=kb_embed.libraryId AND n.noteId=kb_embed.noteId AND n.contentHash=kb_embed.revision)",[library]).map_err(|e|e.to_string())?;
        if super::semantic::model_available() {
            for (rel,text) in &wanted {
                let (nid,hash):(String,String)=conn.query_row("SELECT noteId,contentHash FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2",[library,rel],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
                let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM kb_embed WHERE libraryId=?1 AND noteId=?2 AND revision=?3)",[library,&nid,&hash],|r|r.get(0)).map_err(|e|e.to_string())?;
                if !exists {
                    if let Err(_error)=super::semantic::upsert_embeddings(conn,library,&nid,rel,&hash,&super::semantic::chunk_text(text)) {eprintln!("[MEM-FIX-001] 个人记忆语义索引尚未就绪，关键词与正文已保存");}
                }
            }
        }
    }
    Ok(wanted.len())
}

/// owner在个人库编辑受管记忆时同步回memory_item，保留全局范围。
pub(super) fn edited_item(conn:&Connection,rel:&str,content:&str)->Result<Option<(String,String)>,String> {
    let Some(name)=rel.strip_prefix("记忆/nc-memory-").and_then(|s|s.strip_suffix(".md")) else {return Ok(None)};
    let Some(item)=memory_store::get(conn,name)? else {return Ok(None)};
    if item.scope!="global" {return Err("MEMORY_SCOPE_INVALID：项目记录不得进入个人库".into())}
    if !content.starts_with(MARKER) {return Err("受管记忆需保留首行标识，请在记忆页编辑正文".into())}
    let body=content.split_once("\n\n").and_then(|(_,s)|s.split_once("\n\n## 来源与范围").map(|(body,_)|body.trim())).ok_or("受管记忆格式损坏，请在记忆页编辑")?;
    if body.is_empty()||body.len()>2048 {return Err("记忆正文不能为空或超过2048字节".into())}
    Ok(Some((item.id,body.to_string())))
}
pub(super) fn deleted_item(conn:&Connection,rel:&str)->Result<Option<String>,String> {
    let Some(id)=rel.strip_prefix("记忆/nc-memory-").and_then(|s|s.strip_suffix(".md")) else {return Ok(None)};
    let Some(item)=memory_store::get(conn,id)? else {return Ok(None)};
    if item.scope!="global" {return Err("MEMORY_SCOPE_INVALID".into())}
    Ok(Some(item.id))
}
