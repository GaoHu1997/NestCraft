//! SQLite 初始化与迁移。
//!
//! 设计依据 docs/DB/DB-FEAT-001-知识授权与工作台数据设计.md（ADR-001）：
//! 正文（需求/知识）保存在 Markdown 文件，SQLite 保存索引、授权、配置与会话。

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

static CONN: Mutex<Option<Connection>> = Mutex::new(None);
static DB_DIR: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
static DB_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// 打开（或创建）数据库并执行迁移。多线程共享一个连接（rusqlite 单写者足够）。
pub fn init(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    crate::commands::knowledge::performance::migrate(&conn)?;
    crate::commands::knowledge::snapshot::migrate(&conn)?;
    crate::commands::knowledge::performance::recover_interrupted(&conn)?;
    crate::commands::knowledge::snapshot::recover_interrupted(&conn)?;
    *DB_PATH.lock().map_err(|_| "数据库路径锁不可用")? = Some(path.to_path_buf());
    // CR-051 r6：登记应用数据目录（workbench.db 所在目录），供头像等受管文件使用。
    *DB_DIR.lock().unwrap() = path.parent().map(|p| p.to_path_buf());
    *CONN.lock().unwrap() = Some(conn);
    Ok(())
}

/// 应用数据目录（db 文件所在目录）；未初始化时显式报错，不猜测路径。
pub fn data_dir() -> Result<std::path::PathBuf, String> {
    DB_DIR
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "db not initialized".to_string())
}

/// Knowledge workers use bounded admission before opening this connection.
/// Other business commands keep the existing shared connection unchanged.
pub fn knowledge_connection() -> Result<Connection, String> {
    let path = DB_PATH.lock().map_err(|_| "数据库路径锁不可用")?
        .clone().ok_or("db not initialized")?;
    let conn = Connection::open_with_flags(path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_millis(250)).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192;").map_err(|e| e.to_string())?;
    Ok(conn)
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
    migrate_mcp_oauth(conn)?;
    migrate_cr051_display_icons(conn)?;
    migrate_cr037_native_binding(conn)?;
    // CR-030-D1：知识切片与全文索引最小表集（FTS 虚表在库首次发布时创建，不在此建）。
    crate::commands::kb_index::migrate_cr030_knowledge_index(conn)?;

    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (1, ?1)",
        [now],
    )
    .map_err(|e| e.to_string())?;
    seed_default_provider(conn, now)?;
    Ok(())
}

