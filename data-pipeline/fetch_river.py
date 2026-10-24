"""Cut the Charles River's sailing water out of OpenStreetMap for the map's sailboats.

Fetches the river's water polygons next to the Charles River Campus (`natural=water` +
`water=river`) and the bridges across them (`man_made=bridge`), and keeps two stretches of open
water, each ending a little short of its bridges:

  * the basin, from the BU Bridge down to the Mass Ave (Harvard) Bridge: the "Charles River
    Basin" multipolygon. BU Sailing's pavilion is on its Boston bank by the BU Bridge, next to the
    DeWolfe Boathouse; MIT and Community Boating sail it too;
  * upstream of the BU Bridge and the low Grand Junction railroad bridge (which closes the river
    to masts, so the two stretches never connect), round the bend to Magazine Beach and the
    River Street Bridge. This is the water in the map's default overview.

Each stretch is clipped by half-planes parallel to its bridges, CLEARANCE_METRES out from each
bridge's edge, then simplified to ~SIMPLIFY_METRES.

Writes map-client/public/data/river.json:
    { "name", "source",
      "polygons": [{ "name", "polygon": [[lng, lat], ...], "holes": [[[lng, lat], ...]] }],
      "bbox": [west, south, east, north] }
Each `polygon` is an outer ring, counter-clockwise, not repeated at the end.

Standard library only, in the style of fetch_street.py:
    python3 data-pipeline/fetch_river.py
"""

import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "map-client" / "public" / "data" / "river.json"
CACHE = HERE / ".cache" / "overpass"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

# south, west, north, east: Magazine Beach to past the Mass Ave Bridge.
BBOX = (42.345, -71.125, 42.362, -71.085)
CLEARANCE_METRES = 15  # the water ends this far from a bridge's edge
SIMPLIFY_METRES = 2.5

# (name, which water, bridges that bound it, a point in the open water on the kept side)
ZONES = [
    ("Charles River Basin", "relation:Charles River Basin",
     ["Boston University Bridge", "Harvard Bridge"], (-71.100, 42.3530)),
    ("Upstream of the BU Bridge", "way:upstream",
     ["Boston University Bridge", "Grand Junction Railroad Bridge"], (-71.1150, 42.3540)),
]
# The upstream stretch is an unnamed water=river way (the biggest inside this box); OSM already
# ends it at the River Street Bridge, which has no bridge outline of its own to clip by.
UPSTREAM_BOX = (42.3515, -71.1190, 42.3585, -71.1100)

METRES_PER_DEG_LAT = 110_540
LAT0 = 42.354
METRES_PER_DEG_LNG = 111_320 * math.cos(math.radians(LAT0))


def overpass(query):
    """Run an Overpass query, cached on disk: the public server is often busy (429/502/504)."""
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


# Local metric frame (x east, y north, metres) around the campus.
def to_xy(lng, lat):
    return ((lng - BBOX[1]) * METRES_PER_DEG_LNG, (lat - LAT0) * METRES_PER_DEG_LAT)


def to_lnglat(x, y):
    return [round(BBOX[1] + x / METRES_PER_DEG_LNG, 6), round(LAT0 + y / METRES_PER_DEG_LAT, 6)]


def stitch(ways):
    """Join way geometries (lists of points) end to end into closed rings."""
    pending = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while pending:
        ring = pending.pop()
        while ring[0] != ring[-1]:
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[-2::-1]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[:0:-1] + ring
                else:
                    continue
                pending.pop(i)
                break
            else:
                raise ValueError(f"unclosed ring of {len(ring)} points")
        rings.append(ring[:-1])
    return rings


def clip(ring, edges):
    """Sutherland-Hodgman: clip a ring by half-planes (a, b) = keep points with a.p >= b."""
    for (ax, ay), b in edges:
        out = []
        for i, p in enumerate(ring):
            q = ring[i - 1]
            dp, dq = ax * p[0] + ay * p[1] - b, ax * q[0] + ay * q[1] - b
            if (dp >= 0) != (dq >= 0):
                t = dq / (dq - dp)
                out.append((q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t))
            if dp >= 0:
                out.append(p)
        ring = out
        if not ring:
            break
    return ring


def simplify(points, tolerance):
    """Douglas-Peucker on a closed ring (split at the two farthest-apart points)."""
    def dp(pts):
        if len(pts) < 3:
            return pts
        (x0, y0), (x1, y1) = pts[0], pts[-1]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy) or 1e-9
        worst, index = 0.0, 0
        for i in range(1, len(pts) - 1):
            d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / length
            if d > worst:
                worst, index = d, i
        if worst <= tolerance:
            return [pts[0], pts[-1]]
        return dp(pts[: index + 1])[:-1] + dp(pts[index:])

    far = max(range(len(points)), key=lambda i: math.dist(points[0], points[i]))
    a = dp(points[: far + 1])
    b = dp(points[far:] + [points[0]])
    return a[:-1] + b[:-1]


