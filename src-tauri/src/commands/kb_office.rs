//! CR-097：本机受管 Office 转换组件（LibreOffice）的检测、首次使用下载与行政解包。
//!
//! 设计约束（沿用 CR-084 的既有安全边界）：
//!  - 只做「行政解包」（`msiexec /a`），不安装、不改文件关联、不写系统注册表；
//!  - 下载复用 `updater::accelerated_fetch`（候选源、慢源切源、SHA-256 落盘校验）；
//!  - 组件落在统一数据根 `<data>/office/LibreOffice`，与 `storage_layout` 分类一致；
//!  - 转换器只由 `kb_preview` 以私有临时目录 + 无宏配置调用，本模块不执行任何文档。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Emitter;

/// 与 `scripts/prepare-office-runtime.mjs` 同一固定版本与同一官方散列；换版本必须重新核对。
pub const VERSION: &str = "26.2.7";
pub const MSI_SHA256: &str = "480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59";
pub const MSI_FILE: &str = "LibreOffice_26.2.7_Win_x86-64.msi";
/// 约 300 MiB；仅作进度总量提示，实际以响应头为准。
pub const MSI_HINT: u64 = 314_572_800;
pub const MSI_URLS: &[&str] = &[
    "https://mirrors.nju.edu.cn/tdf/libreoffice/stable/26.2.7/win/x86_64/LibreOffice_26.2.7_Win_x86-64.msi",
    "https://download.documentfoundation.org/libreoffice/stable/26.2.7/win/x86_64/LibreOffice_26.2.7_Win_x86-64.msi",
];
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeState {
    pub installed: bool,
    pub dir: String,
    pub version: String,
    /// 平台或安装问题的稳定说明；安装成功时为空。
    pub error: String,
}

fn office_root() -> Result<PathBuf, String> { crate::storage_layout::category("office") }

/// 受管安装目录：`<data>/office/LibreOffice`。
pub fn installed_root() -> Result<PathBuf, String> { Ok(office_root()?.join("LibreOffice")) }

fn soffice_in(base: &Path) -> PathBuf {
    if cfg!(windows) { base.join("program").join("soffice.exe") } else { base.join("program").join("soffice") }
}

/// 转换器定位顺序：显式环境变量 → 受管安装目录 → 资源目录／exe 同级 → 系统安装 → PATH。
/// 与 CR-084 的既有查找保持一致，仅把受管目录改为统一数据根。
pub fn soffice_path(resource: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("NESTCRAFT_SOFFICE") {
        let path = PathBuf::from(configured);
        if !path.is_absolute() || !path.is_file() { return Err("CONVERTER_UNAVAILABLE: 部署配置的转换器路径不可用".into()); }
        return Ok(path);
    }
    let mut candidates = Vec::new();
    if let Ok(root) = installed_root() { candidates.push(soffice_in(&root)); }
    let relative = Path::new("office/LibreOffice/program/soffice.exe");
    if let Some(resource) = resource { candidates.push(resource.join(relative)); }
    if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { candidates.push(dir.join(relative)); } }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(var) { candidates.push(PathBuf::from(dir).join("LibreOffice/program/soffice.exe")); }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) { candidates.push(dir.join("soffice.exe")); candidates.push(dir.join("soffice")); }
    }
    candidates.into_iter().find(|path| path.is_absolute() && path.is_file())
        .ok_or_else(|| "CONVERTER_UNAVAILABLE: 未找到本机文档转换组件".into())
}

pub fn state() -> OfficeState {
    let dir = installed_root().map(|path| path.display().to_string()).unwrap_or_default();
    if !cfg!(windows) {
        return OfficeState { installed: false, dir, version: VERSION.to_string(), error: "OFFICE_UNSUPPORTED_PLATFORM: 受管组件目前仅支持 Windows".into() };
    }
    // 受管目录或本机已安装的 LibreOffice 都算「转换器可用」；error 只承载平台级不可用。
    let installed = soffice_path(None).is_ok();
    OfficeState { installed, dir, version: VERSION.to_string(), error: String::new() }
}

