"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SINGAPORE_TZ = "Asia/Singapore";
const formatterCache = new Map();

const sessions = [
  { id: "asia", label: "Asia / overnight", note: "Futures and overnight sentiment; usually slower for NAS100.cash", anchorTimeZone: "Asia/Singapore", open: { timeZone: "Asia/Singapore", hour: 8, minute: 0 }, close: { timeZone: "Asia/Singapore", hour: 16, minute: 0 } },
  { id: "london", label: "Europe pre-market", note: "Europe flow before Nasdaq cash open; direction can start building", anchorTimeZone: "America/New_York", requiresCashDay: true, open: { timeZone: "Europe/London", hour: 8, minute: 0 }, close: { timeZone: "America/New_York", hour: 9, minute: 30 } },
  { id: "new-york", label: "U.S. cash session", note: "Main NASDAQ liquidity window; first 15-30 min can fake out", anchorTimeZone: "America/New_York", requiresCashDay: true, cashSession: true, open: { timeZone: "America/New_York", hour: 9, minute: 30 }, close: { cashClose: true } }
];

const nasdaqClosedDates = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
const nasdaqEarlyCloses = new Map([["2026-11-27", { hour: 13, minute: 0 }], ["2026-12-24", { hour: 13, minute: 0 }]]);

const widgetSymbols = {
  "CAPITALCOM:US100": { name: "NAS100 / Nasdaq 100 Cash CFD", tag: "PRIMARY NAS100 CASH CFD" },
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

function ymd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isNasdaqCashDay(parts) {
  const weekday = calendarDate(parts).weekday;
  return weekday >= 1 && weekday <= 5 && !nasdaqClosedDates.has(ymd(parts));
}

function nasdaqCashCloseFor(parts) {
  return nasdaqEarlyCloses.get(ymd(parts)) || { hour: 16, minute: 0 };
}

function sessionEndpointTime(config, side, candidate) {
  const endpoint = side === "close" && config.close.cashClose ? nasdaqCashCloseFor(candidate) : config[side];
  return zonedDateTimeToUtc(candidate.year, candidate.month, candidate.day, endpoint.hour, endpoint.minute || 0, endpoint.timeZone || "America/New_York");
}

function sessionWindow(now, config, offset) {
  const anchorParts = zonedParts(now, config.anchorTimeZone || config.open.timeZone);
  const candidate = calendarDate(anchorParts, offset);
  const openTime = sessionEndpointTime(config, "open", candidate);
  let closeTime = sessionEndpointTime(config, "close", candidate);
  if (closeTime <= openTime) {
    const nextDay = calendarDate(candidate, 1);
    closeTime = sessionEndpointTime(config, "close", nextDay);
  }
  return { candidate, openTime, closeTime };
}

function sessionState(now, config) {
  let nextWindow = null;
  for (let offset = -1; offset <= 8; offset += 1) {
    const window = sessionWindow(now, config, offset);
    const weekday = window.candidate.weekday;
    const validDay = config.requiresCashDay ? isNasdaqCashDay(window.candidate) : weekday >= 1 && weekday <= 5;
    if (!validDay) continue;
    if (now >= window.openTime && now < window.closeTime) {
      return { open: true, target: window.closeTime, openSg: formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(window.openTime), closeSg: formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(window.closeTime) };
    }
    if (window.openTime > now && (!nextWindow || window.openTime < nextWindow.openTime)) nextWindow = window;
  }
  if (!nextWindow) nextWindow = sessionWindow(now, config, 1);
  return { open: false, target: nextWindow.openTime, openSg: formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nextWindow.openTime), closeSg: formatter(SINGAPORE_TZ, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nextWindow.closeTime) };
}

function nextSundayAt(parts, hour, timeZone) {
  const today = calendarDate(parts);
  let offset = (7 - today.weekday) % 7;
  if (offset === 0 && parts.hour >= hour) offset = 7;
  const candidate = calendarDate(parts, offset);
  return zonedDateTimeToUtc(candidate.year, candidate.month, candidate.day, hour, 0, timeZone);
}

