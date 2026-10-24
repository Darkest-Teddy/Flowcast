"""Build placeholder agent trips on BU's real walkway network for the map client.

Stand-in for simulate_week.py until the Simulation Lead's output exists: it pulls each campus's
walk network from OpenStreetMap (Overpass), joins real BU buildings to it at their doors, routes
every trip with Dijkstra, and writes one day of trips in the format the map client renders (see
map-client/README.md, "Data contract").

Walkers keep to sidewalks and cross at crosswalks: the graph (pedestrian_network.py) makes road
centre lines several times dearer than footways, and draws any stretch still along a road beside
it, on the sidewalk side, rather than down the middle. A building's door is its OSM entrance, else
the sidewalk between it and the street it's addressed on.

Campuses and their locations live in data-pipeline/campuses/*.json. Every file in that folder is
loaded; files that share a campus id merge (locations append, bboxes union). Campuses are routed
separately: each agent lives and studies on one campus and never walks between campuses.

It also routes riders off the T and buses: for every Green Line station, MBTA bus stop and BU
Shuttle stop near a campus, the walk from the stop to that campus's nearest locations
("stopRoutes"). The map's rider simulation (map-client/src/sim/riders.ts) walks people from a
stopped train or bus to real buildings along these.

Standard library only, so it runs before anyone has set up a Python environment:
    python3 data-pipeline/make_demo_routes.py
"""

import hashlib
import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pedestrian_network

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "map-client" / "public" / "data" / "demo-day.json"
CAMPUS_DIR = HERE / "campuses"
CACHE = HERE / ".cache" / "overpass"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

AGENT_COUNT = 1200
MIN_AGENTS_PER_CAMPUS = 40  # so every campus visibly moves, however small it is
SEED = 7

WALKABLE = "|".join(pedestrian_network.WALKABLE)  # fetched with tags; pedestrian_network checks foot access
DOOR_ENTRANCES = ("main", "yes", "secondary", "home", "staircase")  # OSM entrance=* walkers use
NETWORKS = {}  # campus id -> (pedestrian graph, {location id: door node}); stop_routes() reuses them

KINDS = ("dorm", "classroom", "library", "dining", "gym")
REQUIRED_FIELDS = ("id", "name", "kind", "lat", "lon", "capacity", "osm")
# Peak share of a campus's simulated population expected in each kind of place at once. Capacities
# are scaled per campus, so "% full" means the same thing for 40 agents as for the real campus.
TARGET_PEAK = 0.85  # how full each kind of place is at its busiest simulated moment
MAX_PEAK = 1.05  # no single building peaks above this
METRES_PER_LEVEL = 3.6
DEFAULT_LEVELS = 4
SNAP_WARN_METRES = 150  # a location this far from its campus walk network probably has a bad bbox

# Rider routes from transit stops (see stop_routes()).
TRANSIT_JSON = HERE.parent / "map-client" / "public" / "data" / "transit.json"
TRANSLOC_ROUTES = "https://bu.transloc.com/Services/JSONPRelay.svc/GetRoutesForMapWithScheduleWithEncodedLine"
TRANSLOC_CACHE = HERE / ".cache" / "transloc-routes.json"
STOP_ROUTES_PER_STOP = 8  # walk routes from each stop to this many of its campus's nearest locations
STOP_CAMPUS_MARGIN = 0.0015  # degrees (~150 m): a stop just outside a campus bbox still serves it
STOP_SNAP_MAX_METRES = 90  # a stop further than this from the campus walk network is skipped
STOP_ROUTE_MAX_METRES = 1200  # nobody gets off the T to walk further than this to a BU building
UNDERGROUND_STOPS = {"place-kencl"}  # Kenmore's platforms are underground; nobody waits on the street

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


