//! CR-089 / FEAT-009: read-only knowledge graph projection over the derived
//! `[[wikilink]]` index (`kb_link`) and the Markdown index (`knowledge_note_index`).
//!
//! Pure projection: no body text is returned, only id/label/path/kind/degree so the
//! front-end can lay out a lightweight force-directed canvas without new dependencies.
//! No AI index/grant change; disabled or missing libraries never return an empty graph
//! that could be mistaken for a successful empty result.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

/// Hard caps so a giant library cannot flood the canvas or the IPC payload.
pub const MAX_NODES: usize = 200;
pub const MAX_EDGES: usize = 400;
const DEFAULT_DEPTH: u32 = 1;
const DEPTH_CAP: u32 = 3;
const MISSING_PREFIX: &str = "missing:";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub path: String,
    /// `note` | `attachment` | `missing`
    pub kind: String,
    pub degree: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// Original `[[...]]` text for unresolved edges, display label otherwise.
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
    /// Center note id of a local graph, or `None` for a whole-library overview.
    pub note_id: Option<String>,
    /// Non-fatal notice (e.g. attachments unavailable, source could not be read).
    pub message: Option<String>,
}

/// Options resolved from the command parameters. Kept separate from serde so the
/// core stays callable from unit tests without Tauri arg plumbing.
#[derive(Debug, Clone, Copy)]
pub struct GraphOptions {
    pub note_id_required: bool,
    pub depth: u32,
    pub include_attachments: bool,
    pub only_unresolved: bool,
}

impl GraphOptions {
    pub fn new(note_id: Option<&str>, depth: Option<u32>, include_attachments: Option<bool>, only_unresolved: Option<bool>) -> Self {
        let depth = depth.unwrap_or(DEFAULT_DEPTH).clamp(1, DEPTH_CAP);
        Self {
            note_id_required: note_id.map(|s| !s.trim().is_empty()).unwrap_or(false),
            depth,
            include_attachments: include_attachments.unwrap_or(false),
            only_unresolved: only_unresolved.unwrap_or(false),
        }
    }
}

/// A note row from the derived index.
#[derive(Debug, Clone)]
struct NoteRow {
    id: String,
    title: String,
    path: String,
}

fn note_title(title: &str, path: &str) -> String {
    let t = title.trim();
    if !t.is_empty() { return t.to_string(); }
    let stem = path.rsplit('/').next().unwrap_or(path);
    stem.trim_end_matches(".md").trim_end_matches(".markdown").to_string()
}

