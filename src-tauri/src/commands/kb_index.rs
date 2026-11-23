//! CR-030-D1：知识检索「切片 + SQLite FTS5，不引入向量」P0 实现。
//!
//! 唯一事实来源：docs/LLD/LLD-FEAT-008-本地知识索引与按需检索.md、
//! docs/DB/DB-FEAT-008-知识原件切片与全文索引.md（P0 最小表集见 LLD「P0 实现记录」）。
//! 本模块只提供派生索引能力：切片、词项、FTS 发布/退役、受限查询；不引入向量、
//! 不读原件做检索、不新增可见界面。
//!
//! P0 关键决策（与评审结论一致）：
//! - unicode61 不切中文，词项 hex 化是硬前提：四列存 `w<utf8hex>`（词）/`b<utf8hex>`（相邻二字组）
//!   的空格分隔 ASCII；索引与查询两侧必须同一 Rust 函数同一版本（tokenizerVersion 落库）。
//! - 每库一张 `kb_fts_l<partitionNo>`（partitionNo 由 kb_library_state 单调分配、宿主代码
//!   生成表名、绝不拼输入）；普通 FTS5 表（应用侧 INSERT 词项行，rowid=chunkKey，退役按
//!   rowid DELETE），不用 external content。
//! - P0 无中文词典：`w` 词项仅覆盖拉丁/数字/其它文字整词，中文靠 `b` 相邻二字组与单字
//!   受限扫描路径；词典分词延后并登记偏差。

use rusqlite::{Connection, OptionalExtension};

/// 索引与查询两侧必须同一 Rust 函数同一版本（tokenizerVersion 落库）。
pub const TOKENIZER_VERSION: &str = "local-utf8-v2";
/// 目标块大小（UTF-8 bytes）。
pub const CHUNK_TARGET_BYTES: usize = 2048;
/// 单块硬顶（UTF-8 bytes）。
pub const CHUNK_HARD_CAP_BYTES: usize = 4096;
/// 片段上限（Unicode 码点）。
pub const SNIPPET_MAX_CODEPOINTS: usize = 400;
/// 查询长度上限（Unicode scalars）。
pub const QUERY_MAX_SCALARS: usize = 128;
/// 查询主词项上限。
pub const QUERY_MAX_TERMS: usize = 16;
/// 单字受限扫描护栏：最多扫描的 chunk 行数。
pub const SCAN_MAX_ROWS: usize = 1000;
/// 单字受限扫描护栏：最多扫描的文本字节。
pub const SCAN_MAX_BYTES: usize = 4 * 1024 * 1024;
/// AI 单次完整 JSON 响应预算（UTF-8 bytes）。
pub const RESPONSE_BUDGET_BYTES: usize = 8192;
/// FTS 每库候选上限。
pub const SEARCH_CANDIDATE_LIMIT: usize = 100;

// ==================== 迁移 ====================

/// P0 最小表集：kb_library_state + kb_chunk。FTS 表不在启动迁移建，
/// 在该库首次发布时（分配 partitionNo 处）创建。幂等：全部 IF NOT EXISTS。
pub fn migrate_cr030_knowledge_index(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS kb_library_state (
            libraryId TEXT PRIMARY KEY REFERENCES knowledge_library(id),
            partitionNo INTEGER NOT NULL UNIQUE CHECK(partitionNo > 0),
            indexEpoch INTEGER NOT NULL DEFAULT 0 CHECK(indexEpoch >= 0),
            tokenizerVersion TEXT NOT NULL DEFAULT 'local-bigram-hex-v1',
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kb_chunk (
            chunkKey INTEGER PRIMARY KEY,
            libraryId TEXT NOT NULL,
            noteId TEXT NOT NULL,
            relativeUri TEXT NOT NULL,
            parseGeneration TEXT NOT NULL,
            sourceHash TEXT NOT NULL,
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            kind TEXT NOT NULL CHECK(kind IN ('body','metadata')),
            startByte INTEGER NOT NULL CHECK(startByte >= 0),
            endByte INTEGER NOT NULL CHECK(endByte >= startByte),
            text TEXT NOT NULL,
            title TEXT NOT NULL,
            heading TEXT NOT NULL,
            startLine INTEGER NOT NULL,
            endLine INTEGER NOT NULL,
            UNIQUE(libraryId,noteId,parseGeneration,ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_kb_chunk_note ON kb_chunk(libraryId, noteId, parseGeneration);
        "#,
    )
    .map_err(|e| format!("CR-030-D1 迁移失败：{e}"))?;
    let now = crate::models::now_ms();
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (2, ?1)",
        [now],
    )
    .map_err(|e| format!("CR-030-D1 schema_version 写入失败：{e}"))?;
    Ok(())
}

/// FTS 表名只由宿主从 partitionNo（DB 内 CHECK>0 的整数）生成，绝不拼接任何输入。
fn fts_table_name(partition_no: i64) -> Result<String, String> {
    if partition_no <= 0 {
        return Err(format!("非法 partitionNo：{partition_no}"));
    }
    Ok(format!("kb_fts_l{partition_no}"))
}

const FTS_DDL: &str =
    "USING fts5(title_terms, heading_terms, body_terms, bigram_terms, tokenize='unicode61 remove_diacritics 0')";

// ==================== 切片器（纯函数） ====================

/// 字节区间 `[start,end)`；两端都在 char 边界，区间连续不重叠地铺满输入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: usize,
    end: usize,
}

impl Span {
    fn len(&self) -> usize {
        self.end - self.start
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub ordinal: usize,
    pub kind: &'static str, // "body" | "metadata"
    pub start_byte: usize,
    pub end_byte: usize,
    pub text: String,
    pub title: String,
    pub heading: String,
    pub start_line: usize,
    pub end_line: usize,
}

fn line_spans(content: &str) -> Vec<Span> {
    let bytes = content.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            spans.push(Span { start, end: i + 1 });
            start = i + 1;
        }
    }
    if start < bytes.len() {
        spans.push(Span { start, end: bytes.len() });
    }
    spans
}

