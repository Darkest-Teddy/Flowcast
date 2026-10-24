"""Generate detailed 3D models of Boston University's buildings for the map client.

Mapbox Standard draws hand-made models for famous landmarks (Fenway Park, the Pru) but every BU
building is a plain grey box. This script pulls the real OpenStreetMap footprints of BU's
buildings on every campus and procedurally builds a detailed model of each one: storey-by-storey
window rows, a ground-floor base or storefront, doors on the street side, cornices and parapets,
rooftop plant, mansard roofs, bay fronts and stoops on the Bay State Road brownstones, and
hand-tuned shapes for the iconic buildings (CDS, Marsh Chapel, Warren Towers, StuVi, Agganis,
CAS, Mugar, GSU).

Output (one draw-friendly GLB per campus, geometry merged per material):
    map-client/public/models/buildings-<campus>.glb
    map-client/public/data/building-models.json   (manifest; see map-client/src/layers/buildings.ts)

Coordinate frame of every GLB: metres, glTF's usual axes. +x = east, +y = up, +z = SOUTH
(so north is -z), relative to the campus origin [lng, lat] in the manifest. Horizontal metres are
deck.gl's own Web-Mercator metres at the origin, so the models land exactly on the OSM footprints.

Every model sits ~0.3 m outside its OSM footprint and its roof ~0.5 m above the height Mapbox
extrudes, so it hides Mapbox's own plain box instead of z-fighting with it. Mapbox's extrusion
heights (often taller than OSM's tags) are kept in data-pipeline/building_height_floors.json; it is
refreshed from data-pipeline/.cache/mapbox-buildings.json when that capture exists.

Standard library only (like make_demo_routes.py):
    python3 data-pipeline/make_building_models.py
"""

import array
import hashlib
import json
import math
import random
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data-pipeline" / ".cache" / "overpass"
MODELS_DIR = ROOT / "map-client" / "public" / "models"
MANIFEST = ROOT / "map-client" / "public" / "data" / "building-models.json"
HEIGHT_FLOORS = ROOT / "data-pipeline" / "building_height_floors.json"
MAPBOX_CAPTURE = ROOT / "data-pipeline" / ".cache" / "mapbox-buildings.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "Flowcast-DSX-hackathon/0.1"

# ------------------------------------------------------------------------------------------------
# OpenStreetMap
# ------------------------------------------------------------------------------------------------

# Every building (and building:part) around the Charles River + Fenway campuses, and the Medical
# Campus. Kept byte-identical between runs so the on-disk cache hits.
Q_CHARLES = ('[out:json][timeout:120];(nwr["building"](42.3380,-71.1260,42.3575,-71.0900);'
             'nwr["building:part"](42.3380,-71.1260,42.3575,-71.0900););out geom;')
Q_MEDICAL = ('[out:json][timeout:120];(nwr["building"](42.3290,-71.0790,42.3420,-71.0610);'
             'nwr["building:part"](42.3290,-71.0790,42.3420,-71.0610););out geom;')
# BU's campus outlines as mapped in OSM (amenity=university): the main "Boston University"
# multipolygon (Charles River + South Campus + Fenway), the Fenway Campus, the Brookline Campus
# (43 Hawes St) and the two Medical Campus areas. Plus Wheelock's old Brookline campus (not used).
Q_CAMPUS = ('[out:json][timeout:90];(relation(6587738);way(1298798352);way(812987474);'
            'way(832668596);way(228917776);relation(3067734);way(228918082););out geom;')
Q_STREETS = '[out:json][timeout:120];way["highway"]["name"](42.3290,-71.1260,42.3575,-71.0610);out geom;'

BU_MAIN = "relation/6587738"
FENWAY_AREAS = ("way/1298798352", "way/228917776")
MEDICAL_AREAS = ("way/832668596", "way/812987474")

CAMPUSES = [
    {"id": "charles-river", "name": "Charles River Campus", "origin": (-71.1075, 42.3500)},
    {"id": "fenway", "name": "Fenway Campus", "origin": (-71.1060, 42.3425)},
    {"id": "medical", "name": "Medical Campus", "origin": (-71.0715, 42.3355)},
]

BU_NAME = re.compile(r"boston univ|\bB\.?U\.?\b|wheelock", re.I)
SKIP_TYPES = {"garage", "garages", "shed", "hut", "gatehouse", "carport", "construction", "kiosk", "service"}
SKIP_AMENITY = {"bicycle_parking", "shelter"}
# Single-family houses inside the coarse BU outline are Brookline homes, not BU's.
HOUSE_TYPES = {"detached", "house"}
# BU buildings just outside OSM's campus outline (West Campus, south side of Comm Ave).
EXTRA_IDS = {"way/29827118", "way/29932285"}
# Medical Campus: the OSM campus area also holds BMC's hospital, a hotel and private housing, so
# there only university buildings, named BU buildings and these are kept.
MEDICAL_EXTRA = {"way/484824710"}  # Crosstown Center (801 Mass Ave): BU School of Public Health

METRES_PER_LEVEL = 3.6
PART_SKIP = {"balcony", "roof", "bleachers"}


def overpass(query):
    """Run an Overpass query, cached on disk. The public server is shared: be gentle."""
    cached = CACHE / f"{hashlib.sha1(query.encode()).hexdigest()[:16]}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": USER_AGENT},  # overpass-api.de returns 406 without one
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                elements = json.load(resp)["elements"]
            break
        except urllib.error.HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 5:
                raise
            print(f"  Overpass busy ({err.code}), retrying...", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(elements))
    time.sleep(2)
    return elements


