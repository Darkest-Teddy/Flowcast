"""Place traffic signals for the map client from OpenStreetMap.

Fetches every `highway=traffic_signals` node inside each campus bbox (data-pipeline/campuses/*.json,
unioned per campus id) plus the roads through those nodes, then works out where the real signal
poles stand: one pole per approach, on the near-right corner at the right-hand curb, its mast arm
reaching over the approach lanes and its heads facing oncoming traffic.

Boston's OSM data maps signals two ways, and both are handled:
  * at the stop line of each approach, tagged `traffic_signals:direction=forward|backward` (or on
    a one-way road, where the direction is implied): one pole for that approach, just past the
    stop line;
  * on the junction node itself: one pole per approach of the main road and of any real crossing
    road (not driveways), set back ~7 m from the node.
A two-way road with an untagged signal far from any junction is a mid-block crossing: one pole
each way. Approaches whose junction points lie within ~25 m are one intersection (`group`);
`axis` 0 is the main road's direction and 1 the crossing one, so the map can alternate them.

Writes map-client/public/data/street.json:
    { "signals": [{ "id", "position": [lng, lat], "bearing", "group", "axis", "road", "campus", "flash"?,
                    "stopLine": [lng, lat], "approach", "movement"? }],
      "intersections": [{ "group", "name", "source", "sourceUrl", "published": "full" | "cycle" | "none",
                          "plans": [{ "name", "from", "to", "cycle", "offset", "note"?, "splits": [...] }] }],
      "timingSources": [...] }
`bearing` is the compass direction the heads face (toward oncoming traffic); `approach` is the
direction traffic on it travels and `stopLine` where it stops (transit vehicles match signals to
their tracks with these). Each intersection's `plans` give its signal timing by time of day:
published BTD timings along Comm Ave at BU, defaults elsewhere (see "Signal timing" below).

Standard library only, in the style of make_demo_routes.py:
    python3 data-pipeline/fetch_street.py
"""

import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "map-client" / "public" / "data" / "street.json"
CAMPUS_DIR = HERE / "campuses"
CACHE = HERE / ".cache" / "overpass"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

CLUSTER_METRES = 25  # approaches whose junction points are this close are one intersection
STOP_TO_JUNCTION = 12  # a stop-line signal's junction is about this far ahead of it
LANE_WIDTH = 3.3
CURB_CLEARANCE = 0.7  # the pole stands this far outside the outer lane line
SETBACK = {"stop": -3.0, "junction": 7.0, "mid": 3.0}  # metres back from the node (negative: past it)
APPROACH_SAMPLE = 15  # an approach's direction is measured over this much road before the signal
ARM_SIGNAL_METRES = 30  # a junction arm reaching another signal this soon already has its own pole
MERGE_DEGREES = 35  # same-direction approaches this close are one approach (duplicate mapping)
MERGE_METRES = 12
CROSSWALK = 3.0  # a marked crosswalk is ~10 ft wide
STOP_BAR_GAP = 1.2  # the stop bar sits ~4 ft before the crosswalk (MUTCD 3B.16)

# Road classes, most important first. Anything else (footway, cycleway, busway...) is ignored.
ROAD_RANK = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4,
    "unclassified": 5, "residential": 5, "motorway_link": 6, "trunk_link": 6, "primary_link": 6,
    "secondary_link": 6, "tertiary_link": 6, "living_street": 7, "service": 8,
}
# At a junction node, a crossing road this important (or within one class of the main road)
# gets its own poles; driveways and service roads don't.
CROSSING_MAX_RANK = 5
DEFAULT_LANES = {0: 4, 1: 4, 2: 4, 3: 2, 4: 2, 5: 2, 6: 1, 7: 2, 8: 2}


def warn(msg):
    print(f"  WARNING: {msg}", file=sys.stderr)


def overpass(query):
    """Run an Overpass query, cached on disk: the public server is often busy (502/504)."""
    cached = CACHE / f"{hashlib.sha1(query.encode()).hexdigest()[:16]}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": USER_AGENT},  # overpass-api.de returns 406 without one
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                elements = json.load(resp)["elements"]
            break
        except urllib.error.HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 4:
                raise
            print(f"  Overpass busy ({err.code}), retrying...", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(elements))
    return elements


def load_campus_bboxes():
    """{campus id: [south, west, north, east]}, unioned over every file with that id."""
    out = {}
    for path in sorted(CAMPUS_DIR.glob("*.json")):
        data = json.loads(path.read_text())
        if not data.get("bbox"):
            continue
        s, w, n, e = data["bbox"]
        if data["campus"] in out:
            s0, w0, n0, e0 = out[data["campus"]]
            s, w, n, e = min(s, s0), min(w, w0), max(n, n0), max(e, e0)
        out[data["campus"]] = [s, w, n, e]
    return out