def ring_centre(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def fetch_footprints(refs, height_overrides, campus_of, part_heights=None):
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
            # A multi-part building (Warren Towers: three towers on a podium) can give a height per
            # part: the part whose centre is within 15 m of a listed centre gets that height.
            ring_height = height
            for part in (part_heights or {}).get(ref, []):
                cx, cy = ring_centre(ring)
                if haversine(cy, cx, part["center"][1], part["center"][0]) < 15:
                    ring_height = part["height"]
            buildings.append({"id": ref, "name": tags.get("name"), "polygon": ring, "height": ring_height, "campus": campus_of.get(ref)})
    return buildings, sorted(set(refs) - found)


def fetch_walk_ways(bbox):
    """Every way pedestrians may use in `bbox`, as {"tags", "path": [(lon, lat), ...]}. Tags are
    fetched so the graph can tell a sidewalk from a road's centre line (pedestrian_network.py)."""
    s, w, n, e = bbox
    elements = overpass(f'[out:json][timeout:90];way["highway"~"^({WALKABLE})$"]({s},{w},{n},{e});(._;>;);out body qt;')
    coords = {el["id"]: (el["lon"], el["lat"]) for el in elements if el["type"] == "node"}
    ways = []
    for el in elements:
        if el["type"] == "way":
            path = [coords[nid] for nid in el["nodes"] if nid in coords]
            if len(path) >= 2:
                ways.append({"tags": el.get("tags", {}), "path": path})
    return ways


def network_bbox(campus):
    """A campus's bbox grown by the stop margin: riders from a stop just outside it (St. Mary's
    Street on Beacon St) walk the real sidewalks there, not whatever stub the bbox edge cut off."""
    s, w, n, e = campus["bbox"]
    m = STOP_CAMPUS_MARGIN
    return [round(s - m, 6), round(w - m, 6), round(n + m, 6), round(e + m, 6)]


def walk_network(bbox):
    """The connected pedestrian graph for `bbox` (its largest component)."""
    network = pedestrian_network.Network()
    for way in fetch_walk_ways(bbox):
        network.add_way(way["tags"], way["path"])
    component = network.largest_component()
    if not component:
        sys.exit("Walk network is empty; check the campus bbox")
    network.keep(component)
    return network


def fetch_building_doors(refs):
    """{ref: {"street": its addr:street, "entrances": [(kind, (lon, lat))]}} for location buildings,
    entrances being OSM entrance=* nodes on the footprint (garages and fire exits left out)."""
    ways = ",".join(r.split("/")[1] for r in refs if r.startswith("way/"))
    rels = ",".join(r.split("/")[1] for r in refs if r.startswith("relation/"))
    parts = (f"way(id:{ways});" if ways else "") + (f"relation(id:{rels});" if rels else "")
    if not parts:
        return {}
    buildings = overpass(f"[out:json][timeout:60];({parts});out geom;")  # fetch_footprints' query
    entrances = overpass(f"[out:json][timeout:60];({parts})->.b;(way(r.b);way.b;)->.w;node(w.w)[entrance];out body qt;")
    doors = {}
    for el in buildings:
        geometry = el.get("geometry") or [p for m in el.get("members", []) for p in m.get("geometry", [])]
        outline = {(round(p["lon"], 6), round(p["lat"], 6)) for p in geometry}
        found = [
            (e["tags"]["entrance"], (e["lon"], e["lat"])) for e in entrances
            if (round(e["lon"], 6), round(e["lat"], 6)) in outline and e["tags"]["entrance"] in DOOR_ENTRANCES
        ]
        doors[f"{el['type']}/{el['id']}"] = {"street": el.get("tags", {}).get("addr:street"), "entrances": found}
    return doors


def door_point(network, loc, building):
    """Where a building's walkers come and go: its main OSM entrance; else the sidewalk between the
    building and the street it's addressed on (Warren Towers' door is on Comm Ave, not the back
    alley); else the building itself."""
    here = (loc["lon"], loc["lat"])
    if building and building["entrances"]:
        kind, point = min(building["entrances"], key=lambda e: (e[0] != "main", pedestrian_network.distance(here, e[1])))
        return point
    street = building and building["street"]
    if street:
        on_street = network.nearest_edge(here, lambda info: info["road"] is not None and info["name"] == street)
        if on_street and on_street[0] <= SNAP_WARN_METRES:
            sidewalks = network.crossings(here, on_street[3], pedestrian_network.is_door)
            if sidewalks:
                return sidewalks[-1]  # the last footway before the kerb: this side's sidewalk
    return here


def attach_location(network, loc, building=None):
    """Where walkers leave and reach a building: the nearest point on a footway to its door (not the
    middle of a crosswalk, not a road's centre line), splitting that way there."""
    point = door_point(network, loc, building)
    for accept in (pedestrian_network.is_door, pedestrian_network.is_foot, lambda info: True):
        found = network.attach(point, accept, SNAP_WARN_METRES)
        if found:
            break
    else:
        found = network.attach(point)
    node, gap = found
    if gap > SNAP_WARN_METRES:
        warn(f"{loc['id']} is {gap:.0f} m from the walk network; is it inside its campus bbox?")
    if not any(info["foot"] for _, _, info, _ in network.adj[node].values()):
        warn(f"{loc['id']} joins the walk network on a road ({gap:.0f} m away); no footway near it")
    return node


def route_between(network, prev, src_node, dst_node):
    """(path, cumulative metres) from src_node to dst_node, given a cheapest-path tree from src_node."""
    node, nodes = dst_node, [dst_node]
    while node != src_node:
        node = prev[node]
        nodes.append(node)
    nodes.reverse()
    path = network.route_geometry(nodes)  # both places at one door (a library inside a classroom) -> 2 points
    return path, pedestrian_network.cumulative(path)


def build_routes(network, locations, doors):
    """Cheapest walk (sidewalks over roads, see pedestrian_network.py) between every pair of one
    campus's locations, and each location's door node. Places in one building share its door."""
    by_building, snapped = {}, {}
    for loc in locations:
        if loc["osm"] not in by_building:
            by_building[loc["osm"]] = attach_location(network, loc, doors.get(loc["osm"]))
        snapped[loc["id"]] = by_building[loc["osm"]]
    routes = {}
    for src_id, src_node in snapped.items():
        _, prev = network.shortest(src_node)
        for dst_id, dst_node in snapped.items():
            if dst_id != src_id:
                routes[(src_id, dst_id)] = route_between(network, prev, src_node, dst_node)
    return routes, snapped


CLASS_MINUTES = 50
GAP_FILL_MINUTES = 60  # a free gap at least this long gets filled (library, food or home)


def plan_day(rng, by_kind):
    """A rough MWF day as (location_id, start_minute, end_minute) stops, home first and last.

    Classes, meals, study and the gym have real end times, so people leave when class lets out
    instead of sitting in the classroom until their next stop. Long gaps get filled the way
    students fill them: the library, a dining hall or back home. Places are picked in proportion
    to their real capacity, so big buildings draw big crowds. Kinds the campus doesn't have are
    skipped. With no dorm, the agent "lives" at a classroom building and the day simply ends
    after its last stop (no trip home)."""

    def pick(kind):
        if kind not in by_kind:
            return None
        ids, weights = by_kind[kind]
        return rng.choices(ids, weights=weights)[0]

    has_dorm = "dorm" in by_kind
    home = pick("dorm") or pick("classroom") or pick(next(iter(by_kind)))

    planned = []  # (location, start, end)
    for slot in sorted(rng.sample(MWF_SLOTS, rng.randint(2, 4))):
        planned.append((pick("classroom"), slot, slot + CLASS_MINUTES))
    lunch = rng.randint(11 * 60 + 30, 13 * 60 + 45)
    planned.append((pick("dining"), lunch, lunch + rng.randint(25, 50)))
    if rng.random() < 0.55:
        study = rng.randint(14 * 60, 19 * 60)
        planned.append((pick("library"), study, study + rng.randint(60, 150)))
    if rng.random() < 0.25:
        workout = rng.randint(16 * 60, 20 * 60)
        planned.append((pick("gym"), workout, workout + rng.randint(45, 90)))
    dinner = rng.randint(17 * 60 + 30, 19 * 60 + 30)
    planned.append((pick("dining"), dinner, dinner + rng.randint(30, 60)))

    # Drop anything a kind the campus lacks, and anything that overlaps an earlier stop.
    day = []
    for loc, begin, finish in sorted((p for p in planned if p[0] is not None), key=lambda p: p[1]):
        if day and begin < day[-1][2] + 10:
            continue
        day.append((loc, begin, finish))

    # Fill long gaps between stops.
    filled = []
    for i, stop in enumerate(day):
        filled.append(stop)
        if i + 1 == len(day):
            break
        gap_start, gap_end = stop[2] + 10, day[i + 1][1] - 15
        if gap_end - gap_start < GAP_FILL_MINUTES:
            continue
        roll = rng.random()
        filler = (pick("library") if roll < 0.5 else pick("dining") if roll < 0.7 else home if has_dorm else None)
        if filler:
            filled.append((filler, gap_start, gap_end))

    day_start = filled[0][1] - 30 if filled else 8 * 60
    stops = [(home, 0, day_start)] + filled
    if has_dorm:
        evening = max(stops[-1][2] + 10, rng.randint(20 * 60, 22 * 60))
        stops.append((home, evening, 24 * 60))
    return home, stops


def occupancy_timeline(agents, trips, step=300):
    """Head count per location every `step` seconds from 6 AM to midnight."""
    by_agent = {}
    for t in trips:
        by_agent.setdefault(t["agent"], []).append(t)
    for v in by_agent.values():
        v.sort(key=lambda t: t["timestamps"][0])
    for now in range(6 * 3600, 24 * 3600, step):
        counts = {}
        for agent in agents:
            where = agent["home"]
            for trip in by_agent.get(agent["id"], []):
                if trip["timestamps"][0] > now:
                    break
                where = None if now < trip["timestamps"][-1] else trip["to"]
            if where:
                counts[where] = counts.get(where, 0) + 1
        yield counts


def simulate_campus(rng, campus, agent_count, first_index, building_doors):
    """Agents, trips, scaled locations and the walk routes used, for one campus."""
    print(f"Fetching {campus['name']} walk network from OpenStreetMap...", file=sys.stderr)
    network = walk_network(network_bbox(campus))
    print(f"  {len(network.adj)} nodes", file=sys.stderr)
    routes, doors = build_routes(network, campus["locations"], building_doors)
    NETWORKS[campus["id"]] = (network, doors)  # stop_routes() routes riders on the same graph

    by_kind = {}
    for loc in campus["locations"]:
        ids, weights = by_kind.setdefault(loc["kind"], ([], []))
        ids.append(loc["id"])
        weights.append(max(1, loc["capacity"]))

    agents, trips, used_routes = [], [], {}
    for i in range(first_index, first_index + agent_count):
        agent_id = f"a{i:04d}"
        speed = rng.uniform(1.1, 1.5)  # metres per second
        home, stops = plan_day(rng, by_kind)
        agents.append({"id": agent_id, "home": home, "model": rng.randrange(12), "campus": campus["id"]})
        here, free_at = home, stops[0][2] * 60
        for dest, arrive_by, leave_at in stops[1:]:
            if dest == here:
                free_at = leave_at * 60
                continue
            path, cumulative = routes[(here, dest)]
            duration = cumulative[-1] / speed
            # Leave once the last stop is over (a few minutes late, like people do), early
            # enough to make the next one.
            depart = max(free_at + rng.uniform(0, 300), arrive_by * 60 - duration - rng.uniform(60, 600))
            trips.append({
                "agent": agent_id,
                "from": here,
                "to": dest,
                "depart": round(depart, 1),
                "speed": round(speed, 3),
                # Full timestamps are only for calibration below; the file stores depart + speed
                # and the shared route, and the map rebuilds these.
                "timestamps": [depart + c / speed for c in cumulative],
            })
            used_routes[f"{here}>{dest}"] = {"path": path, "cumulative": cumulative}
            here, free_at = dest, max(depart + duration + 10 * 60, leave_at * 60)

    # Calibrate: each kind's capacity is sized so its busiest simulated moment is TARGET_PEAK
    # full, then split across buildings by their real-world size. Without this, fixed guesses
    # left dining halls at 200% at dinner and libraries at 170% in the late afternoon.
    kind_of = {loc["id"]: loc["kind"] for loc in campus["locations"]}
    kind_peak, loc_peak = {}, {}
    for counts in occupancy_timeline(agents, trips):
        per_kind = {}
        for loc_id, n in counts.items():
            per_kind[kind_of[loc_id]] = per_kind.get(kind_of[loc_id], 0) + n
            loc_peak[loc_id] = max(loc_peak.get(loc_id, 0), n)
        for kind, n in per_kind.items():
            kind_peak[kind] = max(kind_peak.get(kind, 0), n)

    locations = []
    for loc in campus["locations"]:
        kind_total = sum(by_kind[loc["kind"]][1])
        share_of_kind = max(1, loc["capacity"]) / kind_total
        capacity = round(kind_peak.get(loc["kind"], 1) * share_of_kind / TARGET_PEAK)
        # With only ~40 agents on a small campus, chance pile-ups can overfill a small building;
        # cap that at MAX_PEAK so "Packed" stays believable.
        capacity = max(5, capacity, round(loc_peak.get(loc["id"], 0) / MAX_PEAK))
        locations.append({
            "id": loc["id"], "name": loc["name"], "short": loc["short"], "kind": loc["kind"],
            "position": [loc["lon"], loc["lat"]], "capacity": capacity, "building": loc["osm"], "campus": campus["id"],
        })
    return agents, trips, locations, used_routes


def transloc_stops():
    """BU Shuttle stops from TransLoc, as {id, name, position}, for every route BU shows on its map.

    The map fetches these at runtime (src/transit/buShuttle.ts) and keeps only the routes running
    at that moment; here we keep all of them (day, Night, ...) so a stop has routes whenever it's
    served. Ids match the map's ("BU-stop-<AddressID>"). Cached so the pipeline runs offline."""
    try:
        req = urllib.request.Request(TRANSLOC_ROUTES, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            routes = json.load(resp)
        TRANSLOC_CACHE.parent.mkdir(parents=True, exist_ok=True)
        TRANSLOC_CACHE.write_text(json.dumps(routes))
    except (urllib.error.URLError, OSError, ValueError) as err:
        if not TRANSLOC_CACHE.exists():
            warn(f"BU Shuttle stops unavailable ({err}); no shuttle stop routes")
            return []
        warn(f"BU Shuttle feed unavailable ({err}); using the cached copy")
        routes = json.loads(TRANSLOC_CACHE.read_text())
    stops = {}
    for route in routes:
        if not route.get("IsVisibleOnMap"):
            continue
        for st in route.get("Stops") or []:
            stop_id = f"BU-stop-{st['AddressID']}"
            stops.setdefault(stop_id, {"id": stop_id, "name": st["Description"].strip(), "position": [st["Longitude"], st["Latitude"]]})
    return list(stops.values())


def transit_stops():
    """Every stop a rider can get off at: Green Line stations and bus stops from transit.json
    (written by fetch_transit.py), plus BU Shuttle stops."""
    stops = []
    if TRANSIT_JSON.exists():
        for st in json.loads(TRANSIT_JSON.read_text())["stops"]:
            if st["id"] not in UNDERGROUND_STOPS:
                stops.append({"id": st["id"], "name": st["name"], "position": st["position"]})
    else:
        warn(f"{TRANSIT_JSON} missing (run fetch_transit.py); no MBTA stop routes")
    return stops + transloc_stops()


def stop_routes(campus, stops):
    """Candidate walks from each transit stop near this campus to its locations, as
    {stop_id: [(metres, "stopId>locationId", route)]}, nearest first, route in the same compact
    form as walkRoutes. Each path starts at the stop itself, then joins the walk network on its
    nearest footway, on the graph and doors the campus's walkers use."""
    s, w, n, e = campus["bbox"]
    m = STOP_CAMPUS_MARGIN
    near = [st for st in stops if s - m <= st["position"][1] <= n + m and w - m <= st["position"][0] <= e + m]
    if not near:
        return {}
    network, loc_nodes = NETWORKS[campus["id"]]

    routes = {}
    for stop in near:
        lon, lat = stop["position"]
        # Platforms in Comm Ave's median join on its crosswalks and islands, so any footway will do.
        found = network.attach((lon, lat), pedestrian_network.is_foot, STOP_SNAP_MAX_METRES) \
            or network.attach((lon, lat), lambda info: True, STOP_SNAP_MAX_METRES)
        if not found:
            gap = network.nearest_edge((lon, lat))[0]
            warn(f"stop {stop['id']} ({stop['name']}) is {gap:.0f} m from the {campus['id']} walk network; skipped")
            continue
        start, _ = found
        cost, prev = network.shortest(start)
        reachable = sorted((cost[node], loc_id) for loc_id, node in loc_nodes.items() if node in cost)
        for _, loc_id in reachable[:STOP_ROUTES_PER_STOP]:
            walk, _ = route_between(network, prev, start, loc_nodes[loc_id])
            path = [[round(lon, 6), round(lat, 6)]] + walk
            route = {"path": path, "cumulative": pedestrian_network.cumulative(path)}
            routes.setdefault(stop["id"], []).append((route["cumulative"][-1], f"{stop['id']}>{loc_id}", route))
    return routes


def main():
    rng = random.Random(SEED)
    campuses = load_campuses()
    counts = split_agents(campuses, AGENT_COUNT)

    agents, trips, locations, walk_routes = [], [], [], {}
    building_doors = fetch_building_doors(sorted({loc["osm"] for c in campuses for loc in c["locations"]}))
    for campus in campuses:
        a, t, l, r = simulate_campus(rng, campus, counts[campus["id"]], len(agents), building_doors)
        agents += a
        trips += t
        locations += l
        walk_routes.update(r)

    print("Fetching building footprints...", file=sys.stderr)
    all_locs = [loc for c in campuses for loc in c["locations"]]
    heights = {loc["osm"]: loc["height"] for loc in all_locs if loc.get("height")}
    campus_of = {loc["osm"]: loc["campus"] for loc in all_locs}
    part_heights = {loc["osm"]: loc["partHeights"] for loc in all_locs if loc.get("partHeights")}
    buildings, unresolved = fetch_footprints(sorted(campus_of), heights, campus_of, part_heights)
    for ref in unresolved:
        users = ", ".join(loc["id"] for loc in all_locs if loc["osm"] == ref)
        warn(f"footprint {ref} not found in OSM (used by {users}); it won't be drawn")

    campus_out = []
    for c in campuses:
        locs = c["locations"]
        center = [round(sum(l["lon"] for l in locs) / len(locs), 6), round(sum(l["lat"] for l in locs) / len(locs), 6)]
        campus_out.append({"id": c["id"], "name": c["name"], "bbox": c["bbox"], "center": center})

    # After the day is planned and uses no randomness, so walkers and trips are unchanged.
    print("Routing riders from transit stops...", file=sys.stderr)
    stops = transit_stops()
    candidates = {}
    for c in campuses:
        for stop_id, found in stop_routes(c, stops).items():
            candidates.setdefault(stop_id, []).extend(found)
    # A stop between two campuses (Fenway station) keeps whichever campus's buildings are nearest.
    rider_routes = {}
    for found in candidates.values():
        found.sort(key=lambda f: f[0])
        for metres, key, route in found[:STOP_ROUTES_PER_STOP]:
            if metres <= STOP_ROUTE_MAX_METRES:
                rider_routes[key] = route

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "day": "Wednesday",
        "campuses": campus_out,
        "buildings": buildings,
        "locations": locations,
        "agents": agents,
        # Each walk route once ("from>to": points + metres along them); a trip is just who,
        # where, when they leave and how fast they walk. Timestamps = depart + metres / speed.
        "walkRoutes": walk_routes,
        "trips": [{k: t[k] for k in ("agent", "from", "to", "depart", "speed")} for t in trips],
        # Walks from transit stops to nearby locations ("stopId>locationId"), same form as walkRoutes.
        "stopRoutes": dict(sorted(rider_routes.items())),
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
    stops_routed = len({key.split(">")[0] for key in rider_routes})
    print(f"  {len(rider_routes)} stop routes from {stops_routed} transit stops; {OUT.stat().st_size / 1e6:.2f} MB", file=sys.stderr)
    if unresolved:
        print(f"  {len(unresolved)} footprint(s) unresolved: {', '.join(unresolved)}", file=sys.stderr)


if __name__ == "__main__":
    main()
