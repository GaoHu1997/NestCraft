//! AI 会话：CLI 适配器（spawn claude/codex/grok 非交互模式）+ 会话/消息持久化 + 流式事件。
//!
//! 桥接协议对照 jetbrains-cc-gui 的 ai-bridge（见 docs/tmp/ref-analysis-jetbrains-cc-gui.md）：
//! - claude：`claude -p --output-format stream-json --verbose --include-partial-messages`
//!   stdout JSONL：system/assistant/user/result；stream_event 携带增量
//! - codex：`codex exec --json -m <model>`，`-c model_reasoning_effort="<effort>"`
//! - grok（CR-064/BUG-002）：stdin prompt + `--output-format streaming-json`，
//!   `[--reasoning-effort <effort>]`；1.0.x 无 `--print`/`--json` 参数（实测报错）
//!
//! 运行快照语义（CR-012）：会话开始时锁定 cli/model/effort；运行中禁止原地切换。

use crate::db;
use crate::models::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};
use tokio::sync::watch;

#[path = "chat_stats.rs"]
pub(crate) mod stats;

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

pub(crate) struct RunningTurn { session_id: String, turn_id: String }
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

pub(crate) fn reserve_turn(session_id: &str) -> Result<(RunningTurn, watch::Receiver<bool>), String> {
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
pub(crate) struct FeatureBinding {
    pub feature_id: Option<String>,
    pub feature_title: Option<String>,
    pub feature_source_hash: Option<String>,
}

/// CR-047：执行会话必须绑定本项目中可解析的唯一Feature；普通会话保持无Feature。
pub(crate) fn resolve_execution_feature(conn: &rusqlite::Connection, project_id: Option<&str>, feature_id: Option<&str>) -> Result<FeatureBinding, String> {
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
    // BUG-003：绑定派生必须按运行通道分流；runner 列与 SessionMeta.runner 同源（下标 23）。
    let cli_id: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
    let runner: String = row.get::<_, Option<String>>(23)?.unwrap_or_else(|| "cli".into());
    let binding = crate::commands::chat_binding::derive_view(
        &session_role,
        &runner,
        cli_id.as_str(),
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
        pinned_at: row.get(22)?,
        // CR-069：会话运行通道；列序见 SESSION_COLUMNS（pinnedAt=22，runner=23）。
        runner,
    })
}

const SESSION_COLUMNS: &str = "s.id, s.projectId, s.serverId, s.title, s.cliId, s.providerId, s.modelId, s.effort, s.draft, s.unread, s.createdAt, s.updatedAt, (SELECT COUNT(*) FROM message m WHERE m.sessionId = s.id) AS cnt, s.featureId, s.featureTitle, s.featureSourceHash, s.sessionRole, \
    s.nativeThreadRef, s.nativeBindingRevision, s.nativeConfirmedTurnId, \
    (SELECT t.outcome FROM execution_session_turn t WHERE t.sessionId = s.id ORDER BY t.createdAt DESC, t.rowid DESC LIMIT 1), \
    (SELECT t.reasonCode FROM execution_session_turn t WHERE t.sessionId = s.id ORDER BY t.createdAt DESC, t.rowid DESC LIMIT 1), \
    s.pinnedAt, s.runner";

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

/// CR-063：会话历史每批默认条数与上限。
const SESSION_PAGE_DEFAULT: i64 = 20;
const SESSION_PAGE_MAX: i64 = 100;

/// CR-063：LIKE 关键词转义，避免 % / _ / \ 被当作通配符。
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '%' => out.push_str("\\%"),
            '_' => out.push_str("\\_"),
            _ => out.push(ch),
        }
    }
    out
}

/// CR-063：会话历史游标分页 + 当前作用域标题搜索。
/// 作用域与 `ChatPanel.filterSessions` 逐分支一致；游标为 (updatedAt, id) 键集，避免 OFFSET 漂移。
#[tauri::command]
pub fn chat_sessions_page(
    project_id: Option<String>,
    server_id: Option<String>,
    keyword: Option<String>,
    cursor_pinned_at: Option<i64>,
    cursor_updated_at: Option<i64>,
    cursor_id: Option<String>,
    limit: Option<i64>,
) -> Result<SessionPage, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;

    let cursor = match (cursor_pinned_at, cursor_updated_at, cursor_id) {
        (None, None, None) => None,
        (Some(pinned_at), Some(updated_at), Some(id)) => Some((pinned_at, updated_at, id)),
        _ => return Err("分页游标不完整".into()),
    };
    let keyword = keyword
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());

    sessions_page_query(
        conn,
        project_id.as_deref(),
        server_id.as_deref(),
        keyword.as_deref(),
        cursor,
        limit,
    )
}

/// CR-063/CR-065：分页查询主体（命令与单测共用）。
pub(crate) fn sessions_page_query(
    conn: &rusqlite::Connection,
    project_id: Option<&str>,
    server_id: Option<&str>,
    keyword: Option<&str>,
    cursor: Option<(i64, i64, String)>,
    limit: Option<i64>,
) -> Result<SessionPage, String> {
    use rusqlite::types::Value;

    let limit = limit.unwrap_or(SESSION_PAGE_DEFAULT).clamp(1, SESSION_PAGE_MAX);
    // 纯空白等价于无关键词（命令层已 trim，这里再防御一次，便于单测直接调用）。
    let keyword = keyword.map(str::trim).filter(|k| !k.is_empty());

    let (scope_sql, scope_params): (&str, Vec<Value>) = match (project_id, server_id) {
        (Some(p), Some(s)) => ("s.projectId = ? AND s.serverId = ?", vec![Value::Text(p.into()), Value::Text(s.into())]),
        (Some(p), None) => ("s.projectId = ?", vec![Value::Text(p.into())]),
        (None, Some(s)) => ("s.serverId = ?", vec![Value::Text(s.into())]),
        (None, None) => ("s.projectId IS NULL AND s.serverId IS NULL", vec![]),
    };

    let mut where_sql = scope_sql.to_string();
    let mut where_params = scope_params;
    if let Some(kw) = keyword {
        where_sql.push_str(" AND s.title LIKE ? ESCAPE '\\'");
        where_params.push(Value::Text(format!("%{}%", escape_like(kw))));
    }

    // 单连接 + Mutex 串行：两条查询之间没有并发写插入，total 与 items 同源。
    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM session s WHERE {where_sql}");
        conn.query_row(&sql, rusqlite::params_from_iter(where_params.iter()), |row| row.get(0))
            .map_err(|e| e.to_string())?
    };

    let mut list_sql = format!("SELECT {} FROM session s WHERE {where_sql}", SESSION_COLUMNS);
    let mut list_params = where_params;
    if let Some((pinned_at, updated_at, id)) = &cursor {
        list_sql.push_str(" AND (s.pinnedAt < ? OR (s.pinnedAt = ? AND s.updatedAt < ?) OR (s.pinnedAt = ? AND s.updatedAt = ? AND s.id < ?))");
        list_params.push(Value::Integer(*pinned_at));
        list_params.push(Value::Integer(*pinned_at));
        list_params.push(Value::Integer(*updated_at));
        list_params.push(Value::Integer(*pinned_at));
        list_params.push(Value::Integer(*updated_at));
        list_params.push(Value::Text(id.clone()));
    }
    list_sql.push_str(" ORDER BY s.pinnedAt DESC, s.updatedAt DESC, s.id DESC LIMIT ?");
    list_params.push(Value::Integer(limit + 1));

    let mut stmt = conn.prepare(&list_sql).map_err(|e| e.to_string())?;
    let mut items: Vec<SessionMeta> = stmt
        .query_map(rusqlite::params_from_iter(list_params.iter()), session_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let has_more = items.len() as i64 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        items.last().map(|s| SessionCursor {
            pinned_at: s.pinned_at,
            updated_at: s.updated_at,
            id: s.id.clone(),
        })
    } else {
        None
    };

    Ok(SessionPage { items, total, has_more, next_cursor })
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
    runner: Option<String>,
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
        // CR-069：默认必须是 cli——平台通道是显式选择，不得改变所有既有会话行为。
        let runner = match runner.as_deref() {
            None | Some("") => "cli",
            Some("cli") => "cli",
            Some("platform") => "platform",
            Some(other) => return Err(format!("未知会话运行通道：{other}")),
        };
        conn.execute(
            "INSERT INTO session (id, projectId, serverId, title, cliId, providerId, modelId, effort, draft, createdAt, updatedAt, featureId, featureTitle, featureSourceHash, sessionRole, runner)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9,?9,?10,?11,?12,?13,?14)",
            rusqlite::params![id, project_id, server_id, title, cli_id, provider_id, model_id, effort, now, binding.feature_id, binding.feature_title, binding.feature_source_hash, role, runner],
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
    runner: Option<String>,
) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
    // 运行中禁止修改执行配置（运行快照锁定）
    if running.contains_key(&id)
        && (cli_id.is_some() || provider_id.is_some() || model_id.is_some() || effort.is_some() || runner.is_some())
    {
        return Err("会话运行中或有待审操作，禁止修改执行配置".into());
    }
    // CR-069：只有在会话没有消息且未运行时才允许切换运行通道。中途切换会让上下文
    // 格式与续接语义完全不同（CLI 有原生线程引用，平台通道没有），混合状态无法保证一致。
    if let Some(next) = runner.as_deref() {
        let msg_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message WHERE sessionId=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if msg_count > 0 {
            return Err("已有消息的会话不能切换运行通道；请新建会话".into());
        }
        if running.contains_key(&id) {
            return Err("会话正在运行，不能切换运行通道".into());
        }
        match next {
            "cli" | "platform" => {}
            other => return Err(format!("未知会话运行通道：{other}")),
        }
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
            unread = COALESCE(?9, unread),
            runner = COALESCE(?10, runner)
         WHERE id = ?1",
        rusqlite::params![id, now_ms(), title, draft, cli_id, provider_id, model_id, effort, unread, runner],
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

/// CR-065：置顶/取消置顶。只改 pinnedAt，不动 updatedAt（置顶不是内容更新）。
///
/// 注意：`db::conn()` 是全局不可重入 `Mutex`，持锁期间不得调用任何自己会
/// `db::conn()` 的命令（如 `chat_session_get`），否则同线程二次加锁会永久死锁。
/// 因此写操作先用块作用域释放 guard，再单独读取回执。
#[tauri::command]
pub fn chat_session_pin(id: String, pinned: bool) -> Result<SessionMeta, String> {
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let value = if pinned { now_ms() } else { 0 };
        let changed = conn
            .execute("UPDATE session SET pinnedAt=?1 WHERE id=?2", rusqlite::params![value, &id])
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("会话不存在".into());
        }
    }
    chat_session_get(id)
}

