//! 模型供应商 / 密钥 / 端点 / 模型配置（CR-012 语义）。
//!
//! 移植自思考等级插件参考的数据结构与候选过滤规则（见 docs/tmp/ref-analysis-dsh-model-think-level.md）：
//! - 思考档位表 efforts：off/minimal/low/medium/high/xhigh/max -> wire 拼写，null=不下发参数
//! - 会话候选：供应商启用 + 至少一条启用密钥 + 一条协议匹配启用端点 + text 能力 + 非生图
//! - 密钥明文仅存受管文件（app_data_dir/secrets.json，0600 权限），DB 存掩码与引用

use crate::db;
use tauri::Manager;
use crate::models::{EffortMap, ModelCandidate, ModelConfig, Provider, ProviderEndpoint, ProviderKey, now_ms, new_id};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 受管密钥存储（本地文件，仅本机使用）。
fn secrets_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

/// 供应商密钥与 MCP 凭据共用同一文件，必须共用同一把写锁，避免并发丢更新。
static SECRETS_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn secrets_file_guard() -> std::sync::MutexGuard<'static, ()> {
    SECRETS_FILE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn secrets_read(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    secrets_read_path(&secrets_file(app)?)
}

fn secrets_read_path(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let _guard = secrets_file_guard();
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "密钥文件格式无效，已拒绝覆盖".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err("密钥文件不可读取，已拒绝覆盖".into()),
    }
}

fn secrets_write(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    secrets_write_path(&secrets_file(app)?, map)
}