def fetch(bbox):
    """Signal nodes in the bbox, then every road way through them (with geometry)."""
    s, w, n, e = bbox
    query = f"""
[out:json][timeout:90];
node["highway"="traffic_signals"]({s},{w},{n},{e})->.s;
.s out body;
way(bn.s)["highway"];
out geom;
"""
    return overpass(query)


# --------------------------------------------------------------------------------------------
# Local metric frame: metres east / north of a reference [lng, lat]
# --------------------------------------------------------------------------------------------

M_PER_DEG_LAT = 110_540.0


def m_per_deg_lng(lat):
    return 111_320.0 * math.cos(math.radians(lat))


def to_xy(lng, lat, ref):
    return ((lng - ref[0]) * m_per_deg_lng(ref[1]), (lat - ref[1]) * M_PER_DEG_LAT)


def to_lnglat(x, y, ref):
    return (ref[0] + x / m_per_deg_lng(ref[1]), ref[1] + y / M_PER_DEG_LAT)


def bearing_of(dx, dy):
    """Compass bearing (degrees clockwise from north) of a vector in metres east / north."""
    return math.degrees(math.atan2(dx, dy)) % 360


def unit(bearing):
    r = math.radians(bearing)
    return (math.sin(r), math.cos(r))


def angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def offset(ref, bearing, forward, right):
    """[lng, lat] that is `forward` metres along `bearing` and `right` metres to its right."""
    fx, fy = unit(bearing)
    return to_lnglat(fx * forward + fy * right, fy * forward - fx * right, ref)


# --------------------------------------------------------------------------------------------
# Roads
# --------------------------------------------------------------------------------------------

def is_oneway(tags):
    v = tags.get("oneway")
    if v in ("yes", "true", "1"):
        return 1
    if v == "-1":
        return -1
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


def int_tag(tags, key):
    try:
        return max(1, int(str(tags.get(key, "")).split(";")[0]))
    except ValueError:
        return None


def curb_offset(tags, rank, step):
    """Metres from the way's centreline to the right-hand curb, for traffic moving in index
    direction `step` (+1 = the way's own direction)."""
    oneway = is_oneway(tags)
    lanes = int_tag(tags, "lanes")
    if oneway:
        lanes = lanes or max(1, DEFAULT_LANES.get(rank, 2) // 2)
        return lanes * LANE_WIDTH / 2 + CURB_CLEARANCE  # a one-way carriageway is centred on the way
    own = int_tag(tags, "lanes:forward" if step > 0 else "lanes:backward")
    if own is None:
        lanes = lanes or DEFAULT_LANES.get(rank, 2)
        own = max(1, lanes / 2)
    return own * LANE_WIDTH + CURB_CLEARANCE


def walk(way, start, step, max_metres, ref):
    """Points (metres, local frame) along a way from index `start` in index direction `step`, up
    to `max_metres`; also the node ids passed."""
    geom, ids = way["geometry"], way["nodes"]
    pts = [to_xy(geom[start]["lon"], geom[start]["lat"], ref)]
    passed = [ids[start]]
    run = 0.0
    i = start + step
    while 0 <= i < len(geom):
        p = to_xy(geom[i]["lon"], geom[i]["lat"], ref)
        seg = math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1])
        passed.append(ids[i])
        if seg > 0 and run + seg >= max_metres:
            f = (max_metres - run) / seg
            pts.append((pts[-1][0] + (p[0] - pts[-1][0]) * f, pts[-1][1] + (p[1] - pts[-1][1]) * f))
            return pts, passed
        pts.append(p)
        run += seg
        i += step
    return pts, passed


