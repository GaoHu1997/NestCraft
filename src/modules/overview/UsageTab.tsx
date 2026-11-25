import { useEffect, useState } from "react";
import * as api from "@/api";
import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui";

/* CR-078 / UI-CR078-v5：概览 · 用量 Tab。
   六指标卡 + 活跃热力图 + 按小时趋势（按模型堆叠 + 悬停详情）+ 按模型 / 按供应商排行。
   数据来自 usage_stats 聚合（CLI / 平台主代理闭合步骤）；缺量来源显示「未上报」，不按字符数估算。
   热力图用固定近 28 周的日粒度窗口（后端 days[] 不随周期变化）；模型配色按「按模型」名次取平台色板，
   趋势图堆叠、图例与排行条共用同一份映射。 */

const RANGES: [string, string][] = [["today", "今日"], ["3d", "近 3 天"], ["7d", "近 7 天"], ["1m", "近 1 月"], ["3m", "近 3 月"], ["custom", "自定义"]];

/* 模型配色：按「按模型」排行的名次取平台色板，趋势图堆叠与排行条共用同一份映射，
   同名模型在两张图里颜色一致。只用平台既有主题变量，不引入自造色。 */
const MODEL_COLORS = ["var(--primary)", "var(--teal)", "var(--violet)", "var(--warning)", "var(--success)", "var(--danger)", "var(--primary-strong)", "var(--muted-2)"];
const paletteColor = (i: number) => MODEL_COLORS[i % MODEL_COLORS.length];
/** 悬停浮层最多列几个模型，其余汇总成一行，避免模型多时浮层顶出绘图区（与设计稿一致）。 */
const TIP_ROWS = 6;

/** 每小时该模型的 token 量（与趋势图堆叠口径一致：输入 + 输出，缓存单独用命中率曲线表达）。 */
const hourModelTokens = (m: api.UsageHourModel) => m.inputTokens + m.outputTokens;

const fmt = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n);

const pad2 = (n: number) => String(n).padStart(2, "0");

