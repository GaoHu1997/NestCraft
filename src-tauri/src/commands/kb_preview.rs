//! FEAT-009 / CR-084: window-owned, bounded PDF bytes and local Office conversion.
//! No AI index/grant changes; the original is pinned read-only until the lease closes.
//! Office conversion is NOT an OS sandbox. Unsafe package features fail closed.
use super::{files, performance};
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet}, fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, Once, OnceLock, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant},
};
use tauri::Manager;

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RANGE: usize = 256 * 1024;
const BLOCK: usize = 64 * 1024;
const CONVERT_TIMEOUT: Duration = Duration::from_secs(120);
const LEASE_TTL: Duration = Duration::from_secs(300);
const MAX_SLOTS: usize = 32;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub request_id: String, pub preview_id: String, pub source_revision: String,
    pub size_bytes: String, pub format: String, pub converted: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRange { pub base64: String, pub offset: String, pub eof: bool }

struct Source {
    root: files::SafeRoot, file: File, source_ref: String, note_id: String,
    relative_uri: String, entity: String, revision: String, bytes: u64,
}
struct Document {
    source: Source, output: File, output_entity: String, output_root: Option<files::SafeRoot>,
    output_name: String, bytes: u64, touched: Instant,
    // Drop file/root pins BEFORE removing this task's private derived files.
    _temp: Option<TaskDirectory>,
}
struct Slot {
    owner: String, library: String, request: String, preview_id: String, cancel: AtomicBool,
    active: AtomicBool, created: Instant, child: Mutex<Option<Child>>,
    document: Mutex<Option<Document>>,
}
static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
fn slots() -> &'static Mutex<HashMap<String, Arc<Slot>>> { SLOTS.get_or_init(Default::default) }
fn key(owner: &str, library: &str, request: &str) -> String { format!("{owner}\0{library}\0{request}") }
fn checked_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("REQUEST_ID_INVALID: 请求标识无效".into());
    } Ok(())
}
fn cancelled(slot: &Slot) -> Result<(), String> {
    if slot.cancel.load(Ordering::Acquire) { Err("CANCELLED: 已取消预览".into()) } else { Ok(()) }
}
fn terminate(slot: &Slot) {
    slot.cancel.store(true, Ordering::Release);
    if let Ok(mut holder) = slot.child.lock() {
        if let Some(child) = holder.as_mut() {
            // Never taskkill a remembered PID after its owned process has exited.
            if matches!(child.try_wait(), Ok(None)) {
                #[cfg(windows)] {
                    use std::os::windows::process::CommandExt;
                    let executable = std::env::var_os("SystemRoot").map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32/taskkill.exe");
                    let _ = Command::new(executable).args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                        .creation_flags(0x08000000).status();
                }
                let _ = child.kill(); let _ = child.wait();
            }
        }
    }
}
fn expire() {
    let expired: Vec<Arc<Slot>> = if let Ok(mut all) = slots().lock() {
        let keys: Vec<String> = all.iter().filter_map(|(k, s)| {
            let old = if s.active.load(Ordering::Acquire) {
                s.created.elapsed() > CONVERT_TIMEOUT + Duration::from_secs(30)
            } else {
                s.document.try_lock().map(|d| d.as_ref().map(|d| d.touched.elapsed() > LEASE_TTL)
                    .unwrap_or(s.created.elapsed() > Duration::from_secs(60))).unwrap_or(false)
            };
            old.then(|| k.clone())
        }).collect();
        keys.iter().filter_map(|k| all.remove(k)).collect()
    } else { vec![] };
    for slot in expired { terminate(&slot); }
}
fn start_expiry() {
    static START: Once = Once::new();
    START.call_once(|| { let _ = std::thread::Builder::new().name("kb-preview-expiry".into())
        .spawn(|| loop { std::thread::sleep(Duration::from_secs(10)); expire(); }); });
}
pub fn close_window(owner: &str) {
    let removed: Vec<Arc<Slot>> = if let Ok(mut all) = slots().lock() {
        let keys: Vec<String> = all.iter().filter(|(_, s)| s.owner == owner).map(|(k, _)| k.clone()).collect();
        keys.iter().filter_map(|k| all.remove(k)).collect()
    } else { vec![] };
    for slot in removed { terminate(&slot); }
}
fn begin(owner: &str, library: &str, request: &str) -> Result<Arc<Slot>, String> {
    checked_id(request)?; checked_id(library)?; expire();
    let mut all = slots().lock().map_err(|_| "PREVIEW_BUSY")?;
    if let Some(previous) = all.get(&key(owner, library, request)) {
        return Err(if previous.cancel.load(Ordering::Acquire) { "CANCELLED" } else { "REQUEST_ID_REUSED" }.into());
    }
    if all.len() >= MAX_SLOTS || all.values().filter(|s| s.owner == owner).count() >= 16
        || all.values().filter(|s| s.active.load(Ordering::Acquire)).count() >= 4 {
        return Err("BUSY_RETRY: 预览任务繁忙，请关闭其他预览后重试".into());
    }
    let slot = Arc::new(Slot { owner: owner.into(), library: library.into(), request: request.into(), preview_id: crate::models::new_id("kbpreview"),
        cancel: AtomicBool::new(false), active: AtomicBool::new(true), created: Instant::now(),
        child: Mutex::new(None), document: Mutex::new(None) });
    all.insert(key(owner, library, request), slot.clone()); start_expiry(); Ok(slot)
}
fn finish_failed(slot: &Arc<Slot>) {
    slot.active.store(false, Ordering::Release);
    if let Ok(mut all) = slots().lock() {
        let k = key(&slot.owner, &slot.library, &slot.request);
        if all.get(&k).map(|s| Arc::ptr_eq(s, slot)).unwrap_or(false) && !slot.cancel.load(Ordering::Acquire) {
            all.remove(&k);
        }
    }
}
fn close(owner: &str, library: &str, request: &str) -> Result<(), String> {
    checked_id(request)?; checked_id(library)?;
    let slot = {
        let mut all = slots().lock().map_err(|_| "PREVIEW_BUSY")?;
        let k = key(owner, library, request);
        if let Some(slot) = all.get(&k) { slot.clone() } else {
            // A close arriving before queued open is a bounded cancellation tombstone.
            if all.len() >= MAX_SLOTS { return Err("BUSY_RETRY".into()); }
            let s = Arc::new(Slot { owner: owner.into(), library: library.into(), request: request.into(), preview_id: crate::models::new_id("kbpreview"),
                cancel: AtomicBool::new(true), active: AtomicBool::new(false), created: Instant::now(),
                child: Mutex::new(None), document: Mutex::new(None) }); all.insert(k, s.clone()); s
        }
    };
    terminate(&slot);
    if !slot.active.load(Ordering::Acquire) {
        if let Ok(mut document) = slot.document.lock() { *document = None; }
    }
    Ok(())
}

