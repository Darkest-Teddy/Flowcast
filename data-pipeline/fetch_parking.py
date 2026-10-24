"""Parking garages and lots for the map client's Parking layer (off by default; Transit tab).

The lots that matter for BU and its event venues: BU's own garages and lots (Agganis, Warren
Towers, Langsam under New Balance Field, Buick Street, the West Campus lots, the Medical Campus
garages) and the big public ones near Fenway Park, MGM Music Hall and Kenmore Square.

Geometry, names and (where mapped) `capacity` come from OpenStreetMap via Overpass (cached in
data-pipeline/.cache/overpass, shared User-Agent and retries from fetch_street.py). Capacity is,
in order of preference:
  * "published": a figure published by BU or the operator (URL in `sourceUrl`),
  * "osm": the lot's OSM `capacity` tag,
  * "estimate": footprint area x levels / 30 m^2 per space per level (labelled as an estimate).
Every lot carries that provenance (`capacityBasis`, `capacityNote`, `sourceUrl`, `osm`).

Events: the venues' published schedules where we have them (EVENTS below, with sources), else
clearly-labelled samples (`sample: true`). Cars per event are estimates (attendance x share who
drive and park off-street / people per car); see VENUES.

Writes map-client/public/data/parking.json:
    { "schemaVersion": 1, "generatedAt", "lots": [...], "venues": [...], "events": [...],
      "notes": [...], "sources": [...] }

Standard library only:
    python3 data-pipeline/fetch_parking.py
"""

from datetime import date, datetime, timedelta, timezone
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from fetch_street import overpass  # noqa: E402  (shared cache, User-Agent, retries)

OUT = HERE.parent / "map-client" / "public" / "data" / "parking.json"
M2_PER_SPACE = 30.0  # per space per level, aisles and ramps included
LEVEL_HEIGHT = 3.0  # metres per garage level when OSM has no height
OSM_URL = "https://www.openstreetmap.org/{}"
BU_PARKING = "https://www.bu.edu/parking/"

