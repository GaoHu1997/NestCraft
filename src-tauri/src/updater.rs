//! CR-046：右上角软件更新入口的后端实现。
//!
//! 流程：读取更新清单 → 按安装形态选择资产 → 下载并 SHA-256 校验 → 暂存 →
//! 免安装版换名替换，安装版启动已校验安装包。状态通过 `update-progress` 事件推送，
//! 前端同时以 `update_status` 轮询兜底。更新不写数据库，只用应用数据目录下的 `update/`。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// 当前版本号；与 tauri.conf.json / package.json 保持一致由发布流程保证。
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 默认更新清单：发布仓库最新正式版的固定资产名。可用环境变量或本机 feed.json 覆盖。
const DEFAULT_FEED: &str =
    "https://github.com/GaoHu1997/NestCraft/releases/latest/download/nestcraft-win64.json";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const CHUNK_SIZE: usize = 64 * 1024;
const CONNECT_TIMEOUT_SECS: u64 = 10;
const READ_TIMEOUT_SECS: u64 = 30;

/// 更新清单中的单个资产。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateAsset {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

/// 更新清单：同时描述安装版与免安装版资产，运行时只取匹配的一种。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateManifest {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: String,
    #[serde(default)]
    pub installer: Option<UpdateAsset>,
    #[serde(default)]
    pub portable: Option<UpdateAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateEnvironment {
    pub kind: String,
    pub current_version: String,
    pub exe_path: String,
    pub updatable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub update_available: bool,
    pub manifest: Option<UpdateManifest>,
    pub asset: Option<UpdateAsset>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub speed: u64,
    pub message: String,
    pub staged_file: Option<String>,
    pub kind: String,
    pub version: Option<String>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            done: 0,
            total: 0,
            speed: 0,
            message: String::new(),
            staged_file: None,
            kind: "unsupported".into(),
            version: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StagedMeta {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub kind: String,
}

static STATE: Mutex<Option<UpdateStatus>> = Mutex::new(None);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

fn set_state(status: UpdateStatus) {
    if let Ok(mut guard) = STATE.lock() {
        *guard = Some(status);
    }
}

fn publish(
    app: &tauri::AppHandle,
    phase: &str,
    done: u64,
    total: u64,
    speed: u64,
    message: &str,
    staged: Option<&Path>,
    version: Option<&str>,
    kind: &str,
) {
    let status = UpdateStatus {
        phase: phase.to_string(),
        done,
        total,
        speed,
        message: message.to_string(),
        staged_file: staged.map(|p| p.to_string_lossy().to_string()),
        kind: kind.to_string(),
        version: version.map(str::to_string),
    };
    set_state(status.clone());
    let _ = app.emit("update-progress", &status);
}

/// 更新目录：`<app_data>/update/`。
pub fn update_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;
    Ok(dir)
}

/// 按可执行文件同目录特征判定安装形态；开发环境在命令层直接视为不支持。
pub fn detect_kind(exe: &Path) -> &'static str {
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    if dir.join("portable.marker").is_file() {
        "portable"
    } else if dir.join("uninstall.exe").is_file() {
        "installed"
    } else {
        "unsupported"
    }
}

pub fn environment(_app: &tauri::AppHandle) -> Result<UpdateEnvironment, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序: {e}"))?;
    let kind = if cfg!(debug_assertions) {
        "unsupported".to_string()
    } else {
        detect_kind(&exe).to_string()
    };
    Ok(UpdateEnvironment {
        updatable: kind != "unsupported",
        kind,
        current_version: CURRENT_VERSION.to_string(),
        exe_path: exe.to_string_lossy().to_string(),
    })
}

fn trim_version(value: &str) -> &str {
    value
        .trim()
        .strip_prefix('v')
        .or_else(|| value.trim().strip_prefix('V'))
        .unwrap_or_else(|| value.trim())
}

fn split_prerelease(value: &str) -> (&str, &str) {
    match value.split_once('-') {
        Some((base, pre)) => (base, pre),
        None => (value, ""),
    }
}

