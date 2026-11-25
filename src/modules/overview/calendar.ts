// CR-078：概览页本地日历算法（农历 / 节气 / 干支 / 黄历）。
// 算法照设计稿 docs/UI/workbench-v4/cr078.js（UI-CR078-v3），经 2025–2027 节气与权威日历核对；
// 15 项关键日期断言见 docs/Test/REPORT-CR078。不联网：农历信息表 1900–2100，调休内置 2025–2027。

/* ==================== 农历 ==================== */

// 农历信息表：1900–2100。低 4 位闰月月份（0 无闰），bit4–15 大小月（从正月起），bit16 闰月大小。
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0bca4, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570,
  0x052f2, 0x04970, 0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0,
  0x1c8d7, 0x0c950, 0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2,
  0x0a950,
];

const LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const LUNAR_DAYS = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];

function lYearDays(y: number): number {
  let s = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) s += LUNAR_INFO[y - 1900] & i ? 1 : 0;
  return s + lLeapDays(y);
}
function lLeapMonth(y: number): number {
  return LUNAR_INFO[y - 1900] & 0xf;
}
function lLeapDays(y: number): number {
  return lLeapMonth(y) ? (LUNAR_INFO[y - 1900] & 0x10000 ? 30 : 29) : 0;
}
function lMonthDays(y: number, m: number): number {
  return LUNAR_INFO[y - 1900] & (0x10000 >> m) ? 30 : 29;
}

export interface LunarDate {
  ly: number;
  lm: number;
  leap: boolean;
  ld: number;
  /** 初一显示月名（闰月带「闰」），其余日名；除夕（次日为另一农历年正月初一）优先。 */
  text: string;
}

export function lunarOf(date: Date): LunarDate {
  const base = Date.UTC(1900, 0, 31);
  const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let offset = Math.floor((target - base) / 86400000);
  let ly = 1900;
  for (; ly < 2101 && offset > 0; ly++) offset -= lYearDays(ly);
  if (offset < 0) {
    offset += lYearDays(--ly);
  }
  const leap = lLeapMonth(ly);
  let isLeap = false;
  let lm = 1;
  for (; lm < 13 && offset > 0; lm++) {
    if (leap > 0 && lm === leap + 1 && !isLeap) {
      --lm;
      isLeap = true;
      const d = lLeapDays(ly);
      if (offset < d) break;
      offset -= d;
      isLeap = false;
    } else {
      const d = lMonthDays(ly, lm);
      if (offset < d) break;
      offset -= d;
    }
  }
  if (leap > 0 && lm === leap + 1 && !isLeap) isLeap = true;
  const ld = offset + 1;
  // 除夕：农历十二月的最后一天（腊月廿九或三十）。闰月不影响——闰腊月极罕见且表内 1900–2100 无闰腊月。
  const isLastDay = ld === lMonthDays(ly, lm);
  const eve = !isLeap && lm === 12 && isLastDay;
  const text = eve ? "除夕" : ld === 1 ? (isLeap ? "闰" : "") + LUNAR_MONTHS[lm - 1] + "月" : LUNAR_DAYS[ld - 1];
  return { ly, lm, leap: isLeap, ld, text };
}

/* ==================== 二十四节气 ==================== */

// 顺序按黄经 k=0..23（春分=0°）。
const TERM_NAMES = ["春分", "清明", "谷雨", "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑", "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒", "立春", "雨水", "惊蛰"];

/** 太阳视黄经（Meeus 低阶近似，精度约 0.01°）。采样北京时间当日 12:00。 */
function sunLongitude(date: Date): number {
  const jd = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000) + 4 / 24 + 2440588;
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  const M = ((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360) * Math.PI / 180;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * Math.PI / 180;
  return (((L0 + C) - 0.00569 - 0.00478 * Math.sin(omega)) % 360 + 360) % 360;
}

/** 黄经达到 k×15° 的公历日期；从某年 3/8（惊蛰之后、春分之前）起搜 13 个月，
 *  这样 k=19..23（小寒…惊蛰）传入上一年时不会先命中上一年 3 月初自己的那次，而当年春分（3/20 前后）仍可命中。 */
