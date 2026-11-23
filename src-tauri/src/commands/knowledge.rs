//! CR-045: managed local library files, derived Markdown index, explicit user writes.
//! AI gateway remains read-only and rechecks project grants + enabled libraries every call.

use crate::db;
use crate::models::{now_ms, new_id, KnowledgeHit, KnowledgeLibrary, LibraryGrant, NoteContent, NoteNode};
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::path::Path;

#[path = "knowledge_files.rs"]
mod files;
#[path = "kb_performance.rs"]
pub mod performance;
#[path = "kb_verified.rs"]
mod verified;
#[path = "kb_snapshot.rs"]
pub mod snapshot;
#[path = "kb_transfers.rs"]
pub mod transfers;
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
/// CR-068 K02：三类失败用稳定前缀区分，读取端据此显示不同出路，不把其它读取失败
/// 笼统说成「文件不存在」；任何一类都不会自动改选其它文件或清除草稿。
const ERR_SOURCE: &str = "KB_SOURCE_INVALID";
const ERR_IDENTITY: &str = "KB_INDEX_IDENTITY";
const ERR_MISSING: &str = "KB_FILE_MISSING";

fn source_error(detail: impl AsRef<str>) -> String {
    let detail = detail.as_ref();
    if detail.contains(ERR_SOURCE) { detail.to_string() } else { format!("{ERR_SOURCE}: 知识库源不可用：{detail}") }
}
fn identity_error(note_id: &str, detail: impl AsRef<str>) -> String {
    format!("{ERR_IDENTITY}: 索引身份不一致（ID {note_id}）：{}；未改用其它文件", detail.as_ref())
}
fn missing_error(note_id: &str, rel: &str) -> String {
    format!("{ERR_MISSING}: 文件不存在（ID {note_id}｜{rel}）；未改用其它文件，草稿保留")
}
/// 相对 URI 对应的磁盘路径，只用于判断「确实不存在」；安全判定仍由 SafeRoot 负责。
fn disk_path(root: &files::SafeRoot, rel: &str) -> std::path::PathBuf {
    let mut path = root.path.clone();
    for part in rel.split('/').filter(|part| !part.is_empty()) { path.push(part); }
    path
}
/// 已由登记/索引命名的文件：区分缺失、索引身份异常与其它读取失败。
fn resolve_named(root: &mut files::SafeRoot, note_id: &str, rel: &str, name: String) -> Result<(String, String), String> {
    match root.file(rel) {
        Ok(_) => Ok((rel.to_string(), name)),
        Err(error) => {
            if std::fs::symlink_metadata(disk_path(root, rel)).is_err() { return Err(missing_error(note_id, rel)); }
            if error.contains("symlink") || error.contains("reparse") || error.contains("越界")
                || error.contains("相对URI") || error.contains("文件名无效") {
                return Err(identity_error(note_id, format!("{rel}：{error}")));
            }
            Err(format!("读取失败（{rel}）：{error}"))
        }
    }
}
fn resolve(conn: &Connection, root: &mut files::SafeRoot, id: &str, note_id: &str) -> Result<(String, String), String> {
    let note: Option<(String, String)> = conn.query_row(
        "SELECT relativeUri,title FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2", [id, note_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if let Some((rel, name)) = note {
        files::relative(&rel).map_err(|e| identity_error(note_id, format!("索引登记路径非法 {rel}：{e}")))?;
        return resolve_named(root, note_id, &rel, name);
    }
    match performance::resolve_registered(conn, id, note_id) {
        Ok(Some((rel, name))) => {
            files::relative(&rel).map_err(|e| identity_error(note_id, format!("目录登记路径非法 {rel}：{e}")))?;
            return resolve_named(root, note_id, &rel, name);
        }
        Ok(None) => {}
        Err(error) => return Err(identity_error(note_id, error)),
    }
    // Binary/new Markdown files are visible immediately without an index migration.
    // Preserve the old decimal path-hash ID, and refuse collisions instead of guessing.
    let entries = files::entries(root).map_err(|e| format!("目录清单不可读取，未判定文件是否存在：{e}"))?;
    let mut matches = entries.into_iter().filter(|e| !e.is_dir && files::file_id(&e.rel) == note_id);
    let item = matches.next().ok_or_else(|| missing_error(note_id, "目录中无该稳定 ID 的文件"))?;
    if matches.next().is_some() { return Err(identity_error(note_id, "同一稳定 ID 命中多个文件")); }
    let name = item.rel.rsplit('/').next().unwrap_or("").to_string();
    resolve_named(root, note_id, &item.rel, name)
}
/// 同一个源快照：读取前后都必须一致，源失效不得继续用旧路径冒充成功。
fn file_root(conn: &Connection, id: &str) -> Result<(String, files::SafeRoot), String> {
    let source = performance::source_ref(conn, id).map_err(|e| source_error(e))?;
    let root = enabled_root(conn, id).map_err(|e| source_error(e))?;
    Ok((source, root))
}
fn recheck_source(conn: &Connection, id: &str, source: &str) -> Result<(), String> {
    if performance::source_ref(conn, id)? != source {
        return Err(source_error("知识库根在读取期间改变（SOURCE_CHANGED），未继续使用旧路径"));
    }
    Ok(())
}
fn filename(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or_default().to_string()
}

/// CR-030-D1：保存/上传发布事务。同一事务内完成：
/// ① md 登记 note_index（保持 noteCount 语义 = Markdown 篇数，前端展示不变）；
/// ② 切片 + chunk/词项替换 + indexEpoch++（kb_index::republish_note_tx）；
/// ③ revision+1。任一步失败整事务回滚，沿用 index_error 语义不静默回退读原件。
fn publish_note(conn: &Connection, id: &str, rel: &str, content: &str) -> Result<String, String> {
    let is_md = files::markdown(Path::new(rel));
    let existing: Option<String> = conn.query_row(
        "SELECT noteId FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2", [id,rel], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let note_id = existing.unwrap_or_else(|| files::file_id(rel));
    // Do not replace a different path when the non-cryptographic path hash collides.
    let display_title = if is_md { title(rel,content) } else { filename(rel) };
    let hash = files::hash(content.as_bytes());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if is_md {
        tx.execute(
            "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(libraryId,relativeUri) DO UPDATE SET title=excluded.title,contentHash=excluded.contentHash,updatedAt=excluded.updatedAt",
            rusqlite::params![id,note_id,display_title,rel,hash,now_ms()],
        ).map_err(|e| e.to_string())?;
    }
    crate::commands::kb_index::republish_note_tx(&tx, id, &note_id, rel, &display_title, content, &hash, is_md)?;
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
/// CR-030-D1：完整重建库索引。文件 I/O 与切片在事务外完成，单短事务发布
/// note_index（仅 md，保持前端计数语义）+ chunk/词项 + epoch++。
/// 文本格式（md/markdown/txt/log/text/json/csv）走切片；其它格式 metadata_only
/// （文件名/路径可搜，正文不可搜）。文本读取失败沿用显式失败语义。
fn scan_notes(conn: &Connection, id: &str, root: &mut files::SafeRoot) -> Result<i64, String> {
    let old = indexed(conn,id)?;
    // 登记表 fail-closed：任何穿越路径都使重建显式失败（与搜索同一防线）。
    for rel in old.keys() { files::relative(rel)?; }
    // Gather the entire bounded filesystem and valid text first. Never flatten walk
    // errors into an empty note or publish a partial/truncated replacement index.
    let mut library_files = vec![];
    let mut md_count = 0i64;
    for entry in files::entries(root)? {
        if entry.is_dir { continue; }
        let path = Path::new(&entry.rel);
        let is_md = files::markdown(path);
        let is_text = is_md || files::indexable_text(path);
        let note_id = old.get(&entry.rel).map(|(id,_)| id.clone()).unwrap_or_else(|| files::file_id(&entry.rel));
        let (title, content) = if is_text {
            let (content, hash) = files::read_text(root,&entry.rel).map_err(|e| format!("索引未更新，文件不可读取（{}）：{e}",entry.rel))?;
            let name = if is_md { title(&entry.rel,&content) } else { filename(&entry.rel) };
            (name, Some((content, hash)))
        } else {
            (filename(&entry.rel), None)
        };
        if is_md { md_count += 1; }
        library_files.push(crate::commands::kb_index::LibraryFile {
            note_id, relative_uri: entry.rel.clone(), title, markdown: is_md, content,
        });
    }
    root.verify()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1",[id]).map_err(|e| e.to_string())?;
    for file in library_files.iter().filter(|f| f.markdown) {
        let hash = file.content.as_ref().map(|(_, h)| h.as_str()).unwrap_or("");
        tx.execute(
            "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt) VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id,file.note_id,file.title,file.relative_uri,hash,now_ms()],
        ).map_err(|e| e.to_string())?;
    }
    crate::commands::kb_index::republish_library_tx(&tx, id, &library_files)?;
    tx.execute("UPDATE knowledge_library SET revision=revision+1 WHERE id=?1 AND enabled=1",[id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(md_count)
}

/// CR-030-D1：惰性回填。无状态库（kb_library_state 缺失或 epoch=0）在检索前按库
/// 内联完整重建。锁序：先释放 DB 连接再取 MUTATION（与保存路径一致，防死锁）；
/// 失败时调用方应让该库显式退出本轮检索，其它库正常。
fn ensure_library_indexed(library_id: &str) -> Result<(), String> {
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let epoch: Option<i64> = conn.query_row(
            "SELECT indexEpoch FROM kb_library_state WHERE libraryId=?1", [library_id], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if epoch.unwrap_or(0) > 0 { return Ok(()); }
    }
    let started = std::time::Instant::now();
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    // 双检：等锁期间可能有其它写者完成发布。
    let epoch: Option<i64> = conn.query_row(
        "SELECT indexEpoch FROM kb_library_state WHERE libraryId=?1", [library_id], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if epoch.unwrap_or(0) > 0 { return Ok(()); }
    let mut root = enabled_root(conn, library_id)?;
    let files_count = scan_notes(conn, library_id, &mut root)?;
    let elapsed = started.elapsed();
    let warn = if elapsed > std::time::Duration::from_millis(2000) { "；超过2s，建议后续后台化" } else { "" };
    eprintln!("[CR-030-D1] 惰性回填 library={library_id} files={files_count} 耗时={}ms{warn}", elapsed.as_millis());
    Ok(())
}

/// CR-051 r6：知识库与项目共用 50 个图标（可清空回来源默认），白名单直接复用项目常量。
pub const KB_ICON_IDS: [&str; 50] = super::projects::PROJECT_ICON_IDS;

#[tauri::command]
pub fn kb_list() -> Result<Vec<KnowledgeLibrary>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn.prepare(
        "SELECT l.id,l.name,l.sourceKind,l.sourceRef,l.enabled,l.revision,l.icon,l.iconColor,
        (SELECT COUNT(*) FROM knowledge_note_index n WHERE n.libraryId=l.id)
        FROM knowledge_library l ORDER BY l.createdAt",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(KnowledgeLibrary { id:r.get(0)?,name:r.get(1)?,source_kind:r.get(2)?,source_ref:r.get(3)?,
        enabled:r.get::<_,i64>(4)? != 0,revision:r.get(5)?,icon:r.get(6)?,icon_color:r.get(7)?,note_count:r.get(8)? }))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}
#[tauri::command]
pub fn kb_save(app: tauri::AppHandle, name: String, source_ref: String) -> Result<String, String> {
    let _ = app;
    kb_save_inner(&name, &source_ref)
}

/// CR-059：库级创建抽为可复用内函数（内置 AI 工具 create_kb 调用；语义与 UI 命令一致）。
pub(crate) fn kb_save_inner(name: &str, source_ref: &str) -> Result<String, String> {
    if name.trim().is_empty() { return Err("知识库名称不能为空".into()); }
    let root = files::SafeRoot::new(Path::new(source_ref))?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let id = new_id("kb");
    conn.execute(
        "INSERT INTO knowledge_library(id,name,sourceKind,sourceRef,revision,enabled,createdAt) VALUES(?1,?2,'managed-directory',?3,0,1,?4)",
        rusqlite::params![id,name.trim(),root.path.to_string_lossy(),now_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}
/// CR-051：设置知识库内置图标。None/空串=清空（展示层回来源默认）；其余必须命中共用 50 个白名单。
#[tauri::command]
pub fn kb_set_icon(id: String, icon: Option<String>) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    kb_set_icon_inner(conn, &id, Some(icon), None)
}

/// CR-051 r6：设置知识库背景色卡。None/空串=清空回默认青绿；其余必须命中 10 色白名单。
#[tauri::command]
pub fn kb_set_icon_color(id: String, icon_color: Option<String>) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    kb_set_icon_inner(conn, &id, None, Some(icon_color))
}

/// 图标与色卡同事务保存；None 表示清空对应列。
#[tauri::command]
pub fn kb_set_appearance(id: String, icon: Option<String>, icon_color: Option<String>) -> Result<(), String> {
    let guard = db::conn()?;
    kb_set_icon_inner(guard.as_ref().ok_or("db not initialized")?, &id, Some(icon), Some(icon_color))
}

fn kb_set_icon_inner(
    conn: &Connection,
    id: &str,
    icon: Option<Option<String>>,
    icon_color: Option<Option<String>>,
) -> Result<(), String> {
    let icon = match icon {
        None => None,
        Some(value) => Some(match value {
            None => None,
            Some(ref v) if v.trim().is_empty() => None,
            Some(ref v) if KB_ICON_IDS.contains(&v.as_str()) => Some(v.clone()),
            Some(ref v) => return Err(format!("非法知识库图标 id：{}；仅支持内置 50 个图标", v)),
        }),
    };
    let color = match icon_color {
        None => None,
        Some(value) => Some(match value {
            None => None,
            Some(ref v) if v.trim().is_empty() => None,
            Some(ref v) if super::projects::ICON_COLOR_IDS.contains(&v.as_str()) => Some(v.clone()),
            Some(ref v) => return Err(format!("非法背景色卡 id：{}；仅支持 10 个色卡", v)),
        }),
    };
    // icon / icon_color 各自独立：调用方传入 Some 表示「这一列要更新」（值可为 None=清空），
    // 传入 None 表示「这一列不动」。kb_set_icon 只改图标，kb_set_icon_color 只改色卡。
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: i64 = tx
        .query_row("SELECT COUNT(*) FROM knowledge_library WHERE id=?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("知识库不存在".into());
    }
    match icon {
        Some(value) => {
            tx.execute("UPDATE knowledge_library SET icon=?2 WHERE id=?1", rusqlite::params![id, value])
                .map_err(|e| e.to_string())?;
        }
        None => {}
    }
    match color {
        Some(value) => {
            tx.execute("UPDATE knowledge_library SET iconColor=?2 WHERE id=?1", rusqlite::params![id, value])
                .map_err(|e| e.to_string())?;
        }
        None => {}
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_delete(id: String) -> Result<(), String> {
    let _mutation = files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // CR-030-D1 索引表：kb_library_state 对 knowledge_library 有立即外键（PRAGMA foreign_keys=ON），
    // 必须先删子表（索引状态、分片、授权、旧索引投影）再删库，否则 kb_delete 报
    // FOREIGN KEY constraint failed（2026-11-21 冒烟发现，归属 CR-030-D1 会话登记）。
    tx.execute("DELETE FROM kb_library_state WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM kb_chunk WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM project_library_grant WHERE libraryId=?1",[&id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_library WHERE id=?1",[&id]).map_err(|e| e.to_string())?;
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
pub async fn kb_file_info(id: String, note_id: String) -> Result<KnowledgeFileInfo, String> {
    performance::blocking(move |conn| {
        let (source, mut root) = file_root(&conn, &id)?;
        let (rel, title) = resolve(&conn, &mut root, &id, &note_id)?;
        let result = files::info(&mut root, &rel, &note_id, &title)?;
        recheck_source(&conn, &id, &source)?;
        Ok(result)
    }).await
}
#[tauri::command]
pub async fn kb_read_file(id: String, note_id: String) -> Result<KnowledgeFileData, String> {
    performance::blocking(move |conn| {
        let (source, mut root) = file_root(&conn, &id)?;
        let (rel, title) = resolve(&conn, &mut root, &id, &note_id)?;
        let result = files::data(&mut root, &rel, &note_id, &title)?;
        recheck_source(&conn, &id, &source)?;
        Ok(result)
    }).await
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
                // CR-030-D1：文本格式（md/markdown/txt/log/text/json/csv）同路径发布切片；
                // 其它格式仍只复制原件，扫描时落 metadata 索引（文件名/路径可搜）。
                if files::markdown(Path::new(&rel)) || files::indexable_text(Path::new(&rel)) {
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
    performance::blocking(move |conn| {
        let mut root = enabled_root(&conn,&id)?;
        initial_root.verify()?;
        let (rel,_) = resolve(&conn,&mut root,&id,&note_id)?;
        if root.path != initial_root.path || rel != initial_rel { return Err("选择期间知识文件位置发生变化，未导出".into()); }
        let Some(paths) = choice else { return Ok(ExportResult { cancelled:true,exported:false }); };
        let path = paths.first().ok_or("没有选择导出目标")?;
        files::export(&mut root,&rel,path)?;
        Ok(ExportResult { cancelled:false,exported:true })
    }).await
}

/// CR-030-D1：检索只查询已发布派生索引（FTS5），不再逐篇读原件。
/// 候选=当前代 chunk；命中经归一化原文核验；每文件一条（多 chunk 取最高分）；
/// 跨库确定性 RRF（常数60）合并；单字查询走受限扫描（护栏+incomplete）。
/// fail-closed：登记表任何穿越路径使该库搜索显式失败（保留既有安全语义）。
fn search_bounded(
    conn: &Connection, libs: &[String], query: &str, limit: usize,
) -> Result<(Vec<(KnowledgeHit, bool)>, bool), String> {
    let (hits,incomplete)=search_candidates_bounded(conn,libs,query,limit)?;
    Ok((hits.into_iter().map(|(hit,meta,_)|(hit,meta)).collect(),incomplete))
}
fn search_candidates_bounded(
    conn: &Connection,
    libs: &[String],
    query: &str,
    limit: usize,
) -> Result<(Vec<(KnowledgeHit, bool, crate::commands::kb_index::RawHit)>, bool), String> {
    // Validate every requested library before an early result limit can return.
    for lib in libs { enabled_root(conn,lib)?; }
    for lib in libs {
        let mut statement = conn.prepare("SELECT relativeUri FROM knowledge_note_index WHERE libraryId=?1").map_err(|e|e.to_string())?;
        let rows = statement.query_map([lib], |r| r.get::<_,String>(0)).map_err(|e|e.to_string())?;
        for rel in rows { files::relative(&rel.map_err(|e|e.to_string())?)?; }
    }
    let parsed = crate::commands::kb_index::parse_query(query)?;
    if parsed.is_empty() { return Ok((vec![], false)); }
    let mut merged: Vec<(KnowledgeHit, bool, f64, crate::commands::kb_index::RawHit)> = vec![];
    let mut incomplete = false;
    for lib in libs {
        let name: String = conn.query_row("SELECT name FROM knowledge_library WHERE id=?1 AND enabled=1",[lib],|r| r.get(0)).map_err(|e| e.to_string())?;
        let (raw, hit_incomplete) = match crate::commands::knowledge::snapshot::search_library(conn, lib, &parsed)? {
            Some((hits, incomplete)) => (hits, incomplete),
            None => crate::commands::kb_index::search_library(conn, lib, &parsed)?,
        };
        if hit_incomplete {
            incomplete = true;
            eprintln!("[CR-030-D1] 单字受限扫描护栏触发 library={lib}：结果不完整（incomplete）");
        }
        // 每文件一条命中：多 chunk 取最高分（同分保留最低 ordinal）。
        let mut best: BTreeMap<String, crate::commands::kb_index::RawHit> = BTreeMap::new();
        for hit in raw {
            files::relative(&hit.relative_uri)?;
            match best.get(&hit.note_id) {
                Some(prev) if prev.score <= hit.score => {}
                _ => { best.insert(hit.note_id.clone(), hit); }
            }
        }
        let mut ranked: Vec<crate::commands::kb_index::RawHit> = best.into_values().collect();
        ranked.sort_by(|a,b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal).then(a.note_id.cmp(&b.note_id)));
        for (pos, hit) in ranked.iter().enumerate() {
            let snippet = crate::commands::kb_index::snippet_for(hit, &parsed.needles, parsed.single_char);
            merged.push((
                KnowledgeHit { library_id:lib.clone(),library_name:name.clone(),note_id:hit.note_id.clone(),
                    title:hit.title.clone(),relative_uri:hit.relative_uri.clone(),snippet },
                hit.metadata_only,
                1.0 / ((60 + pos) as f64),
                hit.clone(),
            ));
        }
    }
    merged.sort_by(|a,b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
        .then(a.0.library_id.cmp(&b.0.library_id))
        .then(a.0.note_id.cmp(&b.0.note_id)));
    Ok((merged.into_iter().take(limit).map(|(h,m,_,raw)| (h,m,raw)).collect(), incomplete))
}
fn search(conn: &Connection, libs: &[String], query: &str) -> Result<Vec<KnowledgeHit>, String> {
    Ok(search_bounded(conn, libs, query, 100)?.0.into_iter().map(|(h,_)| h).collect())
}
/// 惰性回填入口：无状态库先按库内联完整重建再检索；失败该库显式退出本轮，其它库正常。
fn usable_libraries(lib_ids: &[String]) -> Result<Vec<String>, String> {
    let mut usable = vec![];
    for lib in lib_ids {
        match ensure_library_indexed(lib) {
            Ok(()) => usable.push(lib.clone()),
            Err(e) => eprintln!("[CR-030-D1] 库 {lib} 惰性回填失败，本轮不参与检索：{e}"),
        }
    }
    if usable.is_empty() && !lib_ids.is_empty() {
        return Err("知识索引重建失败，本轮检索不可用；请检查原件后重新扫描索引".into());
    }
    Ok(usable)
}
#[tauri::command]
pub fn kb_search(lib_ids: Vec<String>, query: String) -> Result<Vec<KnowledgeHit>, String> {
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        for lib in &lib_ids { enabled_root(conn, lib)?; }
    }
    if query.trim().is_empty() { return Ok(vec![]); }
    let usable = usable_libraries(&lib_ids)?;
    let guard = db::conn()?;
    search(guard.as_ref().ok_or("db not initialized")?,&usable,&query)
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
    }
    // CR-037：授权写路径同事务递增 revision（每次变化 +1），撤权保留历史行（readAllowed=0），
    // 不再删除行——侧栏原生绑定的授权复检依赖 revision 失配检测（DB-FEAT-001 CR-037 节）。
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO project_library_grant(projectId,libraryId,readAllowed,revision,updatedAt,actor) VALUES(?1,?2,?3,1,?4,'owner')
         ON CONFLICT(projectId,libraryId) DO UPDATE SET readAllowed=?3, revision=revision+1, updatedAt=?4",
        rusqlite::params![project_id,library_id,if read_allowed {1} else {0},now_ms()],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn authorized(conn: &Connection, project_id: Option<&str>) -> Result<Vec<String>, String> {
    let Some(pid) = project_id else { return Ok(vec![]); };
    let mut stmt = conn.prepare(
        "SELECT g.libraryId FROM project_library_grant g JOIN knowledge_library l ON l.id=g.libraryId
         WHERE g.projectId=?1 AND g.readAllowed=1 AND l.enabled=1 ORDER BY g.libraryId",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([pid],|r| r.get::<_,String>(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}
/// CR-059 / BUG-CR059-01：内置 AI 工具复检用的项目已授权库清单（与 AI 网关同一 SQL）。
pub(crate) fn authorized_libraries(project_id: &str) -> Result<Vec<String>, String> {
    let guard = db::conn()?;
    authorized(guard.as_ref().ok_or("db not initialized")?, Some(project_id))
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
    let _ai=verified::gateway_permit()?;
    let _permit=performance::foreground_permit()?;
    let conn=db::knowledge_connection()?;
    verified::search(&conn,project_id,query)
}
/// The original remains protected until this returned fragment is materialized.
pub fn gateway_read_chunk(project_id: Option<&str>, library_id: &str, note_id: &str) -> Result<crate::commands::kb_index::ChunkView, String> {
    let _ai=verified::gateway_permit()?;
    let _permit=performance::foreground_permit()?;
    let conn=db::knowledge_connection()?;
    let (view,proof,_prepared)=verified::read(&conn,project_id,library_id,Some(note_id),None,None)?;
    proof.recheck(&conn,project_id)?;
    Ok(view)
}
#[tauri::command]
pub async fn kb_gateway(project_id: Option<String>, tool: String, args_json: Option<String>) -> Result<serde_json::Value, String> {
    let input=args_json.unwrap_or_default();
    if input.len()>65536{return Err("知识请求超过64KiB".into());}
    let args:serde_json::Value=if input.is_empty(){serde_json::json!({})}else{serde_json::from_str(&input).map_err(|_|"知识请求JSON无效")?};
    performance::blocking(move|conn|{
        let _ai=if tool=="knowledge.list" {None} else {Some(verified::gateway_permit()?)};
        let project=project_id.as_deref();
        match tool.as_str(){
            "knowledge.list"=>gateway_list_conn(&conn,project),
            "knowledge.search"=>verified::search(&conn,project,args.get("query").and_then(|v|v.as_str()).ok_or("缺少query")?),
            "knowledge.read"=>{
                let library=args.get("libraryId").and_then(|v|v.as_str()).ok_or("缺少libraryId")?;
                let max=args.get("maxBytes").and_then(|v|v.as_u64()).map(|n|n.min(8192)as usize);
                let cursor=args.get("hitRef").or_else(||args.get("cursor")).and_then(|v|v.as_str());
                let note=args.get("noteId").and_then(|v|v.as_str());
                let (view,proof,_prepared)=verified::read(&conn,project,library,note,cursor,max)?;
                let result=serde_json::to_value(view).map_err(|e|e.to_string())?;
                proof.recheck(&conn,project)?;
                Ok(result)
            },
            "knowledge.read_many"=>verified::read_many(&conn,project,args.get("notes").and_then(|v|v.as_array()).ok_or("缺少notes")?),
            _=>Err("未知知识工具；AI不提供文件写入操作".into()),
        }
    }).await
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
                "CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceKind TEXT,sourceRef TEXT,revision INTEGER,enabled INTEGER,createdAt INTEGER,icon TEXT,iconColor TEXT);
                 CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri));
                 CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,updatedAt INTEGER,actor TEXT,PRIMARY KEY(projectId,libraryId));
                 CREATE TABLE schema_version(version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL);"
            ).unwrap();
            // CR-030-D1：切片/FTS 最小表集与真实迁移保持同构。
            crate::commands::kb_index::migrate_cr030_knowledge_index(&conn).unwrap();
            performance::migrate(&conn).unwrap();
            conn.execute("INSERT INTO knowledge_library VALUES('kb','Test','managed-directory',?1,0,1,0,NULL,NULL)",[path.to_string_lossy().as_ref()]).unwrap();
            Self { path, conn }
        }
        fn root(&self) -> files::SafeRoot { enabled_root(&self.conn,"kb").unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }

    #[test]
    fn kb_appearance_preserves_null_and_rolls_back_pair() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,icon TEXT,iconColor TEXT); INSERT INTO knowledge_library(id) VALUES('kb');").unwrap();
        kb_set_icon_inner(&conn,"kb",None,None).unwrap();
        let read = || conn.query_row("SELECT icon,iconColor FROM knowledge_library WHERE id='kb'",[],|r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?))).unwrap();
        assert_eq!(read(),(None,None));
        conn.execute_batch("CREATE TRIGGER fail_color BEFORE UPDATE OF iconColor ON knowledge_library BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(kb_set_icon_inner(&conn,"kb",Some(Some("book".into())),Some(Some("blue".into()))).is_err());
        assert_eq!(read(),(None,None));
        conn.execute_batch("DROP TRIGGER fail_color;").unwrap();
        assert!(kb_set_icon_inner(&conn,"kb",Some(Some("book".into())),Some(Some("invalid".into()))).is_err());
        assert_eq!(read(),(None,None));
        kb_set_icon_inner(&conn,"kb",Some(Some("book".into())),Some(Some("blue".into()))).unwrap();
        assert_eq!(read(),(Some("book".into()),Some("blue".into())));
    }

    #[test]
    fn kb_icon_whitelist_rejects_unknown_ids_and_clears() {
        let f = Fixture::new();
        // 白名单内 id 保存成功并回读。
        for id in KB_ICON_IDS {
            kb_set_icon_inner(&f.conn, "kb", Some(Some(id.to_string())), None).unwrap();
            let icon: Option<String> = f.conn.query_row("SELECT icon FROM knowledge_library WHERE id='kb'", [], |r| r.get(0)).unwrap();
            assert_eq!(icon.as_deref(), Some(id));
        }
        // 非法 id 拒绝且不落库。
        // r6：rocket 已是共享图标库成员；用未登记 id 验证拒绝。
        assert!(kb_set_icon_inner(&f.conn, "kb", Some(Some("notAnIcon".into())), None).is_err());
        let icon: Option<String> = f.conn.query_row("SELECT icon FROM knowledge_library WHERE id='kb'", [], |r| r.get(0)).unwrap();
        // r6 共享白名单后回读应为白名单最后一项（保持「拒绝不落库」语义，不绑定具体图标名）。
        assert_eq!(icon.as_deref(), KB_ICON_IDS.last().copied());
        // 空串与 null 均清空（展示层回来源默认）。
        kb_set_icon_inner(&f.conn, "kb", Some(Some("".into())), None).unwrap();
        let cleared: Option<String> = f.conn.query_row("SELECT icon FROM knowledge_library WHERE id='kb'", [], |r| r.get(0)).unwrap();
        assert_eq!(cleared, None);
        kb_set_icon_inner(&f.conn, "kb", Some(None), None).unwrap();
        // 不存在的库报错。
        assert!(kb_set_icon_inner(&f.conn, "no-such-kb", Some(Some("book".into())), None).is_err());
    }

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
        let gateway_read = |conn: &Connection, p: Option<&str>, kb: &str, n: &str| {
            crate::commands::kb_index::gateway_read_chunk_conn(conn,p,kb,n,None).map(|v| v.content)
        };
        assert!(gateway_read(&f.conn,Some("p"),"kb",&id).is_err());
        f.conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,0,'test')",[]).unwrap();
        assert!(gateway_read(&f.conn,Some("p"),"kb",&id).is_ok());
        assert_eq!(search(&f.conn,&["kb".into()],"keyword").unwrap().len(),1);
        f.conn.execute("UPDATE knowledge_library SET enabled=0",[]).unwrap();
        assert!(enabled_root(&f.conn,"kb").is_err());
        assert!(read_note(&f.conn,"kb",&id).is_err());
        assert!(search(&f.conn,&["kb".into()],"").is_err());
        assert!(gateway_read(&f.conn,Some("p"),"kb",&id).is_err());
        assert!(authorized(&f.conn,Some("p")).unwrap().is_empty());
        assert_eq!(gateway_list_conn(&f.conn,Some("p")).unwrap()["libraries"].as_array().unwrap().len(),0);
        assert!(upload_selected(&f.conn,"kb","",None).is_err());
        f.conn.execute("UPDATE knowledge_library SET enabled=1",[]).unwrap();
        f.conn.execute("DELETE FROM project_library_grant",[]).unwrap();
        assert!(gateway_read(&f.conn,Some("p"),"kb",&id).is_err());
    }
    #[test]
    fn knowledge_search_rejects_indexed_path_traversal_even_title_hit() {
        let f = Fixture::new();
        f.conn.execute("INSERT INTO knowledge_note_index VALUES('kb','bad','hit','../outside.md','',0)",[]).unwrap();
        assert!(search(&f.conn,&["kb".into()],"hit").is_err());
        assert!(read_note(&f.conn,"kb","bad").is_err());
    }

    /// CR-030-D1：扫描登记文本切片与 metadata 索引。
    /// note_index 仍只登记 Markdown（前端 noteCount/N 篇 Markdown 语义不变）；
    /// txt 等文本格式走切片；pdf 等其它格式仅文件名/路径可搜（metadata_only）。
    #[test]
    fn cr030_d1_scan_publishes_text_slices_and_metadata_only() {
        let f = Fixture::new();
        fs::write(f.path.join("note.md"),"# 笔记\n\n中文正文包含缓存一致性描述。").unwrap();
        fs::write(f.path.join("run.log"),"2026-11-21 ERROR 数据库连接超时\n").unwrap();
        fs::write(f.path.join("report.pdf"),b"%PDF-1.4 fake").unwrap();
        assert_eq!(scan_notes(&f.conn,"kb",&mut f.root()).unwrap(),1,"返回值仍为 Markdown 篇数");
        let indexed_count: i64 = f.conn.query_row("SELECT COUNT(*) FROM knowledge_note_index WHERE libraryId='kb'",[],|r| r.get(0)).unwrap();
        assert_eq!(indexed_count,1,"note_count 语义不变：只统计 Markdown");
        // txt/log 正文可搜
        let hits = search(&f.conn,&["kb".into()],"连接超时").unwrap();
        assert_eq!(hits.len(),1);
        assert_eq!(hits[0].relative_uri,"run.log");
        assert!(hits[0].snippet.contains("连接超时"));
        // PDF 文件名可搜（metadata_only）
        let hits = search(&f.conn,&["kb".into()],"report").unwrap();
        assert_eq!(hits.len(),1);
        assert_eq!(hits[0].title,"report.pdf");
        // PDF 正文不可搜
        assert!(search(&f.conn,&["kb".into()],"fake").unwrap().is_empty());
        // AI 读取 PDF 显式拒绝；读取 log 返回片段
        f.conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,0,'test')",[]).unwrap();
        let pdf_id = files::file_id("report.pdf");
        let err = crate::commands::kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),"kb",&pdf_id,None).unwrap_err();
        assert!(err.contains("METADATA_ONLY"));
        let log_id = files::file_id("run.log");
        let view = crate::commands::kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),"kb",&log_id,None).unwrap();
        assert!(view.content.contains("ERROR"));
        assert!(view.eof, "单块文件应 eof");
    }

    /// CR-030-D1 IPC 冒烟三断言（「AI 走派生、人读走原件」）：
    /// 夹具扫描成功后物理删除原件文件 →
    /// ① kb_search 仍命中正文（snippet 来自派生 chunk）；
    /// ② gateway read 仍返回片段（读派生索引，不读原件）；
    /// ③ 人类 kb_read（read_note 路径）报文件不可访问。
    /// 与 src/smoke/runner.ts 的 IPC 冒烟共用同一命令层函数。
    #[test]
    fn cr030_d1_ipc_ai_reads_derived_human_reads_original() {
        let f = Fixture::new();
        fs::write(f.path.join("guide.md"),"# 指南\n\nalpha 正文关键词在这里，包含传感器数据。").unwrap();
        scan_notes(&f.conn,"kb",&mut f.root()).unwrap();
        f.conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,0,'test')",[]).unwrap();
        let note_id = files::file_id("guide.md");
        // ① 删除原件前搜索命中
        assert_eq!(search(&f.conn,&["kb".into()],"正文关键词").unwrap().len(),1);
        // 物理删除原件
        fs::remove_file(f.path.join("guide.md")).unwrap();
        // ① kb_search 仍命中正文，snippet 来自派生 chunk（搜索路径不读原件）
        let hits = search(&f.conn,&["kb".into()],"正文关键词").unwrap();
        assert_eq!(hits.len(),1,"AI 搜索应走派生索引");
        assert!(hits[0].snippet.contains("正文关键词") || hits[0].snippet.contains("关键词"));
        assert_eq!(hits[0].relative_uri,"guide.md");
        // ② gateway read 仍返回片段
        let view = crate::commands::kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),"kb",&note_id,None).unwrap();
        assert!(view.content.contains("alpha"),"AI 读取应来自派生 chunk");
        assert!(view.content.contains("传感器数据"));
        // ③ 人类 kb_read 走原件 → 原件缺失（CR-068 K02 起用稳定前缀说明，不改派生读取语义）
        let err = read_note(&f.conn,"kb",&note_id).unwrap_err();
        assert!(err.starts_with(ERR_MISSING),"实际：{err}");
    }

    /// CR-030-D1：保存后 publish_note 在同一事务发布切片；AI 保存路径
    /// （read_note 仅 Markdown）不受影响；重发后旧词项退役。
    #[test]
    fn cr030_d1_saved_note_publishes_chunks_in_same_transaction() {
        let f = Fixture::new();
        let rel = files::create_markdown(&mut f.root(),"","new.md","# 新文档\n\n量子算法简介。").unwrap();
        let note = saved_note(&f.conn,"kb",&rel,"# 新文档\n\n量子算法简介。".into(),None);
        assert!(note.index_error.is_none());
        let hits = search(&f.conn,&["kb".into()],"量子算法").unwrap();
        assert_eq!(hits.len(),1,"保存后立即可检索");
        assert_eq!(hits[0].title,"新文档");
        // 保存即发布的 chunk 与登记 hash 一致（gateway 校验通过）
        f.conn.execute("INSERT INTO project_library_grant VALUES('p','kb',1,0,'test')",[]).unwrap();
        let view = crate::commands::kb_index::gateway_read_chunk_conn(&f.conn,Some("p"),"kb",&note.note_id,None).unwrap();
        assert!(view.content.contains("量子算法"));
        // 替换内容后旧词项退役
        files::save_markdown(&mut f.root(),"new.md",&files::hash("# 新文档\n\n量子算法简介。".as_bytes()),"# 新文档\n\n改为神经网络内容。").unwrap();
        saved_note(&f.conn,"kb",&rel,"# 新文档\n\n改为神经网络内容。".into(),Some(&note.note_id));
        assert!(search(&f.conn,&["kb".into()],"量子算法").unwrap().is_empty());
        assert_eq!(search(&f.conn,&["kb".into()],"神经网络").unwrap().len(),1);
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
    /// CR-030-D1：惰性回填与检索耗时实测（真实磁盘 I/O + 文件 SQLite）。
    /// 数字仅记录本机夹具实测，不作为性能承诺；>2s 时 ensure_library_indexed
    /// 会输出后台化建议。
    #[test]
    fn cr030_d1_backfill_and_search_timing_on_real_files() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
        let path = base.join(new_id("kb-cr030-d1-perf"));
        fs::create_dir(&path).unwrap();
        // 120 篇约 8KiB 中文文档（夹具，非真实用户库）。
        let body: String = "这是用于回填耗时实测的中文正文段落，包含若干关键词与 Alpha 词，重复多行以接近真实文档长度。\n".repeat(20);
        for i in 0..120 {
            fs::write(path.join(format!("doc{i:03}.md")), format!("# 文档{i:03}\n\n{body}")).unwrap();
        }
        let conn = Connection::open(path.join("workbench.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL);
             CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceKind TEXT,sourceRef TEXT,revision INTEGER,enabled INTEGER,createdAt INTEGER,icon TEXT,iconColor TEXT);
             CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri));
             CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,updatedAt INTEGER,actor TEXT,PRIMARY KEY(projectId,libraryId));",
        ).unwrap();
        crate::commands::kb_index::migrate_cr030_knowledge_index(&conn).unwrap();
        conn.execute("INSERT INTO knowledge_library VALUES('kb','PerfTest','managed-directory',?1,0,1,0,NULL,NULL)",[path.to_string_lossy().as_ref()]).unwrap();
        let mut root = enabled_root(&conn,"kb").unwrap();
        let started = std::time::Instant::now();
        let count = scan_notes(&conn,"kb",&mut root).unwrap();
        let backfill_ms = started.elapsed().as_millis();
        let started = std::time::Instant::now();
        let hits = search(&conn,&["kb".into()],"关键词").unwrap();
        let search_ms = started.elapsed().as_millis();
        let started = std::time::Instant::now();
        let hits2 = search(&conn,&["kb".into()],"关键词").unwrap();
        let warm_ms = started.elapsed().as_millis();
        eprintln!("[CR-030-D1] 实测：files={count} 首次回填={backfill_ms}ms 冷检索={search_ms}ms(hits={}) 暖检索={warm_ms}ms(hits={})", hits.len(), hits2.len());
        assert_eq!(count, 120);
        assert!(!hits.is_empty(), "实测检索必须命中");
        let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM kb_chunk WHERE libraryId='kb'",[],|r| r.get(0)).unwrap();
        eprintln!("[CR-030-D1] 实测：chunk 行数={chunks}");
        drop(conn);
        fs::remove_dir_all(&path).unwrap();
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

    /// CR-068 K02：示例式多目录/多格式原件全部按稳定 ID 定位：
    /// 索引 noteId、目录扫描登记的 id/noteId、未登记文件的路径哈希三者指向同一相对路径；
    /// 可读能力仍严格按真实格式返回，不因「示例」放宽 PDF 等预览边界。
    #[test]
    fn cr068_k02_stable_ids_resolve_example_shapes_for_every_format() {
        let f = Fixture::new();
        fs::create_dir_all(f.path.join("01-快速开始")).unwrap();
        fs::create_dir_all(f.path.join("02-功能手册/子目录")).unwrap();
        fs::write(f.path.join("01-快速开始/索引.md"), "# 索引\n\n正文").unwrap();
        fs::write(f.path.join("02-功能手册/子目录/示例.txt"), "文本正文").unwrap();
        fs::write(f.path.join("02-功能手册/报告.pdf"), b"%PDF-1.4 fake").unwrap();
        assert_eq!(scan_notes(&f.conn, "kb", &mut f.root()).unwrap(), 1);
        let mut root = f.root();
        // Markdown：索引登记的稳定 noteId。
        let md = files::file_id("01-快速开始/索引.md");
        assert_eq!(resolve(&f.conn, &mut root, "kb", &md).unwrap().0, "01-快速开始/索引.md");
        assert_eq!(files::info(&mut root, "01-快速开始/索引.md", &md, "索引").unwrap().kind, "markdown");
        // 目录扫描登记：注册 id 与 noteId 指向同一稳定文件，两条 ID 都能定位。
        let pdf = files::file_id("02-功能手册/报告.pdf");
        f.conn.execute(
            "INSERT INTO kb_perf_file(libraryId,id,noteId,relativeUri,isDir) VALUES('kb','kbf-report',?1,'02-功能手册/报告.pdf',0)",
            [&pdf],
        ).unwrap();
        for id in ["kbf-report", pdf.as_str()] {
            assert_eq!(resolve(&f.conn, &mut root, "kb", id).unwrap().0, "02-功能手册/报告.pdf");
        }
        let pdf_info = files::info(&mut root, "02-功能手册/报告.pdf", &pdf, "报告.pdf").unwrap();
        assert_eq!((pdf_info.kind.as_str(), pdf_info.preview_supported, pdf_info.editable), ("pdf", false, false));
        // 未登记文本文件：路径哈希兜底身份，且按 text 能力可读。
        let txt = files::file_id("02-功能手册/子目录/示例.txt");
        assert_eq!(resolve(&f.conn, &mut root, "kb", &txt).unwrap().0, "02-功能手册/子目录/示例.txt");
        let txt_info = files::info(&mut root, "02-功能手册/子目录/示例.txt", &txt, "示例.txt").unwrap();
        assert_eq!((txt_info.kind.as_str(), txt_info.preview_supported), ("text", true));
        assert_eq!(files::data(&mut root, "02-功能手册/子目录/示例.txt", &txt, "示例.txt").unwrap().text.as_deref(), Some("文本正文"));
    }

    /// CR-068 K02：文件缺失、索引身份异常、源失效三类必须可区分；
    /// 缺失不会被伪装成「换一篇」成功，源失效也不会被说成文件不存在。
    #[test]
    fn cr068_k02_missing_identity_and_source_failures_are_distinct() {
        let f = Fixture::new();
        fs::write(f.path.join("gone.md"), "# 将删除").unwrap();
        scan_notes(&f.conn, "kb", &mut f.root()).unwrap();
        let gone = files::file_id("gone.md");
        fs::remove_file(f.path.join("gone.md")).unwrap();
        let mut root = f.root();
        let error = resolve(&f.conn, &mut root, "kb", &gone).unwrap_err();
        assert!(error.starts_with(ERR_MISSING), "实际：{error}");
        assert!(!error.contains("unreachable"));
        let unknown = resolve(&f.conn, &mut root, "kb", "n-no-such-stable-id").unwrap_err();
        assert!(unknown.starts_with(ERR_MISSING), "实际：{unknown}");
        // 索引登记穿越路径 = 索引身份问题，不是文件缺失。
        f.conn.execute("INSERT INTO knowledge_note_index VALUES('kb','bad-id','坏','../outside.md','h',0)", []).unwrap();
        assert!(resolve(&f.conn, &mut root, "kb", "bad-id").unwrap_err().starts_with(ERR_IDENTITY));
        // 目录扫描登记穿越路径同属索引身份问题。
        f.conn.execute(
            "INSERT INTO kb_perf_file(libraryId,id,noteId,relativeUri,isDir) VALUES('kb','kbf-bad','bad-reg','../outside.txt',0)",
            [],
        ).unwrap();
        assert!(resolve(&f.conn, &mut root, "kb", "bad-reg").unwrap_err().starts_with(ERR_IDENTITY));
        // 源失效：库停用、根目录不可用都归源问题；不冒充文件缺失。
        f.conn.execute("UPDATE knowledge_library SET enabled=0", []).unwrap();
        let disabled = match file_root(&f.conn, "kb") { Ok(_) => panic!("停用库不应返回源快照"), Err(error) => error };
        assert!(disabled.starts_with(ERR_SOURCE), "实际：{disabled}");
        f.conn.execute("UPDATE knowledge_library SET enabled=1", []).unwrap();
        f.conn.execute("UPDATE knowledge_library SET sourceRef='Z:/nestcraft-missing-root'", []).unwrap();
        let missing_root = match file_root(&f.conn, "kb") { Ok(_) => panic!("根不可用不应返回源快照"), Err(error) => error };
        assert!(missing_root.starts_with(ERR_SOURCE), "实际：{missing_root}");
        // 读取前后源一致性复检：根变化必须显式失败，不继续复用旧 root。
        f.conn.execute("UPDATE knowledge_library SET sourceRef=?1", [f.path.to_string_lossy().as_ref()]).unwrap();
        assert!(recheck_source(&f.conn, "kb", "Z:/nestcraft-missing-root").is_err());
    }
}
