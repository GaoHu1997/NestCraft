//! 项目数据统一放在数据目录下，按类别分文件夹。
//! 默认是安装目录的 data；设置里改位置后写入 storage-root.txt，下次启动和后续写入都走新位置。

use std::fs;
use std::io::Write;
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

/// 启动时同步迁移的核心类别（体量小，数据库必须在其中完成）。
/// 大类 `chat/<cli>-profiles`（可达数 GB）不在这里搬，交给后台续传。
fn migrate_core(legacy: &Path, root: &Path) {
    if legacy == root { return; }
    let _ = fs::create_dir_all(root);
    merge_path(&legacy.join("skills"), &root.join("skills"));
    merge_path(&legacy.join("avatar"), &root.join("avatar"));
    merge_path(&legacy.join("examples"), &root.join("examples"));
    merge_path(&legacy.join("editor-operations"), &root.join("editor"));
    merge_path(&legacy.join("kb-recycle"), &root.join("recycle"));
    merge_path(&legacy.join("kb-index"), &root.join("index"));
    merge_path(&legacy.join("smoke"), &root.join("logs").join("smoke"));
    let _ = fs::create_dir_all(root.join("secrets"));
    merge_path(&legacy.join("secrets.json"), &root.join("secrets").join("secrets.json"));
    merge_path(&legacy.join("server-secrets.json"), &root.join("secrets").join("server-secrets.json"));
    merge_path(&legacy.join("git-credentials"), &root.join("git").join("git-credentials"));
    merge_path(&legacy.join("office-demo"), &root.join("office").join("office-demo"));
    merge_path(&legacy.join("generated-images"), &root.join("generated-images"));
    let _ = fs::create_dir_all(root.join("db"));
    for name in ["workbench.db", "workbench.db-wal", "workbench.db-shm", "workbench-smoke.db", "workbench-smoke.db-wal", "workbench-smoke.db-shm"] {
        merge_path(&legacy.join(name), &root.join("db").join(name));
    }
}

/// 待后台续传的 CLI 会话线程存储：`<legacy>/<cli>-profiles` → `<root>/chat/<cli>-profiles`。
/// 单目录可达数 GB，跨盘复制耗时以分钟计，不能放在启动同步路径上。
pub fn deferred_profile_pairs(legacy: &Path, root: &Path) -> Vec<(PathBuf, PathBuf)> {
    if legacy == root { return Vec::new(); }
    let mut pairs = Vec::new();
    if let Ok(entries) = fs::read_dir(legacy) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with("-profiles") && entry.path().is_dir() {
                pairs.push((entry.path(), root.join("chat").join(name)));
            }
        }
    }
    pairs
}

/// 启动迁移入口：只在主线程同步迁核心数据，返回需要后台续传的会话存储。
/// 同步部分不含 `chat/<cli>-profiles`，避免大目录复制阻塞窗口消息循环（BUG-001）。
pub fn migrate_on_startup(legacy: &Path, root: &Path) -> Vec<(PathBuf, PathBuf)> {
    if legacy == root { return Vec::new(); }
    let started = std::time::Instant::now();
    migrate_core(legacy, root);
    let pending = deferred_profile_pairs(legacy, root);
    log_startup(
        root,
        &format!(
            "sync migrate from {} finished in {} ms; deferred profile dirs: {}",
            legacy.display(),
            started.elapsed().as_millis(),
            pending.len()
        ),
    );
    pending
}

/// 启动全量同步迁移（含会话存储）。启动路径已改为 `migrate_on_startup` + 后台续传，
/// 本函数保留给测试与需要一次做完的调用方。
pub fn migrate_legacy(legacy: &Path, root: &Path) {
    if legacy == root { return; }
    migrate_core(legacy, root);
    for (from, to) in deferred_profile_pairs(legacy, root) {
        merge_path(&from, &to);
    }
}

