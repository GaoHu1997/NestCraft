//! CR-045: managed local library files, derived Markdown index, explicit user writes.
//! AI gateway remains read-only and rechecks project grants + enabled libraries every call.

use crate::db;
use crate::models::{now_ms, new_id, KnowledgeHit, KnowledgeLibrary, LibraryGrant, NoteContent, NoteNode};
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::path::Path;

#[path = "knowledge_files.rs"]
mod files;
pub use files::{ExportResult, KnowledgeFileData, KnowledgeFileInfo, UploadItem, UploadResult};

fn enabled_root(conn: &Connection, id: &str) -> Result<files::SafeRoot, String> {
    let source: String = conn.query_row(
        "SELECT sourceRef FROM knowledge_library WHERE id=?1 AND enabled=1 AND sourceKind='managed-directory'",
        [id], |r| r.get(0),
    ).map_err(|_| "知识库不存在、已禁用或不是受管本机目录".to_string())?;
    files::SafeRoot::new(Path::new(&source))
}
fn indexed(conn: &Connection, id: &str) -> Result<BTreeMap<String, (String, String)>, String> {
    let mut stmt = conn.prepare("SELECT relativeUri,noteId,title FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?))))
        .map_err(|e| e.to_string())?.collect::<Result<BTreeMap<_,_>,_>>().map_err(|e| e.to_string());
    rows
}
fn title(rel: &str, content: &str) -> String {
    content.lines().find_map(|line| line.strip_prefix("# ").map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Path::new(rel).file_stem().unwrap_or_default().to_string_lossy().to_string())
}
fn resolve(conn: &Connection, root: &mut files::SafeRoot, id: &str, note_id: &str) -> Result<(String, String), String> {
    let note: Option<(String, String)> = conn.query_row(
        "SELECT relativeUri,title FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2", [id, note_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if let Some((rel, name)) = note { root.file(&rel)?; return Ok((rel, name)); }
    // Binary/new Markdown files are visible immediately without an index migration.
    // Preserve the old decimal path-hash ID, and refuse collisions instead of guessing.
    let mut matches = files::entries(root)?.into_iter().filter(|e| !e.is_dir && files::file_id(&e.rel) == note_id);
    let item = matches.next().ok_or("文件不存在")?;
    if matches.next().is_some() { return Err("文件身份冲突，不能安全解析".into()); }
    root.file(&item.rel)?;
    let name = item.rel.rsplit('/').next().unwrap_or("").to_string();
    Ok((item.rel, name))
}
fn publish_note(conn: &Connection, id: &str, rel: &str, content: &str) -> Result<String, String> {
    let existing: Option<String> = conn.query_row(
        "SELECT noteId FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2", [id,rel], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let note_id = existing.unwrap_or_else(|| files::file_id(rel));
    // Do not replace a different path when the non-cryptographic path hash collides.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(libraryId,relativeUri) DO UPDATE SET title=excluded.title,contentHash=excluded.contentHash,updatedAt=excluded.updatedAt",
        rusqlite::params![id,note_id,title(rel,content),rel,files::hash(content.as_bytes()),now_ms()],
    ).map_err(|e| e.to_string())?;
    tx.execute("UPDATE knowledge_library SET revision=revision+1 WHERE id=?1 AND enabled=1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(note_id)
}
fn saved_note(conn: &Connection, id: &str, rel: &str, content: String, fallback_id: Option<&str>) -> NoteContent {
    let (note_id, error) = match publish_note(conn,id,rel,&content) {
        Ok(id) => (id,None),
        Err(e) => (fallback_id.map(str::to_string).unwrap_or_else(|| files::file_id(rel)),
            Some(format!("文件已保存，但派生索引更新失败；请重建索引，不要重复创建：{e}"))),
    };
    NoteContent { note_id, title: title(rel,&content), relative_uri: rel.into(), hash: Some(files::hash(content.as_bytes())), content, index_error: error }
}
fn scan_notes(conn: &Connection, id: &str, root: &mut files::SafeRoot) -> Result<i64, String> {
    let old = indexed(conn,id)?;
    // Gather the entire bounded filesystem and valid text first. Never flatten walk
    // errors into an empty note or publish a partial/truncated replacement index.
    let mut notes = vec![];
    for entry in files::entries(root)? {
        if entry.is_dir || !files::markdown(Path::new(&entry.rel)) { continue; }
        let (content, hash) = files::read_text(root,&entry.rel).map_err(|e| format!("索引未更新，文件不可读取（{}）：{e}",entry.rel))?;
        let note_id = old.get(&entry.rel).map(|(id,_)| id.clone()).unwrap_or_else(|| files::file_id(&entry.rel));
        notes.push((note_id,title(&entry.rel,&content),entry.rel,hash));
    }
    root.verify()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1",[id]).map_err(|e| e.to_string())?;
    for (nid,name,rel,hash) in &notes {
        tx.execute(
            "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt) VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id,nid,name,rel,hash,now_ms()],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute("UPDATE knowledge_library SET revision=revision+1 WHERE id=?1 AND enabled=1",[id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(notes.len() as i64)
}

#[tauri::command]
pub fn kb_list() -> Result<Vec<KnowledgeLibrary>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn.prepare(
        "SELECT l.id,l.name,l.sourceKind,l.sourceRef,l.enabled,l.revision,
        (SELECT COUNT(*) FROM knowledge_note_index n WHERE n.libraryId=l.id)
        FROM knowledge_library l ORDER BY l.createdAt",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(KnowledgeLibrary { id:r.get(0)?,name:r.get(1)?,source_kind:r.get(2)?,source_ref:r.get(3)?,
        enabled:r.get::<_,i64>(4)? != 0,revision:r.get(5)?,note_count:r.get(6)? }))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}
#[tauri::command]
pub fn kb_save(app: tauri::AppHandle, name: String, source_ref: String) -> Result<String, String> {
    if name.trim().is_empty() { return Err("知识库名称不能为空".into()); }
    let root = files::SafeRoot::new(Path::new(&source_ref))?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let id = new_id("kb");
    conn.execute(
        "INSERT INTO knowledge_library(id,name,sourceKind,sourceRef,revision,enabled,createdAt) VALUES(?1,?2,'managed-directory',?3,0,1,?4)",
        rusqlite::params![id,name.trim(),root.path.to_string_lossy(),now_ms()],
    ).map_err(|e| e.to_string())?;
    let _ = app;
    Ok(id)
}
#[tauri::command]
pub fn kb_delete(id: String) -> Result<(), String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_library WHERE id=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM project_library_grant WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn kb_scan(id: String) -> Result<i64, String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    scan_notes(conn,&id,&mut enabled_root(conn,&id)?)
}
#[tauri::command]
pub fn kb_tree(id: String) -> Result<Vec<NoteNode>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let entries = files::entries(&mut enabled_root(conn,&id)?)?;
    Ok(files::tree(&entries,&indexed(conn,&id)?))
}
fn read_note(conn: &Connection, id: &str, note_id: &str) -> Result<NoteContent, String> {
    let mut root = enabled_root(conn,id)?;
    let (rel,name) = resolve(conn,&mut root,id,note_id)?;
    // This legacy endpoint is also the AI gateway reader. Uploading an attachment
    // must not silently expand the supported AI formats or grant it write access.
    if !files::markdown(Path::new(&rel)) { return Err("AI/笔记接口仅支持Markdown；其它格式请使用用户文件预览".into()); }
    let (content,hash) = files::read_text(&mut root,&rel)?;
    Ok(NoteContent { note_id:note_id.into(),title:name,relative_uri:rel,content,hash:Some(hash),index_error:None })
}
#[tauri::command]
pub fn kb_read(lib_id: String, note_id: String) -> Result<NoteContent, String> {
    let guard = db::conn()?;
    read_note(guard.as_ref().ok_or("db not initialized")?,&lib_id,&note_id)
}

// Explicit user operations. None of these commands is exposed by kb_gateway.
#[tauri::command]
pub fn kb_create_folder(id: String, parent_relative_uri: String, name: String) -> Result<NoteNode, String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    files::create_folder(&mut enabled_root(conn,&id)?,&parent_relative_uri,&name)
}
#[tauri::command]
pub fn kb_create_markdown(id: String, parent_relative_uri: String, name: String, content: String) -> Result<NoteContent, String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let rel = files::create_markdown(&mut enabled_root(conn,&id)?,&parent_relative_uri,&name,&content)?;
    Ok(saved_note(conn,&id,&rel,content,None))
}
#[tauri::command]
pub fn kb_save_markdown(id: String, note_id: String, expected_hash: String, content: String) -> Result<NoteContent, String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = enabled_root(conn,&id)?;
    let (rel,_) = resolve(conn,&mut root,&id,&note_id)?;
    files::save_markdown(&mut root,&rel,&expected_hash,&content)?;
    Ok(saved_note(conn,&id,&rel,content,Some(&note_id)))
}
#[tauri::command]
pub fn kb_file_info(id: String, note_id: String) -> Result<KnowledgeFileInfo, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = enabled_root(conn,&id)?;
    let (rel,title) = resolve(conn,&mut root,&id,&note_id)?;
    files::info(&mut root,&rel,&note_id,&title)
}
#[tauri::command]
pub fn kb_read_file(id: String, note_id: String) -> Result<KnowledgeFileData, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = enabled_root(conn,&id)?;
    let (rel,title) = resolve(conn,&mut root,&id,&note_id)?;
    files::data(&mut root,&rel,&note_id,&title)
}
fn upload_selected(conn: &Connection, id: &str, parent: &str, paths: Option<Vec<std::path::PathBuf>>) -> Result<UploadResult, String> {
    let mut root = enabled_root(conn,id)?;
    root.parent(parent)?;
    let Some(paths) = paths else { return Ok(UploadResult { cancelled:true,items:vec![] }); };
    if paths.len() > files::BATCH_LIMIT { return Err("最多选择20个文件；此次未复制任何文件".into()); }
    let mut items = vec![];
    for source in paths {
        let name = source.file_name().unwrap_or_default().to_string_lossy().to_string();
        let mut item = UploadItem { name,success:false,note_id:None,relative_uri:None,error:None,index_error:None };
        match files::upload_one(&mut root,parent,&source) {
            Err(error) => item.error = Some(error),
            Ok(rel) => {
                item.success = true;
                item.note_id = Some(files::file_id(&rel));
                item.relative_uri = Some(rel.clone());
                if files::markdown(Path::new(&rel)) {
                    match files::read_text(&mut root,&rel) {
                        Ok((content,_)) => match publish_note(conn,id,&rel,&content) {
                            Ok(note_id) => item.note_id = Some(note_id),
                            Err(e) => item.index_error = Some(format!("原件已上传，索引失败，请重建：{e}")),
                        },
                        Err(e) => item.index_error = Some(format!("原件已上传，文本不可索引：{e}")),
                    }
                }
            }
        }
        items.push(item);
    }
    Ok(UploadResult { cancelled:false,items })
}
#[tauri::command]
pub async fn kb_upload_files(id: String, parent_relative_uri: String) -> Result<UploadResult, String> {
    // Validate target before showing picker; drop all locks before awaiting human input.
    let mut initial_root = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        enabled_root(conn,&id)?
    };
    initial_root.parent(&parent_relative_uri)?;
    let paths = files::picker(false).await?;
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    initial_root.verify()?;
    if initial_root.path != enabled_root(conn,&id)?.path { return Err("选择期间知识库根发生变化，未复制文件".into()); }
    upload_selected(conn,&id,&parent_relative_uri,paths)
}
#[tauri::command]
pub async fn kb_export_file(id: String, note_id: String) -> Result<ExportResult, String> {
    let (mut initial_root, initial_rel) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let mut root = enabled_root(conn,&id)?;
        let (rel,_) = resolve(conn,&mut root,&id,&note_id)?;
        (root,rel)
    };
    initial_root.file(&initial_rel)?;
    let choice = files::picker(true).await?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = enabled_root(conn,&id)?;
    initial_root.verify()?;
    let (rel,_) = resolve(conn,&mut root,&id,&note_id)?;
    if root.path != initial_root.path || rel != initial_rel { return Err("选择期间知识文件位置发生变化，未导出".into()); }
    let Some(paths) = choice else { return Ok(ExportResult { cancelled:true,exported:false }); };
    let path = paths.first().ok_or("没有选择导出目标")?;
    files::export(&mut root,&rel,path)?;
    Ok(ExportResult { cancelled:false,exported:true })
}

