//! Skill / MCP / Tool 能力注册（对照 skill/mcp 面板插件逻辑移植，全局统一管理）。
//!
//! - Skill：受管目录 app_data_dir/skills/<name>/SKILL.md，DB 存索引与启用状态
//! - MCP：DB 存服务器配置；tools 经最小 MCP 客户端（stdio/http JSON-RPC）发现
//! - Tool：内置只读工具注册表（含风险等级）

use crate::db;
use tauri::Manager;
use crate::models::{McpServer, McpToolInfo, SkillEntry, ToolEntry, now_ms, new_id};

// ---------- Skill ----------

#[tauri::command]
pub fn skill_list(app: tauri::AppHandle) -> Result<Vec<SkillEntry>, String> {
    let skills_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    // 目录扫描 + DB 状态
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for ent in std::fs::read_dir(&skills_dir).map_err(|e| e.to_string())?.flatten() {
        let path = ent.path();
        let skill_md = path.join("SKILL.md");
        if !path.is_dir() || !skill_md.exists() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let description = content
            .lines()
            .find(|l| l.starts_with("description:"))
            .map(|l| l.trim_start_matches("description:").trim().to_string());
        let source_ref = skill_md.to_string_lossy().to_string();
        let enabled: bool = conn
            .query_row(
                "SELECT enabled FROM capability WHERE kind='skill' AND name=?1",
                [&name],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(true);
        out.push(SkillEntry {
            builtin: false,
            description,
            enabled,
            id: format!("skill:{}", name),
            name,
            source_ref,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub content: String, // SKILL.md 正文
}

#[tauri::command]
pub fn skill_save(app: tauri::AppHandle, draft: SkillDraft) -> Result<(), String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("技能名称不能为空".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("技能名称只能包含字母、数字、连字符和下划线".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills").join(&name);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let skill_md = dir.join("SKILL.md");
    if skill_md.exists() {
        return Err("同名技能已存在".into());
    }
    let body = format!("# {}\n\ndescription: {}\n\n---\n\n{}", name, draft.description, draft.content);
    std::fs::write(&skill_md, body).map_err(|e| e.to_string())?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT OR IGNORE INTO capability (id, kind, name, description, sourceRef, risk, enabled, builtin, createdAt)
         VALUES (?1,'skill',?2,?3,?4,'low',1,0,?5)",
        rusqlite::params![new_id("cap"), name, draft.description, skill_md.to_string_lossy(), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skill_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills").join(&name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM capability WHERE kind='skill' AND name=?1", [&name]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skill_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let changed = conn
        .execute(
            "UPDATE capability SET enabled=?2 WHERE kind='skill' AND name=?1",
            rusqlite::params![name, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO capability (id, kind, name, risk, enabled, builtin, createdAt) VALUES (?1,'skill',?2,'low',?3,0,?4)",
            rusqlite::params![new_id("cap"), name, enabled as i64, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn skill_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let p = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills").join(&name).join("SKILL.md");
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

// ---------- Tool（内置只读注册表） ----------

const BUILTIN_TOOLS: [(&str, &str, &str, &str); 6] = [
    ("fs.read", "读取项目内文件", "low", "read"),
    ("knowledge.list", "列出项目已授权知识库", "low", "read"),
    ("knowledge.search", "在已授权知识库内检索", "low", "read"),
    ("knowledge.read", "读取知识库笔记正文", "low", "read"),
    ("knowledge.read_many", "批量读取知识库笔记", "low", "read"),
    ("ssh-exec", "在服务器上执行命令（需连接、授权与逐次审批）", "high", "exec"),
];

#[tauri::command]
pub fn tool_list() -> Result<Vec<ToolEntry>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for (id, desc, risk, _) in BUILTIN_TOOLS.iter() {
        let enabled: bool = conn
            .query_row(
                "SELECT enabled FROM capability WHERE kind='tool' AND name=?1",
                [id],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(true);
        out.push(ToolEntry {
            builtin: true,
            description: Some(desc.to_string()),
            enabled,
            id: format!("tool:{}", id),
            name: id.to_string(),
            risk: risk.to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn tool_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let changed = conn
        .execute(
            "UPDATE capability SET enabled=?2 WHERE kind='tool' AND name=?1",
            rusqlite::params![name, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO capability (id, kind, name, risk, enabled, builtin, createdAt) VALUES (?1,'tool',?2,'low',?3,1,?4)",
            rusqlite::params![new_id("cap"), name, enabled as i64, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- MCP ----------

fn row_to_server(r: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    Ok(McpServer {
        args: serde_json::from_str(&r.get::<_, Option<String>>(4)?.unwrap_or_default()).unwrap_or_default(),
        command: r.get(2)?,
        enabled: r.get::<_, i64>(7)? != 0,
        env: serde_json::from_str(&r.get::<_, Option<String>>(5)?.unwrap_or_default()).unwrap_or_default(),
        id: r.get(0)?,
        name: r.get(1)?,
        tools: serde_json::from_str(&r.get::<_, Option<String>>(9)?.unwrap_or_default()).unwrap_or_default(),
        transport: r.get(3)?,
        url: r.get(6)?,
    })
}

#[tauri::command]
pub fn mcp_list() -> Result<Vec<McpServer>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, transport, argsJson, envJson, url, enabled, NULL, toolsJson FROM mcp_server ORDER BY createdAt",
        )
        .map_err(|e| e.to_string())?;
    let out: Vec<McpServer> = stmt
        .query_map([], row_to_server)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDraft {
    pub id: Option<String>,
    pub name: String,
    pub transport: String, // stdio | http
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
}

#[tauri::command]
pub fn mcp_save(draft: McpDraft) -> Result<String, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("MCP 名称不能为空".into());
    }
    // 名称规则：^[A-Za-z0-9_-]{1,32}$（对照 skill/mcp 面板校验规则）
    let name_ok = name.len() >= 1
        && name.chars().count() <= 32
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !name_ok {
        return Err("MCP 名称只能包含字母、数字、下划线和连字符，长度 1-32".into());
    }
    if draft.transport != "stdio" && draft.transport != "http" {
        return Err("传输类型必须是 stdio 或 http".into());
    }
    if draft.transport == "stdio" && draft.command.as_deref().map(|c| c.trim().is_empty()).unwrap_or(true) {
        return Err("stdio 服务器必须填写启动命令".into());
    }
    if draft.transport == "http" && draft.url.as_deref().map(|u| u.trim().is_empty()).unwrap_or(true) {
        return Err("http 服务器必须填写 URL".into());
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let now = now_ms();
    let id = match &draft.id {
        Some(id) => {
            conn.execute(
                "UPDATE mcp_server SET name=?2, transport=?3, command=?4, argsJson=?5, envJson=?6, url=?7, enabled=?8 WHERE id=?1",
                rusqlite::params![
                    id, name, draft.transport, draft.command,
                    serde_json::to_string(&draft.args).ok(),
                    serde_json::to_string(&draft.env).ok(),
                    draft.url, draft.enabled as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            id.clone()
        }
        None => {
            // 重复名拒绝
            let dup: i64 = conn
                .query_row("SELECT COUNT(*) FROM mcp_server WHERE name=?1", [&name], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            if dup > 0 {
                return Err(format!("同名 MCP 服务器已存在：{}", name));
            }
            let id = new_id("mcp");
            conn.execute(
                "INSERT INTO mcp_server (id, name, transport, command, argsJson, envJson, url, enabled, createdAt)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    id, name, draft.transport, draft.command,
                    serde_json::to_string(&draft.args).ok(),
                    serde_json::to_string(&draft.env).ok(),
                    draft.url, draft.enabled as i64, now
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    Ok(id)
}

#[tauri::command]
pub fn mcp_delete(id: String) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM mcp_server WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn mcp_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "UPDATE mcp_server SET enabled=?2 WHERE id=?1",
        rusqlite::params![id, enabled as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 最小 MCP 客户端（tools/list 发现） ----------

fn rpc(id: i64, method: &str, params: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "method": method, "params": params
    })
    .to_string()
}

fn parse_tools(result: &serde_json::Value) -> Vec<McpToolInfo> {
    result
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| McpToolInfo {
                    description: t.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                    name: t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                })
                .filter(|t| !t.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn mcp_discover_tools(server_id: String) -> Result<Vec<McpToolInfo>, String> {
    let (transport, command, args, env, url, name) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let row = conn
            .query_row(
                "SELECT transport, command, argsJson, envJson, url, name FROM mcp_server WHERE id=?1",
                [&server_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        row
    };
    let tools = match transport.as_str() {
        "stdio" => {
            let command = command.ok_or("stdio 服务器缺少启动命令")?;
            let args_v: Vec<String> = serde_json::from_str(&args.unwrap_or_default()).unwrap_or_default();
            let env_v: std::collections::BTreeMap<String, String> =
                serde_json::from_str(&env.unwrap_or_default()).unwrap_or_default();
            mcp_stdio_tools(&command, &args_v, &env_v).await?
        }
        "http" => {
            let url = url.ok_or("http 服务器缺少 URL")?;
            mcp_http_tools(&url, &name).await?
        }
        t => return Err(format!("未知传输类型：{}", t)),
    };
    // 缓存工具清单
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute(
            "UPDATE mcp_server SET toolsJson=?2 WHERE id=?1",
            rusqlite::params![server_id, serde_json::to_string(&tools).ok()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(tools)
}

async fn mcp_stdio_tools(
    command: &str,
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
) -> Result<Vec<McpToolInfo>, String> {
    use tokio::io::AsyncBufReadExt;
    let mut cmd = tokio::process::Command::new(crate::util::resolve_command(command));
    cmd.args(args);
    for (k, v) in env.iter() {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("MCP 进程启动失败：{}", e))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());

    send_msg(&mut stdin, rpc(1, "initialize", serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": { "name": "agent-workbench", "version": "0.1.0" }
    }))).await?;
    // 读 initialize 响应（容忍通知行）
    let mut init_ok = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let mut line = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), stdout.read_line(&mut line))
            .await
            .map_err(|_| "initialize 超时".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("MCP 服务器已退出".into());
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
                init_ok = true;
                break;
            }
        }
    }
    if !init_ok {
        return Err("initialize 未收到响应".into());
    }
    send_msg(&mut stdin, serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string()).await?;
    send_msg(&mut stdin, rpc(2, "tools/list", serde_json::json!({}))).await?;
    let mut line = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), stdout.read_line(&mut line))
        .await
        .map_err(|_| "tools/list 超时".to_string())?
        .map_err(|e| e.to_string())?;
    let mut tools = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if let Some(result) = v.get("result") {
            tools = parse_tools(result);
        } else if let Some(err) = v.get("error") {
            return Err(format!("MCP 错误：{}", err));
        }
    }
    let _ = child.kill().await;
    Ok(tools)
}

async fn mcp_http_tools(url: &str, _name: &str) -> Result<Vec<McpToolInfo>, String> {
    let url = url.to_string();
    tokio::task::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build();
        let init = rpc(1, "initialize", serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "agent-workbench", "version": "0.1.0" }
        }));
        let resp = agent
            .post(&url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send_string(&init)
            .map_err(|e| format!("initialize 请求失败：{}", e))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        // SSE 或纯 JSON 都兼容：取第一个含 "result" 的 data 行
        let result_line = if text.trim_start().starts_with('{') {
            text
        } else {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .find(|l| l.contains("\"result\""))
                .ok_or("initialize 未返回 result")?
                .to_string()
        };
        let v: serde_json::Value = serde_json::from_str(result_line.trim()).map_err(|e| e.to_string())?;
        if v.get("error").is_some() {
            return Err(format!("MCP 错误：{}", v.get("error").unwrap()));
        }
        let list = rpc(2, "tools/list", serde_json::json!({}));
        let resp = agent
            .post(&url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send_string(&list)
            .map_err(|e| format!("tools/list 请求失败：{}", e))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        let result_line = if text.trim_start().starts_with('{') {
            text
        } else {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .find(|l| l.contains("\"result\""))
                .ok_or("tools/list 未返回 result")?
                .to_string()
        };
        let v: serde_json::Value = serde_json::from_str(result_line.trim()).map_err(|e| e.to_string())?;
        match v.get("result") {
            Some(result) => Ok(parse_tools(result)),
            None => Err(format!("MCP 错误：{}", v.get("error").unwrap_or(&serde_json::json!("unknown")))),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 向 MCP stdio 进程写入一行 JSON-RPC。
async fn send_msg(stdin: &mut tokio::process::ChildStdin, line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}
