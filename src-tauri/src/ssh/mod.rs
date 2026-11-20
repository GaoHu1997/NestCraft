//! SSH 连接管理（russh）。机制对照 TermX（分析见 docs/tmp/ref-analysis-termx.md）：
//! 连接管理器按主机维护客户端；终端 = 交互 shell channel；监控 = 周期 exec /proc 采样；
//! 文件 = SFTP。注意：TermX 无开源许可证，本模块按机制重实现，未复制其代码。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

pub struct SshHandler;

#[async_trait::async_trait]
impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    // TODO：主机指纹校验（known_hosts）；当前默认接受，供内网使用
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SshConnection {
    pub handle: AsyncMutex<russh::client::Handle<SshHandler>>,
    pub connected_at: i64,
}

static CONNECTIONS: Mutex<BTreeMap<String, Arc<SshConnection>>> = Mutex::new(BTreeMap::new());
/// 终端会话：termId -> Channel（读取任务持有；写入走 handle.data）
static TERMS: Mutex<BTreeMap<String, TermSession>> = Mutex::new(BTreeMap::new());

pub struct TermSession {
    pub host_id: String,
    pub channel_id: russh::ChannelId,
    pub closed: bool,
}

/// 按主机记录 id 判断连接状态（与 user@host:port 键分开维护）。
static CONNECTED_HOSTS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

pub fn is_connected(host_id: &str) -> bool {
    CONNECTED_HOSTS.lock().unwrap().contains_key(host_id)
}

pub async fn connect(
    host_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: &crate::commands::servers::HostAuth,
) -> Result<(), String> {
    let key = format!("{}@{}:{}", username, host, port);
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(600)),
        keepalive_interval: Some(std::time::Duration::from_secs(15)),
        keepalive_max: 4,
        ..Default::default()
    });
    let addr = format!("{}:{}", host, port);
    let mut handle = russh::client::connect(config, addr.clone(), SshHandler)
        .await
        .map_err(|e| format!("SSH 连接失败（{}）：{}", addr, e))?;
    let ok = match auth {
        crate::commands::servers::HostAuth::None => handle
            .authenticate_none(username)
            .await
            .map_err(|e| format!("认证失败：{}", e))?,
        crate::commands::servers::HostAuth::Password { password } => handle
            .authenticate_password(username, password)
            .await
            .map_err(|e| format!("认证失败：{}", e))?,
        crate::commands::servers::HostAuth::Key { key_path, passphrase } => {
            let kp = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| format!("读取密钥失败：{}", e))?;
            handle
                .authenticate_publickey(username, Arc::new(kp))
                .await
                .map_err(|e| format!("认证失败：{}", e))?
        }
    };
    if !ok {
        return Err("认证被拒绝（密码或密钥不正确）".into());
    }
    CONNECTIONS.lock().unwrap().insert(
        key.clone(),
        Arc::new(SshConnection { handle: AsyncMutex::new(handle), connected_at: crate::models::now_ms() }),
    );
    CONNECTED_HOSTS.lock().unwrap().insert(host_id.to_string(), key);
    Ok(())
}

pub fn conn_key(username: &str, host: &str, port: u16) -> String {
    format!("{}@{}:{}", username, host, port)
}

pub async fn disconnect(host_id: &str, username: &str, host: &str, port: u16) {
    let key = CONNECTED_HOSTS
        .lock()
        .unwrap()
        .remove(host_id)
        .unwrap_or_else(|| conn_key(username, host, port));
    // 先在独立作用域取出连接（MutexGuard 不能跨 await）
    let conn = { CONNECTIONS.lock().unwrap().remove(&key) };
    if let Some(conn) = conn {
        let mut handle = conn.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "user disconnect", "en")
            .await;
    }
    let _ = host_id;
}

pub fn get_connection(username: &str, host: &str, port: u16) -> Option<Arc<SshConnection>> {
    let key = conn_key(username, host, port);
    CONNECTIONS.lock().unwrap().get(&key).cloned()
}

