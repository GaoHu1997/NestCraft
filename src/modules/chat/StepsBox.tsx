import { Icon } from "@/components/icons";
import { advanceDemoStep } from "./sessionRuntime";
import type { ChatStep } from "./sessionRuntime";
import { useToast } from "@/components/ui";

/**
 * 分步骤执行折叠框（CR-042 §3.5 / C42-07~08，AC-STORY-062-15~17）：
 * - 位于消息流末尾、输入框之前，随消息区滚动，与消息区等宽；
 * - 头部：步骤图标、标题、done/total 计数、整体状态胶囊（进行中/已完成/有失败/等待继续）、折叠箭头；
 * - 步骤行：完成绿勾、执行中旋转环+高亮、未开始灰时钟、失败红警示；
 * - 失败不计入已完成；折叠保留头部计数；无步骤不显示空框；
 * - 「推进演示」仅存在于合成演示会话（评审 C：显式 seed，不静默注入用户会话）。
 */

export function StepsBox(props: { steps: ChatStep[]; demo: boolean; preview?: boolean; open: boolean; onToggle: () => void; sid: string; bump: () => void }) {
  const toast = useToast();
  const steps = props.steps;
  const done = steps.filter(s => s.state === "done").length;
  const failed = steps.filter(s => s.state === "failed").length;
  const running = steps.some(s => s.state === "running");
  const allDone = done === steps.length;
  const stateCls = failed > 0 ? "fail" : running ? "run" : allDone ? "done" : "";
  const stateText = failed > 0 ? "有失败" : running ? "进行中" : allDone ? "已完成" : "等待继续";

  const advance = () => {
    const more = advanceDemoStep(props.sid);
    props.bump();
    if (!more) toast("步骤已全部完成", "info");
  };

  return (
    <section className={`chat-steps ${props.open ? "open" : "collapsed"}`} aria-label="执行步骤">
      <button className="chat-steps-h" aria-expanded={props.open} onClick={props.onToggle}>
        <Icon name="steps" size={14} aria-hidden />
        <b>执行步骤</b>
        <span className="chat-steps-count">
          {done}/{steps.length}
        </span>
        <span className={`chat-steps-state ${stateCls}`}>{stateText}</span>
        <span className="spacer" />
        <span className="chat-steps-chev" aria-hidden>
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      {props.open && (
        <div className="chat-steps-list">
          {steps.map((s, i) => (
            <div key={s.id} className={`chat-step ${s.state}`} style={{ animationDelay: `${Math.min(i, 8) * 20}ms` }}>
              <span className="chat-step-ico">
                {s.state === "done" ? (
                  <Icon name="check" size={12} />
                ) : s.state === "running" ? (
                  <Icon name="loader" size={12} className="icon-spin" aria-label="执行中" />
                ) : s.state === "failed" ? (
                  <Icon name="alert" size={12} />
                ) : (
                  <Icon name="clock" size={12} />
                )}
              </span>
              <span className="chat-step-title">{s.title}</span>
              <span className="chat-step-meta">
                {s.state === "done"
                  ? `已完成${s.meta ? ` · ${s.meta}` : ""}`
                  : s.state === "running"
                    ? "执行中"
                    : s.state === "failed"
                      ? `失败${s.meta ? ` · ${s.meta}` : ""}`
                      : "未开始"}
              </span>
            </div>
          ))}
        </div>
      )}
      {props.open && (
        <div className="chat-steps-f">
          <span className="chat-steps-note">
            {props.demo || props.preview ? "合成演示 · 未调用真实模型或工具 · 失败步骤不计入已完成" : "来自本会话工具事件记录 · 耗时为相邻事件差估算"}
          </span>
          {props.demo && (
            <button className="chat-steps-advance" onClick={advance}>
              推进演示
            </button>
          )}
        </div>
      )}
    </section>
  );
}