function nextNasdaqCashOpen(parts) {
  const openMinute = 9 * 60 + 30;
  const currentMinute = parts.hour * 60 + parts.minute;
  let offset = 0;
  while (true) {
    const candidate = calendarDate(parts, offset);
    if (isNasdaqCashDay(candidate) && (offset !== 0 || currentMinute < openMinute)) return zonedDateTimeToUtc(candidate.year, candidate.month, candidate.day, 9, 30, "America/New_York");
    offset += 1;
  }
}

function nasdaqMarketState(now) {
  const timeZone = "America/New_York";
  const parts = zonedParts(now, timeZone);
  const date = calendarDate(parts);
  const minute = parts.hour * 60 + parts.minute;
  const openMinute = 9 * 60 + 30;
  const cashClose = nasdaqCashCloseFor(date);
  const closeMinute = cashClose.hour * 60 + (cashClose.minute || 0);
  const cashDay = isNasdaqCashDay(date);
  const open = cashDay && minute >= openMinute && minute < closeMinute;
  if (open) return { open, target: zonedDateTimeToUtc(parts.year, parts.month, parts.day, cashClose.hour, cashClose.minute || 0, timeZone), label: cashClose.hour < 16 ? "Until early NASDAQ cash close" : "Until NASDAQ cash close", detail: "NASDAQ cash session" };
  return { open, target: nextNasdaqCashOpen(parts), label: cashDay && minute < openMinute ? "Until NASDAQ cash open" : "Until next NASDAQ cash open", detail: cashDay ? (minute < openMinute ? "Pre-market before NASDAQ cash open" : "After NASDAQ cash close") : "NASDAQ cash market holiday/weekend" };
}

