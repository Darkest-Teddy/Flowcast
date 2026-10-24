"""Generate low-poly vehicle models (MBTA Green Line train, 40-ft bus, BU shuttles, Boston Fire
Department engine, ladder truck and district chief's SUV) as self-contained GLBs.

Standard library only. Everything is built from flat-shaded polygons with plain PBR colours
(no textures), so the files load in deck.gl's ScenegraphLayer exactly like the Kenney models.

Conventions (same as the Kenney characters): metres at real scale, +Y up, the vehicle's front
faces +Z, origin at the centre of the footprint on the ground (wheels touch y = 0). The
vehicle's right-hand (kerb) side is therefore -X.

    python3 map-client/scripts/make_vehicle_models.py           # write both models
    python3 map-client/scripts/make_vehicle_models.py --check   # also print bounds/tri counts

Tweak the constants and profiles below and re-run.
"""

import json
import math
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "models"

# Text shown on the bus's amber front destination sign (5x7 pixel font below).
BUS_SIGN_TEXT = "MBTA"


# --------------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------------

def srgb_to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def mat(hex_colour, metallic=0.1, roughness=0.55, emissive=None):
    rgb = [srgb_to_linear(int(hex_colour[i : i + 2], 16)) for i in (1, 3, 5)]
    m = {
        "pbrMetallicRoughness": {
            "baseColorFactor": [round(v, 5) for v in rgb] + [1.0],
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
        "doubleSided": True,
    }
    if emissive:
        m["emissiveFactor"] = [round(srgb_to_linear(int(emissive[i : i + 2], 16)), 5) for i in (1, 3, 5)]
    return m


MATERIALS = {
    "body": mat("#E4E7EA", 0.2, 0.45),          # silver-white bodywork
    "roof": mat("#C4CACF", 0.2, 0.55),
    "mbta_green": mat("#00843D", 0.05, 0.5),    # MBTA Green Line
    "mbta_yellow": mat("#FFC72C", 0.05, 0.5),   # MBTA bus yellow
    "glass": mat("#1B2228", 0.3, 0.2),
    "door": mat("#7A848E", 0.3, 0.45),         # door leaves (glazing is a decal)
    "logo_white": mat("#F4F5F6", 0.0, 0.5),
    "trim": mat("#4A5057", 0.2, 0.6),           # skirts, bumpers, frames
    "equipment": mat("#6B7178", 0.3, 0.6),      # roof AC / resistor boxes
    "under": mat("#25282B", 0.1, 0.8),          # undercarriage, bogies, wheel wells
    "tyre": mat("#1A1B1D", 0.0, 0.9),
    "hub": mat("#C9CED3", 0.6, 0.35),
    "steel": mat("#8A9097", 0.7, 0.4),          # train wheels, pantograph
    "headlight": mat("#FFF8E0", 0.0, 0.3, emissive="#FFF4D0"),
    "headlight_off": mat("#B8BCC0", 0.3, 0.25),
    "taillight": mat("#E3262B", 0.0, 0.35, emissive="#D01818"),
    "taillight_off": mat("#7A1A1C", 0.1, 0.35),
    "indicator": mat("#FF9F1A", 0.0, 0.35),
    "sign_black": mat("#111315", 0.1, 0.5),
    "sign_amber": mat("#FFB21A", 0.0, 0.4, emissive="#FF9E00"),
    "sign_white": mat("#FFFFFF", 0.0, 0.4, emissive="#606060"),
    # Boston Fire Department apparatus: red with a white cab roof and gold-leaf lettering.
    "fire_red": mat("#B5121B", 0.25, 0.4),
    "fire_white": mat("#F2F2F0", 0.15, 0.45),
    "fire_gold": mat("#D4A63A", 0.6, 0.35),
    "alu": mat("#BFC5CB", 0.75, 0.35),         # roll-up compartment doors, diamond plate
    "chrome": mat("#DDE2E6", 0.9, 0.2),
    "hose": mat("#B49A62", 0.0, 0.8),
    "lightbar": mat("#202326", 0.2, 0.5),
}

# Warning lights. Their emissiveFactor is a code, not a colour: (0, 0, k/4) puts the lens in
# flash group k (1: A, 2: B, 3: slow rear group). The fire layer's shader (layers/fireTrucks.ts)
# lights each group from a per-truck bitmask, using the lens's base colour; off, it's a dark lens.
for _name, _hex, _group in (("strobe_red_a", "#E8141E", 1), ("strobe_red_b", "#E8141E", 2),
                            ("strobe_white_a", "#FFFFFF", 1), ("strobe_white_b", "#FFFFFF", 2),
                            ("strobe_amber_c", "#FF9A10", 3)):
    MATERIALS[_name] = {**mat(_hex, 0.0, 0.3), "emissiveFactor": [0.0, 0.0, _group / 4]}


# --------------------------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------------------------

def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    length = math.sqrt(dot(a, a))
    return scale(a, 1.0 / length) if length > 1e-12 else (0.0, 0.0, 0.0)


def lerp(a, b, t):
    return a + (b - a) * t


def newell(points):
    n = [0.0, 0.0, 0.0]
    for i, p in enumerate(points):
        q = points[(i + 1) % len(points)]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return tuple(n)


class Mesh:
    """Flat-shaded polygons grouped by material; each polygon gets its own face normal."""

    def __init__(self):
        self.prims = {}  # material -> [positions, normals, indices]

    def poly(self, points, material, outward=None, offset=0.0):
        """Add a planar convex polygon. Winding is taken as CCW-from-outside unless `outward`
        is given, in which case the polygon is flipped if needed to face that direction."""
        points = [p for i, p in enumerate(points) if dot(d := sub(p, points[i - 1]), d) > 1e-12]
        n = newell(points)
        if len(points) < 3 or math.sqrt(dot(n, n)) < 1e-9:
            return  # degenerate (zero area)
        if outward is not None and dot(n, outward) < 0:
            points = points[::-1]
            n = scale(n, -1)
        n = norm(n)
        if offset:
            points = [add(p, scale(n, offset)) for p in points]
        pos, nrm, idx = self.prims.setdefault(material, [[], [], []])
        base = len(pos)
        pos.extend(points)
        nrm.extend([n] * len(points))
        for i in range(1, len(points) - 1):
            idx.extend((base, base + i, base + i + 1))

    def box(self, x0, x1, y0, y1, z0, z1, material, skip=()):
        c = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        faces = {
            "+x": [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
            "-x": [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
            "+y": [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
            "-y": [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
            "+z": [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
            "-z": [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)],
        }
        for name, pts in faces.items():
            if name in skip:
                continue
            fc = scale(add(add(pts[0], pts[1]), add(pts[2], pts[3])), 0.25)
            self.poly(pts, material, outward=sub(fc, c))

    def beam(self, p0, p1, width, height, material):
        """A rectangular bar from p0 to p1 (for pantograph arms etc.)."""
        d = norm(sub(p1, p0))
        up = (0.0, 1.0, 0.0) if abs(d[1]) < 0.95 else (1.0, 0.0, 0.0)
        s = norm(cross(d, up))
        u = cross(s, d)
        hw, hh = width / 2, height / 2
        corners = []
        for p in (p0, p1):
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                corners.append(add(p, add(scale(s, a * hw), scale(u, b * hh))))
        c = scale(add(p0, p1), 0.5)
        quads = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (0, 3, 2, 1), (4, 5, 6, 7)]
        for q in quads:
            pts = [corners[i] for i in q]
            fc = scale(add(add(pts[0], pts[1]), add(pts[2], pts[3])), 0.25)
            self.poly(pts, material, outward=sub(fc, c))

    def cylinder_x(self, cx, cy, cz, radius, x0, x1, segments, side_mat, cap_mat=None, caps=("+x", "-x")):
        """A cylinder whose axis runs along X (wheels)."""
        ring = [(cy + radius * math.cos(2 * math.pi * i / segments), cz + radius * math.sin(2 * math.pi * i / segments))
                for i in range(segments)]
        for i in range(segments):
            (ya, za), (yb, zb) = ring[i], ring[(i + 1) % segments]
            mid = ((ya + yb) / 2 - cy, (za + zb) / 2 - cz)
            self.poly([(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], side_mat, outward=(0, mid[0], mid[1]))
        if "+x" in caps:
            self.poly([(x1, y, z) for y, z in ring], cap_mat or side_mat, outward=(1, 0, 0))
        if "-x" in caps:
            self.poly([(x0, y, z) for y, z in ring], cap_mat or side_mat, outward=(-1, 0, 0))

    def append(self, other, translate=(0.0, 0.0, 0.0), mirror_z=False):
        sz = -1.0 if mirror_z else 1.0
        for material, (pos, nrm, idx) in other.prims.items():
            dpos, dnrm, didx = self.prims.setdefault(material, [[], [], []])
            base = len(dpos)
            dpos.extend((p[0] + translate[0], p[1] + translate[1], p[2] * sz + translate[2]) for p in pos)
            dnrm.extend((n[0], n[1], n[2] * sz) for n in nrm)
            for i in range(0, len(idx), 3):
                a, b, c = idx[i : i + 3]
                if mirror_z:  # a reflection flips the winding
                    b, c = c, b
                didx.extend((base + a, base + b, base + c))

    def triangle_count(self):
        return sum(len(p[2]) // 3 for p in self.prims.values())


# --------------------------------------------------------------------------------------------
# Banded loft: the car/bus body
# --------------------------------------------------------------------------------------------
#
# A body is a symmetric cross-section made of horizontal "levels" (y, half-width). Each band
# between two levels has a material (skirt, colour band, windows ...), so the livery stays on
# the bodywork even where the nose tapers and leans. Stations along Z place each level; a
# station can taper (half-width scale), lean (per-level z offset) or inset some levels (wheel
# wells). Faces between stations are emitted per band, merged along straight runs.

class Loft:
    def __init__(self, levels, stations):
        """levels: [(y, half_width)], bottom to top.
        stations: [(z, [(half_width, y, dz) per level])] in increasing z order."""
        self.levels = levels
        self.n = len(levels) - 1  # number of bands
        self.stations = stations

    def right(self, j, i):
        z, pts = self.stations[j]
        hw, y, dz = pts[i]
        return (hw, y, z + dz)

    def loop(self, j):
        """Cross-section loop, CCW seen from +Z: up the right (+X) side, across the roof,
        down the left side; the closing edge is the floor."""
        r = [self.right(j, i) for i in range(self.n + 1)]
        left = [(-p[0], p[1], p[2]) for p in reversed(r)]
        return r + left

    def edge_info(self, k):
        n = self.n
        if k < n:
            return "side", k, 1
        if k == n:
            return "roof", None, 0
        if k < 2 * n + 1:
            return "side", 2 * n - k, -1
        return "bottom", None, 0

    def build(self, mesh, material_fn, cap_start=None, cap_end=None):
        """material_fn(kind, band, side, z_mid) -> material. cap_*: band -> material, or None
        to leave that end open."""
        loops = [self.loop(j) for j in range(len(self.stations))]
        nv = len(loops[0])
        for k in range(nv):
            kind, band, side = self.edge_info(k)
            k2 = (k + 1) % nv
            j0 = 0
            while j0 < len(loops) - 1:
                zmid = (loops[j0][k][2] + loops[j0 + 1][k][2]) / 2
                m = material_fn(kind, band, side, zmid)
                j1 = j0 + 1
                # Extend along straight runs (same x/y at every station) with the same material.
                while j1 < len(loops) - 1:
                    same_xy = all(loops[j1 + 1][v][:2] == loops[j1][v][:2] == loops[j0][v][:2] for v in (k, k2))
                    zn = (loops[j1][k][2] + loops[j1 + 1][k][2]) / 2
                    if not same_xy or material_fn(kind, band, side, zn) != m:
                        break
                    j1 += 1
                if m is not None:
                    mesh.poly([loops[j0][k], loops[j0][k2], loops[j1][k2], loops[j1][k]], m)
                j0 = j1
        for cap, j, flip in ((cap_start, 0, True), (cap_end, len(loops) - 1, False)):
            if cap is None:
                continue
            for i in range(self.n):
                r0, r1 = self.right(j, i), self.right(j, i + 1)
                pts = [r0, r1, (-r1[0], r1[1], r1[2]), (-r0[0], r0[1], r0[2])]
                mesh.poly(pts[::-1] if flip else pts, cap(i))

    def cap_point(self, j, x, y):
        """Point on an end cap (station j) at height y, plus the cap's outward normal there."""
        for i in range(self.n):
            r0, r1 = self.right(j, i), self.right(j, i + 1)
            if r0[1] - 1e-9 <= y <= r1[1] + 1e-9:
                t = (y - r0[1]) / (r1[1] - r0[1])
                z = lerp(r0[2], r1[2], t)
                tangent = sub(r1, r0)
                n = norm(cross((1.0, 0.0, 0.0), (0.0, tangent[1], tangent[2])))
                facing = 1 if j == len(self.stations) - 1 else -1
                if n[2] * facing < 0:
                    n = scale(n, -1)
                return (x, y, z), n, i
        raise ValueError(f"y={y} outside the cap")

    def cap_decal(self, mesh, j, x0, x1, y0, y1, material, offset=0.012):
        """A flat rectangle on an end cap, split at band edges so it hugs a leaning face."""
        cuts = [y0] + [lv[1] for lv in (self.right(j, i) for i in range(self.n + 1)) if y0 < lv[1] < y1] + [y1]
        for ya, yb in zip(cuts, cuts[1:]):
            ym = (ya + yb) / 2
            _, n, band = self.cap_point(j, 0, ym)
            pts = []
            for x, y in ((x0, ya), (x1, ya), (x1, yb), (x0, yb)):
                r0, r1 = self.right(j, band), self.right(j, band + 1)
                t = (y - r0[1]) / (r1[1] - r0[1])
                pts.append(add((x, y, lerp(r0[2], r1[2], t)), scale(n, offset)))
            mesh.poly(pts, material, outward=n)

    def side_x(self, y):
        """Half-width of the straight (untapered) body at height y."""
        for (ya, wa), (yb, wb) in zip(self.levels, self.levels[1:]):
            if ya - 1e-9 <= y <= yb + 1e-9:
                return lerp(wa, wb, (y - ya) / (yb - ya))
        raise ValueError(f"y={y} outside the body")

    def side_poly(self, mesh, side, zy_points, material, offset=0.012):
        """A flat decal on the straight body side (side=+1 for +X, -1 for -X), given (z, y)."""
        pts = [(side * (self.side_x(y) + offset), y, z) for z, y in zy_points]
        mesh.poly(pts, material, outward=(side, 0.0, 0.0))

    def side_decal(self, mesh, side, z0, z1, y0, y1, material, offset=0.012):
        cuts = [y0] + [y for y, _ in self.levels if y0 < y < y1] + [y1]
        for ya, yb in zip(cuts, cuts[1:]):
            self.side_poly(mesh, side, [(z0, ya), (z1, ya), (z1, yb), (z0, yb)], material, offset)

    def side_roundel(self, mesh, side, zc, yc, radius):
        """The MBTA 'T' roundel: dark ring, white disc, dark T."""
        def disc(r, material, offset):
            ring = [(zc + r * math.cos(2 * math.pi * i / 20), yc + r * math.sin(2 * math.pi * i / 20)) for i in range(20)]
            self.side_poly(mesh, side, ring, material, offset)
        disc(radius, "sign_black", 0.012)
        disc(radius * 0.82, "logo_white", 0.018)
        t = radius * 0.62
        self.side_decal(mesh, side, zc - t, zc + t, yc + t * 0.42, yc + t * 0.78, "sign_black", 0.024)
        self.side_decal(mesh, side, zc - t * 0.2, zc + t * 0.2, yc - t * 0.95, yc + t * 0.45, "sign_black", 0.024)


# --------------------------------------------------------------------------------------------
# Pixel text (for the "B" route sign and the bus destination sign)
# --------------------------------------------------------------------------------------------

FONT = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}


def text_rects(text, cx, cy, pixel, facing=1):
    """Rectangles (x0, x1, y0, y1) spelling `text` centred on (cx, cy), read from the side the
    face points to (facing=+1 for a +Z face, -1 for a -Z face)."""
    cols = len(text) * 6 - 1
    rects = []
    for ci, ch in enumerate(text):
        for row, line in enumerate(FONT[ch]):
            col = 0
            while col < 5:
                if line[col] != "#":
                    col += 1
                    continue
                start = col
                while col < 5 and line[col] == "#":
                    col += 1
                u0 = (ci * 6 + start - cols / 2) * pixel
                u1 = (ci * 6 + col - cols / 2) * pixel
                y1 = cy + (3.5 - row) * pixel
                xa, xb = (cx + u0, cx + u1) if facing > 0 else (cx - u1, cx - u0)
                rects.append((xa, xb, y1 - pixel, y1))
    return rects


# --------------------------------------------------------------------------------------------
# Green Line train: two coupled double-ended articulated LRVs (Type 7/8 style)
# --------------------------------------------------------------------------------------------

TRAIN_CAR_LEN = 22.2      # each LRV, coupler face to coupler face
TRAIN_GAP = 0.6           # between the two cars (coupler)
TRAIN_ARTIC_HALF = 0.25   # half-length of each car's central articulation
TRAIN_NOSE = 1.3          # length of the tapered cab

TRAIN_LEVELS = [  # (y, half_width); the band above each level gets TRAIN_BANDS[i]
    (0.42, 1.26),
    (0.62, 1.31),
    (1.12, 1.345),
    (1.36, 1.35),
    (2.50, 1.33),
    (2.92, 1.29),
    (3.22, 1.02),
]
TRAIN_BANDS = ["trim", "mbta_green", "body", "glass", "body", "roof"]
WINDOW_BAND_TRAIN = 3


def train_half_stations():
    """Stations for one half of an LRV, from the articulation (z=artic) out to the cab end."""
    z_end = TRAIN_CAR_LEN / 2

    def lean(y):  # how far each level of the cab face is set back
        if y < 0.5:
            return 0.14
        if y < 0.7:
            return 0.03
        return max(0.0, (y - 1.36) * 0.36)

    def station(z, hw_scale, lean_f, roof_drop=0.0):
        pts = []
        for i, (y, hw) in enumerate(TRAIN_LEVELS):
            yy = y - (roof_drop if i == len(TRAIN_LEVELS) - 1 else 0.0)
            pts.append((hw * hw_scale, yy, -lean(y) * lean_f))
        return (z, pts)

    zs = {TRAIN_ARTIC_HALF, z_end - TRAIN_NOSE}
    for a, b in train_window_breaks():
        zs.update((a, b))
    straight = sorted(z for z in zs if TRAIN_ARTIC_HALF <= z <= z_end - TRAIN_NOSE)
    st = [station(z, 1.0, 0.0) for z in straight]
    st.append(station(z_end - 0.55, 0.975, 0.25, 0.03))
    st.append(station(z_end - 0.18, 0.93, 0.7, 0.08))
    st.append(station(z_end, 0.88, 1.0, 0.12))
    return st


def train_doors():
    return [(1.6, 2.9), (6.9, 8.2)]  # z ranges on each half-car (both sides)


def train_pillars():
    return [(0.25, 0.42), (1.45, 1.6), (2.9, 3.05), (4.25, 4.37), (5.6, 5.72), (6.78, 6.9),
            (8.2, 8.35), (9.25, 9.37)]


def train_window_breaks():
    return train_doors() + train_pillars()


def train_half_material(kind, band, side, z):
    if kind == "roof":
        return "roof"
    if kind == "bottom":
        return "under"
    for a, b in train_doors():
        if a <= z <= b:
            if band == WINDOW_BAND_TRAIN or band == 2:
                return "door"
            return TRAIN_BANDS[band]
    if band == WINDOW_BAND_TRAIN:
        for a, b in train_pillars():
            if a <= z <= b:
                return "body"
    return TRAIN_BANDS[band]


def build_train_half(lit, b_sign=True, inner=False, mirrored=False):
    """One half of an LRV, pointing +Z (cab at the +Z end). `lit`: 'head', 'tail' or None.
    `inner`: this cab is coupled to the other car, so its coupler reaches across the gap.
    `mirrored`: the half will be reflected to face -Z, so lay sign text out reversed."""
    m = Mesh()
    loft = Loft(TRAIN_LEVELS, train_half_stations())
    loft.build(m, train_half_material, cap_start=lambda i: "trim", cap_end=lambda i: TRAIN_BANDS[i])
    end = len(loft.stations) - 1
    # Cab face details: lights, route sign, wipers' dark surround.
    head = "headlight" if lit == "head" else "headlight_off"
    tail = "taillight" if lit == "tail" else "taillight_off"
    for s in (1, -1):
        loft.cap_decal(m, end, *sorted((s * 0.55, s * 0.85)), 0.80, 0.98, head)
        loft.cap_decal(m, end, *sorted((s * 0.88, s * 1.04)), 0.80, 0.98, tail)
    if b_sign:
        loft.cap_decal(m, end, -0.95, 0.95, 2.55, 2.88, "sign_black")
        loft.cap_decal(m, end, -0.22, 0.22, 2.53, 2.90, "mbta_green", offset=0.02)
        for r in text_rects("B", 0.0, 2.715, 0.042, facing=-1 if mirrored else 1):
            loft.cap_decal(m, end, *r, "sign_white", offset=0.026)
    # Door glazing (two leaves per door, both sides) and the T roundel.
    for s in (1, -1):
        for a, b in train_doors():
            mid = (a + b) / 2
            for za, zb in ((a + 0.1, mid - 0.04), (mid + 0.04, b - 0.1)):
                loft.side_decal(m, s, za, zb, 1.42, 2.40, "glass")
        loft.side_roundel(m, s, 5.0, 0.87, 0.21)
    # Coupler and anticlimber under the cab.
    z_end = TRAIN_CAR_LEN / 2
    m.box(-0.9, 0.9, 0.44, 0.56, z_end - 0.4, z_end - 0.1, "trim")
    m.box(-0.14, 0.14, 0.52, 0.72, z_end - 0.6, z_end + (TRAIN_GAP / 2 if inner else -0.05), "under")
    # Undercarriage equipment between the bogies.
    m.box(-1.0, 1.0, 0.30, 0.43, 1.2, z_end - 3.0, "under", skip=("+y",))
    return m


def bogie(m, zc, wheel_r=0.33):
    for x0, x1 in ((0.70, 0.84), (-0.84, -0.70)):
        for dz in (-0.95, 0.95):
            m.cylinder_x(0, wheel_r, zc + dz, wheel_r, x0, x1, 10, "steel")
    for s in (1, -1):
        m.box(*sorted((s * 0.86, s * 1.0)), 0.30, 0.56, zc - 1.35, zc + 1.35, "under")
        for dz in (-0.95, 0.95):  # axle boxes
            m.box(*sorted((s * 0.84, s * 1.04)), 0.22, 0.44, zc + dz - 0.14, zc + dz + 0.14, "trim")
    m.box(-0.86, 0.86, 0.38, 0.52, zc - 0.25, zc + 0.25, "under", skip=("-y",))  # bolster


def pantograph(m, zc):
    y0 = 3.22
    m.box(-0.55, 0.55, y0, y0 + 0.1, zc - 0.9, zc + 0.9, "equipment")
    for x in (-0.45, 0.45):
        for z in (zc - 0.75, zc + 0.75):
            m.box(x - 0.06, x + 0.06, y0 + 0.1, y0 + 0.28, z - 0.06, z + 0.06, "body")  # insulators
    base = y0 + 0.30
    m.box(-0.5, 0.5, base - 0.03, base + 0.03, zc - 0.85, zc + 0.85, "under")
    hinge = (0.0, base + 0.05, zc - 0.7)
    knee = (0.0, base + 0.55, zc + 0.95)
    head_z = zc - 0.05
    head_y = 4.36
    for x in (-0.3, 0.3):
        m.beam((x, hinge[1], hinge[2]), (x * 0.4, knee[1], knee[2]), 0.06, 0.06, "under")
    m.beam(knee, (0.0, head_y - 0.06, head_z), 0.05, 0.05, "under")
    m.beam((0.0, base + 0.08, zc - 0.4), (0.0, base + 0.5, zc + 0.65), 0.035, 0.035, "under")  # damper
    m.box(-0.62, 0.62, head_y - 0.06, head_y, head_z - 0.12, head_z + 0.12, "steel")
    for s in (1, -1):
        m.beam((s * 0.62, head_y - 0.03, head_z), (s * 0.85, head_y - 0.2, head_z), 0.05, 0.04, "steel")
        m.beam((s * 0.3, head_y - 0.06, head_z), (s * 0.12, knee[1] + 0.2, head_z + 0.35), 0.03, 0.03, "under")


def build_lrv(front_lit, rear_lit, front_inner):
    """One double-ended LRV centred on z=0, cab A at +Z."""
    car = Mesh()
    car.append(build_train_half(front_lit, inner=front_inner))
    car.append(build_train_half(rear_lit, inner=not front_inner, mirrored=True), mirror_z=True)
    # Articulation bellows between the two sections.
    a = TRAIN_ARTIC_HALF
    car.box(-1.22, 1.22, 0.55, 3.10, -a, a, "under")
    for z in (-a * 0.5, 0.0, a * 0.5):
        car.box(-1.25, 1.25, 0.6, 3.05, z - 0.03, z + 0.03, "trim")
    car.box(-0.95, 0.95, 3.10, 3.18, -a - 0.1, a + 0.1, "roof")
    # Bogies: one under each cab section and one under the articulation.
    half = TRAIN_CAR_LEN / 2
    for zc in (half - 3.4, 0.0, -(half - 3.4)):
        bogie(car, zc)
    # Roof equipment: AC units, resistor grid and the pantograph.
    car.box(-0.85, 0.85, 3.22, 3.56, 3.2, 6.8, "equipment")
    car.box(-0.75, 0.75, 3.56, 3.60, 3.5, 6.5, "trim")
    car.box(-0.85, 0.85, 3.22, 3.50, -8.6, -6.4, "equipment")
    car.box(-0.6, 0.6, 3.22, 3.42, 1.0, 2.6, "equipment")
    pantograph(car, -4.2)
    return car


def build_train():
    m = Mesh()
    offset = TRAIN_CAR_LEN / 2 + TRAIN_GAP / 2
    m.append(build_lrv("head", None, front_inner=False), translate=(0, 0, offset))
    m.append(build_lrv(None, "tail", front_inner=True), translate=(0, 0, -offset))
    return m


# --------------------------------------------------------------------------------------------
# MBTA 40-ft bus (New Flyer Xcelsior style)
# --------------------------------------------------------------------------------------------

BUS_LEN = 12.2
BUS_WHEEL_R = 0.5
BUS_AXLES = (3.9, -3.1)     # front, rear axle z
BUS_ARCH_HALF = 0.64
BUS_FRONT_DOOR = (4.62, 5.72)
BUS_REAR_DOOR = (-1.75, -0.55)

BUS_LEVELS = [
    (0.32, 1.24),
    (0.52, 1.29),
    (1.06, 1.30),
    (1.12, 1.30),
    (1.40, 1.30),
    (1.46, 1.30),
    (2.52, 1.27),
    (2.80, 1.22),
    (2.95, 1.02),
]
BUS_BANDS = ["trim", "body", "body", "mbta_yellow", "body", "glass", "body", "roof"]
WINDOW_BAND_BUS = 5
ARCH_LEVELS = 3  # levels 0..2 are pulled in to form the wheel wells


def bus_stations():
    z_f, z_r = BUS_LEN / 2, -BUS_LEN / 2

    def front_lean(i, y):
        if i == 0:
            return 0.08
        return max(0.0, (y - 1.12) * 0.10)

    def station(z, hw_scale=1.0, lean_f=0.0, arch=False, rear=False):
        pts = []
        for i, (y, hw) in enumerate(BUS_LEVELS):
            w = 0.95 if (arch and i < ARCH_LEVELS) else hw * hw_scale
            dz = 0.0
            if lean_f:
                dz = -front_lean(i, y) * lean_f if not rear else (0.05 if i == 0 else 0.0) * lean_f
            pts.append((w, y, dz))
        return (z, pts)

    st = [
        station(z_r, 0.93, 1.0, rear=True),
        station(z_r + 0.2, 0.985, 0.5, rear=True),
    ]
    breaks = {z_r + 0.35, z_f - 0.35}
    for a, b in bus_window_breaks() + [BUS_FRONT_DOOR, BUS_REAR_DOOR]:
        breaks.update((a, b))
    arch_edges = []
    for zc in BUS_AXLES:
        arch_edges.append((zc - BUS_ARCH_HALF, zc + BUS_ARCH_HALF))
    for z in sorted(breaks | {e for pair in arch_edges for e in pair}):
        in_arch = [a < z < b for a, b in arch_edges]
        at_start = [abs(z - a) < 1e-9 for a, _ in arch_edges]
        at_end = [abs(z - b) < 1e-9 for _, b in arch_edges]
        if any(at_start):
            st += [station(z), station(z, arch=True)]
        elif any(at_end):
            st += [station(z, arch=True), station(z)]
        else:
            st.append(station(z, arch=any(in_arch)))
    st += [
        station(z_f - 0.2, 0.985, 0.5),
        station(z_f, 0.94, 1.0),
    ]
    return st


def bus_window_breaks():
    # Side window pillars (z ranges).
    return [(-5.6, -5.45), (-4.3, -4.18), (-2.95, -2.83), (-0.55, -0.43), (0.85, 0.97),
            (2.25, 2.37), (3.65, 3.77), (4.62, 4.74)]


def bus_material(kind, band, side, z):
    if kind == "roof":
        return "roof"
    if kind == "bottom":
        return "under"
    for zc in BUS_AXLES:
        if zc - BUS_ARCH_HALF <= z <= zc + BUS_ARCH_HALF and band < ARCH_LEVELS:
            return "under"
    if side < 0:  # kerb side doors (vehicle's right is -X)
        for a, b in (BUS_FRONT_DOOR, BUS_REAR_DOOR):
            if a <= z <= b and 1 <= band <= WINDOW_BAND_BUS:
                return "door"
    if band == WINDOW_BAND_BUS:
        for a, b in bus_window_breaks():
            if a <= z <= b:
                return "body"
        if z < -5.6:
            return "body"  # engine bay, no rear-most window
    return BUS_BANDS[band]


def build_bus(sign_text=BUS_SIGN_TEXT, mbta_roundel=True, side_text=None):
    """An MBTA bus by default; the BU shuttle passes its own sign/side text and drops the T."""
    m = Mesh()
    loft = Loft(BUS_LEVELS, bus_stations())
    front_cap = {0: "trim", 1: "body", 2: "body", 3: "glass", 4: "glass", 5: "glass", 6: "sign_black", 7: "roof"}
    rear_cap = {0: "trim", 1: "body", 2: "body", 3: "mbta_yellow", 4: "body", 5: "glass", 6: "body", 7: "roof"}
    loft.build(m, bus_material, cap_start=rear_cap.get, cap_end=front_cap.get)
    front, rear = len(loft.stations) - 1, 0
    for s in (1, -1):
        # Headlights, indicators and tail lights.
        loft.cap_decal(m, front, *sorted((s * 0.72, s * 1.08)), 0.66, 0.84, "headlight")
        loft.cap_decal(m, front, *sorted((s * 0.92, s * 1.08)), 0.88, 0.98, "indicator")
        loft.cap_decal(m, rear, *sorted((s * 0.86, s * 1.12)), 0.62, 1.02, "taillight")
        # Mirror arms would widen the bounds past 2.6 m, so they're left off.
    # Windscreen split and wiper bar.
    loft.cap_decal(m, front, -0.025, 0.025, 1.14, 2.50, "trim")
    loft.cap_decal(m, front, -1.0, 1.0, 1.12, 1.17, "trim")
    # Destination sign.
    for r in text_rects(sign_text, 0.0, 2.66, 0.032):
        loft.cap_decal(m, front, *r, "sign_amber", offset=0.018)
    loft.cap_decal(m, rear, -0.9, 0.9, 0.36, 0.50, "under")  # rear bumper strip
    # Door glazing (kerb side, -X): two leaves per door.
    for a, b in (BUS_FRONT_DOOR, BUS_REAR_DOOR):
        mid = (a + b) / 2
        for za, zb in ((a + 0.07, mid - 0.03), (mid + 0.03, b - 0.07)):
            loft.side_decal(m, -1, za, zb, 0.72, 2.44, "glass")
    if mbta_roundel:
        for s in (1, -1):
            loft.side_roundel(m, s, 1.6, 0.79, 0.22)
    if side_text:
        # Big white lettering below the windows. Each side is read from outside, so +X reads
        # toward -Z and -X toward +Z.
        for s in (1, -1):
            for x0, x1, y0, y1 in text_rects(side_text, 0.6, 1.0, 0.075, facing=-s):
                loft.side_decal(m, s, x0, x1, y0, y1, "logo_white", 0.02)
    # Wheels: tyre, hub, and dark inner faces.
    for zc in BUS_AXLES:
        for s in (1, -1):
            xo, xi = s * 1.27, s * 0.97
            m.cylinder_x(0, BUS_WHEEL_R, zc, BUS_WHEEL_R, min(xo, xi), max(xo, xi), 16, "tyre")
            hx = s * 1.285
            m.cylinder_x(0, BUS_WHEEL_R, zc, 0.29, min(hx, xo), max(hx, xo), 12, "hub",
                         caps=("+x",) if s > 0 else ("-x",))
            for k in range(5):  # wheel nuts ring as small studs
                a = 2 * math.pi * k / 5
                yy, zz = BUS_WHEEL_R + 0.15 * math.cos(a), zc + 0.15 * math.sin(a)
                m.box(*sorted((hx, s * 1.295)), yy - 0.025, yy + 0.025, zz - 0.025, zz + 0.025, "trim")
    # Roof: AC unit and battery/exhaust housing.
    m.box(-0.95, 0.95, 2.95, 3.20, 0.2, 3.3, "equipment")
    m.box(-0.8, 0.8, 3.15, 3.20, 0.6, 2.9, "trim", skip=("-y",))
    m.box(-0.85, 0.85, 2.95, 3.12, -5.4, -3.4, "equipment")
    return m


# --------------------------------------------------------------------------------------------
# Boston Fire Department apparatus: engine (pumper), rear-mount aerial ladder, chief's SUV
# --------------------------------------------------------------------------------------------
#
# Boxy custom-cab fire apparatus (E-ONE style, which BFD has bought since 1984) built from boxes
# and flat decals. Left (+X) and right (-X) warning lights are in opposite flash groups, so red
# and white alternate side to side: A = left reds + right whites, B = right reds + left whites.

FIRE_HALF_W = 1.25


def decal_x(m, side, x_half, z0, z1, y0, y1, material, offset=0.012):
    """A flat rectangle on a body side (side=+1 for +X, -1 for -X) whose face is at |x| = x_half."""
    x = side * (x_half + offset)
    m.poly([(x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0)], material, outward=(side, 0.0, 0.0))


def decal_z(m, facing, z_face, x0, x1, y0, y1, material, offset=0.012):
    """A flat rectangle on a front (+1) or rear (-1) face at z = z_face."""
    z = z_face + facing * offset
    m.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], material, outward=(0.0, 0.0, facing))


def side_text(m, x_half, text, zc, yc, pixel, material):
    """Lettering read from outside on both sides (+X reads toward -Z, -X toward +Z)."""
    for s in (1, -1):
        for x0, x1, y0, y1 in text_rects(text, zc, yc, pixel, facing=-s):
            decal_x(m, s, x_half, x0, x1, y0, y1, material, 0.02)


def fire_wheel(m, zc, radius=0.52, dual=False):
    for s in (1, -1):
        xo, xi = s * 1.24, s * (0.78 if dual else 0.94)
        m.cylinder_x(0, radius, zc, radius, min(xo, xi), max(xo, xi), 16, "tyre")
        hx = s * 1.255
        m.cylinder_x(0, radius, zc, radius * 0.55, min(hx, xo), max(hx, xo), 12, "chrome",
                     caps=("+x",) if s > 0 else ("-x",))


def lightbar(m, z0, z1, y0, half_width=1.1, segments=6):
    """Roof light bar: dark base, alternating red/white lenses, groups mirrored left/right."""
    m.box(-half_width - 0.03, half_width + 0.03, y0, y0 + 0.06, z0 - 0.03, z1 + 0.03, "lightbar")
    width = 2 * half_width / segments
    for i in range(segments):
        x1 = half_width - i * width
        x0 = x1 - width + 0.02
        left = (x0 + x1) / 2 > 0
        red = i % 2 == 0 if left else (segments - 1 - i) % 2 == 0
        group = ("a" if left else "b") if red else ("b" if left else "a")
        m.box(x0, x1, y0 + 0.06, y0 + 0.2, z0, z1, f"strobe_{'red' if red else 'white'}_{group}")


def fire_cab(m, z_rear, z_front, roof=2.95, crew=True):
    """Tilt cab: red, white roof, big windscreen, door windows, bumper, grille and lights."""
    w = FIRE_HALF_W
    m.box(-w, w, 0.55, roof - 0.12, z_rear, z_front, "fire_red")
    m.box(-w, w, roof - 0.12, roof, z_rear, z_front, "fire_white")
    # Windscreen and side glass.
    decal_z(m, 1, z_front, -1.12, 1.12, 1.78, roof - 0.28, "glass")
    decal_z(m, 1, z_front, -0.025, 0.025, 1.78, roof - 0.28, "trim", 0.02)
    for s in (1, -1):
        decal_x(m, s, w, z_front - 1.25, z_front - 0.12, 1.78, roof - 0.3, "glass")
        if crew:
            decal_x(m, s, w, z_rear + 0.15, z_rear + 1.3, 1.78, roof - 0.3, "glass")
        # Door seams and handles.
        decal_x(m, s, w, z_front - 1.32, z_front - 1.28, 0.65, roof - 0.25, "trim")
        decal_x(m, s, w, z_front - 1.55, z_front - 1.3, 1.45, 1.52, "chrome")
        # Cab-side warning lights (upper front corners) and step lights.
        decal_x(m, s, w, z_front - 0.35, z_front - 0.06, roof - 0.3, roof - 0.16, "strobe_red_a" if s > 0 else "strobe_red_b", 0.03)
    # Grille, headlights and front warning lights.
    decal_z(m, 1, z_front, -0.62, 0.62, 0.92, 1.62, "trim")
    for k in range(6):
        y = 0.98 + k * 0.11
        decal_z(m, 1, z_front, -0.58, 0.58, y, y + 0.04, "chrome", 0.02)
    for s in (1, -1):
        decal_z(m, 1, z_front, *sorted((s * 0.72, s * 1.12)), 1.0, 1.3, "headlight")
        decal_z(m, 1, z_front, *sorted((s * 0.72, s * 1.12)), 1.38, 1.6, "strobe_red_a" if s > 0 else "strobe_red_b")
        decal_z(m, 1, z_front, *sorted((s * 0.72, s * 1.12)), 1.66, 1.74, "strobe_white_b" if s > 0 else "strobe_white_a")
        decal_z(m, 1, z_front, *sorted((s * 1.14, s * 1.24)), 1.0, 1.3, "indicator")
    m.box(-w - 0.05, w + 0.05, 0.42, 0.78, z_front, z_front + 0.32, "chrome")
    lightbar(m, z_front - 0.62, z_front - 0.28, roof)
    # BFD in gold on the cab doors.
    side_text(m, w, "BFD", z_front - 0.7, 1.15, 0.05, "fire_gold")


def fire_body_details(m, z0, z1, top, compartments, rear_face=True):
    """Compartment doors, gold stripe, side and rear warning lights on the body box."""
    w = FIRE_HALF_W
    for s in (1, -1):
        for a, b in compartments:
            decal_x(m, s, w, a, b, 0.85, top - 0.15, "alu")
            for k in range(1, 6):  # roll-up door slats
                y = 0.85 + k * (top - 1.0) / 6
                decal_x(m, s, w, a + 0.04, b - 0.04, y, y + 0.02, "trim", 0.02)
        decal_x(m, s, w, z0 + 0.05, z1 - 0.05, top - 0.12, top - 0.06, "fire_gold")
        mid = (z0 + z1) / 2
        decal_x(m, s, w, mid - 0.12, mid + 0.12, 0.62, 0.76, "strobe_red_a" if s > 0 else "strobe_red_b", 0.03)
        decal_x(m, s, w, z0 + 0.06, z0 + 0.32, top - 0.32, top - 0.16, "strobe_red_b" if s > 0 else "strobe_red_a", 0.03)
    if rear_face:
        for s in (1, -1):
            decal_z(m, -1, z0, *sorted((s * 0.85, s * 1.2)), top - 0.42, top - 0.14, "strobe_red_a" if s > 0 else "strobe_red_b")
            decal_z(m, -1, z0, *sorted((s * 0.45, s * 0.8)), top - 0.42, top - 0.14, "strobe_amber_c")
            decal_z(m, -1, z0, *sorted((s * 0.85, s * 1.2)), 0.9, 1.2, "taillight")
        decal_z(m, -1, z0, -0.75, 0.75, 1.3, top - 0.6, "alu")


def build_fire_engine():
    """BFD pumper, ~10.2 m: crew cab, pump panel, three compartments a side, hose bed."""
    m = Mesh()
    zf, zr = 5.1, -5.1
    fire_cab(m, 2.1, zf)
    m.box(-1.0, 1.0, 0.32, 0.6, zr + 0.1, zf - 0.1, "under", skip=("+y",))
    # Pump panel between cab and body.
    m.box(-FIRE_HALF_W, FIRE_HALF_W, 0.55, 2.7, 1.25, 2.1, "fire_red")
    for s in (1, -1):
        decal_x(m, s, FIRE_HALF_W, 1.32, 2.03, 0.8, 2.5, "chrome")
        for k in range(3):
            decal_x(m, s, FIRE_HALF_W, 1.45 + k * 0.2, 1.57 + k * 0.2, 1.9, 2.02, "sign_black", 0.02)  # gauges
        m.cylinder_x(0, 1.0, 1.68, 0.12, *sorted((s * FIRE_HALF_W, s * (FIRE_HALF_W + 0.12))), 8, "chrome")  # intake
    # Body and hose bed.
    m.box(-FIRE_HALF_W, FIRE_HALF_W, 0.55, 2.62, zr, 1.25, "fire_red")
    m.box(-1.12, 1.12, 2.62, 2.78, zr + 0.1, 0.9, "hose")
    for k in range(5):
        x = -1.0 + k * 0.5
        m.box(x - 0.04, x + 0.04, 2.78, 2.8, zr + 0.15, 0.85, "under")
    m.box(-FIRE_HALF_W, FIRE_HALF_W, 2.62, 2.84, 0.9, 1.25, "fire_red")
    fire_body_details(m, zr, 1.25, 2.62, [(-4.9, -3.35), (-3.2, -1.55), (-1.4, 0.95)])
    m.box(-1.1, 1.1, 0.5, 0.62, zr - 0.35, zr, "alu")  # rear step
    fire_wheel(m, 3.35)
    fire_wheel(m, -2.6, dual=True)
    return m


def build_fire_ladder():
    """BFD rear-mount aerial ladder, ~12.8 m: cab, compartments, turntable at the rear and the
    ladder stack bedded forward over the cab."""
    m = Mesh()
    zf, zr = 6.4, -6.4
    fire_cab(m, 3.5, zf, roof=2.9)
    m.box(-1.0, 1.0, 0.32, 0.6, zr + 0.1, zf - 0.1, "under", skip=("+y",))
    top = 2.25
    m.box(-FIRE_HALF_W, FIRE_HALF_W, 0.55, top, zr, 3.5, "fire_red")
    fire_body_details(m, zr, 3.5, top, [(-6.2, -4.9), (-2.4, -0.6), (-0.45, 1.3), (1.45, 3.3)])
    # Outrigger jacks behind the rear axles and behind the cab.
    for z in (-4.6, 3.05):
        for s in (1, -1):
            m.box(*sorted((s * 1.05, s * 1.27)), 0.35, 1.0, z - 0.2, z + 0.2, "under")
            decal_x(m, s, 1.27, z - 0.2, z + 0.2, 0.42, 0.5, "strobe_amber_c", 0.01)
    # Turntable and pedestal.
    m.box(-1.05, 1.05, top, top + 0.22, -5.95, -4.15, "alu")
    m.box(-0.62, 0.62, top + 0.22, top + 0.62, -5.75, -4.6, "fire_red")
    m.box(-0.3, 0.3, top + 0.62, top + 0.82, -5.9, -5.35, "under")  # control pedestal
    # Ladder stack: three nested sections, rails and rungs, from the turntable over the cab.
    y0 = 2.98
    for inset, (z0, z1), material in ((0.0, (-6.1, 6.0), "alu"), (0.08, (-5.9, 6.3), "chrome"), (0.16, (-5.7, 6.6), "alu")):
        for s in (1, -1):
            x0, x1 = sorted((s * (0.7 - inset), s * (0.6 - inset)))
            m.box(x0, x1, y0 + inset * 0.6, y0 + 0.42 - inset * 0.6, z0, z1, material)
    z = -5.6
    while z < 6.4:
        m.box(-0.62, 0.62, y0 + 0.04, y0 + 0.1, z - 0.03, z + 0.03, "alu")
        z += 0.36
    m.box(-0.7, 0.7, y0 - 0.12, y0, -6.1, -4.9, "fire_red")  # heel pin housing
    m.beam((0.0, top + 0.6, -4.7), (0.0, y0, -3.3), 0.24, 0.18, "chrome")  # elevation cylinder
    m.box(-0.72, 0.72, 2.9, y0 - 0.02, 4.15, 4.4, "under")  # cradle over the cab
    m.box(-0.08, 0.08, top, y0, 3.0, 3.25, "under")
    # Ladder-tip lights.
    for s in (1, -1):
        m.box(*sorted((s * 0.56, s * 0.72)), y0 + 0.1, y0 + 0.26, 6.6, 6.68, "strobe_white_a" if s > 0 else "strobe_white_b")
    fire_wheel(m, 4.75)
    for zc in (-3.3, -4.7):
        fire_wheel(m, zc, dual=True)
    return m


def build_chief_suv():
    """District chief's SUV, ~5.3 m: red with a white roof, roof light bar, grille lights."""
    m = Mesh()
    w = 1.0
    zf, zr = 2.65, -2.65
    m.box(-w, w, 0.38, 1.12, zr, zf, "fire_red")
    m.box(-0.98, 0.98, 0.3, 0.42, zr + 0.3, zf - 0.3, "under")
    # Greenhouse: slanted windscreen, roof, side glass.
    zw0, zw1, yb, yt = 1.25, 0.55, 1.12, 1.85
    m.poly([(-0.95, yb, zw0), (0.95, yb, zw0), (0.92, yt, zw1), (-0.92, yt, zw1)], "glass", outward=(0, 0.6, 1))
    m.box(-0.95, 0.95, yb, yt - 0.05, zr, zw1, "glass", skip=("+z",))
    m.box(-0.96, 0.96, yt - 0.05, yt, zr + 0.02, zw1, "fire_white")
    for s in (1, -1):
        m.poly([(s * 0.95, yb, zw0), (s * 0.95, yb, zw1), (s * 0.92, yt, zw1)], "glass", outward=(s, 0, 0))
        for z in (-0.3, -1.6):  # pillars
            decal_x(m, s, 0.95, z - 0.06, z + 0.06, yb, yt - 0.05, "fire_red", 0.006)
        decal_x(m, s, w, -1.2, 0.9, 0.98, 1.04, "fire_gold")
        decal_x(m, s, w, 2.2, 2.5, 0.85, 0.98, "strobe_red_a" if s > 0 else "strobe_red_b", 0.02)
    side_text(m, w, "CHIEF", -0.3, 0.72, 0.035, "fire_gold")
    decal_z(m, 1, zf, -0.55, 0.55, 0.6, 0.95, "trim")
    for s in (1, -1):
        decal_z(m, 1, zf, *sorted((s * 0.6, s * 0.95)), 0.8, 0.98, "headlight")
        decal_z(m, 1, zf, *sorted((s * 0.12, s * 0.45)), 0.66, 0.78, "strobe_red_a" if s > 0 else "strobe_red_b", 0.02)
        decal_z(m, 1, zf, *sorted((s * 0.12, s * 0.45)), 0.8, 0.9, "strobe_white_b" if s > 0 else "strobe_white_a", 0.02)
        decal_z(m, -1, zr, *sorted((s * 0.7, s * 0.95)), 0.8, 1.05, "taillight")
        decal_z(m, -1, zr, *sorted((s * 0.3, s * 0.65)), 0.95, 1.05, "strobe_amber_c", 0.02)
    m.box(-w - 0.03, w + 0.03, 0.35, 0.55, zf, zf + 0.12, "trim")
    lightbar(m, 0.0, 0.32, yt, half_width=0.72, segments=6)
    for zc in (1.6, -1.6):
        for s in (1, -1):
            xo, xi = s * 1.0, s * 0.76
            m.cylinder_x(0, 0.4, zc, 0.4, min(xo, xi), max(xo, xi), 14, "tyre")
            m.cylinder_x(0, 0.4, zc, 0.24, *sorted((s * 1.0, s * 1.012)), 10, "hub", caps=("+x",) if s > 0 else ("-x",))
    return m


# --------------------------------------------------------------------------------------------
# GLB writer and checker
# --------------------------------------------------------------------------------------------

def pad4(data, fill):
    return data + fill * (-len(data) % 4)


# BU Shuttle ("the BUS") livery: red bodywork with a white band instead of MBTA yellow.
BU_LIVERY = {
    "body": mat("#CC0000", 0.15, 0.45),
    "roof": mat("#E8E8E8", 0.2, 0.55),
    "mbta_yellow": mat("#FFFFFF", 0.05, 0.5),
}


# BU Night shuttle: the same bus in the Night line's blue (BU's route map colour).
BU_NIGHT_LIVERY = {
    "body": mat("#1736D6", 0.15, 0.45),
    "roof": mat("#E8E8E8", 0.2, 0.55),
    "mbta_yellow": mat("#FFFFFF", 0.05, 0.5),
}


def write_glb(mesh, name, path, overrides=None):
    materials = {**MATERIALS, **(overrides or {})}
    gltf = {
        "asset": {"version": "2.0", "generator": "flowcast make_vehicle_models.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "meshes": [{"name": name, "primitives": []}],
        "materials": [],
        "accessors": [],
        "bufferViews": [],
        "buffers": [{"byteLength": 0}],
    }
    binary = bytearray()

    def view(data, target):
        nonlocal binary
        binary += b"\0" * (-len(binary) % 4)
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data), "target": target})
        binary += data
        return len(gltf["bufferViews"]) - 1

    for material in sorted(mesh.prims):
        pos, nrm, idx = mesh.prims[material]
        if not idx:
            continue
        gltf["materials"].append({"name": material, **materials[material]})
        flat_p = [c for p in pos for c in p]
        flat_n = [c for n in nrm for c in n]
        pv = view(struct.pack(f"<{len(flat_p)}f", *flat_p), 34962)
        nv = view(struct.pack(f"<{len(flat_n)}f", *flat_n), 34962)
        big = len(pos) > 65535
        iv = view(struct.pack(f"<{len(idx)}{'I' if big else 'H'}", *idx), 34963)
        mins = [min(p[a] for p in pos) for a in range(3)]
        maxs = [max(p[a] for p in pos) for a in range(3)]
        acc = gltf["accessors"]
        acc.append({"bufferView": pv, "componentType": 5126, "count": len(pos), "type": "VEC3",
                    "min": [round(v, 5) for v in mins], "max": [round(v, 5) for v in maxs]})
        acc.append({"bufferView": nv, "componentType": 5126, "count": len(nrm), "type": "VEC3"})
        acc.append({"bufferView": iv, "componentType": 5125 if big else 5123, "count": len(idx), "type": "SCALAR"})
        gltf["meshes"][0]["primitives"].append({
            "attributes": {"POSITION": len(acc) - 3, "NORMAL": len(acc) - 2},
            "indices": len(acc) - 1,
            "material": len(gltf["materials"]) - 1,
            "mode": 4,
        })
    binary = pad4(bytes(binary), b"\0")
    gltf["buffers"][0]["byteLength"] = len(binary)
    json_chunk = pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(out)


def check_glb(path):
    """Parse a GLB back and report size, triangles, bounds, and winding/normal consistency."""
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from("<III", raw, 0)
    assert magic == 0x46546C67 and version == 2 and total == len(raw)
    jlen = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20 : 20 + jlen])
    bin_off = 20 + jlen + 8
    assert "images" not in gltf and all("uri" not in b for b in gltf["buffers"])
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    tris = 0
    volume = 0.0
    bad = 0

    def read(acc_index):
        acc = gltf["accessors"][acc_index]
        bv = gltf["bufferViews"][acc["bufferView"]]
        fmt = {5126: "f", 5123: "H", 5125: "I"}[acc["componentType"]]
        comps = {"VEC3": 3, "SCALAR": 1}[acc["type"]]
        data = struct.unpack_from(f"<{acc['count'] * comps}{fmt}", raw, bin_off + bv["byteOffset"])
        return acc, [data[i : i + comps] for i in range(0, len(data), comps)] if comps > 1 else list(data)

    for prim in gltf["meshes"][0]["primitives"]:
        acc, pos = read(prim["attributes"]["POSITION"])
        _, nrm = read(prim["attributes"]["NORMAL"])
        _, idx = read(prim["indices"])
        for a in range(3):
            lo[a] = min(lo[a], acc["min"][a])
            hi[a] = max(hi[a], acc["max"][a])
        for i in range(0, len(idx), 3):
            p0, p1, p2 = (pos[idx[i + k]] for k in range(3))
            face = cross(sub(p1, p0), sub(p2, p0))
            if dot(face, nrm[idx[i]]) <= 0:
                bad += 1
            volume += dot(p0, cross(p1, p2)) / 6
        tris += len(idx) // 3
    size = [hi[a] - lo[a] for a in range(3)]
    print(f"{path.name}: {len(raw) / 1024:.1f} KB, {tris} triangles, {len(gltf['materials'])} materials")
    print(f"  bounds min {[round(v, 3) for v in lo]} max {[round(v, 3) for v in hi]}")
    print(f"  size  x(width) {size[0]:.2f}  y(height) {size[1]:.2f}  z(length) {size[2]:.2f}")
    print(f"  normals disagreeing with winding: {bad}; signed volume {volume:.1f} m^3 (positive = outward)")
    return gltf


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    models = {
        "mbta-green-line-train": (build_train(), None),
        "mbta-bus": (build_bus(), None),
        "bu-shuttle": (build_bus(sign_text="BU", mbta_roundel=False, side_text="BU"), BU_LIVERY),
        "bu-shuttle-night": (build_bus(sign_text="BU", mbta_roundel=False, side_text="BU"), BU_NIGHT_LIVERY),
        "bfd-engine": (build_fire_engine(), None),
        "bfd-ladder": (build_fire_ladder(), None),
        "bfd-chief": (build_chief_suv(), None),
    }
    only = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")]
    if only:
        models = {k: v for k, v in models.items() if k.startswith(only[0])}
    for name, (mesh, overrides) in models.items():
        path = OUT / f"{name}.glb"
        write_glb(mesh, name, path, overrides)
        print(f"wrote {path} ({mesh.triangle_count()} triangles)")
        if "--check" in sys.argv:
            check_glb(path)


if __name__ == "__main__":
    main()
