//! 服务器管理命令：主机 CRUD、连接、终端、SFTP 文件树、监控采样、受限命令审批。

use crate::db;
use crate::models::{FileNode, HostMetrics, ServerHost, TermEvent, now_ms, new_id};
use crate::ssh;
use rusqlite::{params, OptionalExtension};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// 受管密钥存储（服务器密码/密钥口令），与 providers 同一文件约定但独立键空间。
fn secrets_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let _ = app;
    secrets_file_at(&crate::storage_layout::category("secrets")?)
}

/// CR-059：数据根参数版（内置 AI 工具 save_server 复用同一受管密钥文件）。
/// dir 是统一数据根；密钥文件固定在其 secrets 分类下。
pub(crate) fn secrets_file_at(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let secrets_dir = dir.join("secrets");
    std::fs::create_dir_all(&secrets_dir).map_err(|e| e.to_string())?;
    Ok(secrets_dir.join("server-secrets.json"))
}

fn secrets_read(app: &tauri::AppHandle) -> BTreeMap<String, String> {
    secrets_read_at(&secrets_file(app).unwrap_or_default())
}

fn secrets_read_at(file: &std::path::Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn secrets_write(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    secrets_write_at(&secrets_file(app)?, map)
}

fn secrets_write_at(file: &std::path::Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::write(file, serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?)
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
    /// 测试连接得到的系统名（可选）；UPDATE 时用 COALESCE 保留既有值。
    pub os: Option<String>,
}

#[tauri::command]
pub fn server_list(app: tauri::AppHandle) -> Result<Vec<ServerHost>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, host, port, username, authType, groupTag, os, lastSeenAt, cpuPct, memPct, diskPct FROM server_host ORDER BY createdAt")
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
                os: r.get(7)?,
                last_seen_at: r.get(8)?,
                cpu_pct: r.get(9)?,
                mem_pct: r.get(10)?,
                disk_pct: r.get(11)?,
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
pub fn server_save(_app: tauri::AppHandle, draft: HostDraft) -> Result<String, String> {
    let dir = crate::storage_layout::root().map_err(|e| e.to_string())?;
    server_save_at(&dir, draft)
}

/// CR-059：数据目录参数版，供内置 AI 工具 save_server 复用（校验与密钥写入语义完全一致）。
pub(crate) fn server_save_at(data_dir: &std::path::Path, draft: HostDraft) -> Result<String, String> {
    if draft.name.trim().is_empty() || draft.host.trim().is_empty() || draft.username.trim().is_empty() {
        return Err("名称、主机地址、用户名不能为空".into());
    }
    if !(1..=65535).contains(&draft.port) {
        return Err("端口必须在 1–65535 范围内".into());
    }
    if !matches!(draft.auth_type.as_str(), "password" | "key" | "none") {
        return Err("认证类型必须是 password、key 或 none".into());
    }
    let secrets_path = secrets_file_at(data_dir)?;
    let existing_secrets = secrets_read_at(&secrets_path);
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
            "UPDATE server_host SET name=?2, host=?3, port=?4, username=?5, authType=?6, groupTag=?7, os=COALESCE(?8, os) WHERE id=?1",
            params![id, draft.name.trim(), draft.host.trim(), draft.port, draft.username.trim(), draft.auth_type, draft.group_tag, draft.os],
        ).map_err(|error| error.to_string())?;
    } else {
        // 新主机：把测试连接得到的系统名一并写入（未提供时为 NULL），避免再次保存才落库。
        transaction.execute(
            "INSERT INTO server_host (id, name, host, port, username, authType, secretRef, groupTag, os, createdAt) VALUES (?1,?2,?3,?4,?5,?6,?1,?7,?8,?9)",
            params![id, draft.name.trim(), draft.host.trim(), draft.port, draft.username.trim(), draft.auth_type, draft.group_tag, draft.os, now_ms()],
        ).map_err(|error| error.to_string())?;
    }
    secrets_write_at(&secrets_path, &next_secrets)?;
    if let Err(error) = transaction.commit() {
        let _ = secrets_write_at(&secrets_path, &existing_secrets);
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

/// 测试连接的表单草稿：可不保存直接验证；`id` 仅用于读取已保存凭据。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestDraft {
    pub id: Option<String>,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub secret: Option<String>,
    pub key_path: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub os: String,
    pub latency_ms: i64,
}

