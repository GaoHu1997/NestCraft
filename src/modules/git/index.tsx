import { Icon } from "@/components/icons";
/**
 * Git 管理面板（CR-006 / CR-014 AC-06）。
 * 三段纵向布局（未提交变更 / 分支 / 提交历史，高度比约 2:1:2），段间细分隔线，每段右上刷新。
 * 数据层：src/api 的 git_* 命令（Rust 后端执行真实 git）；失败 toast 展示 stderr。
 * 防竞态：seqRef 请求序号，旧响应不覆盖新状态；数据加载并行化（status+branches / log 各自独立）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import * as api from "@/api";
import type { BranchEntry, CommitEntry, CommitFileEntry, GitChange, GitStatus } from "@/api";
import { Confirm, Empty, useToast } from "@/components/ui";
import "./GitPanel.css";

/* ---------- 常量与小工具 ---------- */

const PAGE = 50;
const COMMIT_MAX = 2000;

type GroupKey = "staged" | "unstaged" | "untracked";
const GROUP_LABEL: Record<GroupKey, string> = { staged: "已暂存", unstaged: "未暂存", untracked: "未跟踪" };

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 相对时间：ISO 日期 → 刚刚 / n 分钟前 / … / 超过一个月回退日期。 */
function relTime(date: string): string {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return date;
  const diff = Date.now() - t;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ahead/behind 展示为 ↑n ↓n。 */
function abText(ahead: number | null, behind: number | null): string {
  const parts: string[] = [];
  if (ahead && ahead > 0) parts.push(`↑${ahead}`);
  if (behind && behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

/** 分支名校验：拒绝 git ref 常见非法形式（新建分支前本地检查）。 */
function branchNameIssue(name: string): string | null {
  const n = name.trim();
  if (!n) return "分支名不能为空";
  if (n.startsWith("-")) return "分支名不能以 - 开头";
  if (/\s/.test(n)) return "分支名不能包含空白字符";
  if (/[~^:?*[\]\\]/.test(n)) return "分支名包含非法字符（~ ^ : ? * [ \\）";
  if (n.includes("..") || n.includes("@{") || n.includes("//")) return "分支名不能包含 .. / @{ / //";
  if (n.startsWith("/") || n.endsWith("/")) return "分支名不能以 / 开头或结尾";
  if (n.endsWith(".")) return "分支名不能以 . 结尾";
  if (n.endsWith(".lock")) return "分支名不能以 .lock 结尾";
  return null;
}

/** 变更行状态字符：untracked 显示 ?，其余取对应列首字符。 */
function statusChar(c: GitChange, group: GroupKey): string {
  if (group === "untracked") return "?";
  const ch = ((group === "staged" ? c.staged : c.unstaged) ?? "").trim().charAt(0).toUpperCase();
  return ch || "?";
}

type DiffKind = "meta" | "hunk" | "add" | "del" | "ctx";

/** 解析 diff 文本行：@@/文件头/+/− 按行染色。 */
function classifyDiffLine(line: string): DiffKind {
  if (line.startsWith("@@")) return "hunk";
  const heads = ["diff --git", "index ", "--- ", "+++ ", "new file", "deleted file", "rename ", "similarity ", "\\ No newline"];
  if (heads.some(h => line.startsWith(h))) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function DiffView({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className="gitp-pre">
      {lines.map((ln, i) => (
        <span key={i} className={`gitp-dl ${classifyDiffLine(ln)}`}>{ln.length ? ln : " "}</span>
      ))}
    </pre>
  );
}

/** refs 徽章：branch 蓝 / tag 紫。 */
function refBadges(refs: string[]): ReactNode {
  return refs.map((r, i) => {
    const t = r.trim();
    if (!t) return null;
    const isTag = t.startsWith("tag:");
    const text = isTag ? t.slice(4).trim() : t.replace("HEAD -> ", "");
    if (!text) return null;
    return <span key={i} className={`gitp-ref ${isTag ? "violet" : "blue"}`}>{text}</span>;
  });
}

const RefreshIcon = (
  <Icon name="refresh" size={13} />
);

/** 存在有效检出（ready 或 detached）时允许提交等写操作；no-repo / error 禁用。 */
const writable = (state: GitStatus["state"] | null) => state === "ready" || state === "detached";

interface ConfirmState {
  title: string;
  message: string;
  danger?: boolean;
  onOk: () => void;
}

/* ---------- GitPanel ---------- */

export function GitPanel({ repoPath, className }: { repoPath: string; className?: string }) {
  const toast = useToast();

  // 数据
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [baseLoading, setBaseLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 动作
  const [actBusy, setActBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [draft, setDraft] = useState("");

  // 分支 UI
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [openRemotes, setOpenRemotes] = useState<Set<string>>(new Set());

  // diff 预览（同一时间只展开一处）
  const [diffOpen, setDiffOpen] = useState<{ group: GroupKey; path: string } | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // 历史内联变更文件
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, { state: "loading" | "ok" | "failed"; data?: CommitFileEntry[] }>>({});

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const seqRef = useRef(0);

  /* ---------- 数据加载（seq 防竞态） ---------- */

  /** 状态 + 分支并行；仅当 seq 仍为最新时落状态。 */
  const refreshBase = useCallback(async (seq: number, quiet: boolean) => {
    const [stR, brR] = await Promise.allSettled([api.gitStatus(repoPath), api.gitBranches(repoPath)]);
    if (seqRef.current !== seq) return;
    if (stR.status === "fulfilled") {
      setStatus(stR.value);
      setLoadErr(null);
    } else {
      setStatus(null);
      setLoadErr(errMsg(stR.reason));
      if (!quiet) toast(errMsg(stR.reason), "err");
    }
    setBranches(brR.status === "fulfilled" ? brR.value : []);
    setBaseLoading(false);
  }, [repoPath, toast]);

  /** 历史第 0 页（初始 50 条）。 */
  const refreshHistory = useCallback(async (seq: number, quiet: boolean) => {
    setLogLoading(true);
    try {
      const page = await api.gitLog(repoPath, PAGE, 0);
      if (seqRef.current !== seq) return;
      setCommits(page);
      setHasMore(page.length >= PAGE);
    } catch (e) {
      if (seqRef.current !== seq) return;
      setCommits([]);
      setHasMore(false);
      if (!quiet) toast(errMsg(e), "err");
    } finally {
      if (seqRef.current === seq) setLogLoading(false);
    }
  }, [repoPath, toast]);

  /** 全量刷新：变更/分支/历史并行。 */
  const loadAll = useCallback(() => {
    const seq = ++seqRef.current;
    setBaseLoading(true);
    void refreshBase(seq, true);
    void refreshHistory(seq, true);
  }, [refreshBase, refreshHistory]);

  // repoPath 变化或首次挂载：重置本地 UI 并全量加载
  useEffect(() => {
    setDraft("");
    setDiffOpen(null);
    setDiffText(null);
    setExpanded(null);
    setFilesByHash({});
    setQuery("");
    setCreating(false);
    setNewName("");
    setOpenRemotes(new Set());
    loadAll();
  }, [loadAll]);

  const refreshBaseBtn = () => {
    const seq = ++seqRef.current;
    setBaseLoading(true);
    void refreshBase(seq, false);
  };
  const refreshHistoryBtn = () => {
    void refreshHistory(++seqRef.current, false);
  };

  /** 滚动到底加载下一页（skip = 已加载数量，按 hash 去重）。 */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || logLoading) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const page = await api.gitLog(repoPath, PAGE, commits.length);
      if (seqRef.current !== seq) return;
      const seen = new Set(commits.map(c => c.hash));
      setCommits(prev => [...prev, ...page.filter(c => !seen.has(c.hash))]);
      setHasMore(page.length >= PAGE);
    } catch (e) {
      if (seqRef.current === seq) toast(errMsg(e), "err");
    } finally {
      if (seqRef.current === seq) setLoadingMore(false);
    }
  }, [repoPath, commits, hasMore, loadingMore, logLoading, toast]);

  const onHistoryScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) void loadMore();
  };

  /* ---------- 动作（busy 门 + 失败 toast(stderr) + 成功后全量刷新） ---------- */

  const runAction = useCallback(async (setBusy: (v: boolean) => void, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      // 变更后旧 diff 预览已过期，关闭并全量刷新
      setDiffOpen(null);
      setDiffText(null);
      loadAll();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }, [loadAll, toast]);

  const stageRow = (c: GitChange) => void runAction(setActBusy, () => api.gitStage(repoPath, [c.path]), "已暂存");
  // rename 取消暂存需要旧路径（git reset 对新路径无效）
  const unstageRow = (c: GitChange) =>
    void runAction(setActBusy, () => api.gitUnstage(repoPath, c.oldPath ? [c.path, c.oldPath] : [c.path]), "已取消暂存");
  const askDiscard = (c: GitChange) =>
    setConfirm({
      title: "放弃修改",
      danger: true,
      message: `放弃「${c.path}」的未暂存修改？\n该操作不可撤销，未提交内容将丢失。`,
      onOk: () => void runAction(setActBusy, () => api.gitDiscard(repoPath, [c.path]), "已放弃未暂存修改"),
    });

  const doCommit = () => {
    const msg = draft.trim();
    if (!msg) return;
    setCommitting(true);
    api.gitCommit(repoPath, msg)
      .then(hash => {
        setDraft("");
        toast(`已提交 ${hash.slice(0, 8)}`);
        loadAll();
      })
      .catch(e => toast(errMsg(e), "err"))
      .finally(() => setCommitting(false));
  };

  const askSwitch = (name: string) => {
    const dirty = (status?.changes.length ?? 0) > 0;
    setConfirm({
      title: "切换分支",
      message: `切换到「${name}」？${dirty ? "\n\n注意：工作区存在未提交修改，切换可能冲突。" : ""}`,
      onOk: () => void runAction(setBranchBusy, () => api.gitSwitchBranch(repoPath, name, false), `已切换到 ${name}`),
    });
  };

  const nameIssue = branchNameIssue(newName);
  const createBranch = () => {
    const n = newName.trim();
    if (!n || branchNameIssue(n) || branchBusy) return;
    setConfirm({ title: "新建并切换分支", message: `基于当前 HEAD 创建「${n}」并切换？${status?.changes.length ? "\n工作区存在未提交修改，切换可能冲突。" : ""}`, onOk: () => void runAction(setBranchBusy, async () => {
      await api.gitSwitchBranch(repoPath, n, true);
      setCreating(false); setNewName("");
    }, `已创建并切换到 ${n}`) });
  };

  const toggleRemote = (r: string) =>
    setOpenRemotes(prev => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });

  const upstream = status?.upstream ?? null;
  const remoteName = upstream && upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : upstream ?? "origin";
  const fetchTitle = `fetch --all --prune：拉取所有远端引用（目标远端 ${remoteName}）`;
  const pullTitle = upstream ? `pull --ff-only：将 ${upstream} 快进合并到当前分支 ${status?.branch ?? ""}` : "未设置上游分支，无法更新";
  const pushTitle = upstream ? `push：推送 ${status?.branch ?? ""} 到 ${upstream}` : "未设置上游分支，无法推送";
  const doFetch = () => void runAction(setSyncBusy, () => api.gitFetch(repoPath), `已拉取远端引用（目标远端 ${remoteName}）`);
  const doPull = () => setConfirm({ title: "更新当前分支", message: `将 ${upstream} 快进合并到 ${status?.branch ?? "当前分支"}？\n会访问真实远端并更新工作区文件；不进行强制合并。`, onOk: () => void runAction(setSyncBusy, () => api.gitPullFfOnly(repoPath), `已更新 ${status?.branch ?? ""} 到 ${upstream} 最新提交（--ff-only）`) });
  const doPush = () => setConfirm({ title: "推送当前分支", message: `推送 ${status?.branch ?? "当前分支"} 到 ${upstream}？\n该操作会写入真实远端，不使用强制推送。`, onOk: () => void runAction(setSyncBusy, () => api.gitPush(repoPath), `已推送 ${status?.branch ?? ""} 到 ${upstream}`) });

  /* ---------- diff 预览 / 历史内联文件 ---------- */

  const toggleDiff = (group: GroupKey, c: GitChange) => {
    if (diffOpen && diffOpen.group === group && diffOpen.path === c.path) {
      setDiffOpen(null);
      setDiffText(null);
      return;
    }
    setDiffOpen({ group, path: c.path });
    setDiffText(null);
    setDiffLoading(true);
    api.gitDiffFile(repoPath, c.path, group === "staged")
      .then(t => setDiffText(t))
      .catch(e => {
        toast(errMsg(e), "err");
        setDiffText("");
      })
      .finally(() => setDiffLoading(false));
  };

  const toggleCommitFiles = (hash: string) => {
    if (expanded === hash) {
      setExpanded(null);
      return;
    }
    setExpanded(hash);
    if (!filesByHash[hash]) {
      setFilesByHash(prev => ({ ...prev, [hash]: { state: "loading" } }));
      api.gitCommitFiles(repoPath, hash)
        .then(list => setFilesByHash(prev => ({ ...prev, [hash]: { state: "ok", data: list } })))
        .catch(() => setFilesByHash(prev => ({ ...prev, [hash]: { state: "failed" } })));
    }
  };

  /* ---------- 派生数据 ---------- */

  const groups = useMemo(() => {
    const changes = status?.changes ?? [];
    return ([
      { key: "staged" as GroupKey, rows: changes.filter(c => c.staged) },
      { key: "unstaged" as GroupKey, rows: changes.filter(c => !c.untracked && c.unstaged) },
      { key: "untracked" as GroupKey, rows: changes.filter(c => c.untracked) },
    ] satisfies { key: GroupKey; rows: GitChange[] }[]).filter(g => g.rows.length > 0);
  }, [status]);
  const stagedCount = groups.find(g => g.key === "staged")?.rows.length ?? 0;

  const { locals, remoteGroups } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const vis = q ? branches.filter(b => b.name.toLowerCase().includes(q)) : branches;
    const locals = vis.filter(b => b.kind === "local");
    const map = new Map<string, BranchEntry[]>();
    for (const b of vis) {
      if (b.kind !== "remote") continue;
      const r = b.name.includes("/") ? b.name.slice(0, b.name.indexOf("/")) : b.name;
      map.set(r, [...(map.get(r) ?? []), b]);
    }
    return { locals, remoteGroups: [...map.entries()] };
  }, [branches, query]);
  const searchActive = query.trim().length > 0;

  const state = status?.state ?? null;

  const renderCommitFiles = (hash: string): ReactNode => {
    const st = filesByHash[hash];
    if (!st || st.state === "loading") return <div className="gitp-files muted">加载变更文件…</div>;
    if (st.state === "failed") return <div className="gitp-files muted">变更文件加载失败</div>;
    const list = st.data ?? [];
    if (list.length === 0) return <div className="gitp-files muted">无文件变更</div>;
    return (
      <div className="gitp-files">
        {list.map(f => {
          const ch = (f.status || "?").charAt(0).toUpperCase();
          return (
            <div key={f.path} className="gitp-file-row">
              <span className="gitp-st" data-st={ch}>{ch}</span>
              <span className="gitp-file-path mono ellipsis" title={f.path}>
                {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
              <span className="gitp-num small mono">
                <span className="add">+{f.insertions ?? "-"}</span> <span className="del">−{f.deletions ?? "-"}</span>
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  /* ---------- 渲染 ---------- */

  return (
    <div className={`gitp ${className ?? ""}`} onScroll={onHistoryScroll}>
      {/* 第一段：未提交变更 */}
      <section className="gitp-sec g2" aria-label="未提交变更">
        <div className="gitp-head">
          <h3>未提交变更</h3>
          {status?.repoRoot && <span className="gitp-repo ellipsis" title={status.repoRoot}>{status.repoRoot}</span>}
          <span className="spacer" />
          <button className="btn icon sm ghost" title="刷新变更" onClick={refreshBaseBtn} disabled={baseLoading}>{RefreshIcon}</button>
        </div>
        <div className="gitp-sync-actions">
          <button className="btn sm" title={fetchTitle} onClick={doFetch} disabled={!writable(state) || syncBusy}>提取</button>
          <button className="btn sm" title={pullTitle} onClick={doPull} disabled={!writable(state) || syncBusy || !upstream}>更新当前分支</button>
          <button className="btn sm" title={pushTitle} onClick={doPush} disabled={!writable(state) || syncBusy || !upstream}>推送当前分支</button>
        </div>
        <div className="gitp-body">
          {baseLoading && !status ? (
            <div className="gitp-note muted small">读取仓库状态…</div>
          ) : !status ? (
            <Empty title="读取仓库失败" desc={loadErr ?? "未知错误"} action={<button className="btn sm" onClick={refreshBaseBtn}>重试</button>} />
          ) : state === "no-repo" ? (
            <Empty title="不是 Git 仓库" desc="当前目录未找到 Git 仓库，可先初始化仓库后点击右上角刷新" />
          ) : state === "error" ? (
            <Empty title="仓库状态异常" desc="Git 仓库读取出现错误，请确认目录有效后刷新" />
          ) : (
            <>
              {groups.map(g => (
                <div key={g.key} className="gitp-group">
                  <div className="gitp-group-head">{GROUP_LABEL[g.key]} <span className="n">{g.rows.length}</span></div>
                  {g.rows.map(c => {
                    const ch = statusChar(c, g.key);
                    const open = diffOpen?.group === g.key && diffOpen.path === c.path;
                    return (
                      <div key={`${g.key}:${c.path}`} className="gitp-change">
                        <div className="gitp-change-row clickable" onClick={() => toggleDiff(g.key, c)}>
                          <input className="gitp-stage-check" type="checkbox" aria-label={`${g.key === "staged" ? "取消暂存" : "暂存"} ${c.path}`} title={g.key === "staged" ? "取消暂存" : "暂存"} checked={g.key === "staged"} disabled={actBusy || committing || branchBusy || syncBusy} onClick={e => e.stopPropagation()} onChange={() => g.key === "staged" ? unstageRow(c) : stageRow(c)} />
                          <span className="gitp-st" data-st={ch}>{ch}</span>
                          <span className="gitp-path mono ellipsis" title={c.path}>
                            {c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
                          </span>
                          <span className="gitp-acts">
                            {g.key === "unstaged" && (
                              <button className="btn sm ghost gitp-discard" disabled={actBusy} onClick={e => { e.stopPropagation(); askDiscard(c); }}>放弃</button>
                            )}
                          </span>
                        </div>
                        {open && (
                          <div className="gitp-diff">
                            {diffLoading ? (
                              <div className="gitp-diff-note muted small">加载差异…</div>
                            ) : diffText ? (
                              <DiffView text={diffText} />
                            ) : (
                              <div className="gitp-diff-note muted small">无差异内容</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {status.changes.length === 0 && <Empty title="工作区干净" desc="没有未提交的变更" />}
            </>
          )}
        </div>
        <div className="gitp-commit">
          <textarea
            className="textarea"
            rows={2}
            maxLength={COMMIT_MAX}
            placeholder="提交信息（第一行作为标题，最多 2000 字符）"
            value={draft}
            onChange={e => setDraft(e.target.value)}
          />
          <div className="row">
            {stagedCount === 0 ? (
              <span className="muted small">暂无已暂存内容：勾选文件暂存后再提交</span>
            ) : (
              <span className="muted small">将提交 {stagedCount} 个已暂存文件</span>
            )}
            <span className="spacer" />
            <button className="btn sm" disabled title="尚未接入基于真实 diff 的 AI 提交信息生成">AI 生成</button>
            <button
              className="btn primary sm"
              disabled={!writable(state) || committing || stagedCount === 0 || draft.trim() === ""}
              onClick={doCommit}
            >
              {committing ? "提交中…" : "提交"}
            </button>
          </div>
        </div>
      </section>

      {/* 第二段：分支 */}
      <section className="gitp-sec g1" aria-label="分支">
        <div className="gitp-head">
          <h3>分支</h3>
          {writable(state) && <span className="muted small ellipsis">{status?.branch}</span>}
          <span className="spacer" />
          <button className="btn sm" onClick={() => setCreating(v => !v)} disabled={!writable(state) || branchBusy}>新建</button>
          <button className="btn icon sm ghost" title="刷新分支" onClick={refreshBaseBtn} disabled={baseLoading}>{RefreshIcon}</button>
        </div>
        <div className="gitp-searchrow">
          <input className="input" placeholder="搜索本地 / 远程分支" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {creating && (
          <div className="gitp-newbranch">
            <input
              className="input"
              autoFocus
              placeholder="新分支名"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") createBranch();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
            <button className="btn primary sm" onClick={createBranch} disabled={branchBusy || !!nameIssue}>创建</button>
            <button className="btn ghost sm" onClick={() => { setCreating(false); setNewName(""); }}>取消</button>
            {newName.trim() && nameIssue && <span className="gitp-fielderr">{nameIssue}</span>}
          </div>
        )}
        <div className="gitp-body">
          {!status ? (
            <Empty title="分支不可用" desc={loadErr ?? "读取仓库状态失败"} action={<button className="btn sm" onClick={refreshBaseBtn}>重试</button>} />
          ) : state === "no-repo" ? (
            <Empty title="分支不可用" desc="需要有效的 Git 仓库才能查看与切换分支" />
          ) : state === "error" ? (
            <Empty title="分支不可用" desc="仓库状态异常，无法列出分支" />
          ) : (
            <>
              {state === "detached" && (
                <div className="gitp-banner">HEAD 处于分离状态（detached HEAD），当前提交不关联任何分支</div>
              )}
              <div className="gitp-branch-row current">
                <span className="dot blue" />
                <span className="name ellipsis">{state === "detached" ? "HEAD（分离）" : status.branch ?? "…"}</span>
                {status.upstream && <span className="up ellipsis">↔ {status.upstream}</span>}
                <span className="spacer" />
                <span className="muted small">{abText(status.ahead, status.behind)}</span>
              </div>
              {locals.length > 0 && (
                <div className="gitp-group-head">本地分支 <span className="n">{locals.length}</span></div>
              )}
              {locals.map(b => {
                const isCur = b.current || b.name === status.branch;
                return (
                  <div
                    key={b.name}
                    className="gitp-branch-row clickable"
                    title={isCur ? "当前分支" : `切换到 ${b.name}`}
                    onClick={() => { if (!isCur) askSwitch(b.name); }}
                  >
                    <span className={`dot ${isCur ? "blue" : "neutral"}`} />
                    <span className="name ellipsis">{b.name}</span>
                    <span className="spacer" />
                    {abText(b.ahead, b.behind) && <span className="muted small">{abText(b.ahead, b.behind)}</span>}
                    {isCur && <span className="tag blue">当前</span>}
                  </div>
                );
              })}
              {remoteGroups.map(([remote, list]) => {
                const open = searchActive || openRemotes.has(remote);
                return (
                  <div key={remote}>
                    <div className="gitp-group-head clickable" onClick={() => toggleRemote(remote)}>
                      <span className="gitp-chevron"><Icon name={open ? "chevronDown" : "chevronRight"} size={14} /></span>
                      远程 {remote} <span className="n">{list.length}</span>
                    </div>
                    {open &&
                      list.map(b => (
                        <div
                          key={b.name}
                          className="gitp-branch-row clickable"
                          title={`检出远程分支 ${b.name}（git 自动创建同名本地分支）`}
                          onClick={() => askSwitch(b.name)}
                        >
                          <span className="gitp-chevron" />
                          <span className="name ellipsis">{b.name.slice(remote.length + 1)}</span>
                        </div>
                      ))}
                  </div>
                );
              })}
              {locals.length === 0 && remoteGroups.length === 0 && (
                <div className="gitp-note muted small">{searchActive ? "无匹配分支" : "无分支数据"}</div>
              )}
            </>
          )}
        </div>
      </section>

      {/* 第三段：提交历史 */}
      <section className="gitp-sec g2" aria-label="提交历史">
        <div className="gitp-head">
          <h3>提交历史</h3>
          {commits.length > 0 && <span className="muted small">{commits.length} 条</span>}
          <span className="spacer" />
          <button className="btn icon sm ghost" title="刷新历史" onClick={refreshHistoryBtn} disabled={logLoading}>{RefreshIcon}</button>
        </div>
        <div className="gitp-body" onScroll={onHistoryScroll}>
          {logLoading && commits.length === 0 ? (
            <div className="gitp-note muted small">加载提交历史…</div>
          ) : commits.length === 0 ? (
            <Empty title="暂无提交记录" desc={state === "no-repo" ? "该目录尚未初始化 Git 仓库" : "该分支还没有任何提交"} />
          ) : (
            <>
              {commits.map(c => (
                <div key={c.hash} className="gitp-commit-item">
                  <div className="gitp-log clickable" onClick={() => toggleCommitFiles(c.hash)} title="点击展开 / 收起变更文件">
                    <div className="row">
                      <span className="gitp-subject ellipsis">{c.subject}</span>
                      <span className="gitp-refs">{refBadges(c.refs)}</span>
                    </div>
                    <div className="row gitp-log-meta muted">
                      <span className="ellipsis">{c.authorName}</span>
                      <span>{relTime(c.date)}</span>
                      <span className="hash">{c.short}</span>
                    </div>
                  </div>
                  {expanded === c.hash && renderCommitFiles(c.hash)}
                </div>
              ))}
              {loadingMore && <div className="gitp-more muted small">加载更多…</div>}
              {!hasMore && <div className="gitp-more muted small">已加载全部提交</div>}
              {logLoading && <div className="gitp-more muted small">刷新中…</div>}
            </>
          )}
        </div>
      </section>

      {confirm && (
        <Confirm
          title={confirm.title}
          message={confirm.message}
          danger={confirm.danger}
          onOk={() => {
            const act = confirm.onOk;
            setConfirm(null);
            act();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
