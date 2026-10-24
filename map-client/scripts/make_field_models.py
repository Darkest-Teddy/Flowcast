"""Generate the 3D props for BU's West Campus fields (New Balance Field, Nickerson Field) as
self-contained GLBs, in the style of make_street_models.py (whose helpers are reused): standard
library only, flat-shaded polygons, plain PBR colours, no textures, no KHR_texture_transform.

Reads map-client/public/data/fields.json (written by data-pipeline/fetch_fields.py), which says
where everything stands, and writes to map-client/public/models/:

field-props-new-balance.glb / field-props-nickerson.glb
    Everything that stands still on one field, merged into ONE mesh so each field costs one
    draw per material: goals, bleachers or the grandstand (fitted to its OSM footprint), the
    scoreboard, team benches, ball-stop netting, fences. Frame = the field's own frame from
    fields.json: origin at `anchor` on the playing surface, +Z along the field's long axis
    (`bearing`), +X to its left, +Y up. Metres at real scale (deck.gl's Web-Mercator metres).
field-light-21.glb / field-light-30.glb (+ -lit variants)
    A floodlight pole, 21 m (New Balance Field) or 30 m (Nickerson Field) to the top of the
    lamp frame. Origin = base of the pole; the lamp bank faces +Z, tilted down at the field.
    The -lit variants have emissive lenses (drawn at dusk and night); the lamp bank's centre is
    1.6 m below the top and 0.9 m in front of the pole (fetch_fields.py's `glow`).

    python3 map-client/scripts/make_field_models.py           # write all models
    python3 map-client/scripts/make_field_models.py --check   # also print bounds/tri counts
"""

import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_vehicle_models import Mesh, check_glb, pad4, srgb_to_linear  # noqa: E402
from make_street_models import cylinder, rect  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models"
FIELDS = ROOT / "public" / "data" / "fields.json"

# deck.gl's metres: Web Mercator distance scales at the anchor (isotropic, C / 360 per degree).
M_PER_DEG = 40_075_016.686 / 360


# --------------------------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------------------------

def mat(hex_colour, metallic=0.1, roughness=0.55, alpha=None, emissive=None):
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
    if emissive:
        m["emissiveFactor"] = [round(srgb_to_linear(int(emissive[i : i + 2], 16)), 5) for i in (1, 3, 5)]
    return m


MATERIALS = {
    "goal_white": mat("#F4F5F6", 0.3, 0.4),
    "goal_board": mat("#1C2430", 0.1, 0.6),       # field-hockey back/side boards
    "goal_frame": mat("#5E646B", 0.5, 0.45),      # soccer goal's rear supports
    "net_white": mat("#F2F2F2", 0.0, 0.8, alpha=0.32),
    "net_black": mat("#15171A", 0.0, 0.8, alpha=0.30),   # ball-stop netting
    "chainlink": mat("#50565C", 0.4, 0.6, alpha=0.34),
    "post_black": mat("#1E2023", 0.4, 0.5),
    "galv": mat("#A3A8AD", 0.7, 0.38),            # galvanised poles, fence posts
    "lamp_frame": mat("#5A5F65", 0.6, 0.45),
    "lamp_housing": mat("#3D4247", 0.5, 0.5),
    "lens_off": mat("#C9CED2", 0.2, 0.15),
    "lens_on": mat("#FFF7E4", 0.0, 0.3, emissive="#FFF3D6"),
    "alu": mat("#C9CED3", 0.65, 0.33),            # bleacher planks
    "alu_frame": mat("#8E959C", 0.6, 0.45),
    "concrete": mat("#BDB9B0", 0.0, 0.9),
    "concrete_dark": mat("#A29E95", 0.0, 0.9),
    "bu_red": mat("#C8102E", 0.05, 0.55),         # BU scarlet: walls, risers, press box
    "seat_grey": mat("#8F99A3", 0.2, 0.5),        # chair-back seats
    "seat_red": mat("#B51A24", 0.1, 0.5),
    "glass_dark": mat("#1D2830", 0.3, 0.15),
    "roof_dark": mat("#4A4F55", 0.2, 0.7),
    "board_black": mat("#111315", 0.1, 0.55),
    "letter_white": mat("#F4F5F6", 0.0, 0.5),
    "letter_red": mat("#E0262B", 0.0, 0.45, emissive="#5A0A0A"),
    "digit_amber": mat("#FF8F1F", 0.0, 0.4, emissive="#FF7A00"),
    "screen": mat("#18243A", 0.1, 0.3, emissive="#22385E"),
    "bench_red": mat("#A3222A", 0.1, 0.5),
    "ivy": mat("#3F5B2E", 0.0, 0.95),
    "paint_red": mat("#C41E2A", 0.0, 0.6),
    "rail_white": mat("#E8EAEC", 0.4, 0.4),
    "bench_seat": mat("#6E747B", 0.5, 0.45),
}


