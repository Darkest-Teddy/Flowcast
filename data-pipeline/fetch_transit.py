"""Snapshot the MBTA routes and stops around BU for the map client.

Writes map-client/public/data/transit.json: the Green Line B branch and the bus routes through
campus (shapes clipped to the campus area, official colours) and their stops, with each
station's platform ids so live predictions can be matched back to it. Only the *static* data is
snapshotted here; the map polls live vehicles and arrival times itself (map-client/src/transit/).

Standard library only:
    python3 data-pipeline/fetch_transit.py
Set MBTA_API_KEY for a higher rate limit (free at https://api-v3.mbta.com); not needed for this.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api-v3.mbta.com"
OUT = Path(__file__).resolve().parent.parent / "map-client" / "public" / "data" / "transit.json"
ROUTES = ["Green-B", "57", "47"]
# west, south, east, north: Kenmore to Packard's Corner, the river to Brookline
BBOX = (-71.1250, 42.3440, -71.0900, 42.3560)

# Shorter names for the big screen.
SHORT_NAMES = {
    "Boston University East": "BU East",
    "Boston University Central": "BU Central",
}
DIRECTION_NAMES = {"Green-B": ("Outbound", "Inbound")}  # direction_id 0 = toward Boston College


def get(path, params):
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{API}{path}?{query}", headers={"Accept": "application/vnd.api+json"})
    if os.environ.get("MBTA_API_KEY"):
        req.add_header("x-api-key", os.environ["MBTA_API_KEY"])
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def in_bbox(lon, lat, pad=0.0):
    w, s, e, n = BBOX
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


def clip(path):
    """Keep the runs of a path near campus (a little slack so lines run off-screen cleanly)."""
    runs, current = [], []
    for lng, lat in path:
        if in_bbox(lng, lat, pad=0.004):
            current.append([lng, lat])
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return [r for r in runs if len(r) > 1]


def main():
    routes = get("/routes", {"filter[id]": ",".join(ROUTES)})["data"]
    patterns = get("/route_patterns", {"filter[route]": ",".join(ROUTES), "include": "representative_trip.shape"})
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
            trip_id = p["relationships"]["representative_trip"]["data"]["id"]
            paths += clip(decode_polyline(shapes[trips[trip_id]]))
        out_routes.append({
            "id": rid,
            "name": attrs["short_name"] or attrs["long_name"],
            "longName": attrs["long_name"],
            "kind": "subway" if attrs["type"] in (0, 1) else "bus",
            "color": "#" + attrs["color"],
            "textColor": "#" + attrs["text_color"],
            # Green Line riders say Inbound/Outbound; bus riders go by destination.
            "directions": list(DIRECTION_NAMES.get(rid) or [f"to {d}" for d in attrs["direction_destinations"]]),
            "paths": paths,
        })

    stops = {}
    for rid in ROUTES:
        for s in get("/stops", {"filter[route]": rid, "include": "child_stops"})["data"]:
            a = s["attributes"]
            if not in_bbox(a["longitude"], a["latitude"]):
                continue
            stop = stops.setdefault(s["id"], {
                "id": s["id"],
                "name": a["name"],
                "short": SHORT_NAMES.get(a["name"], a["name"].replace("Commonwealth Ave", "Comm Ave")),
                "kind": "station" if s["id"].startswith("place-") else "bus",
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
    payload = {"routes": out_routes, "stops": list(stops.values()), "bbox": BBOX}
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {len(out_routes)} routes, {len(stops)} stops -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
