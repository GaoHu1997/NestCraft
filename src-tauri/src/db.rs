//! SQLite 初始化与迁移。
//!
//! 设计依据 docs/DB/DB-FEAT-001-知识授权与工作台数据设计.md（ADR-001）：
//! 正文（需求/知识）保存在 Markdown 文件，SQLite 保存索引、授权、配置与会话。

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

static CONN: Mutex<Option<Connection>> = Mutex::new(None);

/// 打开（或创建）数据库并执行迁移。多线程共享一个连接（rusqlite 单写者足够）。
pub fn init(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    *CONN.lock().unwrap() = Some(conn);
    Ok(())
}

/// 供命令模块获取共享连接。
pub fn conn() -> Result<std::sync::MutexGuard<'static, Option<Connection>>, String> {
    CONN.lock().map_err(|e| e.to_string())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            appliedAt INTEGER NOT NULL
        );

        -- 项目（DB-FEAT-001 §2）
        CREATE TABLE IF NOT EXISTS project (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('code','work')),
            rootUri TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );

        -- 需求索引（仅派生投影，正文的唯一事实来源在 Markdown）
        CREATE TABLE IF NOT EXISTS requirement_index (
            projectId TEXT NOT NULL,
            entityId TEXT NOT NULL,
            type TEXT NOT NULL,
            parentId TEXT,
            title TEXT NOT NULL,
            status TEXT,
            owner TEXT,
            sourceUri TEXT NOT NULL,
            contentHash TEXT,
            indexedAt INTEGER NOT NULL,
            PRIMARY KEY (projectId, entityId),
            UNIQUE (projectId, sourceUri)
        );

        -- 知识库与条目索引
        CREATE TABLE IF NOT EXISTS knowledge_library (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sourceKind TEXT NOT NULL DEFAULT 'managed-directory',
            sourceRef TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_note_index (
            libraryId TEXT NOT NULL,
            noteId TEXT NOT NULL,
            title TEXT NOT NULL,
            relativeUri TEXT NOT NULL,
            contentHash TEXT,
            updatedAt INTEGER NOT NULL,
            PRIMARY KEY (libraryId, noteId),
            UNIQUE (libraryId, relativeUri)
        );

        -- 项目-知识库授权（无记录即拒绝）
        CREATE TABLE IF NOT EXISTS project_library_grant (
            projectId TEXT NOT NULL,
            libraryId TEXT NOT NULL,
            readAllowed INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL,
            actor TEXT,
            PRIMARY KEY (projectId, libraryId)
        );

        -- 模型供应商 / 密钥 / 端点 / 模型（CR-012 语义）
        CREATE TABLE IF NOT EXISTS provider (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            protocol TEXT NOT NULL,            -- anthropic | openai
            disabled INTEGER NOT NULL DEFAULT 0,
            headersJson TEXT,                  -- 高级请求头
            fingerprintJson TEXT,              -- 指纹检测结果
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_key (
            id TEXT PRIMARY KEY,
            providerId TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
            alias TEXT,
            secretRef TEXT NOT NULL,           -- 指向受管密钥存储的引用，不存明文
            masked TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_endpoint (
            id TEXT PRIMARY KEY,
            providerId TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
            protocol TEXT NOT NULL,            -- anthropic | openai
            baseUrl TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model (
            id TEXT PRIMARY KEY,
            providerId TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
            modelId TEXT NOT NULL,
            displayName TEXT NOT NULL,
            text INTEGER NOT NULL DEFAULT 1,
            vision INTEGER NOT NULL DEFAULT 0,
            imageGen INTEGER NOT NULL DEFAULT 0,
            effortsJson TEXT NOT NULL DEFAULT '{}',   -- 思考档位表（off/low/.../max -> wire 拼写）
            defaultEffort TEXT,
            contextWindow INTEGER,
            maxTokens INTEGER,
            createdAt INTEGER NOT NULL,
            UNIQUE (providerId, modelId)
        );

        -- CLI SDK（CR-012：codex/claude/grok）
        CREATE TABLE IF NOT EXISTS cli_sdk (
            id TEXT PRIMARY KEY,               -- codex | claude | grok
            package TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            installState TEXT NOT NULL DEFAULT 'unknown', -- installed | not-installed | checking | error
            version TEXT,
            path TEXT,
            updatedAt INTEGER NOT NULL
        );

        -- 能力注册（tool/resource/prompt/skill/client-command）
        CREATE TABLE IF NOT EXISTS capability (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            sourceRef TEXT,
            schemaJson TEXT,
            risk TEXT NOT NULL DEFAULT 'low',  -- low | medium | high
            enabled INTEGER NOT NULL DEFAULT 1,
            builtin INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_kind_name ON capability(kind, name);

        -- MCP 服务器配置（stdio/http）
        CREATE TABLE IF NOT EXISTS mcp_server (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            transport TEXT NOT NULL,           -- stdio | http
            command TEXT,
            argsJson TEXT,
            envJson TEXT,
            url TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            toolsJson TEXT,                    -- 已发现的工具清单缓存
            createdAt INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_name ON mcp_server(name);

        -- 会话与消息
        CREATE TABLE IF NOT EXISTS session (
            id TEXT PRIMARY KEY,
            projectId TEXT,
            serverId TEXT,
            title TEXT NOT NULL DEFAULT '新会话',
            cliId TEXT,
            providerId TEXT,
            modelId TEXT,
            effort TEXT,
            draft TEXT NOT NULL DEFAULT '',
            unread TEXT,                       -- none|green|red|yellow
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            role TEXT NOT NULL,                -- user | assistant | tool_use | tool_result | system
            content TEXT NOT NULL,
            metaJson TEXT,                     -- 工具名/参数/结果/子代理/用量等结构化附加
            refsJson TEXT,                     -- 结构化上下文引用
            gitContextJson TEXT,               -- 消息当时的 Git 基线
            createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_message_session ON message(sessionId, createdAt);

        -- 设置（全局默认，键值；scope 预留 project）
        CREATE TABLE IF NOT EXISTS setting_default (
            scope TEXT NOT NULL DEFAULT 'global',
            key TEXT NOT NULL,
            value TEXT,
            updatedAt INTEGER NOT NULL,
            PRIMARY KEY (scope, key)
        );

        -- 项目 UI 偏好（CR-006：左栏 file/git 等）
        CREATE TABLE IF NOT EXISTS project_ui_preference (
            projectId TEXT PRIMARY KEY,
            key TEXT NOT NULL,
            value TEXT,
            updatedAt INTEGER NOT NULL,
            UNIQUE (projectId, key)
        );

        -- 服务器主机（TermX 逻辑对齐：地址/端口/认证/分组/状态）
        CREATE TABLE IF NOT EXISTS server_host (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            authType TEXT NOT NULL DEFAULT 'password', -- password | key
            secretRef TEXT,                            -- 密码/密钥的受管引用
            groupTag TEXT,
            createdAt INTEGER NOT NULL
        );
        "#
    )
    .map_err(|e| e.to_string())?;

    migrate_session_feature_binding(conn)?;

    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (1, ?1)",
        [now],
    )
    .map_err(|e| e.to_string())?;
    seed_default_provider(conn, now)?;
    Ok(())
}

fn migrate_session_feature_binding(conn: &Connection) -> Result<(), String> {    let columns: Vec<String> = {
        let mut statement = conn.prepare("PRAGMA table_info(session)").map_err(|e| e.to_string())?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        names
    };
    if !columns.iter().any(|name| name == "featureId") {
        conn.execute_batch(
            "ALTER TABLE session ADD COLUMN featureId TEXT;
             ALTER TABLE session ADD COLUMN featureTitle TEXT;
             ALTER TABLE session ADD COLUMN featureSourceHash TEXT;
             ALTER TABLE session ADD COLUMN sessionRole TEXT NOT NULL DEFAULT 'ordinary';",
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "UPDATE session SET sessionRole='ordinary' WHERE sessionRole IS NULL OR sessionRole NOT IN ('ordinary','executor');
         CREATE INDEX IF NOT EXISTS idx_session_feature ON session(projectId, featureId, updatedAt);",
    )
    .map_err(|e| e.to_string())
}

/// 预置一份可用的供应商模板（仅当库中没有任何供应商时创建）。
/// 目的：新装用户不必手填协议、端点与模型即可发起会话；密钥仍需用户自行填写。
fn seed_default_provider(conn: &Connection, now: i64) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM provider", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let pid = "prov-tierflow-default";
    conn.execute(
        "INSERT INTO provider (id, name, protocol, disabled, headersJson, createdAt, updatedAt)
         VALUES (?1, 'TierFlow（预置，需填密钥）', 'anthropic', 0, NULL, ?2, ?2)",
        rusqlite::params![pid, now],
    )
    .map_err(|e| e.to_string())?;
    // 两种协议各一条端点：claude 走 anthropic，codex/grok 走 openai
    for (eid, proto) in [("ep-tf-anthropic", "anthropic"), ("ep-tf-openai", "openai")] {
        conn.execute(
            "INSERT INTO provider_endpoint (id, providerId, protocol, baseUrl, enabled, createdAt)
             VALUES (?1, ?2, ?3, 'https://tierflow.cn', 1, ?4)",
            rusqlite::params![eid, pid, proto, now],
        )
        .map_err(|e| e.to_string())?;
    }
    // 实测可用的模型（tierflow/tierflow_pro）；生图与视觉未验证，不声明
    for (mid, model_id, label, ctx, max) in [
        ("mdl-tf-1", "tierflow", "TierFlow 标准", 128000i64, 8192i64),
        ("mdl-tf-2", "tierflow_pro", "TierFlow Pro", 128000i64, 8192i64),
    ] {
        conn.execute(
            "INSERT INTO model (id, providerId, modelId, displayName, text, vision, imageGen, effortsJson, defaultEffort, contextWindow, maxTokens, createdAt)
             VALUES (?1, ?2, ?3, ?4, 1, 0, 0, ?5, NULL, ?6, ?7, ?8)",
            rusqlite::params![mid, pid, model_id, label, r#"{"low":"low","medium":"medium","high":"high"}"#, ctx, max, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_feature_migration_is_additive_and_preserves_old_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '新会话', cliId TEXT, providerId TEXT,
                modelId TEXT, effort TEXT, draft TEXT NOT NULL DEFAULT '',
                unread TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
             );
             INSERT INTO session (id, projectId, title, draft, createdAt, updatedAt)
             VALUES ('old','p1','旧会话','',1,1);",
        ).unwrap();
        migrate_session_feature_binding(&conn).unwrap();
        let (role, feature): (String, Option<String>) = conn.query_row(
            "SELECT sessionRole, featureId FROM session WHERE id='old'", [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(role, "ordinary");
        assert_eq!(feature, None);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM session", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        // Re-running the migration must be idempotent.
        migrate_session_feature_binding(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM session", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
}
