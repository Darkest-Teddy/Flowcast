"""Signs on the buildings of Kenmore Square and Comm Ave: WHOOP's rooftop letters on One Kenmore
Square, next to the Citgo sign, and the shop signs of the well-known restaurants along the street.

Each sign is placed flush on the modelled facade it hangs on: the restaurant (an OpenStreetMap
node, or a position read off photos where OSM has none) is matched to the modelled building it is
in (map-client/public/data/building-footprints.json), and the sign goes on that building's wall
facing the restaurant's street (OSM `addr:street`), centred on the restaurant, 0.15 m proud of the
model's wall (models stand WALL_OUT outside their footprints). Its height comes from the model's
shopfront (`storefront` in building-models.json, written by make_building_models.py): on the
shop storey's sign band, or above the canopy where the shopfront has one. WHOOP's letters stand on
the roof of the building's glass top storeys (its `volumes`), where the photos show them.

Names, cuisines and hours come from OSM (Overpass, cached in data-pipeline/.cache/overpass with
the pipeline's User-Agent and retries). The list is curated: places open as of October 2026,
checked against recent listings (see VERIFIED). Colours and lettering are brand-like (a clean
name sign in the brand's colours, no logos); the app draws them (map-client/src/layers/signs.ts).

Writes map-client/public/data/signs.json. Run after make_building_models.py:
    python3 data-pipeline/make_signs.py
"""

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make_building_models as mbm  # noqa: E402  (Overpass cache, streets, WALL_OUT)

ROOT = HERE.parent
OUT = ROOT / "map-client" / "public" / "data" / "signs.json"
MANIFEST = ROOT / "map-client" / "public" / "data" / "building-models.json"
FOOTPRINTS = ROOT / "map-client" / "public" / "data" / "building-footprints.json"

PROUD = 0.15             # m in front of the model's wall, so the sign never z-fights it
SIGN_H = 0.8             # m, a shop fascia sign
SIGN_BAND = 12 / 64      # the top of the shop storey that is its sign band (make_building_models B_SHOP)
CANOPY_TOP = 0.3         # a canopy's top sits this far under the shop storey line
DEFAULT_SHOP_TOP = 4.4   # m, where a building has no modelled shopfront

FOOD_BBOX = "42.3455,-71.1240,42.3530,-71.0920"
Q_FOOD = f"""[out:json][timeout:120];
(
  nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|ice_cream)$"]["name"]({FOOD_BBOX});
  nwr["shop"~"^(bakery|coffee)$"]["name"]({FOOD_BBOX});
);
out center tags;"""

# Where each listing was checked open (October 2026). Closed since and left out: Dugout Cafe
# (722 Comm Ave, closed Jan 2026, BU Today 15 Jan 2026) and Blue Ribbon Brasserie (528 Comm Ave,
# closed Aug 2025, Boston.com 2 Sep 2025).
VERIFIED = {
    "india-quality": "BU Today, 'Getting to know your neighborhood: Kenmore Square' (8 Oct 2026)",
    "the-kenmore": "BU Today, Kenmore Square guide (8 Oct 2026); Yelp listing (Jun 2026)",
    "mcdonalds-kenmore": "Yelp listing (Oct 2026), mcdonalds.com location 17677",
    "dunkin-kenmore": "Dunkin' store locator, 530 Commonwealth Ave (store 339667)",
    "cornwalls": "BU Today, Kenmore Square guide (8 Oct 2026); Yelp listing (Jul 2026)",
    "bbq-chicken": "Yelp listing (Aug 2026); Daily Free Press (Mar 2026)",
    "el-jefes-kenmore": "eljefestaqueria.com/locations: 533 Commonwealth Ave, 8 am - 3 am",
    "noodle-street": "noodlestreet.com; Tripadvisor (2026)",
    "insomnia-cookies": "Yelp listing (Oct 2026); insomniacookies.com store 1072",
    "university-grill": "Yelp listing (Oct 2026); ugrillboston.com",
    "pavement": "Yelp listing (Oct 2026)",
    "nud-pob": "Yelp listing (Oct 2026)",
    "taco-bell-cantina": "Yelp listing (Jun 2026); Daily Free Press (21 Sep 2026)",
    "chipotle": "Chipotle locator, 876 Commonwealth Ave; Daily Free Press (21 Sep 2026)",
    "otto": "Yelp listing (Oct 2026), 888 Commonwealth Ave",
    "life-alive": "lifealive.com/location/brookline (7:30 am - 9 pm)",
    "sunset-cantina": "Yelp listing (Aug 2026), 916 Commonwealth Ave",
    "raising-canes": "Raising Cane's locator, 949 Commonwealth Ave",
    "el-jefes-bu": "eljefestaqueria.com; Yelp listing (Jul 2026), 957 Commonwealth Ave",
    "t-anthonys": "BU Today, 'National Pizza Day' (2025); tanthonypizzeria.com",
}

