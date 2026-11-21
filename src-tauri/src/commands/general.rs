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

/// CR-051：头像风格偏好（a–e），存 setting_default(scope=global, key=ui.avatarStyle)。
/// r6：缺省、空值或非法值一律按默认 b 显示（UI-CR051-v6 第 6.2 节）。
pub const AVATAR_STYLE_KEY: &str = "ui.avatarStyle";
pub const AVATAR_STYLE_VALUES: [&str; 5] = ["a", "b", "c", "d", "e"];
pub const DEFAULT_AVATAR_STYLE: &str = "b";

/// r6：自定义头像的本机文件引用与内容 hash，存 setting_default(scope=global)。
/// 只保存路径与校验值，不存原图字节，不上传网络（AC-STORY-069-17）。
pub const AVATAR_IMAGE_KEY: &str = "ui.avatarImage";
pub const AVATAR_IMAGE_HASH_KEY: &str = "ui.avatarImageHash";

fn read_avatar_style(conn: &rusqlite::Connection) -> Result<String, String> {
    let value: Option<Option<String>> = conn
        .query_row(
            "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
            [AVATAR_STYLE_KEY],
            |row| row.get::<_, Option<String>>(0),
        )
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })?;
    let stored = value.flatten().unwrap_or_default();
    Ok(if AVATAR_STYLE_VALUES.contains(&stored.as_str()) { stored } else { DEFAULT_AVATAR_STYLE.to_string() })
}

fn read_setting_opt(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    let row: Option<Option<String>> = conn
        .query_row(
            "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
            [key],
            |r| r.get::<_, Option<String>>(0),
        )
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })?;
    Ok(row.flatten().filter(|v| !v.trim().is_empty()))
}

fn read_avatar_image(conn: &rusqlite::Connection) -> Result<(Option<String>, Option<String>), String> {
    Ok((
        read_setting_opt(conn, AVATAR_IMAGE_KEY)?,
        read_setting_opt(conn, AVATAR_IMAGE_HASH_KEY)?,
    ))
}

#[tauri::command]
pub fn get_avatar_style() -> Result<String, String> {
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    read_avatar_style(conn)
}

#[tauri::command]
pub fn set_avatar_style(style: String) -> Result<(), String> {
    let guard = db::conn()?;
    write_avatar_settings(guard.as_ref().ok_or("db not initialized")?, None, Some(&style))
}

/// CR-051 r6：读取自定义头像。返回 path 与 hash；未设置时两者为 null。
const MAX_AVATAR_BYTES: usize = 200 * 1024;

