"""Generate a low-poly sailing dinghy (420 / FJ / Tech-dinghy size) as self-contained GLBs.

Standard library only; reuses the mesh, loft and GLB helpers of make_vehicle_models.py. Plain
PBR colours, no textures, flat-shaded.

Conventions (same as the vehicles): metres at real scale, +Y up, the bow faces +Z, origin at the
centre of the hull on the waterline. Port is +X, starboard -X. The sails and boom are drawn
sheeted out to PORT (the boat on starboard tack); the map mirrors the model in X (scale -1) for
port tack, so one model covers both tacks.

Each colour comes in two trims: close-hauled (`sailboat*.glb`, boom ~12 degrees off the
centreline, for beating upwind) and broad reach (`sailboat*-run.glb`, boom well out, for the
downwind legs).

    python3 map-client/scripts/make_boat_models.py           # write every variant
    python3 map-client/scripts/make_boat_models.py --check   # also print bounds/tri counts
"""

import math
import sys

from make_vehicle_models import OUT, Loft, Mesh, add, check_glb, mat, norm, scale, sub, write_glb

# --------------------------------------------------------------------------------------------
# Dimensions (metres)
# --------------------------------------------------------------------------------------------

LENGTH = 4.2
BEAM = 1.6
STERN_Z, BOW_Z = -LENGTH / 2, LENGTH / 2
MAX_BEAM_Z = -0.3
# Hull cross-section levels, keel to gunwale: (y, half-width at the widest station).
LEVELS = [(-0.06, 0.12), (0.06, 0.62), (0.20, 0.76), (0.27, 0.79), (0.34, BEAM / 2)]
HULL_BANDS = ["bottom", "hull", "stripe", "hull"]  # material per band between levels
STATIONS_Z = [-2.1, -1.8, -1.2, -0.6, -0.3, 0.2, 0.7, 1.2, 1.6, 1.9, 2.1]
COCKPIT = (-1.85, 0.55)  # open cockpit between these z
COCKPIT_FLOOR = 0.14
SIDE_DECK = 0.09  # width of the side decks either side of the cockpit

MAST_Z = 0.75
MAST_TOP = 6.3  # ~6 m of mast above the deck
BOOM_Y = 1.05
BOOM_LENGTH = 2.5
FORESTAY_Y = 4.9  # where the forestay and shrouds meet the mast
JIB_TACK = (0.0, 0.45, 1.98)
JIB_FOOT = 1.95

TRIMS = {
    # boom and jib angles off the centreline (degrees, out to port)
    "close": (12.0, 9.0),
    "run": (58.0, 38.0),
}

VARIANTS = {
    # name: (hull, stripe, cockpit)
    "sailboat": ("#F4F4F1", "#CC0000", "#C9CDD1"),        # white with a BU-red stripe
    "sailboat-navy": ("#1F2B47", "#F4F4F1", "#AEB5BD"),   # navy with a white stripe
    "sailboat-green": ("#F4F4F1", "#1E7A4C", "#C9CDD1"),  # white with a green stripe
}


# deck.gl lights models with plain directional lights (no sky), so the shaded side of a white
# sail goes grey; a little emissive keeps white things reading as white.
LIFT = "#5A5A58"


def materials(hull, stripe, cockpit):
    white = hull == "#F4F4F1"
    return {
        "hull": mat(hull, 0.05, 0.35, emissive=LIFT if white else None),
        "stripe": mat(stripe, 0.05, 0.4),
        "bottom": mat("#8E9AA3", 0.05, 0.6),
        "deck": mat("#ECEDEA" if white else "#F7F7F4", 0.05, 0.45, emissive=LIFT),
        "cockpit": mat(cockpit, 0.0, 0.85),
        "sail": mat("#FAFAF6", 0.0, 0.8, emissive="#707070"),
        "insignia": mat(stripe if stripe != "#F4F4F1" else "#CC0000", 0.0, 0.7),
        "spar": mat("#C3C8CD", 0.3, 0.4),
        "rigging": mat("#3B4045", 0.3, 0.6),
        "wood": mat("#9A6A3A", 0.0, 0.6),
        "rudder": mat("#E9E9E5", 0.05, 0.5),
    }


# --------------------------------------------------------------------------------------------
# Hull
# --------------------------------------------------------------------------------------------

