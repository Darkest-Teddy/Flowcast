"""Walks event visitors take between where they arrive and the venue's doors.

Writes map-client/public/data/event-visitor-routes.json. For each event venue on the map, its doors
(OpenStreetMap entrance=* nodes on the venue's outline, gates included) and the places visitors
arrive from: Green Line and commuter rail stations, public garages and lots near the venue, and a
rideshare drop-off on the main road. Each origin gets the cheapest pedestrian route to whichever
door is nearest it on the same sidewalk graph students walk (pedestrian_network.py, from the
Charles River Campus's cached Overpass extract), so visitors walk sidewalks and cross at crosswalks.

How many visitors use which origin is decided in the map (sim/eventAttendance.ts: mode shares by
event kind, garages by capacity); this file only fixes where they walk.
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import make_demo_routes as demo
import pedestrian_network

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "map-client" / "public" / "data"
OUT = DATA / "event-visitor-routes.json"
TRANSIT = DATA / "transit.json"
DOOR_KINDS = ("main", "yes", "gate", "entrance", "secondary")
MAX_ROUTE_METRES = 1600  # a garage or station further than this isn't how people reach the venue

# Venue outlines in OSM. Case Gym and Walter Brown Arena share the Case Physical Education Center.
VENUES = {
    "agganis": {"osm": "way/102384832", "name": "Agganis Arena"},
    "walter-brown": {"osm": "way/29904697", "name": "Walter Brown Arena", "street": "Babcock Street"},
    "case-gym": {"osm": "way/29904697", "name": "Case Gym", "street": "Babcock Street"},
    "nickerson": {"osm": "way/663514809", "name": "Nickerson Field", "street": "Harry Agganis Way"},
    "new-balance-field": {"osm": "way/1026274041", "name": "New Balance Field", "street": "Babcock Street"},
    "fenway-park": {"osm": "relation/11188464", "name": "Fenway Park"},
    "mgm-music-hall": {"osm": "way/148755803", "name": "MGM Music Hall at Fenway", "street": "Lansdowne Street"},
}
# Without mapped entrances, the door is the sidewalk between the venue and the street it's
# addressed on (285 Babcock St; 2 Lansdowne St), as make_demo_routes.door_point does for buildings.

# Where visitors arrive. Stations are transit.json stop ids (their platform positions); garages
# and lots are OSM parking features (capacity tag where OSM has one); rideshare drop-offs are a
# kerb point on the main road outside the venue.
WEST = [  # Agganis Arena, Walter Brown Arena, Case Gym: Comm Ave at West Campus
    {"id": "place-babck", "kind": "transit", "name": "Babcock Street (Green Line B)"},
    {"id": "place-amory", "kind": "transit", "name": "Amory Street (Green Line B)"},
    {"id": "langsam-garage", "kind": "parking", "name": "Langsam Garage (BU)", "osm": "way/1026274040", "capacity": 350},
    {"id": "bu-lot-f", "kind": "parking", "name": "BU Lot F", "osm": "way/277437319", "capacity": 262},
    {"id": "west-campus-lot", "kind": "parking", "name": "West Campus lot (Nickerson)", "osm": "relation/1273882", "capacity": 183},
    {"id": "comm-ave-garage", "kind": "parking", "name": "Garage off Comm Ave at Buick St (OSM, unnamed)", "osm": "way/1189678823", "capacity": None},
]
FENWAY = [  # Fenway Park and MGM Music Hall: Lansdowne St and Kenmore Square
    {"id": "place-kencl", "kind": "transit", "name": "Kenmore (Green Line B, C, D)"},
    {"id": "place-fenwy", "kind": "transit", "name": "Fenway (Green Line D)"},
    {"id": "lansdowne", "kind": "transit", "name": "Lansdowne (Commuter Rail)", "position": [-71.0995365, 42.347473]},
    {"id": "lansdowne-garage", "kind": "parking", "name": "Lansdowne Garage", "osm": "way/813954295", "capacity": None},
    {"id": "ipswich-garage", "kind": "parking", "name": "Ipswich Street Garage", "osm": "way/29605152", "capacity": None},
    {"id": "kenmore-lot", "kind": "parking", "name": "Kenmore Lot (VPNE)", "osm": "way/327673956", "capacity": 194},
    {"id": "brookline-ave-lot", "kind": "parking", "name": "Brookline Ave lot (Priority Parking)", "osm": "way/117699201", "capacity": 249},
]
ORIGINS = {
    "agganis": WEST + [{"id": "agganis-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Comm Ave at Harry Agganis Way", "position": [-71.11845, 42.35143]}],
    "walter-brown": WEST + [{"id": "case-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Babcock St", "position": [-71.12105, 42.35302]}],
    "case-gym": WEST + [{"id": "case-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Babcock St", "position": [-71.12105, 42.35302]}],
    "nickerson": WEST + [{"id": "agganis-way-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Harry Agganis Way", "position": [-71.11745, 42.35345]}],
    "new-balance-field": WEST + [{"id": "case-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Babcock St", "position": [-71.12105, 42.35302]}],
    "fenway-park": FENWAY + [{"id": "fenway-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Brookline Ave at Lansdowne St", "position": [-71.09935, 42.34715]}],
    "mgm-music-hall": FENWAY + [{"id": "mgm-dropoff", "kind": "rideshare", "name": "Rideshare drop-off, Ipswich St at Lansdowne St", "position": [-71.0947, 42.3471]}],
}


def outline_points(element):
    geometry = element.get("geometry") or [p for m in element.get("members", []) for p in m.get("geometry", []) or []]
    return [(p["lon"], p["lat"]) for p in geometry]


def fetch_venue_doors(refs):
    """{ref: {"centre", "doors": [(name, (lon, lat))]}}: entrance nodes on each outline (gates too;
    private and service doors left out)."""
    ways = ",".join(r.split("/")[1] for r in refs if r.startswith("way/"))
    rels = ",".join(r.split("/")[1] for r in refs if r.startswith("relation/"))
    parts = (f"way(id:{ways});" if ways else "") + (f"relation(id:{rels});" if rels else "")
    shapes = demo.overpass(f"[out:json][timeout:60];({parts});out geom;")
    nodes = demo.overpass(f"[out:json][timeout:60];({parts})->.b;(way(r.b);way.b;)->.w;node(w.w)[entrance];out body qt;")
    out = {}
    for el in shapes:
        pts = outline_points(el)
        outline = {(round(x, 6), round(y, 6)) for x, y in pts}
        doors = [
            (n["tags"].get("name") or n["tags"]["entrance"], (n["lon"], n["lat"])) for n in nodes
            if (round(n["lon"], 6), round(n["lat"], 6)) in outline and n["tags"]["entrance"] in DOOR_KINDS
            and n["tags"].get("access") not in ("private", "no")
        ]
        centre = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        out[f"{el['type']}/{el['id']}"] = {"centre": centre, "doors": doors}
    return out


def fetch_centres(refs):
    """{ref: (lon, lat)} centre of each OSM parking feature."""
    ways = ",".join(r.split("/")[1] for r in refs if r.startswith("way/"))
    rels = ",".join(r.split("/")[1] for r in refs if r.startswith("relation/"))
    parts = (f"way(id:{ways});" if ways else "") + (f"relation(id:{rels});" if rels else "")
    return {f"{e['type']}/{e['id']}": (e["center"]["lon"], e["center"]["lat"]) for e in demo.overpass(f"[out:json][timeout:60];({parts});out center;")}


def attach(network, point):
    for accept in (pedestrian_network.is_door, pedestrian_network.is_foot, lambda info: True):
        found = network.attach(point, accept, demo.SNAP_WARN_METRES)
        if found:
            return found
    return None


def main():
    campus = next(c for c in demo.load_campuses() if c["id"] == "charles-river")
    network = demo.walk_network(demo.network_bbox(campus))
    stops = {s["id"]: s for s in json.loads(TRANSIT.read_text())["stops"]}
    venue_shapes = fetch_venue_doors(sorted({v["osm"] for v in VENUES.values()}))
    parking = fetch_centres(sorted({o["osm"] for os_ in ORIGINS.values() for o in os_ if o.get("osm")}))

    venues_out = {}
    for venue_id, venue in VENUES.items():
        shape = venue_shapes.get(venue["osm"])
        if not shape:
            print(f"  WARNING: {venue_id}: OSM outline {venue['osm']} not found", file=sys.stderr)
            continue
        doors = shape["doors"]
        if not doors:
            here = {"lon": shape["centre"][0], "lat": shape["centre"][1]}
            doors = [(f"{venue.get('street', 'street')} entrance", demo.door_point(network, here, {"street": venue.get("street"), "entrances": []}))]
        door_nodes = []
        for name, point in doors:
            found = attach(network, point)
            if found:
                door_nodes.append((name, point, found[0]))
        origins_out = []
        for origin in ORIGINS[venue_id]:
            if origin.get("position"):
                position = tuple(origin["position"])
            elif origin["kind"] == "transit":
                position = tuple(stops[origin["id"]]["position"])
            else:
                position = parking.get(origin["osm"])
            if not position:
                print(f"  WARNING: {origin['id']}: no position", file=sys.stderr)
                continue
            found = attach(network, position)
            if not found:
                print(f"  WARNING: {origin['id']}: not near the walk network", file=sys.stderr)
                continue
            cost, prev = network.shortest(found[0])
            name, door_point, door_node = min(door_nodes, key=lambda d: cost.get(d[2], math.inf))
            if door_node not in cost:
                continue
            path, cumulative = demo.route_between(network, prev, found[0], door_node)
            if cumulative[-1] > MAX_ROUTE_METRES:
                continue
            origins_out.append({
                "id": origin["id"], "kind": origin["kind"], "name": origin["name"],
                "position": [round(position[0], 6), round(position[1], 6)],
                "capacity": origin.get("capacity"), "osm": origin.get("osm"), "door": name,
                "metres": cumulative[-1], "path": path, "cumulative": cumulative,
            })
        venues_out[venue_id] = {
            "name": venue["name"], "osm": venue["osm"],
            "doors": [{"name": n, "position": [round(p[0], 6), round(p[1], 6)]} for n, p, _ in door_nodes],
            "origins": origins_out,
        }
        print(f"{venue_id}: {len(door_nodes)} doors, {len(origins_out)} origins, "
              f"{', '.join(f'{o['id']} {o['metres']:.0f} m' for o in origins_out)}")
    demo.CACHE.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap via Overpass (cached): sidewalks, crossings, entrances, parking; MBTA stop positions from transit.json",
        "venues": venues_out,
    }, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
