//! 项目数据统一放在数据目录下，按类别分文件夹。
//! 默认是安装目录的 data；设置里改位置后写入 storage-root.txt，下次启动和后续写入都走新位置。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const CATEGORIES: &[&str] = &[
    "db", "knowledge", "recycle", "index", "examples", "chat", "skills", "mcp", "secrets", "avatar", "logs", "editor", "git",
    "office", "generated-images",
];

/// 本次进程实际使用的数据根：启动时确定一次，运行期间切换位置只在下次启动生效，
/// 避免数据库连接仍指向旧库、新写入却落到新根的分叉状态。
static ACTIVE: OnceLock<PathBuf> = OnceLock::new();

pub fn root() -> Result<PathBuf, String> {
    if let Some(path) = ACTIVE.get() {
        fs::create_dir_all(path).map_err(|_| "无法创建数据存储目录".to_string())?;
        return Ok(path.clone());
    }
    let dir = configured_root()?;
    // 并发首调用时以先写入者为准，保持全进程同一根。
    let chosen = ACTIVE.get_or_init(|| dir.clone()).clone();
    fs::create_dir_all(&chosen).map_err(|_| "无法创建数据存储目录".to_string())?;
    Ok(chosen)
}

/// 配置指向的数据根（偏好值）；下次启动才成为实际根。
pub fn configured_root() -> Result<PathBuf, String> {
    if let Some(custom) = read_pointer()? {
        return Ok(custom);
    }
    let exe = std::env::current_exe().map_err(|e| format!("无法定位安装目录：{e}"))?;
    Ok(exe.parent().ok_or("安装目录不可用")?.join("data"))
}

pub fn category(name: &str) -> Result<PathBuf, String> {
    let dir = root()?.join(name);
    fs::create_dir_all(&dir).map_err(|_| format!("无法创建数据目录 {name}"))?;
    Ok(dir)
}

pub fn write_pointer(path: Option<&Path>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位安装目录：{e}"))?;
    let pointer = exe.parent().ok_or("安装目录不可用")?.join("storage-root.txt");
    match path {
        None => {
            // 回到默认根：把当前自定义根记为迁移来源，重启时搬到默认位置。
            if let Some(current) = read_pointer()? {
                let _ = fs::write(pointer.with_extension("prev.txt"), current.to_string_lossy().as_bytes());
            } else {
                let _ = fs::remove_file(pointer.with_extension("prev.txt"));
            }
            let _ = fs::remove_file(pointer);
            Ok(())
        }
        Some(path) => {
            // 换根时旧根记入 prev.txt；实际搬移与生效在下次启动（数据库未打开）时执行。
            if let Ok(current) = root() {
                if current != path {
                    let _ = fs::write(pointer.with_extension("prev.txt"), current.to_string_lossy().as_bytes());
                }
            }
            fs::write(pointer, path.to_string_lossy().as_bytes()).map_err(|e| format!("无法记录数据存储位置：{e}"))
        }
    }
}

/// 配置已改，但本次进程仍在旧根上运行（需要重启才迁到新位置）。
pub fn restart_required() -> bool {
    match (ACTIVE.get(), read_pointer()) {
        (Some(active), Ok(Some(wanted))) => *active != wanted,
        (Some(_), Ok(None)) => configured_root().map(|dir| ACTIVE.get() != Some(&dir)).unwrap_or(false),
        _ => false,
    }
}

/// 上一次使用的数据根（切换位置后由启动流程迁往新根）。
pub fn previous_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let prev = exe.parent()?.join("storage-root.prev.txt");
    let text = fs::read_to_string(prev).ok()?;
    let path = PathBuf::from(text.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() { return None; }
    Some(path)
}

fn read_pointer() -> Result<Option<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位安装目录：{e}"))?;
    let pointer = exe.parent().ok_or("安装目录不可用")?.join("storage-root.txt");
    let Ok(text) = fs::read_to_string(pointer) else { return Ok(None); };
    let path = PathBuf::from(text.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() { return Ok(None); }
    Ok(Some(path))
}

