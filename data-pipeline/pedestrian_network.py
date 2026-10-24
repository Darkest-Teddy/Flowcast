"""Pedestrian routing graph shared by make_demo_routes.py and build_cross_campus_routes.py.

OpenStreetMap draws a road as its centre line. Routing walkers on plain distance put them down the
middle of Commonwealth Avenue, so this graph weights each way by what it is:

- Footways (sidewalks, crossings, paths, plazas, steps, corridors) cost their length.
- Roads cost several times their length (more for bigger roads, most when OSM maps the road's
  sidewalks as separate ways), so routes take the sidewalk and cross at mapped crosswalks.
- A road whose sidewalk is only a tag on the road (sidewalk=both/left/right/yes) costs about its
  length, since that's where the sidewalk is.

Any stretch a route still walks along a road is drawn beside it rather than on the centre line
(route_geometry): offset to the sidewalk side by half the carriageway (OSM width, lanes, or a
default for the road class) plus 1.5 m. One-way carriageways (each half of Comm Ave, either side
of the Green Line median) offset to their kerb side, never the median.

Nodes are keyed by their (lon, lat) rounded to six decimals, the precision of saved routes, so
ways from different OSM extracts join exactly where they share a vertex.
"""

import heapq
import math
import re

FOOT_COST = {
    "footway": 1.0, "path": 1.0, "pedestrian": 1.0, "corridor": 1.0, "platform": 1.0, "crossing": 1.0,
    "steps": 1.25, "cycleway": 1.15, "track": 1.2, "bridleway": 1.2,
}
# Walking in the roadway itself, where OSM gives no sidewalk for it.
ROAD_COST = {
    "primary": 8, "primary_link": 8, "secondary": 8, "secondary_link": 8,
    "tertiary": 6, "tertiary_link": 6, "unclassified": 4, "residential": 4,
    "service": 2.5, "living_street": 1.5,
}
SEPARATE_SIDEWALK_COST = 10  # the road's sidewalks are their own ways; use those
TAGGED_SIDEWALK_COST = 1.1  # sidewalk=yes on the road itself: walk beside it
CROSSING_PENALTY_METRES = 4  # per crossing edge: waiting for the light, so routes don't zig-zag
# Carriageway width (m) by class when OSM has no width or lanes: (two-way, one-way).
DEFAULT_WIDTH = {
    "primary": (13, 9), "primary_link": (6, 5), "secondary": (12, 7.5), "secondary_link": (6, 5),
    "tertiary": (11, 7), "tertiary_link": (6, 5), "unclassified": (8, 5.5), "residential": (9, 6),
    "service": (5, 4), "living_street": (6, 4.5),
}
LANE_METRES = 3.3
PARKING_LANE = 2.5
KERB_TO_SIDEWALK = 1.5  # walk this far beyond the edge of the carriageway
WALKABLE = sorted(set(FOOT_COST) | set(ROAD_COST))
YES = ("yes", "designated", "permissive")
# Ways a person heads for to leave or reach a building: not the middle of a crosswalk.
NOT_A_DOOR = ("crossing", "traffic_island")


def walkable(tags):
    """Whether OSM lets pedestrians use this way."""
    highway, foot = tags.get("highway"), tags.get("foot")
    if highway not in FOOT_COST and highway not in ROAD_COST:
        return False
    if foot in ("no", "private", "use_sidepath"):
        return False
    if tags.get("access") in ("no", "private") and foot not in YES:
        return False
    if highway in ("cycleway", "bridleway") and foot not in YES:
        return False
    return True


def distance(a, b):
    """Metres between two (lon, lat) points."""
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


def key(lon, lat):
    return (round(lon, 6), round(lat, 6))


