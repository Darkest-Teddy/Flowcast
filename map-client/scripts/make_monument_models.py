"""Generate low-poly models of BU's monuments and landmarks as self-contained GLBs, in the same
style as make_vehicle_models.py and make_street_models.py (whose Mesh, helpers and checker are
reused): standard library only, flat-shaded polygons, plain PBR colours, no textures (so no
KHR_texture_transform).

All models: metres at real scale, +Y up, the front faces +Z, origin on the ground at the anchor
point the map places (public/data/monuments.json); the map turns +Z toward each entry's bearing.
Shapes and proportions follow reference photos (cited in monuments.json and below).

free-at-last.glb
    Sergio Castillo's 1975 Martin Luther King Jr. memorial on Marsh Plaza: 50 Corten-steel doves,
    bent-plate chevrons, rising about 20 ft in a flock that flares out and leans as it climbs,
    on a square granite pedestal whose inscription faces +Z. Origin = centre of the pedestal.
    (Photos: Peter H. Dreyer, 1975, City of Boston Archives, on Wikimedia Commons.)
rhett-bench.glb
    Virgil Oertle's 2019 Rhett bench: a man-sized bronze Rhett in a BU jersey and spiked collar,
    legs crossed and arms along the back of a slatted bronze bench, sitting on its left end as
    seen from the front. Origin = centre of the bench on the paving; the bench faces +Z.
    (Photo: The Daily Free Press, Aug 2019.)
citgo-sign.glb
    The 60 ft (18.29 m) square, double-sided Citgo sign on its ~31 ft steel truss and catwalk.
    White enamel face with a thin dark outline and rounded corners, the trimark as a shallow
    three-facet pyramid and the blue CITGO wordmark, laid out from the official logo's geometry
    (Wikimedia Commons File:Citgo_logo.svg), and its unlit LED strips. Unlit by design: the map
    draws the LEDs from public/data/citgo-lights.json (also written by this script: border,
    39 white rows, 18 concentric trimark triangles, letter centre lines, after the Boston
    Landmarks Commission's 2018 study report) so it can switch and animate them. Origin = the
    roof under the centre of the frame (the map lifts it to the roof). Faces +Z and -Z.
agganis-statue.glb
    Armand LaMontagne's bronze "Golden Greek" (2004): Harry Agganis in his Terrier football
    uniform, left arm drawn back to throw, on a granite pedestal outside Agganis Arena. Origin =
    centre of the pedestal; the figure faces +Z.
bu-seal.glb
    Boston University's coat of arms set into Marsh Plaza in front of Marsh Chapel: a ~3.2 m disc
    of dark stone inlaid with verdigris bronze strips (border rings and lozenges, two scroll
    ribbons lettered BOSTON UNIVERSITY and LEARNING · VIRTUE · PIETY, the shield's outline) and
    the polished bronze floriated cross with three crowns. A few cm proud of the paving. Origin =
    centre; reads upright from +Z. (Photos: BU Today, "The Myths and Legends behind the BU Seal",
    2019; size and place from Esri World Imagery.)

    python3 map-client/scripts/make_monument_models.py           # write all five models + citgo-lights.json
    python3 map-client/scripts/make_monument_models.py --check   # also print bounds/tri counts
"""

import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_street_models import cylinder, flat  # noqa: E402  (shared helpers)
from make_vehicle_models import (  # noqa: E402  (shared geometry and checker)
    Mesh, add, check_glb, cross, norm, pad4, scale, srgb_to_linear, sub,
)

OUT = Path(__file__).resolve().parent.parent / "public" / "models"


# --------------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------------

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
    "corten": mat("#6A3218", 0.45, 0.75),          # weathered Corten steel: the doves
    "granite": mat("#B9B6AE", 0.0, 0.85),          # pale granite pedestal
    "granite_dark": mat("#8E8B84", 0.0, 0.85),
    "engraving": mat("#6E6A62", 0.0, 0.9),         # incised inscription lines
    "bronze": mat("#5A4029", 0.7, 0.45),           # dark statuary bronze patina
    "bronze_light": mat("#7A5A38", 0.8, 0.35),     # highlights: jersey lettering, claws
    "bronze_polished": mat("#A8834F", 0.85, 0.3),  # spots rubbed bright by hands
    "bronze_dark": mat("#21180F", 0.6, 0.5),       # eyes, nose leather
    "pavers": mat("#7E6A60", 0.0, 0.9),            # brick paving under the bench
    "sign_white": mat("#F4F4F0", 0.05, 0.5),
    "sign_outline": mat("#2A2C2E", 0.2, 0.5),
    "sign_side": mat("#2E3236", 0.4, 0.55),        # the sign box's sides (steel cladding)
    # The trimark's three facets (left, right, bottom) as they read on the Kenmore sign.
    # The painted (enamel) graphic, as it reads by day. The night lighting is not in the model:
    # the map draws the LED tubes (public/data/citgo-lights.json) so it can switch and animate them.
    "trimark_left": mat("#F04E2A", 0.0, 0.4),
    "trimark_right": mat("#D11F27", 0.0, 0.4),
    "trimark_bottom": mat("#EC3B42", 0.0, 0.4),
    "citgo_blue": mat("#1A6EC0", 0.0, 0.4),
    "citgo_neon": mat("#CFE6FF", 0.0, 0.3),        # LED strips down the letters
    "led_strip": mat("#D9DCDF", 0.2, 0.35),        # white LED strips across the face (unlit)
    "steel": mat("#4A4F55", 0.6, 0.5),             # rooftop frame, catwalks
    # The BU seal in Marsh Plaza: "black stone with bronze letters" (BU Today, 2019). The strips
    # have weathered to verdigris; the cross and crowns are kept polished.
    # Only a hint of metal and light base colours: lying flat, with no environment map to
    # reflect, metal reads near-black, and the map's noon light renders them at about 60%.
    "seal_stone": mat("#4E555E", 0.0, 0.5),
    "seal_stone_edge": mat("#30353B", 0.0, 0.7),
    "seal_verdigris": mat("#A6E3CE", 0.05, 0.35),
    "seal_bronze": mat("#F4D9A0", 0.08, 0.3),
    "seal_crown": mat("#FFD978", 0.1, 0.3),
}


# --------------------------------------------------------------------------------------------
# Extra geometry helpers (on top of Mesh.poly / box / beam and the street-model helpers)
# --------------------------------------------------------------------------------------------

def ellipsoid(m, c, r, material, seg=10, rings=6, basis=None):
    """A low-poly ellipsoid centred at c with radii r = (rx, ry, rz) along `basis` (default x/y/z)."""
    bx, by, bz = basis or ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))

    def pt(i, j):
        lat = math.pi * (j / rings - 0.5)
        lon = 2 * math.pi * i / seg
        x, y, z = r[0] * math.cos(lat) * math.cos(lon), r[1] * math.sin(lat), r[2] * math.cos(lat) * math.sin(lon)
        return add(c, add(add(scale(bx, x), scale(by, y)), scale(bz, z)))

    for j in range(rings):
        for i in range(seg):
            quad = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)]
            mid = scale(add(add(quad[0], quad[1]), add(quad[2], quad[3])), 0.25)
            m.poly(quad, material, outward=sub(mid, c))