/// 一次性连接测试：绝不改变主机连接状态、不写数据库、不写受管密钥、不进入连接管理器。
#[tauri::command]
pub async fn server_test_connection(app: tauri::AppHandle, draft: TestDraft) -> Result<TestResult, String> {
    let host = draft.host.trim().to_string();
    let username = draft.username.trim().to_string();
    if host.is_empty() {
        return Err("主机地址不能为空".into());
    }
    if username.is_empty() {
        return Err("用户名不能为空".into());
    }
    if !(1..=65535).contains(&draft.port) {
        return Err("端口必须在 1–65535 范围内".into());
    }
    if !matches!(draft.auth_type.as_str(), "password" | "key" | "none") {
        return Err("认证类型必须是 password、key 或 none".into());
    }

    let supplied_secret = draft.secret.as_deref().filter(|secret| !secret.is_empty());
    let supplied_key = draft.key_path.as_deref().filter(|path| !path.trim().is_empty());
    let auth = if draft.auth_type == "none" {
        HostAuth::None
    } else if draft.auth_type == "key" && supplied_key.is_some() {
        // 本次提交了私钥路径：口令沿用提交的 secret（可为空）。
        HostAuth::Key {
            key_path: supplied_key.unwrap_or_default().trim().to_string(),
            passphrase: supplied_secret.map(str::to_string),
        }
    } else if draft.auth_type == "password" && supplied_secret.is_some() {
        HostAuth::Password { password: supplied_secret.unwrap_or_default().to_string() }
    } else if let Some(id) = draft.id.as_deref().filter(|id| !id.is_empty()) {
        // 表单留空则回落到已保存凭据（只读，不写回）。
        let saved = find_host(&app, id)?;
        // 防误发：目标改了却留空凭据时，不能把已保存凭据发往新地址/新用户。
        if saved.host.trim() != host || saved.port != draft.port || saved.username.trim() != username {
            return Err(if draft.auth_type == "key" {
                "地址或用户名已修改，请重新填写私钥路径"
            } else {
                "地址或用户名已修改，请重新填写密码"
            }
            .into());
        }
        host_auth(&app, &saved)?
    } else if draft.auth_type == "key" {
        return Err("请填写私钥路径".into());
    } else {
        return Err("请填写密码".into());
    };

    let (os, latency_ms) = ssh::test_connect(&host, draft.port as u16, &username, &auth).await?;
    Ok(TestResult { os, latency_ms })
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

/// CR-059 / BUG-CR059-01：内置 AI 工具（stdio 进程）与主应用共用同一套风险分类。
pub(crate) fn classify_command_risk(command: &str) -> &'static str {
    classify_risk(command)
}

// ---------- CR-059 / BUG-CR059-01 二期：跨进程待审批命令 ----------

/// 审批有效期（与进程内 PENDING 一致：10 分钟）。
pub(crate) const APPROVAL_TTL_MS: i64 = 10 * 60 * 1000;

/// 由 stdio 工具进程调用：把高风险命令登记为待审批（不执行）。
/// 返回 requestId，主应用轮询 `tool_approval` 后弹出审批卡片。
pub(crate) fn submit_tool_approval(host_id: &str, command: &str) -> Result<String, String> {
    let request_id = new_id("appr");
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT INTO tool_approval (id, hostId, command, risk, status, origin, createdAt) VALUES (?1,?2,?3,'high','pending','builtin-tool',?4)",
        params![request_id, host_id, command, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(request_id)
}

/// 由 stdio 工具进程调用：读取某个审批请求的当前结论。
/// 返回 pending / approved / rejected / expired；不存在返回 missing。
pub(crate) fn tool_approval_status(request_id: &str) -> Result<String, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let row: Option<(String, i64)> = conn
        .query_row("SELECT status, createdAt FROM tool_approval WHERE id=?1", [request_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, created)) = row else { return Ok("missing".into()); };
    if status == "pending" && now_ms() - created > APPROVAL_TTL_MS {
        let _ = conn.execute("UPDATE tool_approval SET status='expired', decidedAt=?2 WHERE id=?1 AND status='pending'", params![request_id, now_ms()]);
        return Ok("expired".into());
    }
    Ok(status)
}

/// 读取已批准请求的执行结果（note 存 JSON 字符串；无结果返回 None）。
pub(crate) fn tool_approval_note(request_id: &str) -> Result<Option<String>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.query_row("SELECT note FROM tool_approval WHERE id=?1", [request_id], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map_err(|e| e.to_string())
        .map(Option::flatten)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub host_id: String,
    pub host_name: Option<String>,
    pub command: String,
    pub risk: String,
    pub created_at: i64,
}

