//! CR-055 FEAT-008: bounded original-file transfer with task progress/cancel.
//! Original transfer never publishes the full-text index; the two completions are reported separately.
//!
//! 注册表与任务状态分离：`Slot` 只保存不可变属主、取消标志与完成序号，易变的任务字段放在
//! `Mutex<TransferTask>` 中由工作线程高频更新。因此注册表锁内只读 `Slot` 的不可变字段，
//! 绝不获取任务锁，复制过程不会阻塞注册、状态查询与取消。
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

const BLOCK: usize = 64 * 1024;
/// 同时运行的任务上限；超出的导入/导出请求返回 `BUSY_RETRY`。
const MAX_ACTIVE: usize = 4;
/// 终态任务保留上限，按完成顺序淘汰最旧的一条；终态可继续查询，但 id 永不复用。
const MAX_FINISHED: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub bytes: String,
    pub sha256: String,
    pub published: bool,
    pub index_pending: bool,
}

/// 已成功发布的单个文件；多文件导入部分失败时保留，不因后续失败丢弃。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFile {
    pub name: String,
    pub relative_uri: String,
    pub note_id: String,
    pub bytes: String,
    pub sha256: String,
}

/// 单个文件的失败记录。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFailure {
    pub name: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub library_id: String,
    pub kind: String,
    pub phase: String,
    /// 当前文件已复制的字节数。多文件任务中每个文件开始时归零，不累计整个任务。
    pub processed_bytes: String,
    /// 当前文件的源字节数（来自 `fs::metadata`）。多文件任务中它只描述正在处理的文件，
    /// 不代表任务总量，也不能与 `processed_bytes` 组合出跨文件的整体百分比。
    pub total_bytes: Option<String>,
    /// 最近一个成功发布文件的摘要；完整清单见 `completed_files`。
    pub sha256: Option<String>,
    /// 最近一个成功发布文件的库内 id；完整清单见 `completed_files`。
    pub note_id: Option<String>,
    /// 最近一个成功发布文件的库内相对 URI；完整清单见 `completed_files`。
    pub relative_uri: Option<String>,
    /// 首个失败原因，供旧前端继续读取；全部失败见 `failed_files`。
    pub error: Option<String>,
    pub index_pending: bool,
    pub cancel_requested: bool,
    /// 正在处理（或刚处理完）的文件名；任务进入终态时清空。
    pub current_file: Option<String>,
    /// 当前文件序号（1 起）；任务结束后保留最后一个序号。
    pub file_index: usize,
    /// 本次任务文件总数：导入为选择结果数量，导出固定为 1。
    pub file_total: usize,
    /// 已成功发布的文件，按完成顺序。
    pub completed_files: Vec<TransferFile>,
    /// 失败的文件及原因，按尝试顺序。
    pub failed_files: Vec<TransferFailure>,
}

struct Slot {
    /// 创建任务的窗口 label；跨窗口访问一律 `TRANSFER_SCOPE`。
    owner: String,
    cancel: Arc<AtomicBool>,
    /// `0` 表示仍在运行；非 `0` 是全局完成序号，用于有界淘汰终态。
    finished: AtomicU64,
    /// 易变的任务状态，仅由工作线程与查询/取消命令短暂持有。
    task: Mutex<TransferTask>,
}

impl Slot {
    fn active(&self) -> bool {
        self.finished.load(Ordering::Acquire) == 0
    }
    /// 记录完成顺序；只有第一次调用生效，重复收尾不会打乱淘汰顺序。
    fn finish(&self) {
        let sequence = FINISH_SEQ.fetch_add(1, Ordering::AcqRel);
        let _ = self.finished.compare_exchange(0, sequence, Ordering::AcqRel, Ordering::Acquire);
    }
}

type Registry = HashMap<String, Arc<Slot>>;
static TASKS: OnceLock<Mutex<Registry>> = OnceLock::new();
static FINISH_SEQ: AtomicU64 = AtomicU64::new(1);

fn tasks() -> &'static Mutex<Registry> {
    TASKS.get_or_init(Default::default)
}

fn terminal(phase: &str) -> bool {
    matches!(phase, "completed" | "failed" | "cancelled")
}

