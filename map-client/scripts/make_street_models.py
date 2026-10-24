"""Generate low-poly street-furniture models (traffic signal, MBTA bus stop, Green Line shelter)
as self-contained GLBs, in the same style as make_vehicle_models.py (whose Mesh and checker are
reused): standard library only, flat-shaded polygons, plain PBR colours, no textures.

All models: metres at real scale, +Y up, origin on the ground at the object's anchor point.

traffic-signal.glb
    Origin = base of the pole. The mast arm reaches along +Z (over the road). Every signal
    face looks toward +X (at approaching traffic). Lenses are unlit near-black glass: the map
    draws the glow itself at the lens centres, which are printed by this script and also
    stored in the node's `extras.lamps` (model space, metres).
bus-stop.glb / bus-stop-sign.glb
    Origin = base of the sign pole at the curb. The street is toward +X. The sign panel faces
    +/-Z (along the street, at approaching buses) and is printed on both sides. The shelter
    (bus-stop.glb only) runs along -Z from the pole, set back from the curb toward -X, open
    on its street (+X) side.
green-line-shelter.glb
    Origin = centre of the canopy footprint on the platform surface (no slab: the map draws
    the platform). Canopy long axis along Z, posts down the back (-X) side, benches facing
    +X (the track side); the roof rises gently toward +X. The "T" sign pole stands just past
    the +Z end of the canopy, where its roundel can clear the roof.

    python3 map-client/scripts/make_street_models.py           # write all four models
    python3 map-client/scripts/make_street_models.py --check   # also print bounds/tri counts
"""

import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_vehicle_models import (  # noqa: E402  (shared geometry + checker)
    Mesh, add, check_glb, cross, norm, pad4, scale, srgb_to_linear, sub,
)

OUT = Path(__file__).resolve().parent.parent / "public" / "models"


# --------------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------------

def mat(hex_colour, metallic=0.1, roughness=0.55, alpha=None):
    rgb = [srgb_to_linear(int(hex_colour[i : i + 2], 16)) for i in (1, 3, 5)]
    m = {
        "pbrMetallicRoughness": {
            "baseColorFactor": [round(v, 5) for v in rgb] + [1.0 if alpha is None else alpha],
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        },
        "doubleSided": True,
    }
    if alpha is not None:
        m["alphaMode"] = "BLEND"
    return m


MATERIALS = {
    "pole_olive": mat("#3E4437", 0.45, 0.55),     # signal pole and mast arm
    "concrete": mat("#A3A29C", 0.0, 0.9),
    "signal_black": mat("#141517", 0.1, 0.6),     # housings, visors, backplates
    "backplate_yellow": mat("#F2C21B", 0.0, 0.45),  # retroreflective backplate border
    "lens_red": mat("#2E0B0B", 0.0, 0.12),        # unlit lenses: near-black tinted glass
    "lens_amber": mat("#2E2208", 0.0, 0.12),
    "lens_green": mat("#08261A", 0.0, 0.12),
    "lens_ped": mat("#1E1E1E", 0.0, 0.15),
    "street_sign": mat("#0B6B3A", 0.05, 0.5),
    "metal": mat("#9AA0A6", 0.6, 0.4),            # sign poles
    "frame": mat("#33383D", 0.4, 0.5),            # shelter posts/frames
    "roof": mat("#25292D", 0.2, 0.6),
    "bench": mat("#6B7178", 0.5, 0.45),
    "ad_face": mat("#DDE5EA", 0.0, 0.4),
    "glass": mat("#B4C6D2", 0.1, 0.08, alpha=0.35),
    "mbta_green": mat("#00843D", 0.05, 0.5),
    "mbta_yellow": mat("#FFC72C", 0.05, 0.5),
    "logo_white": mat("#F4F5F6", 0.0, 0.5),
    "sign_black": mat("#111315", 0.1, 0.5),
}


# --------------------------------------------------------------------------------------------
# Extra geometry helpers (on top of Mesh.poly / Mesh.box / Mesh.beam)
# --------------------------------------------------------------------------------------------

