//! Skill / MCP / Tool 能力注册（对照 skill/mcp 面板插件逻辑移植，全局统一管理）。
//!
//! - Skill：受管目录 app_data_dir/skills/<name>/SKILL.md，DB 存索引与启用状态
//! - MCP：DB 存服务器配置；tools 经最小 MCP 客户端（stdio/http JSON-RPC）发现
//! - Tool：内置只读工具注册表（含风险等级）

use crate::db;
use crate::models::{McpServer, McpToolInfo, SkillEntry, ToolEntry, now_ms, new_id};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use std::thread;

// ---------- Skill ----------

#[tauri::command]
pub fn skill_list(app: tauri::AppHandle) -> Result<Vec<SkillEntry>, String> {
    let skills_dir = crate::storage_layout::category("skills")?;
    std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    // 目录扫描 + DB 状态
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for ent in std::fs::read_dir(&skills_dir).map_err(|e| e.to_string())?.flatten() {
        let path = ent.path();
        let skill_md = path.join("SKILL.md");
        if !path.is_dir() || !skill_md.exists() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let description = content
            .lines()
            .find(|l| l.starts_with("description:"))
            .map(|l| l.trim_start_matches("description:").trim().to_string());
        let source_ref = skill_md.to_string_lossy().to_string();
        let enabled: bool = conn
            .query_row(
                "SELECT enabled FROM capability WHERE kind='skill' AND name=?1",
                [&name],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(true);
        out.push(SkillEntry {
            builtin: false,
            description,
            enabled,
            id: format!("skill:{}", name),
            name,
            source_ref,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub content: String, // SKILL.md 正文
}

#[tauri::command]
pub fn skill_save(app: tauri::AppHandle, draft: SkillDraft) -> Result<(), String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("技能名称不能为空".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("技能名称只能包含字母、数字、连字符和下划线".into());
    }
    let dir = crate::storage_layout::category("skills")?.join(&name);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let skill_md = dir.join("SKILL.md");
    if skill_md.exists() {
        return Err("同名技能已存在".into());
    }
    let body = format!("# {}\n\ndescription: {}\n\n---\n\n{}", name, draft.description, draft.content);
    std::fs::write(&skill_md, body).map_err(|e| e.to_string())?;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT OR IGNORE INTO capability (id, kind, name, description, sourceRef, risk, enabled, builtin, createdAt)
         VALUES (?1,'skill',?2,?3,?4,'low',1,0,?5)",
        rusqlite::params![new_id("cap"), name, draft.description, skill_md.to_string_lossy(), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skill_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = crate::storage_layout::category("skills")?.join(&name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("DELETE FROM capability WHERE kind='skill' AND name=?1", [&name]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn skill_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let changed = conn
        .execute(
            "UPDATE capability SET enabled=?2 WHERE kind='skill' AND name=?1",
            rusqlite::params![name, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO capability (id, kind, name, risk, enabled, builtin, createdAt) VALUES (?1,'skill',?2,'low',?3,0,?4)",
            rusqlite::params![new_id("cap"), name, enabled as i64, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn skill_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let p = crate::storage_layout::category("skills")?.join(&name).join("SKILL.md");
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

// ---------- CR-059 F1/F2：Skill 文件夹导入与跨 agent 扫描 ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFolderPreview {
    /// 用户所选目录的绝对路径（只读展示）。
    pub path: String,
    /// 是否找到 SKILL.md。
    pub valid: bool,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub body: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanItem {
    pub agent: String,
    pub source: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub imported: bool,
    /// 无效（缺 SKILL.md 或不可读）时给出原因。
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanGroup {
    pub agent: String,
    pub root: String,
    pub exists: bool,
    pub items: Vec<SkillScanItem>,
}

fn slugify_skill(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "skill".to_string() } else { trimmed }
}

fn front_value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find(|line| line.starts_with(&format!("{key}:")))
        .map(|line| line.trim_start_matches(&format!("{key}:")).trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|v| !v.is_empty())
}

fn read_skill_folder(path: &std::path::Path) -> Result<SkillFolderPreview, String> {
    let skill_md = path.join("SKILL.md");
    let base = SkillFolderPreview {
        path: path.to_string_lossy().to_string(),
        valid: false,
        name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        slug: slugify_skill(&path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        description: String::new(),
        body: String::new(),
    };
    if !path.is_dir() {
        return Ok(base);
    }
    if !skill_md.is_file() {
        return Ok(base);
    }
    let text = std::fs::read_to_string(&skill_md).map_err(|e| format!("SKILL.md 读取失败：{e}"))?;
    if text.len() > 512 * 1024 {
        return Err("SKILL.md 超过 512 KiB，拒绝导入".into());
    }
    let name = front_value(&text, "name")
        .or_else(|| text.lines().find(|l| l.starts_with("# ")).map(|l| l.trim_start_matches("# ").trim().to_string()))
        .unwrap_or_else(|| base.name.clone());
    let slug = slugify_skill(&front_value(&text, "slug").unwrap_or_else(|| base.slug.clone()));
    Ok(SkillFolderPreview {
        valid: true,
        name,
        slug,
        description: front_value(&text, "description").unwrap_or_default(),
        body: text,
        ..base
    })
}

/// 只读识别用户选中的技能文件夹（不复制、不登记）。
#[tauri::command]
pub fn skill_folder_preview(path: String) -> Result<SkillFolderPreview, String> {
    let canonical = std::fs::canonicalize(path.trim())
        .map_err(|_| "所选目录不可访问".to_string())?;
    if !canonical.is_dir() {
        return Err("所选路径不是目录".into());
    }
    read_skill_folder(&canonical)
}

/// 把整个技能目录递归复制到受管技能目录（app_data_dir/skills/<slug>/）。
/// 跳过符号链接与超限单文件，返回复制结果供界面如实提示。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub slug: String,
    pub copied: usize,
    pub skipped: Vec<String>,
}

#[tauri::command]
pub fn skill_import_folder(
    app: tauri::AppHandle,
    path: String,
    slug: Option<String>,
) -> Result<SkillImportResult, String> {
    let source = std::fs::canonicalize(path.trim()).map_err(|_| "所选目录不可访问".to_string())?;
    let preview = read_skill_folder(&source)?;
    if !preview.valid {
        return Err("所选文件夹没有 SKILL.md，无法识别为技能".into());
    }
    let requested = slug.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let final_slug = slugify_skill(requested.unwrap_or(&preview.slug));
    if final_slug.is_empty() {
        return Err("技能标识无效".into());
    }
    let skills_root = crate::storage_layout::category("skills")?;
    std::fs::create_dir_all(&skills_root).map_err(|e| e.to_string())?;
    let target = skills_root.join(&final_slug);
    if target.exists() {
        return Err(format!("同名技能已存在：{final_slug}"));
    }
    // 先复制到临时目录再改名，失败时不留半成品。
    let temp = skills_root.join(format!(".import-{}-{}", final_slug, new_id("tmp")));
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let mut copied = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    let mut stack = vec![source.clone()];
    let copy_result = (|| -> Result<(), String> {
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => { skipped.push(entry.path().to_string_lossy().to_string()); continue; }
                };
                let rel = entry.path().strip_prefix(&source).map_err(|e| e.to_string())?.to_path_buf();
                if meta.file_type().is_symlink() {
                    skipped.push(format!("{}（符号链接）", rel.to_string_lossy()));
                    continue;
                }
                if meta.is_dir() {
                    std::fs::create_dir_all(temp.join(&rel)).map_err(|e| e.to_string())?;
                    stack.push(entry.path());
                } else if meta.is_file() {
                    if meta.len() > 512 * 1024 {
                        skipped.push(format!("{}（超过 512 KiB）", rel.to_string_lossy()));
                        continue;
                    }
                    std::fs::copy(entry.path(), temp.join(&rel)).map_err(|e| format!("复制 {} 失败：{e}", rel.to_string_lossy()))?;
                    copied += 1;
                }
            }
        }
        std::fs::rename(&temp, &target).map_err(|e| format!("落盘失败：{e}"))
    })();
    if let Err(error) = copy_result {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    // 登记 capability（sourceRef 指向受管副本，不再依赖外部源）。
    let skill_md = target.join("SKILL.md");
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT OR IGNORE INTO capability (id, kind, name, description, sourceRef, risk, enabled, builtin, createdAt)
         VALUES (?1,'skill',?2,?3,?4,'low',1,0,?5)",
        rusqlite::params![new_id("cap"), final_slug, preview.description, skill_md.to_string_lossy(), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(SkillImportResult { slug: final_slug, copied, skipped })
}

/// 跨 agent 技能扫描：只读固定候选目录，不执行任何指令、不读凭据。
#[tauri::command]
pub fn skill_scan_sources(app: tauri::AppHandle) -> Result<Vec<SkillScanGroup>, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let skills_root = crate::storage_layout::category("skills")?;
    let imported: Vec<String> = std::fs::read_dir(&skills_root)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    let candidates: [(&str, std::path::PathBuf); 4] = [
        ("Claude Code", home.join(".claude").join("skills")),
        ("Codex", home.join(".codex").join("skills")),
        ("ZCode", home.join(".zcode").join("skills")),
        ("通用", home.join(".agents").join("skills")),
    ];
    let mut out = Vec::new();
    for (agent, root) in candidates {
        let exists = root.is_dir();
        let mut items = Vec::new();
        if exists {
            for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
                let path = entry.path();
                if !path.is_dir() { continue; }
                match read_skill_folder(&path) {
                    Ok(preview) if preview.valid => {
                        items.push(SkillScanItem {
                            agent: agent.to_string(),
                            source: path.to_string_lossy().to_string(),
                            name: preview.name,
                            slug: preview.slug.clone(),
                            description: preview.description,
                            imported: imported.iter().any(|s| s == &preview.slug),
                            error: None,
                        });
                    }
                    Ok(_) => items.push(SkillScanItem {
                        agent: agent.to_string(),
                        source: path.to_string_lossy().to_string(),
                        name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        slug: slugify_skill(&path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
                        description: String::new(),
                        imported: false,
                        error: Some("缺少 SKILL.md".into()),
                    }),
                    Err(error) => items.push(SkillScanItem {
                        agent: agent.to_string(),
                        source: path.to_string_lossy().to_string(),
                        name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        slug: String::new(),
                        description: String::new(),
                        imported: false,
                        error: Some(error),
                    }),
                }
            }
        }
        items.sort_by(|a, b| a.name.cmp(&b.name));
        out.push(SkillScanGroup { agent: agent.to_string(), root: root.to_string_lossy().to_string(), exists, items });
    }
    Ok(out)
}

// ---------- Tool（内置只读注册表） ----------

/// CR-059：pub(crate) 供 ai_tools 单测校验「注册表 ↔ 工具目录」两侧不漂移。
pub(crate) const BUILTIN_TOOLS: [(&str, &str, &str, &str); 22] = [
    ("fs.read", "读取项目内文件", "low", "read"),
    ("knowledge.list", "列出项目已授权知识库", "low", "read"),
    ("knowledge.search", "在已授权知识库内检索", "low", "read"),
    ("knowledge.read", "读取知识库笔记正文", "low", "read"),
    ("knowledge.read_many", "批量读取知识库笔记", "low", "read"),
    ("ssh-exec", "在服务器上执行命令（需连接、授权与逐次审批）", "high", "exec"),
    // CR-059：内置工作台工具集（MCP 服务器 workbench；与 ai_tools.rs 工具目录一致）
    ("workbench.get_context", "AI 获取当前会话绑定的项目上下文", "low", "config"),
    ("workbench.list_projects", "AI 列出项目清单", "low", "config"),
    ("workbench.create_project", "AI 创建项目（重名与目录校验与界面一致）", "medium", "config"),
    ("workbench.update_project", "AI 更新项目名称/根目录/图标", "medium", "config"),
    ("workbench.get_requirements", "AI 读取项目需求树", "low", "config"),
    ("workbench.read_requirement_doc", "AI 读取需求文档正文", "low", "config"),
    ("workbench.write_requirement_doc", "AI 创建/更新需求文档（自动编号与 front matter）", "medium", "config"),
    ("workbench.list_kbs", "AI 列出知识库与授权状态", "low", "config"),
    ("workbench.create_kb", "AI 创建受管知识库（仅建库，不写知识内容）", "medium", "config"),
    ("workbench.set_kb_grant", "AI 设置项目-知识库读取授权", "medium", "config"),
    ("workbench.list_servers", "AI 列出服务器主机（不含密钥）", "low", "config"),
    ("workbench.save_server", "AI 新建/更新服务器主机配置（密钥只入受管密钥文件）", "medium", "config"),
    // CR-059 G4：生图（多模型有序、失败顺延；随 workbench MCP 注入）
    ("workbench.generate_image", "AI 生成图片（按配置顺序尝试生图模型，失败自动顺延）", "medium", "config"),
    // CR-054 / STORY-073：AI 请求打开工作台右栏（只读预览，不获得额外权限）
    ("workbench.open_panel", "AI 请求打开右侧预览面板（文件/需求/知识/办公文件）", "low", "config"),
    // CR-059 二期：查询 ssh_exec 高风险命令的跨进程审批结论
    ("workbench.ssh_exec_status", "AI 查询服务器命令审批结论与执行结果", "low", "config"),
    // CR-069 / STORY-091：派发工作给受管执行（只建批次与任务，不执行、不推进状态）
    ("workbench.dispatch_work", "AI 派发编码类工作给受管执行（只建批次与任务，不启动执行、不代表完成）", "medium", "config"),
];

#[tauri::command]
pub fn tool_list() -> Result<Vec<ToolEntry>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut out = Vec::new();
    for (id, desc, risk, _) in BUILTIN_TOOLS.iter() {
        let enabled: bool = conn
            .query_row(
                "SELECT enabled FROM capability WHERE kind='tool' AND name=?1",
                [id],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .unwrap_or(true);
        out.push(ToolEntry {
            builtin: true,
            description: Some(desc.to_string()),
            enabled,
            id: format!("tool:{}", id),
            name: id.to_string(),
            risk: risk.to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn tool_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let changed = conn
        .execute(
            "UPDATE capability SET enabled=?2 WHERE kind='tool' AND name=?1",
            rusqlite::params![name, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO capability (id, kind, name, risk, enabled, builtin, createdAt) VALUES (?1,'tool',?2,'low',?3,1,?4)",
            rusqlite::params![new_id("cap"), name, enabled as i64, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- MCP ----------

fn row_to_server(r: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    Ok(McpServer {
        args: serde_json::from_str(&r.get::<_, Option<String>>(4)?.unwrap_or_default()).unwrap_or_default(),
        command: r.get(2)?,
        enabled: r.get::<_, i64>(7)? != 0,
        env: serde_json::from_str(&r.get::<_, Option<String>>(5)?.unwrap_or_default()).unwrap_or_default(),
        id: r.get(0)?,
        name: r.get(1)?,
        tools: serde_json::from_str(&r.get::<_, Option<String>>(9)?.unwrap_or_default()).unwrap_or_default(),
        transport: r.get(3)?,
        url: r.get(6)?,
        auth_status: r.get::<_, Option<String>>(10)?.unwrap_or_else(|| "unauthenticated".into()),
        auth_revision: r.get::<_, Option<i64>>(11)?.unwrap_or(0),
        auth_mode: r.get::<_, Option<String>>(12)?.unwrap_or_else(|| "oauth".into()),
        allow_insecure_local_tls: r.get::<_, Option<i64>>(13)?.unwrap_or(0) != 0,
    })
}

#[tauri::command]
pub fn mcp_list() -> Result<Vec<McpServer>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, transport, argsJson, envJson, url, enabled, NULL, toolsJson, authStatus, authRevision, authMode, allowInsecureLocalTls FROM mcp_server ORDER BY createdAt",
        )
        .map_err(|e| e.to_string())?;
    let out: Vec<McpServer> = stmt
        .query_map([], row_to_server)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDraft {
    pub id: Option<String>,
    pub name: String,
    pub transport: String, // stdio | http
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub url: Option<String>,
    pub enabled: bool,
    /// http：oauth | bearer | none；stdio 忽略。
    #[serde(default)]
    pub auth_mode: Option<String>,
    /// 静态 Bearer 令牌明文，仅本次写入受管密钥，绝不回读。
    #[serde(default)]
    pub auth_token: Option<String>,
    /// 仅 loopback HTTPS 允许；其他主机传入 true 直接拒绝。
    #[serde(default)]
    pub allow_insecure_local_tls: bool,
}

#[tauri::command]
pub fn mcp_save(app: tauri::AppHandle, draft: McpDraft) -> Result<String, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("MCP 名称不能为空".into());
    }
    // 名称规则：^[A-Za-z0-9_-]{1,32}$（对照 skill/mcp 面板校验规则）
    let name_ok = name.len() >= 1
        && name.chars().count() <= 32
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !name_ok {
        return Err("MCP 名称只能包含字母、数字、下划线和连字符，长度 1-32".into());
    }
    if draft.transport != "stdio" && draft.transport != "http" {
        return Err("传输类型必须是 stdio 或 http".into());
    }
    if draft.transport == "stdio" && draft.command.as_deref().map(|c| c.trim().is_empty()).unwrap_or(true) {
        return Err("stdio 服务器必须填写启动命令".into());
    }
    if draft.transport == "http" && draft.url.as_deref().map(|u| u.trim().is_empty()).unwrap_or(true) {
        return Err("http 服务器必须填写 URL".into());
    }
    let auth_mode = draft.auth_mode.clone().unwrap_or_else(|| "oauth".into());
    if draft.transport == "http" && !["oauth", "bearer", "none"].contains(&auth_mode.as_str()) {
        return Err("HTTP MCP 认证方式必须为 oauth、bearer 或 none".into());
    }
    let token = draft.auth_token.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    if draft.transport == "http" && auth_mode == "bearer" && token.is_none() && draft.id.is_none() {
        return Err("静态令牌认证需要填写 Bearer 令牌".into());
    }
    let allow_insecure_local_tls = draft.allow_insecure_local_tls && draft.transport == "http";
    if allow_insecure_local_tls {
        let url = draft.url.as_deref().unwrap_or("");
        if !url.starts_with("https://") || !is_loopback_url(url) {
            return Err("仅允许为本机 loopback 的 HTTPS MCP 信任自签名证书".into());
        }
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let now = now_ms();
    let id = match &draft.id {
        Some(id) => {
            // 端点变化必须使旧凭据失效：否则旧 Bearer 会被派发到新地址。
            let previous: Option<(String, Option<String>, String, Option<String>)> = conn
                .query_row("SELECT transport, url, authMode, authCredentialRef FROM mcp_server WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "oauth".into()), r.get(3)?)))
                .ok();
            let endpoint_changed = previous.as_ref().map(|(transport, url, mode, _)| {
                transport == "http" && (url.as_deref() != draft.url.as_deref() || mode != &auth_mode)
            }).unwrap_or(false);
            conn.execute(
                "UPDATE mcp_server SET name=?2, transport=?3, command=?4, argsJson=?5, envJson=?6, url=?7, enabled=?8, authMode=?9, allowInsecureLocalTls=?10 WHERE id=?1",
                rusqlite::params![
                    id, name, draft.transport, draft.command,
                    serde_json::to_string(&draft.args).ok(),
                    serde_json::to_string(&draft.env).ok(),
                    draft.url, draft.enabled as i64, auth_mode, allow_insecure_local_tls as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            if endpoint_changed {
                // 端点或认证方式变化：旧令牌一律作废，状态回到未授权。
                if let Some(reference) = previous.as_ref().and_then(|(_, _, _, reference)| reference.as_deref()) {
                    remove_mcp_credential(&app, reference)?;
                }
                remove_mcp_credential(&app, &format!("mcp-bearer:{}", id))?;
                conn.execute("UPDATE mcp_server SET authStatus='unauthenticated', authCredentialRef=NULL, authRevision=authRevision+1 WHERE id=?1", [id]).map_err(|e| e.to_string())?;
            }
            id.clone()
        }
        None => {
            // 重复名拒绝
            let dup: i64 = conn
                .query_row("SELECT COUNT(*) FROM mcp_server WHERE name=?1", [&name], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            if dup > 0 {
                return Err(format!("同名 MCP 服务器已存在：{}", name));
            }
            let id = new_id("mcp");
            conn.execute(
                "INSERT INTO mcp_server (id, name, transport, command, argsJson, envJson, url, enabled, createdAt, authMode, allowInsecureLocalTls)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                rusqlite::params![
                    id, name, draft.transport, draft.command,
                    serde_json::to_string(&draft.args).ok(),
                    serde_json::to_string(&draft.env).ok(),
                    draft.url, draft.enabled as i64, now, auth_mode, allow_insecure_local_tls as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    // 结束 DB 锁作用域后再处理受管密钥：db::conn 使用不可重入 Mutex，
    // 持锁再次获取会永久阻塞并连带阻塞其他数据库命令。
    drop(guard);
    // 静态令牌只写受管密钥；清除或切换认证方式时删除旧值，避免残留。
    let reference = format!("mcp-bearer:{}", id);
    let is_http_bearer = draft.transport == "http" && auth_mode == "bearer";
    match (is_http_bearer, token) {
        (true, Some(token)) => save_mcp_credential(&app, &reference, &token)?,
        (true, None) => {
            if load_mcp_credential(&app, &reference)?.is_none() {
                return Err("静态令牌认证需要填写 Bearer 令牌".into());
            }
        }
        (false, _) => { remove_mcp_credential(&app, &reference)?; }
    }
    if is_http_bearer {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute("UPDATE mcp_server SET authStatus='authenticated', authCredentialRef=?2, authRevision=authRevision+1 WHERE id=?1", rusqlite::params![id, reference]).map_err(|e| e.to_string())?;
    } else if draft.transport == "http" && auth_mode != "oauth" {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute("UPDATE mcp_server SET authStatus='unauthenticated', authCredentialRef=NULL, authRevision=authRevision+1 WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    Ok(id)
}

// ---------- CR-059 F4：MCP 跨 agent 扫描导入 ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpScanItem {
    pub agent: String,
    pub source: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    /// 敏感值只标记数量，绝不回显正文。
    pub env_keys: Vec<String>,
    pub url: Option<String>,
    pub imported: bool,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpScanGroup {
    pub agent: String,
    pub root: String,
    pub exists: bool,
    pub items: Vec<McpScanItem>,
}

fn collect_scan_item(
    agent: &str,
    source: &str,
    name: &str,
    cfg: &serde_json::Value,
    existing: &[String],
) -> McpScanItem {
    let imported = existing.iter().any(|n| n == name);
    let transport_raw = cfg.get("transport").and_then(Value::as_str)
        .or_else(|| cfg.get("type").and_then(Value::as_str))
        .unwrap_or("");
    let url = cfg.get("url").and_then(Value::as_str).map(str::to_string);
    let transport = match transport_raw {
        "stdio" => "stdio",
        "http" | "streamable-http" | "streamable_http" => "http",
        "sse" | "websocket" | "ws" => "unsupported",
        _ => if url.is_some() { "http" } else { "stdio" },
    };
    let command = cfg.get("command").and_then(Value::as_str).map(str::to_string);
    let args: Vec<String> = cfg.get("args")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let env_keys: Vec<String> = cfg.get("env")
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let error = if transport == "unsupported" {
        Some("SSE / WebSocket 传输本版不支持".into())
    } else if transport == "stdio" && command.is_none() {
        Some("缺少 command".into())
    } else if transport == "http" && url.is_none() {
        Some("缺少 url".into())
    } else {
        None
    };
    McpScanItem {
        agent: agent.to_string(),
        source: source.to_string(),
        name: name.to_string(),
        transport: transport.to_string(),
        command,
        args,
        env_keys,
        url,
        imported,
        error,
    }
}

/// 极简 TOML 解析：[mcp_servers.<name>] 段内的 command/args/url 键。
/// 只覆盖 Codex 配置的实际结构，不做通用 TOML 支持；无法解析的段落跳过并给出原因。
fn parse_codex_mcp_servers(text: &str) -> Vec<(String, serde_json::Value)> {
    let mut out: Vec<(String, serde_json::Value)> = Vec::new();
    let mut current: Option<(String, serde_json::Value)> = None;
    let flush = |current: &mut Option<(String, serde_json::Value)>, out: &mut Vec<(String, serde_json::Value)>| {
        if let Some(entry) = current.take() { out.push(entry); }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if line.starts_with('[') {
            flush(&mut current, &mut out);
            let header = line.trim_start_matches('[').trim_end_matches(']');
            if let Some(rest) = header.strip_prefix("mcp_servers.") {
                let name = rest.trim().trim_matches('"').to_string();
                if !name.is_empty() && !name.contains('.') {
                    current = Some((name, serde_json::json!({ "transport": "stdio" })));
                }
            }
            continue;
        }
        let Some((name, cfg)) = current.as_mut() else { continue };
        let _ = name;
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let value = value.trim();
        let unquote = |v: &str| v.trim().trim_matches('"').trim_matches('\'').to_string();
        match key {
            "command" => { cfg["command"] = serde_json::json!(unquote(value)); }
            "url" => { cfg["url"] = serde_json::json!(unquote(value)); cfg["transport"] = serde_json::json!("http"); }
            "args" => {
                let inner = value.trim_start_matches('[').trim_end_matches(']');
                let args: Vec<serde_json::Value> = inner.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(|v| serde_json::json!(unquote(v)))
                    .collect();
                cfg["args"] = serde_json::Value::Array(args);
            }
            _ => {}
        }
    }
    flush(&mut current, &mut out);
    out
}

/// 只读扫描其他 agent 的 MCP 配置（不含登录态与令牌正文）。
#[tauri::command]
pub fn mcp_scan_sources() -> Result<Vec<McpScanGroup>, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let existing: Vec<String> = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let mut stmt = conn.prepare("SELECT name FROM mcp_server").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut groups = Vec::new();

    // Claude Code：~/.claude.json 的 mcpServers
    let claude_path = home.join(".claude.json");
    let mut claude_items = Vec::new();
    if claude_path.is_file() {
        match std::fs::read_to_string(&claude_path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(parsed) => {
                    if let Some(map) = parsed.get("mcpServers").and_then(Value::as_object) {
                        for (name, cfg) in map {
                            claude_items.push(collect_scan_item("Claude Code", &claude_path.to_string_lossy(), name, cfg, &existing));
                        }
                    }
                }
                Err(_) => claude_items.push(McpScanItem {
                    agent: "Claude Code".into(), source: claude_path.to_string_lossy().to_string(),
                    name: "（配置文件解析失败）".into(), transport: "-".into(), command: None, args: vec![],
                    env_keys: vec![], url: None, imported: false, error: Some("配置不是合法 JSON".into()),
                }),
            },
            Err(_) => claude_items.push(McpScanItem {
                agent: "Claude Code".into(), source: claude_path.to_string_lossy().to_string(),
                name: "（配置文件不可读）".into(), transport: "-".into(), command: None, args: vec![],
                env_keys: vec![], url: None, imported: false, error: Some("文件不可读".into()),
            }),
        }
    }
    groups.push(McpScanGroup {
        agent: "Claude Code".into(), root: claude_path.to_string_lossy().to_string(),
        exists: claude_path.is_file(), items: claude_items,
    });

    // Codex：~/.codex/config.toml 的 [mcp_servers.*]
    let codex_path = home.join(".codex").join("config.toml");
    let mut codex_items = Vec::new();
    if codex_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&codex_path) {
            for (name, cfg) in parse_codex_mcp_servers(&text) {
                codex_items.push(collect_scan_item("Codex", &codex_path.to_string_lossy(), &name, &cfg, &existing));
            }
        }
    }
    groups.push(McpScanGroup {
        agent: "Codex".into(), root: codex_path.to_string_lossy().to_string(),
        exists: codex_path.is_file(), items: codex_items,
    });

    // ZCode：~/.zcode/mcp.json（mcpServers 或 servers）
    let zcode_path = home.join(".zcode").join("mcp.json");
    let mut zcode_items = Vec::new();
    if zcode_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&zcode_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                let map = parsed.get("mcpServers").or_else(|| parsed.get("servers")).and_then(Value::as_object);
                if let Some(map) = map {
                    for (name, cfg) in map {
                        zcode_items.push(collect_scan_item("ZCode", &zcode_path.to_string_lossy(), name, cfg, &existing));
                    }
                }
            }
        }
    }
    groups.push(McpScanGroup {
        agent: "ZCode".into(), root: zcode_path.to_string_lossy().to_string(),
        exists: zcode_path.is_file(), items: zcode_items,
    });

    Ok(groups)
}

/// 导入一个扫描到的 MCP 配置（按 agent + name 重新只读解析源文件，env 值只在进程内传递）。
/// 返回值不回显任何 env 值。
#[tauri::command]
pub fn mcp_import_source(app: tauri::AppHandle, agent: String, name: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let lookup = |cfg: &serde_json::Value| -> Result<McpDraft, String> {
        let name = name.trim();
        if name.is_empty() { return Err("服务器名称不能为空".into()); }
        let transport_raw = cfg.get("transport").and_then(Value::as_str)
            .or_else(|| cfg.get("type").and_then(Value::as_str)).unwrap_or("");
        let url = cfg.get("url").and_then(Value::as_str).map(str::to_string);
        let transport = match transport_raw {
            "http" | "streamable-http" | "streamable_http" => "http",
            "sse" | "websocket" | "ws" => return Err("SSE / WebSocket 传输本版不支持".into()),
            _ => if url.is_some() { "http" } else { "stdio" },
        };
        let args: Vec<String> = cfg.get("args").and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let env: std::collections::BTreeMap<String, String> = cfg.get("env").and_then(Value::as_object)
            .map(|map| map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        Ok(McpDraft {
            id: None,
            name: name.to_string(),
            transport: transport.to_string(),
            command: cfg.get("command").and_then(Value::as_str).map(str::to_string),
            args,
            env,
            url,
            enabled: true,
            auth_mode: Some("oauth".into()),
            auth_token: None,
            allow_insecure_local_tls: false,
        })
    };
    let draft = match agent.as_str() {
        "Claude Code" => {
            let path = home.join(".claude.json");
            let text = std::fs::read_to_string(&path).map_err(|_| "Claude Code 配置不可读".to_string())?;
            let parsed: Value = serde_json::from_str(&text).map_err(|_| "Claude Code 配置不是合法 JSON".to_string())?;
            let cfg = parsed.get("mcpServers").and_then(Value::as_object)
                .and_then(|map| map.get(name.trim())).ok_or("源配置中已找不到该 MCP 服务器")?;
            lookup(cfg)?
        }
        "Codex" => {
            let path = home.join(".codex").join("config.toml");
            let text = std::fs::read_to_string(&path).map_err(|_| "Codex 配置不可读".to_string())?;
            let mut found = None;
            for (server, cfg) in parse_codex_mcp_servers(&text) {
                if server == name.trim() { found = Some(cfg); break; }
            }
            lookup(&found.ok_or("源配置中已找不到该 MCP 服务器")?)?
        }
        "ZCode" => {
            let path = home.join(".zcode").join("mcp.json");
            let text = std::fs::read_to_string(&path).map_err(|_| "ZCode 配置不可读".to_string())?;
            let parsed: Value = serde_json::from_str(&text).map_err(|_| "ZCode 配置不是合法 JSON".to_string())?;
            let cfg = parsed.get("mcpServers").or_else(|| parsed.get("servers"))
                .and_then(Value::as_object)
                .and_then(|map| map.get(name.trim())).ok_or("源配置中已找不到该 MCP 服务器")?;
            lookup(cfg)?
        }
        other => return Err(format!("未知来源：{other}")),
    };
    mcp_save(app, draft)
}

#[tauri::command]
pub fn mcp_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {    // 删除前清理本人凭据与未完成授权，避免残留可复用凭据或悬挂监听。
    let reference: Option<String> = {
        let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT authCredentialRef FROM mcp_server WHERE id=?1", [&id], |r| r.get(0)).ok().flatten()
    };
    if let Some(reference) = reference { remove_mcp_credential(&app, &reference)?; }
    remove_mcp_credential(&app, &format!("mcp-bearer:{}", id))?;
    {
        let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute("UPDATE mcp_auth_attempt SET status='cancelled',updatedAt=?2 WHERE mcpServerId=?1 AND status='pending'", rusqlite::params![id, now_ms()]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM mcp_server WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    // 丢弃内存中的待回调状态，使该服务器的监听不再完成授权。
    if let Ok(mut map) = pending_auth().lock() { map.retain(|_, pending| pending.server_id != id); }
    Ok(())
}

#[tauri::command]
pub fn mcp_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "UPDATE mcp_server SET enabled=?2 WHERE id=?1",
        rusqlite::params![id, enabled as i64],
    )
    .map_err(|e| e.to_string())?;
    if !enabled {
        conn.execute("UPDATE mcp_auth_attempt SET status='cancelled',updatedAt=?2 WHERE mcpServerId=?1 AND status='pending'", rusqlite::params![id, now_ms()]).map_err(|e| e.to_string())?;
        drop(guard);
        if let Ok(mut map) = pending_auth().lock() { map.retain(|_, pending| pending.server_id != id); }
    }
    Ok(())
}

// ---------- 最小 MCP 客户端（tools/list 发现） ----------

fn rpc(id: i64, method: &str, params: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "method": method, "params": params
    })
    .to_string()
}

fn parse_tools(result: &serde_json::Value) -> Vec<McpToolInfo> {
    result
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| McpToolInfo {
                    description: t.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                    name: t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                })
                .filter(|t| !t.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn mcp_discover_tools(app: tauri::AppHandle, server_id: String) -> Result<Vec<McpToolInfo>, String> {
    let (transport, command, args, env, url, auth_mode, allow_insecure_local_tls) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let row = conn
            .query_row(
                "SELECT transport, command, argsJson, envJson, url, authMode, allowInsecureLocalTls FROM mcp_server WHERE id=?1",
                [&server_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "oauth".into()),
                        r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        row
    };
    let tools = match transport.as_str() {
        "stdio" => {
            let command = command.ok_or("stdio 服务器缺少启动命令")?;
            let args_v: Vec<String> = serde_json::from_str(&args.unwrap_or_default()).unwrap_or_default();
            let env_v: std::collections::BTreeMap<String, String> =
                serde_json::from_str(&env.unwrap_or_default()).unwrap_or_default();
            mcp_stdio_tools(&command, &args_v, &env_v).await?
        }
        "http" => {
            let url = url.ok_or("http 服务器缺少 URL")?;
            mcp_http_tools(&app, &server_id, &url, &auth_mode, allow_insecure_local_tls).await?
        }
        t => return Err(format!("未知传输类型：{}", t)),
    };
    // 缓存工具清单
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute(
            "UPDATE mcp_server SET toolsJson=?2 WHERE id=?1",
            rusqlite::params![server_id, serde_json::to_string(&tools).ok()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(tools)
}

async fn mcp_stdio_tools(
    command: &str,
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
) -> Result<Vec<McpToolInfo>, String> {
    use tokio::io::AsyncBufReadExt;
    let mut cmd = tokio::process::Command::new(crate::util::resolve_command(command));
    cmd.args(args);
    for (k, v) in env.iter() {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("MCP 进程启动失败：{}", e))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());

    send_msg(&mut stdin, rpc(1, "initialize", serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": { "name": "agent-workbench", "version": "0.1.0" }
    }))).await?;
    // 读 initialize 响应（容忍通知行）
    let mut init_ok = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let mut line = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), stdout.read_line(&mut line))
            .await
            .map_err(|_| "initialize 超时".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("MCP 服务器已退出".into());
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
                init_ok = true;
                break;
            }
        }
    }
    if !init_ok {
        return Err("initialize 未收到响应".into());
    }
    send_msg(&mut stdin, serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string()).await?;
    send_msg(&mut stdin, rpc(2, "tools/list", serde_json::json!({}))).await?;
    let mut line = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), stdout.read_line(&mut line))
        .await
        .map_err(|_| "tools/list 超时".to_string())?
        .map_err(|e| e.to_string())?;
    let mut tools = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if let Some(result) = v.get("result") {
            tools = parse_tools(result);
        } else if let Some(err) = v.get("error") {
            return Err(format!("MCP 错误：{}", err));
        }
    }
    let _ = child.kill().await;
    Ok(tools)
}

/// 解析 Streamable HTTP 响应正文：纯 JSON 或 SSE 中第一条含 result/error 的事件。
fn mcp_http_payload(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() { return Err("MCP响应为空".into()); }
    if text.trim_start().starts_with('{') { return serde_json::from_str(text.trim()).map_err(|_| "MCP响应不是有效JSON".to_string()); }
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() { continue; }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if value.get("result").is_some() || value.get("error").is_some() { return Ok(value); }
        }
    }
    Err("MCP响应缺少result".into())
}

/// MCP 资源地址策略：HTTPS 任意主机；明文 HTTP 仅允许 loopback（精确主机比较，非前缀匹配）。
fn is_allowed_mcp_http_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") {
        return trimmed.len() > 8 && !trimmed[8..].starts_with('/');
    }
    trimmed.starts_with("http://") && is_loopback_url(trimmed)
}

/// 仅本机回环主机才允许启用自签名证书信任；其他主机始终走系统根证书校验。
fn is_loopback_url(url: &str) -> bool {
    let Some(rest) = url.split("://").nth(1) else { return false };
    let host_port = rest.split('/').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        host_port.split(']').next().unwrap_or("").trim_start_matches('[')
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    matches!(host.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}

#[derive(Debug)]
struct LoopbackOnlyVerifier(rustls::crypto::CryptoProvider);

impl rustls::client::danger::ServerCertVerifier for LoopbackOnlyVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // 即使放宽本机证书，也不允许把连接指向非 loopback 主机名。
        let allowed = match server_name {
            rustls::pki_types::ServerName::IpAddress(ip) => {
                let ip = std::net::IpAddr::from(*ip);
                ip.is_loopback()
            }
            rustls::pki_types::ServerName::DnsName(name) => name.as_ref().eq_ignore_ascii_case("localhost"),
            _ => false,
        };
        if !allowed { return Err(rustls::Error::General("仅允许本机回环地址的自签名证书".into())); }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// 构造 MCP HTTP 客户端：默认严格校验证书；仅当显式允许且目标为 loopback 时放宽。
fn mcp_http_agent(allow_insecure_local_tls: bool, url: &str) -> ureq::Agent {
    // 不跟随重定向：避免 loopback 放宽的校验被重定向到非本机主机绕过。
    let builder = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(20)).redirects(0);
    if allow_insecure_local_tls && url.starts_with("https://") && is_loopback_url(url) {
        let provider = rustls::crypto::ring::default_provider();
        let verifier = LoopbackOnlyVerifier(provider.clone());
        if let Ok(builder_with_versions) = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(provider)).with_safe_default_protocol_versions() {
            let config = builder_with_versions
                .dangerous()
                .with_custom_certificate_verifier(std::sync::Arc::new(verifier))
                .with_no_client_auth();
            return builder.tls_config(std::sync::Arc::new(config)).build();
        }
    }
    builder.build()
}

fn mcp_http_rpc(agent: &ureq::Agent, url: &str, bearer: Option<&str>, session: Option<&str>, body: &str) -> Result<(Option<String>, String), String> {
    let mut request = agent.post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream");
    if let Some(token) = bearer { request = request.set("Authorization", &format!("Bearer {}", token)); }
    if let Some(id) = session { request = request.set("Mcp-Session-Id", id); }
    let response = request.send_string(body).map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("MCP请求失败（HTTP {}）：未完成初始化或凭据无效", code),
        other => format!("MCP网络请求失败：{}", other),
    })?;
    let session_id = response.header("mcp-session-id").map(str::to_string);
    let text = response.into_string().map_err(|_| "MCP响应读取失败".to_string())?;
    Ok((session_id, text))
}

