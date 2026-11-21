//! IPC 冒烟测试支撑（TAURI_SMOKE=1 时启用）：
//! - smoke_prepare_fixtures：在 app_data_dir/smoke 下准备隔离夹具（项目文档树 / 知识库目录 / git 仓库）
//! - smoke_report_write：冒烟报告落盘并打印到 stdout
//! 仅测试工具，不参与业务逻辑。

use crate::models::now_ms;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(args);
    let _ = cmd.output();
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn smoke_should_run() -> bool {
    std::env::var("TAURI_SMOKE").is_ok()
}

#[tauri::command]
pub fn smoke_prepare_fixtures(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("smoke");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // ---------- 项目夹具：docs/Plan 需求树 + docs/UI + docs/DB ----------
    let proj = base.join("proj-demo");
    let vision = r#"---
id: VISION-DEMO
type: vision
title: 演示项目愿景
status: 设计评审
---

# 演示项目愿景

让个人 Agent 工作台可追踪、可实现、可验证。
"#;
    let epic = r#"---
id: EPIC-001-DEMO
type: epic
parent: VISION-DEMO
title: 工作台导航与体验
status: 设计中
---

# EPIC-001-DEMO：工作台导航与体验

提供一致的全局导航与视觉。
"#;
    let feature = r#"---
id: FEAT-001-DEMO
type: feature
parent: EPIC-001-DEMO
title: 项目工作区
status: 设计中
---

# FEAT-001-DEMO：项目工作区

需求、设计、编码三页签。
"#;
    let story = r#"---
id: STORY-001-DEMO
type: story
parent: FEAT-001-DEMO
title: 需求树展示
status: 开发中
owner: owner
---

# STORY-001-DEMO：需求树展示

给定项目文档，当进入需求页签，则展示带编号的层级树。

- AC-STORY-001-DEMO-01：树按 Epic/Feature/Story 层级展开。
"#;
    write(&proj.join("docs/Plan/Vision/VISION-DEMO.md"), vision)?;
    write(&proj.join("docs/Plan/Epic/EPIC-001-DEMO.md"), epic)?;
    write(&proj.join("docs/Plan/Feature/FEAT-001-DEMO.md"), feature)?;
    write(&proj.join("docs/Plan/Story/STORY-001-DEMO.md"), story)?;
    write(&proj.join("docs/UI/UI设计.md"), "# UI 设计\n\n白蓝简洁风。\n")?;
    write(&proj.join("docs/DB/数据模型.md"), "# 数据模型\n\nproject / session / grant。\n")?;
    write(&proj.join("README.md"), "# proj-demo\n\n冒烟夹具项目。\n")?;

    // ---------- 知识库夹具：两个 md 笔记 ----------
    let kb = base.join("kb-demo");
    write(&kb.join("指南/入门.md"), "# 入门指南\n\n关键词 alpha：知识检索应命中本行。\n")?;
    write(&kb.join("参考/协议.md"), "# 协议参考\n\nbeta 协议说明。\n")?;

    // ---------- Git 仓库夹具 ----------
    let repo = base.join("repo-demo");
    // 每次冒烟重建，保证状态确定性
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).map_err(|e| e.to_string())?;
    {
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "smoke@example.com"]);
        git(&repo, &["config", "user.name", "smoke"]);
        write(&repo.join("a.txt"), "a 内容 v1\n")?;
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "initial commit"]);
        git(&repo, &["branch", "feature/x"]);
write(&repo.join("a.txt"), "a 内容 v1
a 追加修改行
")?;
                write(&repo.join("b.txt"), "b 未暂存修改\n")?;
        write(&repo.join("c.txt"), "c 已暂存\n")?;
        git(&repo, &["add", "c.txt"]);
    }

    Ok(serde_json::json!({
        "projectDir": proj.to_string_lossy(),
        "kbDir": kb.to_string_lossy(),
        "repoDir": repo.to_string_lossy(),
        "preparedAt": now_ms(),
    }))
}

#[tauri::command]
pub fn smoke_report_write(app: tauri::AppHandle, content: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("smoke-report.md");
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    println!("SMOKE-REPORT-BEGIN {}", path.to_string_lossy());
    println!("{}", content);
    println!("SMOKE-REPORT-END");
    Ok(path.to_string_lossy().to_string())
}

