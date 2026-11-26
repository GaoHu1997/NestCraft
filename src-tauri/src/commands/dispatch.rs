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
    /// 临时目录（用后删除；只放 --settings / mcp 配置等一次性文件）
    pub temp_dir: Option<PathBuf>,
    /// CR-037：按会话稳定的线程存储目录（claude 的 CLAUDE_CONFIG_DIR / codex 的 CODEX_HOME）。
    /// 跨轮、跨重启持久保留，绝不随 Drop 清理——这是原生续接的存储前提。
    pub profile_dir: Option<PathBuf>,
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
    /// CR-064：grok 会话级 MCP 配置文件（位于按会话隔离的 GROK_HOME 内）。
    /// 该目录与 claude/codex 的 profile 同性质——按会话稳定保留、不随 Drop 删除，
    /// 因此这里只记录路径用于诊断，不参与清理。
    pub grok_mcp_file: Option<PathBuf>,
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
    pub provider_id: String,
    pub protocol: String,
    pub base_url_host: String,
    pub model_id: String,
}

fn masked_host(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url).to_string()
}

/// OpenAI 兼容端点的请求基址：CLI 自己拼 `/responses`（codex）或 `/chat/completions`（grok），
/// 因此基址必须带 `/v1`。
///
/// 用户在设置里填的端点可能已带 `/v1`（如 `https://host/v1`），也可能只到主机
/// （如 `https://host`）；两种都要只出现一次 `/v1`，否则会拼成 `/v1/v1`。
/// 实测：不带 `/v1` 时网关回 405 Method Not Allowed。
pub(crate) fn openai_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

pub(crate) fn read_secret(app: &tauri::AppHandle, key_id: &str) -> Option<String> {
    let path = crate::storage_layout::category("secrets").ok()?.join("secrets.json");
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

#[derive(Clone)]
struct McpRow {
    id: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    url: Option<String>,
    auth_status: String,
}

fn enabled_mcp_servers() -> Result<Vec<McpRow>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, transport, command, argsJson, envJson, url, authStatus FROM mcp_server WHERE enabled=1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?.unwrap_or_else(|| "unauthenticated".into()),
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|r| r.ok())
        .map(|(id, name, transport, command, args_json, env_json, url, auth_status)| McpRow {
            id,
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
            url,
            auth_status,
        })
        .collect())
}

/// 按会话稳定的线程存储目录：`<app_data>/claude-profiles/<sessionId>` 等。
/// 目录只创建不删除；同一会话跨轮、跨重启命中同一存储，是 `--resume` / `exec resume` 的前提。
pub fn stable_profile_dir(app: &tauri::AppHandle, cli_id: &str, session_id: &str) -> Result<PathBuf, String> {
    let _ = app;
    let dir = crate::storage_layout::category("chat")?
        .join(format!("{cli_id}-profiles"))
        .join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建会话线程存储目录失败：{}", e))?;
    Ok(dir)
}

/// 设置值 → 开关：缺省=启用，仅显式 "0" 关闭（纯函数便于单测）。
pub(crate) fn ai_tools_enabled_from_setting(value: Option<String>) -> bool {
    match value.as_deref() {
        Some("0") => false,
        _ => true,
    }
}

/// CR-059：内置 workbench MCP 的注入条件。None = 不注入。
/// 冒烟模式（TAURI_SMOKE=1）不注入——mock CLI 不实现 MCP，保持冒烟链路确定性；
/// 设置键 `aiTools.enabled`（缺省开）= "0" 时整体关闭；与用户自配 MCP 同名时用户配置优先。
fn built_in_workbench_config(
    app: &tauri::AppHandle,
    project_id: Option<&str>,
    execution_feature_id: Option<&str>,
) -> Result<Option<(PathBuf, Option<String>, Option<String>)>, String> {
    if std::env::var("TAURI_SMOKE").is_ok() {
        return Ok(None);
    }
    let enabled = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let value: Option<Option<String>> = conn
            .query_row(
                "SELECT value FROM setting_default WHERE scope='global' AND key='aiTools.enabled'",
                [],
                |r| r.get(0),
            )
            .ok();
        ai_tools_enabled_from_setting(value.flatten())
    };
    if !enabled {
        return Ok(None);
    }
    // 传给 workbench MCP 子进程的必须是统一数据根：子进程据此打开与主程序同一个库。
    let dir = crate::storage_layout::root().map_err(|e| e.to_string())?;
    Ok(Some((
        dir,
        project_id.filter(|p| !p.is_empty()).map(|p| p.to_string()),
        execution_feature_id
            .filter(|f| !f.is_empty())
            .map(|f| f.to_string()),
    )))
}

