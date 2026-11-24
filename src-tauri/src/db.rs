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
            updatedAt INTEGER NOT NULL,
            -- CR-069：会话运行通道。'cli' 走既有 CLI 进程；'platform' 由平台主代理作答。
            -- 旧库由 migrate_session_runner 补列并回填 'cli'，行为与升级前一致。
            runner TEXT NOT NULL DEFAULT 'cli' CHECK (runner IN ('cli','platform'))
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
    // CR-063：会话历史分页索引（DB-CR063）。
    migrate_cr063_session_page_index(conn)?;
    // CR-065：会话置顶字段与索引重建（DB-CR064）。
    migrate_cr065_session_pin(conn)?;
    // CR-069：会话运行通道，旧记录默认 'cli'（DB-CR069）。
    migrate_session_runner(conn)?;
    // CR-070：平台摘要与精确回放（原 message 保留）。
    crate::commands::platform_context::migrate(conn)?;
    // CR-030-D1：知识切片与全文索引最小表集（FTS 虚表在库首次发布时创建，不在此建）。
    crate::commands::kb_index::migrate_cr030_knowledge_index(conn)?;
    // CR-058：模型检测历史（DB-CR058）。
    migrate_cr058_model_probe(conn)?;
    // CR-059：密钥协议与模型范围、模型排序、生图配置（DB-CR059）。
    migrate_cr059_model_config(conn)?;
    // CR-059 / BUG-CR059-01 二期：跨进程待审批命令（DB-CR059 §5.1）。
    migrate_cr059_pending_approval(conn)?;
    // CR-047 / FEAT-019 基线：任务执行账本、工作包义务与检查点（DB-FEAT-019 / DB-CR047 的 M0 子集）。
    crate::commands::execution::ensure_schema(conn)?;
    // CR-032 / FEAT-004/005 基线：双向同步共同基线、批次与目标写入日志（DB-CR032 的 M0 子集）。
    crate::commands::sync::ensure_schema(conn)?;
    // CR-047：重启后回收过期租约，把可能已中断的运行置为 blocked，不自动重跑。
    crate::commands::execution::recover_interrupted(conn, now_ms_static())?;

    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (1, ?1)",
        [now],
    )
    .map_err(|e| e.to_string())?;
    // CR-061：不再写入任何内置预置模型供应商。
    // 老装用户库里遗留的预置供应商由用户自行在设置中删除（界面已有删除入口，
    // 删除时会连带清理其独占密钥），不做自动清理——避免替用户做不可逆决定。
    Ok(())
}

