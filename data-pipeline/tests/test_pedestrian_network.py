import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pedestrian_network as pn

# Local metres <-> lon/lat around Marsh Plaza, for readable fixtures.
LON0, LAT0 = -71.106, 42.35
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574


def at(x, y):
    return [round(LON0 + x / KX, 6), round(LAT0 + y / KY, 6)]


def xy(p):
    return ((p[0] - LON0) * KX, (p[1] - LAT0) * KY)


def route(network, start, end):
    _, prev = network.shortest(start)
    nodes = [end]
    while nodes[-1] != start:
        nodes.append(prev[nodes[-1]])
    return network.route_geometry(nodes[::-1])


class SidewalkTests(unittest.TestCase):
    def test_prefers_sidewalk_and_crosswalk_over_road_centre(self):
        # A road along y=0 with separately mapped sidewalks at y=+-10, joined by a crosswalk at x=100.
        net = pn.Network()
        net.add_way({'highway': 'secondary', 'sidewalk': 'separate'}, [at(0, 0), at(100, 0), at(200, 0)])
        net.add_way({'highway': 'footway', 'footway': 'sidewalk'}, [at(0, 10), at(100, 10), at(200, 10)])
        net.add_way({'highway': 'footway', 'footway': 'sidewalk'}, [at(0, -10), at(100, -10), at(200, -10)])
        net.add_way({'highway': 'footway', 'footway': 'crossing'}, [at(100, 10), at(100, 0), at(100, -10)])
        net.add_way({'highway': 'footway'}, [at(0, 10), at(0, 0)])  # a path onto the road at each end
        net.add_way({'highway': 'footway'}, [at(200, -10), at(200, 0)])
        start, end = pn.key(*at(0, 10)), pn.key(*at(200, -10))
        path = route(net, start, end)
        self.assertEqual(path, [at(0, 10), at(100, 10), at(100, 0), at(100, -10), at(200, -10)])

    def test_leftover_road_stretch_walks_beside_the_road(self):
        # Footway -> two-way residential road with no sidewalk ways (an L-turn) -> footway.
        net = pn.Network()
        net.add_way({'highway': 'footway'}, [at(-20, 0), at(0, 0)])
        net.add_way({'highway': 'residential', 'width': '10'}, [at(0, 0), at(100, 0), at(100, 100)])
        net.add_way({'highway': 'footway'}, [at(100, 100), at(100, 120)])
        path = route(net, pn.key(*at(-20, 0)), pn.key(*at(100, 120)))
        pts = [xy(p) for p in path]
        self.assertEqual(path[0], at(-20, 0))
        self.assertEqual(path[-1], at(100, 120))
        # Walking east then north, the right-hand side is south of the first leg, east of the
        # second: half of 10 m plus 0.5 m in from the edge (no sidewalk tagged) = 4.5 m.
        inner = pts[1:-1]
        self.assertTrue(all(abs(y + 4.5) < 0.3 for x, y in inner[:1]))
        corner = inner[1]
        self.assertAlmostEqual(corner[0], 104.5, delta=0.3)
        self.assertAlmostEqual(corner[1], -4.5, delta=0.3)
        for x, y in inner:  # never on the centre line
            self.assertTrue(min(abs(y), abs(x - 100)) > 4 or y > 100)

    def test_divided_road_walks_on_the_kerb_side_whichever_way(self):
        # One carriageway of a boulevard, drawn west->east, sidewalk on its right (south), median north.
        net = pn.Network()
        tags = {'highway': 'primary', 'oneway': 'yes', 'lanes': '2', 'sidewalk:left': 'no', 'sidewalk:right': 'yes'}
        net.add_way({'highway': 'footway'}, [at(-10, 0), at(0, 0)])
        net.add_way(tags, [at(0, 0), at(50, 0), at(100, 0)])
        net.add_way({'highway': 'footway'}, [at(100, 0), at(110, 0)])
        for a, b in ((at(-10, 0), at(110, 0)), (at(110, 0), at(-10, 0))):
            path = route(net, pn.key(*a), pn.key(*b))
            ys = [xy(p)[1] for p in path[1:-1]]
            self.assertTrue(ys and all(y < -5 for y in ys), ys)

    def test_attach_prefers_a_sidewalk_to_a_nearer_road(self):
        net = pn.Network()
        net.add_way({'highway': 'residential', 'sidewalk': 'separate'}, [at(0, 0), at(100, 0)])
        net.add_way({'highway': 'footway', 'footway': 'sidewalk'}, [at(0, 8), at(100, 8)])
        node, gap = net.attach(at(50, 3), pn.is_door, 150)
        self.assertEqual(node, pn.key(*at(50, 8)))
        self.assertAlmostEqual(gap, 5, delta=0.3)
        # The split keeps the sidewalk whole: both halves are still edges.
        self.assertIn(pn.key(*at(0, 8)), net.adj[node])
        self.assertIn(pn.key(*at(100, 8)), net.adj[node])

    def test_saved_distances_strictly_increase_between_distinct_points(self):
        # Two OSM vertices 8 cm apart (seen in Boston data) must not give two points at one 0.1 m distance.
        path = pn.tidy([at(0, 0), at(10, 0), [at(10, 0)[0] + 0.000001, at(10, 0)[1]], at(20, 0)])
        self.assertEqual(len(path), 3)
        dist = pn.cumulative(path)
        self.assertTrue(all(b > a for a, b in zip(dist, dist[1:])))
        self.assertEqual(pn.tidy([at(0, 0), at(0, 0)]), [at(0, 0), at(0, 0)])  # one door: zero-length stays
        self.assertEqual(pn.tidy([at(0, 0), at(5, 0), at(5.1, 0)])[-1], at(5.1, 0))  # the end point is kept

    def test_massgis_street_width_is_capped_by_lanes(self):
        _, road = pn.classify({'highway': 'primary', 'oneway': 'yes', 'lanes': '2', 'width': '47.0', 'sidewalk:right': 'separate', 'sidewalk:left': 'no'})
        self.assertLess(road['offset'], 9)
        self.assertEqual(road['side'], 'right')


if __name__ == '__main__':
    unittest.main()