# --------------------------------------------------------------------------------------------
# 5x7 pixel font (for the scoreboard and press-box lettering)
# --------------------------------------------------------------------------------------------

FONT = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}


def text_on_z(m, text, cx, cy, z, pixel, material):
    """Letters on a +Z-facing plane at depth z, centred on (cx, cy), read from +Z.
    A viewer facing that plane has model +X on their right, so the text runs toward +X."""
    cols = len(text) * 6 - 1
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
                rect(m, "z", z, cx + u0, cx + u1, y1 - pixel, y1, material, 1)


# --------------------------------------------------------------------------------------------
# Placement: build each prop in its own frame, then drop it into the field frame
# --------------------------------------------------------------------------------------------

def place(dst, src, x, z, theta_deg, y=0.0):
    """Append `src` rotated so its +Z points `theta_deg` clockwise (seen from above) of the
    destination's +Z, then moved to (x, y, z). +X is left of +Z in both frames."""
    t = math.radians(theta_deg)
    c, s = math.cos(t), math.sin(t)

    def rot(p):
        return (p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c)

    for material, (pos, nrm, idx) in src.prims.items():
        dpos, dnrm, didx = dst.prims.setdefault(material, [[], [], []])
        base = len(dpos)
        for p in pos:
            q = rot(p)
            dpos.append((q[0] + x, q[1] + y, q[2] + z))
        dnrm.extend(rot(n) for n in nrm)
        didx.extend(base + i for i in idx)


class FieldFrame:
    """lng/lat -> the field frame (x = metres left of the long axis, z = metres along it)."""

    def __init__(self, anchor, bearing):
        self.anchor = anchor
        self.bearing = bearing
        r = math.radians(bearing)
        self.f = (math.sin(r), math.cos(r))
        self.l = (-math.cos(r), math.sin(r))
        self.kx = M_PER_DEG * math.cos(math.radians(anchor[1]))

    def xz(self, p):
        e = (p[0] - self.anchor[0]) * self.kx
        n = (p[1] - self.anchor[1]) * M_PER_DEG
        return (e * self.l[0] + n * self.l[1], e * self.f[0] + n * self.f[1])

    def theta(self, bearing):
        return (bearing - self.bearing) % 360


def bar(m, p0, p1, w, material):
    """A square bar between two points."""
    m.beam(p0, p1, w, w, material)


# --------------------------------------------------------------------------------------------
# Goals
# --------------------------------------------------------------------------------------------

def build_hockey_goal():
    """FIH goal: 3.66 m x 2.14 m inside, 1.2 m deep, 0.46 m back and side boards. Mouth on z = 0."""
    m = Mesh()
    hw, h, d, pw = 1.83, 2.14, 1.2, 0.05
    for sx in (-1, 1):
        x0 = sx * hw
        m.box(*sorted((x0, x0 + sx * pw)), 0.0, h + pw, -pw * 1.5, 0.0, "goal_white")
        m.box(*sorted((x0 + sx * 0.002, x0 + sx * 0.03)), 0.0, 0.46, -d, -pw * 1.5, "goal_board")   # side boards
        bar(m, (x0 + sx * 0.03, h, -0.05), (x0 + sx * 0.03, h, -d), 0.035, "goal_frame")
        bar(m, (x0 + sx * 0.03, 0.46, -d), (x0 + sx * 0.03, h, -d), 0.035, "goal_frame")
        rect(m, "x", x0 + sx * 0.035, -d, -0.05, 0.46, h, "net_white", sx)                    # side nets
    m.box(-hw - pw, hw + pw, h, h + pw, -pw * 1.5, 0.0, "goal_white")                          # crossbar
    m.box(-hw, hw, 0.0, 0.46, -d - 0.03, -d, "goal_board")                                      # backboard
    bar(m, (-hw - 0.03, h, -d), (hw + 0.03, h, -d), 0.035, "goal_frame")
    rect(m, "z", -d, -hw, hw, 0.46, h, "net_white", 1)                                          # back net
    m.poly([(-hw, h, 0), (hw, h, 0), (hw, h, -d), (-hw, h, -d)], "net_white", outward=(0, 1, 0))  # roof net
    return m


