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
  /** CR-101：生成中的实时流速（1 位小数）；null 表示无可用实时值，该片段省略。 */
  liveTps?: number | null;
  /** true 表示 liveTps 由字符折算估算，展示必须带 `~` 且在详情标注估算。 */
  liveEstimated?: boolean;
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

/** CR-101：速度格式对齐 DSH 统计行——≥10 取整，<10 保留 1 位小数。 */
export function fmtTps(n: number): string {
  const clamped = Math.max(0, n);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
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
  // CR-101 R5：空态只看「是否存在可信数据」，不再用消息条数 msgs 参与判空。
  const live = nonNegative(data.liveTps);
  const empty = values.rounds == null && values.steps == null && values.tps == null && live == null
    && [values.modelMs, values.toolMs, values.ttftMs, ...tokenParts, values.contextUsed].every(n => n == null);
  return { ...values, total, partialTotal, cacheHitPct, ctxPct, empty, live };
}

/* ---------------- CR-101：组级可见 + 字段级省略 ---------------- */

export type StatGroupId = "session" | "tokens" | "context";
export interface StatFragment { key: string; text: string }
export interface StatGroup { id: StatGroupId; label: string; fragments: StatFragment[] }
export interface StatsView { groups: StatGroup[] }

/**
 * CR-101 R-CR101-1～5：把统计归一化为「可见组 + 组内片段」。
 * - 组内某字段未知时不生成片段，因此不会出现「—」占位或分隔符残骸；
 * - 可信 0 生成片段（0 轮／0 tok／缓存 0%），与 null 严格区分；
 * - 三组都没有片段时返回空数组，调用方必须整条不渲染。
 */