/// Streamable HTTP MCP：initialize → notifications/initialized → tools/list。
/// 会话必须沿用服务端下发的 Mcp-Session-Id；无会话头时现代服务端会拒绝工具列表。
fn mcp_http_discover(url: &str, bearer: Option<&str>, allow_insecure_local_tls: bool) -> Result<Vec<McpToolInfo>, String> {
    let agent = mcp_http_agent(allow_insecure_local_tls, url);
    let init = rpc(1, "initialize", serde_json::json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": { "name": "agent-workbench", "version": "0.1.0" }
    }));
    let (session, text) = mcp_http_rpc(&agent, url, bearer, None, &init)?;
    let value = mcp_http_payload(&text)?;
    if let Some(error) = value.get("error") { return Err(format!("MCP初始化错误：{}", error)); }
    if value.get("result").is_none() { return Err("MCP初始化未返回result".into()); }
    if let Some(session) = session.as_deref() {
        let initialized = serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string();
        mcp_http_rpc(&agent, url, bearer, Some(session), &initialized)?;
    }
    let list = rpc(2, "tools/list", serde_json::json!({}));
    let (_, text) = mcp_http_rpc(&agent, url, bearer, session.as_deref(), &list)?;
    let value = mcp_http_payload(&text)?;
    match value.get("result") {
        Some(result) => Ok(parse_tools(result)),
        None => Err(format!("MCP工具列表错误：{}", value.get("error").unwrap_or(&serde_json::json!("unknown")))),
    }
}