def limb(m, a, b, ra, rb, material, joint=True):
    """A tapered limb segment with a rounded joint at its start."""
    cylinder(m, a, b, ra, material, r1=rb, seg=8, caps=(False, True))
    if joint:
        ellipsoid(m, a, (ra, ra, ra), material, seg=8, rings=4)


def prism_z(m, outline, z0, z1, side_mat, cap_mat=None):
    """A prism along Z over a convex (x, y) outline, capped at both ends."""
    cx = sum(x for x, _ in outline) / len(outline)
    cy = sum(y for _, y in outline) / len(outline)
    for i in range(len(outline)):
        j = (i + 1) % len(outline)
        (xa, ya), (xb, yb) = outline[i], outline[j]
        m.poly([(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)], side_mat,
               outward=((xa + xb) / 2 - cx, (ya + yb) / 2 - cy, 0.0))
    if cap_mat:
        m.poly([(x, y, z1) for x, y in outline], cap_mat, outward=(0.0, 0.0, 1.0))
        m.poly([(x, y, z0) for x, y in outline], cap_mat, outward=(0.0, 0.0, -1.0))


def rounded_rect(cx, cy, half, radius, seg=4):
    """A convex rounded square outline (CCW)."""
    pts = []
    for k, (sx, sy) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
        ox, oy = cx + sx * (half - radius), cy + sy * (half - radius)
        for i in range(seg + 1):
            a = math.pi / 2 * (k + i / seg)
            pts.append((ox + radius * math.cos(a), oy + radius * math.sin(a)))
    return pts


def ring_quads(cx, cy, rx0, ry0, rx1, ry1, a0, a1, seg):
    """Quads of an elliptical ring band between radii (rx0, ry0) inside and (rx1, ry1) outside,
    from angle a0 to a1 (degrees, counter-clockwise, y up)."""
    quads = []
    for i in range(seg):
        ta = math.radians(a0 + (a1 - a0) * i / seg)
        tb = math.radians(a0 + (a1 - a0) * (i + 1) / seg)
        quads.append([(cx + rx0 * math.cos(ta), cy + ry0 * math.sin(ta)), (cx + rx1 * math.cos(ta), cy + ry1 * math.sin(ta)),
                      (cx + rx1 * math.cos(tb), cy + ry1 * math.sin(tb)), (cx + rx0 * math.cos(tb), cy + ry0 * math.sin(tb))])
    return quads


class Frame:
    """An orthonormal frame (origin o; right s, up u, forward f) to place parts in."""

    def __init__(self, o, f, up_hint=(0.0, 1.0, 0.0)):
        self.o = o
        self.f = norm(f)
        self.s = norm(cross(up_hint, self.f))
        self.u = cross(self.f, self.s)

    def __call__(self, p):
        return add(self.o, add(add(scale(self.s, p[0]), scale(self.u, p[1])), scale(self.f, p[2])))


def plate(m, pts, material, thickness=0.02):
    """A flat convex plate given by its mid-surface points: both faces, slightly apart."""
    n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])))
    h = scale(n, thickness / 2)
    m.poly([add(p, h) for p in pts], material, outward=n)
    m.poly([sub(p, h) for p in pts], material, outward=scale(n, -1))


def rand(i, k=0):
    """Deterministic pseudo-random number in [0, 1) (stable models between runs)."""
    x = math.sin(i * 12.9898 + k * 78.233) * 43758.5453
    return x - math.floor(x)


# --------------------------------------------------------------------------------------------
# Free at Last (Marsh Plaza)
# --------------------------------------------------------------------------------------------

DOVES = 50
PEDESTAL = 1.5          # square granite block, about shoulder height (1975 photos)
PEDESTAL_HALF = 0.78
FLOCK_TOP = 6.1         # about 20 ft overall (BU: "about 20 ft tall")


def dove(m, fr, size):
    """One dove as Castillo cut them from Corten plate: an upward chevron. A short pointed head
    blade leads along +f; two long wing blades sweep back and out, bent once at the elbow, and a
    forked tail trails behind. The chevron lies in the (s, f) plane, so it reads from outside (+u)."""
    p = lambda x, y, z: fr((x * size, y * size, z * size))  # noqa: E731
    for side in (1, -1):
        root_f, root_b = p(0.0, 0.0, 0.14), p(0.0, 0.0, -0.06)
        elbow_f, elbow_b = p(side * 0.36, 0.10, -0.10), p(side * 0.34, 0.10, -0.30)
        tip = p(side * 0.74, 0.02 + 0.1 * rand(side, 3), -0.64)
        plate(m, [root_f, elbow_f, elbow_b, root_b], "corten", 0.03 * size)
        plate(m, [elbow_f, tip, elbow_b], "corten", 0.03 * size)
    plate(m, [p(-0.05, 0.0, 0.1), p(0.05, 0.0, 0.1), p(0.0, 0.02, 0.42)], "corten", 0.03 * size)
    plate(m, [p(0.0, 0.0, -0.02), p(0.1, -0.03, -0.40), p(0.0, -0.02, -0.28)], "corten", 0.03 * size)
    plate(m, [p(0.0, 0.0, -0.02), p(0.0, -0.02, -0.28), p(-0.1, -0.03, -0.40)], "corten", 0.03 * size)


def build_free_at_last():
    m = Mesh()
    h = PEDESTAL_HALF
    m.box(-h - 0.06, h + 0.06, 0.0, 0.08, -h - 0.06, h + 0.06, "granite_dark")   # plinth course
    m.box(-h, h, 0.08, PEDESTAL, -h, h, "granite")
    # The inscription on the front face ("To the memory of Martin Luther King, Jr. / 1929-1968 /
    # Distinguished alumnus / Nobel laureate for peace"), as five incised lines.
    for k, (w, y) in enumerate(((0.36, 1.27), (0.56, 1.17), (0.22, 1.08), (0.40, 0.96), (0.50, 0.87))):
        flat(m, "z", h + 0.004, [(-w, y), (w, y), (w, y + 0.035 + 0.01 * (k == 1)), (-w, y + 0.035 + 0.01 * (k == 1))],
             "engraving", 1)
    # 50 doves rising from a tight knot on the pedestal: the flock flares out to ~2.4 m around
    # half-way up, then gathers to a point, leaning as it climbs (the outline of one great dove
    # arching skyward, as BU describes it).
    y0 = PEDESTAL + 0.35
    for i in range(DOVES):
        t = (i + 0.5) / DOVES
        y = y0 + (FLOCK_TOP - 0.45 - y0) * t
        reach = 0.12 + 0.95 * math.sin(math.pi * t ** 0.8) * (1.0 - 0.3 * t)
        lean = 0.8 * t ** 1.5
        theta = i * 2.39996 + 0.4 * rand(i)   # golden-angle spiral, so no two stack up
        r = reach * (0.4 + 0.6 * math.sqrt(rand(i, 1)))
        pos = (lean + r * math.cos(theta), y, r * math.sin(theta) * 0.8)
        out = norm((math.cos(theta), 0.0, math.sin(theta)))
        # Climbing, tipped outward the further out a dove is, with a little scatter.
        f = norm(add((0.0, 1.0, 0.0), add(scale(out, 0.15 + 0.45 * r), (0.4 * (rand(i, 2) - 0.5), 0.0, 0.4 * (rand(i, 4) - 0.5)))))
        size = 0.9 + 0.35 * rand(i, 5) - 0.25 * t
        dove(m, Frame(pos, f, up_hint=out), size)
    # The doves are welded to one another; a few hidden struts carry the knot at the bottom.
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        cylinder(m, (0.0, PEDESTAL, 0.0), (0.35 * math.cos(a), PEDESTAL + 1.1, 0.3 * math.sin(a)), 0.05, "corten",
                 r1=0.035, seg=6)
    return m