/// 打开交互 shell 终端：返回 termId；输出通过回调推送。
pub async fn open_terminal(
    conn: &SshConnection,
    host_id: &str,
    cols: u32,
    rows: u32,
    mut on_data: impl FnMut(String) + Send + 'static,
    on_exit: impl FnOnce(String) + Send + 'static,
) -> Result<String, String> {
    let mut handle = conn.handle.lock().await;
    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel.request_shell(true).await.map_err(|e| e.to_string())?;
    let channel_id = channel.id();
    let term_id = crate::models::new_id("term");
    TERMS.lock().unwrap().insert(
        term_id.clone(),
        TermSession { channel_id, closed: false, host_id: host_id.to_string() },
    );
    let tid = term_id.clone();
    tokio::spawn(async move {
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { ref data }) => {
                    on_data(decode_bytes(data));
                }
                Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    on_data(decode_bytes(data));
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    on_data(format!("\r\n[进程退出，状态码 {}]\r\n", exit_status));
                }
                Some(russh::ChannelMsg::Close) | None => {
                    if let Some(t) = TERMS.lock().unwrap().get_mut(&tid) {
                        t.closed = true;
                    }
                    on_exit(tid.clone());
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(term_id)
}

/// 向终端写入输入。
pub async fn term_write(username: &str, host: &str, port: u16, term_id: &str, data: &str) -> Result<(), String> {
    let conn = get_connection(username, host, port).ok_or("连接已断开")?;
    let channel_id = {
        let terms = TERMS.lock().unwrap();
        let t = terms.get(term_id).ok_or("终端不存在")?;
        if t.closed {
            return Err("终端已关闭".into());
        }
        t.channel_id
    };
    let handle = conn.handle.lock().await;
    handle
        .data(channel_id, russh::CryptoVec::from_slice(data.as_bytes()))
        .await
        .map_err(|_| "写入失败".to_string())
}

pub async fn term_resize(username: &str, host: &str, port: u16, term_id: &str, cols: u32, rows: u32) -> Result<(), String> {
    // 通道窗口变更通过 shell 输入 stty 实现（避免与读取任务争锁）
    let _ = term_id;
    term_write(username, host, port, term_id, &format!("stty cols {} rows {}\n", cols, rows)).await
}

pub fn close_terminal(term_id: &str) {
    TERMS.lock().unwrap().remove(term_id);
}

/// 执行单条命令并收集输出（每次独立 channel）。
pub async fn exec_command(
    conn: &SshConnection,
    command: &str,
    timeout_secs: u64,
) -> Result<(String, i32), String> {
    let mut handle = conn.handle.lock().await;
    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut code = 0;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        let msg = tokio::time::timeout_at(deadline, channel.wait()).await;
        match msg {
            Err(_) => return Err("命令执行超时".into()),
            Ok(None) => break,
            Ok(Some(russh::ChannelMsg::Data { ref data })) => out.extend_from_slice(data),
            Ok(Some(russh::ChannelMsg::ExtendedData { ref data, .. })) => out.extend_from_slice(data),
            Ok(Some(russh::ChannelMsg::ExitStatus { exit_status })) => code = exit_status as i32,
            Ok(Some(russh::ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
        }
    }
    Ok((decode_bytes(&out), code))
}

/// SFTP 列目录。
pub async fn sftp_list(conn: &SshConnection, path: &str) -> Result<Vec<(String, bool, u64)>, String> {
    let mut handle = conn.handle.lock().await;
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP 初始化失败：{}", e))?;
    let entries = sftp.read_dir(path).await.map_err(|e| format!("读取目录失败：{}", e))?;
    let mut out = Vec::new();
    for ent in entries {
        let name = ent.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = ent.metadata();
        let is_dir = meta.is_dir();
        let size = meta.size.unwrap_or(0);
        out.push((name, is_dir, size));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// SFTP 读文件（UTF-8）。
pub async fn sftp_read(conn: &SshConnection, path: &str) -> Result<String, String> {
    let mut handle = conn.handle.lock().await;
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| e.to_string())?;
    let data = sftp.read(path).await.map_err(|e| format!("读取失败：{}", e))?;
    Ok(decode_bytes(&data))
}

/// GBK/UTF-8 容错解码（远端 locale 探测简化：优先 UTF-8，失败回退 GBK）。
pub fn decode_bytes(data: &[u8]) -> String {
    match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(data);
            decoded.to_string()
        }
    }
}

pub mod testserver;