/// HTTP MCP 凭据：OAuth 走受管令牌/刷新，bearer 走静态受管密钥，none 不加认证头。
fn mcp_http_bearer(app: &tauri::AppHandle, server_id: &str, auth_mode: &str) -> Result<Option<String>, String> {
    match auth_mode {
        "oauth" => Ok(Some(mcp_access_token(app, server_id)?)),
        "bearer" => {
            let reference = format!("mcp-bearer:{}", server_id);
            Ok(Some(load_mcp_credential(app, &reference)?.ok_or("MCP静态令牌缺失，请重新填写")?))
        }
        "none" => Ok(None),
        other => Err(format!("未知的MCP认证方式：{}", other)),
    }
}

async fn mcp_http_tools(app: &tauri::AppHandle, server_id: &str, url: &str, auth_mode: &str, allow_insecure_local_tls: bool) -> Result<Vec<McpToolInfo>, String> {
    if !is_allowed_mcp_http_url(url) { return Err("HTTP MCP地址必须是HTTPS或本机loopback".into()); }
    let bearer = mcp_http_bearer(app, server_id, auth_mode)?;
    let url = url.to_string();
    tokio::task::spawn_blocking(move || mcp_http_discover(&url, bearer.as_deref(), allow_insecure_local_tls)).await.map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredMcpToken {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_at: Option<i64>,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    /// 令牌签发时绑定的 MCP 资源地址；地址变化后旧令牌不得再用。
    #[serde(default)]
    resource_url: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingMcpAuth {
    attempt_id: String,
    server_id: String,
    verifier: String,
    redirect_uri: String,
    resource_url: String,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    metadata_json: String,
    expires_at: i64,
}

static MCP_PENDING: OnceLock<Mutex<BTreeMap<String, PendingMcpAuth>>> = OnceLock::new();
static MCP_SECRET_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn pending_auth() -> &'static Mutex<BTreeMap<String, PendingMcpAuth>> {
    MCP_PENDING.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn secret_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::commands::providers::secrets_file_guard()
}

fn random_bytes_32() -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    out[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    out
}

fn pkce_pair() -> (String, String) {
    use sha2::{Digest, Sha256};
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes_32());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn state_value() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes_32())
}