/// CR-059 / BUG-CR059-01 二期：内置 AI 工具进程与主应用跨进程共享的待审批命令表。
///
/// `ssh_exec` 运行在独立的 stdio 工具进程里，无法直接调用主应用的进程内审批表，
/// 因此高风险命令的待批请求落到这张表；主应用轮询后弹出审批卡片，用户在 GUI 里
/// 批准/拒绝，工具进程按 requestId 读取结论。过期清理由主应用在轮询时顺带完成。
fn migrate_cr059_pending_approval(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tool_approval (
            id TEXT PRIMARY KEY,
            hostId TEXT NOT NULL,
            command TEXT NOT NULL,
            risk TEXT NOT NULL DEFAULT 'high',
            -- pending | approved | rejected | expired
            status TEXT NOT NULL DEFAULT 'pending',
            origin TEXT NOT NULL DEFAULT 'builtin-tool',
            createdAt INTEGER NOT NULL,
            decidedAt INTEGER,
            note TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_tool_approval_status ON tool_approval(status, createdAt DESC);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// CR-063：会话历史分页索引（DB-CR063）。只建索引、不改表；重复执行幂等。
/// 三个索引分别覆盖 project-only / server-only / project+server 同时等值的排序前缀。
fn migrate_cr063_session_page_index(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_session_project_updated ON session(projectId, updatedAt DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_session_server_updated ON session(serverId, updatedAt DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_session_scope_updated ON session(projectId, serverId, updatedAt DESC, id DESC);",
    )
    .map_err(|e| e.to_string())
}

/// CR-065：会话置顶字段与索引重建（DB-CR064）。幂等：列已存在则跳过 ALTER，索引已含 pinnedAt 则跳过重建。
fn migrate_cr065_session_pin(conn: &Connection) -> Result<(), String> {
    let has_column: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(session)").map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        names.iter().any(|name| name == "pinnedAt")
    };
    if !has_column {
        conn.execute("ALTER TABLE session ADD COLUMN pinnedAt INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|e| e.to_string())?;
    }

    let index_fresh: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_session_project_updated' AND sql LIKE '%pinnedAt%'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if index_fresh == 0 {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_session_project_updated;
             DROP INDEX IF EXISTS idx_session_server_updated;
             DROP INDEX IF EXISTS idx_session_scope_updated;
             CREATE INDEX IF NOT EXISTS idx_session_project_updated ON session(projectId, pinnedAt DESC, updatedAt DESC, id DESC);
             CREATE INDEX IF NOT EXISTS idx_session_server_updated ON session(serverId, pinnedAt DESC, updatedAt DESC, id DESC);
             CREATE INDEX IF NOT EXISTS idx_session_scope_updated ON session(projectId, serverId, pinnedAt DESC, updatedAt DESC, id DESC);",
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrate_cr058_model_probe(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS model_probe_history (
            id                TEXT PRIMARY KEY,
            providerId        TEXT NOT NULL,
            providerName      TEXT NOT NULL,
            modelId           TEXT NOT NULL,
            modelDisplayName  TEXT NOT NULL,
            protocol          TEXT NOT NULL,
            score             INTEGER NOT NULL,
            grade             TEXT NOT NULL,
            verdict           TEXT NOT NULL,
            channel           TEXT NOT NULL,
            summary           TEXT NOT NULL,
            durationMs        INTEGER NOT NULL,
            resultJson        TEXT NOT NULL,
            createdAt         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_probe_history_created ON model_probe_history(createdAt DESC);
        "#,
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// CR-059：模型配置与生图（DB-CR059）。全部为幂等 ALTER / CREATE，可重复执行。
/// - provider_key：协议（决定请求端点）、模型范围、范围来源、探测时间
/// - model：排序序号
/// - image_gen_config：单行生图配置（有序模型列表 + 默认参数）
fn migrate_cr059_model_config(conn: &Connection) -> Result<(), String> {
    let key_cols: Vec<String> = conn.prepare("PRAGMA table_info(provider_key)").map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    let mut batch = String::new();
    if !key_cols.iter().any(|n| n == "protocol") {
        batch.push_str("ALTER TABLE provider_key ADD COLUMN protocol TEXT NOT NULL DEFAULT '';");
    }
    if !key_cols.iter().any(|n| n == "modelsJson") {
        batch.push_str("ALTER TABLE provider_key ADD COLUMN modelsJson TEXT;");
    }
    if !key_cols.iter().any(|n| n == "scopeSource") {
        batch.push_str("ALTER TABLE provider_key ADD COLUMN scopeSource TEXT;");
    }
    if !key_cols.iter().any(|n| n == "probedAt") {
        batch.push_str("ALTER TABLE provider_key ADD COLUMN probedAt INTEGER;");
    }
    let model_cols: Vec<String> = conn.prepare("PRAGMA table_info(model)").map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    if !model_cols.iter().any(|n| n == "sortOrder") {
        batch.push_str("ALTER TABLE model ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0;");
    }
    batch.push_str(
        "CREATE TABLE IF NOT EXISTS image_gen_config (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, orderJson TEXT NOT NULL DEFAULT '[]', defaultsJson TEXT NOT NULL DEFAULT '{}', outputDir TEXT NOT NULL DEFAULT 'generated-images', updatedAt INTEGER NOT NULL);",
    );
    if !batch.is_empty() { conn.execute_batch(&batch).map_err(|e| e.to_string())?; }
    // 历史模型按创建顺序补齐排序序号（仅在全部为 0 时执行一次）。
    conn.execute(
        "UPDATE model SET sortOrder = (SELECT COUNT(*) FROM model m2 WHERE m2.providerId = model.providerId AND m2.createdAt <= model.createdAt)
         WHERE NOT EXISTS (SELECT 1 FROM model WHERE sortOrder <> 0)",
        [],
    ).map_err(|e| e.to_string())?;
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

/// CR-069：会话运行通道。旧记录默认 'cli'，行为与现状完全一致。
fn migrate_session_runner(conn: &Connection) -> Result<(), String> {
    let column_exists = {
        let mut statement = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| e.to_string())?;
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .any(|name| name == "runner");
        found
    };
    if !column_exists {
        conn.execute_batch(
            "ALTER TABLE session ADD COLUMN runner TEXT NOT NULL DEFAULT 'cli'
                 CHECK (runner IN ('cli','platform'));",
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "UPDATE session SET runner='cli'
           WHERE runner IS NULL OR runner NOT IN ('cli','platform');
         CREATE INDEX IF NOT EXISTS idx_session_runner ON session(projectId, runner, updatedAt);",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// CR-063：三个分页索引幂等创建，且 project-only / project+server / server-only 查询计划免排序。
    /// CR-065：pinnedAt 字段迁移、索引重建与 project-only 查询计划。
    #[test]
    fn cr065_session_pin_migration_adds_column_and_rebuilds_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL
             );",
        )
        .unwrap();
        migrate_cr063_session_page_index(&conn).unwrap();
        migrate_cr065_session_pin(&conn).unwrap();
        migrate_cr065_session_pin(&conn).unwrap();

        let has: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('session') WHERE name='pinnedAt'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has, 1, "pinnedAt 字段应存在且只添加一次");

        conn.execute("INSERT INTO session (id, title, updatedAt) VALUES ('a','a',1)", []).unwrap();
        let pinned: i64 = conn.query_row("SELECT pinnedAt FROM session WHERE id='a'", [], |r| r.get(0)).unwrap();
        assert_eq!(pinned, 0, "旧行默认未置顶");

        let fresh: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql LIKE '%pinnedAt%' AND name IN ('idx_session_project_updated','idx_session_server_updated','idx_session_scope_updated')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fresh, 3, "三个分页索引都应包含 pinnedAt");

        let mut stmt = conn
            .prepare("EXPLAIN QUERY PLAN SELECT id FROM session WHERE projectId = 'p' ORDER BY pinnedAt DESC, updatedAt DESC, id DESC LIMIT 5")
            .unwrap();
        let detail: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(!detail.iter().any(|d| d.contains("TEMP B-TREE")), "plan: {detail:?}");
    }

    #[test]
    fn cr063_session_page_indexes_are_idempotent_and_used() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL
             );",
        )
        .unwrap();
        migrate_cr063_session_page_index(&conn).unwrap();
        migrate_cr063_session_page_index(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_session_project_updated','idx_session_server_updated','idx_session_scope_updated')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3, "三个索引应各存在一条");

        let plans = [
            ("SELECT id FROM session WHERE projectId = 'p' ORDER BY updatedAt DESC, id DESC LIMIT 5", "project"),
            ("SELECT id FROM session WHERE projectId = 'p' AND serverId = 's' ORDER BY updatedAt DESC, id DESC LIMIT 5", "project+server"),
            ("SELECT id FROM session WHERE serverId = 's' ORDER BY updatedAt DESC, id DESC LIMIT 5", "server"),
        ];
        for (sql, label) in plans {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let detail: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(3))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            assert!(
                !detail.iter().any(|d| d.contains("TEMP B-TREE")),
                "{label} 查询计划出现排序临时表：{detail:?}"
            );
        }
    }

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

    /// CR-069（T-089-01）：旧库结构（无 runner）升级后，既有行得到 runner='cli'，行为不变。
    #[test]
    fn cr069_runner_defaults_to_cli_for_old_rows() {
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
        )
        .unwrap();
        migrate_session_runner(&conn).unwrap();
        let runner: String = conn
            .query_row("SELECT runner FROM session WHERE id='old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runner, "cli", "旧行必须默认 cli，不得改变既有行为");
        // 新插入行不指定 runner 时同样默认 cli
        conn.execute("INSERT INTO session (id, title, createdAt, updatedAt) VALUES ('new','新会话',2,2)", []).unwrap();
        let runner: String = conn
            .query_row("SELECT runner FROM session WHERE id='new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runner, "cli");
    }

    /// CR-069（T-089-02）：迁移幂等——连续执行两次不报错、数据不变。
    #[test]
    fn cr069_runner_migration_is_idempotent() {
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
        )
        .unwrap();
        migrate_session_runner(&conn).unwrap();
        migrate_session_runner(&conn).unwrap();
        let (count, runner): (i64, String) = conn
            .query_row("SELECT COUNT(*), MAX(runner) FROM session", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(runner, "cli");
        // 列不重复
        let cols: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info(session)").unwrap();
            statement.query_map([], |row| row.get::<_, String>(1)).unwrap().filter_map(Result::ok).collect()
        };
        assert_eq!(cols.iter().filter(|name| name == &"runner").count(), 1, "runner 列不应重复");
        assert!(cols.iter().any(|name| name == "runner"));
    }

    /// CR-069（T-089-03）：CHECK 约束生效，非法通道值写入被拒。
    #[test]
    fn cr069_runner_rejects_unknown_value() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, projectId TEXT, serverId TEXT,
                title TEXT NOT NULL DEFAULT '新会话', cliId TEXT, providerId TEXT,
                modelId TEXT, effort TEXT, draft TEXT NOT NULL DEFAULT '',
                unread TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
             );",
        )
        .unwrap();
        migrate_session_runner(&conn).unwrap();
        conn.execute("INSERT INTO session (id, title, createdAt, updatedAt) VALUES ('r','会话',1,1)", []).unwrap();
        assert!(conn
            .execute("UPDATE session SET runner='bogus'", [])
            .is_err(), "runner='bogus' 必须被 CHECK 拒绝");
        // 合法取值可以写入
        conn.execute("INSERT INTO session (id, title, createdAt, updatedAt, runner) VALUES ('p','平台会话',1,1,'platform')", []).unwrap();
        let runner: String = conn.query_row("SELECT runner FROM session WHERE id='p'", [], |r| r.get(0)).unwrap();
        assert_eq!(runner, "platform");
    }

}
