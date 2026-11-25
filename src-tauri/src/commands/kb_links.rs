//! CR-088 / FEAT-009: derived `[[wikilink]]` index, backlinks and rename rewriting.
//! Derived only: source of truth remains the Markdown files. No AI index/grant change.
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLink {
    pub raw: String,
    pub name: String,
    pub heading: Option<String>,
    pub display: Option<String>,
    pub ordinal: usize,
    pub snippet: String,
}

fn line_snippet(content: &str, start: usize) -> String {
    let bytes = content.as_bytes();
    let mut from = start.saturating_sub(80);
    while from > 0 && !content.is_char_boundary(from) { from -= 1; }
    let mut to = (start + 80).min(bytes.len());
    while to < bytes.len() && !content.is_char_boundary(to) { to += 1; }
    let line_from = content[..from].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_to = content[to..].find('\n').map(|i| to + i).unwrap_or(bytes.len());
    content[line_from..line_to].trim().chars().take(160).collect()
}

/// Extract `[[...]]` links outside fenced code blocks. Unclosed/invalid markers stay text.
pub fn extract_links(content: &str) -> Vec<ParsedLink> {
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut fence_marker = String::new();
    let mut ordinal = 0usize;
    let mut cursor = 0usize;
    for line in content.split_inclusive('\n') {
        let start = cursor;
        cursor += line.len();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().take(3).collect::<String>();
            if !in_fence { in_fence = true; fence_marker = marker; }
            else if marker == fence_marker { in_fence = false; }
            continue;
        }
        if in_fence { continue; }
        let mut rest = line;
        let mut offset = start;
        while let Some(open) = rest.find("[[") {
            let after = &rest[open + 2..];
            let Some(close) = after.find("]]") else { break };
            let inner = &after[..close];
            let abs = offset + open;
            let parsed = parse_inner(inner);
            if let Some((name, heading, display)) = parsed {
                out.push(ParsedLink {
                    raw: format!("[[{inner}]]"), name, heading, display,
                    ordinal, snippet: line_snippet(content, abs),
                });
                ordinal += 1;
            }
            offset = abs + 2 + close + 2;
            rest = &rest[open + 2 + close + 2..];
        }
    }
    out
}

fn parse_inner(inner: &str) -> Option<(String, Option<String>, Option<String>)> {
    if inner.trim().is_empty() || inner.contains("[[") || inner.contains("]]") { return None; }
    let (target, display) = match inner.split_once('|') {
        Some((t, d)) => (t, Some(d.trim().to_string())),
        None => (inner, None),
    };
    // Heading-only link `[[#标题]]` is a self anchor; no cross-file target to index.
    let (name, heading) = match target.split_once('#') {
        Some((n, h)) => (n.trim(), if h.trim().is_empty() { None } else { Some(h.trim().to_string()) }),
        None => (target.trim(), None),
    };
    if name.is_empty() { return None; }
    Some((name.to_string(), heading, display))
}