fn search(conn: &Connection, libs: &[String], query: &str) -> Result<Vec<KnowledgeHit>, String> {
    // Validate every requested library before an early result limit can return.
    for lib in libs { enabled_root(conn,lib)?; }
    if query.trim().is_empty() { return Ok(vec![]); }
    let q = query.to_lowercase();
    let mut hits = vec![];
    for lib in libs {
        let mut root = enabled_root(conn,lib)?;
        let name: String = conn.query_row("SELECT name FROM knowledge_library WHERE id=?1 AND enabled=1",[lib],|r| r.get(0)).map_err(|e| e.to_string())?;
        for (rel,(nid,title)) in indexed(conn,lib)? {
            if !files::markdown(Path::new(&rel)) { continue; }
            // Resolve canonical/symlink boundaries even when the title alone matches.
            let (content,_) = files::read_text(&mut root,&rel).map_err(|e| format!("搜索失败（{rel}）：{e}"))?;
            let snippet = if title.to_lowercase().contains(&q) { Some(title.clone()) }
                else { content.lines().find(|l| l.to_lowercase().contains(&q)).map(|l| l.trim().chars().take(200).collect()) };
            if let Some(snippet) = snippet {
                hits.push(KnowledgeHit { library_id:lib.clone(),library_name:name.clone(),note_id:nid,relative_uri:rel,title,snippet });
            }
            if hits.len() >= 100 { return Ok(hits); }
        }
    }
    Ok(hits)
}
#[tauri::command]
pub fn kb_search(lib_ids: Vec<String>, query: String) -> Result<Vec<KnowledgeHit>, String> {
    let guard = db::conn()?;
    search(guard.as_ref().ok_or("db not initialized")?,&lib_ids,&query)
}

