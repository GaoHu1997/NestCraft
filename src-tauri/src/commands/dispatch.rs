//! 派发时把「供应商配置 + 能力（Skill/MCP）+ 思考档位」真正交给 CLI 子进程。
//!
//! 设计见 LLD-FEAT-002 §3.1.1。以下每条都经实机验证或对照已验证实现：
//! - claude 忽略进程环境里的 ANTHROPIC_BASE_URL，必须用 `--settings` 的 env 段；
//! - MCP 用 `--strict-mcp-config --mcp-config <file>` + `--allowedTools mcp__<name>`，
//!   非严格模式下 CLI 会连同用户全局 MCP 一起加载；
//! - Skill 用 `--add-dir` 让 CLI 发现 skills 目录；
//! - codex 用 `-c model_providers.*` / `-c mcp_servers.*` 单条 TOML 内联表覆盖，
//!   并 `--ignore-user-config` 防用户配置抢占；MCP 需预放行 approval 模式；
//! - 密钥只进子进程环境或 0600 临时文件，用后即删，绝不进 argv 与日志。

use crate::db;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 思考档位 → claude thinking token 预算（headless 只认这个环境变量）。
fn claude_thinking_budget(effort: &str) -> Option<u32> {
    match effort {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" => Some(16384),
        "xhigh" | "max" => Some(32768),
        _ => None,
    }
}

pub struct DispatchConfig {
    /// 子进程环境变量（含密钥；不得写入日志）
    pub env: BTreeMap<String, String>,
    /// 临时目录（用后删除）
    pub temp_dir: Option<PathBuf>,
    /// claude：`--settings` 指向的受管配置文件
    pub settings_file: Option<PathBuf>,
    /// 需清理的继承环境变量前缀
    pub strip_prefixes: Vec<String>,
    /// claude：MCP 配置与放行清单
    pub mcp_config_file: Option<PathBuf>,
    pub mcp_allowed_tools: Vec<String>,
    /// claude：skills 等附加目录（--add-dir）
    pub add_dirs: Vec<PathBuf>,
    /// codex：额外 -c 覆盖
    pub codex_overrides: Vec<String>,
    /// codex：是否忽略用户配置
    pub ignore_user_config: bool,
    /// 实际使用的供应商/模型信息（不含密钥）
    pub display: ProviderDisplay,
}

impl Drop for DispatchConfig {
    fn drop(&mut self) { cleanup(self); }
}

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDisplay {
    pub provider_name: String,
    pub protocol: String,
    pub base_url_host: String,
    pub model_id: String,
}

fn masked_host(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url).to_string()
}

fn read_secret(app: &tauri::AppHandle, key_id: &str) -> Option<String> {
    use tauri::Manager;
    let path = app.path().app_data_dir().ok()?.join("secrets.json");
    let text = std::fs::read_to_string(path).ok()?;
    let map: BTreeMap<String, String> = serde_json::from_str(&text).ok()?;
    map.get(key_id).cloned().filter(|s| !s.is_empty())
}

fn make_temp_dir(tag: &str) -> Result<PathBuf, String> {
    let base = std::env::temp_dir().join(format!(
        "agent-workbench-{}-{}",
        tag,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&base).map_err(|e| format!("创建临时目录失败：{}", e))?;
    Ok(base)
}

fn write_private(path: &std::path::Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn toml_str(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

fn toml_key(v: &str) -> String {
    if v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        v.to_string()
    } else {
        toml_str(v)
    }
}

struct McpRow {
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

fn enabled_mcp_servers() -> Result<Vec<McpRow>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT name, transport, command, argsJson, envJson FROM mcp_server WHERE enabled=1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|r| r.ok())
        .map(|(name, transport, command, args_json, env_json)| McpRow {
            name,
            transport,
            command,
            args: args_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default(),
            env: env_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default(),
        })
        .collect())
}