fn numeric_segments(value: &str) -> Vec<u64> {
    value
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 语义化版本比较：数字段逐段比较，同号时正式版高于预发布版。
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    let (candidate_base, candidate_pre) = split_prerelease(trim_version(candidate));
    let (current_base, current_pre) = split_prerelease(trim_version(current));
    let mut candidate_parts = numeric_segments(candidate_base);
    let mut current_parts = numeric_segments(current_base);
    let length = candidate_parts.len().max(current_parts.len());
    candidate_parts.resize(length, 0);
    current_parts.resize(length, 0);
    if candidate_parts != current_parts {
        return candidate_parts > current_parts;
    }
    match (candidate_pre.is_empty(), current_pre.is_empty()) {
        (true, false) => true,
        (false, true) => false,
        (false, false) => candidate_pre > current_pre,
        (true, true) => false,
    }
}

pub fn is_http_url(value: &str) -> bool {
    let url = value.trim();
    (url.starts_with("https://") || url.starts_with("http://")) && url.len() > 8
}

pub fn is_sha256(value: &str) -> bool {
    let value = value.trim();
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 按当前形态取资产；缺失即视为该版本不适用于当前安装形态。
pub fn select_asset<'a>(manifest: &'a UpdateManifest, kind: &str) -> Option<&'a UpdateAsset> {
    match kind {
        "installed" => manifest.installer.as_ref(),
        "portable" => manifest.portable.as_ref(),
        _ => None,
    }
}

pub fn validate_asset(asset: &UpdateAsset) -> Result<(), String> {
    if !is_http_url(&asset.url) {
        return Err("更新资产缺少有效的 http(s) 下载地址".into());
    }
    if !is_sha256(&asset.sha256) {
        return Err("更新资产缺少有效的 SHA-256".into());
    }
    for mirror in &asset.mirrors {
        if !is_http_url(mirror) {
            return Err("更新资产包含无效的镜像地址".into());
        }
    }
    Ok(())
}

fn asset_urls(asset: &UpdateAsset) -> Vec<String> {
    let mut urls = Vec::new();
    for candidate in std::iter::once(&asset.url).chain(asset.mirrors.iter()) {
        let url = candidate.trim();
        if is_http_url(url) && !urls.iter().any(|existing| existing == url) {
            urls.push(url.to_string());
        }
    }
    urls
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(READ_TIMEOUT_SECS))
        .build()
}

fn feed_urls(app: &tauri::AppHandle) -> Vec<String> {
    if let Ok(configured) = std::env::var("NESTCRAFT_UPDATE_FEED") {
        let url = configured.trim();
        if is_http_url(url) {
            return vec![url.to_string()];
        }
    }
    if let Ok(dir) = update_dir(app) {
        if let Ok(text) = std::fs::read_to_string(dir.join("feed.json")) {
            let urls: Vec<String> = text
                .split(|c: char| c == ',' || c.is_whitespace())
                .map(str::trim)
                .filter(|value| is_http_url(value))
                .map(str::to_string)
                .collect();
            if !urls.is_empty() {
                return urls;
            }
        }
    }
    vec![DEFAULT_FEED.to_string()]
}

fn fetch_manifest_once(agent: &ureq::Agent, url: &str) -> Result<UpdateManifest, String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("清单请求失败: {e}"))?;
    let mut text = String::new();
    response
        .into_reader()
        .take(MAX_MANIFEST_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| format!("清单读取失败: {e}"))?;
    let manifest: UpdateManifest =
        serde_json::from_str(&text).map_err(|e| format!("清单解析失败: {e}"))?;
    if manifest.version.trim().is_empty() {
        return Err("清单缺少版本号".into());
    }
    Ok(manifest)
}

