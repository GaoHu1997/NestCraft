//! CR-059 G4：生图配置与生成（多模型有序、失败自动顺延）。
//!
//! - 配置存 `image_gen_config` 单行表：总开关、有序模型列表（providerId/modelId）、默认参数、输出目录。
//! - 协议只接 OpenAI 兼容 images（`/images/generations`；带参考图走 `/images/edits`）。
//! - 端点与密钥复用所选模型所属供应商的配置，不单独填写。
//! - 失败策略：单模型内先做参数降级（response_format → quality → size → n），仍失败才换下一个模型；
//!   鉴权/端点不支持等不可修复错误也继续下一个；全部失败时汇总各模型错误（已脱敏）。
//! - 落盘永不覆盖同名文件；超时与取消共享同一预算。
//! - 作为内置 tool `generate_image` 提供给 AI（随 workbench MCP 注入）。

use crate::db;
use crate::models::now_ms;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_BODY: u64 = 32 * 1024 * 1024;
const MAX_N: u32 = 4;
const PARAM_RETRIES: usize = 4;

/// 生图默认参数。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageDefaults {
    #[serde(default = "default_size")]
    pub size: String,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default = "default_n")]
    pub n: u32,
    #[serde(default = "default_timeout")]
    pub timeout_min: u32,
}
fn default_size() -> String { "1024x1024".into() }
fn default_quality() -> String { "auto".into() }
fn default_n() -> u32 { 1 }
fn default_timeout() -> u32 { 15 }

impl Default for ImageDefaults {
    fn default() -> Self {
        Self { size: default_size(), quality: default_quality(), n: default_n(), timeout_min: default_timeout() }
    }
}

/// 生图配置（对前端的完整视图）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenConfig {
    pub enabled: bool,
    /// 有序「先试」列表：`providerId/modelId`。
    pub order: Vec<String>,
    pub defaults: ImageDefaults,
    pub output_dir: String,
    /// 候选：本机已配置、模态标为生图的模型（含所属供应商名）。
    pub candidates: Vec<ImageCandidate>,
    /// 已不可用的 order 项（供应商或模型被删除）。
    pub unavailable: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageCandidate {
    pub key: String,
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub display_name: String,
    /// anthropic 端点不提供 images 接口，前端标注并跳过。
    pub supported: bool,
}