def build_soccer_goal():
    """7.32 m x 2.44 m inside, 0.12 m posts; net 1.0 m back at the top, 2.0 m at the ground."""
    m = Mesh()
    hw, h, pr = 3.66, 2.44, 0.06
    for sx in (-1, 1):
        x = sx * (hw + pr)
        cylinder(m, (x, 0, -pr), (x, h + 2 * pr, -pr), pr, "goal_white", seg=10)
        bar(m, (x, h + pr, -pr), (x, h + pr, -1.0), 0.05, "goal_frame")        # top stays
        bar(m, (x, h + pr, -1.0), (x, 0.03, -2.0), 0.05, "goal_frame")          # rear legs
        bar(m, (x, 0.03, -0.1), (x, 0.03, -2.0), 0.05, "goal_frame")            # ground bars
        m.poly([(x, 0, -0.1), (x, h, -0.1), (x, h, -1.0), (x, 0, -2.0)], "net_white", outward=(sx, 0, 0))
    cylinder(m, (-hw - 2 * pr, h + pr, -pr), (hw + 2 * pr, h + pr, -pr), pr, "goal_white", seg=10)
    bar(m, (-hw - pr, h + pr, -1.0), (hw + pr, h + pr, -1.0), 0.05, "goal_frame")
    bar(m, (-hw - pr, 0.03, -2.0), (hw + pr, 0.03, -2.0), 0.05, "goal_frame")
    m.poly([(-hw, h, -1.0), (hw, h, -1.0), (hw, 0, -2.0), (-hw, 0, -2.0)], "net_white", outward=(0, 0.5, -1))
    m.poly([(-hw, h + pr, -0.1), (hw, h + pr, -0.1), (hw, h + pr, -1.0), (-hw, h + pr, -1.0)], "net_white",
           outward=(0, 1, 0))
    return m


# --------------------------------------------------------------------------------------------
# New Balance Field: aluminium bleachers (500 seats) and the scoreboard
# --------------------------------------------------------------------------------------------

def build_nbf_bleachers():
    """Five rows of aluminium benches, 46 m long (5 x 46 m / 0.46 m a seat = 500 seats), with a
    top walkway, guard rails, red riser panels and a chain-link fence in front. Faces +Z;
    origin = centre of the footprint."""
    m = Mesh()
    hl = 23.0
    rows, tread, rise = 5, 0.6, 0.4
    z_front = 1.4
    aisles = (-11.5, 11.5)
    aisle_w = 1.2

    def spans():
        out, x = [], -hl
        for a in aisles:
            out.append((x, a - aisle_w / 2))
            x = a + aisle_w / 2
        out.append((x, hl))
        return out

    top = 0.25 + rise * rows
    for k in range(rows + 1):
        z1 = z_front - tread * k
        z0 = z1 - tread
        y_foot = 0.25 + rise * k
        # foot boards (full length, the aisles too) and the red riser below them
        m.box(-hl, hl, y_foot - 0.05, y_foot, z0, z1, "alu", skip=("-y",))
        rect(m, "z", z1 + 0.002, -hl, hl, max(0.0, y_foot - rise), y_foot - 0.05, "bu_red", 1)
        if k < rows:
            for x0, x1 in spans():  # bench planks
                m.box(x0, x1, y_foot + 0.40, y_foot + 0.45, z0 + 0.05, z0 + 0.30, "alu")
    # Walkway, back and side rails, and understructure frames every ~3 m.
    zb = z_front - tread * (rows + 1)
    for y in (top + 0.55, top + 1.07):
        m.box(-hl, hl, y - 0.03, y, zb - 0.03, zb, "alu_frame")
    for sx in (-1, 1):
        x = sx * hl
        bar(m, (x, 0.25 + 1.07, z_front), (x, top + 1.07, zb), 0.04, "alu_frame")
        bar(m, (x, 0.25 + 0.55, z_front), (x, top + 0.55, zb), 0.04, "alu_frame")
    n_frames = 16
    for i in range(n_frames + 1):
        x = -hl + 2 * hl * i / n_frames
        m.box(x - 0.03, x + 0.03, 0.0, top + 1.07, zb - 0.06, zb, "alu_frame")         # back post
        bar(m, (x, 0.0, z_front - 0.05), (x, top - 0.05, zb + 0.05), 0.06, "alu_frame")   # stringer
        m.box(x - 0.03, x + 0.03, 0.0, top, zb + 0.6, zb + 0.66, "alu_frame")
    # Chain-link fence in front of the front row (as in the photos).
    zf = z_front + 0.6
    rect(m, "z", zf, -hl - 1, hl + 1, 0.0, 1.2, "chainlink", 1)
    m.box(-hl - 1, hl + 1, 1.17, 1.22, zf - 0.025, zf + 0.025, "galv")
    for i in range(17):
        x = -hl - 1 + (2 * hl + 2) * i / 16
        cylinder(m, (x, 0, zf), (x, 1.22, zf), 0.025, "galv", seg=6)
    return m


