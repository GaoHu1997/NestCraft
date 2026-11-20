//! 服务器管理命令：主机 CRUD、连接、终端、SFTP 文件树、监控采样、受限命令审批。

use crate::db;
use tauri::Manager;
use crate::models::{FileNode, HostMetrics, ServerHost, TermEvent, now_ms, new_id};
use crate::ssh;
use rusqlite::params;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// 受管密钥存储（服务器密码/密钥口令），与 providers 同一文件约定但独立键空间。
fn secrets_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server-secrets.json"))
}

fn secrets_read(app: &tauri::AppHandle) -> BTreeMap<String, String> {
    std::fs::read_to_string(secrets_file(app).unwrap_or_default())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn secrets_write(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::write(secrets_file(app)?, serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDraft {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String, // password | key
    pub secret: Option<String>,     // 密码，或密钥文件口令
    pub key_path: Option<String>,   // authType=key 时的私钥路径
    pub group_tag: Option<String>,
}

#[tauri::command]
pub fn server_list(app: tauri::AppHandle) -> Result<Vec<ServerHost>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, host, port, username, authType, groupTag FROM server_host ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let mut out: Vec<ServerHost> = stmt
        .query_map([], |r| {
            Ok(ServerHost {
                auth_type: r.get(5)?,
                connected: false,
                group_tag: r.get(6)?,
                host: r.get(2)?,
                id: r.get(0)?,
                name: r.get(1)?,
                port: r.get(3)?,
                username: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for h in out.iter_mut() {
        h.connected = ssh::is_connected(&h.id);
    }
    Ok(out)
}

#[tauri::command]
pub fn server_save(app: tauri::AppHandle, draft: HostDraft) -> Result<String, String> {
    if draft.name.trim().is_empty() || draft.host.trim().is_empty() || draft.username.trim().is_empty() {
        return Err("名称、主机地址、用户名不能为空".into());
    }
    if !(1..=65535).contains(&draft.port) {
        return Err("端口必须在 1–65535 范围内".into());
    }
    if !matches!(draft.auth_type.as_str(), "password" | "key" | "none") {
        return Err("认证类型必须是 password、key 或 none".into());
    }
    let existing_secrets = secrets_read(&app);
    let id = draft.id.clone().unwrap_or_else(|| new_id("host"));
    let supplied_secret = draft.secret.as_ref().filter(|secret| !secret.is_empty());
    let supplied_key = draft.key_path.as_ref().filter(|path| !path.trim().is_empty());
    let old_auth = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        if draft.id.is_some() {
            Some(conn.query_row("SELECT authType FROM server_host WHERE id=?1", [&id], |row| row.get::<_, String>(0))
                .map_err(|_| "主机不存在或已删除".to_string())?)
        } else {
            None
        }
    };
    let same_auth = old_auth.as_deref() == Some(draft.auth_type.as_str());
    if draft.auth_type == "password" && supplied_secret.is_none()
        && (!same_auth || existing_secrets.get(&id).map(String::is_empty).unwrap_or(true)) {
        return Err("密码认证必须填写密码；编辑时留空只能保留既有密码".into());
    }
    if draft.auth_type == "key" && supplied_key.is_none()
        && (!same_auth || existing_secrets.get(&format!("{}:keypath", id)).map(String::is_empty).unwrap_or(true)) {
        return Err("密钥认证必须填写私钥路径；编辑时留空只能保留既有私钥".into());
    }
    let mut next_secrets = existing_secrets.clone();
    if let Some(secret) = supplied_secret { next_secrets.insert(id.clone(), secret.clone()); }
    if let Some(path) = supplied_key { next_secrets.insert(format!("{}:keypath", id), path.clone()); }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    if draft.id.is_some() {
        transaction.execute(
            "UPDATE server_host SET name=?2, host=?3, port=?4, username=?5, authType=?6, groupTag=?7 WHERE id=?1",
            params![id, draft.name.trim(), draft.host.trim(), draft.port, draft.username.trim(), draft.auth_type, draft.group_tag],
        ).map_err(|error| error.to_string())?;
    } else {
        transaction.execute(
            "INSERT INTO server_host (id, name, host, port, username, authType, secretRef, groupTag, createdAt) VALUES (?1,?2,?3,?4,?5,?6,?1,?7,?8)",
            params![id, draft.name.trim(), draft.host.trim(), draft.port, draft.username.trim(), draft.auth_type, draft.group_tag, now_ms()],
        ).map_err(|error| error.to_string())?;
    }
    secrets_write(&app, &next_secrets)?;
    if let Err(error) = transaction.commit() {
        let _ = secrets_write(&app, &existing_secrets);
        return Err(error.to_string());
    }
    Ok(id)
}

#[tauri::command]
pub fn server_delete(id: String) -> Result<(), String> {
    if ssh::is_connected(&id) {
        return Err("主机已连接，请先断开".into());
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM server_host WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone)]
pub enum HostAuth {
    Password { password: String },
    Key { key_path: String, passphrase: Option<String> },
    None,
}

fn host_auth(app: &tauri::AppHandle, host: &ServerHost) -> Result<HostAuth, String> {
    let secrets = secrets_read(app);
    if host.auth_type == "none" {
        return Ok(HostAuth::None);
    }
    if host.auth_type == "key" {
        let key_path = secrets.get(&format!("{}:keypath", host.id)).cloned().unwrap_or_default();
        if key_path.is_empty() {
            return Err("未配置私钥路径".into());
        }
        let passphrase = secrets.get(&host.id).cloned().filter(|s| !s.is_empty());
        Ok(HostAuth::Key { key_path, passphrase })
    } else {
        let password = secrets.get(&host.id).cloned().unwrap_or_default();
        Ok(HostAuth::Password { password })
    }
}

fn find_host(app: &tauri::AppHandle, host_id: &str) -> Result<ServerHost, String> {
    let hosts = server_list(app.clone())?;
    hosts.into_iter().find(|h| h.id == host_id).ok_or_else(|| "主机不存在".into())
}

#[tauri::command]
pub async fn server_connect(app: tauri::AppHandle, host_id: String) -> Result<(), String> {
    let host = find_host(&app, &host_id)?;
    if ssh::is_connected(&host_id) {
        return Ok(());
    }
    let auth = host_auth(&app, &host)?;
    ssh::connect(&host_id, &host.host, host.port as u16, &host.username, &auth).await
}

#[tauri::command]
pub async fn server_disconnect(app: tauri::AppHandle, host_id: String) -> Result<(), String> {
    let host = find_host(&app, &host_id)?;
    ssh::disconnect(&host_id, &host.username, &host.host, host.port as u16).await;
    Ok(())
}

#[tauri::command]
pub async fn server_term_open(
    app: tauri::AppHandle,
    host_id: String,
    cols: u32,
    rows: u32,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    let host = find_host(&app, &host_id)?;
    let conn = ssh::get_connection(&host.username, &host.host, host.port as u16).ok_or("主机未连接")?;
    let term_id = ssh::open_terminal(&conn, &host_id, cols.max(2), rows.max(2), move |data| {
        let _ = channel.send(serde_json::json!({ "type": "data", "data": data }));
    }, move |_tid| {
        // 退出事件由 closed 状态轮询观察；此处不再推送
    })
    .await?;
    Ok(term_id)
}

#[tauri::command]
pub async fn server_term_input(
    app: tauri::AppHandle,
    host_id: String,
    term_id: String,
    data: String,
) -> Result<(), String> {
    let host = find_host(&app, &host_id)?;
    ssh::term_write(&host.username, &host.host, host.port as u16, &term_id, &data).await
}

#[tauri::command]
pub async fn server_term_resize(
    app: tauri::AppHandle,
    host_id: String,
    term_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let host = find_host(&app, &host_id)?;
    ssh::term_resize(&host.username, &host.host, host.port as u16, &term_id, cols.max(2), rows.max(2)).await
}

#[tauri::command]
pub fn server_term_close(term_id: String) -> Result<(), String> {
    ssh::close_terminal(&term_id);
    Ok(())
}

#[tauri::command]
pub async fn server_tree(app: tauri::AppHandle, host_id: String, path: String) -> Result<Vec<FileNode>, String> {
    let host = find_host(&app, &host_id)?;
    let conn = ssh::get_connection(&host.username, &host.host, host.port as u16).ok_or("主机未连接")?;
    let entries = ssh::sftp_list(&conn, &path).await?;
    Ok(entries
        .into_iter()
        .map(|(name, is_dir, size)| FileNode {
            is_dir,
            name: name.clone(),
            path: if path.ends_with('/') { format!("{}{}", path, name) } else { format!("{}/{}", path, name) },
            size: Some(size),
        })
        .collect())
}

#[tauri::command]
pub async fn server_read_file(app: tauri::AppHandle, host_id: String, path: String) -> Result<String, String> {
    let host = find_host(&app, &host_id)?;
    let conn = ssh::get_connection(&host.username, &host.host, host.port as u16).ok_or("主机未连接")?;
    ssh::sftp_read(&conn, &path).await
}

// ---------- 受限命令执行与审批 ----------

static PENDING: Mutex<BTreeMap<String, (String, String, i64)>> = Mutex::new(BTreeMap::new()); // requestId -> (hostId, command, createdAt)

const RISK_PATTERNS: [&str; 14] = [
    "rm -rf", "rm -fr", "mkfs", "dd if=", "> /dev/sd", ":(){", "shutdown", "reboot", "halt",
    "chmod -r 777 /", "drop database", "truncate table", "nohup", "curl | sh",
];

fn classify_risk(command: &str) -> &'static str {
    let lower = command.to_lowercase();
    if RISK_PATTERNS.iter().any(|p| lower.contains(p)) {
        "high"
    } else {
        "normal"
    }
}

/// 执行命令；高风险返回 needsApproval，用户确认后用 server_exec_approved。
#[tauri::command]
pub async fn server_exec(
    app: tauri::AppHandle,
    host_id: String,
    command: String,
) -> Result<serde_json::Value, String> {
    let risk = classify_risk(&command);
    if risk == "high" {
        let request_id = new_id("appr");
        PENDING.lock().unwrap().insert(request_id.clone(), (host_id.clone(), command, now_ms()));
        return Ok(serde_json::json!({ "needsApproval": true, "requestId": request_id, "risk": "high" }));
    }
    let result = exec_inner(&app, &host_id, &command).await?;
    Ok(serde_json::json!({ "needsApproval": false, "exitCode": result.1, "output": result.0 }))
}

async fn exec_inner(app: &tauri::AppHandle, host_id: &str, command: &str) -> Result<(String, i32), String> {
    let host = find_host(app, host_id)?;
    let conn = ssh::get_connection(&host.username, &host.host, host.port as u16).ok_or("主机未连接")?;
    ssh::exec_command(&conn, command, 30).await
}

#[tauri::command]
pub async fn server_exec_approved(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<serde_json::Value, String> {
    let (host_id, command, created) = {
        let pending = PENDING.lock().unwrap();
        pending
            .get(&request_id)
            .cloned()
            .ok_or("审批请求不存在或已失效（重新发起即可）")?
    };
    // 审批 10 分钟有效；主机必须仍处于连接状态
    if now_ms() - created > 10 * 60 * 1000 {
        PENDING.lock().unwrap().remove(&request_id);
        return Err("审批请求已过期，请重新发起".into());
    }
    if !ssh::is_connected(&host_id) {
        PENDING.lock().unwrap().remove(&request_id);
        return Err("主机已断开，审批失效".into());
    }
    PENDING.lock().unwrap().remove(&request_id);
    let result = exec_inner(&app, &host_id, &command).await?;
    Ok(serde_json::json!({ "needsApproval": false, "exitCode": result.1, "output": result.0 }))
}

#[tauri::command]
pub fn server_exec_reject(request_id: String) -> Result<(), String> {
    PENDING.lock().unwrap().remove(&request_id);
    Ok(())
}

// ---------- 监控采样（/proc 读取，轮询模式） ----------

#[tauri::command]
pub async fn server_metrics(app: tauri::AppHandle, host_id: String) -> Result<HostMetrics, String> {
    let host = find_host(&app, &host_id)?;
    let conn = ssh::get_connection(&host.username, &host.host, host.port as u16).ok_or("主机未连接")?;
    // 用显式分隔标记采集，避免任一文件过长导致后续内容被截断
    let cmd = "echo '@@STAT'; grep '^cpu' /proc/stat; echo '@@MEM'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo '@@LOAD'; cat /proc/loadavg; echo '@@UP'; cut -d' ' -f1 /proc/uptime; echo '@@HOST'; cat /proc/sys/kernel/hostname; echo '@@OS'; (cat /etc/os-release 2>/dev/null | grep -E '^PRETTY_NAME=' || uname -s)";
    let (out, _) = ssh::exec_command(&conn, cmd, 10).await?;
    parse_metrics(&out)
}

fn parse_metrics(text: &str) -> Result<HostMetrics, String> {
    // 基于 @@SECTION 标记解析，各节独立，互不受长度影响
    let mut cpu_cores: Vec<f64> = Vec::new();
    let mut cpu_total_line: Vec<u64> = Vec::new();
    let mut mem_total_mb = 0i64;
    let mut mem_available_mb = 0i64;
    let mut load1 = 0f64;
    let mut uptime_secs = 0f64;
    let mut hostname = String::new();
    let mut os = String::new();

    let mut section = "";
    for raw in text.lines() {
        let line = raw.trim_end();
        if let Some(name) = line.strip_prefix("@@") {
            section = match name {
                "STAT" => "stat",
                "MEM" => "mem",
                "LOAD" => "load",
                "UP" => "up",
                "HOST" => "host",
                "OS" => "os",
                _ => "",
            };
            continue;
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        match section {
            "stat" => {
                if let Some(rest) = t.strip_prefix("cpu") {
                    let vals: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
                    if vals.len() < 4 {
                        continue;
                    }
                    let total: u64 = vals.iter().sum();
                    let idle = vals[3] + vals.get(4).copied().unwrap_or(0); // idle + iowait
                    let usage = if total > 0 {
                        ((total - idle) as f64 / total as f64) * 100.0
                    } else {
                        0.0
                    };
                    if t.starts_with("cpu ") {
                        cpu_total_line = vals;
                    } else {
                        cpu_cores.push((usage * 100.0).round() / 100.0);
                    }
                }
            }
            "mem" => {
                if let Some(v) = t.strip_prefix("MemTotal:") {
                    mem_total_mb = parse_kb_to_mb(v);
                } else if let Some(v) = t.strip_prefix("MemAvailable:") {
                    mem_available_mb = parse_kb_to_mb(v);
                }
            }
            "load" => {
                load1 = t.split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
            }
            "up" => {
                uptime_secs = t.split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
            }
            "host" => {
                if hostname.is_empty() {
                    hostname = t.to_string();
                }
            }
            "os" => {
                if let Some(v) = t.strip_prefix("PRETTY_NAME=") {
                    os = v.trim_matches('"').to_string();
                } else if os.is_empty() {
                    os = t.to_string();
                }
            }
            _ => {}
        }
    }

    let cpu_avg = if cpu_total_line.len() >= 4 {
        let total: u64 = cpu_total_line.iter().sum();
        let idle = cpu_total_line[3] + cpu_total_line.get(4).copied().unwrap_or(0);
        if total > 0 {
            ((total - idle) as f64 / total as f64 * 10000.0).round() / 100.0
        } else {
            0.0
        }
    } else if !cpu_cores.is_empty() {
        (cpu_cores.iter().sum::<f64>() / cpu_cores.len() as f64 * 100.0).round() / 100.0
    } else {
        0.0
    };

    if mem_total_mb == 0 && cpu_cores.is_empty() && hostname.is_empty() {
        return Err("未能解析 /proc 采样（远端可能非 Linux）".into());
    }

    Ok(HostMetrics {
        cpu_avg,
        cpu_cores,
        hostname,
        load1,
        mem_total_mb,
        mem_used_mb: (mem_total_mb - mem_available_mb).max(0),
        os: if os.is_empty() { "Linux（/proc 采样）".into() } else { os },
        uptime: format_uptime(uptime_secs),
    })
}

fn parse_kb_to_mb(v: &str) -> i64 {
    let num: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    num.parse::<i64>().unwrap_or(0) / 1024
}

fn format_uptime(secs: f64) -> String {
    if secs <= 0.0 {
        return "未知".into();
    }
    let d = (secs / 86400.0).floor() as i64;
    let h = ((secs % 86400.0) / 3600.0).floor() as i64;
    let m = ((secs % 3600.0) / 60.0).floor() as i64;
    if d > 0 {
        format!("{} 天 {} 小时", d, h)
    } else if h > 0 {
        format!("{} 小时 {} 分", h, m)
    } else {
        format!("{} 分钟", m)
    }
}

/// 服务器 AI 会话的 ssh-exec 工具入口（受授权与审批约束）。
#[tauri::command]
pub async fn server_ai_exec(
    app: tauri::AppHandle,
    host_id: String,
    command: String,
) -> Result<serde_json::Value, String> {
    // 与 server_exec 相同的风险路径
    server_exec(app, host_id, command).await
}

// 消除未使用导入告警
#[allow(unused)]
fn _t(_: TermEvent) {}
