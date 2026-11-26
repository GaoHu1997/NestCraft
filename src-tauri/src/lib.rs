//! Agent 工作台 Tauri 后端入口。
//!
//! 模块划分见 docs/LLD/LLD-FEAT-002-Tauri正式实现方案.md：
//! - db: SQLite 连接与迁移（ADR-001：正文 Markdown，SQLite 存索引/授权/配置/会话）
//! - commands: 各模块的 tauri command
//! - ssh: russh 会话管理（服务器模块）

pub mod commands;
pub mod db;
pub mod models;
pub mod ssh;
pub mod storage_layout;
pub mod updater;
pub mod util;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::window::WindowCloseState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                commands::fs::document::destroyed(window.label());
                commands::knowledge::performance::close_window(window.label());
                commands::knowledge::snapshot::close_window(window.label());
                commands::knowledge::preview::close_window(window.label());
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 无条件拦截；缺状态、前端未 ready 或 emit 失败都不能自动关闭。
                    api.prevent_close();
                    if let Err(error) = commands::window::request_close(window.app_handle()) {
                        eprintln!("main window close request blocked: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            let dir = storage_layout::root().map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            // 迁移来源按优先级：上次切换前的数据根 > 系统应用数据目录；合并式迁移幂等不覆盖。
            // 启动同步段只迁核心数据（含数据库）；chat/<cli>-profiles 可达数 GB，放后台续传，
            // 避免跨盘复制阻塞窗口消息循环、被系统判为「未响应」（BUG-001）。
            let mut deferred = Vec::new();
            if let Some(previous) = storage_layout::previous_root() {
                if previous != dir { deferred.extend(storage_layout::migrate_on_startup(&previous, &dir)); }
            }
            if let Ok(legacy) = app.path().app_data_dir() {
                deferred.extend(storage_layout::migrate_on_startup(&legacy, &dir));
            }
            for name in storage_layout::CATEGORIES { let _ = std::fs::create_dir_all(dir.join(name)); }
            commands::fs::document::save::initialize_recovery(dir.join("editor"))
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            // CR-055 FEAT-007：启动时按保留策略（最近 32 条 / 7 天）静默回收已终态保存的
            // backup/temp/journal。失败不影响启动——材料只是诊断与恢复线索，不参与保存正确性。
            let _ = commands::fs::document::save::gc_materials(Default::default());
            // TAURI_SMOKE=1：冒烟测试模式，使用独立隔离库（默认每次全新）并触发前端套件。
            // SMOKE_KEEP_DB=1：保留上次冒烟库——用于 CR-037「重启后仍属原会话」续接验证。
            let smoke = std::env::var("TAURI_SMOKE").is_ok();
            let keep_db = std::env::var("SMOKE_KEEP_DB").map(|v| v == "1").unwrap_or(false);
            let db_file = if smoke { "workbench-smoke.db" } else { "workbench.db" };
            if smoke && !keep_db {
                let _ = std::fs::remove_file(dir.join("db").join(db_file));
                let _ = std::fs::remove_file(dir.join("db").join("workbench-smoke.db-shm"));
                let _ = std::fs::remove_file(dir.join("db").join("workbench-smoke.db-wal"));
            }
            db::init(&dir.join("db").join(db_file))?;
            // CR-092：首启幂等创建内置「个人记忆库」（sourceKind='personal-memory'）与 memory/{画像,记忆,日志}。
            if !smoke {
                if let Ok(guard) = db::conn() {
                    if let Some(conn) = guard.as_ref() {
                        if let Err(error) = commands::memory::ensure_memory_library(conn, &dir) {
                            eprintln!("[CR-092] 个人记忆库初始化失败：{error}");
                        }
                    }
                }
            }
            if !smoke {
                let memory_root=dir.clone();
                std::thread::spawn(move ||{
                    if let Ok(guard)=db::conn() {if let Some(conn)=guard.as_ref() {
                        if let Err(error)=commands::memory::sync_personal_at(conn,&memory_root) {eprintln!("[MEM-FIX-001] 个人记忆回填未完成：{error}");}
                    }}
                });
            }
            // CR-046：清理上次更新留下的旧版程序与未完成下载；保留已就绪的暂存包。
            updater::cleanup(app.handle());
            commands::sdk::seed_sdk_rows_pub()?;
            // CR-057：首次启动自动安装内置示例（编码 / 办公项目 + 知识库）。
            // 幂等且不覆盖：已安装则跳过；失败只记日志不阻塞启动，下次启动重试。
            // 冒烟模式跳过，保持冒烟库的确定性（冒烟夹具自建）。
            // CR-089：模型缺失则首次启动联网下载（不打进安装包），完成后再建索引。
            // CR-097：模型统一落在数据根 `<data>/semantic-model`，旧应用数据目录启动时幂等补齐。
            if !smoke {
                if let Ok(model_dir) = crate::storage_layout::category("semantic-model") {
                    for note in commands::knowledge::semantic::migrate_legacy_root(&model_dir) {
                        eprintln!("[CR-097] 语义模型迁移：{note}");
                    }
                    commands::knowledge::semantic::set_model_root(model_dir);
                }
                let semantic_handle = app.handle().clone();
                std::thread::spawn(move || {
                    use tauri::Emitter;
                    if !commands::knowledge::semantic::model_available() {
                        eprintln!("[CR-089] 本地语义模型未安装，开始首次下载（约 41MB）");
                        let mut progress = |phase: &str, done: u64, total: u64| {
                            let _ = semantic_handle.emit(
                                "kb-semantic-progress",
                                serde_json::json!({ "phase": phase, "done": done, "total": total }),
                            );
                        };
                        let cancel = std::sync::atomic::AtomicBool::new(false);
                        match commands::knowledge::semantic::install::install_runtime(&mut progress, &cancel) {
                            Ok(dir) => eprintln!("[CR-089] 模型下载完成：{}", dir.display()),
                            Err(error) => {
                                eprintln!("[CR-089] 模型下载失败（检索仅用关键词）：{error}");
                                let _ = semantic_handle.emit("kb-semantic-error", serde_json::json!({ "error": error }));
                                return;
                            }
                        }
                    }
                    let libraries: Vec<String> = match crate::db::conn() {
                        Ok(guard) => match guard.as_ref() {
                            Some(conn) => conn.prepare("SELECT id FROM knowledge_library WHERE enabled=1")
                                .and_then(|mut stmt| stmt.query_map([], |row| row.get::<_, String>(0))
                                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>()))
                                .unwrap_or_default(),
                            None => Vec::new(),
                        },
                        Err(_) => Vec::new(),
                    };
                    for library in libraries {
                        let cancel = std::sync::atomic::AtomicBool::new(false);
                        let started = std::time::Instant::now();
                        match commands::knowledge::semantic::rebuild_library_embeddings(&library, &cancel, &|done, total| {
                            if total > 0 && done % 200 == 0 { eprintln!("[CR-089] 语义索引 {library}: {done}/{total}"); }
                        }) {
                            Ok(count) => eprintln!("[CR-089] 语义索引完成 {library}: {count} 块, {}ms", started.elapsed().as_millis()),
                            Err(error) => eprintln!("[CR-089] 语义索引失败 {library}: {error}"),
                        }
                    }
                });
            }
            if !smoke {
                match commands::examples_seed::ensure_seeded(app.handle()) {
                    Ok(report) => {
                        for warning in &report.warnings {
                            eprintln!("examples seed warning: {warning}");
                        }
                    }
                    Err(error) => eprintln!("examples seed failed: {error}"),
                }
                // CR-083：首次启动预置 4 个演示样例项目（对齐项目管理设计稿）。幂等、不复活、不阻塞。
                if let Err(error) = commands::demo_seed::ensure_seeded(app.handle()) {
                    eprintln!("demo seed failed: {error}");
                }
            }
            if smoke {
                use tauri::Manager;
                // 把 mock CLI 钉进 SDK 登记路径，保证会话链路确定性（mockbin/claude.cmd 等）
                if let Some(mock_dir) = std::env::var_os("SMOKE_MOCKBIN") {
                    let guard = db::conn()?;
                    if let Some(conn) = guard.as_ref() {
                        for id in ["claude", "codex", "grok"] {
                            let p = std::path::Path::new(&mock_dir).join(format!("{}.exe", id));
                            if p.is_file() {
                                let _ = conn.execute(
                                    "UPDATE cli_sdk SET path=?2, installState='installed', version='9.9.9-mock' WHERE id=?1",
                                    rusqlite::params![id, p.to_string_lossy()],
                                );
                            }
                        }
                    }
                }
                let _ = commands::smoke::seed_live_key_from_env();
                let _ = commands::smoke::smoke_instrument(app.get_webview_window("main").unwrap());
            }
            // 窗口与数据库就绪后再做后台续传，避免和启动同步段争 IO。
            storage_layout::log_startup(&dir, "setup finished; window ready");
            storage_layout::spawn_deferred_migration(dir.clone(), deferred);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 通用
            commands::general::ping,
            // CR-057：内置示例安装（setup 已自动执行；此命令供前端查询 / 手动补装，幂等）
            commands::examples_seed::seed_example_workspace,
            // CR-044：所有 main 原生关闭来源统一使用一次性 token 门控
            commands::window::window_request_close,
            commands::window::window_confirm_close,
            commands::window::window_cancel_close,
            commands::window::window_pending_close,
            // 冒烟测试支撑（TAURI_SMOKE=1）
            commands::smoke::smoke_should_run,
            commands::smoke::smoke_autorun_flag,
            commands::smoke::smoke_prepare_fixtures,
            commands::smoke::smoke_report_write,
            commands::smoke::smoke_report_write_execution,
            commands::smoke::smoke_exec_suite_flag,
            commands::smoke::smoke_pin_suite_flag,
            commands::smoke::smoke_report_write_pin,
            commands::smoke::smoke_grok_suite_flag,
            commands::smoke::smoke_dual_suite_flag,
            commands::smoke::smoke_token_suite_flag,
            commands::smoke::smoke_report_write_grok,
            commands::smoke::smoke_instrument,
            commands::smoke::smoke_spawn_probe,
            commands::smoke::smoke_mock_full,
            commands::smoke::smoke_channel_probe,
            commands::smoke::smoke_start_ssh,
            commands::smoke::smoke_use_real_claude,
            commands::smoke::smoke_use_real_cli,
            commands::smoke::smoke_mock_resume,
            commands::smoke::smoke_keep_db_flag,
            commands::smoke::smoke_gateway_record,
            commands::smoke::smoke_set_tierflow_key,
            commands::smoke::smoke_progress,
            commands::smoke_seed::smoke_seed_chat_demo,
            commands::general::app_data_dir,
            commands::general::get_setting,
            commands::general::set_setting,
            commands::general::storage_data_dir,
            commands::general::storage_set_data_dir,
            commands::general::get_theme,
            commands::general::set_theme,
            commands::general::get_avatar_style,
            commands::general::set_avatar_style,
            commands::general::get_avatar_image,
            commands::general::set_avatar_image,
            commands::general::save_avatar,
            commands::general::clear_avatar_image,
            commands::general::avatar_image_data,
            // 项目与需求
            commands::projects::list_projects,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::projects::read_requirements,
            commands::projects::read_requirement_sources,
            commands::projects::read_doc,
            commands::projects::write_doc,
            // 文件系统（编码区）
            commands::fs::fs_list_dir,
            commands::fs::fs_list_tree,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_delete_file,
            commands::fs::ops::fs_create_file,
            commands::fs::ops::fs_create_dir,
            commands::fs::ops::fs_rename,
            commands::fs::ops::fs_delete_path,
            commands::fs::ops::fs_path_exists,
            commands::fs::fs_search,
            commands::fs::performance::fs_perf_dir_page,
            commands::fs::performance::fs_perf_search_start,
            commands::fs::performance::fs_perf_search_poll,
            commands::fs::performance::fs_perf_cancel,
            commands::fs::document::read::fs_perf_open_document,
            commands::fs::document::read::fs_perf_read_window,
            commands::fs::document::read::fs_perf_close_document,
            commands::fs::document::read::fs_perf_release_file,
            commands::fs::document::save::fs_perf_save_begin_v2,
            commands::fs::document::save::fs_perf_save_append_v2,
            commands::fs::document::save::fs_perf_save_seal_v2,
            commands::fs::document::save::fs_perf_save_commit_v2,
            commands::fs::document::save::fs_perf_save_status_v2,
            commands::fs::document::save::fs_perf_save_abort_v2,
            commands::fs::document::save::fs_perf_save_release_v2,
            commands::fs::app_data_ensure_dir,
            commands::fs::pick_project_directory,
            commands::fs::pick_local_files,
            // Git
            commands::gitcmd::git_status,
            commands::gitcmd::git_stage,
            commands::gitcmd::git_unstage,
            commands::gitcmd::git_discard,
            commands::gitcmd::git_commit,
            commands::gitcmd::git_diff_file,
            commands::gitcmd::git_branches,
            commands::gitcmd::git_switch_branch,
            commands::gitcmd::git_log,
            commands::gitcmd::git_commit_files,
            commands::gitcmd::git_fetch,
            commands::gitcmd::git_pull_ff_only,
            commands::gitcmd::git_push,
            commands::gitcmd::git_branch_state,
            // Git 侧栏配置（CR-067）：远程、国内加速、按主机令牌
            commands::gitconfig::git_remotes,
            commands::gitconfig::git_remote_save,
            commands::gitconfig::git_remote_remove,
            commands::gitconfig::git_accel_get,
            commands::gitconfig::git_accel_set,
            commands::gitconfig::git_credentials_list,
            commands::gitconfig::git_credentials_save,
            commands::gitconfig::git_credentials_delete,
            commands::gitconfig::git_credential_status,
            // 模型供应商
            commands::providers::provider_list,
            // CR-078：概览页日程 / 待办 / 用量 / 天气
            commands::schedule::schedule_event_list,
            commands::schedule::schedule_event_save,
            commands::schedule::schedule_event_delete,
            commands::schedule::schedule_todo_list,
            commands::schedule::schedule_todo_save,
            commands::schedule::schedule_todo_delete,
            commands::usage_stats::usage_stats,
            commands::weather::weather_current,
            commands::weather::weather_refresh,
            commands::weather::weather_set_enabled,
            commands::providers::provider_save,
            commands::providers::provider_key_reveal,
            commands::providers::provider_reorder,
            commands::providers::provider_models_reorder,
            commands::providers::provider_delete,
            commands::providers::provider_set_disabled,
            commands::providers::model_candidates,
            commands::providers::fingerprint_check,
            commands::providers::provider_discover_models,
            commands::providers::provider_resolve_efforts,
            commands::providers::provider_probe_key_scopes,
            commands::image_gen::image_gen_get,
            commands::image_gen::image_gen_save,
            // CR-058：模型检测九针探针
            commands::model_probe::model_probe_run,
            commands::model_probe::model_probe_history_list,
            // SDK
            commands::sdk::sdk_list,
            // CR-059 D5/E4：缓存先行 + 逐项并发检测
            commands::sdk::sdk_snapshot,
            commands::sdk::sdk_detect_one,
            commands::sdk::sdk_run_job,
            commands::sdk::sdk_job,
            commands::sdk::sdk_cancel,
            commands::sdk::sdk_versions,
            commands::sdk::sdk_set_enabled,
            commands::sdk::sdk_cli_candidates,
            // CR-053：CLI 命令工具（Shell）探测/读取/保存
            commands::shell::cli_shell_candidates,
            commands::shell::cli_shell_get,
            commands::shell::cli_shell_save,
            // 能力
            commands::capabilities::skill_list,
            commands::capabilities::skill_save,
            commands::capabilities::skill_delete,
            commands::capabilities::skill_set_enabled,
            commands::capabilities::skill_read,
            // CR-059 F1/F2：Skill 文件夹识别/导入与跨 agent 扫描
            commands::capabilities::skill_folder_preview,
            commands::capabilities::skill_import_folder,
            commands::capabilities::skill_scan_sources,
            commands::capabilities::tool_list,
            commands::capabilities::tool_set_enabled,
            // CR-093/CR-104：AI 本地与联网搜索（会话级授权 + 联网后端配置）
            commands::search_tools::search_session_scope_get,
            commands::search_tools::search_session_dirs_add,
            commands::search_tools::search_session_dirs_remove,
            commands::search_tools::search_config_get,
            commands::search_tools::search_config_set,
            commands::capabilities::mcp_list,
            commands::capabilities::mcp_save,
            commands::capabilities::mcp_delete,
            commands::capabilities::mcp_set_enabled,
            commands::capabilities::mcp_discover_tools,
            commands::capabilities::mcp_auth_start,
            commands::capabilities::mcp_auth_status,
            commands::capabilities::mcp_auth_logout,
            // CR-059 F4：MCP 跨 agent 扫描导入
            commands::capabilities::mcp_scan_sources,
            commands::capabilities::mcp_import_source,
            // 会话
            commands::chat::chat_sessions,
            commands::chat::chat_sessions_page,
            commands::chat::chat_session_create,
            commands::chat::chat_session_get,
            commands::chat::chat_session_set_permission,
            commands::chat::chat_session_update,
            commands::chat::chat_session_delete,
            commands::chat::chat_session_pin,
            commands::chat::chat_session_fork,
            commands::chat::chat_messages,
            commands::chat::stats::chat_session_stats,
            commands::chat::chat_send,
            commands::chat::chat_abort,
            commands::chat::chat_status,
            commands::chat::chat_approve_tool,
            // 待发恢复 / 配额 / 运行时退出横幅（只读）
            commands::chat::chat_action_status,
            // CR-037：侧栏原生续接——fresh 重建确认
            commands::chat_binding::chat_session_confirm_fresh,
            // 服务器
            commands::servers::server_list,
            commands::servers::server_save,
            commands::servers::server_delete,
            commands::servers::server_connect,
            commands::servers::server_disconnect,
            // 测试连接：不保存表单也可验证主机可达并取回系统名
            commands::servers::server_test_connection,
            commands::servers::server_term_open,
            commands::servers::server_term_input,
            commands::servers::server_term_resize,
            commands::servers::server_term_close,
            commands::servers::server_tree,
            commands::servers::server_read_file,
            commands::servers::server_exec,
            commands::servers::server_exec_approved,
            commands::servers::server_exec_reject,
            // CR-059 二期：内置 AI 工具高风险命令的跨进程审批
            commands::servers::server_pending_approvals,
            commands::servers::server_decide_approval,
            commands::servers::server_metrics,
            commands::servers::server_ai_exec,
            // 知识库
            commands::knowledge::kb_list,
            commands::knowledge::kb_save,
            commands::knowledge::kb_create_library,
            commands::knowledge::kb_set_icon,
            commands::knowledge::kb_set_icon_color,
            commands::knowledge::kb_set_appearance,
            commands::knowledge::kb_update_meta,
            commands::knowledge::kb_delete,
            commands::knowledge::kb_scan,
            commands::knowledge::kb_tree,
            commands::knowledge::kb_read,
            // CR-045：本人知识文件管理；不加入 AI 写入网关
            commands::knowledge::kb_create_folder,
            commands::knowledge::kb_create_markdown,
            commands::knowledge::kb_save_markdown,
            commands::knowledge::kb_create_richtext,
            commands::knowledge::kb_save_richtext,
            commands::knowledge::kb_rename_doc,
            commands::knowledge::kb_delete_doc,
            commands::knowledge::kb_move_doc,
            commands::knowledge::kb_copy_doc,
            commands::knowledge::kb_import_docs,
            commands::knowledge::kb_recycle_doc,
            commands::knowledge::kb_recycle_list,
            commands::knowledge::kb_recycle_restore,
            commands::knowledge::kb_recycle_purge,
            commands::knowledge::kb_write_media,
            commands::knowledge::kb_upload_files,
            commands::knowledge::kb_file_info,
            commands::knowledge::kb_read_file,
            commands::knowledge::kb_export_file,
            // CR-084 FEAT-009: owner-only PDF ranges and local Office previews.
            commands::knowledge::preview::kb_preview_open,
            commands::knowledge::preview::kb_preview_read,
            commands::knowledge::preview::kb_preview_close,
            // CR-088 FEAT-009: derived wikilink index, backlinks and rename preview.
            commands::knowledge::links::kb_links_backlinks,
            commands::knowledge::links::kb_links_outgoing,
            commands::knowledge::links::kb_links_resolve,
            commands::knowledge::links::kb_links_rename_preview,
            commands::knowledge::links::kb_links_rebuild,
            // CR-089 FEAT-009: 图谱与内置知识工具（进程内只读）。
            commands::knowledge::graph::kb_graph,
            commands::knowledge::tools::kb_tool_search,
            commands::knowledge::tools::kb_tool_read,
            commands::knowledge::tools::kb_tool_links,
            commands::knowledge::tools::kb_tool_graph,
            commands::knowledge::tools::kb_tool_list,
            // CR-092 FEAT-026：个人记忆命令（UI 记忆管理界面）
            commands::memory_tools::memory_list_items,
            commands::memory_tools::memory_get_item,
            commands::memory_tools::memory_update_item,
            commands::memory_tools::memory_delete_item,
            commands::memory_tools::memory_get_profile,
            commands::memory_tools::memory_update_profile,
            commands::memory_tools::memory_stats,
            commands::memory_tools::memory_ensure_library,
            commands::memory_tools::memory_resediment_session,
            // CR-089：语义模型状态与首次下载。
            commands::knowledge::semantic::install::kb_semantic_model_state,
            commands::knowledge::semantic::install::kb_semantic_install,
            // CR-097：本机受管 Office 转换组件的状态与首次准备（下载 + 行政解包）
            commands::kb_office::kb_office_state,
            commands::kb_office::kb_office_prepare,
            // CR-055 FEAT-008: owner metadata tasks; not AI mutation tools.
            commands::knowledge::performance::kb_list_children,
            commands::knowledge::performance::kb_scan_start,
            commands::knowledge::performance::kb_task_status,
            commands::knowledge::performance::kb_task_cancel,
            commands::knowledge::performance::kb_search_indexed,
            commands::knowledge::performance::kb_search_cancel,
            commands::knowledge::performance::windows::kb_open_document,
            commands::knowledge::performance::windows::kb_read_window,
            commands::knowledge::performance::windows::kb_close_document,
            commands::knowledge::performance::windows::kb_search_document,
            commands::knowledge::performance::windows::kb_search_document_cancel,
            // CR-055 FEAT-008: immutable index generations remain human-searchable while rebuilding.
            commands::knowledge::snapshot::kb_index_start,
            commands::knowledge::snapshot::kb_index_rebuild_sqlite,
            commands::knowledge::snapshot::kb_index_status,
            commands::knowledge::snapshot::kb_index_cancel,
            // CR-055 FEAT-008: bounded GB-scale original transfer tasks (progress/cancel; index stays pending).
            commands::knowledge::transfers::kb_transfer_import,
            commands::knowledge::transfers::kb_transfer_export,
            commands::knowledge::transfers::kb_transfer_status,
            commands::knowledge::transfers::kb_transfer_cancel,
            commands::knowledge::kb_search,
            commands::knowledge::kb_grants,
            commands::knowledge::kb_grant_set,
            commands::knowledge::kb_gateway,
            // CR-047 / FEAT-019：任务执行账本与工作包（M0；不 spawn CLI）
            commands::execution::execution_batch_create,
            commands::execution::execution_batch_list,
            commands::execution::execution_batch_get,
            commands::execution::execution_task_claim,
            commands::execution::execution_task_list,
            commands::execution::execution_event_list,
            commands::execution::execution_task_transition,
            commands::execution::execution_checkpoint_save,
            commands::execution::execution_checkpoint_latest,
            commands::execution::execution_recovery_inspect,
            commands::execution::execution_recovery_resume,
            commands::execution::execution_package_create,
            commands::execution::execution_package_confirm,
            commands::execution::execution_package_get,
            commands::execution::execution_obligation_map,
            commands::execution::execution_plan_create,
            commands::execution::execution_plan_get,
            commands::execution::execution_plan_authorize,
            commands::execution::execution_plan_revoke,
            commands::execution::execution_plan_check,
            commands::execution::execution_plan_task_status,
            commands::execution::execution_approval_request,
            commands::execution::execution_approval_decide,
            commands::execution::execution_approval_pending,
            commands::execution::execution_approval_get,
            commands::execution::execution_dispatch_once,
            // CR-032 / FEAT-004/005：双向同步基线、批次与目标对账（M0；不自动写文件）
            commands::sync::sync_baseline_current,
            commands::sync::sync_baseline_publish,
            commands::sync::sync_batch_create,
            commands::sync::sync_batch_get,
            commands::sync::sync_batch_decide,
            commands::sync::sync_target_stage,
            commands::sync::sync_target_apply,
            commands::sync::sync_target_write,
            commands::sync::sync_reconcile_pending,
            commands::sync::sync_batch_list,
            commands::sync::sync_publish_baseline,
            commands::sync::sync_target_preview,
            commands::sync::sync_batch_reconcile,
            // CR-046：右上角软件更新入口
            commands::updater::update_environment,
            commands::updater::update_check,
            commands::updater::update_download,
            commands::updater::update_status,
            commands::updater::update_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
