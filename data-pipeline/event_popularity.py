"""Public popularity of calendar events from Google Trends, cached, no API key.

Reads map-client/public/data/event-calendar.json (scrape_venue_events.py) and writes
map-client/public/data/event-popularity.json: for every event, how much Boston searched for its
performers or teams in the 90 days before it, on one common scale.

Google Trends values are relative: 0-100 within each request, 100 being the request's busiest day.
Two requests can't be compared directly, so every request carries the same anchor term and each
event term is rescaled against it:

    score = 100 * mean(term series) / mean(anchor series)

"TD Garden" is the scale (Boston's main arena: year-round concerts and games, so its search volume
moves little): scores read "TD Garden = 100" in the same window. Trends rounds to whole points, so a
term far smaller than its anchor loses precision and a term far bigger squashes the anchor. Terms
are therefore compared with the smallest rung of an anchor ladder (Agganis Arena, TD Garden,
Red Sox) they don't squash, and each rung's ratio to TD Garden is measured in its own request in
the same window. (Checked on 2026-10-24: Tyla scored 1.92 directly against TD Garden and 1.91 via
Agganis Arena; BU hockey 3.44 and 3.37.)

Requests go to trends.google.com's public JSON endpoints (the same ones its web page calls, as the
unofficial pytrends library does) with a session cookie from the home page, a few seconds between
requests and exponential backoff on HTTP 429. Every response is cached under
data-pipeline/.cache/trends/, so re-runs are free and offline runs (--offline) use only the cache.
An event Trends can't score (unreachable, rate limited, no terms) gets source "prior": the
attendance model (map-client/src/sim/eventAttendance.ts) then uses its kind's documented prior.

The output also carries a calibration: past events with published attendance (box scores) are
fitted per kind group as  fill = base * (score / reference) ** elasticity , the same form the map
evaluates. Without enough reference points the map's priors stand.
"""

import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import http.cookiejar
import json
import math
from pathlib import Path
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "map-client" / "public" / "data"
CALENDAR = DATA / "event-calendar.json"
OUT = DATA / "event-popularity.json"
CACHE = HERE / ".cache" / "trends"

GEO = "US-MA-506"  # Boston (Manchester) DMA
GEO_LABEL = "Boston DMA (Nielsen 506)"
WINDOW_DAYS = 90
ANCHOR = "TD Garden"
# Anchor ladder, smallest first: terms are compared with the smallest anchor they don't squash.
LADDER = ("Agganis Arena", ANCHOR, "Red Sox")
# Below this mean (on the request's 0-100 scale) the anchor has too few levels to rescale against.
MIN_ANCHOR_MEAN = 4.0
TERMS_PER_REQUEST = 4  # Trends compares at most five terms; one slot is the anchor
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
EXPLORE = "https://trends.google.com/trends/api/explore"
MULTILINE = "https://trends.google.com/trends/api/widgetdata/multiline"
HOME = "https://trends.google.com/trends/?geo=US"
PAUSE_SECONDS = (6.0, 11.0)  # between live requests
BACKOFF_SECONDS = (60, 150, 300)  # after each 429 in a row; then give up for this run
# Kind groups the attendance model calibrates separately (eventAttendance.ts KIND_GROUP).
KIND_GROUP = {
    "bu-hockey": "bu-hockey", "bu-womens-hockey": "bu-sport", "bu-basketball": "bu-sport",
    "bu-womens-basketball": "bu-sport", "bu-soccer": "bu-sport", "bu-lacrosse": "bu-sport",
    "bu-field-hockey": "bu-sport", "bu-sport": "bu-sport", "concert": "concert", "comedy": "concert",
    "family": "concert", "theatre": "concert", "pwhl": "pwhl", "mlb": "mlb", "ceremony": "ceremony",
    "campus": "campus", "other": "concert",
}
MIN_CALIBRATION_POINTS = 4
ELASTICITY_BOUNDS = (0.0, 0.6)


class RateLimited(RuntimeError):
    pass


def window_for(event_day, today):
    """(start, end) dates of the 90 days of search interest that predict an event: the 90 days to
    the Saturday before it (so a week's events share one request), or to today for an event still
    to come (Trends has no future)."""
    before = event_day - timedelta(days=1)
    end = min(before - timedelta(days=(before.weekday() + 2) % 7), today)
    return end - timedelta(days=WINDOW_DAYS), end


def mean(values):
    return sum(values) / len(values) if values else 0.0


def normalise(series, anchor):
    """Per term in one request: its mean and peak on the anchor's scale (anchor mean = 100).

    `series` maps term -> list of 0-100 values from the same request as `anchor`'s values. Returns
    {term: {"mean", "peak", "score", "peakScore"}}; scores are None when the anchor has no data."""
    base = mean(series[anchor])
    out = {}
    for term, values in series.items():
        m, peak = mean(values), max(values) if values else 0
        out[term] = {
            "mean": round(m, 3), "peak": peak,
            "score": round(100 * m / base, 3) if base > 0 else None,
            "peakScore": round(100 * peak / base, 3) if base > 0 else None,
        }
    return out