fn copy_to_temp(source: &Path, temp: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> Result<(u64, String), String> {
    let mut input = File::open(source).map_err(|e| format!("TRANSFER_SOURCE: {e}"))?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(temp).map_err(|e| format!("TRANSFER_TEMP: {e}"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; BLOCK];
    loop {
        if cancel.load(Ordering::Acquire) { return Err("TRANSFER_CANCELLED".into()); }
        let read = input.read(&mut buffer).map_err(|e| format!("TRANSFER_READ: {e}"))?;
        if read == 0 { break; }
        output.write_all(&buffer[..read]).map_err(|e| format!("TRANSFER_WRITE: {e}"))?;
        hash.update(&buffer[..read]);
        bytes += read as u64;
        progress(bytes);
    }
    output.sync_all().map_err(|e| format!("TRANSFER_DURABILITY: {e}"))?;
    Ok((bytes, format!("sha256:{:x}", hash.finalize())))
}

fn publish(source: &Path, target: &Path, cancel: &AtomicBool, progress: impl FnMut(u64)) -> Result<TransferResult, String> {
    if target.exists() { return Err("同名目标已存在，未覆盖原件 (TRANSFER_TARGET_EXISTS)".into()); }
    let parent = target.parent().ok_or("TRANSFER_TARGET_PARENT")?;
    fs::create_dir_all(parent).map_err(|e| format!("TRANSFER_PARENT: {e}"))?;
    let temp = parent.join(format!(".nestcraft-kb-transfer-{}.tmp", uuid::Uuid::new_v4()));
    let outcome = copy_to_temp(source, &temp, cancel, progress).and_then(|(bytes, sha256)| {
        if cancel.load(Ordering::Acquire) { return Err("TRANSFER_CANCELLED".into()); }
        // hard_link is a no-replace publication primitive on supported same-volume filesystems.
        fs::hard_link(&temp, target).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists {
            "同名目标已存在，未覆盖原件 (TRANSFER_TARGET_EXISTS)".to_string()
        } else { format!("TRANSFER_PUBLISH_UNSUPPORTED: {e}") })?;
        let _ = fs::remove_file(&temp);
        Ok(TransferResult { bytes: bytes.to_string(), sha256, published: true, index_pending: true })
    });
    if outcome.is_err() { let _ = fs::remove_file(&temp); }
    outcome
}

/// Import without replacing an existing target. The caller owns path/root authorization.
pub fn import_no_replace(source: &Path, target: &Path, cancel: &AtomicBool) -> Result<TransferResult, String> {
    publish(source, target, cancel, |_| {})
}
/// Export to a new target; an existing target is never overwritten.
pub fn export_no_replace(source: &Path, target: &Path, cancel: &AtomicBool) -> Result<TransferResult, String> {
    publish(source, target, cancel, |_| {}).map(|mut result| { result.index_pending = false; result })
}

fn initial_task(id: &str, library_id: &str, kind: &str) -> TransferTask {
    TransferTask {
        id: id.into(), library_id: library_id.into(), kind: kind.into(), phase: "queued".into(),
        processed_bytes: "0".into(), total_bytes: None, sha256: None, note_id: None, relative_uri: None,
        error: None, index_pending: false, cancel_requested: false, current_file: None,
        file_index: 0, file_total: 0, completed_files: Vec::new(), failed_files: Vec::new(),
    }
}

/// 只保留完成顺序最新的 `limit` 个终态；活跃任务永不淘汰。
/// 调用方必须持有注册表锁，且本函数不获取任何任务锁。
fn prune_finished(registry: &mut Registry, limit: usize) {
    let mut finished: Vec<(u64, String)> = registry.iter().filter_map(|(id, slot)| {
        let sequence = slot.finished.load(Ordering::Acquire);
        (sequence != 0).then(|| (sequence, id.clone()))
    }).collect();
    if finished.len() <= limit { return; }
    finished.sort_unstable_by_key(|(sequence, _)| *sequence);
    let excess = finished.len() - limit;
    for (_, id) in finished.into_iter().take(excess) { registry.remove(&id); }
}

fn register(registry: &Mutex<Registry>, owner: &str, id: &str, library_id: &str, kind: &str) -> Result<Arc<Slot>, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "REQUEST_ID_INVALID")?;
    let mut map = registry.lock().map_err(|_| "TRANSFER_BUSY")?;
    prune_finished(&mut map, MAX_FINISHED);
    // 终态保留在表中供查询，但 id 永不复用，避免旧结果与新任务混淆。
    if map.contains_key(id) { return Err("REQUEST_ID_REUSED".into()); }
    // 注册表锁内只读不可变属主与原子完成序号，不获取任务锁。
    if map.values().filter(|slot| slot.active()).count() >= MAX_ACTIVE {
        return Err("BUSY_RETRY: 已有原件传输任务在运行".into());
    }
    let slot = Arc::new(Slot {
        owner: owner.into(),
        cancel: Arc::new(AtomicBool::new(false)),
        finished: AtomicU64::new(0),
        task: Mutex::new(initial_task(id, library_id, kind)),
    });
    map.insert(id.into(), slot.clone());
    Ok(slot)
}

