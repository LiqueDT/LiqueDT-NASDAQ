"""LiqueDT local gateway: static PWA + cached, normalized market-context feeds."""

from __future__ import annotations

import argparse
import calendar
import html
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python 3.8 fallback
    ZoneInfo = None  # type: ignore[assignment]
    ZoneInfoNotFoundError = Exception  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parent
NEWS_FEEDS = (
    ("https://www.fxstreet.com/rss/news", "FXStreet"),
    ("https://news.google.com/rss/search?q=%28Nasdaq%20OR%20%22Nasdaq%20100%22%20OR%20NDX%20OR%20QQQ%20OR%20%22tech%20stocks%22%20OR%20AI%20OR%20semiconductor%29%20%28Fed%20OR%20yields%20OR%20CPI%20OR%20Nvidia%20OR%20Apple%20OR%20Microsoft%20OR%20earnings%20OR%20tariff%20OR%20Trump%29&hl=en-US&gl=US&ceid=US%3Aen", "Google News"),
)
CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 LiqueDT/1.7"
NASDAQ_TERMS = (
    "nasdaq", "ndx", "qqq", "tech stocks", "technology stocks", "ai", "chip", "semiconductor",
    "nvidia", "apple", "microsoft", "tesla", "amazon", "meta", "alphabet", "earnings",
    "fed", "fomc", "powell", "rate", "yield", "treasury", "inflation", "cpi", "pce",
    "jobs", "payroll", "vix", "risk", "tariff", "trump", "white house", "china", "export controls",
)

MARKET_SERIES = (
    {"id": "NDX", "ticker": "^NDX", "name": "Nasdaq 100", "relation": 1.0, "weight": 0.30},
    {"id": "SPX", "ticker": "^GSPC", "name": "S&P 500", "relation": 1.0, "weight": 0.22},
    {"id": "US10Y", "ticker": "^TNX", "name": "U.S. 10Y yield", "relation": -1.0, "weight": 0.22},
    {"id": "VIX", "ticker": "^VIX", "name": "CBOE Volatility Index", "relation": -1.0, "weight": 0.18},
    {"id": "SOXX", "ticker": "SOXX", "name": "Semiconductor ETF", "relation": 1.0, "weight": 0.08},
)

BULLISH_PHRASES = {
    "rate cut": 2, "dovish": 2, "lower yields": 2, "yields fall": 2,
    "inflation cools": 2, "soft landing": 1, "risk-on": 1, "stocks rise": 1,
    "tech stocks rise": 2, "nasdaq rises": 2, "nasdaq rallies": 2, "qqq rises": 2,
    "ai rally": 2, "chip stocks rise": 2, "semiconductor stocks rise": 2,
    "nvidia gains": 2, "earnings beat": 2, "strong guidance": 2,
}
BEARISH_PHRASES = {
    "rate hike": -2, "hawkish": -2, "higher yields": -2, "yields rise": -2,
    "inflation hotter": -2, "risk-off": -1, "selloff": -2, "stocks fall": -1,
    "tech stocks fall": -2, "nasdaq falls": -2, "nasdaq retreats": -2, "qqq falls": -2,
    "chip stocks fall": -2, "semiconductor stocks fall": -2, "nvidia falls": -2,
    "earnings miss": -2, "weak guidance": -2, "antitrust": -1, "tariff": -1, "export controls": -1,
}


@dataclass
class CacheEntry:
    value: dict[str, Any] | None = None
    fetched_at: float = 0.0