def stitch_rings(segments):
    """Join multipolygon member ways end-to-end into closed rings."""
    segments = [list(seg) for seg in segments if len(seg) > 1]
    rings = []
    while segments:
        ring = segments.pop(0)
        while ring[0] != ring[-1]:
            for i, seg in enumerate(segments):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = seg[::-1][:-1] + ring
                else:
                    continue
                segments.pop(i)
                break
            else:
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def element_rings(el):
    """[(outer, [inners])] in lng/lat, rings open (last point != first)."""
    def pts(geom):
        return [(p["lon"], p["lat"]) for p in geom]
    if el["type"] == "way":
        g = pts(el.get("geometry", []))
        if len(g) < 4:
            return []
        return [(g[:-1] if g[0] == g[-1] else g, [])]
    outers = stitch_rings([pts(m["geometry"]) for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")])
    inners = stitch_rings([pts(m["geometry"]) for m in el.get("members", []) if m.get("role") == "inner" and m.get("geometry")])
    out = []
    for o in outers:
        o = o[:-1] if o[0] == o[-1] else o
        mine = []
        for r in inners:
            r = r[:-1] if r[0] == r[-1] else r
            if point_in_ring(r[0], o):
                mine.append(r)
        out.append((o, mine))
    return out


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def ring_centroid(ring):
    a = cx = cy = 0.0
    n = len(ring)
    x0, y0 = ring[0]
    for i in range(n):
        x1, y1 = ring[i][0] - x0, ring[i][1] - y0
        x2, y2 = ring[(i + 1) % n][0] - x0, ring[(i + 1) % n][1] - y0
        c = x1 * y2 - x2 * y1
        a += c
        cx += (x1 + x2) * c
        cy += (y1 + y2) * c
    if abs(a) < 1e-14:
        return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
    return (x0 + cx / (3 * a), y0 + cy / (3 * a))


# ------------------------------------------------------------------------------------------------
# Projection: deck.gl's Web-Mercator metres at the campus origin
# ------------------------------------------------------------------------------------------------

DECK_EARTH_CIRCUMFERENCE = 40.03e6  # @math.gl/web-mercator's constant


class Frame:
    def __init__(self, lng0, lat0):
        self.lng0, self.lat0 = lng0, lat0
        # metres per unit of (lng radians) and per unit of mercator-y, at the origin
        self.k = DECK_EARTH_CIRCUMFERENCE / (2 * math.pi) * math.cos(math.radians(lat0))
        self.y0 = self._merc(lat0)

    @staticmethod
    def _merc(lat):
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    def to_local(self, lng, lat):
        """(east, north) metres."""
        return (math.radians(lng - self.lng0) * self.k, (self._merc(lat) - self.y0) * self.k)

    def to_lnglat(self, x, y):
        lng = self.lng0 + math.degrees(x / self.k)
        lat = math.degrees(2 * math.atan(math.exp(y / self.k + self.y0)) - math.pi / 2)
        return (lng, lat)


# ------------------------------------------------------------------------------------------------
# 2D geometry (x east, y north, metres)
# ------------------------------------------------------------------------------------------------

def signed_area(r):
    s = 0.0
    n = len(r)
    for i in range(n):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        s += x1 * y2 - x2 * y1
    return s / 2


def oriented(r, ccw=True):
    return list(r) if (signed_area(r) > 0) == ccw else list(reversed(r))


def dist(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def clean_ring(r, min_len=0.3, sin_tol=0.035):
    """Drop duplicate, tiny and collinear vertices."""
    pts = []
    for p in r:
        if not pts or dist(p, pts[-1]) > 1e-3:
            pts.append(p)
    if len(pts) > 1 and dist(pts[0], pts[-1]) < 1e-3:
        pts.pop()
    changed = True
    while changed and len(pts) > 3:
        changed = False
        n = len(pts)
        for i in range(n):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
            ab, bc = dist(a, b), dist(b, c)
            if ab < min_len:
                del pts[i]
                changed = True
                break
            if bc > 1e-9:
                cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
                if abs(cross) / (ab * bc) < sin_tol:
                    del pts[i]
                    changed = True
                    break
    return pts


def right_normal(a, b):
    L = dist(a, b) or 1.0
    return ((b[1] - a[1]) / L, -(b[0] - a[0]) / L)


def offset_ring(r, d, max_miter=3.0):
    """Move every edge d metres to its right (outward for a CCW outer / CW hole ring)."""
    n = len(r)
    out = []
    for i in range(n):
        p0, p1, p2 = r[i - 1], r[i], r[(i + 1) % n]
        n1 = right_normal(p0, p1)
        n2 = right_normal(p1, p2)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        ml = math.hypot(mx, my)
        if ml < 1e-6:
            mx, my, scale = n1[0], n1[1], d
        else:
            mx, my = mx / ml, my / ml
            cosh = mx * n1[0] + my * n1[1]
            scale = d / max(cosh, 1.0 / max_miter)
        out.append((p1[0] + mx * scale, p1[1] + my * scale))
    return out


def inset_ok(orig, inset):
    """An inward offset is usable if it kept its orientation, every edge direction and some area."""
    a0, a1 = signed_area(orig), signed_area(inset)
    if a1 * a0 <= 0 or abs(a1) < 0.2 * abs(a0):
        return False
    n = len(orig)
    for i in range(n):
        d0 = (orig[(i + 1) % n][0] - orig[i][0], orig[(i + 1) % n][1] - orig[i][1])
        d1 = (inset[(i + 1) % n][0] - inset[i][0], inset[(i + 1) % n][1] - inset[i][1])
        if d0[0] * d1[0] + d0[1] * d1[1] <= 0:
            return False
    return True


def point_seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    q = (a[0] + t * dx, a[1] + t * dy)
    return dist(p, q), q


def obb(r):
    """Minimum-area bounding rectangle: (centre, unit long axis, unit short axis, half long, half short)."""
    best = None
    n = len(r)
    for i in range(n):
        a, b = r[i], r[(i + 1) % n]
        L = dist(a, b)
        if L < 1e-6:
            continue
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        us = [p[0] * ux + p[1] * uy for p in r]
        vs = [-p[0] * uy + p[1] * ux for p in r]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            best = (area, ux, uy, min(us), max(us), min(vs), max(vs))
    _, ux, uy, u0, u1, v0, v1 = best
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    centre = (cu * ux - cv * uy, cu * uy + cv * ux)
    eu, ev = (ux, uy), (-uy, ux)
    hu, hv = (u1 - u0) / 2, (v1 - v0) / 2
    if hv > hu:
        eu, ev, hu, hv = ev, (-eu[0], -eu[1]), hv, hu
    return centre, eu, ev, hu, hv


def clip_halfplane(poly, a, b, c):
    """Keep the part of poly where a*x + b*y + c <= 0 (Sutherland-Hodgman)."""
    out = []
    n = len(poly)
    for i in range(n):
        P, Q = poly[i], poly[(i + 1) % n]
        fp = a * P[0] + b * P[1] + c
        fq = a * Q[0] + b * Q[1] + c
        if fp <= 0:
            out.append(P)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq)
            out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
    return out


def poly_contains(rings, p):
    if not point_in_ring(p, rings[0]):
        return False
    return not any(point_in_ring(p, h) for h in rings[1:])


def min_edge_dist(rings, p):
    best = 1e9
    for r in rings:
        n = len(r)
        for i in range(n):
            d, _ = point_seg_dist(p, r[i - 1], r[i])
            best = min(best, d)
    return best


# ------------------------------------------------------------------------------------------------
# Earcut (port of mapbox/earcut, without the z-order hash)
# ------------------------------------------------------------------------------------------------

class _N:
    __slots__ = ("i", "x", "y", "prev", "next", "steiner")

    def __init__(self, i, x, y):
        self.i, self.x, self.y = i, x, y
        self.prev = self.next = None
        self.steiner = False


def earcut(data, holes=()):
    """data: flat [x0, y0, x1, y1, ...]; holes: start indices (in points). Returns triangle indices."""
    has_holes = bool(holes)
    outer_len = holes[0] * 2 if has_holes else len(data)
    outer = _linked(data, 0, outer_len, True)
    tris = []
    if outer is None or outer.next is outer.prev:
        return tris
    if has_holes:
        outer = _eliminate_holes(data, holes, outer)
    _earcut_linked(outer, tris, 0)
    return tris


def _linked(data, start, end, clockwise):
    last = None
    s = 0.0
    j = end - 2
    for i in range(start, end, 2):
        s += (data[j] - data[i]) * (data[i + 1] + data[j + 1])
        j = i
    if clockwise == (s > 0):
        for i in range(start, end, 2):
            last = _insert(i // 2, data[i], data[i + 1], last)
    else:
        for i in range(end - 2, start - 1, -2):
            last = _insert(i // 2, data[i], data[i + 1], last)
    if last is not None and _equals(last, last.next):
        _remove(last)
        last = last.next
    return last


def _insert(i, x, y, last):
    p = _N(i, x, y)
    if last is None:
        p.prev = p
        p.next = p
    else:
        p.next = last.next
        p.prev = last
        last.next.prev = p
        last.next = p
    return p


def _remove(p):
    p.next.prev = p.prev
    p.prev.next = p.next


def _equals(a, b):
    return a.x == b.x and a.y == b.y


def _area(p, q, r):
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)


def _filter(start, end=None):
    if start is None:
        return start
    if end is None:
        end = start
    p = start
    while True:
        again = False
        if not p.steiner and (_equals(p, p.next) or _area(p.prev, p, p.next) == 0):
            _remove(p)
            p = end = p.prev
            if p is p.next:
                break
            again = True
        else:
            p = p.next
        if not again and p is end:
            break
    return end


def _pit(ax, ay, bx, by, cx, cy, px, py):
    return ((cx - px) * (ay - py) >= (ax - px) * (cy - py) and
            (ax - px) * (by - py) >= (bx - px) * (ay - py) and
            (bx - px) * (cy - py) >= (cx - px) * (by - py))


def _is_ear(ear):
    a, b, c = ear.prev, ear, ear.next
    if _area(a, b, c) >= 0:
        return False
    p = c.next
    while p is not a:
        if _pit(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) and _area(p.prev, p, p.next) >= 0:
            return False
        p = p.next
    return True


def _earcut_linked(ear, tris, pss):
    if ear is None:
        return
    stop = ear
    while ear.prev is not ear.next:
        prev, nxt = ear.prev, ear.next
        if _is_ear(ear):
            tris.extend((prev.i, ear.i, nxt.i))
            _remove(ear)
            ear = nxt.next
            stop = nxt.next
            continue
        ear = nxt
        if ear is stop:
            if pss == 0:
                _earcut_linked(_filter(ear), tris, 1)
            elif pss == 1:
                ear = _cure(_filter(ear), tris)
                _earcut_linked(ear, tris, 2)
            elif pss == 2:
                _split_earcut(ear, tris)
            break


def _cure(start, tris):
    p = start
    while True:
        a, b = p.prev, p.next.next
        if not _equals(a, b) and _intersects(a, p, p.next, b) and _locally_inside(a, b) and _locally_inside(b, a):
            tris.extend((a.i, p.i, b.i))
            _remove(p)
            _remove(p.next)
            p = start = b
        p = p.next
        if p is start:
            break
    return _filter(p)


def _split_earcut(start, tris):
    a = start
    while True:
        b = a.next.next
        while b is not a.prev:
            if a.i != b.i and _valid_diagonal(a, b):
                c = _split(a, b)
                a = _filter(a, a.next)
                c = _filter(c, c.next)
                _earcut_linked(a, tris, 0)
                _earcut_linked(c, tris, 0)
                return
            b = b.next
        a = a.next
        if a is start:
            break


def _eliminate_holes(data, holes, outer):
    queue = []
    for k, h in enumerate(holes):
        start = h * 2
        end = holes[k + 1] * 2 if k < len(holes) - 1 else len(data)
        lst = _linked(data, start, end, False)
        if lst is None:
            continue
        if lst is lst.next:
            lst.steiner = True
        queue.append(_leftmost(lst))
    queue.sort(key=lambda n: (n.x, n.y))
    for q in queue:
        outer = _eliminate_hole(q, outer)
    return outer


def _eliminate_hole(hole, outer):
    bridge = _find_bridge(hole, outer)
    if bridge is None:
        return outer
    rev = _split(bridge, hole)
    _filter(rev, rev.next)
    return _filter(bridge, bridge.next)


def _find_bridge(hole, outer):
    p = outer
    hx, hy = hole.x, hole.y
    qx = -math.inf
    m = None
    while True:
        if hy <= p.y and hy >= p.next.y and p.next.y != p.y:
            x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y)
            if hx >= x > qx:
                qx = x
                m = p if p.x < p.next.x else p.next
                if x == hx:
                    return m
        p = p.next
        if p is outer:
            break
    if m is None:
        return None
    stop = m
    mx, my = m.x, m.y
    tan_min = math.inf
    p = m
    while True:
        if hx >= p.x >= mx and hx != p.x and _pit(hx if hy < my else qx, hy, mx, my, qx if hy < my else hx, hy, p.x, p.y):
            tan = abs(hy - p.y) / (hx - p.x)
            if _locally_inside(p, hole) and (tan < tan_min or (tan == tan_min and (p.x > m.x or (p.x == m.x and _sector(m, p))))):
                m = p
                tan_min = tan
        p = p.next
        if p is stop:
            break
    return m


def _sector(m, p):
    return _area(m.prev, m, p.prev) < 0 and _area(p.next, m, m.next) < 0


def _leftmost(start):
    p = start
    left = start
    while True:
        if p.x < left.x or (p.x == left.x and p.y < left.y):
            left = p
        p = p.next
        if p is start:
            break
    return left


def _valid_diagonal(a, b):
    return (a.next.i != b.i and a.prev.i != b.i and not _intersects_poly(a, b) and
            ((_locally_inside(a, b) and _locally_inside(b, a) and _middle_inside(a, b) and
              (_area(a.prev, a, b.prev) or _area(a, b.prev, b))) or
             (_equals(a, b) and _area(a.prev, a, a.next) > 0 and _area(b.prev, b, b.next) > 0)))


def _sign(v):
    return (v > 0) - (v < 0)


def _on_seg(p, q, r):
    return min(p.x, r.x) <= q.x <= max(p.x, r.x) and min(p.y, r.y) <= q.y <= max(p.y, r.y)


def _intersects(p1, q1, p2, q2):
    o1 = _sign(_area(p1, q1, p2))
    o2 = _sign(_area(p1, q1, q2))
    o3 = _sign(_area(p2, q2, p1))
    o4 = _sign(_area(p2, q2, q1))
    if o1 != o2 and o3 != o4:
        return True
    if o1 == 0 and _on_seg(p1, p2, q1):
        return True
    if o2 == 0 and _on_seg(p1, q2, q1):
        return True
    if o3 == 0 and _on_seg(p2, p1, q2):
        return True
    if o4 == 0 and _on_seg(p2, q1, q2):
        return True
    return False


def _intersects_poly(a, b):
    p = a
    while True:
        if p.i != a.i and p.next.i != a.i and p.i != b.i and p.next.i != b.i and _intersects(p, p.next, a, b):
            return True
        p = p.next
        if p is a:
            break
    return False


def _locally_inside(a, b):
    if _area(a.prev, a, a.next) < 0:
        return _area(a, b, a.next) >= 0 and _area(a, a.prev, b) >= 0
    return _area(a, b, a.prev) < 0 or _area(a, a.next, b) < 0


def _middle_inside(a, b):
    p = a
    inside = False
    px, py = (a.x + b.x) / 2, (a.y + b.y) / 2
    while True:
        if (p.y > py) != (p.next.y > py) and p.next.y != p.y and px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x:
            inside = not inside
        p = p.next
        if p is a:
            break
    return inside


def _split(a, b):
    a2 = _N(a.i, a.x, a.y)
    b2 = _N(b.i, b.x, b.y)
    an, bp = a.next, b.prev
    a.next = b
    b.prev = a
    a2.next = an
    an.prev = a2
    b2.next = a2
    a2.prev = b2
    bp.next = b2
    b2.prev = bp
    return b2


def triangulate(rings):
    """rings: [outer, *holes] (2D). Returns (points, triangle index list)."""
    pts, holes, data = [], [], []
    for k, r in enumerate(rings):
        if k:
            holes.append(len(pts))
        for p in r:
            pts.append(p)
            data.extend(p)
    return pts, earcut(data, holes)


# ------------------------------------------------------------------------------------------------
# Facade texture atlas: one 128 x 1024 PNG, 16 horizontal bands, each one storey of one style.
# A wall quad samples one band, with u repeating once per window bay along the wall.
# ------------------------------------------------------------------------------------------------

TEX_W, BAND_H, NBANDS = 128, 64, 16
B_BRICK, B_BRICK_GROUND, B_BROWNSTONE, B_LIME, B_LIME_GROUND, B_GLASS, B_LOBBY, B_CONCRETE, \
    B_MODERN, B_SHOP, B_WOOD, B_METAL, B_BUFF, B_CONCRETE_GROUND, B_CDS, B_LANCET = range(16)
BLANK_U = (0.03, 0.19)  # a window-free strip of every band, for short wall pieces


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [(0, 0, 0)] * (w * h)

    def put(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = c

    def get(self, x, y):
        return self.px[y * self.w + x]

    def rect(self, x0, y0, x1, y1, col, rng=None, jit=0):
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                if jit:
                    j = rng.uniform(-jit, jit)
                    self.px[y * self.w + x] = (col[0] + j, col[1] + j, col[2] + j)
                else:
                    self.px[y * self.w + x] = col

    def shade(self, x0, y0, x1, y1, f):
        for y in range(max(0, y0), min(self.h, y1)):
            for x in range(max(0, x0), min(self.w, x1)):
                c = self.px[y * self.w + x]
                self.px[y * self.w + x] = (c[0] * f, c[1] * f, c[2] * f)

    def png(self):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)
            for x in range(self.w):
                r, g, b = self.px[y * self.w + x]
                raw.extend((max(0, min(255, int(round(r)))), max(0, min(255, int(round(g)))), max(0, min(255, int(round(b))))))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)) +
                chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def paint_brick(cv, oy, base, mortar, rng, x0=0, x1=TEX_W, y0=0, y1=BAND_H, var=10):
    tones = {}
    for y in range(y0, y1):
        course = y // 4
        off = (course % 2) * 4
        for x in range(x0, x1):
            if y % 4 == 3 or (x + off) % 9 == 8:
                c = mortar
                j = rng.uniform(-3, 3)
            else:
                key = (course, (x + off) // 9)
                if key not in tones:
                    tones[key] = rng.uniform(-var, var)
                j = tones[key] + rng.uniform(-2.5, 2.5)
                c = base
            cv.put(x, oy + y, (c[0] + j, c[1] + j * 0.8, c[2] + j * 0.7))


def paint_stone(cv, oy, base, joint, rng, course=16, block=32, y0=0, y1=BAND_H, var=4):
    for y in range(y0, y1):
        row = y // course
        off = (row % 2) * (block // 2)
        for x in range(TEX_W):
            if y % course == course - 1 or (x + off) % block == block - 1:
                c = joint
            else:
                c = base
            j = rng.uniform(-var, var)
            cv.put(x, oy + y, (c[0] + j, c[1] + j, c[2] + j))


def paint_glass(cv, oy, x0, y0, x1, y1, top, bottom, rng, streak=True):
    for y in range(y0, y1):
        t = (y - y0) / max(1, y1 - y0 - 1)
        base = mix(top, bottom, t)
        for x in range(x0, x1):
            c = base
            if streak and ((x - x0) + (y - y0) * 0.7) % 46 < 9:
                c = (c[0] + 14, c[1] + 15, c[2] + 16)
            j = rng.uniform(-1.5, 1.5)
            cv.put(x, oy + y, (c[0] + j, c[1] + j, c[2] + j))


def paint_window(cv, oy, x0, y0, x1, y1, frame, top, bottom, rng, fw=2, cols=1, rows=1):
    cv.rect(x0, oy + y0, x1, oy + y1, frame)
    paint_glass(cv, oy, x0 + fw, y0 + fw, x1 - fw, y1 - fw, top, bottom, rng)
    for k in range(1, cols + 1):
        mx = x0 + (x1 - x0) * k // (cols + 1)
        cv.rect(mx - 1, oy + y0, mx + 1, oy + y1, frame)
    for k in range(1, rows + 1):
        my = y0 + (y1 - y0) * k // (rows + 1)
        cv.rect(x0, oy + my - 1, x1, oy + my + 1, frame)
    cv.shade(x0 + fw, oy + y0 + fw, x1 - fw, oy + y0 + fw + 3, 0.6)  # reveal shadow under the head


def pointed_halfwidth(y, top, spring, half):
    """Half-width of a pointed (gothic) arch at row y; the arch rises from `spring` up to `top`."""
    if y >= spring:
        return half
    t = (spring - y) / max(1, spring - top)
    return half * max(0.0, math.sqrt(max(0.0, 1 - t * t)) * (1 - 0.35 * t))


def paint_lancet(cv, oy, cx, top, spring, bottom, half, stone, glass_top, glass_bot, rng, mullion=True, transoms=()):
    mould = (stone[0] * 0.8, stone[1] * 0.8, stone[2] * 0.8)
    for y in range(top - 1, bottom + 1):
        hw = pointed_halfwidth(y, top, spring, half + 1.5)
        for x in range(int(cx - hw), int(cx + hw) + 1):
            cv.put(x, oy + y, mould)
    for y in range(top, bottom):
        hw = pointed_halfwidth(y, top, spring, half)
        t = (y - top) / max(1, bottom - top)
        for x in range(int(round(cx - hw)), int(round(cx + hw))):
            c = mix(glass_top, glass_bot, t)
            j = rng.uniform(-2, 2)
            cv.put(x, oy + y, (c[0] + j, c[1] + j, c[2] + j))
    if mullion:
        cv.rect(int(cx) - 1, oy + top + 4, int(cx) + 1, oy + bottom, stone)
    for ty in transoms:
        hw = int(pointed_halfwidth(ty, top, spring, half))
        cv.rect(int(cx) - hw, oy + ty, int(cx) + hw, oy + ty + 2, stone)
    cv.rect(int(cx - half - 3), oy + bottom, int(cx + half + 3), oy + bottom + 3, (stone[0] * 1.04, stone[1] * 1.04, stone[2] * 1.04))


def make_atlas():
    rng = random.Random(11)
    cv = Canvas(TEX_W, BAND_H * NBANDS)
    glass_t, glass_b = (66, 80, 96), (34, 42, 54)
    stone = (206, 197, 178)

    # 0 red-brown brick, sash window with stone lintel and sill
    oy = B_BRICK * BAND_H
    paint_brick(cv, oy, (142, 72, 55), (168, 150, 136), rng)
    cv.rect(33, oy + 8, 95, oy + 13, stone, rng, 3)
    paint_window(cv, oy, 38, 13, 90, 52, (226, 222, 212), glass_t, glass_b, rng, fw=3, cols=1, rows=1)
    cv.rect(34, oy + 52, 94, oy + 56, stone, rng, 3)
    cv.shade(34, oy + 56, 94, oy + 58, 0.75)
    cv.rect(0, oy + 61, TEX_W, oy + 64, (128, 66, 52), rng, 2)

    # 1 brick ground floor: darker brick over a granite base course, larger window
    oy = B_BRICK_GROUND * BAND_H
    paint_brick(cv, oy, (124, 62, 49), (150, 136, 124), rng)
    cv.rect(30, oy + 6, 98, oy + 11, stone, rng, 3)
    paint_window(cv, oy, 34, 11, 94, 49, (222, 218, 208), glass_t, glass_b, rng, fw=3, cols=2, rows=0)
    cv.rect(0, oy + 52, TEX_W, oy + 64, (118, 114, 108), rng, 4)
    cv.rect(0, oy + 52, TEX_W, oy + 54, (140, 136, 130))

    # 2 brownstone: chocolate sandstone, tall narrow window, carved lintel
    oy = B_BROWNSTONE * BAND_H
    paint_stone(cv, oy, (116, 82, 66), (98, 68, 55), rng, course=16, block=40, var=5)
    cv.rect(40, oy + 2, 88, oy + 8, (136, 100, 82), rng, 3)
    cv.rect(40, oy + 8, 88, oy + 9, (80, 56, 46))
    paint_window(cv, oy, 45, 9, 83, 54, (58, 50, 44), glass_t, glass_b, rng, fw=3, cols=0, rows=1)
    cv.rect(42, oy + 54, 86, oy + 58, (134, 98, 80), rng, 3)

    # 3 limestone (collegiate gothic): ashlar with paired pointed windows
    oy = B_LIME * BAND_H
    paint_stone(cv, oy, stone, (184, 175, 156), rng, course=16, block=32)
    paint_lancet(cv, oy, 64, 8, 22, 54, 17, stone, (60, 70, 84), (38, 45, 56), rng, transoms=(36,))
    cv.rect(0, oy + 61, TEX_W, oy + 64, (190, 181, 162))

    # 4 limestone ground: rusticated base with round-arched windows
    oy = B_LIME_GROUND * BAND_H
    paint_stone(cv, oy, (196, 187, 168), (160, 151, 134), rng, course=8, block=40)
    for y in range(10, 56):
        hw = 22 if y >= 32 else math.sqrt(max(0, 22 * 22 - (32 - y) ** 2))
        for x in range(int(64 - hw - 2), int(64 + hw + 2)):
            cv.put(x, oy + y, (176, 168, 150))
    for y in range(12, 56):
        hw = 20 if y >= 32 else math.sqrt(max(0, 20 * 20 - (32 - y) ** 2))
        t = (y - 12) / 44
        for x in range(int(64 - hw), int(64 + hw)):
            c = mix((62, 72, 86), (36, 43, 54), t)
            cv.put(x, oy + y, c)
    cv.rect(63, oy + 14, 65, oy + 56, (176, 168, 150))
    cv.rect(0, oy + 56, TEX_W, oy + 64, (150, 144, 132), rng, 3)

    # 5 glass curtain wall: two lites per bay, mullions, opaque spandrel
    oy = B_GLASS * BAND_H
    paint_glass(cv, oy, 0, 0, TEX_W, 49, (104, 130, 148), (70, 92, 112), rng)
    cv.rect(0, oy + 49, TEX_W, oy + 64, (112, 124, 136), rng, 2)
    cv.rect(0, oy + 47, TEX_W, oy + 50, (68, 74, 82))
    cv.rect(0, oy, 3, oy + 64, (68, 74, 82))
    cv.rect(63, oy, 66, oy + 64, (68, 74, 82))
    cv.rect(0, oy + 62, TEX_W, oy + 64, (82, 88, 96))

    # 6 glass lobby: tall glazing with a warm-lit interior
    oy = B_LOBBY * BAND_H
    for y in range(6, 64):
        t = (y - 6) / 58
        for x in range(TEX_W):
            c = mix((112, 112, 108), (172, 150, 116), t)
            if (x + y * 0.5) % 52 < 12:
                c = mix(c, (150, 164, 176), 0.45)
            cv.put(x, oy + y, c)
    cv.rect(0, oy, TEX_W, oy + 6, (50, 52, 56))
    for x0 in (0, 42, 85):
        cv.rect(x0, oy, x0 + 3, oy + 64, (50, 52, 56))
    cv.rect(0, oy + 30, TEX_W, oy + 32, (60, 62, 66))

    # 7 board-formed concrete: piers, deep-set window, spandrel
    oy = B_CONCRETE * BAND_H
    for y in range(BAND_H):
        for x in range(TEX_W):
            j = ((x * 7) % 5) - 2 + rng.uniform(-3, 3)
            cv.put(x, oy + y, (172 + j, 166 + j, 156 + j))
    cv.rect(0, oy, 18, oy + 64, (190, 184, 174), rng, 3)
    cv.rect(110, oy, 128, oy + 64, (190, 184, 174), rng, 3)
    cv.rect(18, oy, 21, oy + 64, (136, 130, 122))
    cv.rect(22, oy + 8, 106, oy + 15, (54, 56, 60))
    paint_glass(cv, oy, 22, 15, 106, 46, (60, 70, 84), (36, 44, 54), rng)
    cv.rect(63, oy + 15, 65, oy + 46, (90, 92, 96))
    cv.rect(20, oy + 46, 108, oy + 50, (200, 194, 184))

    # 8 modernist band (Mugar, GSU): concrete fascia, ribbon window, dark-brick spandrel
    oy = B_MODERN * BAND_H
    cv.rect(0, oy, TEX_W, oy + 11, (186, 180, 170), rng, 3)
    cv.rect(0, oy + 11, TEX_W, oy + 13, (120, 116, 110))
    paint_glass(cv, oy, 0, 13, TEX_W, 44, (58, 68, 82), (32, 40, 50), rng)
    for x0 in (0, 32, 64, 96):
        cv.rect(x0, oy + 13, x0 + 2, oy + 44, (112, 112, 114))
    cv.rect(0, oy + 44, TEX_W, oy + 47, (176, 170, 160))
    paint_brick(cv, oy, (102, 68, 56), (124, 104, 92), rng, y0=47, y1=64, var=6)

    # 9 storefront: sign band, display glass with a lit interior, kick plate
    oy = B_SHOP * BAND_H
    cv.rect(0, oy, TEX_W, oy + 12, (60, 56, 54), rng, 2)
    cv.rect(0, oy + 10, TEX_W, oy + 12, (92, 88, 84))
    for y in range(12, 58):
        t = (y - 12) / 46
        for x in range(TEX_W):
            c = mix((132, 140, 146), (190, 160, 116), t)
            if (x + y * 0.6) % 60 < 10:
                c = mix(c, (176, 186, 194), 0.5)
            cv.put(x, oy + y, c)
    for x0 in (0, 64):
        cv.rect(x0, oy + 12, x0 + 3, oy + 64, (44, 44, 46))
    cv.rect(0, oy + 58, TEX_W, oy + 64, (74, 70, 66))

    # 10 painted clapboard (boathouses): siding, trimmed window, shutters
    oy = B_WOOD * BAND_H
    for y in range(BAND_H):
        c = (198, 188, 164) if y % 5 else (166, 156, 134)
        cv.rect(0, oy + y, TEX_W, oy + y + 1, c, rng, 2)
    paint_window(cv, oy, 46, 14, 82, 50, (234, 232, 224), glass_t, glass_b, rng, fw=3, cols=1, rows=1)
    cv.rect(37, oy + 14, 45, oy + 50, (54, 78, 62), rng, 2)
    cv.rect(83, oy + 14, 91, oy + 50, (54, 78, 62), rng, 2)

    # 11 ribbed metal panel with a ribbon window
    oy = B_METAL * BAND_H
    for x in range(TEX_W):
        m = x % 8
        c = (130, 136, 142) if m < 2 else (178, 184, 190) if m == 2 else (156, 162, 168)
        cv.rect(x, oy, x + 1, oy + 64, c)
    paint_glass(cv, oy, 0, 20, TEX_W, 33, (64, 76, 90), (42, 50, 62), rng)

    # 12 buff brick (mid-century): aluminium window, concrete sill
    oy = B_BUFF * BAND_H
    paint_brick(cv, oy, (182, 146, 110), (198, 186, 170), rng, var=7)
    paint_window(cv, oy, 36, 12, 92, 51, (84, 86, 90), glass_t, glass_b, rng, fw=2, cols=1, rows=0)
    cv.rect(34, oy + 51, 94, oy + 54, (196, 190, 180))

    # 13 concrete ground floor: piers around a recessed glazed base
    oy = B_CONCRETE_GROUND * BAND_H
    cv.rect(0, oy, TEX_W, oy + 64, (74, 74, 76))
    paint_glass(cv, oy, 18, 8, 110, 64, (96, 104, 110), (128, 118, 100), rng)
    cv.rect(0, oy, 18, oy + 64, (184, 178, 168), rng, 3)
    cv.rect(110, oy, 128, oy + 64, (184, 178, 168), rng, 3)
    cv.rect(18, oy, 110, oy + 8, (52, 52, 54))
    cv.rect(62, oy + 8, 65, oy + 64, (60, 62, 66))

    # 14 CDS: white slab edge, pale blue-green glass, frit line, light mullions
    oy = B_CDS * BAND_H
    paint_glass(cv, oy, 0, 6, TEX_W, 64, (126, 158, 170), (88, 116, 132), rng)
    cv.rect(0, oy, TEX_W, oy + 6, (236, 238, 236))
    cv.rect(0, oy + 33, TEX_W, oy + 36, (214, 220, 222))
    for x0 in (0, 32, 64, 96):
        cv.rect(x0, oy + 6, x0 + 2, oy + 64, (204, 208, 212))

    # 15 tall gothic lancet (chapel nave, towers): one window spanning the band
    oy = B_LANCET * BAND_H
    paint_stone(cv, oy, stone, (184, 175, 156), rng, course=8, block=24)
    paint_lancet(cv, oy, 64, 3, 20, 58, 15, stone, (66, 72, 92), (40, 44, 60), rng, transoms=(30, 44))

    return cv


ATLAS = make_atlas()


def band_average(band, x0=3, x1=24):
    oy = band * BAND_H
    n = 0
    s = [0.0, 0.0, 0.0]
    for y in range(oy, oy + BAND_H):
        for x in range(x0, x1):
            c = ATLAS.get(x, y)
            s[0] += c[0]
            s[1] += c[1]
            s[2] += c[2]
            n += 1
    return tuple(v / n for v in s)


# ------------------------------------------------------------------------------------------------
# Styles and materials
# ------------------------------------------------------------------------------------------------

STYLES = {
    #              upper band     ground band         bay width  family       cornice
    "brick":      (B_BRICK,       B_BRICK_GROUND,     2.9,       "brick",     "stone"),
    "brownstone": (B_BROWNSTONE,  B_BROWNSTONE,       2.4,       "brownstone", "brown"),
    "rowbrick":   (B_BRICK,       B_BRICK,            2.4,       "brick",     "stone"),
    "rowlime":    (B_LIME,        B_LIME_GROUND,      2.6,       "limestone", "stone"),
    "limestone":  (B_LIME,        B_LIME_GROUND,      3.3,       "limestone", "stone"),
    "gothic":     (B_LIME,        B_LIME_GROUND,      3.3,       "limestone", "stone"),
    "glass":      (B_GLASS,       B_LOBBY,            3.0,       "glass",     "metal"),
    "cds":        (B_CDS,         B_LOBBY,            3.2,       "glass",     "white"),
    "concrete":   (B_CONCRETE,    B_CONCRETE_GROUND,  2.8,       "concrete",  "concrete"),
    "modern":     (B_MODERN,      B_LOBBY,            3.4,       "modern",    "concrete"),
    "buff":       (B_BUFF,        B_BUFF,             3.0,       "buff",      "concrete"),
    "metal":      (B_METAL,       B_METAL,            4.0,       "metal",     "metal"),
    "wood":       (B_WOOD,        B_WOOD,             3.0,       "wood",      "white"),
}

# Plain (untextured) materials, sRGB colours.
PLAIN = {
    "trim_stone": (212, 204, 188), "trim_brown": (104, 76, 62), "trim_white": (234, 234, 230),
    "trim_metal": (92, 96, 102), "trim_concrete": (190, 186, 178),
    "roof_dark": (84, 84, 86), "roof_light": (164, 164, 160), "roof_gravel": (124, 120, 114),
    "slate": (74, 78, 88), "roof_green": (96, 122, 74), "roof_metal": (176, 182, 188),
    "roof_copper": (104, 146, 128), "mech": (156, 158, 160), "door": (56, 42, 34),
    "glass_dark": (42, 50, 62), "stone": (176, 168, 152), "chimney": (128, 66, 52),
}
FAMILY_BAND = {"brick": B_BRICK, "brownstone": B_BROWNSTONE, "limestone": B_LIME, "glass": B_GLASS,
               "concrete": B_CONCRETE, "modern": B_MODERN, "buff": B_BUFF, "metal": B_METAL, "wood": B_WOOD}
for fam, band in FAMILY_BAND.items():
    PLAIN["wall_" + fam] = band_average(band)
PLAIN["wall_glass"] = (84, 104, 122)
PLAIN["wall_modern"] = band_average(B_MODERN, 0, 128)
CORNICE_MAT = {"stone": "trim_stone", "brown": "trim_brown", "white": "trim_white", "metal": "trim_metal",
               "concrete": "trim_concrete"}
# Textured facade materials share the atlas; small tints vary neighbouring buildings.
FACADE_TINTS = [(255, 255, 255), (238, 233, 226), (252, 242, 230), (230, 231, 236)]
GLASS_TINTS = [(255, 255, 255), (232, 242, 250)]


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material_defs():
    mats = []
    for i, t in enumerate(FACADE_TINTS):
        mats.append({"name": f"facade_{i}", "color": t, "texture": True, "rough": 0.88, "metal": 0.0})
    for i, t in enumerate(GLASS_TINTS):
        mats.append({"name": f"glassfacade_{i}", "color": t, "texture": True, "rough": 0.38, "metal": 0.15})
    for name, c in PLAIN.items():
        rough, metal = 0.9, 0.0
        if name in ("roof_metal", "mech", "trim_metal"):
            rough, metal = 0.55, 0.25
        if name in ("glass_dark", "wall_glass"):
            rough, metal = 0.35, 0.1
        mats.append({"name": name, "color": c, "texture": False, "rough": rough, "metal": metal})
    return mats


MATERIALS = material_defs()
MAT_INDEX = {m["name"]: i for i, m in enumerate(MATERIALS)}
TEXTURED = {m["name"] for m in MATERIALS if m["texture"]}


def h32(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


# ------------------------------------------------------------------------------------------------
# Mesh builder (model space: x east, y up, z south)
# ------------------------------------------------------------------------------------------------

class Prim:
    def __init__(self, textured):
        self.pos = array.array("f")
        self.nrm = array.array("f")
        self.uv = array.array("f") if textured else None
        self.idx = array.array("I")
        self.n = 0


class Mesh:
    def __init__(self):
        self.prims = {}

    def prim(self, mat):
        p = self.prims.get(mat)
        if p is None:
            p = self.prims[mat] = Prim(mat in TEXTURED)
        return p

    def face(self, mat, pts, uvs=None):
        """A planar convex polygon (3D points, CCW seen from the front), fan-triangulated."""
        nx = ny = nz = 0.0
        n = len(pts)
        for i in range(n):
            x1, y1, z1 = pts[i]
            x2, y2, z2 = pts[(i + 1) % n]
            nx += (y1 - y2) * (z1 + z2)
            ny += (z1 - z2) * (x1 + x2)
            nz += (x1 - x2) * (y1 + y2)
        L = math.sqrt(nx * nx + ny * ny + nz * nz)
        if L < 1e-9:
            return
        nx, ny, nz = nx / L, ny / L, nz / L
        p = self.prim(mat)
        base = p.n
        for k, q in enumerate(pts):
            p.pos.extend(q)
            p.nrm.extend((nx, ny, nz))
            if p.uv is not None:
                p.uv.extend(uvs[k] if uvs else (0.5, 0.5))
        for k in range(1, n - 1):
            p.idx.extend((base, base + k, base + k + 1))
        p.n += n

    def wall(self, mat, a, b, y0, y1, uv=None):
        """Vertical quad over 2D edge a->b (outside is to the right of a->b)."""
        P0, Q0 = (a[0], y0, -a[1]), (b[0], y0, -b[1])
        Q1, P1 = (b[0], y1, -b[1]), (a[0], y1, -a[1])
        if uv:
            u0, u1, v0, v1 = uv  # v0 at y0 (bottom), v1 at y1 (top)
            self.face(mat, [P0, Q0, Q1, P1], [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
        else:
            self.face(mat, [P0, Q0, Q1, P1])

    def flat(self, mat, rings, y, up=True):
        """Horizontal polygon with holes at height y."""
        pts, tris = triangulate(rings)
        if not tris:
            return
        p = self.prim(mat)
        base = p.n
        for q in pts:
            p.pos.extend((q[0], y, -q[1]))
            p.nrm.extend((0.0, 1.0 if up else -1.0, 0.0))
            if p.uv is not None:
                p.uv.extend((0.5, 0.5))
        for k in range(0, len(tris), 3):
            a, b, c = tris[k], tris[k + 1], tris[k + 2]
            ax, ay = pts[a]
            bx, by = pts[b]
            cx, cy = pts[c]
            ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0  # CCW in (east, north) = facing up
            if ccw != up:
                b, c = c, b
            p.idx.extend((base + a, base + b, base + c))
        p.n += len(pts)

    def sloped(self, mat, poly, height_fn):
        """Triangulated 2D polygon lifted onto a plane (height_fn linear), facing up."""
        pts, tris = triangulate([poly])
        for k in range(0, len(tris), 3):
            tri = [pts[tris[k]], pts[tris[k + 1]], pts[tris[k + 2]]]
            (ax, ay), (bx, by), (cx, cy) = tri
            if (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0:
                tri = [tri[0], tri[2], tri[1]]
            self.face(mat, [(q[0], height_fn(q), -q[1]) for q in tri])

    def box(self, mat, c, eu, hu, hv, y0, y1, top_mat=None, bottom=False):
        """Oriented box: centre c, unit axis eu, half sizes hu (along eu) and hv."""
        ev = (-eu[1], eu[0])
        corners = [(c[0] + sx * hu * eu[0] + sy * hv * ev[0], c[1] + sx * hu * eu[1] + sy * hv * ev[1])
                   for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]  # CCW
        self.prism(mat, corners, y0, y1, top_mat or mat, bottom)

    def prism(self, mat, ring, y0, y1, top_mat=None, bottom=False):
        ring = oriented(ring, True)
        n = len(ring)
        for i in range(n):
            self.wall(mat, ring[i], ring[(i + 1) % n], y0, y1)
        if top_mat:
            self.flat(top_mat, [ring], y1, True)
        if bottom:
            self.flat(mat, [ring], y0, False)

    def pyramid(self, mat, ring, y0, apex):
        ring = oriented(ring, True)
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        n = len(ring)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            self.face(mat, [(a[0], y0, -a[1]), (b[0], y0, -b[1]), (cx, apex, -cy)])

    def vert_count(self):
        return sum(p.n for p in self.prims.values())


def band_v(band):
    """(v at storey bottom, v at storey top). glTF v=0 is the top row of the image."""
    pad = 0.6 / (BAND_H * NBANDS)
    return ((band + 1) / NBANDS - pad, band / NBANDS + pad)


# ------------------------------------------------------------------------------------------------
# Building selection
# ------------------------------------------------------------------------------------------------

class Building:
    def __init__(self, el, campus):
        self.el = el
        self.ref = f"{el['type']}/{el['id']}"
        self.tags = el.get("tags", {})
        self.name = self.tags.get("name")
        self.campus = campus
        self.rings_ll = element_rings(el)
        self.parts = []


def is_bu_tagged(tags):
    return any(BU_NAME.search(str(tags.get(k, ""))) for k in ("operator", "owner", "name", "alt_name", "official_name"))


def foreign_operator(tags):
    op = tags.get("operator") or tags.get("owner")
    return bool(op) and not BU_NAME.search(op)


def select_buildings(charles, medical, areas):
    def area_rings(ref):
        return [o for o, _ in areas[ref]]

    def inside(ref, pt):
        return any(point_in_ring(pt, r) for r in area_rings(ref))

    chosen = {}
    parts = []
    for elements, region in ((charles, "charles"), (medical, "medical")):
        for el in elements:
            tags = el.get("tags", {})
            rings = element_rings(el)
            if not rings:
                continue
            ref = f"{el['type']}/{el['id']}"
            if "building" not in tags:
                if tags.get("building:part") and tags["building:part"] not in PART_SKIP:
                    parts.append(el)
                continue
            btype = tags["building"]
            c = ring_centroid(rings[0][0])
            if region == "medical":
                if not any(inside(a, c) for a in MEDICAL_AREAS):
                    continue
                if foreign_operator(tags):
                    continue
                small_area = inside("way/812987474", c)
                # Untagged institutional blocks on the BU campus area (BioSquare, 670/650 Albany...)
                local = [(p[0] * 82000, p[1] * 111000) for p in rings[0][0]]
                big_block = (btype == "yes" and abs(signed_area(local)) > 900 and tags.get("amenity") != "parking"
                             and "East Brookline" not in tags.get("addr:street", "") and not tags.get("name", "").startswith("Hampton"))
                if not (btype in ("university", "college", "dormitory") or is_bu_tagged(tags) or ref in MEDICAL_EXTRA
                        or small_area or big_block):
                    continue
                campus = "medical"
            else:
                in_fenway = any(inside(a, c) for a in FENWAY_AREAS)
                in_main = inside(BU_MAIN, c)
                if not (in_fenway or in_main or is_bu_tagged(tags) or ref in EXTRA_IDS):
                    continue
                if foreign_operator(tags):
                    continue
                if btype in HOUSE_TYPES and "Bay State Road" not in tags.get("addr:street", ""):
                    continue
                campus = "fenway" if in_fenway else "charles-river"
            if btype in SKIP_TYPES or tags.get("amenity") in SKIP_AMENITY:
                continue
            chosen.setdefault(ref, Building(el, campus))
    # building:part pieces belong to the building whose outline holds their centre.
    for el in parts:
        rings = element_rings(el)
        c = ring_centroid(rings[0][0])
        for b in chosen.values():
            if b.rings_ll and any(point_in_ring(c, o) for o, _ in b.rings_ll):
                b.parts.append(el)
                break
    return list(chosen.values())


# ------------------------------------------------------------------------------------------------
# Heights
# ------------------------------------------------------------------------------------------------

def num(v):
    if v is None:
        return None
    m = re.match(r"\s*([0-9.]+)", str(v))
    return float(m.group(1)) if m else None


DEFAULT_LEVELS = {"dormitory": 4, "apartments": 4, "residential": 4, "house": 4, "university": 4, "college": 4,
                  "retail": 2, "commercial": 2, "church": 4, "boathouse": 2, "grandstand": 2, "parking": 4,
                  "office": 5, "hotel": 5, "roof": 1, "bridge": 3}


def tag_height(tags, parent=None):
    """(height m, levels, min_height m) from OSM tags; falls back to the parent's or type defaults."""
    h = num(tags.get("height"))
    lv = num(tags.get("building:levels"))
    mh = num(tags.get("min_height")) or 0.0
    if h is None and lv is not None:
        h = lv * METRES_PER_LEVEL + (num(tags.get("roof:levels")) or 0) * 0.0
    if h is None and parent is not None:
        h = parent[0]
        lv = lv or parent[1]
    if h is None:
        lv = DEFAULT_LEVELS.get(tags.get("building", ""), 3)
        h = lv * METRES_PER_LEVEL
    if lv is None:
        lv = max(1, round((h - mh) / METRES_PER_LEVEL))
    return h, lv, mh


# ------------------------------------------------------------------------------------------------
# Styles per building
# ------------------------------------------------------------------------------------------------

# Hand-curated styles for buildings whose OSM tags don't say what they're made of.
STYLE_BY_ID = {
    # Collegiate gothic limestone around Marsh Plaza
    "way/1007090939": "gothic", "way/1007090937": "gothic", "way/1007090933": "gothic",
    "way/1007090940": "limestone", "way/1007090941": "limestone", "way/29922737": "limestone",
    "way/337210330": "limestone", "way/29680728": "limestone", "way/822625894": "limestone",
    "way/29887049": "gothic", "way/485223500": "limestone", "way/29631663": "limestone",
    "way/822626746": "limestone",
    # Glass and steel
    "way/277434241": "cds", "way/29927783": "glass", "way/155291470": "glass", "way/337489367": "glass",
    "way/697017104": "glass", "way/697017102": "glass", "way/697017103": "glass", "way/825285416": "glass",
    "way/102385045": "glass", "way/29513001": "glass", "way/1188211556": "glass", "way/212124942": "glass",
    "way/29888004": "glass",
    # Concrete (brutalism and its neighbours)
    "relation/20512578": "concrete", "way/485223499": "concrete", "way/316156067": "concrete",
    "way/277435862": "concrete", "way/29904697": "concrete", "way/1160558564": "concrete",
    "way/29650907": "concrete", "way/29638497": "concrete",
    # Sert's modernist banded boxes
    "way/130209089": "modern", "way/130209090": "modern", "way/29579939": "modern",
    # Mid-century buff brick
    "way/29889456": "buff", "way/813732836": "buff", "way/29680668": "buff", "way/242272535": "buff",
    "way/29557600": "brick", "way/29863053": "buff", "way/1007090933x": "buff",
    # Metal sheds
    "way/29930171": "metal", "way/29680684": "metal",
}
LANDMARKS = {
    "way/277434241": "cds", "way/1007090937": "chapel", "relation/20512578": "warren",
    "way/29927783": "stuvi", "way/155291470": "stuvi", "way/102384832": "arena",
    "way/1007090939": "cas", "way/130209089": "mugar", "way/130209090": "gsu", "way/485223499": "lawtower",
}
ROWHOUSE_STREETS = ("Bay State Road", "Buswell Street", "Park Drive", "Mountfort Street", "Beacon Street",
                    "Euston Street", "Ivy Street", "Saint Mary's Street", "Raleigh Street", "Deerfield Street",
                    "Commonwealth Avenue", "Carlton Street", "Pilgrim Road", "Riverway")


def colour_style(c):
    c = c.lower().strip()
    named = {"white": "limestone", "beige": "buff", "cream": "limestone", "grey": "concrete", "gray": "concrete",
             "brown": "brownstone", "red": "brick", "darkred": "brick", "maroon": "brick", "tan": "buff",
             "yellow": "buff", "blue": "glass", "lightblue": "glass", "black": "glass", "silver": "metal"}
    if c in named:
        return named[c]
    m = re.match(r"#?([0-9a-f]{6})$", c)
    if not m:
        return None
    r, g, b = (int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))
    if b > r + 15:
        return "glass"
    if max(r, g, b) - min(r, g, b) < 25:
        return "limestone" if r > 170 else "concrete"
    return "brick" if r > g + 40 else "buff"


def style_for(b, area, levels):
    tags = b.tags
    if b.ref in STYLE_BY_ID:
        return STYLE_BY_ID[b.ref]
    mat = tags.get("building:material", "").lower()
    if mat:
        s = {"brick": "brick", "stone": "limestone", "limestone": "limestone", "sandstone": "brownstone",
             "glass": "glass", "concrete": "concrete", "metal": "metal", "steel": "glass", "wood": "wood",
             "timber_framing": "wood", "plaster": "limestone"}.get(mat)
        if s:
            if s == "brick" and is_rowhouse(b, area, levels):
                return "rowbrick"
            return s
    col = tags.get("building:colour")
    if col and colour_style(col):
        return colour_style(col)
    if tags.get("building") in ("boathouse",):
        return "wood"
    if is_rowhouse(b, area, levels):
        k = h32(b.ref) % 20
        if "Bay State Road" in tags.get("addr:street", ""):
            return "brownstone" if k < 8 else "rowlime" if k < 11 else "rowbrick"
        return "brownstone" if k < 4 else "rowbrick"
    if b.campus == "medical":
        return ("brick", "concrete", "buff", "brick", "glass")[h32(b.ref) % 5]
    if tags.get("building") in ("retail", "commercial"):
        return "brick"
    return "brick" if h32(b.ref) % 7 else "buff"


def is_rowhouse(b, area, levels):
    street = b.tags.get("addr:street", "")
    return (area < 650 and levels <= 6 and any(s in street for s in ROWHOUSE_STREETS)
            and b.tags.get("building") in ("apartments", "dormitory", "residential", "house", "yes", "university"))


# ------------------------------------------------------------------------------------------------
# The generic building
# ------------------------------------------------------------------------------------------------

WALL_OUT = 0.3      # model walls sit this far outside the OSM footprint
ROOF_UP = 0.5       # and the roof this far above the height Mapbox extrudes
# Optional extra clearance per metre of height. Not needed: buildings.ts gives the layer a polygon
# offset that matches the depth step Mapbox applies to its own buildings.
OUT_PER_M = 0.0
UP_PER_M = 0.0


def wall_out(top):
    return WALL_OUT + OUT_PER_M * max(0.0, top)


def roof_up(top):
    return ROOF_UP + UP_PER_M * max(0.0, top)


class Ctx:
    """Per-campus lookups: every OSM footprint (to find party walls) and the street network."""

    def __init__(self, frame, all_footprints, streets):
        self.frame = frame
        self.cell = 40.0
        self.grid = {}
        for key, rings in all_footprints:
            xs = [p[0] for p in rings[0]]
            ys = [p[1] for p in rings[0]]
            for gx in range(int(math.floor(min(xs) / self.cell)), int(math.floor(max(xs) / self.cell)) + 1):
                for gy in range(int(math.floor(min(ys) / self.cell)), int(math.floor(max(ys) / self.cell)) + 1):
                    self.grid.setdefault((gx, gy), []).append((key, rings))
        self.streets = streets  # [(name, [(x, y), ...])]

    def footprint_at(self, p, exclude=()):
        for key, rings in self.grid.get((int(math.floor(p[0] / self.cell)), int(math.floor(p[1] / self.cell))), ()):
            if key in exclude:
                continue
            if poly_contains(rings, p):
                return key
        return None

    def nearest_street(self, p, name=None):
        best = (1e9, None)
        for sname, line in self.streets:
            if name and sname != name:
                continue
            for a, b in zip(line, line[1:]):
                if abs(a[0] - p[0]) > 150 and abs(b[0] - p[0]) > 150:
                    continue
                d, q = point_seg_dist(p, a, b)
                if d < best[0]:
                    best = (d, q)
        return best


class Volume:
    """One extruded piece of a building: footprint rings (raw OSM, local metres), base and top."""

    def __init__(self, key, rings, base, top, levels, style, roof="flat", party=True, ground=True):
        self.key = key
        self.rings = rings
        self.base = base
        self.top = top
        self.levels = levels
        self.style = style
        self.roof = roof
        self.party = party
        self.ground = ground and base < 0.5
        self.door = True
        self.cornice = True
        self.parapet = 0.9
        self.mech = True
        self.bays = False
        self.stoop = False
        self.chimneys = False
        self.mansard = 2.6
        self.roof_mat = None
        self.fascia = False
        self.merlons = False
        self.terrace = False


def storey_lines(v, y0, y1):
    n = max(1, int(v.levels))
    if n == 1:
        return [y0, y1]
    g = (y1 - y0) / n
    if v.ground and v.style not in ("brownstone", "rowbrick", "rowlime", "wood"):
        g = min(5.0, g * 1.25)
    ys = [y0, y0 + g]
    rest = (y1 - ys[1]) / (n - 1)
    for k in range(1, n):
        ys.append(ys[1] + rest * k)
    ys[-1] = y1
    return ys


def facade_mats(v):
    upper, ground, bay, family, cornice = STYLES[v.style]
    glassy = family == "glass"
    tints = GLASS_TINTS if glassy else FACADE_TINTS
    mat = ("glassfacade_" if glassy else "facade_") + str(h32(v.key) % len(tints))
    return upper, ground, bay, family, cornice, mat


def edge_list(ring):
    n = len(ring)
    return [(ring[i], ring[(i + 1) % n]) for i in range(n)]


def build_walls(mesh, v, ctx, rings_o, y0, y1, exclude):
    """Textured storeys on every edge; party walls (against a neighbouring building) stay blank."""
    upper, ground, bay, family, _, mat = facade_mats(v)
    ys = storey_lines(v, y0, y1)
    info = []
    for ri, (raw, out) in enumerate(zip(v.rings, rings_o)):
        n = len(raw)
        for i in range(n):
            a, b = out[i], out[(i + 1) % n]
            ra, rb = raw[i], raw[(i + 1) % n]
            L = dist(a, b)
            if L < 0.05:
                continue
            nrm = right_normal(ra, rb)
            mid = ((ra[0] + rb[0]) / 2, (ra[1] + rb[1]) / 2)
            party = False
            if v.party:
                for t in (0.5, 0.2, 0.8):
                    probe = (ra[0] + (rb[0] - ra[0]) * t + nrm[0] * 1.2, ra[1] + (rb[1] - ra[1]) * t + nrm[1] * 1.2)
                    if ctx.footprint_at(probe, exclude):
                        party = True
                        break
            info.append({"a": a, "b": b, "ra": ra, "rb": rb, "L": L, "n": nrm, "mid": mid, "party": party, "outer": ri == 0})
            if party:
                mesh.wall("wall_" + family, a, b, y0, y1)
                continue
            if L < bay * 0.55:
                u0, u1 = BLANK_U
            else:
                u0, u1 = 0.0, float(max(1, round(L / bay)))
            for k in range(len(ys) - 1):
                band = ground if (k == 0 and v.ground) else upper
                vb, vt = band_v(band)
                mesh.wall(mat, a, b, ys[k], ys[k + 1], (u0, u1, vb, vt))
    return info, ys


def build_flat_top(mesh, v, rings_o, y_roof, edges, rng):
    """Parapet, cornice lip and roof slab."""
    upper, ground, bay, family, cornice, mat = facade_mats(v)
    trim = CORNICE_MAT[cornice]
    p = v.parapet
    lip = 0.15 if family == "glass" else 0.4
    ch = 0.35 if family == "glass" else 0.55
    top = y_roof + p
    rings_c = [offset_ring(r, lip) for r in rings_o]
    rings_in = v.rings
    for ro, rc, ri in zip(rings_o, rings_c, rings_in):
        n = len(ro)
        for i in range(n):
            j = (i + 1) % n
            if dist(ro[i], ro[j]) < 0.05:
                continue
            # frieze between the top storey and the cornice
            if top - ch > y_roof:
                mesh.wall("wall_" + family, ro[i], ro[j], y_roof, top - ch)
            if v.cornice:
                mesh.wall(trim, rc[i], rc[j], top - ch, top)
                # soffit under the lip (faces down)
                mesh.face(trim, [(ro[i][0], top - ch, -ro[i][1]), (ro[j][0], top - ch, -ro[j][1]),
                                 (rc[j][0], top - ch, -rc[j][1]), (rc[i][0], top - ch, -rc[i][1])])
                # cap from the lip back to the parapet's inner face
                mesh.face(trim, [(rc[i][0], top, -rc[i][1]), (rc[j][0], top, -rc[j][1]),
                                 (ri[j][0], top, -ri[j][1]), (ri[i][0], top, -ri[i][1])])
            else:
                mesh.wall("wall_" + family, ro[i], ro[j], top - ch, top)
                mesh.face(trim, [(ro[i][0], top, -ro[i][1]), (ro[j][0], top, -ro[j][1]),
                                 (ri[j][0], top, -ri[j][1]), (ri[i][0], top, -ri[i][1])])
            # inner face of the parapet (faces into the roof)
            mesh.wall("wall_" + family, ri[j], ri[i], y_roof, top)
    roof_mat = v.roof_mat or ("roof_dark", "roof_light", "roof_gravel")[h32(v.key + "r") % 3]
    mesh.flat(roof_mat, rings_in, y_roof, True)
    if v.merlons:
        for ro, ri in zip(rings_o, rings_in):
            n = len(ro)
            for i in range(n):
                a, b = ro[i], ro[(i + 1) % n]
                L = dist(a, b)
                k = int(L // 2.2)
                if k < 1:
                    continue
                eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
                nrm = right_normal(a, b)
                for m in range(k):
                    t = (m + 0.5) / k
                    c = (a[0] + (b[0] - a[0]) * t - nrm[0] * 0.15, a[1] + (b[1] - a[1]) * t - nrm[1] * 0.15)
                    mesh.box(trim, c, eu, 0.5, 0.32, top, top + 0.75)


def add_mech(mesh, v, rings, y_roof, rng):
    """Rooftop plant on tall flat roofs: boxes at the most interior points of the roof."""
    area = abs(signed_area(rings[0])) - sum(abs(signed_area(h)) for h in rings[1:])
    if v.top < 14 or area < 150:
        return
    centre, eu, ev, hu, hv = obb(rings[0])
    count = 1 + (area > 1200) + (area > 3000)
    if v.top < 22:
        count = 1
    cands = []
    steps = 14
    for i in range(steps):
        for j in range(steps):
            su = (i + 0.5) / steps * 2 - 1
            sv = (j + 0.5) / steps * 2 - 1
            p = (centre[0] + eu[0] * su * hu + ev[0] * sv * hv, centre[1] + eu[1] * su * hu + ev[1] * sv * hv)
            if poly_contains(rings, p):
                cands.append((min_edge_dist(rings, p), p))
    cands.sort(reverse=True)
    placed = []
    for d, p in cands:
        if len(placed) >= count:
            break
        if d < 2.5 or any(dist(p, q) < 10 for q in placed):
            continue
        s = min(d * 0.75, math.sqrt(area) * (0.16 if v.top < 22 else 0.22))
        su, sv = s * (0.9 + 0.5 * rng.random()), s * (0.6 + 0.3 * rng.random())
        su, sv = min(su, d * 0.8), min(sv, d * 0.8)
        hgt = 1.6 if v.top < 22 else 2.4 + 2.0 * rng.random()
        mesh.box("mech", p, eu, su, sv, y_roof, y_roof + hgt, top_mat="roof_metal")
        if v.top >= 30 and su > 3:
            # a cooling unit and a vent stack on the big ones
            mesh.box("trim_metal", (p[0] + eu[0] * su * 0.4, p[1] + eu[1] * su * 0.4), eu, su * 0.35, sv * 0.5,
                     y_roof + hgt, y_roof + hgt + 1.0, top_mat="glass_dark")
        placed.append(p)


def pitched_top(mesh, v, ring_o, y_eave, shape, rise=None):
    """Gabled / hipped / pyramidal / vaulted roof on the footprint's bounding rectangle."""
    _, _, _, family, cornice, _ = facade_mats(v)
    centre, eu, ev, hu, hv = obb(ring_o)
    if rise is None:
        rise = min(hv * (1.0 if shape == "gabled" else 0.8), 9.0)
    slope = rise / hv
    planes = []  # (gu, gv, h0) in OBB coords: h = h0 + gu*u + gv*v

    if shape in ("gabled", "saltbox"):
        planes = [(0, -slope, y_eave + rise), (0, slope, y_eave + rise)]
    elif shape in ("round", "vault", "barrel"):
        K = 8
        vs = [-hv + 2 * hv * k / K for k in range(K + 1)]
        hs = [y_eave + rise * math.sqrt(max(0.0, 1 - (x / hv) ** 2)) for x in vs]
        for k in range(K):
            g = (hs[k + 1] - hs[k]) / (vs[k + 1] - vs[k])
            planes.append((0, g, hs[k] - g * vs[k]))
    else:  # hipped, pyramidal, quadruple_saltbox, ...
        planes = [(0, -slope, y_eave + rise), (0, slope, y_eave + rise),
                  (-slope, 0, y_eave + slope * hu), (slope, 0, y_eave + slope * hu)]

    def to_xy(gu, gv, h0):
        gx = gu * eu[0] + gv * ev[0]
        gy = gu * eu[1] + gv * ev[1]
        return gx, gy, h0 - gx * centre[0] - gy * centre[1]

    xy = [to_xy(*p) for p in planes]

    def roof_h(p):
        return min(gx * p[0] + gy * p[1] + c for gx, gy, c in xy)

    mat = v.roof_mat or "slate"
    for i, (gx, gy, c) in enumerate(xy):
        poly = list(ring_o)
        for j, (hx, hy, d) in enumerate(xy):
            if i == j:
                continue
            poly = clip_halfplane(poly, gx - hx, gy - hy, c - d)
            if len(poly) < 3:
                break
        if len(poly) >= 3 and abs(signed_area(poly)) > 0.05:
            mesh.sloped(mat, poly, lambda q, gx=gx, gy=gy, c=c: gx * q[0] + gy * q[1] + c)
    # gable infill where the roof rises above the eave line along a wall
    wall_mat = "wall_" + family
    n = len(ring_o)
    for i in range(n):
        a, b = ring_o[i], ring_o[(i + 1) % n]
        ts = [0.0, 1.0]
        for p1 in range(len(xy)):
            for p2 in range(p1 + 1, len(xy)):
                g1, g2 = xy[p1], xy[p2]
                fa = (g1[0] - g2[0]) * a[0] + (g1[1] - g2[1]) * a[1] + g1[2] - g2[2]
                fb = (g1[0] - g2[0]) * b[0] + (g1[1] - g2[1]) * b[1] + g1[2] - g2[2]
                if (fa < 0 < fb) or (fb < 0 < fa):
                    ts.append(fa / (fa - fb))
        ts.sort()
        for t0, t1 in zip(ts, ts[1:]):
            if t1 - t0 < 1e-4:
                continue
            p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            p1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            h0, h1 = roof_h(p0), roof_h(p1)
            if h0 < y_eave + 0.02 and h1 < y_eave + 0.02:
                continue
            pts = [(p0[0], y_eave, -p0[1]), (p1[0], y_eave, -p1[1])]
            if h1 > y_eave + 0.02:
                pts.append((p1[0], h1, -p1[1]))
            if h0 > y_eave + 0.02:
                pts.append((p0[0], h0, -p0[1]))
            mesh.face(wall_mat, pts)
    # a slim fascia board along the eaves
    trim = CORNICE_MAT[cornice]
    ring_f = offset_ring(ring_o, 0.25)
    for i in range(n):
        a, b = ring_f[i], ring_f[(i + 1) % n]
        mesh.wall(trim, a, b, y_eave - 0.35, y_eave)
        mesh.face(trim, [(ring_o[i][0], y_eave - 0.35, -ring_o[i][1]), (ring_o[(i + 1) % n][0], y_eave - 0.35, -ring_o[(i + 1) % n][1]),
                         (b[0], y_eave - 0.35, -b[1]), (a[0], y_eave - 0.35, -a[1])])
    return max(roof_h(p) for p in ring_o + [centre])


def mansard_top(mesh, v, rings_o, y_eave, front_edges):
    """Brownstone mansard: steep slate slopes up to a flat top, dormers on the street side."""
    _, _, _, family, cornice, _ = facade_mats(v)
    ring = rings_o[0]
    centre, eu, ev, hu, hv = obb(ring)
    d = min(1.3, hv * 0.35)
    r = v.mansard
    inset = offset_ring(ring, -d)
    if not inset_ok(ring, inset):
        return None
    trim = CORNICE_MAT[cornice]
    # cornice at the eave
    ring_c = offset_ring(ring, 0.35)
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        mesh.wall(trim, ring_c[i], ring_c[j], y_eave - 0.45, y_eave + 0.15)
        mesh.face(trim, [(ring[i][0], y_eave - 0.45, -ring[i][1]), (ring[j][0], y_eave - 0.45, -ring[j][1]),
                         (ring_c[j][0], y_eave - 0.45, -ring_c[j][1]), (ring_c[i][0], y_eave - 0.45, -ring_c[i][1])])
        mesh.face(trim, [(ring_c[i][0], y_eave + 0.15, -ring_c[i][1]), (ring_c[j][0], y_eave + 0.15, -ring_c[j][1]),
                         (ring[j][0], y_eave + 0.15, -ring[j][1]), (ring[i][0], y_eave + 0.15, -ring[i][1])])
    y0 = y_eave + 0.15
    for i in range(n):
        j = (i + 1) % n
        mesh.face("slate", [(ring[i][0], y0, -ring[i][1]), (ring[j][0], y0, -ring[j][1]),
                            (inset[j][0], y0 + r, -inset[j][1]), (inset[i][0], y0 + r, -inset[i][1])])
    mesh.flat("roof_dark", [inset], y0 + r, True)
    # dormers
    for e in front_edges:
        a, b = e["a"], e["b"]
        L = e["L"]
        k = min(3, int(L // 3.2))
        if k < 1:
            continue
        eu2 = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        nrm = e["n"]
        for m in range(k):
            t = (m + 0.5) / k
            base = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            front = (base[0] - nrm[0] * d * 0.35, base[1] - nrm[1] * d * 0.35)
            back = (base[0] - nrm[0] * d * 1.05, base[1] - nrm[1] * d * 1.05)
            cc = ((front[0] + back[0]) / 2, (front[1] + back[1]) / 2)
            hd = (dist(front, back)) / 2
            yb, yt = y0 + 0.2, y0 + r * 0.85
            # box oriented along the edge; hv = half depth
            mesh.box("trim_white", cc, eu2, 0.7, hd, yb, yt, top_mat="slate")
            # dark window on the front face
            wa = (front[0] - eu2[0] * 0.45 + nrm[0] * 0.03, front[1] - eu2[1] * 0.45 + nrm[1] * 0.03)
            wb = (front[0] + eu2[0] * 0.45 + nrm[0] * 0.03, front[1] + eu2[1] * 0.45 + nrm[1] * 0.03)
            mesh.wall("glass_dark", wa, wb, yb + 0.25, yt - 0.25)
    return y0 + r


def add_door(mesh, v, e, y_floor, kind, rng):
    a, b, L, nrm = e["a"], e["b"], e["L"], e["n"]
    eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
    t = 0.5 if kind != "row" else (0.78 if h32(v.key + "d") % 2 else 0.22)
    c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    if kind == "row":
        w, hgt = 0.75, 2.6
    elif kind == "big":
        w, hgt = 1.8, 3.4
    else:
        w, hgt = 1.2, 2.9
    w = min(w, L * 0.3)
    _, _, _, family, cornice, _ = facade_mats(v)
    trim = CORNICE_MAT[cornice] if family != "glass" else "trim_metal"
    # surround, then the door leaf in front of it
    mesh.box(trim, (c[0] + nrm[0] * 0.08, c[1] + nrm[1] * 0.08), eu, w + 0.3, 0.12, y_floor, y_floor + hgt + 0.35, top_mat=trim)
    leaf = "glass_dark" if kind == "big" or family in ("glass", "modern", "concrete") else "door"
    mesh.box(leaf, (c[0] + nrm[0] * 0.18, c[1] + nrm[1] * 0.18), eu, w, 0.06, y_floor, y_floor + hgt, top_mat=leaf)
    if kind == "big" or family in ("glass", "modern", "concrete"):
        mesh.box("trim_metal", (c[0] + nrm[0] * 0.9, c[1] + nrm[1] * 0.9), eu, w + 1.0, 0.85,
                 y_floor + hgt + 0.4, y_floor + hgt + 0.7, top_mat="trim_metal", bottom=True)
    if kind == "row":
        # stoop: three stone steps up to the raised parlour floor
        for k in range(4):
            depth = 0.35 * (4 - k)
            cc = (c[0] + nrm[0] * (0.2 + depth / 2), c[1] + nrm[1] * (0.2 + depth / 2))
            mesh.box("stone", cc, eu, w + 0.35, depth / 2, -0.1, y_floor * (k + 1) / 4, top_mat="stone")
    return c


def add_bay(mesh, v, e, y0, y1, avoid):
    """A three-sided bay window on a rowhouse's street front."""
    a, b, L, nrm = e["a"], e["b"], e["L"], e["n"]
    if L < 4.5:
        return
    eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
    t = 0.3 if avoid > 0.5 else 0.7
    w = min(L * 0.42, 4.2)
    depth = 1.0
    c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    p0 = (c[0] - eu[0] * w / 2, c[1] - eu[1] * w / 2)
    p3 = (c[0] + eu[0] * w / 2, c[1] + eu[1] * w / 2)
    p1 = (p0[0] + eu[0] * depth * 0.8 + nrm[0] * depth, p0[1] + eu[1] * depth * 0.8 + nrm[1] * depth)
    p2 = (p3[0] - eu[0] * depth * 0.8 + nrm[0] * depth, p3[1] - eu[1] * depth * 0.8 + nrm[1] * depth)
    upper, ground, bay, family, cornice, mat = facade_mats(v)
    ys = [y for y in storey_lines(v, 0, y1) if y >= y0 - 0.01]
    if len(ys) < 2:
        ys = [y0, y1]
    ys[0] = y0
    vb, vt = band_v(upper)
    for s, t2 in ((p0, p1), (p1, p2), (p2, p3)):
        for k in range(len(ys) - 1):
            mesh.wall(mat, s, t2, ys[k], ys[k + 1], (0.0, 1.0, vb, vt))
    ring = [p0, p1, p2, p3]
    trim = CORNICE_MAT[cornice]
    mesh.flat(trim, [oriented(ring)], ys[-1] + 0.25, True)
    for s, t2 in ((p0, p1), (p1, p2), (p2, p3)):
        mesh.wall(trim, s, t2, ys[-1], ys[-1] + 0.25)
    # stone base under the bay
    for s, t2 in ((p0, p1), (p1, p2), (p2, p3)):
        mesh.wall("stone", s, t2, -0.1, y0)
    mesh.flat("stone", [oriented(ring)], y0, False)


def street_edges(v, info, ctx, tags):
    """Edges of the outer ring that face a street, nearest first."""
    street = tags.get("addr:street")
    cands = []
    for e in info:
        if e["party"] or not e["outer"] or e["L"] < 2.0:
            continue
        for name in ([street] if street else []) + [None]:
            d, q = ctx.nearest_street(e["mid"], name)
            if q is None or d > 80:
                continue
            to = (q[0] - e["mid"][0], q[1] - e["mid"][1])
            facing = (to[0] * e["n"][0] + to[1] * e["n"][1]) / max(d, 1e-6)
            if facing > 0.35:
                cands.append((d - 0.05 * min(e["L"], 40) + (0 if name else 15), id(e), e))
                break
    cands.sort(key=lambda c: c[0])
    out = [c[2] for c in cands]
    if not out:
        rest = [e for e in info if e["outer"] and not e["party"]] or [e for e in info if e["outer"]]
        out = sorted(rest, key=lambda e: -e["L"])[:1]
    return out


def build_volume(mesh, v, ctx, exclude, rng):
    """Walls, ground floor, doors and roof for one volume. Returns the top of the model (m)."""
    rings_o = [offset_ring(r, wall_out(v.top)) for r in v.rings]
    y0 = v.base - 0.3 if v.base > 0.5 else -0.2
    y_eave = v.top + roof_up(v.top)
    info, ys = build_walls(mesh, v, ctx, rings_o, y0, y_eave, exclude)
    _, _, _, family, cornice, _ = facade_mats(v)
    if v.base > 0.5:
        mesh.flat("trim_white" if v.style == "cds" else "wall_" + family, rings_o, y0, False)
    fronts = street_edges(v, info, ctx, v.tags) if (v.door or v.bays) and v.ground else []
    if v.fascia:
        trim = CORNICE_MAT[cornice]
        for e in info:
            if e["party"]:
                continue
            a, b = e["a"], e["b"]
            nrm = e["n"]
            a2 = (a[0] + nrm[0] * 0.4, a[1] + nrm[1] * 0.4)
            b2 = (b[0] + nrm[0] * 0.4, b[1] + nrm[1] * 0.4)
            for y in ys[1:-1]:
                mesh.wall(trim, a2, b2, y - 0.35, y)
                mesh.face(trim, [(a2[0], y, -a2[1]), (b2[0], y, -b2[1]), (b[0], y, -b[1]), (a[0], y, -a[1])])
                mesh.face(trim, [(a[0], y - 0.35, -a[1]), (b[0], y - 0.35, -b[1]), (b2[0], y - 0.35, -b2[1]), (a2[0], y - 0.35, -a2[1])])
    top = y_eave
    if v.roof == "mansard" and len(v.rings) == 1:
        t = mansard_top(mesh, v, rings_o, y_eave, fronts[:1])
        if t is None:
            v.roof = "flat"
        else:
            top = t
    if v.roof in ("gabled", "hipped", "pyramidal", "round", "vault", "quadruple_saltbox", "saltbox", "half-hipped") and len(v.rings) == 1:
        top = pitched_top(mesh, v, rings_o[0], y_eave, v.roof)
    elif v.roof != "mansard" or top == y_eave:
        build_flat_top(mesh, v, rings_o, y_eave, info, rng)
        top = y_eave + v.parapet
        if v.mech:
            add_mech(mesh, v, v.rings, y_eave, rng)
        if v.chimneys:
            for e in info:
                if e["party"] and e["L"] > 6 and rng.random() < 0.7:
                    c = (e["mid"][0] - e["n"][0] * 0.6, e["mid"][1] - e["n"][1] * 0.6)
                    eu = ((e["b"][0] - e["a"][0]) / e["L"], (e["b"][1] - e["a"][1]) / e["L"])
                    mesh.box("chimney", c, eu, 0.9, 0.35, y_eave, y_eave + v.parapet + 1.4, top_mat="roof_dark")
        if v.terrace:
            for r in v.rings[:1]:
                ins = offset_ring(r, -2.0)
                if inset_ok(r, ins):
                    mesh.flat("roof_green", [ins], y_eave + 0.08, True)
    if v.ground and fronts:
        if v.bays:
            avoid = 0.78 if h32(v.key + "d") % 2 else 0.22
            add_bay(mesh, v, fronts[0], 1.1, ys[-2] if len(ys) > 2 else ys[-1], avoid)
        if v.door:
            kind = "row" if v.stoop else ("big" if v.top > 25 or abs(signed_area(v.rings[0])) > 1500 else "small")
            add_door(mesh, v, fronts[0], 1.1 if v.stoop else 0.0, kind, rng)
    return top


# ------------------------------------------------------------------------------------------------
# Landmarks
# ------------------------------------------------------------------------------------------------

def tower(mesh, ring, y0, y1, storeys, spacing, key, roof="pyramid", band=B_LANCET, pinnacles=True, cap=None):
    """A square gothic tower: lancet storeys, crenellated parapet, corner pinnacles, low pyramid."""
    ring = oriented(ring, True)
    ro = ring
    n = len(ro)
    ys = [y0 + (y1 - y0) * k / storeys for k in range(storeys + 1)]
    vb, vt = band_v(band)
    for i in range(n):
        a, b = ro[i], ro[(i + 1) % n]
        u1 = float(max(1, round(dist(a, b) / spacing)))
        for k in range(storeys):
            mesh.wall("facade_" + str(h32(key) % 2), a, b, ys[k], ys[k + 1], (0.0, u1, vb, vt))
    rc = offset_ring(ro, 0.35)
    for i in range(n):
        j = (i + 1) % n
        mesh.wall("trim_stone", rc[i], rc[j], y1, y1 + 0.6)
        mesh.face("trim_stone", [(ro[i][0], y1, -ro[i][1]), (ro[j][0], y1, -ro[j][1]), (rc[j][0], y1, -rc[j][1]), (rc[i][0], y1, -rc[i][1])])
    mesh.flat("trim_stone", [rc], y1 + 0.6, True)
    for i in range(n):
        a, b = rc[i], rc[(i + 1) % n]
        L = dist(a, b)
        eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        nrm = right_normal(a, b)
        k = max(2, int(L // 1.6))
        for m in range(1, k):
            t = m / k
            c = (a[0] + (b[0] - a[0]) * t - nrm[0] * 0.25, a[1] + (b[1] - a[1]) * t - nrm[1] * 0.25)
            mesh.box("trim_stone", c, eu, 0.35, 0.25, y1 + 0.6, y1 + 1.4)
    cx = sum(p[0] for p in ro) / n
    cy = sum(p[1] for p in ro) / n
    side = min(dist(ro[i], ro[(i + 1) % n]) for i in range(n))
    top = y1 + 1.4
    if pinnacles:
        for p in rc:
            q = (p[0] + (cx - p[0]) * 0.08, p[1] + (cy - p[1]) * 0.08)
            sq = [(q[0] - 0.5, q[1] - 0.5), (q[0] + 0.5, q[1] - 0.5), (q[0] + 0.5, q[1] + 0.5), (q[0] - 0.5, q[1] + 0.5)]
            mesh.prism("trim_stone", sq, y1, y1 + 3.2)
            mesh.pyramid("trim_stone", sq, y1 + 3.2, y1 + 5.6)
        top = y1 + 5.6
    if roof == "pyramid":
        inner = offset_ring(ro, -0.6)
        mesh.pyramid(cap or "slate", inner, y1 + 0.6, y1 + 0.6 + side * 0.55)
        top = max(top, y1 + 0.6 + side * 0.55)
    return top


def landmark_chapel(mesh, b, ctx, rng, vols):
    """Marsh Chapel: limestone nave with buttresses and lancets, steep slate roof, square tower on the plaza."""
    v = vols[0]
    ring = v.rings[0]
    ring_o = offset_ring(ring, wall_out(v.top))
    centre, eu, ev, hu, hv = obb(ring_o)
    eave = max(v.top, 12.1) + roof_up(v.top)
    nave_eave = eave + 2.0
    # nave walls: one tall storey of lancets
    vb, vt = band_v(B_LANCET)
    mat = "facade_0"
    n = len(ring_o)
    for i in range(n):
        a, bb = ring_o[i], ring_o[(i + 1) % n]
        L = dist(a, bb)
        if L < 0.05:
            continue
        u = (0.0, float(max(1, round(L / 4.4)))) if L > 2.5 else BLANK_U
        mesh.wall(mat, a, bb, -0.2, nave_eave, (u[0], u[1], vb, vt))
        # buttresses between the windows on the long walls
        if L > 8:
            k = int(round(L / 4.4))
            e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
            nrm = right_normal(a, bb)
            for m in range(k + 1):
                t = m / k
                c = (a[0] + (bb[0] - a[0]) * t + nrm[0] * 0.45, a[1] + (bb[1] - a[1]) * t + nrm[1] * 0.45)
                mesh.box("trim_stone", c, e2, 0.4, 0.45, -0.2, nave_eave - 1.2, top_mat="trim_stone")
                mesh.box("trim_stone", (c[0] - nrm[0] * 0.2, c[1] - nrm[1] * 0.2), e2, 0.32, 0.25, nave_eave - 1.2, nave_eave + 1.0)
    v.style = "gothic"
    v.roof_mat = "slate"
    ridge = pitched_top(mesh, v, ring_o, nave_eave, "gabled", rise=min(hv * 1.25, 12.0))
    # tower: on the end of the long axis nearest Commonwealth Avenue (south)
    end = 1 if eu[1] < 0 else -1  # +eu points south when eu[1] < 0
    s = min(hv * 2 * 0.55, 9.5)
    tc = (centre[0] + eu[0] * end * (hu - s / 2 + 1.2), centre[1] + eu[1] * end * (hu - s / 2 + 1.2))
    sq = [(tc[0] + sx * s / 2 * eu[0] + sy * s / 2 * ev[0], tc[1] + sx * s / 2 * eu[1] + sy * s / 2 * ev[1])
          for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    t_top = max(ridge + 9.0, 36.0)
    top = tower(mesh, sq, -0.2, t_top, 3, 3.6, b.ref + "t")
    # a slender flèche over the crossing
    return max(top, ridge)


def landmark_cas(mesh, b, ctx, rng, vols):
    """CAS: long limestone block with a hipped slate roof and a central tower over the Comm Ave entrance."""
    v = vols[0]
    v.style = "gothic"
    v.roof = "hipped"
    v.roof_mat = "slate"
    v.levels = max(v.levels, 5)
    top = build_volume(mesh, v, ctx, {b.ref}, rng)
    ring = v.rings[0]
    centre, eu, ev, hu, hv = obb(ring)
    side = ev if ev[1] < 0 else (-ev[0], -ev[1])  # towards the south (Comm Ave)
    s = 11.0
    tc = (centre[0] + side[0] * (hv - s / 2 + 2.5), centre[1] + side[1] * (hv - s / 2 + 2.5))
    sq = [(tc[0] + sx * s / 2 * eu[0] + sy * s / 2 * ev[0], tc[1] + sx * s / 2 * eu[1] + sy * s / 2 * ev[1])
          for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    t = tower(mesh, sq, -0.2, v.top + ROOF_UP + 15.0, 5, 3.4, b.ref + "t", band=B_LIME)
    return max(top, t)


def landmark_warren(mesh, b, ctx, rng, vols):
    """Warren Towers: three 18-storey precast towers on a shared four-storey podium."""
    towers, podium = [], []
    for v in vols:
        (towers if abs(signed_area(v.rings[0])) < 750 else podium).append(v)
    top = 0
    pod_h = 15.5
    for v in podium:
        v.top = pod_h
        v.levels = 4
        v.style = "concrete"
        v.mech = False
        v.parapet = 1.1
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    for v in towers:
        v.top = max(v.top, 18 * METRES_PER_LEVEL)
        v.levels = 18
        v.style = "concrete"
        v.base = 0.0
        v.ground = True
        v.door = False
        v.parapet = 1.2
        v.mech = False
        t = build_volume(mesh, v, ctx, {b.ref}, rng)
        # machine-room crown
        centre, eu, ev, hu, hv = obb(v.rings[0])
        mesh.box("trim_concrete", centre, eu, hu * 0.55, hv * 0.6, v.top + ROOF_UP, v.top + ROOF_UP + 4.2, top_mat="roof_light")
        top = max(top, t, v.top + ROOF_UP + 4.2)
    return top


def landmark_stuvi(mesh, b, ctx, rng, vols):
    """StuVi towers: glass curtain walls over a two-storey lobby, with a glass crown."""
    top = 0
    for v in vols:
        v.style = "glass"
        v.parapet = 2.6
        v.cornice = False
        v.mech = True
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_arena(mesh, b, ctx, rng, vols):
    """Agganis Arena: buff masonry and a glass lobby under a long, shallow metal barrel roof."""
    top = 0
    for v in vols:
        v.style = "buff"
        v.roof = "round"
        v.roof_mat = "roof_metal"
        v.levels = 4
        v.ground = True
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_modern(mesh, b, ctx, rng, vols, glass_ground=True):
    top = 0
    for v in vols:
        v.style = "modern"
        v.fascia = True
        v.parapet = 1.3
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_lawtower(mesh, b, ctx, rng, vols):
    top = 0
    for v in vols:
        v.style = "concrete"
        v.fascia = True
        v.parapet = 1.4
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_cds(mesh, b, ctx, rng, vols):
    """CDS: the stacked, offset 'Jenga' glass volumes (from OSM's building:part pieces)."""
    top = 0
    for v in vols:
        v.style = "cds"
        v.party = False
        v.cornice = True
        v.parapet = 1.1
        v.terrace = v.top < 85
        v.roof_mat = "roof_light"
        v.mech = False
        if v.top > 90:  # white mechanical crown
            v.style = "metal"
            v.levels = 2
            v.door = False
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


LANDMARK_FN = {"chapel": landmark_chapel, "cas": landmark_cas, "warren": landmark_warren, "stuvi": landmark_stuvi,
               "arena": landmark_arena, "mugar": landmark_modern, "gsu": landmark_modern, "lawtower": landmark_lawtower,
               "cds": landmark_cds}


# ------------------------------------------------------------------------------------------------
# Volumes for a building
# ------------------------------------------------------------------------------------------------

def local_rings(frame, outer, inners):
    o = clean_ring([frame.to_local(*p) for p in outer])
    if len(o) < 3:
        return None
    rings = [oriented(o, True)]
    for h in inners:
        hr = clean_ring([frame.to_local(*p) for p in h])
        if len(hr) >= 3:
            rings.append(oriented(hr, False))
    return rings


def volumes_for(b, frame, floors):
    """Building -> [Volume]. Uses building:part pieces when OSM has them."""
    h, lv, mh = tag_height(b.tags)
    vols = []
    roof_shape = b.tags.get("roof:shape", "flat")
    if b.parts and LANDMARKS.get(b.ref) != "warren":
        for el in b.parts:
            tags = el.get("tags", {})
            ph, plv, pmh = tag_height(tags, (h, lv))
            if ph - pmh < 0.5:
                continue
            for o, inn in element_rings(el):
                rings = local_rings(frame, o, inn)
                if not rings:
                    continue
                key = f"{el['type']}/{el['id']}"
                top = max(ph, floors.get(key, 0))
                levels = plv if pmh < 0.5 else max(1, round((ph - pmh) / METRES_PER_LEVEL))
                vols.append(Volume(key, rings, pmh, top, levels, None, tags.get("roof:shape", "flat"), party=False))
    if not vols:
        for k, (o, inn) in enumerate(b.rings_ll):
            rings = local_rings(frame, o, inn)
            if not rings:
                continue
            top = max(h, floors.get(b.ref, 0), floors.get(f"{b.ref}#{k}", 0))
            vols.append(Volume(b.ref if k == 0 else f"{b.ref}#{k}", rings, mh, top, lv, None, roof_shape))
    for v in vols:
        v.tags = b.tags
        # Re-derive storeys when Mapbox's height overrides OSM's.
        per = (v.top - v.base) / max(1, v.levels)
        if per > 5.2 or per < 2.6:
            v.levels = max(1, round((v.top - v.base) / METRES_PER_LEVEL))
    return vols


def configure(b, v, area):
    style = style_for(b, area, v.levels)
    v.style = style
    btype = b.tags.get("building", "")
    shape = b.tags.get("roof:shape", "flat")
    row = style in ("brownstone", "rowbrick", "rowlime") or is_rowhouse(b, area, v.levels)
    if row:
        v.stoop = v.ground
        v.bays = v.ground and h32(b.ref + "b") % 3 != 0
        v.chimneys = True
        v.mech = False
        v.parapet = 0.7
        if "Bay State Road" in b.tags.get("addr:street", "") and shape in ("flat", "") and v.levels <= 6:
            v.roof = "mansard"
    if shape in ("gabled", "hipped", "pyramidal", "round", "quadruple_saltbox", "saltbox", "half-hipped", "mansard"):
        v.roof = shape
    if shape in ("gabled", "hipped") and b.tags.get("roof:colour", "").lower() == "green":
        v.roof_mat = "roof_copper"
    if btype == "roof":
        v.roof = "canopy"
    if btype in ("grandstand",):
        v.door = False
        v.mech = False
    if style == "gothic":
        v.merlons = True
    if style == "modern":
        v.fascia = True


def build_canopy(mesh, v):
    """building=roof: a slab on columns (covered walkways)."""
    ring_o = offset_ring(v.rings[0], 0.2)
    top = min(v.top, 5.0) + ROOF_UP
    mesh.prism("trim_stone", ring_o, top - 0.45, top, top_mat="roof_light", bottom=True)
    n = len(v.rings[0])
    for i in range(n):
        a, b = v.rings[0][i], v.rings[0][(i + 1) % n]
        L = dist(a, b)
        k = max(1, int(L // 3.5))
        for m in range(k + 1):
            t = m / k
            c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            mesh.box("trim_stone", c, (1.0, 0.0), 0.22, 0.22, -0.1, top - 0.45)
    return top


# ------------------------------------------------------------------------------------------------
# Mapbox height floors
# ------------------------------------------------------------------------------------------------

def compute_floors(buildings, frames):
    """Match Mapbox's own extrusions (captured in the browser) to our footprints; keep the max height."""
    if not MAPBOX_CAPTURE.exists():
        return None
    feats = json.loads(MAPBOX_CAPTURE.read_text())
    frame = frames["charles-river"]
    cand = []  # (key, rings local, area)
    for b in buildings:
        pieces = []
        if b.parts and LANDMARKS.get(b.ref) != "warren":
            for el in b.parts:
                for o, inn in element_rings(el):
                    pieces.append((f"{el['type']}/{el['id']}", o, inn))
        for k, (o, inn) in enumerate(b.rings_ll):
            pieces.append((b.ref if k == 0 else f"{b.ref}#{k}", o, inn))
        for key, o, inn in pieces:
            rings = local_rings(frame, o, inn)
            if rings:
                cand.append((key, rings, abs(signed_area(rings[0]))))
    grid = {}
    for c in cand:
        xs = [p[0] for p in c[1][0]]
        ys = [p[1] for p in c[1][0]]
        for gx in range(int(min(xs) // 50), int(max(xs) // 50) + 1):
            for gy in range(int(min(ys) // 50), int(max(ys) // 50) + 1):
                grid.setdefault((gx, gy), []).append(c)
    floors = {}
    for f in feats:
        g = f["g"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            ring = [frame.to_local(*p) for p in poly[0]]
            if len(ring) < 3:
                continue
            a = abs(signed_area(ring))
            if a < 4:
                continue
            c = ring_centroid(ring)
            best = None
            for key, rings, area in grid.get((int(c[0] // 50), int(c[1] // 50)), ()):
                if not poly_contains(rings, c):
                    continue
                score = abs(math.log(a / max(area, 1)))
                if best is None or score < best[0]:
                    best = (score, key)
            if best and best[0] < math.log(4):
                floors[best[1]] = max(floors.get(best[1], 0), float(f["h"]))
    return floors


# ------------------------------------------------------------------------------------------------
# glTF writer
# ------------------------------------------------------------------------------------------------

def write_glb(path, mesh, png):
    blob = bytearray()
    views, accessors = [], []

    def view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(data)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    def accessor(data_view, ctype, count, typ, mn=None, mx=None):
        a = {"bufferView": data_view, "componentType": ctype, "count": count, "type": typ}
        if mn is not None:
            a["min"], a["max"] = mn, mx
        accessors.append(a)
        return len(accessors) - 1

    used = [m for m in MATERIALS if m["name"] in mesh.prims and mesh.prims[m["name"]].n]
    mat_ids = {m["name"]: i for i, m in enumerate(used)}
    gl_materials = []
    for m in used:
        pbr = {"baseColorFactor": [round(srgb_to_linear(c), 5) for c in m["color"]] + [1.0],
               "metallicFactor": m["metal"], "roughnessFactor": m["rough"]}
        if m["texture"]:
            pbr["baseColorTexture"] = {"index": 0}
        gl_materials.append({"name": m["name"], "pbrMetallicRoughness": pbr})

    primitives = []
    for m in used:
        p = mesh.prims[m["name"]]
        # split into chunks of < 65536 vertices so indices fit in uint16
        tri_idx = p.idx
        start = 0
        while start < len(tri_idx):
            remap = {}
            idx = array.array("H")
            k = start
            while k < len(tri_idx) and (len(remap) < 65530 or all(t in remap for t in tri_idx[k:k + 3])):
                for t in tri_idx[k:k + 3]:
                    if t not in remap:
                        remap[t] = len(remap)
                    idx.append(remap[t])
                k += 3
            start = k
            order = sorted(remap, key=remap.get)
            pos = array.array("f")
            nrm = array.array("f")
            uv = array.array("f") if p.uv is not None else None
            for o in order:
                pos.extend(p.pos[o * 3:o * 3 + 3])
                nrm.extend(p.nrm[o * 3:o * 3 + 3])
                if uv is not None:
                    uv.extend(p.uv[o * 2:o * 2 + 2])
            count = len(order)
            mn = [min(pos[i::3]) for i in range(3)]
            mx = [max(pos[i::3]) for i in range(3)]
            attrs = {
                "POSITION": accessor(view(pos.tobytes(), 34962), 5126, count, "VEC3", mn, mx),
                "NORMAL": accessor(view(nrm.tobytes(), 34962), 5126, count, "VEC3"),
            }
            if uv is not None:
                attrs["TEXCOORD_0"] = accessor(view(uv.tobytes(), 34962), 5126, count, "VEC2")
            ind = accessor(view(idx.tobytes(), 34963), 5123, len(idx), "SCALAR")
            primitives.append({"attributes": attrs, "indices": ind, "material": mat_ids[m["name"]], "mode": 4})

    img_view = view(png)
    gltf = {
        "asset": {"version": "2.0", "generator": "Flowcast make_building_models.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.stem}],
        "meshes": [{"name": path.stem, "primitives": primitives}],
        "materials": gl_materials,
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "images": [{"bufferView": img_view, "mimeType": "image/png"}],
        "accessors": accessors,
        "bufferViews": views,
    }
    while len(blob) % 4:
        blob.append(0)
    gltf["buffers"] = [{"byteLength": len(blob)}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    path.write_bytes(out)
    return len(out)


# ------------------------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------------------------

def main():
    print("Fetching OpenStreetMap buildings (cached in data-pipeline/.cache/)...")
    charles = overpass(Q_CHARLES)
    medical = overpass(Q_MEDICAL)
    area_els = overpass(Q_CAMPUS)
    streets_raw = overpass(Q_STREETS)
    areas = {f"{e['type']}/{e['id']}": element_rings(e) for e in area_els}

    buildings = select_buildings(charles, medical, areas)
    frames = {c["id"]: Frame(*c["origin"]) for c in CAMPUSES}

    floors = compute_floors(buildings, frames)
    if floors is not None:
        HEIGHT_FLOORS.write_text(json.dumps(dict(sorted(floors.items())), indent=0) + "\n")
        print(f"  {len(floors)} Mapbox height floors refreshed from the browser capture")
    elif HEIGHT_FLOORS.exists():
        floors = json.loads(HEIGHT_FLOORS.read_text())
    else:
        floors = {}

    png = ATLAS.png()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"frame": "glTF metres: +x east, +y up, +z south (north is -z), relative to origin [lng, lat]",
                "campuses": []}
    total = 0
    for campus in CAMPUSES:
        cid = campus["id"]
        frame = frames[cid]
        mine = sorted((b for b in buildings if b.campus == cid), key=lambda b: b.ref)
        # every OSM footprint near the campus, for party-wall detection
        footprints = []
        for el in (medical if cid == "medical" else charles):
            if "building" not in el.get("tags", {}):
                continue
            for k, (o, inn) in enumerate(element_rings(el)):
                rings = local_rings(frame, o, inn)
                if rings:
                    footprints.append((f"{el['type']}/{el['id']}", rings))
        streets = []
        for w in streets_raw:
            if w["type"] == "way" and w.get("geometry"):
                streets.append((w["tags"].get("name"), [frame.to_local(p["lon"], p["lat"]) for p in w["geometry"]]))
        ctx = Ctx(frame, footprints, streets)
        mesh = Mesh()
        entries = []
        for b in mine:
            rng = random.Random(h32(b.ref))
            vols = volumes_for(b, frame, floors)
            if not vols:
                continue
            for v in vols:
                configure(b, v, abs(signed_area(v.rings[0])))
            kind = LANDMARKS.get(b.ref)
            if kind:
                top = LANDMARK_FN[kind](mesh, b, ctx, rng, vols)
            else:
                top = 0
                for v in vols:
                    if v.roof == "canopy":
                        top = max(top, build_canopy(mesh, v))
                    else:
                        top = max(top, build_volume(mesh, v, ctx, {b.ref} | {f"{p['type']}/{p['id']}" for p in b.parts}, rng))
            outer = b.rings_ll[0][0]
            c = ring_centroid(outer)
            entries.append({"osm": b.ref, "name": b.name, "center": [round(c[0], 6), round(c[1], 6)],
                            "height": round(top, 1), **({"landmark": kind} if kind else {})})
        out = MODELS_DIR / f"buildings-{cid}.glb"
        size = write_glb(out, mesh, png)
        total += size
        manifest["campuses"].append({
            "id": cid, "name": campus["name"], "origin": [campus["origin"][0], campus["origin"][1]],
            "model": f"/models/{out.name}", "buildings": entries,
        })
        print(f"  {campus['name']}: {len(entries)} buildings, {mesh.vert_count():,} vertices, {size / 1e6:.2f} MB -> {out.relative_to(ROOT)}")
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"Total {total / 1e6:.2f} MB. Manifest -> {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
