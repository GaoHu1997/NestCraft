//! CR-053 / STORY-070：CLI 命令工具（Shell）探测、读取、保存与注入。
//!
//! 按 LLD-CR053 实现：
//! - NestCraft 不引入 Shell 执行层：只把「CLI 内部用哪个命令工具」作为启动环境变量交给 CLI；
//! - 复用 `setting_default`（键 `cli.shell.<cliId>`），无新表、无迁移；缺省/解析失败一律按 auto，
//!   不报错、不改写用户设置（与升级前行为一致）；
//! - 检测只来自本机真实探测（固定位置优先 + PATH 兜底，Git Bash 排除 WindowsApps WSL 存根）；
//! - 保存前服务端复核（枚举、绝对路径、is_file、文件名白名单、WindowsApps 排除）；
//! - 注入映射严格按 LLD §5 表格：codex 实测前不注入任何变量（只存偏好），grok 不提供保存入口；
//! - 新会话启动前复检：失效时阻止启动并返回明确中文错误，提示改选「自动」，不静默回落。

use crate::db;
use crate::models::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

pub const SHELL_KEY_PREFIX: &str = "cli.shell.";
pub const SHELL_CLIS: [&str; 3] = ["claude", "codex", "grok"];
pub const SHELL_MODES: [&str; 4] = ["auto", "pwsh", "windows-powershell", "git-bash"];