fn line_starts(content: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, b) in content.as_bytes().iter().enumerate() {
        if *b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// 1-based 行号：起点在 offset 所在行。
fn line_no(starts: &[usize], offset: usize) -> usize {
    starts.partition_point(|s| *s <= offset).max(1)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum LineKind {
    Blank,
    FenceStart,
    FenceBody,
    FenceEnd,
    Table,
    Text,
}

fn fence_marker(line_text: &str) -> bool {
    let t = line_text.trim();
    t.starts_with("```") || t.starts_with("~~~")
}

fn classify_line(line: &Span, content: &str, in_fence: &mut bool, markdown: bool) -> LineKind {
    let text = &content[line.start..line.end];
    if markdown && fence_marker(text) {
        if *in_fence {
            *in_fence = false;
            return LineKind::FenceEnd;
        }
        *in_fence = true;
        return LineKind::FenceStart;
    }
    if *in_fence {
        return LineKind::FenceBody;
    }
    let body = text.trim_end_matches(['\n', '\r']);
    if body.trim().is_empty() {
        return LineKind::Blank;
    }
    if markdown && body.trim_start().starts_with('|') {
        return LineKind::Table;
    }
    LineKind::Text
}

/// 把 `[0,len)` 拆成段落级原子片段：围栏代码块、表格整段保护；空行挂前段尾部；
/// 片段连续铺满全区间。
fn paragraph_pieces(content: &str, markdown: bool) -> Vec<Span> {
    let lines = line_spans(content);
    if lines.is_empty() {
        return vec![];
    }
    let mut pieces: Vec<Span> = Vec::new();
    let mut piece_start = 0usize;
    let mut in_fence = false;
    let mut prev_kind = LineKind::Blank;
    let mut prev_table = false;
    for (idx, line) in lines.iter().enumerate() {
        let kind = classify_line(line, content, &mut in_fence, markdown);
        let is_table = kind == LineKind::Table;
        let brk = idx > 0
            && match kind {
                LineKind::FenceStart => true,
                LineKind::Blank => false,
                _ => {
                    prev_kind == LineKind::FenceEnd
                        || prev_kind == LineKind::Blank
                        || (is_table && !prev_table)
                        || (!is_table && prev_table)
                }
            };
        if brk {
            pieces.push(Span { start: piece_start, end: line.start });
            piece_start = line.start;
        }
        prev_kind = kind;
        prev_table = is_table;
    }
    pieces.push(Span { start: piece_start, end: content.len() });
    pieces
}

/// 超长片段在字符边界强制续分（受保护区间长度上限防游离吞段）；每片 ≤ TARGET。
fn force_split(content: &str, span: Span) -> Vec<Span> {
    let mut out = Vec::new();
    let mut start = span.start;
    let mut len = 0usize;
    for (idx, ch) in content[span.start..span.end].char_indices() {
        let ch_len = ch.len_utf8();
        if len + ch_len > CHUNK_TARGET_BYTES && len > 0 {
            out.push(Span { start, end: span.start + idx });
            start = span.start + idx;
            len = ch_len;
        } else {
            len += ch_len;
        }
    }
    out.push(Span { start, end: span.end });
    out
}

/// 相邻片段合并（仅当区间相邻）到 TARGET；单片段超 TARGET 先续分。
fn accumulate(content: &str, pieces: &[Span]) -> Vec<Span> {
    let mut blocks: Vec<Span> = Vec::new();
    let mut cur: Option<Span> = None;
    for p in pieces {
        if p.len() > CHUNK_TARGET_BYTES {
            if let Some(c) = cur.take() {
                blocks.push(c);
            }
            blocks.extend(force_split(content, *p));
            continue;
        }
        match cur {
            None => cur = Some(*p),
            Some(c) => {
                if p.end - c.start <= CHUNK_TARGET_BYTES {
                    cur = Some(Span { start: c.start, end: p.end });
                } else {
                    blocks.push(c);
                    cur = Some(*p);
                }
            }
        }
    }
    if let Some(c) = cur {
        blocks.push(c);
    }
    blocks
}

/// 切片策略降级信号：当前层结果不合格，退到更简单一层重切。
struct Degrade;

enum LayerOutcome {
    Done(Vec<Span>),
    Degrade(Degrade),
    Fatal(String),
}

/// Validator 最小集（byte 口径）：
/// ① 0 块 → 拒绝降级（由上层接 metadata 兜底）；
/// ② 单块且 > 2×目标 → 降级；
/// ③ maxLen > 2×目标 → 先续分（bug 检出），续分后仍超限才失败；
/// ④ <50 bytes 非尾块占比 > 1/4 且 > 2 → 降级；
/// ⑤ 全员远小于目标（< 1/4 目标且 ≥4 块）→ 哨兵降级。
fn validate(content: &str, mut blocks: Vec<Span>) -> LayerOutcome {
    let total = content.len();
    if blocks.is_empty() {
        return LayerOutcome::Degrade(Degrade);
    }
    // 覆盖不变式：连续、无重叠、铺满 [0,total)。破坏即实现 bug，直接失败。
    if blocks[0].start != 0
        || blocks.last().map(|b| b.end) != Some(total)
        || blocks.windows(2).any(|w| w[0].end != w[1].start)
        || blocks.iter().any(|b| b.start > b.end)
    {
        return LayerOutcome::Fatal("切片覆盖不变式被破坏（重叠/缝隙/越界）".into());
    }
    let mut max_len = blocks.iter().map(|b| b.len()).max().unwrap_or(0);
    if max_len > CHUNK_HARD_CAP_BYTES {
        let mut repaired = Vec::with_capacity(blocks.len());
        for b in blocks {
            if b.len() > CHUNK_HARD_CAP_BYTES {
                repaired.extend(force_split(content, b));
            } else {
                repaired.push(b);
            }
        }
        max_len = repaired.iter().map(|b| b.len()).max().unwrap_or(0);
        if max_len > CHUNK_HARD_CAP_BYTES {
            return LayerOutcome::Fatal(format!("续分后仍超过硬顶 {CHUNK_HARD_CAP_BYTES} bytes（chunker bug）"));
        }
        blocks = repaired;
    }
    if blocks.len() == 1 && blocks[0].len() > 2 * CHUNK_TARGET_BYTES {
        return LayerOutcome::Degrade(Degrade);
    }
    let tiny = blocks[..blocks.len() - 1].iter().filter(|b| b.len() < 50).count();
    if tiny > blocks.len() / 4 && tiny > 2 {
        return LayerOutcome::Degrade(Degrade);
    }
    if blocks.len() >= 4 && blocks.iter().all(|b| b.len() < CHUNK_TARGET_BYTES / 4) {
        return LayerOutcome::Degrade(Degrade);
    }
    LayerOutcome::Done(blocks)
}

fn run_layer(content: &str, markdown: bool, heading_sections: bool) -> LayerOutcome {
    if heading_sections {
        let mut blocks = Vec::new();
        for section in heading_section_spans(content) {
            let local = &content[section.start..section.end];
            let pieces: Vec<Span> = paragraph_pieces(local, markdown)
                .into_iter()
                .map(|p| Span { start: p.start + section.start, end: p.end + section.start })
                .collect();
            blocks.extend(accumulate(content, &pieces));
        }
        if blocks.is_empty() {
            return LayerOutcome::Degrade(Degrade);
        }
        validate(content, blocks)
    } else {
        let pieces = paragraph_pieces(content, markdown);
        let blocks = accumulate(content, &pieces);
        validate(content, blocks)
    }
}

fn force_split_layer(content: &str) -> LayerOutcome {
    validate(content, force_split(content, Span { start: 0, end: content.len() }))
}

/// 主导标题层级（出现次数最多的层级，并列取更浅）；无标题时整篇为单节。
fn heading_section_spans(content: &str) -> Vec<Span> {
    let lines = line_spans(content);
    let mut counts = [0usize; 7];
    let mut levels: Vec<usize> = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    let mut has_heading = false;
    for line in &lines {
        let text = &content[line.start..line.end];
        if fence_marker(text) {
            in_fence = !in_fence;
            levels.push(0);
            continue;
        }
        if in_fence {
            levels.push(0);
            continue;
        }
        let body = text.trim_end_matches(['\n', '\r']);
        let hashes = body.len() - body.trim_start_matches('#').len();
        let level = if hashes >= 1 && hashes <= 6 {
            let rest = &body[hashes..];
            if rest.starts_with(' ') || rest.is_empty() {
                hashes
            } else {
                0
            }
        } else {
            0
        };
        if level > 0 {
            counts[level] += 1;
            has_heading = true;
        }
        levels.push(level);
    }
    if !has_heading {
        return vec![Span { start: 0, end: content.len() }];
    }
    let mut dominant = 1usize;
    for level in 2..=6 {
        if counts[level] > counts[dominant] {
            dominant = level;
        }
    }
    let mut sections = Vec::new();
    let mut current_start = 0usize;
    for (idx, line) in lines.iter().enumerate() {
        if levels[idx] == dominant && line.start > current_start {
            sections.push(Span { start: current_start, end: line.start });
            current_start = line.start;
        }
    }
    sections.push(Span { start: current_start, end: content.len() });
    sections
}

fn chunk_spans(content: &str, markdown: bool) -> Result<Vec<Span>, String> {
    if content.is_empty() {
        return Ok(vec![]);
    }
    if markdown {
        match run_layer(content, markdown, true) {
            LayerOutcome::Done(spans) => return Ok(spans),
            LayerOutcome::Fatal(e) => return Err(e),
            LayerOutcome::Degrade(_) => {}
        }
        match run_layer(content, markdown, false) {
            LayerOutcome::Done(spans) => return Ok(spans),
            LayerOutcome::Fatal(e) => return Err(e),
            LayerOutcome::Degrade(_) => {}
        }
    } else {
        match run_layer(content, markdown, false) {
            LayerOutcome::Done(spans) => return Ok(spans),
            LayerOutcome::Fatal(e) => return Err(e),
            LayerOutcome::Degrade(_) => {}
        }
    }
    match force_split_layer(content) {
        LayerOutcome::Done(spans) => Ok(spans),
        LayerOutcome::Fatal(e) => Err(e),
        LayerOutcome::Degrade(_) => Err("切片降级链耗尽仍未产出有效块".into()),
    }
}

/// 标题面包屑：对每个块起点快照当前打开的标题栈（只进索引，不进正文 offset）。
/// 围栏代码块内的 `#` 不是标题；块若正好起始于标题行，则包含该标题。
fn heading_breadcrumbs(content: &str, markdown: bool, blocks: &[Span]) -> Vec<String> {
    let mut out = vec![String::new(); blocks.len()];
    if !markdown || blocks.is_empty() {
        return out;
    }
    let lines = line_spans(content);
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut in_fence = false;
    let mut bi = 0usize;
    for line in &lines {
        let text = &content[line.start..line.end];
        let mut heading_here: Option<(usize, String)> = None;
        if fence_marker(text) {
            in_fence = !in_fence;
        } else if !in_fence {
            let body = text.trim_end_matches(['\n', '\r']);
            let hashes = body.len() - body.trim_start_matches('#').len();
            if hashes >= 1 && hashes <= 6 {
                let rest = &body[hashes..];
                if rest.starts_with(' ') || rest.is_empty() {
                    heading_here = Some((hashes, rest.trim().trim_end_matches('#').trim().to_string()));
                }
            }
        }
        // 先把本行标题压栈：起始于标题行的块，其面包屑含该标题且不含同名级兄弟旧节。
        if let Some((level, title_text)) = heading_here {
            stack.retain(|(l, _)| *l < level);
            stack.push((level, title_text));
        }
        while bi < blocks.len() && blocks[bi].start < line.end {
            out[bi] = stack.iter().map(|(_, t)| t.clone()).collect::<Vec<_>>().join(" > ");
            bi += 1;
        }
    }
    out
}

/// 切片入口：对同一 `read_text` 读出的内容产出连续覆盖 `[0,len)` 的 body 块。
/// 不做 CRLF 归一化——offset 语义 = 该内容的原始字节（gateway_read 可按相同路径重建）。
pub fn chunk_content(content: &str, markdown: bool, title: &str) -> Result<Vec<Chunk>, String> {
    let spans = chunk_spans(content, markdown)?;
    let headings = heading_breadcrumbs(content, markdown, &spans);
    let starts = line_starts(content);
    let mut out = Vec::with_capacity(spans.len());
    for (i, s) in spans.iter().enumerate() {
        let end_line = if s.end > s.start { line_no(&starts, s.end - 1) } else { line_no(&starts, s.start) };
        out.push(Chunk {
            ordinal: i,
            kind: "body",
            start_byte: s.start,
            end_byte: s.end,
            text: content[s.start..s.end].to_string(),
            title: title.to_string(),
            heading: headings[i].clone(),
            start_line: line_no(&starts, s.start),
            end_line,
        });
    }
    Ok(out)
}

/// metadata-only 兜底块：无正文（start=end=0、text 空），文件名与路径可搜。
fn metadata_chunk(title: &str) -> Chunk {
    Chunk {
        ordinal: 0,
        kind: "metadata",
        start_byte: 0,
        end_byte: 0,
        text: String::new(),
        title: title.to_string(),
        heading: String::new(),
        start_line: 0,
        end_line: 0,
    }
}

// ==================== 词项管线（纯函数） ====================

/// 搜索归一化：全角 ASCII 折叠为半角、拉丁大写折叠为小写；1:1 字符映射，
/// 因此归一化串的字符下标可直接映射回原文（用于片段定位）。
/// P0 不做 NFC 与繁简转换（登记偏差）；索引与查询两侧必须同一函数。
pub fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mapped = match c {
                '\u{3000}' => ' ',
                c if ('\u{FF01}'..='\u{FF5E}').contains(&c) => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
                c => c,
            };
            if mapped.is_ascii() {
                mapped.to_ascii_lowercase()
            } else {
                mapped
            }
        })
        .collect()
}

