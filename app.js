"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SINGAPORE_TZ = "Asia/Singapore";
const formatterCache = new Map();

const SESSION_TZ = SINGAPORE_TZ;
const MARKET_TZ = "America/New_York";
const LONDON_TZ = "Europe/London";
// General underlying NQ futures reference, not a broker-specific spot-CFD schedule.
// Cash-exchange holidays do not determine futures/CFD holiday trading hours.
const CFD_SCHEDULE = { closeHour: 17, closeMinute: 0, reopenHour: 18, reopenMinute: 0 };

const mainSessions = [
  { id: "asia-overnight", label: "Asia", note: "Regional overnight context, not an exchange session", tone: "range", kind: "main", zone: SESSION_TZ },
  { id: "europe-pre-market", label: "London", note: "London cash-market reference", tone: "bias", kind: "main", zone: LONDON_TZ },
  { id: "us-cash-session", label: "New York", note: "Nasdaq regular session / main liquidity", tone: "main", kind: "main", zone: MARKET_TZ }
];

const statusWindows = [
  { id: "after-hours", label: "After-hours", note: "Low liquidity", tone: "low", kind: "status" },
  { id: "daily-pause", label: "Daily pause", note: "Market paused", tone: "avoid", kind: "status" },
  { id: "early-cfd-reopen", label: "Early CFD reopen", note: "Observe", tone: "observe", kind: "status" }
];

const sessions = [...mainSessions, ...statusWindows];
const widgetSymbols = {
  "CAPITALCOM:US100": { name: "NAS100 / Nasdaq 100 Spot CFD", tag: "PRIMARY NAS100 SPOT CFD" },
  "CAPITALCOM:US500": { name: "US500 / S&P 500 Cash CFD", tag: "US500 / BROAD RISK CONFIRMATION" },
  "CAPITALCOM:US30": { name: "US30 / Dow Cash CFD", tag: "US30 / BROADER SENTIMENT" },
  "TVC:US10Y": { name: "U.S. 10Y Treasury Yield", tag: "DURATION / RATES · TV CHART USB10YUSD PROXY", interval: "D", range: "12M", chartSymbol: "OANDA:USB10YUSD" },
  "CBOE:VXN": { name: "Nasdaq-100 Volatility Index", tag: "NASDAQ-SPECIFIC FEAR · TV CHART VIXY", interval: "D", range: "12M", chartSymbol: "CBOE:VIXY" },
  "NASDAQ:SOX": { name: "PHLX Semiconductor Index", tag: "CHIP / AI LEADERSHIP · TV CHART SOXX", interval: "D", range: "12M", chartSymbol: "NASDAQ:SOXX" },
  "TVC:DXY": { name: "U.S. Dollar Index", tag: "GLOBAL FX CONDITIONS · TV CHART CAPITALCOM:DXY", interval: "D", range: "12M", chartSymbol: "CAPITALCOM:DXY" }
};

const tickerDefinitions = [
  { id: "NDX", label: "NAS100 / NDX", fallback: "NAS100" },
  { id: "SPX", label: "US500", fallback: "SPX" },
  { id: "DJI", label: "US30", fallback: "US30" },
  { id: "US10Y", label: "U.S. 10Y", fallback: "US10Y" },
  { id: "VXN", label: "VXN", fallback: "VXN" },
  { id: "SOX", label: "Semis", fallback: "SOX" },
  { id: "DXY", label: "Dollar", fallback: "DXY" }
];

let activeSymbol = "CAPITALCOM:US100";
let latestRefresh = null;
let latestMarketPulse = null;
let latestMarketItems = [];
let tickerResizeTimer = null;
let latestCompanies = [];
let latestNewsPulse = null;
let latestCalendar = null;
let latestCalendarPulse = null;
let latestStaticBuild = null;
let feedDeliveryMode = "checking";
let needsDataRetry = false;
let refreshBusy = false;
let holidayRenderKey = "";
let windowsCache = { key: "", windows: [] };
const WIDGETS_DISABLED = new URLSearchParams(location.search).has("no-widgets");
const healthState = { market: "checking", charts: "checking", calendar: "checking", news: "checking" };
const healthMeta = { market: null, charts: null, calendar: null, news: null };
const healthLabels = { market: "Markets", charts: "Charts", calendar: "Calendar", news: "News" };

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatter(timeZone, options) {
  const key = `${timeZone}:${JSON.stringify(options)}`;
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat("en-GB", { timeZone, ...options }));
  }
  return formatterCache.get(key);
}

function zonedParts(date, timeZone) {
  const values = Object.fromEntries(
    formatter(timeZone, {
      weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value])
  );
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: values.weekday
  };
}

function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += desired - rendered;
  }
  return new Date(guess);
}

function calendarDate(parts, offsetDays = 0) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function countdown(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const clock = [hours, minutes, secs].map(value => String(value).padStart(2, "0")).join(":");
  return days ? `${days}d ${clock}` : clock;
}

