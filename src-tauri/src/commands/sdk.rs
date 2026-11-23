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

/// 缓存快照（CR-059 D5/E4）：只读 DB 已持久化的检测结果，不 spawn 任何 npm 进程。
/// 首帧用它渲染上次缓存；随后由前端并发调用 `sdk_detect_one` 逐项刷新。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkSnapshot {
    pub states: Vec<SdkState>,
    /// 上次检测时间（毫秒时间戳）；unknown 表示从未成功检测。
    pub checked_at: i64,
}

pub(crate) const DETECT_TTL_MS: i64 = 10 * 60 * 1000;

#[tauri::command]
pub fn sdk_snapshot() -> Result<SdkSnapshot, String> {
    seed_sdk_rows()?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, package, enabled, installState, version, path, updatedAt FROM cli_sdk")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((SdkState {
                enabled: r.get::<_, i64>(2)? != 0,
                id: r.get(0)?,
                install_state: r.get(3)?,
                package: r.get(1)?,
                path: r.get(5)?,
                version: r.get(4)?,
            }, r.get::<_, i64>(6)?))
        })
        .map_err(|e| e.to_string())?;
    let mut states = Vec::new();
    let mut newest = 0i64;
    for row in rows {
        let (state, updated) = row.map_err(|e| e.to_string())?;
        newest = newest.max(updated);
        states.push(state);
    }
    Ok(SdkSnapshot { states, checked_at: newest })
}

/// 单项检测（CR-059 D5/E4）：并发调用、逐项上屏；`force=false` 且缓存新鲜时直接短路。
#[tauri::command]
pub async fn sdk_detect_one(sdk_id: String, force: bool) -> Result<SdkState, String> {
    seed_sdk_rows()?;
    if !SDK_PACKAGES.iter().any(|(id, _)| *id == sdk_id.as_str()) {
        return Err(format!("未知 SDK：{sdk_id}"));
    }
    if !force {
        let fresh = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            conn.query_row(
                "SELECT updatedAt FROM cli_sdk WHERE id=?1 AND installState != 'unknown'",
                [&sdk_id],
                |r| r.get::<_, i64>(0),
            )
            .ok()
            .filter(|at| now_ms() - at < DETECT_TTL_MS)
        };
        if let Some(at) = fresh {
            // 新鲜缓存：直接用持久化结果，不再 spawn npm/--version。
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let state = conn
                .query_row(
                    "SELECT id, package, enabled, installState, version, path FROM cli_sdk WHERE id=?1",
                    [&sdk_id],
                    |r| {
                        Ok(SdkState {
                            enabled: r.get::<_, i64>(2)? != 0,
                            id: r.get(0)?,
                            install_state: r.get(3)?,
                            package: r.get(1)?,
                            path: r.get(5)?,
                            version: r.get(4)?,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            let _ = at;
            return Ok(state);
        }
    }
    let mut st = detect_one(&sdk_id).await;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    persist_detection(conn, &mut st)?;
    Ok(st)
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

/// 可用版本列表（CR-059 E3/E4）：HTTP 直连 registry 读 dist-tags/versions，不 spawn npm。
///
/// - 列表＝最新 10 个稳定版（倒序，不含预发布）；
/// - 注册表地址来自 `npmRegistry` 设置，缺省 npmjs 官方；
/// - 网络失败返回明确错误，由前端显示「版本列表获取失败，点击刷新重试」。
#[tauri::command]
pub async fn sdk_versions(sdk_id: String) -> Result<Vec<String>, String> {
    let pkg = SDK_PACKAGES
        .iter()
        .find(|(i, _)| *i == sdk_id.as_str())
        .map(|(_, p)| p.to_string())
        .ok_or_else(|| format!("未知 SDK：{}", sdk_id))?;
    let registry = npm_registry()?
        .unwrap_or_else(|| "https://registry.npmjs.org".to_string());
    let base = registry.trim_end_matches('/');
    let encoded = pkg.replace('/', "%2F");
    let url = format!("{base}/{encoded}");
    let body = tokio::task::spawn_blocking(move || fetch_registry_json(&url))
        .await
        .map_err(|e| e.to_string())??;
    Ok(pick_stable_versions(&body, 10))
}

/// 同步拉取 registry 元数据（ureq 为阻塞实现，放到 blocking 线程执行）。
fn fetch_registry_json(url: &str) -> Result<serde_json::Value, String> {
    let response = ureq::get(url)
        .set("Accept", "application/vnd.npm.install-v1+json, application/json")
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("版本列表获取失败：{e}"))?;
    let text = response
        .into_string()
        .map_err(|e| format!("版本列表读取失败：{e}"))?;
    serde_json::from_str(&text).map_err(|_| "版本列表响应不是合法 JSON".to_string())
}

/// 从 registry 元数据里取最新 N 个稳定版本（按 semver 倒序）。
fn pick_stable_versions(meta: &serde_json::Value, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = meta
        .get("versions")
        .and_then(|v| v.as_object())
        .map(|versions| versions.keys().cloned().collect())
        .unwrap_or_default();
    out.retain(|v| !v.contains('-'));
    out.sort_by(|a, b| semver_cmp(a, b));
    out.reverse();
    out.truncate(limit);
    out
}

/// 极简 semver 比较（主.次.修订 + 可选 build 数字后缀），仅用于稳定版排序。
fn semver_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| -> Vec<i64> {
        v.split(['.', '+'])
            .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
            .map(|p| p.parse::<i64>().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
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

    #[test]
    fn stable_versions_pick_latest_ten_desc() {
        // CR-059 E3：只列稳定版、倒序、最多 10 条（跳过 alpha/beta/rc）。
        let meta = serde_json::json!({
            "versions": {
                "1.0.0": {}, "1.2.0": {}, "1.10.0": {}, "2.0.0": {},
                "2.1.0": {}, "2.2.0": {}, "2.3.0": {}, "2.4.0": {},
                "2.5.0": {}, "2.6.0": {}, "2.7.0": {}, "3.0.0-beta.1": {}
            }
        });
        let picked = pick_stable_versions(&meta, 10);
        assert_eq!(picked.len(), 10);
        assert_eq!(picked[0], "2.7.0", "最新稳定版应排首位");
        assert!(!picked.iter().any(|v| v.contains('-')), "预发布不应出现在列表");
        // semver 比较不按字典序：1.10.0 必须大于 1.2.0
        assert_eq!(semver_cmp("1.10.0", "1.2.0"), std::cmp::Ordering::Greater);
        assert_eq!(semver_cmp("2.0.0", "2.0.0"), std::cmp::Ordering::Equal);
    }
}
