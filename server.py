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
    ("https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENDX&region=US&lang=en-US", "Yahoo Finance NDX"),
    ("https://feeds.finance.yahoo.com/rss/2.0/headline?s=QQQ&region=US&lang=en-US", "Yahoo Finance QQQ"),
    ("https://news.google.com/rss/search?q=%28US100%20OR%20NAS100%20OR%20Nasdaq%20OR%20%22Nasdaq%20100%22%20OR%20NDX%20OR%20QQQ%20OR%20%22tech%20stocks%22%20OR%20AI%20OR%20semiconductor%20OR%20VXN%20OR%20%22Treasury%20yields%22%29%20%28Fed%20OR%20yields%20OR%20CPI%20OR%20PCE%20OR%20Nvidia%20OR%20Apple%20OR%20Microsoft%20OR%20earnings%20OR%20tariff%20OR%20Trump%20OR%20chip%29&hl=en-US&gl=US&ceid=US%3Aen", "Google News"),
)
CALENDAR_URLS = (
    "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.xml",
)
NASDAQ100_URL = "https://api.nasdaq.com/api/quote/list-type/nasdaq100"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 LiqueDT/1.7"
DIRECT_MARKET_TERMS = (
    "us100", "us 100", "u.s. tech 100", "nas100", "nasdaq futures", "e-mini nasdaq",
    "nasdaq 100", "nasdaq-100", "nasdaq composite", "ndx", "qqq", "tech stocks",
    "technology stocks", "growth stocks", "u.s. stocks", "us stocks", "wall street", "stock market",
    "s&p 500", "sp 500", "dow", "dow jones",
)
MEGACAP_TERMS = (
    "nvidia", "nvda", "apple", "aapl", "microsoft", "msft", "amazon", "amzn", "meta",
    "alphabet", "google", "googl", "tesla", "tsla", "broadcom", "avgo", "micron", "amd",
)
SEMI_TERMS = ("chip", "chips", "semiconductor", "semiconductors", "sox", "ai stocks", "ai trade")
MARKET_MOVING_TERMS = (
    "rise", "rises", "rally", "rallies", "gain", "gains", "jump", "jumps", "soar", "soars",
    "advance", "advances", "rebound", "rebounds", "fall", "falls", "drop", "drops", "slide", "slides",
    "selloff", "sell-off", "rout", "crater", "slump", "tumble", "earnings", "guidance", "outlook",
    "revenue", "profit", "forecast", "upside", "downgrade", "upgrade", "deal", "investment", "spending",
    "antitrust", "tariff", "export controls", "ban", "probe", "warning", "demand", "orders",
)
MACRO_TERMS = (
    "fed", "fomc", "powell", "u.s. treasury", "us treasury", "treasury yields", "bond yields",
    "rate cut", "rate hike", "u.s. inflation", "us inflation", "u.s. cpi", "us cpi", "core cpi",
    "core pce", "nonfarm payroll", "non-farm payroll", "u.s. jobs", "us jobs", "retail sales", "ism pmi",
)
POLICY_TERMS = ("trump", "white house", "china tech", "chip export", "export controls", "tech tariff", "antitrust")

MARKET_SERIES = (
    {"id": "NDX", "ticker": "^NDX", "name": "NAS100 / Nasdaq 100", "relation": 1.0, "weight": 0.28, "move_scale": 1.25},
    {"id": "SPX", "ticker": "^GSPC", "name": "S&P 500 / US500", "relation": 1.0, "weight": 0.17, "move_scale": 1.00},
    {"id": "DJI", "ticker": "^DJI", "name": "Dow Jones / US30", "relation": 1.0, "weight": 0.07, "move_scale": 0.90},
    {"id": "US10Y", "ticker": "^TNX", "name": "U.S. 10Y yield", "relation": -1.0, "weight": 0.16, "move_scale": 2.00},
    {"id": "VXN", "ticker": "^VXN", "name": "Nasdaq-100 Volatility Index", "relation": -1.0, "weight": 0.15, "move_scale": 8.00},
    {"id": "SOX", "ticker": "^SOX", "name": "PHLX Semiconductor Index", "relation": 1.0, "weight": 0.12, "move_scale": 2.00},
    {"id": "DXY", "ticker": "DX-Y.NYB", "name": "U.S. Dollar Index", "relation": -0.5, "weight": 0.05, "move_scale": 0.50},
)

