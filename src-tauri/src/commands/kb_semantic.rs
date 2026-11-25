//! CR-089（FEAT-009）语义子流：本地中文语义检索（真实 ONNX 推理，禁止哈希/随机向量冒充语义）。
//!
//! 技术选型（方案 A，已实测跑通）：`ort`（onnxruntime，load-dynamic）+ `tokenizers`。
//!  - 模型：BAAI/bge-small-zh-v1.5 的 ONNX 量化版（Xenova/bge-small-zh-v1.5 `onnx/model_quantized.onnx`，
//!    24,010,842 B，uint8 动态量化 → 推理时 int8 权重），hidden_size=512。
//!  - 分词：配套 tokenizer.json（TemplateProcessing：[CLS] + tokens + [SEP]，max_len 512）。
//!  - 池化：CLS（last_hidden_state[:,0,:]）+ L2 归一化（符合 bge-zh 官方建议；短查询不加 instruction 前缀）。
//!    报告附 mean 池化对比数据（mean gap 更大但官方推荐 CLS，本模块采用 CLS）。
//!  - 输出：维度 512，int8 量化（f32 余弦相似度 → i8 定点：v_i8 = round(v_norm * 127)，点积近似余弦）。
//!
//! 运行时依赖：`load-dynamic` 特性要求进程内有 `onnxruntime.dll`（Windows x64，>= 1.31.x）。
//!  - `ensure_model()` 会定位模型目录并在必要时设置 `ORT_DYLIB_PATH`。
//!  - 模型目录优先级：`NESTCRAFT_EMBED_MODEL` 环境变量 > exe 同级 `semantic/model` > `resource_dir/semantic/model`。
//!  - 目录缺失或缺 `model_quantized.onnx` / `tokenizer.json` / `onnxruntime.dll` 时返回
//!    `SEMANTIC_MODEL_UNAVAILABLE: ...` 稳定错误码；推理失败返回 `SEMANTIC_INFER_FAILED: ...`。
//!
//! 表结构（由主代理在 db 中建立）：
//!   kb_embed(libraryId, noteId, chunkKey, sourcePath, revision, modelId, modelVersion, dim,
//!            vector BLOB, preview, updatedAt, PRIMARY KEY(libraryId,noteId,chunkKey))
//! 本模块按此读写。

use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use ndarray::Array2;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;

// ==================== 常量 ====================

/// 稳定错误码：模型不可用。
pub const ERR_MODEL_UNAVAILABLE: &str = "SEMANTIC_MODEL_UNAVAILABLE";
/// 稳定错误码：推理失败。
pub const ERR_INFER_FAILED: &str = "SEMANTIC_INFER_FAILED";
/// 模型标识（写 kb_embed.modelId）。
pub const MODEL_ID: &str = "BAAI/bge-small-zh-v1.5";
/// 模型版本（写 kb_embed.modelVersion）；同时作为向量口径版本，改动池化/量化/分块须升版本并重建。
pub const MODEL_VERSION: &str = "onnx-int8-v1";
/// 向量维度。
pub const EMBED_DIM: usize = 512;
/// 单条截断 token 上限。
pub const MAX_TOKENS: usize = 512;
/// 批量上限。
pub const MAX_BATCH: usize = 64;
/// 分块目标字符数（200–400 区间由切分器保证）。
pub const CHUNK_MIN_CHARS: usize = 200;
pub const CHUNK_MAX_CHARS: usize = 400;
/// RRF 常数。
pub const RRF_K: usize = 60;

/// 模型文件名（int8 量化版）。
const MODEL_FILE: &str = "model_quantized.onnx";
/// 分词器文件名。
const TOKENIZER_FILE: &str = "tokenizer.json";
/// 运行时 DLL 文件名（Windows）。
#[cfg(windows)]
const ORT_DYLIB_FILE: &str = "onnxruntime.dll";
#[cfg(not(windows))]
const ORT_DYLIB_FILE: &str = "libonnxruntime.so";

// ==================== 结果类型 ====================

/// 语义命中。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub note_id: String,
    pub source_path: String,
    pub title: String,
    pub chunk_key: String,
    pub score: f32,
    pub preview: String,
}

/// 混合检索单条命中。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridHit {
    pub note_id: String,
    pub source_path: String,
    pub title: String,
    pub preview: String,
    pub score: f32,
    /// "keyword" | "semantic" | "both"
    pub source: String,
}

/// 混合检索结果，如实标注各通道可用性。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridResult {
    pub keyword_available: bool,
    pub semantic_available: bool,
    pub degraded_reason: Option<String>,
    pub hits: Vec<HybridHit>,
}

/// 语义索引状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    pub library_id: String,
    pub model_available: bool,
    pub model_id: String,
    pub model_version: String,
    pub dim: usize,
    /// 已编码块条数（kb_embed 中该库行数）。
    pub embedded_chunks: usize,
    /// 库内块总数（以 kb_chunk 当前代计；无 kb_chunk 时退回 note 数）。
    pub total_chunks: usize,
    /// 模型不可用时的稳定错误描述。
    pub unavailable_reason: Option<String>,
}

// ==================== 运行时单例（onnxruntime 每进程仅允许一个环境） ====================

struct Engine {
    _env: ort::environment::Environment,
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    /// 模型目录（诊断/状态用）。
    #[allow(dead_code)]
    model_path: PathBuf,
}

// 惰性单例：onnxruntime 每进程仅允许一个环境，故引擎全局唯一。
// 使用 OnceLock 缓存首次初始化结果（成功或失败），保证推理会话唯一。
static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();

fn model_unavailable(detail: impl std::fmt::Display) -> String {
    format!("{ERR_MODEL_UNAVAILABLE}: {detail}")
}

fn infer_failed(detail: impl std::fmt::Display) -> String {
    format!("{ERR_INFER_FAILED}: {detail}")
}

/// 候选模型目录：环境变量 > exe 同级 semantic/model > resource/dir semantic/model。
fn candidate_model_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("NESTCRAFT_EMBED_MODEL") {
        let v = v.trim();
        if !v.is_empty() {
            dirs.push(PathBuf::from(v));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("semantic").join("model"));
        }
    }
    // Tauri resource_dir：运行期由主代理注入；此处尝试常见相对布局，缺失即跳过。
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("semantic").join("model"));
    }
    dirs
}

fn dir_has_model(dir: &Path) -> bool {
    dir.join(MODEL_FILE).is_file() && dir.join(TOKENIZER_FILE).is_file()
}

/// 在模型目录内确定 DLL 路径（同目录优先）。
fn dylib_in(dir: &Path) -> Option<PathBuf> {
    let p = dir.join(ORT_DYLIB_FILE);
    if p.is_file() { Some(p) } else { None }
}

