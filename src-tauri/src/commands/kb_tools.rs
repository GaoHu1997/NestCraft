//! CR-089（FEAT-009）内置知识库工具子流：进程内 5 个只读知识工具。
//!
//! 定位：由主代理注册到工作台 MCP 工具目录 / 平台 AI 运行时，供 AI 直接调用；
//! 不经 MCP 客户端子进程、不走网络。语义通道经 `HYBRID_SEARCH` 函数指针解耦——
//! `kb_semantic` 可能尚未就绪，未 set 时只用关键词并标 `degraded`。
//!
//! 设计依据：docs/LLD/LLD-CR089-知识库图谱与语义实现.md §4。
//! 统一约束（与 UI 命令同一套安全语义，但预算更小）：
//! - 权限：每次校验库 `enabled=1`；带 `projectId` 时必须 `project_library_grant.readAllowed=1`，
//!   否则 `KB_ACCESS_DENIED`。所有者路径（无 projectId）不要求项目授权。
//! - 预算：read ≤65536 字节；search/list ≤20 条；片段 ≤200 字；graph 节点 ≤50、边 ≤100。
//! - 审计：设置环境变量 `CR089_AUDIT_LOG` 时追加一行（时间/工具/library/note/条数/是否拒绝）；
//!   未设置不写文件；写失败静默。
//! - 不返回整篇正文；read 按偏移读文本，UTF-8 边界错位向前/后对齐，不 panic。
//!
//! 文件归属：本文件仅由 CR-089 内置工具子流维护，不改动他人文件。

use rusqlite::Connection;
use serde_json::{json, Value};

// ==================== 语义解耦（函数指针） ====================

/// 混合检索命中（关键词 + 语义融合后的统一结果；切片已由实现方限制到预算内）。
/// 语义实现方（kb_semantic）负责产出该结构；本模块只消费。
#[derive(Debug, Clone)]
pub struct KbHit {
    pub library_id: String,
    pub note_id: String,
    pub title: String,
    pub relative_uri: String,
    /// 片段（本模块会再截到 ≤200 字）。
    pub snippet: String,
    /// 命中来源：keyword | semantic | both。
    pub source: String,
}

/// 混合检索函数指针：`(conn, library_id, query, limit) -> Result<Vec<KbHit>, String>`。
/// 只在已启用、已授权的单个库内检索；跨库合并由本模块负责。
pub type HybridSearchFn = fn(&Connection, &str, &str, usize) -> Result<Vec<KbHit>, String>;

/// 由主代理在 `kb_semantic` 就绪后 set 到其 `hybrid_search` 适配器。
/// 未 set：只用关键词通道，并在结果里标 `degraded=true`、`semantic="unavailable"`。
pub static HYBRID_SEARCH: std::sync::OnceLock<HybridSearchFn> = std::sync::OnceLock::new();

// ==================== 预算常量 ====================

/// read 单次返回正文上限（UTF-8 字节），与 chat.rs `MAX_REF_TEXT` 同值。
pub const READ_MAX_BYTES: usize = 64 * 1024;
/// search / list 单次返回条数上限。
pub const LIST_MAX_ITEMS: usize = 20;
/// search 片段字符（Unicode 码点）上限。
pub const SNIPPET_MAX_CHARS: usize = 200;
/// graph 节点上限（比 UI 的 200 更小）。
pub const GRAPH_MAX_NODES: usize = 50;
/// graph 边上限（比 UI 的 400 更小）。
pub const GRAPH_MAX_EDGES: usize = 100;
/// graph depth 上限。
pub const GRAPH_MAX_DEPTH: usize = 3;

// ==================== 工具定义 ====================

/// 工具规格（供主代理拼装 MCP/平台工具目录条目）。
pub struct KbToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