def area(ring):
    return sum(ring[i - 1][0] * p[1] - p[0] * ring[i - 1][1] for i, p in enumerate(ring)) / 2


def clip_line_from(bridge_pts, toward):
    """Half-plane (normal, offset) keeping the side of a bridge that `toward` is on, starting
    CLEARANCE_METRES beyond the bridge's edge on that side."""
    a, b = max(((p, q) for p in bridge_pts for q in bridge_pts), key=lambda pq: math.dist(*pq))
    ux, uy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(ux, uy)
    nx, ny = -uy / length, ux / length
    if nx * (toward[0] - a[0]) + ny * (toward[1] - a[1]) < 0:
        nx, ny = -nx, -ny
    edge = max(nx * p[0] + ny * p[1] for p in bridge_pts)
    return (nx, ny), edge + CLEARANCE_METRES


def point_in(p, ring):
    inside = False
    for i, a in enumerate(ring):
        b = ring[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def main():
    s, w, n, e = BBOX
    us, uw, un, ue = UPSTREAM_BOX
    elements = overpass(f"""
[out:json][timeout:120];
relation["natural"="water"]["water"="river"]["name"="Charles River Basin"]({s},{w},{n},{e});
out geom;
way["natural"="water"]["water"="river"]({us},{uw},{un},{ue});
out geom;
way["man_made"="bridge"]["name"]({s},{w},{n},{e});
out geom;
""")
    bridges = {}
    for el in elements:
        if el["type"] == "way" and el.get("tags", {}).get("man_made") == "bridge":
            bridges.setdefault(el["tags"]["name"], []).extend(to_xy(p["lon"], p["lat"]) for p in el["geometry"])

    def water(kind):
        if kind.startswith("relation:"):
            rel = next(el for el in elements if el["type"] == "relation" and el["tags"].get("name") == kind[9:])
            members = {"outer": [], "inner": []}
            for m in rel["members"]:
                if m["type"] == "way" and m.get("geometry") and m["role"] in members:
                    members[m["role"]].append([(p["lon"], p["lat"]) for p in m["geometry"]])
            return f"relation/{rel['id']}", stitch(members["outer"]), stitch(members["inner"])
        ways = [el for el in elements if el["type"] == "way" and el.get("tags", {}).get("natural") == "water"
                and el["geometry"][0] == el["geometry"][-1]]
        way = max(ways, key=lambda el: abs(area([to_xy(p["lon"], p["lat"]) for p in el["geometry"]])))
        return f"way/{way['id']}", [[(p["lon"], p["lat"]) for p in way["geometry"][:-1]]], []

    zones, sources = [], []
    for name, kind, bridge_names, inside in ZONES:
        source, outer_rings, inner_rings = water(kind)
        toward = to_xy(*inside)
        edges = []
        for bridge in bridge_names:
            if bridge not in bridges:
                print(f"  WARNING: no '{bridge}' in OSM; {name} is not clipped there", file=sys.stderr)
                continue
            edges.append(clip_line_from(bridges[bridge], toward))
        outers = [[to_xy(*p) for p in r] for r in outer_rings]
        pieces = [r for r in (clip(o, edges) for o in outers) if len(r) >= 3]
        # Keep the piece around the reference point (or else the biggest).
        outer = max(pieces, key=lambda r: (point_in(toward, r), abs(area(r))))
        if area(outer) < 0:
            outer = outer[::-1]  # counter-clockwise outer ring
        holes = [h for h in (clip([to_xy(*p) for p in r], edges) for r in inner_rings) if len(h) >= 3]
        holes = [h for h in holes if point_in(h[0], outer)]
        outer = simplify(outer, SIMPLIFY_METRES)
        holes = [simplify(h, SIMPLIFY_METRES) for h in holes]
        zones.append({"name": name, "polygon": [to_lnglat(*p) for p in outer],
                      "holes": [[to_lnglat(*p) for p in h] for h in holes]})
        sources.append(source)
        print(f"  {name}: {len(outer)} points, {len(holes)} holes, {abs(area(outer)) / 1e4:.1f} ha, "
              f"clipped at {len(edges)} bridges")

    ring = [p for z in zones for p in z["polygon"]]
    out = {
        "name": "Charles River",
        "source": f"OpenStreetMap {', '.join(sources)} (ODbL), clipped short of the bridges",
        "polygons": zones,
        "bbox": [min(p[0] for p in ring), min(p[1] for p in ring), max(p[0] for p in ring), max(p[1] for p in ring)],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
