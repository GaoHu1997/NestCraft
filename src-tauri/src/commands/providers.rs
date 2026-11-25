//! 模型供应商 / 密钥 / 端点 / 模型配置（CR-012 语义）。
//!
//! 移植自思考等级插件参考的数据结构与候选过滤规则（见 docs/tmp/ref-analysis-dsh-model-think-level.md）：
//! - 思考档位表 efforts：off/minimal/low/medium/high/xhigh/max -> wire 拼写，null=不下发参数
//! - 会话候选：供应商启用 + 至少一条启用密钥 + 一条协议匹配启用端点 + text 能力 + 非生图
//! - 密钥明文仅存受管文件（app_data_dir/secrets.json，0600 权限），DB 存掩码与引用

use crate::db;
use crate::models::{EffortMap, ModelCandidate, ModelConfig, Provider, ProviderEndpoint, ProviderKey, now_ms, new_id};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 受管密钥存储（本地文件，仅本机使用）。
fn secrets_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let _ = app;
    let dir = crate::storage_layout::category("secrets")?;
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
        return if chars.len() < 2 { "****".into() } else { format!("{}****{}", chars[0], chars[chars.len()-1]) };
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}****{}", head, tail)
}

// ---------- 查询 ----------

pub(crate) fn load_providers_inner(conn: &rusqlite::Connection) -> Result<Vec<Provider>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, protocol, disabled, headersJson, fingerprintJson, apiMode, sortOrder FROM provider ORDER BY sortOrder, createdAt, id")
        .map_err(|e| e.to_string())?;
    let mut providers: Vec<Provider> = stmt
        .query_map([], |r| {
            Ok(Provider {
                id: r.get(0)?,
                name: r.get(1)?,
                protocol: r.get(2)?,
                api_mode: r.get::<_, String>(6).map(|m| if m.is_empty() { if r.get::<_, String>(2).unwrap_or_default() == "anthropic" { "Anthropic".into() } else { "Chat".into() } } else { m })?,
                sort_order: r.get(7)?,
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
    #[serde(default)]
    pub create_id: Option<String>,
    #[serde(default)]
    pub api_mode: Option<String>,
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
    if draft.id.is_some() && draft.create_id.is_some() { return Err("创建ID与更新身份不能同时指定".into()); }
    let mode = draft.api_mode.as_deref().unwrap_or(if draft.protocol == "anthropic" { "Anthropic" } else { "Chat" });
    if !matches!(mode, "Chat" | "Responses" | "Anthropic") || (mode == "Anthropic") != (draft.protocol == "anthropic") {
        return Err("默认协议与端点类型不一致".into());
    }
    if draft.name.trim().is_empty() {
        return Err("供应商名称不能为空".into());
    }
    if draft.protocol != "anthropic" && draft.protocol != "openai" {
        return Err("协议必须是 anthropic 或 openai".into());
    }
    for m in &draft.models { validate_draft(m)?; }
    let mut endpoint_wires = BTreeSet::new();
    for e in draft.endpoints.iter().filter(|e| !e.base_url.trim().is_empty()) {
        if !endpoint_wires.insert(&e.protocol) { return Err("同一协议只能配置一个端点".into()); }
        models_url(&e.base_url)?;
        if e.protocol != "anthropic" && e.protocol != "openai" {
            return Err("端点协议必须是 anthropic 或 openai".into());
        }
    }
    let now = now_ms();
    let pid = draft.id.clone().or_else(|| draft.create_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(str::to_string)).unwrap_or_else(|| new_id("prov"));
    if draft.id.is_none() && (pid.len() > 128 || !pid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        return Err("供应商ID仅允许字母、数字、短横线、下划线和点，最多128字符".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if draft.id.is_none() && tx.query_row("SELECT COUNT(*) FROM provider WHERE id=?1", [&pid], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? != 0 {
        return Err("供应商 ID 已存在".into());
    }
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
    tx.execute("UPDATE provider SET apiMode=?2 WHERE id=?1", rusqlite::params![pid, mode]).map_err(|e| e.to_string())?;
    if draft.id.is_none() {
        tx.execute("UPDATE provider SET sortOrder=(SELECT COALESCE(MAX(sortOrder),-1)+1 FROM provider WHERE id<>?1) WHERE id=?1", [&pid]).map_err(|e| e.to_string())?;
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
                None => return Err("新密钥不能为空".into()),
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
    for e in draft.endpoints.iter().filter(|e| !e.base_url.trim().is_empty()) {
        let eid = e.id.clone().unwrap_or_else(|| new_id("ep"));
        tx.execute(
            "INSERT INTO provider_endpoint (id, providerId, protocol, baseUrl, enabled, createdAt) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![eid, pid, e.protocol, e.base_url.trim(), 1_i64, now],
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

fn key_secret_ref(conn: &rusqlite::Connection, provider_id: &str, key_id: &str) -> Result<String, String> {
    conn.query_row("SELECT secretRef FROM provider_key WHERE providerId=?1 AND id=?2",
        rusqlite::params![provider_id, key_id], |r| r.get(0)).map_err(|_| "密钥不存在或不属于该供应商".into())
}

/// 仅响应用户主动编辑/复制；列表、日志和提示中均不返回明文。
#[tauri::command]
pub fn provider_key_reveal(app: tauri::AppHandle, provider_id: String, key_id: String) -> Result<String, String> {
    let reference = {
        let guard = db::conn()?;
        key_secret_ref(guard.as_ref().ok_or("db not initialized")?, &provider_id, &key_id)?
    };
    secrets_read(&app)?.get(&reference).cloned().ok_or("密钥值不可读取".into())
}

/// 独立事务只写顺序；完整唯一集合防止跨供应商、遗漏或部分更新。
fn reorder_inner(conn: &rusqlite::Connection, provider_id: Option<&str>, ids: &[String]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let sql = if provider_id.is_some() { "SELECT id FROM model WHERE providerId=?1" } else { "SELECT id FROM provider" };
    let expected: BTreeSet<String> = {
        let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params_from_iter(provider_id.into_iter()), |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    if let Some(pid) = provider_id {
        if tx.query_row("SELECT COUNT(*) FROM provider WHERE id=?1", [pid], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? != 1 {
            return Err("供应商不存在".into());
        }
    }
    let supplied: BTreeSet<String> = ids.iter().cloned().collect();
    if supplied.len() != ids.len() || supplied != expected { return Err("排序必须包含完整且唯一的当前ID集合，请刷新后重试".into()); }
    for (index, id) in ids.iter().enumerate() {
        if let Some(pid) = provider_id {
            tx.execute("UPDATE model SET sortOrder=?3 WHERE providerId=?1 AND id=?2", rusqlite::params![pid, id, index as i64])
        } else {
            tx.execute("UPDATE provider SET sortOrder=?2 WHERE id=?1", rusqlite::params![id, index as i64])
        }.map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_reorder(ids: Vec<String>) -> Result<(), String> {
    let guard = db::conn()?;
    reorder_inner(guard.as_ref().ok_or("db not initialized")?, None, &ids)
}

#[tauri::command]
pub fn provider_models_reorder(provider_id: String, ids: Vec<String>) -> Result<(), String> {
    let guard = db::conn()?;
    reorder_inner(guard.as_ref().ok_or("db not initialized")?, Some(&provider_id), &ids)
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
    Ok(crate::commands::model_route::model_candidates_from(&providers))
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
        let (text, vision, image_gen) = modality_signal(row);
        let thinking = reasoning_signal(row);
        // 只透传已归一化能力，不把上游任意字段带回前端。
        out.push(serde_json::json!({ "id": id, "modelId": id, "displayName": display, "display_name": display,
            "contextWindow": null, "text": text, "vision": vision, "imageGen": image_gen,
            "supports_reasoning": thinking, "thinking": thinking }));
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

/// 模型发现不等待额外能力查询；明确上游信号归一化保留，未知不猜。
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
    pub text: Option<bool>,
    pub vision: Option<bool>,
    pub image_gen: Option<bool>,
    pub modality_source: Option<String>,
}

fn modality_signal(row: &serde_json::Value) -> (Option<bool>, Option<bool>, Option<bool>) {
    let flag = |names: &[&str]| names.iter().find_map(|name| row.get(*name).and_then(|v| v.as_bool())
        .or_else(|| row.get("capabilities").and_then(|c| c.get(*name)).and_then(|v| v.as_bool())));
    let array = |key: &str| row.get(key).or_else(|| row.get("architecture").and_then(|v| v.get(key)))
        .and_then(|v| v.as_array()).filter(|a| !a.is_empty() && a.iter().all(|v| v.is_string()));
    let has = |items: Option<&Vec<serde_json::Value>>, kind: &str| items.map(|a| a.iter().any(|v| v.as_str() == Some(kind)));
    (flag(&["text", "supports_text"]).or_else(|| has(array("input_modalities"), "text")),
     flag(&["vision", "supports_vision"]).or_else(|| has(array("input_modalities"), "image")),
     flag(&["imageGen", "image_gen", "supports_image_generation"]).or_else(|| has(array("output_modalities"), "image")))
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
        let (text, vision, image_gen) = row.map(modality_signal).unwrap_or((None, None, None));
        let modality_source = if text.is_some() || vision.is_some() || image_gen.is_some() { Some("vendor".to_string()) } else { None };
        if signal == Some(false) {
            return EffortResolution {
                model_id: model_id.clone(), efforts: EffortMap::new(), default_effort: None,
                context_window: None, max_tokens: None, source: "vendor".into(),
                note: Some("上游明确声明不支持推理".into()), text, vision, image_gen, modality_source,
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
                note: entry.note.map(str::to_string), text, vision, image_gen, modality_source,
            };
        }
        if signal == Some(true) {
            return EffortResolution {
                model_id: model_id.clone(), efforts: generic_ladder(), default_effort: None,
                context_window: None, max_tokens: None, source: "vendor".into(),
                note: Some("上游确认支持推理，使用通用阶梯（中置信），请核实下发拼写".into()), text, vision, image_gen, modality_source,
            };
        }
        EffortResolution {
            model_id: model_id.clone(), efforts: EffortMap::new(), default_effort: None,
            context_window: None, max_tokens: None, source: "none".into(),
            note: Some("供应商与内置知识库均未提供可信档位，请手动配置".into()), text, vision, image_gen, modality_source,
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
    use crate::commands::model_route::{model_candidates_from, resolve_for_cli};

    fn database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,createdAt INTEGER,updatedAt INTEGER,apiMode TEXT NOT NULL DEFAULT '',sortOrder INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE provider_key(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,alias TEXT,secretRef TEXT,masked TEXT,enabled INTEGER,createdAt INTEGER,protocol TEXT NOT NULL DEFAULT '',modelsJson TEXT,scopeSource TEXT,probedAt INTEGER);
            CREATE TABLE provider_endpoint(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,protocol TEXT,baseUrl TEXT,enabled INTEGER,createdAt INTEGER);
            CREATE TABLE model(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,modelId TEXT,displayName TEXT,text INTEGER,vision INTEGER,imageGen INTEGER,effortsJson TEXT,defaultEffort TEXT,contextWindow INTEGER,maxTokens INTEGER,sortOrder INTEGER NOT NULL DEFAULT 0,createdAt INTEGER,UNIQUE(providerId,modelId));
            INSERT INTO provider(id,name,protocol,disabled,headersJson,createdAt,updatedAt) VALUES('p1','one','openai',0,NULL,1,1),('p2','two','openai',0,NULL,1,1);
            INSERT INTO provider_key VALUES('key-one','p1',NULL,'custom-ref','masked',1,1,'','[]',NULL,NULL),('key-two','p2',NULL,'key-two','other-mask',1,1,'','[]',NULL,NULL);").unwrap();
        conn
    }

    fn draft(secret: Option<&str>) -> ProviderDraft {
        ProviderDraft { create_id: None, api_mode: None, id: Some("p1".into()), name: "updated".into(), protocol: "openai".into(), disabled: false,
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

    #[test]
    fn cr085_creation_identity_rejects_duplicates_and_missing_updates() {
        let conn = database();
        let mut secrets = BTreeMap::new();
        let mut d = draft(None); d.id = None; d.create_id = Some("p1".into()); d.keys.clear();
        assert!(save_provider_inner(&conn, d, &mut secrets, |_| panic!("must not write")).unwrap_err().contains("已存在"));
        let mut d = draft(None); d.id = Some("missing".into()); d.keys.clear();
        assert!(save_provider_inner(&conn, d, &mut secrets, |_| panic!("must not write")).unwrap_err().contains("不存在"));
        let mut d = draft(None); d.create_id = Some("another".into());
        assert!(save_provider_inner(&conn, d, &mut secrets, |_| panic!("must not write")).is_err());
        for mode in ["Chat", "Responses"] {
            let mut d = draft(None); d.id = None; d.create_id = Some(format!("custom-{mode}")); d.api_mode = Some(mode.into()); d.keys.clear();
            let id = save_provider_inner(&conn, d, &mut secrets, |_| Ok(())).unwrap();
            assert_eq!(conn.query_row("SELECT apiMode FROM provider WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), mode);
        }
        let mut d = draft(None); d.id = None; d.keys.clear();
        assert!(save_provider_inner(&conn, d, &mut secrets, |_| Ok(())).unwrap().starts_with("prov"));
        assert_eq!(conn.query_row("SELECT name FROM provider WHERE id='p1'", [], |r| r.get::<_, String>(0)).unwrap(), "one");
    }

    #[test]
    fn cr085_endpoint_content_enables_and_blank_is_omitted() {
        let conn = database();
        let mut d = draft(None);
        d.endpoints = vec![EndpointDraft { id: None, protocol: "openai".into(), base_url: "https://demo.invalid/v1".into(), enabled: false },
            EndpointDraft { id: None, protocol: "anthropic".into(), base_url: " ".into(), enabled: true }];
        save_provider_inner(&conn, d, &mut BTreeMap::new(), |_| Ok(())).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM provider_endpoint", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT enabled FROM provider_endpoint", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let mut d = draft(None);
        d.endpoints = (0..2).map(|_| EndpointDraft { id: None, protocol: "openai".into(), base_url: "https://demo.invalid".into(), enabled: true }).collect();
        assert!(save_provider_inner(&conn, d, &mut BTreeMap::new(), |_| panic!("must not write")).is_err());
    }

    #[test]
    fn cr085_key_reveal_checks_owner_and_short_mask_never_exposes_full_value() {
        let conn = database();
        assert_eq!(key_secret_ref(&conn, "p1", "key-one").unwrap(), "custom-ref");
        assert!(key_secret_ref(&conn, "p1", "key-two").is_err());
        assert!(key_secret_ref(&conn, "missing", "key-one").is_err());
        assert_eq!(mask_secret("ab"), "a****b");
        assert_eq!(mask_secret("a"), "****");
        assert_eq!(mask_secret("demo-not-real-key-tail"), "demo****tail");
    }

    #[test]
    fn cr085_sort_validates_complete_unique_sets_and_rolls_back_partial_failure() {
        let conn = route_database();
        insert_provider(&conn, "p1", "openai", false); insert_provider(&conn, "p2", "openai", false);
        insert_model(&conn, "m1", "p1", "one", true, false); insert_model(&conn, "m2", "p1", "two", true, false);
        insert_model(&conn, "foreign", "p2", "three", true, false);
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        reorder_inner(&conn, None, &ids(&["p2", "p1"])).unwrap();
        assert_eq!(load_providers_inner(&conn).unwrap()[0].id, "p2");
        assert!(reorder_inner(&conn, None, &ids(&["p1", "p1"])).is_err());
        assert!(reorder_inner(&conn, None, &ids(&["p1"])).is_err());
        assert!(reorder_inner(&conn, Some("p1"), &ids(&["m1", "foreign"])).is_err());
        reorder_inner(&conn, Some("p1"), &ids(&["m2", "m1"])).unwrap();
        assert_eq!(load_providers_inner(&conn).unwrap()[1].models[0].id, "m2");
        conn.execute_batch("CREATE TRIGGER reject_order BEFORE UPDATE OF sortOrder ON model WHEN NEW.id='m2' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
        assert!(reorder_inner(&conn, Some("p1"), &ids(&["m1", "m2"])).is_err());
        assert_eq!(load_providers_inner(&conn).unwrap()[1].models[0].id, "m2");
    }

    #[test]
    fn cr085_discovery_preserves_trusted_signals_and_never_infers_from_name() {
        let rows = parse_discovered_models(br#"{"data":[{"id":"unknown-vision-thinking"},{"id":"explicit","supports_reasoning":true,"input_modalities":["text","image"],"output_modalities":["text"],"secret":"must-not-return"}]}"#).unwrap();
        assert!(rows[0]["vision"].is_null());
        assert!(rows[1].get("secret").is_none());
        let hits = resolve_efforts(&["unknown-vision-thinking".into(), "explicit".into()], &rows);
        assert_eq!(hits[0].modality_source, None); assert!(hits[0].efforts.is_empty());
        assert_eq!((hits[1].text, hits[1].vision, hits[1].image_gen), (Some(true), Some(true), Some(false)));
        assert_eq!(hits[1].modality_source.as_deref(), Some("vendor")); assert!(!hits[1].efforts.is_empty());
    }
    /// CR-068 J06：路由回归使用独立内存库，secretRef 只写不可执行占位，测试绝不读取凭据。
    fn route_database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE provider(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,disabled INTEGER,headersJson TEXT,fingerprintJson TEXT,createdAt INTEGER,updatedAt INTEGER,apiMode TEXT NOT NULL DEFAULT '',sortOrder INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE provider_key(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,alias TEXT,secretRef TEXT,masked TEXT,enabled INTEGER,createdAt INTEGER,protocol TEXT NOT NULL DEFAULT '',modelsJson TEXT,scopeSource TEXT,probedAt INTEGER);
            CREATE TABLE provider_endpoint(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,protocol TEXT,baseUrl TEXT,enabled INTEGER,createdAt INTEGER);
            CREATE TABLE model(id TEXT PRIMARY KEY,providerId TEXT REFERENCES provider(id) ON DELETE CASCADE,modelId TEXT,displayName TEXT,text INTEGER,vision INTEGER,imageGen INTEGER,effortsJson TEXT,defaultEffort TEXT,contextWindow INTEGER,maxTokens INTEGER,sortOrder INTEGER NOT NULL DEFAULT 0,createdAt INTEGER,UNIQUE(providerId,modelId));")
            .unwrap();
        conn
    }

    fn insert_provider(conn: &rusqlite::Connection, id: &str, protocol: &str, disabled: bool) {
        conn.execute(
            "INSERT INTO provider (id,name,protocol,disabled,headersJson,createdAt,updatedAt) VALUES(?1,?2,?3,?4,NULL,1,1)",
            rusqlite::params![id, format!("provider-{id}"), protocol, disabled as i64],
        ).unwrap();
    }

    fn insert_endpoint(conn: &rusqlite::Connection, id: &str, provider_id: &str, protocol: &str, url: &str, enabled: bool, created_at: i64) {
        conn.execute(
            "INSERT INTO provider_endpoint VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id, provider_id, protocol, url, enabled as i64, created_at],
        ).unwrap();
    }

    fn insert_key(conn: &rusqlite::Connection, id: &str, provider_id: &str, enabled: bool, protocol: &str, models_json: Option<&str>, created_at: i64) {
        let reference = format!("unexecutable-secret-{id}");
        conn.execute(
            "INSERT INTO provider_key (id,providerId,alias,secretRef,masked,enabled,protocol,modelsJson,scopeSource,probedAt,createdAt)
             VALUES(?1,?2,NULL,?3,'masked',?4,?5,?6,NULL,NULL,?7)",
            rusqlite::params![id, provider_id, reference, enabled as i64, protocol, models_json, created_at],
        ).unwrap();
    }

    fn insert_model(conn: &rusqlite::Connection, row_id: &str, provider_id: &str, model_id: &str, text: bool, image_gen: bool) {
        conn.execute(
            "INSERT INTO model VALUES(?1,?2,?3,?3,?4,0,?5,'{}',NULL,NULL,NULL,0,1)",
            rusqlite::params![row_id, provider_id, model_id, text as i64, image_gen as i64],
        ).unwrap();
    }

    #[test]
    fn cr068_dual_protocol_routes_by_cli_not_provider_default() {
        let conn = route_database();
        insert_provider(&conn, "p-dual", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-dual", "openai", "https://openai.example/v1", true, 1);
        insert_endpoint(&conn, "e-anthropic", "p-dual", "anthropic", "https://anthropic.example", true, 2);
        // 显式 Anthropic 密钥先插入，旧实现会先取它并错误拒绝 Codex/Grok。
        insert_key(&conn, "k-anthropic", "p-dual", true, "Anthropic", Some("[]"), 1);
        insert_key(&conn, "k-openai", "p-dual", true, "", None, 2);
        insert_model(&conn, "row-1", "p-dual", "remote-model", true, false);

        let providers = load_providers_inner(&conn).unwrap();
        let candidates = model_candidates_from(&providers);
        let protocols: Vec<&str> = candidates.iter().map(|candidate| candidate.protocol.as_str()).collect();
        assert_eq!(protocols, vec!["openai", "anthropic"], "默认协议在前，另一兼容协议各一条");
        assert!(candidates.iter().all(|candidate| candidate.model_id == "remote-model" && candidate.model_row_id == "row-1"));

        let claude = resolve_for_cli(&providers, "p-dual", "claude", "remote-model").unwrap();
        assert_eq!((claude.protocol, claude.endpoint.id.as_str(), claude.key.id.as_str()), ("anthropic", "e-anthropic", "k-anthropic"));
        let codex = resolve_for_cli(&providers, "p-dual", "codex", "remote-model").unwrap();
        assert_eq!((codex.protocol, codex.endpoint.id.as_str(), codex.key.id.as_str()), ("openai", "e-openai", "k-openai"));
        let grok = resolve_for_cli(&providers, "p-dual", "grok", "remote-model").unwrap();
        assert_eq!((grok.protocol, grok.endpoint.id.as_str(), grok.key.id.as_str()), ("openai", "e-openai", "k-openai"));
    }

    #[test]
    fn cr068_candidate_and_dispatch_resolver_agree_per_protocol() {
        let conn = route_database();
        insert_provider(&conn, "p-agree", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-agree", "openai", "https://openai.example/v1", true, 1);
        insert_endpoint(&conn, "e-anthropic", "p-agree", "anthropic", "https://anthropic.example", true, 2);
        insert_key(&conn, "k-anthropic", "p-agree", true, "Anthropic", Some("[\"remote-model\"]"), 1);
        insert_key(&conn, "k-openai", "p-agree", true, "Responses", Some("[\"remote-model\"]"), 2);
        insert_model(&conn, "row-1", "p-agree", "remote-model", true, false);

        let providers = load_providers_inner(&conn).unwrap();
        let candidates = model_candidates_from(&providers);
        assert_eq!(candidates.len(), 2);
        for candidate in candidates {
            let cli = if candidate.protocol == "anthropic" { "claude" } else { "codex" };
            let route = resolve_for_cli(&providers, "p-agree", cli, &candidate.model_id).unwrap();
            assert_eq!(route.protocol, candidate.protocol);
            assert_eq!(route.endpoint.protocol, candidate.protocol);
            assert!(route.key.enabled);
            assert!(route.key.models.is_empty() || route.key.models.iter().any(|id| id == &candidate.model_id));
        }
    }

    #[test]
    fn cr068_empty_key_protocol_inherits_provider_and_never_crosses() {
        let conn = route_database();
        insert_provider(&conn, "p-anth", "anthropic", false);
        insert_endpoint(&conn, "e-anthropic", "p-anth", "anthropic", "https://anthropic.example", true, 1);
        insert_endpoint(&conn, "e-openai", "p-anth", "openai", "https://openai.example/v1", true, 2);
        insert_key(&conn, "k-default", "p-anth", true, "", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-anth", "remote-model", true, false);

        let providers = load_providers_inner(&conn).unwrap();
        let candidates = model_candidates_from(&providers);
        let protocols: Vec<&str> = candidates.iter().map(|candidate| candidate.protocol.as_str()).collect();
        assert_eq!(protocols, vec!["anthropic"], "空协议密钥只继承 Anthropic，不产生 OpenAI 候选");
        let claude = resolve_for_cli(&providers, "p-anth", "claude", "remote-model").unwrap();
        assert_eq!((claude.protocol, claude.endpoint.id.as_str(), claude.key.id.as_str()), ("anthropic", "e-anthropic", "k-default"));
        let codex = resolve_for_cli(&providers, "p-anth", "codex", "remote-model").unwrap_err();
        assert!(codex.contains("openai"), "应明确缺少 OpenAI 密钥：{codex}");
    }

    #[test]
    fn cr068_single_protocol_rejects_opposite_cli() {
        let conn = route_database();
        insert_provider(&conn, "p-openai", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-openai", "openai", "https://openai.example/v1", true, 1);
        insert_key(&conn, "k-openai", "p-openai", true, "Chat", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-openai", "remote-model", true, false);

        let providers = load_providers_inner(&conn).unwrap();
        assert_eq!(model_candidates_from(&providers).len(), 1);
        let err = resolve_for_cli(&providers, "p-openai", "claude", "remote-model").unwrap_err();
        assert!(err.contains("anthropic 端点"), "Claude 必须明确缺少 Anthropic 端点：{err}");
        assert!(resolve_for_cli(&providers, "p-openai", "codex", "remote-model").is_ok());
    }

    #[test]
    fn cr068_disabled_or_blank_endpoint_rejected() {
        let conn = route_database();
        insert_provider(&conn, "p-endpoint", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-endpoint", "openai", "https://openai.example/v1", false, 1);
        insert_key(&conn, "k-openai", "p-endpoint", true, "", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-endpoint", "remote-model", true, false);
        let providers = load_providers_inner(&conn).unwrap();

        assert!(resolve_for_cli(&providers, "p-endpoint", "codex", "remote-model").unwrap_err().contains("openai 端点"));
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE provider_endpoint SET enabled=1, baseUrl='   ' WHERE id='e-openai'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-endpoint", "codex", "remote-model").unwrap_err().contains("openai 端点"));
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE provider_endpoint SET baseUrl='https://openai.example/v1' WHERE id='e-openai'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-endpoint", "codex", "remote-model").is_ok());
        assert_eq!(model_candidates_from(&providers).len(), 1);
    }

    #[test]
    fn cr068_key_enabled_protocol_and_scope_gate_eligibility() {
        let conn = route_database();
        insert_provider(&conn, "p-key", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-key", "openai", "https://openai.example/v1", true, 1);
        insert_key(&conn, "k-main", "p-key", false, "", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-key", "remote-model", true, false);
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-key", "codex", "remote-model").is_err(), "停用密钥不得参与路由");
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE provider_key SET enabled=1, modelsJson='[\"other-model\"]' WHERE id='k-main'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-key", "codex", "remote-model").is_err(), "模型不在密钥范围必须拒绝");
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE provider_key SET modelsJson=NULL WHERE id='k-main'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-key", "codex", "remote-model").is_ok(), "NULL 范围等价全部模型");

        conn.execute("UPDATE provider_key SET protocol='Anthropic' WHERE id='k-main'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-key", "codex", "remote-model").is_err(), "密钥协议不符必须拒绝");

        conn.execute("UPDATE provider_key SET protocol='OpenAI' WHERE id='k-main'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-key", "codex", "remote-model").is_err(), "非约定协议值不得按名称猜测");
    }

    #[test]
    fn cr068_model_must_be_remote_text_non_image() {
        let conn = route_database();
        insert_provider(&conn, "p-model", "openai", false);
        insert_endpoint(&conn, "e-openai", "p-model", "openai", "https://openai.example/v1", true, 1);
        insert_key(&conn, "k-main", "p-model", true, "", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-model", "remote-model", false, false);
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-model", "codex", "remote-model").unwrap_err().contains("不支持文本"));
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE model SET text=1, imageGen=1 WHERE id='row-1'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-model", "codex", "remote-model").unwrap_err().contains("生图"));
        assert!(model_candidates_from(&providers).is_empty());

        conn.execute("UPDATE model SET imageGen=0 WHERE id='row-1'", []).unwrap();
        let providers = load_providers_inner(&conn).unwrap();
        assert!(resolve_for_cli(&providers, "p-model", "codex", "row-1").is_err(), "会话传入行 ID 必须拒绝，不能误当远端模型 ID");
        assert!(resolve_for_cli(&providers, "p-model", "codex", "remote-model").is_ok());
    }

    #[test]
    fn cr068_disabled_or_missing_provider_rejected() {
        let conn = route_database();
        insert_provider(&conn, "p-disabled", "openai", true);
        insert_endpoint(&conn, "e-openai", "p-disabled", "openai", "https://openai.example/v1", true, 1);
        insert_key(&conn, "k-main", "p-disabled", true, "", Some("[]"), 1);
        insert_model(&conn, "row-1", "p-disabled", "remote-model", true, false);
        let providers = load_providers_inner(&conn).unwrap();

        assert!(model_candidates_from(&providers).is_empty());
        assert!(resolve_for_cli(&providers, "p-disabled", "codex", "remote-model").unwrap_err().contains("已停用"));
        assert!(resolve_for_cli(&providers, "p-missing", "codex", "remote-model").unwrap_err().contains("不存在"));
    }
}