export function UsageTab() {
  const [range, setRange] = useState("7d");
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const n = new Date();
    const from = new Date(n); from.setDate(n.getDate() - 13);
    return { from: from.toISOString().slice(0, 10), to: n.toISOString().slice(0, 10) };
  });
  const [stats, setStats] = useState<api.UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.usageStats(range, range === "custom" ? custom.from : undefined, range === "custom" ? custom.to : undefined)
      .then((s) => { setStats(s); setError(null); })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [range, custom.from, custom.to]);

  const t = stats?.totals;
  // 排行与配色共用同一份已排序数据：名次 → 颜色，趋势图堆叠与「按模型」条形必然同色。
  const models = ranked((stats?.models ?? []).map((m) => ({ ...m, total: m.inputTokens + m.outputTokens })));
  const providers = ranked((stats?.providers ?? []).map((p) => ({ ...p, total: p.inputTokens + p.outputTokens })));
  const modelColor = new Map(models.map((m, i) => [m.name, paletteColor(i)]));
  return (
    <div className="ov-usage">
      <div className="ov-usage-h">
        <div className="ov-seg" role="tablist" aria-label="统计周期">
          {RANGES.map(([k, label]) => (
            <button key={k} className={range === k ? "active" : ""} role="tab" aria-selected={range === k} onClick={() => setRange(k)}>{label}</button>
          ))}
        </div>
        {range === "custom" && (
          <div className="row ov-custom">
            <input className="input" type="date" value={custom.from} aria-label="开始日期" onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <span className="muted">至</span>
            <input className="input" type="date" value={custom.to} aria-label="结束日期" onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        )}
        <div className="row ov-asof">
          <span className="caption">{stats ? `统计截至 ${new Date(stats.asOf).toLocaleString("zh-CN", { hour12: false })} · ${stats.from} ~ ${stats.to}` : "统计中…"}</span>
          <button className="btn sm" onClick={load}><Icon name="refresh" size={14} />刷新</button>
        </div>
      </div>
      {error && <div className="nc-error" role="alert">用量读取失败：{error}<button className="btn sm" onClick={load}>重试</button></div>}
      <div className="ov-kpis">
        <Kpi icon="tokenUsage" label="总 Tokens" value={t ? fmt(t.inputTokens + t.outputTokens) : "—"} sub={t ? `${(t.inputTokens + t.outputTokens).toLocaleString()} tokens` : " "} tone="blue" />
        <Kpi icon="download" label="输入 Tokens" value={t ? fmt(t.inputTokens) : "—"} sub={t ? `${t.inputTokens.toLocaleString()} tokens` : " "} tone="green" />
        <Kpi icon="upload" label="输出 Tokens" value={t ? fmt(t.outputTokens) : "—"} sub={t ? `${t.outputTokens.toLocaleString()} tokens` : " "} tone="amber" />
        <Kpi icon="database" label="缓存 Tokens" value={t ? fmt(t.cacheTokens) : "—"} sub={t ? `${t.cacheTokens.toLocaleString()} tokens` : " "} tone="violet" />
        <Kpi icon="chartLine" label="缓存命中率" value={t?.cacheHitRate != null ? t.cacheHitRate.toFixed(1) + "%" : "—"} sub={t ? `${fmt(t.cacheTokens)} 缓存命中` : " "} tone="teal" />
        <Kpi icon="message" label="请求量" value={t ? t.requests.toLocaleString() : "—"} sub={t ? `含 CLI 与平台会话` : " "} tone="rose" />
      </div>
      <div className="ov-two">
        <section className="card ov-panel">
          <div className="card-h"><h3>活跃热力图</h3>
            <span className="ov-legend"><span>较少</span>{[0, 1, 2, 3, 4].map((i) => <i key={i} className={`l${i}`} />)}<span>较多</span></span>
          </div>
          <div className="card-b ov-heat-wrap">
            {stats && stats.days.length > 0
              ? <Heat days={stats.days} />
              : <Empty title={loading ? "加载中…" : "这个周期没有用量记录"} />}
          </div>
        </section>
        <section className="card ov-panel">
          <div className="card-h"><h3>按小时 Token 趋势</h3>
            <span className="ov-legend">
              {models.slice(0, 3).map((m) => (
                <span key={m.name} title={m.name}><i style={{ background: modelColor.get(m.name) }} />{m.name}</span>
              ))}
              <span className="line">缓存命中率</span>
            </span>
          </div>
          <div className="card-b ov-chart">
            {stats && <Trend hours={stats.hours} colors={modelColor} />}
          </div>
        </section>
      </div>
      <div className="ov-two">
        <section className="card ov-panel">
          <div className="card-h"><h3>按模型</h3><span className="sub">{stats?.models.length ?? 0} 个</span></div>
          {models.length > 0 ? (
            <ol className="ov-rank">
              {models.map((m, i) => (
                <RankRow key={m.name} i={i} name={m.name} total={m.total} pct={m.pct} hit={m.cacheHitRate} color={paletteColor(i)}
                  logo={m.source !== "platform" && m.source !== "mixed" && m.cliId ? <span className="cli-logo cli-brand" data-cli={m.cliId}><CliLogo id={m.cliId} /></span> : <span className="ov-src"><Icon name={m.source === "platform" ? "sparkles" : "bot"} size={16} /></span>}
                  source={m.source === "platform" ? "平台主代理" : m.source === "cli" ? "CLI" : m.source === "mixed" ? "CLI + 平台" : m.source} />
              ))}
            </ol>
          ) : <Empty title={loading ? "加载中…" : "没有带用量上报的模型记录"} />}
        </section>
        <section className="card ov-panel">
          <div className="card-h"><h3>按供应商</h3><span className="sub">{stats?.providers.length ?? 0} 个</span></div>
          {providers.length > 0 ? (
            <ol className="ov-rank">
              {providers.map((p, i) => (
                <RankRow key={p.name} i={i} name={p.name} total={p.total} pct={p.pct} hit={p.cacheHitRate} color={paletteColor(i)}
                  logo={<i className="ov-prov-dot" style={{ background: paletteColor(i) }} />}
                  source="供应商" />
              ))}
            </ol>
          ) : <Empty title={loading ? "加载中…" : "没有带用量上报的供应商记录"} />}
        </section>
      </div>
      <div className="nc-page-foot">
        <span>来源：CLI 会话与平台主代理闭合步骤的落库用量；缺量的记录不计入，不做估算。</span>
        <span>栖造 · NestCraft</span>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: React.ComponentProps<typeof Icon>["name"]; label: string; value: string; sub: string; tone: string }) {
  return (
    <div className={`ov-kpi ${tone}`}>
      <div className="k"><span className="ov-kpi-ic"><Icon name={icon} size={16} /></span>{label}</div>
      <div className="v">{value}</div>
      <div className="s">{sub}</div>
    </div>
  );
}

/** 热力图：周一起始、列优先（周一在上），网格按固定列数铺满。
 *  时间轴从右往左推进——最右列是最近一周（末格对齐到本周周日），左侧逐列往前推；
 *  所选周期之外的日子保留空框，保证网格铺满且最新数据固定在右侧。 */