function updateClocks() {
  const now = new Date();
  $("#sgTime").textContent = formatter(SINGAPORE_TZ, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(now);
  $("#sgDate").textContent = `${formatter(SINGAPORE_TZ, { weekday: "short", day: "2-digit", month: "short" }).format(now)} - SGT`;

  const market = nasdaqMarketState(now);
  $("#marketState").textContent = market.open ? "NASDAQ cash open" : "NASDAQ cash closed";
  $("#marketStateDetail").textContent = market.detail;
  $("#marketCountdown").textContent = countdown(market.target - now);
  $("#marketCountdownLabel").textContent = market.label;
  $("#marketDot").className = `market-dot ${market.open ? "open" : "closed"}`;

  sessions.forEach(session => {
    const state = sessionState(now, session);
    const card = $(`[data-session="${session.id}"]`);
    card.classList.toggle("open", state.open);
    card.querySelector("h3").textContent = session.label;
    card.querySelector(".session-status").textContent = state.open ? "OPEN NOW" : "CLOSED";
    card.querySelector(".session-timer strong").textContent = countdown(state.target - now);
    card.querySelector(".session-timer small").textContent = state.open ? "Until close" : "Until open";
    card.querySelector(".session-local-time")?.replaceChildren(`${state.openSg}-${state.closeSg} SGT ? ${session.note}`);
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
    const buildDetail = build ? `GitHub checked ${sgtClock(build)} SGT (${ageLabel(build)})` : "";
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
  const candidates = name === "companies" ? [`data/${name}.json`, `api/${name}`] : [`api/${name}`, `data/${name}.json`];
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
  renderHealthSummary();
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
  const named = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (named) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const month = months[named[1].slice(0, 3).toLowerCase()];
    if (month) return `${named[2].padStart(2, "0")}/${month}/${named[3]}`;
  }
  return text;
}

function olderThan(value, minutes) {
  const date = timestamp(value);
  return Boolean(date && minutes && Date.now() - date.getTime() > minutes * 60000);
}

function statusFreshness(payload, sourceName, options = {}) {
  const backup = Boolean(payload?.stale || payload?.static_snapshot);
  const dataAt = firstTimestamp(payload?.snapshot_data_at, payload?.updated_at, payload?.snapshot_refreshed_at, payload?.snapshot_generated_at);
  const generatedAt = firstTimestamp(payload?.snapshot_generated_at, payload?.snapshot_attempted_at);
  const stale = Boolean(payload?.stale || (backup && olderThan(dataAt || generatedAt, options.maxAgeMinutes)));
  const contentAt = firstTimestamp(options.contentAt);
  const stampTarget = dataAt || generatedAt;
  const stamp = stampTarget ? `${sgtClock(stampTarget)} SGT` : "time unknown";
  const badge = backup ? `${stale ? "STALE " : ""}SNAPSHOT - ${sgtClock(stampTarget)}` : (options.liveBadge || "LIVE DATA");
  const health = backup ? `Snap ${sgtClock(stampTarget)}` : (options.liveHealth || "Live");
  const contentNote = contentAt && options.contentLabel
    ? ` - ${options.contentLabel} ${relativeTime(contentAt)}`
    : "";

  let detail;
  if (backup && stale) {
    const retry = generatedAt ? `; GitHub retry ${sgtStamp(generatedAt)}` : "";
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
    ? `${stale ? "Stale snapshot" : "Snapshot"} from ${sgtStamp(stampTarget)}${generatedAt && generatedAt.getTime() !== stampTarget?.getTime() ? ` - GitHub checked ${sgtStamp(generatedAt)}` : ""}${contentNote}`
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
  const confidence = item.confidence_label || "low";
  const reason = item.impact_reason || "headline language";
  const method = item.verified_article ? "article verified" : "headline estimate";
  return `Estimated NASDAQ impact - ${confidence} confidence - ${reason} - ${method}`;
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
    return "FX link muted";
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
  if (!payload.ok || !payload.events?.length) {
    latestCalendar = null;
    latestCalendarPulse = null;
    if (!WIDGETS_DISABLED) {
      status.className = "source-status delayed";
      status.textContent = "LIVE WIDGET";
      status.title = "Parsed calendar feed is unavailable; TradingView calendar widget is loaded temporarily.";
      setHealth("calendar", "delayed", "Widget", { summary: "Calendar: live widget", detail: status.title });
      $("#calendarFreshnessNote").textContent = "Live backup widget - USD high/medium impact";
      mountWidget($("#calendarList"), "embed-widget-events.js", {
        colorTheme: "dark", isTransparent: true, width: "100%", height: 385,
        locale: "en", importanceFilter: "0,1", countryFilter: "us"
      });
    } else {
      status.className = "source-status offline";
      status.textContent = "UNAVAILABLE";
      status.title = "Calendar feed is unavailable.";
      setHealth("calendar", "offline", "Unavailable", null);
      $("#calendarFreshnessNote").textContent = "Calendar feed unavailable";
      $("#calendarList").innerHTML = '<div class="empty-feed">The calendar feed is unavailable right now. Use the full calendar link below before making time-sensitive decisions.</div>';
    }
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
  const groups = new Map();
  payload.events.slice(0, 12).forEach(event => {
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
  if (!payload.ok || !payload.items?.length) {
    if (!WIDGETS_DISABLED) {
      status.className = "source-status delayed";
      status.textContent = "LIVE WIDGET";
      status.title = "Parsed headline feed is unavailable; a live TradingView headline widget is loaded temporarily.";
      setHealth("news", "delayed", "Widget", { summary: "News: live widget", detail: status.title });
      $("#newsFreshnessNote").textContent = "Live backup widget - source attribution shown per story";
      mountWidget($("#newsList"), "embed-widget-timeline.js", {
        feedMode: "symbol", symbol: "CAPITALCOM:US100", colorTheme: "dark",
        isTransparent: true, displayMode: "regular", width: "100%", height: 385, locale: "en"
      });
    } else {
      status.className = "source-status offline";
      status.textContent = "UNAVAILABLE";
      status.title = "News feed is unavailable.";
      setHealth("news", "offline", "Unavailable", null);
      $("#newsFreshnessNote").textContent = "News feed unavailable";
      $("#newsList").innerHTML = '<div class="empty-feed">Live headlines could not be reached. LiqueDT will retry automatically; open the source link below for a direct check.</div>';
    }
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
  $("#newsFreshnessNote").textContent = `${freshness.footer} - source attribution shown per story`;
  $("#newsList").innerHTML = payload.items.slice(0, 18).map(item => `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
    <span class="news-effect ${escapeHtml(item.impact)}">${escapeHtml(item.impact || "mixed")}</span>
    <span class="news-copy"><h3>${escapeHtml(item.title)}</h3><p><span>${escapeHtml(item.source || "FXStreet")}</span><span>-</span><span>${escapeHtml(relativeTime(item.published))}</span></p></span>
  </a>`).join("");
  $("#newsFreshnessNote").textContent = `${freshness.footer} - NASDAQ impact is estimated from headline text and source context, not full-article verification`;
  $("#newsList").innerHTML = payload.items.slice(0, 18).map(item => `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
    <span class="news-effect ${escapeHtml(item.impact)}"><small>EST.</small>${escapeHtml(item.impact || "mixed")}</span>
    <span class="news-copy"><h3>${escapeHtml(item.title)}</h3><p><span>${escapeHtml(item.source || "FXStreet")}</span><span>-</span><span>${escapeHtml(relativeTime(item.published))}</span></p><p class="news-estimate">${escapeHtml(newsEstimateLine(item))}</p></span>
  </a>`).join("");
  renderPulse(payload.pulse, backup, freshness);
  return true;
}


function renderCompanyCards(items = latestCompanies) {
  const query = ($("#companySearch")?.value || "").trim().toLowerCase();
  const filtered = query
    ? items.filter(item => `${item.symbol || ""} ${item.name || ""}`.toLowerCase().includes(query))
    : items;
  const visible = filtered.slice(0, 120);
  $("#companiesList").innerHTML = visible.map(item => {
    const change = String(item.percent_change || item.net_change || "").trim();
    const direction = change.startsWith("-") ? "down" : change.startsWith("+") ? "up" : "flat";
    return `<article class="company-card ${direction}">
      <span class="company-rank">${escapeHtml(item.rank || "")}</span>
      <div class="company-main"><strong>${escapeHtml(item.symbol || "--")}</strong><span>${escapeHtml(item.name || "Name unavailable")}</span></div>
      <div class="company-meta"><span>${escapeHtml(item.last_sale || "n/a")}</span><span>${escapeHtml(item.percent_change || item.net_change || "n/a")}</span><span>${escapeHtml(item.market_cap || "n/a")}</span></div>
    </article>`;
  }).join("") || '<div class="empty-feed">No matching Nasdaq-100 constituent found.</div>';
  $("#companiesCount").textContent = `${filtered.length} shown`;
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
    return false;
  }
  latestCompanies = payload.items;
  const backup = Boolean(payload.stale || payload.static_snapshot);
  const freshness = statusFreshness(payload, "Companies", { liveBadge: "NASDAQ LIVE", maxAgeMinutes: 1440 });
  const sourceDate = sourceDateLabel(payload.as_of);
  const checkedAt = firstTimestamp(payload.snapshot_generated_at, payload.snapshot_attempted_at, payload.updated_at);
  const checkedLabel = checkedAt ? ` - app checked ${sgtStamp(checkedAt)}` : "";
  status.className = `source-status ${backup ? "delayed" : "live"}`;
  status.textContent = sourceDate ? `AS OF ${sourceDate}` : (backup ? freshness.badge : "NASDAQ LIVE");
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
  status.textContent = backup && freshness ? `${freshness.badge} - ${pulse.sample_size || 0}` : `${pulse.sample_size || 0} HEADLINES`;
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

async function refreshData() {
  const button = $("#refreshData");
  button.classList.add("loading");
  button.disabled = true;
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
  if (staticStatusResult.status === "fulfilled") renderStaticStatus(staticStatusResult.value);
  updateFreshness(successCount);
  button.classList.remove("loading");
  button.disabled = false;
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
  $("#refreshData").addEventListener("click", refreshData);
  $("#methodButton").addEventListener("click", () => $("#methodDialog").showModal());
  $("#feedbackButton").addEventListener("click", () => $("#feedbackDialog").showModal());
  $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  $$("#marketTabs button").forEach(button => button.addEventListener("click", () => mountChart(button.dataset.symbol)));
  $$('[data-open-symbol]').forEach(button => button.addEventListener("click", () => {
    mountChart(button.dataset.openSymbol);
    $("#markets").scrollIntoView({ behavior: "smooth" });
  }));
  $("#companySearch")?.addEventListener("input", () => renderCompanyCards());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && latestRefresh && Date.now() - latestRefresh > 300000) refreshData();
  });
  window.addEventListener("resize", () => {
    clearTimeout(tickerResizeTimer);
    tickerResizeTimer = setTimeout(() => renderTicker(latestMarketItems), 160);
  });
}

function init() {
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
