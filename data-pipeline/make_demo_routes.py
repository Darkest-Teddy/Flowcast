"""Build placeholder agent trips on BU's real walkway network for the map client.

Stand-in for simulate_week.py until the Simulation Lead's output exists: it pulls the
walk network from OpenStreetMap (Overpass), snaps a handful of real BU buildings to it,
routes every trip with Dijkstra, and writes one day of trips in the format the map
client renders (see map-client/README.md, "Data contract").

Standard library only, so it runs before anyone has set up a Python environment:
    python3 data-pipeline/make_demo_routes.py
"""

import hashlib
import heapq
import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BBOX = (42.3455, -71.1225, 42.3560, -71.0925)  # south, west, north, east: central + west campus
OUT = Path(__file__).resolve().parent.parent / "map-client" / "public" / "data" / "demo-day.json"
CACHE = Path(__file__).resolve().parent / ".cache" / "overpass"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

AGENT_COUNT = 300
SEED = 7

WALKABLE = "footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|secondary|primary|crossing|corridor"

# Real BU locations: (id, name, kind, lat, lon, real-world capacity, OSM footprint).
# SHORT_NAMES are what students call them; the big-screen labels use these.
# Coordinates are OSM building centers (Overpass, Oct 2026). Capacities are rough public figures
# (beds, seats) used only for relative size. Locations inside the same building share a footprint.
LOCATIONS = [
    ("warren", "Warren Towers", "dorm", 42.34933, -71.10402, 1800, "relation/20512578"),
    ("myles", "Myles Standish Hall", "dorm", 42.34967, -71.09443, 750, "way/29557600"),
    ("stuvi", "Student Village", "dorm", 42.35239, -71.11599, 950, "way/29927783"),
    ("claflin", "Claflin Hall", "dorm", 42.35252, -71.11981, 350, "way/29889456"),
    ("kilachand", "Kilachand Hall", "dorm", 42.35035, -71.09700, 550, "way/29863053"),
    ("cas", "College of Arts and Sciences", "classroom", 42.35028, -71.10559, 900, "way/1007090939"),
    ("cds", "Computing & Data Sciences", "classroom", 42.35003, -71.10290, 600, "way/277434241"),
    ("questrom", "Questrom School of Business", "classroom", 42.34961, -71.09973, 700, "way/256604722"),
    ("photonics", "Photonics Center", "classroom", 42.34917, -71.10611, 500, "way/29581513"),
    ("epic", "Engineering Product Innovation Center", "classroom", 42.34970, -71.10802, 300, "way/29513001"),
    ("mugar", "Mugar Memorial Library", "library", 42.35100, -71.10800, 800, "way/130209089"),
    ("pardee", "Pardee Library", "library", 42.34962, -71.09968, 200, "way/256604722"),
    ("gsu", "George Sherman Union", "dining", 42.35097, -71.10886, 600, "way/130209090"),
    ("warren-dining", "Warren Towers Dining Hall", "dining", 42.34940, -71.10406, 500, "relation/20512578"),
    ("agganis", "Agganis Arena", "gym", 42.35222, -71.11774, 1500, "way/102384832"),
]

SHORT_NAMES = {
    "warren": "Warren Towers",
    "myles": "Myles",
    "stuvi": "StuVi",
    "claflin": "Claflin",
    "kilachand": "Kilachand",
    "cas": "CAS",
    "cds": "CDS",
    "questrom": "Questrom",
    "photonics": "Photonics",
    "epic": "EPIC",
    "mugar": "Mugar Library",
    "pardee": "Pardee Library",
    "gsu": "GSU",
    "warren-dining": "Warren Dining",
    "agganis": "Agganis Arena",
}

