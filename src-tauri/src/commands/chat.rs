//! AI 会话：CLI 适配器（spawn claude/codex/grok 非交互模式）+ 会话/消息持久化 + 流式事件。
//!
//! 桥接协议对照 jetbrains-cc-gui 的 ai-bridge（见 docs/tmp/ref-analysis-jetbrains-cc-gui.md）：
//! - claude：`claude -p --output-format stream-json --verbose --include-partial-messages`
//!   stdout JSONL：system/assistant/user/result；stream_event 携带增量
//! - codex：`codex exec --json -m <model>`，`-c model_reasoning_effort="<effort>"`
//! - grok：尝试通用 `--print --json`，失败如实报错（不伪造兼容）
//!
//! 运行快照语义（CR-012）：会话开始时锁定 cli/model/effort；运行中禁止原地切换。

use crate::db;
use crate::models::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};
use tokio::sync::watch;

/// 每个注册项带独立 turn ID；旧任务的清理不得移除新代次。
struct RunningEntry {
    turn_id: String,
    abort: watch::Sender<bool>,
}
static RUNNING: Mutex<BTreeMap<String, RunningEntry>> = Mutex::new(BTreeMap::new());

fn release_turn(running: &mut BTreeMap<String, RunningEntry>, session_id: &str, turn_id: &str) {
    if running.get(session_id).map(|entry| entry.turn_id.as_str()) == Some(turn_id) {
        running.remove(session_id);
    }
}

struct RunningTurn { session_id: String, turn_id: String }
impl RunningTurn {
    fn turn_id(&self) -> &str { &self.turn_id }
}
impl Drop for RunningTurn {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock() { release_turn(&mut running, &self.session_id, &self.turn_id); }
    }
}

fn insert_turn(running: &mut BTreeMap<String, RunningEntry>, session_id: &str, entry: RunningEntry) -> Result<(), String> {
    if running.contains_key(session_id) { return Err("会话已有进行中的发送，请等待或停止".into()); }
    running.insert(session_id.to_string(), entry);
    Ok(())
}

fn reserve_turn(session_id: &str) -> Result<(RunningTurn, watch::Receiver<bool>), String> {
    // 锁顺序统一 DB -> RUNNING，与修改/删除会话及项目更换根目录互斥。
    let _db_guard = db::conn()?;
    let mut running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
    let turn_id = new_id("turn");
    let (abort, receiver) = watch::channel(false);
    insert_turn(&mut running, session_id, RunningEntry { turn_id: turn_id.clone(), abort })?;
    Ok((RunningTurn { session_id: session_id.to_string(), turn_id }, receiver))
}

#[tauri::command]
pub fn chat_status(id: String) -> bool {
    RUNNING.lock().map(|r| r.contains_key(&id)).unwrap_or(true)
}

