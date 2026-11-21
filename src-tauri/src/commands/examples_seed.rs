//! CR-057：示例项目随包发布。
//!
//! 示例内容在编译期通过 `include_bytes!` 嵌入二进制（发布形态是单文件 exe，
//! 没有可用的资源目录），首次启动时解压到应用数据目录并登记项目与知识库。
//!
//! 约束：
//! - 幂等：安装成功后记录 `examples.seed.version`，重复启动不重复创建。
//! - 不覆盖：已存在的文件跳过；同名但目录不同的用户项目不冒用。
//! - 不复活：用户删除的示例项目不会在下次启动时重建（版本标记仍在）。
//! - 不阻塞：安装失败只返回错误/警告，不影响应用启动。

use crate::db;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

pub const SEED_VERSION: &str = "1";
const VERSION_KEY: &str = "examples.seed.version";
const PROJECTS_KEY: &str = "examples.seed.projects";
const LIBRARIES_KEY: &str = "examples.seed.libraries";

pub const CODE_PROJECT_NAME: &str = "计算器 · 示例项目";
pub const WORK_PROJECT_NAME: &str = "NestCraft 产品介绍 · 示例项目";
pub const KB_NAME: &str = "NestCraft 产品资料库（示例）";

struct SeedFile {
    rel: &'static str,
    bytes: &'static [u8],
}

macro_rules! seed_files {
    ($($rel:literal),* $(,)?) => {
        &[$(SeedFile {
            rel: $rel,
            bytes: include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/seed/", $rel)),
        }),*]
    };
}

/// 编码示例：计算器（需求 / 设计 / 方案 / 代码 / 测试）。
const CODE_FILES: &[SeedFile] = seed_files![
    "code/calculator/README.md",
    "code/calculator/package.json",
    "code/calculator/docs/README.md",
    "code/calculator/docs/Plan/VISION-001-产品愿景.md",
    "code/calculator/docs/Plan/Epic/EPIC-001-四则运算计算器.md",
    "code/calculator/docs/Plan/Feature/FEAT-001-基础四则运算.md",
    "code/calculator/docs/Plan/Feature/FEAT-002-键盘输入与历史记录.md",
    "code/calculator/docs/Plan/Story/STORY-001-四则运算与连续计算.md",
    "code/calculator/docs/Plan/Story/STORY-002-键盘输入与历史记录.md",
    "code/calculator/docs/PRD/PRD-001-计算器需求规格.md",
    "code/calculator/docs/LLD/LLD-FEAT-001-实现方案.md",
    "code/calculator/docs/LLD/ADR-001-计算引擎选型.md",
    "code/calculator/docs/UI/仿真原型UI.html",
    "code/calculator/docs/UI/文档/UI-FEAT-001-交互设计.md",
    "code/calculator/docs/Test/TEST-FEAT-001-测试方案.md",
    "code/calculator/docs/Test/REPORT-001-验证记录.md",
    "code/calculator/src/index.html",
    "code/calculator/src/calculator.css",
    "code/calculator/src/calculator.js",
    "code/calculator/tests/calculator.test.mjs",
];

/// 办公示例的目录说明（办公文件内容在工作台内生成，目录本身用于项目绑定）。
const WORK_FILES: &[SeedFile] = seed_files!["work/nestcraft-intro/README.md"];