/// 注入 JS 错误陷阱：捕获页面 error/unhandledrejection 并回传报告（诊断用）。
#[tauri::command]
pub fn smoke_instrument(window: tauri::WebviewWindow) -> Result<(), String> {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let js = "window.addEventListener('error',function(e){try{window.__TAURI_INTERNALS__.invoke('smoke_report_write',{content:'JS ERROR: '+e.message+' @ '+e.filename+':'+e.lineno+':'+e.colno});}catch(err){}});window.addEventListener('unhandledrejection',function(e){try{window.__TAURI_INTERNALS__.invoke('smoke_report_write',{content:'REJECTION: '+String(e.reason)});}catch(err){}});setTimeout(function(){try{window.__TAURI_INTERNALS__.invoke('smoke_report_write',{content:'页面 JS 存活探针'});}catch(err){}},100);";
        let _ = window.eval(js);
    });
    Ok(())
}

/// 进程 spawn 诊断探针：直接测试 .cmd 批处理与 npm 的解析（冒烟用）。
#[tauri::command]
pub fn smoke_spawn_probe() -> Result<serde_json::Value, String> {
    let path_head = std::env::var("PATH").unwrap_or_default().chars().take(400).collect::<String>();
    let resolved = crate::util::resolve_command("claude");
    let resolved_npm = crate::util::resolve_command("npm");
    let claude = {
        let mut cmd = Command::new(&resolved);
        cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        match cmd.output() {
            Ok(o) => format!(
                "status={:?} out={} err={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
            Err(e) => format!("spawn-err: {}", e),
        }
    };
    let npm = {
        let mut cmd = Command::new(&resolved_npm);
        cmd.args(["ls", "-g", "--depth=0", "--json"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        match cmd.output() {
            Ok(o) => format!(
                "status={:?} out_head={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stdout).chars().take(160).collect::<String>()
            ),
            Err(e) => format!("spawn-err: {}", e),
        }
    };
    Ok(serde_json::json!({
        "claude": claude,
        "npm": npm,
        "resolvedClaude": resolved,
        "resolvedNpm": resolved_npm,
        "pathHead": path_head,
    }))
}


/// 复刻 chat 后端的 spawn 时序（tokio + 管道 stdin + shutdown），验证 mock 全链路。
#[tauri::command]
pub async fn smoke_mock_full() -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let resolved = {
        let pinned = crate::db::conn().ok().and_then(|g| {
            let conn = g.as_ref()?;
            conn.query_row(
                "SELECT path FROM cli_sdk WHERE id='claude' AND enabled=1",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .filter(|p| !p.is_empty() && std::path::Path::new(p).is_file())
        });
        pinned.unwrap_or_else(|| crate::util::resolve_command("claude"))
    };
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.kill_on_drop(true).spawn().map_err(|e| format!("spawn: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(b"hello
").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        drop(stdin);
    }
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
    let mut lines = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let mut line = String::new();
        match tokio::time::timeout_at(deadline, stdout.read_line(&mut line)).await {
            Err(_) => { lines.push("<TIMEOUT>".into()); break; }
            Ok(Err(e)) => { lines.push(format!("<ERR {}>", e)); break; }
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => lines.push(line.trim().chars().take(120).collect()),
        }
    }
    let status = child.try_wait().ok().flatten().map(|s| s.code()).flatten();
    Ok(serde_json::json!({ "resolved": resolved, "lines": lines, "exitCode": status }))
}

/// Channel 送达探针：立即 3 个 + 分离任务延迟 3 个（验证后台任务发送可达性）。
#[tauri::command]
pub async fn smoke_channel_probe(channel: tauri::ipc::Channel<i32>) -> Result<(), String> {
    for i in 0..3 {
        channel.send(i).map_err(|e| e.to_string())?;
    }
    let ch = channel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        for i in 10..13 {
            let _ = ch.send(i);
        }
    });
    Ok(())
}

/// 启动本地测试 SSH 服务器（russh），返回端口。冒烟专用。
#[tauri::command]
pub async fn smoke_start_ssh() -> Result<u16, String> {
    crate::ssh::testserver::start().await
}

/// 冒烟用：设置 mock CLI 的 resume 场景（confirm/silent-new/stale/refuse）。
/// 通过进程环境变量传给子进程（mock-cli.cs / mock-*.mjs 读取 MOCK_RESUME）。
#[tauri::command]
pub fn smoke_mock_resume(mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "confirm" | "silent-new" | "stale" | "refuse") {
        return Err(format!("未知 MOCK_RESUME 场景：{}", mode));
    }
    std::env::set_var("MOCK_RESUME", &mode);
    Ok(())
}