function termDate(y: number, k: number): Date | null {
  const target = k * 15;
  const d = new Date(Date.UTC(y, 2, 8));
  const end = new Date(Date.UTC(y + 1, 3, 20));
  let diff = ((sunLongitude(d) - target + 540) % 360) - 180;
  while (d <= end) {
    const cur = ((sunLongitude(d) - target + 540) % 360) - 180;
    if (diff < 0 && cur >= 0) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    diff = cur;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

const TERM_CACHE = new Map<number, { name: string; d: Date }[]>();

/** 公历 y 年内发生的 24 个节气（按日期升序，按年缓存）。小寒…惊蛰（k=19..23）从上一年起搜。 */
export function termDatesOfYear(y: number): { name: string; d: Date }[] {
  let out = TERM_CACHE.get(y);
  if (!out) {
    out = [];
    for (let k = 0; k < 24; k++) {
      const d = termDate(k >= 19 ? y - 1 : y, k);
      if (d && d.getFullYear() === y) out.push({ name: TERM_NAMES[k], d });
    }
    out.sort((a, b) => a.d.getTime() - b.d.getTime());
    TERM_CACHE.set(y, out);
  }
  return out;
}

export function solarTermDate(y: number, name: string): Date | undefined {
  return termDatesOfYear(y).find((t) => t.name === name)?.d;
}

/** 公历日期对应节气（节气日当天返回名称），否则 null。 */
export function termOf(date: Date): string | null {
  for (const t of termDatesOfYear(date.getFullYear())) {
    if (sameDay(t.d, date)) return t.name;
  }
  return null;
}

/* ==================== 干支 / 黄历 ==================== */

const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const ZODIAC = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

export interface Ganzhi {
  year: string;
  month: string;
  day: string;
  zodiac: string;
  /** 十二值日（建除满平定执破危成收开闭）。 */
  value: string;
}

/** 年柱以立春为界；月柱按节气：立春起每两个节气（节 + 中）为一月支，
 *  寅月=立春~惊蛰前、卯月=惊蛰~清明前……按「最近一个已过的节（奇数位：立春/惊蛰/清明…）」定支，
 *  月干按五虎遁（年干起正月）。日柱按儒略日连续推算（2000-01-01 甲辰）。 */
export function ganzhi(date: Date): Ganzhi {
  const y = date.getFullYear();
  const lichun = solarTermDate(y, "立春") ?? new Date(y, 1, 4);
  const gzYear = date >= lichun ? y : y - 1;
  const sy = STEMS[((gzYear - 4) % 10 + 10) % 10];
  const by = BRANCHES[((gzYear - 4) % 12 + 12) % 12];
  const zodiac = ZODIAC[((gzYear - 4) % 12 + 12) % 12];
  // 12 个「节」（月首）：立春 惊蛰 清明 立夏 芒种 小暑 立秋 白露 寒露 立冬 大雪 小寒
  const JIE = ["立春", "惊蛰", "清明", "立夏", "芒种", "小暑", "立秋", "白露", "寒露", "立冬", "大雪", "小寒"];
  // 最近一个已过的节：跨年时（如 1 月的小寒属上年周期）在当年与上一年表中按日期取最大。
  let jie = -1;
  let jieDate = 0;
  for (const yy of [y - 1, y]) {
    for (const name of JIE) {
      const d = solarTermDate(yy, name);
      if (d && d <= date) {
        const t = d.getTime();
        if (t > jieDate) {
          jieDate = t;
          jie = JIE.indexOf(name);
        }
      }
    }
  }
  if (jie < 0) jie = 11; // 兜底：立春前 → 上年丑月之后（实际被上面循环覆盖）
  const monthBranch = (jie + 2) % 12; // 立春(0)→寅(2)，惊蛰(1)→卯(3)…
  // 五虎遁：寅月干序 = (年干序*2 + 2) % 10（甲己之年丙作首）；月序 k 从寅起数，干随 k 线性递增。
  const monthK = jie; // jie 即以立春为 0 的月序
  const monthStemIdx = (((((gzYear - 4) % 5) + 5) % 5) * 2 + 2 + monthK) % 10;
  const sm = STEMS[monthStemIdx];
  const bm = BRANCHES[monthBranch];
  const jd = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000) + 2440588;
  const dIdx = (((jd + 50) % 60) + 60) % 60;
  const sd = STEMS[dIdx % 10];
  const bd = BRANCHES[dIdx % 12];
  const value = "建除满平定执破危成收开闭"[dIdx % 12];
  return { year: sy + by, month: sm + bm, day: sd + bd, zodiac, value };
}

/* ==================== 节日 / 调休 ==================== */

const FIXED_FESTIVALS: Record<string, string> = {
  "1-1": "元旦", "3-8": "妇女节", "5-1": "劳动节", "5-4": "青年节",
  "6-1": "儿童节", "8-1": "建军节", "9-10": "教师节", "10-1": "国庆节",
};
const LUNAR_FESTIVALS: Record<string, string> = {
  "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节", "7-7": "七夕节",
  "7-15": "中元节", "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节", "12-23": "小年",
};
const LEGAL = new Set(["元旦", "春节", "清明节", "劳动节", "端午节", "中秋节", "国庆节"]);

export type FestivalKind = "legal" | "tradition" | "term";
export interface Festival {
  name: string;
  kind: FestivalKind;
}

/** 调休（国务院安排，内置 2025–2027；值「休」或「班」）。其他年份不显示。 */
const WORK_OFF: Record<string, "休" | "班"> = {
  "2025-01-01": "休",
  "2025-01-28": "休", "2025-01-29": "休", "2025-01-30": "休", "2025-01-31": "休",
  "2025-02-01": "休", "2025-02-02": "休", "2025-02-03": "休", "2025-02-04": "休",
  "2025-01-26": "班", "2025-02-08": "班",
  "2025-04-04": "休", "2025-04-05": "休", "2025-04-06": "休",
  "2025-05-01": "休", "2025-05-02": "休", "2025-05-03": "休", "2025-05-04": "休", "2025-05-05": "休", "2025-04-27": "班",
  "2025-10-01": "休", "2025-10-02": "休", "2025-10-03": "休", "2025-10-04": "休",
  "2025-10-05": "休", "2025-10-06": "休", "2025-10-07": "休", "2025-10-08": "休",
  "2025-09-28": "班", "2025-10-11": "班",
  "2026-01-01": "休", "2026-01-02": "休", "2026-01-03": "休",
  "2026-02-15": "休", "2026-02-16": "休", "2026-02-17": "休", "2026-02-18": "休",
  "2026-02-19": "休", "2026-02-20": "休", "2026-02-21": "休", "2026-02-22": "休", "2026-02-28": "班",
  "2026-04-04": "休", "2026-04-05": "休", "2026-04-06": "休",
  "2026-05-01": "休", "2026-05-02": "休", "2026-05-03": "休", "2026-05-04": "休", "2026-05-05": "休", "2026-05-09": "班",
  "2026-06-19": "休", "2026-06-20": "休", "2026-06-21": "休",
  "2026-09-25": "休", "2026-09-26": "休", "2026-09-27": "休",
  "2026-10-01": "休", "2026-10-02": "休", "2026-10-03": "休", "2026-10-04": "休",
  "2026-10-05": "休", "2026-10-06": "休", "2026-10-07": "休", "2026-10-08": "休", "2026-10-10": "班",
  "2027-01-01": "休", "2027-01-02": "休", "2027-01-03": "休",
};

export function workOffOf(date: Date): "休" | "班" | null {
  return WORK_OFF[ymd(date)] ?? null;
}

export function festivalsOf(date: Date): Festival[] {
  const lunar = lunarOf(date);
  const list: Festival[] = [];
  const key = `${date.getMonth() + 1}-${date.getDate()}`;
  if (FIXED_FESTIVALS[key]) list.push({ name: FIXED_FESTIVALS[key], kind: LEGAL.has(FIXED_FESTIVALS[key]) ? "legal" : "tradition" });
  const lk = `${lunar.lm}-${lunar.ld}`;
  if (!lunar.leap && LUNAR_FESTIVALS[lk]) list.push({ name: LUNAR_FESTIVALS[lk], kind: LEGAL.has(LUNAR_FESTIVALS[lk]) ? "legal" : "tradition" });
  if (lunar.text === "除夕") list.push({ name: "除夕", kind: "tradition" });
  const term = termOf(date);
  if (term === "清明") list.push({ name: "清明节", kind: "legal" });
  else if (term) list.push({ name: term, kind: "term" });
  const order: Record<FestivalKind, number> = { legal: 0, tradition: 1, term: 2 };
  return list.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** 十二值日宜忌（传统通书口诀，近似规则；界面不声称权威）。 */
const VALUE_GOOD_BAD: Record<string, { good: string; bad: string }> = {
  建: { good: "出行、上任、会友", bad: "动土、开仓、嫁娶" },
  除: { good: "扫舍、祭祀、除服、疗病", bad: "嫁娶、出行、赴任" },
  满: { good: "祈福、祭祀、结亲、开市", bad: "服药、栽种、下葬、求医" },
  平: { good: "修饰垣墙、平治道涂", bad: "嫁娶、开市、动土" },
  定: { good: "祭祀、祈福、嫁娶、宴请、协议", bad: "诉讼、出行、搬迁" },
  执: { good: "造屋、结网、捕捉、纳财", bad: "搬迁、出行、开市" },
  破: { good: "破屋坏垣、求医治病", bad: "嫁娶、签约、出行、动土" },
  危: { good: "祭祀、安床、纳财", bad: "登高、行船、出行" },
  成: { good: "开业、入学、嫁娶、签约、上任", bad: "诉讼" },
  收: { good: "纳财、开市、交易、立契", bad: "出行、安葬" },
  开: { good: "开业、结婚、入宅、出行、求医", bad: "安葬、动土" },
  闭: { good: "安葬、填塞、筑堤", bad: "开市、出行、嫁娶、手术" },
};

export interface DayInfo {
  lunar: LunarDate;
  gz: Ganzhi;
  festivals: Festival[];
  workOff: "休" | "班" | null;
  good: string;
  bad: string;
}

export function dayInfo(date: Date): DayInfo {
  const lunar = lunarOf(date);
  const gz = ganzhi(date);
  return {
    lunar,
    gz,
    festivals: festivalsOf(date),
    workOff: workOffOf(date),
    good: VALUE_GOOD_BAD[gz.value]?.good ?? "",
    bad: VALUE_GOOD_BAD[gz.value]?.bad ?? "",
  };
}

/* ==================== 工具 ==================== */

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** ISO 周号（周一为一周开始）。 */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}
