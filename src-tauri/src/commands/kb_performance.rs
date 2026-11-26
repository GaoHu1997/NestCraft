//! CR-055: owner-only, bounded directory snapshots and background metadata tasks.
//! This module never publishes or disables the full-text index.
use super::files;
use crate::{db, models::{new_id, now_ms, KnowledgeHit}};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant, UNIX_EPOCH}};

const MAX_WORKERS: usize = 2;
static BACKGROUND_COUNT: AtomicUsize = AtomicUsize::new(0);
pub(crate) struct BackgroundPermit;
impl Drop for BackgroundPermit { fn drop(&mut self) { BACKGROUND_COUNT.fetch_sub(1,Ordering::AcqRel); } }
pub(crate) fn try_background_permit() -> Result<BackgroundPermit,String> {
    BACKGROUND_COUNT.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|if n<MAX_WORKERS {Some(n+1)} else {None})
        .map(|_|BackgroundPermit).map_err(|_|"BUSY_RETRY: 知识后台任务合计最多两个".into())
}
const PAGE_BYTES: usize = 256 * 1024;
const MAX_PAGE: usize = 200;
const BATCH_BYTES: usize = 128 * 1024;
const CURSOR_TTL: Duration = Duration::from_secs(60);

#[path = "kb_windows.rs"]
pub mod windows;

pub fn close_window(owner: &str) {
    if let Ok(mut state) = runtime().lock() {
        for task in state.tasks.values() { if task.owner == owner && !task.publishing { task.cancel.store(true,Ordering::Release); } }
        state.cursors.retain(|_,cursor|cursor.owner != owner);
        for (search_owner,_,handle) in state.searches.values() { if search_owner == owner { handle.interrupt(); } }
    }
    windows::close_window(owner);
    super::snapshot::close_window(owner);
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String, pub note_id: String, pub title: String, pub relative_uri: String,
    pub is_dir: bool, pub size_bytes: String, pub source_revision: String, pub has_children: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub items: Vec<Entry>, pub directory_revision: String, pub next_cursor: Option<String>,
    pub complete: bool, pub scan_state: String, pub task_id: Option<String>, pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String, pub library_id: String, pub parent_id: String, pub kind: String,
    pub phase: String, pub processed_entries: i64, pub processed_bytes: String,
    pub total_bytes: Option<String>, pub cancel_requested: bool, pub error: Option<String>,
    pub completed_coverage: String, pub updated_at: i64,
}
struct ActiveTask { owner: String, library: String, parent: String, cancel: Arc<AtomicBool>, publishing: bool }
#[derive(Clone)]
struct Cursor { owner: String, library: String, parent: String, generation: String, key: (i64, String, String), touched: Instant }
#[derive(Default)]
struct Runtime { tasks: HashMap<String, ActiveTask>, cursors: HashMap<String, Cursor>, searches: HashMap<String, (String, String, rusqlite::InterruptHandle)> }
static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
fn runtime() -> &'static Mutex<Runtime> { RUNTIME.get_or_init(|| Mutex::new(Runtime::default())) }

pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
    CREATE TABLE IF NOT EXISTS kb_perf_file (
      libraryId TEXT NOT NULL REFERENCES knowledge_library(id) ON DELETE CASCADE,
      id TEXT NOT NULL, noteId TEXT NOT NULL, relativeUri TEXT NOT NULL, isDir INTEGER NOT NULL,
      PRIMARY KEY(libraryId,id), UNIQUE(libraryId,noteId), UNIQUE(libraryId,relativeUri)
    );
    CREATE TABLE IF NOT EXISTS kb_perf_directory (
      libraryId TEXT NOT NULL REFERENCES knowledge_library(id) ON DELETE CASCADE,
      parentId TEXT NOT NULL, activeGeneration TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending', taskId TEXT, taskOwner TEXT, error TEXT,
      PRIMARY KEY(libraryId,parentId)
    );
    CREATE TABLE IF NOT EXISTS kb_perf_entry (
      libraryId TEXT NOT NULL REFERENCES knowledge_library(id) ON DELETE CASCADE,
      parentId TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL, noteId TEXT NOT NULL,
      title TEXT NOT NULL, relativeUri TEXT NOT NULL, kindRank INTEGER NOT NULL,
      sortKey TEXT NOT NULL, sizeBytes TEXT NOT NULL, sourceRevision TEXT NOT NULL,
      PRIMARY KEY(libraryId,parentId,generation,id)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_perf_page ON kb_perf_entry(libraryId,parentId,generation,kindRank,sortKey,id);
    CREATE TABLE IF NOT EXISTS kb_perf_task (
      id TEXT PRIMARY KEY, libraryId TEXT NOT NULL REFERENCES knowledge_library(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, parentId TEXT NOT NULL, kind TEXT NOT NULL, phase TEXT NOT NULL,
      processedEntries INTEGER NOT NULL DEFAULT 0, processedBytes TEXT NOT NULL DEFAULT '0',
      totalBytes TEXT, cancelRequested INTEGER NOT NULL DEFAULT 0, error TEXT,
      completedCoverage TEXT NOT NULL DEFAULT 'none', updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_perf_task_scope ON kb_perf_task(libraryId,owner,updatedAt);
    "#).map_err(|e| e.to_string())
}
pub fn recover_interrupted(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("UPDATE kb_perf_task SET phase='interrupted',error='应用已重启，任务未完成；请重新盘点',completedCoverage='none' WHERE phase IN ('queued','scanning','copying','committing'); UPDATE kb_perf_directory SET state='failed',error='上次目录盘点已中断',taskId=NULL WHERE taskId IN (SELECT id FROM kb_perf_task WHERE phase='interrupted');")
        .map_err(|e| e.to_string())
}
pub(super) fn source_ref(conn: &Connection, library: &str) -> Result<String, String> {
    conn.query_row("SELECT sourceRef FROM knowledge_library WHERE id=?1 AND enabled=1 AND sourceKind IN ('managed-directory','personal-memory')", [library], |r| r.get(0))
        .map_err(|_| "LIBRARY_UNAVAILABLE: 知识库不存在或已停用".into())
}
fn checked_source(conn: &Connection, library: &str, expected: &str) -> Result<(), String> {
    if source_ref(conn, library)? != expected { return Err("SOURCE_CHANGED: 知识库根已改变".into()); }
    Ok(())
}
/// Limited foreground admission, including SQL/serialization; never queue unbounded spawn_blocking work.
pub(super) fn foreground_permit() -> Result<tokio::sync::OwnedSemaphorePermit,String> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(||Arc::new(tokio::sync::Semaphore::new(2))).clone().try_acquire_owned()
        .map_err(|_|"BUSY_RETRY: 知识前台任务繁忙".into())
}
pub(super) async fn blocking<T: Send + 'static>(f: impl FnOnce(Connection) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let permit = foreground_permit()?;
    tokio::task::spawn_blocking(move || { let _permit = permit; f(db::knowledge_connection()?) })
        .await.map_err(|_| "知识后台操作中断".to_string())?
}
fn canonical_parent(conn: &Connection, library: &str, parent: &str) -> Result<String, String> {
    if parent.is_empty() { return Ok(String::new()); }
    conn.query_row("SELECT id FROM kb_perf_file WHERE libraryId=?1 AND (id=?2 OR noteId=?2) AND isDir=1", params![library,parent], |r|r.get(0))
        .map_err(|_| "DIRECTORY_UNKNOWN: 请先盘点父目录".into())
}
fn parent_uri(conn: &Connection, library: &str, parent: &str) -> Result<String, String> {
    if parent.is_empty() { return Ok(String::new()); }
    let rel = conn.query_row("SELECT relativeUri FROM kb_perf_file WHERE libraryId=?1 AND (id=?2 OR noteId=?2) AND isDir=1", params![library,parent], |r| r.get::<_,String>(0))
        .optional().map_err(|e| e.to_string())?.ok_or("DIRECTORY_UNKNOWN: 请先盘点父目录")?;
    files::relative(&rel)?;
    Ok(rel)
}
/// No filesystem traversal. The caller still validates the original through SafeRoot.
pub(super) fn resolve_registered(conn: &Connection, library: &str, id: &str) -> Result<Option<(String,String)>,String> {
    conn.query_row("SELECT relativeUri FROM kb_perf_file WHERE libraryId=?1 AND (id=?2 OR noteId=?2) AND isDir=0", params![library,id], |r| r.get::<_,String>(0))
        .optional().map_err(|e| e.to_string()).and_then(|rel| rel.map(|rel| { files::relative(&rel)?; let title=rel.rsplit('/').next().unwrap_or("").to_string(); Ok((rel,title)) }).transpose())
}
fn task_row(conn: &Connection, owner: &str, library: &str, id: &str) -> Result<Task,String> {
    source_ref(conn, library)?;
    conn.query_row("SELECT id,libraryId,parentId,kind,phase,processedEntries,processedBytes,totalBytes,cancelRequested,error,completedCoverage,updatedAt FROM kb_perf_task WHERE id=?1 AND owner=?2 AND libraryId=?3", params![id,owner,library], |r| Ok(Task {
        id:r.get(0)?,library_id:r.get(1)?,parent_id:r.get(2)?,kind:r.get(3)?,phase:r.get(4)?,processed_entries:r.get(5)?,processed_bytes:r.get(6)?,total_bytes:r.get(7)?,cancel_requested:r.get::<_,i64>(8)?!=0,error:r.get(9)?,completed_coverage:r.get(10)?,updated_at:r.get(11)?
    })).map_err(|_| "TASK_NOT_FOUND: 任务不属于当前窗口和知识库".into())
}
fn terminal(conn: &Connection, id: &str, phase: &str, error: Option<&str>) -> Result<(),String> {
    conn.execute("UPDATE kb_perf_task SET phase=?2,error=?3,updatedAt=?4 WHERE id=?1 AND phase NOT IN ('completed','cancelled','failed','interrupted')",params![id,phase,error,now_ms()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn cancelled(token: &AtomicBool) -> Result<(),String> { if token.load(Ordering::Acquire) { Err("CANCELLED".into()) } else { Ok(()) } }
fn start_scan(conn: &Connection, owner: &str, library: &str, parent: &str) -> Result<Task,String> {
    let source = source_ref(conn,library)?;
    let rel=parent_uri(conn,library,parent)?;
    // Only a bounded number of parent pins, not all descendants.
    let mut root=files::SafeRoot::new(Path::new(&source))?; root.parent(&rel)?;
    let permit=try_background_permit()?;
    let id=new_id("kbscan"); let token=Arc::new(AtomicBool::new(false));
    {
        let mut state=runtime().lock().map_err(|_|"任务锁不可用")?;
        if let Some((existing,task))=state.tasks.iter().find(|(_,t)| t.library==library && t.parent==parent) {
            if task.owner!=owner {return Err("BUSY_RETRY: 目录正由其它窗口盘点".into());}
            let existing=existing.clone(); drop(state); return task_row(conn,owner,library,&existing);
        }
        if state.tasks.len()>=MAX_WORKERS {return Err("BUSY_RETRY: 最多两个知识后台任务".into());}
        state.tasks.insert(id.clone(),ActiveTask {owner:owner.into(),library:library.into(),parent:parent.into(),cancel:token.clone(),publishing:false});
    }
    let setup=(|| {
        let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO kb_perf_task(id,libraryId,owner,parentId,kind,phase,updatedAt) VALUES(?1,?2,?3,?4,'directory','queued',?5)",params![id,library,owner,parent,now_ms()]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO kb_perf_directory(libraryId,parentId,state,taskId,taskOwner) VALUES(?1,?2,'pending',?3,?4) ON CONFLICT(libraryId,parentId) DO UPDATE SET state='pending',taskId=excluded.taskId,taskOwner=excluded.taskOwner,error=NULL",params![library,parent,id,owner]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    })();
    if let Err(e)=setup {runtime().lock().map_err(|_|"任务锁不可用")?.tasks.remove(&id); return Err(e);}
    let initial=task_row(conn,owner,library,&id)?;
    let worker_id=id.clone(); let lib=library.to_string(); let parent=parent.to_string();
    let spawned=std::thread::Builder::new().name("kb-directory".into()).spawn(move || {
        let _permit=permit;
        let result=db::knowledge_connection().and_then(|conn| scan_directory(&conn,&lib,&parent,&rel,&source,&worker_id,&token));
        if let Err(e)=result {
            if let Ok(conn)=db::knowledge_connection() {
                let phase=if e=="CANCELLED" {"cancelled"} else {"failed"};
                let _=terminal(&conn,&worker_id,phase,Some(&e));
                let _=conn.execute("UPDATE kb_perf_directory SET state='failed',error=?4,taskId=NULL WHERE libraryId=?1 AND parentId=?2 AND taskId=?3",params![lib,parent,worker_id,e]);
            }
        }
        if let Ok(mut state)=runtime().lock(){state.tasks.remove(&worker_id);}
    });
    if spawned.is_err(){
        if let Ok(mut state)=runtime().lock(){state.tasks.remove(&id);}
        terminal(conn,&id,"failed",Some("后台线程无法创建"))?;
        conn.execute("UPDATE kb_perf_directory SET state='failed',error='后台线程无法创建',taskId=NULL WHERE taskId=?1",[&id]).map_err(|e|e.to_string())?;
        return Err("后台线程无法创建".into());
    }
    Ok(initial)
}
#[derive(Clone)]
struct Discovered { rel:String, name:String, is_dir:bool, bytes:u64, revision:String }
fn stat_revision(meta:&fs::Metadata)->String {
    let modified=meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_nanos()).unwrap_or(0);
    let created=meta.created().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_nanos()).unwrap_or(0);
    format!("stat:{}:{modified}:{created}",meta.len())
}
fn forbidden_link(meta:&fs::Metadata)->bool {
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt; meta.file_type().is_symlink() || meta.file_attributes()&0x400!=0}
    #[cfg(not(windows))] {meta.file_type().is_symlink()}
}
fn insert_batch(conn:&Connection,library:&str,parent:&str,generation:&str,batch:&[Discovered],count:i64,token:&AtomicBool)->Result<(),String>{
    cancelled(token)?;
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    for item in batch {
        cancelled(token)?;
        let existing:Option<(String,String)>=tx.query_row("SELECT id,noteId FROM kb_perf_file WHERE libraryId=?1 AND relativeUri=?2",params![library,item.rel],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let (id,note_id)=if let Some(row)=existing {row} else {
            let legacy:Option<String>=if item.is_dir {None} else {tx.query_row("SELECT noteId FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2",params![library,item.rel],|r|r.get(0)).optional().map_err(|e|e.to_string())?};
            let note=legacy.unwrap_or_else(||if item.is_dir {files::dir_id(&item.rel)} else {files::file_id(&item.rel)});
            let id=new_id("kbf");
            tx.execute("INSERT INTO kb_perf_file(libraryId,id,noteId,relativeUri,isDir) VALUES(?1,?2,?3,?4,?5)",params![library,id,note,item.rel,item.is_dir as i64]).map_err(|e|format!("IDENTITY_CONFLICT: {e}"))?;
            (id,note)
        };
        tx.execute("INSERT INTO kb_perf_entry(libraryId,parentId,generation,id,noteId,title,relativeUri,kindRank,sortKey,sizeBytes,sourceRevision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![library,parent,generation,id,note_id,item.name,item.rel,if item.is_dir {0i64}else{1i64},item.name.to_lowercase(),item.bytes.to_string(),item.revision]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE kb_perf_task SET phase='scanning',processedEntries=?2,updatedAt=?3 WHERE id=?1",params![generation,count,now_ms()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
fn scan_directory(conn:&Connection,library:&str,parent:&str,rel:&str,source:&str,generation:&str,token:&AtomicBool)->Result<(),String>{
    let mut root=files::SafeRoot::new(Path::new(source))?;
    let directory=root.parent(rel)?;
    let before=fs::metadata(&directory).map_err(|e|e.to_string())?.modified().ok();
    let mut batch=Vec::new(); let mut batch_bytes=0usize; let mut count=0i64;
    for entry in fs::read_dir(&directory).map_err(|_|"DIRECTORY_UNAVAILABLE")? {
        cancelled(token)?;
        let entry=entry.map_err(|_|"DIRECTORY_READ_FAILED")?;
        let name=entry.file_name().into_string().map_err(|_|"文件名不是有效Unicode")?;
        if name==".git" || name=="node_modules" || name.starts_with(".nestcraft-kb-save-"){continue;}
        let uri=files::child_uri(rel,&name)?;
        let meta=fs::symlink_metadata(entry.path()).map_err(|_|"文件状态不可读取")?;
        if forbidden_link(&meta)||(!meta.is_dir()&&!meta.is_file()){return Err("UNSAFE_ENTRY: 拒绝链接/reparse/非普通文件，未发布部分目录".into());}
        batch_bytes+=uri.len()+name.len()+256;
        batch.push(Discovered{rel:uri,name,is_dir:meta.is_dir(),bytes:if meta.is_file(){meta.len()}else{0},revision:stat_revision(&meta)});
        count+=1;
        if batch.len()>=64 || batch_bytes>=BATCH_BYTES {
            checked_source(conn,library,source)?; root.verify()?;
            insert_batch(conn,library,parent,generation,&batch,count,token)?;
            batch.clear();batch_bytes=0;
        }
    }
    if !batch.is_empty(){insert_batch(conn,library,parent,generation,&batch,count,token)?;}
    cancelled(token)?;root.verify()?;checked_source(conn,library,source)?;
    if fs::metadata(&directory).map_err(|_|"目录已变化")?.modified().ok()!=before {return Err("DIRECTORY_CHANGED: 枚举期间目录变化，请重新盘点".into());}
    // Cancellation before this decision wins; after it the small publication finishes.
    {
        let mut state=runtime().lock().map_err(|_|"任务锁不可用")?;
        cancelled(token)?;
        if let Some(task)=state.tasks.get_mut(generation){task.publishing=true;}
    }
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    let changed=tx.execute("UPDATE kb_perf_directory SET activeGeneration=?3,state='ready',error=NULL,taskId=NULL WHERE libraryId=?1 AND parentId=?2 AND taskId=?3",params![library,parent,generation]).map_err(|e|e.to_string())?;
    if changed!=1{return Err("TASK_SUPERSEDED".into());}
    tx.execute("UPDATE kb_perf_task SET phase='completed',processedEntries=?2,completedCoverage='directory',updatedAt=?3 WHERE id=?1",params![generation,count,now_ms()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    // Old rows are reclaimed in bounded transactions, never during publication.
    loop {
        let changed=conn.execute("DELETE FROM kb_perf_entry WHERE rowid IN (SELECT rowid FROM kb_perf_entry WHERE libraryId=?1 AND parentId=?2 AND generation<>?3 LIMIT 128)",params![library,parent,generation]).map_err(|e|e.to_string())?;
        if changed==0{break;}
        if token.load(Ordering::Acquire){break;}
    }
    Ok(())
}
fn list_page(conn:&Connection,owner:&str,library:&str,parent:&str,cursor:Option<&str>,limit:usize)->Result<DirectoryPage,String>{
    source_ref(conn,library)?;
    let state:Option<(String,String,Option<String>,Option<String>,Option<String>)>=conn.query_row("SELECT activeGeneration,state,taskId,taskOwner,error FROM kb_perf_directory WHERE libraryId=?1 AND parentId=?2",params![library,parent],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
    let (generation,scan_state,task,task_owner,error)=if let Some(row)=state{row}else{
        let task=start_scan(conn,owner,library,parent)?;
        return Ok(DirectoryPage{items:vec![],directory_revision:String::new(),next_cursor:None,complete:false,scan_state:"pending".into(),task_id:Some(task.id),error:None});
    };
    // A rescan never makes a partial/new tree visible. Old generation may remain in storage only.
    if scan_state!="ready" {return Ok(DirectoryPage{items:vec![],directory_revision:generation,next_cursor:None,complete:false,scan_state,task_id:if task_owner.as_deref()==Some(owner){task}else{None},error});}
    let key=if let Some(cursor)=cursor {
        let mut runtime=runtime().lock().map_err(|_|"游标锁不可用")?;
        runtime.cursors.retain(|_,c|c.touched.elapsed()<CURSOR_TTL);
        let c=runtime.cursors.get(cursor).ok_or("CURSOR_EXPIRED")?;
        if c.owner!=owner||c.library!=library||c.parent!=parent{return Err("CURSOR_SCOPE_MISMATCH".into());}
        if c.generation!=generation{return Err("DIRECTORY_CHANGED".into());}
        c.key.clone()
    }else{(-1,String::new(),String::new())};
    let limit=limit.clamp(1,MAX_PAGE);
    let mut statement=conn.prepare("SELECT id,noteId,title,relativeUri,kindRank,sizeBytes,sourceRevision,sortKey FROM kb_perf_entry WHERE libraryId=?1 AND parentId=?2 AND generation=?3 AND (kindRank,sortKey,id)>(?4,?5,?6) ORDER BY kindRank,sortKey,id LIMIT ?7").map_err(|e|e.to_string())?;
    let rows=statement.query_map(params![library,parent,generation,key.0,key.1,key.2,(limit+1)as i64],|r|{
        let rank:i64=r.get(4)?;let id:String=r.get(0)?;let sort:String=r.get(7)?;
        Ok((Entry{id:id.clone(),note_id:r.get(1)?,title:r.get(2)?,relative_uri:r.get(3)?,is_dir:rank==0,size_bytes:r.get(5)?,source_revision:r.get(6)?,has_children:rank==0},(rank,sort,id)))
    }).map_err(|e|e.to_string())?;
    let mut items=Vec::new();let mut bytes=512usize;let mut last=None;let mut more=false;
    for row in rows {
        let (entry,key)=row.map_err(|e|e.to_string())?;
        let size=serde_json::to_vec(&entry).map_err(|e|e.to_string())?.len()+1;
        if items.len()>=limit || bytes+size>PAGE_BYTES {more=true;break;}
        bytes+=size;last=Some(key);items.push(entry);
    }
    if more && items.is_empty(){return Err("FIELD_TOO_LARGE".into());}
    let next_cursor=if more {
        let mut runtime=runtime().lock().map_err(|_|"游标锁不可用")?;
        runtime.cursors.retain(|_,c|c.touched.elapsed()<CURSOR_TTL);
        if let Some(previous)=cursor{runtime.cursors.remove(previous);}
        if runtime.cursors.values().filter(|c|c.owner==owner).count()>=32 {return Err("CURSOR_LIMIT".into());}
        let id=new_id("kbcursor");
        runtime.cursors.insert(id.clone(),Cursor{owner:owner.into(),library:library.into(),parent:parent.into(),generation:generation.clone(),key:last.ok_or("游标缺少末项")?,touched:Instant::now()});Some(id)
    }else{None};
    Ok(DirectoryPage{items,directory_revision:generation,next_cursor,complete:!more,scan_state:"ready".into(),task_id:None,error:None})
}

#[tauri::command]
pub async fn kb_list_children(window:tauri::WebviewWindow,library_id:String,parent_id:String,cursor:Option<String>,limit:Option<usize>,request_id:Option<String>)->Result<DirectoryPage,String>{
    let owner=window.label().to_string();
    if request_id.as_ref().map(|s|s.len()>128).unwrap_or(false){return Err("REQUEST_ID_INVALID".into());}
    blocking(move |conn| { let parent=canonical_parent(&conn,&library_id,&parent_id)?; list_page(&conn,&owner,&library_id,&parent,cursor.as_deref(),limit.unwrap_or(MAX_PAGE)) }).await
}
#[tauri::command]
pub async fn kb_scan_start(window:tauri::WebviewWindow,library_id:String,parent_id:String)->Result<Task,String>{
    let owner=window.label().to_string();blocking(move|conn| { let parent=canonical_parent(&conn,&library_id,&parent_id)?; start_scan(&conn,&owner,&library_id,&parent) }).await
}
#[tauri::command]
pub async fn kb_task_status(window:tauri::WebviewWindow,library_id:String,task_id:String)->Result<Task,String>{
    let owner=window.label().to_string();blocking(move|conn|task_row(&conn,&owner,&library_id,&task_id)).await
}
#[tauri::command]
pub async fn kb_task_cancel(window:tauri::WebviewWindow,library_id:String,task_id:String)->Result<Task,String>{
    let owner=window.label().to_string();
    // Token is set directly, before waiting for SQL or foreground permits.
    {
        let state=runtime().lock().map_err(|_|"任务锁不可用")?;
        if let Some(task)=state.tasks.get(&task_id){
            if task.owner!=owner||task.library!=library_id{return Err("TASK_NOT_FOUND".into());}
            if !task.publishing { task.cancel.store(true,Ordering::Release); }
        }
    }
    blocking(move|conn|{
        let task=task_row(&conn,&owner,&library_id,&task_id)?;
        if !["completed","cancelled","failed","interrupted"].contains(&task.phase.as_str()) {
            conn.execute("UPDATE kb_perf_task SET cancelRequested=1 WHERE id=?1 AND owner=?2 AND libraryId=?3",params![task_id,owner,library_id]).map_err(|e|e.to_string())?;
        }
        task_row(&conn,&owner,&library_id,&task_id)
    }).await
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SearchCoverage {state:String,incomplete:bool,freshness:String,metadata_only_count:usize}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SearchResult {hits:Vec<KnowledgeHit>,index_epoch:String,human_only:bool,coverage:SearchCoverage}
#[tauri::command]
pub async fn kb_search_indexed(window:tauri::WebviewWindow,library_id:String,query:String,request_id:String)->Result<SearchResult,String>{
    let owner=window.label().to_string();
    if request_id.is_empty()||request_id.len()>128{return Err("REQUEST_ID_INVALID".into());}
    blocking(move|conn|{
        let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
        let original_source=source_ref(&tx,&library_id)?;
        let snapshot = super::snapshot::active_snapshot(&tx, &library_id)?;
        let epoch = if let Some(info) = snapshot { info.epoch } else {
            let epoch: Option<i64> = tx.query_row("SELECT indexEpoch FROM kb_library_state WHERE libraryId=?1", [&library_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            epoch.unwrap_or(0)
        };
        if epoch==0 {
            tx.commit().map_err(|e|e.to_string())?;
            checked_source(&conn,&library_id,&original_source)?;
            return Ok(SearchResult{hits:vec![],index_epoch:"0".into(),human_only:true,coverage:SearchCoverage{state:"not_indexed".into(),incomplete:true,freshness:"unknown".into(),metadata_only_count:0}});
        }
        let key=format!("{owner}\0{library_id}\0{request_id}");
        {
            let mut state=runtime().lock().map_err(|_|"查询锁不可用")?;
            if state.searches.contains_key(&key){return Err("REQUEST_ID_REUSED".into());}
            state.searches.insert(key.clone(),(owner.clone(),library_id.clone(),conn.get_interrupt_handle()));
        }
        let result=super::search_bounded(&tx,std::slice::from_ref(&library_id),&query,100);
        if let Ok(mut state)=runtime().lock(){state.searches.remove(&key);}
        let (rows,incomplete)=result?;
        tx.commit().map_err(|e|e.to_string())?;
        checked_source(&conn,&library_id,&original_source)?;
        let metadata_only_count=rows.iter().filter(|(_,meta)|*meta).count();
        Ok(SearchResult{hits:rows.into_iter().map(|(h,_)|h).collect(),index_epoch:epoch.to_string(),human_only:true,coverage:SearchCoverage{state:"ready".into(),incomplete,freshness:"unknown".into(),metadata_only_count}})
    }).await
}
#[tauri::command]
pub fn kb_search_cancel(window:tauri::WebviewWindow,library_id:String,request_id:String)->Result<(),String>{
    let owner=window.label();let key=format!("{owner}\0{library_id}\0{request_id}");
    let state=runtime().lock().map_err(|_|"查询锁不可用")?;
    if let Some((_,_,handle))=state.searches.get(&key){handle.interrupt();}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Connection{
        let c=Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,sourceRef TEXT,enabled INTEGER,sourceKind TEXT); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT); INSERT INTO knowledge_library VALUES('lib','unused',1,'managed-directory');").unwrap();
        migrate(&c).unwrap();c
    }
    #[test]
    fn directory_paging_is_complete_scoped_and_generation_checked(){
        let c=fixture();
        c.execute("INSERT INTO kb_perf_directory(libraryId,parentId,activeGeneration,state) VALUES('lib','','g','ready')",[]).unwrap();
        let token=AtomicBool::new(false);
        let input:Vec<Discovered>=(0..10007).map(|i|Discovered{rel:format!("f{i:05}.txt"),name:format!("f{i:05}.txt"),is_dir:false,bytes:5,revision:"v1".into()}).collect();
        for batch in input.chunks(64){insert_batch(&c,"lib","","g",batch,0,&token).unwrap();}
        let mut ids=std::collections::HashSet::new();let mut cursor=None;
        loop{let page=list_page(&c,"w","lib","",cursor.as_deref(),200).unwrap();for e in page.items{assert!(ids.insert(e.id));}cursor=page.next_cursor;if cursor.is_none(){break;}}
        assert_eq!(ids.len(),10007);
        let page=list_page(&c,"w","lib","",None,1).unwrap();let token=page.next_cursor.unwrap();
        assert!(list_page(&c,"other","lib","",Some(&token),1).unwrap_err().contains("SCOPE"));
        c.execute("UPDATE kb_perf_directory SET activeGeneration='g2'",[]).unwrap();
        assert!(list_page(&c,"w","lib","",Some(&token),1).unwrap_err().contains("DIRECTORY_CHANGED"));
    }
    #[test]
    fn registration_is_stable_and_reads_do_not_traverse_filesystem(){
        let c=fixture();let token=AtomicBool::new(false);
        let item=Discovered{rel:"a.pdf".into(),name:"a.pdf".into(),is_dir:false,bytes:5,revision:"v1".into()};
        insert_batch(&c,"lib","","g1",&[item.clone()],1,&token).unwrap();
        let first:String=c.query_row("SELECT id FROM kb_perf_file",[],|r|r.get(0)).unwrap();
        insert_batch(&c,"lib","","g2",&[item],1,&token).unwrap();
        assert_eq!(c.query_row("SELECT id FROM kb_perf_file",[],|r|r.get::<_,String>(0)).unwrap(),first);
        assert_eq!(resolve_registered(&c,"lib",&first).unwrap().unwrap().0,"a.pdf");
        assert!(resolve_registered(&c,"other",&first).unwrap().is_none());
    }
    #[test]
    fn cancellation_and_recovery_never_publish_staging(){
        let c=fixture();let token=AtomicBool::new(true);
        assert!(insert_batch(&c,"lib","","x",&[],0,&token).unwrap_err().contains("CANCELLED"));
        c.execute("INSERT INTO kb_perf_task(id,libraryId,owner,parentId,kind,phase,updatedAt) VALUES('t','lib','w','','directory','scanning',0)",[]).unwrap();
        c.execute("INSERT INTO kb_perf_directory(libraryId,parentId,activeGeneration,state,taskId) VALUES('lib','','old','pending','t')",[]).unwrap();
        recover_interrupted(&c).unwrap();
        assert_eq!(task_row(&c,"w","lib","t").unwrap().phase,"interrupted");
        let page=list_page(&c,"w","lib","",None,200).unwrap();assert_eq!(page.scan_state,"failed");assert_eq!(page.directory_revision,"old");assert!(!page.complete);
        assert!(task_row(&c,"other","lib","t").is_err());
    }
}
