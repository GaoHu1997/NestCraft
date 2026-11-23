//! CR-047 / FEAT-019：任务执行账本、工作包义务与检查点（M0 持久化地基）。
//!
//! 设计依据：docs/DB/DB-FEAT-019、docs/DB/DB-CR047、docs/LLD/LLD-R004。
//! 本模块只提供受管存储、状态机校验、租约/fence CAS 与依赖 gate；**不 spawn CLI、
//! 不创建 worktree、不做进程监督、不冒充真实执行**。M0 的 fake runner 只能消费
//! 这里的状态，真实 M1 仍需 G-PLAN/G-CAP/G-RUN 等门禁。

use crate::db;
use crate::models::{new_id, now_ms};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// 任务状态集合（DB-FEAT-019 §3）。终态：succeeded / cancelled / failed。
pub const TASK_STATUSES: [&str; 13] = [
    "queued",
    "waiting_dependency",
    "waiting_resource",
    "preparing",
    "running",
    "verifying",
    "integrating",
    "succeeded",
    "retry_wait",
    "blocked",
    "paused",
    "cancelled",
    "failed",
];

pub fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "cancelled" | "failed")
}

/// 状态转换白名单。暂停/可恢复 blocked 保 activeKey；终态不可原地改回运行态。
pub fn transition_allowed(from: &str, to: &str) -> bool {
    if from == to {
        return false;
    }
    matches!(
        (from, to),
        ("queued", "waiting_dependency")
            | ("queued", "waiting_resource")
            | ("queued", "preparing")
            | ("queued", "cancelled")
            | ("waiting_dependency", "waiting_resource")
            | ("waiting_dependency", "preparing")
            | ("waiting_dependency", "blocked")
            | ("waiting_dependency", "cancelled")
            | ("waiting_dependency", "failed")
            | ("waiting_resource", "preparing")
            | ("waiting_resource", "blocked")
            | ("waiting_resource", "cancelled")
            | ("waiting_resource", "failed")
            | ("preparing", "running")
            | ("preparing", "retry_wait")
            | ("preparing", "blocked")
            | ("preparing", "cancelled")
            | ("preparing", "failed")
            | ("running", "verifying")
            | ("running", "retry_wait")
            | ("running", "blocked")
            | ("running", "paused")
            | ("running", "cancelled")
            | ("running", "failed")
            | ("verifying", "integrating")
            | ("verifying", "succeeded")
            | ("verifying", "queued")
            | ("verifying", "blocked")
            | ("verifying", "cancelled")
            | ("verifying", "failed")
            | ("integrating", "succeeded")
            | ("integrating", "blocked")
            | ("integrating", "cancelled")
            | ("integrating", "failed")
            | ("retry_wait", "queued")
            | ("retry_wait", "waiting_dependency")
            | ("retry_wait", "waiting_resource")
            | ("retry_wait", "blocked")
            | ("retry_wait", "cancelled")
            | ("retry_wait", "failed")
            // 可恢复 blocked：只允许重新进入准备或排队；finalBlocked 由 finalBlocked 列另行拒绝。
            | ("blocked", "queued")
            | ("blocked", "preparing")
            | ("blocked", "cancelled")
            | ("blocked", "failed")
            | ("paused", "running")
            | ("paused", "queued")
            | ("paused", "cancelled")
            | ("paused", "failed")
    )
}

