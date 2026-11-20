//! 项目管理与需求树（Markdown 正文 + SQLite 投影，ADR-001）。
//!
//! 需求事实来源：项目 rootUri 下 docs/Plan/ 目录的 Markdown 文件 front matter
//! （id/type/parent/status/owner）。本模块只读解析并重建 requirement_index 投影；
//! 写操作（创建/编辑文档）通过 write_doc 原子写入。

use crate::db;
use crate::models::{now_ms, new_id, Project, RequirementNode};
use std::path::{Path, PathBuf};

#[path = "requirement_sources.rs"]
mod sources;
pub use sources::read_requirement_sources;
pub use sources::__cmd__read_requirement_sources;
pub use sources::__tauri_command_name_read_requirement_sources;

#[tauri::command]
pub fn list_projects() -> Result<Vec<Project>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, type, rootUri, createdAt, updatedAt FROM project ORDER BY updatedAt DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                root_uri: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn create_project(name: String, kind: String, root_uri: String) -> Result<Project, String> {
    if kind != "code" && kind != "work" {
        return Err("项目类型必须是 code 或 work".into());
    }
    let name = validated_project_name(&name)?.to_string();
    let canonical = accessible_project_directory(&root_uri)?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    // 同名校验
    let dup: i64 = conn
        .query_row("SELECT COUNT(*) FROM project WHERE name=?1", [&name], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!("已存在同名项目：{}", name));
    }
    let id = new_id("proj");
    let now = now_ms();
    conn.execute(
        "INSERT INTO project (id, name, type, rootUri, createdAt, updatedAt) VALUES (?1,?2,?3,?4,?5,?5)",
        rusqlite::params![id, name, kind, canonical.to_string_lossy(), now],
    )
    .map_err(|e| e.to_string())?;
    Ok(Project {
        id,
        name,
        kind,
        root_uri: canonical.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub fn update_project(id: String, name: String, root_uri: Option<String>) -> Result<Project, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    update_project_inner(conn, &id, &name, root_uri.as_deref())
}

fn validated_project_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() { return Err("项目名称不能为空".into()); }
    Ok(name)
}

fn accessible_project_directory(root_uri: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(root_uri.trim()).map_err(|_| "项目目录不可访问".to_string())?;
    if !canonical.is_dir() || std::fs::read_dir(&canonical).is_err() {
        return Err("项目根必须是可访问的目录".into());
    }
    Ok(canonical)
}

fn update_project_inner(conn: &rusqlite::Connection, id: &str, name: &str, root_uri: Option<&str>) -> Result<Project, String> {
    let name = validated_project_name(name)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut project = tx.query_row(
        "SELECT id, name, type, rootUri, createdAt, updatedAt FROM project WHERE id=?1", [id],
        |r| Ok(Project { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, root_uri: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)? }),
    ).map_err(|_| "项目不存在".to_string())?;
    let duplicate: i64 = tx.query_row("SELECT COUNT(*) FROM project WHERE trim(name)=?1 AND id<>?2", [name, id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if duplicate > 0 { return Err(format!("已存在同名项目：{}", name)); }
    let root = match root_uri {
        Some(root) => accessible_project_directory(root)?.to_string_lossy().to_string(),
        None => project.root_uri.clone(),
    };
    if root != project.root_uri {
        // root_uri=Some 是确认后更换绑定，不迁移源文件；运行中禁止切换执行根。
        if crate::commands::chat::project_is_running(&tx, id)? {
            return Err("项目会话运行中，停止后才能更换目录".into());
        }
    }
    project.name = name.to_string();
    project.root_uri = root;
    project.updated_at = now_ms();
    tx.execute("UPDATE project SET name=?2, rootUri=?3, updatedAt=?4 WHERE id=?1",
        rusqlite::params![id, project.name, project.root_uri, project.updated_at]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    // 保留 ID/type/会话/授权及旧目录全部内容；索引由 read_requirements 再从新根重建。
    Ok(project)
}

#[tauri::command]
pub fn delete_project(id: String) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM project WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM requirement_index WHERE projectId=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_library_grant WHERE projectId=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn project_root(root_uri: &str) -> Result<PathBuf, String> {
    let p = Path::new(root_uri);
    if !p.is_dir() {
        return Err(format!("项目目录不存在：{}", root_uri));
    }
    Ok(p.to_path_buf())
}

/// 解析一个 Markdown 文件的 front matter（简化 YAML：key: value 逐行）。
fn parse_front_matter(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    if let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) {
        for line in rest.lines() {
            if line.trim() == "---" {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                map.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
            }
        }
    }
    map
}

/// 扫描项目 docs/Plan 下的需求文档，重建 requirement_index 并构建树。
fn scan_requirements(root: &Path, project_id: &str) -> Result<Vec<RequirementNode>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM requirement_index WHERE projectId=?1", [project_id])
        .map_err(|e| e.to_string())?;

    let mut entries: Vec<(String, String, Option<String>, String, Option<String>, Option<String>, String, String)> = Vec::new();
    let plan_dir = root.join("docs").join("Plan");
    let dirs = [
        plan_dir.join("Vision"),
        plan_dir.join("Epic"),
        plan_dir.join("Feature"),
        plan_dir.join("Story"),
        plan_dir.clone(),
    ];
    for dir in dirs.iter() {
        if !dir.is_dir() {
            continue;
        }
        let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        for ent in rd.flatten() {
            let path = ent.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let fm = parse_front_matter(&text);
            let entity_id = match fm.get("id") {
                Some(v) if !v.is_empty() => v.clone(),
                _ => continue, // 没有 id 的文档不进入需求树
            };
            let kind = fm
                .get("type")
                .cloned()
                .or_else(|| fm.get("kind").cloned())
                .unwrap_or_else(|| "story".into());
            let parent = fm.get("parent").cloned();
            let title = fm
                .get("title")
                .cloned()
                .unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string());
            let status = fm.get("status").cloned();
            let owner = fm.get("owner").cloned();
            let source_uri = path.to_string_lossy().to_string();
            let content_hash = format!("{:x}", md5_lite(&text));
            conn.execute(
                "INSERT OR IGNORE INTO requirement_index
                 (projectId, entityId, type, parentId, title, status, owner, sourceUri, contentHash, indexedAt)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                rusqlite::params![project_id, entity_id, kind, parent, title, status, owner, source_uri, content_hash, now_ms()],
            )
            .map_err(|e| e.to_string())?;
            entries.push((entity_id, kind, parent, title, status, owner, source_uri, content_hash));
        }
    }

    // 组树：vision -> epic -> feature -> story/bug
    // 用索引连边，最后从索引递归装配，避免克隆时序导致的子树丢失
    use std::collections::HashMap;
    let idx: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, (eid, _, _, _, _, _, _, _))| (eid.as_str(), i))
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
    let mut is_child: Vec<bool> = vec![false; entries.len()];
    for (i, (_eid, _kind, parent, _, _, _, _, _)) in entries.iter().enumerate() {
        if let Some(p) = parent {
            if let Some(&pi) = idx.get(p.as_str()) {
                if pi != i {
                    children[pi].push(i);
                    is_child[i] = true;
                }
            }
        }
    }
    fn build(
        i: usize,
        entries: &[(String, String, Option<String>, String, Option<String>, Option<String>, String, String)],
        children: &[Vec<usize>],
    ) -> RequirementNode {
        let (eid, kind, parent, title, status, owner, uri, _hash) = &entries[i];
        RequirementNode {
            entity_id: eid.clone(),
            kind: kind.clone(),
            parent_id: parent.clone(),
            title: title.clone(),
            status: status.clone(),
            owner: owner.clone(),
            source_uri: uri.clone(),
            children: children[i].iter().map(|&c| build(c, entries, children)).collect(),
        }
    }
    let mut roots: Vec<RequirementNode> = Vec::new();
    for i in 0..entries.len() {
        if !is_child[i] {
            roots.push(build(i, &entries, &children));
        }
    }
    sort_tree(&mut roots);
    Ok(roots)
}