/// CR-065：分叉会话——复制元信息与消息上下文，不继承原生线程绑定。
/// 同上：先释放 guard 再读回执，避免 `db::conn()` 重入死锁。
#[tauri::command]
pub fn chat_session_fork(id: String) -> Result<SessionMeta, String> {
    let new_session_id = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        {
            let running = RUNNING.lock().map_err(|_| "会话运行状态不可用".to_string())?;
            if running.contains_key(&id) {
                return Err("会话正在运行，结束或停止后再分叉".into());
            }
        }
        fork_session(conn, &id)?
    };
    chat_session_get(new_session_id)
}

/// CR-065：分叉实现（命令与单测共用）。复制元信息与消息，不继承原生线程绑定。
fn fork_session(conn: &rusqlite::Connection, id: &str) -> Result<String, String> {
    let (role, project_id, server_id, cli_id, provider_id, model_id, effort, title, feature_id, feature_title, feature_hash): (
        String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>, Option<String>, Option<String>,
    ) = conn
        .query_row(
            "SELECT sessionRole, projectId, serverId, cliId, providerId, modelId, effort, title, featureId, featureTitle, featureSourceHash FROM session WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?)),
        )
        .map_err(|_| "会话不存在".to_string())?;
    if role != "ordinary" {
        return Err("执行会话暂不支持分叉".into());
    }

    let new_session_id = new_id("sess");
    let now = now_ms();
    let forked_title = format!("分叉 · {title}");

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO session (id, projectId, serverId, title, cliId, providerId, modelId, effort, draft, unread, createdAt, updatedAt, featureId, featureTitle, featureSourceHash, sessionRole, nativeBindingRevision)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',NULL,?9,?9,?10,?11,?12,'ordinary',0)",
        rusqlite::params![&new_session_id, project_id, server_id, forked_title, cli_id, provider_id, model_id, effort, now, feature_id, feature_title, feature_hash],
    )
    .map_err(|e| e.to_string())?;

    {
        let mut stmt = tx
            .prepare("SELECT role, content, metaJson, refsJson, gitContextJson, createdAt FROM message WHERE sessionId=?1 ORDER BY createdAt, rowid")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, i64)> = stmt
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for (role, content, meta_json, refs_json, git_json, created_at) in rows {
            tx.execute(
                "INSERT INTO message (id, sessionId, role, content, metaJson, refsJson, gitContextJson, createdAt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                rusqlite::params![new_id("msg"), &new_session_id, role, content, meta_json, refs_json, git_json, created_at],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(new_session_id)
}

#[tauri::command]
pub fn chat_messages(session_id: String) -> Result<Vec<ChatMessage>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, sessionId, role, content, metaJson, refsJson, gitContextJson, createdAt FROM message WHERE sessionId=?1 ORDER BY createdAt, rowid")
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
    // CR-069：平台通道分流。必须在任何 CLI 校验之前判定；runner=cli 走下方既有实现，一行不改。
    // 注意：DB 连接守卫必须在 await 前释放（MutexGuard 非 Send）。
    let is_platform = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        let runner: Option<String> = conn
            .query_row("SELECT runner FROM session WHERE id=?1", [&payload.session_id], |r| r.get(0))
            .map_err(|_| "会话不存在".to_string())?;
        runner.as_deref().unwrap_or("cli") == "platform"
    };
    if is_platform {
        if payload.attachments.iter().any(|a| a.image_base64.is_some()) {
            return Err("平台模型通道暂不支持发送图片".into());
        }
        return crate::commands::platform_agent::send_platform(app, payload, channel).await;
    }
    let session_id = payload.session_id.clone();
    let (running_turn, abort_rx) = reserve_turn(&session_id)?;
    // 会话与执行配置
    let session = chat_session_get(session_id.clone())?;
    let cli_id = session.cli_id.clone().ok_or("会话未选择 CLI")?;
    let mut model_id = session.model_id.clone().unwrap_or_default();
    let mut effort = session.effort.clone().unwrap_or_default();
    // CR-059 D3：任务模型路由在派发链路消费。只在会话未显式锁定模型时按任务类型改派，
    // 且失败一律沿用会话选择——路由配置损坏不得阻断发送。
    if model_id.trim().is_empty() {
        if let Ok(guard) = db::conn() {
            if let Some(conn) = guard.as_ref() {
                let table = route_table_for_cli(conn, &cli_id);
                let task_types = detect_task_types(&payload.content);
                let (routed_model, routed_effort, _why) =
                    resolve_route(&table, &task_types, &model_id, &effort);
                if !routed_model.trim().is_empty() {
                    model_id = routed_model;
                    effort = routed_effort;
                }
            }
        }
    }
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
    // CR-065：grok 的 MCP 配置需要落到会话工作目录（.grok/config.toml），因此传入 project_root。
    let mut dispatch = DispatchHolder(crate::commands::dispatch::resolve(
        &app, &cli_id, &session_id, session.provider_id.as_deref(), &model_id, &effort,
        session.project_id.as_deref(),
        project_root.as_deref().map(std::path::Path::new),
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
    let images = CliImages::prepare(&cli_id, &payload.attachments)?;
    let child = spawn_cli(&cli_id, &model_id, &effort, project_root.as_deref(), dispatch.0.as_ref(), permission_id.as_deref(), requested_resume.as_deref(), &images.paths)?;

    // 持久化用户消息
    let msg_id = new_id("msg");
    {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        tx_debug(conn, "before-user-msg");
        conn.execute(
            "INSERT INTO message (id, sessionId, role, content, refsJson, createdAt, metaJson) VALUES (?1,?2,'user',?3,?4,?5,?6)",
            rusqlite::params![
                msg_id,
                session_id,
                payload.content,
                serde_json::to_string(&payload.refs).ok(),
                now_ms(),
                (!payload.attachments.is_empty()).then(|| serde_json::json!({"attachments": payload.attachments}).to_string())
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
        let images = images;
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
                    match spawn_cli(&cli_id2, &model_id, &effort, project_root.as_deref(), _dispatch_holder.0.as_ref(), permission_id.as_deref(), requested_resume.as_deref(), &images.paths) {
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
        // 未读状态（B 方案）：按本轮结果写 session.unread——正常成功→success、失败(is_error)→failed；
        // 用户停止(aborted)与持久化失败(settle=None)不改写，避免把「你正在看/主动停止」的轮次标成未读。
        let unread: Option<&str> = match (&result, &settle) {
            (Ok(out), Some(_)) if !out.aborted => Some(if out.is_error { "failed" } else { "success" }),
            (Err(_), _) => Some("failed"),
            _ => None,
        };
        if let Some(u) = unread { set_session_unread(&session_id2, u); }
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

// ---------- CR-059 D3：CLI 任务模型路由在派发链路的消费 ----------

/// 13 类任务类型（与 UI-CR059 词表一致；派发侧只做匹配，不新增分类）。
const TASK_TYPES: [&str; 13] = [
    "仓库探索", "代码定位", "资料检索", "方案核验", "影响分析", "功能开发", "缺陷修复",
    "测试验证", "代码审查", "数据处理", "模块重构", "方案设计", "文档整理",
];

/// 路由表的单个模型槽：模型＋思考档位＋适用任务类型。
#[derive(serde::Deserialize)]
struct RouteSlot {
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: String,
    #[serde(default)]
    types: Vec<String>,
}

#[derive(serde::Deserialize, Default)]
struct RouteFallback {
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: String,
}

#[derive(serde::Deserialize, Default)]
struct RouteTable {
    #[serde(default)]
    slots: Vec<RouteSlot>,
    #[serde(default)]
    fallback: RouteFallback,
}

/// 从会话绑定的 CLI 偏好里解析任务模型路由（旧结构无此字段时为空表＝不干预）。
fn route_table_for_cli(conn: &rusqlite::Connection, cli_id: &str) -> RouteTable {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
            [format!("cli.preferences.{cli_id}")],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let Some(raw) = raw else { return RouteTable::default(); };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return RouteTable::default(); };
    // 只取 route 子对象；解不出就当作未配置，绝不让派发因偏好损坏而失败。
    let route = value.get("route").cloned().unwrap_or(value);
    serde_json::from_value::<RouteTable>(route).unwrap_or_default()
}

/// 按任务类型解析要使用的模型与思考档位。
///
/// 规则（CR-059 §4.4）：命中任务类型的第一个模型槽优先；未命中或槽位模型为空时使用兜底；
/// 兜底未配置则沿用会话当前选择。返回 (模型, 档位, 命中说明)，不做静默换模型。
fn resolve_route(
    table: &RouteTable,
    task_types: &[String],
    session_model: &str,
    session_effort: &str,
) -> (String, String, String) {
    if !task_types.is_empty() {
        for slot in &table.slots {
            if slot.model.trim().is_empty() { continue; }
            if slot.types.iter().any(|t| task_types.iter().any(|want| want == t)) {
                let effort = if slot.effort.trim().is_empty() { session_effort.to_string() } else { slot.effort.clone() };
                return (slot.model.clone(), effort, format!("按任务类型 {} 命中模型槽", task_types.join("/")));
            }
        }
    }
    if !table.fallback.model.trim().is_empty() {
        let effort = if table.fallback.effort.trim().is_empty() { session_effort.to_string() } else { table.fallback.effort.clone() };
        return (table.fallback.model.clone(), effort, "未命中模型槽，使用兜底模型".to_string());
    }
    (session_model.to_string(), session_effort.to_string(), "未配置路由，沿用会话选择".to_string())
}

/// 从用户消息里识别任务类型（只做关键词匹配，不做模型推断；识别不到返回空）。
fn detect_task_types(content: &str) -> Vec<String> {
    const KEYWORDS: [(&str, &[&str]); 13] = [
        ("仓库探索", &["探索", "仓库结构", "目录结构", "先看一下项目"]),
        ("代码定位", &["定位", "在哪个文件", "哪一行", "找到实现"]),
        ("资料检索", &["检索", "查一下", "搜索资料", "文档在哪"]),
        ("方案核验", &["核验", "方案是否", "确认方案", "是否符合"]),
        ("影响分析", &["影响分析", "影响范围", "会影响到", "破坏性"]),
        ("功能开发", &["实现", "开发", "新增功能", "加一个", "做一个"]),
        ("缺陷修复", &["修复", "bug", "缺陷", "报错", "崩溃", "不工作"]),
        ("测试验证", &["测试", "验证", "跑一下", "用例", "回归"]),
        ("代码审查", &["审查", "review", "代码质量", "评审代码"]),
        ("数据处理", &["数据", "清洗", "统计", "转换格式"]),
        ("模块重构", &["重构", "拆分模块", "抽出来", "解耦"]),
        ("方案设计", &["设计方案", "架构", "技术方案", "怎么设计"]),
        ("文档整理", &["文档", "整理", "写个说明", "补充说明"]),
    ];
    let lower = content.to_lowercase();
    let mut hits = Vec::new();
    for (name, words) in KEYWORDS {
        if words.iter().any(|word| lower.contains(&word.to_lowercase())) {
            hits.push(name.to_string());
        }
    }
    hits.truncate(3);
    let _ = TASK_TYPES;
    hits
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

pub(crate) fn checked_file_ref(conn: &rusqlite::Connection, project_id: &str, root: &std::path::Path, target: &str) -> Result<std::path::PathBuf, String> {
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
pub(crate) fn build_prompt(app: &tauri::AppHandle, payload: &SendPayload, project_id: Option<&str>) -> Result<String, String> {
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
                let root = crate::storage_layout::category("skills")?;
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
        if att.image_base64.is_some() { continue; }
        parts.push(format!("<attachment name=\"{}\" size=\"{}\" />", xml_attribute(&att.name), att.byte_size.unwrap_or(0)));
    }
    if payload.content.trim().is_empty() && payload.attachments.iter().any(|a| a.image_base64.is_some()) {
        parts.push("请查看随消息发送的图片。".into());
    } else {
        parts.push(payload.content.clone());
    }
    check_prompt_size(&parts)?;
    Ok(parts.join("\n\n"))
}

enum TurnSegment {
    Text(String),
    Thinking(String),
    ToolUse(usize),
    ToolResult(usize, Option<i64>),
    PlanUpdate(Vec<serde_json::Value>),
}

struct ClaudeToolBlock {
    index: u64,
    id: String,
    name: String,
    input: serde_json::Value,
    partial_json: String,
}

pub(crate) struct StreamOutcome {
    claude_streamed: std::collections::HashSet<u64>,
    claude_tool: Option<ClaudeToolBlock>,
    segments: Vec<TurnSegment>,
    command_output: std::collections::HashMap<String, String>,
    pub assistant_text: String,
    pub thinking_text: String,
    pub tool_uses: Vec<(String, String, String)>,  // id, name, input
    pub tool_results: Vec<(String, String, bool)>, // id, content, is_error
    pub usage: Option<(i64, i64, i64)>,
    /// FEAT-012：仅平台真实生成边界；CLI缺协议时不生成该字段。
    pub session_stats: Option<stats::TurnStats>,
    /// 流内适配器上报的线程/会话 id（emittedRef）。仅后端内存使用，不进日志与前端。
    pub emitted_ref: Option<String>,
    /// CR-037：本轮请求的 resume 引用（requestedResume）。
    pub requested_resume: Option<String>,
    /// claude result.is_error：exit 0 不可信，is_error 才能识别 API 失败轮。
    pub is_error: bool,
    /// 途中被停止（写 stdin 阶段或流中）。
    pub aborted: bool,
    /// CR-056：首段 thinking 的时间点，用于统计思考阶段耗时。
    pub thinking_started: Option<std::time::Instant>,
    /// CR-056：思考阶段耗时（毫秒），0 表示尚未确定。落库进 metaJson.thinkingMs。
    pub thinking_ms: u64,
}

impl StreamOutcome {
    pub(crate) fn push_text(&mut self, text: &str) {
        if text.is_empty() { return; }
        self.mark_content();
        self.assistant_text.push_str(text);
        match self.segments.last_mut() {
            Some(TurnSegment::Text(tail)) => tail.push_str(text),
            _ => self.segments.push(TurnSegment::Text(text.into())),
        }
    }

    pub(crate) fn push_thinking(&mut self, text: &str) {
        if text.is_empty() { return; }
        self.mark_thinking();
        self.thinking_text.push_str(text);
        match self.segments.last_mut() {
            Some(TurnSegment::Thinking(tail)) => tail.push_str(text),
            _ => self.segments.push(TurnSegment::Thinking(text.into())),
        }
    }

    pub(crate) fn push_tool_use(&mut self, id: String, name: String, input: String) {
        self.segments.push(TurnSegment::ToolUse(self.tool_uses.len()));
        self.tool_uses.push((id, name, input));
    }

    pub(crate) fn push_tool_result(&mut self, id: String, content: String, is_error: bool, exit_code: Option<i64>) {
        self.segments.push(TurnSegment::ToolResult(self.tool_results.len(), exit_code));
        self.tool_results.push((id, content, is_error));
    }

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
            claude_streamed: Default::default(),
            claude_tool: None,
            segments: vec![],
            command_output: Default::default(),
            assistant_text: String::new(),
            thinking_text: String::new(),
            tool_uses: vec![],
            tool_results: vec![],
            usage: None,
            session_stats: None,
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

struct CliImages {
    directory: Option<std::path::PathBuf>,
    paths: Vec<std::path::PathBuf>,
}

impl CliImages {
    fn prepare(cli: &str, attachments: &[crate::models::AttachmentMeta]) -> Result<Self, String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        const MAX_BYTES: usize = 10 * 1024 * 1024;
        let mut images = Self { directory: None, paths: vec![] };
        let entries: Vec<_> = attachments.iter().filter_map(|a| a.image_base64.as_deref().map(|data| (a, data))).collect();
        if entries.is_empty() { return Ok(images); }
        if cli != "codex" { return Err("当前 CLI 通道暂不支持发送图片".into()); }
        if entries.len() > 8 { return Err("每条消息最多发送 8 张图片".into()); }
        let dir = std::env::temp_dir().join(format!("ai-delelovelop-chat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).map_err(|_| "无法创建图片临时目录".to_string())?;
        images.directory = Some(dir.clone());
        for (index, (attachment, data)) in entries.into_iter().enumerate() {
            if data.len() > MAX_BYTES.div_ceil(3) * 4 { return Err("单张图片不能超过 10 MiB".into()); }
            let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效".to_string())?;
            if bytes.len() > MAX_BYTES { return Err("单张图片不能超过 10 MiB".into()); }
            if attachment.byte_size.is_some_and(|size| size != bytes.len() as i64) { return Err("图片长度不匹配".into()); }
            let ext = match attachment.mime.as_deref() {
                Some("image/png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
                Some("image/jpeg") if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "jpg",
                Some("image/webp") if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "webp",
                _ => return Err("请选择有效的 PNG、JPEG 或 WebP 图片".into()),
            };
            let path = dir.join(format!("{index}.{ext}"));
            std::fs::write(&path, bytes).map_err(|_| "无法写入图片临时文件".to_string())?;
            images.paths.push(path);
        }
        Ok(images)
    }
}

impl Drop for CliImages {
    fn drop(&mut self) {
        if let Some(dir) = &self.directory { let _ = std::fs::remove_dir_all(dir); }
    }
}

fn spawn_cli(
    cli_id: &str,
    model_id: &str,
    effort: &str,
    cwd: Option<&str>,
    dispatch: Option<&crate::commands::dispatch::DispatchConfig>,
    permission_id: Option<&str>,
    resume_ref: Option<&str>,
    image_paths: &[std::path::PathBuf],
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
            // CR-064 / BUG-002：grok 1.0.x 没有 `--print`/`--json`（实测 `--json` 直接报
            // unexpected argument，会话根本起不来）。正确用法：prompt 经 stdin 写入，
            // 输出格式用 `--output-format streaming-json`（JSONL 事件流）。
            // 仍为单轮通道，无线程续接（CR-037 登记不变）。
            let mut c = Command::new(&cli_bin);
            c.arg("--output-format").arg("streaming-json");
            if !model_id.is_empty() {
                c.arg("--model").arg(model_id);
            }
            // 思考档位：grok 与 claude/codex 用同一语义、不同承载（命令行参数）。
            if !effort.is_empty() && effort != "off" {
                c.arg("--reasoning-effort").arg(effort);
            }
            c
        }
        other => return Err(format!("未知 CLI：{}", other)),
    };

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if cli_id == "codex" {
        for path in image_paths { cmd.arg("--image").arg(path); }
        // End the variadic --image option before the positional stdin marker.
        cmd.arg("--").arg("-");
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
    // 冒烟模式默认压到 20s，防止 mock 链路挂起拖慢套件；但验证真实 CLI 时必须给足时间
    // （真实 grok 首轮要加载插件与工具清单，实测远超 20s）。
    // SMOKE_REAL_CLI=1 表示「本轮冒烟会跑真实 CLI」，此时不压缩超时。
    let smoke_fast = std::env::var_os("SMOKE_MOCKBIN").is_some()
        && std::env::var("SMOKE_REAL_CLI").map(|v| v != "1").unwrap_or(true);
    let timeout_secs = if smoke_fast { 20 } else { 30 * 60 };
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
        out.push_text("\n\n[已停止]");
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
            out.push_text("\n\n[已停止]");
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

/// CR-062：子智能体任务名摘要（首行、最多 60 字），不把整段正文当标题。
fn agent_task_summary(text: &str) -> String {
    text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim().chars().take(60).collect()
}

/// CR-062：子代理工具调用的可读摘要，只取常见字段，避免把完整输入（可能含凭证）送进界面。
fn agent_tool_brief(name: &str, input: &serde_json::Value) -> String {
    let field = ["command", "file_path", "path", "query", "pattern", "description"]
        .iter()
        .find_map(|key| input.get(*key).and_then(|value| value.as_str()))
        .unwrap_or("")
        .chars()
        .take(160)
        .collect::<String>();
    if field.is_empty() { name.to_string() } else { format!("{name} · {field}") }
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
    // CR-064/BUG-002：grok `--output-format streaming-json` 的帧把增量放在 `data`，
    // 形如 {"type":"text","data":"OK"} / {"type":"thought","data":"…"} /
    // {"type":"usage","usage":{…}} / {"type":"end","stopReason":"end_turn","sessionId":"…"}。
    // 与 claude 的 {type:…, message/event:…} 结构不同，必须单独分支，否则正文会静默丢失。
    if cli_id == "grok" {
        match typ {
            "text" => {
                if let Some(text) = v.get("data").and_then(|d| d.as_str()) {
                    if !text.is_empty() {
                        out.push_text(text);
                        send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                    }
                }
                return;
            }
            "thought" => {
                if let Some(text) = v.get("data").and_then(|d| d.as_str()) {
                    if !text.is_empty() {
                        out.push_thinking(text);
                        send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                    }
                }
                return;
            }
            "usage" => {
                if let Some(u) = v.get("usage") {
                    let (i, o, c) = extract_usage(u);
                    out.usage = Some((i, o, c));
                    send(channel, serde_json::json!({
                        "type": "usage", "inputTokens": i, "outputTokens": o, "cacheReadTokens": c
                    }));
                }
                return;
            }
            "end" => {
                // 无头单轮运行的终帧；会话引用留在后端内存，供续接判定。
                if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
                    out.emitted_ref = Some(sid.to_string());
                }
                return;
            }
            "error" => {
                let msg = v
                    .get("data")
                    .or_else(|| v.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                send(channel, serde_json::json!({ "type": "error", "message": msg }));
                return;
            }
            // available_commands 等元信息帧：不进正文。
            _ => return,
        }
    }
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
            if v.get("parent_tool_use_id").and_then(|id| id.as_str()).is_some_and(|id| !id.is_empty()) {
                return;
            }
            if et == "message_start" {
                out.claude_streamed.clear();
                out.claude_tool = None;
            }
            let index = ev["index"].as_u64().unwrap_or(0);
            if et == "content_block_start" && ev["content_block"]["type"] == "tool_use" {
                let block = &ev["content_block"];
                if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                    out.claude_tool = Some(ClaudeToolBlock {
                        index, id: id.into(), name: name.into(), input: block["input"].clone(), partial_json: String::new(),
                    });
                }
            }
            if et == "content_block_stop" && out.claude_tool.as_ref().is_some_and(|tool| tool.index == index) {
                let tool = out.claude_tool.take().unwrap();
                let input = serde_json::from_str::<serde_json::Value>(&tool.partial_json).unwrap_or(tool.input).to_string();
                out.push_tool_use(tool.id.clone(), tool.name.clone(), input.clone());
                send(channel, serde_json::json!({ "type": "toolUse", "toolId": tool.id, "name": tool.name, "inputJson": input }));
                out.claude_streamed.insert(index);
            }
            if et == "content_block_delta" {
                let delta = &ev["delta"];
                let dt = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if dt == "text_delta" {
                    let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !text.is_empty() { out.claude_streamed.insert(index); }
                    out.push_text(text);
                    send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                } else if dt == "thinking_delta" {
                    let text = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    if !text.is_empty() { out.claude_streamed.insert(index); }
                    out.push_thinking(text);
                    send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                } else if dt == "input_json_delta" {
                    if let Some(tool) = out.claude_tool.as_mut().filter(|tool| tool.index == index) {
                        tool.partial_json.push_str(delta["partial_json"].as_str().unwrap_or(""));
                    }
                }
            }
        }
        (_, "assistant") => {
            let msg = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                out.emitted_ref = Some(sid.to_string());
            }
            // CR-062：带 parent_tool_use_id 的消息属于子智能体；只上报只读事件，
            // 不并入主会话正文、工具步骤与用量，避免两套记录互相污染。
            if let Some(pid) = v.get("parent_tool_use_id").and_then(|s| s.as_str()) {
                if !pid.is_empty() {
                    let mut task = String::new();
                    if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                        for b in blocks {
                            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                                "text" => {
                                    let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                    if text.trim().is_empty() { continue; }
                                    if task.is_empty() { task = agent_task_summary(text); }
                                    send(channel, serde_json::json!({
                                        "type": "subagent", "id": pid, "task": task, "status": "running",
                                        "cli": cli_id, "content": text, "kind": "text"
                                    }));
                                }
                                "tool_use" => {
                                    let name = b.get("name").and_then(|t| t.as_str()).unwrap_or("");
                                    let input = b.get("input").cloned().unwrap_or(serde_json::json!({}));
                                    send(channel, serde_json::json!({
                                        "type": "subagent", "id": pid, "task": task, "status": "running",
                                        "cli": cli_id, "kind": "tool_use", "toolName": name,
                                        "content": agent_tool_brief(name, &input)
                                    }));
                                }
                                _ => {}
                            }
                        }
                    }
                    return;
                }
            }
            if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                for (index, b) in blocks.iter().enumerate() {
                    if out.claude_streamed.contains(&(index as u64)) { continue; }
                    let bt = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match bt {
                        "text" => {
                            let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !text.is_empty() {
                                out.push_text(text);
                                send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                            }
                        }
                        "thinking" => {
                            if let Some(text) = b["thinking"].as_str().filter(|text| !text.is_empty()) {
                                out.push_thinking(text);
                                send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                            }
                        }
                        "tool_use" => {
                            let tid = b.get("id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            let name = b.get("name").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            let input = b.get("input").cloned().unwrap_or(serde_json::json!({}));
                            out.push_tool_use(tid.clone(), name.clone(), input.to_string());
                            send(channel, serde_json::json!({ "type": "toolUse", "toolId": tid, "name": name, "inputJson": input.to_string() }));
                        }
                        _ => {}
                    }
                }
            }
            out.claude_streamed.clear();
            out.claude_tool = None;
            if let Some(u) = msg.get("usage") {
                out.usage = Some(extract_usage(u));
                if let Some((i, o, c)) = out.usage {
                    send(channel, serde_json::json!({ "type": "usage", "inputTokens": i, "outputTokens": o, "cacheReadTokens": c }));
                }
            }
        }
        (_, "user") => {
            // CR-062：子代理的工具结果同样只作为只读事件上报。
            if let Some(pid) = v.get("parent_tool_use_id").and_then(|s| s.as_str()) {
                if !pid.is_empty() {
                    if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        for b in blocks {
                            if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                                let is_err = b.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                                let content: String = extract_content_text(b.get("content")).chars().take(4000).collect();
                                send(channel, serde_json::json!({
                                    "type": "subagent", "id": pid, "task": "", "status": "running",
                                    "cli": cli_id, "kind": "tool_result", "content": content, "isError": is_err
                                }));
                            }
                        }
                    }
                    return;
                }
            }
            if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let tid = b.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                        let is_err = b.get("is_error").and_then(|t| t.as_bool()).unwrap_or(false);
                        let content = match b.get("content") {
                            Some(serde_json::Value::String(text)) => text.clone(),
                            Some(content) => content.to_string(),
                            None => String::new(),
                        };
                        out.push_tool_result(tid.clone(), content.clone(), is_err, None);
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
                    out.push_text(r);
                    send(channel, serde_json::json!({ "type": "delta", "delta": r }));
                }
            }
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                out.emitted_ref = Some(sid.to_string());
            }
        }
        // ---------- codex exec --json ----------
        ("codex", "item.started" | "item.updated" | "item.completed") => {
            let Some(item) = v.get("item") else { return; };
            let it = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match it {
                "agent_message" if typ == "item.completed" => {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        out.push_text(text);
                        send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                    }
                }
                "reasoning" if typ == "item.completed" => {
                    let text = item
                        .get("text")
                        .or_else(|| item.pointer("/summary/0/text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if !text.is_empty() {
                        out.push_thinking(text);
                        send(channel, serde_json::json!({ "type": "thinking", "delta": text }));
                    }
                }
                "todo_list" => {
                    if let Some(items) = codex_plan_items(item) {
                        let duplicate = out.segments.iter().rev().find_map(|segment| match segment {
                            TurnSegment::PlanUpdate(previous) => Some(previous == &items),
                            _ => None,
                        }).unwrap_or(false);
                        if !duplicate {
                            send(channel, serde_json::json!({ "type": "planUpdate", "items": items }));
                            out.segments.push(TurnSegment::PlanUpdate(items));
                        }
                    }
                }
                "command_execution" => {
                    for event in codex_command_events(typ, item, out) {
                        send(channel, event);
                    }
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
                    out.push_text(text);
                    send(channel, serde_json::json!({ "type": "delta", "delta": text }));
                }
            }
        }
    }
}

