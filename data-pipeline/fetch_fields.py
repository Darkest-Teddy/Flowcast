"""Lay out BU's two West Campus athletic fields, New Balance Field and Nickerson Field, for the
map client: turf, track, line markings, and where every 3D prop stands.

Geometry comes from OpenStreetMap (Overpass, cached in data-pipeline/.cache/overpass):
    New Balance Field   way/1026274041  leisure=pitch, artificial_turf, 278 Babcock St, layer=1
                        (it is the roof deck of the Langsam Garage, way/1026274040)
    Nickerson Field     way/663514809   leisure=stadium (outline)
                        way/619598469   leisure=pitch, soccer;lacrosse, artificial_turf
                        relation/8592949 leisure=track (outer + inner ring, 4 lanes)
                        way/29680684    building=grandstand (the 1915 Braves Field right-field pavilion)

What OSM doesn't map (light poles, scoreboards, the bleachers, the field-hockey inset, the press
box) was measured on Mapbox's satellite imagery (Static Images API, 1000x1000 px, 512-px tiles):
each `PIXEL_MEASUREMENTS` entry is a pixel in an image at a stated centre and zoom, converted back
to lng/lat here. The OSM outlines line up with that imagery to within ~1 m, so the two agree.
Facts and photo references are in the `sources` block written to fields.json.

Every field has a local frame: `anchor` [lng, lat] and `bearing` (compass bearing of its long
axis). Inside it, u = metres along the long axis and v = metres to the left of it; the props GLB
(map-client/scripts/make_field_models.py) is built in the same frame, model +Z = u, +X = v.

Writes map-client/public/data/fields.json. Standard library only:
    python3 data-pipeline/fetch_fields.py
"""

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from fetch_street import overpass  # noqa: E402  (shared cache, User-Agent, retries)


# Local metres on the WGS84 ellipsoid (so a 91.4 m pitch really is 91.4 m long).
def _m_per_deg(lat):
    p = math.radians(lat)
    return (111_412.84 * math.cos(p) - 93.5 * math.cos(3 * p),
            111_132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p))


def to_xy(lng, lat, ref):
    kx, ky = _m_per_deg(ref[1])
    return ((lng - ref[0]) * kx, (lat - ref[1]) * ky)


def to_lnglat(x, y, ref):
    kx, ky = _m_per_deg(ref[1])
    return (ref[0] + x / kx, ref[1] + y / ky)

OUT = HERE.parent / "map-client" / "public" / "data" / "fields.json"

NBF_PITCH, NBF_GARAGE = 1026274041, 1026274040
NICK_STADIUM, NICK_PITCH, NICK_STAND, NICK_TRACK = 663514809, 619598469, 29680684, 8592949

# The garage is one parking level, partly below grade ("a deck above parking", BU Campus Planning;
# "1 level, 322-car parking", PCI): from the photos the deck is about one storey above the
# surrounding streets. The map is flat (no terrain), so this is metres above the map's ground.
NBF_DECK_ALTITUDE = 3.5

# Pixels picked on Mapbox satellite-v9 static images: (centre lng, lat, zoom, px x, px y).
PIXEL_MEASUREMENTS = {
    # New Balance Field: the blue-green field-hockey inset's corners (NW, SW, SE, NE).
    "nbf_inset": [(-71.12186, 42.35353, 18.6, x, y) for x, y in ((262, 278), (200, 650), (820, 748), (878, 378))],
    "nbf_bleachers": (-71.12186, 42.35353, 18.6, 495, 770),       # aluminium bleachers, south side
    "nbf_scoreboard": (-71.1214, 42.35345, 19.6, 800, 28),        # NE corner, behind the east goal
    "nick_scoreboard": (-71.1186, 42.3538, 19.3, 778, 432),       # video board, NE end zone
    "nick_light_se1": (-71.1189, 42.3529, 19.3, 310, 856),        # poles behind the grandstand
    "nick_light_se2": (-71.1189, 42.3529, 19.3, 868, 562),
    "nick_light_nw1": (-71.1198, 42.3535, 19.3, 405, 195),        # pole across the field (west)
    "nick_press_box": (-71.1189, 42.3529, 19.3, 600, 735),        # press box roof, top of the stand
    "nick_red_seats": (-71.1189, 42.3529, 19.3, 470, 615),        # block of red seats, upper tier
    "nick_chairs_sw": (-71.1189, 42.3529, 19.3, 200, 510),        # ends of the chair-back section,
    "nick_chairs_ne": (-71.1189, 42.3529, 19.3, 755, 290),        # lower tier
    "nick_bench_w": (-71.1198, 42.3535, 19.3, 657, 240),          # team benches, NW sideline
    "nick_bench_e": (-71.1198, 42.3535, 19.3, 945, 90),
}

