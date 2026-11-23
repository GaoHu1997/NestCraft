//! CR-032 / FEAT-004 / FEAT-005：设计↔代码双向同步的共同基线、批次与写入日志（M0）。
//!
//! 设计依据：docs/DB/DB-CR032-同步基线与语义追踪.md、docs/LLD/LLD-CR032。
//! 本模块只提供**结构化基线、提案批次状态机、逐目标 hash 对账**；不自动解析文档／源码、
//! 不自动写回文件，也不把“保存文档”当成同步完成。第三方修改与未知 hash 一律冲突，
//! 不覆盖人工新稿。

use crate::db;
use crate::models::{new_id, now_ms};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

pub const BATCH_ORIGINS: [&str; 3] = ["document", "code", "recovery"];
pub const BATCH_STATES: [&str; 8] = [
    "prepared",
    "applied_pending_reconcile",
    "reconciled",
    "rejected",
    "conflict",
    "failed",
    "cancelled",
    "staging",
];
pub const JOURNAL_STATES: [&str; 5] = ["staged", "applied", "pending", "conflict", "compensated"];

pub fn batch_transition_allowed(from: &str, to: &str) -> bool {
    if from == to {
        return false;
    }
    matches!(
        (from, to),
        ("prepared", "applied_pending_reconcile")
            | ("prepared", "rejected")
            | ("prepared", "cancelled")
            | ("prepared", "failed")
            | ("prepared", "conflict")
            | ("applied_pending_reconcile", "reconciled")
            | ("applied_pending_reconcile", "conflict")
            | ("applied_pending_reconcile", "failed")
            | ("applied_pending_reconcile", "cancelled")
    )
}

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sync_baseline (
            id                TEXT PRIMARY KEY,
            projectId         TEXT NOT NULL,
            branchRef         TEXT,
            headCommit        TEXT,
            codeManifestRef   TEXT NOT NULL,
            codeManifestHash  TEXT NOT NULL,
            sourceRefsJson    TEXT NOT NULL DEFAULT '[]',
            coverage          TEXT NOT NULL
                              CHECK (coverage IN ('complete-in-scope','partial','unknown')),
            publishedBatchId  TEXT,
            createdAt         INTEGER NOT NULL,
            supersededAt      INTEGER,
            UNIQUE (projectId, codeManifestHash)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_baseline_current
            ON sync_baseline(projectId, supersededAt, createdAt DESC);

        CREATE TABLE IF NOT EXISTS sync_batch (
            id                            TEXT PRIMARY KEY,
            projectId                     TEXT NOT NULL,
            origin                        TEXT NOT NULL
                                          CHECK (origin IN ('document','code','recovery')),
            causationId                   TEXT,
            idempotencyKey                TEXT NOT NULL,
            baseId                        TEXT,
            inputManifestHash             TEXT NOT NULL,
            proposalRef                   TEXT NOT NULL,
            proposalHash                  TEXT NOT NULL,
            requirementDecisionRef        TEXT,
            codingGrantRef                TEXT,
            state                         TEXT NOT NULL DEFAULT 'prepared'
                                          CHECK (state IN ('prepared','applied_pending_reconcile','reconciled','rejected','conflict','failed','cancelled','staging')),
            confirmedDocumentSnapshotRef  TEXT,
            confirmedDocumentSnapshotHash TEXT,
            documentConsistency           TEXT NOT NULL DEFAULT 'pending'
                                          CHECK (documentConsistency IN ('pending','consistent','conflict')),
            codeReconcileState            TEXT NOT NULL DEFAULT 'not_required'
                                          CHECK (codeReconcileState IN ('not_required','pending','verified','failed')),
            createdAt                     INTEGER NOT NULL,
            updatedAt                     INTEGER NOT NULL,
            revision                      INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            UNIQUE (projectId, idempotencyKey)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_batch_project
            ON sync_batch(projectId, createdAt DESC);

        CREATE TABLE IF NOT EXISTS sync_target_journal (
            batchId       TEXT NOT NULL REFERENCES sync_batch(id) ON DELETE RESTRICT,
            targetId      TEXT NOT NULL,
            kind          TEXT NOT NULL CHECK (kind IN ('document','model','code','index')),
            baseRevision  TEXT,
            baseHash      TEXT NOT NULL,
            newRevision   TEXT,
            newHash       TEXT NOT NULL,
            stagingRef    TEXT,
            targetUri     TEXT,
            applyState    TEXT NOT NULL DEFAULT 'staged'
                          CHECK (applyState IN ('staged','applied','pending','conflict','compensated')),
            updatedAt     INTEGER NOT NULL,
            PRIMARY KEY (batchId, targetId)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_journal_state
            ON sync_target_journal(batchId, applyState);
        "#,
    )
    .map_err(|e| e.to_string())?;
    // 旧开发库兼容：targetUri 为增量列。
    let has_target_uri: bool = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(sync_target_journal)")
            .map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        names.iter().any(|n| n == "targetUri")
    };
    if !has_target_uri {
        conn.execute("ALTER TABLE sync_target_journal ADD COLUMN targetUri TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------- 类型 ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BaselineView {
    pub id: String,
    pub project_id: String,
    pub branch_ref: Option<String>,
    pub head_commit: Option<String>,
    pub code_manifest_ref: String,
    pub code_manifest_hash: String,
    pub source_refs: Vec<serde_json::Value>,
    pub coverage: String,
    pub published_batch_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublishBaselineInput {
    pub project_id: String,
    pub branch_ref: Option<String>,
    pub head_commit: Option<String>,
    pub code_manifest_ref: String,
    pub code_manifest_hash: String,
    #[serde(default)]
    pub source_refs: Vec<serde_json::Value>,
    pub coverage: String,
    pub published_batch_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSyncBatchInput {
    pub project_id: String,
    pub origin: String,
    pub causation_id: Option<String>,
    pub idempotency_key: String,
    pub base_id: Option<String>,
    pub input_manifest_hash: String,
    pub proposal_ref: String,
    pub proposal_hash: String,
    pub requirement_decision_ref: Option<String>,
    pub coding_grant_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchView {
    pub id: String,
    pub project_id: String,
    pub origin: String,
    pub state: String,
    pub revision: i64,
    pub base_id: Option<String>,
    pub document_consistency: String,
    pub code_reconcile_state: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub targets: Vec<JournalView>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JournalView {
    pub target_id: String,
    pub kind: String,
    pub base_hash: String,
    pub new_hash: String,
    pub apply_state: String,
    pub target_uri: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StageTargetInput {
    pub batch_id: String,
    pub target_id: String,
    pub kind: String,
    pub base_hash: String,
    pub new_hash: String,
    pub base_revision: Option<String>,
    pub new_revision: Option<String>,
    pub staging_ref: Option<String>,
    /// 要写入的文件路径；与 content 同时给出时可自动生成暂存与 newHash。
    pub target_uri: Option<String>,
    /// 新内容；给出时以其 SHA-256 作为 newHash 并写暂存文件。
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTargetInput {
    pub batch_id: String,
    pub target_id: String,
    pub actual_hash: String,
}

/// 记录一次内容指纹，便于提案与防回环去重（不存正文）。
pub fn content_fingerprint(text: &str) -> String {
    format!("sha256:{}", sha256_hex(text.as_bytes()))
}

// ---------------- 基线 ----------------

pub fn current_baseline(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<BaselineView>, String> {
    conn.query_row(
        "SELECT id, projectId, branchRef, headCommit, codeManifestRef, codeManifestHash, sourceRefsJson, coverage, publishedBatchId, createdAt \
         FROM sync_baseline WHERE projectId=?1 AND supersededAt IS NULL ORDER BY createdAt DESC, id DESC LIMIT 1",
        [project_id],
        row_to_baseline,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn row_to_baseline(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaselineView> {
    let refs_json: String = row.get(6)?;
    Ok(BaselineView {
        id: row.get(0)?,
        project_id: row.get(1)?,
        branch_ref: row.get(2)?,
        head_commit: row.get(3)?,
        code_manifest_ref: row.get(4)?,
        code_manifest_hash: row.get(5)?,
        source_refs: serde_json::from_str(&refs_json).unwrap_or_default(),
        coverage: row.get(7)?,
        published_batch_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

/// 发布共同基线：同项目同 manifest hash 幂等；新基线使旧基线 superseded。
/// publishedBatchId 若给出必须已 reconciled，且本批全部 target 不能仍 conflict。
pub fn publish_baseline(
    conn: &Connection,
    input: &PublishBaselineInput,
) -> Result<BaselineView, String> {
    if !matches!(
        input.coverage.as_str(),
        "complete-in-scope" | "partial" | "unknown"
    ) {
        return Err(format!("未知覆盖度 {}", input.coverage));
    }
    if input.code_manifest_ref.trim().is_empty() || input.code_manifest_hash.trim().is_empty() {
        return Err("代码 manifest 引用与 hash 不能为空".into());
    }
    if input.published_batch_id.is_some() && input.coverage == "unknown" {
        return Err("覆盖度 unknown 不能发布为共同基线".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let project_exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM project WHERE id=?1",
            [&input.project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if project_exists == 0 {
        return Err(format!("项目 {} 不存在", input.project_id));
    }
    if let Some(batch_id) = input.published_batch_id.as_deref() {
        let (state, conflict_count): (String, i64) = tx
            .query_row(
                "SELECT b.state, (SELECT COUNT(*) FROM sync_target_journal j WHERE j.batchId=b.id AND j.applyState='conflict') \
                 FROM sync_batch b WHERE b.id=?1 AND b.projectId=?2",
                rusqlite::params![batch_id, input.project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("批次 {batch_id} 不存在或不属于该项目"))?;
        if state != "reconciled" {
            return Err(format!("批次 {batch_id} 状态为 {state}，未完成对账不能发布基线"));
        }
        if conflict_count > 0 {
            return Err("批次仍存在冲突目标，不能发布基线".into());
        }
    }
    let existing: Option<BaselineView> = tx
        .query_row(
            "SELECT id, projectId, branchRef, headCommit, codeManifestRef, codeManifestHash, sourceRefsJson, coverage, publishedBatchId, createdAt \
             FROM sync_baseline WHERE projectId=?1 AND codeManifestHash=?2",
            rusqlite::params![input.project_id, input.code_manifest_hash],
            row_to_baseline,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(view) = existing {
        return Ok(view);
    }
    let now = now_ms();
    let id = new_id("syncbase");
    tx.execute(
        "UPDATE sync_baseline SET supersededAt=?1 WHERE projectId=?2 AND supersededAt IS NULL",
        rusqlite::params![now, input.project_id],
    )
    .map_err(|e| e.to_string())?;
    let refs_json = serde_json::to_string(&input.source_refs).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sync_baseline (id, projectId, branchRef, headCommit, codeManifestRef, codeManifestHash, sourceRefsJson, coverage, publishedBatchId, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            id,
            input.project_id,
            input.branch_ref,
            input.head_commit,
            input.code_manifest_ref,
            input.code_manifest_hash,
            refs_json,
            input.coverage,
            input.published_batch_id,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    current_baseline(conn, &input.project_id)?
        .ok_or_else(|| "基线发布后读取失败".to_string())
}

// ---------------- 同步批次 ----------------

pub fn read_sync_batch(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
) -> Result<SyncBatchView, String> {
    let (origin, state, revision, base_id, doc_consistency, code_reconcile, created_at, updated_at): (
        String,
        String,
        i64,
        Option<String>,
        String,
        String,
        i64,
        i64,
    ) = conn
        .query_row(
            "SELECT origin, state, revision, baseId, documentConsistency, codeReconcileState, createdAt, updatedAt \
             FROM sync_batch WHERE id=?1 AND projectId=?2",
            rusqlite::params![batch_id, project_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .map_err(|_| format!("同步批次 {batch_id} 不存在或不属于该项目"))?;
    let targets: Vec<JournalView> = {
        let mut stmt = conn
            .prepare(
                "SELECT targetId, kind, baseHash, newHash, applyState, targetUri FROM sync_target_journal \
                 WHERE batchId=?1 ORDER BY targetId",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([batch_id], |r| {
                Ok(JournalView {
                    target_id: r.get(0)?,
                    kind: r.get(1)?,
                    base_hash: r.get(2)?,
                    new_hash: r.get(3)?,
                    apply_state: r.get(4)?,
                    target_uri: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    Ok(SyncBatchView {
        id: batch_id.to_string(),
        project_id: project_id.to_string(),
        origin,
        state,
        revision,
        base_id,
        document_consistency: doc_consistency,
        code_reconcile_state: code_reconcile,
        created_at,
        updated_at,
        targets,
    })
}

/// 创建同步批次。document/code 增量必须引用同项目共同基线；
/// recovery 模式禁止引用基线（纯源码重建不得读取历史同步资料）。
pub fn create_sync_batch(
    conn: &Connection,
    input: &CreateSyncBatchInput,
) -> Result<SyncBatchView, String> {
    if !BATCH_ORIGINS.contains(&input.origin.as_str()) {
        return Err(format!("未知变更来源 {}", input.origin));
    }
    if input.input_manifest_hash.trim().is_empty()
        || input.proposal_ref.trim().is_empty()
        || input.proposal_hash.trim().is_empty()
    {
        return Err("输入 manifest、提案引用与提案 hash 不能为空".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM sync_batch WHERE projectId=?1 AND idempotencyKey=?2",
            rusqlite::params![input.project_id, input.idempotency_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        let view = read_sync_batch(&tx, &input.project_id, &id)?;
        return Ok(view);
    }
    match input.origin.as_str() {
        "recovery" => {
            if input.base_id.is_some() {
                return Err("recovery 模式禁止引用历史共同基线".into());
            }
        }
        _ => {
            let base_id = input
                .base_id
                .as_deref()
                .ok_or_else(|| "document/code 增量必须引用当前共同基线".to_string())?;
            let exists: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM sync_baseline WHERE id=?1 AND projectId=?2 AND supersededAt IS NULL",
                    rusqlite::params![base_id, input.project_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if exists == 0 {
                return Err("引用的共同基线不存在、已替代或不属于该项目".into());
            }
        }
    }
    let id = new_id("syncbatch");
    let now = now_ms();
    tx.execute(
        "INSERT INTO sync_batch (id, projectId, origin, causationId, idempotencyKey, baseId, inputManifestHash, proposalRef, proposalHash, requirementDecisionRef, codingGrantRef, state, createdAt, updatedAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'prepared',?12,?12)",
        rusqlite::params![
            id,
            input.project_id,
            input.origin,
            input.causation_id,
            input.idempotency_key,
            input.base_id,
            input.input_manifest_hash,
            input.proposal_ref,
            input.proposal_hash,
            input.requirement_decision_ref,
            input.coding_grant_ref,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_sync_batch(conn, &input.project_id, &id)
}

/// 决定同步批次：accept 进入应用／对账，reject／cancel 终结。
pub fn decide_sync_batch(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
    expected_revision: i64,
    decision: &str,
) -> Result<SyncBatchView, String> {
    let to = match decision {
        "accept" => "applied_pending_reconcile",
        "reject" => "rejected",
        "cancel" => "cancelled",
        other => return Err(format!("未知决定 {other}")),
    };
    transition_sync_batch(conn, project_id, batch_id, expected_revision, to)
}

fn transition_sync_batch(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
    expected_revision: i64,
    to: &str,
) -> Result<SyncBatchView, String> {
    if !BATCH_STATES.contains(&to) {
        return Err(format!("未知批次状态 {to}"));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (state, revision): (String, i64) = tx
        .query_row(
            "SELECT state, revision FROM sync_batch WHERE id=?1 AND projectId=?2",
            rusqlite::params![batch_id, project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| format!("同步批次 {batch_id} 不存在或不属于该项目"))?;
    if revision != expected_revision {
        return Err(format!(
            "STALE_REVISION：批次当前 revision={revision}，请求={expected_revision}"
        ));
    }
    if !batch_transition_allowed(&state, to) {
        return Err(format!("非法批次状态转换 {state} → {to}"));
    }
    if to == "reconciled" {
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sync_target_journal WHERE batchId=?1 AND applyState NOT IN ('applied','compensated')",
                [batch_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if pending > 0 {
            return Err(format!("仍有 {pending} 个目标未应用或冲突，不能标记 reconciled"));
        }
    }
    tx.execute(
        "UPDATE sync_batch SET state=?1, revision=revision+1, updatedAt=?2 WHERE id=?3 AND projectId=?4",
        rusqlite::params![to, now_ms(), batch_id, project_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_sync_batch(conn, project_id, batch_id)
}

// ---------------- 目标写入日志 ----------------

pub fn stage_target(conn: &Connection, input: &StageTargetInput) -> Result<JournalView, String> {
    if !matches!(input.kind.as_str(), "document" | "model" | "code" | "index") {
        return Err(format!("未知目标类型 {}", input.kind));
    }
    let batch = read_sync_batch(conn, &batch_project(conn, &input.batch_id)?, &input.batch_id)?;
    if batch.state != "prepared" {
        return Err(format!("批次状态 {} 不允许登记目标", batch.state));
    }
    // 给出新内容时，以内容 SHA-256 为准并写暂存；否则沿用调用方提供的受检引用。
    let (new_hash, staging_ref) = if let Some(content) = input.content.as_deref() {
        let dir = std::env::temp_dir()
            .join("agent-workbench-sync-staging")
            .join(&input.batch_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建暂存目录失败：{e}"))?;
        let safe: String = input
            .target_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let file = dir.join(format!("{safe}.staged"));
        std::fs::write(&file, content).map_err(|e| format!("写暂存文件失败：{e}"))?;
        (
            content_fingerprint(content),
            Some(file.to_string_lossy().to_string()),
        )
    } else {
        if input.new_hash.trim().is_empty() {
            return Err("newHash 或 content 必须至少提供一个".into());
        }
        (input.new_hash.clone(), input.staging_ref.clone())
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO sync_target_journal (batchId, targetId, kind, baseRevision, baseHash, newRevision, newHash, stagingRef, targetUri, applyState, updatedAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'staged',?10)",
        rusqlite::params![
            input.batch_id,
            input.target_id,
            input.kind,
            input.base_revision,
            input.base_hash,
            input.new_revision,
            new_hash,
            staging_ref,
            input.target_uri,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(JournalView {
        target_id: input.target_id.clone(),
        kind: input.kind.clone(),
        base_hash: input.base_hash.clone(),
        new_hash,
        apply_state: "staged".into(),
        target_uri: input.target_uri.clone(),
    })
}

fn batch_project(conn: &Connection, batch_id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT projectId FROM sync_batch WHERE id=?1",
        [batch_id],
        |r| r.get(0),
    )
    .map_err(|_| format!("同步批次 {batch_id} 不存在"))
}

/// 按实际内容 hash 对账：等于 new → applied；等于 base → pending（可安全重试）；
/// 其它第三方 hash → conflict，绝不覆盖。
pub fn apply_target(conn: &Connection, input: &ApplyTargetInput) -> Result<SyncBatchView, String> {
    let project_id = batch_project(conn, &input.batch_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (base_hash, new_hash): (String, String) = tx
        .query_row(
            "SELECT baseHash, newHash FROM sync_target_journal WHERE batchId=?1 AND targetId=?2",
            rusqlite::params![input.batch_id, input.target_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("目标 {} 未登记", input.target_id))?;
    let state = if input.actual_hash == new_hash {
        "applied"
    } else if input.actual_hash == base_hash {
        "pending"
    } else {
        "conflict"
    };
    tx.execute(
        "UPDATE sync_target_journal SET applyState=?1, updatedAt=?2 WHERE batchId=?3 AND targetId=?4",
        rusqlite::params![state, now_ms(), input.batch_id, input.target_id],
    )
    .map_err(|e| e.to_string())?;
    if state == "conflict" {
        tx.execute(
            "UPDATE sync_batch SET state='conflict', revision=revision+1, updatedAt=?1 WHERE id=?2",
            rusqlite::params![now_ms(), input.batch_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_sync_batch(conn, &project_id, &input.batch_id)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteTargetInput {
    pub project_id: String,
    pub batch_id: String,
    pub target_id: String,
}

/// 目标文件必须 canonicalize 后仍位于项目根内，防目录穿越与符号链接越界。
fn ensure_within(root: &str, target: &str) -> Result<(), String> {
    let root_canon = std::fs::canonicalize(root).map_err(|e| format!("项目根不可访问：{e}"))?;
    let target_canon =
        std::fs::canonicalize(target).map_err(|e| format!("目标文件不可访问：{e}"))?;
    let r = root_canon.to_string_lossy().to_lowercase();
    let t = target_canon.to_string_lossy().to_lowercase();
    if !t.starts_with(&r) {
        return Err("目标文件必须位于项目目录内".into());
    }
    Ok(())
}

/// 同目录临时文件 + rename。Windows 目标已存在时 rename 失败，回退为直接写；
/// 非严格原子，但写入后会复核 hash，异常时保留冲突而不谎报成功。
fn atomic_replace(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("sync-tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写临时文件失败：{e}"))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, content).map_err(|e| format!("写目标文件失败：{e}"))
        }
    }
}

/// 从暂存写入目标：只有磁盘仍是 base 时才替换；已是 new 视为已应用；
/// 其它第三方 hash 记 conflict，不覆盖人工新稿。
pub fn write_target(conn: &Connection, input: &WriteTargetInput) -> Result<SyncBatchView, String> {
    let (base_hash, new_hash, staging_ref, target_uri, apply_state): (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    ) = conn
        .query_row(
            "SELECT baseHash, newHash, stagingRef, targetUri, applyState FROM sync_target_journal \
             WHERE batchId=?1 AND targetId=?2",
            rusqlite::params![input.batch_id, input.target_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("目标 {} 未登记", input.target_id))?;
    if apply_state == "conflict" {
        return Err("目标已冲突，需人工核对后再推进".into());
    }
    if apply_state == "applied" {
        return read_sync_batch(conn, &input.project_id, &input.batch_id);
    }
    let uri = target_uri.ok_or("目标未登记文件路径，不能写入")?;
    let root: String = conn
        .query_row(
            "SELECT rootUri FROM project WHERE id=?1",
            [&input.project_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("项目 {} 不存在", input.project_id))?;
    ensure_within(&root, &uri)?;
    let current = std::fs::read_to_string(&uri).map_err(|e| format!("读取目标失败：{e}"))?;
    let actual = content_fingerprint(&current);
    let state = if actual == base_hash {
        let staging = staging_ref.ok_or("缺少暂存内容，无法写入")?;
        let content = std::fs::read_to_string(&staging).map_err(|e| format!("读取暂存失败：{e}"))?;
        if content_fingerprint(&content) != new_hash {
            return Err("暂存内容与登记的 newHash 不一致，拒绝写入".into());
        }
        atomic_replace(std::path::Path::new(&uri), &content)?;
        let after = content_fingerprint(
            &std::fs::read_to_string(&uri).map_err(|e| format!("写入后读取失败：{e}"))?,
        );
        if after != new_hash {
            return Err("写入后内容 hash 不符，需人工核对".into());
        }
        "applied"
    } else if actual == new_hash {
        "applied"
    } else {
        "conflict"
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE sync_target_journal SET applyState=?1, updatedAt=?2 WHERE batchId=?3 AND targetId=?4",
        rusqlite::params![state, now_ms(), input.batch_id, input.target_id],
    )
    .map_err(|e| e.to_string())?;
    if state == "conflict" {
        tx.execute(
            "UPDATE sync_batch SET state='conflict', revision=revision+1, updatedAt=?1 WHERE id=?2",
            rusqlite::params![now_ms(), input.batch_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_sync_batch(conn, &input.project_id, &input.batch_id)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileSummary {
    pub checked: i64,
    pub applied: i64,
    pub pending: i64,
    pub conflict: i64,
    pub skipped: i64,
}

fn set_journal_state(
    conn: &Connection,
    batch_id: &str,
    target_id: &str,
    state: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_target_journal SET applyState=?1, updatedAt=?2 WHERE batchId=?3 AND targetId=?4",
        rusqlite::params![state, now_ms(), batch_id, target_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 崩溃／中断后的只读对账：按目标文件的**实际 hash** 回填 journal 状态。
/// 已写出 new → applied；仍是 base → pending；第三方 → conflict 并使批次冲突。
/// 不重写文件、不删除用户内容、不自动 reconciled。
pub fn reconcile_pending(
    conn: &Connection,
    project_id: &str,
) -> Result<ReconcileSummary, String> {
    let batches: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM sync_batch WHERE projectId=?1 \
                 AND state IN ('prepared','applied_pending_reconcile') ORDER BY createdAt",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let mut summary = ReconcileSummary {
        checked: 0,
        applied: 0,
        pending: 0,
        conflict: 0,
        skipped: 0,
    };
    for batch_id in batches {
        let targets: Vec<(String, String, String, Option<String>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT targetId, baseHash, newHash, targetUri FROM sync_target_journal \
                     WHERE batchId=?1 AND applyState IN ('staged','pending','applied')",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([&batch_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        let mut batch_conflict = false;
        for (target_id, base_hash, new_hash, uri) in targets {
            summary.checked += 1;
            let Some(uri) = uri else {
                summary.skipped += 1;
                continue;
            };
            let actual = match std::fs::read_to_string(&uri) {
                Ok(content) => content_fingerprint(&content),
                // 文件不可读：无法判定，保留 pending 等待人工处理。
                Err(_) => {
                    summary.pending += 1;
                    set_journal_state(conn, &batch_id, &target_id, "pending")?;
                    continue;
                }
            };
            let state = if actual == new_hash {
                "applied"
            } else if actual == base_hash {
                "pending"
            } else {
                "conflict"
            };
            set_journal_state(conn, &batch_id, &target_id, state)?;
            match state {
                "applied" => summary.applied += 1,
                "pending" => summary.pending += 1,
                _ => {
                    summary.conflict += 1;
                    batch_conflict = true;
                }
            }
        }
        if batch_conflict {
            conn.execute(
                "UPDATE sync_batch SET state='conflict', revision=revision+1, updatedAt=?1 \
                 WHERE id=?2 AND state IN ('prepared','applied_pending_reconcile')",
                rusqlite::params![now_ms(), batch_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(summary)
}

/// 全部目标已应用后标记对账完成（不自动发布基线、不自动验收）。
pub fn mark_reconciled(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
    expected_revision: i64,
) -> Result<SyncBatchView, String> {
    transition_sync_batch(conn, project_id, batch_id, expected_revision, "reconciled")
}

// ---------------- Tauri 命令 ----------------

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    f(conn)
}

#[tauri::command]
pub fn sync_baseline_current(project_id: String) -> Result<Option<BaselineView>, String> {
    with_conn(|conn| current_baseline(conn, &project_id))
}

#[tauri::command]
pub fn sync_baseline_publish(input: PublishBaselineInput) -> Result<BaselineView, String> {
    with_conn(|conn| publish_baseline(conn, &input))
}

#[tauri::command]
pub fn sync_batch_create(input: CreateSyncBatchInput) -> Result<SyncBatchView, String> {
    with_conn(|conn| create_sync_batch(conn, &input))
}

#[tauri::command]
pub fn sync_batch_get(project_id: String, batch_id: String) -> Result<SyncBatchView, String> {
    with_conn(|conn| read_sync_batch(conn, &project_id, &batch_id))
}

#[tauri::command]
pub fn sync_batch_decide(
    project_id: String,
    batch_id: String,
    expected_revision: i64,
    decision: String,
) -> Result<SyncBatchView, String> {
    with_conn(|conn| decide_sync_batch(conn, &project_id, &batch_id, expected_revision, &decision))
}

#[tauri::command]
pub fn sync_target_stage(input: StageTargetInput) -> Result<JournalView, String> {
    with_conn(|conn| stage_target(conn, &input))
}

#[tauri::command]
pub fn sync_target_apply(input: ApplyTargetInput) -> Result<SyncBatchView, String> {
    with_conn(|conn| apply_target(conn, &input))
}

#[tauri::command]
pub fn sync_target_write(input: WriteTargetInput) -> Result<SyncBatchView, String> {
    with_conn(|conn| write_target(conn, &input))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchSummary {
    pub id: String,
    pub origin: String,
    pub state: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub target_count: i64,
    pub conflict_count: i64,
}

pub fn list_sync_batches(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<SyncBatchSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.origin, b.state, b.revision, b.createdAt, b.updatedAt, \
                    (SELECT COUNT(*) FROM sync_target_journal j WHERE j.batchId=b.id), \
                    (SELECT COUNT(*) FROM sync_target_journal j WHERE j.batchId=b.id AND j.applyState='conflict') \
             FROM sync_batch b WHERE b.projectId=?1 ORDER BY b.createdAt DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok(SyncBatchSummary {
                id: r.get(0)?,
                origin: r.get(1)?,
                state: r.get(2)?,
                revision: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                target_count: r.get(6)?,
                conflict_count: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// same | add | remove
    pub kind: String,
    pub text: String,
}

/// 行级 LCS 差异：以当前内容为旧、提案为新。超过 4M 单元格或截断时不计算。
pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    if a.len() * b.len() > 4_000_000 {
        return Vec::new();
    }
    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(DiffLine { kind: "same".into(), text: a[i].into() });
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            out.push(DiffLine { kind: "remove".into(), text: a[i].into() });
            i += 1;
        } else {
            out.push(DiffLine { kind: "add".into(), text: b[j].into() });
            j += 1;
        }
    }
    while i < n {
        out.push(DiffLine { kind: "remove".into(), text: a[i].into() });
        i += 1;
    }
    while j < m {
        out.push(DiffLine { kind: "add".into(), text: b[j].into() });
        j += 1;
    }
    out
}

/// 语义差异（弱化版）：只比较 Markdown 标题与 AC 编号集合，不做完整语义解析。
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDelta {
    pub added_headings: Vec<String>,
    pub removed_headings: Vec<String>,
    pub added_acs: Vec<String>,
    pub removed_acs: Vec<String>,
}

fn markdown_headings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('#') {
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let rest = trimmed[hashes..].trim_start();
        if !rest.is_empty() {
            out.push(rest.to_string());
        }
    }
    out
}

fn ac_tokens(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] == b"AC-" {
            let mut j = i + 3;
            let mut token = String::from("AC-");
            while j < bytes.len() {
                let c = bytes[j] as char;
                if c.is_ascii_alphanumeric() || c == '-' {
                    token.push(c);
                    j += 1;
                } else {
                    break;
                }
            }
            if token.len() > 3 {
                out.push(token);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn semantic_delta(old: &str, new: &str) -> SemanticDelta {
    let old_headings = markdown_headings(old);
    let new_headings = markdown_headings(new);
    let old_acs = ac_tokens(old);
    let new_acs = ac_tokens(new);
    SemanticDelta {
        added_headings: new_headings
            .iter()
            .filter(|item| !old_headings.contains(item))
            .cloned()
            .collect(),
        removed_headings: old_headings
            .iter()
            .filter(|item| !new_headings.contains(item))
            .cloned()
            .collect(),
        added_acs: new_acs
            .iter()
            .filter(|item| !old_acs.contains(item))
            .cloned()
            .collect(),
        removed_acs: old_acs
            .iter()
            .filter(|item| !new_acs.contains(item))
            .cloned()
            .collect(),
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TargetPreview {
    pub target_id: String,
    pub target_uri: Option<String>,
    pub base_hash: String,
    pub new_hash: String,
    pub apply_state: String,
    pub current_hash: Option<String>,
    pub current_matches_base: bool,
    pub current_matches_new: bool,
    pub current_text: Option<String>,
    pub staged_text: Option<String>,
    pub diff: Vec<DiffLine>,
    pub semantic: SemanticDelta,
    pub truncated: bool,
}

const PREVIEW_LIMIT: usize = 20_000;

fn truncate_preview(text: String) -> (String, bool) {
    if text.chars().count() > PREVIEW_LIMIT {
        (text.chars().take(PREVIEW_LIMIT).collect(), true)
    } else {
        (text, false)
    }
}

/// 只读预览：返回目标当前内容、暂存内容与三态匹配，不写文件、不改状态。
pub fn preview_target(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
    target_id: &str,
) -> Result<TargetPreview, String> {
    let (base_hash, new_hash, staging_ref, target_uri, apply_state): (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    ) = conn
        .query_row(
            "SELECT baseHash, newHash, stagingRef, targetUri, applyState FROM sync_target_journal \
             WHERE batchId=?1 AND targetId=?2",
            rusqlite::params![batch_id, target_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("目标 {target_id} 未登记"))?;
    let mut current_hash: Option<String> = None;
    let mut current_text: Option<String> = None;
    let mut truncated = false;
    if let Some(uri) = target_uri.as_deref() {
        let root: String = conn
            .query_row(
                "SELECT rootUri FROM project WHERE id=?1",
                [project_id],
                |r| r.get(0),
            )
            .map_err(|_| format!("项目 {project_id} 不存在"))?;
        if std::path::Path::new(uri).exists() {
            ensure_within(&root, uri)?;
            let full = std::fs::read_to_string(uri).map_err(|e| format!("读取目标失败：{e}"))?;
            current_hash = Some(content_fingerprint(&full));
            let (text, cut) = truncate_preview(full);
            current_text = Some(text);
            truncated |= cut;
        }
    }
    let staged_text = if let Some(staging) = staging_ref.as_deref() {
        match std::fs::read_to_string(staging) {
            Ok(text) => {
                let (view, cut) = truncate_preview(text);
                truncated |= cut;
                Some(view)
            }
            Err(_) => None,
        }
    } else {
        None
    };
    let diff = match (&current_text, &staged_text) {
        (Some(current), Some(staged)) if !truncated => line_diff(current, staged),
        _ => Vec::new(),
    };
    let semantic = match (&current_text, &staged_text) {
        (Some(current), Some(staged)) if !truncated => semantic_delta(current, staged),
        _ => SemanticDelta::default(),
    };
    Ok(TargetPreview {
        target_id: target_id.to_string(),
        target_uri,
        current_matches_base: current_hash.as_deref() == Some(base_hash.as_str()),
        current_matches_new: current_hash.as_deref() == Some(new_hash.as_str()),
        base_hash,
        new_hash,
        apply_state,
        current_hash,
        current_text,
        staged_text,
        diff,
        semantic,
        truncated,
    })
}

#[tauri::command]
pub fn sync_target_preview(
    project_id: String,
    batch_id: String,
    target_id: String,
) -> Result<TargetPreview, String> {
    with_conn(|conn| preview_target(conn, &project_id, &batch_id, &target_id))
}

#[tauri::command]
pub fn sync_batch_list(project_id: String) -> Result<Vec<SyncBatchSummary>, String> {
    with_conn(|conn| list_sync_batches(conn, &project_id))
}

/// 从已对账批次发布共同基线：manifest 由目标 newHash 排序聚合，幂等。
pub fn publish_baseline_from_batch(
    conn: &Connection,
    project_id: &str,
    batch_id: &str,
) -> Result<BaselineView, String> {
    let batch = read_sync_batch(conn, project_id, batch_id)?;
    if batch.state != "reconciled" {
        return Err(format!(
            "批次状态 {} 未完成对账，不能发布基线",
            batch.state
        ));
    }
    if batch.targets.iter().any(|target| target.apply_state == "conflict") {
        return Err("批次仍有冲突目标，不能发布基线".into());
    }
    let mut entries: Vec<String> = batch
        .targets
        .iter()
        .map(|target| format!("{}:{}", target.target_id, target.new_hash))
        .collect();
    entries.sort();
    let manifest = format!("sha256:{}", sha256_hex(entries.join("|").as_bytes()));
    let source_refs: Vec<serde_json::Value> = batch
        .targets
        .iter()
        .map(|target| serde_json::json!({"id": target.target_id, "hash": target.new_hash}))
        .collect();
    publish_baseline(
        conn,
        &PublishBaselineInput {
            project_id: project_id.to_string(),
            branch_ref: None,
            head_commit: None,
            code_manifest_ref: format!("batch:{batch_id}"),
            code_manifest_hash: manifest,
            source_refs,
            coverage: "complete-in-scope".into(),
            published_batch_id: Some(batch_id.to_string()),
        },
    )
}

#[tauri::command]
pub fn sync_publish_baseline(
    project_id: String,
    batch_id: String,
) -> Result<BaselineView, String> {
    with_conn(|conn| publish_baseline_from_batch(conn, &project_id, &batch_id))
}

#[tauri::command]
pub fn sync_reconcile_pending(project_id: String) -> Result<ReconcileSummary, String> {
    with_conn(|conn| reconcile_pending(conn, &project_id))
}

#[tauri::command]
pub fn sync_batch_reconcile(
    project_id: String,
    batch_id: String,
    expected_revision: i64,
) -> Result<SyncBatchView, String> {
    with_conn(|conn| mark_reconciled(conn, &project_id, &batch_id, expected_revision))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, rootUri TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
             INSERT INTO project VALUES ('p1','P','code','C:/p',1,1);",
        )
        .unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn fixture_with_root() -> (Connection, std::path::PathBuf) {
        let conn = fixture();
        let root = std::env::temp_dir()
            .join(format!("sync-root-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        conn.execute(
            "UPDATE project SET rootUri=?1 WHERE id='p1'",
            [root.to_string_lossy().to_string()],
        )
        .unwrap();
        (conn, root)
    }

    fn batch_for(conn: &Connection, key: &str, baseline_id: &str) -> SyncBatchView {
        create_sync_batch(
            conn,
            &CreateSyncBatchInput {
                project_id: "p1".into(),
                origin: "document".into(),
                causation_id: None,
                idempotency_key: key.into(),
                base_id: Some(baseline_id.to_string()),
                input_manifest_hash: "sha256:in".into(),
                proposal_ref: format!("proposal:{key}"),
                proposal_hash: "sha256:prop".into(),
                requirement_decision_ref: None,
                coding_grant_ref: None,
            },
        )
        .unwrap()
    }

    fn baseline_input(hash: &str) -> PublishBaselineInput {
        PublishBaselineInput {
            project_id: "p1".into(),
            branch_ref: Some("refs/heads/main".into()),
            head_commit: Some("abc".into()),
            code_manifest_ref: "manifest:code-1".into(),
            code_manifest_hash: hash.into(),
            source_refs: vec![serde_json::json!({"id":"FEAT-001","hash":"sha256:doc"})],
            coverage: "complete-in-scope".into(),
            published_batch_id: None,
        }
    }

    #[test]
    fn baseline_publish_supersedes_previous_and_is_idempotent() {
        let conn = fixture();
        let first = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        assert_eq!(first.coverage, "complete-in-scope");
        assert_eq!(current_baseline(&conn, "p1").unwrap().unwrap().id, first.id);

        let again = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        assert_eq!(again.id, first.id, "同 manifest hash 必须幂等");

        let second = publish_baseline(&conn, &baseline_input("sha256:c2")).unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(current_baseline(&conn, "p1").unwrap().unwrap().id, second.id);
        let superseded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_baseline WHERE id=?1 AND supersededAt IS NOT NULL",
                [&first.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(superseded, 1);
    }

    #[test]
    fn document_batch_requires_current_baseline_and_recovery_forbids_it() {
        let conn = fixture();
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let base = CreateSyncBatchInput {
            project_id: "p1".into(),
            origin: "document".into(),
            causation_id: Some("cause-1".into()),
            idempotency_key: "req-1".into(),
            base_id: Some(baseline.id.clone()),
            input_manifest_hash: "sha256:in".into(),
            proposal_ref: "proposal:1".into(),
            proposal_hash: "sha256:prop".into(),
            requirement_decision_ref: Some("decision:1".into()),
            coding_grant_ref: None,
        };
        let batch = create_sync_batch(&conn, &base).unwrap();
        assert_eq!(batch.state, "prepared");
        assert_eq!(create_sync_batch(&conn, &base).unwrap().id, batch.id, "同幂等键复用");

        let mut no_base = base.clone();
        no_base.idempotency_key = "req-2".into();
        no_base.base_id = None;
        assert!(create_sync_batch(&conn, &no_base).unwrap_err().contains("共同基线"));

        let recovery = CreateSyncBatchInput {
            project_id: "p1".into(),
            origin: "recovery".into(),
            causation_id: None,
            idempotency_key: "req-3".into(),
            base_id: Some(baseline.id.clone()),
            input_manifest_hash: "sha256:in".into(),
            proposal_ref: "proposal:3".into(),
            proposal_hash: "sha256:prop3".into(),
            requirement_decision_ref: None,
            coding_grant_ref: None,
        };
        assert!(create_sync_batch(&conn, &recovery).unwrap_err().contains("禁止引用"));
    }

    #[test]
    fn journal_detects_third_party_hash_and_blocks_reconcile() {
        let conn = fixture();
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = create_sync_batch(
            &conn,
            &CreateSyncBatchInput {
                project_id: "p1".into(),
                origin: "document".into(),
                causation_id: None,
                idempotency_key: "req-1".into(),
                base_id: Some(baseline.id.clone()),
                input_manifest_hash: "sha256:in".into(),
                proposal_ref: "proposal:1".into(),
                proposal_hash: "sha256:prop".into(),
                requirement_decision_ref: None,
                coding_grant_ref: None,
            },
        )
        .unwrap();
        stage_target(
            &conn,
            &StageTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                kind: "document".into(),
                base_hash: "sha256:base".into(),
                new_hash: "sha256:new".into(),
                base_revision: None,
                new_revision: None,
                staging_ref: Some("staging:1".into()),
                target_uri: None,
                content: None,
            },
        )
        .unwrap();
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        let after_accept = read_sync_batch(&conn, "p1", &batch.id).unwrap();
        assert_eq!(after_accept.state, "applied_pending_reconcile");

        // 第三方内容：既不是 base 也不是 new → conflict。
        let conflicted = apply_target(
            &conn,
            &ApplyTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                actual_hash: "sha256:third-party".into(),
            },
        )
        .unwrap();
        assert_eq!(conflicted.state, "conflict");
        assert!(decide_sync_batch(&conn, "p1", &batch.id, conflicted.revision, "accept").is_err());
    }

    #[test]
    fn applied_targets_reconcile_then_publish_new_baseline() {
        let conn = fixture();
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = create_sync_batch(
            &conn,
            &CreateSyncBatchInput {
                project_id: "p1".into(),
                origin: "document".into(),
                causation_id: None,
                idempotency_key: "req-1".into(),
                base_id: Some(baseline.id.clone()),
                input_manifest_hash: "sha256:in".into(),
                proposal_ref: "proposal:1".into(),
                proposal_hash: "sha256:prop".into(),
                requirement_decision_ref: None,
                coding_grant_ref: None,
            },
        )
        .unwrap();
        stage_target(
            &conn,
            &StageTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                kind: "document".into(),
                base_hash: "sha256:base".into(),
                new_hash: "sha256:new".into(),
                base_revision: None,
                new_revision: None,
                staging_ref: None,
                target_uri: None,
                content: None,
            },
        )
        .unwrap();
        let accepted = decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        // 未应用前不能 reconcile。
        assert!(mark_reconciled(&conn, "p1", &batch.id, accepted.revision).is_err());

        let applied = apply_target(
            &conn,
            &ApplyTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                actual_hash: "sha256:new".into(),
            },
        )
        .unwrap();
        assert_eq!(applied.targets[0].apply_state, "applied");
        let reconciled = mark_reconciled(&conn, "p1", &batch.id, applied.revision).unwrap();
        assert_eq!(reconciled.state, "reconciled");

        let mut next = baseline_input("sha256:c2");
        next.published_batch_id = Some(batch.id.clone());
        let published = publish_baseline(&conn, &next).unwrap();
        assert_eq!(published.published_batch_id.as_deref(), Some(batch.id.as_str()));
    }

    fn stage_doc(
        conn: &Connection,
        batch_id: &str,
        target: &std::path::Path,
        base_hash: String,
        new_content: &str,
    ) -> JournalView {
        stage_target(
            conn,
            &StageTargetInput {
                batch_id: batch_id.into(),
                target_id: "STORY-001".into(),
                kind: "document".into(),
                base_hash,
                new_hash: String::new(),
                base_revision: None,
                new_revision: None,
                staging_ref: None,
                target_uri: Some(target.to_string_lossy().to_string()),
                content: Some(new_content.into()),
            },
        )
        .unwrap()
    }

    #[test]
    fn staged_content_writes_only_when_target_is_unchanged() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash, "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();

        let written = write_target(
            &conn,
            &WriteTargetInput {
                project_id: "p1".into(),
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
            },
        )
        .unwrap();
        assert_eq!(written.targets[0].apply_state, "applied");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new body");
        let stored = content_fingerprint("new body");
        assert_eq!(written.targets[0].new_hash, stored);
    }

    #[test]
    fn third_party_edit_is_reported_as_conflict_and_not_overwritten() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash, "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();

        // 人工在同步前改了目标：既不是 base 也不是 new。
        std::fs::write(&target, "third party edit").unwrap();
        let result = write_target(
            &conn,
            &WriteTargetInput {
                project_id: "p1".into(),
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
            },
        )
        .unwrap();
        assert_eq!(result.state, "conflict");
        assert_eq!(result.targets[0].apply_state, "conflict");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "third party edit",
            "冲突时不得覆盖人工新稿"
        );
    }

    #[test]
    fn sync_batch_list_reports_target_and_conflict_counts() {
        let (conn, _root) = fixture_with_root();
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_target(
            &conn,
            &StageTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                kind: "document".into(),
                base_hash: "sha256:base".into(),
                new_hash: "sha256:new".into(),
                base_revision: None,
                new_revision: None,
                staging_ref: None,
                target_uri: None,
                content: None,
            },
        )
        .unwrap();
        let list = list_sync_batches(&conn, "p1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, batch.id);
        assert_eq!(list[0].target_count, 1);
        assert_eq!(list[0].conflict_count, 0);
    }

    #[test]
    fn reconcile_pending_recovers_write_happened_before_record() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash, "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        // 进程在写文件后、更新 DB 前中断：文件已是 new，journal 仍 staged。
        std::fs::write(&target, "new body").unwrap();

        let summary = reconcile_pending(&conn, "p1").unwrap();
        assert_eq!(summary.applied, 1);
        assert_eq!(summary.conflict, 0);
        let after = read_sync_batch(&conn, "p1", &batch.id).unwrap();
        assert_eq!(after.targets[0].apply_state, "applied");
        let reconciled = mark_reconciled(&conn, "p1", &batch.id, after.revision).unwrap();
        assert_eq!(reconciled.state, "reconciled");
    }

    #[test]
    fn reconcile_pending_marks_third_party_as_conflict() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash, "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        std::fs::write(&target, "third party").unwrap();

        let summary = reconcile_pending(&conn, "p1").unwrap();
        assert_eq!(summary.conflict, 1);
        let after = read_sync_batch(&conn, "p1", &batch.id).unwrap();
        assert_eq!(after.state, "conflict");
        assert_eq!(after.targets[0].apply_state, "conflict");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "third party");
    }

    #[test]
    fn target_preview_reports_current_and_staged_without_writing() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash.clone(), "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();

        let preview = preview_target(&conn, "p1", &batch.id, "STORY-001").unwrap();
        assert_eq!(preview.current_hash.as_deref(), Some(base_hash.as_str()));
        assert!(preview.current_matches_base);
        assert!(!preview.current_matches_new);
        assert_eq!(preview.current_text.as_deref(), Some("base body"));
        assert_eq!(preview.staged_text.as_deref(), Some("new body"));
        let kinds: Vec<&str> = preview.diff.iter().map(|d| d.kind.as_str()).collect();
        assert!(kinds.contains(&"remove"));
        assert!(kinds.contains(&"add"));
        // 只读：磁盘未被改写。
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "base body");
    }

    #[test]
    fn line_diff_marks_same_add_remove() {
        let diff = line_diff("a\nb", "a\nc");
        assert_eq!(diff.len(), 3);
        assert_eq!(diff[0].kind, "same");
        assert_eq!(diff[0].text, "a");
        assert_eq!(diff[1].kind, "remove");
        assert_eq!(diff[1].text, "b");
        assert_eq!(diff[2].kind, "add");
        assert_eq!(diff[2].text, "c");
    }

    #[test]
    fn semantic_delta_reports_headings_and_acs() {
        let delta = semantic_delta(
            "# 范围\n## 旧章节\nAC-1 描述",
            "# 范围\n## 新章节\nAC-1 描述\nAC-2 新增",
        );
        assert_eq!(delta.added_headings, vec!["新章节".to_string()]);
        assert_eq!(delta.removed_headings, vec!["旧章节".to_string()]);
        assert!(delta.added_acs.contains(&"AC-2".to_string()));
        assert!(delta.removed_acs.is_empty());
    }

    #[test]
    fn target_preview_detects_third_party_content() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-001.md");
        std::fs::write(&target, "base body").unwrap();
        let base_hash = content_fingerprint("base body");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);
        stage_doc(&conn, &batch.id, &target, base_hash, "new body");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        std::fs::write(&target, "third party").unwrap();

        let preview = preview_target(&conn, "p1", &batch.id, "STORY-001").unwrap();
        assert!(!preview.current_matches_base);
        assert!(!preview.current_matches_new);
        assert_eq!(preview.current_text.as_deref(), Some("third party"));
    }

    #[test]
    fn publish_baseline_from_batch_requires_reconciled_and_is_idempotent() {
        let (conn, root) = fixture_with_root();
        let target = root.join("STORY-002.md");
        std::fs::write(&target, "base").unwrap();
        let base_hash = content_fingerprint("base");
        let baseline = publish_baseline(&conn, &baseline_input("sha256:c1")).unwrap();
        let batch = batch_for(&conn, "req-1", &baseline.id);

        // 未对账不能发布。
        assert!(publish_baseline_from_batch(&conn, "p1", &batch.id)
            .unwrap_err()
            .contains("未完成对账"));

        stage_doc(&conn, &batch.id, &target, base_hash.clone(), "new");
        decide_sync_batch(&conn, "p1", &batch.id, batch.revision, "accept").unwrap();
        let applied = apply_target(
            &conn,
            &ApplyTargetInput {
                batch_id: batch.id.clone(),
                target_id: "STORY-001".into(),
                actual_hash: content_fingerprint("new"),
            },
        )
        .unwrap();
        let reconciled = mark_reconciled(&conn, "p1", &batch.id, applied.revision).unwrap();
        assert_eq!(reconciled.state, "reconciled");

        let published = publish_baseline_from_batch(&conn, "p1", &batch.id).unwrap();
        assert_eq!(published.published_batch_id.as_deref(), Some(batch.id.as_str()));
        assert_eq!(published.coverage, "complete-in-scope");
        let again = publish_baseline_from_batch(&conn, "p1", &batch.id).unwrap();
        assert_eq!(again.id, published.id, "同批次重复发布应幂等");
        let current = current_baseline(&conn, "p1").unwrap().unwrap();
        assert_eq!(current.id, published.id);
    }
}