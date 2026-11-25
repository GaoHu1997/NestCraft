//! CR-078：概览页日程与待办（DB-CR078）。单机个人数据，软删除；
//! 日期与字段校验在应用层给出中文错误，CHECK 约束只作最后兜底。
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub(crate) const EVENT_COLORS: [&str; 5] = ["blue", "green", "amber", "violet", "rose"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleEvent {
    pub id: String,
    pub title: String,
    pub start_date: String,
    pub end_date: String,
    pub all_day: bool,
    pub start_time: String,
    pub end_time: String,
    pub note: String,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleTodo {
    pub id: String,
    pub date: String,
    pub title: String,
    pub done: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `YYYY-MM-DD` 且能被日期解析接受（拒绝 2026-02-30 这类格式合法但不存在的日期）。
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| (i == 4 || i == 7) || c.is_ascii_digit())
        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// `HH:mm`（分钟级，小时 0–23）。全天事件允许空串。
fn valid_time(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
}

fn validate_event(e: &ScheduleEvent) -> Result<(), String> {
    let title = e.title.trim();
    if title.is_empty() {
        return Err("请填写日程标题".into());
    }
    if title.chars().count() > 80 {
        return Err("日程标题不能超过 80 字".into());
    }
    if !valid_date(&e.start_date) || !valid_date(&e.end_date) {
        return Err("日期格式无效".into());
    }
    if e.end_date < e.start_date {
        return Err("结束日期不能早于开始日期".into());
    }
    if !valid_time(&e.start_time) || !valid_time(&e.end_time) {
        return Err("时间格式无效".into());
    }
    if !e.all_day {
        if e.start_time.is_empty() || e.end_time.is_empty() {
            return Err("请选择开始与结束时间".into());
        }
        if e.end_time < e.start_time {
            return Err("结束时间不能早于开始时间".into());
        }
    }
    if e.note.chars().count() > 200 {
        return Err("备注不能超过 200 字".into());
    }
    if !EVENT_COLORS.contains(&e.color.as_str()) {
        return Err("日程颜色无效".into());
    }
    Ok(())
}

fn validate_todo(t: &ScheduleTodo) -> Result<(), String> {
    let title = t.title.trim();
    if title.is_empty() {
        return Err("请填写待办内容".into());
    }
    if title.chars().count() > 80 {
        return Err("待办内容不能超过 80 字".into());
    }
    if !valid_date(&t.date) {
        return Err("日期格式无效".into());
    }
    Ok(())
}

fn row_event(r: &rusqlite::Row) -> rusqlite::Result<ScheduleEvent> {
    Ok(ScheduleEvent {
        id: r.get(0)?,
        title: r.get(1)?,
        start_date: r.get(2)?,
        end_date: r.get(3)?,
        all_day: r.get::<_, i64>(4)? != 0,
        start_time: r.get(5)?,
        end_time: r.get(6)?,
        note: r.get(7)?,
        color: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn row_todo(r: &rusqlite::Row) -> rusqlite::Result<ScheduleTodo> {
    Ok(ScheduleTodo {
        id: r.get(0)?,
        date: r.get(1)?,
        title: r.get(2)?,
        done: r.get::<_, i64>(3)? != 0,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub(crate) fn list_events(conn: &Connection, from: &str, to: &str) -> Result<Vec<ScheduleEvent>, String> {
    if !valid_date(from) || !valid_date(to) {
        return Err("日期格式无效".into());
    }
    if to < from {
        return Err("结束不能早于开始".into());
    }
    // 区间相交：startDate <= to AND endDate >= from（含跨月覆盖）。
    let mut stmt = conn
        .prepare(
            "SELECT id,title,startDate,endDate,allDay,startTime,endTime,note,color,createdAt,updatedAt
             FROM schedule_event WHERE deletedAt IS NULL AND startDate <= ?2 AND endDate >= ?1
             ORDER BY allDay DESC, startDate, startTime, createdAt",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to], row_event)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

pub(crate) fn save_event(conn: &Connection, event: &ScheduleEvent) -> Result<ScheduleEvent, String> {
    validate_event(event)?;
    let now = chrono::Utc::now().timestamp_millis();
    let exists: bool = conn
        .query_row("SELECT COUNT(*) FROM schedule_event WHERE id=?1 AND deletedAt IS NULL", [&event.id], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .map_err(|e| e.to_string())?;
    if exists {
        conn.execute(
            "UPDATE schedule_event SET title=?2,startDate=?3,endDate=?4,allDay=?5,startTime=?6,endTime=?7,note=?8,color=?9,updatedAt=?10
             WHERE id=?1 AND deletedAt IS NULL",
            params![event.id, event.title.trim(), event.start_date, event.end_date, event.all_day as i64,
                    event.start_time, event.end_time, event.note.trim(), event.color, now],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO schedule_event (id,title,startDate,endDate,allDay,startTime,endTime,note,color,createdAt,updatedAt)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![event.id, event.title.trim(), event.start_date, event.end_date, event.all_day as i64,
                    event.start_time, event.end_time, event.note.trim(), event.color, now],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut out = event.clone();
    out.title = event.title.trim().into();
    out.note = event.note.trim().into();
    out.updated_at = now;
    Ok(out)
}

pub(crate) fn delete_event(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn
        .execute("UPDATE schedule_event SET deletedAt=?2, updatedAt=?2 WHERE id=?1 AND deletedAt IS NULL", params![id, now])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("日程不存在或已删除".into());
    }
    Ok(())
}

pub(crate) fn list_todos(conn: &Connection, date: &str) -> Result<Vec<ScheduleTodo>, String> {
    if !valid_date(date) {
        return Err("日期格式无效".into());
    }
    let mut stmt = conn
        .prepare("SELECT id,date,title,done,createdAt,updatedAt FROM schedule_todo WHERE deletedAt IS NULL AND date=?1 ORDER BY done, createdAt")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([date], row_todo)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

pub(crate) fn save_todo(conn: &Connection, todo: &ScheduleTodo) -> Result<ScheduleTodo, String> {
    validate_todo(todo)?;
    let now = chrono::Utc::now().timestamp_millis();
    let exists: bool = conn
        .query_row("SELECT COUNT(*) FROM schedule_todo WHERE id=?1 AND deletedAt IS NULL", [&todo.id], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .map_err(|e| e.to_string())?;
    if exists {
        conn.execute(
            "UPDATE schedule_todo SET date=?2,title=?3,done=?4,updatedAt=?5 WHERE id=?1 AND deletedAt IS NULL",
            params![todo.id, todo.date, todo.title.trim(), todo.done as i64, now],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO schedule_todo (id,date,title,done,createdAt,updatedAt) VALUES (?1,?2,?3,?4,?5,?5)",
            params![todo.id, todo.date, todo.title.trim(), todo.done as i64, now],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut out = todo.clone();
    out.title = todo.title.trim().into();
    out.updated_at = now;
    Ok(out)
}

pub(crate) fn delete_todo(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let n = conn
        .execute("UPDATE schedule_todo SET deletedAt=?2, updatedAt=?2 WHERE id=?1 AND deletedAt IS NULL", params![id, now])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("待办不存在或已删除".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn schedule_event_list(from: String, to: String) -> Result<Vec<ScheduleEvent>, String> {
    let guard = crate::db::conn()?;
    list_events(guard.as_ref().ok_or("db not initialized")?, &from, &to)
}

#[tauri::command]
pub(crate) fn schedule_event_save(event: ScheduleEvent) -> Result<ScheduleEvent, String> {
    let guard = crate::db::conn()?;
    save_event(guard.as_ref().ok_or("db not initialized")?, &event)
}

#[tauri::command]
pub(crate) fn schedule_event_delete(id: String) -> Result<(), String> {
    let guard = crate::db::conn()?;
    delete_event(guard.as_ref().ok_or("db not initialized")?, &id)
}

#[tauri::command]
pub(crate) fn schedule_todo_list(date: String) -> Result<Vec<ScheduleTodo>, String> {
    let guard = crate::db::conn()?;
    list_todos(guard.as_ref().ok_or("db not initialized")?, &date)
}

#[tauri::command]
pub(crate) fn schedule_todo_save(todo: ScheduleTodo) -> Result<ScheduleTodo, String> {
    let guard = crate::db::conn()?;
    save_todo(guard.as_ref().ok_or("db not initialized")?, &todo)
}

#[tauri::command]
pub(crate) fn schedule_todo_delete(id: String) -> Result<(), String> {
    let guard = crate::db::conn()?;
    delete_todo(guard.as_ref().ok_or("db not initialized")?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, start: &str, end: &str) -> ScheduleEvent {
        ScheduleEvent {
            id: id.into(), title: "评审".into(), start_date: start.into(), end_date: end.into(),
            all_day: true, start_time: "".into(), end_time: "".into(), note: "".into(),
            color: "blue".into(), created_at: 1, updated_at: 1,
        }
    }
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // 内存库无 migrate()，直接建与 db.rs migrate_cr078 相同 DDL 的最小表集。
        conn.execute_batch(
            "CREATE TABLE schedule_event (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, startDate TEXT NOT NULL,
                endDate TEXT NOT NULL CHECK (endDate >= startDate), allDay INTEGER NOT NULL DEFAULT 1,
                startTime TEXT NOT NULL DEFAULT '', endTime TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'blue' CHECK (color IN ('blue','green','amber','violet','rose')),
                createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);
             CREATE TABLE schedule_todo (
                id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn event_validation_rejects_bad_input() {
        let conn = setup();
        // 标题空
        let mut e = event("a", "2026-11-24", "2026-11-24");
        e.title = "  ".into();
        assert_eq!(save_event(&conn, &e).unwrap_err(), "请填写日程标题");
        // 日期倒置
        assert_eq!(save_event(&conn, &event("a", "2026-11-26", "2026-11-20")).unwrap_err(), "结束日期不能早于开始日期");
        // 非法日期（格式对但不存在）
        assert_eq!(save_event(&conn, &event("a", "2026-02-30", "2026-02-30")).unwrap_err(), "日期格式无效");
        // 非法颜色
        let mut c = event("a", "2026-11-24", "2026-11-24");
        c.color = "black".into();
        assert_eq!(save_event(&conn, &c).unwrap_err(), "日程颜色无效");
        // 具体时间倒置
        let mut t = event("a", "2026-11-24", "2026-11-24");
        t.all_day = false;
        t.start_time = "10:00".into();
        t.end_time = "09:00".into();
        assert_eq!(save_event(&conn, &t).unwrap_err(), "结束时间不能早于开始时间");
        // 全天缺时间不允许（all_day=false 但时间为空）
        let mut t2 = event("a", "2026-11-24", "2026-11-24");
        t2.all_day = false;
        assert_eq!(save_event(&conn, &t2).unwrap_err(), "请选择开始与结束时间");
    }

    #[test]
    fn event_save_list_delete_roundtrip() {
        let conn = setup();
        // 创建 + 更新同一 id 不产生重复行
        save_event(&conn, &event("e1", "2026-11-24", "2026-11-25")).unwrap();
        save_event(&conn, &event("e1", "2026-11-24", "2026-11-28")).unwrap();
        // 跨月查询：11 月视图能取到 11-24 开始、11-28 结束的事件
        let nov = list_events(&conn, "2026-10-26", "2026-12-06").unwrap();
        assert_eq!(nov.len(), 1);
        assert_eq!(nov[0].end_date, "2026-11-28");
        // 区间外取不到
        assert!(list_events(&conn, "2026-12-10", "2026-12-20").unwrap().is_empty());
        // 软删除后列表为空、再删除报不存在
        delete_event(&conn, "e1").unwrap();
        assert!(list_events(&conn, "2026-10-26", "2026-12-06").unwrap().is_empty());
        assert_eq!(delete_event(&conn, "e1").unwrap_err(), "日程不存在或已删除");
    }

    #[test]
    fn todo_validation_and_ordering() {
        let conn = setup();
        let mk = |id: &str, title: &str, done: bool| ScheduleTodo {
            id: id.into(), date: "2026-11-24".into(), title: title.into(), done, created_at: 1, updated_at: 1,
        };
        assert_eq!(save_todo(&conn, &mk("t", "", false)).unwrap_err(), "请填写待办内容");
        save_todo(&conn, &mk("t1", "未完成", false)).unwrap();
        save_todo(&conn, &mk("t2", "已完成", true)).unwrap();
        let list = list_todos(&conn, "2026-11-24").unwrap();
        assert_eq!(list.len(), 2);
        assert!(!list[0].done, "未完成应排在已完成之前");
        delete_todo(&conn, "t1").unwrap();
        assert_eq!(list_todos(&conn, "2026-11-24").unwrap().len(), 1);
    }
}
