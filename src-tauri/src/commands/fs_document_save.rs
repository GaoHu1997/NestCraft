//! FEAT-007: handle-pinned, durable and recoverable two-rename save.
use super::{guard, resources};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{ErrorKind, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU8, Ordering}}, time::{Duration, SystemTime}};
use tauri::WebviewWindow;
const BLOCK: usize = 65536;
const JOURNAL_LIMIT: u64 = 4 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveStatus {
    pub request_id: String, pub submitted_revision: String, pub phase: String,
    pub next_seq: u64, pub written_bytes: String, pub source_hash: Option<String>,
    pub source_bytes: Option<String>, pub committed_revision: Option<String>,
    pub cancel_too_late: bool, pub needs_recovery: bool, pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    version: u32, request_id: String, submitted_revision: String,
    owner: String, process: String, root: PathBuf, root_id: String,
    parent_id: String, source_id: String, temp_id: Option<String>,
    target: PathBuf, temp: PathBuf, backup: PathBuf, expected_hash: String,
    submitted_hash: String, encoding: String, total: u64, written: u64,
    next_seq: u64, phase: String, error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Row { seq: u64, previous: String, record: Record, hash: String }
struct Journal { file: File, seq: u64, previous: String }
struct Save {
    record: Record, pins: guard::RootedPath, file: Option<File>, journal: Option<Journal>,
    last: Option<(u64, String)>, lock: Option<guard::FilePermit>,
}
struct Operation {
    owner: String, root_id: String, instance: Arc<guard::Instance>,
    cancel: AtomicBool, phase: AtomicU8, snapshot: Mutex<SaveStatus>, state: Mutex<Save>,
}
static SAVES: OnceLock<Mutex<HashMap<String, Arc<Operation>>>> = OnceLock::new();
static RECOVERY: OnceLock<PathBuf> = OnceLock::new();
static PROCESS: OnceLock<String> = OnceLock::new();
fn process() -> &'static str { PROCESS.get_or_init(|| uuid::Uuid::new_v4().to_string()) }
fn saves() -> &'static Mutex<HashMap<String, Arc<Operation>>> { SAVES.get_or_init(Default::default) }
pub fn initialize_recovery(path: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if let Some(old) = RECOVERY.get() { return if old == &path { Ok(()) } else { Err("RECOVERY_ALREADY_INITIALIZED".into()) }; }
    RECOVERY.set(path).map_err(|_| "RECOVERY_ALREADY_INITIALIZED".into())
}
fn log_path(id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(RECOVERY.get().ok_or("RECOVERY_NOT_INITIALIZED")?.join(format!("{id}.jsonl")))
}
fn validate_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "REQUEST_ID_INVALID")?;
    if parsed.to_string() != id { return Err("REQUEST_ID_INVALID".into()); }
    Ok(())
}
fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 71 || !hash.starts_with("sha256:") || !hash[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("HASH_INVALID".into()); }
    Ok(())
}
fn digest(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }
fn row_hash(seq: u64, previous: &str, record: &Record) -> Result<String, String> {
    Ok(digest(&serde_json::to_vec(&(seq, previous, record)).map_err(|e| e.to_string())?))
}
impl Journal {
    fn create(id: &str) -> Result<Self, String> {
        let mut options = OpenOptions::new(); options.write(true).read(true).create_new(true);
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0).custom_flags(0x00200000 | 0x80000000); }
        let file = options.open(log_path(id)?).map_err(|e| format!("REQUEST_ALREADY_EXISTS: {e}"))?;
        Ok(Self { file, seq: 0, previous: String::new() })
    }
    fn append(&mut self, record: &Record) -> Result<(), String> {
        let hash = row_hash(self.seq, &self.previous, record)?;
        let row = Row { seq: self.seq, previous: self.previous.clone(), record: record.clone(), hash: hash.clone() };
        let mut bytes = serde_json::to_vec(&row).map_err(|e| e.to_string())?; bytes.push(b'\n');
        if self.file.metadata().map_err(|e| e.to_string())?.len() + bytes.len() as u64 > JOURNAL_LIMIT { return Err("JOURNAL_TOO_LARGE".into()); }
        self.file.write_all(&bytes).and_then(|_| self.file.sync_all()).map_err(|e| format!("JOURNAL_NOT_DURABLE: {e}"))?;
        self.seq += 1; self.previous = hash; Ok(())
    }
}
fn status(record: &Record, late: bool) -> SaveStatus {
    let committed = record.phase == "committed";
    SaveStatus { request_id: record.request_id.clone(), submitted_revision: record.submitted_revision.clone(),
        phase: record.phase.clone(), next_seq: record.next_seq, written_bytes: record.written.to_string(),
        source_hash: committed.then(|| record.submitted_hash.clone()), source_bytes: committed.then(|| record.total.to_string()),
        committed_revision: committed.then(|| record.submitted_revision.clone()), cancel_too_late: late,
        needs_recovery: record.phase == "needs_recovery", error: record.error.clone() }
}
fn publish(op: &Operation, save: &Save) -> Result<SaveStatus, String> {
    let value = status(&save.record, op.cancel.load(Ordering::Acquire) && op.phase.load(Ordering::Acquire) >= 2);
    *op.snapshot.lock().map_err(|_| "SAVE_BUSY")? = value.clone(); Ok(value)
}
fn persist(save: &mut Save, phase: &str) -> Result<(), String> {
    // Memory must not advertise an outcome which failed to reach durable storage.
    let mut next = save.record.clone(); next.phase = phase.into();
    save.journal.as_mut().ok_or("JOURNAL_CLOSED")?.append(&next)?; save.record = next; Ok(())
}
fn fail(op: &Operation, save: &mut Save, error: String, recovery: bool) -> Result<SaveStatus, String> {
    save.record.error = Some(error);
    let phase = if recovery { "needs_recovery" } else { "failed" };
    if persist(save, phase).is_err() { save.record.phase = "needs_recovery".into(); }
    op.phase.store(3, Ordering::Release);
    save.file.take(); save.lock.take(); publish(op, save)
}
fn cancelled(op: &Operation) -> Result<(), String> {
    if op.cancel.load(Ordering::Acquire) || !op.instance.alive.load(Ordering::Acquire) { Err("SAVE_CANCELLED".into()) } else { Ok(()) }
}
fn hash_file(file: &mut File, cancel: Option<&Operation>) -> Result<(u64, String), String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new(); let mut buffer = [0u8; BLOCK]; let mut length = 0u64;
    loop { if let Some(op) = cancel { cancelled(op)?; }
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; } hash.update(&buffer[..n]); length += n as u64;
    }
    Ok((length, format!("sha256:{:x}", hash.finalize())))
}
fn encode(enc: &str, text: &str) -> Result<Vec<u8>, String> {
    if text.len() > BLOCK { return Err("SAVE_BLOCK_TOO_LARGE".into()); }
    match enc { "utf-8" | "utf-8-bom" => Ok(text.as_bytes().to_vec()),
        "utf-16le" => Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect()),
        "utf-16be" => Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect()), _ => Err("ENCODING_REQUIRED".into()) }
}
fn owner_for(window: &WebviewWindow, root_uri: &str) -> Result<(String, guard::RootedPath, Arc<guard::Instance>), String> {
    let root = guard::RootedPath::new(root_uri, "", false)?;
    let instance = guard::instance(window.label())?; guard::live(&instance)?;
    Ok((format!("{}\n{}\n{}", instance.label, instance.nonce, root.root_id), root, instance))
}
fn scoped(window: &WebviewWindow, root: &str, id: &str) -> Result<Arc<Operation>, String> {
    validate_id(id)?; let (owner, pins, _) = owner_for(window, root)?;
    let op = saves().lock().map_err(|_| "SAVE_BUSY")?.get(id).cloned().ok_or("SAVE_NOT_FOUND")?;
    if op.owner != owner || op.root_id != pins.root_id { return Err("SAVE_SCOPE".into()); } Ok(op)
}
// Repeated begin is read-only: it returns the state already persisted by the first
// begin and must never append a second intent row or touch recovery material.
fn duplicate_begin(op: &Operation, owner: &str, root_uri: &str, path: &str, submitted_revision: &str,
    expected_hash: &str, submitted_hash: &str, total: u64, encoding: &str) -> Result<SaveStatus, String> {
    if op.owner != owner { return Err("SAVE_SCOPE".into()); }
    let save = op.state.try_lock().map_err(|_| "SAVE_IN_PROGRESS")?;
    if save.record.submitted_revision != submitted_revision || save.record.expected_hash != expected_hash
        || save.record.submitted_hash != submitted_hash || save.record.total != total
        || save.record.encoding != encoding || guard::RootedPath::new(root_uri, path, false)?.path != save.record.target {
        return Err("REQUEST_ID_REUSED".into());
    }
    Ok(status(&save.record, false))
}
#[tauri::command]
pub async fn fs_perf_save_begin_v2(window: WebviewWindow, root_uri: String, path: String,
    request_id: String, submitted_revision: String, expected_hash: String, encoding: String,
    total_bytes: String, submitted_hash: String) -> Result<SaveStatus, String> {
    validate_id(&request_id)?; validate_id(&submitted_revision)?; validate_hash(&expected_hash)?; validate_hash(&submitted_hash)?;
    encode(&encoding, "")?; let total = total_bytes.parse::<u64>().map_err(|_| "SAVE_ARGUMENTS_INVALID")?;
    let permit = resources::admit(BLOCK * 4)?;
    let (owner, root, instance) = owner_for(&window, &root_uri)?;
    if let Some(op) = saves().lock().map_err(|_| "SAVE_BUSY")?.get(&request_id).cloned() {
        return duplicate_begin(&op, &owner, &root_uri, &path, &submitted_revision, &expected_hash, &submitted_hash, total, &encoding);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit; guard::live(&instance)?;
        let pins = guard::RootedPath::new(&root_uri, &path, false)?;
        if pins.root_id != root.root_id { return Err("ROOT_CHANGED".into()); }
        let mut source = pins.read()?; let source_id = guard::identity(&source)?;
        let lock = guard::lock_file(&source_id)?;
        if hash_file(&mut source, None)?.1 != expected_hash { return Err("BASELINE_CHANGED".into()); }
        let temp = pins.path.with_file_name(format!(".nestcraft-editor-{request_id}.tmp"));
        let backup = pins.path.with_file_name(format!(".nestcraft-editor-{request_id}.backup"));
        if temp.exists() || backup.exists() { return Err("SAVE_MATERIAL_EXISTS".into()); }
        let record = Record { version: 1, request_id: request_id.clone(), submitted_revision,
            owner: owner.clone(), process: process().into(), root: pins.root.clone(), root_id: pins.root_id.clone(),
            parent_id: pins.parent_id.clone(), source_id, temp_id: None, target: pins.path.clone(), temp, backup,
            expected_hash, submitted_hash, encoding, total, written: 0, next_seq: 0, phase: "intent".into(), error: None };
        let mut journal = Journal::create(&request_id)?;
        journal.append(&record)?; // Durable intent precedes the creation of recovery material.
        let file = guard::exclusive(&record.temp, true)?;
        let mut save = Save { record, pins, file: Some(file), journal: Some(journal), last: None, lock: Some(lock) };
        save.record.temp_id = Some(guard::identity(save.file.as_ref().ok_or("SAVE_PHASE")?)?);
        persist(&mut save, "staging")?;
        let op = Arc::new(Operation { owner, root_id: save.record.root_id.clone(), instance,
            cancel: AtomicBool::new(false), phase: AtomicU8::new(0), snapshot: Mutex::new(status(&save.record, false)), state: Mutex::new(save) });
        let mut map = saves().lock().map_err(|_| "SAVE_BUSY")?;
        if map.len() >= 128 { return Err("SAVE_REGISTRY_FULL".into()); }
        guard::live(&op.instance)?; map.insert(request_id, op.clone()); drop(map);
        let mut save = op.state.lock().map_err(|_| "SAVE_BUSY")?;
        let bom: &[u8] = match save.record.encoding.as_str() { "utf-8-bom" => &[0xef,0xbb,0xbf], "utf-16le" => &[0xff,0xfe], "utf-16be" => &[0xfe,0xff], _ => &[] };
        if total < bom.len() as u64 { return fail(&op, &mut save, "SAVE_TOTAL_TOO_SMALL".into(), false); }
        if let Err(e) = save.file.as_mut().ok_or("SAVE_PHASE")?.write_all(bom) { return fail(&op, &mut save, e.to_string(), false); }
        save.record.written = bom.len() as u64; publish(&op, &save)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn fs_perf_save_append_v2(window: WebviewWindow, root_uri: String, request_id: String, seq: u64, text: String) -> Result<SaveStatus, String> {
    if text.len() > BLOCK { return Err("SAVE_BLOCK_TOO_LARGE".into()); }
    let permit = resources::admit(BLOCK * 4)?; let op = scoped(&window, &root_uri, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit; let mut save = op.state.lock().map_err(|_| "SAVE_BUSY")?;
        if save.record.phase != "staging" { return Err("SAVE_PHASE".into()); }
        if let Err(e) = cancelled(&op) { return fail(&op, &mut save, e, false); }
        let bytes = encode(&save.record.encoding, &text)?; let hash = digest(&bytes);
        if save.last.as_ref() == Some(&(seq, hash.clone())) { return publish(&op, &save); }
        if seq != save.record.next_seq { return Err("SAVE_SEQUENCE".into()); }
        if save.record.written.checked_add(bytes.len() as u64).filter(|n| *n <= save.record.total).is_none() { return fail(&op, &mut save, "SAVE_SIZE_MISMATCH".into(), false); }
        if let Err(e) = save.file.as_mut().ok_or("SAVE_PHASE")?.write_all(&bytes) { return fail(&op, &mut save, format!("SAVE_POISONED: {e}"), false); }
        save.record.written += bytes.len() as u64; save.record.next_seq += 1; save.last = Some((seq, hash)); publish(&op, &save)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn fs_perf_save_seal_v2(window: WebviewWindow, root_uri: String, request_id: String, expected_chunks: u64) -> Result<SaveStatus, String> {
    let permit = resources::admit(BLOCK * 4)?; let op = scoped(&window, &root_uri, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit; let mut save = op.state.lock().map_err(|_| "SAVE_BUSY")?;
        if save.record.phase == "sealed" && save.record.next_seq == expected_chunks { return publish(&op, &save); }
        if save.record.phase != "staging" { return Err("SAVE_PHASE".into()); }
        if save.record.next_seq != expected_chunks || save.record.written != save.record.total { return Err("SAVE_SIZE_MISMATCH".into()); }
        let temp_id = guard::identity(save.file.as_ref().ok_or("SAVE_PHASE")?)?;
        if save.record.temp_id.as_ref() != Some(&temp_id) { return fail(&op, &mut save, "TEMP_CHANGED".into(), false); }
        let actual = hash_file(save.file.as_mut().ok_or("SAVE_PHASE")?, Some(&op));
        match actual { Ok((n, h)) if n == save.record.total && h == save.record.submitted_hash => (), Ok(_) => return fail(&op, &mut save, "SAVE_HASH_MISMATCH".into(), false), Err(e) => return fail(&op, &mut save, e, false) }
        if let Err(e) = save.file.as_ref().ok_or("SAVE_PHASE")?.sync_all() { return fail(&op, &mut save, e.to_string(), false); }
        if let Err(e) = persist(&mut save, "sealed") { return fail(&op, &mut save, e, true); }
        op.phase.store(1, Ordering::Release); publish(&op, &save)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn fs_perf_save_commit_v2(window: WebviewWindow, root_uri: String, request_id: String) -> Result<SaveStatus, String> {
    let permit = resources::admit(BLOCK * 4)?; let op = scoped(&window, &root_uri, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit; let mut save = op.state.lock().map_err(|_| "SAVE_BUSY")?;
        if save.record.phase == "committed" { return publish(&op, &save); }
        if save.record.phase != "sealed" { return Err("SAVE_PHASE".into()); }
        let result = commit_core(&op, &mut save);
        match result { Ok(()) => { op.phase.store(3, Ordering::Release); save.file.take(); save.lock.take(); publish(&op, &save) }, Err(e) => { let recovery = op.phase.load(Ordering::Acquire) >= 2; fail(&op, &mut save, e, recovery) } }
    }).await.map_err(|e| e.to_string())?
}
fn commit_core(op: &Operation, save: &mut Save) -> Result<(), String> {
    cancelled(op)?; save.pins.verify()?;
    let mut source = save.pins.exclusive()?;
    if guard::identity(&source)? != save.record.source_id || hash_file(&mut source, Some(op))?.1 != save.record.expected_hash { return Err("BASELINE_CHANGED".into()); }
    // Both hashes are checked while their exclusive handles and all parent pins remain held.
    let actual = hash_file(save.file.as_mut().ok_or("SAVE_PHASE")?, Some(op))?;
    if actual != (save.record.total, save.record.submitted_hash.clone()) { return Err("TEMP_CHANGED".into()); }
    save.pins.verify()?; cancelled(op)?; persist(save, "committing")?;
    publish(op, save)?; cancelled(op)?;
    // No disk journal sync, hash, registry lock or cancellation wait between these renames.
    rename_handle(&source, &save.record.backup)?;
    op.phase.store(2, Ordering::Release);
    if let Err(e) = rename_handle(save.file.as_ref().ok_or("SAVE_PHASE")?, &save.record.target) {
        // Never overwrite a competitor; leave all material for reconciliation on failure.
        let _ = rename_handle(&source, &save.record.target); return Err(e);
    }
    persist(save, "replaced")?;
    save.file.as_ref().ok_or("SAVE_PHASE")?.sync_all().map_err(|e| format!("FILE_NOT_DURABLE: {e}"))?;
    source.sync_all().map_err(|e| format!("BACKUP_NOT_DURABLE: {e}"))?;
    persist(save, "durability")?; persist(save, "committed")?;
    // Backup is deliberately retained. Cleanup is outside the success hot path:
    // it belongs to the separate reclaim entry `gc_materials` (see the section
    // below), so a slow or failing delete can never delay or poison a commit.
    Ok(())
}
#[cfg(windows)]
fn rename_handle(file: &File, destination: &Path) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::{ffi::OsStrExt, io::AsRawHandle}};
    #[repr(C)] struct Info { replace: u8, root: *mut c_void, name_bytes: u32, name: [u16; 1] }
    #[link(name="kernel32")] extern "system" { fn SetFileInformationByHandle(file: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32; }
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(Info, name);
    let size = (offset + name.len() * 2).max(std::mem::size_of::<Info>());
    // Word-aligned backing avoids dereferencing an unaligned byte Vec as an FFI struct.
    // Keep one usize of tail slack: with an exactly aligned buffer SetFileInformationByHandle
    // returned ERROR_INVALID_NAME for long paths in the CR-055 fault test.
    let mut storage = vec![0usize; (size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>() + 1];
    unsafe { let bytes = storage.as_mut_ptr().cast::<u8>(); let p = bytes.cast::<Info>();
        (*p).replace = 0; (*p).root = std::ptr::null_mut(); (*p).name_bytes = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), bytes.add(offset).cast::<u16>(), name.len());
        if SetFileInformationByHandle(file.as_raw_handle(), 3, bytes.cast(), size as u32) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    } Ok(())
}
#[cfg(not(windows))]
fn rename_handle(_file: &File, _destination: &Path) -> Result<(), String> { Err("SAFE_PLATFORM_UNAVAILABLE".into()) }
#[tauri::command]
pub async fn fs_perf_save_status_v2(window: WebviewWindow, root_uri: String, request_id: String) -> Result<SaveStatus, String> {
    let (owner, pins, _) = owner_for(&window, &root_uri)?; validate_id(&request_id)?;
    if let Some(op) = saves().lock().map_err(|_| "SAVE_BUSY")?.get(&request_id).cloned() {
        if op.owner != owner { return Err("SAVE_SCOPE".into()); }
        return Ok(op.snapshot.lock().map_err(|_| "SAVE_BUSY")?.clone());
    }
    let permit = resources::admit(BLOCK * 4)?;
    tauri::async_runtime::spawn_blocking(move || { let _permit = permit; reconcile(&owner, &pins.root_id, &request_id) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn fs_perf_save_abort_v2(window: WebviewWindow, root_uri: String, request_id: String) -> Result<SaveStatus, String> {
    let op = scoped(&window, &root_uri, &request_id)?;
    op.cancel.store(true, Ordering::Release);
    let mut value = op.snapshot.lock().map_err(|_| "SAVE_BUSY")?.clone();
    value.cancel_too_late = op.phase.load(Ordering::Acquire) >= 2;
    // No operation removal and no long-I/O mutex acquisition on cancellation.
    if let Ok(mut save) = op.state.try_lock() { if matches!(save.record.phase.as_str(), "staging" | "sealed") {
        persist(&mut save, "cancelled")?; save.file.take(); save.lock.take(); op.phase.store(3, Ordering::Release); value = publish(&op, &save)?;
    } } Ok(value)
}
#[tauri::command]
pub fn fs_perf_save_release_v2(window: WebviewWindow, root_uri: String, request_id: String) -> Result<(), String> {
    let op = scoped(&window, &root_uri, &request_id)?;
    if op.phase.load(Ordering::Acquire) != 3 { return Err("SAVE_IN_PROGRESS".into()); }
    let _state = op.state.try_lock().map_err(|_| "SAVE_IN_PROGRESS")?;
    saves().lock().map_err(|_| "SAVE_BUSY")?.remove(&request_id); Ok(())
}
pub fn destroy_instance(instance: &guard::Instance) {
    // Destroyed 的窗口不能继续占用保存注册表或 journal 句柄：先持久化 cancelled，
    // 再在确认没有活跃写入（拿到状态锁）后移除。移除后仍可通过 reconcile 从 journal
    // 读到同一终态，因为 status 命令在内存未命中时会回退磁盘对账。
    let mut released: Vec<String> = Vec::new();
    if let Ok(map) = saves().lock() {
        for (id, op) in map.iter() {
            if op.instance.nonce != instance.nonce { continue; }
            op.cancel.store(true, Ordering::Release);
            if let Ok(mut save) = op.state.try_lock() {
                if matches!(save.record.phase.as_str(), "staging" | "sealed") {
                    let _ = persist(&mut save, "cancelled");
                    save.file.take(); save.lock.take(); save.journal.take();
                    op.phase.store(3, Ordering::Release);
                    let _ = publish(op, &save);
                }
                released.push(id.clone());
            }
        }
    }
    if released.is_empty() { return; }
    if let Ok(mut map) = saves().lock() { for id in released { map.remove(&id); } }
}
fn read_journal(file: &mut File, id: &str) -> Result<(Record, u64, String), String> {
    if file.metadata().map_err(|e| e.to_string())?.len() > JOURNAL_LIMIT { return Err("JOURNAL_TOO_LARGE".into()); }
    let mut bytes = Vec::new(); file.take(JOURNAL_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if !bytes.ends_with(b"\n") { return Err("JOURNAL_CORRUPT".into()); }
    let text = std::str::from_utf8(&bytes).map_err(|_| "JOURNAL_CORRUPT")?;
    let mut seq = 0; let mut previous = String::new(); let mut latest = None;
    for line in text.lines() { let row: Row = serde_json::from_str(line).map_err(|_| "JOURNAL_CORRUPT")?;
        if row.seq != seq || row.previous != previous || row.hash != row_hash(row.seq, &row.previous, &row.record)? || row.record.request_id != id || row.record.version != 1 { return Err("JOURNAL_CORRUPT".into()); }
        if let Some(ref old) = latest { let old: &Record = old;
            if old.root_id != row.record.root_id || old.source_id != row.record.source_id || old.target != row.record.target || old.submitted_hash != row.record.submitted_hash || old.submitted_revision != row.record.submitted_revision { return Err("JOURNAL_CORRUPT".into()); }
        }
        seq += 1; previous = row.hash; latest = Some(row.record);
    } Ok((latest.ok_or("JOURNAL_CORRUPT")?, seq, previous))
}
fn reconcile(owner: &str, root_id: &str, id: &str) -> Result<SaveStatus, String> {
    let mut options = OpenOptions::new(); options.read(true).write(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0).custom_flags(0x00200000 | 0x80000000); }
    let mut file = options.open(log_path(id)?).map_err(|e| format!("SAVE_NOT_FOUND_OR_BUSY: {e}"))?;
    let (mut record, seq, previous) = read_journal(&mut file, id)?;
    if record.root_id != root_id || (record.process == process() && record.owner != owner) { return Err("SAVE_SCOPE".into()); }
    validate_hash(&record.expected_hash)?; validate_hash(&record.submitted_hash)?;
    // A durable terminal outcome is immutable. Status must never alter the target,
    // restore a backup, or append a different outcome after commit/failure/cancel.
    if matches!(record.phase.as_str(), "committed" | "failed" | "cancelled" | "needs_recovery") {
        return Ok(status(&record, false));
    }
    let pins = guard::RootedPath::new(&record.root.to_string_lossy(), &record.target.to_string_lossy(), true)?;
    if pins.root_id != record.root_id || pins.parent_id != record.parent_id || pins.path != record.target || record.temp != record.target.with_file_name(format!(".nestcraft-editor-{id}.tmp")) || record.backup != record.target.with_file_name(format!(".nestcraft-editor-{id}.backup")) { return Err("JOURNAL_SCOPE_INVALID".into()); }
    let _lock = guard::lock_file(&record.source_id)?;
    let outcome = (|| -> Result<String, String> {
        match fs::symlink_metadata(&record.target) {
            Ok(_) => {
                let mut target = pins.exclusive()?; let identity = guard::identity(&target)?; let actual = hash_file(&mut target, None)?;
                if record.temp_id.as_ref() == Some(&identity) && actual == (record.total, record.submitted_hash.clone()) { target.sync_all().map_err(|e| e.to_string())?; return Ok("committed".into()); }
                if identity == record.source_id && actual.1 == record.expected_hash { return Ok("cancelled".into()); }
                Err("TARGET_EXTERNAL_OR_UNKNOWN".into())
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !matches!(record.phase.as_str(), "intent" | "staging" | "sealed" | "committing" | "replaced" | "durability") { return Err("TARGET_MISSING_UNKNOWN".into()); }
                let mut backup = guard::exclusive(&record.backup, false)?;
                if guard::identity(&backup)? != record.source_id || hash_file(&mut backup, None)?.1 != record.expected_hash { return Err("BACKUP_UNVERIFIED".into()); }
                pins.verify()?; rename_handle(&backup, &record.target)?; backup.sync_all().map_err(|e| e.to_string())?; Ok("cancelled".into())
            }, Err(e) => Err(e.to_string())
        }
    })();
    match outcome { Ok(phase) => { record.phase = phase; record.error = None; }, Err(e) => { record.phase = "needs_recovery".into(); record.error = Some(e); } }
    file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    let mut journal = Journal { file, seq, previous };
    if let Err(e) = journal.append(&record) { record.phase = "needs_recovery".into(); record.error = Some(e); }
    Ok(status(&record, false))
}
// ---------------------------------------------------------------------------
// 恢复材料回收（backup / temp / journal）。
//
// 为什么不在 commit_core 里清理：成功热路径只有两次 rename 与耐久 sync，中间连
// journal sync 都不做；一旦插入删除 I/O，任何删除失败、杀毒扫描或目录锁等待都会
// 直接反噬 commit 的返回时延与结论。因此回收独立成 gc_materials 入口，由调用方在
// 提交/取消之后的空闲时机（例如应用启动或工作区切换时）执行。
//
// 保留策略（MAT_GC_KEEP_RECENT_ENTRIES + MAT_GC_KEEP_WINDOW）：
//   * 只处理终态（committed / failed / cancelled）的 journal；
//   * 终态时间取 journal 文件自身的最后修改时间：终态行一经写入即不再追加
//     （reconcile 对终态只读、绝不 append），所以 mtime 就是终态落盘时间；这样也
//     不必给 Record 增加时间字段——增加字段会改变 row hash 链，让已存在的 journal
//     被判为 JOURNAL_CORRUPT；
//   * 保留「最近 32 条终态 journal」与「最近 7 天内的终态 journal」的并集：至少留
//     条数、至少留时长，两者都超出才回收。理由：条数保证最近若干次保存仍有可回查
//     证据；时长覆盖“长期没保存 / 节假日”的场景，避免只按条数把仍有诊断价值的近期
//     记录删掉；并集同时给出存储上界（单条 journal 受 JOURNAL_LIMIT 约束，材料只有
//     tmp/backup 两个文件），长期运行不会无界增长；
//   * needs_recovery 永不自动回收：它是“材料需要下一次对账/人工处理”的唯一证据，
//     自动删除等于销毁线索；非终态 journal 同样一个都不动。
// ---------------------------------------------------------------------------

/// 至少保留的终态 journal 条数。
pub const MAT_GC_KEEP_RECENT_ENTRIES: usize = 32;
/// 至少保留的终态 journal 时长（7 天）。
pub const MAT_GC_KEEP_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcPolicy {
    pub keep_recent_entries: usize,
    pub keep_within: Duration,
}
impl Default for GcPolicy {
    fn default() -> Self { Self { keep_recent_entries: MAT_GC_KEEP_RECENT_ENTRIES, keep_within: MAT_GC_KEEP_WINDOW } }
}
impl GcPolicy {
    /// 立即回收全部终态材料（保留 0 条、保留 0 时长）。只用于显式维护操作，例如
    /// 用户主动“清理已完成的保存残留”，或需要马上释放空间的诊断场景。
    pub const fn reclaim_all_terminal() -> Self { Self { keep_recent_entries: 0, keep_within: Duration::ZERO } }
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcReport {
    /// 扫描到的、文件名可解析为 save journal 的条目数。
    pub scanned: usize,
    /// 本次保留下来的 journal 数（非终态、needs_recovery、受策略保护、删除失败）。
    pub retained: usize,
    /// 本次完整回收（材料 + journal）的 requestId。
    pub reclaimed: Vec<String>,
    /// 实际删除的文件数，含 journal 本体。
    pub removed_files: usize,
    /// 明确跳过但不算失败的条目及原因（可观测性）。
    pub skipped: Vec<GcSkip>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcSkip {
    pub request_id: String,
    pub reason: String,
}
struct TerminalJournal {
    id: String,
    path: PathBuf,
    record: Record,
    terminal_at: SystemTime,
}
fn gc_skip(id: &str, reason: &str) -> GcSkip {
    GcSkip { request_id: id.to_string(), reason: reason.to_string() }
}
fn is_terminal(phase: &str) -> bool { matches!(phase, "committed" | "failed" | "cancelled") }
/// 与 reconcile / Journal::create 相同的独占打开方式：GC 绝不与活跃写入或对账共享
/// 句柄。拿不到独占句柄说明该 journal 正在被使用（活跃保存或被 reconcile 读取），
/// 直接跳过——让保存协议原有的共享语义保持唯一，不因 GC 引入第二种打开方式。
fn open_journal(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0).custom_flags(0x00200000 | 0x80000000); }
    options.open(path)
}
fn gc_target_dir() -> Result<PathBuf, String> {
    Ok(RECOVERY.get().ok_or("RECOVERY_NOT_INITIALIZED")?.clone())
}
/// 回收入口：扫描 recovery 目录中的 `*.jsonl` journal，回收已终态且超出保留策略的
/// 条目在 target 同目录下的 `.nestcraft-editor-<id>.backup`、`.nestcraft-editor-<id>.tmp`
/// 以及 journal 本体。幂等、best-effort：单条目失败只记入 `skipped` 而不返回 Err，
/// 重复调用保持安全；目录不存在时返回 Ok(空报告)。
pub fn gc_materials(policy: GcPolicy) -> Result<GcReport, String> {
    gc_directory(&gc_target_dir()?, policy)
}
fn gc_directory(dir: &Path, policy: GcPolicy) -> Result<GcReport, String> {
    let mut report = GcReport::default();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // 目录不存在＝没有材料可回收，属于正常的幂等结果。
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(report),
        Err(e) => return Err(format!("RECOVERY_UNREADABLE: {e}")),
    };
    let active: HashSet<String> = saves().lock().map(|map| map.keys().cloned().collect()).unwrap_or_default();
    let mut terminal: Vec<TerminalJournal> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) else { continue };
        // 名字不是规范 uuid 的条目不属于本协议，一个字节都不碰。
        if validate_id(id).is_err() { continue; }
        report.scanned += 1;
        let path = entry.path();
        if active.contains(id) { report.retained += 1; report.skipped.push(gc_skip(id, "SAVE_ACTIVE")); continue; }
        let mut file = match open_journal(&path) {
            Ok(file) => file,
            Err(e) => { report.retained += 1; report.skipped.push(gc_skip(id, &format!("JOURNAL_BUSY: {e}"))); continue; }
        };
        let record = match read_journal(&mut file, id) {
            Ok((record, _, _)) => record,
            Err(e) => { report.retained += 1; report.skipped.push(gc_skip(id, &format!("JOURNAL_UNREADABLE: {e}"))); continue; }
        };
        if record.phase == "needs_recovery" { report.retained += 1; report.skipped.push(gc_skip(id, "NEEDS_RECOVERY")); continue; }
        if !is_terminal(&record.phase) { report.retained += 1; report.skipped.push(gc_skip(id, "NOT_TERMINAL")); continue; }
        match fs::metadata(&path).and_then(|meta| meta.modified()) {
            Ok(terminal_at) => terminal.push(TerminalJournal { id: id.to_string(), path, record, terminal_at }),
            Err(e) => { report.retained += 1; report.skipped.push(gc_skip(id, &format!("JOURNAL_MTIME_UNAVAILABLE: {e}"))); }
        }
    }
    // 终态时间倒序；并列时按路径排序以保证稳定（生产 mtime 精度足以区分）。
    terminal.sort_by(|a, b| b.terminal_at.cmp(&a.terminal_at).then_with(|| b.path.cmp(&a.path)));
    let now = SystemTime::now();
    for (index, journal) in terminal.into_iter().enumerate() {
        let within = match now.duration_since(journal.terminal_at) {
            Ok(elapsed) => elapsed < policy.keep_within,
            // 时钟回拨/未来时间：按“仍在保留期内”处理，宁可少删。
            Err(_) => true,
        };
        if index < policy.keep_recent_entries || within {
            report.retained += 1;
            report.skipped.push(gc_skip(&journal.id, "RETAINED_BY_POLICY"));
            continue;
        }
        match reclaim_materials(&journal) {
            Ok(removed) => { report.removed_files += removed; report.reclaimed.push(journal.id); }
            Err(e) => { report.retained += 1; report.skipped.push(gc_skip(&journal.id, &e)); }
        }
    }
    Ok(report)
}
/// 回收单个终态条目的材料，返回实际删除的文件数（含 journal）。
/// 顺序：先材料、后 journal——journal 是“这里还有材料”的唯一线索，材料没删干净就
/// 保留 journal，下一轮还可以重试；反过来会留下无人认领的孤儿材料。
fn reclaim_materials(journal: &TerminalJournal) -> Result<usize, String> {
    let id = journal.id.as_str();
    let record = &journal.record;
    if record.request_id != id { return Err("JOURNAL_ID_MISMATCH".into()); }
    // 只回收本 id 在 target 同目录下的固定命名材料；journal 被改写时宁可跳过。
    let expected_temp = record.target.with_file_name(format!(".nestcraft-editor-{id}.tmp"));
    let expected_backup = record.target.with_file_name(format!(".nestcraft-editor-{id}.backup"));
    if record.temp != expected_temp || record.backup != expected_backup { return Err("JOURNAL_SCOPE_INVALID".into()); }
    // target 本体，以及任何指向 target 的“材料”，都绝不删除。
    if record.temp == record.target || record.backup == record.target || record.temp == record.backup { return Err("JOURNAL_SCOPE_INVALID".into()); }
    let mut removed = 0usize;
    for material in [&record.temp, &record.backup] {
        match fs::symlink_metadata(material) {
            Ok(meta) if meta.file_type().is_file() => {
                fs::remove_file(material).map_err(|e| format!("MATERIAL_NOT_RECLAIMED: {e}"))?;
                removed += 1;
            }
            // 不是普通文件（目录/其它类型）：不属于本协议的材料，不碰。
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("MATERIAL_NOT_RECLAIMED: {e}")),
        }
    }
    fs::remove_file(&journal.path).map_err(|e| format!("JOURNAL_NOT_RECLAIMED: {e}"))?;
    Ok(removed + 1)
}
#[cfg(test)]
#[path = "fs_document_save_tests.rs"]
mod tests;