fn codex_plan_items(item: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    let entries = item["items"].as_array()?;
    entries.iter().map(|entry| {
        let text = entry["text"].as_str()?.trim();
        if text.is_empty() { return None; }
        let status = match entry["status"].as_str() {
            Some(status @ ("pending" | "in_progress" | "completed")) => status,
            Some(_) => return None,
            None if entry["completed"].as_bool()? => "completed",
            None => "pending",
        };
        Some(serde_json::json!({ "text": text, "status": status }))
    }).collect()
}

/// `aggregated_output` is cumulative. Updates replace the command snapshot in place.
fn codex_command_events(stage: &str, item: &serde_json::Value, out: &mut StreamOutcome) -> Vec<serde_json::Value> {
    use serde_json::json;
    let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else { return vec![]; };
    if out.tool_results.iter().any(|(tool_id, _, _)| tool_id == id) { return vec![]; }
    let mut events = vec![];
    if !out.tool_uses.iter().any(|(tool_id, _, _)| tool_id == id) {
        let input = json!({"command": item["command"].as_str().unwrap_or("")}).to_string();
        out.push_tool_use(id.into(), "shell".into(), input.clone());
        events.push(json!({"type":"toolUse","toolId":id,"name":"shell","inputJson":input}));
    }
    if let Some(text) = item["aggregated_output"].as_str() {
        out.command_output.insert(id.into(), text.into());
    }
    if stage == "item.completed" {
        let content = out.command_output.remove(id).unwrap_or_default();
        let exit_code = item["exit_code"].as_i64();
        let is_error = exit_code.is_some_and(|code| code != 0) || item["status"].as_str() == Some("failed");
        out.push_tool_result(id.into(), content.clone(), is_error, exit_code);
        events.push(json!({"type":"toolResult","toolId":id,"content":content,"isError":is_error,"exitCode":exit_code}));
    } else if let Some(content) = out.command_output.get(id).filter(|text| !text.is_empty() || stage == "item.updated") {
        events.push(json!({"type":"toolUpdate","toolId":id,"content":content}));
    }
    events
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

/// 更新会话未读列（可独立测试的纯 SQL 部分）。
fn apply_session_unread(conn: &rusqlite::Connection, session_id: &str, unread: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE session SET unread=?2 WHERE id=?1",
        rusqlite::params![session_id, unread],
    )?;
    Ok(())
}

