//! CR-093：AI 本地与联网搜索工具。
//!
//! 覆盖两类能力（用户已确认）：
//! - **本地**：`fs_grep`（内容正则检索）/`fs_glob`（文件名/路径匹配）。范围＝**项目授权目录**
//!   （`setting_default(scope=projectId, key='search.authDirs')` 的 JSON 数组）；复用 fs.rs 的
//!   canonicalize 白名单思路，防目录穿越与符号链接逃逸，受结果/字节/文件大小上限与二进制跳过约束。
//! - **联网**：`web_search`（默认抓 DuckDuckGo HTML，Bing 备用；设置可配 Tavily），
//!   `web_fetch`（网页 HTML→Markdown，AI 阅读友好）。仅 http/https，拒绝 localhost/私网/内网（SSRF）。
//!
//! 决策（用户 2026-11-25 授权「决策按推荐」）：
//! - 授权目录按**项目**存储（会话绑定项目，等价于「对话时授权」），默认空→本地工具提示先授权。
//! - 联网后端默认 `default`（免 key 抓取）；配置 Tavily 且可用→走 Tavily，失败回退默认并提示。
//! - 后端密钥存 `data_dir/secrets/search.json`（受管密钥文件，不写入 setting_default、不进日志）。
//!
//! 未验证：真实网络抓取（DuckDuckGo/Bing/Tavily 结果页结构随版本变化）需实际联网复验；
//! SSRF 仅做主机名/字面 IP 黑名单，未做 DNS 解析防重绑定（见 LLD 限制）。

use crate::commands::ai_tools::ToolContext;
use crate::db;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

// ---------- 设置键 ----------
const K_BACKEND: &str = "search.web.backend"; // "default" | "tavily"
const K_TAVILY_BASE: &str = "search.web.tavily.baseUrl";
const K_TIMEOUT: &str = "search.web.timeoutSec";
const K_MAXRESULTS: &str = "search.web.maxResults";
const K_WEBFETCH: &str = "search.webFetch.enabled";
const K_SESSION_DIRS: &str = "search.extraDirs"; // scope=session:<sessionId>（CR-104 会话级授权）
const SECRET_TAVILY: &str = "search.tavily";

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

fn setting_get(conn: &rusqlite::Connection, scope: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM setting_default WHERE scope=?1 AND key=?2",
        [scope, key],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

fn setting_set(conn: &rusqlite::Connection, scope: &str, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO setting_default(scope,key,value,updatedAt) VALUES(?1,?2,?3,?4)
         ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt",
        rusqlite::params![scope, key, value, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 后端密钥文件 ----------
fn secrets_file(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join("search.json")
}

fn read_secrets(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(secrets_file(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<BTreeMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

fn write_secrets(data_dir: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = secrets_file(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("密钥目录不可写：{e}"))?;
    }
    let body = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("密钥写入失败：{e}"))
}

// ---------- 项目与授权目录 ----------
fn resolve_project(ctx: &ToolContext, args: &Value) -> Result<String, String> {
    if let Some(pid) = args.get("projectId").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(pid.to_string());
    }
    ctx.project_id
        .clone()
        .ok_or_else(|| "会话未绑定项目且未提供 projectId".to_string())
}

fn scope_for_session(session_id: &str) -> String {
    format!("session:{session_id}")
}

/// 校验并规范化一个可搜索目录：必须是存在的绝对目录。
fn canonical_dir(raw: &str) -> Result<PathBuf, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("目录不能为空".into());
    }
    let p = Path::new(t);
    if !p.is_absolute() {
        return Err(format!("搜索目录必须是绝对路径：{t}"));
    }
    let c = std::fs::canonicalize(p).map_err(|_| format!("目录不可访问：{t}"))?;
    if !c.is_dir() {
        return Err(format!("不是目录：{t}"));
    }
    Ok(c)
}

/// 会话绑定项目的根目录（canonical）。项目不存在或不可访问时返回 None。
fn project_root(conn: &rusqlite::Connection, project_id: &str) -> Option<PathBuf> {
    let uri: String = conn
        .query_row("SELECT rootUri FROM project WHERE id=?1", [project_id], |r| r.get(0))
        .ok()?;
    std::fs::canonicalize(&uri).ok().filter(|p| p.is_dir())
}

/// 会话级额外搜索目录（实时读取，目录不可访问时跳过）。
fn session_extra_dirs(conn: &rusqlite::Connection, session_id: &str) -> Vec<PathBuf> {
    setting_get(conn, &scope_for_session(session_id), K_SESSION_DIRS)
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| std::fs::canonicalize(d).ok())
        .filter(|p| p.is_dir())
        .collect()
}