fn locate(registry: &Mutex<Registry>, owner: &str, id: &str) -> Result<Arc<Slot>, String> {
    let slot = {
        let map = registry.lock().map_err(|_| "TRANSFER_BUSY")?;
        map.get(id).cloned().ok_or("TRANSFER_NOT_FOUND")?
    };
    // 属主不可变，检查在注册表锁外完成。
    if slot.owner != owner { return Err("TRANSFER_SCOPE".into()); }
    Ok(slot)
}

fn snapshot(slot: &Slot) -> Result<TransferTask, String> {
    slot.task.lock().map(|task| task.clone()).map_err(|_| "TRANSFER_BUSY".to_string())
}

fn status_of(registry: &Mutex<Registry>, owner: &str, id: &str) -> Result<TransferTask, String> {
    let slot = locate(registry, owner, id)?;
    snapshot(&slot)
}

/// 非终态更新。终态只读：任何迟到的进度或阶段写入都不会改写已发布的结果。
fn update(slot: &Arc<Slot>, change: impl FnOnce(&mut TransferTask)) {
    if let Ok(mut task) = slot.task.lock() {
        if !terminal(&task.phase) { change(&mut task); }
    }
}

/// 登记终态并裁剪保留数量；调用前必须已释放任务锁。
fn mark_finished(registry: &Mutex<Registry>, slot: &Arc<Slot>) {
    slot.finish();
    if let Ok(mut map) = registry.lock() { prune_finished(&mut map, MAX_FINISHED); }
}

/// 把任务收尾到终态。重复收尾不改变已有结果。
fn retire(registry: &Mutex<Registry>, slot: &Arc<Slot>, change: impl FnOnce(&mut TransferTask)) {
    {
        match slot.task.lock() {
            Ok(mut task) => {
                if terminal(&task.phase) { return; }
                change(&mut task);
            }
            // 任务锁中毒：保守收尾，避免活跃配额永久泄漏。
            Err(_) => {}
        }
    }
    mark_finished(registry, slot);
}

fn cancelled(registry: &Mutex<Registry>, slot: &Arc<Slot>) {
    retire(registry, slot, |task| {
        task.phase = "cancelled".into();
        task.error = Some("TRANSFER_CANCELLED".into());
        task.current_file = None;
    });
}

fn record_success(task: &mut TransferTask, name: &str, relative_uri: &str, result: &TransferResult) {
    task.completed_files.push(TransferFile {
        name: name.to_string(),
        relative_uri: relative_uri.to_string(),
        note_id: super::files::file_id(relative_uri),
        bytes: result.bytes.clone(),
        sha256: result.sha256.clone(),
    });
    // 顶层字段表示"最近一个成功文件"，单文件任务即该文件；完整清单见 completedFiles。
    task.relative_uri = Some(relative_uri.to_string());
    task.note_id = Some(super::files::file_id(relative_uri));
    task.sha256 = Some(result.sha256.clone());
    task.index_pending = true;
}

fn record_failure(task: &mut TransferTask, name: &str, error: &str) {
    task.failed_files.push(TransferFailure { name: name.to_string(), error: error.to_string() });
}