/// Han 区间表（U+4E00–9FFF、U+3400–4DBF、U+F900–FAFF、扩展 B–F）。
fn is_han(c: char) -> bool {
    let u = c as u32;
    (0x4E00..=0x9FFF).contains(&u)
        || (0x3400..=0x4DBF).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0x20000..=0x2FA1F).contains(&u)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum CharClass {
    Han,
    Word,
    Sep,
}

fn classify_char(c: char) -> CharClass {
    if is_han(c) {
        CharClass::Han
    } else if c.is_alphanumeric() {
        CharClass::Word
    } else {
        CharClass::Sep
    }
}

struct Run {
    class: CharClass,
    text: String,
}

fn runs(norm: &str) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for c in norm.chars() {
        let class = classify_char(c);
        match out.last_mut() {
            Some(last) if last.class == class => last.text.push(c),
            _ => out.push(Run { class, text: c.to_string() }),
        }
    }
    out
}

/// 词项直出原始 UTF-8 字面（CR-055 v4）：FTS5 `unicode61` 以空格分隔 token，
/// 汉字二字组（`数据`）与拉丁整词（`needle`）直接作为 token 存留，
/// 不再做 `%02x` 十六进制编码——后者让 6 字节二字组膨胀为 13 字节 ASCII，是 10GiB 基准
/// 空间放大约 2.17× 的主因之一。token 只含 Han 或 `is_alphanumeric` 字符，
/// 不含 FTS5 语法字符，因此不引入查询注入面。
fn index_term(text: &str) -> String {
    text.to_string()
}

/// 归一化文本 → (词项 w…, 二字组 b…)。连续 Han 段生成相邻二字组；
/// 拉丁/数字/其它文字整词为词项；单字 Han 不入索引（走受限扫描路径）。
fn tokens(norm: &str) -> (Vec<String>, Vec<String>) {
    let (mut words, mut bigrams) = (String::new(), String::new());
    push_terms(norm, &mut words, &mut bigrams);
    (split_terms(words), split_terms(bigrams))
}

/// 直接把词项追加进两个以空格分隔的缓冲区。索引热路径用它，避免为每个词项
/// 单独分配 String：10GiB 基准里约 400 万分块 × 每块近百词，逐词分配是主要 CPU 开销。
pub(crate) fn push_terms(norm: &str, words: &mut String, bigrams: &mut String) {
    for run in runs(norm) {
        match run.class {
            CharClass::Han => {
                let chars: Vec<char> = run.text.chars().collect();
                if chars.len() >= 2 {
                    for pair in chars.windows(2) {
                        if !bigrams.is_empty() { bigrams.push(' '); }
                        bigrams.extend(pair.iter());
                    }
                }
            }
            CharClass::Word => {
                if !words.is_empty() { words.push(' '); }
                words.push_str(&run.text);
            }
            CharClass::Sep => {}
        }
    }
}

fn split_terms(joined: String) -> Vec<String> {
    if joined.is_empty() { return Vec::new(); }
    joined.split(' ').map(|t| t.to_string()).collect()
}

/// 解析后的字面查询：`terms` 进入 FTS MATCH（hex 词项，无操作符）；
/// `needles` 为归一化原文子串（命中核验 + 片段定位）；单字查询走受限扫描。
#[derive(Debug, Clone)]
pub struct ParsedQuery {
    pub terms: Vec<String>,
    pub needles: Vec<String>,
    pub single_char: Option<char>,
}

impl ParsedQuery {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.single_char.is_none() && self.needles.is_empty()
    }
}

/// 用户 query 是 literal：AND/OR/NEAR、引号、*、冒号一律不解释为查询语言。
pub fn parse_query(query: &str) -> Result<ParsedQuery, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(ParsedQuery { terms: vec![], needles: vec![], single_char: None });
    }
    let norm = normalize(trimmed);
    let scalars = norm.chars().count();
    if scalars > QUERY_MAX_SCALARS {
        return Err(format!("查询过长：最多 {QUERY_MAX_SCALARS} 个字符，收到 {scalars} 个"));
    }
    let (words, bigrams) = tokens(&norm);
    let mut terms: Vec<String> = Vec::new();
    for t in words.into_iter().chain(bigrams) {
        if !terms.contains(&t) {
            terms.push(t);
        }
    }
    if terms.len() > QUERY_MAX_TERMS {
        return Err(format!("查询词项过多：最多 {QUERY_MAX_TERMS} 个，收到 {} 个", terms.len()));
    }
    let mut needles = Vec::new();
    for run in runs(&norm) {
        match run.class {
            CharClass::Han => needles.push(run.text),
            CharClass::Word => needles.push(run.text),
            _ => {}
        }
    }
    let single_char = if scalars == 1 && terms.is_empty() {
        norm.chars().next()
    } else {
        None
    };
    Ok(ParsedQuery { terms, needles, single_char })
}

fn join_terms(terms: &[String]) -> String {
    terms.join(" ")
}

// ==================== 发布 ====================

#[derive(Debug, Clone)]
pub struct LibraryFile {
    pub note_id: String,
    pub relative_uri: String,
    pub title: String,
    pub markdown: bool,
    /// Some((正文, 源 hash)) = 文本切片；None = metadata-only（文件名/路径可搜）。
    pub content: Option<(String, String)>,
}

pub(crate) struct ChunkTerms {
    pub(crate) title: String,
    pub(crate) heading: String,
    pub(crate) body: String,
    pub(crate) bigram: String,
}

/// 四列词项：title 列含标题+路径的 w/b；heading 列含面包屑 w/b；
/// body 列仅正文 w；bigram 列仅正文 b（bm25 权重 8/4/1/0.2）。
pub(crate) fn terms_for_chunk(chunk: &Chunk, relative_uri: &str) -> ChunkTerms {
    let (body, bigram) = body_terms_for(&chunk.text);
    ChunkTerms {
        title: title_terms_for(&chunk.title, relative_uri),
        heading: heading_terms_for(&chunk.heading),
        body,
        bigram,
    }
}

/// title 列词项（标题+相对路径的 w 与 b）。同一文件各分块相同，调用方可缓存。
pub(crate) fn title_terms_for(title: &str, relative_uri: &str) -> String {
    let (mut words, mut bigrams) = (String::new(), String::new());
    push_terms(&normalize(&format!("{title}\n{relative_uri}")), &mut words, &mut bigrams);
    if words.is_empty() { return bigrams; }
    if bigrams.is_empty() { return words; }
    words.push(' ');
    words.push_str(&bigrams);
    words
}

/// heading 列词项（面包屑的 w 与 b）。
pub(crate) fn heading_terms_for(heading: &str) -> String {
    let (mut words, mut bigrams) = (String::new(), String::new());
    push_terms(&normalize(heading), &mut words, &mut bigrams);
    if words.is_empty() { return bigrams; }
    if bigrams.is_empty() { return words; }
    words.push(' ');
    words.push_str(&bigrams);
    words
}

/// 正文两列：body 只含整词 w，bigram 只含汉字二字组 b。入参须是归一化后的文本。
pub(crate) fn body_terms_for(text: &str) -> (String, String) {
    let (mut words, mut bigrams) = (String::new(), String::new());
    push_terms(&normalize(text), &mut words, &mut bigrams);
    (words, bigrams)
}