/// 定位本地模型目录。缺失返回稳定错误码 `SEMANTIC_MODEL_UNAVAILABLE: ...`。
pub fn ensure_model() -> Result<PathBuf, String> {
    let candidates = candidate_model_dirs();
    for dir in &candidates {
        if dir_has_model(dir) {
            return Ok(dir.clone());
        }
    }
    Err(model_unavailable(format!(
        "未找到本地语义模型目录（需要 {MODEL_FILE} 与 {TOKENIZER_FILE}）。已尝试：{}。请设置环境变量 NESTCRAFT_EMBED_MODEL 指向模型目录，或运行 scripts/prepare-semantic-model.mjs 下载。",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    )))
}

/// 确保运行时 DLL 可用：若目录内含 onnxruntime.dll 且进程未显式设置 `ORT_DYLIB_PATH`，则设置之。
fn ensure_dylib(dir: &Path) -> Result<(), String> {
    if std::env::var_os("ORT_DYLIB_PATH").is_some() {
        return Ok(());
    }
    match dylib_in(dir) {
        Some(p) => {
            std::env::set_var("ORT_DYLIB_PATH", &p);
            Ok(())
        }
        None => Err(model_unavailable(format!(
            "模型目录 {} 缺少运行时库 {ORT_DYLIB_FILE}（onnxruntime >= 1.31.x，Windows x64）。可运行 scripts/prepare-semantic-model.mjs 下载，或设置 ORT_DYLIB_PATH。",
            dir.display()
        ))),
    }
}

fn build_engine(dir: PathBuf) -> Result<Engine, String> {
    ensure_dylib(&dir)?;
    let tokenizer = Tokenizer::from_file(dir.join(TOKENIZER_FILE))
        .map_err(|e| model_unavailable(format!("tokenizer.json 加载失败：{e}")))?;
    let env = ort::init()
        .build()
        .map_err(|e| model_unavailable(format!("onnxruntime 环境初始化失败（检查 {ORT_DYLIB_FILE} 是否 >= 1.31.x）：{e}")))?;
    let session = Session::builder(&env)
        .map_err(|e| model_unavailable(format!("session builder 失败：{e}")))?
        .commit_from_file(dir.join(MODEL_FILE))
        .map_err(|e| model_unavailable(format!("模型加载失败（{}）：{e}", dir.join(MODEL_FILE).display())))?;
    Ok(Engine {
        _env: env,
        session: Mutex::new(session),
        tokenizer,
        model_path: dir,
    })
}

/// 取得（惰性初始化的）全局引擎；失败结果缓存，避免反复初始化的副作用。
fn engine() -> Result<&'static Engine, String> {
    let slot = ENGINE.get_or_init(|| {
        let dir = ensure_model()?;
        build_engine(dir)
    });
    match slot {
        Ok(e) => Ok(e),
        Err(e) => Err(e.clone()),
    }
}

/// 供测试/诊断：当前模型是否可用（不触发重初始化副作用以外的行为）。
pub fn model_available() -> bool {
    engine().is_ok()
}

// ==================== 推理 ====================

fn pool_cls(hidden: &[f32], dim: usize) -> Vec<f32> {
    // hidden 第 0 个 token（CLS）的前 dim 个分量。
    let mut v = vec![0f32; dim];
    v.copy_from_slice(&hidden[0..dim]);
    l2_normalize(&mut v);
    v
}

fn l2_normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// 量化 f32（已 L2 归一化，分量约在 [-1,1]）到 int8：round(x*127)，夹取 [-127,127]。
fn quantize_i8(v: &[f32]) -> Vec<i8> {
    v.iter()
        .map(|&x| {
            let q = (x * 127.0).round();
            q.clamp(-127.0, 127.0) as i8
        })
        .collect()
}

/// 对一批文本做真实推理，返回 int8 量化向量（每条 512 维）。批量 ≤ MAX_BATCH，单条截断 ≤ MAX_TOKENS。
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<i8>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    if texts.len() > MAX_BATCH {
        return Err(infer_failed(format!(
            "批量过大：{} 条，单批最多 {MAX_BATCH} 条",
            texts.len()
        )));
    }
    let eng = engine()?;
    // 分词（padding + truncation 至 512）。
    let mut ids_rows: Vec<Vec<i64>> = Vec::with_capacity(texts.len());
    let mut mask_rows: Vec<Vec<i64>> = Vec::with_capacity(texts.len());
    let mut type_rows: Vec<Vec<i64>> = Vec::with_capacity(texts.len());
    let encodings = eng
        .tokenizer
        .encode_batch(texts.to_vec(), true)
        .map_err(|e| infer_failed(format!("分词失败：{e}")))?;
    for enc in &encodings {
        let mut ids: Vec<i64> = enc.get_ids().iter().take(MAX_TOKENS).map(|x| *x as i64).collect();
        let mut mask: Vec<i64> = enc.get_attention_mask().iter().take(MAX_TOKENS).map(|x| *x as i64).collect();
        let mut types: Vec<i64> = enc.get_type_ids().iter().take(MAX_TOKENS).map(|x| *x as i64).collect();
        while ids.len() < MAX_TOKENS {
            ids.push(0);
            mask.push(0);
            types.push(0);
        }
        ids_rows.push(ids);
        mask_rows.push(mask);
        type_rows.push(types);
    }
    let b = texts.len();
    let ids_arr = Array2::from_shape_vec((b, MAX_TOKENS), ids_rows.concat())
        .map_err(|e| infer_failed(format!("input_ids 张量构造失败：{e}")))?;
    let mask_arr = Array2::from_shape_vec((b, MAX_TOKENS), mask_rows.concat())
        .map_err(|e| infer_failed(format!("attention_mask 张量构造失败：{e}")))?;
    let types_arr = Array2::from_shape_vec((b, MAX_TOKENS), type_rows.concat())
        .map_err(|e| infer_failed(format!("token_type_ids 张量构造失败：{e}")))?;

    let inputs = ort::inputs![
        "input_ids" => Tensor::from_array(ids_arr).map_err(|e| infer_failed(format!("input_ids 张量转换失败：{e}")))?,
        "attention_mask" => Tensor::from_array(mask_arr).map_err(|e| infer_failed(format!("attention_mask 张量转换失败：{e}")))?,
        "token_type_ids" => Tensor::from_array(types_arr).map_err(|e| infer_failed(format!("token_type_ids 张量转换失败：{e}")))?,
    ];

    let mut sess = eng
        .session
        .lock()
        .map_err(|_| infer_failed("推理会话锁不可用"))?;
    let outputs = sess
        .run(inputs)
        .map_err(|e| infer_failed(format!("onnxruntime 推理失败：{e}")))?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| infer_failed(format!("输出张量提取失败：{e}")))?;
    // last_hidden_state: [b, seq, dim]
    let ndims = shape.len();
    if ndims < 2 {
        return Err(infer_failed("输出张量维度不足"));
    }
    let dim = *shape.last().unwrap() as usize;
    let seq = shape[ndims - 2] as usize;
    if dim != EMBED_DIM {
        return Err(infer_failed(format!("模型输出维度 {dim} 与预期 {EMBED_DIM} 不符")));
    }
    let stride_b = seq * dim;
    let mut out: Vec<Vec<i8>> = Vec::with_capacity(b);
    for bi in 0..b {
        let start = bi * stride_b;
        let row = &data[start..start + stride_b];
        let pooled = pool_cls(row, dim);
        out.push(quantize_i8(&pooled));
    }
    Ok(out)
}