# The signs. `osm`: the restaurant's OSM node (name, cuisine, hours, position); `at`: [lng, lat]
# read off photos where OSM has no node (then `building` and `address` say where). `width`: the
# sign's length along the wall (m; shortened if the wall is shorter). Styles: `frame` "panel" (a
# lit box or painted fascia: `bg` behind `fg` lettering) or "letters" (lit channel letters straight
# on the wall); `font` one of the app's font families (signs.ts); `fg2` colours the text after
# `split` characters (two-colour wordmarks).
SIGNS = [
    # Kenmore Square
    dict(id="india-quality", osm="node/7775144117", text="INDIA QUALITY", width=5.2,
         style=dict(frame="panel", bg="#7d1418", fg="#f4d58d", font="serif", weight=700)),
    dict(id="the-kenmore", osm="node/7776200191", text="THE KENMORE", width=4.6,
         style=dict(frame="panel", bg="#141414", fg="#f1e6cf", font="serif", weight=700, spacing=0.12)),
    dict(id="mcdonalds-kenmore", osm="node/2367929358", text="McDonald's", width=4.2,
         style=dict(frame="panel", bg="#da291c", fg="#ffc72c", font="rounded", weight=800)),
    dict(id="dunkin-kenmore", osm="node/2350393263", text="DUNKIN'", width=3.4,
         style=dict(frame="letters", fg="#ff671f", fg2="#da1884", split=4, font="rounded", weight=900)),
    dict(id="cornwalls", osm="node/12045953853", text="Cornwall's", width=4.4,
         style=dict(frame="panel", bg="#123b2a", fg="#e8c66a", font="serif", weight=700, italic=True)),
    dict(id="bbq-chicken", osm="node/1975218212", text="bb.q CHICKEN", width=4.0,
         style=dict(frame="panel", bg="#e2231a", fg="#ffffff", font="sans", weight=800)),
    # One Kenmore Square's shopfront at its east end, by Vinodivino (Commons photo, Nov 2025).
    dict(id="el-jefes-kenmore", at=[-71.096478, 42.349102], building="way/1188211556", street="Commonwealth Avenue",
         name="El Jefe's Taqueria", amenity="fast_food", cuisine="mexican", address="533 Commonwealth Avenue",
         hours="Mo-Su 08:00-03:00", website="https://www.eljefestaqueria.com/", text="EL JEFE'S TAQUERIA", width=5.2,
         style=dict(frame="panel", bg="#111111", fg="#ffd200", font="condensed", weight=800)),
    # Comm Ave by BU
    dict(id="noodle-street", osm="relation/9686032", text="NOODLE STREET", width=4.6,
         style=dict(frame="panel", bg="#1f7a3a", fg="#ffffff", font="sans", weight=800)),
    dict(id="insomnia-cookies", osm="node/4738685923", text="Insomnia Cookies", width=4.4,
         style=dict(frame="panel", bg="#0f2a5f", fg="#ffffff", font="script", weight=700)),
    dict(id="university-grill", osm="node/4738685924", text="UNIVERSITY GRILL", width=4.6,
         style=dict(frame="panel", bg="#b3141b", fg="#ffffff", font="condensed", weight=800)),
    dict(id="pavement", osm="node/1977416124", text="PAVEMENT", width=3.6,
         style=dict(frame="panel", bg="#151515", fg="#ffffff", font="sans", weight=700, spacing=0.22)),
    dict(id="nud-pob", osm="node/1456474145", text="NUD POB", width=3.4,
         style=dict(frame="panel", bg="#e8a317", fg="#3a1c08", font="serif", weight=700)),
    dict(id="taco-bell-cantina", osm="node/9342177337", text="TACO BELL CANTINA", width=5.0,
         style=dict(frame="panel", bg="#5b2a86", fg="#ffffff", font="sans", weight=800)),
    dict(id="chipotle", osm="node/14287602379", address="876 Commonwealth Avenue", text="CHIPOTLE", width=4.0,
         style=dict(frame="panel", bg="#7a1712", fg="#fbf3e6", font="sans", weight=800, spacing=0.1)),
    dict(id="otto", osm="node/1972927835", name="OTTO Pizza", address="888 Commonwealth Avenue", text="OTTO PIZZA", width=3.8,
         style=dict(frame="panel", bg="#f4efe4", fg="#111111", fg2="#c8102e", split=4, font="sans", weight=900)),
    dict(id="life-alive", osm="node/1978317372", text="LIFE ALIVE", width=3.8,
         style=dict(frame="panel", bg="#4f7f2a", fg="#fdf6e3", font="rounded", weight=800)),
    dict(id="sunset-cantina", osm="node/3445717462", address="916 Commonwealth Avenue", text="SUNSET CANTINA", width=4.8,
         style=dict(frame="panel", bg="#9b1b1e", fg="#ffb347", font="serif", weight=700)),
    dict(id="raising-canes", osm="node/815754376", text="Raising Cane's", width=4.6,
         style=dict(frame="panel", bg="#c8102e", fg="#ffffff", font="script", weight=700)),
    dict(id="el-jefes-bu", osm="node/11165170305", text="EL JEFE'S TAQUERIA", width=5.2,
         style=dict(frame="panel", bg="#111111", fg="#ffd200", font="condensed", weight=800)),
    dict(id="t-anthonys", osm="node/1978954424", text="T. ANTHONY'S PIZZERIA", width=5.4,
         style=dict(frame="panel", bg="#0b5e34", fg="#ffffff", fg2="#ffffff", font="serif", weight=700)),
]

