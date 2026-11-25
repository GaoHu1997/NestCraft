//! 编码区文件操作命令：新建文件/目录、改名/移动、删除、存在性校验。
//!
//! 路径安全：全部限制在传入的 root_uri 之下，复用 `fs::ensure_under` 的越界校验语义
//! （canonicalize + 前缀匹配），拒绝 traversal 逃逸与符号链接目标。所有错误字符串使用
//! 中文，可直接展示给用户。

use std::path::{Path, PathBuf};

use super::ensure_under;

/// 解析并校验相对路径：非空、目标非符号链接、且位于 root 之下。
/// 返回 canonicalize 后的目标路径（目标不存在时返回其父目录下的词法拼接结果）。
fn resolve(root_uri: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    let root = Path::new(root_uri);
    // 目标本身若是符号链接（含断链），拒绝，避免借链接改写 root 之外的内容。
    let raw = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { root.join(rel) };
    if let Ok(meta) = std::fs::symlink_metadata(&raw) {
        if meta.file_type().is_symlink() {
            return Err("目标为符号链接，已拒绝".into());
        }
    }
    ensure_under(root, Path::new(rel))
}

/// 新建空文件。父目录必须存在；目标已存在报错；用 create_new 防竞态。
#[tauri::command]
pub fn fs_create_file(root_uri: String, rel_path: String) -> Result<(), String> {
    let target = resolve(&root_uri, &rel_path)?;
    let parent = target.parent().ok_or("路径无效")?;
    if !parent.is_dir() {
        return Err("父目录不存在".into());
    }
    if target.exists() {
        return Err("已存在同名文件".into());
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                "已存在同名文件".to_string()
            } else {
                format!("创建文件失败：{}", e)
            }
        })?;
    Ok(())
}

/// 新建目录（只建一层，不递归）；父目录必须存在；已存在报错。
#[tauri::command]
pub fn fs_create_dir(root_uri: String, rel_path: String) -> Result<(), String> {
    let target = resolve(&root_uri, &rel_path)?;
    if target.exists() {
        return Err("已存在同名目录或文件".into());
    }
    let parent = target.parent().ok_or("路径无效")?;
    if !parent.is_dir() {
        return Err("父目录不存在".into());
    }
    std::fs::create_dir(&target).map_err(|e| format!("创建目录失败：{}", e))
}

/// 同根内改名/移动。源必须存在，目标不得已存在，目标父目录必须存在。
#[tauri::command]
pub fn fs_rename(root_uri: String, from_rel: String, to_rel: String) -> Result<(), String> {
    let from = resolve(&root_uri, &from_rel)?;
    let to = resolve(&root_uri, &to_rel)?;
    if !from.exists() {
        return Err("源路径不存在".into());
    }
    if to.exists() {
        return Err("目标已存在同名文件或目录".into());
    }
    let to_parent = to.parent().ok_or("路径无效")?;
    if !to_parent.is_dir() {
        return Err("目标父目录不存在".into());
    }
    std::fs::rename(&from, &to).map_err(|e| format!("重命名失败：{}", e))
}

/// 删除文件，或删除空目录（非空目录报错）；不允许删除根目录本身。
#[tauri::command]
pub fn fs_delete_path(root_uri: String, rel_path: String) -> Result<(), String> {
    let target = resolve(&root_uri, &rel_path)?;
    let root_c = std::fs::canonicalize(&root_uri).map_err(|e| format!("目录不可访问：{}", e))?;
    if target == root_c {
        return Err("不允许删除根目录".into());
    }
    let meta = std::fs::symlink_metadata(&target).map_err(|e| format!("路径不存在：{}", e))?;
    if meta.is_dir() {
        let mut rd = std::fs::read_dir(&target).map_err(|e| format!("读取目录失败：{}", e))?;
        if rd.next().is_some() {
            return Err("目录非空".into());
        }
        std::fs::remove_dir(&target).map_err(|e| format!("删除目录失败：{}", e))
    } else if meta.is_file() {
        std::fs::remove_file(&target).map_err(|e| format!("删除失败：{}", e))
    } else {
        Err("不支持删除该类型的路径".into())
    }
}