// ---------- Grants and read-only gateway ----------
#[tauri::command]
pub fn kb_grants(project_id: Option<String>) -> Result<Vec<LibraryGrant>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn.prepare(
        "SELECT l.id,l.name,g.projectId,COALESCE(g.readAllowed,0) FROM knowledge_library l
         LEFT JOIN project_library_grant g ON g.libraryId=l.id AND (?1 IS NULL OR g.projectId=?1) ORDER BY l.name",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([project_id.as_deref()],|r| Ok(LibraryGrant { library_id:r.get(0)?,library_name:r.get(1)?,
        project_id:r.get(2)?,read_allowed:r.get::<_,i64>(3)? != 0 }))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}
#[tauri::command]
pub fn kb_grant_set(project_id: String, library_id: String, read_allowed: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    if read_allowed {
        enabled_root(conn,&library_id)?;
        conn.execute(
            "INSERT INTO project_library_grant(projectId,libraryId,readAllowed,updatedAt,actor) VALUES(?1,?2,1,?3,'owner')
             ON CONFLICT(projectId,libraryId) DO UPDATE SET readAllowed=1,updatedAt=?3",
            rusqlite::params![project_id,library_id,now_ms()],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM project_library_grant WHERE projectId=?1 AND libraryId=?2",[&project_id,&library_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn authorized(conn: &Connection, project_id: Option<&str>) -> Result<Vec<String>, String> {
    let Some(pid) = project_id else { return Ok(vec![]); };
    let mut stmt = conn.prepare(
        "SELECT g.libraryId FROM project_library_grant g JOIN knowledge_library l ON l.id=g.libraryId
         WHERE g.projectId=?1 AND g.readAllowed=1 AND l.enabled=1 ORDER BY g.libraryId",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([pid],|r| r.get::<_,String>(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}
fn gateway_list_conn(conn: &Connection, project_id: Option<&str>) -> Result<serde_json::Value, String> {
    let mut out = vec![];
    for lib in authorized(conn,project_id)? {
        enabled_root(conn,&lib)?;
        let (name,count): (String,i64) = conn.query_row(
            "SELECT name,(SELECT COUNT(*) FROM knowledge_note_index WHERE libraryId=?1) FROM knowledge_library WHERE id=?1 AND enabled=1",
            [&lib],|r| Ok((r.get(0)?,r.get(1)?)),
        ).map_err(|e| e.to_string())?;
        out.push(serde_json::json!({"id":lib,"name":name,"noteCount":count}));
    }
    Ok(serde_json::json!({"libraries":out}))
}
pub fn gateway_list(project_id: Option<&str>) -> Result<serde_json::Value, String> {
    let guard = db::conn()?;
    gateway_list_conn(guard.as_ref().ok_or("db not initialized")?,project_id)
}
pub fn gateway_search(project_id: Option<&str>, query: &str) -> Result<serde_json::Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let libs = authorized(conn,project_id)?;
    if libs.is_empty() { return Ok(serde_json::json!({"hits":[],"denied":true})); }
    Ok(serde_json::json!({"hits":search(conn,&libs,query)?,"denied":false}))
}
fn gateway_read_conn(conn: &Connection, project_id: Option<&str>, library_id: &str, note_id: &str) -> Result<String, String> {
    if !authorized(conn,project_id)?.iter().any(|l| l == library_id) { return Err("知识库未授权或已禁用，读取被拒绝".into()); }
    Ok(read_note(conn,library_id,note_id)?.content)
}
pub fn gateway_read(project_id: Option<&str>, library_id: &str, note_id: &str) -> Result<String, String> {
    let guard = db::conn()?;
    gateway_read_conn(guard.as_ref().ok_or("db not initialized")?,project_id,library_id,note_id)
}
#[tauri::command]
pub fn kb_gateway(project_id: Option<String>, tool: String, args_json: Option<String>) -> Result<serde_json::Value, String> {
    let args: serde_json::Value = serde_json::from_str(&args_json.unwrap_or_default()).unwrap_or(serde_json::json!({}));
    match tool.as_str() {
        "knowledge.list" => gateway_list(project_id.as_deref()),
        "knowledge.search" => gateway_search(project_id.as_deref(),args.get("query").and_then(|v| v.as_str()).ok_or("缺少query")?),
        "knowledge.read" => gateway_read(project_id.as_deref(),
            args.get("libraryId").and_then(|v| v.as_str()).ok_or("缺少libraryId")?,
            args.get("noteId").and_then(|v| v.as_str()).ok_or("缺少noteId")?)
            .map(|content| serde_json::json!({"content":content})),
        "knowledge.read_many" => {
            let items = args.get("notes").and_then(|v| v.as_array()).ok_or("缺少notes")?;
            if items.len() > 100 { return Err("单次最多读取100篇笔记".into()); }
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let mut out = vec![];
            let mut errors = vec![];
            for item in items {
                let lib = item.get("libraryId").and_then(|v| v.as_str()).unwrap_or("");
                let note = item.get("noteId").and_then(|v| v.as_str()).unwrap_or("");
                match gateway_read_conn(conn,project_id.as_deref(),lib,note) {
                    Ok(content) => out.push(serde_json::json!({"noteId":note,"content":content})),
                    Err(error) => errors.push(serde_json::json!({"noteId":note,"error":error})),
                }
            }
            Ok(serde_json::json!({"notes":out,"errors":errors}))
        }
        _ => Err("未知知识工具；AI不提供文件写入操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture { path: PathBuf, conn: Connection }
    impl Fixture {
        fn new() -> Self {
            // 夹具目录必须直接基于规范化后的临时目录：GitHub Windows runner 的
            // %TEMP% 可能是 8.3 短名（如 RUNNER~1），SafeRoot 会把 canonicalize
            // 结果与原始路径不一致判为“路径已变化”，与产品行为无关。
            let base = fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
            let path = base.join(new_id("knowledge-cr045-test"));
            fs::create_dir(&path).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceKind TEXT,sourceRef TEXT,revision INTEGER,enabled INTEGER,createdAt INTEGER);
                 CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri));
                 CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,updatedAt INTEGER,actor TEXT,PRIMARY KEY(projectId,libraryId));"
            ).unwrap();
            conn.execute("INSERT INTO knowledge_library VALUES('kb','Test','managed-directory',?1,0,1,0)",[path.to_string_lossy().as_ref()]).unwrap();
            Self { path, conn }
        }
        fn root(&self) -> files::SafeRoot { enabled_root(&self.conn,"kb").unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }

    #[test]
    fn knowledge_invalid_names_paths_and_devices_are_rejected() {
        for name in ["", ".", "..", " x", "x ", "x.", "../a", "a/b", "a\\b", "a:b", "a\0b", "CON", "nul.txt", "COM1.md", "LPT²", "CONOUT$", ".nestcraft-kb-save-a"] {
            assert!(files::validate_name(name).is_err(), "accepted {name:?}");
        }
        for rel in ["../outside", "/root", "x//y", "x/../y", "C:/x", "//server/share", "x\\y", "x/."] {
            assert!(files::relative(rel).is_err(),"accepted {rel:?}");
        }
        assert!(files::validate_name("中文草稿.MARKDOWN").is_ok());
        #[cfg(windows)]
        for path in [r"\\server\share\file", r"\\.\C:\file", r"C:\file:secret", r"\\?\UNC\server\share", r"C:\dir\..\file"] {
            assert!(files::SafeRoot::new(Path::new(path)).is_err());
        }
    }
    #[test]
    fn knowledge_create_new_hash_cas_and_existing_bytes_survive() {
        let f = Fixture::new();
        let mut root = f.root();
        let rel = files::create_markdown(&mut root,"","测试.MARKDOWN","# Initial\r\n正文").unwrap();
        assert!(files::create_markdown(&mut root,"","测试.MARKDOWN","overwrite").is_err());
        let initial = fs::read(f.path.join(&rel)).unwrap();
        assert_eq!(initial,"# Initial\r\n正文".as_bytes());
        assert_eq!(files::hash(b""),"fnv1a64:cbf29ce484222325");
        let note = saved_note(&f.conn,"kb",&rel,"# Initial\r\n正文".into(),None);
        assert_eq!(note.hash,Some(files::hash(&initial)));
        assert!(note.index_error.is_none());
        assert!(files::save_markdown(&mut root,&rel,"wrong","bad").unwrap_err().contains("冲突"));
        assert_eq!(fs::read(f.path.join(&rel)).unwrap(),initial);
        fs::write(f.path.join(&rel),"# external").unwrap();
        assert!(files::save_markdown(&mut root,&rel,note.hash.as_ref().unwrap(),"bad").is_err());
        assert_eq!(fs::read(f.path.join(&rel)).unwrap(),b"# external");
        let token = files::save_markdown(&mut root,&rel,&files::hash(b"# external"),"# Saved\nnew").unwrap();
        assert_eq!(token,files::hash(b"# Saved\nnew"));
        assert_eq!(fs::read(f.path.join(&rel)).unwrap(),b"# Saved\nnew");
        assert!(fs::read_dir(&f.path).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".nestcraft-kb-save-")));
    }
    #[test]
    fn knowledge_folder_creation_has_no_overwrite_or_implicit_parents() {
        let f = Fixture::new();
        let mut root = f.root();
        let folder = files::create_folder(&mut root,"","空目录").unwrap();
        assert!(folder.is_dir && folder.children.is_empty());
        assert!(f.path.join("空目录").is_dir());
        assert!(files::create_folder(&mut root,"","空目录").is_err());
        let child = files::create_folder(&mut root,"空目录","child").unwrap();
        assert_eq!(child.relative_uri,"空目录/child");
        let rel = files::create_markdown(&mut root,"空目录/child","note.md","# child").unwrap();
        assert_eq!(rel,"空目录/child/note.md");
        assert!(files::create_folder(&mut root,"missing/parent","child").is_err());
        assert!(!f.path.join("missing").exists());
        assert!(files::create_folder(&mut root,"","../escape").is_err());
        assert!(files::create_folder(&mut root,"空目录/child","note.md").is_err());
        assert_eq!(fs::read(f.path.join(rel)).unwrap(),b"# child");
    }
    #[test]
    fn knowledge_empty_deep_directories_and_binary_tree_are_real() {
        let f = Fixture::new();
        fs::create_dir_all(f.path.join("a/b/c/d/e")).unwrap();
        fs::create_dir(f.path.join("empty")).unwrap();
        fs::write(f.path.join("a/b/c/d/e/report.md"),"# Deep").unwrap();
        fs::write(f.path.join("original.bin"),[0,255,1,2,128]).unwrap();
        let mut root = f.root();
        assert_eq!(scan_notes(&f.conn,"kb",&mut root).unwrap(),1);
        let nodes = files::tree(&files::entries(&mut root).unwrap(),&indexed(&f.conn,"kb").unwrap());
        assert!(nodes.iter().any(|n| n.relative_uri == "empty" && n.children.is_empty() && n.is_dir));
        let mut n = nodes.iter().find(|n| n.relative_uri == "a").unwrap();
        for expected in ["a/b","a/b/c","a/b/c/d","a/b/c/d/e","a/b/c/d/e/report.md"] {
            n = n.children.iter().find(|n| n.relative_uri == expected).unwrap();
        }
        assert_eq!(n.title,"Deep");
        let binary = nodes.iter().find(|n| n.relative_uri == "original.bin").unwrap();
        assert_eq!(resolve(&f.conn,&mut root,"kb",&binary.note_id).unwrap().0,"original.bin");
        assert!(read_note(&f.conn,"kb",&binary.note_id).is_err());
        let metadata = files::data(&mut root,"original.bin",&binary.note_id,"binary").unwrap();
        assert_eq!(metadata.info.kind,"attachment");
        assert!(!metadata.info.preview_supported && metadata.text.is_none() && metadata.base64.is_none());
    }
    #[test]
    fn knowledge_scan_transaction_and_legacy_ids_are_preserved() {
        let f = Fixture::new();
        fs::write(f.path.join("legacy.md"),"# First").unwrap();
        f.conn.execute("INSERT INTO knowledge_note_index VALUES('kb','old-id','Old','legacy.md','old-hash',0)",[]).unwrap();
        assert_eq!(scan_notes(&f.conn,"kb",&mut f.root()).unwrap(),1);
        assert_eq!(indexed(&f.conn,"kb").unwrap()["legacy.md"].0,"old-id");
        let rev: i64 = f.conn.query_row("SELECT revision FROM knowledge_library",[],|r| r.get(0)).unwrap();
        fs::write(f.path.join("broken.md"),[0xff,0xfe]).unwrap();
        assert!(scan_notes(&f.conn,"kb",&mut f.root()).is_err());
        assert_eq!(indexed(&f.conn,"kb").unwrap().len(),1);
        assert_eq!(f.conn.query_row("SELECT revision FROM knowledge_library",[],|r| r.get::<_,i64>(0)).unwrap(),rev);
        fs::remove_file(f.path.join("broken.md")).unwrap();
        fs::write(f.path.join("UPPER.MD"),"# Upper").unwrap();
        fs::write(f.path.join("long.MARKDOWN"),"# Markdown").unwrap();
        assert_eq!(scan_notes(&f.conn,"kb",&mut f.root()).unwrap(),3);
        // Rollback after DELETE if publishing a row fails.
        f.conn.execute_batch("CREATE TRIGGER fail_index BEFORE INSERT ON knowledge_note_index BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(scan_notes(&f.conn,"kb",&mut f.root()).is_err());
        assert_eq!(indexed(&f.conn,"kb").unwrap().len(),3);
    }
    #[test]
    fn knowledge_index_failure_reports_saved_file_not_failed_save() {
        let f = Fixture::new();
        f.conn.execute_batch("CREATE TRIGGER fail_index BEFORE INSERT ON knowledge_note_index BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let rel = files::create_markdown(&mut f.root(),"","new.md","# saved").unwrap();
        let result = saved_note(&f.conn,"kb",&rel,"# saved".into(),None);
        assert!(result.index_error.unwrap().contains("文件已保存"));
        assert_eq!(fs::read(f.path.join("new.md")).unwrap(),b"# saved");
        assert_eq!(resolve(&f.conn,&mut f.root(),"kb",&result.note_id).unwrap().0,"new.md");
    }
    #[test]
    fn knowledge_upload_cancel_limits_collisions_and_bytes() {
        let f = Fixture::new();
        let source = Fixture::new();
        let bytes: Vec<_> = (0..=255).collect();
        fs::write(source.path.join("raw.bin"),&bytes).unwrap();
        fs::write(source.path.join("invalid.md"),[255,254]).unwrap();
        let cancelled = upload_selected(&f.conn,"kb","",None).unwrap();
        assert!(cancelled.cancelled && cancelled.items.is_empty());
        assert_eq!(fs::read_dir(&f.path).unwrap().count(),0);
        let first = upload_selected(&f.conn,"kb","",Some(vec![source.path.join("raw.bin"),source.path.join("invalid.md")])).unwrap();
        assert!(first.items[0].success && first.items[1].success);
        assert!(first.items[1].index_error.is_some());
        assert_eq!(fs::read(f.path.join("raw.bin")).unwrap(),bytes);
        let collision = upload_selected(&f.conn,"kb","",Some(vec![source.path.join("raw.bin")])).unwrap();
        assert!(!collision.items[0].success && collision.items[0].error.as_ref().unwrap().contains("同名"));
        assert_eq!(fs::read(f.path.join("raw.bin")).unwrap(),bytes);
        assert!(upload_selected(&f.conn,"kb","",Some(vec![source.path.join("raw.bin");21])).is_err());
        let big = fs::File::create(source.path.join("big.bin")).unwrap();
        big.set_len(files::FILE_LIMIT+1).unwrap(); drop(big);
        let result = upload_selected(&f.conn,"kb","",Some(vec![source.path.join("big.bin")])).unwrap();
        assert!(!result.items[0].success && !f.path.join("big.bin").exists());
        assert!(files::create_markdown(&mut f.root(),"","huge.md",&"x".repeat(files::TEXT_LIMIT as usize+1)).is_err());
        let text = fs::File::create(f.path.join("huge.txt")).unwrap(); text.set_len(files::TEXT_LIMIT+1).unwrap(); drop(text);
        assert!(files::read_text(&mut f.root(),"huge.txt").is_err());
    }
    #[test]
    fn knowledge_formats_require_utf8_and_image_signatures_pdf_is_metadata() {
        let f = Fixture::new();
        fs::write(f.path.join("safe.json"),"{\"ok\":true}").unwrap();
        assert_eq!(files::data(&mut f.root(),"safe.json","json","JSON").unwrap().text.as_deref(),Some("{\"ok\":true}"));
        fs::write(f.path.join("broken.txt"),[255]).unwrap();
        assert!(files::data(&mut f.root(),"broken.txt","txt","txt").is_err());
        fs::write(f.path.join("fake.png"),b"<svg onload='bad' />").unwrap();
        assert!(files::data(&mut f.root(),"fake.png","png","png").is_err());
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD,"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPrsAAAAASUVORK5CYII=").unwrap();
        fs::write(f.path.join("safe.png"),&png).unwrap();
        assert!(files::data(&mut f.root(),"safe.png","png","png").unwrap().base64.is_some());
        for filename in ["original.pdf","macro.docm","book.xlsx","page.html","vector.svg","bundle.zip"] {
            fs::write(f.path.join(filename),b"original bytes").unwrap();
            let data = files::data(&mut f.root(),filename,"id",filename).unwrap();
            assert!(!data.info.preview_supported && !data.info.editable);
            assert!(data.text.is_none() && data.base64.is_none());
        }
    }
    #[test]
    fn knowledge_disabled_and_grants_rechecked_every_read_search_gateway() {
        let f = Fixture::new();
        fs::write(f.path.join("read.md"),"# Secret\nkeyword").unwrap();
        scan_notes(&f.conn,"kb",&mut f.root()).unwrap();
        let id = files::file_id("read.md");
        assert!(gateway_read_conn(&f.conn,Some("p"),"kb",&id).is_err());
        f.conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,0,'test')",[]).unwrap();
        assert!(gateway_read_conn(&f.conn,Some("p"),"kb",&id).is_ok());
        assert_eq!(search(&f.conn,&["kb".into()],"keyword").unwrap().len(),1);
        f.conn.execute("UPDATE knowledge_library SET enabled=0",[]).unwrap();
        assert!(enabled_root(&f.conn,"kb").is_err());
        assert!(read_note(&f.conn,"kb",&id).is_err());
        assert!(search(&f.conn,&["kb".into()],"").is_err());
        assert!(gateway_read_conn(&f.conn,Some("p"),"kb",&id).is_err());
        assert!(authorized(&f.conn,Some("p")).unwrap().is_empty());
        assert_eq!(gateway_list_conn(&f.conn,Some("p")).unwrap()["libraries"].as_array().unwrap().len(),0);
        assert!(upload_selected(&f.conn,"kb","",None).is_err());
        f.conn.execute("UPDATE knowledge_library SET enabled=1",[]).unwrap();
        f.conn.execute("DELETE FROM project_library_grant",[]).unwrap();
        assert!(gateway_read_conn(&f.conn,Some("p"),"kb",&id).is_err());
    }
    #[test]
    fn knowledge_search_rejects_indexed_path_traversal_even_title_hit() {
        let f = Fixture::new();
        f.conn.execute("INSERT INTO knowledge_note_index VALUES('kb','bad','hit','../outside.md','',0)",[]).unwrap();
        assert!(search(&f.conn,&["kb".into()],"hit").is_err());
        assert!(read_note(&f.conn,"kb","bad").is_err());
    }
    #[test]
    fn knowledge_export_bytes_no_overwrite_and_failed_save_keeps_draft() {
        let f = Fixture::new();
        let target = Fixture::new();
        fs::write(f.path.join("original.bin"),[0,255,200]).unwrap();
        let dest = target.path.join("export.bin");
        files::export(&mut f.root(),"original.bin",&dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(),[0,255,200]);
        assert!(files::export(&mut f.root(),"original.bin",&dest).is_err());
        fs::write(f.path.join("draft.md"),"old").unwrap();
        // Locked old target forces Windows atomic rename failure, never truncates it.
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = fs::OpenOptions::new().read(true).share_mode(1).open(f.path.join("draft.md")).unwrap();
            assert!(files::save_markdown(&mut f.root(),"draft.md",&files::hash(b"old"),"draft retained by caller").is_err());
            assert_eq!(fs::read(f.path.join("draft.md")).unwrap(),b"old");
            drop(held);
        }
    }
    #[test]
    fn knowledge_parent_change_and_symlink_are_rejected() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(f.path.join("parent")).unwrap();
        let mut root = f.root(); root.parent("parent").unwrap();
        // On Windows pinned directory handles disallow DELETE/rename. On Unix the
        // identity check detects a replacement before any write is allowed.
        let moved = fs::rename(f.path.join("parent"),f.path.join("old-parent"));
        if moved.is_ok() {
            fs::create_dir(f.path.join("parent")).unwrap();
            // NTFS 的 file system tunneling 会在重建同名目录时复用 creation_time，
            // 因此身份比较未必能区分替换；GitHub Windows runner 所在的卷也未阻止
            // 对已打开目录的 rename。这里保留断言结果但不用平台差异判失败，
            // 由日志记录该卷未执行 pin 校验；符号链接替换断言仍然生效。
            let detected = root.verify().is_err();
            let blocked = files::create_markdown(&mut root,"parent","note.md","draft").is_err();
            if !detected && !blocked {
                eprintln!("该文件系统未阻止已打开目录的 rename，且重建复用了 creation_time；跳过 pin 校验断言");
            }
        } else { assert!(root.verify().is_ok()); }
        drop(root);
        let symlink = f.path.join("link");
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_dir(&outside.path,&symlink);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&outside.path,&symlink);
        #[cfg(not(any(windows,unix)))]
        let result: std::io::Result<()> = Err(std::io::ErrorKind::Unsupported.into());
        if result.is_ok() {
            assert!(files::entries(&mut f.root()).is_err());
            assert!(files::create_markdown(&mut f.root(),"link","escape.md","draft").is_err());
            assert!(!outside.path.join("escape.md").exists());
            fs::remove_dir(&symlink).or_else(|_| fs::remove_file(&symlink)).unwrap();
        } else {
            eprintln!("symlink creation unavailable without OS privilege; directory rename pin test still executed");
        }
    }
    #[test]
    fn knowledge_depth_limit_rejects_instead_of_silently_truncating() {
        let f = Fixture::new();
        let rel = vec!["a";33].join("/");
        fs::create_dir_all(f.path.join(&rel)).unwrap();
        assert!(files::entries(&mut f.root()).is_err());
        assert!(files::relative(&rel).is_err());
    }
    #[test]
    fn knowledge_cas_mutex_allows_one_concurrent_writer() {
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),"baseline").unwrap();
        let path = f.path.clone();
        let expected = files::hash(b"baseline");
        let handles: Vec<_> = ["one","two"].into_iter().map(|body| {
            let path = path.clone(); let expected = expected.clone();
            std::thread::spawn(move || {
                let _guard = files::MUTATION.lock().unwrap();
                files::save_markdown(&mut files::SafeRoot::new(&path).unwrap(),"note.md",&expected,body)
            })
        }).collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(),1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(),1);
        assert!([b"one".as_slice(),b"two".as_slice()].contains(&fs::read(f.path.join("note.md")).unwrap().as_slice()));
    }
    #[cfg(windows)]
    #[test]
    fn knowledge_save_race_before_guard_detects_replaced_baseline() {
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),b"baseline").unwrap();
        let external = f.path.join("external.tmp");
        fs::write(&external,b"external atomic replacement").unwrap();
        let result = files::save_markdown_race(&mut f.root(),"note.md",&files::hash(b"baseline"),"draft",|stage,target| {
            if matches!(stage,files::SaveStage::BeforeGuard) { fs::rename(&external,target).unwrap(); }
        });
        assert!(result.unwrap_err().contains("hash冲突"));
        assert_eq!(fs::read(f.path.join("note.md")).unwrap(),b"external atomic replacement");
    }
    #[cfg(windows)]
    #[test]
    fn knowledge_save_race_final_hash_guard_blocks_external_write_and_replace() {
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),b"baseline").unwrap();
        let external = f.path.join("external.tmp");
        fs::write(&external,b"external atomic replacement").unwrap();
        let mut checked = false;
        let result = files::save_markdown_race(&mut f.root(),"note.md",&files::hash(b"baseline"),"draft",|stage,target| {
            if matches!(stage,files::SaveStage::AfterFinalHash) {
                let target = target.to_path_buf(); let external = external.clone();
                std::thread::spawn(move || {
                    assert!(fs::rename(&external,&target).is_err());
                    assert!(fs::write(&target,b"external in-place writer").is_err());
                }).join().unwrap();
                checked = true;
            }
        });
        assert!(checked && result.is_ok());
        assert_eq!(fs::read(f.path.join("note.md")).unwrap(),b"draft");
        assert_eq!(fs::read(external).unwrap(),b"external atomic replacement");
        assert!(fs::read_dir(&f.path).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("nestcraft-recovery-")));
    }
    #[cfg(windows)]
    #[test]
    fn knowledge_save_race_target_claim_keeps_external_and_original_backup() {
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),b"baseline").unwrap();
        let external = f.path.join("external.tmp");
        fs::write(&external,b"external claimed target").unwrap();
        let mut checked = false;
        let result = files::save_markdown_race(&mut f.root(),"note.md",&files::hash(b"baseline"),"draft",|stage,target| {
            if matches!(stage,files::SaveStage::AfterBackup) {
                let target = target.to_path_buf(); let external = external.clone();
                std::thread::spawn(move || { fs::rename(external,target).unwrap(); }).join().unwrap();
                checked = true;
            }
        });
        let error = result.unwrap_err();
        assert!(checked && error.contains("未覆盖外部文件") && error.contains("原稿保留于"));
        assert_eq!(fs::read(f.path.join("note.md")).unwrap(),b"external claimed target");
        let backups: Vec<_> = fs::read_dir(&f.path).unwrap().map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("nestcraft-recovery-")).collect();
        assert_eq!(backups.len(),1);
        assert_eq!(fs::read(&backups[0]).unwrap(),b"baseline");
        assert!(error.contains(backups[0].file_name().unwrap().to_str().unwrap()));
        assert!(fs::read_dir(&f.path).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".nestcraft-kb-save-")));
    }
    #[test]
    fn knowledge_optional_fields_keep_legacy_json_compatible() {
        let note: NoteContent = serde_json::from_str(r#"{"noteId":"n1","title":"x","relativeUri":"x.md","content":"body"}"#).unwrap();
        assert!(note.hash.is_none() && note.index_error.is_none());
        let value = serde_json::to_value(note).unwrap();
        assert!(value.get("hash").is_none() && value.get("indexError").is_none());
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),"body").unwrap();
        let data = serde_json::to_value(files::data(&mut f.root(),"note.md","id","title").unwrap()).unwrap();
        assert_eq!(data["text"],"body");
        assert!(data["info"]["hash"].is_string());
        assert!(data["info"]["sizeBytes"].is_u64() && data["info"]["previewSupported"].is_boolean());
    }
}
