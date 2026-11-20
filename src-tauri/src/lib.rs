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
pub mod util;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::window::WindowCloseState::default())
        .on_window_event(|window, event| {
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
            // TAURI_SMOKE=1：冒烟测试模式，使用独立隔离库（每次全新）并触发前端套件
            let smoke = std::env::var("TAURI_SMOKE").is_ok();
            let db_file = if smoke { "workbench-smoke.db" } else { "workbench.db" };
            if smoke {
                let _ = std::fs::remove_file(dir.join(db_file));
                let _ = std::fs::remove_file(dir.join("workbench-smoke.db-shm"));
                let _ = std::fs::remove_file(dir.join("workbench-smoke.db-wal"));
            }
            db::init(&dir.join(db_file))?;
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
            commands::smoke::smoke_gateway_record,
            commands::smoke::smoke_set_tierflow_key,
            commands::smoke::smoke_progress,
            commands::smoke_seed::smoke_seed_chat_demo,
            commands::general::app_data_dir,
            commands::general::get_setting,
            commands::general::set_setting,
            commands::general::get_theme,
            commands::general::set_theme,
            // 项目与需求
            commands::projects::list_projects,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::projects::read_requirements,
            commands::projects::read_doc,
            commands::projects::write_doc,
            // 文件系统（编码区）
            commands::fs::fs_list_dir,
            commands::fs::fs_list_tree,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_delete_file,
            commands::fs::fs_search,
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
            commands::knowledge::kb_delete,
            commands::knowledge::kb_scan,
            commands::knowledge::kb_tree,
            commands::knowledge::kb_read,
            commands::knowledge::kb_search,
            commands::knowledge::kb_grants,
            commands::knowledge::kb_grant_set,
            commands::knowledge::kb_gateway,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