fn state_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

fn percent_encode(value: &str) -> String {
    value.bytes().flat_map(|b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            vec![b as char]
        } else {
            format!("%{:02X}", b).chars().collect()
        }
    }).collect()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|part| {
        let mut it = part.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k != key { return None; }
        // 按字节解码，避免在非字符边界切片导致 panic；非法 %xx 一律拒绝该值。
        let bytes = v.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                if i + 2 >= bytes.len() { return None; }
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                let n = u8::from_str_radix(hex, 16).ok()?;
                out.push(n); i += 3; continue;
            }
            out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
            i += 1;
        }
        Some(String::from_utf8_lossy(&out).into_owned())
    }).next()
}

fn mcp_secret_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let _ = app;
    Ok(crate::storage_layout::category("secrets")?.join("secrets.json"))
}

fn read_secret_map(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    match std::fs::read(mcp_secret_path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "受管密钥文件格式无效".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err("受管密钥文件不可读取".into()),
    }
}

fn write_secret_map(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = mcp_secret_path(app)?;
    let tmp = path.with_file_name(format!("secrets-mcp-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp).map_err(|_| "无法写入受管密钥文件")?;
        file.write_all(&serde_json::to_vec_pretty(map).map_err(|_| "无法序列化受管密钥")?).map_err(|_| "无法写入受管密钥文件")?;
        file.sync_all().map_err(|_| "无法保存受管密钥文件")?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|_| "无法替换受管密钥文件，原文件已保留")
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map(|_| ()).map_err(|e| e.to_string())
}

fn save_mcp_token(app: &tauri::AppHandle, reference: &str, token: &StoredMcpToken) -> Result<(), String> {
    let _guard = secret_lock();
    let mut map = read_secret_map(app)?;
    map.insert(reference.to_string(), serde_json::to_string(token).map_err(|_| "无法序列化MCP令牌")?);
    write_secret_map(app, &map)
}

fn load_mcp_token(app: &tauri::AppHandle, reference: &str) -> Result<Option<StoredMcpToken>, String> {
    let _guard = secret_lock();
    let map = read_secret_map(app)?;
    map.get(reference).map(|raw| serde_json::from_str(raw).map_err(|_| "受管MCP令牌格式无效".into())).transpose()
}

fn remove_mcp_token(app: &tauri::AppHandle, reference: &str) -> Result<(), String> {
    let _guard = secret_lock();
    let mut map = read_secret_map(app)?;
    map.remove(reference);
    write_secret_map(app, &map)
}

/// 静态凭据（如 MCP Bearer）：与 OAuth 令牌共用受管密钥文件，但保存原始字符串。
fn save_mcp_credential(app: &tauri::AppHandle, reference: &str, value: &str) -> Result<(), String> {
    let _guard = secret_lock();
    let mut map = read_secret_map(app)?;
    map.insert(reference.to_string(), value.to_string());
    write_secret_map(app, &map)
}

fn load_mcp_credential(app: &tauri::AppHandle, reference: &str) -> Result<Option<String>, String> {
    let _guard = secret_lock();
    let map = read_secret_map(app)?;
    Ok(map.get(reference).filter(|value| !value.trim().is_empty()).cloned())
}

fn remove_mcp_credential(app: &tauri::AppHandle, reference: &str) -> Result<(), String> {
    remove_mcp_token(app, reference)
}

fn http_json(url: &str) -> Result<Value, String> {
    if !is_allowed_mcp_http_url(url) { return Err("OAuth元数据地址必须是HTTPS或本机loopback".to_string()); }
    ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).redirects(0).build()
        .get(url).set("Accept", "application/json").call()
        .map_err(|_| "OAuth元数据请求失败".to_string())?.into_json().map_err(|_| "OAuth元数据不是有效JSON".to_string())
}

