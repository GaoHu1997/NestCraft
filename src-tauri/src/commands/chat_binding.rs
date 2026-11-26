//! CR-037 / STORY-032 AC-05/06：普通会话的原生线程持久绑定。
//!
//! 职责（LLD-CR037 §5.1/§5.2、DB-FEAT-001「CR-037 普通会话的持久绑定」）：
//! - spawn 前 `resolve_binding`：按绑定快照与当前环境决定 create/resume/fresh/blocked；
//!   `fresh` 只在 `confirm_fresh` 写过 `fresh-…` 标记后成立——普通轮次结算的 `turn-…`
//!   不算重建确认，避免第二轮在引用丢失时静默换新上下文（CR-068 J11）；
//! - 兼容键：服务端规范键 = cli + cli 版本 + 运行模式（本适配器为 headless，权限模式为逐轮
//!   参数不影响线程存储，不计入）+ provider 身份指纹（协议+端点主机+providerId 的 sha256 前16）
//!   + 范围（project:<id> / server:<id> / global）；原引用永不进入键、前端或日志；
//! - 轮次判定 `judge_turn`：纯函数，仅凭流内证据（emittedRef/is_error/退出信号）判定，
//!   exit 0 不作为确认依据（claude API 403 时 exit=0 且 result.is_error=true）；
//! - CAS 结算 `settle_turn`：单事务内写 execution_session_turn + 条件 UPDATE session；
//!   条件含 sessionRole='ordinary'（执行会话门控）与 nativeBindingRevision=expected；
//!   rows_affected=0 → 只归档（LATE），不覆盖绑定；首轮写入附加 nativeThreadRef IS NULL；
//! - fresh 确认 `confirm_fresh`：用户确认后才清空旧引用并写 system 断点消息；
//! - 原因码 → 中文文案 `reason_text`（横幅/弹窗/断点卡共用，跨重启一致）；
//! - BUG-003：派生视图按 `runner` 分流——平台通道不适用 CLI 原生绑定（返回 None）；
//!   CLI 无任何 turn 记录时用 `REF_NOT_ESTABLISHED` 与「已结算未落引用」区分。

use crate::db;
use crate::models::{new_id, now_ms, SessionBindingView};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

pub const REASON_CODES: [&str; 11] = [
    "REF_MISSING",
    "REF_NOT_ESTABLISHED",
    "REF_STALE",
    "REF_NOT_READY",
    "INCOMPATIBLE_CLI",
    "INCOMPATIBLE_STORE",
    "GRANT_REVOKED",
    "STOPPED",
    "LATE",
    "ADAPTER_REFUSED",
    "UNSUPPORTED_CLI",
];

/// claude/codex 具备原生续接通道；grok 的 `--print --json` 通道无线程概念（本轮登记不支持）。
pub fn cli_supported(cli_id: &str) -> bool {
    matches!(cli_id, "claude" | "codex")
}

/// 用户显式「重建上下文」确认的标记前缀（`confirm_fresh` 用 `new_id("fresh")` 写入）。
///
/// CR-068 J11：普通轮次结算写入的是 `turn-…`，不能当成「已确认 fresh」。否则一旦旧引用丢失
/// （历史缺绑定、引用被清理等），第二轮就会**静默**换新上下文。只有 `fresh-…` 才允许按
/// fresh 发送；其余情况必须回到 FreshPending，由用户显式确认后才开始新上下文。
const FRESH_CONFIRM_PREFIX: &str = "fresh-";

fn explicit_fresh_confirmed(confirmed_turn_id: Option<&str>) -> bool {
    confirmed_turn_id
        .map(|value| value.starts_with(FRESH_CONFIRM_PREFIX))
        .unwrap_or(false)
}

pub fn reason_text(code: &str) -> &'static str {
    match code {
        "REF_MISSING" => "引用缺失（历史无原生绑定）",
        "REF_NOT_ESTABLISHED" => "尚无原生线程引用（首轮未完成或历史来自旧版本）",
        "REF_STALE" => "原线程引用已过期",
        "REF_NOT_READY" => "引用尚未就绪，请重试",
        "INCOMPATIBLE_CLI" => "CLI 或版本不兼容",
        "INCOMPATIBLE_STORE" => "后端实例或存储位置不兼容",
        "GRANT_REVOKED" => "知识授权已变化或撤销",
        "STOPPED" => "本轮已停止",
        "LATE" => "本轮结果迟到",
        "ADAPTER_REFUSED" => "适配器未确认回到同一线程",
        "UNSUPPORTED_CLI" => "当前 CLI 不支持原生续接",
        _ => "原因未知",
    }
}

/// 引用脱敏指纹：sha256 前 16 位十六进制。审计与前端只允许出现指纹。
pub fn fingerprint_ref(reference: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(reference.as_bytes());
    let out = hasher.finalize();
    out.iter().map(|b| format!("{:02x}", b)).collect::<String>()[..16].to_string()
}

/// provider 身份指纹：协议 + 端点主机 + providerId。
pub fn provider_fingerprint(protocol: &str, base_host: &str, provider_id: &str) -> String {
    fingerprint_ref(&format!("provider\x1f{}\x1f{}\x1f{}", protocol, base_host, provider_id))
}

/// 服务端规范兼容键（可读组件；provider 为指纹）。
pub fn compatibility_key(
    cli_id: &str,
    cli_version: &str,
    mode: &str,
    provider_fp: &str,
    scope: &str,
) -> String {
    format!("v1|cli={}|cliVersion={}|mode={}|provider={}|scope={}", cli_id, cli_version, mode, provider_fp, scope)
}

/// 与存储的兼容键对比失配时定位不兼容面（cli/版本/模式 vs provider/范围）。
pub fn incompatibility_reason(stored: &str, current: &str) -> &'static str {
    let pick = |key: &str, value: &str| -> Option<String> {
        value.split('|').find(|p| p.starts_with(key)).map(|p| p.to_string())
    };
    for key in ["cli=", "cliVersion=", "mode="] {
        if pick(key, stored) != pick(key, current) {
            return "INCOMPATIBLE_CLI";
        }
    }
    "INCOMPATIBLE_STORE"
}

