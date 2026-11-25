//! Git 命令封装（对照 dsh-git-branch 的命令清单与 porcelain 解析逻辑移植）。
//!
//! 执行方式：tokio::process 数组参数调用 git CLI，不做 shell 拼接；
//! core.quotepath=false 保证中文路径；失败返回 git stderr。

use crate::models::{BranchEntry, CommitEntry, CommitFileEntry, GitChange, GitStatus};
use std::io::Write;
use std::path::Path;
use tokio::process::Command;

async fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(crate::util::resolve_command("git"));
    cmd.current_dir(repo).args(args).env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git 启动失败：{}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

async fn git_checked(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(repo, args).await?;
    Ok(out)
}

/// 带附加环境变量的执行（CR-067）：仅用于注入 `GIT_CONFIG_*` 与提示开关，
/// 参数仍是数组、不经 shell。失败同样回 stderr。
async fn git_with_env(
    repo: &Path,
    args: &[&str],
    envs: &[(String, String)],
) -> Result<String, String> {
    let mut cmd = Command::new(crate::util::resolve_command("git"));
    cmd.current_dir(repo).args(args).env("GIT_OPTIONAL_LOCKS", "0");
    for (key, value) in envs {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git 启动失败：{}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn is_repo_dir(p: &Path) -> bool {
    p.join(".git").exists()
}

fn find_repo(start: &str) -> Result<std::path::PathBuf, String> {
    let mut cur = std::path::PathBuf::from(start);
    if !cur.is_dir() {
        return Err(format!("目录不存在：{}", start));
    }
    loop {
        if is_repo_dir(&cur) {
            return Ok(cur);
        }
        if !cur.pop() {
            return Err("该目录不在 Git 仓库内".into());
        }
    }
}

/// 仓库总览：分支、HEAD、上游、变更列表（porcelain v1 -z 解析）。
#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let repo = find_repo(&repo_path)?;
    let state_branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    if state_branch.is_err() {
        return Ok(GitStatus {
            repo_root: repo.to_string_lossy().to_string(),
            state: "error".into(),
            branch: None,
            head_oid: None,
            upstream: None,
            ahead: None,
            behind: None,
            changes: vec![],
        });
    }
    let branch_out = state_branch.unwrap().trim().to_string();
    let head = git(&repo, &["rev-parse", "HEAD"]).await.ok().map(|s| s.trim().to_string());
    let detached = branch_out == "HEAD";
    let status_raw = git(
        &repo,
        &["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"],
    )
    .await?;
    let changes = parse_porcelain(&status_raw);
    // 上游与 ahead/behind
    let mut upstream = None;
    let mut ahead = None;
    let mut behind = None;
    if !detached {
        if let Ok(u) = git(&repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await {
            upstream = Some(u.trim().to_string());
            if let Ok(ab) = git(
                &repo,
                &["rev-list", "--left-right", "--count", &format!("{}...HEAD", upstream.as_ref().unwrap())],
            )
            .await
            {
                let parts: Vec<&str> = ab.trim().split('\t').collect();
                if parts.len() == 2 {
                    behind = parts[0].parse().ok();
                    ahead = parts[1].parse().ok();
                }
            }
        }
    }
    Ok(GitStatus {
        repo_root: repo.to_string_lossy().to_string(),
        state: if detached { "detached".into() } else { "ready".into() },
        branch: if detached { None } else { Some(branch_out) },
        head_oid: head,
        upstream,
        ahead,
        behind,
        changes,
    })
}

/// porcelain v1 -z：每条目 `XY <path>` NUL 分隔；R/C 有第二条 NUL 路径。
fn parse_porcelain(raw: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = it.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = entry.as_bytes()[0] as char;
        let y = entry.as_bytes()[1] as char;
        let path = &entry[3..];
        let old_path: Option<String> = if x == 'R' || x == 'C' {
            it.next().map(|s| s.to_string())
        } else {
            None
        };
        let untracked = x == '?' && y == '?';
        let staged = (!untracked && x != ' ').then(|| {
            if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
                'U'
            } else {
                x
            }
        });
        let unstaged = (!untracked && y != ' ').then(|| {
            if x == 'U' || y == 'U' {
                'U'
            } else {
                y
            }
        });
        changes.push(GitChange {
            path: path.to_string(),
            old_path,
            staged: staged.map(|c| c.to_string()),
            unstaged: unstaged.map(|c| c.to_string()).filter(|_| !untracked),
            untracked,
        });
    }
    changes
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    git(&repo, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    git(&repo, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_discard(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    // 仅对未暂存修改 checkout -- <path>；不做 clean（untracked 由 UI 单独提示）
    let repo = find_repo(&repo_path)?;
    let mut args = vec!["checkout", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    git(&repo, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    let repo = find_repo(&repo_path)?;
    if message.trim().is_empty() {
        return Err("提交信息不能为空".into());
    }
    git(&repo, &["commit", "-m", &message]).await?;
    let oid = git(&repo, &["rev-parse", "HEAD"]).await?;
    Ok(oid.trim().to_string())
}

#[tauri::command]
pub async fn git_diff_file(repo_path: String, path: String, staged: bool) -> Result<String, String> {
    let repo = find_repo(&repo_path)?;
    if staged {
        git(&repo, &["-c", "core.quotepath=false", "diff", "--cached", "--", &path]).await
    } else {
        git(&repo, &["-c", "core.quotepath=false", "diff", "--", &path]).await
    }
}

/// 分支列表（本地 + 远程，含 ahead/behind）。
#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<Vec<BranchEntry>, String> {
    let repo = find_repo(&repo_path)?;
    let current = git(&repo, &["branch", "--show-current"]).await?.trim().to_string();
    let mut out = Vec::new();
    let local = git(
        &repo,
        &["-c", "core.quotepath=false", "for-each-ref", "refs/heads",
          "--format=%(refname:short)\t%(upstream:track)"],
    )
    .await?;
    for line in local.lines() {
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("").to_string();
        let track = parts.next().unwrap_or("");
        let (ahead, behind) = parse_track(track);
        out.push(BranchEntry {
            ahead,
            behind,
            current: name == current,
            kind: "local".into(),
            name,
        });
    }
    let remote = git(
        &repo,
        &["-c", "core.quotepath=false", "for-each-ref", "refs/remotes", "--format=%(refname:short)"],
    )
    .await?;
    for name in remote.lines().filter(|l| !l.is_empty() && !l.ends_with("/HEAD")) {
        out.push(BranchEntry {
            ahead: None,
            behind: None,
            current: false,
            kind: "remote".into(),
            name: name.to_string(),
        });
    }
    Ok(out)
}

fn parse_track(track: &str) -> (Option<i64>, Option<i64>) {
    let mut ahead = None;
    let mut behind = None;
    for tok in track.split(',').map(|s| s.trim()) {
        if let Some(n) = tok.strip_prefix("ahead ") {
            ahead = n.parse().ok();
        }
        if let Some(n) = tok.strip_prefix("behind ") {
            behind = n.parse().ok();
        }
    }
    (ahead, behind)
}

/// 切换分支；create=true 时新建。
#[tauri::command]
pub async fn git_switch_branch(repo_path: String, name: String, create: bool) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    if create {
        git(&repo, &["switch", "-c", &name]).await.map(|_| ())
    } else {
        git(&repo, &["switch", &name]).await.map(|_| ())
    }
}

/// 提交历史（topo-order，ISO 日期，\x1f 字段分隔）。
///
/// CR-067：新增筛选参数。`all` 追查全部引用（不只是 HEAD 可达），`branch` 指定
/// 单分支/引用（优先于 `all`），`author` 为提交人子串（git 的 `--author` 是正则，
/// 这里先转义再包成子串匹配），`since` 为 ISO 日期下界。
/// 筛选在服务端执行，避免「只在已加载页内过滤」的漏项。
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: Option<i64>,
    skip: Option<i64>,
    all: Option<bool>,
    branch: Option<String>,
    author: Option<String>,
    since: Option<String>,
) -> Result<Vec<CommitEntry>, String> {
    let repo = find_repo(&repo_path)?;
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let skip = skip.unwrap_or(0).max(0);
    let fmt = "%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1f%D%x1e";
    let mut args: Vec<String> = vec![
        "log".into(),
        "--topo-order".into(),
        "--date=iso-strict".into(),
        format!("--max-count={}", limit),
        format!("--skip={}", skip),
        format!("--pretty=format:{}", fmt),
    ];
    // 指定分支：按该引用查询（单分支视图）。未指定时按 all 决定是否追全部引用。
    let branch_filter = branch.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(name) = branch_filter.clone() {
        // 拒绝可能被 git 解释为选项的输入。
        if name.starts_with('-') || name.chars().any(|c| c.is_whitespace()) {
            return Err("分支名不合法".into());
        }
        args.push(name);
    } else if all.unwrap_or(false) {
        args.push("--all".into());
    }
    if let Some(a) = author.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        // 转义正则元字符，再作为子串进行不区分大小写匹配。
        let escaped = a.replace('\\', "\\\\")
            .replace('.', "\\.")
            .replace('*', "\\*")
            .replace('+', "\\+")
            .replace('?', "\\?")
            .replace('(', "\\(")
            .replace(')', "\\)")
            .replace('[', "\\[")
            .replace(']', "\\]")
            .replace('{', "\\{")
            .replace('}', "\\}")
            .replace('|', "\\|")
            .replace('^', "\\^")
            .replace('$', "\\$");
        args.push(format!("--author={}", escaped));
        args.push("--regexp-ignore-case".into());
    }
    if let Some(s) = since.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ':' || c == 'T' || c == 'Z' || c == '+' || c == '.') {
            args.push(format!("--since={}", s));
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = git(&repo, &arg_refs).await?;
    Ok(parse_log(&out))
}

fn parse_log(raw: &str) -> Vec<CommitEntry> {
    raw.split('\x1e')
        .filter(|s| !s.trim().is_empty())
        .map(|block| {
            let f: Vec<&str> = block.trim_start_matches('\n').split('\x1f').collect();
            CommitEntry {
                hash: f.get(0).unwrap_or(&"").to_string(),
                short: f.get(1).unwrap_or(&"").to_string(),
                author_name: f.get(2).unwrap_or(&"").to_string(),
                author_email: f.get(3).unwrap_or(&"").to_string(),
                date: f.get(4).unwrap_or(&"").to_string(),
                parents: f
                    .get(5)
                    .map(|s| s.split_whitespace().map(|p| p.to_string()).collect())
                    .unwrap_or_default(),
                subject: f.get(6).unwrap_or(&"").to_string(),
                body: f.get(7).unwrap_or(&"").to_string(),
                refs: f
                    .get(8)
                    .map(|s| {
                        s.split(", ")
                            .map(|r| r.trim().replace("HEAD -> ", ""))
                            .filter(|r| !r.is_empty())
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// 某提交的文件清单（name-status + numstat 并行对齐）。
#[tauri::command]
pub async fn git_commit_files(repo_path: String, hash: String) -> Result<Vec<CommitFileEntry>, String> {
    let repo = find_repo(&repo_path)?;
    let ns = git(
        &repo,
        &["-c", "core.quotepath=false", "show", "--name-status", "-M", "--format=", &hash],
    )
    .await?;
    let num = git(
        &repo,
        &["-c", "core.quotepath=false", "show", "--numstat", "-M", "--format=", &hash],
    )
    .await?;
    let mut out = Vec::new();
    let mut num_lines = num.lines().filter(|l| !l.trim().is_empty());
    for line in ns.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = line.split('\t');
        let st = it.next().unwrap_or("").to_string();
        let (path, old_path) = match (st.starts_with('R'), it.next(), it.next()) {
            (true, Some(a), Some(b)) => (b.to_string(), Some(a.to_string())),
            (_, Some(a), _) => (a.to_string(), None),
            _ => continue,
        };
        let (ins, del) = num_lines
            .next()
            .map(|l| {
                let mut p = l.split('\t');
                let i = p.next().unwrap_or("-").to_string();
                let d = p.next().unwrap_or("-").to_string();
                (
                    if i == "-" { None } else { i.parse().ok() },
                    if d == "-" { None } else { d.parse().ok() },
                )
            })
            .unwrap_or((None, None));
        out.push(CommitFileEntry {
            deletions: del,
            insertions: ins,
            old_path,
            path,
            status: st.chars().next().unwrap_or('M').to_string(),
        });
    }
    Ok(out)
}

/* ---------- 网络命令（CR-067：可带加速前缀与该主机的令牌） ---------- */

/// 网络命令的公共前缀与额外环境变量。
///
/// 加速只作用于读取（`fetch`／`merge`）：镜像承担传输，写入仍走直连。
/// 凭据按「远端主机」注入，且**不进命令行**：令牌写入应用受管
/// `git-credentials`（0600、原子替换），再用 `GIT_CONFIG_*` 把
/// `credential.helper` 指向该文件。这样进程参数、错误信息与日志里都不会出现令牌。
async fn network_prefix(
    app: &tauri::AppHandle,
    repo: &Path,
    with_accel: bool,
) -> (Vec<String>, Vec<(String, String)>) {
    let cfg = crate::commands::gitconfig::git_accel_get().unwrap_or(
        crate::models::AccelConfig { enabled: false, url: String::new() },
    );
    let prefix = if with_accel {
        crate::commands::gitconfig::accel_args(cfg.enabled, &cfg.url)
    } else {
        Vec::new()
    };

    let mut envs: Vec<(String, String)> = Vec::new();
    let remotes = git(repo, &["remote", "-v"]).await.unwrap_or_default();
    let hosts: Vec<String> = remotes
        .lines()
        .filter(|l| l.contains("(fetch)"))
        .filter_map(|l| l.split('\t').nth(1))
        .filter_map(|rest| crate::commands::gitconfig::host_of_remote_url(rest.trim_end_matches("(fetch)").trim()))
        .collect();
    let mut counted: Vec<(String, String)> = Vec::new();
    for host in hosts.iter() {
        let Some((user, token)) = crate::commands::gitconfig::load_credential(app, host) else { continue };
        let path = match managed_store_path(app) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if ensure_store_entry(&path, host, &user, &token).is_err() {
            continue;
        }
        // 每个主机两条配置：helper 指向受管 store，username 供 git 组装 Basic 认证头。
        counted.push((format!("credential.https://{}.helper", host), format!("store --file={}", path.to_string_lossy())));
        counted.push((format!("credential.https://{}.username", host), user));
    }
    if !counted.is_empty() {
        envs.push(("GIT_CONFIG_COUNT".to_string(), counted.len().to_string()));
        for (i, (key, value)) in counted.into_iter().enumerate() {
            envs.push((format!("GIT_CONFIG_KEY_{}", i), key));
            envs.push((format!("GIT_CONFIG_VALUE_{}", i), value));
        }
        envs.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
    }
    (prefix, envs)
}

/// 受管 git-credentials 文件路径。
fn managed_store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let _ = app;
    Ok(crate::storage_layout::category("git")?.join("git-credentials"))
}

/// 写入（或替换）该主机的凭据行：同一主机只保留一条，0600 与原子替换。
fn ensure_store_entry(
    path: &std::path::Path,
    host: &str,
    user: &str,
    token: &str,
) -> Result<(), String> {
    let line = format!("https://{}:{}@{}\n", encode_userinfo(user), encode_userinfo(token), host);
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l == line.trim_end()) {
        return Ok(());
    }
    let needle = format!("@{host}");
    let kept: String = existing
        .lines()
        .filter(|l| !l.ends_with(&needle))
        .map(|l| format!("{l}\n"))
        .collect();
    let next = format!("{kept}{line}");
    let tmp = path.with_file_name(format!("git-credentials-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| "无法写入凭据文件".to_string())?;
        file.write_all(next.as_bytes()).map_err(|_| "无法写入凭据文件".to_string())?;
        file.sync_all().map_err(|_| "无法保存凭据文件".to_string())?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|_| "无法替换凭据文件".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// git-credentials 的用户名/令牌按百分号编码，`:`、`@`、`/` 等必须转义。
fn encode_userinfo(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[tauri::command]
pub async fn git_fetch(app: tauri::AppHandle, repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    let (prefix, envs) = network_prefix(&app, &repo, true).await;
    let mut args: Vec<String> = prefix;
    args.extend(["fetch".to_string(), "--all".to_string(), "--prune".to_string()]);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_with_env(&repo, &refs, &envs).await.map(|_| ())
}

#[tauri::command]
pub async fn git_pull_ff_only(app: tauri::AppHandle, repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    // 更新 = fetch + ff-only 合并：两个动作都允许走加速读取。
    let (prefix, envs) = network_prefix(&app, &repo, true).await;
    let mut fetch_args: Vec<String> = prefix.clone();
    fetch_args.extend(["fetch".to_string(), "--all".to_string(), "--prune".to_string()]);
    let fetch_refs: Vec<&str> = fetch_args.iter().map(|s| s.as_str()).collect();
    git_with_env(&repo, &fetch_refs, &envs).await?;
    let mut merge_args: Vec<String> = prefix;
    merge_args.extend(["merge".to_string(), "--ff-only".to_string(), "@{u}".to_string()]);
    let merge_refs: Vec<&str> = merge_args.iter().map(|s| s.as_str()).collect();
    git_with_env(&repo, &merge_refs, &envs).await.map(|_| ())
}

#[tauri::command]
pub async fn git_push(app: tauri::AppHandle, repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    // 推送不套加速前缀：镜像只承担读取，写入必须直连远端。
    let (_prefix, envs) = network_prefix(&app, &repo, false).await;
    git_with_env(&repo, &["push"], &envs).await.map(|_| ())
}

/// 当前分支信息（AI 输入区 branch chip 用）。
#[tauri::command]
pub async fn git_branch_state(repo_path: String) -> Result<GitStatus, String> {
    git_status(repo_path).await
}

#[allow(dead_code)]
fn _unused(repo: &Path) {
    let _ = git_checked(repo, &["version"]);
}
