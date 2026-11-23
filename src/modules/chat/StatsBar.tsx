import { Icon } from "@/components/icons";
import { useChatOverlay } from "./overlay";
import { formatDur } from "./sessionRuntime";

/**
 * 底部三统计（CR-042 §3.4 / C42-06）：
 * - 会话统计 / Token 用量 / 上下文 三个入口位于输入区最底部一行；
 * - 点击向上展开 296px 详情浮层：右缘与控件右缘对齐、下缘贴控件上缘（≤8px 间隙），
 *   底部右侧 8px 箭头指向触发控件；同一时刻只开一个；再点/外点/Escape 收起；
 * - 字段口径沿用 CR-019：轮次/模型用时/工具用时/TTFT/TPS；
 *   Token 总量/缓存命中/未缓存输入/缓存读取/输出；上下文 used/limit 与占比。
 * - CR-068 J10：上下文是**当前窗口**（最近一次请求上报的提示词用量），不是整会话累计；
 *   窗口上限只来自模型声明的 contextWindow；未上报的字段保持未知，不填 0、不用上限冒充用量。
 */

export interface StatsData {
  rounds: number;
  msgs: number;
  modelMs: number | null;
  toolMs: number | null;
  ttftMs: number | null;
  tps: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  contextUsed: number | null;
  contextLimit: number | null;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Row(props: { label: string; value: string }) {
  return (
    <div>
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

export function StatsBar(props: { data: StatsData }) {
  const overlay = useChatOverlay();
  const open = overlay.activeOverlay;
  const toggle = (k: "session" | "tokens" | "context", trigger: HTMLElement) => overlay.toggle(k, trigger);
  // CR-068 J10：Token 总量 = 未缓存输入 + 缓存读取 + 输出（互斥规范字段）；缓存未上报时只给已知部分。
  const total = props.data.tokensIn != null && props.data.tokensOut != null
    ? props.data.tokensIn + props.data.tokensOut + (props.data.cacheRead ?? 0)
    : null;
  const totalPartial = total != null && props.data.cacheRead == null;
  const cacheTotal = props.data.cacheRead != null && props.data.tokensIn != null ? props.data.cacheRead + props.data.tokensIn : null;
  const cacheHitPct = cacheTotal != null && cacheTotal > 0 && props.data.cacheRead != null ? Math.round(props.data.cacheRead / cacheTotal * 100) : null;
  // 上下文只取最近一次请求上报的窗口占用；窗口上限未知/0 不显示比例，也不用配置上限冒充实际用量。
  const contextUsed = props.data.contextUsed;
  const contextLimit = props.data.contextLimit != null && props.data.contextLimit > 0 ? props.data.contextLimit : null;
  const ctxPct = contextUsed != null && contextLimit != null ? Math.min(100, Math.round((contextUsed / contextLimit) * 100)) : null;
  const tps = props.data.tps;
  // CR-065：无数据的统计项不显示；三项都无数据时隐藏内容但**保留占位高度**，避免输入区位移。
  const showSession = props.data.rounds > 0 || props.data.msgs > 0;
  const showTokens = total != null && total > 0;
  const showContext = contextUsed != null;
  const empty = !showSession && !showTokens && !showContext;

  return (
    <div className={`chat-stats${empty ? " is-empty" : ""}`} aria-hidden={empty || undefined}>
      <span className="chat-stat-wrap" style={showSession ? undefined : { display: "none" }}>
        <button
          className={`chat-stat-btn ${open === "session" ? "on" : ""}`}
          aria-label="会话统计"
          aria-expanded={open === "session"}
          title="会话统计"
          data-chat-overlay-trigger="session" onClick={e => toggle("session", e.currentTarget)}
        >
          <Icon name="sessionStats" size={14} aria-hidden />
          {props.data.rounds} 轮{tps != null ? ` · ${tps} tok/s` : ""}
        </button>
        {open === "session" && (
          <div className="chat-stat-pop" data-chat-overlay="session" role="dialog" aria-label="会话统计详情">
            <div className="chat-stat-pop-head">
              <b>会话统计</b>
              <span className="muted">{props.data.msgs} 条消息</span>
            </div>
            <div className="chat-stat-rows">
              <Row label="会话轮次" value={`${props.data.rounds} 轮`} />
              <Row label="模型用时" value={props.data.modelMs != null && props.data.modelMs > 0 ? formatDur(props.data.modelMs) : "—"} />
              <Row label="工具调用用时" value={props.data.toolMs != null && props.data.toolMs > 0 ? `${formatDur(props.data.toolMs)}（估算）` : "—"} />
              <Row label="本轮首 token（TTFT）" value={props.data.ttftMs != null ? formatDur(props.data.ttftMs) : "—"} />
              <Row label="输出速度（TPS）" value={tps != null ? `${tps} tok/s` : "—"} />
            </div>
            <div className="chat-stat-pop-foot">客户端本轮测量；工具耗时为事件差，TPS 未有本轮输出计量时保持未知</div>
          </div>
        )}
      </span>

      <span className="chat-stat-wrap" style={showTokens ? undefined : { display: "none" }}>
        <button
          className={`chat-stat-btn ${open === "tokens" ? "on" : ""}`}
          aria-label="Token 用量"
          aria-expanded={open === "tokens"}
          title="Token 用量"
          data-chat-overlay-trigger="tokens" onClick={e => toggle("tokens", e.currentTarget)}
        >
          <Icon name="tokenUsage" size={14} aria-hidden />
          {total != null ? fmtTok(total) : "—"} tok
        </button>
        {open === "tokens" && (
          <div className="chat-stat-pop" data-chat-overlay="tokens" role="dialog" aria-label="Token 用量详情">
            <div className="chat-stat-pop-head">
              <b>Token 用量</b>
              <span className="muted">{total != null ? `${total.toLocaleString()} tok${totalPartial ? "（缓存读取未上报，已知部分）" : ""}` : "用量未知"}</span>
            </div>
            <div className="chat-stat-rows">
              <Row label="缓存命中" value={cacheHitPct != null ? `${cacheHitPct}%` : "—"} />
              <Row label="未缓存输入" value={props.data.tokensIn != null && props.data.tokensIn > 0 ? `${fmtTok(props.data.tokensIn)} tok` : "—"} />
              <Row label="缓存读取" value={props.data.cacheRead != null && props.data.cacheRead > 0 ? `${fmtTok(props.data.cacheRead)} tok` : "—"} />
              <Row label="输出" value={props.data.tokensOut != null && props.data.tokensOut > 0 ? `${fmtTok(props.data.tokensOut)} tok` : "—"} />
            </div>
            <div className="chat-stat-pop-foot">累计口径：请求内累计上报去重，跨请求累加；未知不推算</div>
          </div>
        )}
      </span>

      <span className="chat-stat-wrap" style={showContext ? undefined : { display: "none" }}>
        <button
          className={`chat-stat-btn ${open === "context" ? "on" : ""}`}
          aria-label="上下文用量"
          aria-expanded={open === "context"}
          title="上下文用量"
          data-chat-overlay-trigger="context" onClick={e => toggle("context", e.currentTarget)}
        >
          <Icon name="contextUsage" size={14} aria-hidden />
          上下文 {contextUsed != null ? (ctxPct != null ? `${ctxPct}%` : `${fmtTok(contextUsed)} tok`) : "未知"}
        </button>
        {open === "context" && (
          <div className="chat-stat-pop" data-chat-overlay="context" role="dialog" aria-label="上下文详情">
            <div className="chat-stat-pop-head">
              <b>上下文</b>
              <span className="muted">
                {contextUsed == null
                  ? "窗口占用未上报"
                  : contextLimit != null
                    ? `已用 ${ctxPct}% · ~${fmtTok(contextUsed)} / ${fmtTok(contextLimit)}`
                    : `已用 ~${fmtTok(contextUsed)} tok · 窗口上限未知`}
              </span>
            </div>
            <div className="chat-stat-rows">
              <Row label="已用 tokens" value={contextUsed != null ? `~${fmtTok(contextUsed)} tok` : "—"} />
              <Row label="窗口上限" value={contextLimit != null ? fmtTok(contextLimit) + " tok" : "未知"} />
              <Row label="剩余" value={contextUsed != null && contextLimit != null ? `${fmtTok(Math.max(0, contextLimit - contextUsed))} tok` : "—"} />
            </div>
            <div className="chat-stat-rows"><Row label="系统提示词" value="未知（未上报）" /><Row label="工具定义" value="未知（未上报）" /><Row label="对话消息" value="未知（未上报）" /></div><div className="chat-stat-pop-foot">取最近一次请求上报的当前窗口占用；不累加历史窗口，不用累计 Token 或配置上限推算</div>
          </div>
        )}
      </span>
    </div>
  );
}
