import { Icon } from "@/components/icons";
import type { SessionMeta } from "@/api";
import { ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { HistoryContent, HistoryHeader, type HistoryBodyProps } from "./HistoryBody";

// 保留既有公开导出，供 ChatPanel 和其他布局继续使用。
export { historyMarkOf as markOf } from "./HistoryBody";
export type { HistoryLoading } from "./HistoryBody";
export function HistoryIcon({ size = 16 }: { size?: number }) { return <Icon name="history" size={size} aria-hidden />; }

export interface SessionHistoryProps extends HistoryBodyProps {
  scopeId?: string;
  current: SessionMeta | null;
  onClose: () => void;
}

/** WP-074-F011：浮层只承担定位/拖宽/关闭；历史行为完全复用公共实现。 */
export function SessionHistory(props: SessionHistoryProps) {
  const history = usePaneWidth(props.scopeId ?? "chat", "history", { default: 296, min: 240, max: 420, side: "left", overlay: true, minCenter: 0, maxAvailable: () => Math.max(0, window.innerWidth - 16) });
  const count = props.loading === "first" ? "…" : `${props.items.length} / ${props.total}`;
  return <div className="chat-history resizable-pane" style={{ width: history.width, minWidth: 0, maxWidth: "calc(100vw - 16px)" }} data-chat-overlay="history" role="dialog" aria-label="会话历史">
    <ResizeHandle pane={history} label="会话历史" />
    <HistoryHeader count={count} action={<button className="chat-iconbtn" title="关闭" aria-label="关闭会话历史" onClick={props.onClose}><Icon name="x" size={14} /></button>} />
    <HistoryContent {...props} pinned={props.current} searchId="chat-history-q" />
  </div>;
}
