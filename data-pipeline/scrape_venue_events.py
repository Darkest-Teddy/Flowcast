"""Collect public events at large venues on or near BU's Charles River campus.

Writes map-client/public/data/event-calendar.json: venues (verified capacities and
positions) plus dated events from

  * goterriers.com (Sidearm) schedules: BU home games at Agganis, Walter Brown,
    Case Gym, Nickerson Field and New Balance Field, with box-score attendance
    for games already played (calibration reference points);
  * agganisarena.com's own calendar (concerts, family shows, PWHL Boston Fleet);
  * Live Nation's MGM Music Hall at Fenway page (embedded event JSON / JSON-LD);
  * the MLB Stats API (Red Sox home games at Fenway Park, with attendance);
  * campus-data.json events already located at Agganis (student productions).

No API keys or accounts. Every page is cached under data-pipeline/.cache/sources
(see common.Fetcher); --offline replays the cache. A failing source is recorded
in `sources` with ok=false and never stops the others.

    python3 data-pipeline/scrape_venue_events.py [--offline] [--out PATH]
"""

import argparse
from datetime import date, datetime, time as dtime, timedelta, timezone
import json
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo

import common
from common import CACHE, Fetcher, ScrapeError, utc_now, write_json

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DEFAULT_OUT = REPO / "map-client" / "public" / "data" / "event-calendar.json"
CAMPUS_DATA = REPO / "map-client" / "public" / "data" / "campus-data.json"
TZ = ZoneInfo("America/New_York")
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

GOTERRIERS = "https://goterriers.com"
AGGANIS_CALENDAR = "https://www.agganisarena.com/events-tickets/calendar/"
# Venue id KovZ917AEJz is MGM Music Hall (KovZ917ACc7 is Coca-Cola Roxy, Atlanta).
LIVENATION_MGM = "https://www.livenation.com/venue/KovZ917AEJz/mgm-music-hall-at-fenway-events"
MLB_SCHEDULE = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId={team}&season={season}&{types}"
MLB_BOXSCORE = "https://statsapi.mlb.com/api/v1/game/{pk}/boxscore"
RED_SOX, FENWAY_VENUE_ID = 111, 3

VENUES = [
    {
        "id": "agganis", "name": "Agganis Arena", "address": "925 Commonwealth Ave, Boston, MA 02215",
        "position": [-71.11774, 42.35222], "locationId": "agganis",
        "capacities": {"hockey": 6150, "basketball": 6411, "end-stage": 7500, "center-stage": 8000,
                       "theatre": 3500},
        "defaultSetup": "end-stage",
        "capacitySource": "Agganis Arena Capacity & Specifications: ice hockey 6,150; basketball 6,411; "
                          "end stage concert up to 7,500; center stage 8,000; theatre configuration 1,500-3,500 "
                          "(theatre = upper bound)",
        "capacityUrl": "https://www.agganisarena.com/business-opportunities/book-the-arena/capacity-specifications/",
        "nearestStations": ["Babcock Street", "Amory Street", "Boston University Central"],
        "positionSource": "OSM way/102384832 (Nominatim)",
    },
    {
        "id": "walter-brown", "name": "Walter Brown Arena", "address": "285 Babcock St, Boston, MA 02215",
        "position": [-71.1203527, 42.3539611], "locationId": None,
        "capacities": {"hockey": 3806}, "defaultSetup": "hockey",
        "capacitySource": "Walter Brown Arena seating capacity 3,806 (verified figure supplied with the brief)",
        "capacityUrl": "https://en.wikipedia.org/wiki/Walter_Brown_Arena",
        "nearestStations": ["Babcock Street", "Amory Street"],
        "positionSource": "OSM node/9644856272 (Walter Brown Arena, leisure=ice_rink; Nominatim)",
    },
    {
        "id": "case-gym", "name": "Case Gym (\"The Roof\")", "address": "285 Babcock St (Case Center), Boston, MA 02215",
        "position": [-71.1203071, 42.3540666], "locationId": None,
        "capacities": {"basketball": 1800}, "defaultSetup": "basketball",
        "capacitySource": "goterriers.com Case Gym facility page: \"CAPACITY: 1,800 seats\"",
        "capacityUrl": "https://goterriers.com/facilities/case-gym-the-roof-/17",
        "nearestStations": ["Babcock Street", "Amory Street"],
        "positionSource": "OSM way/29904697 Case Physical Education Center centroid (same building as Walter Brown)",
    },
    {
        "id": "nickerson", "name": "Nickerson Field", "address": "Harry Agganis Way, Boston, MA 02215",
        "position": [-71.1192528, 42.3534645], "locationId": None, "fieldId": "nickerson-field",
        "capacities": {"field": 9871}, "defaultSetup": "field",
        "capacitySource": "goterriers.com Nickerson Field facility page: \"CAPACITY: 9,871 (3,546 chair back | 6,325 bleacher)\"",
        "capacityUrl": "https://goterriers.com/facilities/nickerson-field/10",
        "nearestStations": ["Babcock Street", "Amory Street"],
        "positionSource": "map-client/public/data/fields.json nickerson-field anchor (OSM way/663514809)",
    },
    {
        "id": "new-balance-field", "name": "New Balance Field", "address": "278 Babcock St, Boston, MA 02215",
        "position": [-71.1218565, 42.3535306], "locationId": None, "fieldId": "new-balance-field",
        "capacities": {"field": 500}, "defaultSetup": "field",
        "capacitySource": "goterriers.com New Balance Field facility page: \"seating for 500\"",
        "capacityUrl": "https://goterriers.com/facilities/new-balance-field/12",
        "nearestStations": ["Babcock Street", "Amory Street"],
        "positionSource": "map-client/public/data/fields.json new-balance-field anchor (OSM way/1026274041)",
    },
    {
        "id": "fenway-park", "name": "Fenway Park", "address": "4 Jersey St, Boston, MA 02215",
        "position": [-71.0970999, 42.3464614], "locationId": None,
        "capacities": {"ballpark": 37755, "ballpark-day": 37305}, "defaultSetup": "ballpark",
        "capacitySource": "Fenway Park capacity 37,755 night / 37,305 day (ballpark = night; day games: ballpark-day)",
        "capacityUrl": "https://en.wikipedia.org/wiki/Fenway_Park",
        "nearestStations": ["Kenmore", "Fenway", "Lansdowne (Commuter Rail)"],
        "positionSource": "OSM relation/11188464 (Nominatim)",
    },
    {
        "id": "mgm-music-hall", "name": "MGM Music Hall at Fenway", "address": "2 Lansdowne St, Boston, MA 02215",
        "position": [-71.0954944, 42.3466937], "locationId": None,
        "capacities": {"end-stage": 5000}, "defaultSetup": "end-stage",
        "capacitySource": "MGM Music Hall at Fenway, approximately 5,000 (general admission floor + balconies)",
        "capacityUrl": "https://en.wikipedia.org/wiki/MGM_Music_Hall_at_Fenway",
        "nearestStations": ["Kenmore", "Fenway", "Lansdowne (Commuter Rail)"],
        "positionSource": "OSM way/148755803 (Nominatim)",
    },
]
VENUE_IDS = {v["id"] for v in VENUES}