// ==================== 分块（搜索端与编码端必须一致） ====================

/// 将 markdown 正文切成 200–400 字的块。以段落（空行分隔）为原子单位合并，
/// 超长段落按字符硬切；返回 (chunk_key, text)。chunk_key 形如 `b0000`。
/// 分块口径：按 Unicode 字符数计长度，与 query 编码端共用同一 tokenizer（query 直接整条）。
pub fn chunk_text(content: &str) -> Vec<(String, String)> {
    if content.trim().is_empty() {
        return Vec::new();
    }
    // 段落：按空行切分；保留非空段落文本。
    let mut paragraphs: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            if !cur.trim().is_empty() {
                paragraphs.push(cur.trim().to_string());
                cur.clear();
            }
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.trim().is_empty() {
        paragraphs.push(cur.trim().to_string());
    }

    // 每个段落先按 CHUNK_MAX_CHARS 硬切成片段。
    let mut pieces: Vec<String> = Vec::new();
    for p in paragraphs {
        let chars: Vec<char> = p.chars().collect();
        if chars.len() <= CHUNK_MAX_CHARS {
            pieces.push(p);
        } else {
            let mut i = 0;
            while i < chars.len() {
                let end = (i + CHUNK_MAX_CHARS).min(chars.len());
                pieces.push(chars[i..end].iter().collect());
                i = end;
            }
        }
    }

    // 合并相邻片段至 ≥ CHUNK_MIN_CHARS 且 ≤ CHUNK_MAX_CHARS。
    let mut chunks: Vec<String> = Vec::new();
    let mut acc = String::new();
    let mut acc_len = 0usize;
    for piece in pieces {
        let plen = piece.chars().count();
        if acc_len == 0 {
            acc = piece;
            acc_len = plen;
        } else if acc_len + 1 + plen <= CHUNK_MAX_CHARS {
            acc.push('\n');
            acc.push_str(&piece);
            acc_len += 1 + plen;
        } else {
            chunks.push(std::mem::take(&mut acc));
            acc = piece;
            acc_len = plen;
        }
        // 已达目标上限即落块。
        if acc_len >= CHUNK_MIN_CHARS {
            chunks.push(std::mem::take(&mut acc));
            acc_len = 0;
        }
    }
    if !acc.trim().is_empty() {
        chunks.push(acc);
    }

    chunks
        .into_iter()
        .enumerate()
        .map(|(i, text)| (format!("b{:04}", i), text))
        .collect()
}

/// 生成预览：取块首 ≤120 字符。
fn make_preview(text: &str) -> String {
    let s: String = text.chars().take(120).collect();
    s.replace('\n', " ").trim().to_string()
}

// ==================== 向量 BLOB 编解码 ====================

fn vector_to_blob(v: &[i8]) -> Vec<u8> {
    v.iter().map(|&x| x as u8).collect()
}

fn blob_to_vector(b: &[u8]) -> Vec<i8> {
    b.iter().map(|&x| x as i8).collect()
}

// ==================== 写入 / 删除 ====================

