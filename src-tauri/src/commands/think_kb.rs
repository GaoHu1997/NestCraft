//! CR-059 B2：内置模型思考等级知识库（87 条）。
//!
//! 数据来源：MIT 许可的开源实现 dsh-model-think-level v2.6.7 的 `src/knowledge.ts`
//! （Copyright (c) 2026 GaoHu1997，MIT License）。按其许可证要求保留版权与来源声明；
//! 仅抽取匹配模式、档位→wire 拼写、默认档位、容量与生图标记，不含其插件运行逻辑。
//! 由 `scripts/gen-think-kb.mjs` 生成，请勿手改；上游更新后重新生成并复核。

/// 知识库条目：模式按小写宽松匹配（非字母数字折叠为空格、字母数字边界），最长命中优先。
pub struct Entry {
    pub id: &'static str,
    pub patterns: &'static [&'static str],
    /// (档位, wire 拼写)；None 表示该档位不下发参数。
    pub efforts: &'static [(&'static str, Option<&'static str>)],
    pub default_effort: Option<&'static str>,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
    pub image_gen: bool,
    pub note: Option<&'static str>,
}

pub const KNOWLEDGE: &[Entry] = &[
    Entry { id: "deepseek-v4-vision", patterns: &["deepseek-v4-flash-vision", "deepseek-v4-vision"], efforts: &[("off", Some("none")), ("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("high"), context_window: Some(1048576), max_tokens: Some(384000), image_gen: false, note: Some("DeepSeek 视觉实验版 id（deepseek-v4-flash-vision-exp）。官方目录已标注该模型退役，名字仍被接受、由现行 deepseek-flash 提供服务——图片输入现已由 deepseek-flash 原生提供") },
    Entry { id: "deepseek-v4-1-flash", patterns: &["deepseek-v4.1-flash", "deepseek-flash"], efforts: &[("off", Some("none")), ("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("high"), context_window: Some(1048576), max_tokens: Some(384000), image_gen: false, note: Some("DeepSeek-V4.1-Flash（2026-09-10 发布的现行官方模型，官方 id 为 deepseek-flash；25 万并发、**原生图片输入**）。V4.1 的各写法（deepseek-flash、deepseek-v4.") },
    Entry { id: "deepseek-v4", patterns: &["deepseek-v4"], efforts: &[("off", Some("none")), ("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("high"), context_window: Some(1048576), max_tokens: Some(384000), image_gen: false, note: Some("DeepSeek 官方枚举 Low / High / Max（默认 High；minimal、medium、xhigh 兼容映射，ultra→max），Off 即 thinking:\"disabled\"（Responses API 下 of") },
    Entry { id: "deepseek-v3", patterns: &["deepseek-v3", "deepseek-chat"], efforts: &[("off", Some("none")), ("high", Some("high")), ("max", Some("max"))], default_effort: None, context_window: Some(163840), max_tokens: Some(65536), image_gen: false, note: Some("DeepSeek V3 档位：Off / High / Max。官方已停售 V3 代（定价页仅剩 V4 三型），容量取目录现役值。") },
    Entry { id: "deepseek-r1", patterns: &["deepseek-r1", "deepseek-reasoner"], efforts: &[("high", Some("high"))], default_effort: Some("high"), context_window: Some(163840), max_tokens: Some(32768), image_gen: false, note: Some("DeepSeek-R1 为推理模型，仅提供 High。官方已下架 R1 代，容量取目录 r1-0528 值。") },
    Entry { id: "openai-gpt-5-2", patterns: &["gpt-5.2"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("off"), context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.2 档位：None / Low / Medium / High / XHigh（默认 None）。官方另支持 PDF 输入（核心词表暂不含）。gpt-5.2-pro 官方页未单列档位行，按本条目同档处理；gpt-5.2-code") },
    Entry { id: "openai-gpt-5-2-codex", patterns: &["gpt-5.2-codex"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("medium"), context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.2-Codex 档位：Low / Medium / High / XHigh（无 None 档，勿勾 Off），带图输入、400K。") },
    Entry { id: "openai-gpt-5-6", patterns: &["gpt-5.6"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: Some("medium"), context_window: Some(272000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.6（别名即 sol）档位：None / Low / Medium(默认) / High / XHigh / Max；sol/luna/terra 同档，带图输入。2026-10 校准：上下文按 pi-ai 1.2.0 目录记 2") },
    Entry { id: "openai-gpt-5-5", patterns: &["gpt-5.5"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("medium"), context_window: Some(272000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.5 档位：None / Low / Medium(默认) / High / XHigh（无 Max 档），带图输入。pro 变体仅 High(默认) / XHigh、1.05M 上下文且仅 Responses API。2026-") },
    Entry { id: "openai-gpt-5-4", patterns: &["gpt-5.4"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("off"), context_window: Some(272000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.4 档位：None(默认) / Low / Medium / High / XHigh，带图输入。pro 变体仅 Medium/High/XHigh（1.05M）；mini/nano 为 400K 上下文。2026-10 校准：") },
    Entry { id: "openai-gpt-5-3", patterns: &["gpt-5.3"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("medium"), context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.3-Codex 档位：None / Low / Medium(默认) / High / XHigh，带图输入、400K；2026-10 校准：None 档按 pi-ai 1.2.0 目录补回（此前按旧模型页记为无 None）。g") },
    Entry { id: "openai-gpt-5-1", patterns: &["gpt-5.1"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("off"), context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.1 档位：None / Low / Medium / High（默认 None）。") },
    Entry { id: "openai-gpt-5-1-codex", patterns: &["gpt-5.1-codex"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.1-Codex 系列：官方模型页未单列 effort 值域，按同代保守档 Low / Medium / High（无 None；xhigh 未证实）。如端点支持 xhigh/none 可手调。") },
    Entry { id: "openai-gpt-5", patterns: &["gpt-5"], efforts: &[("minimal", Some("minimal")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("medium"), context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5 初代档位：Minimal / Low / Medium / High，无关闭档。") },
    Entry { id: "openai-gpt-5-2-chat", patterns: &["gpt-5.2-chat"], efforts: &[("off", None), ("medium", Some("medium")), ("xhigh", Some("xhigh"))], default_effort: None, context_window: Some(128000), max_tokens: Some(16384), image_gen: false, note: Some("GPT-5.2-Chat（官方 id gpt-5.2-chat-latest）：pi-ai 1.2.0 目录记为推理模型，仅 Medium / XHigh 两档（off 以省略表达，非显式关闭），128K / 16,384 输出。2026-") },
    Entry { id: "openai-chat", patterns: &["gpt-5.1-chat-latest", "gpt-5.3-chat-latest", "gpt-5-chat-latest", "gpt-chat-latest", "gpt-5-chat", "gpt-5.1-chat", "gpt-5.3-chat"], efforts: &[], default_effort: None, context_window: Some(128000), max_tokens: Some(16384), image_gen: false, note: Some("-chat 系列（官方 id 为 gpt-5.x-chat-latest）为非推理聊天模型，不支持 effort 参数（勿勾思考档）；官方支持图片输入，128K / 16,384 输出。gpt-5-chat-latest 已于 2026-0") },
    Entry { id: "openai-o", patterns: &["o1", "o3", "o4"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("medium"), context_window: Some(200000), max_tokens: Some(100000), image_gen: false, note: Some("OpenAI o 系档位：Low / Medium / High。官方已于 2026-06 公告退役（o1/o1-pro/o3-mini/o4-mini 2026-10-23 移除、o3/o3-pro 2026-12-11），网关残留仍可命") },
    Entry { id: "openai-gpt-oss", patterns: &["gpt-oss"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("low"), context_window: Some(131072), max_tokens: Some(131072), image_gen: false, note: Some("GPT-OSS 开源权重（Ollama/vLLM 常见）：reasoning effort Low / Medium / High，纯文本，131K 上下文 / 131K 输出。2026-09 复核：官方模型页现在写 Chat Comple") },
    Entry { id: "openai-gpt-6", patterns: &["gpt-6-luna", "gpt-6-sol", "gpt-6-terra", "gpt-6.1"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(272000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-6 系（luna/sol/terra，2026-10 校准新增）：pi-ai 1.2.0 目录全档 None / Low / Medium / High / XHigh / Max，带图输入，272,000 上下文 / 128,00") },
    Entry { id: "openai-gpt-6-astra", patterns: &["gpt-6-astra", "gpt-6", "gpt-6.1-sol"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(272000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-6 Astra 档位：Low / Medium / High / XHigh / Max——**没有 None 档**（官方原文：设为 none 返回 HTTP 400），因此本条目不声明 Off。带图输入；2026-10 校准：上") },
    Entry { id: "openai-gpt-daybreak", patterns: &["gpt-daybreak"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(1050000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-Daybreak（blue-latest 1.05M / red-latest 400K，2026-10 新增）：pi-ai 1.2.0 目录全档 None / Low / Medium / High / XHigh / Max，带") },
    Entry { id: "openai-gpt-realtime", patterns: &["gpt-realtime"], efforts: &[("minimal", Some("minimal")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: None, context_window: Some(128000), max_tokens: Some(32000), image_gen: false, note: Some("GPT-Realtime 2.1（2026-10 新增）：pi-ai 1.2.0 目录档位 Minimal / Low / Medium / High / XHigh（off 以省略表达），128,000 上下文 / 32,000 输出。") },
    Entry { id: "openai-gpt-5-6-cyber", patterns: &["gpt-5.6-cyber"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: None, context_window: Some(400000), max_tokens: Some(128000), image_gen: false, note: Some("GPT-5.6-Cyber：官方模型页未单列 effort 值域（不等于不支持），故按同代保守档 Low / Medium / High / XHigh；该型号仅 Responses API，带图输入、400K 上下文。官方支持的其他档位可") },
    Entry { id: "openai-gpt-4o", patterns: &["gpt-4o"], efforts: &[], default_effort: None, context_window: Some(128000), max_tokens: Some(16384), image_gen: false, note: Some("GPT-4o 代际：非推理模型，不支持 effort 参数（勿勾思考档）；图片输入全系标配，128K / 16,384 输出。") },
    Entry { id: "openai-gpt-4-1", patterns: &["gpt-4.1"], efforts: &[], default_effort: None, context_window: Some(1047576), max_tokens: Some(32768), image_gen: false, note: Some("GPT-4.1 全系（含 mini/nano）：非推理模型，不支持 effort 参数；官方 1,047,576 上下文 / 32,768 输出，全系带图输入。") },
    Entry { id: "openai-gpt-4-turbo-preview", patterns: &["gpt-4-turbo-preview"], efforts: &[], default_effort: None, context_window: Some(128000), max_tokens: Some(4096), image_gen: false, note: Some("GPT-4 Turbo Preview：非推理模型，纯文本输入（正式 turbo 快照支持图片，见下条），128K。") },
    Entry { id: "openai-gpt-4-turbo", patterns: &["gpt-4-turbo"], efforts: &[], default_effort: None, context_window: Some(128000), max_tokens: Some(4096), image_gen: false, note: Some("GPT-4 Turbo：非推理模型，官方支持图片输入，128K / 4,096 输出。") },
    Entry { id: "openai-gpt", patterns: &["gpt-4", "gpt-3.5"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("GPT-4/3.5 代际：非推理模型，不支持 effort 参数（勿勾思考档）。gpt-4-turbo/4.1 起支持图片，见单独条目；新代请用 GPT-5 系（见 openai-chat/gpt-5.x 条目）。") },
    Entry { id: "anthropic-claude-5-5", patterns: &["claude-haiku-5.5", "claude-opus-5-5", "claude-sonnet-5-5", "haiku-5.5", "claude-5-5"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: Some("high"), context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude 5.5 代（Haiku 5.5 / Opus 5.5 / Sonnet 5.5）：pi-ai 1.2.0 官方目录全档 Low / Medium / High(默认) / XHigh / Max，自适应思考，1M 上下文 / ") },
    Entry { id: "anthropic-claude-5", patterns: &["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5"], efforts: &[("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude 5 代（Fable 5 / Mythos 5 / Opus 5 / Sonnet 5）：2026-10 校准——pi-ai 1.2.0 官方目录已收紧为 XHigh / Max（low/medium/high 档已从该代 ef") },
    Entry { id: "anthropic-claude-5-1", patterns: &["claude-fable-5-1", "claude-mythos-5-1"], efforts: &[("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude Fable 5.1 / Mythos 5.1：2026-10 校准——pi-ai 1.2.0 目录档位 XHigh / Max（off 以省略表达），自适应思考常开（不接受 enabled/disabled）。1M 上下文 /") },
    Entry { id: "anthropic-claude-mythos-preview", patterns: &["claude-mythos-preview"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("high"), context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude Mythos Preview：官方档位 Low / Medium / High / Max（无 XHigh），1M 上下文。pi-ai 1.2.0 目录无 mythos 条目，本档位沿用官方 effort 矩阵。") },
    Entry { id: "anthropic-claude-opus-4-high", patterns: &["claude-opus-4-8", "claude-opus-4-7"], efforts: &[("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: None, context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude Opus 4.7/4.8：2026-10 校准——pi-ai 1.2.0 官方目录档位仅 XHigh / Max（low/medium/high 已从该代目录移除；xhigh 为官方推荐的编码起步档）。1M 上下文。") },
    Entry { id: "anthropic-claude-4-6", patterns: &["claude-opus-4-6", "claude-sonnet-4-6"], efforts: &[("max", Some("max"))], default_effort: None, context_window: Some(1000000), max_tokens: Some(128000), image_gen: false, note: Some("Claude 4.6 代（Opus 4.6 / Sonnet 4.6）：2026-10 校准——pi-ai 1.2.0 官方目录仅剩 Max 一档（low/medium/high/xhigh 均已从目录移除）。1M 上下文。") },
    Entry { id: "anthropic-claude-opus-4-5", patterns: &["claude-opus-4-5"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(200000), max_tokens: Some(64000), image_gen: false, note: Some("Claude Opus 4.5：官方 effort 支持列表（20251101 快照），档位 Low / Medium / High（无 XHigh/Max），可与 budget_tokens 并用；200K / 64K。") },
    Entry { id: "anthropic-claude", patterns: &["claude"], efforts: &[], default_effort: None, context_window: Some(200000), max_tokens: Some(64000), image_gen: false, note: Some("Claude 3.x 与 Sonnet 4.5 / Haiku 4.5：官方 effort 参数不支持（仅 5.5/5/5.1 代、Opus 4.5/4.6/4.7/4.8、Sonnet 4.6 支持），思考由 thinking.type ") },
    Entry { id: "google-gemini", patterns: &["gemini"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(65536), image_gen: false, note: Some("Gemini 通用安全档：Low / Medium / High（官方 OpenAI 兼容映射表另收 minimal：2.5 系映射为 1,024 预算、3.1 Flash-Lite/3 Flash 原生 minimal、3.1 Pro 落") },
    Entry { id: "google-gemma-4", patterns: &["gemma-4"], efforts: &[("off", None), ("minimal", Some("MINIMAL")), ("high", Some("HIGH"))], default_effort: None, context_window: Some(262144), max_tokens: Some(32768), image_gen: false, note: Some("Gemma 4（26b/31b-it）：三档 Minimal / High（档位线为官方大写枚举拼写），off 以省略表达；Low/Medium 不被接受。带图输入，262,144 / 32,768（2026-10 校准新增）。") },
    Entry { id: "xai-grok-4-7", patterns: &["grok-4.7"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: None, context_window: Some(500000), max_tokens: Some(500000), image_gen: false, note: Some("Grok 4.7：档位 Low / Medium / High / XHigh，思考不可关闭（off 仅以省略表达）；带图输入，500K 上下文 / 500K 输出（2026-10 校准：pi-ai 1.2.0 官方目录确认档位与容量，\"上") },
    Entry { id: "xai-grok-high", patterns: &["grok-4.6"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: Some("high"), context_window: Some(500000), max_tokens: None, image_gen: false, note: Some("Grok 4.6 档位：Low / Medium / High(默认) / XHigh，思考不可关闭；带图输入、500K 上下文。Grok 4.7 见上一条（此前记为\"不存在\"，已随发布作废）。") },
    Entry { id: "xai-grok-4-5", patterns: &["grok-4.5"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(500000), max_tokens: None, image_gen: false, note: Some("Grok 4.5 档位：Low / Medium / High(默认)，思考不可关闭；带图输入。传入 xhigh 会被官方静默按 High 处理。") },
    Entry { id: "xai-grok-4-3", patterns: &["grok-4.3"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("low"), context_window: Some(1000000), max_tokens: Some(30000), image_gen: false, note: Some("Grok 4.3：官方四级 reasoning effort（None / Low(默认) / Medium / High），1M 上下文 / 30,000 输出（2026-10 校准：XHigh 档按 pi-ai 1.2.0 目录移除——") },
    Entry { id: "xai-grok", patterns: &["grok"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("Grok 通用档位：Low / Medium / High。初代 grok-4、grok-4.20 与 grok-build-0.1 不接受该参数（grok-4 系与 grok-3 已于 2026-05-15 退役并重定向至 4.3）；gr") },
    Entry { id: "mistral-magistral", patterns: &["magistral"], efforts: &[("off", Some("none")), ("high", Some("high"))], default_effort: Some("off"), context_window: Some(262144), max_tokens: Some(16384), image_gen: false, note: Some("Magistral（magistral-medium-latest）：2026-10 校准——pi-ai 1.2.0 目录显示现役 magistral 走 mistral-conversations 协议并接受 effort（None / ") },
    Entry { id: "mistral-medium-3", patterns: &["mistral-medium-3.5", "mistral-large-4", "mistral-medium-2604", "mistral-medium-latest", "mistral-small-latest", "mistral-small-2603"], efforts: &[("off", Some("none")), ("high", Some("high"))], default_effort: Some("off"), context_window: None, max_tokens: None, image_gen: false, note: Some("Mistral 现役推理档（2026-10 扩充）：None / High 两档，官方 reasoning_effort 枚举即 none/high；现役型号 mistral-large-4（1M）、mistral-medium-3.5（2") },
    Entry { id: "mistral-legacy", patterns: &["mistral-large-2411", "mistral-large-latest", "mistral-large-2512", "mistral-medium-2505", "mistral-medium-2508", "mistral-small-2506", "mistral-nemo", "devstral", "ministral", "codestral", "pixtral", "voxtral"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("Mistral 非推理线（2026-10 新增条目）：large-2411/2512/latest、medium-2505/2508、small-2506、nemo 及 devstral/ministral/codestral/pixtra") },
    Entry { id: "qwen-vision", patterns: &["qwen-vl", "qwen2-vl", "qwen2-5-vl", "qwen3-vl", "qvq"], efforts: &[("off", None), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(131072), max_tokens: Some(8192), image_gen: false, note: Some("通义视觉线（Qwen-VL/QvQ）：enable_thinking 开关（开=High），收图。qwen3-vl 容量更大，按需上调。") },
    Entry { id: "qwen-3-8", patterns: &["qwen3.8"], efforts: &[("off", None), ("low", Some("low")), ("medium", Some("medium")), ("xhigh", Some("xhigh"))], default_effort: Some("xhigh"), context_window: Some(1000000), max_tokens: None, image_gen: false, note: Some("Qwen 3.8 系：官方 reasoning_effort 档位 XHigh(默认) / Medium / Low，thinking 默认开、可按请求关闭；原生多模态（qwen3.8-max 图像/视频理解，视频未入核心词表）。1M 档上") },
    Entry { id: "qwen-3-8-27b", patterns: &["qwen3.8-27b"], efforts: &[("off", None), ("low", Some("low")), ("medium", Some("medium")), ("xhigh", Some("xhigh"))], default_effort: Some("xhigh"), context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("Qwen3.8-27B（dense，2026-08-14 开源）：官方 reasoning_effort 档位 XHigh(默认) / Medium / Low，thinking 默认开、可按请求关；原生图像+视频理解（视频未入核心词表）。") },
    Entry { id: "qwen-3-8-flash-next", patterns: &["qwen3.8-flash-next"], efforts: &[("off", None), ("low", Some("low")), ("medium", Some("medium")), ("xhigh", Some("xhigh"))], default_effort: Some("xhigh"), context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("Qwen3.8-Flash-Next（125B-A6B 实验架构，Qwen4 前身）：官方 reasoning_effort 档位 XHigh(默认) / Medium / Low + enable_thinking 开关；原生视觉（Vis") },
    Entry { id: "qwen", patterns: &["qwen", "qwq"], efforts: &[("off", None), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(1000000), max_tokens: Some(65536), image_gen: false, note: Some("通义千问：enable_thinking 开关（无 effort 档），开=High；现役旗舰为 qwen3.8 系（1M 档上下文，见 qwen-3-8 条目）。3.6/3.7 代的 Plus/Flash 亦默认多模态（图片/视频），如接") },
    Entry { id: "glm-vision", patterns: &["glm-4v", "glm-4-6v", "glm-4-5v", "glm-5v"], efforts: &[("off", None), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(131072), max_tokens: Some(32768), image_gen: false, note: Some("智谱视觉线（GLM-4V/4.5V/4.6V/5V）：thinking 开关（开=High），收图。GLM-4.5V 为强制思考（传 disabled 报错，请手动删 Off 档）。") },
    Entry { id: "glm-5-3-flash", patterns: &["glm-5.3-flash", "glm-5.3-flashx"], efforts: &[("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("max"), context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("GLM-5.3-Flash（320B，官方文档 vlm 分类）：强制思考（thinking.type 仅 enabled，不支持关闭），文本参数与 GLM-5.3 一致——档位 Low / High / Max。输入模态：视频、图像、文本、") },
    Entry { id: "glm-5-3", patterns: &["glm-5.3"], efforts: &[("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("max"), context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("GLM-5.3 档位：Low / High / Max（强制思考，其余值报错）。官方容量 1M / 128K。") },
    Entry { id: "glm-5-2", patterns: &["glm-5.2"], efforts: &[("off", Some("none")), ("minimal", Some("minimal")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: Some("max"), context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("GLM-5.2 档位：None / Minimal / Low / Medium / High / XHigh / Max（官方映射：Low·Medium→High、XHigh→Max、None·Minimal=停止思考）。视觉线见 glm") },
    Entry { id: "glm", patterns: &["glm", "zhipu", "chatglm"], efforts: &[("off", None), ("high", Some("high"))], default_effort: Some("high"), context_window: None, max_tokens: None, image_gen: false, note: Some("GLM 通用：thinking 开关（无 effort 档），开=High；effort 阶梯仅 GLM-5.2+ 支持（见上两条目）。注意 GLM-4.7/GLM-4.5V 为强制思考，传 disabled 会报错（请手动删 Off 档）") },
    Entry { id: "kimi-k3", patterns: &["kimi-k3"], efforts: &[("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: Some("max"), context_window: Some(1048576), max_tokens: None, image_gen: false, note: Some("Kimi K3 档位：Low / High / Max(默认 Max)，走顶层 reasoning_effort；始终推理、勿传 thinking 对象。原生视觉理解，1M 上下文（最大输出官方未单独列，不提供）。") },
    Entry { id: "kimi-k2-vision", patterns: &["kimi-k2.6", "kimi-k2.5"], efforts: &[("off", None), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("Kimi K2.5/K2.6 视觉代：thinking.type 开关（默认开、可关），开=High；带视觉，256K。K2.7 Code 始终思考，见单独条目。") },
    Entry { id: "kimi-k27-code", patterns: &["kimi-k2.7"], efforts: &[("high", Some("high"))], default_effort: Some("high"), context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("Kimi K2.7 Code（含高速版）：始终思考——thinking.type 仅接受 enabled（传 disabled 报错），无 Off 档；带视觉，256K。") },
    Entry { id: "kimi-for-coding", patterns: &["kimi-for-coding"], efforts: &[("low", Some("low")), ("high", Some("high")), ("max", Some("max"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(32768), image_gen: false, note: Some("Kimi for Coding：Moonshot 编码专线走 anthropic-messages 协议、自适应思考，档位 Low / High / Max（off 以省略表达）；带图输入，1M 上下文 / 32,768 输出。高速版（-h") },
    Entry { id: "kimi-moonshot-v1-vision", patterns: &["moonshot-v1-8k-vision", "moonshot-v1-32k-vision", "moonshot-v1-128k-vision"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("Moonshot V1 视觉旧代（8k/32k/128k 各一）：无思考控件（生成模型）、支持图片输入；该线已停止对新用户开放（2026-08-31 全量下线，网关残留仍可命中）。") },
    Entry { id: "kimi", patterns: &["kimi", "moonshot"], efforts: &[("off", None), ("high", Some("high"))], default_effort: None, context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("Kimi 通用：thinking 开关（无 effort 档），开=High。k2 系列 2026-05-25 下线、kimi-latest 2026-01-28 下线、moonshot-v1 系 2026-08-31 全量下线（网关残留仍") },
    Entry { id: "hunyuan-hy3", patterns: &["hy3"], efforts: &[("low", Some("low")), ("high", Some("high"))], default_effort: None, context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("混元 hy3：开源契约经 chat_template_kwargs.reasoning_effort = no_think(默认)/low/high；官方模型卡 256K 上下文（295B MoE，2026 开源）。") },
    Entry { id: "hunyuan-hy4", patterns: &["hy4-preview", "hy-4-preview"], efforts: &[("off", Some("no_think")), ("high", Some("high"))], default_effort: Some("high"), context_window: Some(1000000), max_tokens: None, image_gen: false, note: Some("混元 Hy4 preview：官方 README——reasoning 默认 high（深度思考），关闭经 chat_template_kwargs.reasoning_effort=no_think；官方规格表 1M 上下文（770B-A") },
    Entry { id: "step-5-preview", patterns: &["step-5"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("medium"), context_window: Some(1000000), max_tokens: Some(65536), image_gen: false, note: Some("阶跃 Step-5-Preview（官方 id 即 step-5-preview，无裸 step-5；pattern 取家族主干以兼容网关写法）：档位 Low / Medium(官方标\"默认推荐\") / High，思考不可关闭；原生图片 +") },
    Entry { id: "step-3-7", patterns: &["step-3.7", "step-3.6"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("medium"), context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("阶跃 Step-3.6/3.7 档位：Low / Medium(默认推荐) / High，原生图片+视频理解。上下文为输入+输出总和上限。") },
    Entry { id: "step-3-5", patterns: &["step-3.5"], efforts: &[("low", Some("low")), ("high", Some("high"))], default_effort: None, context_window: Some(262144), max_tokens: None, image_gen: false, note: Some("阶跃 Step-3.5 Flash 档位：Low / High（纯文本推理旗舰）。上下文为输入+输出总和上限。") },
    Entry { id: "step", patterns: &["step-3", "step-2"], efforts: &[("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: Some("medium"), context_window: None, max_tokens: None, image_gen: false, note: Some("阶跃 Step 档位：Low / Medium / High（默认 Medium，不可关闭）。3.6/3.7 视觉代见单独条目。") },
    Entry { id: "doubao", patterns: &["doubao", "seed"], efforts: &[("off", None), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("豆包档位：Off / Low / Medium / High——effort 阶梯仍是社区证据、官方 Ark 文档明列的为 thinking.type 开关（2026-08-24 复核仍未见到 effort 官方明文）。seed 代收图（1") },
    Entry { id: "minimax-m2", patterns: &["minimax-m2"], efforts: &[], default_effort: None, context_window: Some(204800), max_tokens: Some(131072), image_gen: false, note: Some("MiniMax-M2 / M2.5（含 -highspeed）：无思考控件、无 effort 参数（M3 才引入 thinking 参数），纯文本，204,800 / 131,072（2026-10 校准新增；M3 见下条）。") },
    Entry { id: "minimax-m3", patterns: &["minimax-m3"], efforts: &[("off", None), ("high", Some("high"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(512000), image_gen: false, note: Some("MiniMax-M3：官方 thinking 参数 enabled/adaptive/disabled（无 effort 档），开=High、关=disabled；原生多模态（图/视频，核心词表仅含图），1M 上下文 / 512,000 输") },
    Entry { id: "mimo-v2-6", patterns: &["mimo-v2.6", "mimo-v2.5"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("小米 MiMo v2.6 系列（mimo-v2.6-pro / -flash / -pro-ultraspeed；1M 上下文 / 128K 最大输出、原生全模态）与其前代 mimo-v2.5。官方文档：thinking.type（enab") },
    Entry { id: "mimo-v2-5-pro", patterns: &["mimo-v2.5-pro"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("小米 MiMo v2.5-Pro：该家族唯一的**纯文本**成员（官方能力表未列全模态理解），1M 上下文 / 128K 最大输出，推理契约与 v2.6 系列相同（thinking.type + reasoning.effort，none ") },
    Entry { id: "baidu-ernie", patterns: &["ernie"], efforts: &[], default_effort: None, context_window: Some(131072), max_tokens: None, image_gen: false, note: Some("百度千帆 ERNIE 系：官方 OpenAI 兼容接口无 reasoning_effort 参数——思考由模型变体决定（-Thinking 系列始终思考、普通系列不思考），勿勾思考档。ERNIE 4.5 Turbo VL 支持图片，按需手勾") },
    Entry { id: "fireworks-ember", patterns: &["ember-1"], efforts: &[("off", Some("none")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("max", Some("max"))], default_effort: None, context_window: Some(1048576), max_tokens: Some(131072), image_gen: false, note: Some("Fireworks ember-1：anthropic-messages 协议自适应思考，档位 None(关) / Low / Medium / High / Max（off 显式 none 拼写）；带图输入，1M 上下文 / 131,07") },
    Entry { id: "thinkingmachines-inkling", patterns: &["inkling"], efforts: &[("off", Some("none")), ("minimal", Some("minimal")), ("low", Some("low")), ("medium", Some("medium")), ("high", Some("high")), ("xhigh", Some("xhigh")), ("max", Some("max"))], default_effort: Some("medium"), context_window: Some(524288), max_tokens: Some(131072), image_gen: false, note: Some("Thinking Machines Inkling：全档 Minimal / Low / Medium(默认) / High / XHigh / Max，off 显式 none；带图输入，512K 上下文 / 131,072 输出（2026") },
    Entry { id: "antling-ring", patterns: &["ring-2.6"], efforts: &[("high", Some("high")), ("xhigh", Some("xhigh"))], default_effort: None, context_window: Some(262144), max_tokens: Some(65536), image_gen: false, note: Some("蚂蚁 Ling Ring-2.6-1T：档位 High / XHigh（off 以省略表达）；262,144 / 65,536（2026-10 校准新增）。") },
    Entry { id: "antling-ling", patterns: &["ling-2.6"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: false, note: Some("蚂蚁 Ling-2.6（含 -flash）：非思考模型，无 effort 控件（2026-10 校准新增；Ring-2.6 思考线见上条）。") },
    Entry { id: "openai-gpt-image", patterns: &["gpt-image", "dall-e", "dalle"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("OpenAI 生图系（gpt-image-1 / DALL·E 3）：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "google-imagen", patterns: &["imagen", "flash-image", "pro-image", "nano-banana"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("Google 生图系（Imagen / Gemini-Image \"nano banana\"）：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "black-forest-flux", patterns: &["flux"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("FLUX 系（FLUX.1 schnell/dev/pro 等）：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "stability-sd", patterns: &["stable-diffusion", "sdxl", "sd3"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("Stability 生图系（Stable Diffusion / SDXL / SD3）：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "zhipu-cogview", patterns: &["cogview"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("智谱 CogView 生图系：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "aliyun-wanx", patterns: &["wanx"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("阿里万相 Wanx 生图系：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "bytedance-seedream", patterns: &["seedream", "seededit"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("字节 Seedream / SeedEdit 生图系：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "qwen-image", patterns: &["qwen-image"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("通义千问 Qwen-Image 生图系：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
    Entry { id: "midjourney", patterns: &["midjourney", "niji"], efforts: &[], default_effort: None, context_window: None, max_tokens: None, image_gen: true, note: Some("Midjourney / Niji 生图系（中转常见）：图像生成模型，不能作为对话模型使用——在输入框模型切换列表中带「生图」标记展示。请勿勾思考档。") },
];

/// 宽松归一化：小写、非字母数字折叠为空格、字母后数字拆开（qwen3 → qwen 3）。
pub fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    let mut prev: Option<char> = None;
    for ch in value.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            // 仅在「字母 → 数字」的一次跨越处插入空格（qwen3 → qwen 3）；
            // 数字链内部（v4.1 中的 4→1）不再拆，保持 v4 1 形态。
            if let Some(p) = prev {
                if p.is_ascii_alphabetic() && c.is_ascii_digit() { out.push(' '); }
            }
            out.push(c);
            prev = Some(c);
        } else {
            if !out.ends_with(' ') { out.push(' '); }
            prev = None;
        }
    }
    out.trim().to_string()
}

/// 按模型 ID 与显示名匹配知识库；词边界 + 最长命中优先；未命中返回 None（不猜）。
pub fn match_entry(model_id: &str, display_name: &str) -> Option<&'static Entry> {
    let hay = format!("{} {}", normalize(model_id), normalize(display_name));
    let mut best: Option<(&'static Entry, usize)> = None;
    for entry in KNOWLEDGE {
        for pattern in entry.patterns {
            let needle = normalize(pattern);
            if needle.is_empty() { continue; }
            let mut from = 0;
            while let Some(at) = hay[from..].find(&needle) {
                let pos = from + at;
                let before = hay[..pos].chars().last();
                let after = hay[pos + needle.len()..].chars().next();
                let boundary = before.map(|c| !c.is_ascii_alphanumeric()).unwrap_or(true)
                    && after.map(|c| !c.is_ascii_alphanumeric()).unwrap_or(true);
                if boundary && best.map(|(_, len)| needle.len() > len).unwrap_or(true) {
                    best = Some((entry, needle.len()));
                }
                from = pos + needle.len();
            }
        }
    }
    best.map(|(entry, _)| entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_entries_match_known_models() {
        let entry = match_entry("deepseek-v4.1-flash", "DeepSeek V4.1 Flash").expect("应命中 DeepSeek 条目");
        assert!(entry.efforts.iter().any(|(level, _)| *level == "high"));
        assert_eq!(entry.context_window, Some(1_048_576));
        let gpt = match_entry("gpt-5.2", "GPT-5.2").expect("应命中 GPT-5.2");
        assert!(gpt.efforts.iter().any(|(level, _)| *level == "off"));
    }

    #[test]
    fn word_boundaries_prevent_false_hits() {
        // 'o1' 这类短模式不能命中无关模型名里的片段
        assert!(match_entry("ko1-local", "Ko1 Local").is_none());
        assert!(match_entry("totally-unknown-model", "Unknown").is_none());
    }

    #[test]
    fn image_gen_entries_are_marked_and_have_no_efforts() {
        let image = match_entry("gpt-image-1", "GPT Image").expect("生图系应命中");
        assert!(image.image_gen);
        assert!(image.efforts.is_empty(), "生图条目不应有思考档位");
    }

    #[test]
    fn normalize_splits_letters_and_digits_like_the_reference() {
        // 字母→数字跨界插空格（Qwen3 → qwen 3、v4 → v 4）；数字链与标点折叠为空格。
        assert_eq!(normalize("Qwen3-Max"), "qwen 3 max");
        assert_eq!(normalize("deepseek_v4.1"), "deepseek v 4 1");
        assert_eq!(normalize("gpt-5.2"), "gpt 5 2");
    }
}