/// 会话权限档位；历史记录 NULL 视为 default。
fn session_permission_mode(conn: &rusqlite::Connection, session_id: Option<&str>) -> String {
    session_id
        .and_then(|sid| {
            conn.query_row(
                "SELECT permissionMode FROM session WHERE id=?1",
                [sid],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        })
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "default".into())
}

/// 本轮可搜索的根目录集合：项目根 + 会话额外目录；规划（plan）档位只保留项目根。
fn search_roots(
    conn: &rusqlite::Connection,
    ctx: &ToolContext,
    project_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = project_root(conn, project_id) {
        roots.push(root);
    }
    if session_permission_mode(conn, ctx.session_id.as_deref()) != "plan" {
        if let Some(sid) = ctx.session_id.as_deref() {
            for dir in session_extra_dirs(conn, sid) {
                if !roots.contains(&dir) {
                    roots.push(dir);
                }
            }
        }
    }
    if roots.is_empty() {
        return Err(
            "当前会话没有可搜索范围：请先选择项目，或在 AI 侧栏「搜索授权」中为本会话添加目录。"
                .into(),
        );
    }
    Ok(roots)
}

/// 在某个根下解析搜索起点；`sub` 为空取根本身。
/// 返回 `Err("OUT_OF_SCOPE")` 表示该路径不在这个根内。
fn start_under_root(root: &Path, sub: Option<&str>) -> Result<PathBuf, String> {
    let root_c = std::fs::canonicalize(root)
        .map_err(|_| format!("目录不可访问：{}", root.to_string_lossy()))?;
    match sub {
        None => Ok(root_c),
        Some(sp) => {
            let p = Path::new(sp);
            let cand = if p.is_absolute() { p.to_path_buf() } else { root_c.join(p) };
            let c = std::fs::canonicalize(&cand)
                .map_err(|_| format!("路径不存在或不可访问：{sp}"))?;
            if c.starts_with(&root_c) {
                Ok(c)
            } else {
                Err("OUT_OF_SCOPE".into())
            }
        }
    }
}

fn out_of_scope_error(sub: Option<&str>) -> String {
    match sub {
        Some(sp) => format!(
            "搜索范围外：{sp}。默认范围仅包含当前项目根与会话已授权目录；如需搜索该目录，请在 AI 侧栏「搜索授权」中为本会话添加（仅本会话有效）。"
        ),
        None => "搜索范围外：该目录不在当前会话的可搜索范围内。".into(),
    }
}

// ---------- Tauri 命令：会话授权目录与配置 ----------

/// 读取某会话的搜索范围：项目根、额外目录、权限档位。
#[tauri::command]
pub fn search_session_scope_get(session_id: String) -> Result<Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let project_id: Option<String> = conn
        .query_row("SELECT projectId FROM session WHERE id=?1", [&session_id], |r| r.get(0))
        .ok()
        .flatten();
    let root = project_id
        .as_deref()
        .and_then(|pid| project_root(conn, pid))
        .map(|p| p.to_string_lossy().to_string());
    let extra: Vec<String> = session_extra_dirs(conn, &session_id)
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(json!({
        "projectRoot": root,
        "extraDirs": extra,
        "permissionMode": session_permission_mode(conn, Some(&session_id)),
    }))
}

/// 为某会话添加一个额外搜索目录（仅本会话有效；去重、canonical 化）。
#[tauri::command]
pub fn search_session_dirs_add(session_id: String, dir: String) -> Result<Vec<String>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let c = canonical_dir(&dir)?;
    let mut dirs = session_extra_dirs(conn, &session_id);
    if !dirs.contains(&c) {
        dirs.push(c);
    }
    let out: Vec<String> = dirs.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let json_v = serde_json::to_string(&out).map_err(|e| e.to_string())?;
    setting_set(conn, &scope_for_session(&session_id), K_SESSION_DIRS, &json_v)?;
    Ok(out)
}

