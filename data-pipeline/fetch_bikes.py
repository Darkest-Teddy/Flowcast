"""Real Bluebikes rides at BU's docks for the map client.

Writes map-client/public/data/bikes.json:
  - stations: every Bluebikes dock within STATION_RADIUS_M of a BU location in
    data-pipeline/campuses/*.json, with its live-feed (GBFS) id and a typical-weekday profile:
    bikes docked and undocked per 15 minutes, averaged over every such weekday in the month.
  - trips: every ride on one real day of that month that starts or ends at those docks, in the
    same {path, timestamps} shape as demo-day.json, so deck.gl's TripsLayer plays them directly.

What is measured and what is inferred: docks, ride counts, which two docks a ride joined, bike
type, rider type and the time a ride leaves or reaches a BU dock all come from Bluebikes' published
trip data. The street path is not published (a ride records only its two ends), so each ride is
routed along the most bike-friendly path in OpenStreetMap: protected and painted lanes and
off-street paths are preferred, one-way streets are respected. Rides to docks beyond the routed
area are drawn as far as its edge, heading toward the real far dock.

Standard library only:
    python3 data-pipeline/fetch_bikes.py                       # September 2026, Wednesdays
    python3 data-pipeline/fetch_bikes.py --replay-date 2026-09-23
The trip file (~130 MB a month) is downloaded once into data-pipeline/.cache/bluebikes/.
Source and licence: https://bluebikes.com/system-data
"""

import argparse
import csv
import hashlib
import heapq
import io
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "map-client" / "public" / "data" / "bikes.json"
CAMPUS_DIR = HERE / "campuses"
CACHE = HERE / ".cache"
TRIP_BUCKET = "https://s3.amazonaws.com/hubway-data"
GBFS_STATIONS = "https://gbfs.lyft.com/gbfs/1.1/bos/en/station_information.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

STATION_RADIUS_M = 200  # a dock this close to a BU building is one its students use
NETWORK_PAD_M = 900  # how far past a campus's docks rides are routed before leaving the map
FULL_SNAP_M = 150  # a far dock within this of the routed network counts as reached
MIN_DRAWN_M = 30  # same-dock round trips have no route to draw
BIN_SECONDS = 15 * 60
BINS = 24 * 3600 // BIN_SECONDS
SIMPLIFY_M = 2.0
# Typical riding speeds (m/s) for rides whose far end is off the map, so no real duration applies.
CRUISE = {"classic": 4.2, "electric": 5.3}  # ~15 and ~19 km/h
# A ride slower than this between its docks stopped along the way; faster isn't plausible.
MIN_SPEED, MAX_SPEED = 2.0, 8.0

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# Bike-routable ways. Footways count only where bikes are explicitly allowed (see allows_bikes).
BIKE_HIGHWAYS = (
    "cycleway|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|"
    "residential|living_street|service|path|track|pedestrian|footway"
)
SHORT_NAMES = {
    "B.U. Central T Stop - 725 Commonwealth Ave": "BU Central T",
    "Boston Medical Center - E Concord St at Harrison Ave": "Boston Medical Center",
    "Packard's Corner - Commonwealth Ave at Brighton Ave": "Packard's Corner",
    "Landmark Center - Brookline Ave at Park Dr": "Landmark Center",
    "Kenmore Square - 660 Beacon St": "Kenmore Sq · 660 Beacon",
}


def warn(msg):
    print(f"  WARNING: {msg}", file=sys.stderr)


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def short_name(name):
    return SHORT_NAMES.get(name) or name.replace("Commonwealth Ave", "Comm Ave").replace("Massachusetts Ave", "Mass Ave")


