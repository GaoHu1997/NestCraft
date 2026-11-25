import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SessionMeta } from "@/api";
import { Icon } from "@/components/icons";
import { Confirm, useToast } from "@/components/ui";
import { formatDur, getRuntime } from "./sessionRuntime";
import { useHistorySearch } from "./useHistorySearch";
import "./history-shared.css";

export type HistoryLoading = "idle" | "first" | "more" | "search";
export type HistoryMark = "running" | "unread-success" | "unread-failed" | "unread-pending" | "none";

/** 原有两个组件的 props 数据/回调契约；不查询后端，不更改分页、计量或会话状态。 */
export interface HistoryBodyProps {
  items: SessionMeta[];
  currentId: string | null;
  runningIds: string[];
  total: number;
  hasMore: boolean;
  loading: HistoryLoading;
  error: string | null;
  keyword: string;
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

export function historyMarkOf(s: SessionMeta, runningIds: string[], currentId: string | null): HistoryMark {
  if (runningIds.includes(s.id)) return "running";
  if (s.id === currentId) return "none";
  const unread = (s.unread ?? "").toLowerCase();
  if (!unread || unread === "none") return "none";
  if (["success", "green", "done"].includes(unread)) return "unread-success";
  if (["failed", "failure", "error", "red"].includes(unread)) return "unread-failed";
  return "unread-pending";
}

export function HistoryStatusMark({ kind }: { kind: HistoryMark }) {
  if (kind === "running") return <span className="chat-hist-spin" role="status" aria-label="运行中" title="运行中" />;
  if (kind === "none") return <span className="chat-hist-mark" aria-hidden="true" />;
  const tone = kind === "unread-success" ? "good" : kind === "unread-failed" ? "bad" : "warn";
  const label = kind === "unread-success" ? "未读 · 成功" : kind === "unread-failed" ? "未读 · 失败" : "待处理";
  return <span className={`chat-hist-dot dot-${tone}`} role="img" aria-label={label} title={label} />;
}

export function HistoryHeader({ count, action }: { count: string; action: ReactNode }) {
  return <div className="chat-history-head">
    <span className="chat-history-title"><Icon name="history" size={14} /><b>会话历史</b><span className="chat-history-count" title="已加载 / 全部">{count}</span></span>
    {action}
  </div>;
}

function HistorySearchFields({ query, id }: { query: ReturnType<typeof useHistorySearch>; id: string }) {
  return <div className="chat-history-search">
    <span className="chat-hist-search-ico"><Icon name="search" size={14} /></span>
    <input id={id} type="search" autoComplete="off" value={query.raw}
      placeholder="搜索本项目会话标题" aria-label="搜索本项目会话标题"
      onFocus={query.onFocus} onBlur={query.onBlur}
      onChange={e => query.onChange(e.currentTarget.value, (e.nativeEvent as InputEvent).isComposing)}
      onCompositionStart={query.onCompositionStart}
      onCompositionEnd={e => query.onCompositionEnd(e.currentTarget.value)} />
    <button className="chat-hist-all" onClick={query.reset} disabled={!query.canReset}
      title={query.canReset ? "清空搜索并重新查询" : "当前没有搜索词"} aria-label="清空搜索并重新查询">重置</button>
  </div>;
}

export function HistoryContent(props: HistoryBodyProps & { searchId: string }) {
  const query = useHistorySearch(props.keyword, props.onSearch, props.onShowAll);
  return <><HistorySearchFields query={query} id={props.searchId} /><HistoryBody {...props} onShowAll={query.reset} /></>;
}

function fmtTime(ts: number): string {
  const d = new Date(ts), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const MENU_OPEN_EVENT = "nestcraft-history-menu-open";

/** WP-074-F011 / UI-CR074-v1：两种外壳真正共享同一 body、状态、菜单和原位编辑。 */
export function HistoryBody(props: HistoryBodyProps) {
  const instance = useId();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuOwner = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState<SessionMeta | null>(null);
  const editingRef = useRef<SessionMeta | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const valueRef = useRef("");
  const renameInput = useRef<HTMLInputElement | null>(null);
  const renameComposing = useRef(false);
  const blurAfterComposition = useRef(false);
  const [confirmTarget, setConfirmTarget] = useState<SessionMeta | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const keepScroll = useRef<number | null>(null);
  const scrollPosition = useRef({ top: 0, left: 0 });
  const toast = useToast();

  useEffect(() => {
    const otherOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== instance) setMenuFor(null);
    };
    document.addEventListener(MENU_OPEN_EVENT, otherOpened);
    return () => document.removeEventListener(MENU_OPEN_EVENT, otherOpened);
  }, [instance]);
  useEffect(() => {
    if (!menuFor) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuOwner.current?.contains(event.target)) setMenuFor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      setMenuFor(null);
      // Escape仅收本层菜单，不顺带关历史浮层；外点路径从不拦事件或恢复焦点。
      // 同一document target仍可继续执行其他监听器；不能只依赖defaultPrevented（合成事件可不可取消）。
      event.preventDefault(); event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [menuFor]);
  useEffect(() => {
    if (menuFor && !props.items.some(s => s.id === menuFor) && props.pinned?.id !== menuFor) setMenuFor(null);
  }, [props.items, props.pinned, menuFor]);
  useEffect(() => {
    if (!editing || !renameInput.current) return;
    renameInput.current.focus({ preventScroll: true }); renameInput.current.select();
  }, [editing?.id]);
  useEffect(() => {
    if (keepScroll.current !== null && listRef.current) {
      listRef.current.scrollTop = keepScroll.current; keepScroll.current = null;
    }
  }, [props.items.length]);

