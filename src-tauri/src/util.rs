//! 通用工具。

use std::path::{Path, PathBuf};

/// 在 Windows 上解析裸命令名（PATH × PATHEXT），返回显式路径。
/// Rust std 对显式 .bat/.cmd 路径会经 cmd.exe 安全执行（BatBadBut 加固）；
/// 但对不含扩展名的裸名不会自动尝试 .cmd/.bat，因此这里自行解析。
pub fn resolve_command(name: &str) -> String {
    let p = Path::new(name);
    if p.is_absolute() {
        return name.to_string();
    }
    if name.contains('.') && p.extension().is_some() {
        // 带扩展名：按 PATH 逐目录查找
        if let Some(found) = find_in_path(name) {
            return found.to_string_lossy().to_string();
        }
        return name.to_string();
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for dir in path_dirs() {
        for ext in pathext.split(';') {
            let cand: PathBuf = dir.join(format!("{}{}", name, ext.to_ascii_lowercase()));
            if cand.is_file() {
                return cand.to_string_lossy().to_string();
            }
        }
    }
    // 未找到：原样返回，让 spawn 报出明确错误
    name.to_string()
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    for dir in path_dirs() {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}