pub fn fetch_manifest(app: &tauri::AppHandle) -> Result<UpdateManifest, String> {
    let agent = http_agent();
    let mut errors = Vec::new();
    for url in feed_urls(app) {
        match fetch_manifest_once(&agent, &url) {
            Ok(manifest) => return Ok(manifest),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!("拉取更新清单失败：{}", errors.join("；")))
}

fn no_update(message: impl Into<String>) -> UpdateCheckResult {
    UpdateCheckResult {
        current_version: CURRENT_VERSION.to_string(),
        update_available: false,
        manifest: None,
        asset: None,
        message: message.into(),
    }
}

/// 检查更新；网络或清单失败返回错误由前端静默处理。
pub fn check(app: &tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let env = environment(app)?;
    if !env.updatable {
        return Ok(no_update("开发环境或无法判定安装形态，已跳过更新检查"));
    }
    let manifest = fetch_manifest(app)?;
    if !version_is_newer(&manifest.version, CURRENT_VERSION) {
        return Ok(no_update("当前已是最新版本"));
    }
    let asset = match select_asset(&manifest, &env.kind) {
        Some(asset) => asset.clone(),
        None => {
            return Ok(no_update(format!(
                "v{} 未提供当前安装形态（{}）的更新包",
                manifest.version, env.kind
            )))
        }
    };
    validate_asset(&asset)?;

    // 已暂存同版本同哈希的包时直接视为就绪，避免重复下载。
    if let Ok(dir) = update_dir(app) {
        let staged = dir.join("update-staged.exe");
        if staged.is_file() {
            if let Ok(meta) = read_staged(&dir) {
                if meta.version == manifest.version
                    && meta.sha256.eq_ignore_ascii_case(asset.sha256.trim())
                {
                    set_state(UpdateStatus {
                        phase: "ready".into(),
                        done: asset.size,
                        total: asset.size,
                        speed: 0,
                        message: "更新包已下载并通过校验".into(),
                        staged_file: Some(staged.to_string_lossy().to_string()),
                        kind: env.kind.clone(),
                        version: Some(manifest.version.clone()),
                    });
                }
            }
        }
    }

    Ok(UpdateCheckResult {
        current_version: CURRENT_VERSION.to_string(),
        update_available: true,
        manifest: Some(manifest),
        asset: Some(asset),
        message: String::new(),
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("读取更新包失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; CHUNK_SIZE];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("读取更新包失败: {e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

struct SpeedMeter {
    started: Instant,
    bytes: u64,
    speed: u64,
}

impl SpeedMeter {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            speed: 0,
        }
    }

    fn sample(&mut self, bytes: u64) -> u64 {
        self.bytes += bytes;
        let elapsed = self.started.elapsed();
        if elapsed >= Duration::from_secs(1) {
            self.speed = (self.bytes as f64 / elapsed.as_secs_f64()) as u64;
            self.bytes = 0;
            self.started = Instant::now();
        }
        self.speed
    }
}

fn download_once(
    app: &tauri::AppHandle,
    agent: &ureq::Agent,
    url: &str,
    part: &Path,
    total_hint: u64,
    version: &str,
    kind: &str,
) -> Result<u64, String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("下载请求失败: {e}"))?;
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| format!("创建下载文件失败: {e}"))?;
    let mut done: u64 = 0;
    let mut meter = SpeedMeter::new();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buffer = [0u8; CHUNK_SIZE];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|e| format!("读取更新包失败: {e}"))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])
            .map_err(|e| format!("写入更新包失败: {e}"))?;
        done += count as u64;
        let speed = meter.sample(count as u64);
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let total = if total_hint > 0 { total_hint } else { done };
            publish(
                app,
                "downloading",
                done,
                total,
                speed,
                "正在下载更新",
                None,
                Some(version),
                kind,
            );
        }
    }
    file.flush().map_err(|e| format!("写入更新包失败: {e}"))?;
    Ok(done)
}

fn read_staged(dir: &Path) -> Result<StagedMeta, String> {
    let text = std::fs::read_to_string(dir.join("staged.json"))
        .map_err(|e| format!("读取更新状态失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析更新状态失败: {e}"))
}

