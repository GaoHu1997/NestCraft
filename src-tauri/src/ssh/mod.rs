//! SSH 连接管理（russh）。机制对照 TermX（分析见 docs/tmp/ref-analysis-termx.md）：
//! 连接管理器按主机维护客户端；终端 = 交互 shell channel；监控 = 周期 exec /proc 采样；
//! 文件 = SFTP。注意：TermX 无开源许可证，本模块按机制重实现，未复制其代码。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::MutexGuard as AsyncMutexGuard;

/// 锁等待与通道开启的暂定预算（毫秒）。需同机分段实测后才能冻结，
/// 这里只保证“慢/失败辅助 I/O 不会无限期占住公共锁”，不作为提速倍数依据。
const LOCK_WAIT_MS: u64 = 3_000;
const CHANNEL_OPEN_MS: u64 = 8_000;
const CHANNEL_SETUP_MS: u64 = 8_000;
/// 终端输入必须最快失败并提示重试，不能等成“按键丢失”。
const TERM_WRITE_WAIT_MS: u64 = 3_000;
/// SFTP 单次目录读取／文件读取的上限：超时即丢弃该通道（相当于取消），
/// 让界面拿到可重试错误而不是无限加载。预算为暂定值，需实测后复核。
const SFTP_OP_MS: u64 = 30_000;

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
        // 断开同样不能让辅助 I/O 无限期拖延：锁等待与发送都限时。
        if let Ok(handle) = lock_conn(&conn, "断开连接", LOCK_WAIT_MS).await {
            let _ = tokio::time::timeout(
                Duration::from_millis(LOCK_WAIT_MS),
                handle.disconnect(russh::Disconnect::ByApplication, "user disconnect", "en"),
            )
            .await;
        }
    }
    let _ = host_id;
}

pub fn get_connection(username: &str, host: &str, port: u16) -> Option<Arc<SshConnection>> {
    let key = conn_key(username, host, port);
    CONNECTIONS.lock().unwrap().get(&key).cloned()
}

type ClientHandle = russh::client::Handle<SshHandler>;
type ClientChannel = russh::Channel<russh::client::Msg>;

/// 获取共享句柄的访问权；锁等待有上限，超时返回可定位错误而不是无限期挂起。
async fn lock_with_timeout<'a, T>(
    mutex: &'a AsyncMutex<T>,
    stage: &str,
    budget_ms: u64,
) -> Result<AsyncMutexGuard<'a, T>, String> {
    match tokio::time::timeout(Duration::from_millis(budget_ms), mutex.lock()).await {
        Ok(guard) => Ok(guard),
        Err(_) => Err(format!("{stage}：SSH 会话被其它请求占用超过 {budget_ms}ms，请重试")),
    }
}

async fn lock_conn<'a>(
    conn: &'a SshConnection,
    stage: &str,
    budget_ms: u64,
) -> Result<AsyncMutexGuard<'a, ClientHandle>, String> {
    lock_with_timeout(&conn.handle, stage, budget_ms).await
}

