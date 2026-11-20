//! 知识库（对照 zyplayer-doc 机制移植：空间/目录树/正文/搜索/授权；正文 Markdown 文件）。
//!
//! - 库 = 受管本地目录（managed-directory），DB 存索引
//! - 授权：project_library_grant；无记录即拒绝（DB-FEAT-001）
//! - 网关：gateway_* 函数供 AI 会话的 knowledge.* 工具复用，每次调用复检授权

use crate::db;
use crate::models::{KnowledgeHit, KnowledgeLibrary, LibraryGrant, NoteContent, NoteNode, now_ms, new_id};
use std::path::{Path, PathBuf};

fn library_root(source_ref: &str) -> Result<PathBuf, String> {
    let p = Path::new(source_ref);
    if !p.is_dir() {
        return Err(format!("知识库目录不可访问：{}", source_ref));
    }
    Ok(p.to_path_buf())
}

/// 扫描库目录，重建 note_index（.md 文件）。
fn scan_notes(lib_id: &str, root: &Path) -> Result<i64, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1", [lib_id]).map_err(|e| e.to_string())?;
    let mut count = 0i64;
    for ent in walkdir::WalkDir::new(root)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            n != ".git" && n != "node_modules" && n != "tmp"
        })
        .flatten()
    {
        if !ent.path().is_file() {
            continue;
        }
        if ent.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = ent
            .path()
            .strip_prefix(root)
            .unwrap_or(ent.path())
            .to_string_lossy()
            .replace('\\', "/");
        let content = std::fs::read_to_string(ent.path()).unwrap_or_default();
        let title = content
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches("# ").trim().to_string())
            .unwrap_or_else(|| ent.path().file_stem().unwrap_or_default().to_string_lossy().to_string());
        let note_id = format!("n{}", fnv1a(&rel));
        conn.execute(
            "INSERT OR REPLACE INTO knowledge_note_index (libraryId, noteId, title, relativeUri, contentHash, updatedAt)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![lib_id, note_id, title, rel, format!("{:x}", fnv1a(&content)), now_ms()],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    conn.execute(
        "UPDATE knowledge_library SET revision = revision + 1 WHERE id=?1",
        [lib_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(count)
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[tauri::command]
pub fn kb_list() -> Result<Vec<KnowledgeLibrary>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.name, l.sourceKind, l.sourceRef, l.enabled, l.revision,
                    (SELECT COUNT(*) FROM knowledge_note_index n WHERE n.libraryId = l.id)
             FROM knowledge_library l ORDER BY l.createdAt",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(KnowledgeLibrary {
                enabled: r.get::<_, i64>(4)? != 0,
                id: r.get(0)?,
                name: r.get(1)?,
                note_count: r.get(6)?,
                revision: r.get(5)?,
                source_kind: r.get(2)?,
                source_ref: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn kb_save(app: tauri::AppHandle, name: String, source_ref: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("知识库名称不能为空".into());
    }
    let canonical = std::fs::canonicalize(&source_ref).map_err(|_| format!("目录不可访问：{}", source_ref))?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let id = new_id("kb");
    conn.execute(
        "INSERT INTO knowledge_library (id, name, sourceKind, sourceRef, revision, enabled, createdAt)
         VALUES (?1,?2,'managed-directory',?3,0,1,?4)",
        rusqlite::params![id, name.trim(), canonical.to_string_lossy(), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    let _ = &app;
    Ok(id)
}

#[tauri::command]
pub fn kb_delete(id: String) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM knowledge_library WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM knowledge_note_index WHERE libraryId=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_library_grant WHERE libraryId=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kb_scan(id: String) -> Result<i64, String> {
    let source = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT sourceRef FROM knowledge_library WHERE id=?1", [&id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
    };
    let root = library_root(&source)?;
    scan_notes(&id, &root)
}

/// 目录树（按相对路径分组；目录节点 is_dir=true）。
#[tauri::command]
pub fn kb_tree(id: String) -> Result<Vec<NoteNode>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT noteId, title, relativeUri FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
        .map_err(|e| e.to_string())?;
    let notes: Vec<(String, String, String)> = stmt
        .query_map([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    use std::collections::BTreeMap;
    // dir -> 文件节点（同目录内按 relativeUri 有序）
    let mut dirs: BTreeMap<String, Vec<NoteNode>> = BTreeMap::new();
    for (nid, title, rel) in notes {
        let dir = match rel.rsplit_once('/') {
            Some((d, _)) => d.to_string(),
            None => String::new(),
        };
        dirs.entry(dir).or_default().push(NoteNode {
            children: vec![],
            is_dir: false,
            note_id: nid,
            relative_uri: rel,
            title,
        });
    }
    // 确保目录链上的每个目录节点都存在
    let mut nodes: BTreeMap<String, NoteNode> = BTreeMap::new();
    for dir in dirs.keys() {
        if dir.is_empty() {
            continue;
        }
        let mut cur = String::new();
        for part in dir.split('/') {
            cur = if cur.is_empty() { part.to_string() } else { format!("{}/{}", cur, part) };
            nodes.entry(cur.clone()).or_insert_with(|| NoteNode {
                children: vec![],
                is_dir: true,
                note_id: format!("d{}", fnv1a(&cur)),
                relative_uri: cur.clone(),
                title: part.to_string(),
            });
        }
    }
    // 文件挂到所属目录
    for (dir, files) in dirs.iter() {
        if dir.is_empty() {
            continue; // 根级文件单独处理
        }
        if let Some(pn) = nodes.get_mut(dir) {
            pn.children.extend(files.iter().cloned());
        }
    }
    // 目录父子链接（父持有子节点；子标记已有父）
    let mut roots: Vec<NoteNode> = Vec::new();
    let mut has_parent: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let dir_keys: Vec<String> = nodes.keys().cloned().collect();
    for dir in dir_keys.iter() {
        if let Some((parent, _)) = dir.rsplit_once('/') {
            let child = nodes.get(dir).cloned();
            if let (Some(child), Some(pn)) = (child, nodes.get_mut(parent)) {
                has_parent.insert(dir.clone());
                pn.children.push(child);
            }
        }
    }
    // 根级内容：无父目录 + 根级文件
    for dir in dir_keys.iter() {
        if !has_parent.contains(dir) {
            if let Some(n) = nodes.remove(dir) {
                roots.push(n);
            }
        }
    }
    if let Some(root_files) = dirs.get("") {
        roots.extend(root_files.iter().cloned());
    }
    Ok(roots)
}

fn resolve_note(lib_id: &str, note_id: &str) -> Result<(PathBuf, String, String), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let (source, rel, title): (String, String, String) = conn
        .query_row(
            "SELECT l.sourceRef, n.relativeUri, n.title FROM knowledge_library l
             JOIN knowledge_note_index n ON n.libraryId = l.id
             WHERE l.id=?1 AND n.noteId=?2",
            [lib_id, note_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "笔记不存在".to_string())?;
    let root = library_root(&source)?;
    // 路径安全：拒绝越界
    let path = root.join(&rel);
    let canonical = std::fs::canonicalize(&path).map_err(|_| "文件不可访问".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("路径越界".into());
    }
    Ok((canonical, rel, title))
}

#[tauri::command]
pub fn kb_read(lib_id: String, note_id: String) -> Result<NoteContent, String> {
    let (path, rel, title) = resolve_note(&lib_id, &note_id)?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取失败：{}", e))?;
    Ok(NoteContent { content, note_id, relative_uri: rel, title })
}

/// 关键词搜索（标题 + 正文 LIKE；返回片段）。
#[tauri::command]
pub fn kb_search(lib_ids: Vec<String>, query: String) -> Result<Vec<KnowledgeHit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut hits = Vec::new();
    for lib in lib_ids.iter() {
        let (name, source): (String, String) = conn
            .query_row("SELECT name, sourceRef FROM knowledge_library WHERE id=?1 AND enabled=1", [lib], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|_| format!("知识库不存在或未启用：{}", lib))?;
        let mut stmt = conn
            .prepare("SELECT noteId, title, relativeUri FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
            .map_err(|e| e.to_string())?;
        let notes: Vec<(String, String, String)> = stmt
            .query_map([lib], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        let root = library_root(&source)?;
        let q = query.to_lowercase();
        for (nid, title, rel) in notes {
            if title.to_lowercase().contains(&q) {
                hits.push(KnowledgeHit {
                    library_id: lib.clone(),
                    library_name: name.clone(),
                    note_id: nid.clone(),
                    relative_uri: rel.clone(),
                    snippet: title.clone(),
                    title,
                });
            } else if let Ok(content) = std::fs::read_to_string(root.join(&rel)) {
                if let Some(line) = content.lines().find(|l| l.to_lowercase().contains(&q)) {
                    hits.push(KnowledgeHit {
                        library_id: lib.clone(),
                        library_name: name.clone(),
                        note_id: nid.clone(),
                        relative_uri: rel.clone(),
                        snippet: line.trim().chars().take(200).collect(),
                        title,
                    });
                }
            }
            if hits.len() >= 100 {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

// ---------- 授权与网关 ----------

#[tauri::command]
pub fn kb_grants(project_id: Option<String>) -> Result<Vec<LibraryGrant>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.name, g.projectId, COALESCE(g.readAllowed, 0)
             FROM knowledge_library l
             LEFT JOIN project_library_grant g ON g.libraryId = l.id AND (?1 IS NULL OR g.projectId = ?1)
             ORDER BY l.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id.as_deref()], |r| {
            Ok(LibraryGrant {
                library_id: r.get(0)?,
                library_name: r.get(1)?,
                project_id: r.get(2)?,
                read_allowed: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn kb_grant_set(project_id: String, library_id: String, read_allowed: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    if read_allowed {
        conn.execute(
            "INSERT INTO project_library_grant (projectId, libraryId, readAllowed, updatedAt, actor)
             VALUES (?1,?2,1,?3,'owner')
             ON CONFLICT(projectId, libraryId) DO UPDATE SET readAllowed=1, updatedAt=?3",
            rusqlite::params![project_id, library_id, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "DELETE FROM project_library_grant WHERE projectId=?1 AND libraryId=?2",
            [&project_id, &library_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 网关：解析项目的授权库集合（每次调用实时复检）。
fn authorized_libraries(project_id: Option<&str>) -> Result<Vec<String>, String> {
    match project_id {
        Some(pid) => {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let mut stmt = conn
                .prepare("SELECT libraryId FROM project_library_grant WHERE projectId=?1 AND readAllowed=1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([pid], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
        None => Ok(vec![]), // 无项目身份 → 空授权（默认拒绝）
    }
}

/// knowledge.list：列出项目已授权库。
pub fn gateway_list(project_id: Option<&str>) -> Result<serde_json::Value, String> {
    let libs = authorized_libraries(project_id)?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for lib in libs {
        if let Ok((name, count)) = conn.query_row(
            "SELECT name, (SELECT COUNT(*) FROM knowledge_note_index WHERE libraryId=?1) FROM knowledge_library WHERE id=?1 AND enabled=1",
            [&lib],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        ) {
            out.push(serde_json::json!({ "id": lib, "name": name, "noteCount": count }));
        }
    }
    Ok(serde_json::json!({ "libraries": out }))
}

/// knowledge.search：限定授权库集合内检索。
pub fn gateway_search(project_id: Option<&str>, query: &str) -> Result<serde_json::Value, String> {
    let libs = authorized_libraries(project_id)?;
    if libs.is_empty() {
        return Ok(serde_json::json!({ "hits": [], "denied": true }));
    }
    let hits = kb_search(libs, query.to_string())?;
    Ok(serde_json::json!({ "hits": hits, "denied": false }))
}

/// knowledge.read：读取授权库内笔记（供 AI 会话引用解析复用）。
pub fn gateway_read(project_id: Option<&str>, library_id: &str, note_id: &str) -> Result<String, String> {
    let libs = authorized_libraries(project_id)?;
    if !libs.iter().any(|l| l == library_id) {
        return Err("知识库未授权给当前项目，读取被拒绝".into());
    }
    let note = kb_read(library_id.to_string(), note_id.to_string())?;
    Ok(note.content)
}

#[tauri::command]
pub fn kb_gateway(
    project_id: Option<String>,
    tool: String,
    args_json: Option<String>,
) -> Result<serde_json::Value, String> {
    let args: serde_json::Value = serde_json::from_str(&args_json.unwrap_or_default()).unwrap_or(serde_json::json!({}));
    match tool.as_str() {
        "knowledge.list" => gateway_list(project_id.as_deref()),
        "knowledge.search" => {
            let q = args.get("query").and_then(|v| v.as_str()).ok_or("缺少 query")?;
            gateway_search(project_id.as_deref(), q)
        }
        "knowledge.read" => {
            let lib = args.get("libraryId").and_then(|v| v.as_str()).ok_or("缺少 libraryId")?;
            let note = args.get("noteId").and_then(|v| v.as_str()).ok_or("缺少 noteId")?;
            gateway_read(project_id.as_deref(), lib, note).map(|content| serde_json::json!({ "content": content }))
        }
        "knowledge.read_many" => {
            let libs = authorized_libraries(project_id.as_deref())?;
            let items = args
                .get("notes")
                .and_then(|v| v.as_array())
                .ok_or("缺少 notes")?;
            let mut out = Vec::new();
            for it in items {
                let lib = it.get("libraryId").and_then(|v| v.as_str()).unwrap_or("");
                let note = it.get("noteId").and_then(|v| v.as_str()).unwrap_or("");
                if libs.iter().any(|l| l == lib) {
                    if let Ok(n) = kb_read(lib.to_string(), note.to_string()) {
                        out.push(serde_json::json!({ "noteId": note, "content": n.content }));
                    }
                }
            }
            Ok(serde_json::json!({ "notes": out }))
        }
        other => Err(format!("未知知识工具：{}", other)),
    }
}