# --------------------------------------------------------------------------------------------
# Rhett bench (between BU Beach and the Leventhal Center, facing away from the river)
# --------------------------------------------------------------------------------------------

BENCH_HALF = 1.15
SEAT_Y = 0.46
BACK_Z = -0.24
BACK_TOP = 0.95


def build_bench(m):
    m.box(-1.35, 1.35, 0.0, 0.03, -0.5, 0.75, "pavers")
    for s in (1, -1):  # end frames: legs, side rails and a scroll panel
        x = s * (BENCH_HALF - 0.05)
        m.box(x - 0.04, x + 0.04, 0.0, SEAT_Y, 0.16, 0.24, "bronze")
        m.box(x - 0.04, x + 0.04, 0.0, BACK_TOP, BACK_Z - 0.04, BACK_Z + 0.04, "bronze")
        m.box(x - 0.03, x + 0.03, SEAT_Y - 0.08, SEAT_Y - 0.02, BACK_Z, 0.24, "bronze")
        m.box(x - 0.03, x + 0.03, 0.08, 0.12, BACK_Z, 0.24, "bronze")
        cylinder(m, (x, 0.24, 0.0), (x + s * 0.01, 0.24, 0.0), 0.1, "bronze", seg=10)
    for k in range(6):  # seat slats along the bench
        z0 = BACK_Z + 0.03 + k * 0.08
        m.box(-BENCH_HALF, BENCH_HALF, SEAT_Y - 0.03, SEAT_Y, z0, z0 + 0.06, "bronze")
    m.box(-BENCH_HALF + 0.04, BENCH_HALF - 0.04, BACK_TOP - 0.06, BACK_TOP, BACK_Z - 0.03, BACK_Z + 0.03, "bronze")
    m.box(-BENCH_HALF + 0.04, BENCH_HALF - 0.04, SEAT_Y + 0.08, SEAT_Y + 0.12, BACK_Z - 0.03, BACK_Z + 0.03, "bronze")
    n = 22  # vertical back slats
    for k in range(n):
        x = -BENCH_HALF + 0.12 + k * (2 * BENCH_HALF - 0.24) / (n - 1)
        m.box(x - 0.022, x + 0.022, SEAT_Y + 0.12, BACK_TOP - 0.06, BACK_Z - 0.015, BACK_Z + 0.015, "bronze")


def build_rhett_bench():
    m = Mesh()
    build_bench(m)
    # Rhett sits on the bench's left end as you face it (-X), leaning back, his right leg crossed
    # over his left knee with the foot out toward -X, both arms stretched along the back.
    cx = -0.42
    ellipsoid(m, (cx, SEAT_Y + 0.12, -0.04), (0.25, 0.14, 0.21), "bronze")                  # hips
    jersey = Frame((cx, SEAT_Y + 0.50, -0.09), (0.0, 0.18, 1.0))                            # leaning back
    ellipsoid(m, jersey.o, (0.25, 0.34, 0.16), "bronze", basis=(jersey.s, jersey.u, jersey.f))
    ellipsoid(m, jersey((0.0, -0.2, 0.02)), (0.24, 0.1, 0.17), "bronze", basis=(jersey.s, jersey.u, jersey.f))  # hem
    # "BOSTON" across the chest, raised a touch and catching the light.
    for k in range(6):
        u = -0.15 + k * 0.06
        a = jersey((u - 0.017, 0.1, 0.153))
        b = jersey((u + 0.017, 0.1, 0.153))
        m.poly([a, b, add(b, scale(jersey.u, 0.06)), add(a, scale(jersey.u, 0.06))], "bronze_light", outward=jersey.f)
    neck = jersey((0.0, 0.33, 0.0))
    cylinder(m, neck, add(neck, (0.0, 0.07, 0.01)), 0.15, "bronze_dark", seg=12)            # spiked collar
    for k in range(8):
        a = 2 * math.pi * k / 8
        base = add(neck, (0.15 * math.cos(a), 0.035, 0.15 * math.sin(a)))
        cylinder(m, base, add(base, (0.07 * math.cos(a), 0.0, 0.07 * math.sin(a))), 0.025, "bronze_polished",
                 r1=0.002, seg=5, caps=(False, False))
    # A Boston Terrier's head, mascot-sized: broad skull, short pushed-in muzzle with heavy jowls,
    # a scowling brow, and upright ears set wide.
    head = add(neck, (0.0, 0.27, 0.03))
    ellipsoid(m, head, (0.26, 0.23, 0.22), "bronze", seg=12, rings=7)
    ellipsoid(m, add(head, (0.0, -0.1, 0.16)), (0.13, 0.09, 0.1), "bronze", seg=10)         # muzzle
    for s_ in (1, -1):
        ellipsoid(m, add(head, (s_ * 0.085, -0.13, 0.15)), (0.09, 0.075, 0.08), "bronze", seg=8)  # jowls
        ellipsoid(m, add(head, (s_ * 0.09, 0.04, 0.19)), (0.035, 0.025, 0.02), "bronze_dark", seg=8)  # eyes
        ellipsoid(m, add(head, (s_ * 0.09, 0.075, 0.19)), (0.08, 0.03, 0.05), "bronze", seg=8,     # brow
                  basis=((1.0, -0.35 * s_, 0.0), (0.35 * s_, 1.0, 0.0), (0.0, 0.0, 1.0)))
        ear = Frame(add(head, (s_ * 0.17, 0.21, -0.03)), (0.0, 0.0, 1.0), up_hint=(s_ * 0.35, 1.0, 0.0))
        ellipsoid(m, ear.o, (0.06, 0.12, 0.035), "bronze", seg=8, basis=(ear.s, ear.u, ear.f))  # ears
    ellipsoid(m, add(head, (0.0, -0.03, 0.26)), (0.06, 0.04, 0.035), "bronze_polished", seg=8)  # nose, rubbed
    # Arms along the bench back.
    sh_r, sh_l = jersey((-0.27, 0.22, -0.02)), jersey((0.27, 0.22, -0.02))
    for sh, elbow, hand in ((sh_r, (cx - 0.48, BACK_TOP + 0.05, BACK_Z - 0.02), (cx - 0.66, BACK_TOP - 0.02, BACK_Z + 0.06)),
                            (sh_l, (cx + 0.52, BACK_TOP + 0.06, BACK_Z - 0.02), (cx + 0.88, BACK_TOP - 0.02, BACK_Z + 0.06))):
        limb(m, sh, elbow, 0.09, 0.075, "bronze")
        limb(m, elbow, hand, 0.075, 0.06, "bronze")
        ellipsoid(m, hand, (0.08, 0.05, 0.1), "bronze", seg=8)                              # paw over the rail
    # Left leg (+X side) down to the paving; right leg crossed over it, foot out to -X.
    hip_l, hip_r = (cx + 0.13, SEAT_Y + 0.12, 0.0), (cx - 0.13, SEAT_Y + 0.14, 0.0)
    knee_l, foot_l = (cx + 0.10, SEAT_Y + 0.14, 0.44), (cx + 0.14, 0.09, 0.52)
    limb(m, hip_l, knee_l, 0.13, 0.11, "bronze")
    limb(m, knee_l, foot_l, 0.11, 0.08, "bronze")
    ellipsoid(m, add(foot_l, (0.0, -0.03, 0.09)), (0.1, 0.07, 0.15), "bronze", seg=8)
    knee_r, ankle_r = (cx + 0.02, SEAT_Y + 0.34, 0.42), (cx - 0.48, SEAT_Y + 0.22, 0.46)
    limb(m, hip_r, knee_r, 0.13, 0.11, "bronze")
    limb(m, knee_r, ankle_r, 0.11, 0.08, "bronze")
    ellipsoid(m, add(ankle_r, (-0.14, 0.0, 0.0)), (0.18, 0.1, 0.11), "bronze", seg=8)
    for k in range(3):  # claws on the crossed foot
        ellipsoid(m, add(ankle_r, (-0.31, 0.0, -0.05 + 0.05 * k)), (0.03, 0.025, 0.02), "bronze_light", seg=6, rings=4)
    return m