fn all_notes(conn: &Connection, library_id: &str) -> Result<Vec<NoteRow>, String> {
    let mut stmt = conn
        .prepare("SELECT noteId,title,relativeUri FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let path: String = r.get(2)?;
            Ok(NoteRow { id, title, path })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// One resolved link row used for graph adjacency.
#[derive(Debug, Clone)]
struct ResolvedLink {
    source: String,
    target: String,
}

/// One unresolved link row: source note plus the raw `[[...]]` target text.
#[derive(Debug, Clone)]
struct UnresolvedLink {
    source: String,
    raw: String,
    name: String,
}

fn resolved_links(conn: &Connection, library_id: &str) -> Result<Vec<ResolvedLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT sourceNoteId, targetNoteId FROM kb_link
             WHERE libraryId=?1 AND targetNoteId IS NOT NULL
             ORDER BY sourceNoteId, ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id], |r| Ok(ResolvedLink { source: r.get(0)?, target: r.get(1)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn unresolved_links(conn: &Connection, library_id: &str) -> Result<Vec<UnresolvedLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT sourceNoteId, rawTarget, name FROM kb_link
             WHERE libraryId=?1 AND targetNoteId IS NULL AND state='unresolved'
             ORDER BY sourceNoteId, ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id], |r| {
            Ok(UnresolvedLink { source: r.get(0)?, raw: r.get(1)?, name: r.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// BFS the resolved adjacency from `start`, keeping notes within `depth` hops.
/// Undirected: both outgoing and incoming resolved links are followed.
fn neighborhood(links: &[ResolvedLink], start: &str, depth: u32) -> std::collections::HashSet<String> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for l in links {
        adj.entry(l.source.as_str()).or_default().push(l.target.as_str());
        adj.entry(l.target.as_str()).or_default().push(l.source.as_str());
    }
    let mut seen = HashSet::new();
    seen.insert(start.to_string());
    let mut queue = VecDeque::new();
    queue.push_back((start.to_string(), 0u32));
    while let Some((node, d)) = queue.pop_front() {
        if d >= depth { continue; }
        if let Some(neighbors) = adj.get(node.as_str()) {
            for &next in neighbors {
                if seen.insert(next.to_string()) {
                    queue.push_back((next.to_string(), d + 1));
                }
            }
        }
    }
    seen
}

/// An attachment entry projected into the graph (rel path + file id).
#[derive(Debug, Clone)]
pub struct AttachmentEntry {
    pub rel: String,
    pub id: String,
}

/// Map an attachment rel path to the note that references it, if any `kb_link`
/// row's resolved target path equals the attachment path. Attachments are shown as
/// detached only when no such reference exists — this keeps the graph honest.
fn attachments_referenced_by(conn: &Connection, library_id: &str, rel: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT sourceNoteId FROM kb_link
             WHERE libraryId=?1 AND targetPath=?2 AND targetNoteId IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id, rel], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Core graph builder over an open connection. Pure read; caller handles library
/// validation and attachment enumeration.
pub fn build_graph(
    conn: &Connection,
    library_id: &str,
    note_id: Option<&str>,
    opts: GraphOptions,
    attachments: &[AttachmentEntry],
) -> Result<GraphData, String> {
    let notes = all_notes(conn, library_id)?;
    let by_id: std::collections::HashMap<String, NoteRow> =
        notes.iter().map(|n| (n.id.clone(), n.clone())).collect();

    // Whole library overview: every indexed note. Local graph: BFS neighborhood.
    let links = resolved_links(conn, library_id)?;
    let center: Option<String> = match note_id {
        Some(id) if !id.trim().is_empty() => {
            if !by_id.contains_key(id) {
                return Err("KB_NOTE_NOT_FOUND: 笔记不在当前索引中".to_string());
            }
            Some(id.to_string())
        }
        _ => None,
    };

    let mut included: Vec<String> = match &center {
        Some(id) => {
            let set = neighborhood(&links, id, opts.depth);
            notes.iter().filter(|n| set.contains(&n.id)).map(|n| n.id.clone()).collect()
        }
        None => notes.iter().map(|n| n.id.clone()).collect(),
    };
    // Deterministic order by path so truncation is stable.
    included.sort_by(|a, b| by_id[a].path.cmp(&by_id[b].path));

    let mut truncated = false;
    if included.len() > MAX_NODES {
        included.truncate(MAX_NODES);
        truncated = true;
    }
    let included_set: std::collections::HashSet<&String> = included.iter().collect();

    // Build nodes for the resolved-note set.
    let mut nodes: Vec<GraphNode> = included
        .iter()
        .map(|id| {
            let n = &by_id[id];
            GraphNode {
                id: n.id.clone(),
                label: note_title(&n.title, &n.path),
                path: n.path.clone(),
                kind: "note".to_string(),
                degree: 0,
            }
        })
        .collect();

    let mut edges: Vec<GraphEdge> = Vec::new();

    if opts.only_unresolved {
        // Unresolved-only view: source note + virtual `missing:<name>` target.
        let unresolved = unresolved_links(conn, library_id)?;
        let mut missing_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut missing_nodes: Vec<GraphNode> = Vec::new();
        for u in &unresolved {
            if !included_set.contains(&u.source) { continue; }
            let vid = format!("{MISSING_PREFIX}{}", u.name);
            if missing_seen.insert(vid.clone()) {
                if nodes.len() + missing_nodes.len() >= MAX_NODES {
                    truncated = true;
                    break;
                }
                missing_nodes.push(GraphNode {
                    id: vid.clone(),
                    label: u.name.clone(),
                    path: String::new(),
                    kind: "missing".to_string(),
                    degree: 0,
                });
            }
            if edges.len() >= MAX_EDGES {
                truncated = true;
                break;
            }
            edges.push(GraphEdge { source: u.source.clone(), target: vid, label: u.raw.clone() });
        }
        nodes.extend(missing_nodes);
    } else {
        // Resolved edges where both endpoints are rendered.
        for l in &links {
            if !included_set.contains(&l.source) || !included_set.contains(&l.target) { continue; }
            if edges.len() >= MAX_EDGES {
                truncated = true;
                break;
            }
            let src_label = note_title(&by_id[&l.source].title, &by_id[&l.source].path);
            edges.push(GraphEdge { source: l.source.clone(), target: l.target.clone(), label: src_label });
        }

        // Optional attachments: shown only when referenced by a rendered note.
        if opts.include_attachments {
            for att in attachments {
                if nodes.len() >= MAX_NODES { truncated = true; break; }
                let refs = attachments_referenced_by(conn, library_id, &att.rel)?;
                let rendered: Vec<&String> = refs.iter().filter(|id| included_set.contains(*id)).collect();
                if rendered.is_empty() { continue; }
                let label = att.rel.rsplit('/').next().unwrap_or(&att.rel).to_string();
                nodes.push(GraphNode {
                    id: att.id.clone(),
                    label,
                    path: att.rel.clone(),
                    kind: "attachment".to_string(),
                    degree: 0,
                });
                for src in rendered {
                    if edges.len() >= MAX_EDGES { truncated = true; break; }
                    edges.push(GraphEdge { source: src.clone(), target: att.id.clone(), label: String::new() });
                }
            }
        }
    }

    // Degree from rendered edges (both kinds).
    let mut degree: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for e in &edges {
        *degree.entry(e.source.as_str()).or_default() += 1;
        *degree.entry(e.target.as_str()).or_default() += 1;
    }
    for n in nodes.iter_mut() {
        n.degree = *degree.get(n.id.as_str()).unwrap_or(&0);
    }

    Ok(GraphData { nodes, edges, truncated, note_id: center, message: None })
}

/// Tauri entry point. Validates the library is enabled=1 before touching indexes;
/// an unknown/disabled library must not masquerade as a successful empty graph.
#[tauri::command]
pub fn kb_graph(
    library_id: String,
    note_id: Option<String>,
    depth: Option<u32>,
    include_attachments: Option<bool>,
    only_unresolved: Option<bool>,
) -> Result<GraphData, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;

    let enabled: Option<i64> = conn
        .query_row(
            "SELECT enabled FROM knowledge_library WHERE id=?1",
            [&library_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match enabled {
        Some(1) => {}
        _ => return Err("KB_LIBRARY_UNAVAILABLE: 知识库不存在或已禁用".to_string()),
    }

    let opts = GraphOptions::new(note_id.as_deref(), depth, include_attachments, only_unresolved);

    let mut attachments: Vec<AttachmentEntry> = Vec::new();
    let mut message: Option<String> = None;
    if opts.include_attachments {
        match super::enabled_root(conn, &library_id) {
            Ok(mut root) => match super::files::entries(&mut root) {
                Ok(entries) => {
                    for e in entries {
                        if e.is_dir { continue; }
                        if super::files::markdown(std::path::Path::new(&e.rel)) { continue; }
                        attachments.push(AttachmentEntry {
                            id: super::files::file_id(&e.rel),
                            rel: e.rel,
                        });
                    }
                }
                Err(err) => {
                    message = Some(format!("附件不可枚举，仅返回笔记节点：{err}"));
                }
            },
            Err(err) => {
                message = Some(format!("附件不可枚举，仅返回笔记节点：{err}"));
            }
        }
    }

    let mut data = build_graph(conn, &library_id, note_id.as_deref(), opts, &attachments)?;
    if message.is_some() {
        data.message = message;
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory SQLite with hand-built `knowledge_note_index` + `kb_link`.
    /// 3 notes, 2 resolved edges and 1 unresolved link.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE knowledge_note_index(
                libraryId TEXT, noteId TEXT, title TEXT, relativeUri TEXT,
                contentHash TEXT, updatedAt INTEGER);
             CREATE TABLE kb_link(
                libraryId TEXT NOT NULL, sourceNoteId TEXT NOT NULL, sourcePath TEXT NOT NULL,
                sourceRevision TEXT NOT NULL, ordinal INTEGER NOT NULL,
                rawTarget TEXT NOT NULL, name TEXT NOT NULL, targetPath TEXT, targetNoteId TEXT,
                heading TEXT, state TEXT NOT NULL, snippet TEXT NOT NULL,
                PRIMARY KEY (libraryId, sourceNoteId, ordinal));",
        )
        .unwrap();
        for (id, title, rel) in [
            ("n-a", "产品定位", "01/产品定位.md"),
            ("n-b", "路线图", "01/路线图.md"),
            ("n-c", "竞品分析", "02/竞品分析.md"),
        ] {
            conn.execute(
                "INSERT INTO knowledge_note_index VALUES('lib',?1,?2,?3,'h',0)",
                rusqlite::params![id, title, rel],
            )
            .unwrap();
        }
        // a -> b resolved, b -> c resolved, a -> 不存在 unresolved
        let link = |src: &str, src_path: &str, ord: i64, raw: &str, name: &str, tp: Option<&str>, tn: Option<&str>, state: &str| {
            conn.execute(
                "INSERT INTO kb_link VALUES('lib',?1,?2,'rev',?3,?4,?5,?6,?7,NULL,?8,'snip')",
                rusqlite::params![src, src_path, ord, raw, name, tp, tn, state],
            )
            .unwrap();
        };
        link("n-a", "01/产品定位.md", 0, "[[路线图]]", "路线图", Some("01/路线图.md"), Some("n-b"), "resolved");
        link("n-b", "01/路线图.md", 0, "[[竞品分析]]", "竞品分析", Some("02/竞品分析.md"), Some("n-c"), "resolved");
        link("n-a", "01/产品定位.md", 1, "[[不存在]]", "不存在", None, None, "unresolved");
        conn
    }

    fn opts(note_id: Option<&str>, depth: Option<u32>, att: bool, unresolved: bool) -> GraphOptions {
        GraphOptions::new(note_id, depth, Some(att), Some(unresolved))
    }

    #[test]
    fn whole_library_graph_has_three_nodes_two_edges() {
        let conn = fixture();
        let g = build_graph(&conn, "lib", None, opts(None, None, false, false), &[]).unwrap();
        assert_eq!(g.nodes.len(), 3, "全部笔记节点");
        assert_eq!(g.edges.len(), 2, "两条 resolved 边");
        assert!(g.nodes.iter().all(|n| n.kind == "note"));
        assert!(g.edges.iter().all(|e| e.label.contains("产品定位") || e.label.contains("路线图")));
        assert!(!g.truncated);
        // Degree: a=1, b=2, c=1
        let deg = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().degree;
        assert_eq!((deg("n-a"), deg("n-b"), deg("n-c")), (1, 2, 1));
        // No body text anywhere.
        assert!(g.nodes.iter().all(|n| !n.path.contains("正文")));
    }

    #[test]
    fn local_depth_one_excludes_two_hop_note() {
        let conn = fixture();
        // From a at depth 1: a, b. c is 2 hops via b -> excluded.
        let g1 = build_graph(&conn, "lib", Some("n-a"), opts(Some("n-a"), Some(1), false, false), &[]).unwrap();
        let ids1: Vec<&str> = g1.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids1.len(), 2);
        assert!(ids1.contains(&"n-a") && ids1.contains(&"n-b") && !ids1.contains(&"n-c"));
        assert_eq!(g1.edges.len(), 1);
        assert_eq!(g1.note_id.as_deref(), Some("n-a"));
        // Depth 2 reaches c.
        let g2 = build_graph(&conn, "lib", Some("n-a"), opts(Some("n-a"), Some(2), false, false), &[]).unwrap();
        assert_eq!(g2.nodes.len(), 3);
        assert_eq!(g2.edges.len(), 2);
    }

    #[test]
    fn depth_is_clamped_by_options() {
        // depth 9 clamps to 3, depth 0 clamps to 1 — assert via GraphOptions.
        assert_eq!(GraphOptions::new(Some("x"), Some(9), None, None).depth, 3);
        assert_eq!(GraphOptions::new(Some("x"), Some(0), None, None).depth, 1);
        assert_eq!(GraphOptions::new(Some("x"), None, None, None).depth, 1);
    }

    #[test]
    fn only_unresolved_returns_virtual_missing_node() {
        let conn = fixture();
        let g = build_graph(&conn, "lib", None, opts(None, None, false, true), &[]).unwrap();
        assert!(g.edges.len() == 1);
        assert_eq!(g.edges[0].source, "n-a");
        assert_eq!(g.edges[0].label, "[[不存在]]", "保留原始链接文本");
        let missing = g.nodes.iter().find(|n| n.kind == "missing").expect("虚拟缺失节点");
        assert_eq!(missing.id, "missing:不存在");
        assert_eq!(missing.label, "不存在");
        assert_eq!(g.edges[0].target, "missing:不存在");
    }

    #[test]
    fn truncation_caps_nodes_and_sets_flag() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE knowledge_note_index(libraryId TEXT, noteId TEXT, title TEXT, relativeUri TEXT, contentHash TEXT, updatedAt INTEGER);
             CREATE TABLE kb_link(libraryId TEXT, sourceNoteId TEXT, sourcePath TEXT, sourceRevision TEXT, ordinal INTEGER, rawTarget TEXT, name TEXT, targetPath TEXT, targetNoteId TEXT, heading TEXT, state TEXT, snippet TEXT);",
        )
        .unwrap();
        // 250 notes -> node cap 200, truncated=true.
        for i in 0..250 {
            let rel = format!("n/{i:03}.md");
            conn.execute(
                "INSERT INTO knowledge_note_index VALUES('lib',?1,?2,?3,'h',0)",
                rusqlite::params![format!("id-{i:03}"), format!("笔记{i:03}"), rel],
            )
            .unwrap();
        }
        let g = build_graph(&conn, "lib", None, opts(None, None, false, false), &[]).unwrap();
        assert_eq!(g.nodes.len(), MAX_NODES);
        assert!(g.truncated);
    }

    #[test]
    fn unknown_center_note_is_an_error_not_empty_graph() {
        let conn = fixture();
        let err = build_graph(&conn, "lib", Some("n-zzz"), opts(Some("n-zzz"), Some(1), false, false), &[]).unwrap_err();
        assert!(err.starts_with("KB_NOTE_NOT_FOUND"), "实际：{err}");
    }

    #[test]
    fn attachments_only_attach_when_referenced() {
        let conn = fixture();
        // 竞品.png is referenced by... nothing resolved to it in fixture, so should not appear.
        let att = vec![AttachmentEntry { id: "att-x".to_string(), rel: "02/竞品.png".to_string() }];
        let g = build_graph(&conn, "lib", None, opts(None, None, true, false), &att).unwrap();
        assert!(g.nodes.iter().all(|n| n.kind == "note"), "未引用的附件不进入图");
    }
}