export function statsView(data: StatsData): StatsView {
  const p = statsPresentation(data);
  const groups: StatGroup[] = [];

  // 会话组：轮与步共用计数段（空格相连），流速独立片段（· 相连）。
  const counts = [
    p.rounds != null ? `${p.rounds} 轮` : "",
    p.steps != null ? `${p.steps} 步` : "",
  ].filter(Boolean).join(" ");
  const fragments: StatFragment[] = [];
  if (counts) fragments.push({ key: "counts", text: counts });
  // R-CR101-10：生成中优先实时值；无实时值时回落到权威测量，不并列显示两种口径。
  if (p.live != null && p.live > 0) {
    // R-CR101-9：实时值始终是密度估算，带 `~` 前缀；取整为 0 时不显示。
    fragments.push({ key: "tps", text: `~${fmtTps(p.live)} tok/s` });
  } else if (p.tps != null) {
    // R-CR101-4：权威测得的 0 是可信零值，必须显示（区别于实时估算取整为 0 的省略）。
    fragments.push({ key: "tps", text: `${fmtTps(p.tps)} tok/s` });
  }
  if (fragments.length) groups.push({ id: "session", label: "会话统计", fragments });

  // Token 组：完整总量 / 已知部分 / 缓存命中率各自独立判定。
  // 完整总量未知但已有部分字段时显示「已知 N tok」，不冒充完整累计，也不把真实数据藏掉。
  const tokenFragments: StatFragment[] = [];
  if (p.total != null) tokenFragments.push({ key: "total", text: `${fmtTok(p.total)} tok` });
  else if (p.partialTotal != null) tokenFragments.push({ key: "total", text: `已知 ${fmtTok(p.partialTotal)} tok` });
  // R-CR101-14：统计条写两字「缓存」省空间；详情浮层仍写完整「缓存命中」。
  if (p.cacheHitPct != null) tokenFragments.push({ key: "cache", text: `缓存 ${p.cacheHitPct}%` });
  if (tokenFragments.length) groups.push({ id: "tokens", label: "Token 用量", fragments: tokenFragments });

  // 上下文组：只在当前窗口占用可信时出现；上限未知时给已用量而非假百分比。
  if (p.contextUsed != null) {
    groups.push({
      id: "context", label: "上下文",
      fragments: [{ key: "ctx", text: p.ctxPct != null ? `${p.ctxPct}%` : `~${fmtTok(p.contextUsed)} tok` }],
    });
  }
  return { groups };
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
  const toggle = (k: StatGroupId, trigger: HTMLElement) => overlay.toggle(k, trigger);
  const data = statsPresentation(props.data);
  const view = statsView(props.data);
  const { total, partialTotal, cacheHitPct, contextUsed, contextLimit, ctxPct } = data;
  const find = (id: StatGroupId) => view.groups.find(g => g.id === id);
  const session = find("session"), tokens = find("tokens"), context = find("context");
  // CR-101 R-CR101-1：三组全无可信数据时整条不渲染——不输出容器、不留 padding／min-height
  // 空白、不提供只能打开空浮层的入口。可信零值仍会生成片段，因此不会被这里误隐藏。
  if (!session && !tokens && !context) return null;
  const groupText = (g: StatGroup) => g.fragments.map(f => f.text).join(" · ");
  /** R-CR101-6：详情内未知字段写「未上报」，不用「—」冒充数值。 */
  const unknown = "未上报";
  const liveActive = data.live != null && data.live > 0;
  const tpsLabel = liveActive
    ? `~${fmtTps(data.live!)} tok/s（生成中实时估算）`
    : data.tps != null
      ? `${fmtTps(data.tps)} tok/s（本轮闭合测量）`
      : null;
  const countsText = [data.rounds != null ? `${data.rounds} 轮` : "", data.steps != null ? `${data.steps} 步` : ""].filter(Boolean).join(" ");

  return (
    <div className="chat-stats cr074-stats">
      {session && (
      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "session" ? "on" : ""}`}
          aria-label="会话统计"
          aria-expanded={open === "session"}
          title="会话统计"
          data-chat-overlay-trigger="session" onClick={e => toggle("session", e.currentTarget)}
        >
          <SessionGauge />
          {groupText(session)}
        </button>
        {open === "session" && (
          <div className="chat-stat-pop" data-chat-overlay="session" role="dialog" aria-label="会话统计详情">
            <div className="chat-stat-pop-head">
              <b>会话统计</b>
              <span className="muted">{data.msgs != null ? `${data.msgs} 条消息` : unknown}</span>
            </div>
            <div className="chat-stat-pop-body">
            <div className="chat-stat-rows">
              <Row label="会话轮次" value={data.rounds != null ? `${data.rounds} 轮` : unknown} />
              <Row label="执行步数" value={data.steps != null ? `${data.steps} 步` : unknown} />
              <Row label="模型用时" value={data.modelMs != null ? formatDur(data.modelMs) : unknown} />
              <Row label="工具调用用时" value={data.toolMs != null ? `${formatDur(data.toolMs)}（估算）` : unknown} />
              <Row label="本轮首 token（TTFT）" value={data.ttftMs != null ? formatDur(data.ttftMs) : unknown} />
              <Row label="输出速度（TPS）" value={tpsLabel ?? unknown} />
            </div>
            <div className="chat-stat-pop-foot">{props.data.statsSource ?? "未上报权威闭合步骤边界时，轮次和步数保持未知"}；{props.data.timingSource ?? "客户端本轮测量"}；实时流速按 DeepSeek 官方字符密度（中文 0.6／英文 0.3 token）估算并用已结算步骤校准，属估算值；工具耗时为事件差</div>
            </div>
          </div>
        )}
      </span>
      )}

      {tokens && (
      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "tokens" ? "on" : ""}`}
          aria-label="Token 用量"
          aria-expanded={open === "tokens"}
          title="Token 用量"
          data-chat-overlay-trigger="tokens" onClick={e => toggle("tokens", e.currentTarget)}
        >
          <TokenDatabase />
          {groupText(tokens)}
        </button>
        {open === "tokens" && (
          <div className="chat-stat-pop" data-chat-overlay="tokens" role="dialog" aria-label="Token 用量详情">
            <div className="chat-stat-pop-head">
              <b>Token 用量</b>
              <span className="muted">{total != null ? `${total.toLocaleString()} tok` : partialTotal != null ? `已知部分 ${partialTotal.toLocaleString()} tok（部分字段未上报）` : unknown}</span>
            </div>
            <div className="chat-stat-pop-body">
            <div className="chat-stat-rows">
              <Row label="缓存命中" value={cacheHitPct != null ? `${cacheHitPct}%` : unknown} />
              <Row label="未缓存输入" value={data.tokensIn != null ? `${fmtTok(data.tokensIn)} tok` : unknown} />
              <Row label="缓存读取" value={data.cacheRead != null ? `${fmtTok(data.cacheRead)} tok` : unknown} />
              <Row label="输出" value={data.tokensOut != null ? `${fmtTok(data.tokensOut)} tok` : unknown} />
            </div>
            <div className="chat-stat-pop-foot">累计口径：请求内累计上报去重，跨请求累加；未知不推算，字段不完整时不展示完整总量</div>
            </div>
          </div>
        )}
      </span>
      )}

      {context && (
      <span className="chat-stat-wrap">
        <button
          className={`chat-stat-btn ${open === "context" ? "on" : ""}`}
          aria-label="上下文用量"
          aria-expanded={open === "context"}
          title="上下文用量"
          data-chat-overlay-trigger="context" onClick={e => toggle("context", e.currentTarget)}
        >
          <ContextRing percent={ctxPct} />
          {groupText(context)}
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
              <Row label="已用 tokens" value={contextUsed != null ? `~${fmtTok(contextUsed)} tok` : unknown} />
              <Row label="窗口上限" value={contextLimit != null ? fmtTok(contextLimit) + " tok" : unknown} />
              <Row label="剩余" value={contextUsed != null && contextLimit != null && contextLimit > 0 ? `${fmtTok(Math.max(0, contextLimit - contextUsed))} tok` : unknown} />
            </div>
            <div className="chat-stat-rows"><Row label="系统提示词" value="未上报" /><Row label="工具定义" value="未上报" /><Row label="对话消息" value="未上报" /></div><div className="chat-stat-pop-foot">取最近一次请求上报的当前窗口占用；不累加历史窗口，不用累计 Token 或配置上限推算</div>
            </div>
          </div>
        )}
      </span>
      )}
    </div>
  );
}