  const cancelRename = () => {
    editingRef.current = null; renameComposing.current = false; blurAfterComposition.current = false; setEditing(null);
  };
  const commitRename = () => {
    const target = editingRef.current;
    if (!target || renameComposing.current) return;
    editingRef.current = null; setEditing(null); blurAfterComposition.current = false;
    const title = valueRef.current.trim();
    if (!title) { toast("标题不能为空", "warn"); return; }
    if (title !== target.title) props.onRename(target, title);
  };
  const startRename = (s: SessionMeta) => {
    setMenuFor(null); editingRef.current = s; valueRef.current = s.title ?? "";
    renameComposing.current = false; blurAfterComposition.current = false;
    setEditingValue(valueRef.current); setEditing(s);
  };
  const pinned = !props.keyword.trim() && props.pinned && !props.items.some(s => s.id === props.pinned!.id) ? props.pinned : null;

  const row = (s: SessionMeta, pinnedRow = false) => {
    const rt = getRuntime(s.id), tokens = rt.tokensIn + rt.tokensOut, dur = rt.modelMs + rt.toolMs;
    const meta = [fmtTime(s.updatedAt), tokens > 0 ? `${tokens >= 10000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok` : "—", dur > 0 ? formatDur(dur) : "—"].join(" · ");
    const isEditing = editing?.id === s.id, running = props.runningIds.includes(s.id);
    return <div key={s.id} data-history-session={s.id}
      className={`chat-hist-item ${s.id === props.currentId ? "active" : ""}${pinnedRow ? " pinned-row" : ""}${isEditing ? " editing" : ""}`}
      onClick={() => { if (!isEditing) props.onSwitch(s); }} role="button" tabIndex={0}
      onKeyDown={e => { if (e.target === e.currentTarget && !isEditing && !e.nativeEvent.isComposing && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); props.onSwitch(s); } }}
      aria-current={s.id === props.currentId ? "true" : undefined}>
      <HistoryStatusMark kind={historyMarkOf(s, props.runningIds, props.currentId)} />
      <div className="chat-hist-main">
        {isEditing ? <input ref={renameInput} id={`chat-hist-rename-${instance}`} className="chat-hist-rename"
          value={editingValue} maxLength={200} aria-label="重命名会话标题"
          onClick={e => e.stopPropagation()}
          onChange={e => { valueRef.current = e.currentTarget.value; setEditingValue(valueRef.current); }}
          onCompositionStart={() => { renameComposing.current = true; }}
          onCompositionEnd={e => {
            renameComposing.current = false; valueRef.current = e.currentTarget.value; setEditingValue(valueRef.current);
            if (blurAfterComposition.current) queueMicrotask(() => { if (document.activeElement !== renameInput.current) commitRename(); });
          }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing || renameComposing.current || e.keyCode === 229) return;
            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
          }}
          onBlur={() => { if (renameComposing.current) blurAfterComposition.current = true; else commitRename(); }} />
          : <div className="chat-hist-title ellipsis">{(s.pinnedAt ?? 0) > 0 && <Icon name="arrowUp" size={12} className="chat-hist-pin" />}{s.title || "未命名会话"}</div>}
        <div className="chat-hist-meta">{meta}</div>
        {s.sessionRole === "executor" && s.featureId && <div className="chat-hist-scope" title={`执行特性：${s.featureTitle ?? s.featureId}`}>单特性 · {s.featureId}</div>}
      </div>
      <div className="chat-hist-menu-wrap" ref={menuFor === s.id ? menuOwner : undefined}>
        <button className="chat-hist-more-btn" title="更多操作" aria-label={`更多操作：${s.title || "未命名会话"}`}
          aria-haspopup="menu" aria-expanded={menuFor === s.id} onClick={e => {
            e.stopPropagation();
            if (menuFor === s.id) setMenuFor(null);
            else { menuOwner.current = e.currentTarget.parentElement as HTMLDivElement; document.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: instance })); setMenuFor(s.id); }
          }}><Icon name="more" size={14} /></button>
        {menuFor === s.id && <div className="chat-hist-menu" role="menu" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenuFor(null); props.onCopyId(s); }}><Icon name="copy" size={13} />复制会话 ID</button>
          <button role="menuitem" disabled={running} title={running ? "会话运行中，结束或停止后再分叉" : undefined} onClick={() => { if (!running) { setMenuFor(null); props.onFork(s); } }}><Icon name="branch" size={13} />分叉会话</button>
          <button role="menuitem" onClick={() => { setMenuFor(null); props.onPin(s); }}><Icon name="arrowUp" size={13} />{(s.pinnedAt ?? 0) > 0 ? "取消置顶" : "置顶"}</button>
          <button role="menuitem" onClick={() => startRename(s)}><Icon name="pen" size={13} />重命名</button>
          <button role="menuitem" className="danger" onClick={() => { setMenuFor(null); setConfirmTarget(s); }}><Icon name="trash" size={13} />删除</button>
        </div>}
      </div>
    </div>;
  };

  return <>
    <div className="chat-history-list history-shared-list" ref={listRef} onScroll={e => {
      if (e.target !== e.currentTarget) return;
      const { scrollTop: top, scrollLeft: left } = e.currentTarget;
      if (top !== scrollPosition.current.top || left !== scrollPosition.current.left) setMenuFor(null);
      scrollPosition.current = { top, left };
    }}>
      {props.loading === "first" && <div className="chat-hist-loading" role="status" aria-live="polite">加载中…</div>}
      {props.error && props.loading !== "first" && <div className="chat-hist-error" role="alert"><span title={props.error}>加载失败，已加载内容保留</span><button className="chat-hist-link" onClick={props.onRetry}>重试</button></div>}
      {props.loading === "search" && <div className="chat-hist-loading" role="status" aria-live="polite">搜索中…</div>}
      {pinned && row(pinned, true)}{props.items.map(s => row(s))}
      {props.items.length > 0 && props.hasMore && props.loading !== "first" && (props.loading === "more"
        ? <div className="chat-hist-more loading" role="status" aria-live="polite">加载中…</div>
        : <button className="chat-hist-more" onClick={() => { keepScroll.current = listRef.current?.scrollTop ?? 0; props.onLoadMore(); }}>继续加载 · 还剩 {Math.max(0, props.total - props.items.length)} 条</button>)}
      {props.items.length > 0 && !props.hasMore && props.loading !== "first" && <div className="chat-hist-end">已到全部</div>}
      {props.items.length === 0 && !pinned && !props.error && props.loading !== "first" && props.loading !== "search" && <div className="chat-hist-empty">{props.keyword.trim() ? <>没有匹配的会话<button className="chat-hist-link" onClick={props.onShowAll}>清除搜索</button></> : "暂无历史会话"}</div>}
    </div>
    {confirmTarget && <Confirm title="删除会话" message={`确定删除「${confirmTarget.title || "未命名会话"}」？删除后不可恢复。`} danger
      onOk={() => { props.onDelete(confirmTarget.id); setConfirmTarget(null); }} onCancel={() => setConfirmTarget(null)} />}
  </>;
}