pub(crate) fn project_is_running(conn: &rusqlite::Connection, project_id: &str) -> Result<bool, String> {
    let mut statement = conn.prepare("SELECT id FROM session WHERE projectId=?1").map_err(|e| e.to_string())?;
    let rows = statement.query_map([project_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let ids = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
    Ok(ids.iter().any(|id| running.contains_key(id)))
}

struct DispatchHolder(Option<crate::commands::dispatch::DispatchConfig>);
impl Drop for DispatchHolder {
    fn drop(&mut self) {
        if let Some(config) = &self.0 { crate::commands::dispatch::cleanup(config); }
    }
}

fn spawn_cmd(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

#[derive(Default, Debug)]
struct FeatureBinding {
    feature_id: Option<String>,
    feature_title: Option<String>,
    feature_source_hash: Option<String>,
}

/// CR-047：执行会话必须绑定本项目中可解析的唯一Feature；普通会话保持无Feature。
fn resolve_execution_feature(conn: &rusqlite::Connection, project_id: Option<&str>, feature_id: Option<&str>) -> Result<FeatureBinding, String> {
    let feature_id = feature_id.map(str::trim).filter(|value| !value.is_empty());
    let Some(feature_id) = feature_id else { return Ok(FeatureBinding::default()); };
    let project_id = project_id.ok_or("执行会话必须指定所属项目")?;
    let (kind, parent, title, hash): (String, Option<String>, String, String) = conn.query_row(
        "SELECT type, parentId, title, contentHash FROM requirement_index WHERE projectId=?1 AND entityId=?2",
        rusqlite::params![project_id, feature_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|_| format!("执行特性 {feature_id} 不存在或不属于该项目"))?;
    if kind != "feature" { return Err(format!("{feature_id} 不是特性（Feature），不能创建执行会话")); }
    let parent = parent.ok_or_else(|| format!("特性 {feature_id} 缺少所属Epic；源关系不完整，不能创建执行会话"))?;
    let parent_kind: String = conn.query_row(
        "SELECT type FROM requirement_index WHERE projectId=?1 AND entityId=?2",
        rusqlite::params![project_id, parent],
        |row| row.get(0),
    ).map_err(|_| format!("特性 {feature_id} 的父项 {parent} 不在本项目源索引中"))?;
    if parent_kind != "epic" { return Err(format!("特性 {feature_id} 的父项 {parent} 不是Epic；源关系异常，不能创建执行会话")); }
    Ok(FeatureBinding { feature_id: Some(feature_id.to_string()), feature_title: Some(title), feature_source_hash: Some(hash) })
}

fn session_row(row: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
    let session_role = row.get::<_, Option<String>>(16)?.unwrap_or_else(|| "ordinary".into());
    // CR-037：绑定派生视图只含状态/原因/脱敏指纹/期望修订，原引用永不出后端。
    let thread_ref: Option<String> = row.get(17)?;
    let binding_revision: i64 = row.get(18)?;
    let confirmed_turn_id: Option<String> = row.get(19)?;
    let last_outcome: Option<String> = row.get(20)?;
    let last_reason: Option<String> = row.get(21)?;
    let message_count: i64 = row.get(12)?;
    let binding = crate::commands::chat_binding::derive_view(
        &session_role,
        row.get::<_, Option<String>>(4)?.as_deref().unwrap_or(""),
        thread_ref.as_deref(),
        binding_revision,
        confirmed_turn_id.as_deref(),
        last_outcome.as_deref(),
        last_reason.as_deref(),
        message_count,
    );
    Ok(SessionMeta {
        id: row.get(0)?,
        project_id: row.get(1)?,
        server_id: row.get(2)?,
        title: row.get(3)?,
        cli_id: row.get(4)?,
        provider_id: row.get(5)?,
        model_id: row.get(6)?,
        effort: row.get(7)?,
        draft: row.get(8)?,
        unread: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        message_count,
        feature_id: row.get(13)?,
        feature_title: row.get(14)?,
        feature_source_hash: row.get(15)?,
        session_role,
        binding,
    })
}

const SESSION_COLUMNS: &str = "s.id, s.projectId, s.serverId, s.title, s.cliId, s.providerId, s.modelId, s.effort, s.draft, s.unread, s.createdAt, s.updatedAt, (SELECT COUNT(*) FROM message m WHERE m.sessionId = s.id) AS cnt, s.featureId, s.featureTitle, s.featureSourceHash, s.sessionRole, \
    s.nativeThreadRef, s.nativeBindingRevision, s.nativeConfirmedTurnId, \
    (SELECT t.outcome FROM execution_session_turn t WHERE t.sessionId = s.id ORDER BY t.createdAt DESC, t.rowid DESC LIMIT 1), \
    (SELECT t.reasonCode FROM execution_session_turn t WHERE t.sessionId = s.id ORDER BY t.createdAt DESC, t.rowid DESC LIMIT 1)";

// ---------- 会话 CRUD ----------

#[tauri::command]
pub fn chat_sessions(project_id: Option<String>) -> Result<Vec<SessionMeta>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let sql = format!(
        "SELECT {} FROM session s {} ORDER BY s.updatedAt DESC",
        SESSION_COLUMNS,
        match &project_id { Some(_) => "WHERE s.projectId = ?1", None => "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if let Some(pid) = &project_id {
        stmt.query_map([pid], session_row).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect()
    } else {
        stmt.query_map([], session_row).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect()
    };
    Ok(rows)
}

#[tauri::command]
pub fn chat_session_create(
    project_id: Option<String>,
    server_id: Option<String>,
    cli_id: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    feature_id: Option<String>,
) -> Result<SessionMeta, String> {
    let id = new_id("sess");
    let now = now_ms();
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let binding = resolve_execution_feature(conn, project_id.as_deref(), feature_id.as_deref())?;
        let role = if binding.feature_id.is_some() { "executor" } else { "ordinary" };
        let title = binding.feature_id.as_ref().map(|id| match &binding.feature_title {
            Some(name) => format!("执行 {id} · {name}"),
            None => format!("执行 {id}"),
        }).unwrap_or_else(|| "新会话".into());
        conn.execute(
            "INSERT INTO session (id, projectId, serverId, title, cliId, providerId, modelId, effort, draft, createdAt, updatedAt, featureId, featureTitle, featureSourceHash, sessionRole)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9,?9,?10,?11,?12,?13)",
            rusqlite::params![id, project_id, server_id, title, cli_id, provider_id, model_id, effort, now, binding.feature_id, binding.feature_title, binding.feature_source_hash, role],
        )
        .map_err(|e| e.to_string())?;
    }
    chat_session_get(id)
}

#[tauri::command]
pub fn chat_session_get(id: String) -> Result<SessionMeta, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.query_row(
        &format!("SELECT {} FROM session s WHERE s.id=?1", SESSION_COLUMNS),
        [&id],
        session_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_session_update(
    id: String,
    title: Option<String>,
    draft: Option<String>,
    cli_id: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    unread: Option<String>,
) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
    // 运行中禁止修改执行配置（运行快照锁定）
    if running.contains_key(&id)
        && (cli_id.is_some() || provider_id.is_some() || model_id.is_some() || effort.is_some())
    {
        return Err("会话运行中或有待审操作，禁止修改执行配置".into());
    }
    // CR-037 / STORY-011 AC-05：非空会话（有消息或已有原生绑定）禁止原地换 CLI——
    // 前端改为确认后另建会话；空会话维持原地修改。
    if let Some(new_cli) = cli_id.as_deref() {
        let (current_cli, msg_count, has_binding): (Option<String>, i64, i64) = conn.query_row(
            "SELECT cliId,
                    (SELECT COUNT(*) FROM message WHERE sessionId=?1),
                    (SELECT COUNT(*) FROM session WHERE id=?1 AND (nativeThreadRef IS NOT NULL OR nativeConfirmedTurnId IS NOT NULL))
             FROM session WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
        if current_cli.as_deref() != Some(new_cli) && (msg_count > 0 || has_binding > 0) {
            return Err(format!(
                "会话已有 {} 条消息或原生绑定，切换 CLI 须另建会话（历史保留在原会话）",
                msg_count
            ));
        }
    }
    // COALESCE：None 表示保持原值；draft 传空串即清空
    // CR-047：featureId/featureTitle/featureSourceHash/sessionRole 不在更新白名单内，绑定不可改。
    conn.execute(
        "UPDATE session SET
            updatedAt = ?2,
            title = COALESCE(?3, title),
            draft = COALESCE(?4, draft),
            cliId = COALESCE(?5, cliId),
            providerId = COALESCE(?6, providerId),
            modelId = COALESCE(?7, modelId),
            effort = COALESCE(?8, effort),
            unread = COALESCE(?9, unread)
         WHERE id = ?1",
        rusqlite::params![id, now_ms(), title, draft, cli_id, provider_id, model_id, effort, unread],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn chat_session_delete(id: String) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
    if running.contains_key(&id) {
        return Err("会话运行中，先停止再删除".into());
    }
    conn.execute("DELETE FROM session WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn chat_messages(session_id: String) -> Result<Vec<ChatMessage>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, sessionId, role, content, metaJson, refsJson, gitContextJson, createdAt FROM message WHERE sessionId=?1 ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&session_id], |r| {
            Ok(ChatMessage {
                content: r.get(3)?,
                created_at: r.get(7)?,
                git_context_json: r.get(6)?,
                id: r.get(0)?,
                meta_json: r.get(4)?,
                refs_json: r.get(5)?,
                role: r.get(2)?,
                session_id: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn chat_abort(session_id: String) -> Result<(), String> {
    if let Some(entry) = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?.get(&session_id) {
        let _ = entry.abort.send(true);
    }
    Ok(())
}

/// 工具确认（本轮适配器为非交互模式：审批由 permission-mode 决定；此命令保留契约）。
#[tauri::command]
pub fn chat_approve_tool(_request_id: String, _decision: String) -> Result<(), String> {
    Err("当前 CLI 适配器为非交互模式，工具权限由 permission-mode 决定；本命令暂无待审请求".into())
}

// ---------- 发送 ----------

#[tauri::command]
pub async fn chat_send(
    app: tauri::AppHandle,
    payload: SendPayload,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let session_id = payload.session_id.clone();
    let (running_turn, abort_rx) = reserve_turn(&session_id)?;
    // 会话与执行配置
    let session = chat_session_get(session_id.clone())?;
    let cli_id = session.cli_id.clone().ok_or("会话未选择 CLI")?;
    let model_id = session.model_id.clone().unwrap_or_default();
    let effort = session.effort.clone().unwrap_or_default();
    let project_root: Option<String> = match &session.project_id {
        Some(pid) => {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let root: String = conn.query_row("SELECT rootUri FROM project WHERE id=?1", [pid], |r| r.get(0))
                .map_err(|_| "会话所属项目不存在".to_string())?;
            let canonical = std::fs::canonicalize(&root).map_err(|_| "项目根目录不可访问".to_string())?;
            if !canonical.is_dir() { return Err("项目根不是目录".into()); }
            Some(canonical.to_string_lossy().to_string())
        }
        None => None,
    };

    // CR-047：执行会话发送前复检Feature仍属于本项目且绑定未被篡改；源变更只提示，不静默换归属。
    if let Some(feature_id) = session.feature_id.as_deref() {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let current = resolve_execution_feature(conn, session.project_id.as_deref(), Some(feature_id))?;
        if current.feature_id.as_deref() != Some(feature_id) {
            return Err("执行会话的Feature绑定不一致，拒绝发送".into());
        }
        if current.feature_source_hash != session.feature_source_hash {
            return Err(format!("特性 {feature_id} 的源已变化；请重新预检后再创建或绑定执行会话，未按旧范围发送"));
        }
    }

    // CLI 已安装校验
    let installed: Option<String> = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        conn.query_row(
            "SELECT installState FROM cli_sdk WHERE id=?1 AND enabled=1",
            [&cli_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    if installed.as_deref() != Some("installed") {
        return Err(format!("CLI「{}」未安装或未启用，请先在设置 → SDK 管理中安装", cli_id));
    }

    validate_permission(&cli_id, payload.permission_id.as_deref())?;
    // 知识和文件引用必须由后端复核归属/授权，技能读取真实正文。
    let prompt = build_prompt(&app, &payload, session.project_id.as_deref())?;

    // 所有启动校验均在持久化用户消息之前完成，失败保留前端草稿。
    let mut dispatch = DispatchHolder(crate::commands::dispatch::resolve(
        &app, &cli_id, &session_id, session.provider_id.as_deref(), &model_id, &effort,
    )?);
    if dispatch.0.is_none() && session.provider_id.as_deref().map(|p| !p.is_empty()).unwrap_or(false) {
        return Err("会话绑定的供应商无法解析，请检查设置中的供应商/密钥/端点".into());
    }
    if let Some(config) = dispatch.0.as_mut() {
        // dispatch 的旧目录暴露包括停用技能；仅允许本轮显式引用的正文注入。
        config.add_dirs.clear();
    }

    // CR-037 / AC-05/06：普通会话的原生绑定解析（执行会话不绑定；解析失败在持久化用户消息前拒绝，
    // 草稿保留）。原引用只存在于后端内存，错误信息只带原因码。
    let turn_id = running_turn.turn_id().to_string();
    let (requested_resume, turn_mode, compat_key) = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        tx_debug(conn, "binding-resolve");
        let cli_version: Option<String> = conn
            .query_row("SELECT version FROM cli_sdk WHERE id=?1", [&cli_id], |r| r.get(0))
            .ok()
            .flatten();
        let scope = match (&session.project_id, &session.server_id) {
            (Some(p), _) => format!("project:{p}"),
            (None, Some(s)) => format!("server:{s}"),
            _ => "global".into(),
        };
        let provider_fp = match dispatch.0.as_ref().filter(|d| !d.display.provider_id.is_empty()) {
            Some(d) => crate::commands::chat_binding::provider_fingerprint(&d.display.protocol, &d.display.base_url_host, &d.display.provider_id),
            None => "external".into(),
        };
        let compat_key = crate::commands::chat_binding::compatibility_key(&cli_id, cli_version.as_deref().unwrap_or("unknown"), "headless", &provider_fp, &scope);
        let current_grant_rev = crate::commands::chat_binding::grant_revision_snapshot(conn, session.project_id.as_deref())?;
        let snapshot = crate::commands::chat_binding::load_binding(conn, &session_id)?;
        let decision = crate::commands::chat_binding::resolve_binding(&snapshot, &cli_id, &compat_key, current_grant_rev, session.message_count > 0);
        match decision {
            crate::commands::chat_binding::BindingDecision::Send { mode, requested } => Ok((requested, mode, compat_key)),
            crate::commands::chat_binding::BindingDecision::FreshPending { reason } => {
                if session.session_role == "ordinary" {
                    record_refused_row(conn, &session_id, &turn_id, "resume", snapshot.binding_revision, current_grant_rev, reason)?;
                }
                Err(format!(
                    "BINDING_FRESH_REQUIRED|{}|{}|{}",
                    reason,
                    snapshot.binding_revision,
                    crate::commands::chat_binding::reason_text(reason)
                ))
            }
            crate::commands::chat_binding::BindingDecision::Blocked { reason } => {
                if session.session_role == "ordinary" {
                    record_refused_row(conn, &session_id, &turn_id, "resume", snapshot.binding_revision, current_grant_rev, reason)?;
                }
                Err(format!(
                    "BINDING_BLOCKED|{}|{}|{}",
                    reason,
                    snapshot.binding_revision,
                    crate::commands::chat_binding::reason_text(reason)
                ))
            }
        }?
    };
    if *abort_rx.borrow() { return Err("发送已停止".into()); }
    let permission_id = payload.permission_id.clone();
    let child = spawn_cli(&cli_id, &model_id, &effort, project_root.as_deref(), dispatch.0.as_ref(), permission_id.as_deref(), requested_resume.as_deref())?;

    // 持久化用户消息
    let msg_id = new_id("msg");
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        tx_debug(conn, "before-user-msg");
        conn.execute(
            "INSERT INTO message (id, sessionId, role, content, refsJson, createdAt) VALUES (?1,?2,'user',?3,?4,?5)",
            rusqlite::params![
                msg_id,
                session_id,
                payload.content,
                serde_json::to_string(&payload.refs).ok(),
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("UPDATE session SET updatedAt=?2 WHERE id=?1", rusqlite::params![session_id, now_ms()])
            .map_err(|e| e.to_string())?;
    }

    let session_id2 = session_id.clone();
    let cli_id2 = cli_id.clone();
    let ordinary = session.session_role == "ordinary";
    let binding_revision = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        crate::commands::chat_binding::load_binding(conn, &session_id)?.binding_revision
    };
    let grant_revision = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        crate::commands::chat_binding::grant_revision_snapshot(conn, session.project_id.as_deref())?
    };
    tokio::spawn(async move {
        // RAII 在成功、错误、任务取消或 panic 时都只清理本代次。
        let _running_turn = running_turn;
        let _dispatch_holder = dispatch;
        let max_attempts: i64 = 2;
        let mut attempt: i64 = 0;
        let mut current_child = child;
        let result = loop {
            let run = run_cli_stream(current_child, abort_rx.clone(), &cli_id2, &prompt, &session_id2, &channel).await;
            match run {
                Err(fail) if attempt < max_attempts && retry_reason(&fail).is_some() && !*abort_rx.borrow() => {
                    attempt += 1;
                    let delay_ms = 750_i64 * (1_i64 << (attempt - 1));
                    let reason = retry_reason(&fail).unwrap_or("供应商暂时不可用");
                    let _ = channel.send(serde_json::json!({
                        "type": "retrying",
                        "attempt": attempt,
                        "maxAttempts": max_attempts,
                        "delayMs": delay_ms,
                        "reason": reason
                    }));
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms as u64)).await;
                    if *abort_rx.borrow() {
                        break Err(fail);
                    }
                    match spawn_cli(&cli_id2, &model_id, &effort, project_root.as_deref(), _dispatch_holder.0.as_ref(), permission_id.as_deref(), requested_resume.as_deref()) {
                        Ok(next) => { current_child = next; }
                        Err(message) => break Err(StreamFailure { message, stderr: String::new(), timed_out: false }),
                    }
                }
                other => break other,
            }
        };
        drop(_dispatch_holder);
        // CR-037：结算与消息持久化在同一连接窗口完成，且先于 RUNNING 释放与 done 事件。
        let settle = match &result {
            Ok(out) => {
                if !out.aborted {
                    match persist_and_settle(&session_id2, out, &turn_id, turn_mode, requested_resume.as_deref(), binding_revision, grant_revision, Some(compat_key.clone()), ordinary, cli_id2.as_str()) {
                        Ok(done) => Some(done),
                        Err(e) => { let _ = channel.send(serde_json::json!({ "type": "error", "message": e })); None }
                    }
                } else {
                    match archive_turn(&session_id2, out, &turn_id, requested_resume.as_deref(), binding_revision, grant_revision, ordinary) {
                        Ok(done) => Some(done),
                        Err(e) => { let _ = channel.send(serde_json::json!({ "type": "error", "message": e })); None }
                    }
                }
            }
            Err(fail) => {
                match failure_turn(&session_id2, fail, &turn_id, requested_resume.as_deref(), binding_revision, grant_revision, ordinary, cli_id2.as_str()) {
                    Ok(Some(done)) => Some(done),
                    Ok(None) => None,
                    Err(e) => { let _ = channel.send(serde_json::json!({ "type": "error", "message": e })); None }
                }
            }
        };
        drop(_running_turn);
        match (&result, settle) {
            (_, Some(done)) => { let _ = channel.send(done); }
            (Ok(_), None) => {}
            (Err(fail), None) => { let _ = channel.send(serde_json::json!({ "type": "error", "message": fail.message.clone() })); }
        }
    });
    Ok(())
}

/// 诊断：共享连接的事务状态（仅在 debug 输出；用于定位「事务内再开事务」）。
fn tx_debug(conn: &rusqlite::Connection, tag: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[chat] tx-state tag={} autocommit={}", tag, conn.is_autocommit());
    let _ = conn;
    let _ = tag;
}

/// done 事件载荷：只含轮次身份、判定结果与脱敏指纹；原引用永不发给前端。
fn done_payload(turn_id: &str, result: &crate::commands::chat_binding::SettleResult) -> serde_json::Value {
    serde_json::json!({
        "type": "done",
        "turnId": turn_id,
        "nativeResumed": result.native_resumed,
        "freshContext": result.fresh_context,
        "blocked": result.outcome == "blocked",
        "reasonCode": result.reason_code,
        "refFingerprint": result.ref_fingerprint,
    })
}

/// spawn 前被拒（freshPending / blocked）：登记 blocked 轮次行，供重启后恢复阻塞状态与审计。
fn record_refused_row(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_id: &str,
    mode: &str,
    expected_binding_revision: i64,
    grant_revision: i64,
    reason: &str,
) -> Result<(), String> {
    let turn_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(turnSeq),0)+1 FROM execution_session_turn WHERE sessionId=?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,reasonCode,expectedBindingRevision,grantRevision,createdAt,settledAt)
         VALUES (?1,?2,?3,?4,'blocked',?5,?6,?7,?8,?8)",
        rusqlite::params![turn_id, session_id, turn_seq, mode, reason, expected_binding_revision, grant_revision, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 已停止轮：持久化既有部分输出 + 只写 archived 行（STOPPED），不改绑定。
fn archive_turn(
    session_id: &str,
    out: &StreamOutcome,
    turn_id: &str,
    requested_resume: Option<&str>,
    binding_revision: i64,
    grant_revision: i64,
    ordinary: bool,
) -> Result<serde_json::Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("会话数据库未初始化")?;
    let tx = conn.unchecked_transaction().map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    insert_assistant_messages(&tx, session_id, out).map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    if ordinary {
        let mode = if requested_resume.is_some() { "resume" } else { "create" };
        record_refused_row_tx(&tx, session_id, turn_id, mode, binding_revision, grant_revision, "STOPPED")?;
    }
    tx.commit().map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    Ok(serde_json::json!({
        "type": "done",
        "turnId": turn_id,
        "nativeResumed": false,
        "freshContext": false,
        "blocked": false,
        "reasonCode": if ordinary { serde_json::Value::from("STOPPED") } else { serde_json::Value::Null },
        "refFingerprint": serde_json::Value::Null,
    }))
}

fn record_refused_row_tx(
    tx: &rusqlite::Transaction,
    session_id: &str,
    turn_id: &str,
    mode: &str,
    expected_binding_revision: i64,
    grant_revision: i64,
    reason: &str,
) -> Result<(), String> {
    record_turn_row_tx(tx, session_id, turn_id, mode, "archived", expected_binding_revision, grant_revision, reason)
}

/// 轮次行写入（无 session 更新）：outcome 由调用方给定（archived / blocked）。
fn record_turn_row_tx(
    tx: &rusqlite::Transaction,
    session_id: &str,
    turn_id: &str,
    mode: &str,
    outcome: &str,
    expected_binding_revision: i64,
    grant_revision: i64,
    reason: &str,
) -> Result<(), String> {
    let turn_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(turnSeq),0)+1 FROM execution_session_turn WHERE sessionId=?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,reasonCode,expectedBindingRevision,grantRevision,createdAt,settledAt)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        rusqlite::params![turn_id, session_id, turn_seq, mode, outcome, reason, expected_binding_revision, grant_revision, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 正常完成轮：消息持久化 + 轮次判定 + CAS 绑定结算在同一事务窗口。
/// 不支持续接的 CLI（grok）与执行会话一样不写轮次行（无线程可绑定）。
fn persist_and_settle(
    session_id: &str,
    out: &StreamOutcome,
    turn_id: &str,
    mode: &'static str,
    requested_resume: Option<&str>,
    binding_revision: i64,
    grant_revision: i64,
    compat_key: Option<String>,
    ordinary: bool,
    cli_id: &str,
) -> Result<serde_json::Value, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("会话数据库未初始化")?;
    tx_debug(conn, "persist_and_settle-begin");
    let tx = conn.unchecked_transaction().map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    insert_assistant_messages(&tx, session_id, out).map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    let payload = if ordinary && crate::commands::chat_binding::cli_supported(cli_id) {
        let verdict = crate::commands::chat_binding::judge_turn(
            requested_resume,
            out.emitted_ref.as_deref(),
            out.is_error,
            true,
            "",
            None,
        );
        let plan = crate::commands::chat_binding::SettlePlan {
            turn_id: turn_id.to_string(),
            mode,
            expected_binding_revision: binding_revision,
            grant_revision,
            current_compat_key: compat_key,
            verdict,
        };
        let result = crate::commands::chat_binding::settle_turn(&tx, session_id, &plan)?;
        done_payload(turn_id, &result)
    } else {
        serde_json::json!({
            "type": "done",
            "turnId": turn_id,
            "nativeResumed": false,
            "freshContext": false,
            "blocked": false,
            "reasonCode": serde_json::Value::Null,
            "refFingerprint": serde_json::Value::Null,
        })
    };
    tx.commit().map_err(|_| "回复保存失败，流式内容保留但未持久化".to_string())?;
    Ok(payload)
}

/// 流失败轮：resume 失败带原生报错特征 → blocked（REF_STALE / REF_NOT_READY）并以 done 通报；
/// 其余（超时/崩溃）→ archived 行 + error 事件（None）。
fn failure_turn(
    session_id: &str,
    fail: &StreamFailure,
    turn_id: &str,
    requested_resume: Option<&str>,
    binding_revision: i64,
    grant_revision: i64,
    ordinary: bool,
    _cli_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    if !ordinary || requested_resume.is_none() {
        // 非绑定相关失败：不写轮次行（进程未产生任何上下文），按原错误路径报错。
        return Ok(None);
    }
    let verdict = crate::commands::chat_binding::judge_turn(
        requested_resume,
        None,
        false,
        false,
        &fail.stderr,
        first_confirmed_settled_at(session_id)?,
    );
    match verdict {
        crate::commands::chat_binding::Verdict::Blocked { reason } => {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            record_turn_row_tx(&tx, session_id, turn_id, "resume", "blocked", binding_revision, grant_revision, reason)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(Some(serde_json::json!({
                "type": "done",
                "turnId": turn_id,
                "nativeResumed": false,
                "freshContext": false,
                "blocked": true,
                "reasonCode": reason,
                "refFingerprint": serde_json::Value::Null,
            })))
        }
        _ => Ok(None),
    }
}

/// 首轮（最近一次 confirmed 轮）落定时间，用于 REF_NOT_READY 竞态窗口判定。
fn first_confirmed_settled_at(session_id: &str) -> Result<Option<i64>, String> {
    use rusqlite::OptionalExtension;
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let t: Option<Option<i64>> = conn
        .query_row(
            "SELECT MAX(settledAt) FROM execution_session_turn WHERE sessionId=?1 AND outcome='confirmed'",
            [session_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(t.flatten())
}

/// 只开放当前适配器能生成明确原生参数的模式；未知或危险模式必须拒绝。
fn validate_permission(cli_id: &str, permission_id: Option<&str>) -> Result<(), String> {
    if !matches!(cli_id, "claude" | "codex" | "grok") { return Err("未知 CLI".into()); }
    match permission_id {
        None | Some("default") => Ok(()),
        Some("plan" | "agent") if matches!(cli_id, "claude" | "codex") => Ok(()),
        Some(_) => Err("当前 CLI/版本未核验该权限模式或缺少审批/隔离能力，发送已拒绝".into()),
    }
}

const MAX_REF_TEXT: usize = 64 * 1024;
const MAX_PROMPT_TEXT: usize = 512 * 1024;

fn xml_attribute(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn validate_office_ref(project_id: Option<&str>, kind: Option<&str>, id: &str, content: Option<&str>) -> Result<(), String> {
    let pid = project_id.ok_or("办公引用缺少项目身份")?;
    if kind != Some("work") { return Err("办公引用只能属于办公项目".into()); }
    let prefix = format!("office:OFF-{}-", pid);
    let suffix = id.strip_prefix(&prefix).filter(|s| !s.is_empty()).ok_or("办公引用不属于当前项目")?;
    if !suffix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("办公引用 ID 无效".into());
    }
    if content.map(|s| s.len() > MAX_REF_TEXT).unwrap_or(false) { return Err("办公引用正文过长".into()); }
    Ok(())
}

fn checked_file_ref(conn: &rusqlite::Connection, project_id: &str, root: &std::path::Path, target: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(target);
    let absolute = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let canonical = std::fs::canonicalize(absolute).map_err(|_| "引用文件不可访问".to_string())?;
    let root = std::fs::canonicalize(root).map_err(|_| "项目根目录不可访问".to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("文件引用不在当前项目根目录内".into());
    }
    // 库目录即使与项目根重叠，亦不能借 file kind 穿过独立知识授权。
    let mut statement = conn.prepare(
        "SELECT l.sourceRef, l.enabled, COALESCE(g.readAllowed,0) FROM knowledge_library l
         LEFT JOIN project_library_grant g ON g.libraryId=l.id AND g.projectId=?1",
    ).map_err(|e| e.to_string())?;
    let rows = statement.query_map([project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (source, enabled, allowed) = row.map_err(|e| e.to_string())?;
        if let Ok(library_root) = std::fs::canonicalize(source) {
            if canonical.starts_with(library_root) && (enabled == 0 || allowed == 0) {
                return Err("文件位于未授权或停用的知识库，引用已拒绝".into());
            }
        }
    }
    Ok(canonical)
}

fn check_prompt_size(parts: &[String]) -> Result<(), String> {
    if parts.iter().map(|s| s.len() + 2).sum::<usize>() > MAX_PROMPT_TEXT {
        return Err("本轮上下文过长，请减少引用".into());
    }
    Ok(())
}

/// 组装提示词；office 正文仅接受有当前 work 项目身份的内存快照。
/// 这是受管注入边界，不代表 CLI 原生工具拥有 OS 隔离。
fn build_prompt(app: &tauri::AppHandle, payload: &SendPayload, project_id: Option<&str>) -> Result<String, String> {
    if payload.refs.len() > 32 || payload.attachments.len() > 32 || payload.content.len() > MAX_PROMPT_TEXT {
        return Err("本轮消息或引用过多".into());
    }
    let project: Option<(String, String)> = match project_id {
        Some(pid) => {
            let guard = db::conn()?;
            let conn = guard.as_ref().ok_or("db not initialized")?;
            Some(conn.query_row("SELECT type, rootUri FROM project WHERE id=?1", [pid], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| "引用所属项目不存在".to_string())?)
        }
        None => None,
    };
    let mut parts: Vec<String> = Vec::new();
    // CR-030-D1：知识引用改有界片段注入；同一轮同 (noteId,ordinal) 去重。
    let mut seen_knowledge: std::collections::HashSet<(String, usize)> = std::collections::HashSet::new();
    for r in &payload.refs {
        if r.object_id.len() > 4096 || r.display.len() > 4096 || r.content.as_ref().map(|s| s.len() > MAX_REF_TEXT).unwrap_or(false) {
            return Err("引用标识或正文过长".into());
        }
        if r.kind != "file" && r.content.is_some() { return Err("该引用类型不接受任意正文快照".into()); }
        if r.kind != "knowledge" && r.library_id.is_some() { return Err("知识引用必须使用授权网关".into()); }
        match r.kind.as_str() {
            "knowledge" => {
                let lib = r.library_id.as_deref().ok_or("知识引用缺少 libraryId")?;
                // 先复核停用状态，再由现有网关每次检查项目授权。
                {
                    let guard = db::conn()?;
                    let conn = guard.as_ref().ok_or("db not initialized")?;
                    let enabled: i64 = conn.query_row("SELECT enabled FROM knowledge_library WHERE id=?1", [lib], |row| row.get(0))
                        .map_err(|_| "知识库不存在".to_string())?;
                    if enabled == 0 { return Err("知识库已停用".into()); }
                }
                // 有界读取：返回首块（≤4096 bytes）+ 完整出处；不再整篇注入。
                let view = crate::commands::knowledge::gateway_read_chunk(project_id, lib, &r.object_id)?;
                if !seen_knowledge.insert((r.object_id.clone(), view.ordinal)) { continue; }
                if view.content.len() > MAX_REF_TEXT { return Err("知识引用过长，请使用较小资料".into()); }
                parts.push(format!(
                    "<knowledge library=\"{}\" note=\"{}\" revision=\"{}\" range=\"{}-{}\">\n{}\n</knowledge>",
                    xml_attribute(lib),
                    xml_attribute(&r.object_id),
                    xml_attribute(&view.source_hash),
                    view.start_byte,
                    view.end_byte,
                    view.content
                ));
            }
            "skill" => {
                let name = r.object_id.strip_prefix("skill:").unwrap_or(&r.object_id);
                if name.is_empty() || name.len() > 128 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                    return Err("技能引用名称无效".into());
                }
                {
                    let guard = db::conn()?;
                    let conn = guard.as_ref().ok_or("db not initialized")?;
                    use rusqlite::OptionalExtension;
                    let enabled: Option<i64> = conn.query_row("SELECT enabled FROM capability WHERE kind='skill' AND name=?1", [name], |row| row.get(0))
                        .optional().map_err(|e| e.to_string())?;
                    // 与 skill_list 的受管目录默认启用语义一致，显式停用永不注入。
                    if enabled == Some(0) { return Err("技能已停用，引用已拒绝".into()); }
                }
                use tauri::Manager;
                let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
                let source = std::fs::canonicalize(root.join(name).join("SKILL.md")).map_err(|_| "技能正文不存在".to_string())?;
                let root = std::fs::canonicalize(root).map_err(|_| "技能目录不可访问".to_string())?;
                if !source.starts_with(&root) || std::fs::metadata(&source).map_err(|e| e.to_string())?.len() > MAX_REF_TEXT as u64 {
                    return Err("技能正文越界或过长".into());
                }
                let body = crate::commands::capabilities::skill_read(app.clone(), name.to_string())?;
                if body.len() > MAX_REF_TEXT { return Err("技能正文过长".into()); }
                parts.push(format!("<skill name=\"{}\">\n{}\n</skill>", xml_attribute(name), body));
            }
            "file" if r.object_id.starts_with("office:") => {
                validate_office_ref(project_id, project.as_ref().map(|p| p.0.as_str()), &r.object_id, r.content.as_deref())?;
                let body = r.content.as_deref().ok_or("办公引用缺少本轮内容快照")?;
                parts.push(format!("<office-source path=\"{}\" source=\"memory-snapshot\">\n{}\n</office-source>", xml_attribute(&r.display), body));
            }
            "file" => {
                if r.content.is_some() { return Err("磁盘文件引用不接受任意正文，请使用当前项目中的真实文件".into()); }
                let pid = project_id.ok_or("文件引用缺少项目身份")?;
                let root = &project.as_ref().ok_or("文件引用所属项目不存在")?.1;
                let guard = db::conn()?;
                let conn = guard.as_ref().ok_or("db not initialized")?;
                let path = checked_file_ref(conn, pid, std::path::Path::new(root), &r.object_id)?;
                parts.push(format!("<file-ref path=\"{}\" />", xml_attribute(&path.to_string_lossy())));
            }
            "requirement" => {
                let pid = project_id.ok_or("需求引用缺少项目身份")?;
                let root = &project.as_ref().ok_or("需求引用所属项目不存在")?.1;
                let guard = db::conn()?;
                let conn = guard.as_ref().ok_or("db not initialized")?;
                let source: String = conn.query_row("SELECT sourceUri FROM requirement_index WHERE projectId=?1 AND entityId=?2", [pid, &r.object_id], |row| row.get(0))
                    .map_err(|_| "需求引用不属于当前项目".to_string())?;
                checked_file_ref(conn, pid, std::path::Path::new(root), &source)?;
                parts.push(format!("<requirement id=\"{}\">{}</requirement>", xml_attribute(&r.object_id), xml_attribute(&r.display)));
            }
            "command" => parts.push(format!("<command name=\"{}\" />", xml_attribute(&r.object_id))),
            _ => return Err("不支持的上下文引用类型".into()),
        }
        check_prompt_size(&parts)?;
    }
    for att in &payload.attachments {
        if att.name.len() > 4096 { return Err("附件名称过长".into()); }
        parts.push(format!("<attachment name=\"{}\" size=\"{}\" />", xml_attribute(&att.name), att.byte_size.unwrap_or(0)));
    }
    parts.push(payload.content.clone());
    check_prompt_size(&parts)?;
    Ok(parts.join("\n\n"))
}

struct StreamOutcome {
    assistant_text: String,
    thinking_text: String,
    tool_uses: Vec<(String, String, String)>,  // id, name, input
    tool_results: Vec<(String, String, bool)>, // id, content, is_error
    usage: Option<(i64, i64, i64)>,
    /// 流内适配器上报的线程/会话 id（emittedRef）。仅后端内存使用，不进日志与前端。
    emitted_ref: Option<String>,
    /// CR-037：本轮请求的 resume 引用（requestedResume）。
    requested_resume: Option<String>,
    /// claude result.is_error：exit 0 不可信，is_error 才能识别 API 失败轮。
    is_error: bool,
    /// 途中被停止（写 stdin 阶段或流中）。
    aborted: bool,
    /// CR-056：首段 thinking 的时间点，用于统计思考阶段耗时。
    thinking_started: Option<std::time::Instant>,
    /// CR-056：思考阶段耗时（毫秒），0 表示尚未确定。落库进 metaJson.thinkingMs。
    thinking_ms: u64,
}

impl StreamOutcome {
    /// 收到首段思考内容时开始计时。
    fn mark_thinking(&mut self) {
        if self.thinking_started.is_none() {
            self.thinking_started = Some(std::time::Instant::now());
        }
    }

    /// 思考阶段在首段正文出现时结束；重复调用只记录第一次。
    fn mark_content(&mut self) {
        if self.thinking_ms == 0 {
            if let Some(t) = self.thinking_started {
                self.thinking_ms = t.elapsed().as_millis() as u64;
            }
        }
    }
}

impl Default for StreamOutcome {
    fn default() -> Self {
        Self {
            assistant_text: String::new(),
            thinking_text: String::new(),
            tool_uses: vec![],
            tool_results: vec![],
            usage: None,
            emitted_ref: None,
            requested_resume: None,
            is_error: false,
            aborted: false,
            thinking_started: None,
            thinking_ms: 0,
        }
    }
}

/// 流失败的结构化错误：携带 stderr 摘要以识别原生 resume 报错（REF_STALE 竞态）。
struct StreamFailure {
    message: String,
    stderr: String,
    timed_out: bool,
}

fn spawn_cli(
    cli_id: &str,
    model_id: &str,
    effort: &str,
    cwd: Option<&str>,
    dispatch: Option<&crate::commands::dispatch::DispatchConfig>,
    permission_id: Option<&str>,
    resume_ref: Option<&str>,
) -> Result<Child, String> {
    validate_permission(cli_id, permission_id)?;
    // CR-053：命令工具设置读取 + 启动前复检；所选路径失效时阻止启动并提示改选「自动」，不静默回落。
    let shell_setting = crate::commands::shell::prepare_launch(cli_id)?;
    // 优先使用 SDK 管理登记的可执行路径（安装/检测时记录），否则按 PATH 解析
    let registered: Option<String> = (|| {
        let guard = db::conn().ok()?;
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT path FROM cli_sdk WHERE id=?1 AND enabled=1",
            [cli_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|p| !p.is_empty() && std::path::Path::new(p).is_file())
    })();
    let cli_bin: String = registered.unwrap_or_else(|| crate::util::resolve_command(cli_id));
    #[cfg(debug_assertions)]
    eprintln!(
        "[chat] spawn cli={} bin={} resume={}",
        cli_id,
        cli_bin,
        resume_ref.map(crate::commands::chat_binding::fingerprint_ref).unwrap_or_else(|| "none".into())
    );

    let mut cmd = match cli_id {
        "claude" => {
            let mut c = Command::new(&cli_bin);
            let permission_mode = match permission_id {
                Some("plan") => "plan",
                Some("agent") => "acceptEdits",
                _ => "default",
            };
            c.arg("-p")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose")
                .arg("--include-partial-messages")
                .arg("--permission-mode")
                .arg(permission_mode);
            // CR-037：原生续接——resume 引用只在后端内存出现，不进日志/前端。
            if let Some(resume_ref) = resume_ref {
                c.arg("--resume").arg(resume_ref);
            }
            if !model_id.is_empty() {
                c.arg("--model").arg(model_id);
            }
            if let Some(d) = dispatch {
                // 供应商必须经 --settings 注入（env 会被 CLI 忽略）
                if let Some(sf) = &d.settings_file {
                    c.arg("--settings").arg(sf);
                }
                // 受管 MCP：严格模式只用我们的配置，并放行对应工具
                if let Some(mcp) = &d.mcp_config_file {
                    c.arg("--strict-mcp-config").arg("--mcp-config").arg(mcp);
                    if !d.mcp_allowed_tools.is_empty() {
                        c.arg("--allowedTools").arg(d.mcp_allowed_tools.join(","));
                    }
                }
                // 技能目录
                for dir in d.add_dirs.iter() {
                    c.arg("--add-dir").arg(dir);
                }
            }
            c
        }
        "codex" => {
            let mut c = Command::new(&cli_bin);
            // CR-037：`codex exec resume <id>` 续接（同 CODEX_HOME store）；注意 resume 子命令在 flags 之前。
            if let Some(resume_ref) = resume_ref {
                c.arg("exec").arg("resume").arg(resume_ref);
            } else {
                c.arg("exec");
            }
            c.arg("--json").arg("--skip-git-repo-check");
            if !model_id.is_empty() {
                c.arg("-m").arg(model_id);
            }
            if let Some(d) = dispatch {
                if d.ignore_user_config {
                    c.arg("--ignore-user-config");
                }
                for ov in d.codex_overrides.iter() {
                    c.arg("-c").arg(ov);
                }
            } else if !effort.is_empty() && effort != "off" {
                c.arg("-c").arg(format!("model_reasoning_effort=\"{}\"", effort));
            }
            c.arg("-c").arg("project_doc_max_bytes=65536");
            // 权限覆盖置于供应商覆盖之后，禁止旧 override 抢占显式模式。
            match permission_id {
                Some("plan") => {
                    c.arg("--sandbox").arg("read-only").arg("-c").arg("approval_policy=\"never\"");
                }
                Some("agent") => {
                    c.arg("--sandbox").arg("workspace-write").arg("-c").arg("approval_policy=\"never\"");
                }
                _ => {}
            }
            c
        }
        "grok" => {
            // grok `--print --json` 单轮通道无线程概念（CR-037 本轮登记不支持原生续接）。
            let mut c = Command::new(&cli_bin);
            c.arg("--print").arg("--json");
            if !model_id.is_empty() {
                c.arg("--model").arg(model_id);
            }
            c
        }
        other => return Err(format!("未知 CLI：{}", other)),
    };

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if cli_id == "codex" {
        cmd.arg("-");
    }

    // 注入供应商环境；先清理可能串号的原生配置
    if let Some(d) = dispatch {
        for prefix in d.strip_prefixes.iter() {
            for (k, _) in std::env::vars() {
                if k.starts_with(prefix.as_str()) {
                    cmd.env_remove(&k);
                }
            }
        }
        for (k, v) in d.env.iter() {
            cmd.env(k, v);
        }
    }
    // 不暴露全局受管 skills 目录（其中可能有停用项）。
    cmd.env_remove("AGENT_WORKBENCH_SKILLS");

    // CR-053：在供应商环境注入与 strip_prefixes 之后注入命令工具环境（LLD-CR053 §5）。
    // 只影响本次新启动的子进程；进行中的会话不受影响。codex/grok 与 auto 均不注入。
    crate::commands::shell::inject_shell_env(cli_id, shell_setting.as_ref(), &mut cmd);

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    spawn_cmd(&mut cmd);
    cmd.spawn().map_err(|e| format!("CLI 启动失败（{}）：{}", cli_id, e))
}

async fn write_stdin(child: &mut Child, prompt: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    // take 出写端，写完直接 drop 关闭管道：tokio 的 shutdown() 在 Windows 上
    // 不会关闭句柄，子进程将一直等待 EOF（已用独立 example 复现并验证 drop 方案）。
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        drop(stdin);
    }
    Ok(())
}

fn retry_reason(fail: &StreamFailure) -> Option<&'static str> {
    let text = format!("{}\n{}", fail.message, fail.stderr).to_ascii_lowercase();
    if text.contains("429") || text.contains("rate limit") || text.contains("too many requests") || text.contains("resource exhausted") {
        return Some("供应商限流 429");
    }
    if text.contains("502") || text.contains("503") || text.contains("504") || text.contains("temporarily unavailable") || text.contains("service unavailable") {
        return Some("供应商暂时不可用");
    }
    None
}

async fn run_cli_stream(
    mut child: Child,
    mut abort_rx: watch::Receiver<bool>,
    cli_id: &str,
    prompt: &str,
    session_id: &str,
    channel: &tauri::ipc::Channel<serde_json::Value>,
) -> Result<StreamOutcome, StreamFailure> {
    if *abort_rx.borrow() {
        let _ = child.kill().await;
        return Ok(StreamOutcome { assistant_text: "[已停止]".into(), aborted: true, ..Default::default() });
    }
    let timeout_secs = if std::env::var_os("SMOKE_MOCKBIN").is_some() { 20 } else { 30 * 60 };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    tokio::select! {
        result = write_stdin(&mut child, prompt) => {
            result.map_err(|e| StreamFailure { message: e, stderr: String::new(), timed_out: false })?;
        }
        _ = abort_rx.changed() => {
            let _ = child.kill().await;
            return Ok(StreamOutcome { assistant_text: "[已停止]".into(), aborted: true, ..Default::default() });
        }
        _ = tokio::time::sleep_until(deadline) => {
            let _ = child.kill().await;
            return Err(StreamFailure { message: "CLI 执行超时".into(), stderr: String::new(), timed_out: true });
        }
    }
    let mut stdout = tokio::io::BufReader::new(
        child
            .stdout
            .take()
            .ok_or(StreamFailure { message: "CLI 输出管道不可用".into(), stderr: String::new(), timed_out: false })?,
    );
    let stderr_shared = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        use tokio::io::AsyncReadExt;
        let sink = stderr_shared.clone();
        let mut buf = vec![0u8; 8192];
        // 后台收集 stderr（失败时用于诊断）
        tokio::spawn(async move {
            loop {
                match err.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut sink = sink.lock().unwrap();
                        if sink.len() < 16000 {
                            sink.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                    }
                }
            }
        });
    }

    let mut out = StreamOutcome::default();
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    let mut aborted = false;
    let mut timed_out = false;
    loop {
        line.clear();
        if *abort_rx.borrow() {
            aborted = true;
            let _ = child.kill().await;
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                timed_out = true;
                let _ = child.kill().await;
                break;
            }
            _ = abort_rx.changed() => {
                if *abort_rx.borrow() {
                    aborted = true;
                    let _ = child.kill().await;
                    break;
                }
            }
            n = stdout.read_line(&mut line) => {
                match n {
                    Ok(0) => {
                        #[cfg(debug_assertions)]
                        eprintln!("[chat] stdout EOF（子进程关闭输出）");
                        break;
                    }
                    Err(e) => {
                        #[cfg(debug_assertions)]
                        eprintln!("[chat] stdout 读错误: {e}");
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        // 不记录原始 JSONL：其中可能包含正文、工具输入与密钥。
                        if trimmed.is_empty() { continue; }
                        let v: serde_json::Value = match serde_json::from_str(trimmed) {
                            Ok(v) => v,
                            Err(_) => continue, // 容忍非 JSON 行
                        };
                        parse_cli_line(&v, cli_id, &mut out, channel);
                    }
                }
            }
        }
    }
    if aborted {
        out.assistant_text.push_str("\n\n[已停止]");
        out.aborted = true;
        return Ok(out);
    }
    if timed_out { return Err(StreamFailure { message: "CLI 执行超时，未将部分输出标为成功".into(), stderr: String::new(), timed_out: true }); }
    // 等待退出码；不把 stderr（可能含凭证或私有正文）返回到 UI，仅用于适配器报错特征识别。
    let _ = session_id;
    #[cfg(debug_assertions)]
    eprintln!(
        "[chat] 流结束 assistant_len={} tool_uses={} emitted_ref={}",
        out.assistant_text.len(),
        out.tool_uses.len(),
        out.emitted_ref.as_deref().map(crate::commands::chat_binding::fingerprint_ref).unwrap_or_else(|| "none".into())
    );
    let status = tokio::select! {
        status = child.wait() => status.map_err(|_| StreamFailure { message: "CLI 等待退出失败".into(), stderr: String::new(), timed_out: false })?,
        _ = abort_rx.changed() => {
            let _ = child.kill().await;
            out.assistant_text.push_str("\n\n[已停止]");
            out.aborted = true;
            return Ok(out);
        }
        _ = tokio::time::sleep_until(deadline) => {
            let _ = child.kill().await;
            return Err(StreamFailure { message: "CLI 执行超时".into(), stderr: String::new(), timed_out: true });
        }
    };
    if status.success() {
        Ok(out)
    } else {
        Err(StreamFailure {
            message: format!("CLI 退出码 {}，执行未成功", status.code().unwrap_or(-1)),
            stderr: stderr_shared.lock().unwrap().clone(),
            timed_out: false,
        })
    }
}

/// 解析单行 CLI 输出并推送事件（claude stream-json / codex exec --json / 通用回退）。
fn parse_cli_line(
    v: &serde_json::Value,
    cli_id: &str,
    out: &mut StreamOutcome,
    channel: &tauri::ipc::Channel<serde_json::Value>,
) {
    let send = |c: &tauri::ipc::Channel<serde_json::Value>, ev: serde_json::Value| {
        let _ = c.send(ev);
    };
    let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match (cli_id, typ) {
        // ---------- claude stream-json ----------
        (_, "system") => {
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                out.emitted_ref = Some(sid.to_string());
            }
        }
        (_, "stream_event") => {
            let ev = v.get("event").cloned().unwrap_or(serde_json::Value::Null);
            let et = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if et == "content_block_delta" {
                let delta = ev.get("delta").cloned().unwrap_or(serde_json::Value::Null);
                let dt = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if dt == "text_delta" {
                    let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    out.mark_content();
                    out.assistant_text.push_str(text);
                    send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                } else if dt == "thinking_delta" {
                    let text = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    out.mark_thinking();
                    out.thinking_text.push_str(text);
                    send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                }
            }
        }
        (_, "assistant") => {
            let msg = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                out.emitted_ref = Some(sid.to_string());
            }
            if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                for b in blocks {
                    let bt = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match bt {
                        "text" => {
                            let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !text.is_empty() && !out.assistant_text.contains(text) {
                                out.assistant_text.push_str(text);
                                send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                            }
                        }
                        "tool_use" => {
                            let tid = b.get("id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            let name = b.get("name").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            let input = b.get("input").cloned().unwrap_or(serde_json::json!({}));
                            out.tool_uses.push((tid.clone(), name.clone(), input.to_string()));
                            send(channel, serde_json::json!({ "type": "toolUse", "toolId": tid, "name": name, "inputJson": input.to_string() }));
                        }
                        _ => {}
                    }
                }
            }
            if let Some(u) = msg.get("usage") {
                out.usage = Some(extract_usage(u));
                if let Some((i, o, c)) = out.usage {
                    send(channel, serde_json::json!({ "type": "usage", "inputTokens": i, "outputTokens": o, "cacheReadTokens": c }));
                }
            }
        }
        (_, "user") => {
            if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let tid = b.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                        let is_err = b.get("is_error").and_then(|t| t.as_bool()).unwrap_or(false);
                        let content = extract_content_text(b.get("content"));
                        out.tool_results.push((tid.clone(), content.clone(), is_err));
                        send(channel, serde_json::json!({ "type": "toolResult", "toolId": tid, "content": content, "isError": is_err }));
                    }
                }
            }
        }
        (_, "result") => {
            if let Some(u) = v.get("usage") {
                out.usage = Some(extract_usage(u));
            }
            // CR-037：exit 0 不可信；result.is_error 才是 API 失败轮的判定依据。
            if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
                out.is_error = true;
            }
            if out.assistant_text.is_empty() {
                if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                    out.mark_content();
                    out.assistant_text = r.to_string();
                    send(channel, serde_json::json!({ "type": "delta", "delta": r }));
                }
            }
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                out.emitted_ref = Some(sid.to_string());
            }
        }
        // ---------- codex exec --json ----------
        (_, "item.completed") | (_, "item.updated") => {
            let item = v.get("item").cloned().unwrap_or(serde_json::Value::Null);
            let it = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match it {
                "agent_message" => {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !text.is_empty() && !out.assistant_text.contains(text) {
                        out.mark_content();
                        out.assistant_text.push_str(text);
                        send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                    }
                }
                "reasoning" => {
                    let text = item
                        .get("text")
                        .or_else(|| item.pointer("/summary/0/text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if !text.is_empty() {
                        out.mark_thinking();
                        out.thinking_text.push_str(text);
                        send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                    }
                }
                "command_execution" => {
                    let cmdstr = item.get("command").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let tid = item.get("id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    out.tool_uses.push((tid.clone(), "shell".into(), serde_json::json!({ "command": cmdstr }).to_string()));
                    send(channel, serde_json::json!({ "type": "toolUse", "toolId": tid, "name": "shell", "inputJson": serde_json::json!({ "command": cmdstr }).to_string() }));
                }
                _ => {}
            }
        }
        (_, "turn.completed") | (_, "thread.completed") => {
            if let Some(u) = v.get("usage") {
                out.usage = Some(extract_usage(u));
                if let Some((i, o, c)) = out.usage {
                    send(channel, serde_json::json!({ "type": "usage", "inputTokens": i, "outputTokens": o, "cacheReadTokens": c }));
                }
            }
        }
        (_, "thread.started") => {
            if let Some(tid) = v.get("thread_id").and_then(|t| t.as_str()) {
                out.emitted_ref = Some(tid.to_string());
            }
        }
        (_, "error") => {
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("未知错误");
            send(channel, serde_json::json!({ "type": "error", "message": msg }));
        }
        // ---------- 通用回退 ----------
        _ => {
            if let Some(text) = v.get("text").or_else(|| v.get("content")).and_then(|t| t.as_str()) {
                if !text.is_empty() && typ != "user" {
                    out.mark_content();
                    out.assistant_text.push_str(text);
                    send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                }
            }
        }
    }
}

