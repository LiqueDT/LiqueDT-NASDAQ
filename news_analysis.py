"""Shared-rule NASDAQ headline analysis. Evidence strength is not a price probability."""
from __future__ import annotations
import html
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RULES = json.loads((ROOT / "news_rules.json").read_text(encoding="utf-8"))


def normalize(text):
    return re.sub(r"\s+", " ", html.unescape(text).lower().translate(str.maketrans({"’": "'", "‘": "'", "–": "-", "—": ";"})).replace("rate-cut", "rate cut").replace("rate-hike", "rate hike")).strip()


def terms_pattern(terms):
    return r"(?<![a-z0-9-])(?:" + "|".join(re.escape(t) for t in sorted(set(terms), key=len, reverse=True)) + r")(?![a-z0-9])"


def company_aliases(title):
    aliases = list(RULES["aliases"]["companies"])
    try:
        rows = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8")).get("items", [])
        for row in rows:
            name = re.split(r"\b(?:inc\.?|corporation|corp\.?|plc|limited|ltd\.?|class|common|ordinary|american|new york)\b", normalize(row.get("name", "")))[0].strip(" .,()")
            if len(name) >= 4:
                aliases.append(name)
            symbol = row.get("symbol", "")
            if len(symbol) >= 2 and re.search(r"(?<![A-Za-z0-9])" + re.escape(symbol) + r"(?![A-Za-z0-9])", title):
                aliases.append(symbol.lower())
    except (OSError, ValueError):
        pass
    return aliases


def analyze(title):
    text = re.sub(r"\((?:nasdaq|nyse|amex|otc):[^)]+\)", " ", normalize(title))
    text = re.sub(r"\b(?:nasdaq|nyse|amex|otc)\s*:\s*[a-z0-9.-]+|\bnasdaq[- ]listed\b", " ", text)
    aliases = RULES["aliases"]
    companies = company_aliases(title)
    direct = bool(re.search(terms_pattern(aliases["index"]), text))
    broad = bool(re.search(terms_pattern(aliases["broad"]), text))
    company = bool(re.search(terms_pattern(companies), text))
    labor_report = bool(re.search(r"\badp (?:employment|jobs|payrolls|nonfarm|non-farm)\b", text))
    if labor_report:
        company = False
    macro = labor_report or bool(re.search(terms_pattern(aliases["macro"]), text))
    foreign = bool(re.search(terms_pattern(aliases["foreign_assets"]), text))
    mover = bool(re.search(RULES["mover"], text))
    actual_policy = bool(re.search(RULES["actual_policy"], text))
    policy = bool(re.search(r"\b(?:chip export|tech tariffs?|export controls|semiconductor restrictions)\b", text))
    relevant = (direct or company or macro or policy or broad) and mover
    if re.search(r"\bdow(?: jones)?\b", text) and not (direct or company or macro or policy):
        relevant = False
    if foreign and not (direct or company or actual_policy):
        relevant = False
    if re.search(r"\b(?:german|british|japanese|uk|eurozone|ecb|boe|boj)\b", text) and not (direct or company or actual_policy):
        relevant = False
    if re.search(RULES["noise"], text):
        relevant = False
    if company and re.search(r"^(?:why|how|what)\b.*\?", text) and not re.search(r"\b(?:earnings|revenue|profit|guidance|valuation|shares|stock|stocks|rates|yields|chips|semiconductor|demand|orders)\b", text):
        relevant = False
    evidence = []
    if relevant:
        target = terms_pattern(aliases["index"] + companies)
        broad_pattern = terms_pattern(aliases["broad"])
        # Do not borrow a movement verb from another subject in the next clause.
        clauses = re.split(r"\s+(?:but|while|whereas|despite|as|after|amid|although|ahead of)\s+|[,;:!?]", text)
        for rule in RULES["rules"]:
            if rule.get("company") and not company:
                continue
            pattern = rule["pattern"].replace("{target}", target).replace("{broad}", broad_pattern)
            for clause in clauses:
                clause = clause.strip()
                match = re.search(pattern, clause)
                if not match:
                    continue
                prefix = clause[max(0, match.start() - 35):match.start()]
                phrase = match.group()
                suffix = clause[match.end():match.end() + 40]
                if re.search(r"\b(?:not|never|no longer|unlikely to|rules? out)\b", phrase):
                    continue
                if rule.get("observed") and re.match(r"\s+(?:fades?|fails?|stalls?|reverses?)\b", suffix):
                    continue
                if rule["factor"] == "Policy" and re.search(r"\b(?:may|could|might)\b.{0,15}\b(?:dismissed|lifted|rejected|removed)\b", suffix):
                    continue
                if re.search(r"\b(?:not|never|no longer|fails? to|failed to|without|denies?|unlikely to|rules? out)\b(?:\s+\w+){0,3}\s*$", prefix):
                    continue
                tentative = bool(re.search(RULES["speculation"], prefix + phrase))
                if tentative:
                    continue
                evidence.append({"id": rule["id"], "factor": rule["factor"], "weight": rule["weight"], "reason": rule["reason"], "phrase": phrase, "observed": rule.get("observed", False)})
                break
    # A specific reversal/relief phrase takes precedence over a contained generic trigger.
    evidence = [e for e in evidence if not any(e is not other and e["factor"] == other["factor"] and e["weight"] * other["weight"] < 0 and e["phrase"] in other["phrase"] and len(e["phrase"]) < len(other["phrase"]) for other in evidence)]
    # One category cannot amplify itself through repeated synonyms.
    strongest = {}
    for item in evidence:
        key = (item["factor"], item["weight"] > 0)
        if key not in strongest or abs(item["weight"]) > abs(strongest[key]["weight"]):
            strongest[key] = item
    evidence = list(strongest.values())
    observed = [e for e in evidence if e["factor"] == "Price action"]
    usable = observed or evidence
    positive = sum(e["weight"] for e in usable if e["weight"] > 0)
    negative = -sum(e["weight"] for e in usable if e["weight"] < 0)
    conflict = bool(positive and negative)
    # Forward guidance can dominate a trailing earnings beat/miss.
    guidance = [e for e in usable if e["factor"] == "Guidance"]
    if not observed and guidance and len({e["weight"] > 0 for e in guidance}) == 1 and all(e["factor"] in {"Guidance", "Earnings"} for e in usable):
        raw = guidance[0]["weight"]
    elif conflict and (abs(positive - negative) < 2 or max(positive, negative) / min(positive, negative) < 2):
        raw = 0
    else:
        raw = positive - negative
    score = max(-3, min(3, raw))
    preview = bool(re.search(RULES["preview"], text))
    question = bool(re.search(r"^(?:will|can|could|should|is|are|what if)\b.*\?", text))
    if question or (preview and not any(e["observed"] for e in evidence)):
        score = 0
    if not relevant:
        score = 0
        reason = "Outside the Nasdaq-sensitive news filter"
    elif question or (preview and not any(e["observed"] for e in evidence)):
        reason = "Preview or hypothetical scenario; no reported directional outcome yet"
    elif score == 0:
        reason = "Conflicting directional evidence; no clear Nasdaq lean" if conflict else "Relevant context, but no clear directional evidence in the headline"
    else:
        supporting = sorted((e for e in usable if e["weight"] * score > 0), key=lambda e: abs(e["weight"]), reverse=True)
        reason = supporting[0]["reason"]
        if conflict:
            reason += "; opposing evidence lowers conviction"
    strength = 0.30 if score == 0 else min(0.85, 0.48 + abs(score) * 0.08 + (0.09 if observed else 0) + (0.06 if len(evidence) > 1 else 0))
    if conflict:
        strength = min(strength, 0.60)
    return {
        "relevant": relevant, "relevance_weight": 1.0 if direct else 0.8 if company else 0.7 if macro or policy else 0.45,
        "impact": "bullish" if score > 0 else "bearish" if score < 0 else "mixed", "direction_score": score,
        "impact_reason": reason, "confidence": round(strength, 2), "confidence_label": "high" if strength >= 0.70 else "medium" if strength >= 0.46 else "low",
        "factors": list(dict.fromkeys(e["factor"] for e in evidence)), "evidence": evidence,
        "analysis_version": RULES["version"], "method": "headline estimate", "verified_article": False
    }


