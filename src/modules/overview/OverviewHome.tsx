import { useEffect, useMemo, useState } from "react";
import * as api from "@/api";
import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui";
import { dayInfo, isoWeek, pad2, sameDay, termOf, ymd } from "./calendar";
import { UsageTab } from "./UsageTab";
import "./overview.css";

/* CR-078 / UI-CR078-v3：概览页 = 日程 / 用量 两个 Tab。
   视觉与交互以 UI-CR078-v3 设计稿为准（docs/UI/workbench-v4/cr078.js）；
   类名前缀 ov-（设计稿为 c078-），结构一致。 */

const EV_COLORS = ["blue", "green", "amber", "violet", "rose"] as const;

/** 月历可视 6 周（含前后月补齐）的起止日期。 */
function monthRange(view: string): { first: Date; weeks: Date[][]; from: string; to: string } {
  const [y, m] = view.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const weeks: Date[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  return { first, weeks, from: ymd(weeks[0][0]), to: ymd(weeks[5][6]) };
}

/** 跨天条带车道布局（同设计稿 layoutWeek）：按周求连续段并分配不重叠车道。 */
function layoutWeek(week: Date[], events: api.ScheduleEvent[]) {
  const lanes: (string | null)[][] = [];
  const segs: { e: api.ScheduleEvent; from: number; to: number; lane: number; head: boolean; tail: boolean }[] = [];
  const weekStart = ymd(week[0]);
  const weekEnd = ymd(week[6]);
  const sorted = events
    .filter((e) => e.endDate >= weekStart && e.startDate <= weekEnd)
    .sort((a, b) => (a.startDate + (a.allDay ? "0" : "1") + a.startTime).localeCompare(b.startDate + (b.allDay ? "0" : "1") + b.startTime));
  for (const e of sorted) {
    const from = e.startDate < weekStart ? 0 : week.findIndex((d) => ymd(d) === e.startDate);
    const to = e.endDate > weekEnd ? 6 : week.findIndex((d) => ymd(d) === e.endDate);
    if (from < 0 || to < 0 || from > to) continue;
    let lane = 0;
    for (;;) {
      if (!lanes[lane]) lanes[lane] = Array(7).fill(null);
      if (lanes[lane].slice(from, to + 1).every((v) => !v)) break;
      lane++;
    }
    for (let i = from; i <= to; i++) lanes[lane][i] = e.id;
    segs.push({ e, from, to, lane, head: ymd(week[from]) === e.startDate, tail: ymd(week[to]) === e.endDate });
  }
  return { lanes: lanes.length, segs };
}

const fmtTokens = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n);

export function OverviewHome() {
  const [tab, setTab] = useState<"schedule" | "usage">("schedule");
  return (
    <div className="pagebody nc-home">
      <div className="nc-page-heading">
        <div>
          <h1>概览</h1>
          <p>日程与全平台用量集中在这里。</p>
        </div>
      </div>
      <div className="ov-tabs" role="tablist" aria-label="概览页签">
        <button className={`ov-tab ${tab === "schedule" ? "active" : ""}`} role="tab" aria-selected={tab === "schedule"} onClick={() => setTab("schedule")}>
          <Icon name="calendar" size={16} />日程
        </button>
        <button className={`ov-tab ${tab === "usage" ? "active" : ""}`} role="tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}>
          <Icon name="tokenUsage" size={16} />用量
        </button>
      </div>
      {tab === "schedule" ? <ScheduleTab /> : <UsageTab />}
    </div>
  );
}

/* ==================== 日程 Tab ==================== */