fn write_staged(dir: &Path, meta: &StagedMeta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("staged.json"), text).map_err(|e| format!("保存更新状态失败: {e}"))
}

/// 下载更新包并校验；成功后写入暂存文件与 staged.json。
pub fn download(
    app: &tauri::AppHandle,
    expected_version: Option<String>,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("已有下载任务进行中".into());
    }
    let result = download_inner(app, expected_version, expected_sha256);
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

fn download_inner(
    app: &tauri::AppHandle,
    expected_version: Option<String>,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let env = environment(app)?;
    if !env.updatable {
        return Err("当前安装形态不支持应用内更新".into());
    }
    let manifest = fetch_manifest(app)?;
    if let Some(expected) = expected_version.as_deref() {
        if trim_version(expected) != trim_version(&manifest.version) {
            return Err("更新版本已变化，请重新检查更新".into());
        }
    }
    let asset = select_asset(&manifest, &env.kind)
        .cloned()
        .ok_or_else(|| format!("该版本未提供当前安装形态（{}）的更新包", env.kind))?;
    validate_asset(&asset)?;
    if let Some(expected) = expected_sha256.as_deref() {
        if !expected.trim().eq_ignore_ascii_case(asset.sha256.trim()) {
            return Err("更新包已变化（SHA-256 不一致），请重新检查更新".into());
        }
    }

    let dir = update_dir(app)?;
    let part = dir.join("update.part");
    let staged = dir.join("update-staged.exe");
    let urls = asset_urls(&asset);
    if urls.is_empty() {
        return Err("更新清单未提供有效下载地址".into());
    }

    let agent = http_agent();
    publish(
        app,
        "downloading",
        0,
        asset.size,
        0,
        "开始下载更新",
        None,
        Some(&manifest.version),
        &env.kind,
    );
    let mut last_error = String::new();
    for url in &urls {
        match download_once(
            app,
            &agent,
            url,
            &part,
            asset.size,
            &manifest.version,
            &env.kind,
        ) {
            Ok(done) => {
                publish(
                    app,
                    "verifying",
                    done,
                    asset.size.max(done),
                    0,
                    "正在校验更新包",
                    None,
                    Some(&manifest.version),
                    &env.kind,
                );
                if asset.size > 0 && done != asset.size {
                    let message = format!(
                        "更新包大小不匹配（期望 {} 字节，实际 {} 字节）",
                        asset.size, done
                    );
                    let _ = std::fs::remove_file(&part);
                    last_error = message;
                    continue;
                }
                let actual = sha256_file(&part)?;
                if !actual.eq_ignore_ascii_case(asset.sha256.trim()) {
                    let _ = std::fs::remove_file(&part);
                    last_error = "更新包 SHA-256 校验失败，已删除损坏文件".into();
                    continue;
                }
                if staged.exists() {
                    let _ = std::fs::remove_file(&staged);
                }
                std::fs::rename(&part, &staged).map_err(|e| format!("暂存更新包失败: {e}"))?;
                write_staged(
                    &dir,
                    &StagedMeta {
                        version: manifest.version.clone(),
                        sha256: asset.sha256.trim().to_ascii_lowercase(),
                        kind: env.kind.clone(),
                    },
                )?;
                publish(
                    app,
                    "ready",
                    done,
                    asset.size.max(done),
                    0,
                    "更新已下载并通过校验，重启后安装",
                    Some(&staged),
                    Some(&manifest.version),
                    &env.kind,
                );
                return Ok(staged.to_string_lossy().to_string());
            }
            Err(error) => {
                last_error = error;
                let _ = std::fs::remove_file(&part);
            }
        }
    }

    publish(
        app,
        "idle",
        0,
        0,
        0,
        &format!("下载更新失败：{last_error}"),
        None,
        Some(&manifest.version),
        &env.kind,
    );
    Err(format!("下载更新失败：{last_error}"))
}