fn write_avatar_settings(conn: &rusqlite::Connection, image: Option<(Option<&str>, Option<&str>)>, style: Option<&str>) -> Result<(), String> {
    if style.is_some_and(|s| !AVATAR_STYLE_VALUES.contains(&s)) {
        return Err("头像风格必须是 a、b、c、d、e 之一".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut values = Vec::new();
    if let Some((path, hash)) = image {
        values.push((AVATAR_IMAGE_KEY, path));
        values.push((AVATAR_IMAGE_HASH_KEY, hash));
    }
    if let Some(style) = style { values.push((AVATAR_STYLE_KEY, Some(style))); }
    for (key, value) in values {
        tx.execute("INSERT INTO setting_default(scope,key,value,updatedAt) VALUES('global',?1,?2,?3) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt", rusqlite::params![key,value,now_ms()]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn is_avatar_link(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false; };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Windows junction 也属于重解析点，不能作为受管目录/文件使用。
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    meta.file_type().is_symlink()
}

// 路径必须是受管目录的直接子文件；拒绝穿越、符号链接及不匹配的文件名/摘要。
fn managed_avatar(dir: &std::path::Path, path: &str, hash: &str) -> Option<(std::path::PathBuf, &'static str)> {
    if is_avatar_link(dir) || is_avatar_link(std::path::Path::new(path)) { return None; }
    if hash.len() != 16 || !hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) { return None; }
    let p = std::path::Path::new(path);
    let mime = match p.extension()?.to_str()? { "png" => "image/png", "jpg" => "image/jpeg", "webp" => "image/webp", _ => return None };
    let ext = p.extension()?.to_str()?;
    if p.file_name()?.to_str()? != format!("avatar-{hash}.{ext}") { return None; }
    if std::fs::symlink_metadata(p).ok()?.file_type().is_symlink() { return None; }
    let canonical = p.canonicalize().ok()?;
    if canonical.parent()? != dir.canonicalize().ok()? || !canonical.is_file() { return None; }
    Some((canonical, mime))
}

fn load_avatar(conn: &rusqlite::Connection, dir: &std::path::Path) -> Result<Option<(String,String,Vec<u8>, &'static str)>, String> {
    use std::io::Read;
    let (Some(path), Some(hash)) = read_avatar_image(conn)? else { return Ok(None) };
    let Some((file, mime)) = managed_avatar(dir, &path, &hash) else { return Ok(None) };
    let mut bytes = Vec::new();
    std::fs::File::open(file).map_err(|e| e.to_string())?.take((MAX_AVATAR_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if validate_avatar_payload(mime, &bytes).is_err() || short_content_hash(&bytes) != hash { return Ok(None); }
    Ok(Some((path,hash,bytes,mime)))
}

#[tauri::command]
pub fn get_avatar_image(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatar");
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    Ok(match load_avatar(conn, &dir)? {
        Some((path,hash,_,_)) => serde_json::json!({"path":path,"hash":hash}),
        None => serde_json::json!({"path":null,"hash":null}),
    })
}

fn save_avatar_inner(conn: &rusqlite::Connection, dir: &std::path::Path, data_url: Option<&str>, style: Option<&str>) -> Result<serde_json::Value, String> {
    if style.is_some_and(|s| !AVATAR_STYLE_VALUES.contains(&s)) { return Err("头像风格无效".into()); }
    if data_url == Some("") {
        write_avatar_settings(conn, Some((None, None)), style)?;
        return Ok(serde_json::json!({ "path": null, "hash": null }));
    }
    let image = if let Some(data) = data_url {
        let (mime, payload) = parse_data_url_payload(data)?;
        validate_avatar_payload(mime, &payload)?;
        let ext = match mime { "image/png" => "png", "image/jpeg" => "jpg", _ => "webp" };
        if is_avatar_link(dir) { return Err("头像目录不能是链接".into()); }
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let hash = short_content_hash(&payload);
        let file = dir.join(format!("avatar-{hash}.{ext}"));
        // create_new 避免覆盖任意已有文件或跟随符号链接。
        use std::io::Write;
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut f) => { if let Err(e) = f.write_all(&payload) { let _ = std::fs::remove_file(&file); return Err(e.to_string()); } },
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if managed_avatar(dir, &file.to_string_lossy(), &hash).is_none() || std::fs::metadata(&file).map_err(|e| e.to_string())?.len() != payload.len() as u64 || std::fs::read(&file).map_err(|e| e.to_string())? != payload { return Err("头像文件冲突".into()); }
            },
            Err(e) => return Err(e.to_string()),
        }
        Some((file.to_string_lossy().to_string(),hash))
    } else { None };
    write_avatar_settings(conn, image.as_ref().map(|(p,h)| (Some(p.as_str()),Some(h.as_str()))), style)?;
    let (path,hash) = read_avatar_image(conn)?;
    Ok(serde_json::json!({"path":path,"hash":hash}))
}

#[tauri::command]
pub fn set_avatar_image(app: tauri::AppHandle, data_url: String, original_name: Option<String>) -> Result<serde_json::Value, String> {
    let _ = original_name;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatar");
    let guard = db::conn()?;
    save_avatar_inner(guard.as_ref().ok_or("db not initialized")?, &dir, Some(&data_url), None)
}

/// 风格与新图片作为一次提交；data_url 缺省时保留已有图片。
#[tauri::command]
pub fn save_avatar(app: tauri::AppHandle, data_url: Option<String>, style: String) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatar");
    let guard = db::conn()?;
    save_avatar_inner(guard.as_ref().ok_or("db not initialized")?, &dir, data_url.as_deref(), Some(&style))
}

/// 载荷校验：类型白名单 + 魔数（声明类型与真实字节一致）+ ≤200KB。
/// 声明 image/png 但字节不是 PNG（伪装扩展名/内容）一律拒绝。
pub fn validate_avatar_payload(mime: &str, payload: &[u8]) -> Result<(), String> {
    const MAX_BYTES: usize = 200 * 1024;
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
        return Err("头像只支持 PNG、JPG 或 WebP".into());
    }
    let magic_ok = match mime {
        "image/png" => payload.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => payload.starts_with(&[0xFF, 0xD8, 0xFF]),
        _ => payload.len() >= 12 && &payload[0..4] == b"RIFF" && &payload[8..12] == b"WEBP",
    };
    if !magic_ok {
        return Err("头像文件内容与声明的图片格式不符".into());
    }
    if payload.len() > MAX_BYTES {
        return Err(format!("头像图片不能超过 200KB（当前 {} 字节）", payload.len()));
    }
    Ok(())
}

