//! CR-055 FEAT-008: bounded immutable library snapshots.
//! Entity/publication implementation follows the reviewed snapshot execution design.
#[path = "kb_tantivy.rs"]
mod tantivy_engine;
#[cfg(test)]
#[path = "kb_tantivy_tests.rs"]
mod formal_tests;
#[cfg(test)]
#[path = "kb_tantivy_bench.rs"]
mod formal_bench;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use sha2::{Digest, Sha256};
use super::{files, performance};
use crate::{db, models::{new_id, now_ms}};
use crate::commands::kb_index::{self, ChunkView, ParsedQuery, RawHit};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant, UNIX_EPOCH}};

const PARSER_VERSION: &str = "stream-text-v1";
const CHUNKER_VERSION: &str = "scalar-line-2048-v1";
const ENCODING_VERSION: &str = "strict-utf8-bom-utf16-keep-eol-v1";
// v2：searchText 只存"下一块开头的 512 字节 lookahead"，正文由 text 列复用；
// v1 存的是"整块正文 + lookahead"，语义不同，必须禁止跨版本复用解析结果。
const CONTEXT_VERSION: &str = "forward-512-owned-start-v2";
#[cfg(test)]
const LEGACY_CONTEXT_VERSION: &str = "forward-512-owned-start-v1";
// NULL deliberately rejects unknown formats instead of guessing their storage layout.
const SEARCH_CONTEXT_SQL: &str = "CASE m.contextVersion WHEN 'forward-512-owned-start-v1' THEN CASE WHEN c.searchText='' THEN c.text ELSE c.searchText END WHEN 'forward-512-owned-start-v2' THEN c.text||c.searchText ELSE NULL END";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const BATCH_TIME_SLICE: Duration = Duration::from_millis(125);
const DISK_WRITE_INTERVAL: u64 = 32 * 1024 * 1024;
const OPTIONS_MANIFEST: &str = "stream-text-v1;chunk=2048;lookahead=512;eol=preserve;heading=512";
fn options_hash() -> String { format!("sha256:{:x}", Sha256::digest(OPTIONS_MANIFEST.as_bytes())) }
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;
// 单行上限独立于批次上限：批次放大到 2 MiB 后若继续用它当行长护栏，护栏就等于失效。
// 单块真实上限来自 Chunker（2048 字节正文 + 512 lookahead + 4 KiB 标题），64 KiB 足以拦住异常字段。
const MAX_SINGLE_ROW_BYTES: usize = 64 * 1024;
const MAX_BATCH_ROWS: usize = 512;
const LEASE_TTL: Duration = Duration::from_secs(60);
// v5：contentless（content=''）让 FTS5 不再保存词项副本（%_content）；
// contentless_delete=1 保留按 rowid 删除能力（GC 与整代回收仍走 DELETE/DROP）；
// detail=full 保留列信息与位置列表：实测 contentless + detail=column 会让 bm25() 恒为 0（相关性排序静默失效），
// 代价：不支持 UPDATE 与短语/NEAR 查询——检索本就是字面 AND + needles 命中核验。
const FTS_DDL: &str = "USING fts5(title_terms, heading_terms, body_terms, bigram_terms, content='', contentless_delete=1, detail=full, tokenize='unicode61 remove_diacritics 0')";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexTask {
    pub id: String, pub library_id: String, pub kind: String, pub phase: String,
    pub processed_files: i64, pub processed_bytes: String, pub total_bytes: Option<String>,
    pub cancel_requested: bool, pub error: Option<String>, pub coverage: String,
    pub snapshot_epoch: Option<String>, pub updated_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub generation: i64, pub epoch: i64, pub created_at: i64, pub scan_started_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub library_id: String, pub note_id: String, pub snapshot_generation: i64,
    pub snapshot_epoch: i64, pub parse_generation: String, pub source_hash: String,
    pub legacy_hash: String, pub relative_uri: String, pub chunk_key: i64,
    pub start_byte: u64, pub end_byte: u64, pub primary_end_byte: u64,
    pub match_start: Option<u64>, pub match_end: Option<u64>, pub metadata_only: bool,
}
#[derive(Clone)]
struct Limits { logical_bytes: u64, disk_bytes: u64, check_space: bool }
impl Default for Limits {
    fn default() -> Self { Self { logical_bytes: 64 * 1024 * 1024 * 1024, disk_bytes: 64 * 1024 * 1024 * 1024, check_space: true } }
}
struct ActiveBuild { owner: String, library: String, id: String, cancel: Arc<AtomicBool> }
struct BuildReservation { cancel:Arc<AtomicBool> }
impl Drop for BuildReservation {fn drop(&mut self){if let Ok(mut rt)=runtime().lock(){if rt.build.as_ref().is_some_and(|b|Arc::ptr_eq(&b.cancel,&self.cancel)){rt.build=None;}}}}
struct Lease { owner: String, library: String, generation: i64, touched: Instant }
#[derive(Default)]
struct Runtime { build: Option<ActiveBuild>, leases: HashMap<String, Lease>, owners: HashMap<String, String>, cursors:HashMap<String,(ReadCursor,Instant)> }
static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
fn runtime() -> &'static Mutex<Runtime> { RUNTIME.get_or_init(|| Mutex::new(Runtime::default())) }
fn lock_runtime() -> Result<std::sync::MutexGuard<'static, Runtime>, String> { runtime().lock().map_err(|_| "SNAPSHOT_RUNTIME_POISONED".into()) }
fn fts_name(generation: i64) -> Result<String, String> {
    if generation <= 0 { return Err("SNAPSHOT_INVALID_GENERATION".into()); }
    Ok(format!("kb_snap_fts_{generation}"))
}

pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
    CREATE TABLE IF NOT EXISTS kb_snap_control (
      libraryId TEXT PRIMARY KEY REFERENCES knowledge_library(id) ON DELETE CASCADE,
      activeGeneration INTEGER, epoch INTEGER NOT NULL DEFAULT 0, sourceFence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kb_snap_generation (
      id INTEGER PRIMARY KEY AUTOINCREMENT, libraryId TEXT NOT NULL,
      state TEXT NOT NULL, baseEpoch INTEGER NOT NULL, baseFence INTEGER NOT NULL,
      sourceRoot TEXT NOT NULL, taskId TEXT NOT NULL UNIQUE, tokenizerVersion TEXT NOT NULL,
      startedAt INTEGER NOT NULL, completedAt INTEGER, publishedEpoch INTEGER,
      manifestDigest TEXT, fileCount INTEGER NOT NULL DEFAULT 0,
      chunkCount INTEGER NOT NULL DEFAULT 0, logicalBytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kb_snap_generation_lib ON kb_snap_generation(libraryId,state,id);
    CREATE TABLE IF NOT EXISTS kb_snap_member (
      libraryId TEXT NOT NULL, generation INTEGER NOT NULL, noteId TEXT NOT NULL,
      relativeUri TEXT NOT NULL, title TEXT NOT NULL, parseGeneration TEXT NOT NULL,
      sourceHash TEXT NOT NULL, legacyHash TEXT NOT NULL, sourceSize TEXT NOT NULL,
      statIdentity TEXT NOT NULL, coverage TEXT NOT NULL, chunkCount INTEGER NOT NULL,
      parserVersion TEXT NOT NULL, chunkerVersion TEXT NOT NULL, encodingVersion TEXT NOT NULL,
      contextVersion TEXT NOT NULL, optionsHash TEXT NOT NULL,
      PRIMARY KEY(libraryId,generation,noteId), UNIQUE(libraryId,generation,relativeUri)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_snap_member_parse ON kb_snap_member(libraryId,noteId,parseGeneration);
    CREATE TABLE IF NOT EXISTS kb_snap_chunk (
      chunkKey INTEGER PRIMARY KEY AUTOINCREMENT, libraryId TEXT NOT NULL, noteId TEXT NOT NULL,
      parseGeneration TEXT NOT NULL, createdGeneration INTEGER NOT NULL,
      ordinal INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      searchText TEXT NOT NULL, startByte INTEGER NOT NULL, endByte INTEGER NOT NULL,
      searchEndByte INTEGER NOT NULL, startLine INTEGER NOT NULL, endLine INTEGER NOT NULL, heading TEXT NOT NULL,
      UNIQUE(libraryId,noteId,parseGeneration,ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_snap_chunk_owner ON kb_snap_chunk(createdGeneration,chunkKey);
    CREATE TABLE IF NOT EXISTS kb_snap_managed_entity (
      libraryId TEXT NOT NULL, generation INTEGER NOT NULL, entityId TEXT NOT NULL,
      cleanupPath TEXT, deleteComplete INTEGER NOT NULL DEFAULT 0,
      cleanupStage TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(libraryId,generation)
    );
    CREATE TABLE IF NOT EXISTS kb_snap_job (
      id TEXT PRIMARY KEY, libraryId TEXT NOT NULL, owner TEXT NOT NULL, requestId TEXT NOT NULL,
      generation INTEGER NOT NULL, phase TEXT NOT NULL, processedFiles INTEGER NOT NULL DEFAULT 0,
      processedBytes TEXT NOT NULL DEFAULT '0', cancelRequested INTEGER NOT NULL DEFAULT 0,
      error TEXT, coverage TEXT NOT NULL DEFAULT 'none', snapshotEpoch TEXT, updatedAt INTEGER NOT NULL,
      UNIQUE(owner,libraryId,requestId)
    );
    "#).map_err(db_error)?;
    for (name,ddl) in [
        ("engineKind","TEXT NOT NULL DEFAULT 'sqlite'"),
        ("engineSchemaVersion","INTEGER NOT NULL DEFAULT 1"),
        ("enginePath","TEXT"),("engineFormat","TEXT"),("engineOptionsHash","TEXT"),("engineSealHash","TEXT")
    ] {
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('kb_snap_generation') WHERE name=?1)",[name],|r|r.get(0)).map_err(db_error)?;
        if !exists {conn.execute_batch(&format!("ALTER TABLE kb_snap_generation ADD COLUMN {name} {ddl}")).map_err(db_error)?;}
    }
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('kb_snap_managed_entity') WHERE name='deleteComplete')",[],|r|r.get(0)).map_err(db_error)?;
    if !exists{conn.execute_batch("ALTER TABLE kb_snap_managed_entity ADD COLUMN deleteComplete INTEGER NOT NULL DEFAULT 0").map_err(db_error)?;}
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('kb_snap_managed_entity') WHERE name='cleanupStage')",[],|r|r.get(0)).map_err(db_error)?;
    if !exists{conn.execute_batch("ALTER TABLE kb_snap_managed_entity ADD COLUMN cleanupStage TEXT NOT NULL DEFAULT 'pending'").map_err(db_error)?;}
    Ok(())
}
pub fn recover_interrupted(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("UPDATE kb_snap_job SET phase='interrupted',error='构建被进程重启中断，旧索引快照保持可用',coverage='none' WHERE phase IN ('queued','discovering','hashing','parsing','building','validating','publishing','cancelling'); UPDATE kb_snap_generation SET state='interrupted' WHERE state IN ('building','sealed');").map_err(db_error)
}
pub fn invalidate_source_tx(conn: &Connection, library_id: &str) -> Result<(), String> {
    conn.execute("INSERT INTO kb_snap_control(libraryId,sourceFence) VALUES(?1,1) ON CONFLICT(libraryId) DO UPDATE SET sourceFence=sourceFence+1", [library_id]).map_err(db_error)?;
    Ok(())
}
pub fn active_snapshot(conn: &Connection, library_id: &str) -> Result<Option<SnapshotInfo>, String> {
    let row = conn.query_row("SELECT g.id,c.epoch,g.completedAt,g.startedAt FROM kb_snap_control c JOIN kb_snap_generation g ON g.id=c.activeGeneration AND g.libraryId=c.libraryId WHERE c.libraryId=?1 AND g.state='active'", [library_id], |r| Ok(SnapshotInfo { generation:r.get(0)?, epoch:r.get(1)?,created_at:r.get(2)?,scan_started_at:r.get(3)? })).optional();
    match row {
        Ok(value) => Ok(value),
        // A database created before the snapshot schema has no snapshot, not an error.
        Err(rusqlite::Error::SqliteFailure(_, message)) if message.as_deref().is_some_and(|m| m.contains("no such table")) => Ok(None),
        Err(error) => Err(db_error(error)),
    }
}
pub fn snapshot_epoch(conn: &Connection, library_id: &str) -> Result<Option<i64>, String> { Ok(active_snapshot(conn,library_id)?.map(|s|s.epoch)) }

fn task_row(conn: &Connection, owner: &str, lib: &str, id: &str) -> Result<IndexTask, String> {
    // Task metadata stays owner-scoped and queryable after disable/root failure; no source is opened.
    conn.prepare_cached("SELECT id,libraryId,phase,processedFiles,processedBytes,cancelRequested,error,coverage,snapshotEpoch,updatedAt FROM kb_snap_job WHERE id=?1 AND owner=?2 AND libraryId=?3").map_err(db_error)?.query_row(params![id,owner,lib],|r| Ok(IndexTask {
        id:r.get(0)?,library_id:r.get(1)?,kind:"index".into(),phase:r.get(2)?,processed_files:r.get(3)?,processed_bytes:r.get(4)?,total_bytes:None,cancel_requested:r.get::<_,i64>(5)?!=0,error:r.get(6)?,coverage:r.get(7)?,snapshot_epoch:r.get(8)?,updated_at:r.get(9)?,
    })).map_err(|_|"TASK_NOT_FOUND: 索引任务不属于当前窗口和库".into())
}
fn owner_for(window: &tauri::WebviewWindow) -> Result<String, String> {
    let label=window.label().to_string();
    let mut rt=lock_runtime()?;
    if let Some(owner)=rt.owners.get(&label) { return Ok(owner.clone()); }
    let owner=new_id("kbwin"); rt.owners.insert(label.clone(),owner.clone()); drop(rt);
    let captured=owner.clone();
    window.on_window_event(move |event| {
        if matches!(event,tauri::WindowEvent::Destroyed) {
            if let Ok(mut rt)=runtime().lock() {
                if rt.owners.get(&label)==Some(&captured) {rt.owners.remove(&label);}
                rt.leases.retain(|_,l|l.owner!=captured);
                if let Some(b)=&rt.build{if b.owner==captured{b.cancel.store(true,Ordering::Release);}}
                rt.cursors.retain(|_,(c,_)|c.owner.as_deref()!=Some(&captured));
            }
        }
    });
    Ok(owner)
}

const READ_BYTES: usize = 64 * 1024;
const CHUNK_BYTES: usize = 2048;
const SEARCH_OVERLAP: usize = 512;
const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) { Err("CANCELLED".into()) } else { Ok(()) }
}
fn db_error(e: rusqlite::Error) -> String { format!("SNAPSHOT_DB: {e}") }
#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceHash { sha256: String, fnv: String, bytes: u64 }
fn hash_reader(reader: &mut impl Read, cancel: &AtomicBool) -> Result<SourceHash, String> {
    hash_reader_progress(reader, cancel, |_| Ok(()))
}
fn hash_reader_progress(reader: &mut impl Read, cancel: &AtomicBool, mut progress: impl FnMut(u64)->Result<(),String>) -> Result<SourceHash, String> {
    let mut buffer = [0u8; READ_BYTES];
    let mut sha = Sha256::new();
    let mut fnv = FNV_OFFSET;
    let mut bytes = 0u64;
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut buffer).map_err(|e| format!("SOURCE_READ: {e}"))?;
        if n == 0 { break; }
        sha.update(&buffer[..n]);
        for b in &buffer[..n] { fnv = (fnv ^ u64::from(*b)).wrapping_mul(FNV_PRIME); }
        bytes = bytes.checked_add(n as u64).ok_or("SOURCE_SIZE_OVERFLOW")?;
        progress(n as u64)?;
    }
    Ok(SourceHash { sha256: format!("sha256:{:x}", sha.finalize()), fnv: format!("fnv1a64:{fnv:016x}"), bytes })
}