fn import_one(slot: &Arc<Slot>, library_id: &str, parent_uri: &str, source: &Path, name: &str, cancel: &AtomicBool) -> Result<(String, TransferResult), String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = super::enabled_root(conn, library_id)?;
    let directory = root.parent(parent_uri)?;
    let relative = super::files::child_uri(parent_uri, name)?;
    let target = directory.join(name);
    drop(guard);
    let result = publish(source, &target, cancel, |bytes| update(slot, |task| task.processed_bytes = bytes.to_string()))?;
    Ok((relative, result))
}

/// 多选导入：逐个尝试，单个文件失败不中断，也不丢弃已成功的文件记录。
fn transfer_import_paths(registry: &Mutex<Registry>, slot: &Arc<Slot>, library_id: &str, parent_uri: &str, paths: &[PathBuf], cancel: &AtomicBool) {
    let total = paths.len();
    update(slot, |task| task.file_total = total);
    for (index, source) in paths.iter().enumerate() {
        if cancel.load(Ordering::Acquire) { cancelled(registry, slot); return; }
        let name = source.file_name().map(|raw| raw.to_string_lossy().to_string()).unwrap_or_default();
        // 进度只描述"当前文件"：每个文件开始时重置已复制字节与当前文件总量，不提供跨文件百分比。
        update(slot, |task| {
            task.phase = "copying".into();
            task.current_file = Some(name.clone());
            task.file_index = index + 1;
            task.processed_bytes = "0".into();
            task.total_bytes = fs::metadata(source).ok().map(|meta| meta.len().to_string());
        });
        match import_one(slot, library_id, parent_uri, source, &name, cancel) {
            Ok((relative_uri, result)) => update(slot, |task| record_success(task, &name, &relative_uri, &result)),
            Err(error) => {
                let interrupted = error.contains("CANCELLED");
                update(slot, |task| record_failure(task, &name, &error));
                if interrupted { cancelled(registry, slot); return; }
            }
        }
    }
    let first_failure = slot.task.lock().ok().and_then(|task| task.failed_files.first().cloned());
    match first_failure {
        Some(first) => retire(registry, slot, |task| {
            task.phase = "failed".into();
            task.error = Some(first.error);
            task.current_file = None;
        }),
        None => retire(registry, slot, |task| { task.phase = "completed".into(); task.current_file = None; }),
    }
}

fn run_export(registry: &Mutex<Registry>, slot: &Arc<Slot>, library_id: &str, relative: &str) {
    update(slot, |task| task.phase = "picking".into());
    let picked = tauri::async_runtime::block_on(super::files::picker(true));
    let cancel = slot.cancel.clone();
    let destination = match picked {
        Err(error) => { retire(registry, slot, |task| { task.phase = "failed".into(); task.error = Some(error); }); return; }
        Ok(None) => { cancelled(registry, slot); return; }
        Ok(Some(paths)) => match paths.into_iter().next() {
            Some(path) => path,
            None => { cancelled(registry, slot); return; }
        },
    };
    let outcome = (|| -> Result<TransferResult, String> {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let mut root = super::enabled_root(conn, library_id)?;
        let source = root.file(relative)?;
        drop(guard);
        update(slot, |task| {
            task.phase = "copying".into();
            task.current_file = destination.file_name().map(|raw| raw.to_string_lossy().to_string());
            task.processed_bytes = "0".into();
            task.total_bytes = fs::metadata(&source).ok().map(|meta| meta.len().to_string());
        });
        publish(&source, &destination, &cancel, |bytes| update(slot, |task| task.processed_bytes = bytes.to_string()))
    })();
    match outcome {
        Ok(result) => retire(registry, slot, |task| {
            task.phase = "completed".into();
            task.sha256 = Some(result.sha256);
            task.current_file = None;
        }),
        Err(error) => {
            if error.contains("CANCELLED") { cancelled(registry, slot); }
            else {
                retire(registry, slot, |task| {
                    task.phase = "failed".into();
                    task.error = Some(error);
                    task.current_file = None;
                });
            }
        }
    }
}

