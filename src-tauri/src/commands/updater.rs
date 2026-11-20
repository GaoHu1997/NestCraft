//! CR-046：软件更新命令包装。核心逻辑见 `crate::updater`。

use crate::updater;

#[tauri::command]
pub fn update_environment(app: tauri::AppHandle) -> Result<updater::UpdateEnvironment, String> {
    updater::environment(&app)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<updater::UpdateCheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || updater::check(&app))
        .await
        .map_err(|e| format!("更新检查任务失败: {e}"))?
}

#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    expected_version: Option<String>,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        updater::download(&app, expected_version, expected_sha256)
    })
    .await
    .map_err(|e| format!("更新下载任务失败: {e}"))?
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> updater::UpdateStatus {
    updater::status(&app)
}

#[tauri::command]
pub fn update_apply(
    app: tauri::AppHandle,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    updater::apply(&app, expected_sha256)
}