fn secrets_write_path(path: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    let _guard = secrets_file_guard();
    let tmp = path.with_file_name(format!("secrets-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| "无法写入密钥文件".to_string())?;
        file.write_all(&serde_json::to_vec_pretty(map).map_err(|_| "无法序列化密钥".to_string())?)
            .map_err(|_| "无法写入密钥文件".to_string())?;
        file.sync_all().map_err(|_| "无法保存密钥文件".to_string())?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|_| "无法替换密钥文件，原文件已保留".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn mask_secret(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}****{}", head, tail)
}

// ---------- 查询 ----------

fn load_providers_inner(conn: &rusqlite::Connection) -> Result<Vec<Provider>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, protocol, disabled, headersJson, fingerprintJson FROM provider ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let mut providers: Vec<Provider> = stmt
        .query_map([], |r| {
            Ok(Provider {
                id: r.get(0)?,
                name: r.get(1)?,
                protocol: r.get(2)?,
                disabled: r.get::<_, i64>(3)? != 0,
                headers_json: r.get(4)?,
                fingerprint_json: r.get(5)?,
                keys: vec![],
                endpoints: vec![],
                models: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for p in providers.iter_mut() {
        let mut ks = conn
            .prepare("SELECT id, alias, masked, enabled, protocol, modelsJson, scopeSource, probedAt FROM provider_key WHERE providerId=?1 ORDER BY createdAt")
            .map_err(|e| e.to_string())?;
        p.keys = ks
            .query_map([&p.id], |r| {
                let models_json: Option<String> = r.get(5)?;
                Ok(ProviderKey {
                    enabled: r.get::<_, i64>(3)? != 0,
                    id: r.get(0)?,
                    alias: r.get(1)?,
                    masked: r.get(2)?,
                    protocol: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    models: models_json
                        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
                        .unwrap_or_default(),
                    scope_source: r.get(6)?,
                    probed_at: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut es = conn
            .prepare("SELECT id, protocol, baseUrl, enabled FROM provider_endpoint WHERE providerId=?1 ORDER BY createdAt")
            .map_err(|e| e.to_string())?;
        p.endpoints = es
            .query_map([&p.id], |r| {
                Ok(ProviderEndpoint {
                    enabled: r.get::<_, i64>(3)? != 0,
                    id: r.get(0)?,
                    protocol: r.get(1)?,
                    base_url: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut ms = conn
            .prepare(
                "SELECT id, modelId, displayName, text, vision, imageGen, effortsJson, defaultEffort, contextWindow, maxTokens, sortOrder
                 FROM model WHERE providerId=?1 ORDER BY sortOrder, createdAt",
            )
            .map_err(|e| e.to_string())?;
        p.models = ms
            .query_map([&p.id], |r| {
                let efforts_json: String = r.get(6)?;
                Ok(ModelConfig {
                    context_window: r.get(8)?,
                    default_effort: r.get(7)?,
                    display_name: r.get(2)?,
                    efforts: serde_json::from_str(&efforts_json).unwrap_or_default(),
                    id: r.get(0)?,
                    image_gen: r.get::<_, i64>(5)? != 0,
                    max_tokens: r.get(9)?,
                    model_id: r.get(1)?,
                    provider_id: p.id.clone(),
                    text: r.get::<_, i64>(3)? != 0,
                    vision: r.get::<_, i64>(4)? != 0,
                    sort_order: r.get::<_, Option<i64>>(10)?.unwrap_or(0),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
    }
    Ok(providers)
}

#[tauri::command]
pub fn provider_list(app: tauri::AppHandle) -> Result<Vec<Provider>, String> {
    let _ = &app; // 密钥值不出后端；此处仅掩码展示
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    load_providers_inner(conn)
}

/// 供应商草稿（新建/更新）。keys/endpoints/models 为整表替换。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    pub id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub disabled: bool,
    pub headers_json: Option<String>,
    pub keys: Vec<KeyDraft>,
    pub endpoints: Vec<EndpointDraft>,
    pub models: Vec<ModelDraft>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDraft {
    pub id: Option<String>,
    pub alias: Option<String>,
    pub secret: Option<String>, // 明文仅出现在保存请求，存入受管文件
    pub enabled: bool,
    /// CR-059：'' 沿用供应商默认；Chat/Responses → OpenAI 端点；Anthropic → Anthropic 端点。
    #[serde(default)]
    pub protocol: String,
    /// CR-059：该密钥可用模型（空 = 全部）。
    #[serde(default)]
    pub models: Vec<String>,
    /// CR-059：范围来源 auto/manual。
    #[serde(default)]
    pub scope_source: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDraft {
    pub id: Option<String>,
    pub protocol: String,
    pub base_url: String,
    pub enabled: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDraft {
    pub id: Option<String>,
    pub model_id: String,
    pub display_name: String,
    pub text: bool,
    pub vision: bool,
    pub image_gen: bool,
    pub efforts: EffortMap,
    pub default_effort: Option<String>,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
    /// CR-059：该供应商内的展示顺序（缺省按数组下标）。
    #[serde(default)]
    pub sort_order: Option<i64>,
}

/// 校验默认档位必须来自已配置档位（CR-012）。
fn validate_draft(d: &ModelDraft) -> Result<(), String> {
    if d.model_id.trim().is_empty() {
        return Err("模型 ID 不能为空".into());
    }
    for k in d.efforts.keys() {
        if !THINKING_LEVELS.contains(&k.as_str()) {
            return Err(format!("未知思考档位：{}", k));
        }
    }
    if let Some(def) = &d.default_effort {
        if !d.efforts.contains_key(def) {
            return Err("默认档位必须来自已配置的档位".into());
        }
    }
    if d.image_gen && d.text {
        return Err("文本与生图能力互斥".into());
    }
    Ok(())
}

#[tauri::command]
pub fn provider_save(app: tauri::AppHandle, draft: ProviderDraft) -> Result<String, String> {
    // 与删除共用 DB 锁；读取失败绝不能视为空密钥表再覆盖。
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut secrets = secrets_read(&app)?;
    save_provider_inner(conn, draft, &mut secrets, |map| secrets_write(&app, map))
}

fn check_owned_ids<'a>(conn: &rusqlite::Connection, table: &str, pid: &str, ids: impl Iterator<Item = Option<&'a str>>) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let mut seen = BTreeSet::new();
    for id in ids.flatten() {
        if id.trim().is_empty() || !seen.insert(id) {
            return Err("配置 ID 为空或重复".into());
        }
        let owner: Option<String> = conn.query_row(
            &format!("SELECT providerId FROM {} WHERE id=?1", table), [id], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if owner.as_deref().map(|p| p != pid).unwrap_or(false) {
            return Err("配置 ID 属于其他供应商，已拒绝保存".into());
        }
    }
    Ok(())
}

fn save_provider_inner(
    conn: &rusqlite::Connection,
    draft: ProviderDraft,
    secrets: &mut BTreeMap<String, String>,
    write_secrets: impl FnOnce(&BTreeMap<String, String>) -> Result<(), String>,
) -> Result<String, String> {
    if draft.name.trim().is_empty() {
        return Err("供应商名称不能为空".into());
    }
    if draft.protocol != "anthropic" && draft.protocol != "openai" {
        return Err("协议必须是 anthropic 或 openai".into());
    }
    for m in &draft.models { validate_draft(m)?; }
    for e in &draft.endpoints {
        models_url(&e.base_url)?;
        if e.protocol != "anthropic" && e.protocol != "openai" {
            return Err("端点协议必须是 anthropic 或 openai".into());
        }
    }
    let now = now_ms();
    let pid = draft.id.clone().unwrap_or_else(|| new_id("prov"));
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    check_owned_ids(&tx, "provider_key", &pid, draft.keys.iter().map(|k| k.id.as_deref()))?;
    check_owned_ids(&tx, "provider_endpoint", &pid, draft.endpoints.iter().map(|e| e.id.as_deref()))?;
    check_owned_ids(&tx, "model", &pid, draft.models.iter().map(|m| m.id.as_deref()))?;
    let old_probed: BTreeMap<String, Option<i64>> = {
        let mut stmt = tx.prepare("SELECT id, probedAt FROM provider_key WHERE providerId=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&pid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let old_keys: BTreeMap<String, (String, String, i64)> = {
        let mut stmt = tx.prepare("SELECT id, secretRef, masked, createdAt FROM provider_key WHERE providerId=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&pid], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    if draft.id.is_some() {
        let changed = tx.execute(
            "UPDATE provider SET name=?2, protocol=?3, disabled=?4, headersJson=?5, updatedAt=?6 WHERE id=?1",
            rusqlite::params![pid, draft.name.trim(), draft.protocol, draft.disabled as i64, draft.headers_json, now],
        ).map_err(|e| e.to_string())?;
        if changed != 1 { return Err("供应商不存在，已拒绝保存".into()); }
    } else {
        tx.execute(
            "INSERT INTO provider (id, name, protocol, disabled, headersJson, createdAt, updatedAt) VALUES (?1,?2,?3,?4,?5,?6,?6)",
            rusqlite::params![pid, draft.name.trim(), draft.protocol, draft.disabled as i64, draft.headers_json, now],
        ).map_err(|e| e.to_string())?;
    }
    // 子表仅替换目标供应商，事务内任一步失败都保留原配置。
    // 新密钥用新引用：DB 提交前写入的是旧+新密钥全集，失败/崩溃不破坏旧引用。
    let mut next_secrets = secrets.clone();
    tx.execute("DELETE FROM provider_key WHERE providerId=?1", [&pid]).map_err(|e| e.to_string())?;
    for k in &draft.keys {
        let kid = k.id.clone().unwrap_or_else(|| new_id("key"));
        let old = old_keys.get(&kid);
        let (secret_ref, masked) = match k.secret.as_deref().filter(|s| !s.is_empty()) {
            Some(sec) => {
                let secret_ref = new_id("secret");
                next_secrets.insert(secret_ref.clone(), sec.to_string());
                (secret_ref, mask_secret(sec))
            }
            None => match old {
                Some((secret_ref, masked, _)) => (secret_ref.clone(), masked.clone()),
                None => (new_id("secret"), String::new()),
            },
        };
        if !matches!(k.protocol.as_str(), "" | "Chat" | "Responses" | "Anthropic") {
            return Err("密钥协议只能是默认、Chat、Responses 或 Anthropic".into());
        }
        let models_json = serde_json::to_string(&k.models).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO provider_key (id, providerId, alias, secretRef, masked, enabled, protocol, modelsJson, scopeSource, probedAt, createdAt)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![kid, pid, k.alias, secret_ref, masked, k.enabled as i64,
                k.protocol, models_json, k.scope_source,
                old_probed.get(&kid).copied().flatten(), old.map(|v| v.2).unwrap_or(now)],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM provider_endpoint WHERE providerId=?1", [&pid]).map_err(|e| e.to_string())?;
    for e in &draft.endpoints {
        let eid = e.id.clone().unwrap_or_else(|| new_id("ep"));
        tx.execute(
            "INSERT INTO provider_endpoint (id, providerId, protocol, baseUrl, enabled, createdAt) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![eid, pid, e.protocol, e.base_url.trim(), e.enabled as i64, now],
        ).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM model WHERE providerId=?1", [&pid]).map_err(|e| e.to_string())?;
    for m in &draft.models {
        let mid = m.id.clone().unwrap_or_else(|| new_id("mdl"));
        tx.execute(
            "INSERT INTO model (id, providerId, modelId, displayName, text, vision, imageGen, effortsJson, defaultEffort, contextWindow, maxTokens, sortOrder, createdAt)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            rusqlite::params![mid, pid, m.model_id.trim(), m.display_name.trim(), m.text as i64,
                m.vision as i64, m.image_gen as i64, serde_json::to_string(&m.efforts).map_err(|e| e.to_string())?,
                m.default_effort, m.context_window, m.max_tokens, m.sort_order.unwrap_or(now), now],
        ).map_err(|e| e.to_string())?;
    }
    write_secrets(&next_secrets)?;
    tx.commit().map_err(|e| e.to_string())?;
    *secrets = next_secrets;
    Ok(pid)
}

#[tauri::command]
pub fn provider_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let refs = provider_secret_refs(&tx, &id)?;
    tx.execute("DELETE FROM provider WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    // 先提交 DB，避免失败时删除仍在使用的密钥；只清理目标独占的 secretRef。
    let mut secrets = secrets_read(&app)?;
    let removable = unreferenced_secrets(&tx, refs)?;
    tx.commit().map_err(|e| e.to_string())?;
    for secret_ref in removable { secrets.remove(&secret_ref); }
    secrets_write(&app, &secrets)
}

fn provider_secret_refs(conn: &rusqlite::Connection, id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT secretRef FROM provider_key WHERE providerId=?1").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn unreferenced_secrets(conn: &rusqlite::Connection, refs: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for secret_ref in refs {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM provider_key WHERE secretRef=?1", [&secret_ref], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count == 0 { out.push(secret_ref); }
    }
    Ok(out)
}

#[tauri::command]
pub fn provider_set_disabled(id: String, disabled: bool) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "UPDATE provider SET disabled=?2, updatedAt=?3 WHERE id=?1",
        rusqlite::params![id, disabled as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 会话候选模型（CR-012 过滤规则）。
#[tauri::command]
pub fn model_candidates() -> Result<Vec<ModelCandidate>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let providers = load_providers_inner(conn)?;
    let mut out = Vec::new();
    for p in providers.iter().filter(|p| !p.disabled) {
        let has_key = p.keys.iter().any(|k| k.enabled && !k.masked.is_empty());
        if !has_key {
            continue;
        }
        let has_endpoint = p.endpoints.iter().any(|e| e.enabled && e.protocol == p.protocol);
        if !has_endpoint {
            continue;
        }
        for m in p.models.iter().filter(|m| m.text && !m.image_gen) {
            out.push(ModelCandidate {
                context_window: m.context_window,
                default_effort: m.default_effort.clone(),
                display_name: m.display_name.clone(),
                efforts: m.efforts.clone(),
                model_id: m.model_id.clone(),
                max_tokens: m.max_tokens,
                model_row_id: m.id.clone(),
                provider_id: p.id.clone(),
                provider_name: p.name.clone(),
                protocol: p.protocol.clone(),
                vision: m.vision,
            });
        }
    }
    Ok(out)
}

const MAX_MODELS_BODY: u64 = 1024 * 1024;
const MAX_DISCOVERED_MODELS: usize = 1000;

fn models_url(base: &str) -> Result<String, String> {
    let mut url = tauri::Url::parse(base.trim()).map_err(|_| "端点地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
    {
        return Err("端点必须为不含凭证、查询或片段的 HTTP(S) 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/v1") { format!("{}/models", path) }
        else { format!("{}/v1/models", path) };
    url.set_path(&path);
    Ok(url.to_string())
}

fn parse_discovered_models(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    if bytes.len() as u64 > MAX_MODELS_BODY { return Err("模型发现响应过大".into()); }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "模型发现响应不是有效 JSON".to_string())?;
    let rows = value.get("data").and_then(|v| v.as_array()).ok_or("模型发现响应缺少 data 列表")?;
    if rows.len() > MAX_DISCOVERED_MODELS { return Err("模型发现条目过多".into()); }
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for row in rows {
        let id = row.get("id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty() && s.len() <= 512)
            .ok_or("模型发现响应包含无效模型 ID")?;
        if !seen.insert(id) { continue; }
        let display = row.get("display_name").and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty() && s.len() <= 512).unwrap_or(id);
        // 模型列表通常不提供这些能力字段，禁止依据名称猜测。
        out.push(serde_json::json!({ "modelId": id, "displayName": display,
            "contextWindow": null, "vision": null, "thinking": null }));
    }
    Ok(out)
}

/// 取上游 `/models` 原始行（含推理信号等字段），供模型发现与档位解析共用。
/// 不跟随重定向；失败返回错误，调用方可降级。
async fn provider_listing_rows(app: &tauri::AppHandle, provider_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let (url, key, protocol, headers) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let (protocol, disabled, headers): (String, bool, Option<String>) = conn.query_row(
            "SELECT protocol, disabled, headersJson FROM provider WHERE id=?1", [provider_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)),
        ).map_err(|_| "供应商不存在".to_string())?;
        if disabled || !matches!(protocol.as_str(), "openai" | "anthropic") {
            return Err("供应商已停用或协议不支持模型发现".into());
        }
        let base: String = conn.query_row(
            "SELECT baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1 AND protocol=?2 ORDER BY createdAt, id LIMIT 1",
            rusqlite::params![provider_id, protocol], |r| r.get(0),
        ).map_err(|_| "没有与供应商协议匹配的启用端点".to_string())?;
        let secrets = secrets_read(app)?;
        let refs = {
            let mut stmt = conn.prepare("SELECT secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt, id")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([provider_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let key = refs.iter().find_map(|r| secrets.get(r).filter(|s| !s.trim().is_empty()).cloned())
            .ok_or("供应商没有可用的启用密钥")?;
        if key.contains(['\r', '\n']) { return Err("密钥含无效字符".into()); }
        let headers: BTreeMap<String, String> = match headers.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(s) => serde_json::from_str(s).map_err(|_| "高级请求头格式无效".to_string())?,
            None => BTreeMap::new(),
        };
        for (name, value) in &headers {
            if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c))
                || value.contains(['\r', '\n'])
                || matches!(name.to_ascii_lowercase().as_str(), "authorization" | "x-api-key" | "host" | "cookie" | "proxy-authorization")
            { return Err("高级请求头含无效或保留字段".into()); }
        }
        (models_url(&base)?, key, protocol, headers)
    };
    tokio::task::spawn_blocking(move || {
        // 不跟随重定向，防密钥被带往非用户配置的端点。
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(10)).build();
        let mut request = agent.get(&url).set("Accept", "application/json");
        for (name, value) in headers { request = request.set(&name, &value); }
        request = if protocol == "anthropic" {
            request.set("x-api-key", &key).set("anthropic-version", "2023-06-01")
        } else { request.set("Authorization", &format!("Bearer {}", key)) };
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(code, _)) => return Err(format!("模型发现失败（HTTP {}）", code)),
            Err(_) => return Err("模型发现连接失败或超时".into()),
        };
        if !(200..300).contains(&response.status()) { return Err(format!("模型发现失败（HTTP {}）", response.status())); }
        let mut body = Vec::new();
        response.into_reader().take(MAX_MODELS_BODY + 1).read_to_end(&mut body)
            .map_err(|_| "无法读取模型发现响应".to_string())?;
        parse_discovered_models(&body)
    }).await.map_err(|_| "模型发现任务异常".to_string())?
}

/// 模型发现（只返回清单字段，不含思考等级/模态，CR-059 B1）。
#[tauri::command]
pub async fn provider_discover_models(app: tauri::AppHandle, provider_id: String) -> Result<Vec<serde_json::Value>, String> {
    provider_listing_rows(&app, &provider_id).await
}

// ---------- CR-059：思考等级解析（供应商信号 → 内置知识库） ----------

/// 单个模型的思考档位解析结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortResolution {
    pub model_id: String,
    pub efforts: EffortMap,
    pub default_effort: Option<String>,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
    /// vendor / knowledge / vendor+knowledge / none
    pub source: String,
    pub note: Option<String>,
}

/// 从上游 `/models` 列表读取的推理信号（三态：Some(true)/Some(false)/None=未知）。
fn reasoning_signal(row: &serde_json::Value) -> Option<bool> {
    let flag = |key: &str| row.get(key).and_then(|v| v.as_bool());
    if let Some(v) = flag("supports_reasoning").or_else(|| flag("supportsReasoning")).or_else(|| flag("can_reason")) {
        return Some(v);
    }
    let has = |key: &str, needle: &str| row.get(key).and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str()).any(|s| s == needle)).unwrap_or(false);
    if has("supported_parameters", "reasoning") || has("supported_parameters", "reasoning_effort")
        || has("supported_parameters", "include_reasoning") || has("supported_features", "reasoning")
    {
        return Some(true);
    }
    if let Some(v) = row.get("capabilities").and_then(|c| c.get("effort")).and_then(|e| e.get("supported")).and_then(|v| v.as_bool()) {
        return Some(v);
    }
    if let Some(v) = row.get("capabilities").and_then(|c| c.get("thinking")).and_then(|e| e.get("supported")).and_then(|v| v.as_bool()) {
        return Some(v);
    }
    if row.get("reasoning_effort").map(|v| v.is_null()).unwrap_or(false) {
        return Some(false);
    }
    None
}

/// 供应商未声明档位但确认支持推理时的通用阶梯（中置信）。
fn generic_ladder() -> EffortMap {
    [("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))]
        .into_iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect()
}

/// 解析一批模型（先供应商信号，再内置知识库）；未命中返回 efforts 空并标 source=none，不猜。
fn resolve_efforts(ids: &[String], rows: &[serde_json::Value]) -> Vec<EffortResolution> {
    ids.iter().map(|model_id| {
        let row = rows.iter().find(|r| r.get("id").and_then(|v| v.as_str()) == Some(model_id.as_str()));
        let display = row.and_then(|r| r.get("display_name").and_then(|v| v.as_str())).unwrap_or(model_id);
        let signal = row.and_then(reasoning_signal);
        if signal == Some(false) {
            return EffortResolution {
                model_id: model_id.clone(), efforts: EffortMap::new(), default_effort: None,
                context_window: None, max_tokens: None, source: "vendor".into(),
                note: Some("上游明确声明不支持推理".into()),
            };
        }
        if let Some(entry) = crate::commands::think_kb::match_entry(model_id, display) {
            let efforts: EffortMap = entry.efforts.iter()
                .map(|(level, wire)| (level.to_string(), wire.map(str::to_string))).collect();
            return EffortResolution {
                model_id: model_id.clone(),
                default_effort: entry.default_effort.map(str::to_string).filter(|d| efforts.contains_key(d)),
                context_window: entry.context_window,
                max_tokens: entry.max_tokens,
                efforts,
                source: if signal == Some(true) { "vendor+knowledge".into() } else { "knowledge".into() },
                note: entry.note.map(str::to_string),
            };
        }
        if signal == Some(true) {
            return EffortResolution {
                model_id: model_id.clone(), efforts: generic_ladder(), default_effort: None,
                context_window: None, max_tokens: None, source: "vendor".into(),
                note: Some("上游确认支持推理，使用通用阶梯（中置信），请核实下发拼写".into()),
            };
        }
        EffortResolution {
            model_id: model_id.clone(), efforts: EffortMap::new(), default_effort: None,
            context_window: None, max_tokens: None, source: "none".into(),
            note: Some("供应商与内置知识库均未提供可信档位，请手动配置".into()),
        }
    }).collect()
}

/// 模型发现并把上游返回行（含推理信号）一起带回，供前端批量补齐档位使用。
#[tauri::command]
pub async fn provider_resolve_efforts(
    app: tauri::AppHandle,
    provider_id: String,
    model_ids: Vec<String>,
) -> Result<Vec<EffortResolution>, String> {
    if model_ids.len() > MAX_DISCOVERED_MODELS { return Err("模型数量过多".into()); }
    // 上游信号失败不阻塞：按知识库解析，信号为未知。
    let rows = provider_listing_rows(&app, &provider_id).await.unwrap_or_default();
    Ok(resolve_efforts(&model_ids, &rows))
}


// ---------- CR-059：密钥协议→端点解析与按密钥模型范围探测 ----------

/// 密钥请求目标：协议 wire 与端点地址。
pub struct KeyTarget {
    pub wire: String,
    pub base_url: String,
}

fn key_wire(protocol: &str) -> &'static str {
    match protocol {
        "Anthropic" => "anthropic",
        _ => "openai",
    }
}

/// 解析某密钥应使用的端点（r8：密钥协议决定端点，只有「默认」才沿用供应商协议）。
fn resolve_key_target(
    key_protocol: &str,
    provider_protocol: &str,
    endpoints: &[(String, String)],
) -> Result<KeyTarget, String> {
    let wire = if key_protocol.is_empty() { provider_protocol.to_string() } else { key_wire(key_protocol).to_string() };
    let base = endpoints.iter().find(|(p, _)| p == &wire).map(|(_, u)| u.clone())
        .ok_or_else(|| if wire == "anthropic" { "该密钥使用 Anthropic 协议，但没有启用且已填写的 Anthropic 端点".to_string() }
                      else { "该密钥使用 OpenAI 协议，但没有启用且已填写的 OpenAI 端点".to_string() })?;
    Ok(KeyTarget { wire, base_url: base })
}

/// 探测目标列表：未指定协议的密钥，按供应商协议端点 + 另一协议端点（若有地址）各问一次。
fn probe_targets(key_protocol: &str, provider_protocol: &str, endpoints: &[(String, String)]) -> Vec<KeyTarget> {
    if !key_protocol.is_empty() {
        return resolve_key_target(key_protocol, provider_protocol, endpoints).into_iter().collect();
    }
    let mut out = Vec::new();
    if let Ok(t) = resolve_key_target("", provider_protocol, endpoints) { out.push(t); }
    let other = if provider_protocol == "anthropic" { "openai" } else { "anthropic" };
    if let Some((_, url)) = endpoints.iter().find(|(p, _)| p == other) {
        if !url.trim().is_empty() { out.push(KeyTarget { wire: other.to_string(), base_url: url.clone() }); }
    }
    out
}

/// 取一个端点的模型清单（仅用于范围探测；失败返回错误，调用方跳过该 target）。
fn listing_ids(base_url: &str, wire: &str, key: &str, headers: &BTreeMap<String, String>) -> Result<Vec<String>, String> {
    let url = models_url(base_url)?;
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(10)).build();
    let mut request = agent.get(&url).set("Accept", "application/json");
    for (name, value) in headers { request = request.set(name, value); }
    request = if wire == "anthropic" {
        request.set("x-api-key", key).set("anthropic-version", "2023-06-01")
    } else { request.set("Authorization", &format!("Bearer {}", key)) };
    let response = match request.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return Err(format!("HTTP {}", code)),
        Err(_) => return Err("连接失败".into()),
    };
    let mut body = Vec::new();
    response.into_reader().take(MAX_MODELS_BODY + 1).read_to_end(&mut body).map_err(|_| "读取失败".to_string())?;
    let models = parse_discovered_models(&body)?;
    Ok(models.iter().filter_map(|m| m.get("modelId").and_then(|v| v.as_str()).map(str::to_string)).collect())
}

/// 单个密钥的探测结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyProbeOutcome {
    pub key_id: String,
    pub alias: Option<String>,
    /// 该密钥实际支持的、且属于本供应商已声明模型的子集；None = 未取到清单（保留原范围）。
    pub served: Option<Vec<String>>,
    pub error: Option<String>,
}

/// 按密钥探测模型范围（保存后异步触发 / 用户点「立即探测」）。
/// 规则：启用密钥 <2 时不探测；全部支持→写空范围；部分→写交集；手动已配置→只追加新增。
#[tauri::command]
pub async fn provider_probe_key_scopes(app: tauri::AppHandle, provider_id: String) -> Result<Vec<KeyProbeOutcome>, String> {
    let (provider_protocol, headers, enabled_keys, endpoints, declared, key_values) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let (protocol, disabled, headers): (String, bool, Option<String>) = conn.query_row(
            "SELECT protocol, disabled, headersJson FROM provider WHERE id=?1", [&provider_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)),
        ).map_err(|_| "供应商不存在".to_string())?;
        if disabled { return Err("供应商已停用，未执行探测".into()); }
        let headers: BTreeMap<String, String> = match headers.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(s) => serde_json::from_str(s).map_err(|_| "高级请求头格式无效".to_string())?,
            None => BTreeMap::new(),
        };
        let mut ks = conn.prepare(
            "SELECT id, alias, protocol, secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt, id")
            .map_err(|e| e.to_string())?;
        let enabled_keys: Vec<(String, Option<String>, String, String)> = ks.query_map([&provider_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get(3)?))
        }).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        let mut es = conn.prepare("SELECT protocol, baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1")
            .map_err(|e| e.to_string())?;
        let endpoints: Vec<(String, String)> = es.query_map([&provider_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        let mut ms = conn.prepare("SELECT modelId FROM model WHERE providerId=?1").map_err(|e| e.to_string())?;
        let declared: Vec<String> = ms.query_map([&provider_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        let secrets = secrets_read(&app)?;
        let key_values: BTreeMap<String, String> = enabled_keys.iter()
            .filter_map(|(id, _, _, r)| secrets.get(r).filter(|v| !v.trim().is_empty()).map(|v| (id.clone(), v.clone())))
            .collect();
        (protocol, headers, enabled_keys, endpoints, declared, key_values)
    };
    // 单密钥无需探测：模型配置中的模型即其支持范围。
    if enabled_keys.len() < 2 || declared.is_empty() {
        return Ok(enabled_keys.iter().map(|(id, alias, _, _)| KeyProbeOutcome {
            key_id: id.clone(), alias: alias.clone(), served: None,
            error: Some(if declared.is_empty() { "尚未配置模型".into() } else { "只有一个启用密钥，无需探测".into() }),
        }).collect());
    }
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for (key_id, alias, key_protocol, _) in enabled_keys {
            let Some(secret) = key_values.get(&key_id) else {
                out.push(KeyProbeOutcome { key_id, alias, served: None, error: Some("密钥值不可用".into()) });
                continue;
            };
            if secret.contains(['\r', '\n']) {
                out.push(KeyProbeOutcome { key_id, alias, served: None, error: Some("密钥含无效字符".into()) });
                continue;
            }
            let targets = probe_targets(&key_protocol, &provider_protocol, &endpoints);
            if targets.is_empty() {
                out.push(KeyProbeOutcome { key_id, alias, served: None, error: Some("没有可用的端点".into()) });
                continue;
            }
            let mut served: Vec<String> = Vec::new();
            let mut last_error = None;
            let mut answered = false;
            for target in targets {
                match listing_ids(&target.base_url, &target.wire, secret, &headers) {
                    Ok(ids) => { answered = true; for id in ids { if !served.contains(&id) { served.push(id); } } }
                    Err(e) => last_error = Some(e),
                }
            }
            if !answered {
                out.push(KeyProbeOutcome { key_id, alias, served: None, error: last_error.or(Some("未取到模型清单".into())) });
                continue;
            }
            // 只在本供应商已声明模型集合内报告（避免写进不属于该供应商的模型）。
            let scoped: Vec<String> = declared.iter().filter(|id| served.contains(id)).cloned().collect();
            out.push(KeyProbeOutcome { key_id, alias, served: Some(scoped), error: last_error });
        }
        Ok(out)
    }).await.map_err(|_| "密钥探测任务异常".to_string())?
}

/// 指纹检测：探测每个协议匹配的启用端点。
#[tauri::command]
pub async fn fingerprint_check(app: tauri::AppHandle, provider_id: String) -> Result<serde_json::Value, String> {
    let (protocol, endpoints): (String, Vec<(String, String)>) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let protocol: String = conn
            .query_row("SELECT protocol FROM provider WHERE id=?1", [&provider_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1 AND protocol=?2")
            .map_err(|e| e.to_string())?;
        let eps = stmt
            .query_map(rusqlite::params![provider_id, protocol], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        (protocol, eps)
    };
    let secrets = secrets_read(&app)?;
    let mut results = Vec::new();
    for (ep_id, base) in endpoints {
        let probe_url = models_url(&base)?;
        // 取该供应商第一条密钥
        let key_ref: Option<String> = {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            conn.query_row(
                "SELECT secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt LIMIT 1",
                [&provider_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        };
        let key = key_ref.and_then(|k| secrets.get(&k).cloned()).unwrap_or_default();
        let status = probe_endpoint(&probe_url, &key, &protocol).await;
        results.push(serde_json::json!({ "endpointId": ep_id, "url": probe_url, "status": status }));
    }
    // 保存指纹结果
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.execute(
            "UPDATE provider SET fingerprintJson=?2, updatedAt=?3 WHERE id=?1",
            rusqlite::params![provider_id, serde_json::to_string(&results).map_err(|e| e.to_string())?, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(serde_json::json!({ "results": results }))
}

/// 端点探测（https/http，ureq 阻塞调用放入 blocking 线程）。
async fn probe_endpoint(url: &str, key: &str, protocol: &str) -> String {
    let url = url.to_string();
    let key = key.to_string();
    let protocol = protocol.to_string();
    tokio::task::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(10)).build();
        let mut req = agent.get(&url).set("User-Agent", "agent-workbench");
        req = if protocol == "anthropic" {
            req.set("x-api-key", &key).set("anthropic-version", "2023-06-01")
        } else {
            req.set("Authorization", &format!("Bearer {}", key))
        };
        match req.call() {
            Ok(resp) => format!("{} {}", resp.status(), resp.status_text()),
            Err(ureq::Error::Status(code, resp)) => format!("{} {}", code, resp.status_text()),
            Err(e) => format!("ERR: {}", e),
        }
    })
    .await
    .unwrap_or_else(|e| format!("ERR: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,createdAt INTEGER,updatedAt INTEGER);
            CREATE TABLE provider_key(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,alias TEXT,secretRef TEXT,masked TEXT,enabled INTEGER,createdAt INTEGER,protocol TEXT NOT NULL DEFAULT '',modelsJson TEXT,scopeSource TEXT,probedAt INTEGER);
            CREATE TABLE provider_endpoint(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,protocol TEXT,baseUrl TEXT,enabled INTEGER,createdAt INTEGER);
            CREATE TABLE model(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,modelId TEXT,displayName TEXT,text INTEGER,vision INTEGER,imageGen INTEGER,effortsJson TEXT,defaultEffort TEXT,contextWindow INTEGER,maxTokens INTEGER,sortOrder INTEGER NOT NULL DEFAULT 0,createdAt INTEGER,UNIQUE(providerId,modelId));
            INSERT INTO provider VALUES('p1','one','openai',0,NULL,1,1),('p2','two','openai',0,NULL,1,1);
            INSERT INTO provider_key VALUES('key-one','p1',NULL,'custom-ref','masked',1,1,'','[]',NULL,NULL),('key-two','p2',NULL,'key-two','other-mask',1,1,'','[]',NULL,NULL);").unwrap();
        conn
    }

    fn draft(secret: Option<&str>) -> ProviderDraft {
        ProviderDraft { id: Some("p1".into()), name: "updated".into(), protocol: "openai".into(), disabled: false,
            headers_json: None, keys: vec![KeyDraft { id: Some("key-one".into()), alias: None, secret: secret.map(str::to_string), enabled: false, protocol: String::new(), models: vec![], scope_source: None }],
            endpoints: vec![], models: vec![] }
    }

    #[test]
    fn save_preserves_custom_ref_and_other_provider() {
        let conn = database();
        let mut secrets = BTreeMap::from([("custom-ref".into(), "original".into()), ("key-two".into(), "other".into())]);
        save_provider_inner(&conn, draft(None), &mut secrets, |_| Ok(())).unwrap();
        let reference: String = conn.query_row("SELECT secretRef FROM provider_key WHERE id='key-one'", [], |r| r.get(0)).unwrap();
        assert_eq!(reference, "custom-ref");
        assert_eq!(secrets["key-two"], "other");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM provider_key WHERE providerId='p2'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn secret_write_failure_rolls_back_entire_save() {
        let conn = database();
        let mut secrets = BTreeMap::from([("custom-ref".into(), "original".into())]);
        assert!(save_provider_inner(&conn, draft(Some("replacement")), &mut secrets, |_| Err("disk unavailable".into())).is_err());
        assert_eq!(secrets["custom-ref"], "original");
        assert_eq!(conn.query_row("SELECT name FROM provider WHERE id='p1'", [], |r| r.get::<_, String>(0)).unwrap(), "one");
        assert_eq!(conn.query_row("SELECT secretRef FROM provider_key WHERE id='key-one'", [], |r| r.get::<_, String>(0)).unwrap(), "custom-ref");
    }

    #[test]
    fn replacement_writes_union_before_changing_reference() {
        let conn = database();
        let mut secrets = BTreeMap::from([("custom-ref".into(), "original".into()), ("key-two".into(), "other".into())]);
        save_provider_inner(&conn, draft(Some("replacement")), &mut secrets, |map| {
            assert_eq!(map["custom-ref"], "original");
            assert_eq!(map["key-two"], "other");
            assert!(map.values().any(|v| v == "replacement"));
            Ok(())
        }).unwrap();
        let reference: String = conn.query_row("SELECT secretRef FROM provider_key WHERE id='key-one'", [], |r| r.get(0)).unwrap();
        assert_ne!(reference, "custom-ref");
        assert_eq!(secrets[&reference], "replacement");
    }

    #[test]
    fn rejects_foreign_child_id_before_writing() {
        let conn = database();
        let mut d = draft(Some("replacement"));
        d.keys[0].id = Some("key-two".into());
        assert!(save_provider_inner(&conn, d, &mut BTreeMap::new(), |_| panic!("must not write")).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM provider_key", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn deletion_only_selects_target_unshared_refs() {
        let conn = database();
        let refs = provider_secret_refs(&conn, "p1").unwrap();
        conn.execute("DELETE FROM provider WHERE id='p1'", []).unwrap();
        assert_eq!(unreferenced_secrets(&conn, refs).unwrap(), vec!["custom-ref"]);
        assert_eq!(provider_secret_refs(&conn, "p2").unwrap(), vec!["key-two"]);
    }

    #[test]
    fn models_endpoint_respects_v1_and_rejects_credentials() {
        assert_eq!(models_url("https://example.test/v1/").unwrap(), "https://example.test/v1/models");
        assert_eq!(models_url("https://example.test/api").unwrap(), "https://example.test/api/v1/models");
        assert!(models_url("https://secret@example.test").is_err());
        assert!(models_url("file:///private").is_err());
        assert!(models_url("https://example.test?key=private").is_err());
    }

    #[test]
    fn discovery_does_not_guess_capabilities_or_accept_oversized_body() {
        let models = parse_discovered_models(br#"{"data":[{"id":"vision-thinking-1"},{"id":"vision-thinking-1"}]}"#).unwrap();
        assert_eq!(models.len(), 1);
        assert!(models[0]["contextWindow"].is_null());
        assert!(models[0]["vision"].is_null());
        assert!(models[0]["thinking"].is_null());
        assert!(parse_discovered_models(&vec![b' '; MAX_MODELS_BODY as usize + 1]).is_err());
    }
}