# WHOOP, One Kenmore Square (545 Commonwealth Ave; WHOOP's headquarters since July 2023).
# Measured off two Wikimedia Commons photos taken from Kenmore Square, File:Whoop (54924676654).jpg
# (8 Nov 2025) and File:Whoop headquarters and new Citgo sign frame September 2026.jpg (7 Sep
# 2026), against the OSM footprint: white-grey channel letters, a light geometric sans, standing on
# the roof of the glass top storeys at their Comm Ave (south) edge, from where the facade starts to
# round its south-west corner about 22 m east; the letters are about half the height of the two
# glass storeys, so about 4 m.
WHOOP = dict(
    id="whoop", building="way/1188211556", text="WHOOP", centre_lng=-71.096815, width=22.0, height=4.0,
    name="WHOOP", subtitle="One Kenmore Square · WHOOP headquarters",
    style=dict(frame="letters", fg="#e4e7ea", font="whoop", weight=300),
    source=dict(
        position="Wikimedia Commons, File:Whoop (54924676654).jpg (Nov 2025) and File:Whoop headquarters and new Citgo sign "
                 "frame September 2026.jpg (Sep 2026), registered to OSM way/1188211556 (One Kenmore Square, tagged Whoop)",
        details="Boston Globe, 14 Jul 2023 ('You've seen the sign over Kenmore Square, now see inside Whoop's new HQ'): "
                "eight storeys at One Kenmore Square; Boston Globe, 27 May 2026: 'the tall white all-caps logo on Whoop's "
                "sign' overtakes the Citgo sign from several vantage points; BU Today (2025): 'a large grey WHOOP sign' atop "
                "the brick building.",
        unverified="Exact letter height and length (measured from photos, about 4 m by 22 m) and the lighting (the brief "
                   "and photos suggest white letters lit after dark; drawn steady, not animated).",
    ),
)

AMENITY_WORD = {"restaurant": "Restaurant", "fast_food": "Fast food", "cafe": "Café", "bar": "Bar", "pub": "Pub",
                "ice_cream": "Ice cream", "bakery": "Bakery"}


# --------------------------------------------------------------------------------------------
# Geometry: small-area metres around Kenmore (equirectangular, as the app's citgo.ts placer)
# --------------------------------------------------------------------------------------------

LAT0 = 42.349
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def to_m(p):
    return (p[0] * KX, p[1] * KY)


def to_ll(q):
    return [round(q[0] / KX, 7), round(q[1] / KY, 7)]


def ring_area(r):
    return sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r))) / 2


def outward(a, b, ccw):
    """Unit normal of edge a->b pointing out of a ring wound counter-clockwise (ccw) or not."""
    L = math.dist(a, b) or 1.0
    n = ((b[1] - a[1]) / L, -(b[0] - a[0]) / L)  # right of a->b: outward for a CCW ring
    return n if ccw else (-n[0], -n[1])


