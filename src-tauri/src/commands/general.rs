//! 通用命令：连通性、应用目录、全局设置。

use crate::db;
use tauri::Manager;
use crate::models::now_ms;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
pub fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_setting(key: String) -> Result<Option<String>, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let mut stmt = conn
        .prepare("SELECT value FROM setting_default WHERE scope='global' AND key=?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([&key]).map_err(|e| e.to_string())?;
    if let Ok(Some(row)) = rows.next() {
        Ok(row.get::<_, Option<String>>(0).map_err(|e| e.to_string())?)
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_setting(key: String, value: Option<String>) -> Result<(), String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value=?2, updatedAt=?3",
        rusqlite::params![key, value, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 主题偏好（light/dark），保存在设置表，前端启动时读取。
#[tauri::command]
pub fn get_theme() -> Result<String, String> {
    Ok(get_setting("theme".to_string())?.unwrap_or_else(|| "light".into()))
}

#[tauri::command]
pub fn set_theme(theme: String) -> Result<(), String> {
    set_setting("theme".into(), Some(theme))
}