/// 写入会话未读标记（success/failed）。独立短事务；调用方在主事务提交后调用，避免事务嵌套。
/// 失败静默（未读只是提示，不应影响轮次结算与消息落库）。
fn set_session_unread(session_id: &str, unread: &str) {
    if let Ok(guard) = db::conn() {
        if let Some(conn) = guard.as_ref() {
            let _ = apply_session_unread(conn, session_id, unread);
        }
    }
}

/// 消息落库（无事务）：由 persist_assistant_with_conn 或结算事务复用，禁止嵌套开事务。
pub(crate) fn insert_assistant_messages(conn: &rusqlite::Connection, session_id: &str, out: &StreamOutcome) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    if !out.segments.is_empty() {
        let last_text = out.segments.iter().rposition(|s| matches!(s, TurnSegment::Text(_)))
            .or_else(|| out.segments.iter().rposition(|s| matches!(s, TurnSegment::Thinking(_))));
        let mut first_thinking = true;
        for (index, segment) in out.segments.iter().enumerate() {
            let (role, content, meta) = match segment {
                TurnSegment::Text(text) | TurnSegment::Thinking(text) => {
                    let thinking = matches!(segment, TurnSegment::Thinking(_));
                    let mut meta = serde_json::json!({});
                    if thinking {
                        meta["thinking"] = serde_json::json!(text);
                        if first_thinking && out.thinking_ms > 0 {
                            meta["thinkingMs"] = serde_json::json!(out.thinking_ms);
                        }
                        first_thinking = false;
                    }
                    if Some(index) == last_text {
                        if let Some((i, o, c)) = out.usage {
                            meta["usage"] = serde_json::json!({"inputTokens":i,"outputTokens":o,"cacheReadTokens":c});
                        }
                    }
                    ("assistant", if thinking { "" } else { text.as_str() }, meta)
                }
                TurnSegment::ToolUse(index) => {
                    let (id, name, input) = &out.tool_uses[*index];
                    ("tool_use", name.as_str(), serde_json::json!({"toolId":id,"input":input,"toolOutput":out.command_output.get(id)}))
                }
                TurnSegment::ToolResult(index, exit_code) => {
                    let (id, content, is_error) = &out.tool_results[*index];
                    ("tool_result", content.as_str(), serde_json::json!({"toolId":id,"isError":is_error,"exitCode":exit_code}))
                }
                TurnSegment::PlanUpdate(items) => ("system", "", serde_json::json!({ "kind": "planUpdate", "items": items })),
            };
            conn.execute(
                "INSERT INTO message (id,sessionId,role,content,metaJson,createdAt) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![new_id("msg"), session_id, role, content, meta.to_string(), now],
            )?;
        }
        conn.execute("UPDATE session SET updatedAt=?2 WHERE id=?1", rusqlite::params![session_id,now])?;
        return Ok(());
    }
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