fn basename(path: &str) -> &str { path.rsplit('/').next().unwrap_or(path) }
fn dirname(path: &str) -> &str { path.rsplit_once('/').map(|(d, _)| d).unwrap_or("") }
fn with_md(name: &str) -> String {
    if name.to_ascii_lowercase().ends_with(".md") || name.to_ascii_lowercase().ends_with(".markdown") { name.to_string() } else { format!("{name}.md") }
}
fn safe_relative(name: &str) -> bool {
    !name.starts_with('/') && !name.contains('\\') && !name.contains(':')
        && !name.split('/').any(|p| p.is_empty() || p == "." || p == "..")
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkState { Resolved, Unresolved, Ambiguous }

/// Four-level resolution: exact path > same folder > unique basename > ambiguous.
pub fn resolve_target(name: &str, from_path: &str, paths: &[String]) -> (LinkState, Option<String>) {
    if name.is_empty() || !safe_relative(name) { return (LinkState::Unresolved, None); }
    let lower: Vec<(String, &String)> = paths.iter().map(|p| (p.to_ascii_lowercase(), p)).collect();
    if name.contains('/') {
        let wanted = with_md(name).to_ascii_lowercase();
        if let Some((_, real)) = lower.iter().find(|(l, _)| *l == wanted) { return (LinkState::Resolved, Some((*real).clone())); }
        // Obsidian-style shortest path: accept a unique suffix such as `研究/竞品分析`.
        let suffix = format!("/{wanted}");
        let matches: Vec<&String> = paths.iter().filter(|p| p.to_ascii_lowercase().ends_with(&suffix)).collect();
        return match matches.len() {
            1 => (LinkState::Resolved, Some(matches[0].clone())),
            0 => (LinkState::Unresolved, None),
            _ => (LinkState::Ambiguous, None),
        };
    }
    let file = with_md(name);
    let dir = dirname(from_path);
    let same = if dir.is_empty() { file.clone() } else { format!("{dir}/{file}") };
    if let Some((_, real)) = lower.iter().find(|(l, _)| *l == same.to_ascii_lowercase()) { return (LinkState::Resolved, Some((*real).clone())); }
    let matches: Vec<&String> = paths.iter().filter(|p| basename(p).eq_ignore_ascii_case(&file)).collect();
    match matches.len() {
        1 => (LinkState::Resolved, Some(matches[0].clone())),
        0 => (LinkState::Unresolved, None),
        _ => (LinkState::Ambiguous, None),
    }
}

/// Rewrite links that resolved to `old_rel` so they point at `new_rel`, keeping `|display` and `#heading`.
pub fn rewrite_references(content: &str, old_rel: &str, new_rel: &str, paths: &[String]) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut changed = 0usize;
    let mut rest = content;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else { break };
        let inner = &after[..close];
        out.push_str(&rest[..open]);
        let mut replaced = format!("[[{inner}]]");
        if let Some((name, _heading, _display)) = parse_inner(inner) {
            let (state, target) = resolve_target(&name, new_rel, paths);
            if state == LinkState::Resolved && target.as_deref() == Some(old_rel) {
                let (head, disp) = match inner.split_once('|') {
                    Some((t, d)) => (t.split_once('#').map(|(_, h)| h.trim().to_string()), Some(d.to_string())),
                    None => (inner.split_once('#').map(|(_, h)| h.trim().to_string()), None),
                };
                let mut body = new_rel.trim_end_matches(".md").to_string();
                if let Some(h) = head { if !h.is_empty() { body.push('#'); body.push_str(&h); } }
                if let Some(d) = disp { body.push('|'); body.push_str(&d); }
                replaced = format!("[[{body}]]");
                changed += 1;
            }
        }
        out.push_str(&replaced);
        rest = &rest[open + 2 + close + 2..];
    }
    out.push_str(rest);
    (out, changed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub source_note_id: String,
    pub source_path: String,
    pub source_title: String,
    pub raw_target: String,
    pub heading: Option<String>,
    pub snippet: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    pub raw_target: String,
    pub name: String,
    pub state: String,
    pub target_path: Option<String>,
    pub target_note_id: Option<String>,
    pub heading: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate { pub path: String, pub title: String, pub note_id: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution { pub state: String, pub target_path: Option<String>, pub target_note_id: Option<String>, pub candidates: Vec<Candidate> }

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kb_link (
            libraryId TEXT NOT NULL, sourceNoteId TEXT NOT NULL, sourcePath TEXT NOT NULL,
            sourceRevision TEXT NOT NULL, ordinal INTEGER NOT NULL,
            rawTarget TEXT NOT NULL, name TEXT NOT NULL, targetPath TEXT, targetNoteId TEXT,
            heading TEXT, state TEXT NOT NULL, snippet TEXT NOT NULL,
            PRIMARY KEY (libraryId, sourceNoteId, ordinal)
        );
        CREATE INDEX IF NOT EXISTS kb_link_target ON kb_link(libraryId, targetNoteId);
        CREATE INDEX IF NOT EXISTS kb_link_source ON kb_link(libraryId, sourceNoteId);",
    ).map_err(|e| e.to_string())
}

