import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui";
import { dayInfo, isoWeek, pad2, sameDay, termOf, ymd } from "./calendar";
import { UsageTab } from "./UsageTab";
import "./overview.css";

/* CR-078 / UI-CR078-v8：概览页 = 日程 / 用量 两个 Tab。
   视觉与交互以 UI-CR078-v8 设计稿为准（docs/UI/workbench-v4/cr078.js）；
   类名前缀 ov-（设计稿为 c078-），结构一致。v8：移除天气与右侧日程新建，
   日期详情改为参考图头部（竖排宜忌 + 大号公历日/农历/干支），选中描边独立覆盖日程条带。 */

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

const LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const LUNAR_DAYS = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];

function almTerms(v: string): string[] { return (v || "—").split(/[、\s]+/).filter(Boolean); }

function ScheduleTab() {
  const [view, setView] = useState(() => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`; });
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [dayTab, setDayTab] = useState<"events" | "todo">("events");
  const [events, setEvents] = useState<api.ScheduleEvent[]>([]);
  const [todos, setTodos] = useState<api.ScheduleTodo[]>([]);
  const [form, setForm] = useState<{
    id?: string; start: string; end: string; title?: string; allDay?: boolean;
    startTime?: string; endTime?: string; color?: string; note?: string;
  } | null>(null);
  const [formErr, setFormErr] = useState("");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const todoCancelRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pickerOpen]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => monthRange(view), [view]);

  /* v6：新建与编辑共用同一弹窗；编辑时回填原日程并以同一 id 保存（后端 save_event 按 id upsert）。 */
  const openNew = (start: string, end: string = start) => { setFormErr(""); setForm({ start, end }); };
  const openEdit = (e: api.ScheduleEvent) => {
    setFormErr("");
    setForm({ id: e.id, start: e.startDate, end: e.endDate, title: e.title, allDay: e.allDay, startTime: e.startTime, endTime: e.endTime, color: e.color, note: e.note });
  };

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
    api.scheduleEventSave({ id: form?.id ?? `ev_${Date.now()}`, title, startDate: start, endDate: end, allDay, startTime, endTime, note, color, createdAt: 0, updatedAt: 0 })
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
  /* v6：待办行内编辑（Enter / 失焦保存，Esc 取消；空值不覆盖）。 */
  const beginEditTodo = (id: string) => { todoCancelRef.current = false; setEditingTodoId(id); };
  const commitTodo = (t: api.ScheduleTodo, title: string) => {
    setEditingTodoId(null);
    if (todoCancelRef.current) { todoCancelRef.current = false; return; }
    const v = title.trim();
    if (!v || v === t.title) return;
    api.scheduleTodoSave({ ...t, title: v }).then(() => reload()).catch((err) => setError(String(err instanceof Error ? err.message : err)));
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
          <div className="ov-cal-nav">
            <button className="ov-nav-btn" aria-label="上一年" title="上一年" onClick={() => shift(-12)}>«</button>
            <button className="ov-nav-btn" aria-label="上月" title="上月" onClick={() => shift(-1)}>‹</button>
            <button className={`ov-cal-title ${pickerOpen ? "open" : ""}`} aria-haspopup="true" aria-expanded={pickerOpen} onClick={() => { setPickerYear(range.first.getFullYear()); setPickerOpen((v) => !v); }}>
              {range.first.getFullYear()}年{range.first.getMonth() + 1}月
            </button>
            <button className="ov-nav-btn" aria-label="下月" title="下月" onClick={() => shift(1)}>›</button>
            <button className="ov-nav-btn" aria-label="下一年" title="下一年" onClick={() => shift(12)}>»</button>
            <button className="btn sm ov-today-btn" onClick={() => { setPickerOpen(false); goToday(); }}>今天</button>
          </div>
          <button className="btn primary sm" onClick={() => openNew(selected)}>
            <Icon name="plus" size={14} />新建日程
          </button>
          {pickerOpen && (
            <>
              <div className="ov-picker-mask" onClick={() => setPickerOpen(false)} />
              <div className="ov-picker" role="dialog" aria-label="选择年月">
                <div className="ov-picker-h">
                  <button className="ov-nav-btn" aria-label="上一年" onClick={() => setPickerYear((y) => y - 1)}>‹</button>
                  <b>{pickerYear}年</b>
                  <button className="ov-nav-btn" aria-label="下一年" onClick={() => setPickerYear((y) => y + 1)}>›</button>
                </div>
                <div className="ov-picker-grid">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((mm) => {
                    const now = new Date();
                    const active = pickerYear === range.first.getFullYear() && mm === range.first.getMonth() + 1;
                    const current = pickerYear === now.getFullYear() && mm === now.getMonth() + 1;
                    return (
                      <button key={mm} className={active ? "is-active" : current ? "is-current" : ""} onClick={() => { setView(`${pickerYear}-${pad2(mm)}`); setPickerOpen(false); }}>
                        {mm}月
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
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
                        onClick={(e) => { e.stopPropagation(); openNew(k); }}
                      ><Icon name="plus" size={12} /></button>
                    </div>
                  );
                })}
                <div className="ov-week-lanes">
                  {shown.map((s) => (
                    <span
                      key={s.e.id + s.from}
                      className={`ov-band c-${s.e.color} ${s.head ? "head" : ""} ${s.tail ? "tail" : ""}`}
                      style={{ ["--from" as string]: String(s.from), ["--span" as string]: String(s.to - s.from + 1), ["--lane" as string]: String(s.lane) }}
                      title={`${s.e.title} · ${s.e.startDate}${s.e.startDate !== s.e.endDate ? " 至 " + s.e.endDate : ""}（点击编辑）`}
                      role="button"
                      tabIndex={0}
                      onClick={() => { const ev = events.find((x) => x.id === s.e.id); if (ev) openEdit(ev); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { const ev = events.find((x) => x.id === s.e.id); if (ev) openEdit(ev); } }}
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
        <div className="ov-day-b">
          <div className="ov-date-header" aria-label="所选日期黄历">
            <div className="ov-alm-yj">
              <div><span>宜</span><p title={selInfo.good || "—"}>{almTerms(selInfo.good).map((t, i) => <i key={i}>{t}</i>)}</p></div>
              <div><span>忌</span><p title={selInfo.bad || "—"}>{almTerms(selInfo.bad).map((t, i) => <i key={i}>{t}</i>)}</p></div>
            </div>
            <div className="ov-date-main">
              <span className="ov-date-number">{selDate.getDate()}</span>
              <b className="ov-date-lunar">{selInfo.lunar.leap ? "闰" : ""}{LUNAR_MONTHS[selInfo.lunar.lm - 1]}月{LUNAR_DAYS[selInfo.lunar.ld - 1]}</b>
              <span className="ov-date-cycle">{selInfo.gz.year}{selInfo.gz.zodiac}年 {selInfo.gz.month}月 {selInfo.gz.day}日</span>
            </div>
          </div>
          <div className="ov-date-notes"><time dateTime={selected}>{selected}</time><span className="tag blue">{dayTone}</span><span>{selInfo.gz.value}日</span>{selInfo.festivals.map((f, i) => <span key={i} className={`ov-fest is-${f.kind}`}>{f.name}</span>)}{selInfo.workOff && <span className="ov-off">{selInfo.workOff}</span>}</div>
          <div className="ov-day-tabs" role="tablist" aria-label="当天事项">
            <button className={`ov-day-tab ${dayTab === "events" ? "active" : ""}`} role="tab" aria-selected={dayTab === "events"} onClick={() => setDayTab("events")}>
              <Icon name="calendar" size={14} />日程 <span>{eventsOn.length}</span>
            </button>
            <button className={`ov-day-tab ${dayTab === "todo" ? "active" : ""}`} role="tab" aria-selected={dayTab === "todo"} onClick={() => setDayTab("todo")}>
              <Icon name="check" size={14} />待办 <span>{todos.filter((t) => !t.done).length}</span>
            </button>
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
                    <button className="ov-ev-edit" aria-label={`编辑日程 ${e.title}`} onClick={() => openEdit(e)}><Icon name="edit" size={12} /></button>
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
                    <div key={t.id} className={`ov-todo ${t.done ? "done" : ""}`}>
                      <input type="checkbox" checked={t.done} onChange={() => toggleTodo(t)} />
                      {editingTodoId === t.id ? (
                        <input
                          className="input ov-todo-edit"
                          autoFocus
                          defaultValue={t.title}
                          maxLength={80}
                          aria-label="编辑待办"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                            else if (e.key === "Escape") { todoCancelRef.current = true; e.currentTarget.blur(); }
                          }}
                          onBlur={(e) => commitTodo(t, e.target.value)}
                        />
                      ) : (
                        <>
                          <span className="ov-todo-text">{t.title}</span>
                          <button className="ov-todo-edit-btn" aria-label={`编辑待办 ${t.title}`} onClick={() => beginEditTodo(t.id)}><Icon name="edit" size={12} /></button>
                        </>
                      )}
                    </div>
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
          <div className="ov-form card" role="dialog" aria-modal="true" aria-label={form.id ? "编辑日程" : "新建日程"} onClick={(e) => e.stopPropagation()}>
            <div className="card-h"><h3>{form.id ? "编辑日程" : "新建日程"}</h3><button className="btn icon sm" aria-label="关闭" onClick={() => setForm(null)}><Icon name="close" size={14} /></button></div>
            <form className="ov-form-b" onSubmit={saveEvent}>
              <label className="ov-f-row"><span>标题</span><input className="input" name="title" maxLength={80} required autoFocus defaultValue={form.title ?? ""} placeholder="日程标题" /></label>
              <div className="ov-f-row"><span>日期</span>
                <div className="row">
                  <input className="input" name="start" type="date" defaultValue={form.start} required />
                  <span className="muted">至</span>
                  <input className="input" name="end" type="date" defaultValue={form.end} required />
                </div>
              </div>
              <div className="ov-f-row"><span>时间</span>
                <div className="row wrap">
                  <label className="ov-radio"><input type="radio" name="allday" value="1" defaultChecked={form.allDay !== false} />全天</label>
                  <label className="ov-radio"><input type="radio" name="allday" value="0" defaultChecked={form.allDay === false} />具体时间</label>
                  <TimeInputs allDay={form.allDay !== false} startTime={form.startTime} endTime={form.endTime} />
                </div>
              </div>
              <div className="ov-f-row"><span>颜色</span>
                <div className="ov-swatches" role="radiogroup" aria-label="颜色">
                  {EV_COLORS.map((c, i) => (
                    <label key={c} className={`ov-sw c-${c}`} title={c}>
                      <input type="radio" name="color" value={c} defaultChecked={form.color ? c === form.color : i === 0} /><i />
                    </label>
                  ))}
                </div>
              </div>
              <label className="ov-f-row"><span>备注</span><textarea className="input textarea" name="note" rows={2} maxLength={200} defaultValue={form.note ?? ""} placeholder="可选" /></label>
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

/** 具体时间输入：随「全天 / 具体时间」单选启用；编辑时回填原时间。 */
function TimeInputs({ allDay: initialAllDay = true, startTime, endTime }: { allDay?: boolean; startTime?: string; endTime?: string }) {
  const [allDay, setAllDay] = useState(initialAllDay);
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
      <input className="input ov-time" name="startTime" type="time" defaultValue={startTime || "09:00"} disabled={allDay} />
      <span className="muted">–</span>
      <input className="input ov-time" name="endTime" type="time" defaultValue={endTime || "10:00"} disabled={allDay} />
    </>
  );
}

void sameDay;
void termOf;
void pad2;
