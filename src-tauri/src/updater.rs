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

/// GitHub 加速镜像（前缀拼接式：`{加速器}{原始 GitHub 地址}`）。
///
/// 直连 GitHub Release 在部分网络下会卡在 `release-assets.githubusercontent.com` 的
/// 连接重置上（表现为「拉取更新清单失败」），因此清单与安装包的 GitHub 直链都按
/// 「直连 → 本列表顺序」逐级尝试，任一成功即用。
///
/// 顺序只影响首选速度、不影响正确性：靠前的源失败会自动切下一个。靠前的为实测
/// 可用的通用代理，靠后的保留作兜底（各代理可用性会随网络与时间波动，出现限流
/// 429/403 时仍是下一轮的有效候选）。安装包始终以清单中的 SHA-256 完整校验，
/// 镜像只承担传输。
const GITHUB_ACCELERATORS: &[&str] = &[
    "https://hub.ddayh.com/",
    "https://kenyu.ggff.net/",
    "https://github-proxy.lixxing.top/",
    "https://github.dpik.top/",
    "https://ghpxy.hwinzniej.top/",
    "https://gh.ddlc.top/",
    "https://gh.aaa.team/",
    "https://y.whereisdoge.work/",
    "https://gh-proxy.com/",
    "https://git.tangbao.cc/",
];

/// 需要按加速器展开的 GitHub 域名片段（Release 资产、raw 与对象存储重定向域）。
const GITHUB_HOSTS: &[&str] = &[
    "://github.com/",
    "://raw.githubusercontent.com/",
    "://objects.githubusercontent.com/",
    "://release-assets.githubusercontent.com/",
    "://codeload.github.com/",
];

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const CHUNK_SIZE: usize = 64 * 1024;
const CONNECT_TIMEOUT_SECS: u64 = 10;
const READ_TIMEOUT_SECS: u64 = 30;
/// 清单候选的连接超时：连不上要尽快切下一个源，不能干等。
const MANIFEST_CONNECT_TIMEOUT_SECS: u64 = 6;
/// 清单候选的单次读取超时（清单本身只有几百字节）。
const MANIFEST_READ_TIMEOUT_SECS: u64 = 12;
/// 清单拉取的总等待上限：超过后放弃剩余候选并报错，避免用户长时间空等。
const MANIFEST_TOTAL_BUDGET_SECS: u64 = 45;
/// 单个下载源的总时限：再慢的可用源也不能无限占住更新流程，超时即丢弃半包切下一源。
const DOWNLOAD_SOURCE_TIMEOUT_SECS: u64 = 600;
/// 启动阶段的慢源判定窗口与最低字节数：窗口内连 512 KiB 都收不到（约 <17KB/s），
/// 视为该源不可用，立即切源；避免镜像里的极慢源让用户长时间停在 0% 附近。
const DOWNLOAD_STARTUP_WINDOW_SECS: u64 = 30;
const DOWNLOAD_STARTUP_MIN_BYTES: u64 = 512 * 1024;
/// 错误消息里保留的源错误条数上限，避免把 10 多个源的失败串塞满界面提示。
const MANIFEST_ERROR_KEEP: usize = 3;

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

/// 更新暂存目录；免安装版必须与 exe 同卷，见 [`staging_dir`]。
pub fn update_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序: {e}"))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    let portable = detect_kind(&exe) == "portable";
    let dir = staging_dir(&exe, &app_data);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return Err(if portable {
            format!(
                "无法在程序所在目录创建更新暂存目录 {}：{error}（免安装版要求程序所在目录可写，请移动到用户目录等可写位置后重试）",
                dir.display()
            )
        } else {
            format!("创建更新目录失败: {error}")
        });
    }
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