/// Strict fixed-buffer decoding. No whole-file String, line array or read_line.
fn decode_reader(
    reader: &mut impl Read, cancel: &AtomicBool,
    mut emit: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(test)] STAGE_STATS.with(|s|s.borrow_mut().decode_calls+=1);
    let mut prefix = [0u8; 3];
    let mut used = 0;
    while used < prefix.len() {
        let n = reader.read(&mut prefix[used..]).map_err(|e| format!("SOURCE_READ: {e}"))?;
        if n == 0 { break; }
        used += n;
    }
    let (encoding, skip) = if prefix[..used].starts_with(&[0xff, 0xfe]) {
        (encoding_rs::UTF_16LE, 2)
    } else if prefix[..used].starts_with(&[0xfe, 0xff]) {
        (encoding_rs::UTF_16BE, 2)
    } else { (encoding_rs::UTF_8, if prefix[..used].starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 }) };
    let mut stream = std::io::Cursor::new(prefix[skip..used].to_vec()).chain(reader);
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut input = [0u8; READ_BYTES];
    let mut output = [0u8; READ_BYTES];
    loop {
        check_cancel(cancel)?;
        let n = stream.read(&mut input).map_err(|e| format!("SOURCE_READ: {e}"))?;
        let last = n == 0;
        let mut offset = 0;
        loop {
            check_cancel(cancel)?;
            let (result, read, written) = decoder.decode_to_utf8_without_replacement(&input[offset..n], &mut output, last);
            offset += read;
            let text = std::str::from_utf8(&output[..written]).map_err(|_| "DECODER_INVALID_UTF8")?;
            if text.contains('\0') { return Err("ENCODING_REQUIRED: 文本含NUL".into()); }
            if !text.is_empty() { emit(text)?; }
            match result {
                encoding_rs::DecoderResult::InputEmpty => break,
                encoding_rs::DecoderResult::OutputFull => {},
                encoding_rs::DecoderResult::Malformed(_, _) => return Err("ENCODING_REQUIRED: 原件含无效编码序列".into()),
            }
        }
        if last { return Ok(()); }
    }
}

#[derive(Debug, Clone)]
struct StreamChunk {
    ordinal: usize, start: u64, end: u64, start_line: usize, end_line: usize,
    text: String, heading: String,
}
struct Chunker {
    buffer: String, offset: u64, ordinal: usize, line: usize, previous_cr: bool,
    heading: String, line_prefix: String, line_overflow: bool, markdown: bool,
}
impl Chunker {
    fn new(markdown: bool) -> Self { Self {
        buffer: String::with_capacity(CHUNK_BYTES + 4), offset: 0, ordinal: 0, line: 1,
        previous_cr: false, heading: String::new(), line_prefix: String::new(), line_overflow: false, markdown,
    } }
    fn feed(&mut self, text: &str, emit: &mut impl FnMut(StreamChunk) -> Result<(), String>) -> Result<(), String> {
        // Input pieces are <=64KiB; draining operates only on the small chunk buffer.
        for c in text.chars() {
            if self.buffer.len() + c.len_utf8() > CHUNK_BYTES { self.flush(emit)?; }
            self.buffer.push(c);
            if self.buffer.len() >= CHUNK_BYTES || (c == '\n' && self.buffer.len() >= CHUNK_BYTES / 2) { self.flush(emit)?; }
        }
        Ok(())
    }
    fn flush(&mut self, emit: &mut impl FnMut(StreamChunk) -> Result<(), String>) -> Result<(), String> {
        if self.buffer.is_empty() { return Ok(()); }
        let text = std::mem::replace(&mut self.buffer, String::with_capacity(CHUNK_BYTES + 4));
        let start_line = self.line;
        let heading = self.heading.clone();
        for c in text.chars() {
            if c == '\r' || c == '\n' {
                if c == '\r' || !self.previous_cr { self.line = self.line.saturating_add(1); }
                if self.markdown && !self.line_overflow {
                    let s = self.line_prefix.trim();
                    let level = s.chars().take_while(|c| *c == '#').count();
                    if (1..=6).contains(&level) && s.as_bytes().get(level) == Some(&b' ') {
                        self.heading = s[level+1..].trim().to_string();
                    }
                }
                self.line_prefix.clear(); self.line_overflow = false;
                self.previous_cr = c == '\r';
            } else {
                self.previous_cr = false;
                if self.line_prefix.len() + c.len_utf8() <= 512 { self.line_prefix.push(c); } else { self.line_overflow = true; }
            }
        }
        let end = self.offset.checked_add(text.len() as u64).ok_or("OFFSET_OVERFLOW")?;
        let chunk = StreamChunk { ordinal: self.ordinal, start: self.offset, end, start_line, end_line: self.line, text, heading };
        emit(chunk)?;
        self.offset = end; self.ordinal += 1;
        Ok(())
    }
}
fn tail_chars(text: &str, budget: usize) -> String {
    let mut start = text.len().saturating_sub(budget);
    while !text.is_char_boundary(start) { start += 1; }
    text[start..].to_string()
}

// Benchmark instrumentation is test-only and thread-local: no production collection or schema changes.
#[cfg(test)]
#[derive(Clone,Copy)]
enum Stage { Hash, Parse, Insert, Validation, Optimize, Publish, Copy, EngineCommit, EngineValidate, EngineSeal }
#[cfg(test)]
struct StageStats { elapsed:[Duration;10], stack:Vec<Stage>, last:Instant, wal_sampled_peak:u64, decode_calls:u64, reused_files:u64 }
#[cfg(test)]
impl Default for StageStats {fn default()->Self{Self{elapsed:[Duration::ZERO;10],stack:Vec::new(),last:Instant::now(),wal_sampled_peak:0,decode_calls:0,reused_files:0}}}
#[cfg(test)]
std::thread_local! {static STAGE_STATS:std::cell::RefCell<StageStats>=std::cell::RefCell::new(StageStats::default());}
#[cfg(test)]
struct StageTimer;
#[cfg(test)]
impl StageTimer {
    fn new(stage:Stage)->Self{
        STAGE_STATS.with(|s|{let mut s=s.borrow_mut();let now=Instant::now();if let Some(parent)=s.stack.last().copied(){let dt=now.duration_since(s.last);s.elapsed[parent as usize]+=dt;}s.last=now;s.stack.push(stage);});Self
    }
}
#[cfg(test)]
impl Drop for StageTimer {fn drop(&mut self){STAGE_STATS.with(|s|{let mut s=s.borrow_mut();let now=Instant::now();if let Some(stage)=s.stack.pop(){let dt=now.duration_since(s.last);s.elapsed[stage as usize]+=dt;}s.last=now;});}}
#[cfg(test)]
fn sample_wal(conn:&Connection){
    if let Some(path)=conn.path(){let bytes=fs::metadata(format!("{path}-wal")).map(|m|m.len()).unwrap_or(0);STAGE_STATS.with(|s|{let mut s=s.borrow_mut();s.wal_sampled_peak=s.wal_sampled_peak.max(bytes);});}
}

#[cfg(test)]
std::thread_local! {static BEFORE_PUBLISH:std::cell::RefCell<Option<Box<dyn FnOnce(&Connection,&BuildSpec)>>> =std::cell::RefCell::new(None);}
#[cfg(test)]
std::thread_local! {static BEFORE_ENGINE_PREPARE:std::cell::RefCell<Option<Box<dyn FnOnce(&Connection,&BuildSpec)>>> =std::cell::RefCell::new(None);}
#[derive(Clone)]
struct BuildSpec { generation:i64, library:String, id:String, root:String, base_epoch:i64, base_fence:i64, engine:Engine }
#[derive(Clone,Copy,Debug,PartialEq)]
enum Engine { Sqlite, Tantivy }
fn engine_for(conn:&Connection,lib:&str,generation:i64)->Result<Engine,String>{
    let (kind,schema,token,format,options):(String,i64,String,Option<String>,Option<String>)=conn.query_row("SELECT engineKind,engineSchemaVersion,tokenizerVersion,engineFormat,engineOptionsHash FROM kb_snap_generation WHERE libraryId=?1 AND id=?2",params![lib,generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(db_error)?;
    match kind.as_str(){
        "sqlite" if schema==1&&token==kb_index::TOKENIZER_VERSION=>Ok(Engine::Sqlite),
        "tantivy" if schema==i64::from(tantivy_engine::SCHEMA_VERSION)&&token==tantivy_engine::TOKENIZER&&format.as_deref()==Some(tantivy_engine::FORMAT)&&options.as_deref()==Some(options_hash().as_str())=>Ok(Engine::Tantivy),
        _=>Err("SNAPSHOT_REBUILD_REQUIRED: 未知引擎或版本".into())
    }
}
fn terminal(conn:&Connection,spec:&BuildSpec,phase:&str,error:&str)->Result<(),String>{
    let tx=conn.unchecked_transaction().map_err(db_error)?;
    tx.execute("UPDATE kb_snap_job SET phase=?2,error=?3,updatedAt=?4 WHERE id=?1 AND phase<>'completed'",params![spec.id,phase,error,now_ms()]).map_err(db_error)?;
    tx.execute("UPDATE kb_snap_generation SET state=?2 WHERE id=?1 AND state IN ('building','sealed')",params![spec.generation,phase]).map_err(db_error)?;
    tx.commit().map_err(db_error)
}
fn ensure_build(conn:&Connection,spec:&BuildSpec,cancel:&AtomicBool)->Result<(),String>{
    check_cancel(cancel)?;
    let (epoch,fence,root,enabled,cancelled):(i64,i64,String,bool,bool)=conn.query_row(
        "SELECT c.epoch,c.sourceFence,l.sourceRef,l.enabled,j.cancelRequested FROM kb_snap_control c JOIN knowledge_library l ON l.id=c.libraryId JOIN kb_snap_job j ON j.id=?2 WHERE c.libraryId=?1",
        params![spec.library,spec.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(db_error)?;
    if cancelled {return Err("CANCELLED".into());}
    if !enabled || root!=spec.root || epoch!=spec.base_epoch || fence!=spec.base_fence {return Err("SOURCE_CHANGED: 构建基线已改变，旧快照保持可用".into());}
    Ok(())
}
fn begin_build(conn:&Connection,owner:&str,library:&str,request:&str)->Result<BuildSpec,String>{
    begin_build_engine(conn,owner,library,request,Engine::Sqlite)
}
fn begin_build_engine(conn:&Connection,owner:&str,library:&str,request:&str,engine:Engine)->Result<BuildSpec,String>{
    let root=performance::source_ref(conn,library)?;
    files::SafeRoot::new(Path::new(&root))?.verify()?;
    let tx=conn.unchecked_transaction().map_err(db_error)?;
    tx.execute("INSERT OR IGNORE INTO kb_snap_control(libraryId) VALUES(?1)",[library]).map_err(db_error)?;
    let existing:i64=tx.query_row("SELECT COUNT(*) FROM kb_snap_generation WHERE libraryId=?1 AND state NOT IN ('collected')",[library],|r|r.get(0)).map_err(db_error)?;
    if existing>=2 {return Err("BUSY_RETRY: 快照保留/回收配额已满，请稍后重试".into());}
    let (epoch,fence):(i64,i64)=tx.query_row("SELECT epoch,sourceFence FROM kb_snap_control WHERE libraryId=?1",[library],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
    let id=new_id("kbindex");
    tx.execute("INSERT INTO kb_snap_generation(libraryId,state,baseEpoch,baseFence,sourceRoot,taskId,tokenizerVersion,startedAt) VALUES(?1,'building',?2,?3,?4,?5,?6,?7)",params![library,epoch,fence,root,id,kb_index::TOKENIZER_VERSION,now_ms()]).map_err(db_error)?;
    let generation=tx.last_insert_rowid();
    let fts=fts_name(generation)?;
    if engine==Engine::Sqlite {
        tx.execute_batch(&format!("CREATE VIRTUAL TABLE {fts} {FTS_DDL}; INSERT INTO {fts}({fts},rank) VALUES('automerge',8);")).map_err(db_error)?;
    } else {
        let path=tantivy_engine::location(conn,library,generation)?;
        tx.execute("UPDATE kb_snap_generation SET engineKind='tantivy',engineSchemaVersion=?6,tokenizerVersion=?2,enginePath=?3,engineFormat=?4,engineOptionsHash=?5 WHERE id=?1",params![generation,tantivy_engine::TOKENIZER,path.to_string_lossy(),tantivy_engine::FORMAT,options_hash(),tantivy_engine::SCHEMA_VERSION]).map_err(db_error)?;
    }
    tx.execute("INSERT INTO kb_snap_job(id,libraryId,owner,requestId,generation,phase,updatedAt) VALUES(?1,?2,?3,?4,?5,'queued',?6)",params![id,library,owner,request,generation,now_ms()]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(BuildSpec {generation,library:library.into(),id,root,base_epoch:epoch,base_fence:fence,engine})
}
#[tauri::command]
pub async fn kb_index_start(window:tauri::WebviewWindow,library_id:String,request_id:String)->Result<IndexTask,String>{
    start_index_task(window,library_id,request_id,Engine::Tantivy).await
}
/// Explicit non-destructive fallback: rebuild a SQLite generation, then the same CAS publication.
#[tauri::command]
pub async fn kb_index_rebuild_sqlite(window:tauri::WebviewWindow,library_id:String,request_id:String)->Result<IndexTask,String>{
    start_index_task(window,library_id,request_id,Engine::Sqlite).await
}
async fn start_index_task(window:tauri::WebviewWindow,library_id:String,request_id:String,engine:Engine)->Result<IndexTask,String>{
    let owner=owner_for(&window)?;
    if request_id.is_empty()||request_id.len()>128 {return Err("INVALID_REQUEST_ID".into());}
    performance::blocking(move |conn| {
        performance::source_ref(&conn,&library_id)?;
        if let Some(id)=conn.prepare_cached("SELECT id FROM kb_snap_job WHERE owner=?1 AND libraryId=?2 AND requestId=?3").map_err(db_error)?.query_row(params![owner,library_id,request_id],|r|r.get::<_,String>(0)).optional().map_err(db_error)? {return task_row(&conn,&owner,&library_id,&id);}
        let mut rt=lock_runtime()?;
        if rt.build.is_some(){return Err("BUSY_RETRY: 全文索引后台槽已占用".into());}
        let permit=performance::try_background_permit()?;
        // Reserve before spawn; a tiny ID is sufficient until preparation finishes.
        let cancel=Arc::new(AtomicBool::new(false));
        rt.build=Some(ActiveBuild{owner:owner.clone(),library:library_id.clone(),id:String::new(),cancel:cancel.clone()});
        drop(rt);
        let setup=(||{
            check_disk(&conn,&Limits::default())?;
            begin_build_engine(&conn,&owner,&library_id,&request_id,engine)
        })();
        let spec=match setup {Ok(s)=>s,Err(e)=>{
            if e.starts_with("BUSY_RETRY: 快照保留"){
                let cleanup_library=library_id.clone();let cleanup_cancel=cancel.clone();
                let cleanup=std::thread::Builder::new().name("kb-snapshot-gc".into()).spawn(move ||{
                    let _permit=permit;let _reservation=BuildReservation{cancel:cleanup_cancel};
                    if let Ok(conn)=db::knowledge_connection(){let _=gc_background(&conn,&cleanup_library,&AtomicBool::new(false));}
                    if let Ok(mut rt)=runtime().lock(){rt.build=None;}
                });
                if cleanup.is_err(){lock_runtime()?.build=None;}
            }else{lock_runtime()?.build=None;}
            return Err(e);
        }};
        if let Some(active)=lock_runtime()?.build.as_mut(){active.id=spec.id.clone();}
        let initial=match task_row(&conn,&owner,&library_id,&spec.id){Ok(task)=>task,Err(e)=>{lock_runtime()?.build=None;let _=terminal(&conn,&spec,"failed",&e);return Err(e);}};
        let spawned_spec=spec.clone();
        let spawned=std::thread::Builder::new().name("kb-fulltext-snapshot".into()).spawn(move || {
            let _permit=permit;
            let _reservation=BuildReservation{cancel:cancel.clone()};
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||db::knowledge_connection().and_then(|conn| build_snapshot(&conn,&spawned_spec,&cancel,&Limits::default())))).unwrap_or_else(|_|Err("INDEX_WORKER_PANIC: 后台构建异常退出，旧快照保留".into()));
            if let Err(e)=result {
                if let Ok(conn)=db::knowledge_connection(){let _=terminal(&conn,&spawned_spec,if e=="CANCELLED"{"cancelled"}else{"failed"},&e);}
            }
            if let Ok(conn)=db::knowledge_connection(){let _=gc_background(&conn,&spawned_spec.library,&AtomicBool::new(false));}
            if let Ok(mut rt)=runtime().lock(){if rt.build.as_ref().map(|b|b.id.as_str())==Some(spawned_spec.id.as_str()){rt.build=None;}}
        });
        if spawned.is_err(){lock_runtime()?.build=None;terminal(&conn,&spec,"failed","后台线程创建失败")?;return Err("INDEX_WORKER_UNAVAILABLE".into());}
        Ok(initial)
    }).await
}
#[tauri::command]
pub async fn kb_index_status(window:tauri::WebviewWindow,library_id:String,task_id:String)->Result<IndexTask,String>{
    let owner=owner_for(&window)?;
    performance::blocking(move |conn|task_row(&conn,&owner,&library_id,&task_id)).await
}
#[tauri::command]
pub async fn kb_index_cancel(window:tauri::WebviewWindow,library_id:String,task_id:String)->Result<IndexTask,String>{
    let owner=owner_for(&window)?;
    {let rt=lock_runtime()?;if let Some(b)=&rt.build{if b.owner==owner&&b.library==library_id&&b.id==task_id{b.cancel.store(true,Ordering::Release);}}}
    performance::blocking(move |conn| {
        let before=task_row(&conn,&owner,&library_id,&task_id)?;
        if ["completed","cancelled","failed","interrupted"].contains(&before.phase.as_str()){return Ok(before);}
        let tx=conn.unchecked_transaction().map_err(db_error)?;
        let changed=tx.execute("UPDATE kb_snap_job SET cancelRequested=1,phase='cancelling',updatedAt=?4 WHERE id=?1 AND owner=?2 AND libraryId=?3 AND phase NOT IN ('completed','cancelled','failed','interrupted')",params![task_id,owner,library_id,now_ms()]).map_err(db_error)?;
        if changed>0{invalidate_source_tx(&tx,&library_id)?;}
        tx.commit().map_err(db_error)?;
        task_row(&conn,&owner,&library_id,&task_id)
    }).await
}
pub fn close_window(label:&str){
    if let Ok(mut rt)=runtime().lock(){if let Some(owner)=rt.owners.remove(label){rt.leases.retain(|_,l|l.owner!=owner);rt.cursors.retain(|_,(c,_)|c.owner.as_deref()!=Some(&owner));if let Some(b)=&rt.build{if b.owner==owner{b.cancel.store(true,Ordering::Release);}}}}
}
struct DiskGuard { last_probe:Instant, written:u64 }
impl DiskGuard {
    fn new()->Self { Self{last_probe:Instant::now(),written:0} }
    fn check(&mut self,conn:&Connection,limits:&Limits,written:u64,force:bool)->Result<(),String>{
        self.written=self.written.saturating_add(written);
        if force||self.written>=DISK_WRITE_INTERVAL||self.last_probe.elapsed()>=PROGRESS_INTERVAL {
            check_disk(conn,limits)?;
            self.written=0;self.last_probe=Instant::now();
        }
        Ok(())
    }
}
fn check_disk(conn:&Connection,limits:&Limits)->Result<(),String>{
    if !limits.check_space && conn.path().filter(|p|!p.is_empty()).is_none(){return Ok(());}
    let db_path=conn.path().filter(|p|!p.is_empty()).ok_or("DISK_PROBE_UNAVAILABLE")?;
    let mut bytes=0u64;
    for suffix in ["","-wal","-shm"] {match fs::metadata(format!("{db_path}{suffix}")){Ok(m)=>bytes=bytes.saturating_add(m.len()),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(format!("DISK_PROBE: {e}"))}}
    if let Ok(root)=tantivy_engine::managed_root(conn){bytes=bytes.checked_add(directory_bytes(&root)?).ok_or("INDEX_SIZE_OVERFLOW")?;}
    if bytes>limits.disk_bytes{return Err("INDEX_DISK_QUOTA: 数据库与WAL达到索引空间预算，旧快照保留".into());}
    if !limits.check_space{return Ok(());}
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name="kernel32")]
        extern "system" {fn GetDiskFreeSpaceExW(path:*const u16,available:*mut u64,total:*mut u64,free:*mut u64)->i32;}
        let parent=Path::new(db_path).parent().ok_or("DISK_PROBE_UNAVAILABLE")?;
        let wide:Vec<u16>=parent.as_os_str().encode_wide().chain(Some(0)).collect();
        let(mut available,mut total,mut free)=(0u64,0u64,0u64);
        let ok=unsafe{GetDiskFreeSpaceExW(wide.as_ptr(),&mut available,&mut total,&mut free)};
        if ok==0{return Err("DISK_PROBE_UNAVAILABLE".into());}
        if available<(2*1024*1024*1024u64).max(total/20){return Err("DISK_LOW_WATERMARK: 磁盘余量不足，旧快照保留".into());}
        Ok(())
    }
    #[cfg(not(windows))] {Err("DISK_PROBE_UNAVAILABLE: 此快照构建尚未验证当前平台空间探测".into())}
}
fn directory_bytes(path:&Path)->Result<u64,String>{
    let _io=tantivy_engine::disk_scan_atomic_guard().map_err(|e|format!("INDEX_DISK_PROBE: {e}"))?;
    for attempt in 0..12 {
        match directory_bytes_once(path){
            Ok(n)=>return Ok(n),
            // Windows delete-pending can be AccessDenied until directory handles close.
            // The failed traversal has fully unwound before retry; persistent ACL errors fail.
            // CI runners (slower FS / realtime scanning) need a longer, growing window than local disks.
            Err(e)if e.kind()==std::io::ErrorKind::PermissionDenied&&attempt<11=>std::thread::sleep(Duration::from_millis(5*(attempt as u64+1))),
            Err(e)=>return Err(format!("INDEX_DISK_PROBE: {e}"))
        }
    }unreachable!()
}
/// 并发删除受管临时目录时，Windows delete-pending 会让条目表现为 NotFound 或
/// AccessDenied(ERROR_ACCESS_DENIED → PermissionDenied)。这类瞬时子条目跳过即可；
/// 根路径的持久 ACL 错误仍返回 Err，由 directory_bytes 重试耗尽后 fail-closed。
fn transient_entry(e:&std::io::Error)->bool{
    e.kind()==std::io::ErrorKind::NotFound||e.kind()==std::io::ErrorKind::PermissionDenied
}
fn directory_bytes_once(path:&Path)->std::io::Result<u64>{
    let m=match fs::symlink_metadata(path){Ok(m)=>m,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(0),Err(e)=>return Err(e)};
    if unsafe_entry(&m)||!m.is_dir(){return Err(std::io::Error::other("INDEX_PATH_UNSAFE"));}
    let entries=match fs::read_dir(path){Ok(entries)=>entries,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(0),Err(e)=>return Err(e)};
    let mut total=0u64;
    for entry in entries{
        let entry=match entry{Ok(e)=>e,Err(e)if transient_entry(&e)=>continue,Err(e)=>return Err(e)};
        let m=match fs::symlink_metadata(entry.path()){Ok(m)=>m,Err(e)if transient_entry(&e)=>continue,Err(e)=>return Err(e)};
        if unsafe_entry(&m)||(!m.is_dir()&&!m.is_file()){return Err(std::io::Error::other("INDEX_PATH_UNSAFE"));}
        let size=if m.is_dir(){
            match directory_bytes_once(&entry.path()){Ok(n)=>n,Err(e)if transient_entry(&e)=>0,Err(e)=>return Err(e)}
        }else{m.len()};
        total=total.checked_add(size).ok_or_else(||std::io::Error::other("INDEX_SIZE_OVERFLOW"))?;
    }Ok(total)
}
fn unsafe_entry(meta:&fs::Metadata)->bool{
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;meta.file_type().is_symlink()||meta.file_attributes()&0x400!=0}
    #[cfg(not(windows))]{meta.file_type().is_symlink()}
}
fn stat_token(meta:&fs::Metadata)->String{
    let modified=meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_nanos()).unwrap_or(0);
    let created=meta.created().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_nanos()).unwrap_or(0);
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;return format!("{}:{modified}:{created}:{}:{}",meta.len(),meta.dev(),meta.ino());}
    #[cfg(not(unix))]{format!("{}:{modified}:{created}",meta.len())}
}
fn walk_files(root_path:&Path,relative:&str,depth:usize,cancel:&AtomicBool,visit:&mut impl FnMut(&str)->Result<(),String>)->Result<(),String>{
    check_cancel(cancel)?;
    if depth>32{return Err("DEPTH_UNSUPPORTED: 库目录超过32层，未发布部分索引".into());}
    let mut root=files::SafeRoot::new(root_path)?;
    let path=root.parent(relative)?;
    let before=fs::metadata(&path).map_err(|e|e.to_string())?.modified().ok();
    for entry in fs::read_dir(&path).map_err(|e|format!("DIRECTORY_READ: {e}"))?{
        check_cancel(cancel)?;
        let entry=entry.map_err(|e|e.to_string())?;
        let name=entry.file_name().into_string().map_err(|_|"PATH_ENCODING_INVALID")?;
        // These exclusions match the existing knowledge directory scanner.
        if name==".git"||name=="node_modules"||name.starts_with(".nestcraft-kb-save-"){continue;}
        let rel=files::child_uri(relative,&name)?;
        if rel.len()>16*1024{return Err("PATH_TOO_LARGE".into());}
        let meta=fs::symlink_metadata(entry.path()).map_err(|e|e.to_string())?;
        if unsafe_entry(&meta){return Err("UNSAFE_ENTRY: 拒绝symlink/reparse".into());}
        if meta.is_dir(){walk_files(root_path,&rel,depth+1,cancel,visit)?;}else if meta.is_file(){visit(&rel)?;}else{return Err("UNSAFE_ENTRY: 非普通文件".into());}
    }
    root.verify()?;
    if fs::metadata(path).map_err(|e|e.to_string())?.modified().ok()!=before{return Err("SOURCE_CHANGED: 扫描期间目录变化".into());}
    Ok(())
}