fn sort_tree(nodes: &mut [RequirementNode]) {
    nodes.sort_by(|a, b| a.entity_id.cmp(&b.entity_id));
    for n in nodes.iter_mut() {
        sort_tree(&mut n.children);
    }
}

fn md5_lite(s: &str) -> u64 {
    // 简易内容指纹（非加密用途，仅用于变更检测）
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 读取项目需求树；同时刷新投影。
#[tauri::command]
pub fn read_requirements(project_id: String) -> Result<Vec<RequirementNode>, String> {
    // 先短锁取 rootUri，再交给 scan_requirements（其内部自取连接，避免重入死锁）
    let root_uri = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT rootUri FROM project WHERE id=?1", [&project_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
    };
    let root = project_root(&root_uri)?;
    scan_requirements(&root, &project_id)
}

/// 读取任意文档正文（需求详情/预览）。
#[tauri::command]
pub fn read_doc(source_uri: String) -> Result<String, String> {
    std::fs::read_to_string(&source_uri).map_err(|e| format!("读取失败：{}", e))
}

/// 原子写文档：先写临时文件再替换（ADR-001 一致性要求）。
#[tauri::command]
pub fn write_doc(source_uri: String, content: String) -> Result<(), String> {
    let path = Path::new(&source_uri);
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写入失败：{}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_preserves_identity_type_data_and_original_directory() {
        let root = std::env::temp_dir().join(new_id("project-test"));
        let old = root.join("old");
        let new = root.join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("user.txt"), "keep").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT,type TEXT,rootUri TEXT,createdAt INTEGER,updatedAt INTEGER);
            CREATE TABLE session(id TEXT,projectId TEXT);
            CREATE TABLE requirement_index(projectId TEXT,entityId TEXT);
            INSERT INTO requirement_index VALUES('p1','story');").unwrap();
        conn.execute("INSERT INTO project VALUES('p1','one','code',?1,1,1),('p2','two','work',?1,1,1)", [old.to_string_lossy().as_ref()]).unwrap();
        assert!(update_project_inner(&conn, "p1", "  ", None).is_err());
        assert!(update_project_inner(&conn, "p1", " two ", None).is_err());
        let renamed = update_project_inner(&conn, "p1", " renamed ", None).unwrap();
        assert_eq!(renamed.name, "renamed");
        assert_eq!(renamed.root_uri, old.to_string_lossy());
        let updated = update_project_inner(&conn, "p1", "renamed", Some(new.to_str().unwrap())).unwrap();
        assert_eq!(updated.id, "p1");
        assert_eq!(updated.kind, "code");
        assert_eq!(updated.created_at, 1);
        assert_eq!(std::fs::read_to_string(old.join("user.txt")).unwrap(), "keep");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM requirement_index", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_root_must_be_accessible_directory_not_file() {
        let root = std::env::temp_dir().join(new_id("project-file-test"));
        std::fs::write(&root, "file").unwrap();
        assert!(accessible_project_directory(root.to_str().unwrap()).is_err());
        std::fs::remove_file(root).unwrap();
        assert!(validated_project_name("\n\t").is_err());
    }
}