/// 单次探测超时（LLD §3）。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// PowerShell 7 固定位置（Claude Code 只从固定绝对位置识别，不查 PATH）。
const PWSH_FIXED: [&str; 2] = [
    r"C:\Program Files\PowerShell\7\pwsh.exe",
    r"C:\Program Files\PowerShell\7-preview\pwsh.exe",
];
/// Git Bash 固定位置。
const BASH_FIXED: [&str; 2] = [
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSetting {
    /// auto | pwsh | windows-powershell | git-bash
    pub mode: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub saved_at: Option<i64>,
}

impl ShellSetting {
    fn auto() -> Self {
        Self { mode: "auto".into(), path: None, saved_at: None }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCandidate {
    /// pwsh | windows-powershell | git-bash
    pub kind: String,
    /// 界面文案
    pub label: String,
    pub path: Option<String>,
    pub version: Option<String>,
    /// fixed（固定位置）| path（PATH 兜底）
    pub source: String,
    pub available: bool,
    /// 不可用原因（如「未找到」/「探测超时」），可用时为空
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSettingView {
    pub setting: ShellSetting,
    /// 非 auto 且保存路径当前不存在（前端标红、禁用保存的依据；只读不写）。
    pub missing: bool,
}

fn spawn_probe(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

/// 运行版本探测命令：stdin 关闭、CREATE_NO_WINDOW、3 秒超时；失败返回原因不让整个命令失败。
async fn probe_version(exe: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    spawn_probe(&mut cmd);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "探测超时（3 秒）".to_string())?
        .map_err(|e| format!("探测进程启动失败：{}", e))?;
    if !out.status.success() {
        return Err(format!("探测进程退出码 {}", out.status.code().unwrap_or(-1)));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("探测输出为空".into());
    }
    Ok(text.lines().next().unwrap_or("").trim().to_string())
}

/// 路径任意组件是否为 WindowsApps（Store 应用执行别名目录，Git Bash 存根须排除）。
pub fn is_windows_apps_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("WindowsApps"))
}

/// 按候选目录查找 `bash.exe`，跳过 WindowsApps 下的 WSL 存根。
fn find_bash_in_dirs(dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        if is_windows_apps_dir(dir) {
            continue;
        }
        let cand = dir.join("bash.exe");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default()
}

/// 在固定位置与 PATH 兜底之间选第一个存在的候选；返回（路径，来源）。
fn pick_shell_path(fixed: &[PathBuf], fallback: Option<PathBuf>) -> Option<(PathBuf, &'static str)> {
    if let Some(p) = fixed.iter().find(|p| p.is_file()) {
        return Some((p.clone(), "fixed"));
    }
    fallback.map(|p| (p, "path"))
}

/// 探测单个候选类型（LLD §3 表格：固定位置优先，PATH 兜底排除 WindowsApps）。
async fn probe_candidate(kind: &str) -> ShellCandidate {
    let (label, found, version_args): (&str, Option<(PathBuf, &'static str)>, &[&str]) = match kind {
        "pwsh" => (
            "PowerShell 7",
            pick_shell_path(
                &PWSH_FIXED.iter().map(PathBuf::from).collect::<Vec<_>>(),
                find_bash_like("pwsh.exe"),
            ),
            &["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        ),
        "windows-powershell" => (
            "Windows PowerShell 5.1",
            pick_shell_path(&windows_powershell_fixed(), None), // LLD：不查 PATH
            &["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        ),
        "git-bash" => (
            "Git Bash",
            pick_shell_path(
                &BASH_FIXED.iter().map(PathBuf::from).collect::<Vec<_>>(),
                find_bash_in_dirs(&path_dirs()),
            ),
            &["-c", "echo $BASH_VERSION"],
        ),
        other => {
            return ShellCandidate {
                kind: other.to_string(),
                label: other.to_string(),
                path: None,
                version: None,
                source: "fixed".into(),
                available: false,
                detail: Some("未知候选类型".into()),
            }
        }
    };
    let Some((path, source)) = found else {
        return ShellCandidate {
            kind: kind.to_string(),
            label: label.to_string(),
            path: None,
            version: None,
            source: "fixed".into(),
            available: false,
            detail: Some("未找到".into()),
        };
    };
    match probe_version(&path, version_args).await {
        Ok(version) => ShellCandidate {
            kind: kind.to_string(),
            label: label.to_string(),
            path: Some(path.to_string_lossy().to_string()),
            version: Some(version),
            source: source.to_string(),
            available: true,
            detail: None,
        },
        Err(detail) => ShellCandidate {
            kind: kind.to_string(),
            label: label.to_string(),
            path: Some(path.to_string_lossy().to_string()),
            version: None,
            source: source.to_string(),
            available: false,
            // 探测失败≠未安装：原因如实呈现（「未知」），由用户判断。
            detail: Some(format!("不可用（{}）", detail)),
        },
    }
}

/// PATH 兜底解析裸 exe 名（pwsh.exe），不做 WindowsApps 排除（仅 bash 需要排除）。
fn find_bash_like(name: &str) -> Option<PathBuf> {
    for dir in path_dirs() {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Windows PowerShell 5.1 固定位置：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。
fn windows_powershell_fixed() -> Vec<PathBuf> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    vec![PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")]
}

/// 候选检测：每类型一条，失败返回 available=false+原因，不让整个命令失败；检测不改任何设置。
#[tauri::command]
pub async fn cli_shell_candidates(cli_id: String) -> Result<Vec<ShellCandidate>, String> {
    if !SHELL_CLIS.contains(&cli_id.as_str()) {
        return Err(format!("未知 CLI：{}", cli_id));
    }
    let mut out = Vec::new();
    for kind in ["pwsh", "windows-powershell", "git-bash"] {
        out.push(probe_candidate(kind).await);
    }
    Ok(out)
}

/// 解析设置：缺省/JSON 解析失败/枚举非法/auto 与 path 不配对 → 一律按 auto，不报错不改写。
pub fn parse_shell_setting(raw: Option<&str>) -> ShellSetting {
    let Some(raw) = raw else { return ShellSetting::auto() };
    let parsed: Result<ShellSetting, _> = serde_json::from_str(raw);
    match parsed {
        Ok(s) => {
            let has_path = s.path.as_deref().map(|p| !p.trim().is_empty()).unwrap_or(false);
            if !SHELL_MODES.contains(&s.mode.as_str()) || (s.mode == "auto") == has_path {
                ShellSetting::auto()
            } else {
                s
            }
        }
        Err(_) => ShellSetting::auto(),
    }
}

fn shell_key(cli_id: &str) -> String {
    format!("{}{}", SHELL_KEY_PREFIX, cli_id)
}

fn read_shell_setting_raw(conn: &rusqlite::Connection, cli_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
        [shell_key(cli_id)],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|v| v.flatten())
}

/// 文件名白名单与类型匹配（保存与复检共用；LLD §4：大小写不敏感，git-bash 排除 WindowsApps）。
pub fn validate_shell_path(mode: &str, path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("路径缺少文件名")?
        .to_ascii_lowercase();
    let expected = match mode {
        "pwsh" => "pwsh.exe",
        "windows-powershell" => "powershell.exe",
        "git-bash" => "bash.exe",
        _ => return Err("未知命令工具类型".into()),
    };
    if name != expected {
        return Err(format!("文件名必须是 {}", expected));
    }
    if mode == "git-bash" && is_windows_apps_dir(path) {
        return Err("不支持 WindowsApps 下的 WSL bash 存根".into());
    }
    Ok(())
}

/// 保存前服务端复核（LLD §4）；前端校验只用于即时反馈，此处为准。
pub fn validate_shell_selection(cli_id: &str, mode: &str, path: Option<&str>) -> Result<ShellSetting, String> {
    if !SHELL_CLIS.contains(&cli_id) {
        return Err(format!("未知 CLI：{}", cli_id));
    }
    if !SHELL_MODES.contains(&mode) {
        return Err(format!("未知命令工具类型：{}", mode));
    }
    if cli_id == "grok" && mode != "auto" {
        return Err("Grok CLI 未提供 Shell 配置项，仅支持展示，不支持指定命令工具".into());
    }
    let trimmed = path.map(str::trim).filter(|p| !p.is_empty());
    if mode == "auto" {
        if trimmed.is_some() {
            return Err("自动模式不接受路径".into());
        }
        return Ok(ShellSetting { mode: "auto".into(), path: None, saved_at: Some(now_ms()) });
    }
    let path = trimmed.ok_or("指定命令工具时必须提供路径")?;
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("命令工具路径必须是绝对路径".into());
    }
    if !p.is_file() {
        return Err(format!("命令工具路径不存在：{}", path));
    }
    validate_shell_path(mode, p)?;
    Ok(ShellSetting { mode: mode.into(), path: Some(path.to_string()), saved_at: Some(now_ms()) })
}

fn write_shell_setting(cli_id: &str, setting: &ShellSetting) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let json = serde_json::to_string(setting).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value=?2, updatedAt=?3",
        rusqlite::params![shell_key(cli_id), json, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存：服务端复核后写入 `cli.shell.<cliId>`；失败不自动改回 auto。
#[tauri::command]
pub fn cli_shell_save(cli_id: String, mode: String, path: Option<String>) -> Result<ShellSetting, String> {
    let setting = validate_shell_selection(&cli_id, &mode, path.as_deref())?;
    write_shell_setting(&cli_id, &setting)?;
    Ok(setting)
}

/// 读取当前设置并附带失效判定（missing：非 auto 且保存路径当前不存在）。
#[tauri::command]
pub fn cli_shell_get(cli_id: String) -> Result<ShellSettingView, String> {
    if !SHELL_CLIS.contains(&cli_id.as_str()) {
        return Err(format!("未知 CLI：{}", cli_id));
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let raw = read_shell_setting_raw(conn, &cli_id)?;
    let setting = parse_shell_setting(raw.as_deref());
    let missing = setting.mode != "auto"
        && setting.path.as_deref().map(|p| !Path::new(p).is_file()).unwrap_or(false);
    Ok(ShellSettingView { setting, missing })
}

/// 复检（LLD §6）：路径必须为绝对路径、存在且通过白名单；错误只含路径与原因，并提示改选「自动」。
pub fn check_shell_ready(mode: &str, path: Option<&str>) -> Result<(), String> {
    let path = path.ok_or("命令工具设置缺少路径，请重新检测或改选「自动」")?;
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("所选命令工具路径不是绝对路径：{}", path));
    }
    if !p.is_file() {
        return Err(format!(
            "所选命令工具已不存在：{}。请重新检测或改选「自动」，不会静默改用其他 Shell",
            path
        ));
    }
    validate_shell_path(mode, p)
        .map_err(|e| format!("所选命令工具不可用：{}（{}）。请重新检测或改选「自动」", path, e))
}

/// 新会话启动前：读取 Shell 设置并复检；auto 返回 None；失效返回 Err 阻止启动（不静默回落）。
pub fn prepare_launch(cli_id: &str) -> Result<Option<ShellSetting>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let raw = read_shell_setting_raw(conn, cli_id)?;
    let setting = parse_shell_setting(raw.as_deref());
    if setting.mode == "auto" {
        return Ok(None);
    }
    check_shell_ready(&setting.mode, setting.path.as_deref())?;
    Ok(Some(setting))
}

/// 注入映射（LLD-CR053 §5 表格，逐行照做；构造 `Command` 后可断言 env，不真正 spawn）。
pub fn inject_shell_env(cli_id: &str, setting: Option<&ShellSetting>, cmd: &mut Command) {
    let Some(setting) = setting else { return };
    if setting.mode == "auto" {
        return;
    }
    match cli_id {
        "claude" => match setting.mode.as_str() {
            "pwsh" | "windows-powershell" => {
                cmd.env("CLAUDE_CODE_USE_POWERSHELL_TOOL", "1");
            }
            "git-bash" => {
                if let Some(p) = setting.path.as_deref() {
                    cmd.env("CLAUDE_CODE_GIT_BASH_PATH", p);
                    cmd.env("CLAUDE_CODE_USE_POWERSHELL_TOOL", "0");
                }
            }
            _ => {}
        },
        // codex：实验性，环境变量语义未实测前不注入任何变量（只存偏好，界面已标注）。
        "codex" => {}
        // grok：无配置项，不注入。
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cr053-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---------- 解析：缺省/解析失败/非法 = auto，不改写 ----------

    #[test]
    fn shell_setting_defaults_and_corruption_fall_back_to_auto() {
        assert_eq!(parse_shell_setting(None), ShellSetting::auto());
        assert_eq!(parse_shell_setting(Some("")), ShellSetting::auto());
        assert_eq!(parse_shell_setting(Some("not-json")), ShellSetting::auto());
        assert_eq!(parse_shell_setting(Some("[]")), ShellSetting::auto());
        // mode 枚举外
        assert_eq!(
            parse_shell_setting(Some(r#"{"mode":"cmd","path":null}"#)),
            ShellSetting::auto()
        );
        // auto 与 path 不配对
        assert_eq!(
            parse_shell_setting(Some(r#"{"mode":"auto","path":"C:\\x\\pwsh.exe"}"#)),
            ShellSetting::auto()
        );
        assert_eq!(
            parse_shell_setting(Some(r#"{"mode":"pwsh","path":null}"#)),
            ShellSetting::auto()
        );
        // 合法值保留
        let ok = parse_shell_setting(Some(r#"{"mode":"git-bash","path":"C:\\Git\\bin\\bash.exe","savedAt":1}"#));
        assert_eq!(ok.mode, "git-bash");
        assert_eq!(ok.path.as_deref(), Some(r"C:\Git\bin\bash.exe"));
        assert_eq!(ok.saved_at, Some(1));
    }

    // ---------- 保存校验（LLD §4 逐条） ----------

    #[test]
    fn save_rejects_unknown_cli_and_mode() {
        assert!(validate_shell_selection("shell", "auto", None).is_err());
        assert!(validate_shell_selection("claude", "cmd", None).is_err());
    }

    #[test]
    fn save_grok_only_accepts_auto() {
        assert!(validate_shell_selection("grok", "auto", None).is_ok());
        assert!(validate_shell_selection("grok", "pwsh", Some("C:\\x\\pwsh.exe"))
            .unwrap_err()
            .contains("仅支持展示"));
    }

    #[test]
    fn save_auto_rejects_path_and_requires_no_path() {
        assert!(validate_shell_selection("claude", "auto", Some("C:\\x\\pwsh.exe")).is_err());
        assert!(validate_shell_selection("claude", "pwsh", None).is_err());
        assert!(validate_shell_selection("claude", "pwsh", Some("  ")).is_err());
    }

    #[test]
    fn save_rejects_relative_and_missing_paths() {
        assert!(validate_shell_selection("claude", "pwsh", Some("relative\\pwsh.exe")).is_err());
        assert!(validate_shell_selection("claude", "pwsh", Some("C:\\不存在目录\\pwsh.exe")).is_err());
    }

    #[test]
    fn save_enforces_filename_whitelist_case_insensitive() {
        let dir = temp_dir("whitelist");
        let bad = dir.join("cmd.exe");
        std::fs::write(&bad, "x").unwrap();
        assert!(validate_shell_selection("claude", "pwsh", Some(bad.to_str().unwrap())).is_err());
        let mixed = dir.join("PwSh.EXE");
        std::fs::write(&mixed, "x").unwrap();
        let ok = validate_shell_selection("claude", "pwsh", Some(mixed.to_str().unwrap())).unwrap();
        assert_eq!(ok.mode, "pwsh");
        assert!(ok.path.as_deref().unwrap_or("").to_ascii_lowercase().ends_with("pwsh.exe"));
        // 类型与文件名不匹配（pwsh 模式给 powershell.exe）
        let wp = dir.join("powershell.exe");
        std::fs::write(&wp, "x").unwrap();
        assert!(validate_shell_selection("claude", "pwsh", Some(wp.to_str().unwrap())).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_rejects_windows_apps_bash_stub() {
        let dir = temp_dir("windowsapps");
        let stub = dir.join("WindowsApps").join("bash.exe");
        std::fs::create_dir_all(stub.parent().unwrap()).unwrap();
        std::fs::write(&stub, "x").unwrap();
        assert!(is_windows_apps_dir(stub.parent().unwrap()));
        let err = validate_shell_selection("claude", "git-bash", Some(stub.to_str().unwrap()))
            .unwrap_err();
        assert!(err.contains("WindowsApps"), "实际错误：{}", err);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_accepts_valid_absolute_path() {
        let dir = temp_dir("valid");
        let exe = dir.join("bash.exe");
        std::fs::write(&exe, "x").unwrap();
        let ok = validate_shell_selection("codex", "git-bash", Some(exe.to_str().unwrap())).unwrap();
        assert_eq!(ok.mode, "git-bash");
        assert!(ok.saved_at.is_some());
        // auto 保存：path 必须为空
        let auto = validate_shell_selection("codex", "auto", None).unwrap();
        assert_eq!(auto, ShellSetting { mode: "auto".into(), path: None, saved_at: auto.saved_at });
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---------- 候选路径选择：固定位置优先、PATH 兜底、WindowsApps 排除 ----------

    #[test]
    fn pick_prefers_fixed_location_over_path_fallback() {
        let dir = temp_dir("pick");
        let fixed = dir.join("pwsh.exe");
        std::fs::write(&fixed, "x").unwrap();
        let fallback = dir.join("other").join("pwsh.exe");
        std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();
        std::fs::write(&fallback, "x").unwrap();
        let (picked, source) = pick_shell_path(&[fixed.clone()], Some(fallback.clone())).unwrap();
        assert_eq!(picked, fixed);
        assert_eq!(source, "fixed");
        // 固定位置缺失 → PATH 兜底
        let (picked, source) = pick_shell_path(&[dir.join("missing.exe")], Some(fallback.clone())).unwrap();
        assert_eq!(picked, fallback);
        assert_eq!(source, "path");
        // 都没有 → None
        assert!(pick_shell_path(&[dir.join("missing.exe")], None).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bash_path_lookup_skips_windows_apps_stub_dirs() {
        let dir = temp_dir("bashdirs");
        let real = dir.join("git").join("bash.exe");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "x").unwrap();
        let stub_dir = dir.join("WindowsApps");
        let stub = stub_dir.join("bash.exe");
        std::fs::create_dir_all(&stub_dir).unwrap();
        std::fs::write(&stub, "x").unwrap();
        // 存根在前：应被跳过，命中真实 bash
        let picked = find_bash_in_dirs(&[stub_dir.clone(), real.parent().unwrap().to_path_buf()]).unwrap();
        assert_eq!(picked, real);
        // 只有存根：None
        assert!(find_bash_in_dirs(&[stub_dir]).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---------- 探测超时（真实 powershell 存在时验证 3 秒上限；缺失则条件跳过） ----------

    #[tokio::test]
    async fn probe_version_times_out_within_three_seconds() {
        let exe = windows_powershell_fixed().remove(0);
        if !exe.is_file() {
            println!("跳过：本机不存在 Windows PowerShell，超时用例不适用");
            return;
        }
        let started = std::time::Instant::now();
        let result = probe_version(&exe, &["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("探测超时"));
        assert!(started.elapsed() < Duration::from_secs(10), "应在超时上限内返回");
    }

    // ---------- 注入映射（LLD §5 表格逐行；构造 Command 断言 env，不 spawn） ----------

    fn env_of(cmd: &Command, key: &str) -> Option<String> {
        cmd.as_std()
            .get_envs()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().to_string()))
    }

    fn setting(mode: &str, path: Option<&str>) -> ShellSetting {
        ShellSetting { mode: mode.into(), path: path.map(|p| p.into()), saved_at: Some(1) }
    }

    #[test]
    fn claude_pwsh_enables_powershell_tool_without_path() {
        let mut cmd = Command::new("claude");
        inject_shell_env("claude", Some(&setting("pwsh", Some("C:\\PS7\\pwsh.exe"))), &mut cmd);
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL").as_deref(), Some("1"));
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH"), None);
        // windows-powershell 同开关
        let mut cmd = Command::new("claude");
        inject_shell_env("claude", Some(&setting("windows-powershell", Some("C:\\PS\\powershell.exe"))), &mut cmd);
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL").as_deref(), Some("1"));
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH"), None);
    }

    #[test]
    fn claude_git_bash_sets_path_and_disables_powershell_tool() {
        let mut cmd = Command::new("claude");
        inject_shell_env("claude", Some(&setting("git-bash", Some("C:\\Git\\bin\\bash.exe"))), &mut cmd);
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH").as_deref(), Some("C:\\Git\\bin\\bash.exe"));
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL").as_deref(), Some("0"));
    }

    #[test]
    fn auto_and_missing_setting_inject_nothing() {
        for cli in ["claude", "codex", "grok"] {
            let mut cmd = Command::new(cli);
            inject_shell_env(cli, None, &mut cmd);
            assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL"), None);
            let mut cmd = Command::new(cli);
            inject_shell_env(cli, Some(&setting("auto", None)), &mut cmd);
            assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL"), None);
            assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH"), None);
        }
    }

    #[test]
    fn codex_injects_nothing_until_verified_and_grok_never_injects() {
        for mode in ["pwsh", "windows-powershell", "git-bash"] {
            let mut cmd = Command::new("codex");
            inject_shell_env("codex", Some(&setting(mode, Some("C:\\x\\bash.exe"))), &mut cmd);
            assert_eq!(env_of(&cmd, "PWSH"), None);
            assert_eq!(env_of(&cmd, "POWERSHELL"), None);
            assert_eq!(env_of(&cmd, "SHELL"), None);
            assert_eq!(env_of(&cmd, "CLAUDE_CODE_USE_POWERSHELL_TOOL"), None);
            assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH"), None);
        }
        let mut cmd = Command::new("grok");
        inject_shell_env("grok", Some(&setting("git-bash", Some("C:\\x\\bash.exe"))), &mut cmd);
        assert_eq!(env_of(&cmd, "CLAUDE_CODE_GIT_BASH_PATH"), None);
    }

    // ---------- 复检（LLD §6） ----------

    #[test]
    fn launch_check_blocks_missing_or_invalid_path() {
        let dir = temp_dir("ready");
        let exe = dir.join("pwsh.exe");
        std::fs::write(&exe, "x").unwrap();
        assert!(check_shell_ready("pwsh", Some(exe.to_str().unwrap())).is_ok());
        let missing = dir.join("gone").join("pwsh.exe");
        let err = check_shell_ready("pwsh", Some(missing.to_str().unwrap())).unwrap_err();
        assert!(err.contains("已不存在") && err.contains("自动"), "实际错误：{}", err);
        assert!(check_shell_ready("pwsh", None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