def event_score(term_scores):
    """One event's score from its terms' scores: the biggest, plus half of the rest (a game is
    home team plus opponent; a bill is headliner plus support). None when no term was scored."""
    scored = sorted((s for s in term_scores if s is not None), reverse=True)
    if not scored:
        return None
    return round(scored[0] + 0.5 * sum(scored[1:]), 3)


# Performer names that are also everyday words: searched with a qualifier so the score measures the
# act, not the word. ("FLO" alone scored 11 on 2026-10-24, from the word and the Progressive ad
# character; "FLO girl group" 0.2.)
DISAMBIGUATE = {"FLO": "FLO girl group"}
# A term below Trends' reporting threshold (all zeros) still says "very few searches": it scores
# this floor rather than nothing, so it can sit on the calibration's log scale.
SCORE_FLOOR = 0.05


def event_terms(event):
    return [DISAMBIGUATE.get(t, t) for t in event.get("trendsTerms") or [] if t]


def scored_event(event, terms, records):
    """(score, term it rests on) for one event.

    A game is scored by its opponent's term: the home team's ("BU hockey") is the same for every
    home game and mostly tracks the season (summer windows are low), so it says nothing about which
    game draws. Everything else uses event_score over its terms."""
    by_term = {r["term"]: r for r in records}
    if event.get("opponent") and len(terms) >= 2 and terms[1] in by_term and by_term[terms[1]]["score"] is not None:
        return round(max(SCORE_FLOOR, by_term[terms[1]]["score"]), 3), terms[1]
    score = event_score([r["score"] for r in records]) if records else None
    if score is None:
        return None, None
    top = max((r for r in records if r["score"] is not None), key=lambda r: r["score"])
    return round(max(SCORE_FLOOR, score), 3), top["term"]


def fit_calibration(points, reference):
    """Least squares in log space of  fill = base * (score / reference) ** e  over reference points
    [(score, fill)], fills under 0.98 only (a sell-out is censored at capacity: it says demand was
    at least that). Returns {"base", "elasticity", "residualSd", "n"} or None if too few points."""
    usable = [(s, f) for s, f in points if s and s > 0 and 0 < f < 0.98]
    if len(usable) < MIN_CALIBRATION_POINTS:
        return None
    xs = [math.log(s / reference) for s, _ in usable]
    ys = [math.log(f) for _, f in usable]
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    e = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx > 1e-9 else 0.0
    e = min(ELASTICITY_BOUNDS[1], max(ELASTICITY_BOUNDS[0], e))
    log_base = my - e * mx
    residuals = [y - (log_base + e * x) for x, y in zip(xs, ys)]
    sd = math.sqrt(sum(r * r for r in residuals) / max(1, len(residuals) - 2))
    return {"base": round(math.exp(log_base), 4), "elasticity": round(e, 4), "residualSd": round(sd, 4), "n": len(usable)}