# Regulation dimensions (metres).
HOCKEY = {"length": 91.40, "width": 55.00, "quarter": 22.90, "circle": 14.63, "goal": 3.66, "spot": 6.475}
SOCCER = {"circle": 9.15, "box_d": 16.5, "box_w": 40.32, "six_d": 5.5, "six_w": 18.32, "spot": 11.0, "goal": 7.32}
LANE = 1.22

# Colours (sRGB), matched to the satellite imagery and the photos listed in `sources`.
COLOURS = {
    "hockey_turf": [26, 136, 116],    # NBF's blue-green field-hockey inset
    "runoff_turf": [60, 98, 54],      # NBF's dark green surround
    "infield_turf": [66, 116, 52],    # Nickerson's green (GreenFields MX, 2015)
    "infield_stripe": [58, 106, 47],
    "track": [182, 86, 62],           # terracotta polyurethane track
    "line": [246, 246, 240],
}


# --------------------------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------------------------

def mercator_px(lng, lat, z):
    s = 512 * 2 ** z
    return (lng / 360 + 0.5) * s, (0.5 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / (2 * math.pi)) * s


def pixel_to_lnglat(clng, clat, z, px, py, size=1000):
    cx, cy = mercator_px(clng, clat, z)
    s = 512 * 2 ** z
    x, y = cx + px - size / 2, cy + py - size / 2
    return (x / s - 0.5) * 360, math.degrees(2 * math.atan(math.exp((0.5 - y / s) * 2 * math.pi)) - math.pi / 2)


class Frame:
    """u along `bearing`, v to its left, metres, around `anchor` [lng, lat]."""

    def __init__(self, anchor, bearing):
        self.anchor = anchor
        self.bearing = bearing % 360
        r = math.radians(self.bearing)
        self.f = (math.sin(r), math.cos(r))      # forward, (east, north)
        self.l = (-math.cos(r), math.sin(r))     # left

    def uv(self, lng, lat):
        x, y = to_xy(lng, lat, self.anchor)
        return (x * self.f[0] + y * self.f[1], x * self.l[0] + y * self.l[1])

    def ll(self, u, v):
        x = u * self.f[0] + v * self.l[0]
        y = u * self.f[1] + v * self.l[1]
        lng, lat = to_lnglat(x, y, self.anchor)
        return [round(lng, 7), round(lat, 7)]

    def path(self, pts):
        return [self.ll(u, v) for u, v in pts]


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return lower[:-1] + upper[:-1]


def min_rectangle(ring_ll):
    """Minimum-area bounding rectangle of a lng/lat ring: (centre [lng, lat], long-axis bearing,
    length, width). The bearing is folded into [0, 180)."""
    ref = ring_ll[0]
    pts = [to_xy(lng, lat, ref) for lng, lat in ring_ll]
    h = hull(pts)
    best = None
    for i in range(len(h)):
        a, b = h[i], h[(i + 1) % len(h)]
        ex, ey = b[0] - a[0], b[1] - a[1]
        n = math.hypot(ex, ey)
        if n < 1e-6:
            continue
        ux, uy = ex / n, ey / n
        us = [p[0] * ux + p[1] * uy for p in h]
        vs = [-p[0] * uy + p[1] * ux for p in h]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            best = (area, ux, uy, min(us), max(us), min(vs), max(vs))
    _, ux, uy, u0, u1, v0, v1 = best
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    cx, cy = cu * ux - cv * uy, cu * uy + cv * ux
    length, width = u1 - u0, v1 - v0
    if width > length:  # report the long axis
        length, width = width, length
        ux, uy = -uy, ux
    bearing = math.degrees(math.atan2(ux, uy)) % 180
    return list(to_lnglat(cx, cy, ref)), bearing, length, width