/// 解析会话所需的派发配置。None = 无供应商且无能力需要注入。
pub fn resolve(
    app: &tauri::AppHandle,
    cli_id: &str,
    provider_id: Option<&str>,
    model_id: &str,
    effort: &str,
) -> Result<Option<DispatchConfig>, String> {
    let mcp_servers = enabled_mcp_servers()?;
    let has_provider = provider_id.map(|p| !p.is_empty()).unwrap_or(false);

    let mut cfg = DispatchConfig {
        env: BTreeMap::new(),
        temp_dir: None,
        settings_file: None,
        strip_prefixes: vec![],
        mcp_config_file: None,
        mcp_allowed_tools: vec![],
        add_dirs: vec![],
        codex_overrides: vec![],
        ignore_user_config: false,
        display: ProviderDisplay::default(),
    };

    if has_provider {
        let pid = provider_id.unwrap();
        let (name, protocol, disabled) = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            conn.query_row(
                "SELECT name, protocol, disabled FROM provider WHERE id=?1",
                [pid],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .map_err(|_| "会话绑定的供应商不存在（可能已被删除），请改选或修复设置".to_string())?
        };
        if disabled {
            return Err(format!("供应商「{}」已停用，请启用或改选", name));
        }

        let (base_url, key_ref) = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let base_url: Option<String> = conn
                .query_row(
                    "SELECT baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1 AND protocol=?2 ORDER BY createdAt LIMIT 1",
                    rusqlite::params![pid, protocol],
                    |r| r.get(0),
                )
                .ok();
            let key_ref: Option<String> = conn
                .query_row(
                    "SELECT secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt LIMIT 1",
                    [pid],
                    |r| r.get(0),
                )
                .ok();
            (base_url, key_ref)
        };
        let base_url = base_url
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| format!("供应商「{}」没有与协议 {} 匹配的启用端点", name, protocol))?;
        let secret = key_ref
            .as_deref()
            .and_then(|k| read_secret(app, k))
            .ok_or_else(|| format!("供应商「{}」没有可用密钥，请在设置中补充", name))?;

        match (cli_id, protocol.as_str()) {
            ("claude", "anthropic") => {}
            ("codex" | "grok", "openai") => {}
            ("claude", other) => {
                return Err(format!(
                    "CLI「claude」需要 Anthropic 兼容协议，当前供应商协议为 {}；请改选模型或供应商",
                    other
                ))
            }
            (c, other) => {
                return Err(format!(
                    "CLI「{}」需要 OpenAI 兼容协议，当前供应商协议为 {}；请改选模型或供应商",
                    c, other
                ))
            }
        }

        let base = base_url.trim_end_matches('/').to_string();
        match cli_id {
            "claude" => {
                // 实测：claude 不读进程环境的 ANTHROPIC_BASE_URL，须 --settings
                let dir = make_temp_dir("claude")?;
                cfg.temp_dir = Some(dir.clone());
                let mut env_block = serde_json::Map::new();
                env_block.insert("ANTHROPIC_BASE_URL".into(), serde_json::json!(base));
                env_block.insert("ANTHROPIC_AUTH_TOKEN".into(), serde_json::json!(secret.clone()));
                if !model_id.is_empty() {
                    env_block.insert("ANTHROPIC_MODEL".into(), serde_json::json!(model_id));
                }
                if let Some(budget) = claude_thinking_budget(effort) {
                    env_block.insert("MAX_THINKING_TOKENS".into(), serde_json::json!(budget.to_string()));
                }
                let sf = dir.join("settings.json");
                write_private(&sf, &serde_json::json!({ "env": env_block }).to_string())?;
                cfg.env.insert("ANTHROPIC_BASE_URL".into(), base.clone());
                cfg.env.insert("ANTHROPIC_AUTH_TOKEN".into(), secret.clone());
                cfg.env.insert("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().to_string());
                if let Some(budget) = claude_thinking_budget(effort) {
                    cfg.env.insert("MAX_THINKING_TOKENS".into(), budget.to_string());
                }
                cfg.strip_prefixes.extend(["ANTHROPIC_".into(), "CLAUDE_CODE_USE_".into()]);
                cfg.settings_file = Some(sf);
                cfg.temp_dir = Some(dir);
            }
            "codex" => {
                // codex：-c 覆盖 pin 住 provider/模型/端点；--ignore-user-config 防用户配置抢占
                let key_env = "AGENT_WORKBENCH_PROVIDER_KEY";
                cfg.env.insert(key_env.into(), secret.clone());
                cfg.codex_overrides.extend([
                    format!("model={}", toml_str(model_id)),
                    "model_provider=\"agent_workbench\"".to_string(),
                    "model_providers.agent_workbench.name=\"agent-workbench\"".to_string(),
                    format!("model_providers.agent_workbench.base_url={}", toml_str(&base)),
                    format!("model_providers.agent_workbench.env_key={}", toml_str(key_env)),
                    // codex 0.166 起只支持 responses（chat 已被移除，实测报错）
                    "model_providers.agent_workbench.wire_api=\"responses\"".to_string(),
                ]);
                if !effort.is_empty() && effort != "off" {
                    cfg.codex_overrides.push(format!("model_reasoning_effort={}", toml_str(effort)));
                }
                #[cfg(windows)]
                cfg.codex_overrides.push("windows.sandbox=\"elevated\"".to_string());
                // codex 自己拼接 /responses，base_url 不应带 /v1（实测 404）
                cfg.env.insert("OPENAI_BASE_URL".into(), base.clone());
                cfg.env.insert("OPENAI_API_KEY".into(), secret.clone());
                cfg.strip_prefixes.push("OPENAI_".into());
                cfg.ignore_user_config = true;
            }
            "grok" => {
                cfg.env.insert("OPENAI_BASE_URL".into(), format!("{}/v1", base));
                cfg.env.insert("OPENAI_API_KEY".into(), secret.clone());
                cfg.strip_prefixes.push("OPENAI_".into());
            }
            other => return Err(format!("未知 CLI：{}", other)),
        }

        cfg.display = ProviderDisplay {
            provider_name: name,
            protocol,
            base_url_host: masked_host(&base_url),
            model_id: model_id.to_string(),
        };
    }

    apply_capabilities(app, cli_id, &mcp_servers, &mut cfg)?;
    if !has_provider && cfg.mcp_config_file.is_none() && cfg.add_dirs.is_empty() && !cfg.ignore_user_config {
        return Ok(None);
    }
    Ok(Some(cfg))
}