/// 知识库示例：NestCraft 产品资料库（多目录、多格式真实资料）。
const KB_FILES: &[SeedFile] = seed_files![
    "knowledge/nestcraft-kb/01-产品与定位/NestCraft-一句话定位与价值主张.md",
    "knowledge/nestcraft-kb/01-产品与定位/NestCraft-产品白皮书.docx",
    "knowledge/nestcraft-kb/01-产品与定位/NestCraft-能力地图.xlsx",
    "knowledge/nestcraft-kb/02-功能手册/01-项目与需求工作流.md",
    "knowledge/nestcraft-kb/02-功能手册/02-AI-会话与模型接入.md",
    "knowledge/nestcraft-kb/02-功能手册/03-知识库授权与检索.md",
    "knowledge/nestcraft-kb/02-功能手册/04-服务器与终端运维.md",
    "knowledge/nestcraft-kb/03-评测与验证/更新日志.md",
    "knowledge/nestcraft-kb/03-评测与验证/版本发布检查清单.csv",
    "knowledge/nestcraft-kb/03-评测与验证/构建与冒烟日志.txt",
    "knowledge/nestcraft-kb/03-评测与验证/NestCraft-能力核对表.xlsx",
    "knowledge/nestcraft-kb/04-设计与规范/工作台信息架构.drawio",
    "knowledge/nestcraft-kb/04-设计与规范/滚动条按需显示规范.md",
    "knowledge/nestcraft-kb/04-设计与规范/设计令牌清单.json",
    "knowledge/nestcraft-kb/05-会议与纪要/2026-11-18-产品评审纪要.md",
    "knowledge/nestcraft-kb/05-会议与纪要/需求变更登记.csv",
    "knowledge/nestcraft-kb/06-图示与素材/工作台三栏布局.png",
    "knowledge/nestcraft-kb/06-图示与素材/能力矩阵.png",
    "knowledge/nestcraft-kb/07-参考资料/常见问题.md",
    "knowledge/nestcraft-kb/07-参考资料/附件格式样本.pos",
    "knowledge/nestcraft-kb/07-参考资料/NestCraft-平台介绍.pdf",
    "knowledge/nestcraft-kb/07-参考资料/NestCraft-产品介绍.pptx",
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeedRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub root_uri: String,
    /// true = 复用已存在的记录（本次未新建）
    pub reused: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub installed: bool,
    pub version: String,
    pub base_dir: String,
    pub files_written: usize,
    pub files_skipped: usize,
    pub projects: Vec<SeedRecord>,
    pub libraries: Vec<SeedRecord>,
    pub warnings: Vec<String>,
}

fn read_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
        [key],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|value| !value.trim().is_empty())
}

fn write_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value=?2, updatedAt=?3",
        rusqlite::params![key, value, crate::models::now_ms()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// 只接受相对路径：拒绝绝对路径、盘符与 `..`，最终路径必须落在 base 之内。
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(format!("示例清单包含绝对路径：{rel}"));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(format!("示例清单包含越界路径：{rel}")),
        }
    }
    let joined = base.join(candidate);
    if !joined.starts_with(base) {
        return Err(format!("示例写入越界：{rel}"));
    }
    Ok(joined)
}

fn write_tree(base: &Path, files: &[SeedFile], warnings: &mut Vec<String>) -> (usize, usize) {
    let mut written = 0;
    let mut skipped = 0;
    for file in files {
        let path = match safe_join(base, file.rel) {
            Ok(path) => path,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        if path.exists() {
            skipped += 1;
            continue;
        }
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                warnings.push(format!("创建目录失败 {}：{error}", parent.display()));
                continue;
            }
        }
        match std::fs::write(&path, file.bytes) {
            Ok(()) => written += 1,
            Err(error) => warnings.push(format!("写入失败 {}：{error}", path.display())),
        }
    }
    (written, skipped)
}

