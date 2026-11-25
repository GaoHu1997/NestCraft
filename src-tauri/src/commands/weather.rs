//! CR-078：概览页当前位置天气。
//! 用户决策（PRD Q-078-03～05）：Open-Meteo 免密钥；系统定位优先 + IP 兜底；仅天气联网，设置可关。
//! 系统定位需 tauri-plugin-geolocation（本仓库未安装，引入新插件依赖超出本次授权范围），
//! 因此当前实现为：缓存位置 → IP 定位（ipapi.co）→ Open-Meteo。系统定位接入点留在 `locate()`
//! 与 LLD，安装插件后只需替换该函数，其余不变；此偏离已登记交付说明。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub(crate) const ENABLE_KEY: &str = "weather.enabled";
pub(crate) const CACHE_KEY: &str = "weather.last";
const IP_LOCATE_URL: &str = "https://ipapi.co/json/";
const OPEN_METEO_URL: &str = "https://api.open-meteo.com/v1/forecast";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WeatherNow {
    pub city: String,
    pub temp: f64,
    pub low: f64,
    pub high: f64,
    /// 中文天气文字（由 WMO code 映射）。
    pub text: String,
    /// 界面图标：sunny | cloudy | overcast | rain | snow | storm
    pub code: String,
    pub updated_at: i64,
    pub lat: f64,
    pub lon: f64,
    /// true = 本次结果是缓存（可能过期）。
    pub cached: bool,
    /// 缓存时的降级说明；正常为空。
    pub degraded: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum WeatherResult {
    /// 正常或缓存命中（cached=true 时界面标注可能过期）。
    Ok { weather: WeatherNow },
    /// 无缓存且获取失败；frontend 显示「天气不可用 + 重试」。
    Unavailable { reason: String },
    /// 用户关闭了天气（`weather.enabled` = false）。
    Disabled,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build()
}

fn setting_get(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM setting_default WHERE scope='global' AND key=?1", [key], |r| r.get::<_, Option<String>>(0))
        .optional()
        .map_err(|e| e.to_string())
        .and_then(|row| Ok(row.flatten()))
}

fn setting_set(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value=?2, updatedAt=?3",
        params![key, value, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

use rusqlite::params;
use rusqlite::OptionalExtension;

pub(crate) fn enabled(conn: &rusqlite::Connection) -> Result<bool, String> {
    match setting_get(conn, ENABLE_KEY) {
        Ok(v) => Ok(v.map(|s| s != "false").unwrap_or(true)),
        Err(_) => Ok(true), // 键不存在视为默认开启（setting_get 对缺行返回 Query returned no rows）
    }
}

fn cached_weather(conn: &rusqlite::Connection, degraded: Option<String>) -> Option<WeatherNow> {
    let raw = setting_get(conn, CACHE_KEY).ok()??;
    let mut w: WeatherNow = serde_json::from_str(&raw).ok()?;
    w.cached = true;
    w.degraded = degraded;
    Some(w)
}

/// IP 定位。返回 (城市, 纬度, 经度)。城市仅到城市级。
fn locate(agent: &ureq::Agent) -> Result<(String, f64, f64), String> {
    let resp: Value = agent
        .get(IP_LOCATE_URL)
        .call()
        .map_err(|e| format!("定位失败：{}", e))?
        .into_json()
        .map_err(|_| "定位响应无效".to_string())?;
    let city = resp
        .get("city")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("定位结果缺少城市")?
        .trim()
        .to_string();
    let lat = resp.get("latitude").and_then(Value::as_f64).ok_or("定位结果缺少纬度")?;
    let lon = resp.get("longitude").and_then(Value::as_f64).ok_or("定位结果缺少经度")?;
    Ok((city, lat, lon))
}

/// WMO weather interpretation code → (中文文字, 界面图标)。
fn describe_wmo(code: i64) -> (&'static str, &'static str) {
    match code {
        0 => ("晴", "sunny"),
        1 | 2 => ("多云", "cloudy"),
        3 => ("阴", "overcast"),
        45 | 48 => ("雾", "overcast"),
        51..=67 => ("雨", "rain"),
        71..=77 | 85 | 86 => ("雪", "snow"),
        80..=82 => ("阵雨", "rain"),
        95..=99 => ("雷雨", "storm"),
        _ => ("多云", "cloudy"),
    }
}

fn fetch_open_meteo(agent: &ureq::Agent, lat: f64, lon: f64) -> Result<(f64, f64, f64, i64), String> {
    let url = format!(
        "{}?latitude={}&longitude={}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1",
        OPEN_METEO_URL, lat, lon
    );
    let resp: Value = agent
        .get(&url)
        .call()
        .map_err(|e| format!("天气服务请求失败：{}", e))?
        .into_json()
        .map_err(|_| "天气响应无效".to_string())?;
    let err = resp.get("error").and_then(Value::as_bool).unwrap_or(false);
    if err {
        let reason = resp.get("reason").and_then(Value::as_str).unwrap_or("未知原因");
        return Err(format!("天气服务拒绝：{}", reason));
    }
    let temp = resp
        .pointer("/current/temperature_2m")
        .and_then(Value::as_f64)
        .ok_or("天气响应缺少当前温度")?;
    let code = resp.pointer("/current/weather_code").and_then(Value::as_i64).unwrap_or(3);
    let high = resp
        .pointer("/daily/temperature_2m_max/0")
        .and_then(Value::as_f64)
        .unwrap_or(temp);
    let low = resp
        .pointer("/daily/temperature_2m_min/0")
        .and_then(Value::as_f64)
        .unwrap_or(temp);
    Ok((temp, low, high, code))
}

pub(crate) fn current(conn: &rusqlite::Connection) -> Result<WeatherResult, String> {
    if !enabled(conn)? {
        return Ok(WeatherResult::Disabled);
    }
    let now = chrono::Utc::now().timestamp_millis();
    // 30 分钟内的缓存直接用，不请求（节流）。
    if let Some(mut cached) = cached_weather(conn, None) {
        if now - cached.updated_at < 30 * 60 * 1000 {
            cached.cached = false; // 30 分钟内视为新鲜
            return Ok(WeatherResult::Ok { weather: cached });
        }
    }
    let agent = agent();
    let (city, lat, lon) = match locate(&agent) {
        Ok(v) => v,
        Err(loc_err) => {
            return Ok(match cached_weather(conn, Some("定位失败 · 上次位置".into())) {
                Some(w) => WeatherResult::Ok { weather: w },
                None => WeatherResult::Unavailable { reason: loc_err },
            })
        }
    };
    match fetch_open_meteo(&agent, lat, lon) {
        Ok((temp, low, high, code)) => {
            let (text, icon) = describe_wmo(code);
            let weather = WeatherNow {
                city,
                temp,
                low,
                high,
                text: text.into(),
                code: icon.into(),
                updated_at: now,
                lat,
                lon,
                cached: false,
                degraded: None,
            };
            setting_set(conn, CACHE_KEY, &serde_json::to_string(&weather).map_err(|e| e.to_string())?)?;
            Ok(WeatherResult::Ok { weather })
        }
        Err(fetch_err) => Ok(match cached_weather(conn, Some("更新失败".into())) {
            Some(w) => WeatherResult::Ok { weather: w },
            None => WeatherResult::Unavailable { reason: fetch_err },
        }),
    }
}

#[tauri::command]
pub(crate) fn weather_current() -> Result<WeatherResult, String> {
    let guard = crate::db::conn()?;
    current(guard.as_ref().ok_or("db not initialized")?)
}

/// 用户点「重试」：忽略 30 分钟节流重新获取。
#[tauri::command]
pub(crate) fn weather_refresh() -> Result<WeatherResult, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    if !enabled(conn)? {
        return Ok(WeatherResult::Disabled);
    }
    if let Some(raw) = setting_get(conn, CACHE_KEY)? {
        let mut stale: Value = serde_json::from_str(&raw).map_err(|_| String::from("缓存无效"))?;
        stale["updatedAt"] = Value::from(0);
        setting_set(conn, CACHE_KEY, &stale.to_string())?;
    }
    current(conn)
}

#[tauri::command]
pub(crate) fn weather_set_enabled(enabled: bool) -> Result<(), String> {
    let guard = crate::db::conn()?;
    setting_set(guard.as_ref().ok_or("db not initialized")?, ENABLE_KEY, if enabled { "true" } else { "false" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE setting_default (scope TEXT NOT NULL DEFAULT 'global', key TEXT NOT NULL, value TEXT, updatedAt INTEGER NOT NULL, PRIMARY KEY (scope, key));",
        )
        .unwrap();
        conn
    }

    #[test]
    fn enabled_defaults_true_and_settable() {
        let conn = setup();
        assert!(enabled(&conn).unwrap());
        setting_set(&conn, ENABLE_KEY, "false").unwrap();
        assert!(!enabled(&conn).unwrap());
        setting_set(&conn, ENABLE_KEY, "true").unwrap();
        assert!(enabled(&conn).unwrap());
    }

    #[test]
    fn wmo_codes_map_to_six_icons() {
        assert_eq!(describe_wmo(0), ("晴", "sunny"));
        assert_eq!(describe_wmo(2), ("多云", "cloudy"));
        assert_eq!(describe_wmo(3), ("阴", "overcast"));
        assert_eq!(describe_wmo(63), ("雨", "rain"));
        assert_eq!(describe_wmo(73), ("雪", "snow"));
        assert_eq!(describe_wmo(95), ("雷雨", "storm"));
        assert_eq!(describe_wmo(99).1, "storm");
        assert_eq!(describe_wmo(42).1, "cloudy", "未知代码回退多云");
    }

    #[test]
    fn cache_roundtrip_and_degraded_note() {
        let conn = setup();
        let w = WeatherNow {
            city: "武汉".into(), temp: 8.0, low: 5.0, high: 12.0, text: "晴".into(),
            code: "sunny".into(), updated_at: chrono::Utc::now().timestamp_millis(),
            lat: 30.5, lon: 114.3, cached: false, degraded: None,
        };
        setting_set(&conn, CACHE_KEY, &serde_json::to_string(&w).unwrap()).unwrap();
        let got = cached_weather(&conn, Some("更新失败".into())).unwrap();
        assert!(got.cached);
        assert_eq!(got.degraded.as_deref(), Some("更新失败"));
        assert_eq!(got.city, "武汉");
    }
}