class Trends:
    """trends.google.com's public JSON API with a cookie session, on-disk cache and backoff."""

    def __init__(self, offline=False, log=print):
        self.offline = offline
        self.log = log
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.opener.addheaders = [("User-Agent", USER_AGENT), ("Accept-Language", "en-US,en;q=0.9")]
        self.session = False
        self.last = 0.0
        self.blocked = False
        self.live_requests = 0

    def _get(self, url, pause=PAUSE_SECONDS):
        wait = random.uniform(*pause) - (time.time() - self.last)
        if self.last and wait > 0:
            time.sleep(wait)
        for attempt in range(len(BACKOFF_SECONDS) + 1):
            self.last = time.time()
            try:
                with self.opener.open(url, timeout=30) as resp:
                    self.live_requests += 1
                    return resp.read().decode("utf-8")
            except urllib.error.HTTPError as err:
                if err.code != 429:
                    raise
                if attempt == len(BACKOFF_SECONDS):
                    self.blocked = True
                    raise RateLimited("Google Trends kept answering 429") from err
                pause = BACKOFF_SECONDS[attempt] * random.uniform(0.9, 1.2)
                self.log(f"  Trends rate limit (429); waiting {pause:.0f} s")
                time.sleep(pause)
                self._cookie(force=True)

    def _cookie(self, force=False):
        if self.session and not force:
            return
        self.opener.open(HOME, timeout=30).read()
        self.session = True

    @staticmethod
    def _json(text):
        return json.loads(text[text.index("{"):])  # strip the ")]}'" guard

    def interest(self, terms, start, end):
        """{term: [daily 0-100 values]} for up to five terms in one request, plus the request's
        dates. Cached by (terms, geo, window)."""
        window = f"{start.isoformat()} {end.isoformat()}"
        key = hashlib.sha1(json.dumps([terms, GEO, window]).encode()).hexdigest()[:16]
        path = CACHE / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text()), key, True
        if self.offline or self.blocked:
            raise RateLimited("offline" if self.offline else "rate limited earlier in this run")
        self._cookie()
        req = {"comparisonItem": [{"keyword": t, "geo": GEO, "time": window} for t in terms], "category": 0, "property": ""}
        explore = self._json(self._get(f"{EXPLORE}?{urllib.parse.urlencode({'hl': 'en-US', 'tz': 240, 'req': json.dumps(req)})}"))
        widget = next(w for w in explore["widgets"] if w["id"] == "TIMESERIES")
        params = {"hl": "en-US", "tz": 240, "req": json.dumps(widget["request"]), "token": widget["token"]}
        # The chart data follows its explore call as the web page's does: a short pause only.
        data = self._json(self._get(f"{MULTILINE}?{urllib.parse.urlencode(params)}", pause=(1.0, 2.5)))
        timeline = data["default"]["timelineData"]
        result = {
            "terms": terms, "geo": GEO, "window": window,
            "dates": [datetime.fromtimestamp(int(p["time"]), timezone.utc).date().isoformat() for p in timeline],
            "series": {t: [int(p["value"][i]) for p in timeline] for i, t in enumerate(terms)},
            "queriedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "url": f"https://trends.google.com/trends/explore?date={urllib.parse.quote(window)}&geo={GEO}&q={urllib.parse.quote(','.join(terms))}",
        }
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result))
        return result, key, False


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def score_terms(trends, terms, start, end, log=print):
    """{term: record} for terms over one window, each on the TD Garden = 100 scale.

    Terms are first compared with the smallest rung of the anchor ladder (most precision for the
    small searches most events are); a group whose anchor gets squashed by a big term moves up a
    rung. Each rung's ratio to TD Garden is measured in its own two-term request, same window."""
    out = {}
    ratios = {ANCHOR: 100.0}

    def ratio(rung):
        if rung not in ratios:
            pair, _, _ = trends.interest([ANCHOR, rung], start, end)
            ratios[rung] = normalise(pair["series"], ANCHOR)[rung]["score"]
        return ratios[rung]

    pending = sorted(set(terms) - set(LADDER))
    for rung in LADDER:
        if not pending:
            break
        squashed = []
        for group in chunks(pending, TERMS_PER_REQUEST):
            try:
                scale = ratio(rung)
                result, key, cached = trends.interest([rung, *group], start, end)
            except (RateLimited, urllib.error.URLError, OSError, KeyError, StopIteration, ValueError) as err:
                log(f"  Trends unavailable for {group} ({err}); using priors")
                continue
            if not scale:
                continue
            if mean(result["series"][rung]) < MIN_ANCHOR_MEAN and rung != LADDER[-1]:
                squashed += group  # a big term flattened this anchor: try the next one up
                continue
            norm = normalise(result["series"], rung)
            for term in group:
                rec = norm[term]
                out[term] = {
                    "term": term, "mean": rec["mean"], "peak": rec["peak"],
                    "score": round(rec["score"] * scale / 100, 3) if rec["score"] is not None else None,
                    "peakScore": round(rec["peakScore"] * scale / 100, 3) if rec["peakScore"] is not None else None,
                    "series": result["series"][term], "anchorSeries": result["series"][rung],
                    "dates": [result["dates"][0], result["dates"][-1]], "request": key, "url": result["url"],
                    "queriedAt": result["queriedAt"], "cached": cached, "via": rung, "viaRatio": scale,
                }
        pending = squashed
    # The anchors themselves (a term like "Red Sox"): scored from the ladder requests.
    for rung in set(terms) & set(LADDER):
        try:
            out[rung] = {"term": rung, "score": ratio(rung), "peakScore": None, "series": [], "anchorSeries": [], "via": ANCHOR, "viaRatio": 100.0}
        except (RateLimited, urllib.error.URLError, OSError, KeyError, StopIteration, ValueError):
            pass
    return out