fn url_origin(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{}://{}", &url[..scheme_end], &rest[..host_end]))
}

fn discover_oauth_metadata(resource: &str) -> Result<Value, String> {
    let origin = url_origin(resource).ok_or("MCP资源URL无效")?;
    let candidates = [
        format!("{}/.well-known/oauth-protected-resource", resource.trim_end_matches('/')),
        format!("{}/.well-known/oauth-protected-resource", origin),
    ];
    for candidate in candidates {
        if let Ok(value) = http_json(&candidate) {
            if value.get("authorization_servers").is_some() || value.get("authorization_endpoint").is_some() { return Ok(value); }
        }
    }
    let direct = format!("{}/.well-known/oauth-authorization-server", resource.trim_end_matches('/'));
    http_json(&direct)
}

fn authorization_metadata(resource: &str, protected: &Value) -> Result<Value, String> {
    if protected.get("authorization_endpoint").is_some() { return Ok(protected.clone()); }
    let issuer = protected.get("authorization_servers").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()).ok_or("OAuth缺少授权服务器")?;
    let issuer = issuer.trim_end_matches('/');
    let direct = http_json(&format!("{}/.well-known/oauth-authorization-server", issuer));
    direct.or_else(|_| http_json(&format!("{}/.well-known/openid-configuration", issuer))).map_err(|_| format!("无法读取MCP授权服务器元数据：{}", resource))
}