def build_nbf_scoreboard():
    """Black board 7.6 m x 4.3 m on two posts, 'NEW BALANCE FIELD' in red across the top, amber
    clock and scores below (as in the goterriers.com photo). Faces +Z; origin at ground centre."""
    m = Mesh()
    w, y0, y1, t = 3.8, 2.6, 6.9, 0.3
    for sx in (-1, 1):
        m.box(sx * 2.0 - 0.15, sx * 2.0 + 0.15, 0.0, y0 + 0.4, -t - 0.3, -t, "post_black")
    m.box(-w, w, y0, y1, -t, 0.0, "board_black")
    zf = 0.004
    text_on_z(m, "NEW BALANCE FIELD", 0.0, y1 - 0.55, zf, 0.105, "letter_red")
    rect(m, "z", zf, -w + 0.12, w - 0.12, y1 - 1.0, y1 - 0.96, "letter_red", 1)     # red rule
    text_on_z(m, "00:18", 0.0, y1 - 1.55, zf, 0.085, "digit_amber")
    for cx, txt in ((-2.6, "5"), (2.6, "1")):  # home (Terriers) on the left
        text_on_z(m, txt, cx, y1 - 1.95, zf, 0.11, "digit_amber")
    for cx in (2.6, -2.6, 1.2, -1.2):
        text_on_z(m, "18", cx, y0 + 0.9, zf, 0.06, "digit_amber")
    text_on_z(m, "BU", 0.0, y0 + 1.2, zf, 0.13, "letter_red")
    return m


def build_net(m, a, b, height, pole_spacing=11.0):
    """Ball-stop netting from a to b (x, z on the ground): black poles, a net and a top cable."""
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    n = max(1, math.ceil(L / pole_spacing))
    ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    for i in range(n + 1):
        x, z = a[0] + ux * L * i / n, a[1] + uz * L * i / n
        m.box(x - 0.1, x + 0.1, 0.0, height, z - 0.1, z + 0.1, "post_black")
    nx, nz = -uz, ux
    pts = [(a[0], 0.6, a[1]), (b[0], 0.6, b[1]), (b[0], height - 0.1, b[1]), (a[0], height - 0.1, a[1])]
    m.poly(pts, "net_black", outward=(nx, 0, nz))
    bar(m, (a[0], height - 0.1, a[1]), (b[0], height - 0.1, b[1]), 0.03, "post_black")