function sgtHourMinute(date) {
  return formatter(SESSION_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function sgtDayHourMinute(date) {
  return formatter(SESSION_TZ, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function ymd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = calendarDate({ year, month, day: 1 });
  const offset = (weekday - first.weekday + 7) % 7;
  return calendarDate({ year, month, day: 1 + offset + (n - 1) * 7 });
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = calendarDate({ year, month: month + 1, day: 0 });
  const offset = (last.weekday - weekday + 7) % 7;
  return calendarDate(last, -offset);
}

function observedFixedHoliday(year, month, day) {
  const holiday = calendarDate({ year, month, day });
  if (holiday.weekday === 6) return calendarDate(holiday, -1);
  if (holiday.weekday === 0) return calendarDate(holiday, 1);
  return holiday;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return calendarDate({ year, month, day });
}

const nasdaqHolidayCache = new Map();

function nasdaqHolidayKeysForYear(year) {
  if (nasdaqHolidayCache.has(year)) return nasdaqHolidayCache.get(year);
  const keys = new Set();
  const add = parts => keys.add(ymd(parts));
  // Nasdaq does not observe a Saturday New Year's Day on the preceding Friday.
  const newYear = calendarDate({ year, month: 1, day: 1 });
  if (newYear.weekday !== 6) add(observedFixedHoliday(year, 1, 1));
  add(nthWeekdayOfMonth(year, 1, 1, 3));
  add(nthWeekdayOfMonth(year, 2, 1, 3));
  add(calendarDate(easterSunday(year), -2));
  add(lastWeekdayOfMonth(year, 5, 1));
  add(observedFixedHoliday(year, 6, 19));
  add(observedFixedHoliday(year, 7, 4));
  add(nthWeekdayOfMonth(year, 9, 1, 1));
  add(nthWeekdayOfMonth(year, 11, 4, 4));
  add(observedFixedHoliday(year, 12, 25));
  nasdaqHolidayCache.set(year, keys);
  return keys;
}

function isNasdaqHoliday(parts) {
  const key = ymd(parts);
  for (const year of [parts.year - 1, parts.year, parts.year + 1]) {
    if (nasdaqHolidayKeysForYear(year).has(key)) return true;
  }
  return false;
}

function isWeekday(parts) {
  return parts.weekday >= 1 && parts.weekday <= 5;
}

function isNasdaqTradingDate(parts) {
  return isWeekday(parts) && !isNasdaqHoliday(parts);
}

function isCfdScheduleDate(parts) {
  return isWeekday(parts);
}


function partsToDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function sameYmd(a, b) {
  return a && b && a.year === b.year && a.month === b.month && a.day === b.day;
}

function nasdaqMarketHolidaysForYear(year) {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  const events = [
    ...(calendarDate({ year, month: 1, day: 1 }).weekday === 6 ? [] : [{ name: "New Year's Day", type: "closed", parts: observedFixedHoliday(year, 1, 1) }]),
    { name: "Martin Luther King Jr. Day", type: "closed", parts: nthWeekdayOfMonth(year, 1, 1, 3) },
    { name: "Presidents' Day", type: "closed", parts: nthWeekdayOfMonth(year, 2, 1, 3) },
    { name: "Good Friday", type: "closed", parts: calendarDate(easterSunday(year), -2) },
    { name: "Memorial Day", type: "closed", parts: lastWeekdayOfMonth(year, 5, 1) },
    { name: "Juneteenth", type: "closed", parts: observedFixedHoliday(year, 6, 19) },
    { name: "Independence Day", type: "closed", parts: observedFixedHoliday(year, 7, 4) },
    { name: "Labor Day", type: "closed", parts: nthWeekdayOfMonth(year, 9, 1, 1) },
    { name: "Thanksgiving Day", type: "closed", parts: thanksgiving },
    { name: "Black Friday early close", type: "early", parts: calendarDate(thanksgiving, 1), closeHour: 13 },
    { name: "Christmas Eve early close", type: "early", parts: calendarDate({ year, month: 12, day: 24 }), closeHour: 13 },
    { name: "Christmas Day", type: "closed", parts: observedFixedHoliday(year, 12, 25) }
  ];
  const independenceEve = calendarDate({ year, month: 7, day: 3 });
  if (isWeekday(independenceEve) && !isNasdaqHoliday(independenceEve)) {
    events.push({ name: "Independence Day early close", type: "early", parts: independenceEve, closeHour: 13 });
  }
  return events.filter(event => isWeekday(event.parts) && (event.type === "closed" || !isNasdaqHoliday(event.parts)));
}

function holidayWindow(event) {
  const cashOpen = nyDateTime(event.parts, 9, 30);
  const normalClose = nyDateTime(event.parts, 16, 0);
  const earlyClose = event.type === "early" ? nyDateTime(event.parts, event.closeHour || 13, 0) : null;
  return { cashOpen, normalClose, earlyClose, start: event.type === "early" ? earlyClose : cashOpen, end: normalClose };
}

function bankHolidaysForYear(year) {
  const sundayObserved = (month, day) => {
    const parts = calendarDate({ year, month, day });
    return parts.weekday === 0 ? calendarDate(parts, 1) : parts;
  };
  const us = [
    ["New Year's Day", sundayObserved(1, 1)],
    ["Martin Luther King Jr. Day", nthWeekdayOfMonth(year, 1, 1, 3)],
    ["Presidents' Day", nthWeekdayOfMonth(year, 2, 1, 3)],
    ["Memorial Day", lastWeekdayOfMonth(year, 5, 1)],
    ["Juneteenth", sundayObserved(6, 19)],
    ["Independence Day", sundayObserved(7, 4)],
    ["Labor Day", nthWeekdayOfMonth(year, 9, 1, 1)],
    ["Columbus Day / Indigenous Peoples' Day", nthWeekdayOfMonth(year, 10, 1, 2)],
    ["Veterans Day", sundayObserved(11, 11)],
    ["Thanksgiving Day", nthWeekdayOfMonth(year, 11, 4, 4)],
    ["Christmas Day", sundayObserved(12, 25)]
  ];
  const ukObserved = (month, day, occupied = new Set()) => {
    let parts = calendarDate({ year, month, day });
    while (!isWeekday(parts) || occupied.has(ymd(parts))) parts = calendarDate(parts, 1);
    occupied.add(ymd(parts));
    return parts;
  };
  const christmasDates = new Set();
  // Reserve weekday dates before assigning substitutes (e.g. Boxing Day Monday).
  [25, 26].forEach(day => {
    const parts = calendarDate({ year, month: 12, day });
    if (isWeekday(parts)) christmasDates.add(ymd(parts));
  });
  const christmas = calendarDate({ year, month: 12, day: 25 });
  const boxing = calendarDate({ year, month: 12, day: 26 });
  const uk = [
    ["New Year's Day", ukObserved(1, 1)],
    ["Good Friday", calendarDate(easterSunday(year), -2)],
    ["Easter Monday", calendarDate(easterSunday(year), 1)],
    ["Early May bank holiday", nthWeekdayOfMonth(year, 5, 1, 1)],
    ["Spring bank holiday", lastWeekdayOfMonth(year, 5, 1)],
    ["Summer bank holiday", lastWeekdayOfMonth(year, 8, 1)],
    ["Christmas Day", isWeekday(christmas) ? christmas : ukObserved(12, 25, christmasDates)],
    ["Boxing Day", isWeekday(boxing) ? boxing : ukObserved(12, 26, christmasDates)]
  ];
  return [
    ...us.map(([name, parts]) => ({ name, parts, type: "bank", region: "US", zone: MARKET_TZ })),
    ...uk.map(([name, parts]) => ({ name, parts, type: "bank", region: "UK", zone: LONDON_TZ }))
  ];
}

function isLondonBankHoliday(parts) {
  return bankHolidaysForYear(parts.year).some(event => event.region === "UK" && sameYmd(parts, event.parts));
}

function bankHolidayWindow(event) {
  const start = zonedDateTimeToUtc(event.parts.year, event.parts.month, event.parts.day, 0, 0, event.zone);
  const next = calendarDate(event.parts, 1);
  const end = zonedDateTimeToUtc(next.year, next.month, next.day, 0, 0, event.zone);
  return { ...event, start, end, cashOpen: start, key: `${ymd(event.parts)}-${event.region}-bank-${event.name}` };
}

function upcomingMarketAndBankHolidays(now = new Date(), limit = 16) {
  const year = zonedParts(now, MARKET_TZ).year;
  const banks = [year - 1, year, year + 1].flatMap(bankHolidaysForYear).map(bankHolidayWindow)
    .filter(event => event.end > now);
  const exchange = upcomingNasdaqHolidays(now, 24);
  const combined = exchange.map(event => ({ ...event, bankHoliday: banks.some(bank => bank.region === "US" && sameYmd(bank.parts, event.parts)) }));
  // One US date can be both a cash closure and a banking holiday: show one row.
  const additionalBanks = banks.filter(bank => bank.region !== "US" || !exchange.some(event => event.type === "closed" && sameYmd(event.parts, bank.parts)));
  return [...combined, ...additionalBanks].sort((a, b) => a.start - b.start).slice(0, limit);
}

function upcomingNasdaqHolidays(now = new Date(), limit = 8) {
  const nyNow = zonedParts(now, MARKET_TZ);
  const nowKey = ymd(nyNow);
  const events = [];
  for (const year of [nyNow.year - 1, nyNow.year, nyNow.year + 1]) {
    nasdaqMarketHolidaysForYear(year).forEach(event => {
      const window = holidayWindow(event);
      const eventKey = ymd(event.parts);
      if (window.end >= new Date(now.getTime() - 3600000) || eventKey === nowKey) {
        events.push({ ...event, ...window, key: `${eventKey}-${event.type}-${event.name}` });
      }
    });
  }
  return [...new Map(events.map(event => [event.key, event])).values()]
    .sort((a, b) => a.start - b.start)
    .slice(0, limit);
}

function holidaySgtLabel(event) {
  if (event.type === "early") {
    return `Closes ${sgtDayHourMinute(event.earlyClose)} SGT / ${String(event.closeHour || 13).padStart(2, "0")}:00 ET`;
  }
  return `Cash closed ${sgtDayHourMinute(event.cashOpen)}-${sgtDayHourMinute(event.normalClose)} SGT`;
}

function holidayEtLabel(event) {
  const label = formatter(MARKET_TZ, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(event.cashOpen);
  return `${label} ET`;
}

function holidayState(event, now = new Date()) {
  if (event.type === "bank") {
    return event.start <= now && now < event.end ? "today" : "upcoming";
  }
  const nyNow = zonedParts(now, MARKET_TZ);
  if (sameYmd(event.parts, nyNow)) return "today";
  if (event.start <= now && now < event.end) return "active";
  return "upcoming";
}


function holidayNoticeInfo(now = new Date()) {
  const events = upcomingNasdaqHolidays(now, 4);
  const current = events.find(event => holidayState(event, now) === "today" || holidayState(event, now) === "active");
  if (current) {
    const title = current.type === "early" ? "Nasdaq early close today" : "Nasdaq cash holiday today";
    const detail = current.type === "early"
      ? `${current.name}: ${holidaySgtLabel(current)}. Expect cash liquidity to thin after the early close; CFD hours may differ.`
      : `${current.name}: ${holidaySgtLabel(current)}. NAS100 CFD may still quote, but Nasdaq cash liquidity is closed.`;
    return { tone: current.type === "early" ? "early" : "closed", title, detail };
  }
  const soon = events.find(event => event.start > now && event.start - now <= 7 * 86400000);
  if (soon) {
    const title = soon.type === "early" ? "Upcoming Nasdaq early close" : "Upcoming Nasdaq cash holiday";
    const detail = `${soon.name}: ${holidaySgtLabel(soon)} · ${holidayEtLabel(soon)}`;
    return { tone: soon.type === "early" ? "early" : "upcoming", title, detail };
  }
  const bank = upcomingMarketAndBankHolidays(now).find(event => event.type === "bank" && holidayState(event, now) === "today");
  return bank ? { tone: "upcoming", title: `${bank.region} bank holiday today`, detail: `${bank.name}. ${bank.region === "UK" ? "London participation may be lower; Nasdaq follows its U.S. calendar." : "U.S. banking/settlement holiday; Nasdaq cash closes only on exchange holidays."}` } : null;
}

function renderHolidayNotice(now = new Date()) {
  const notice = $("#holidayNotice");
  if (!notice) return;
  const info = holidayNoticeInfo(now);
  notice.classList.toggle("hidden", !info);
  if (!info) return;
  notice.classList.toggle("closed", info.tone === "closed");
  notice.classList.toggle("early", info.tone === "early");
  notice.classList.toggle("upcoming", info.tone === "upcoming");
  $("#holidayNoticeTitle").textContent = info.title;
  $("#holidayNoticeDetail").textContent = info.detail;
}
function renderHolidayCalendar() {
  const list = $("#holidayList");
  const status = $("#holidayStatus");
  if (!list || !status) return;
  const now = new Date();
  const events = upcomingMarketAndBankHolidays(now);
  if (!events.length) {
    status.className = "source-status delayed";
    status.textContent = "NO UPCOMING";
    list.innerHTML = '<div class="empty-feed">No upcoming Nasdaq market holidays were found in the generated schedule.</div>';
    return;
  }
  const current = events.find(event => holidayState(event, now) === "today" || holidayState(event, now) === "active");
  status.className = `source-status ${current ? "delayed" : "live"}`;
  status.textContent = current ? "HOLIDAY NOW" : "LOCAL SCHEDULE";
  const renderKey = events.map(event => `${event.key}:${holidayState(event, now)}`).join("|");
  if (renderKey === holidayRenderKey) return;
  holidayRenderKey = renderKey;
  const renderEvent = event => {
    const state = holidayState(event, now);
    const badge = event.type === "bank" ? `${event.region} BANK${state === "today" ? " · TODAY" : ""}` : event.bankHoliday && event.type === "closed" ? `CASH + US BANK${state === "today" ? " · TODAY" : ""}` : state === "today" ? "TODAY" : event.type === "early" ? "EARLY CLOSE" : "CLOSED";
    if (event.type === "bank") {
      const date = formatter(event.zone, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(event.start);
      const note = event.region === "UK" ? "England & Wales bank holiday; London participation may be lower. Nasdaq follows its U.S. exchange calendar." : "Federal Reserve bank holiday; Nasdaq can remain open. Banking and settlement availability may be reduced.";
      return `<article class="holiday-item bank ${escapeHtml(state)}"><div class="holiday-date"><strong>${escapeHtml(formatter(event.zone, { day: "2-digit", month: "short" }).format(event.start))}</strong><small>${escapeHtml(event.region)}</small></div><div class="holiday-copy"><h5>${escapeHtml(event.name)}</h5><p>${escapeHtml(date)} · ${escapeHtml(event.region)} local date</p><p>${escapeHtml(note)}</p></div><span class="holiday-badge">${escapeHtml(badge)}</span></article>`;
    }
    const note = event.type === "early"
      ? "Nasdaq cash market closes at 1:00 p.m. ET; liquidity usually thins after the early close."
      : "Nasdaq cash market is closed; NAS100 CFD availability can still vary by broker.";
    return `<article class="holiday-item ${escapeHtml(event.type)} ${escapeHtml(state)}">
      <div class="holiday-date"><strong>${escapeHtml(formatter(SESSION_TZ, { day: "2-digit", month: "short" }).format(event.cashOpen))}</strong><small>SGT</small></div>
      <div class="holiday-copy"><h5>${escapeHtml(event.name)}</h5><p>${escapeHtml(holidaySgtLabel(event))}</p><p>${escapeHtml(holidayEtLabel(event))} · ${escapeHtml(note)}</p></div>
      <span class="holiday-badge ${escapeHtml(event.type)} ${escapeHtml(state)}">${escapeHtml(badge)}</span>
    </article>`;
  };
  const years = new Map();
  events.forEach(event => {
    const { year, month } = event.parts;
    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(event);
  });
  list.innerHTML = [...years].map(([year, months]) => {
    const monthGroups = [...months].map(([month, items]) => {
      const monthName = formatter("UTC", { month: "long" }).format(new Date(Date.UTC(year, month - 1, 1)));
      return `<section class="holiday-month-group" aria-label="${escapeHtml(monthName)} ${year}"><h4 class="holiday-month-label">${escapeHtml(monthName)}</h4>${items.map(renderEvent).join("")}</section>`;
    }).join("");
    return `<section class="holiday-year-group" aria-label="Holidays in ${year}"><h3 class="holiday-year-label">${year}</h3>${monthGroups}</section>`;
  }).join("");
}
function nyDateTime(parts, hour, minute = 0) {
  return zonedDateTimeToUtc(parts.year, parts.month, parts.day, hour, minute, MARKET_TZ);
}

function sgtDateTime(parts, hour, minute = 0) {
  return zonedDateTimeToUtc(parts.year, parts.month, parts.day, hour, minute, SESSION_TZ);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function formatTimeRange(start, end) {
  const crossesMidnight = !sameYmd(zonedParts(start, SESSION_TZ), zonedParts(end, SESSION_TZ));
  return `${sgtHourMinute(start)}–${sgtHourMinute(end)}${crossesMidnight ? " (+1 day)" : ""}`;
}

function zoneOffsetMinutes(date, zone) {
  const parts = zonedParts(date, zone);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(+date / 1000) * 1000) / 60000);
}

function zoneClockLabel(zone, now) {
  const offset = zoneOffsetMinutes(now, zone);
  return zone === SESSION_TZ ? "SGT · UTC+8" : zone === LONDON_TZ ? (offset === 60 ? "BST · UTC+1" : "GMT · UTC+0") : (offset === -240 ? "EDT · UTC−4" : "EST · UTC−5");
}

function clockSeason(zone, now = new Date()) {
  const offset = zoneOffsetMinutes(now, zone);
  if (zone === SESSION_TZ) return { short: "SGT · UTC+8", detail: "Singapore time year-round. No daylight-saving clock changes.", next: null };
  const isLondon = zone === LONDON_TZ;
  const daylight = offset === (isLondon ? 60 : -240);
  const short = zoneClockLabel(zone, now);
  let previous = now;
  let next = null;
  // Read the installed time-zone database, not a shared 'summer' flag or hard-coded SGT dates.
  for (let day = 1; day <= 370; day++) {
    const candidate = new Date(+now + day * 86400000);
    if (zoneOffsetMinutes(candidate, zone) !== offset) {
      let low = Math.floor(+previous / 1000) * 1000, high = Math.ceil(+candidate / 1000) * 1000;
      while (high - low > 1000) {
        const mid = Math.floor((low + high) / 2000) * 1000;
        if (zoneOffsetMinutes(new Date(mid), zone) === offset) low = mid; else high = mid;
      }
      next = new Date(Math.ceil(high / 1000) * 1000);
      break;
    }
    previous = candidate;
  }
  const nextLabel = next ? `${formatter(SESSION_TZ, { day: "2-digit", month: "short", year: "numeric" }).format(next)} at ${sgtHourMinute(next)} SGT` : "not available";
  return { short, next, daylight, detail: `${isLondon ? (daylight ? "British Summer Time" : "Greenwich Mean Time / standard time") : (daylight ? "U.S. daylight-saving time" : "U.S. Eastern Standard Time")}. Next clock change: ${nextLabel}.` };
}

let seasonsCache = { key: "", value: null };
function sessionSeasons(now = new Date()) {
  // Includes offsets so the descriptions switch at the actual Sunday clock-change instant.
  const key = `${ymd(zonedParts(now, SESSION_TZ))}:${zoneOffsetMinutes(now, LONDON_TZ)}:${zoneOffsetMinutes(now, MARKET_TZ)}`;
  if (seasonsCache.key !== key) seasonsCache = { key, value: new Map([SESSION_TZ, LONDON_TZ, MARKET_TZ].map(zone => [zone, clockSeason(zone, now)])) };
  return seasonsCache.value;
}

function londonSchedule(parts) {
  const holiday = bankHolidaysForYear(parts.year).find(event => event.region === "UK" && sameYmd(parts, event.parts));
  const earlyClose = !holiday && parts.month === 12 && [24, 31].includes(parts.day);
  const local = (hour, minute) => zonedDateTimeToUtc(parts.year, parts.month, parts.day, hour, minute, LONDON_TZ);
  return { start: local(8, 0), end: local(earlyClose ? 12 : 16, 30), holiday: holiday?.name || null, earlyClose };
}

function sessionById(id) {
  return sessions.find(session => session.id === id);
}

function attachWindowMeta(sessionId, start, end, meta = {}) {
  const session = sessionById(sessionId);
  return { ...session, ...meta, start, end, timeLabel: formatTimeRange(start, end) };
}

function buildWindows(now) {
  const sgtParts = zonedParts(now, SESSION_TZ);
  const cacheKey = ymd(sgtParts);
  if (windowsCache.key === cacheKey) return windowsCache.windows;
  const windows = [];
  for (let offset = -3; offset <= 14; offset += 1) {
    const tradingDate = calendarDate(sgtParts, offset);
    if (!isCfdScheduleDate(tradingDate)) continue;
    const cashHoliday = isNasdaqHoliday(tradingDate);
    const asiaStart = sgtDateTime(tradingDate, 8, 0);
    const asiaEnd = sgtDateTime(tradingDate, 17, 0);
    const london = londonSchedule(tradingDate);
    const londonHoliday = isLondonBankHoliday(tradingDate);
    const cashOpen = nyDateTime(tradingDate, 9, 30);
    const earlyClose = nasdaqMarketHolidaysForYear(tradingDate.year).find(event => event.type === "early" && sameYmd(event.parts, tradingDate));
    const cashClose = nyDateTime(tradingDate, earlyClose ? 13 : 16, 0);
    const afterClose = nyDateTime(tradingDate, CFD_SCHEDULE.closeHour, CFD_SCHEDULE.closeMinute);
    const holidayMeta = { cashHoliday, tradingDate, earlyClose: Boolean(earlyClose) };
    // Each trading day starts with the preceding evening's reopen. Monday uses Sunday.
    const previousDate = calendarDate(tradingDate, -1);
    const reopen = nyDateTime(previousDate, CFD_SCHEDULE.reopenHour, CFD_SCHEDULE.reopenMinute);
    windows.push(attachWindowMeta("early-cfd-reopen", reopen, asiaStart, holidayMeta));
    windows.push(attachWindowMeta("asia-overnight", asiaStart, asiaEnd, holidayMeta));
    windows.push(attachWindowMeta("europe-pre-market", london.start, london.end, { ...holidayMeta, londonHoliday, unavailable: Boolean(london.holiday), closureReason: london.holiday, earlyClose: london.earlyClose }));
    if (!cashHoliday) windows.push(attachWindowMeta("us-cash-session", cashOpen, cashClose, holidayMeta));
    else windows.push(attachWindowMeta("us-cash-session", cashOpen, cashClose, { ...holidayMeta, unavailable: true, closureReason: nasdaqMarketHolidaysForYear(tradingDate.year).find(event => event.type === "closed" && sameYmd(event.parts, tradingDate))?.name || "Nasdaq holiday" }));
    windows.push(attachWindowMeta("after-hours", cashClose, afterClose, holidayMeta));
    // Friday ends the trading week; there is no Saturday CFD reopen.
    if (tradingDate.weekday !== 5) {
      const pauseEnd = nyDateTime(tradingDate, CFD_SCHEDULE.reopenHour, CFD_SCHEDULE.reopenMinute);
      windows.push(attachWindowMeta("daily-pause", afterClose, pauseEnd, holidayMeta));
    }
  }
  windowsCache = { key: cacheKey, windows: windows.sort((a, b) => a.start - b.start) };
  return windowsCache.windows;
}

function activeWindow(now) {
  // Header priority is separate from card states: every overlapping card stays independently open.
  const priority = ["daily-pause", "us-cash-session", "europe-pre-market", "asia-overnight", "after-hours", "early-cfd-reopen"];
  const active = buildWindows(now).filter(window => now >= window.start && now < window.end);
  const primary = active.find(window => window.id === "daily-pause") || active.find(window => window.id === "us-cash-session");
  if (primary) return primary;
  return priority.map(id => active.find(window => window.id === id && !window.unavailable)).find(Boolean)
    || active.find(window => window.id === "us-cash-session") || active[0] || null;
}

function nextWindowAfter(now, predicate = () => true) {
  return buildWindows(now).find(window => window.start > now && predicate(window)) || null;
}

function sessionState(now, config) {
  const ownWindows = buildWindows(now).filter(window => window.id === config.id);
  const active = ownWindows.find(window => now >= window.start && now < window.end);
  const upcoming = ownWindows.find(window => window.start > now && !window.unavailable);
  const localDate = calendarDate(zonedParts(now, config.zone || MARKET_TZ));
  const holiday = ownWindows.find(window => sameYmd(window.tradingDate, localDate) && window.unavailable);
  const overlaps = active && !active.unavailable ? buildWindows(now).filter(window => window.kind === "main" && window.id !== config.id && !window.unavailable && now >= window.start && now < window.end) : [];
  if (active && !active.unavailable) {
    return {
      active: true,
      open: active.tone !== "avoid" && !active.unavailable,
      tone: active.tone,
      target: active.end,
      openSg: sgtHourMinute(active.start),
      closeSg: sgtHourMinute(active.end),
      timeLabel: active.timeLabel,
      window: active,
      overlaps,
      statusText: active.tone === "avoid" ? "PAUSED NOW" : config.kind === "main" ? (overlaps.length ? "OPEN · OVERLAP" : "OPEN NOW") : (active.cashHoliday || (active.earlyClose && active.id === "after-hours") ? "HOURS UNCONFIRMED" : "ACTIVE NOW"),
      timerLabel: config.kind === "main" ? "Closes in" : "Ends in"
    };
  }
  if (upcoming) {
    return {
      active: false,
      open: false,
      tone: upcoming.tone,
      target: upcoming.start,
      openSg: sgtHourMinute(upcoming.start),
      closeSg: sgtHourMinute(upcoming.end),
      timeLabel: upcoming.timeLabel,
      window: upcoming,
      overlaps: [],
      closureReason: holiday?.closureReason || null,
      statusText: config.kind === "main" ? (holiday ? "CLOSED · HOLIDAY" : !isWeekday(localDate) ? "CLOSED · WEEKEND" : "CLOSED") : "UPCOMING",
      timerLabel: config.kind === "main" ? "Opens in" : "Starts in"
    };
  }
  return { active: false, open: false, tone: config.tone, target: now, openSg: "--:--", closeSg: "--:--", timeLabel: config.timeLabel || "--:-----:--", statusText: "CLOSED", timerLabel: "Starts in" };
}

function closedMarketState(now) {
  const upcoming = nextWindowAfter(now);
  const nyParts = calendarDate(zonedParts(now, MARKET_TZ));
  const reason = [0, 5, 6].includes(nyParts.weekday) ? "Weekend" : (isNasdaqHoliday(nyParts) ? "Holiday" : "Between sessions");
  return {
    open: false,
    title: "Market closed",
    detail: reason,
    target: upcoming?.start || now,
    label: upcoming ? "Until CFD reopen" : "Until next session"
  };
}

function nasdaqMarketState(now) {
  const current = activeWindow(now);
  if (!current) return closedMarketState(now);
  const pause = nextWindowAfter(now, window => window.id === "daily-pause");
  const weeklyClose = buildWindows(now).find(window => window.id === "after-hours" && window.end > now && window.tradingDate.weekday === 5);
  const stop = [pause?.start, weeklyClose?.end].filter(Boolean).sort((a, b) => a - b)[0];
  const reopen = nextWindowAfter(now, window => window.id === "early-cfd-reopen");
  const isPaused = current.tone === "avoid";
  const cashClosed = current.id === "us-cash-session" && current.unavailable;
  const uncertainHolidayHours = current.cashHoliday || (current.earlyClose && current.id === "after-hours");
  return {
    open: !isPaused && !uncertainHolidayHours,
    title: isPaused ? "Reference paused" : cashClosed ? "Nasdaq cash closed" : uncertainHolidayHours ? "CFD hours unconfirmed" : current.id === "us-cash-session" ? "Nasdaq cash open" : "Reference open",
    detail: current.cashHoliday ? `Cash holiday / ${current.label}` : isLondonBankHoliday(zonedParts(now, LONDON_TZ)) ? "London / UK bank holiday" : current.label,
    target: isPaused ? reopen?.start || current.end : uncertainHolidayHours ? current.end : stop || current.end,
    label: isPaused ? "Until reference reopen" : uncertainHolidayHours ? "Until next window" : stop && weeklyClose && +stop === +weeklyClose.end ? "Until weekend close" : "Until daily pause"
  };
}
function updateClocks() {
  const now = new Date();
  $("#sgTime").textContent = formatter(SINGAPORE_TZ, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(now);
  $("#sgDate").textContent = `${formatter(SINGAPORE_TZ, { weekday: "short", day: "2-digit", month: "short" }).format(now)} SGT`;

  renderHolidayCalendar();
  renderHolidayNotice(now);
  const scheduleNote = $("#sessionScheduleNote");
  if (scheduleNote) {
    scheduleNote.textContent = "Independent windows can overlap. Asia is regional context; London and New York use their own cash-market calendars. Broker CFD hours are separate.";
  }
  const seasons = sessionSeasons(now);
  const openSessions = mainSessions.map(config => ({ config, state: sessionState(now, config) })).filter(({ state }) => state.open);
  const overlapNote = $("#sessionOverlapNote");
  if (overlapNote) overlapNote.textContent = openSessions.length > 1 ? `${openSessions.map(({ config }) => config.label).join(" + ")} overlap now · Each stays open until its own close.` : openSessions.length ? `${openSessions[0].config.label} window open · The other sessions keep their own schedules.` : "All three session windows are closed. Check the separate overnight reference status below.";

  const market = nasdaqMarketState(now);
  $("#marketState").textContent = market.title;
  $("#marketStateDetail").textContent = market.detail;
  $("#marketCountdown").textContent = countdown(market.target - now);
  $("#marketCountdownLabel").textContent = market.label;
  $("#marketDot").className = `market-dot ${market.open ? "open" : "closed"}`;

  sessions.forEach(session => {
    const state = sessionState(now, session);
    const card = $(`[data-session="${session.id}"]`);
    card.classList.toggle("open", state.active && (session.kind === "status" || state.open));
    card.classList.toggle("avoid", state.active && state.tone === "avoid");
    card.querySelector("h3").textContent = session.label;
    card.querySelector(".session-status").textContent = state.statusText || (state.open ? "OPEN NOW" : "CLOSED");
    card.querySelector(".session-timer strong").textContent = countdown(state.target - now);
    card.querySelector(".session-timer small").textContent = state.timerLabel || (state.open ? "Until close" : "Until open");
    const currentWindow = state.window;
    const holidayNote = state.closureReason ? `${state.closureReason} · next available session` : session.kind === "status" && state.active && currentWindow?.cashHoliday && state.tone !== "avoid" ? "Nasdaq cash closed / CFD hours unconfirmed" : currentWindow?.earlyClose && session.kind === "main" ? `${session.note} · early close` : session.note;
    card.querySelector(".session-local-time")?.replaceChildren(`${state.timeLabel || `${state.openSg}-${state.closeSg}`} SGT | ${holidayNote}`);
    if (session.kind === "main") {
      const season = seasons.get(session.zone);
      card.querySelector(".session-season")?.replaceChildren(`Now: ${season.short}`);
      card.querySelector(".session-season-description")?.replaceChildren(season.detail);
      const dateLabel = currentWindow ? formatter(SESSION_TZ, { weekday: "short", day: "2-digit", month: "short" }).format(currentWindow.start) : "";
      const windowClock = currentWindow ? zoneClockLabel(session.zone, currentWindow.start).split(" · ")[0] : "";
      const basis = session.id === "asia-overnight" ? "08:00–17:00 SGT · regional context" : session.id === "europe-pre-market" ? `08:00–${currentWindow?.earlyClose ? "12:30" : "16:30"} London (${windowClock}) · cash reference` : `09:30–${currentWindow?.earlyClose ? "13:00" : "16:00"} New York (${windowClock}) · Nasdaq regular`;
      card.querySelector(".session-basis")?.replaceChildren(`${state.active ? "Session" : "Next"}: ${dateLabel} · ${basis}`);
    }
  });
}

function renderHealthSummary() {
  const values = Object.values(healthState);
  const dot = $("#dataHealthDot");
  const summary = $("#dataHealthSummary");
  let state = "live";
  let title = "All data current";
  let detail = "All monitored sources are responding";
  if (values.includes("checking")) {
    state = "checking";
    title = "Checking live data";
    detail = "Connecting markets, charts, news and calendar";
  } else if (values.includes("offline")) {
    state = "offline";
    title = "Some data is unavailable";
    detail = "Unavailable sources are clearly marked below";
  } else if (values.includes("delayed")) {
    state = "delayed";
    const delayed = Object.entries(healthState)
      .filter(([, value]) => value === "delayed")
      .map(([key]) => healthMeta[key]?.summary || `${healthLabels[key] || key}: snapshot`);
    title = delayed.some(text => text.toLowerCase().includes("stale")) ? "Using stale snapshot data" : "Live with snapshot data";
    const build = latestStaticBuild?.snapshot_generated_at || latestStaticBuild?.updated_at;
    const buildDetail = build ? `App checked ${sgtClock(build)} SGT (${ageLabel(build)})` : "";
    detail = [buildDetail, delayed.length ? delayed.join(" - ") : "A cached or backup source is currently active"].filter(Boolean).join(" - ");
  }
  dot.className = `health-dot ${state}`;
  summary.textContent = title;
  $("#dataFreshness").textContent = detail;
}

function setHealth(key, state, label, meta) {
  healthState[key] = state;
  if (arguments.length >= 4) healthMeta[key] = meta;
  const element = $(`#${key}Health`);
  element.className = state;
  element.textContent = label || ({ live: "Live", delayed: "Backup", offline: "Offline", checking: "Checking" }[state]);
  element.title = healthMeta[key]?.detail || "";
  renderHealthSummary();
}

function mountWidget(container, scriptName, config, healthKey = null) {
  container.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "tradingview-widget-container__widget";
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = `https://s3.tradingview.com/external-embedding/${scriptName}`;
  script.async = true;
  script.textContent = JSON.stringify(config);
  if (healthKey) {
    setHealth(healthKey, "checking", "Loading");
    script.addEventListener("load", () => setHealth(healthKey, "live", "Live"));
    script.addEventListener("error", () => setHealth(healthKey, "offline", "Unavailable"));
  }
  container.append(shell, script);
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "" || value === "NaN") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tickerNumber(value, fallback = "--") {
  const number = finiteNumber(value, null);
  if (number === null) return fallback;
  const decimals = number >= 1000 ? 2 : number >= 100 ? 2 : number >= 10 ? 3 : 4;
  return number.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function tickerPercent(value) {
  const number = finiteNumber(value, null);
  if (number === null) return "waiting";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}
function renderTicker(items = []) {
  latestMarketItems = items;
  const byId = new Map(items.map(item => [item.id, item]));
  const cardWidth = window.matchMedia("(max-width: 560px)").matches ? 158 : 196;
  const repeats = Math.max(2, Math.ceil((window.innerWidth * 1.15) / (tickerDefinitions.length * cardWidth)));
  const sequence = Array.from({ length: repeats }, () => tickerDefinitions).flat();
  const cards = sequence.map(definition => {
    const item = byId.get(definition.id) || {};
    const change = finiteNumber(item.change_percent, null);
    const direction = change !== null ? (change > 0 ? "up" : change < 0 ? "down" : "flat") : "waiting";
    const price = finiteNumber(item.price, null) !== null ? tickerNumber(item.price) : definition.fallback;
    return `<article class="ticker-card ${direction}">
      <span class="ticker-dot" aria-hidden="true"></span>
      <span class="ticker-name">${escapeHtml(definition.label)}</span>
      <span class="ticker-value"><strong class="ticker-price">${escapeHtml(price)}</strong><span class="ticker-change">${escapeHtml(tickerPercent(item.change_percent))}</span></span>
    </article>`;
  }).join("");
  const strip = `<div class="ticker-strip">${cards}</div>`;
  $("#tickerWidget").innerHTML = strip;
  $("#tickerWidgetClone").innerHTML = strip;
}

function mountTicker() {
  renderTicker();
}

function mountChart(symbol = activeSymbol) {
  const compactChart = window.matchMedia("(max-width: 820px)").matches;
  activeSymbol = symbol;
  const meta = widgetSymbols[symbol] || widgetSymbols[activeSymbol] || { name: symbol, tag: "MARKET CHART" };
  $("#activeMarketName").textContent = meta.name;
  $("#activeMarketTag").textContent = meta.tag;
  $$("#marketTabs button").forEach(button => {
    const active = button.dataset.symbol === symbol;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (WIDGETS_DISABLED) {
    $("#marketChart").innerHTML = `<div class="widget-placeholder">${escapeHtml(meta.name)} chart paused for interface testing</div>`;
    return;
  }
  const chartConfig = {
    autosize: true, width: "100%", height: "100%", symbol: meta.chartSymbol || symbol, interval: meta.interval || "15", timezone: "Asia/Singapore", theme: "dark",
    style: "1", locale: "en", backgroundColor: "rgba(16, 23, 31, 1)",
    gridColor: "rgba(226, 232, 240, 0.055)", hide_top_toolbar: false,
    hide_side_toolbar: compactChart, hide_legend: false, withdateranges: true,
    allow_symbol_change: false, save_image: false, calendar: false, support_host: "https://www.tradingview.com"
  };
  if (meta.range) chartConfig.range = meta.range;
  mountWidget($("#marketChart"), "embed-widget-advanced-chart.js", chartConfig, "charts");
}

async function fetchJson(name) {
  const candidates = [`api/${name}`, `data/${name}.json`];
  let lastError = new Error("No data source responded");
  for (const path of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = new URL(path, document.baseURI);
      url.searchParams.set("v", String(Date.now()));
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) throw new Error("Response was not JSON");
      const payload = await response.json();
      if (path.startsWith("data/")) payload.static_snapshot = true;
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchStaticStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL("data/status.json", document.baseURI);
    url.searchParams.set("v", String(Date.now()));
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error("Response was not JSON");
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function renderStaticStatus(payload) {
  if (!payload?.snapshot_generated_at && !payload?.updated_at) return;
  latestStaticBuild = payload;
  document.body.classList.toggle("static-snapshot-mode", feedDeliveryMode === "snapshot");
  renderHealthSummary();
}

function configureSnapshotControls() {
  const refreshButton = $("#refreshData");
  if (refreshButton) {
    const snapshot = feedDeliveryMode === "snapshot";
    refreshButton.hidden = !snapshot && !needsDataRetry;
    refreshButton.querySelector("span").textContent = snapshot ? "Check updates" : "Retry data";
    refreshButton.setAttribute("aria-label", snapshot ? "Check for a newer published snapshot" : "Retry unavailable or backup data feeds");
    refreshButton.title = snapshot
      ? "Checks the latest published snapshot without leaving the app. This does not start a build."
      : "Retries the data sources. Healthy live data updates automatically.";
  }
}

function showRefreshFeedback(message) {
  const feedback = $("#refreshFeedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.hidden = !message;
  $(".data-health").classList.toggle("has-refresh-feedback", Boolean(message));
}

function preventMobileZoom() {
  const block = event => event.preventDefault();
  ["gesturestart", "gesturechange", "gestureend"].forEach(type => {
    document.addEventListener(type, block, { passive: false });
  });
  document.addEventListener("touchmove", event => {
    if (event.touches && event.touches.length > 1) event.preventDefault();
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", event => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) event.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
}

function relativeTime(value) {
  if (!value) return "Recently";
  const seconds = Math.round((new Date(value) - new Date()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60) return formatter.format(Math.round(seconds), "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}

function ageLabel(value) {
  return timestamp(value) ? relativeTime(value) : "age unknown";
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const date = timestamp(value);
    if (date) return date;
  }
  return null;
}

function sgtClock(value) {
  const date = timestamp(value);
  if (!date) return "time unknown";
  return formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function sgtStamp(value) {
  const date = timestamp(value);
  if (!date) return "time unknown";
  const day = formatter(SINGAPORE_TZ, { weekday: "short", day: "2-digit", month: "short" }).format(date);
  return `${day} ${sgtClock(date)} SGT`;
}


function sourceDateLabel(value) {
  if (!value) return "";
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const named = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})(?:\s+.*)?$/);
  if (named) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const month = months[named[1].slice(0, 3).toLowerCase()];
    if (month) return `${named[2].padStart(2, "0")}/${month}/${named[3]}`;
  }
  return text;
}

function nasdaqSourceDateLabel(value) {
  if (!value) return "";
  const text = String(value).trim().replace(/\s+/g, " ");
  const named = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})(?:\s+.*)?$/);
  if (named) return `${named[1].slice(0, 3)} ${Number(named[2])}, ${named[3]}`;
  return sourceDateLabel(value);
}

function isCalendarEventActive(event, graceMinutes = 60) {
  if (!event?.time_utc) return true;
  const date = timestamp(event.time_utc);
  return !date || date.getTime() >= Date.now() - graceMinutes * 60000;
}
function olderThan(value, minutes) {
  const date = timestamp(value);
  return Boolean(date && minutes && Date.now() - date.getTime() > minutes * 60000);
}

function compactDateLabel(value) {
  if (!value) return "";
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dmy = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  let day = "";
  let month = "";
  let year = "";
  if (iso) {
    [, year, month, day] = iso;
  } else if (dmy) {
    [, day, month, year] = dmy;
    if (year.length === 2) year = `20${year}`;
  } else {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return sourceDateLabel(value);
    day = String(parsed.getUTCDate()).padStart(2, "0");
    month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    year = String(parsed.getUTCFullYear());
  }
  const monthName = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(month) - 1];
  return monthName ? `${Number(day)} ${monthName} ${year}` : sourceDateLabel(value);
}
function statusFreshness(payload, sourceName, options = {}) {
  const backup = Boolean(payload?.stale || payload?.static_snapshot);
  const dataAt = firstTimestamp(payload?.snapshot_data_at, payload?.updated_at, payload?.snapshot_refreshed_at, payload?.snapshot_generated_at);
  const generatedAt = firstTimestamp(payload?.snapshot_generated_at, payload?.snapshot_attempted_at);
  const stale = Boolean(payload?.stale || (backup && olderThan(dataAt || generatedAt, options.maxAgeMinutes)));
  const contentAt = firstTimestamp(options.contentAt);
  const stampTarget = dataAt || generatedAt;
  const stamp = stampTarget ? `${sgtClock(stampTarget)} SGT` : "time unknown";
  const badge = backup ? `${stale ? "STALE " : ""}SNAPSHOT · ${sgtClock(stampTarget)}` : (options.liveBadge || "LIVE DATA");
  const health = backup ? `Snap ${sgtClock(stampTarget)}` : (options.liveHealth || "Live");
  const contentNote = contentAt && options.contentLabel
    ? ` · ${options.contentLabel} ${relativeTime(contentAt)}`
    : "";

  let detail;
  if (backup && stale) {
    const retry = generatedAt ? `; App retry ${sgtStamp(generatedAt)}` : "";
    detail = `Stale ${sourceName.toLowerCase()} snapshot from ${sgtStamp(stampTarget)} (${ageLabel(stampTarget)})${retry}${contentNote}`;
  } else if (backup) {
    const built = generatedAt ? `; built ${sgtStamp(generatedAt)}` : "";
    detail = `${sourceName} snapshot from ${sgtStamp(stampTarget)} (${ageLabel(stampTarget)})${built}${contentNote}`;
  } else {
    detail = `${sourceName} live source updated ${sgtStamp(stampTarget)} (${ageLabel(stampTarget)})${contentNote}`;
  }

  const summaryBits = [`${sourceName}: ${stale ? "stale " : ""}${stamp}`];
  if (contentAt && options.contentLabel) summaryBits.push(`${options.contentLabel} ${relativeTime(contentAt)}`);
  const footer = backup
    ? `${stale ? "Stale snapshot" : "Snapshot"} from ${sgtStamp(stampTarget)}${generatedAt && generatedAt.getTime() !== stampTarget?.getTime() ? ` · App checked ${sgtStamp(generatedAt)}` : ""}${contentNote}`
    : `Live source updated ${sgtStamp(stampTarget)}${contentNote}`;

  return {
    backup,
    stale,
    dataAt,
    generatedAt,
    contentAt,
    badge,
    health,
    detail,
    summary: summaryBits.join(" / "),
    footer,
  };
}

function eventDay(value) {
  if (!value) return "Date TBC";
  const date = new Date(value);
  const today = formatter(SINGAPORE_TZ, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const event = formatter(SINGAPORE_TZ, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const tomorrow = formatter(SINGAPORE_TZ, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400000));
  if (event === today) return "Today";
  if (event === tomorrow) return "Tomorrow";
  return formatter(SINGAPORE_TZ, { weekday: "short", day: "2-digit", month: "short" }).format(date);
}

function eventDayLong(value) {
  if (!value) return "Date to be confirmed";
  const date = new Date(value);
  const relative = eventDay(value);
  const full = formatter(SINGAPORE_TZ, { weekday: "long", day: "2-digit", month: "short" }).format(date);
  return relative === "Today" || relative === "Tomorrow" ? `${relative} - ${full}` : full;
}

function sentiment(score) {
  const value = Math.max(-1, Math.min(1, finiteNumber(score, 0)));
  if (value >= .18) return { key: "bullish", label: "Bullish", phrase: "leans bullish" };
  if (value <= -.18) return { key: "bearish", label: "Bearish", phrase: "leans bearish" };
  return { key: "balanced", label: "Balanced", phrase: "is balanced" };
}

function setNeedle(selector, score) {
  $(selector).style.left = `${50 + Math.max(-1, Math.min(1, finiteNumber(score, 0))) * 42}%`;
}

function formatMarketValue(item) {
  const price = finiteNumber(item.price, null);
  const change = finiteNumber(item.change_percent, null);
  if (price === null || change === null) return "Live value unavailable";
  const decimals = price >= 100 ? 2 : price >= 10 ? 3 : 4;
  return `${price.toLocaleString("en-US", { maximumFractionDigits: decimals })} - ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
}

function formatCorrelation(value) {
  const number = finiteNumber(value, null);
  return number !== null ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}` : "n/a";
}

function correlationSummary(item) {
  if (item.id === "NDX") return "Primary Nasdaq momentum anchor";
  const hasCorrelation = finiteNumber(item.correlation_60, null) !== null || finiteNumber(item.correlation_20, null) !== null;
  if (!hasCorrelation) return "Correlation n/a";
  const strength = item.correlation_strength || "unavailable";
  const label = item.correlation_label || "correlation unavailable";
  return `Corr: ${strength} - 60D ${formatCorrelation(item.correlation_60)} - 20D ${formatCorrelation(item.correlation_20)} - ${label}`;
}

function newsImpactLabel(item) {
  return `est. ${item.impact || "mixed"}`;
}

function newsEstimateLine(item) {
  const strength = { high: "strong", medium: "moderate", low: "limited" }[item.confidence_label] || "limited";
  const reason = item.impact_reason || "headline language";
  const method = item.verified_article ? "article verified" : "headline estimate";
  return `Estimated NASDAQ impact - ${reason} - ${strength} headline evidence - ${method}`;
}

function marketEffect(item) {
  if (finiteNumber(item.nasdaq_score, null) === null) return "Effect unavailable";
  const read = sentiment(item.nasdaq_score);
  if (item.id === "US10Y") {
    if (read.key === "bullish") return "Rate relief";
    if (read.key === "bearish") return "Yield pressure";
    return "Rates balanced";
  }
  if (item.id === "VXN") {
    if (read.key === "bullish") return "Risk appetite";
    if (read.key === "bearish") return "Volatility pressure";
    return "Volatility balanced";
  }
  if (item.id === "DXY") {
    if (read.key === "bullish") return "FX tailwind";
    if (read.key === "bearish") return "Dollar pressure";
    const relation = finiteNumber(item.effective_relation, null);
    return relation === 0 ? "Weak correlation / effect muted" : "FX effect balanced";
  }
  if (item.id === "SOX") {
    if (read.key === "bullish") return "Chip / AI support";
    if (read.key === "bearish") return "Chip / AI drag";
    return "Semis balanced";
  }
  if (item.id === "DJI") {
    if (read.key === "bullish") return "Broad risk support";
    if (read.key === "bearish") return "Broad risk drag";
    return "US30 balanced";
  }
  return read.label;
}

function normalizeMarketItem(item = {}) {
  const normalized = { ...item };
  ["price", "change_percent", "nasdaq_score", "correlation_20", "correlation_60", "effective_relation", "assumed_relation"].forEach(key => {
    normalized[key] = finiteNumber(normalized[key], null);
  });
  return normalized;
}

function renderMarket(payload) {
  if (!payload.ok || !payload.items?.length || !payload.pulse) {
    latestMarketItems = [];
    renderTicker();
    latestMarketPulse = null;
    setHealth("market", "offline", "No data");
    const status = $("#marketPulseStatus");
    status.className = "source-status offline";
    status.textContent = "NO DATA";
    $("#marketPulseTitle").textContent = "Cross-market read unavailable";
    $("#marketPulseSummary").textContent = "No verified Nasdaq market snapshot is available, so LiqueDT will not show a directional assumption.";
    setNeedle("#marketPulseNeedle", 0);
    $$('[data-driver]').forEach(card => {
      const metric = card.querySelector(".driver-market-read");
      if (!metric) return;
      metric.className = "driver-market-read offline";
      metric.textContent = "Market context unavailable";
    });
    renderTotalPulse();
    return false;
  }

  const backup = Boolean(payload.stale || payload.static_snapshot);
  const freshness = statusFreshness(payload, "Markets", { liveBadge: "LIVE DATA", maxAgeMinutes: 20 });
  const marketItems = payload.items.map(normalizeMarketItem);
  renderTicker(marketItems);
  latestMarketPulse = { ...payload.pulse, backup, freshness };
  setHealth("market", backup ? "delayed" : "live", freshness.health, freshness);
  const status = $("#marketPulseStatus");
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = freshness.badge;
  status.title = freshness.detail;
  setNeedle("#marketPulseNeedle", payload.pulse.score);
  $("#marketPulseTitle").textContent = payload.pulse.title || `Cross-market context ${sentiment(payload.pulse.score).phrase}`;
  $("#marketPulseSummary").textContent = payload.pulse.summary || "Weighted from NASDAQ/NDX momentum, US500/US30 confirmation, U.S. yields, VXN, semiconductors and the dollar.";

  marketItems.forEach(item => {
    const card = $(`[data-driver="${item.id}"]`);
    if (!card) return;
    let metric = card.querySelector(".driver-market-read");
    if (!metric) {
      metric = document.createElement("div");
      metric.className = "driver-market-read";
      card.querySelector("h3").insertAdjacentElement("afterend", metric);
    }
    const read = sentiment(item.nasdaq_score);
    metric.className = `driver-market-read ${read.key}`;
    metric.innerHTML = `<span class="driver-value">${escapeHtml(formatMarketValue(item))}</span><span class="driver-effect">Nasdaq effect: ${escapeHtml(marketEffect(item))}</span><span class="driver-correlation">${escapeHtml(correlationSummary(item))}</span>${item.proxy_note ? `<span class="driver-proxy">Proxy/source note: public market data may use the closest available ETF/index feed.</span>` : ""}`;
  });
  renderTotalPulse();
  return true;
}

function renderTotalPulse() {
  const parts = [];
  let weighted = 0;
  let weight = 0;
  if (latestMarketPulse) {
    weighted += Number(latestMarketPulse.score || 0) * .60;
    weight += .60;
    parts.push(`Cross-market context ${sentiment(latestMarketPulse.score).phrase}`);
  }
  if (latestNewsPulse) {
    weighted += Number(latestNewsPulse.score || 0) * .30;
    weight += .30;
    parts.push(`news narrative ${sentiment(latestNewsPulse.score).phrase}`);
  }
  if (latestCalendarPulse?.sample_size) {
    weighted += Number(latestCalendarPulse.score || 0) * .10;
    weight += .10;
    parts.push(`latest macro result ${sentiment(latestCalendarPulse.score).phrase}`);
  }

  const status = $("#totalPulseStatus");
  if (!weight) {
    status.className = "source-status offline";
    status.textContent = "NO DATA";
    $("#totalPulseTitle").textContent = "Total context unavailable";
    $("#totalPulseSummary").textContent = "LiqueDT needs at least one verified market, calendar or news source before showing an assumption.";
    setNeedle("#totalPulseNeedle", 0);
    return;
  }

  const score = weighted / weight;
  const read = sentiment(score);
  const partial = !latestMarketPulse || !latestNewsPulse || latestMarketPulse?.backup || latestNewsPulse?.backup;
  const highImpact = latestCalendar?.events?.filter(event => event.impact === "High" || event.nasdaq_relevance === "Critical").length || 0;
  const latestResult = latestCalendarPulse?.latest_result;
  status.className = `source-status ${partial ? "delayed" : "live"}`;
  status.textContent = partial ? "PARTIAL / SNAPSHOT" : "LIVE COMBINED";
  status.title = [latestMarketPulse?.freshness?.detail, latestNewsPulse?.freshness?.detail].filter(Boolean).join(" - ");
  setNeedle("#totalPulseNeedle", score);
  $("#totalPulseTitle").textContent = `Total NASDAQ context ${read.phrase}`;
  const eventLine = latestResult
    ? `Latest result: ${latestResult.title} actual ${latestResult.actual || "released"}${latestResult.forecast ? ` vs forecast ${latestResult.forecast}` : ""} ? ${latestResult.result_bias} for NASDAQ (${latestResult.result_reason}).`
    : highImpact
      ? `${highImpact} important USD event${highImpact === 1 ? " is" : "s are"} on watch; a fresh result can quickly invalidate the current read.`
      : "No listed high-impact USD event is currently adding event-result pressure.";
  $("#totalPulseSummary").textContent = `${parts.join("; ")}. ${eventLine}`;
  const factors = [latestMarketPulse && `Markets: ${sentiment(latestMarketPulse.score).label}`, latestNewsPulse && `News: ${sentiment(latestNewsPulse.score).label}`, latestCalendarPulse?.sample_size && `Calendar: ${sentiment(latestCalendarPulse.score).label}`, highImpact && `${highImpact} event risk`].filter(Boolean);
  $("#totalPulseFactors").innerHTML = factors.map(factor => `<span>${escapeHtml(factor)}</span>`).join("");
}

function renderCalendar(payload) {
  const status = $("#calendarStatus");
  if (!payload?.ok) {
    latestCalendar = null;
    latestCalendarPulse = null;
    status.className = "source-status offline";
    status.textContent = "NO FEED";
    status.title = "Parsed ForexFactory calendar feed is unavailable. LiqueDT no longer switches this section to a TradingView widget.";
    setHealth("calendar", "offline", "No feed", { summary: "Calendar: parsed feed unavailable", detail: status.title });
    $("#calendarFreshnessNote").textContent = "Parsed ForexFactory calendar unavailable - use the source link below for a direct check";
    $("#calendarList").innerHTML = '<div class="empty-feed">Parsed ForexFactory calendar could not be loaded. Use the full calendar link below for a direct check.</div>';
    renderTotalPulse();
    return false;
  }
  latestCalendar = payload;
  latestCalendarPulse = payload.pulse || null;
  const backup = Boolean(payload.stale || payload.static_snapshot);
  const freshness = statusFreshness(payload, "Calendar", { liveBadge: "LIVE FEED", maxAgeMinutes: 90 });
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = freshness.badge;
  status.title = freshness.detail;
  setHealth("calendar", backup ? "delayed" : "live", freshness.health, freshness);
  $("#calendarFreshnessNote").textContent = `${freshness.footer} - USD high/medium impact`;
  const moreLink = $("#calendarMoreLink");
  if (moreLink && payload.more_url) moreLink.href = payload.more_url;
  const groups = new Map();
  const calendarEvents = (Array.isArray(payload.events) ? payload.events : []).filter(event => isCalendarEventActive(event, 60));
  if (!calendarEvents.length) {
    $("#calendarList").innerHTML = '<div class="empty-feed">No upcoming or recently released NASDAQ-relevant USD high/medium events are listed in the current ForexFactory snapshot. Events are removed about 1 hour after release. Use More dates below to open the expanded ForexFactory calendar.</div>';
    renderTotalPulse();
    return true;
  }
  calendarEvents.slice(0, 18).forEach(event => {
    const key = event.time_utc
      ? formatter(SINGAPORE_TZ, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(event.time_utc))
      : "TBC";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  $("#calendarList").innerHTML = [...groups.values()].map(events => {
    const label = eventDayLong(events[0].time_utc);
    const rows = events.map(event => {
      const time = event.time_utc
        ? formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(event.time_utc))
        : "TBC";
      const values = [event.actual && `Actual ${event.actual}`, event.forecast && `Fcst ${event.forecast}`, event.previous && `Prev ${event.previous}`].filter(Boolean).join(" - ") || "Details pending";
      const bias = event.result_bias || "pending";
      const resultLine = event.result_status === "released"
        ? `<p class="calendar-result ${escapeHtml(bias)}">NASDAQ result read: ${escapeHtml(bias)} - ${escapeHtml(event.result_reason || "actual result released")}</p>`
        : `<p class="calendar-reason">NASDAQ watch: ${escapeHtml(event.nasdaq_relevance || "Watch")} - ${escapeHtml(event.nasdaq_reason || "USD event risk")}</p>`;
      return `<article class="calendar-item">
        <div class="calendar-time"><strong>${escapeHtml(time)}</strong><small>SGT</small></div>
        <div class="calendar-copy"><h3>${escapeHtml(event.title)}</h3><p>USD - ${escapeHtml(values)}</p>${resultLine}</div>
        <span class="impact ${event.impact === "High" ? "high" : "medium"}"><i></i>${escapeHtml(event.impact)}</span>
      </article>`;
    }).join("");
    return `<section class="calendar-day-group"><div class="calendar-day-label">${escapeHtml(label)}</div>${rows}</section>`;
  }).join("");
  renderTotalPulse();
  return true;
}

function renderNews(payload) {
  const status = $("#newsStatus");
  if (!payload?.ok || !payload.items?.length) {
    status.className = "source-status offline";
    status.textContent = "NO FEED";
    status.title = "Parsed NASDAQ headline feed is unavailable. LiqueDT no longer switches this section to a TradingView widget.";
    setHealth("news", "offline", "No feed", { summary: "News: parsed feed unavailable", detail: status.title });
    $("#newsFreshnessNote").textContent = "Parsed NASDAQ news unavailable - refresh after the app or GitHub snapshot updates";
    $("#newsList").innerHTML = '<div class="empty-feed">Parsed NASDAQ headlines could not be loaded. LiqueDT will retry automatically; use the source link below for a direct check.</div>';
    renderPulse(null);
    return false;
  }
  const backup = Boolean(payload.stale || payload.static_snapshot);
  const freshness = statusFreshness(payload, "News", {
    contentAt: payload.items?.[0]?.published,
    contentLabel: "latest headline",
    liveBadge: "LIVE FEED",
    maxAgeMinutes: 20
  });
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = freshness.badge;
  status.title = freshness.detail;
  setHealth("news", backup ? "delayed" : "live", freshness.health, freshness);
  $("#newsFreshnessNote").textContent = `${freshness.footer} - NASDAQ subject/context filter; evidence strength describes the headline reading, not the probability of a future price move`;
  $("#newsList").innerHTML = payload.items.slice(0, 18).map(item => `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
    <span class="news-effect ${escapeHtml(item.impact)}"><small>EST.</small>${escapeHtml(item.impact || "mixed")}</span>
    <span class="news-copy"><h3>${escapeHtml(item.title)}</h3><p><span>${escapeHtml(item.source || "FXStreet")}</span><span>-</span><span>${escapeHtml(relativeTime(item.published))}</span></p><p class="news-estimate">${escapeHtml(newsEstimateLine(item))}</p></span>
  </a>`).join("");
  renderPulse(payload.pulse, backup, freshness);
  return true;
}


// Missing source values must remain unknown, never silently become zero.
function companyNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/\u2212/g, "-");
  if (/^(UNCH|UNCHANGED)$/i.test(text)) return 0;
  const match = text.match(/^\(?\s*([+-]?)\s*\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*([KMBT]?)\s*%?\s*\)?$/i);
  if (!match) return null;
  const number = Number(match[2].replace(/,/g, "")) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[3].toUpperCase()] || 1);
  return Number.isFinite(number) ? number * (match[1] === "-" || text.startsWith("(") ? -1 : 1) : null;
}

function companyIssuerName(name) {
  return String(name || "").replace(/\s+(?:Class\s+[A-Z]\s+)?(?:Common Stock|Capital Stock|Ordinary Shares|Common Shares|American Depositary Shares|New York Registry Shares|Subordinate Voting Shares).*$/i, "")
    .replace(/\s+Class\s+[A-Z]$/i, "").trim();
}

function companyRows(items, view = "companies") {
  const unique = new Map();
  for (const item of items) {
    const symbol = String(item.symbol || "").trim().toUpperCase();
    if (!symbol || unique.has(symbol)) continue;
    const parsedCap = companyNumber(item.market_cap);
    unique.set(symbol, { ...item, symbol, issuer: companyIssuerName(item.name) || symbol,
      cap: parsedCap > 0 ? parsedCap : null, change: companyNumber(item.percent_change) });
  }
  const groups = new Map();
  for (const item of unique.values()) {
    const key = view === "listings" ? item.symbol : item.issuer.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(classes => {
    classes.sort((a, b) => (b.cap ?? -Infinity) - (a.cap ?? -Infinity) || a.symbol.localeCompare(b.symbol));
    // Nasdaq quote caps can repeat issuer capitalisation across classes: never sum them.
    const representative = classes[0];
    return { ...representative, name: view === "companies" ? representative.issuer : representative.name,
      classes, search: classes.map(item => `${item.symbol} ${item.name}`).join(" ").toLowerCase() };
  });
}

function rankCompanies(rows, mode = "size") {
  const metric = row => mode === "size" ? row.cap : mode === "movers" ? (row.change === null ? null : Math.abs(row.change)) : row.change;
  return [...rows].sort((a, b) => {
    const tie = a.name.localeCompare(b.name) || a.symbol.localeCompare(b.symbol);
    if (mode === "name") return tie;
    const av = metric(a), bv = metric(b);
    if (av === null) return bv === null ? tie : 1;
    if (bv === null) return -1;
    return (mode === "losers" ? av - bv : bv - av) || tie;
  }).map((row, index) => ({ ...row, displayRank: index + 1 }));
}

function companyCapLabel(value) {
  if (value === null) return "Cap unavailable";
  const unit = value >= 1e12 ? [1e12, "T"] : value >= 1e9 ? [1e9, "B"] : value >= 1e6 ? [1e6, "M"] : [1, ""];
  return `$${(value / unit[0]).toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit[1]} cap`;
}

function renderCompanyCards(items = latestCompanies) {
  const query = ($("#companySearch")?.value || "").trim().toLowerCase();
  const mode = $("#companySort")?.value || "size";
  const view = $("#companyView")?.value || "companies";
  const rows = rankCompanies(companyRows(items, view), mode);
  const filtered = rows.filter(item => !query || item.search.includes(query));
  $("#companiesList").innerHTML = filtered.map(item => {
    const direction = item.change === null || item.change === 0 ? "flat" : item.change > 0 ? "up" : "down";
    const quotes = item.classes.map(share => `<span>${item.classes.length > 1 ? `${escapeHtml(share.symbol)} ` : ""}${escapeHtml(share.last_sale || "n/a")}</span><span class="company-change ${share.change === null || share.change === 0 ? "flat" : share.change > 0 ? "up" : "down"}">${share.change === null ? "Change unavailable" : `${share.change > 0 ? "+" : ""}${share.change.toFixed(2)}%`}</span>`).join("");
    return `<article class="company-card ${direction}">
      <span class="company-rank" title="Rank within selected view before search">${item.displayRank}</span>
      <div class="company-main"><strong>${escapeHtml(item.classes.map(share => share.symbol).join(" / "))}</strong><span>${escapeHtml(item.name)}</span></div>
      <div class="company-meta">${quotes}<span title="Source market cap; not index weight">${companyCapLabel(item.cap)}</span></div>
    </article>`;
  }).join("") || '<div class="empty-feed">No matching Nasdaq-100 constituent found.</div>';
  $("#companiesCount").textContent = `${filtered.length} / ${rows.length} ${view === "companies" ? "companies" : "listings"}`;
  const listings = companyRows(items, "listings");
  const up = listings.filter(item => item.change > 0).length;
  const down = listings.filter(item => item.change < 0).length;
  const flat = listings.filter(item => item.change === 0).length;
  const missing = listings.filter(item => item.change === null).length;
  $("#companiesSummary").innerHTML = `<span>Listing breadth</span><span class="up">${up} rising</span><span class="down">${down} falling</span><span>${flat} unchanged</span>${missing ? `<span>${missing} unavailable</span>` : ""}`;
  $("#companiesRankNote").textContent = `${mode === "size" ? "Ranked by source market cap, not official index weight or index contribution." : mode === "name" ? "Alphabetical company order." : "Ranked by the source's daily percentage change, not Nasdaq impact."} ${view === "companies" ? "Share classes are grouped; size and movement rank use the largest-cap class. Each class quote remains visible." : "Each share class is separate; market caps may repeat issuer size."} Missing values rank last. Search keeps the original ranks.`;
}

function renderCompanies(payload) {
  const status = $("#companiesStatus");
  if (!payload?.ok || !payload.items?.length) {
    latestCompanies = [];
    status.className = "source-status offline";
    status.textContent = "UNAVAILABLE";
    $("#companiesCount").textContent = "No data";
    $("#companiesFreshnessNote").textContent = "Official Nasdaq constituent list unavailable right now";
    $("#companiesList").innerHTML = '<div class="empty-feed">Nasdaq-100 constituents could not be loaded. Try refresh again later.</div>';
    $("#companiesSummary").textContent = "Listing breadth unavailable";
    return false;
  }
  latestCompanies = payload.items;
  const backup = Boolean(payload.stale || payload.static_snapshot);
  const freshness = statusFreshness(payload, "Companies", { liveBadge: "NASDAQ LIVE", maxAgeMinutes: 1440 });
  const sourceDate = nasdaqSourceDateLabel(payload.as_of);
  const checkedAt = firstTimestamp(payload.snapshot_generated_at, payload.snapshot_attempted_at, payload.updated_at);
  const checkedLabel = checkedAt ? ` - app checked ${sgtStamp(checkedAt)}` : "";
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = sourceDate ? `AS OF ${sourceDate.toUpperCase()}` : (backup ? freshness.badge : "NASDAQ LIVE");
  status.title = sourceDate
    ? `${payload.source || "Official Nasdaq source"} list date ${sourceDate}.${checkedAt ? ` App snapshot checked ${sgtStamp(checkedAt)}.` : ""} If Nasdaq updates the source date, the next app/GitHub refresh will display the new date.`
    : freshness.detail;
  const officialCount = payload.total_records || payload.items.length;
  $("#companiesCount").textContent = `${payload.items.length} shown`;
  $("#companiesFreshnessNote").textContent = sourceDate
    ? `Official Nasdaq list date ${sourceDate} - ${officialCount} listings${checkedLabel}`
    : `Official Nasdaq list ${freshness.footer} - ${officialCount} listings`;
  renderCompanyCards(payload.items);
  return true;
}

function renderPulse(pulse, backup = false, freshness = null) {
  const status = $("#pulseStatus");
  if (!pulse) {
    latestNewsPulse = null;
    status.className = "source-status offline";
    status.textContent = "NO FEED";
    $("#pulseTitle").textContent = "Narrative read unavailable";
    $("#pulseSummary").textContent = "Live headlines are not reachable. No directional assumption is shown when the source cannot be verified.";
    $("#pulseNeedle").style.left = "50%";
    renderTotalPulse();
    return;
  }
  const score = Math.max(-1, Math.min(1, Number(pulse.score) || 0));
  latestNewsPulse = { ...pulse, score, backup, freshness };
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = backup && freshness ? `${freshness.badge} · ${pulse.sample_size || 0} HEADLINES` : `${pulse.sample_size || 0} HEADLINES`;
  status.title = freshness?.detail || "";
  $("#pulseNeedle").style.left = `${50 + score * 42}%`;
  $("#pulseTitle").textContent = pulse.title || "Balanced narrative";
  $("#pulseSummary").textContent = pulse.summary || "Recent headlines contain mixed or neutral Nasdaq-sensitive language.";
  const factors = pulse.factors?.length ? pulse.factors : ["Rates", "AI", "Risk", "Earnings"];
  $("#pulseFactors").innerHTML = factors.slice(0, 4).map(factor => `<span>${escapeHtml(factor)}</span>`).join("");
  renderTotalPulse();
}

function updateFreshness(successCount) {
  latestRefresh = new Date();
  $("#lastChecked").textContent = `${formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(latestRefresh)} SGT`;
  renderHealthSummary();
}

async function refreshData({ manual = false } = {}) {
  if (refreshBusy) return;
  refreshBusy = true;
  const button = $("#refreshData");
  const previousBuild = firstTimestamp(latestStaticBuild?.snapshot_generated_at, latestStaticBuild?.updated_at);
  button.classList.add("loading");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (manual) {
    button.querySelector("span").textContent = "Checking...";
    showRefreshFeedback("Checking for updated data...");
  }
  try {
    const [marketResult, calendarResult, newsResult, companiesResult, staticStatusResult] = await Promise.allSettled([
      fetchJson("market"), fetchJson("calendar"), fetchJson("news"), fetchJson("companies"), fetchStaticStatus()
    ]);
    let successCount = 0;
    if (marketResult.status === "fulfilled" && renderMarket(marketResult.value)) successCount += 1;
    else renderMarket({ ok: false });
    if (calendarResult.status === "fulfilled" && renderCalendar(calendarResult.value)) successCount += 1;
    else renderCalendar({ ok: false });
    if (newsResult.status === "fulfilled" && renderNews(newsResult.value)) successCount += 1;
    else renderNews({ ok: false });
    if (companiesResult.status === "fulfilled" && renderCompanies(companiesResult.value)) successCount += 1;
    else renderCompanies({ ok: false });
    const feeds = [marketResult, calendarResult, newsResult, companiesResult];
    const liveAvailable = feeds.some(result => result.status === "fulfilled" && result.value?.ok && !result.value.static_snapshot);
    const failedFeeds = feeds.some(result => result.status !== "fulfilled" || !result.value?.ok);
    feedDeliveryMode = liveAvailable ? "live" : "snapshot";
    needsDataRetry = feeds.some(result => result.status !== "fulfilled" || !result.value?.ok || result.value.static_snapshot || result.value.stale);
    if (staticStatusResult.status === "fulfilled") renderStaticStatus(staticStatusResult.value);
    if (manual) {
      if (successCount === 0) showRefreshFeedback("Data could not be checked. Please try again shortly.");
      else if (failedFeeds) showRefreshFeedback("Some data could not be updated. Please try again shortly.");
      else if (feedDeliveryMode === "snapshot") {
        const build = staticStatusResult.status === "fulfilled"
          ? firstTimestamp(staticStatusResult.value.snapshot_generated_at, staticStatusResult.value.updated_at) : null;
        const newer = build && (!previousBuild || build > previousBuild);
        const stamp = build ? ` Last built ${sgtStamp(build)}.` : "";
        showRefreshFeedback(!build ? "Snapshot files checked. Build time is unavailable." : newer ? `A newer published snapshot is loaded.${stamp}` : `No newer snapshot is published yet.${stamp}`);
      } else showRefreshFeedback(needsDataRetry ? "Data checked; some sources still need to recover." : "Live data checked. Automatic updates are running.");
    }
    updateFreshness(successCount);
  } catch (error) {
    needsDataRetry = true;
    if (manual) showRefreshFeedback("Data could not be checked. Please try again shortly.");
  } finally {
    button.classList.remove("loading");
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    refreshBusy = false;
    configureSnapshotControls();
  }
}

function bindNavigation() {
  const links = $$(".primary-nav a");
  const sections = [...new Set(links.map(link => document.querySelector(link.getAttribute("href"))).filter(Boolean))];
  let navLockUntil = 0;
  links.forEach(link => link.addEventListener("click", () => {
    navLockUntil = Date.now() + 1800;
    const href = link.getAttribute("href");
    links.forEach(item => item.classList.toggle("active", item.getAttribute("href") === href));
  }));
  const observer = new IntersectionObserver(entries => {
    if (Date.now() < navLockUntil) return;
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach(link => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-30% 0px -60%", threshold: [0, .2, .6] });
  sections.forEach(section => observer.observe(section));
}

function bindEvents() {
  configureSnapshotControls();
  $("#refreshData").addEventListener("click", () => refreshData({ manual: true }));
  $("#methodButton").addEventListener("click", () => $("#methodDialog").showModal());
  $("#feedbackButton").addEventListener("click", () => $("#feedbackDialog").showModal());
  $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  $$("#marketTabs button").forEach(button => button.addEventListener("click", () => mountChart(button.dataset.symbol)));
  $$('[data-open-symbol]').forEach(button => button.addEventListener("click", () => {
    mountChart(button.dataset.openSymbol);
    $("#markets").scrollIntoView({ behavior: "smooth" });
  }));
  $("#companySearch")?.addEventListener("input", () => renderCompanyCards());
  $("#companySort")?.addEventListener("change", () => renderCompanyCards());
  $("#companyView")?.addEventListener("change", () => renderCompanyCards());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && latestRefresh && Date.now() - latestRefresh > 300000) refreshData();
  });
  window.addEventListener("resize", () => {
    clearTimeout(tickerResizeTimer);
    tickerResizeTimer = setTimeout(() => renderTicker(latestMarketItems), 160);
  });
}

function init() {
  preventMobileZoom();
  updateClocks();
  setInterval(updateClocks, 1000);
  if (WIDGETS_DISABLED) {
    renderTicker();
    $("#marketChart").innerHTML = '<div class="widget-placeholder">Live chart paused for interface testing</div>';
    setHealth("charts", "delayed", "Paused");
  } else {
    mountTicker();
    mountChart();
  }
  bindNavigation();
  bindEvents();
  refreshData();
  setInterval(refreshData, 60000);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
  }
}

init();