/// 把旧的应用数据目录按类别搬进 data。目标已存在则保留，不覆盖。
pub fn migrate_legacy(legacy: &Path, root: &Path) {
    if legacy == root { return; }
    let _ = fs::create_dir_all(root);
    move_if_absent(&legacy.join("skills"), &root.join("skills"));
    move_if_absent(&legacy.join("avatar"), &root.join("avatar"));
    move_if_absent(&legacy.join("examples"), &root.join("examples"));
    move_if_absent(&legacy.join("editor-operations"), &root.join("editor"));
    move_if_absent(&legacy.join("kb-recycle"), &root.join("recycle"));
    move_if_absent(&legacy.join("kb-index"), &root.join("index"));
    move_if_absent(&legacy.join("smoke"), &root.join("logs").join("smoke"));
    let _ = fs::create_dir_all(root.join("secrets"));
    move_if_absent(&legacy.join("secrets.json"), &root.join("secrets").join("secrets.json"));
    move_if_absent(&legacy.join("server-secrets.json"), &root.join("secrets").join("server-secrets.json"));
    move_if_absent(&legacy.join("git-credentials"), &root.join("git").join("git-credentials"));
    move_if_absent(&legacy.join("office-demo"), &root.join("office").join("office-demo"));
    move_if_absent(&legacy.join("generated-images"), &root.join("generated-images"));
    if let Ok(entries) = fs::read_dir(legacy) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with("-profiles") {
                move_if_absent(&entry.path(), &root.join("chat").join(name));
            }
        }
    }
    let _ = fs::create_dir_all(root.join("db"));
    for name in ["workbench.db", "workbench.db-wal", "workbench.db-shm", "workbench-smoke.db", "workbench-smoke.db-wal", "workbench-smoke.db-shm"] {
        move_if_absent(&legacy.join(name), &root.join("db").join(name));
    }
}

fn move_if_absent(from: &Path, to: &Path) {
    if !from.exists() || to.exists() { return; }
    if let Some(parent) = to.parent() { let _ = fs::create_dir_all(parent); }
    if fs::rename(from, to).is_err() {
        let _ = copy_tree(from, to);
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_file() {
        if let Some(parent) = to.parent() { fs::create_dir_all(parent)?; }
        fs::copy(from, to)?;
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
        let dir = base.join(format!("nc-storage-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrate_legacy_sorts_categories_and_never_overwrites() {
        let legacy = temp_dir("legacy");
        let root = temp_dir("root");
        fs::create_dir_all(legacy.join("skills/demo")).unwrap();
        fs::write(legacy.join("skills/demo/SKILL.md"), "skill").unwrap();
        fs::write(legacy.join("secrets.json"), "{\"k\":\"v\"}").unwrap();
        fs::write(legacy.join("server-secrets.json"), "{}").unwrap();
        fs::write(legacy.join("workbench.db"), "db-bytes").unwrap();
        fs::create_dir_all(legacy.join("codex-profiles")).unwrap();
        fs::write(legacy.join("codex-profiles/thread.json"), "t").unwrap();
        fs::create_dir_all(legacy.join("kb-index")).unwrap();
        fs::write(legacy.join("kb-index/meta"), "i").unwrap();
        fs::create_dir_all(legacy.join("smoke")).unwrap();
        fs::write(legacy.join("smoke/report.md"), "r").unwrap();

        // 已有同名目标必须保留，不得被旧数据覆盖。
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        fs::write(root.join("skills/demo/SKILL.md"), "newer").unwrap();

        migrate_legacy(&legacy, &root);

        assert_eq!(fs::read_to_string(root.join("skills/demo/SKILL.md")).unwrap(), "newer");
        assert_eq!(fs::read_to_string(root.join("secrets/secrets.json")).unwrap(), "{\"k\":\"v\"}");
        assert!(root.join("secrets/server-secrets.json").is_file());
        assert_eq!(fs::read_to_string(root.join("db/workbench.db")).unwrap(), "db-bytes");
        assert!(root.join("chat/codex-profiles/thread.json").is_file());
        assert!(root.join("index/meta").is_file());
        assert!(root.join("logs/smoke/report.md").is_file());
        assert!(!legacy.join("workbench.db").exists(), "旧库已迁走，避免下次启动读到两个库");

        // 二次执行幂等：目标已存在时不再改动。
        migrate_legacy(&legacy, &root);
        assert_eq!(fs::read_to_string(root.join("db/workbench.db")).unwrap(), "db-bytes");
        let _ = fs::remove_dir_all(&legacy);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_legacy_leaves_unrelated_files_and_same_root_alone() {
        let legacy = temp_dir("unrelated");
        let root = temp_dir("root2");
        fs::write(legacy.join("third-party.cfg"), "keep").unwrap();
        migrate_legacy(&legacy, &root);
        assert!(legacy.join("third-party.cfg").is_file(), "不认识的来源文件不搬");
        assert!(!root.join("third-party.cfg").exists());

        let same = temp_dir("same");
        fs::write(same.join("workbench.db"), "x").unwrap();
        migrate_legacy(&same, &same);
        assert!(same.join("workbench.db").is_file());
        let _ = fs::remove_dir_all(&legacy);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&same);
    }
}
