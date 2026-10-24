"""Build the Boston Fire Department response network for the map client's fire alarms.

Fetches from OpenStreetMap (Overpass, cached in data-pipeline/.cache/overpass like
fetch_bikes.py):
  * the BFD firehouses near BU (`amenity=fire_station`), matched to the companies quartered there
    (Boston.gov "Fire department phone numbers and locations", checked October 2026);
  * the driveable street network (`highway` motorway..residential, links, living streets and
    public service roads) with one-way handling, truck restrictions (`hgv=no`, low `maxheight`,
    so Storrow Drive's underpasses are out) and `highway=traffic_signals` nodes;
  * fire hydrants (`emergency=fire_hydrant`) within reach of BU buildings, where the first engine
    pulls up.

The client routes at dispatch time (src/sim/fireResponse.ts), so the file is a compact graph,
not a route table. To keep it small the graph is pruned to the streets near BU buildings plus
every street on a quickest path between a firehouse and one of them, in either direction: a
quickest path that lies inside the pruned graph is still the quickest there, so routing on it
gives the same answers as on the full network.

Writes map-client/public/data/fire-response.json:
    { "source", "stations": [{ "id", "name", "address", "position": [lng, lat],
                               "units": [{ "id", "kind": "engine" | "ladder" | "chief", "name" }] }],
      "nodes": [lng, lat, lng, lat, ...] (1e-6 degrees, delta-encoded integers),
      "signals": [node index, ...],
      "edges": [from, to, class, flags, ...] (flags: 1 = one-way from -> to, lanes << 1),
      "classes": [highway class names], "hydrants": [[lng, lat], ...] }

Standard library only:
    python3 data-pipeline/fetch_fire_response.py
"""

import heapq
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from fetch_bikes import haversine, largest_strong_component, overpass, reverse

HERE = Path(__file__).resolve().parent
DAY_FILE = HERE.parent / "map-client" / "public" / "data" / "demo-day.json"
OUT = HERE.parent / "map-client" / "public" / "data" / "fire-response.json"

# South, west, north, east: BU's three campuses plus the firehouses that would answer them.
BBOX = (42.3250, -71.1600, 42.3640, -71.0600)
NEAR_BUILDING_M = 150  # streets this close to a BU building are kept whole (kerb snapping)
HYDRANT_M = 120

# Companies by OSM firehouse (Boston.gov list; OSM names agree). District chiefs ride in their own
# car from the district's headquarters house.
STATIONS = {
    "node/257494439": ("e33", "Engine 33 / Ladder 15", "941 Boylston St, Back Bay",
                       [("E33", "engine", "Engine 33"), ("L15", "ladder", "Ladder 15")]),
    "way/29650737": ("e7", "Engine 7 / Tower Ladder 17 / District 4", "200 Columbus Ave, Back Bay",
                     [("E7", "engine", "Engine 7"), ("TL17", "ladder", "Tower Ladder 17"), ("D4", "chief", "District 4 Chief")]),
    "node/257494865": ("e22", "Engine 22", "700 Tremont St, South End", [("E22", "engine", "Engine 22")]),
    "way/29650833": ("e3", "Engine 3", "618 Harrison Ave, South End", [("E3", "engine", "Engine 3")]),
    "node/257494464": ("e37", "Engine 37 / Ladder 26", "560 Huntington Ave, Mission Hill",
                       [("E37", "engine", "Engine 37"), ("L26", "ladder", "Ladder 26")]),
    "way/510704766": ("e14", "Engine 14 / Ladder 4", "174 Dudley St, Roxbury",
                      [("E14", "engine", "Engine 14"), ("L4", "ladder", "Ladder 4")]),
    "way/29632136": ("e41", "Engine 41 / Ladder 14", "460 Cambridge St, Allston",
                     [("E41", "engine", "Engine 41"), ("L14", "ladder", "Ladder 14")]),
    "node/257495214": ("e29", "Engine 29 / Ladder 11 / District 11", "138 Chestnut Hill Ave, Brighton",
                       [("E29", "engine", "Engine 29"), ("L11", "ladder", "Ladder 11"), ("D11", "chief", "District 11 Chief")]),
}

CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
           "living_street", "service", "link"]
# Emergency running speeds (m/s) for pruning; the client applies the same table.
SPEED = {"motorway": 18, "trunk": 15, "primary": 13, "secondary": 12, "tertiary": 11, "unclassified": 9,
         "residential": 8, "living_street": 5, "service": 5, "link": 9}