# goterriers.com sport slug -> (event kind, display name, setup, trends sport word)
SPORTS = {
    "mens-ice-hockey": ("bu-hockey", "BU Men's Ice Hockey", "hockey", "hockey"),
    "womens-ice-hockey": ("bu-womens-hockey", "BU Women's Ice Hockey", "hockey", "women's hockey"),
    "mens-basketball": ("bu-basketball", "BU Men's Basketball", "basketball", "basketball"),
    "womens-basketball": ("bu-womens-basketball", "BU Women's Basketball", "basketball", "women's basketball"),
    "mens-soccer": ("bu-soccer", "BU Men's Soccer", "field", "soccer"),
    "womens-soccer": ("bu-soccer", "BU Women's Soccer", "field", "women's soccer"),
    "field-hockey": ("bu-field-hockey", "BU Field Hockey", "field", "field hockey"),
    "mens-lacrosse": ("bu-lacrosse", "BU Men's Lacrosse", "field", "lacrosse"),
    "womens-lacrosse": ("bu-lacrosse", "BU Women's Lacrosse", "field", "women's lacrosse"),
}
TRENDS_BU = {"bu-hockey": "BU hockey", "bu-womens-hockey": "BU women's hockey", "bu-basketball": "BU basketball",
             "bu-womens-basketball": "BU women's basketball", "bu-soccer": "BU soccer",
             "bu-field-hockey": "BU field hockey", "bu-lacrosse": "BU lacrosse"}
# Previous seasons fetched only for box-score attendance reference points: slug -> (season, max games)
REFERENCE_SEASONS = {
    "mens-ice-hockey": ("2025-26", 25),
    "womens-ice-hockey": ("2025-26", 8),
    "mens-basketball": ("2025-26", 8),
    "womens-basketball": ("2025-26", 6),
}
# goterriers facility title (lowercase prefix) -> venue id. Anything else (TD Garden, neutral) is not ours.
FACILITIES = [("agganis", "agganis"), ("walter brown", "walter-brown"), ("case gym", "case-gym"),
              ("nickerson", "nickerson"), ("new balance field", "new-balance-field")]
SOURCE_PREFERENCE = {  # lower = preferred when the same event is listed twice
    "sports": ["goterriers", "mlb-statsapi", "agganisarena", "livenation", "campus-data"],
    "shows": ["agganisarena", "livenation", "goterriers", "mlb-statsapi", "campus-data"],
}
SPORT_KINDS = set(TRENDS_BU) | {"bu-sport", "pwhl", "mlb"}


# ---------------------------------------------------------------- helpers

def local_iso(day, clock=None):
    """ISO string in Boston time (correct EDT/EST offset) for a date and optional time."""
    return datetime.combine(day, clock or dtime(0, 0), TZ).isoformat()


def parse_clock(text):
    """'7 PM', '7:15 PM', '07:00 PM', '12:00 AM' -> time; None if absent/TBA."""
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?", text or "")
    if not m:
        return None
    hour, minute = int(m.group(1)) % 12, int(m.group(2) or 0)
    if m.group(3).lower() == "p":
        hour += 12
    return dtime(hour, minute)


def clean(text):
    return re.sub(r"\s+", " ", (text or "").replace(" ", " ")).strip()


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def season_label(day):
    start = day.year if day.month >= 7 else day.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


def fetch(fetcher, url, browser_fallback=True):
    """Fetcher.get, retrying once with a browser User-Agent on 403, and refusing empty WAF challenges."""
    try:
        source = fetcher.get(url)
    except ScrapeError as exc:
        if not (browser_fallback and "HTTP 403" in str(exc)):
            raise
        saved, common.USER_AGENT = common.USER_AGENT, BROWSER_UA
        try:
            source = fetcher.get(url)
        finally:
            common.USER_AGENT = saved
    if not source.body.strip():
        # AWS WAF answers bot challenges with an empty 202; never keep that as a cache entry.
        if source.cache_path and not fetcher.offline:
            for path in (Path(source.cache_path), Path(source.cache_path).with_suffix(".json")):
                path.unlink(missing_ok=True)
        with fetcher._lock:
            fetcher.responses.pop(url, None)
        raise ScrapeError(f"Empty response (bot challenge?) for {url}")
    return source


def base_event(**fields):
    event = {
        "id": None, "venueId": None, "name": None, "kind": "other", "setup": None,
        "start": None, "end": None, "doors": None, "timeTbd": False,
        "performers": [], "opponent": None, "opponentRank": None, "trendsTerms": [],
        "soldOut": None, "attendance": None, "attendanceSource": None, "priceFrom": None,
        "source": None, "sourceUrl": None, "fetchedAt": None,
    }
    event.update(fields)
    return event


# ---------------------------------------------------------------- Sidearm / goterriers