fn register_oauth_client(metadata: &Value, redirect_uri: &str) -> Result<(String, Option<String>), String> {
    let endpoint = metadata.get("registration_endpoint").and_then(|v| v.as_str()).ok_or("MCP未提供动态注册端点，且NestCraft没有预注册client配置")?;
    let body = serde_json::json!({"client_name":"NestCraft","redirect_uris":[redirect_uri],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"});
    let response: Value = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build().post(endpoint).set("Content-Type", "application/json").send_string(&body.to_string()).map_err(|e| format!("OAuth客户端动态注册失败：{}", e))?.into_json().map_err(|_| "OAuth客户端注册响应无效".to_string())?;
    let id = response.get("client_id").and_then(|v| v.as_str()).filter(|v| !v.is_empty()).ok_or("OAuth客户端注册未返回client_id")?.to_string();
    Ok((id, response.get("client_secret").and_then(|v| v.as_str()).map(str::to_string)))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthStart { pub status: String, pub authorization_url: String }

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)] { std::process::Command::new("explorer.exe").arg(url).spawn().map_err(|_| "无法打开系统浏览器")?; }
    #[cfg(target_os = "macos")] { std::process::Command::new("open").arg(url).spawn().map_err(|_| "无法打开系统浏览器")?; }
    #[cfg(all(unix, not(target_os = "macos")))] { std::process::Command::new("xdg-open").arg(url).spawn().map_err(|_| "无法打开系统浏览器")?; }
    Ok(())
}

fn set_mcp_auth_status(server_id: &str, status: &str, reference: Option<&str>) -> Result<(), String> {
    let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("UPDATE mcp_server SET authStatus=?2, authCredentialRef=?3, authRevision=authRevision+1 WHERE id=?1", rusqlite::params![server_id, status, reference]).map_err(|e| e.to_string())?;
    Ok(())
}

