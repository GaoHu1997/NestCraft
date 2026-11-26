/* CR-078：主菜单「工作台」更名「概览」，首页重建为「日程 / 用量」两个 Tab（仅设计资源）。
   - 覆盖式接管 Screens.home("workbench")，其余首页（项目 / 知识库 / 服务器）与项目内「工作台」页签（CR-054）不动。
   - 农历 / 节气 / 干支 / 黄历为本地内置表与近似算法，不联网；调休只内置 2025–2027。
   - 用量为合成夹具：三类来源（CLI / 平台主代理 / 子智能体），与既有 AI 侧栏统计同源风格，不代表真实落库数据。
   - 不接真实业务：日程与待办只在内存演示，刷新重置。滚动遵守 UI-SCROLL-001，不新增常显滚动条。 */
window.CR078 = (() => {
  "use strict";
  const { esc, icon, store, toast, openDialog, closeDialog, dlgShell, cliLogo, D } = UI;

  /* ==================== 日期与农历 ==================== */
  /* 农历信息表：1900–2100。每年一个数：低 4 位闰月月份（0 为无闰），中间 12 位为大小月（1=30 天），高 4 位（第 17–20 位）为春节所在公历日。
     压缩格式（常用）：year -> LunarInfo；bit0–3 闰月，bit4–15 大小月（从正月起），bit16–19 春节日（公历 1 月或 2 月，bit15=1 表示 2 月）。 */
  const LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900–1909
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910–1919
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920–1929
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930–1939
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940–1949
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950–1959
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960–1969
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970–1979
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980–1989
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990–1999
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000–2009
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010–2019
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020–2029
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030–2039
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040–2049
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050–2059
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060–2069
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0bca4, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, // 2070–2079
    0x052f2, 0x04970, 0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, // 2080–2089
    0x1c8d7, 0x0c950, 0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, // 2090–2099
    0x0a950
  ];
  const LUNAR_MONTHS = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  const LUNAR_DAYS = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
  const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
  const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
  const ZODIAC = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  function lYearDays(y) { let s = 348; for (let i = 0x8000; i > 0x8; i >>= 1) s += LUNAR_INFO[y - 1900] & i ? 1 : 0; return s + lLeapDays(y); }
  function lLeapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
  function lLeapDays(y) { return lLeapMonth(y) ? LUNAR_INFO[y - 1900] & 0x10000 ? 30 : 29 : 0; }
  function lMonthDays(y, m) { return LUNAR_INFO[y - 1900] & (0x10000 >> m) ? 30 : 29; }

  /** 公历 → 农历核心（不含除夕判断）。返回 { ly, lm(1–12), leap, ld }。 */
  function lunarOf(date) {
    const base = Date.UTC(1900, 0, 31);
    const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    let offset = Math.floor((target - base) / 86400000);
    let ly = 1900;
    for (; ly < 2101 && offset > 0; ly++) offset -= lYearDays(ly);
    if (offset < 0) { offset += lYearDays(--ly); }
    const leap = lLeapMonth(ly);
    let isLeap = false, lm = 1;
    for (; lm < 13 && offset > 0; lm++) {
      if (leap > 0 && lm === leap + 1 && !isLeap) { --lm; isLeap = true; const d = lLeapDays(ly); if (offset < d) break; offset -= d; isLeap = false; }
      else { const d = lMonthDays(ly, lm); if (offset < d) break; offset -= d; }
    }
    if (leap > 0 && lm === leap + 1 && !isLeap) isLeap = true;
    return { ly, lm, leap: isLeap, ld: offset + 1 };
  }
  /** 公历 → 农历。text：初一显示月名（闰月带「闰」），其余显示日名；除夕（次日为正月初一）优先。 */
  function toLunar(date) {
    const { ly, lm, leap, ld } = lunarOf(date);
    const next = new Date(date); next.setDate(next.getDate() + 1);
    const nl = lunarOf(next);
    const eve = nl.ly !== ly && nl.lm === 1 && nl.ld === 1 && !nl.leap;
    const text = eve ? "除夕" : ld === 1 ? (leap ? "闰" : "") + LUNAR_MONTHS[lm - 1] + "月" : LUNAR_DAYS[ld - 1];
    return { ly, lm, leap, ld, text };
  }
  /** 年干支：以立春为界。月柱按 12 节（立春起），月支 = 立春(寅) 起顺数；月干按五虎遁
   *  （寅月干 = (年干序*2+2)%10，干随月序线性递增）。日柱按儒略日连续推算。 */
  function ganzhi(date, lunar) {
    const y = date.getFullYear();
    const lichun = solarTermDate(y, "立春");
    const gzYear = date >= lichun ? y : y - 1;
    const sy = STEMS[(((gzYear - 4) % 10) + 10) % 10], by = BRANCHES[(((gzYear - 4) % 12) + 12) % 12];
    const zodiac = ZODIAC[(((gzYear - 4) % 12) + 12) % 12];
    /* 12 个「节」（月首）：立春 惊蛰 清明 立夏 芒种 小暑 立秋 白露 寒露 立冬 大雪 小寒。最近已过者按日期取最大。 */
    const JIE = ["立春", "惊蛰", "清明", "立夏", "芒种", "小暑", "立秋", "白露", "寒露", "立冬", "大雪", "小寒"];
    let jie = 11, jieDate = 0;
    for (const yy of [y - 1, y]) {
      for (const name of JIE) {
        const d = solarTermDate(yy, name);
        if (d && d <= date) {
          const t = d.getTime();
          if (t > jieDate) { jieDate = t; jie = JIE.indexOf(name); }
        }
      }
    }
    const monthBranch = (jie + 2) % 12;
    const monthStemIdx = ((((((gzYear - 4) % 5) + 5) % 5) * 2 + 2 + jie) % 10 + 10) % 10;
    const sm = STEMS[monthStemIdx], bm = BRANCHES[monthBranch];
    /* 日柱：2000-01-01 为甲辰日（儒略日 2451545）；60 甲子序号 = (jd + 50) mod 60。 */
    const jd = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000) + 2440588;
    const dIdx = (((jd + 50) % 60) + 60) % 60;
    const sd = STEMS[dIdx % 10], bd = BRANCHES[dIdx % 12];
    const value = "建除满平定执破危成收开闭"[(dIdx % 12)];
    void lunar;
    return { year: sy + by, month: sm + bm, day: sd + bd, zodiac, value };
  }

  /* 二十四节气：按太阳视黄经计算。每 15° 一个节气（春分=0°，清明=15°，…，惊蛰=345°）。
     太阳黄经用 Meeus 低阶近似（精度约 0.01°，对应日期误差远小于 1 天），不依赖查表系数。 */
  const TERM_NAMES = ["春分", "清明", "谷雨", "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑", "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒", "立春", "雨水", "惊蛰"];
  function sunLongitude(date) {
    // 采样时刻：北京时间当日 12:00（UTC 04:00），避免交节时刻落在凌晨时被日界切到前一天。
    const jd = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000) + 4 / 24 + 2440588;
    const T = (jd - 2451545.0) / 36525;
    const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360;
    const Mr = M * Math.PI / 180;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    return ((trueLong - 0.00569 - 0.00478 * Math.sin(omega * Math.PI / 180)) % 360 + 360) % 360;
  }
  /** 黄经达到 k×15°（k=0..23，k=0 为春分）的公历日期。从某年春分之后的 3 月 21 日起按日搜索 13 个月，
      这样 k=19..23（小寒…惊蛰，285°–345°）传入上一年时，不会先命中上一年 3 月初自己的那次。 */
  function termDate(y, k) {
    const target = k * 15;
    const d = new Date(Date.UTC(y, 2, 21));
    const end = new Date(Date.UTC(y + 1, 3, 20));
    let diff = ((sunLongitude(d) - target + 540) % 360) - 180;
    while (d <= end) {
      const diffCur = ((sunLongitude(d) - target + 540) % 360) - 180;
      if (diff < 0 && diffCur >= 0) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      diff = diffCur;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return null;
  }
  function solarTermDate(y, name) { return (termDatesOfYear(y).find(t => t.name === name) || {}).d || null; }
  /** 当年（公历 y 年 1–12 月）发生的 24 个节气，按公历日期升序，按年缓存。
      春分…冬至（k=0..18）发生在 y 年；小寒…惊蛰（k=19..23）黄经 285°–345° 需从上一年 3 月下旬起搜才落到 y 年初。 */
  const TERM_CACHE = new Map();
  function termDatesOfYear(y) {
    if (!TERM_CACHE.has(y)) {
      const out = [];
      for (let k = 0; k < 24; k++) { const d = termDate(k >= 19 ? y - 1 : y, k); if (d && d.getFullYear() === y) out.push({ name: TERM_NAMES[k], d }); }
      TERM_CACHE.set(y, out.sort((a, b) => a.d - b.d));
    }
    return TERM_CACHE.get(y);
  }
  /** 公历日期对应节气（节气日当天返回名称），否则 null。 */
  function termOf(date) {
    for (const t of termDatesOfYear(date.getFullYear())) if (sameDay(t.d, date)) return t.name;
    return null;
  }
  const pad2 = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /* 法定节假日（按农历的春节 / 端午 / 中秋按农历推；清明按节气）。 */
  const FIXED_FESTIVALS = { "1-1": "元旦", "5-1": "劳动节", "10-1": "国庆节", "3-8": "妇女节", "5-4": "青年节", "6-1": "儿童节", "8-1": "建军节", "9-10": "教师节" };
  const LUNAR_FESTIVALS = { "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节", "7-7": "七夕节", "7-15": "中元节", "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节", "12-23": "小年" };
  const LEGAL = new Set(["元旦", "春节", "清明节", "劳动节", "端午节", "中秋节", "国庆节"]);
  /* 调休（国务院安排，仅内置 2025–2027；值「休」或「班」。同日冲突以表中后写者为准）。 */
  const WORK_OFF = {
    /* 2025：元旦 1.1；春节 1.28–2.4（1.26、2.8 班）；清明 4.4–4.6；劳动 5.1–5.5（4.27 班）；国庆中秋 10.1–10.8（9.28、10.11 班）。 */
    "2025-01-01": "休",
    "2025-01-28": "休", "2025-01-29": "休", "2025-01-30": "休", "2025-01-31": "休", "2025-02-01": "休", "2025-02-02": "休", "2025-02-03": "休", "2025-02-04": "休", "2025-01-26": "班", "2025-02-08": "班",
    "2025-04-04": "休", "2025-04-05": "休", "2025-04-06": "休",
    "2025-05-01": "休", "2025-05-02": "休", "2025-05-03": "休", "2025-05-04": "休", "2025-05-05": "休", "2025-04-27": "班",
    "2025-10-01": "休", "2025-10-02": "休", "2025-10-03": "休", "2025-10-04": "休", "2025-10-05": "休", "2025-10-06": "休", "2025-10-07": "休", "2025-10-08": "休", "2025-09-28": "班", "2025-10-11": "班",
    /* 2026（按国务院惯例推定，界面以表内为准）：元旦 1.1–1.3；春节 2.15–2.22（2.28 班）；清明 4.4–4.6；劳动 5.1–5.5（5.9 班）；端午 6.19–6.21；中秋 9.25–9.27；国庆 10.1–10.8（10.10 班）。 */
    "2026-01-01": "休", "2026-01-02": "休", "2026-01-03": "休",
    "2026-02-15": "休", "2026-02-16": "休", "2026-02-17": "休", "2026-02-18": "休", "2026-02-19": "休", "2026-02-20": "休", "2026-02-21": "休", "2026-02-22": "休", "2026-02-28": "班",
    "2026-04-04": "休", "2026-04-05": "休", "2026-04-06": "休",
    "2026-05-01": "休", "2026-05-02": "休", "2026-05-03": "休", "2026-05-04": "休", "2026-05-05": "休", "2026-05-09": "班",
    "2026-06-19": "休", "2026-06-20": "休", "2026-06-21": "休",
    "2026-09-25": "休", "2026-09-26": "休", "2026-09-27": "休",
    "2026-10-01": "休", "2026-10-02": "休", "2026-10-03": "休", "2026-10-04": "休", "2026-10-05": "休", "2026-10-06": "休", "2026-10-07": "休", "2026-10-08": "休", "2026-10-10": "班",
    /* 2027：元旦 1.1–1.3（后续年度以表内为准）。 */
    "2027-01-01": "休", "2027-01-02": "休", "2027-01-03": "休"
  };

  function festivalsOf(date, lunar) {
    const list = [];
    const key = `${date.getMonth() + 1}-${date.getDate()}`;
    if (FIXED_FESTIVALS[key]) list.push({ name: FIXED_FESTIVALS[key], legal: LEGAL.has(FIXED_FESTIVALS[key]), kind: "legal" });
    const lk = `${lunar.lm}-${lunar.ld}`;
    if (!lunar.leap && LUNAR_FESTIVALS[lk]) list.push({ name: LUNAR_FESTIVALS[lk], legal: LEGAL.has(LUNAR_FESTIVALS[lk]), kind: "tradition" });
    if (lunar.text === "除夕") list.push({ name: "除夕", legal: false, kind: "tradition" });
    const term = termOf(date);
    if (term === "清明") list.push({ name: "清明节", legal: true, kind: "legal" });
    const order = { legal: 0, tradition: 1, term: 2 };
    if (term && term !== "清明") list.push({ name: term, legal: false, kind: "term" });
    return list.sort((a, b) => order[a.kind] - order[b.kind]);
  }

  /* 十二值日宜忌（传统通书常见口诀，属近似规则）。 */
  const VALUE_GOOD_BAD = {
    "建": { good: "出行、上任、会友", bad: "动土、开仓、嫁娶" },
    "除": { good: "扫舍、祭祀、除服、疗病", bad: "嫁娶、出行、赴任" },
    "满": { good: "祈福、祭祀、结亲、开市", bad: "服药、栽种、下葬、求医" },
    "平": { good: "修饰垣墙、平治道涂", bad: "嫁娶、开市、动土" },
    "定": { good: "祭祀、祈福、嫁娶、宴请、协议", bad: "诉讼、出行、搬迁" },
    "执": { good: "造屋、结网、捕捉、纳财", bad: "搬迁、出行、开市" },
    "破": { good: "破屋坏垣、求医治病", bad: "嫁娶、签约、出行、动土" },
    "危": { good: "祭祀、安床、纳财", bad: "登高、行船、出行" },
    "成": { good: "开业、入学、嫁娶、签约、上任", bad: "诉讼" },
    "收": { good: "纳财、开市、交易、立契", bad: "出行、安葬" },
    "开": { good: "开业、结婚、入宅、出行、求医", bad: "安葬、动土" },
    "闭": { good: "安葬、填塞、筑堤", bad: "开市、出行、嫁娶、手术" }
  };

  function dayInfo(date) {
    const lunar = toLunar(date);
    const gz = ganzhi(date, lunar);
    const festivals = festivalsOf(date, lunar);
    return { lunar, gz, festivals, workOff: WORK_OFF[ymd(date)] || null, good: VALUE_GOOD_BAD[gz.value].good, bad: VALUE_GOOD_BAD[gz.value].bad };
  }

  /* ==================== 日程与待办（内存演示） ==================== */
  const COLORS = ["blue", "green", "amber", "violet", "rose"];
  const COLOR_LABEL = { blue: "蓝", green: "绿", amber: "琥珀", violet: "紫", rose: "玫红" };
  let events = [
    { id: "e1", title: "客户需求评审", start: "2026-11-24", end: "2026-11-24", allDay: false, time: "10:00", endTime: "11:30", note: "3F 会议室 B", color: "blue" },
    { id: "e2", title: "午间散步", start: "2026-11-24", end: "2026-11-24", allDay: false, time: "12:30", endTime: "13:00", note: "", color: "green" },
    { id: "e3", title: "小红书文案初稿", start: "2026-11-24", end: "2026-11-24", allDay: false, time: "19:00", endTime: "20:00", note: "", color: "violet" },
    { id: "e4", title: "健身房训练", start: "2026-11-24", end: "2026-11-24", allDay: false, time: "19:30", endTime: "21:00", note: "乐动运动万象城店", color: "amber" },
    { id: "e5", title: "和朋友聚餐", start: "2026-11-24", end: "2026-11-24", allDay: false, time: "20:30", endTime: "22:00", note: "海底捞万象城店", color: "rose" },
    { id: "e6", title: "年度体检安排 · 体检与取证报告", start: "2026-12-07", end: "2026-12-13", allDay: true, time: "", endTime: "", note: "含体检报告领取", color: "green" },
    { id: "e7", title: "休假 · 老家探亲", start: "2026-12-09", end: "2026-12-11", allDay: true, time: "", endTime: "", note: "", color: "amber" },
    { id: "e8", title: "客户官网改版 · 页面与接口", start: "2026-12-11", end: "2026-12-17", allDay: true, time: "", endTime: "", note: "与研发同步", color: "blue" },
    { id: "e9", title: "出差 · 杭州分公司", start: "2026-11-29", end: "2026-12-02", allDay: true, time: "", endTime: "", note: "跨月", color: "violet" },
    { id: "e10", title: "季度复盘", start: "2026-11-30", end: "2026-11-30", allDay: false, time: "15:00", endTime: "17:00", note: "", color: "blue" }
  ];
  let todos = [
    { id: "t1", date: "2026-11-24", title: "回复客户需求澄清邮件", done: false },
    { id: "t2", date: "2026-11-24", title: "整理评审会议纪要", done: true },
    { id: "t3", date: "2026-11-24", title: "准备明日站会材料", done: false },
    { id: "t4", date: "2026-11-25", title: "提交周报", done: false }
  ];
  let seq = 11;

  const state = { tab: "schedule", view: "2026-11", selected: "2026-11-24", dayTab: "events", form: null, editingTodo: null, picker: false, pickerYear: 2026, usageRange: "today" };
  const TODAY = new Date(2026, 10, 24);
  /* v8：移除详情栏顶部天气条（含定位 / Open-Meteo 相关夹具与降级态），详情栏直接从日期标题开始。 */

  function eventsOn(dateKey) {
    return events.filter(e => e.start <= dateKey && dateKey <= e.end).sort((a, b) => (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || (a.time || "").localeCompare(b.time || ""));
  }
  function todosOn(dateKey) { return todos.filter(t => t.date === dateKey); }

  /* ==================== 日程 Tab ==================== */
  function monthMatrix(view) {
    const [y, m] = view.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const weeks = [];
    const cur = new Date(start);
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let d = 0; d < 7; d++) { row.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      weeks.push(row);
    }
    return { y, m, weeks };
  }
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - y0) / 86400000 + 1) / 7);
  }

  /* 跨天条带布局：求每条事件在当周的连续段，并分配不重叠的车道（lane）。 */
  function layoutWeek(week) {
    const lanes = [];
    const segs = [];
    const weekStart = ymd(week[0]), weekEnd = ymd(week[6]);
    const sorted = events.filter(e => e.end >= weekStart && e.start <= weekEnd)
      .sort((a, b) => (a.start + (a.allDay ? "0" : "1") + a.time).localeCompare(b.start + (b.allDay ? "0" : "1") + b.time));
    for (const e of sorted) {
      const from = e.start < weekStart ? 0 : week.findIndex(d => ymd(d) === e.start);
      const to = e.end > weekEnd ? 6 : week.findIndex(d => ymd(d) === e.end);
      if (from < 0 || to < 0 || from > to) continue;
      let lane = 0;
      while (true) {
        if (!lanes[lane]) lanes[lane] = Array(7).fill(null);
        if (lanes[lane].slice(from, to + 1).every(v => !v)) break;
        lane++;
      }
      for (let i = from; i <= to; i++) lanes[lane][i] = e.id;
      segs.push({ e, from, to, lane, head: ymd(week[from]) === e.start, tail: ymd(week[to]) === e.end });
    }
    return { lanes: lanes.length, segs };
  }

  function almTerms(s) { return String(s || "—").split(/[、\s]+/).filter(Boolean); }

  function schedulePage() {
    const { y, m } = monthMatrix(state.view);
    const selInfo = dayInfo(new Date(state.selected + "T00:00:00"));
    return `<div class="page c078-page" data-design-version="UI-CR078-v11">
      <div class="page-h"><div class="titles"><h1 class="page-title">概览</h1><p class="page-sub">日程与全平台用量集中在这里。</p></div></div>
      <div class="c078-tabs" role="tablist" aria-label="概览页签">
        <button class="c078-tab ${state.tab === "schedule" ? "active" : ""}" role="tab" aria-selected="${state.tab === "schedule"}" data-c078-act="tab" data-tab="schedule">${icon("calendar", "ico-16")}日程</button>
        <button class="c078-tab ${state.tab === "usage" ? "active" : ""}" role="tab" aria-selected="${state.tab === "usage"}" data-c078-act="tab" data-tab="usage">${icon("tokenUsage", "ico-16")}用量</button>
      </div>
      <div class="c078-schedule">
        <section class="card c078-cal-card" aria-label="月日历">
          <div class="c078-cal-h">
            <div class="c078-cal-nav">
              <button class="c078-nav-btn" data-c078-act="shift-year" data-d="-1" aria-label="上一年" title="上一年">«</button>
              <button class="c078-nav-btn" data-c078-act="shift-month" data-d="-1" aria-label="上月" title="上月">‹</button>
              <button class="c078-cal-title ${state.picker ? "open" : ""}" data-c078-act="open-picker" aria-haspopup="true" aria-expanded="${state.picker}">${y}年${m}月</button>
              <button class="c078-nav-btn" data-c078-act="shift-month" data-d="1" aria-label="下月" title="下月">›</button>
              <button class="c078-nav-btn" data-c078-act="shift-year" data-d="1" aria-label="下一年" title="下一年">»</button>
              <button class="btn sm c078-today-btn" data-c078-act="today">今天</button>
            </div>
            <button class="btn primary sm" data-c078-act="new">${icon("plus", "ico-14")}新建日程</button>
            ${state.picker ? pickerHTML(y, m) : ""}
          </div>
          <div class="c078-cal-grid" role="grid" aria-rowcount="7" aria-colcount="8">
            <div class="c078-cal-wh" role="columnheader">周</div>
            ${["一", "二", "三", "四", "五", "六", "日"].map((w, i) => `<div class="c078-cal-wh ${i >= 5 ? "weekend" : ""}" role="columnheader">${w}</div>`).join("")}
            ${monthMatrix(state.view).weeks.map(week => renderWeek(week, y, m)).join("")}
          </div>
        </section>
        <aside class="card c078-day" aria-label="日期详情">
          <div class="c078-day-b">
            <div class="c078-date-header" aria-label="所选日期黄历">
              <div class="c078-alm-yj">
                <div><span>宜</span><p title="${esc(selInfo.good || "—")}">${almTerms(selInfo.good).map(t => `<i>${esc(t)}</i>`).join("")}</p></div>
                <div><span>忌</span><p title="${esc(selInfo.bad || "—")}">${almTerms(selInfo.bad).map(t => `<i>${esc(t)}</i>`).join("")}</p></div>
              </div>
              <div class="c078-date-main">
                <span class="c078-date-number">${new Date(state.selected + "T00:00:00").getDate()}</span>
                <b class="c078-date-lunar">${selInfo.lunar.leap ? "闰" : ""}${LUNAR_MONTHS[selInfo.lunar.lm - 1]}月${LUNAR_DAYS[selInfo.lunar.ld - 1]}</b>
                <span class="c078-date-cycle">${esc(selInfo.gz.year)}${esc(selInfo.gz.zodiac)}年 ${esc(selInfo.gz.month)}月 ${esc(selInfo.gz.day)}日</span>
              </div>
            </div>
            <div class="c078-date-notes"><time datetime="${state.selected}">${state.selected}</time><span class="tag blue">${dayTone(state.selected)}</span><span>${esc(selInfo.gz.value)}日</span>${selInfo.festivals.map(f => `<span class="c078-fest is-${f.kind}">${esc(f.name)}</span>`).join("")}${selInfo.workOff ? `<span class="c078-off">${selInfo.workOff}</span>` : ""}</div>
            <div class="c078-day-tabs" role="tablist" aria-label="当天事项">
              <button class="c078-day-tab ${state.dayTab === "todo" ? "" : "active"}" role="tab" aria-selected="${state.dayTab !== "todo"}" data-c078-act="day-tab" data-tab="events">${icon("calendar", "ico-14")}日程 <span>${eventsOn(state.selected).length}</span></button>
              <button class="c078-day-tab ${state.dayTab === "todo" ? "active" : ""}" role="tab" aria-selected="${state.dayTab === "todo"}" data-c078-act="day-tab" data-tab="todo">${icon("check", "ico-14")}待办 <span>${todosOn(state.selected).filter(t => !t.done).length}</span></button>
            </div>
            <div class="c078-day-panel">
            ${state.dayTab === "todo" ? `
              <div class="c078-day-list">${todosOn(state.selected).map(t => {
                const editing = state.editingTodo === t.id;
                return `<div class="c078-todo ${t.done ? "done" : ""}"><input type="checkbox" data-c078-act="todo-toggle" data-id="${t.id}" ${t.done ? "checked" : ""}>` +
                  (editing
                    ? `<input class="input c078-todo-edit" id="c078-todo-edit-input" value="${esc(t.title)}" maxlength="80" aria-label="编辑待办">`
                    : `<span class="c078-todo-text">${esc(t.title)}</span><button class="c078-todo-edit-btn" data-c078-act="todo-edit" data-id="${t.id}" aria-label="编辑待办 ${esc(t.title)}">${icon("edit", "ico-12")}</button>`) +
                  `</div>`;
              }).join("") || `<div class="c078-none">没有待办</div>`}</div>
              <form class="c078-todo-new" data-c078-form="todo"><input class="input" id="c078-todo-input" maxlength="80" placeholder="新增待办，回车保存" aria-label="新增待办"><button class="btn sm" type="submit">${icon("plus", "ico-12")}</button></form>` : `
              <div class="c078-day-list">${eventsOn(state.selected).map(e => `<div class="c078-ev c-${e.color}"><span class="c078-ev-dot"></span><span class="c078-ev-main"><b>${esc(e.title)}</b><small>${e.allDay ? "全天" : `${e.time} – ${e.endTime}`}${e.start !== e.end ? ` · ${e.start} 至 ${e.end}` : ""}${e.note ? ` · ${esc(e.note)}` : ""}</small></span><button class="c078-ev-edit" data-c078-act="edit" data-id="${e.id}" aria-label="编辑日程 ${esc(e.title)}">${icon("edit", "ico-12")}</button><button class="c078-ev-del" data-c078-act="del" data-id="${e.id}" aria-label="删除日程 ${esc(e.title)}">${icon("trash", "ico-12")}</button></div>`).join("") || `<div class="c078-none">这一天没有日程</div>`}</div>`}
            </div>
          </div>
        </aside>
      </div>
    </div>`;
  }
  function dayTone(key) { return key === ymd(TODAY) ? "今天" : key > ymd(TODAY) ? "未来" : "过去"; }

  /* v7：点击「YYYY年M月」弹出年月快速选择器（年可步进 + 12 个月网格），选月即跳转。 */
  function pickerHTML(y, m) {
    const cy = state.pickerYear || y;
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    return `<div class="c078-picker-mask" data-c078-act="close-picker"></div>
      <div class="c078-picker" role="dialog" aria-label="选择年月">
        <div class="c078-picker-h">
          <button class="c078-nav-btn" data-c078-act="picker-year" data-d="-1" aria-label="上一年">‹</button>
          <b>${cy}年</b>
          <button class="c078-nav-btn" data-c078-act="picker-year" data-d="1" aria-label="下一年">›</button>
        </div>
        <div class="c078-picker-grid">${months.map(mm => {
          const isActive = cy === y && mm === m;
          const isCurrent = cy === TODAY.getFullYear() && mm === TODAY.getMonth() + 1;
          return `<button data-c078-act="pick-month" data-m="${mm}" class="${isActive ? "is-active" : isCurrent ? "is-current" : ""}">${mm}月</button>`;
        }).join("")}</div>
      </div>`;
  }

  /* 一个周行 = 周号 + 7 个单元格 + 条带覆盖层（覆盖层与 7 天同列对齐）。条带按车道堆叠，跨天连续；周内外日期截断到边界。 */
  function renderWeek(week, y, m) {
    const { lanes, segs } = layoutWeek(week);
    const maxLane = Math.min(lanes, 2);
    const shown = segs.filter(s => s.lane < maxLane);
    const hidden = segs.filter(s => s.lane >= maxLane);
    return `<div class="c078-cal-row" role="row">
      <div class="c078-cal-wk" role="rowheader">${isoWeek(week[0])}</div>
      ${week.map((d, di) => renderCell(d, y, m, di)).join("")}
      <div class="c078-week-lanes">
        ${shown.map(s => `<span class="c078-band c-${s.e.color} ${s.head ? "head" : ""} ${s.tail ? "tail" : ""}" style="--from:${s.from};--span:${s.to - s.from + 1};--lane:${s.lane}" data-c078-act="edit" data-id="${s.e.id}" title="${esc(s.e.title)} · ${s.e.start}${s.e.start !== s.e.end ? " 至 " + s.e.end : ""}（点击编辑）">${s.head || s.to - s.from < 2 ? esc(s.e.title) : ""}</span>`).join("")}
      </div>
      ${hidden.length ? `<span class="c078-week-more" data-c078-act="select" data-date="${ymd(week[0])}">+${hidden.length} 条在详情</span>` : ""}
    </div>`;
  }
  function renderCell(d, y, m, di) {
    const k = ymd(d);
    const info = dayInfo(d);
    const inMonth = d.getMonth() === m - 1;
    const isToday = k === ymd(TODAY), isSelected = k === state.selected;
    const fest = info.festivals[0];
    return `<div class="c078-cell ${inMonth ? "" : "out"} ${di >= 5 ? "weekend" : ""} ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}" role="gridcell" data-c078-act="select" data-date="${k}" tabindex="0" aria-label="${k} ${info.lunar.text}${fest ? " " + fest.name : ""}${info.workOff ? " " + (info.workOff === "休" ? "休息日" : "调休上班") : ""}">
      <div class="c078-cell-top"><span class="c078-dnum">${d.getDate()}</span>${info.workOff ? `<span class="c078-off">${info.workOff}</span>` : ""}<span class="c078-lunar ${fest ? "is-" + fest.kind : ""}">${esc(fest ? fest.name : info.lunar.text)}</span></div>
      <button class="c078-cell-add" data-c078-act="new" data-date="${k}" aria-label="在 ${k} 新建日程" tabindex="-1">${icon("plus", "ico-12")}</button>
    </div>`;
    void y;
  }

  /* ==================== 新建 / 编辑日程弹窗 ==================== */
  function eventForm(dateKey, eventId) {
    const e = eventId ? events.find(x => x.id === eventId) : null;
    const start = e ? e.start : dateKey || state.selected;
    const body = `<form class="c078-form" data-c078-form="event">
      <label class="f-row"><span>标题</span><input class="input" id="c078-title" maxlength="80" required placeholder="日程标题" value="${esc(e ? e.title : "")}"></label>
      <div class="f-row"><span>日期</span><div class="row"><input class="input" id="c078-start" type="date" value="${start}"><span class="muted">至</span><input class="input" id="c078-end" type="date" value="${e ? e.end : start}"></div></div>
      <div class="f-row"><span>时间</span><div class="row wrap"><label class="c078-radio"><input type="radio" name="c078-allday" value="1" ${!e || e.allDay ? "checked" : ""}>全天</label><label class="c078-radio"><input type="radio" name="c078-allday" value="0" ${e && !e.allDay ? "checked" : ""}>具体时间</label>
        <input class="input c078-time" id="c078-time" type="time" value="${e ? e.time : "09:00"}" ${!e || e.allDay ? "disabled" : ""}><span class="muted">–</span><input class="input c078-time" id="c078-endtime" type="time" value="${e ? e.endTime : "10:00"}" ${!e || e.allDay ? "disabled" : ""}></div></div>
      <div class="f-row"><span>颜色</span><div class="c078-swatches" role="radiogroup" aria-label="颜色">${COLORS.map(c => `<label class="c078-sw c-${c}" title="${COLOR_LABEL[c]}"><input type="radio" name="c078-color" value="${c}" ${(e ? e.color : "blue") === c ? "checked" : ""}><i></i></label>`).join("")}</div></div>
      <label class="f-row"><span>备注</span><textarea class="input textarea" id="c078-note" rows="2" maxlength="200" placeholder="可选">${esc(e ? e.note : "")}</textarea></label>
      <p class="c078-form-err" id="c078-err" role="alert" hidden></p>
    </form>`;
    openDialog(dlgShell(e ? "编辑日程" : "新建日程", "结束日期不能早于开始日期；跨天日程会在月历上连成一条。", body,
      `<span class="left caption">${e ? "" : "保存后立即出现在月历"}</span><button class="btn" data-act="close-dialog">取消</button><button class="btn primary" data-c078-act="save-event" data-id="${e ? e.id : ""}">${icon("check", "ico-14")}保存</button>`));
    setTimeout(() => document.getElementById("c078-title")?.focus(), 0);
  }

  /* ==================== 用量 Tab ==================== */
  const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n);
  const RANGES = { today: "今日", "3d": "近 3 天", "7d": "近 7 天", "1m": "近 1 月", "3m": "近 3 月", custom: "自定义" };
  /* 合成夹具：以「今日 2026-11-24」为基准生成 210 天数据；三类来源。
     210 天 > 热力图 28 周（196 天）窗口，保证固定长周期热力图整格有数据。 */
  const USAGE = (() => {
    const days = [];
    let seed = 20261124;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 209; i >= 0; i--) {
      const d = new Date(2026, 10, 24); d.setDate(d.getDate() - i);
      const dow = d.getDay();
      const active = dow === 0 || dow === 6 ? rnd() < 0.35 : rnd() < 0.86;
      const hours = [];
      let dayIn = 0, dayOut = 0, dayCache = 0, dayReq = 0;
      for (let h = 0; h < 24; h++) {
        const w = (h >= 9 && h <= 12 ? 1 : h >= 14 && h <= 18 ? 1.1 : h >= 19 && h <= 23 ? 0.8 : h >= 7 && h <= 8 ? 0.4 : 0.05);
        const v = active ? rnd() * w : 0;
        const hitRate = 0.55 + 0.42 * Math.abs(Math.sin(h * 0.9 + 0.6));
        const inp = Math.round(v * 9_000_000 * (1 - hitRate)), out = Math.round(v * 320_000), cache = Math.round(v * 9_000_000 * hitRate), req = Math.round(v * 52);
        hours.push({ in: inp, out, cache, req });
        dayIn += inp; dayOut += out; dayCache += cache; dayReq += req;
      }
      days.push({ date: ymd(d), in: dayIn, out: dayOut, cache: dayCache, req: dayReq, hours });
    }
    return days;
  })();
  const PROVIDERS = [
    { name: "MagpieGateway", in: 199_800_000, out: 3_100_000, cache: 188_400_000, req: 1268, hit: 94.1 },
    { name: "基准云动", in: 178_300_000, out: 2_700_000, cache: 173_900_000, req: 1104, hit: 97.7 },
    { name: "基准巴巴", in: 121_800_000, out: 2_100_000, cache: 99_600_000, req: 812, hit: 81.8 },
    { name: "中转信投", in: 59_100_000, out: 1_100_000, cache: 58_500_000, req: 402, hit: 99.3 },
    { name: "primerelay", in: 23_000_000, out: 600_000, cache: 21_300_000, req: 188, hit: 92.3 },
    { name: "Abin", in: 19_600_000, out: 400_000, cache: 18_300_000, req: 121, hit: 93.9 }
  ];
  const MODELS = [
    { name: "deepseek-v4.1-flash-1017", total: 197_800_000, hit: 97.8, source: "cli" },
    { name: "gpt-6.1-sol-free", total: 152_700_000, hit: 93.1, source: "cli" },
    { name: "grok-4.7", total: 83_400_000, hit: 95.7, source: "cli" },
    { name: "gpt-6.2-sol", total: 61_500_000, hit: 65.5, source: "platform" },
    { name: "glm-5.3-flashx", total: 59_100_000, hit: 99.3, source: "cli" },
    { name: "deepseek-v4.1-flash", total: 28_300_000, hit: 96.9, source: "subagent" },
    { name: "glm-5.3-flash", total: 18_800_000, hit: 97.7, source: "subagent" }
  ];
  /* v11：来源文字标签（CLI / 平台主代理 / 子智能体）已移除，来源改由左侧图标区分，不再需要文本映射。 */
  /* 模型色板：沿用平台主题色，排行与趋势图共用同一套索引色，保证同一个模型在两处颜色一致。 */
  const MODEL_COLORS = [
    "var(--primary)", "var(--teal)", "var(--violet)", "var(--warning)",
    "var(--success)", "var(--danger)", "var(--primary-strong)", "var(--muted-2)",
  ];
  const modelColor = (name) => {
    const i = MODELS.findIndex(m => m.name === name);
    return MODEL_COLORS[(i < 0 ? MODEL_COLORS.length - 1 : i) % MODEL_COLORS.length];
  };

  function rangeDays(key) {
    const n = key === "today" ? 1 : key === "3d" ? 3 : key === "7d" ? 7 : key === "1m" ? 30 : 90;
    return USAGE.slice(-n);
  }
  function sum(days) {
    return days.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out, cache: a.cache + d.cache, req: a.req + d.req }), { in: 0, out: 0, cache: 0, req: 0 });
  }

  function usagePage() {
    const days = state.usageRange === "custom" ? USAGE.slice(-14) : rangeDays(state.usageRange);
    const s = sum(days);
    const total = s.in + s.out;
    const hit = s.in + s.cache > 0 ? (s.cache / (s.in + s.cache)) * 100 : null;
    const modelTotal = MODELS.reduce((a, m) => a + m.total, 0);
    const provTotal = PROVIDERS.reduce((a, p) => a + p.in + p.out, 0);
    /* 每小时按显示名称聚合的模型明细：趋势图按模型堆叠，悬停浮层列举详情。
       分布按模型总量占比分摊到该小时 token 总量，并带确定性扰动，避免每根柱子形状雷同。 */
    const hours = Array.from({ length: 24 }, (_, h) => {
      const b = days.reduce((a, d) => ({
        in: a.in + d.hours[h].in, out: a.out + d.hours[h].out,
        cache: a.cache + d.hours[h].cache, req: a.req + d.hours[h].req,
      }), { in: 0, out: 0, cache: 0, req: 0 });
      const tokenSum = b.in + b.out;
      const raw = MODELS.map((m, mi) => ({
        name: m.name,
        w: (m.total / modelTotal) * (0.7 + 0.6 * Math.abs(Math.sin((h + 1) * 1.7 + mi * 2.9))),
      }));
      const wSum = raw.reduce((a, x) => a + x.w, 0) || 1;
      const models = raw.map(x => ({ name: x.name, tokens: Math.round((x.w / wSum) * tokenSum) }));
      return { ...b, models };
    });
    const hMax = Math.max(1, ...hours.map(h => h.models.reduce((a, m) => a + m.tokens, 0)));
    /* 活跃热力图是固定长周期视图（近 28 周），不随上方周期筛选变化，
       否则选「近 7 天」时 28 列里只有 2 列有数据、其余全是空框。 */
    const heatDays = USAGE;
    const heat = heatGrid(heatDays);
    const heatCols = heat.cols;
    const heatStyle = `--cols:${heatCols};grid-template-columns:repeat(${heatCols}, minmax(0, 1fr))`;
    return `<div class="page c078-page" data-design-version="UI-CR078-v11">
      <div class="page-h"><div class="titles"><h1 class="page-title">概览</h1><p class="page-sub">日程与全平台用量集中在这里。</p></div></div>
      <div class="c078-tabs" role="tablist" aria-label="概览页签">
        <button class="c078-tab ${state.tab === "schedule" ? "active" : ""}" role="tab" aria-selected="${state.tab === "schedule"}" data-c078-act="tab" data-tab="schedule">${icon("calendar", "ico-16")}日程</button>
        <button class="c078-tab ${state.tab === "usage" ? "active" : ""}" role="tab" aria-selected="${state.tab === "usage"}" data-c078-act="tab" data-tab="usage">${icon("tokenUsage", "ico-16")}用量</button>
      </div>
      <div class="c078-usage" data-range="${esc(state.usageRange)}">
        <div class="c078-usage-h">
          <div class="c078-seg" role="tablist" aria-label="统计周期">${Object.entries(RANGES).map(([k, l]) => `<button class="${state.usageRange === k ? "active" : ""}" role="tab" aria-selected="${state.usageRange === k}" data-c078-act="range" data-key="${k}">${l}</button>`).join("")}</div>
          ${state.usageRange === "custom" ? `<div class="row c078-custom"><input class="input" type="date" value="2026-11-10" aria-label="开始日期"><span class="muted">至</span><input class="input" type="date" value="2026-11-24" aria-label="结束日期"></div>` : ""}
          <div class="row c078-asof"><span class="caption">统计截至 2026-11-24 22:29</span><button class="btn sm" data-c078-act="refresh">${icon("refresh", "ico-14")}刷新</button></div>
        </div>
        <div class="c078-kpis">
          ${kpi("tokenUsage", "总 Tokens", fmt(total), `${total.toLocaleString()} tokens`, "blue")}
          ${kpi("download", "输入 Tokens", fmt(s.in), `${s.in.toLocaleString()} tokens`, "green")}
          ${kpi("upload", "输出 Tokens", fmt(s.out), `${s.out.toLocaleString()} tokens`, "amber")}
          ${kpi("database", "缓存 Tokens", fmt(s.cache), `${s.cache.toLocaleString()} tokens`, "violet")}
          ${kpi("chartLine", "缓存命中率", hit == null ? "—" : hit.toFixed(1) + "%", `${fmt(s.cache)} 缓存命中`, "teal")}
          ${kpi("message", "请求量", s.req.toLocaleString(), `失败 ${Math.round(s.req * 0.121)} · 12.1%`, "rose")}
        </div>
        <div class="c078-two">
          <section class="card c078-panel"><div class="card-h"><h3>活跃热力图</h3><span class="c078-legend"><span>较少</span>${[0, 1, 2, 3, 4].map(i => `<i class="l${i}"></i>`).join("")}<span>较多</span></span></div>
            <div class="card-b c078-heat-wrap"><div class="c078-heat" style="--cols:${heatCols}">
              <div class="c078-heat-months" style="${heatStyle}">${heatMonths(heatDays, heatCols).map(mo => `<span style="grid-column:${mo.col} / span ${mo.span}">${mo.label}</span>`).join("")}</div>
              <div class="c078-heat-body"><div class="c078-heat-days">${["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(w => `<span>${w}</span>`).join("")}</div>
              <div class="c078-heat-grid" style="${heatStyle}">${heat.cells.map(c => c.blank ? `<i class="l-1 is-blank" style="grid-row:${c.row + 1};grid-column:${c.col + 1}" aria-hidden="true"></i>` : `<i class="l${c.level}" style="grid-row:${c.row + 1};grid-column:${c.col + 1}" title="${c.date} · ${fmt(c.value)} tokens · ${c.req} 次请求"></i>`).join("")}</div></div>
            </div></div>
          </section>
          <section class="card c078-panel"><div class="card-h"><h3>按小时 Token 趋势</h3></div>
            <div class="card-b c078-chart"><div class="c078-chart-y">${[1, .75, .5, .25, 0].map(v => `<span>${v === 0 ? "0" : fmt(Math.round(hMax * v))}</span>`).join("")}</div>
              <div class="c078-chart-plot"><div class="c078-gridlines">${[0, 25, 50, 75, 100].map(v => `<i style="bottom:${v}%"></i>`).join("")}</div>
                <div class="c078-bars">${hours.map((h, i) => `<div class="c078-bar" data-c078-hour="${i}" data-tip-total="${h.models.reduce((a, m) => a + m.tokens, 0)}" data-tip-hit="${h.in + h.cache > 0 ? ((h.cache / (h.in + h.cache)) * 100).toFixed(1) : ""}">${h.models.map(m => `<i style="height:${(m.tokens / hMax) * 100}%;background:${modelColor(m.name)}" data-model="${esc(m.name)}" data-tokens="${m.tokens}"></i>`).join("")}</div>`).join("")}</div>
                <svg class="c078-line" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d="${smoothPath(hours.map((h, i) => { const r = h.in + h.cache > 0 ? h.cache / (h.in + h.cache) : null; return [(i + 0.5) / 24 * 1000, r == null ? 100 : 100 - r * 100]; }))}" /></svg>
                <div class="c078-tip" role="tooltip" hidden></div></div>
              <div class="c078-chart-x">${[2, 5, 8, 11, 14, 17, 20, 23].map(h => `<span style="left:${(h + 0.5) / 24 * 100}%">${pad2(h)}:00</span>`).join("")}</div>
              <div class="c078-chart-y right">${[100, 75, 50, 25, 0].map(v => `<span>${v}%</span>`).join("")}</div></div>
          </section>
        </div>
        <div class="c078-two">
          <section class="card c078-panel"><div class="card-h"><h3>按模型</h3><span class="sub">${MODELS.length} 个</span></div>
            <ol class="c078-rank">${MODELS.map((m, i) => rank(i, m.source === "cli" ? cliLogo(m.name.startsWith("gpt") ? "codex" : m.name.startsWith("grok") ? "grok" : "claude", 18) : `<span class="c078-src">${icon(m.source === "platform" ? "sparkles" : "bot", "ico-16")}</span>`, m.name, m.total, m.total / modelTotal * 100, m.hit, m.source)).join("")}</ol></section>
          <section class="card c078-panel"><div class="card-h"><h3>按供应商</h3><span class="sub">${PROVIDERS.length} 个</span></div>
            <ol class="c078-rank">${PROVIDERS.map((p, i) => rank(i, `<i class="c078-prov-dot" style="--i:${i}"></i>`, p.name, p.in + p.out, (p.in + p.out) / provTotal * 100, p.hit, "provider")).join("")}</ol></section>
        </div>
      </div>
    </div>`;
  }
  function kpi(ic, label, value, sub, tone) {
    return `<div class="c078-kpi ${tone}"><div class="k"><span class="c078-kpi-ic">${icon(ic, "ico-16")}</span>${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
  }
  function rank(i, logo, name, total, pct, hit, kind) {
    // 模型条与趋势图共用 modelColor：同一个模型在两处颜色一致；供应商各自独立色相。
    // 供应商同样取平台色板，避免自造高饱和彩虹色偏离平台视觉。
    const barColor = kind === "provider" ? MODEL_COLORS[i % MODEL_COLORS.length] : modelColor(name);
    /* v11：去掉「CLI / 平台主代理 / 子智能体 / 供应商」来源标签——图标已经区分来源，文字重复且没有增量信息；
       左侧序号与图标统一进 20px 居中列，整行垂直居中。 */
    return `<li class="c078-rank-row"><span class="c078-rank-n">${i + 1}</span><span class="c078-rank-ic">${logo}</span><div class="c078-rank-main"><div class="c078-rank-top"><b class="ellipsis">${esc(name)}</b><span class="c078-rank-v">${fmt(total)}</span></div>
      <div class="c078-rank-bar"><i style="width:${Math.max(2, pct)}%;background:${barColor}"></i></div>
      <div class="c078-rank-sub"><span>占比 ${pct.toFixed(1)}%</span><span>缓存命中率 ${hit == null ? "未上报" : hit.toFixed(1) + "%"}</span></div></div></li>`;
  }
  /* v11：命中率折线由折线段改为平滑曲线（Catmull-Rom → 三次贝塞尔）。
     控制点 y 夹在 [0,100]，防止曲线冲出绘图区上下边界；x 不夹，保持时间均匀推进。 */
  function smoothPath(pts) {
    if (!pts.length) return "";
    if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
    const clamp = v => Math.max(0, Math.min(100, v));
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }
  /* 热力图：周一起始、列优先（周一在上），网格按固定列数铺满。
     时间轴从右往左推进——最右列是最近一周（末格对齐到本周周日），左侧逐列往前推；
     所选周期之外的日子保留空框，保证网格永远铺满、最新数据固定在右侧。
     每格 14px + 3px 间距，28 列约 473px，适配面板宽度。 */
  /* 悬停浮层最多列几个模型，其余汇总成一行，避免模型多时浮层顶出绘图区。 */
  const TIP_ROWS = 6;
  const HEAT_COLS = 28;
  function heatSpan(days, cols) {
    const last = new Date(`${days[days.length - 1].date}T00:00:00`);
    const end = new Date(last); end.setDate(end.getDate() + (6 - ((last.getDay() + 6) % 7)));
    const start = new Date(end); start.setDate(start.getDate() - (cols * 7 - 1));
    return { start, end };
  }
  function heatGrid(days) {
    const max = Math.max(1, ...days.map(d => d.in + d.out));
    const byDate = new Map(days.map(d => [d.date, d]));
    const { start } = heatSpan(days, HEAT_COLS);
    const cells = [];
    for (let i = 0; i < HEAT_COLS * 7; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = ymd(d), col = Math.floor(i / 7), row = i % 7;
      const item = byDate.get(key);
      if (!item) { cells.push({ level: -1, blank: true, col, row }); continue; }
      const v = item.in + item.out, r = v / max;
      cells.push({ level: r <= 0 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4, value: v, date: key, req: item.req, col, row });
    }
    return { cells, cols: HEAT_COLS };
  }
  function heatMonths(days, cols) {
    const { start } = heatSpan(days, cols);
    const out = [];
    for (let c = 0; c < cols; c++) {
      const d = new Date(start); d.setDate(d.getDate() + c * 7);
      const mo = ymd(d).slice(0, 7);
      if (!out.length || out[out.length - 1].mo !== mo) out.push({ mo, label: `${Number(mo.slice(5))}月`, col: c + 1 });
    }
    out.forEach((m, i) => { m.span = (i + 1 < out.length ? out[i + 1].col : cols + 1) - m.col; });
    // 跨度不足 2 列的月份放不下「N月」两字，直接不标（首列常是月中，标签会压到下一月）。
    return out.filter(m => m.span >= 2);
  }
  void D;

  /* ==================== 事件 ==================== */
  function render() { UI.render(); }
  /* 待办行内编辑提交：Enter / 失焦时保存，空值不覆盖；提交后退出编辑态。 */
  function commitTodoEdit(inputEl) {
    const id = state.editingTodo;
    if (!id || !inputEl || !inputEl.isConnected) return;
    const v = String(inputEl.value || "").trim();
    const t = todos.find(x => x.id === id);
    state.editingTodo = null;
    if (t && v) t.title = v;
    render();
  }
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-c078-act]");
    if (!el) return;
    const act = el.dataset.c078Act;
    if (act === "tab") { state.tab = el.dataset.tab; render(); return; }
    if (act === "day-tab") { state.dayTab = el.dataset.tab; render(); return; }
    if (act === "range") { state.usageRange = el.dataset.key; render(); return; }
    if (act === "refresh") { toast("已刷新用量统计（原型演示，数据不变）"); return; }
    if (act === "shift-month" || act === "shift-year") {
      const [y, m] = state.view.split("-").map(Number);
      const d = Number(el.dataset.d) * (act === "shift-year" ? 12 : 1);
      const dt = new Date(y, m - 1 + d, 1);
      state.view = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`; render(); return;
    }
    if (act === "today") { state.picker = false; state.view = `${TODAY.getFullYear()}-${pad2(TODAY.getMonth() + 1)}`; state.selected = ymd(TODAY); render(); return; }
    if (act === "open-picker") { state.picker = !state.picker; if (state.picker) state.pickerYear = Number(state.view.slice(0, 4)); render(); return; }
    if (act === "picker-year") { state.pickerYear = (state.pickerYear || Number(state.view.slice(0, 4))) + Number(el.dataset.d); render(); return; }
    if (act === "pick-month") { state.view = `${state.pickerYear || Number(state.view.slice(0, 4))}-${pad2(Number(el.dataset.m))}`; state.picker = false; render(); return; }
    if (act === "close-picker") { state.picker = false; render(); return; }
    if (act === "select") {
      if (e.target.closest("[data-c078-act='new']") || e.target.closest("[data-c078-act='del']")) return;
      state.selected = el.dataset.date; render(); return;
    }
    if (act === "new") { eventForm(el.dataset.date || state.selected, null); return; }
    if (act === "edit") { eventForm(null, el.dataset.id); return; }
    if (act === "del") {
      const ev = events.find(x => x.id === el.dataset.id);
      openDialog(dlgShell("删除日程", "", `<p class="small">确定删除「${esc(ev.title)}」？此操作只影响本机日程，不可撤销。</p>`, `<button class="btn" data-act="close-dialog">取消</button><button class="btn danger" data-c078-act="del-confirm" data-id="${ev.id}">删除</button>`)); return;
    }
    if (act === "del-confirm") { events = events.filter(x => x.id !== el.dataset.id); closeDialog(); toast("日程已删除"); render(); return; }
    if (act === "save-event") {
      const id = el.dataset.id;
      const title = document.getElementById("c078-title").value.trim();
      const start = document.getElementById("c078-start").value, end = document.getElementById("c078-end").value;
      const allDay = document.querySelector('input[name="c078-allday"]:checked').value === "1";
      const color = document.querySelector('input[name="c078-color"]:checked').value;
      const err = document.getElementById("c078-err");
      const fail = msg => { err.textContent = msg; err.hidden = false; };
      if (!title) return fail("请填写标题");
      if (!start || !end) return fail("请选择开始与结束日期");
      if (end < start) return fail("结束日期不能早于开始日期");
      const payload = { title, start, end, allDay, time: allDay ? "" : document.getElementById("c078-time").value, endTime: allDay ? "" : document.getElementById("c078-endtime").value, note: document.getElementById("c078-note").value.trim(), color };
      if (id) Object.assign(events.find(x => x.id === id), payload); else events.push({ id: "e" + seq++, ...payload });
      closeDialog(); toast(id ? "日程已更新" : "日程已创建");
      state.selected = start; state.view = start.slice(0, 7); render(); return;
    }
    if (act === "todo-toggle") {
      const t = todos.find(x => x.id === el.dataset.id); t.done = el.checked; render(); return;
    }
    if (act === "todo-edit") { state.editingTodo = el.dataset.id; render(); setTimeout(() => { const i = document.getElementById("c078-todo-edit-input"); if (i) { i.focus(); i.select(); } }, 0); return; }
  }, true);
  document.addEventListener("change", e => {
    const r = e.target.closest('input[name="c078-allday"]'); if (!r) return;
    const allDay = r.value === "1";
    ["c078-time", "c078-endtime"].forEach(i => { document.getElementById(i).disabled = allDay; });
  });
  document.addEventListener("submit", e => {
    const f = e.target.closest("[data-c078-form='todo']"); if (!f) return;
    e.preventDefault();
    const input = f.querySelector("input"); const v = input.value.trim(); if (!v) return;
    todos.push({ id: "t" + Date.now(), date: state.selected, title: v, done: false });
    toast("待办已添加"); render();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches(".c078-cell") && !e.target.closest("button")) { state.selected = e.target.dataset.date; render(); }
    if (e.key === "Enter" && e.target.matches(".c078-cell-add")) { e.stopPropagation(); }
    if (e.target.matches(".c078-todo-edit")) { if (e.key === "Enter") { e.preventDefault(); commitTodoEdit(e.target); } else if (e.key === "Escape") { state.editingTodo = null; render(); } }
    if (e.key === "Escape" && state.picker) { state.picker = false; render(); }
  });
  document.addEventListener("blur", e => { if (e.target && e.target.matches && e.target.matches(".c078-todo-edit")) commitTodoEdit(e.target); }, true);
  /* 趋势图悬停浮层：显示该小时总量、各模型明细（色点＝堆叠段＝排行走廊同色）与缓存命中率。 */
  function hideTip() {
    const tip = document.querySelector(".c078-tip"); if (tip) tip.hidden = true;
  }
  document.addEventListener("mousemove", e => {
    const bar = e.target.closest(".c078-bar");
    const tip = document.querySelector(".c078-tip");
    if (!tip) return;
    if (!bar || !bar.dataset.c078Hour) { hideTip(); return; }
    const hour = Number(bar.dataset.c078Hour);
    const rows = [...bar.querySelectorAll("i[data-model]")].map((i) => ({
      name: i.dataset.model, tokens: Number(i.dataset.tokens), color: i.style.background,
    }));
    const total = Number(bar.dataset.tipTotal) || 0;
    const hit = bar.dataset.tipHit;
    // 模型多时浮层会顶出绘图区，只列前 TIP_ROWS 个，其余汇总成一行，保证浮层高度可控。
    const shown = rows.slice(0, TIP_ROWS), rest = rows.slice(TIP_ROWS);
    const restTokens = rest.reduce((a, r) => a + r.tokens, 0);
    tip.innerHTML = `<div class="c078-tip-h">按小时 · ${pad2(hour)}:00</div>
<div class="c078-tip-total">总用量：${total.toLocaleString()}</div>
${shown.map((r) => `<div class="c078-tip-row"><i style="background:${r.color}"></i><b>${esc(r.name)}</b><span>${r.tokens.toLocaleString()}</span></div>`).join("")}
${rest.length ? `<div class="c078-tip-row c078-tip-rest"><i style="background:var(--muted-2)"></i><b>其余 ${rest.length} 个模型</b><span>${restTokens.toLocaleString()}</span></div>` : ""}
${hit ? `<div class="c078-tip-hit">缓存命中率：${hit}%</div>` : ""}`;
    tip.hidden = false;
    const wrap = tip.parentElement.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const left = Math.min(Math.max(barRect.left - wrap.left - 20, 4), Math.max(wrap.width - tip.offsetWidth - 4, 4));
    const top = Math.max(Math.min(barRect.top - wrap.top - tip.offsetHeight - 8, wrap.height - tip.offsetHeight - 4), 4);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  document.addEventListener("mouseleave", hideTip, true);

  /* 覆盖式接管首页「概览」（workbench 路由键不变）。main.js 的首屏渲染可能晚于本脚本同步执行，
     所以同步重绘一次，并在 load 后再重绘一次，确保首屏是概览而不是旧工作台。 */
  const Screens = window.Screens = window.Screens || {};
  const prevHome = Screens.home;
  Screens.home = page => page === "workbench" && window.CR078 ? (state.tab === "usage" ? usagePage() : schedulePage()) : prevHome(page);
  const repaint = () => { if (UI.store.active === "home" && UI.store.homePage === "workbench") UI.render(); };
  repaint();
  if (document.readyState === "complete") setTimeout(repaint, 0); else window.addEventListener("load", () => setTimeout(repaint, 0), { once: true });
  return { version: "UI-CR078-v8", state, dayInfo, toLunar, termOf, eventsOn, get events() { return events; }, get todos() { return todos; } };
})();