# --------------------------------------------------------------------------------------------
# Citgo sign (Kenmore Square)
# --------------------------------------------------------------------------------------------

SIGN = 18.29            # 60 ft square
SIGN_DEPTH = 2.0        # box between the two faces (its steel skeleton is inside)
# Boston Landmarks Commission study report (2018): "The steel framework is approximately 90 feet
# tall, holding the 60 foot square sign 40 feet above the rooftop" (the two figures disagree a
# little: 90 - 60 = 30 ft). Photos agree with ~30 ft to the underside of the sign.
FRAME_H = 9.5
PYRAMID = 0.9           # "a large equilateral triangle projects a few feet from the white surface
                        #  to form a shallow pyramid in three shades of red" (same report)
LIGHT_ROWS = 39         # "39 white horizontal lights" across the face (same report)
LIGHT_TRIANGLES = 18    # "18 equally spaced, concentric equilateral triangles"
TUBE_OFFSET = 0.08      # the lights sit this far in front of the face (behind their covers)

# The logo, in the units of Wikimedia Commons File:Citgo_logo.svg (y down). The trimark is an
# upward triangle split at an inner point into three facets; CITGO sits under it, as wide.
SVG_APEX, SVG_LEFT, SVG_RIGHT, SVG_INNER = (485.16, 644.99), (421.78, 746.46), (547.98, 746.46), (485.16, 712.12)
SVG_CX, SVG_CY = 484.88, 713.1                     # centre of the logo's bounding box
LOGO_SCALE = 0.77 * SIGN / (SVG_RIGHT[0] - SVG_LEFT[0])   # the triangle's base spans ~77% of the face
FACE_CENTRE = FRAME_H + SIGN / 2 + 0.1             # height of the logo's centre on the face


def svg_to_face(x, y, y_centre=FACE_CENTRE):
    return ((x - SVG_CX) * LOGO_SCALE, y_centre - (y - SVG_CY) * LOGO_SCALE)


def citgo_letters():
    """The CITGO wordmark as (material, convex polygon) pairs in SVG units, y down."""
    shapes = []

    def rect(x0, x1, y0, y1):
        return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]

    def ring(cx, cy, rx, ry, w, a0, a1, seg):
        # ring_quads works y-up; flip to SVG's y-down by negating the angles.
        return [[(x, 2 * cy - y) for x, y in q] for q in ring_quads(cx, cy, rx - w, ry - w, rx, ry, -a1, -a0, seg)]

    # C, open to the right; I; T; G with its crossbar; O.
    for q in ring(439.2, 767.05, 11.3, 13.45, 6.2, 38, 322, 14):
        shapes.append(("citgo_blue", q))
    shapes.append(("citgo_blue", rect(454.13, 461.55, 753.93, 779.99)))
    shapes.append(("citgo_blue", rect(463.73, 485.02, 753.93, 760.2)))
    shapes.append(("citgo_blue", rect(470.8, 478.22, 760.2, 780.07)))
    for q in ring(498.9, 767.0, 12.4, 13.5, 6.6, 0, 322, 15):
        shapes.append(("citgo_blue", q))
    shapes.append(("citgo_blue", rect(499.4, 511.3, 764.0, 769.8)))
    for q in ring(527.6, 767.3, 13.9, 13.9, 6.6, 0, 360, 18):
        shapes.append(("citgo_blue", q))
    # LED strips down the middle of each stroke.
    t = 1.0
    for q in ring(439.2, 767.05, 11.3 - 2.6, 13.45 - 2.6, t, 42, 318, 14):
        shapes.append(("citgo_neon", q))
    shapes.append(("citgo_neon", rect(457.34, 458.34, 756.5, 777.5)))
    shapes.append(("citgo_neon", rect(466.0, 482.8, 756.6, 757.6)))
    shapes.append(("citgo_neon", rect(474.0, 475.0, 757.6, 777.5)))
    for q in ring(498.9, 767.0, 12.4 - 2.8, 13.5 - 2.8, t, 4, 318, 15):
        shapes.append(("citgo_neon", q))
    shapes.append(("citgo_neon", rect(501.5, 508.6, 766.4, 767.4)))
    for q in ring(527.6, 767.3, 13.9 - 2.8, 13.9 - 2.8, t, 0, 360, 18):
        shapes.append(("citgo_neon", q))
    return shapes


def face_pt(x, y):
    return svg_to_face(x, y)