/// 建表与索引。幂等；与 db.rs 其余迁移同样只做增量，不改既有表。
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS execution_batch (
            id             TEXT PRIMARY KEY,
            projectId      TEXT NOT NULL,
            scopeKind      TEXT NOT NULL CHECK (scopeKind IN ('story','feature','epic','allEligible')),
            scopeHash      TEXT NOT NULL,
            policyId       TEXT,
            idempotencyKey TEXT NOT NULL,
            requestDigest  TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','succeeded','partial','failed','cancelled')),
            createdAt      INTEGER NOT NULL,
            updatedAt      INTEGER NOT NULL,
            revision       INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            UNIQUE (projectId, idempotencyKey)
        );

        CREATE TABLE IF NOT EXISTS execution_task (
            id              TEXT PRIMARY KEY,
            projectId       TEXT NOT NULL,
            batchId         TEXT NOT NULL REFERENCES execution_batch(id) ON DELETE RESTRICT,
            storyId         TEXT NOT NULL,
            featureId       TEXT,
            baselineHash    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','waiting_dependency','waiting_resource','preparing','running','verifying','integrating','succeeded','retry_wait','blocked','paused','cancelled','failed')),
            priority        INTEGER NOT NULL DEFAULT 0,
            queuedAt        INTEGER NOT NULL,
            revision        INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            currentStepId   TEXT,
            currentAttemptId TEXT,
            fencingToken    INTEGER NOT NULL DEFAULT 0 CHECK (fencingToken >= 0),
            activeKeyHeld   INTEGER NOT NULL DEFAULT 1 CHECK (activeKeyHeld IN (0,1)),
            stopPending     INTEGER NOT NULL DEFAULT 0 CHECK (stopPending IN (0,1)),
            finalBlocked    INTEGER NOT NULL DEFAULT 0 CHECK (finalBlocked IN (0,1)),
            blockedReason   TEXT,
            retryAt         INTEGER,
            repairRound     INTEGER NOT NULL DEFAULT 0 CHECK (repairRound >= 0),
            createdAt       INTEGER NOT NULL,
            updatedAt       INTEGER NOT NULL,
            closedAt        INTEGER,
            UNIQUE (id, projectId)
        );
        -- 活动任务防重：同项目/Story/基线只能有一个 held 活动键。
        CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_task_active
            ON execution_task(projectId, storyId, baselineHash) WHERE activeKeyHeld = 1;
        CREATE INDEX IF NOT EXISTS idx_execution_task_queue
            ON execution_task(projectId, status, priority DESC, queuedAt ASC);
        CREATE INDEX IF NOT EXISTS idx_execution_task_batch
            ON execution_task(batchId, status);

        CREATE TABLE IF NOT EXISTS execution_step (
            id                 TEXT PRIMARY KEY,
            projectId          TEXT NOT NULL,
            taskId             TEXT NOT NULL REFERENCES execution_task(id) ON DELETE RESTRICT,
            ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
            kind               TEXT NOT NULL CHECK (kind IN ('prepare','implement','verify','integrate','deliver')),
            status             TEXT NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','preparing','running','verifying','integrating','succeeded','retry_wait','blocked','cancelled','failed')),
            validationPlanHash TEXT,
            inputManifestHash  TEXT NOT NULL,
            retryCount         INTEGER NOT NULL DEFAULT 0 CHECK (retryCount >= 0),
            repairRound        INTEGER NOT NULL DEFAULT 0 CHECK (repairRound >= 0),
            UNIQUE (taskId, ordinal)
        );

        CREATE TABLE IF NOT EXISTS execution_attempt (
            id             TEXT PRIMARY KEY,
            projectId      TEXT NOT NULL,
            taskId         TEXT NOT NULL REFERENCES execution_task(id) ON DELETE RESTRICT,
            stepId         TEXT NOT NULL REFERENCES execution_step(id) ON DELETE RESTRICT,
            ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
            taskFence      INTEGER NOT NULL CHECK (taskFence >= 0),
            ownerId        TEXT NOT NULL,
            runnerEpoch    TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'claimed'
                           CHECK (status IN ('claimed','running','ended','interrupted')),
            leaseUntil     INTEGER NOT NULL,
            heartbeatAt    INTEGER NOT NULL,
            checkpointId   TEXT,
            errorClass     TEXT,
            errorCode      TEXT,
            startedAt      INTEGER NOT NULL,
            endedAt        INTEGER,
            UNIQUE (stepId, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_attempt_lease
            ON execution_attempt(leaseUntil, status);
        CREATE INDEX IF NOT EXISTS idx_execution_attempt_task
            ON execution_attempt(taskId, ordinal);

        CREATE TABLE IF NOT EXISTS execution_dependency (
            id               TEXT PRIMARY KEY,
            projectId        TEXT NOT NULL,
            predecessorTaskId TEXT REFERENCES execution_task(id) ON DELETE RESTRICT,
            successorTaskId  TEXT NOT NULL REFERENCES execution_task(id) ON DELETE RESTRICT,
            requiredArtifactKey TEXT NOT NULL,
            gateState        TEXT NOT NULL DEFAULT 'waiting'
                             CHECK (gateState IN ('waiting','satisfied','invalidated')),
            createdAt        INTEGER NOT NULL,
            CHECK (predecessorTaskId IS NOT NULL AND predecessorTaskId <> successorTaskId)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_dependency_successor
            ON execution_dependency(successorTaskId);
        CREATE INDEX IF NOT EXISTS idx_execution_dependency_predecessor
            ON execution_dependency(predecessorTaskId);

        CREATE TABLE IF NOT EXISTS execution_checkpoint (
            id                  TEXT PRIMARY KEY,
            projectId           TEXT NOT NULL,
            taskId              TEXT NOT NULL REFERENCES execution_task(id) ON DELETE RESTRICT,
            attemptId           TEXT REFERENCES execution_attempt(id) ON DELETE RESTRICT,
            taskFence           INTEGER NOT NULL CHECK (taskFence >= 0),
            workPackageId       TEXT,
            workPackageRevision INTEGER,
            planHash            TEXT,
            stepCursor          TEXT,
            artifactManifestHash TEXT,
            sourceManifestHash  TEXT,
            headRevision        TEXT,
            dirtyDiffHash       TEXT,
            checkpointUri       TEXT,
            checkpointHash      TEXT,
            createdAt           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_execution_checkpoint_task
            ON execution_checkpoint(taskId, createdAt DESC);

        CREATE TABLE IF NOT EXISTS execution_event (
            seq            INTEGER PRIMARY KEY AUTOINCREMENT,
            eventId        TEXT NOT NULL UNIQUE,
            projectId      TEXT NOT NULL,
            batchId        TEXT,
            taskId         TEXT,
            attemptId      TEXT,
            eventType      TEXT NOT NULL,
            taskRevision   INTEGER,
            taskFence      INTEGER,
            sourceEventKey TEXT UNIQUE,
            payloadJson    TEXT,
            createdAt      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_execution_event_project
            ON execution_event(projectId, seq);

        CREATE TABLE IF NOT EXISTS execution_work_package (
            id                     TEXT NOT NULL,
            revision               INTEGER NOT NULL CHECK (revision >= 1),
            projectId              TEXT NOT NULL,
            batchId                TEXT,
            featureId              TEXT NOT NULL,
            workLevel              TEXT NOT NULL
                                   CHECK (workLevel IN ('story','feature','epic','allEligible')),
            sourceManifestHash     TEXT NOT NULL,
            obligationManifestHash TEXT NOT NULL,
            packageHash            TEXT NOT NULL,
            state                  TEXT NOT NULL DEFAULT 'prepared'
                                   CHECK (state IN ('prepared','confirmed','invalidated','archived')),
            invalidatedReason      TEXT,
            createdAt              INTEGER NOT NULL,
            confirmedAt            INTEGER,
            PRIMARY KEY (id, revision),
            UNIQUE (projectId, packageHash)
        );

        CREATE TABLE IF NOT EXISTS execution_work_package_story (
            packageId      TEXT NOT NULL,
            packageRevision INTEGER NOT NULL,
            projectId      TEXT NOT NULL,
            storyId        TEXT NOT NULL,
            featureId      TEXT NOT NULL,
            sourceHash     TEXT NOT NULL,
            disposition    TEXT NOT NULL
                           CHECK (disposition IN ('execute','deferred','cancelled','notReady')),
            reasonRef      TEXT,
            PRIMARY KEY (packageId, packageRevision, storyId),
            FOREIGN KEY (packageId, packageRevision)
                REFERENCES execution_work_package(id, revision) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS execution_obligation (
            packageId      TEXT NOT NULL,
            packageRevision INTEGER NOT NULL,
            projectId      TEXT NOT NULL,
            obligationId   TEXT NOT NULL,
            ownerStoryId   TEXT NOT NULL,
            kind           TEXT NOT NULL
                           CHECK (kind IN ('ac','ui','lld','db','rule','boundary')),
            sourceLocator  TEXT NOT NULL,
            sourceHash     TEXT NOT NULL,
            applicability  TEXT NOT NULL
                           CHECK (applicability IN ('required','optional','notApplicable')),
            applicabilityBasisRef TEXT,
            methodRef      TEXT,
            manifestItemHash TEXT NOT NULL,
            PRIMARY KEY (packageId, packageRevision, obligationId),
            FOREIGN KEY (packageId, packageRevision)
                REFERENCES execution_work_package(id, revision) ON DELETE RESTRICT,
            CHECK (applicability <> 'notApplicable' OR applicabilityBasisRef IS NOT NULL)
        );

        CREATE TABLE IF NOT EXISTS execution_obligation_mapping (
            packageId      TEXT NOT NULL,
            packageRevision INTEGER NOT NULL,
            projectId      TEXT NOT NULL,
            obligationId   TEXT NOT NULL,
            taskId         TEXT NOT NULL,
            validationItemId TEXT NOT NULL,
            mappingHash    TEXT NOT NULL,
            PRIMARY KEY (packageId, packageRevision, obligationId, taskId, validationItemId)
        );

        -- CR-026 / CR-031 G-PLAN：不可变执行计划与授权快照（M1 启动前置）。
        CREATE TABLE IF NOT EXISTS execution_plan (
            id                      TEXT PRIMARY KEY,
            projectId               TEXT NOT NULL,
            taskId                  TEXT NOT NULL,
            phase                   TEXT NOT NULL
                                    CHECK (phase IN ('prepare','implement','verify','integrate','deliver')),
            planHash                TEXT NOT NULL,
            hashRuleVersion         TEXT NOT NULL,
            requirementHash         TEXT NOT NULL,
            designHash              TEXT NOT NULL,
            acHash                  TEXT NOT NULL,
            authorizationRef        TEXT,
            selectedCli             TEXT NOT NULL,
            modelRef                TEXT NOT NULL,
            effort                  TEXT,
            permissionPolicyHash    TEXT NOT NULL,
            capabilityManifestHash  TEXT NOT NULL,
            createdAt               INTEGER NOT NULL,
            UNIQUE (projectId, planHash)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_plan_task ON execution_plan(taskId);

        CREATE TABLE IF NOT EXISTS execution_plan_authorization (
            id          TEXT PRIMARY KEY,
            projectId   TEXT NOT NULL,
            planHash    TEXT NOT NULL,
            actorRef    TEXT NOT NULL,
            source      TEXT NOT NULL,
            scope       TEXT NOT NULL,
            expiresAt   INTEGER,
            revokedAt   INTEGER,
            createdAt   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_execution_plan_auth
            ON execution_plan_authorization(planHash, revokedAt, expiresAt);

        -- CR-031：工具审批记录（M1 审批前置；UI 审批界面仍未实现）。
        CREATE TABLE IF NOT EXISTS execution_approval (
            id              TEXT PRIMARY KEY,
            projectId       TEXT NOT NULL,
            planHash        TEXT NOT NULL,
            taskId          TEXT,
            toolCallId      TEXT NOT NULL,
            finalArgsHash   TEXT NOT NULL,
            risk            TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
            decision        TEXT NOT NULL DEFAULT 'pending'
                            CHECK (decision IN ('pending','approved','rejected','expired')),
            decidedBy       TEXT,
            createdAt       INTEGER NOT NULL,
            decidedAt       INTEGER,
            expiresAt       INTEGER,
            UNIQUE (projectId, planHash, toolCallId)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_approval_pending
            ON execution_approval(projectId, decision, createdAt);
        "#,
    )
    .map_err(|e| e.to_string())
}

// ---------------- 请求/响应类型 ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInput {
    pub successor_story_id: String,
    pub predecessor_story_id: String,
    pub required_artifact_key: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateBatchInput {
    pub project_id: String,
    pub scope_kind: String,
    pub story_ids: Vec<String>,
    pub feature_id: Option<String>,
    pub baseline_hash: String,
    pub idempotency_key: String,
    pub request_digest: String,
    #[serde(default)]
    pub dependencies: Vec<DependencyInput>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub project_id: String,
    pub batch_id: String,
    pub story_id: String,
    pub feature_id: Option<String>,
    pub status: String,
    pub revision: i64,
    pub fencing_token: i64,
    pub current_attempt_id: Option<String>,
    pub active_key_held: bool,
    pub stop_pending: bool,
    pub final_blocked: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchView {
    pub id: String,
    pub project_id: String,
    pub scope_kind: String,
    pub status: String,
    pub revision: i64,
    pub created_at: i64,
    pub tasks: Vec<TaskView>,
    pub dependencies: Vec<DependencyView>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DependencyView {
    pub id: String,
    pub predecessor_task_id: Option<String>,
    pub successor_task_id: String,
    pub required_artifact_key: String,
    pub gate_state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub task: TaskView,
    pub attempt_id: String,
    pub task_fence: i64,
    pub lease_until: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInput {
    pub project_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub task_fence: i64,
    pub work_package_id: Option<String>,
    pub work_package_revision: Option<i64>,
    pub plan_hash: Option<String>,
    pub step_cursor: Option<String>,
    pub artifact_manifest_hash: Option<String>,
    pub source_manifest_hash: Option<String>,
    pub head_revision: Option<String>,
    pub dirty_diff_hash: Option<String>,
    pub checkpoint_uri: Option<String>,
    pub checkpoint_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointView {
    pub id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub task_fence: i64,
    pub step_cursor: Option<String>,
    pub work_package_id: Option<String>,
    pub plan_hash: Option<String>,
    pub source_manifest_hash: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObligationInput {
    pub obligation_id: String,
    pub owner_story_id: String,
    pub kind: String,
    pub source_locator: String,
    pub source_hash: String,
    pub applicability: String,
    pub applicability_basis_ref: Option<String>,
    pub method_ref: Option<String>,
    pub manifest_item_hash: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PackageStoryInput {
    pub story_id: String,
    pub feature_id: String,
    pub source_hash: String,
    pub disposition: String,
    pub reason_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatePackageInput {
    pub project_id: String,
    pub batch_id: Option<String>,
    pub feature_id: String,
    pub work_level: String,
    pub source_manifest_hash: String,
    pub package_hash: String,
    pub stories: Vec<PackageStoryInput>,
    pub obligations: Vec<ObligationInput>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PackageView {
    pub id: String,
    pub revision: i64,
    pub project_id: String,
    pub feature_id: String,
    pub work_level: String,
    pub state: String,
    pub package_hash: String,
    pub stories: Vec<PackageStoryView>,
    pub obligations: Vec<ObligationView>,
    pub coverage: CoverageView,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PackageStoryView {
    pub story_id: String,
    pub disposition: String,
    pub source_hash: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObligationView {
    pub obligation_id: String,
    pub owner_story_id: String,
    pub kind: String,
    pub applicability: String,
    pub method_ref: Option<String>,
    pub source_locator: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoverageView {
    pub required: i64,
    pub not_applicable: i64,
    pub with_method: i64,
    pub mapped: i64,
    pub missing_method: Vec<String>,
    pub missing_mapping: Vec<String>,
    pub ready: bool,
}

// ---------------- 内部读取 ----------------

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskView> {
    Ok(TaskView {
        id: row.get(0)?,
        project_id: row.get(1)?,
        batch_id: row.get(2)?,
        story_id: row.get(3)?,
        feature_id: row.get(4)?,
        status: row.get(5)?,
        revision: row.get(6)?,
        fencing_token: row.get(7)?,
        current_attempt_id: row.get(8)?,
        active_key_held: row.get::<_, i64>(9)? != 0,
        stop_pending: row.get::<_, i64>(10)? != 0,
        final_blocked: row.get::<_, i64>(11)? != 0,
        blocked_reason: row.get(12)?,
    })
}

const TASK_SELECT: &str = "SELECT id, projectId, batchId, storyId, featureId, status, revision, fencingToken, \
    currentAttemptId, activeKeyHeld, stopPending, finalBlocked, blockedReason FROM execution_task";

fn read_task(conn: &Connection, project_id: &str, task_id: &str) -> Result<TaskView, String> {
    conn.query_row(
        &format!("{TASK_SELECT} WHERE projectId=?1 AND id=?2"),
        rusqlite::params![project_id, task_id],
        row_to_task,
    )
    .map_err(|_| format!("任务 {task_id} 不存在或不属于该项目"))
}

fn write_event(
    conn: &Connection,
    project_id: &str,
    batch_id: Option<&str>,
    task_id: Option<&str>,
    attempt_id: Option<&str>,
    event_type: &str,
    revision: Option<i64>,
    fence: Option<i64>,
    payload: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO execution_event (eventId, projectId, batchId, taskId, attemptId, eventType, taskRevision, taskFence, payloadJson, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            new_id("evt"),
            project_id,
            batch_id,
            task_id,
            attempt_id,
            event_type,
            revision,
            fence,
            payload,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_scope_kind(kind: &str) -> Result<(), String> {
    if matches!(kind, "story" | "feature" | "epic" | "allEligible") {
        Ok(())
    } else {
        Err(format!("不支持的派发范围 {kind}"))
    }
}

// ---------------- 批次与任务 ----------------

/// 创建批次、任务、依赖（单事务）。同 idempotencyKey 重投返回原批次；
/// digest 不同拒绝，不覆盖原批次。
pub fn create_batch(conn: &Connection, input: &CreateBatchInput) -> Result<BatchView, String> {
    validate_scope_kind(&input.scope_kind)?;
    if input.story_ids.is_empty() {
        return Err("派发批次至少需要一个 Story".into());
    }
    if input.baseline_hash.trim().is_empty() {
        return Err("baselineHash 不能为空".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // 幂等：同项目 + 同幂等键。
    let existing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT id, requestDigest, status FROM execution_batch WHERE projectId=?1 AND idempotencyKey=?2",
            rusqlite::params![input.project_id, input.idempotency_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((batch_id, digest, _)) = existing {
        if digest != input.request_digest {
            return Err("同一幂等键的请求摘要不一致，拒绝覆盖原批次".into());
        }
        let view = read_batch(&tx, &input.project_id, &batch_id)?;
        return Ok(view);
    }

    let batch_id = new_id("batch");
    let now = now_ms();
    let scope_hash = format!("sha256:{}", sha256_hex(input.story_ids.join(",").as_bytes()));
    tx.execute(
        "INSERT INTO execution_batch (id, projectId, scopeKind, scopeHash, idempotencyKey, requestDigest, status, createdAt, updatedAt, revision) \
         VALUES (?1,?2,?3,?4,?5,?6,'running',?7,?7,0)",
        rusqlite::params![
            batch_id,
            input.project_id,
            input.scope_kind,
            scope_hash,
            input.idempotency_key,
            input.request_digest,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    // story → task 映射，供依赖解析。
    let mut story_task: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for story in &input.story_ids {
        let task_id = new_id("task");
        tx.execute(
            "INSERT INTO execution_task (id, projectId, batchId, storyId, featureId, baselineHash, status, priority, queuedAt, revision, fencingToken, activeKeyHeld, createdAt, updatedAt) \
             VALUES (?1,?2,?3,?4,?7,?5,'queued',0,?6,0,0,1,?6,?6)",
            rusqlite::params![
                task_id,
                input.project_id,
                batch_id,
                story,
                input.baseline_hash,
                now,
                input.feature_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        for (ordinal, kind) in ["prepare", "implement", "verify"].iter().enumerate() {
            tx.execute(
                "INSERT INTO execution_step (id, projectId, taskId, ordinal, kind, status, inputManifestHash) \
                 VALUES (?1,?2,?3,?4,?5,'queued',?6)",
                rusqlite::params![
                    new_id("step"),
                    input.project_id,
                    task_id,
                    ordinal as i64,
                    kind,
                    input.baseline_hash
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        story_task.insert(story.clone(), task_id);
    }

    for dep in &input.dependencies {
        let successor = story_task
            .get(&dep.successor_story_id)
            .ok_or_else(|| format!("依赖的后继 Story {} 不在本批次", dep.successor_story_id))?;
        let predecessor = story_task
            .get(&dep.predecessor_story_id)
            .ok_or_else(|| format!("依赖的前置 Story {} 不在本批次", dep.predecessor_story_id))?;
        tx.execute(
            "INSERT INTO execution_dependency (id, projectId, predecessorTaskId, successorTaskId, requiredArtifactKey, gateState, createdAt) \
             VALUES (?1,?2,?3,?4,?5,'waiting',?6)",
            rusqlite::params![
                new_id("dep"),
                input.project_id,
                predecessor,
                successor,
                dep.required_artifact_key,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 事务内拓扑检环：任何依赖边都不得形成环。
    detect_cycle(&tx, &input.project_id)?;
    tx.commit().map_err(|e| e.to_string())?;

    read_batch(conn, &input.project_id, &batch_id)
}

/// 检测执行依赖环；有环返回错误（整个创建事务回滚）。
fn detect_cycle(conn: &Connection, project_id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT predecessorTaskId, successorTaskId FROM execution_dependency WHERE projectId=?1")
        .map_err(|e| e.to_string())?;
    let edges: Vec<(String, String)> = stmt
        .query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    // 0=未访问，1=访问中，2=已完成。
    let mut color: std::collections::BTreeMap<String, u8> = std::collections::BTreeMap::new();
    let mut adj: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for (pred, succ) in edges {
        adj.entry(pred).or_default().push(succ);
    }
    fn dfs(
        node: &str,
        adj: &std::collections::BTreeMap<String, Vec<String>>,
        color: &mut std::collections::BTreeMap<String, u8>,
    ) -> bool {
        color.insert(node.to_string(), 1);
        if let Some(next) = adj.get(node) {
            for n in next {
                match color.get(n).copied().unwrap_or(0) {
                    1 => return true,
                    0 => {
                        if dfs(n, adj, color) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
        }
        color.insert(node.to_string(), 2);
        false
    }
    let nodes: Vec<String> = adj.keys().cloned().collect();
    for node in nodes {
        if color.get(&node).copied().unwrap_or(0) == 0 && dfs(&node, &adj, &mut color) {
            return Err("依赖关系形成环，拒绝创建批次".into());
        }
    }
    Ok(())
}

pub fn read_batch(conn: &Connection, project_id: &str, batch_id: &str) -> Result<BatchView, String> {
    let (scope_kind, status, revision, created_at): (String, String, i64, i64) = conn
        .query_row(
            "SELECT scopeKind, status, revision, createdAt FROM execution_batch WHERE projectId=?1 AND id=?2",
            rusqlite::params![project_id, batch_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| format!("批次 {batch_id} 不存在或不属于该项目"))?;
    let mut stmt = conn
        .prepare(&format!(
            "{TASK_SELECT} WHERE projectId=?1 AND batchId=?2 ORDER BY queuedAt, id"
        ))
        .map_err(|e| e.to_string())?;
    let tasks: Vec<TaskView> = stmt
        .query_map(rusqlite::params![project_id, batch_id], row_to_task)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);
    let mut dstmt = conn
        .prepare("SELECT id, predecessorTaskId, successorTaskId, requiredArtifactKey, gateState FROM execution_dependency WHERE projectId=?1 AND successorTaskId IN (SELECT id FROM execution_task WHERE batchId=?2)")
        .map_err(|e| e.to_string())?;
    let dependencies: Vec<DependencyView> = dstmt
        .query_map(rusqlite::params![project_id, batch_id], |r| {
            Ok(DependencyView {
                id: r.get(0)?,
                predecessor_task_id: r.get(1)?,
                successor_task_id: r.get(2)?,
                required_artifact_key: r.get(3)?,
                gate_state: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(BatchView {
        id: batch_id.to_string(),
        project_id: project_id.to_string(),
        scope_kind,
        status,
        revision,
        created_at,
        tasks,
        dependencies,
    })
}

pub fn list_batches(conn: &Connection, project_id: &str) -> Result<Vec<BatchView>, String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM execution_batch WHERE projectId=?1 ORDER BY createdAt DESC")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([project_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        collected
    };
    ids.into_iter()
        .map(|id| read_batch(conn, project_id, &id))
        .collect()
}

/// 依赖 gate：后继任务的所有前置任务都必须 succeeded；否则依赖未满足。
fn dependencies_satisfied(conn: &Connection, project_id: &str, task_id: &str) -> Result<bool, String> {
    let unmet: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM execution_dependency d \
             JOIN execution_task t ON t.id = d.predecessorTaskId \
             WHERE d.projectId=?1 AND d.successorTaskId=?2 AND t.status <> 'succeeded'",
            rusqlite::params![project_id, task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(unmet == 0)
}

/// 领取任务：校验 revision、状态与依赖，递增 fence，登记 attempt 与租约（CAS）。
pub fn claim_task(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    owner_id: &str,
    expected_revision: i64,
    lease_ms: i64,
    runner_epoch: &str,
) -> Result<ClaimView, String> {
    claim_task_at(
        conn,
        project_id,
        task_id,
        owner_id,
        expected_revision,
        lease_ms,
        runner_epoch,
        now_ms(),
    )
}

/// 可注入时钟的领取实现；调度循环用它保证退避判定与测试可复现。
fn claim_task_at(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    owner_id: &str,
    expected_revision: i64,
    lease_ms: i64,
    runner_epoch: &str,
    now: i64,
) -> Result<ClaimView, String> {
    if lease_ms <= 0 {
        return Err("leaseMs 必须为正数".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let task = read_task(&tx, project_id, task_id)?;
    if task.revision != expected_revision {
        return Err(format!(
            "STALE_REVISION：任务当前 revision={}，请求={}",
            task.revision, expected_revision
        ));
    }
    if !matches!(task.status.as_str(), "queued" | "retry_wait") {
        return Err(format!("任务状态 {} 不可领取", task.status));
    }
    let retry_at: Option<i64> = tx
        .query_row(
            "SELECT retryAt FROM execution_task WHERE id=?1",
            [task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if retry_at.map(|at| at > now).unwrap_or(false) {
        return Err("RETRY_NOT_DUE：退避时间未到，不忙循环".into());
    }
    if !dependencies_satisfied(&tx, project_id, task_id)? {
        return Err("DEPENDENCY_UNMET：前置任务尚未交付".into());
    }
    let step_id: String = tx
        .query_row(
            "SELECT id FROM execution_step WHERE taskId=?1 AND projectId=?2 ORDER BY ordinal LIMIT 1",
            rusqlite::params![task_id, project_id],
            |r| r.get(0),
        )
        .map_err(|_| "任务缺少执行步骤".to_string())?;
    let attempt_no: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM execution_attempt WHERE taskId=?1",
            [task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let attempt_id = new_id("attempt");
    let new_fence = task.fencing_token + 1;
    let lease_until = now + lease_ms;
    let changed = tx
        .execute(
            "UPDATE execution_task SET status='preparing', fencingToken=?1, currentAttemptId=?2, currentStepId=?3, revision=revision+1, updatedAt=?4 \
             WHERE projectId=?5 AND id=?6 AND revision=?7 AND fencingToken=?8",
            rusqlite::params![
                new_fence,
                attempt_id,
                step_id,
                now,
                project_id,
                task_id,
                expected_revision,
                task.fencing_token
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("STALE_REVISION：任务已被其他执行者领取".into());
    }
    tx.execute(
        "INSERT INTO execution_attempt (id, projectId, taskId, stepId, ordinal, taskFence, ownerId, runnerEpoch, status, leaseUntil, heartbeatAt, startedAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'claimed',?9,?10,?11)",
        rusqlite::params![
            attempt_id,
            project_id,
            task_id,
            step_id,
            attempt_no,
            new_fence,
            owner_id,
            runner_epoch,
            lease_until,
            now,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    write_event(
        &tx,
        project_id,
        Some(&task.batch_id),
        Some(task_id),
        Some(&attempt_id),
        "task.claimed",
        Some(expected_revision + 1),
        Some(new_fence),
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    let task = read_task(conn, project_id, task_id)?;
    Ok(ClaimView {
        task,
        attempt_id,
        task_fence: new_fence,
        lease_until,
    })
}

/// 受管状态转换：校验合法转换、fencingToken 与 finalBlocked，CAS 更新并写事件。
pub fn transition_task(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    expected_revision: i64,
    fencing_token: i64,
    to_status: &str,
    reason: Option<&str>,
) -> Result<TaskView, String> {
    if !TASK_STATUSES.contains(&to_status) {
        return Err(format!("未知任务状态 {to_status}"));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let task = read_task(&tx, project_id, task_id)?;
    if task.revision != expected_revision {
        return Err(format!(
            "STALE_REVISION：任务当前 revision={}，请求={}",
            task.revision, expected_revision
        ));
    }
    if task.fencing_token != fencing_token {
        return Err("LEASE_LOST：fencingToken 已变化，拒绝旧执行者写入".into());
    }
    if task.final_blocked && to_status != "cancelled" && to_status != "failed" {
        return Err("任务已 finalBlocked，需新授权创建新批次，不能原地恢复".into());
    }
    if !transition_allowed(&task.status, to_status) {
        return Err(format!("非法状态转换 {} → {}", task.status, to_status));
    }
    let now = now_ms();
    let terminal = is_terminal(to_status);
    let active = if terminal { 0 } else { 1 };
    let closed_at = if terminal { Some(now) } else { None };
    let changed = tx
        .execute(
            "UPDATE execution_task SET status=?1, revision=revision+1, updatedAt=?2, activeKeyHeld=?3, closedAt=?4, \
             blockedReason=CASE WHEN ?1='blocked' THEN ?5 ELSE NULL END \
             WHERE projectId=?6 AND id=?7 AND revision=?8 AND fencingToken=?9",
            rusqlite::params![
                to_status,
                now,
                active,
                closed_at,
                reason,
                project_id,
                task_id,
                expected_revision,
                fencing_token
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("STALE_REVISION：任务已被其他执行者更新".into());
    }
    if terminal {
        // 终态：该任务未结束的 attempt 标记结束。
        tx.execute(
            "UPDATE execution_attempt SET status='ended', endedAt=?1 WHERE taskId=?2 AND status IN ('claimed','running')",
            rusqlite::params![now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    write_event(
        &tx,
        project_id,
        Some(&task.batch_id),
        Some(task_id),
        task.current_attempt_id.as_deref(),
        &format!("task.{to_status}"),
        Some(expected_revision + 1),
        Some(fencing_token),
        reason,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_task(conn, project_id, task_id)
}

/// 保存检查点：只允许当前 fence 的 attempt 写入，先复核租约未过期。
pub fn save_checkpoint(conn: &Connection, input: &CheckpointInput) -> Result<CheckpointView, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let task = read_task(&tx, &input.project_id, &input.task_id)?;
    if task.fencing_token != input.task_fence {
        return Err("LEASE_LOST：fencingToken 不匹配，拒绝写入检查点".into());
    }
    let (attempt_fence, lease_until, status): (i64, i64, String) = tx
        .query_row(
            "SELECT taskFence, leaseUntil, status FROM execution_attempt WHERE id=?1 AND taskId=?2 AND projectId=?3",
            rusqlite::params![input.attempt_id, input.task_id, input.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "检查点所属 attempt 不存在".to_string())?;
    if attempt_fence != input.task_fence {
        return Err("LEASE_LOST：attempt 不属于当前 fence".into());
    }
    if !matches!(status.as_str(), "claimed" | "running") {
        return Err("attempt 已结束，不能写检查点".into());
    }
    if lease_until < now_ms() {
        return Err("LEASE_LOST：租约已过期，不能写检查点".into());
    }
    let id = new_id("ckpt");
    let now = now_ms();
    tx.execute(
        "INSERT INTO execution_checkpoint (id, projectId, taskId, attemptId, taskFence, workPackageId, workPackageRevision, planHash, stepCursor, artifactManifestHash, sourceManifestHash, headRevision, dirtyDiffHash, checkpointUri, checkpointHash, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        rusqlite::params![
            id,
            input.project_id,
            input.task_id,
            input.attempt_id,
            input.task_fence,
            input.work_package_id,
            input.work_package_revision,
            input.plan_hash,
            input.step_cursor,
            input.artifact_manifest_hash,
            input.source_manifest_hash,
            input.head_revision,
            input.dirty_diff_hash,
            input.checkpoint_uri,
            input.checkpoint_hash,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE execution_attempt SET checkpointId=?1 WHERE id=?2",
        rusqlite::params![id, input.attempt_id],
    )
    .map_err(|e| e.to_string())?;
    write_event(
        &tx,
        &input.project_id,
        Some(&task.batch_id),
        Some(&input.task_id),
        Some(&input.attempt_id),
        "task.checkpoint",
        Some(task.revision),
        Some(input.task_fence),
        Some(&id),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(CheckpointView {
        id,
        task_id: input.task_id.clone(),
        attempt_id: Some(input.attempt_id.clone()),
        task_fence: input.task_fence,
        step_cursor: input.step_cursor.clone(),
        work_package_id: input.work_package_id.clone(),
        plan_hash: input.plan_hash.clone(),
        source_manifest_hash: input.source_manifest_hash.clone(),
        created_at: now,
    })
}

pub fn latest_checkpoint(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
) -> Result<Option<CheckpointView>, String> {
    conn.query_row(
        "SELECT id, taskId, attemptId, taskFence, stepCursor, workPackageId, planHash, sourceManifestHash, createdAt \
         FROM execution_checkpoint WHERE projectId=?1 AND taskId=?2 ORDER BY createdAt DESC LIMIT 1",
        rusqlite::params![project_id, task_id],
        |r| {
            Ok(CheckpointView {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt_id: r.get(2)?,
                task_fence: r.get(3)?,
                step_cursor: r.get(4)?,
                work_package_id: r.get(5)?,
                plan_hash: r.get(6)?,
                source_manifest_hash: r.get(7)?,
                created_at: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

// ---------------- 恢复预检与受控恢复 ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInspectInput {
    pub project_id: String,
    pub task_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttemptView {
    pub id: String,
    pub status: String,
    pub task_fence: i64,
    pub lease_until: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInspectView {
    pub task: TaskView,
    pub checkpoint: Option<CheckpointView>,
    pub live_attempts: Vec<AttemptView>,
    pub blockers: Vec<String>,
    pub resumable: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResumeInput {
    pub project_id: String,
    pub task_id: String,
    pub expected_revision: i64,
    /// 旧 writer 停止确认的受检证据引用；缺失视为 STOP_UNCONFIRMED。
    pub stop_confirmation_ref: String,
}

/// 恢复预检（只读）：检查检查点、fence、源版本与可能仍存活的旧 writer。
/// 任何一项无法证明都列为 blocker，不自动接管。
pub fn inspect_recovery(
    conn: &Connection,
    input: &RecoveryInspectInput,
    now: i64,
) -> Result<RecoveryInspectView, String> {
    let task = read_task(conn, &input.project_id, &input.task_id)?;
    let checkpoint = latest_checkpoint(conn, &input.project_id, &input.task_id)?;
    let live_attempts: Vec<AttemptView> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, status, taskFence, leaseUntil FROM execution_attempt \
                 WHERE taskId=?1 AND status IN ('claimed','running') AND leaseUntil > ?2 ORDER BY startedAt",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![input.task_id, now], |r| {
                Ok(AttemptView {
                    id: r.get(0)?,
                    status: r.get(1)?,
                    task_fence: r.get(2)?,
                    lease_until: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let mut blockers = Vec::new();
    match &checkpoint {
        None => blockers.push("CHECKPOINT_MISSING".to_string()),
        Some(ckpt) => {
            if ckpt.task_fence != task.fencing_token {
                blockers.push("CHECKPOINT_STALE_FENCE".to_string());
            }
            if ckpt
                .source_manifest_hash
                .as_deref()
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                blockers.push("SOURCE_UNVERIFIED".to_string());
            }
        }
    }
    if !live_attempts.is_empty() {
        blockers.push("OLD_WRITER_MAY_BE_ALIVE".to_string());
    }
    if !matches!(task.status.as_str(), "blocked" | "paused" | "queued" | "retry_wait") {
        blockers.push("STATUS_NOT_RESUMABLE".to_string());
    }
    let resumable = blockers.is_empty();
    Ok(RecoveryInspectView {
        task,
        checkpoint,
        live_attempts,
        blockers,
        resumable,
    })
}

/// 受控恢复：必须先通过预检且给出停止确认引用；新 fence 防止旧执行者继续写入。
/// 本函数不创建新 attempt，领取仍走正常 claim。
pub fn resume_task(
    conn: &Connection,
    input: &RecoveryResumeInput,
    now: i64,
) -> Result<TaskView, String> {
    let pre = inspect_recovery(
        conn,
        &RecoveryInspectInput {
            project_id: input.project_id.clone(),
            task_id: input.task_id.clone(),
        },
        now,
    )?;
    if !pre.resumable {
        return Err(format!("恢复预检未通过：{}", pre.blockers.join(", ")));
    }
    if input.stop_confirmation_ref.trim().is_empty() {
        return Err("STOP_UNCONFIRMED：缺少旧 writer 停止确认，不能恢复".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let new_fence = pre.task.fencing_token + 1;
    let changed = tx
        .execute(
            "UPDATE execution_task SET status='queued', revision=revision+1, fencingToken=?1, activeKeyHeld=1, \
             stopPending=0, retryAt=NULL, updatedAt=?2 \
             WHERE projectId=?3 AND id=?4 AND revision=?5 AND status IN ('blocked','paused')",
            rusqlite::params![
                new_fence,
                now,
                input.project_id,
                input.task_id,
                input.expected_revision
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("STALE_REVISION：任务状态或修订已变化".into());
    }
    write_event(
        &tx,
        &input.project_id,
        Some(&pre.task.batch_id),
        Some(&input.task_id),
        None,
        "task.recovery_resume",
        Some(input.expected_revision + 1),
        Some(new_fence),
        Some(&input.stop_confirmation_ref),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_task(conn, &input.project_id, &input.task_id)
}

/// 启动回收：租约已过期且仍标记 claimed/running 的 attempt 置 interrupted，
/// 对应任务置 blocked 并保留 activeKey；不自动重跑，等待显式恢复预检。
pub fn recover_interrupted(conn: &Connection, now: i64) -> Result<u64, String> {
    let candidates: Vec<(String, String, String, String, i64, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.taskId, t.projectId, t.batchId, t.revision, a.taskFence \
                 FROM execution_attempt a JOIN execution_task t ON t.id=a.taskId \
                 WHERE a.status IN ('claimed','running') AND a.leaseUntil < ?1 \
                   AND t.status IN ('preparing','running','verifying','integrating')",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([now], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    if candidates.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut count = 0u64;
    for (attempt_id, task_id, project_id, batch_id, revision, fence) in candidates {
        let ended = tx
            .execute(
                "UPDATE execution_attempt SET status='interrupted', endedAt=?1 \
                 WHERE id=?2 AND status IN ('claimed','running')",
                rusqlite::params![now, attempt_id],
            )
            .map_err(|e| e.to_string())?;
        if ended == 0 {
            continue;
        }
        let changed = tx
            .execute(
                "UPDATE execution_task SET status='blocked', revision=revision+1, blockedReason=?1, updatedAt=?2, activeKeyHeld=1 \
                 WHERE id=?3 AND revision=?4 AND status IN ('preparing','running','verifying','integrating')",
                rusqlite::params!["LEASE_EXPIRED_NEEDS_RECOVERY", now, task_id, revision],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            continue;
        }
        write_event(
            &tx,
            &project_id,
            Some(&batch_id),
            Some(&task_id),
            Some(&attempt_id),
            "task.blocked",
            Some(revision + 1),
            Some(fence),
            Some("LEASE_EXPIRED_NEEDS_RECOVERY"),
        )?;
        count += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn execution_recovery_inspect(
    project_id: String,
    task_id: String,
) -> Result<RecoveryInspectView, String> {
    with_conn(|conn| {
        inspect_recovery(
            conn,
            &RecoveryInspectInput { project_id, task_id },
            now_ms(),
        )
    })
}

#[tauri::command]
pub fn execution_recovery_resume(input: RecoveryResumeInput) -> Result<TaskView, String> {
    with_conn(|conn| resume_task(conn, &input, now_ms()))
}

// ---------------- 工作包与义务 ----------------

pub fn create_package(conn: &Connection, input: &CreatePackageInput) -> Result<PackageView, String> {
    if input.feature_id.trim().is_empty() {
        return Err("工作包必须绑定一个 Feature".into());
    }
    if input.stories.is_empty() {
        return Err("工作包至少需要一个 Story 处置".into());
    }
    if input.obligations.is_empty() {
        return Err("工作包必须登记义务清单；空清单不能确认 ready".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT id, revision FROM execution_work_package WHERE projectId=?1 AND packageHash=?2",
            rusqlite::params![input.project_id, input.package_hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, revision)) = existing {
        let view = read_package(&tx, &input.project_id, &id, revision)?;
        return Ok(view);
    }
    let id = new_id("wp");
    let revision = 1i64;
    let now = now_ms();
    let obligation_manifest_hash = format!(
        "sha256:{}",
        sha256_hex(
            input
                .obligations
                .iter()
                .map(|o| format!("{}:{}", o.obligation_id, o.manifest_item_hash))
                .collect::<Vec<_>>()
                .join("|")
                .as_bytes()
        )
    );
    tx.execute(
        "INSERT INTO execution_work_package (id, revision, projectId, batchId, featureId, workLevel, sourceManifestHash, obligationManifestHash, packageHash, state, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'prepared',?10)",
        rusqlite::params![
            id,
            revision,
            input.project_id,
            input.batch_id,
            input.feature_id,
            input.work_level,
            input.source_manifest_hash,
            obligation_manifest_hash,
            input.package_hash,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    for story in &input.stories {
        if !matches!(story.disposition.as_str(), "execute" | "deferred" | "cancelled" | "notReady") {
            return Err(format!("未知的 Story 处置 {}", story.disposition));
        }
        tx.execute(
            "INSERT INTO execution_work_package_story (packageId, packageRevision, projectId, storyId, featureId, sourceHash, disposition, reasonRef) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                id,
                revision,
                input.project_id,
                story.story_id,
                story.feature_id,
                story.source_hash,
                story.disposition,
                story.reason_ref
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for obligation in &input.obligations {
        if !matches!(obligation.kind.as_str(), "ac" | "ui" | "lld" | "db" | "rule" | "boundary") {
            return Err(format!("未知的义务类型 {}", obligation.kind));
        }
        if !matches!(obligation.applicability.as_str(), "required" | "optional" | "notApplicable") {
            return Err(format!("未知的适用性 {}", obligation.applicability));
        }
        if obligation.applicability == "notApplicable" && obligation.applicability_basis_ref.is_none() {
            return Err(format!("义务 {} 标为不适用时必须给出依据", obligation.obligation_id));
        }
        tx.execute(
            "INSERT INTO execution_obligation (packageId, packageRevision, projectId, obligationId, ownerStoryId, kind, sourceLocator, sourceHash, applicability, applicabilityBasisRef, methodRef, manifestItemHash) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            rusqlite::params![
                id,
                revision,
                input.project_id,
                obligation.obligation_id,
                obligation.owner_story_id,
                obligation.kind,
                obligation.source_locator,
                obligation.source_hash,
                obligation.applicability,
                obligation.applicability_basis_ref,
                obligation.method_ref,
                obligation.manifest_item_hash
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_package(conn, &input.project_id, &id, revision)
}

/// 确认工作包：只允许 prepared → confirmed；required 义务必须有验证方法。
pub fn confirm_package(
    conn: &Connection,
    project_id: &str,
    package_id: &str,
    revision: i64,
) -> Result<PackageView, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let coverage = compute_coverage(&tx, project_id, package_id, revision)?;
    if !coverage.ready {
        return Err(format!(
            "工作包未就绪：缺验证方法 [{}]；未映射任务/验证项 [{}]",
            coverage.missing_method.join(", "),
            coverage.missing_mapping.join(", ")
        ));
    }
    let changed = tx
        .execute(
            "UPDATE execution_work_package SET state='confirmed', confirmedAt=?1 \
             WHERE projectId=?2 AND id=?3 AND revision=?4 AND state='prepared'",
            rusqlite::params![now_ms(), project_id, package_id, revision],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("工作包状态不是 prepared，不能确认".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_package(conn, project_id, package_id, revision)
}

fn compute_coverage(
    conn: &Connection,
    project_id: &str,
    package_id: &str,
    revision: i64,
) -> Result<CoverageView, String> {
    let mut stmt = conn
        .prepare(
            "SELECT o.obligationId, o.applicability, o.methodRef, \
                    EXISTS(SELECT 1 FROM execution_obligation_mapping m \
                           WHERE m.packageId=o.packageId AND m.packageRevision=o.packageRevision \
                             AND m.obligationId=o.obligationId) \
             FROM execution_obligation o \
             WHERE o.projectId=?1 AND o.packageId=?2 AND o.packageRevision=?3",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>, bool)> = stmt
        .query_map(rusqlite::params![project_id, package_id, revision], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let mut required = 0i64;
    let mut not_applicable = 0i64;
    let mut with_method = 0i64;
    let mut mapped_count = 0i64;
    let mut missing_method = Vec::new();
    let mut missing_mapping = Vec::new();
    for (id, applicability, method, mapped) in rows {
        match applicability.as_str() {
            "required" => {
                required += 1;
                if method.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                    with_method += 1;
                } else {
                    missing_method.push(id.clone());
                }
                if mapped {
                    mapped_count += 1;
                } else {
                    missing_mapping.push(id);
                }
            }
            "notApplicable" => not_applicable += 1,
            _ => {}
        }
    }
    Ok(CoverageView {
        required,
        not_applicable,
        with_method,
        mapped: mapped_count,
        ready: missing_method.is_empty() && missing_mapping.is_empty() && required > 0,
        missing_method,
        missing_mapping,
    })
}

pub fn read_package(
    conn: &Connection,
    project_id: &str,
    package_id: &str,
    revision: i64,
) -> Result<PackageView, String> {
    let (feature_id, work_level, state, package_hash): (String, String, String, String) = conn
        .query_row(
            "SELECT featureId, workLevel, state, packageHash FROM execution_work_package \
             WHERE projectId=?1 AND id=?2 AND revision=?3",
            rusqlite::params![project_id, package_id, revision],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| format!("工作包 {package_id} 不存在或不属于该项目"))?;
    let stories: Vec<PackageStoryView> = {
        let mut stmt = conn
            .prepare("SELECT storyId, disposition, sourceHash FROM execution_work_package_story WHERE packageId=?1 AND packageRevision=?2 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map(rusqlite::params![package_id, revision], |r| {
                Ok(PackageStoryView {
                    story_id: r.get(0)?,
                    disposition: r.get(1)?,
                    source_hash: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        collected
    };
    let obligations: Vec<ObligationView> = {
        let mut stmt = conn
            .prepare("SELECT obligationId, ownerStoryId, kind, applicability, methodRef, sourceLocator FROM execution_obligation WHERE packageId=?1 AND packageRevision=?2 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map(rusqlite::params![package_id, revision], |r| {
                Ok(ObligationView {
                    obligation_id: r.get(0)?,
                    owner_story_id: r.get(1)?,
                    kind: r.get(2)?,
                    applicability: r.get(3)?,
                    method_ref: r.get(4)?,
                    source_locator: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        collected
    };
    let coverage = compute_coverage(conn, project_id, package_id, revision)?;
    Ok(PackageView {
        id: package_id.to_string(),
        revision,
        project_id: project_id.to_string(),
        feature_id,
        work_level,
        state,
        package_hash,
        stories,
        obligations,
        coverage,
    })
}

// ---------------- M0 fake runner：调度循环 ----------------

/// M0 调度输入。`simulate` 只驱动状态机与故障分支，**不执行真实工作**。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DispatchOnceInput {
    pub project_id: String,
    pub owner_id: String,
    #[serde(default = "default_max_tasks")]
    pub max_tasks: i64,
    #[serde(default = "default_lease_ms")]
    pub lease_ms: i64,
    pub runner_epoch: String,
    /// succeed | retry-once | retry-exhaust | fail | block
    pub simulate: String,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: i64,
}

fn default_max_tasks() -> i64 { 4 }
fn default_lease_ms() -> i64 { 30_000 }
fn default_max_attempts() -> i64 { 2 }

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DispatchOnceSummary {
    pub started: Vec<String>,
    pub succeeded: Vec<String>,
    pub retried: Vec<String>,
    pub failed: Vec<String>,
    pub blocked: Vec<String>,
    pub skipped: Vec<String>,
}

/// 一次调度循环：按优先级领取依赖已满足的任务，推进 prepare→running→verify，
/// 再按 `simulate` 结束。所有写入都走受管状态机与 fence CAS；M0 不 spawn 进程。
pub fn dispatch_once(
    conn: &Connection,
    input: &DispatchOnceInput,
    now: i64,
) -> Result<DispatchOnceSummary, String> {
    if !matches!(
        input.simulate.as_str(),
        "succeed" | "retry-once" | "retry-exhaust" | "fail" | "block"
    ) {
        return Err(format!("未知的模拟结果 {}", input.simulate));
    }
    let max_tasks = input.max_tasks.max(1);
    let mut summary = DispatchOnceSummary {
        started: Vec::new(),
        succeeded: Vec::new(),
        retried: Vec::new(),
        failed: Vec::new(),
        blocked: Vec::new(),
        skipped: Vec::new(),
    };
    let candidates: Vec<(String, i64, Option<i64>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, revision, retryAt FROM execution_task \
                 WHERE projectId=?1 AND status IN ('queued','retry_wait') \
                 ORDER BY priority DESC, queuedAt ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&input.project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    for (task_id, revision, retry_at) in candidates {
        if summary.started.len() as i64 >= max_tasks {
            break;
        }
        if retry_at.map(|at| at > now).unwrap_or(false) {
            summary.skipped.push(task_id);
            continue;
        }
        if !dependencies_satisfied(conn, &input.project_id, &task_id)? {
            summary.skipped.push(task_id);
            continue;
        }
        let claim = match claim_task_at(
            conn,
            &input.project_id,
            &task_id,
            &input.owner_id,
            revision,
            input.lease_ms,
            &input.runner_epoch,
            now,
        ) {
            Ok(claim) => claim,
            Err(_) => {
                // 竞争失败或状态已变：留给下一轮，不阻塞其它任务。
                summary.skipped.push(task_id);
                continue;
            }
        };
        summary.started.push(task_id.clone());
        let running = transition_task(
            conn,
            &input.project_id,
            &task_id,
            claim.task.revision,
            claim.task_fence,
            "running",
            None,
        )?;
        let verifying = transition_task(
            conn,
            &input.project_id,
            &task_id,
            running.revision,
            running.fencing_token,
            "verifying",
            None,
        )?;
        let attempts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM execution_attempt WHERE taskId=?1",
                [&task_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        match input.simulate.as_str() {
            "succeed" => {
                transition_task(
                    conn,
                    &input.project_id,
                    &task_id,
                    verifying.revision,
                    verifying.fencing_token,
                    "succeeded",
                    None,
                )?;
                summary.succeeded.push(task_id);
            }
            "fail" => {
                transition_task(
                    conn,
                    &input.project_id,
                    &task_id,
                    verifying.revision,
                    verifying.fencing_token,
                    "failed",
                    Some("simulated failure"),
                )?;
                summary.failed.push(task_id);
            }
            "block" => {
                transition_task(
                    conn,
                    &input.project_id,
                    &task_id,
                    verifying.revision,
                    verifying.fencing_token,
                    "blocked",
                    Some("simulated block"),
                )?;
                summary.blocked.push(task_id);
            }
            "retry-once" => {
                if attempts <= 1 {
                    // 验证失败可修复：回到 queued 并记录 repairRound（LLD 状态表），不做 verifying→retry_wait。
                    transition_task(
                        conn,
                        &input.project_id,
                        &task_id,
                        verifying.revision,
                        verifying.fencing_token,
                        "queued",
                        Some("simulated transient failure"),
                    )?;
                    conn.execute(
                        "UPDATE execution_task SET retryAt=?1, repairRound=repairRound+1 WHERE id=?2",
                        rusqlite::params![now + 1_000, task_id],
                    )
                    .map_err(|e| e.to_string())?;
                    summary.retried.push(task_id);
                } else {
                    transition_task(
                        conn,
                        &input.project_id,
                        &task_id,
                        verifying.revision,
                        verifying.fencing_token,
                        "succeeded",
                        None,
                    )?;
                    summary.succeeded.push(task_id);
                }
            }
            "retry-exhaust" => {
                if attempts >= input.max_attempts.max(1) {
                    transition_task(
                        conn,
                        &input.project_id,
                        &task_id,
                        verifying.revision,
                        verifying.fencing_token,
                        "failed",
                        Some("模拟重试次数耗尽"),
                    )?;
                    summary.failed.push(task_id);
                } else {
                    transition_task(
                        conn,
                        &input.project_id,
                        &task_id,
                        verifying.revision,
                        verifying.fencing_token,
                        "queued",
                        Some("simulated transient failure"),
                    )?;
                    conn.execute(
                        "UPDATE execution_task SET retryAt=?1, repairRound=repairRound+1 WHERE id=?2",
                        rusqlite::params![now + 1_000, task_id],
                    )
                    .map_err(|e| e.to_string())?;
                    summary.retried.push(task_id);
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(summary)
}

#[tauri::command]
pub fn execution_dispatch_once(input: DispatchOnceInput) -> Result<DispatchOnceSummary, String> {
    with_conn(|conn| dispatch_once(conn, &input, now_ms()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MapObligationInput {
    pub project_id: String,
    pub package_id: String,
    pub package_revision: i64,
    pub obligation_id: String,
    pub task_id: String,
    pub validation_item_id: String,
}

/// 登记义务到“任务 + 验证项”的映射；任务必须同项目且 Story 与义务归属一致。
pub fn map_obligation(
    conn: &Connection,
    input: &MapObligationInput,
) -> Result<PackageView, String> {
    if input.validation_item_id.trim().is_empty() {
        return Err("验证项 validationItemId 不能为空".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let owner_story: String = tx
        .query_row(
            "SELECT ownerStoryId FROM execution_obligation \
             WHERE projectId=?1 AND packageId=?2 AND packageRevision=?3 AND obligationId=?4",
            rusqlite::params![
                input.project_id,
                input.package_id,
                input.package_revision,
                input.obligation_id
            ],
            |r| r.get(0),
        )
        .map_err(|_| format!("义务 {} 不存在于该工作包", input.obligation_id))?;
    let (task_project, task_story): (String, String) = tx
        .query_row(
            "SELECT projectId, storyId FROM execution_task WHERE id=?1",
            [&input.task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| format!("任务 {} 不存在", input.task_id))?;
    if task_project != input.project_id {
        return Err("任务不属于该项目".into());
    }
    if task_story != owner_story {
        return Err(format!(
            "义务所属 Story {owner_story} 与任务 Story {task_story} 不一致"
        ));
    }
    let hash = format!(
        "sha256:{}",
        sha256_hex(
            format!(
                "{}|{}|{}|{}|{}",
                input.package_id,
                input.package_revision,
                input.obligation_id,
                input.task_id,
                input.validation_item_id
            )
            .as_bytes()
        )
    );
    tx.execute(
        "INSERT OR REPLACE INTO execution_obligation_mapping \
         (packageId, packageRevision, projectId, obligationId, taskId, validationItemId, mappingHash) \
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            input.package_id,
            input.package_revision,
            input.project_id,
            input.obligation_id,
            input.task_id,
            input.validation_item_id,
            hash
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_package(
        conn,
        &input.project_id,
        &input.package_id,
        input.package_revision,
    )
}

// ---------------- 查询 ----------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub seq: i64,
    pub event_id: String,
    pub event_type: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub task_revision: Option<i64>,
    pub task_fence: Option<i64>,
    pub payload_json: Option<String>,
    pub created_at: i64,
}

pub fn list_tasks(
    conn: &Connection,
    project_id: &str,
    batch_id: Option<&str>,
) -> Result<Vec<TaskView>, String> {
    let mut tasks = Vec::new();
    if let Some(batch_id) = batch_id {
        let mut stmt = conn
            .prepare(&format!(
                "{TASK_SELECT} WHERE projectId=?1 AND batchId=?2 ORDER BY queuedAt, id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![project_id, batch_id], row_to_task)
            .map_err(|e| e.to_string())?;
        tasks.extend(rows.filter_map(Result::ok));
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "{TASK_SELECT} WHERE projectId=?1 ORDER BY queuedAt DESC, id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], row_to_task)
            .map_err(|e| e.to_string())?;
        tasks.extend(rows.filter_map(Result::ok));
    }
    Ok(tasks)
}

/// 事件只读查询；`limit` 上限 500，按 seq 倒序后正序返回，便于时间线展示。
pub fn list_events(
    conn: &Connection,
    project_id: &str,
    task_id: Option<&str>,
    limit: i64,
) -> Result<Vec<EventView>, String> {
    let limit = limit.clamp(1, 500);
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok(EventView {
            seq: r.get(0)?,
            event_id: r.get(1)?,
            event_type: r.get(2)?,
            task_id: r.get(3)?,
            attempt_id: r.get(4)?,
            task_revision: r.get(5)?,
            task_fence: r.get(6)?,
            payload_json: r.get(7)?,
            created_at: r.get(8)?,
        })
    };
    let mut events = Vec::new();
    if let Some(task_id) = task_id {
        let mut stmt = conn
            .prepare(
                "SELECT seq, eventId, eventType, taskId, attemptId, taskRevision, taskFence, payloadJson, createdAt \
                 FROM execution_event WHERE projectId=?1 AND taskId=?2 ORDER BY seq DESC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![project_id, task_id, limit], map_row)
            .map_err(|e| e.to_string())?;
        events.extend(rows.filter_map(Result::ok));
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT seq, eventId, eventType, taskId, attemptId, taskRevision, taskFence, payloadJson, createdAt \
                 FROM execution_event WHERE projectId=?1 ORDER BY seq DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![project_id, limit], map_row)
            .map_err(|e| e.to_string())?;
        events.extend(rows.filter_map(Result::ok));
    }
    events.reverse();
    Ok(events)
}

#[tauri::command]
pub fn execution_task_list(
    project_id: String,
    batch_id: Option<String>,
) -> Result<Vec<TaskView>, String> {
    with_conn(|conn| list_tasks(conn, &project_id, batch_id.as_deref()))
}

#[tauri::command]
pub fn execution_event_list(
    project_id: String,
    task_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<EventView>, String> {
    with_conn(|conn| {
        list_events(
            conn,
            &project_id,
            task_id.as_deref(),
            limit.unwrap_or(100),
        )
    })
}

// ---------------- 执行计划与授权（G-PLAN） ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlanInput {
    pub project_id: String,
    pub task_id: String,
    pub phase: String,
    pub plan_hash: String,
    pub hash_rule_version: String,
    pub requirement_hash: String,
    pub design_hash: String,
    pub ac_hash: String,
    pub authorization_ref: Option<String>,
    pub selected_cli: String,
    pub model_ref: String,
    pub effort: Option<String>,
    pub permission_policy_hash: String,
    pub capability_manifest_hash: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub phase: String,
    pub plan_hash: String,
    pub hash_rule_version: String,
    pub requirement_hash: String,
    pub design_hash: String,
    pub ac_hash: String,
    pub authorization_ref: Option<String>,
    pub selected_cli: String,
    pub model_ref: String,
    pub effort: Option<String>,
    pub permission_policy_hash: String,
    pub capability_manifest_hash: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizePlanInput {
    pub project_id: String,
    pub plan_id: String,
    pub actor_ref: String,
    pub source: String,
    pub scope: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanAuthorizationView {
    pub id: String,
    pub plan_hash: String,
    pub actor_ref: String,
    pub source: String,
    pub scope: String,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanCheckView {
    pub plan: PlanView,
    pub authorization: Option<PlanAuthorizationView>,
    pub blockers: Vec<String>,
    pub ready: bool,
}

const PLAN_SELECT: &str = "SELECT id, projectId, taskId, phase, planHash, hashRuleVersion, requirementHash, \
    designHash, acHash, authorizationRef, selectedCli, modelRef, effort, permissionPolicyHash, \
    capabilityManifestHash, createdAt FROM execution_plan";

fn row_to_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanView> {
    Ok(PlanView {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        phase: row.get(3)?,
        plan_hash: row.get(4)?,
        hash_rule_version: row.get(5)?,
        requirement_hash: row.get(6)?,
        design_hash: row.get(7)?,
        ac_hash: row.get(8)?,
        authorization_ref: row.get(9)?,
        selected_cli: row.get(10)?,
        model_ref: row.get(11)?,
        effort: row.get(12)?,
        permission_policy_hash: row.get(13)?,
        capability_manifest_hash: row.get(14)?,
        created_at: row.get(15)?,
    })
}

/// 冻结执行计划：必填、同项目、同 planHash 幂等且不可覆盖。
pub fn create_plan(conn: &Connection, input: &CreatePlanInput) -> Result<PlanView, String> {
    if !matches!(
        input.phase.as_str(),
        "prepare" | "implement" | "verify" | "integrate" | "deliver"
    ) {
        return Err(format!("未知计划阶段 {}", input.phase));
    }
    for (name, value) in [
        ("planHash", input.plan_hash.as_str()),
        ("hashRuleVersion", input.hash_rule_version.as_str()),
        ("requirementHash", input.requirement_hash.as_str()),
        ("designHash", input.design_hash.as_str()),
        ("acHash", input.ac_hash.as_str()),
        ("selectedCli", input.selected_cli.as_str()),
        ("modelRef", input.model_ref.as_str()),
        ("permissionPolicyHash", input.permission_policy_hash.as_str()),
        ("capabilityManifestHash", input.capability_manifest_hash.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("执行计划缺少 {name}"));
        }
    }
    let task_project: String = conn
        .query_row(
            "SELECT projectId FROM execution_task WHERE id=?1",
            [&input.task_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("任务 {} 不存在", input.task_id))?;
    if task_project != input.project_id {
        return Err("任务不属于该项目".into());
    }
    if let Some(existing) = conn
        .query_row(
            &format!("{PLAN_SELECT} WHERE projectId=?1 AND planHash=?2"),
            rusqlite::params![input.project_id, input.plan_hash],
            row_to_plan,
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(existing);
    }
    let id = new_id("plan");
    conn.execute(
        "INSERT INTO execution_plan (id, projectId, taskId, phase, planHash, hashRuleVersion, requirementHash, \
         designHash, acHash, authorizationRef, selectedCli, modelRef, effort, permissionPolicyHash, \
         capabilityManifestHash, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        rusqlite::params![
            id,
            input.project_id,
            input.task_id,
            input.phase,
            input.plan_hash,
            input.hash_rule_version,
            input.requirement_hash,
            input.design_hash,
            input.ac_hash,
            input.authorization_ref,
            input.selected_cli,
            input.model_ref,
            input.effort,
            input.permission_policy_hash,
            input.capability_manifest_hash,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    read_plan(conn, &input.project_id, &id)
}

pub fn read_plan(conn: &Connection, project_id: &str, plan_id: &str) -> Result<PlanView, String> {
    conn.query_row(
        &format!("{PLAN_SELECT} WHERE projectId=?1 AND id=?2"),
        rusqlite::params![project_id, plan_id],
        row_to_plan,
    )
    .map_err(|_| format!("执行计划 {plan_id} 不存在或不属于该项目"))
}

pub fn authorize_plan(
    conn: &Connection,
    input: &AuthorizePlanInput,
) -> Result<PlanAuthorizationView, String> {
    if input.actor_ref.trim().is_empty() || input.source.trim().is_empty() || input.scope.trim().is_empty() {
        return Err("授权必须包含 actorRef、source 与 scope".into());
    }
    let plan = read_plan(conn, &input.project_id, &input.plan_id)?;
    let id = new_id("planauth");
    let now = now_ms();
    conn.execute(
        "INSERT INTO execution_plan_authorization (id, projectId, planHash, actorRef, source, scope, expiresAt, revokedAt, createdAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8)",
        rusqlite::params![
            id,
            input.project_id,
            plan.plan_hash,
            input.actor_ref,
            input.source,
            input.scope,
            input.expires_at,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(PlanAuthorizationView {
        id,
        plan_hash: plan.plan_hash,
        actor_ref: input.actor_ref.clone(),
        source: input.source.clone(),
        scope: input.scope.clone(),
        expires_at: input.expires_at,
        revoked_at: None,
        created_at: now,
    })
}

pub fn revoke_plan_authorization(
    conn: &Connection,
    project_id: &str,
    authorization_id: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE execution_plan_authorization SET revokedAt=?1 \
             WHERE id=?2 AND projectId=?3 AND revokedAt IS NULL",
            rusqlite::params![now_ms(), authorization_id, project_id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("授权不存在或已撤销".into());
    }
    Ok(())
}

/// 启动前检查：计划存在、存在未撤销授权且未过期、任务处于可执行状态。
pub fn check_plan(
    conn: &Connection,
    project_id: &str,
    plan_id: &str,
    now: i64,
) -> Result<PlanCheckView, String> {
    let plan = read_plan(conn, project_id, plan_id)?;
    let authorization = conn
        .query_row(
            "SELECT id, planHash, actorRef, source, scope, expiresAt, revokedAt, createdAt \
             FROM execution_plan_authorization WHERE projectId=?1 AND planHash=?2 AND revokedAt IS NULL \
             ORDER BY createdAt DESC LIMIT 1",
            rusqlite::params![project_id, plan.plan_hash],
            |r| {
                Ok(PlanAuthorizationView {
                    id: r.get(0)?,
                    plan_hash: r.get(1)?,
                    actor_ref: r.get(2)?,
                    source: r.get(3)?,
                    scope: r.get(4)?,
                    expires_at: r.get(5)?,
                    revoked_at: r.get(6)?,
                    created_at: r.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut blockers = Vec::new();
    match &authorization {
        None => blockers.push("NO_AUTHORIZATION".to_string()),
        Some(auth) => {
            if auth.expires_at.map(|at| at <= now).unwrap_or(false) {
                blockers.push("AUTHORIZATION_EXPIRED".to_string());
            }
        }
    }
    let task = read_task(conn, project_id, &plan.task_id)?;
    if !matches!(task.status.as_str(), "queued" | "preparing" | "running") {
        blockers.push("TASK_NOT_READY".to_string());
    }
    Ok(PlanCheckView {
        plan,
        authorization,
        ready: blockers.is_empty(),
        blockers,
    })
}

/// 任务最新计划与授权状态；无计划返回 None。
pub fn plan_status_for_task(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    now: i64,
) -> Result<Option<PlanCheckView>, String> {
    let plan_id: Option<String> = conn
        .query_row(
            "SELECT id FROM execution_plan WHERE projectId=?1 AND taskId=?2 ORDER BY createdAt DESC LIMIT 1",
            rusqlite::params![project_id, task_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match plan_id {
        Some(id) => check_plan(conn, project_id, &id, now).map(Some),
        None => Ok(None),
    }
}

// ---------------- 执行适配器边界（M0.5） ----------------

/// 执行结果。真实 adapter 尚未实现；本批只固定接口与门禁顺序。
#[derive(Debug, Clone, PartialEq)]
pub enum AdapterOutcome {
    Succeeded,
    Failed(String),
    TimedOut,
}

/// 执行适配器：真实实现负责启动／监督／停止 CLI；本批只提供脚本化替身。
pub trait ExecutionAdapter {
    fn launch(&mut self, task: &TaskView, plan: &PlanView) -> Result<String, String>;
    fn wait(&mut self, handle: &str) -> Result<AdapterOutcome, String>;
    fn stop(&mut self, handle: &str) -> Result<(), String>;
}

/// 脚本化替身：按预置结果返回，记录启动与停止，用于验证门禁与状态闭环。
#[derive(Default)]
pub struct ScriptedAdapter {
    outcomes: std::collections::VecDeque<AdapterOutcome>,
    pub launched: Vec<String>,
    pub stopped: Vec<String>,
}

impl ScriptedAdapter {
    pub fn new(outcomes: Vec<AdapterOutcome>) -> Self {
        Self {
            outcomes: outcomes.into(),
            launched: Vec::new(),
            stopped: Vec::new(),
        }
    }
}

impl ExecutionAdapter for ScriptedAdapter {
    fn launch(&mut self, task: &TaskView, plan: &PlanView) -> Result<String, String> {
        if plan.selected_cli.trim().is_empty() {
            return Err("执行计划缺少 CLI".into());
        }
        let handle = format!("scripted-{}-{}", task.id, self.launched.len() + 1);
        self.launched.push(handle.clone());
        Ok(handle)
    }

    fn wait(&mut self, _handle: &str) -> Result<AdapterOutcome, String> {
        self.outcomes
            .pop_front()
            .ok_or_else(|| "脚本化适配器没有后续结果".to_string())
    }

    fn stop(&mut self, handle: &str) -> Result<(), String> {
        self.stopped.push(handle.to_string());
        Ok(())
    }
}

/// 真实进程适配器（M1 进程基础）：启动受控命令、读取退出码、支持停止。
/// 当前不接入生产命令入口；真实 CLI adapter 仍需 worktree、审批与整树停止。
#[allow(dead_code)]
pub struct ProcessAdapter {
    program: String,
    args: Vec<String>,
    cwd: Option<std::path::PathBuf>,
    child: Option<std::process::Child>,
}

#[allow(dead_code)]
impl ProcessAdapter {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: None,
            child: None,
        }
    }

    /// 在指定工作目录中启动（用于隔离 worktree）。
    pub fn with_cwd(mut self, cwd: impl Into<std::path::PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// 启动子进程，stdin 关闭、stdout 丢弃、stderr 保留供诊断。
    pub fn launch_process(&mut self) -> Result<String, String> {
        use std::process::{Command, Stdio};
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        let child = command.spawn().map_err(|e| format!("启动进程失败：{e}"))?;
        let handle = format!("pid-{}", child.id());
        self.child = Some(child);
        Ok(handle)
    }
}

impl ExecutionAdapter for ProcessAdapter {
    fn launch(&mut self, _task: &TaskView, _plan: &PlanView) -> Result<String, String> {
        self.launch_process()
    }

    fn wait(&mut self, _handle: &str) -> Result<AdapterOutcome, String> {
        let mut child = self.child.take().ok_or("没有在运行的子进程")?;
        let status = child.wait().map_err(|e| format!("等待进程失败：{e}"))?;
        if status.success() {
            Ok(AdapterOutcome::Succeeded)
        } else {
            Ok(AdapterOutcome::Failed(format!(
                "exit {}",
                status.code().unwrap_or(-1)
            )))
        }
    }

    fn stop(&mut self, _handle: &str) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

// ---------------- 隔离 worktree（M1 基础） ----------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub branch: String,
    pub path: String,
}

fn safe_task_slug(task_id: &str) -> Result<String, String> {
    let slug: String = task_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if slug.is_empty() || slug.len() > 64 {
        return Err("任务 ID 不能用于 worktree 路径".into());
    }
    Ok(slug)
}

/// 为任务创建独立分支与 worktree；不修改主工作区。
pub fn prepare_task_worktree(
    repo_root: &std::path::Path,
    worktree_root: &std::path::Path,
    task_id: &str,
) -> Result<WorktreeInfo, String> {
    if !repo_root.join(".git").exists() {
        return Err("项目根不是 Git 仓库".into());
    }
    let slug = safe_task_slug(task_id)?;
    let branch = format!("task/{slug}");
    let path = worktree_root.join(&slug);
    if path.exists() {
        return Err(format!("worktree 路径已存在：{}", path.display()));
    }
    std::fs::create_dir_all(worktree_root).map_err(|e| format!("创建 worktree 目录失败：{e}"))?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "add", "-b", &branch])
        .arg(&path)
        .arg("HEAD")
        .output()
        .map_err(|e| format!("运行 git 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "创建 worktree 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(WorktreeInfo {
        branch,
        path: path.to_string_lossy().to_string(),
    })
}

/// 删除 worktree 与对应任务分支；失败保留现场，不静默忽略。
pub fn remove_task_worktree(
    repo_root: &std::path::Path,
    worktree_path: &str,
    branch: &str,
) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "remove", "--force", worktree_path])
        .output()
        .map_err(|e| format!("运行 git 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "删除 worktree 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["branch", "-D", branch])
        .output();
    Ok(())
}

/// 在隔离 worktree 中运行一次受控命令，结束后清理；返回结果与工作目录。
/// 这是 cwd 隔离闭环的测试入口，不暴露给生产命令；不启动真实 CLI。
#[allow(dead_code)]
pub fn run_isolated_command(
    repo_root: &std::path::Path,
    worktree_root: &std::path::Path,
    task_id: &str,
    program: &str,
    args: Vec<String>,
) -> Result<IsolatedRunResult, String> {
    let info = prepare_task_worktree(repo_root, worktree_root, task_id)?;
    let mut adapter = ProcessAdapter::new(program, args)
        .with_cwd(std::path::PathBuf::from(&info.path));
    let outcome = match adapter.launch_process() {
        Ok(handle) => adapter.wait(&handle),
        Err(error) => Err(error),
    };
    let _ = remove_task_worktree(repo_root, &info.path, &info.branch);
    outcome.map(|outcome| IsolatedRunResult {
        outcome,
        worktree: info.path,
        branch: info.branch,
    })
}

#[derive(Debug, Clone)]
pub struct IsolatedRunResult {
    pub outcome: AdapterOutcome,
    pub worktree: String,
    pub branch: String,
}

// ---------------- CLI 启动参数构造（不启动进程） ----------------

#[derive(Debug, Clone, PartialEq)]
pub struct CliInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn claude_thinking_budget(effort: &str) -> Option<u32> {
    match effort {
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" => Some(16384),
        "xhigh" | "max" => Some(32768),
        _ => None,
    }
}

/// 根据冻结计划构造 CLI 参数；只做映射，不 spawn、不写日志、不接触密钥。
pub fn build_cli_invocation(plan: &PlanView, prompt: &str) -> Result<CliInvocation, String> {
    if prompt.trim().is_empty() {
        return Err("prompt 不能为空".into());
    }
    if plan.model_ref.trim().is_empty() {
        return Err("计划缺少模型".into());
    }
    match plan.selected_cli.as_str() {
        "claude" => {
            let args = vec![
                "-p".to_string(),
                prompt.to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--model".to_string(),
                plan.model_ref.clone(),
            ];
            let mut env = Vec::new();
            if let Some(effort) = plan.effort.as_deref() {
                if let Some(budget) = claude_thinking_budget(effort) {
                    env.push(("MAX_THINKING_TOKENS".to_string(), budget.to_string()));
                }
            }
            Ok(CliInvocation {
                program: "claude".into(),
                args,
                env,
            })
        }
        "codex" => {
            let mut args = vec![
                "exec".to_string(),
                "--json".to_string(),
                "-m".to_string(),
                plan.model_ref.clone(),
            ];
            if let Some(effort) = plan.effort.as_deref() {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{effort}\""));
            }
            Ok(CliInvocation {
                program: "codex".into(),
                args,
                env: Vec::new(),
            })
        }
        "grok" => {
            let mut args = vec![
                "--output-format".to_string(),
                "streaming-json".to_string(),
            ];
            if let Some(effort) = plan.effort.as_deref() {
                args.push("--reasoning-effort".to_string());
                args.push(effort.to_string());
            }
            Ok(CliInvocation {
                program: "grok".into(),
                args,
                env: Vec::new(),
            })
        }
        other => Err(format!("不支持的 CLI：{other}")),
    }
}

// ---------------- CLI 适配器组合（受控命令，不接真实 CLI） ----------------

/// 按计划构造参数，在指定工作目录启动；program 可被测试替身覆盖。
pub struct CliAdapter {
    plan: PlanView,
    prompt: String,
    program_override: Option<String>,
    cwd: Option<std::path::PathBuf>,
    child: Option<std::process::Child>,
}

impl CliAdapter {
    pub fn new(plan: PlanView, prompt: String) -> Self {
        Self {
            plan,
            prompt,
            program_override: None,
            cwd: None,
            child: None,
        }
    }

    pub fn with_program(mut self, program: impl Into<String>) -> Self {
        self.program_override = Some(program.into());
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<std::path::PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// 按计划构造参数并启动；环境变量只来自计划映射，不含密钥。
    pub fn spawn_plan(&mut self) -> Result<String, String> {
        use std::process::{Command, Stdio};
        let invocation = build_cli_invocation(&self.plan, &self.prompt)?;
        let program = self
            .program_override
            .clone()
            .unwrap_or(invocation.program);
        let mut command = Command::new(&program);
        command
            .args(&invocation.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        for (key, value) in &invocation.env {
            command.env(key, value);
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        let child = command.spawn().map_err(|e| format!("启动 CLI 失败：{e}"))?;
        let handle = format!("pid-{}", child.id());
        self.child = Some(child);
        Ok(handle)
    }
}

impl ExecutionAdapter for CliAdapter {
    fn launch(&mut self, _task: &TaskView, _plan: &PlanView) -> Result<String, String> {
        self.spawn_plan()
    }

    fn wait(&mut self, _handle: &str) -> Result<AdapterOutcome, String> {
        let mut child = self.child.take().ok_or("没有在运行的 CLI 进程")?;
        let status = child.wait().map_err(|e| format!("等待 CLI 失败：{e}"))?;
        if status.success() {
            Ok(AdapterOutcome::Succeeded)
        } else {
            Ok(AdapterOutcome::Failed(format!(
                "exit {}",
                status.code().unwrap_or(-1)
            )))
        }
    }

    fn stop(&mut self, _handle: &str) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

/// 受控演练：worktree + 计划参数 + 进程，运行后清理。不接真实 CLI。
#[allow(dead_code)]
pub fn run_task_cli_dryrun(
    repo_root: &std::path::Path,
    worktree_root: &std::path::Path,
    task_id: &str,
    plan: PlanView,
    prompt: &str,
    program_override: Option<&str>,
) -> Result<IsolatedRunResult, String> {
    let info = prepare_task_worktree(repo_root, worktree_root, task_id)?;
    let mut adapter = CliAdapter::new(plan, prompt.to_string())
        .with_cwd(std::path::PathBuf::from(&info.path));
    if let Some(program) = program_override {
        adapter = adapter.with_program(program);
    }
    let outcome = match adapter.spawn_plan() {
        Ok(handle) => adapter.wait(&handle),
        Err(error) => Err(error),
    };
    let _ = remove_task_worktree(repo_root, &info.path, &info.branch);
    outcome.map(|outcome| IsolatedRunResult {
        outcome,
        worktree: info.path,
        branch: info.branch,
    })
}

/// 受管运行：计划门禁 → 领取 → running → 适配器启动／等待 → 结果转换。
/// 不 spawn CLI；真实 adapter 必须自行保证整树停止与身份核验。
/// 真实 CLI 适配器的受控开关：默认关闭，必须由调用方显式启用。
/// 当前不注册生产命令；接入前仍需能力验证、审批门禁与整树停止。
#[allow(dead_code)]
pub struct RealCliAdapter {
    inner: CliAdapter,
    enabled: bool,
}

#[allow(dead_code)]
impl RealCliAdapter {
    pub fn new(
        plan: PlanView,
        prompt: String,
        enabled: bool,
        program_override: Option<String>,
    ) -> Self {
        let mut inner = CliAdapter::new(plan, prompt);
        if let Some(program) = program_override {
            inner = inner.with_program(program);
        }
        Self { inner, enabled }
    }

    pub fn spawn_plan(&mut self) -> Result<String, String> {
        if !self.enabled {
            return Err("REAL_CLI_DISABLED：真实 CLI 未启用，需显式授权".into());
        }
        self.inner.spawn_plan()
    }

    pub fn with_cwd(mut self, cwd: impl Into<std::path::PathBuf>) -> Self {
        self.inner = self.inner.with_cwd(cwd);
        self
    }

    pub fn wait(&mut self, handle: &str) -> Result<AdapterOutcome, String> {
        self.inner.wait(handle)
    }

    pub fn stop(&mut self, handle: &str) -> Result<(), String> {
        self.inner.stop(handle)
    }
}

impl ExecutionAdapter for RealCliAdapter {
    fn launch(&mut self, _task: &TaskView, _plan: &PlanView) -> Result<String, String> {
        self.spawn_plan()
    }

    fn wait(&mut self, handle: &str) -> Result<AdapterOutcome, String> {
        self.inner.wait(handle)
    }

    fn stop(&mut self, handle: &str) -> Result<(), String> {
        self.inner.stop(handle)
    }
}

/// 真实 CLI 受控组合：worktree + 计划参数 + 受控适配器，运行后清理。
/// 默认关闭；不注册生产命令，需外部显式启用并完成能力验证。
#[allow(dead_code)]
pub fn run_task_real_cli(
    repo_root: &std::path::Path,
    worktree_root: &std::path::Path,
    task_id: &str,
    plan: PlanView,
    prompt: &str,
    enabled: bool,
    program_override: Option<&str>,
) -> Result<IsolatedRunResult, String> {
    let info = prepare_task_worktree(repo_root, worktree_root, task_id)?;
    let mut adapter = RealCliAdapter::new(
        plan,
        prompt.to_string(),
        enabled,
        program_override.map(|value| value.to_string()),
    )
    .with_cwd(std::path::PathBuf::from(&info.path));
    let outcome = match adapter.spawn_plan() {
        Ok(handle) => adapter.wait(&handle),
        Err(error) => Err(error),
    };
    let _ = remove_task_worktree(repo_root, &info.path, &info.branch);
    outcome.map(|outcome| IsolatedRunResult {
        outcome,
        worktree: info.path,
        branch: info.branch,
    })
}

/// 计划级审批门禁：存在未决定请求或已被拒绝／过期的审批时阻止运行。
pub fn ensure_approvals_cleared(
    conn: &Connection,
    project_id: &str,
    plan_hash: &str,
    now: i64,
) -> Result<(), String> {
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM execution_approval \
             WHERE projectId=?1 AND planHash=?2 AND decision='pending' \
               AND (expiresAt IS NULL OR expiresAt > ?3)",
            rusqlite::params![project_id, plan_hash, now],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if pending > 0 {
        return Err("APPROVAL_PENDING：存在未决定的审批请求".into());
    }
    let blocked: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM execution_approval \
             WHERE projectId=?1 AND planHash=?2 AND decision IN ('rejected','expired')",
            rusqlite::params![project_id, plan_hash],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if blocked > 0 {
        return Err("APPROVAL_REJECTED：审批被拒绝或过期".into());
    }
    Ok(())
}

pub fn run_task_with_adapter<A: ExecutionAdapter>(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    owner_id: &str,
    lease_ms: i64,
    runner_epoch: &str,
    adapter: &mut A,
    now: i64,
) -> Result<TaskView, String> {
    run_task_with_adapter_checked(
        conn,
        project_id,
        task_id,
        owner_id,
        lease_ms,
        runner_epoch,
        adapter,
        now,
        false,
    )
}

pub fn run_task_with_adapter_checked<A: ExecutionAdapter>(
    conn: &Connection,
    project_id: &str,
    task_id: &str,
    owner_id: &str,
    lease_ms: i64,
    runner_epoch: &str,
    adapter: &mut A,
    now: i64,
    require_approval: bool,
) -> Result<TaskView, String> {
    let task = read_task(conn, project_id, task_id)?;
    let plan_view = plan_status_for_task(conn, project_id, task_id, now)?
        .ok_or("PLAN_MISSING：任务没有冻结执行计划")?;
    if !plan_view.ready {
        return Err(format!(
            "PLAN_BLOCKED：{}",
            plan_view.blockers.join(", ")
        ));
    }
    if require_approval {
        ensure_approvals_cleared(conn, project_id, &plan_view.plan.plan_hash, now)?;
    }
    let claim = claim_task_at(
        conn,
        project_id,
        task_id,
        owner_id,
        task.revision,
        lease_ms,
        runner_epoch,
        now,
    )?;
    let running = transition_task(
        conn,
        project_id,
        task_id,
        claim.task.revision,
        claim.task_fence,
        "running",
        None,
    )?;
    let handle = adapter.launch(&running, &plan_view.plan)?;
    let outcome = match adapter.wait(&handle) {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = adapter.stop(&handle);
            transition_task(
                conn,
                project_id,
                task_id,
                running.revision,
                running.fencing_token,
                "failed",
                Some(&format!("ADAPTER_ERROR: {error}")),
            )?;
            return Err(error);
        }
    };
    match outcome {
        AdapterOutcome::Succeeded => {
            let verifying = transition_task(
                conn,
                project_id,
                task_id,
                running.revision,
                running.fencing_token,
                "verifying",
                None,
            )?;
            transition_task(
                conn,
                project_id,
                task_id,
                verifying.revision,
                verifying.fencing_token,
                "succeeded",
                None,
            )
        }
        AdapterOutcome::Failed(reason) => {
            let verifying = transition_task(
                conn,
                project_id,
                task_id,
                running.revision,
                running.fencing_token,
                "verifying",
                None,
            )?;
            transition_task(
                conn,
                project_id,
                task_id,
                verifying.revision,
                verifying.fencing_token,
                "queued",
                Some(&reason),
            )
        }
        AdapterOutcome::TimedOut => {
            let _ = adapter.stop(&handle);
            transition_task(
                conn,
                project_id,
                task_id,
                running.revision,
                running.fencing_token,
                "blocked",
                Some("ADAPTER_TIMEOUT"),
            )
        }
    }
}

// ---------------- 审批记录（M1 前置） ----------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestInput {
    pub project_id: String,
    pub plan_hash: String,
    pub task_id: Option<String>,
    pub tool_call_id: String,
    pub final_args_hash: String,
    pub risk: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub id: String,
    pub project_id: String,
    pub plan_hash: String,
    pub task_id: Option<String>,
    pub tool_call_id: String,
    pub final_args_hash: String,
    pub risk: String,
    pub decision: String,
    pub decided_by: Option<String>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
    pub expires_at: Option<i64>,
}

const APPROVAL_SELECT: &str = "SELECT id, projectId, planHash, taskId, toolCallId, finalArgsHash, risk, \
    decision, decidedBy, createdAt, decidedAt, expiresAt FROM execution_approval";

fn row_to_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalView> {
    Ok(ApprovalView {
        id: row.get(0)?,
        project_id: row.get(1)?,
        plan_hash: row.get(2)?,
        task_id: row.get(3)?,
        tool_call_id: row.get(4)?,
        final_args_hash: row.get(5)?,
        risk: row.get(6)?,
        decision: row.get(7)?,
        decided_by: row.get(8)?,
        created_at: row.get(9)?,
        decided_at: row.get(10)?,
        expires_at: row.get(11)?,
    })
}

/// 登记工具审批请求；同 plan + toolCall 幂等返回原记录。
pub fn request_approval(
    conn: &Connection,
    input: &ApprovalRequestInput,
) -> Result<ApprovalView, String> {
    if !matches!(input.risk.as_str(), "low" | "medium" | "high") {
        return Err(format!("未知风险等级 {}", input.risk));
    }
    for (name, value) in [
        ("planHash", input.plan_hash.as_str()),
        ("toolCallId", input.tool_call_id.as_str()),
        ("finalArgsHash", input.final_args_hash.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("审批请求缺少 {name}"));
        }
    }
    let plan_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM execution_plan WHERE projectId=?1 AND planHash=?2",
            rusqlite::params![input.project_id, input.plan_hash],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if plan_exists == 0 {
        return Err("审批关联的执行计划不存在".into());
    }
    if let Some(existing) = conn
        .query_row(
            &format!(
                "{APPROVAL_SELECT} WHERE projectId=?1 AND planHash=?2 AND toolCallId=?3"
            ),
            rusqlite::params![input.project_id, input.plan_hash, input.tool_call_id],
            row_to_approval,
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(existing);
    }
    let id = new_id("approval");
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO execution_approval (id, projectId, planHash, taskId, toolCallId, finalArgsHash, risk, decision, createdAt, expiresAt) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9)",
        rusqlite::params![
            id,
            input.project_id,
            input.plan_hash,
            input.task_id,
            input.tool_call_id,
            input.final_args_hash,
            input.risk,
            now,
            input.expires_at
        ],
    )
    .map_err(|e| e.to_string())?;
    write_event(
        &tx,
        &input.project_id,
        None,
        input.task_id.as_deref(),
        None,
        "approval.requested",
        None,
        None,
        Some(&format!(
            "{{\"approvalId\":\"{id}\",\"risk\":\"{}\"}}",
            input.risk
        )),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_approval(conn, &input.project_id, &id)
}

pub fn read_approval(
    conn: &Connection,
    project_id: &str,
    approval_id: &str,
) -> Result<ApprovalView, String> {
    conn.query_row(
        &format!("{APPROVAL_SELECT} WHERE projectId=?1 AND id=?2"),
        rusqlite::params![project_id, approval_id],
        row_to_approval,
    )
    .map_err(|_| format!("审批 {approval_id} 不存在或不属于该项目"))
}

/// 决定审批：仅 pending 可决定；过期记为 expired 并拒绝；已决定不可改。
pub fn decide_approval(
    conn: &Connection,
    project_id: &str,
    approval_id: &str,
    decision: &str,
    actor_ref: &str,
    now: i64,
) -> Result<ApprovalView, String> {
    if !matches!(decision, "approved" | "rejected") {
        return Err(format!("未知审批决定 {decision}"));
    }
    if actor_ref.trim().is_empty() {
        return Err("审批决定缺少 actorRef".into());
    }
    let current = read_approval(conn, project_id, approval_id)?;
    if current.decision != "pending" {
        return Err(format!("审批已处于 {} 状态，不能重复决定", current.decision));
    }
    if current.expires_at.map(|at| at <= now).unwrap_or(false) {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE execution_approval SET decision='expired', decidedAt=?1 WHERE id=?2",
            rusqlite::params![now, approval_id],
        )
        .map_err(|e| e.to_string())?;
        write_event(
            &tx,
            project_id,
            None,
            current.task_id.as_deref(),
            None,
            "approval.expired",
            None,
            None,
            Some(&format!("{{\"approvalId\":\"{approval_id}\"}}")),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        return Err("审批已过期，不能决定".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE execution_approval SET decision=?1, decidedBy=?2, decidedAt=?3 \
             WHERE id=?4 AND projectId=?5 AND decision='pending'",
            rusqlite::params![decision, actor_ref, now, approval_id, project_id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("审批状态已变化，拒绝重复决定".into());
    }
    write_event(
        &tx,
        project_id,
        None,
        current.task_id.as_deref(),
        None,
        "approval.decided",
        None,
        None,
        Some(&format!(
            "{{\"approvalId\":\"{approval_id}\",\"decision\":\"{decision}\"}}"
        )),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_approval(conn, project_id, approval_id)
}

pub fn list_pending_approvals(
    conn: &Connection,
    project_id: &str,
    now: i64,
) -> Result<Vec<ApprovalView>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{APPROVAL_SELECT} WHERE projectId=?1 AND decision='pending' \
             AND (expiresAt IS NULL OR expiresAt > ?2) ORDER BY createdAt"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![project_id, now], row_to_approval)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

// ---------------- Tauri 命令包装 ----------------

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    f(conn)
}

#[tauri::command]
pub fn execution_batch_create(input: CreateBatchInput) -> Result<BatchView, String> {
    with_conn(|conn| create_batch(conn, &input))
}

#[tauri::command]
pub fn execution_batch_list(project_id: String) -> Result<Vec<BatchView>, String> {
    with_conn(|conn| list_batches(conn, &project_id))
}

#[tauri::command]
pub fn execution_batch_get(project_id: String, batch_id: String) -> Result<BatchView, String> {
    with_conn(|conn| read_batch(conn, &project_id, &batch_id))
}

#[tauri::command]
pub fn execution_task_claim(
    project_id: String,
    task_id: String,
    owner_id: String,
    expected_revision: i64,
    lease_ms: i64,
    runner_epoch: String,
) -> Result<ClaimView, String> {
    with_conn(|conn| {
        claim_task(
            conn,
            &project_id,
            &task_id,
            &owner_id,
            expected_revision,
            lease_ms,
            &runner_epoch,
        )
    })
}

#[tauri::command]
pub fn execution_task_transition(
    project_id: String,
    task_id: String,
    expected_revision: i64,
    fencing_token: i64,
    to_status: String,
    reason: Option<String>,
) -> Result<TaskView, String> {
    with_conn(|conn| {
        transition_task(
            conn,
            &project_id,
            &task_id,
            expected_revision,
            fencing_token,
            &to_status,
            reason.as_deref(),
        )
    })
}

#[tauri::command]
pub fn execution_checkpoint_save(input: CheckpointInput) -> Result<CheckpointView, String> {
    with_conn(|conn| save_checkpoint(conn, &input))
}

#[tauri::command]
pub fn execution_checkpoint_latest(
    project_id: String,
    task_id: String,
) -> Result<Option<CheckpointView>, String> {
    with_conn(|conn| latest_checkpoint(conn, &project_id, &task_id))
}

#[tauri::command]
pub fn execution_package_create(input: CreatePackageInput) -> Result<PackageView, String> {
    with_conn(|conn| create_package(conn, &input))
}

#[tauri::command]
pub fn execution_package_confirm(
    project_id: String,
    package_id: String,
    revision: i64,
) -> Result<PackageView, String> {
    with_conn(|conn| confirm_package(conn, &project_id, &package_id, revision))
}

#[tauri::command]
pub fn execution_package_get(
    project_id: String,
    package_id: String,
    revision: i64,
) -> Result<PackageView, String> {
    with_conn(|conn| read_package(conn, &project_id, &package_id, revision))
}

#[tauri::command]
pub fn execution_obligation_map(input: MapObligationInput) -> Result<PackageView, String> {
    with_conn(|conn| map_obligation(conn, &input))
}

#[tauri::command]
pub fn execution_plan_create(input: CreatePlanInput) -> Result<PlanView, String> {
    with_conn(|conn| create_plan(conn, &input))
}

#[tauri::command]
pub fn execution_plan_get(project_id: String, plan_id: String) -> Result<PlanView, String> {
    with_conn(|conn| read_plan(conn, &project_id, &plan_id))
}

#[tauri::command]
pub fn execution_plan_authorize(input: AuthorizePlanInput) -> Result<PlanAuthorizationView, String> {
    with_conn(|conn| authorize_plan(conn, &input))
}

#[tauri::command]
pub fn execution_plan_revoke(project_id: String, authorization_id: String) -> Result<(), String> {
    with_conn(|conn| revoke_plan_authorization(conn, &project_id, &authorization_id))
}

#[tauri::command]
pub fn execution_plan_check(project_id: String, plan_id: String) -> Result<PlanCheckView, String> {
    with_conn(|conn| check_plan(conn, &project_id, &plan_id, now_ms()))
}

#[tauri::command]
pub fn execution_plan_task_status(
    project_id: String,
    task_id: String,
) -> Result<Option<PlanCheckView>, String> {
    with_conn(|conn| plan_status_for_task(conn, &project_id, &task_id, now_ms()))
}

#[tauri::command]
pub fn execution_approval_request(input: ApprovalRequestInput) -> Result<ApprovalView, String> {
    with_conn(|conn| request_approval(conn, &input))
}

#[tauri::command]
pub fn execution_approval_decide(
    project_id: String,
    approval_id: String,
    decision: String,
    actor_ref: String,
) -> Result<ApprovalView, String> {
    with_conn(|conn| {
        decide_approval(
            conn,
            &project_id,
            &approval_id,
            &decision,
            &actor_ref,
            now_ms(),
        )
    })
}

#[tauri::command]
pub fn execution_approval_pending(project_id: String) -> Result<Vec<ApprovalView>, String> {
    with_conn(|conn| list_pending_approvals(conn, &project_id, now_ms()))
}

#[tauri::command]
pub fn execution_approval_get(
    project_id: String,
    approval_id: String,
) -> Result<ApprovalView, String> {
    with_conn(|conn| read_approval(conn, &project_id, &approval_id))
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

    fn batch_input(story_ids: &[&str], deps: Vec<DependencyInput>) -> CreateBatchInput {
        CreateBatchInput {
            project_id: "p1".into(),
            scope_kind: "story".into(),
            story_ids: story_ids.iter().map(|s| s.to_string()).collect(),
            feature_id: Some("FEAT-001".into()),
            baseline_hash: "sha256:base".into(),
            idempotency_key: "req-1".into(),
            request_digest: "digest-1".into(),
            dependencies: deps,
        }
    }

    #[test]
    fn batch_create_is_idempotent_and_rejects_digest_mismatch() {
        let conn = fixture();
        let input = batch_input(&["STORY-1", "STORY-2"], vec![]);
        let first = create_batch(&conn, &input).unwrap();
        assert_eq!(first.tasks.len(), 2);
        assert_eq!(first.status, "running");

        let again = create_batch(&conn, &input).unwrap();
        assert_eq!(first.id, again.id);

        let mut changed = input.clone();
        changed.request_digest = "other".into();
        assert!(create_batch(&conn, &changed).unwrap_err().contains("幂等键"));
    }

    #[test]
    fn dependency_cycle_is_rejected() {
        let conn = fixture();
        let deps = vec![
            DependencyInput {
                successor_story_id: "STORY-2".into(),
                predecessor_story_id: "STORY-1".into(),
                required_artifact_key: "artifact".into(),
            },
            DependencyInput {
                successor_story_id: "STORY-1".into(),
                predecessor_story_id: "STORY-2".into(),
                required_artifact_key: "artifact".into(),
            },
        ];
        let err = create_batch(&conn, &batch_input(&["STORY-1", "STORY-2"], deps)).unwrap_err();
        assert!(err.contains("环"));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM execution_batch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "失败事务必须整体回滚");
    }

    #[test]
    fn claim_enforces_revision_dependency_and_lease_cas() {
        let conn = fixture();
        let deps = vec![DependencyInput {
            successor_story_id: "STORY-2".into(),
            predecessor_story_id: "STORY-1".into(),
            required_artifact_key: "artifact".into(),
        }];
        let batch = create_batch(&conn, &batch_input(&["STORY-1", "STORY-2"], deps)).unwrap();
        let first = batch.tasks.iter().find(|t| t.story_id == "STORY-1").unwrap();
        let second = batch.tasks.iter().find(|t| t.story_id == "STORY-2").unwrap();

        // 后继任务在前置完成前不可领取。
        assert!(claim_task(&conn, "p1", &second.id, "owner", second.revision, 60_000, "epoch").is_err());

        let claim = claim_task(&conn, "p1", &first.id, "owner", first.revision, 60_000, "epoch").unwrap();
        assert_eq!(claim.task.status, "preparing");
        assert_eq!(claim.task_fence, 1);

        // 旧 revision 再次领取必须失败。
        assert!(claim_task(&conn, "p1", &first.id, "other", first.revision, 60_000, "epoch").is_err());

        // 推进前置到 succeeded 后，后继可领取。
        let mut rev = claim.task.revision;
        let mut fence = claim.task_fence;
        for status in ["running", "verifying", "succeeded"] {
            let t = transition_task(&conn, "p1", &first.id, rev, fence, status, None).unwrap();
            rev = t.revision;
            fence = t.fencing_token;
        }
        assert!(claim_task(&conn, "p1", &second.id, "owner", second.revision, 60_000, "epoch").is_ok());
    }

    #[test]
    fn transition_rejects_illegal_edges_and_stale_fence() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];

        assert!(transition_task(&conn, "p1", &task.id, task.revision, task.fencing_token, "succeeded", None).is_err());

        let claim = claim_task(&conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();
        // 旧 fence 写入被拒。
        assert!(transition_task(&conn, "p1", &task.id, claim.task.revision, claim.task_fence - 1, "running", None)
            .unwrap_err()
            .contains("LEASE_LOST"));
        assert_eq!(
            transition_task(&conn, "p1", &task.id, claim.task.revision, claim.task_fence, "running", None)
                .unwrap()
                .status,
            "running"
        );
    }

    #[test]
    fn checkpoint_requires_live_lease() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];
        let claim = claim_task(&conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();

        let input = CheckpointInput {
            project_id: "p1".into(),
            task_id: task.id.clone(),
            attempt_id: claim.attempt_id.clone(),
            task_fence: claim.task_fence,
            work_package_id: None,
            work_package_revision: None,
            plan_hash: Some("sha256:plan".into()),
            step_cursor: Some("implement".into()),
            artifact_manifest_hash: None,
            source_manifest_hash: None,
            head_revision: None,
            dirty_diff_hash: None,
            checkpoint_uri: None,
            checkpoint_hash: None,
        };
        let saved = save_checkpoint(&conn, &input).unwrap();
        assert_eq!(saved.task_fence, claim.task_fence);

        let latest = latest_checkpoint(&conn, "p1", &task.id).unwrap().unwrap();
        assert_eq!(latest.id, saved.id);

        let mut stale = input.clone();
        stale.task_fence = 999;
        assert!(save_checkpoint(&conn, &stale).unwrap_err().contains("LEASE_LOST"));
    }

    fn package_input(obligations: Vec<ObligationInput>) -> CreatePackageInput {
        CreatePackageInput {
            project_id: "p1".into(),
            batch_id: None,
            feature_id: "FEAT-001".into(),
            work_level: "feature".into(),
            source_manifest_hash: "sha256:src".into(),
            package_hash: "sha256:pkg".into(),
            stories: vec![PackageStoryInput {
                story_id: "STORY-1".into(),
                feature_id: "FEAT-001".into(),
                source_hash: "sha256:s1".into(),
                disposition: "execute".into(),
                reason_ref: None,
            }],
            obligations,
        }
    }

    fn obligation(id: &str, method: Option<&str>) -> ObligationInput {
        ObligationInput {
            obligation_id: id.into(),
            owner_story_id: "STORY-1".into(),
            kind: "ac".into(),
            source_locator: format!("docs/Plan/Story/STORY-1.md#{id}"),
            source_hash: "sha256:ac".into(),
            applicability: "required".into(),
            applicability_basis_ref: None,
            method_ref: method.map(|m| m.to_string()),
            manifest_item_hash: format!("sha256:{id}"),
        }
    }

    #[test]
    fn package_confirm_requires_method_for_required_obligations() {
        let conn = fixture();
        let missing = create_package(&conn, &package_input(vec![obligation("AC-1", None)])).unwrap();
        assert!(!missing.coverage.ready);
        assert_eq!(missing.coverage.missing_method, vec!["AC-1".to_string()]);
        assert!(confirm_package(&conn, "p1", &missing.id, missing.revision).is_err());

        let ready = create_package(
            &conn,
            &CreatePackageInput {
                package_hash: "sha256:pkg2".into(),
                ..package_input(vec![obligation("AC-1", Some("test:auto"))])
            },
        )
        .unwrap();
        assert!(!ready.coverage.ready, "只有验证方法、没有任务映射不得 ready");
        assert_eq!(ready.coverage.missing_mapping, vec!["AC-1".to_string()]);
        assert!(confirm_package(&conn, "p1", &ready.id, ready.revision).is_err());

        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let mapped = map_obligation(
            &conn,
            &MapObligationInput {
                project_id: "p1".into(),
                package_id: ready.id.clone(),
                package_revision: ready.revision,
                obligation_id: "AC-1".into(),
                task_id: batch.tasks[0].id.clone(),
                validation_item_id: "test:auto".into(),
            },
        )
        .unwrap();
        assert!(mapped.coverage.ready);
        assert_eq!(mapped.coverage.mapped, 1);
        let confirmed = confirm_package(&conn, "p1", &ready.id, ready.revision).unwrap();
        assert_eq!(confirmed.state, "confirmed");
    }

    #[test]
    fn obligation_map_rejects_story_mismatch() {
        let conn = fixture();
        let pkg = create_package(
            &conn,
            &package_input(vec![obligation("AC-1", Some("test:auto"))]),
        )
        .unwrap();
        // 任务属于 STORY-2，义务归属 STORY-1：拒绝跨 Story 充数。
        let batch = create_batch(&conn, &batch_input(&["STORY-2"], vec![])).unwrap();
        let err = map_obligation(
            &conn,
            &MapObligationInput {
                project_id: "p1".into(),
                package_id: pkg.id.clone(),
                package_revision: pkg.revision,
                obligation_id: "AC-1".into(),
                task_id: batch.tasks[0].id.clone(),
                validation_item_id: "test:auto".into(),
            },
        )
        .unwrap_err();
        assert!(err.contains("不一致"));
    }

    #[test]
    fn not_applicable_obligation_requires_basis() {
        let conn = fixture();
        let mut item = obligation("AC-2", None);
        item.applicability = "notApplicable".into();
        let err = create_package(&conn, &package_input(vec![item])).unwrap_err();
        assert!(err.contains("依据"));

        let mut with_basis = obligation("AC-2", None);
        with_basis.applicability = "notApplicable".into();
        with_basis.applicability_basis_ref = Some("docs/Test/TEST-1.md#scope".into());
        let pkg = create_package(&conn, &package_input(vec![with_basis])).unwrap();
        assert_eq!(pkg.coverage.not_applicable, 1);
        assert!(!pkg.coverage.ready, "只有不适用义务时不得 ready");
    }

    fn blocked_with_checkpoint(conn: &Connection) -> (String, i64, i64) {
        let batch = create_batch(conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];
        let claim = claim_task(conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();
        let running = transition_task(
            conn,
            "p1",
            &task.id,
            claim.task.revision,
            claim.task_fence,
            "running",
            None,
        )
        .unwrap();
        save_checkpoint(
            conn,
            &CheckpointInput {
                project_id: "p1".into(),
                task_id: task.id.clone(),
                attempt_id: claim.attempt_id.clone(),
                task_fence: claim.task_fence,
                work_package_id: None,
                work_package_revision: None,
                plan_hash: Some("sha256:plan".into()),
                step_cursor: Some("implement".into()),
                artifact_manifest_hash: None,
                source_manifest_hash: Some("sha256:src".into()),
                head_revision: None,
                dirty_diff_hash: None,
                checkpoint_uri: None,
                checkpoint_hash: None,
            },
        )
        .unwrap();
        let blocked = transition_task(
            conn,
            "p1",
            &task.id,
            running.revision,
            running.fencing_token,
            "blocked",
            Some("simulated"),
        )
        .unwrap();
        (task.id.clone(), blocked.fencing_token, blocked.revision)
    }

    #[test]
    fn recovery_inspect_blocks_live_writer_and_missing_checkpoint() {
        let conn = fixture();
        let (task_id, _fence, _revision) = blocked_with_checkpoint(&conn);
        let pre = inspect_recovery(
            &conn,
            &RecoveryInspectInput {
                project_id: "p1".into(),
                task_id: task_id.clone(),
            },
            now_ms(),
        )
        .unwrap();
        assert!(pre.blockers.contains(&"OLD_WRITER_MAY_BE_ALIVE".to_string()));
        assert!(!pre.resumable);

        let mut second = batch_input(&["STORY-2"], vec![]);
        second.idempotency_key = "req-2".into();
        second.request_digest = "digest-2".into();
        let other = create_batch(&conn, &second).unwrap();
        let pre2 = inspect_recovery(
            &conn,
            &RecoveryInspectInput {
                project_id: "p1".into(),
                task_id: other.tasks[0].id.clone(),
            },
            now_ms(),
        )
        .unwrap();
        assert!(pre2.blockers.contains(&"CHECKPOINT_MISSING".to_string()));
        assert!(!pre2.resumable);
    }

    #[test]
    fn recovery_resume_requires_stop_confirmation_and_advances_fence() {
        let conn = fixture();
        let (task_id, fence, revision) = blocked_with_checkpoint(&conn);
        // 模拟已确认旧进程停止后租约过期。
        conn.execute(
            "UPDATE execution_attempt SET leaseUntil=1 WHERE taskId=?1",
            [&task_id],
        )
        .unwrap();
        let pre = inspect_recovery(
            &conn,
            &RecoveryInspectInput {
                project_id: "p1".into(),
                task_id: task_id.clone(),
            },
            now_ms(),
        )
        .unwrap();
        assert!(pre.resumable, "blockers: {:?}", pre.blockers);

        let missing = RecoveryResumeInput {
            project_id: "p1".into(),
            task_id: task_id.clone(),
            expected_revision: revision,
            stop_confirmation_ref: String::new(),
        };
        assert!(resume_task(&conn, &missing, now_ms())
            .unwrap_err()
            .contains("STOP_UNCONFIRMED"));

        let confirmed = RecoveryResumeInput {
            project_id: "p1".into(),
            task_id: task_id.clone(),
            expected_revision: revision,
            stop_confirmation_ref: "stop:evidence-1".into(),
        };
        let resumed = resume_task(&conn, &confirmed, now_ms()).unwrap();
        assert_eq!(resumed.status, "queued");
        assert_eq!(resumed.fencing_token, fence + 1);
    }

    fn dispatch_input(simulate: &str, max_attempts: i64) -> DispatchOnceInput {
        DispatchOnceInput {
            project_id: "p1".into(),
            owner_id: "runner-1".into(),
            max_tasks: 4,
            lease_ms: 60_000,
            runner_epoch: "epoch-1".into(),
            simulate: simulate.into(),
            max_attempts,
        }
    }

    #[test]
    fn dispatch_respects_dependency_order() {
        let conn = fixture();
        let deps = vec![DependencyInput {
            successor_story_id: "STORY-2".into(),
            predecessor_story_id: "STORY-1".into(),
            required_artifact_key: "artifact".into(),
        }];
        let batch = create_batch(&conn, &batch_input(&["STORY-1", "STORY-2"], deps)).unwrap();
        let input = dispatch_input("succeed", 2);
        let now = 1_000_000;

        let first = dispatch_once(&conn, &input, now).unwrap();
        // 同一轮可级联：前置成功后，后继的依赖 gate 才放行。
        assert_eq!(first.succeeded.len(), 2, "依赖满足后的后继可在同轮执行");
        let order: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT seq, taskId FROM execution_event WHERE eventType='task.succeeded' ORDER BY seq")
                .unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.filter_map(Result::ok).collect()
        };
        assert_eq!(order.len(), 2);
        let story1 = batch
            .tasks
            .iter()
            .find(|t| t.story_id == "STORY-1")
            .unwrap()
            .id
            .clone();
        assert_eq!(order[0].1, story1, "前置任务必须先成功");
        assert!(dispatch_once(&conn, &input, now).unwrap().succeeded.is_empty());
    }

    #[test]
    fn dispatch_retries_once_then_succeeds_after_backoff() {
        let conn = fixture();
        create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let input = dispatch_input("retry-once", 2);
        let now = 1_000_000;

        let first = dispatch_once(&conn, &input, now).unwrap();
        assert_eq!(first.retried.len(), 1);
        assert!(first.succeeded.is_empty());

        // 退避未到：不忙循环，任务留在 retry_wait。
        let early = dispatch_once(&conn, &input, now).unwrap();
        assert_eq!(early.skipped.len(), 1);
        assert!(early.retried.is_empty());

        let later = dispatch_once(&conn, &input, now + 2_000).unwrap();
        assert_eq!(later.succeeded.len(), 1);
    }

    #[test]
    fn dispatch_stops_after_retry_budget() {
        let conn = fixture();
        create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let input = dispatch_input("retry-exhaust", 1);
        let first = dispatch_once(&conn, &input, 1_000_000).unwrap();
        assert_eq!(first.failed.len(), 1);
        assert_eq!(first.retried.len(), 0);
    }

    #[test]
    fn task_and_event_queries_return_persisted_rows() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];
        let claim = claim_task(&conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();
        let mut rev = claim.task.revision;
        let mut fence = claim.task_fence;
        for status in ["running", "verifying", "succeeded"] {
            let t = transition_task(&conn, "p1", &task.id, rev, fence, status, None).unwrap();
            rev = t.revision;
            fence = t.fencing_token;
        }
        let tasks = list_tasks(&conn, "p1", Some(&batch.id)).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "succeeded");

        let events = list_events(&conn, "p1", Some(&task.id), 10).unwrap();
        assert!(events.len() >= 4, "应包含 claimed/running/verifying/succeeded 事件");
        assert_eq!(events.first().unwrap().event_type, "task.claimed");
        assert_eq!(events.last().unwrap().event_type, "task.succeeded");
    }

    #[test]
    fn startup_recovery_blocks_expired_lease_and_keeps_active_key() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];
        let claim = claim_task(&conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();
        conn.execute(
            "UPDATE execution_attempt SET leaseUntil=1 WHERE id=?1",
            [&claim.attempt_id],
        )
        .unwrap();

        let recovered = recover_interrupted(&conn, now_ms()).unwrap();
        assert_eq!(recovered, 1);
        let after = read_task(&conn, "p1", &task.id).unwrap();
        assert_eq!(after.status, "blocked");
        assert_eq!(
            after.blocked_reason.as_deref(),
            Some("LEASE_EXPIRED_NEEDS_RECOVERY")
        );
        assert!(after.active_key_held, "回收后仍占活动键，等人工恢复");
        let attempt_status: String = conn
            .query_row(
                "SELECT status FROM execution_attempt WHERE id=?1",
                [&claim.attempt_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempt_status, "interrupted");
    }

    #[test]
    fn startup_recovery_leaves_live_lease_untouched() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task = &batch.tasks[0];
        let claim = claim_task(&conn, "p1", &task.id, "owner", task.revision, 60_000, "epoch").unwrap();

        let recovered = recover_interrupted(&conn, now_ms()).unwrap();
        assert_eq!(recovered, 0);
        assert_eq!(read_task(&conn, "p1", &task.id).unwrap().status, "preparing");
        let attempt_status: String = conn
            .query_row(
                "SELECT status FROM execution_attempt WHERE id=?1",
                [&claim.attempt_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempt_status, "claimed");
    }

    fn plan_input(task_id: &str) -> CreatePlanInput {
        CreatePlanInput {
            project_id: "p1".into(),
            task_id: task_id.into(),
            phase: "implement".into(),
            plan_hash: "sha256:plan-1".into(),
            hash_rule_version: "v1".into(),
            requirement_hash: "sha256:req".into(),
            design_hash: "sha256:des".into(),
            ac_hash: "sha256:ac".into(),
            authorization_ref: Some("auth:1".into()),
            selected_cli: "claude".into(),
            model_ref: "model-x".into(),
            effort: Some("high".into()),
            permission_policy_hash: "sha256:perm".into(),
            capability_manifest_hash: "sha256:cap".into(),
        }
    }

    #[test]
    fn plan_create_is_immutable_and_idempotent() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let plan = create_plan(&conn, &plan_input(&batch.tasks[0].id)).unwrap();
        let again = create_plan(&conn, &plan_input(&batch.tasks[0].id)).unwrap();
        assert_eq!(plan.id, again.id, "同 planHash 必须幂等返回原计划");

        let mut bad = plan_input(&batch.tasks[0].id);
        bad.model_ref = "  ".into();
        assert!(create_plan(&conn, &bad).unwrap_err().contains("modelRef"));

        let mut foreign = plan_input("task-other");
        foreign.project_id = "p1".into();
        assert!(create_plan(&conn, &foreign).is_err());
    }

    #[test]
    fn plan_check_requires_valid_authorization_and_task_state() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let plan = create_plan(&conn, &plan_input(&batch.tasks[0].id)).unwrap();

        let none = check_plan(&conn, "p1", &plan.id, now_ms()).unwrap();
        assert!(!none.ready);
        assert!(none.blockers.contains(&"NO_AUTHORIZATION".to_string()));

        let auth = authorize_plan(
            &conn,
            &AuthorizePlanInput {
                project_id: "p1".into(),
                plan_id: plan.id.clone(),
                actor_ref: "user:1".into(),
                source: "user".into(),
                scope: "task".into(),
                expires_at: None,
            },
        )
        .unwrap();
        let ok = check_plan(&conn, "p1", &plan.id, now_ms()).unwrap();
        assert!(ok.ready, "blockers: {:?}", ok.blockers);

        revoke_plan_authorization(&conn, "p1", &auth.id).unwrap();
        let revoked = check_plan(&conn, "p1", &plan.id, now_ms()).unwrap();
        assert!(revoked.blockers.contains(&"NO_AUTHORIZATION".to_string()));

        let expired = authorize_plan(
            &conn,
            &AuthorizePlanInput {
                project_id: "p1".into(),
                plan_id: plan.id.clone(),
                actor_ref: "user:1".into(),
                source: "user".into(),
                scope: "task".into(),
                expires_at: Some(1),
            },
        )
        .unwrap();
        let exp = check_plan(&conn, "p1", &plan.id, now_ms()).unwrap();
        assert!(exp.blockers.contains(&"AUTHORIZATION_EXPIRED".to_string()));
        assert_eq!(exp.authorization.unwrap().id, expired.id);
    }

    #[test]
    fn task_plan_status_returns_none_without_plan_and_ready_with_authorization() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        assert!(plan_status_for_task(&conn, "p1", &task_id, now_ms()).unwrap().is_none());

        let plan = create_plan(&conn, &plan_input(&task_id)).unwrap();
        let pending = plan_status_for_task(&conn, "p1", &task_id, now_ms()).unwrap().unwrap();
        assert_eq!(pending.plan.id, plan.id);
        assert!(!pending.ready);

        authorize_plan(
            &conn,
            &AuthorizePlanInput {
                project_id: "p1".into(),
                plan_id: plan.id,
                actor_ref: "user:1".into(),
                source: "user".into(),
                scope: "task".into(),
                expires_at: None,
            },
        )
        .unwrap();
        let ready = plan_status_for_task(&conn, "p1", &task_id, now_ms()).unwrap().unwrap();
        assert!(ready.ready, "blockers: {:?}", ready.blockers);
    }

    fn ready_plan(conn: &Connection, task_id: &str, hash: &str) -> PlanView {
        let mut input = plan_input(task_id);
        input.plan_hash = hash.into();
        let plan = create_plan(conn, &input).unwrap();
        authorize_plan(
            conn,
            &AuthorizePlanInput {
                project_id: "p1".into(),
                plan_id: plan.id.clone(),
                actor_ref: "user:1".into(),
                source: "user".into(),
                scope: "task".into(),
                expires_at: None,
            },
        )
        .unwrap();
        plan
    }

    #[test]
    fn run_task_requires_ready_plan_before_launch() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();

        let mut adapter = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let missing = run_task_with_adapter(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut adapter, now_ms(),
        )
        .unwrap_err();
        assert!(missing.contains("PLAN_MISSING"));
        assert!(adapter.launched.is_empty(), "无计划不得启动适配器");

        create_plan(&conn, &plan_input(&task_id)).unwrap();
        let mut blocked = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let err = run_task_with_adapter(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut blocked, now_ms(),
        )
        .unwrap_err();
        assert!(err.contains("PLAN_BLOCKED"));
        assert!(blocked.launched.is_empty(), "无授权不得启动适配器");
    }

    #[test]
    fn run_task_succeeds_and_failure_requeues() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        ready_plan(&conn, &task_id, "sha256:plan-ok");
        let mut adapter = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let done = run_task_with_adapter(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut adapter, now_ms(),
        )
        .unwrap();
        assert_eq!(done.status, "succeeded");
        assert_eq!(adapter.launched.len(), 1);

        let mut second = batch_input(&["STORY-2"], vec![]);
        second.idempotency_key = "req-2".into();
        second.request_digest = "digest-2".into();
        let other = create_batch(&conn, &second).unwrap();
        let other_task = other.tasks[0].id.clone();
        ready_plan(&conn, &other_task, "sha256:plan-fail");
        let mut failing = ScriptedAdapter::new(vec![AdapterOutcome::Failed("simulated".into())]);
        let failed = run_task_with_adapter(
            &conn, "p1", &other_task, "runner", 60_000, "epoch", &mut failing, now_ms(),
        )
        .unwrap();
        assert_eq!(failed.status, "queued", "可修复失败回到 queued");
    }

    #[test]
    fn run_task_timeout_blocks_and_stops_adapter() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        ready_plan(&conn, &task_id, "sha256:plan-timeout");
        let mut adapter = ScriptedAdapter::new(vec![AdapterOutcome::TimedOut]);
        let blocked = run_task_with_adapter(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut adapter, now_ms(),
        )
        .unwrap();
        assert_eq!(blocked.status, "blocked");
        assert_eq!(adapter.stopped.len(), 1, "超时必须请求停止");
    }

    #[cfg(windows)]
    #[test]
    fn process_adapter_reports_exit_status() {
        let mut ok = ProcessAdapter::new("cmd", vec!["/C".into(), "exit 0".into()]);
        ok.launch_process().unwrap();
        assert_eq!(ok.wait("handle").unwrap(), AdapterOutcome::Succeeded);

        let mut bad = ProcessAdapter::new("cmd", vec!["/C".into(), "exit 3".into()]);
        bad.launch_process().unwrap();
        match bad.wait("handle").unwrap() {
            AdapterOutcome::Failed(reason) => assert!(reason.contains('3'), "reason={reason}"),
            other => panic!("期望失败，实际 {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn process_adapter_stop_terminates_child() {
        let mut adapter = ProcessAdapter::new(
            "cmd",
            vec!["/C".into(), "ping -n 20 127.0.0.1 >NUL".into()],
        );
        adapter.launch_process().unwrap();
        adapter.stop("handle").unwrap();
        assert!(adapter.wait("handle").is_err(), "停止后不应再有子进程");
    }

    fn run_git(dir: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} 失败：{}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_git_repo(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        run_git(dir, &["init"]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("README.md"), "init").unwrap();
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn worktree_create_and_remove_roundtrip() {
        let base = std::env::temp_dir().join(format!("wt-test-{}", uuid::Uuid::new_v4().simple()));
        let repo = base.join("repo");
        let worktrees = base.join("worktrees");
        init_git_repo(&repo);

        let info = prepare_task_worktree(&repo, &worktrees, "task-demo").unwrap();
        assert!(std::path::Path::new(&info.path).exists());
        assert_eq!(info.branch, "task/task-demo");
        assert!(std::path::Path::new(&info.path).join("README.md").exists());

        remove_task_worktree(&repo, &info.path, &info.branch).unwrap();
        assert!(!std::path::Path::new(&info.path).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_rejects_non_git_root_and_unsafe_id() {
        let base = std::env::temp_dir().join(format!("wt-test-{}", uuid::Uuid::new_v4().simple()));
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(prepare_task_worktree(&plain, &base.join("wt"), "task-1")
            .unwrap_err()
            .contains("Git"));

        let repo = base.join("repo");
        init_git_repo(&repo);
        assert!(prepare_task_worktree(&repo, &base.join("wt2"), "///")
            .unwrap_err()
            .contains("任务 ID"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn process_adapter_respects_working_directory() {
        let dir = std::env::temp_dir().join(format!("cwd-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut adapter = ProcessAdapter::new(
            "cmd",
            vec!["/C".into(), "echo hi > out.txt".into()],
        )
        .with_cwd(dir.clone());
        adapter.launch_process().unwrap();
        assert_eq!(adapter.wait("handle").unwrap(), AdapterOutcome::Succeeded);
        assert!(dir.join("out.txt").exists(), "命令应在指定工作目录中执行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_isolated_command_creates_and_cleans_worktree() {
        let base = std::env::temp_dir().join(format!("iso-test-{}", uuid::Uuid::new_v4().simple()));
        let repo = base.join("repo");
        let worktrees = base.join("worktrees");
        init_git_repo(&repo);

        let result =
            run_isolated_command(&repo, &worktrees, "task-iso", "git", vec!["status".into()]).unwrap();
        assert_eq!(result.outcome, AdapterOutcome::Succeeded);
        assert_eq!(result.branch, "task/task-iso");
        assert!(
            !std::path::Path::new(&result.worktree).exists(),
            "运行结束后应清理 worktree"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    fn approval_input(plan_hash: &str, tool_call_id: &str, expires_at: Option<i64>) -> ApprovalRequestInput {
        ApprovalRequestInput {
            project_id: "p1".into(),
            plan_hash: plan_hash.into(),
            task_id: None,
            tool_call_id: tool_call_id.into(),
            final_args_hash: "sha256:args".into(),
            risk: "high".into(),
            expires_at,
        }
    }

    #[test]
    fn approval_request_is_idempotent_and_requires_plan() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        let mut input = approval_input("sha256:plan-1", "tool-1", None);
        input.task_id = Some(task_id.clone());

        assert!(request_approval(&conn, &input).unwrap_err().contains("执行计划"));
        create_plan(&conn, &plan_input(&task_id)).unwrap();
        let first = request_approval(&conn, &input).unwrap();
        let again = request_approval(&conn, &input).unwrap();
        assert_eq!(first.id, again.id, "同 plan + toolCall 幂等");
        assert_eq!(first.decision, "pending");
        let requested: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM execution_event WHERE eventType='approval.requested' AND taskId=?1",
                [&task_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(requested, 1, "幂等请求不应重复写事件");
    }

    #[test]
    fn approval_decide_rejects_repeat_and_handles_expiry() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        create_plan(&conn, &plan_input(&task_id)).unwrap();

        let mut first_input = approval_input("sha256:plan-1", "tool-1", None);
        first_input.task_id = Some(task_id.clone());
        let pending = request_approval(&conn, &first_input).unwrap();
        let approved = decide_approval(&conn, "p1", &pending.id, "approved", "user:1", now_ms()).unwrap();
        assert_eq!(approved.decision, "approved");
        assert!(decide_approval(&conn, "p1", &pending.id, "rejected", "user:1", now_ms()).is_err());
        let decided: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM execution_event WHERE eventType='approval.decided' AND taskId=?1",
                [&task_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decided, 1, "决定应写入事件流");

        let mut expired_input = approval_input("sha256:plan-1", "tool-2", Some(1));
        expired_input.task_id = Some(task_id.clone());
        let expired = request_approval(&conn, &expired_input).unwrap();
        assert!(decide_approval(&conn, "p1", &expired.id, "approved", "user:1", now_ms())
            .unwrap_err()
            .contains("过期"));
        assert_eq!(read_approval(&conn, "p1", &expired.id).unwrap().decision, "expired");

        let pending_list = list_pending_approvals(&conn, "p1", now_ms()).unwrap();
        assert!(pending_list.is_empty(), "已决定与过期都不应出现在待批列表");
    }

    #[test]
    fn run_task_approval_gate_blocks_pending_and_allows_approved() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        ready_plan(&conn, &task_id, "sha256:plan-gate");

        let mut input = approval_input("sha256:plan-gate", "tool-gate", None);
        input.task_id = Some(task_id.clone());
        let pending = request_approval(&conn, &input).unwrap();
        let mut blocked = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let err = run_task_with_adapter_checked(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut blocked, now_ms(), true,
        )
        .unwrap_err();
        assert!(err.contains("APPROVAL_PENDING"));
        assert!(blocked.launched.is_empty(), "待审批不得启动适配器");

        decide_approval(&conn, "p1", &pending.id, "approved", "user:1", now_ms()).unwrap();
        let mut allowed = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let done = run_task_with_adapter_checked(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut allowed, now_ms(), true,
        )
        .unwrap();
        assert_eq!(done.status, "succeeded");
        assert_eq!(allowed.launched.len(), 1);
    }

    #[test]
    fn run_task_approval_gate_blocks_rejected() {
        let conn = fixture();
        let mut second = batch_input(&["STORY-2"], vec![]);
        second.idempotency_key = "req-2".into();
        second.request_digest = "digest-2".into();
        let batch = create_batch(&conn, &second).unwrap();
        let task_id = batch.tasks[0].id.clone();
        ready_plan(&conn, &task_id, "sha256:plan-gate-rej");

        let mut input = approval_input("sha256:plan-gate-rej", "tool-rej", None);
        input.task_id = Some(task_id.clone());
        let pending = request_approval(&conn, &input).unwrap();
        decide_approval(&conn, "p1", &pending.id, "rejected", "user:1", now_ms()).unwrap();

        let mut adapter = ScriptedAdapter::new(vec![AdapterOutcome::Succeeded]);
        let err = run_task_with_adapter_checked(
            &conn, "p1", &task_id, "runner", 60_000, "epoch", &mut adapter, now_ms(), true,
        )
        .unwrap_err();
        assert!(err.contains("APPROVAL_REJECTED"));
        assert!(adapter.launched.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn real_cli_adapter_requires_explicit_enable() {
        let base = std::env::temp_dir().join(format!("realcli-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();
        let script = base.join("fake-cli.cmd");
        std::fs::write(&script, "@echo off\r\nexit /b 0\r\n").unwrap();

        let mut disabled = RealCliAdapter::new(
            manual_plan(),
            "do work".into(),
            false,
            Some(script.to_string_lossy().to_string()),
        );
        assert!(disabled
            .spawn_plan()
            .unwrap_err()
            .contains("REAL_CLI_DISABLED"));

        let mut enabled = RealCliAdapter::new(
            manual_plan(),
            "do work".into(),
            true,
            Some(script.to_string_lossy().to_string()),
        );
        enabled.spawn_plan().unwrap();
        assert_eq!(enabled.wait("handle").unwrap(), AdapterOutcome::Succeeded);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn run_task_real_cli_is_disabled_by_default_and_cleans_worktree() {
        let base = std::env::temp_dir().join(format!("realcombo-{}", uuid::Uuid::new_v4().simple()));
        let repo = base.join("repo");
        let worktrees = base.join("worktrees");
        init_git_repo(&repo);
        let script = base.join("fake-cli.cmd");
        std::fs::write(&script, "@echo off\r\nexit /b 0\r\n").unwrap();

        let disabled = run_task_real_cli(
            &repo,
            &worktrees,
            "task-real-disabled",
            manual_plan(),
            "do work",
            false,
            Some(script.to_str().unwrap()),
        );
        assert!(disabled.unwrap_err().contains("REAL_CLI_DISABLED"));
        assert!(!worktrees.join("task-real-disabled").exists(), "失败后也应清理 worktree");

        let enabled = run_task_real_cli(
            &repo,
            &worktrees,
            "task-real-enabled",
            manual_plan(),
            "do work",
            true,
            Some(script.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(enabled.outcome, AdapterOutcome::Succeeded);
        assert!(!std::path::Path::new(&enabled.worktree).exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cli_invocation_maps_model_effort_and_rejects_unknown() {
        let conn = fixture();
        let batch = create_batch(&conn, &batch_input(&["STORY-1"], vec![])).unwrap();
        let task_id = batch.tasks[0].id.clone();
        let plan = create_plan(&conn, &plan_input(&task_id)).unwrap();

        let claude = build_cli_invocation(&plan, "do work").unwrap();
        assert_eq!(claude.program, "claude");
        assert!(claude.args.contains(&"model-x".to_string()));
        assert!(claude.args.contains(&"--model".to_string()));
        assert!(claude
            .env
            .iter()
            .any(|(key, value)| key == "MAX_THINKING_TOKENS" && value == "16384"));

        let mut codex = plan_input(&task_id);
        codex.plan_hash = "sha256:plan-codex".into();
        codex.selected_cli = "codex".into();
        let codex_plan = create_plan(&conn, &codex).unwrap();
        let invocation = build_cli_invocation(&codex_plan, "do work").unwrap();
        assert_eq!(invocation.program, "codex");
        assert!(invocation.args.iter().any(|arg| arg.contains("model_reasoning_effort")));

        let mut unknown = plan_input(&task_id);
        unknown.plan_hash = "sha256:plan-unknown".into();
        unknown.selected_cli = "unknown-cli".into();
        let unknown_plan = create_plan(&conn, &unknown).unwrap();
        assert!(build_cli_invocation(&unknown_plan, "x").unwrap_err().contains("不支持"));
        assert!(build_cli_invocation(&plan, "   ").unwrap_err().contains("prompt"));
    }

    fn manual_plan() -> PlanView {
        PlanView {
            id: "plan-manual".into(),
            project_id: "p1".into(),
            task_id: "task-manual".into(),
            phase: "implement".into(),
            plan_hash: "sha256:manual".into(),
            hash_rule_version: "v1".into(),
            requirement_hash: "h".into(),
            design_hash: "d".into(),
            ac_hash: "a".into(),
            authorization_ref: None,
            selected_cli: "claude".into(),
            model_ref: "model-x".into(),
            effort: Some("high".into()),
            permission_policy_hash: "p".into(),
            capability_manifest_hash: "c".into(),
            created_at: 0,
        }
    }

    #[cfg(windows)]
    #[test]
    fn cli_adapter_runs_in_worktree_and_cleans_up() {
        let base = std::env::temp_dir().join(format!("cli-test-{}", uuid::Uuid::new_v4().simple()));
        let repo = base.join("repo");
        let worktrees = base.join("worktrees");
        init_git_repo(&repo);
        let script = base.join("fake-cli.cmd");
        std::fs::write(&script, "@echo off\r\nexit /b 0\r\n").unwrap();

        let result = run_task_cli_dryrun(
            &repo,
            &worktrees,
            "task-cli",
            manual_plan(),
            "do work",
            Some(script.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(result.outcome, AdapterOutcome::Succeeded);
        assert!(!std::path::Path::new(&result.worktree).exists(), "运行后应清理 worktree");
        let _ = std::fs::remove_dir_all(&base);
    }
}