/// 当前项目授权修订快照：项目全部授权行 revision 之和；任何授权变化都会失配。
pub fn grant_revision_snapshot(conn: &rusqlite::Connection, project_id: Option<&str>) -> Result<i64, String> {
    let Some(pid) = project_id else { return Ok(0) };
    conn.query_row(
        "SELECT COALESCE(SUM(revision),0) FROM project_library_grant WHERE projectId=?1",
        [pid],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone)]
pub struct BindingSnapshot {
    pub thread_ref: Option<String>,
    pub compat_key: Option<String>,
    pub grant_revision: Option<i64>,
    pub binding_revision: i64,
    pub confirmed_turn_id: Option<String>,
}

pub fn load_binding(conn: &rusqlite::Connection, session_id: &str) -> Result<BindingSnapshot, String> {
    let row = conn
        .query_row(
            "SELECT nativeThreadRef, nativeCompatibilityKey, nativeGrantRevision, nativeBindingRevision, nativeConfirmedTurnId
             FROM session WHERE id=?1 AND sessionRole='ordinary'",
            [session_id],
            |r| {
                Ok(BindingSnapshot {
                    thread_ref: r.get(0)?,
                    compat_key: r.get(1)?,
                    grant_revision: r.get(2)?,
                    binding_revision: r.get(3)?,
                    confirmed_turn_id: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // 执行会话/不存在的会话返回空快照；写入侧仍有 sessionRole 门控。
    Ok(row.unwrap_or(BindingSnapshot {
        thread_ref: None,
        compat_key: None,
        grant_revision: None,
        binding_revision: 0,
        confirmed_turn_id: None,
    }))
}

/// spawn 前的绑定决定。
#[derive(Debug)]
pub enum BindingDecision {
    /// 直接发送；requested=Some 时携带 resume 引用（仅后端内存，不进前端/日志）。
    Send { mode: &'static str, requested: Option<String> },
    /// 有历史但无法续接且用户未显式确认重建：拒绝发送，前端弹确认（CR-068：普通轮次不算确认）。
    FreshPending { reason: &'static str },
    /// 明确阻塞（兼容键失配 / 撤权）：拒绝发送，保留草稿与历史。
    Blocked { reason: &'static str },
}

pub fn resolve_binding(
    snapshot: &BindingSnapshot,
    cli_id: &str,
    current_compat_key: &str,
    current_grant_revision: i64,
    has_history: bool,
    create_failed: bool,
) -> BindingDecision {
    // 支持续接的 CLI 且已有确认过的原生引用 → resume。
    if let Some(reference) = snapshot.thread_ref.as_deref() {
        if !cli_supported(cli_id) {
            return BindingDecision::Blocked { reason: "UNSUPPORTED_CLI" };
        }
        if let Some(stored) = snapshot.compat_key.as_deref() {
            if stored != current_compat_key {
                return BindingDecision::Blocked { reason: incompatibility_reason(stored, current_compat_key) };
            }
        }
        if let Some(stored) = snapshot.grant_revision {
            if stored != current_grant_revision || current_grant_revision < 0 {
                // 授权快照失配：存在撤权或授权变化时不把旧历史送回 CLI。
                return BindingDecision::Blocked { reason: "GRANT_REVOKED" };
            }
        }
        return BindingDecision::Send { mode: "resume", requested: Some(reference.to_string()) };
    }
    // 无引用：CLI 不支持（grok）→ 有历史须确认 fresh，首轮直接 create。
    if !cli_supported(cli_id) {
        if has_history {
            if explicit_fresh_confirmed(snapshot.confirmed_turn_id.as_deref()) {
                return BindingDecision::Send { mode: "fresh", requested: None };
            }
            // BUG-004：首轮 create 已确定失败（无任何模型输出）时允许直接重发，不要求确认重建。
            if create_failed {
                return BindingDecision::Send { mode: "create", requested: None };
            }
            return BindingDecision::FreshPending { reason: "UNSUPPORTED_CLI" };
        }
        return BindingDecision::Send { mode: "create", requested: None };
    }
    // 支持续接的 CLI 但无引用：有历史且**用户显式确认重建** → fresh；否则 freshPending。
    // CR-068 J11：普通轮次结算的 confirmed_turn_id 不能当作重建确认，避免静默 fresh。
    if has_history {
        if explicit_fresh_confirmed(snapshot.confirmed_turn_id.as_deref()) {
            return BindingDecision::Send { mode: "fresh", requested: None };
        }
        // BUG-004：最新轮为 CREATE_FAILED 说明上次首轮未建立任何上下文，可直接重试 create。
        if create_failed {
            return BindingDecision::Send { mode: "create", requested: None };
        }
        return BindingDecision::FreshPending { reason: "REF_MISSING" };
    }
    BindingDecision::Send { mode: "create", requested: None }
}

/// 流结束后的轮次判定（纯函数；只信流内证据与退出信号，不信 exit 0）。
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// 适配器确认回到同一原生线程。
    ConfirmedResume { reference: String },
    /// 新线程确认建立（create/fresh 首轮，或静默换线后的新线程）。
    ConfirmedCreate { reference: String },
    /// 请求 resume 但引擎返回了新线程（如 codex 静默新建）：绑定新线程并写断点消息。
    FreshContext { reference: String },
    /// 绑定保持不变，用户须确认重建（emitted≠requested、resume 遇 is_error 等）。
    Blocked { reason: &'static str },
    /// 只归档不改绑定（停止/超时/进程失败/is_error 首轮）。
    Archived { reason: &'static str },
}

/// resume 失败的原生报错特征（claude / codex）。
pub fn stale_signal(stderr: &str) -> bool {
    stderr.contains("No conversation found with session ID") || stderr.contains("no rollout found for thread id")
}

pub fn judge_turn(
    requested: Option<&str>,
    emitted: Option<&str>,
    is_error: bool,
    exit_ok: bool,
    stderr: &str,
    first_confirmed_settled_at: Option<i64>,
) -> Verdict {
    if !exit_ok {
        if requested.is_some() && stale_signal(stderr) {
            // 首轮落定 3 秒内的 resume 失败视为竞态（引用尚未落盘），可重试。
            let recent = first_confirmed_settled_at
                .map(|t| now_ms() - t < 3000)
                .unwrap_or(false);
            return Verdict::Blocked { reason: if recent { "REF_NOT_READY" } else { "REF_STALE" } };
        }
        return Verdict::Archived { reason: "STOPPED" };
    }
    match (requested, emitted) {
        (Some(requested), Some(emitted)) => {
            if emitted == requested {
                if is_error {
                    Verdict::Blocked { reason: "ADAPTER_REFUSED" }
                } else {
                    Verdict::ConfirmedResume { reference: requested.to_string() }
                }
            } else if is_error {
                Verdict::Blocked { reason: "ADAPTER_REFUSED" }
            } else {
                // 静默换线：不得记为已续接；绑定新线程并写断点消息。
                Verdict::FreshContext { reference: emitted.to_string() }
            }
        }
        (Some(_), None) => Verdict::Blocked { reason: "ADAPTER_REFUSED" },
        (None, Some(emitted)) => {
            if is_error {
                Verdict::Archived { reason: "ADAPTER_REFUSED" }
            } else {
                Verdict::ConfirmedCreate { reference: emitted.to_string() }
            }
        }
        (None, None) => Verdict::Archived { reason: "ADAPTER_REFUSED" },
    }
}

/// CAS 结算计划（confirmed create 需要写入当前兼容键）。
#[derive(Debug)]
pub struct SettlePlan {
    pub turn_id: String,
    pub mode: &'static str,
    pub expected_binding_revision: i64,
    pub grant_revision: i64,
    pub current_compat_key: Option<String>,
    pub verdict: Verdict,
}

#[derive(Debug)]
pub struct SettleResult {
    pub outcome: &'static str,
    pub native_resumed: bool,
    pub fresh_context: bool,
    pub reason_code: Option<&'static str>,
    pub ref_fingerprint: Option<String>,
}

fn insert_turn(
    tx: &rusqlite::Transaction,
    session_id: &str,
    plan: &SettlePlan,
    outcome: &str,
    reason: Option<&str>,
    fingerprint: Option<&str>,
) -> Result<(), String> {
    let turn_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(turnSeq),0)+1 FROM execution_session_turn WHERE sessionId=?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,reasonCode,refFingerprint,expectedBindingRevision,grantRevision,createdAt,settledAt)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
        rusqlite::params![
            plan.turn_id,
            session_id,
            turn_seq,
            plan.mode,
            outcome,
            reason,
            fingerprint,
            plan.expected_binding_revision,
            plan.grant_revision,
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 断点消息（role=system，metaJson.kind=context-breakpoint）：跨重启可见。
fn insert_breakpoint_message(
    tx: &rusqlite::Transaction,
    session_id: &str,
    title: &str,
    reason: &str,
    reason_code: Option<&str>,
) -> Result<(), String> {
    let content = format!(
        "{}：{}。此前的对话保留为历史，不再作为模型上下文。",
        title, reason
    );
    tx.execute(
        "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES (?1,?2,'system',?3,?4,?5)",
        rusqlite::params![
            new_id("msg"),
            session_id,
            content,
            serde_json::json!({ "kind": "context-breakpoint", "reasonCode": reason_code }).to_string(),
            now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 单事务结算：消息持久化由调用方在同一连接事务内先行完成（persist_and_settle）。
pub fn settle_turn(
    tx: &rusqlite::Transaction,
    session_id: &str,
    plan: &SettlePlan,
) -> Result<SettleResult, String> {
    match &plan.verdict {
        Verdict::Archived { reason } => {
            insert_turn(tx, session_id, plan, "archived", Some(reason), None)?;
            Ok(SettleResult {
                outcome: "archived",
                native_resumed: false,
                fresh_context: false,
                reason_code: Some(reason),
                ref_fingerprint: None,
            })
        }
        Verdict::Blocked { reason } => {
            insert_turn(tx, session_id, plan, "blocked", Some(reason), None)?;
            Ok(SettleResult {
                outcome: "blocked",
                native_resumed: false,
                fresh_context: false,
                reason_code: Some(reason),
                ref_fingerprint: None,
            })
        }
        Verdict::ConfirmedResume { reference } => {
            let fingerprint = fingerprint_ref(reference);
            insert_turn(tx, session_id, plan, "confirmed", None, Some(&fingerprint))?;
            let updated = tx
                .execute(
                    "UPDATE session SET nativeThreadRef=?2, nativeCompatibilityKey=COALESCE(nativeCompatibilityKey, nativeCompatibilityKey),
                     nativeGrantRevision=?3, nativeBindingRevision=nativeBindingRevision+1, nativeConfirmedTurnId=?4, updatedAt=?5
                     WHERE id=?1 AND sessionRole='ordinary' AND nativeBindingRevision=?6 AND nativeThreadRef=?2",
                    rusqlite::params![
                        session_id,
                        reference,
                        plan.grant_revision,
                        plan.turn_id,
                        now_ms(),
                        plan.expected_binding_revision
                    ],
                )
                .map_err(|e| e.to_string())?;
            if updated == 0 {
                tx.execute(
                    "UPDATE execution_session_turn SET outcome='archived', reasonCode='LATE', settledAt=?2 WHERE id=?1",
                    rusqlite::params![plan.turn_id, now_ms()],
                )
                .map_err(|e| e.to_string())?;
                return Ok(SettleResult {
                    outcome: "archived",
                    native_resumed: false,
                    fresh_context: false,
                    reason_code: Some("LATE"),
                    ref_fingerprint: Some(fingerprint),
                });
            }
            Ok(SettleResult {
                outcome: "confirmed",
                native_resumed: true,
                fresh_context: false,
                reason_code: None,
                ref_fingerprint: Some(fingerprint),
            })
        }
        Verdict::ConfirmedCreate { reference } => {
            let fingerprint = fingerprint_ref(reference);
            insert_turn(tx, session_id, plan, "confirmed", None, Some(&fingerprint))?;
            // 首轮写入：仅当当前无绑定时覆盖，防止竞态改写已有引用。
            let updated = tx
                .execute(
                    "UPDATE session SET nativeThreadRef=?2, nativeCompatibilityKey=?3, nativeGrantRevision=?4,
                     nativeBindingRevision=nativeBindingRevision+1, nativeConfirmedTurnId=?5, updatedAt=?6
                     WHERE id=?1 AND sessionRole='ordinary' AND nativeBindingRevision=?7 AND nativeThreadRef IS NULL",
                    rusqlite::params![
                        session_id,
                        reference,
                        plan.current_compat_key.clone().unwrap_or_default(),
                        plan.grant_revision,
                        plan.turn_id,
                        now_ms(),
                        plan.expected_binding_revision
                    ],
                )
                .map_err(|e| e.to_string())?;
            if updated == 0 {
                tx.execute(
                    "UPDATE execution_session_turn SET outcome='archived', reasonCode='LATE', settledAt=?2 WHERE id=?1",
                    rusqlite::params![plan.turn_id, now_ms()],
                )
                .map_err(|e| e.to_string())?;
                return Ok(SettleResult {
                    outcome: "archived",
                    native_resumed: false,
                    fresh_context: false,
                    reason_code: Some("LATE"),
                    ref_fingerprint: Some(fingerprint),
                });
            }
            Ok(SettleResult {
                outcome: "confirmed",
                native_resumed: false,
                fresh_context: false,
                reason_code: None,
                ref_fingerprint: Some(fingerprint),
            })
        }
        Verdict::FreshContext { reference } => {
            let fingerprint = fingerprint_ref(reference);
            insert_turn(tx, session_id, plan, "confirmed", None, Some(&fingerprint))?;
            let updated = tx
                .execute(
                    "UPDATE session SET nativeThreadRef=?2, nativeBindingRevision=nativeBindingRevision+1, nativeConfirmedTurnId=?3, updatedAt=?4
                     WHERE id=?1 AND sessionRole='ordinary' AND nativeBindingRevision=?5 AND nativeThreadRef IS NOT NULL",
                    rusqlite::params![
                        session_id,
                        reference,
                        plan.turn_id,
                        now_ms(),
                        plan.expected_binding_revision
                    ],
                )
                .map_err(|e| e.to_string())?;
            if updated == 0 {
                tx.execute(
                    "UPDATE execution_session_turn SET outcome='archived', reasonCode='LATE', settledAt=?2 WHERE id=?1",
                    rusqlite::params![plan.turn_id, now_ms()],
                )
                .map_err(|e| e.to_string())?;
                return Ok(SettleResult {
                    outcome: "archived",
                    native_resumed: false,
                    fresh_context: false,
                    reason_code: Some("LATE"),
                    ref_fingerprint: None,
                });
            }
            insert_breakpoint_message(
                tx,
                session_id,
                "上下文已重建",
                "CLI 返回了新线程，原引用未被确认续接",
                None,
            )?;
            Ok(SettleResult {
                outcome: "confirmed",
                native_resumed: false,
                fresh_context: true,
                reason_code: None,
                ref_fingerprint: Some(fingerprint),
            })
        }
    }
}

/// fresh 确认命令（AC-06）：用户在确认弹窗点击「重建并继续」后调用。
/// CAS 清空旧引用并写 system 断点消息；修订失配时拒绝（可能已有新轮完成）。
#[tauri::command]
pub fn chat_session_confirm_fresh(session_id: String, expected_binding_revision: i64, reason_code: Option<String>) -> Result<(), String> {
    confirm_fresh(&session_id, expected_binding_revision, reason_code.as_deref())
}

/// fresh 确认：CAS 清空旧引用并写 system 断点消息（用户显式确认后才可重建）。
pub fn confirm_fresh(
    session_id: &str,
    expected_binding_revision: i64,
    reason_code: Option<&str>,
) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let role: String = conn
        .query_row("SELECT sessionRole FROM session WHERE id=?1", [session_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("会话不存在")?;
    if role != "ordinary" {
        return Err("执行会话不参与侧栏原生绑定，无需重建确认".into());
    }
    // BUG-004：本轮仍在运行时不得清引用/改修订，否则本轮结算会变 LATE 并丢弃引用。
    if crate::commands::chat::chat_status(session_id.to_string()) {
        return Err("本轮仍在运行，无法重建上下文；请等待本轮结束或先停止发送".into());
    }
    if let Some(code) = reason_code {
        if !REASON_CODES.contains(&code) {
            return Err(format!("未知原因码：{}", code));
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let updated = tx
        .execute(
            "UPDATE session SET nativeThreadRef=NULL, nativeCompatibilityKey=NULL, nativeGrantRevision=NULL,
             nativeBindingRevision=nativeBindingRevision+1, nativeConfirmedTurnId=?2, updatedAt=?3
             WHERE id=?1 AND sessionRole='ordinary' AND nativeBindingRevision=?4",
            rusqlite::params![session_id, new_id("fresh"), now_ms(), expected_binding_revision],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err("绑定已变化（可能已有新的一轮完成），请刷新后重试".into());
    }
    let (title, reason) = match reason_code {
        Some("UNSUPPORTED_CLI") => ("原线程不可续接".to_string(), reason_text("UNSUPPORTED_CLI").to_string()),
        Some(code) => ("上下文已重建".to_string(), reason_text(code).to_string()),
        None => ("上下文已重建".to_string(), "引用缺失（历史无原生绑定）".to_string()),
    };
    insert_breakpoint_message(&tx, session_id, &title, &reason, reason_code)?;
    tx.commit().map_err(|e| e.to_string())
}

/// SessionMeta.binding 派生（不查库；最新轮次结果由查询列传入）。
///
/// BUG-003：`runner` 必须参与判定。平台通道（`platform`）按历史回放承载上下文，
/// 不产生 CLI 原生线程，也不写 `execution_session_turn`；若仍按「有消息且无引用」派生
/// 绑定状态，平台会话每轮都会被误判为 `freshPending` 并锁住输入。
pub fn derive_view(
    session_role: &str,
    runner: &str,
    running: bool,
    cli_id: &str,
    thread_ref: Option<&str>,
    binding_revision: i64,
    confirmed_turn_id: Option<&str>,
    last_outcome: Option<&str>,
    last_reason: Option<&str>,
    message_count: i64,
) -> Option<SessionBindingView> {
    if session_role != "ordinary" {
        return None;
    }
    // BUG-003：平台通道不适用 CLI 原生绑定，返回 None（前端据此不显示横幅、不锁输入）。
    if runner == "platform" {
        return None;
    }
    // BUG-004：本轮仍在运行时不派生绑定状态。此时 user 消息已落库但引用尚未结算，
    // 若按「有消息无引用」判定会把正常的长任务误报成待重建并锁住输入；运行结束后按真实结果恢复。
    if running {
        return None;
    }
    let view = |state: &str, reason: Option<&str>, fp: Option<String>| SessionBindingView {
        state: state.to_string(),
        reason_code: reason.map(|r| r.to_string()),
        ref_fingerprint: fp,
        expected_revision: binding_revision,
    };
    // blocked 只在旧引用仍存在（未决）时成立；confirm_fresh 清空引用后按 fresh 展示。
    if last_outcome == Some("blocked") && thread_ref.is_some() {
        return Some(view("blocked", last_reason, thread_ref.map(fingerprint_ref)));
    }
    if let Some(reference) = thread_ref {
        return Some(view("native", None, Some(fingerprint_ref(reference))));
    }
    // CR-068 J11/J12：只有用户显式确认过重建才派生 fresh（无需处理、不显示常驻标签）；
    // 普通轮次的 confirmed_turn_id 说明有历史但没有可用引用，仍按待确认暴露原因与出路。
    if explicit_fresh_confirmed(confirmed_turn_id) {
        return Some(view("fresh", None, None));
    }
    // BUG-004：首轮 create 已明确失败且没有任何模型输出（failure_turn 写入 CREATE_FAILED），
    // 属于「确定未建立上下文」：允许直接重发 create，不要求用户确认重建。
    if last_reason == Some("CREATE_FAILED") {
        return None;
    }
    if message_count > 0 {
        // 不支持续接的 CLI（grok）无引用可谈：原因按 UNSUPPORTED_CLI 展示。
        // BUG-003：CLI 完全没有 turn 记录说明首轮在结算前中断（或历史来自 CR-037 之前），
        // 与「已结算但未落引用」区分，避免用户被误导成引用丢失。
        let reason = if !cli_supported(cli_id) {
            "UNSUPPORTED_CLI"
        } else if last_outcome.is_none() {
            "REF_NOT_ESTABLISHED"
        } else {
            "REF_MISSING"
        };
        return Some(view("freshPending", Some(reason), None));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::now_ms;

    fn snapshot() -> BindingSnapshot {
        BindingSnapshot { thread_ref: None, compat_key: None, grant_revision: None, binding_revision: 0, confirmed_turn_id: None }
    }

    // ---------- 判定：只信流内证据，exit 0 不可单独作为确认 ----------

    #[test]
    fn resume_confirm_requires_emitted_match_and_no_error() {
        let v = judge_turn(Some("t1"), Some("t1"), false, true, "", None);
        assert_eq!(v, Verdict::ConfirmedResume { reference: "t1".into() });
        // emitted != requested：不得记 resumed
        let v = judge_turn(Some("t1"), Some("t2"), false, true, "", None);
        assert_eq!(v, Verdict::FreshContext { reference: "t2".into() });
        // 无 emitted：ADAPTER_REFUSED
        let v = judge_turn(Some("t1"), None, false, true, "", None);
        assert_eq!(v, Verdict::Blocked { reason: "ADAPTER_REFUSED" });
        // is_error：exit 0 也不确认（API 403 场景）
        let v = judge_turn(Some("t1"), Some("t1"), true, true, "", None);
        assert_eq!(v, Verdict::Blocked { reason: "ADAPTER_REFUSED" });
        // 进程失败 + 原生报错 → REF_STALE
        let v = judge_turn(Some("t1"), None, false, false, "No conversation found with session ID: t1", None);
        assert_eq!(v, Verdict::Blocked { reason: "REF_STALE" });
        // 距首轮落定 <3s → REF_NOT_READY
        let v = judge_turn(Some("t1"), None, false, false, "No conversation found with session ID: t1", Some(now_ms() - 500));
        assert_eq!(v, Verdict::Blocked { reason: "REF_NOT_READY" });
        // codex 的 no rollout 特征同样识别
        let v = judge_turn(Some("t1"), None, false, false, "ERROR: no rollout found for thread id t1", None);
        assert_eq!(v, Verdict::Blocked { reason: "REF_STALE" });
        // 其他进程失败/超时 → 归档
        let v = judge_turn(Some("t1"), None, false, false, "unrelated", None);
        assert_eq!(v, Verdict::Archived { reason: "STOPPED" });
    }

    #[test]
    fn create_mode_confirms_only_with_emitted_and_no_error() {
        let v = judge_turn(None, Some("new-thread"), false, true, "", None);
        assert_eq!(v, Verdict::ConfirmedCreate { reference: "new-thread".into() });
        let v = judge_turn(None, None, false, true, "", None);
        assert_eq!(v, Verdict::Archived { reason: "ADAPTER_REFUSED" });
        let v = judge_turn(None, Some("x"), true, true, "", None);
        assert_eq!(v, Verdict::Archived { reason: "ADAPTER_REFUSED" });
    }

    // ---------- 解析：grok / freshPending / 兼容键与撤权 ----------

    #[test]
    fn only_explicit_fresh_marker_allows_silent_fresh() {
        // CR-068 J11：普通结算轮（turn-…）与空值都不得被当成“已确认重建”，否则会静默 fresh。
        assert!(!explicit_fresh_confirmed(None));
        assert!(!explicit_fresh_confirmed(Some("turn-abc")));
        assert!(!explicit_fresh_confirmed(Some("fresh")));
        assert!(explicit_fresh_confirmed(Some("fresh-1")));
    }

    #[test]
    fn grok_first_round_creates_then_requires_confirmation() {
        let mut snap = snapshot();
        assert!(matches!(resolve_binding(&snap, "grok", "k", 0, false, false), BindingDecision::Send { mode: "create", requested: None }));
        // 有历史且未确认 → freshPending（直接 IPC 会被拒，前端弹确认）
        assert!(matches!(resolve_binding(&snap, "grok", "k", 0, true, false), BindingDecision::FreshPending { reason: "UNSUPPORTED_CLI" }));
        // CR-068 J11：普通结算轮（turn-…）不是重建确认，不能静默 fresh。
        snap.confirmed_turn_id = Some("turn-2b0f".into());
        assert!(matches!(resolve_binding(&snap, "grok", "k", 0, true, false), BindingDecision::FreshPending { reason: "UNSUPPORTED_CLI" }));
        snap.confirmed_turn_id = Some("fresh-1".into());
        assert!(matches!(resolve_binding(&snap, "grok", "k", 0, true, false), BindingDecision::Send { mode: "fresh", requested: None }));
    }

    #[test]
    fn claude_resume_requires_compat_and_grant_match() {
        let key = compatibility_key("claude", "2.1.318", "headless", "abc123", "project:p1");
        let mut snap = snapshot();
        snap.thread_ref = Some("t-1".into());
        snap.compat_key = Some(key.clone());
        snap.grant_revision = Some(3);
        snap.binding_revision = 2;
        match resolve_binding(&snap, "claude", &key, 3, true, false) {
            BindingDecision::Send { mode: "resume", requested } => assert_eq!(requested.as_deref(), Some("t-1")),
            other => panic!("期望 resume，实际 {:?}", other),
        }
        // 版本变化 → INCOMPATIBLE_CLI
        let key2 = compatibility_key("claude", "2.2.0", "headless", "abc123", "project:p1");
        assert!(matches!(resolve_binding(&snap, "claude", &key2, 3, true, false), BindingDecision::Blocked { reason: "INCOMPATIBLE_CLI" }));
        // provider 变化 → INCOMPATIBLE_STORE
        let key3 = compatibility_key("claude", "2.1.318", "headless", "ffff00", "project:p1");
        assert!(matches!(resolve_binding(&snap, "claude", &key3, 3, true, false), BindingDecision::Blocked { reason: "INCOMPATIBLE_STORE" }));
        // 授权变化 → GRANT_REVOKED
        assert!(matches!(resolve_binding(&snap, "claude", &key, 4, true, false), BindingDecision::Blocked { reason: "GRANT_REVOKED" }));
        // 快照口径：撤权/授权均使 revision 递增（撤权保留历史行）；快照与当前一致时不阻塞。
        assert!(matches!(resolve_binding(&snap, "claude", &key, 3, true, false), BindingDecision::Send { .. }));
    }

    #[test]
    fn supported_cli_without_ref_asks_fresh_when_history_exists() {
        let snap = snapshot();
        assert!(matches!(resolve_binding(&snap, "claude", "k", 0, false, false), BindingDecision::Send { mode: "create", requested: None }));
        assert!(matches!(resolve_binding(&snap, "claude", "k", 0, true, false), BindingDecision::FreshPending { reason: "REF_MISSING" }));
        // CR-068 J11：已结算的普通轮（turn-…）不代表用户确认重建，第二轮不得静默 fresh。
        let mut settled = snapshot();
        settled.confirmed_turn_id = Some("turn-7c1a".into());
        settled.binding_revision = 2;
        assert!(matches!(resolve_binding(&settled, "claude", "k", 0, true, false), BindingDecision::FreshPending { reason: "REF_MISSING" }));
        // 只有 confirm_fresh 写入的 fresh-… 标记才允许以 fresh 发送。
        let mut confirmed = snapshot();
        confirmed.confirmed_turn_id = Some("fresh-9".into());
        confirmed.binding_revision = 3;
        assert!(matches!(resolve_binding(&confirmed, "claude", "k", 0, true, false), BindingDecision::Send { mode: "fresh", requested: None }));
    }

    // ---------- BUG-003：派生视图按通道与首轮结算区分 ----------

    #[test]
    fn bug003_platform_sessions_never_derive_cli_binding() {
        // 平台会话有历史、无 CLI 引用：不得派生任何绑定状态（否则首轮后即被锁输入）。
        assert!(derive_view("ordinary", "platform", false, "codex", None, 0, None, None, None, 10).is_none());
        // 防御：即使残留引用（通道切换已被禁止），平台仍按不适用处理。
        assert!(derive_view("ordinary", "platform", false, "claude", Some("t-1"), 1, Some("turn-1"), Some("confirmed"), None, 10).is_none());
    }

    #[test]
    fn bug003_cli_without_settled_turn_reports_not_established() {
        let view = derive_view("ordinary", "cli", false, "codex", None, 0, None, None, None, 10).expect("应派生待确认");
        assert_eq!(view.state, "freshPending");
        assert_eq!(view.reason_code.as_deref(), Some("REF_NOT_ESTABLISHED"));
    }

    #[test]
    fn bug003_cli_settled_without_ref_keeps_ref_missing() {
        let view = derive_view("ordinary", "cli", false, "codex", None, 1, Some("turn-1"), Some("archived"), Some("STOPPED"), 10)
            .expect("应派生待确认");
        assert_eq!(view.state, "freshPending");
        assert_eq!(view.reason_code.as_deref(), Some("REF_MISSING"));
    }

    #[test]
    fn bug003_unsupported_cli_reason_unchanged() {
        let view = derive_view("ordinary", "cli", false, "grok", None, 0, None, None, None, 3).expect("应派生待确认");
        assert_eq!(view.state, "freshPending");
        assert_eq!(view.reason_code.as_deref(), Some("UNSUPPORTED_CLI"));
    }

    // ---------- BUG-004：运行中不派生、首轮失败可重发 ----------

    #[test]
    fn bug004_running_session_derives_no_binding() {
        // 本轮运行中：user 消息已落库、无引用、无 turn，也不得判成待重建。
        assert!(derive_view("ordinary", "cli", true, "codex", None, 0, None, None, None, 1).is_none());
        // 运行结束且无结算证据时，仍按 BUG-003 规则要求确认。
        let view = derive_view("ordinary", "cli", false, "codex", None, 0, None, None, None, 1).expect("应派生待确认");
        assert_eq!(view.reason_code.as_deref(), Some("REF_NOT_ESTABLISHED"));
    }

    #[test]
    fn bug004_create_failed_evidence_allows_direct_retry() {
        // 最新轮 CREATE_FAILED：确定未建立上下文，不再要求确认重建。
        assert!(derive_view("ordinary", "cli", false, "codex", None, 0, None, Some("archived"), Some("CREATE_FAILED"), 1).is_none());
        // 其他归档原因（如用户停止）仍要求确认，不静默 fresh。
        let view = derive_view("ordinary", "cli", false, "codex", None, 0, None, Some("archived"), Some("STOPPED"), 1)
            .expect("应派生待确认");
        assert_eq!(view.reason_code.as_deref(), Some("REF_MISSING"));
        // 发送前解析：create_failed 放行 create，其余仍 FreshPending。
        let snap = snapshot();
        assert!(matches!(resolve_binding(&snap, "codex", "k", 0, true, true), BindingDecision::Send { mode: "create", requested: None }));
        assert!(matches!(resolve_binding(&snap, "codex", "k", 0, true, false), BindingDecision::FreshPending { reason: "REF_MISSING" }));
        // grok 同样适用首轮失败重试（无原生续接，但仍可重新 create）。
        assert!(matches!(resolve_binding(&snap, "grok", "k", 0, true, true), BindingDecision::Send { mode: "create", requested: None }));
    }

    #[test]
    fn bug003_native_fresh_blocked_and_executor_unchanged() {
        let native = derive_view("ordinary", "cli", false, "claude", Some("t-1"), 2, Some("turn-1"), Some("confirmed"), None, 5)
            .expect("native");
        assert_eq!(native.state, "native");
        let fresh = derive_view("ordinary", "cli", false, "claude", None, 3, Some("fresh-1"), None, None, 5).expect("fresh");
        assert_eq!(fresh.state, "fresh");
        let blocked = derive_view("ordinary", "cli", false, "claude", Some("t-1"), 2, Some("turn-1"), Some("blocked"), Some("GRANT_REVOKED"), 5)
            .expect("blocked");
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.reason_code.as_deref(), Some("GRANT_REVOKED"));
        assert!(derive_view("executor", "cli", false, "codex", None, 0, None, None, None, 2).is_none());
    }

    // ---------- CAS：失配只归档不覆盖；首轮附加 NULL 条件；executor 门控 ----------

    fn fixture() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '新会话', cliId TEXT, providerId TEXT,
                modelId TEXT, effort TEXT, draft TEXT NOT NULL DEFAULT '',
                unread TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
                sessionRole TEXT NOT NULL DEFAULT 'ordinary',
                nativeThreadRef TEXT, nativeCompatibilityKey TEXT, nativeGrantRevision INTEGER,
                nativeBindingRevision INTEGER NOT NULL DEFAULT 0, nativeConfirmedTurnId TEXT);
             CREATE TABLE execution_session_turn (
                id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                turnSeq INTEGER NOT NULL, mode TEXT NOT NULL, outcome TEXT NOT NULL,
                reasonCode TEXT, refFingerprint TEXT, expectedBindingRevision INTEGER,
                grantRevision INTEGER, createdAt INTEGER NOT NULL, settledAt INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, sessionId TEXT, role TEXT, content TEXT, metaJson TEXT, refsJson TEXT, gitContextJson TEXT, createdAt INTEGER);
             INSERT INTO session (id, projectId, title, draft, createdAt, updatedAt) VALUES ('s1','p1','普通','0',1,1);
             INSERT INTO session (id, projectId, title, draft, createdAt, updatedAt, sessionRole) VALUES ('ex1','p1','执行','0',1,1,'executor');",
        )
        .unwrap();
        conn
    }

    fn plan(turn: &str, expected: i64, verdict: Verdict) -> SettlePlan {
        SettlePlan {
            turn_id: turn.to_string(),
            mode: "resume",
            expected_binding_revision: expected,
            grant_revision: 0,
            current_compat_key: Some("k".into()),
            verdict,
        }
    }

    #[test]
    fn confirmed_create_is_gated_by_first_round_null_condition() {
        let conn = fixture();
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "s1", &plan("t1", 0, Verdict::ConfirmedCreate { reference: "ref-1".into() })).unwrap();
        assert_eq!(r.outcome, "confirmed");
        tx.commit().unwrap();
        let (ref_, rev): (Option<String>, i64) = conn.query_row("SELECT nativeThreadRef, nativeBindingRevision FROM session WHERE id='s1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(ref_.as_deref(), Some("ref-1"));
        assert_eq!(rev, 1);
        // 第二个 create 不得覆盖已有引用（CAS 0 行 → 归档）
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "s1", &plan("t2", 1, Verdict::ConfirmedCreate { reference: "ref-2".into() })).unwrap();
        assert_eq!(r.outcome, "archived");
        assert_eq!(r.reason_code, Some("LATE"));
        tx.commit().unwrap();
        let ref_: String = conn.query_row("SELECT nativeThreadRef FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(ref_, "ref-1");
        let outcome: String = conn.query_row("SELECT outcome FROM execution_session_turn WHERE id='t2'", [], |r| r.get(0)).unwrap();
        assert_eq!(outcome, "archived");
    }

    #[test]
    fn confirmed_resume_requires_expected_revision_and_same_ref() {
        let conn = fixture();
        conn.execute("UPDATE session SET nativeThreadRef='old', nativeBindingRevision=3 WHERE id='s1'", []).unwrap();
        // revision 失配 → 归档，不覆盖
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "s1", &plan("t1", 1, Verdict::ConfirmedResume { reference: "old".into() })).unwrap();
        assert_eq!(r.outcome, "archived");
        tx.commit().unwrap();
        // revision 与引用都匹配 → 确认并递增
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "s1", &plan("t2", 3, Verdict::ConfirmedResume { reference: "old".into() })).unwrap();
        assert!(r.native_resumed);
        tx.commit().unwrap();
        let rev: i64 = conn.query_row("SELECT nativeBindingRevision FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(rev, 4);
        let confirmed: String = conn.query_row("SELECT nativeConfirmedTurnId FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(confirmed, "t2");
    }

    #[test]
    fn executor_sessions_never_receive_binding_writes() {
        let conn = fixture();
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "ex1", &plan("t1", 0, Verdict::ConfirmedCreate { reference: "ref-x".into() })).unwrap();
        tx.commit().unwrap();
        // sessionRole 门控：UPDATE 影响 0 行 → 归档，绑定列保持空
        assert_eq!(r.outcome, "archived");
        let ref_: Option<String> = conn.query_row("SELECT nativeThreadRef FROM session WHERE id='ex1'", [], |r| r.get(0)).unwrap();
        assert_eq!(ref_, None);
        // blocked / archived 照常登记（无 session 更新）
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "ex1", &plan("t2", 0, Verdict::Blocked { reason: "REF_STALE" })).unwrap();
        tx.commit().unwrap();
        assert_eq!(r.outcome, "blocked");
    }

    #[test]
    fn fresh_context_binds_new_ref_and_writes_breakpoint_message() {
        let conn = fixture();
        conn.execute("UPDATE session SET nativeThreadRef='old', nativeBindingRevision=1 WHERE id='s1'", []).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let r = settle_turn(&tx, "s1", &plan("t1", 1, Verdict::FreshContext { reference: "new-1".into() })).unwrap();
        assert!(r.fresh_context);
        tx.commit().unwrap();
        let ref_: String = conn.query_row("SELECT nativeThreadRef FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(ref_, "new-1");
        let (role, meta, content): (String, String, String) = conn.query_row(
            "SELECT role, metaJson, content FROM message WHERE sessionId='s1' AND role='system'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(role, "system");
        assert!(meta.contains("context-breakpoint"));
        assert!(content.contains("上下文已重建"));
    }

    #[test]
    fn blocked_and_archived_never_touch_session_binding() {
        let conn = fixture();
        conn.execute("UPDATE session SET nativeThreadRef='keep', nativeBindingRevision=2 WHERE id='s1'", []).unwrap();
        for (tid, verdict) in [
            ("t1", Verdict::Blocked { reason: "REF_STALE" }),
            ("t2", Verdict::Archived { reason: "STOPPED" }),
        ] {
            let tx = conn.unchecked_transaction().unwrap();
            let r = settle_turn(&tx, "s1", &plan(tid, 2, verdict)).unwrap();
            tx.commit().unwrap();
            assert!(r.outcome == "blocked" || r.outcome == "archived");
        }
        let (ref_, rev): (String, i64) = conn.query_row("SELECT nativeThreadRef, nativeBindingRevision FROM session WHERE id='s1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((ref_.as_str(), rev), ("keep", 2));
    }

    // ---------- 派生视图与指纹 ----------

    #[test]
    fn derived_view_follows_state_priority() {
        assert!(derive_view("executor", "cli", false, "claude", Some("r"), 1, None, None, None, 5).is_none());
        let v = derive_view("ordinary", "cli", false, "claude", Some("r"), 1, None, Some("blocked"), Some("REF_STALE"), 5).unwrap();
        assert_eq!((v.state.as_str(), v.reason_code.as_deref()), ("blocked", Some("REF_STALE")));
        assert_eq!(v.ref_fingerprint.as_deref(), Some(fingerprint_ref("r").as_str()));
        let v = derive_view("ordinary", "cli", false, "claude", Some("r"), 1, None, Some("confirmed"), None, 5).unwrap();
        assert_eq!(v.state, "native");
        let v = derive_view("ordinary", "cli", false, "claude", None, 2, Some("fresh-9"), Some("confirmed"), None, 5).unwrap();
        assert_eq!(v.state, "fresh");
        // 普通结算轮的 turn-… 不是重建确认：引用缺失仍按待确认暴露原因（CR-068 J11/J12）。
        let v = derive_view("ordinary", "cli", false, "claude", None, 2, Some("turn-9"), Some("confirmed"), None, 5).unwrap();
        assert_eq!((v.state.as_str(), v.reason_code.as_deref()), ("freshPending", Some("REF_MISSING")));
        // BUG-003：完全没有 turn 记录 → 首轮未完成，原因与「已结算未落引用」区分。
        let v = derive_view("ordinary", "cli", false, "claude", None, 0, None, None, None, 3).unwrap();
        assert_eq!((v.state.as_str(), v.reason_code.as_deref()), ("freshPending", Some("REF_NOT_ESTABLISHED")));
        // grok：freshPending 原因按 UNSUPPORTED_CLI 展示
        let v = derive_view("ordinary", "cli", false, "grok", None, 0, None, None, None, 3).unwrap();
        assert_eq!((v.state.as_str(), v.reason_code.as_deref()), ("freshPending", Some("UNSUPPORTED_CLI")));
        assert!(derive_view("ordinary", "cli", false, "claude", None, 0, None, None, None, 0).is_none());
    }

    #[test]
    fn fingerprints_are_stable_and_masked() {
        let a = fingerprint_ref("session-abc");
        assert_eq!(a.len(), 16);
        assert_eq!(a, fingerprint_ref("session-abc"));
        assert_ne!(a, fingerprint_ref("session-abd"));
        // 原引用不出现在指纹中
        assert!(!a.contains("session"));
        assert_eq!(incompatibility_reason("v1|cli=claude|cliVersion=1|mode=headless|provider=x|scope=p", "v1|cli=codex|cliVersion=1|mode=headless|provider=x|scope=p"), "INCOMPATIBLE_CLI");
        assert_eq!(incompatibility_reason("v1|cli=claude|cliVersion=1|mode=headless|provider=x|scope=p", "v1|cli=claude|cliVersion=1|mode=headless|provider=y|scope=p"), "INCOMPATIBLE_STORE");
    }
}