def nuxt_payload(html):
    """Decode a Nuxt 3 `__NUXT_DATA__` (devalue) payload into plain Python data."""
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise ScrapeError("No __NUXT_DATA__ payload")
    table = json.loads(m.group(1))
    memo = {}
    wrappers = {"Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef", "NuxtError"}

    def hydrate(index):
        if not isinstance(index, int) or index < 0:
            return None
        if index in memo:
            return memo[index]
        value = table[index]
        if isinstance(value, list):
            tag = value[0] if value and isinstance(value[0], str) else None
            if tag in wrappers:
                memo[index] = None
                out = hydrate(value[1]) if len(value) > 1 else None
            elif tag == "Date":
                out = value[1]
            elif tag == "Set":
                out = [hydrate(x) for x in value[1:]]
            elif tag in ("Map", "null"):
                out = {str(hydrate(value[k])): hydrate(value[k + 1]) for k in range(1, len(value) - 1, 2)}
            else:
                out = []
                memo[index] = out
                out.extend(hydrate(x) for x in value)
                return out
        elif isinstance(value, dict):
            out = {}
            memo[index] = out
            for key, x in value.items():
                out[key] = hydrate(x)
            return out
        else:
            out = value
        memo[index] = out
        return out

    return hydrate(0)


def opponent_parts(title):
    """'#3/4 Michigan State' -> ('Michigan State', 3, None); '(11) Vermont - Hockey East Opening Round'
    -> ('Vermont', None, 'Hockey East Opening Round'); 'RPI (exh.)' -> ('RPI', None, 'exhibition')."""
    text = re.sub(r"^\(\d+\)\s+", "", clean(title))  # tournament seed, not a poll rank
    rank = None
    m = re.match(r"#(\d+)(?:/\d+)?\s+", text)
    if m:
        rank, text = int(m.group(1)), text[m.end():]
    note = None
    m = re.search(r"\s+[-–—]\s+(.+)$", text)
    if m:
        note, text = m.group(1), text[:m.start()]
    m = re.search(r"\s*\((exh\.?|exhibition|scrimmage)\)\s*$", text, re.I)
    if m:
        note = "scrimmage" if "scrim" in m.group(1).lower() else "exhibition"
        text = text[:m.start()]
    return text.strip(), rank, note


def facility_venue(title):
    lowered = (title or "").lower()
    for prefix, venue in FACILITIES:
        if lowered.startswith(prefix):
            return venue
    return None


def parse_sidearm_schedule(html):
    """Games from a goterriers.com schedule page (Nuxt payload). Returns raw game dicts."""
    data = nuxt_payload(html)
    schedules = (((data or {}).get("pinia") or {}).get("schedule") or {}).get("schedules") or {}
    games = []
    for schedule in schedules.values():
        games.extend(schedule.get("games") or [])
    if not games:
        raise ScrapeError("Schedule payload has no games")
    out = []
    for g in games:
        when = datetime.fromisoformat(g["date"])
        opponent = (g.get("opponent") or {}).get("title") or g.get("event_name") or ""
        result = g.get("result") or {}
        box = ((result.get("boxscore") or {}).get("url")) if isinstance(result, dict) else None
        out.append({
            "gameId": g.get("id"),
            "date": when.date(),
            "time": None if g.get("tbd") else (parse_clock(g.get("time")) or when.time()),
            "tbd": bool(g.get("tbd")) or (g.get("time") or "").upper() in ("TBA", "TBD"),
            "indicator": g.get("location_indicator"),
            "type": g.get("type"),
            "opponentTitle": opponent,
            "facility": (g.get("facility") or {}).get("title"),
            "location": g.get("location"),
            "promotion": clean(g.get("promotion")) or None,
            "noplay": clean(g.get("noplay_text")) or None,
            "result": (result.get("status") if isinstance(result, dict) else None) or None,
            "boxscoreUrl": (GOTERRIERS + box) if box and box.startswith("/") else box,
            "ticketUrl": ((g.get("ticket_link") or {}).get("url")),
        })
    return out


def parse_sidearm_text(html, season):
    """Fallback: the `/schedule/text/<season>` table (Date, Time, At, Opponent, Location, Tournament, Result)."""
    from bs4 import BeautifulSoup
    page = BeautifulSoup(html, "html.parser")
    table = page.find("table")
    if not table:
        raise ScrapeError("No schedule table in text view")
    first_year = int(season[:4])
    out = []
    for row in table.find_all("tr"):
        cells = [clean(td.get_text(" ")) for td in row.find_all("td")]
        if len(cells) < 5:
            continue
        m = re.match(r"([A-Z][a-z]{2})\.? (\d{1,2})", cells[0])
        if not m:
            continue
        month = datetime.strptime(m.group(1), "%b").month
        day = date(first_year if month >= 7 else first_year + 1, month, int(m.group(2)))
        loc = cells[4]
        fac = re.search(r"\(([^)]+)\)\s*$", loc)
        clock = parse_clock(cells[1])
        out.append({
            "gameId": None, "date": day, "time": clock, "tbd": clock is None,
            "indicator": {"home": "H", "away": "A", "neutral": "N"}.get(cells[2].lower()[:7].strip(), cells[2][:1].upper()),
            "type": None, "opponentTitle": cells[3], "facility": fac.group(1) if fac else None,
            "location": loc, "promotion": None, "noplay": None,
            "result": (cells[6][:1] if len(cells) > 6 and cells[6][:1] in "WLT" else None),
            "boxscoreUrl": None, "ticketUrl": None,
        })
    if not out:
        raise ScrapeError("Text schedule had no rows")
    return out


def sidearm_events(games, sport, url, fetched_at):
    kind, label, setup, trends_word = SPORTS[sport]
    events = []
    for g in games:
        if g["indicator"] == "A":
            continue
        venue = facility_venue(g["facility"])
        if not venue:
            continue  # neutral sites (TD Garden Beanpot etc.) or unknown facility
        opponent, rank, note = opponent_parts(g["opponentTitle"])
        if g["type"] == "S" and not note:
            note = "exhibition"
        status = "scheduled"
        if g["noplay"]:
            status = "postponed" if "postpon" in g["noplay"].lower() else (
                "canceled" if "cancel" in g["noplay"].lower() else "scheduled")
        if g["result"] in ("W", "L", "T"):
            status = "final"
        event = base_event(
            id=f"goterriers:{sport}:{g['date'].isoformat()}",
            venueId=venue,
            name=(f"{label} {opponent}" if "alumni" in opponent.lower() else f"{label} vs. {opponent}")
            if opponent else label,
            kind=kind, setup=setup,
            start=local_iso(g["date"], g["time"]), timeTbd=g["tbd"],
            opponent=opponent or None, opponentRank=rank,
            trendsTerms=[TRENDS_BU[kind]] + ([f"{opponent} {trends_word}"] if opponent and "alumni" not in opponent.lower() else []),
            source="goterriers", sourceUrl=url, fetchedAt=fetched_at,
        )
        event.update({"sport": sport, "gameNote": note, "promotion": g["promotion"], "status": status,
                      "result": g["result"], "boxscoreUrl": g["boxscoreUrl"], "goterriersGameId": g["gameId"]})
        events.append(event)
    return events


