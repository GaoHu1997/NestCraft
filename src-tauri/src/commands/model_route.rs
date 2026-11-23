//! CR-068 J06：会话候选与派发共用的「有效协议」资格解析。
//!
//! 规则唯一来源：
//! - CLI 决定有效协议：claude → anthropic，codex/grok → openai；
//! - 供应商默认协议只代表默认偏好，不覆盖另一协议端点；
//! - 密钥协议为空时严格继承供应商默认协议；Chat/Responses → openai，Anthropic → anthropic；
//! - 端点必须启用、协议匹配且地址非空；
//! - 密钥必须启用、协议匹配，且 modelsJson 为空/未限定或包含该模型；
//! - 模型必须属于该供应商、支持文本且不是生图模型。
//!
//! 本模块不读取密钥文件，只做配置层资格判断。调用方仅在解析成功后读取 secretRef。

use crate::models::{ModelCandidate, ModelConfig, Provider, ProviderEndpoint, ProviderKey};

#[derive(Debug)]
pub(crate) struct ResolvedRoute<'a> {
    pub protocol: &'static str,
    pub endpoint: &'a ProviderEndpoint,
    pub key: &'a ProviderKey,
}

/// CLI 自身可执行的协议。未知 CLI 不做协议猜测。
pub(crate) fn cli_protocol(cli_id: &str) -> Result<&'static str, String> {
    match cli_id {
        "claude" => Ok("anthropic"),
        "codex" | "grok" => Ok("openai"),
        other => Err(format!("未知 CLI：{}", other)),
    }
}

/// 密钥自身协议；空值严格继承供应商默认协议，不跨协议复用。
fn key_protocol(key_protocol: &str, provider_protocol: &str) -> Option<&'static str> {
    match key_protocol {
        "" => match provider_protocol {
            "openai" => Some("openai"),
            "anthropic" => Some("anthropic"),
            _ => None,
        },
        "Chat" | "Responses" => Some("openai"),
        "Anthropic" => Some("anthropic"),
        _ => None,
    }
}

/// modelsJson 为空/未限定表示全部模型；非空必须精确包含远端模型 ID。
fn key_allows_model(key: &ProviderKey, model_id: &str) -> bool {
    key.models.is_empty() || key.models.iter().any(|m| m == model_id)
}

fn endpoint_for_protocol<'a>(provider: &'a Provider, protocol: &str) -> Option<&'a ProviderEndpoint> {
    provider.endpoints.iter().find(|endpoint| {
        endpoint.enabled
            && endpoint.protocol == protocol
            && !endpoint.base_url.trim().is_empty()
    })
}

fn key_for_protocol<'a>(
    provider: &'a Provider,
    protocol: &str,
    model_id: &str,
) -> Option<&'a ProviderKey> {
    provider.keys.iter().find(|key| {
        key.enabled
            && key_protocol(&key.protocol, &provider.protocol) == Some(protocol)
            && key_allows_model(key, model_id)
    })
}

fn candidate_protocol_order(provider_protocol: &str) -> [&'static str; 2] {
    match provider_protocol {
        "anthropic" => ["anthropic", "openai"],
        _ => ["openai", "anthropic"],
    }
}

/// 某模型在供应商配置下可用的协议；每个协议都要求端点与密钥同时合格。
pub(crate) fn candidate_protocols(
    provider: &Provider,
    model: &ModelConfig,
) -> Vec<&'static str> {
    if provider.disabled || !model.text || model.image_gen {
        return Vec::new();
    }
    candidate_protocol_order(&provider.protocol)
        .into_iter()
        .filter(|protocol| {
            endpoint_for_protocol(provider, protocol).is_some()
                && key_for_protocol(provider, protocol, &model.model_id).is_some()
        })
        .collect()
}

/// 候选清单：同一供应商模型可分别在兼容协议下各出一条候选。
pub(crate) fn model_candidates_from(providers: &[Provider]) -> Vec<ModelCandidate> {
    let mut candidates = Vec::new();
    for provider in providers.iter().filter(|provider| !provider.disabled) {
        for model in provider
            .models
            .iter()
            .filter(|model| model.text && !model.image_gen)
        {
            for protocol in candidate_protocols(provider, model) {
                candidates.push(ModelCandidate {
                    context_window: model.context_window,
                    default_effort: model.default_effort.clone(),
                    display_name: model.display_name.clone(),
                    efforts: model.efforts.clone(),
                    model_id: model.model_id.clone(),
                    max_tokens: model.max_tokens,
                    model_row_id: model.id.clone(),
                    provider_id: provider.id.clone(),
                    provider_name: provider.name.clone(),
                    protocol: protocol.to_string(),
                    vision: model.vision,
                });
            }
        }
    }
    candidates
}

/// 派发资格：按 CLI 有效协议解析唯一的端点与密钥。
///
/// `model_id` 是模型表中的远端模型 ID（会话/候选保存的 `modelId`），不是 `model.id` 行 ID。
pub(crate) fn resolve_for_cli<'a>(
    providers: &'a [Provider],
    provider_id: &str,
    cli_id: &str,
    model_id: &str,
) -> Result<ResolvedRoute<'a>, String> {
    let provider = providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| "会话绑定的供应商不存在（可能已被删除），请改选或修复设置".to_string())?;
    if provider.disabled {
        return Err(format!(
            "供应商「{}」已停用，请启用或改选",
            provider.name
        ));
    }

    let protocol = cli_protocol(cli_id)?;
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("会话未选择模型，无法解析供应商调用资格；请先选择模型".into());
    }
    let model = provider
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .ok_or_else(|| {
            format!(
                "模型「{}」不属于供应商「{}」，请改选模型或修复设置",
                model_id, provider.name
            )
        })?;
    if !model.text {
        return Err(format!(
            "模型「{}」不支持文本对话，不能用于 CLI 派发",
            model_id
        ));
    }
    if model.image_gen {
        return Err(format!(
            "模型「{}」是生图模型，不能用于 CLI 对话",
            model_id
        ));
    }

    let endpoint = endpoint_for_protocol(provider, protocol).ok_or_else(|| {
        format!(
            "供应商「{}」没有启用且地址非空的 {} 端点；CLI「{}」需要该协议",
            provider.name, protocol, cli_id
        )
    })?;
    let key = key_for_protocol(provider, protocol, model_id).ok_or_else(|| {
        format!(
            "供应商「{}」没有启用的 {} 密钥覆盖模型「{}」，请补充密钥或调整协议/模型范围",
            provider.name, protocol, model_id
        )
    })?;

    Ok(ResolvedRoute {
        protocol,
        endpoint,
        key,
    })
}