SIGNAL_PENALTY_S = 4
DRIVE_HIGHWAYS = "|".join(c for c in CLASSES if c != "link") + "|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
NO_SERVICE = {"parking_aisle", "drive-through", "emergency_access_no"}
MIN_CLEARANCE_M = 3.9  # an aerial ladder is ~3.5 m tall


def metres(value):
    """OSM maxheight ('3.2', '10\\'6"', '3.2 m') in metres, or None."""
    value = (value or "").strip().lower()
    try:
        if "'" in value:
            feet, _, rest = value.partition("'")
            inches = rest.replace('"', "").strip() or "0"
            return float(feet) * 0.3048 + float(inches) * 0.0254
        return float(value.replace("m", "").strip())
    except ValueError:
        return None


def drivable(tags):
    if tags.get("area") == "yes" or tags.get("highway") not in DRIVE_HIGHWAYS.split("|"):
        return False
    if tags.get("emergency") in ("yes", "designated"):
        return True
    if tags.get("access") in ("no", "private") or tags.get("motor_vehicle") in ("no", "private") or tags.get("motorcar") == "no":
        return False
    if tags.get("hgv") == "no":
        return False
    clearance = metres(tags.get("maxheight"))
    if clearance is not None and clearance < MIN_CLEARANCE_M:
        return False
    return not (tags.get("highway") == "service" and tags.get("service") in NO_SERVICE)


def road_class(tags):
    hw = tags["highway"]
    return "link" if hw.endswith("_link") else hw


def directions(tags):
    oneway = tags.get("oneway")
    if oneway in ("yes", "1", "true") or (oneway is None and (tags.get("junction") == "roundabout" or tags.get("highway") == "motorway")):
        return True, False
    if oneway == "-1":
        return False, True
    return True, True


def lanes(tags):
    try:
        return max(0, min(7, int(str(tags.get("lanes", "0")).split(";")[0])))
    except ValueError:
        return 0


def dijkstra(graph, sources):
    """{node: previous node} for the quickest paths from any source."""
    cost, prev = {s: 0.0 for s in sources}, {}
    heap = [(0.0, s) for s in sources]
    while heap:
        c, node = heapq.heappop(heap)
        if c > cost[node]:
            continue
        for nxt, w in graph.get(node, ()):
            if c + w < cost.get(nxt, math.inf):
                cost[nxt], prev[nxt] = c + w, node
                heapq.heappush(heap, (c + w, nxt))
    return prev