# Peak share of the simulated population expected in each kind of place at once. Capacities are
# scaled so "% full" means the same thing at 300 agents as it would for the real campus.
KIND_PEAK_SHARE = {"dorm": 1.1, "classroom": 0.75, "dining": 0.4, "library": 0.3, "gym": 0.15}
# Footprints whose OSM entry has no height or level tags.
HEIGHT_OVERRIDES = {"relation/20512578": 18 * 3.6}  # Warren Towers: 18-storey towers
METRES_PER_LEVEL = 3.6
DEFAULT_LEVELS = 4

MWF_SLOTS = [8 * 60, 9 * 60 + 5, 10 * 60 + 10, 11 * 60 + 15, 12 * 60 + 20, 13 * 60 + 25, 14 * 60 + 30, 15 * 60 + 35]


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


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


def stitch_rings(segments):
    """Join a multipolygon's outer member ways end-to-end into closed rings."""
    segments = [list(seg) for seg in segments]
    rings = []
    while segments:
        ring = segments.pop(0)
        while ring[0] != ring[-1]:
            for i, seg in enumerate(segments):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                else:
                    continue
                segments.pop(i)
                break
            else:
                break  # unclosable fragment; keep what we have
        rings.append(ring)
    return rings


def fetch_footprints(refs):
    ways = ",".join(r.split("/")[1] for r in refs if r.startswith("way/"))
    rels = ",".join(r.split("/")[1] for r in refs if r.startswith("relation/"))
    elements = overpass(f"[out:json][timeout:60];(way(id:{ways});relation(id:{rels}););out geom;")
    buildings = []
    for el in elements:
        if el["type"] == "way":
            rings = [[[round(p["lon"], 6), round(p["lat"], 6)] for p in el["geometry"]]]
        else:
            outers = [
                [[round(p["lon"], 6), round(p["lat"], 6)] for p in m["geometry"]]
                for m in el["members"]
                if m["type"] == "way" and m.get("role") == "outer"
            ]
            rings = stitch_rings(outers)
        tags = el.get("tags", {})
        levels = float(tags.get("building:levels", DEFAULT_LEVELS))
        ref = f"{el['type']}/{el['id']}"
        height = HEIGHT_OVERRIDES.get(ref) or float(tags.get("height", levels * METRES_PER_LEVEL))
        for ring in rings:
            buildings.append({"id": ref, "name": tags.get("name"), "polygon": ring, "height": height})
    return buildings


def fetch_walk_network():
    s, w, n, e = BBOX
    elements = overpass(f'[out:json][timeout:90];way["highway"~"^({WALKABLE})$"]["foot"!="no"]({s},{w},{n},{e});(._;>;);out skel qt;')

    coords = {el["id"]: (el["lat"], el["lon"]) for el in elements if el["type"] == "node"}
    graph = {}
    for el in elements:
        if el["type"] != "way":
            continue
        nodes = [nid for nid in el["nodes"] if nid in coords]
        for a, b in zip(nodes, nodes[1:]):
            d = haversine(*coords[a], *coords[b])
            graph.setdefault(a, []).append((b, d))
            graph.setdefault(b, []).append((a, d))
    return coords, graph


def largest_component(graph):
    seen, best = set(), set()
    for start in graph:
        if start in seen:
            continue
        comp, stack = {start}, [start]
        while stack:
            for nxt, _ in graph[stack.pop()]:
                if nxt not in comp:
                    comp.add(nxt)
                    stack.append(nxt)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    return best


def dijkstra(graph, source):
    dist, prev = {source: 0.0}, {}
    heap = [(0.0, source)]
    while heap:
        d, node = heapq.heappop(heap)
        if d > dist[node]:
            continue
        for nxt, w in graph[node]:
            nd = d + w
            if nd < dist.get(nxt, math.inf):
                dist[nxt], prev[nxt] = nd, node
                heapq.heappush(heap, (nd, nxt))
    return dist, prev