struct PendingRow { key:Option<i64>, chunk:StreamChunk, search:String, kind:&'static str, terms:kb_index::ChunkTerms }
struct Builder<'a> {
    conn:&'a Connection, spec:&'a BuildSpec, cancel:&'a AtomicBool, limits:&'a Limits,
    fts:String, pending:Vec<PendingRow>, pending_bytes:usize, logical:u64,
    processed:u64, files:i64, chunks:i64, last_progress:Instant, disk:DiskGuard,
    note:String, parse:String, title:String, relative:String,
    // v4：title/heading 词项在同一文件的各 chunk 间完全一致，按 (title, heading) 缓存，避免逐块重算。
    term_cache:Option<(String,String,String)>,
    engine_writer:Option<tantivy_engine::Writer>, source_hash:Option<SourceHash>,
}
impl<'a> Builder<'a>{
    fn phase(&mut self,phase:&str,force:bool)->Result<(),String>{
        if force||self.last_progress.elapsed()>=PROGRESS_INTERVAL{
            ensure_build(self.conn,self.spec,self.cancel)?;
            self.write_progress(self.conn,phase,self.files)?;
            self.last_progress=Instant::now();
        }
        self.disk.check(self.conn,self.limits,0,false)
    }
    fn write_progress(&self,conn:&Connection,phase:&str,files:i64)->Result<(),String>{
        conn.prepare_cached("UPDATE kb_snap_job SET phase=?2,processedFiles=?3,processedBytes=?4,updatedAt=?5 WHERE id=?1").map_err(db_error)?
            .execute(params![self.spec.id,phase,files,self.processed.to_string(),now_ms()]).map_err(db_error)?;
        Ok(())
    }
    /// title/heading 词项只依赖文件级信息与该块 heading；同一 (title, heading) 直接复用。
    fn heading_terms(&mut self, heading:&str)->(String,String){
        if let Some((h,tv,hv))=self.term_cache.as_ref(){
            if h==heading{return (tv.clone(),hv.clone());}
        }
        let tv=self.term_cache.as_ref().map(|(_,tv,_)|tv.clone()).unwrap_or_else(||kb_index::title_terms_for(&self.title,&self.relative));
        let hv=kb_index::heading_terms_for(heading);
        self.term_cache=Some((heading.to_string(),tv.clone(),hv.clone()));
        (tv,hv)
    }
    /// `lookahead` 是下一块开头的 SEARCH_OVERLAP 字节（最后一块为空串），正文本身在 `chunk.text`。
    /// 检索文本 = 正文 + lookahead；但只把 lookahead 落盘，正文靠 text 列复用，省掉一份正文副本。
    fn push(&mut self,key:Option<i64>,chunk:StreamChunk,lookahead:String,kind:&'static str)->Result<(),String>{
        check_cancel(self.cancel)?;
        self.phase("building",false)?;
        let (title_terms,heading_terms)=self.heading_terms(&chunk.heading);
        let full:std::borrow::Cow<str>=if lookahead.is_empty(){std::borrow::Cow::Borrowed(chunk.text.as_str())}else{std::borrow::Cow::Owned(format!("{}{}",chunk.text,lookahead))};
        let (body,bigram)=kb_index::body_terms_for(&full);
        let terms=kb_index::ChunkTerms{title:title_terms,heading:heading_terms,body,bigram};
        let bytes=full.len()+terms.title.len()+terms.heading.len()+terms.body.len()+terms.bigram.len()+chunk.heading.len()+self.relative.len()+self.title.len()+256;
        if bytes>MAX_SINGLE_ROW_BYTES{return Err("INDEX_FIELD_TOO_LARGE".into());}
        if !self.pending.is_empty()&&(self.pending.len()>=MAX_BATCH_ROWS||self.pending_bytes+bytes>MAX_BATCH_BYTES){self.flush()?;}
        self.logical=self.logical.checked_add(bytes as u64).ok_or("INDEX_SIZE_OVERFLOW")?;
        if self.logical>self.limits.logical_bytes{return Err("INDEX_LOGICAL_QUOTA: 索引载荷超限，旧快照保留".into());}
        self.pending_bytes+=bytes;
        self.pending.push(PendingRow{key,chunk,search:lookahead,kind,terms});
        Ok(())
    }
    fn flush(&mut self)->Result<(),String>{
        if self.pending.is_empty(){return Ok(());}
        #[cfg(test)] let _timer=StageTimer::new(Stage::Insert);
        let fts_sql=format!("INSERT INTO {}(rowid,title_terms,heading_terms,body_terms,bigram_terms) VALUES(?1,?2,?3,?4,?5)",self.fts);
        let mut after=0;
        while after<self.pending.len(){
            ensure_build(self.conn,self.spec,self.cancel)?;
            self.disk.check(self.conn,self.limits,0,false)?;
            let started=Instant::now();
            let tx=self.conn.unchecked_transaction().map_err(db_error)?;
            let mut count=0;let mut written=0u64;
            {
                let mut chunk_insert=tx.prepare_cached("INSERT INTO kb_snap_chunk(libraryId,noteId,parseGeneration,createdGeneration,ordinal,kind,text,searchText,startByte,endByte,searchEndByte,startLine,endLine,heading) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)").map_err(db_error)?;
                let mut fts_insert=if self.spec.engine==Engine::Sqlite{Some(tx.prepare_cached(&fts_sql).map_err(db_error)?)}else{None};
                for row in &self.pending[after..] {
                    check_cancel(self.cancel)?;
                    let key=if let Some(key)=row.key {key}else{
                        chunk_insert.execute(params![self.spec.library,self.note,self.parse,self.spec.generation,row.chunk.ordinal as i64,row.kind,if self.spec.engine==Engine::Sqlite{row.chunk.text.as_str()}else{""},if self.spec.engine==Engine::Sqlite{row.search.as_str()}else{""},row.chunk.start as i64,row.chunk.end as i64,(row.chunk.end+row.search.len() as u64)as i64,row.chunk.start_line as i64,row.chunk.end_line as i64,row.chunk.heading]).map_err(db_error)?;
                        tx.last_insert_rowid()
                    };
                    if let Some(fts_insert)=fts_insert.as_mut(){fts_insert.execute(params![key,row.terms.title,row.terms.heading,row.terms.body,row.terms.bigram]).map_err(db_error)?;}
                    if let Some(writer)=self.engine_writer.as_ref(){
                        let hash=self.source_hash.as_ref().ok_or("INDEX_SOURCE_IDENTITY_MISSING")?;
                        let meta=tantivy_engine::Meta::new(self.spec,&self.note,&self.parse,&self.relative,&self.title,hash,key,&row.chunk,&row.search,row.kind);
                        writer.add(&meta,&row.chunk.text,&row.search,&row.terms)?;
                    }
                    written=written.saturating_add((row.chunk.text.len()+row.search.len()+row.terms.title.len()+row.terms.heading.len()+row.terms.body.len()+row.terms.bigram.len()+256)as u64);
                    count+=1;
                    // Bound active work between visible heartbeats; individual SQLite I/O is not preemptible.
                    if started.elapsed()>=BATCH_TIME_SLICE {break;}
                }
            }
            self.write_progress(&tx,"building",self.files)?;
            tx.commit().map_err(db_error)?;
            #[cfg(test)] sample_wal(self.conn);
            self.last_progress=Instant::now();self.chunks+=count as i64;after+=count;
            self.disk.check(self.conn,self.limits,written,false)?;
            std::thread::yield_now();
        }
        self.pending.clear();self.pending_bytes=0;
        Ok(())
    }
    fn copy_parse(&mut self,generation:i64,parse:&str,reuse_keys:bool)->Result<usize,String>{
        #[cfg(test)] let _timer=StageTimer::new(Stage::Copy);
        let lease=ReadLease::new(self.conn,&self.spec.library,generation)?;
        let mut after=-1i64;let mut count=0;
        loop {
            check_cancel(self.cancel)?;lease.renew(self.conn,&self.spec.library,generation)?;
            let rows={
                let mut stmt=self.conn.prepare_cached("SELECT chunkKey,ordinal,startByte,endByte,startLine,endLine,text,heading,searchText,kind FROM kb_snap_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND ordinal>?4 ORDER BY ordinal LIMIT 32").map_err(db_error)?;
                let mapped=stmt.query_map(params![self.spec.library,self.note,parse,after],|r|Ok((r.get::<_,i64>(0)?,StreamChunk{ordinal:r.get::<_,i64>(1)?as usize,start:r.get::<_,i64>(2)?as u64,end:r.get::<_,i64>(3)?as u64,start_line:r.get::<_,i64>(4)?as usize,end_line:r.get::<_,i64>(5)?as usize,text:r.get(6)?,heading:r.get(7)?},r.get::<_,String>(8)?,r.get::<_,String>(9)?))).map_err(db_error)?;
                mapped.collect::<Result<Vec<_>,_>>().map_err(db_error)?
            };
            if rows.is_empty(){break;}
            for (key,chunk,search,kind)in rows {
                if chunk.ordinal!=count{return Err("INDEX_REUSE_MAPPING_MISMATCH".into());}
                after=chunk.ordinal as i64;self.push(if reuse_keys{Some(key)}else{None},chunk,search,if kind=="metadata"{"metadata"}else{"body"})?;count+=1;
                lease.renew(self.conn,&self.spec.library,generation)?;
            }
        }
        Ok(count)
    }
    fn copy_tantivy_parse(&mut self,generation:i64,parse:&str)->Result<usize,String>{
        #[cfg(test)] let _timer=StageTimer::new(Stage::Copy);
        let conn=self.conn;let lib=self.spec.library.clone();let note=self.note.clone();let cancel=self.cancel;
        tantivy_engine::copy_member(conn,&lib,generation,&note,parse,cancel,|m,primary,suffix|{
            self.push(None,StreamChunk{ordinal:m.ordinal,start:m.start,end:m.end,start_line:m.start_line,end_line:m.end_line,text:primary,heading:m.heading.clone()},suffix,if m.kind=="metadata"{"metadata"}else{"body"})
        })
    }
    fn file(&mut self,relative:&str)->Result<(),String>{
        self.flush()?;self.phase("hashing",false)?;
        self.term_cache=None; // pending is empty: the next file owns a fresh title/heading cache.
        let mut root=files::SafeRoot::new(Path::new(&self.spec.root))?;
        let mut file=files::open_snapshot(&mut root,relative)?;
        let initial_stat=stat_token(&file.metadata().map_err(|e|e.to_string())?);
        let cancel=self.cancel;
        let hash={
            #[cfg(test)] let _timer=StageTimer::new(Stage::Hash);
            hash_reader_progress(&mut file,cancel,|n|{self.processed=self.processed.checked_add(n).ok_or("SOURCE_SIZE_OVERFLOW")?;self.phase("hashing",false)})?
        };
        self.source_hash=Some(hash.clone());
        let legacy:Option<(String,String)>=self.conn.prepare_cached("SELECT noteId,title FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2").map_err(db_error)?.query_row(params![self.spec.library,relative],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
        let registered:Option<String>=self.conn.prepare_cached("SELECT noteId FROM kb_perf_file WHERE libraryId=?1 AND relativeUri=?2 AND isDir=0").map_err(db_error)?.query_row(params![self.spec.library,relative],|r|r.get(0)).optional().map_err(db_error)?;
        self.note=legacy.as_ref().map(|x|x.0.clone()).or(registered).unwrap_or_else(||files::file_id(relative));
        self.title=legacy.map(|x|x.1).unwrap_or_else(||relative.rsplit('/').next().unwrap_or(relative).to_string());
        if self.title.len()>4096{return Err("INDEX_TITLE_TOO_LARGE".into());}
        self.relative=relative.to_string();
        let is_text=files::markdown(Path::new(relative))||files::indexable_text(Path::new(relative));
        // Only existing stable note identities are reused; no new move mapping.
        let reusable:Option<(i64,String,i64)>=self.conn.prepare_cached("SELECT m.generation,m.parseGeneration,m.chunkCount FROM kb_snap_member m JOIN kb_snap_control c ON c.libraryId=m.libraryId AND c.activeGeneration=m.generation WHERE m.libraryId=?1 AND m.noteId=?2 AND m.sourceHash=?3 AND m.legacyHash=?4 AND m.sourceSize=?5 AND m.parserVersion=?6 AND m.chunkerVersion=?7 AND m.encodingVersion=?8 AND m.contextVersion=?9 AND m.optionsHash=?10 AND m.coverage=?11").map_err(db_error)?.query_row(params![self.spec.library,self.note,hash.sha256,hash.fnv,hash.bytes.to_string(),PARSER_VERSION,CHUNKER_VERSION,ENCODING_VERSION,CONTEXT_VERSION,options_hash(),if is_text{"text"}else{"metadata"}],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_error)?;
        let reusable=match reusable{
            Some((generation,parse,chunks))=>match engine_for(self.conn,&self.spec.library,generation){
                Ok(engine)=>Some((generation,parse,chunks,engine)),
                Err(e)if e.starts_with("SNAPSHOT_REBUILD_REQUIRED")=>None,
                Err(e)=>return Err(e)
            },
            None=>None
        };
        let count=if let Some((generation,parse,expected,engine))=reusable {
            self.parse=if engine==Engine::Sqlite&&self.spec.engine==Engine::Sqlite{parse.clone()}else{new_id("parse")};
            let count=match engine{
                Engine::Sqlite=>self.copy_parse(generation,&parse,self.spec.engine==Engine::Sqlite)?,
                Engine::Tantivy=>self.copy_tantivy_parse(generation,&parse)?
            };
            if expected<1||count as i64!=expected{return Err("INDEX_REUSE_COUNT_MISMATCH".into());}
            #[cfg(test)] STAGE_STATS.with(|s|s.borrow_mut().reused_files+=1);
            count
        }else{
            self.parse=new_id("parse");
            if is_text {
                #[cfg(test)] let _timer=StageTimer::new(Stage::Parse);
                self.phase("parsing",false)?;
                file.seek(SeekFrom::Start(0)).map_err(|e|e.to_string())?;
                let mut chunker=Chunker::new(files::markdown(Path::new(relative)));
                let mut previous:Option<StreamChunk>=None;
                let mut emit=|current:StreamChunk|->Result<(),String>{
                    if let Some(prior)=previous.take(){
                        let mut end=SEARCH_OVERLAP.min(current.text.len());while !current.text.is_char_boundary(end){end-=1;}
                        self.push(None,prior,current.text[..end].to_string(),"body")?;
                    }
                    previous=Some(current);Ok(())
                };
                decode_reader(&mut file,cancel,|text|chunker.feed(text,&mut emit))?;
                chunker.flush(&mut emit)?;
                drop(emit);
                if let Some(prior)=previous{self.push(None,prior,String::new(),"body")?;}
                else {self.push(None,StreamChunk{ordinal:0,start:0,end:0,start_line:1,end_line:1,text:String::new(),heading:String::new()},String::new(),"body")?;}
                chunker.ordinal.max(1)
            }else{
                self.push(None,StreamChunk{ordinal:0,start:0,end:0,start_line:0,end_line:0,text:String::new(),heading:String::new()},String::new(),"metadata")?;1
            }
        };
        self.flush()?;root.verify()?;
        if initial_stat!=stat_token(&file.metadata().map_err(|e|e.to_string())?){return Err("SOURCE_CHANGED: 原件在读取期间改变".into());}
        ensure_build(self.conn,self.spec,self.cancel)?;
        let tx=self.conn.unchecked_transaction().map_err(db_error)?;
        tx.prepare_cached("INSERT INTO kb_snap_member(libraryId,generation,noteId,relativeUri,title,parseGeneration,sourceHash,legacyHash,sourceSize,statIdentity,coverage,chunkCount,parserVersion,chunkerVersion,encodingVersion,contextVersion,optionsHash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)").map_err(db_error)?.execute(params![self.spec.library,self.spec.generation,self.note,relative,self.title,self.parse,hash.sha256,hash.fnv,hash.bytes.to_string(),initial_stat,if is_text{"text"}else{"metadata"},count as i64,PARSER_VERSION,CHUNKER_VERSION,ENCODING_VERSION,CONTEXT_VERSION,options_hash()]).map_err(db_error)?;
        self.write_progress(&tx,"building",self.files+1)?;
        tx.commit().map_err(db_error)?;
        self.files+=1;self.last_progress=Instant::now();
        self.disk.check(self.conn,self.limits,(relative.len()+self.title.len()+512)as u64,false)?;
        Ok(())
    }
}
fn validate_manifest(conn:&Connection,spec:&BuildSpec,cancel:&AtomicBool)->Result<(String,i64),String>{
    #[cfg(test)] let _timer=StageTimer::new(Stage::Validation);
    let mut heartbeat=Instant::now();
    let mut seen=0i64;
    walk_files(Path::new(&spec.root),"",0,cancel,&mut |relative|{
        ensure_build(conn,spec,cancel)?;
        let expected:String=conn.prepare_cached("SELECT statIdentity FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND relativeUri=?3").map_err(db_error)?.query_row(params![spec.library,spec.generation,relative],|r|r.get(0)).map_err(|_|"SOURCE_CHANGED: 源集合新增或身份变化".to_string())?;
        let mut root=files::SafeRoot::new(Path::new(&spec.root))?;
        let file=files::open_snapshot(&mut root,relative)?;
        if stat_token(&file.metadata().map_err(|e|e.to_string())?)!=expected{return Err("SOURCE_CHANGED: 源集合版本改变".into());}
        let (expected_chunks,actual_chunks,min_ordinal,max_ordinal):(i64,i64,Option<i64>,Option<i64>)=conn.prepare_cached("SELECT m.chunkCount,COUNT(c.chunkKey),MIN(c.ordinal),MAX(c.ordinal) FROM kb_snap_member m LEFT JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND m.relativeUri=?3 GROUP BY m.noteId").map_err(db_error)?.query_row(params![spec.library,spec.generation,relative],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(db_error)?;
        if expected_chunks<1||actual_chunks!=expected_chunks||min_ordinal!=Some(0)||max_ordinal!=Some(expected_chunks-1){return Err("MANIFEST_CHUNK_MISMATCH".into());}
        seen+=1;
        if heartbeat.elapsed()>=PROGRESS_INTERVAL{conn.execute("UPDATE kb_snap_job SET updatedAt=?2 WHERE id=?1 AND phase='validating'",params![spec.id,now_ms()]).map_err(db_error)?;heartbeat=Instant::now();}
        Ok(())
    })?;
    let count:i64=conn.prepare_cached("SELECT COUNT(*) FROM kb_snap_member WHERE libraryId=?1 AND generation=?2").map_err(db_error)?.query_row(params![spec.library,spec.generation],|r|r.get(0)).map_err(db_error)?;
    if seen!=count{return Err("SOURCE_CHANGED: 源集合缺失".into());}
    let mut digest=Sha256::new();let mut after=String::new();
    loop{
        ensure_build(conn,spec,cancel)?;
        if heartbeat.elapsed()>=PROGRESS_INTERVAL{conn.execute("UPDATE kb_snap_job SET updatedAt=?2 WHERE id=?1 AND phase='validating'",params![spec.id,now_ms()]).map_err(db_error)?;heartbeat=Instant::now();}
        let rows={let mut stmt=conn.prepare_cached("SELECT noteId,relativeUri,sourceHash,legacyHash,parseGeneration,coverage,chunkCount,parserVersion,chunkerVersion,encodingVersion,contextVersion,optionsHash FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND noteId>?3 ORDER BY noteId LIMIT 16").map_err(db_error)?;
            let mapped=stmt.query_map(params![spec.library,spec.generation,after],|r|Ok((r.get::<_,String>(0)?,(0..12).map(|i|if i==6{r.get::<_,i64>(i).map(|v|v.to_string())}else{r.get::<_,String>(i)}).collect::<Result<Vec<_>,_>>()?))).map_err(db_error)?;
            mapped.collect::<Result<Vec<_>,_>>().map_err(db_error)?};
        if rows.is_empty(){break;}
        for(note,fields)in rows{after=note;for field in fields{digest.update((field.len()as u64).to_le_bytes());digest.update(field.as_bytes());}}
    }
    Ok((format!("sha256:{:x}",digest.finalize()),count))
}
fn publish(conn:&Connection,spec:&BuildSpec,cancel:&AtomicBool,digest:&str,files:i64,chunks:i64,logical:u64,seal_hash:Option<&str>)->Result<(),String>{
    #[cfg(test)] let _timer=StageTimer::new(Stage::Publish);
    ensure_build(conn,spec,cancel)?;
    if spec.engine==Engine::Tantivy && !seal_hash.is_some_and(|h|h.strip_prefix("sha256:").is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()))){return Err("INDEX_SEAL_UNTRUSTED: 发布缺可信封存SHA".into());}
    let tx=conn.unchecked_transaction().map_err(db_error)?;
    ensure_build(&tx,spec,cancel)?;
    let previous:Option<i64>=tx.query_row("SELECT activeGeneration FROM kb_snap_control WHERE libraryId=?1",[&spec.library],|r|r.get(0)).map_err(db_error)?;
    let changed=tx.execute("UPDATE kb_snap_control SET activeGeneration=?2,epoch=epoch+1 WHERE libraryId=?1 AND epoch=?3 AND sourceFence=?4 AND NOT EXISTS(SELECT 1 FROM kb_snap_job WHERE id=?5 AND cancelRequested<>0)",params![spec.library,spec.generation,spec.base_epoch,spec.base_fence,spec.id]).map_err(db_error)?;
    if changed!=1{return Err("SNAPSHOT_CAS_CONFLICT".into());}
    if let Some(old)=previous{tx.execute("UPDATE kb_snap_generation SET state='retired' WHERE id=?1 AND state='active'",[old]).map_err(db_error)?;}
    let activated=tx.execute("UPDATE kb_snap_generation SET state='active',publishedEpoch=?2,completedAt=?3,manifestDigest=?4,fileCount=?5,chunkCount=?6,logicalBytes=?7,engineSealHash=?8 WHERE id=?1 AND libraryId=?9 AND state='building'",params![spec.generation,spec.base_epoch+1,now_ms(),digest,files,chunks,logical as i64,seal_hash,spec.library]).map_err(db_error)?;
    if activated!=1{return Err("SNAPSHOT_CAS_CONFLICT".into());}
    tx.execute("UPDATE kb_snap_job SET phase='completed',processedFiles=?2,coverage='metadata_and_text',snapshotEpoch=?3,updatedAt=?4 WHERE id=?1",params![spec.id,files,(spec.base_epoch+1).to_string(),now_ms()]).map_err(db_error)?;
    tx.commit().map_err(db_error)
}
fn build_snapshot(conn:&Connection,spec:&BuildSpec,cancel:&AtomicBool,limits:&Limits)->Result<(),String>{
    let mut builder=Builder{conn,spec,cancel,limits,fts:fts_name(spec.generation)?,pending:Vec::new(),pending_bytes:0,logical:0,processed:0,files:0,chunks:0,last_progress:Instant::now(),disk:DiskGuard::new(),note:String::new(),parse:String::new(),title:String::new(),relative:String::new(),term_cache:None,engine_writer:if spec.engine==Engine::Tantivy{Some(tantivy_engine::Writer::create(conn,spec)?)}else{None},source_hash:None};
    let result=(||{
    builder.disk.check(conn,limits,0,true)?;
    builder.phase("discovering",true)?;
    walk_files(Path::new(&spec.root),"",0,cancel,&mut |relative|builder.file(relative))?;
    builder.flush()?;builder.phase("validating",true)?;
    let(digest,count)=validate_manifest(conn,spec,cancel)?;
    if count!=builder.files{return Err("MANIFEST_COUNT_MISMATCH".into());}
    let mut seal_hash=None;
    #[cfg(test)] BEFORE_ENGINE_PREPARE.with(|hook|{if let Some(h)=hook.borrow_mut().take(){h(conn,spec);}});
    ensure_build(conn,spec,cancel)?;
    let engine_ready=if let Some(writer)=builder.engine_writer.take(){
        let ready={
            #[cfg(test)] let _timer=StageTimer::new(Stage::EngineCommit);
            writer.commit_monitored(conn,spec,cancel,limits)?
        };
        builder.disk.check(conn,limits,0,true)?;
        {
            #[cfg(test)] let _timer=StageTimer::new(Stage::EngineValidate);
            ready.validate(conn,spec,builder.chunks,cancel,limits)?;
        }
        {
            #[cfg(test)] let _timer=StageTimer::new(Stage::EngineSeal);
            seal_hash=Some(ready.seal(conn,spec,&digest,cancel,limits)?);
        }
        Some(ready)
    }else{
        let fts_count:i64=conn.query_row(&format!("SELECT COUNT(*) FROM {}",builder.fts),[],|r|r.get(0)).map_err(db_error)?;
        if fts_count!=builder.chunks{return Err("MANIFEST_FTS_MISMATCH".into());}None
    };
    check_disk(conn,limits)?;builder.phase("publishing",true)?;
    // 构建期把 automerge 设为 8、只在这里合并一次：逐段频繁合并在 10GiB 基准里是主要时间开销。
    // optimize 把已写入的多个 segment 合并为单个，检索路径也随之更快；取消后不 optimize 也无副作用。
    // 失败不能让任务显示“一切正常”：检索仍正确（多段可查），但性能退化必须可见，写入 job.error 供状态查询。
    if spec.engine==Engine::Sqlite && !cancel.load(Ordering::Acquire) {
        #[cfg(test)] let _timer=StageTimer::new(Stage::Optimize);
        if let Err(error)=conn.execute(&format!("INSERT INTO {} ({} ,rank) VALUES('optimize',0)",builder.fts,builder.fts),[]) {
            let _=conn.execute("UPDATE kb_snap_job SET error=?2 WHERE id=?1",params![spec.id,format!("FTS_OPTIMIZE_FAILED: {error}")]);
        }
    }
    #[cfg(test)] sample_wal(conn);
    // optimize can grow the DB/WAL without changing sourceBytesHashed. Never publish past the quota.
    builder.disk.check(conn,limits,0,true)?;
    #[cfg(test)] BEFORE_PUBLISH.with(|hook|{if let Some(h)=hook.borrow_mut().take(){h(conn,spec);}});
    let result=publish(conn,spec,cancel,&digest,count,builder.chunks,builder.logical,seal_hash.as_deref());
    drop(engine_ready);result
    })();
    match result{
        Err(host)=>Err(if let Some(writer)=builder.engine_writer.take(){writer.abort_error(host)}else{host}),
        Ok(())=>Ok(())
    }
}

