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

Every model sits ~0.3 m outside its OSM footprint and its roof ~0.5 m above its height. The app
removes these buildings (and their building:part / relation member ids, also listed in the
manifest) from its city-buildings layer, so nothing else is drawn underneath them.

At Dusk and Night the layer adds lit windows: buildings-<campus>-lights-dusk.glb (a random share
of windows, warm emissive) and -lights-night.glb (more of them).

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
SKIP_TYPES = {"garage", "garages", "shed", "hut", "gatehouse", "carport", "construction", "kiosk", "service",
              "grandstand"}  # Nickerson Field's stands are drawn by the sports-fields layer
SKIP_AMENITY = {"bicycle_parking", "shelter"}
# Single-family houses inside the coarse BU outline are Brookline homes, not BU's.
HOUSE_TYPES = {"detached", "house"}
# BU buildings just outside OSM's campus outline (West Campus, south side of Comm Ave).
EXTRA_IDS = {"way/29827118", "way/29932285"}
# Medical Campus: the OSM campus area also holds BMC's hospital, a hotel and private housing, so
# there only university buildings, named BU buildings and these are kept.
MEDICAL_EXTRA = {"way/484824710"}  # Crosstown Center (801 Mass Ave): BU School of Public Health

METRES_PER_LEVEL = 3.6
# True heights where OSM's tags are missing or misleading (from the reference research).
HEIGHT_OVERRIDES = {
    "way/155291470": 80.0,      # StuVi II: 26 storeys (Cannon Design)
    "way/29927783": 57.0,       # StuVi I: 18 storeys
    "way/485223499": 80.8,      # Law Tower: 265 ft, 18 storeys (SkyscraperPage b22471; BU Law history)
    "way/29889456": 40.5, "way/813732836": 40.5, "way/29680668": 40.5,  # West Campus: 13 storeys
}
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


def offset_ring_var(r, ds, max_miter=3.0):
    """Like offset_ring, but each edge i (r[i] -> r[i+1]) moves its own distance ds[i]."""
    n = len(r)
    out = []
    for i in range(n):
        p0, p1, p2 = r[i - 1], r[i], r[(i + 1) % n]
        n0, n1 = right_normal(p0, p1), right_normal(p1, p2)
        d0, d1 = ds[i - 1], ds[i]
        det = n0[0] * n1[1] - n0[1] * n1[0]
        if abs(det) < 0.05:  # nearly straight: average
            d = (d0 + d1) / 2
            m = (n0[0] + n1[0], n0[1] + n1[1])
            ml = math.hypot(*m) or 1.0
            out.append((p1[0] + m[0] / ml * d, p1[1] + m[1] / ml * d))
            continue
        x = (d0 * n1[1] - d1 * n0[1]) / det
        y = (n0[0] * d1 - n1[0] * d0) / det
        lim = max_miter * max(abs(d0), abs(d1), 0.05)
        L = math.hypot(x, y)
        if L > lim:
            x, y = x / L * lim, y / L * lim
        out.append((p1[0] + x, p1[1] + y))
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

TEX_W, BAND_H, NBANDS = 128, 64, 35
B_BRICK, B_BRICK_GROUND, B_BROWNSTONE, B_LIME, B_LIME_GROUND, B_GLASS, B_LOBBY, B_CONCRETE, \
    B_MODERN, B_SHOP, B_WOOD, B_METAL, B_BUFF, B_CONCRETE_GROUND, B_CDS, B_LANCET = range(16)
# Building-specific storeys, painted from reference photos (see BUILDING_NOTES).
B_WARREN, B_GARAGE, B_CDS_FRIT, B_SERT, B_SERT_TOWER, B_HARIRI, B_HOTEL, B_HOTEL_BASE, \
    B_TERRA, B_TRACERY, B_TERRACOTTA, B_MED_BRICK, B_PHOTONICS, B_SERT_TOWER_G, B_LIME_STRIP, B_BLUEGLASS = range(16, 32)
B_QUESTROM, B_QUESTROM_BASE, B_TUDOR = 32, 33, 34
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


# Where the windows are in each band (pixel rects inside one 128 x 64 cell), so lit-window
# quads at Dusk/Night land exactly on painted windows.
WINDOWS = {}


