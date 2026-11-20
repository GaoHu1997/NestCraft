import { Icon } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "@/api";
import { Confirm } from "@/components/ui";
import { formatDur, getRuntime } from "./sessionRuntime";
import type { SessionStatus } from "./sessionRuntime";

/**
 * 会话历史浮层（CR-042 C42-03/04，§3.1 设计原机制，评审 A/B 多数决）：
 * - 覆盖式浮层：position:absolute; top:0; bottom:0; right:100%，
 *   右缘贴侧栏左缘、与侧栏同高、宽 296px，不占布局、覆盖主内容；
 * - 前提约束：.chat-panel 不得加 overflow:hidden / transform（会裁剪本浮层），
 *   该约束已写入 chat.css 注释与 LLD；
 * - 行：状态点 + 标题 + 元信息（更新时间 · tokens · 时长）+ 右侧状态文字；
 * - 头部：历史图标 + 「会话历史」+ 总数 + 关闭按钮；底部「新会话」；
 * - 关闭：再次点击触发按钮 / 外点 / Escape / 关闭按钮 / 切换或新建会话后收起。
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

export function statusOf(s: SessionMeta, runningIds: string[]): { cls: string; text: string } {
  const unread = s.unread?.toLowerCase();
  if (runningIds.includes(s.id)) return { cls: "amber", text: "运行中" };
  if (!unread) return { cls: "none", text: "已读" };
  if (["success", "green", "done"].includes(unread)) return { cls: "green", text: "成功" };
  if (["failed", "failure", "error", "red"].includes(unread)) return { cls: "red", text: "失败" };
  return { cls: "amber", text: "待处理" };
}

export function HistoryIcon({ size = 16 }: { size?: number }) {
  // 「面板 + 会话记录 + 回环」语义（CR-042：弃用退回箭头/时钟）
  return (
    <Icon name="history" size={size} aria-hidden />
  );
}

export function SessionHistory(props: {
  sessions: SessionMeta[];
  currentId: string | null;
  runningIds: string[];
  onSwitch: (s: SessionMeta) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 外点与 Escape 由同 scope 的唯一 overlay 控制器处理。

  const target = props.sessions.find(s => s.id === confirmId);

  return (
    <div className="chat-history" data-chat-overlay="history" ref={boxRef} role="dialog" aria-label="会话历史">
      <div className="chat-history-head">
        <span className="chat-history-title">
          <HistoryIcon size={14} />
          <b>会话历史</b>
          <span className="chat-history-count">{props.sessions.length}</span>
        </span>
        <button className="chat-iconbtn" title="关闭" aria-label="关闭会话历史" onClick={props.onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="chat-history-list">
        {props.sessions.length === 0 && <div className="chat-menu-hint">暂无历史会话</div>}
        {props.sessions.map(s => {
          const st = statusOf(s, props.runningIds);
          const rt = getRuntime(s.id);
          const tokens = rt.tokensIn + rt.tokensOut;
          const dur = rt.modelMs + rt.toolMs;
          const meta = [
            fmtTime(s.updatedAt),
            tokens > 0 ? `${tokens >= 10000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok` : "—",
            dur > 0 ? formatDur(dur) : "—",
          ].join(" · ");
          return (
            <div
              key={s.id}
              className={`chat-hist-item ${s.id === props.currentId ? "active" : ""}`}
              onClick={() => props.onSwitch(s)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSwitch(s); } }}
              aria-current={s.id === props.currentId ? "true" : undefined}
            >
              <span className={`chat-hist-dot dot-${st.cls}`} title={st.text} />
              <div className="chat-hist-main">
                <div className="chat-hist-title ellipsis">{s.title || "未命名会话"}</div>
                <div className="chat-hist-meta">{meta}</div>
              </div>
              <span className={`chat-hist-state st-${st.cls}`}>{st.text}</span>
              <button
                className="chat-hist-del"
                title="删除会话"
                aria-label={`删除会话 ${s.title || "未命名会话"}`}
                onClick={e => {
                  e.stopPropagation();
                  setConfirmId(s.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="chat-history-foot">
        <button className="btn sm primary" style={{ width: "100%" }} onClick={props.onNew}>
          <Icon name="plus" size={14} /> 新会话
        </button>
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