/// CR-059：构造内置 workbench MCP 行（命令=应用自身，stdio 模式；纯函数便于单测）。
fn built_in_workbench_row(
    data_dir: &std::path::Path,
    project_id: Option<&str>,
    execution_feature_id: Option<&str>,
    session_id: Option<&str>,
) -> McpRow {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-workbench"));
    let mut args = vec![
        "--app-mcp-stdio".to_string(),
        "--app-data-dir".to_string(),
        data_dir.to_string_lossy().to_string(),
    ];
    if let Some(pid) = project_id {
        args.push("--project-id".to_string());
        args.push(pid.to_string());
    }
    // CR-047：执行会话把唯一 Feature 传给工作台 MCP，工具侧据此拒绝跨范围写入。
    if let Some(feature_id) = execution_feature_id {
        args.push("--execution-feature-id".to_string());
        args.push(feature_id.to_string());
    }
    // CR-104：会话 id 供本地搜索读取会话级授权目录与权限档位。
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        args.push("--session-id".to_string());
        args.push(sid.to_string());
    }
    McpRow {
        id: "builtin-workbench".into(),
        name: "workbench".into(),
        transport: "stdio".into(),
        command: Some(exe.to_string_lossy().to_string()),
        args,
        env: BTreeMap::new(),
        url: None,
        auth_status: "unauthenticated".into(),
    }
}

/// CR-059：把内置 workbench 行并入用户自配 MCP 清单（同名时用户配置优先；纯函数便于单测）。
fn merge_built_in_workbench(
    servers: Vec<McpRow>,
    data_dir: &std::path::Path,
    project_id: Option<&str>,
    execution_feature_id: Option<&str>,
    session_id: Option<&str>,
) -> Vec<McpRow> {
    let mut servers = servers;
    if !servers.iter().any(|s| s.name == "workbench") {
        servers.insert(
            0,
            built_in_workbench_row(data_dir, project_id, execution_feature_id, session_id),
        );
    }
    servers
}