def parse_sidearm_boxscore(html):
    """-> {'attendance': int|None, 'start': 'HH:MM AM', 'end': ..., 'date': 'MM/DD/YYYY'} from a box score page."""
    info = {}
    try:
        data = nuxt_payload(html)
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                if "attendance" in node and "duration" in node and "start" in node:
                    info = {k: node.get(k) for k in ("attendance", "start", "end", "date", "duration")}
                    break
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    except (ScrapeError, ValueError, json.JSONDecodeError):
        pass
    attendance = info.get("attendance")
    if not attendance:
        m = re.search(r"Attendance:\s*</span>\s*<span[^>]*>\s*([\d,]+)", html)
        attendance = m.group(1) if m else None
    try:
        attendance = int(str(attendance).replace(",", "")) if attendance else None
    except ValueError:
        attendance = None
    info["attendance"] = attendance if attendance and attendance > 0 else None
    return info


def apply_boxscore(event, info, url):
    if info.get("attendance"):
        event["attendance"], event["attendanceSource"] = info["attendance"], url
    day = date.fromisoformat(event["start"][:10])
    start_clock, end_clock = parse_clock(info.get("start")), parse_clock(info.get("end"))
    begin = datetime.combine(day, start_clock, TZ) if start_clock else datetime.fromisoformat(event["start"])
    end = None
    duration = re.fullmatch(r"(\d{1,2}):(\d{2})", str(info.get("duration") or "").strip())
    if duration:
        end = begin + timedelta(hours=int(duration.group(1)), minutes=int(duration.group(2)))
    elif end_clock:
        end = datetime.combine(day, end_clock, TZ)
        if end <= begin:
            end += timedelta(days=1)
    # Stat crews sometimes type AM for PM; keep only plausible game lengths.
    if end and timedelta(minutes=45) <= end - begin <= timedelta(hours=5):
        event["end"] = end.isoformat()