def citgo_light_geometry():
    """The sign's lights on the front face, in model metres: (u, v) = (x, y); `dz` is height in
    front of the face plane (the trimark tubes ride on its pyramid). The back face is the same
    turned 180 degrees about Y. Layout follows the Landmarks Commission's description."""
    half = SIGN / 2
    y0, y1 = FRAME_H, FRAME_H + SIGN
    apex, left, right, inner = (face_pt(*p) for p in (SVG_APEX, SVG_LEFT, SVG_RIGHT, SVG_INNER))
    r = lambda v: round(v, 3)  # noqa: E731

    # White border tube following the rounded perimeter.
    border = [[r(u), r(v)] for u, v in rounded_rect(0.0, y0 + half, half - 0.38, 0.75, 4)]
    border.append(border[0])

    # 18 concentric triangles on the pyramid: scaled about its peak, so each ring stays on the
    # three facets (left orange, bottom medium red, right dark red).
    triangles = []
    for k in range(LIGHT_TRIANGLES, 0, -1):  # outermost first
        s = (k - 0.35) / LIGHT_TRIANGLES
        dz = PYRAMID * (1 - s)

        def at(p):
            return [r(inner[0] + s * (p[0] - inner[0])), r(inner[1] + s * (p[1] - inner[1])), r(dz)]

        triangles.append({"left": [at(left), at(apex)], "bottom": [at(left), at(right)], "right": [at(apex), at(right)]})

    # Letter centre lines.
    def arc(cx, cy, rx, ry, a0, a1, seg):
        cu, cv = face_pt(cx, cy)
        out = []
        for i in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * i / seg)
            out.append([r(cu + rx * LOGO_SCALE * math.cos(a)), r(cv + ry * LOGO_SCALE * math.sin(a))])
        return out

    def line(*pts):
        return [[r(c) for c in face_pt(x, y)] for x, y in pts]

    g = arc(498.9, 767.0, 12.4 - 3.3, 13.5 - 3.3, 38, 360, 22)
    letters = [
        arc(439.2, 767.05, 11.3 - 3.1, 13.45 - 3.1, 38, 322, 20),
        line((457.84, 755.6), (457.84, 778.3)),
        line((464.6, 757.06), (484.2, 757.06)),
        line((474.51, 757.1), (474.51, 778.4)),
        g + [[r(c) for c in face_pt(501.0, 767.0)]],
        arc(527.6, 767.3, 13.9 - 3.3, 13.9 - 3.3, 0, 360, 24),
    ]

    # 39 white rows across the face, broken around the trimark and the letters.
    letter_boxes = []
    for poly in letters:
        us = [p[0] for p in poly]
        vs = [p[1] for p in poly]
        letter_boxes.append((min(us) - 0.75, max(us) + 0.75, min(vs) - 0.75, max(vs) + 0.75))
    rows = []
    inset = 0.75
    for i in range(LIGHT_ROWS):  # bottom to top
        v = y0 + inset + i * (SIGN - 2 * inset) / (LIGHT_ROWS - 1)
        # Width of the rounded field at this height.
        dv = max(0.0, abs(v - (y0 + half)) - (half - 1.6))
        w = half - 0.75 - (1.6 - math.sqrt(max(0.0, 1.6 ** 2 - dv ** 2)))
        blocks = []
        if left[1] - 0.45 <= v <= apex[1] + 0.45:
            t = min(1.0, max(0.0, (v - left[1]) / (apex[1] - left[1])))
            blocks.append((left[0] + (apex[0] - left[0]) * t - 0.7, right[0] + (apex[0] - right[0]) * t + 0.7))
        for u0, u1, v0, v1 in letter_boxes:
            if v0 <= v <= v1:
                blocks.append((u0, u1))
        segments, cur = [], -w
        for b0, b1 in sorted(blocks):
            if b0 > cur + 0.3:
                segments.append([r(cur), r(min(b0, w))])
            cur = max(cur, b1)
        if cur < w - 0.3:
            segments.append([r(cur), r(w)])
        rows.append({"v": r(v), "segments": segments})

    return {
        "about": "Citgo sign lights in model metres (see make_monument_models.py). Front face plane z = face; "
                 "points are [u, v] or [u, v, dz] with u = x, v = y; the back face is the front turned 180 degrees about Y.",
        "source": "Boston Landmarks Commission, Citgo Sign study report (2018), sections 2.2 and 9.5",
        "face": r(SIGN_DEPTH / 2 + TUBE_OFFSET),
        "centre": [0.0, r(y0 + half)],
        "trimarkCentre": [r((left[0] + right[0] + apex[0]) / 3), r((left[1] + right[1] + apex[1]) / 3)],
        "lettersCentre": [0.0, r(sum(p[1] for p in letters[1]) / 2)],
        "border": border,
        "rows": rows,
        "triangles": triangles,
        "letters": letters,
    }


def citgo_face(m, z, facing, y_centre):
    """Everything painted on one face, as decals stepping out toward `facing`, plus the trimark's
    shallow pyramid and the (unlit) LED strips."""
    step = 0.012

    def put(uv, material, layer):
        if facing < 0:  # seen from -Z the face is mirrored, so the logo still reads correctly
            uv = [(-u, v) for u, v in uv]
        flat(m, "z", z + facing * step * layer, uv, material, facing)

    half = SIGN / 2
    put(rounded_rect(0.0, y_centre, half - 0.30, 1.0, 5), "sign_outline", 1)  # thin dark keyline
    put(rounded_rect(0.0, y_centre, half - 0.45, 0.85, 5), "sign_white", 2)
    lights = citgo_light_geometry()
    sx = 1 if facing > 0 else -1
    for row in lights["rows"]:
        for u0, u1 in row["segments"]:
            put([(u0, row["v"] - 0.03), (u1, row["v"] - 0.03), (u1, row["v"] + 0.03), (u0, row["v"] + 0.03)], "led_strip", 3)
    # The trimark: three facets rising to a peak PYRAMID metres proud of the face.
    apex, left, right, inner = (svg_to_face(*p, y_centre) for p in (SVG_APEX, SVG_LEFT, SVG_RIGHT, SVG_INNER))
    zb = z + facing * step * 3
    peak = (sx * inner[0], inner[1], zb + facing * PYRAMID)
    for (a, b), material in (((left, apex), "trimark_left"), ((apex, right), "trimark_right"), ((left, right), "trimark_bottom")):
        m.poly([(sx * a[0], a[1], zb), (sx * b[0], b[1], zb), peak], material, outward=(0.0, 0.0, facing))
    for material, poly in citgo_letters():
        put([svg_to_face(x, y, y_centre) for x, y in poly], material, 3 if material == "citgo_blue" else 4)


def build_citgo_sign():
    m = Mesh()
    half, d = SIGN / 2, SIGN_DEPTH / 2
    y0 = FRAME_H
    yc = y0 + half
    # Rooftop truss: columns, girders in three tiers, X-braces in every bay, and a catwalk.
    xs = (-half + 1.2, -half / 3, half / 3, half - 1.2)
    zs = (-1.6, 1.6)
    tiers = (0.6, y0 / 2, y0 - 0.3)
    for x in xs:
        for z in zs:
            m.box(x - 0.17, x + 0.17, 0.0, y0, z - 0.17, z + 0.17, "steel")
    for z in zs:
        for yb in tiers:
            m.box(xs[0], xs[-1], yb - 0.15, yb + 0.15, z - 0.12, z + 0.12, "steel")
        for ya, yb in zip(tiers, tiers[1:]):
            for xa, xb in zip(xs, xs[1:]):
                m.beam((xa, ya, z), (xb, yb, z), 0.1, 0.1, "steel")
                m.beam((xb, ya, z), (xa, yb, z), 0.1, 0.1, "steel")
    for x in xs:
        for yb in tiers:
            m.box(x - 0.12, x + 0.12, yb - 0.15, yb + 0.15, zs[0], zs[1], "steel")
        for ya, yb in zip(tiers, tiers[1:]):
            m.beam((x, ya, zs[0]), (x, yb, zs[1]), 0.08, 0.08, "steel")
    walk_y = y0 - 2.4  # catwalk along the +Z side (2017 photo)
    m.box(-half - 0.4, half + 0.4, walk_y - 0.08, walk_y, d - 0.2, d + 1.0, "steel")
    m.box(-half - 0.4, half + 0.4, walk_y + 1.0, walk_y + 1.06, d + 0.95, d + 1.0, "steel")
    for k in range(13):
        x = -half - 0.4 + k * (SIGN + 0.8) / 12
        m.box(x - 0.03, x + 0.03, walk_y, walk_y + 1.06, d + 0.95, d + 1.0, "steel")
    # The sign box: rounded corners, dark steel sides, a white face on each side.
    prism_z(m, rounded_rect(0.0, yc, half, 1.1, 5), -d, d, "sign_side", cap_mat="sign_white")
    m.box(-half + 0.5, half - 0.5, y0 + SIGN, y0 + SIGN + 0.08, -0.5, 0.5, "steel")  # top catwalk
    for facing in (1, -1):
        citgo_face(m, facing * d, facing, FACE_CENTRE)
    return m