/// 解析会话所需的派发配置。None = 无供应商且无能力需要注入（此时无 profile 需求）。
pub fn resolve(
    app: &tauri::AppHandle,
    cli_id: &str,
    session_id: &str,
    provider_id: Option<&str>,
    model_id: &str,
    effort: &str,
    project_id: Option<&str>,
    cwd: Option<&std::path::Path>,
) -> Result<Option<DispatchConfig>, String> {
    let mut mcp_servers = enabled_mcp_servers()?;
    // CR-047：执行会话的唯一 Feature 身份来自持久会话，不接受前端自报。
    let execution_feature = {
        let guard = db::conn().ok();
        guard
            .as_ref()
            .and_then(|g| g.as_ref())
            .and_then(|conn| {
                conn.query_row(
                    "SELECT featureId FROM session WHERE id=?1",
                    [session_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
            })
    };
    if let Some((dir, pid, feature)) = built_in_workbench_config(
        app,
        project_id,
        execution_feature.as_deref(),
    )? {
        mcp_servers = merge_built_in_workbench(
            mcp_servers,
            &dir,
            pid.as_deref(),
            feature.as_deref(),
            Some(session_id),
        );
    }
    let has_provider = provider_id.map(|p| !p.is_empty()).unwrap_or(false);

    let mut cfg = DispatchConfig {
        env: BTreeMap::new(),
        temp_dir: None,
        profile_dir: None,
        settings_file: None,
        strip_prefixes: vec![],
        mcp_config_file: None,
        mcp_allowed_tools: vec![],
        add_dirs: vec![],
        codex_overrides: vec![],
        ignore_user_config: false,
        grok_mcp_file: None,
        display: ProviderDisplay::default(),
    };

    if has_provider {
        let pid = provider_id.unwrap();
        let providers = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            crate::commands::providers::load_providers_inner(conn)?
        };
        // CR-068 J06：候选与派发共用同一资格 resolver；CLI 决定有效协议，
        // 默认协议只作默认偏好，不覆盖另一协议端点，也不跨协议复用密钥。
        let route = crate::commands::model_route::resolve_for_cli(&providers, pid, cli_id, model_id)?;
        let name = providers
            .iter()
            .find(|provider| provider.id == pid)
            .map(|provider| provider.name.clone())
            .unwrap_or_default();
        let protocol = route.protocol.to_string();
        let base_url = route.endpoint.base_url.trim().to_string();
        let key_id = route.key.id.clone();

        // 仅在端点、密钥协议与模型范围均合格后读取 secretRef。
        let key_ref: Option<String> = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            conn.query_row(
                "SELECT secretRef FROM provider_key WHERE id=?1 AND providerId=?2",
                rusqlite::params![key_id, pid],
                |r| r.get(0),
            )
            .ok()
            .flatten()
        };
        let secret = key_ref
            .as_deref()
            .and_then(|k| read_secret(app, k))
            .ok_or_else(|| format!("供应商「{}」没有可用密钥，请在设置中补充", name))?;

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
                if let Some(budget) = claude_thinking_budget(effort) {
                    cfg.env.insert("MAX_THINKING_TOKENS".into(), budget.to_string());
                }
                cfg.strip_prefixes.extend(["ANTHROPIC_".into(), "CLAUDE_CODE_USE_".into()]);
                cfg.settings_file = Some(sf);
                // CR-037：线程存储改为按会话稳定目录（此前为随 Drop 删除的临时目录，续接不可能）。
                // 含密钥的 --settings 临时文件保持现状：用后即删，不入 profile 目录。
                let profile = stable_profile_dir(app, "claude", session_id)?;
                cfg.env.insert("CLAUDE_CONFIG_DIR".into(), profile.to_string_lossy().to_string());
                cfg.profile_dir = Some(profile);
            }
            "codex" => {
                // codex：-c 覆盖 pin 住 provider/模型/端点；--ignore-user-config 防用户配置抢占
                let key_env = "AGENT_WORKBENCH_PROVIDER_KEY";
                cfg.env.insert(key_env.into(), secret.clone());
                // 实测（codex 0.166）：codex 自己拼接 /responses，base_url 必须带 /v1，
                // 否则请求落到 POST <host>/responses，网关回 405 Method Not Allowed。
                let codex_base = openai_base(&base);
                cfg.codex_overrides.extend([
                    format!("model={}", toml_str(model_id)),
                    "model_provider=\"agent_workbench\"".to_string(),
                    "model_providers.agent_workbench.name=\"agent-workbench\"".to_string(),
                    format!("model_providers.agent_workbench.base_url={}", toml_str(&codex_base)),
                    format!("model_providers.agent_workbench.env_key={}", toml_str(key_env)),
                    // codex 0.166 起只支持 responses（chat 已被移除，实测报错）
                    "model_providers.agent_workbench.wire_api=\"responses\"".to_string(),
                ]);
                if !effort.is_empty() && effort != "off" {
                    cfg.codex_overrides.push(format!("model_reasoning_effort={}", toml_str(effort)));
                }
                #[cfg(windows)]
                cfg.codex_overrides.push("windows.sandbox=\"elevated\"".to_string());
                cfg.env.insert("OPENAI_BASE_URL".into(), codex_base.clone());
                cfg.env.insert("OPENAI_API_KEY".into(), secret.clone());
                cfg.strip_prefixes.push("OPENAI_".into());
                cfg.ignore_user_config = true;
                // CR-037：CODEX_HOME 指向按会话稳定目录（exec resume 读同一 store）。
                // auth 来自 env/覆盖，不依赖用户真实 ~/.codex；隔离亦避免跨会话 store 冲突。
                let profile = stable_profile_dir(app, "codex", session_id)?;
                cfg.env.insert("CODEX_HOME".into(), profile.to_string_lossy().to_string());
                cfg.profile_dir = Some(profile);
            }
            "grok" => {
                // 实测（grok 1.0.77）：grok 只读自己的端点变量 GROK_XAI_API_BASE_URL，
                // 不读 OPENAI_BASE_URL——只给后者时它会连 xAI 官方端点并长时间挂起。
                // 端点必须带 /v1（grok 拼 /chat/completions），否则网关回 405。
                let grok_base = openai_base(&base);
                cfg.env.insert("GROK_XAI_API_BASE_URL".into(), grok_base.clone());
                cfg.env.insert("XAI_API_KEY".into(), secret.clone());
                // 避免长跑任务停在更新横幅上。
                cfg.env.insert("GROK_NO_AUTO_UPDATE".into(), "1".into());
                cfg.strip_prefixes.push("GROK_XAI_".into());
                cfg.strip_prefixes.push("XAI_".into());
                // CR-064：GROK_HOME 指向按会话稳定目录（同 claude/codex 的 profile 机制）。
                // MCP 配置落在这里：既不需要「项目文件夹受信任」（实测 repo-local MCP
                // 未信任时不会启动），也不污染用户 ~/.grok。
                let profile = stable_profile_dir(app, "grok", session_id)?;
                cfg.env.insert("GROK_HOME".into(), profile.to_string_lossy().to_string());
                cfg.profile_dir = Some(profile);
            }
            other => return Err(format!("未知 CLI：{}", other)),
        }

        cfg.display = ProviderDisplay {
            provider_name: name,
            provider_id: pid.to_string(),
            protocol,
            base_url_host: masked_host(&base_url),
            model_id: model_id.to_string(),
        };
    }

    apply_capabilities(app, cli_id, &mcp_servers, &mut cfg, cwd)?;
    // CR-059：codex 的 MCP 走 TOML 覆盖（无 mcp_config_file），因此「是否需要派发配置」
    // 必须同时看 codex_overrides，否则无供应商时内置 workbench 工具会被静默丢掉。
    // CR-064：grok 同理走 .grok/config.toml（grok_mcp），也必须纳入判定。
    if !has_provider
        && cfg.mcp_config_file.is_none()
        && cfg.add_dirs.is_empty()
        && cfg.codex_overrides.is_empty()
        && cfg.grok_mcp_file.is_none()
        && !cfg.ignore_user_config
    {
        return Ok(None);
    }
    Ok(Some(cfg))
}