/// CR-051 r6：读取已应用头像的 data URL（「更换头像」弹窗重开时据此继续拖动/缩放调整）。
/// 只读取本命令自己写入的 app_data/avatar/ 下文件；引用失效返回 null。
#[tauri::command]
pub fn avatar_image_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatar");
    let guard = db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    Ok(load_avatar(conn, &dir)?.map(|(_,_,bytes,mime)| format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

/// 最小 base64 编码（与 base64_decode 对应，避免引入新依赖）。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// CR-051 r6：清除自定义头像，回落品牌 Logo。
#[tauri::command]
pub fn clear_avatar_image(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatar");
    let guard = db::conn()?;
    clear_avatar_inner(guard.as_ref().ok_or("db not initialized")?, &dir)
}

fn clear_avatar_inner(conn: &rusqlite::Connection, dir: &std::path::Path) -> Result<(), String> {
    let (path, hash) = read_avatar_image(conn)?;
    let file = path.zip(hash).and_then(|(p,h)| managed_avatar(dir, &p, &h));
    write_avatar_settings(conn, Some((None,None)), Some(DEFAULT_AVATAR_STYLE))?;
    if let Some((file,_)) = file { let _ = std::fs::remove_file(file); }
    Ok(())
}

/// 解析 data:image/png;base64,.... 形式的载荷；格式不符直接拒绝。
fn parse_data_url_payload(data_url: &str) -> Result<(&str, Vec<u8>), String> {
    if data_url.len() > 32 + MAX_AVATAR_BYTES.div_ceil(3) * 4 { return Err("头像图片不能超过 200KB".into()); }
    let rest = data_url.strip_prefix("data:").ok_or("头像数据格式无效")?;
    let (meta, encoded) = rest.split_once(',').ok_or("头像数据格式无效")?;
    let mime = meta.strip_suffix(";base64").ok_or("头像数据必须是 base64 编码")?;
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") { return Err("头像格式无效".into()); }
    let bytes = base64_decode(encoded)?;
    validate_avatar_payload(mime, &bytes)?;
    Ok((mime, bytes))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if input.len() > MAX_AVATAR_BYTES.div_ceil(3) * 4 { return Err("头像图片不能超过 200KB".into()); }
    base64::engine::general_purpose::STANDARD.decode(input).map_err(|_| "头像 base64 编码无效".into())
}

/// 64 位内容摘要：仅用于生成稳定文件名与变更检测，不作为安全校验。
fn short_content_hash(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_style_defaults_to_b_when_missing_or_invalid() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE setting_default (scope TEXT NOT NULL DEFAULT 'global', key TEXT NOT NULL, value TEXT, updatedAt INTEGER NOT NULL, PRIMARY KEY (scope, key));",
        ).unwrap();
        // 未设置（含表为空）：缺省 b（r6 起默认薄荷承载）。
        assert_eq!(read_avatar_style(&conn).unwrap(), "b");
        // 存了非法值：按缺省 b 显示，不报错。
        conn.execute(
            "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, 'z', 1)",
            [AVATAR_STYLE_KEY],
        ).unwrap();
        assert_eq!(read_avatar_style(&conn).unwrap(), "b");
        // 合法值原样读取。
        for style in AVATAR_STYLE_VALUES {
            conn.execute(
                "UPDATE setting_default SET value=?2 WHERE key=?1",
                rusqlite::params![AVATAR_STYLE_KEY, style],
            ).unwrap();
            assert_eq!(read_avatar_style(&conn).unwrap(), style);
        }
        // 非法风格被 set_avatar_style 拒绝（不落库）。
        assert!(set_avatar_style_inner(&conn, "x".into()).is_err());
        assert!(set_avatar_style_inner(&conn, "d".into()).is_ok());
        assert_eq!(read_avatar_style(&conn).unwrap(), "d");
    }

    fn set_avatar_style_inner(conn: &rusqlite::Connection, style: String) -> Result<(), String> {
        if !AVATAR_STYLE_VALUES.contains(&style.as_str()) {
            return Err("头像风格必须是 a、b、c、d、e 之一".into());
        }
        conn.execute(
            "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, 1)
             ON CONFLICT(scope, key) DO UPDATE SET value=?2, updatedAt=1",
            rusqlite::params![AVATAR_STYLE_KEY, style],
        ).map(|_| ()).map_err(|e| e.to_string())
    }

    fn settings_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE setting_default(scope TEXT,key TEXT,value TEXT,updatedAt INTEGER,PRIMARY KEY(scope,key));").unwrap();
        conn
    }

    #[test]
    fn avatar_strict_base64_and_input_limits() {
        for bad in ["A", "AA", "AA=", "AA===", "AB==", "AA==AA==", "AA==\n", "====", "!AAA"] {
            assert!(base64_decode(bad).is_err(), "{bad:?}");
        }
        assert!(parse_data_url_payload(&format!("data:image/png;base64,{}", "A".repeat(MAX_AVATAR_BYTES.div_ceil(3)*4+1))).is_err());
        assert!(parse_data_url_payload("data:image/png;extra;base64,iVBORw0KGgo=").is_err());
        assert!(parse_data_url_payload("data:image/jpeg;base64,iVBORw0KGgo=").is_err());
    }

    #[test]
    fn avatar_atomic_failure_and_clear_are_safe() {
        let conn = settings_db();
        write_avatar_settings(&conn, Some((Some("old"), Some("oldhash"))), Some("d")).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_hash BEFORE UPDATE ON setting_default WHEN NEW.key='ui.avatarImageHash' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(write_avatar_settings(&conn, Some((Some("new"),Some("newhash"))), Some("e")).is_err());
        assert_eq!(read_avatar_image(&conn).unwrap(), (Some("old".into()),Some("oldhash".into())));
        assert_eq!(read_avatar_style(&conn).unwrap(), "d");
        conn.execute_batch("DROP TRIGGER fail_hash;").unwrap();
        let dir = std::env::temp_dir().join(format!("cr051-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("outside/avatar")).unwrap();
        let outside = dir.join("outside/avatar/avatar-0000000000000000.png");
        std::fs::write(&outside, PNG_MAGIC).unwrap();
        write_avatar_settings(&conn, Some((Some(&outside.to_string_lossy()),Some("0000000000000000"))), None).unwrap();
        clear_avatar_inner(&conn, &dir.join("managed/avatar")).unwrap();
        assert!(outside.exists());
        assert_eq!(read_avatar_image(&conn).unwrap(), (None,None));
        assert_eq!(read_avatar_style(&conn).unwrap(), "b");
        let managed = dir.join("managed/avatar");
        let data = format!("data:image/png;base64,{}",base64_encode(&PNG_MAGIC));
        save_avatar_inner(&conn,&managed,Some(&data),Some("c")).unwrap();
        assert!(load_avatar(&conn,&managed).unwrap().is_some());
        let path = read_avatar_image(&conn).unwrap().0.unwrap();
        clear_avatar_inner(&conn,&managed).unwrap();
        assert!(!std::path::Path::new(&path).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    #[test]
    fn avatar_payload_rejects_bad_magic_type_and_oversize() {
        // 合法 PNG（最小头）通过。
        let png = [PNG_MAGIC.as_slice(), &[0, 0, 0, 13]].concat();
        assert!(validate_avatar_payload("image/png", &png).is_ok());
        // 魔数不符：声明 PNG 但字节是文本（伪装内容拒绝）。
        let fake = b"GIF89a not really png".to_vec();
        assert!(validate_avatar_payload("image/png", &fake).is_err());
        // 类型白名单：BMP / SVG 文本拒绝。
        assert!(validate_avatar_payload("image/bmp", &png).is_err());
        assert!(validate_avatar_payload("image/svg+xml", b"<svg/>".to_vec().as_slice()).is_err());
        // JPEG / WebP 魔数各自匹配。
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0].to_vec();
        assert!(validate_avatar_payload("image/jpeg", &jpeg).is_ok());
        let webp = [b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'E', b'B', b'P'].to_vec();
        assert!(validate_avatar_payload("image/webp", &webp).is_ok());
        let bad_webp = [b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'J', b'U', b'N', b'K'].to_vec();
        assert!(validate_avatar_payload("image/webp", &bad_webp).is_err());
        // 超 200KB 拒绝（含边界：恰好 200KB 通过，+1 字节拒绝）。
        let big_ok = [PNG_MAGIC.as_slice(), &vec![0u8; 200 * 1024 - 8]].concat();
        assert_eq!(big_ok.len(), 200 * 1024);
        assert!(validate_avatar_payload("image/png", &big_ok).is_ok());
        let big_bad = [PNG_MAGIC.as_slice(), &vec![0u8; 200 * 1024 - 8 + 1]].concat();
        assert!(validate_avatar_payload("image/png", &big_bad).is_err());
    }

    #[test]
    fn avatar_data_url_roundtrip_matches_png_payload() {
        let png = [PNG_MAGIC.as_slice(), &[0, 0, 0, 13]].concat();
        let encoded = base64_encode(&png);
        let data_url = format!("data:image/png;base64,{encoded}");
        let (mime, decoded) = parse_data_url_payload(&data_url).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(decoded, png);
    }
}
