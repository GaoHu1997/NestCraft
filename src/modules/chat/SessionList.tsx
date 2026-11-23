import { Icon } from "@/components/icons";
import { useState } from "react";
import type { SessionMeta } from "@/api";
import { Confirm } from "@/components/ui";
import { formatDur, getRuntime } from "./sessionRuntime";
import type { HistoryLoading } from "./SessionHistory";

/**
 * CR-054：会话列表（历史浮层与工作台左栏共用）。
 *
 * 与 CR-063/065 的约定保持一致：
 * - 状态只看左侧 10px 标识：运行 spinner / 成功绿点 / 失败红点 / 待处理橘点 / 已读留空；
 * - 选中只用背景色、无边框、不写「当前」；
 * - 搜索旁「重置」；行 hover「…」菜单：复制 ID / 分叉 / 置顶 / 重命名（原位）/ 删除。
 *
 * 本组件不持有会话数据，只渲染与派发操作，确保两处入口看到的是同一份数据。
 */

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function SessionListMark({ kind }: { kind: "running" | "unread-success" | "unread-failed" | "unread-pending" | "none" }) {
  if (kind === "running") return <span className="chat-hist-spin" role="status" aria-label="运行中" title="运行中" />;
  if (kind === "none") return <span className="chat-hist-mark" aria-hidden="true" />;
  const cls = kind === "unread-success" ? "good" : kind === "unread-failed" ? "bad" : "warn";
  const label = kind === "unread-success" ? "未读 · 成功" : kind === "unread-failed" ? "未读 · 失败" : "待处理";
  return <span className={`chat-hist-dot dot-${cls}`} role="img" aria-label={label} title={label} />;
}

export function sessionKind(s: SessionMeta, runningIds: string[], currentId: string | null): "running" | "unread-success" | "unread-failed" | "unread-pending" | "none" {
  if (runningIds.includes(s.id)) return "running";
  if (s.id === currentId) return "none";
  const unread = (s.unread ?? "").toLowerCase();
  if (!unread || unread === "none") return "none";
  if (["success", "green", "done"].includes(unread)) return "unread-success";
  if (["failed", "failure", "error", "red"].includes(unread)) return "unread-failed";
  return "unread-pending";
}

export interface SessionListProps {
  items: SessionMeta[];
  currentId: string | null;
  runningIds: string[];
  total: number;
  hasMore: boolean;
  loading: HistoryLoading;
  error: string | null;
  keyword: string;
  /** 当前会话不在已加载分页内时，钉在顶部。 */
  pinned?: SessionMeta | null;
  onSwitch: (s: SessionMeta) => void;
  onLoadMore: () => void;
  onSearch: (q: string) => void;
  onShowAll: () => void;
  onRetry: () => void;
  onDelete: (id: string) => void;
  onCopyId: (s: SessionMeta) => void;
  onFork: (s: SessionMeta) => void;
  onPin: (s: SessionMeta) => void;
  onRename: (s: SessionMeta, title: string) => void;
}