/// 当前状态；重启后从 staged.json 恢复「就绪」。
pub fn status(app: &tauri::AppHandle) -> UpdateStatus {
    let kind = environment(app)
        .map(|env| env.kind)
        .unwrap_or_else(|_| "unsupported".into());
    let mut current = STATE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default();
    current.kind = kind.clone();
    if current.phase != "downloading" && current.phase != "applying" {
        if let Ok(dir) = update_dir(app) {
            let staged = dir.join("update-staged.exe");
            if staged.is_file() {
                if let Ok(meta) = read_staged(&dir) {
                    if meta.kind == kind {
                        current.phase = "ready".into();
                        current.staged_file = Some(staged.to_string_lossy().to_string());
                        current.version = Some(meta.version);
                        current.message = "更新已下载并通过校验，重启后安装".into();
                    }
                }
            }
        }
    }
    current
}

fn aside_path(exe: &Path) -> PathBuf {
    let mut path = exe.with_extension("exe.old");
    let mut index = 2;
    while path.exists() {
        if index > 9 {
            path = exe.with_extension(format!("exe.old-{}", std::process::id()));
            break;
        }
        path = exe.with_extension(format!("exe.old-{index}"));
        index += 1;
    }
    path
}

fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let waits = [100u64, 200, 400, 800, 1500];
    for wait in waits {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) => std::thread::sleep(Duration::from_millis(wait)),
        }
    }
    std::fs::rename(from, to)
}

#[cfg(windows)]
fn spawn_detached(exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    std::process::Command::new(exe)
        .env("NESTCRAFT_UPDATED", "1")
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动新版本失败: {e}"))
}

#[cfg(not(windows))]
fn spawn_detached(exe: &Path) -> Result<(), String> {
    std::process::Command::new(exe)
        .env("NESTCRAFT_UPDATED", "1")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动新版本失败: {e}"))
}

fn portable_apply(app: &tauri::AppHandle, staged: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序: {e}"))?;
    let old = aside_path(&exe);
    rename_with_retry(&exe, &old)
        .map_err(|e| format!("旧版程序改名失败（可能被杀毒软件占用）: {e}"))?;
    if let Err(error) = std::fs::rename(staged, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("新版程序落位失败，已回滚: {error}"));
    }
    spawn_detached(&exe)?;
    app.exit(0);
    Ok(())
}

fn installer_apply(app: &tauri::AppHandle, staged: &Path) -> Result<(), String> {
    std::process::Command::new(staged)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("安装器启动失败: {e}"))?;
    app.exit(0);
    Ok(())
}

/// 安装更新：先重校验暂存包，再按形态落位；失败保留旧版本与暂存包。
pub fn apply(app: &tauri::AppHandle, expected_sha256: Option<String>) -> Result<(), String> {
    let env = environment(app)?;
    if !env.updatable {
        return Err("当前安装形态不支持应用内更新".into());
    }
    let dir = update_dir(app)?;
    let staged = dir.join("update-staged.exe");
    if !staged.is_file() {
        return Err("没有已下载的更新包，请先下载更新".into());
    }
    let meta = read_staged(&dir)?;
    let expected = expected_sha256
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| meta.sha256.clone());
    if !is_sha256(&expected) {
        return Err("更新包校验信息缺失，请重新下载更新".into());
    }
    if !meta.kind.is_empty() && meta.kind != env.kind {
        return Err("更新包与当前安装形态不匹配，请重新检查更新".into());
    }
    let actual = sha256_file(&staged)?;
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        let _ = std::fs::remove_file(&staged);
        let _ = std::fs::remove_file(dir.join("staged.json"));
        return Err("待安装更新包 SHA-256 不匹配，已取消安装，请重新下载".into());
    }

    publish(
        app,
        "applying",
        0,
        0,
        0,
        "正在重启并安装更新",
        Some(&staged),
        Some(&meta.version),
        &env.kind,
    );

    let result = match env.kind.as_str() {
        "portable" => portable_apply(app, &staged),
        "installed" => installer_apply(app, &staged),
        _ => Err("当前安装形态不支持应用内更新".into()),
    };
    if let Err(error) = &result {
        publish(
            app,
            "ready",
            0,
            0,
            0,
            error,
            Some(&staged),
            Some(&meta.version),
            &env.kind,
        );
    }
    result
}

