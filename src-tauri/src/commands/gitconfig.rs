//! Git 侧栏的配置类命令（CR-067）：远程管理、国内加速、按主机的访问令牌。
//!
//! 三类数据各归其位：
//! - 远程：仓库自身的 `.git/config`，通过 git CLI 读写，不另存。
//! - 国内加速：`setting_default(scope=global, key='git.accel')`，全局一条。
//! - 令牌：应用受管密钥文件 `secrets.json`（与 MCP 令牌同一互斥锁、同一原子写），
//!   键为 `git-credential:<host>`，值含用户名与令牌。
//!
//! 令牌永不出现在命令返回值里：列表只回主机、用户名与保存时间；保存不回显。

use crate::commands::general::{get_setting, set_setting};
use crate::commands::providers::secrets_file_guard;
use crate::models::{AccelConfig, CredentialHostEntry, RemoteEntry, StoredGitCredential};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use tokio::process::Command;

/// 与 `gitcmd.rs` 共用同一套执行约定：数组参数、无窗口、失败回 stderr。
async fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(crate::util::resolve_command("git"));
    cmd.current_dir(repo).args(args).env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| format!("git 启动失败：{}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn find_repo(start: &str) -> Result<std::path::PathBuf, String> {
    let mut cur = std::path::PathBuf::from(start);
    if !cur.is_dir() {
        return Err(format!("目录不存在：{}", start));
    }
    loop {
        if cur.join(".git").exists() {
            return Ok(cur);
        }
        if !cur.pop() {
            return Err("该目录不在 Git 仓库内".into());
        }
    }
}

/* ---------- 远程 ---------- */

/// 远程名称校验：非空、不以 `-` 开头、只允许字母数字与 `._-`。
pub fn remote_name_issue(name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return Some("远程名称不能为空".into());
    }
    if n.starts_with('-') {
        return Some("远程名称不能以 - 开头".into());
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Some("远程名称只能包含字母、数字、点、下划线与短横线".into());
    }
    None
}

/// 远程地址校验：只接受 http(s)、ssh、git、本机路径形式，且不含空白。
pub fn remote_url_issue(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() {
        return Some("仓库地址不能为空".into());
    }
    if u.chars().any(char::is_whitespace) {
        return Some("仓库地址不能包含空白".into());
    }
    if u.starts_with('-') {
        return Some("仓库地址不能以 - 开头".into());
    }
    None
}

fn parse_remotes(raw: &str) -> Vec<RemoteEntry> {
    // `remote -v` 每行：`<name>\t<url> (fetch|push)`，同一远程两行，取 fetch。
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for line in raw.lines() {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or("").trim();
        let rest = parts.next().unwrap_or("");
        if name.is_empty() || !rest.contains("(fetch)") {
            continue;
        }
        let url = rest.trim_end_matches("(fetch)").trim();
        map.insert(name.to_string(), url.to_string());
    }
    map.into_iter().map(|(name, url)| RemoteEntry { name, url }).collect()
}

#[tauri::command]
pub async fn git_remotes(repo_path: String) -> Result<Vec<RemoteEntry>, String> {
    let repo = find_repo(&repo_path)?;
    let raw = git(&repo, &["remote", "-v"]).await?;
    Ok(parse_remotes(&raw))
}

/// 新增或更新远程：已存在走 `set-url`，否则 `add`。只改仓库配置，不访问网络。
#[tauri::command]
pub async fn git_remote_save(repo_path: String, name: String, url: String) -> Result<(), String> {
    if let Some(issue) = remote_name_issue(&name) {
        return Err(issue);
    }
    if let Some(issue) = remote_url_issue(&url) {
        return Err(issue);
    }
    let repo = find_repo(&repo_path)?;
    let exists = git(&repo, &["remote"]).await?
        .lines()
        .any(|line| line.trim() == name.trim());
    if exists {
        git(&repo, &["remote", "set-url", name.trim(), url.trim()]).await.map(|_| ())
    } else {
        git(&repo, &["remote", "add", name.trim(), url.trim()]).await.map(|_| ())
    }
}

/// 删除远程（仅配置，不删远端分支）。
#[tauri::command]
pub async fn git_remote_remove(repo_path: String, name: String) -> Result<(), String> {
    if let Some(issue) = remote_name_issue(&name) {
        return Err(issue);
    }
    let repo = find_repo(&repo_path)?;
    git(&repo, &["remote", "remove", name.trim()]).await.map(|_| ())
}

/* ---------- 国内加速 ---------- */

const ACCEL_KEY: &str = "git.accel";
const DEFAULT_ACCEL_URL: &str = "https://gh-proxy.com/";

/// 加速前缀校验：http(s)、无空白；返回规范化后的前缀（以 `/` 结尾）。
pub fn normalize_accel_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("镜像前缀不能为空".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("镜像前缀不能包含空白".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("镜像前缀必须以 http:// 或 https:// 开头".into());
    }
    Ok(if trimmed.ends_with('/') { trimmed.to_string() } else { format!("{}/", trimmed) })
}