def main():
    s, w, n, e = BBOX
    box = f"({s},{w},{n},{e})"
    print("Fetching firehouses, streets and hydrants from OpenStreetMap...", file=sys.stderr)
    stations_raw = overpass(f'[out:json][timeout:120];nwr["amenity"="fire_station"]{box};out center tags;')
    streets = overpass(f'[out:json][timeout:180];way["highway"~"^({DRIVE_HIGHWAYS})$"]{box};(._;>;);out body qt;')
    hydrants_raw = overpass(f'[out:json][timeout:120];node["emergency"="fire_hydrant"]{box};out;')

    day = json.loads(DAY_FILE.read_text())
    building_points = [tuple(p) for b in day["buildings"] for p in b["polygon"]]

    coords = {el["id"]: (el["lat"], el["lon"]) for el in streets if el["type"] == "node"}
    signal_nodes = {el["id"] for el in streets if el["type"] == "node" and el.get("tags", {}).get("highway") == "traffic_signals"}
    edges = {}  # (a, b) -> (class, oneway, lanes); two-way edges stored once
    graph = defaultdict(list)
    for el in streets:
        if el["type"] != "way" or not drivable(el.get("tags", {})):
            continue
        tags = el["tags"]
        cls = road_class(tags)
        forward, backward = directions(tags)
        nodes = [x for x in el["nodes"] if x in coords]
        for a, b in zip(nodes, nodes[1:]):
            if a == b:
                continue
            if not forward:  # oneway=-1: store it in travel order
                a, b = b, a
            oneway = not (forward and backward)
            if (a, b) in edges or (b, a) in edges:
                continue
            edges[(a, b)] = (cls, oneway, lanes(tags))
            t = haversine(*coords[a], *coords[b]) / SPEED[cls] + (SIGNAL_PENALTY_S if b in signal_nodes else 0)
            graph[a].append((b, t))
            if not oneway:
                graph[b].append((a, t + (SIGNAL_PENALTY_S if a in signal_nodes else 0) - (SIGNAL_PENALTY_S if b in signal_nodes else 0)))
    graph = dict(graph)
    rgraph_full = defaultdict(list)
    for a, out in graph.items():
        for b, t in out:
            rgraph_full[b].append((a, t))
    component = largest_strong_component({a: [(b, t, 0) for b, t in out] for a, out in graph.items()},
                                         {b: [(a, t, 0) for a, t in out] for b, out in rgraph_full.items()})
    graph = {a: [(b, t) for b, t in out if b in component] for a, out in graph.items() if a in component}
    rgraph = defaultdict(list)
    for a, out in graph.items():
        for b, t in out:
            rgraph[b].append((a, t))
    print(f"  {len(edges)} street segments, {len(component)} routable nodes", file=sys.stderr)

    # Near-building nodes: their streets are kept whole so any kerb next to a building is there.
    cell = 0.002
    grid = defaultdict(list)
    for lng, lat in building_points:
        grid[(int(lat // cell), int(lng // cell))].append((lat, lng))

    def near_building(node, limit=NEAR_BUILDING_M):
        lat, lng = coords[node]
        ci, cj = int(lat // cell), int(lng // cell)
        return any(haversine(lat, lng, *p) <= limit for i in (ci - 1, ci, ci + 1) for j in (cj - 1, cj, cj + 1) for p in grid.get((i, j), ()))

    local = {node for node in component if near_building(node)}

    # Firehouses: OSM positions, snapped (for pruning) to the nearest routable node.
    stations = []
    for el in stations_raw:
        key = f"{el['type']}/{el['id']}"
        if key not in STATIONS:
            continue
        sid, name, address, units = STATIONS[key]
        lat, lng = (el["center"]["lat"], el["center"]["lon"]) if "center" in el else (el["lat"], el["lon"])
        stations.append({"id": sid, "name": name, "address": address, "osm": key,
                         "position": [round(lng, 6), round(lat, 6)],
                         "units": [{"id": u, "kind": k, "name": nm} for u, k, nm in units]})
    missing = set(STATIONS) - {s["osm"] for s in stations}
    if missing:
        sys.exit(f"Firehouses missing from OpenStreetMap: {sorted(missing)}")
    keep = set(local)
    for station in stations:
        lng, lat = station["position"]
        near = sorted(component, key=lambda x: haversine(lat, lng, *coords[x]))[:6]
        keep.update(near)
        for tree, nodes in ((dijkstra(graph, near), local), (dijkstra(rgraph, near), local)):
            for target in nodes:
                node = target
                while node in tree:
                    keep.add(node)
                    node = tree[node]
                keep.add(node)
    # Whole segments only: both ends kept.
    kept_edges = [(a, b, v) for (a, b), v in edges.items() if a in keep and b in keep]
    used = sorted({x for a, b, _ in kept_edges for x in (a, b)}, key=lambda x: (coords[x][1], coords[x][0]))
    index = {node: i for i, node in enumerate(used)}

    flat, last = [], (0, 0)
    for node in used:
        lat, lng = coords[node]
        q = (round(lng * 1e6), round(lat * 1e6))
        flat += [q[0] - last[0], q[1] - last[1]]
        last = q
    edge_flat = []
    for a, b, (cls, oneway, ln) in sorted(kept_edges, key=lambda x: (index[x[0]], index[x[1]])):
        edge_flat += [index[a], index[b], CLASSES.index(cls), int(oneway) | (ln << 1)]

    hydrants = sorted(
        [round(h["lon"], 6), round(h["lat"], 6)] for h in hydrants_raw
        if any(haversine(h["lat"], h["lon"], lat, lng) <= HYDRANT_M for lng, lat in building_points[::2])
    )
    out = {
        "source": "OpenStreetMap contributors (ODbL): streets, firehouses, hydrants; companies per Boston.gov fire department locations",
        "sourceUrl": "https://www.boston.gov/departments/fire-operations/fire-department-phone-numbers-and-locations",
        "classes": CLASSES,
        "stations": [{k: v for k, v in s.items() if k != "osm"} for s in sorted(stations, key=lambda s: s["id"])],
        "nodes": flat,
        "signals": sorted(index[x] for x in signal_nodes if x in index),
        "edges": edge_flat,
        "hydrants": hydrants,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB): {len(used)} nodes, {len(kept_edges)} segments, "
          f"{len(out['signals'])} signals, {len(hydrants)} hydrants, {len(stations)} firehouses", file=sys.stderr)


if __name__ == "__main__":
    main()