def build_routes(coords, graph):
    component = largest_component(graph)
    snapped = {}
    for loc_id, _, _, lat, lon, _, _ in LOCATIONS:
        snapped[loc_id] = min(component, key=lambda nid: haversine(lat, lon, *coords[nid]))

    routes = {}
    for src_id, src_node in snapped.items():
        dist, prev = dijkstra(graph, src_node)
        for dst_id, dst_node in snapped.items():
            if dst_id == src_id:
                continue
            node, nodes = dst_node, [dst_node]
            while node != src_node:
                node = prev[node]
                nodes.append(node)
            nodes.reverse()
            path = [[round(coords[nid][1], 6), round(coords[nid][0], 6)] for nid in nodes]
            cumulative = [0.0]
            for a, b in zip(nodes, nodes[1:]):
                cumulative.append(cumulative[-1] + haversine(*coords[a], *coords[b]))
            routes[(src_id, dst_id)] = (path, cumulative)
    return routes


def plan_day(rng, by_kind):
    """A rough MWF day: home -> classes (with a meal and maybe study/gym between) -> home.

    Places are picked in proportion to their real capacity, so big buildings draw big crowds."""

    def pick(kind):
        ids, weights = by_kind[kind]
        return rng.choices(ids, weights=weights)[0]

    home = pick("dorm")
    slots = sorted(rng.sample(MWF_SLOTS, rng.randint(2, 4)))
    stops = []  # (location_id, arrive_by_minute)
    for slot in slots:
        stops.append((pick("classroom"), slot))
    lunch = rng.randint(11 * 60 + 30, 13 * 60 + 45)
    stops.append((pick("dining"), lunch))
    if rng.random() < 0.55:
        stops.append((pick("library"), rng.randint(14 * 60, 19 * 60)))
    if rng.random() < 0.25:
        stops.append((pick("gym"), rng.randint(16 * 60, 20 * 60)))
    stops.append((pick("dining"), rng.randint(17 * 60 + 30, 19 * 60 + 30)))
    stops.sort(key=lambda s: s[1])
    stops.append((home, rng.randint(20 * 60, 22 * 60)))
    return home, stops


def main():
    rng = random.Random(SEED)
    print("Fetching BU walk network from OpenStreetMap...", file=sys.stderr)
    coords, graph = fetch_walk_network()
    print(f"  {len(graph)} nodes", file=sys.stderr)
    routes = build_routes(coords, graph)

    by_kind = {}
    for loc_id, _, kind, _, _, cap, _ in LOCATIONS:
        ids, weights = by_kind.setdefault(kind, ([], []))
        ids.append(loc_id)
        weights.append(cap)

    agents, trips = [], []
    for i in range(AGENT_COUNT):
        agent_id = f"a{i:03d}"
        speed = rng.uniform(1.1, 1.5)  # metres per second
        home, stops = plan_day(rng, by_kind)
        agents.append({"id": agent_id, "home": home, "model": rng.randrange(12)})
        here, free_at = home, 0
        for dest, arrive_by in stops:
            if dest == here:
                continue
            path, cumulative = routes[(here, dest)]
            duration = cumulative[-1] / speed
            depart = max(free_at, arrive_by * 60 - duration - rng.uniform(60, 600))
            trips.append({
                "agent": agent_id,
                "from": here,
                "to": dest,
                "path": path,
                "timestamps": [round(depart + c / speed, 1) for c in cumulative],
            })
            here, free_at = dest, depart + duration + 25 * 60

    locations = []
    for loc_id, name, kind, lat, lon, cap, building in LOCATIONS:
        kind_total = sum(by_kind[kind][1])
        capacity = max(5, round(cap / kind_total * AGENT_COUNT * KIND_PEAK_SHARE[kind]))
        locations.append({"id": loc_id, "name": name, "short": SHORT_NAMES[loc_id], "kind": kind, "position": [lon, lat], "capacity": capacity, "building": building})

    print("Fetching building footprints...", file=sys.stderr)
    buildings = fetch_footprints(sorted({loc[6] for loc in LOCATIONS}))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"day": "Wednesday", "buildings": buildings, "locations": locations, "agents": agents, "trips": trips}
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {len(agents)} agents, {len(trips)} trips -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