def http_get(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 4:
                raise
            print(f"  {urllib.parse.urlsplit(url).netloc} busy ({err.code}), retrying...", file=sys.stderr)
            time.sleep(5 * (attempt + 1))


# --- Trip data ---------------------------------------------------------------------------------


def trip_file(month):
    """Path to the month's trip CSV, downloading it once. Bluebikes names files inconsistently
    (.csv, .zip, .csv.zip), so the bucket listing decides."""
    folder = CACHE / "bluebikes"
    for cached in sorted(folder.glob(f"{month}-bluebikes-tripdata*")):
        return cached
    listing = http_get(f"{TRIP_BUCKET}?list-type=2&prefix={month}-bluebikes-tripdata").decode()
    keys = re.findall(r"<Key>([^<]+)</Key>", listing)
    if not keys:
        sys.exit(f"No Bluebikes trip file for {month} at {TRIP_BUCKET} (published around the 10th of the next month)")
    print(f"Downloading {keys[0]}...", file=sys.stderr)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / keys[0]
    path.write_bytes(http_get(f"{TRIP_BUCKET}/{keys[0]}", timeout=600))
    return path


def read_trips(path):
    """Rows of the month's trip CSV, whether it came zipped or not."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith(".csv") and not n.startswith("__MACOSX"))
            with z.open(name) as raw:
                yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))
    else:
        with path.open(encoding="utf-8", newline="") as f:
            yield from csv.DictReader(f)


def parse_ride(row):
    """A trip-data row as a ride, or None if a time is unreadable. Times are Boston local time."""
    try:
        start = datetime.fromisoformat(row["started_at"])
        end = datetime.fromisoformat(row["ended_at"])
    except (KeyError, ValueError):
        return None

    def point(prefix):
        try:
            return float(row[f"{prefix}_lat"]), float(row[f"{prefix}_lng"])
        except (KeyError, ValueError):
            return None

    return {
        "start": start,
        "end": end,
        "from": row.get("start_station_id") or None,
        "to": row.get("end_station_id") or None,
        "fromName": row.get("start_station_name") or None,
        "toName": row.get("end_station_name") or None,
        "fromPoint": point("start"),
        "toPoint": point("end"),
        "type": "electric" if row.get("rideable_type") == "electric_bike" else "classic",
        "member": row.get("member_casual") == "member",
    }


def load_locations():
    locations = []
    for path in sorted(CAMPUS_DIR.glob("*.json")):
        data = json.loads(path.read_text())
        for loc in data.get("locations", []):
            if "lat" in loc and "lon" in loc:
                locations.append({"id": loc["id"], "campus": data["campus"], "lat": loc["lat"], "lon": loc["lon"]})
    if not locations:
        sys.exit(f"No BU locations found in {CAMPUS_DIR}")
    return locations


def campus_stations(positions, locations, radius=STATION_RADIUS_M):
    """{station id: (campus, nearest location id, metres)} for docks within radius of a BU location."""
    out = {}
    for sid, (lat, lon) in positions.items():
        best = min(locations, key=lambda l: haversine(lat, lon, l["lat"], l["lon"]))
        d = haversine(lat, lon, best["lat"], best["lon"])
        if d <= radius:
            out[sid] = (best["campus"], best["id"], d)
    return out


def bin_of(moment):
    return (moment.hour * 3600 + moment.minute * 60 + moment.second) // BIN_SECONDS


def weekday_profiles(rides, stations, weekday, month=None):
    """Per-station docked/undocked rides per 15-minute bin, averaged over every `weekday` date with
    rides in the data (only dates in `month`, YYYYMM, if given: monthly files carry a few rides
    from the day before). Returns (profiles, the dates averaged, BU rides per date)."""
    counts = {sid: {"arrivals": [0] * BINS, "departures": [0] * BINS} for sid in stations}
    per_day = defaultdict(int)
    days = set()

    def counted(moment):
        return moment.weekday() == weekday and (month is None or moment.strftime("%Y%m") == month)

    for ride in rides:
        day = None  # a BU-to-BU ride counts once per day, on the day it leaves
        if ride["to"] in stations and counted(ride["end"]):
            counts[ride["to"]]["arrivals"][bin_of(ride["end"])] += 1
            day = ride["end"].date()
        if ride["from"] in stations and counted(ride["start"]):
            counts[ride["from"]]["departures"][bin_of(ride["start"])] += 1
            day = ride["start"].date()
        if day:
            days.add(day)
            per_day[day] += 1
    n = max(1, len(days))
    profiles = {sid: {k: [round(v / n, 2) for v in series] for k, series in c.items()} for sid, c in counts.items()}
    return profiles, sorted(days), {d: per_day[d] for d in sorted(days)}


def median_day(rides_per_day):
    """The day whose ride count is the median: a typical day, not a record or a washout."""
    if not rides_per_day:
        return None
    ordered = sorted(rides_per_day, key=lambda d: (rides_per_day[d], d))
    return ordered[(len(ordered) - 1) // 2]


# --- Bike network ------------------------------------------------------------------------------


def overpass(query):
    """Run an Overpass query, cached on disk: the public server is often busy."""
    cached = CACHE / "overpass" / f"{hashlib.sha1(query.encode()).hexdigest()[:16]}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    elements = json.loads(http_get(OVERPASS, data=urllib.parse.urlencode({"data": query}).encode()))["elements"]
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(elements))
    return elements


BIKES_ALLOWED = ("yes", "designated", "permissive")


def allows_bikes(tags):
    """Bikes may use the way, if only by walking them (see walks_bike)."""
    if tags.get("bicycle") == "no":
        return False
    if tags.get("access") in ("no", "private"):
        return tags.get("bicycle") in BIKES_ALLOWED
    return True


def walks_bike(tags):
    """Sidewalks and plazas without bike access: you push the bike, as from a sidewalk dock."""
    return tags.get("bicycle") == "dismount" or (
        tags.get("highway") in ("footway", "pedestrian") and tags.get("bicycle") not in BIKES_ALLOWED
    )


def lane_kinds(tags):
    return {tags.get(k) for k in ("cycleway", "cycleway:both", "cycleway:right", "cycleway:left")} - {None}


def cost_factor(tags):
    """How much longer a metre of this way feels to a cyclist than a plain street's metre."""
    hw = tags.get("highway")
    if walks_bike(tags):
        return 3.0  # walking pace: only for the last few metres to a dock
    if hw == "cycleway" or tags.get("bicycle") == "designated":
        return 0.6
    lanes = lane_kinds(tags)
    if "track" in lanes:
        return 0.65
    if lanes & {"lane", "buffered_lane"}:
        return 0.75
    if lanes & {"shared_lane", "share_busway"}:
        return 0.9
    return {
        "primary": 1.5, "primary_link": 1.5, "secondary": 1.25, "secondary_link": 1.25, "tertiary": 1.1,
        "service": 1.5 if tags.get("service") in ("parking_aisle", "drive-through") else 1.3,
        "footway": 1.4, "pedestrian": 1.4, "track": 1.2, "path": 0.9,
    }.get(hw, 1.0)


def directions(tags):
    """(forward allowed, backward allowed) for a bike along the way's node order."""
    if tags.get("oneway:bicycle") == "no" or any(v.startswith("opposite") for v in lane_kinds(tags)):
        return True, True
    oneway = tags.get("oneway:bicycle") or tags.get("oneway")
    if oneway in ("yes", "1", "true") or (oneway is None and tags.get("junction") == "roundabout"):
        return True, False
    if oneway == "-1":
        return False, True
    return True, True


def build_graph(elements):
    """Directed bike graph: {node: [(next node, cost, metres)]}, plus node coordinates."""
    coords = {el["id"]: (el["lat"], el["lon"]) for el in elements if el["type"] == "node"}
    graph = defaultdict(list)
    for el in elements:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        if not allows_bikes(tags):
            continue
        factor = cost_factor(tags)
        forward, backward = directions(tags)
        nodes = [n for n in el["nodes"] if n in coords]
        for a, b in zip(nodes, nodes[1:]):
            d = haversine(*coords[a], *coords[b])
            if forward:
                graph[a].append((b, d * factor, d))
            if backward:
                graph[b].append((a, d * factor, d))
    return coords, dict(graph)


def reverse(graph):
    out = defaultdict(list)
    for a, edges in graph.items():
        for b, cost, d in edges:
            out[b].append((a, cost, d))
    return dict(out)


def largest_strong_component(graph, rgraph):
    """The biggest set of nodes that can all reach each other (Kosaraju, iterative): with one-way
    streets, a node can be reachable from campus yet have no way back."""
    finished, seen = [], set()
    for root in graph.keys() | rgraph.keys():
        if root in seen:
            continue
        seen.add(root)
        stack = [(root, iter(graph.get(root, ())))]
        while stack:
            node, edges = stack[-1]
            for nxt, _, _ in edges:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append((nxt, iter(graph.get(nxt, ()))))
                    break
            else:
                stack.pop()
                finished.append(node)
    best, assigned = set(), set()
    for root in reversed(finished):
        if root in assigned:
            continue
        component, stack = {root}, [root]
        assigned.add(root)
        while stack:
            for nxt, _, _ in rgraph.get(stack.pop(), ()):
                if nxt not in assigned:
                    assigned.add(nxt)
                    component.add(nxt)
                    stack.append(nxt)
        if len(component) > len(best):
            best = component
    return best


class NodeIndex:
    """Nearest graph node to a point, via a ~100 m grid."""

    CELL = 0.001

    def __init__(self, coords, nodes):
        self.coords = coords
        self.cells = defaultdict(list)
        for n in nodes:
            lat, lon = coords[n]
            self.cells[(int(lat // self.CELL), int(lon // self.CELL))].append(n)

    def nearest(self, lat, lon):
        """(node, metres), or (None, inf) if the index is empty."""
        if not self.cells:
            return None, math.inf
        ci, cj = int(lat // self.CELL), int(lon // self.CELL)
        best, found_at = None, None
        for r in range(400):
            for i in range(ci - r, ci + r + 1):
                for j in range(cj - r, cj + r + 1):
                    if max(abs(i - ci), abs(j - cj)) != r:
                        continue
                    for n in self.cells.get((i, j), ()):
                        d = haversine(lat, lon, *self.coords[n])
                        if best is None or d < best[0]:
                            best = (d, n)
            if best and found_at is None:
                found_at = r
            elif found_at is not None:  # one more ring covers a nearer node in a neighbouring cell
                return best[1], best[0]
        return (best[1], best[0]) if best else (None, math.inf)


def shortest_tree(graph, source):
    """Dijkstra from source: {node: previous node}, {node: metres along the chosen path}."""
    cost, metres, prev = {source: 0.0}, {source: 0.0}, {}
    heap = [(0.0, source)]
    while heap:
        c, node = heapq.heappop(heap)
        if c > cost[node]:
            continue
        for nxt, w, d in graph.get(node, ()):
            nc = c + w
            if nc < cost.get(nxt, math.inf):
                cost[nxt], metres[nxt], prev[nxt] = nc, metres[node] + d, node
                heapq.heappush(heap, (nc, nxt))
    return prev, metres


def walk_back(prev, node, source):
    """Nodes from `node` back to `source` along a shortest-path tree."""
    nodes = [node]
    while node != source:
        node = prev[node]
        nodes.append(node)
    return nodes


def simplify(points, tolerance=SIMPLIFY_M):
    """Ramer-Douglas-Peucker on [lng, lat] points, tolerance in metres."""
    if len(points) < 3:
        return points
    lat0 = math.radians(points[0][1])
    xy = [(p[0] * 111320 * math.cos(lat0), p[1] * 110540) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        length = math.hypot(bx - ax, by - ay)
        far, far_d = None, tolerance
        for i in range(a + 1, b):
            px, py = xy[i]
            d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length if length else math.hypot(px - ax, py - ay)
            if d > far_d:
                far, far_d = i, d
        if far is not None:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, k in zip(points, keep) if k]


def timestamps(points, depart, speed):
    """Seconds at each [lng, lat] point for a ride leaving at `depart` at a steady speed."""
    out, t = [round(depart, 1)], depart
    for a, b in zip(points, points[1:]):
        t += haversine(a[1], a[0], b[1], b[0]) / speed
        out.append(round(t, 1))
    return out


def ride_timing(length, ride, midnight, anchor, reached):
    """(depart seconds-since-midnight, speed). The time at the BU dock is the real one: a ride
    leaving BU departs at its real start, a ride arriving at BU docks at its real end. Rides that
    stay on the map use their real duration; rides leaving it ride at a typical speed."""
    start = (ride["start"] - midnight).total_seconds()
    end = (ride["end"] - midnight).total_seconds()
    if reached and end > start:
        speed = min(MAX_SPEED, max(MIN_SPEED, length / (end - start)))
    else:
        speed = CRUISE[ride["type"]]
    if anchor == "from":
        return start, speed
    return end - length / speed, speed


def padded_bbox(points, pad=NETWORK_PAD_M):
    """(south, west, north, east) around (lat, lon) points, padded by `pad` metres."""
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    pad_lat = pad / 111000
    pad_lon = pad / (111000 * math.cos(math.radians(sum(lats) / len(lats))))
    return min(lats) - pad_lat, min(lons) - pad_lon, max(lats) + pad_lat, max(lons) + pad_lon


def network_groups(points_by_campus):
    """Campuses whose routed areas overlap share one network (Fenway's docks sit inside the
    Charles River's area), so a ride between them isn't cut at an artificial edge.
    Returns [(campus ids, points)]."""
    groups = [([c], list(p)) for c, p in sorted(points_by_campus.items())]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                (s1, w1, n1, e1), (s2, w2, n2, e2) = padded_bbox(groups[i][1]), padded_bbox(groups[j][1])
                if s1 <= n2 and s2 <= n1 and w1 <= e2 and w2 <= e1:
                    groups[i] = (groups[i][0] + groups[j][0], groups[i][1] + groups[j][1])
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    return groups


class Network:
    """One routed area: a group of campuses' docks plus NETWORK_PAD_M around them."""

    def __init__(self, name, points):
        self.name = name
        self.bbox = padded_bbox(points)
        s, w, n, e = self.bbox
        print(f"Fetching the {name} bike network from OpenStreetMap...", file=sys.stderr)
        query = (
            f'[out:json][timeout:180];way["highway"~"^({BIKE_HIGHWAYS})$"]'
            f"({s:.5f},{w:.5f},{n:.5f},{e:.5f});(._;>;);out body qt;"
        )
        self.coords, self.graph = build_graph(overpass(query))
        self.rgraph = reverse(self.graph)
        # Only nodes you can both get to and get away from: no one-way dead ends or islands.
        component = largest_strong_component(self.graph, self.rgraph)
        self.index = NodeIndex(self.coords, component)
        self.trees = {}
        print(f"  {len(component)} routable nodes", file=sys.stderr)

    def snap(self, point):
        """Nearest routable node, clamping points beyond the area to its edge first."""
        s, w, n, e = self.bbox
        lat, lon = min(max(point[0], s), n), min(max(point[1], w), e)
        node, _ = self.index.nearest(lat, lon)
        return node, haversine(point[0], point[1], *self.coords[node])

    def tree(self, node, outbound):
        key = (node, outbound)
        if key not in self.trees:
            self.trees[key] = shortest_tree(self.graph if outbound else self.rgraph, node)
        return self.trees[key]

    def route(self, dock_node, other_node, outbound):
        """([lng, lat] points from the BU dock out to the other end, or in from it; metres), or
        (None, 0) when the other end can't be reached."""
        prev, metres = self.tree(dock_node, outbound)
        if other_node not in prev and other_node != dock_node:
            return None, 0.0
        nodes = walk_back(prev, other_node, dock_node)
        if outbound:
            nodes.reverse()
        return [[round(self.coords[n][1], 6), round(self.coords[n][0], 6)] for n in nodes], metres.get(other_node, 0.0)


# --- Assembly ----------------------------------------------------------------------------------


def gbfs_stations():
    """{short name (the trip data's station id): live-feed station}. Optional: without it the map
    simply has no live dock counts."""
    try:
        data = json.loads(http_get(GBFS_STATIONS, timeout=30))["data"]["stations"]
    except (urllib.error.URLError, KeyError, ValueError) as err:
        warn(f"Bluebikes live station list unavailable ({err}); no live dock counts")
        return {}
    return {s["short_name"]: s for s in data if s.get("short_name")}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--month", default="202609", help="trip-data month, YYYYMM (default: 202609)")
    parser.add_argument("--weekday", default="Wednesday", choices=WEEKDAYS, help="weekday to profile and replay")
    parser.add_argument("--replay-date", type=date.fromisoformat, help="day to replay (default: the median weekday)")
    parser.add_argument("--radius", type=float, default=STATION_RADIUS_M, help="max metres from a BU location to a dock")
    args = parser.parse_args()
    weekday = WEEKDAYS.index(args.weekday)

    path = trip_file(args.month)
    print(f"Reading {path.name}...", file=sys.stderr)
    rides = [r for r in map(parse_ride, read_trips(path)) if r]

    # Station positions: the mean reported dock position (e-bike GPS jitters around the dock).
    sums = defaultdict(lambda: [0.0, 0.0, 0, None])
    for r in rides:
        for sid, point, name in ((r["from"], r["fromPoint"], r["fromName"]), (r["to"], r["toPoint"], r["toName"])):
            if sid and point:
                acc = sums[sid]
                acc[0] += point[0]
                acc[1] += point[1]
                acc[2] += 1
                acc[3] = name
    positions = {sid: (a[0] / a[2], a[1] / a[2]) for sid, a in sums.items()}
    names = {sid: a[3] for sid, a in sums.items()}

    locations = load_locations()
    stations = campus_stations(positions, locations, args.radius)
    if not stations:
        sys.exit("No Bluebikes docks near BU locations; check data-pipeline/campuses/*.json")
    profiles, days, rides_per_day = weekday_profiles(rides, stations, weekday, args.month)
    if not days:
        sys.exit(f"No {args.weekday} rides at BU docks in {args.month}")
    replay = args.replay_date or median_day(rides_per_day)
    if replay not in rides_per_day:
        sys.exit(f"{replay} has no rides at BU docks; pick one of {', '.join(map(str, days))}")
    midnight = datetime.combine(replay, datetime.min.time())

    live = gbfs_stations()
    out_stations = []
    for sid, (campus, near, _) in sorted(stations.items(), key=lambda s: (s[1][0], s[0])):
        info = live.get(sid, {})
        lat, lon = (info["lat"], info["lon"]) if "lat" in info else positions[sid]
        name = info.get("name") or names[sid]
        out_stations.append({
            "id": sid,
            "gbfsId": info.get("station_id"),
            "name": name,
            "short": short_name(name),
            "campus": campus,
            "near": near,
            "position": [round(lon, 6), round(lat, 6)],
            "capacity": info.get("capacity"),
            "profile": profiles[sid],
        })
        if not info:
            warn(f"{sid} ({name}) isn't in the live feed; no live dock counts for it")

    # One routed network per group of nearby campuses.
    by_campus = defaultdict(list)
    for sid, (campus, _, _) in stations.items():
        by_campus[campus].append(positions[sid])
    networks = {}
    for campus_ids, points in network_groups(by_campus):
        network = Network(" + ".join(campus_ids), points)
        networks.update({c: network for c in campus_ids})
    dock_nodes = {}
    for sid, (campus, _, _) in stations.items():
        node, gap = networks[campus].snap(positions[sid])
        if gap > 60:
            warn(f"{sid} ({names[sid]}) is {gap:.0f} m from the bike network")
        dock_nodes[sid] = node

    trips, skipped = [], defaultdict(int)
    day_rides = [r for r in rides if r["start"].date() == replay or r["end"].date() == replay]
    for ride in sorted(day_rides, key=lambda r: r["start"]):
        if ride["from"] in stations and ride["start"].date() == replay:
            anchor, dock, other_point = "from", ride["from"], ride["toPoint"]
        elif ride["to"] in stations and ride["end"].date() == replay:
            anchor, dock, other_point = "to", ride["to"], ride["fromPoint"]
        else:
            continue
        if other_point is None:
            skipped["no far end"] += 1
            continue
        network = networks[stations[dock][0]]
        other_node, gap = network.snap(other_point)
        points, length = network.route(dock_nodes[dock], other_node, outbound=anchor == "from")
        if points is None:
            skipped["unroutable"] += 1
            continue
        if length < MIN_DRAWN_M:
            skipped["round trip or same block"] += 1
            continue
        reached = gap <= FULL_SNAP_M
        depart, speed = ride_timing(length, ride, midnight, anchor, reached)
        points = simplify(points)
        trips.append({
            "from": ride["from"],
            "to": ride["to"],
            "fromName": short_name(ride["fromName"] or "Unknown"),
            "toName": short_name(ride["toName"] or "Unknown"),
            "type": ride["type"],
            "member": ride["member"],
            "reached": reached,
            "path": points,
            "timestamps": timestamps(points, depart, speed),
        })

    payload = {
        "source": "Bluebikes System Data (https://bluebikes.com/system-data)",
        "month": f"{args.month[:4]}-{args.month[4:]}",
        "weekday": args.weekday,
        "replayDate": replay.isoformat(),
        "profileDates": [d.isoformat() for d in days],
        "ridesPerDay": {d.isoformat(): n for d, n in rides_per_day.items()},
        "binSeconds": BIN_SECONDS,
        "stationRadiusMetres": args.radius,
        "stations": out_stations,
        "trips": trips,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))

    print(f"{len(out_stations)} BU docks; {args.weekday} rides at them: "
          + ", ".join(f"{d} {n}" for d, n in rides_per_day.items()), file=sys.stderr)
    print(f"Replaying {replay}: {len(trips)} rides drawn ({sum(t['reached'] for t in trips)} end to end, "
          f"{sum(not t['reached'] for t in trips)} to the map edge)", file=sys.stderr)
    for reason, n in sorted(skipped.items()):
        print(f"  {n} not drawn: {reason}", file=sys.stderr)
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