def build_fence(m, path, height, post_spacing=3.0):
    """Chain-link fence along a path of (x, z) points."""
    for a, b in zip(path, path[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 0.05:
            continue
        ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        m.poly([(a[0], 0.0, a[1]), (b[0], 0.0, b[1]), (b[0], height, b[1]), (a[0], height, a[1])], "chainlink",
               outward=(-uz, 0, ux))
        bar(m, (a[0], height, a[1]), (b[0], height, b[1]), 0.045, "galv")
        n = max(1, round(L / post_spacing))
        for i in range(n):
            x, z = a[0] + ux * L * i / n, a[1] + uz * L * i / n
            cylinder(m, (x, 0, z), (x, height + 0.05, z), 0.03, "galv", seg=6, caps=(False, True))
    x, z = path[-1]
    cylinder(m, (x, 0, z), (x, height + 0.05, z), 0.03, "galv", seg=6, caps=(False, True))


def build_wall(m, path, height, lettering=None):
    """Ivy-covered wall along a path of (x, z) points with a white rail on top; `lettering` in
    red block letters on the field side of its first segment (the field is at the origin)."""
    for a, b in zip(path, path[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, nz = -uz, ux
        if nx * -a[0] + nz * -a[1] < 0:  # make n face the field
            nx, nz = -nx, -nz
        t = 0.2
        quad = [(a[0] + nx * t, a[1] + nz * t), (b[0] + nx * t, b[1] + nz * t), (b[0] - nx * t, b[1] - nz * t), (a[0] - nx * t, a[1] - nz * t)]
        for (p0, p1), sign in ((quad[0:2], 1), (quad[2:4], -1)):
            m.poly([(p0[0], 0, p0[1]), (p1[0], 0, p1[1]), (p1[0], height, p1[1]), (p0[0], height, p0[1])], "ivy",
                   outward=(nx * sign, 0, nz * sign))
        m.poly([(q[0], height, q[1]) for q in quad], "ivy", outward=(0, 1, 0))
        for y in (height + 0.5, height + 1.0):
            bar(m, (a[0], y, a[1]), (b[0], y, b[1]), 0.05, "rail_white")
        n_posts = max(1, round(L / 2.5))
        for i in range(n_posts + 1):
            x, z = a[0] + ux * L * i / n_posts, a[1] + uz * L * i / n_posts
            bar(m, (x, height, z), (x, height + 1.0, z), 0.05, "rail_white")
    if lettering:
        a, b = path[0], path[1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, nz = -uz, ux
        if nx * -a[0] + nz * -a[1] < 0:
            nx, nz = -nx, -nz
        sign = Mesh()
        text_on_z(sign, lettering, 0.0, height * 0.55, 0.0, min(0.2, L * 0.8 / (len(lettering) * 6)), "paint_red")
        cx, cz = (a[0] + b[0]) / 2 + nx * 0.22, (a[1] + b[1]) / 2 + nz * 0.22
        place(m, sign, cx, cz, math.degrees(math.atan2(-nx, nz)))


# --------------------------------------------------------------------------------------------
# Nickerson Field: the grandstand (the old Braves Field pavilion), scoreboard, benches
# --------------------------------------------------------------------------------------------

STAND = {
    "front_wall": 1.2,     # red wall along the track
    "walk": 1.2,           # front walkway behind it
    "tread": 0.80,         # row depth
    "rise": 0.21,          # row rise (a shallow, single-deck pavilion, ~11-12 m at the back)
    "lower_rows": 19,
    "aisle": 2.6,          # cross-aisle between the tiers
    "aisle_step": 0.6,     # the upper tier starts a little above the aisle
    "section": 14.0,       # stair aisles about every 14 m
    "stair": 1.3,
}


def stand_profile():
    """[(d0, d1, y, tier)] rows from the front edge (d = metres back from the front)."""
    s = STAND
    rows, d, y = [], s["walk"], s["front_wall"]
    for _ in range(s["lower_rows"]):
        y += s["rise"]
        rows.append((d, d + s["tread"], y, "lower"))
        d += s["tread"]
    rows.append((d, d + s["aisle"], y, "aisle"))
    d += s["aisle"]
    y += s["aisle_step"]
    for _ in range(40):
        y += s["rise"]
        rows.append((d, d + s["tread"], y, "upper"))
        d += s["tread"]
    return rows


def slice_x(poly, z):
    """x-interval where the polygon crosses the line at depth z (largest span)."""
    xs = []
    for (x0, z0), (x1, z1) in zip(poly, poly[1:] + poly[:1]):
        if (z0 - z) * (z1 - z) <= 0 and z0 != z1:
            xs.append(x0 + (x1 - x0) * (z - z0) / (z1 - z0))
    return (min(xs), max(xs)) if len(xs) >= 2 else None


def build_grandstand(fp, press_box, red_seats, chairs):
    """The stand in its own frame: +Z toward the field, +X along it (left when facing the field),
    rows rising toward -Z. `fp` is the footprint in that frame; the front is its max z."""
    m = Mesh()
    s = STAND
    z_front = max(p[1] for p in fp)
    z_back = min(p[1] for p in fp)
    depth = z_front - z_back
    rows = [r for r in stand_profile() if r[1] <= depth + 0.01]
    # Stair-aisle positions along the stand (evenly spaced within its full length).
    xs_all = [p[0] for p in fp]
    xa, xb = min(xs_all), max(xs_all)
    n_sec = max(1, round((xb - xa) / s["section"]))
    stairs = [xa + (xb - xa) * i / n_sec for i in range(1, n_sec)]
    chair_x = sorted(chairs)
    prev_y = s["front_wall"]

    def span(d0, d1):
        a, b = slice_x(fp, z_front - d0 - 0.01), slice_x(fp, z_front - d1 + 0.01)
        if not a or not b:
            return None
        return max(a[0], b[0]) + 0.15, min(a[1], b[1]) - 0.15

    # Front wall (red) along the track.
    sp = span(0.0, 0.3)
    if sp:
        m.box(sp[0], sp[1], 0.0, s["front_wall"], z_front - 0.3, z_front, "bu_red", skip=("-y",))
        m.box(sp[0], sp[1], s["front_wall"] - 0.05, s["front_wall"], z_front - s["walk"], z_front - 0.3, "concrete", skip=("-y",))
    top_y, last = s["front_wall"], None
    for d0, d1, y, tier in rows:
        sp = span(d0, d1)
        if not sp or sp[1] - sp[0] < 2:
            continue
        x0, x1 = sp
        z1, z0 = z_front - d0, z_front - d1
        # Tread (concrete), riser, and the stepped end walls.
        m.poly([(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], "concrete", outward=(0, 1, 0))
        m.poly([(x0, prev_y, z1), (x1, prev_y, z1), (x1, y, z1), (x0, y, z1)], "concrete_dark", outward=(0, 0, 1))
        for x, sx in ((x0, -1), (x1, 1)):
            m.poly([(x, 0, z0), (x, 0, z1), (x, y, z1), (x, y, z0)], "concrete_dark", outward=(sx, 0, 0))
        prev_y = y
        top_y, last = y, (x0, x1, z0)
        if tier == "aisle":
            # Rail along the front of the upper tier.
            m.box(x0, x1, y + 1.0 + s["aisle_step"], y + 1.05 + s["aisle_step"], z0 - 0.02, z0 + 0.02, "galv")
            continue
        # Seats: chair-backs in the lower tier between the measured ends, red seats in the upper
        # tier round the measured block, aluminium benches elsewhere; gaps at the stair aisles.
        cuts = [x0] + [c for st in stairs for c in (st - s["stair"] / 2, st + s["stair"] / 2) if x0 < c < x1] + [x1]
        for a, b in zip(cuts[0::2], cuts[1::2]):
            if b - a < 0.6:
                continue
            zs = z0 + 0.12
            pieces = [(a, b, "bench")]
            if tier == "lower" and d0 > 3.5:
                pieces = split(a, b, chair_x[0], chair_x[1], "chair", "bench")
            if tier == "upper" and abs((z_front - d0) - red_seats[1]) < 3.4:
                pieces = [q for (pa, pb, kind) in pieces for q in split(pa, pb, red_seats[0] - 5, red_seats[0] + 5, "red", kind)]
            for pa, pb, kind in pieces:
                if pb - pa < 0.3:
                    continue
                if kind == "bench":
                    m.box(pa, pb, y + 0.40, y + 0.45, zs, zs + 0.28, "alu", skip=("-y",))
                else:
                    material = "seat_red" if kind == "red" else "seat_grey"
                    m.box(pa, pb, y + 0.40, y + 0.46, zs + 0.02, zs + 0.45, material, skip=("-y",))
                    m.box(pa, pb, y + 0.46, y + 0.85, zs, zs + 0.06, material, skip=("-y",))
    # Back wall down to the ground, with a rail on top.
    for (xp, zp), (xq, zq) in zip(fp, fp[1:] + fp[:1]):
        if min(zp, zq) > z_back + depth * 0.5 and abs(zp - zq) < 3:
            continue  # the front edge
        hp, hq = height_at(rows, z_front - zp, top_y), height_at(rows, z_front - zq, top_y)
        m.poly([(xp, 0, zp), (xq, 0, zq), (xq, hq + 1.1, zq), (xp, hp + 1.1, zp)], "concrete", outward=(0, 0, -1)
               if zp < z_back + depth * 0.5 else None)
    if last:
        x0, x1, z0 = last
        m.box(x0, x1, top_y + 1.05, top_y + 1.1, z0, z0 + 0.15, "concrete")
    build_press_box(m, press_box, top_y, z_back, fp, z_front)
    return m, top_y


def split(a, b, c0, c1, inside, outside):
    """Split [a, b] into the parts inside [c0, c1] (kind `inside`) and outside it."""
    out = []
    if a < c0:
        out.append((a, min(b, c0), outside))
    if b > c0 and a < c1:
        out.append((max(a, c0), min(b, c1), inside))
    if b > c1:
        out.append((max(a, c1), b, outside))
    return out


def height_at(rows, d, top):
    for d0, d1, y, _ in rows:
        if d0 <= d <= d1:
            return y
    return top if d > 0 else 0.0


def build_press_box(m, pos, top_y, z_back, fp, z_front):
    """Red box with a window band on the field side and 'BOSTON UNIVERSITY NICKERSON FIELD' on
    its fascia, standing on the back rows (a press box was mounted on the pavilion in 1960)."""
    cx = pos[0]
    span = slice_x(fp, z_back + 2.5) or (cx - 11, cx + 11)
    hw = 11.0
    cx = min(max(cx, span[0] + hw), span[1] - hw)
    zb = max(z_back + 0.4, slice_z_back(fp, cx) + 0.4)
    zf = zb + 4.6
    y0, y1 = top_y + 0.2, top_y + 3.6
    m.box(cx - hw, cx + hw, y0, y1, zb, zf, "bu_red", skip=("-y",))
    m.box(cx - hw - 0.3, cx + hw + 0.3, y1, y1 + 0.25, zb - 0.3, zf + 0.4, "roof_dark")
    m.box(cx - hw + 0.2, cx + hw - 0.2, y0 + 0.9, y0 + 2.3, zf, zf + 0.02, "glass_dark")
    for i in range(12):
        x = cx - hw + 0.2 + (2 * hw - 0.4) * i / 11
        m.box(x - 0.05, x + 0.05, y0 + 0.9, y0 + 2.3, zf, zf + 0.04, "bu_red")
    text_on_z(m, "BOSTON UNIVERSITY NICKERSON FIELD", cx, y1 - 0.55, zf + 0.01, 0.075, "letter_white")
    # Columns down to the rows below the front of the box.
    for x in (cx - hw + 0.5, cx, cx + hw - 0.5):
        m.box(x - 0.15, x + 0.15, top_y - 3.0, y0, zf - 0.4, zf - 0.1, "concrete_dark")


def slice_z_back(fp, x):
    zs = []
    for (x0, z0), (x1, z1) in zip(fp, fp[1:] + fp[:1]):
        if (x0 - x) * (x1 - x) <= 0 and x0 != x1:
            zs.append(z0 + (z1 - z0) * (x - x0) / (x1 - x0))
    return min(zs) if zs else min(p[1] for p in fp)


def build_video_scoreboard():
    """Video board about 12 m x 6.5 m on two red-clad legs, bottom 3.2 m up. Faces +Z."""
    m = Mesh()
    w, y0, y1 = 6.0, 3.2, 9.7
    for sx in (-1, 1):
        m.box(sx * 3.6 - 0.35, sx * 3.6 + 0.35, 0.0, y0 + 0.5, -0.9, -0.2, "bu_red")
    m.box(-w - 0.25, w + 0.25, y0 - 0.25, y1 + 0.25, -0.6, 0.0, "board_black")
    m.box(-w, w, y0, y1, 0.0, 0.02, "screen")
    m.box(-w - 0.25, w + 0.25, y1 + 0.25, y1 + 1.15, -0.6, 0.0, "bu_red")
    text_on_z(m, "BOSTON UNIVERSITY", 0.0, y1 + 0.70, 0.005, 0.09, "letter_white")
    return m


def build_team_bench():
    """10 m covered team bench: aluminium bench under a red shell, open toward +Z."""
    m = Mesh()
    hl = 5.0
    m.box(-hl, hl, 0.43, 0.48, -0.55, -0.15, "bench_seat")
    for i in range(6):
        x = -hl + 0.3 + (2 * hl - 0.6) * i / 5
        m.box(x - 0.04, x + 0.04, 0.0, 0.43, -0.45, -0.25, "galv")
    m.box(-hl - 0.1, hl + 0.1, 0.0, 2.2, -1.0, -0.9, "bench_red")           # back
    m.box(-hl - 0.1, hl + 0.1, 2.2, 2.28, -1.0, 0.3, "bench_red")           # roof
    for sx in (-1, 1):
        m.box(*sorted((sx * hl, sx * (hl + 0.1))), 0.0, 2.2, -1.0, 0.0, "bench_red")
    return m


# --------------------------------------------------------------------------------------------
# Light poles
# --------------------------------------------------------------------------------------------

def build_light_tower(height, cols, rows, lit):
    """Tapered galvanised pole, a lamp frame at the top and `cols` x `rows` floodlights facing +Z,
    aimed down at the field. Lamp-bank centre: 1.6 m below the top, ~0.9 m in front."""
    m = Mesh()
    base_r = 0.28 if height > 25 else 0.22
    cylinder(m, (0, 0, 0), (0, 0.6, 0), base_r + 0.25, "concrete", seg=12, caps=(False, True))
    cylinder(m, (0, 0.6, 0), (0, height - 2.6, 0), base_r, "galv", r1=base_r * 0.55, seg=12, caps=(False, False))
    pitch, gap = 0.62, 0.66
    w = (cols - 1) * gap
    hgt = (rows - 1) * pitch
    cy = height - 1.6
    # Frame: two vertical posts and a horizontal bar per lamp row.
    for sx in (-1, 1):
        bar(m, (sx * (w / 2 + 0.35), cy - hgt / 2 - 0.4, 0.45), (sx * (w / 2 + 0.35), cy + hgt / 2 + 0.4, 0.45), 0.09, "lamp_frame")
    bar(m, (0, height - 2.7, 0), (0, cy, 0.45), 0.16, "lamp_frame")      # knuckle to the frame
    for r in range(rows):
        y = cy - hgt / 2 + r * pitch
        bar(m, (-w / 2 - 0.35, y, 0.45), (w / 2 + 0.35, y, 0.45), 0.07, "lamp_frame")
        for c in range(cols):
            x = -w / 2 + c * gap
            tilt = math.radians(28)
            z0, z1 = 0.5, 0.5 + 0.42 * math.cos(tilt)
            yy = y - 0.42 * math.sin(tilt)
            # Housing (a short tilted drum) with the lens on its front face.
            cylinder(m, (x, y, z0), (x, yy, z1), 0.26, "lamp_housing", r1=0.29, seg=10, caps=(True, True),
                     cap_mat="lens_on" if lit else "lens_off")
    return m


# --------------------------------------------------------------------------------------------
# Field prop assemblies
# --------------------------------------------------------------------------------------------

def field_props(field):
    frame = FieldFrame(field["anchor"], field["bearing"])
    m = Mesh()
    builders = {
        "goal-hockey": build_hockey_goal,
        "goal-soccer": build_soccer_goal,
        "bleachers-nbf": build_nbf_bleachers,
        "scoreboard-nbf": build_nbf_scoreboard,
        "scoreboard-video": build_video_scoreboard,
        "bench": build_team_bench,
    }
    cache = {}
    info = {}
    for obj in field["objects"]:
        kind = obj["kind"]
        if kind in builders:
            if kind not in cache:
                cache[kind] = builders[kind]()
            x, z = frame.xz(obj["position"])
            place(m, cache[kind], x, z, frame.theta(obj["bearing"]))
        elif kind == "net":
            a, b = (frame.xz(p) for p in obj["path"])
            build_net(m, a, b, obj["height"])
        elif kind == "fence":
            build_fence(m, [frame.xz(p) for p in obj["path"]], obj["height"])
        elif kind == "wall":
            build_wall(m, [frame.xz(p) for p in obj["path"]], obj["height"], obj.get("lettering"))
        elif kind == "grandstand":
            # Stand frame: +Z toward the field (the field frame's +X), +X = -(field +Z), then
            # turned by the small angle that makes the footprint's front edge run along +X.
            def to_stand(p, d=0.0):
                x, z = frame.xz(p)
                xs, zs = -z, x
                return (xs * math.cos(d) + zs * math.sin(d), -xs * math.sin(d) + zs * math.cos(d))
            raw = [to_stand(p) for p in obj["footprint"]]
            edges = [(a, b) for a, b in zip(raw, raw[1:] + raw[:1]) if math.hypot(b[0] - a[0], b[1] - a[1]) > 30]
            a, b = max(edges, key=lambda e: e[0][1] + e[1][1])
            delta = math.atan2(b[1] - a[1], b[0] - a[0])
            if abs(delta) > math.pi / 2:
                delta -= math.copysign(math.pi, delta)
            fp = [to_stand(p, delta) for p in obj["footprint"]]
            if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(fp, fp[1:] + fp[:1])) < 0:
                fp = fp[::-1]
            chairs = [to_stand(p, delta)[0] for p in obj["chairs"]]
            stand, top = build_grandstand(fp, to_stand(obj["pressBox"], delta), to_stand(obj["redSeats"], delta), chairs)
            place(m, stand, 0.0, 0.0, -90.0 + math.degrees(delta))
            info["grandstand top (m)"] = round(top, 2)
            info["grandstand front-edge skew (deg)"] = round(math.degrees(delta), 2)
    return m, info


def write_glb(mesh, name, path):
    gltf = {
        "asset": {"version": "2.0", "generator": "flowcast make_field_models.py"},
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

    # Opaque materials first, translucent nets and fences last.
    order = sorted(mesh.prims, key=lambda k: ("alphaMode" in MATERIALS[k], k))
    for material in order:
        pos, nrm, idx = mesh.prims[material]
        if not idx:
            continue
        gltf["materials"].append({"name": material, **MATERIALS[material]})
        flat_p = [round(c, 4) for p in pos for c in p]
        flat_n = [c for n in nrm for c in n]
        pv = view(struct.pack(f"<{len(flat_p)}f", *flat_p), 34962)
        nv = view(struct.pack(f"<{len(flat_n)}f", *flat_n), 34962)
        big = len(pos) > 65535
        iv = view(struct.pack(f"<{len(idx)}{'I' if big else 'H'}", *idx), 34963)
        acc = gltf["accessors"]
        acc.append({"bufferView": pv, "componentType": 5126, "count": len(pos), "type": "VEC3",
                    "min": [round(min(p[a] for p in pos), 4) for a in range(3)],
                    "max": [round(max(p[a] for p in pos), 4) for a in range(3)]})
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
    data = json.loads(FIELDS.read_text())
    models = {}
    for field in data["fields"]:
        mesh, info = field_props(field)
        models[Path(field["props"]).stem] = mesh
        for k, v in info.items():
            print(f"  {field['name']}: {k} {v}")
    for height, cols, rows in ((21, 4, 3), (30, 6, 4)):
        models[f"field-light-{height}"] = build_light_tower(height, cols, rows, lit=False)
        models[f"field-light-{height}-lit"] = build_light_tower(height, cols, rows, lit=True)
    for name, mesh in models.items():
        path = OUT / f"{name}.glb"
        write_glb(mesh, name, path)
        print(f"wrote {path} ({mesh.triangle_count()} triangles, {path.stat().st_size / 1024:.0f} KB)")
        if "--check" in sys.argv:
            check_glb(path)


if __name__ == "__main__":
    main()