fn mark_mcp_attempt(state: &str, status: &str) -> Result<(), String> {
    let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute("UPDATE mcp_auth_attempt SET status=?2,updatedAt=?3 WHERE stateHash=?1 AND status='pending'", rusqlite::params![state_hash(state), status, now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn callback_response(stream: &mut std::net::TcpStream, body: &str) {
    let bytes = body.as_bytes();
    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
    let _ = stream.write_all(header.as_bytes()); let _ = stream.write_all(bytes); let _ = stream.flush();
}

fn complete_mcp_auth(app: &tauri::AppHandle, state: &str, query: &str) -> Result<(), String> {
    let pending = pending_auth().lock().map_err(|_| "OAuth状态锁不可用")?.remove(state).ok_or("OAuth状态不存在或已使用")?;
    let (attempt_server, attempt_hash, attempt_redirect, attempt_expires, attempt_status): (String, String, String, i64, String) = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT mcpServerId,stateHash,redirectUri,expiresAt,status FROM mcp_auth_attempt WHERE id=?1", [&pending.attempt_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_| "OAuth授权尝试不存在")? };
    if attempt_server != pending.server_id || attempt_hash != state_hash(state) || attempt_redirect != pending.redirect_uri || attempt_status != "pending" || attempt_expires < now_ms() || pending.expires_at < now_ms() || query_value(query, "state").as_deref() != Some(state) { return Err("OAuth回调状态无效或已过期".into()); }
    if let Some(error) = query_value(query, "error") { return Err(format!("OAuth授权被拒绝：{}", error)); }
    let code = query_value(query, "code").ok_or("OAuth回调缺少授权码")?;
    let mut form = vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", pending.redirect_uri.as_str()), ("client_id", pending.client_id.as_str()), ("code_verifier", pending.verifier.as_str())];
    if let Some(secret) = pending.client_secret.as_deref() { form.push(("client_secret", secret)); }
    let response: Value = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build().post(&pending.token_endpoint).send_form(&form).map_err(|_| "OAuth令牌交换失败")?.into_json().map_err(|_| "OAuth令牌响应无效")?;
    let access = response.get("access_token").and_then(|v| v.as_str()).filter(|v| !v.is_empty()).ok_or("OAuth令牌响应缺少access_token")?;
    let expires_at = response.get("expires_in").and_then(|v| v.as_i64()).map(|n| now_ms().saturating_add(n.saturating_mul(1000)));
    let token = StoredMcpToken { access_token: access.to_string(), refresh_token: response.get("refresh_token").and_then(|v| v.as_str()).map(str::to_string), token_type: response.get("token_type").and_then(|v| v.as_str()).unwrap_or("Bearer").to_string(), expires_at, token_endpoint: pending.token_endpoint.clone(), client_id: pending.client_id, client_secret: pending.client_secret, resource_url: Some(pending.resource_url.clone()) };
    let reference = format!("mcp-oauth:{}:{}", pending.server_id, pending.attempt_id);
    save_mcp_token(app, &reference, &token)?;
    let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
    // 仅当该服务器仍处于 pending 时提交；期间登出、改端点或重开会话则丢弃本次令牌。
    let changed = conn.execute("UPDATE mcp_server SET authStatus='authenticated',authCredentialRef=?2,authServerMetadataJson=?3,authRevision=authRevision+1 WHERE id=?1 AND authStatus='pending'", rusqlite::params![pending.server_id, reference, pending.metadata_json]).map_err(|e| e.to_string())?;
    if changed != 1 {
        drop(guard);
        let _ = remove_mcp_token(app, &reference);
        return Err("授权已取消或配置已变化，本次回调结果已丢弃".into());
    }
    conn.execute("UPDATE mcp_auth_attempt SET status='completed',updatedAt=?2 WHERE id=?1", rusqlite::params![pending.attempt_id, now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn serve_mcp_callback(listener: std::net::TcpListener, app: tauri::AppHandle, state: String) {
    let _ = listener.set_nonblocking(true);
    for _ in 0..300 {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // 读超时：避免只连接不发送的本地请求永久占住回调线程。
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                let mut buffer = [0u8; 16384]; let n = stream.read(&mut buffer).unwrap_or(0); let request = String::from_utf8_lossy(&buffer[..n]);
                let request_target = request.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|path| path.split_whitespace().next()).map(str::to_string);
                let query = request_target.filter(|target| target.split('?').next() == Some("/callback")).and_then(|target| target.split_once('?').map(|(_, q)| q.to_string())).unwrap_or_default();
                // 先校验回调确实带有本次 state；不匹配的本地请求不消耗一次性授权。
                if query_value(&query, "state").as_deref() != Some(state.as_str()) {
                    callback_response(&mut stream, "回调无效：缺少或不匹配的 state，未消耗授权。");
                    continue;
                }
                let server_id = pending_auth().lock().ok().and_then(|map| map.get(&state).map(|p| p.server_id.clone()));
                match complete_mcp_auth(&app, &state, &query) { Ok(()) => callback_response(&mut stream, "NestCraft OAuth授权完成，可以返回应用。"), Err(error) => { let _ = mark_mcp_attempt(&state, "failed"); if let Some(server_id) = server_id.as_deref() { let _ = set_mcp_auth_status(server_id, "error", None); } callback_response(&mut stream, &format!("NestCraft OAuth未完成：{}", error)); } }
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(std::time::Duration::from_secs(1)),
            Err(_) => break,
        }
    }
    if let Ok(mut map) = pending_auth().lock() { if let Some(pending) = map.remove(&state) { let _ = mark_mcp_attempt(&state, "expired"); let _ = set_mcp_auth_status(&pending.server_id, "expired", None); } }
}

#[tauri::command]
pub fn mcp_auth_start(app: tauri::AppHandle, server_id: String) -> Result<McpAuthStart, String> {
    let (transport, resource) = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT transport,url FROM mcp_server WHERE id=?1", [&server_id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,Option<String>>(1)?))).map_err(|_| "MCP服务器不存在")? };
    if transport != "http" { return Err("stdio MCP不使用OAuth".into()); }
    let resource = resource.ok_or("HTTP MCP缺少URL")?;
    if !is_allowed_mcp_http_url(&resource) { return Err("MCP OAuth只允许HTTPS，或本机loopback的HTTP资源".into()); }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "无法创建本机OAuth回调监听器")?;
    let port = listener.local_addr().map_err(|_| "无法读取OAuth回调端口")?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
    let protected = discover_oauth_metadata(&resource)?; let metadata = authorization_metadata(&resource, &protected)?;
    let authorization_endpoint = metadata.get("authorization_endpoint").and_then(|v|v.as_str()).ok_or("OAuth元数据缺少authorization_endpoint")?.to_string();
    let token_endpoint = metadata.get("token_endpoint").and_then(|v|v.as_str()).ok_or("OAuth元数据缺少token_endpoint")?.to_string();
    let (client_id, client_secret) = register_oauth_client(&metadata, &redirect_uri)?;
    let state = state_value(); let (verifier, challenge) = pkce_pair(); let expires_at = now_ms().saturating_add(300_000); let attempt_id = new_id("oauth");
    let pending = PendingMcpAuth { attempt_id: attempt_id.clone(), server_id: server_id.clone(), verifier, redirect_uri: redirect_uri.clone(), resource_url: resource.clone(), token_endpoint, client_id, client_secret, metadata_json: metadata.to_string(), expires_at };
    { let mut map = pending_auth().lock().map_err(|_| "OAuth状态锁不可用")?; map.insert(state.clone(), pending.clone()); }
    { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.execute("INSERT INTO mcp_auth_attempt (id,mcpServerId,stateHash,pkceChallenge,redirectUri,authorizationServer,expiresAt,status,createdAt,updatedAt) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8)", rusqlite::params![attempt_id,server_id,state_hash(&state),challenge,redirect_uri,authorization_endpoint,expires_at,now_ms()]).map_err(|e|e.to_string())?; conn.execute("UPDATE mcp_server SET authStatus='pending' WHERE id=?1", [&server_id]).map_err(|e|e.to_string())?; }
    let url = format!("{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256", authorization_endpoint, percent_encode(&pending.client_id), percent_encode(&pending.redirect_uri), percent_encode(&state), percent_encode(&challenge));
    let thread_app = app.clone(); let thread_state = state.clone(); thread::spawn(move || serve_mcp_callback(listener, thread_app, thread_state));
    if let Err(error) = open_browser(&url) { let _ = pending_auth().lock().map(|mut map| map.remove(&state)); let _ = set_mcp_auth_status(&server_id, "error", None); return Err(error); }
    Ok(McpAuthStart { status: "pending".into(), authorization_url: url })
}

#[tauri::command]
pub fn mcp_auth_status(server_id: String) -> Result<String, String> {
    let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.query_row("SELECT authStatus FROM mcp_server WHERE id=?1", [&server_id], |r| r.get(0)).map_err(|_| "MCP服务器不存在".into())
}

#[tauri::command]
pub fn mcp_auth_logout(app: tauri::AppHandle, server_id: String) -> Result<(), String> {
    let (reference, metadata_json): (Option<String>, Option<String>) = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT authCredentialRef,authServerMetadataJson FROM mcp_server WHERE id=?1", [&server_id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "MCP服务器不存在")? };
    if let Some(reference) = reference {
        if let Some(token) = load_mcp_token(&app, &reference)? {
            if let Some(endpoint) = metadata_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()).and_then(|v| v.get("revocation_endpoint").and_then(|x| x.as_str()).map(str::to_string)) {
                let _ = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build().post(&endpoint).send_form(&[("token", token.access_token.as_str()), ("token_type_hint", "access_token"), ("client_id", token.client_id.as_str())]);
            }
        }
        remove_mcp_token(&app, &reference)?;
    }
    { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.execute("UPDATE mcp_auth_attempt SET status='cancelled',updatedAt=?2 WHERE mcpServerId=?1 AND status='pending'", rusqlite::params![server_id, now_ms()]).map_err(|e| e.to_string())?; }
    set_mcp_auth_status(&server_id, "revoked", None)
}

/// 供派发使用的 HTTP MCP 凭据解析：读取认证方式后返回对应 Bearer。
pub(crate) fn mcp_http_authorization(app: &tauri::AppHandle, server_id: &str) -> Result<Option<String>, String> {
    let auth_mode: String = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT authMode FROM mcp_server WHERE id=?1", [server_id], |r| r.get::<_, Option<String>>(0)).map_err(|_| "MCP服务器不存在")?.unwrap_or_else(|| "oauth".into()) };
    mcp_http_bearer(app, server_id, &auth_mode)
}

/// 读取并在临近过期时刷新NestCraft拥有的MCP访问令牌。
pub(crate) fn mcp_access_token(app: &tauri::AppHandle, server_id: &str) -> Result<String, String> {
    let (status, reference, current_url): (String, Option<String>, Option<String>) = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT authStatus,authCredentialRef,url FROM mcp_server WHERE id=?1", [server_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "MCP服务器不存在")? };
    if status != "authenticated" { return Err(format!("MCP未授权，当前状态：{}", status)); }
    let reference = reference.ok_or("MCP缺少受管凭据引用")?; let mut token = load_mcp_token(app, &reference)?.ok_or("MCP受管凭据不存在")?;
    // 令牌与资源地址绑定：端点变化后旧令牌不得继续使用。
    if token.resource_url.as_deref() != current_url.as_deref() {
        let _ = remove_mcp_token(app, &reference);
        let _ = set_mcp_auth_status(server_id, "unauthenticated", None);
        return Err("MCP端点已变化，旧令牌已失效，请重新授权".into());
    }
    if token.expires_at.map(|v| v <= now_ms().saturating_add(60_000)).unwrap_or(false) {
        let refresh = match token.refresh_token.clone() { Some(value) => value, None => { let _ = set_mcp_auth_status(server_id, "expired", Some(&reference)); return Err("MCP访问令牌已过期且没有刷新令牌".into()); } };
        let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", token.client_id.as_str())];
        if let Some(secret) = token.client_secret.as_deref() { form.push(("client_secret", secret)); }
        let response = match ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build().post(&token.token_endpoint).send_form(&form) {
            Ok(response) => match response.into_json::<Value>() { Ok(value) => value, Err(_) => { let _ = set_mcp_auth_status(server_id, "expired", Some(&reference)); return Err("MCP刷新响应无效".into()); } },
            Err(_) => { let _ = set_mcp_auth_status(server_id, "expired", Some(&reference)); return Err("MCP令牌刷新失败".into()); }
        };
        let access = match response.get("access_token").and_then(|v| v.as_str()) { Some(value) => value, None => { let _ = set_mcp_auth_status(server_id, "expired", Some(&reference)); return Err("MCP刷新响应缺少access_token".into()); } };
        // 网络往返期间可能已撤权或改端点：复核后再写回，避免复活旧授权。
        let still_valid: Option<(String, Option<String>)> = { let guard = db::conn()?; let conn = guard.as_ref().ok_or("db not initialized")?; conn.query_row("SELECT authStatus,authCredentialRef FROM mcp_server WHERE id=?1", [server_id], |r| Ok((r.get(0)?,r.get(1)?))).ok() };
        match still_valid {
            Some((status, reference_now)) if status == "authenticated" && reference_now.as_deref() == Some(reference.as_str()) => {}
            _ => return Err("MCP授权在刷新期间已变更，本次刷新结果已丢弃".into()),
        }
        token.access_token = access.to_string(); token.expires_at = response.get("expires_in").and_then(|v|v.as_i64()).map(|n| now_ms().saturating_add(n.saturating_mul(1000))); if response.get("refresh_token").is_some() { token.refresh_token = response.get("refresh_token").and_then(|v|v.as_str()).map(str::to_string); }
        save_mcp_token(app, &reference, &token)?;
    }
    Ok(token.access_token)
}


async fn send_msg(stdin: &mut tokio::process::ChildStdin, line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod oauth_tests {
    use super::*;

    #[test]
    #[ignore = "需要真实 MCP：MCP_TEST_URL / MCP_TEST_TOKEN 环境变量"]
    fn real_streamable_http_mcp_discovery() {
        let url = std::env::var("MCP_TEST_URL").expect("需要 MCP_TEST_URL");
        let token = std::env::var("MCP_TEST_TOKEN").expect("需要 MCP_TEST_TOKEN");
        let allow_insecure_local_tls = std::env::var("MCP_TEST_ALLOW_INSECURE_LOCAL_TLS").map(|v| v == "1").unwrap_or(false);
        let tools = mcp_http_discover(&url, Some(&token), allow_insecure_local_tls).expect("真实 MCP 工具发现应成功");
        assert!(!tools.is_empty(), "真实 MCP 应返回至少一个工具");
        println!("真实 MCP 工具数={} 首个={}", tools.len(), tools[0].name);
    }

    #[test]
    fn http_payload_parses_sse_and_plain_json() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"a\"}]}}\n\n";
        assert_eq!(mcp_http_payload(sse).unwrap()["result"]["tools"][0]["name"], "a");
        assert_eq!(mcp_http_payload("{\"result\":{\"tools\":[]}}").unwrap()["result"]["tools"], serde_json::json!([]));
        assert!(mcp_http_payload("").is_err());
    }

    #[test]
    fn callback_query_rejects_invalid_percent_encoding() {
        // 非法或截断的百分号编码不得触发切片 panic，也不得被当作有效 state。
        assert_eq!(query_value("state=%", "state"), None);
        assert_eq!(query_value("state=%E2%82", "state"), Some(String::from_utf8_lossy(&[0xE2, 0x82]).into_owned()));
        assert_eq!(query_value("state=%ZZ", "state"), None);
        assert_eq!(query_value("state=a&state=b", "state"), Some("a".into()));
    }

    #[test]
    fn loopback_and_url_policy_rejects_lookalike_hosts() {
        assert!(is_loopback_url("http://127.0.0.1:27124/mcp"));
        assert!(is_loopback_url("https://localhost:27124/mcp"));
        assert!(is_loopback_url("https://[::1]:27124/mcp"));
        assert!(!is_loopback_url("http://localhost.attacker.example/mcp"));
        assert!(!is_loopback_url("https://127.0.0.1.attacker.example/mcp"));
        assert!(!is_loopback_url("https://10.0.0.5/mcp"));
        assert!(is_allowed_mcp_http_url("https://mcp.example.com/mcp"));
        assert!(!is_allowed_mcp_http_url("http://mcp.example.com/mcp"));
        assert!(is_allowed_mcp_http_url("http://127.0.0.1:27124/mcp"));
    }

    #[test]
    fn pkce_challenge_matches_verifier() {
        use sha2::{Digest, Sha256};
        let (verifier, challenge) = pkce_pair();
        assert!(verifier.len() >= 43);
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
        assert!(!verifier.contains('='));
        assert!(!challenge.contains('='));
    }

    #[test]
    fn state_hash_is_stable_and_distinct() {
        assert_eq!(state_hash("abc"), state_hash("abc"));
        assert_ne!(state_hash("abc"), state_hash("abd"));
    }

    #[test]
    fn local_metadata_and_registration_flow_uses_declared_endpoints() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut stream_buffer = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096]; let read = stream.read(&mut chunk).unwrap();
                    if read == 0 { break; }
                    stream_buffer.extend_from_slice(&chunk[..read]);
                    if let Some(header_end) = stream_buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&stream_buffer[..header_end]);
                        let content_length = headers.lines().find_map(|line| line.strip_prefix("Content-Length:").and_then(|value| value.trim().parse::<usize>().ok())).unwrap_or(0);
                        if stream_buffer.len() >= header_end + 4 + content_length { break; }
                    }
                }
                let request = String::from_utf8_lossy(&stream_buffer);
                let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
                let body = if path == "/mcp/.well-known/oauth-protected-resource" {
                    format!(r#"{{"authorization_servers":["http://127.0.0.1:{port}/issuer"]}}"#)
                } else if path == "/issuer/.well-known/oauth-authorization-server" {
                    format!(r#"{{"authorization_endpoint":"http://127.0.0.1:{port}/authorize","token_endpoint":"http://127.0.0.1:{port}/token","registration_endpoint":"http://127.0.0.1:{port}/register"}}"#)
                } else if path == "/register" {
                    r#"{"client_id":"local-test-client"}"#.to_string()
                } else {
                    panic!("unexpected fake OAuth path: {path}");
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let resource = format!("http://127.0.0.1:{port}/mcp");
        let protected = discover_oauth_metadata(&resource).unwrap();
        let metadata = authorization_metadata(&resource, &protected).unwrap();
        let redirect = format!("http://127.0.0.1:{port}/callback");
        let (client_id, client_secret) = register_oauth_client(&metadata, &redirect).unwrap();
        assert_eq!(client_id, "local-test-client");
        assert_eq!(client_secret, None);
        handle.join().unwrap();
    }
}
