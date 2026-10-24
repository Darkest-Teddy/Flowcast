"""Generate Bluebikes models: the bike alone and with a Kenney Mini Character riding it.

Standard library only; reuses the mesh helpers of make_vehicle_models.py. Same conventions as
the vehicles: metres at real scale, +Y up, the bike's front faces +Z, origin on the ground at
the centre of the wheelbase (tyres touch y = 0). The drivetrain is on the bike's right, -X.

The look follows photos of the Lyft-built Bluebikes: a sturdy step-through frame in Bluebikes
blue, a front carrier with the BLUEbikes logo panel, a big navy sponsor skirt over the rear
wheel, black fenders and a fully enclosed black chain guard, upright swept-back handlebars and
a silver seat post. The e-bike adds a battery on the down tube, a front hub motor and a
handlebar display.

Every bike file has one clip, 'ride': the wheels spin (two turns a pedal stroke, ~17 km/h) and
the cranks turn. The cyclist files add a seated Kenney character whose legs follow the pedals,
with a slight rock and bob. deck.gl's ScenegraphLayer animates nodes but does not do glTF
skinning, so the character's skinned mesh is cut into rigid parts hung on its joints (the Kenney
weights are all 1.0, so this is exact).

To keep draw calls down (every primitive is a draw per layer), the bike's colours come from a
tiny palette texture, so each moving part is one primitive; the rider uses Kenney's colormap.
No KHR_texture_transform.

    python3 map-client/scripts/make_bike_models.py           # write every model
    python3 map-client/scripts/make_bike_models.py --check   # also print sizes and bounds
"""

import json
import math
import struct
import sys
import zlib

import make_vehicle_models as vm
from make_vehicle_models import OUT, Mesh, add, cross, dot, norm, pad4, scale, sub, text_rects

# --------------------------------------------------------------------------------------------
# Palette (sRGB, sampled from photos of the bikes and the Bluebikes logo)
# --------------------------------------------------------------------------------------------

PALETTE = {
    "frame": "#1A8BCB",      # Bluebikes blue (frames photograph at #198BC2..#2F8BC1)
    "logo_blue": "#2CA4E0",  # the "BLUE" of the logo
    "navy": "#1F3A7A",       # sponsor skirt and logo panel
    "white": "#F2F4F6",
    "orange": "#F7941D",     # the logo's dot, skirt accents, spoke reflectors
    "black": "#1C1E22",      # fenders, chain guard, carrier, saddle, grips, pedals
    "tyre": "#202124",
    "silver": "#C9CED3",     # rims, spokes, hubs, seat post
    "red": "#D3202B",        # rear light
    "battery": "#3B414A",    # e-bike battery and hub motor
    "lamp": "#FFF6D8",
}
CELL = 4  # pixels per palette cell; sampled at cell centres with NEAREST filtering
PALETTE_NAMES = list(PALETTE)

# Kenney characters on the bikes, one model per layer (classic bikes, then e-bikes).
CLASSIC_RIDERS = ["female-b", "male-a", "female-c"]
ELECTRIC_RIDERS = ["male-f", "female-e", "male-b"]

# Metres per Kenney unit. The walkers use 2.3 (1.8 m tall standing), but at that size the big
# chibi head dwarfs a real-size bike; at 1.7 the rider's head tops out at about a walker's
# head height, as a real cyclist's does.
RIDER_SCALE = 1.7
LEG_STRETCH = 1.6  # the chibi legs, lengthened a little towards the pedals

# --------------------------------------------------------------------------------------------
# Bike geometry (metres)
# --------------------------------------------------------------------------------------------

WHEEL_R = 0.33           # 26" wheel, outer tyre radius
AXLE_Y = WHEEL_R
FRONT_Z = 0.555
REAR_Z = -0.555
BB = (0.0, 0.28, -0.07)  # bottom bracket (x, y, z)
CRANK = 0.17
HEAD_TOP = (0.0, 0.95, 0.395)
HEAD_BOT = (0.0, 0.70, 0.47)
SEAT_CLUSTER = (0.0, 0.80, -0.27)
SADDLE = (0.0, 0.93, -0.33)  # top of the saddle, at the rider's sit bones
GRIP = (0.27, 1.06, 0.20)    # left grip centre; right is mirrored

CLIP_SECONDS = 0.9   # one pedal stroke (~67 rpm)
WHEEL_TURNS = 2      # per stroke: 2 x 2.07 m / 0.9 s = 4.6 m/s
KEYS = 16


def tube(m, pts, r, material, sides=6, caps=True):
    """A polygonal tube through `pts` with rings shared at the joints (parallel transport)."""
    n = len(pts)
    tangents = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tangents.append(norm(sub(b, a)))
    ref = (1.0, 0.0, 0.0) if abs(tangents[0][0]) < 0.9 else (0.0, 1.0, 0.0)
    u = norm(cross(tangents[0], ref))
    rings = []
    for i, (p, t) in enumerate(zip(pts, tangents)):
        u = norm(sub(u, scale(t, dot(u, t))))  # transport the frame along the tube
        v = cross(t, u)
        rings.append([add(p, add(scale(u, r * math.cos(2 * math.pi * k / sides)), scale(v, r * math.sin(2 * math.pi * k / sides))))
                      for k in range(sides)])
    for i in range(n - 1):
        c = scale(add(pts[i], pts[i + 1]), 0.5)
        for k in range(sides):
            k2 = (k + 1) % sides
            quad = [rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]]
            fc = scale(add(add(quad[0], quad[1]), add(quad[2], quad[3])), 0.25)
            m.poly(quad, material, outward=sub(fc, c))
    if caps:
        m.poly(rings[0], material, outward=scale(tangents[0], -1))
        m.poly(rings[-1], material, outward=tangents[-1])