function WeatherBar() {
  const [wx, setWx] = useState<api.WeatherResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = (refresh = false) => {
    setLoading(true);
    (refresh ? api.weatherRefresh() : api.weatherCurrent())
      .then(setWx)
      .catch(() => setWx({ kind: "unavailable", reason: "读取失败" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []);
  const fmtTime = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  if (loading && !wx) {
    return (
      <div className="ov-day-h ov-weather" role="group" aria-label="当前位置天气">
        <span className="ov-wx-ico is-muted"><Icon name="cloud" size={24} /></span>
        <div className="ov-wx-main"><span className="ov-wx-text is-muted">读取中…</span></div>
      </div>
    );
  }
  if (!wx || wx.kind === "unavailable") {
    return (
      <div className="ov-day-h ov-weather" role="group" aria-label="当前位置天气">
        <span className="ov-wx-ico is-muted"><Icon name="cloud" size={24} /></span>
        <div className="ov-wx-main"><b className="is-dash">—</b><span className="ov-wx-text is-muted">天气不可用</span></div>
        <div className="ov-wx-meta"><span>{wx?.kind === "unavailable" ? "无网络或定位失败" : ""}</span>
          <span className="ov-wx-note"><button className="ov-wx-retry" type="button" onClick={() => load(true)}>重试</button></span></div>
      </div>
    );
  }
  if (wx.kind === "disabled") {
    return (
      <div className="ov-day-h ov-weather" role="group" aria-label="当前位置天气">
        <span className="ov-wx-ico is-muted"><Icon name="cloud" size={24} /></span>
        <div className="ov-wx-main"><b className="is-dash">—</b><span className="ov-wx-text is-muted">天气已关闭</span></div>
        <div className="ov-wx-meta"><span>设置 · 通用 · 天气</span></div>
      </div>
    );
  }
  const w = wx.weather;
  return (
    <div className="ov-day-h ov-weather" role="group" aria-label="当前位置天气" title={w.degraded ?? undefined}>
      <span className={`ov-wx-ico ${w.cached ? "is-muted" : ""}`}><WeatherGlyph code={w.code} /></span>
      <div className="ov-wx-main"><b>{Math.round(w.temp)}°</b><span className="ov-wx-text">{w.text}</span></div>
      <div className="ov-wx-meta">
        <span className="ov-wx-loc"><Icon name="globe" size={12} />{w.city}</span>
        <span>{Math.round(w.low)}° / {Math.round(w.high)}°</span>
        <span className="ov-wx-note">{w.degraded ?? `更新 ${fmtTime(w.updatedAt)}`}</span>
      </div>
    </div>
  );
}

const WX_GLYPH: Record<string, string> = {
  sunny: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6",
  cloudy: "M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 18z",
  overcast: "M6 17h12a3.5 3.5 0 0 0 .3-7 6 6 0 0 0-11.4 1.2A3 3 0 0 0 6 17zM8 20h8",
  rain: "M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 15zM9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5",
  snow: "M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 15zM9 19h.01M13 21h.01M17 19h.01",
  storm: "M7 14h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 14zM13 15l-2 3.5h3l-2 3.5",
};
function WeatherGlyph({ code }: { code: string }) {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={WX_GLYPH[code] ?? WX_GLYPH.cloudy} />
    </svg>
  );
}

function ScheduleTab() {
  const [view, setView] = useState(() => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`; });
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [dayTab, setDayTab] = useState<"events" | "todo">("events");
  const [events, setEvents] = useState<api.ScheduleEvent[]>([]);
  const [todos, setTodos] = useState<api.ScheduleTodo[]>([]);
  const [form, setForm] = useState<{ start: string; end: string } | null>(null);
  const [formErr, setFormErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => monthRange(view), [view]);

  const reload = () => {
    setLoading(true);
    Promise.all([api.scheduleEventList(range.from, range.to), api.scheduleTodoList(selected)])
      .then(([ev, td]) => { setEvents(ev); setTodos(td); setError(null); })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [range.from, range.to, selected]);

  const shift = (months: number) => {
    const [y, m] = view.split("-").map(Number);
    const d = new Date(y, m - 1 + months, 1);
    setView(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  };
  const goToday = () => { const n = new Date(); setView(`${n.getFullYear()}-${pad2(n.getMonth() + 1)}`); setSelected(ymd(n)); };

  const saveEvent = (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const title = String(fd.get("title") ?? "").trim();
    const start = String(fd.get("start") ?? "");
    const end = String(fd.get("end") ?? "");
    const allDay = String(fd.get("allday")) === "1";
    const color = String(fd.get("color") ?? "blue");
    const note = String(fd.get("note") ?? "").trim();
    const startTime = allDay ? "" : String(fd.get("startTime") ?? "");
    const endTime = allDay ? "" : String(fd.get("endTime") ?? "");
    api.scheduleEventSave({ id: `ev_${Date.now()}`, title, startDate: start, endDate: end, allDay, startTime, endTime, note, color, createdAt: 0, updatedAt: 0 })
      .then(() => { setForm(null); setFormErr(""); reload(); })
      .catch((err) => setFormErr(String(err instanceof Error ? err.message : err)));
  };
  const addTodo = (e: React.FormEvent) => {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).querySelector("input");
    const title = (input?.value ?? "").trim();
    if (!title) return;
    api.scheduleTodoSave({ id: `td_${Date.now()}`, date: selected, title, done: false, createdAt: 0, updatedAt: 0 })
      .then(() => { if (input) input.value = ""; reload(); })
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  };
  const toggleTodo = (t: api.ScheduleTodo) => {
    api.scheduleTodoSave({ ...t, done: !t.done }).then(() => reload()).catch(() => {});
  };
  const deleteEvent = (ev: api.ScheduleEvent) => {
    if (!window.confirm(`删除日程「${ev.title}」？此操作不可撤销。`)) return;
    api.scheduleEventDelete(ev.id).then(reload).catch((err) => setError(String(err instanceof Error ? err.message : err)));
  };

  const selDate = new Date(selected + "T00:00:00");
  const selInfo = dayInfo(selDate);
  const eventsOn = events.filter((e) => e.startDate <= selected && selected <= e.endDate);
  const todayKey = ymd(new Date());
  const dayTone = selected === todayKey ? "今天" : selected > todayKey ? "未来" : "过去";

  return (
    <div className="ov-schedule">
      <section className="card ov-cal-card" aria-label="月日历">
        <div className="ov-cal-h">
          <div className="row">
            <button className="btn icon sm" aria-label="上一年" onClick={() => shift(-12)}><Icon name="chevronLeft" size={14} /><Icon name="chevronLeft" size={14} /></button>
            <button className="btn icon sm" aria-label="上月" onClick={() => shift(-1)}><Icon name="chevronLeft" size={14} /></button>
            <b className="ov-cal-title">{range.first.getFullYear()}年{range.first.getMonth() + 1}月</b>
            <button className="btn icon sm" aria-label="下月" onClick={() => shift(1)}><Icon name="chevronRight" size={14} /></button>
            <button className="btn icon sm" aria-label="下一年" onClick={() => shift(12)}><Icon name="chevronRight" size={14} /><Icon name="chevronRight" size={14} /></button>
            <button className="btn sm" onClick={goToday}>本月</button>
          </div>
          <button className="btn primary sm" onClick={() => { setFormErr(""); setForm({ start: selected, end: selected }); }}>
            <Icon name="plus" size={14} />新建日程
          </button>
        </div>
        <div className="ov-cal-grid" role="grid" aria-rowcount={7} aria-colcount={8}>
          <div className="ov-cal-wh" role="columnheader">周</div>
          {["一", "二", "三", "四", "五", "六", "日"].map((w, i) => (
            <div key={w} className={`ov-cal-wh ${i >= 5 ? "weekend" : ""}`} role="columnheader">{w}</div>
          ))}
          {range.weeks.map((week) => {
            const layout = layoutWeek(week, events);
            const maxLane = Math.min(layout.lanes, 2);
            const shown = layout.segs.filter((s) => s.lane < maxLane);
            const hidden = layout.segs.filter((s) => s.lane >= maxLane);
            return (
              <div key={week[0].getTime()} className="ov-cal-row" role="row">
                <div className="ov-cal-wk" role="rowheader">{isoWeek(week[0])}</div>
                {week.map((d, di) => {
                  const k = ymd(d);
                  const info = dayInfo(d);
                  const inMonth = d.getMonth() === range.first.getMonth();
                  const fest = info.festivals[0];
                  const lunarLabel = fest ? fest.name : info.lunar.text;
                  return (
                    <div
                      key={k}
                      className={`ov-cell ${inMonth ? "" : "out"} ${di >= 5 ? "weekend" : ""} ${k === todayKey ? "today" : ""} ${k === selected ? "selected" : ""}`}
                      role="gridcell"
                      tabIndex={0}
                      data-date={k}
                      aria-label={`${k} ${info.lunar.text}${fest ? " " + fest.name : ""}${info.workOff ? (info.workOff === "休" ? " 休息日" : " 调休上班") : ""}`}
                      onClick={() => setSelected(k)}
                      onKeyDown={(e) => { if (e.key === "Enter") setSelected(k); }}
                    >
                      <div className="ov-cell-top">
                        <span className="ov-dnum">{d.getDate()}</span>
                        {info.workOff ? <span className="ov-off">{info.workOff}</span> : null}
                        <span className={`ov-lunar ${fest ? `is-${fest.kind}` : ""}`}>{lunarLabel}</span>
                      </div>
                      <button
                        className="ov-cell-add"
                        aria-label={`在 ${k} 新建日程`}
                        onClick={(e) => { e.stopPropagation(); setFormErr(""); setForm({ start: k, end: k }); }}
                      ><Icon name="plus" size={12} /></button>
                    </div>
                  );
                })}
                <div className="ov-week-lanes" aria-hidden="true">
                  {shown.map((s) => (
                    <span
                      key={s.e.id + s.from}
                      className={`ov-band c-${s.e.color} ${s.head ? "head" : ""} ${s.tail ? "tail" : ""}`}
                      style={{ ["--from" as string]: String(s.from), ["--span" as string]: String(s.to - s.from + 1), ["--lane" as string]: String(s.lane) }}
                      title={`${s.e.title} · ${s.e.startDate}${s.e.startDate !== s.e.endDate ? " 至 " + s.e.endDate : ""}`}
                    >
                      {s.head || s.to - s.from < 2 ? s.e.title : ""}
                    </span>
                  ))}
                </div>
                {hidden.length > 0 && (
                  <span className="ov-week-more" data-count={hidden.length} onClick={() => { setSelected(ymd(week[0])); setDayTab("events"); }}>
                    +{hidden.length} 条在详情
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <aside className="card ov-day" aria-label="日期详情">
        <WeatherBar />
        <div className="ov-day-b">
          <div className="ov-day-title"><h3>{selected}</h3><span className="tag blue">{dayTone}</span></div>
          <div className="ov-almanac">
            <div className="ov-alm-row"><span>农历</span><b>{selInfo.lunar.leap ? "闰" : ""}{["正","二","三","四","五","六","七","八","九","十","十一","十二"][selInfo.lunar.lm - 1]}月{["初一","初二","初三","初四","初五","初六","初七","初八","初九","初十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十","廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十"][selInfo.lunar.ld - 1]}</b></div>
            <div className="ov-alm-row"><span>干支</span><b>{selInfo.gz.year}年 {selInfo.gz.month}月 {selInfo.gz.day}日</b></div>
            <div className="ov-alm-row"><span>生肖</span><b>{selInfo.gz.zodiac}</b></div>
            <div className="ov-alm-row"><span>值日</span><b>{selInfo.gz.value}日</b></div>
            {selInfo.festivals.length > 0 && (
              <div className="ov-alm-row"><span>节日</span><b>{selInfo.festivals.map((f) => <span key={f.name} className={`ov-fest is-${f.kind}`}>{f.name}</span>)}</b></div>
            )}
            {selInfo.workOff && <div className="ov-alm-row"><span>调休</span><b><span className="ov-off">{selInfo.workOff}</span></b></div>}
            <div className="ov-alm-yj">
              <div><span>宜</span><p>{selInfo.good || "—"}</p></div>
              <div><span>忌</span><p>{selInfo.bad || "—"}</p></div>
            </div>
          </div>
          <div className="ov-day-tabs" role="tablist" aria-label="当天事项">
            <button className={`ov-day-tab ${dayTab === "events" ? "active" : ""}`} role="tab" aria-selected={dayTab === "events"} onClick={() => setDayTab("events")}>
              <Icon name="calendar" size={14} />日程 <span>{eventsOn.length}</span>
            </button>
            <button className={`ov-day-tab ${dayTab === "todo" ? "active" : ""}`} role="tab" aria-selected={dayTab === "todo"} onClick={() => setDayTab("todo")}>
              <Icon name="check" size={14} />待办 <span>{todos.filter((t) => !t.done).length}</span>
            </button>
            {dayTab === "events" && (
              <button className="btn xs ov-day-add" onClick={() => { setFormErr(""); setForm({ start: selected, end: selected }); }}>
                <Icon name="plus" size={12} />新增
              </button>
            )}
          </div>
          {error && <div className="nc-error" role="alert">{error}</div>}
          {dayTab === "events" ? (
            <div className="ov-day-list">
              {eventsOn.length === 0
                ? <Empty title={loading ? "加载中…" : "这一天没有日程"} />
                : eventsOn.map((e) => (
                  <div key={e.id} className={`ov-ev c-${e.color}`}>
                    <span className="ov-ev-dot" />
                    <span className="ov-ev-main">
                      <b>{e.title}</b>
                      <small>{e.allDay ? "全天" : `${e.startTime} – ${e.endTime}`}{e.startDate !== e.endDate ? ` · ${e.startDate} 至 ${e.endDate}` : ""}{e.note ? ` · ${e.note}` : ""}</small>
                    </span>
                    <button className="ov-ev-del" aria-label={`删除日程 ${e.title}`} onClick={() => deleteEvent(e)}><Icon name="trash" size={12} /></button>
                  </div>
                ))}
            </div>
          ) : (
            <div className="ov-day-panel">
              <div className="ov-day-list">
                {todos.length === 0
                  ? <Empty title={loading ? "加载中…" : "没有待办"} />
                  : todos.map((t) => (
                    <label key={t.id} className={`ov-todo ${t.done ? "done" : ""}`}>
                      <input type="checkbox" checked={t.done} onChange={() => toggleTodo(t)} />
                      <span>{t.title}</span>
                    </label>
                  ))}
              </div>
              <form className="ov-todo-new" onSubmit={addTodo}>
                <input className="input" maxLength={80} placeholder="新增待办，回车保存" aria-label="新增待办" />
                <button className="btn sm" type="submit"><Icon name="plus" size={12} /></button>
              </form>
            </div>
          )}
        </div>
      </aside>

      {form && (
        <div className="ov-form-mask" onClick={() => setForm(null)}>
          <div className="ov-form card" role="dialog" aria-modal="true" aria-label="新建日程" onClick={(e) => e.stopPropagation()}>
            <div className="card-h"><h3>新建日程</h3><button className="btn icon sm" aria-label="关闭" onClick={() => setForm(null)}><Icon name="close" size={14} /></button></div>
            <form className="ov-form-b" onSubmit={saveEvent}>
              <label className="ov-f-row"><span>标题</span><input className="input" name="title" maxLength={80} required autoFocus placeholder="日程标题" /></label>
              <div className="ov-f-row"><span>日期</span>
                <div className="row">
                  <input className="input" name="start" type="date" defaultValue={form.start} required />
                  <span className="muted">至</span>
                  <input className="input" name="end" type="date" defaultValue={form.end} required />
                </div>
              </div>
              <div className="ov-f-row"><span>时间</span>
                <div className="row wrap">
                  <label className="ov-radio"><input type="radio" name="allday" value="1" defaultChecked />全天</label>
                  <label className="ov-radio"><input type="radio" name="allday" value="0" />具体时间</label>
                  <TimeInputs />
                </div>
              </div>
              <div className="ov-f-row"><span>颜色</span>
                <div className="ov-swatches" role="radiogroup" aria-label="颜色">
                  {EV_COLORS.map((c, i) => (
                    <label key={c} className={`ov-sw c-${c}`} title={c}>
                      <input type="radio" name="color" value={c} defaultChecked={i === 0} /><i />
                    </label>
                  ))}
                </div>
              </div>
              <label className="ov-f-row"><span>备注</span><textarea className="input textarea" name="note" rows={2} maxLength={200} placeholder="可选" /></label>
              {formErr && <p className="ov-form-err" role="alert">{formErr}</p>}
              <div className="row between">
                <span className="caption">保存后立即出现在月历</span>
                <span className="row">
                  <button className="btn" type="button" onClick={() => setForm(null)}>取消</button>
                  <button className="btn primary" type="submit"><Icon name="check" size={14} />保存</button>
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/** 具体时间输入：随「全天 / 具体时间」单选启用。 */
function TimeInputs() {
  const [allDay, setAllDay] = useState(true);
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      if (e.target instanceof HTMLInputElement && e.target.name === "allday") setAllDay(v === "1");
    };
    document.addEventListener("change", handler);
    return () => document.removeEventListener("change", handler);
  }, []);
  return (
    <>
      <input className="input ov-time" name="startTime" type="time" defaultValue="09:00" disabled={allDay} />
      <span className="muted">–</span>
      <input className="input ov-time" name="endTime" type="time" defaultValue="10:00" disabled={allDay} />
    </>
  );
}

void sameDay;
void termOf;
void pad2;