export function SessionListBody(props: SessionListProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const commitRename = (s: SessionMeta) => {
    const value = editingValue.trim();
    setEditingId(null);
    if (value && value !== s.title) props.onRename(s, value);
  };
  const cancelRename = () => setEditingId(null);
  const startRename = (s: SessionMeta) => { setEditingId(s.id); setEditingValue(s.title ?? ""); };

  const row = (s: SessionMeta, pinnedRow = false) => {
    const rt = getRuntime(s.id);
    const tokens = rt.tokensIn + rt.tokensOut;
    const dur = rt.modelMs + rt.toolMs;
    const meta = [
      fmtTime(s.updatedAt),
      tokens > 0 ? `${tokens >= 10000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok` : "—",
      dur > 0 ? formatDur(dur) : "—",
    ].join(" · ");
    const editing = editingId === s.id;
    const running = props.runningIds.includes(s.id);
    return (
      <div
        key={s.id}
        className={`chat-hist-item ${s.id === props.currentId ? "active" : ""}${pinnedRow ? " pinned-row" : ""}${editing ? " editing" : ""}`}
        onClick={() => { if (!editing) props.onSwitch(s); }}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (!editing && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); props.onSwitch(s); } }}
        aria-current={s.id === props.currentId ? "true" : undefined}
      >
        <SessionListMark kind={sessionKind(s, props.runningIds, props.currentId)} />
        <div className="chat-hist-main">
          {editing ? (
            <input
              className="chat-hist-rename"
              value={editingValue}
              maxLength={200}
              aria-label="重命名会话标题"
              onClick={e => e.stopPropagation()}
              onChange={e => setEditingValue(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") { e.preventDefault(); commitRename(s); }
                else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
              }}
              onBlur={() => commitRename(s)}
            />
          ) : (
            <div className="chat-hist-title ellipsis">
              {(s.pinnedAt ?? 0) > 0 && <Icon name="arrowUp" size={12} className="chat-hist-pin" />}
              {s.title || "未命名会话"}
            </div>
          )}
          <div className="chat-hist-meta">{meta}</div>
          {s.sessionRole === "executor" && s.featureId && <div className="chat-hist-scope" title={`执行特性：${s.featureTitle ?? s.featureId}`}>单特性 · {s.featureId}</div>}
        </div>
        <div className="chat-hist-menu-wrap">
          <button
            className="chat-hist-more-btn"
            title="更多操作"
            aria-label={`更多操作：${s.title || "未命名会话"}`}
            aria-haspopup="menu"
            aria-expanded={menuFor === s.id}
            onClick={e => { e.stopPropagation(); setMenuFor(prev => (prev === s.id ? null : s.id)); }}
          >
            <Icon name="more" size={14} />
          </button>
          {menuFor === s.id && (
            <div className="chat-hist-menu" role="menu" onClick={e => e.stopPropagation()}>
              <button role="menuitem" onClick={() => { setMenuFor(null); props.onCopyId(s); }}><Icon name="copy" size={13} />复制会话 ID</button>
              <button role="menuitem" disabled={running} title={running ? "会话运行中，结束或停止后再分叉" : undefined} onClick={() => { if (!running) { setMenuFor(null); props.onFork(s); } }}><Icon name="branch" size={13} />分叉会话</button>
              <button role="menuitem" onClick={() => { setMenuFor(null); props.onPin(s); }}><Icon name="arrowUp" size={13} />{(s.pinnedAt ?? 0) > 0 ? "取消置顶" : "置顶"}</button>
              <button role="menuitem" onClick={() => startRename(s)}><Icon name="pen" size={13} />重命名</button>
              <button role="menuitem" className="danger" onClick={() => { setMenuFor(null); setConfirmId(s.id); }}><Icon name="trash" size={13} />删除</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const searching = Boolean(props.keyword);
  const empty = searching
    ? <div className="chat-hist-empty">没有匹配的会话<button className="chat-hist-link" onClick={props.onShowAll}>清除搜索</button></div>
    : <div className="chat-hist-empty">暂无历史会话</div>;

  return (
    <div className="chat-history-list wb-hist-list">
      {props.loading === "first" && <div className="chat-hist-loading" role="status" aria-live="polite">加载中…</div>}
      {props.error && props.loading !== "first" && (
        <div className="chat-hist-error" role="alert">
          <span title={props.error}>加载失败，已加载内容保留</span>
          <button className="chat-hist-link" onClick={props.onRetry}>重试</button>
        </div>
      )}
      {props.loading === "search" && <div className="chat-hist-loading" role="status" aria-live="polite">搜索中…</div>}
      {props.pinned && row(props.pinned, true)}
      {props.items.map(s => row(s))}
      {props.items.length > 0 && props.hasMore && props.loading !== "first" && (
        props.loading === "more"
          ? <div className="chat-hist-more loading" role="status" aria-live="polite">加载中…</div>
          : <button className="chat-hist-more" onClick={props.onLoadMore}>继续加载 · 还剩 {Math.max(0, props.total - props.items.length)} 条</button>
      )}
      {props.items.length > 0 && !props.hasMore && props.loading !== "first" && <div className="chat-hist-end">已到全部</div>}
      {props.items.length === 0 && !props.pinned && !props.error && props.loading !== "first" && props.loading !== "search" && empty}
      {confirmId && (
        <Confirm
          title="删除会话"
          message={`确定删除「${props.items.find(s => s.id === confirmId)?.title || "未命名会话"}」？删除后不可恢复。`}
          danger
          onOk={() => { props.onDelete(confirmId); setConfirmId(null); }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

/** 工作台左栏：标题 + 搜索 + 列表（不含浮层定位与拖宽，拖宽由 Workbench 负责）。 */
export function SessionHistoryList(props: SessionListProps & { onNew: () => void }) {
  const searching = Boolean(props.keyword);
  const count = props.loading === "first" ? "…" : `${props.items.length} / ${props.total}`;
  return (
    <div className="chat-history wb-history" role="region" aria-label="会话历史">
      <div className="chat-history-head">
        <span className="chat-history-title">
          <Icon name="history" size={14} />
          <b>会话历史</b>
          <span className="chat-history-count" title="已加载 / 全部">{count}</span>
        </span>
        <button className="chat-iconbtn" title="新会话" aria-label="新会话" onClick={props.onNew}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="chat-history-search">
        <span className="chat-hist-search-ico"><Icon name="search" size={14} /></span>
        <input
          id="wb-history-q"
          type="search"
          autoComplete="off"
          value={props.keyword}
          placeholder="搜索本项目会话标题"
          aria-label="搜索本项目会话标题"
          onChange={e => props.onSearch(e.currentTarget.value)}
        />
        <button className="chat-hist-all" onClick={props.onShowAll} disabled={!searching} title={searching ? "清空搜索并重新查询" : "当前没有搜索词"} aria-label="清空搜索并重新查询">重置</button>
      </div>
      <SessionListBody {...props} />
    </div>
  );
}
