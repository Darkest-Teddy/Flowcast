"""Snapshot the MBTA routes and stops serving each BU campus for the map client.

Writes map-client/public/data/transit.json: per campus area, the routes that serve it (shapes
clipped to the area, official colours) and their stops, with each station's platform ids so
live predictions can be matched back to it. Only the *static* data is snapshotted here; the map
polls live vehicles and arrival times itself (map-client/src/transit/).

Standard library only:
    python3 data-pipeline/fetch_transit.py
Set MBTA_API_KEY for a higher rate limit (free at https://api-v3.mbta.com); not needed for this.
"""

import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api-v3.mbta.com"
OVERPASS = "https://overpass-api.de/api/interpreter"
CACHE = Path(__file__).resolve().parent / ".cache" / "overpass"
# A path point within this many metres of an OSM rail tunnel is underground.
TUNNEL_MATCH_METRES = 15
OUT = Path(__file__).resolve().parent.parent / "map-client" / "public" / "data" / "transit.json"

# Campus ids match data-pipeline/campuses/*.json. bbox is (west, south, east, north).
AREAS = [
    {
        "id": "charles-river",
        "name": "Charles River Campus",
        # Kenmore to Packard's Corner, the river to Beacon St (South Campus, St. Mary's St on the C)
        "bbox": (-71.1250, 42.3440, -71.0900, 42.3560),
        "routes": ["Green-B", "Green-C", "57", "47"],
    },
    {
        "id": "fenway",
        "name": "Fenway Campus",
        # The Riverway / Pilgrim Rd / Longwood: Fenway and Longwood stations on the D
        "bbox": (-71.1130, 42.3380, -71.0990, 42.3465),
        "routes": ["Green-D", "47"],
    },
    {
        "id": "medical",
        "name": "Medical Campus",
        # South End: E Concord St / Albany St / Harrison Ave, Boston Medical Center
        "bbox": (-71.0790, 42.3320, -71.0680, 42.3390),
        "routes": ["751", "749", "1", "8", "10", "47"],  # 751/749 = Silver Line SL4/SL5
    },
]

# Shorter names for the big screen.
SHORT_NAMES = {
    "Boston University East": "BU East",
    "Boston University Central": "BU Central",
}
# Green Line riders say Inbound/Outbound (direction_id 0 runs outbound, west); bus riders go by destination.
GREEN_DIRECTIONS = ("Outbound", "Inbound")


def get(path, params):
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API}{path}?{query}", headers={"Accept": "application/vnd.api+json"})
    if os.environ.get("MBTA_API_KEY"):
        req.add_header("x-api-key", os.environ["MBTA_API_KEY"])
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as err:
            # Without a key the MBTA allows 20 requests/minute per IP; wait for the window to reset.
            if err.code != 429 or attempt == 5:
                raise
            reset = err.headers.get("x-ratelimit-reset")
            wait = max(1.0, int(reset) - time.time()) if reset and reset.isdigit() else 10.0
            print(f"  MBTA rate limit; waiting {wait:.0f}s", file=sys.stderr)
            time.sleep(min(wait + 1, 65))


def overpass(query):
    """Overpass with a User-Agent (406 without), polite retries, and a disk cache."""
    cached = CACHE / f"{hashlib.sha1(query.encode()).hexdigest()[:16]}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "Flowcast-DSX-hackathon/0.1"},
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                elements = json.load(resp)["elements"]
            break
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as err:
            if attempt == 5:
                raise
            print(f"  Overpass busy ({err}), retrying...", file=sys.stderr)
            time.sleep(8 * (attempt + 1))
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(elements))
    return elements


def tunnel_segments():
    """Green Line tunnel geometry from OSM, as ((lng, lat), (lng, lat)) segments."""
    w = min(a["bbox"][0] for a in AREAS)
    s = min(a["bbox"][1] for a in AREAS)
    e = max(a["bbox"][2] for a in AREAS)
    n = max(a["bbox"][3] for a in AREAS)
    ways = overpass(f'[out:json][timeout:60];way["railway"~"^(light_rail|subway|tram)$"]["tunnel"]({s - 0.01},{w - 0.01},{n + 0.01},{e + 0.01});out geom;')
    segs = []
    for way in ways:
        if way.get("tags", {}).get("tunnel") in ("no",):
            continue
        g = [(p["lon"], p["lat"]) for p in way["geometry"]]
        segs += list(zip(g, g[1:]))
    return segs


def underground_spans(path, segs):
    """[start, end] point-index spans of `path` that run through a tunnel."""
    def metres_to_segment(p, a, b):
        kx = 111320 * math.cos(math.radians(p[1]))
        ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * 110540
        bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * 110540
        dx, dy = bx - ax, by - ay
        f = max(0.0, min(1.0, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1)))
        return math.hypot(ax + dx * f, ay + dy * f)

    inside = [any(metres_to_segment(p, a, b) < TUNNEL_MATCH_METRES for a, b in segs) for p in path]
    spans, start = [], None
    for i, flag in enumerate(inside + [False]):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            if i - start >= 2:
                spans.append([start, i - 1])
            start = None
    return spans


