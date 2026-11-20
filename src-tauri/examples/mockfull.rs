//! 复刻 chat/mock_full 的 spawn 时序，独立定位 stdin EOF 问题。
//! 运行：cargo run --example mockfull --manifest-path src-tauri/Cargo.toml
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const EXE: &str = "D:\\github\\AI_Delelovelop\\mockbin\\claude.exe";
const CWD: &str = "C:\\Users\\gaohu\\AppData\\Roaming\\com.agentworkbench.app\\smoke\\proj-demo";

fn claude_args() -> [&'static str; 8] {
    [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--model",
    ]
}

fn spawn_tokio(exe: &str, cwd: Option<&str>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(claude_args()).arg("smoke-model");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// 与 chat.rs 完全一致：select! + watch abort + trim + eprintln
async fn variant_select(name: &str) {
    let (abort_tx, mut abort_rx) = tokio::sync::watch::channel(false);
    let mut child = spawn_tokio(EXE, Some(CWD))
        .kill_on_drop(true)
        .spawn()
        .expect("spawn");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all("你好
".as_bytes()).await;
        let _ = stdin.flush().await;
        drop(stdin);
    }
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
    if let Some(mut err) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 8192];
            loop {
                match err.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
    let mut lines = 0;
    let mut line = String::new();
    let mut aborted = false;
    loop {
        line.clear();
        tokio::select! {
            _ = abort_rx.changed() => {
                if *abort_rx.borrow() {
                    aborted = true;
                    let _ = child.kill().await;
                    break;
                }
            }
            n = stdout.read_line(&mut line) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            lines += 1;
                            println!("[{name}] 行{lines}: {}", trimmed.chars().take(70).collect::<String>());
                        }
                        if trimmed.is_empty() { continue; }
                    }
                }
            }
        }
    }
    if aborted {
        println!("[{name}] ABORTED（提前返回）");
        return;
    }
    let status = child.wait().await.ok().and_then(|s| s.code());
    println!("[{name}] 完成 lines={lines} exit={status:?}");
    drop(abort_tx);
}

/// chat 的精确时序：tokio spawn → take stdin 写入+drop → take stdout 读循环
async fn variant_chat_exact(name: &str) {
    let mut child = spawn_tokio(EXE, Some(CWD))
        .kill_on_drop(true)
        .spawn()
        .expect("spawn");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all("你好\n".as_bytes()).await;
        let _ = stdin.flush().await;
        drop(stdin);
    }
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
    let err_shared = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let sink = err_shared.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 8192];
            loop {
                match err.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut s = sink.lock().unwrap();
                        if s.len() < 8000 {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                    }
                }
            }
        });
    }
    let mut lines = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    loop {
        let mut line = String::new();
        match tokio::time::timeout_at(deadline, stdout.read_line(&mut line)).await {
            Err(_) => {
                let st = child.try_wait().ok().flatten().map(|s| s.code());
                println!("[{name}] 读超时 lines={lines} child={st:?} stderr={}", err_shared.lock().unwrap());
                let _ = child.kill().await;
                return;
            }
            Ok(Err(e)) => {
                println!("[{name}] 读错误: {e}");
                return;
            }
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {
                lines += 1;
                println!("[{name}] 行{lines}: {}", line.trim().chars().take(80).collect::<String>());
            }
        }
    }
    let status = child.wait().await.ok().and_then(|s| s.code());
    println!("[{name}] 完成 lines={lines} exit={status:?}");
}

/// 对照：std 同步 + 完整参数 + cwd
fn variant_std(name: &str) {
    use std::io::{BufRead, Write};
    let mut child = std::process::Command::new(EXE);
    child.args(claude_args()).arg("smoke-model");
    child.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(CWD);
    let mut child = child.spawn().expect("spawn");
    {
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all("你好\n".as_bytes());
        drop(stdin);
    }
    let mut out = String::new();
    let reader = std::io::BufReader::new(child.stdout.take().unwrap());
    for line in reader.lines() {
        match line {
            Ok(l) => {
                out.push_str(&l.chars().take(60).collect::<String>());
                out.push('\n');
                if out.lines().count() >= 5 {
                    break;
                }
            }
            Err(e) => {
                out.push_str(&format!("ERR {e}"));
                break;
            }
        }
    }
    let status = child.try_wait();
    println!(
        "[{name}] 行数={} 前3行={}",
        out.lines().count(),
        out.lines().take(3).collect::<Vec<_>>().join(" | ")
    );
    println!("[{name}] status={status:?}");
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    variant_select("S1: select!+watch（current_thread）").await;
    variant_chat_exact("F: chat 精确复刻（tokio+全参数+cwd）").await;
    variant_std("G: std 同步对照（全参数+cwd）");
    variant_chat_exact("H: chat 精确复刻 重试").await;
}