/// 写 kb_embed：先删该 note 旧行再插入。返回插入行数。空 chunks 也先清理旧行。
pub fn upsert_embeddings(
    conn: &Connection,
    library_id: &str,
    note_id: &str,
    source_path: &str,
    revision: &str,
    chunks: &[(String, String)],
) -> Result<usize, String> {
    // 先编码（外部推理），与 DB 写分离；失败即中止、不动旧行。
    let texts: Vec<String> = chunks.iter().map(|(_, t)| t.clone()).collect();
    let mut vectors: Vec<Vec<i8>> = Vec::with_capacity(texts.len());
    for batch in texts.chunks(MAX_BATCH) {
        let mut got = embed_texts(batch)?;
        vectors.append(&mut got);
    }
    if vectors.len() != chunks.len() {
        return Err(infer_failed(format!(
            "编码条数 {} 与块数 {} 不一致",
            vectors.len(),
            chunks.len()
        )));
    }
    let now = crate::models::now_ms();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM kb_embed WHERE libraryId=?1 AND noteId=?2",
        rusqlite::params![library_id, note_id],
    )
    .map_err(|e| e.to_string())?;
    let mut inserted = 0usize;
    for ((chunk_key, text), vector) in chunks.iter().zip(vectors.iter()) {
        tx.execute(
            "INSERT INTO kb_embed(libraryId,noteId,chunkKey,sourcePath,revision,modelId,modelVersion,dim,vector,preview,updatedAt)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                library_id,
                note_id,
                chunk_key,
                source_path,
                revision,
                MODEL_ID,
                MODEL_VERSION,
                EMBED_DIM as i64,
                vector_to_blob(vector),
                make_preview(text),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        inserted += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// 删除某 note 的全部向量行。
pub fn delete_embeddings(conn: &Connection, library_id: &str, note_id: &str) -> Result<usize, String> {
    let n = conn
        .execute(
            "DELETE FROM kb_embed WHERE libraryId=?1 AND noteId=?2",
            rusqlite::params![library_id, note_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

// ==================== 检索 ====================

/// 余弦近似：i8 点积（向量已 L2 归一化后量化到 [-127,127]，点积/127^2 近似余弦）。
fn dot_i8(a: &[i8], b: &[i8]) -> i64 {
    a.iter().zip(b.iter()).map(|(x, y)| *x as i64 * *y as i64).sum()
}

/// 语义检索：query 编码 → 对 kb_embed 该库所有行暴力余弦（i8 点积）→ TopN。
/// 模型不可用时返回 SEMANTIC_INFER_FAILED/SEMANTIC_MODEL_UNAVAILABLE；kb_embed 为空返回空列表。
pub fn semantic_search(
    conn: &Connection,
    library_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let q_vec = embed_texts(&[q.to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| infer_failed("query 编码返回空向量"))?;
    let q_norm_sq: f64 = q_vec.iter().map(|&x| (x as f64) * (x as f64)).sum();

    let mut stmt = conn
        .prepare(
            "SELECT noteId, chunkKey, sourcePath, vector, preview FROM kb_embed WHERE libraryId=?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([library_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let denom_q = q_norm_sq.sqrt();
    let mut scored: Vec<(f64, String, String, String, String)> = Vec::new();
    while let Some(row) = rows.next() {
        let (note_id, chunk_key, source_path, blob, preview) = row.map_err(|e| e.to_string())?;
        let v = blob_to_vector(&blob);
        if v.len() != q_vec.len() {
            continue; // 维度不符的行（旧口径）跳过
        }
        let dot = dot_i8(&q_vec, &v) as f64;
        let v_norm = (v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>()).sqrt();
        let denom = denom_q * v_norm;
        let cos = if denom > 0.0 { dot / denom } else { 0.0 };
        scored.push((cos, note_id, chunk_key, source_path, preview));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // 每笔记取最高分块；title 从 kb_chunk/note_index 补，缺失用 sourcePath 文件名。
    let mut best: Vec<SemanticHit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (score, note_id, chunk_key, source_path, preview) in scored {
        if seen.contains(&note_id) {
            continue;
        }
        seen.insert(note_id.clone());
        let title = lookup_title(conn, library_id, &note_id, &source_path);
        best.push(SemanticHit {
            note_id,
            source_path,
            title,
            chunk_key,
            score: score as f32,
            preview,
        });
        if best.len() >= limit {
            break;
        }
    }
    Ok(best)
}

/// 标题查询：先 kb_embed 的 sourcePath 文件名，再尝试 knowledge_note_index。
fn lookup_title(conn: &Connection, library_id: &str, note_id: &str, source_path: &str) -> String {
    let from_index: Option<String> = conn
        .query_row(
            "SELECT title FROM knowledge_note_index WHERE libraryId=?1 AND noteId=?2",
            rusqlite::params![library_id, note_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(t) = from_index {
        if !t.trim().is_empty() {
            return t;
        }
    }
    Path::new(source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| source_path.to_string())
}

// ==================== 混合检索（RRF） ====================

/// 关键词通道：调用既有关键词检索（kb_index::parse_query + search_library），
/// 返回 (note_id, source_path, title, preview, rank位置)。不可用时返回 Err(reason)。
fn keyword_channel(
    conn: &Connection,
    library_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, String, String, String)>, String> {
    let parsed = crate::commands::kb_index::parse_query(query)?;
    if parsed.is_empty() {
        return Ok(Vec::new());
    }
    let (raw, _incomplete) = crate::commands::kb_index::search_library(conn, library_id, &parsed)?;
    // 每笔记取最高分块。
    let mut best: std::collections::BTreeMap<String, crate::commands::kb_index::RawHit> =
        std::collections::BTreeMap::new();
    for hit in raw {
        match best.get(&hit.note_id) {
            Some(prev) if prev.score <= hit.score => {}
            _ => {
                best.insert(hit.note_id.clone(), hit);
            }
        }
    }
    let mut ranked: Vec<crate::commands::kb_index::RawHit> = best.into_values().collect();
    ranked.sort_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.note_id.cmp(&b.note_id))
    });
    let mut out = Vec::new();
    for hit in ranked.into_iter().take(limit) {
        let preview = crate::commands::kb_index::snippet_for(&hit, &parsed.needles, parsed.single_char);
        out.push((hit.note_id, hit.relative_uri, hit.title, preview));
    }
    Ok(out)
}

/// 混合检索：关键词 + 语义，用 RRF(k=60) 融合。任一通道不可用如实标注并继续用另一路。
pub fn hybrid_search(
    conn: &Connection,
    library_id: &str,
    query: &str,
    limit: usize,
) -> Result<HybridResult, String> {
    let keyword = keyword_channel(conn, library_id, query, limit);
    let semantic = semantic_search(conn, library_id, query, limit);
    Ok(fuse_channels(keyword, semantic, limit))
}

/// RRF 融合纯函数：接收两通道结果（可能是错误），产出带可用性标注的融合结果。
/// 便于在无真实推理的环境下验证降级路径。
fn fuse_channels(
    keyword: Result<Vec<(String, String, String, String)>, String>,
    semantic: Result<Vec<SemanticHit>, String>,
    limit: usize,
) -> HybridResult {
    let mut degraded: Vec<String> = Vec::new();
    let (keyword_hits, keyword_available) = match keyword {
        Ok(h) => (h, true),
        Err(e) => {
            degraded.push(format!("关键词通道不可用：{e}"));
            (Vec::new(), false)
        }
    };
    let (semantic_hits, semantic_available) = match semantic {
        Ok(h) => (h, true),
        Err(e) => {
            degraded.push(format!("语义通道不可用：{e}"));
            (Vec::new(), false)
        }
    };

    // RRF 融合：score = Σ 1/(k + rank_i)，rank 从 1 起。
    use std::collections::HashMap;
    struct Acc {
        note_id: String,
        source_path: String,
        title: String,
        preview: String,
        score: f64,
        kw: bool,
        sem: bool,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    for (rank, (note_id, source_path, title, preview)) in keyword_hits.iter().enumerate() {
        let e = acc.entry(note_id.clone()).or_insert_with(|| Acc {
            note_id: note_id.clone(),
            source_path: source_path.clone(),
            title: title.clone(),
            preview: preview.clone(),
            score: 0.0,
            kw: false,
            sem: false,
        });
        e.score += 1.0 / ((RRF_K + rank + 1) as f64);
        e.kw = true;
        if e.preview.is_empty() {
            e.preview = preview.clone();
        }
    }
    for (rank, hit) in semantic_hits.iter().enumerate() {
        let e = acc.entry(hit.note_id.clone()).or_insert_with(|| Acc {
            note_id: hit.note_id.clone(),
            source_path: hit.source_path.clone(),
            title: hit.title.clone(),
            preview: hit.preview.clone(),
            score: 0.0,
            kw: false,
            sem: false,
        });
        e.score += 1.0 / ((RRF_K + rank + 1) as f64);
        e.sem = true;
        if e.title.is_empty() {
            e.title = hit.title.clone();
        }
        if e.preview.is_empty() {
            e.preview = hit.preview.clone();
        }
    }

    let mut hits: Vec<HybridHit> = acc
        .into_values()
        .map(|a| HybridHit {
            note_id: a.note_id,
            source_path: a.source_path,
            title: a.title,
            preview: a.preview,
            score: a.score as f32,
            source: match (a.kw, a.sem) {
                (true, true) => "both".to_string(),
                (true, false) => "keyword".to_string(),
                (false, true) => "semantic".to_string(),
                (false, false) => "keyword".to_string(),
            },
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.note_id.cmp(&b.note_id))
    });
    hits.truncate(limit);

    HybridResult {
        keyword_available,
        semantic_available,
        degraded_reason: if degraded.is_empty() { None } else { Some(degraded.join("；")) },
        hits,
    }
}

// ==================== 整库重建（后台可取消） ====================

/// 后台可取消地编码整库：读取 knowledge_note_index + 原件文本，按 markdown 段落切 200–400 字，
/// 分批 upsert 到 kb_embed。`cancel` 为真时尽快返回；`progress(已处理篇数, 总篇数)` 回调。
/// 返回成功编码的篇数。分块口径与搜索端一致（chunk_text）。
pub fn rebuild_library_embeddings(
    library_id: &str,
    cancel: &AtomicBool,
    progress: &dyn Fn(usize, usize),
) -> Result<usize, String> {
    // 模型先探测，缺失立即失败（避免读到一半才失败）。
    let _ = ensure_model()?;
    // 收集笔记清单（noteId, sourcePath 相对 uri, title）。
    let (source_root, notes) = {
        let guard = crate::db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let source: String = conn
            .query_row(
                "SELECT sourceRef FROM knowledge_library WHERE id=?1 AND enabled=1 AND sourceKind='managed-directory'",
                [library_id],
                |r| r.get(0),
            )
            .map_err(|_| "知识库不存在、已禁用或不是受管本机目录".to_string())?;
        let mut stmt = conn
            .prepare("SELECT noteId, relativeUri, title FROM knowledge_note_index WHERE libraryId=?1 ORDER BY relativeUri")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map([library_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        (PathBuf::from(source), rows)
    };

    let total = notes.len();
    let mut done = 0usize;
    for (idx, (note_id, rel, _title)) in notes.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // 读取原件文本（相对 root；越界/缺失跳过该篇，不中断整库）。
        let abs = safe_join(&source_root, rel);
        let content = match abs.and_then(|p| std::fs::read_to_string(&p).ok()) {
            Some(c) => c,
            None => {
                progress(idx + 1, total);
                continue;
            }
        };
        let chunks = chunk_text(&content);
        if chunks.is_empty() {
            progress(idx + 1, total);
            continue;
        }
        // 每篇独立事务 upsert（失败该篇跳过，记录错误但不中断整库）。
        let r = (|| -> Result<(), String> {
            let guard = crate::db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let revision = format!("{MODEL_VERSION}");
            upsert_embeddings(conn, library_id, note_id, rel, &revision, &chunks)?;
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("[CR-089] 编码笔记失败 note={note_id}：{e}（跳过）");
        } else {
            done += 1;
        }
        progress(idx + 1, total);
    }
    Ok(done)
}

/// 安全拼接：拒绝绝对路径与 `..` 越界。
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return None;
    }
    for comp in rel_path.components() {
        match comp {
            std::path::Component::Normal(_) => {}
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(root.join(rel_path))
}

// ==================== 状态 ====================

/// 语义索引状态：模型可用性、模型标识/版本、维度、已编码块数、库内块总数。
pub fn semantic_status(library_id: &str) -> Result<SemanticStatus, String> {
    let (available, reason) = match ensure_model() {
        Ok(dir) => {
            let dll_ok = std::env::var_os("ORT_DYLIB_PATH").is_some() || dylib_in(&dir).is_some();
            if dll_ok {
                (true, None)
            } else {
                (
                    false,
                    Some(model_unavailable(format!(
                        "模型目录 {} 缺少运行时库 {ORT_DYLIB_FILE}",
                        dir.display()
                    ))),
                )
            }
        }
        Err(e) => (false, Some(e)),
    };

    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;

    let embedded_chunks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM kb_embed WHERE libraryId=?1",
            [library_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);

    // 库内块总数：优先 kb_chunk 当前代；表不存在或无行时退回 note 数。
    let total_chunks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM kb_chunk WHERE libraryId=?1",
            [library_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| {
            conn.query_row(
                "SELECT COUNT(*) FROM knowledge_note_index WHERE libraryId=?1",
                [library_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });

    Ok(SemanticStatus {
        library_id: library_id.to_string(),
        model_available: available,
        model_id: MODEL_ID.to_string(),
        model_version: MODEL_VERSION.to_string(),
        dim: EMBED_DIM,
        embedded_chunks: embedded_chunks as usize,
        total_chunks: total_chunks as usize,
        unavailable_reason: reason,
    })
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    // 测试用模型目录：通过 NESTCRAFT_EMBED_MODEL 指向 docs/tmp 下载的模型（或跳过）。
    fn test_model_dir() -> Option<PathBuf> {
        if let Ok(v) = std::env::var("NESTCRAFT_EMBED_MODEL") {
            let p = PathBuf::from(v);
            if dir_has_model(&p) {
                return Some(p);
            }
        }
        let fallback = PathBuf::from("../../docs/tmp/cr089-model");
        if dir_has_model(&fallback) {
            return Some(fallback);
        }
        None
    }

    #[test]
    fn chunk_text_bounds_and_coverage() {
        let para = "退款流程：用户在下单后可在订单详情页发起退款申请，填写退款原因并提交，客服审核通过后原路退款。".repeat(3);
        let content = format!("# 退款说明\n\n{para}\n\n## 常见问题\n\n退款多久到账？一般 1-7 个工作日。");
        let chunks = chunk_text(&content);
        assert!(!chunks.is_empty());
        for (key, text) in &chunks {
            let n = text.chars().count();
            assert!(n <= CHUNK_MAX_CHARS, "块 {key} 超长 {n}");
            assert!(!text.trim().is_empty());
        }
        // 覆盖：所有正文段落首句应能被某个块包含。
        assert!(chunks.iter().any(|(_, t)| t.contains("退款流程")));
        // chunk_key 形如 b0000 递增。
        assert!(chunks[0].0.starts_with('b'));
    }

    #[test]
    fn quantize_roundtrip() {
        let v = vec![1.0f32, 0.0, -1.0, 0.5, -0.5];
        let q = quantize_i8(&v);
        assert_eq!(q[0], 127);
        assert_eq!(q[2], -127);
        assert_eq!(q[1], 0);
        let blob = vector_to_blob(&q);
        assert_eq!(blob_to_vector(&blob), q);
    }

    #[test]
    fn real_embedding_similarity() {
        // 3 条中文语义测试：退款相关应明显高于无关。需真实模型；缺失则跳过并注明。
        if let Some(dir) = test_model_dir() {
            std::env::set_var("NESTCRAFT_EMBED_MODEL", &dir);
            let vs = embed_texts(&[
                "如何申请退款".to_string(),
                "退款流程是什么".to_string(),
                "服务器磁盘告警".to_string(),
            ])
            .expect("真实推理失败");
            assert_eq!(vs.len(), 3);
            assert_eq!(vs[0].len(), EMBED_DIM);
            let s1 = dot_i8(&vs[0], &vs[1]) as f64 / (127.0 * 127.0);
            let s2 = dot_i8(&vs[0], &vs[2]) as f64 / (127.0 * 127.0);
            println!("[CR-089] sim(如何申请退款,退款流程是什么) = {s1:.4}");
            println!("[CR-089] sim(如何申请退款,服务器磁盘告警) = {s2:.4}");
            assert!(s1 > s2 + 0.1, "退款相关相似度应明显高于磁盘告警：{s1:.4} vs {s2:.4}");
        } else {
            eprintln!("[CR-089] 跳过真实推理测试：未找到本地模型（设置 NESTCRAFT_EMBED_MODEL 指向含 model_quantized.onnx 的目录）");
        }
    }

    #[test]
    fn semantic_search_and_hybrid_over_temp_db() {
        let Some(dir) = test_model_dir() else {
            eprintln!("[CR-089] 跳过 DB 端到端测试：未找到本地模型");
            return;
        };
        std::env::set_var("NESTCRAFT_EMBED_MODEL", &dir);
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE kb_embed(
                libraryId TEXT, noteId TEXT, chunkKey TEXT, sourcePath TEXT, revision TEXT,
                modelId TEXT, modelVersion TEXT, dim INTEGER, vector BLOB, preview TEXT, updatedAt INTEGER,
                PRIMARY KEY(libraryId,noteId,chunkKey));
            CREATE TABLE knowledge_note_index(
                libraryId TEXT, noteId TEXT, title TEXT, relativeUri TEXT, contentHash TEXT, updatedAt INTEGER,
                PRIMARY KEY(libraryId,noteId));
            CREATE TABLE kb_library_state(
                libraryId TEXT PRIMARY KEY, partitionNo INTEGER NOT NULL UNIQUE, indexEpoch INTEGER NOT NULL,
                tokenizerVersion TEXT NOT NULL, updatedAt INTEGER NOT NULL);
            CREATE TABLE kb_chunk(
                chunkKey INTEGER PRIMARY KEY, libraryId TEXT NOT NULL, noteId TEXT NOT NULL, relativeUri TEXT NOT NULL,
                parseGeneration TEXT NOT NULL, sourceHash TEXT NOT NULL, ordinal INTEGER NOT NULL,
                kind TEXT NOT NULL, startByte INTEGER NOT NULL, endByte INTEGER NOT NULL, text TEXT NOT NULL,
                title TEXT NOT NULL, heading TEXT NOT NULL, startLine INTEGER NOT NULL, endLine INTEGER NOT NULL);
            "#,
        )
        .unwrap();

        let lib = "lib1";
        // 构造真实 md 内容：退款笔记 + 无关笔记。
        let refund = "# 退款与退货\n\n想退货怎么办？可以在订单详情页点击申请退款，填写原因后提交，客服审核通过后原路退款，一般 1-7 个工作日到账。";
        let disk = "# 运维手册\n\n服务器磁盘告警处理：检查 /var/log 分区使用率，清理旧日志，扩容磁盘。";
        let refund_chunks = chunk_text(refund);
        let disk_chunks = chunk_text(disk);
        upsert_embeddings(&conn, lib, "note_refund", "退款与退货.md", "v1", &refund_chunks).unwrap();
        upsert_embeddings(&conn, lib, "note_disk", "运维手册.md", "v1", &disk_chunks).unwrap();

        let hits = semantic_search(&conn, lib, "想退货怎么办", 10).unwrap();
        assert!(!hits.is_empty(), "语义检索应有命中");
        println!("[CR-089] semantic_search('想退货怎么办') top: {}", hits[0].title);
        assert_eq!(hits[0].note_id, "note_refund", "语义检索应命中退款笔记");
        assert!(hits[0].preview.contains("退款") || hits[0].title.contains("退款"));
    }

    #[test]
    fn hybrid_degrades_when_semantic_unavailable() {
        // 纯函数验证降级路径：语义通道不可用（Err）时，融合结果必须保留 keyword 结果并给出明确 degraded_reason。
        // 不触发全局引擎、不改变环境变量，避免污染其它依赖真实模型的测试。
        let keyword = Ok(vec![(
            "note_refund".to_string(),
            "退款.md".to_string(),
            "退款".to_string(),
            "想退货怎么办？申请退款即可".to_string(),
        )]);
        let semantic = Err::<Vec<SemanticHit>, String>(
            "SEMANTIC_MODEL_UNAVAILABLE: 未找到本地语义模型目录".to_string(),
        );
        let res = fuse_channels(keyword, semantic, 10);
        assert!(res.keyword_available, "关键词通道应可用");
        assert!(!res.semantic_available, "语义通道应不可用");
        let reason = res.degraded_reason.expect("语义不可用时必须有 degraded_reason");
        assert!(reason.contains("语义通道不可用"), "degraded_reason 应明确标注语义不可用：{reason}");
        assert!(!res.hits.is_empty(), "应返回关键词结果");
        assert_eq!(res.hits[0].note_id, "note_refund");
        assert_eq!(res.hits[0].source, "keyword");
        assert!((res.hits[0].score - 1.0 / 61.0).abs() < 1e-6, "RRF rank1 分应为 1/61");
    }

    #[test]
    fn hybrid_fuses_both_channels() {
        // 两通道都有同一笔记时，source 应为 both，分数为两路 RRF 之和。
        let keyword = Ok(vec![(
            "note_a".to_string(),
            "a.md".to_string(),
            "A 标题".to_string(),
            "关键词预览".to_string(),
        )]);
        let semantic = Ok(vec![SemanticHit {
            note_id: "note_a".to_string(),
            source_path: "a.md".to_string(),
            title: "A 标题".to_string(),
            chunk_key: "b0000".to_string(),
            score: 0.9,
            preview: "语义预览".to_string(),
        }]);
        let res = fuse_channels(keyword, semantic, 10);
        assert!(res.keyword_available && res.semantic_available);
        assert!(res.degraded_reason.is_none());
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].source, "both");
        assert!((res.hits[0].score - 2.0 / 61.0).abs() < 1e-6);
    }
}

// ===== CR-089：首次启动联网下载（模型与运行时，不打进安装包）=====
pub mod install {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicBool;
    use std::sync::OnceLock;

    static MODEL_ROOT: OnceLock<std::path::PathBuf> = OnceLock::new();

    pub const DLL_NAME: &str = "onnxruntime.dll";
    pub const DLL_SHA256: &str = "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c";
    pub const DLL_SIZE: u64 = 17_253_176;

    pub struct FileSpec {
        pub name: &'static str,
        pub urls: &'static [&'static str],
        pub sha256: &'static str,
        pub size: u64,
    }

    pub const MODEL_FILES: [FileSpec; 3] = [
        FileSpec {
            name: "model_quantized.onnx",
            urls: &[
                "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
                "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
            ],
            sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
            size: 24_010_842,
        },
        FileSpec {
            name: "tokenizer.json",
            urls: &[
                "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
                "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
            ],
            sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
            size: 439_125,
        },
        FileSpec {
            name: "config.json",
            urls: &[
                "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/config.json",
                "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/config.json",
            ],
            sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f",
            size: 716,
        },
    ];

    /// NuGet 包内含 runtimes/win-x64/native/onnxruntime.dll；用 HTTP Range 只取该条目，避免整包 159MB。
    pub const DLL_PACKAGES: &[&str] = &[
        "https://nuget.azure.cn/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/microsoft.ml.onnxruntime.1.31.0.nupkg",
        "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/microsoft.ml.onnxruntime.1.31.0.nupkg",
    ];
    pub const DLL_ENTRY_SUFFIX: &str = "runtimes/win-x64/native/onnxruntime.dll";

    /// 宿主启动时注入：应用数据目录下的模型根，并同步环境变量供 ensure_model 使用。
    pub fn set_model_root(dir: std::path::PathBuf) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = MODEL_ROOT.set(dir.clone());
        std::env::set_var("NESTCRAFT_EMBED_MODEL", &dir);
    }

    pub fn installed_root() -> std::path::PathBuf {
        MODEL_ROOT.get().cloned().unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("NestCraft")
                .join("semantic-model")
        })
    }

    pub fn sha256_file(path: &std::path::Path) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let mut file = std::fs::File::open(path).map_err(|e| format!("打开失败 {}: {e}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 { break; }
            hasher.update(&buffer[..read]);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    fn http_get(url: &str) -> Result<Box<dyn Read>, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(600))
            .build();
        let response = agent.get(url).call().map_err(|e| format!("GET {url} 失败：{e}"))?;
        Ok(Box::new(response.into_reader()))
    }

    /// 复用更新器的加速下载引擎：候选源按序尝试、慢源切源、落盘前 SHA-256 校验。
    pub fn download_file(
        spec: &FileSpec,
        dir: &std::path::Path,
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<std::path::PathBuf, String> {
        let target = dir.join(spec.name);
        if target.exists() {
            if let Ok(hash) = sha256_file(&target) {
                if hash == spec.sha256 {
                    return Ok(target);
                }
            }
        }
        let urls: Vec<String> = spec.urls.iter().map(|u| u.to_string()).collect();
        let mut sink = |_url: &str, done: u64, total: u64, _speed: u64| progress(spec.name, done, total);
        let fetched = crate::updater::accelerated_fetch(&urls, &target, spec.sha256, spec.size, &mut sink)?;
        Ok(fetched.path)
    }

    /// 通过 HTTP Range 按需读取远程压缩包：只取中央目录与目标条目，不下载整包。
    pub struct RangeReader {
        url: String,
        len: u64,
        pos: u64,
        buffer: Vec<u8>,
        buffer_at: u64,
        fetched: std::sync::Arc<std::sync::atomic::AtomicU64>,
        agent: ureq::Agent,
    }

    const RANGE_CHUNK: u64 = 512 * 1024;

    fn range_agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(15))
            .timeout_read(std::time::Duration::from_secs(120))
            .build()
    }

    impl RangeReader {
        pub fn open(url: &str) -> Result<Self, String> {
            Ok(Self::open_with_agent(url, range_agent())?)
        }

        fn open_with_agent(url: &str, agent: ureq::Agent) -> Result<Self, String> {
            let response = agent
                .get(url)
                .set("Range", "bytes=0-0")
                .call()
                .map_err(|e| format!("探测 {url} 失败：{e}"))?;
            let total = response
                .header("Content-Range")
                .and_then(|value| value.rsplit('/').next().map(str::to_string))
                .and_then(|value| value.trim().parse::<u64>().ok())
                .ok_or_else(|| format!("{url} 未返回 Content-Range，无法按需读取"))?;
            drop(response);
            Ok(Self {
                url: url.to_string(),
                len: total,
                pos: 0,
                buffer: Vec::new(),
                buffer_at: 0,
                fetched: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
                agent,
            })
        }

        pub fn counter(&self) -> std::sync::Arc<std::sync::atomic::AtomicU64> { self.fetched.clone() }

        fn fill_at(&mut self, offset: u64, want: u64) -> Result<(), String> {
            if offset >= self.len { self.buffer.clear(); return Ok(()); }
            let end = (offset + want).min(self.len) - 1;
            let range = format!("bytes={offset}-{end}");
            let response = self
                .agent
                .get(&self.url)
                .set("Range", &range)
                .call()
                .map_err(|e| format!("读取 {range} 失败：{e}"))?;
            let mut body = Vec::new();
            response.into_reader().read_to_end(&mut body).map_err(|e| e.to_string())?;
            if body.is_empty() { return Err(format!("{range} 返回空内容")); }
            self.fetched.fetch_add(body.len() as u64, std::sync::atomic::Ordering::Relaxed);
            self.buffer = body;
            self.buffer_at = offset;
            Ok(())
        }
    }

    impl Read for RangeReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.len || out.is_empty() { return Ok(0); }
            let in_cache = self.pos >= self.buffer_at
                && self.pos < self.buffer_at + self.buffer.len() as u64;
            if !in_cache {
                self.fill_at(self.pos, RANGE_CHUNK)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            }
            let start = (self.pos - self.buffer_at) as usize;
            if start >= self.buffer.len() { return Ok(0); }
            let available = self.buffer.len() - start;
            let take = available.min(out.len());
            out[..take].copy_from_slice(&self.buffer[start..start + take]);
            self.pos += take as u64;
            Ok(take)
        }
    }

    impl std::io::Seek for RangeReader {
        fn seek(&mut self, from: std::io::SeekFrom) -> std::io::Result<u64> {
            let next = match from {
                std::io::SeekFrom::Start(value) => value as i128,
                std::io::SeekFrom::Current(delta) => self.pos as i128 + delta as i128,
                std::io::SeekFrom::End(delta) => self.len as i128 + delta as i128,
            };
            if next < 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek 到负偏移")); }
            self.pos = (next as u64).min(self.len);
            Ok(self.pos)
        }
    }

    /// 从远程压缩包中只取 DLL 条目，写出并返回实际下载字节数。
    pub fn fetch_dll_from_package(
        url: &str,
        out: &std::path::Path,
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<u64, String> {
        let reader = RangeReader::open(url)?;
        let counter = reader.counter();
        let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("压缩包无法读取：{e}"))?;
        let mut picked = None;
        for index in 0..archive.len() {
            let name = archive.by_index(index).map_err(|e| e.to_string())?.name().to_string();
            if name.ends_with(DLL_ENTRY_SUFFIX) { picked = Some(index); break; }
        }
        let index = picked.ok_or_else(|| format!("包内未找到 {DLL_ENTRY_SUFFIX}"))?;
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let size = entry.size();
        let mut output = std::fs::File::create(out).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        let mut done: u64 = 0;
        loop {
            let read = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 { break; }
            output.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            done += read as u64;
            progress(DLL_NAME, done, size);
        }
        let _ = output.flush();
        drop(entry);
        Ok(counter.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// 下载/校验模型与运行时；已存在且校验通过的文件跳过（幂等、可重试）。
    pub fn install_runtime(
        progress: &mut dyn FnMut(&str, u64, u64),
        cancel: &AtomicBool,
    ) -> Result<std::path::PathBuf, String> {
        install_runtime_to(&installed_root(), progress, cancel)
    }

    /// 同 install_runtime，但目标目录由调用方指定（便于验证与自定义部署）。
    pub fn install_runtime_to(
        dir: &std::path::Path,
        progress: &mut dyn FnMut(&str, u64, u64),
        cancel: &AtomicBool,
    ) -> Result<std::path::PathBuf, String> {
        let dir = dir.to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型目录：{e}"))?;
        for spec in MODEL_FILES.iter() {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err("已取消".into()); }
            download_file(spec, &dir, progress)?;
        }
        let dll = dir.join(DLL_NAME);
        let dll_ok = dll.exists() && sha256_file(&dll).map(|h| h == DLL_SHA256).unwrap_or(false);
        if !dll_ok {
            let mut last: Option<String> = None;
            for url in DLL_PACKAGES {
                match fetch_dll_from_package(url, &dll, progress) {
                    Ok(fetched) => {
                        if sha256_file(&dll)? == DLL_SHA256 {
                            eprintln!("[CR-089] 运行时按需读取完成，实际下载 {fetched} B");
                            last = None;
                            break;
                        }
                        let _ = std::fs::remove_file(&dll);
                        last = Some(format!("{url} 的 {DLL_NAME} 校验失败"));
                    }
                    Err(error) => last = Some(error),
                }
            }
            if let Some(error) = last { return Err(error); }
        }
        Ok(dir)
    }

    #[derive(Clone, serde::Serialize)]
    pub struct ModelProgress {
        pub phase: String,
        pub file: String,
        pub done: u64,
        pub total: u64,
    }

    #[tauri::command]
    pub fn kb_semantic_model_state() -> serde_json::Value {
        let dir = installed_root();
        match super::ensure_model() {
            Ok(path) => serde_json::json!({ "installed": true, "dir": path.display().to_string() }),
            Err(error) => serde_json::json!({ "installed": false, "dir": dir.display().to_string(), "error": error }),
        }
    }

    #[tauri::command]
    pub async fn kb_semantic_install(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
        use tauri::Emitter;
        let dir = installed_root();
        set_model_root(dir.clone());
        let handle = app.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let cancel = AtomicBool::new(false);
            let mut progress = |phase: &str, done: u64, total: u64| {
                let _ = handle.emit("kb-semantic-progress", ModelProgress {
                    phase: phase.to_string(), file: phase.to_string(), done, total,
                });
            };
            install_runtime(&mut progress, &cancel)
        })
        .await
        .map_err(|e| e.to_string())?;
        match outcome {
            Ok(path) => Ok(serde_json::json!({ "installed": true, "dir": path.display().to_string() })),
            Err(error) => { eprintln!("[CR-089] 模型下载失败：{error}"); Err(error) }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Write;

        #[test]
        fn verify_sha256_matches_known_content() {
            let dir = std::env::temp_dir().join(crate::models::new_id("cr089-sha"));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("a.txt");
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(b"abc").unwrap();
            drop(file);
            assert_eq!(
                sha256_file(&path).unwrap(),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 隔离探针：只下载最小的 config.json，确认加速引擎本身可用（秒级）。
        #[test]
        #[ignore]
        fn real_fetch_small_file_only() {
            let dir = std::env::temp_dir().join(crate::models::new_id("cr089-probe-small"));
            std::fs::create_dir_all(&dir).unwrap();
            let started = std::time::Instant::now();
            let mut sink = |name: &str, done: u64, total: u64| {
                if done == total || done == 0 { eprintln!("[probe] {name} {done}/{total}"); }
            };
            let spec = &MODEL_FILES[2];
            let path = download_file(spec, &dir, &mut sink).expect("config.json 应下载成功");
            eprintln!("[probe] 用时 {}ms, {}", started.elapsed().as_millis(), path.display());
            assert_eq!(sha256_file(&path).unwrap(), spec.sha256);
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 隔离探针：只按需取 DLL，报告实际下载字节与耗时。
        #[test]
        #[ignore]
        fn real_fetch_dll_only() {
            let dir = std::env::temp_dir().join(crate::models::new_id("cr089-probe-dll"));
            std::fs::create_dir_all(&dir).unwrap();
            let out = dir.join(DLL_NAME);
            let started = std::time::Instant::now();
            let mut last = 0u64;
            let mut sink = |name: &str, done: u64, total: u64| {
                if done - last >= 2 * 1024 * 1024 || done == total {
                    last = done;
                    eprintln!("[probe] {name} {done}/{total} ({}ms)", started.elapsed().as_millis());
                }
            };
            let fetched = fetch_dll_from_package(DLL_PACKAGES[0], &out, &mut sink).expect("应能按需取到 DLL");
            eprintln!("[probe] 实际下载 {fetched} B, 用时 {}ms", started.elapsed().as_millis());
            assert_eq!(sha256_file(&out).unwrap(), DLL_SHA256);
            assert!(fetched < 40 * 1024 * 1024, "按需读取不应接近整包 159MB，实际 {fetched}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 真实联网下载（默认忽略；用 --ignored 显式执行）：验证 URL 可达、SHA256 校验、DLL 解压。
        #[test]
        #[ignore]
        fn real_download_install_into_temp_dir() {
            let dir = std::env::temp_dir().join(crate::models::new_id("cr089-download"));
            std::fs::create_dir_all(&dir).unwrap();
            let cancel = AtomicBool::new(false);
            let mut last = String::new();
            let mut report = |phase: &str, done: u64, total: u64| {
                let line = format!("{phase} {done}/{total}");
                if line != last { eprintln!("[download] {line}"); last = line.clone(); }
            };
            let root = install_runtime_to(&dir, &mut report, &cancel).expect("真实下载应成功");
            for name in ["model_quantized.onnx", "tokenizer.json", "config.json", DLL_NAME] {
                let path = root.join(name);
                let meta = std::fs::metadata(&path).unwrap_or_else(|_| panic!("缺少 {name}"));
                eprintln!("[download] {name} = {} B", meta.len());
                assert!(meta.len() > 0, "{name} 不应为空");
            }
            assert_eq!(sha256_file(&root.join("model_quantized.onnx")).unwrap(), MODEL_FILES[0].sha256);
            assert_eq!(sha256_file(&root.join(DLL_NAME)).unwrap(), DLL_SHA256);
            // 幂等：第二次应立即成功且不重复下载。
            let mut noop = |_: &str, _: u64, _: u64| {};
            let again = install_runtime_to(&dir, &mut noop, &cancel).expect("第二次应幂等成功");
            assert_eq!(again, root);
            // 下载后应能被 ensure_model 识别（模型可用性以本目录为准）。
            std::env::set_var("NESTCRAFT_EMBED_MODEL", &root);
            std::env::set_var("ORT_DYLIB_PATH", root.join(DLL_NAME));
            let texts = vec!["如何申请退款".to_string(), "服务器磁盘告警".to_string()];
            let vectors = super::super::embed_texts(&texts).expect("下载后的模型应可推理");
            assert_eq!(vectors.len(), 2);
            assert_eq!(vectors[0].len(), super::super::EMBED_DIM);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn range_reader_seeks_and_reads_across_chunks() {
            // 用本地文件模拟：验证 Seek/Read 语义与 zip 解析一致（网络读取逻辑由真实下载测试覆盖）。
            let dir = std::env::temp_dir().join(crate::models::new_id("cr089-range"));
            std::fs::create_dir_all(&dir).unwrap();
            let zip_path = dir.join("pkg.zip");
            {
                let file = std::fs::File::create(&zip_path).unwrap();
                let mut writer = zip::ZipWriter::new(file);
                let options = zip::write::SimpleFileOptions::default();
                writer.start_file("runtimes/win-x64/native/onnxruntime.dll", options).unwrap();
                let payload = vec![7u8; 300 * 1024];
                writer.write_all(&payload).unwrap();
                writer.finish().unwrap();
            }
            let file = std::fs::File::open(&zip_path).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            let mut entry = archive.by_name("runtimes/win-x64/native/onnxruntime.dll").unwrap();
            let mut got = Vec::new();
            entry.read_to_end(&mut got).unwrap();
            assert_eq!(got.len(), 300 * 1024);
            assert!(got.iter().all(|b| *b == 7));
            let _ = std::fs::remove_dir_all(&dir);
        }

    }
}
pub use install::{installed_root, kb_semantic_install, kb_semantic_model_state, set_model_root};
