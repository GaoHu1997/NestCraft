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
  const total = props.data.tokensIn != null && props.data.tokensOut != null ? props.data.tokensIn + props.data.tokensOut : null;
  const cacheTotal = props.data.cacheRead != null && props.data.tokensIn != null ? props.data.cacheRead + props.data.tokensIn : null;
  const cacheHitPct = cacheTotal && props.data.cacheRead != null ? Math.round(props.data.cacheRead / cacheTotal * 100) : null;
  const ctxPct =
    props.data.contextUsed != null && props.data.contextLimit ? Math.min(100, Math.round((props.data.contextUsed / props.data.contextLimit) * 100)) : null;
  const tps = props.data.tps;

  return (
    <div className="chat-stats">
      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "session" ? "on" : ""}`}
          aria-label="会话统计"
          aria-expanded={open === "session"}
          title="会话统计"
          data-chat-overlay-trigger="session" onClick={e => toggle("session", e.currentTarget)}
        >
          <Icon name="refresh" size={13} aria-hidden />
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

      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "tokens" ? "on" : ""}`}
          aria-label="Token 用量"
          aria-expanded={open === "tokens"}
          title="Token 用量"
          data-chat-overlay-trigger="tokens" onClick={e => toggle("tokens", e.currentTarget)}
        >
          <Icon name="database" size={13} aria-hidden />
          {total != null ? fmtTok(total) : "—"} tok
        </button>
        {open === "tokens" && (
          <div className="chat-stat-pop" data-chat-overlay="tokens" role="dialog" aria-label="Token 用量详情">
            <div className="chat-stat-pop-head">
              <b>Token 用量</b>
              <span className="muted">{total != null ? `${total.toLocaleString()} tok` : "用量未知"}</span>
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

      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "context" ? "on" : ""}`}
          aria-label="上下文用量"
          aria-expanded={open === "context"}
          title="上下文用量"
          data-chat-overlay-trigger="context" onClick={e => toggle("context", e.currentTarget)}
        >
          <Icon name="cpu" size={13} aria-hidden />
          上下文 {ctxPct != null ? `${ctxPct}%` : props.data.contextUsed != null ? fmtTok(props.data.contextUsed) : "未知"}
        </button>
        {open === "context" && (
          <div className="chat-stat-pop" data-chat-overlay="context" role="dialog" aria-label="上下文详情">
            <div className="chat-stat-pop-head">
              <b>上下文</b>
              <span className="muted">
                {props.data.contextUsed != null && props.data.contextLimit
                  ? `已用 ${ctxPct}% · ~${fmtTok(props.data.contextUsed)} / ${fmtTok(props.data.contextLimit)}`
                  : props.data.contextLimit != null ? "占用未上报" : "窗口未知"}
              </span>
            </div>
            <div className="chat-stat-rows">
              <Row label="已用 tokens" value={props.data.contextUsed != null ? `${fmtTok(props.data.contextUsed)} tok` : "—"} />
              <Row label="窗口上限" value={props.data.contextLimit != null ? `${fmtTok(props.data.contextLimit)} tok` : "—"} />
              <Row label="剩余" value={props.data.contextUsed != null && props.data.contextLimit ? `${fmtTok(Math.max(0, props.data.contextLimit - props.data.contextUsed))} tok` : "—"} />
            </div>
            <div className="chat-stat-rows"><Row label="系统提示词" value="未知（未上报）" /><Row label="工具定义" value="未知（未上报）" /><Row label="对话消息" value="未知（未上报）" /></div><div className="chat-stat-pop-foot">上下文占用不使用累计 Token 估算</div>
          </div>
        )}
      </span>
    </div>
  );
}
