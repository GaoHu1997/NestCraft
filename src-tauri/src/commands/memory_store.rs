//! CR-092 / FEAT-026：个人记忆数据访问层。
//!
//! 本文件是 `memory_item` / `memory_profile` 两表的唯一 SQL 写入点。
//! 设计依据 docs/DB/DB-FEAT-026-个人记忆数据设计.md：
//! 记忆是派生数据，可删可重建；原文权威仍在 `message` 与 Markdown 笔记。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

/// 原子记忆。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub mem_key: Option<String>,
    pub content: String,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub trust: String,
    pub importance: i64,
    pub confidence: f64,
    pub status: String,
    pub superseded_by: Option<String>,
    pub access_count: i64,
    pub last_access_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 画像摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub scope: String,
    pub fields_json: String,
    pub summary: String,
    pub revision: i64,
}

const ITEM_COLUMNS: &str = "id, scope, kind, memKey, content, sourceType, sourceRef, trust, importance, confidence, status, supersededBy, accessCount, lastAccessAt, createdAt, updatedAt";

/// 幂等建表。
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    migrate_feat026(conn)
}

/// CR-092 迁移：新增派生表与索引；不改任何既有表。
pub fn migrate_feat026(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_item (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            kind TEXT NOT NULL,
            memKey TEXT,
            content TEXT NOT NULL,
            sourceType TEXT NOT NULL,
            sourceRef TEXT,
            trust TEXT NOT NULL DEFAULT 'own',
            importance INTEGER NOT NULL DEFAULT 3,
            confidence REAL NOT NULL DEFAULT 0.7,
            status TEXT NOT NULL DEFAULT 'active',
            supersededBy TEXT,
            accessCount INTEGER NOT NULL DEFAULT 0,
            lastAccessAt INTEGER,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mem_scope ON memory_item(scope, kind, status);
        CREATE INDEX IF NOT EXISTS idx_mem_key ON memory_item(scope, memKey);
        CREATE INDEX IF NOT EXISTS idx_mem_updated ON memory_item(status, updatedAt DESC);

        CREATE TABLE IF NOT EXISTS memory_profile (
            scope TEXT PRIMARY KEY,
            fieldsJson TEXT NOT NULL DEFAULT '{}',
            summary TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        scope: row.get(1)?,
        kind: row.get(2)?,
        mem_key: row.get(3)?,
        content: row.get(4)?,
        source_type: row.get(5)?,
        source_ref: row.get(6)?,
        trust: row.get(7)?,
        importance: row.get(8)?,
        confidence: row.get(9)?,
        status: row.get(10)?,
        superseded_by: row.get(11)?,
        access_count: row.get(12)?,
        last_access_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub fn insert(conn: &Connection, it: &MemoryItem) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO memory_item ({ITEM_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"
        ),
        params![
            it.id, it.scope, it.kind, it.mem_key, it.content, it.source_type, it.source_ref,
            it.trust, it.importance, it.confidence, it.status, it.superseded_by,
            it.access_count, it.last_access_at, it.created_at, it.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<MemoryItem>, String> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM memory_item WHERE id=?1"),
        [id],
        row_item,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 按 scope+kind+memKey 查找当前生效条。
pub fn find_by_key(conn: &Connection, scope: &str, kind: &str, mem_key: &str) -> Result<Option<MemoryItem>, String> {
    conn.query_row(
        &format!(
            "SELECT {ITEM_COLUMNS} FROM memory_item
             WHERE scope=?1 AND kind=?2 AND memKey=?3 AND status='active'
             ORDER BY updatedAt DESC, id DESC LIMIT 1"
        ),
        params![scope, kind, mem_key],
        row_item,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list(
    conn: &Connection,
    scope: Option<&str>,
    kind: Option<&str>,
    status: Option<&str>,
    limit: usize,
) -> Result<Vec<MemoryItem>, String> {
    let mut sql = format!("SELECT {ITEM_COLUMNS} FROM memory_item WHERE 1=1");
    let mut values: Vec<String> = Vec::new();
    if let Some(scope) = scope {
        values.push(scope.to_string());
        sql.push_str(&format!(" AND scope=?{}", values.len()));
    }
    if let Some(kind) = kind {
        values.push(kind.to_string());
        sql.push_str(&format!(" AND kind=?{}", values.len()));
    }
    if let Some(status) = status {
        values.push(status.to_string());
        sql.push_str(&format!(" AND status=?{}", values.len()));
    }
    let limit = limit.clamp(1, 1000);
    sql.push_str(&format!(" ORDER BY updatedAt DESC, id DESC LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), row_item)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn update_content(conn: &Connection, id: &str, content: &str, importance: Option<i64>) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE memory_item SET content=?2, importance=COALESCE(?3, importance), updatedAt=?4 WHERE id=?1",
            params![id, content, importance, crate::models::now_ms()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("记忆不存在：{id}"));
    }
    Ok(())
}

pub fn soft_delete(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE memory_item SET status='deleted', updatedAt=?2 WHERE id=?1",
            params![id, crate::models::now_ms()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("记忆不存在：{id}"));
    }
    Ok(())
}

pub fn hard_delete(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM memory_item WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("记忆不存在：{id}"));
    }
    Ok(())
}

/// 旧条标记被新条取代；保留追溯，不物理删除。
pub fn supersede(conn: &Connection, old_id: &str, new_id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE memory_item SET status='superseded', supersededBy=?2, updatedAt=?3 WHERE id=?1",
            params![old_id, new_id, crate::models::now_ms()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("记忆不存在：{old_id}"));
    }
    Ok(())
}

pub fn touch_access(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE memory_item SET accessCount=accessCount+1, lastAccessAt=?2 WHERE id=?1",
        params![id, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 供画像/检索使用的 active 正文。
pub fn all_active_texts(conn: &Connection, scope: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content FROM memory_item
             WHERE scope=?1 AND status='active'
             ORDER BY importance DESC, updatedAt DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([scope], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn counts(conn: &Connection, scope: &str) -> Result<Value, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_item WHERE scope=?1", [scope], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let active: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_item WHERE scope=?1 AND status='active'", [scope], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let superseded: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_item WHERE scope=?1 AND status='superseded'", [scope], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let deleted: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_item WHERE scope=?1 AND status='deleted'", [scope], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let external: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_item WHERE scope=?1 AND status='active' AND trust='external'",
            [scope],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut by_kind = serde_json::Map::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT kind, COUNT(*) FROM memory_item
                 WHERE scope=?1 AND status='active' GROUP BY kind ORDER BY kind",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([scope], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (kind, count) = row.map_err(|e| e.to_string())?;
            by_kind.insert(kind, json!(count));
        }
    }
    Ok(json!({
        "scope": scope,
        "total": total,
        "active": active,
        "superseded": superseded,
        "deleted": deleted,
        "external": external,
        "byKind": Value::Object(by_kind),
    }))
}

pub fn get_profile(conn: &Connection, scope: &str) -> Result<Profile, String> {
    let found = conn
        .query_row(
            "SELECT scope, fieldsJson, summary, revision FROM memory_profile WHERE scope=?1",
            [scope],
            |r| {
                Ok(Profile {
                    scope: r.get(0)?,
                    fields_json: r.get(1)?,
                    summary: r.get(2)?,
                    revision: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.unwrap_or(Profile {
        scope: scope.to_string(),
        fields_json: "{}".to_string(),
        summary: String::new(),
        revision: 0,
    }))
}

pub fn upsert_profile(conn: &Connection, scope: &str, fields_json: &str, summary: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_profile(scope, fieldsJson, summary, revision, updatedAt)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(scope) DO UPDATE SET
             fieldsJson=excluded.fieldsJson,
             summary=excluded.summary,
             revision=memory_profile.revision+1,
             updatedAt=excluded.updatedAt",
        params![scope, fields_json, summary, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn item(id: &str, scope: &str, kind: &str, key: Option<&str>, content: &str) -> MemoryItem {
        MemoryItem {
            id: id.into(),
            scope: scope.into(),
            kind: kind.into(),
            mem_key: key.map(str::to_string),
            content: content.into(),
            source_type: "manual".into(),
            source_ref: None,
            trust: "own".into(),
            importance: 3,
            confidence: 0.7,
            status: "active".into(),
            superseded_by: None,
            access_count: 0,
            last_access_at: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn migrate_feat026_is_idempotent_and_creates_tables_and_indexes() {
        let conn = conn();
        insert(&conn, &item("m1", "global", "fact", None, "用户使用 Windows")).unwrap();
        migrate_feat026(&conn).unwrap();
        migrate_feat026(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_item", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "重复迁移不得改动数据");
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('memory_item','memory_profile')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
        let indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_mem_scope','idx_mem_key','idx_mem_updated')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 3);
    }

    #[test]
    fn soft_delete_filters_and_hard_delete_removes() {
        let conn = conn();
        insert(&conn, &item("a", "global", "fact", None, "a")).unwrap();
        insert(&conn, &item("b", "global", "fact", None, "b")).unwrap();
        soft_delete(&conn, "a").unwrap();
        assert_eq!(get(&conn, "a").unwrap().unwrap().status, "deleted");
        assert_eq!(list(&conn, Some("global"), None, Some("active"), 10).unwrap().len(), 1);
        assert_eq!(list(&conn, Some("global"), None, None, 10).unwrap().len(), 2);
        hard_delete(&conn, "a").unwrap();
        assert!(get(&conn, "a").unwrap().is_none());
    }

    #[test]
    fn scope_and_kind_filters_are_isolated() {
        let conn = conn();
        insert(&conn, &item("g", "global", "preference", None, "global")).unwrap();
        insert(&conn, &item("p", "project:p1", "preference", None, "project")).unwrap();
        insert(&conn, &item("f", "global", "fact", None, "fact")).unwrap();
        assert_eq!(list(&conn, Some("global"), None, Some("active"), 10).unwrap().len(), 2);
        assert_eq!(list(&conn, Some("project:p1"), None, Some("active"), 10).unwrap().len(), 1);
        assert_eq!(list(&conn, Some("global"), Some("fact"), Some("active"), 10).unwrap().len(), 1);
    }

    #[test]
    fn supersede_keeps_old_row_with_link() {
        let conn = conn();
        insert(&conn, &item("old", "global", "preference", Some("theme"), "喜欢深色")).unwrap();
        insert(&conn, &item("new", "global", "preference", Some("theme"), "喜欢浅色")).unwrap();
        supersede(&conn, "old", "new").unwrap();
        let old = get(&conn, "old").unwrap().unwrap();
        assert_eq!(old.status, "superseded");
        assert_eq!(old.superseded_by.as_deref(), Some("new"));
        assert_eq!(find_by_key(&conn, "global", "preference", "theme").unwrap().unwrap().id, "new");
    }
}
