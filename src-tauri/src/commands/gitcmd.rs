//! Git 命令封装（对照 dsh-git-branch 的命令清单与 porcelain 解析逻辑移植）。
//!
//! 执行方式：tokio::process 数组参数调用 git CLI，不做 shell 拼接；
//! core.quotepath=false 保证中文路径；失败返回 git stderr。

use crate::models::{BranchEntry, CommitEntry, CommitFileEntry, GitChange, GitStatus};
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
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: Option<i64>,
    skip: Option<i64>,
) -> Result<Vec<CommitEntry>, String> {
    let repo = find_repo(&repo_path)?;
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let skip = skip.unwrap_or(0).max(0);
    let fmt = "%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1f%D%x1e";
    let out = git(
        &repo,
        &["log", "--topo-order", "--date=iso-strict",
          &format!("--max-count={}", limit), &format!("--skip={}", skip),
          &format!("--pretty=format:{}", fmt)],
    )
    .await?;
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

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    git(&repo, &["fetch", "--all", "--prune"]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_pull_ff_only(repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    git(&repo, &["merge", "--ff-only", "@{u}"]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<(), String> {
    let repo = find_repo(&repo_path)?;
    git(&repo, &["push"]).await.map(|_| ())
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