/// 后台续传会话存储：不阻塞窗口；中途退出后，下次启动会继续补齐未复制完的文件。
pub fn spawn_deferred_migration(root: PathBuf, pending: Vec<(PathBuf, PathBuf)>) {
    if pending.is_empty() { return; }
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        for (from, to) in &pending {
            let one = std::time::Instant::now();
            merge_path(from, to);
            log_startup(
                &root,
                &format!("deferred migrate {} -> {} finished in {} ms", from.display(), to.display(), one.elapsed().as_millis()),
            );
        }
        log_startup(
            &root,
            &format!("deferred migrate all finished in {} ms ({} dirs)", started.elapsed().as_millis(), pending.len()),
        );
    });
}

/// 合并式迁移：源不存在跳过；目标已存在跳过（不覆盖）；目录递归逐项合并。
/// 与「目标目录存在就整目录跳过」不同，中断后再执行会补齐缺失文件（BUG-001 半份数据）。
pub fn merge_path(from: &Path, to: &Path) {
    if !from.exists() { return; }
    if from.is_file() {
        if to.exists() { return; }
        if let Some(parent) = to.parent() { let _ = fs::create_dir_all(parent); }
        if fs::rename(from, to).is_err() {
            let _ = fs::copy(from, to);
        }
        return;
    }
    if let Some(parent) = to.parent() { let _ = fs::create_dir_all(parent); }
    if fs::create_dir_all(to).is_err() { return; }
    let Ok(entries) = fs::read_dir(from) else { return; };
    for entry in entries.flatten() {
        merge_path(&entry.path(), &to.join(entry.file_name()));
    }
}

/// 启动期日志：追加到 `<root>/logs/startup.log`，记录迁移耗时与结果，失败不影响启动。
pub fn log_startup(root: &Path, line: &str) {
    let dir = root.join("logs");
    let _ = fs::create_dir_all(&dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("startup.log")) {
        let _ = writeln!(file, "{stamp} {line}");
    }
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
    fn migrate_on_startup_defers_profiles_and_resumes_partial_copy() {
        let legacy = temp_dir("defer-legacy");
        let root = temp_dir("defer-root");
        fs::create_dir_all(legacy.join("skills/demo")).unwrap();
        fs::write(legacy.join("skills/demo/SKILL.md"), "skill").unwrap();
        fs::create_dir_all(legacy.join("codex-profiles/sess-a")).unwrap();
        fs::write(legacy.join("codex-profiles/sess-a/thread.json"), "a").unwrap();
        fs::write(legacy.join("codex-profiles/sess-b.json"), "b").unwrap();

        let pending = migrate_on_startup(&legacy, &root);
        assert_eq!(pending.len(), 1, "会话存储进后台待迁清单");
        assert!(root.join("skills/demo/SKILL.md").is_file(), "核心数据同步迁完");
        assert!(!root.join("chat/codex-profiles").exists(), "会话存储不在启动同步路径");

        // 模拟上次迁移中途退出：目标只落了部分文件。
        fs::create_dir_all(root.join("chat/codex-profiles/sess-a")).unwrap();
        fs::write(root.join("chat/codex-profiles/sess-a/thread.json"), "a").unwrap();
        for (from, to) in migrate_on_startup(&legacy, &root) {
            merge_path(&from, &to);
        }
        assert_eq!(fs::read_to_string(root.join("chat/codex-profiles/sess-a/thread.json")).unwrap(), "a");
        assert!(root.join("chat/codex-profiles/sess-b.json").is_file(), "中断后缺失文件被续传补齐");
        let _ = fs::remove_dir_all(&legacy);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_path_resumes_without_overwriting_existing_files() {
        let from = temp_dir("merge-from");
        let to = temp_dir("merge-to");
        fs::create_dir_all(from.join("d")).unwrap();
        fs::write(from.join("d/keep.txt"), "old").unwrap();
        fs::write(from.join("d/missing.txt"), "new").unwrap();
        fs::create_dir_all(to.join("d")).unwrap();
        fs::write(to.join("d/keep.txt"), "current").unwrap();

        merge_path(&from, &to);

        assert_eq!(fs::read_to_string(to.join("d/keep.txt")).unwrap(), "current", "已有文件不覆盖");
        assert_eq!(fs::read_to_string(to.join("d/missing.txt")).unwrap(), "new", "缺失文件补齐");
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
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
