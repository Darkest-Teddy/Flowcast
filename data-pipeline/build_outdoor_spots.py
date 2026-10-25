"""Outdoor free-time destinations by the Charles: BU Beach, the Charles River Reservation lawns and
the Dr. Paul Dudley White Path, with walking connectors from nearby campus locations.

Writes map-client/public/data/outdoor.json, read by the behaviour engine (map-client/src/sim/
sourceDay.ts, conditions engine hook) and drawn by map-client/src/layers/outdoor.ts.

Everything is local: green spaces come from the saved OpenStreetMap extract (snapshots/osm/
bridge.osm.gz) and connectors follow the same sidewalk-aware pedestrian network as the campus walk
routes (make_demo_routes.walk_network / pedestrian_network.py, from .cache/overpass), which
includes the river path (a cycleway with designated foot access). Storrow Drive is a motorway and
not walkable, so connectors reach the river only over grade-separated crossings such as the BU
Beach footbridge (OSM way 114011284). Every connector starts exactly at a location's saved
walk-route endpoint (a node of the same network) so the client can join them, and every point stays
on the Boston bank.

    python3 data-pipeline/build_outdoor_spots.py
"""

import argparse
import gzip
import heapq
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SNAPSHOTS = HERE / "snapshots" / "osm"
OUTPUT = ROOT / "map-client" / "public" / "data" / "outdoor.json"
DAY_FILE = ROOT / "map-client" / "public" / "data" / "demo-day.json"
PATH_NAME = "Dr. Paul Dudley White Path"
CONNECTORS_PER_SPOT = 10
MAX_CONNECTOR_METRES = 1800
# Lawns by the river (OSM ids in snapshots/osm/bridge.osm.gz). Names are descriptive; only BU Beach is named in OSM.
LAWNS = [
    {"id": "outdoor:bu-beach", "way": 242274262, "kind": "lawn", "name": "BU Beach",
     "note": "Lawn between Marsh Plaza's buildings and Storrow Drive; students sit and study on the grass."},
    {"id": "outdoor:reservation-lawn", "way": 826798498, "kind": "riverside", "name": "Charles River Reservation lawn",
     "note": "The large riverbank lawn between Storrow Drive and the water west of the BU Beach footbridge; sitting by the river."},
    {"id": "outdoor:bu-bridge-lawn", "way": 826798494, "kind": "riverside", "name": "Riverbank lawn by the BU Bridge",
     "note": "Grass by the river path just east of the BU Bridge."},
]
LOOP = {"id": "outdoor:river-path", "kind": "loop", "name": "Dr. Paul Dudley White Path",
        "note": "Walks and runs along the river path on the Boston bank: west from the BU Beach footbridge toward the BU Bridge and back, then east and back.",
        "max_reach": 1300, "landing": (-71.106737, 42.3515963)}
RIVER_FILE = ROOT / "map-client" / "public" / "data" / "river.json"


def boston_side(point, river):
    """South of the river's southern edge at that longitude. The Charles runs west to east past BU,
    so the Boston bank (Esplanade, Charles River Reservation) is south of the water; Cambridge is north."""
    lat, lon = point
    for polygon in river:
        crossings = []
        for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]):
            if (x1 - lon) * (x2 - lon) <= 0 and x1 != x2:
                crossings.append(y1 + (lon - x1) / (x2 - x1) * (y2 - y1))
        if crossings and lat >= min(crossings) + 0.00005:
            return False
    return True


def haversine(a, b):
    (lat1, lon1), (lat2, lon2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def dijkstra(graph, source):
    dist, prev, heap = {source: 0.0}, {}, [(0.0, source)]
    while heap:
        d, node = heapq.heappop(heap)
        if d > dist[node]:
            continue
        for nxt, w in graph.get(node, ()):
            if d + w < dist.get(nxt, math.inf):
                dist[nxt], prev[nxt] = d + w, node
                heapq.heappush(heap, (d + w, nxt))
    return dist, prev


def walk_back(prev, source, target):
    nodes = [target]
    while nodes[-1] != source:
        nodes.append(prev[nodes[-1]])
    return nodes[::-1]


def osm_polygons(path, ids):
    root = ET.parse(gzip.open(path)).getroot()
    nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.iter("node")}
    out = {}
    for way in root.iter("way"):
        if int(way.get("id")) in ids:
            out[int(way.get("id"))] = [nodes[nd.get("ref")] for nd in way.iter("nd")]
    return out