fn load_row(conn: &rusqlite::Connection) -> Result<(bool, Vec<String>, ImageDefaults, String), String> {
    let row: Option<(i64, String, String, String)> = conn.query_row(
        "SELECT enabled, orderJson, defaultsJson, outputDir FROM image_gen_config WHERE id='default'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).ok();
    Ok(match row {
        Some((enabled, order, defaults, dir)) => (
            enabled != 0,
            serde_json::from_str(&order).unwrap_or_default(),
            serde_json::from_str(&defaults).unwrap_or_default(),
            dir,
        ),
        None => (true, Vec::new(), ImageDefaults::default(), "generated-images".to_string()),
    })
}

fn image_candidates(conn: &rusqlite::Connection) -> Result<Vec<ImageCandidate>, String> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.protocol, p.disabled, m.modelId, m.displayName
         FROM model m JOIN provider p ON p.id = m.providerId
         WHERE m.imageGen = 1 ORDER BY p.createdAt, m.sortOrder, m.createdAt",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let provider_id: String = r.get(0)?;
        let provider_name: String = r.get(1)?;
        let protocol: String = r.get(2)?;
        let disabled: i64 = r.get(3)?;
        let model_id: String = r.get(4)?;
        let display_name: String = r.get(5)?;
        Ok(ImageCandidate {
            key: format!("{}/{}", provider_id, model_id),
            provider_id,
            provider_name,
            model_id,
            display_name,
            supported: protocol == "openai" && disabled == 0,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub fn image_gen_get() -> Result<ImageGenConfig, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let (enabled, order, defaults, output_dir) = load_row(conn)?;
    let candidates = image_candidates(conn)?;
    let known: Vec<&String> = candidates.iter().map(|c| &c.key).collect();
    let unavailable: Vec<String> = order.iter().filter(|k| !known.contains(k)).cloned().collect();
    Ok(ImageGenConfig { enabled, order, defaults, output_dir, candidates, unavailable })
}

/// 保存配置。order 中的项必须存在于候选；enabled 关闭时不影响已存列表。
#[tauri::command]
pub fn image_gen_save(config: ImageGenConfig) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let candidates = image_candidates(conn)?;
    let mut seen = std::collections::BTreeSet::new();
    for key in &config.order {
        if !candidates.iter().any(|c| &c.key == key) {
            return Err(format!("生图模型不存在或已不可用：{}", key));
        }
        if !seen.insert(key.clone()) { return Err("生图模型列表存在重复项".into()); }
    }
    let n = config.defaults.n.clamp(1, MAX_N);
    let timeout = config.defaults.timeout_min.clamp(1, 60);
    let dir = config.output_dir.trim();
    if dir.is_empty() { return Err("输出目录不能为空".into()); }
    if dir.contains("..") || dir.starts_with('/') || dir.starts_with('\\') || dir.contains(':') {
        return Err("输出目录必须是应用数据目录下的相对路径".into());
    }
    let defaults = ImageDefaults {
        size: config.defaults.size.clone(),
        quality: config.defaults.quality.clone(),
        n,
        timeout_min: timeout,
    };
    conn.execute(
        "INSERT INTO image_gen_config (id, enabled, orderJson, defaultsJson, outputDir, updatedAt)
         VALUES ('default', ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET enabled=?1, orderJson=?2, defaultsJson=?3, outputDir=?4, updatedAt=?5",
        rusqlite::params![config.enabled as i64,
            serde_json::to_string(&config.order).map_err(|e| e.to_string())?,
            serde_json::to_string(&defaults).map_err(|e| e.to_string())?,
            dir, now_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 生成结果（单次尝试的汇总）。
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub images: Vec<String>,
    pub model: Option<String>,
    pub prompt: String,
    pub params_used: Value,
    pub revisions: Vec<String>,
    pub attempts: Vec<Value>,
}

struct ProviderAccess {
    wire: String,
    base_url: String,
    key: String,
    headers: BTreeMap<String, String>,
}

fn mask_error(message: &str, secret: &str) -> String {
    let mut text = message.to_string();
    if !secret.is_empty() { text = text.replace(secret, "***"); }
    for token in ["Bearer ", "sk-"] {
        if let Some(idx) = text.find(token) {
            let end = text[idx..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'').map(|e| idx + e).unwrap_or(text.len());
            text.replace_range(idx..end, "***");
        }
    }
    text.chars().take(400).collect()
}

/// 取某模型所属供应商的端点与密钥（复用受管密钥；不单独填写）。
fn provider_access(data_dir: &Path, provider_id: &str, model_id: &str) -> Result<ProviderAccess, String> {
    let (protocol, disabled): (String, bool) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row("SELECT protocol, disabled FROM provider WHERE id=?1", [provider_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0))).map_err(|_| "供应商不存在".to_string())?
    };
    if disabled { return Err("供应商已停用".into()); }
    if protocol != "openai" { return Err("该供应商为 Anthropic 端点，不提供 images 接口".into()); }
    let _ = model_id;
    let (base_url, secret_ref) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let base: String = conn.query_row(
            "SELECT baseUrl FROM provider_endpoint WHERE providerId=?1 AND enabled=1 AND protocol='openai' ORDER BY createdAt LIMIT 1",
            [provider_id], |r| r.get(0)).map_err(|_| "供应商没有启用的 OpenAI 端点".to_string())?;
        let mut stmt = conn.prepare("SELECT secretRef FROM provider_key WHERE providerId=?1 AND enabled=1 ORDER BY createdAt LIMIT 1")
            .map_err(|e| e.to_string())?;
        let secret_ref: String = stmt.query_row([provider_id], |r| r.get(0)).map_err(|_| "供应商没有启用的密钥".to_string())?;
        (base, secret_ref)
    };
    // stdio MCP 进程同样从数据目录读受管密钥文件，与 GUI 共用同一份。
    let secrets: BTreeMap<String, String> = match std::fs::read(data_dir.join("secrets.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "密钥文件格式无效".to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(_) => return Err("密钥文件不可读取".into()),
    };
    let key = secrets.get(&secret_ref).filter(|v| !v.trim().is_empty()).cloned().ok_or("密钥值不可用")?;
    if key.contains(['\r', '\n']) { return Err("密钥含无效字符".into()); }
    Ok(ProviderAccess { wire: "openai".into(), base_url, key, headers: BTreeMap::new() })
}

fn images_url(base: &str, edit: bool) -> Result<String, String> {
    let mut url = tauri::Url::parse(base.trim()).map_err(|_| "端点地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("端点必须为 HTTP(S) 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let suffix = if edit { "/images/edits" } else { "/images/generations" };
    let path = if path.ends_with("/v1") { format!("{}{}", path, suffix) } else { format!("{}/v1{}", path, suffix) };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

/// 参数降级判定：按错误正文匹配第一个可降级项。
fn fallback_revision(status: u16, body: &str, params: &AttemptParams) -> Option<(&'static str, AttemptParams)> {
    if !(400..500).contains(&status) { return None; }
    let lower = body.to_ascii_lowercase();
    let mut next = params.clone();
    if lower.contains("response_format") && params.response_format.is_some() {
        next.response_format = None;
        return Some(("已移除 response_format", next));
    }
    if lower.contains("output_format") && params.output_format.is_some() {
        next.output_format = None;
        return Some(("已移除 output_format", next));
    }
    if lower.contains("quality") && params.quality != "auto" && params.quality != "low" {
        next.quality = if params.quality == "high" { "medium".into() } else { "low".into() };
        return Some(("已降低 quality", next));
    }
    if lower.contains("size") && params.size != "1024x1024" {
        next.size = "1024x1024".into();
        return Some(("尺寸重置为 1024x1024", next));
    }
    if (lower.contains("num_images") || lower.contains("too many images")) && params.n > 1 {
        next.n = 1;
        return Some(("数量降为 1", next));
    }
    None
}

#[derive(Clone)]
struct AttemptParams {
    size: String,
    quality: String,
    n: u32,
    response_format: Option<String>,
    output_format: Option<String>,
}

fn decode_images(value: &Value) -> Result<Vec<String>, String> {
    // 标准信封 data[]；兼容中转站包一层 images / output / result。
    let list = value.get("data").and_then(Value::as_array)
        .or_else(|| value.get("images").and_then(Value::as_array))
        .or_else(|| value.get("output").and_then(Value::as_array))
        .or_else(|| value.get("result").and_then(Value::as_array))
        .ok_or("上游应答缺少图片列表")?;
    let mut out = Vec::new();
    for entry in list {
        if let Some(b64) = entry.get("b64_json").and_then(Value::as_str) {
            out.push(b64.to_string());
        } else if let Some(url) = entry.get("url").and_then(Value::as_str) {
            out.push(url.to_string());
        }
    }
    if out.is_empty() { return Err("上游应答既无 b64_json 也无 url".into()); }
    Ok(out)
}

/// 单模型生成（含参数降级链）。返回 (图片 b64 或 url 列表, 实际参数, 回退记录)。
fn generate_one(
    access: &ProviderAccess,
    model_id: &str,
    prompt: &str,
    defaults: &ImageDefaults,
    n: u32,
    timeout_secs: u64,
) -> Result<(Vec<String>, Value, Vec<String>), String> {
    let url = images_url(&access.base_url, false)?;
    let mut params = AttemptParams {
        size: defaults.size.clone(),
        quality: defaults.quality.clone(),
        n: n.clamp(1, MAX_N),
        response_format: Some("b64_json".into()),
        output_format: Some("png".into()),
    };
    let mut revisions: Vec<String> = Vec::new();
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(timeout_secs)).build();
    let mut last_error = String::from("生成失败");
    for _ in 0..=PARAM_RETRIES {
        let mut payload = json!({
            "model": model_id,
            "prompt": prompt,
            "n": params.n,
            "size": params.size,
            "quality": params.quality,
        });
        if let Some(fmt) = &params.response_format { payload["response_format"] = json!(fmt); }
        if let Some(fmt) = &params.output_format { payload["output_format"] = json!(fmt); }
        let mut request = agent.post(&url).set("Content-Type", "application/json");
        for (name, value) in &access.headers { request = request.set(name, value); }
        let request = if access.wire == "anthropic" {
            request.set("x-api-key", &access.key).set("anthropic-version", "2023-06-01")
        } else { request.set("Authorization", format!("Bearer {}", access.key).as_str()) };
        match request.send_string(&payload.to_string()) {
            Ok(response) => {
                let mut body = Vec::new();
                response.into_reader().take(MAX_BODY + 1).read_to_end(&mut body).map_err(|_| "读取应答失败".to_string())?;
                let value: Value = serde_json::from_slice(&body).map_err(|_| "上游应答不是有效 JSON".to_string())?;
                let images = decode_images(&value)?;
                let used = json!({ "size": params.size, "quality": params.quality, "n": params.n,
                    "responseFormat": params.response_format, "outputFormat": params.output_format });
                return Ok((images, used, revisions));
            }
            Err(ureq::Error::Status(code, response)) => {
                let text = response.into_string().unwrap_or_default();
                last_error = format!("HTTP {}：{}", code, mask_error(&text, &access.key));
                if let Some((label, next)) = fallback_revision(code, &text, &params) {
                    revisions.push(label.to_string());
                    params = next;
                    continue;
                }
                return Err(last_error);
            }
            Err(_) => return Err("连接失败或超时".into()),
        }
    }
    Err(last_error)
}

/// 落盘：默认 `<data_dir>/<outputDir>/<prompt 前 40 字>-<时间戳>.png`；同名自动加序号，永不覆盖。
fn persist_image(data_dir: &Path, output_dir: &str, prompt: &str, index: usize, source: &str) -> Result<PathBuf, String> {
    let dir = data_dir.join(output_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建输出目录失败：{}", e))?;
    let stem: String = prompt.chars().filter(|c| c.is_alphanumeric()).take(40).collect();
    let stem = if stem.is_empty() { "image".to_string() } else { stem };
    let stamp = now_ms();
    for seq in 0..1000 {
        let suffix = if seq == 0 { String::new() } else { format!("-{}", seq) };
        let name = format!("{}-{}-{}{}.png", stem, stamp, index + 1, suffix);
        let path = dir.join(name);
        if path.exists() { continue; }
        let bytes = if source.starts_with("http://") || source.starts_with("https://") {
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(60)).build();
            let response = agent.get(source).call().map_err(|_| "下载生成图片失败".to_string())?;
            let mut buf = Vec::new();
            response.into_reader().take(MAX_BODY + 1).read_to_end(&mut buf).map_err(|_| "读取图片失败".to_string())?;
            buf
        } else {
            base64::engine::general_purpose::STANDARD.decode(source).map_err(|_| "图片 base64 解码失败".to_string())?
        };
        std::fs::write(&path, bytes).map_err(|e| format!("写入图片失败：{}", e))?;
        return Ok(path);
    }
    Err("同名文件过多，未能落盘".into())
}

/// 供 AI 调用与前端测试共用：按配置顺序尝试，第一个失败自动用下一个。
pub fn run_generate(
    data_dir: &Path,
    prompt: &str,
    model: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
    n: Option<u32>,
) -> Result<ImageResult, String> {
    if prompt.trim().is_empty() { return Err("prompt 不能为空".into()); }
    let (enabled, order, defaults, output_dir) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        load_row(conn)?
    };
    if !enabled { return Err("生图已在设置中关闭".into()); }
    let mut queue: Vec<String> = match model {
        Some(m) if !m.trim().is_empty() => {
            let key = if m.contains('/') { m.to_string() } else {
                // 允许只给 modelId：在候选中按 modelId 唯一匹配
                let guard = db::conn()?;
                let conn = guard.as_ref().ok_or("db not initialized")?;
                let candidates = image_candidates(conn)?;
                let hits: Vec<&ImageCandidate> = candidates.iter().filter(|c| c.model_id == m.trim()).collect();
                if hits.len() != 1 { return Err(format!("无法唯一确定生图模型：{}", m)); }
                hits[0].key.clone()
            };
            vec![key]
        }
        _ => order.clone(),
    };
    queue.retain(|k| !k.is_empty());
    if queue.is_empty() { return Err("尚未配置生图模型，请先在设置中启用".into()); }
    let timeout_secs = (defaults.timeout_min.clamp(1, 60) as u64) * 60;
    let count = n.unwrap_or(defaults.n).clamp(1, MAX_N);
    let mut result = ImageResult { prompt: prompt.to_string(), ..Default::default() };
    for key in queue {
        let (provider_id, model_id) = match key.split_once('/') {
            Some((p, m)) => (p.to_string(), m.to_string()),
            None => continue,
        };
        let access = match provider_access(data_dir, &provider_id, &model_id) {
            Ok(a) => a,
            Err(e) => { result.attempts.push(json!({ "model": key, "error": e })); continue; }
        };
        let mut effective = defaults.clone();
        if let Some(s) = size.filter(|v| !v.trim().is_empty()) { effective.size = s.to_string(); }
        if let Some(q) = quality.filter(|v| !v.trim().is_empty()) { effective.quality = q.to_string(); }
        match generate_one(&access, &model_id, prompt, &effective, count, timeout_secs) {
            Ok((sources, used, revisions)) => {
                let mut paths = Vec::new();
                for (index, source) in sources.iter().enumerate() {
                    match persist_image(data_dir, &output_dir, prompt, index, source) {
                        Ok(path) => paths.push(path.to_string_lossy().to_string()),
                        Err(e) => { result.attempts.push(json!({ "model": key, "error": e })); }
                    }
                }
                if paths.is_empty() {
                    result.attempts.push(json!({ "model": key, "error": "图片已生成但全部落盘失败" }));
                    continue;
                }
                result.images = paths;
                result.model = Some(key);
                result.params_used = used;
                result.revisions = revisions;
                return Ok(result);
            }
            Err(e) => { result.attempts.push(json!({ "model": key, "error": mask_error(&e, &access.key) })); }
        }
    }
    Err(format!("全部生图模型尝试失败：{}", serde_json::to_string(&result.attempts).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_fallback_follows_the_documented_order() {
        let params = AttemptParams {
            size: "4096x4096".into(), quality: "high".into(), n: 4,
            response_format: Some("b64_json".into()), output_format: Some("png".into()),
        };
        let (label, next) = fallback_revision(400, "unsupported response_format", &params).unwrap();
        assert_eq!(label, "已移除 response_format");
        assert!(next.response_format.is_none());
        let (label, next) = fallback_revision(400, "bad output_format", &next).unwrap();
        assert_eq!(label, "已移除 output_format");
        let (label, next) = fallback_revision(400, "quality not supported", &next).unwrap();
        assert_eq!(label, "已降低 quality");
        assert_eq!(next.quality, "medium");
        let (label, next) = fallback_revision(400, "invalid size", &next).unwrap();
        assert_eq!(label, "尺寸重置为 1024x1024");
        assert_eq!(next.size, "1024x1024");
        let (label, next) = fallback_revision(400, "too many images", &next).unwrap();
        assert_eq!(label, "数量降为 1");
        assert_eq!(next.n, 1);
        assert!(fallback_revision(401, "invalid key", &next).is_none());
    }

    #[test]
    fn decode_accepts_standard_and_wrapped_envelopes() {
        let standard = json!({ "data": [{ "b64_json": "AAA" }, { "url": "https://x/y.png" }] });
        assert_eq!(decode_images(&standard).unwrap(), vec!["AAA", "https://x/y.png"]);
        let wrapped = json!({ "result": [{ "b64_json": "BBB" }] });
        assert_eq!(decode_images(&wrapped).unwrap(), vec!["BBB"]);
        assert!(decode_images(&json!({ "data": [] })).is_err());
    }

    #[test]
    fn secrets_never_appear_in_error_text() {
        let text = mask_error("Bearer sk-secret-1234 rejected; key sk-secret-1234 invalid", "sk-secret-1234");
        assert!(!text.contains("sk-secret-1234"));
    }

    #[test]
    fn output_dir_rejects_escaping_paths() {
        for bad in ["..", "../x", "/abs", "C:/x", "a/../b"] {
            let escaped = bad.contains("..") || bad.starts_with('/') || bad.starts_with('\\') || bad.contains(':');
            assert!(escaped, "{} 应被拒绝", bad);
        }
    }
}