fn indexed_paths(conn: &Connection, library_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT relativeUri FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([library_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
fn note_id_of(conn: &Connection, library_id: &str, path: &str) -> Option<String> {
    conn.query_row("SELECT noteId FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2",
        [library_id, path], |r| r.get(0)).optional().ok().flatten()
}

/// Replace all link rows for one note (call inside the save transaction).
pub fn replace_for_note(conn: &Connection, library_id: &str, note_id: &str, rel: &str, content: &str) -> Result<usize, String> {
    let paths = indexed_paths(conn, library_id)?;
    conn.execute("DELETE FROM kb_link WHERE libraryId=?1 AND sourceNoteId=?2", [library_id, note_id]).map_err(|e| e.to_string())?;
    let revision = super::files::hash(content.as_bytes());
    let mut n = 0usize;
    for link in extract_links(content) {
        let (state, target) = resolve_target(&link.name, rel, &paths);
        let target_note = target.as_deref().and_then(|p| note_id_of(conn, library_id, p));
        conn.execute(
            "INSERT INTO kb_link(libraryId,sourceNoteId,sourcePath,sourceRevision,ordinal,rawTarget,name,targetPath,targetNoteId,heading,state,snippet)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            rusqlite::params![library_id, note_id, rel, revision, link.ordinal as i64, link.raw, link.name,
                target, target_note, link.heading, state_str(state), link.snippet],
        ).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}
fn state_str(s: LinkState) -> &'static str {
    match s { LinkState::Resolved => "resolved", LinkState::Unresolved => "unresolved", LinkState::Ambiguous => "ambiguous" }
}

/// Rebuild every link row for a library inside the caller's transaction.
pub fn rebuild_tx(conn: &Connection, library_id: &str, root: &mut super::files::SafeRoot) -> Result<usize, String> {
    let paths = indexed_paths(conn, library_id)?;
    conn.execute("DELETE FROM kb_link WHERE libraryId=?1", [library_id]).map_err(|e| e.to_string())?;
    let mut total = 0usize;
    for path in &paths {
        let note_id = note_id_of(conn, library_id, path).unwrap_or_else(|| super::files::file_id(path));
        let content = match super::files::read_text(root, path) { Ok((c, _)) => c, Err(_) => continue };
        total += replace_for_note(conn, library_id, &note_id, path, &content)?;
    }
    Ok(total)
}

/// Rebuild every link row for a library from the currently indexed Markdown contents.
pub fn rebuild_from_root(conn: &Connection, library_id: &str, root: &mut super::files::SafeRoot) -> Result<usize, String> {
    ensure_schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let total = rebuild_tx(&tx, library_id, root)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(total)
}

pub fn backlinks(conn: &Connection, library_id: &str, note_id: &str) -> Result<Vec<Backlink>, String> {
    let mut stmt = conn.prepare(
        "SELECT l.sourceNoteId, l.sourcePath, COALESCE(n.title,l.sourcePath), l.rawTarget, l.heading, l.snippet
         FROM kb_link l LEFT JOIN knowledge_note_index n ON n.libraryId=l.libraryId AND n.noteId=l.sourceNoteId
         WHERE l.libraryId=?1 AND l.targetNoteId=?2 ORDER BY l.sourcePath, l.ordinal").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([library_id, note_id], |r| Ok(Backlink {
        source_note_id: r.get(0)?, source_path: r.get(1)?, source_title: r.get(2)?,
        raw_target: r.get(3)?, heading: r.get(4)?, snippet: r.get(5)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn outgoing(conn: &Connection, library_id: &str, note_id: &str) -> Result<Vec<Outgoing>, String> {
    let mut stmt = conn.prepare(
        "SELECT rawTarget,name,state,targetPath,targetNoteId,heading FROM kb_link
         WHERE libraryId=?1 AND sourceNoteId=?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([library_id, note_id], |r| Ok(Outgoing {
        raw_target: r.get(0)?, name: r.get(1)?, state: r.get(2)?, target_path: r.get(3)?,
        target_note_id: r.get(4)?, heading: r.get(5)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn resolve_query(conn: &Connection, library_id: &str, name: &str, from_path: &str) -> Result<Resolution, String> {
    let paths = indexed_paths(conn, library_id)?;
    let (state, target) = resolve_target(name, from_path, &paths);
    let target_note = target.as_deref().and_then(|p| note_id_of(conn, library_id, p));
    let mut candidates = Vec::new();
    if state == LinkState::Ambiguous {
        let file = with_md(name);
        for path in paths.iter().filter(|p| basename(p).eq_ignore_ascii_case(&file)).take(20) {
            let title = conn.query_row("SELECT title FROM knowledge_note_index WHERE libraryId=?1 AND relativeUri=?2",
                [library_id, path], |r| r.get::<_, String>(0)).optional().ok().flatten();
            candidates.push(Candidate { path: path.clone(), title: title.unwrap_or_else(|| path.clone()), note_id: note_id_of(conn, library_id, path).unwrap_or_default() });
        }
    }
    Ok(Resolution { state: state_str(state).into(), target_path: target, target_note_id: target_note, candidates })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFile { pub path: String, pub count: usize }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePreview { pub affected_files: Vec<RenameFile>, pub total_links: usize }

/// Preview which files/links would change if `old_rel` became `new_rel`.
pub fn rename_preview(conn: &Connection, library_id: &str, old_rel: &str) -> Result<RenamePreview, String> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare("SELECT sourcePath, COUNT(*) FROM kb_link WHERE libraryId=?1 AND targetPath=?2 GROUP BY sourcePath ORDER BY sourcePath")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([library_id, old_rel], |r| Ok(RenameFile { path: r.get(0)?, count: r.get::<_, i64>(1)? as usize }))
        .map_err(|e| e.to_string())?;
    let affected_files = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let total_links = affected_files.iter().map(|f| f.count).sum();
    Ok(RenamePreview { affected_files, total_links })
}

/// Apply link rewriting after a successful rename/move inside the library root.
pub fn apply_move(conn: &Connection, library_id: &str, root: &mut super::files::SafeRoot, old_rel: &str, new_rel: &str) -> Result<usize, String> {
    ensure_schema(conn)?;
    let paths = indexed_paths(conn, library_id)?;
    let sources: Vec<(String, String)> = conn.prepare("SELECT DISTINCT sourceNoteId, sourcePath FROM kb_link WHERE libraryId=?1 AND targetPath=?2")
        .map_err(|e| e.to_string())?.query_map([library_id, old_rel], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let mut changed = 0usize;
    for (note_id, path) in sources {
        let (content, hash) = super::files::read_text(root, &path).map_err(|e| format!("读取 {path} 失败：{e}"))?;
        let (next, count) = rewrite_references(&content, old_rel, new_rel, &paths);
        if count == 0 { continue; }
        super::files::save_markdown(root, &path, &hash, &next)?;
        replace_for_note(conn, library_id, &note_id, &path, &next)?;
        changed += count;
    }
    if old_rel != new_rel {
        if note_id_of(conn, library_id, old_rel).is_some() {
            conn.execute("UPDATE knowledge_note_index SET relativeUri=?1, noteId=?2, title=?3 WHERE libraryId=?4 AND relativeUri=?5",
                rusqlite::params![new_rel, super::files::file_id(new_rel), super::filename(new_rel), library_id, old_rel])
                .map_err(|e| e.to_string())?;
        }
    }
    rebuild_from_root(conn, library_id, root)?;
    Ok(changed)
}

#[tauri::command]
pub fn kb_links_backlinks(library_id: String, note_id: String) -> Result<Vec<Backlink>, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    ensure_schema(conn)?;
    backlinks(conn, &library_id, &note_id)
}
#[tauri::command]
pub fn kb_links_outgoing(library_id: String, note_id: String) -> Result<Vec<Outgoing>, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    ensure_schema(conn)?;
    outgoing(conn, &library_id, &note_id)
}
#[tauri::command]
pub fn kb_links_resolve(library_id: String, name: String, from_path: String) -> Result<Resolution, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    ensure_schema(conn)?;
    resolve_query(conn, &library_id, &name, &from_path)
}
#[tauri::command]
pub fn kb_links_rename_preview(library_id: String, relative_uri: String) -> Result<RenamePreview, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    rename_preview(conn, &library_id, &relative_uri)
}
#[tauri::command]
pub fn kb_links_rebuild(library_id: String) -> Result<usize, String> {
    let _mutation = super::files::MUTATION.lock().map_err(|_| "知识操作锁不可用")?;
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut root = super::enabled_root(conn, &library_id)?;
    rebuild_from_root(conn, &library_id, &mut root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::files;

    fn paths() -> Vec<String> { vec![
        "01-产品/产品定位.md".into(), "01-产品/路线图.md".into(), "02-研究/竞品分析.md".into(),
        "02-研究/周报.md".into(), "01-产品/周报.md".into(), "资料/归档/说明.md".into(),
    ]}

    #[test]
    fn four_level_priority() {
        let p = paths();
        assert_eq!(resolve_target("路线图", "01-产品/产品定位.md", &p), (LinkState::Resolved, Some("01-产品/路线图.md".into())));
        assert_eq!(resolve_target("02-研究/竞品分析", "01-产品/产品定位.md", &p), (LinkState::Resolved, Some("02-研究/竞品分析.md".into())), "完整相对路径");
        assert_eq!(resolve_target("归档/说明", "01-产品/产品定位.md", &p), (LinkState::Resolved, Some("资料/归档/说明.md".into())), "唯一后缀路径");
        assert_eq!(resolve_target("周报", "02-研究/竞品分析.md", &p), (LinkState::Resolved, Some("02-研究/周报.md".into())), "同目录优先");
        assert_eq!(resolve_target("周报", "归档/x.md", &p).0, LinkState::Ambiguous);
        assert_eq!(resolve_target("不存在", "01-产品/产品定位.md", &p).0, LinkState::Unresolved);
        assert_eq!(resolve_target("../evil", "01-产品/产品定位.md", &p).0, LinkState::Unresolved);
    }

    #[test]
    fn extract_skips_fence_and_parses_parts() {
        let md = "a [[路线图]] b [[研究/竞品分析|竞品]] c [[路线图#Q3 目标]]\n```\n[[忽略]]\n```\n";
        let links = extract_links(md);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].name, "路线图");
        assert_eq!(links[1].display.as_deref(), Some("竞品"));
        assert_eq!(links[2].heading.as_deref(), Some("Q3 目标"));
    }

    #[test]
    fn rewrite_keeps_display_and_heading() {
        let p = paths();
        let md = "见 [[周报]] 与 [[周报|本周]] 与 [[周报#要点]] 以及 [[周报x]]";
        let (out, n) = rewrite_references(md, "02-研究/周报.md", "02-研究/周报归档.md", &p);
        assert_eq!(n, 3);
        assert!(out.contains("[[02-研究/周报归档]]"));
        assert!(out.contains("[[02-研究/周报归档|本周]]"));
        assert!(out.contains("[[02-研究/周报归档#要点]]"));
        assert!(out.contains("[[周报x]]"), "未解析链接不得改动");
    }

    #[test]
    fn schema_and_links_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER);").unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO knowledge_note_index VALUES('lib','n1','产品定位','01-产品/产品定位.md','h',1)", []).unwrap();
        conn.execute("INSERT INTO knowledge_note_index VALUES('lib','n2','路线图','01-产品/路线图.md','h',1)", []).unwrap();
        replace_for_note(&conn, "lib", "n1", "01-产品/产品定位.md", "见 [[路线图]] 与 [[不存在]]").unwrap();
        let out = outgoing(&conn, "lib", "n1").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].state, "resolved");
        assert_eq!(out[1].state, "unresolved");
        let back = backlinks(&conn, "lib", "n2").unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].source_title, "产品定位");
        let r = resolve_query(&conn, "lib", "路线图", "02-研究/x.md").unwrap();
        assert_eq!(r.state, "resolved");
        assert_eq!(r.target_note_id.as_deref(), Some("n2"));
    }

    #[test]
    fn apply_move_rewrites_sources_and_rebuilds_backlinks() {
        use std::fs;
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(crate::models::new_id("cr088-move"));
        fs::create_dir_all(base.join("01")).unwrap();
        fs::write(base.join("01/目标.md"), "# 目标\n").unwrap();
        fs::write(base.join("01/引用.md"), "见 [[目标]] 与 [[目标|别名]]\n").unwrap();
        let mut root = files::SafeRoot::new(&base).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER);").unwrap();
        ensure_schema(&conn).unwrap();
        let target_id = files::file_id("01/目标.md");
        let src_id = files::file_id("01/引用.md");
        conn.execute("INSERT INTO knowledge_note_index VALUES('lib',?1,'目标','01/目标.md','h',1)", [&target_id]).unwrap();
        conn.execute("INSERT INTO knowledge_note_index VALUES('lib',?1,'引用','01/引用.md','h',1)", [&src_id]).unwrap();
        replace_for_note(&conn, "lib", &src_id, "01/引用.md", "见 [[目标]] 与 [[目标|别名]]").unwrap();
        fs::rename(base.join("01/目标.md"), base.join("01/目标2.md")).unwrap();
        let changed = apply_move(&conn, "lib", &mut root, "01/目标.md", "01/目标2.md").unwrap();
        assert_eq!(changed, 2);
        let text = fs::read_to_string(base.join("01/引用.md")).unwrap();
        assert!(text.contains("[[01/目标2]]"), "{text}");
        assert!(text.contains("[[01/目标2|别名]]"), "{text}");
        let new_id = files::file_id("01/目标2.md");
        assert_eq!(backlinks(&conn, "lib", &new_id).unwrap().len(), 2);
        drop(root);
        let _ = fs::remove_dir_all(&base);
    }
}