/// 确保库状态行与 FTS 表存在；返回 (fts 表名, 当前 indexEpoch)。
/// FTS 表创建时机 = 该库首次发布时（分配 partitionNo 处），不在启动迁移建。
fn ensure_partition_tx(tx: &rusqlite::Transaction, library_id: &str) -> Result<(String, i64), String> {
    let existing: Option<(i64, i64)> = tx
        .query_row(
            "SELECT partitionNo, indexEpoch FROM kb_library_state WHERE libraryId=?1",
            [library_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((partition, epoch)) = existing {
        let name = fts_table_name(partition)?;
        // 这里只保证表存在，不改 tokenizerVersion：本函数被单篇替换路径共用，
        // 单篇替换只重写一篇，其余篇仍是旧词项；若在此刷版本，检索闸门会放行，
        // 导致“只命中刚保存那一篇、其余静默消失”。版本刷新只由整库替换（republish_library_tx）负责。
        tx.execute_batch(&format!("CREATE VIRTUAL TABLE IF NOT EXISTS {name} {FTS_DDL};"))
            .map_err(|e| format!("FTS 表创建失败（FTS5 不可用即显式失败，不静默回退逐篇扫描）：{e}"))?;
        return Ok((name, epoch));
    }
    let next: i64 = tx
        .query_row("SELECT COALESCE(MAX(partitionNo),0)+1 FROM kb_library_state", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let name = fts_table_name(next)?;
    tx.execute(
        "INSERT INTO kb_library_state(libraryId,partitionNo,indexEpoch,tokenizerVersion,updatedAt) VALUES(?1,?2,0,?3,?4)",
        rusqlite::params![library_id, next, TOKENIZER_VERSION, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute_batch(&format!("CREATE VIRTUAL TABLE IF NOT EXISTS {name} {FTS_DDL};"))
        .map_err(|e| format!("FTS 表创建失败（FTS5 不可用即显式失败，不静默回退逐篇扫描）：{e}"))?;
    Ok((name, 0))
}

/// 单篇替换前确认库内词项与当前分词器同版本。不同版本时重写单篇会让其余篇的词项与新查询不同构，
/// 检索会静默漏掉它们；这里显式拒绝，让调用方提示重建索引（原件保存不受影响）。
fn require_current_tokenizer_tx(tx: &rusqlite::Transaction, library_id: &str) -> Result<(), String> {
    let stored: Option<String> = tx
        .query_row("SELECT tokenizerVersion FROM kb_library_state WHERE libraryId=?1", [library_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    if let Some(version) = stored {
        if version != TOKENIZER_VERSION {
            return Err(format!("INDEX_REBUILD_REQUIRED: 索引使用旧版分词器（{version}），需重建索引后才能更新单篇索引"));
        }
    }
    Ok(())
}
/// 退役：词项删除从 kb_chunk 存储行取精确值（rowid=chunkKey），按 rowid 集 DELETE；
/// 禁止手工重建词项。note_id=None 删除整库（kb_scan 重建）。
fn retire_rows_tx(tx: &rusqlite::Transaction, fts: &str, library_id: &str, note_id: Option<&str>) -> Result<(), String> {
    match note_id {
        Some(nid) => {
            tx.execute(
                &format!("DELETE FROM {fts} WHERE rowid IN (SELECT chunkKey FROM kb_chunk WHERE libraryId=?1 AND noteId=?2)"),
                rusqlite::params![library_id, nid],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM kb_chunk WHERE libraryId=?1 AND noteId=?2", rusqlite::params![library_id, nid])
                .map_err(|e| e.to_string())?;
        }
        None => {
            tx.execute(
                &format!("DELETE FROM {fts} WHERE rowid IN (SELECT chunkKey FROM kb_chunk WHERE libraryId=?1)"),
                [library_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM kb_chunk WHERE libraryId=?1", [library_id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn insert_chunk_tx(
    tx: &rusqlite::Transaction,
    fts: &str,
    library_id: &str,
    note_id: &str,
    parse_generation: &str,
    chunk: &Chunk,
    relative_uri: &str,
    source_hash: &str,
) -> Result<(), String> {
    let terms = terms_for_chunk(chunk, relative_uri);
    tx.execute(
        "INSERT INTO kb_chunk(libraryId,noteId,relativeUri,parseGeneration,sourceHash,ordinal,kind,startByte,endByte,text,title,heading,startLine,endLine)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        rusqlite::params![
            library_id,
            note_id,
            relative_uri,
            parse_generation,
            source_hash,
            chunk.ordinal as i64,
            chunk.kind,
            chunk.start_byte as i64,
            chunk.end_byte as i64,
            chunk.text,
            chunk.title,
            chunk.heading,
            chunk.start_line as i64,
            chunk.end_line as i64,
        ],
    )
    .map_err(|e| e.to_string())?;
    let chunk_key = tx.last_insert_rowid();
    tx.execute(
        &format!("INSERT INTO {fts}(rowid,title_terms,heading_terms,body_terms,bigram_terms) VALUES(?1,?2,?3,?4,?5)"),
        rusqlite::params![chunk_key, terms.title, terms.heading, terms.body, terms.bigram],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn bump_epoch_tx(tx: &rusqlite::Transaction, library_id: &str, new_epoch: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE kb_library_state SET indexEpoch=?2, updatedAt=?3 WHERE libraryId=?1",
        rusqlite::params![library_id, new_epoch, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 发布事务内的单篇笔记替换：chunk/词项替换 + indexEpoch++（同事务）。
/// 任一步失败整事务回滚（调用方负责）；空内容/0 块落 metadata 兜底块。
pub fn republish_note_tx(
    tx: &rusqlite::Transaction,
    library_id: &str,
    note_id: &str,
    relative_uri: &str,
    title: &str,
    content: &str,
    source_hash: &str,
    markdown: bool,
) -> Result<(), String> {
    require_current_tokenizer_tx(tx, library_id)?;
    let (fts, old_epoch) = ensure_partition_tx(tx, library_id)?;
    retire_rows_tx(tx, &fts, library_id, Some(note_id))?;
    let parse_generation = (old_epoch + 1).to_string();
    let mut chunks = if content.is_empty() {
        vec![metadata_chunk(title)]
    } else {
        chunk_content(content, markdown, title)?
    };
    if chunks.is_empty() {
        chunks.push(metadata_chunk(title));
    }
    for chunk in &chunks {
        insert_chunk_tx(tx, &fts, library_id, note_id, &parse_generation, chunk, relative_uri, source_hash)?;
    }
    bump_epoch_tx(tx, library_id, old_epoch + 1)
}

/// 发布事务内的整库替换（kb_scan / 惰性回填）：单短事务发布全部 chunk/词项/epoch++。
pub fn republish_library_tx(tx: &rusqlite::Transaction, library_id: &str, files: &[LibraryFile]) -> Result<(), String> {
    let (fts, old_epoch) = ensure_partition_tx(tx, library_id)?;
    retire_rows_tx(tx, &fts, library_id, None)?;
    let parse_generation = (old_epoch + 1).to_string();
    for file in files {
        let mut chunks = match &file.content {
            Some((content, _)) if !content.is_empty() => chunk_content(content, file.markdown, &file.title)?,
            _ => vec![metadata_chunk(&file.title)],
        };
        if chunks.is_empty() {
            chunks.push(metadata_chunk(&file.title));
        }
        let source_hash = file.content.as_ref().map(|(_, h)| h.as_str()).unwrap_or("");
        for chunk in &chunks {
            insert_chunk_tx(tx, &fts, library_id, &file.note_id, &parse_generation, chunk, &file.relative_uri, source_hash)?;
        }
    }
    // 整库词项已全部按当前分词器重写，此时才把版本刷成当前值。
    tx.execute("UPDATE kb_library_state SET tokenizerVersion=?2,updatedAt=?3 WHERE libraryId=?1",
        rusqlite::params![library_id, TOKENIZER_VERSION, crate::models::now_ms()]).map_err(|e| e.to_string())?;
    bump_epoch_tx(tx, library_id, old_epoch + 1)
}

// ==================== 检索 ====================

#[derive(Debug, Clone)]
pub struct RawHit {
    pub note_id: String,
    pub relative_uri: String,
    pub title: String,
    pub heading: String,
    pub chunk_key: i64,
    pub ordinal: usize,
    pub score: f64,
    pub chunk_text: String,
    pub metadata_only: bool,
    /// None is the legacy P0 table; Some is an explicit kb_snap generation.
    pub snapshot_generation: Option<i64>,
}

/// 当前代子查询：每篇笔记只取其最新 parseGeneration（删除式退役之外的防御）。
const CURRENT_GEN_FILTER: &str = "c.parseGeneration = (SELECT MAX(CAST(x.parseGeneration AS INTEGER)) FROM kb_chunk x WHERE x.libraryId = c.libraryId AND x.noteId = c.noteId)";

fn row_to_hit(r: &rusqlite::Row) -> rusqlite::Result<RawHit> {
    Ok(RawHit {
        note_id: r.get(0)?,
        relative_uri: r.get(1)?,
        title: r.get(2)?,
        heading: r.get(3)?,
        chunk_key: r.get(4)?,
        ordinal: r.get::<_, i64>(5)?.max(0) as usize,
        score: r.get(6)?,
        chunk_text: r.get(7)?,
        metadata_only: r.get::<_, String>(8)? == "metadata",
        snapshot_generation: None,
    })
}

/// 单库检索：词项 AND 主检索 + 归一化原文核验（去掉偶然分散组合）；
/// 单字查询走受限扫描（护栏 + incomplete 标记），不读原件。
pub fn search_library(conn: &Connection, library_id: &str, q: &ParsedQuery) -> Result<(Vec<RawHit>, bool), String> {
    let (partition, _epoch): (i64, i64) = conn
        .query_row(
            "SELECT partitionNo, indexEpoch FROM kb_library_state WHERE libraryId=?1",
            [library_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "该库尚未建立索引状态；请先重新扫描索引".to_string())?;
    // 检索闸门：库内词项由哪个 tokenizer 版本生成，就必须用同版本查询；
    // 版本不一致时 MATCH 会静默 0 命中，必须显式要求重建，不能把“索引需重建”显示成“无匹配结果”。
    let stored: Option<String> = conn
        .query_row("SELECT tokenizerVersion FROM kb_library_state WHERE libraryId=?1", [library_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    if stored.as_deref().is_some_and(|v| v != TOKENIZER_VERSION) {
        return Err(format!("INDEX_REBUILD_REQUIRED: 索引使用旧版分词器（{}），需重建索引后才能检索", stored.unwrap_or_default()));
    }
    if q.terms.is_empty() {
        return scan_literal(conn, library_id, q);
    }
    let fts = fts_table_name(partition)?;
    let expr = join_terms(&q.terms);
    let sql = format!(
        "SELECT c.noteId, c.relativeUri, c.title, c.heading, c.chunkKey, c.ordinal, bm25({fts},8.0,4.0,1.0,0.2) AS score, c.text, c.kind
         FROM {fts} JOIN kb_chunk c ON c.chunkKey = {fts}.rowid
         WHERE {fts} MATCH ?1 AND c.libraryId = ?2 AND {CURRENT_GEN_FILTER}
         ORDER BY score ASC, c.noteId ASC, c.ordinal ASC LIMIT {}",SEARCH_CANDIDATE_LIMIT+1
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<RawHit> = stmt
        .query_map(rusqlite::params![expr, library_id], |r| row_to_hit(r))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let incomplete=rows.len()>SEARCH_CANDIDATE_LIMIT;
    // 原文核验：hex 词项可能被正文中同形字符串误配（hex 碰撞），统一按归一化子串复核。
    let hits: Vec<RawHit> = rows
        .into_iter().take(SEARCH_CANDIDATE_LIMIT)
        .filter(|h| {
            let hay = literal_normalize(&format!("{}\n{}\n{}\n{}", h.chunk_text, h.title, h.heading,h.relative_uri));
            q.needles.iter().all(|n| hay.contains(&literal_normalize(n)))
        })
        .collect();
    Ok((hits, incomplete))
}

/// 单字受限扫描：只扫当前授权库的 DB 派生 chunk（text+title），不读原件；
/// 超护栏标 incomplete，不是「全库无结果」。
fn literal_normalize(text:&str)->String{normalize(text).chars().map(|c|{let mut lower=c.to_lowercase();let a=lower.next().unwrap_or(c);if lower.next().is_none(){a}else{c}}).collect()}
#[cfg(test)]
fn scan_single_char(conn:&Connection,library_id:&str,ch:char)->Result<(Vec<RawHit>,bool),String>{scan_literal(conn,library_id,&ParsedQuery{terms:vec![],needles:vec![ch.to_string()],single_char:Some(ch)})}
fn scan_literal(conn: &Connection, library_id: &str, q: &ParsedQuery) -> Result<(Vec<RawHit>, bool), String> {
    let sql = format!(
        "SELECT c.noteId, c.relativeUri, c.title, c.heading, c.chunkKey, c.ordinal, 0.0 AS score, c.text, c.kind
         FROM kb_chunk c WHERE c.libraryId = ?1 AND {CURRENT_GEN_FILTER}
         ORDER BY c.noteId ASC, c.ordinal ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map([library_id], |r| row_to_hit(r)).map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let mut incomplete = false;
    let mut scanned_rows = 0usize;
    let mut scanned_bytes = 0usize;
    while let Some(row) = rows.next() {
        let hit = row.map_err(|e| e.to_string())?;
        scanned_rows += 1;
        scanned_bytes += hit.chunk_text.len() + hit.title.len();
        if scanned_rows > SCAN_MAX_ROWS || scanned_bytes > SCAN_MAX_BYTES {
            incomplete = true;
            break;
        }
        let hay = literal_normalize(&format!("{}\n{}\n{}\n{}", hit.chunk_text, hit.title,hit.heading,hit.relative_uri));
        let matches=if let Some(ch)=q.single_char{hay.contains(&literal_normalize(&ch.to_string()))}else{q.needles.iter().all(|n|hay.contains(&literal_normalize(n)))};
        if matches {
            hits.push(hit);
        }
    }
    Ok((hits, incomplete))
}

/// 命中片段：最高分 chunk 内首个词项命中处起 ≤400 码点；metadata 命中登记
/// contentUnavailable 语义文案。归一化为 1:1 字符映射，归一化下标即原文字符下标。
pub fn snippet_for(hit: &RawHit, needles: &[String], single_char: Option<char>) -> String {
    if hit.metadata_only {
        return "（metadata_only：仅文件名与路径可检索；正文不可用）".into();
    }
    let norm_text = normalize(&hit.chunk_text);
    let norm_title = normalize(&hit.title);
    let norm_heading = normalize(&hit.heading);
    let text_len = norm_text.chars().count();
    let hay = format!("{norm_text}\n{norm_title}\n{norm_heading}");
    let mut best: Option<usize> = None;
    let mut consider = |idx: usize| {
        let char_idx = hay[..idx].chars().count();
        best = Some(match best {
            Some(b) => b.min(char_idx),
            None => char_idx,
        });
    };
    for needle in needles {
        if let Some(idx) = hay.find(needle.as_str()) {
            consider(idx);
        }
    }
    if let Some(ch) = single_char {
        if let Some(idx) = hay.find(ch) {
            consider(idx);
        }
    }
    let window = |chars: &str, start: usize| -> String {
        chars.chars().skip(start).take(SNIPPET_MAX_CODEPOINTS).collect()
    };
    match best {
        Some(idx) if idx < text_len => window(&hit.chunk_text, idx),
        Some(_) => {
            let trimmed: String = hit.title.chars().take(SNIPPET_MAX_CODEPOINTS).collect();
            if trimmed.is_empty() {
                window(&hit.chunk_text, 0)
            } else {
                trimmed
            }
        }
        None => window(&hit.chunk_text, 0),
    }
}

// ==================== AI 网关有界读取 ====================

/// AI 路径 knowledge.read 结构化响应：整块正文（≤4096 UTF-8 bytes）+ 完整出处。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkView {
    pub library_id: String,
    pub note_id: String,
    pub source_hash: String,
    pub parse_generation: String,
    pub chunk_key: i64,
    pub ordinal: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub heading: String,
    pub content: String,
    pub truncated: bool,
    pub eof: bool,
    pub next_cursor: Option<String>,
}

/// 每篇笔记当前代（删除式退役 + MAX 防御）。
fn current_generation(conn: &Connection, library_id: &str, note_id: &str) -> Result<Option<String>, String> {
    let gen: Option<i64> = conn
        .query_row(
            "SELECT MAX(CAST(parseGeneration AS INTEGER)) FROM kb_chunk WHERE libraryId=?1 AND noteId=?2",
            rusqlite::params![library_id, note_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(gen.map(|g| g.to_string()))
}

struct ChunkRow {
    chunk_key: i64,
    source_hash: String,
    kind: String,
    text: String,
    start_byte: i64,
    end_byte: i64,
    start_line: usize,
    end_line: usize,
    heading: String,
}

fn load_chunk(conn: &Connection, library_id: &str, note_id: &str, generation: &str, ordinal: usize) -> Result<Option<ChunkRow>, String> {
    conn.query_row(
        "SELECT chunkKey, sourceHash, kind, text, startByte, endByte, startLine, endLine, heading FROM kb_chunk
         WHERE libraryId=?1 AND noteId=?2 AND parseGeneration=?3 AND ordinal=?4",
        rusqlite::params![library_id, note_id, generation, ordinal as i64],
        |r| {
            Ok(ChunkRow {
                chunk_key: r.get(0)?,
                source_hash: r.get(1)?,
                kind: r.get(2)?,
                text: r.get(3)?,
                start_byte: r.get(4)?,
                end_byte: r.get(5)?,
                start_line: r.get::<_, i64>(6)?.max(0) as usize,
                end_line: r.get::<_, i64>(7)?.max(0) as usize,
                heading: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 读取指定笔记当前代的一个 chunk；校验游标 hash、登记 hash、越界与 metadata-only 拒绝。
fn read_note_chunk_conn(
    conn: &Connection,
    library_id: &str,
    note_id: &str,
    ordinal: usize,
    expect_hash: Option<&str>,
    max_bytes: Option<usize>,
) -> Result<ChunkView, String> {
    let Some(generation) = current_generation(conn, library_id, note_id)? else {
        return Err("INDEX_PENDING|该笔记尚无已发布索引；请先重新扫描索引".into());
    };
    let Some(row) = load_chunk(conn, library_id, note_id, &generation, ordinal)? else {
        return Err("CURSOR_INVALID|读取位置不存在或已越界；请重新检索".into());
    };
    if let Some(expect) = expect_hash {
        if expect != row.source_hash {
            return Err("SOURCE_CHANGED|源内容已更新，引用失效；请重新检索".into());
        }
    }
    // 派生 chunk 与登记 hash 双向校验（登记行存在时；metadata-only 文件无登记行）。
    let registered: Option<String> = conn
        .query_row(
            "SELECT contentHash FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2",
            rusqlite::params![library_id, note_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(content_hash) = registered {
        if content_hash != row.source_hash {
            return Err("SOURCE_CHANGED|源内容已更新，引用失效；请重新检索".into());
        }
    }
    if row.kind == "metadata" {
        return Err("METADATA_ONLY|该文件正文不可检索（仅文件名与路径可搜索）；不提供虚构正文".into());
    }
    let eof = load_chunk(conn, library_id, note_id, &generation, ordinal + 1)?.is_none();
    let next_cursor = if eof { None } else { Some(format!("{note_id}:{}:{}", ordinal + 1, row.source_hash)) };
    let mut content = row.text;
    let mut truncated = false;
    if let Some(max) = max_bytes {
        if content.len() > max {
            let mut cut = max;
            while cut > 0 && !content.is_char_boundary(cut) {
                cut -= 1;
            }
            content = content[..cut].to_string();
            truncated = true;
        }
    }
    Ok(ChunkView {
        library_id: library_id.to_string(),
        note_id: note_id.to_string(),
        source_hash: row.source_hash,
        parse_generation: generation,
        chunk_key: row.chunk_key,
        ordinal,
        start_byte: row.start_byte.max(0) as usize,
        end_byte: row.end_byte.max(0) as usize,
        start_line: row.start_line,
        end_line: row.end_line,
        heading: row.heading,
        content,
        truncated,
        eof,
        next_cursor,
    })
}

/// 授权复检 + 首块读取（AI 路径 knowledge.read，noteId 入口）。
pub fn gateway_read_chunk_conn(
    conn: &Connection,
    project_id: Option<&str>,
    library_id: &str,
    note_id: &str,
    max_bytes: Option<usize>,
) -> Result<ChunkView, String> {
    // Bind issuance and grant revision in the same bounded SQLite read snapshot.
    if conn.is_autocommit(){let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;let view=gateway_read_chunk_conn(&tx,project_id,library_id,note_id,max_bytes)?;tx.commit().map_err(|e|e.to_string())?;return Ok(view);}
    if !crate::commands::knowledge::authorized(conn, project_id)?.iter().any(|l| l == library_id) {
        return Err("知识库未授权或已禁用，读取被拒绝".into());
    }
    if let Some(view)=crate::commands::knowledge::snapshot::read_chunk_conn(conn,library_id,note_id,None,0,max_bytes)?{
        if let Some(c)=view.next_cursor.as_deref(){crate::commands::knowledge::snapshot::bind_cursor(conn,c,project_id)?;}
        return Ok(view);
    }
    read_note_chunk_conn(conn, library_id, note_id, 0, None, max_bytes)
}

/// 授权复检 + 游标续读（noteId:下一ordinal:sourceHash）；
/// 校验 hash/授权/越界；maxBytes 仅向下收窄。
pub fn gateway_read_cursor_conn(
    conn: &Connection,
    project_id: Option<&str>,
    library_id: &str,
    cursor: &str,
    max_bytes: Option<usize>,
) -> Result<ChunkView, String> {
    // Never renew an old capability with a revision observed after continuation.
    if conn.is_autocommit(){let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;let view=gateway_read_cursor_conn(&tx,project_id,library_id,cursor,max_bytes)?;tx.commit().map_err(|e|e.to_string())?;return Ok(view);}
    if !crate::commands::knowledge::authorized(conn, project_id)?.iter().any(|l| l == library_id) {
        return Err("知识库未授权或已禁用，读取被拒绝".into());
    }
    if cursor.starts_with("kbsnapcursor"){
        crate::commands::knowledge::snapshot::check_cursor_scope(conn,cursor,project_id)?;
        let view=crate::commands::knowledge::snapshot::read_cursor_conn(conn,library_id,cursor,max_bytes)?;
        if let Some(c)=view.next_cursor.as_deref(){crate::commands::knowledge::snapshot::bind_cursor(conn,c,project_id)?;}
        return Ok(view);
    }
    let parts: Vec<&str> = cursor.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0].is_empty() || parts[2].is_empty() {
        return Err("CURSOR_INVALID|游标格式无效".into());
    }
    let ordinal: usize = parts[1].parse().map_err(|_| "CURSOR_INVALID|游标格式无效".to_string())?;
    read_note_chunk_conn(conn, library_id, parts[0], ordinal, Some(parts[2]), max_bytes)
}

/// 单次完整 JSON 响应 ≤8192 UTF-8 bytes：装不下就按字符边界收缩正文，
/// metadata 永不截断；最小 envelope 也装不下则显式失败，不伪造 eof。
pub fn fit_response(mut view: ChunkView) -> Result<ChunkView, String> {
    let measure = |v: &ChunkView| serde_json::to_string(v).map(|s| s.len()).map_err(|e| e.to_string());
    if measure(&view)? <= RESPONSE_BUDGET_BYTES {
        return Ok(view);
    }
    let mut cut = view.content.len();
    for _ in 0..32 {
        while cut > 0 && !view.content.is_char_boundary(cut) {
            cut -= 1;
        }
        view.content = view.content[..cut].to_string();
        view.truncated = true;
        view.eof = false;
        let size = measure(&view)?;
        if size <= RESPONSE_BUDGET_BYTES {
            return Ok(view);
        }
        // 按比例收敛（二分式），避免逐字节循环。
        cut = cut.saturating_sub(1).saturating_mul(RESPONSE_BUDGET_BYTES).saturating_sub(256) / size.max(1);
        if cut == 0 {
            view.content = String::new();
            view.truncated = true;
            view.eof = false;
            if measure(&view)? <= RESPONSE_BUDGET_BYTES {
                return Ok(view);
            }
            return Err("BUDGET_EXCEEDED|最小完整响应也无法放入预算；请缩小读取范围".into());
        }
    }
    Err("BUDGET_EXCEEDED|预算收敛未完成；请缩小读取范围".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// FNV-1a64（与 knowledge_files::hash 同算法，测试本地副本避免跨模块私有依赖）。
    fn hash(bytes: &[u8]) -> String {
        let h = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3));
        format!("fnv1a64:{h:016x}")
    }

    pub struct IndexFixture {
        pub conn: Connection,
    }

    impl IndexFixture {
        pub fn new() -> Self {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL);
                 CREATE TABLE knowledge_library(id TEXT PRIMARY KEY, name TEXT, sourceKind TEXT, sourceRef TEXT, revision INTEGER, enabled INTEGER, createdAt INTEGER, icon TEXT, iconColor TEXT);
                 CREATE TABLE knowledge_note_index(libraryId TEXT,noteId TEXT,title TEXT,relativeUri TEXT,contentHash TEXT,updatedAt INTEGER,PRIMARY KEY(libraryId,noteId),UNIQUE(libraryId,relativeUri));
                 CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER,updatedAt INTEGER,actor TEXT,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(projectId,libraryId));",
            )
            .unwrap();
            migrate_cr030_knowledge_index(&conn).unwrap();
            conn.execute(
                "INSERT INTO knowledge_library(id,name,sourceKind,sourceRef,revision,enabled,createdAt,icon,iconColor) VALUES('kb','Test','managed-directory','D:/x',0,1,0,NULL,NULL)",
                [],
            )
            .unwrap();
            Self { conn }
        }

        pub fn publish(&self, note_id: &str, rel: &str, title: &str, content: &str, markdown: bool) {
            let h = hash(content.as_bytes());
            self.conn
                .execute(
                    "INSERT INTO knowledge_note_index(libraryId,noteId,title,relativeUri,contentHash,updatedAt) VALUES('kb',?1,?2,?3,?4,0)
                     ON CONFLICT(libraryId,relativeUri) DO UPDATE SET title=excluded.title,contentHash=excluded.contentHash",
                    rusqlite::params![note_id, title, rel, h],
                )
                .unwrap();
            let tx = self.conn.unchecked_transaction().unwrap();
            republish_note_tx(&tx, "kb", note_id, rel, title, content, &h, markdown).unwrap();
            tx.commit().unwrap();
        }

        pub fn search(&self, query: &str) -> (Vec<RawHit>, bool) {
            let q = parse_query(query).unwrap();
            if q.is_empty() {
                return (vec![], false);
            }
            search_library(&self.conn, "kb", &q).unwrap()
        }
    }

    fn body_hits(hits: &[RawHit]) -> Vec<&RawHit> {
        hits.iter().filter(|h| !h.metadata_only).collect()
    }

    fn assert_cover(content: &str, chunks: &[Chunk]) {
        assert!(!chunks.is_empty());
        let mut offset = 0usize;
        for c in chunks {
            assert_eq!(c.start_byte, offset, "切片必须连续覆盖，无缝隙/重叠");
            assert_eq!(c.end_byte - c.start_byte, c.text.len());
            assert!(c.text.as_bytes().len() <= CHUNK_HARD_CAP_BYTES, "单块不得超过硬顶");
            offset = c.end_byte;
        }
        assert_eq!(offset, content.len(), "切片必须铺满全部输入字节");
        let rebuilt: String = chunks.iter().map(|c| c.text.clone()).collect();
        assert_eq!(rebuilt, content, "按 ordinal 拼接应逐字节还原原文（无重叠无丢失）");
    }

    // ---------- 迁移 ----------

    #[test]
    fn cr030_migration_is_idempotent_and_enforces_checks() {
        let f = IndexFixture::new();
        migrate_cr030_knowledge_index(&f.conn).unwrap();
        let version: i64 = f.conn.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 2, "schema_version 应登记 2");
        assert!(f.conn.execute("INSERT INTO kb_chunk(libraryId,noteId,relativeUri,parseGeneration,sourceHash,ordinal,kind,startByte,endByte,text,title,heading,startLine,endLine) VALUES('kb','n','r.md','1','h',0,'other',0,0,'','','',0,0)", []).is_err(), "kind CHECK 应拒绝非法值");
        assert!(f.conn.execute("INSERT INTO kb_library_state(libraryId,partitionNo,indexEpoch,tokenizerVersion,updatedAt) VALUES('kb2',0,0,'t',0)", []).is_err(), "partitionNo 必须 > 0");
        assert!(f.conn.execute("INSERT INTO kb_library_state(libraryId,partitionNo,indexEpoch,tokenizerVersion,updatedAt) VALUES('no-such',9,0,'t',0)", []).is_err(), "外键应拒绝未知库");
    }

    // ---------- 切片器 ----------

    #[test]
    fn chunker_md_offsets_breadcrumbs_lines_and_crlf_preserved() {
        let doc = "# 根标题\r\n\r\n引言内容。\r\n\r\n## 子节一\r\n\r\n第一段内容。\r\n\r\n## 子节二\r\n\r\n第二段正文。\r\n";
        let chunks = chunk_content(doc, true, "根标题").unwrap();
        assert_cover(doc, &chunks);
        // 标题面包屑进 heading 列（主导层级 = H2，各节独立成块）
        let sub1 = chunks.iter().find(|c| c.text.contains("第一段内容")).unwrap();
        assert_eq!(sub1.heading, "根标题 > 子节一", "面包屑应含祖先标题，实际：{}", sub1.heading);
        let sub2 = chunks.iter().find(|c| c.text.contains("第二段正文")).unwrap();
        assert_eq!(sub2.heading, "根标题 > 子节二");
        assert_eq!(sub2.start_line, 9, "行号按同一内容计（CRLF 每行占一行）");
        assert_eq!(chunks[0].start_line, 1);
    }

    #[test]
    fn chunker_md_protects_fenced_code_and_tables_from_heading_and_split() {
        let doc = "# 配置\n\n```bash\n# 这不是标题\necho \"# 也不是\"\n```\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n收尾段落。\n";
        let chunks = chunk_content(doc, true, "配置").unwrap();
        assert_cover(doc, &chunks);
        // 围栏代码块原子：开头与代码体永远同块
        let code_chunks: Vec<&Chunk> = chunks.iter().filter(|c| c.text.contains("echo")).collect();
        assert_eq!(code_chunks.len(), 1, "围栏代码体不得被切开");
        assert!(code_chunks[0].text.contains("```bash"), "围栏开头应与代码体同块");
        // 表格原子：表头与数据行同块
        let table_chunks: Vec<&Chunk> = chunks.iter().filter(|c| c.text.contains("| 列A |")).collect();
        assert_eq!(table_chunks.len(), 1, "表格不得被切开");
        assert!(table_chunks[0].text.contains("| 1 | 2 |"), "表头与数据行应同块");
        // 围栏内 # 不产生面包屑污染
        assert!(!code_chunks[0].heading.contains("这不是标题"));
    }

    #[test]
    fn chunker_oversized_paragraph_force_split_and_no_loss() {
        let para = format!("很长的单段落。{}", "甲乙丙丁戊己庚辛壬癸".repeat(200));
        let doc = format!("# 大文件\n\n{para}\n");
        let chunks = chunk_content(&doc, true, "大文件").unwrap();
        assert_cover(&doc, &chunks);
        assert!(chunks.len() >= 2, "超目标段落必须续分");
        assert!(chunks.iter().all(|c| c.text.as_bytes().len() <= CHUNK_HARD_CAP_BYTES));
    }

    #[test]
    fn chunker_degrades_fragmented_heading_sections_into_merged_blocks() {
        let mut doc = String::new();
        for i in 0..100 {
            doc.push_str(&format!("## 节{i}\n\n短{i}。\n\n"));
        }
        let chunks = chunk_content(&doc, true, "多节").unwrap();
        assert_cover(&doc, &chunks);
        let tiny_non_tail = chunks[..chunks.len() - 1].iter().filter(|c| c.text.len() < 50).count();
        assert!(tiny_non_tail <= chunks.len() / 4, "降级后不应仍然过碎：tiny={tiny_non_tail} total={}", chunks.len());
    }

    #[test]
    fn chunker_txt_json_csv_line_grouping() {
        let lines: Vec<String> = (0..400).map(|i| format!("log line {i} with payload data\n")).collect();
        let content = lines.concat();
        let chunks = chunk_content(&content, false, "app.log").unwrap();
        assert_cover(&content, &chunks);
        assert!(chunks.len() >= 2, "长日志必须切多块");
        let json = format!("{{\"key\": \"{}\"}}", "值".repeat(3000));
        let jc = chunk_content(&json, false, "data.json").unwrap();
        assert_cover(&json, &jc);
        assert!(jc.iter().all(|c| c.text.as_bytes().len() <= CHUNK_HARD_CAP_BYTES));
    }

    #[test]
    fn chunker_single_line_no_newline_and_empty_content() {
        let content = "single line without newline but long enough: ".to_string() + &"x".repeat(3000);
        let chunks = chunk_content(&content, false, "a.txt").unwrap();
        assert_cover(&content, &chunks);
        assert!(chunk_content("", true, "empty.md").unwrap().is_empty(), "空内容产出 0 块 → 发布侧落 metadata");
    }

    // ---------- 词项管线 ----------

    #[test]
    fn terms_bigram_chinese_latin_words_are_literal_utf8() {
        let norm = normalize("数据库 Database！");
        let (words, bigrams) = tokens(&norm);
        assert_eq!(norm, "数据库 database!");
        // v4：词项是原始 UTF-8 字面，不再 hex 编码；6 字节二字组不再膨胀成 13 字节 ASCII。
        assert!(bigrams.contains(&"数据".to_string()));
        assert!(bigrams.contains(&"据库".to_string()));
        assert!(!bigrams.iter().any(|t| t == "库d"), "二字组不跨 Han/拉丁边界");
        assert!(words.contains(&"database".to_string()));
        assert!(bigrams.iter().all(|t| !t.chars().all(|c| c.is_ascii_hexdigit())), "词项不含十六进制编码");
        assert_eq!("数据".len(), 6);
        // 单字 Han 不入索引（走受限扫描路径）
        let (_, bigrams_single) = tokens(&normalize("知"));
        assert!(bigrams_single.is_empty());
    }

    #[test]
    fn normalize_folds_fullwidth_and_keeps_11_char_mapping() {
        let src = "ＡＢＣ：Ｄａｔａ１";
        let norm = normalize(src);
        assert_eq!(norm, "abc:data1");
        assert_eq!(norm.chars().count(), src.chars().count(), "1:1 字符映射保证片段定位可回原文");
    }

    #[test]
    fn parse_query_literal_limits_and_single_char_modes() {
        let q = parse_query("a* AND (b) OR \"c\"").unwrap();
        assert!(!q.terms.iter().any(|t| t.contains('*')), "通配符不进入词项（literal）");
        let long = "中".repeat(129);
        assert!(parse_query(&long).is_err(), "超过 128 scalars 应拒绝");
        let ok = parse_query("一二三四五六七八九十").unwrap();
        assert_eq!(ok.terms.len(), 9, "10 个不同汉字 → 9 个二字组（重复二字组去重）");
        let many: String = (0..20).map(|i| format!(" w{i:02}")).collect();
        assert!(parse_query(&many).is_err(), "超过 16 个词项应拒绝");
        let single = parse_query("知").unwrap();
        assert!(single.terms.is_empty() && single.single_char == Some('知'), "单字中文走受限扫描");
        let latin = parse_query("a").unwrap();
        assert!(!latin.terms.is_empty() && latin.single_char.is_none(), "单字拉丁走 FTS 词项");
        assert!(parse_query("！！！").unwrap().is_empty(), "全分隔符查询为空结果不报错");
    }

    // ---------- 发布 / 检索 / 网关 ----------

    #[test]
    fn publish_and_search_chinese_body_and_latin_case() {
        let f = IndexFixture::new();
        f.publish("n1", "docs/缓存设计.md", "缓存设计", "# 缓存设计\n\n分布式缓存一致性协议保证最终一致。", true);
        f.publish("n2", "sensors.md", "Sensors", "AlphaSensor reports temperature.", true);
        let (hits, _) = f.search("缓存一致");
        let body = body_hits(&hits);
        assert_eq!(body.len(), 1, "应命中 n1 正文，实际 {:?}", hits.iter().map(|h| &h.note_id).collect::<Vec<_>>());
        assert_eq!(body[0].note_id, "n1");
        assert!(body[0].chunk_text.contains("分布式缓存一致性"), "命中应来自正文切片而非仅标题");
        let (hits, _) = f.search("alphasensor");
        assert_eq!(body_hits(&hits).len(), 1, "拉丁词项大小写折叠后命中");
        let (hits, _) = f.search("完全不存在的词组");
        assert!(hits.is_empty());
    }

    #[test]
    fn metadata_only_searchable_by_name_and_gateway_refuses_body() {
        let f = IndexFixture::new();
        let tx = f.conn.unchecked_transaction().unwrap();
        republish_library_tx(
            &tx,
            "kb",
            &[LibraryFile {
                note_id: "pdf1".into(),
                relative_uri: "reports/年度报告.pdf".into(),
                title: "年度报告.pdf".into(),
                markdown: false,
                content: None,
            }],
        )
        .unwrap();
        tx.commit().unwrap();
        let (hits, _) = f.search("年度报告");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].metadata_only, "PDF 应为 metadata-only 命中");
        assert!(snippet_for(&hits[0], &[], None).contains("metadata_only"));
        let err = read_note_chunk_conn(&f.conn, "kb", "pdf1", 0, None, None).unwrap_err();
        assert!(err.contains("METADATA_ONLY"), "AI 读取应显式拒绝，实际：{err}");
    }

    #[test]
    fn republish_replaces_terms_and_old_terms_have_zero_hits() {
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n旧内容包含量子算法描述。", true);
        assert_eq!(f.search("量子算法").0.len(), 1);
        let epoch_before: i64 = f.conn.query_row("SELECT indexEpoch FROM kb_library_state WHERE libraryId='kb'", [], |r| r.get(0)).unwrap();
        f.publish("n1", "a.md", "A", "# A\n新内容讨论神经网络。", true);
        let epoch_after: i64 = f.conn.query_row("SELECT indexEpoch FROM kb_library_state WHERE libraryId='kb'", [], |r| r.get(0)).unwrap();
        assert_eq!(epoch_after, epoch_before + 1, "发布事务内 indexEpoch 必须递增");
        let (hits, _) = f.search("量子算法");
        assert!(hits.is_empty(), "退役后旧词项必须零命中");
        assert_eq!(f.search("神经网络").0.len(), 1);
        let rows: i64 = f.conn.query_row("SELECT COUNT(*) FROM kb_chunk WHERE libraryId='kb' AND noteId='n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "每篇笔记只保留当前代 chunk 行");
        let partition: i64 = f.conn.query_row("SELECT partitionNo FROM kb_library_state WHERE libraryId='kb'", [], |r| r.get(0)).unwrap();
        let fts = fts_table_name(partition).unwrap();
        f.conn.execute_batch(&format!("INSERT INTO {fts}({fts}) VALUES('integrity-check');")).unwrap();
    }

    #[test]
    fn republish_note_keeps_other_notes_terms() {
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n独特词组甲乙丙丁。", true);
        f.publish("n2", "b.md", "B", "# B\n另外的内容戊己庚辛。", true);
        f.publish("n1", "a.md", "A", "# A\n更新后的独特词组甲乙丙丁。", true);
        assert_eq!(f.search("戊己庚辛").0.len(), 1, "其它笔记词项不受单篇重发影响");
        assert_eq!(f.search("甲乙丙丁").0.len(), 1);
    }

    #[test]
    fn single_note_republish_refuses_legacy_tokenizer_instead_of_partial_hits() {
        // 单篇替换只重写一篇：若在旧版本库上放行并刷版本，检索闸门会通过，
        // 结果是只命中刚保存的那篇、其余篇静默消失。这里必须显式拒绝，且不得改动其它笔记。
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n甲乙丙丁内容。", true);
        f.publish("n2", "b.md", "B", "# B\n戊己庚辛内容。", true);
        f.conn.execute("UPDATE kb_library_state SET tokenizerVersion='local-bigram-hex-v1' WHERE libraryId='kb'", []).unwrap();
        let tx = f.conn.unchecked_transaction().unwrap();
        let h = hash("brand-new".as_bytes());
        let error = republish_note_tx(&tx, "kb", "n1", "a.md", "A", "# A\n更新后的甲乙丙丁。", &h, true).unwrap_err();
        drop(tx);
        assert!(error.contains("INDEX_REBUILD_REQUIRED"), "单篇替换在旧分词器库上必须要求重建，实际: {error}");
        let version: String = f.conn.query_row("SELECT tokenizerVersion FROM kb_library_state WHERE libraryId='kb'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "local-bigram-hex-v1", "单篇替换不得刷版本");
        let chunks: i64 = f.conn.query_row("SELECT count(*) FROM kb_chunk WHERE libraryId='kb' AND noteId='n2'", [], |r| r.get(0)).unwrap();
        assert!(chunks > 0, "被拒绝的发布不得删除其它笔记的分块");
        // 检索侧同样被闸门挡住，而不是给出“只有一篇”的部分结果。
        let q = parse_query("戊己庚辛").unwrap();
        let gate = search_library(&f.conn, "kb", &q).unwrap_err();
        assert!(gate.contains("INDEX_REBUILD_REQUIRED"), "旧版本库检索必须要求重建，实际: {gate}");
    }
    #[test]
    fn library_republish_upgrades_legacy_tokenizer_version_and_search_recovers() {
        // 整库替换会重写全部词项，此时才允许把版本刷成当前值，检索随之恢复。
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n甲乙丙丁内容。", true);
        f.conn.execute("UPDATE kb_library_state SET tokenizerVersion='local-bigram-hex-v1' WHERE libraryId='kb'", []).unwrap();
        let q = parse_query("甲乙丙丁").unwrap();
        assert!(search_library(&f.conn, "kb", &q).unwrap_err().contains("INDEX_REBUILD_REQUIRED"));
        let body = "# A\n甲乙丙丁内容。";
        let files = vec![LibraryFile {
            note_id: "n1".into(), relative_uri: "a.md".into(), title: "A".into(), markdown: true,
            content: Some((body.to_string(), hash(body.as_bytes()))),
        }];
        let tx = f.conn.unchecked_transaction().unwrap();
        republish_library_tx(&tx, "kb", &files).unwrap();
        tx.commit().unwrap();
        let version: String = f.conn.query_row("SELECT tokenizerVersion FROM kb_library_state WHERE libraryId='kb'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TOKENIZER_VERSION, "整库替换后版本应为当前值");
        assert_eq!(search_library(&f.conn, "kb", &q).unwrap().0.len(), 1, "整库替换后检索应恢复");
    }    #[test]
    fn cursor_pagination_eof_nextcursor_and_source_changed() {
        let f = IndexFixture::new();
        f.conn.execute("INSERT INTO project_library_grant(projectId,libraryId,readAllowed,updatedAt,actor,revision) VALUES('p','kb',1,0,'t',0)", []).unwrap();
        let long_body = format!("# 长文\n\n{}", "段落内容句子。".repeat(400));
        f.publish("n1", "long.md", "长文", &long_body, true);
        let v0 = read_note_chunk_conn(&f.conn, "kb", "n1", 0, None, None).unwrap();
        assert!(!v0.eof && v0.next_cursor.is_some());
        assert!(v0.content.as_bytes().len() <= CHUNK_HARD_CAP_BYTES);
        assert_eq!(v0.ordinal, 0);
        assert_eq!(v0.start_byte, 0);
        let cursor_after_first = v0.next_cursor.clone().unwrap();
        let mut view = v0;
        let mut steps = 0;
        while let Some(cursor) = view.next_cursor.clone() {
            view = gateway_read_cursor_conn(&f.conn, Some("p"), "kb", &cursor, None).unwrap();
            steps += 1;
            assert!(steps < 64, "游标必须有限收敛");
            assert!(view.source_hash.starts_with("fnv1a64:"));
        }
        assert!(view.eof && view.next_cursor.is_none(), "最后一块应 eof");
        assert!(steps >= 2, "长文应至少 3 块，实际续读 {steps} 次");
        // 伪造 hash 的游标 → SOURCE_CHANGED
        let err = gateway_read_cursor_conn(&f.conn, Some("p"), "kb", "n1:1:fnv1a64:0000000000000000", None).unwrap_err();
        assert!(err.contains("SOURCE_CHANGED"), "实际：{err}");
        // 代际推进后，旧代游标同样 SOURCE_CHANGED
        f.publish("n1", "long.md", "长文", &format!("# 长文\n\n{}", "新版本内容句子。".repeat(400)), true);
        let err = gateway_read_cursor_conn(&f.conn, Some("p"), "kb", &cursor_after_first, None).unwrap_err();
        assert!(err.contains("SOURCE_CHANGED"), "重发后旧游标必须失效，实际：{err}");
        // 越界游标
        let err = gateway_read_cursor_conn(&f.conn, Some("p"), "kb", "n1:9999:x", None).unwrap_err();
        assert!(err.contains("CURSOR_INVALID"), "实际：{err}");
        // 游标格式非法
        let err = gateway_read_cursor_conn(&f.conn, Some("p"), "kb", "not-a-cursor", None).unwrap_err();
        assert!(err.contains("CURSOR_INVALID"));
    }

    #[test]
    fn gateway_read_requires_grant_and_metadata_refuses() {
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n需要授权的内容。", true);
        let err = gateway_read_chunk_conn(&f.conn, Some("p"), "kb", "n1", None).unwrap_err();
        assert!(err.contains("未授权"), "未授权应拒绝，实际：{err}");
        f.conn.execute("INSERT INTO project_library_grant(projectId,libraryId,readAllowed,updatedAt,actor,revision) VALUES('p','kb',1,0,'t',0)", []).unwrap();
        let view = gateway_read_chunk_conn(&f.conn, Some("p"), "kb", "n1", None).unwrap();
        assert!(view.content.contains("需要授权的内容"));
        // metadata-only 笔记：授权后仍显式拒绝正文
        let tx = f.conn.unchecked_transaction().unwrap();
        republish_library_tx(&tx, "kb", &[LibraryFile {
            note_id: "img1".into(),
            relative_uri: "图.png".into(),
            title: "图.png".into(),
            markdown: false,
            content: None,
        }])
        .unwrap();
        tx.commit().unwrap();
        let err = gateway_read_chunk_conn(&f.conn, Some("p"), "kb", "img1", None).unwrap_err();
        assert!(err.contains("METADATA_ONLY"), "实际：{err}");
    }

    #[test]
    fn max_bytes_narrows_and_marks_truncated() {
        let f = IndexFixture::new();
        f.publish("n2", "b.md", "B", &format!("# B\n\n{}", "正文内容。".repeat(500)), true);
        let view = read_note_chunk_conn(&f.conn, "kb", "n2", 0, None, Some(2)).unwrap();
        assert!(view.truncated, "maxBytes 向下收窄应标记 truncated");
        assert!(view.content.as_bytes().len() <= 2);
        assert!(!view.eof, "收窄不得伪造 eof");
    }

    #[test]
    fn budget_fit_response_never_exceeds_8192_bytes() {
        // 引号在 JSON 中转义翻倍，可构造越过 8191/8192/8193 边界的响应
        for target in [8191usize, 8192, 8193] {
            let content = "\"".repeat(target.min(CHUNK_HARD_CAP_BYTES));
            let view = ChunkView {
                library_id: "kb".into(),
                note_id: "n1".into(),
                source_hash: "fnv1a64:abcd".into(),
                parse_generation: "1".into(),
                chunk_key: 1,
                ordinal: 0,
                start_byte: 0,
                end_byte: content.len(),
                start_line: 1,
                end_line: 1,
                heading: String::new(),
                content,
                truncated: false,
                eof: true,
                next_cursor: None,
            };
            let raw = serde_json::to_string(&view).unwrap().len();
            let fitted = fit_response(view).unwrap();
            let final_size = serde_json::to_string(&fitted).unwrap().len();
            assert!(final_size <= RESPONSE_BUDGET_BYTES, "target={target} raw={raw} final={final_size} 应 ≤8192");
            if raw > RESPONSE_BUDGET_BYTES {
                assert!(fitted.truncated && !fitted.eof, "越界必须 truncated 且不伪造 eof");
            }
        }
    }

    #[test]
    fn single_char_scan_guardrail_reports_incomplete() {
        let f = IndexFixture::new();
        let tx = f.conn.unchecked_transaction().unwrap();
        for i in 0..1200i64 {
            tx.execute(
                "INSERT INTO kb_chunk(libraryId,noteId,relativeUri,parseGeneration,sourceHash,ordinal,kind,startByte,endByte,text,title,heading,startLine,endLine)
                 VALUES('kb',?1,?1,'1','',?2,'body',0,1,'x','title i','',1,1)",
                rusqlite::params![format!("n{i}"), i],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let q = parse_query("知").unwrap();
        let (hits, incomplete) = scan_single_char(&f.conn, "kb", '知').unwrap();
        assert!(incomplete, "超过 1000 行护栏必须标 incomplete");
        assert!(hits.is_empty(), "'知' 不在夹具文本中");
    }

    #[test]
    fn trigger_injection_rolls_back_chunks_terms_and_note_index() {
        let f = IndexFixture::new();
        f.publish("n1", "a.md", "A", "# A\n原始内容。", true);
        f.conn.execute_batch("CREATE TRIGGER fail_chunk BEFORE INSERT ON kb_chunk BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let result: Result<(), String> = (|| {
            let tx = f.conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM knowledge_note_index WHERE libraryId='kb'", []).map_err(|e| e.to_string())?;
            republish_library_tx(
                &tx,
                "kb",
                &[LibraryFile {
                    note_id: "n1".into(),
                    relative_uri: "a.md".into(),
                    title: "A".into(),
                    markdown: true,
                    content: Some(("# A\n替换内容。".into(), hash("# A\n替换内容。".as_bytes()))),
                }],
            )?;
            tx.commit().map_err(|e| e.to_string())
        })();
        assert!(result.is_err(), "trigger 注入必须使发布失败");
        drop(result);
        let notes: i64 = f.conn.query_row("SELECT COUNT(*) FROM knowledge_note_index", [], |r| r.get(0)).unwrap();
        let chunks: i64 = f.conn.query_row("SELECT COUNT(*) FROM kb_chunk", [], |r| r.get(0)).unwrap();
        assert_eq!(notes, 1, "事务回滚后 note_index 不变");
        assert_eq!(chunks, 1, "事务回滚后 chunk 不变");
        assert_eq!(f.search("原始内容").0.len(), 1, "回滚后旧词项仍可命中");
        assert_eq!(f.search("替换内容").0.len(), 0);
    }
}