def path_length(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def travel_bearing(way, idx, step, ref):
    """Direction of travel at node `idx` for traffic moving in index direction `step`: measured
    over the road just before the node (the approach), else just after it."""
    back, _ = walk(way, idx, -step, APPROACH_SAMPLE, ref)
    if len(back) >= 2 and path_length(back) > 1:
        return bearing_of(back[0][0] - back[-1][0], back[0][1] - back[-1][1])
    ahead, _ = walk(way, idx, step, APPROACH_SAMPLE, ref)
    if len(ahead) >= 2 and path_length(ahead) > 1:
        return bearing_of(ahead[-1][0] - ahead[0][0], ahead[-1][1] - ahead[0][1])
    return None


# --------------------------------------------------------------------------------------------
# Approaches
# --------------------------------------------------------------------------------------------

def approach(node_id, pos, way, idx, step, mode, ref):
    tags = way["tags"]
    rank = ROAD_RANK[tags["highway"]]
    travel = travel_bearing(way, idx, step, ref)
    if travel is None:
        return None
    return {
        "node": node_id,
        "pos": pos,
        "way": way["id"],
        "name": tags.get("name") or tags.get("ref") or tags["highway"].replace("_", " ").title(),
        "rank": rank,
        "lanes": int_tag(tags, "lanes") or DEFAULT_LANES.get(rank, 2),
        "travel": travel,
        "curb": curb_offset(tags, rank, step),
        "mode": mode,
        "oneway": bool(is_oneway(tags)),
        "maxspeed": tags.get("maxspeed"),
    }


def approaches_at(node_id, node, ways, signal_ids):
    """Approaches controlled by one signal node."""
    pos = (node["lon"], node["lat"])
    tags = node.get("tags", {})
    direction = tags.get("traffic_signals:direction")
    roads = [(w, w["nodes"].index(node_id)) for w in ways]
    # Prefer the way the node sits inside (not at an end), then the more important road.
    roads.sort(key=lambda r: (r[1] in (0, len(r[0]["nodes"]) - 1), ROAD_RANK[r[0]["tags"]["highway"]]))
    out = []

    if direction in ("forward", "backward"):
        way, idx = roads[0]
        step = 1 if direction == "forward" else -1
        out.append(approach(node_id, pos, way, idx, step, "stop", pos))
        return out

    if len(roads) >= 2:
        # A junction node: every road arm carrying traffic toward it is an approach, unless it
        # leads to another signal node nearby (that approach has its own stop-line signal).
        arms = []
        for way, idx in roads:
            oneway = is_oneway(way["tags"])
            for side in (-1, 1):  # side -1: the arm before the node in index order
                if not (0 <= idx + side < len(way["nodes"])):
                    continue
                step = -side  # traffic on this arm moves toward the node
                if oneway and step != oneway:
                    continue
                _, passed = walk(way, idx, side, ARM_SIGNAL_METRES, pos)
                if any(n in signal_ids for n in passed[1:]):
                    continue
                a = approach(node_id, pos, way, idx, step, "junction", pos)
                if a:
                    arms.append(a)
        if arms:
            main = min(a["rank"] for a in arms)
            limit = max(CROSSING_MAX_RANK, main + 1)
            out.extend(a for a in arms if a["rank"] <= limit)
        return out

    way, idx = roads[0]
    oneway = is_oneway(way["tags"])
    if oneway:
        out.append(approach(node_id, pos, way, idx, oneway, "stop", pos))
        return out
    # Two-way road, no direction given: if one end of the way (a junction) is close, the signal
    # controls traffic heading there; otherwise it's a mid-block crossing, one pole each way.
    before = path_length(walk(way, idx, -1, 1e9, pos)[0])
    after = path_length(walk(way, idx, 1, 1e9, pos)[0])
    near = min(before, after)
    if near < 30 and max(before, after) > 2 * near:
        out.append(approach(node_id, pos, way, idx, 1 if after < before else -1, "stop", pos))
    else:
        out.extend(approach(node_id, pos, way, idx, s, "mid", pos) for s in (1, -1))
    return out


def junction_point(a):
    """Where an approach's traffic meets the junction it's controlled for."""
    if a["mode"] != "stop":
        return a["pos"]
    return offset(a["pos"], a["travel"], STOP_TO_JUNCTION, 0)


def pole_position(a):
    return offset(a["pos"], a["travel"], -SETBACK[a["mode"]], a["curb"])


def half_width(a):
    """Metres from an approach road's centreline to its curb (a one-way carriageway: half of it)."""
    return max(LANE_WIDTH, a["curb"] - CURB_CLEARANCE)


def stop_line(a, crossing_half):
    """Where traffic on an approach stops, on the road's centreline: at a stop-line node, the node
    itself; at a junction node, short of the crossing road and its crosswalk; mid-block, just
    short of the crosswalk."""
    if a["mode"] == "stop":
        back = 0.0
    elif a["mode"] == "junction":
        back = min(25.0, max(6.0, crossing_half + CROSSWALK + STOP_BAR_GAP))
    else:
        back = CROSSWALK / 2 + STOP_BAR_GAP
    return offset(a["pos"], a["travel"], -back, 0)


def cluster(approaches):
    """Group approaches into intersections (single linkage on their junction points)."""
    n = len(approaches)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    points = [junction_point(a) for a in approaches]
    for i in range(n):
        for j in range(i + 1, n):
            same_node = approaches[i]["node"] == approaches[j]["node"]
            dx, dy = to_xy(points[j][0], points[j][1], points[i])
            if same_node or math.hypot(dx, dy) <= CLUSTER_METRES:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(approaches[i])
    return list(groups.values())


def place(cid, elements):
    nodes = {e["id"]: e for e in elements if e["type"] == "node"}
    ways_by_node = {}
    for e in elements:
        if e["type"] != "way" or "geometry" not in e:
            continue
        tags = e.setdefault("tags", {})
        if tags.get("highway") not in ROAD_RANK or tags.get("area") == "yes":
            continue
        for nid in e["nodes"]:
            if nid in nodes:
                ways_by_node.setdefault(nid, []).append(e)

    approaches = []
    skipped = 0
    for nid, node in nodes.items():
        ways = ways_by_node.get(nid)
        if not ways:
            skipped += 1  # a bike or path signal (cycle track, footway): no traffic-signal pole
            continue
        for a in approaches_at(nid, node, ways, nodes):
            if a:
                a["flash"] = node.get("tags", {}).get("traffic_signals") == "blinker"
                approaches.append(a)

    if skipped:
        print(f"  {skipped} signals on cycle tracks or paths only; skipped")
    signals = []
    groups = cluster(approaches)
    groups.sort(key=lambda g: min(a["node"] for a in g))
    for gi, group in enumerate(groups):
        gid = f"{cid}-{gi + 1}"
        group.sort(key=lambda a: (a["rank"], -a["lanes"], a["node"]))
        main = group[0]["travel"]
        kept = []
        for a in group:
            pole = pole_position(a)
            dupe = any(
                angle_diff(a["travel"], k["travel"]) < MERGE_DEGREES
                and math.hypot(*to_xy(pole[0], pole[1], k["pole"])) < MERGE_METRES
                for k in kept
            )
            if dupe:
                continue
            a["pole"] = pole
            kept.append(a)
        axis_of = lambda a: 1 if 45 < angle_diff(a["travel"], main) < 135 else 0  # noqa: E731
        for k, a in enumerate(kept):
            crossing = [half_width(b) for b in group if axis_of(b) != axis_of(a)]
            line = stop_line(a, max(crossing) if crossing else 2 * LANE_WIDTH)
            s = {
                "id": f"{gid}-{k + 1}",
                "position": [round(a["pole"][0], 7), round(a["pole"][1], 7)],
                "bearing": round((a["travel"] + 180) % 360, 1),  # heads face oncoming traffic
                "group": gid,
                "axis": axis_of(a),
                "road": a["name"],
                "campus": cid,
                "stopLine": [round(line[0], 7), round(line[1], 7)],
                "approach": round(a["travel"], 1),
                # Used for timing below, then dropped from the output.
                "halfWidth": round(half_width(a), 1),
                "oneway": a["oneway"],
                "rank": a["rank"],
                "lanes": a["lanes"],
                "maxspeed": a["maxspeed"],
            }
            if a["flash"]:
                s["flash"] = True
            signals.append(s)
    return nodes, groups, signals


# --------------------------------------------------------------------------------------------
# Signal timing
#
# Boston publishes no live or current per-signal timing (no SPaT / connected-vehicle feed;
# Analyze Boston's "Traffic Signals" dataset lists locations and BTD intersection numbers only;
# MassDOT and DCR publish none). What is published:
#   * BU's Charles River Campus Transportation Master Plan 2013-2023 (Jan 2013), Appendix B:
#     Synchro "Timings" sheets for the Comm Ave signals from Packards Corner to Kenmore, weekday
#     AM and PM peak hours, dated 5/16/2012, modelled with BTD's own timings: cycle, splits
#     (green + yellow + all-red), yellow, all-red, offsets. Encoded below for the 12 we map.
#     They predate the Comm Ave Phase 2A rebuild (BU Bridge to Packards, ~2018-21), so the
#     western ones have likely changed since; no newer timings are published.
#   * BTD, Fenway-Longwood-Kenmore Priority Projects (May 2010): Audubon Circle (Beacon St /
#     Park Dr) proposed 85 s AM plan, 38 + 12 + 29 + 6 s, with a leading pedestrian interval.
#   * Cycle lengths only: Mass Ave & Memorial Dr 110 s (P. Furth, Northeastern, 2022); Mass Ave
#     coordinated at 100 s near Newmarket Sq (Furth, 2019).
#   * BTD Signal Operations Design Policy (May 2023): cycles "as short as possible", min green
#     8 s (through) / 6 s (turns), WALK >= 7 s, clearance at 3.5 ft/s, a 3-4 s buffer before
#     conflicting traffic, LPI 3-6 s (default 3), pedestrian recall 7AM-11PM, progression no
#     faster than the limit (5 mph lower considered), yellow / all-red per MUTCD and MassDOT.
# Everything else gets a default plan built from that policy and the MUTCD / ITE formulas, and
# says so in its `source`.
# --------------------------------------------------------------------------------------------

BU_TMP_SOURCE = "BTD Comm Ave timings (2012, BU Transportation Master Plan)"
BU_TMP_URL = "https://www.bu.edu/community/files/2016/03/2013-2023-BU-Charles-River-Campus-Transportation-Master-Plan_January-17-2013.pdf"
FLK_URL = "https://www.cityofboston.gov/images_documents/audubon%20051110_complete_tcm3-17184.pdf"
FURTH_MEMORIAL_URL = "https://peterfurth.sites.northeastern.edu/2022/02/11/improving-the-mass-ave-memorial-drive-intersection"
FURTH_NEWMARKET_URL = "https://peterfurth.sites.northeastern.edu/2019/07/14/mass-ave-newmarket-square-intersection-design-for-a-road-diet"
BTD_POLICY_URL = "https://content.boston.gov/sites/default/files/file/2023/05/BTD%20Signal%20Policy%205-19-2023.pdf"

H = 3600
# Weekday plan periods. The BU sheets are for the AM and PM peak hours; BTD runs AM, midday,
# PM, off-peak and overnight plans.
PERIODS = [
    ("AM peak", 6 * H, 10 * H),
    ("Midday", 10 * H, 15 * H),
    ("PM peak", 15 * H, 19 * H),
    ("Evening", 19 * H, 22 * H),
    ("Night", 22 * H, 30 * H),  # to 6:00 the next morning
]
# Default cycle lengths (s) by period, for arterials and for minor intersections. Peak values
# follow the published corridor cycles (Comm Ave 100 / 110 s, Mass Ave 100-110 s, Audubon
# Circle 85-110 s); off-peak ones are shorter, per BTD's "as short as possible".
DEFAULT_CYCLES = {
    "major": {"AM peak": 100, "Midday": 90, "PM peak": 110, "Evening": 90, "Night": 70},
    "minor": {"AM peak": 80, "Midday": 70, "PM peak": 80, "Evening": 70, "Night": 60},
}
PARKING_LANE = 2.4  # m (8 ft), each side of a Boston street
WALK = 7.0  # s, BTD minimum WALK
PED_SPEED = 3.5 * 0.3048  # 3.5 ft/s
PED_BUFFER = 3.0  # s of solid DON'T WALK before conflicting traffic (BTD: 3-4 s)
LPI = 3.0  # s, BTD default leading pedestrian interval
MIN_GREEN = 8.0  # s, BTD minimum through green
DEFAULT_SPEED_MPH = 25  # Boston's default limit since 2017
PROGRESSION_MPH = 20  # BTD: no faster than the limit; 5 mph lower should be considered
PERCEPTION = 1.0  # s, ITE yellow formula
DECEL = 10 * 0.3048  # 10 ft/s², ITE
VEHICLE_LENGTH = 6.1  # 20 ft, ITE all-red formula

COMPASS = {"NB": 0, "NE": 45, "EB": 90, "SE": 135, "SB": 180, "SW": 225, "WB": 270, "NW": 315}


def ph(moves, start, split, yellow, all_red, label=None):
    """One movement window from a Synchro sheet: `split` includes yellow and all-red."""
    p = {"moves": moves, "start": start, "green": round(split - yellow - all_red, 1), "yellow": yellow, "allRed": all_red}
    if label:
        p["label"] = label
    return p


def ped(start, length, label="Exclusive pedestrian phase"):
    return {"start": start, "green": 0, "yellow": 0, "allRed": length, "label": label}


# The Comm Ave sheets, by Synchro node. Windows are seconds from the reference phase's start of
# green (the sheet's offset reference); ring-and-barrier lead/lag phases become overlapping
# windows per movement. "ø" phases with no lane group are pedestrian-only intervals.
BU_PLAN_DATA = json.loads((HERE / "inputs" / "bu-signal-plans.json").read_text())
BU_SHEETS = BU_PLAN_DATA["intersections"]

# Audubon Circle: BTD's proposed AM plan (concurrent walks, LPI on the Park Dr south
# crosswalk). The slides give the four intervals but not every movement; the 6 s one is held
# as an all-red / pedestrian interval here.
AUDUBON = {
    "name": "Audubon Circle (Beacon St & Park Dr)", "at": [(-71.10487, 42.34647)],
    "plan": (85, [ph(["EB", "WB"], 0, 38, 4, 2), ph(["NB"], 38, 41, 3, 2), ph(["SB"], 50, 29, 3, 2), ped(79, 6, "Clearance / pedestrians")]),
}

# Published cycle lengths without splits.
CYCLE_ONLY = [
    {"name": "Massachusetts Ave & Memorial Dr", "at": [(-71.09267, 42.35712), (-71.09283, 42.35745)], "cycle": 110,
     "source": "Mass Ave & Memorial Dr cycle (Furth 2022), splits estimated", "url": FURTH_MEMORIAL_URL},
    {"road": "Massachusetts Avenue", "campus": "medical", "cycle": 100,
     "source": "Mass Ave corridor cycle (Furth 2019), splits estimated", "url": FURTH_NEWMARKET_URL},
]


def round_half(x):
    return math.ceil(x * 2 - 1e-9) / 2


def mph_of(tag):
    try:
        v = float(str(tag).split()[0])
    except (TypeError, ValueError):
        return DEFAULT_SPEED_MPH
    return v / 1.609 if "km" in str(tag) else v


def yellow_for(mph):
    """ITE / MUTCD change interval: t + v / 2a, at least 3 s."""
    v = mph * 0.44704
    return max(3.0, round_half(PERCEPTION + v / (2 * DECEL)))


def all_red_for(mph, crossing_width):
    """ITE red clearance: (W + L) / v, 1-3 s."""
    v = mph * 0.44704
    return min(3.0, max(1.0, round_half((crossing_width + VEHICLE_LENGTH) / v)))


def group_centre(sigs):
    return (sum(s["position"][0] for s in sigs) / len(sigs), sum(s["position"][1] for s in sigs) / len(sigs))


def near(sigs, points, metres=30):
    return any(math.hypot(*to_xy(s["position"][0], s["position"][1], p)) <= metres for s in sigs for p in points)


def road_width(sigs, axis):
    """Curb-to-curb width pedestrians cross on this axis's road, from the approaches' travel
    lanes plus a parking lane each side (one carriageway of a divided road: pedestrians cross
    it in two stages at the median)."""
    on = [s for s in sigs if s["axis"] == axis]
    if not on:
        return 2 * LANE_WIDTH
    parking = 0 if any(s["rank"] <= ROAD_RANK["trunk"] for s in on) else 2 * PARKING_LANE
    return max(2 * s["halfWidth"] for s in on) + parking


def intersection_name(sigs):
    names = []
    for s in sorted(sigs, key=lambda s: s["axis"]):
        n = s["road"]
        if n in names or n.endswith(" Link") or n in ("Service", "Unclassified"):
            continue
        names.append(n)
    return " & ".join(names[:3]) or sigs[0]["road"]


def movement_of(sig, labels):
    """The compass movement (of those a sheet uses) nearest this approach's travel bearing."""
    best = min(labels, key=lambda m: angle_diff(COMPASS[m], sig["approach"]))
    return best if angle_diff(COMPASS[best], sig["approach"]) <= 50 else None


def with_axes(splits, sigs):
    """Give each published window the axis of the approaches it moves, as a fallback for
    approaches the sheet doesn't name."""
    out = []
    for p in splits:
        p = dict(p)
        axes = [s["axis"] for s in sigs if s.get("movement") in p.get("moves", [])]
        if axes:
            p["axis"] = max(set(axes), key=axes.count)
        out.append(p)
    return out


def default_splits(sigs, cycle, lpi):
    """A two-phase plan: main road, then crossing road (or a pedestrian crossing), each long
    enough for the walk across the other road, the rest of the cycle shared by lanes."""
    mph = max((mph_of(s.get("maxspeed")) for s in sigs), default=DEFAULT_SPEED_MPH)
    w_main, w_cross = road_width(sigs, 0), road_width(sigs, 1)
    y = yellow_for(mph)
    ar0, ar1 = all_red_for(mph, w_cross), all_red_for(mph, w_main)
    fdw_main = round(w_main / PED_SPEED)  # crossing the main road, during the crossing phase
    fdw_cross = round(w_cross / PED_SPEED)
    lanes = lambda axis: sum(s["lanes"] for s in sigs if s["axis"] == axis) or 1  # noqa: E731
    share = min(0.45, max(0.3, lanes(1) / (lanes(0) + lanes(1))))
    need1 = max(lpi + MIN_GREEN + y + ar1, lpi + WALK + fdw_main + PED_BUFFER)
    need0 = max(lpi + MIN_GREEN + y + ar0, lpi + WALK + fdw_cross + PED_BUFFER)
    split1 = max(need1, round(cycle * share))
    split0 = cycle - split1
    if split0 < need0:  # too short for both: lengthen the cycle rather than cut a walk
        split0 = need0
    split0, split1 = round(split0), round(split1)
    cycle = split0 + split1
    return cycle, [
        {"axis": 0, "start": 0, "lpi": lpi, "green": split0 - lpi - y - ar0, "yellow": y, "allRed": ar0, "walk": WALK, "fdw": fdw_cross},
        {"axis": 1, "start": split0, "lpi": lpi, "green": split1 - lpi - y - ar1, "yellow": y, "allRed": ar1, "walk": WALK, "fdw": fdw_main},
    ]


def stable_hash(text):
    return int(hashlib.sha1(text.encode()).hexdigest()[:8], 16)


def corridor_offsets(groups):
    """Offsets giving a green wave along each named main road: eastbound (inbound) in the
    morning and at night, westbound (outbound) in the afternoon and evening, at the BTD
    progression speed. {gid: {period: offset}}."""
    by_road = {}
    for gid, sigs in groups.items():
        main = next((s for s in sigs if s["axis"] == 0), sigs[0])
        by_road.setdefault((main["campus"], main["road"]), []).append((gid, group_centre(sigs)))
    v = PROGRESSION_MPH * 0.44704
    out = {}
    for (campus, road), members in by_road.items():
        ref = members[0][1]
        xs = {gid: to_xy(c[0], c[1], ref)[0] for gid, c in members}
        x0, x1 = min(xs.values()), max(xs.values())
        base = stable_hash(f"{campus}:{road}") % 997
        for gid, _ in members:
            out[gid] = {}
            for period, _, _ in PERIODS:
                eastward = period in ("AM peak", "Midday", "Night")
                travel = (xs[gid] - x0) / v if eastward else (x1 - xs[gid]) / v
                out[gid][period] = base + travel if len(members) > 1 else stable_hash(gid) % 997
    return out


def timings(signals):
    """Per-intersection plans for street.json, and each approach's `movement` where a
    published sheet names movements."""
    groups = {}
    for s in signals:
        groups.setdefault(s["group"], []).append(s)
    offsets = corridor_offsets(groups)
    out = []
    for gid, sigs in groups.items():
        main = next((s for s in sigs if s["axis"] == 0), sigs[0])
        if all(s.get("flash") for s in sigs):
            out.append({"group": gid, "name": intersection_name(sigs), "source": "flashing beacon (OSM)", "published": "none", "plans": []})
            continue
        sheet = next((b for b in BU_SHEETS if near(sigs, b["at"])), None)
        audubon = near(sigs, AUDUBON["at"])
        if sheet or audubon:
            plan_sets = {"AM": sheet["AM"], "PM": sheet["PM"]} if sheet else {"AM": (AUDUBON["plan"][0], 0, AUDUBON["plan"][1])}
            labels = sorted({m for (_, _, splits) in plan_sets.values() for p in splits for m in p.get("moves", [])})
            for s in sigs:
                m = movement_of(s, labels)
                if m:
                    s["movement"] = m
            plans = []
            for period, start, end in PERIODS:
                key = "PM" if period in ("PM peak",) and "PM" in plan_sets else "AM"
                cycle, offset, splits = plan_sets[key]
                if audubon and not sheet:
                    offset = round(offsets[gid][period] % cycle, 1)
                plan = {"name": period, "from": start, "to": end, "cycle": cycle, "offset": offset, "splits": with_axes(splits, sigs)}
                plan["basis"] = "published" if sheet and period in ("AM peak", "PM peak") else "reused" if sheet else "proposed"
                if sheet:
                    plan["sourceUrl"] = f"{BU_TMP_URL}#page={sheet['sourcePages'][key]}"
                    plan["sourceDate"] = BU_PLAN_DATA["reportDate"]
                if sheet and period not in ("AM peak", "PM peak"):
                    plan["note"] = f"AM plan reused: no {period.lower()} plan published"
                if audubon and not sheet and period != "AM peak":
                    plan["note"] = f"AM plan reused: no {period.lower()} plan published"
                plans.append(plan)
            out.append({
                "group": gid,
                "name": sheet["name"] if sheet else AUDUBON["name"],
                "source": BU_TMP_SOURCE if sheet else "BTD Audubon Circle plan (2010, proposed)",
                "node": sheet["node"] if sheet else None,
                "sourceUrl": BU_TMP_URL if sheet else FLK_URL,
                "published": "full",
                "corridor": "Commonwealth Avenue" if sheet else "Beacon Street",
                "plans": plans,
            })
            continue

        cycle_only = next((c for c in CYCLE_ONLY if ("at" in c and near(sigs, c["at"])) or
                           (c.get("road") == main["road"] and c.get("campus") == main["campus"])), None)
        comm_ave = main["campus"] == "charles-river" and main["road"] == "Commonwealth Avenue" and main["position"][0] < -71.0945
        major = min(s["rank"] for s in sigs) <= ROAD_RANK["primary"] or comm_ave
        plans = []
        for period, start, end in PERIODS:
            cycle = DEFAULT_CYCLES["major" if major else "minor"][period]
            source = "typical Boston arterial (no published plan)" if major else "typical Boston signal (no published plan)"
            url = BTD_POLICY_URL
            if comm_ave and period in ("AM peak", "PM peak"):
                cycle = 100 if period == "AM peak" else 110
                source = "Comm Ave corridor cycle (BTD 2012 sheets), splits estimated"
                url = BU_TMP_URL
            elif cycle_only and period in ("AM peak", "Midday", "PM peak"):
                cycle, source, url = cycle_only["cycle"], cycle_only["source"], cycle_only["url"]
            day = period != "Night"  # pedestrian recall 7AM-11PM covers every plan but overnight
            cycle, splits = default_splits(sigs, cycle, LPI if day else 0.0)
            plans.append({"name": period, "from": start, "to": end, "cycle": cycle, "offset": round(offsets[gid][period] % cycle, 1),
                          "splits": splits, "source": source, "sourceUrl": url,
                          "basis": "estimated"})
        # The intersection's source is what its busiest plans rest on.
        peak = plans[0]
        out.append({
            "group": gid,
            "name": intersection_name(sigs),
            "source": peak["source"],
            "sourceUrl": peak["sourceUrl"],
            "published": "cycle" if (comm_ave or cycle_only) else "none",
            "plans": plans,
        })
        for p in plans[1:]:
            src = p["source"]
            if src != out[-1]["source"]:
                p["note"] = "default: none published for this period"
    return out


INTERNAL_KEYS = ("halfWidth", "oneway", "rank", "lanes", "maxspeed")
TIMING_SOURCES = [
    {"what": "Comm Ave signals, Babcock St to Kenmore Sq, and Mountfort / St Mary's: AM and PM peak cycle, splits, yellow, all-red, offsets (5/16/2012)",
     "title": "Boston University Charles River Campus Transportation Master Plan 2013-2023, Appendix B Synchro sheets", "url": BU_TMP_URL},
    {"what": "Audubon Circle proposed AM plan: 85 s, 38/12/29/6 s, LPI",
     "title": "BTD, Fenway-Longwood-Kenmore Priority Projects (May 2010)", "url": FLK_URL},
    {"what": "Mass Ave & Memorial Dr: 110 s cycle", "title": "P. Furth, Improving the Mass Ave / Memorial Drive intersection (2022)", "url": FURTH_MEMORIAL_URL},
    {"what": "Mass Ave coordinated at 100 s near Newmarket Sq", "title": "P. Furth, Mass Ave / Newmarket Square (2019)", "url": FURTH_NEWMARKET_URL},
    {"what": "Defaults: min green, WALK 7 s, 3.5 ft/s clearance, 3 s buffer, LPI 3 s, ped recall 7AM-11PM, progression speed",
     "title": "BTD Signal Operations Design Policy (May 2023)", "url": BTD_POLICY_URL},
    {"what": "Yellow t + v/2a (t = 1 s, a = 10 ft/s²), all-red (W + L)/v", "title": "ITE change and clearance intervals / MUTCD 4D.26", "url": None},
]


def refresh_published_timings(data):
    """Refresh published inputs without refetching OSM or changing estimated geometry/plans."""
    groups = {}
    for signal in data["signals"]:
        groups.setdefault(signal["group"], []).append(signal)
    covered = {gid for gid, sigs in groups.items() if any(near(sigs, sheet["at"]) for sheet in BU_SHEETS)}
    replacements = {item["group"]: item for item in timings([s for s in data["signals"] if s["group"] in covered])}
    data["intersections"] = [replacements.get(item["group"], item) for item in data["intersections"]]
    for item in data["intersections"]:
        for plan in item["plans"]:
            plan.setdefault("basis", "proposed" if item.get("sourceUrl") == FLK_URL else "estimated")
            if plan["basis"] == "estimated" and plan.get("note") == "default: none published for this period":
                plan.setdefault("source", "estimated off-peak plan")
                plan.setdefault("sourceUrl", BTD_POLICY_URL)
    return data


def main():
    if sys.argv[1:] == ["--timings-only"]:
        data = refresh_published_timings(json.loads(OUT.read_text()))
        OUT.write_text(json.dumps(data, separators=(",", ":")))
        print(f"Updated published timing plans in {OUT}")
        return
    campuses = load_campus_bboxes()
    signals = []
    seen = set()
    for cid, bbox in campuses.items():
        print(f"{cid}: fetching signals in {bbox}")
        # A signal inside two campus boxes belongs to the first.
        elements = [e for e in fetch(bbox) if not (e["type"] == "node" and e["id"] in seen)]
        nodes, groups, placed = place(cid, elements)
        seen.update(nodes)
        signals.extend(placed)
        print(f"  {len(nodes)} signal nodes -> {len(groups)} intersections -> {len(placed)} signal poles")

    intersections = timings(signals)
    for s in signals:
        for key in INTERNAL_KEYS:
            s.pop(key, None)
    counts = {}
    for i in intersections:
        counts[i["published"]] = counts.get(i["published"], 0) + 1
    print(f"  timing: {counts.get('full', 0)} published plans, {counts.get('cycle', 0)} published cycle only, "
          f"{counts.get('none', 0)} defaults or flashing")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "OpenStreetMap contributors (ODbL): highway=traffic_signals; poles placed by data-pipeline/fetch_street.py",
        "timingSources": TIMING_SOURCES,
        "signals": signals,
        "intersections": intersections,
    }, separators=(",", ":")))
    print(f"wrote {OUT} ({len(signals)} signals, {len(intersections)} intersections)")


if __name__ == "__main__":
    main()