// ---------- 待发恢复 / 配额 / 运行时退出横幅（只读） ----------

/// 配额视图：后端目前没有真实的会话配额数据源，字段为空时前端不显示。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuotaView {
    pub used: Option<i64>,
    pub limit: Option<i64>,
    pub label: String,
    pub detail: Option<String>,
}

/// 待发命令视图：当前待发队列完全在渲染进程内存中，后端没有持久化来源，正常为空。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPendingCommandView {
    pub id: String,
    pub text: String,
    pub created_at: i64,
    pub source: String,
}

/// 运行时退出视图：只有在能确证 CLI 进程异常退出时才会填充；此处不伪造。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuntimeExitView {
    pub reason: String,
    pub detail: String,
    pub at: i64,
}

/// 会话运行态横幅数据（只读）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatActionStatus {
    pub session_id: String,
    pub updated_at: i64,
    pub running: bool,
    pub quota: Option<ChatQuotaView>,
    pub runtime_exit: Option<ChatRuntimeExitView>,
    pub pending_commands: Vec<ChatPendingCommandView>,
}

/// 只读查询会话运行态横幅数据：参数校验 + 中文错误，不返回敏感信息。
///
/// - `running`：本进程内该会话是否有进行中的回合（真实内存状态）。
/// - `quota`：后端暂无真实配额数据源，返回 `None`，前端据此不渲染，不显示占位数字。
/// - `runtimeExit`：后端未持久化 CLI 进程退出事件，无法确证时返回 `None`，不生成假横幅。
/// - `pendingCommands`：待发队列目前仅存在于前端内存，后端无持久化来源，返回空数组。
#[tauri::command]
pub fn chat_action_status(session_id: String) -> Result<ChatActionStatus, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("缺少会话 ID，无法查询运行状态".into());
    }
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("数据库未初始化")?;
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM session WHERE id=?1", [&sid], |r| r.get(0))
        .map_err(|e| format!("查询会话失败：{e}"))?;
    if exists == 0 {
        return Err("会话不存在或已被删除".into());
    }
    let running = RUNNING
        .lock()
        .map_err(|_| "会话运行状态不可用".to_string())?
        .contains_key(&sid);
    Ok(ChatActionStatus {
        session_id: sid,
        updated_at: now_ms(),
        running,
        quota: None,
        runtime_exit: None,
        pending_commands: Vec::new(),
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

    fn cr076_history(out: &StreamOutcome) -> Vec<(String, String, serde_json::Value)> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,updatedAt INTEGER);
            INSERT INTO session VALUES('s',1);
            CREATE TABLE message(id TEXT,sessionId TEXT,role TEXT,content TEXT,metaJson TEXT,createdAt INTEGER);").unwrap();
        persist_assistant_with_conn(&conn, "s", out).unwrap();
        let mut stmt = conn.prepare("SELECT role, content, metaJson FROM message ORDER BY createdAt, rowid").unwrap();
        stmt.query_map([], |row| {
            let meta: String = row.get(2)?;
            Ok((row.get(0)?, row.get(1)?, serde_json::from_str(&meta).unwrap()))
        }).unwrap().collect::<Result<_, _>>().unwrap()
    }

    #[test]
    fn cr076_codex_command_and_plan_history_preserve_order() {
        use serde_json::json;
        let mut out = StreamOutcome::default();
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let frames = [
            json!({"type":"item.started","item":{"type":"command_execution","id":"command-1","command":"echo example","aggregated_output":""}}),
            json!({"type":"item.updated","item":{"type":"command_execution","id":"command-1","aggregated_output":"first"}}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":"interleaved"}}),
            json!({"type":"item.updated","item":{"type":"todo_list","items":[{"text":"inspect","completed":false},{"text":"check","status":"in_progress"}]}}),
            json!({"type":"item.updated","item":{"type":"command_execution","id":"command-1","aggregated_output":"first\nsecond"}}),
            json!({"type":"item.completed","item":{"type":"command_execution","id":"command-1","exit_code":3,"status":"failed"}}),
            json!({"type":"item.completed","item":{"type":"command_execution","id":"command-1","exit_code":3}}),
            json!({"type":"item.updated","item":{"type":"todo_list","items":[{"text":"check","status":"completed"}]}}),
            json!({"type":"item.completed","item":{"type":"todo_list","items":[]}}),
            json!({"type":"item.started","item":{"type":"command_execution","id":"command-2","command":"echo partial","aggregated_output":"partial"}}),
        ];
        for frame in frames { parse_cli_line(&frame, "codex", &mut out, &channel); }
        out.aborted = true;
        let rows = cr076_history(&out);
        assert_eq!(rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(), ["tool_use", "assistant", "system", "tool_result", "system", "system", "tool_use"]);
        assert_eq!(serde_json::from_str::<serde_json::Value>(rows[0].2["input"].as_str().unwrap()).unwrap()["command"], "echo example");
        assert_eq!(rows[2].2["items"][0]["status"], "pending");
        assert_eq!(rows[2].2["items"][1]["status"], "in_progress");
        assert_eq!(rows[3].1, "first\nsecond");
        assert_eq!(rows[3].2["exitCode"], 3);
        assert_eq!(rows[3].2["isError"], true);
        assert_eq!(rows[4].2["items"], json!([{"text":"check","status":"completed"}]));
        assert_eq!(rows[5].2["items"], json!([]));
        assert_eq!(rows[6].2["toolOutput"], "partial");
    }

    #[test]
    fn cr076_apply_session_unread_sets_and_clears() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY, unread TEXT); INSERT INTO session(id,unread) VALUES('s1',NULL);").unwrap();
        apply_session_unread(&c, "s1", "success").unwrap();
        let v: Option<String> = c.query_row("SELECT unread FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(v.as_deref(), Some("success"));
        apply_session_unread(&c, "s1", "failed").unwrap();
        let v2: Option<String> = c.query_row("SELECT unread FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(v2.as_deref(), Some("failed"));
        apply_session_unread(&c, "s1", "").unwrap();
        let v3: Option<String> = c.query_row("SELECT unread FROM session WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(v3.as_deref(), Some(""));
        // 不存在的会话：UPDATE 影响 0 行不报错（幂等安全）
        apply_session_unread(&c, "missing", "success").unwrap();
    }

    #[test]
    fn cr076_claude_streaming_and_history_preserve_tool_chronology() {
        use serde_json::json;
        let mut out = StreamOutcome::default();
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let frames = [
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"same"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"Read","input":{}}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"demo.txt\"}"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":1}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"check"}}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"same"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"path":"demo.txt"}},{"type":"thinking","thinking":"check"}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"example"}]}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"same"}]}}),
        ];
        for frame in frames { parse_cli_line(&frame, "claude", &mut out, &channel); }
        let rows = cr076_history(&out);
        assert_eq!(rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(), ["assistant", "tool_use", "assistant", "tool_result", "assistant"]);
        assert_eq!(rows[0].1, "same");
        assert_eq!(rows[1].2["input"], "{\"path\":\"demo.txt\"}");
        assert_eq!(rows[2].2["thinking"], "check");
        assert_eq!(rows[3].1, "[{\"text\":\"example\",\"type\":\"text\"}]");
        assert_eq!(rows[4].1, "same");
    }

    #[test]
    fn cr076_real_claude_local_process_sample() {
        use serde_json::json;
        // Real installed Claude 2.1.331 process, synthetic loopback API, actual Read only.
        // Sanitization preserves both complete assistant frames BEFORE their block stops.
        // This sample cannot establish TaskCreate/TaskUpdate/TodoWrite or UI acceptance.
        let frames: Vec<serde_json::Value> = include_str!("../../tests/fixtures/cr076-claude-2.1.331-local.jsonl")
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(frames[0]["provenance"]["kind"], "sanitized_local_api_fixture");
        assert_eq!(frames[0]["provenance"]["cli_version"], "2.1.331");
        assert_eq!(frames[1..].iter().map(|frame| {
            if frame["type"] == "stream_event" { frame["event"]["type"].as_str().unwrap() }
            else { frame["type"].as_str().unwrap() }
        }).collect::<Vec<_>>(), [
            "message_start", "content_block_start", "content_block_delta", "assistant",
            "content_block_stop", "message_delta", "message_stop", "user",
            "message_start", "content_block_start", "content_block_delta", "assistant",
            "content_block_stop", "message_delta", "message_stop", "result",
        ]);
        assert_eq!(frames[2]["event"]["content_block"]["type"], "tool_use");
        assert_eq!(frames[3]["event"]["delta"]["type"], "input_json_delta");
        assert_eq!(frames[4]["message"]["content"][0]["type"], "tool_use");
        assert_eq!(frames[8]["message"]["content"][0]["type"], "tool_result");
        assert_eq!(frames[11]["event"]["delta"]["type"], "text_delta");
        assert_eq!(frames[12]["message"]["content"][0]["type"], "text");

        let mut out = StreamOutcome::default();
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        for frame in &frames { parse_cli_line(frame, "claude", &mut out, &channel); }
        assert_eq!(out.tool_uses.len(), 1);
        assert_eq!(out.tool_results.len(), 1);
        assert_eq!(out.assistant_text, "LOCAL_CLAUDE_FIXTURE_OK");
        assert!(out.thinking_text.is_empty());
        assert!(!out.is_error && !out.aborted);
        assert!(!out.segments.iter().any(|segment| matches!(segment, TurnSegment::PlanUpdate(_))));

        // The existing helper invokes production persistence against SQLite :memory:.
        let rows = cr076_history(&out);
        assert_eq!(rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(), ["tool_use", "tool_result", "assistant"]);
        assert_eq!(rows[0].1, "Read");
        assert_eq!(rows[0].2["toolId"], "fixture-read");
        let input: serde_json::Value = serde_json::from_str(rows[0].2["input"].as_str().unwrap()).unwrap();
        assert_eq!(input, json!({"file_path":"D:/demo/cr076/input.txt"}));
        assert_eq!(input["file_path"].as_str().unwrap().replace('\\', "/"), "D:/demo/cr076/input.txt");
        assert_eq!(rows[1].2["toolId"], "fixture-read");
        assert_eq!(rows[1].1, "1\tLOCAL_READ_FIXTURE_ONLY\n2\t");
        assert_eq!(rows[1].2["isError"], false);
        assert_eq!(rows.iter().filter(|row| row.0 == "tool_use" && row.2["toolId"] == "fixture-read").count(), 1);
        assert_eq!(rows.iter().filter(|row| row.0 == "tool_result" && row.2["toolId"] == "fixture-read").count(), 1);
        assert_eq!(rows[2].1, "LOCAL_CLAUDE_FIXTURE_OK");
        assert_eq!(rows.iter().filter(|row| row.0 == "assistant" && row.1 == "LOCAL_CLAUDE_FIXTURE_OK").count(), 1);
        assert!(rows.iter().all(|row| row.2["kind"] != "planUpdate"));
    }

    #[test]
    fn cr076_image_bytes_are_kept_until_the_turn_releases_them() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPrsAAAAASUVORK5CYII=";
        let bytes = STANDARD.decode(encoded).unwrap();
        let attachment = crate::models::AttachmentMeta {
            name: "fixture image.png".into(),
            mime: Some("image/png".into()),
            byte_size: Some(bytes.len() as i64),
            image_base64: Some(encoded.into()),
        };
        for unsupported in ["claude", "grok"] {
            assert!(CliImages::prepare(unsupported, std::slice::from_ref(&attachment)).is_err());
        }
        let images = CliImages::prepare("codex", &[attachment.clone(), attachment]).unwrap();
        let directory = images.directory.clone().unwrap();
        let paths = images.paths.clone();
        assert_eq!(paths.len(), 2);
        for (index, path) in paths.iter().enumerate() {
            assert_eq!(path, &directory.join(format!("{index}.png")));
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        drop(images);
        assert!(!directory.exists());
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

    // ---------- CR-063：会话历史分页 ----------

    fn page_conn() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '新会话', cliId TEXT, providerId TEXT,
                modelId TEXT, effort TEXT, draft TEXT NOT NULL DEFAULT '', unread TEXT,
                createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
                featureId TEXT, featureTitle TEXT, featureSourceHash TEXT,
                sessionRole TEXT NOT NULL DEFAULT 'ordinary',
                nativeThreadRef TEXT, nativeBindingRevision INTEGER NOT NULL DEFAULT 0,
                nativeConfirmedTurnId TEXT,
                pinnedAt INTEGER NOT NULL DEFAULT 0,
                runner TEXT NOT NULL DEFAULT 'cli'
             );
             CREATE TABLE message (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, metaJson TEXT, refsJson TEXT, gitContextJson TEXT, createdAt INTEGER NOT NULL);
             CREATE TABLE execution_session_turn (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, outcome TEXT, reasonCode TEXT, createdAt INTEGER NOT NULL);",
        )
        .unwrap();
        c
    }

    fn seed(c: &rusqlite::Connection, id: &str, project: Option<&str>, server: Option<&str>, title: &str, updated: i64) {
        c.execute(
            "INSERT INTO session (id, projectId, serverId, title, createdAt, updatedAt) VALUES (?1,?2,?3,?4,?5,?5)",
            rusqlite::params![id, project, server, title, updated],
        )
        .unwrap();
    }

    fn page_ids(page: &SessionPage) -> Vec<String> {
        page.items.iter().map(|s| s.id.clone()).collect()
    }

    fn expect_ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cr063_first_page_has_20_and_cursor_pages_have_no_dup_or_gap() {
        let c = page_conn();
        for i in 0..25 {
            seed(&c, &format!("s{i:02}"), Some("p1"), None, &format!("会话 {i:02}"), 1000 + i as i64);
        }
        let first = sessions_page_query(&c, Some("p1"), None, None, None, None).unwrap();
        assert_eq!(first.items.len(), 20);
        assert_eq!(first.total, 25);
        assert!(first.has_more);
        let cursor = first.next_cursor.clone().expect("cursor");
        let second = sessions_page_query(
            &c,
            Some("p1"),
            None,
            None,
            Some((cursor.pinned_at, cursor.updated_at, cursor.id.clone())),
            None,
        )
        .unwrap();
        assert_eq!(second.items.len(), 5);
        assert!(!second.has_more);
        assert!(second.next_cursor.is_none());
        let mut all = page_ids(&first);
        all.extend(page_ids(&second));
        let unique: std::collections::BTreeSet<_> = all.iter().cloned().collect();
        assert_eq!(all.len(), 25);
        assert_eq!(unique.len(), 25);
    }

    #[test]
    fn cr063_scopes_match_filter_sessions() {
        let c = page_conn();
        seed(&c, "a", Some("p1"), Some("srv1"), "a", 10);
        seed(&c, "b", None, Some("srv1"), "b", 11);
        seed(&c, "c", Some("p2"), Some("srv1"), "c", 12);
        seed(&c, "d", Some("p1"), None, "d", 13);
        seed(&c, "e", None, None, "e", 14);
        seed(&c, "f", None, None, "f", 15);

        let project = sessions_page_query(&c, Some("p1"), None, None, None, None).unwrap();
        assert_eq!(page_ids(&project), expect_ids(&["d", "a"]));

        let both = sessions_page_query(&c, Some("p1"), Some("srv1"), None, None, None).unwrap();
        assert_eq!(page_ids(&both), expect_ids(&["a"]));

        // server-only 不限制 projectId（与 filterSessions 既有语义一致）
        let server = sessions_page_query(&c, None, Some("srv1"), None, None, None).unwrap();
        assert_eq!(page_ids(&server), expect_ids(&["c", "b", "a"]));

        let global = sessions_page_query(&c, None, None, None, None, None).unwrap();
        assert_eq!(page_ids(&global), expect_ids(&["f", "e"]));
    }

    #[test]
    fn cr063_keyword_matches_title_and_escapes_wildcards() {
        let c = page_conn();
        seed(&c, "a", Some("p1"), None, "处理 CLI 退出码 137", 10);
        seed(&c, "b", Some("p1"), None, "100% 覆盖", 11);
        seed(&c, "c", Some("p1"), None, "a_b 测试", 12);
        seed(&c, "d", Some("p1"), None, "路径 a\\b", 13);

        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("退出码"), None, None).unwrap().items.len(), 1);
        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("%"), None, None).unwrap().items.len(), 1);
        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("_"), None, None).unwrap().items.len(), 1);
        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("\\"), None, None).unwrap().items.len(), 1);
        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("不存在的关键词"), None, None).unwrap().total, 0);
        // 纯空白等价于无关键词
        assert_eq!(sessions_page_query(&c, Some("p1"), None, Some("   "), None, None).unwrap().total, 4);
    }

    #[test]
    fn cr063_limit_is_clamped_and_search_pages_carry_keyword() {
        let c = page_conn();
        for i in 0..22 {
            seed(&c, &format!("k{i:02}"), Some("p1"), None, &format!("任务 {i:02}"), 100 + i as i64);
        }
        seed(&c, "x", Some("p1"), None, "别的", 200);

        let one = sessions_page_query(&c, Some("p1"), None, None, None, Some(0)).unwrap();
        assert_eq!(one.items.len(), 1);
        let capped = sessions_page_query(&c, Some("p1"), None, None, None, Some(1000)).unwrap();
        assert_eq!(capped.items.len(), 23);

        let first = sessions_page_query(&c, Some("p1"), None, Some("任务"), None, None).unwrap();
        assert_eq!(first.items.len(), 20);
        assert_eq!(first.total, 22);
        assert!(first.has_more);
        let cursor = first.next_cursor.clone().expect("cursor");
        let second = sessions_page_query(
            &c,
            Some("p1"),
            None,
            Some("任务"),
            Some((cursor.pinned_at, cursor.updated_at, cursor.id.clone())),
            None,
        )
        .unwrap();
        assert_eq!(second.items.len(), 2);
        assert_eq!(second.total, 22);
        assert!(!second.has_more);
    }

    #[test]
    fn cr063_escape_like_escapes_control_chars() {
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    #[test]
    fn cr065_pin_orders_before_recent() {
        let c = page_conn();
        for i in 0..5 {
            seed(&c, &format!("n{i}"), Some("p1"), None, &format!("普通 {i}"), 100 + i as i64);
        }
        seed(&c, "old", Some("p1"), None, "置顶旧会话", 1);
        c.execute("UPDATE session SET pinnedAt=1000 WHERE id='old'", []).unwrap();
        let page = sessions_page_query(&c, Some("p1"), None, None, None, None).unwrap();
        assert_eq!(page.items[0].id, "old");
        assert_eq!(page.items[0].pinned_at, 1000);
        assert_eq!(page.total, 6);

        // 置顶两条：最近置顶的在前，随后是不久前更新但未置顶的
        c.execute("UPDATE session SET pinnedAt=2000 WHERE id='n0'", []).unwrap();
        let page2 = sessions_page_query(&c, Some("p1"), None, None, None, None).unwrap();
        assert_eq!(page2.items[0].id, "n0");
        assert_eq!(page2.items[1].id, "old");
        assert_eq!(page2.items[2].id, "n4");
    }

    #[test]
    fn cr065_fork_copies_messages_without_native_binding() {
        let c = page_conn();
        c.execute(
            "INSERT INTO session (id, projectId, title, createdAt, updatedAt, sessionRole, nativeThreadRef, nativeBindingRevision) VALUES ('src','p1','原标题',1,1,'ordinary','ref-x',3)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO message (id, sessionId, role, content, createdAt) VALUES ('m1','src','user','hi',1)", []).unwrap();
        c.execute("INSERT INTO message (id, sessionId, role, content, createdAt) VALUES ('m2','src','assistant','hello',2)", []).unwrap();

        let new_id = fork_session(&c, "src").unwrap();
        let (title, role, native, rev): (String, String, Option<String>, i64) = c
            .query_row(
                "SELECT title, sessionRole, nativeThreadRef, nativeBindingRevision FROM session WHERE id=?1",
                [&new_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "分叉 · 原标题");
        assert_eq!(role, "ordinary");
        assert_eq!(native, None);
        assert_eq!(rev, 0);

        let copied: Vec<String> = {
            let mut stmt = c.prepare("SELECT content FROM message WHERE sessionId=?1 ORDER BY createdAt").unwrap();
            stmt.query_map([&new_id], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(copied, vec!["hi".to_string(), "hello".to_string()]);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM message WHERE sessionId='src'", [], |r| r.get::<_, i64>(0)).unwrap(),
            2
        );
    }

    #[test]
    fn cr059_route_table_matches_task_type_then_fallback_then_session() {
        let table = RouteTable {
            slots: vec![
                RouteSlot { model: "p/m-code".into(), effort: "high".into(), types: vec!["功能开发".into()] },
                RouteSlot { model: "p/m-doc".into(), effort: "".into(), types: vec!["文档整理".into()] },
                // 空模型槽必须跳过，不能命中。
                RouteSlot { model: "  ".into(), effort: "max".into(), types: vec!["功能开发".into()] },
            ],
            fallback: RouteFallback { model: "p/m-fallback".into(), effort: "medium".into() },
        };
        // 命中第一个含该类型的非空槽；槽位档位为空时沿用会话档位。
        assert_eq!(resolve_route(&table, &["功能开发".into()], "s/m", "low").0, "p/m-code");
        assert_eq!(resolve_route(&table, &["功能开发".into()], "s/m", "low").1, "high");
        assert_eq!(resolve_route(&table, &["文档整理".into()], "s/m", "low").1, "low");
        // 未命中任务类型 → 兜底。
        assert_eq!(resolve_route(&table, &["测试验证".into()], "s/m", "low").0, "p/m-fallback");
        // 无任务类型识别 → 兜底（不猜）。
        assert_eq!(resolve_route(&table, &[], "s/m", "low").0, "p/m-fallback");
        // 兜底也未配置 → 沿用会话选择。
        let empty = RouteTable::default();
        let (model, effort, why) = resolve_route(&empty, &["功能开发".into()], "s/m", "low");
        assert_eq!((model.as_str(), effort.as_str()), ("s/m", "low"));
        assert!(why.contains("沿用会话"));
    }

    #[test]
    fn cr059_detect_task_types_matches_keywords_without_guessing() {
        let hits = detect_task_types("帮我修一下这个 bug，报错崩溃了");
        assert!(hits.contains(&"缺陷修复".to_string()), "应识别缺陷修复：{hits:?}");
        assert!(detect_task_types("今天天气怎么样").is_empty(), "无关消息不应命中任何任务类型");
        // 最多 3 个，避免一条消息把所有槽位都点亮。
        assert!(detect_task_types("重构 测试 审查 文档 方案设计 定位").len() <= 3);
    }

    #[test]
    fn cr059_front_end_route_json_deserializes_into_route_table() {
        // 前端（src/modules/settings/CliRoute.tsx）实际写入 cli.preferences.<id> 的 JSON 形状。
        // 这里锁定契约：后端必须能原样反序列化，且兜底含 effort、slots 为变长数组。
        let raw = r#"{
            "route": {
                "slots": [
                    { "model": "PRV-MAGPIE/gpt-6-astra-ar", "effort": "high", "types": ["仓库探索"] },
                    { "model": "", "effort": "", "types": [] }
                ],
                "fallback": { "model": "", "effort": "medium" }
            },
            "permission": "agent"
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).expect("前端 JSON 应可解析");
        let route = value.get("route").cloned().unwrap_or(value);
        let table: RouteTable = serde_json::from_value(route).expect("前端 route 应能反序列化为 RouteTable");
        assert_eq!(table.slots.len(), 2, "变长槽位应原样保留");
        assert_eq!(table.slots[0].model, "PRV-MAGPIE/gpt-6-astra-ar");
        assert_eq!(table.slots[0].effort, "high");
        assert_eq!(table.slots[0].types, vec!["仓库探索".to_string()]);
        // 兜底 effort 必须可读，且未配置模型时按「沿用会话」处理。
        assert_eq!(table.fallback.effort, "medium");
        assert!(table.fallback.model.trim().is_empty());
        // 命中任务类型 → 第一个非空槽；空模型槽必须跳过。
        assert_eq!(resolve_route(&table, &["仓库探索".into()], "s/m", "low").0, "PRV-MAGPIE/gpt-6-astra-ar");
        // 未命中 → 兜底未配模型 → 沿用会话选择。
        assert_eq!(resolve_route(&table, &["测试验证".into()], "s/m", "low").0, "s/m");
    }

    #[test]
    fn cr065_executor_session_cannot_fork() {
        let c = page_conn();
        c.execute(
            "INSERT INTO session (id, projectId, title, createdAt, updatedAt, sessionRole) VALUES ('ex','p1','执行 FEAT-1',1,1,'executor')",
            [],
        )
        .unwrap();
        assert!(fork_session(&c, "ex").is_err());
    }
}