def mirror_x(p):
    return (-p[0], p[1], p[2])


def zy(cz, cy, r, a_deg):
    a = math.radians(a_deg)
    return (cz + r * math.cos(a), cy + r * math.sin(a))


def arc_band(m, cz, cy, r0, r1, a0, a1, x0, x1, material, seg=None, ends=True, inner=True, outer=True):
    """A curved slab: the annulus sector r0..r1, a0..a1 (degrees, 0 = +Z, 90 = up) about the
    axis (x, cy, cz), extruded over x0..x1. Full circles (a1 - a0 = 360) get no end caps."""
    seg = seg or max(2, int(abs(a1 - a0) / 12))
    full = abs(abs(a1 - a0) - 360) < 1e-6
    angles = [a0 + (a1 - a0) * i / seg for i in range(seg + 1)]
    for i in range(seg):
        (za0, ya0), (za1, ya1) = zy(cz, cy, r1, angles[i]), zy(cz, cy, r1, angles[i + 1])
        (zb0, yb0), (zb1, yb1) = zy(cz, cy, r0, angles[i]), zy(cz, cy, r0, angles[i + 1])
        mid = math.radians((angles[i] + angles[i + 1]) / 2)
        radial = (0.0, math.sin(mid), math.cos(mid))
        if outer:
            m.poly([(x0, ya0, za0), (x1, ya0, za0), (x1, ya1, za1), (x0, ya1, za1)], material, outward=radial)
        if r0 > 1e-6 and inner:
            m.poly([(x0, yb0, zb0), (x1, yb0, zb0), (x1, yb1, zb1), (x0, yb1, zb1)], material, outward=scale(radial, -1))
        for x, s in ((x0, -1.0), (x1, 1.0)):
            if r0 > 1e-6:
                m.poly([(x, ya0, za0), (x, ya1, za1), (x, yb1, zb1), (x, yb0, zb0)], material, outward=(s, 0.0, 0.0))
            else:
                m.poly([(x, ya0, za0), (x, ya1, za1), (x, cy, cz)], material, outward=(s, 0.0, 0.0))
    if ends and not full:
        for a, s in ((angles[0], -1.0), (angles[-1], 1.0)):
            (za, ya), (zb, yb) = zy(cz, cy, r1, a), zy(cz, cy, r0, a)
            t = math.radians(a)
            tangent = (0.0, math.cos(t) * s, -math.sin(t) * s)
            m.poly([(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], material, outward=tangent)


def flat_sector(m, cz, cy, r0, r1, a0, a1, x, material, seg, facing):
    """A flat annulus sector on the plane x (the materials are double-sided)."""
    angles = [a0 + (a1 - a0) * i / seg for i in range(seg + 1)]
    for a, b in zip(angles, angles[1:]):
        (za0, ya0), (za1, ya1) = zy(cz, cy, r1, a), zy(cz, cy, r1, b)
        (zb0, yb0), (zb1, yb1) = zy(cz, cy, r0, a), zy(cz, cy, r0, b)
        m.poly([(x, ya0, za0), (x, ya1, za1), (x, yb1, zb1), (x, yb0, zb0)], material, outward=(facing, 0.0, 0.0))


def prism_x(m, outline_zy, x0, x1, material):
    """A slab with a convex (z, y) outline, between x0 and x1."""
    pts0 = [(x0, y, z) for z, y in outline_zy]
    pts1 = [(x1, y, z) for z, y in outline_zy]
    m.poly(pts0, material, outward=(-1.0, 0.0, 0.0))
    m.poly(pts1, material, outward=(1.0, 0.0, 0.0))
    cz = sum(z for z, _ in outline_zy) / len(outline_zy)
    cy = sum(y for _, y in outline_zy) / len(outline_zy)
    for i in range(len(outline_zy)):
        (za, ya), (zb, yb) = outline_zy[i], outline_zy[(i + 1) % len(outline_zy)]
        out = (0.0, (ya + yb) / 2 - cy, (za + zb) / 2 - cz)
        m.poly([(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], material, outward=out)


def prism_y(m, outline_xz, y0, y1, material, top_lift=None):
    """A slab with a convex (x, z) outline between y0 and y1; top_lift(x, z) raises top vertices."""
    lift = top_lift or (lambda x, z: 0.0)
    bot = [(x, y0, z) for x, z in outline_xz]
    top = [(x, y1 + lift(x, z), z) for x, z in outline_xz]
    m.poly(bot, material, outward=(0.0, -1.0, 0.0))
    m.poly(top, material, outward=(0.0, 1.0, 0.0))
    cx = sum(x for x, _ in outline_xz) / len(outline_xz)
    cz = sum(z for _, z in outline_xz) / len(outline_xz)
    for i in range(len(outline_xz)):
        j = (i + 1) % len(outline_xz)
        out = ((outline_xz[i][0] + outline_xz[j][0]) / 2 - cx, 0.0, (outline_xz[i][1] + outline_xz[j][1]) / 2 - cz)
        m.poly([bot[i], bot[j], top[j], top[i]], material, outward=out)


def circle_zy(cz, cy, r, a0, a1, seg):
    return [zy(cz, cy, r, a0 + (a1 - a0) * i / seg) for i in range(seg + 1)]


def bezier(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3
        out.append(tuple(a * p0[k] + b * p1[k] + c * p2[k] + d * p3[k] for k in range(3)))
    return out


# --------------------------------------------------------------------------------------------
# Bike parts
# --------------------------------------------------------------------------------------------

def build_wheel(front, electric):
    """A wheel centred on its hub (local origin), spinning about X."""
    m = Mesh()
    arc_band(m, 0.0, 0.0, 0.288, WHEEL_R, 0, 360, -0.024, 0.024, "tyre", seg=20, inner=False)
    arc_band(m, 0.0, 0.0, 0.262, 0.289, 0, 360, -0.013, 0.013, "silver", seg=20, outer=False)
    if front and electric:
        hub_r, hub_w, hub_mat = 0.075, 0.055, "battery"  # front hub motor
    elif front:
        hub_r, hub_w, hub_mat = 0.03, 0.045, "silver"
    else:
        hub_r, hub_w, hub_mat = 0.055, 0.05, "silver"  # internal-gear hub
    m.cylinder_x(0.0, 0.0, 0.0, hub_r, -hub_w, hub_w, 10, hub_mat)
    spokes = 16
    for i in range(spokes):
        a = 2 * math.pi * (i + 0.5) / spokes
        side = 1 if i % 2 else -1
        p0 = (side * hub_w * 0.8, hub_r * 0.85 * math.sin(a), hub_r * 0.85 * math.cos(a + 0.35 * side))
        p1 = (0.0, 0.266 * math.sin(a), 0.266 * math.cos(a))
        # A flat strip in the wheel's plane (double-sided material): 2 triangles a spoke.
        side_v = norm(cross(sub(p1, p0), (1.0, 0.0, 0.0)))
        hw = scale(side_v, 0.004)
        m.poly([sub(p0, hw), add(p0, hw), add(p1, hw), sub(p1, hw)], "silver")
    # A spoke reflector, so the spin reads even when the spokes don't.
    m.box(-0.012, 0.012, 0.15, 0.215, -0.02, 0.02, "orange")
    return m


def build_crank():
    """Chainring, crank arms and pedals about the bottom bracket (local origin), turning about X."""
    m = Mesh()
    m.cylinder_x(0.0, 0.0, 0.0, 0.025, -0.11, 0.11, 8, "silver")
    for side, angle in ((-1, 0.0), (1, math.pi)):
        x = side * 0.105
        tip = (x, CRANK * math.sin(angle), CRANK * math.cos(angle))
        m.beam((x, 0.0, 0.0), tip, 0.03, 0.018, "silver")
        px0, px1 = sorted((x + side * 0.015, x + side * 0.115))
        m.box(px0, px1, tip[1] - 0.014, tip[1] + 0.014, tip[2] - 0.045, tip[2] + 0.045, "black")
    return m


def logo_text(m, x_centre, y_centre, z, pixel):
    """'BLUEbikes' as pixel text on a +Z-facing panel: BLUE light blue, BIKES white."""
    left = -26.5 * pixel
    for text, centre, material in (("BLUE", left + 11.5 * pixel, "logo_blue"), ("BIKES", left + 38.5 * pixel, "white")):
        for x0, x1, y0, y1 in text_rects(text, x_centre + centre, y_centre, pixel, facing=1):
            m.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], material, outward=(0, 0, 1))


vm.FONT.update({
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
})


def build_frame(electric):
    """Everything that doesn't move: frame, fork, bars, carrier, fenders, skirt, guard, saddle."""
    m = Mesh()
    f = "frame"
    # Step-through main tube: head tube down in a sweep to the bottom bracket.
    main = bezier((0.0, 0.80, 0.445), (0.0, 0.58, 0.36), (0.0, 0.32, 0.18), (0.0, 0.26, -0.04), 7)
    tube(m, main, 0.034, f)
    # A second, slimmer lower tube (the Lyft frame's twin-spar look) from the head tube to the BB.
    tube(m, bezier((0.0, 0.72, 0.46), (0.0, 0.48, 0.42), (0.0, 0.26, 0.20), (0.0, 0.24, 0.0), 6), 0.02, f)
    tube(m, [HEAD_BOT, HEAD_TOP], 0.032, f)                         # head tube
    tube(m, [(0.0, 0.24, -0.06), SEAT_CLUSTER], 0.027, f)            # seat tube
    tube(m, [(0.0, 0.24, -0.075), (0.0, 0.30, -0.06)], 0.045, f)     # bottom bracket shell
    for s in (1, -1):
        x = 0.062 * s
        tube(m, [(0.025 * s, BB[1], BB[2]), (x, 0.30, -0.25), (x, AXLE_Y, REAR_Z)], 0.015, f)              # chainstay
        tube(m, [(x, AXLE_Y, REAR_Z), (0.045 * s, 0.56, -0.36), (0.02 * s, 0.72, -0.245)], 0.013, f)       # seatstay
        tube(m, [(0.03 * s, 0.68, 0.475), (0.048 * s, 0.50, 0.53), (0.048 * s, AXLE_Y, FRONT_Z)], 0.016, f)  # fork leg
    tube(m, [(-0.05, 0.69, 0.475), (0.05, 0.69, 0.475)], 0.022, f)  # fork crown

    # Seat post (silver) and saddle (black).
    tube(m, [SEAT_CLUSTER, (0.0, SADDLE[1] - 0.04, SADDLE[2] + 0.015)], 0.016, "silver")
    tube(m, [(-0.024, SEAT_CLUSTER[1] - 0.01, SEAT_CLUSTER[2]), (0.024, SEAT_CLUSTER[1] - 0.01, SEAT_CLUSTER[2])], 0.03, "black")  # clamp
    sz = SADDLE[2]
    saddle = [(0.0, sz + 0.15), (0.04, sz + 0.13), (0.10, sz - 0.02), (0.11, sz - 0.08), (0.08, sz - 0.12),
              (-0.08, sz - 0.12), (-0.11, sz - 0.08), (-0.10, sz - 0.02), (-0.04, sz + 0.13)]
    prism_y(m, saddle, SADDLE[1] - 0.055, SADDLE[1] - 0.01, "black", top_lift=lambda x, z: 0.01 - 0.25 * x * x)

    # Stem and swept-back upright bars with black grips.
    stem_top = (0.0, 1.03, 0.37)
    tube(m, [HEAD_TOP, stem_top], 0.02, "black")
    gx, gy, gz = GRIP
    bar = [(-gx - 0.05, gy, gz - 0.035), (-gx, gy, gz), (-0.20, gy - 0.005, 0.30), (-0.08, gy - 0.02, 0.37),
           (0.08, gy - 0.02, 0.37), (0.20, gy - 0.005, 0.30), (gx, gy, gz), (gx + 0.05, gy, gz - 0.035)]
    tube(m, bar, 0.011, "silver", sides=6)
    for s in (1, -1):
        tube(m, [(s * (gx - 0.06), gy, gz + 0.05), (s * (gx + 0.055), gy, gz - 0.04)], 0.018, "black", sides=6)
    if electric:  # handlebar display
        m.box(-0.05, 0.05, 1.04, 1.075, 0.31, 0.37, "black")
        m.poly([(-0.04, 1.077, 0.32), (0.04, 1.077, 0.32), (0.04, 1.077, 0.36), (-0.04, 1.077, 0.36)], "logo_blue", outward=(0, 1, 0))

    # Front carrier, frame-mounted on the head tube: a tray with a logo panel at the front.
    z0, z1, hx = 0.50, 0.80, 0.18
    yb, yt = 0.86, 0.99
    m.box(-hx, hx, yb, yb + 0.02, z0, z1, "black")                           # tray floor
    m.box(-hx, hx, yb, yt, z1 - 0.015, z1, "navy")                            # logo panel
    for s in (1, -1):
        m.box(s * hx - 0.012, s * hx + 0.012, yb, yt - 0.03, z0, z1 - 0.015, "frame")  # side panels
        m.box(s * hx - 0.014, s * hx + 0.014, yt - 0.03, yt - 0.01, z0, z1, "black")   # rail
    m.box(-hx, hx, yb, yt - 0.04, z0, z0 + 0.015, "black")                    # back wall
    for s in (1, -1):
        tube(m, [(s * 0.1, yb, z0 + 0.05), (s * 0.03, HEAD_BOT[1] + 0.06, 0.47)], 0.012, "black", sides=6)
    logo_text(m, 0.0, (yb + yt) / 2 + 0.01, z1 + 0.002, 0.0064)
    m.box(0.155, 0.175, 0.955, 0.975, z1, z1 + 0.004, "orange")             # the logo's dot
    m.box(-0.05, 0.05, yb - 0.035, yb, z1 - 0.03, z1 + 0.01, "lamp")         # front light

    # Fenders: black, hugging the tyres.
    arc_band(m, FRONT_Z, AXLE_Y, 0.345, 0.36, -20, 150, -0.042, 0.042, "black", seg=12, inner=False, ends=False)
    arc_band(m, REAR_Z, AXLE_Y, 0.345, 0.36, 40, 205, -0.045, 0.045, "black", seg=12, inner=False, ends=False)
    # Rear sponsor skirt on both sides: navy with a white band and an orange corner.
    for s in (1, -1):
        flat_sector(m, REAR_Z, AXLE_Y, 0.12, 0.35, 70, 195, s * 0.072, "navy", 10, s)
        flat_sector(m, REAR_Z, AXLE_Y, 0.22, 0.285, 95, 170, s * 0.076, "white", 6, s)
        flat_sector(m, REAR_Z, AXLE_Y, 0.29, 0.35, 160, 195, s * 0.076, "orange", 3, s)
        flat_sector(m, REAR_Z, AXLE_Y, 0.13, 0.2, 70, 110, s * 0.076, "logo_blue", 3, s)
    m.box(-0.03, 0.03, AXLE_Y + 0.33, AXLE_Y + 0.37, REAR_Z - 0.19, REAR_Z - 0.16, "red")  # rear light

    # Enclosed chain guard on the right (-X): the hull of the chainring and the rear sprocket.
    ring = circle_zy(BB[2], BB[1], 0.115, -90, 90, 8)
    sprocket = circle_zy(REAR_Z, AXLE_Y, 0.07, 90, 270, 6)
    prism_x(m, ring + sprocket, -0.09, -0.045, "black")
    m.cylinder_x(BB[1], BB[1], BB[2], 0.045, -0.096, -0.09, 12, "silver", caps=("-x",))
    m.cylinder_x(BB[1], BB[1], BB[2], 0.045, 0.045, 0.05, 12, "black", caps=("+x",))  # left-side cover

    if electric:
        # Battery along the top of the main tube, with a light-blue stripe and charge LEDs.
        a, b = (0.0, 0.70, 0.40), (0.0, 0.40, 0.17)
        d = norm(sub(b, a))
        up = norm(cross((1.0, 0.0, 0.0), d))
        lift = 0.06
        m.beam(add(a, scale(up, lift)), add(b, scale(up, lift)), 0.095, 0.075, "battery")
        m.beam(add(add(a, scale(up, lift + 0.03)), scale(d, 0.04)), add(add(b, scale(up, lift + 0.03)), scale(d, -0.04)), 0.1, 0.02, "logo_blue")
    return m


# --------------------------------------------------------------------------------------------
# Kenney character, cut into rigid parts
# --------------------------------------------------------------------------------------------

COMPONENTS = {5126: ("f", 4), 5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4)}
COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Glb:
    def __init__(self, raw):
        jlen = struct.unpack_from("<I", raw, 12)[0]
        self.json = json.loads(raw[20 : 20 + jlen])
        self.bin_off = 20 + jlen + 8
        self.raw = raw

    def read(self, index):
        acc = self.json["accessors"][index]
        bv = self.json["bufferViews"][acc["bufferView"]]
        fmt, size = COMPONENTS[acc["componentType"]]
        n = COUNTS[acc["type"]]
        stride = bv.get("byteStride", size * n)
        off = self.bin_off + bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        return [struct.unpack_from(f"<{n}{fmt}", self.raw, off + i * stride) for i in range(acc["count"])]

    def image(self, index):
        bv = self.json["bufferViews"][self.json["images"][index]["bufferView"]]
        off = self.bin_off + bv.get("byteOffset", 0)
        return self.raw[off : off + bv["byteLength"]]