def collect_goterriers(fetcher, window, now, max_boxscores, report):
    events, references = [], []
    budget = [max_boxscores]

    def boxscores(rows, limit=None):
        done = found = 0
        for event in rows:
            url = event.get("boxscoreUrl")
            if not url or event["status"] != "final" or budget[0] <= 0 or (limit is not None and done >= limit):
                continue
            budget[0] -= 1
            done += 1
            try:
                info = parse_sidearm_boxscore(fetch(fetcher, url).text)
            except ScrapeError as exc:
                report["boxscoreErrors"].append(f"{url}: {exc}")
                continue
            apply_boxscore(event, info, url)
            found += bool(event["attendance"])
        return found

    report.setdefault("boxscoreErrors", [])
    report["boxscoresWithAttendance"] = 0
    for sport in SPORTS:
        url = f"{GOTERRIERS}/sports/{sport}/schedule"
        entry = {"id": f"goterriers:{sport}", "url": url, "fetchedAt": None, "ok": False, "count": 0}
        report["sources"].append(entry)
        try:
            source = fetch(fetcher, url)
            entry["fetchedAt"] = source.fetched_at
            try:
                games = parse_sidearm_schedule(source.text)
            except (ScrapeError, ValueError, KeyError, json.JSONDecodeError) as exc:
                season = season_label(now.date())
                text_url = f"{GOTERRIERS}/sports/{sport}/schedule/text/{season}"
                source = fetch(fetcher, text_url)
                games = parse_sidearm_text(source.text, season)
                entry.update(url=text_url, fetchedAt=source.fetched_at, note=f"Nuxt payload unusable ({exc}); used text view")
            rows = [e for e in sidearm_events(games, sport, url, source.fetched_at)
                    if window[0] <= date.fromisoformat(e["start"][:10]) <= window[1]]
            rows = [e for e in rows if e["status"] != "canceled"]
            report["boxscoresWithAttendance"] += boxscores(
                [e for e in rows if datetime.fromisoformat(e["start"]) < now])
            entry.update(ok=True, count=len(rows))
            events.extend(rows)
        except (ScrapeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            entry["error"] = str(exc)
    for sport, (season, limit) in REFERENCE_SEASONS.items():
        url = f"{GOTERRIERS}/sports/{sport}/schedule/{season}"
        entry = {"id": f"goterriers:{sport}:{season}", "url": url, "fetchedAt": None, "ok": False, "count": 0,
                 "purpose": "attendance reference (before the calendar window)"}
        report["sources"].append(entry)
        try:
            source = fetch(fetcher, url)
            entry["fetchedAt"] = source.fetched_at
            rows = [e for e in sidearm_events(parse_sidearm_schedule(source.text), sport, url, source.fetched_at)
                    if date.fromisoformat(e["start"][:10]) < window[0]]
            for e in rows:
                e["id"] = e["id"].replace(f"goterriers:{sport}:", f"goterriers:{sport}:ref:")
            # Prefer the biggest venue (Agganis), then the most recent games.
            rows.sort(key=lambda e: e["start"], reverse=True)
            rows.sort(key=lambda e: e["venueId"] != "agganis")
            found = boxscores(rows, limit)
            report["boxscoresWithAttendance"] += found
            kept = [e for e in rows if e["attendance"]]
            entry.update(ok=True, count=len(kept))
            references.extend(kept)
        except (ScrapeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            entry["error"] = str(exc)
    return events, references


# ---------------------------------------------------------------- Agganis Arena calendar

PROMOTER_RE = re.compile(r"^(?P<promoter>.+?)\s+(?:Presents?|Present)\s*:\s*(?P<act>.+)$", re.I)


def classify_agganis(title, sponsor):
    t, s = title.lower(), (sponsor or "").lower()
    if "bu men's hockey" in t or "bu men’s hockey" in t:
        return "bu-hockey"
    if "bu women's hockey" in t:
        return "bu-womens-hockey"
    if "bu women's basketball" in t:
        return "bu-womens-basketball"
    if "bu men's basketball" in t or "bu basketball" in t:
        return "bu-basketball"
    if "boston fleet" in t or s == "pwhl":
        return "pwhl"
    if any(w in t for w in ("commencement", "graduation", "convocation", "matriculation")):
        return "ceremony"
    if any(w in t for w in ("disney on ice", "sesame", "paw patrol", "monster jam", "harlem globetrotters",
                            "cocomelon", "bluey", "circus")) or "feld" in s:
        return "family"
    if any(w in t for w in ("comedy", "comedian", "stand-up", "letterkenny")):
        return "comedy"
    if any(w in t for w in ("musical", "theatre", "theater", "broadway")):
        return "theatre"
    if PROMOTER_RE.match(title) or any(w in s for w in ("live nation", "aeg", "emporium", "cmn", "crossroads")):
        return "concert"
    return "other"


def parse_agganis_calendar(html, reference):
    """Rows from agganisarena.com/events-tickets/calendar/ (the list shows dates without a year)."""
    from bs4 import BeautifulSoup
    page = BeautifulSoup(html, "html.parser")
    items = page.select("ul#events > li")
    if not items:
        raise ScrapeError("No events list on the Agganis calendar page")
    rows, year, last_month = [], reference.year, None
    for li in items:
        date_node, title_node = li.select_one(".event-date"), li.select_one(".event-title")
        if not date_node or not title_node:
            continue
        m = re.search(r"([A-Z][a-z]+)\s+(\d{1,2})", date_node.get_text(" ", strip=True))
        if not m:
            continue
        month, day_num = datetime.strptime(m.group(1), "%B").month, int(m.group(2))
        if last_month is not None and month < last_month:
            year += 1
        last_month = month
        ticket = li.select_one("a.buy-tickets, .buttons a")
        ticket_url = ticket.get("href") if ticket else None
        tm = re.search(r"-(\d{2})-(\d{2})-(\d{4})/event/", ticket_url or "")
        if tm and (int(tm.group(1)), int(tm.group(2))) == (month, day_num):
            year = int(tm.group(3))
        title = clean(title_node.get_text(" "))
        time_node = li.select_one(".event-time")
        clock = parse_clock(time_node.get_text(" ") if time_node else "")
        tbd = bool(re.search(r"\b(TBA|TBD)\b", title)) or clock is None
        link = li.select_one('a[href*="eid="]')
        eid = re.search(r"eid=(\d+)", link.get("href")) if link else None
        buttons = " ".join(b.get_text(" ", strip=True) for b in li.select(".buttons *")).lower()
        sponsor = li.select_one(".event-sponsor")
        rows.append({
            "date": date(year, month, day_num), "time": None if tbd else clock, "tbd": tbd, "title": title,
            "sponsor": clean(sponsor.get_text(" ")) if sponsor else None,
            "eid": eid.group(1) if eid else None, "ticketUrl": ticket_url,
            "soldOut": True if "sold out" in buttons or "sold out" in title.lower() else None,
        })
    return rows


def agganis_events(rows, fetched_at):
    events = []
    for row in rows:
        title = re.sub(r"\s*\bGAME TIME (TBA|TBD)\b", "", row["title"]).strip()
        kind = classify_agganis(title, row["sponsor"])
        venue = "walter-brown" if re.search(r"\bat Walter Brown\b", title, re.I) else "agganis"
        event = base_event(
            id=f"agganisarena:{row['eid'] or row['date'].isoformat() + ':' + norm(title)[:40].replace(' ', '-')}",
            venueId=venue, name=title, kind=kind,
            start=local_iso(row["date"], row["time"]), timeTbd=row["tbd"], soldOut=row["soldOut"],
            source="agganisarena",
            sourceUrl=f"{AGGANIS_CALENDAR}?eid={row['eid']}" if row["eid"] else AGGANIS_CALENDAR,
            fetchedAt=fetched_at,
        )
        event["ticketUrl"] = row["ticketUrl"]
        event["presenter"] = row["sponsor"]
        if kind in SPORT_KINDS:
            m = re.search(r"\bvs\.?\s+(.+)$", title, re.I)
            opponent = None
            if m:
                opponent = re.sub(r"\s+(EXH\.?|Exhibition)\b.*$", "", m.group(1), flags=re.I).strip()
                opponent = re.sub(r"\s+at Walter Brown.*$", "", opponent, flags=re.I).strip()
            event["opponent"] = opponent or None
            if kind == "pwhl":
                event.update(setup="hockey", trendsTerms=["Boston Fleet"],
                             name=f"Boston Fleet vs. {opponent}" if opponent else title)
            else:
                label = {"bu-hockey": "BU Men's Ice Hockey", "bu-womens-hockey": "BU Women's Ice Hockey",
                         "bu-basketball": "BU Men's Basketball", "bu-womens-basketball": "BU Women's Basketball"}[kind]
                word = {"bu-hockey": "hockey", "bu-womens-hockey": "women's hockey", "bu-basketball": "basketball",
                        "bu-womens-basketball": "women's basketball"}[kind]
                event.update(setup="hockey" if "hockey" in kind else "basketball",
                             name=f"{label} vs. {opponent}" if opponent else title,
                             trendsTerms=[TRENDS_BU[kind]] + ([f"{opponent} {word}"] if opponent else []))
        else:
            m = PROMOTER_RE.match(title)
            act = m.group("act").strip() if m else title
            if kind == "family" and act.lower().startswith("disney on ice"):
                act = "Disney on Ice"
            performers = [p.strip() for p in re.split(r"\s+(?:with|w/)\s+(?:special guests?\s+)?", act, flags=re.I) if p.strip()]
            trends = re.sub(r"^(?:Mix|Kiss|Hot|Magic|Jam'?n|Amp|Radio)\s+\d+(?:\.\d+)?(?:\s*FM)?\s+", "", performers[0], flags=re.I)
            trends = re.sub(r"\s+Live!?$", "", trends, flags=re.I)
            if trends.isupper() and len(trends) > 4:
                trends = trends.title()
            event.update(performers=performers, trendsTerms=[trends], name=act,
                         setup=None if kind == "ceremony" else "end-stage")
            if act != title:
                event["listedTitle"] = title
        events.append(event)
    return events


def collect_agganis(fetcher, window, now, report):
    entry = {"id": "agganisarena:calendar", "url": AGGANIS_CALENDAR, "fetchedAt": None, "ok": False, "count": 0}
    report["sources"].append(entry)
    try:
        source = fetch(fetcher, AGGANIS_CALENDAR)
        entry["fetchedAt"] = source.fetched_at
        reference = datetime.fromisoformat(source.fetched_at).astimezone(TZ).date()
        rows = parse_agganis_calendar(source.text, reference)
        events = [e for e in agganis_events(rows, source.fetched_at)
                  if window[0] <= date.fromisoformat(e["start"][:10]) <= window[1]]
        entry.update(ok=True, count=len(events), note="The list starts at the retrieval date; earlier dates "
                     "(?date=YYYYMMDD) sit behind an AWS WAF bot challenge")
    except (ScrapeError, ValueError) as exc:
        entry["error"] = str(exc)
        return []
    # Past dates: the month view is behind a bot challenge for scripts; try once, record the outcome.
    if now.date() > window[0]:
        past_url = f"{AGGANIS_CALENDAR}?date={window[0].strftime('%Y%m%d')}"
        past = {"id": "agganisarena:calendar-past", "url": past_url, "fetchedAt": None, "ok": False, "count": 0}
        report["sources"].append(past)
        try:
            source = fetch(fetcher, past_url)
            rows = parse_agganis_calendar(source.text, window[0])
            seen = {e["id"] for e in events}
            extra = [e for e in agganis_events(rows, source.fetched_at)
                     if window[0] <= date.fromisoformat(e["start"][:10]) < now.date() and e["id"] not in seen]
            events.extend(extra)
            past.update(ok=True, fetchedAt=source.fetched_at, count=len(extra))
        except (ScrapeError, ValueError) as exc:
            past["error"] = str(exc)
    return events


# ---------------------------------------------------------------- Live Nation (MGM Music Hall)

def next_flight_text(html):
    chunks = []
    for m in re.finditer(r"self\.__next_f\.push\((\[.*?\])\)</script>", html, re.S):
        try:
            item = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if len(item) > 1 and isinstance(item[1], str):
            chunks.append(item[1])
    return "".join(chunks)


def parse_livenation(html):
    """Event objects embedded in the Next.js flight data; JSON-LD MusicEvent as a fallback."""
    flight, decoder, rows, seen = next_flight_text(html), json.JSONDecoder(), [], set()
    for m in re.finditer(r'\{"event_data_type"', flight):
        try:
            obj, _ = decoder.raw_decode(flight[m.start():])
        except json.JSONDecodeError:
            continue
        key = obj.get("discovery_id") or obj.get("id")
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "id": key, "name": clean(obj.get("name")), "start": obj.get("datetime_local"),
            "date": obj.get("start_date_local"), "tbd": not obj.get("start_time_local"),
            "artists": [clean(a.get("name")) for a in obj.get("artists") or [] if a.get("name")],
            "genre": obj.get("genre"), "segment": obj.get("segment"), "status": obj.get("status_code"),
            "url": f"https://www.livenation.com/event/{key}/{obj.get('slug') or ''}".rstrip("/"),
            "ticketUrl": obj.get("url"), "type": obj.get("type"),
        })
    if rows:
        return rows
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        for obj in data if isinstance(data, list) else [data]:
            if not isinstance(obj, dict) or obj.get("@type") not in ("MusicEvent", "Event", "ComedyEvent", "TheaterEvent"):
                continue
            url = obj.get("url") or ""
            key = (re.search(r"/event/([^/]+)/", url) or re.search(r"(.+)", url)).group(1) if url else obj.get("name")
            performers = obj.get("performers") or obj.get("performer") or []
            performers = performers if isinstance(performers, list) else [performers]
            status = (obj.get("eventStatus") or "").rsplit("/", 1)[-1].replace("Event", "").lower() or None
            rows.append({
                "id": key, "name": clean(obj.get("name")), "start": obj.get("startDate"),
                "date": (obj.get("startDate") or "")[:10], "tbd": "T" not in (obj.get("startDate") or ""),
                "artists": [clean(p.get("name")) for p in performers if isinstance(p, dict) and p.get("name")],
                "genre": None, "segment": None, "status": status, "url": url, "ticketUrl": None,
                "type": obj.get("@type"),
            })
    if not rows:
        raise ScrapeError("No Live Nation event data found (layout change?)")
    return rows