fn schema_obj(props: Value, required: &[&str]) -> Value {
    let mut schema = json!({ "type": "object", "properties": props, "additionalProperties": false });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// 5 个内置知识工具的名称/说明/参数 schema。
pub fn specs() -> Vec<KbToolSpec> {
    vec![
        KbToolSpec {
            name: "knowledge_search",
            description: "在已授权且启用的知识库内做只读检索（关键词 + 可选语义混合）。返回命中摘要，不含整篇正文。",
            parameters: schema_obj(
                json!({
                    "query": { "type": "string", "description": "检索词" },
                    "libraryId": { "type": "string", "description": "限定单个库；省略＝全部可见库" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "description": "返回条数上限，默认 10" },
                    "projectId": { "type": "string", "description": "项目上下文；带此参数时逐库复检读取授权" }
                }),
                &["query"],
            ),
        },
        KbToolSpec {
            name: "knowledge_read",
            description: "按偏移读取知识库笔记正文切片（只读，不返回整篇正文）。每次调用复检库启用与项目授权。",
            parameters: schema_obj(
                json!({
                    "noteId": { "type": "string", "description": "笔记稳定 ID（命中结果中的 noteId）" },
                    "offset": { "type": "integer", "minimum": 0, "description": "起始字节偏移，默认 0；落在多字节字符中间时自动向后对齐" },
                    "length": { "type": "integer", "minimum": 1, "maximum": 65536, "description": "读取字节数上限，默认 8192；超出 65536 按 65536 截断" },
                    "projectId": { "type": "string", "description": "项目上下文；带此参数时复检读取授权" }
                }),
                &["noteId"],
            ),
        },
        KbToolSpec {
            name: "knowledge_links",
            description: "查询某笔记的出链与反链（基于双链索引）。只读，不返回正文。",
            parameters: schema_obj(
                json!({
                    "noteId": { "type": "string", "description": "笔记稳定 ID" },
                    "projectId": { "type": "string", "description": "项目上下文；带此参数时复检读取授权" }
                }),
                &["noteId"],
            ),
        },
        KbToolSpec {
            name: "knowledge_graph",
            description: "按笔记展开知识图谱邻域（节点/边），depth 1..3，节点≤50、边≤100，超限截断并标记。只读。",
            parameters: schema_obj(
                json!({
                    "noteId": { "type": "string", "description": "中心笔记 ID；省略时返回库内整体概览图（受同一预算）" },
                    "depth": { "type": "integer", "minimum": 1, "maximum": 3, "description": "展开深度，默认 1" },
                    "onlyUnresolved": { "type": "boolean", "description": "仅保留未解析链接（missing:<name> 虚拟目标）" },
                    "libraryId": { "type": "string", "description": "库；省略时按 noteId 定位" },
                    "projectId": { "type": "string", "description": "项目上下文；带此参数时复检读取授权" }
                }),
                &[],
            ),
        },
        KbToolSpec {
            name: "knowledge_list",
            description: "列出知识库某目录下的条目（名称/路径/类型/大小），≤20 条，不含正文。",
            parameters: schema_obj(
                json!({
                    "libraryId": { "type": "string", "description": "知识库 ID" },
                    "folder": { "type": "string", "description": "相对目录路径；省略＝根目录" },
                    "projectId": { "type": "string", "description": "项目上下文；带此参数时复检读取授权" }
                }),
                &["libraryId"],
            ),
        },
    ]
}

// ==================== 公共辅助 ====================

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn req_str(args: &Value, key: &str) -> Result<String, String> {
    str_arg(args, key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("缺少必填参数：{key}"))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    str_arg(args, key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn opt_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|v| v as usize)
}

/// 库 enabled=1 校验。库不存在/停用统一报 `KB_LIBRARY_UNAVAILABLE`。
fn ensure_library_enabled(conn: &Connection, library_id: &str) -> Result<(), String> {
    let enabled: i64 = conn
        .query_row(
            "SELECT enabled FROM knowledge_library WHERE id=?1",
            [library_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("KB_LIBRARY_UNAVAILABLE：知识库不存在或已停用：{library_id}"))?;
    if enabled == 0 {
        return Err(format!("KB_LIBRARY_UNAVAILABLE：知识库已停用：{library_id}"));
    }
    Ok(())
}

/// 项目读取授权校验：`project_library_grant.readAllowed=1` 且库启用，否则 `KB_ACCESS_DENIED`。
fn ensure_project_grant(conn: &Connection, project_id: &str, library_id: &str) -> Result<(), String> {
    let allowed: Option<i64> = conn
        .query_row(
            "SELECT g.readAllowed FROM project_library_grant g
             JOIN knowledge_library l ON l.id=g.libraryId
             WHERE g.projectId=?1 AND g.libraryId=?2 AND l.enabled=1",
            [project_id, library_id],
            |r| r.get(0),
        )
        .ok();
    match allowed {
        Some(v) if v != 0 => Ok(()),
        _ => Err(format!(
            "KB_ACCESS_DENIED：项目 {project_id} 未授权读取知识库 {library_id}"
        )),
    }
}

/// 统一权限校验：先查库启用；若带 projectId 再查项目授权。
fn check_access(conn: &Connection, library_id: &str, project_id: Option<&str>) -> Result<(), String> {
    ensure_library_enabled(conn, library_id)?;
    if let Some(pid) = project_id {
        ensure_project_grant(conn, pid, library_id)?;
    }
    Ok(())
}

/// 可见库集合（带 projectId=该项目授权库；无=全部启用库）。已按 enabled=1 过滤。
fn visible_libraries(conn: &Connection, project_id: Option<&str>) -> Result<Vec<String>, String> {
    match project_id {
        Some(pid) => super::authorized(conn, Some(pid)),
        None => {
            let mut stmt = conn
                .prepare("SELECT id FROM knowledge_library WHERE enabled=1 ORDER BY id")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        }
    }
}

// ==================== 审计 ====================

/// 审计：设置 `CR089_AUDIT_LOG` 时追加一行 TSV；未设置/写失败静默。
fn audit(tool: &str, library: Option<&str>, note: Option<&str>, count: usize, denied: bool, reason: &str) {
    let Ok(path) = std::env::var("CR089_AUDIT_LOG") else { return };
    if path.trim().is_empty() {
        return;
    }
    let ts = crate::models::now_ms();
    let lib = library.unwrap_or("-");
    let nid = note.unwrap_or("-");
    let verdict = if denied { "DENY" } else { "ALLOW" };
    let line = format!(
        "{ts}\t{tool}\t{lib}\t{nid}\t{count}\t{verdict}\t{}\n",
        reason.replace(['\t', '\n', '\r'], " ")
    );
    // 追加写；失败静默（不因审计影响业务）。
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

// ==================== search ====================

/// 截断片段到 ≤200 个 Unicode 码点，不做字节切分。
fn clip_snippet(s: &str) -> String {
    if s.chars().count() <= SNIPPET_MAX_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(SNIPPET_MAX_CHARS).collect();
    out.push('…');
    out
}

fn tool_search(conn: &Connection, args: &Value) -> Result<Value, String> {
    let query = req_str(args, "query")?;
    let project_id = opt_str(args, "projectId");
    let limit = opt_usize(args, "limit").unwrap_or(10).clamp(1, LIST_MAX_ITEMS);

    // 候选库：显式 libraryId 时先校验该库权限；否则用可见库集合。
    let libraries: Vec<String> = match opt_str(args, "libraryId") {
        Some(lib) => {
            check_access(conn, &lib, project_id.as_deref())?;
            vec![lib]
        }
        None => visible_libraries(conn, project_id.as_deref())?,
    };

    // 关键词通道（与 UI 命令同一套检索实现）。
    let mut hits: Vec<KbHit> = Vec::new();
    let mut degraded = false;
    let mut reasons: Vec<String> = Vec::new();

    for lib in &libraries {
        // 逐库复检（授权集合可能变化；显式库已校验但不影响此处幂等校验）。
        if let Err(e) = check_access(conn, lib, project_id.as_deref()) {
            reasons.push(e);
            continue;
        }
        match HYBRID_SEARCH.get() {
            Some(hybrid) => match hybrid(conn, lib, &query, limit) {
                Ok(mut got) => hits.append(&mut got),
                Err(e) => {
                    // 语义/混合通道失败 → 回落关键词并标 degraded。
                    degraded = true;
                    reasons.push(format!("hybrid:{e}"));
                    keyword_only(conn, lib, &query, limit, &mut hits, &mut reasons)?;
                }
            },
            None => {
                degraded = true;
                keyword_only(conn, lib, &query, limit, &mut hits, &mut reasons)?;
            }
        }
    }

    // 去重（同库同笔记保留首个）并截断到 limit / 片段 ≤200 字。
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for h in hits {
        let key = (h.library_id.clone(), h.note_id.clone());
        if !seen.insert(key) {
            continue;
        }
        out.push(json!({
            "libraryId": h.library_id,
            "noteId": h.note_id,
            "title": h.title,
            "relativeUri": h.relative_uri,
            "snippet": clip_snippet(&h.snippet),
            "source": h.source,
        }));
        if out.len() >= limit {
            break;
        }
    }

    let semantic = if HYBRID_SEARCH.get().is_some() && !degraded {
        "ok"
    } else {
        "unavailable"
    };
    let mut result = json!({
        "query": query,
        "libraries": libraries,
        "hits": out,
        "count": out.len(),
        "semantic": semantic,
        "degraded": degraded,
    });
    if !reasons.is_empty() {
        result["notes"] = json!(reasons);
    }
    Ok(result)
}

/// 仅关键词通道：把结果并入 `hits`。单库失败不中断，记 reason。
/// 复用知识模块既有检索 `super::search`（每库 RRF 归并、原文核验、片段生成）。
/// 注意：此处不触发惰性回填——工具调用时已持有全局 DB 连接 guard，再次取锁会重入死锁；
/// 索引由 UI/后台建好，无索引时 `search` 显式报错被记为 reason，不冒充成功。
fn keyword_only(
    conn: &Connection,
    library_id: &str,
    query: &str,
    _limit: usize,
    hits: &mut Vec<KbHit>,
    reasons: &mut Vec<String>,
) -> Result<(), String> {
    match super::search(conn, &[library_id.to_string()], query) {
        Ok(found) => {
            for h in found {
                hits.push(KbHit {
                    library_id: h.library_id,
                    note_id: h.note_id,
                    title: h.title,
                    relative_uri: h.relative_uri,
                    snippet: h.snippet,
                    source: "keyword".into(),
                });
            }
            Ok(())
        }
        Err(e) => {
            reasons.push(format!("{library_id}:{e}"));
            Ok(())
        }
    }
}

// ==================== read ====================

/// UTF-8 安全切片：把 [offset, offset+len) 对齐到字符边界并向两端收拢。
/// offset 落在多字节字符中间时向后对齐到下一字符起点；end 同理向前对齐。
fn utf8_slice(content: &str, offset: usize, length: usize) -> (usize, usize) {
    let bytes = content.as_bytes();
    let total = bytes.len();
    let mut start = offset.min(total);
    // 向后对齐：若 start 不是字符边界，向后找一个边界（不越过 total）。
    while start < total && !content.is_char_boundary(start) {
        start += 1;
    }
    if start >= total {
        return (total, total);
    }
    let mut end = start.saturating_add(length).min(total);
    // 向前对齐：end 若不是字符边界，向前收拢到边界。
    while end > start && !content.is_char_boundary(end) {
        end -= 1;
    }
    (start, end)
}

/// 按 noteId 定位 (libraryId, relativeUri)。候选库已按权限过滤由调用方负责。
fn locate_note(
    conn: &Connection,
    libraries: &[String],
    note_id: &str,
) -> Result<(String, String, String), String> {
    // 先走索引（Markdown 笔记）。
    for lib in libraries {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT relativeUri,title FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2",
                [lib, note_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((rel, title)) = row {
            return Ok((lib.clone(), rel, title));
        }
    }
    // 兜底：遍历库目录清单，按稳定 file_id 命中（非 md 或未入索引文件）。
    for lib in libraries {
        let mut root = super::enabled_root(conn, lib)?;
        let entries = super::files::entries(&mut root)?;
        for e in entries {
            if e.is_dir {
                continue;
            }
            if super::files::file_id(&e.rel) == note_id {
                let title = e.rel.rsplit('/').next().unwrap_or("").to_string();
                return Ok((lib.clone(), e.rel, title));
            }
        }
    }
    Err(format!("KB_NOTE_NOT_FOUND：未找到笔记 {note_id}（在可见库范围内）"))
}

fn tool_read(conn: &Connection, args: &Value) -> Result<Value, String> {
    let note_id = req_str(args, "noteId")?;
    let project_id = opt_str(args, "projectId");
    let library_hint = opt_str(args, "libraryId");
    let offset = opt_usize(args, "offset").unwrap_or(0);
    let length = opt_usize(args, "length").unwrap_or(8192).clamp(1, READ_MAX_BYTES);

    // 候选库：显式 libraryId 优先并校验，否则用可见库集合。
    let libraries: Vec<String> = match library_hint {
        Some(lib) => {
            check_access(conn, &lib, project_id.as_deref())?;
            vec![lib]
        }
        None => visible_libraries(conn, project_id.as_deref())?,
    };

    let (library_id, rel, title) = locate_note(conn, &libraries, &note_id)?;
    // 定位后再复检（防越权：库可能在定位后变化，或 noteId 命中非授权路径）。
    check_access(conn, &library_id, project_id.as_deref())?;

    // 只对文本类笔记提供正文；非文本一律拒绝，不返回整篇二进制。
    let path = std::path::Path::new(&rel);
    if !(super::files::markdown(path) || super::files::indexable_text(path)) {
        return Err(format!("KB_READ_UNSUPPORTED：笔记 {note_id} 不是可读文本（{rel}）"));
    }
    let mut root = super::enabled_root(conn, &library_id)?;
    let (content, _hash) = super::files::read_text(&mut root, &rel)?;

    let total = content.len();
    let (start, end) = utf8_slice(&content, offset, length);
    let slice = &content[start..end];
    let eof = end >= total;

    Ok(json!({
        "libraryId": library_id,
        "noteId": note_id,
        "title": title,
        "relativeUri": rel,
        "offset": start,
        "length": end - start,
        "content": slice,
        "totalBytes": total,
        "truncated": !eof,
        "eof": eof,
        "nextOffset": if eof { Value::Null } else { json!(end) },
    }))
}

// ==================== links ====================

fn tool_links(conn: &Connection, args: &Value) -> Result<Value, String> {
    let note_id = req_str(args, "noteId")?;
    let project_id = opt_str(args, "projectId");
    let library_hint = opt_str(args, "libraryId");

    let libraries: Vec<String> = match library_hint {
        Some(lib) => {
            check_access(conn, &lib, project_id.as_deref())?;
            vec![lib]
        }
        None => visible_libraries(conn, project_id.as_deref())?,
    };

    // 定位所属库（用索引；无索引时按 file_id 兜底）。
    let (library_id, _rel, _title) = locate_note(conn, &libraries, &note_id)?;
    check_access(conn, &library_id, project_id.as_deref())?;

    super::links::ensure_schema(conn)?;
    let outgoing = super::links::outgoing(conn, &library_id, &note_id)?;
    let backlinks = super::links::backlinks(conn, &library_id, &note_id)?;

    let out_json: Vec<Value> = outgoing
        .iter()
        .take(LIST_MAX_ITEMS)
        .map(|o| {
            json!({
                "rawTarget": o.raw_target,
                "name": o.name,
                "state": o.state,
                "targetPath": o.target_path,
                "targetNoteId": o.target_note_id,
                "heading": o.heading,
            })
        })
        .collect();
    let back_json: Vec<Value> = backlinks
        .iter()
        .take(LIST_MAX_ITEMS)
        .map(|b| {
            json!({
                "sourceNoteId": b.source_note_id,
                "sourcePath": b.source_path,
                "sourceTitle": b.source_title,
                "rawTarget": b.raw_target,
                "heading": b.heading,
                "snippet": clip_snippet(&b.snippet),
            })
        })
        .collect();

    Ok(json!({
        "libraryId": library_id,
        "noteId": note_id,
        "outgoing": out_json,
        "backlinks": back_json,
        "outgoingCount": outgoing.len(),
        "backlinkCount": backlinks.len(),
        "truncated": outgoing.len() > LIST_MAX_ITEMS || backlinks.len() > LIST_MAX_ITEMS,
    }))
}

// ==================== graph ====================

fn tool_graph(conn: &Connection, args: &Value) -> Result<Value, String> {
    let project_id = opt_str(args, "projectId");
    let note_id = opt_str(args, "noteId");
    let library_hint = opt_str(args, "libraryId");
    let depth = opt_usize(args, "depth").unwrap_or(1).clamp(1, GRAPH_MAX_DEPTH);
    let only_unresolved = args.get("onlyUnresolved").and_then(Value::as_bool).unwrap_or(false);

    let libraries: Vec<String> = match &library_hint {
        Some(lib) => {
            check_access(conn, lib, project_id.as_deref())?;
            vec![lib.clone()]
        }
        None => visible_libraries(conn, project_id.as_deref())?,
    };

    // 确定库：显式 libraryId 优先；否则按 noteId 定位；再否则取第一个可见库做概览。
    let library_id: String = if let Some(lib) = library_hint {
        lib
    } else if let Some(nid) = &note_id {
        locate_note(conn, &libraries, nid)?.0
    } else {
        libraries
            .into_iter()
            .next()
            .ok_or_else(|| "KB_ACCESS_DENIED：没有可见的知识库".to_string())?
    };
    check_access(conn, &library_id, project_id.as_deref())?;
    super::links::ensure_schema(conn)?;

    // 邻域展开：从中心（或全库）出发，按 depth 逐层收集节点。
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    // 节点：note_id -> (label, path)
    let mut nodes: BTreeMap<String, (String, String)> = BTreeMap::new();
    // 边：(from, to, state, rawTarget)
    let mut edges: Vec<(String, String, String, String)> = Vec::new();
    let mut truncated = false;

    let node_label = |conn: &Connection, nid: &str| -> String {
        conn.query_row(
            "SELECT title FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2",
            [&library_id, nid],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| nid.to_string())
    };
    let node_path = |conn: &Connection, nid: &str| -> String {
        conn.query_row(
            "SELECT relativeUri FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2",
            [&library_id, nid],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default()
    };

    // 加载全库边（受预算限制，只取 resolved/unresolved）。
    let mut stmt = conn
        .prepare(
            "SELECT sourceNoteId, targetNoteId, state, name FROM kb_link
             WHERE libraryId=?1 AND state IN ('resolved','unresolved') ORDER BY sourceNoteId, ordinal",
        )
        .map_err(|e| e.to_string())?;
    let all_edges: Vec<(String, Option<String>, String, String)> = stmt
        .query_map([&library_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // 起点集合。
    let mut frontier: BTreeSet<String> = BTreeSet::new();
    match &note_id {
        Some(nid) => {
            frontier.insert(nid.clone());
            nodes.insert(nid.clone(), (node_label(conn, nid), node_path(conn, nid)));
        }
        None => {
            // 概览：所有出现过的源/目标笔记作为起点（在预算内）。
            for (src, tgt, _, _) in &all_edges {
                frontier.insert(src.clone());
                if let Some(t) = tgt {
                    frontier.insert(t.clone());
                }
                if frontier.len() >= GRAPH_MAX_NODES {
                    truncated = true;
                    break;
                }
            }
        }
    }

    let mut visited: BTreeSet<String> = frontier.clone();
    for nid in &frontier {
        if let std::collections::btree_map::Entry::Vacant(e) = nodes.entry(nid.clone()) {
            e.insert((node_label(conn, nid), node_path(conn, nid)));
        }
    }

    let mut queue: VecDeque<(String, usize)> = frontier.iter().map(|n| (n.clone(), 1usize)).collect();
    let mut edge_seen: BTreeSet<(String, String, String)> = BTreeSet::new();

    while let Some((cur, d)) = queue.pop_front() {
        for (src, tgt, state, name) in &all_edges {
            let neighbor: Option<(String, bool)> = if src == &cur {
                match tgt {
                    Some(t) => Some((t.clone(), false)),
                    None => {
                        // 未解析目标：onlyUnresolved 时作为虚拟节点 missing:<name>。
                        if only_unresolved {
                            Some((format!("missing:{name}"), true))
                        } else {
                            None
                        }
                    }
                }
            } else if tgt.as_deref() == Some(cur.as_str()) {
                Some((src.clone(), false))
            } else {
                None
            };
            let Some((nbr, is_virtual)) = neighbor else { continue };

            // onlyUnresolved：过滤掉 resolved 边。
            if only_unresolved && state != "unresolved" {
                continue;
            }
            if !only_unresolved && state == "unresolved" {
                // resolved-only 图中不展示未解析虚拟目标。
                continue;
            }

            // 记录边（去重）。
            let ekey = (src.clone(), tgt.clone().unwrap_or_else(|| nbr.clone()), state.clone());
            if edge_seen.insert(ekey) {
                if edges.len() >= GRAPH_MAX_EDGES {
                    truncated = true;
                    break;
                }
                edges.push((src.clone(), nbr.clone(), state.clone(), name.clone()));
            }

            // 节点：新增即计入预算；虚拟节点不递归展开。
            if is_virtual {
                nodes
                    .entry(nbr.clone())
                    .or_insert((name.clone(), String::new()));
                continue;
            }
            if !nodes.contains_key(&nbr) {
                if nodes.len() >= GRAPH_MAX_NODES {
                    truncated = true;
                    break;
                }
                nodes.insert(nbr.clone(), (node_label(conn, &nbr), node_path(conn, &nbr)));
            }
            if d < depth && !visited.contains(&nbr) {
                visited.insert(nbr.clone());
                queue.push_back((nbr, d + 1));
            }
        }
        if edges.len() >= GRAPH_MAX_EDGES {
            truncated = true;
            break;
        }
    }

    // 计算 degree。
    let mut degree: BTreeMap<String, usize> = BTreeMap::new();
    for (from, to, _, _) in &edges {
        *degree.entry(from.clone()).or_insert(0) += 1;
        *degree.entry(to.clone()).or_insert(0) += 1;
    }

    let nodes_json: Vec<Value> = nodes
        .iter()
        .map(|(id, (label, path))| {
            json!({
                "id": id,
                "label": label,
                "path": path,
                "kind": if id.starts_with("missing:") { "missing" } else { "note" },
                "degree": degree.get(id).copied().unwrap_or(0),
            })
        })
        .collect();
    let edges_json: Vec<Value> = edges
        .iter()
        .map(|(from, to, state, raw)| {
            json!({ "from": from, "to": to, "state": state, "rawTarget": raw })
        })
        .collect();

    Ok(json!({
        "libraryId": library_id,
        "center": note_id,
        "depth": depth,
        "onlyUnresolved": only_unresolved,
        "nodes": nodes_json,
        "edges": edges_json,
        "nodeCount": nodes.len(),
        "edgeCount": edges.len(),
        "truncated": truncated,
    }))
}

// ==================== list ====================

fn tool_list(conn: &Connection, args: &Value) -> Result<Value, String> {
    let library_id = req_str(args, "libraryId")?;
    let project_id = opt_str(args, "projectId");
    check_access(conn, &library_id, project_id.as_deref())?;

    let folder = opt_str(args, "folder").unwrap_or_default();
    // 归一化 folder：去首尾 '/'，禁止穿越。
    let folder = folder.trim_matches('/').to_string();
    if folder.split('/').any(|p| p == ".." || p == ".") {
        return Err("folder 非法：不允许 .. 或 . 片段".into());
    }

    let mut root = super::enabled_root(conn, &library_id)?;
    let entries = super::files::entries(&mut root)?;

    let mut items: Vec<Value> = Vec::new();
    for e in entries.iter() {
        // 只列直接子项：父目录 == folder。
        let parent = e.rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        if parent != folder {
            continue;
        }
        let name = e.rel.rsplit('/').next().unwrap_or("").to_string();
        let (kind, size) = if e.is_dir {
            ("directory".to_string(), 0u64)
        } else {
            // 读取文件大小（不改内容）；失败给 0 并标 unknown。
            let size = std::fs::metadata(root.path.join(path_from_rel(&e.rel)))
                .map(|m| m.len())
                .unwrap_or(0);
            ("file".to_string(), size)
        };
        items.push(json!({
            "name": name,
            "path": e.rel,
            "kind": kind,
            "size": size,
        }));
        if items.len() >= LIST_MAX_ITEMS {
            break;
        }
    }

    let truncated = entries
        .iter()
        .filter(|e| e.rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("") == folder)
        .count()
        > LIST_MAX_ITEMS;

    Ok(json!({
        "libraryId": library_id,
        "folder": folder,
        "items": items,
        "count": items.len(),
        "truncated": truncated,
    }))
}

/// 把相对 URI 拆成路径分量（用于拼接 SafeRoot.path 只做元数据读取）。
fn path_from_rel(rel: &str) -> std::path::PathBuf {
    let mut p = std::path::PathBuf::new();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

// ==================== Tauri 命令（供主代理注册） ====================

fn run_with_conn<F>(tool: &'static str, args: &Value, library: Option<&str>, note: Option<&str>, f: F) -> Result<Value, String>
where
    F: FnOnce(&Connection) -> Result<Value, String>,
{
    let result = {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        f(conn)
    };
    match &result {
        Ok(v) => {
            let count = v.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
            audit(tool, library, note, count, false, "");
        }
        Err(e) => {
            // 拒绝类错误统一记 DENY；其余算失败但同样留痕。
            let denied = e.starts_with("KB_ACCESS_DENIED") || e.starts_with("KB_LIBRARY_UNAVAILABLE");
            audit(tool, library, note, 0, denied, e);
        }
    }
    result
}

#[tauri::command]
pub fn kb_tool_search(args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let lib = opt_str(&args, "libraryId");
    let project = opt_str(&args, "projectId");
    run_with_conn("knowledge_search", &args, lib.as_deref(), None, |conn| {
        // projectId 已在 tool_search 内逐库校验；此处对显式库无 projectId 场景也做 enabled 校验。
        let _ = project;
        tool_search(conn, &args)
    })
}

#[tauri::command]
pub fn kb_tool_read(args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let note = opt_str(&args, "noteId");
    run_with_conn("knowledge_read", &args, None, note.as_deref(), |conn| {
        tool_read(conn, &args)
    })
}

#[tauri::command]
pub fn kb_tool_links(args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let note = opt_str(&args, "noteId");
    run_with_conn("knowledge_links", &args, None, note.as_deref(), |conn| {
        tool_links(conn, &args)
    })
}

#[tauri::command]
pub fn kb_tool_graph(args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let lib = opt_str(&args, "libraryId");
    let note = opt_str(&args, "noteId");
    run_with_conn("knowledge_graph", &args, lib.as_deref(), note.as_deref(), |conn| {
        tool_graph(conn, &args)
    })
}

#[tauri::command]
pub fn kb_tool_list(args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(json!({}));
    let lib = opt_str(&args, "libraryId");
    run_with_conn("knowledge_list", &args, lib.as_deref(), None, |conn| {
        tool_list(conn, &args)
    })
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    /// 内存 SQLite + 临时目录 SafeRoot 最小夹具。
    /// 表结构与 knowledge.rs / kb_links.rs 的真实最小集同构（仅测试所需列）。
    struct Fixture {
        conn: Connection,
        root: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE knowledge_library(id TEXT PRIMARY KEY,name TEXT,sourceKind TEXT,sourceRef TEXT,revision INTEGER,enabled INTEGER,createdAt INTEGER,icon TEXT,iconColor TEXT);
                 CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri));
                 CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,updatedAt INTEGER,actor TEXT,PRIMARY KEY(projectId,libraryId));",
            )
            .unwrap();
            let base = std::fs::canonicalize(std::env::temp_dir())
                .unwrap_or_else(|_| std::env::temp_dir());
            let root = base.join(format!("cr089-tools-test-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Fixture { conn, root }
        }

        fn add_library(&self, id: &str, enabled: i64) {
            self.conn
                .execute(
                    "INSERT INTO knowledge_library(id,name,sourceKind,sourceRef,revision,enabled,createdAt) VALUES(?1,?2,'managed-directory',?3,0,?4,1)",
                    rusqlite::params![id, id, self.root.to_string_lossy(), enabled],
                )
                .unwrap();
        }

        fn grant(&self, project: &str, lib: &str, read: i64) {
            self.conn
                .execute(
                    "INSERT INTO project_library_grant(projectId,libraryId,readAllowed,updatedAt,actor) VALUES(?1,?2,?3,1,'owner')",
                    rusqlite::params![project, lib, read],
                )
                .unwrap();
        }

        fn write_note(&self, rel: &str, content: &str) -> String {
            let path = self.root.join(path_from_rel(rel));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, content).unwrap();
            super::super::files::file_id(rel)
        }

        fn index_note(&self, lib: &str, note_id: &str, rel: &str, title: &str) {
            self.conn
                .execute(
                    "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt) VALUES(?1,?2,?3,?4,'h',1)",
                    rusqlite::params![lib, note_id, title, rel],
                )
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn unauthorized_project_search_is_denied() {
        let fx = Fixture::new("deny");
        fx.add_library("lib1", 1);
        // 项目 p1 明确 readAllowed=0。
        fx.grant("p1", "lib1", 0);
        let args = json!({ "query": "退款", "projectId": "p1", "libraryId": "lib1" });
        let err = tool_search(&fx.conn, &args).unwrap_err();
        assert!(err.starts_with("KB_ACCESS_DENIED"), "应拒绝未授权项目：{err}");
    }

    #[test]
    fn disabled_library_is_unavailable() {
        let fx = Fixture::new("disabled");
        fx.add_library("lib1", 0); // 停用
        let args = json!({ "query": "x", "libraryId": "lib1" });
        let err = tool_search(&fx.conn, &args).unwrap_err();
        assert!(err.starts_with("KB_LIBRARY_UNAVAILABLE"), "应报库不可用：{err}");
    }

    #[test]
    fn read_truncates_to_65536_bytes() {
        let fx = Fixture::new("read-trunc");
        fx.add_library("lib1", 1);
        // 200KB ASCII 正文。
        let content = "a".repeat(200 * 1024);
        let nid = fx.write_note("big.md", &content);
        fx.index_note("lib1", &nid, "big.md", "big");
        // length 请求 100000，应被夹到 65536。
        let args = json!({ "noteId": nid, "offset": 0, "length": 100000 });
        let v = tool_read(&fx.conn, &args).unwrap();
        assert_eq!(v["length"].as_u64().unwrap(), READ_MAX_BYTES as u64, "应截断到 65536");
        assert!(v["truncated"].as_bool().unwrap());
    }

    #[test]
    fn read_mid_multibyte_offset_does_not_panic() {
        let fx = Fixture::new("read-mb");
        fx.add_library("lib1", 1);
        // "中" 占 3 字节；整体 6 字节。
        let content = "中文";
        let nid = fx.write_note("mb.md", content);
        fx.index_note("lib1", &nid, "mb.md", "mb");
        // offset=1 落在第一个字符中间 → 向后对齐到 3。
        let v = tool_read(&fx.conn, &json!({ "noteId": nid, "offset": 1, "length": 3 })).unwrap();
        let start = v["offset"].as_u64().unwrap() as usize;
        assert_eq!(start, 3, "offset 应对齐到字符边界");
        assert_eq!(v["content"].as_str().unwrap(), "文");
        // offset=2 → 也对齐到 3。
        let v2 = tool_read(&fx.conn, &json!({ "noteId": nid, "offset": 2, "length": 64 })).unwrap();
        assert_eq!(v2["offset"].as_u64().unwrap() as usize, 3);
    }

    #[test]
    fn graph_truncates_over_50_nodes() {
        let fx = Fixture::new("graph-trunc");
        fx.add_library("lib1", 1);
        super::super::links::ensure_schema(&fx.conn).unwrap();
        // 造 120 条笔记，中心 n0 指向其余所有（resolved 边 120 条 → 节点>50 边>100）。
        let center = "n0";
        fx.write_note("n0.md", "# 中心\n");
        fx.index_note("lib1", center, "n0.md", "中心");
        for i in 1..=120 {
            let nid = format!("n{i}");
            let rel = format!("{nid}.md");
            fx.write_note(&rel, "# x\n");
            fx.index_note("lib1", &nid, &rel, &nid);
            fx.conn
                .execute(
                    "INSERT INTO kb_link(libraryId,sourceNoteId,sourcePath,sourceRevision,ordinal,rawTarget,name,targetPath,targetNoteId,heading,state,snippet)
                     VALUES('lib1',?1,'n0.md','rev',?2,'[[x]]','x',?3,?4,NULL,'resolved','')",
                    rusqlite::params![center, i as i64, rel, nid],
                )
                .unwrap();
        }
        let v = tool_graph(&fx.conn, &json!({ "noteId": center, "depth": 1, "libraryId": "lib1" })).unwrap();
        assert!(v["nodeCount"].as_u64().unwrap() <= GRAPH_MAX_NODES as u64, "节点应≤50");
        assert!(v["edgeCount"].as_u64().unwrap() <= GRAPH_MAX_EDGES as u64, "边应≤100");
        assert!(v["truncated"].as_bool().unwrap(), "应标记截断");
    }

    #[test]
    fn list_returns_only_name_path_kind_size() {
        let fx = Fixture::new("list");
        fx.add_library("lib1", 1);
        fx.write_note("a.md", "# a\n正文不应出现\n");
        std::fs::create_dir_all(fx.root.join("sub")).unwrap();
        let v = tool_list(&fx.conn, &json!({ "libraryId": "lib1" })).unwrap();
        let items = v["items"].as_array().unwrap();
        assert!(!items.is_empty());
        for item in items {
            let obj = item.as_object().unwrap();
            // 只含这四个键，且无正文。
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            assert_eq!(keys, vec!["kind", "name", "path", "size"], "字段应只有名称/路径/类型/大小: {keys:?}");
            assert!(obj.get("content").is_none());
        }
        // 目录项 kind=directory。
        let sub = items.iter().find(|i| i["name"] == "sub").unwrap();
        assert_eq!(sub["kind"], "directory");
    }
}