/// 移除某会话的一个额外搜索目录。
#[tauri::command]
pub fn search_session_dirs_remove(session_id: String, dir: String) -> Result<Vec<String>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let target = std::fs::canonicalize(dir.trim())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| dir.trim().to_string());
    let dirs: Vec<String> = session_extra_dirs(conn, &session_id)
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| p != &target)
        .collect();
    let json_v = serde_json::to_string(&dirs).map_err(|e| e.to_string())?;
    setting_set(conn, &scope_for_session(&session_id), K_SESSION_DIRS, &json_v)?;
    Ok(dirs)
}

/// 读取联网搜索配置（不含密钥明文，只返回是否已配置）。
#[tauri::command]
pub fn search_config_get() -> Result<Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let backend = setting_get(conn, "global", K_BACKEND).unwrap_or_else(|| "default".into());
    let tavily_base = setting_get(conn, "global", K_TAVILY_BASE).unwrap_or_else(|| "https://api.tavily.com".into());
    let timeout: i64 = setting_get(conn, "global", K_TIMEOUT).and_then(|v| v.parse().ok()).unwrap_or(20);
    let max_results: i64 = setting_get(conn, "global", K_MAXRESULTS).and_then(|v| v.parse().ok()).unwrap_or(10);
    let web_fetch_enabled = setting_get(conn, "global", K_WEBFETCH).map(|v| v != "0").unwrap_or(true);
    let has_tavily_key = data_root(conn)
        .ok()
        .map(|d| read_secrets(&d).contains_key(SECRET_TAVILY))
        .unwrap_or(false);
    Ok(json!({
        "backend": backend,
        "tavilyBaseUrl": tavily_base,
        "hasTavilyKey": has_tavily_key,
        "timeoutSec": timeout,
        "maxResults": max_results,
        "webFetchEnabled": web_fetch_enabled,
    }))
}

/// 保存联网搜索配置。tavilyKey 为 None 表示不改，空串表示清空。
#[tauri::command]
pub fn search_config_set(
    backend: String,
    tavily_base_url: Option<String>,
    tavily_key: Option<String>,
    timeout_sec: Option<i64>,
    max_results: Option<i64>,
    web_fetch_enabled: Option<bool>,
) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let backend = backend.trim();
    if backend != "default" && backend != "tavily" {
        return Err("未知搜索后端".into());
    }
    setting_set(conn, "global", K_BACKEND, backend)?;
    if let Some(base) = tavily_base_url.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        setting_set(conn, "global", K_TAVILY_BASE, base)?;
    }
    if let Some(t) = timeout_sec {
        setting_set(conn, "global", K_TIMEOUT, &t.clamp(3, 120).to_string())?;
    }
    if let Some(m) = max_results {
        setting_set(conn, "global", K_MAXRESULTS, &m.clamp(1, 30).to_string())?;
    }
    if let Some(b) = web_fetch_enabled {
        setting_set(conn, "global", K_WEBFETCH, if b { "1" } else { "0" })?;
    }
    if let Some(key) = tavily_key {
        let data_dir = data_root(&conn)?;
        let mut map = read_secrets(&data_dir);
        if key.trim().is_empty() {
            map.remove(SECRET_TAVILY);
        } else {
            map.insert(SECRET_TAVILY.to_string(), key.trim().to_string());
        }
        write_secrets(&data_dir, &map)?;
    }
    Ok(())
}

/// 反推应用数据根：setting_default 里没有直接存 data_dir，这里从 DB 文件位置推得。
fn data_root(conn: &rusqlite::Connection) -> Result<PathBuf, String> {
    // db 文件位于 <root>/db/workbench.db；用 PRAGMA database_list 取路径。
    let mut stmt = conn.prepare("PRAGMA database_list").map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(1).unwrap_or_default();
        if name == "main" {
            let file: String = row.get(2).unwrap_or_default();
            let p = PathBuf::from(file);
            // <root>/db/workbench.db -> <root>
            if let Some(db_dir) = p.parent() {
                if let Some(root) = db_dir.parent() {
                    return Ok(root.to_path_buf());
                }
            }
        }
    }
    Err("无法定位应用数据目录".into())
}

// ---------- 本地搜索 ----------

fn is_probably_binary(sample: &[u8]) -> bool {
    sample.iter().take(8192).any(|b| *b == 0)
}

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024; // 单文件 4MiB 上限

fn rel_display(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().replace('\\', "/"))
}