def select_and_summarize(items, now=None):
    now = now or datetime.now(timezone.utc)
    retained = []
    fingerprints = []
    for item in sorted(items, key=lambda x: x.get("published") or "", reverse=True):
        try:
            published = datetime.fromisoformat(item["published"])
            age = (now - published).total_seconds() / 3600
        except (ValueError, TypeError, KeyError):
            continue
        if age < -0.25 or age > RULES["max_age_hours"]:
            continue
        tokens = set(re.findall(r"[a-z0-9]+", normalize(item["title"]))) - {"the", "a", "an", "on", "as", "and", "of", "to", "in", "for", "update", "updated", "breaking"}
        duplicate = any(tokens == old or (min(len(tokens), len(old)) >= 6 and len(tokens & old) / max(1, len(tokens | old)) >= .82 and item["impact"] == impact) for old, impact in fingerprints)
        if duplicate:
            continue
        fingerprints.append((tokens, item["impact"]))
        item["age_weight"] = round(math.pow(0.5, max(0, age) / RULES["half_life_hours"]), 4)
        retained.append(item)
        if len(retained) >= 18:
            break
    weights = [x["age_weight"] * x["confidence"] * x["relevance_weight"] for x in retained]
    score = sum(x["direction_score"] / 3 * w for x, w in zip(retained, weights)) / max(1.0, sum(weights))
    factors = {}
    for item in retained:
        for factor in item["factors"]:
            factors[factor] = factors.get(factor, 0) + 1
    title = "Headlines lean supportive for NASDAQ" if score >= .2 else "Headlines lean restrictive for NASDAQ" if score <= -.2 else "The NASDAQ narrative is balanced"
    directional = sum(x["direction_score"] != 0 for x in retained)
    summary = f"{directional} of {len(retained)} distinct recent headlines provide directional evidence. The read weights Nasdaq relevance, headline evidence and recency; mixed stories remain neutral."
    pulse = {"score": round(score, 3), "sample_size": len(retained), "directional_count": directional, "title": title, "summary": summary, "factors": sorted(factors, key=factors.get, reverse=True)[:4]}
    return retained, pulse