def register_window(oy, x0, y0, x1, y1):
    WINDOWS.setdefault(oy // BAND_H, []).append((x0, y0, x1, y1))


def paint_window(cv, oy, x0, y0, x1, y1, frame, top, bottom, rng, fw=2, cols=1, rows=1, lit=True):
    if lit:
        register_window(oy, x0 + fw, y0 + fw, x1 - fw, y1 - fw)
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
    register_window(oy, int(cx - half * 0.8), spring, int(cx + half * 0.8), bottom)
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

    paint_specific_bands(cv, rng)
    return cv


def paint_specific_bands(cv, rng):
    """Storeys of particular BU buildings. Colours and rhythms from reference photos and
    descriptions (sources in the module notes / report); hex values are estimates."""
    stone = (214, 204, 180)      # Indiana limestone, warm cream (~#D6CCB4)
    glass_t, glass_b = (66, 80, 96), (34, 42, 54)

    # Warren Towers (1965), from photos: tan masonry, one narrow window per bay between piers
    oy = B_WARREN * BAND_H
    paint_brick(cv, oy, (186, 168, 142), (198, 186, 168), rng, var=4)
    paint_window(cv, oy, 40, 8, 88, 56, (150, 156, 164), (70, 84, 100), (40, 48, 60), rng, fw=3, cols=0, rows=1)
    cv.rect(36, oy + 56, 92, oy + 60, (200, 190, 172), rng, 2)

    # Warren podium / garages: tan masonry, long horizontal openings
    oy = B_GARAGE * BAND_H
    paint_brick(cv, oy, (184, 166, 140), (196, 184, 166), rng, var=4)
    cv.rect(10, oy + 18, 118, oy + 44, (38, 38, 40))
    for y in range(18, 44):
        for x in range(10, 118):
            if y > 38:
                cv.put(x, oy + y, (58, 56, 54))
    cv.rect(0, oy + 44, TEX_W, oy + 48, (176, 170, 160), rng, 2)

    # CDS (KPMB, 2022): patterned grey-blue glass, fritted, slab edges, light mullions
    oy = B_CDS_FRIT * BAND_H
    paint_glass(cv, oy, 0, 5, TEX_W, 64, (120, 136, 148), (88, 104, 116), rng)
    for y in range(5, 64, 3):
        for x in range((y // 3) % 2, TEX_W, 3):
            c = cv.get(x, oy + y)
            cv.put(x, oy + y, (c[0] + 12, c[1] + 13, c[2] + 13))
    cv.rect(0, oy, TEX_W, oy + 5, (212, 214, 212))
    for x0 in (0, 42, 85):
        cv.rect(x0, oy + 5, x0 + 2, oy + 64, (186, 190, 192))
    register_window(oy, 4, 8, 40, 60)
    register_window(oy, 46, 8, 83, 60)
    register_window(oy, 89, 8, 126, 60)

    # Sert (Mugar, GSU): exposed concrete frame, deep-set steel windows, precast spandrel
    oy = B_SERT * BAND_H
    for y in range(BAND_H):
        for x in range(TEX_W):
            j = ((x * 5 + y // 3) % 4) - 1.5 + rng.uniform(-3, 3)
            cv.put(x, oy + y, (172 + j, 168 + j, 156 + j))
    cv.rect(12, oy + 8, 116, oy + 15, (62, 60, 58))
    paint_glass(cv, oy, 12, 15, 116, 46, (58, 66, 78), (30, 36, 46), rng)
    register_window(oy, 14, 15, 114, 46)
    for x0 in (38, 64, 90):
        cv.rect(x0, oy + 15, x0 + 2, oy + 46, (46, 46, 46))
    cv.shade(12, oy + 15, 18, oy + 46, 0.55)
    for y in range(46, 58):
        for x in range(TEX_W):
            j = rng.uniform(-6, 6)
            cv.put(x, oy + y, (181 + j, 174 + j, 159 + j))
    cv.rect(0, oy + 58, TEX_W, oy + 64, (160, 156, 146), rng, 2)

    # Sert's Law Tower: concrete grid, deep windows, coloured ventilation panels
    for band, panel in ((B_SERT_TOWER, (176, 58, 46)), (B_SERT_TOWER_G, (63, 122, 74))):
        oy = band * BAND_H
        for y in range(BAND_H):
            for x in range(TEX_W):
                j = rng.uniform(-3, 3)
                cv.put(x, oy + y, (176 + j, 172 + j, 160 + j))
        paint_window(cv, oy, 10, 12, 70, 50, (52, 52, 52), (58, 66, 78), (30, 36, 46), rng, fw=4, cols=1, rows=0)
        cv.rect(80, oy + 12, 104, oy + 50, panel, rng, 3)
        for y in range(14, 50, 4):
            cv.rect(82, oy + y, 102, oy + y + 1, (panel[0] * 0.7, panel[1] * 0.7, panel[2] * 0.7))
        cv.rect(0, oy + 54, TEX_W, oy + 64, (158, 152, 142), rng, 2)

    # Questrom / Rafik B. Hariri Building (1996): red brick, concrete trim, half-round arched heads
    oy = B_HARIRI * BAND_H
    paint_brick(cv, oy, (143, 74, 56), (172, 158, 146), rng, var=8)
    for y in range(6, 22):
        hw = math.sqrt(max(0, 34 * 34 - (22 - y) ** 2 * 4.5))
        for x in range(int(64 - hw), int(64 + hw)):
            cv.put(x, oy + y, (201, 195, 181))
    paint_window(cv, oy, 34, 20, 94, 52, (234, 232, 226), glass_t, glass_b, rng, fw=3, cols=2, rows=1)
    for y in range(10, 22):
        hw = math.sqrt(max(0, 27 * 27 - (22 - y) ** 2 * 4.5))
        for x in range(int(64 - hw), int(64 + hw)):
            cv.put(x, oy + y, mix(glass_t, (90, 100, 112), 0.4))
    cv.rect(30, oy + 52, 98, oy + 56, (201, 195, 181), rng, 2)

    # 1920s apartment hotels (Myles Standish, Kilachand): brick, paired sashes, cast-stone trim
    oy = B_HOTEL * BAND_H
    paint_brick(cv, oy, (160, 100, 74), (178, 160, 144), rng, var=9)
    for x0 in (22, 68):
        cv.rect(x0 - 3, oy + 9, x0 + 41, oy + 13, (196, 188, 172), rng, 2)
        paint_window(cv, oy, x0, 13, x0 + 38, 52, (230, 226, 216), glass_t, glass_b, rng, fw=3, cols=0, rows=1)
        cv.rect(x0 - 2, oy + 52, x0 + 40, oy + 55, (196, 188, 172), rng, 2)

    # granite / cast-stone hotel base with tall round-headed windows
    oy = B_HOTEL_BASE * BAND_H
    paint_stone(cv, oy, (190, 180, 164), (150, 142, 128), rng, course=8, block=48)
    for y in range(8, 58):
        hw = 22 if y >= 26 else math.sqrt(max(0, 22 * 22 - (26 - y) ** 2))
        for x in range(int(64 - hw), int(64 + hw)):
            cv.put(x, oy + y, mix((70, 80, 92), (40, 46, 56), (y - 8) / 50))
    register_window(oy, 44, 16, 84, 58)
    cv.rect(62, oy + 14, 66, oy + 58, (170, 162, 146))

    # StuVi II (Cannon Design, 2009): terracotta rainscreen, full-height bedroom windows, metal panel
    oy = B_TERRA * BAND_H
    for y in range(BAND_H):
        for x in range(TEX_W):
            j = rng.uniform(-4, 4) + (3 if (y // 8) % 2 else -3)
            cv.put(x, oy + y, (181 + j, 101 + j * 0.7, 63 + j * 0.5))
    for y in range(BAND_H):
        if y % 8 == 7:
            cv.rect(0, oy + y, TEX_W, oy + y + 1, (140, 78, 50))
    paint_window(cv, oy, 18, 4, 50, 60, (167, 169, 172), (96, 115, 128), (60, 74, 88), rng, fw=3, cols=0, rows=0)
    cv.rect(70, oy, 106, oy + 64, (167, 169, 172), rng, 2)
    paint_window(cv, oy, 76, 4, 100, 60, (150, 152, 156), (96, 115, 128), (60, 74, 88), rng, fw=2, cols=0, rows=0)

    # gothic tracery: one great window with mullions, transoms and a traceried head
    oy = B_TRACERY * BAND_H
    paint_stone(cv, oy, stone, (190, 180, 160), rng, course=8, block=24)
    paint_lancet(cv, oy, 64, 2, 26, 60, 40, stone, (74, 82, 104), (44, 50, 66), rng, mullion=True, transoms=(38, 50))
    for x0 in (44, 84):
        cv.rect(x0 - 1, oy + 20, x0 + 1, oy + 60, stone)
    for y in range(8, 26):
        for x in range(30, 98):
            if (x - 64) ** 2 + ((y - 20) * 2.2) ** 2 < 120 and (x + y) % 5 < 2:
                cv.put(x, oy + y, stone)

    # College of Fine Arts (Bowditch, 1919, English Perpendicular): cream stone, big framed openings
    oy = B_TERRACOTTA * BAND_H
    paint_stone(cv, oy, (226, 214, 188), (200, 188, 162), rng, course=8, block=16, var=3)
    paint_window(cv, oy, 24, 10, 104, 52, (204, 192, 166), glass_t, glass_b, rng, fw=4, cols=2, rows=1)
    cv.rect(18, oy + 4, 110, oy + 9, (200, 186, 156), rng, 2)

    # Medical campus: brown brick with ribbon windows
    oy = B_MED_BRICK * BAND_H
    paint_brick(cv, oy, (124, 70, 54), (146, 126, 112), rng, var=6)
    paint_glass(cv, oy, 0, 18, TEX_W, 46, (66, 78, 92), (38, 46, 58), rng)
    register_window(oy, 4, 18, 60, 46)
    register_window(oy, 68, 18, 124, 46)
    for x0 in (0, 64):
        cv.rect(x0, oy + 18, x0 + 3, oy + 46, (94, 96, 100))
    cv.rect(0, oy + 46, TEX_W, oy + 49, (180, 172, 160))

    # Photonics Center (1997): red brick, concrete banding, tall windows in threes
    oy = B_PHOTONICS * BAND_H
    paint_brick(cv, oy, (142, 73, 54), (172, 158, 146), rng, var=8)
    cv.rect(0, oy + 56, TEX_W, oy + 60, (184, 178, 166), rng, 2)
    for x0 in (20, 54, 88):
        paint_window(cv, oy, x0, 12, x0 + 22, 52, (206, 202, 192), glass_t, glass_b, rng, fw=2, cols=0, rows=1)

    # Central Campus limestone (CAS, Theology, Marsh Chapel block): tall vertical bays of metal
    # casements running storey to storey, thin dark spandrels
    oy = B_LIME_STRIP * BAND_H
    paint_stone(cv, oy, stone, (196, 186, 164), rng, course=16, block=64, var=3)
    cv.rect(44, oy, 84, oy + 64, (174, 166, 146))
    paint_glass(cv, oy, 48, 0, 80, 64, (70, 80, 96), (46, 54, 66), rng, streak=False)
    register_window(oy, 48, 4, 80, 56)
    cv.rect(63, oy, 65, oy + 64, (58, 58, 54))
    for y0 in (20, 40):
        cv.rect(48, oy + y0, 80, oy + y0 + 1, (58, 58, 54))
    cv.rect(48, oy + 57, 80, oy + 63, (92, 86, 76))

    # Questrom (Hariri Building), from photos: warm red brick; wide and narrow rectangular windows,
    # each under a white louvred sunshade panel, on cast-stone sills
    oy = B_QUESTROM * BAND_H
    paint_brick(cv, oy, (196, 132, 114), (212, 194, 182), rng, var=5)  # warm salmon-pink brick (photo)
    for x0, x1 in ((10, 80), (92, 118)):
        cv.rect(x0 - 2, oy + 10, x1 + 2, oy + 25, (240, 238, 232))       # bold white louvred sunshade
        for y in range(13, 25, 4):
            cv.rect(x0, oy + y, x1, oy + y + 1, (188, 190, 192))
        paint_window(cv, oy, x0, 25, x1, 52, (196, 198, 200), (82, 96, 112), (46, 56, 70), rng, fw=2, cols=1 if x1 - x0 > 40 else 0, rows=0)
        cv.rect(x0 - 2, oy + 52, x1 + 2, oy + 55, (214, 208, 196))

    # Questrom base: cream cast stone, square piers, recessed glazing with a transom
    oy = B_QUESTROM_BASE * BAND_H
    paint_stone(cv, oy, (232, 228, 218), (206, 202, 192), rng, course=16, block=64, var=3)
    cv.rect(18, oy + 8, 110, oy + 64, (64, 64, 66))
    paint_glass(cv, oy, 22, 12, 106, 64, (98, 108, 116), (140, 128, 108), rng)
    register_window(oy, 22, 12, 106, 64)
    cv.rect(22, oy + 26, 106, oy + 28, (70, 72, 76))
    cv.rect(63, oy + 12, 65, oy + 64, (70, 72, 76))

    # The Castle (Tudor Revival, 1915), from photos: buff Amherst sandstone ashlar, three-light
    # mullioned and transomed windows with arched heads, a carved hood mould over each
    oy = B_TUDOR * BAND_H
    paint_stone(cv, oy, (210, 192, 156), (186, 168, 134), rng, course=8, block=22, var=6)
    sand = (222, 206, 172)
    cv.rect(24, oy + 8, 104, oy + 12, sand, rng, 2)           # hood mould
    cv.rect(22, oy + 12, 26, oy + 16, sand)
    cv.rect(102, oy + 12, 106, oy + 16, sand)
    for x0 in (30, 56, 82):
        for y in range(13, 54):
            hw = 9 if y >= 19 else math.sqrt(max(0, 81 - (19 - y) ** 2 * 2.2))
            for x in range(int(x0 + 8 - hw), int(x0 + 8 + hw)):
                c = mix((88, 96, 104), (48, 52, 60), (y - 13) / 41)
                if (x + y) % 6 == 0 or (x - y) % 6 == 0:   # leaded diamond quarries
                    c = (c[0] * 0.75, c[1] * 0.75, c[2] * 0.75)
                cv.put(x, oy + y, c)
        register_window(oy, x0, 19, x0 + 16, 54)
    cv.rect(26, oy + 13, 30, oy + 54, sand)                    # mullions and surround
    for x0 in (46, 72, 98):
        cv.rect(x0, oy + 13, x0 + 10 if x0 < 98 else x0 + 4, oy + 54, sand)
    cv.rect(26, oy + 33, 102, oy + 35, sand)                   # transom
    cv.rect(24, oy + 54, 104, oy + 58, sand, rng, 2)           # sill

    # newer blue-green reflective curtain wall
    oy = B_BLUEGLASS * BAND_H
    paint_glass(cv, oy, 0, 0, TEX_W, 64, (110, 150, 168), (64, 98, 118), rng)
    register_window(oy, 4, 4, 60, 56)
    register_window(oy, 68, 4, 124, 56)
    for x0 in (0, 64):
        cv.rect(x0, oy, x0 + 3, oy + 64, (150, 164, 172))
    cv.rect(0, oy + 56, TEX_W, oy + 60, (120, 140, 150))


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
    "glass_rail": (150, 172, 180), "fin_white": (226, 228, 226), "fin_metal": (120, 126, 132),
    "concrete_fin": (184, 178, 164), "water_tank": (112, 92, 72), "hatch": (120, 120, 118),
    "fin_rust": (160, 126, 104), "fin_sand": (205, 187, 154), "copper": (110, 156, 136),
    "awning": (150, 172, 192), "stone_cream": (216, 210, 196), "tan_pier": (190, 172, 146),
    "penthouse": (206, 210, 212), "brick_salmon": (192, 128, 110),
    "sandstone": (212, 194, 158), "sand_trim": (226, 212, 180), "slate_grey": (112, 118, 126),
    "copper_green": (112, 160, 138), "chimney_brick": (150, 76, 58),
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
# Named tints for particular buildings: buff sandstone (the Castle), grey precast (NEIDL),
# deeper red brick, sun-faded brick.
EXTRA_TINTS = {"facade_sand": (255, 236, 196), "facade_grey": (226, 228, 230), "facade_deep": (226, 206, 198),
               "facade_faded": (255, 240, 228)}


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material_defs():
    mats = []
    for i, t in enumerate(FACADE_TINTS):
        mats.append({"name": f"facade_{i}", "color": t, "texture": True, "rough": 0.88, "metal": 0.0})
    for name, t in EXTRA_TINTS.items():
        mats.append({"name": name, "color": t, "texture": True, "rough": 0.88, "metal": 0.0})
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
# Lit windows: black base, warm emissive. Drawn as a separate mesh the layer shows at dusk/night.
# Lit windows: black base, emissive glow, one mesh per campus. Every window quad's TEXCOORD_0 holds
# its schedule, (on hour, off hour) on a 12..36 h axis (so 26 = 2 AM); buildings.ts switches them
# with a clock uniform in the shader, so lights come on and go off smoothly as the sim time moves.
LIT_MATERIALS = [
    {"name": "lit_warm", "color": (0, 0, 0), "emissive": (236, 170, 104), "texture": False, "rough": 1.0, "metal": 0.0},
    {"name": "lit_soft", "color": (0, 0, 0), "emissive": (240, 204, 150), "texture": False, "rough": 1.0, "metal": 0.0},
    {"name": "lit_neutral", "color": (0, 0, 0), "emissive": (232, 228, 210), "texture": False, "rough": 1.0, "metal": 0.0},
    {"name": "lit_cool", "color": (0, 0, 0), "emissive": (200, 214, 236), "texture": False, "rough": 1.0, "metal": 0.0},
]
DATA_UV = {m["name"] for m in LIT_MATERIALS}
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
            p = self.prims[mat] = Prim(mat in TEXTURED or mat in DATA_UV)
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
        per = METRES_PER_LEVEL
        if tags.get("building") in ("dormitory", "apartments", "residential", "hotel") and lv >= 10:
            per = 3.1  # high-rise housing has lower storeys than classroom buildings
        h = lv * per
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
    "way/256604722": "questrom", "way/1026274040": "garage", "way/29887049": "castle", "way/1007090933": "theology",
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
            return "brownstone" if k < 7 else "rowlime" if k < 9 else "rowbrick"
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
        self.lit = None
        self.floor_plans = {}
        self.heights = {}

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
        self.lit_share = 0.3
        self.use = "office"    # how it's lit after dark: see light_windows
        self.library_floors = ()  # floors lit late like a library (Pardee Library in Questrom)
        self.bands = None      # (upper, ground) band override for a specific building
        self.tint = None       # facade material override, e.g. "facade_3"
        self.fins = None       # (spacing m, depth m, width m, material, from y or None, to y or None)
        self.arcade = None     # pier spacing along street fronts, e.g. 4.5
        self.rail = False      # glass terrace railing instead of a parapet
        self.facing_bands = None  # (north/south band, east/west band)
        self.top_band = None   # a different top storey (glazed crowns, attic floors)
        self.canopy = False    # a street canopy over the shopfronts


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
    if v.bands:
        upper, ground = v.bands[0], v.bands[1]
        if len(v.bands) > 2:
            bay = v.bands[2]
    glassy = family == "glass"
    tints = GLASS_TINTS if glassy else FACADE_TINTS
    mat = v.tint or ("glassfacade_" if glassy else "facade_") + str(h32(v.key) % len(tints))
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
            if getattr(v, "edges", None):
                party, neighbour_h, _ = v.edges[ri][i]
            else:
                party, neighbour_h = False, 0.0
                if v.party:
                    for t in (0.5, 0.2, 0.8):
                        probe = (ra[0] + (rb[0] - ra[0]) * t + nrm[0] * 1.2, ra[1] + (rb[1] - ra[1]) * t + nrm[1] * 1.2)
                        key = ctx.footprint_at(probe, exclude)
                        if key:
                            party = True
                            neighbour_h = max(neighbour_h, ctx.heights.get(key, y1))
            info.append({"a": a, "b": b, "ra": ra, "rb": rb, "L": L, "n": nrm, "mid": mid, "party": party, "outer": ri == 0})
            first = 0
            if party:
                # Blank party wall up to the neighbour's roof; windows again where we rise above it.
                above = [k for k in range(len(ys) - 1) if ys[k] >= neighbour_h + 0.5]
                if not above or y1 - neighbour_h < 4.0:
                    mesh.wall("wall_" + family, a, b, y0, y1)
                    continue
                first = above[0]
                mesh.wall("wall_" + family, a, b, y0, ys[first])
            if L < bay * 0.55:
                u0, u1 = BLANK_U
            else:
                u0, u1 = 0.0, float(max(1, round(L / bay)))
            up = upper
            if v.facing_bands:
                up = v.facing_bands[0] if abs(nrm[1]) >= abs(nrm[0]) else v.facing_bands[1]
            for k in range(first, len(ys) - 1):
                band = ground if (k == 0 and v.ground) else up
                if v.top_band is not None and k == len(ys) - 2 and len(ys) > 3:
                    band = v.top_band
                vb, vt = band_v(band)
                mesh.wall(mat, a, b, ys[k], ys[k + 1], (u0, u1, vb, vt))
                if u0 == 0.0:
                    light_windows(ctx, v, band, a, b, ys[k], ys[k + 1], int(u1), nrm, floor=k)
    return info, ys


# How BU's buildings are used after dark, by use class. Each entry builds schedules for whole floors
# (institutional) or for rooms of 1-3 adjacent windows (housing). Hours are on a 12..36 axis.
def _floor_plan(ctx, v, floor):
    """One schedule per (building volume, floor): shared by every wall of that floor."""
    key = (v.key, floor)
    plan = ctx.floor_plans.get(key)
    if plan is None:
        r = random.Random(h32(f"{v.key}|{floor}"))
        use = v.use
        if floor in v.library_floors:
            use = "library"
        if use == "office":
            lit = r.random() < 0.82
            plan = (lit, 15.0 + r.random() * 2.0, 20.5 + r.random() * 2.0 if r.random() > 0.06 else 23.0 + r.random())
        elif use == "glass":
            plan = (r.random() < 0.9, 15.0 + r.random() * 1.5, 21.0 + r.random() * 2.0)
        elif use == "library":
            plan = (r.random() < 0.92, 15.0, 25.0 + r.random() * 1.5 if floor <= 3 else 22.5 + r.random() * 2.5)
        elif use == "medical":
            plan = (r.random() < 0.85, 15.0, 30.0 if r.random() < 0.25 else 21.0 + r.random() * 5.0)
        elif use == "arena":
            plan = (True, 16.0, 23.0)
        elif use == "church":
            plan = (True, 16.5, 21.0)
        elif use == "venue":  # the Castle: events and the pub in the evening
            plan = (r.random() < 0.85, 16.3, 23.0 + r.random() * 1.5)
        elif use == "retail":
            plan = (True, 15.0, 22.0 + r.random() * 1.5) if floor == 0 else None
        else:
            plan = None
        ctx.floor_plans[key] = plan
    return plan


def _room_schedule(r, cosy):
    """A dorm or apartment room: (used, on, off, morning?)."""
    if r.random() > (0.42 if cosy else 0.78):
        return None
    on = 16.0 + r.random() * 3.5
    x = r.random()
    if x < 0.15:
        off = 21.0 + r.random() * 2.0
    elif x < 0.65:
        off = 23.0 + r.random() * 3.0          # 11 PM - 2 AM
    elif x < 0.92:
        off = 26.0 + r.random() * 2.0          # 2 - 4 AM
    else:
        off = 30.5                             # up all night
    morning = r.random() < (0.12 if cosy else 0.2)
    return on, off, morning


def light_windows(ctx, v, band, a, b, y0, y1, nbays, nrm, out=0.12, floor=None):
    """Lit-window quads for one storey of one wall, grouped by floor and room, with schedules."""
    rects = WINDOWS.get(band)
    if not rects or ctx.lit is None or v.use == "none":
        return
    if floor is None:
        floor = int(max(0.0, y0) // 3.6)
    h = y1 - y0
    plan = _floor_plan(ctx, v, floor)
    rng = random.Random(h32(f"{v.key}|{floor}|{a[0]:.1f},{a[1]:.1f}"))
    housing = plan is None
    mat_inst = {"venue": "lit_warm", "office": "lit_cool", "glass": "lit_cool", "medical": "lit_cool", "library": "lit_neutral",
                "arena": "lit_neutral", "church": "lit_soft", "retail": "lit_soft"}.get(v.use, "lit_neutral")
    # stairwell / corridor column: one bay per long wall stays dimly lit all night in institutions
    stair = rng.randrange(nbays) if (not housing and nbays >= 4 and v.use in ("office", "glass", "library", "medical")) else -1
    room_left = 0
    room = None
    merge = band in CURTAIN_BANDS
    runs = []  # (first bay, last bay, mat, spans) when merging curtain-wall glass into floor plates
    for i in range(nbays):
        if housing:
            if room_left == 0:
                room_left = 1 + rng.randrange(3)
                room = _room_schedule(rng, v.use == "cosy")
            room_left -= 1
            if room is None:
                continue
            on, off, morning = room
            mat = "lit_warm" if rng.random() < 0.6 else "lit_soft"
            spans = [(on, off)] + ([(29.3 + rng.random() * 0.8, 31.0 + rng.random() * 0.6)] if morning and off < 29 else [])
        else:
            if i == stair:
                spans = [(15.0, 35.9)]
                mat = "lit_neutral"
            elif plan and plan[0] and rng.random() > 0.08:
                spans = [(plan[1] + rng.random() * 0.3, plan[2] + rng.random() * 0.25)]
                mat = mat_inst
            else:
                continue
        if merge:
            if runs and runs[-1][1] == i - 1 and runs[-1][2] == mat and (housing or i != stair) and runs[-1][4]:
                runs[-1][1] = i
            else:
                runs.append([i, i, mat, spans, housing or i != stair])
            continue
        for (x0, py0, x1, py1) in rects:
            _lit_quad(ctx, a, b, nrm, out, (i + x0 / TEX_W) / nbays, (i + x1 / TEX_W) / nbays,
                      y1 - h * py1 / BAND_H, y1 - h * py0 / BAND_H, mat, spans)
    if merge and runs:
        x0 = min(r[0] for r in rects) / TEX_W
        x1 = max(r[2] for r in rects) / TEX_W
        py0 = min(r[1] for r in rects)
        py1 = max(r[3] for r in rects)
        for first, last, mat, spans, _ in runs:
            _lit_quad(ctx, a, b, nrm, out, (first + x0) / nbays, (last + x1) / nbays,
                      y1 - h * py1 / BAND_H, y1 - h * py0 / BAND_H, mat, spans)


# Glass bands whose windows run edge to edge: a lit floor is drawn as one plate per wall.
CURTAIN_BANDS = {B_GLASS, B_CDS, B_CDS_FRIT, B_BLUEGLASS, B_LOBBY, B_MED_BRICK, B_SHOP, B_MODERN, B_SERT}


def _lit_quad(ctx, a, b, nrm, out, t0, t1, ya, yb, mat, spans):
    p0 = (a[0] + (b[0] - a[0]) * t0 + nrm[0] * out, a[1] + (b[1] - a[1]) * t0 + nrm[1] * out)
    p1 = (a[0] + (b[0] - a[0]) * t1 + nrm[0] * out, a[1] + (b[1] - a[1]) * t1 + nrm[1] * out)
    for on, off in spans:
        ctx.lit.wall(mat, p0, p1, ya, yb, (on, on, off, off))


def build_flat_top(mesh, v, rings_o, y_roof, edges, rng):
    """Parapet, cornice lip and roof slab."""
    upper, ground, bay, family, cornice, mat = facade_mats(v)
    trim = CORNICE_MAT[cornice]
    p = v.parapet
    lip = 0.15 if family == "glass" else 0.4
    ch = 0.35 if family == "glass" else 0.55
    top = y_roof + p
    edges = getattr(v, "edges", None) or [[(False, 0, False)] * len(r) for r in rings_o]
    rings_c = [offset_ring_var(r, [0.0 if f[2] else lip for f in fl]) for r, fl in zip(rings_o, edges)]
    rings_in = v.rings
    for ro, rc, ri, fl in zip(rings_o, rings_c, rings_in, edges):
        n = len(ro)
        for i in range(n):
            j = (i + 1) % n
            if dist(ro[i], ro[j]) < 0.05 or fl[i][2]:
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
            if v.rail:
                mesh.wall("glass_rail", rc[i], rc[j], top, top + 1.05)
                mesh.wall("glass_rail", rc[j], rc[i], top, top + 1.05)
    roof_mat = v.roof_mat or ("roof_dark", "roof_light", "roof_gravel")[h32(v.key + "r") % 3]
    slab = [offset_ring_var(r, [-SHARED_INSET if f[2] else 0.0 for f in fl]) for r, fl in zip(rings_in, edges)]
    mesh.flat(roof_mat, slab, y_roof, True)
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
    shared = [f[2] for f in (getattr(v, "edges", None) or [[(False, 0, False)] * len(ring)])[0]]
    inset = offset_ring_var(ring, [0.0 if sh else -d for sh in shared])
    if not inset_ok(ring, offset_ring(ring, -d)):
        return None
    trim = CORNICE_MAT[cornice]
    # cornice at the eave (not on shared party walls: the neighbour's cornice continues it)
    ring_c = offset_ring_var(ring, [0.0 if sh else 0.35 for sh in shared])
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        if shared[i]:
            continue
        mesh.wall(trim, ring_c[i], ring_c[j], y_eave - 0.45, y_eave + 0.15)
        mesh.face(trim, [(ring[i][0], y_eave - 0.45, -ring[i][1]), (ring[j][0], y_eave - 0.45, -ring[j][1]),
                         (ring_c[j][0], y_eave - 0.45, -ring_c[j][1]), (ring_c[i][0], y_eave - 0.45, -ring_c[i][1])])
        mesh.face(trim, [(ring_c[i][0], y_eave + 0.15, -ring_c[i][1]), (ring_c[j][0], y_eave + 0.15, -ring_c[j][1]),
                         (ring[j][0], y_eave + 0.15, -ring[j][1]), (ring[i][0], y_eave + 0.15, -ring[i][1])])
    y0 = y_eave + 0.15
    for i in range(n):
        j = (i + 1) % n
        if shared[i]:
            mesh.wall("wall_" + family, ring[i], ring[j], y_eave - 0.45, y0 + r)  # gable end of the mansard
            continue
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


def add_fins(mesh, v, info, ys, y_eave):
    """Vertical fins / sun-shading blades standing proud of the facade."""
    spacing, depth, width, mat, fy0, fy1 = v.fins
    y0 = (ys[1] if v.ground else ys[0]) if fy0 is None else fy0
    y1 = y_eave if fy1 is None else fy1
    for e in info:
        if e["party"] or e["L"] < spacing:
            continue
        a, b, L, nrm = e["a"], e["b"], e["L"], e["n"]
        eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        k = max(1, int(round(L / spacing)))
        for m in range(k + 1):
            t = m / k
            c = (a[0] + (b[0] - a[0]) * t + nrm[0] * depth / 2, a[1] + (b[1] - a[1]) * t + nrm[1] * depth / 2)
            mesh.box(mat, c, eu, width / 2, depth / 2, y0, y1, top_mat=mat)


def add_arcade(mesh, v, info, fronts, ys):
    """Street arcade: square piers standing in front of a recessed, shaded ground floor."""
    _, _, _, family, cornice, _ = facade_mats(v)
    trim = CORNICE_MAT[cornice]
    h = ys[1]
    for e in fronts[:2]:
        a, b, L, nrm = e["a"], e["b"], e["L"], e["n"]
        if L < 8:
            continue
        eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
        k = max(2, int(round(L / v.arcade)))
        for m in range(k + 1):
            t = m / k
            c = (a[0] + (b[0] - a[0]) * t + nrm[0] * 0.35, a[1] + (b[1] - a[1]) * t + nrm[1] * 0.35)
            mesh.box(trim, c, eu, 0.45, 0.45, -0.2, h, top_mat=trim)
        a2 = (a[0] + nrm[0] * 0.8, a[1] + nrm[1] * 0.8)
        b2 = (b[0] + nrm[0] * 0.8, b[1] + nrm[1] * 0.8)
        mesh.wall(trim, a2, b2, h, h + 0.6)
        mesh.face(trim, [(a[0], h, -a[1]), (b[0], h, -b[1]), (b2[0], h, -b2[1]), (a2[0], h, -a2[1])])


SHARED_INSET = 0.04  # shared party walls sit just inside the footprint, so neighbours never overlap


def party_edges(v, ctx, exclude):
    """Per ring, per edge: (party?, neighbour height, shared?). Shared = a neighbour at least as tall
    stands against this wall, so it gets no outward offset, cornice or parapet (rowhouses)."""
    out = []
    for ring in v.rings:
        flags = []
        n = len(ring)
        for i in range(n):
            ra, rb = ring[i], ring[(i + 1) % n]
            party, nh = False, 0.0
            if v.party and dist(ra, rb) > 0.05:
                nrm = right_normal(ra, rb)
                for t in (0.5, 0.2, 0.8):
                    probe = (ra[0] + (rb[0] - ra[0]) * t + nrm[0] * 1.2, ra[1] + (rb[1] - ra[1]) * t + nrm[1] * 1.2)
                    key = ctx.footprint_at(probe, exclude)
                    if key:
                        party = True
                        nh = max(nh, ctx.heights.get(key, v.top))
            flags.append((party, nh, party and nh >= v.top - 0.6))
        out.append(flags)
    return out


def build_volume(mesh, v, ctx, exclude, rng):
    """Walls, ground floor, doors and roof for one volume. Returns the top of the model (m)."""
    v.edges = party_edges(v, ctx, exclude)
    rings_o = [offset_ring_var(r, [-SHARED_INSET if f[2] else wall_out(v.top) for f in fl])
               for r, fl in zip(v.rings, v.edges)]
    y0 = v.base - 0.3 if v.base > 0.5 else -0.2
    y_eave = v.top + roof_up(v.top)
    info, ys = build_walls(mesh, v, ctx, rings_o, y0, y_eave, exclude)
    _, _, _, family, cornice, _ = facade_mats(v)
    if v.base > 0.5:
        mesh.flat("trim_white" if v.style == "cds" else "wall_" + family, rings_o, y0, False)
    fronts = street_edges(v, info, ctx, v.tags) if (v.door or v.bays or v.canopy or v.arcade) and v.ground else []
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
    if v.fins:
        add_fins(mesh, v, info, ys, y_eave)
    if v.arcade and fronts:
        add_arcade(mesh, v, info, fronts, ys)
    if v.canopy and fronts:
        for e in fronts[:1]:
            a, b, L, nrm = e["a"], e["b"], e["L"], e["n"]
            eu = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
            if v.canopy == "barrel":
                # a long curved awning (quarter barrel) springing from the wall over the sidewalk
                d, h0 = 3.2, ys[1] - 0.4
                a0 = (a[0] + eu[0] * L * 0.05, a[1] + eu[1] * L * 0.05)
                b0 = (b[0] - eu[0] * L * 0.05, b[1] - eu[1] * L * 0.05)
                K = 6
                pts = [(d * math.sin(math.pi / 2 * k / K), h0 - 2.4 + 2.4 * math.cos(math.pi / 2 * k / K) + 2.4 * 0) for k in range(K + 1)]
                pts = [(d * (1 - math.cos(math.pi / 2 * k / K)), h0 - 2.0 * (1 - math.sin(math.pi / 2 * k / K)) + 0.0) for k in range(K + 1)]
                pts = [(d * math.sin(math.pi / 2 * k / K), h0 - 2.2 + 2.2 * math.cos(math.pi / 2 * k / K)) for k in range(K + 1)]
                for k in range(K):
                    (o0, y0_), (o1, y1_) = pts[k], pts[k + 1]
                    q = [(a0[0] + nrm[0] * o0, y0_, -(a0[1] + nrm[1] * o0)), (b0[0] + nrm[0] * o0, y0_, -(b0[1] + nrm[1] * o0)),
                         (b0[0] + nrm[0] * o1, y1_, -(b0[1] + nrm[1] * o1)), (a0[0] + nrm[0] * o1, y1_, -(a0[1] + nrm[1] * o1))]
                    mesh.face("awning", q[::-1])
                    mesh.face("trim_metal", q)
            else:
                c = ((a[0] + b[0]) / 2 + nrm[0] * 0.9, (a[1] + b[1]) / 2 + nrm[1] * 0.9)
                mesh.box("trim_metal", c, eu, L / 2 * 0.9, 0.9, ys[1] - 0.6, ys[1] - 0.3, top_mat="trim_metal", bottom=True)
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
            # roof hatch and a skylight (Boston rowhouses have these, not New York water tanks)
            centre, eu2, ev2, hu2, hv2 = obb(v.rings[0])
            if hu2 > 4 and hv2 > 2:
                mesh.box("hatch", (centre[0] + eu2[0] * hu2 * 0.3, centre[1] + eu2[1] * hu2 * 0.3), eu2, 0.5, 0.5, y_eave, y_eave + 0.6, top_mat="hatch")
                mesh.box("glass_dark", (centre[0] - eu2[0] * hu2 * 0.25, centre[1] - eu2[1] * hu2 * 0.25), eu2, 0.8, 0.6, y_eave, y_eave + 0.35, top_mat="glass_rail")
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

def tower(mesh, ring, y0, y1, storeys, spacing, key, roof="pyramid", band=B_LANCET, pinnacles=True, cap=None, cap_ratio=0.55):
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
    if roof is None:
        pass
    elif roof == "pyramid":
        inner = offset_ring(ro, -0.6)
        mesh.pyramid(cap or "slate", inner, y1 + 0.6, y1 + 0.6 + side * cap_ratio)
        top = max(top, y1 + 0.6 + side * cap_ratio)
    return top


def landmark_chapel(mesh, b, ctx, rng, vols):
    """Marsh Chapel (Cram & Ferguson, 1950): Indiana-limestone collegiate Gothic nave with
    buttresses and pinnacles, a steep slate roof, a great traceried window in the gable facing
    Marsh Plaza, flanked by two slender pinnacles (checked against photos). (The 350 ft bell tower planned
    behind it was never built, so there is no big tower.)"""
    v = vols[0]
    ring = v.rings[0]
    ring_o = offset_ring(ring, wall_out(v.top))
    centre, eu, ev, hu, hv = obb(ring_o)
    eave = max(v.top, 12.1) + roof_up(v.top)
    nave_eave = eave + 2.0
    vb, vt = band_v(B_LANCET)
    mat = "facade_0"
    n = len(ring_o)
    south_edge = None
    for i in range(n):
        a, bb = ring_o[i], ring_o[(i + 1) % n]
        L = dist(a, bb)
        if L < 0.05:
            continue
        nrm = right_normal(a, bb)
        u = (0.0, float(max(1, round(L / 4.4)))) if L > 2.5 else BLANK_U
        mesh.wall(mat, a, bb, -0.2, nave_eave, (u[0], u[1], vb, vt))
        if L > 6 and (south_edge is None or nrm[1] < south_edge[2][1]):
            south_edge = (a, bb, nrm, L)
        # buttresses with pinnacles between the windows on the long walls
        if L > 8:
            k = int(round(L / 4.4))
            e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
            for m in range(k + 1):
                t = m / k
                c = (a[0] + (bb[0] - a[0]) * t + nrm[0] * 0.55, a[1] + (bb[1] - a[1]) * t + nrm[1] * 0.55)
                mesh.box("trim_stone", c, e2, 0.42, 0.55, -0.2, nave_eave - 1.6, top_mat="trim_stone")
                c2 = (c[0] - nrm[0] * 0.25, c[1] - nrm[1] * 0.25)
                sq = [(c2[0] + sx * 0.32 * e2[0] + sy * 0.32 * nrm[0], c2[1] + sx * 0.32 * e2[1] + sy * 0.32 * nrm[1])
                      for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
                mesh.prism("trim_stone", sq, nave_eave - 1.6, nave_eave + 1.2)
                mesh.pyramid("trim_stone", sq, nave_eave + 1.2, nave_eave + 3.4)
    v.style = "gothic"
    v.roof_mat = "slate"
    rise = min(hv * 1.25, 12.0)
    ridge = pitched_top(mesh, v, ring_o, nave_eave, "gabled", rise=rise)
    # great traceried window on the plaza end
    if south_edge:
        a, bb, nrm, L = south_edge
        w = min(L * 0.5, 9.0)
        mid = ((a[0] + bb[0]) / 2 + nrm[0] * 0.08, (a[1] + bb[1]) / 2 + nrm[1] * 0.08)
        e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
        p0 = (mid[0] - e2[0] * w / 2, mid[1] - e2[1] * w / 2)
        p1 = (mid[0] + e2[0] * w / 2, mid[1] + e2[1] * w / 2)
        tvb, tvt = band_v(B_TRACERY)
        mesh.wall("facade_0", p0, p1, 3.0, nave_eave + rise * 0.42, (0.0, 1.0, tvb, tvt))
        light_windows(ctx, v, B_TRACERY, p0, p1, 3.0, nave_eave + rise * 0.42, 1, nrm, out=0.1)
    # photos: two slender octagonal pinnacles flank the plaza gable and rise well above it; the
    # gable has a carved stone coping with a cross; lower flat-roofed aisles at the sides
    top = ridge
    if south_edge:
        a, bb, nrm, L = south_edge
        e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
        mid = ((a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2)
        for sx in (-1, 1):
            c = (mid[0] + e2[0] * sx * (L / 2 - 1.6) - nrm[0] * 0.6, mid[1] + e2[1] * sx * (L / 2 - 1.6) - nrm[1] * 0.6)
            oct_ = [(c[0] + 0.95 * math.cos(math.pi / 8 + k * math.pi / 4), c[1] + 0.95 * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]
            mesh.prism("trim_stone", oct_, -0.2, ridge + 1.5)
            mesh.pyramid("trim_stone", oct_, ridge + 1.5, ridge + 8.5)
            top = max(top, ridge + 8.5)
        cross = (mid[0] - nrm[0] * 0.3, mid[1] - nrm[1] * 0.3)
        mesh.box("trim_stone", cross, e2, 0.12, 0.12, ridge, ridge + 2.2)
        mesh.box("trim_stone", (cross[0], cross[1]), e2, 0.55, 0.12, ridge + 1.3, ridge + 1.55)
    return max(top, ridge + 2.2)


def landmark_cas(mesh, b, ctx, rng, vols, plaza_side="west"):
    """CAS (and the School of Theology): long Indiana-limestone blocks in sleek collegiate Gothic
    (Cram & Ferguson, 1939-50): tall vertical bays of pointed casements and a battlemented roof.
    Photos show a square stone tower with tall lancets and a steep pyramidal stone spire at the end
    of each block facing Marsh Plaza, so the plaza is framed by two spires with the chapel between."""
    v = vols[0]
    v.style = "gothic"
    v.roof = "flat"
    v.bands = (B_LIME_STRIP, B_LIME_GROUND, 2.6)
    v.top_band = B_LIME
    v.levels = max(v.levels, 5)
    v.merlons = True
    top = build_volume(mesh, v, ctx, {b.ref}, rng)
    ring = v.rings[0]
    centre, eu, ev, hu, hv = obb(ring)
    long_ax = eu if abs(eu[0]) > abs(eu[1]) else ev
    toward = long_ax if (long_ax[0] > 0) == (plaza_side == "east") else (-long_ax[0], -long_ax[1])
    across = (-toward[1], toward[0])
    half_long = hu if long_ax is eu else hv
    s = 10.5
    tc = (centre[0] + toward[0] * (half_long - s / 2 - 1.0), centre[1] + toward[1] * (half_long - s / 2 - 1.0))
    sq = [(tc[0] + sx * s / 2 * toward[0] + sy * s / 2 * across[0], tc[1] + sx * s / 2 * toward[1] + sy * s / 2 * across[1])
          for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    y1 = v.top + ROOF_UP + 10.0
    t = tower(mesh, sq, -0.2, y1, 4, 2.6, b.ref + "t", roof="pyramid", band=B_LANCET, pinnacles=True,
              cap="trim_stone", cap_ratio=1.25)
    return max(top, t)


def landmark_theology(mesh, b, ctx, rng, vols):
    return landmark_cas(mesh, b, ctx, rng, vols, plaza_side="east")


def landmark_warren(mesh, b, ctx, rng, vols):
    """Warren Towers (1965), checked against photos: three 18-storey towers (Fairfield, Marshall,
    Shields) in tan masonry with narrow window columns between projecting piers and a single
    vertical window strip on each end face, on a 4-storey tan podium (ribbon windows on the dining
    floor) with a long curved blue-grey awning over the Comm Ave shops; small rooftop boxes."""
    # The three towers are the relation pieces under OSM's named tower parts (Fairfield, Marshall,
    # Shields); everything else (including the 566 m2 east-end piece) is podium.
    tower_rings = []
    for el in b.parts:
        if str(el.get("tags", {}).get("name", "")).endswith("Tower"):
            for o, inn in element_rings(el):
                tower_rings.append(local_rings(ctx.frame, o, inn)[0])
    towers, podium = [], []
    for v in vols:
        c = ring_centroid(v.rings[0])
        (towers if any(point_in_ring(c, r) for r in tower_rings) else podium).append(v)
    top = 0
    pod_h = 15.5
    for v in podium:
        v.top = pod_h
        v.levels = 4
        v.style = "buff"
        v.bands = (B_GARAGE, B_SHOP, 3.2)
        v.top_band = B_BUFF
        v.mech = False
        v.parapet = 1.1
        v.canopy = "barrel"
        v.lit_share = 0.35
        v.use = "retail"
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    for v in towers:
        v.top = 56.0  # 18 storeys: the 4-storey podium plus 14 residential floors
        v.levels = 18
        v.style = "buff"
        v.bands = (B_WARREN, B_GARAGE, 2.5)
        v.fins = (2.5, 0.45, 0.45, "tan_pier", None, None)
        v.base = 0.0
        v.ground = True
        v.door = False
        v.parapet = 1.2
        v.mech = False
        v.lit_share = 0.5
        t = build_volume(mesh, v, ctx, {b.ref}, rng)
        centre, eu, ev, hu, hv = obb(v.rings[0])
        y = v.top + ROOF_UP
        ring = [(centre[0] + sx * hu * 0.62 * eu[0] + sy * hv * 0.7 * ev[0], centre[1] + sx * hu * 0.62 * eu[1] + sy * hv * 0.7 * ev[1])
                for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        ring = oriented(ring)
        mesh.prism("tan_pier", ring, y, y + 3.4, top_mat="roof_light")
        top = max(top, t, y + 4.6)
    return top


def landmark_stuvi(mesh, b, ctx, rng, vols):
    """StuVi I (2000) and StuVi II (Cannon Design, 2009: terracotta rainscreen and metal panels,
    full-height bedroom windows, glazed lobby and top activity floor)."""
    top = 0
    stuvi2 = b.ref == "way/155291470"
    for v in vols:
        v.style = "buff"
        v.bands = (B_TERRA, B_LOBBY, 2.6) if stuvi2 else (B_BUFF, B_LOBBY, 3.0)
        v.top_band = B_GLASS
        v.parapet = 1.6
        v.mech = True
        v.lit_share = 0.5
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_arena(mesh, b, ctx, rng, vols):
    """Agganis Arena (CannonDesign, 2005; 925 Comm Ave). Sources describe mostly red brick and
    architectural precast panels on a steel frame, punched windows and a couple of large
    curtain-wall sections, a 6,200-7,200-seat bowl, and the Harry Agganis statue at the corner of
    Comm Ave and Harry Agganis Way. Modelled as: a cast-stone base, brick walls with precast
    banding and punched windows, a long shallow standing-seam barrel roof with rooftop plant, a
    full-height glazed entrance pavilion on the Comm Ave / Harry Agganis Way corner with a canopy
    and an AGGANIS ARENA sign band, and loading docks further up Harry Agganis Way."""
    v = vols[0]
    ring = v.rings[0]
    eave = 17.5
    v.top = eave
    v.style = "brick"
    v.bands = (B_PHOTONICS, B_HOTEL_BASE, 4.2)
    v.top_band = B_BRICK
    v.levels = 4
    v.ground = True
    v.door = False
    v.roof = "flat"
    v.mech = False
    v.parapet = 0.6
    v.cornice = True
    v.lit_share = 0.35
    rings_o = [offset_ring(r, wall_out(eave)) for r in v.rings]
    y_eave = eave + roof_up(eave)
    info, ys = build_walls(mesh, v, ctx, rings_o, -0.2, y_eave, {b.ref})
    # precast band courses between storeys
    for e in info:
        if e["party"]:
            continue
        a, bb, nrm = e["a"], e["b"], e["n"]
        a2 = (a[0] + nrm[0] * 0.18, a[1] + nrm[1] * 0.18)
        b2 = (bb[0] + nrm[0] * 0.18, bb[1] + nrm[1] * 0.18)
        for y in ys[1:-1]:
            mesh.wall("trim_stone", a2, b2, y - 0.45, y)
            mesh.face("trim_stone", [(a2[0], y, -a2[1]), (b2[0], y, -b2[1]), (bb[0], y, -bb[1]), (a[0], y, -a[1])])
    ring_o = rings_o[0]
    centre, eu, ev, hu, hv = obb(ring_o)
    # cornice
    rc = offset_ring(ring_o, 0.45)
    n = len(ring_o)
    for i in range(n):
        j = (i + 1) % n
        mesh.wall("trim_stone", rc[i], rc[j], y_eave - 0.7, y_eave + 0.3)
        mesh.face("trim_stone", [(ring_o[i][0], y_eave - 0.7, -ring_o[i][1]), (ring_o[j][0], y_eave - 0.7, -ring_o[j][1]),
                                 (rc[j][0], y_eave - 0.7, -rc[j][1]), (rc[i][0], y_eave - 0.7, -rc[i][1])])
    mesh.flat("roof_dark", [rc], y_eave + 0.3, True)
    # long shallow barrel roof over the bowl, ridge along the long axis, standing seams across it
    rise = 7.5
    inset = 3.0
    hu_r, hv_r = hu - inset, hv - inset
    K = 10
    y_r = y_eave + 0.3

    def P(u, w, y):
        return (centre[0] + eu[0] * u + ev[0] * w, y, -(centre[1] + eu[1] * u + ev[1] * w))
    ws = [-hv_r + 2 * hv_r * k / K for k in range(K + 1)]
    hs = [y_r + 0.8 + rise * math.sqrt(max(0.0, 1 - (w / hv_r) ** 2)) for w in ws]
    for k in range(K):
        mesh.face("roof_metal", [P(-hu_r, ws[k], hs[k]), P(-hu_r, ws[k + 1], hs[k + 1]),
                                 P(hu_r, ws[k + 1], hs[k + 1]), P(hu_r, ws[k], hs[k])][::-1])
    for end in (-1, 1):  # end walls of the vault
        pts = [P(end * hu_r, w, h) for w, h in zip(ws, hs)] + [P(end * hu_r, hv_r, y_r), P(end * hu_r, -hv_r, y_r)]
        cx = sum(q[0] for q in pts) / len(pts)
        cz = sum(q[2] for q in pts) / len(pts)
        for k in range(K):
            tri = [P(end * hu_r, ws[k], y_r), P(end * hu_r, ws[k], hs[k]), P(end * hu_r, ws[k + 1], hs[k + 1]), P(end * hu_r, ws[k + 1], y_r)]
            mesh.face("trim_metal", tri if end > 0 else tri[::-1])
    for side in (-1, 1):  # low curb walls along the vault's edges
        a = (centre[0] + eu[0] * -hu_r + ev[0] * side * hv_r, centre[1] + eu[1] * -hu_r + ev[1] * side * hv_r)
        bb = (centre[0] + eu[0] * hu_r + ev[0] * side * hv_r, centre[1] + eu[1] * hu_r + ev[1] * side * hv_r)
        if side < 0:
            a, bb = bb, a
        mesh.wall("trim_metal", a, bb, y_r, y_r + 0.8)
    # standing seams: thin ribs following the curve
    nseam = int(2 * hu_r / 2.4)
    for m in range(nseam + 1):
        u = -hu_r + 2 * hu_r * m / nseam
        for k in range(K):
            p0, p1 = P(u, ws[k], hs[k] + 0.06), P(u, ws[k + 1], hs[k + 1] + 0.06)
            q0, q1 = P(u + 0.09, ws[k], hs[k] + 0.06), P(u + 0.09, ws[k + 1], hs[k + 1] + 0.06)
            mesh.face("roof_light", [p0, q0, q1, p1])
    # rooftop plant on the flat margin beside the vault
    for su in (-0.75, -0.25, 0.25, 0.75):
        c = (centre[0] + eu[0] * su * hu + ev[0] * (hv - 1.6), centre[1] + eu[1] * su * hu + ev[1] * (hv - 1.6))
        mesh.box("mech", c, eu, 2.2, 1.0, y_r, y_r + 2.0, top_mat="roof_metal")
    # corner entrance pavilion where the statue stands: Comm Ave (south side) x Harry Agganis Way
    # (which runs up the arena's west side and round the back)
    south = min((eu, ev, (-eu[0], -eu[1]), (-ev[0], -ev[1])), key=lambda d: d[1])
    east = (-south[1], south[0]) if (-south[1]) > 0 else (south[1], -south[0])
    # the rounded south end faces Comm Ave: the glass pavilion stands proud of it, towards the
    # Harry Agganis Way corner
    tip = max(ring_o, key=lambda q: q[0] * south[0] + q[1] * south[1])
    pw, pd = 28.0, 12.0
    pc = (tip[0] - east[0] * 9.0 + south[0] * (4.0 - pd / 2), tip[1] - east[1] * 9.0 + south[1] * (4.0 - pd / 2))
    pav = [(pc[0] + sx * pw / 2 * east[0] + sy * pd / 2 * south[0], pc[1] + sx * pw / 2 * east[1] + sy * pd / 2 * south[1])
           for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    pav = oriented(pav)
    vb, vt = band_v(B_GLASS)
    lvb, lvt = band_v(B_LOBBY)
    ptop = y_eave + 3.0
    for i in range(4):
        a, bb = pav[i], pav[(i + 1) % 4]
        nb = float(max(1, round(dist(a, bb) / 3.0)))
        nrm = right_normal(a, bb)
        mesh.wall("glassfacade_0", a, bb, -0.2, 5.5, (0.0, nb, lvb, lvt))
        light_windows(ctx, v, B_LOBBY, a, bb, -0.2, 5.5, int(nb), nrm)
        for y0, y1 in ((5.5, 10.0), (10.0, 14.5), (14.5, ptop)):
            mesh.wall("glassfacade_0", a, bb, y0, y1, (0.0, nb, vb, vt))
            light_windows(ctx, v, B_GLASS, a, bb, y0, y1, int(nb), nrm)
    mesh.box("trim_metal", pc, east, pw / 2 + 0.6, pd / 2 + 0.6, ptop, ptop + 1.2, top_mat="roof_light")
    # canopy over the Comm Ave doors and the sign band above it
    cc = (pc[0] + south[0] * (pd / 2 + 2.0), pc[1] + south[1] * (pd / 2 + 2.0))
    mesh.box("trim_metal", cc, east, pw / 2 - 1.0, 2.0, 4.6, 5.0, top_mat="trim_metal", bottom=True)
    face_c = (pc[0] + south[0] * (pd / 2), pc[1] + south[1] * (pd / 2))
    band_c = (face_c[0] + south[0] * 0.3, face_c[1] + south[1] * 0.3)
    mesh.box("glass_dark", band_c, east, pw / 2 - 0.5, 0.25, 15.2, 18.0, top_mat="glass_dark")
    sign_text(mesh, ctx.lit, "AGGANIS ARENA",
              (band_c[0] + south[0] * 0.25, band_c[1] + south[1] * 0.25), east, south, 15.6, 2.0)
    # loading docks on Harry Agganis Way: the west wall, up towards the back, away from the corner
    east_edges = [e for e in info if e["n"][0] < -0.7 and e["L"] > 15]
    for e in east_edges[:1]:
        a, bb, L, nrm = e["a"], e["b"], e["L"], e["n"]
        eu2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
        for k in range(3):
            t = 0.62 + 0.11 * k if eu2[1] > 0 else 0.38 - 0.11 * k
            c = (a[0] + (bb[0] - a[0]) * t + nrm[0] * 0.06, a[1] + (bb[1] - a[1]) * t + nrm[1] * 0.06)
            mesh.box("glass_dark", c, eu2, 2.0, 0.05, -0.1, 4.2, top_mat="glass_dark")
            mesh.box("trim_metal", (c[0] + nrm[0] * 1.0, c[1] + nrm[1] * 1.0), eu2, 2.4, 1.0, 4.4, 4.7, top_mat="trim_metal", bottom=True)
    return max(hs) + 0.1


def landmark_modern(mesh, b, ctx, rng, vols, glass_ground=True):
    """Sert's Mugar Library and George Sherman Union: exposed concrete frame, deep-set windows,
    floor-edge slabs and precast sun-shading fins, glazed ground floor."""
    top = 0
    for v in vols:
        v.style = "concrete"
        v.bands = (B_SERT, B_LOBBY, 3.2)
        v.fascia = True
        v.fins = (3.2, 0.75, 0.28, "concrete_fin", None, None)
        v.parapet = 1.3
        v.lit_share = 0.45
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


def landmark_lawtower(mesh, b, ctx, rng, vols):
    """Sert's Law Tower (1964): exposed concrete with precast fins, red ventilation panels on the
    north and south faces and green ones on the east and west, and a stepped rooftop crown."""
    top = 0
    for v in vols:
        v.style = "concrete"
        v.facing_bands = (B_SERT_TOWER, B_SERT_TOWER_G)
        v.bands = (B_SERT, B_LOBBY, 2.8)
        v.fins = (2.8, 0.6, 0.24, "concrete_fin", None, None)
        v.parapet = 1.4
        v.mech = False
        t = build_volume(mesh, v, ctx, {b.ref}, rng)
        centre, eu, ev, hu, hv = obb(v.rings[0])
        y = v.top + ROOF_UP + 1.4
        mesh.box("trim_concrete", centre, eu, hu * 0.7, hv * 0.62, y - 1.4, y + 3.2, top_mat="roof_light")
        mesh.box("trim_concrete", (centre[0] + eu[0] * hu * 0.2, centre[1] + eu[1] * hu * 0.2), eu, hu * 0.36, hv * 0.4, y + 3.2, y + 6.0, top_mat="roof_light")
        # photos: a tall lattice antenna mast on the crown
        mc = (centre[0] + eu[0] * hu * 0.2, centre[1] + eu[1] * hu * 0.2)
        mesh.box("trim_metal", mc, eu, 0.35, 0.35, y + 6.0, y + 22.0, top_mat="trim_metal")
        for k in range(4):
            mesh.box("trim_metal", mc, eu, 1.2 - k * 0.25, 0.08, y + 8 + k * 3.5, y + 8.2 + k * 3.5)
        top = max(top, t, y + 22.0)
    return top


def landmark_cds(mesh, b, ctx, rng, vols):
    """CDS (KPMB, 2022): stacked, offset 'Jenga' volumes (OSM's building:part pieces) in patterned
    grey-blue glass with angled rust-coloured aluminium fins, glazed lobby podium, eight green
    terraces with glass railings, and a white rooftop pavilion."""
    top = 0
    for v in vols:
        v.style = "cds"
        v.bands = (B_CDS_FRIT, B_LOBBY, 3.0)
        v.party = False
        v.cornice = True
        v.parapet = 0.5
        v.rail = v.top < 85
        v.terrace = v.top < 85
        v.roof_mat = "roof_light"
        v.mech = False
        v.lit_share = 0.4
        if v.top > 4.6:
            v.fins = (3.0, 0.35, 0.12, "fin_rust", None, None)
        if v.top > 90:  # white mechanical crown
            v.style = "metal"
            v.bands = None
            v.fins = None
            v.levels = 2
            v.door = False
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


# 5 x 7 pixel letters for building signage, built as small boxes.
FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    " ": ["00000"] * 7,
}


def sign_text(mesh, lit_mesh, text, centre, eu, nrm, y0, height, mat="trim_white"):
    """Raised letters on a wall: centre is the wall point, eu runs along the wall, nrm faces out."""
    px = height / 7
    w = len(text) * 6 * px - px
    for ci, ch in enumerate(text):
        rows = FONT.get(ch, FONT[" "])
        for r, row in enumerate(rows):
            for col, bit in enumerate(row):
                if bit != "1":
                    continue
                u = -w / 2 + (ci * 6 + col + 0.5) * px
                c = (centre[0] + eu[0] * u + nrm[0] * 0.18, centre[1] + eu[1] * u + nrm[1] * 0.18)
                yb = y0 + (6 - r) * px
                mesh.box(mat, c, eu, px * 0.48, 0.1, yb, yb + px * 0.96, top_mat=mat)
                if lit_mesh is not None:
                    c2 = (c[0] + nrm[0] * 0.11, c[1] + nrm[1] * 0.11)
                    a = (c2[0] - eu[0] * px * 0.48, c2[1] - eu[1] * px * 0.48)
                    b = (c2[0] + eu[0] * px * 0.48, c2[1] + eu[1] * px * 0.48)
                    lit_mesh.wall("lit_neutral", a, b, yb, yb + px * 0.96, (15.0, 15.0, 24.5, 24.5))


def landmark_questrom(mesh, b, ctx, rng, vols):
    """Questrom School of Business, Rafik B. Hariri Building (Canon Associates, 1996), rebuilt from
    photos (Wikimedia Commons: "BU School of Management", "Boston University Graduate School of
    Management", Blandford Street station views). What they show:
    - a big flat-topped block of warm red brick that steps back in tiers: full footprint to about
      the 7th floor, a ~3 m setback for two more floors, then a top storey set back again, with a
      light-grey metal penthouse and a ridged glass skylight (over the six-storey atrium) on the roof;
    - rectangular windows in wide and narrow pairs, each under a white louvred sunshade panel,
      on cast-stone sills;
    - light cast-stone band courses where the tiers step, a tall cast-stone base with square piers
      and recessed glazing, and stone coping on every parapet;
    - a tall recessed glass slot (stone-framed curtain wall) in the middle of the Comm Ave front over
      the main entrance, and a second, narrower one towards the east end."""
    v0 = vols[0]
    raw = v0.rings[0]
    tiers = [(raw, 0.0, 26.0, 7)]
    r1 = offset_ring(raw, -3.0)
    if inset_ok(raw, r1):
        tiers.append((r1, 26.0, 33.0, 2))
        r2 = offset_ring(raw, -6.0)
        if inset_ok(raw, r2):
            tiers.append((r2, 33.0, 36.5, 1))
    top = 0
    tier_vols = []
    for k, (ring, base, height, levels) in enumerate(tiers):
        v = Volume(v0.key if k == 0 else f"{v0.key}#t{k}", [ring], base, height, levels, "brick")
        v.tags = v0.tags
        v.bands = (B_QUESTROM, B_QUESTROM_BASE, 4.2)
        v.tint = "facade_0"
        v.door = False
        v.mech = False
        v.cornice = True
        v.parapet = 0.9
        v.party = False
        v.use = "office"
        v.library_floors = (1, 2) if k == 0 else ()
        if k:
            v.ground = False
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
        tier_vols.append(v)
    v = tier_vols[0]
    ring_o = offset_ring(raw, wall_out(v.top))
    centre, eu, ev, hu, hv = obb(ring_o)
    ys = storey_lines(v, -0.2, v.top + roof_up(v.top))
    # cast-stone band course over the base, and one under the first setback
    n = len(ring_o)
    for i in range(n):
        a, bb = ring_o[i], ring_o[(i + 1) % n]
        if dist(a, bb) < 1:
            continue
        nrm = right_normal(a, bb)
        a2 = (a[0] + nrm[0] * 0.25, a[1] + nrm[1] * 0.25)
        b2 = (bb[0] + nrm[0] * 0.25, bb[1] + nrm[1] * 0.25)
        for y, hgt in ((ys[1], 1.1), (ys[-2], 0.7)):
            mesh.wall("stone_cream", a2, b2, y - hgt, y)
            mesh.face("stone_cream", [(a2[0], y, -a2[1]), (b2[0], y, -b2[1]), (bb[0], y, -bb[1]), (a[0], y, -a[1])])
            mesh.face("stone_cream", [(a[0], y - hgt, -a[1]), (bb[0], y - hgt, -bb[1]), (b2[0], y - hgt, -b2[1]), (a2[0], y - hgt, -a2[1])])
    south = min((eu, ev, (-eu[0], -eu[1]), (-ev[0], -ev[1])), key=lambda d: d[1])
    east = (-south[1], south[0]) if -south[1] > 0 else (south[1], -south[0])
    face = max(ring_o, key=lambda q: q[0] * south[0] + q[1] * south[1])
    fd = face[0] * south[0] + face[1] * south[1] - (centre[0] * south[0] + centre[1] * south[1])
    # tall glass slots in stone frames on the Comm Ave front
    gvb, gvt = band_v(B_GLASS)
    for along, w in ((0.0, 9.0), (0.62 * hu, 4.5)):
        c = (centre[0] + east[0] * along + south[0] * (fd + 0.35), centre[1] + east[1] * along + south[1] * (fd + 0.35))
        y0, y1 = ys[1] + 0.2, ys[-2] - 0.8
        mesh.box("stone_cream", (c[0] - east[0] * (w / 2 + 0.5), c[1] - east[1] * (w / 2 + 0.5)), east, 0.5, 0.4, ys[1], ys[-2], top_mat="stone_cream")
        mesh.box("stone_cream", (c[0] + east[0] * (w / 2 + 0.5), c[1] + east[1] * (w / 2 + 0.5)), east, 0.5, 0.4, ys[1], ys[-2], top_mat="stone_cream")
        ga = (c[0] - east[0] * w / 2, c[1] - east[1] * w / 2)
        gb = (c[0] + east[0] * w / 2, c[1] + east[1] * w / 2)
        nb = max(1, round(w / 3.0))
        storeys = max(1, round((y1 - y0) / 3.6))
        for k in range(storeys):
            ya = y0 + (y1 - y0) * k / storeys
            yb = y0 + (y1 - y0) * (k + 1) / storeys
            mesh.wall("glassfacade_0", ga, gb, ya, yb, (0.0, float(nb), gvb, gvt))
            light_windows(ctx, v, B_GLASS, ga, gb, ya, yb, nb, south, out=0.06, floor=k + 1)
    # two tall projecting brick bays on the Comm Ave front, rising to the first setback (photo)
    qvb, qvt = band_v(B_QUESTROM)
    for along in (-0.45 * hu, 0.36 * hu):
        c = (centre[0] + east[0] * along + south[0] * (fd + 0.9), centre[1] + east[1] * along + south[1] * (fd + 0.9))
        bay_ring = oriented([(c[0] + sx * 4.5 * east[0] + sy * 1.2 * south[0], c[1] + sx * 4.5 * east[1] + sy * 1.2 * south[1])
                             for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        for i in range(4):
            a, bb = bay_ring[i], bay_ring[(i + 1) % 4]
            for k in range(1, len(ys) - 1):
                mesh.wall("facade_0", a, bb, ys[k], ys[k + 1], (0.0, max(1.0, round(dist(a, bb) / 4.2)), qvb, qvt))
            mesh.wall("stone_cream", a, bb, -0.2, ys[1])
        mesh.prism("stone_cream", offset_ring(bay_ring, 0.25), ys[-1], ys[-1] + 0.9, top_mat="stone_cream")
    # main entrance: recessed under the centre slot, with a stone portal
    pc = (centre[0] + south[0] * (fd + 0.6), centre[1] + south[1] * (fd + 0.6))
    mesh.box("stone_cream", pc, east, 6.0, 0.6, ys[1] - 1.1, ys[1] + 0.3, top_mat="stone_cream")
    # roof: metal penthouse to the west, ridged glass skylight over the atrium in the middle
    t2 = tier_vols[-1]
    y_r = t2.top + roof_up(t2.top)
    # photos: a long, prominent light-grey ribbed metal penthouse runs along the top
    pc_ = (centre[0] - east[0] * hu * 0.12, centre[1] - east[1] * hu * 0.12)
    pen = oriented([(pc_[0] + sx * hu * 0.62 * east[0] + sy * hv * 0.30 * south[0], pc_[1] + sx * hu * 0.62 * east[1] + sy * hv * 0.30 * south[1])
                    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    mesh.prism("penthouse", pen, y_r, y_r + 4.6, top_mat="roof_light")
    for i in range(4):  # standing ribs
        a, bb = pen[i], pen[(i + 1) % 4]
        L = dist(a, bb)
        e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
        nrm = right_normal(a, bb)
        for k in range(1, int(L // 2.4)):
            c = (a[0] + e2[0] * k * 2.4 + nrm[0] * 0.08, a[1] + e2[1] * k * 2.4 + nrm[1] * 0.08)
            mesh.box("roof_metal", c, e2, 0.08, 0.08, y_r, y_r + 4.6)
    sw, sd, rise = 7.0, 4.5, 2.4
    sk = (centre[0] + east[0] * hu * 0.72, centre[1] + east[1] * hu * 0.72)
    lo = oriented([(sk[0] + sx * sw * east[0] + sy * sd * south[0], sk[1] + sx * sw * east[1] + sy * sd * south[1])
                   for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    mesh.prism("trim_metal", lo, y_r, y_r + 0.8)

    def P(u, w, y):
        return (sk[0] + east[0] * u + south[0] * w, y, -(sk[1] + east[1] * u + south[1] * w))
    y0 = y_r + 0.8
    # three parallel glass ridges (photos show a ridged glazed roof)
    for r in range(3):
        w0 = -sd + 2 * sd * r / 3
        w1 = w0 + 2 * sd / 3
        wm = (w0 + w1) / 2
        for (wa, wb) in ((w0, wm), (wm, w1)):
            ha = y0 + (rise if wa == wm else 0)
            hb = y0 + (rise if wb == wm else 0)
            q = [P(-sw, wa, ha), P(sw, wa, ha), P(sw, wb, hb), P(-sw, wb, hb)]
            mesh.face("glass_rail", q)
            mesh.face("glass_rail", q[::-1])
            if ctx.lit is not None:
                pr = ctx.lit.prim("lit_soft")
                base_i = pr.n
                for qq in q:
                    pr.pos.extend((qq[0], qq[1] - 0.05, qq[2]))
                    pr.nrm.extend((0.0, 1.0, 0.0))
                    pr.uv.extend((15.5, 23.5))
                pr.idx.extend((base_i, base_i + 1, base_i + 2, base_i, base_i + 2, base_i + 3, base_i, base_i + 2, base_i + 1, base_i, base_i + 3, base_i + 2))
                pr.n += 4
        for end in (-1, 1):
            tri = [P(end * sw, w0, y0), P(end * sw, w1, y0), P(end * sw, wm, y0 + rise)]
            mesh.face("glass_rail", tri)
            mesh.face("glass_rail", tri[::-1])
    return max(top, y_r + 4.6, y0 + rise)


def _gable(mesh, a, b, nrm, y_eave, rise, depth, wall_mat, roof_mat, trim_mat, finial=True):
    """A cross gable on wall a->b: triangular stone gable face with a coped edge and finial, and a
    small pitched roof running back into the main roof."""
    L = dist(a, b)
    e2 = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
    m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    apex = (m[0], y_eave + rise, -m[1])
    mesh.face(wall_mat, [(a[0], y_eave, -a[1]), (b[0], y_eave, -b[1]), apex])
    back = (-nrm[0] * depth, -nrm[1] * depth)
    a2 = (a[0] + back[0], a[1] + back[1])
    b2 = (b[0] + back[0], b[1] + back[1])
    m2 = (m[0] + back[0], m[1] + back[1])
    ov = 0.35  # eaves overhang
    ao = (a[0] - e2[0] * ov + nrm[0] * ov, a[1] - e2[1] * ov + nrm[1] * ov)
    bo = (b[0] + e2[0] * ov + nrm[0] * ov, b[1] + e2[1] * ov + nrm[1] * ov)
    mo = (m[0] + nrm[0] * ov, m[1] + nrm[1] * ov)
    yl = y_eave - ov * rise / (L / 2)
    for (p, q, pb, qb) in (((ao, mo, a2, m2)), ((mo, bo, m2, b2))):
        yp = yl if p is ao else y_eave + rise
        yq = y_eave + rise if q is mo else yl
        quad = [(p[0], yp, -p[1]), (q[0], yq, -q[1]), (qb[0], yq if q is mo else y_eave, -qb[1]), (pb[0], yp if p is mo else y_eave, -pb[1])]
        mesh.face(roof_mat, quad[::-1])
        mesh.face(roof_mat, quad)
    # coping along the gable edges and a stone finial on the apex
    for p, q in ((a, m), (m, b)):
        yp = y_eave if p is a else y_eave + rise
        yq = y_eave + rise if q is m else y_eave
        pp = (p[0] + nrm[0] * 0.15, p[1] + nrm[1] * 0.15)
        qq = (q[0] + nrm[0] * 0.15, q[1] + nrm[1] * 0.15)
        mesh.face(trim_mat, [(pp[0], yp, -pp[1]), (qq[0], yq, -qq[1]), (qq[0], yq + 0.35, -qq[1]), (pp[0], yp + 0.35, -pp[1])])
    if finial:
        sq = [(m[0] + sx * 0.3, m[1] + sy * 0.3) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        mesh.prism(trim_mat, sq, y_eave + rise, y_eave + rise + 0.9)
        mesh.pyramid(trim_mat, sq, y_eave + rise + 0.9, y_eave + rise + 1.7)
    return y_eave + rise + 1.7


def landmark_castle(mesh, b, ctx, rng, vols):
    """The Castle, Dahod Family Alumni Center (Chapman & Frazer, c. 1915; 225 Bay State Rd), rebuilt
    from Wikimedia Commons photos: a Tudor Revival mansion of buff Amherst sandstone, three storeys
    under steep grey-slate roofs with copper-green flashing; several steep cross gables with coped
    edges and stone finials; a square battlemented entrance tower with a Gothic arched doorway; three-
    light mullioned and transomed leaded windows with hood moulds; tall stone chimney stacks (and one
    red-brick stack at the back); and a raised terrace with a stone balustrade along the street.
    Warm light glows through the leaded windows in the evening."""
    v = vols[0]
    v.style = "gothic"
    v.top = 11.0
    v.levels = 3
    v.bands = (B_TUDOR, B_TUDOR, 4.8)
    v.tint = "facade_0"
    v.use = "venue"
    v.party = False
    v.door = False
    v.ground = True
    rings_o = [offset_ring(r, wall_out(v.top)) for r in v.rings]
    y_eave = v.top + roof_up(v.top)
    info, ys = build_walls(mesh, v, ctx, rings_o, -0.2, y_eave, {b.ref})
    ring_o = rings_o[0]
    centre, eu, ev, hu, hv = obb(ring_o)
    # stone string courses between storeys and a moulded eaves course
    n = len(ring_o)
    for i in range(n):
        a, bb = ring_o[i], ring_o[(i + 1) % n]
        if dist(a, bb) < 0.5:
            continue
        nrm = right_normal(a, bb)
        a2 = (a[0] + nrm[0] * 0.18, a[1] + nrm[1] * 0.18)
        b2 = (bb[0] + nrm[0] * 0.18, bb[1] + nrm[1] * 0.18)
        for y, hgt in ((ys[1], 0.3), (ys[2], 0.3), (y_eave, 0.5)):
            mesh.wall("sand_trim", a2, b2, y - hgt, y)
            mesh.face("sand_trim", [(a2[0], y, -a2[1]), (b2[0], y, -b2[1]), (bb[0], y, -bb[1]), (a[0], y, -a[1])])
    # steep slate roof (hipped, ridge along the longer axis) with a copper ridge
    v.roof_mat = "slate_grey"
    ridge = pitched_top(mesh, v, ring_o, y_eave, "hipped", rise=7.0)
    long_ax, half = (eu, hu) if hu >= hv else (ev, hv)
    for sgn in (-1, 1):
        pass
    mesh.box("copper_green", centre, long_ax, max(0.5, half - (min(hu, hv))), 0.22, ridge - 0.15, ridge + 0.12, top_mat="copper_green")
    top = ridge + 0.12
    # cross gables on every long-enough outer wall facing a street or the river (photos: 2-3 per side)
    fronts = street_edges(v, info, ctx, v.tags)
    front = fronts[0] if fronts else max(info, key=lambda e: e["L"])
    for e in sorted([e for e in info if e["outer"] and e["L"] > 5.5], key=lambda e: -e["L"])[:5]:
        L = e["L"]
        w = min(L * 0.6, 10.0)
        e2 = ((e["b"][0] - e["a"][0]) / L, (e["b"][1] - e["a"][1]) / L)
        t = 0.3 if e is front else 0.5
        c = (e["a"][0] + e2[0] * L * t, e["a"][1] + e2[1] * L * t)
        ga = (c[0] - e2[0] * w / 2 + e["n"][0] * 0.05, c[1] - e2[1] * w / 2 + e["n"][1] * 0.05)
        gb = (c[0] + e2[0] * w / 2 + e["n"][0] * 0.05, c[1] + e2[1] * w / 2 + e["n"][1] * 0.05)
        top = max(top, _gable(mesh, ga, gb, e["n"], y_eave, w * 1.0, 6.5, "sandstone", "slate_grey", "sand_trim"))
        # attic window in the gable
        wa = (c[0] - e2[0] * 1.0 + e["n"][0] * 0.1, c[1] - e2[1] * 1.0 + e["n"][1] * 0.1)
        wb = (c[0] + e2[0] * 1.0 + e["n"][0] * 0.1, c[1] + e2[1] * 1.0 + e["n"][1] * 0.1)
        tvb, tvt = band_v(B_TUDOR)
        mesh.wall("facade_0", wa, wb, y_eave + 0.5, y_eave + 2.6, (0.0, 1.0, tvb, tvt))
        light_windows(ctx, v, B_TUDOR, wa, wb, y_eave + 0.5, y_eave + 2.6, 1, e["n"], out=0.06, floor=3)
    # battlemented entrance tower on the street front, Gothic arched doorway
    a, bb, nrm = front["a"], front["b"], front["n"]
    L = front["L"]
    e2 = ((bb[0] - a[0]) / L, (bb[1] - a[1]) / L)
    tc = (a[0] + e2[0] * L * 0.72 + nrm[0] * 1.2, a[1] + e2[1] * L * 0.72 + nrm[1] * 1.2)
    ts = 3.4
    tring = oriented([(tc[0] + sx * ts * e2[0] + sy * ts * nrm[0], tc[1] + sx * ts * e2[1] + sy * ts * nrm[1])
                      for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    ty = y_eave + 2.5
    tvb, tvt = band_v(B_TUDOR)
    for i in range(4):
        p0, p1 = tring[i], tring[(i + 1) % 4]
        for k in range(3):
            mesh.wall("facade_0", p0, p1, ys[k] if k else -0.2, ys[k + 1] if k < 2 else ty, (0.0, 1.0, tvb, tvt))
    mesh.flat("roof_dark", [tring], ty, True)
    rc = offset_ring(tring, 0.25)
    for i in range(4):
        p0, p1 = rc[i], rc[(i + 1) % 4]
        mesh.wall("sand_trim", p0, p1, ty - 0.4, ty + 0.5)
        Lq = dist(p0, p1)
        eq = ((p1[0] - p0[0]) / Lq, (p1[1] - p0[1]) / Lq)
        nq = right_normal(p0, p1)
        for m in range(4):
            c = (p0[0] + eq[0] * Lq * (m + 0.5) / 4 - nq[0] * 0.2, p0[1] + eq[1] * Lq * (m + 0.5) / 4 - nq[1] * 0.2)
            mesh.box("sand_trim", c, eq, 0.45, 0.2, ty + 0.5, ty + 1.3)
    top = max(top, ty + 1.3)
    door_c = (tc[0] + nrm[0] * (ts + 0.08), tc[1] + nrm[1] * (ts + 0.08))
    mesh.box("sand_trim", door_c, e2, 1.3, 0.12, -0.2, 3.6, top_mat="sand_trim")
    mesh.box("door", (door_c[0] + nrm[0] * 0.1, door_c[1] + nrm[1] * 0.1), e2, 0.8, 0.06, 0.0, 2.9, top_mat="door")
    sq = [(door_c[0] + nrm[0] * 0.18 + e2[0] * dx, door_c[1] + nrm[1] * 0.18 + e2[1] * dx) for dx in (-0.8, 0.8)]
    mesh.face("door", [(sq[0][0], 2.9, -sq[0][1]), (sq[1][0], 2.9, -sq[1][1]), ((sq[0][0] + sq[1][0]) / 2, 3.5, -(sq[0][1] + sq[1][1]) / 2)])
    # chimney stacks: tall stone stacks with pots, one red-brick stack at the back
    stacks = [(0.55, 0.6, "sandstone"), (-0.5, 0.3, "sandstone"), (0.1, -0.7, "chimney_brick")]
    for su, sv, mat in stacks:
        c = (centre[0] + eu[0] * su * hu + ev[0] * sv * hv, centre[1] + eu[1] * su * hu + ev[1] * sv * hv)
        mesh.box(mat, c, eu, 0.9, 0.55, y_eave, ridge + 2.6, top_mat="sand_trim")
        mesh.box("sand_trim", c, eu, 1.05, 0.7, ridge + 2.0, ridge + 2.3, top_mat="sand_trim")
        for k in (-0.45, 0.0, 0.45):
            mesh.box("chimney_brick", (c[0] + eu[0] * k, c[1] + eu[1] * k), eu, 0.13, 0.13, ridge + 2.6, ridge + 3.3)
        top = max(top, ridge + 3.3)
    # raised terrace with a stone balustrade along the street front
    ta = (a[0] + nrm[0] * 0.3, a[1] + nrm[1] * 0.3)
    tb = (bb[0] + nrm[0] * 0.3, bb[1] + nrm[1] * 0.3)
    depth = 4.5
    terr = oriented([ta, tb, (tb[0] + nrm[0] * depth, tb[1] + nrm[1] * depth), (ta[0] + nrm[0] * depth, ta[1] + nrm[1] * depth)])
    mesh.prism("sandstone", terr, -0.2, 1.5, top_mat="roof_gravel")
    ea, eb = (ta[0] + nrm[0] * depth, ta[1] + nrm[1] * depth), (tb[0] + nrm[0] * depth, tb[1] + nrm[1] * depth)
    mesh.wall("sand_trim", ea, eb, 1.5, 1.65)
    k = int(L / 0.35)
    for m in range(k + 1):
        c = (ea[0] + (eb[0] - ea[0]) * m / k - nrm[0] * 0.1, ea[1] + (eb[1] - ea[1]) * m / k - nrm[1] * 0.1)
        mesh.box("sand_trim", c, e2, 0.07, 0.07, 1.65, 2.35)
    mesh.box("sand_trim", ((ea[0] + eb[0]) / 2 - nrm[0] * 0.1, (ea[1] + eb[1]) / 2 - nrm[1] * 0.1), e2, L / 2, 0.16, 2.35, 2.5, top_mat="sand_trim")
    for p_ in (ea, eb):
        mesh.box("sandstone", (p_[0] - nrm[0] * 0.1, p_[1] - nrm[1] * 0.1), e2, 0.3, 0.3, 1.5, 2.8, top_mat="sand_trim")
    return top


def landmark_garage(mesh, b, ctx, rng, vols):
    """Langsam Garage (278 Babcock St): one level, partly below grade, with New Balance Field on its
    roof deck (~3.5 m up) behind a ~0.9 m parapet. The deck is left plain for the field layer."""
    top = 0
    for v in vols:
        v.top = 3.5 - ROOF_UP
        v.levels = 1
        v.style = "concrete"
        v.bands = (B_GARAGE, B_GARAGE, 6.0)
        v.door = False
        v.mech = False
        v.cornice = False
        v.parapet = 0.9
        v.use = "none"
        v.roof_mat = "roof_gravel"
        top = max(top, build_volume(mesh, v, ctx, {b.ref}, rng))
    return top


LANDMARK_FN = {"castle": landmark_castle, "theology": landmark_theology, "questrom": landmark_questrom, "garage": landmark_garage, "chapel": landmark_chapel, "cas": landmark_cas, "warren": landmark_warren, "stuvi": landmark_stuvi,
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
                top = floors.get(key, ph)
                levels = plv if pmh < 0.5 else max(1, round((ph - pmh) / METRES_PER_LEVEL))
                vols.append(Volume(key, rings, pmh, top, levels, None, tags.get("roof:shape", "flat"), party=False))
    if not vols:
        for k, (o, inn) in enumerate(b.rings_ll):
            rings = local_rings(frame, o, inn)
            if not rings:
                continue
            top = floors.get(f"{b.ref}#{k}", floors.get(b.ref, h))
            vols.append(Volume(b.ref if k == 0 else f"{b.ref}#{k}", rings, mh, top, lv, None, roof_shape))
    for v in vols:
        v.tags = b.tags
        # Re-derive storeys when Mapbox's height overrides OSM's.
        per = (v.top - v.base) / max(1, v.levels)
        if per > 5.2 or per < 2.6:
            v.levels = max(1, round((v.top - v.base) / METRES_PER_LEVEL))
    return vols


# Per-building treatments from reference photos and descriptions (see the report for sources).
SPECIAL = {
    # Central Campus limestone block (Cram & Ferguson): tall vertical bays of casements
    "way/1007090933": dict(bands=(B_LIME_STRIP, B_LIME_GROUND, 2.6), top_band=B_LIME),
    "way/1007090940": dict(bands=(B_LIME_STRIP, B_LIME_GROUND, 2.6), top_band=B_LIME),
    "way/1007090941": dict(bands=(B_LIME_STRIP, B_LIME_GROUND, 2.6), top_band=B_LIME),
    "way/485223500": dict(style="limestone", bands=(B_LIME_STRIP, B_LOBBY, 2.8)),          # Redstone Building
    "way/29557600": dict(style="brick", bands=(B_HOTEL, B_HOTEL_BASE, 3.4), lit=0.5),       # Myles Standish
    "way/29863053": dict(style="brick", bands=(B_HOTEL, B_HOTEL_BASE, 3.4), tint="facade_faded", lit=0.5),  # Kilachand
    "way/29581513": dict(style="brick", bands=(B_PHOTONICS, B_BRICK_GROUND, 3.0)),         # Photonics
    "way/102385045": dict(style="brick", bands=(B_BRICK, B_LOBBY, 3.2), top_band=B_GLASS),  # FitRec
    "way/697017104": dict(style="glass", fins=(1.3, 0.7, 0.35, "fin_sand", None, None)),   # LSEB
    "way/697017102": dict(style="glass", fins=(1.3, 0.7, 0.35, "fin_sand", None, None)),
    "way/697017103": dict(style="glass", fins=(1.3, 0.7, 0.35, "fin_sand", None, None)),
    "way/337489367": dict(style="glass", fins=(1.3, 0.7, 0.35, "fin_sand", None, None)),   # CILSE
    "way/825285416": dict(style="glass", fins=(3.0, 0.6, 0.6, "concrete_fin", None, None)),  # Booth Theatre
    "way/29680728": dict(style="limestone", bands=(B_TERRACOTTA, B_HOTEL_BASE, 3.6)),     # College of Fine Arts
    "way/212128584": dict(style="glass", bands=(B_BLUEGLASS, B_LOBBY, 3.0)),               # 150 Riverway
    "way/212124942": dict(style="limestone", bands=(B_LIME_STRIP, B_LIME_GROUND, 3.0), tint="facade_grey"),  # NEIDL
    "way/1160558564": dict(style="concrete"),                                               # Instructional Bldg
}


LIBRARIES = {"way/130209089", "way/29513254"}  # Mugar (open late), Wheelock library
HOUSING = {"dormitory", "apartments", "residential", "house", "hotel", "detached"}


def use_class(b, style, area, v):
    btype = b.tags.get("building", "")
    if b.ref in LIBRARIES or b.tags.get("amenity") == "library":
        return "library"
    if LANDMARKS.get(b.ref) == "arena":
        return "arena"
    if btype in ("church",) or b.tags.get("amenity") == "place_of_worship":
        return "church"
    if btype in ("parking", "roof", "bridge") or b.tags.get("amenity") == "parking":
        return "none"
    if style in ("brownstone", "rowbrick", "rowlime") or (btype in HOUSING and is_rowhouse(b, area, v.levels)):
        return "cosy" if btype not in ("dormitory",) else "dorm"
    if btype in HOUSING or LANDMARKS.get(b.ref) in ("warren", "stuvi"):
        return "dorm"
    if btype in ("retail", "commercial"):
        return "retail"
    if b.campus == "medical":
        return "medical"
    if style in ("glass", "cds"):
        return "glass"
    return "office"


def configure(b, v, area):
    style = style_for(b, area, v.levels)
    v.style = style
    btype = b.tags.get("building", "")
    v.lit_share = {"dormitory": 0.45, "apartments": 0.4, "residential": 0.4, "house": 0.35, "retail": 0.7,
                   "commercial": 0.6, "hotel": 0.45}.get(btype, 0.3)
    if b.campus == "medical" and style == "brick":
        v.bands = (B_MED_BRICK, B_BRICK_GROUND, 3.2)
    v.use = use_class(b, style, area, v)
    sp = SPECIAL.get(b.ref)
    if sp:
        if "style" in sp:
            v.style = style = sp["style"]
        v.bands = sp.get("bands", v.bands)
        v.tint = sp.get("tint")
        v.top_band = sp.get("top_band")
        v.fins = sp.get("fins")
        v.lit_share = sp.get("lit", v.lit_share)
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
# glTF writer
# ------------------------------------------------------------------------------------------------

def write_glb(path, mesh, png=None, materials=None, normals=True):
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

    used = [m for m in (materials or MATERIALS) if m["name"] in mesh.prims and mesh.prims[m["name"]].n]
    mat_ids = {m["name"]: i for i, m in enumerate(used)}
    gl_materials = []
    for m in used:
        pbr = {"baseColorFactor": [round(srgb_to_linear(c), 5) for c in m["color"]] + [1.0],
               "metallicFactor": m["metal"], "roughnessFactor": m["rough"]}
        if m["texture"]:
            pbr["baseColorTexture"] = {"index": 0}
        gm = {"name": m["name"], "pbrMetallicRoughness": pbr}
        if m.get("emissive"):
            gm["emissiveFactor"] = [round(srgb_to_linear(c), 5) for c in m["emissive"]]
        gl_materials.append(gm)

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
            attrs = {"POSITION": accessor(view(pos.tobytes(), 34962), 5126, count, "VEC3", mn, mx)}
            if normals:
                attrs["NORMAL"] = accessor(view(nrm.tobytes(), 34962), 5126, count, "VEC3")
            if uv is not None:
                attrs["TEXCOORD_0"] = accessor(view(uv.tobytes(), 34962), 5126, count, "VEC2")
            ind = accessor(view(idx.tobytes(), 34963), 5123, len(idx), "SCALAR")
            primitives.append({"attributes": attrs, "indices": ind, "material": mat_ids[m["name"]], "mode": 4})

    textured = any(m["texture"] for m in used)
    img_view = view(png) if textured else None
    gltf = {
        "asset": {"version": "2.0", "generator": "Flowcast make_building_models.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.stem}],
        "meshes": [{"name": path.stem, "primitives": primitives}],
        "materials": gl_materials,
        "accessors": accessors,
        "bufferViews": views,
    }
    if textured:
        gltf["textures"] = [{"sampler": 0, "source": 0}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        gltf["images"] = [{"bufferView": img_view, "mimeType": "image/png"}]
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

    # Heights come from OSM tags and the reference research (HEIGHT_OVERRIDES), not from Mapbox:
    # the app hides Mapbox's own copies of these buildings (basemap.excludeBuildings).
    floors = HEIGHT_OVERRIDES

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
        for el in (medical if cid == "medical" else charles):
            if "building" in el.get("tags", {}):
                ctx.heights[f"{el['type']}/{el['id']}"] = tag_height(el["tags"])[0]
        ctx.lit = Mesh()
        ctx.floor_plans = {}
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
            if kind == "garage":
                entries[-1]["deck"] = 3.5  # roof deck under New Balance Field; "height" includes the parapet
            # Pieces Mapbox's vector tiles carry as separate features: building:part ways and a
            # relation's member ways. Listed so the app's city layer leaves them out too.
            extra = [f"{p['type']}/{p['id']}" for p in b.parts]
            extra += [f"way/{m['ref']}" for m in b.el.get("members", []) if m.get("type") == "way"]
            for ref in dict.fromkeys(extra):
                if ref != b.ref:
                    entries.append({"osm": ref, "name": None, "center": [round(c[0], 6), round(c[1], 6)],
                                    "height": round(top, 1), "partOf": b.ref})
        out = MODELS_DIR / f"buildings-{cid}.glb"
        size = write_glb(out, mesh, png)
        for old in MODELS_DIR.glob(f"buildings-{cid}-lights-*.glb"):
            old.unlink()
        lp = MODELS_DIR / f"buildings-{cid}-lights.glb"
        size += write_glb(lp, ctx.lit, None, LIT_MATERIALS, normals=False)
        lights = {"scheduled": f"/models/{lp.name}"}
        total += size
        manifest["campuses"].append({
            "id": cid, "name": campus["name"], "origin": [campus["origin"][0], campus["origin"][1]],
            "model": f"/models/{out.name}", "lights": lights, "buildings": entries,
        })
        nlit = ctx.lit.vert_count() // 4
        print(f"  {campus['name']}: {sum(1 for e in entries if 'partOf' not in e)} buildings ({len(entries)} OSM ids), {mesh.vert_count():,} vertices, {nlit:,} lit windows, {size / 1e6:.2f} MB")
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"Total {total / 1e6:.2f} MB. Manifest -> {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