def _metres(value):
    """OSM width ("12", "12.5 m", "40'", "40 ft") in metres, or None."""
    if not value:
        return None
    match = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*('|ft|feet)?", value)
    if not match:
        return None
    number = float(match.group(1)) * (0.3048 if match.group(2) else 1)
    return number if 2 <= number <= 40 else None


def _sides(tags):
    """Sidewalk on the way's (left, right): 'separate', 'yes', 'no' or None (unknown)."""
    def norm(value):
        if value in ("separate",):
            return "separate"
        if value in ("yes", "both", "left", "right"):
            return "yes"
        if value in ("no", "none"):
            return "no"
        return None
    both = tags.get("sidewalk")
    left = norm(tags.get("sidewalk:left") or tags.get("sidewalk:both"))
    right = norm(tags.get("sidewalk:right") or tags.get("sidewalk:both"))
    if both in ("separate", "yes", "no", "none", "both"):
        left = left or norm(both)
        right = right or norm(both)
    elif both == "left":
        left, right = left or "yes", right or "no"
    elif both == "right":
        left, right = left or "no", right or "yes"
    return left, right


def classify(tags):
    """(cost multiplier, road info or None) for a walkable way.

    Road info: offset (m from the centre line to where people walk) and side ('travel' = right of
    the direction of travel, 'left'/'right' = that side of the OSM way whichever way you walk)."""
    highway = tags["highway"]
    if highway in FOOT_COST:
        return FOOT_COST[highway], None
    left, right = _sides(tags)
    sides = (left, right)
    if "yes" in sides:
        cost = TAGGED_SIDEWALK_COST
    elif "separate" in sides:
        cost = SEPARATE_SIDEWALK_COST
    else:
        cost = ROAD_COST[highway]
    if highway == "service" and tags.get("service") in ("parking_aisle", "driveway", "alley") and cost > ROAD_COST["service"]:
        cost = max(ROAD_COST["service"], min(cost, 4))

    oneway = tags.get("oneway") in ("yes", "1", "-1") or tags.get("junction") == "roundabout"
    default = DEFAULT_WIDTH[highway][1 if oneway else 0]
    try:
        lanes = float(tags.get("lanes", "").split(";")[0])
    except ValueError:
        lanes = None
    # Boston's widths came from MassGIS and often measure the whole street (Comm Ave's carriageways
    # each say 47 m, the full boulevard), so a width is capped at what its lanes plus parking allow.
    widest = lanes * LANE_METRES + 2 * PARKING_LANE + 1 if lanes else default * 1.3
    width = _metres(tags.get("width"))
    if width is None:
        width = lanes * LANE_METRES + PARKING_LANE if lanes else default
    width = min(width, widest)
    has = {s for s in sides if s in ("yes", "separate")}
    offset = width / 2 + KERB_TO_SIDEWALK if has else max(1.5, width / 2 - 0.5)

    walk_left, walk_right = left in ("yes", "separate"), right in ("yes", "separate")
    if walk_left and not walk_right:
        side = "left"
    elif walk_right and not walk_left:
        side = "right"
    elif oneway and not (walk_left and walk_right):
        # Half of a divided road: the kerb (and its sidewalk) is on the drivers' right.
        side = "left" if tags.get("oneway") == "-1" else "right"
    else:
        side = "travel"
    return cost, {"offset": offset, "side": side, "highway": highway}


class Network:
    """Undirected pedestrian graph: node -> {neighbour: Edge}."""

    def __init__(self):
        self.adj = {}
        self.edges = []  # (a, b, info) as added, for nearest-edge search

    def add_way(self, tags, path):
        if not walkable(tags):
            return
        cost, road = classify(tags)
        info = {
            "cost": cost, "road": road,
            "foot": tags["highway"] in FOOT_COST,
            "door": tags["highway"] in FOOT_COST and tags.get("footway") not in NOT_A_DOOR and tags["highway"] != "crossing",
            "crossing": tags.get("footway") == "crossing" or tags["highway"] == "crossing",
            "name": tags.get("name"),
        }
        nodes = [key(*p) for p in path]
        for a, b in zip(nodes, nodes[1:]):
            if a != b:
                self._link(a, b, info)

    def _link(self, a, b, info):
        length = distance(a, b)
        weight = length * info["cost"] + (CROSSING_PENALTY_METRES if info["crossing"] else 0)
        old = self.adj.get(a, {}).get(b)
        if old and old[1] <= weight:
            return
        # Stored per direction: (length, weight, info, forward along the OSM way)
        self.adj.setdefault(a, {})[b] = (length, weight, info, True)
        self.adj.setdefault(b, {})[a] = (length, weight, info, False)
        self.edges.append((a, b))

    def _unlink(self, a, b):
        self.adj[a].pop(b, None)
        self.adj[b].pop(a, None)

    def largest_component(self):
        seen, best = set(), set()
        for start in self.adj:
            if start in seen:
                continue
            comp, stack = {start}, [start]
            while stack:
                for nxt in self.adj[stack.pop()]:
                    if nxt not in comp:
                        comp.add(nxt)
                        stack.append(nxt)
            seen |= comp
            if len(comp) > len(best):
                best = comp
        return best

    def keep(self, nodes):
        """Drop every node (and edge) outside `nodes`."""
        self.adj = {n: {m: e for m, e in nbrs.items() if m in nodes} for n, nbrs in self.adj.items() if n in nodes}
        self.edges = [(a, b) for a, b in self.edges if a in nodes and b in nodes]

    def nearest_edge(self, point, accept=lambda info: True):
        """(metres, a, b, projected (lon, lat)) of the closest live edge passing `accept`."""
        lon0, lat0 = point
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
        best = None
        for a, b in self.edges:
            edge = self.adj.get(a, {}).get(b)
            if edge is None or not accept(edge[2]):
                continue
            ax, ay = (a[0] - lon0) * kx, (a[1] - lat0) * ky
            bx, by = (b[0] - lon0) * kx, (b[1] - lat0) * ky
            dx, dy = bx - ax, by - ay
            seg = dx * dx + dy * dy
            t = 0.0 if seg == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg))
            px, py = ax + t * dx, ay + t * dy
            d = math.hypot(px, py)
            if best is None or d < best[0]:
                best = (d, a, b, (lon0 + px / kx, lat0 + py / ky))
        return best

    def crossings(self, p, q, accept=lambda info: True):
        """Points where the straight line p -> q crosses accepted edges, nearest p first."""
        lon0, lat0 = p
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
        qx, qy = (q[0] - lon0) * kx, (q[1] - lat0) * ky
        hits = []
        for a, b in self.edges:
            edge = self.adj.get(a, {}).get(b)
            if edge is None or not accept(edge[2]):
                continue
            ax, ay = (a[0] - lon0) * kx, (a[1] - lat0) * ky
            bx, by = (b[0] - lon0) * kx, (b[1] - lat0) * ky
            ex, ey = bx - ax, by - ay
            den = qx * ey - qy * ex
            if abs(den) < 1e-9:
                continue
            t = (ax * ey - ay * ex) / den  # along p -> q
            u = (ax * qy - ay * qx) / den  # along a -> b
            if 0 <= t <= 1 and 0 <= u <= 1:
                hits.append((t, (lon0 + t * qx / kx, lat0 + t * qy / ky)))
        return [point for _, point in sorted(hits)]

    def attach(self, point, accept=lambda info: True, max_metres=math.inf, exact=False):
        """Join `point` to the graph where it's nearest to an accepted edge, splitting that edge.

        Returns (node, metres from point to node), or None if no accepted edge is close enough.
        The node is an existing vertex if the projection lands within 1 m of one. With `exact`,
        the new vertex is `point` itself (a saved route endpoint lying on the edge)."""
        if exact and key(*point) in self.adj:
            return key(*point), 0.0
        found = self.nearest_edge(point, accept)
        if found is None or found[0] > max_metres:
            return None
        gap, a, b, proj = found
        if exact:
            proj = point
        else:
            for end in (a, b):
                if distance(end, proj) <= 1.0:
                    return end, distance(point, end)
        node = key(*proj)
        if node in self.adj:
            return node, distance(point, node)
        length, _, info, forward = self.adj[a][b]
        self._unlink(a, b)
        # Keep the OSM way direction on both halves (it decides which side a road offsets to).
        first, second = (a, node), (node, b)
        if not forward:
            first, second = (node, a), (b, node)
        for u, v in (first, second):
            self._link(u, v, info)
        return node, distance(point, node)

    def shortest(self, source):
        """Dijkstra on walking cost: (cost, previous) dicts."""
        cost, prev = {source: 0.0}, {}
        heap = [(0.0, source)]
        while heap:
            c, node = heapq.heappop(heap)
            if c > cost[node]:
                continue
            for nxt, (_, w, _, _) in self.adj[node].items():
                nc = c + w
                if nc < cost.get(nxt, math.inf):
                    cost[nxt], prev[nxt] = nc, node
                    heapq.heappush(heap, (nc, nxt))
        return cost, prev

    def route_geometry(self, nodes):
        """Points ([lon, lat], six decimals) a walker follows along this node path.

        Footway stretches follow OSM exactly. Road stretches are moved off the centre line to the
        side people walk on, with corners joined where the offset lines meet (or bevelled at a
        hairpin). The first and last points are always the path's own nodes, so every route from
        a place starts at the same spot."""
        if len(nodes) < 2:
            return [list(nodes[0]), list(nodes[0])]
        lat0 = sum(n[1] for n in nodes) / len(nodes)
        lon0 = sum(n[0] for n in nodes) / len(nodes)
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
        xy = [((n[0] - lon0) * kx, (n[1] - lat0) * ky) for n in nodes]

        # Per edge: signed offset (+ = right of travel) in metres.
        shifts = []
        for a, b in zip(nodes, nodes[1:]):
            _, _, info, forward = self.adj[a][b]
            road = info["road"]
            if not road:
                shifts.append(0.0)
            elif road["side"] == "travel":
                shifts.append(road["offset"])
            else:  # a fixed side of the OSM way: right of travel when walking along it
                along_right = road["side"] == "right"
                shifts.append(road["offset"] if along_right == forward else -road["offset"])

        def offset_line(i):
            (ax, ay), (bx, by) = xy[i], xy[i + 1]
            dx, dy = bx - ax, by - ay
            length = math.hypot(dx, dy) or 1e-9
            nx, ny = dy / length * shifts[i], -dx / length * shifts[i]
            return (ax + nx, ay + ny), (bx + nx, by + ny), (dx / length, dy / length)

        out = [xy[0]]
        for i in range(1, len(nodes) - 1):
            before, after = shifts[i - 1], shifts[i]
            if before == 0 and after == 0:
                out.append(xy[i])
                continue
            a0, a1, da = offset_line(i - 1)
            b0, b1, db = offset_line(i)
            if before and after:
                cross = da[0] * db[1] - da[1] * db[0]
                if abs(cross) < 0.05:  # nearly straight on: the offset lines all but meet
                    out.append(a1)
                    if math.hypot(a1[0] - b0[0], a1[1] - b0[1]) > 0.3:
                        out.append(b0)
                    continue
                # Where the two offset lines cross; bevel instead if that's far out (a hairpin).
                t = ((b0[0] - a0[0]) * db[1] - (b0[1] - a0[1]) * db[0]) / cross
                corner = (a0[0] + da[0] * t, a0[1] + da[1] * t)
                if math.hypot(corner[0] - xy[i][0], corner[1] - xy[i][1]) <= 3 * max(abs(before), abs(after)):
                    out.append(corner)
                else:
                    out += [a1, b0]
            elif before:  # road -> footway: leave from the kerb side, not the centre line
                out.append(a1)
            else:  # footway -> road
                out.append(b0)
        out.append(xy[-1])
        out = _untangle(out, xy, shifts)
        points = [[round(lon0 + x / kx, 6), round(lat0 + y / ky, 6)] for x, y in out]
        points[0], points[-1] = list(nodes[0]), list(nodes[-1])
        return tidy(points)


