import { Icon } from "@/components/icons";
/**
 * Git 管理面板（CR-067，设计：UI-CR067-v1）。
 *
 * 结构按参考图一比一：顶栏（仓库路径药丸 + 国内加速 / 密钥配置 / 刷新）
 * → 三张卡片（未提交变更 2 : 分支 1 : 提交历史 2）。
 * 未提交卡内文件列表独立滚动、提交区固定底部；提交为拆分按钮。
 *
 * 数据层：src/api 的 git_* 命令（Rust 后端执行真实 git）；失败 toast 展示 stderr。
 * 防竞态：seqRef 请求序号，旧响应不覆盖新状态。
 * 滚动条：遵守 UI-SCROLL-001，滚动条仅在实际滚动时显示（全局 scrollbar 处理，不在此禁用）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import * as api from "@/api";
import type { AccelConfig, BranchEntry, CommitEntry, CommitFileEntry, CredentialHostEntry, GitChange, GitStatus, RemoteEntry } from "@/api";
import { Confirm, Empty, Modal, useToast } from "@/components/ui";
import "./GitPanel.css";

/* ---------- 常量与小工具 ---------- */

const PAGE = 50;
const COMMIT_MAX = 2000;
const DEFAULT_ACCEL_URL = "https://gh-proxy.com/";
const CRED_HOST_PRESETS = ["github.com", "gitlab.com", "gitee.com"];

type GroupKey = "staged" | "unstaged";
const GROUP_LABEL: Record<GroupKey, string> = { staged: "已暂存", unstaged: "未暂存" };

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 绝对时间：参考图右列 `YYYY/MM/DD HH:mm`；解析失败回退原文。 */
function stamp(date: string): string {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return date;
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO 下界：时间范围下拉 → `--since` 可接受的取值。 */
function sinceFor(range: "all" | "day" | "week"): string | undefined {
  if (range === "all") return undefined;
  const days = range === "day" ? 1 : 7;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** ahead/behind 展示为 ↓n ↑n（与参考图同序）。 */
function trackText(behind: number | null, ahead: number | null): string {
  if (!behind && !ahead) return "";
  return `↓${behind ?? 0} ↑${ahead ?? 0}`;
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
  if (c.untracked) return "?";
  const ch = ((group === "staged" ? c.staged : c.unstaged) ?? "").trim().charAt(0).toUpperCase();
  return ch || "?";
}

/** 状态字符 → 徽标样式键（? 用 Q，避免与 CSS 类名冲突）。 */
const statusClass = (ch: string) => (ch === "?" ? "Q" : ch);

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
    <pre className="gita-pre">
      {lines.map((ln, i) => (
        <span key={i} className={`gita-dl ${classifyDiffLine(ln)}`}>{ln.length ? ln : " "}</span>
      ))}
    </pre>
  );
}

/** refs 徽章：HEAD / tag / 远程 / 本地四类，对应参考图配色。 */
type RefKind = "head" | "tag" | "remote" | "local";

function refInfo(raw: string): { kind: RefKind; text: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("tag:")) return { kind: "tag", text: t.slice(4).trim() };
  if (t.startsWith("HEAD")) return { kind: "head", text: t };
  if (/^[^/]+\//.test(t)) return { kind: "remote", text: t };
  return { kind: "local", text: t };
}

function refBadges(refs: string[]): ReactNode {
  return refs.map((r, i) => {
    const info = refInfo(r);
    if (!info || !info.text) return null;
    return <span key={i} className={`gita-ref ${info.kind}`}>{info.text}</span>;
  });
}

/* ---------- 提交图谱（前向单趟车道算法） ---------- */

interface GraphEdge { kind: "through" | "in" | "out"; from: number; to: number }
interface GraphRow { lane: number; edges: GraphEdge[] }

