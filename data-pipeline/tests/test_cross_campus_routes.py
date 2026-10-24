import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_cross_campus_routes import build, walkable


class CorridorTests(unittest.TestCase):
    def test_pedestrian_permissions(self):
        self.assertFalse(walkable({'highway': 'cycleway'}))
        self.assertTrue(walkable({'highway': 'cycleway', 'foot': 'yes'}))
        self.assertFalse(walkable({'highway': 'service', 'access': 'private'}))
        self.assertFalse(walkable({'highway': 'primary', 'foot': 'use_sidepath'}))
        self.assertTrue(walkable({'highway': 'path', 'access': 'private', 'foot': 'designated'}))

    def test_requires_actual_shared_vertex(self):
        a, b, c, d = [-71.1, 42.34], [-71.1, 42.341], [-71.1, 42.342], [-71.1, 42.343]
        base = {'locations': [{'id': name, 'campus': campus} for name, campus in [('a', 'fenway'), ('b', 'fenway'), ('c', 'charles-river'), ('d', 'charles-river')]], 'walkRoutes': {'a>b': {'path': [a, b]}, 'c>d': {'path': [c, d]}}}
        campus = [{'tags': {'highway': 'footway'}, 'path': [a, b]}, {'tags': {'highway': 'footway'}, 'path': [c, d]}]
        source = {'sources': [], 'retrieved': '2026-10-24', 'attribution': 'OSM', 'ways': [{'tags': {'highway': 'footway'}, 'path': [b, c]}]}
        route = build(base, source, campus)['walkRoutes']['a>d']
        self.assertEqual(route['path'], [a, b, c, d])
        source['ways'][0]['path'][0] = [-71.100001, 42.341]
        with self.assertRaisesRegex(AssertionError, 'No verified corridor'):
            build(base, source, campus)


if __name__ == '__main__':
    unittest.main()
