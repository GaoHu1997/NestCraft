import { CliLogo, Icon } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import type { SubagentEvent, SubagentRow } from "./sessionRuntime";
import { findSubagent } from "./sessionRuntime";
import "./chat.css";

/**
 * CR-062 / UI-CR062：子智能体只读详情（复用侧栏位置，不新建会话）。
 * - 顶部：返回图标 + 面包屑「主会话 / 子任务名」+ 状态；不显示子智能体/后台任务计数。
 * - 内容：子智能体本次运行的过程记录（状态、正文、工具、结果、产出），未知保持未知。
 * - 底部：只读提示与返回；子智能体由主会话派发，本视图不提供输入框。
 * - 记录只来自本进程运行时；刷新或重启后不承诺恢复，界面注明。
 */

const TONE: Record<string, "green" | "red" | "amber" | "gray"> = {
  运行中: "amber",
  待确认: "amber",
  成功: "green",
  失败: "red",
  已停止: "gray",
};

const KIND_LABEL: Record<SubagentEvent["kind"], string> = {
  status: "状态",
  text: "说明",
  tool: "工具调用",
  result: "工具结果",
  output: "产出",
};

function fmtTime(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function SubagentPanel(props: { parentId: string; agentId: string; onBack: () => void; visible?: boolean; width?: number; height?: string }) {
  const [, force] = useState(0);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // 子智能体事件在 Panel 隐藏期间仍持续写入运行态；这里按固定节拍复读，不上报、不改状态。
  useEffect(() => {
    if (props.visible === false) return;
    const timer = window.setInterval(() => force(v => v + 1), 500);
    return () => window.clearInterval(timer);
  }, [props.visible]);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      // 浮层打开时由浮层消费 Escape；到达这里说明没有更高优先级层。
      event.preventDefault();
      props.onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onBack]);

  const row: SubagentRow | null = findSubagent(props.parentId, props.agentId);
  const events = row?.events ?? [];
  const lastCount = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (events.length !== lastCount.current && stickRef.current) el.scrollTop = el.scrollHeight;
    lastCount.current = events.length;
  }, [events.length]);
  const tone = row ? TONE[row.status] ?? "gray" : "gray";

  return (
    <div className="chat-panel" hidden={props.visible === false} aria-label="子智能体只读详情" data-agent-view={props.agentId} style={{ height: props.height ?? "100%", ...(props.width ? { width: props.width } : {}) }}>
      <div className="chat-head chat-agent-head">
        <button ref={backRef} type="button" className="chat-iconbtn chat-agent-back" title="返回主会话" aria-label="返回主会话" onClick={props.onBack}>
          <Icon name="arrowLeft" size={16} />
        </button>
        <nav className="chat-crumb" aria-label="会话位置">
          <button type="button" className="chat-crumb-link" onClick={props.onBack} title="返回主会话">主会话</button>
          <span className="chat-crumb-sep" aria-hidden>/</span>
          <span className="chat-crumb-current ellipsis" title={row?.title ?? "子智能体任务"}>{row?.title ?? "子智能体任务"}</span>
        </nav>
        <span className="spacer" />
        {row && (
          <span className={`chat-agent-state st-${tone}`} role="status">
            <span className={`chat-agent-dot dot-${tone}`} aria-hidden />
            {row.status}
          </span>
        )}
      </div>
      {row ? (
        <>
          <div className="chat-agent-meta-bar">
            <CliLogo id={row.cli ?? "unknown"} size={16} />
            <span className="chat-agent-meta-cli">{row.cli ?? "CLI 未知"}</span>
            <span className="chat-agent-meta-sep" aria-hidden>·</span>
            <span>{row.model ?? "模型未知"}</span>
            <span className="chat-agent-meta-sep" aria-hidden>·</span>
            <span>{row.duration ?? "耗时未知"}</span>
            <span className="chat-agent-meta-sep" aria-hidden>·</span>
            <span>{row.tokens ? `${row.tokens} tokens` : "tokens 未知"}</span>
            {row.taskId && <span className="chat-agent-task-tag" title={`任务 ${row.taskId}`}>任务 {row.taskId}</span>}
          </div>
          <div
            className="chat-msgs chat-agent-timeline"
            ref={listRef}
            onScroll={() => {
              const el = listRef.current;
              if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            <div className="chat-agent-note" role="note">
              子智能体记录仅本次运行可见；未上报的内容保持未知，不补造。
            </div>
            {events.length === 0 && (
              <div className="chat-agent-ev ev-empty">
                <span className="chat-agent-ev-ico"><Icon name="clock" size={14} /></span>
                <div className="chat-agent-ev-main">
                  <div className="chat-agent-ev-head"><span>暂无过程记录</span></div>
                  <div className="chat-agent-ev-text">{row.output || "该子智能体尚未上报正文或工具调用；可返回主会话查看本轮结果。"}</div>
                </div>
              </div>
            )}
            {events.map((ev, i) => (
              <div className={`chat-agent-ev ev-${ev.kind}${ev.isError ? " ev-error" : ""}`} key={`${ev.at}-${ev.kind}-${i}`}>
                <span className="chat-agent-ev-ico" aria-hidden>
                  <Icon name={ev.kind === "tool" ? "terminal" : ev.kind === "result" ? "check" : ev.kind === "status" ? "loader" : ev.kind === "output" ? "checkCircle" : "message"} size={14} />
                </span>
                <div className="chat-agent-ev-main">
                  <div className="chat-agent-ev-head">
                    <span className="chat-agent-ev-kind">{KIND_LABEL[ev.kind]}</span>
                    {ev.status && <span className={`chat-agent-ev-status st-${TONE[ev.status] ?? "gray"}`}>{ev.status}</span>}
                    {ev.toolName && <code className="chat-agent-ev-tool">{ev.toolName}</code>}
                    {ev.at > 0 && <time className="chat-agent-ev-time">{fmtTime(ev.at)}</time>}
                  </div>
                  {ev.text && <div className={`chat-agent-ev-text${ev.kind === "tool" || ev.kind === "result" ? " mono" : ""}`}>{ev.text}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="chat-agent-missing" role="alert">
          <div className="chat-agent-missing-title">该子智能体记录已不可用</div>
          <p>可能已随会话运行态清理，或所在会话已关闭。返回主会话后可重新进入。</p>
          <button type="button" className="btn sm primary" onClick={props.onBack}>返回主会话</button>
        </div>
      )}
      <div className="chat-agent-readonly" role="note">
        <Icon name="eye" size={14} />
        <span>子智能体由主会话派发，这里只读；输入与发送在主会话进行。</span>
        <button type="button" className="btn sm" onClick={props.onBack}>返回主会话</button>
      </div>
    </div>
  );
}