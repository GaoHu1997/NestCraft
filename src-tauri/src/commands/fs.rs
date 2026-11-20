//! 文件系统命令（编码区）：目录树、读/写文件、文本搜索。
//!
//! 路径安全：所有操作限制在传入的 rootUri 之下，拒绝 traversal 与符号链接逃逸
//! （ADR-001 / DB-FEAT-001 一致性要求）。

use crate::models::FileNode;
use tauri::Manager;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 校验 target 必须位于 root 之下（canonicalize 后前缀匹配）。
/// 相对路径按 root 解析；target 或其父目录不存在时按词法解析（不逃逸即可）。
fn ensure_under(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root_c = std::fs::canonicalize(root).map_err(|e| format!("目录不可访问：{}", e))?;
    let target_abs = if target.is_absolute() { target.to_path_buf() } else { root.join(target) };
    let target_c = match std::fs::canonicalize(&target_abs) {
        Ok(p) => p,
        Err(_) => {
            // 文件尚不存在：校验其父目录（必须存在且在 root 内）
            let parent = target_abs.parent().ok_or("路径无效")?;
            let parent_c = std::fs::canonicalize(parent).map_err(|e| format!("路径不可访问：{}", e))?;
            if !parent_c.starts_with(&root_c) {
                return Err("路径越界：目标不在项目目录内".into());
            }
            return Ok(parent_c.join(target_abs.file_name().ok_or("路径无效")?));
        }
    };
    if !target_c.starts_with(&root_c) {
        return Err("路径越界：目标不在项目目录内".into());
    }
    Ok(target_c)
}

/// 列出目录的一层内容（懒加载树）。
#[tauri::command]
pub fn fs_list_dir(root_uri: String, rel_path: String) -> Result<Vec<FileNode>, String> {
    let root = Path::new(&root_uri);
    let target = if rel_path.is_empty() { root.to_path_buf() } else { root.join(&rel_path) };
    let dir = ensure_under(root, &target)?;
    let mut out: Vec<FileNode> = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = ent.path();
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // 跳过符号链接，防逃逸
        if meta.file_type().is_symlink() {
            continue;
        }
        out.push(FileNode {
            name: ent.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { Some(meta.len()) } else { None },
        });
    }
    out.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 递归列出目录树（深度限制，用于项目文件页签）。
#[tauri::command]
pub fn fs_list_tree(root_uri: String, max_depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let root = std::fs::canonicalize(&root_uri).map_err(|e| format!("目录不可访问：{}", e))?;
    let depth = max_depth.unwrap_or(6) as usize;
    let mut out = Vec::new();
    for ent in WalkDir::new(&root)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !(name == "node_modules" || name == ".git" || name == "target" || name == "dist")
        })
        .flatten()
    {
        if ent.depth() == 0 {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        out.push(FileNode {
            name: ent.file_name().to_string_lossy().to_string(),
            path: ent.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { Some(meta.len()) } else { None },
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn fs_read_file(root_uri: String, path: String) -> Result<String, String> {
    let p = ensure_under(Path::new(&root_uri), Path::new(&path))?;
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败：{}", e))
}

#[tauri::command]
pub fn fs_write_file(root_uri: String, path: String, content: String) -> Result<(), String> {
    let p = ensure_under(Path::new(&root_uri), Path::new(&path))?;
    let tmp = p.with_extension(format!("{}", "tmp_write"));
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入失败：{}", e))
}

/// 删除文件（仅限 rootUri 之内；需求文档删除用）。
#[tauri::command]
pub fn fs_delete_file(root_uri: String, path: String) -> Result<(), String> {
    let p = ensure_under(Path::new(&root_uri), Path::new(&path))?;
    if !p.is_file() {
        return Err("目标不是文件".into());
    }
    std::fs::remove_file(&p).map_err(|e| format!("删除失败：{}", e))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line_no: i64,
    pub line_text: String,
}

/// 简单文本搜索（逐行 LIKE），限制返回条数避免大仓库卡顿。
#[tauri::command]
pub fn fs_search(root_uri: String, query: String, limit: Option<i64>) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let root = std::fs::canonicalize(&root_uri).map_err(|e| e.to_string())?;
    let cap = limit.unwrap_or(200);
    let mut hits: Vec<SearchHit> = Vec::new();
    let q_lower = query.to_lowercase();
    for ent in WalkDir::new(&root)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !(name == "node_modules" || name == ".git" || name == "target" || name == "dist")
        })
        .flatten()
    {
        if hits.len() >= cap as usize {
            break;
        }
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        // 只搜文本类扩展名，跳过二进制
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        const TEXT_EXT: &[&str] = &["md", "txt", "rs", "ts", "tsx", "js", "jsx", "json", "toml", "yaml", "yml", "css", "html", "py", "java", "go", "c", "h", "cpp", "sql", "sh", "vue", "xml"];
        if !TEXT_EXT.contains(&ext.as_str()) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(path) {
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&q_lower) {
                    hits.push(SearchHit {
                        path: path.to_string_lossy().to_string(),
                        line_no: (i + 1) as i64,
                        line_text: line.chars().take(200).collect(),
                    });
                    if hits.len() >= cap as usize {
                        break;
                    }
                }
            }
        }
    }
    Ok(hits)
}

