//! CLI SDK 管理（对照 dsh-maestro-codex 的任务状态机与检测逻辑移植）。
//!
//! - 安装/卸载 = npm 全局任务：`npm install -g <pkg>` / `npm uninstall -g <pkg>`
//! - 任务状态机：queued → running → done|failed|cancelled|timeout；事件日志环形上限
//! - 已安装检测：`npm ls -g --depth=0 --json` + `<cmd> --version` 兜底
//! - 会话候选过滤：只列已安装且启用的 CLI（CR-012）

use crate::db;
use crate::models::{now_ms, new_id, SdkJob, SdkState};
use rusqlite::OptionalExtension;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::process::Command;

pub const SDK_PACKAGES: [(&str, &str); 3] = [
    ("claude", "@anthropic-ai/claude-code"),
    ("codex", "@openai/codex"),
    ("grok", "@xai-official/grok"),
];

fn spawn_cmd(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

/// 任务注册表（进程内）。sdkId -> 运行中任务（单 CLI 同时只允许一个非终态任务）。
#[derive(Clone)]
struct JobEntry {
    job: Arc<Mutex<SdkJob>>,
    abort: Arc<tokio::sync::watch::Sender<bool>>,
}

static JOBS: Mutex<BTreeMap<String, JobEntry>> = Mutex::new(BTreeMap::new());
static RUNNING_BY_SDK: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

fn job_log(job: &Arc<Mutex<SdkJob>>, line: String) {
    let mut j = job.lock().unwrap();
    if j.logs.len() > 800 {
        j.logs.remove(0);
    }
    j.logs.push(line.chars().take(4000).collect());
    j.updated_at = now_ms();
}

fn seed_sdk_rows() -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    for (id, pkg) in SDK_PACKAGES.iter() {
        conn.execute(
            "INSERT OR IGNORE INTO cli_sdk (id, package, enabled, installState, updatedAt) VALUES (?1,?2,1,'unknown',?3)",
            rusqlite::params![id, pkg, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启动时播种 SDK 行（lib.rs setup 调用）。
pub fn seed_sdk_rows_pub() -> Result<(), String> {
    seed_sdk_rows()
}

/// 冒烟模式：SMOKE_MOCKBIN 下钉扎的 mock CLI（优先于真实检测，保证会话链路确定性）。
fn smoke_mock_path(id: &str) -> Option<String> {
    let dir = std::env::var_os("SMOKE_MOCKBIN")?;
    let p = std::path::Path::new(&dir).join(format!("{}.exe", id));
    if p.is_file() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 检测单个 CLI：冒烟模式优先 mock 钉扎；否则优先 npm 全局列表，再兜底 `--version`。
async fn detect_one(id: &str) -> SdkState {
    if let Some(mp) = smoke_mock_path(id) {
        return SdkState {
            enabled: true,
            id: id.to_string(),
            install_state: "installed".into(),
            package: SDK_PACKAGES.iter().find(|(i, _)| *i == id).map(|(_, p)| p.to_string()).unwrap_or_default(),
            path: Some(mp),
            version: Some("9.9.9-mock".into()),
        };
    }
    let pkg = SDK_PACKAGES.iter().find(|(i, _)| *i == id).map(|(_, p)| p.to_string()).unwrap_or_default();
    let mut state = SdkState {
        enabled: true,
        id: id.to_string(),
        install_state: "not-installed".into(),
        package: pkg,
        path: None,
        version: None,
    };
    // npm ls -g --depth=0 --json
    let mut cmd = Command::new(crate::util::resolve_command("npm"));
    cmd.args(["ls", "-g", "--depth=0", "--json"]);
    spawn_cmd(&mut cmd);
    if let Ok(out) = cmd.output().await {
        if out.status.success() {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                if let Some(deps) = v.get("dependencies").and_then(|d| d.as_object()) {
                    let pkg_name = &state.package;
                    if let Some(info) = deps.get(pkg_name) {
                        state.install_state = "installed".into();
                        state.version = info.get("version").and_then(|x| x.as_str()).map(|s| s.to_string());
                        if let Some(bin) = info.get("path").and_then(|x| x.as_str()) {
                            state.path = Some(bin.to_string());
                        }
                    }
                }
            }
        }
    }
    // 登记 PATH 解析出的可执行路径（供会话适配器直接使用）
    if state.install_state == "installed" {
        state.path = Some(crate::util::resolve_command(id));
    }
    // 兜底：直接 --version
    if state.install_state != "installed" {
        let mut cmd = Command::new(crate::util::resolve_command(id));
        cmd.arg("--version");
        spawn_cmd(&mut cmd);
        if let Ok(out) = cmd.output().await {
            if out.status.success() {
                let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !ver.is_empty() {
                    state.install_state = "installed".into();
                    state.version = Some(ver.lines().next().unwrap_or("").trim().to_string());
                }
            }
        }
    }
    state
}

#[tauri::command]
pub async fn sdk_list() -> Result<Vec<SdkState>, String> {
    seed_sdk_rows()?;
    let mut out = Vec::new();
    for (id, _) in SDK_PACKAGES.iter() {
        let mut st = detect_one(id).await;
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        persist_detection(conn, &mut st)?;
        out.push(st);
    }
    Ok(out)
}

fn persist_detection(conn: &rusqlite::Connection, state: &mut SdkState) -> Result<(), String> {
    conn.execute(
        "UPDATE cli_sdk SET installState=?2, version=?3, path=?4, updatedAt=?5 WHERE id=?1",
        rusqlite::params![state.id, state.install_state, state.version, state.path, now_ms()],
    ).map_err(|e| e.to_string())?;
    // 检测只更新安装事实，启停始终使用当前持久化值（避免异步检测覆盖用户开关）。
    state.enabled = conn.query_row("SELECT enabled FROM cli_sdk WHERE id=?1", [&state.id], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())? != 0;
    Ok(())
}

fn npm_registry() -> Result<Option<String>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let value: Option<String> = conn.query_row(
        "SELECT value FROM setting_default WHERE scope='global' AND key='npmRegistry'", [], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?.flatten();
    Ok(value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

fn apply_registry(command: &mut Command, registry: Option<&str>) {
    if let Some(registry) = registry { command.arg("--registry").arg(registry); }
}

/// 安装/卸载任务启动；返回 jobId，进度用 sdk_job 轮询。
#[tauri::command]
pub async fn sdk_run_job(sdk_id: String, kind: String, version: Option<String>) -> Result<String, String> {
    seed_sdk_rows()?;
    let pkg = SDK_PACKAGES
        .iter()
        .find(|(i, _)| *i == sdk_id.as_str())
        .map(|(_, p)| p.to_string())
        .ok_or_else(|| format!("未知 SDK：{}", sdk_id))?;
    if kind != "install" && kind != "uninstall" {
        return Err("任务类型必须是 install 或 uninstall".into());
    }
    // 冒烟模式禁止真实卸载（防止破坏用户已安装的 CLI）
    if kind == "uninstall" && std::env::var("SMOKE_MOCKBIN").is_ok() {
        return Err("冒烟模式禁止真实卸载".into());
    }
    {
        let running = RUNNING_BY_SDK.lock().unwrap();
        if running.contains_key(&sdk_id) {
            return Err("该 SDK 已有进行中的任务".into());
        }
    }
    let job_id = new_id("npm");
    let job = Arc::new(Mutex::new(SdkJob {
        created_at: now_ms(),
        error: None,
        id: job_id.clone(),
        kind: kind.clone(),
        logs: vec![],
        phase: "queued".into(),
        sdk_id: sdk_id.clone(),
        updated_at: now_ms(),
    }));
    let (abort_tx, mut abort_rx) = tokio::sync::watch::channel(false);
    JOBS.lock().unwrap().insert(
        job_id.clone(),
        JobEntry { abort: Arc::new(abort_tx), job: job.clone() },
    );
    RUNNING_BY_SDK.lock().unwrap().insert(sdk_id.clone(), job_id.clone());
    let job_id_task = job_id.clone();

    // 注册表（与版本查询复用同一持久化源）。
    let registry = npm_registry()?;

    let spec = match (&kind[..], &version) {
        ("install", Some(v)) if !v.is_empty() => format!("{}@{}", pkg, v),
        _ => pkg.clone(),
    };
    let mut args: Vec<String> = if kind == "install" {
        vec!["install".into(), "-g".into(), spec]
    } else {
        vec!["uninstall".into(), "-g".into(), pkg.clone()]
    };
    if let Some(reg) = &registry {
        if !reg.is_empty() {
            args.push("--registry".into());
            args.push(reg.clone());
        }
    }

    tokio::spawn(async move {
        {
            let mut j = job.lock().unwrap();
            j.phase = "running".into();
            j.updated_at = now_ms();
        }
        job_log(&job, format!("$ npm {}", args.join(" ")));
        let mut cmd = Command::new(crate::util::resolve_command("npm"));
        cmd.args(&args);
        spawn_cmd(&mut cmd);
        // 以 kill_on_drop + abort watch 实现取消
        let mut child = match cmd.kill_on_drop(true).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
            Ok(c) => c,
                Err(e) => {
                    let mut j = job.lock().unwrap();
                    j.phase = "failed".into();
                    j.error = Some(format!("npm 启动失败：{}", e));
                    cleanup(&sdk_id, &job_id_task);
                    return;
                }
        };
        // npm 不读 stdin：立即关闭写端（take+drop，避免子进程等待 EOF）
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.flush().await;
            drop(stdin);
        }
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let j1 = job.clone();
        let j2 = job.clone();
        let t1 = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 4096];
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                job_log(&j1, String::from_utf8_lossy(&buf[..n]).trim().to_string());
            }
        });
        let t2 = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                job_log(&j2, String::from_utf8_lossy(&buf[..n]).trim().to_string());
            }
        });
        loop {
            tokio::select! {
                st = child.wait() => {
                    let _ = t1.await; let _ = t2.await;
                    match st {
                        Ok(s) if s.success() => {
                            let mut j = job.lock().unwrap();
                            j.phase = "done".into();
                            j.updated_at = now_ms();
                        }
                        Ok(s) => {
                            let mut j = job.lock().unwrap();
                            if abort_rx.has_changed().unwrap_or(false) {
                                j.phase = "cancelled".into();
                            } else {
                                j.phase = "failed".into();
                                j.error = Some(format!("npm 退出码：{}", s.code().unwrap_or(-1)));
                            }
                            j.updated_at = now_ms();
                        }
                        Err(e) => {
                            let mut j = job.lock().unwrap();
                            j.phase = "failed".into();
                            j.error = Some(e.to_string());
                            j.updated_at = now_ms();
                        }
                    }
                    break;
                }
                _ = abort_rx.changed() => {
                    let _ = child.kill().await;
                }
            }
        }
        cleanup(&sdk_id, &job_id_task);
    });

    Ok(job_id)
}