# --------------------------------------------------------------------------------------------
# "The Golden Greek": Harry Agganis statue (Agganis Arena)
# --------------------------------------------------------------------------------------------

def build_agganis_statue():
    m = Mesh()
    ped = 1.45
    m.box(-0.85, 0.85, 0.0, 0.25, -0.85, 0.85, "granite_dark")
    m.box(-0.65, 0.65, 0.25, ped - 0.08, -0.65, 0.65, "granite")
    m.box(-0.72, 0.72, ped - 0.08, ped, -0.72, 0.72, "granite_dark")
    flat(m, "z", 0.654, [(-0.42, 0.95), (0.42, 0.95), (0.42, 1.0), (-0.42, 1.0)], "engraving", 1)  # "always excel"
    y = ped
    P = lambda x, h, z: (x, y + h, z)  # noqa: E731  (heights above the pedestal)
    # A left-handed passer about to throw: right foot forward, weight on the back (left) foot,
    # shoulders turned, the ball drawn back behind his head, right arm out front. He faces +Z;
    # his left is +X.
    legs = (
        (P(-0.14, 0.0, 0.30), P(-0.13, 0.48, 0.22), P(-0.11, 0.93, 0.03)),   # right: foot, knee, hip
        (P(0.16, 0.0, -0.26), P(0.15, 0.47, -0.12), P(0.11, 0.93, -0.03)),   # left
    )
    for foot, knee, hip in legs:
        m.box(foot[0] - 0.055, foot[0] + 0.055, y, y + 0.09, foot[2] - 0.09, foot[2] + 0.17, "bronze_dark")  # cleat
        limb(m, add(foot, (0, 0.08, 0.02)), knee, 0.07, 0.085, "bronze", joint=False)      # socks
        limb(m, knee, hip, 0.105, 0.135, "bronze")                                         # pants, knee pad
    ellipsoid(m, P(0.0, 0.97, 0.0), (0.23, 0.15, 0.16), "bronze", seg=10)                 # hips
    tor = Frame(P(0.0, 1.26, -0.01), (-0.35, 0.0, 1.0))                                    # turned to his left
    ellipsoid(m, tor.o, (0.23, 0.29, 0.15), "bronze", basis=(tor.s, tor.u, tor.f))         # jersey
    ellipsoid(m, tor((0.0, 0.2, 0.0)), (0.33, 0.12, 0.19), "bronze", basis=(tor.s, tor.u, tor.f))  # shoulder pads
    flat_n = tor.f
    for u0, u1 in ((-0.1, -0.02), (0.02, 0.1)):  # number on the chest
        pts = [tor((u0, 0.0, 0.135)), tor((u1, 0.0, 0.135)), tor((u1, 0.14, 0.12)), tor((u0, 0.14, 0.12))]
        m.poly(pts, "bronze_light", outward=flat_n)
    sh_r, sh_l = tor((-0.27, 0.19, 0.0)), tor((0.27, 0.19, 0.0))
    arms = ((sh_l, P(0.44, 1.5, -0.2), P(0.36, 1.78, -0.3)),     # throwing arm, cocked back
            (sh_r, P(-0.36, 1.32, 0.24), P(-0.3, 1.38, 0.52)))   # leading arm
    for sh, elbow, hand in arms:
        limb(m, sh, elbow, 0.085, 0.07, "bronze")
        limb(m, elbow, hand, 0.07, 0.055, "bronze")
        ellipsoid(m, hand, (0.06, 0.07, 0.06), "bronze", seg=6, rings=4)
    ball = add(arms[0][2], (0.0, 0.06, 0.07))
    bf = Frame(ball, (0.0, 0.4, 1.0))
    ellipsoid(m, ball, (0.085, 0.085, 0.145), "bronze_polished", seg=8, basis=(bf.s, bf.u, bf.f))
    neck = P(0.0, 1.56, 0.0)
    cylinder(m, neck, add(neck, (0, 0.09, 0.01)), 0.065, "bronze", seg=8)
    head = P(0.0, 1.76, 0.02)
    ellipsoid(m, head, (0.1, 0.125, 0.115), "bronze", seg=10)
    ellipsoid(m, add(head, (0, 0.05, -0.015)), (0.106, 0.085, 0.118), "bronze_dark", seg=10, rings=4)  # hair
    return m


# --------------------------------------------------------------------------------------------
# The BU seal (coat of arms) set into Marsh Plaza
# --------------------------------------------------------------------------------------------

SEAL_R = 1.6            # ~3.2 m across (Esri World Imagery: 42-45 px at 7.5 cm/px; ~6.5 paving squares)
SEAL_TOP = 0.03         # the stone stands a few cm proud of the paving in the model, so it never sinks
SEAL_STEP = 0.006       # each inlay layer above the last (keeps the depth test clean)
SEAL_LINE = 0.016       # bronze strip width, in units of SEAL_R (about 2.5 cm)

# A stroke font for the inlaid capitals, on a 4 x 6 grid (x right, y up); each glyph is a list of
# polylines. The real letters are thin bronze strips, so strokes match them better than pixels.
SEAL_FONT = {
    "A": [[(0, 0), (2, 6), (4, 0)], [(0.8, 2.2), (3.2, 2.2)]],
    "B": [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    "E": [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    "G": [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2.6), (2.2, 2.6)]],
    "I": [[(0, 0), (0, 6)]],
    "L": [[(0, 6), (0, 0), (4, 0)]],
    "N": [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    "O": [[(1, 0), (3, 0), (4, 1), (4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0)]],
    "P": [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]],
    "R": [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(1.8, 3), (4, 0)]],
    "S": [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    "T": [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    "U": [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]],
    "V": [[(0, 6), (2, 0), (4, 6)]],
    "Y": [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]],
    " ": [],
    "·": [],  # drawn as a small diamond
}
SEAL_GLYPH_W = {"I": 0, " ": 2.0, "·": 1.0}  # glyph widths that aren't the usual 4


