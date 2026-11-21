//! Protected sequential source-byte windows, with independent editor ownership.
use super::{guard, resources};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::WebviewWindow;
const BLOCK: usize = 65536;
const TTL: Duration = Duration::from_secs(60);
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct DocumentInfo { pub doc_id: String, pub revision: String, pub size_bytes: String, pub encoding: String, pub initial_cursor: String }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct WindowData { pub text: String, pub next_cursor: Option<String>, pub eof: bool, pub source_start_byte: String, pub source_end_byte: String, pub canonical_start_byte: String, pub canonical_end_byte: String, pub source_hash: Option<String> }
struct Document { pins: guard::RootedPath, file_id: String, file: File, revision: String, size: u64, encoding: String, next: u64, canonical: u64, hasher: Sha256, replay: Option<(String, WindowData)>, touched: Instant }
struct Lease { owner: String, instance: Arc<guard::Instance>, cancel: AtomicBool, state: Mutex<Document>, _credit: resources::ByteCredit }
static DOCS: OnceLock<Mutex<HashMap<String, Arc<Lease>>>> = OnceLock::new();
fn docs() -> &'static Mutex<HashMap<String, Arc<Lease>>> { DOCS.get_or_init(Default::default) }
fn owner(window: &WebviewWindow, root_id: &str) -> Result<(String, Arc<guard::Instance>), String> {
    let i = guard::instance(window.label())?; guard::live(&i)?;
    Ok((format!("{}\n{}\n{}", i.label, i.nonce, root_id), i))
}
fn cleanup(map: &mut HashMap<String, Arc<Lease>>) { map.retain(|_, v| v.state.try_lock().map(|d| d.touched.elapsed() < TTL && !v.cancel.load(Ordering::Acquire)).unwrap_or(true)); }
fn open_document(own: String, instance: Arc<guard::Instance>, pins: guard::RootedPath, credit: resources::ByteCredit) -> Result<DocumentInfo, String> {
    guard::live(&instance)?; let mut file = pins.read()?; let file_id = guard::identity(&file)?;
    let _lock = guard::lock_file(&file_id)?; let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut head = [0u8; 3]; let n = file.read(&mut head).map_err(|e| e.to_string())?;
    let encoding = if n >= 3 && head == [0xef,0xbb,0xbf] { "utf-8-bom" } else if n >= 2 && head[..2] == [0xff,0xfe] { "utf-16le" } else if n >= 2 && head[..2] == [0xfe,0xff] { "utf-16be" } else { "utf-8" };
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string(); let revision = format!("{}:{}", uuid::Uuid::new_v4(), file_id);
    let info = DocumentInfo { doc_id: id.clone(), revision: revision.clone(), size_bytes: size.to_string(), encoding: encoding.into(), initial_cursor: "0".into() };
    let mut map = docs().lock().map_err(|_| "DOC_BUSY")?; cleanup(&mut map);
    if map.len() >= 32 { return Err("BUSY_RETRY: 文档读取租约已满".into()); }
    guard::live(&instance)?;
    guard::manage(&instance, &pins.root_id, &file_id, &pins.path)?;
    let doc = Document { pins, file_id, file, revision, size, encoding: encoding.into(), next: 0, canonical: 0, hasher: Sha256::new(), replay: None, touched: Instant::now() };
    map.insert(id, Arc::new(Lease { owner: own, instance, cancel: AtomicBool::new(false), state: Mutex::new(doc), _credit: credit })); Ok(info)
}
#[tauri::command]
pub async fn fs_perf_open_document(window: WebviewWindow, root_uri: String, path: String) -> Result<DocumentInfo, String> {
    let permit = resources::admit(BLOCK * 6)?; let credit = resources::ByteCredit::acquire(BLOCK * 8)?;
    let pins = guard::RootedPath::new(&root_uri, &path, false)?; let (own, instance) = owner(&window, &pins.root_id)?;
    tauri::async_runtime::spawn_blocking(move || { let _permit = permit; open_document(own, instance, pins, credit) }).await.map_err(|e| e.to_string())?
}
fn lookup(window: &WebviewWindow, root_uri: &str, id: &str) -> Result<Arc<Lease>, String> {
    if id.len() > 64 { return Err("DOC_INVALID".into()); }
    let root = guard::RootedPath::new(root_uri, "", false)?; let (own, _) = owner(window, &root.root_id)?;
    let mut map = docs().lock().map_err(|_| "DOC_BUSY")?; cleanup(&mut map);
    let doc = map.get(id).cloned().ok_or("DOC_EXPIRED")?;
    if doc.owner != own { return Err("DOC_SCOPE".into()); } Ok(doc)
}
fn decode(raw: &[u8], encoding: &str, offset: u64, final_bytes: bool) -> Result<(usize, String), String> {
    let bom = if offset == 0 { match encoding { "utf-8-bom" => 3, "utf-16le" | "utf-16be" => 2, _ => 0 } } else { 0 };
    if raw.len() < bom { return Err("ENCODING_REQUIRED".into()); }
    let bytes = &raw[bom..]; let mut used = bytes.len();
    let text = if encoding.starts_with("utf-8") {
        match std::str::from_utf8(bytes) { Ok(s) => s.into(), Err(e) => {
            if e.error_len().is_some() || final_bytes { return Err("ENCODING_REQUIRED".into()); }
            used = e.valid_up_to(); std::str::from_utf8(&bytes[..used]).map_err(|_| "ENCODING_REQUIRED")?.into()
        } }
    } else {
        if used % 2 != 0 { if final_bytes { return Err("ENCODING_REQUIRED".into()); } used -= 1; }
        let be = encoding == "utf-16be";
        let mut units: Vec<u16> = bytes[..used].chunks_exact(2).map(|v| if be { u16::from_be_bytes([v[0],v[1]]) } else { u16::from_le_bytes([v[0],v[1]]) }).collect();
        if !final_bytes && units.last().map(|v| (0xd800..=0xdbff).contains(v)).unwrap_or(false) { units.pop(); used -= 2; }
        String::from_utf16(&units).map_err(|_| "ENCODING_REQUIRED")?
    };
    Ok((used + bom, text))
}
fn read_window(doc: &mut Document, cursor: &str, revision: &str) -> Result<WindowData, String> {
    if revision != doc.revision { return Err("SOURCE_CHANGED".into()); }
    if doc.touched.elapsed() >= TTL { return Err("DOC_EXPIRED".into()); }
    doc.pins.verify()?;
    if guard::identity(&doc.file)? != doc.file_id { return Err("SOURCE_CHANGED".into()); }
    if let Some((key, value)) = &doc.replay { if key == cursor { doc.touched = Instant::now(); return Ok(value.clone()); } }
    let offset = cursor.parse::<u64>().map_err(|_| "INVALID_CURSOR")?;
    if offset != doc.next || offset > doc.size { return Err("INVALID_CURSOR".into()); }
    doc.file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut raw = vec![0u8; (doc.size - offset).min(BLOCK as u64) as usize];
    doc.file.read_exact(&mut raw).map_err(|_| "SOURCE_CHANGED")?;
    let mut candidate = raw.len();
    let (used, out) = loop {
        let (used, text) = decode(&raw[..candidate], &doc.encoding, offset, offset + candidate as u64 == doc.size)?;
        if used == 0 && offset < doc.size { return Err("INVALID_BOUNDARY".into()); }
        let next = offset + used as u64; let end = doc.canonical + text.len() as u64; let eof = next == doc.size;
        let hash = eof.then(|| { let mut h = doc.hasher.clone(); h.update(&raw[..used]); format!("sha256:{:x}", h.finalize()) });
        let out = WindowData { text, next_cursor: (!eof).then(|| next.to_string()), eof, source_start_byte: offset.to_string(), source_end_byte: next.to_string(), canonical_start_byte: doc.canonical.to_string(), canonical_end_byte: end.to_string(), source_hash: hash };
        if serde_json::to_vec(&out).map_err(|e| e.to_string())?.len() <= 256 * 1024 { break (used, out); }
        candidate = used / 2; if candidate < 4 { return Err("RESPONSE_BUDGET_TOO_SMALL".into()); }
    };
    doc.hasher.update(&raw[..used]); doc.next = offset + used as u64;
    doc.canonical = out.canonical_end_byte.parse().map_err(|_| "INVALID_OFFSET")?;
    doc.replay = Some((cursor.into(), out.clone())); doc.touched = Instant::now(); Ok(out)
}
#[tauri::command]
pub async fn fs_perf_read_window(window: WebviewWindow, root_uri: String, doc_id: String, revision: String, cursor: String) -> Result<WindowData, String> {
    if revision.len() > 256 || cursor.len() > 20 { return Err("DOCUMENT_ARGUMENTS_INVALID".into()); }
    let permit = resources::admit(BLOCK * 12)?; let lease = lookup(&window, &root_uri, &doc_id)?;
    tauri::async_runtime::spawn_blocking(move || { let _permit = permit;
        if lease.cancel.load(Ordering::Acquire) { return Err("DOC_CLOSED".into()); } guard::live(&lease.instance)?;
        let mut doc = lease.state.lock().map_err(|_| "DOC_BUSY")?; let out = read_window(&mut doc, &cursor, &revision)?;
        guard::live(&lease.instance)?; if lease.cancel.load(Ordering::Acquire) { return Err("DOC_CLOSED".into()); } Ok(out)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn fs_perf_close_document(window: WebviewWindow, root_uri: String, doc_id: String) -> Result<(), String> {
    let lease = lookup(&window, &root_uri, &doc_id)?; lease.cancel.store(true, Ordering::Release);
    docs().lock().map_err(|_| "DOC_BUSY")?.remove(&doc_id); Ok(())
}
#[tauri::command]
pub fn fs_perf_release_file(window: WebviewWindow, root_uri: String, path: String) -> Result<(), String> {
    let pins = guard::RootedPath::new(&root_uri, &path, true)?; let (_, instance) = owner(&window, &pins.root_id)?;
    guard::release_managed(&instance, &pins.root_id, &pins.path); Ok(())
}
pub fn destroy_instance(instance: &guard::Instance) {
    if let Ok(mut map) = docs().lock() { map.retain(|_, lease| { if lease.instance.nonce == instance.nonce { lease.cancel.store(true, Ordering::Release); false } else { true } }); }
    guard::destroy_managed(instance);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn scalar_and_bom_decode() {
        assert_eq!(decode(b"\xef\xbb\xbfhi\r\n", "utf-8-bom", 0, true).unwrap(), (7,"hi\r\n".into()));
        assert_eq!(decode(&[0xff,0xfe,0x3d,0xd8,0,0xde], "utf-16le", 0, true).unwrap().1, "😀");
        assert_eq!(decode(&[0xfe,0xff,0xd8,0x3d,0xde,0], "utf-16be", 0, true).unwrap().1, "😀");
        assert!(decode(&[0xff,0xfe,0x3d,0xd8], "utf-16le", 0, true).is_err());
        assert_eq!(decode(&[b'a',0xf0,0x9f], "utf-8", 0, false).unwrap(), (1,"a".into()));
    }
}