def point_in_ring(p, r):
    inside = False
    for i in range(len(r)):
        (x1, y1), (x2, y2) = r[i - 1], r[i]
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < x1 + (p[1] - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def seg_closest(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return t, (a[0] + t * dx, a[1] + t * dy)


def bearing_of(n):
    return round(math.degrees(math.atan2(n[0], n[1])) % 360, 1)


def nearest_on(lines, p):
    best = (1e18, None)
    for line in lines:
        for a, b in zip(line, line[1:]):
            _, q = seg_closest(p, a, b)
            d = math.dist(p, q)
            if d < best[0]:
                best = (d, q)
    return best


def street_wall(ring, p, street_lines, width):
    """The edge of `ring` (metres) a sign for the place at `p` goes on: one whose outward side
    faces the street, nearest the place. Returns (a, b, outward normal, t along the edge)."""
    ccw = ring_area(ring) > 0
    cands = []
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        L = math.dist(a, b)
        if L < 2.0:
            continue
        n = outward(a, b, ccw)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        d, q = nearest_on(street_lines, mid)
        if q is None or d > 60:
            continue
        facing = ((q[0] - mid[0]) * n[0] + (q[1] - mid[1]) * n[1]) / max(d, 1e-6)
        if facing < 0.5:
            continue
        t, c = seg_closest(p, a, b)
        # Nearest wall to the place; a wall too short for the sign only if nothing else fits.
        cands.append((math.dist(p, c) + (0 if L >= width + 0.4 else 25), a, b, n, t))
    if not cands:
        raise ValueError("no street-facing wall")
    _, a, b, n, t = min(cands, key=lambda c: c[0])
    return a, b, n, t


# --------------------------------------------------------------------------------------------

def load():
    manifest = json.loads(MANIFEST.read_text())
    entries = {e["osm"]: e for c in manifest["campuses"] for e in c["buildings"]}
    footprints = {f["osm"]: [[to_m(p) for p in r] for r in f["rings"]] for f in json.loads(FOOTPRINTS.read_text())}
    pois = {}
    for el in mbm.overpass(Q_FOOD):
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        pois[f"{el['type']}/{el['id']}"] = {"tags": el.get("tags", {}), "at": (lon, lat)}
    streets = {}
    for w in mbm.overpass(mbm.Q_STREETS):
        name = w.get("tags", {}).get("name")
        if name and w.get("geometry"):
            streets.setdefault(name, []).append([to_m((g["lon"], g["lat"])) for g in w["geometry"]])
    return entries, footprints, pois, streets


def building_at(footprints, entries, p):
    """The modelled building (OSM id) the point is in, else the nearest within 12 m."""
    best = (12.0, None)
    for osm, rings in footprints.items():
        if osm not in entries:
            continue
        if point_in_ring(p, rings[0]):
            return osm
        for i in range(len(rings[0])):
            _, q = seg_closest(p, rings[0][i - 1], rings[0][i])
            if math.dist(p, q) < best[0]:
                best = (math.dist(p, q), osm)
    return best[1]


def place_storefront(spec, entries, footprints, pois, streets):
    poi = pois.get(spec.get("osm")) if spec.get("osm") else None
    if spec.get("osm") and poi is None:
        raise KeyError(f"{spec['id']}: {spec['osm']} not in the Overpass result")
    tags = poi["tags"] if poi else {}
    at = spec.get("at") or poi["at"]
    p = to_m(at)
    building = spec.get("building") or building_at(footprints, entries, p)
    if not building:
        raise ValueError(f"{spec['id']}: no modelled building at {at}")
    street = spec.get("street") or tags.get("addr:street") or "Commonwealth Avenue"
    lines = streets.get(street)
    if not lines:
        raise ValueError(f"{spec['id']}: no street called {street}")
    ring = footprints[building][0]
    a, b, n, t = street_wall(ring, p, lines, spec["width"])
    L = math.dist(a, b)
    width = round(min(spec["width"], L - 0.4), 2)
    t = min(max(t, (width / 2 + 0.2) / L), 1 - (width / 2 + 0.2) / L)
    out = mbm.WALL_OUT + PROUD
    c = (a[0] + (b[0] - a[0]) * t + n[0] * out, a[1] + (b[1] - a[1]) * t + n[1] * out)
    entry = entries[building]
    shop = entry.get("storefront") or {}
    top = shop.get("top", DEFAULT_SHOP_TOP)
    height = SIGN_H
    centre = top - (SIGN_BAND * (top + 0.2)) / 2  # middle of the sign band
    on_canopy = False
    if shop.get("canopy"):
        ca, cb = (to_m(q) for q in shop["canopy"])
        _, q = seg_closest(c, ca, cb)
        if math.dist(c, q) < 1.2:
            centre = top - CANOPY_TOP + 0.05 + height / 2  # standing on the canopy
            on_canopy = True
    amenity = spec.get("amenity") or tags.get("amenity") or tags.get("shop")
    cuisine = spec.get("cuisine") or tags.get("cuisine")
    address = spec.get("address") or " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x) or None
    return {
        "id": spec["id"],
        "kind": "storefront",
        "name": spec.get("name") or tags.get("name"),
        "text": spec["text"],
        "osm": spec.get("osm"),
        "building": building,
        "position": to_ll(c),
        "altitude": round(centre, 2),
        "bearing": bearing_of(n),
        "width": width,
        "height": height,
        "style": spec["style"],
        "info": {k: v for k, v in {
            "amenity": AMENITY_WORD.get(amenity, amenity),
            "cuisine": cuisine.replace("_", " ").replace(";", ", ") if cuisine else None,
            "address": address,
            "hours": spec.get("hours") or tags.get("opening_hours"),
            "website": spec.get("website") or tags.get("website"),
        }.items() if v},
        "source": {
            "position": (f"https://www.openstreetmap.org/{spec['osm']}" if spec.get("osm") else "Photo (see make_signs.py)")
                        + f" on the {street} wall of {building}" + (" (on its canopy)" if on_canopy else ""),
            "open": VERIFIED[spec["id"]],
        },
    }


def place_whoop(entries):
    entry = entries[WHOOP["building"]]
    vols = sorted(entry.get("volumes", []), key=lambda v: -v["top"])
    if not vols:
        raise ValueError("WHOOP building has no modelled volumes")
    top = vols[0]
    ring = [to_m(p) for p in top["ring"]]
    ccw = ring_area(ring) > 0
    # The top storeys' Comm Ave wall: the longest edge facing within 30 degrees of south.
    best = None
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        n = outward(a, b, ccw)
        if n[1] < -math.cos(math.radians(30)) and (best is None or math.dist(a, b) > math.dist(*best[:2])):
            best = (a, b, n)
    a, b, n = best
    # The point of that wall's line at the measured longitude.
    ex = (b[0] - a[0]) / (math.dist(a, b) or 1)
    ey = (b[1] - a[1]) / (math.dist(a, b) or 1)
    s = (WHOOP["centre_lng"] * KX - a[0]) / ex if abs(ex) > 1e-6 else 0
    c = (a[0] + ex * s, a[1] + ey * s)
    inset = 0.6 - mbm.WALL_OUT  # standing on the roof, just behind the parapet
    c = (c[0] - n[0] * inset, c[1] - n[1] * inset)
    return {
        "id": WHOOP["id"],
        "kind": "rooftop",
        "name": WHOOP["name"],
        "text": WHOOP["text"],
        "osm": WHOOP["building"],
        "building": WHOOP["building"],
        "position": to_ll(c),
        "altitude": round(top["top"] + WHOOP["height"] / 2, 2),
        "bearing": bearing_of(n),
        "width": WHOOP["width"],
        "height": WHOOP["height"],
        "style": WHOOP["style"],
        "info": {"subtitle": WHOOP["subtitle"], "address": "1 Kenmore Square (545 Commonwealth Avenue)"},
        "source": WHOOP["source"],
    }


def main():
    entries, footprints, pois, streets = load()
    signs = [place_whoop(entries)] + [place_storefront(s, entries, footprints, pois, streets) for s in SIGNS]
    data = {
        "source": "OpenStreetMap contributors (ODbL) for places, names, cuisines and hours; positions on the modelled "
                  "facades by data-pipeline/make_signs.py; open as of October 2026 (each sign's source.open).",
        "signs": signs,
    }
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    for s in signs:
        print(f"  {s['id']:<20} {s['building']:<18} bearing {s['bearing']:>5}  {s['width']:>4} m wide at {s['altitude']} m")
    print(f"{len(signs)} signs -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