def arc(cu, cv, r, a0, a1, step_deg=4):
    """Points on a circle (angles in degrees, measured from +u toward +v)."""
    n = max(2, int(abs(a1 - a0) / step_deg) + 1)
    return [(cu + r * math.cos(math.radians(a0 + (a1 - a0) * i / (n - 1))),
             cv + r * math.sin(math.radians(a0 + (a1 - a0) * i / (n - 1)))) for i in range(n)]


def rect(u0, u1, v0, v1):
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1), (u0, v0)]


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def offset_ring(ring, d):
    """Offset a closed ring (no repeated end point) outward by d metres (mitred, clamped)."""
    ccw = signed_area(ring) > 0
    n = len(ring)
    out = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        normals = []
        for a, b in ((p0, p1), (p1, p2)):
            ex, ey = b[0] - a[0], b[1] - a[1]
            L = math.hypot(ex, ey) or 1.0
            # outward normal: right of travel for a CCW ring
            normals.append((ey / L, -ex / L) if ccw else (-ey / L, ex / L))
        nx, ny = normals[0][0] + normals[1][0], normals[0][1] + normals[1][1]
        L = math.hypot(nx, ny) or 1.0
        nx, ny = nx / L, ny / L
        cos_half = max(0.5, nx * normals[0][0] + ny * normals[0][1])
        out.append((p1[0] + nx * d / cos_half, p1[1] + ny * d / cos_half))
    return out


