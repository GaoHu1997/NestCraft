import { Icon } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "@/api";
import { Confirm } from "@/components/ui";
import { ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { formatDur, getRuntime } from "./sessionRuntime";

/**
 * 会话历史浮层（CR-042 定位；CR-063 分批/搜索；CR-065 状态标识与行操作）：
 * - 覆盖式浮层：position:absolute; top:0; bottom:0; right:100%，宽 296px，不占布局；
 * - 状态只看左侧 10px 标识：运行 spinner / 成功绿点 / 失败红点 / 待处理橘点 / 已读留空；
 * - 选中只用背景色、无边框、不写「当前」；底部无栏；
 * - 搜索旁「重置」；行 hover「…」菜单：复制 ID / 分叉 / 置顶 / 重命名（原位）/ 删除。
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

/** CR-065：状态标识。运行中优先；当前会话视为已读。 */
export function markOf(s: SessionMeta, runningIds: string[], currentId: string | null): "running" | "unread-success" | "unread-failed" | "unread-pending" | "none" {
  if (runningIds.includes(s.id)) return "running";
  if (s.id === currentId) return "none";
  const unread = (s.unread ?? "").toLowerCase();
  if (!unread || unread === "none") return "none";
  if (["success", "green", "done"].includes(unread)) return "unread-success";
  if (["failed", "failure", "error", "red"].includes(unread)) return "unread-failed";
  return "unread-pending";
}

export function HistoryIcon({ size = 16 }: { size?: number }) {
  return <Icon name="history" size={size} aria-hidden />;
}

export type HistoryLoading = "idle" | "first" | "more" | "search";

export function SessionHistory(props: {
  scopeId?: string;
  items: SessionMeta[];
  current: SessionMeta | null;
  currentId: string | null;
  total: number;
  hasMore: boolean;
  loading: HistoryLoading;
  error: string | null;
  keyword: string;
  runningIds: string[];
  onLoadMore: () => void;
  onSearch: (q: string) => void;
  onShowAll: () => void;
  onRetry: () => void;
  onSwitch: (s: SessionMeta) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onCopyId: (s: SessionMeta) => void;
  onFork: (s: SessionMeta) => void;
  onPin: (s: SessionMeta) => void;
  onRename: (s: SessionMeta, title: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const keepScroll = useRef<number | null>(null);
  const editingRef = useRef<string | null>(null);
  const history = usePaneWidth(props.scopeId ?? "chat", "history", { default: 296, min: 240, max: 420, side: "left", overlay: true, minCenter: 0, maxAvailable: () => Math.max(0, window.innerWidth - 16) });

  editingRef.current = editingId;

  // 追加加载后恢复滚动位置
  useEffect(() => {
    if (keepScroll.current !== null && listRef.current) {
      listRef.current.scrollTop = keepScroll.current;
      keepScroll.current = null;
    }
  }, [props.items.length]);

  // 「…」菜单外点关闭
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".chat-hist-menu-wrap")) setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  const pinned = !props.keyword && props.current && !props.items.some(s => s.id === props.current!.id) ? props.current : null;
  const target = props.items.find(s => s.id === confirmId) ?? (props.current?.id === confirmId ? props.current : undefined);

  const startRename = (s: SessionMeta) => {
    setMenuFor(null);
    setEditingId(s.id);
    setEditingValue(s.title);
    window.setTimeout(() => {
      const input = document.getElementById("chat-hist-rename") as HTMLInputElement | null;
      if (input) { input.focus(); input.select(); }
    }, 0);
  };
  const commitRename = (s: SessionMeta) => {
    if (editingRef.current !== s.id) return;
    editingRef.current = null;
    setEditingId(null);
    props.onRename(s, editingValue.trim());
  };
  const cancelRename = () => { editingRef.current = null; setEditingId(null); };

  const mark = (s: SessionMeta) => {
    const kind = markOf(s, props.runningIds, props.currentId);
    if (kind === "running") return <span className="chat-hist-spin" role="status" aria-label="运行中" title="运行中" />;
    if (kind === "none") return <span className="chat-hist-mark" aria-hidden />;
    const tone = kind === "unread-success" ? "good" : kind === "unread-failed" ? "bad" : "warn";
    const label = kind === "unread-success" ? "未读 · 成功" : kind === "unread-failed" ? "未读 · 失败" : "待处理";
    return <span className={`chat-hist-dot dot-${tone}`} role="img" aria-label={label} title={label} />;
  };

  const row = (s: SessionMeta, pinnedRow = false) => {
    const st = getRuntime(s.id);
    const tokens = st.tokensIn + st.tokensOut;
    const dur = st.modelMs + st.toolMs;
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
        {mark(s)}
        <div className="chat-hist-main">
          {editing ? (
            <input
              id="chat-hist-rename"
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

  const count = props.loading === "first" ? "…" : `${props.items.length} / ${props.total}`;
  const searching = Boolean(props.keyword);
  const empty = searching ? (
    <div className="chat-hist-empty">没有匹配的会话<button className="chat-hist-link" onClick={props.onShowAll}>清除搜索</button></div>
  ) : (
    <div className="chat-hist-empty">暂无历史会话</div>
  );

  return (
    <div className="chat-history resizable-pane" style={{ width: history.width, minWidth: 0, maxWidth: "calc(100vw - 16px)" }} data-chat-overlay="history" ref={boxRef} role="dialog" aria-label="会话历史">
      <ResizeHandle pane={history} label="会话历史" />
      <div className="chat-history-head">
        <span className="chat-history-title">
          <HistoryIcon size={14} />
          <b>会话历史</b>
          <span className="chat-history-count" title="已加载 / 全部">{count}</span>
        </span>
        <button className="chat-iconbtn" title="关闭" aria-label="关闭会话历史" onClick={props.onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="chat-history-search">
        <span className="chat-hist-search-ico"><Icon name="search" size={14} /></span>
        <input
          id="chat-history-q"
          type="search"
          autoComplete="off"
          value={props.keyword}
          placeholder="搜索本项目会话标题"
          aria-label="搜索本项目会话标题"
          onChange={e => props.onSearch(e.currentTarget.value)}
        />
        <button className="chat-hist-all" onClick={props.onShowAll} disabled={!searching} title={searching ? "清空搜索并重新查询" : "当前没有搜索词"} aria-label="清空搜索并重新查询">重置</button>
      </div>
      <div className="chat-history-list" ref={listRef}>
        {props.loading === "first" && <div className="chat-hist-loading" role="status" aria-live="polite">加载中…</div>}
        {props.error && props.loading !== "first" && (
          <div className="chat-hist-error" role="alert">
            <span title={props.error}>加载失败，已加载内容保留</span>
            <button className="chat-hist-link" onClick={props.onRetry}>重试</button>
          </div>
        )}
        {props.loading === "search" && <div className="chat-hist-loading" role="status" aria-live="polite">搜索中…</div>}
        {pinned && row(pinned, true)}
        {props.items.map(s => row(s))}
        {props.items.length > 0 && props.hasMore && props.loading !== "first" && (
          props.loading === "more"
            ? <div className="chat-hist-more loading" role="status" aria-live="polite">加载中…</div>
            : <button className="chat-hist-more" onClick={() => { keepScroll.current = listRef.current?.scrollTop ?? 0; props.onLoadMore(); }}>继续加载 · 还剩 {Math.max(0, props.total - props.items.length)} 条</button>
        )}
        {props.items.length > 0 && !props.hasMore && props.loading !== "first" && <div className="chat-hist-end">已到全部</div>}
        {props.items.length === 0 && !pinned && !props.error && props.loading !== "first" && props.loading !== "search" && empty}
      </div>
      {target && (
        <Confirm
          title="删除会话"
          message={`确定删除「${target.title || "未命名会话"}」？删除后不可恢复。`}
          danger
          onOk={() => {
            props.onDelete(target.id);
            setConfirmId(null);
          }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}