def plan_factor(z):
    """Half-width scale along the hull: a slightly narrower transom, a fine bow."""
    if z <= MAX_BEAM_Z:
        return 1 - 0.22 * ((MAX_BEAM_Z - z) / (MAX_BEAM_Z - STERN_Z)) ** 2
    f = (z - MAX_BEAM_Z) / (BOW_Z - MAX_BEAM_Z)
    return max(0.03, (1 - f * f) ** 0.75)


def rise(z):
    """(keel rocker, sheer) at z: the forefoot lifts out of the water, the bow sheer rises."""
    bow = max(0.0, (z - 0.4) / (BOW_Z - 0.4))
    stern = max(0.0, (STERN_Z + 0.6 - z) / 0.6)
    sheer = max(0.0, (z - MAX_BEAM_Z) / (BOW_Z - MAX_BEAM_Z))
    return 0.30 * bow * bow + 0.05 * stern, 0.12 * sheer * sheer


def station(z):
    f = plan_factor(z)
    rocker, sheer = rise(z)
    y_keel, y_gun = LEVELS[0][0], LEVELS[-1][0]
    pts = []
    for y, hw in LEVELS:
        frac = (y - y_keel) / (y_gun - y_keel)
        pts.append((hw * f, y + rocker * (1 - frac) + sheer * frac, 0.0))
    return (z, pts)


def gunwale(z):
    """Half-width and height of the gunwale at z."""
    hw, y, _ = station(z)[1][-1]
    return hw, y


def build_hull(m):
    loft = Loft(LEVELS, [station(z) for z in STATIONS_Z])

    def material(kind, band, side, z):
        if kind == "side":
            return HULL_BANDS[band]
        if kind == "bottom":
            return "bottom"
        return None if COCKPIT[0] < z < COCKPIT[1] else "deck"  # the cockpit is built below

    loft.build(m, material, cap_start=lambda band: HULL_BANDS[band], cap_end=lambda band: HULL_BANDS[band])

    # Open cockpit: side decks, sloping inner walls, a floor and bulkheads fore and aft.
    zs = [z for z in STATIONS_Z if COCKPIT[0] <= z <= COCKPIT[1]]
    inner = []  # (z, inner half-width at the deck, gunwale y, inner half-width at the floor)
    for z in zs:
        hw, y = gunwale(z)
        inner.append((z, hw - SIDE_DECK, y, (hw - SIDE_DECK) * 0.84))
    for (z0, i0, y0, f0), (z1, i1, y1, f1) in zip(inner, inner[1:]):
        hw0, _ = gunwale(z0)
        hw1, _ = gunwale(z1)
        for s in (1, -1):
            m.poly([(s * hw0, y0, z0), (s * hw1, y1, z1), (s * i1, y1, z1), (s * i0, y0, z0)], "deck", outward=(0, 1, 0))
            m.poly([(s * i0, y0, z0), (s * i1, y1, z1), (s * f1, COCKPIT_FLOOR, z1), (s * f0, COCKPIT_FLOOR, z0)],
                   "cockpit", outward=(-s, 0.3, 0))
        m.poly([(f0, COCKPIT_FLOOR, z0), (f1, COCKPIT_FLOOR, z1), (-f1, COCKPIT_FLOOR, z1), (-f0, COCKPIT_FLOOR, z0)],
               "cockpit", outward=(0, 1, 0))
    for (z, i, y, f), facing in ((inner[0], 1), (inner[-1], -1)):
        m.poly([(i, y, z), (-i, y, z), (-f, COCKPIT_FLOOR, z), (f, COCKPIT_FLOOR, z)], "deck", outward=(0, 0, facing))
    # The deck between the cockpit's ends and the nearest loft stations.
    for za, zb in ((COCKPIT[0], zs[0]), (zs[-1], COCKPIT[1])):
        if abs(za - zb) > 1e-6:
            (ha, ya), (hb, yb) = gunwale(za), gunwale(zb)
            m.poly([(ha, ya, za), (hb, yb, zb), (-hb, yb, zb), (-ha, ya, za)], "deck", outward=(0, 1, 0))

    # Centreboard trunk and a thwart.
    m.box(-0.035, 0.035, COCKPIT_FLOOR, 0.40, -0.25, 0.55, "deck")
    hw, y = gunwale(-0.35)
    m.box(-(hw - SIDE_DECK), hw - SIDE_DECK, 0.30, 0.34, -0.45, -0.25, "deck")

    # Rudder hung on the transom, and the tiller over the aft deck into the cockpit.
    _, y_t = gunwale(STERN_Z)
    m.box(-0.018, 0.018, -0.02, y_t + 0.10, STERN_Z - 0.30, STERN_Z - 0.02, "rudder")
    m.beam((0.0, y_t + 0.08, STERN_Z - 0.12), (0.0, y_t + 0.16, -1.05), 0.045, 0.035, "wood")