/// 只在锁内完成通道开启（含服务端确认等待，且受超时约束），返回前释放句柄；
/// 之后的 SFTP 目录读取、命令等待、终端读写都不再持有公共锁。
async fn open_channel(conn: &SshConnection, stage: &str) -> Result<ClientChannel, String> {
    let handle = lock_conn(conn, stage, LOCK_WAIT_MS).await?;
    match tokio::time::timeout(Duration::from_millis(CHANNEL_OPEN_MS), handle.channel_open_session()).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(e)) => Err(format!("{stage}：打开 SSH 通道失败：{e}")),
        Err(_) => Err(format!("{stage}：打开 SSH 通道超时（{CHANNEL_OPEN_MS}ms）")),
    }
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
    let mut channel = open_channel(conn, "终端").await?;
    // 通道确认后句柄锁已释放；pty/shell 请求只属于本通道，各自限时。
    tokio::time::timeout(
        Duration::from_millis(CHANNEL_SETUP_MS),
        channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]),
    )
    .await
    .map_err(|_| format!("终端：申请 pty 超时（{CHANNEL_SETUP_MS}ms）"))?
    .map_err(|e| format!("终端：申请 pty 失败：{e}"))?;
    tokio::time::timeout(
        Duration::from_millis(CHANNEL_SETUP_MS),
        channel.request_shell(true),
    )
    .await
    .map_err(|_| format!("终端：启动 shell 超时（{CHANNEL_SETUP_MS}ms）"))?
    .map_err(|e| format!("终端：启动 shell 失败：{e}"))?;
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
    let handle = lock_conn(&conn, "终端输入", TERM_WRITE_WAIT_MS).await?;
    tokio::time::timeout(
        Duration::from_millis(TERM_WRITE_WAIT_MS),
        handle.data(channel_id, russh::CryptoVec::from_slice(data.as_bytes())),
    )
    .await
    .map_err(|_| "终端输入：写入超时，请重试".to_string())?
    .map_err(|_| "终端输入：写入失败".to_string())
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
    let mut channel = open_channel(conn, "命令执行").await?;
    tokio::time::timeout(
        Duration::from_millis(CHANNEL_SETUP_MS),
        channel.exec(true, command),
    )
    .await
    .map_err(|_| format!("命令执行：提交命令超时（{CHANNEL_SETUP_MS}ms）"))?
    .map_err(|e| format!("命令执行：提交命令失败：{e}"))?;
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
    let channel = open_channel(conn, "SFTP 目录").await?;
    // 通道确认后即释放公共锁：目录读取可能很慢，不能挡住终端打开与输入。
    let sftp = tokio::time::timeout(
        Duration::from_millis(CHANNEL_SETUP_MS),
        russh_sftp::client::SftpSession::new(channel.into_stream()),
    )
    .await
    .map_err(|_| format!("SFTP：初始化超时（{CHANNEL_SETUP_MS}ms）"))?
    .map_err(|e| format!("SFTP 初始化失败：{}", e))?;
    let entries = tokio::time::timeout(Duration::from_millis(SFTP_OP_MS), sftp.read_dir(path))
        .await
        .map_err(|_| format!("读取目录超时（{}ms），此请求已取消，请重试", SFTP_OP_MS))?
        .map_err(|e| format!("读取目录失败：{}", e))?;
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
    let channel = open_channel(conn, "SFTP 读取").await?;
    let sftp = tokio::time::timeout(
        Duration::from_millis(CHANNEL_SETUP_MS),
        russh_sftp::client::SftpSession::new(channel.into_stream()),
    )
    .await
    .map_err(|_| format!("SFTP：初始化超时（{CHANNEL_SETUP_MS}ms）"))?
    .map_err(|e| format!("SFTP 初始化失败：{}", e))?;
    let data = tokio::time::timeout(Duration::from_millis(SFTP_OP_MS), sftp.read(path))
        .await
        .map_err(|_| format!("读取文件超时（{}ms），此请求已取消，请重试", SFTP_OP_MS))?
        .map_err(|e| format!("读取失败：{}", e))?;
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

#[cfg(test)]
mod timeout_tests {
    use super::*;

    /// 锁被长期占用时必须按预算返回可读错误，而不是无限期等待（AC-STORY-035-CR068-02）。
    #[tokio::test]
    async fn lock_wait_times_out_with_stage_message() {
        let mutex = AsyncMutex::new(7u32);
        let held = mutex.lock().await;
        let started = std::time::Instant::now();
        let err = lock_with_timeout(&mutex, "终端", 50).await.expect_err("占用期间应超时");
        assert!(err.contains("终端"), "{err}");
        assert!(err.contains("超过 50ms"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(1), "超时预算未生效：{:?}", started.elapsed());
        drop(held);
        let guard = lock_with_timeout(&mutex, "终端", 50).await.expect("释放后应取得锁");
        assert_eq!(*guard, 7);
    }

    /// 端到端（仅本机测试 SSH 服务器）：长辅助 I/O 占住共享锁时，终端打开按预算失败；
    /// 释放后能真正开出交互 shell。不连接任何真实主机，也不读取真实凭据。
    #[tokio::test]
    async fn terminal_open_fails_fast_on_lock_wait_and_succeeds_after_release() {
        let run = async {
            let port = testserver::start().await.expect("启动本机测试 SSH 服务器");
            let host = "127.0.0.1";
            let user = "smoke";
            let host_id = "cr068-lock-wait-test";
            connect(
                host_id,
                host,
                port,
                user,
                &crate::commands::servers::HostAuth::Password { password: "smoke-pass".to_string() },
            )
            .await
            .expect("连接本机测试服务器");
            let conn = get_connection(user, host, port).expect("取得连接");

            // 模拟辅助 I/O 长期占用共享句柄：终端打开必须在锁等待预算内失败并给出原因。
            let held = conn.handle.lock().await;
            let started = std::time::Instant::now();
            let err = open_terminal(&conn, host_id, 80, 24, |_| {}, |_| {})
                .await
                .expect_err("共享锁被占住时终端打开应超时失败");
            assert!(err.contains("终端") && err.contains("占用超过"), "{err}");
            assert!(started.elapsed() >= Duration::from_millis(2_000), "未等待锁等待预算：{:?}", started.elapsed());
            assert!(started.elapsed() < Duration::from_secs(6), "未按预算失败：{:?}", started.elapsed());
            drop(held);

            let term = open_terminal(&conn, host_id, 80, 24, |_| {}, |_| {})
                .await
                .expect("释放锁后终端应可打开");
            close_terminal(&term);
            disconnect(host_id, user, host, port).await;
        };
        tokio::time::timeout(Duration::from_secs(30), run).await.expect("测试整体超时");
    }
}