def cylinder(m, p0, p1, r0, material, r1=None, seg=12, caps=(True, True), cap_mat=None):
    """A (possibly tapered) cylinder between two points."""
    r1 = r0 if r1 is None else r1
    d = norm(sub(p1, p0))
    up = (0.0, 1.0, 0.0) if abs(d[1]) < 0.95 else (1.0, 0.0, 0.0)
    s = norm(cross(d, up))
    u = cross(s, d)
    angles = [2 * math.pi * i / seg for i in range(seg)]
    radial = [add(scale(s, math.cos(a)), scale(u, math.sin(a))) for a in angles]
    ring0 = [add(p0, scale(r, r0)) for r in radial]
    ring1 = [add(p1, scale(r, r1)) for r in radial]
    for i in range(seg):
        j = (i + 1) % seg
        out = add(radial[i], radial[j])
        m.poly([ring0[i], ring0[j], ring1[j], ring1[i]], material, outward=out)
    if caps[0]:
        m.poly(ring0, cap_mat or material, outward=scale(d, -1))
    if caps[1]:
        m.poly(ring1, cap_mat or material, outward=d)


def hexa(m, c, material):
    """Hexahedron from 8 corners: bottom (x0z0, x1z0, x1z1, x0z1) then top in the same order."""
    centre = scale([sum(p[k] for p in c) for k in range(3)], 1 / 8)
    for q in ((0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        pts = [c[i] for i in q]
        fc = scale([sum(p[k] for p in pts) for k in range(3)], 0.25)
        m.poly(pts, material, outward=sub(fc, centre))


def plane_pt(axis, w, u, v):
    """A point on a plane normal to `axis` at coordinate w; (u, v) = (z, y) for X, (x, y) for Z."""
    return (w, v, u) if axis == "x" else (u, v, w)


def flat(m, axis, w, uv, material, facing):
    n = (facing, 0.0, 0.0) if axis == "x" else (0.0, 0.0, facing)
    m.poly([plane_pt(axis, w, u, v) for u, v in uv], material, outward=n)


def rect(m, axis, w, u0, u1, v0, v1, material, facing):
    flat(m, axis, w, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], material, facing)


def disc(m, axis, w, cu, cv, r, material, facing, seg=24):
    pts = [(cu + r * math.cos(2 * math.pi * i / seg), cv + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    flat(m, axis, w, pts, material, facing)


def roundel(m, axis, w, cu, cv, r, facing, step=0.003):
    """The MBTA 'T' roundel on a plane: black ring, white disc, black T (same proportions as the
    vehicle livery). `w` is the surface it sits on; layers step outward toward `facing`."""
    disc(m, axis, w + facing * step, cu, cv, r, "sign_black", facing)
    disc(m, axis, w + facing * step * 2, cu, cv, r * 0.82, "logo_white", facing)
    t = r * 0.62
    ww = w + facing * step * 3
    rect(m, axis, ww, cu - t, cu + t, cv + t * 0.42, cv + t * 0.78, "sign_black", facing)
    rect(m, axis, ww, cu - t * 0.2, cu + t * 0.2, cv - t * 0.95, cv + t * 0.45, "sign_black", facing)


def visor_x(m, x0, cy, cz, r, length, material, seg=10, a0=-25.0, a1=205.0):
    """A thin curved hood over a +X-facing lens: covers the top and sides, longest on top."""
    pts = []
    for i in range(seg + 1):
        a = math.radians(a0 + (a1 - a0) * i / seg)
        pts.append((cz + r * math.cos(a), cy + r * math.sin(a), length * (0.4 + 0.6 * max(0.0, math.sin(a))), a))
    for (za, ya, la, aa), (zb, yb, lb, ab) in zip(pts, pts[1:]):
        am = (aa + ab) / 2
        m.poly([(x0, ya, za), (x0, yb, zb), (x0 + lb, yb, zb), (x0 + la, ya, za)], material,
               outward=(0.0, math.sin(am), math.cos(am)))


# --------------------------------------------------------------------------------------------
# Traffic signal
# --------------------------------------------------------------------------------------------

POLE_H = 5.5
POLE_R = 0.075            # 0.15 m diameter
ARM_Y = 5.40              # mast arm centreline height
ARM_LEN = 4.5
HEAD_Z = 4.30             # mast-arm head hangs here (just short of the arm tip)
LENS_GLASS = 0.015        # lens stands this far proud of the housing face


def signal_head(m, x_back, x_front, y_top, zc, lens_r, pitch, width, visor_len):
    """A three-section head facing +X. Returns lens centres (red, amber, green)."""
    y_bot = y_top - 3 * pitch
    m.box(x_back, x_front, y_bot, y_top, zc - width / 2, zc + width / 2, "signal_black")
    lenses = []
    for k, lens_mat in enumerate(("lens_red", "lens_amber", "lens_green")):
        cy = y_top - pitch * (k + 0.5)
        cylinder(m, (x_front, cy, zc), (x_front + LENS_GLASS, cy, zc), lens_r, "signal_black",
                 seg=16, caps=(False, True), cap_mat=lens_mat)
        visor_x(m, x_front, cy, zc, lens_r + 0.02, visor_len, "signal_black")
        lenses.append((round(x_front + LENS_GLASS, 4), round(cy, 4), round(zc, 4)))
        if k:  # section seam (door frames)
            m.box(x_front, x_front + 0.01, y_top - pitch * k - 0.008, y_top - pitch * k + 0.008,
                  zc - width / 2, zc + width / 2, "signal_black")
    return lenses


def build_traffic_signal():
    m = Mesh()
    lamps = {}
    # Footing, base collar, tapered pole, cap.
    cylinder(m, (0, 0, 0), (0, 0.08, 0), 0.30, "concrete", seg=16, caps=(False, True))
    cylinder(m, (0, 0.08, 0), (0, 0.45, 0), 0.12, "pole_olive", r1=0.095, seg=12, caps=(False, True))
    cylinder(m, (0, 0.45, 0), (0, POLE_H - 0.04, 0), POLE_R + 0.008, "pole_olive", r1=POLE_R - 0.008,
             seg=12, caps=(False, False))
    cylinder(m, (0, POLE_H - 0.04, 0), (0, POLE_H, 0), POLE_R + 0.01, "pole_olive", seg=12)
    # Mast arm with its clamp at the pole and a tip cap.
    m.box(-0.11, 0.11, ARM_Y - 0.17, ARM_Y + 0.12, -0.11, 0.11, "pole_olive")
    cylinder(m, (0, ARM_Y, 0.08), (0, ARM_Y, ARM_LEN), 0.07, "pole_olive", r1=0.048, seg=10)

    # Mast-arm head: 12-inch lenses, 1.05 m housing, black backplate with yellow border.
    pitch, width = 0.35, 0.38
    y_top = ARM_Y - 0.09
    x_back, x_front = -0.13, 0.13
    m.box(-0.035, 0.035, y_top, ARM_Y - 0.03, HEAD_Z - 0.035, HEAD_Z + 0.035, "signal_black")  # hanger
    cylinder(m, (0, ARM_Y, HEAD_Z - 0.07), (0, ARM_Y, HEAD_Z + 0.07), 0.064, "signal_black", seg=10)  # clamp
    bp_x0, bp_x1 = x_front - 0.07, x_front - 0.055
    bw, bm = width / 2 + 0.13, 0.12
    m.box(bp_x0, bp_x1, y_top - 3 * pitch - bm, y_top + bm, HEAD_Z - bw, HEAD_Z + bw, "signal_black")
    for s in (1, -1):  # yellow border on the front face of the backplate
        rect(m, "x", bp_x1 + 0.002, HEAD_Z + s * bw, HEAD_Z + s * (bw - 0.05),
             y_top - 3 * pitch - bm, y_top + bm, "backplate_yellow", 1)
        yb = y_top + bm if s > 0 else y_top - 3 * pitch - bm
        rect(m, "x", bp_x1 + 0.002, HEAD_Z - bw, HEAD_Z + bw, yb, yb - s * 0.05, "backplate_yellow", 1)
    lamps["arm"] = signal_head(m, x_back, x_front, y_top, HEAD_Z, 0.15, pitch, width, 0.26)

    # Pole-mounted near-side head (8-inch lenses) on the +X face of the pole.
    p_pitch, p_width, p_top = 0.26, 0.27, 3.23
    m.box(0.04, 0.13, p_top - 0.12, p_top - 0.04, -0.04, 0.04, "signal_black")   # upper bracket
    m.box(0.04, 0.13, p_top - 3 * p_pitch + 0.04, p_top - 3 * p_pitch + 0.12, -0.04, 0.04, "signal_black")
    lamps["pole"] = signal_head(m, 0.12, 0.33, p_top, 0.0, 0.105, p_pitch, p_width, 0.18)

    # Pedestrian signal facing +Z (seen from the far kerb), with a hood, and a push button.
    m.box(-0.04, 0.04, 2.05, 2.35, 0.05, 0.13, "signal_black")
    m.box(-0.22, 0.22, 1.98, 2.42, 0.12, 0.40, "signal_black")
    rect(m, "z", 0.405, -0.18, 0.18, 2.02, 2.38, "lens_ped", 1)
    m.box(-0.23, 0.23, 2.42, 2.44, 0.40, 0.60, "signal_black")                  # hood top
    for s in (1, -1):
        m.box(*sorted((s * 0.21, s * 0.23)), 2.10, 2.42, 0.40, 0.58, "signal_black")  # hood sides
    lamps["pedestrian"] = [(0.0, 2.2, 0.405)]
    m.box(-0.06, 0.06, 0.95, 1.17, 0.06, 0.14, "backplate_yellow")               # push-button box
    cylinder(m, (0, 1.06, 0.14), (0, 1.06, 0.155), 0.03, "metal", seg=10, caps=(False, True))

    # Street-name sign hung under the arm, faces +/-X, green with a white border.
    zs0, zs1, ys0, ys1 = 1.7, 2.9, ARM_Y - 0.42, ARM_Y - 0.10
    for z in (zs0 + 0.15, zs1 - 0.15):
        m.box(-0.012, 0.012, ys1, ARM_Y - 0.03, z - 0.02, z + 0.02, "metal")
    m.box(-0.015, 0.015, ys0, ys1, zs0, zs1, "street_sign")
    for f in (1, -1):
        w = f * 0.017
        for a, b, c, d in ((zs0 + 0.03, zs1 - 0.03, ys1 - 0.05, ys1 - 0.03), (zs0 + 0.03, zs1 - 0.03, ys0 + 0.03, ys0 + 0.05),
                           (zs0 + 0.03, zs0 + 0.05, ys0 + 0.03, ys1 - 0.03), (zs1 - 0.05, zs1 - 0.03, ys0 + 0.03, ys1 - 0.03)):
            rect(m, "x", w, a, b, c, d, "logo_white", f)
        for za, zb in ((zs0 + 0.16, zs0 + 0.68), (zs0 + 0.78, zs1 - 0.16)):  # two "words"
            rect(m, "x", w, za, zb, ys0 + 0.12, ys1 - 0.12, "logo_white", f)
    return m, lamps


# --------------------------------------------------------------------------------------------
# MBTA bus stop (sign + shelter)
# --------------------------------------------------------------------------------------------

SIGN_POLE_H = 2.7


def build_bus_sign(m):
    """Pole at the origin; the panel faces +/-Z and is bolted to the pole's +Z side."""
    cylinder(m, (0, 0, 0), (0, SIGN_POLE_H, 0), 0.03, "metal", seg=10)
    cylinder(m, (0, SIGN_POLE_H, 0), (0, SIGN_POLE_H + 0.02, 0), 0.036, "metal", seg=10)
    x0, x1, y0, y1 = -0.23, 0.23, 1.88, 2.66
    z0, z1 = 0.033, 0.051
    for y in (y0 + 0.08, y1 - 0.08):  # clamps
        m.box(-0.045, 0.045, y - 0.025, y + 0.025, -0.04, z0, "metal")
    m.box(x0, x1, y0, y1, z0, z1, "metal")
    split = 2.20
    for f, w in ((1, z1), (-1, z0)):
        rect(m, "z", w + f * 0.002, x0 + 0.015, x1 - 0.015, split, y1 - 0.015, "mbta_yellow", f)
        rect(m, "z", w + f * 0.002, x0 + 0.015, x1 - 0.015, y0 + 0.015, split, "logo_white", f)
        roundel(m, "z", w + f * 0.002, 0.0, 2.44, 0.17, f)
        rect(m, "z", w + f * 0.004, x0 + 0.015, x1 - 0.015, split - 0.012, split + 0.004, "sign_black", f)
        # Bus pictogram on the white part (body, windows, wheels).
        ww = w + f * 0.004
        rect(m, "z", ww, -0.14, 0.14, 2.01, 2.14, "sign_black", f)
        for k in range(4):
            xa = -0.12 + k * 0.062
            rect(m, "z", ww + f * 0.002, xa, xa + 0.046, 2.075, 2.125, "logo_white", f)
        for xc in (-0.085, 0.085):
            disc(m, "z", ww, xc, 2.005, 0.028, "sign_black", f, seg=12)
        rect(m, "z", ww, -0.15, 0.15, 1.935, 1.955, "sign_black", f)  # "text" line


SH_X0, SH_X1 = -2.15, -0.65     # back wall / street edge of the shelter
SH_Z0, SH_Z1 = -4.35, -0.85     # far end / pole end
SH_H = 2.5


def build_shelter(m):
    post = 0.03
    roof_y0 = SH_H - 0.12
    posts = [(SH_X0, SH_Z0), (SH_X0, SH_Z1), (SH_X1, SH_Z0), (SH_X1, SH_Z1), (SH_X0, (SH_Z0 + SH_Z1) / 2)]
    for x, z in posts:
        m.box(x - post, x + post, 0.0, roof_y0, z - post, z + post, "frame")
    # Roof slab with a slight overhang, and a fascia rim.
    m.box(SH_X0 - 0.1, SH_X1 + 0.12, roof_y0, SH_H, SH_Z0 - 0.1, SH_Z1 + 0.1, "roof")
    # Rails: top and bottom of the back wall and both ends.
    for y0, y1 in ((0.06, 0.12), (roof_y0 - 0.08, roof_y0)):
        m.box(SH_X0 - 0.025, SH_X0 + 0.025, y0, y1, SH_Z0, SH_Z1, "frame")
        for z in (SH_Z0, SH_Z1):
            m.box(SH_X0, SH_X1, y0, y1, z - 0.025, z + 0.025, "frame")
    m.box(SH_X1 - 0.03, SH_X1 + 0.03, roof_y0 - 0.12, roof_y0, SH_Z0, SH_Z1, "frame")  # front header
    # Glass: back wall (two panes) and the pole-end wall; ad panel at the far end.
    gy0, gy1 = 0.12, roof_y0 - 0.08
    zm = (SH_Z0 + SH_Z1) / 2
    for za, zb in ((SH_Z0 + post, zm - post), (zm + post, SH_Z1 - post)):
        rect(m, "x", SH_X0, za, zb, gy0, gy1, "glass", 1)
    rect(m, "z", SH_Z1, SH_X0 + post, SH_X1 - post, gy0, gy1, "glass", -1)
    m.box(SH_X0 + 0.05, SH_X1 - 0.05, 0.25, 2.05, SH_Z0 - 0.06, SH_Z0 + 0.10, "frame")
    for f, w in ((1, SH_Z0 + 0.102), (-1, SH_Z0 - 0.062)):
        rect(m, "z", w, SH_X0 + 0.12, SH_X1 - 0.12, 0.32, 1.98, "ad_face", f)
    # Bench along the back wall, facing the street.
    bz0, bz1 = SH_Z0 + 0.6, SH_Z1 - 0.7
    m.box(SH_X0 + 0.08, SH_X0 + 0.48, 0.43, 0.48, bz0, bz1, "bench")
    for z in (bz0 + 0.15, bz1 - 0.15):
        m.box(SH_X0 + 0.15, SH_X0 + 0.40, 0.0, 0.43, z - 0.03, z + 0.03, "frame")
    m.box(SH_X0 + 0.04, SH_X0 + 0.08, 0.55, 0.85, bz0, bz1, "bench")  # backrest rail
    for z in (bz0 + 0.15, bz1 - 0.15):
        m.box(SH_X0 + 0.03, SH_X0 + 0.12, 0.45, 0.85, z - 0.025, z + 0.025, "frame")


def build_bus_stop(shelter):
    m = Mesh()
    build_bus_sign(m)
    if shelter:
        build_shelter(m)
    return m


# --------------------------------------------------------------------------------------------
# Green Line surface-stop shelter
# --------------------------------------------------------------------------------------------

GL_HALF_L, GL_HALF_W = 6.0, 1.3
GL_POST_X = -0.55
GL_POSTS_Z = (-4.5, -1.5, 1.5, 4.5)


def gl_under(x):
    """Height of the roof underside at x: rises gently toward +X (the track side)."""
    return 2.90 + 0.05 * x


def build_green_line_shelter():
    m = Mesh()
    th = 0.12
    xa, xb = -GL_HALF_W, GL_HALF_W
    za, zb = -GL_HALF_L, GL_HALF_L
    ya, yb = gl_under(xa), gl_under(xb)
    hexa(m, [(xa, ya, za), (xb, yb, za), (xb, yb, zb), (xa, ya, zb),
             (xa, ya + th, za), (xb, yb + th, za), (xb, yb + th, zb), (xa, ya + th, zb)], "roof")
    # Green fascia along both long edges, and dark end trims.
    for x, y, s in ((xb, yb, 1), (xa, ya, -1)):
        m.box(*sorted((x, x + s * 0.05)), y - 0.10, y + th + 0.03, za - 0.05, zb + 0.05, "mbta_green")
    for z, s in ((za, -1), (zb, 1)):
        hexa(m, [(xa, ya - 0.10, z), (xb, yb - 0.10, z), (xb, yb - 0.10, z + s * 0.05), (xa, ya - 0.10, z + s * 0.05),
                 (xa, ya + th + 0.03, z), (xb, yb + th + 0.03, z), (xb, yb + th + 0.03, z + s * 0.05),
                 (xa, ya + th + 0.03, z + s * 0.05)], "roof")
    # Spine beam along the posts and a sloped rafter over each post.
    sy = gl_under(GL_POST_X)
    m.box(GL_POST_X - 0.08, GL_POST_X + 0.08, sy - 0.22, sy, za + 0.3, zb - 0.3, "frame")
    for z in GL_POSTS_Z:
        m.beam((xa + 0.1, gl_under(xa + 0.1) - 0.04, z), (xb - 0.1, gl_under(xb - 0.1) - 0.04, z), 0.08, 0.08, "frame")
        cylinder(m, (GL_POST_X, 0.0, z), (GL_POST_X, sy - 0.22, z), 0.065, "frame", seg=10, caps=(False, False))
        m.box(GL_POST_X - 0.14, GL_POST_X + 0.14, 0.0, 0.02, z - 0.14, z + 0.14, "frame")  # base plate
    # Windscreen behind the benches and two benches facing the track (+X).
    rect(m, "x", -1.05, -4.3, 1.3, 0.12, 2.2, "glass", 1)
    for z in (-4.3, 1.3):
        m.box(-1.08, -1.02, 0.0, 2.25, z - 0.03, z + 0.03, "frame")
    m.box(-1.08, -1.02, 2.19, 2.25, -4.3, 1.3, "frame")
    m.box(-1.08, -1.02, 0.06, 0.12, -4.3, 1.3, "frame")
    for z0, z1 in ((-1.25, 1.25), (-4.2, -1.75)):
        m.box(-0.95, -0.52, 0.43, 0.48, z0, z1, "bench")
        m.box(-0.99, -0.94, 0.55, 0.88, z0, z1, "bench")
        for z in (z0 + 0.2, z1 - 0.2):
            m.box(-0.9, -0.6, 0.0, 0.43, z - 0.03, z + 0.03, "frame")
            m.box(-1.0, -0.92, 0.45, 0.88, z - 0.025, z + 0.025, "frame")
    # "T" sign pole just past the +Z end of the canopy, roundel facing +/-X.
    tz, tx, top = zb + 0.45, 0.2, 3.0
    cylinder(m, (tx, 0, tz), (tx, top, tz), 0.04, "metal", seg=10)
    r = 0.30
    cy = top + r - 0.02
    cylinder(m, (tx - 0.022, cy, tz), (tx + 0.022, cy, tz), r, "sign_black", seg=28)
    for f in (1, -1):
        roundel(m, "x", tx + f * 0.022, tz, cy, r * 0.98, f)
    return m


# --------------------------------------------------------------------------------------------
# GLB writer (as in make_vehicle_models.py, plus per-model materials, alpha blend and extras)
# --------------------------------------------------------------------------------------------

def write_glb(mesh, name, path, extras=None):
    node = {"name": name, "mesh": 0}
    if extras:
        node["extras"] = extras
    gltf = {
        "asset": {"version": "2.0", "generator": "flowcast make_street_models.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [node],
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

    # Opaque materials first, translucent glass last.
    order = sorted(mesh.prims, key=lambda k: ("alphaMode" in MATERIALS[k], k))
    for material in order:
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
    signal, lamps = build_traffic_signal()
    models = {
        "traffic-signal": (signal, {"lamps": {k: {"red": v[0], "amber": v[1], "green": v[2]} if len(v) == 3 else v[0]
                                              for k, v in lamps.items()}}),
        "bus-stop": (build_bus_stop(shelter=True), None),
        "bus-stop-sign": (build_bus_stop(shelter=False), None),
        "green-line-shelter": (build_green_line_shelter(), None),
    }
    for name, (mesh, extras) in models.items():
        path = OUT / f"{name}.glb"
        write_glb(mesh, name, path, extras)
        print(f"wrote {path} ({mesh.triangle_count()} triangles)")
        if "--check" in sys.argv:
            check_glb(path)
    print("traffic-signal lens centres (model space, metres; lit faces look toward +X):")
    for head, centres in lamps.items():
        for colour, c in zip(("red", "amber", "green") if len(centres) == 3 else ("walk",), centres):
            print(f"  {head:10s} {colour:5s} {c}")


if __name__ == "__main__":
    main()
