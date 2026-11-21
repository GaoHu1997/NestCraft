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
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            commands::fs::document::save::initialize_recovery(dir.join("editor-operations"))
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
                let _ = std::fs::remove_file(dir.join(db_file));
                let _ = std::fs::remove_file(dir.join("workbench-smoke.db-shm"));
                let _ = std::fs::remove_file(dir.join("workbench-smoke.db-wal"));
            }
            db::init(&dir.join(db_file))?;
            // CR-046：清理上次更新留下的旧版程序与未完成下载；保留已就绪的暂存包。
            updater::cleanup(app.handle());
            commands::sdk::seed_sdk_rows_pub()?;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 通用
            commands::general::ping,
            // CR-044：所有 main 原生关闭来源统一使用一次性 token 门控
            commands::window::window_request_close,
            commands::window::window_confirm_close,
            commands::window::window_cancel_close,
            commands::window::window_pending_close,
            // 冒烟测试支撑（TAURI_SMOKE=1）
            commands::smoke::smoke_should_run,
            commands::smoke::smoke_prepare_fixtures,
            commands::smoke::smoke_report_write,
            commands::smoke::smoke_instrument,
            commands::smoke::smoke_spawn_probe,
            commands::smoke::smoke_mock_full,
            commands::smoke::smoke_channel_probe,
            commands::smoke::smoke_start_ssh,
            commands::smoke::smoke_use_real_claude,
            commands::smoke::smoke_mock_resume,
            commands::smoke::smoke_keep_db_flag,
            commands::smoke::smoke_gateway_record,
            commands::smoke::smoke_set_tierflow_key,
            commands::smoke::smoke_progress,
            commands::smoke_seed::smoke_seed_chat_demo,
            commands::general::app_data_dir,
            commands::general::get_setting,
            commands::general::set_setting,
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
            // 模型供应商
            commands::providers::provider_list,
            commands::providers::provider_save,
            commands::providers::provider_delete,
            commands::providers::provider_set_disabled,
            commands::providers::model_candidates,
            commands::providers::fingerprint_check,
            commands::providers::provider_discover_models,
            // SDK
            commands::sdk::sdk_list,
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
            commands::capabilities::tool_list,
            commands::capabilities::tool_set_enabled,
            commands::capabilities::mcp_list,
            commands::capabilities::mcp_save,
            commands::capabilities::mcp_delete,
            commands::capabilities::mcp_set_enabled,
            commands::capabilities::mcp_discover_tools,
            commands::capabilities::mcp_auth_start,
            commands::capabilities::mcp_auth_status,
            commands::capabilities::mcp_auth_logout,
            // 会话
            commands::chat::chat_sessions,
            commands::chat::chat_session_create,
            commands::chat::chat_session_get,
            commands::chat::chat_session_update,
            commands::chat::chat_session_delete,
            commands::chat::chat_messages,
            commands::chat::chat_send,
            commands::chat::chat_abort,
            commands::chat::chat_status,
            commands::chat::chat_approve_tool,
            // CR-037：侧栏原生续接——fresh 重建确认
            commands::chat_binding::chat_session_confirm_fresh,
            // 服务器
            commands::servers::server_list,
            commands::servers::server_save,
            commands::servers::server_delete,
            commands::servers::server_connect,
            commands::servers::server_disconnect,
            commands::servers::server_term_open,
            commands::servers::server_term_input,
            commands::servers::server_term_resize,
            commands::servers::server_term_close,
            commands::servers::server_tree,
            commands::servers::server_read_file,
            commands::servers::server_exec,
            commands::servers::server_exec_approved,
            commands::servers::server_exec_reject,
            commands::servers::server_metrics,
            commands::servers::server_ai_exec,
            // 知识库
            commands::knowledge::kb_list,
            commands::knowledge::kb_save,
            commands::knowledge::kb_set_icon,
            commands::knowledge::kb_set_icon_color,
            commands::knowledge::kb_set_appearance,
            commands::knowledge::kb_delete,
            commands::knowledge::kb_scan,
            commands::knowledge::kb_tree,
            commands::knowledge::kb_read,
            // CR-045：本人知识文件管理；不加入 AI 写入网关
            commands::knowledge::kb_create_folder,
            commands::knowledge::kb_create_markdown,
            commands::knowledge::kb_save_markdown,
            commands::knowledge::kb_upload_files,
            commands::knowledge::kb_file_info,
            commands::knowledge::kb_read_file,
            commands::knowledge::kb_export_file,
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
