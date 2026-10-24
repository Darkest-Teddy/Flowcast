"""Snapshot the MBTA routes and stops serving each BU campus for the map client.

Writes map-client/public/data/transit.json: per campus area, the routes that serve it (shapes
clipped to the area, official colours) and their stops, with each station's platform ids so
live predictions can be matched back to it. Only the *static* data is snapshotted here; the map
polls live vehicles and arrival times itself (map-client/src/transit/).

Standard library only:
    python3 data-pipeline/fetch_transit.py
Set MBTA_API_KEY for a higher rate limit (free at https://api-v3.mbta.com); not needed for this.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api-v3.mbta.com"
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
            for area in areas_for_route[rid]:
                paths += clip(shape, area["bbox"])
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