const HEAT_COLS = 28;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function heatSpan(days: api.UsageDay[], cols: number) {
  const last = new Date(`${days[days.length - 1].date}T00:00:00`);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const start = new Date(end);
  start.setDate(start.getDate() - (cols * 7 - 1));
  return { start, end };
}

function Heat({ days }: { days: api.UsageDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const { start } = heatSpan(days, HEAT_COLS);
  const cells: { blank: boolean; level: number; row: number; col: number; d?: api.UsageDay; key: string }[] = [];
  for (let i = 0; i < HEAT_COLS * 7; i++) {
    const at = new Date(start);
    at.setDate(at.getDate() + i);
    const key = ymd(at);
    const d = byDate.get(key);
    const col = Math.floor(i / 7), row = i % 7;
    if (!d) { cells.push({ blank: true, level: -1, row, col, key }); continue; }
    const r = (d.inputTokens + d.outputTokens) / max;
    cells.push({ blank: false, level: r <= 0 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4, row, col, d, key });
  }
  const months: { label: string; col: number; span: number }[] = [];
  for (let c = 0; c < HEAT_COLS; c++) {
    const at = new Date(start);
    at.setDate(at.getDate() + c * 7);
    const mo = ymd(at).slice(0, 7);
    const label = `${Number(mo.slice(5))}月`;
    if (months.length === 0 || months[months.length - 1].label !== label) months.push({ label, col: c + 1, span: 1 });
  }
  months.forEach((m, i) => { m.span = (i + 1 < months.length ? months[i + 1].col : HEAT_COLS + 1) - m.col; });
  // 跨度不足 2 列的月份放不下「N月」两字，直接不标（首列常是月中，标签会压到下一月）。
  const shown = months.filter((m) => m.span >= 2);
  return (
    <div className="ov-heat" style={{ ["--cols" as string]: String(HEAT_COLS) }}>
      <div className="ov-heat-months" style={{ gridTemplateColumns: `repeat(${HEAT_COLS}, minmax(0, 1fr))` }}>
        {shown.map((m) => <span key={m.label + m.col} style={{ gridColumn: `${m.col} / span ${m.span}` }}>{m.label}</span>)}
      </div>
      <div className="ov-heat-body">
        <div className="ov-heat-days">{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((w) => <span key={w}>{w}</span>)}</div>
        <div className="ov-heat-grid" style={{ gridTemplateColumns: `repeat(${HEAT_COLS}, minmax(0, 1fr))` }}>
          {cells.map((c) => c.blank
            ? <i key={"b" + c.key} className="l-1 is-blank" style={{ gridRow: c.row + 1, gridColumn: c.col + 1 }} aria-hidden="true" />
            : <i key={c.key} className={`l${c.level}`} style={{ gridRow: c.row + 1, gridColumn: c.col + 1 }} title={`${c.d!.date} · ${fmt(c.d!.inputTokens + c.d!.outputTokens)} tokens · ${c.d!.requests} 次请求`} />)}
        </div>
      </div>
    </div>
  );
}

/** 按小时 Token 趋势：按模型堆叠（与「按模型」排行同色），悬停浮层列出该小时各模型用量。 */
function Trend({ hours, colors }: { hours: api.UsageHour[]; colors: Map<string, string> }) {
  const [tip, setTip] = useState<number | null>(null);
  const hMax = Math.max(1, ...hours.map((h) => h.models.reduce((a, m) => a + hourModelTokens(m), 0)));
  const points = hours.map((h, i) => {
    const denom = h.inputTokens + h.cacheTokens;
    const r = denom > 0 ? h.cacheTokens / denom : null;
    return `${((i + 0.5) / 24) * 1000},${r == null ? 100 : 100 - r * 100}`;
  }).join(" ");
  const tipHour = tip != null && tip >= 0 && tip < hours.length ? hours[tip] : null;
  const tipTotal = tipHour ? tipHour.models.reduce((a, m) => a + hourModelTokens(m), 0) : 0;
  const tipDenom = tipHour ? tipHour.inputTokens + tipHour.cacheTokens : 0;
  const tipHit = tipHour && tipDenom > 0 ? ((tipHour.cacheTokens / tipDenom) * 100).toFixed(1) : null;
  return (
    <>
      <div className="ov-chart-y">{[1, 0.75, 0.5, 0.25, 0].map((v) => <span key={v}>{v === 0 ? "0" : fmt(Math.round(hMax * v))}</span>)}</div>
      <div
        className="ov-chart-plot"
        onMouseMove={(e) => {
          const el = (e.target as HTMLElement).closest(".ov-bar") as HTMLElement | null;
          const i = el ? Number(el.dataset.hour) : NaN;
          setTip(Number.isInteger(i) ? i : null);
        }}
        onMouseLeave={() => setTip(null)}
      >
        <div className="ov-gridlines">{[0, 25, 50, 75, 100].map((v) => <i key={v} style={{ bottom: `${v}%` }} />)}</div>
        <div className="ov-bars">
          {hours.map((h, i) => (
            <div key={i} className="ov-bar" data-hour={i}
              data-tip-total={h.models.reduce((a, m) => a + hourModelTokens(m), 0)}
              data-tip-hit={h.inputTokens + h.cacheTokens > 0 ? ((h.cacheTokens / (h.inputTokens + h.cacheTokens)) * 100).toFixed(1) : ""}>
              {h.models.map((m) => (
                <i key={m.name} data-model={m.name} data-tokens={hourModelTokens(m)}
                  style={{ height: `${(hourModelTokens(m) / hMax) * 100}%`, background: colors.get(m.name) ?? "var(--muted-2)" }} />
              ))}
            </div>
          ))}
        </div>
        <svg className="ov-line" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} /></svg>
        {tipHour && (() => {
          /* 模型多时浮层会顶出绘图区：只列前 TIP_ROWS 个，其余汇总成一行，浮层高度恒定。 */
          const shown = tipHour.models.slice(0, TIP_ROWS);
          const rest = tipHour.models.slice(TIP_ROWS);
          const restTokens = rest.reduce((a, m) => a + hourModelTokens(m), 0);
          return (
            <div className="ov-tip" role="tooltip" style={{ left: `${Math.min(Math.max(((tip! + 0.5) / 24) * 100, 12), 88)}%` }}>
              <div className="ov-tip-h">按小时 · {pad2(tip!)}:00</div>
              <div className="ov-tip-total">总用量：{tipTotal.toLocaleString()}</div>
              {shown.map((m) => (
                <div key={m.name} className="ov-tip-row">
                  <i style={{ background: colors.get(m.name) ?? "var(--muted-2)" }} />
                  <b>{m.name}</b>
                  <span>{hourModelTokens(m).toLocaleString()}</span>
                </div>
              ))}
              {rest.length > 0 && (
                <div className="ov-tip-row ov-tip-rest">
                  <i style={{ background: "var(--muted-2)" }} />
                  <b>其余 {rest.length} 个模型</b>
                  <span>{restTokens.toLocaleString()}</span>
                </div>
              )}
              {tipHit && <div className="ov-tip-hit">缓存命中率：{tipHit}%</div>}
            </div>
          );
        })()}
      </div>
      <div className="ov-chart-x">{[2, 5, 8, 11, 14, 17, 20, 23].map((h) => <span key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>{pad2(h)}:00</span>)}</div>
      <div className="ov-chart-y right">{[100, 75, 50, 25, 0].map((v) => <span key={v}>{v}%</span>)}</div>
    </>
  );
}