fn migrate_mcp_oauth(conn: &Connection) -> Result<(), String> {
    let columns: Vec<String> = conn.prepare("PRAGMA table_info(mcp_server)").map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    let mut batch = String::new();
    if !columns.iter().any(|name| name == "authStatus") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN authStatus TEXT NOT NULL DEFAULT 'unauthenticated';\n"); }
    if !columns.iter().any(|name| name == "authCredentialRef") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN authCredentialRef TEXT;\n"); }
    if !columns.iter().any(|name| name == "authServerMetadataJson") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN authServerMetadataJson TEXT;\n"); }
    if !columns.iter().any(|name| name == "authRevision") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN authRevision INTEGER NOT NULL DEFAULT 0;\n"); }
    if !columns.iter().any(|name| name == "authMode") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN authMode TEXT NOT NULL DEFAULT 'oauth';\n"); }
    if !columns.iter().any(|name| name == "allowInsecureLocalTls") { batch.push_str("ALTER TABLE mcp_server ADD COLUMN allowInsecureLocalTls INTEGER NOT NULL DEFAULT 0;\n"); }
    if !batch.is_empty() { conn.execute_batch(&batch).map_err(|e| e.to_string())?; }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS mcp_auth_attempt (id TEXT PRIMARY KEY,mcpServerId TEXT NOT NULL,stateHash TEXT NOT NULL,pkceChallenge TEXT NOT NULL,redirectUri TEXT NOT NULL,authorizationServer TEXT,expiresAt INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_mcp_auth_attempt_expiry ON mcp_auth_attempt(mcpServerId,status,expiresAt);").map_err(|e| e.to_string())?;
    // 启动回收：内存中的 verifier 与 loopback 监听随进程消失，残留 pending 不可恢复。
    let now = now_ms_static();
    conn.execute("UPDATE mcp_auth_attempt SET status='expired', updatedAt=?1 WHERE status='pending'", [now]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE mcp_server SET authStatus='unauthenticated', authRevision=authRevision+1 WHERE authStatus='pending'", []).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_ms_static() -> i64 { chrono::Utc::now().timestamp_millis() }

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

/// CR-051：项目与知识库的可选显示字段 `icon TEXT` 与 r6 的 `icon_color TEXT`
/// （内置图标 id／10 个色卡 id，NULL 按类型/来源推导）。
/// 幂等：列已存在则跳过；旧记录保持 NULL，不做批量回填（DB-FEAT-001 CR-051 节）。
fn migrate_cr051_display_icons(conn: &Connection) -> Result<(), String> {
    for table in ["project", "knowledge_library"] {
        let columns: Vec<String> = {
            let mut statement = conn
                .prepare(&format!("PRAGMA table_info({})", table))
                .map_err(|e| e.to_string())?;
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            names
        };
        if columns.is_empty() {
            return Err(format!("CR-051 迁移前置缺失：表 {} 不存在", table));
        }
        if !columns.iter().any(|name| name == "icon") {
            conn.execute_batch(&format!("ALTER TABLE {} ADD COLUMN icon TEXT;", table))
                .map_err(|e| e.to_string())?;
        }
        if !columns.iter().any(|name| name == "iconColor") {
            conn.execute_batch(&format!("ALTER TABLE {} ADD COLUMN iconColor TEXT;", table))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// CR-037 / STORY-032 AC-05/06：普通会话的原生线程持久绑定。
/// - session 增加可空绑定列（nativeThreadRef 等），旧记录保持 NULL / 0；
/// - 新表 execution_session_turn 持久化每轮 create/resume/fresh 的确认、阻塞与归档结果；
///   零业务外键（不指向 task/attempt/artifact），只挂 session 级联删除；
/// - project_library_grant 增加 revision（写路径同事务递增，撤权保留历史行）。
/// 幂等：逐列检查后追加，重跑不重复加列（模式同 migrate_session_feature_binding）。
fn migrate_cr037_native_binding(conn: &Connection) -> Result<(), String> {
    let columns: Vec<String> = {
        let mut statement = conn.prepare("PRAGMA table_info(session)").map_err(|e| e.to_string())?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        names
    };
    if columns.is_empty() {
        return Err("CR-037 迁移前置缺失：表 session 不存在".to_string());
    }
    let mut batch = String::new();
    if !columns.iter().any(|name| name == "nativeThreadRef") {
        batch.push_str("ALTER TABLE session ADD COLUMN nativeThreadRef TEXT;\n");
    }
    if !columns.iter().any(|name| name == "nativeCompatibilityKey") {
        batch.push_str("ALTER TABLE session ADD COLUMN nativeCompatibilityKey TEXT;\n");
    }
    if !columns.iter().any(|name| name == "nativeGrantRevision") {
        batch.push_str("ALTER TABLE session ADD COLUMN nativeGrantRevision INTEGER;\n");
    }
    if !columns.iter().any(|name| name == "nativeBindingRevision") {
        batch.push_str("ALTER TABLE session ADD COLUMN nativeBindingRevision INTEGER NOT NULL DEFAULT 0;\n");
    }
    if !columns.iter().any(|name| name == "nativeConfirmedTurnId") {
        batch.push_str("ALTER TABLE session ADD COLUMN nativeConfirmedTurnId TEXT;\n");
    }
    if !batch.is_empty() {
        conn.execute_batch(&batch).map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS execution_session_turn (
            id TEXT PRIMARY KEY,               -- = turnId
            sessionId TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            turnSeq INTEGER NOT NULL,          -- 同会话内递增轮次
            mode TEXT NOT NULL CHECK (mode IN ('create','resume','fresh')),
            outcome TEXT NOT NULL CHECK (outcome IN ('confirmed','blocked','archived')),
            reasonCode TEXT,                   -- REF_MISSING/REF_STALE/REF_NOT_READY/INCOMPATIBLE_CLI/
                                               -- INCOMPATIBLE_STORE/GRANT_REVOKED/STOPPED/LATE/
                                               -- ADAPTER_REFUSED/UNSUPPORTED_CLI
            refFingerprint TEXT,               -- 脱敏 sha256 前16；原引用永不落此列
            expectedBindingRevision INTEGER,
            grantRevision INTEGER,
            createdAt INTEGER NOT NULL,
            settledAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_execution_session_turn_session
            ON execution_session_turn(sessionId, createdAt);
        "#,
    )
    .map_err(|e| e.to_string())?;
    let grant_columns: Vec<String> = {
        let mut statement = conn
            .prepare("PRAGMA table_info(project_library_grant)")
            .map_err(|e| e.to_string())?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        names
    };
    if grant_columns.is_empty() {
        return Err("CR-037 迁移前置缺失：表 project_library_grant 不存在".to_string());
    }
    if !grant_columns.iter().any(|name| name == "revision") {
        conn.execute_batch("ALTER TABLE project_library_grant ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

    #[test]
    fn cr037_native_binding_migration_is_additive_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '新会话', cliId TEXT, providerId TEXT,
                modelId TEXT, effort TEXT, draft TEXT NOT NULL DEFAULT '',
                unread TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
             );
             CREATE TABLE project_library_grant (
                projectId TEXT NOT NULL, libraryId TEXT NOT NULL,
                readAllowed INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, actor TEXT,
                PRIMARY KEY (projectId, libraryId)
             );
             INSERT INTO session (id, projectId, title, draft, createdAt, updatedAt)
             VALUES ('old','p1','旧会话','',1,1);
             INSERT INTO project_library_grant (projectId, libraryId, readAllowed, updatedAt)
             VALUES ('p1','kb1',1,1);",
        )
        .unwrap();
        migrate_cr037_native_binding(&conn).unwrap();
        // 旧行保持 NULL / 0
        let (ref_, compat, grant_rev, bind_rev, turn): (Option<String>, Option<String>, Option<i64>, i64, Option<String>) = conn
            .query_row(
                "SELECT nativeThreadRef, nativeCompatibilityKey, nativeGrantRevision, nativeBindingRevision, nativeConfirmedTurnId FROM session WHERE id='old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!((ref_, compat, grant_rev, bind_rev, turn), (None, None, None, 0, None));
        let grant_rev: i64 = conn
            .query_row("SELECT revision FROM project_library_grant WHERE projectId='p1' AND libraryId='kb1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(grant_rev, 0);
        // execution_session_turn 表存在且 CHECK 约束生效
        assert!(conn
            .execute(
                "INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,createdAt) VALUES ('t1','s-missing',1,'resume','confirmed',1)",
                [],
            )
            .is_err());
        conn.execute(
            "INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,createdAt) VALUES ('t1','old',1,'resume','confirmed',1)",
            [],
        )
        .unwrap();
        assert!(conn
            .execute("INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,createdAt) VALUES ('t2','old',2,'bogus','confirmed',1)", [])
            .is_err());
        assert!(conn
            .execute("INSERT INTO execution_session_turn (id,sessionId,turnSeq,mode,outcome,createdAt) VALUES ('t3','old',3,'resume','bogus',1)", [])
            .is_err());
        // 重跑幂等
        migrate_cr037_native_binding(&conn).unwrap();
        let cols: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info(session)").unwrap();
            statement.query_map([], |row| row.get::<_, String>(1)).unwrap().filter_map(Result::ok).collect()
        };
        for name in ["nativeThreadRef", "nativeCompatibilityKey", "nativeGrantRevision", "nativeBindingRevision", "nativeConfirmedTurnId"] {
            assert_eq!(cols.iter().filter(|c| c == &name).count(), 1, "列 {} 不应重复", name);
        }
        // 前置表缺失时报错，不静默通过
        let empty = Connection::open_in_memory().unwrap();
        assert!(migrate_cr037_native_binding(&empty).is_err());
        // 会话删除时轮次记录级联删除
        conn.execute("DELETE FROM session WHERE id='old'", []).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM execution_session_turn", [], |r| r.get::<_, i64>(0)).unwrap(),
            0
        );
    }

    #[test]
    fn mcp_oauth_migration_is_additive_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE mcp_server (id TEXT PRIMARY KEY,name TEXT NOT NULL,transport TEXT NOT NULL,command TEXT,argsJson TEXT,envJson TEXT,url TEXT,enabled INTEGER NOT NULL DEFAULT 1,toolsJson TEXT,createdAt INTEGER NOT NULL); INSERT INTO mcp_server (id,name,transport,createdAt) VALUES ('m1','测试','http',1);").unwrap();
        migrate_mcp_oauth(&conn).unwrap();
        let status: String = conn.query_row("SELECT authStatus FROM mcp_server WHERE id='m1'", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "unauthenticated");
        conn.execute("INSERT INTO mcp_auth_attempt (id,mcpServerId,stateHash,pkceChallenge,redirectUri,expiresAt,status,createdAt,updatedAt) VALUES ('a1','m1','h','c','http://127.0.0.1:1/callback',2,'pending',1,1)", []).unwrap();
        migrate_mcp_oauth(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM mcp_auth_attempt", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(mcp_server)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(Result::ok).collect();
        assert!(columns.iter().any(|name| name == "authStatus"));
    }
    #[test]
    fn mcp_oauth_startup_recovery_expires_pending_attempts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE mcp_server (id TEXT PRIMARY KEY,name TEXT NOT NULL,transport TEXT NOT NULL,command TEXT,argsJson TEXT,envJson TEXT,url TEXT,enabled INTEGER NOT NULL DEFAULT 1,toolsJson TEXT,createdAt INTEGER NOT NULL); INSERT INTO mcp_server (id,name,transport,createdAt) VALUES ('m1','测试','http',1);").unwrap();
        migrate_mcp_oauth(&conn).unwrap();
        conn.execute("UPDATE mcp_server SET authStatus='pending' WHERE id='m1'", []).unwrap();
        conn.execute("INSERT INTO mcp_auth_attempt (id,mcpServerId,stateHash,pkceChallenge,redirectUri,expiresAt,status,createdAt,updatedAt) VALUES ('a1','m1','h','c','http://127.0.0.1:1/callback',9999999999999,'pending',1,1)", []).unwrap();
        // 重启后内存 verifier 丢失，残留 pending 必须被回收。
        migrate_mcp_oauth(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT status FROM mcp_auth_attempt WHERE id='a1'", [], |r| r.get::<_, String>(0)).unwrap(), "expired");
        assert_eq!(conn.query_row("SELECT authStatus FROM mcp_server WHERE id='m1'", [], |r| r.get::<_, String>(0)).unwrap(), "unauthenticated");
    }

    #[test]
    fn cr051_icon_columns_are_additive_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, rootUri TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
             CREATE TABLE knowledge_library (id TEXT PRIMARY KEY, name TEXT NOT NULL, sourceKind TEXT NOT NULL DEFAULT 'managed-directory', sourceRef TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL);
             INSERT INTO project (id, name, type, rootUri, createdAt, updatedAt) VALUES ('p1','旧项目','code','D:/x',1,1);
             INSERT INTO knowledge_library (id, name, sourceRef, createdAt) VALUES ('kb1','旧库','D:/docs',1);",
        ).unwrap();
        migrate_cr051_display_icons(&conn).unwrap();
        // 旧记录保持 NULL，读取时由展示层推导默认图标。
        let (p_icon, k_icon): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT icon FROM project WHERE id='p1'), (SELECT icon FROM knowledge_library WHERE id='kb1')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(p_icon, None);
        assert_eq!(k_icon, None);
        // 重跑迁移不得报错或重复加列。
        migrate_cr051_display_icons(&conn).unwrap();
        let columns: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info(project)").unwrap();
            statement.query_map([], |row| row.get::<_, String>(1)).unwrap().filter_map(Result::ok).collect()
        };
        assert_eq!(columns.iter().filter(|name| name == &"icon").count(), 1);
        // 显式赋值后可读回。
        conn.execute("UPDATE project SET icon='briefcase' WHERE id='p1'", []).unwrap();
        let icon: String = conn.query_row("SELECT icon FROM project WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(icon, "briefcase");
        // 前置表缺失时迁移必须报错，不静默通过。
        let empty = Connection::open_in_memory().unwrap();
        assert!(migrate_cr051_display_icons(&empty).is_err());
    }
}