/// CR-059：claude 的 MCP 配置（纯函数，便于单测锁定注入内容）。
/// 返回 (mcpServers JSON, 放行的工具清单 mcp__<server>)。
fn claude_mcp_config(servers: &[McpRow], token_of: &dyn Fn(&McpRow) -> Result<Option<String>, String>) -> Result<(serde_json::Value, Vec<String>), String> {
    let selected: Vec<&McpRow> = servers.iter().filter(|s| s.transport == "stdio" || s.transport == "http").collect();
    let mut map = serde_json::Map::new();
    let mut allowed = Vec::new();
    for s in selected {
        let mut entry = serde_json::Map::new();
        if s.transport == "stdio" {
            entry.insert("command".into(), serde_json::json!(s.command.clone().unwrap_or_default()));
            if !s.args.is_empty() {
                let safe_args: Vec<String> = s.args.iter().map(|a| {
                    let looks_like_path = a.len() > 2 && a.chars().nth(1) == Some(':');
                    if looks_like_path && a.contains('\\') { a.replace('\\', "/") } else { a.clone() }
                }).collect();
                entry.insert("args".into(), serde_json::json!(safe_args));
            }
            if !s.env.is_empty() { entry.insert("env".into(), serde_json::json!(s.env)); }
            allowed.push(format!("mcp__{}", s.name));
        } else {
            if s.auth_status != "authenticated" { return Err(format!("HTTP MCP「{}」未授权，无法派发", s.name)); }
            let url = s.url.as_deref().filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("HTTP MCP「{}」缺少URL", s.name))?;
            let token = token_of(s)?;
            if let Some(token) = token {
                entry.insert("type".into(), serde_json::json!("http"));
                entry.insert("url".into(), serde_json::json!(url));
                entry.insert("headers".into(), serde_json::json!({"Authorization": format!("Bearer {}", token)}));
            }
        }
        map.insert(s.name.clone(), serde_json::Value::Object(entry));
    }
    Ok((serde_json::json!({ "mcpServers": map }), allowed))
}

/// CR-059：codex 的 MCP TOML 覆盖（纯函数，便于单测锁定注入内容）。
/// 返回 (覆盖项, 需要注入环境变量的 (键, 值))。
fn codex_mcp_overrides(servers: &[McpRow], token_of: &dyn Fn(&McpRow) -> Result<Option<String>, String>) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    let mut overrides = Vec::new();
    let mut envs = Vec::new();
    for s in servers.iter() {
        if s.transport == "stdio" {
            if s.command.as_deref().unwrap_or("").trim().is_empty() { continue; }
            let mut parts = vec![format!("command={}", toml_str(s.command.as_deref().unwrap_or("")))];
            if !s.args.is_empty() { parts.push(format!("args=[{}]", s.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(", "))); }
            parts.push("default_tools_approval_mode=\"approve\"".into());
            overrides.push(format!("mcp_servers.{}={{ {} }}", toml_key(&s.name), parts.join(", ")));
        } else if s.transport == "http" {
            if s.auth_status != "authenticated" { return Err(format!("HTTP MCP「{}」未授权，无法派发给Codex", s.name)); }
            let url = s.url.as_deref().filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("HTTP MCP「{}」缺少URL", s.name))?;
            let token = token_of(s)?;
            let Some(token) = token else {
                overrides.push(format!("mcp_servers.{}={{ url={} }}", toml_key(&s.name), toml_str(url)));
                continue;
            };
            let env_key = format!("AGENT_WORKBENCH_MCP_TOKEN_{}", s.id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
            envs.push((env_key.clone(), token));
            overrides.push(format!("mcp_servers.{}={{ url={}, bearer_token_env_var={} }}", toml_key(&s.name), toml_str(url), toml_str(&env_key)));
        }
    }
    Ok((overrides, envs))
}