def livenation_events(rows, fetched_at):
    events = []
    for row in rows:
        if (row.get("type") or "REGULAR").upper() not in ("REGULAR", "MUSICEVENT", "EVENT", "COMEDYEVENT", "THEATEREVENT"):
            continue  # upsells (lounge access, parking) are not shows
        status = (row.get("status") or "").lower()
        if status in ("cancelled", "canceled"):
            continue
        genre, segment = (row.get("genre") or "").lower(), (row.get("segment") or "").lower()
        kind = ("comedy" if genre == "comedy" else "concert" if segment == "music" or not segment else
                "theatre" if segment.startswith("arts") else "other")
        artists = row["artists"] or [row["name"]]
        trends = [artists[0]]
        if len(artists) > 1 and artists[1].lower() in row["name"].lower() and not re.search(
                r"(special guests?|with|w/|feat\.?|featuring)\s+" + re.escape(artists[1].lower()), row["name"].lower()):
            trends.append(artists[1])
        start = row["start"]
        if start:
            start = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(TZ).isoformat()
        else:
            start = local_iso(date.fromisoformat(row["date"]))
        event = base_event(
            id=f"livenation:{row['id']}", venueId="mgm-music-hall", name=row["name"], kind=kind,
            setup="end-stage", start=start, timeTbd=bool(row["tbd"]), performers=artists, trendsTerms=trends,
            soldOut=True if "sold" in status else None, source="livenation", sourceUrl=row["url"],
            fetchedAt=fetched_at,
        )
        event.update({"ticketStatus": status or None, "genre": row.get("genre"), "ticketUrl": row.get("ticketUrl")})
        events.append(event)
    return events