def _untangle(out, xy, shifts):
    """Drop offset points that double back (an offset bigger than a tight bend makes little loops)."""
    if not any(shifts):
        return out
    cleaned = [out[0]]
    for i in range(1, len(out) - 1):
        px, py = cleaned[-1]
        x, y = out[i]
        nx, ny = out[i + 1]
        # Backtracking: going from the previous point to this one and on to the next reverses.
        v1, v2 = (x - px, y - py), (nx - x, ny - y)
        if math.hypot(*v1) > 0.01 and math.hypot(*v2) > 0.01 and (v1[0] * v2[0] + v1[1] * v2[1]) < -0.9 * math.hypot(*v1) * math.hypot(*v2):
            continue
        cleaned.append(out[i])
    cleaned.append(out[-1])
    return cleaned


def tidy(path, min_metres=0.3):
    """Drop points within `min_metres` of the one before (two OSM nodes a few cm apart, or an offset
    corner landing on a vertex): saved distances have 0.1 m precision, and playback rejects two
    distinct points at the same distance. The first and last points always stay."""
    out = [path[0]]
    for i, point in enumerate(path[1:], 1):
        if distance(out[-1], point) >= min_metres:
            out.append(point)
        elif i == len(path) - 1 and len(out) > 1:
            out[-1] = point
    if len(out) == 1:
        out.append(path[-1])
    return out


def cumulative(path):
    """Metres along a path of [lon, lat] points, one decimal."""
    total, out = 0.0, [0.0]
    for a, b in zip(path, path[1:]):
        total += distance(a, b)
        out.append(round(total, 1))
    return out


def is_door(info):
    """Where a walker can step out of a building: any footway but a crosswalk."""
    return info["door"]


def is_foot(info):
    return info["foot"]