/// 注入 MCP 与 Skill（能力配置必须真正到达 CLI）。
fn apply_capabilities(
    app: &tauri::AppHandle,
    cli_id: &str,
    servers: &[McpRow],
    cfg: &mut DispatchConfig,
) -> Result<(), String> {
    if let Some(dir) = skill_dir(app) {
        cfg.add_dirs.push(dir);
    }

    match cli_id {
        "claude" => {
            let stdio: Vec<&McpRow> = servers.iter().filter(|s| s.transport == "stdio").collect();
            if stdio.is_empty() {
                return Ok(());
            }
            let mut map = serde_json::Map::new();
            for s in stdio.iter() {
                let mut entry = serde_json::Map::new();
                entry.insert(
                    "command".into(),
                    serde_json::json!(s.command.clone().unwrap_or_default()),
                );
                if !s.args.is_empty() {
                    // Windows 路径统一正斜杠：JSON 里的反斜杠会让 CLI 报 "不是有效 JSON"
                    let safe_args: Vec<String> = s
                        .args
                        .iter()
                        .map(|a| {
                            let looks_like_path = a.len() > 2 && a.chars().nth(1) == Some(':');
                            if looks_like_path && a.contains('\\') {
                                a.replace('\\', "/")
                            } else {
                                a.clone()
                            }
                        })
                        .collect();
                    entry.insert("args".into(), serde_json::json!(safe_args));
                }
                if !s.env.is_empty() {
                    entry.insert("env".into(), serde_json::json!(s.env));
                }
                map.insert(s.name.clone(), serde_json::Value::Object(entry));
            }
            let dir = make_temp_dir("mcp")?;
            let file = dir.join("mcp-config.json");
            cfg.mcp_config_file = Some(file.clone());
            write_private(&file, &serde_json::json!({ "mcpServers": map }).to_string())?;
            cfg.mcp_config_file = Some(file);
            cfg.mcp_allowed_tools = stdio.iter().map(|s| format!("mcp__{}", s.name)).collect();
            if cfg.temp_dir.is_none() {
                cfg.temp_dir = Some(dir);
            }
        }
        "codex" => {
            for s in servers.iter() {
                if s.transport != "stdio" || s.command.as_deref().unwrap_or("").trim().is_empty() {
                    continue; // http 无 command，codex 无法 spawn
                }
                let mut parts = vec![format!(
                    "command={}",
                    toml_str(s.command.as_deref().unwrap_or(""))
                )];
                if !s.args.is_empty() {
                    parts.push(format!(
                        "args=[{}]",
                        s.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(", ")
                    ));
                }
                parts.push("default_tools_approval_mode=\"approve\"".into());
                cfg.codex_overrides.push(format!(
                    "mcp_servers.{}={{ {} }}",
                    toml_key(&s.name),
                    parts.join(", ")
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

/// 清理临时文件/目录（失败静默）。
pub fn cleanup(cfg: &DispatchConfig) {
    if let Some(file) = &cfg.mcp_config_file {
        let _ = std::fs::remove_file(file);
        if let Some(parent) = file.parent() {
            let owned = parent.parent() == Some(std::env::temp_dir().as_path())
                && parent.file_name().map(|name| name.to_string_lossy().starts_with("agent-workbench-mcp-")).unwrap_or(false);
            if owned { let _ = std::fs::remove_dir_all(parent); }
        }
    }
    if let Some(directory) = &cfg.temp_dir {
        let _ = std::fs::remove_dir_all(directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_configuration_cleans_both_owned_temporary_directories() {
        let provider = make_temp_dir("claude").unwrap();
        let mcp = make_temp_dir("mcp").unwrap();
        let file = mcp.join("mcp-config.json");
        std::fs::write(&file, "test-only").unwrap();
        let config = DispatchConfig {
            env: BTreeMap::new(), temp_dir: Some(provider.clone()), settings_file: None,
            strip_prefixes: vec![], mcp_config_file: Some(file), mcp_allowed_tools: vec![],
            add_dirs: vec![], codex_overrides: vec![], ignore_user_config: false,
            display: ProviderDisplay::default(),
        };
        drop(config);
        assert!(!provider.exists());
        assert!(!mcp.exists());
    }
}

/// 受管 Skill 目录。
pub fn skill_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?.join("skills");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}