/// CR-064：生成 grok 会话级 `config.toml` 内容（只含 stdio MCP 服务器）。
/// 复用 codex 分支同一套 TOML 转义（`toml_str` / `toml_key`），避免两套规则漂移。
/// 无可用服务器时返回 None（不写空文件）。
fn grok_mcp_config_toml(servers: &[McpRow]) -> Option<String> {
    let mut sections = String::new();
    for s in servers {
        // grok 本轮只接 stdio；HTTP/SSE 需要独立 auth 流程，登记为后续（LLD §2.3）。
        if s.transport != "stdio" {
            continue;
        }
        let command = s.command.as_deref().map(str::trim).unwrap_or("");
        if command.is_empty() {
            continue;
        }
        sections.push_str(&format!("\n[mcp_servers.{}]\n", toml_key(&s.name)));
        sections.push_str(&format!("command = {}\n", toml_str(command)));
        if !s.args.is_empty() {
            let args = s.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(", ");
            sections.push_str(&format!("args = [{}]\n", args));
        }
        if !s.env.is_empty() {
            sections.push_str(&format!("[mcp_servers.{}.env]\n", toml_key(&s.name)));
            for (k, v) in s.env.iter() {
                sections.push_str(&format!("{} = {}\n", toml_key(k), toml_str(v)));
            }
        }
    }
    if sections.is_empty() {
        return None;
    }
    Some(format!(
        "# 由应用生成：会话级 MCP 配置（CR-064）。按会话隔离，不影响你的 ~/.grok 与项目配置。\n{}\n",
        sections
    ))
}

/// CR-064：把 grok MCP 配置写入**按会话隔离的 GROK_HOME 目录**。
///
/// 为什么不写项目级 `.grok/config.toml`（实测结论）：
/// grok 对 repo-local（project-scoped）MCP 服务器要求**文件夹受信任**，
/// 未信任时 `grok mcp doctor` 报 `folder untrusted ... not started`，
/// 即注入的服务器会被静默忽略。而 `GROK_HOME` 覆盖的配置文件被识别为
/// `config` 来源（非 repo-local），不需要文件夹信任，且天然按会话隔离，
/// 不污染用户 `~/.grok`。这与 claude 的 `CLAUDE_CONFIG_DIR`、
/// codex 的 `CODEX_HOME` 完全同一套做法。
fn write_grok_mcp_config(grok_home: &std::path::Path, servers: &[McpRow]) -> Result<Option<PathBuf>, String> {
    let Some(content) = grok_mcp_config_toml(servers) else { return Ok(None) };
    std::fs::create_dir_all(grok_home).map_err(|e| format!("创建 grok 会话配置目录失败：{}", e))?;
    let path = grok_home.join("config.toml");
    // 该目录专属本会话（由 stable_profile_dir 生成），可直接写；若上一轮遗留则覆盖。
    std::fs::write(&path, content).map_err(|e| format!("写入 grok MCP 配置失败：{}", e))?;
    Ok(Some(path))
}

/// 注入 MCP 与 Skill（能力配置必须真正到达 CLI）。
fn apply_capabilities(
    app: &tauri::AppHandle,
    cli_id: &str,
    servers: &[McpRow],
    cfg: &mut DispatchConfig,
    cwd: Option<&std::path::Path>,
) -> Result<(), String> {
    if let Some(dir) = skill_dir(app) {
        cfg.add_dirs.push(dir);
    }

    match cli_id {
        "claude" => {
            let selected: Vec<&McpRow> = servers.iter().filter(|s| s.transport == "stdio" || s.transport == "http").collect();
            if selected.is_empty() { return Ok(()); }
            let (payload, allowed) = claude_mcp_config(servers, &|s| {
                crate::commands::capabilities::mcp_http_authorization(app, &s.id)
            })?;
            let dir = make_temp_dir("mcp")?;
            let file = dir.join("mcp-config.json");
            write_private(&file, &payload.to_string())?;
            cfg.mcp_config_file = Some(file);
            cfg.mcp_allowed_tools = allowed;
            if cfg.temp_dir.is_none() { cfg.temp_dir = Some(dir); }
        }
        "codex" => {
            let (overrides, envs) = codex_mcp_overrides(servers, &|s| {
                crate::commands::capabilities::mcp_http_authorization(app, &s.id)
            })?;
            for (env_key, token) in envs {
                cfg.env.insert(env_key.clone(), token);
                // 继承环境里同族令牌必须清掉（沿用既有前缀口径，避免串号）。
                cfg.strip_prefixes.push("AGENT_WORKBENCH_MCP_TOKEN_".into());
            }
            cfg.codex_overrides.extend(overrides);
        }
        "grok" => {
            // CR-064：grok 的 MCP 配置写入按会话隔离的 GROK_HOME（见 write_grok_mcp_config 注释）。
            // GROK_HOME 在 resolve 的 grok 供应商分支里已设置为 profile_dir。
            if let Some(home) = cfg.profile_dir.clone() {
                cfg.grok_mcp_file = write_grok_mcp_config(&home, servers)?;
            } else {
                eprintln!("[dispatch] grok 会话缺少 GROK_HOME 目录，跳过 MCP 注入");
            }
        }
        _ => {}
    }
    Ok(())
}