fn cancel_task(registry: &Mutex<Registry>, owner: &str, id: &str) -> Result<TransferTask, String> {
    let slot = locate(registry, owner, id)?;
    let result = {
        let mut task = slot.task.lock().map_err(|_| "TRANSFER_BUSY")?;
        // 终态只读：已结束的任务不再改 phase，也不置取消标志。
        if terminal(&task.phase) { return Ok(task.clone()); }
        slot.cancel.store(true, Ordering::Release);
        task.cancel_requested = true;
        // queued/picking 阶段没有可中断的复制块，直接进入终态，避免前端看到永远"取消中"的任务；
        // copying 阶段由工作线程在块边界收尾，迟到的 update 会被终态保护挡下。
        if matches!(task.phase.as_str(), "queued" | "picking") {
            task.phase = "cancelled".into();
            task.error = Some("TRANSFER_CANCELLED".into());
        }
        task.clone()
    };
    if terminal(&result.phase) && slot.active() { mark_finished(registry, &slot); }
    Ok(result)
}

#[tauri::command]
pub async fn kb_transfer_import(window: tauri::WebviewWindow, library_id: String, parent_uri: String, task_id: String) -> Result<TransferTask, String> {
    let registry = tasks();
    let slot = register(registry, window.label(), &task_id, &library_id, "import")?;
    // 先校验目标目录，再弹原生选择器；校验失败必须收尾，不能留下永远 queued 的活跃槽位。
    let checked = (|| -> Result<(), String> {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let mut root = super::enabled_root(conn, &library_id)?;
        root.parent(&parent_uri)?;
        Ok(())
    })();
    if let Err(error) = checked {
        retire(registry, &slot, |task| { task.phase = "failed".into(); task.error = Some(error.clone()); });
        return Err(error);
    }
    let worker = slot.clone();
    let library_id = library_id.clone();
    let parent_uri = parent_uri.clone();
    let spawned = std::thread::Builder::new().name("kb-transfer".into()).spawn(move || {
        update(&worker, |task| task.phase = "picking".into());
        // picker 由独立的 powershell.exe -STA 进程弹出系统对话框，不依赖 AppHandle 或 UI 主线程，
        // 所以在工作线程内 block_on 是安全的，无需改到命令层等待选择结果。
        let picked = tauri::async_runtime::block_on(super::files::picker(false));
        let cancel = worker.cancel.clone();
        match picked {
            Err(error) => retire(registry, &worker, |task| { task.phase = "failed".into(); task.error = Some(error); }),
            Ok(None) => cancelled(registry, &worker),
            Ok(Some(paths)) => transfer_import_paths(registry, &worker, &library_id, &parent_uri, &paths, &cancel),
        }
    });
    if let Err(error) = spawned {
        // 槽位登记在 spawn 之前；线程创建失败必须收尾，否则会永久占用 MAX_ACTIVE。
        let message = format!("TRANSFER_THREAD: {error}");
        retire(registry, &slot, |task| { task.phase = "failed".into(); task.error = Some(message.clone()); });
        return Err(message);
    }
    snapshot(&slot)
}

#[tauri::command]
pub async fn kb_transfer_export(window: tauri::WebviewWindow, library_id: String, note_id: String, task_id: String) -> Result<TransferTask, String> {
    let registry = tasks();
    let slot = register(registry, window.label(), &task_id, &library_id, "export")?;
    let checked = (|| -> Result<String, String> {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let mut root = super::enabled_root(conn, &library_id)?;
        let (relative, _) = super::resolve(conn, &mut root, &library_id, &note_id)?;
        root.file(&relative)?;
        Ok(relative)
    })();
    let relative = match checked {
        Ok(relative) => relative,
        Err(error) => {
            retire(registry, &slot, |task| { task.phase = "failed".into(); task.error = Some(error.clone()); });
            return Err(error);
        }
    };
    update(&slot, |task| { task.relative_uri = Some(relative.clone()); task.file_total = 1; });
    let worker = slot.clone();
    let library_id = library_id.clone();
    let spawned = std::thread::Builder::new().name("kb-transfer".into()).spawn(move || {
        run_export(registry, &worker, &library_id, &relative)
    });
    if let Err(error) = spawned {
        let message = format!("TRANSFER_THREAD: {error}");
        retire(registry, &slot, |task| { task.phase = "failed".into(); task.error = Some(message.clone()); });
        return Err(message);
    }
    snapshot(&slot)
}