/// 暂存目录按形态分化，关键是让免安装版的暂存包与 exe 处在同一个卷：
/// Windows 的 `MoveFile` 不能跨卷，`<app_data>/update/` 位于系统盘、程序在别的盘时，
/// 落位必然以 `os error 17`（ERROR_NOT_SAME_DEVICE）失败并回滚。
/// 因此免安装版把暂存包放在程序目录下的 `.update/`，落位就是同卷改名；
/// 安装版只负责启动已校验的安装包，不存在文件移动，仍用应用数据目录。
fn staging_dir(exe: &Path, app_data: &Path) -> PathBuf {
    if detect_kind(exe) == "portable" {
        exe.parent()
            .unwrap_or_else(|| Path::new("."))
            .join(".update")
    } else {
        app_data.join("update")
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

/// 追加一个 HTTP(S) 候选，去重并过滤空白/非法项。
fn push_unique(urls: &mut Vec<String>, candidate: &str) {
    let url = candidate.trim();
    if is_http_url(url) && !urls.iter().any(|existing| existing == url) {
        urls.push(url.to_string());
    }
}

/// 把一个原始 GitHub / raw 地址展开为「直连 + 各加速器」候选列表。
pub fn accelerated_urls(original: &str) -> Vec<String> {
    let original = original.trim();
    let mut urls = Vec::with_capacity(GITHUB_ACCELERATORS.len() + 1);
    if !is_http_url(original) {
        return urls;
    }
    urls.push(original.to_string());
    for accelerator in GITHUB_ACCELERATORS {
        urls.push(format!("{accelerator}{original}"));
    }
    urls
}

fn is_github_url(url: &str) -> bool {
    let url = url.trim();
    GITHUB_HOSTS.iter().any(|host| url.contains(host))
}

/// GitHub 直链展开为「直连 + 各加速器」；其他地址原样返回。
/// 加速器只负责传输，安装包仍以清单里的 SHA-256 完整校验兜底。
fn expand_github_download(url: &str) -> Vec<String> {
    if is_github_url(url) {
        accelerated_urls(url)
    } else if is_http_url(url) {
        vec![url.trim().to_string()]
    } else {
        Vec::new()
    }
}

/// 默认清单候选：直连优先（可信），失败后逐个用加速器代理同一份清单。
fn default_feed_urls() -> Vec<String> {
    accelerated_urls(DEFAULT_FEED)
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

/// 下载候选：主地址优先（GitHub 直链自动展开为「直连 + 各加速器」），
/// 其次清单显式声明的镜像；去重、过滤非 http(s) 与空白项。
fn asset_urls(asset: &UpdateAsset) -> Vec<String> {
    let mut urls = Vec::new();
    for candidate in expand_github_download(&asset.url) {
        push_unique(&mut urls, &candidate);
    }
    for mirror in &asset.mirrors {
        push_unique(&mut urls, mirror);
    }
    urls
}

/// 代理：优先专用变量 `NESTCRAFT_UPDATE_PROXY`，其次通用代理环境变量，
/// 取不到时交给 ureq 读取环境变量（`try_proxy_from_env`）。都取不到即直连。
fn proxy_from_env() -> Option<ureq::Proxy> {
    const KEYS: &[&str] = &[
        "NESTCRAFT_UPDATE_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ];
    for key in KEYS {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                if let Ok(proxy) = ureq::Proxy::new(value) {
                    return Some(proxy);
                }
            }
        }
    }
    None
}

fn user_agent() -> String {
    format!("NestCraft/{}", CURRENT_VERSION)
}

fn agent_builder() -> ureq::AgentBuilder {
    let builder = ureq::AgentBuilder::new().user_agent(&user_agent());
    match proxy_from_env() {
        Some(proxy) => builder.proxy(proxy),
        None => builder.try_proxy_from_env(true),
    }
}

fn http_agent() -> ureq::Agent {
    agent_builder()
        .timeout_connect(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(READ_TIMEOUT_SECS))
        .build()
}

/// 清单探测专用：连接超时更短，失败要尽快切到下一个候选源。
fn manifest_agent() -> ureq::Agent {
    agent_builder()
        .timeout_connect(Duration::from_secs(MANIFEST_CONNECT_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(MANIFEST_READ_TIMEOUT_SECS))
        .build()
}

/// 清单候选：环境变量与本地 `feed.json` 视为强制指定（只用它们），
/// 未覆盖时用「直连 + 各 GitHub 加速器」的内置候选。
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
    default_feed_urls()
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

/// 逐个候选源拉取清单：直连优先，失败按加速器顺序切换；超过总预算即停止。
pub fn fetch_manifest(app: &tauri::AppHandle) -> Result<UpdateManifest, String> {
    fetch_manifest_from(&manifest_agent(), feed_urls(app))
}

fn fetch_manifest_from(
    agent: &ureq::Agent,
    candidates: Vec<String>,
) -> Result<UpdateManifest, String> {
    let started = Instant::now();
    let total = candidates.len();
    let mut errors: Vec<String> = Vec::new();
    let mut tried = 0usize;
    for (index, url) in candidates.iter().enumerate() {
        if index > 0 && started.elapsed() >= Duration::from_secs(MANIFEST_TOTAL_BUDGET_SECS) {
            errors.push(format!(
                "已放弃剩余 {} 个候选源（总等待超过 {} 秒）",
                total - index,
                MANIFEST_TOTAL_BUDGET_SECS
            ));
            break;
        }
        tried += 1;
        match fetch_manifest_once(agent, url) {
            Ok(manifest) => return Ok(manifest),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "拉取更新清单失败（已尝试 {tried} 个源，含直连与加速镜像）：{}",
        summarize_errors(&errors)
    ))
}

/// 错误摘要：只保留前若干条并标注省略条数，避免界面提示被十几个源的失败串撑满。
fn summarize_errors(errors: &[String]) -> String {
    if errors.is_empty() {
        return "没有可用的清单地址".into();
    }
    if errors.len() <= MANIFEST_ERROR_KEEP {
        return errors.join("；");
    }
    let head = errors
        .iter()
        .take(MANIFEST_ERROR_KEEP)
        .cloned()
        .collect::<Vec<_>>()
        .join("；");
    format!("{head}；…另有 {} 个源失败", errors.len() - MANIFEST_ERROR_KEEP)
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

/// 单源是否应放弃：返回放弃原因。纯函数，便于单测。
fn source_give_up(done: u64, elapsed: Duration) -> Option<String> {
    if elapsed >= Duration::from_secs(DOWNLOAD_SOURCE_TIMEOUT_SECS) {
        return Some(format!(
            "该下载源超过 {} 秒仍未完成（已接收 {} 字节），改用下一个源",
            DOWNLOAD_SOURCE_TIMEOUT_SECS, done
        ));
    }
    if done < DOWNLOAD_STARTUP_MIN_BYTES
        && elapsed >= Duration::from_secs(DOWNLOAD_STARTUP_WINDOW_SECS)
    {
        return Some(format!(
            "该下载源过慢（{} 秒仅收到 {} 字节），改用下一个源",
            DOWNLOAD_STARTUP_WINDOW_SECS, done
        ));
    }
    None
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
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buffer = [0u8; CHUNK_SIZE];
    loop {
        if let Some(reason) = source_give_up(done, started.elapsed()) {
            return Err(reason);
        }
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

/// 把已校验的暂存包换名落位到 exe；失败把旧版改回原名。
/// 暂存目录与 exe 同卷（见 [`staging_dir`]），这里的改名不会跨卷。
fn replace_executable(exe: &Path, staged: &Path) -> Result<(), String> {
    let old = aside_path(exe);
    rename_with_retry(exe, &old)
        .map_err(|e| format!("旧版程序改名失败（可能被杀毒软件占用）: {e}"))?;
    if let Err(error) = std::fs::rename(staged, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("新版程序落位失败，已回滚: {error}"));
    }
    Ok(())
}

fn portable_apply(app: &tauri::AppHandle, staged: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序: {e}"))?;
    replace_executable(&exe, staged)?;
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

/// 旧版备份文件名判定：`<exe>.old`、`<exe>.old-2`…`<exe>.old-9`、`<exe>.old-<pid>`。
///
/// 注意不能用 `file_stem`（`NestCraft`）拼前缀：备份实际叫 `NestCraft.exe.old`，
/// 用 `NestCraft.old` 去比永远不命中，替换一次就永久残留一份旧程序。
fn is_old_backup(candidate: &str, exe_name: &str) -> bool {
    let prefix = format!("{exe_name}.old");
    candidate == prefix
        || candidate
            .strip_prefix(&prefix)
            .is_some_and(|rest| rest.starts_with('-'))
}

/// 启动清理：删除上次替换留下的旧版程序、未完成下载与过期暂存状态。
///
/// 旧版备份名是 `<exe>.old`（例如 `NestCraft.exe.old`、`NestCraft.exe.old-2`、
/// `NestCraft.exe.old-<pid>`），必须按完整文件名匹配；早先按 `file_stem` 拼出
/// `NestCraft.old` 前缀，永远匹配不到，替换一次就永久残留一份几十 MB 的旧程序。
pub fn cleanup(app: &tauri::AppHandle) {
    let Some(exe) = std::env::current_exe().ok() else {
        return;
    };
    if let Some(dir) = exe.parent() {
        if let Some(name) = exe.file_name().map(|value| value.to_string_lossy().to_string()) {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let candidate = entry.file_name().to_string_lossy().to_string();
                if is_old_backup(&candidate, &name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    let app_data = app.path().app_data_dir().ok();
    let staging = app_data.as_deref().map(|data| staging_dir(&exe, data));
    if let Some(dir) = &staging {
        let _ = std::fs::remove_file(dir.join("update.part"));
        // 暂存包已落位（改名走掉）时，staged.json 不再有意义，避免“幽灵就绪”。
        if !dir.join("update-staged.exe").is_file() {
            let _ = std::fs::remove_file(dir.join("staged.json"));
        }
    }
    // 旧版本把暂存包放在应用数据目录；暂存位置改到程序目录后清掉遗留，避免白占空间。
    if let Some(data) = app_data {
        let legacy = data.join("update");
        if staging.as_deref() != Some(legacy.as_path()) {
            let _ = std::fs::remove_file(legacy.join("update.part"));
            let _ = std::fs::remove_file(legacy.join("update-staged.exe"));
            let _ = std::fs::remove_file(legacy.join("staged.json"));
            let _ = std::fs::remove_dir(&legacy);
        }
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
    fn portable_staging_dir_is_next_to_exe_so_placement_stays_on_one_volume() {
        let root = std::env::temp_dir().join(format!("nestcraft-staging-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let exe = root.join("NestCraft.exe");
        let app_data = root.join("appdata");
        // 非免安装版沿用应用数据目录（安装包只被启动，不参与文件移动）。
        assert_eq!(staging_dir(&exe, &app_data), app_data.join("update"));
        std::fs::write(root.join("portable.marker"), b"portable").expect("marker");
        // 免安装版暂存包必须与 exe 同目录：落位是同卷改名，不再触发 os error 17。
        assert_eq!(staging_dir(&exe, &app_data), root.join(".update"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_executable_swaps_new_build_and_leaves_cleanable_backup() {
        let root = std::env::temp_dir().join(format!("nestcraft-replace-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".update")).expect("staging dir");
        let exe = root.join("NestCraft.exe");
        let staged = root.join(".update").join("update-staged.exe");
        std::fs::write(&exe, b"old-build").expect("old exe");
        std::fs::write(&staged, b"new-build").expect("staged");
        replace_executable(&exe, &staged).expect("同卷落位应成功");
        assert_eq!(std::fs::read(&exe).expect("read exe"), b"new-build".to_vec());
        assert!(!staged.exists(), "暂存包应已改名走掉");
        let backup = root.join("NestCraft.exe.old");
        assert_eq!(std::fs::read(&backup).expect("backup"), b"old-build".to_vec());
        assert!(is_old_backup("NestCraft.exe.old", "NestCraft.exe"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_update_flow_places_new_build_and_cleanup_removes_old_copy() {
        // 模拟「程序在非系统盘」：暂存目录跟着程序走，落位是同卷改名，清理能删掉旧备份。
        let root = std::env::temp_dir().join(format!("nestcraft-flow-test-{}", std::process::id()));
        let app_data = std::env::temp_dir().join(format!("nestcraft-flow-appdata-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
        std::fs::create_dir_all(&root).expect("temp dir");
        std::fs::write(root.join("portable.marker"), b"portable").expect("marker");
        let exe = root.join("NestCraft.exe");
        std::fs::write(&exe, b"v0.0.4").expect("old exe");
        let staging = staging_dir(&exe, &app_data);
        assert_eq!(staging, root.join(".update"));
        std::fs::create_dir_all(&staging).expect("staging dir");
        let staged = staging.join("update-staged.exe");
        std::fs::write(&staged, b"v0.0.5").expect("staged");

        replace_executable(&exe, &staged).expect("同卷落位应成功");
        assert_eq!(std::fs::read(&exe).expect("read exe"), b"v0.0.5".to_vec());
        assert!(!staged.exists(), "暂存包落位后不应残留");

        // 新版本启动清理：旧备份被删除，新程序不受影响。
        let backup = root.join("NestCraft.exe.old");
        assert!(backup.is_file(), "落位应留下旧版备份");
        for entry in std::fs::read_dir(&root).expect("read dir").flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_old_backup(&name, "NestCraft.exe") {
                std::fs::remove_file(entry.path()).expect("cleanup backup");
            }
        }
        assert!(!backup.exists(), "清理必须能删掉 <exe>.old");
        assert!(exe.is_file(), "清理不得误删当前程序");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn old_backup_matching_uses_full_executable_name() {
        assert!(is_old_backup("NestCraft.exe.old", "NestCraft.exe"));
        assert!(is_old_backup("NestCraft.exe.old-2", "NestCraft.exe"));
        assert!(is_old_backup("NestCraft.exe.old-4096", "NestCraft.exe"));
        assert!(!is_old_backup("NestCraft.exe", "NestCraft.exe"));
        // 旧实现用 file_stem 拼出 `NestCraft.old`，这一条正是它漏删的形态。
        assert!(!is_old_backup("NestCraft.old", "NestCraft.exe"));
        assert!(!is_old_backup("NestCraft.exe.old2", "NestCraft.exe"));
        assert!(!is_old_backup("NestCraft.exe.bak", "NestCraft.exe"));
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

    #[test]
    fn default_feed_candidates_start_with_direct_then_every_accelerator() {
        let urls = default_feed_urls();
        assert_eq!(urls[0], DEFAULT_FEED, "直连必须排在首位");
        assert_eq!(urls.len(), GITHUB_ACCELERATORS.len() + 1);
        for accelerator in GITHUB_ACCELERATORS {
            assert!(
                urls.contains(&format!("{accelerator}{DEFAULT_FEED}")),
                "缺少加速候选 {accelerator}"
            );
        }
    }

    #[test]
    fn accelerator_expansion_only_applies_to_github_urls() {
        let github = "https://github.com/GaoHu1997/NestCraft/releases/download/v0.0.2/NestCraft_0.0.2_x64_portable.exe";
        let expanded = expand_github_download(github);
        assert_eq!(expanded[0], github);
        assert_eq!(expanded.len(), GITHUB_ACCELERATORS.len() + 1);

        let cdn = "https://cdn.example.com/NestCraft_0.0.2_x64_portable.exe";
        assert_eq!(expand_github_download(cdn), vec![cdn.to_string()]);
        assert!(expand_github_download("file:///tmp/a.exe").is_empty());
        assert!(accelerated_urls("not a url").is_empty());
    }

    #[test]
    fn asset_candidates_expand_primary_and_keep_mirrors_once() {
        let asset = UpdateAsset {
            url: "https://github.com/GaoHu1997/NestCraft/releases/download/v0.0.2/app.exe".into(),
            mirrors: vec![
                "https://github.com/GaoHu1997/NestCraft/releases/download/v0.0.2/app.exe".into(),
                "https://mirror.example.com/app.exe".into(),
                "  ".into(),
            ],
            sha256: "a".repeat(64),
            size: 10,
        };
        let urls = asset_urls(&asset);
        // 直连 + 各加速器，镜像只留一条且排在最后，空白项被过滤。
        assert_eq!(urls.len(), GITHUB_ACCELERATORS.len() + 2);
        assert_eq!(urls.last().map(String::as_str), Some("https://mirror.example.com/app.exe"));
        assert!(!urls.iter().any(|value| value.trim().is_empty()));
        // 主地址与镜像重复时不会出现第二次直连。
        assert_eq!(
            urls.iter().filter(|value| *value == &asset.url).count(),
            1
        );
    }

    #[test]
    fn slow_download_source_is_dropped_but_progressing_source_is_kept() {
        // 正常下载：30 秒内已有 600 KiB，继续。
        assert!(source_give_up(600 * 1024, Duration::from_secs(31)).is_none());
        // 极慢源：30 秒内只有 300 KiB，立即放弃。
        let stalled = source_give_up(300 * 1024, Duration::from_secs(31));
        assert!(stalled.is_some_and(|reason| reason.contains("过慢")));
        // 刚开始：不判定。
        assert!(source_give_up(0, Duration::from_secs(5)).is_none());
        // 大文件已经下了很久：总时限兜底，即使速度不慢也放弃。
        let overtime = source_give_up(8 * 1024 * 1024, Duration::from_secs(700));
        assert!(overtime.is_some_and(|reason| reason.contains("超过")));
    }

    #[test]
    fn manifest_error_summary_is_capped() {
        let errors: Vec<String> = (0..6).map(|index| format!("源 {index} 失败")).collect();
        let summary = summarize_errors(&errors);
        assert!(summary.contains("源 0 失败"));
        assert!(summary.contains("另有 3 个源失败"));
        assert!(!summary.contains("源 5 失败"));
        assert_eq!(summarize_errors(&[]), "没有可用的清单地址");
    }

    /// 需要外网的实网验证：默认候选（直连 + 各加速器）必须能拉到一份可解析的清单。
    /// 设置 `NESTCRAFT_UPDATE_FEED` 可只验证指定源（如某个加速器地址）。
    /// 手动执行：`cargo test --lib manifest_fetch -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn manifest_fetch_reaches_published_release() {
        let candidates = match std::env::var("NESTCRAFT_UPDATE_FEED") {
            Ok(value) if is_http_url(value.trim()) => vec![value.trim().to_string()],
            _ => default_feed_urls(),
        };
        let manifest = fetch_manifest_from(&manifest_agent(), candidates)
            .unwrap_or_else(|error| panic!("所有清单候选均失败：{error}"));
        println!("清单版本：v{}", manifest.version);
        assert!(!manifest.version.trim().is_empty());
    }

    /// 实网验证回退路径：首位源不可达时，必须自动切到加速器并成功返回清单。
    #[test]
    #[ignore]
    fn manifest_fetch_skips_unreachable_source_and_falls_back_to_accelerator() {
        let candidates = vec![
            "https://127.0.0.1:9/nestcraft-win64.json".to_string(),
            format!("{}https://github.com/GaoHu1997/NestCraft/releases/latest/download/nestcraft-win64.json", GITHUB_ACCELERATORS[0]),
        ];
        let manifest = fetch_manifest_from(&manifest_agent(), candidates)
            .unwrap_or_else(|error| panic!("回退失败：{error}"));
        println!(
            "回退命中：{} → v{}",
            GITHUB_ACCELERATORS[0], manifest.version
        );
        assert!(!manifest.version.trim().is_empty());
    }

    /// 实网验证完整下载路径：按 `asset_urls` 候选（直连 + 加速器）取回安装包，
    /// 整包 SHA-256 必须与清单一致——镜像只承担传输，不能影响内容校验。
    #[test]
    #[ignore]
    fn accelerated_download_matches_manifest_sha256() {
        let manifest = fetch_manifest_from(&manifest_agent(), default_feed_urls())
            .unwrap_or_else(|error| panic!("清单失败：{error}"));
        let asset = manifest.portable.as_ref().expect("清单应包含免安装资产");
        let expected = asset.sha256.trim().to_ascii_lowercase();
        assert!(is_sha256(&expected), "清单缺少有效 SHA-256");
        let agent = http_agent();
        let mut last = String::new();
        for url in asset_urls(asset) {
            let started = Instant::now();
            let response = match agent.get(&url).call() {
                Ok(response) => response,
                Err(error) => {
                    last = format!("{url}: {error}");
                    continue;
                }
            };
            let mut reader = response.into_reader();
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; CHUNK_SIZE];
            let mut total: u64 = 0;
            let mut read_error = None;
            loop {
                if started.elapsed() >= Duration::from_secs(240) {
                    read_error = Some("超过 240 秒仍没下完".to_string());
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        hasher.update(&buffer[..count]);
                        total += count as u64;
                    }
                    Err(error) => {
                        read_error = Some(error.to_string());
                        break;
                    }
                }
            }
            if let Some(error) = read_error {
                last = format!("{url}: 读取失败 {error}");
                continue;
            }
            let digest = format!("{:x}", hasher.finalize());
            if digest == expected {
                println!(
                    "下载校验通过：{url}（{total} 字节，{:.0}s）",
                    started.elapsed().as_secs_f64()
                );
                if asset.size > 0 {
                    assert_eq!(asset.size, total, "下载字节数与清单不一致");
                }
                return;
            }
            last = format!("{url}: SHA-256 不匹配（{digest}）");
        }
        panic!("所有下载候选均失败：{last}");
    }
}