def build(calendar, trends, today, log=print):
    # Calendar events, plus past games with published attendance kept only to calibrate.
    events = calendar.get("events", []) + calendar.get("referenceEvents", [])
    # Events grouped by Trends window (upcoming events share today's window: one batch).
    windows, priority = {}, {}
    for event in events:
        terms = event_terms(event)
        if not terms:
            continue
        day = date.fromisoformat(event["start"][:10])
        win = window_for(day, today)
        windows.setdefault(win, set()).update(terms)
        # Upcoming events first, then calibration points by how much they calibrate, so a rate
        # limit part-way through costs the least useful scores.
        rank = 0 if win[1] == today else 1 if event.get("attendance") and KIND_GROUP.get(event.get("kind")) in ("bu-hockey", "mlb") else 2 if event.get("attendance") else 3
        priority[win] = min(priority.get(win, 9), rank)
    scored = {}
    for (start, end), terms in sorted(windows.items(), key=lambda w: (priority[w[0]], w[0])):
        log(f"Window {start} to {end}: {len(terms)} terms")
        scored[(start, end)] = score_terms(trends, sorted(terms), start, end, log)

    out_events = {}
    for event in events:
        terms = event_terms(event)
        day = date.fromisoformat(event["start"][:10])
        win = window_for(day, today)
        records = [scored.get(win, {}).get(t) for t in terms]
        records = [r for r in records if r]
        score, basis = scored_event(event, terms, records)
        entry = {
            "eventId": event["id"], "kind": event.get("kind"), "group": KIND_GROUP.get(event.get("kind"), "concert"),
            "terms": terms, "window": {"from": win[0].isoformat(), "to": win[1].isoformat()},
        }
        if score is not None:
            entry.update({"source": "trends", "score": score, "scoreTerm": basis, "termScores": records})
        else:
            entry.update({"source": "prior", "score": None,
                          "reason": "no search terms" if not terms else "Google Trends unavailable or rate limited when built"})
        out_events[event["id"]] = entry

    # Per kind group: the median upcoming score is the group's reference (score / reference = 1
    # means a typical event of its kind), and past events with attendance calibrate the curve.
    venues = {v["id"]: v for v in calendar.get("venues", [])}
    calibration = {}
    for group in sorted(set(e["group"] for e in out_events.values())):
        group_scores = sorted(e["score"] for e in out_events.values() if e["group"] == group and e["score"])
        if not group_scores:
            continue
        reference = group_scores[len(group_scores) // 2]
        points = []
        for event in events:
            entry = out_events[event["id"]]
            if entry["group"] != group or not event.get("attendance") or not entry["score"]:
                continue
            venue = venues.get(event["venueId"], {})
            caps = venue.get("capacities") or {}
            capacity = caps.get(event.get("setup") or venue.get("defaultSetup")) or next(iter(caps.values()), None)
            if capacity:
                points.append({"eventId": event["id"], "score": entry["score"], "fill": round(event["attendance"] / capacity, 4),
                               "attendance": event["attendance"], "capacity": capacity, "source": event.get("attendanceSource")})
        fit = fit_calibration([(p["score"], p["fill"]) for p in points], reference)
        calibration[group] = {"referenceScore": reference, "fit": fit, "points": points}

    counts = {"trends": sum(e["source"] == "trends" for e in out_events.values()), "prior": sum(e["source"] == "prior" for e in out_events.values())}
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "builtFor": today.isoformat(),
        "geo": GEO, "geoLabel": GEO_LABEL, "windowDays": WINDOW_DAYS,
        "anchor": {"term": ANCHOR, "ladder": list(LADDER), "minAnchorMean": MIN_ANCHOR_MEAN},
        "method": [
            f"Google Trends daily search interest in {GEO_LABEL} over the {WINDOW_DAYS} days before each event (before the build date for events still to come).",
            f"Every request includes \"{ANCHOR}\"; a term's score is 100 x its mean / {ANCHOR}'s mean in the same request, so scores compare across requests ({ANCHOR} = 100).",
            f"For precision, terms are compared with the smallest anchor of the ladder {', '.join(LADDER)} that they don't squash below a mean of {MIN_ANCHOR_MEAN}; each anchor's ratio to {ANCHOR} is measured in its own request in the same window.",
            "A game is scored by its opponent's term (the home team's is the same for every home game and mostly tracks the season); other events by their biggest term's score plus half of the others' (headliner plus support). Terms below Trends' threshold score 0.05.",
            "Events without a score (no terms, Trends unreachable or rate limited) are marked source \"prior\" and use their kind's prior in the attendance model.",
        ],
        "counts": counts,
        "requests": trends.live_requests,
        "rateLimited": trends.blocked,
        "calibration": calibration,
        "events": out_events,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--calendar", type=Path, default=CALENDAR)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--offline", action="store_true", help="cache only; uncached events fall back to priors")
    parser.add_argument("--today", type=date.fromisoformat, default=date.today())
    args = parser.parse_args()
    if not args.calendar.exists():
        sys.exit(f"{args.calendar} not found; run scrape_venue_events.py first")
    calendar = json.loads(args.calendar.read_text())
    result = build(calendar, Trends(offline=args.offline), args.today)
    args.out.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {args.out}: {result['counts']['trends']} events scored by Trends, {result['counts']['prior']} on priors, {result['requests']} live requests")


if __name__ == "__main__":
    main()