/// 复用目录与名称都一致的记录；同名但目录不同不冒用，记警告后跳过。
fn ensure_project(
    conn: &rusqlite::Connection,
    name: &str,
    kind: &str,
    dir: &Path,
    icon: &str,
    color: &str,
    warnings: &mut Vec<String>,
) -> Option<SeedRecord> {
    let canonical = match std::fs::canonicalize(dir) {
        Ok(path) => path,
        Err(error) => {
            warnings.push(format!("示例目录不可用 {}：{error}", dir.display()));
            return None;
        }
    };
    let root_uri = canonical.to_string_lossy().to_string();
    let existing: Option<(String, String)> = conn
        .query_row("SELECT id, rootUri FROM project WHERE name=?1", [name], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok();
    if let Some((id, existing_root)) = existing {
        let same_root = std::fs::canonicalize(&existing_root)
            .map(|path| path == canonical)
            .unwrap_or(false);
        if !same_root {
            warnings.push(format!("已存在同名项目「{name}」且目录不同，未创建示例"));
            return None;
        }
        return Some(SeedRecord { id, name: name.to_string(), kind: kind.to_string(), root_uri, reused: true });
    }
    // 直接插入：本函数已持有数据库连接，不能再经 create_project 二次加锁。
    let id = crate::models::new_id("proj");
    let now = crate::models::now_ms();
    let result = conn.execute(
        "INSERT INTO project (id, name, type, rootUri, icon, iconColor, createdAt, updatedAt)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        rusqlite::params![id, name, kind, root_uri, icon, color, now],
    );
    match result {
        Ok(_) => Some(SeedRecord { id, name: name.to_string(), kind: kind.to_string(), root_uri, reused: false }),
        Err(error) => {
            warnings.push(format!("创建示例项目「{name}」失败：{error}"));
            None
        }
    }
}

fn ensure_library(
    conn: &rusqlite::Connection,
    name: &str,
    dir: &Path,
    icon: &str,
    color: &str,
    warnings: &mut Vec<String>,
) -> Option<SeedRecord> {
    let canonical = match std::fs::canonicalize(dir) {
        Ok(path) => path,
        Err(error) => {
            warnings.push(format!("知识库目录不可用 {}：{error}", dir.display()));
            return None;
        }
    };
    let root_uri = canonical.to_string_lossy().to_string();
    let existing: Option<(String, String)> = conn
        .query_row("SELECT id, sourceRef FROM knowledge_library WHERE name=?1", [name], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok();
    if let Some((id, source_ref)) = existing {
        let same_root = std::fs::canonicalize(&source_ref)
            .map(|path| path == canonical)
            .unwrap_or(false);
        if !same_root {
            warnings.push(format!("已存在同名知识库「{name}」且目录不同，未创建示例"));
            return None;
        }
        return Some(SeedRecord { id, name: name.to_string(), kind: "library".into(), root_uri, reused: true });
    }
    let id = crate::models::new_id("kb");
    let result = conn.execute(
        "INSERT INTO knowledge_library(id,name,sourceKind,sourceRef,revision,enabled,createdAt,icon,iconColor)
         VALUES(?1,?2,'managed-directory',?3,0,1,?4,?5,?6)",
        rusqlite::params![id, name, root_uri, crate::models::now_ms(), icon, color],
    );
    match result {
        Ok(_) => Some(SeedRecord { id, name: name.to_string(), kind: "library".into(), root_uri, reused: false }),
        Err(error) => {
            warnings.push(format!("创建示例知识库「{name}」失败：{error}"));
            None
        }
    }
}

fn project_ids_present(conn: &rusqlite::Connection, key: &str) -> bool {
    let Some(raw) = read_setting(conn, key) else { return false };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    let mut any = false;
    for entry in map.values() {
        let Some(id) = entry.as_str() else { continue };
        any = true;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM project WHERE id=?1", [id], |row| row.get(0))
            .unwrap_or(0);
        if count == 0 {
            return false;
        }
    }
    any
}

fn library_ids_present(conn: &rusqlite::Connection, key: &str) -> bool {
    let Some(raw) = read_setting(conn, key) else { return false };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    let mut any = false;
    for entry in items {
        let Some(id) = entry.as_str() else { continue };
        any = true;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM knowledge_library WHERE id=?1", [id], |row| row.get(0))
            .unwrap_or(0);
        if count == 0 {
            return false;
        }
    }
    any
}

/// 首次启动安装示例；已安装且记录仍在时直接返回。
pub fn ensure_seeded(app: &tauri::AppHandle) -> Result<SeedReport, String> {
    use tauri::Manager;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("应用数据目录不可用：{error}"))?
        .join("examples")
        .join(format!("v{SEED_VERSION}"));

    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;

    let installed_version = read_setting(conn, VERSION_KEY);
    if installed_version.as_deref() == Some(SEED_VERSION)
        && project_ids_present(conn, PROJECTS_KEY)
        && library_ids_present(conn, LIBRARIES_KEY)
    {
        return Ok(SeedReport {
            installed: false,
            version: SEED_VERSION.to_string(),
            base_dir: base.to_string_lossy().to_string(),
            ..Default::default()
        });
    }

    let mut warnings = Vec::new();
    let mut report = SeedReport {
        installed: true,
        version: SEED_VERSION.to_string(),
        base_dir: base.to_string_lossy().to_string(),
        ..Default::default()
    };

    let code_dir = base.join("code").join("calculator");
    let work_dir = base.join("work").join("nestcraft-intro");
    let kb_dir = base.join("knowledge").join("nestcraft-kb");
    for dir in [&code_dir, &work_dir, &kb_dir] {
        if let Err(error) = std::fs::create_dir_all(dir) {
            return Err(format!("创建示例目录失败 {}：{error}", dir.display()));
        }
    }

    let (code_written, code_skipped) = write_tree(&code_dir, CODE_FILES, &mut warnings);
    let (work_written, work_skipped) = write_tree(&work_dir, WORK_FILES, &mut warnings);
    let (kb_written, kb_skipped) = write_tree(&kb_dir, KB_FILES, &mut warnings);
    report.files_written = code_written + work_written + kb_written;
    report.files_skipped = code_skipped + work_skipped + kb_skipped;

    let code = ensure_project(conn, CODE_PROJECT_NAME, "code", &code_dir, "code", "blue", &mut warnings);
    let work = ensure_project(conn, WORK_PROJECT_NAME, "work", &work_dir, "presentation", "violet", &mut warnings);
    let library = ensure_library(conn, KB_NAME, &kb_dir, "library", "teal", &mut warnings);

    let mut projects = serde_json::Map::new();
    if let Some(record) = &code {
        projects.insert("code".into(), serde_json::Value::String(record.id.clone()));
        report.projects.push(record.clone());
    }
    if let Some(record) = &work {
        projects.insert("work".into(), serde_json::Value::String(record.id.clone()));
        report.projects.push(record.clone());
    }
    let mut libraries = Vec::new();
    if let Some(record) = &library {
        libraries.push(serde_json::Value::String(record.id.clone()));
        report.libraries.push(record.clone());
    }

    if let Err(error) = write_setting(conn, PROJECTS_KEY, &serde_json::Value::Object(projects).to_string()) {
        warnings.push(format!("记录示例项目身份失败：{error}"));
    }
    if let Err(error) = write_setting(conn, LIBRARIES_KEY, &serde_json::Value::Array(libraries).to_string()) {
        warnings.push(format!("记录示例知识库身份失败：{error}"));
    }
    if code.is_some() && work.is_some() && library.is_some() {
        if let Err(error) = write_setting(conn, VERSION_KEY, SEED_VERSION) {
            warnings.push(format!("记录示例版本失败：{error}"));
        }
    } else {
        warnings.push("示例未完整安装，下次启动会重试；不会覆盖已有文件".into());
    }
    report.warnings = warnings;
    Ok(report)
}

/// 前端启动时可主动调用一次；与 setup 阶段调用等价，重复调用幂等。
#[tauri::command]
pub fn seed_example_workspace(app: tauri::AppHandle) -> Result<SeedReport, String> {
    ensure_seeded(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_manifest_paths_are_relative_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for file in CODE_FILES.iter().chain(WORK_FILES).chain(KB_FILES) {
            assert!(!file.rel.starts_with('/'), "{} 不应是绝对路径", file.rel);
            assert!(!file.rel.contains(".."), "{} 不应包含越界段", file.rel);
            assert!(seen.insert(file.rel), "{} 重复登记", file.rel);
            assert!(!file.bytes.is_empty(), "{} 内容为空", file.rel);
        }
    }

    #[test]
    fn seed_manifest_covers_required_file_types() {
        let extensions: Vec<String> = CODE_FILES
            .iter()
            .chain(WORK_FILES)
            .chain(KB_FILES)
            .filter_map(|file| Path::new(file.rel).extension().and_then(|ext| ext.to_str()))
            .map(|ext| ext.to_ascii_lowercase())
            .collect();
        for required in [
            "md", "docx", "pptx", "xlsx", "pdf", "png", "drawio", "csv", "json", "txt", "pos", "html", "js", "css",
            "mjs",
        ] {
            assert!(extensions.iter().any(|ext| ext == required), "缺少类型：{required}");
        }
    }

    #[test]
    fn safe_join_rejects_escape_attempts() {
        let base = Path::new("/tmp/nestcraft-seed");
        assert!(safe_join(base, "code/calculator/README.md").is_ok());
        assert!(safe_join(base, "../escape.md").is_err());
        assert!(safe_join(base, "code/../../escape.md").is_err());
        assert!(safe_join(base, "/etc/passwd").is_err());
    }

    #[test]
    fn write_tree_skips_existing_files() {
        let dir = std::env::temp_dir().join(format!("seed-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = [SeedFile { rel: "a/b.txt", bytes: b"first" }];
        let mut warnings = Vec::new();
        assert_eq!(write_tree(&dir, &files, &mut warnings), (1, 0));
        assert_eq!(write_tree(&dir, &files, &mut warnings), (0, 1));
        assert_eq!(std::fs::read_to_string(dir.join("a").join("b.txt")).unwrap(), "first");
        assert!(warnings.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
