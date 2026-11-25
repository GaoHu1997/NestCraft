import { Icon } from "@/components/icons";
import { HistoryBody, HistoryContent, HistoryHeader, type HistoryBodyProps } from "./HistoryBody";

export { HistoryStatusMark as SessionListMark, historyMarkOf as sessionKind } from "./HistoryBody";
/** 旧 props 接口保持兼容；控制器仍拥有分页与会话数据。 */
export interface SessionListProps extends HistoryBodyProps {}
export function SessionListBody(props: SessionListProps) { return <HistoryBody {...props} />; }

/** WP-074-F011：常驻布局仅提供外壳，与浮层共用真实搜索、状态及操作组件。 */
export function SessionHistoryList(props: SessionListProps & { onNew: () => void }) {
  const count = props.loading === "first" ? "…" : `${props.items.length} / ${props.total}`;
  return <div className="chat-history wb-history" role="region" aria-label="会话历史">
    <HistoryHeader count={count} action={<button className="chat-iconbtn" title="新会话" aria-label="新会话" onClick={props.onNew}><Icon name="plus" size={14} /></button>} />
    <HistoryContent {...props} searchId="wb-history-q" />
  </div>;
}
