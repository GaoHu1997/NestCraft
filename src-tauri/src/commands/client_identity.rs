//! CR-099：模拟客户端身份。
//!
//! 平台 runtime 请求第三方模型时，可选地按所选官方 CLI 的身份发出请求头，
//! 用于通过部分网关对客户端身份的检查。
//!
//! 严格边界（不可扩大）：
//! - 只设置**客户端身份标识类**请求头（user-agent、originator、x-app、anthropic-* 等）；
//! - **绝不**改写或伪造 `Authorization`、`x-api-key`、账号 id、组织 id、计费头；
//!   凭证始终来自用户自己配置的密钥；
//! - 只作用于平台 runtime 通道，不影响 CLI 会话自身的启动参数；
//! - 默认关闭；配置缺失或格式非法时按关闭处理，不阻断请求。

use serde_json::Value;

/// 身份预设。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClientIdentity {
    Codex,
    Claude,
}

impl ClientIdentity {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }
}

/// 从 `setting_default(scope=global, key='chat.clientIdentity')` 的原始值解析。
///
/// 返回 `None` 表示关闭或配置无效——两种情况都按「不模拟」处理。
pub(crate) fn resolve(raw: Option<&str>) -> Option<ClientIdentity> {
    let value: Value = serde_json::from_str(raw?.trim()).ok()?;
    if value.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    ClientIdentity::parse(value.get("preset").and_then(Value::as_str)?)
}

/// 该身份要追加的请求头。
///
/// 版本号取与官方 CLI 同形的稳定串；这些值只用于通过身份识别，不承载任何凭证。
pub(crate) fn headers(identity: ClientIdentity) -> Vec<(&'static str, String)> {
    match identity {
        ClientIdentity::Codex => vec![
            ("user-agent", "codex_cli_rs/0.55.0 (Windows 10; x86_64)".to_string()),
            ("originator", "codex_cli_rs".to_string()),
            ("x-codex-session-id", process_session_id()),
        ],
        ClientIdentity::Claude => vec![
            ("user-agent", "claude-cli/2.1.0 (external, cli)".to_string()),
            ("x-app", "cli".to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
            ("anthropic-beta", "claude-code-20250219".to_string()),
        ],
    }
}

/// 每进程固定的会话标识：同一进程内多次请求保持一致，像真实 CLI 那样。
fn process_session_id() -> String {
    use std::sync::OnceLock;
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        // 不引入随机数依赖：用进程 id 与启动时间构造稳定且不重复的串。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:x}{:x}", std::process::id(), nanos)
    })
    .clone()
}

/// 合并身份头到已有请求头：同名（忽略大小写）时**保留身份头**，
/// 因为身份识别依赖这些标记的一致性；但凭证类字段永不出现在这里。
pub(crate) fn merge(existing: &[(String, String)], identity_headers: Vec<(&'static str, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = existing.to_vec();
    for (name, value) in identity_headers {
        let lower = name.to_ascii_lowercase();
        // 安全兜底：即便调用方误传，也拒绝身份头覆盖凭证类字段。
        if matches!(lower.as_str(), "authorization" | "x-api-key" | "host" | "cookie" | "proxy-authorization") {
            continue;
        }
        if let Some(slot) = out.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(&lower)) {
            slot.1 = value;
        } else {
            out.push((name.to_string(), value));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_or_invalid_means_no_identity() {
        assert!(resolve(None).is_none());
        assert!(resolve(Some("")).is_none());
        assert!(resolve(Some("not json")).is_none());
        assert!(resolve(Some(r#"{"enabled":false,"preset":"codex"}"#)).is_none());
        assert!(resolve(Some(r#"{"enabled":true,"preset":"unknown"}"#)).is_none());
    }

    #[test]
    fn enabled_presets_resolve() {
        assert_eq!(resolve(Some(r#"{"enabled":true,"preset":"codex"}"#)), Some(ClientIdentity::Codex));
        assert_eq!(resolve(Some(r#"{"enabled":true,"preset":"claude"}"#)), Some(ClientIdentity::Claude));
    }

    #[test]
    fn headers_never_carry_credentials() {
        for id in [ClientIdentity::Codex, ClientIdentity::Claude] {
            for (name, value) in headers(id) {
                let lower = name.to_ascii_lowercase();
                assert_ne!(lower, "authorization");
                assert_ne!(lower, "x-api-key");
                assert!(!value.contains("Bearer"));
            }
        }
    }

    #[test]
    fn merge_replaces_same_name_and_keeps_others() {
        let existing = vec![
            ("X-Trace".to_string(), "1".to_string()),
            ("user-agent".to_string(), "generic-sdk/1.0".to_string()),
        ];
        let merged = merge(&existing, headers(ClientIdentity::Codex));
        assert!(merged.iter().any(|(n, _)| n == "X-Trace"));
        let ua = merged.iter().find(|(n, _)| n.eq_ignore_ascii_case("user-agent")).unwrap();
        assert!(ua.1.starts_with("codex_cli_rs/"));
        // 同名只保留一条
        assert_eq!(merged.iter().filter(|(n, _)| n.eq_ignore_ascii_case("user-agent")).count(), 1);
    }

    #[test]
    fn merge_refuses_to_override_credentials() {
        let existing = vec![("authorization".to_string(), "Bearer real".to_string())];
        let merged = merge(&existing, vec![("Authorization", "Bearer fake".to_string())]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].1, "Bearer real");
    }
}
