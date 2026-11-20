//! CR045：完整需求源清单，不依赖索引树的完整性。
use crate::models::RequirementNode;
use std::{collections::{HashMap, HashSet}, path::Path};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementSource {
    pub source_uri: String,
    pub node: Option<RequirementNode>,
    pub error: Option<String>,
    pub warning: Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementSources {
    pub root_uri: String,
    pub sources: Vec<RequirementSource>,
    pub warnings: Vec<String>,
}
fn inferred_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let mut parts = stem.split('-');
    let prefix = parts.next()?;
    let number = parts.next()?;
    if !["VISION", "EPIC", "FEAT", "STORY", "BUG"].contains(&prefix) || number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) { return None; }
    Some(format!("{}-{}", prefix, number))
}
fn kind_from_id(id: &str) -> &'static str {
    if id.starts_with("VISION-") { "vision" } else if id.starts_with("EPIC-") { "epic" } else if id.starts_with("FEAT-") { "feature" } else if id.starts_with("BUG-") { "bug" } else { "story" }
}
fn source_node(path: &Path, text: &str) -> Option<RequirementNode> {
    let fm = super::parse_front_matter(text);
    let id = fm.get("id").filter(|id| !id.is_empty()).cloned().or_else(|| inferred_id(path))?;
    let kind = fm.get("type").or_else(|| fm.get("kind")).cloned().unwrap_or_else(|| kind_from_id(&id).into());
    if !["vision", "epic", "feature", "story", "bug"].contains(&kind.as_str()) { return None; }
    let heading = text.lines().find_map(|line| line.strip_prefix("# ")).map(str::trim);
    Some(RequirementNode {
        entity_id: id, kind, parent_id: fm.get("parent").filter(|value| !value.is_empty()).cloned(),
        title: fm.get("title").cloned().or_else(|| heading.map(str::to_string)).unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string()),
        status: fm.get("status").cloned(), owner: fm.get("owner").cloned(),
        source_uri: path.to_string_lossy().to_string(), children: vec![],
    })
}
fn collect(root: &Path) -> Result<RequirementSources, String> {
    let root = std::fs::canonicalize(root).map_err(|_| "项目目录不可访问")?;
    let plan = root.join("docs/Plan");
    let mut out = RequirementSources { root_uri: root.to_string_lossy().to_string(), sources: vec![], warnings: vec![] };
    if !plan.exists() { out.warnings.push("项目尚无 docs/Plan 目录".into()); return Ok(out); }
    if std::fs::symlink_metadata(&plan).map_err(|e| e.to_string())?.file_type().is_symlink() || !std::fs::canonicalize(&plan).map_err(|e| e.to_string())?.starts_with(&root) {
        return Err("需求目录越界或符号链接".into());
    }
    for result in walkdir::WalkDir::new(&plan).max_depth(12).follow_links(false) {
        let entry = match result { Ok(entry) => entry, Err(error) => { out.warnings.push(format!("源目录读取失败：{}", error)); continue; } };
        let path = entry.path();
        if entry.file_type().is_symlink() { out.warnings.push(format!("跳过符号链接：{}", path.display())); continue; }
        if !entry.file_type().is_file() || !path.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown")).unwrap_or(false) { continue; }
        if out.sources.len() >= 5000 { out.warnings.push("源清单超过5000文件，已停止；结果不完整".into()); break; }
        let uri = path.to_string_lossy().to_string();
        let checked = std::fs::canonicalize(path).map_err(|e| e.to_string());
        let text = checked.and_then(|checked| {
            if !checked.starts_with(&root) { return Err("源路径越界".into()); }
            if std::fs::metadata(&checked).map_err(|e| e.to_string())?.len() > 1024 * 1024 { return Err("需求源超过1MiB，未读取；清单仍保留".into()); }
            std::fs::read_to_string(checked).map_err(|e| e.to_string())
        });
        match text {
            Ok(text) => {
                let node = source_node(path, &text);
                let warning = if node.is_none() { Some("文档无可识别稳定需求编号；可在全文预览阅读，不推断父项".into()) }
                    else if !super::parse_front_matter(&text).contains_key("id") { Some("编号由文件名读取；父项未在元信息声明，不自动推断".into()) } else { None };
                out.sources.push(RequirementSource { source_uri: uri, node, error: None, warning });
            }
            Err(error) => out.sources.push(RequirementSource { source_uri: uri, node: None, error: Some(error), warning: None }),
        }
    }
    out.sources.sort_by(|a, b| a.source_uri.cmp(&b.source_uri));
    let mut ids = HashMap::<String, Vec<usize>>::new();
    for (index, source) in out.sources.iter().enumerate() { if let Some(node) = &source.node { ids.entry(node.entity_id.clone()).or_default().push(index); } }
    for (id, entries) in &ids { if entries.len() > 1 { for index in entries { out.sources[*index].error = Some(format!("需求编号冲突：{} 对应多个源文件", id)); } } }
    let parents: HashMap<String, Option<String>> = out.sources.iter().filter_map(|source| source.node.as_ref().map(|node| (node.entity_id.clone(), node.parent_id.clone()))).collect();
    for source in &mut out.sources {
        let Some(node) = &source.node else { continue; };
        let mut seen = HashSet::new();
        let mut next = Some(node.entity_id.clone());
        while let Some(id) = next {
            if !seen.insert(id.clone()) { source.error = Some("源父项关系成环；保留源文件，不隐藏节点".into()); break; }
            next = parents.get(&id).cloned().flatten();
            if let Some(parent) = &next { if !parents.contains_key(parent) { source.warning = Some(format!("父项{}缺源；保留孤立节点", parent)); break; } }
        }
    }
    Ok(out)
}
#[tauri::command]
pub fn read_requirement_sources(project_id: String) -> Result<RequirementSources, String> {
    let root: String = {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT rootUri FROM project WHERE id=?1", [project_id], |row| row.get(0)).map_err(|_| "项目不存在")?
    };
    collect(Path::new(&root))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn knowledge_independent_requirement_manifest_keeps_unindexed_sources() {
        let root = std::env::temp_dir().join(format!("nestcraft-req-{}", uuid::Uuid::new_v4()));
        let plan = root.join("docs/Plan/Epic"); std::fs::create_dir_all(&plan).unwrap();
        std::fs::write(plan.join("EPIC-001-目标.md"), "# 源目标\n\n完整正文").unwrap();
        std::fs::write(plan.join("未登记.md"), "# 未登记全文").unwrap();
        let result = collect(&root).unwrap();
        assert_eq!(result.sources.len(), 2);
        assert!(result.sources.iter().any(|s| s.node.as_ref().map(|n| n.entity_id.as_str()) == Some("EPIC-001")));
        assert!(result.sources.iter().any(|s| s.node.is_none() && s.warning.is_some()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn knowledge_independent_requirement_manifest_reports_duplicate_and_cycle() {
        let root = std::env::temp_dir().join(format!("nestcraft-req-{}", uuid::Uuid::new_v4()));
        let plan = root.join("docs/Plan"); std::fs::create_dir_all(&plan).unwrap();
        std::fs::write(plan.join("EPIC-001-a.md"), "---\nid: EPIC-001\ntype: epic\nparent: FEAT-001\n---\n# A").unwrap();
        std::fs::write(plan.join("EPIC-001-b.md"), "# B").unwrap();
        std::fs::write(plan.join("FEAT-001-a.md"), "---\nid: FEAT-001\ntype: feature\nparent: EPIC-001\n---\n# F").unwrap();
        let result = collect(&root).unwrap();
        assert_eq!(result.sources.len(), 3);
        assert!(result.sources.iter().filter(|s| s.error.is_some()).count() >= 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