def collect_livenation(fetcher, window, report):
    entry = {"id": "livenation:mgm-music-hall", "url": LIVENATION_MGM, "fetchedAt": None, "ok": False, "count": 0}
    report["sources"].append(entry)
    try:
        source = fetch(fetcher, LIVENATION_MGM)
        entry["fetchedAt"] = source.fetched_at
        if "MGM Music Hall" not in source.text[:400000]:
            raise ScrapeError("Page does not describe MGM Music Hall (venue id changed?)")
        events = [e for e in livenation_events(parse_livenation(source.text), source.fetched_at)
                  if window[0] <= date.fromisoformat(e["start"][:10]) <= window[1]]
        entry.update(ok=True, count=len(events), note="Upcoming shows only; past shows are not listed")
        return events
    except (ScrapeError, ValueError, KeyError) as exc:
        entry["error"] = str(exc)
        return []


# ---------------------------------------------------------------- MLB Stats API (Fenway Park)

def mlb_home_games(payload, team=RED_SOX, venue=FENWAY_VENUE_ID):
    games = []
    for day in payload.get("dates") or []:
        for g in day.get("games") or []:
            if g["teams"]["home"]["team"]["id"] == team and g["venue"]["id"] == venue:
                games.append(g)
    return games


def parse_mlb_boxscore(payload):
    info = {item.get("label"): (item.get("value") or "").rstrip(".") for item in payload.get("info") or []}
    attendance = re.sub(r"[^\d]", "", info.get("Att", "")) or None
    duration = re.match(r"(\d+):(\d{2})", info.get("T", ""))
    return {"attendance": int(attendance) if attendance else None,
            "firstPitch": parse_clock(info.get("First pitch")),
            "duration": timedelta(hours=int(duration.group(1)), minutes=int(duration.group(2))) if duration else None}


def mlb_events(games, url, fetched_at):
    events = []
    for g in games:
        state = g["status"].get("detailedState", "")
        if state in ("Cancelled", "Postponed") or g["status"].get("codedGameState") in ("C", "D"):
            continue
        tbd = bool(g["status"].get("startTimeTBD"))
        day = date.fromisoformat(g["officialDate"])
        start = local_iso(day) if tbd else datetime.fromisoformat(
            g["gameDate"].replace("Z", "+00:00")).astimezone(TZ).isoformat()
        opponent = g["teams"]["away"]["team"]["name"]
        suffix = f"-g{g['gameNumber']}" if g.get("doubleHeader") in ("Y", "S") else ""
        event = base_event(
            id=f"mlb:{g['gamePk']}", venueId="fenway-park", name=f"Red Sox vs. {opponent}", kind="mlb",
            setup="ballpark", start=start, timeTbd=tbd, opponent=opponent, trendsTerms=["Red Sox"],
            source="mlb-statsapi", sourceUrl=f"https://www.mlb.com/gameday/{g['gamePk']}", fetchedAt=fetched_at,
        )
        event.update({"gamePk": g["gamePk"], "status": "final" if g["status"].get("abstractGameState") == "Final"
                      else state.lower(), "dayNight": g.get("dayNight"), "gameType": g.get("gameType"),
                      "doubleHeader": g.get("doubleHeader") if suffix else None,
                      "scheduleUrl": url})
        events.append(event)
    return events


def collect_mlb(fetcher, window, now, max_attendance, report):
    events = []
    for season in range(window[0].year, window[1].year + 1):
        for label, types in (("regular", "gameType=R"), ("postseason", "gameTypes=F,D,L,W")):
            url = MLB_SCHEDULE.format(team=RED_SOX, season=season, types=types)
            entry = {"id": f"mlb-statsapi:{season}:{label}", "url": url, "fetchedAt": None, "ok": False, "count": 0}
            report["sources"].append(entry)
            try:
                source = fetch(fetcher, url, browser_fallback=False)
                entry["fetchedAt"] = source.fetched_at
                rows = [e for e in mlb_events(mlb_home_games(json.loads(source.text)), url, source.fetched_at)
                        if window[0] <= date.fromisoformat(e["start"][:10]) <= window[1]]
                entry.update(ok=True, count=len(rows))
                events.extend(rows)
            except (ScrapeError, ValueError, KeyError) as exc:
                entry["error"] = str(exc)
    budget = max_attendance
    for event in sorted(events, key=lambda e: e["start"], reverse=True):
        if event["status"] != "final" or datetime.fromisoformat(event["start"]) >= now or budget <= 0:
            continue
        budget -= 1
        url = MLB_BOXSCORE.format(pk=event["gamePk"])
        try:
            info = parse_mlb_boxscore(json.loads(fetch(fetcher, url, browser_fallback=False).text))
        except (ScrapeError, ValueError) as exc:
            report["boxscoreErrors"].append(f"{url}: {exc}")
            continue
        if info["attendance"]:
            event["attendance"], event["attendanceSource"] = info["attendance"], url
        if info["firstPitch"] and info["duration"]:
            first = datetime.combine(date.fromisoformat(event["start"][:10]), info["firstPitch"], TZ)
            event["end"] = (first + info["duration"]).isoformat()
    return events


# ---------------------------------------------------------------- campus-data.json

def collect_campus(path, window, report):
    entry = {"id": "campus-data", "url": str(path.relative_to(REPO)) if path.is_relative_to(REPO) else str(path),
             "fetchedAt": None, "ok": False, "count": 0}
    report["sources"].append(entry)
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        entry["error"] = str(exc)
        return []
    entry["fetchedAt"] = data.get("collectedAt")
    events = []
    for row in data.get("events") or []:
        if row.get("locationId") != "agganis" or not row.get("start"):
            continue
        if not window[0] <= date.fromisoformat(row["start"][:10]) <= window[1]:
            continue
        event = base_event(
            id=f"campus-data:{row['id']}", venueId="agganis", name=row.get("name"), kind="campus", setup=None,
            start=row["start"], end=row.get("end"), source="campus-data",
            sourceUrl=row.get("sourceUrl"), fetchedAt=data.get("collectedAt"),
        )
        event.update({"campusEventId": row["id"], "organizer": row.get("organizer"),
                      "locationName": row.get("locationName")})
        events.append(event)
    entry.update(ok=True, count=len(events))
    return events


# ---------------------------------------------------------------- merge

def dedupe_key(event):
    day = event["start"][:10]
    if event["kind"] in SPORT_KINDS:
        return (event["venueId"], day, event["kind"])
    if event["kind"] == "campus":
        return (event["venueId"], event["start"], event["kind"], event.get("campusEventId"))
    return (event["venueId"], event["start"], "show")


