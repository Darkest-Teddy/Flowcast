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
    { "signals": [{ "id", "position": [lng, lat], "bearing", "group", "axis", "road", "campus", "flash"? }] }
`bearing` is the compass direction the heads face (toward oncoming traffic).

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
        for k, a in enumerate(kept):
            diff = angle_diff(a["travel"], main)
            s = {
                "id": f"{gid}-{k + 1}",
                "position": [round(a["pole"][0], 7), round(a["pole"][1], 7)],
                "bearing": round((a["travel"] + 180) % 360, 1),  # heads face oncoming traffic
                "group": gid,
                "axis": 1 if 45 < diff < 135 else 0,
                "road": a["name"],
                "campus": cid,
            }
            if a["flash"]:
                s["flash"] = True
            signals.append(s)
    return nodes, groups, signals


def main():
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

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "OpenStreetMap contributors (ODbL): highway=traffic_signals; poles placed by data-pipeline/fetch_street.py",
        "signals": signals,
    }, separators=(",", ":")))
    print(f"wrote {OUT} ({len(signals)} signals)")


if __name__ == "__main__":
    main()