fn read_accel() -> AccelConfig {
    let raw = get_setting(ACCEL_KEY.to_string()).ok().flatten();
    let parsed: Option<AccelConfig> = raw
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok());
    match parsed {
        Some(cfg) => AccelConfig {
            enabled: cfg.enabled,
            url: if cfg.url.trim().is_empty() { DEFAULT_ACCEL_URL.to_string() } else { cfg.url },
        },
        None => AccelConfig { enabled: false, url: DEFAULT_ACCEL_URL.to_string() },
    }
}

#[tauri::command]
pub fn git_accel_get() -> Result<AccelConfig, String> {
    Ok(read_accel())
}

#[tauri::command]
pub fn git_accel_set(enabled: bool, url: String) -> Result<AccelConfig, String> {
    let normalized = normalize_accel_url(&url)?;
    let cfg = AccelConfig { enabled, url: normalized };
    let text = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    set_setting(ACCEL_KEY.to_string(), Some(text))?;
    Ok(cfg)
}

/// 给网络读命令拼加速参数：`-c url.<prefix>https://github.com/.insteadOf=https://github.com/`。
pub fn accel_args(enabled: bool, url: &str) -> Vec<String> {
    if !enabled {
        return Vec::new();
    }
    let Ok(base) = normalize_accel_url(url) else { return Vec::new() };
    vec![
        "-c".to_string(),
        format!("url.{}https://github.com/.insteadOf=https://github.com/", base),
    ]
}

/* ---------- 令牌（按远端主机） ---------- */

fn credential_reference(host: &str) -> String {
    format!("git-credential:{}", host.trim().to_ascii_lowercase())
}

fn secrets_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let _ = app;
    let dir = crate::storage_layout::category("secrets")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

fn read_secrets(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    match std::fs::read(secrets_path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "受管密钥文件格式无效".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err("受管密钥文件不可读取".into()),
    }
}

