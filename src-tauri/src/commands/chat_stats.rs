//! FEAT-012：平台闭合生成步骤观测；不读取正文、不改变执行或授权。
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(crate) const STEP_SCHEMA: &str = "dsh.closed-steps.v1";
pub(crate) const SNAPSHOT_SCHEMA: &str = "dsh.session-stats.snapshot.v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelTiming {
    pub started_at: i64,
    pub finished_at: i64,
    pub model_ms: u64,
    pub ttft_ms: Option<u64>,
    pub decode_ms: Option<u64>,
    pub output_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosedStep {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub outcome: String,
    pub timing: Option<ModelTiming>,
    pub usage: Option<(i64, i64, i64)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnStats {
    pub schema: String,
    pub rule: String,
    pub source: String,
    pub session_id: String,
    pub turn_id: String,
    pub complete: bool,
    pub closed_steps: Vec<ClosedStep>,
}

impl TurnStats {
    pub fn new(session_id: &str, turn_id: &str) -> Self {
        Self { schema: STEP_SCHEMA.into(), rule: "dsh".into(), source: "platform".into(),
            session_id: session_id.into(), turn_id: turn_id.into(), complete: false, closed_steps: vec![] }
    }
    fn valid(&self, session_id: &str, turn_id: &str) -> bool {
        self.schema == STEP_SCHEMA && self.rule == "dsh" && self.source == "platform"
            && self.session_id == session_id && self.turn_id == turn_id
            && self.closed_steps.iter().all(|step| step.event_type == "step/end"
                && step.session_id == session_id && step.turn_id == turn_id && !step.step_id.trim().is_empty()
                && matches!(step.outcome.as_str(), "completed" | "failed" | "cancelled" | "max_tokens"))
    }
}

/// 调用方已有事务时直接参与该事务；重复写入保留首次闭合，不改变其他meta或正文。
pub(crate) fn save_turn(conn: &Connection, stats: &TurnStats, complete: bool) -> Result<(), String> {
    if !stats.valid(&stats.session_id, &stats.turn_id) { return Err("步骤统计格式无效".into()); }
    let raw: Option<String> = conn.query_row(
        "SELECT metaJson FROM message WHERE id=?1 AND sessionId=?2 AND role='user'",
        params![stats.turn_id, stats.session_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let mut meta = match raw {
        None => json!({}),
        Some(raw) => serde_json::from_str::<Value>(&raw).map_err(|_| "原消息元信息无效，未覆盖")?,
    };
    let object = meta.as_object_mut().ok_or("原消息元信息不是对象，未覆盖")?;
    let old = object.get("sessionStats").cloned().and_then(|v| serde_json::from_value::<TurnStats>(v).ok())
        .filter(|v| v.valid(&stats.session_id, &stats.turn_id));
    let mut merged = stats.clone();
    merged.complete = complete || old.as_ref().is_some_and(|v| v.complete);
    let mut steps = BTreeMap::new();
    for step in old.iter().flat_map(|v| &v.closed_steps).chain(&stats.closed_steps) {
        steps.entry(step.step_id.clone()).or_insert_with(|| step.clone());
    }
    // stepId由平台顺序生成，保留生成顺序供最近步骤计时，不按字符串序排列。
    merged.closed_steps.clear();
    for step in old.iter().flat_map(|v| &v.closed_steps).chain(&stats.closed_steps) {
        if let Some(step) = steps.remove(&step.step_id) { merged.closed_steps.push(step); }
    }
    object.insert("sessionStats".into(), serde_json::to_value(merged).map_err(|e| e.to_string())?);
    conn.execute("UPDATE message SET metaJson=?3 WHERE id=?1 AND sessionId=?2 AND role='user'",
        params![stats.turn_id, stats.session_id, meta.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionStats {
    pub schema: &'static str,
    pub rule: &'static str,
    pub source: &'static str,
    pub session_id: String,
    pub scope: &'static str,
    pub complete: bool,
    pub rounds: Option<usize>,
    pub steps: Option<usize>,
    pub observed_turns: usize,
    pub unobserved_turns: usize,
    pub model_ms: Option<u64>,
    pub ttft_ms: Option<u64>,
    pub tps: Option<f64>,
}

/// 整会话全部user元信息；不使用UI分页、assistant消息或压缩后的上下文投影。
pub(crate) fn read_session(conn: &Connection, session_id: &str) -> Result<SessionStats, String> {
    if conn.query_row("SELECT id FROM session WHERE id=?1", [session_id], |r| r.get::<_, String>(0))
        .optional().map_err(|e| e.to_string())?.is_none() { return Err("会话不存在".into()); }
    let mut stmt = conn.prepare("SELECT id,metaJson FROM message WHERE sessionId=?1 AND role='user' ORDER BY createdAt,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([session_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut all = BTreeMap::new();
    let mut turns = std::collections::BTreeSet::new();
    let mut observed = 0usize;
    let mut unobserved = 0usize;
    let mut complete = true;
    let mut last = None;
    for row in rows {
        let (turn_id, raw) = row.map_err(|e| e.to_string())?;
        last = None;
        let marker = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("sessionStats").cloned())
            .and_then(|v| serde_json::from_value::<TurnStats>(v).ok())
            .filter(|v| v.valid(session_id, &turn_id));
        let Some(marker) = marker else { unobserved += 1; complete = false; continue; };
        observed += 1;
        complete &= marker.complete;
        for step in marker.closed_steps {
            turns.insert(step.turn_id.clone());
            last = step.timing.clone();
            all.entry((step.turn_id.clone(), step.step_id.clone())).or_insert(step);
        }
    }
    complete &= observed > 0;
    let model_ms = if complete && !all.is_empty() {
        all.values().try_fold(0u64, |n, step| n.checked_add(step.timing.as_ref()?.model_ms))
    } else { None };
    let ttft_ms = last.as_ref().and_then(|t| t.ttft_ms);
    let tps = last.and_then(|t| match (t.output_tokens, t.decode_ms) {
        (Some(output), Some(ms)) if output >= 0 && ms > 0 => Some((output as f64 * 10_000.0 / ms as f64).round() / 10.0),
        _ => None,
    });
    Ok(SessionStats { schema: SNAPSHOT_SCHEMA, rule: "dsh", source: if observed > 0 {"platform"} else {"unknown"},
        session_id: session_id.into(), scope: if observed == 0 {"unknown"} else if complete {"session"} else {"partial"},
        complete, rounds: (observed > 0).then_some(turns.len()), steps: (observed > 0).then_some(all.len()),
        observed_turns: observed, unobserved_turns: unobserved, model_ms, ttft_ms, tps })
}

#[tauri::command]
pub(crate) fn chat_session_stats(session_id: String) -> Result<SessionStats, String> {
    let guard = crate::db::conn()?;
    read_session(guard.as_ref().ok_or("db not initialized")?, &session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY, updatedAt INTEGER);
            CREATE TABLE message(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, metaJson TEXT, createdAt INTEGER);").unwrap();
        c.execute("INSERT INTO session VALUES('s1',1)", []).unwrap();
        c.execute("INSERT INTO session VALUES('s2',1)", []).unwrap();
        c.execute("INSERT INTO message(id,sessionId,role,content,createdAt) VALUES('t1','s1','user','hi',1)", []).unwrap();
        c.execute("INSERT INTO message(id,sessionId,role,content,createdAt) VALUES('t2','s1','user','hi2',2)", []).unwrap();
        c
    }
    fn timing() -> ModelTiming {
        ModelTiming { started_at: 0, finished_at: 10, model_ms: 10, ttft_ms: Some(2), decode_ms: Some(8), output_tokens: Some(5) }
    }
    fn step(turn: &str, id: &str, outcome: &str) -> ClosedStep {
        ClosedStep { event_type: "step/end".into(), session_id: "s1".into(), turn_id: turn.into(), step_id: id.into(),
            outcome: outcome.into(), timing: Some(timing()), usage: Some((10, 5, 0)) }
    }

    #[test]
    fn counts_all_closed_outcomes_and_dedups_repeat() {
        let c = conn();
        let mut a = TurnStats::new("s1", "t1");
        a.closed_steps.push(step("t1", "1", "completed"));
        a.closed_steps.push(step("t1", "2", "failed"));
        save_turn(&c, &a, false).unwrap();
        // 重放同 step 1 + 追加 cancelled/max_tokens；不重复计数、各终态都计一步。
        let mut b = TurnStats::new("s1", "t1");
        b.closed_steps.push(step("t1", "1", "completed"));
        b.closed_steps.push(step("t1", "3", "cancelled"));
        b.closed_steps.push(step("t1", "4", "max_tokens"));
        save_turn(&c, &b, false).unwrap();
        let r = read_session(&c, "s1").unwrap();
        assert_eq!(r.steps, Some(4));
        assert_eq!(r.rounds, Some(1));
        assert_eq!(r.scope, "partial");
        assert!(!r.complete);
    }

    #[test]
    fn two_turns_complete_gives_session_scope() {
        let c = conn();
        let mut a = TurnStats::new("s1", "t1");
        a.closed_steps.push(step("t1", "1", "completed"));
        save_turn(&c, &a, true).unwrap();
        let mut b = TurnStats::new("s1", "t2");
        b.closed_steps.push(step("t2", "1", "completed"));
        b.closed_steps.push(step("t2", "2", "failed"));
        save_turn(&c, &b, true).unwrap();
        let r = read_session(&c, "s1").unwrap();
        assert_eq!(r.rounds, Some(2));
        assert_eq!(r.steps, Some(3));
        assert_eq!(r.scope, "session");
        assert!(r.complete);
    }

    #[test]
    fn no_marker_stays_unknown_not_zero() {
        let c = conn();
        let r = read_session(&c, "s1").unwrap();
        assert_eq!(r.scope, "unknown");
        assert_eq!(r.rounds, None);
        assert_eq!(r.steps, None);
        assert!(!r.complete);
        assert_eq!(r.observed_turns, 0);
    }

    #[test]
    fn rejects_turn_that_does_not_belong_to_session() {
        let c = conn();
        // t1 属于 s1；用 s2 身份更新必须失败，不串会话。
        let mut st = TurnStats::new("s2", "t1");
        st.closed_steps.push(ClosedStep { session_id: "s2".into(), ..step("t1", "1", "completed") });
        assert!(save_turn(&c, &st, true).is_err());
    }

    #[test]
    fn preserves_unrelated_meta_fields() {
        let c = conn();
        c.execute("UPDATE message SET metaJson=?1 WHERE id='t1' AND sessionId='s1'",
            params![r#"{"thinking":"keep","usage":{"inputTokens":1}}"#]).unwrap();
        let mut st = TurnStats::new("s1", "t1");
        st.closed_steps.push(step("t1", "1", "completed"));
        save_turn(&c, &st, false).unwrap();
        let raw: String = c.query_row("SELECT metaJson FROM message WHERE id='t1'", [], |r| r.get(0)).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["thinking"], json!("keep"));
        assert_eq!(v["usage"]["inputTokens"], json!(1));
        assert!(v.get("sessionStats").is_some());
    }

    #[test]
    fn incomplete_observed_turn_yields_partial_and_no_aggregate_timing() {
        let c = conn();
        let mut a = TurnStats::new("s1", "t1");
        a.closed_steps.push(step("t1", "1", "completed"));
        save_turn(&c, &a, false).unwrap(); // t2 无 marker → 未观测
        let r = read_session(&c, "s1").unwrap();
        assert_eq!(r.scope, "partial");
        assert_eq!(r.observed_turns, 1);
        assert_eq!(r.unobserved_turns, 1);
        assert_eq!(r.model_ms, None); // 不把已知子集叫完整累计
        assert!(r.rounds.is_some() && r.steps.is_some());
    }
}