/// 冒烟用：当前是否处于保留库模式（SMOKE_KEEP_DB=1），供套件区分「首次建档」与「重启复验」。
#[tauri::command]
pub fn smoke_keep_db_flag() -> bool {
    std::env::var("SMOKE_KEEP_DB").map(|v| v == "1").unwrap_or(false)
}

/// 冒烟用：把 SDK 登记路径清空，让 claude 走 PATH 解析到真实 CLI。
#[tauri::command]
pub fn smoke_use_real_claude() -> Result<(), String> {    // 解析真实 claude 可执行文件（排除 mockbin，避免误用 mock）。
    // Git Bash 启动时 SMOKE_MOCKBIN 会带正斜杠（D:/…），PATH 目录是反斜杠，须归一化后比较。
    let mock_dir = std::env::var("SMOKE_MOCKBIN").unwrap_or_default();
    let mock_norm = mock_dir.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let mut real: Option<std::path::PathBuf> = None;
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if !mock_norm.is_empty()
                && dir.to_string_lossy().replace('/', "\\").to_lowercase().contains(&mock_norm)
            {
                continue;
            }
            for ext in ["cmd", "exe"] {
                let cand = dir.join(format!("claude.{}", ext));
                if cand.is_file() {
                    real = Some(cand);
                    break;
                }
            }
            if real.is_some() {
                break;
            }
        }
    }
    let real = real.ok_or("未找到真实 claude CLI（PATH 中除 mockbin 外无 claude）")?;
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "UPDATE cli_sdk SET path=?1, installState='installed' WHERE id='claude'",
        rusqlite::params![real.to_string_lossy()],
    )
    .map_err(|e| e.to_string())?;
    eprintln!("[smoke] 真实 claude = {}", real.display());
    Ok(())
}

/// 冒烟用：读取本地 mock 网关的请求记录（验证注入是否真的到达网关）。
#[tauri::command]
pub fn smoke_gateway_record(url: String) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(5))
        .build();
    let resp = agent.get(&url).call().map_err(|e| format!("读取网关记录失败：{}", e))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("解析网关记录失败：{}", e))
}

/// 启动时把环境变量里的真实密钥写入设置表，供套件执行真实供应商用例。
pub fn seed_live_key_from_env() -> Result<(), String> {
    let Ok(key) = std::env::var("TIERFLOW_SMOKE_KEY") else { return Ok(()) };
    if key.trim().is_empty() { return Ok(()); }
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global','smoke.tierflowKey',?1,?2)
         ON CONFLICT(scope,key) DO UPDATE SET value=?1, updatedAt=?2",
        rusqlite::params![key, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 冒烟用：给预置供应商写入测试密钥（值来自环境变量，不写死在代码里）。
#[tauri::command]
pub fn smoke_set_tierflow_key(app: tauri::AppHandle, key: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("secrets.json");
    let mut map: std::collections::BTreeMap<String, String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let key_id = "key-tf-live";
    map.insert(key_id.to_string(), key);
    std::fs::write(&path, serde_json::to_vec_pretty(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    conn.execute(
        "INSERT OR REPLACE INTO provider_key (id, providerId, alias, secretRef, masked, enabled, createdAt)
         VALUES (?1, 'prov-tierflow-default', 'live', ?1, ?2, 1, ?3)",
        rusqlite::params![key_id, "sk-8****BV8M", crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(key_id.to_string())
}

/// 冒烟进度标记：前端每完成一段就写一次，便于定位卡点。
#[tauri::command]
pub fn smoke_progress(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let p = dir.join("smoke-progress.txt");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).map_err(|e| e.to_string())?;
    writeln!(f, "{}", label).map_err(|e| e.to_string())?;
    Ok(())
}