def mat_mul_point(m, p):
    """Column-major glTF 4x4 times a point."""
    return tuple(m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] for r in range(3))


def mat_mul_dir(m, d):
    return tuple(m[r] * d[0] + m[4 + r] * d[1] + m[8 + r] * d[2] for r in range(3))


# The torso, arms and head never move relative to each other on the bike, so they become one
# part on the torso joint (one draw instead of four).
MERGE_INTO_TORSO = {"arm-left", "arm-right", "head"}


def kenney_character(name):
    """The character's joints (name, parent, rest translation) and its mesh cut into rigid parts
    in each joint's space: {joint name: (positions, normals, uvs, indices)}."""
    g = Glb((OUT / f"character-{name}.glb").read_bytes())
    nodes = g.json["nodes"]
    skin = g.json["skins"][0]
    joints = skin["joints"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    joint_info = {nodes[j]["name"]: (nodes[parent[j]]["name"] if parent.get(j) in joints else None, tuple(nodes[j].get("translation", (0, 0, 0))))
                  for j in joints}
    parts = {}
    for node in nodes:
        if "mesh" not in node:
            continue
        ibms = g.read(g.json["skins"][node["skin"]]["inverseBindMatrices"])
        node_joints = g.json["skins"][node["skin"]]["joints"]
        for prim in g.json["meshes"][node["mesh"]]["primitives"]:
            a = prim["attributes"]
            pos, nrm, uv = g.read(a["POSITION"]), g.read(a["NORMAL"]), g.read(a["TEXCOORD_0"])
            jnt, wgt = g.read(a["JOINTS_0"]), g.read(a["WEIGHTS_0"])
            idx = [i[0] for i in g.read(prim["indices"])]
            owner = [jj[w.index(max(w))] for jj, w in zip(jnt, wgt)]
            for t in range(0, len(idx), 3):
                tri = idx[t : t + 3]
                k = owner[tri[0]]
                target = nodes[node_joints[k]]["name"]
                ibm = ibms[k]  # into the owning joint's space
                p_list, n_list, u_list, i_list, remap = parts.setdefault(target, ([], [], [], [], {}))
                for v in tri:
                    key = (id(prim), v)
                    if key not in remap:
                        remap[key] = len(p_list)
                        p_list.append(mat_mul_point(ibm, pos[v]))
                        n_list.append(norm(mat_mul_dir(ibm, nrm[v])))
                        u_list.append(uv[v])
                    i_list.append(remap[key])
    material = dict(g.json["materials"][0])
    sampler = g.json["samplers"][g.json["textures"][0].get("sampler", 0)] if g.json.get("samplers") else {}
    return joint_info, {k: v[:4] for k, v in parts.items()}, g.image(0), material, sampler


# --------------------------------------------------------------------------------------------
# Quaternions and the rider's pose
# --------------------------------------------------------------------------------------------

def q_axis(axis, deg):
    a = math.radians(deg) / 2
    s = math.sin(a)
    ax = norm(axis)
    return (ax[0] * s, ax[1] * s, ax[2] * s, math.cos(a))


def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def q_rotate(q, v):
    x, y, z, w = q
    u = (x, y, z)
    t = scale(cross(u, v), 2)
    return add(add(v, scale(t, w)), cross(u, t))


def q_conj(q):
    return (-q[0], -q[1], -q[2], q[3])


def q_from_to(a, b):
    a, b = norm(a), norm(b)
    c = cross(a, b)
    w = 1 + dot(a, b)
    if w < 1e-6:
        return (1.0, 0.0, 0.0, 0.0)
    n = math.sqrt(dot(c, c) + w * w)
    return (c[0] / n, c[1] / n, c[2] / n, w / n)


def q_round(q):
    return [round(v, 6) for v in q]


TORSO_LEAN = 14  # degrees forward


def rider_pose(joints, parts):
    """Wrapper transform, static joint rotations and per-key leg/torso/root animation."""
    s = RIDER_SCALE
    hip_local = joints["torso"][1]  # torso pivot (= hip height) in character units
    # Sit the hip pivot on the saddle, a touch above its top.
    wrap_t = (0.0, SADDLE[1] + 0.02 - hip_local[1] * s, SADDLE[2] - 0.02 - hip_local[2] * s)

    def world(p_char):
        return add(wrap_t, scale(p_char, s))

    lean = q_axis((1, 0, 0), TORSO_LEAN)
    static = {"torso": lean}
    for arm, side in (("arm-left", 1), ("arm-right", -1)):
        shoulder_local = joints[arm][1]  # relative to the torso
        shoulder = world(add(hip_local, q_rotate(lean, shoulder_local)))
        grip = (side * GRIP[0], GRIP[1], GRIP[2])
        dir_world = sub(grip, shoulder)
        dir_torso = q_rotate(q_conj(lean), dir_world)
        static[arm] = q_from_to((side, 0.0, 0.0), dir_torso)
        # Shorten the arm along its length so the hand ends at the grip, not in the basket.
        length = max(abs(v[0]) for v in parts[arm][0])
        static[arm + ":reach"] = min(1.0, math.sqrt(dot(dir_world, dir_world)) / s / length)

    times, legs, torso, root = [], {"leg-left": [], "leg-right": []}, [], []
    for k in range(KEYS + 1):
        t = k / KEYS
        times.append(round(t * CLIP_SECONDS, 5))
        phase = 2 * math.pi * t
        for leg, side, offset in (("leg-left", 1, math.pi), ("leg-right", -1, 0.0)):
            # The crank model: right pedal at angle 0 (forward), left opposite; turning top-forward.
            a = phase + offset
            pedal = (side * 0.16, BB[1] + CRANK * math.sin(a), BB[2] + CRANK * math.cos(a))
            hip = world(joints[leg][1])
            d = sub(pedal, hip)
            legs[leg].append(q_from_to((0.0, -1.0, 0.0), (0.0, d[1], d[2])))
        # Rock a little towards the pushing leg, and bob twice a stroke.
        rock = q_axis((0, 0, 1), 2.0 * math.sin(phase))
        torso.append(q_mul(rock, lean))
        root.append((0.0, 0.006 * math.cos(2 * phase), 0.0))
    return wrap_t, static, times, legs, torso, root


# --------------------------------------------------------------------------------------------
# GLB writer (multi-node, textured, animated)
# --------------------------------------------------------------------------------------------

def png_rgba(width, height, pixels):
    """Minimal PNG encoder; pixels is a list of rows of (r, g, b, a)."""
    raw = b"".join(b"\0" + bytes(c for px in row for c in px) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def palette_png():
    cols = len(PALETTE_NAMES)
    row = []
    for name in PALETTE_NAMES:
        h = PALETTE[name]
        rgb = tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))
        row.extend([rgb + (255,)] * CELL)
    return png_rgba(cols * CELL, CELL, [row] * CELL)