# --------------------------------------------------------------------------------------------
# Lots. `osm` gives the geometry (way or relation). `capacity`/`capacitySource`: a published
# figure. `levels`: parking levels when OSM doesn't say (for the estimate). `profile`: the
# baseline fill curve (map-client/src/sim/parking.ts). `underBuilding`: a garage below or inside
# another building (drawn as an outline at street level, not a roof fill).
# --------------------------------------------------------------------------------------------
LOTS = [
    # BU, Charles River Campus
    dict(id="agganis-garage", osm="way/102384832", name="Agganis Arena Garage", short="Agganis Garage", kind="underground",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter", underBuilding=True, levels=2),
    dict(id="warren-garage", osm="relation/20512578", name="Warren Towers Garage", short="Warren Garage", kind="garage",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-mixed", underBuilding=True, levels=4),
    dict(id="langsam-garage", osm="way/1026274040", name="Langsam Garage (under New Balance Field)", short="Langsam Garage", kind="garage",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter", underBuilding=True),
    dict(id="buick-lot", osm="way/468829403", name="Buick Street Lot", short="Buick St Lot", kind="surface",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter"),
    dict(id="bu-lot-f", osm="way/277437319", name="BU Lot F", short="Lot F", kind="surface",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter"),
    dict(id="bu-lot-h", osm="way/277436700", name="BU Lot H (Bridge)", short="Lot H", kind="surface",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter"),
    dict(id="bu-lot-r", osm="way/185784280", name="BU Lot R", short="Lot R", kind="surface",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter"),
    dict(id="comm-730-garage", osm="way/468538536", name="730 Commonwealth Ave Garage", short="730 Comm Ave", kind="garage",
         operator="Boston University", bu=True, campus="charles-river", profile="bu-commuter", levels=3),
    # BU Medical Campus (garages shared with Boston Medical Center)
    dict(id="albany-710-garage", osm="way/29867966", name="710 Albany Street Garage", short="710 Albany Garage", kind="garage",
         operator="Boston University Medical Campus", bu=True, campus="medical", profile="medical", eventParking=False),
    dict(id="albany-610-garage", osm="way/102521151", name="610 Albany Street Garage", short="610 Albany Garage", kind="garage",
         operator="Boston Medical Center", bu=False, campus="medical", profile="medical", eventParking=False),
    dict(id="crosstown-garage", osm="way/675464970", name="Crosstown Center Garage", short="Crosstown Garage", kind="garage",
         operator="Crosstown Center", bu=False, campus="medical", profile="medical", eventParking=False),
    dict(id="harrison-720-garage", osm="way/484823084", name="720 Harrison Avenue Garage", short="720 Harrison Garage", kind="garage",
         operator="Boston Medical Center", bu=False, campus="medical", profile="medical", eventParking=False, levels=4),
    # Fenway Park, MGM Music Hall and Kenmore Square
    dict(id="lansdowne-garage", osm="way/813954295", name="Lansdowne Street Garage (SP+)", short="Lansdowne Garage", kind="garage",
         operator="SP+", bu=False, campus="fenway-kenmore", profile="public", levels=4),
    dict(id="ipswich-garage", osm="way/29605152", name="Ipswich Street Garage", short="Ipswich Garage", kind="garage",
         operator="Ipswich Street Garage", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="kenmore-lot", osm="way/327673956", name="Kenmore Lot (73 Brookline Ave)", short="Kenmore Lot", kind="surface",
         operator="VPNE", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="beacon-819-lot", osm="way/117699201", name="819 Beacon Street Lot", short="819 Beacon Lot", kind="surface",
         operator="Priority Parking", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="hotel-commonwealth-garage", osm="way/93458629", name="Hotel Commonwealth Garage", short="Hotel Comm Garage", kind="garage",
         operator="Hotel Commonwealth", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="somerset-garage", osm="way/29650743", name="Somerset Garage (425 Newbury St)", short="Somerset Garage", kind="garage",
         operator="Pilgrim Parking", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="newbury-415-lot", osm="way/799419417", name="415 Newbury Street Lot", short="415 Newbury Lot", kind="surface",
         operator="Harvard Club of Boston", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="brookline-120r-lot", osm="way/813740514", name="VIP Parking (120R Brookline Ave)", short="120R Brookline Lot", kind="surface",
         operator="VIP Parking", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="ipswich-132-lot", osm="way/813683170", name="132 Ipswich Street Lot", short="132 Ipswich Lot", kind="surface",
         operator="The Boston Conservatory", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="haviland-garage", osm="way/858314163", name="Haviland Street Garage", short="Haviland Garage", kind="underground",
         operator="Patriot Parking", bu=False, campus="fenway-kenmore", profile="public", underBuilding=True, levels=1),
    dict(id="jersey-lot", osm="way/813710196", name="Jersey Street Lot (Van Ness St)", short="Jersey St Lot", kind="surface",
         operator="Fenway Sports Group", bu=False, campus="fenway-kenmore", profile="public"),
    dict(id="landmark-garage", osm="way/1422573181", name="Landmark Center Garage (Park Drive)", short="Landmark Garage", kind="garage",
         operator="Landmark Center", bu=False, campus="fenway-kenmore", profile="public", levels=4),
]

# Published capacities (spaces) with their sources, by lot id (read October 2026). BU's own and
# hospital master-plan figures first; Parkopedia listings only where nothing official exists, and
# never over an OSM `capacity` tag. Red Sox figures are the public game-day spaces at each lot.
REDSOX_PARKING = "https://www.mlb.com/redsox/ballpark/transportation/parking/directions"
BMC_IMP = "https://www.bmc.org/sites/default/files/About_Us/BMC_IMP_2021.pdf"
PUBLISHED = {
    "warren-garage": dict(capacity=322, url="https://www.bu.edu/articles/2025/warren-towers-garage-parking-changes",
                          note="BU (2025): 422 spaces, about 100 of them closed for the Warren Towers renovation until ~2028, so 322 open"),
    "langsam-garage": dict(capacity=350, url="https://goterriers.com/facilities/new-balance-field/12",
                           note="BU Athletics: 'nearly 350' spaces under New Balance Field (OSM capacity tag agrees)"),
    "agganis-garage": dict(capacity=745, url="https://en.parkopedia.com/parking/garage/boston_university_charles_river_campus_agganis_arena_lot_a/02215/boston",
                           note="Parkopedia listing for BU Lot A (garage and lot); BU's 2013 master plan says the Agganis project added 779 spaces. Low confidence"),
    "buick-lot": dict(capacity=85, url="https://en.parkopedia.com/parking/lot/boston_university_charles_river_campus_lot_d_buick_street_lot/02215/boston",
                      note="Parkopedia listing for BU Lot D (Buick Street). Low confidence"),
    "albany-710-garage": dict(capacity=1022, url=BMC_IMP, note="Boston Medical Center Institutional Master Plan 2021, Table 6-3 (2019): 1,036 spaces including 14 outside the garage"),
    "albany-610-garage": dict(capacity=1400, url=BMC_IMP, note="Boston Medical Center Institutional Master Plan 2021, Table 6-3 (2019)"),
    "harrison-720-garage": dict(capacity=238, url=BMC_IMP, note="Boston Medical Center Institutional Master Plan 2021, Table 6-3 (2019; Doctors' Office Building garage)"),
    "crosstown-garage": dict(capacity=1500, url="https://en.parkopedia.com/parking/garage/crosstown_center_garage/02118/boston/",
                             note="Parkopedia listing for the whole garage (BMC's own allocation is 615, BMC IMP 2021). Low confidence"),
    "ipswich-garage": dict(capacity=150, url=REDSOX_PARKING, note="Red Sox game-day parking table, lot #16 (VPNE): public spaces on game days"),
    "hotel-commonwealth-garage": dict(capacity=132, url=REDSOX_PARKING, note="Red Sox game-day parking table, lot #18 (500 Commonwealth Ave)"),
    "somerset-garage": dict(capacity=500, url=REDSOX_PARKING, note="Red Sox game-day parking table, lot #19 (Pilgrim Parking, 425 Newbury St)"),
    "landmark-garage": dict(capacity=400, url=REDSOX_PARKING, note="Red Sox game-day parking table, lot #5 (401 Park Dr / 201 Brookline Ave): game-day spaces, likely less than the whole garage"),
    "jersey-lot": dict(capacity=150, url=REDSOX_PARKING, note="Red Sox game-day parking table, lot #12 (Van Ness / Jersey St)"),
}

# --------------------------------------------------------------------------------------------
# Venues: where event drivers head, how far they'll walk from a lot, and typical cars per event
# (attendance x share who drive and park off-street / people per car): estimates.
# --------------------------------------------------------------------------------------------
VENUES = [
    dict(id="fenway-park", name="Fenway Park", osm="relation/11188464", position=[-71.09714, 42.34633], walkRadius=1400),
    dict(id="mgm-music-hall", name="MGM Music Hall at Fenway", osm="way/148755803", position=[-71.0954, 42.34672], walkRadius=1000),
    dict(id="agganis", name="Agganis Arena", osm="way/102384832", position=[-71.11774, 42.35222], walkRadius=1100),
    dict(id="nickerson", name="Nickerson Field", osm="way/663514809", position=[-71.11924, 42.35330], walkRadius=1300),
    dict(id="bu-campus", name="BU (Charles River Campus)", osm=None, position=[-71.10870, 42.35100], walkRadius=900),
]

# Typical off-street cars for each kind of event (attendance, drive-and-park share, per car).
CARS = {
    "red-sox": (33000, 0.30, 2.5),  # ~4,000 cars; MBTA and walking carry most fans
    "concert-mgm": (5000, 0.30, 2.2),
    "hockey": (5500, 0.30, 2.4),
    "concert-agganis": (6000, 0.35, 2.3),
    "basketball": (1500, 0.30, 2.4),
    "soccer": (800, 0.30, 2.5),
    "commencement": (25000, 0.35, 2.8),
    # Move-in: ~1,200 family cars parked at once at the peak (each stays a couple of hours).
    "move-in": (2400, 0.5, 1.0),
}
# Typical length when the schedule gives only a start, hours.
DURATION = {"red-sox": 3.2, "concert-mgm": 3.0, "concert-agganis": 3.0, "hockey": 2.5, "basketball": 2.0, "soccer": 2.0, "commencement": 3.0, "move-in": 10.0}
VENUE_OF = {"red-sox": "fenway-park", "concert-mgm": "mgm-music-hall", "concert-agganis": "agganis", "hockey": "agganis", "basketball": "agganis", "soccer": "nickerson", "commencement": "nickerson", "move-in": "bu-campus"}


def cars_for(kind):
    attendance, share, per_car = CARS[kind]
    return int(round(attendance * share / per_car / 10.0) * 10)


def to_seconds(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 3600 + int(m) * 60


def event(kind, name, day, start, source, url, end=None, sample=False, venue=None):
    """One parking event: `day` YYYY-MM-DD, `start`/`end` "HH:MM" (Boston)."""
    s = to_seconds(start)
    e = to_seconds(end) if end else (s + int(DURATION[kind] * 3600)) % 86400
    return {
        "id": f"{kind}:{day}:{start.replace(':', '')}",
        "venue": venue or VENUE_OF[kind],
        "name": name,
        "date": day,
        "start": s,
        "end": e,
        "cars": cars_for(kind),
        "sample": sample,
        "source": source,
        "sourceUrl": url,
    }


# Red Sox 2026 home games at Fenway Park (regular season; no home postseason games), from
# Baseball-Reference's 2026 schedule, which gives day (D) or night (N) but not first-pitch times:
# D is taken as 1:35 pm, N as 7:10 pm (Fenway's usual times); the second game of a day-night
# doubleheader as 6:10 pm.
REDSOX_URL = "https://www.baseball-reference.com/teams/BOS/2026-schedule-scores.shtml"
REDSOX_TEAMS = {
    "SDP": "Padres", "MIL": "Brewers", "DET": "Tigers", "NYY": "Yankees", "HOU": "Astros", "TBR": "Rays", "PHI": "Phillies",
    "MIN": "Twins", "ATL": "Braves", "BAL": "Orioles", "TEX": "Rangers", "TOR": "Blue Jays", "WSN": "Nationals", "CHW": "White Sox",
    "ATH": "Athletics", "ARI": "Diamondbacks", "SFG": "Giants", "SEA": "Mariners", "LAA": "Angels", "KCR": "Royals", "CLE": "Guardians",
    "CHC": "Cubs",
}
REDSOX_2026_HOME = """
04-03 SDP D, 04-04 SDP D, 04-05 SDP D, 04-06 MIL N, 04-07 MIL N, 04-08 MIL D, 04-17 DET N, 04-18 DET D, 04-19 DET D,
04-20 DET D, 04-21 NYY N, 04-22 NYY N, 04-23 NYY N, 05-01 HOU N, 05-02 HOU D, 05-03 HOU D, 05-07 TBR N, 05-08 TBR N,
05-10 TBR N, 05-12 PHI N, 05-13 PHI N, 05-14 PHI N, 05-22 MIN N, 05-23 MIN D, 05-24 MIN D, 05-26 ATL N, 05-27 ATL N,
05-28 ATL N, 06-02 BAL N, 06-03 BAL N, 06-04 BAL D, 06-12 TEX N, 06-13 TEX D, 06-14 TEX N, 06-16 TOR N, 06-17 TOR N,
06-18 TOR D, 06-25 NYY N, 06-26 NYY N, 06-27 NYY D, 06-28 NYY N, 06-29 WSN N, 06-30 WSN N, 07-01 WSN D, 07-17 TBR D,
07-17 TBR N, 07-18 TBR D, 07-19 TBR D, 07-20 BAL N, 07-22 BAL D, 07-22 BAL N, 07-24 TOR N, 07-25 TOR D, 07-26 TOR D,
08-04 CHW N, 08-05 CHW N, 08-06 CHW N, 08-07 ATH N, 08-08 ATH D, 08-09 ATH D, 08-17 ARI N, 08-18 ARI N, 08-19 ARI D,
08-21 SFG N, 08-22 SFG N, 08-23 SFG D, 08-31 SEA N, 09-01 SEA N, 09-02 SEA D, 09-07 LAA D, 09-08 LAA N, 09-09 LAA N,
09-11 KCR N, 09-12 KCR D, 09-13 KCR D, 09-22 CLE N, 09-23 CLE N, 09-24 CLE N, 09-25 CHC D, 09-25 CHC N, 09-27 CHC D
"""


def redsox_events():
    games = [g.split() for g in REDSOX_2026_HOME.replace("\n", " ").split(",") if g.strip()]
    out = []
    for i, (md, opp, dn) in enumerate(games):
        doubleheader_night = dn == "N" and i > 0 and games[i - 1][0] == md
        start = "18:10" if doubleheader_night else "13:35" if dn == "D" else "19:10"
        out.append(event("red-sox", f"Red Sox v {REDSOX_TEAMS[opp]}", f"2026-{md}", start,
                         "Baseball-Reference 2026 schedule (home games; first pitch assumed from day/night)", REDSOX_URL))
    return out


# BU men's hockey home games at Agganis Arena, 2026-27 (College Hockey Inc.'s tentative schedule,
# matching BU's June 2026 announcement for October; Beanpot games at TD Garden left out).
HOCKEY_URL = "https://collegehockeyinc.com/teams/boston-university/schedule27.php"
HOCKEY_2026_27 = [
    ("2026-10-24", "19:00", "UConn"), ("2026-10-30", "19:00", "Maine"), ("2026-10-31", "18:00", "Maine"),
    ("2026-11-10", "19:00", "Harvard"), ("2026-11-18", "19:00", "Quinnipiac"), ("2026-11-21", "18:00", "Merrimack"),
    ("2026-11-27", "18:00", "Denver"), ("2026-11-28", "18:00", "Denver"), ("2026-12-11", "19:00", "Northeastern"),
    ("2026-12-12", "18:00", "Northeastern"), ("2027-01-08", "19:00", "UMass"), ("2027-01-16", "18:00", "UMass Lowell"),
    ("2027-01-22", "19:00", "Providence"), ("2027-02-19", "19:00", "New Hampshire"), ("2027-02-27", "19:00", "Boston College"),
    ("2027-03-05", "19:00", "Northeastern"), ("2027-03-06", "18:00", "UMass Lowell"),
]

# MGM Music Hall shows from third-party listings (dates only; doors ~7 pm, show assumed 8-11 pm).
MGM_SHOWS = [
    ("2026-10-17", "Chief Keef", "https://www.stereoboard.com/venues/boston/mgm-music-hall-at-fenway"),
    ("2026-10-30", "Rawayana or Beck (listings differ)", "https://www.stereoboard.com/venues/boston/mgm-music-hall-at-fenway"),
    ("2026-11-07", "Sammy Rae & the Friends", "https://theriverboston.com/events/sammy-rae-mgm-music-hall/"),
    ("2026-11-14", "Klass", "https://songkick.com/concerts/43331525-klass-at-mgm-music-hall-at-fenway"),
    ("2026-11-21", "Orville Peck", "https://www.jambase.com/show/orville-peck-mgm-music-hall-at-fenway-park-20261121"),
    ("2026-11-25", "Tyla", "https://www.stereoboard.com/venues/boston/mgm-music-hall-at-fenway"),
]


def build_events():
    out = redsox_events()
    out += [event("hockey", f"BU hockey v {opp}", day, start, "College Hockey Inc. 2026-27 BU schedule (tentative)", HOCKEY_URL)
            for day, start, opp in HOCKEY_2026_27]
    out += [event("concert-mgm", f"Concert: {name}", day, "20:00", "Third-party concert listing; show time assumed", url, end="23:00")
            for day, name, url in MGM_SHOWS]
    # BU calendar: move-in (BU Today) and Commencement (bu.edu/commencement).
    move_in = "https://www.bu.edu/articles/2026/move-in-2026-everything-you-need-to-know/"
    for day, who in [("2026-08-24", "new students"), ("2026-08-25", "new students"), ("2026-08-28", "returning students"),
                     ("2026-08-29", "returning students"), ("2026-08-30", "returning students"), ("2026-08-31", "returning students")]:
        out.append(event("move-in", f"BU move-in ({who})", day, "08:00", "BU Today, Move-In 2026; hours assumed 8 am-6 pm", move_in, end="18:00"))
    out.append(event("commencement", "BU Commencement", "2027-05-16", "11:00", "BU Commencement page (Sunday May 16, 2027, Nickerson Field); time assumed",
                     "https://www.bu.edu/commencement/", end="14:00"))
    # No published schedule found for BU soccer at Nickerson this fall: one clearly-labelled sample.
    out.append(event("soccer", "BU soccer at Nickerson (sample)", "2026-10-28", "19:00", "Sample: no published 2026 schedule found",
                     "https://goterriers.com/", sample=True))
    return out


EVENTS = build_events()


# --------------------------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------------------------
M_PER_DEG_LAT = 110_540.0


def ring_area(ring):
    """Square metres of a [[lng, lat], ...] ring."""
    lat0 = ring[0][1]
    kx = 111_320.0 * math.cos(math.radians(lat0))
    pts = [(x * kx, y * M_PER_DEG_LAT) for x, y in ring]
    return abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2


def centroid(ring):
    n = len(ring) - 1 if ring[0] == ring[-1] else len(ring)
    return [round(sum(p[0] for p in ring[:n]) / n, 6), round(sum(p[1] for p in ring[:n]) / n, 6)]


def stitch(ways):
    """Join member ways (lists of [lng, lat]) end to end into closed rings."""
    ways = [w[:] for w in ways if len(w) >= 2]
    rings = []
    while ways:
        ring = ways.pop(0)
        while ring[0] != ring[-1]:
            for i, w in enumerate(ways):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                else:
                    continue
                ways.pop(i)
                break
            else:
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def outer_ring(element):
    if element["type"] == "way":
        return [[p["lon"], p["lat"]] for p in element["geometry"]]
    members = element.get("members", [])
    for roles in (("outline",), ("outer",), ("part", "")):
        ways = [[[p["lon"], p["lat"]] for p in m["geometry"]] for m in members if m["type"] == "way" and m.get("role", "") in roles and m.get("geometry")]
        rings = stitch(ways)
        if rings:
            if len(rings) > 1:
                # Several pieces (Warren's towers and podium): their hull stands in for the outline.
                return convex_hull([p for r in rings for p in r])
            return rings[0]
    raise ValueError(f"No outline for relation {element['id']}")


def convex_hull(points):
    pts = sorted(set(map(tuple, points)))
    if len(pts) < 3:
        return [list(p) for p in pts]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return [list(p) for p in hull + [hull[0]]]


def fetch_elements():
    ways = sorted(int(l["osm"].split("/")[1]) for l in LOTS if l["osm"].startswith("way/"))
    rels = sorted(int(l["osm"].split("/")[1]) for l in LOTS if l["osm"].startswith("relation/"))
    query = f"[out:json][timeout:90];(way(id:{','.join(map(str, ways))});relation(id:{','.join(map(str, rels))}););out geom;"
    return {f"{e['type']}/{e['id']}": e for e in overpass(query)}


def number(value):
    try:
        return float(str(value).split(";")[0].replace("m", "").strip())
    except (TypeError, ValueError):
        return None


def build_lot(cfg, element):
    tags = element.get("tags", {})
    ring = [[round(x, 6), round(y, 6)] for x, y in outer_ring(element)]
    area = ring_area(ring)
    osm_levels = number(tags.get("building:levels")) or number(tags.get("parking:levels")) or number(tags.get("levels"))
    levels = cfg.get("levels") or osm_levels or (1 if cfg["kind"] == "surface" else 4)
    published = PUBLISHED.get(cfg["id"])
    if published:
        capacity, basis = published["capacity"], "published"
        note, url = published["note"], published["url"]
    # Only a parking element's capacity counts: Agganis Arena's own tag is its 6,150 seats.
    elif tags.get("amenity") == "parking" and number(tags.get("capacity")):
        capacity, basis = int(number(tags["capacity"])), "osm"
        note, url = f"OpenStreetMap capacity tag on {cfg['osm']}", OSM_URL.format(cfg["osm"])
    else:
        capacity = int(round(area * levels / M2_PER_SPACE / 5.0) * 5)
        basis, url = "estimate", OSM_URL.format(cfg["osm"])
        level_note = f"{levels:g} level{'s' if levels != 1 else ''}" + ("" if osm_levels or cfg["kind"] == "surface" else " (assumed)")
        note = f"Estimated: {area:,.0f} m² footprint × {level_note} ÷ {M2_PER_SPACE:g} m² per space"
    height = 0.0
    if cfg["kind"] == "garage" and not cfg.get("underBuilding"):
        height = number(tags.get("height")) or levels * LEVEL_HEIGHT
    return {
        "id": cfg["id"],
        "name": cfg["name"],
        "short": cfg["short"],
        "kind": cfg["kind"],
        "operator": cfg["operator"],
        "bu": cfg["bu"],
        "campus": cfg["campus"],
        "position": centroid(ring),
        "polygon": ring[:-1] if ring[0] == ring[-1] else ring,
        "height": round(height, 1),
        "underBuilding": bool(cfg.get("underBuilding")),
        "capacity": int(capacity),
        "capacityBasis": basis,
        "capacityNote": note,
        "profile": cfg["profile"],
        "eventParking": cfg.get("eventParking", True),
        "osm": cfg["osm"],
        "sourceUrl": url,
    }


def main():
    elements = fetch_elements()
    lots = []
    for cfg in LOTS:
        element = elements.get(cfg["osm"])
        if not element:
            print(f"  WARNING: {cfg['osm']} ({cfg['name']}) not returned by Overpass; skipped", file=sys.stderr)
            continue
        lots.append(build_lot(cfg, element))
    venues = [{k: v for k, v in venue.items() if k != "osm"} | {"osm": venue["osm"]} for venue in VENUES]
    out = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "lots": lots,
        "venues": venues,
        "events": sorted(EVENTS, key=lambda e: (e["date"], e["start"], e["id"])),
        "notes": NOTES,
        "sources": SOURCES,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n")
    by_basis = {}
    for lot in lots:
        by_basis[lot["capacityBasis"]] = by_basis.get(lot["capacityBasis"], 0) + 1
    print(f"Wrote {OUT.relative_to(HERE.parent)}: {len(lots)} lots ({by_basis}), {sum(l['capacity'] for l in lots):,} spaces, {len(EVENTS)} events")


NOTES = [
    "Cars per event are estimates (attendance × share who drive and park off-street ÷ people per car): "
    + ", ".join(f"{k} ~{cars_for(k):,}" for k in CARS) + ".",
    "Red Sox first pitches are assumed from day/night (1:35 pm / 7:10 pm); MGM show times and the Commencement time are assumed.",
]
SOURCES = [
    {"label": "OpenStreetMap contributors (ODbL), via Overpass: lot geometry, names, capacity tags", "url": "https://www.openstreetmap.org/copyright"},
    {"label": "Boston University: Warren Towers Garage changes (2025)", "url": "https://www.bu.edu/articles/2025/warren-towers-garage-parking-changes"},
    {"label": "Boston University: parking lots and locations", "url": "https://www.bu.edu/transportation/parking/lots-locations/"},
    {"label": "Boston Medical Center Institutional Master Plan 2021 (garage capacities)", "url": BMC_IMP},
    {"label": "Boston Red Sox: game-day parking", "url": REDSOX_PARKING},
    {"label": "Baseball-Reference: 2026 Boston Red Sox schedule", "url": REDSOX_URL},
    {"label": "College Hockey Inc.: Boston University 2026-27 schedule", "url": HOCKEY_URL},
    {"label": "BU Today: Move-In 2026", "url": "https://www.bu.edu/articles/2026/move-in-2026-everything-you-need-to-know/"},
    {"label": "BU Commencement", "url": "https://www.bu.edu/commencement/"},
    {"label": "Parkopedia (Agganis Lot A, Buick Street Lot D, Crosstown Center): low-confidence listings", "url": "https://en.parkopedia.com/"},
]

if __name__ == "__main__":
    main()