const LANE_PITCH = 14;
const LANE_COLORS = ["#4c6bf5", "#2f9e44", "#e8590c", "#9c36b5", "#0c8599", "#d6336c", "#f08c00", "#5f3dc4"];
const laneColor = (n: number) => LANE_COLORS[((n % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];

/** 由 parents 推出每行车道：汇入本提交的车道进点，第一父沿本车道下行，其余父开/并车道。 */
function buildGraph(commits: CommitEntry[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const takeLane = () => {
    const free = lanes.indexOf(null);
    if (free >= 0) return free;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const commit of commits) {
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === commit.hash) incoming.push(i);
    const lane = incoming.length ? incoming[0] : takeLane();
    while (lanes.length <= lane) lanes.push(null);
    if (!incoming.length) incoming.push(lane);
    const top = lanes.slice();
    for (const i of incoming) lanes[i] = null;
    const outs: number[] = [];
    commit.parents.forEach((parent, position) => {
      let target: number;
      if (position === 0) {
        target = lane;
        while (lanes.length <= target) lanes.push(null);
      } else {
        const waiting = lanes.indexOf(parent);
        target = waiting >= 0 ? waiting : takeLane();
      }
      lanes[target] = parent;
      if (!outs.includes(target)) outs.push(target);
    });
    const edges: GraphEdge[] = [];
    for (let i = 0; i < Math.max(top.length, lanes.length); i += 1) {
      const above = top[i] ?? null;
      const below = lanes[i] ?? null;
      if (above === null) continue;
      if (below === above && i !== lane) { edges.push({ kind: "through", from: i, to: i }); continue; }
      edges.push({ kind: "in", from: i, to: lane });
    }
    for (const target of outs) edges.push({ kind: "out", from: lane, to: target });
    rows.push({ lane, edges });
  }
  return rows;
}

function graphWidth(rows: GraphRow[]): number {
  return rows.reduce((w, row) => Math.max(w, row.lane + 1, ...row.edges.map(e => Math.max(e.from, e.to) + 1)), 1);
}

function CommitGraph({ row, width, merge }: { row: GraphRow | undefined; width: number; merge: boolean }) {
  if (!row) return null;
  const band = 44;
  const mid = band / 2;
  const cx = (lane: number) => lane * LANE_PITCH + LANE_PITCH / 2 + 2;
  const bend = (from: number, fromY: number, to: number, toY: number) => {
    const x0 = cx(from);
    const x1 = cx(to);
    if (x0 === x1) return `M ${x0} ${fromY} L ${x1} ${toY}`;
    const m = (toY - fromY) / 2;
    return `M ${x0} ${fromY} C ${x0} ${fromY + m} ${x1} ${toY - m} ${x1} ${toY}`;
  };
  const color = laneColor(row.lane);
  return (
    <>
      <svg width={width} height="100%" viewBox={`0 0 ${width} ${band}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {row.edges.map((edge, i) => {
          const [fromY, toY] = edge.kind === "through" ? [0, band] : edge.kind === "in" ? [0, mid] : [mid, band];
          return (
            <path
              key={`${edge.kind}:${edge.from}:${edge.to}:${i}`}
              d={bend(edge.from, fromY, edge.to, toY)}
              fill="none"
              stroke={laneColor(edge.kind === "out" ? edge.to : edge.from)}
              strokeWidth={1.6}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <span
        className="gita-dot"
        style={{ left: cx(row.lane), color, backgroundColor: merge ? "transparent" : color }}
        aria-hidden="true"
      />
    </>
  );
}

const RefreshIcon = <Icon name="refresh" size={13} />;

/** 存在有效检出（ready 或 detached）时允许提交等写操作；no-repo / error 禁用。 */
const writable = (state: GitStatus["state"] | null) => state === "ready" || state === "detached";

interface ConfirmState {
  title: string;
  message: string;
  danger?: boolean;
  onOk: () => void;
}

type HistoryRange = "all" | "day" | "week";

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

  // 顶栏：加速与密钥
  const [accel, setAccel] = useState<AccelConfig>({ enabled: false, url: DEFAULT_ACCEL_URL });
  const [accelOpen, setAccelOpen] = useState(false);
  const [accelDraft, setAccelDraft] = useState<{ enabled: boolean; url: string }>({ enabled: false, url: DEFAULT_ACCEL_URL });
  const [credOpen, setCredOpen] = useState(false);
  const [creds, setCreds] = useState<CredentialHostEntry[]>([]);
  const [credHost, setCredHost] = useState("github.com");
  const [credToken, setCredToken] = useState("");
  const [credBusy, setCredBusy] = useState(false);

  // 动作
  const [actBusy, setActBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [draft, setDraft] = useState("");
  const [commitMenu, setCommitMenu] = useState(false);

  // 分支 UI
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [remoteForm, setRemoteForm] = useState<{ name: string; url: string } | null>(null);
  const [remotes, setRemotes] = useState<RemoteEntry[]>([]);
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["local"]));

  // 历史 UI
  const [authorDraft, setAuthorDraft] = useState("");
  const [author, setAuthor] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [range, setRange] = useState<HistoryRange>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, { state: "loading" | "ok" | "failed"; data?: CommitFileEntry[] }>>({});

  // diff 预览（同一时间只展开一处）
  const [diffOpen, setDiffOpen] = useState<{ group: GroupKey; path: string } | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const seqRef = useRef(0);

  /* ---------- 数据加载（seq 防竞态） ---------- */

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

  /** 历史按当前筛选重新查询（筛选走服务端，不在已加载页内过滤）。 */
  const refreshHistory = useCallback(async (seq: number, quiet: boolean) => {
    setLogLoading(true);
    try {
      const page = await api.gitLog(repoPath, PAGE, 0, {
        all: branchFilter === "",
        branch: branchFilter || undefined,
        author,
        since: sinceFor(range),
      });
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
  }, [repoPath, toast, author, branchFilter, range]);

  const loadAll = useCallback(() => {
    const seq = ++seqRef.current;
    setBaseLoading(true);
    void refreshBase(seq, true);
    void refreshHistory(seq, true);
  }, [refreshBase, refreshHistory]);

  /** 筛选变化：重置分页，仅重查历史（不动变更与分支）。 */
  const reloadHistory = useCallback(() => {
    void refreshHistory(++seqRef.current, false);
  }, [refreshHistory]);

  // 首次挂载与仓库切换
  useEffect(() => {
    setDraft("");
    setDiffOpen(null);
    setDiffText(null);
    setExpanded(null);
    setFilesByHash({});
    setQuery("");
    setCreating(false);
    setNewName("");
    setOpenGroups(new Set(["local"]));
    loadAll();
  }, [loadAll]);

  // 筛选变化后重查历史（跳过首次由 loadAll 覆盖的那次）
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return; }
    reloadHistory();
  }, [reloadHistory]);

  // 加速配置（全局）
  useEffect(() => {
    api.gitAccelGet()
      .then(cfg => { setAccel(cfg); setAccelDraft(cfg); })
      .catch(() => { /* 读取失败保持默认关闭，不阻断面板 */ });
  }, []);

  const refreshBaseBtn = () => { setBaseLoading(true); void refreshBase(++seqRef.current, false); };
  const refreshHistoryBtn = () => { void refreshHistory(++seqRef.current, false); };

  const toggleAccel = () => {
    if (accelOpen) { setAccelOpen(false); return; }
    setAccelDraft(accel);
    setAccelOpen(true);
  };

  const saveAccel = () => {
    api.gitAccelSet(accelDraft.enabled, accelDraft.url)
      .then(cfg => {
        setAccel(cfg);
        setAccelOpen(false);
        toast(cfg.enabled ? `已启用国内加速：${cfg.url}` : "已关闭国内加速");
      })
      .catch(e => toast(errMsg(e), "err"));
  };

  const openCred = () => {
    if (credOpen) { setCredOpen(false); return; }
    setCredOpen(true);
    setCredToken("");
    api.gitCredentialsList().then(setCreds).catch(e => toast(errMsg(e), "err"));
  };

  const saveCred = () => {
    if (credBusy) return;
    setCredBusy(true);
    api.gitCredentialsSave(credHost, credToken)
      .then(() => {
        setCredToken("");
        toast(`已保存 ${credHost} 的访问令牌`);
        return api.gitCredentialsList().then(setCreds);
      })
      .catch(e => toast(errMsg(e), "err"))
      .finally(() => setCredBusy(false));
  };

  const deleteCred = (host: string) => {
    setConfirm({
      title: "删除令牌",
      danger: true,
      message: `删除 ${host} 的访问令牌？\n删除后该主机的私有仓库操作需要重新配置。`,
      onOk: () => {
        api.gitCredentialsDelete(host)
          .then(() => { toast(`已删除 ${host} 的令牌`); return api.gitCredentialsList().then(setCreds); })
          .catch(e => toast(errMsg(e), "err"));
      },
    });
  };

  const openRemotes = () => {
    api.gitRemotes(repoPath)
      .then(list => { setRemotes(list); setRemoteForm({ name: "", url: "" }); })
      .catch(e => toast(errMsg(e), "err"));
  };

  const saveRemote = () => {
    if (!remoteForm) return;
    api.gitRemoteSave(repoPath, remoteForm.name, remoteForm.url)
      .then(() => {
        toast(`已保存远程 ${remoteForm.name}`);
        setRemoteForm(null);
        return api.gitRemotes(repoPath).then(setRemotes);
      })
      .catch(e => toast(errMsg(e), "err"));
  };

  /* ---------- 滚动到底加载下一页 ---------- */

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || logLoading) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const page = await api.gitLog(repoPath, PAGE, commits.length, {
        all: branchFilter === "",
        branch: branchFilter || undefined,
        author,
        since: sinceFor(range),
      });
      if (seqRef.current !== seq) return;
      const seen = new Set(commits.map(c => c.hash));
      setCommits(prev => [...prev, ...page.filter(c => !seen.has(c.hash))]);
      setHasMore(page.length >= PAGE);
    } catch (e) {
      if (seqRef.current === seq) toast(errMsg(e), "err");
    } finally {
      if (seqRef.current === seq) setLoadingMore(false);
    }
  }, [repoPath, commits, hasMore, loadingMore, logLoading, toast, author, branchFilter, range]);

  const onHistoryScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) void loadMore();
  };

  /* ---------- 动作 ---------- */

  const runAction = useCallback(async (setBusy: (v: boolean) => void, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
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
  const stageAll = (rows: GitChange[]) => {
    if (!rows.length) return;
    void runAction(setActBusy, async () => {
      // rename 只传新路径：旧路径已不在工作区，git add 会报错。
      for (const c of rows) await api.gitStage(repoPath, [c.path]);
    }, `已暂存 ${rows.length} 个文件`);
  };
  const unstageAll = (rows: GitChange[]) => {
    if (!rows.length) return;
    void runAction(setActBusy, async () => {
      for (const c of rows) await api.gitUnstage(repoPath, c.oldPath ? [c.path, c.oldPath] : [c.path]);
    }, `已取消暂存 ${rows.length} 个文件`);
  };

  const doCommit = (push: boolean) => {
    const msg = draft.trim();
    if (!msg) return;
    setCommitMenu(false);
    setCommitting(true);
    api.gitCommit(repoPath, msg)
      .then(async hash => {
        setDraft("");
        if (push) {
          try {
            await api.gitPush(repoPath);
            toast(`已提交 ${hash.slice(0, 8)} 并推送`);
          } catch (e) {
            toast(`已提交 ${hash.slice(0, 8)}，但推送失败：${errMsg(e)}`, "err");
          }
        } else {
          toast(`已提交 ${hash.slice(0, 8)}`);
        }
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
    setConfirm({
      title: "新建并切换分支",
      message: `基于当前 HEAD 创建「${n}」并切换？${status?.changes.length ? "\n工作区存在未提交修改，切换可能冲突。" : ""}`,
      onOk: () => void runAction(setBranchBusy, async () => {
        await api.gitSwitchBranch(repoPath, n, true);
        setCreating(false); setNewName("");
      }, `已创建并切换到 ${n}`),
    });
  };

  const toggleGroup = (key: string) =>
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const upstream = status?.upstream ?? null;
  const remoteName = upstream && upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : upstream ?? "origin";
  const fetchTitle = `fetch --all --prune：拉取所有远端引用（目标远端 ${remoteName}）`;
  const pullTitle = upstream ? `fetch + merge --ff-only：将 ${upstream} 快进合并到当前分支 ${status?.branch ?? ""}` : "未设置上游分支，无法更新";
  const pushTitle = upstream ? `push：推送 ${status?.branch ?? ""} 到 ${upstream}（不使用强制推送）` : "未设置上游分支，无法推送";
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
    if (expanded === hash) { setExpanded(null); return; }
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
    return [
      { key: "staged" as GroupKey, rows: changes.filter(c => c.staged) },
      { key: "unstaged" as GroupKey, rows: changes.filter(c => !c.staged) },
    ];
  }, [status]);
  const stagedCount = groups[0].rows.length;
  const canCommit = stagedCount > 0 && draft.trim() !== "";

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
  const remoteTotal = remoteGroups.reduce((n, [, list]) => n + list.length, 0);

  const state = status?.state ?? null;
  const graph = useMemo(() => buildGraph(commits), [commits]);
  const band = useMemo(() => graphWidth(graph) * LANE_PITCH + 4, [graph]);

  const commitHint = stagedCount === 0
    ? "先勾选文件加入暂存区"
    : draft.trim() === ""
      ? "填写提交信息后可提交"
      : `将提交 ${stagedCount} 个已暂存文件`;

  const renderCommitFiles = (hash: string): ReactNode => {
    const st = filesByHash[hash];
    if (!st || st.state === "loading") return <div className="gita-note">加载变更文件…</div>;
    if (st.state === "failed") return <div className="gita-note">变更文件加载失败</div>;
    const list = st.data ?? [];
    if (list.length === 0) return <div className="gita-note">无文件变更</div>;
    return (
      <>
        {list.map(f => {
          const ch = (f.status || "?").charAt(0).toUpperCase();
          return (
            <div key={f.path} className="gita-file-row">
              <span className={`gita-st ${statusClass(ch)}`}>{ch}</span>
              <span className="gita-file-path" title={f.path}>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
              <span className="gita-file-nums">
                +{f.insertions ?? "-"} −{f.deletions ?? "-"}
              </span>
            </div>
          );
        })}
      </>
    );
  };

  /* ---------- 渲染 ---------- */

  const accelUrlIssue = (() => {
    const v = accelDraft.url.trim();
    if (!v) return "镜像前缀不能为空";
    if (/\s/.test(v)) return "镜像前缀不能包含空白";
    if (!/^https?:\/\//.test(v)) return "镜像前缀必须以 http:// 或 https:// 开头";
    return null;
  })();

  return (
    <div className={`gita ${className ?? ""}`}>
      {/* 顶栏 */}
      <div className="gita-top">
        <span className="gita-repo" title={status?.repoRoot || repoPath}><span>{status?.repoRoot || repoPath}</span></span>
        <div className="gita-top-acts">
          <button
            className="gita-top-btn"
            title="国内加速：仅对 GitHub 的读取操作按前缀重写"
            aria-expanded={accelOpen}
            onClick={toggleAccel}
          >
            <Icon name="zap" size={13} />
            <span>国内加速</span>
            {accel.enabled && <span className="gita-accel-dot" aria-label="已启用" />}
          </button>
          <button
            className="gita-top-btn"
            title="密钥配置：按远端主机保存访问令牌"
            aria-expanded={credOpen}
            onClick={openCred}
          >
            <Icon name="key" size={13} />
            <span>密钥配置</span>
          </button>
          <button className="gita-refresh" title="刷新仓库状态" aria-label="刷新" onClick={() => loadAll()} disabled={baseLoading}>
            {RefreshIcon}
          </button>
        </div>

        {accelOpen && (
          <div className="gita-pop" role="dialog" aria-label="国内加速">
            <div className="gita-pop-h"><Icon name="zap" size={13} /><b>国内加速</b></div>
            <p className="gita-pop-note">
              仅对 GitHub 的读取（提取／更新）按前缀重写地址；推送与私有仓库仍走直连。
            </p>
            <label className="gita-switch-row">
              <button
                type="button"
                role="switch"
                aria-checked={accelDraft.enabled}
                className={`gita-switch ${accelDraft.enabled ? "on" : ""}`}
                onClick={() => setAccelDraft(d => ({ ...d, enabled: !d.enabled }))}
                aria-label="启用加速"
              />
              启用加速
            </label>
            <div className="gita-field">
              <label htmlFor="gita-accel-url">镜像前缀</label>
              <input
                id="gita-accel-url"
                value={accelDraft.url}
                placeholder={DEFAULT_ACCEL_URL}
                onChange={e => setAccelDraft(d => ({ ...d, url: e.target.value }))}
              />
              <span className="gita-err">{accelUrlIssue ?? ""}</span>
            </div>
            <div className="gita-pop-f">
              <button className="gita-act primary" onClick={saveAccel} disabled={!!accelUrlIssue}>保存</button>
              <button className="gita-act" onClick={() => setAccelOpen(false)}>取消</button>
            </div>
          </div>
        )}

        {credOpen && (
          <div className="gita-pop" role="dialog" aria-label="密钥配置">
            <div className="gita-pop-h"><Icon name="key" size={13} /><b>密钥配置</b></div>
            <p className="gita-pop-note">
              按远端主机保存访问令牌，本机所有仓库共用；列表只显示掩码，保存后不回显原值。
            </p>
            {creds.length === 0 ? (
              <p className="gita-empty">尚未保存任何主机的令牌</p>
            ) : (
              creds.map(c => (
                <div key={c.host} className="gita-cred-row">
                  <Icon name="globe" size={13} />
                  <span className="gita-cred-host" title={`${c.host} · ${c.username} · ${c.savedAt}`}>{c.host}</span>
                  <span className="gita-cred-mask">••••••••</span>
                  <button className="gita-link" onClick={() => deleteCred(c.host)}>删除</button>
                </div>
              ))
            )}
            <div className="gita-field">
              <label htmlFor="gita-cred-host">主机</label>
              <input
                id="gita-cred-host"
                list="gita-cred-hosts"
                value={credHost}
                onChange={e => setCredHost(e.target.value)}
                placeholder="github.com"
              />
              <datalist id="gita-cred-hosts">
                {CRED_HOST_PRESETS.map(h => <option key={h} value={h} />)}
              </datalist>
            </div>
            <div className="gita-field">
              <label htmlFor="gita-cred-token">访问令牌</label>
              <input
                id="gita-cred-token"
                type="password"
                autoComplete="new-password"
                value={credToken}
                onChange={e => setCredToken(e.target.value)}
                placeholder={creds.some(c => c.host === credHost.trim().toLowerCase()) ? "留空保留原令牌" : "粘贴 Personal Access Token"}
              />
            </div>
            <div className="gita-pop-f">
              <button className="gita-act primary" onClick={saveCred} disabled={credBusy}>保存</button>
              <button className="gita-act" onClick={() => setCredOpen(false)}>取消</button>
            </div>
          </div>
        )}
      </div>

      <div className="gita-scroll">
        {/* 第一张：未提交变更 */}
        <section className="gita-card changes" aria-label="未提交变更">
          <div className="gita-head">
            <h2 className="gita-title">未提交变更</h2>
            {(status?.changes.length ?? 0) > 0 && <span className="gita-count">{status?.changes.length}</span>}
            <div className="gita-tools">
              <button className="gita-act" title={fetchTitle} onClick={doFetch} disabled={!writable(state) || syncBusy}>
                <Icon name="download" size={13} />提取
              </button>
              <button className="gita-act" title={pullTitle} onClick={doPull} disabled={!writable(state) || syncBusy || !upstream}>
                <Icon name="download" size={13} />更新当前分支
              </button>
              <button className="gita-act" title={pushTitle} onClick={doPush} disabled={!writable(state) || syncBusy || !upstream}>
                <Icon name="upload" size={13} />推送当前分支
              </button>
            </div>
          </div>
          <div className="gita-body">
            <div className="gita-changes">
              {baseLoading && !status ? (
                <p className="gita-note">读取仓库状态…</p>
              ) : !status ? (
                <Empty title="读取仓库失败" desc={loadErr ?? "未知错误"} action={<button className="btn sm" onClick={refreshBaseBtn}>重试</button>} />
              ) : state === "no-repo" ? (
                <Empty title="不是 Git 仓库" desc="当前目录未找到 Git 仓库；初始化后点击顶栏刷新" />
              ) : state === "error" ? (
                <Empty title="仓库状态异常" desc="Git 仓库读取出现错误，请确认目录有效后刷新" />
              ) : status.changes.length === 0 ? (
                <p className="gita-empty">没有未提交的变更</p>
              ) : (
                groups.filter(g => g.rows.length > 0).map(g => (
                  <div key={g.key}>
                    <div className="gita-group-h">
                      {GROUP_LABEL[g.key]} <span className="n">{g.rows.length}</span>
                      <button
                        className={`gita-link ${g.key === "unstaged" ? "accent" : ""}`}
                        disabled={actBusy || committing || branchBusy || syncBusy}
                        onClick={() => (g.key === "staged" ? unstageAll(g.rows) : stageAll(g.rows))}
                      >
                        {g.key === "staged" ? "全部取消暂存" : "全部暂存"}
                      </button>
                    </div>
                    {g.rows.map(c => {
                      const ch = statusChar(c, g.key);
                      const open = diffOpen?.group === g.key && diffOpen.path === c.path;
                      return (
                        <div key={`${g.key}:${c.path}`} className="gita-change">
                          <label className="gita-row">
                            <input
                              className="gita-row-check"
                              type="checkbox"
                              aria-label={`${g.key === "staged" ? "取消暂存" : "暂存"} ${c.path}`}
                              checked={g.key === "staged"}
                              disabled={actBusy || committing || branchBusy || syncBusy}
                              onChange={() => (g.key === "staged" ? unstageRow(c) : stageRow(c))}
                            />
                            <span className={`gita-st ${statusClass(ch)}`}>{ch}</span>
                            <button
                              className="gita-path"
                              title={`${c.path}（点击查看差异）`}
                              onClick={() => toggleDiff(g.key, c)}
                            >
                              {c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
                            </button>
                            <span className="gita-hint">{g.key === "staged" ? "git reset" : "git add"}</span>
                          </label>
                          {open && (
                            <div className="gita-diff">
                              {diffLoading ? (
                                <div className="gita-note">加载差异…</div>
                              ) : diffText ? (
                                <DiffView text={diffText} />
                              ) : (
                                <div className="gita-note">无差异内容</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <div className="gita-commit">
              <textarea
                className="gita-commit-input"
                rows={2}
                maxLength={COMMIT_MAX}
                placeholder="提交信息（feat: …）"
                aria-label="提交信息"
                value={draft}
                onChange={e => setDraft(e.target.value)}
              />
              <div className="gita-commit-acts">
                <button
                  className="gita-act"
                  disabled={!status || status.changes.length === 0}
                  title={status?.changes.length ? "按当前变更生成提交信息（尚未接入真实 diff）" : "没有变更可生成"}
                >
                  <Icon name="sparkles" size={13} />AI 生成
                </button>
                <div className="gita-split">
                  <button className="gita-act primary" disabled={!writable(state) || committing || !canCommit} onClick={() => doCommit(false)}>
                    {committing ? "提交中…" : "提交"}
                  </button>
                  <button
                    className="gita-act primary caret"
                    aria-label="更多提交操作"
                    aria-expanded={commitMenu}
                    disabled={!writable(state) || committing || !canCommit}
                    onClick={() => setCommitMenu(v => !v)}
                  >
                    ▾
                  </button>
                  {commitMenu && (
                    <div className="gita-menu" role="menu">
                      <button className="gita-menu-item" role="menuitem" onClick={() => doCommit(false)}>提交</button>
                      <button className="gita-menu-item" role="menuitem" onClick={() => doCommit(true)}>提交并推送</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="gita-commit-hint">{commitHint}</div>
            </div>
          </div>
        </section>

        {/* 第二张：分支 */}
        <section className="gita-card branches" aria-label="分支">
          <div className="gita-head">
            <h2 className="gita-title">分支</h2>
            <label className="gita-search">
              <Icon name="search" size={13} />
              <input value={query} placeholder="搜索分支" aria-label="搜索分支" onChange={e => setQuery(e.target.value)} />
            </label>
            <div className="gita-tools">
              <button className="gita-link" onClick={() => setOpenGroups(new Set(["local", "remote", ...remoteGroups.map(([r]) => `remote:${r}`)]))}>全部展开</button>
              <button className="gita-link" onClick={() => setOpenGroups(new Set())}>全部折叠</button>
              <button className="gita-link" onClick={openRemotes}>管理远程</button>
              <button className="gita-act" onClick={() => setCreating(v => !v)} disabled={!writable(state) || branchBusy}>
                <Icon name="plus" size={13} />新建分支
              </button>
            </div>
          </div>
          <div className="gita-body scroll">
            {creating && (
              <div className="gita-newbranch">
                <input
                  className="gita-input"
                  autoFocus
                  placeholder="新分支名"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") createBranch();
                    if (e.key === "Escape") { setCreating(false); setNewName(""); }
                  }}
                />
                <button className="gita-act primary" onClick={createBranch} disabled={branchBusy || !!nameIssue}>创建</button>
                <button className="gita-act" onClick={() => { setCreating(false); setNewName(""); }}>取消</button>
                {newName.trim() && nameIssue && <span className="gita-err">{nameIssue}</span>}
              </div>
            )}
            {!status ? (
              <Empty title="分支不可用" desc={loadErr ?? "读取仓库状态失败"} action={<button className="btn sm" onClick={refreshBaseBtn}>重试</button>} />
            ) : state === "no-repo" ? (
              <Empty title="分支不可用" desc="需要有效的 Git 仓库才能查看与切换分支" />
            ) : state === "error" ? (
              <Empty title="分支不可用" desc="仓库状态异常，无法列出分支" />
            ) : (
              <>
                {state === "detached" && (
                  <div className="gita-banner">HEAD 处于分离状态（detached HEAD），当前提交不关联任何分支</div>
                )}
                {searchActive && locals.length === 0 && remoteGroups.length === 0 && (
                  <p className="gita-empty">无匹配分支</p>
                )}
                <div>
                  <div
                    className="gita-tree-h"
                    role="button"
                    tabIndex={0}
                    aria-expanded={openGroups.has("local")}
                    onClick={() => toggleGroup("local")}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup("local"); } }}
                  >
                    <span className="gita-tree-caret"><Icon name={openGroups.has("local") ? "chevronDown" : "chevronRight"} size={12} /></span>
                    <span>本地</span><span className="n">{locals.length}</span>
                  </div>
                  {openGroups.has("local") && (
                    <div className="gita-tree-kids">
                      {locals.map(b => {
                        const isCur = b.current || b.name === status.branch;
                        return (
                          <div
                            key={b.name}
                            className={`gita-branch ${isCur ? "current" : ""}`}
                            role="button"
                            tabIndex={0}
                            title={isCur ? "当前分支" : `切换到 ${b.name}`}
                            onClick={() => { if (!isCur) askSwitch(b.name); }}
                            onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && !isCur) { e.preventDefault(); askSwitch(b.name); } }}
                          >
                            <span className="gita-branch-mark"><Icon name={isCur ? "check" : "branch"} size={13} /></span>
                            <span className="gita-branch-name" title={b.name}>{b.name}</span>
                            <span className="gita-branch-track">{trackText(b.behind, b.ahead)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <div
                    className="gita-tree-h"
                    role="button"
                    tabIndex={0}
                    aria-expanded={openGroups.has("remote")}
                    onClick={() => toggleGroup("remote")}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup("remote"); } }}
                  >
                    <span className="gita-tree-caret"><Icon name={openGroups.has("remote") ? "chevronDown" : "chevronRight"} size={12} /></span>
                    <span>远程</span><span className="n">{remoteTotal}</span>
                  </div>
                  {openGroups.has("remote") && (
                    <div className="gita-tree-kids">
                      {remoteGroups.map(([remote, list]) => (
                        <div key={remote}>
                          <div
                            className="gita-tree-h nest"
                            role="button"
                            tabIndex={0}
                            aria-expanded={openGroups.has(`remote:${remote}`)}
                            onClick={() => toggleGroup(`remote:${remote}`)}
                            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(`remote:${remote}`); } }}
                          >
                            <span className="gita-tree-caret"><Icon name={openGroups.has(`remote:${remote}`) ? "chevronDown" : "chevronRight"} size={12} /></span>
                            <span>{remote}</span><span className="n">{list.length}</span>
                          </div>
                          {openGroups.has(`remote:${remote}`) && (
                            <div className="gita-tree-kids">
                              {list.map(b => (
                                <div
                                  key={b.name}
                                  className="gita-branch"
                                  role="button"
                                  tabIndex={0}
                                  title={`检出远程分支 ${b.name}（git 自动创建同名本地分支）`}
                                  onClick={() => askSwitch(b.name)}
                                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); askSwitch(b.name); } }}
                                >
                                  <span className="gita-branch-mark"><Icon name="branch" size={13} /></span>
                                  <span className="gita-branch-name">{b.name.slice(remote.length + 1)}</span>
                                  <span className="gita-branch-track">{trackText(b.behind, b.ahead)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        {/* 第三张：提交历史 */}
        <section className="gita-card history" aria-label="提交历史">
          <div className="gita-history-head">
            <h2 className="gita-title">提交历史</h2>
            <div className="gita-filters">
              <input
                className="gita-filter-input"
                value={authorDraft}
                placeholder="提交人"
                aria-label="提交人"
                onChange={e => setAuthorDraft(e.target.value)}
                onBlur={() => setAuthor(authorDraft.trim())}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); setAuthor(authorDraft.trim()); } }}
              />
              <select
                className="gita-filter-select"
                value={branchFilter}
                aria-label="所有分支"
                onChange={e => setBranchFilter(e.target.value)}
              >
                <option value="">所有分支</option>
                {branches.filter(b => b.kind === "local").map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
              <select
                className="gita-filter-select"
                value={range}
                aria-label="时间范围"
                onChange={e => setRange(e.target.value as HistoryRange)}
              >
                <option value="all">全部</option>
                <option value="day">最近 24 小时</option>
                <option value="week">最近 7 天</option>
              </select>
            </div>
          </div>
          <div className="gita-body scroll" onScroll={onHistoryScroll} style={{ ["--graph-w" as string]: `${band}px` }}>
            {logLoading && commits.length === 0 ? (
              <p className="gita-note">加载提交历史…</p>
            ) : commits.length === 0 ? (
              <p className="gita-empty">{state === "no-repo" ? "该目录尚未初始化 Git 仓库" : "没有符合条件的提交"}</p>
            ) : (
              <>
                {commits.map((c, i) => {
                  const open = expanded === c.hash;
                  return (
                    <div key={c.hash} className="gita-commit-row" role="button" tabIndex={0}
                      title="点击展开 / 收起变更文件"
                      onClick={() => toggleCommitFiles(c.hash)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCommitFiles(c.hash); } }}
                    >
                      <span className="gita-graph"><CommitGraph row={graph[i]} width={band} merge={c.parents.length > 1} /></span>
                      <div className="gita-commit-main">
                        <div className="gita-commit-subject">
                          <span className="txt">{c.subject}</span>
                          <span className="gita-refs">{refBadges(c.refs)}</span>
                        </div>
                        <div className="gita-commit-meta"><span className="author">{c.authorName}</span></div>
                      </div>
                      <div className="gita-commit-side"><span className="gita-commit-date">{stamp(c.date)}</span></div>
                      {open && <div className="gita-files">{renderCommitFiles(c.hash)}</div>}
                    </div>
                  );
                })}
                {loadingMore && <p className="gita-more">加载更多…</p>}
                {!hasMore && commits.length > 0 && <p className="gita-more">已加载全部提交</p>}
                {hasMore && !loadingMore && (
                  <div className="gita-more">
                    <button className="gita-act" onClick={() => void loadMore()}>加载更多</button>
                  </div>
                )}
                {logLoading && <p className="gita-more">刷新中…</p>}
              </>
            )}
          </div>
        </section>
      </div>

      {confirm && (
        <Confirm
          title={confirm.title}
          message={confirm.message}
          danger={confirm.danger}
          onOk={() => { const act = confirm.onOk; setConfirm(null); act(); }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {remoteForm && (
        <Modal
          title="管理远程"
          onClose={() => setRemoteForm(null)}
          width={520}
          footer={
            <>
              <button className="btn" onClick={() => setRemoteForm(null)}>关闭</button>
              <button className="btn primary" onClick={saveRemote} disabled={!remoteForm.name.trim() || !remoteForm.url.trim()}>保存</button>
            </>
          }
        >
          <div className="gita-field">
            <label htmlFor="gita-remote-name">远程名称</label>
            <input id="gita-remote-name" value={remoteForm.name} placeholder="origin" onChange={e => setRemoteForm(f => f && ({ ...f, name: e.target.value }))} />
          </div>
          <div className="gita-field">
            <label htmlFor="gita-remote-url">仓库地址</label>
            <input id="gita-remote-url" value={remoteForm.url} placeholder="https://github.com/owner/repo.git" onChange={e => setRemoteForm(f => f && ({ ...f, url: e.target.value }))} />
          </div>
          {remotes.length > 0 && (
            <div className="gita-remote-list">
              {remotes.map(r => (
                <div key={r.name} className="gita-cred-row">
                  <Icon name="globe" size={13} />
                  <span className="gita-cred-host">{r.name}</span>
                  <span className="gita-hint" title={r.url}>{r.url}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