def palette_uv(name):
    return ((PALETTE_NAMES.index(name) + 0.5) / len(PALETTE_NAMES), 0.5)


class Writer:
    def __init__(self, name):
        self.g = {
            "asset": {"version": "2.0", "generator": "flowcast make_bike_models.py"},
            "scene": 0,
            "scenes": [{"name": name, "nodes": []}],
            "nodes": [], "meshes": [], "materials": [], "textures": [], "images": [], "samplers": [],
            "accessors": [], "bufferViews": [], "buffers": [{"byteLength": 0}],
        }
        self.bin = bytearray()

    def view(self, data, target=None):
        self.bin += b"\0" * (-len(self.bin) % 4)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.g["bufferViews"].append(v)
        self.bin += data
        return len(self.g["bufferViews"]) - 1

    def accessor(self, rows, kind, fmt="f", target=None, bounds=False):
        flat = [c for r in rows for c in (r if isinstance(r, (tuple, list)) else (r,))]
        comp = {"f": 5126, "H": 5123, "I": 5125}[fmt]
        acc = {"bufferView": self.view(struct.pack(f"<{len(flat)}{fmt}", *flat), target), "componentType": comp,
               "count": len(rows), "type": kind}
        if bounds:
            n = COUNTS[kind]
            acc["min"] = [round(min(r[i] for r in rows), 5) if n > 1 else min(rows) for i in range(n)]
            acc["max"] = [round(max(r[i] for r in rows), 5) if n > 1 else max(rows) for i in range(n)]
        self.g["accessors"].append(acc)
        return len(self.g["accessors"]) - 1

    def texture_material(self, name, png, factors, sampler):
        self.g["samplers"].append(sampler)
        self.g["images"].append({"bufferView": self.view(png), "mimeType": "image/png"})
        self.g["textures"].append({"sampler": len(self.g["samplers"]) - 1, "source": len(self.g["images"]) - 1})
        self.g["materials"].append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorTexture": {"index": len(self.g["textures"]) - 1, "texCoord": 0}, **factors},
            "doubleSided": True,
        })
        return len(self.g["materials"]) - 1

    def mesh(self, name, pos, nrm, uv, idx, material):
        big = len(pos) > 65535
        prim = {
            "attributes": {
                "POSITION": self.accessor(pos, "VEC3", target=34962, bounds=True),
                "NORMAL": self.accessor(nrm, "VEC3", target=34962),
                "TEXCOORD_0": self.accessor(uv, "VEC2", target=34962),
            },
            "indices": self.accessor(idx, "SCALAR", "I" if big else "H", target=34963),
            "material": material,
            "mode": 4,
        }
        self.g["meshes"].append({"name": name, "primitives": [prim]})
        return len(self.g["meshes"]) - 1

    def palette_mesh(self, name, m, material):
        """A helper Mesh (prims by palette colour) as one primitive with palette UVs."""
        pos, nrm, uv, idx = [], [], [], []
        for colour in sorted(m.prims):
            p, n, i = m.prims[colour]
            base = len(pos)
            pos.extend(p)
            nrm.extend(n)
            uv.extend([palette_uv(colour)] * len(p))
            idx.extend(base + k for k in i)
        return self.mesh(name, pos, nrm, uv, idx, material)

    def node(self, **kw):
        self.g["nodes"].append({k: v for k, v in kw.items() if v is not None})
        return len(self.g["nodes"]) - 1

    def animation(self, name, channels):
        """channels: [(node, path, times, values)], linear interpolation."""
        anim = {"name": name, "samplers": [], "channels": []}
        cache = {}
        for node, path, times, values in channels:
            key = tuple(times)
            if key not in cache:
                cache[key] = self.accessor(times, "SCALAR", bounds=True)
            kind = "VEC4" if path == "rotation" else "VEC3"
            out = self.accessor([tuple(v) for v in values], kind)
            anim["samplers"].append({"input": cache[key], "output": out, "interpolation": "LINEAR"})
            anim["channels"].append({"sampler": len(anim["samplers"]) - 1, "target": {"node": node, "path": path}})
        self.g.setdefault("animations", []).append(anim)

    def write(self, path, roots):
        self.g["scenes"][0]["nodes"] = roots
        for key in ("textures", "images", "samplers"):
            if not self.g[key]:
                del self.g[key]
        data = pad4(bytes(self.bin), b"\0")
        self.g["buffers"][0]["byteLength"] = len(data)
        js = pad4(json.dumps(self.g, separators=(",", ":")).encode(), b" ")
        total = 12 + 8 + len(js) + 8 + len(data)
        out = struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(data), 0x004E4942) + data
        path.write_bytes(out)