fn in_read<T>(conn:&Connection,f:impl FnOnce(&Connection)->Result<T,String>)->Result<T,String>{
    if !conn.is_autocommit(){return f(conn);}
    let tx=conn.unchecked_transaction().map_err(db_error)?;let value=f(&tx)?;tx.commit().map_err(db_error)?;Ok(value)
}
fn live_generation(conn:&Connection,lib:&str,generation:i64)->Result<i64,String>{
    performance::source_ref(conn,lib)?;
    conn.prepare_cached("SELECT publishedEpoch FROM kb_snap_generation WHERE libraryId=?1 AND id=?2 AND state IN ('active','retired')").map_err(db_error)?.query_row(params![lib,generation],|r|r.get(0)).optional().map_err(db_error)?.ok_or("SNAPSHOT_EXPIRED: 指定索引快照已回收或不可读".into())
}
fn original_offset(text:&str,normalized:&str,offset:usize)->usize{
    let count=normalized[..offset].chars().count();text.char_indices().nth(count).map(|(i,_)|i).unwrap_or(text.len())
}
/// Only a match beginning in the primary owns this candidate; suffix-only matches belong to the next chunk.
fn owned_match(text:&str,primary:usize,title:&str,heading:&str,q:&ParsedQuery)->Option<Option<(usize,usize)>>{
    let norm=tantivy_engine::fold(&kb_index::normalize(text));let meta=tantivy_engine::fold(&kb_index::normalize(&format!("{title}\n{heading}")));
    let needles:Vec<String>=if let Some(ch)=q.single_char{vec![tantivy_engine::fold(&ch.to_string())]}else{q.needles.iter().map(|n|tantivy_engine::fold(n)).collect()};
    let(mut first,mut last)=(usize::MAX,0usize);let mut metadata_match=false;
    for needle in &needles{
        if let Some(at)=norm.find(needle){let start=original_offset(text,&norm,at);let end=original_offset(text,&norm,at+needle.len());first=first.min(start);last=last.max(end);}
        else if meta.contains(needle){metadata_match=true;}else{return None;}
    }
    if first<primary{return Some(Some((first,last)));}
    if first==usize::MAX && metadata_match{return Some(None);}
    if needles.is_empty(){return Some(None);}
    None
}
fn check_member_versions(conn:&Connection,lib:&str,generation:i64,key:Option<i64>)->Result<(),String>{
    // Validate the generation before MATCH (even zero candidates), or only the referenced member.
    let scope="m.libraryId=?1 AND m.generation=?2 AND (?3 IS NULL OR EXISTS(SELECT 1 FROM kb_snap_chunk c WHERE c.chunkKey=?3 AND c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration))";
    let context_sql=format!("SELECT EXISTS(SELECT 1 FROM kb_snap_member m WHERE {scope} AND m.contextVersion NOT IN ('forward-512-owned-start-v1','forward-512-owned-start-v2'))");
    let unknown_context:bool=conn.prepare_cached(&context_sql).map_err(db_error)?.query_row(params![lib,generation,key],|r|r.get(0)).map_err(db_error)?;
    if unknown_context{return Err("SNAPSHOT_CONTEXT_UNSUPPORTED: 未知检索上下文版本，需重建索引".into());}
    let versions_sql=format!("SELECT EXISTS(SELECT 1 FROM kb_snap_member m WHERE {scope} AND (m.parserVersion<>?4 OR m.chunkerVersion<>?5 OR m.encodingVersion<>?6 OR m.optionsHash<>?7))");
    let unknown:bool=conn.prepare_cached(&versions_sql).map_err(db_error)?.query_row(params![lib,generation,key,PARSER_VERSION,CHUNKER_VERSION,ENCODING_VERSION,options_hash()],|r|r.get(0)).map_err(db_error)?;
    if unknown{return Err("SNAPSHOT_REBUILD_REQUIRED: 未知解析/编码/切片版本".into());}Ok(())
}
fn raw_row(r:&rusqlite::Row,generation:i64)->Result<(RawHit,usize,u64),String>{
    let text=r.get::<_,Option<String>>(7).map_err(db_error)?.ok_or("SNAPSHOT_CONTEXT_UNSUPPORTED: 未知检索上下文版本，需重建索引")?;
    let read=||->rusqlite::Result<(RawHit,usize,u64)>{Ok((RawHit{note_id:r.get(0)?,relative_uri:r.get(1)?,title:r.get(2)?,heading:r.get(3)?,chunk_key:r.get(4)?,ordinal:r.get::<_,i64>(5)?as usize,score:r.get(6)?,chunk_text:text,metadata_only:r.get::<_,String>(8)?=="metadata",snapshot_generation:Some(generation)},r.get::<_,i64>(9)?as usize,r.get::<_,i64>(10)?as u64))};
    read().map_err(db_error)
}
pub fn search_library(conn:&Connection,library_id:&str,q:&ParsedQuery)->Result<Option<(Vec<RawHit>,bool)>,String>{
    in_read(conn,|conn|{
        performance::source_ref(conn,library_id)?;
        let Some(snapshot)=active_snapshot(conn,library_id)?else{return Ok(None);};
        let engine=engine_for(conn,library_id,snapshot.generation)?;
        let _lease=ReadLease::new(conn,library_id,snapshot.generation)?;
        // Validate before either engine returns zero candidates or an empty query.
        check_member_versions(conn,library_id,snapshot.generation,None)?;
        if engine==Engine::Tantivy{return Ok(Some(tantivy_engine::search(conn,library_id,snapshot.generation,q)?));}
        if q.is_empty(){return Ok(Some((vec![],false)));}
        let generation=snapshot.generation;let fts=fts_name(generation)?;
        let select="m.noteId,m.relativeUri,m.title,c.heading,c.chunkKey,c.ordinal";
        let join="JOIN kb_snap_member m ON m.libraryId=c.libraryId AND m.noteId=c.noteId AND m.parseGeneration=c.parseGeneration AND m.generation=?2";
        let mut hits=Vec::new();let mut incomplete=false;let mut seen=HashSet::new();
        if q.terms.is_empty(){
            let sql=format!("SELECT {select},0.0,{SEARCH_CONTEXT_SQL},c.kind,(c.endByte-c.startByte),c.startByte FROM kb_snap_chunk c {join} WHERE c.libraryId=?1 ORDER BY m.noteId,c.ordinal LIMIT 1001");
            let mut stmt=conn.prepare(&sql).map_err(db_error)?;
            let mut rows=stmt.query(params![library_id,generation]).map_err(db_error)?;
            let(mut count,mut bytes)=(0usize,0usize);
            while let Some(row)=rows.next().map_err(db_error)?{
                let(hit,primary,start)=raw_row(row,generation)?;
                count+=1;bytes+=hit.chunk_text.len()+hit.title.len();
                if count>kb_index::SCAN_MAX_ROWS||bytes>kb_index::SCAN_MAX_BYTES{incomplete=true;break;}
                if let Some(span)=owned_match(&hit.chunk_text,primary,&format!("{}\n{}",hit.title,hit.relative_uri),&hit.heading,q){
                    let key=(hit.note_id.clone(),span.map(|(a,b)|(start+a as u64,start+b as u64)));
                    if seen.insert(key){hits.push(hit);}
                }
                if hits.len()>=kb_index::SEARCH_CANDIDATE_LIMIT{incomplete=true;break;}
            }
        }else{
            let sql=format!("SELECT {select},bm25({fts},8.0,4.0,1.0,0.2),{SEARCH_CONTEXT_SQL},c.kind,length(CAST(c.text AS BLOB)),c.startByte FROM {fts} JOIN kb_snap_chunk c ON c.chunkKey={fts}.rowid {join} WHERE c.libraryId=?1 AND {fts} MATCH ?3 ORDER BY bm25({fts},8.0,4.0,1.0,0.2),m.noteId,c.ordinal LIMIT 101");
            let mut stmt=conn.prepare(&sql).map_err(db_error)?;
            let mut rows=stmt.query(params![library_id,generation,q.terms.join(" ")]).map_err(db_error)?;let mut count=0;
            while let Some(row)=rows.next().map_err(db_error)?{
                count+=1;if count>kb_index::SEARCH_CANDIDATE_LIMIT{incomplete=true;break;}
                let(hit,primary,start)=raw_row(row,generation)?;
                if let Some(span)=owned_match(&hit.chunk_text,primary,&format!("{}\n{}",hit.title,hit.relative_uri),&hit.heading,q){
                    let key=(hit.note_id.clone(),span.map(|(a,b)|(start+a as u64,start+b as u64)));
                    if seen.insert(key){hits.push(hit);}
                }
            }
        }
        Ok(Some((hits,incomplete)))
    })
}
pub fn hit_reference(conn:&Connection,library_id:&str,generation:i64,chunk_key:i64)->Result<SnapshotRef,String>{
    in_read(conn,|conn|{
        let _lease=ReadLease::new(conn,library_id,generation)?;
        let epoch=live_generation(conn,library_id,generation)?;
        let engine=engine_for(conn,library_id,generation)?;
        check_member_versions(conn,library_id,generation,Some(chunk_key))?;
        if engine==Engine::Tantivy{tantivy_engine::load(conn,library_id,generation,chunk_key)?;}
        conn.prepare_cached("SELECT m.noteId,m.parseGeneration,m.sourceHash,m.legacyHash,m.relativeUri,c.startByte,c.searchEndByte,c.endByte,c.kind FROM kb_snap_chunk c JOIN kb_snap_member m ON m.libraryId=c.libraryId AND m.noteId=c.noteId AND m.parseGeneration=c.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND c.chunkKey=?3").map_err(db_error)?.query_row(params![library_id,generation,chunk_key],|r|Ok(SnapshotRef{library_id:library_id.into(),note_id:r.get(0)?,snapshot_generation:generation,snapshot_epoch:epoch,parse_generation:r.get(1)?,source_hash:r.get(2)?,legacy_hash:r.get(3)?,relative_uri:r.get(4)?,chunk_key,start_byte:r.get::<_,i64>(5)?as u64,end_byte:r.get::<_,i64>(6)?as u64,primary_end_byte:r.get::<_,i64>(7)?as u64,match_start:None,match_end:None,metadata_only:r.get::<_,String>(8)?=="metadata"})).optional().map_err(db_error)?.ok_or("SNAPSHOT_HIT_MISMATCH: 命中不属于指定快照".into())
    })
}
pub fn hit_reference_for_query(conn:&Connection,library_id:&str,generation:i64,hit:&RawHit,q:&ParsedQuery)->Result<SnapshotRef,String>{
    let mut reference=hit_reference(conn,library_id,generation,hit.chunk_key)?;
    if let Some(Some((a,b)))=owned_match(&hit.chunk_text,(reference.primary_end_byte-reference.start_byte)as usize,&hit.title,&hit.heading,q){reference.match_start=Some(reference.start_byte+a as u64);reference.match_end=Some(reference.start_byte+b as u64);}
    Ok(reference)
}
#[derive(Clone)]
struct ReadCursor { version:u8, library:String, generation:i64, note:String, ordinal:usize, offset:usize, hit:bool, owner:Option<String>, project:Option<String>, grant_revision:Option<i64>, source_hash:String, parse:String }
struct ReadLease {token:String}
impl ReadLease {
    fn new(conn:&Connection,lib:&str,generation:i64)->Result<Self,String>{Ok(Self{token:acquire_lease(conn,"internal-reader",lib,generation)?})}
    fn renew(&self,conn:&Connection,lib:&str,generation:i64)->Result<(),String>{
        let mut rt=lock_runtime()?;
        let lease=rt.leases.get_mut(&self.token).ok_or("LEASE_EXPIRED: 复用租约已失效")?;
        if lease.owner!="internal-reader"||lease.library!=lib||lease.generation!=generation{return Err("LEASE_OWNER_MISMATCH".into());}
        if lease.touched.elapsed()>=LEASE_TTL{return Err("LEASE_EXPIRED: 复用租约已过期，禁止重新授予".into());}
        live_generation(conn,lib,generation)?;lease.touched=Instant::now();Ok(())
    }
}
impl Drop for ReadLease{fn drop(&mut self){let _=release_lease("internal-reader",&self.token);}}
fn piece_text(conn:&Connection,lib:&str,generation:i64,key:i64,hit:bool,sql_text:Option<String>)->Result<String,String>{
    match engine_for(conn,lib,generation)? {
        Engine::Sqlite=>{
            let text=sql_text.ok_or("SNAPSHOT_CONTEXT_UNSUPPORTED: 未知检索上下文版本，需重建索引")?;
            let (parser,chunker,encoding,options):(String,String,String,String)=conn.query_row("SELECT m.parserVersion,m.chunkerVersion,m.encodingVersion,m.optionsHash FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND c.chunkKey=?3",params![lib,generation,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(db_error)?;
            if parser!=PARSER_VERSION||chunker!=CHUNKER_VERSION||encoding!=ENCODING_VERSION||options!=options_hash(){return Err("SNAPSHOT_REBUILD_REQUIRED: 未知解析/编码/切片版本".into());}
            Ok(text)
        },
        Engine::Tantivy=>{let(_,primary,suffix)=tantivy_engine::load(conn,lib,generation,key)?;Ok(if hit{format!("{primary}{suffix}")}else{primary})}
    }
}
pub(super) fn advance_lines(text:&str,mut line:usize,mut previous_cr:bool)->(usize,bool){
    for c in text.chars(){if c=='\r'||(c=='\n'&&!previous_cr){line=line.saturating_add(1);}previous_cr=c=='\r';}
    (line,previous_cr)
}
fn read_piece(conn:&Connection,lib:&str,note:&str,generation:i64,ordinal:usize,offset:usize,max_bytes:Option<usize>,hit:bool)->Result<ChunkView,String>{
    let _lease=ReadLease::new(conn,lib,generation)?;
    let sql=format!("SELECT c.chunkKey,m.sourceHash,m.parseGeneration,CASE WHEN ?5 THEN {SEARCH_CONTEXT_SQL} WHEN m.contextVersion IN ('forward-512-owned-start-v1','forward-512-owned-start-v2') THEN c.text ELSE NULL END,c.startByte,c.startLine,c.heading,c.kind FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.libraryId=?1 AND m.generation=?2 AND m.noteId=?3 AND c.ordinal=?4");
    let row:Option<(i64,String,String,Option<String>,i64,i64,String,String)>=conn.query_row(&sql,params![lib,generation,note,ordinal as i64,hit],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(db_error)?;
    let(key,hash,parse,text,start,start_line,heading,kind)=row.ok_or("NOTE_NOT_IN_SNAPSHOT: 文件或片段不在指定快照，禁止回退新版本")?;
    let text=piece_text(conn,lib,generation,key,hit,text)?;
    if kind=="metadata"{return Err("METADATA_ONLY: 此快照只提供文件名/路径索引".into());}
    if offset>text.len()||!text.is_char_boundary(offset){return Err("CURSOR_INVALID: 字节偏移无效".into());}
    let cap=max_bytes.unwrap_or(4096).min(4096);
    if cap==0{return Err("BUDGET_EXCEEDED: 正文预算为零".into());}
    let more:bool=if hit{false}else{conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM kb_snap_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND ordinal=?4)").map_err(db_error)?.query_row(params![lib,note,parse,ordinal as i64+1],|r|r.get(0)).map_err(db_error)?};
    let previous_cr=if ordinal==0{false}else{
        let previous:Option<(i64,String)>=conn.query_row("SELECT chunkKey,text FROM kb_snap_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND ordinal=?4",params![lib,note,parse,ordinal as i64-1],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
        match previous{Some((k,t))=>piece_text(conn,lib,generation,k,false,Some(t))?.ends_with('\r'),None=>false}
    };
    let (actual_start_line,at_cr)=advance_lines(&text[..offset],start_line.max(0)as usize,previous_cr);
    let mut end=(offset+cap).min(text.len());while !text.is_char_boundary(end){end-=1;}
    loop{
        if end==offset&&offset<text.len(){return Err("BUDGET_EXCEEDED: 预算无法容纳一个完整字符".into());}
        let partial=end<text.len();let eof=!partial&&!more;
        let cursor_state=if eof{None}else{Some(ReadCursor{version:1,library:lib.into(),generation,note:note.into(),ordinal:if partial{ordinal}else{ordinal+1},offset:if partial{end}else{0},hit,owner:None,project:None,grant_revision:None,source_hash:hash.clone(),parse:parse.clone()})};
        let next_cursor=cursor_state.as_ref().map(|_|new_id("kbsnapcursor"));
        let (actual_end_line,_)=advance_lines(&text[offset..end],actual_start_line,at_cr);
        let view=ChunkView{library_id:lib.into(),note_id:note.into(),source_hash:hash.clone(),parse_generation:parse.clone(),chunk_key:key,ordinal,start_byte:start as usize+offset,end_byte:start as usize+end,start_line:actual_start_line,end_line:actual_end_line,heading:heading.clone(),content:text[offset..end].to_string(),truncated:partial,eof,next_cursor};
        if serde_json::to_vec(&view).map_err(|e|e.to_string())?.len()<=kb_index::RESPONSE_BUDGET_BYTES{
            if let (Some(token),Some(state))=(&view.next_cursor,cursor_state){
                let mut rt=lock_runtime()?;rt.cursors.retain(|_,(_,at)|at.elapsed()<LEASE_TTL);
                if rt.cursors.len()>=256{if let Some(old)=rt.cursors.iter().min_by_key(|(_,(_,at))|*at).map(|(key,_)|key.clone()){rt.cursors.remove(&old);}}
                rt.cursors.insert(token.clone(),(state,Instant::now()));
            }
            return Ok(view);
        }
        if end<=offset{return Err("BUDGET_EXCEEDED: 元数据超过响应预算".into());}
        end=offset+(end-offset)/2;while !text.is_char_boundary(end){end-=1;}
    }
}
pub fn read_chunk_conn(conn:&Connection,library_id:&str,note_id:&str,expected_generation:Option<i64>,ordinal:usize,max_bytes:Option<usize>)->Result<Option<ChunkView>,String>{
    in_read(conn,|conn|{
        performance::source_ref(conn,library_id)?;
        let generation=match expected_generation{Some(g)=>g,None=>match active_snapshot(conn,library_id)?{Some(s)=>s.generation,None=>return Ok(None)}};
        Ok(Some(read_piece(conn,library_id,note_id,generation,ordinal,0,max_bytes,false)?))
    })
}
pub fn read_hit_conn(conn:&Connection,library_id:&str,generation:i64,chunk_key:i64,max_bytes:Option<usize>)->Result<ChunkView,String>{
    in_read(conn,|conn|{
        let reference=hit_reference(conn,library_id,generation,chunk_key)?;
        let ordinal:i64=conn.prepare_cached("SELECT ordinal FROM kb_snap_chunk WHERE chunkKey=?1").map_err(db_error)?.query_row([chunk_key],|r|r.get(0)).map_err(db_error)?;
        read_piece(conn,library_id,&reference.note_id,generation,ordinal as usize,0,max_bytes,true)
    })
}
pub fn read_cursor_conn(conn:&Connection,library_id:&str,cursor:&str,max_bytes:Option<usize>)->Result<ChunkView,String>{
    if cursor.len()>4096{return Err("CURSOR_INVALID".into());}
    let c={let mut rt=lock_runtime()?;rt.cursors.retain(|_,(_,at)|at.elapsed()<LEASE_TTL);rt.cursors.get(cursor).map(|(c,_)|c.clone()).ok_or("CURSOR_EXPIRED")?};
    if c.version!=1||c.library!=library_id{return Err("CURSOR_INVALID".into());}
    in_read(conn,|conn|{
        let view=read_piece(conn,library_id,&c.note,c.generation,c.ordinal,c.offset,max_bytes,c.hit)?;
        if view.source_hash!=c.source_hash||view.parse_generation!=c.parse{return Err("CURSOR_SOURCE_MISMATCH".into());}
        Ok(view)
    })
}

fn cursor_grant_revision(conn:&Connection,project:Option<&str>,library:&str)->Result<i64,String>{
    conn.query_row("SELECT g.revision FROM project_library_grant g JOIN knowledge_library l ON l.id=g.libraryId WHERE g.projectId=?1 AND g.libraryId=?2 AND g.readAllowed=1 AND l.enabled=1",params![project.ok_or("KNOWLEDGE_DENIED")?,library],|r|r.get(0)).map_err(|_|"KNOWLEDGE_DENIED: 知识库已撤权或停用".into())
}
pub(crate) fn bind_cursor(conn:&Connection,cursor:&str,project:Option<&str>)->Result<(),String>{
    let mut rt=lock_runtime()?;
    let (state,at)=rt.cursors.get_mut(cursor).ok_or("CURSOR_EXPIRED")?;
    if at.elapsed()>=LEASE_TTL{return Err("CURSOR_EXPIRED".into());}
    if state.project.as_deref().is_some_and(|p|Some(p)!=project){return Err("CURSOR_SCOPE_MISMATCH".into());}
    let revision=cursor_grant_revision(conn,project,&state.library)?;
    if state.grant_revision.is_some_and(|old|old!=revision){return Err("KNOWLEDGE_DENIED: 续读授权版本已变化".into());}
    state.project=Some(project.ok_or("KNOWLEDGE_DENIED")?.to_string());state.grant_revision=Some(revision);Ok(())
}
pub(crate) fn check_cursor_scope(conn:&Connection,cursor:&str,project:Option<&str>)->Result<(),String>{
    let rt=lock_runtime()?;let(state,at)=rt.cursors.get(cursor).ok_or("CURSOR_EXPIRED")?;
    if at.elapsed()>=LEASE_TTL{return Err("CURSOR_EXPIRED".into());}
    if state.project.as_deref()!=project||project.is_none(){return Err("CURSOR_SCOPE_MISMATCH: 续读能力不属于项目".into());}
    if state.grant_revision!=Some(cursor_grant_revision(conn,project,&state.library)?){return Err("KNOWLEDGE_DENIED: 续读授权版本已变化".into());}Ok(())
}
pub(super) fn preceding_cr(conn:&Connection,view:&ChunkView,generation:i64)->Result<bool,String>{
    let _lease=ReadLease::new(conn,&view.library_id,generation)?;
    let (start,text):(i64,String)=conn.query_row("SELECT startByte,text FROM kb_snap_chunk WHERE chunkKey=?1 AND libraryId=?2 AND noteId=?3 AND parseGeneration=?4",params![view.chunk_key,view.library_id,view.note_id,view.parse_generation],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
    if start<0||view.start_byte<start as usize{return Err("CURSOR_INVALID".into());}
    if view.start_byte>start as usize{
        let t=piece_text(conn,&view.library_id,generation,view.chunk_key,true,Some(text))?;
        return Ok(t.as_bytes().get(view.start_byte-start as usize-1)==Some(&b'\r'));
    }
    if view.ordinal==0{return Ok(false);}
    let (key,text):(i64,String)=conn.query_row("SELECT chunkKey,text FROM kb_snap_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND ordinal=?4",params![view.library_id,view.note_id,view.parse_generation,view.ordinal as i64-1],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
    Ok(piece_text(conn,&view.library_id,generation,key,false,Some(text))?.ends_with('\r'))
}
pub fn acquire_lease(conn:&Connection,owner:&str,library_id:&str,generation:i64)->Result<String,String>{
    performance::source_ref(conn,library_id)?;
    let mut rt=lock_runtime()?;
    rt.leases.retain(|_,l|l.touched.elapsed()<LEASE_TTL);
    if rt.leases.len()>=64||rt.leases.values().filter(|l|l.owner==owner).count()>=32{return Err("LEASE_QUOTA".into());}
    live_generation(conn,library_id,generation)?;
    let token=new_id("kbsnaplease");rt.leases.insert(token.clone(),Lease{owner:owner.into(),library:library_id.into(),generation,touched:Instant::now()});Ok(token)
}
pub fn release_lease(owner:&str,token:&str)->Result<(),String>{
    let mut rt=lock_runtime()?;
    if rt.leases.get(token).is_some_and(|l|l.owner!=owner){return Err("LEASE_OWNER_MISMATCH".into());}
    rt.leases.remove(token);Ok(())
}
/// One bounded GC step. A single global build/maintenance worker invokes this, never a foreground query.
fn gc_once(conn:&Connection,library:Option<&str>,cancel:&AtomicBool)->Result<bool,String>{
    check_cancel(cancel)?;
    let generation={
        let mut rt=lock_runtime()?;rt.leases.retain(|_,l|l.touched.elapsed()<LEASE_TTL);
        let candidates={let mut stmt=conn.prepare("SELECT id,libraryId FROM kb_snap_generation g WHERE state IN ('retired','failed','cancelled','interrupted','collecting') AND (?1 IS NULL OR libraryId=?1) AND NOT EXISTS(SELECT 1 FROM kb_snap_control c WHERE c.activeGeneration=g.id) ORDER BY id LIMIT 8").map_err(db_error)?;
            let rows=stmt.query_map([library],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).map_err(db_error)?;
            rows.collect::<Result<Vec<_>,_>>().map_err(db_error)?};
        let selected=candidates.into_iter().find(|(id,lib)|!rt.leases.values().any(|l|l.generation==*id&&l.library==*lib));
        let Some((id,lib))=selected else{return Ok(false);};
        conn.execute("UPDATE kb_snap_generation SET state='collecting' WHERE id=?1 AND state IN ('retired','failed','cancelled','interrupted','collecting')",[id]).map_err(db_error)?;
        (id,lib)
    };
    let (id,lib)=generation;let fts=fts_name(id)?;
    // GC must not depend on query/tokenizer compatibility: known derived bad generations
    // remain collectible. Tantivy remove independently checks host path and ownership.
    let kind:String=conn.query_row("SELECT engineKind FROM kb_snap_generation WHERE libraryId=?1 AND id=?2",params![lib,id],|r|r.get(0)).map_err(db_error)?;
    match kind.as_str(){"tantivy"=>tantivy_engine::remove(conn,&lib,id)?,"sqlite"=>{},_=>return Err("SNAPSHOT_REBUILD_REQUIRED: 未知引擎，禁止猜测回收方式".into())}
    let exists:bool=conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)").map_err(db_error)?.query_row([&fts],|r|r.get(0)).map_err(db_error)?;
    if exists{
        let changed=conn.execute(&format!("DELETE FROM {fts} WHERE rowid IN (SELECT rowid FROM {fts} LIMIT 64)"),[]).map_err(db_error)?;
        if changed>0{return Ok(true);}
    }
    let member:Option<(String,String)>=conn.prepare_cached("SELECT noteId,parseGeneration FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 ORDER BY noteId LIMIT 1").map_err(db_error)?.query_row(params![lib,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
    if let Some((note,parse))=member{
        let other:bool=conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM kb_snap_member WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND generation<>?4)").map_err(db_error)?.query_row(params![lib,note,parse,id],|r|r.get(0)).map_err(db_error)?;
        if !other{
            let changed=conn.execute("DELETE FROM kb_snap_chunk WHERE chunkKey IN (SELECT chunkKey FROM kb_snap_chunk WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 LIMIT 64)",params![lib,note,parse]).map_err(db_error)?;
            if changed>0{return Ok(true);}
        }
        conn.execute("DELETE FROM kb_snap_member WHERE libraryId=?1 AND generation=?2 AND noteId=?3",params![lib,id,note]).map_err(db_error)?;
        return Ok(true);
    }
    let changed=conn.execute("DELETE FROM kb_snap_chunk WHERE chunkKey IN (SELECT c.chunkKey FROM kb_snap_chunk c WHERE c.createdGeneration=?1 AND NOT EXISTS(SELECT 1 FROM kb_snap_member m WHERE m.libraryId=c.libraryId AND m.noteId=c.noteId AND m.parseGeneration=c.parseGeneration) LIMIT 64)",[id]).map_err(db_error)?;
    if changed>0{return Ok(true);}
    let tx=conn.unchecked_transaction().map_err(db_error)?;
    if exists{tx.execute_batch(&format!("DROP TABLE {fts};")).map_err(db_error)?;}
    tx.execute("DELETE FROM kb_snap_managed_entity WHERE libraryId=?1 AND generation=?2",params![lib,id]).map_err(db_error)?;
    tx.execute("UPDATE kb_snap_generation SET state='collected' WHERE id=?1 AND state='collecting'",[id]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(true)
}
fn gc_background(conn:&Connection,library:&str,cancel:&AtomicBool)->Result<(),String>{
    while gc_once(conn,Some(library),cancel)?{std::thread::yield_now();}
    Ok(())
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    struct Fixture {conn:Connection,root:PathBuf,lib:String}
    impl Fixture {
        fn new()->Self{
            let dir=std::env::temp_dir().join(new_id("nestcraft-snapshot-test"));fs::create_dir_all(&dir).unwrap();
            let root=fs::canonicalize(&dir).unwrap();
            let conn=Connection::open_in_memory().unwrap();
            conn.execute_batch("CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,sourceRef TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,sourceKind TEXT NOT NULL DEFAULT 'managed-directory'); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT); CREATE INDEX legacy_lookup ON knowledge_note_index(libraryId,relativeUri);").unwrap();
            let lib=new_id("lib");
            conn.execute("INSERT INTO knowledge_library(id,sourceRef) VALUES(?1,?2)",params![lib,root.to_string_lossy()]).unwrap();
            performance::migrate(&conn).unwrap();migrate(&conn).unwrap();
            Self{conn,root,lib}
        }
        fn write(&self,name:&str,body:impl AsRef<[u8]>){fs::write(self.root.join(name),body).unwrap();}
        fn build(&self)->BuildSpec{
            let spec=begin_build(&self.conn,"test-owner",&self.lib,&new_id("req")).unwrap();
            build_snapshot(&self.conn,&spec,&AtomicBool::new(false),&Limits{logical_bytes:16*1024*1024,disk_bytes:u64::MAX,check_space:false}).unwrap();spec
        }
        fn search(&self,q:&str)->(Vec<RawHit>,bool){search_library(&self.conn,&self.lib,&kb_index::parse_query(q).unwrap()).unwrap().unwrap()}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    #[test]
    fn fulltext_snapshot_handles_empty_and_metadata_without_faking_body(){
        let f=Fixture::new();f.write("empty.txt",b"");f.write("guide.md","# Guide\nneedle 中文\n");f.write("attachment.pdf",b"%PDF-1.7 opaque");
        let spec=f.build();assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,spec.generation);
        let hits=f.search("needle").0;assert_eq!(hits.len(),1);assert!(!hits[0].metadata_only);
        let r=hit_reference(&f.conn,&f.lib,spec.generation,hits[0].chunk_key).unwrap();
        assert!(r.source_hash.starts_with("sha256:"));assert!(r.legacy_hash.starts_with("fnv1a64:"));
        assert_eq!(read_hit_conn(&f.conn,&f.lib,spec.generation,hits[0].chunk_key,None).unwrap().source_hash,r.source_hash);
        let metadata=f.search("attachment").0;assert!(metadata[0].metadata_only);
        assert!(read_hit_conn(&f.conn,&f.lib,spec.generation,metadata[0].chunk_key,None).unwrap_err().contains("METADATA_ONLY"));
        assert!(read_chunk_conn(&f.conn,&f.lib,"missing",None,0,None).unwrap_err().contains("NOTE_NOT_IN_SNAPSHOT"));
    }
    #[test]
    fn bm25_scores_are_nonzero_and_column_weights_change_order(){
        // 独立复审实测：contentless + detail=column 会让 bm25() 恒为 0，相关性排序静默失效。
        // 本测试钉住“分数必须非零”，并要求交换列权重能改变排序（证明四列权重真的参与打分）。
        let f=Fixture::new();
        f.write("a.txt",b"needle appears in body only, many times: needle needle needle needle");
        f.write("b.txt",b"needle is also the file title element of this note body needle");
        f.write("title-needle.txt",b"unrelated body words here");
        let spec=f.build();
        let fts=fts_name(spec.generation).unwrap();
        let scores=|col:String|->Vec<(i64,f64)>{
            let sql=format!("SELECT rowid,bm25({fts},{col}) FROM {fts} WHERE {fts} MATCH ?1 ORDER BY 2");
            let mut stmt=f.conn.prepare(&sql).unwrap();
            let rows=stmt.query_map(params!["needle"],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            rows.map(|r|r.unwrap()).collect()
        };
        let default=scores("8.0,4.0,1.0,0.2".into());
        assert!(!default.is_empty(),"命中不应为空");
        assert!(default.iter().any(|(_,s)|*s!=0.0),"bm25 必须给出非零分数（全 0 表示相关性排序失效）");
        let title_heavy=scores("0.1,0.1,1.0,0.1".into());
        assert_eq!(default.len(),title_heavy.len());
        let order=|v:&Vec<(i64,f64)>|->Vec<i64>{v.iter().map(|(k,_)|*k).collect()};
        assert_ne!(order(&default),order(&title_heavy),"交换列权重必须改变排序，否则列权重未参与打分");
        // 接线断言：生产检索路径确实按 bm25 排序（而不只是 FTS 表里分数非零）。
        // a.txt 正文多次命中 needle，应排在仅命中一次（或仅标题命中）的笔记之前。
        let hits=f.search("needle").0;
        assert!(hits.len()>=2,"应有多个命中块，实际 {}",hits.len());
        assert!(hits.iter().map(|h|h.score).collect::<Vec<_>>().windows(2).all(|w|w[0]<=w[1]),"search_library 必须按 bm25 升序（更相关在前）");
        // title 列权重最高（8.0），标题命中的笔记必须排在仅正文命中的笔记之前——这正是列权重生效的接线证据。
        assert_eq!(hits[0].relative_uri,"title-needle.txt","标题命中的笔记应排最前，实际 {:?}",hits.iter().map(|h|(h.relative_uri.clone(),h.score)).collect::<Vec<_>>());
    }
    #[test]
    fn legacy_tokenizer_snapshot_refuses_search_instead_of_silent_zero_hits(){
        // 升级分词器后，既有快照里的词项与新查询不同构；必须显式报“需重建”，不能静默 0 命中。
        let f=Fixture::new();f.write("a.txt",b"needle body");
        let spec=f.build();
        f.conn.execute("UPDATE kb_snap_generation SET tokenizerVersion='local-bigram-hex-v1' WHERE id=?1",params![spec.generation]).unwrap();
        let query=kb_index::parse_query("needle").unwrap();
        let error=search_library(&f.conn,&f.lib,&query).unwrap_err();
        assert!(error.contains("SNAPSHOT_REBUILD_REQUIRED"),"必须给出需重建索引的明确错误，实际: {error}");
        // 恢复为当前版本后可正常检索
        f.conn.execute("UPDATE kb_snap_generation SET tokenizerVersion=?2 WHERE id=?1",params![spec.generation,kb_index::TOKENIZER_VERSION]).unwrap();
        assert_eq!(search_library(&f.conn,&f.lib,&query).unwrap().unwrap().0.len(),1);
    }    #[test]
    fn cross_chunk_chinese_match_has_owned_exact_span_and_suffix_not_duplicated(){
        let f=Fixture::new();let source=format!("{}中文 ending", "x".repeat(CHUNK_BYTES-3));f.write("cross.txt",source.as_bytes());
        let spec=f.build();let query=kb_index::parse_query("中文").unwrap();let hits=f.search("中文").0;
        assert_eq!(hits.len(),1);assert_eq!(hits[0].ordinal,0);
        let reference=hit_reference_for_query(&f.conn,&f.lib,spec.generation,&hits[0],&query).unwrap();
        assert_eq!(reference.match_start,Some((CHUNK_BYTES-3)as u64));assert_eq!(reference.match_end,Some((CHUNK_BYTES+3)as u64));
        assert!(reference.match_end.unwrap()>reference.primary_end_byte);
        let view=read_hit_conn(&f.conn,&f.lib,spec.generation,hits[0].chunk_key,None).unwrap();assert!(view.content.contains("中文"));assert_eq!(view.end_byte-view.start_byte,view.content.len());
        let suffix=f.search("文").0;assert_eq!(suffix.len(),1);assert_eq!(suffix[0].ordinal,1);
    }
    #[test]
    fn lookahead_covers_maximum_four_byte_query_and_preserves_utf16_hash(){
        let f=Fixture::new();let query="𠀀".repeat(128);let text=format!("{}{} tail","x".repeat(CHUNK_BYTES-4),query);
        let mut source=vec![0xff,0xfe];for c in text.encode_utf16(){source.extend_from_slice(&c.to_le_bytes());}f.write("wide.txt",&source);
        let spec=f.build();let hits=f.search(&query).0;assert_eq!(hits.len(),1);
        let q=kb_index::parse_query(&query).unwrap();let reference=hit_reference_for_query(&f.conn,&f.lib,spec.generation,&hits[0],&q).unwrap();
        assert_eq!(reference.match_end.unwrap()-reference.match_start.unwrap(),512);
        let expected=hash_reader(&mut std::io::Cursor::new(&source),&AtomicBool::new(false)).unwrap();assert_eq!(reference.source_hash,expected.sha256);
        assert_ne!(expected.sha256,hash_reader(&mut std::io::Cursor::new(text.as_bytes()),&AtomicBool::new(false)).unwrap().sha256);
    }
    #[test]
    fn cancelled_or_source_changed_build_never_replaces_active(){
        let f=Fixture::new();f.write("a.txt",b"old needle");let old=f.build();
        let pending=begin_build(&f.conn,"test-owner",&f.lib,"cancel").unwrap();
        assert_eq!(f.search("needle").0[0].snapshot_generation,Some(old.generation));
        let error=build_snapshot(&f.conn,&pending,&AtomicBool::new(true),&Limits{logical_bytes:1000,disk_bytes:u64::MAX,check_space:false}).unwrap_err();assert_eq!(error,"CANCELLED");
        terminal(&f.conn,&pending,"cancelled",&error).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        let changed=begin_build(&f.conn,"test-owner",&f.lib,"changed").unwrap();invalidate_source_tx(&f.conn,&f.lib).unwrap();
        assert!(publish(&f.conn,&changed,&AtomicBool::new(false),"digest",0,0,0,None).unwrap_err().contains("SOURCE_CHANGED"));
        assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
    }
    #[test]
    fn retired_lease_protects_old_hash_then_gc_explicitly_expires_reference(){
        let f=Fixture::new();f.write("a.txt",b"old needle");let old=f.build();let old_hit=f.search("needle").0.remove(0);
        let lease=acquire_lease(&f.conn,"lease-owner",&f.lib,old.generation).unwrap();f.write("a.txt",b"new needle");let new=f.build();
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        assert!(read_hit_conn(&f.conn,&f.lib,old.generation,old_hit.chunk_key,None).unwrap().content.contains("old"));
        assert!(f.search("new").0[0].snapshot_generation==Some(new.generation));
        release_lease("lease-owner",&lease).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        assert!(hit_reference(&f.conn,&f.lib,old.generation,old_hit.chunk_key).unwrap_err().contains("SNAPSHOT_EXPIRED"));
        assert!(!f.search("new").0.is_empty());
    }
    #[test]
    fn immutable_parse_reuse_survives_old_snapshot_gc_and_version_change_disables_reuse(){
        let f=Fixture::new();f.write("a.txt",b"stable needle");let old=f.build();let first=f.search("needle").0.remove(0);
        let new=f.build();let second=f.search("needle").0.remove(0);assert_eq!(first.chunk_key,second.chunk_key);assert_ne!(old.generation,new.generation);
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();assert!(!read_hit_conn(&f.conn,&f.lib,new.generation,second.chunk_key,None).unwrap().content.is_empty());
        // Simulate a parser manifest upgrade: source bytes alone are not a reuse key.
        f.conn.execute("UPDATE kb_snap_member SET contextVersion='old-policy' WHERE generation=?1",[new.generation]).unwrap();
        let newer=f.build();let third=f.search("needle").0.remove(0);assert_ne!(second.chunk_key,third.chunk_key);assert_eq!(third.snapshot_generation,Some(newer.generation));
    }
    #[test]
    fn partial_read_cursor_is_opaque_and_does_not_skip_multibyte_bytes(){
        let f=Fixture::new();f.write("a.txt","甲乙😀丙丁");let spec=f.build();let note=files::file_id("a.txt");
        let mut view=read_chunk_conn(&f.conn,&f.lib,&note,Some(spec.generation),0,Some(4)).unwrap().unwrap();let mut result=view.content.clone();let mut end=view.end_byte;
        while let Some(cursor)=view.next_cursor.clone(){assert!(!cursor.starts_with('{'));view=read_cursor_conn(&f.conn,&f.lib,&cursor,Some(4)).unwrap();assert_eq!(view.start_byte,end);end=view.end_byte;result.push_str(&view.content);}
        assert_eq!(result,"甲乙😀丙丁");assert!(view.eof);
        assert!(read_cursor_conn(&f.conn,&f.lib,"{\"generation\":1}",None).is_err());
    }
    #[test]
    fn quotas_bad_encoding_and_restart_keep_old_snapshot(){
        let f=Fixture::new();f.write("a.txt",b"stable needle");let old=f.build();f.write("bad.txt",[0xf0,0x9f]);
        let bad=begin_build(&f.conn,"test-owner",&f.lib,"bad").unwrap();assert!(build_snapshot(&f.conn,&bad,&AtomicBool::new(false),&Limits{logical_bytes:1,disk_bytes:u64::MAX,check_space:false}).is_err());
        recover_interrupted(&f.conn).unwrap();assert_eq!(task_row(&f.conn,"test-owner",&f.lib,&bad.id).unwrap().phase,"interrupted");
        assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);assert!(!f.search("needle").0.is_empty());
    }
    #[test]
    fn database_before_snapshot_schema_returns_none_not_error(){
        let conn=Connection::open_in_memory().unwrap();assert!(active_snapshot(&conn,"old-library").unwrap().is_none());
        assert!(snapshot_epoch(&conn,"old-library").unwrap().is_none());
    }
    #[test]
    fn legacy_v1_storage_active_retired_and_old_cursor_are_read_without_duplication(){
        let f=Fixture::new();let source=format!("{}中文 ending\r\nnext line\r\ntail","x".repeat(CHUNK_BYTES-3));f.write("cross.txt",&source);
        let old=f.build();
        // A real SQLite legacy fixture, including its documented empty-string fallback.
        f.conn.execute("UPDATE kb_snap_chunk SET searchText=CASE WHEN searchText='' THEN '' ELSE text||searchText END WHERE createdGeneration=?1",[old.generation]).unwrap();
        f.conn.execute("UPDATE kb_snap_member SET contextVersion=?2 WHERE generation=?1",params![old.generation,LEGACY_CONTEXT_VERSION]).unwrap();
        let storage=||->Vec<(i64,String,String)>{let mut s=f.conn.prepare("SELECT chunkKey,text,searchText FROM kb_snap_chunk WHERE createdGeneration=?1 ORDER BY ordinal").unwrap();s.query_map([old.generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().map(|r|r.unwrap()).collect()};
        let before=storage();assert!(before[0].2.starts_with(&before[0].1));assert!(before.last().unwrap().2.is_empty());
        let q=kb_index::parse_query("中文").unwrap();let hits=f.search("中文").0;assert_eq!(hits.len(),1);assert_eq!(hits[0].ordinal,0);
        assert_eq!(hits[0].chunk_text,source);assert!(hits[0].score<0.0);
        let reference=hit_reference_for_query(&f.conn,&f.lib,old.generation,&hits[0],&q).unwrap();
        assert_eq!(reference.match_start,Some((CHUNK_BYTES-3)as u64));assert_eq!(reference.match_end,Some((CHUNK_BYTES+3)as u64));
        assert_eq!(f.search("文").0[0].ordinal,1);
        let first=read_hit_conn(&f.conn,&f.lib,old.generation,hits[0].chunk_key,Some(2030)).unwrap();
        let cursor=first.next_cursor.clone().unwrap();let lease=acquire_lease(&f.conn,"legacy-v1-owner",&f.lib,old.generation).unwrap();
        let new=f.build();let new_hit=f.search("中文").0.remove(0);assert_ne!(new_hit.chunk_key,hits[0].chunk_key);
        assert_eq!(new_hit.snapshot_generation,Some(new.generation));assert_eq!(new_hit.chunk_text,source);
        gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        let last=read_cursor_conn(&f.conn,&f.lib,&cursor,None).unwrap();assert_eq!(last.start_byte,first.end_byte);
        assert_eq!(format!("{}{}",first.content,last.content),source);assert!(last.eof);
        assert_eq!(read_hit_conn(&f.conn,&f.lib,old.generation,hits[0].chunk_key,None).unwrap().content,source);
        assert_eq!(before,storage(),"reading/rebuilding must not rewrite legacy chunks");
        release_lease("legacy-v1-owner",&lease).unwrap();gc_background(&f.conn,&f.lib,&AtomicBool::new(false)).unwrap();
        assert!(read_cursor_conn(&f.conn,&f.lib,&cursor,None).unwrap_err().contains("SNAPSHOT_EXPIRED"));
    }
    #[test]
    fn unknown_context_fails_explicitly_for_search_hit_and_primary_read(){
        let f=Fixture::new();f.write("a.txt","needle body");let spec=f.build();let hit=f.search("needle").0.remove(0);
        f.conn.execute("UPDATE kb_snap_member SET contextVersion='future-unknown' WHERE generation=?1",[spec.generation]).unwrap();
        assert!(search_library(&f.conn,&f.lib,&kb_index::parse_query("needle").unwrap()).unwrap_err().contains("SNAPSHOT_CONTEXT_UNSUPPORTED"));
        assert!(read_hit_conn(&f.conn,&f.lib,spec.generation,hit.chunk_key,None).unwrap_err().contains("SNAPSHOT_CONTEXT_UNSUPPORTED"));
        assert!(read_chunk_conn(&f.conn,&f.lib,&hit.note_id,Some(spec.generation),0,None).unwrap_err().contains("SNAPSHOT_CONTEXT_UNSUPPORTED"));
    }
    #[test]
    fn slice_lines_follow_crlf_offsets_and_suffix_across_primary_boundaries(){
        let f=Fixture::new();let source=format!("{}\r\nsecond\r\n第三\nlast","x".repeat(CHUNK_BYTES-1));f.write("lines.txt",&source);let spec=f.build();let note=files::file_id("lines.txt");
        let mut view=read_chunk_conn(&f.conn,&f.lib,&note,Some(spec.generation),0,Some(37)).unwrap().unwrap();let mut joined=String::new();
        loop{
            let (start_line,cr)=advance_lines(&source[..view.start_byte],1,false);let(end_line,_)=advance_lines(&view.content,start_line,cr);
            assert_eq!((view.start_line,view.end_line),(start_line,end_line));joined.push_str(&view.content);
            match view.next_cursor.clone(){Some(c)=>view=read_cursor_conn(&f.conn,&f.lib,&c,Some(37)).unwrap(),None=>break}
        }
        assert_eq!(joined,source);
        // Primary 0 ends with CR; its lookahead has LF plus several more lines.
        let key:i64=f.conn.query_row("SELECT chunkKey FROM kb_snap_chunk WHERE createdGeneration=?1 AND ordinal=0",[spec.generation],|r|r.get(0)).unwrap();
        let hit=read_hit_conn(&f.conn,&f.lib,spec.generation,key,None).unwrap();assert_eq!(hit.content,source);assert_eq!((hit.start_line,hit.end_line),(1,4));
        let next=read_chunk_conn(&f.conn,&f.lib,&note,Some(spec.generation),1,None).unwrap().unwrap();assert!(next.content.starts_with('\n'));assert_eq!((next.start_line,next.end_line),(2,4));
    }
    #[test]
    fn batched_inserts_and_file_local_term_cache_do_not_mix_owners(){
        let f=Fixture::new();let a="# Alpha\nbody common\n".repeat(60000);let b="# Beta\nbody common\n".repeat(60000);f.write("alpha.txt",&a);f.write("beta.txt",&b);
        let spec=f.build();
        for(name,source,query)in [("alpha.txt",a,"alpha"),("beta.txt",b,"beta")]{
            let note=files::file_id(name);let mut s=f.conn.prepare("SELECT c.text FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.generation=?1 AND m.noteId=?2 ORDER BY c.ordinal").unwrap();
            let parts=s.query_map(params![spec.generation,note],|r|r.get::<_,String>(0)).unwrap();assert_eq!(parts.map(|p|p.unwrap()).collect::<String>(),source);
            let hits=f.search(query).0;assert!(!hits.is_empty());assert!(hits.iter().all(|h|h.relative_uri==name));
        }
        let task=task_row(&f.conn,"test-owner",&f.lib,&spec.id).unwrap();assert_eq!(task.processed_files,2);assert_eq!(task.phase,"completed");
    }
    #[cfg(windows)]
    #[test]
    fn physical_quota_probe_is_driven_by_write_bytes_time_and_forced_final_check(){
        let dir=std::env::temp_dir().join(new_id("snapshot-disk-guard"));fs::create_dir_all(&dir).unwrap();let path=dir.join("quota.sqlite");
        let conn=Connection::open(&path).unwrap();conn.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE bytes(payload BLOB);INSERT INTO bytes VALUES(zeroblob(65536));").unwrap();
        let limits=Limits{logical_bytes:u64::MAX,disk_bytes:1,check_space:true};
        let mut guard=DiskGuard::new();guard.check(&conn,&limits,1,false).unwrap();
        assert!(guard.check(&conn,&limits,DISK_WRITE_INTERVAL,false).unwrap_err().contains("INDEX_DISK_QUOTA"));
        let mut guard=DiskGuard::new();guard.last_probe=Instant::now()-PROGRESS_INTERVAL;
        assert!(guard.check(&conn,&limits,0,false).unwrap_err().contains("INDEX_DISK_QUOTA"));
        assert!(DiskGuard::new().check(&conn,&limits,0,true).unwrap_err().contains("INDEX_DISK_QUOTA"));
        drop(conn);fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn parse_and_copy_flush_probe_disk_even_when_hash_counter_has_stopped(){
        for reuse in [false,true]{
            let mut f=Fixture::new();f.write("a.txt","stable needle\r\n");let old=f.build();
            let run=std::env::temp_dir().join(new_id("snapshot-disk-pipeline"));fs::create_dir_all(&run).unwrap();let db_path=run.join("snapshot.sqlite");
            f.conn.execute("VACUUM INTO ?1",[db_path.to_string_lossy().as_ref()]).unwrap();f.conn=Connection::open(&db_path).unwrap();f.conn.execute_batch("PRAGMA journal_mode=WAL").unwrap();
            if !reuse{f.write("a.txt","changed needle\r\n");}
            let spec=begin_build(&f.conn,"test-owner",&f.lib,&new_id("req")).unwrap();let cancel=AtomicBool::new(false);
            let limits=Limits{logical_bytes:16*1024*1024,disk_bytes:1,check_space:true};
            let mut builder=Builder{conn:&f.conn,spec:&spec,cancel:&cancel,limits:&limits,fts:fts_name(spec.generation).unwrap(),pending:Vec::new(),pending_bytes:0,logical:0,processed:0,files:0,chunks:0,last_progress:Instant::now(),disk:DiskGuard{last_probe:Instant::now(),written:DISK_WRITE_INTERVAL-1},note:String::new(),parse:String::new(),title:String::new(),relative:String::new(),term_cache:None,engine_writer:None,source_hash:None};
            let error=builder.file("a.txt").unwrap_err();assert!(error.contains("INDEX_DISK_QUOTA"),"{error}");
            assert!(builder.processed>0,"source hash must have really run");assert!(builder.chunks>0,"must reach the write batch, not just the initial/hash probe");
            let key:i64=f.conn.query_row("SELECT count(*) FROM kb_snap_chunk WHERE createdGeneration=?1",[spec.generation],|r|r.get(0)).unwrap();assert_eq!(key==0,reuse,"copy must reuse chunk keys, parse must insert new chunks");
            assert_eq!(active_snapshot(&f.conn,&f.lib).unwrap().unwrap().generation,old.generation);
            drop(builder);drop(f);fs::remove_dir_all(run).unwrap();
        }
    }
    #[test]
    #[ignore = "Uses CR055_FIXTURE_ROOT and explicitly bounded CR055_INDEX_QUOTA_GIB; run only under lead's benchmark coordination"]
    fn snapshot_external_fixture_benchmark(){
        let fixture_root=PathBuf::from(std::env::var_os("CR055_FIXTURE_ROOT").expect("set CR055_FIXTURE_ROOT to existing fixtures"));
        let subdir=std::env::var("CR055_INDEX_SUBDIR").unwrap_or_else(|_|"knowledge".into());
        assert!(["knowledge","large"].contains(&subdir.as_str()),"supported fixture subdir knowledge or large");
        let source=fs::canonicalize(fixture_root.join(subdir)).unwrap();
        let workspace=std::env::var_os("CR055_BENCH_WORKDIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let run=workspace.join(new_id("kb-snapshot-bench"));fs::create_dir_all(&run).unwrap();
        let db_path=run.join("snapshot.sqlite");let conn=Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA cache_size=-8192; CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,sourceRef TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,sourceKind TEXT NOT NULL DEFAULT 'managed-directory'); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT);CREATE INDEX legacy_lookup ON knowledge_note_index(libraryId,relativeUri);").unwrap();
        let library=new_id("bench-library");conn.execute("INSERT INTO knowledge_library(id,sourceRef)VALUES(?1,?2)",params![library,source.to_string_lossy()]).unwrap();performance::migrate(&conn).unwrap();migrate(&conn).unwrap();
        let quota:u64=std::env::var("CR055_INDEX_QUOTA_GIB").unwrap_or_else(|_|"64".into()).parse().unwrap();assert!((1..=256).contains(&quota));
        STAGE_STATS.with(|s|*s.borrow_mut()=StageStats::default());
        let creating=Instant::now();let spec=begin_build(&conn,"benchmark",&library,"benchmark").unwrap();let create_seconds=creating.elapsed().as_secs_f64();let started=Instant::now();
        let outcome=build_snapshot(&conn,&spec,&AtomicBool::new(false),&Limits{logical_bytes:quota*1024*1024*1024,disk_bytes:quota*1024*1024*1024,check_space:true});
        let elapsed=started.elapsed();sample_wal(&conn);
        let task=task_row(&conn,"benchmark",&library,&spec.id).unwrap();
        let bytes=fs::metadata(&db_path).unwrap().len();let wal=fs::metadata(format!("{}-wal",db_path.display())).map(|m|m.len()).unwrap_or(0);
        let (members,source_sum):(i64,i64)=conn.query_row("SELECT count(*),coalesce(sum(cast(sourceSize AS INTEGER)),0) FROM kb_snap_member WHERE generation=?1",[spec.generation],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let (chunks,text_bytes,suffix_bytes):(i64,i64,i64)=conn.query_row("SELECT count(*),coalesce(sum(length(cast(c.text AS BLOB))),0),coalesce(sum(length(cast(c.searchText AS BLOB))),0) FROM kb_snap_member m JOIN kb_snap_chunk c ON c.libraryId=m.libraryId AND c.noteId=m.noteId AND c.parseGeneration=m.parseGeneration WHERE m.generation=?1",[spec.generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        let pragma=|name:&str|->i64{conn.query_row(&format!("PRAGMA {name}"),[],|r|r.get(0)).unwrap()};
        let pragmas=serde_json::json!({"synchronous":pragma("synchronous"),"cacheSize":pragma("cache_size"),"pageSize":pragma("page_size"),"walAutocheckpoint":pragma("wal_autocheckpoint"),"tempStore":pragma("temp_store"),"journalMode":conn.query_row("PRAGMA journal_mode",[],|r|r.get::<_,String>(0)).unwrap()});
        let pages=serde_json::json!({"pageCount":pragma("page_count"),"pageSize":pragma("page_size"),"freelistCount":pragma("freelist_count")});
        let mut manifest_identity=serde_json::Value::Null;
        let mut manifest_verified:Option<bool>=None;
        if let Ok(data)=fs::read(fixture_root.join("manifest.json")){
            let manifest:serde_json::Value=serde_json::from_slice(&data).unwrap();
            manifest_identity=manifest.get("manifestSha256").cloned().unwrap_or_default();
            let mut valid=outcome.is_ok()&&manifest["sourceFiles"].as_i64()==Some(members)&&manifest["sourceBytes"].as_i64()==Some(source_sum);
            if let Some(files)=manifest["files"].as_array(){for file in files{
                let actual:Option<(String,i64)>=conn.query_row("SELECT sourceHash,cast(sourceSize AS INTEGER) FROM kb_snap_member WHERE generation=?1 AND relativeUri=?2",params![spec.generation,file["relative"].as_str().unwrap()],|r|Ok((r.get(0)?,r.get(1)?))).optional().unwrap();
                valid&=actual.as_ref().is_some_and(|(hash,size)|Some(*size)==file["bytes"].as_i64()&&hash.strip_prefix("sha256:")==file["sha256"].as_str());
            }}else{valid=false;}
            manifest_verified=Some(valid);
        }
        let mut searches=Vec::new();
        if outcome.is_ok(){for needle in ["doc0","中文索引","baseline"]{
            let q=kb_index::parse_query(needle).unwrap();let(hits,incomplete)=search_library(&conn,&library,&q).unwrap().unwrap();
            searches.push(serde_json::json!({"needle":needle,"hits":hits.len(),"incomplete":incomplete,"nonzeroBm25":hits.iter().any(|h|h.score!=0.0),"bm25Sorted":hits.windows(2).all(|h|h[0].score<=h[1].score),"literalVerified":hits.iter().all(|h|owned_match(&h.chunk_text,usize::MAX,&h.title,&h.heading,&q).is_some())}));
        }}
        let (stages,peak)=STAGE_STATS.with(|s|{let s=s.borrow();(s.elapsed.map(|d|d.as_secs_f64()),s.wal_sampled_peak)});
        let phase_seconds=serde_json::json!({"createGeneration":create_seconds,"hash":stages[Stage::Hash as usize],"parse":stages[Stage::Parse as usize],"insertBatches":stages[Stage::Insert as usize],"validation":stages[Stage::Validation as usize],"optimize":stages[Stage::Optimize as usize],"publish":stages[Stage::Publish as usize],"copyParse":stages[Stage::Copy as usize],"discoveryMemberProgressAndOther":(elapsed.as_secs_f64()-stages.iter().sum::<f64>()).max(0.0)});
        // Preserve legacy dbBytes/walBytes before this explicitly reported post-build checkpoint.
        let checkpoint:(i64,i64,i64)=conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        let report=serde_json::json!({"kind":"real-streaming-snapshot-index","source":source,"database":db_path,"elapsedMs":elapsed.as_millis(),"processedFiles":task.processed_files,"sourceBytesHashed":task.processed_bytes,"dbBytes":bytes,"walBytes":wal,"maxBatchRows":MAX_BATCH_ROWS,"maxBatchPayloadBytes":MAX_BATCH_BYTES,"quotaGiB":quota,"success":outcome.is_ok(),"error":outcome.as_ref().err(),"memoryMeasuredExternally":false,"memoryBytes":null,"phaseSeconds":phase_seconds,"phaseTiming":"test-only thread-local exclusive nested timers; insert includes checks/progress; residual includes member commits/discovery/bookkeeping; elapsed excludes create-generation as before","actualMemberFiles":members,"actualMemberSourceBytes":source_sum,"chunks":chunks,"primaryTextBytes":text_bytes,"suffixBytes":suffix_bytes,"sourceManifestIdentity":manifest_identity,"memberSourceHashesMatchManifest":manifest_verified,"sqliteVersion":rusqlite::version(),"pragmas":pragmas,"pages":pages,"searchChecks":searches,"walSampledPeakBytes":peak,"walPeakMethod":"sample after each committed chunk batch and after optimize; not an exact OS peak","checkpoint":{"busy":checkpoint.0,"logFrames":checkpoint.1,"checkpointedFrames":checkpoint.2},"afterCheckpointDbBytes":fs::metadata(&db_path).unwrap().len(),"afterCheckpointWalBytes":fs::metadata(format!("{}-wal",db_path.display())).map(|m|m.len()).unwrap_or(0)});
        fs::write(run.join("report.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();println!("{report}");
        outcome.unwrap();
        assert!(active_snapshot(&conn,&library).unwrap().is_some());
        // Preserve only this isolated benchmark DB/report for the lead's subsequent queries and cleanup.
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    #[test]
    fn hashes_keep_algorithm_and_original_bytes() {
        let h = hash_reader(&mut std::io::Cursor::new(b"hello"), &AtomicBool::new(false)).unwrap();
        assert_eq!(h.sha256, "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(h.fnv, "fnv1a64:a430d84680aabd0b");
        assert_eq!(h.bytes, 5);
        assert_ne!(h.sha256, h.fnv);
    }
    #[test]
    fn empty_and_cancelled_hashes_do_not_fabricate_input() {
        let h = hash_reader(&mut std::io::empty(), &AtomicBool::new(false)).unwrap();
        assert_eq!(h.sha256, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(h.bytes, 0);
        assert!(hash_reader(&mut std::io::empty(), &AtomicBool::new(true)).is_err());
    }
    #[test]
    fn decoder_handles_utf16_surrogate_and_rejects_bad_tail() {
        let source = "标题😀\r\n尾行";
        let mut bytes = vec![0xff, 0xfe];
        for c in source.encode_utf16() { bytes.extend_from_slice(&c.to_le_bytes()); }
        let mut actual = String::new();
        decode_reader(&mut std::io::Cursor::new(&bytes), &AtomicBool::new(false), |s| {actual.push_str(s); Ok(())}).unwrap();
        assert_eq!(actual, source);
        bytes.push(0x00);
        assert!(decode_reader(&mut std::io::Cursor::new(bytes), &AtomicBool::new(false), |_| Ok(())).is_err());
        assert!(decode_reader(&mut std::io::Cursor::new([0xf0,0x9f]), &AtomicBool::new(false), |_| Ok(())).is_err());
    }
    #[test]
    fn long_unicode_line_is_bounded_lossless_and_contiguous() {
        let source = format!("# 标题\r\n{}\r\nend", "你😀x".repeat(20000));
        let mut chunks = Vec::new();
        let mut chunker = Chunker::new(true);
        decode_reader(&mut std::io::Cursor::new(source.as_bytes()), &AtomicBool::new(false), |s| chunker.feed(s, &mut |c| {chunks.push(c);Ok(())})).unwrap();
        chunker.flush(&mut |c| {chunks.push(c);Ok(())}).unwrap();
        let mut end = 0;
        let mut joined = String::new();
        for (ordinal,c) in chunks.iter().enumerate() {
            assert!(c.text.len() <= CHUNK_BYTES);
            assert_eq!(c.ordinal, ordinal);
            assert_eq!(c.start, end);
            assert_eq!(c.end-c.start, c.text.len() as u64);
            assert!(c.start_line <= c.end_line);
            joined.push_str(&c.text); end = c.end;
        }
        assert_eq!(joined, source);
        assert_eq!(end, source.len() as u64);
        assert_eq!(chunks.last().unwrap().end_line, 3);
    }
}