def in_bbox(bbox, lon, lat, pad=0.0):
    w, s, e, n = bbox
    return w - pad <= lon <= e + pad and s - pad <= lat <= n + pad


def decode_polyline(encoded):
    """Google encoded polyline -> [[lng, lat], ...]."""
    coords, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append([round(lng / 1e5, 6), round(lat / 1e5, 6)])
    return coords


def clip(path, bbox):
    """Keep the runs of a path inside an area (a little slack so lines run off-screen cleanly)."""
    runs, current = [], []
    for lng, lat in path:
        if in_bbox(bbox, lng, lat, pad=0.004):
            current.append([lng, lat])
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return [r for r in runs if len(r) > 1]


def main():
    route_ids = sorted({r for area in AREAS for r in area["routes"]})
    areas_for_route = {r: [a for a in AREAS if r in a["routes"]] for r in route_ids}

    print("Fetching Green Line tunnels from OpenStreetMap...", file=sys.stderr)
    tunnels = tunnel_segments()
    print(f"  {len(tunnels)} tunnel segments", file=sys.stderr)
    routes = get("/routes", {"filter[id]": ",".join(route_ids)})["data"]
    patterns = get("/route_patterns", {"filter[route]": ",".join(route_ids), "include": "representative_trip.shape"})
    shapes = {i["id"]: i["attributes"]["polyline"] for i in patterns.get("included", []) if i["type"] == "shape"}
    trips = {i["id"]: i["relationships"]["shape"]["data"]["id"] for i in patterns.get("included", []) if i["type"] == "trip"}

    out_routes = []
    for route in routes:
        rid, attrs = route["id"], route["attributes"]
        paths = []
        for p in patterns["data"]:
            # typicality 1 = the route's normal service (not detours, shuttles or short turns)
            if p["relationships"]["route"]["data"]["id"] != rid or p["attributes"]["typicality"] != 1:
                continue
            shape = decode_polyline(shapes[trips[p["relationships"]["representative_trip"]["data"]["id"]]])
            # Points run in travel order for this direction, so the map can lay each direction
            # on its own right-hand track and point vehicles along it.
            direction = p["attributes"]["direction_id"]
            for area in areas_for_route[rid]:
                for run in clip(shape, area["bbox"]):
                    entry = {"direction": direction, "path": run}
                    if attrs["type"] in (0, 1):
                        # Kenmore, Hynes and the D past Fenway run underground: the map draws no
                        # track there and trains vanish into the portal.
                        entry["underground"] = underground_spans(run, tunnels)
                    paths.append(entry)
        is_green = rid.startswith("Green-")
        out_routes.append({
            "id": rid,
            "name": attrs["short_name"] or attrs["long_name"],
            "longName": attrs["long_name"],
            "kind": "subway" if attrs["type"] in (0, 1) else "bus",
            "color": "#" + attrs["color"],
            "textColor": "#" + attrs["text_color"],
            "directions": list(GREEN_DIRECTIONS if is_green else [f"to {d}" for d in attrs["direction_destinations"]]),
            "paths": paths,
        })

    stops = {}
    for rid in route_ids:
        for s in get("/stops", {"filter[route]": rid, "include": "child_stops"})["data"]:
            a = s["attributes"]
            for area in areas_for_route[rid]:
                if not in_bbox(area["bbox"], a["longitude"], a["latitude"]):
                    continue
                stop = stops.setdefault(s["id"], {
                    "id": s["id"],
                    "name": a["name"],
                    "short": SHORT_NAMES.get(a["name"], a["name"].replace("Commonwealth Ave", "Comm Ave")),
                    "kind": "station" if s["id"].startswith("place-") else "bus",
                    "area": area["id"],
                    "position": [round(a["longitude"], 6), round(a["latitude"], 6)],
                    # Predictions name the platform (child stop), not the station; match on any of these.
                    "platforms": [s["id"]] + [
                        c["id"]
                        for c in s["relationships"].get("child_stops", {}).get("data", [])
                        if not c["id"].startswith(("door-", "node-"))  # entrances and stairwells, not platforms
                    ],
                    "routes": [],
                })
                if rid not in stop["routes"]:
                    stop["routes"].append(rid)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    areas = [{"id": a["id"], "name": a["name"], "bbox": a["bbox"], "routes": a["routes"]} for a in AREAS]
    OUT.write_text(json.dumps({"areas": areas, "routes": out_routes, "stops": list(stops.values())}, separators=(",", ":")))
    for area in AREAS:
        n = [s for s in stops.values() if s["area"] == area["id"]]
        print(f"{area['id']}: {sum(s['kind'] == 'station' for s in n)} stations, {sum(s['kind'] == 'bus' for s in n)} bus stops", file=sys.stderr)
    print(f"Wrote {len(out_routes)} routes, {len(stops)} stops -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