#[tauri::command]
pub fn kb_office_state() -> OfficeState { state() }

fn progress(app: &tauri::AppHandle, phase: &str, done: u64, total: u64) {
    let _ = app.emit("kb-office-progress", serde_json::json!({ "phase": phase, "done": done, "total": total }));
}
fn failure(app: &tauri::AppHandle, error: &str) {
    let _ = app.emit("kb-office-error", serde_json::json!({ "error": error }));
}

/// 下载并行政解包受管组件。幂等：已就绪直接返回；下载完成但解包中断时复用已校验的 MSI。
pub fn prepare_blocking(app: &tauri::AppHandle, cancel: &AtomicBool) -> Result<PathBuf, String> {
    if !cfg!(windows) { return Err("OFFICE_UNSUPPORTED_PLATFORM: 受管组件目前仅支持 Windows".into()); }
    let root = installed_root()?;
    if soffice_in(&root).is_file() { return Ok(root); }
    let cache = office_root()?.join(".cache");
    fs::create_dir_all(&cache).map_err(|_| "OFFICE_CACHE_UNAVAILABLE: 无法创建组件缓存目录".to_string())?;
    let msi = cache.join(MSI_FILE);
    let mut last = 0u64;
    if !(msi.is_file() && crate::commands::knowledge::semantic::install::sha256_file(&msi).map(|hash| hash == MSI_SHA256).unwrap_or(false)) {
        progress(app, "download", 0, MSI_HINT);
        let urls: Vec<String> = MSI_URLS.iter().map(|url| url.to_string()).collect();
        let mut sink = |_url: &str, done: u64, total: u64, _speed: u64| {
            if cancel.load(Ordering::Acquire) { return; }
            // 事件按 1 MiB 节流，避免下载线程被 UI 事件淹没。
            if done.saturating_sub(last) >= 1024 * 1024 || done >= total { last = done; progress(app, "download", done, if total > 0 { total } else { MSI_HINT }); }
        };
        crate::updater::accelerated_fetch(&urls, &msi, MSI_SHA256, MSI_HINT, &mut sink)
            .map_err(|error| format!("OFFICE_DOWNLOAD_FAILED: {error}"))?;
    }
    if cancel.load(Ordering::Acquire) { return Err("CANCELLED: 组件准备已取消".into()); }
    progress(app, "extract", 0, 0);
    fs::create_dir_all(&root).map_err(|_| "OFFICE_EXTRACT_FAILED: 无法创建组件目录".to_string())?;
    // 行政解包：只展开文件，不注册、不改关联（TARGETDIR 指向受管目录）。
    let status = std::process::Command::new("msiexec.exe")
        .arg("/a").arg(&msi)
        .arg("/qn")
        .arg(format!("TARGETDIR={}", root.display()))
        .arg("/L*v").arg(cache.join("extract.log"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("OFFICE_EXTRACT_FAILED: 无法启动解包进程：{error}"))?;
    if !status.success() { return Err(format!("OFFICE_EXTRACT_FAILED: 解包进程返回 {}", status.code().unwrap_or(-1))); }
    let start = Instant::now();
    while !soffice_in(&root).is_file() {
        if cancel.load(Ordering::Acquire) { return Err("CANCELLED: 组件准备已取消".into()); }
        if start.elapsed() > EXTRACT_TIMEOUT { return Err("OFFICE_EXTRACT_FAILED: 解包超时".into()); }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = fs::remove_file(cache.join("extract.log"));
    progress(app, "done", 1, 1);
    Ok(root)
}

/// 前端「准备组件」入口：后台线程执行下载与解包，进度经事件回报。
#[tauri::command]
pub async fn kb_office_prepare(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        prepare_blocking(&handle, &cancel)
    }).await.map_err(|_| "OFFICE_INTERRUPTED: 组件准备被中断".to_string())?;
    match result {
        Ok(path) => Ok(serde_json::json!({ "installed": true, "dir": path.display().to_string(), "version": VERSION })),
        Err(error) => { failure(&app, &error); Err(error) }
    }
}