def seal_pt(u, v, h):
    """Design coordinates (in units of SEAL_R, v up = toward the chapel) to model metres. The
    seal faces +Z (the viewer stands south of it, on the Commonwealth Ave side), so design up is
    -Z and design right is +X."""
    return (u * SEAL_R, h, -v * SEAL_R)


def seal_poly(m, uv, material, layer):
    m.poly([seal_pt(u, v, SEAL_TOP + layer * SEAL_STEP) for u, v in uv], material, outward=(0.0, 1.0, 0.0))


def seal_dot(m, cu, cv, r, material, layer, seg=10):
    seal_poly(m, [(cu + r * math.cos(2 * math.pi * i / seg), cv + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)],
              material, layer)


def seal_strip(m, pts, width, material, layer, closed=False):
    """A bronze strip of the given width along a polyline (quads per segment, round-ish joints)."""
    pts = list(pts) + ([pts[0]] if closed else [])
    hw = width / 2
    for (ua, va), (ub, vb) in zip(pts, pts[1:]):
        du, dv = ub - ua, vb - va
        n = math.hypot(du, dv)
        if n < 1e-9:
            continue
        ou, ov = -dv / n * hw, du / n * hw
        seal_poly(m, [(ua + ou, va + ov), (ua - ou, va - ov), (ub - ou, vb - ov), (ub + ou, vb + ov)], material, layer)
    for u, v in pts[1:-1] if not closed else pts[:-1]:
        seal_dot(m, u, v, hw, material, layer, seg=6)


def seal_arc(r, a0, a1, seg):
    """Points on a circle of radius r from a0 to a1 (degrees, counter-clockwise from +u)."""
    return [(r * math.cos(math.radians(a0 + (a1 - a0) * i / seg)), r * math.sin(math.radians(a0 + (a1 - a0) * i / seg)))
            for i in range(seg + 1)]


def seal_ring(m, r0, r1, material, layer, seg=72):
    for q in ring_quads(0.0, 0.0, r0, r0, r1, r1, 0.0, 360.0, seg):
        seal_poly(m, q, material, layer)


def seal_text(m, text, r_base, centre_deg, span_deg, cap, material, layer, top=True):
    """Capitals around the seal, centred on `centre_deg` and spread over `span_deg`. Along the top
    the letters stand on r_base with their tops outward, read clockwise; along the bottom they hang
    from r_base with their tops toward the centre, read counter-clockwise (as on the seal)."""
    unit = cap / 6.0
    widths = [SEAL_GLYPH_W.get(ch, 4.0) for ch in text]
    gap = (math.radians(span_deg) * (r_base + (cap / 2 if top else -cap / 2)) / unit - sum(widths)) / max(1, len(text) - 1)
    total = sum(widths) + gap * (len(text) - 1)
    x = -total / 2
    for ch, w in zip(text, widths):
        xc = x + w / 2  # glyph centre along the line, in font units
        x += w + gap
        if ch == " ":
            continue
        r_mid = r_base + (cap / 2 if top else -cap / 2)
        theta = math.radians(centre_deg) + (-1 if top else 1) * xc * unit / r_mid
        radial = (math.cos(theta), math.sin(theta))
        tangent = (math.sin(theta), -math.cos(theta)) if top else (-math.sin(theta), math.cos(theta))
        up = radial if top else (-radial[0], -radial[1])

        def at(gx, gy):
            s, t = (gx - w / 2) * unit, gy * unit
            return (r_base * radial[0] + s * tangent[0] + t * up[0], r_base * radial[1] + s * tangent[1] + t * up[1])

        if ch == "·":
            c = at(w / 2, 3)
            d = 0.75 * unit
            seal_poly(m, [(c[0] + d * up[0], c[1] + d * up[1]), (c[0] + d * tangent[0], c[1] + d * tangent[1]),
                          (c[0] - d * up[0], c[1] - d * up[1]), (c[0] - d * tangent[0], c[1] - d * tangent[1])], material, layer)
            continue
        for line in SEAL_FONT[ch]:
            seal_strip(m, [at(gx, gy) for gx, gy in line], 0.75 * unit, material, layer)


def seal_ribbon(m, a0, a1, r0, r1, tail_dir, material, layer):
    """A scroll ribbon outlined in bronze: a band between radii r0 and r1 from a0 to a1 (degrees,
    counter-clockwise), whose two ends fold back and roll up. tail_dir = -1 rolls the ends toward
    the centre of the seal (top ribbon, hanging down), +1 away from it (bottom ribbon, curling up)."""
    w = SEAL_LINE
    seal_strip(m, seal_arc(r1, a0, a1, 40), w, material, layer)
    seal_strip(m, seal_arc(r0, a0, a1, 40), w, material, layer)
    for a, away in ((a0, -1), (a1, 1)):  # `away`: the direction (in angle) beyond the band's end
        ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
        seal_strip(m, [(r0 * ca, r0 * sa), (r1 * ca, r1 * sa)], w, material, layer)
        # The fold: a short tail of ribbon beyond the end, dropped by a third of the band.
        shift = tail_dir * (r1 - r0) * 0.3
        t0, t1 = r0 + shift, r0 + shift + (r1 - r0) * 0.7
        b = a + away * 10
        seal_strip(m, seal_arc(t1, a, b, 5), w, material, layer)
        seal_strip(m, seal_arc(t0, a, b, 5), w, material, layer)
        # The rolled end: a small round roll at the tail's tip.
        cb, sb = math.cos(math.radians(b)), math.sin(math.radians(b))
        rc = (t1 - t0) / 2
        cu, cv = (t0 + rc) * cb, (t0 + rc) * sb
        seal_strip(m, [(cu + rc * math.cos(2 * math.pi * k / 12), cv + rc * math.sin(2 * math.pi * k / 12)) for k in range(12)],
                   w, material, layer, closed=True)


def seal_crown(m, cu, cv, width, material, layer, groove="seal_stone_edge"):
    """A heraldic crown: a band with five points, the outer and inner ones tipped with pearls. It
    lies on the bronze cross, so (as on the seal) a dark groove around every piece sets it off."""
    hw = width / 2
    band = 0.034
    polys = [[(cu - hw, cv), (cu + hw, cv), (cu + hw * 0.92, cv + band), (cu - hw * 0.92, cv + band)]]
    for k, (du, height, base) in enumerate(((0.0, 0.085, 0.05), (-0.055, 0.05, 0.034), (0.055, 0.05, 0.034),
                                           (-hw + 0.012, 0.062, 0.03), (hw - 0.012, 0.062, 0.03))):
        u = cu + du
        lean = 0.0 if k < 3 else (-0.012 if du < 0 else 0.012)  # outer points splay out
        tip = (u + lean, cv + band + height)
        polys.append([(u - base / 2, cv + band - 0.002), (u + base / 2, cv + band - 0.002), tip])
        if k:  # pearls
            polys.append([(tip[0] + 0.015 * math.cos(2 * math.pi * i / 8), tip[1] + 0.008 + 0.015 * math.sin(2 * math.pi * i / 8))
                          for i in range(8)])
    # The centre point is a fleur: a lozenge head on its spike.
    polys.append([(cu, cv + band + 0.062), (cu + 0.026, cv + band + 0.088), (cu, cv + band + 0.118), (cu - 0.026, cv + band + 0.088)])
    grow = 0.013
    for pts in polys:
        mu, mv = sum(u for u, _ in pts) / len(pts), sum(v for _, v in pts) / len(pts)
        out = []
        for u, v in pts:
            d = math.hypot(u - mu, v - mv) or 1.0
            out.append((u + (u - mu) / d * grow, v + (v - mv) / d * grow))
        seal_poly(m, out, groove, layer)
    for pts in polys:
        seal_poly(m, pts, material, layer + 1)