fn sha_file(file: &mut File, slot: &Slot) -> Result<(String, u64), String> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    let mut digest = Sha256::new(); let mut bytes = 0u64; let mut buf = [0; BLOCK];
    loop { cancelled(slot)?; let n = file.read(&mut buf).map_err(|_| "READ_FAILED")?;
        if n == 0 { break; } bytes += n as u64;
        if bytes > MAX_BYTES { return Err("SOURCE_TOO_LARGE: 预览源超过512MiB".into()); }
        digest.update(&buf[..n]);
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    Ok((format!("sha256:{:x}", digest.finalize()), bytes))
}
fn load_source(conn: &Connection, library: &str, note: &str, slot: &Slot) -> Result<Source, String> {
    #[cfg(not(windows))] { let _ = (conn, library, note, slot); return Err("SNAPSHOT_UNAVAILABLE: 尚未验证本平台受保护源句柄".into()); }
    #[cfg(windows)] {
        cancelled(slot)?;
        let source_ref = performance::source_ref(conn, library)?;
        let mut root = files::SafeRoot::new(Path::new(&source_ref))?;
        let (relative_uri, _) = super::resolve(conn, &mut root, library, note)?;
        let mut file = files::open_snapshot(&mut root, &relative_uri)?;
        let bytes = file.metadata().map_err(|_| "READ_FAILED")?.len();
        if bytes == 0 { return Err("EMPTY_FILE: 原件为空".into()); }
        if bytes > MAX_BYTES { return Err("SOURCE_TOO_LARGE: 预览源超过512MiB".into()); }
        let entity = files::snapshot_entity_id(&file)?;
        let (revision, read_bytes) = sha_file(&mut file, slot)?;
        if read_bytes != bytes { return Err("SOURCE_CHANGED".into()); }
        root.verify()?;
        if performance::source_ref(conn, library)? != source_ref { return Err("SOURCE_CHANGED".into()); }
        Ok(Source { root, file, source_ref, note_id: note.into(), relative_uri, entity, revision, bytes })
    }
}
fn recheck(conn: &Connection, library: &str, source: &mut Source) -> Result<(), String> {
    if performance::source_ref(conn, library)? != source.source_ref { return Err("SOURCE_CHANGED: 知识库根已变化".into()); }
    let (rel, _) = super::resolve(conn, &mut source.root, library, &source.note_id)?;
    if rel != source.relative_uri { return Err("SOURCE_CHANGED: 稳定文件标识已重新指向其他源".into()); }
    // New READ_DATA checks current access rights; entity must match the pinned source.
    let fresh = files::open_snapshot(&mut source.root, &rel)?;
    if files::snapshot_entity_id(&fresh)? != source.entity || fresh.metadata().map_err(|_| "READ_FAILED")?.len() != source.bytes {
        return Err("SOURCE_CHANGED: 原件实体已变化".into());
    }
    source.root.verify()
}
fn format_of(rel: &str) -> Result<String, String> {
    let ext = Path::new(rel).extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "pdf" | "doc" | "docx" | "rtf" | "ppt" | "pptx" | "pps" | "pot" | "xls" | "xlsx") {
        return Err("UNSUPPORTED: 此格式不支持预览".into());
    } Ok(ext)
}
fn pdf_valid(file: &mut File) -> Result<u64, String> {
    let len = file.metadata().map_err(|_| "READ_FAILED")?.len();
    if len == 0 { return Err("EMPTY_FILE: 文档没有页面".into()); }
    if len > MAX_BYTES { return Err("SOURCE_TOO_LARGE: 预览PDF超过512MiB".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    let mut header = [0u8; 8]; file.read_exact(&mut header).map_err(|_| "CORRUPT: PDF文件头不完整")?;
    if &header[..5] != b"%PDF-" || !(header[5] == b'1' || header[5] == b'2') || header[6] != b'.' || !header[7].is_ascii_digit() {
        return Err("CORRUPT: PDF签名与扩展名不符".into());
    }
    let tail_len = len.min(4096) as usize; let mut tail = vec![0; tail_len];
    file.seek(SeekFrom::End(-(tail_len as i64))).map_err(|_| "READ_FAILED")?;
    file.read_exact(&mut tail).map_err(|_| "READ_FAILED")?;
    if !tail.windows(5).any(|w| w == b"%%EOF") { return Err("CORRUPT: PDF缺少文件结束标记".into()); }
    // Structural/password verification is performed by PDF.js, not a fake parser here.
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?; Ok(len)
}

struct TaskDirectory { path: PathBuf, entity: String }
impl TaskDirectory {
    fn create(base: &Path) -> Result<Self, String> {
        let parent = files::SnapshotPins::parent(&base.join("placeholder"), true)?;
        let parent = if base.exists() { drop(parent); files::SnapshotPins::new(base)? } else {
            // parent(create=true) already created/pinned the full base chain.
            return Err("PREVIEW_TEMP_UNAVAILABLE".into());
        };
        let pins = parent.create_generation(std::ffi::OsStr::new(&crate::models::new_id("preview")))?;
        let path = pins.path.clone(); let entity = pins.entity()?; drop(pins);
        Ok(Self { path, entity })
    }
}
impl Drop for TaskDirectory {
    fn drop(&mut self) {
        // Only this random task directory, with matching entity, is eligible for cleanup.
        if files::snapshot_directory_identity(&self.path).ok().as_deref() != Some(&self.entity) { return; }
        fn remove(path: &Path, depth: usize) -> Result<(), ()> {
            if depth > 12 { return Err(()); }
            let meta = fs::symlink_metadata(path).map_err(|_| ())?;
            #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return Err(()); } }
            if meta.file_type().is_symlink() { return Err(()); }
            if meta.is_dir() {
                for entry in fs::read_dir(path).map_err(|_| ())?.take(8193) { remove(&entry.map_err(|_| ())?.path(), depth + 1)?; }
                fs::remove_dir(path).map_err(|_| ())
            } else if meta.is_file() { fs::remove_file(path).map_err(|_| ()) } else { Err(()) }
        }
        let _ = remove(&self.path, 0);
    }
}
fn file_url(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("CONVERTER_PATH_ENCODING")?.replace('\\', "/");
    let mut out = if text.starts_with('/') { "file://".to_string() } else { "file:///".to_string() };
    for b in text.bytes() { if b.is_ascii_alphanumeric() || b"/:_-~.".contains(&b) { out.push(b as char); }
        else { out.push_str(&format!("%{b:02X}")); } }
    Ok(out)
}
/// CR-097：转换器定位统一到 `kb_office::soffice_path`（受管目录改为统一数据根）。
fn soffice(resource: Option<&Path>) -> Result<PathBuf, String> {
    crate::commands::kb_office::soffice_path(resource)
}
fn copy_source(source: &mut Source, destination: &Path, slot: &Slot) -> Result<(), String> {
    source.file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(destination).map_err(|_| "PREVIEW_TEMP_UNAVAILABLE")?;
    let mut buf = [0; BLOCK]; let mut hash = Sha256::new(); let mut bytes = 0;
    loop { cancelled(slot)?; let n = source.file.read(&mut buf).map_err(|_| "READ_FAILED")?; if n == 0 { break; }
        bytes += n as u64; if bytes > MAX_BYTES { return Err("SOURCE_TOO_LARGE".into()); }
        hash.update(&buf[..n]); output.write_all(&buf[..n]).map_err(|_| "PREVIEW_TEMP_UNAVAILABLE")?;
    }
    if bytes != source.bytes || format!("sha256:{:x}", hash.finalize()) != source.revision { return Err("SOURCE_CHANGED".into()); }
    output.sync_all().map_err(|_| "PREVIEW_TEMP_UNAVAILABLE")?; Ok(())
}
fn office_profile(profile: &Path) -> Result<(), String> {
    fs::create_dir(profile).map_err(|_| "PREVIEW_TEMP_UNAVAILABLE")?;
    fs::create_dir(profile.join("user")).map_err(|_| "PREVIEW_TEMP_UNAVAILABLE")?;
    // Security level 3 = Very High. No trusted locations are configured in this fresh profile.
    let settings = r#"<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Save/Document"><prop oor:name="LoadPrinter" oor:op="fuse"><value>false</value></prop></item>
</oor:items>"#;
    fs::write(profile.join("user/registrymodifications.xcu"), settings).map_err(|_| "PREVIEW_TEMP_UNAVAILABLE".into())
}
fn convert(slot: &Slot, executable: &Path, input: &Path, profile: &Path, output: &Path) -> Result<(), String> {
    cancelled(slot)?;
    let mut cmd = Command::new(executable);
    cmd.arg(format!("-env:UserInstallation={}", file_url(profile)?))
        .args(["--headless", "--nologo", "--nodefault", "--norestore", "--nofirststartwizard"])
        .args(["--convert-to", "pdf", "--outdir"]).arg(output).arg(input)
        .current_dir(output).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    { let mut holder = slot.child.lock().map_err(|_| "PREVIEW_BUSY")?;
        cancelled(slot)?; *holder = Some(cmd.spawn().map_err(|_| "CONVERTER_UNAVAILABLE: 转换组件无法启动")?); }
    let start = Instant::now();
    loop {
        if slot.cancel.load(Ordering::Acquire) { terminate(slot); return Err("CANCELLED".into()); }
        if start.elapsed() > CONVERT_TIMEOUT { terminate(slot); return Err("TIMEOUT: 文档转换超过120秒".into()); }
        let status = { let mut holder = slot.child.lock().map_err(|_| "PREVIEW_BUSY")?;
            holder.as_mut().ok_or("CANCELLED")?.try_wait().map_err(|_| "CONVERSION_FAILED")? };
        if let Some(status) = status {
            if !status.success() { return Err("CONVERSION_FAILED: 本机转换进程失败".into()); }
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    cancelled(slot)
}

#[tauri::command]
pub async fn kb_preview_open(window: tauri::WebviewWindow, library_id: String, note_id: String, request_id: String) -> Result<Preview, String> {
    let owner = window.label().to_string(); let resource = window.app_handle().path().resource_dir().ok();
    let slot = begin(&owner, &library_id, &request_id)?;
    let held = slot.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = crate::db::knowledge_connection()?;
        prepare(&conn, &held, &note_id, resource.as_deref(), None)
    }).await.map_err(|_| "PREVIEW_INTERRUPTED: 预览任务被中断".to_string()).and_then(|r| r);
    if result.is_err() { finish_failed(&slot); }
    result
}
fn prepare(conn: &Connection, slot: &Arc<Slot>, note: &str, resource: Option<&Path>, temp_base: Option<&Path>) -> Result<Preview, String> {
    let mut source = load_source(conn, &slot.library, note, slot)?;
    let format = format_of(&source.relative_uri)?; let converted = format != "pdf";
    let mut temp = None; let mut output_root = None; let output_name;
    let output;
    if converted {
        let executable = soffice(resource)?;
        check_office(&mut source.file, &format)?; cancelled(slot)?;
        let base = match temp_base { Some(base) => base.to_path_buf(), None => crate::storage_layout::category("index")?.join("preview") };
        let task = TaskDirectory::create(&base)?;
        let input = task.path.join(format!("source.{format}")); copy_source(&mut source, &input, slot)?;
        let profile = task.path.join("profile"); office_profile(&profile)?;
        let mut root = files::SafeRoot::new(&task.path)?;
        // Pin task ancestors throughout conversion; only the converter writes this private directory.
        convert(slot, &executable, &input, &profile, &task.path)?;
        output = files::open_snapshot(&mut root, "source.pdf").map_err(|_| "CONVERSION_FAILED: 转换未生成PDF")?;
        output_root = Some(root); output_name = "source.pdf".into(); temp = Some(task);
    } else {
        output = source.file.try_clone().map_err(|_| "READ_FAILED")?;
        output_name = source.relative_uri.clone();
    }
    let mut output = output; let bytes = pdf_valid(&mut output)?;
    let output_entity = files::snapshot_entity_id(&output)?;
    recheck(conn, &slot.library, &mut source)?; cancelled(slot)?;
    let preview_id = slot.preview_id.clone();
    let result = Preview { request_id: slot.request.clone(), preview_id: preview_id.clone(),
        source_revision: source.revision.clone(), size_bytes: bytes.to_string(), format, converted };
    let doc = Document { source, output, output_entity, output_root, output_name, bytes,
        touched: Instant::now(), _temp: temp };
    // Registration and cancellation have a final linearization fence.
    let all = slots().lock().map_err(|_| "PREVIEW_BUSY")?;
    if !all.get(&key(&slot.owner, &slot.library, &slot.request)).map(|s| Arc::ptr_eq(s, slot)).unwrap_or(false) { return Err("CANCELLED".into()); }
    cancelled(slot)?;
    *slot.document.lock().map_err(|_| "PREVIEW_BUSY")? = Some(doc);
    slot.active.store(false, Ordering::Release); drop(all); Ok(result)
}
fn read_range(conn: &Connection, owner: &str, library: &str, id: &str, revision: &str, offset: &str, length: usize) -> Result<PreviewRange, String> {
    if length == 0 || length > MAX_RANGE { return Err("INVALID_BUDGET: 每次读取必须为1～262144字节".into()); }
    if offset.is_empty() || offset.len() > 20 || !offset.bytes().all(|b| b.is_ascii_digit()) { return Err("INVALID_OFFSET".into()); }
    let offset = offset.parse::<u64>().map_err(|_| "INVALID_OFFSET")?;
    let slot = { let all = slots().lock().map_err(|_| "PREVIEW_BUSY")?;
        all.values().find(|s| s.owner == owner && s.library == library && s.preview_id == id).cloned()
            .ok_or("PREVIEW_SCOPE_MISMATCH: 预览已关闭或不属于此窗口和知识库")? };
    cancelled(&slot)?;
    let mut held = slot.document.lock().map_err(|_| "PREVIEW_BUSY")?;
    let doc = held.as_mut().ok_or("PREVIEW_CLOSED")?;
    if doc.source.revision != revision { return Err("SOURCE_CHANGED: 源修订不一致".into()); }
    if doc.touched.elapsed() > LEASE_TTL { return Err("PREVIEW_EXPIRED".into()); }
    recheck(conn, library, &mut doc.source)?;
    if offset > doc.bytes { return Err("INVALID_OFFSET: 偏移超过PDF末尾".into()); }
    if let Some(root) = doc.output_root.as_mut() {
        let fresh = files::open_snapshot(root, &doc.output_name)?;
        if files::snapshot_entity_id(&fresh)? != doc.output_entity { return Err("SOURCE_CHANGED: 派生预览实体已变化".into()); }
    }
    let len = (doc.bytes - offset).min(length as u64) as usize;
    doc.output.seek(SeekFrom::Start(offset)).map_err(|_| "READ_FAILED")?;
    let mut bytes = vec![0; len]; doc.output.read_exact(&mut bytes).map_err(|_| "READ_FAILED")?;
    recheck(conn, library, &mut doc.source)?; cancelled(&slot)?; doc.touched = Instant::now();
    Ok(PreviewRange { base64: base64::engine::general_purpose::STANDARD.encode(&bytes), offset: offset.to_string(), eof: offset + len as u64 == doc.bytes })
}
#[tauri::command]
pub async fn kb_preview_read(window: tauri::WebviewWindow, library_id: String, preview_id: String, source_revision: String, offset: String, length: usize) -> Result<PreviewRange, String> {
    let owner = window.label().to_string();
    performance::blocking(move |conn| read_range(&conn, &owner, &library_id, &preview_id, &source_revision, &offset, length)).await
}
#[tauri::command]
pub fn kb_preview_close(window: tauri::WebviewWindow, library_id: String, request_id: String) -> Result<(), String> {
    close(window.label(), &library_id, &request_id)
}


#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: PathBuf, conn: Connection, owner: String }
    impl Fixture {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let root = base.join(crate::models::new_id("cr084-fixture")); fs::create_dir(&root).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch("CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,enabled INTEGER,sourceKind TEXT,sourceRef TEXT); CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,relativeUri TEXT,title TEXT);").unwrap();
            conn.execute("INSERT INTO knowledge_library VALUES('lib',1,'managed-directory',?1)", [root.to_str().unwrap()]).unwrap();
            Self { root, conn, owner: crate::models::new_id("cr084-owner") }
        }
        fn write(&self, rel: &str, data: &[u8]) -> String {
            fs::write(self.root.join(rel), data).unwrap();
            let id = files::file_id(rel);
            self.conn.execute("INSERT INTO knowledge_note_index VALUES('lib',?1,?2,?2)", rusqlite::params![id, rel]).unwrap(); id
        }
        fn slot(&self) -> Arc<Slot> { begin(&self.owner, "lib", &crate::models::new_id("request")).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { close_window(&self.owner); let _ = fs::remove_dir_all(&self.root); } }
    fn pdf_bytes() -> Vec<u8> { let mut bytes = b"%PDF-1.4\n".to_vec(); bytes.extend(vec![b'x'; 300_000]); bytes.extend_from_slice(b"\n%%EOF\n"); bytes }
    #[test]
    fn pdf_ranges_scope_revision_and_source_fence() {
        let f = Fixture::new(); let original = pdf_bytes(); let id = f.write("file.pdf", &original); let slot = f.slot();
        let p = prepare(&f.conn, &slot, &id, None, Some(&f.root.join("derived"))).unwrap();
        assert!(!p.converted); assert_eq!(p.source_revision, format!("sha256:{:x}", Sha256::digest(&original)));
        assert!(read_range(&f.conn, "other", "lib", &p.preview_id, &p.source_revision, "0", MAX_RANGE).unwrap_err().contains("SCOPE"));
        assert!(read_range(&f.conn, &f.owner, "other", &p.preview_id, &p.source_revision, "0", MAX_RANGE).is_err());
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, "wrong", "0", MAX_RANGE).unwrap_err().contains("SOURCE_CHANGED"));
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", MAX_RANGE + 1).is_err());
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "-1", 10).is_err());
        let a = read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", MAX_RANGE).unwrap();
        assert!(!a.eof); let mut bytes = base64::engine::general_purpose::STANDARD.decode(a.base64).unwrap();
        let b = read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, &MAX_RANGE.to_string(), MAX_RANGE).unwrap();
        assert!(b.eof); bytes.extend(base64::engine::general_purpose::STANDARD.decode(b.base64).unwrap()); assert_eq!(bytes, original);
        let eof = read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, &original.len().to_string(), 1).unwrap(); assert!(eof.eof && eof.base64.is_empty());
        #[cfg(windows)] { assert!(fs::write(f.root.join("file.pdf"), "replace").is_err()); assert!(fs::rename(f.root.join("file.pdf"), f.root.join("other.pdf")).is_err()); }
        f.conn.execute("UPDATE knowledge_library SET enabled=0", []).unwrap();
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", 10).unwrap_err().contains("LIBRARY_UNAVAILABLE"));
        close(&f.owner, "lib", &slot.request).unwrap();
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", 10).is_err());
        fs::write(f.root.join("file.pdf"), "now unlocked").unwrap();
    }
    #[test]
    fn corrupt_empty_pdf_and_bad_identity_fail_closed() {
        let f = Fixture::new(); let bad = f.write("bad.pdf", b"%PDF-1.4 missing EOF"); let slot = f.slot();
        assert!(prepare(&f.conn, &slot, &bad, None, None).unwrap_err().contains("CORRUPT")); finish_failed(&slot);
        let empty = f.write("empty.pdf", b""); let slot = f.slot(); assert!(prepare(&f.conn, &slot, &empty, None, None).unwrap_err().contains("EMPTY_FILE")); finish_failed(&slot);
        f.conn.execute("INSERT INTO knowledge_note_index VALUES('lib','unsafe','../outside.pdf','unsafe')", []).unwrap();
        let slot = f.slot(); assert!(load_source(&f.conn, "lib", "unsafe", &slot).is_err()); finish_failed(&slot);
    }
    #[test]
    fn close_before_open_and_request_reuse_are_isolated() {
        let f = Fixture::new(); close(&f.owner, "lib", "future").unwrap();
        assert!(begin(&f.owner, "lib", "future").err().unwrap().contains("CANCELLED"));
        let other = begin(&f.owner, "another-lib", "future").unwrap(); assert!(!other.cancel.load(Ordering::Acquire));
        let slot = f.slot(); assert!(begin(&f.owner, "lib", &slot.request).is_err()); close(&f.owner, "another-lib", &slot.request).unwrap(); assert!(!slot.cancel.load(Ordering::Acquire));
        close(&f.owner, "lib", &slot.request).unwrap(); assert!(cancelled(&slot).is_err());
    }
    #[test]
    fn relationships_external_entities_and_legacy_are_restricted() {
        let names = HashSet::from(["word/document.xml".to_string(), "word/styles.xml".to_string()]);
        check_xml("word/_rels/document.xml.rels", br#"<Relationships><Relationship Id="r1" Type="style" Target="styles.xml"/></Relationships>"#, &names).unwrap();
        check_xml("word/_rels/document.xml.rels", br#"<Relationships><Relationship Id="r1" Type="style" Target="../word/styles.xml"/></Relationships>"#, &names).unwrap();
        assert!(check_xml("word/_rels/document.xml.rels", br#"<Relationships><Relationship Id="r1" Target="https://example.invalid" TargetMode="&#69;xternal"/></Relationships>"#, &names).unwrap_err().contains("RESTRICTED"));
        assert!(check_xml("word/document.xml", b"<!DOCTYPE a [<!ENTITY x SYSTEM 'file:///private'>]><a/>", &names).is_err());
        let f = Fixture::new(); f.write("legacy.doc", b"opaque"); let mut file = File::open(f.root.join("legacy.doc")).unwrap();
        assert!(check_office(&mut file, "doc").unwrap_err().contains("UNSUPPORTED_RESTRICTED"));
        assert!(format_of("macro.docm").is_err()); assert!(format_of("archive.zip").is_err());
        assert_eq!(file_url(Path::new(r"D:\space and中\profile")).unwrap(), "file:///D:/space%20and%E4%B8%AD/profile");
    }
    #[test]
    fn cancel_kills_owned_conversion_process() {
        let f = Fixture::new(); let slot = f.slot();
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            let cmd = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap().join("System32/cmd.exe");
            let child = Command::new(cmd).args(["/C", "ping -n 30 127.0.0.1 > NUL"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000).spawn().unwrap();
            *slot.child.lock().unwrap() = Some(child);
            close(&f.owner, "lib", &slot.request).unwrap();
            assert!(slot.child.lock().unwrap().as_mut().unwrap().try_wait().unwrap().is_some());
        }
    }
    #[test]
    fn bound_source_and_note_retarget_are_rejected() {
        let f = Fixture::new(); let note = f.write("a.pdf", &pdf_bytes()); f.write("b.pdf", &pdf_bytes());
        let slot = f.slot(); let p = prepare(&f.conn, &slot, &note, None, None).unwrap();
        f.conn.execute("UPDATE knowledge_note_index SET relativeUri='b.pdf' WHERE noteId=?1", [&note]).unwrap();
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", 10).unwrap_err().contains("SOURCE_CHANGED"));
        f.conn.execute("UPDATE knowledge_note_index SET relativeUri='a.pdf' WHERE noteId=?1", [&note]).unwrap();
        f.conn.execute("UPDATE knowledge_library SET sourceRef='changed-root'", []).unwrap();
        assert!(read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", 10).unwrap_err().contains("SOURCE_CHANGED"));
    }
    fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut data = Vec::new(); let mut central = Vec::new();
        for (name, payload) in entries {
            let offset = data.len() as u32; let checksum = crc32(payload); let size = payload.len() as u32;
            data.extend_from_slice(b"PK\x03\x04"); data.extend_from_slice(&20u16.to_le_bytes());
            for _ in 0..4 { data.extend_from_slice(&0u16.to_le_bytes()); }
            data.extend_from_slice(&checksum.to_le_bytes()); data.extend_from_slice(&size.to_le_bytes()); data.extend_from_slice(&size.to_le_bytes());
            data.extend_from_slice(&(name.len() as u16).to_le_bytes()); data.extend_from_slice(&0u16.to_le_bytes()); data.extend_from_slice(name.as_bytes()); data.extend_from_slice(payload);
            central.extend_from_slice(b"PK\x01\x02"); central.extend_from_slice(&20u16.to_le_bytes()); central.extend_from_slice(&20u16.to_le_bytes());
            for _ in 0..4 { central.extend_from_slice(&0u16.to_le_bytes()); }
            central.extend_from_slice(&checksum.to_le_bytes()); central.extend_from_slice(&size.to_le_bytes()); central.extend_from_slice(&size.to_le_bytes()); central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            for _ in 0..4 { central.extend_from_slice(&0u16.to_le_bytes()); }
            central.extend_from_slice(&0u32.to_le_bytes()); central.extend_from_slice(&offset.to_le_bytes()); central.extend_from_slice(name.as_bytes());
        }
        let offset = data.len() as u32; data.extend_from_slice(&central); data.extend_from_slice(b"PK\x05\x06"); data.extend_from_slice(&[0u8;4]);
        data.extend_from_slice(&(entries.len() as u16).to_le_bytes()); data.extend_from_slice(&(entries.len() as u16).to_le_bytes()); data.extend_from_slice(&(central.len() as u32).to_le_bytes()); data.extend_from_slice(&offset.to_le_bytes()); data.extend_from_slice(&[0u8;2]); data
    }
    #[test]
    fn malformed_bomb_and_macro_packages_are_rejected() {
        let f = Fixture::new();
        let base = [("[Content_Types].xml", b"<Types/>" as &[u8]), ("_rels/.rels", b"<Relationships/>" as &[u8]), ("word/document.xml", b"<document/>" as &[u8])];
        for (suffix, extra) in [("macro", "word/vbaProject.bin"), ("embedded", "word/embeddings/oleObject.bin"), ("script", "word/media/active.svg"), ("traversal", "../outside.xml")] {
            let mut entries = base.to_vec(); entries.push((extra, b"unsafe"));
            let path = f.root.join(format!("{suffix}.docx")); fs::write(&path, stored_zip(&entries)).unwrap();
            assert!(check_openxml(&mut File::open(&path).unwrap(), "docx").unwrap_err().contains("RESTRICTED"));
        }
        let mut bomb = stored_zip(&base); let index = bomb.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bomb[index + 24..index + 28].copy_from_slice(&(300 * 1024 * 1024u32).to_le_bytes());
        let path = f.root.join("bomb.docx"); fs::write(&path, bomb).unwrap(); assert!(check_openxml(&mut File::open(&path).unwrap(), "docx").is_err());
        let path = f.root.join("valid.docx"); fs::write(&path, stored_zip(&base)).unwrap(); check_openxml(&mut File::open(&path).unwrap(), "docx").unwrap();
        let names = HashSet::from(["word/styles.xml".to_string()]);
        assert!(check_xml("word/_rels/document.xml.rels", br#"<Relationships><Relationship Target="styles.xml" TargetMode="Maybe"/></Relationships>"#, &names).is_err());
    }
    #[test]
    fn real_libreoffice_converts_safe_docx_pptx_rtf_and_cleans() {
        let Some(fixtures) = std::env::var_os("CR084_OFFICE_FIXTURES").map(PathBuf::from) else { eprintln!("未配置CR084_OFFICE_FIXTURES，真实转换未执行"); return; };
        let f = Fixture::new(); let derived = f.root.join("derived"); let mut evidence = vec![];
        for name in ["source.docx", "slides.pptx"] {
            let original = fs::read(fixtures.join(name)).unwrap(); let note = f.write(name, &original); let slot = f.slot();
            let p = prepare(&f.conn, &slot, &note, None, Some(&derived)).unwrap(); assert!(p.converted);
            let page = read_range(&f.conn, &f.owner, "lib", &p.preview_id, &p.source_revision, "0", MAX_RANGE).unwrap();
            let data = base64::engine::general_purpose::STANDARD.decode(page.base64).unwrap(); assert!(data.starts_with(b"%PDF-"));
            assert_eq!(fs::read(f.root.join(name)).unwrap(), original);
            evidence.push(serde_json::json!({"input":name,"sourceRevision":p.source_revision,"pdfBytes":p.size_bytes,"converted":p.converted}));
            close(&f.owner, "lib", &slot.request).unwrap();
            assert_eq!(fs::read_dir(&derived).unwrap().count(), 0);
        }
        let bytes = b"{\\rtf1\\ansi Hello CR084 static local preview}"; let note = f.write("static.rtf", bytes); let slot = f.slot();
        let p = prepare(&f.conn, &slot, &note, None, Some(&derived)).unwrap(); assert!(p.converted);
        evidence.push(serde_json::json!({"input":"static.rtf","sourceRevision":p.source_revision,"pdfBytes":p.size_bytes,"converted":true}));
        close(&f.owner, "lib", &slot.request).unwrap(); assert_eq!(fs::read_dir(&derived).unwrap().count(), 0);
        if let Some(out) = std::env::var_os("CR084_BACKEND_REPORT") { fs::write(out, serde_json::to_vec_pretty(&serde_json::json!({"time":chrono::Utc::now().to_rfc3339(),"realConversion":true,"fixtures":evidence,"originalsUnchanged":true,"derivedCleaned":true,"converter":std::env::var("NESTCRAFT_SOFFICE").unwrap_or_default()})).unwrap()).unwrap(); }
    }
}

fn le16(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or("CORRUPT: ZIP结构不完整".into())
}
fn le32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or("CORRUPT: ZIP结构不完整".into())
}
fn xml_unescape(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len()); let mut remaining = text;
    while let Some(at) = remaining.find('&') {
        out.push_str(&remaining[..at]); let rest = &remaining[at + 1..];
        let end = rest.find(';').filter(|v| *v <= 12).ok_or("UNSUPPORTED_RESTRICTED: 不支持的XML实体")?;
        let name = &rest[..end]; let c = match name {
            "amp" => '&', "lt" => '<', "gt" => '>', "quot" => '"', "apos" => '\'',
            _ => {
                let number = if let Some(hex) = name.strip_prefix("#x") { u32::from_str_radix(hex, 16).ok() }
                    else { name.strip_prefix('#').and_then(|s| s.parse::<u32>().ok()) };
                number.and_then(char::from_u32).ok_or("UNSUPPORTED_RESTRICTED: 拒绝自定义XML实体")?
            }
        };
        out.push(c); remaining = &rest[end + 1..];
    }
    out.push_str(remaining); Ok(out)
}
fn xml_attributes(tag: &str) -> Result<HashMap<String, String>, String> {
    let bytes = tag.as_bytes(); let mut i = 0; let mut attrs = HashMap::new();
    // Skip element name, then parse only quoted attributes; malformed XML fails closed.
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() { i += 1; }
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i == bytes.len() || bytes[i] == b'/' || bytes[i] == b'?' { break; }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' { i += 1; }
        let name = &tag[start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if name.is_empty() || bytes.get(i) != Some(&b'=') { return Err("CORRUPT: XML属性无效".into()); }
        i += 1; while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        let quote = *bytes.get(i).ok_or("CORRUPT")?;
        if quote != b'\'' && quote != b'"' { return Err("CORRUPT: XML属性必须加引号".into()); }
        i += 1; let start = i; while i < bytes.len() && bytes[i] != quote { i += 1; }
        if i == bytes.len() { return Err("CORRUPT: XML属性未结束".into()); }
        if attrs.insert(name.to_ascii_lowercase(), xml_unescape(&tag[start..i])?).is_some() {
            return Err("CORRUPT: XML重复属性".into());
        }
        i += 1;
    }
    Ok(attrs)
}
fn check_xml(name: &str, bytes: &[u8], names: &HashSet<String>) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "UNSUPPORTED_RESTRICTED: 只接受UTF-8 OpenXML部件")?;
    let lower = text.to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<!entity") || lower.contains('\0') {
        return Err("UNSUPPORTED_RESTRICTED: 拒绝XML外部实体或DOCTYPE".into());
    }
    // Scan the expanded values, so numeric character references cannot hide unsafe fields.
    let decoded = xml_unescape(text)?.to_ascii_lowercase();
    for feature in ["vnd.ms-office.vbaproject", "macroenabled", "oleobject", "activex", "ddeauto", "dde ", "includepicture ", "includetext ", " altchunk", ":altchunk", "attachedtemplate", "externaldata"] {
        if decoded.contains(feature) { return Err("UNSUPPORTED_RESTRICTED: 文档包含宏、嵌入对象或外部更新字段".into()); }
    }
    if !name.ends_with(".rels") { return Ok(()); }
    let parent = if name == "_rels/.rels" { "" } else {
        name.rsplit_once("/_rels/").map(|v| v.0).ok_or("CORRUPT: 关系部件路径无效")?
    };
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        rest = &rest[at + 1..]; let end = rest.find('>').ok_or("CORRUPT: XML标签未结束")?;
        let tag = &rest[..end]; rest = &rest[end + 1..];
        let element = tag.split_ascii_whitespace().next().unwrap_or("").trim_end_matches('/').rsplit(':').next().unwrap_or("");
        if element != "Relationship" { continue; }
        let attrs = xml_attributes(tag)?;
        if let Some(mode) = attrs.get("targetmode") {
            if !mode.eq_ignore_ascii_case("Internal") { return Err("UNSUPPORTED_RESTRICTED: 文档含外部或未知关系模式，未联网转换".into()); }
        }
        let target = attrs.get("target").ok_or("CORRUPT: 关系缺少Target")?;
        if target.contains(':') || target.contains('\\') || target.starts_with('/') || target.contains('%') {
            return Err("UNSUPPORTED_RESTRICTED: 文档关系目标不是受检包内路径".into());
        }
        let path = target.split('#').next().unwrap_or(""); if path.is_empty() { continue; }
        let mut parts: Vec<&str> = parent.split('/').filter(|p| !p.is_empty()).collect();
        for part in path.split('/') { match part { "" | "." => {}, ".." => { if parts.pop().is_none() { return Err("UNSUPPORTED_RESTRICTED: 包关系越界".into()); } }, _ => parts.push(part) } }
        if !names.contains(&parts.join("/")) { return Err("CORRUPT: 文档关系指向不存在的包部件".into()); }
    }
    Ok(())
}
struct ZipPart { name: String, flags: u16, method: u16, compressed: u64, plain: u64, local: u64, crc: u32 }
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes { crc ^= b as u32; for _ in 0..8 { crc = (crc >> 1) ^ (0xedb88320u32 & (0u32.wrapping_sub(crc & 1))); } }
    !crc
}
fn check_openxml(file: &mut File, format: &str) -> Result<(), String> {
    let length = file.metadata().map_err(|_| "READ_FAILED")?.len();
    let tail_length = length.min(65557) as usize; let mut tail = vec![0; tail_length];
    file.seek(SeekFrom::End(-(tail_length as i64))).map_err(|_| "READ_FAILED")?;
    file.read_exact(&mut tail).map_err(|_| "READ_FAILED")?;
    let at = (0..tail.len().saturating_sub(21)).rev().find(|&i| tail.get(i..i + 4) == Some(b"PK\x05\x06")
        && le16(&tail, i + 20).map(|comment| i + 22 + comment as usize == tail.len()).unwrap_or(false)).ok_or("CORRUPT: OpenXML包目录无效")?;
    if le16(&tail, at + 4)? != 0 || le16(&tail, at + 6)? != 0 || le16(&tail, at + 8)? != le16(&tail, at + 10)? {
        return Err("UNSUPPORTED_RESTRICTED: 不支持分卷OpenXML包".into());
    }
    let count = le16(&tail, at + 10)? as usize; let size = le32(&tail, at + 12)? as u64; let offset = le32(&tail, at + 16)? as u64;
    if count == 0 || count > 8192 || size > 8 * 1024 * 1024 || offset + size != length - tail_length as u64 + at as u64 {
        return Err("UNSUPPORTED_RESTRICTED: OpenXML包目录预算或结构超限".into());
    }
    let mut central = vec![0; size as usize]; file.seek(SeekFrom::Start(offset)).map_err(|_| "READ_FAILED")?;
    file.read_exact(&mut central).map_err(|_| "CORRUPT")?;
    let mut parts = Vec::with_capacity(count); let mut names = HashSet::new(); let mut cursor = 0; let mut total = 0u64;
    for _ in 0..count {
        if central.get(cursor..cursor + 4) != Some(b"PK\x01\x02") { return Err("CORRUPT: 包目录签名无效".into()); }
        let flags = le16(&central, cursor + 8)?; let method = le16(&central, cursor + 10)?;
        let compressed = le32(&central, cursor + 20)? as u64; let plain = le32(&central, cursor + 24)? as u64;
        let name_length = le16(&central, cursor + 28)? as usize; let extra = le16(&central, cursor + 30)? as usize; let comment = le16(&central, cursor + 32)? as usize;
        let local = le32(&central, cursor + 42)? as u64;
        let end = cursor + 46 + name_length + extra + comment;
        if end > central.len() || flags & 1 != 0 || !matches!(method, 0 | 8) || le16(&central, cursor + 34)? != 0 {
            return Err("UNSUPPORTED_RESTRICTED: 加密或不支持的包压缩方式".into());
        }
        let name = std::str::from_utf8(&central[cursor + 46..cursor + 46 + name_length]).map_err(|_| "CORRUPT: 包路径编码无效")?.to_string();
        if name.is_empty() || name.len() > 512 || name.contains(['\\', ':', '\0']) || name.starts_with('/')
            || name.split('/').any(|s| s == "." || s == "..") || !names.insert(name.clone()) {
            return Err("UNSUPPORTED_RESTRICTED: OpenXML包路径非法或重复".into());
        }
        let lower = name.to_ascii_lowercase();
        let printer_bin = lower.strip_prefix("ppt/printersettings/printersettings").and_then(|s| s.strip_suffix(".bin"))
            .map(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
        if lower.contains("vbaproject") || lower.contains("/embeddings/") || lower.contains("/activex/") || lower.contains("/externallinks/")
            || (lower.ends_with(".bin") && !printer_bin) || lower.contains("encryptedpackage") || lower.ends_with(".vml")
            || [".svg", ".html", ".htm", ".js", ".exe", ".dll"].iter().any(|suffix| lower.ends_with(suffix)) {
            return Err("UNSUPPORTED_RESTRICTED: 文档含宏、嵌入对象或未支持的活动部件".into());
        }
        total = total.checked_add(plain).ok_or("UNSUPPORTED_RESTRICTED")?;
        if total > 256 * 1024 * 1024 || plain > 64 * 1024 * 1024 || (plain > 1024 * 1024 && plain > compressed.saturating_mul(1000)) {
            return Err("UNSUPPORTED_RESTRICTED: OpenXML解压预算超限".into());
        }
        parts.push(ZipPart { name, flags, method, compressed, plain, local, crc: le32(&central, cursor + 16)? }); cursor = end;
    }
    if cursor != central.len() || !names.contains("[Content_Types].xml") || !names.contains("_rels/.rels") {
        return Err("CORRUPT: OpenXML目录或主部件缺失".into());
    }
    let main = match format { "docx" => "word/document.xml", "pptx" => "ppt/presentation.xml", "xlsx" => "xl/workbook.xml", _ => return Err("UNSUPPORTED".into()) };
    if !names.contains(main) { return Err("CORRUPT: 文件类型与包主部件不符".into()); }
    let mut ranges = vec![]; let mut xml_bytes = 0u64;
    for part in parts {
        if part.local + 30 > offset { return Err("CORRUPT: ZIP本地条目越界".into()); }
        file.seek(SeekFrom::Start(part.local)).map_err(|_| "READ_FAILED")?;
        let mut header = [0; 30]; file.read_exact(&mut header).map_err(|_| "CORRUPT")?;
        if &header[..4] != b"PK\x03\x04" || le16(&header, 6)? != part.flags || le16(&header, 8)? != part.method { return Err("CORRUPT: ZIP本地结构不一致".into()); }
        let local_name_size = le16(&header, 26)? as usize; let extra = le16(&header, 28)? as u64;
        let mut local_name = vec![0; local_name_size]; file.read_exact(&mut local_name).map_err(|_| "CORRUPT")?;
        if local_name != part.name.as_bytes() { return Err("CORRUPT: ZIP本地路径不一致".into()); }
        let data_start = part.local + 30 + local_name_size as u64 + extra; let end = data_start.checked_add(part.compressed).ok_or("CORRUPT")?;
        if end > offset || ranges.iter().any(|&(a, b)| part.local < b && end > a) { return Err("CORRUPT: ZIP条目越界或重叠".into()); }
        ranges.push((part.local, end));
        if part.name.ends_with(".xml") || part.name.ends_with(".rels") {
            xml_bytes += part.plain;
            if part.plain > 4 * 1024 * 1024 || xml_bytes > 32 * 1024 * 1024 { return Err("UNSUPPORTED_RESTRICTED: XML部件预算超限".into()); }
            file.seek(SeekFrom::Start(data_start)).map_err(|_| "READ_FAILED")?;
            let mut bytes = Vec::with_capacity(part.plain as usize);
            if part.method == 0 { file.take(part.compressed).read_to_end(&mut bytes).map_err(|_| "CORRUPT")?; }
            else { flate2::read::DeflateDecoder::new(file.take(part.compressed)).take(part.plain + 1).read_to_end(&mut bytes).map_err(|_| "CORRUPT: XML解压失败")?; }
            if bytes.len() as u64 != part.plain || crc32(&bytes) != part.crc { return Err("CORRUPT: XML部件长度或CRC不符".into()); }
            check_xml(&part.name, &bytes, &names)?;
        }
    }
    Ok(())
}
fn check_office(file: &mut File, format: &str) -> Result<(), String> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    match format {
        "docx" | "pptx" | "xlsx" => check_openxml(file, format),
        "rtf" => {
            let size = file.metadata().map_err(|_| "READ_FAILED")?.len();
            if size > 16 * 1024 * 1024 { return Err("UNSUPPORTED_RESTRICTED: RTF安全检查限制16MiB".into()); }
            let mut bytes = Vec::new(); file.take(size + 1).read_to_end(&mut bytes).map_err(|_| "READ_FAILED")?;
            if !bytes.starts_with(b"{\\rtf") { return Err("CORRUPT: RTF签名无效".into()); }
            let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            for feature in ["\\object", "\\objdata", "\\field", "\\filetbl", "\\bin", "\\datafield"] {
                if text.contains(feature) { return Err("UNSUPPORTED_RESTRICTED: RTF包含未支持的对象或外部字段".into()); }
            }
            Ok(())
        },
        // Legacy OLE compound formats can hide VBA/DDE/embedded objects; do not call
        // LO on an opaque container without a verified compound-file parser.
        "doc" | "ppt" | "pps" | "pot" | "xls" => Err("UNSUPPORTED_RESTRICTED: 旧版Office复合格式暂未通过宏和外链安全验证；请先另存为docx/pptx/xlsx".into()),
        _ => Err("UNSUPPORTED".into()),
    }
}
