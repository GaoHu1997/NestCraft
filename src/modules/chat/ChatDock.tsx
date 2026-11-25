/* TodoPanel and GoalBar adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek.
 * Distributed under the MIT license. See chat-dock.LICENSE. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Confirm } from "@/components/ui";
import type { PlanItem } from "./sessionPlan";
import type { SessionGoal, SessionGoalState, SessionTaskState } from "./sessionRuntime";
import "./chat-dock.css";

const statuses: Record<SessionTaskState, string> = {
  completed: "已完成", running: "进行中", pending: "待处理",
  failed: "失败", cancelled: "已取消", awaiting_user: "待用户处理",
};
const progressOrder: SessionTaskState[] = ["completed", "running", "pending", "failed", "cancelled", "awaiting_user"];
const glyphStates: Record<SessionTaskState, "done" | "ongoing" | "idle" | "error" | "warning"> = {
  completed: "done", running: "ongoing", pending: "idle",
  failed: "error", cancelled: "idle", awaiting_user: "warning",
};

function TaskStatusGlyph({ state }: { state: SessionTaskState }) {
  const glyphState = glyphStates[state];
  const spinnerRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const spinner = spinnerRef.current;
    if (!spinner) return;
    const synchronize = () => {
      for (const animation of spinner.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0;
    };
    synchronize();
    spinner.addEventListener("animationstart", synchronize);
    return () => spinner.removeEventListener("animationstart", synchronize);
  }, [glyphState]);

  return <span className="chat-todo-glyph" role="img" aria-label={statuses[state]}>
    {glyphState === "ongoing" ? <svg ref={spinnerRef} className="chat-task-spinner" data-state="ongoing" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
      <g className="chat-task-spinner-motion">
        <circle className="chat-task-spinner-track" cx="12" cy="12" r="9.5" />
        <circle className="chat-task-spinner-arc" cx="12" cy="12" r="9.5" />
      </g>
    </svg> : <span className="chat-task-dot" data-state={glyphState} aria-hidden="true" />}
  </span>;
}

export function TodoPanel({ items, expanded, onToggle }: {
  items: PlanItem[]; expanded: boolean; onToggle: () => void;
}) {
  const listId = useId();
  if (!items.length) return null;
  const progress = progressOrder.flatMap(state => {
    const count = items.filter(item => item.state === state).length;
    return count ? [`${count} ${statuses[state]}`] : [];
  }).join(" · ");

  return <section className="chat-dock-card chat-todo" data-testid="todo-panel" aria-label="任务">
    <button className="chat-todo-header" type="button" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={onToggle}>
      <Icon name="steps" size={16} />
      <span className="chat-dock-label">任务</span>
      <span className="chat-dock-ellipsis" title={progress}>{progress}</span>
      <Icon name={expanded ? "chevronDown" : "chevronUp"} size={16} />
    </button>
    {expanded && <ul id={listId} className="chat-todo-list" data-testid="todo-list">
      {items.map(item => <li key={item.id} data-status={item.state}>
        <TaskStatusGlyph state={item.state} />
        <span className="chat-dock-ellipsis" title={item.text}>{item.text}</span>
      </li>)}
    </ul>}
  </section>;
}

function GoalAction({ label, icon, onClick, disabled }: {
  label: string; icon: IconName; onClick: () => void; disabled?: boolean;
}) {
  return <button className="chat-goal-action" type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <Icon name={icon} size={14} />
  </button>;
}

export function GoalBar({ goal, disarmed, onEdit, onStateChange, onCleared }: {
  goal: SessionGoal; disarmed: boolean; onEdit: (text: string) => void; onStateChange: (state: SessionGoalState) => void; onCleared: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const composingRef = useRef(false);
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      editRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);
  const closeEditor = () => { composingRef.current = false; restoreFocus.current = true; setDraft(null); };
  const save = () => {
    if (!draft?.trim()) return;
    onEdit(draft);
    closeEditor();
  };
  const phase = goal.state === "paused" ? "已暂停的目标" : goal.state === "blocked" ? "受阻的目标" : disarmed ? "待继续的目标" : "进行中的目标";
  const resume = goal.state !== "active" || disarmed;

  return <div className={`chat-dock-card chat-goal${editing ? " editing" : ""}`} data-goal-bar="">
    {editing ? <>
      <textarea aria-label="目标内容" autoFocus rows={1} value={draft} onChange={e => setDraft(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={e => {
        if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEditor(); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      }} />
      <div className="chat-goal-actions">
        <GoalAction label="保存目标" icon="check" onClick={save} disabled={!draft.trim()} />
        <GoalAction label="取消编辑" icon="x" onClick={closeEditor} />
      </div>
    </> : <>
      <Icon name="target" size={14} />
      <span className="chat-dock-label">{phase}</span>
      <span className="chat-dock-ellipsis" title={goal.text}>{goal.text}</span>
      <div className="chat-goal-actions">
        <button ref={editRef} className="chat-goal-action" type="button" title="编辑目标" aria-label="编辑目标" onClick={() => { composingRef.current = false; setDraft(goal.text); }}><Icon name="edit" size={14} /></button>
        <GoalAction label="清除目标" icon="trash" onClick={() => setConfirming(true)} />
        <GoalAction label={resume ? "恢复目标" : "暂停目标"} icon={resume ? "play" : "pause"} onClick={() => onStateChange(resume ? "active" : "paused")} />
      </div>
    </>}
    {confirming && <Confirm title="清除目标？" message="此目标将停止，清除记录会保留在本会话。" danger onCancel={() => setConfirming(false)} onOk={() => { setConfirming(false); onStateChange("cancelled"); onCleared(); }} />}
  </div>;
}