# --------------------------------------------------------------------------------------------
# Rig
# --------------------------------------------------------------------------------------------

def sheeted(origin, length, angle_deg, dy=0.0):
    """Point `length` aft of `origin` (or forward, if length < 0), swung `angle_deg` out to port."""
    a = math.radians(angle_deg)
    return (origin[0] + length * math.sin(a), origin[1] + dy, origin[2] - length * math.cos(a))


def sail(m, luff_foot, luff_head, clew, camber, rows=6, cols=4, insignia_rows=0):
    """A cambered triangular sail, drawn as two shells (one per side) so it lights from both.
    Rows run up the luff; the leech converges on the head. The belly bulges toward +X (port,
    where the sails are sheeted: the leeward side)."""
    grid = []
    for r in range(rows + 1):
        h = r / rows
        luff = add(luff_foot, scale(sub(luff_head, luff_foot), h))
        leech = add(clew, scale(sub(luff_head, clew), h))
        chord = sub(leech, luff)
        length = math.hypot(chord[0], chord[2])
        side = norm((chord[2], 0.0, -chord[0])) if length > 1e-6 else (1.0, 0.0, 0.0)
        if side[0] < 0:
            side = scale(side, -1)
        row = []
        for c in range(cols + 1):
            u = c / cols
            bulge = camber * length * 6.75 * u * (1 - u) ** 2  # deepest a third of the way back
            row.append(add(add(luff, scale(chord, u)), scale(side, bulge)))
        grid.append(row)
    for r in range(rows):
        material = "insignia" if r >= rows - insignia_rows else "sail"
        for c in range(cols):
            a, b, cc, d = grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]
            for tri in ((a, b, cc), (a, cc, d)):
                m.poly(list(tri), material, offset=0.005)
                m.poly(list(tri)[::-1], material, offset=0.005)


def build_rig(m, boom_deg, jib_deg):
    m.beam((0.0, COCKPIT_FLOOR, MAST_Z), (0.0, MAST_TOP, MAST_Z), 0.075, 0.09, "spar")
    gooseneck = (0.0, BOOM_Y, MAST_Z - 0.05)
    boom_end = sheeted(gooseneck, BOOM_LENGTH, boom_deg)
    m.beam(gooseneck, boom_end, 0.06, 0.07, "spar")
    # Mainsail: luff up the back of the mast, foot along the boom.
    sail(m, (0.0, BOOM_Y + 0.06, MAST_Z - 0.06), (0.0, MAST_TOP - 0.1, MAST_Z - 0.06),
         add(boom_end, (0.0, 0.06, 0.0)), camber=0.09, rows=7, insignia_rows=1)
    # Jib on the forestay, its clew sheeted to the side deck.
    hound = (0.0, FORESTAY_Y, MAST_Z + 0.05)
    head = add(JIB_TACK, scale(sub(hound, JIB_TACK), 0.88))
    sail(m, JIB_TACK, head, sheeted(JIB_TACK, JIB_FOOT, jib_deg, dy=0.12), camber=0.10, rows=5)
    # Standing rigging: forestay and two shrouds.
    m.beam((0.0, JIB_TACK[1] - 0.02, BOW_Z - 0.05), hound, 0.014, 0.014, "rigging")
    for s in (1, -1):
        hw, y = gunwale(MAST_Z - 0.25)
        m.beam((s * (hw - 0.02), y, MAST_Z - 0.25), (0.0, FORESTAY_Y, MAST_Z), 0.014, 0.014, "rigging")
    # Mainsheet from the boom end down to the transom.
    _, y_t = gunwale(STERN_Z + 0.2)
    m.beam(sheeted(gooseneck, BOOM_LENGTH * 0.92, boom_deg), (0.0, y_t, STERN_Z + 0.25), 0.012, 0.012, "rigging")


def build_boat(trim):
    m = Mesh()
    build_hull(m)
    build_rig(m, *TRIMS[trim])
    return m


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for trim, suffix in (("close", ""), ("run", "-run")):
        mesh = build_boat(trim)
        for name, colours in VARIANTS.items():
            path = OUT / f"{name}{suffix}.glb"
            write_glb(mesh, name, path, materials(*colours))
            print(f"wrote {path} ({mesh.triangle_count()} triangles)")
            if "--check" in sys.argv:
                check_glb(path)


if __name__ == "__main__":
    main()