/// 主应用轮询：列出仍在有效期内的待审批命令（顺带把过期项标记掉）。
#[tauri::command]
pub fn server_pending_approvals() -> Result<Vec<PendingApproval>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let cutoff = now_ms() - APPROVAL_TTL_MS;
    conn.execute("UPDATE tool_approval SET status='expired', decidedAt=?1 WHERE status='pending' AND createdAt<?2", params![now_ms(), cutoff])
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.hostId, h.name, a.command, a.risk, a.createdAt
             FROM tool_approval a LEFT JOIN server_host h ON h.id=a.hostId
             WHERE a.status='pending' ORDER BY a.createdAt DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PendingApproval {
                id: r.get(0)?,
                host_id: r.get(1)?,
                host_name: r.get(2)?,
                command: r.get(3)?,
                risk: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// 主应用：用户批准或拒绝某条待审批命令。
/// 批准时执行命令并把输出同时写回 note 供工具进程读取（工具进程不自己执行，避免二次执行）。
#[tauri::command]
pub async fn server_decide_approval(
    app: tauri::AppHandle,
    request_id: String,
    decision: String,
) -> Result<serde_json::Value, String> {
    if decision != "approve" && decision != "reject" {
        return Err("decision 必须是 approve 或 reject".into());
    }
    let (host_id, command, status) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let row: Option<(String, String, String, i64)> = conn
            .query_row("SELECT hostId, command, status, createdAt FROM tool_approval WHERE id=?1", [&request_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((host_id, command, status, created)) = row else { return Err("审批请求不存在".into()); };
        if status != "pending" {
            return Err(format!("该请求已是 {status} 状态，不能再次处理"));
        }
        if now_ms() - created > APPROVAL_TTL_MS {
            conn.execute("UPDATE tool_approval SET status='expired', decidedAt=?2 WHERE id=?1", params![request_id, now_ms()])
                .map_err(|e| e.to_string())?;
            return Err("审批请求已过期，请重新发起".into());
        }
        (host_id, command, status)
    };
    let _ = status;

    if decision == "reject" {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute("UPDATE tool_approval SET status='rejected', decidedAt=?2, note=?3 WHERE id=?1",
            params![request_id, now_ms(), "用户拒绝执行"]).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({ "status": "rejected" }));
    }

    // 批准：先在主应用侧执行，再把结果写回 note；工具进程只读结论，不重复执行。
    let outcome = exec_inner(&app, &host_id, &command).await;
    let (status, note) = match outcome {
        Ok((output, code)) => {
            let payload = serde_json::json!({ "exitCode": code, "output": output });
            ("approved".to_string(), payload.to_string())
        }
        Err(error) => ("approved".to_string(), serde_json::json!({ "error": error }).to_string()),
    };
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute("UPDATE tool_approval SET status=?2, decidedAt=?3, note=?4 WHERE id=?1",
            params![request_id, status, now_ms(), note]).map_err(|e| e.to_string())?;
    }
    Ok(serde_json::json!({ "status": "approved", "executed": true, "result": serde_json::from_str::<serde_json::Value>(&note).unwrap_or(serde_json::Value::Null) }))
}