#[tauri::command]
pub fn kb_transfer_status(window: tauri::WebviewWindow, task_id: String) -> Result<TransferTask, String> {
    status_of(tasks(), window.label(), &task_id)
}

#[tauri::command]
pub fn kb_transfer_cancel(window: tauri::WebviewWindow, task_id: String) -> Result<TransferTask, String> {
    cancel_task(tasks(), window.label(), &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Mutex<Registry> { Mutex::new(HashMap::new()) }

    fn new_id() -> String { uuid::Uuid::new_v4().to_string() }

    fn add(registry: &Mutex<Registry>, owner: &str) -> String {
        let id = new_id();
        register(registry, owner, &id, "library", "import").expect("register");
        id
    }

    fn settle(registry: &Mutex<Registry>, owner: &str, id: &str, phase: &str) {
        let slot = locate(registry, owner, id).expect("locate");
        retire(registry, &slot, |task| task.phase = phase.to_string());
    }

    fn result(bytes: &str, sha256: &str) -> TransferResult {
        TransferResult { bytes: bytes.into(), sha256: sha256.into(), published: true, index_pending: true }
    }

    #[test]
    fn import_and_export_are_bounded_and_no_replace() {
        let root = std::env::temp_dir().join(format!("cr055-transfer-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.bin"); let imported = root.join("imported.bin"); let exported = root.join("exported.bin");
        fs::write(&source, b"transfer bytes\n").unwrap();
        let cancel = AtomicBool::new(false);
        let imported_result = import_no_replace(&source, &imported, &cancel).unwrap();
        assert!(imported_result.published && imported_result.index_pending);
        assert_eq!(fs::read(&imported).unwrap(), b"transfer bytes\n");
        assert_eq!(export_no_replace(&imported, &exported, &cancel).unwrap().published, true);
        assert!(import_no_replace(&source, &imported, &cancel).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_leaves_no_target_or_temp() {
        let root = std::env::temp_dir().join(format!("cr055-transfer-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap(); let source = root.join("source.bin"); let target = root.join("target.bin");
        fs::write(&source, vec![7u8; BLOCK * 2]).unwrap(); let cancel = AtomicBool::new(true);
        assert_eq!(import_no_replace(&source, &target, &cancel).unwrap_err(), "TRANSFER_CANCELLED");
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn progress_reports_monotonic_bytes_and_hash_is_original_source() {
        let root = std::env::temp_dir().join(format!("cr055-transfer-progress-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.bin"); let target = root.join("target.bin");
        let payload = vec![9u8; BLOCK * 2 + 17]; fs::write(&source, &payload).unwrap();
        let cancel = AtomicBool::new(false); let mut seen = Vec::new();
        let result = publish(&source, &target, &cancel, |bytes| seen.push(bytes)).unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(result.bytes, payload.len().to_string());
        assert_eq!(result.sha256, format!("sha256:{:x}", Sha256::digest(&payload)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_tasks_are_bounded_to_max_active() {
        let registry = registry();
        let ids: Vec<String> = (0..MAX_ACTIVE).map(|_| add(&registry, "win-main")).collect();
        assert_eq!(ids.len(), MAX_ACTIVE);
        let error = register(&registry, "win-main", &new_id(), "library", "import").err().expect("fifth task is rejected");
        assert!(error.starts_with("BUSY_RETRY"), "{error}");
        // 终态不再占用活跃配额。
        settle(&registry, "win-main", &ids[0], "completed");
        register(&registry, "win-main", &new_id(), "library", "import").expect("slot released");
    }

    #[test]
    fn reusing_a_task_id_is_rejected() {
        let registry = registry();
        let id = new_id();
        register(&registry, "win-main", &id, "library", "import").expect("first registration");
        let error = register(&registry, "win-main", &id, "library", "import").err().expect("duplicate rejected");
        assert_eq!(error, "REQUEST_ID_REUSED");
        // 终态 id 同样不复用，避免旧结果与新任务混淆。
        settle(&registry, "win-main", &id, "completed");
        assert_eq!(register(&registry, "win-main", &id, "library", "import").err().expect("terminal id rejected"), "REQUEST_ID_REUSED");
    }

    #[test]
    fn another_window_cannot_read_or_cancel() {
        let registry = registry();
        let id = add(&registry, "win-a");
        assert_eq!(status_of(&registry, "win-b", &id).err().expect("scope"), "TRANSFER_SCOPE");
        assert_eq!(cancel_task(&registry, "win-b", &id).err().expect("scope"), "TRANSFER_SCOPE");
        let task = status_of(&registry, "win-a", &id).expect("owner reads");
        assert_eq!(task.phase, "queued");
        assert!(!task.cancel_requested);
    }

    #[test]
    fn cancelled_task_stays_queryable_with_terminal_phase() {
        let registry = registry();
        let id = add(&registry, "win-main");
        let cancelled_task = cancel_task(&registry, "win-main", &id).expect("cancel");
        assert_eq!(cancelled_task.phase, "cancelled");
        assert!(cancelled_task.cancel_requested);
        let polled = status_of(&registry, "win-main", &id).expect("status after cancel");
        assert_eq!(polled.phase, "cancelled");
        assert_eq!(polled.error.as_deref(), Some("TRANSFER_CANCELLED"));
    }

    #[test]
    fn cancelling_a_finished_task_keeps_its_phase() {
        let registry = registry();
        let id = add(&registry, "win-main");
        settle(&registry, "win-main", &id, "completed");
        let again = cancel_task(&registry, "win-main", &id).expect("cancel terminal");
        assert_eq!(again.phase, "completed");
        assert!(!again.cancel_requested);
        assert_eq!(status_of(&registry, "win-main", &id).expect("status").phase, "completed");
    }

    #[test]
    fn finished_tasks_are_bounded_to_the_newest_entries() {
        let registry = registry();
        let mut ids = Vec::new();
        for _ in 0..=MAX_FINISHED {
            let id = add(&registry, "win-main");
            settle(&registry, "win-main", &id, "completed");
            ids.push(id);
        }
        assert_eq!(registry.lock().unwrap().len(), MAX_FINISHED);
        assert_eq!(status_of(&registry, "win-main", &ids[0]).err().expect("oldest evicted"), "TRANSFER_NOT_FOUND");
        assert_eq!(status_of(&registry, "win-main", &ids[MAX_FINISHED]).expect("newest kept").phase, "completed");
    }

    #[test]
    fn partial_import_failure_keeps_successful_files() {
        let mut task = initial_task("id", "library", "import");
        task.file_total = 3;
        record_success(&mut task, "a.md", "docs/a.md", &result("3", "sha256:11"));
        record_failure(&mut task, "b.md", "同名目标已存在，未覆盖原件 (TRANSFER_TARGET_EXISTS)");
        record_success(&mut task, "c.md", "docs/c.md", &result("5", "sha256:22"));
        assert_eq!(task.completed_files.len(), 2);
        assert_eq!(task.failed_files.len(), 1);
        assert_eq!(task.completed_files[0].relative_uri, "docs/a.md");
        assert_eq!(task.completed_files[0].note_id, super::super::files::file_id("docs/a.md"));
        assert_eq!(task.completed_files[1].relative_uri, "docs/c.md");
        assert_eq!(task.failed_files[0].name, "b.md");
        assert_eq!(task.relative_uri.as_deref(), Some("docs/c.md"));
        assert_eq!(task.sha256.as_deref(), Some("sha256:22"));
        assert!(task.index_pending);
    }

    #[test]
    fn task_serializes_camel_case_contract_fields() {
        let mut task = initial_task("id", "library", "import");
        task.file_total = 2;
        record_failure(&mut task, "b.md", "boom");
        let value = serde_json::to_value(&task).unwrap();
        for key in [
            "processedBytes", "totalBytes", "currentFile", "fileIndex", "fileTotal",
            "completedFiles", "failedFiles", "relativeUri", "noteId", "indexPending",
            "cancelRequested", "libraryId",
        ] {
            assert!(value.get(key).is_some(), "missing camelCase field {key}");
        }
        assert_eq!(value["failedFiles"][0]["name"], "b.md");
        assert_eq!(value["failedFiles"][0]["error"], "boom");
    }
}