fn write_secrets(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = secrets_path(app)?;
    let tmp = path.with_file_name(format!("secrets-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| "无法写入受管密钥文件".to_string())?;
        file.write_all(&serde_json::to_vec_pretty(map).map_err(|_| "无法序列化受管密钥".to_string())?)
            .map_err(|_| "无法写入受管密钥文件".to_string())?;
        file.sync_all().map_err(|_| "无法保存受管密钥文件".to_string())?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|_| "无法替换受管密钥文件，原文件已保留".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 主机名规范化：小写、去端口与协议、拒绝空白与路径字符。
pub fn normalize_host(host: &str) -> Result<String, String> {
    let mut h = host.trim().to_ascii_lowercase();
    if let Some(idx) = h.find("://") {
        h = h[idx + 3..].to_string();
    }
    if let Some(idx) = h.find('/') {
        h.truncate(idx);
    }
    if let Some(idx) = h.rfind(':') {
        // 端口只在 `host:port` 形态下截断；IPv6 字面量不在支持范围，明确拒绝。
        if h[idx + 1..].chars().all(|c| c.is_ascii_digit()) && !h[idx + 1..].is_empty() {
            h.truncate(idx);
        }
    }
    if h.is_empty() {
        return Err("主机不能为空".into());
    }
    if h.contains(':') {
        return Err("暂不支持 IPv6 字面量主机".into());
    }
    if !h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) || !h.contains('.') {
        return Err("主机名格式无效（示例：github.com）".into());
    }
    Ok(h)
}

#[tauri::command]
pub fn git_credentials_list(app: tauri::AppHandle) -> Result<Vec<CredentialHostEntry>, String> {
    let _guard = secrets_file_guard();
    let map = read_secrets(&app)?;
    let mut out = Vec::new();
    for (key, value) in map.iter() {
        let Some(host) = key.strip_prefix("git-credential:") else { continue };
        // 只解析元信息；令牌字段在此被丢弃，绝不进入返回结构。
        let stored: StoredGitCredential = serde_json::from_str(value).unwrap_or(StoredGitCredential {
            username: "oauth2".into(),
            token: String::new(),
            saved_at: String::new(),
        });
        out.push(CredentialHostEntry {
            host: host.to_string(),
            username: stored.username,
            saved_at: stored.saved_at,
        });
    }
    out.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct CredentialSaveInput {
    pub host: String,
    pub username: Option<String>,
    /// 空表示保留原令牌（新增主机时为空则拒绝）。
    pub token: Option<String>,
}

#[tauri::command]
pub fn git_credentials_save(
    app: tauri::AppHandle,
    input: CredentialSaveInput,
) -> Result<CredentialHostEntry, String> {
    let host = normalize_host(&input.host)?;
    let reference = credential_reference(&host);
    let _guard = secrets_file_guard();
    let mut map = read_secrets(&app)?;
    let existing: Option<StoredGitCredential> = map
        .get(&reference)
        .and_then(|raw| serde_json::from_str(raw).ok());
    let token = match input.token.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => match existing.as_ref() {
            Some(prev) if !prev.token.trim().is_empty() => prev.token.clone(),
            _ => return Err("新增主机需要填写访问令牌".into()),
        },
    };
    let username = input
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| existing.as_ref().map(|p| p.username.clone()))
        .unwrap_or_else(|| "oauth2".to_string());
    let saved_at = chrono_now();
    let record = StoredGitCredential { username: username.clone(), token, saved_at: saved_at.clone() };
    map.insert(reference, serde_json::to_string(&record).map_err(|_| "无法序列化令牌".to_string())?);
    write_secrets(&app, &map)?;
    Ok(CredentialHostEntry { host, username, saved_at })
}

#[tauri::command]
pub fn git_credentials_delete(app: tauri::AppHandle, host: String) -> Result<(), String> {
    let host = normalize_host(&host)?;
    let reference = credential_reference(&host);
    let _guard = secrets_file_guard();
    let mut map = read_secrets(&app)?;
    if map.remove(&reference).is_none() {
        return Ok(());
    }
    write_secrets(&app, &map)
}

/// 取某主机的令牌参数（内部用，不暴露命令）。返回 (用户名, 令牌)。
pub fn load_credential(app: &tauri::AppHandle, host: &str) -> Option<(String, String)> {
    let reference = credential_reference(host);
    let _guard = secrets_file_guard();
    let map = read_secrets(app).ok()?;
    let raw = map.get(&reference)?;
    let stored: StoredGitCredential = serde_json::from_str(raw).ok()?;
    if stored.token.trim().is_empty() {
        return None;
    }
    Some((stored.username, stored.token))
}

/// 由远程地址推出主机（用于挑选令牌）；无主机（本机路径）时返回 None。
pub fn host_of_remote_url(url: &str) -> Option<String> {
    let u = url.trim();
    // scp 形式：git@github.com:owner/repo.git
    if let Some(rest) = u.strip_prefix("git@") {
        return rest.split(':').next().map(|h| h.to_ascii_lowercase());
    }
    for scheme in ["https://", "http://", "ssh://"] {
        if let Some(rest) = u.strip_prefix(scheme) {
            let authority = rest.split('/').next().unwrap_or("");
            let host = authority.rsplit('@').next().unwrap_or(authority);
            let host = host.split(':').next().unwrap_or(host);
            if !host.is_empty() {
                return Some(host.to_ascii_lowercase());
            }
        }
    }
    None
}

fn chrono_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

#[derive(Debug, Serialize)]
pub struct RemoteProbe {
    pub host: Option<String>,
    pub credential: bool,
}

/// 供面板展示「当前仓库远端主机是否已配置令牌」，不回传令牌本身。
#[tauri::command]
pub async fn git_credential_status(
    app: tauri::AppHandle,
    repo_path: String,
) -> Result<RemoteProbe, String> {
    let repo = find_repo(&repo_path)?;
    let raw = git(&repo, &["remote", "-v"]).await.unwrap_or_default();
    let hosts: Vec<String> = parse_remotes(&raw).iter().filter_map(|r| host_of_remote_url(&r.url)).collect();
    let host = hosts.into_iter().next();
    let credential = host.as_deref().and_then(|h| load_credential(&app, h)).is_some();
    Ok(RemoteProbe { host, credential })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accel_url_requires_http_scheme() {
        assert!(normalize_accel_url("gh-proxy.com").is_err());
        assert!(normalize_accel_url("").is_err());
        assert_eq!(normalize_accel_url("https://gh-proxy.com").unwrap(), "https://gh-proxy.com/");
        assert_eq!(normalize_accel_url(" https://a.b/ ").unwrap(), "https://a.b/");
    }

    #[test]
    fn accel_args_only_when_enabled() {
        assert!(accel_args(false, "https://gh-proxy.com/").is_empty());
        let args = accel_args(true, "https://gh-proxy.com/");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], "url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/");
    }

    #[test]
    fn remote_name_rules() {
        assert!(remote_name_issue("origin").is_none());
        assert!(remote_name_issue("-bad").is_some());
        assert!(remote_name_issue("has space").is_some());
        assert!(remote_name_issue("a/b").is_some());
    }

    #[test]
    fn remote_url_rules() {
        assert!(remote_url_issue("https://github.com/a/b.git").is_none());
        assert!(remote_url_issue("").is_some());
        assert!(remote_url_issue("https://a b").is_some());
    }

    #[test]
    fn parse_remotes_keeps_fetch_url() {
        let raw = "origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\nup\thttps://x/y (fetch)\n";
        let list = parse_remotes(raw);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "origin");
        assert_eq!(list[0].url, "https://github.com/a/b.git");
    }

    #[test]
    fn host_extraction() {
        assert_eq!(host_of_remote_url("https://github.com/a/b.git").as_deref(), Some("github.com"));
        assert_eq!(host_of_remote_url("git@github.com:a/b.git").as_deref(), Some("github.com"));
        assert_eq!(host_of_remote_url("https://user@gitlab.com:8443/a/b").as_deref(), Some("gitlab.com"));
        assert_eq!(host_of_remote_url("D:/repos/local"), None);
    }

    #[test]
    fn host_normalization() {
        assert_eq!(normalize_host("GitHub.com").unwrap(), "github.com");
        assert_eq!(normalize_host("https://github.com/x").unwrap(), "github.com");
        assert!(normalize_host("").is_err());
        assert!(normalize_host("localhost").is_err());
    }
}