/** 按总量降序并附占比。 */
function ranked<T extends { total: number }>(items: T[]): (T & { pct: number })[] {
  const totalSum = items.reduce((a, x) => a + x.total, 0);
  return items
    .slice()
    .sort((a, b) => b.total - a.total)
    .map((x) => ({ ...x, pct: totalSum > 0 ? (x.total / totalSum) * 100 : 0 }));
}

function RankRow({ i, logo, name, total, pct, hit, source, color }: {
  i: number; logo: React.ReactNode; name: string; total: number; pct: number; hit: number | null; source: string; color: string;
}) {
  return (
    <li className="ov-rank-row">
      <span className="ov-rank-n">{i + 1}</span>
      {logo}
      <div className="ov-rank-main">
        <div className="ov-rank-top"><b className="ellipsis">{name}</b><span className="ov-rank-v">{fmt(total)}</span></div>
        <div className="ov-rank-bar"><i style={{ width: `${Math.max(2, pct)}%`, background: color }} /></div>
        <div className="ov-rank-sub">
          <span>{source === "供应商" ? "供应商" : <span className="tag violet">{source}</span>} · {pct.toFixed(1)}%</span>
          <span>缓存命中率 {hit == null ? "未上报" : hit.toFixed(1) + "%"}</span>
        </div>
      </div>
    </li>
  );
}

/** CLI 官方标识（沿用项目既有 CliLogo 组件）。 */
function CliLogo({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Icon name="alert" size={18} />;
  return <img src={`/ui/brand-icons/${id}.svg`} width={18} height={18} alt="" aria-hidden="true" draggable={false} onError={() => setFailed(true)} />;
}