/// 同步执行一条已通过风险分类的命令（内置 AI 工具在 stdio 进程内调用）。
///
/// stdio 进程没有 Tauri AppHandle；这里用共享 SQLite 读出主机信息并复用进程内的 SSH 连接表。
/// 与 GUI 路径 `server_exec` 使用同一 `ssh::exec_command`，不扩大任何权限。
pub(crate) fn exec_ai_command_blocking(
    host_id: &str,
    command: &str,
) -> Result<(String, i32), String> {
    let (host, port, username) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row(
            "SELECT host, port, username FROM server_host WHERE id=?1",
            [host_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
        )
        .map_err(|_| format!("主机不存在：{host_id}"))?
    };
    let conn = ssh::get_connection(&username, &host, port as u16)
        .ok_or("主机未连接：请先在服务器工作台建立连接后再试")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("无法创建执行运行时：{e}"))?;
    runtime.block_on(ssh::exec_command(&conn, command, 30))
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
    let cmd = "echo '@@STAT'; grep '^cpu' /proc/stat; echo '@@MEM'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo '@@LOAD'; cat /proc/loadavg; echo '@@UP'; cut -d' ' -f1 /proc/uptime; echo '@@HOST'; cat /proc/sys/kernel/hostname; echo '@@OS'; (cat /etc/os-release 2>/dev/null | grep -E '^PRETTY_NAME=' || uname -s); echo '@@DISK'; df -kP / 2>/dev/null | tail -n 1";
    let (out, _) = ssh::exec_command(&conn, cmd, 10).await?;
    let metrics = parse_metrics(&out)?;
    // CR-072：采样成功后写回列表缓存（本地记录），供 server_list 直接展示；不改连接/审批语义。
    let mem_pct = if metrics.mem_total_mb > 0 { Some(metrics.mem_used_mb as f64 / metrics.mem_total_mb as f64 * 100.0) } else { None };
    let disk_pct = if metrics.disk_total_mb > 0 { Some(metrics.disk_used_mb as f64 / metrics.disk_total_mb as f64 * 100.0) } else { None };
    if let Ok(guard) = db::conn() {
        if let Some(c) = guard.as_ref() {
            let _ = c.execute(
                "UPDATE server_host SET os=?2, lastSeenAt=?3, cpuPct=?4, memPct=?5, diskPct=?6 WHERE id=?1",
                rusqlite::params![host_id, metrics.os.clone(), now_ms(), metrics.cpu_avg, mem_pct, disk_pct],
            );
        }
    }
    Ok(metrics)
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
    let mut disk_total_mb = 0i64;
    let mut disk_used_mb = 0i64;

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
                "DISK" => "disk",
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
            "disk" => {
                let f: Vec<&str> = t.split_whitespace().collect();
                if f.len() >= 3 {
                    if let (Ok(tot), Ok(used)) = (f[1].parse::<i64>(), f[2].parse::<i64>()) {
                        disk_total_mb = tot / 1024;
                        disk_used_mb = used / 1024;
                    }
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
        disk_total_mb,
        disk_used_mb,
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

#[cfg(test)]
mod approval_tests {
    use super::*;

    fn memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE server_host (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL, authType TEXT NOT NULL DEFAULT 'password', secretRef TEXT, groupTag TEXT, createdAt INTEGER NOT NULL);
             CREATE TABLE tool_approval (id TEXT PRIMARY KEY, hostId TEXT NOT NULL, command TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'high',
                status TEXT NOT NULL DEFAULT 'pending', origin TEXT NOT NULL DEFAULT 'builtin-tool', createdAt INTEGER NOT NULL,
                decidedAt INTEGER, note TEXT);",
        ).unwrap();
        conn
    }

    /// CR-059 二期：跨进程审批的状态机——pending 有效、超时判 expired、拒绝与批准终态不可再改。
    #[test]
    fn approval_state_machine_expires_and_is_terminal() {
        let conn = memory_db();
        let now = now_ms();
        conn.execute("INSERT INTO tool_approval (id,hostId,command,createdAt) VALUES ('a1','h1','rm -rf /tmp/x',?1)", [now]).unwrap();
        conn.execute("INSERT INTO tool_approval (id,hostId,command,createdAt) VALUES ('old','h1','reboot',?1)", [now - APPROVAL_TTL_MS - 1]).unwrap();

        // 过期项：查询时被标成 expired，不返回给界面。
        let cutoff = now - APPROVAL_TTL_MS;
        conn.execute("UPDATE tool_approval SET status='expired', decidedAt=?1 WHERE status='pending' AND createdAt<?2", rusqlite::params![now, cutoff]).unwrap();
        let pending: Vec<String> = conn
            .prepare("SELECT id FROM tool_approval WHERE status='pending'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(pending, vec!["a1".to_string()], "过期请求不应留在待审批列表");

        // 拒绝是终态：再次更新不应把它改回 pending/approved。
        conn.execute("UPDATE tool_approval SET status='rejected', decidedAt=?1 WHERE id='a1' AND status='pending'", rusqlite::params![now_ms()]).unwrap();
        let changed = conn.execute("UPDATE tool_approval SET status='approved' WHERE id='a1' AND status='pending'", []).unwrap();
        assert_eq!(changed, 0, "已决定的请求不能再被批准");
        assert_eq!(conn.query_row("SELECT status FROM tool_approval WHERE id='a1'", [], |r| r.get::<_, String>(0)).unwrap(), "rejected");
    }

    /// 高风险分类必须是纯函数可测的：AI 工具与 GUI 走同一条判定。
    #[test]
    fn risk_classification_is_shared_and_case_insensitive() {
        assert_eq!(classify_command_risk("RM -RF /var/data"), "high");
        assert_eq!(classify_command_risk("systemctl status nginx"), "normal");
        assert_eq!(classify_command_risk("truncate table orders"), "high");
    }
}
