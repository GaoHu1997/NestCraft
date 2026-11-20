//! 冒烟用本地 SSH 服务器（russh server 模式），提供：
//! - 密码认证（用户 smoke / 密码 smoke-pass）
//! - shell：回显输入，模拟 stty 与命令输出
//! - exec：按命令返回固定输出（/proc 采样 => 固定 metrics 文本）
//! - sftp 子系统：拒绝（用于验证未实现路径如实报错）
//! 仅测试工具，不参与生产逻辑。

use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, CryptoVec};
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct TestSshServer {
    pub port: u16,
}

struct Handler;

const PROC_STAT: &str = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n";
const MEMINFO: &str = "MemTotal:       2048000 kB\nMemFree:         200000 kB\nMemAvailable:    800000 kB\n";
const LOADAVG: &str = "0.42 0.35 0.30 1/120 4321\n";
const UPTIME: &str = "123456.78 987654.32\n";
const HOSTNAME: &str = "smoke-host\n";

fn metrics_text() -> String {
    format!("{}{}{}{}{}", PROC_STAT, MEMINFO, LOADAVG, UPTIME, HOSTNAME)
}

#[async_trait::async_trait]
impl russh::server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "smoke" && password == "smoke-pass" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, CryptoVec::from_slice(b"smoke-shell$ "));
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let text = String::from_utf8_lossy(data).to_string();
        // 模拟终端的命令执行：stty 静默；其它命令回显输出
        if text.starts_with("stty ") {
            return Ok(());
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            session.data(channel, CryptoVec::from_slice(b"smoke-shell$ "));
            return Ok(());
        }
        let out = if trimmed == "echo hello" {
            "hello\n".to_string()
        } else if trimmed.starts_with("cat /proc") {
            metrics_text()
        } else {
            format!("ran: {}\n", trimmed)
        };
        session.data(channel, CryptoVec::from_slice(out.as_bytes()));
        session.data(channel, CryptoVec::from_slice(b"smoke-shell$ "));
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        let out = if cmd.contains("/proc/stat") {
            metrics_text()
        } else if cmd.contains("uname") {
            "Linux smoke-host 6.1.0-smoke #1 SMP x86_64 GNU/Linux\n".to_string()
        } else {
            format!("exec-ok: {}\n", cmd.trim())
        };
        session.data(channel, CryptoVec::from_slice(out.as_bytes()));
        session.exit_status_request(channel, 0);
        session.close(channel);
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 测试服务器不实现 SFTP：客户端应收到明确失败
        session.close(channel);
        Ok(())
    }
}

#[derive(Clone)]
struct ServerImpl {
    handle: Arc<tokio::sync::watch::Sender<bool>>,
}

impl russh::server::Server for ServerImpl {
    type Handler = Handler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Handler {
        Handler
    }
}

/// 启动测试服务器；返回监听端口。后台运行，进程退出即结束。
pub async fn start() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, _rx) = tokio::sync::watch::channel(false);
    let mut server = ServerImpl { handle: Arc::new(tx) };
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::key::KeyPair::generate_ed25519().ok_or("密钥生成失败")?],
        auth_rejection_time: std::time::Duration::from_millis(10),
        ..Default::default()
    });
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    Ok(port)
}

/// 便于 lib.rs 的 server 依赖引用（避免 unused 警告）。
pub fn _unused(_: &ServerImpl) {}
