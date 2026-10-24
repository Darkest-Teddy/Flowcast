"""Build placeholder agent trips on BU's real walkway network for the map client.

Stand-in for simulate_week.py until the Simulation Lead's output exists: it pulls each campus's
walk network from OpenStreetMap (Overpass), snaps real BU buildings to it, routes every trip
with Dijkstra, and writes one day of trips in the format the map client renders (see
map-client/README.md, "Data contract").

Campuses and their locations live in data-pipeline/campuses/*.json. Every file in that folder is
loaded; files that share a campus id merge (locations append, bboxes union). Campuses are routed
separately: each agent lives and studies on one campus and never walks between campuses.

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

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "map-client" / "public" / "data" / "demo-day.json"
CAMPUS_DIR = HERE / "campuses"
CACHE = HERE / ".cache" / "overpass"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

AGENT_COUNT = 300
MIN_AGENTS_PER_CAMPUS = 40  # so every campus visibly moves, however small it is
SEED = 7

WALKABLE = "footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|secondary|primary|crossing|corridor"

KINDS = ("dorm", "classroom", "library", "dining", "gym")
REQUIRED_FIELDS = ("id", "name", "kind", "lat", "lon", "capacity", "osm")
# Peak share of a campus's simulated population expected in each kind of place at once. Capacities
# are scaled per campus, so "% full" means the same thing for 40 agents as for the real campus.
KIND_PEAK_SHARE = {"dorm": 1.1, "classroom": 0.75, "dining": 0.4, "library": 0.3, "gym": 0.15}
METRES_PER_LEVEL = 3.6
DEFAULT_LEVELS = 4
SNAP_WARN_METRES = 150  # a location this far from its campus walk network probably has a bad bbox

MWF_SLOTS = [8 * 60, 9 * 60 + 5, 10 * 60 + 10, 11 * 60 + 15, 12 * 60 + 20, 13 * 60 + 25, 14 * 60 + 30, 15 * 60 + 35]


def warn(msg):
    print(f"  WARNING: {msg}", file=sys.stderr)


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


def load_campuses():
    """Merge every campuses/*.json into a list of campuses, biggest (by total capacity) first."""
    campuses, seen = {}, set()
    files = [(path, json.loads(path.read_text())) for path in CAMPUS_DIR.glob("*.json")]
    # A campus's base file (named after its id, e.g. charles-river.json) loads before its add-ons,
    # so on a duplicate location id the base file's entry wins.
    files.sort(key=lambda f: (f[0].stem != f[1]["campus"], f[0].name))
    for path, data in files:
        cid = data["campus"]
        campus = campuses.setdefault(cid, {"id": cid, "name": None, "bbox": None, "locations": []})
        campus["name"] = campus["name"] or data.get("name")
        if data.get("bbox"):
            s, w, n, e = data["bbox"]
            if campus["bbox"]:
                s0, w0, n0, e0 = campus["bbox"]
                s, w, n, e = min(s, s0), min(w, w0), max(n, n0), max(e, e0)
            campus["bbox"] = [s, w, n, e]
        for loc in data.get("locations", []):
            missing = [f for f in REQUIRED_FIELDS if f not in loc]
            if missing:
                warn(f"{path.name}: skipping {loc.get('id', '?')}, missing {', '.join(missing)}")
                continue
            if loc["kind"] not in KINDS:
                warn(f"{path.name}: skipping {loc['id']}, unknown kind {loc['kind']!r}")
                continue
            if loc["id"] in seen:
                warn(f"{path.name}: skipping duplicate location id {loc['id']}")
                continue
            seen.add(loc["id"])
            campus["locations"].append({**loc, "short": loc.get("short") or loc["name"], "campus": cid})

    out = []
    for campus in campuses.values():
        locs = campus["locations"]
        if not locs:
            warn(f"campus {campus['id']} has no locations; skipping it")
            continue
        if not campus["bbox"]:  # no bbox given: pad the locations' extent by ~300 m
            lats, lons = [l["lat"] for l in locs], [l["lon"] for l in locs]
            campus["bbox"] = [min(lats) - 0.003, min(lons) - 0.004, max(lats) + 0.003, max(lons) + 0.004]
        campus["name"] = campus["name"] or campus["id"].replace("-", " ").title()
        campus["total_capacity"] = sum(max(1, l["capacity"]) for l in locs)
        out.append(campus)
    if not out:
        sys.exit(f"No campus locations found in {CAMPUS_DIR}")
    out.sort(key=lambda c: -c["total_capacity"])
    return out


def split_agents(campuses, total):
    """Agents per campus in proportion to total capacity, with a floor so small campuses still move."""
    caps = {c["id"]: c["total_capacity"] for c in campuses}
    floor = min(MIN_AGENTS_PER_CAMPUS, total // len(campuses))
    fixed, shares = {}, {}
    while True:
        free = [cid for cid in caps if cid not in fixed]
        if not free:
            break
        budget = total - sum(fixed.values())
        cap_sum = sum(caps[cid] for cid in free)
        shares = {cid: budget * caps[cid] / cap_sum for cid in free}
        low = [cid for cid in free if shares[cid] < floor]
        if not low:
            break
        for cid in low:
            fixed[cid] = floor
    free = [cid for cid in caps if cid not in fixed]
    counts = {**fixed, **{cid: int(shares[cid]) for cid in free}}
    # Largest remainder; if every campus sat on the floor, the leftovers go to the biggest ones.
    order = sorted(free, key=lambda cid: counts[cid] - shares[cid]) or sorted(caps, key=lambda cid: -caps[cid])
    for i in range(total - sum(counts.values())):
        counts[order[i % len(order)]] += 1
    return counts


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


def fetch_footprints(refs, height_overrides, campus_of):
    """Footprint rings for OSM refs ("way/1", "relation/2"). Returns (buildings, unresolved refs)."""
    ways = ",".join(r.split("/")[1] for r in refs if r.startswith("way/"))
    rels = ",".join(r.split("/")[1] for r in refs if r.startswith("relation/"))
    parts = (f"way(id:{ways});" if ways else "") + (f"relation(id:{rels});" if rels else "")
    elements = overpass(f"[out:json][timeout:60];({parts});out geom;") if parts else []
    buildings, found = [], set()
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
        ref = f"{el['type']}/{el['id']}"
        found.add(ref)
        try:
            levels = float(tags.get("building:levels", DEFAULT_LEVELS))
            height = height_overrides.get(ref) or float(tags.get("height", levels * METRES_PER_LEVEL))
        except ValueError:  # e.g. height="20 m"
            height = height_overrides.get(ref) or DEFAULT_LEVELS * METRES_PER_LEVEL
        for ring in rings:
            buildings.append({"id": ref, "name": tags.get("name"), "polygon": ring, "height": height, "campus": campus_of.get(ref)})
    return buildings, sorted(set(refs) - found)


def fetch_walk_network(bbox):
    s, w, n, e = bbox
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


def build_routes(coords, graph, locations):
    """Shortest walk between every pair of one campus's locations."""
    component = largest_component(graph)
    if not component:
        sys.exit("Walk network is empty; check the campus bbox")
    snapped = {}
    for loc in locations:
        node = min(component, key=lambda nid: haversine(loc["lat"], loc["lon"], *coords[nid]))
        gap = haversine(loc["lat"], loc["lon"], *coords[node])
        if gap > SNAP_WARN_METRES:
            warn(f"{loc['id']} is {gap:.0f} m from the walk network; is it inside its campus bbox?")
        snapped[loc["id"]] = node

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
            if len(nodes) == 1:  # both places snap to one door (e.g. a library inside a classroom building)
                nodes.append(nodes[0])
            path = [[round(coords[nid][1], 6), round(coords[nid][0], 6)] for nid in nodes]
            cumulative = [0.0]
            for a, b in zip(nodes, nodes[1:]):
                cumulative.append(cumulative[-1] + haversine(*coords[a], *coords[b]))
            routes[(src_id, dst_id)] = (path, cumulative)
    return routes


def plan_day(rng, by_kind):
    """A rough MWF day: home -> classes (with a meal and maybe study/gym between) -> home.

    Places are picked in proportion to their real capacity, so big buildings draw big crowds.
    Kinds the campus doesn't have are skipped. With no dorm, the agent "lives" at a classroom
    building and the day simply ends after its last stop (no trip home)."""

    def pick(kind):
        if kind not in by_kind:
            return None
        ids, weights = by_kind[kind]
        return rng.choices(ids, weights=weights)[0]

    has_dorm = "dorm" in by_kind
    home = pick("dorm") or pick("classroom") or pick(next(iter(by_kind)))
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
    stops = sorted((s for s in stops if s[0] is not None), key=lambda s: s[1])
    if has_dorm:
        stops.append((home, rng.randint(20 * 60, 22 * 60)))
    return home, stops


def simulate_campus(rng, campus, agent_count, first_index):
    """Agents, trips and scaled locations for one campus, routed on its own walk network."""
    print(f"Fetching {campus['name']} walk network from OpenStreetMap...", file=sys.stderr)
    coords, graph = fetch_walk_network(campus["bbox"])
    print(f"  {len(graph)} nodes", file=sys.stderr)
    routes = build_routes(coords, graph, campus["locations"])

    by_kind = {}
    for loc in campus["locations"]:
        ids, weights = by_kind.setdefault(loc["kind"], ([], []))
        ids.append(loc["id"])
        weights.append(max(1, loc["capacity"]))

    agents, trips = [], []
    for i in range(first_index, first_index + agent_count):
        agent_id = f"a{i:03d}"
        speed = rng.uniform(1.1, 1.5)  # metres per second
        home, stops = plan_day(rng, by_kind)
        agents.append({"id": agent_id, "home": home, "model": rng.randrange(12), "campus": campus["id"]})
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
    for loc in campus["locations"]:
        kind_total = sum(by_kind[loc["kind"]][1])
        capacity = max(5, round(max(1, loc["capacity"]) / kind_total * agent_count * KIND_PEAK_SHARE[loc["kind"]]))
        locations.append({
            "id": loc["id"], "name": loc["name"], "short": loc["short"], "kind": loc["kind"],
            "position": [loc["lon"], loc["lat"]], "capacity": capacity, "building": loc["osm"], "campus": campus["id"],
        })
    return agents, trips, locations


def main():
    rng = random.Random(SEED)
    campuses = load_campuses()
    counts = split_agents(campuses, AGENT_COUNT)

    agents, trips, locations = [], [], []
    for campus in campuses:
        a, t, l = simulate_campus(rng, campus, counts[campus["id"]], len(agents))
        agents += a
        trips += t
        locations += l

    print("Fetching building footprints...", file=sys.stderr)
    all_locs = [loc for c in campuses for loc in c["locations"]]
    heights = {loc["osm"]: loc["height"] for loc in all_locs if loc.get("height")}
    campus_of = {loc["osm"]: loc["campus"] for loc in all_locs}
    buildings, unresolved = fetch_footprints(sorted(campus_of), heights, campus_of)
    for ref in unresolved:
        users = ", ".join(loc["id"] for loc in all_locs if loc["osm"] == ref)
        warn(f"footprint {ref} not found in OSM (used by {users}); it won't be drawn")

    campus_out = []
    for c in campuses:
        locs = c["locations"]
        center = [round(sum(l["lon"] for l in locs) / len(locs), 6), round(sum(l["lat"] for l in locs) / len(locs), 6)]
        campus_out.append({"id": c["id"], "name": c["name"], "bbox": c["bbox"], "center": center})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "day": "Wednesday",
        "campuses": campus_out,
        "buildings": buildings,
        "locations": locations,
        "agents": agents,
        "trips": trips,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))

    agent_campus = {a["id"]: a["campus"] for a in agents}
    print(f"{'campus':<16}{'locations':>10}{'footprints':>12}{'agents':>8}{'trips':>8}", file=sys.stderr)
    for c in campuses:
        cid = c["id"]
        refs = {loc["osm"] for loc in c["locations"]}
        resolved = f"{len(refs - set(unresolved))}/{len(refs)}"
        n_agents = sum(campus == cid for campus in agent_campus.values())
        n_trips = sum(agent_campus[t["agent"]] == cid for t in trips)
        print(f"{cid:<16}{len(c['locations']):>10}{resolved:>12}{n_agents:>8}{n_trips:>8}", file=sys.stderr)
    print(f"Wrote {len(agents)} agents, {len(trips)} trips, {len(campuses)} campuses -> {OUT}", file=sys.stderr)
    if unresolved:
        print(f"  {len(unresolved)} footprint(s) unresolved: {', '.join(unresolved)}", file=sys.stderr)


if __name__ == "__main__":
    main()