fn cleanup(sdk_id: &str, job_id: &str) {
    RUNNING_BY_SDK.lock().unwrap().remove(sdk_id);
    // 保留最近 60 个终态任务
    let mut jobs = JOBS.lock().unwrap();
    if jobs.len() > 80 {
        let remove: Vec<String> = jobs
            .keys()
            .take(jobs.len() - 60)
            .cloned()
            .collect();
        for k in remove {
            jobs.remove(&k);
        }
    }
    let _ = job_id;
}

#[tauri::command]
pub async fn sdk_job(job_id: String) -> Result<Option<SdkJob>, String> {
    let entry = JOBS.lock().unwrap().get(&job_id).cloned();
    match entry {
        Some(e) => {
            let j = e.job.lock().unwrap().clone();
            Ok(Some(j))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn sdk_cancel(job_id: String) -> Result<(), String> {
    let entry = JOBS.lock().unwrap().get(&job_id).cloned();
    if let Some(e) = entry {
        let _ = e.abort.send(true);
    }
    Ok(())
}

/// 可用版本列表（npm view，只留正式版，最多 30 条）。
#[tauri::command]
pub async fn sdk_versions(sdk_id: String) -> Result<Vec<String>, String> {
    let pkg = SDK_PACKAGES
        .iter()
        .find(|(i, _)| *i == sdk_id.as_str())
        .map(|(_, p)| p.to_string())
        .ok_or_else(|| format!("未知 SDK：{}", sdk_id))?;
    let mut cmd = Command::new(crate::util::resolve_command("npm"));
    cmd.arg("view").arg(&pkg).args(["versions", "--json"]);
    apply_registry(&mut cmd, npm_registry()?.as_deref());
    spawn_cmd(&mut cmd);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let versions: Vec<String> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| !s.contains('-'))
                .rev()
                .take(30)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    Ok(versions)
}

#[tauri::command]
pub fn sdk_set_enabled(sdk_id: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "UPDATE cli_sdk SET enabled=?2, updatedAt=?3 WHERE id=?1",
        rusqlite::params![sdk_id, enabled as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 会话 CLI 候选：只列已安装且启用的 CLI（CR-012）。
#[tauri::command]
pub fn sdk_cli_candidates() -> Result<Vec<SdkState>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, package, enabled, installState, version, path FROM cli_sdk WHERE enabled=1 AND installState='installed'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SdkState {
                enabled: r.get::<_, i64>(2)? != 0,
                id: r.get(0)?,
                install_state: r.get(3)?,
                package: r.get(1)?,
                path: r.get(5)?,
                version: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_preserves_persisted_disabled_state_in_db_and_response() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE cli_sdk(id TEXT PRIMARY KEY,enabled INTEGER,installState TEXT,version TEXT,path TEXT,updatedAt INTEGER);
            INSERT INTO cli_sdk VALUES('claude',0,'unknown',NULL,NULL,1);").unwrap();
        let mut state = SdkState { id: "claude".into(), package: "test".into(), enabled: true,
            install_state: "installed".into(), version: Some("test-version".into()), path: None };
        persist_detection(&conn, &mut state).unwrap();
        assert!(!state.enabled);
        assert_eq!(conn.query_row("SELECT enabled FROM cli_sdk", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        conn.execute("UPDATE cli_sdk SET enabled=1", []).unwrap();
        persist_detection(&conn, &mut state).unwrap();
        assert!(state.enabled);
    }

    #[test]
    fn versions_registry_is_single_literal_argument() {
        let mut command = Command::new("npm");
        apply_registry(&mut command, Some("https://registry.example.test"));
        let args: Vec<_> = command.as_std().get_args().map(|s| s.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["--registry", "https://registry.example.test"]);
    }
}