/// 系统目录选择器，仅返回用户所选路径；取消返回 null，不创建或删除目录。
#[tauri::command]
pub async fn pick_project_directory() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目目录'
$dialog.ShowNewFolderButton = $false
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        ConvertTo-Json -InputObject $dialog.SelectedPath -Compress
    } else {
        [Console]::WriteLine('null')
    }
} finally { $dialog.Dispose() }
"#;
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let windows = std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用")?;
        let exe = Path::new(&windows).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = tokio::process::Command::new(exe);
        command.args(["-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", &encoded])
            .stdin(std::process::Stdio::null()).kill_on_drop(true);
        // 不通过 cmd/shell 解释路径，也不落盘脚本或加载 profile。
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(std::time::Duration::from_secs(600), command.output()).await
            .map_err(|_| "目录选择超时，请重试".to_string())?
            .map_err(|_| "无法打开系统目录选择器".to_string())?;
        if !output.status.success() { return Err("系统目录选择器执行失败".into()); }
        parse_directory_choice(&output.stdout)
    }
    #[cfg(not(windows))]
    { Err("当前平台未接入系统目录选择器".into()) }
}

#[cfg(any(windows, test))]
fn parse_directory_choice(bytes: &[u8]) -> Result<Option<String>, String> {
    if bytes.len() > 32768 { return Err("目录选择结果过长".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "目录选择结果编码无效".to_string())?;
    let value: Option<String> = serde_json::from_str(text.trim_start_matches('\u{feff}').trim())
        .map_err(|_| "目录选择结果无效".to_string())?;
    match value {
        Some(path) if !path.trim().is_empty() && Path::new(&path).is_absolute() => {
            let canonical = std::fs::canonicalize(&path).map_err(|_| "选择的目录不可访问".to_string())?;
            if !canonical.is_dir() || std::fs::read_dir(&canonical).is_err() { return Err("选择的目录不可访问".into()); }
            Ok(Some(canonical.to_string_lossy().to_string()))
        }
        Some(_) => Err("目录选择结果不是绝对目录".into()),
        None => Ok(None),
    }
}

/// 在应用数据目录下确保子目录存在并返回规范绝对路径。
/// 仅限 app_data 之内（拒绝 traversal），用于办公演示项目的容器目录（CR-043 / AC-STORY-065-10）；
/// 树内容一律不落盘，此命令只创建空容器。
#[tauri::command]
pub fn app_data_ensure_dir(app: tauri::AppHandle, rel: String) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("应用数据目录不可用：{}", e))?;
    let rel_trim = rel.trim().trim_start_matches(['/', '\\']).to_string();
    if rel_trim.is_empty() {
        return Err("子目录不能为空".into());
    }
    let parts: Vec<&str> = rel_trim.split(['/', '\\']).collect();
    if parts.iter().any(|p| *p == ".." || p.is_empty()) {
        return Err("子目录路径越界".into());
    }
    let full = base.join(rel_trim.replace('\\', "/"));
    std::fs::create_dir_all(&full).map_err(|e| format!("创建目录失败：{}", e))?;
    let canonical = std::fs::canonicalize(&full).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&std::fs::canonicalize(&base).map_err(|e| e.to_string())?) {
        return Err("子目录路径越界".into());
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_choice_handles_cancellation_and_rejects_invalid_output() {
        assert_eq!(parse_directory_choice(b"null\r\n").unwrap(), None);
        assert!(parse_directory_choice(br#""relative/path""#).is_err());
        assert!(parse_directory_choice(b"not-json").is_err());
        assert!(parse_directory_choice(&vec![b' '; 32769]).is_err());
    }

    #[test]
    fn directory_choice_uses_real_existing_directory_without_creating_any() {
        let directory = std::env::temp_dir().join(crate::models::new_id("picker-test"));
        std::fs::create_dir(&directory).unwrap();
        let bytes = serde_json::to_vec(&directory.to_string_lossy()).unwrap();
        let selected = parse_directory_choice(&bytes).unwrap().unwrap();
        assert_eq!(PathBuf::from(selected), std::fs::canonicalize(&directory).unwrap());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        std::fs::remove_dir(directory).unwrap();
    }
}