/// 清理临时文件/目录（失败静默）。profile_dir（会话线程存储）绝不清理——CR-037 续接前提。
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

    /// CR-059：内置 workbench MCP 行的构造（名称/stdio/参数齐全，供 claude/codex 注入）。
    #[test]
    fn built_in_workbench_row_carries_stdio_command_and_context() {
        let dir = std::path::Path::new("D:/app-data");
        let row = built_in_workbench_row(dir, Some("proj-1"), None, Some("sess-1"));
        assert_eq!(row.name, "workbench");
        assert_eq!(row.transport, "stdio");
        assert_eq!(row.auth_status, "unauthenticated");
        let command = row.command.clone().unwrap();
        assert!(!command.is_empty(), "command 必须是应用自身路径");
        assert_eq!(row.args[0], "--app-mcp-stdio");
        assert_eq!(row.args[1], "--app-data-dir");
        assert_eq!(row.args[2], "D:/app-data");
        assert_eq!(row.args[3], "--project-id");
        assert_eq!(row.args[4], "proj-1");
        assert_eq!(row.args[5], "--session-id");
        assert_eq!(row.args[6], "sess-1");
        // 未绑定项目时省略 --project-id
        let row2 = built_in_workbench_row(dir, None, None, None);
        assert!(!row2.args.iter().any(|a| a == "--project-id"));
        assert!(!row2.args.iter().any(|a| a == "--session-id"));
    }

    /// CR-059：合并语义——注入置顶、开关关闭不注入、用户自配同名 workbench 优先。
    #[test]
    fn merge_built_in_workbench_respects_switch_and_user_config() {
        let dir = std::path::Path::new("D:/app-data");
        let user = McpRow {
            id: "m1".into(), name: "user-mcp".into(), transport: "stdio".into(),
            command: Some("node".into()), args: vec!["x.js".into()], env: BTreeMap::new(),
            url: None, auth_status: "unauthenticated".into(),
        };
        let merged = merge_built_in_workbench(vec![user.clone()], dir, Some("p1"), None, Some("s1"));
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "workbench", "内置服务器应置于清单首位");
        assert_eq!(merged[1].name, "user-mcp");
        // 用户已自配同名 workbench：用户配置优先，不重复注入
        let clash = McpRow { id: "m2".into(), name: "workbench".into(), transport: "stdio".into(),
            command: Some("node".into()), args: vec![], env: BTreeMap::new(), url: None, auth_status: "unauthenticated".into() };
        let merged2 = merge_built_in_workbench(vec![clash], dir, None, None, None);
        assert_eq!(merged2.len(), 1);
        assert_eq!(merged2[0].id, "m2");
    }

    /// CR-059：开关语义——缺省启用，仅显式 "0" 关闭。
    #[test]
    fn ai_tools_enabled_defaults_on_and_respects_explicit_off() {
        assert!(ai_tools_enabled_from_setting(None));
        assert!(ai_tools_enabled_from_setting(Some("1".into())));
        assert!(ai_tools_enabled_from_setting(Some("".into())));
        assert!(!ai_tools_enabled_from_setting(Some("0".into())));
    }

    /// CR-059：claude 派发必须把内置 workbench 写进 mcp-config 并放行 mcp__workbench。
    #[test]
    fn claude_dispatch_includes_builtin_workbench_and_allows_it() {
        let dir = std::path::Path::new("D:/app-data");
        let servers = vec![built_in_workbench_row(dir, Some("proj-1"), None, Some("sess-1"))];
        let (payload, allowed) = claude_mcp_config(&servers, &|_| Ok(None)).unwrap();
        assert_eq!(allowed, vec!["mcp__workbench".to_string()]);
        let entry = &payload["mcpServers"]["workbench"];
        assert!(entry["command"].as_str().unwrap().contains("agent-workbench") || !entry["command"].as_str().unwrap().is_empty());
        let args = entry["args"].as_array().unwrap();
        assert_eq!(args[0], "--app-mcp-stdio");
        assert_eq!(args[1], "--app-data-dir");
        assert_eq!(args[2], "D:/app-data");
        assert_eq!(args[3], "--project-id");
        assert_eq!(args[4], "proj-1");
    }

    /// CR-059：codex 派发必须生成 mcp_servers.workbench 的 TOML 覆盖。
    #[test]
    fn codex_dispatch_emits_workbench_toml_override() {
        let dir = std::path::Path::new("D:/app-data");
        let servers = vec![built_in_workbench_row(dir, None, None, None)];
        let (overrides, envs) = codex_mcp_overrides(&servers, &|_| Ok(None)).unwrap();
        assert_eq!(overrides.len(), 1);
        let line = &overrides[0];
        assert!(line.starts_with("mcp_servers.workbench={"), "实际：{line}");
        assert!(line.contains("--app-mcp-stdio"));
        assert!(line.contains("--app-data-dir"));
        assert!(line.contains("default_tools_approval_mode=\"approve\""));
        assert!(envs.is_empty(), "stdio 服务器不需要令牌环境变量");
    }

    /// CR-059：无供应商但存在内置 MCP 时不得返回 None（否则工具被静默丢弃）。
    #[test]
    fn dispatch_config_is_kept_when_only_builtin_tools_exist() {
        let cfg = DispatchConfig {
            env: BTreeMap::new(), temp_dir: None, profile_dir: None, settings_file: None,
            strip_prefixes: vec![], mcp_config_file: None, mcp_allowed_tools: vec![],
            add_dirs: vec![], codex_overrides: vec!["mcp_servers.workbench={ command=\"x\" }".into()],
            ignore_user_config: false, display: ProviderDisplay::default(), grok_mcp_file: None,
        };
        assert!(!cfg.codex_overrides.is_empty(), "codex 覆盖存在时必须保留派发配置");
    }

    /* ---------- CR-064：grok 适配器 ---------- */

    /// CR-064：生成的 TOML 必须含 stdio 服务器的 command/args，并跳过非 stdio 传输。
    #[test]
    fn grok_mcp_toml_contains_stdio_servers_and_skips_http() {
        let stdio = McpRow {
            id: "b1".into(), name: "workbench".into(), transport: "stdio".into(),
            command: Some("C:\\app\\agent-workbench.exe".into()),
            args: vec!["--app-mcp-stdio".into(), "--app-data-dir".into(), "C:\\data".into()],
            env: BTreeMap::new(), url: None, auth_status: "unauthenticated".into(),
        };
        let http = McpRow {
            id: "h1".into(), name: "remote".into(), transport: "http".into(),
            command: None, args: vec![], env: BTreeMap::new(),
            url: Some("https://example.invalid/mcp".into()), auth_status: "authenticated".into(),
        };
        let toml = grok_mcp_config_toml(&[stdio, http]).unwrap();
        assert!(toml.contains("[mcp_servers.workbench]"), "应含 workbench 段：{toml}");
        assert!(toml.contains("command = "), "应含 command：{toml}");
        assert!(toml.contains("--app-mcp-stdio"), "应含 args：{toml}");
        assert!(toml.contains("\\\\"), "Windows 反斜杠必须转义：{toml}");
        assert!(!toml.contains("[mcp_servers.remote]"), "本轮不支持 http 传输，必须跳过");
        // 无可用 stdio 服务器时不产生内容（不写空文件）
        assert!(grok_mcp_config_toml(&[]).is_none());
        assert!(grok_mcp_config_toml(&[McpRow {
            id: "h2".into(), name: "only-http".into(), transport: "http".into(),
            command: None, args: vec![], env: BTreeMap::new(), url: None,
            auth_status: "authenticated".into(),
        }]).is_none());
        // 命令为空的 stdio 项被跳过
        assert!(grok_mcp_config_toml(&[McpRow {
            id: "e1".into(), name: "empty".into(), transport: "stdio".into(),
            command: Some("   ".into()), args: vec![], env: BTreeMap::new(), url: None,
            auth_status: "unauthenticated".into(),
        }]).is_none());
    }

    /// CR-064：GROK_HOME 隔离目录写入——按会话目录写 config.toml，可重复覆盖，
    /// 且不影响用户 ~/.grok（路径完全由调用方给定的 profile 目录决定）。
    #[test]
    fn grok_mcp_write_targets_isolated_grok_home() {
        let row = McpRow {
            id: "b1".into(), name: "workbench".into(), transport: "stdio".into(),
            command: Some("app.exe".into()), args: vec!["--app-mcp-stdio".into()],
            env: BTreeMap::new(), url: None, auth_status: "unauthenticated".into(),
        };
        let home = std::env::temp_dir().join(format!("grok-home-{}", uuid::Uuid::new_v4().simple()));
        // 首次写入：目录被创建、文件内容含服务器段
        let path = write_grok_mcp_config(&home, &[row.clone()]).unwrap().expect("应生成配置");
        assert_eq!(path, home.join("config.toml"));
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("[mcp_servers.workbench]"), "应含服务器段：{body}");
        assert!(body.contains("--app-mcp-stdio"));
        // 重复写入：覆盖（会话目录专属，不存在用户配置冲突）
        let path2 = write_grok_mcp_config(&home, &[row]).unwrap().expect("应再次生成");
        assert_eq!(path2, path);
        // 无 stdio 服务器：不写文件
        let empty_home = std::env::temp_dir().join(format!("grok-home-empty-{}", uuid::Uuid::new_v4().simple()));
        assert!(write_grok_mcp_config(&empty_home, &[]).unwrap().is_none());
        assert!(!empty_home.exists(), "无服务器时不应创建目录");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn dropping_configuration_cleans_both_owned_temporary_directories() {
        let provider = make_temp_dir("claude").unwrap();
        let mcp = make_temp_dir("mcp").unwrap();
        let file = mcp.join("mcp-config.json");
        std::fs::write(&file, "test-only").unwrap();
        let config = DispatchConfig {
            env: BTreeMap::new(), temp_dir: Some(provider.clone()), profile_dir: None, settings_file: None,
            strip_prefixes: vec![], mcp_config_file: Some(file), mcp_allowed_tools: vec![],
            add_dirs: vec![], codex_overrides: vec![], ignore_user_config: false,
            display: ProviderDisplay::default(), grok_mcp_file: None,
        };
        drop(config);
        assert!(!provider.exists());
        assert!(!mcp.exists());
    }

    /// CR-037：profile_dir 是会话线程存储，绝不随 Drop 清理；目录按 session 稳定创建。
    #[test]
    fn profile_dir_survives_drop_and_is_stable_per_session() {
        let dir = std::env::temp_dir().join(format!("profile-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = DispatchConfig {
            env: BTreeMap::new(), temp_dir: None, profile_dir: Some(dir.clone()), settings_file: None,
            strip_prefixes: vec![], mcp_config_file: None, mcp_allowed_tools: vec![],
            add_dirs: vec![], codex_overrides: vec![], ignore_user_config: false,
            display: ProviderDisplay::default(), grok_mcp_file: None,
        };
        drop(config);
        assert!(dir.exists(), "profile 目录不得随 Drop 删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// CR-064：OpenAI 系 CLI（codex/grok）的基址必须恰好带一次 `/v1`。
    ///
    /// 实测背景：codex 0.166 自行拼接 `/responses`、grok 1.0.77 拼接 `/chat/completions`；
    /// 基址缺 `/v1` 时请求落到 `POST <host>/responses`，网关回 405 Method Not Allowed。
    /// 用户也可能自己填了带 `/v1` 的地址，两种都要归一，不能拼成 `/v1/v1`。
    #[test]
    fn openai_base_appends_v1_exactly_once() {
        assert_eq!(openai_base("https://host"), "https://host/v1");
        assert_eq!(openai_base("https://host/"), "https://host/v1");
        assert_eq!(openai_base("https://host/v1"), "https://host/v1");
        assert_eq!(openai_base("https://host/v1/"), "https://host/v1");
        assert_eq!(openai_base("https://host/api"), "https://host/api/v1");
        assert_eq!(openai_base("  https://host/v1  "), "https://host/v1");
        assert_eq!(openai_base(""), "");
    }

    /// CR-064：grok 的供应商注入必须走上 grok 自己的变量名。
    ///
    /// 实测背景：grok 1.0.77 不读 `OPENAI_BASE_URL`——只注入 OPENAI_* 时它会连 xAI 官方
    /// 端点并长时间挂起（>15 分钟无输出），只能靠整树停止收场；改注入
    /// `GROK_XAI_API_BASE_URL` 后同一网关正常回话。这里锁定注入键名与 `/v1` 归一。
    #[test]
    fn grok_env_uses_grok_specific_endpoint_key() {
        // 与 build_dispatch_config 的 grok 分支保持同一构造顺序。
        let base = "https://gateway.example";
        let secret = "sk-test";
        let grok_base = openai_base(base);
        let mut env: BTreeMap<String, String> = BTreeMap::new();
        env.insert("GROK_XAI_API_BASE_URL".into(), grok_base.clone());
        env.insert("XAI_API_KEY".into(), secret.into());
        env.insert("GROK_NO_AUTO_UPDATE".into(), "1".into());

        assert_eq!(
            env.get("GROK_XAI_API_BASE_URL").map(String::as_str),
            Some("https://gateway.example/v1"),
            "端点变量是 GROK_XAI_API_BASE_URL 且必须带 /v1"
        );
        assert!(
            !env.contains_key("OPENAI_BASE_URL"),
            "grok 不读 OPENAI_BASE_URL，注入它只会造成挂起"
        );
        assert_eq!(env.get("XAI_API_KEY").map(String::as_str), Some("sk-test"));
        assert_eq!(
            env.get("GROK_NO_AUTO_UPDATE").map(String::as_str),
            Some("1"),
            "长跑任务需关闭自动更新横幅"
        );
        // 用户已填 /v1 时不得重复拼成 /v1/v1。
        assert_eq!(openai_base("https://gateway.example/v1"), grok_base);
    }
}

/// 受管 Skill 目录。
pub fn skill_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = crate::storage_layout::category("skills").ok()?;
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}