def build(network, polygons, day, river):
    import pedestrian_network as pn
    bank = lambda node: boston_side((node[1], node[0]), river)
    on_path = lambda info: info["name"] == PATH_NAME
    campus_of = {loc["id"]: loc.get("campus", "charles-river") for loc in day["locations"]}
    # Each Charles River location's saved walk endpoint, as a node of this network (exactly there).
    anchors = {}
    for name, route in sorted(day.get("walkRoutes", {}).items()):
        origin = name.split(">")[0]
        if origin in anchors or campus_of.get(origin) != "charles-river":
            continue
        found = network.attach(tuple(route["path"][0]), exact=True)
        if found:
            anchors[origin] = found[0]

    def connectors(entry):
        _, prev = network.shortest(entry)
        ranked = sorted((pn.distance(entry, node), loc) for loc, node in anchors.items() if node in prev or node == entry)
        out = []
        for _, loc in ranked:
            nodes = walk_back(prev, entry, anchors[loc])[::-1]  # anchor → entry
            path = network.route_geometry(nodes)
            metres = pn.cumulative(path)
            if metres[-1] > MAX_CONNECTOR_METRES or not all(bank(tuple(point)) for point in path):
                continue
            out.append({"location": loc, "path": [[round(x, 6), round(y, 6)] for x, y in path], "cumulative": [round(m, 2) for m in metres]})
            if len(out) >= CONNECTORS_PER_SPOT:
                break
        return sorted(out, key=lambda row: row["cumulative"][-1])

    spots = []
    for lawn in LAWNS:
        polygon = polygons[lawn["way"]]
        if not all(boston_side(point, river) for point in polygon):
            sys.exit(f"{lawn['name']} is not on the Boston bank")
        centre = (sum(p[1] for p in polygon) / len(polygon), sum(p[0] for p in polygon) / len(polygon))  # (lon, lat)
        # Lawns by the river are entered from the river path itself; BU Beach from its own footpaths.
        found = network.attach(centre, on_path if lawn["kind"] == "riverside" else pn.is_foot, 120)
        if not found or not bank(found[0]):
            sys.exit(f"No walkable entry beside {lawn['name']}")
        entry = found[0]
        links = connectors(entry)
        if not links:
            sys.exit(f"No walk connects campus to {lawn['name']}")
        area = abs(sum((b[1] - a[1]) * (a[0] + b[0]) for a, b in zip(polygon, polygon[1:] + polygon[:1]))) / 2 * 111320 * math.cos(math.radians(42.35)) * 110540
        spots.append({"id": lawn["id"], "kind": lawn["kind"], "name": lawn["name"], "campus": "charles-river",
                      "position": [round(centre[0], 6), round(centre[1], 6)], "entry": [round(entry[0], 6), round(entry[1], 6)],
                      "polygon": [[round(lon, 6), round(lat, 6)] for lat, lon in polygon], "areaSquareMetres": round(area),
                      "source": f"https://www.openstreetmap.org/way/{lawn['way']}", "note": lawn["note"], "connectors": links})

    # The loop starts where the BU Beach footbridge reaches the river path and stays on the river
    # path's Boston-bank stretch connected to it, out to about 1.3 km either way.
    landing = network.attach(LOOP["landing"], on_path, 60)
    if not landing or not bank(landing[0]):
        sys.exit("The footbridge does not reach the river path")
    landing = landing[0]
    graph = {}
    for a, neighbours in network.adj.items():
        for b, (length, _, info, _) in neighbours.items():
            if on_path(info) and bank(a) and bank(b):
                graph.setdefault(a, []).append((b, length))
    along, prev = dijkstra(graph, landing)
    near = [n for n in along if along[n] <= LOOP["max_reach"]]
    west, east = min(near, key=lambda n: n[0]), max(near, key=lambda n: n[0])
    out_west, out_east = walk_back(prev, landing, west), walk_back(prev, landing, east)
    print(f"  loop: landing {landing}, west {west} ({along[west]:.0f} m), east {east} ({along[east]:.0f} m)")
    loop_nodes = out_west + out_west[::-1][1:] + out_east[1:] + out_east[::-1][1:]
    loop_path = network.route_geometry(loop_nodes)
    loop = {"path": [[round(x, 6), round(y, 6)] for x, y in loop_path], "cumulative": [round(m, 2) for m in pn.cumulative(loop_path)]}
    spots.append({"id": LOOP["id"], "kind": "loop", "name": LOOP["name"], "campus": "charles-river",
                  "position": [round(landing[0], 6), round(landing[1], 6)], "entry": [round(landing[0], 6), round(landing[1], 6)],
                  "loop": loop, "source": "https://www.openstreetmap.org/way/1115824699", "note": LOOP["note"], "connectors": connectors(landing)})
    return {
        "schemaVersion": 1,
        "description": "Outdoor free-time destinations by the Charles River and walking connectors from campus locations. Built by data-pipeline/build_outdoor_spots.py.",
        "attribution": "© OpenStreetMap contributors, ODbL 1.0",
        "crossings": "Storrow Drive (a motorway) is not walkable; the river is reached over the BU Beach footbridge (OSM way 114011284) and other grade-separated paths in the network.",
        "spots": spots,
    }


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    sys.path.insert(0, str(HERE))
    import make_demo_routes as routes
    campus = next(c for c in routes.load_campuses() if c["id"] == "charles-river")
    network = routes.walk_network(routes.network_bbox(campus))
    polygons = osm_polygons(SNAPSHOTS / "bridge.osm.gz", {lawn["way"] for lawn in LAWNS})
    river = [[tuple(p) for p in row["polygon"]] for row in json.loads(RIVER_FILE.read_text())["polygons"]]
    result = build(network, polygons, json.loads(DAY_FILE.read_text()), river)
    OUTPUT.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    for spot in result["spots"]:
        size = f"loop {spot['loop']['cumulative'][-1]:.0f} m" if spot["kind"] == "loop" else f"{spot['areaSquareMetres']} m²"
        first = spot["connectors"][0]
        print(f"{spot['id']}: {len(spot['connectors'])} connectors, nearest {first['location']} {first['cumulative'][-1]:.0f} m; {size}")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