/// 供前端做重名校验；路径逃逸或为空时返回错误，仅供存在判断。
#[tauri::command]
pub fn fs_path_exists(root_uri: String, rel_path: String) -> Result<bool, String> {
    let target = resolve(&root_uri, &rel_path)?;
    Ok(target.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(crate::models::new_id("fs-ops-test"));
            std::fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }
        fn uri(&self) -> String {
            self.root.to_string_lossy().into_owned()
        }
        fn join(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn create_file_succeeds_and_rejects_existing_and_missing_parent() {
        let f = Fixture::new();
        fs_create_file(f.uri(), "a.txt".into()).unwrap();
        assert!(f.join("a.txt").is_file());
        // 已存在同名文件
        let err = fs_create_file(f.uri(), "a.txt".into()).unwrap_err();
        assert!(err.contains("已存在"), "{}", err);
        // 父目录不存在
        let err = fs_create_file(f.uri(), "no_dir/b.txt".into()).unwrap_err();
        assert!(!err.is_empty());
        assert!(!f.join("no_dir").exists());
    }

    #[test]
    fn create_dir_succeeds_and_rejects_existing_and_multi_level() {
        let f = Fixture::new();
        fs_create_dir(f.uri(), "d".into()).unwrap();
        assert!(f.join("d").is_dir());
        // 已存在
        let err = fs_create_dir(f.uri(), "d".into()).unwrap_err();
        assert!(err.contains("已存在"), "{}", err);
        // 不递归：多层路径应失败
        let err = fs_create_dir(f.uri(), "x/y/z".into()).unwrap_err();
        assert!(!err.is_empty());
        assert!(!f.join("x").exists());
    }

    #[test]
    fn rename_succeeds_and_rejects_existing_and_out_of_root() {
        let f = Fixture::new();
        fs_create_file(f.uri(), "old.txt".into()).unwrap();
        fs_rename(f.uri(), "old.txt".into(), "new.txt".into()).unwrap();
        assert!(!f.join("old.txt").exists());
        assert!(f.join("new.txt").is_file());
        // 目标已存在
        fs_create_file(f.uri(), "other.txt".into()).unwrap();
        let err = fs_rename(f.uri(), "new.txt".into(), "other.txt".into()).unwrap_err();
        assert!(err.contains("已存在"), "{}", err);
        // 源不存在
        assert!(fs_rename(f.uri(), "ghost.txt".into(), "x.txt".into()).is_err());
        // 跨根越界
        let other = Fixture::new();
        let outside = other.join("moved.txt").to_string_lossy().into_owned();
        let err = fs_rename(f.uri(), "new.txt".into(), outside).unwrap_err();
        assert!(err.contains("越界"), "{}", err);
        assert!(f.join("new.txt").is_file());
    }

    #[test]
    fn delete_handles_file_empty_dir_non_empty_dir_and_root() {
        let f = Fixture::new();
        // 删除文件
        fs_create_file(f.uri(), "file.txt".into()).unwrap();
        fs_delete_path(f.uri(), "file.txt".into()).unwrap();
        assert!(!f.join("file.txt").exists());
        // 删除空目录
        fs_create_dir(f.uri(), "empty".into()).unwrap();
        fs_delete_path(f.uri(), "empty".into()).unwrap();
        assert!(!f.join("empty").exists());
        // 删除非空目录应失败
        fs_create_dir(f.uri(), "full".into()).unwrap();
        fs_create_file(f.uri(), "full/inner.txt".into()).unwrap();
        let err = fs_delete_path(f.uri(), "full".into()).unwrap_err();
        assert!(err.contains("目录非空"), "{}", err);
        assert!(f.join("full/inner.txt").is_file());
        // 删除根目录应失败
        let err = fs_delete_path(f.uri(), ".".into()).unwrap_err();
        assert!(!err.is_empty());
        assert!(f.root.is_dir());
    }

    #[test]
    fn path_exists_reports_state_and_rejects_escape() {
        let f = Fixture::new();
        assert!(!fs_path_exists(f.uri(), "nope.txt".into()).unwrap());
        fs_create_file(f.uri(), "here.txt".into()).unwrap();
        assert!(fs_path_exists(f.uri(), "here.txt".into()).unwrap());
        // 空路径拒绝
        assert!(fs_path_exists(f.uri(), "".into()).is_err());
        // .. 逃逸
        let escape = format!("../{}", crate::models::new_id("escape"));
        assert!(fs_path_exists(f.uri(), escape).is_err());
    }

    #[test]
    fn traversal_escape_is_rejected_across_commands() {
        let f = Fixture::new();
        let escape = format!("../{}", crate::models::new_id("escape"));
        assert!(fs_create_file(f.uri(), escape.clone()).is_err());
        assert!(fs_create_dir(f.uri(), escape.clone()).is_err());
        assert!(fs_delete_path(f.uri(), escape).is_err());
    }
}