fn extract_usage(u: &serde_json::Value) -> (i64, i64, i64) {
    let input = u
        .get("input_tokens")
        .or_else(|| u.get("inputTokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let output = u
        .get("output_tokens")
        .or_else(|| u.get("outputTokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let cache = u
        .get("cache_read_input_tokens")
        .or_else(|| u.get("cached_input_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    (input, output, cache)
}

fn extract_content_text(c: Option<&serde_json::Value>) -> String {
    match c {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| b.as_str().map(|s| s.to_string()))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// 消息落库（无事务）：由 persist_assistant_with_conn 或结算事务复用，禁止嵌套开事务。
fn insert_assistant_messages(conn: &rusqlite::Connection, session_id: &str, out: &StreamOutcome) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    if !out.assistant_text.trim().is_empty() || !out.thinking_text.trim().is_empty() {
        let mut meta = serde_json::json!({
            "thinking": out.thinking_text,
            "usage": out.usage.map(|(i,o,c)| serde_json::json!({"inputTokens":i,"outputTokens":o,"cacheReadTokens":c})),
        });
        // CR-056：思考阶段耗时只在真的记录到思考内容时写入，避免给出 0 秒的假时长。
        if out.thinking_ms > 0 && !out.thinking_text.trim().is_empty() {
            meta["thinkingMs"] = serde_json::json!(out.thinking_ms);
        }
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES (?1,?2,'assistant',?3,?4,?5)",
            rusqlite::params![new_id("msg"), session_id, out.assistant_text, meta.to_string(), now],
        )?;
    }
    for (tid, name, input) in &out.tool_uses {
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES (?1,?2,'tool_use',?3,?4,?5)",
            rusqlite::params![new_id("msg"),session_id,name,serde_json::json!({"toolId":tid,"input":input}).to_string(),now],
        )?;
    }
    for (tid, content, is_error) in &out.tool_results {
        conn.execute(
            "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES (?1,?2,'tool_result',?3,?4,?5)",
            rusqlite::params![new_id("msg"),session_id,content,serde_json::json!({"toolId":tid,"isError":is_error}).to_string(),now],
        )?;
    }
    conn.execute("UPDATE session SET updatedAt=?2 WHERE id=?1", rusqlite::params![session_id,now])?;
    Ok(())
}

/// 独立事务版消息落库（现仅测试与回退路径使用；流式结算走 insert_assistant_messages）。
#[cfg_attr(not(test), allow(dead_code))]
fn persist_assistant_with_conn(conn: &rusqlite::Connection, session_id: &str, out: &StreamOutcome) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|e| {
            eprintln!("[chat] 回复保存失败（开事务）：{e}");
            format!("回复保存失败，流式内容保留但未持久化（{e}）")
        })?;
    insert_assistant_messages(&transaction, session_id, out).map_err(|e| {
        eprintln!("[chat] 回复保存失败：{e}");
        format!("回复保存失败，流式内容保留但未持久化（{e}）")
    })?;
    transaction.commit().map_err(|e| {
        eprintln!("[chat] 回复保存失败（提交）：{e}");
        format!("回复保存失败，流式内容保留但未持久化（{e}）")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_persistence_is_atomic_and_reports_failure() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,updatedAt INTEGER); INSERT INTO session VALUES('s',1); CREATE TABLE message(id TEXT,sessionId TEXT,role TEXT,content TEXT,metaJson TEXT,createdAt INTEGER); CREATE TRIGGER reject_tool BEFORE INSERT ON message WHEN NEW.role='tool_result' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        let mut out = StreamOutcome::default();
        out.assistant_text = "reply".into();
        out.tool_results.push(("t".into(),"result".into(),false));
        assert!(persist_assistant_with_conn(&conn,"s",&out).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM message",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT updatedAt FROM session WHERE id='s'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        conn.execute_batch("DROP TRIGGER reject_tool;").unwrap();
        persist_assistant_with_conn(&conn,"s",&out).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM message",[],|row|row.get::<_,i64>(0)).unwrap(),2);
    }

    fn entry(id: &str) -> RunningEntry {
        let (abort, _) = watch::channel(false);
        RunningEntry { turn_id: id.into(), abort }
    }

    /// CR-047：执行会话只接受本项目、父项为Epic的Feature；普通会话不绑定。
    fn feature_fixture() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE requirement_index(projectId TEXT, entityId TEXT, type TEXT, parentId TEXT, title TEXT, contentHash TEXT);
             INSERT INTO requirement_index VALUES
               ('p1','EPIC-01','epic',NULL,'史诗','h-e'),
               ('p1','FEAT-011','feature','EPIC-01','预约主流程','h-f'),
               ('p1','STORY-0101','story','FEAT-011','故事','h-s'),
               ('p1','FEAT-ORPHAN','feature',NULL,'孤立特性','h-o')
             ;",
        ).unwrap();
        conn
    }

    #[test]
    fn execution_feature_accepts_only_project_feature_with_epic_parent() {
        let conn = feature_fixture();
        assert!(resolve_execution_feature(&conn, None, None).unwrap().feature_id.is_none());
        let ok = resolve_execution_feature(&conn, Some("p1"), Some("FEAT-011")).unwrap();
        assert_eq!(ok.feature_id.as_deref(), Some("FEAT-011"));
        assert_eq!(ok.feature_title.as_deref(), Some("预约主流程"));
        assert_eq!(ok.feature_source_hash.as_deref(), Some("h-f"));
    }

    #[test]
    fn execution_feature_rejects_non_feature_missing_project_and_broken_parent() {        let conn = feature_fixture();
        assert!(resolve_execution_feature(&conn, Some("p1"), Some("STORY-0101")).unwrap_err().contains("不是特性"));
        assert!(resolve_execution_feature(&conn, Some("p1"), Some("EPIC-01")).unwrap_err().contains("不是特性"));
        assert!(resolve_execution_feature(&conn, None, Some("FEAT-011")).unwrap_err().contains("必须指定所属项目"));
        assert!(resolve_execution_feature(&conn, Some("p2"), Some("FEAT-011")).unwrap_err().contains("不属于该项目"));
        assert!(resolve_execution_feature(&conn, Some("p1"), Some("FEAT-ORPHAN")).unwrap_err().contains("缺少所属Epic"));
    }

    #[test]
    fn busy_registry_rejects_duplicate_send_and_stale_cleanup() {
        let mut running = BTreeMap::new();
        insert_turn(&mut running, "sid", entry("old")).unwrap();
        assert!(insert_turn(&mut running, "sid", entry("second")).is_err());
        assert_eq!(running["sid"].turn_id, "old");
        release_turn(&mut running, "sid", "old");
        insert_turn(&mut running, "sid", entry("new")).unwrap();
        release_turn(&mut running, "sid", "old");
        assert_eq!(running["sid"].turn_id, "new");
    }

    #[test]
    fn failed_launch_scope_releases_only_its_own_turn() {
        let sid = new_id("unit-session");
        RUNNING.lock().unwrap().insert(sid.clone(), entry("turn"));
        let result: Result<(), String> = (|| {
            let _turn = RunningTurn { session_id: sid.clone(), turn_id: "turn".into() };
            Err("spawn failed".into())
        })();
        assert!(result.is_err());
        assert!(!chat_status(sid));
    }

    #[test]
    fn permission_none_is_legacy_and_unsupported_modes_never_upgrade() {
        assert!(validate_permission("grok", None).is_ok());
        assert!(validate_permission("claude", Some("agent")).is_ok());
        assert!(validate_permission("codex", Some("agent")).is_ok());
        for mode in ["auto", "full", "bypassPermissions", ""] {
            assert!(validate_permission("claude", Some(mode)).is_err());
            assert!(validate_permission("codex", Some(mode)).is_err());
        }
        assert!(validate_permission("grok", Some("agent")).is_err());
        assert!(validate_permission("unknown", None).is_err());
        let payload: SendPayload = serde_json::from_str(r#"{"sessionId":"s","content":"x","refs":[],"attachments":[]}"#).unwrap();
        assert!(payload.permission_id.is_none());
    }

    #[test]
    fn office_snapshot_requires_matching_work_project_and_bounded_content() {
        assert!(validate_office_ref(Some("p1"), Some("work"), "office:OFF-p1-1", Some("text")).is_ok());
        assert!(validate_office_ref(None, Some("work"), "office:OFF-p1-1", None).is_err());
        assert!(validate_office_ref(Some("p2"), Some("work"), "office:OFF-p1-1", None).is_err());
        assert!(validate_office_ref(Some("p1"), Some("code"), "office:OFF-p1-1", None).is_err());
        assert!(validate_office_ref(Some("p1"), Some("work"), "office:OFF-p1-../x", None).is_err());
        assert!(validate_office_ref(Some("p1"), Some("work"), "office:OFF-p1-1", Some(&"x".repeat(MAX_REF_TEXT + 1))).is_err());
    }

    #[test]
    fn file_reference_cannot_escape_or_bypass_overlapping_knowledge_grants() {
        let base = std::env::temp_dir().join(new_id("file-ref-test"));
        let root = base.join("project");
        let knowledge = root.join("knowledge");
        std::fs::create_dir_all(&knowledge).unwrap();
        std::fs::write(root.join("source.txt"), "public").unwrap();
        std::fs::write(knowledge.join("private.md"), "private").unwrap();
        std::fs::write(base.join("outside.txt"), "outside").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE knowledge_library(id TEXT,sourceRef TEXT,enabled INTEGER);
            CREATE TABLE project_library_grant(projectId TEXT,libraryId TEXT,readAllowed INTEGER);").unwrap();
        conn.execute("INSERT INTO knowledge_library VALUES('k',?1,1)", [knowledge.to_string_lossy().as_ref()]).unwrap();
        assert!(checked_file_ref(&conn, "p", &root, "source.txt").is_ok());
        assert!(checked_file_ref(&conn, "p", &root, "../outside.txt").is_err());
        assert!(checked_file_ref(&conn, "p", &root, "knowledge/private.md").is_err());
        conn.execute("INSERT INTO project_library_grant VALUES('p','k',1)", []).unwrap();
        assert!(checked_file_ref(&conn, "p", &root, "knowledge/private.md").is_ok());
        conn.execute("UPDATE knowledge_library SET enabled=0", []).unwrap();
        assert!(checked_file_ref(&conn, "p", &root, "knowledge/private.md").is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn prompt_limits_and_attributes_are_checked() {
        assert!(check_prompt_size(&["x".repeat(MAX_PROMPT_TEXT + 1)]).is_err());
        assert_eq!(xml_attribute("\"<x>&"), "&quot;&lt;x&gt;&amp;");
    }
}