def spin_keys(turns):
    """Rotation keys about +X (top of the wheel moving forward, +Z) for `turns` per clip."""
    return [q_round(q_axis((1, 0, 0), 360.0 * turns * k / KEYS)) for k in range(KEYS + 1)]


def write_bike(path, electric, rider=None):
    name = path.stem
    w = Writer(name)
    palette = w.texture_material("bluebikes-palette", palette_png(), {"metallicFactor": 0.15, "roughnessFactor": 0.5},
                                 {"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071})
    children = []
    frame = w.node(name="frame", mesh=w.palette_mesh("frame", build_frame(electric), palette))
    front = w.node(name="wheel-front", mesh=w.palette_mesh("wheel-front", build_wheel(True, electric), palette),
                   translation=[0.0, AXLE_Y, FRONT_Z])
    rear = w.node(name="wheel-rear", mesh=w.palette_mesh("wheel-rear", build_wheel(False, electric), palette),
                  translation=[0.0, AXLE_Y, REAR_Z])
    crank = w.node(name="crank", mesh=w.palette_mesh("crank", build_crank(), palette), translation=[0.0, BB[1], BB[2]])
    children += [frame, front, rear, crank]
    times = [round(CLIP_SECONDS * k / KEYS, 5) for k in range(KEYS + 1)]
    channels = [(front, "rotation", times, spin_keys(WHEEL_TURNS)), (rear, "rotation", times, spin_keys(WHEEL_TURNS)),
                (crank, "rotation", times, spin_keys(1))]

    if rider:
        joints, parts, png, kmat, ksampler = kenney_character(rider)
        wrap_t, static, ptimes, legs, torso, root = rider_pose(joints, parts)
        kenney = w.texture_material("colormap", png, {"metallicFactor": 0.0}, ksampler or {"magFilter": 9728, "minFilter": 9728})
        # The arms (in their handlebar pose) and the head join the torso's part.
        tp, tn, tu, ti = (list(a) for a in parts["torso"])
        for jname in sorted(MERGE_INTO_TORSO):
            if jname not in parts:
                continue
            q = static.get(jname, (0.0, 0.0, 0.0, 1.0))
            reach = static.get(jname + ":reach", 1.0)
            offset = joints[jname][1]
            p, n, u, i = parts[jname]
            base = len(tp)
            tp += [add(offset, q_rotate(q, (v[0] * reach, v[1], v[2]))) for v in p]
            tn += [q_rotate(q, v) for v in n]
            tu += list(u)
            ti += [base + k for k in i]
        parts["torso"] = (tp, tn, tu, ti)
        node_of = {}
        # Joints, parents before children.
        for jname in ("root", "leg-left", "leg-right", "torso"):
            parent, t = joints[jname]
            mesh = None
            if jname in parts:
                p, n, u, i = parts[jname]
                mesh = w.mesh(f"{rider}-{jname}", p, n, u, i, kenney)
            node_of[jname] = w.node(name=jname, mesh=mesh, translation=[round(v, 6) for v in t],
                                    rotation=q_round(static[jname]) if jname in static else None,
                                    scale=[1.0, LEG_STRETCH, 1.0] if jname.startswith("leg") else None)
        for jname in ("leg-left", "leg-right", "torso"):
            w.g["nodes"][node_of["root"]].setdefault("children", []).append(node_of[jname])
        wrapper = w.node(name=f"rider-{rider}", translation=[round(v, 5) for v in wrap_t], scale=[RIDER_SCALE] * 3,
                         children=[node_of["root"]])
        children.append(wrapper)
        channels += [(node_of["leg-left"], "rotation", ptimes, [q_round(q) for q in legs["leg-left"]]),
                     (node_of["leg-right"], "rotation", ptimes, [q_round(q) for q in legs["leg-right"]]),
                     (node_of["torso"], "rotation", ptimes, [q_round(q) for q in torso]),
                     (node_of["root"], "translation", ptimes, root)]
    w.animation("ride", channels)
    root_node = w.node(name=name, children=children)
    w.write(path, [root_node])


def check(path):
    raw = path.read_bytes()
    g = Glb(raw)
    lo, hi, tris = [math.inf] * 3, [-math.inf] * 3, 0

    def world_mats():
        out = {}

        def visit(i, mtx):
            n = g.json["nodes"][i]
            t = n.get("translation", (0, 0, 0))
            r = n.get("rotation", (0, 0, 0, 1))
            s = n.get("scale", (1, 1, 1))
            local = lambda p: add(q_rotate(r, (p[0] * s[0], p[1] * s[1], p[2] * s[2])), t)
            f = (lambda p, local=local, mtx=mtx: mtx(local(p)))
            out[i] = f
            for c in n.get("children", []):
                visit(c, f)

        for root in g.json["scenes"][0]["nodes"]:
            visit(root, lambda p: p)
        return out

    mats = world_mats()
    for i, n in enumerate(g.json["nodes"]):
        if "mesh" not in n:
            continue
        for prim in g.json["meshes"][n["mesh"]]["primitives"]:
            for p in g.read(prim["attributes"]["POSITION"]):
                q = mats[i](p)
                for a in range(3):
                    lo[a] = min(lo[a], q[a])
                    hi[a] = max(hi[a], q[a])
            tris += g.json["accessors"][prim["indices"]]["count"] // 3
    prims = sum(len(g.json["meshes"][n["mesh"]]["primitives"]) for n in g.json["nodes"] if "mesh" in n)
    print(f"{path.name}: {len(raw) / 1024:.1f} KB, {tris} triangles, {prims} primitives (draws), "
          f"{len(g.json['animations'][0]['channels'])} animated channels")
    print(f"  bounds min {[round(v, 3) for v in lo]} max {[round(v, 3) for v in hi]}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [("bluebike", False, None), ("bluebike-electric", True, None)]
    jobs += [(f"bluebike-rider-{r}", False, r) for r in CLASSIC_RIDERS]
    jobs += [(f"bluebike-electric-rider-{r}", True, r) for r in ELECTRIC_RIDERS]
    for name, electric, rider in jobs:
        path = OUT / f"{name}.glb"
        write_bike(path, electric, rider)
        print(f"wrote {path}")
        if "--check" in sys.argv:
            check(path)


if __name__ == "__main__":
    main()
