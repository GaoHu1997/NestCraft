// 从 MIT 参考实现生成 Rust 内置思考等级知识库（CR-059 B2）。
// 只抽取匹配与档位所需字段；输出保留来源与许可声明。
import fs from "node:fs";

const SRC = "docs/参考/repos/dsh-model-think-level/src/knowledge.ts";
const OUT = "src-tauri/src/commands/think_kb.rs";
const text = fs.readFileSync(SRC, "utf8");

const start = text.indexOf("export const KNOWLEDGE_BASE");
// 以行结构切分：条目为 `  {` … `  },`（顶层两空格缩进），数组以 `];` 结束。
const tail = text.slice(start);
const endMark = tail.indexOf("\n];");
const body = tail.slice(0, endMark === -1 ? tail.length : endMark);

const entries = [];
let buf = null;
for (const line of body.split(/\r?\n/)) {
  if (/^  \{\s*$/.test(line)) { buf = []; continue; }
  if (buf !== null) {
    if (/^  \},?\s*$/.test(line)) { entries.push(buf.join("\n")); buf = null; }
    else buf.push(line);
  }
}

const BACKSLASH = String.fromCharCode(92);
const DQUOTE = String.fromCharCode(34);
const esc = (s) => String(s).split(BACKSLASH).join(BACKSLASH + BACKSLASH).split(DQUOTE).join(BACKSLASH + DQUOTE);
const opt = (v) => (v === undefined || v === null || v === "" ? "None" : 'Some("' + esc(v) + '")');

const rows = [];
for (const raw of entries) {
  const id = /id:\s*'([^']+)'/.exec(raw)?.[1] ?? /id:\s*"([^"]+)"/.exec(raw)?.[1];
  const patternsRaw = /patterns:\s*\[([\s\S]*?)\]/.exec(raw)?.[1] ?? "";
  const patterns = [...patternsRaw.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]).filter(Boolean);
  if (!id || !patterns.length) continue;
  const effortsRaw = /efforts:\s*(\{[^}]*\}|false)/.exec(raw)?.[1] ?? "";
  const efforts = [];
  if (effortsRaw.startsWith("{")) {
    for (const m of effortsRaw.matchAll(/([a-zA-Z]+):\s*(null|'([^']*)'|"([^"]*)")/g)) {
      const level = m[1];
      const wire = m[2] === "null" ? null : (m[3] ?? m[4]);
      efforts.push([level, wire]);
    }
  }
  const defaultEffort = /defaultEffort:\s*'([^']+)'/.exec(raw)?.[1] ?? /defaultEffort:\s*"([^"]+)"/.exec(raw)?.[1];
  const contextWindow = /contextWindow:\s*([\d_]+)/.exec(raw)?.[1]?.replace(/_/g, "");
  const maxTokens = /maxTokens:\s*([\d_]+)/.exec(raw)?.[1]?.replace(/_/g, "");
  const imageGen = /imageGen:\s*true/.test(raw);
  const note = /note:\s*'([^']*)'/.exec(raw)?.[1] ?? /note:\s*"([^"]*)"/.exec(raw)?.[1];
  rows.push({ id, patterns, efforts, defaultEffort, contextWindow, maxTokens, imageGen, note });
}

const lines = rows.map(r => {
  const pats = r.patterns.map(p => '"' + esc(p) + '"').join(", ");
  const eff = r.efforts
    .map(([lv, w]) => w === null ? '("' + lv + '", None)' : '("' + lv + '", Some("' + esc(w) + '"))')
    .join(", ");
  const note = r.note ? r.note.slice(0, 120) : undefined;
  const ctx = r.contextWindow ? `Some(${r.contextWindow})` : "None";
  const maxTok = r.maxTokens ? `Some(${r.maxTokens})` : "None";
  return `    Entry { id: "${esc(r.id)}", patterns: &[${pats}], efforts: &[${eff}], default_effort: ${opt(r.defaultEffort)}, context_window: ${ctx}, max_tokens: ${maxTok}, image_gen: ${r.imageGen}, note: ${opt(note)} },`;
});

const out = `//! CR-059 B2：内置模型思考等级知识库（${rows.length} 条）。
//!
//! 数据来源：MIT 许可的开源实现 dsh-model-think-level v2.6.7 的 \`src/knowledge.ts\`
//! （Copyright (c) 2026 GaoHu1997，MIT License）。按其许可证要求保留版权与来源声明；
//! 仅抽取匹配模式、档位→wire 拼写、默认档位、容量与生图标记，不含其插件运行逻辑。
//! 由 \`scripts/gen-think-kb.mjs\` 生成，请勿手改；上游更新后重新生成并复核。

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
${lines.join("\n")}
];

/// 宽松归一化：小写、非字母数字折叠为空格、字母后数字拆开（qwen3 → qwen 3）。
pub fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    let mut prev_alnum = false;
    let mut prev_digit = false;
    for ch in value.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            if prev_alnum && !prev_digit && c.is_ascii_digit() { out.push(' '); }
            out.push(c);
            prev_alnum = true;
            prev_digit = c.is_ascii_digit();
        } else {
            if !out.ends_with(' ') { out.push(' '); }
            prev_alnum = false;
            prev_digit = false;
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
`;
fs.writeFileSync(OUT, out, "utf8");
console.log("entries:", rows.length, "->", OUT);