/// 启动清理：删除上次替换留下的旧版程序与未完成下载；保留已就绪的暂存包。
pub fn cleanup(app: &tauri::AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let stem = exe
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            if !stem.is_empty() {
                for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with(&format!("{stem}.old")) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
    if let Ok(dir) = update_dir(app) {
        let _ = std::fs::remove_file(dir.join("update.part"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_is_semantic() {
        assert!(version_is_newer("0.2.0", "0.1.0"));
        assert!(version_is_newer("v1.0.0", "0.9.9"));
        assert!(!version_is_newer("0.1.0", "0.1.0"));
        assert!(!version_is_newer("0.1.0", "0.2.0"));
        assert!(version_is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!version_is_newer("1.0.0-rc.1", "1.0.0"));
        assert!(!version_is_newer("0.2", "0.2.0"));
    }

    #[test]
    fn asset_selection_matches_install_kind() {
        let manifest = UpdateManifest {
            version: "0.2.0".into(),
            installer: Some(UpdateAsset {
                url: "https://example.com/setup.exe".into(),
                sha256: "a".repeat(64),
                size: 10,
                ..Default::default()
            }),
            portable: Some(UpdateAsset {
                url: "https://example.com/portable.exe".into(),
                sha256: "b".repeat(64),
                size: 11,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            select_asset(&manifest, "installed").map(|a| a.size),
            Some(10)
        );
        assert_eq!(
            select_asset(&manifest, "portable").map(|a| a.size),
            Some(11)
        );
        assert!(select_asset(&manifest, "unsupported").is_none());
    }

    #[test]
    fn asset_validation_rejects_bad_url_and_hash() {
        let mut asset = UpdateAsset {
            url: "https://example.com/a.exe".into(),
            sha256: "c".repeat(64),
            ..Default::default()
        };
        assert!(validate_asset(&asset).is_ok());
        asset.url = "file:///tmp/a.exe".into();
        assert!(validate_asset(&asset).is_err());
        asset.url = "https://example.com/a.exe".into();
        asset.sha256 = "xyz".into();
        assert!(validate_asset(&asset).is_err());
        asset.sha256 = "c".repeat(64);
        asset.mirrors = vec!["ftp://example.com/a.exe".into()];
        assert!(validate_asset(&asset).is_err());
    }

    #[test]
    fn manifest_parses_both_assets() {
        let text = r#"{
            "version": "0.2.0",
            "pub_date": "2026-11-21",
            "installer": {"url": "https://example.com/setup.exe", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 1},
            "portable": {"url": "https://example.com/portable.exe", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "size": 2, "mirrors": ["https://mirror.example/portable.exe"]}
        }"#;
        let manifest: UpdateManifest = serde_json::from_str(text).expect("manifest");
        assert_eq!(manifest.version, "0.2.0");
        assert_eq!(manifest.installer.as_ref().map(|a| a.size), Some(1));
        assert_eq!(
            manifest.portable.as_ref().map(|a| a.mirrors.len()),
            Some(1)
        );
    }

    #[test]
    fn detect_kind_prefers_portable_marker() {
        let root = std::env::temp_dir().join(format!("nestcraft-update-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let exe = root.join("NestCraft.exe");
        assert_eq!(detect_kind(&exe), "unsupported");
        std::fs::write(root.join("uninstall.exe"), b"x").expect("uninstall");
        assert_eq!(detect_kind(&exe), "installed");
        std::fs::write(root.join("portable.marker"), b"portable").expect("marker");
        assert_eq!(detect_kind(&exe), "portable");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sha256_file_matches_known_digest() {
        let path = std::env::temp_dir().join(format!("nestcraft-sha-test-{}.bin", std::process::id()));
        std::fs::write(&path, b"abc").expect("write");
        let digest = sha256_file(&path).expect("digest");
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&path);
    }
}