/// fs_grep：在项目授权目录内按正则检索文件内容。
pub(crate) fn tool_fs_grep(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project(ctx, args)?;
    let pattern = args.get("pattern").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if pattern.is_empty() {
        return Err("缺少必填参数：pattern".into());
    }
    let case_sensitive = args.get("caseSensitive").and_then(Value::as_bool).unwrap_or(false);
    let max_results: usize = args
        .get("maxResults")
        .and_then(Value::as_i64)
        .map(|v| v.clamp(1, 1000) as usize)
        .unwrap_or(200);
    let glob_filter = args.get("glob").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let sub_path = args.get("path").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());

    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("正则无效：{e}"))?;
    let glob_matcher = match glob_filter {
        Some(g) => Some(globset::Glob::new(g).map_err(|e| format!("glob 无效：{e}"))?.compile_matcher()),
        None => None,
    };

    let (roots, starts) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let roots = search_roots(conn, ctx, &project_id)?;
        let mut starts: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut scope_miss = false;
        let mut last_err: Option<String> = None;
        for root in &roots {
            match start_under_root(root, sub_path) {
                Ok(start) => starts.push((root.clone(), start)),
                Err(e) if e == "OUT_OF_SCOPE" => scope_miss = true,
                Err(e) => last_err = Some(e),
            }
        }
        if starts.is_empty() {
            return Err(if scope_miss {
                out_of_scope_error(sub_path)
            } else {
                last_err.unwrap_or_else(|| "没有可搜索的目录".into())
            });
        }
        (roots, starts)
    };

    let mut matches: Vec<Value> = Vec::new();
    let mut truncated = false;
    'outer: for (root, start) in &starts {
        let walker = ignore::WalkBuilder::new(start)
            .standard_filters(true)
            .follow_links(false)
            .build();
        for ent in walker.flatten() {
            if matches.len() >= max_results {
                truncated = true;
                break 'outer;
            }
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            if let Some(m) = &glob_matcher {
                let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if !m.is_match(fname) {
                    continue;
                }
            }
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mut sample = vec![0u8; 8192];
            let mut f = match std::fs::File::open(path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let n = f.read(&mut sample).unwrap_or(0);
            if is_probably_binary(&sample[..n]) {
                continue;
            }
            drop(f);
            let content = match std::fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for (i, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    matches.push(json!({
                        "path": path.to_string_lossy().to_string(),
                        "relative": rel_display(root, path),
                        "line": i + 1,
                        "text": line.chars().take(300).collect::<String>(),
                    }));
                    if matches.len() >= max_results {
                        truncated = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    Ok(json!({
        "matches": matches,
        "count": matches.len(),
        "truncated": truncated,
        "searchRoots": roots.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
    }))
}

/// fs_glob：在当前会话可搜索范围（项目根 + 会话额外目录）内按文件名/相对路径 glob 匹配。
pub(crate) fn tool_fs_glob(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let project_id = resolve_project(ctx, args)?;
    let pattern = args.get("pattern").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if pattern.is_empty() {
        return Err("缺少必填参数：pattern".into());
    }
    let case_sensitive = args.get("caseSensitive").and_then(Value::as_bool).unwrap_or(false);
    let max_results: usize = args
        .get("maxResults")
        .and_then(Value::as_i64)
        .map(|v| v.clamp(1, 5000) as usize)
        .unwrap_or(500);
    let glob = globset::GlobBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .literal_separator(false)
        .build()
        .map_err(|e| format!("glob 无效：{e}"))?;
    let matcher = glob.compile_matcher();

    let roots = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        search_roots(conn, ctx, &project_id)?
    };

    let mut files: Vec<Value> = Vec::new();
    let mut truncated = false;
    'outer: for root in &roots {
        let walker = ignore::WalkBuilder::new(root)
            .standard_filters(true)
            .follow_links(false)
            .build();
        for ent in walker.flatten() {
            if files.len() >= max_results {
                truncated = true;
                break 'outer;
            }
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            let rel = rel_display(root, path);
            let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if matcher.is_match(rel.as_str()) || matcher.is_match(fname) {
                files.push(json!({
                    "path": path.to_string_lossy().to_string(),
                    "relative": rel,
                }));
            }
        }
    }
    Ok(json!({
        "files": files,
        "count": files.len(),
        "truncated": truncated,
        "searchRoots": roots.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
    }))
}

// ---------- 联网搜索 ----------

/// 简易 SSRF 防护：只允许 http/https，拒绝 localhost/私网/内网字面地址。
fn url_allowed(url: &str) -> Result<(), String> {
    let lower = url.trim();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("仅支持 http/https 链接".into());
    }
    let after = &lower[lower.find("://").unwrap() + 3..];
    let host_port = after.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.split('@').last().unwrap_or(host_port);
    let host = host.split(':').next().unwrap_or(host); // 去端口（IPv6 字面量暂不支持）
    if host.is_empty() {
        return Err("URL 缺少主机名".into());
    }
    let h = host.to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".local") || h == "0.0.0.0" || h == "[::1]" || h == "::1" {
        return Err("出于安全考虑，拒绝访问本机/内网地址".into());
    }
    // 字面 IPv4 私网/回环/链路本地
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) {
        let o0: u8 = parts[0].parse().unwrap();
        let o1: u8 = parts[1].parse().unwrap();
        let private = o0 == 127
            || o0 == 10
            || (o0 == 192 && o1 == 168)
            || (o0 == 172 && (16..=31).contains(&o1))
            || (o0 == 169 && o1 == 254)
            || o0 == 0;
        if private {
            return Err("出于安全考虑，拒绝访问本机/内网地址".into());
        }
    }
    Ok(())
}