class FeedCache:
    def __init__(self) -> None:
        self._entries: dict[str, CacheEntry] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._master = threading.Lock()

    def get(self, key: str, ttl: int, loader: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        now = time.time()
        entry = self._entries.get(key)
        if entry and entry.value and now - entry.fetched_at < ttl:
            return {**entry.value, "stale": False}

        with self._master:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            entry = self._entries.get(key)
            now = time.time()
            if entry and entry.value and now - entry.fetched_at < ttl:
                return {**entry.value, "stale": False}
            try:
                value = loader()
                self._entries[key] = CacheEntry(value=value, fetched_at=now)
                return {**value, "stale": False}
            except (OSError, ValueError, ET.ParseError, urllib.error.URLError) as exc:
                if entry and entry.value:
                    return {**entry.value, "stale": True, "warning": "Upstream refresh failed"}
                return {"ok": False, "stale": False, "error": type(exc).__name__}


CACHE = FeedCache()


def fetch_bytes(url: str, timeout: int = 8) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/xml,text/xml,application/rss+xml;q=0.9,*/*;q=0.5"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if getattr(response, "status", 200) != 200:
            raise urllib.error.URLError(f"Upstream returned {response.status}")
        data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError("Upstream payload exceeded 2 MB")
        return data


def text_of(node: ET.Element, name: str) -> str:
    child = node.find(name)
    return (child.text or "").strip() if child is not None else ""


def safe_external_url(value: str, fallback: str) -> str:
    try:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return value
    except ValueError:
        pass
    return fallback


def pearson(values_a: list[float], values_b: list[float]) -> float | None:
    if len(values_a) != len(values_b) or len(values_a) < 6:
        return None
    mean_a = sum(values_a) / len(values_a)
    mean_b = sum(values_b) / len(values_b)
    centered_a = [value - mean_a for value in values_a]
    centered_b = [value - mean_b for value in values_b]
    denom_a = math.sqrt(sum(value * value for value in centered_a))
    denom_b = math.sqrt(sum(value * value for value in centered_b))
    if not denom_a or not denom_b:
        return None
    return sum(a * b for a, b in zip(centered_a, centered_b)) / (denom_a * denom_b)


def daily_returns(closes: list[float]) -> list[float]:
    output: list[float] = []
    for previous, current in zip(closes, closes[1:]):
        if previous:
            output.append((current - previous) / previous)
    return output


def rolling_corr(primary: list[float], secondary: list[float], window: int) -> float | None:
    length = min(len(primary), len(secondary))
    if length < window + 1:
        return None
    primary_returns = daily_returns(primary[-(window + 1):])
    secondary_returns = daily_returns(secondary[-(window + 1):])
    value = pearson(primary_returns, secondary_returns)
    return None if value is None else round(max(-1.0, min(1.0, value)), 3)


def correlation_strength(value: float | None) -> str:
    if value is None:
        return "unavailable"
    absolute = abs(value)
    if absolute >= 0.55:
        return "strong"
    if absolute >= 0.32:
        return "moderate"
    if absolute >= 0.18:
        return "weak"
    return "unstable"


def correlation_label(value: float | None) -> str:
    if value is None:
        return "correlation unavailable"
    if value >= 0.18:
        return "positive correlation"
    if value <= -0.18:
        return "inverse correlation"
    return "unstable correlation"


def effective_relation(series: dict[str, Any], corr_60: float | None) -> float:
    if series["id"] == "NDX":
        return 1.0
    if corr_60 is None:
        return float(series["relation"]) * 0.65
    if abs(corr_60) < 0.18:
        return 0.0
    return corr_60


def correlation_note(series: dict[str, Any], corr_20: float | None, corr_60: float | None) -> str:
    if series["id"] == "NDX":
        return "Primary Nasdaq momentum anchor"
    if corr_60 is None:
        return "Using macro assumption; rolling correlation unavailable"
    expected = float(series["relation"])
    confirms = corr_60 * expected > 0.12
    contradicts = corr_60 * expected < -0.12
    regime = "confirms usual macro relationship" if confirms else "is flipped versus usual macro relationship" if contradicts else "is currently unstable"
    short = f"20D {corr_20:+.2f}" if corr_20 is not None else "20D n/a"
    medium = f"60D {corr_60:+.2f}"
    return f"{medium}, {short}; {regime}"


def load_daily_closes_yahoo(ticker: str) -> list[float]:
    encoded = urllib.parse.quote(ticker, safe="")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?interval=1d&range=6mo"
    payload = json.loads(fetch_bytes(url).decode("utf-8"))
    result = payload["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    return [float(value) for value in closes if value is not None]


def headline_score(title: str) -> tuple[int, str, list[str], str, str, float]:
    normalized = re.sub(r"\s+", " ", html.unescape(title).lower())
    matched_bullish = [(phrase, weight) for phrase, weight in BULLISH_PHRASES.items() if phrase in normalized]
    matched_bearish = [(phrase, weight) for phrase, weight in BEARISH_PHRASES.items() if phrase in normalized]
    score = sum(weight for _, weight in matched_bullish) + sum(weight for _, weight in matched_bearish)
    impact = "bullish" if score > 0 else "bearish" if score < 0 else "mixed"
    factors: list[str] = []
    if any(term in normalized for term in ("fed", "fomc", "rate", "yield", "treasury", "powell")):
        factors.append("Rates")
    if any(term in normalized for term in ("war", "risk", "geopolit", "conflict", "selloff", "vix", "risk-off", "risk-on")):
        factors.append("Risk")
    if any(term in normalized for term in ("inflation", "cpi", "pce")):
        factors.append("Inflation")
    if any(term in normalized for term in ("ai", "chip", "semiconductor", "nvidia")):
        factors.append("AI/Semis")
    if any(term in normalized for term in ("earnings", "guidance", "apple", "microsoft", "amazon", "meta", "alphabet", "tesla")):
        factors.append("Mega-cap earnings")
    if any(term in normalized for term in ("tariff", "antitrust", "export controls", "china")):
        factors.append("Policy")
    reason = headline_reason(normalized, score, factors, matched_bullish + matched_bearish)
    confidence = min(0.9, 0.25 + abs(score) * 0.2 + min(len(factors), 3) * 0.08)
    confidence_label = "high" if confidence >= 0.68 else "medium" if confidence >= 0.46 else "low"
    return score, impact, factors, reason, confidence_label, round(confidence, 2)


def headline_reason(normalized: str, score: int, factors: list[str], matches: list[tuple[str, int]]) -> str:
    if not score:
        return "No strong Nasdaq-sensitive phrase detected in the headline"
    if any(phrase in normalized for phrase in ("rate cut", "dovish", "lower yields", "yields fall")):
        return "lower-rate/yield language"
    if any(phrase in normalized for phrase in ("rate hike", "hawkish", "higher yields", "yields rise")):
        return "higher-rate/yield language"
    if any(phrase in normalized for phrase in ("ai rally", "chip stocks rise", "semiconductor stocks rise", "nvidia gains")):
        return "AI/semiconductor leadership language"
    if any(phrase in normalized for phrase in ("chip stocks fall", "semiconductor stocks fall", "nvidia falls")):
        return "semiconductor weakness language"
    if any(phrase in normalized for phrase in ("earnings beat", "strong guidance")):
        return "earnings/guidance support"
    if any(phrase in normalized for phrase in ("earnings miss", "weak guidance")):
        return "earnings/guidance pressure"
    if any(phrase in normalized for phrase in ("risk-on", "stocks rise", "nasdaq rises", "nasdaq rallies", "qqq rises")):
        return "risk-appetite language"
    if any(phrase in normalized for phrase in ("risk-off", "selloff", "stocks fall", "nasdaq falls", "nasdaq retreats", "qqq falls")):
        return "risk-off price-action language"
    if any(phrase in normalized for phrase in ("antitrust", "tariff", "export controls")):
        return "policy/regulatory pressure"
    if factors:
        return f"{', '.join(factors[:2]).lower()} context"
    strongest = sorted(matches, key=lambda item: abs(item[1]), reverse=True)
    return strongest[0][0] if strongest else "headline language"


def load_news() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    total_score = 0
    factors: dict[str, int] = {}
    seen: set[str] = set()

    for feed_url, default_source in NEWS_FEEDS:
        try:
            root = ET.fromstring(fetch_bytes(feed_url))
        except (OSError, ValueError, ET.ParseError, urllib.error.URLError):
            continue
        for node in root.findall(".//item"):
            title = re.sub(r"\s+", " ", html.unescape(text_of(node, "title"))).strip()
            title_key = title.casefold()
            if not title or title_key in seen or not any(term in title.lower() for term in NASDAQ_TERMS):
                continue
            seen.add(title_key)
            score, impact, item_factors, reason, confidence_label, confidence = headline_score(title)
            total_score += score
            for factor in item_factors:
                factors[factor] = factors.get(factor, 0) + 1
            published_text = text_of(node, "pubDate")
            try:
                published = parsedate_to_datetime(published_text)
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                published_iso = published.astimezone(timezone.utc).isoformat()
            except (TypeError, ValueError):
                published_iso = None
            source = text_of(node, "source") or default_source
            items.append({
                "title": title,
                "url": safe_external_url(text_of(node, "link"), "https://news.google.com/search?q=Nasdaq%20100%20OR%20NDX%20OR%20QQQ%20technology%20stocks"),
                "source": source,
                "published": published_iso,
                "impact": impact,
                "impact_label": f"estimated {impact}",
                "impact_reason": reason,
                "confidence": confidence,
                "confidence_label": confidence_label,
                "verified_article": False,
                "method": "headline estimate",
            })

    items.sort(key=lambda item: item["published"] or "", reverse=True)
    items = items[:18]

    if not items:
        raise ValueError("No relevant news items in upstream feed")

    normalized_score = max(-1.0, min(1.0, total_score / max(4, len(items) * 1.5)))
    if normalized_score >= 0.2:
        title = "Headlines lean supportive for NASDAQ"
        summary = "Recent coverage emphasizes language that can support Nasdaq risk appetite, but price may already reflect the narrative."
    elif normalized_score <= -0.2:
        title = "Headlines lean restrictive for NASDAQ"
        summary = "Recent coverage emphasizes language that can pressure Nasdaq growth/risk appetite, though cross-market confirmation still matters."
    else:
        title = "The Nasdaq narrative is balanced"
        summary = "Recent headlines contain mixed Nasdaq-sensitive language with no clear aggregate lean."

    return {
        "ok": True,
        "source": "FXStreet + attributable public news",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
        "pulse": {
            "score": round(normalized_score, 3),
            "sample_size": len(items),
            "title": title,
            "summary": summary,
            "factors": [name for name, _ in sorted(factors.items(), key=lambda pair: pair[1], reverse=True)][:4],
        },
    }


def load_market() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    weighted_score = 0.0
    total_weight = 0.0
    histories: dict[str, list[float]] = {}
    for series in MARKET_SERIES:
        try:
            histories[str(series["ticker"])] = load_daily_closes_yahoo(str(series["ticker"]))
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError, OSError, urllib.error.URLError):
            continue
    primary_history = histories.get("^NDX", [])

    for series in MARKET_SERIES:
        ticker = urllib.parse.quote(str(series["ticker"]), safe="")
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=5m&range=1d"
        try:
            payload = json.loads(fetch_bytes(url).decode("utf-8"))
            result = payload["chart"]["result"][0]
            meta = result["meta"]
            price = float(meta["regularMarketPrice"])
            previous = float(meta.get("chartPreviousClose") or meta.get("previousClose"))
            if not previous:
                continue
            change_percent = (price - previous) / previous * 100
            normalized_move = max(-1.0, min(1.0, change_percent / 0.75))
            series_history = histories.get(str(series["ticker"]), [])
            if series["id"] == "NDX":
                corr_20, corr_60 = 1.0, 1.0
            else:
                corr_20 = rolling_corr(primary_history, series_history, 20)
                corr_60 = rolling_corr(primary_history, series_history, 60)
            relation_used = effective_relation(series, corr_60)
            nasdaq_score = normalized_move * relation_used
            weight = float(series["weight"])
            weighted_score += nasdaq_score * weight
            total_weight += weight
            items.append({
                "id": series["id"], "name": series["name"], "ticker": series["ticker"],
                "price": round(price, 5), "change_percent": round(change_percent, 3),
                "nasdaq_score": round(nasdaq_score, 3), "currency": meta.get("currency", "USD"),
                "assumed_relation": float(series["relation"]),
                "effective_relation": round(relation_used, 3),
                "correlation_20": corr_20,
                "correlation_60": corr_60,
                "correlation_strength": correlation_strength(corr_60),
                "correlation_label": correlation_label(corr_60),
                "correlation_note": correlation_note(series, corr_20, corr_60),
                "relation_source": "rolling_60d_correlation" if corr_60 is not None and series["id"] != "NDX" else "primary_or_macro_fallback",
                "data_proxy": False,
                "proxy_note": "",
            })
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError, OSError, urllib.error.URLError):
            continue

    if len(items) < 3 or not total_weight:
        raise ValueError("Insufficient live cross-market data")
    score = max(-1.0, min(1.0, weighted_score / total_weight))
    if score >= 0.18:
        title = "Cross-market context leans bullish"
    elif score <= -0.18:
        title = "Cross-market context leans bearish"
    else:
        title = "Cross-market context is balanced"
    strongest = sorted(items, key=lambda item: abs(item["nasdaq_score"]), reverse=True)[:3]
    summary = "Correlation-aware live movement: " + ", ".join(
        f'{item["id"]} {"supports" if item["nasdaq_score"] > .1 else "pressures" if item["nasdaq_score"] < -.1 else "is neutral for"} Nasdaq ({item.get("correlation_label", "correlation n/a")})'
        for item in strongest
    ) + ". Weak or unstable correlations are muted instead of forced into a directional read."
    return {
        "ok": True,
        "source": "Yahoo Finance public chart data",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
        "pulse": {"score": round(score, 3), "sample_size": len(items), "title": title, "summary": summary},
    }


def new_york_timezone(local_date: datetime):
    if ZoneInfo is not None:
        try:
            return ZoneInfo("America/New_York")
        except ZoneInfoNotFoundError:
            pass
    # U.S. DST fallback: second Sunday in March through first Sunday in November.
    march = calendar.monthcalendar(local_date.year, 3)
    sundays_march = [week[calendar.SUNDAY] for week in march if week[calendar.SUNDAY]]
    november = calendar.monthcalendar(local_date.year, 11)
    sundays_november = [week[calendar.SUNDAY] for week in november if week[calendar.SUNDAY]]
    dst_start = datetime(local_date.year, 3, sundays_march[1], 2)
    dst_end = datetime(local_date.year, 11, sundays_november[0], 2)
    return timezone(timedelta(hours=-4 if dst_start <= local_date < dst_end else -5))


def parse_calendar_datetime(date_text: str, time_text: str) -> str | None:
    if not date_text or not time_text or time_text.lower() in {"all day", "tentative"}:
        return None
    parsed_date = None
    for pattern in ("%m-%d-%Y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            parsed_date = datetime.strptime(date_text, pattern)
            break
        except ValueError:
            continue
    if parsed_date is None:
        return None
    compact_time = time_text.lower().replace(" ", "")
    parsed_time = None
    for pattern in ("%I:%M%p", "%I%p", "%H:%M"):
        try:
            parsed_time = datetime.strptime(compact_time, pattern)
            break
        except ValueError:
            continue
    if parsed_time is None:
        return None
    local_naive = parsed_date.replace(hour=parsed_time.hour, minute=parsed_time.minute)
    aware = local_naive.replace(tzinfo=new_york_timezone(local_naive))
    return aware.astimezone(timezone.utc).isoformat()


def load_calendar() -> dict[str, Any]:
    root = ET.fromstring(fetch_bytes(CALENDAR_URL))
    now = datetime.now(timezone.utc)
    events: list[dict[str, Any]] = []
    for node in root.findall(".//event"):
        country = text_of(node, "country").upper()
        impact = text_of(node, "impact").title()
        if country != "USD" or impact not in {"High", "Medium"}:
            continue
        event_time = parse_calendar_datetime(text_of(node, "date"), text_of(node, "time"))
        if event_time:
            parsed = datetime.fromisoformat(event_time)
            if parsed < now - timedelta(hours=3):
                continue
        events.append({
            "title": html.unescape(text_of(node, "title")),
            "country": country,
            "impact": impact,
            "time_utc": event_time,
            "forecast": text_of(node, "forecast"),
            "previous": text_of(node, "previous"),
            "url": safe_external_url(text_of(node, "url"), "https://www.forexfactory.com/calendar"),
        })
    events.sort(key=lambda event: (event["time_utc"] is None, event["time_utc"] or "9999"))
    if not events:
        raise ValueError("No upcoming USD calendar events in feed")
    return {
        "ok": True,
        "source": "Forex Factory calendar feed",
        "updated_at": now.isoformat(),
        "events": events[:14],
    }


class LiqueDTHandler(SimpleHTTPRequestHandler):
    server_version = "LiqueDT/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/news":
            self.send_json(CACHE.get("news", 180, load_news))
            return
        if path == "/api/calendar":
            self.send_json(CACHE.get("calendar", 900, load_calendar))
            return
        if path == "/api/market":
            self.send_json(CACHE.get("market", 60, load_market))
            return
        if path == "/api/health":
            self.send_json({"ok": True, "service": "liquedt-gateway", "time": datetime.now(timezone.utc).isoformat()})
            return
        super().do_GET()

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://s3.tradingview.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; "
            "frame-src https://s.tradingview.com https://www.tradingview.com https://www.tradingview-widget.com; "
            "connect-src 'self' https://*.tradingview.com wss://*.tradingview.com; "
            "form-action 'self' https://formsubmit.co",
        )
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LiqueDT locally")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), LiqueDTHandler)
    print(f"LiqueDT is live at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