def clip(poly, keep):
    """Sutherland-Hodgman: clip `poly` by the half-plane where keep(p) >= 0 (keep is linear)."""
    out = []
    for i in range(len(poly)):
        a, b = poly[i - 1], poly[i]
        ka, kb = keep(a), keep(b)
        if kb >= 0:
            if ka < 0:
                t = ka / (ka - kb)
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            out.append(b)
        elif ka >= 0:
            t = ka / (ka - kb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def ring_of(element):
    pts = [(p["lon"], p["lat"]) for p in element["geometry"]]
    return pts[:-1] if pts[0] == pts[-1] else pts


def closed(path):
    return path + path[:1]


# --------------------------------------------------------------------------------------------
# Line markings (in the pitch's own u/v, centred on the pitch)
# --------------------------------------------------------------------------------------------

def hockey_lines():
    L, W = HOCKEY["length"] / 2, HOCKEY["width"] / 2
    g = HOCKEY["goal"] / 2
    r = HOCKEY["circle"]
    lines = [rect(-L, L, -W, W), [(0, -W), (0, W)]]
    for s in (-1, 1):
        q = s * (L - HOCKEY["quarter"])
        lines.append([(q, -W), (q, W)])
        # Shooting circle: quarter circles round each post joined by a straight, 14.63 m out;
        # then a dashed circle 5 m further out (0.3 m dashes every 3 m).
        def circle(rad, step=4):
            if s < 0:
                return arc(-L, -g, rad, 270, 360, step) + arc(-L, g, rad, 0, 90, step)
            return arc(L, -g, rad, 270, 180, step) + arc(L, g, rad, 180, 90, step)

        lines.append(circle(r))
        path = circle(r + 5.0, 1)
        acc, k = 0.0, 0
        for p0, p1 in zip(path, path[1:]):
            seg = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            if acc >= 3.0 * k + 1.5 and abs(p0[0]) <= L:
                t = min(1.0, 0.3 / max(seg, 1e-6))
                lines.append([p0, (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)])
                k += 1
            acc += seg
        # Penalty spot and the back-line marks 5 m and 10 m from each post.
        sp = s * (L - HOCKEY["spot"])
        lines.append([(sp - 0.075, 0), (sp + 0.075, 0)])
        for m in (5.0, 10.0):
            for side in (-1, 1):
                vv = side * (g + m)
                lines.append([(s * L, vv), (s * (L - 0.3), vv)])
    return lines


def soccer_lines(length, width):
    L, W = length / 2, width / 2
    c = SOCCER
    lines = [rect(-L, L, -W, W), [(0, -W), (0, W)], closed(arc(0, 0, c["circle"], 0, 356)),
             [(-0.11, 0), (0.11, 0)]]
    for s in (-1, 1):
        bx, sx = s * (L - c["box_d"]), s * (L - c["six_d"])
        lines.append([(s * L, -c["box_w"] / 2), (bx, -c["box_w"] / 2), (bx, c["box_w"] / 2), (s * L, c["box_w"] / 2)])
        lines.append([(s * L, -c["six_w"] / 2), (sx, -c["six_w"] / 2), (sx, c["six_w"] / 2), (s * L, c["six_w"] / 2)])
        spot = s * (L - c["spot"])
        lines.append([(spot - 0.11, 0), (spot + 0.11, 0)])
        # Penalty arc: the part of the 9.15 m circle round the spot outside the area.
        half = math.degrees(math.acos((c["box_d"] - c["spot"]) / c["circle"]))
        a0 = 180 - half if s > 0 else -half
        lines.append(arc(spot, 0, c["circle"], a0, a0 + 2 * half, 3))
        for side in (-1, 1):  # corner arcs, 1 m, inside the field
            a_u = 0 if s < 0 else 180
            a_v = -90 if side > 0 else 90
            if a_u == 180 and a_v == -90:
                a_v = 270
            lines.append(arc(s * L, side * W, 1.0, a_u, a_v, 15))
    return lines


# --------------------------------------------------------------------------------------------
# Fields
# --------------------------------------------------------------------------------------------

def tower(frame, u, v, face_bearing, height, model, source):
    """A light pole: the lamp bank's centre is 1.6 m below the top and 0.9 m in front of the pole."""
    fu = math.cos(math.radians(face_bearing - frame.bearing))
    fv = -math.sin(math.radians(face_bearing - frame.bearing))
    return {
        "position": frame.ll(u, v),
        "bearing": round(face_bearing % 360, 2),
        "height": height,
        "model": f"/models/field-light-{model}.glb",
        "litModel": f"/models/field-light-{model}-lit.glb",
        "glow": frame.ll(u + fu * 0.9, v + fv * 0.9),
        "lampHeight": round(height - 1.6, 2),  # above the field's surface
        "source": source,
    }


def measured(frame, key):
    return frame.uv(*pixel_to_lnglat(*PIXEL_MEASUREMENTS[key]))


def new_balance_field(elements):
    deck = ring_of(elements[("way", NBF_PITCH)])
    centre, bearing, length, width = min_rectangle(deck)
    # Long axis pointing east-ish (toward Babcock Street).
    bearing = bearing if bearing < 180 and 45 < bearing < 135 else (bearing + 180) % 360
    frame = Frame(centre, bearing)
    inset = [frame.uv(*pixel_to_lnglat(*m)) for m in PIXEL_MEASUREMENTS["nbf_inset"]]
    pu = sum(p[0] for p in inset) / 4
    pv = sum(p[1] for p in inset) / 4
    L, W = HOCKEY["length"] / 2, HOCKEY["width"] / 2
    pitch = Frame(frame.ll(pu, pv), bearing)
    deck_uv = [frame.uv(*p) for p in deck]
    half_w = width / 2
    alt = NBF_DECK_ALTITUDE

    lines = [pitch.path(l) for l in hockey_lines()]
    objects = []
    for s in (-1, 1):  # field-hockey goals on the back lines, mouths facing up the field
        objects.append({"kind": "goal-hockey", "position": pitch.ll(s * L, 0),
                        "bearing": round((bearing + (180 if s > 0 else 0)) % 360, 2),
                        "source": "regulation position (centre of each back line)"})
    bu, bv = measured(frame, "nbf_bleachers")
    objects.append({"kind": "bleachers-nbf", "position": frame.ll(bu, bv),
                    "bearing": round((bearing - 90) % 360, 2),
                    "source": "satellite imagery: on the walkway strip south of the turf (along Gardner St), facing the field"})
    su, sv = measured(frame, "nbf_scoreboard")
    objects.append({"kind": "scoreboard-nbf", "position": frame.ll(su, sv),
                    "bearing": round((bearing + 180) % 360, 2),
                    "source": "satellite imagery (NE corner) and the goterriers.com facility photos"})
    # Ball-stop netting along both end walls (pole shadows every ~11 m on the imagery).
    ends = []
    for s in (-1, 1):
        u_end = max(p[0] for p in deck_uv) if s > 0 else min(p[0] for p in deck_uv)
        ends.append({"kind": "net", "height": 10.0,
                     "path": [frame.ll(u_end - s * 0.6, -half_w + 0.6), frame.ll(u_end - s * 0.6, half_w - 0.6)],
                     "source": "satellite imagery (pole shadows) and goterriers.com photos; height estimated"})
    objects += ends

    towers = []
    for side in (-1, 1):
        for du in (-42.0, 0.0, 42.0):
            face = (bearing - 90) if side < 0 else (bearing + 90)
            towers.append(tower(frame, pu + du, side * (half_w - 0.8), face, 21.0, "21",
                                "estimated: three poles per long side, as in the goterriers.com photos"))

    surfaces = [
        {"kind": "runoff", "polygon": [closed([list(p) for p in deck]), pitch.path(rect(-L, L, -W, W))],
         "color": COLOURS["runoff_turf"]},
        {"kind": "pitch", "polygon": [pitch.path(rect(-L, L, -W, W))], "color": COLOURS["hockey_turf"]},
    ]
    # "BOSTON" in white block letters across the west run-off, reading south to north.
    west = min(p[0] for p in deck_uv)
    text = [{"text": "BOSTON", "position": frame.ll((west + pu - L) / 2, -1.0), "size": 10.0,
             "angle": round((90 - (bearing - 90)) % 360, 2), "color": [244, 244, 238],
             "font": "Impact, 'Arial Narrow Bold', 'Arial Black', sans-serif"}]
    return {
        "id": "new-balance-field",
        "name": "New Balance Field",
        "subtitle": "Field hockey · lacrosse · 500 seats",
        "osm": f"way/{NBF_PITCH}",
        "anchor": [round(centre[0], 7), round(centre[1], 7)],
        "bearing": round(bearing, 3),
        "altitude": alt,
        "followBuilding": {"osm": f"way/{NBF_GARAGE}", "roofBelowTop": 0.9},
        "size": [round(length, 1), round(width, 1)],
        "props": "/models/field-props-new-balance.glb",
        "surfaces": surfaces,
        "lines": lines,
        "lineWidth": 0.1,
        "lineColor": COLOURS["line"],
        "text": text,
        "objects": objects,
        "towers": towers,
        "label": [round(centre[0], 7), round(centre[1], 7)],
    }, {"deck_uv": deck_uv, "pitch_uv": (pu, pv)}


def nickerson_field(elements):
    pitch_ring = ring_of(elements[("way", NICK_PITCH)])
    centre, bearing, length, width = min_rectangle(pitch_ring)
    bearing = bearing if bearing < 180 else bearing - 180  # long axis toward the NE end zone
    frame = Frame(centre, bearing)
    track = elements[("relation", NICK_TRACK)]
    rings = {}
    for m in track["members"]:
        pts = [(p["lon"], p["lat"]) for p in m["geometry"]]
        rings[m["role"]] = pts[:-1] if pts[0] == pts[-1] else pts
    outer = [frame.uv(*p) for p in rings["outer"]]
    inner = [frame.uv(*p) for p in rings["inner"]]

    # Lane lines. OSM's track is 4.2 m wide round the bends (4 lanes, so 1.05 m each, a little
    # under the regulation 1.22 m) and wider along the SE (home) straight, where the extra
    # sprint lanes carry on as open lines wherever the surface is wide enough.
    def width_at(p):
        return min(math.hypot(q[0] - p[0], q[1] - p[1]) for q in outer)

    bend = sorted(width_at(p) for p in inner)[len(inner) // 2]
    lane = bend / 4
    lanes = [frame.path(closed(offset_ring(inner, k * lane))) for k in range(0, 5)]
    widths = [width_at(p) for p in inner]
    for k in range(5, 12):
        ring = offset_ring(inner, k * lane)
        run = []
        for p, w in zip(ring + ring[:1], widths + widths[:1]):
            if w >= k * lane + 0.3:
                run.append(p)
            elif run:
                if len(run) > 3:
                    lanes.append(frame.path(run))
                run = []
        if len(run) > 3:
            lanes.append(frame.path(run))
    # Infield turf in 5 m mowing-pattern stripes across the field (as on the imagery).
    surfaces = [{"kind": "track", "polygon": [frame.path(closed(outer)), frame.path(closed(inner))], "color": COLOURS["track"]}]
    u_min, u_max = min(p[0] for p in inner), max(p[0] for p in inner)
    k = 0
    u = -5.0 * math.ceil((-u_min) / 5.0)
    while u < u_max:
        strip = clip(clip(inner, lambda p, a=u: p[0] - a), lambda p, b=u + 5.0: b - p[0])
        if len(strip) >= 3:
            surfaces.append({"kind": "turf", "polygon": [frame.path(closed(strip))],
                             "color": COLOURS["infield_turf"] if k % 2 == 0 else COLOURS["infield_stripe"]})
        u += 5.0
        k += 1

    lines = [frame.path(l) for l in soccer_lines(length, width)]
    objects = []
    for s in (-1, 1):
        objects.append({"kind": "goal-soccer", "position": frame.ll(s * length / 2, 0),
                        "bearing": round((bearing + (180 if s > 0 else 0)) % 360, 2),
                        "source": "satellite imagery: soccer goals on both goal lines"})
    stand = ring_of(elements[("way", NICK_STAND)])
    pu, pv = measured(frame, "nick_press_box")
    objects.append({"kind": "grandstand", "footprint": [list(p) for p in stand], "pressBox": frame.ll(pu, pv),
                    "redSeats": frame.ll(*measured(frame, "nick_red_seats")),
                    "chairs": [frame.ll(*measured(frame, k)) for k in ("nick_chairs_sw", "nick_chairs_ne")],
                    "osm": f"way/{NICK_STAND}",
                    "source": "OSM footprint; tiers, aisles, chair-back and red seat blocks and press box from the satellite imagery and Wikimedia Commons photos"})
    su, sv = measured(frame, "nick_scoreboard")
    objects.append({"kind": "scoreboard-video", "position": frame.ll(su, sv), "bearing": round((bearing + 180) % 360, 2),
                    "source": "Stadium Journey ('video scoreboard in the northeast end zone') and satellite imagery"})
    for key in ("nick_bench_w", "nick_bench_e"):
        bu, bv = measured(frame, key)
        objects.append({"kind": "bench", "position": frame.ll(bu, bv), "bearing": round((bearing + 90) % 360, 2),
                        "source": "satellite imagery: team benches on the NW sideline"})
    # Fence round the stadium outline, except where the grandstand closes it.
    stadium = ring_of(elements[("way", NICK_STADIUM)])
    # Walk the outline from the first vertex after the grandstand (its NE end) round to the
    # grandstand's SW front corner.
    i0 = max(stadium.index(p) for p in stand if p in stadium) + 1
    path = stadium[i0:] + stadium[:i0]
    path = path[: path.index(stand[1]) + 1]
    # The NW side (behind the track, below the tennis courts and dorms) is an ivy-covered wall
    # with BOSTON UNIVERSITY in red letters (Wikimedia Commons: NickersonField1.jpg,
    # BUWestCampus.jpg); the rest is chain-link.
    uv = [frame.uv(*p) for p in path]
    nw = [i for i, (u, v) in enumerate(uv) if v > 40 and abs(u) < 70]
    a, b = nw[0], nw[-1]
    for part in (path[: a + 1], path[b:]):
        objects.append({"kind": "fence", "height": 2.4, "path": [list(p) for p in part],
                        "source": "OSM leisure=stadium outline; chain-link fence as in the photos, height estimated"})
    objects.append({"kind": "wall", "height": 3.0, "path": [list(p) for p in path[a: b + 1]],
                    "lettering": "BOSTON UNIVERSITY",
                    "source": "OSM leisure=stadium outline; ivy wall and lettering from the Wikimedia Commons photos, height estimated"})

    towers = []
    for key in ("nick_light_se1", "nick_light_se2"):
        tu, tv = measured(frame, key)
        towers.append(tower(frame, tu, tv, bearing - 90, 30.0, "30",
                            "satellite imagery (lamp-bank shadows on the seats); height estimated from photos"))
    tu, tv = measured(frame, "nick_light_nw1")
    towers.append(tower(frame, tu, tv, bearing + 90, 30.0, "30", "satellite imagery (pole shadow)"))
    towers.append(tower(frame, -tu, tv, bearing + 90, 30.0, "30",
                        "assumed: mirrors the west pole (a four-pole layout); not visible on the imagery"))

    text = [{"text": "BU", "position": frame.ll(0, 0), "size": 13.0, "angle": round((90 - bearing) % 360, 2),
             "color": [204, 0, 0], "outline": [250, 250, 250], "font": "Rockwell, 'Roboto Slab', Georgia, serif"}]
    return {
        "id": "nickerson-field",
        "name": "Nickerson Field",
        "subtitle": "Soccer · lacrosse · track · 10,412 seats",
        "osm": f"way/{NICK_STADIUM}",
        "replaces": [f"way/{NICK_STAND}"],  # the grandstand is modelled here, not by the city layer
        "anchor": [round(centre[0], 7), round(centre[1], 7)],
        "bearing": round(bearing, 3),
        "altitude": 0.0,
        "size": [round(length, 1), round(width, 1)],
        "props": "/models/field-props-nickerson.glb",
        "surfaces": surfaces,
        "lines": lines,
        "laneLines": lanes,
        "lineWidth": 0.12,
        "lineColor": COLOURS["line"],
        "text": text,
        "objects": objects,
        "towers": towers,
        "label": frame.ll(0, 0),
    }, {"outer": outer, "inner": inner}


SOURCES = {
    "osm": "OpenStreetMap contributors (ODbL), via Overpass: ways 1026274041, 1026274040, 663514809, 619598469, 29680684; relation 8592949",
    "imagery": "Mapbox satellite-v9 (Maxar) static images: field-hockey inset, poles, scoreboards, bleachers, press box",
    "new_balance_field": [
        "https://goterriers.com/facilities/new-balance-field/12 (500 seats, opened Sept 2013, atop the Langsam Garage, ~350 spaces, facility photos incl. scoreboard)",
        "https://www.bu.edu/articles/2013/the-games-begin-on-new-balance-field (110,000 sq ft, ~90,000 sq ft AstroTurf, bleachers for 500, six water cannons)",
        "https://www.bu.edu/cpo/project/new-balance-field/ (a deck above parking, 340 spaces, bleacher seating for 500)",
        "https://www.pci.org/PCI/PCI/Project_Resources/Project_Profile/Project_Profile_Details.aspx?ID=221528 (1 level, 322-car precast garage)",
        "https://www.bostonplans.org/projects/development-projects/boston-university-new-balance-field (500 portable seats; women's field hockey)",
    ],
    "nickerson_field": [
        "https://en.wikipedia.org/wiki/Nickerson_Field (Braves Field 1915; right-field pavilion kept; GreenFields MX turf 2015)",
        "https://sabr.org/journal/article/braves-field-to-nickerson-field-baseball-football-soccer-and-everything-in-between (press box on the pavilion since 1960; individual seats added to the lower area 2001; 10,412 capacity)",
        "https://www.stadiumjourney.com/stadiums/nickerson-field-boston-university-terriers (metal bleachers, chair-backs at midfield, video scoreboard in the NE end zone)",
        "https://www.bu.edu/meetatbu/campus-venues/athletic-venues/ (10,412 seats, four-lane track)",
        "https://commons.wikimedia.org/wiki/File:BUNickersonFldStands.jpg, File:NickersonField2.jpg, File:BUWestCampus.jpg (photos of the stand, press box, light poles)",
    ],
}


def main():
    ids = ",".join(str(i) for i in (NBF_PITCH, NBF_GARAGE, NICK_STADIUM, NICK_PITCH, NICK_STAND))
    elements = overpass(f"[out:json][timeout:60];(way(id:{ids});relation({NICK_TRACK}););out geom;")
    by_id = {(e["type"], e["id"]): e for e in elements}
    nbf, nbf_dbg = new_balance_field(by_id)
    nick, nick_dbg = nickerson_field(by_id)
    out = {"sources": SOURCES, "fields": [nbf, nick]}
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
    for f in (nbf, nick):
        print(f"  {f['name']}: {f['size'][0]} x {f['size'][1]} m, long axis {f['bearing']} deg, "
              f"{len(f['lines'])} line paths, {len(f['objects'])} objects, {len(f['towers'])} light poles")
    widths = [min(math.hypot(o[0] - i[0], o[1] - i[1]) for o in nick_dbg["outer"]) for i in nick_dbg["inner"]]
    print(f"  track width: min {min(widths):.2f} m, max {max(widths):.2f} m (4 lanes = {4 * LANE:.2f} m)")
    print(f"  NBF inset centre offset from deck centre: u {nbf_dbg['pitch_uv'][0]:.2f} m, v {nbf_dbg['pitch_uv'][1]:.2f} m")


if __name__ == "__main__":
    main()