def merge_events(events, notes):
    groups = {}
    for event in events:
        groups.setdefault(dedupe_key(event), []).append(event)
    merged = []
    for group in groups.values():
        if len(group) == 1:
            merged.append(group[0])
            continue
        order = SOURCE_PREFERENCE["sports" if group[0]["kind"] in SPORT_KINDS else "shows"]
        group.sort(key=lambda e: order.index(e["source"]))
        keep, others = dict(group[0]), group[1:]
        keep["alsoListedBy"] = []
        for other in others:
            if other["source"] == keep["source"]:
                merged.append(other)  # same source twice on one day (e.g. two shows): not a duplicate
                continue
            keep["alsoListedBy"].append({"source": other["source"], "id": other["id"],
                                         "sourceUrl": other["sourceUrl"], "start": other["start"]})
            for field in ("soldOut", "priceFrom", "doors", "attendance", "attendanceSource", "end"):
                if keep.get(field) is None and other.get(field) is not None:
                    keep[field] = other[field]
            for field in ("ticketUrl", "presenter"):
                if other.get(field) and not keep.get(field):
                    keep[field] = other[field]
            if not keep["performers"] and other["performers"]:
                keep["performers"] = other["performers"]
            if other["start"] != keep["start"] and not keep["timeTbd"] and not other["timeTbd"]:
                message = (f"{keep['name']} on {keep['start'][:10]}: {keep['source']} lists "
                           f"{keep['start'][11:16]}, {other['source']} lists {other['start'][11:16]} "
                           f"(kept {keep['source']})")
                keep.setdefault("discrepancies", []).append(message)
                notes.append(message)
        if not keep["alsoListedBy"]:
            del keep["alsoListedBy"]
        merged.append(keep)
    return merged


def finalize(event):
    for key in ("boxscoreUrl",):
        if event.get(key) and event.get("attendanceSource") == event[key]:
            event.pop(key)
    optional = ("gameNote", "promotion", "result", "doubleHeader", "discrepancies", "ticketUrl", "presenter",
                "boxscoreUrl")
    return {k: v for k, v in event.items() if not (k in optional and v is None)}


def collect(fetcher, window, now, max_boxscores=80, max_mlb_attendance=15, campus_path=CAMPUS_DATA):
    report = {"sources": [], "boxscoreErrors": []}
    notes = []
    events, references = collect_goterriers(fetcher, window, now, max_boxscores, report)
    events += collect_agganis(fetcher, window, now, report)
    events += collect_livenation(fetcher, window, report)
    events += collect_mlb(fetcher, window, now, max_mlb_attendance, report)
    events += collect_campus(campus_path, window, report)
    events = [finalize(e) for e in merge_events(events, notes)]
    events.sort(key=lambda e: (e["start"], e["venueId"], e["id"]))
    references = sorted((finalize(e) for e in references), key=lambda e: e["start"])
    report["sources"].append({"id": "goterriers:boxscores", "url": GOTERRIERS + "/sports/*/stats/*/boxscore/*",
                              "fetchedAt": None, "ok": not report["boxscoreErrors"],
                              "count": report.get("boxscoresWithAttendance", 0),
                              **({"error": "; ".join(report["boxscoreErrors"][:5])} if report["boxscoreErrors"] else {})})
    failed = [s["id"] for s in report["sources"] if not s["ok"]]
    notes += [
        "Times are America/New_York with the offset in effect on that date (EDT -04:00 until 2026-11-01, EST -05:00 after).",
        "BU home games come from goterriers.com schedules; neutral-site games (e.g. Beanpot at TD Garden) are excluded.",
        "attendance is the published box-score figure for games already played; soldOut is set only when a source says so "
        "(no source currently marks sold-out events).",
        "referenceEvents holds 2025-26 BU home games (before the calendar window) with published attendance, for calibration.",
        "Agganis campus-data events are student productions in the Student Theater at Agganis Arena (a small space, "
        "not the arena bowl), so their setup is null.",
        "Agganis Arena's own calendar lists only dates from the retrieval day on; earlier dates are behind an AWS WAF "
        "bot challenge, so past non-BU Agganis events (2026-09-01 to the retrieval date) may be missing.",
        "Live Nation lists only upcoming MGM Music Hall shows, so past MGM shows in the window are missing.",
        "Agganis capacities from the arena's Capacity & Specifications page; theatre = upper bound of its 1,500-3,500 range.",
    ]
    if failed:
        notes.append("Sources that failed: " + ", ".join(failed))
    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "window": {"from": window[0].isoformat(), "to": window[1].isoformat()},
        "venues": VENUES,
        "events": events,
        "referenceEvents": references,
        "sources": report["sources"],
        "notes": notes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--offline", action="store_true", help="Use cached responses only")
    parser.add_argument("--refresh", action="store_true", help="Fetch again even when cached")
    parser.add_argument("--cache-dir", type=Path, default=CACHE)
    parser.add_argument("--delay", type=float, default=1.5, help="Seconds between requests per host")
    parser.add_argument("--from", dest="start", type=date.fromisoformat, default=date(2026, 9, 1))
    parser.add_argument("--to", dest="end", type=date.fromisoformat, default=date(2027, 4, 30))
    parser.add_argument("--now", type=datetime.fromisoformat, default=None,
                        help="Treat this time as now (past/upcoming split); default: current time")
    parser.add_argument("--max-boxscores", type=int, default=80)
    parser.add_argument("--max-mlb-attendance", type=int, default=15)
    args = parser.parse_args(argv)
    now = args.now or datetime.now(TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    try:
        fetcher = Fetcher(cache_dir=args.cache_dir, offline=args.offline, refresh=args.refresh, delay=args.delay)
    except ScrapeError as exc:
        parser.exit(2, f"{exc}\n")
    result = collect(fetcher, (args.start, args.end), now, args.max_boxscores, args.max_mlb_attendance)
    write_json(args.out, result)
    args.out.chmod(0o644)  # write_json's temp file is 0600; the map serves this file publicly
    by_source = {}
    for event in result["events"]:
        by_source[event["source"]] = by_source.get(event["source"], 0) + 1
    print(f"event-calendar: {len(result['events'])} events {by_source}, "
          f"{len(result['referenceEvents'])} reference games -> {args.out}")
    failed = [s for s in result["sources"] if not s["ok"]]
    for s in failed:
        print(f"  source failed: {s['id']}: {s.get('error')}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