BULLISH_PHRASES = {
    "rate hike fears ease": 3, "rate hike odds fall": 3, "rate cut odds rise": 3, "rate cut bets grow": 3,
    "dovish": 2, "lower yields": 2, "yields fall": 2, "yields drop": 2, "yields slide": 2,
    "inflation cools": 2, "inflation eases": 2, "below forecast": 1, "soft landing": 1, "risk-on": 2,
    "nasdaq rallies": 3, "nasdaq rises": 3, "nasdaq gains": 3, "nasdaq jumps": 3, "nasdaq rebounds": 3,
    "tech stocks rise": 2, "tech stocks rally": 2, "stocks rise": 1, "stocks gain": 1,
    "chip stocks rise": 2, "semiconductor stocks rise": 2, "ai rally": 2, "ai tailwind": 1,
    "earnings beat": 2, "beats estimates": 2, "raises guidance": 2, "strong guidance": 2,
    "soars": 2, "soar": 2, "jumps": 2, "jump": 2, "rebounds": 1, "rebound": 1, "upside": 1, "record high": 2, "all-time high": 2, "vxn falls": 2, "vxn drops": 2, "vix falls": 1, "upgraded": 1, "raises price target": 1, "strong demand": 1, "ai boom": 2, "data center demand": 2, "blockbuster earnings": 1,
}
BEARISH_PHRASES = {
    "rate cut bets fade": -3, "rate cut odds fall": -3, "rate hike odds rise": -3, "rate hike bets grow": -3, "fed hike bets": -2,
    "hawkish": -2, "higher yields": -2, "yields rise": -2, "yields climb": -2, "yields surge": -2,
    "inflation hotter": -2, "inflation accelerates": -2, "above forecast": -1, "risk-off": -2,
    "nasdaq falls": -3, "nasdaq drops": -3, "nasdaq retreats": -3, "nasdaq slides": -3,
    "tech stocks fall": -2, "tech sell-off": -2, "tech selloff": -2, "stocks fall": -1, "stocks drop": -1,
    "chip stocks fall": -2, "semiconductor selloff": -2, "ai rout": -2, "ai trade cools": -2,
    "earnings miss": -2, "misses estimates": -2, "cuts guidance": -2, "weak guidance": -2,
    "selloff": -2, "sell-off": -2, "rout": -2, "crater": -2, "slumps": -2, "tumbles": -2,
    "downside": -1, "warning": -1, "vxn surges": -2, "vxn spikes": -2, "vix spikes": -1, "export controls": -1, "antitrust": -1, "downgraded": -1, "bubble": -1, "valuation concern": -1, "chip costs soar": -2, "costs soar": -2, "under pressure": -1, "doesn't inspire": -1, "don't inspire": -2, "do not inspire": -1, "rate hike penciled": -2, "hawkish fed outlook": -2, "playing defence": -1, "playing defense": -1,
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


def finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def pearson(values_a: list[float], values_b: list[float]) -> float | None:
    if len(values_a) != len(values_b) or len(values_a) < 6:
        return None
    if not all(math.isfinite(value) for value in values_a + values_b):
        return None
    mean_a = sum(values_a) / len(values_a)
    mean_b = sum(values_b) / len(values_b)
    centered_a = [value - mean_a for value in values_a]
    centered_b = [value - mean_b for value in values_b]
    denom_a = math.sqrt(sum(value * value for value in centered_a))
    denom_b = math.sqrt(sum(value * value for value in centered_b))
    if not denom_a or not denom_b or not math.isfinite(denom_a) or not math.isfinite(denom_b):
        return None
    result = sum(a * b for a, b in zip(centered_a, centered_b)) / (denom_a * denom_b)
    return result if math.isfinite(result) else None


def daily_returns(closes: list[float]) -> list[float]:
    output: list[float] = []
    for previous, current in zip(closes, closes[1:]):
        if previous and math.isfinite(previous) and math.isfinite(current):
            change = (current - previous) / previous
            if math.isfinite(change):
                output.append(change)
    return output


def rolling_corr(primary: list[float], secondary: list[float], window: int) -> float | None:
    length = min(len(primary), len(secondary))
    if length < window + 1:
        return None
    primary_returns = daily_returns(primary[-(window + 1):])
    secondary_returns = daily_returns(secondary[-(window + 1):])
    value = pearson(primary_returns, secondary_returns)
    return None if value is None or not math.isfinite(value) else round(max(-1.0, min(1.0, value)), 3)


def correlation_strength(value: float | None) -> str:
    if value is None or not math.isfinite(value):
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
    if value is None or not math.isfinite(value):
        return "correlation unavailable"
    if value >= 0.18:
        return "positive correlation"
    if value <= -0.18:
        return "inverse correlation"
    return "unstable correlation"


def effective_relation(series: dict[str, Any], corr_60: float | None) -> float:
    if series["id"] == "NDX":
        return 1.0
    if corr_60 is None or not math.isfinite(corr_60):
        return float(series["relation"]) * 0.65
    if abs(corr_60) < 0.18:
        return 0.0
    return corr_60
def correlation_note(series: dict[str, Any], corr_20: float | None, corr_60: float | None) -> str:
    if series["id"] == "NDX":
        return "Primary NAS100 / Nasdaq-100 momentum anchor"
    if corr_60 is None:
        return "Using macro assumption; rolling correlation unavailable"
    expected = float(series["relation"])
    confirms = corr_60 * expected > 0.12
    contradicts = corr_60 * expected < -0.12
    regime = "confirms usual macro relationship" if confirms else "is flipped versus usual macro relationship" if contradicts else "is currently unstable"
    short = f"20D {corr_20:+.2f}" if corr_20 is not None else "20D n/a"
    medium = f"60D {corr_60:+.2f}"
    return f"{medium}, {short}; {regime}"


def load_daily_history_yahoo(ticker: str) -> list[dict[str, Any]]:
    encoded = urllib.parse.quote(ticker, safe="")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?interval=1d&range=6mo"
    payload = json.loads(fetch_bytes(url).decode("utf-8"))
    result = payload["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    timestamps = result.get("timestamp") or []
    output: list[dict[str, Any]] = []
    total = len(closes)
    for index, value in enumerate(closes):
        number = finite_float(value)
        if number is None:
            continue
        stamp = timestamps[index] if index < len(timestamps) else None
        if stamp:
            date = datetime.fromtimestamp(float(stamp), timezone.utc).date().isoformat()
        else:
            date = (datetime.now(timezone.utc).date() - timedelta(days=max(0, total - index - 1))).isoformat()
        output.append({"date": date, "value": round(number, 5)})
    return output


def history_values(history: list[dict[str, Any]]) -> list[float]:
    values: list[float] = []
    for point in history:
        number = finite_float(point.get("value"))
        if number is not None:
            values.append(number)
    return values


def load_daily_closes_yahoo(ticker: str) -> list[float]:
    return history_values(load_daily_history_yahoo(ticker))


def contains_term(value: str, term: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", value) is not None


def contains_any_term(value: str, terms: tuple[str, ...]) -> bool:
    return any(contains_term(value, term) for term in terms)


def is_nasdaq_relevant(title: str) -> bool:
    normalized = re.sub(r"\s+", " ", html.unescape(title).lower()).strip()
    cleaned = re.sub(r"\((?:nasdaq|nyse|amex|otc):[^)]+\)", " ", normalized)
    if contains_any_term(cleaned, DIRECT_MARKET_TERMS):
        return True
    if contains_any_term(cleaned, MACRO_TERMS) or contains_any_term(cleaned, POLICY_TERMS):
        return True
    has_mover = contains_any_term(cleaned, MARKET_MOVING_TERMS)
    return has_mover and (contains_any_term(cleaned, MEGACAP_TERMS) or contains_any_term(cleaned, SEMI_TERMS))


def directional_matches(normalized: str) -> list[tuple[str, int]]:
    candidates = sorted((*BULLISH_PHRASES.items(), *BEARISH_PHRASES.items()), key=lambda pair: len(pair[0]), reverse=True)
    occupied: list[tuple[int, int]] = []
    matches: list[tuple[str, int]] = []
    for phrase, weight in candidates:
        for found in re.finditer(re.escape(phrase), normalized):
            span = found.span()
            if any(span[0] < end and span[1] > start for start, end in occupied):
                continue
            occupied.append(span)
            matches.append((phrase, weight))
            break
    return matches



def contextual_headline_score(normalized: str) -> tuple[int, str] | None:
    bearish_policy = ("tariff", "export controls", "antitrust", "probe", "ban", "china restrictions", "regulatory scrutiny")
    bearish_risk = ("uncertainty", "fear", "risk-off", "sell pressure", "valuation concern", "bubble", "warning", "under pressure", "doesn't inspire", "don't inspire", "playing defence", "playing defense")
    bullish_ai = ("ai spending", "ai demand", "data center demand", "ai boom", "chip demand", "investment plan", "strong demand")
    bullish_risk = ("risk appetite", "soft landing", "growth optimism", "record close", "new high")
    if any(term in normalized for term in bearish_policy):
        return -1, "policy/regulatory pressure"
    if any(term in normalized for term in bearish_risk):
        return -1, "risk or valuation pressure"
    if any(term in normalized for term in bullish_ai):
        return 1, "AI/semiconductor demand support"
    if any(term in normalized for term in bullish_risk):
        return 1, "risk appetite support"
    if "earnings" in normalized and any(term in normalized for term in ("preview", "ahead", "wait", "watch")):
        return None
    if any(term in normalized for term in ("nvidia", "microsoft", "apple", "amazon", "meta", "alphabet", "tesla")) and any(term in normalized for term in ("demand", "growth", "launch", "deal", "investment")):
        return 1, "mega-cap growth support"
    return None

def headline_score(title: str) -> tuple[int, str, list[str], str, str, float]:
    normalized = re.sub(r"\s+", " ", html.unescape(title).lower())
    matches = directional_matches(normalized)
    positive = sum(weight for _, weight in matches if weight > 0)
    negative = sum(weight for _, weight in matches if weight < 0)
    score = positive + negative
    if positive and negative and abs(score) <= 1:
        score = 0
    factors: list[str] = []
    if any(term in normalized for term in ("fed", "fomc", "rate", "yield", "treasury", "powell")):
        factors.append("Rates")
    if any(term in normalized for term in ("war", "risk", "geopolit", "conflict", "selloff", "sell-off", "rout", "vix", "vxn", "risk-off", "risk-on")):
        factors.append("Risk")
    if any(term in normalized for term in ("inflation", "cpi", "pce")):
        factors.append("Inflation")
    if any(term in normalized for term in ("ai", "chip", "semiconductor", "nvidia", "micron", "broadcom", "amd")):
        factors.append("AI/Semis")
    if any(term in normalized for term in ("earnings", "guidance", "apple", "microsoft", "amazon", "meta", "alphabet", "tesla")):
        factors.append("Mega-cap earnings")
    if any(term in normalized for term in ("tariff", "antitrust", "export controls", "china", "white house", "trump")):
        factors.append("Policy")
    contextual = contextual_headline_score(normalized) if score == 0 else None
    if contextual:
        score, contextual_reason = contextual
        matches.append((contextual_reason, score))
    impact = "bullish" if score > 0 else "bearish" if score < 0 else "mixed"
    reason = headline_reason(normalized, score, factors, matches, positive, negative)
    confidence = min(0.94, 0.26 + abs(score) * 0.20 + min(len(factors), 3) * 0.09)
    if contextual and abs(score) == 1:
        confidence = max(confidence, 0.48)
    if score == 0:
        confidence = min(confidence, 0.38)
    confidence_label = "high" if confidence >= 0.70 else "medium" if confidence >= 0.46 else "low"
    return score, impact, factors, reason, confidence_label, round(confidence, 2)


def headline_reason(normalized: str, score: int, factors: list[str], matches: list[tuple[str, int]], positive: int, negative: int) -> str:
    if positive and negative and score == 0:
        return "conflicting bullish and bearish signals in the headline"
    if not score:
        return "no reliable Nasdaq direction detected from the headline alone"
    if any(phrase in normalized for phrase in ("rate hike fears ease", "rate hike odds fall", "rate cut odds rise", "rate cut bets grow", "dovish", "lower yields", "yields fall", "yields drop", "yields slide")):
        return "lower-rate/yield pressure language"
    if any(phrase in normalized for phrase in ("rate cut bets fade", "rate cut odds fall", "rate hike odds rise", "rate hike bets grow", "fed hike bets", "hawkish", "higher yields", "yields rise", "yields climb", "yields surge")):
        return "higher-rate/yield pressure language"
    if any(phrase in normalized for phrase in ("ai rally", "ai tailwind", "chip stocks rise", "semiconductor stocks rise")):
        return "AI/semiconductor leadership language"
    if any(phrase in normalized for phrase in ("ai rout", "ai trade cools", "chip stocks fall", "semiconductor selloff", "crater")):
        return "AI/semiconductor weakness language"
    if any(phrase in normalized for phrase in ("earnings beat", "beats estimates", "raises guidance", "strong guidance")):
        return "earnings/guidance support"
    if any(phrase in normalized for phrase in ("earnings miss", "misses estimates", "cuts guidance", "weak guidance")):
        return "earnings/guidance pressure"
    if score > 0 and any(phrase in normalized for phrase in ("rall", "rise", "gain", "jump", "soar", "rebound", "upside", "record high")):
        return "positive market or company price-action language"
    if score < 0 and any(phrase in normalized for phrase in ("fall", "drop", "retreat", "slide", "selloff", "sell-off", "rout", "slump", "tumble", "warning")):
        return "negative market or company price-action language"
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
            source = text_of(node, "source") or default_source
            if source:
                title = re.sub(rf"\s+-\s+{re.escape(source)}$", "", title, flags=re.IGNORECASE).strip()
            title_key = re.sub(r"\s+-\s+[^-]{2,80}$", "", title).casefold()
            if not title or title_key in seen or not is_nasdaq_relevant(title):
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
                "direction_score": score,
                "factors": item_factors,
                "verified_article": False,
                "method": "headline estimate",
            })

    items.sort(key=lambda item: item["published"] or "", reverse=True)
    items = items[:18]

    if not items:
        raise ValueError("No relevant NASDAQ news items in upstream feed")

    total_score = sum(int(item.get("direction_score", 0)) for item in items)
    factors = {}
    for item in items:
        for factor in item.get("factors", []):
            factors[factor] = factors.get(factor, 0) + 1
    normalized_score = max(-1.0, min(1.0, total_score / max(4, len(items) * 1.5)))
    if normalized_score >= 0.2:
        title = "Headlines lean supportive for NASDAQ"
        summary = "Recent coverage emphasizes language that can support Nasdaq risk appetite, but price may already reflect the narrative."
    elif normalized_score <= -0.2:
        title = "Headlines lean restrictive for NASDAQ"
        summary = "Recent coverage emphasizes language that can pressure Nasdaq growth/risk appetite, though cross-market confirmation still matters."
    else:
        title = "The NASDAQ narrative is balanced"
        summary = "Recent headlines contain mixed NASDAQ-sensitive language with no clear aggregate lean."

    return {
        "ok": True,
        "source": "FXStreet + Yahoo Finance + attributable public news (Nasdaq filter)",
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



def compact_money(value: str) -> str:
    if not value:
        return "n/a"
    return html.unescape(str(value)).strip() or "n/a"


def load_companies() -> dict[str, Any]:
    payload = json.loads(fetch_bytes(NASDAQ100_URL).decode("utf-8"))
    data = payload.get("data") or {}
    table = data.get("data") or {}
    rows = table.get("rows") or []
    items: list[dict[str, Any]] = []
    for rank, row in enumerate(rows, 1):
        symbol = html.unescape(str(row.get("symbol") or "")).strip()
        name = html.unescape(str(row.get("companyName") or row.get("name") or "")).strip()
        if not symbol or not name:
            continue
        items.append({
            "rank": rank,
            "symbol": symbol,
            "name": name,
            "market_cap": compact_money(row.get("marketCap") or row.get("marketcap") or ""),
            "last_sale": compact_money(row.get("lastSalePrice") or row.get("lastsale") or ""),
            "net_change": compact_money(row.get("netChange") or row.get("netchange") or ""),
            "percent_change": compact_money(row.get("percentageChange") or row.get("pctchange") or ""),
        })
    if not items:
        raise ValueError("No Nasdaq-100 constituents returned")
    return {
        "ok": True,
        "source": "Official Nasdaq quote list-type/nasdaq100 endpoint",
        "source_url": NASDAQ100_URL,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "as_of": data.get("date"),
        "total_records": data.get("totalrecords") or len(items),
        "items": items,
    }

def load_market() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    weighted_score = 0.0
    total_weight = 0.0
    histories: dict[str, list[dict[str, Any]]] = {}
    for series in MARKET_SERIES:
        try:
            histories[str(series["ticker"])] = load_daily_history_yahoo(str(series["ticker"]))
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError, OSError, urllib.error.URLError):
            continue
    primary_history = history_values(histories.get("^NDX", []))

    for series in MARKET_SERIES:
        ticker = urllib.parse.quote(str(series["ticker"]), safe="")
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=5m&range=1d"
        try:
            payload = json.loads(fetch_bytes(url).decode("utf-8"))
            result = payload["chart"]["result"][0]
            meta = result["meta"]
            price = finite_float(meta.get("regularMarketPrice"))
            previous = finite_float(meta.get("chartPreviousClose") or meta.get("previousClose"))
            if price is None or previous is None or not previous:
                continue
            change_percent = (price - previous) / previous * 100
            if not math.isfinite(change_percent):
                continue
            normalized_move = max(-1.0, min(1.0, change_percent / float(series["move_scale"])))
            series_history_points = histories.get(str(series["ticker"]), [])
            series_history = history_values(series_history_points)
            if series["id"] == "NDX":
                corr_20, corr_60 = 1.0, 1.0
            else:
                corr_20 = rolling_corr(primary_history, series_history, 20)
                corr_60 = rolling_corr(primary_history, series_history, 60)
            relation_used = effective_relation(series, corr_60)
            nasdaq_score = normalized_move * relation_used
            if not math.isfinite(relation_used) or not math.isfinite(nasdaq_score):
                continue
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
                "history": series_history_points[-126:],
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
    summary = "Correlation-aware NASDAQ movement: " + ", ".join(
        f'{item["id"]} {"supports" if item["nasdaq_score"] > .1 else "pressures" if item["nasdaq_score"] < -.1 else "is neutral for"} Nasdaq ({item.get("correlation_label", "correlation n/a")})'
        for item in strongest
    ) + ". The gauge is driven by each market move multiplied by its rolling Nasdaq-100 correlation; weak regimes are muted."
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
    # Forex Factory's public XML feed timestamps are UTC; the UI converts them to SGT.
    utc_time = parsed_date.replace(hour=parsed_time.hour, minute=parsed_time.minute, tzinfo=timezone.utc)
    return utc_time.isoformat()


def parse_event_number(value: str | None) -> float | None:
    if not value:
        return None
    text = html.unescape(str(value)).strip().lower().replace(",", "")
    if not text or text in {"n/a", "na", "-"}:
        return None
    multiplier = 1.0
    if text.endswith("k"):
        multiplier, text = 1_000.0, text[:-1]
    elif text.endswith("m"):
        multiplier, text = 1_000_000.0, text[:-1]
    elif text.endswith("b"):
        multiplier, text = 1_000_000_000.0, text[:-1]
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    return float(match.group(0)) * multiplier if match else None


def calendar_result_effect(title: str, actual: str, forecast: str, previous: str) -> dict[str, Any]:
    normalized = title.lower()
    if not actual:
        return {"status": "pending", "bias": "pending", "score": 0.0, "reason": "waiting for actual result"}
    actual_value = parse_event_number(actual)
    benchmark_value = parse_event_number(forecast) if forecast else parse_event_number(previous)
    if actual_value is None or benchmark_value is None:
        return {"status": "released", "bias": "mixed", "score": 0.0, "reason": "actual result released; numeric surprise unavailable"}
    threshold = max(abs(benchmark_value) * 0.005, 0.01)
    if abs(actual_value - benchmark_value) <= threshold:
        return {"status": "released", "bias": "mixed", "score": 0.0, "reason": "actual was broadly in line with forecast"}
    hotter = actual_value > benchmark_value
    inflation_terms = ("cpi", "pce", "ppi", "inflation", "average hourly earnings", "wages")
    slack_terms = ("unemployment rate", "unemployment claims", "jobless claims")
    jobs_terms = ("non-farm", "nonfarm", "payroll", "adp", "jolts", "job openings")
    growth_terms = ("retail sales", "gdp", "pmi", "ism", "consumer confidence", "consumer sentiment", "durable goods", "factory orders", "industrial production", "housing", "home sales")
    if any(term in normalized for term in inflation_terms):
        return {"status": "released", "bias": "bearish" if hotter else "bullish", "score": -0.65 if hotter else 0.65, "reason": "hotter inflation/wages can lift yields" if hotter else "cooler inflation/wages can ease rate pressure"}
    if any(term in normalized for term in slack_terms):
        return {"status": "released", "bias": "bullish" if hotter else "bearish", "score": 0.45 if hotter else -0.45, "reason": "more labour slack can support rate-cut expectations" if hotter else "tighter labour data can keep yields firm"}
    if any(term in normalized for term in jobs_terms):
        return {"status": "released", "bias": "bearish" if hotter else "bullish", "score": -0.45 if hotter else 0.45, "reason": "stronger jobs can revive rate-pressure risk" if hotter else "softer jobs can support rate-relief expectations"}
    if any(term in normalized for term in growth_terms):
        return {"status": "released", "bias": "bullish" if hotter else "bearish", "score": 0.35 if hotter else -0.35, "reason": "stronger growth supports equity risk appetite" if hotter else "weaker growth can pressure risk sentiment"}
    return {"status": "released", "bias": "mixed", "score": 0.0, "reason": "result released; NASDAQ effect depends on yields and risk reaction"}


def calendar_pulse(events: list[dict[str, Any]]) -> dict[str, Any]:
    released = [event for event in events if event.get("result_status") == "released" and event.get("result_bias") in {"bullish", "bearish"}]
    released.sort(key=lambda event: event.get("time_utc") or "", reverse=True)
    if not released:
        return {"score": 0.0, "sample_size": 0, "title": "No fresh USD result yet", "summary": "Upcoming events are on watch, but no released result is currently biasing NASDAQ.", "factors": ["Event risk"], "latest_result": None}
    score = max(-1.0, min(1.0, sum(float(event.get("result_score") or 0) for event in released) / max(1, len(released))))
    latest = released[0]
    read = "bullish" if score >= 0.18 else "bearish" if score <= -0.18 else "mixed"
    return {"score": round(score, 3), "sample_size": len(released), "title": f"Fresh USD result leans {read} for NASDAQ", "summary": f"Latest result: {latest.get('title')} actual {latest.get('actual') or 'released'} vs forecast {latest.get('forecast') or 'n/a'}; {latest.get('result_reason')}", "factors": ["USD result", latest.get("nasdaq_relevance") or "Event risk"], "latest_result": latest}


def calendar_relevance(title: str) -> tuple[str, str] | None:
    normalized = title.lower()
    if any(term in normalized for term in ("fomc", "federal funds rate", "interest rate decision", "fed chair", "powell")):
        return "Critical", "Fed policy can reprice yields and growth-stock valuations immediately"
    if any(term in normalized for term in ("core cpi", "cpi ", "consumer price index", "core pce", "pce price", "non-farm", "nonfarm", "unemployment rate", "average hourly earnings")):
        return "Critical", "Inflation or labour data can rapidly shift Fed-rate expectations"
    if any(term in normalized for term in ("ppi", "retail sales", "ism manufacturing", "ism services", "gdp", "jolts", "unemployment claims", "jobless claims", "flash manufacturing pmi", "flash services pmi", "philly fed", "empire state")):
        return "High", "Growth or inflation data can move Treasury yields and U.S. equity risk appetite"
    if any(term in normalized for term in ("consumer confidence", "consumer sentiment", "inflation expectations", "adp", "durable goods", "factory orders", "industrial production", "housing starts", "building permits", "new home sales", "pending home sales", "fed member", "treasury auction")):
        return "Watch", "Secondary macro signal that can matter when it changes the rates or growth narrative"
    if any(term in normalized for term in ("president trump speaks", "president speaks", "white house")):
        return "Watch", "Policy headlines can affect tariffs, regulation and large technology companies"
    return None


def load_calendar() -> dict[str, Any]:
    roots: list[ET.Element] = []
    errors: list[str] = []
    for url in CALENDAR_URLS:
        try:
            roots.append(ET.fromstring(fetch_bytes(url)))
        except (OSError, ValueError, ET.ParseError, urllib.error.URLError) as exc:
            errors.append(f"{url}: {type(exc).__name__}")
    if not roots:
        raise ValueError("; ".join(errors) or "Calendar feeds unavailable")

    now = datetime.now(timezone.utc)
    events: list[dict[str, Any]] = []
    seen_events: set[tuple[str, str, str]] = set()
    for root in roots:
        for node in root.findall(".//event"):
            country = text_of(node, "country").upper()
            impact = text_of(node, "impact").title()
            if country != "USD" or impact not in {"High", "Medium"}:
                continue
            title = html.unescape(text_of(node, "title"))
            relevance = calendar_relevance(title)
            if relevance is None:
                continue
            event_time = parse_calendar_datetime(text_of(node, "date"), text_of(node, "time"))
            actual = text_of(node, "actual")
            forecast = text_of(node, "forecast")
            previous = text_of(node, "previous")
            if event_time:
                parsed = datetime.fromisoformat(event_time)
                keep_recent_result = bool(actual) and parsed >= now - timedelta(hours=36)
                if parsed < now - timedelta(hours=3) and not keep_recent_result:
                    continue
            event_key = (title, event_time or "", actual)
            if event_key in seen_events:
                continue
            seen_events.add(event_key)
            result = calendar_result_effect(title, actual, forecast, previous)
            events.append({
                "title": title,
                "country": country,
                "impact": impact,
                "nasdaq_relevance": relevance[0],
                "nasdaq_reason": relevance[1],
                "time_utc": event_time,
                "actual": actual,
                "forecast": forecast,
                "previous": previous,
                "result_status": result["status"],
                "result_bias": result["bias"],
                "result_score": result["score"],
                "result_reason": result["reason"],
                "url": safe_external_url(text_of(node, "url"), "https://www.forexfactory.com/calendar"),
            })
    events.sort(key=lambda event: (event["time_utc"] is None, event["time_utc"] or "9999"))
    return {
        "ok": True,
        "source": "Forex Factory calendar feed this week + next week (UTC normalized to SGT in app)",
        "updated_at": now.isoformat(),
        "events": events[:14],
        "pulse": calendar_pulse(events[:14]),
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
        if path == "/api/companies":
            self.send_json(CACHE.get("companies", 3600, load_companies))
            return
        if path == "/api/market":
            self.send_json(CACHE.get("market", 60, load_market))
            return
        if path == "/api/health":
            self.send_json({"ok": True, "service": "liquedt-gateway", "time": datetime.now(timezone.utc).isoformat()})
            return
        super().do_GET()

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
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
