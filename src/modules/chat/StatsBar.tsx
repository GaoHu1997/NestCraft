import { useChatOverlay } from "./overlay";
import { formatDur } from "./sessionRuntime";
import "./stats-bar.css";

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
  rounds: number | null;
  /** WP-074-F012：只计权威闭合步骤；未上报时未知，不从消息或工具数推算。 */
  steps?: number | null;
  /** 轮/步的来源与覆盖范围；不改变现有耗时和 Token 计量来源。 */
  statsSource?: string;
  timingSource?: string;
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

/** 只在展示层归一化；未知/非法值不参与求和，不以0替代未知。 */
const nonNegative = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const count = (n: unknown): number | null => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
const sumKnown = (values: (number | null)[]): number | null => {
  if (values.some(n => n == null)) return null;
  return nonNegative(values.reduce<number>((total, n) => total + (n ?? 0), 0));
};

/** UI-CR074-v1：K/M最多一位小数，不尾随.0，单位统一为大写K。 */
export function fmtTok(n: number | null | undefined): string {
  const value = nonNegative(n);
  if (value == null) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}K`;
  return String(value);
}

/** WP-074-F012：消费现行互斥字段，聚合/请求去重由现有上游负责，本函数不计数请求。 */
export function statsPresentation(data: StatsData) {
  const values = {
    rounds: count(data.rounds), msgs: count(data.msgs), steps: count(data.steps),
    modelMs: nonNegative(data.modelMs), toolMs: nonNegative(data.toolMs),
    ttftMs: nonNegative(data.ttftMs), tps: nonNegative(data.tps),
    tokensIn: nonNegative(data.tokensIn), tokensOut: nonNegative(data.tokensOut),
    cacheRead: nonNegative(data.cacheRead), contextUsed: nonNegative(data.contextUsed),
    contextLimit: nonNegative(data.contextLimit),
  };
  const tokenParts = [values.tokensIn, values.cacheRead, values.tokensOut];
  // 必须三项均已上报，缓存缺失不能把已知部分当作完整累计总量。
  const total = sumKnown(tokenParts);
  const knownParts = tokenParts.filter((n): n is number => n != null);
  const partialTotal = knownParts.length ? sumKnown(knownParts) : null;
  const cacheTotal = sumKnown([values.tokensIn, values.cacheRead]);
  const cacheHitPct = cacheTotal != null && cacheTotal > 0 && values.cacheRead != null
    ? Math.round(values.cacheRead / cacheTotal * 100) : null;
  const ctxPct = values.contextUsed != null && values.contextLimit != null && values.contextLimit > 0
    ? values.contextUsed >= values.contextLimit ? 100 : Math.round(values.contextUsed / values.contextLimit * 100)
    : null;
  // 沿用全新空会话占位规则；可信零用量/零步骤/零耗时仍是已知数据，不能被隐藏。
  const empty = values.rounds === 0 && values.msgs === 0 && values.steps == null
    && [values.modelMs, values.toolMs, values.ttftMs, values.tps, ...tokenParts, values.contextUsed].every(n => n == null);
  return { ...values, total, partialTotal, cacheHitPct, ctxPct, empty };
}

function SessionGauge() {
  return <svg className="chat-stat-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 17a9 9 0 1 1 16 0" /><path d="m12 12 4-4" /></svg>;
}
function TokenDatabase() {
  return <svg className="chat-stat-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3M5 15c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>;
}
function ContextRing({ percent }: { percent: number | null }) {
  return <svg className="chat-context-ring" width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeOpacity=".2" strokeWidth="2.2" />{percent != null && <circle className="chat-context-ring-value" cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.2" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 10 10)" />}</svg>;
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
  const data = statsPresentation(props.data);
  const { total, partialTotal, cacheHitPct, contextUsed, contextLimit, ctxPct, tps, empty } = data;

  return (
    <div className={`chat-stats cr074-stats${empty ? " is-empty" : ""}`} aria-hidden={empty || undefined}>
      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "session" ? "on" : ""}`}
          aria-label="会话统计"
          aria-expanded={open === "session"}
          title="会话统计"
          data-chat-overlay-trigger="session" onClick={e => toggle("session", e.currentTarget)}
        >
          <SessionGauge />
          {data.rounds ?? "—"} 轮 {data.steps ?? "—"} 步 · {tps ?? "—"} tok/s
        </button>
        {open === "session" && (
          <div className="chat-stat-pop" data-chat-overlay="session" role="dialog" aria-label="会话统计详情">
            <div className="chat-stat-pop-head">
              <b>会话统计</b>
              <span className="muted">{data.msgs ?? "—"} 条消息</span>
            </div>
            <div className="chat-stat-pop-body">
            <div className="chat-stat-rows">
              <Row label="会话轮次" value={`${data.rounds ?? "—"} 轮`} />
              <Row label="执行步数" value={`${data.steps ?? "—"} 步`} />
              <Row label="模型用时" value={data.modelMs != null ? formatDur(data.modelMs) : "—"} />
              <Row label="工具调用用时" value={data.toolMs != null ? `${formatDur(data.toolMs)}（估算）` : "—"} />
              <Row label="本轮首 token（TTFT）" value={data.ttftMs != null ? formatDur(data.ttftMs) : "—"} />
              <Row label="输出速度（TPS）" value={tps != null ? `${tps} tok/s` : "—"} />
            </div>
            <div className="chat-stat-pop-foot">{props.data.statsSource ?? "未上报权威闭合步骤边界时，轮次和步数保持未知"}；{props.data.timingSource ?? "客户端本轮测量"}；工具耗时为事件差，TPS 未有本轮输出计量时保持未知</div>
            </div>
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
          <TokenDatabase />
          {fmtTok(total)} tok · 缓存命中 {cacheHitPct != null ? `${cacheHitPct}%` : "—"}
        </button>
        {open === "tokens" && (
          <div className="chat-stat-pop" data-chat-overlay="tokens" role="dialog" aria-label="Token 用量详情">
            <div className="chat-stat-pop-head">
              <b>Token 用量</b>
              <span className="muted">{total != null ? `${total.toLocaleString()} tok` : partialTotal != null ? `已知部分 ${partialTotal.toLocaleString()} tok（部分字段未上报）` : "用量未知"}</span>
            </div>
            <div className="chat-stat-pop-body">
            <div className="chat-stat-rows">
              <Row label="缓存命中" value={cacheHitPct != null ? `${cacheHitPct}%` : "—"} />
              <Row label="未缓存输入" value={data.tokensIn != null ? `${fmtTok(data.tokensIn)} tok` : "—"} />
              <Row label="缓存读取" value={data.cacheRead != null ? `${fmtTok(data.cacheRead)} tok` : "—"} />
              <Row label="输出" value={data.tokensOut != null ? `${fmtTok(data.tokensOut)} tok` : "—"} />
            </div>
            <div className="chat-stat-pop-foot">累计口径：请求内累计上报去重，跨请求累加；未知不推算，字段不完整时不展示完整总量</div>
            </div>
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
          <ContextRing percent={ctxPct} />
          {ctxPct != null ? `${ctxPct}%` : "—"}
        </button>
        {open === "context" && (
          <div className="chat-stat-pop" data-chat-overlay="context" role="dialog" aria-label="上下文详情">
            <div className="chat-stat-pop-head">
              <b>上下文</b>
              <span className="muted">
                {contextUsed == null
                  ? "窗口占用未上报"
                  : ctxPct != null
                    ? `已用 ${ctxPct}% · ~${fmtTok(contextUsed)} / ${fmtTok(contextLimit)}`
                    : `已用 ~${fmtTok(contextUsed)} tok · ${contextLimit === 0 ? "窗口上限为0，比例不可计算" : "窗口上限未知"}`}
              </span>
            </div>
            <div className="chat-stat-pop-body">
            <div className="chat-stat-rows">
              <Row label="已用 tokens" value={contextUsed != null ? `~${fmtTok(contextUsed)} tok` : "—"} />
              <Row label="窗口上限" value={contextLimit != null ? fmtTok(contextLimit) + " tok" : "—"} />
              <Row label="剩余" value={contextUsed != null && contextLimit != null && contextLimit > 0 ? `${fmtTok(Math.max(0, contextLimit - contextUsed))} tok` : "—"} />
            </div>
            <div className="chat-stat-rows"><Row label="系统提示词" value="未知（未上报）" /><Row label="工具定义" value="未知（未上报）" /><Row label="对话消息" value="未知（未上报）" /></div><div className="chat-stat-pop-foot">取最近一次请求上报的当前窗口占用；不累加历史窗口，不用累计 Token 或配置上限推算</div>
            </div>
          </div>
        )}
      </span>
    </div>
  );
}