fn http_get_text(url: &str, timeout: u64, max_bytes: u64) -> Result<(String, String), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(timeout))
        .redirects(5)
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", UA)
        .call()
        .map_err(|e| format!("请求失败：{e}"))?;
    let ctype = resp.header("content-type").unwrap_or("").to_string();
    let mut buf = Vec::new();
    resp.into_reader()
        .take(max_bytes)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败：{e}"))?;
    let text = String::from_utf8_lossy(&buf).to_string();
    Ok((ctype, text))
}

fn strip_tags(s: &str) -> String {
    // 粗粒度去标签 + 基础实体解码 + 空白归一化（用于结果标题/摘要）
    let re = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let no = re.replace_all(s, " ");
    let decoded = decode_entities(&no);
    let ws = regex::Regex::new(r"\s+").unwrap();
    ws.replace_all(&decoded, " ").trim().to_string()
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn decode_ddg_url(href: &str) -> String {
    // DDG 结果链接常为 //duckduckgo.com/l/?uddg=<encoded>&...
    if let Some(pos) = href.find("uddg=") {
        let rest = &href[pos + 5..];
        let enc = rest.split('&').next().unwrap_or(rest);
        return percent_decode(enc);
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    href.to_string()
}

fn ddg_search(query: &str, count: usize, timeout: u64) -> Result<Vec<Value>, String> {
    let q = urlencode(query);
    let url = format!("https://html.duckduckgo.com/html/?q={q}");
    let (_ct, html) = http_get_text(&url, timeout, 4 * 1024 * 1024)?;
    let re_a = regex::Regex::new(r#"(?s)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let re_snip = regex::Regex::new(r#"(?s)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>"#).unwrap();
    let titles: Vec<(String, String)> = re_a
        .captures_iter(&html)
        .map(|c| (decode_ddg_url(&c[1]), strip_tags(&c[2])))
        .collect();
    let snippets: Vec<String> = re_snip
        .captures_iter(&html)
        .map(|c| strip_tags(&c[1]))
        .collect();
    let mut out = Vec::new();
    for (i, (url, title)) in titles.iter().enumerate() {
        if out.len() >= count {
            break;
        }
        if url.is_empty() || title.is_empty() {
            continue;
        }
        out.push(json!({
            "title": title,
            "url": url,
            "snippet": snippets.get(i).cloned().unwrap_or_default(),
            "source": "duckduckgo",
        }));
    }
    if out.is_empty() {
        return Err("DuckDuckGo 未返回可解析结果（可能被反爬或页面结构变化）".into());
    }
    Ok(out)
}

fn bing_search(query: &str, count: usize, timeout: u64) -> Result<Vec<Value>, String> {
    let q = urlencode(query);
    let url = format!("https://www.bing.com/search?q={q}&count={count}");
    let (_ct, html) = http_get_text(&url, timeout, 4 * 1024 * 1024)?;
    let re_block = regex::Regex::new(r#"(?s)<li class="b_algo".*?</li>"#).unwrap();
    let re_h2 = regex::Regex::new(r#"(?s)<h2[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let re_p = regex::Regex::new(r#"(?s)<p[^>]*>(.*?)</p>"#).unwrap();
    let mut out = Vec::new();
    for block in re_block.find_iter(&html) {
        if out.len() >= count {
            break;
        }
        let b = block.as_str();
        if let Some(c) = re_h2.captures(b) {
            let url = c[1].to_string();
            let title = strip_tags(&c[2]);
            let snippet = re_p.captures(b).map(|p| strip_tags(&p[1])).unwrap_or_default();
            if !url.is_empty() && !title.is_empty() {
                out.push(json!({"title": title, "url": url, "snippet": snippet, "source": "bing"}));
            }
        }
    }
    if out.is_empty() {
        return Err("Bing 未返回可解析结果".into());
    }
    Ok(out)
}

fn tavily_search(base: &str, key: &str, query: &str, count: usize, timeout: u64) -> Result<Vec<Value>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(timeout))
        .build();
    let body = json!({ "api_key": key, "query": query, "max_results": count });
    let resp = agent
        .post(&format!("{}/search", base.trim_end_matches('/')))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("Tavily 请求失败：{e}"))?;
    let v: Value = resp.into_json().map_err(|e| format!("Tavily 响应无效：{e}"))?;
    let arr = v.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    let out: Vec<Value> = arr
        .into_iter()
        .take(count)
        .map(|r| {
            json!({
                "title": r.get("title").and_then(Value::as_str).unwrap_or(""),
                "url": r.get("url").and_then(Value::as_str).unwrap_or(""),
                "snippet": r.get("content").and_then(Value::as_str).unwrap_or(""),
                "source": "tavily",
            })
        })
        .collect();
    if out.is_empty() {
        return Err("Tavily 无结果".into());
    }
    Ok(out)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// web_search：默认免 key 抓取（DuckDuckGo → Bing 备用）；可配 Tavily，失败回退默认。
pub(crate) fn tool_web_search(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let query = args.get("query").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if query.is_empty() {
        return Err("缺少必填参数：query".into());
    }
    let (configured_backend, timeout, default_count, tavily_base, tavily_key) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let be = setting_get(conn, "global", K_BACKEND).unwrap_or_else(|| "default".into());
        let to: u64 = setting_get(conn, "global", K_TIMEOUT).and_then(|v| v.parse().ok()).unwrap_or(20);
        let dc: usize = setting_get(conn, "global", K_MAXRESULTS).and_then(|v| v.parse().ok()).unwrap_or(10);
        let base = setting_get(conn, "global", K_TAVILY_BASE).unwrap_or_else(|| "https://api.tavily.com".into());
        let key = data_root(conn).ok().map(|d| read_secrets(&d).get(SECRET_TAVILY).cloned()).flatten();
        (be, to, dc, base, key)
    };
    let count: usize = args.get("count").and_then(Value::as_i64).map(|v| v.clamp(1, 30) as usize).unwrap_or(default_count);
    let req_backend = args.get("backend").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let backend = req_backend.unwrap_or(configured_backend.as_str());

    let mut fallback_note: Option<String> = None;
    if backend == "tavily" {
        if let Some(k) = tavily_key.filter(|k| !k.trim().is_empty()) {
            match tavily_search(&tavily_base, &k, query, count, timeout) {
                Ok(results) => {
                    return Ok(json!({"results": results, "count": results.len(), "backend": "tavily", "fetchedAt": crate::models::now_ms()}));
                }
                Err(e) => fallback_note = Some(format!("Tavily 失败，已回退 DuckDuckGo：{e}")),
            }
        } else {
            fallback_note = Some("未配置 Tavily 密钥，已回退 DuckDuckGo".into());
        }
    }

    let results = match ddg_search(query, count, timeout) {
        Ok(r) => r,
        Err(e1) => match bing_search(query, count, timeout) {
            Ok(r) => r,
            Err(e2) => return Err(format!("联网搜索失败（DuckDuckGo：{e1}；Bing：{e2}）")),
        },
    };
    Ok(json!({
        "results": results,
        "count": results.len(),
        "backend": "default",
        "note": fallback_note,
        "fetchedAt": crate::models::now_ms(),
    }))
}

/// web_fetch：抓取网页并转为 AI 阅读友好的 Markdown。
pub(crate) fn tool_web_fetch(ctx: &ToolContext, args: &Value) -> Result<Value, String> {
    let url = args.get("url").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if url.is_empty() {
        return Err("缺少必填参数：url".into());
    }
    url_allowed(url)?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let enabled = setting_get(conn, "global", K_WEBFETCH).map(|v| v != "0").unwrap_or(true);
    let timeout: u64 = setting_get(conn, "global", K_TIMEOUT).and_then(|v| v.parse().ok()).unwrap_or(20);
    drop(guard);
    if !enabled {
        return Err("网页抓取已在设置中关闭".into());
    }
    let max_chars: usize = args.get("maxChars").and_then(Value::as_i64).map(|v| v.clamp(500, 200_000) as usize).unwrap_or(20_000);

    let (ctype, body) = http_get_text(url, timeout, 8 * 1024 * 1024)?;
    let content = if ctype.contains("html") || body.trim_start().starts_with('<') {
        match htmd::convert(&body) {
            Ok(md) => md,
            Err(e) => return Err(format!("网页正文解析失败：{e}")),
        }
    } else if ctype.contains("json") || ctype.contains("text") || ctype.is_empty() {
        body
    } else {
        return Err(format!("暂不支持的网页类型：{ctype}"));
    };
    let truncated = content.chars().count() > max_chars;
    let content: String = content.chars().take(max_chars).collect();
    Ok(json!({
        "url": url,
        "format": "markdown",
        "content": content,
        "truncated": truncated,
        "contentType": ctype,
    }))
}

// ---------- 单测（不联网的部分） ----------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_allowed_blocks_local_and_private() {
        assert!(url_allowed("https://example.com/a").is_ok());
        assert!(url_allowed("ftp://example.com").is_err());
        assert!(url_allowed("http://localhost:8080").is_err());
        assert!(url_allowed("http://127.0.0.1/x").is_err());
        assert!(url_allowed("http://10.1.2.3").is_err());
        assert!(url_allowed("http://192.168.0.1").is_err());
        assert!(url_allowed("http://172.16.5.5").is_err());
        assert!(url_allowed("http://169.254.1.1").is_err());
        assert!(url_allowed("http://8.8.8.8").is_ok());
    }

    #[test]
    fn percent_and_ddg_url_decoding() {
        assert_eq!(percent_decode("https%3A%2F%2Fa.com%2Fb"), "https://a.com/b");
        assert_eq!(decode_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com"), "https://x.com");
        assert_eq!(decode_ddg_url("https://plain.com"), "https://plain.com");
    }

    #[test]
    fn strip_tags_and_entities() {
        assert_eq!(strip_tags("<b>Hello</b> &amp; <i>world</i>"), "Hello & world");
    }

    #[test]
    fn urlencode_basic() {
        assert_eq!(urlencode("a b&c"), "a+b%26c");
    }

    #[test]
    fn binary_detection() {
        assert!(is_probably_binary(&[0, 1, 2, 3]));
        assert!(!is_probably_binary(b"hello world"));
    }

    /// CR-104：默认项目根内可解析；绝对越界与 `..` 逃逸都返回 OUT_OF_SCOPE。
    #[test]
    fn start_under_root_keeps_inside_and_rejects_escape() {
        let base = std::env::temp_dir().join(format!("dsh-search-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "x").unwrap();
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        let inside = start_under_root(&root, Some("sub")).unwrap();
        assert!(inside.ends_with("sub"), "实际：{}", inside.display());
        assert_eq!(start_under_root(&root, None).unwrap(), std::fs::canonicalize(&root).unwrap());

        let abs = outside.to_string_lossy().to_string();
        assert_eq!(start_under_root(&root, Some(abs.as_str())).unwrap_err(), "OUT_OF_SCOPE");
        assert_eq!(start_under_root(&root, Some("../outside")).unwrap_err(), "OUT_OF_SCOPE");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// CR-104：越界错误必须指向会话级授权入口，不能回退到旧的「设置·搜索」文案。
    #[test]
    fn out_of_scope_message_points_to_session_grant() {
        let msg = out_of_scope_error(Some("D:/elsewhere"));
        assert!(msg.contains("搜索范围外"));
        assert!(msg.contains("搜索授权"));
        assert!(!msg.contains("设置 · 搜索"));
    }
}