def seal_cross_end(m, cu, cv, du, dv, material, layer):
    """A floriated end of the cross: the limb flares into a broad tip with a lobe either side and a
    point in the middle. (du, dv) is the unit direction out along the limb, (cu, cv) the tip."""
    pu, pv = -dv, du  # across the limb
    hw0, hw1, flare = 0.062, 0.11, 0.1
    a = (cu - du * flare + pu * hw0, cv - dv * flare + pv * hw0)
    b = (cu - du * flare - pu * hw0, cv - dv * flare - pv * hw0)
    c = (cu - pu * hw1, cv - pv * hw1)
    d = (cu + pu * hw1, cv + pv * hw1)
    seal_poly(m, [a, b, c, d], material, layer)
    for s in (1, -1):  # lobes curling back at the corners
        seal_dot(m, cu - du * 0.012 + s * pu * (hw1 - 0.018), cv - dv * 0.012 + s * pv * (hw1 - 0.018), 0.034, material, layer)
    seal_poly(m, [(cu + pu * 0.045, cv + pv * 0.045), (cu + du * 0.05, cv + dv * 0.05), (cu - pu * 0.045, cv - pv * 0.045)],
              material, layer)


def build_bu_seal():
    """Boston University's coat of arms as inlaid in Marsh Plaza: a disc of dark granite with
    verdigris bronze strips (two border rings with 20 lozenges between them, a scroll ribbon over
    the top reading BOSTON UNIVERSITY and one below reading LEARNING · VIRTUE · PIETY, and the
    outline of the shield) and, on the shield, the floriated cross in polished bronze with the
    three crowns. Layout from the BU Today photos (2019) of the inlay. Origin = centre, on the
    paving; the design reads upright from +Z (the Commonwealth Ave side), its top toward -Z."""
    m = Mesh()
    cylinder(m, (0.0, 0.0, 0.0), (0.0, SEAL_TOP, 0.0), SEAL_R, "seal_stone_edge", seg=72, caps=(False, False))
    seal_poly(m, seal_arc(1.0, 0.0, 360.0, 72)[:-1], "seal_stone", 0)

    green, bright, crown = "seal_verdigris", "seal_bronze", "seal_crown"
    # Border: two rings and 20 lozenges between them.
    seal_ring(m, 0.958, 0.976, green, 1)
    seal_ring(m, 0.886, 0.902, green, 1)
    for k in range(20):
        a = math.radians(90 + 18 * k)
        cu, cv = 0.93 * math.cos(a), 0.93 * math.sin(a)
        ru, rv, tu, tv = math.cos(a), math.sin(a), -math.sin(a), math.cos(a)
        d, e = 0.02, 0.016
        seal_poly(m, [(cu + ru * d, cv + rv * d), (cu + tu * e, cv + tv * e), (cu - ru * d, cv - rv * d), (cu - tu * e, cv - tv * e)],
                  green, 1)

    # The scroll ribbons and their lettering.
    seal_ribbon(m, 30, 150, 0.665, 0.845, -1, green, 1)
    seal_ribbon(m, 197, 343, 0.665, 0.845, -1, green, 1)
    seal_text(m, "BOSTON UNIVERSITY", 0.7, 90, 96, 0.105, green, 1, top=True)
    seal_text(m, "LEARNING · VIRTUE · PIETY", 0.81, 270, 124, 0.105, green, 1, top=False)

    # The shield: a flat top, straight sides, and curves meeting in a point at the bottom.
    hw, top, shoulder, tip = 0.41, 0.5, -0.08, -0.64
    side = [(hw, top), (hw, shoulder)]
    for i in range(1, 11):  # each lower edge is a quarter-ellipse-ish curve to the point
        t = i / 10
        side.append((hw * math.cos(t * math.pi / 2) ** 0.9, shoulder + (tip - shoulder) * math.sin(t * math.pi / 2)))
    outline = [(-hw, top)] + side + [(-u, v) for u, v in reversed(side[1:-1])]
    seal_strip(m, outline, SEAL_LINE, green, 1, closed=True)

    # The floriated cross, in polished bronze: the upright and the arms, each end flared.
    bar = 0.062
    arm_v, arm_u, top_v, foot_v = 0.2, 0.37, 0.47, -0.47
    seal_poly(m, [(-bar, foot_v + 0.09), (bar, foot_v + 0.09), (bar, top_v - 0.09), (-bar, top_v - 0.09)], bright, 2)
    seal_poly(m, [(-arm_u + 0.09, arm_v - bar), (arm_u - 0.09, arm_v - bar), (arm_u - 0.09, arm_v + bar), (-arm_u + 0.09, arm_v + bar)],
              bright, 2)
    seal_cross_end(m, 0.0, top_v, 0.0, 1.0, bright, 2)
    seal_cross_end(m, 0.0, foot_v, 0.0, -1.0, bright, 2)
    seal_cross_end(m, arm_u, arm_v, 1.0, 0.0, bright, 2)
    seal_cross_end(m, -arm_u, arm_v, -1.0, 0.0, bright, 2)
    # The three crowns: on the upper limb, over the crossing, and on the lower limb.
    for cv in (0.29, 0.07, -0.29):
        seal_crown(m, 0.0, cv, 0.21, crown, 3)
    return m


# --------------------------------------------------------------------------------------------
# GLB writer (as in make_vehicle_models.py, with this file's materials)
# --------------------------------------------------------------------------------------------

def write_glb(mesh, name, path):
    gltf = {
        "asset": {"version": "2.0", "generator": "flowcast make_monument_models.py"},
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
        gltf["materials"].append({"name": material, **MATERIALS[material]})
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


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    models = {
        "free-at-last": build_free_at_last(),
        "rhett-bench": build_rhett_bench(),
        "citgo-sign": build_citgo_sign(),
        "agganis-statue": build_agganis_statue(),
        "bu-seal": build_bu_seal(),
    }
    lights = OUT.parent / "data" / "citgo-lights.json"
    lights.write_text(json.dumps(citgo_light_geometry(), separators=(",", ":")) + "\n")
    print(f"wrote {lights}")
    for name, mesh in models.items():
        path = OUT / f"{name}.glb"
        write_glb(mesh, name, path)
        print(f"wrote {path} ({mesh.triangle_count()} triangles)")
        if "--check" in sys.argv:
            check_glb(path)


if __name__ == "__main__":
    main()
