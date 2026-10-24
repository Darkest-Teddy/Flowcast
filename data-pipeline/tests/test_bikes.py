from datetime import date, datetime
import unittest

import fetch_bikes as fb


def ride(start, end, frm=None, to=None, kind='classic'):
    return {
        'start': datetime.fromisoformat(start), 'end': datetime.fromisoformat(end), 'from': frm, 'to': to,
        'fromName': frm, 'toName': to, 'fromPoint': (42.35, -71.10), 'toPoint': (42.36, -71.09),
        'type': kind, 'member': True,
    }


class TripDataTests(unittest.TestCase):
    def test_rows_parse_with_local_times_and_missing_coordinates(self):
        row = {
            'ride_id': 'X', 'rideable_type': 'electric_bike', 'started_at': '2026-09-02 08:01:23.123',
            'ended_at': '2026-09-02 08:15:00.000', 'start_station_name': 'Silber Way', 'start_station_id': 'D32032',
            'end_station_name': '', 'end_station_id': '', 'start_lat': '42.3495', 'start_lng': '-71.1009',
            'end_lat': '', 'end_lng': '', 'member_casual': 'casual',
        }
        parsed = fb.parse_ride(row)
        self.assertEqual(parsed['start'], datetime(2026, 9, 2, 8, 1, 23, 123000))
        self.assertEqual((parsed['from'], parsed['to']), ('D32032', None))
        self.assertEqual((parsed['fromPoint'], parsed['toPoint']), ((42.3495, -71.1009), None))
        self.assertEqual((parsed['type'], parsed['member']), ('electric', False))
        self.assertIsNone(fb.parse_ride({**row, 'started_at': 'not a time'}))

    def test_only_docks_near_a_bu_location_count(self):
        locations = [{'id': 'cas', 'campus': 'charles-river', 'lat': 42.3503, 'lon': -71.1040}]
        positions = {'near': (42.3510, -71.1040), 'far': (42.3600, -71.1040)}  # ~80 m and ~1 km north
        stations = fb.campus_stations(positions, locations, radius=200)
        self.assertEqual(list(stations), ['near'])
        self.assertEqual(stations['near'][:2], ('charles-river', 'cas'))

    def test_profiles_average_per_day_and_count_bu_to_bu_rides_once(self):
        stations = {'A': None, 'B': None}
        rides = [
            ride('2026-09-02 08:05:00', '2026-09-02 08:20:00', 'A', 'B'),  # Wed, BU to BU
            ride('2026-09-09 08:10:00', '2026-09-09 08:40:00', 'X', 'A'),  # Wed, arrives at A
            ride('2026-09-03 08:10:00', '2026-09-03 08:40:00', 'A', 'X'),  # Thursday: ignored
            ride('2026-08-26 08:10:00', '2026-08-26 08:40:00', 'A', 'X'),  # August Wednesday: other month
        ]
        profiles, days, per_day = fb.weekday_profiles(rides, stations, weekday=2, month='202609')
        self.assertEqual(days, [date(2026, 9, 2), date(2026, 9, 9)])
        self.assertEqual(per_day, {date(2026, 9, 2): 1, date(2026, 9, 9): 1})
        eight = 8 * 4  # 08:00-08:15 bin
        self.assertEqual(profiles['A']['departures'][eight], 0.5)  # one ride over two Wednesdays
        self.assertEqual(profiles['B']['arrivals'][eight + 1], 0.5)
        self.assertEqual(profiles['A']['arrivals'][eight + 2], 0.5)
        self.assertEqual(len(profiles['A']['arrivals']), fb.BINS)

    def test_median_day_is_a_typical_day(self):
        counts = {date(2026, 9, 2): 2400, date(2026, 9, 9): 900, date(2026, 9, 16): 2500, date(2026, 9, 23): 2450}
        self.assertEqual(fb.median_day(counts), date(2026, 9, 2))
        counts[date(2026, 9, 30)] = 2420
        self.assertEqual(fb.median_day(counts), date(2026, 9, 30))
        self.assertIsNone(fb.median_day({}))


class NetworkTests(unittest.TestCase):
    def test_bike_infrastructure_is_preferred_over_streets_and_sidewalks(self):
        factor = fb.cost_factor
        cycleway = factor({'highway': 'cycleway'})
        protected = factor({'highway': 'primary', 'cycleway:right': 'track'})
        painted = factor({'highway': 'primary', 'cycleway': 'lane'})
        street = factor({'highway': 'residential'})
        arterial = factor({'highway': 'primary'})
        sidewalk = factor({'highway': 'footway'})
        self.assertLess(cycleway, protected)
        self.assertLess(protected, painted)
        self.assertLess(painted, street)
        self.assertLess(street, arterial)
        self.assertLess(arterial, sidewalk)
        self.assertLess(factor({'highway': 'footway', 'bicycle': 'designated'}), street)

    def test_access_and_walking_a_bike(self):
        self.assertFalse(fb.allows_bikes({'highway': 'path', 'bicycle': 'no'}))
        self.assertFalse(fb.allows_bikes({'highway': 'service', 'access': 'private'}))
        self.assertTrue(fb.allows_bikes({'highway': 'service', 'access': 'private', 'bicycle': 'yes'}))
        self.assertTrue(fb.walks_bike({'highway': 'footway'}))
        self.assertTrue(fb.walks_bike({'highway': 'cycleway', 'bicycle': 'dismount'}))
        self.assertFalse(fb.walks_bike({'highway': 'footway', 'bicycle': 'yes'}))

    def test_one_way_rules_for_bikes(self):
        self.assertEqual(fb.directions({'oneway': 'yes'}), (True, False))
        self.assertEqual(fb.directions({'oneway': '-1'}), (False, True))
        self.assertEqual(fb.directions({'junction': 'roundabout'}), (True, False))
        self.assertEqual(fb.directions({'oneway': 'yes', 'oneway:bicycle': 'no'}), (True, True))
        self.assertEqual(fb.directions({'oneway': 'yes', 'cycleway:left': 'opposite_lane'}), (True, True))
        self.assertEqual(fb.directions({'highway': 'residential'}), (True, True))

    def test_graph_follows_one_way_streets_and_drops_dead_ends(self):
        nodes = [{'type': 'node', 'id': i, 'lat': 42.35, 'lon': -71.10 + i * 0.001} for i in range(1, 5)]
        ways = [
            {'type': 'way', 'id': 10, 'nodes': [1, 2, 3], 'tags': {'highway': 'residential'}},
            # A one-way street out of the network with no way back: reachable but not escapable.
            {'type': 'way', 'id': 11, 'nodes': [3, 4], 'tags': {'highway': 'residential', 'oneway': 'yes'}},
            {'type': 'way', 'id': 12, 'nodes': [1, 2], 'tags': {'highway': 'footway', 'bicycle': 'no'}},
        ]
        coords, graph = fb.build_graph(nodes + ways)
        self.assertEqual(sorted(b for b, _, _ in graph[3]), [2, 4])
        self.assertNotIn(4, graph)  # no edge back from 4
        self.assertEqual(len(graph[1]), 1)  # the no-bikes footway added nothing
        self.assertEqual(fb.largest_strong_component(graph, fb.reverse(graph)), {1, 2, 3})

    def test_shortest_tree_prefers_cheap_edges_and_reports_real_metres(self):
        graph = {
            'dock': [('street', 100, 100), ('lane', 75, 150)],
            'street': [('far', 100, 100)],
            'lane': [('far', 60, 80)],
        }
        prev, metres = fb.shortest_tree(graph, 'dock')
        self.assertEqual(fb.walk_back(prev, 'far', 'dock'), ['far', 'lane', 'dock'])
        self.assertEqual(metres['far'], 230)  # the lane route is longer but cheaper

    def test_nearest_node_searches_neighbouring_cells(self):
        coords = {1: (42.35005, -71.10005), 2: (42.3519, -71.1001)}
        index = fb.NodeIndex(coords, coords)
        self.assertEqual(index.nearest(42.3501, -71.1001)[0], 1)
        node, metres = index.nearest(42.3525, -71.1001)
        self.assertEqual(node, 2)
        self.assertLess(metres, 100)
        self.assertEqual(fb.NodeIndex(coords, []).nearest(42.35, -71.1), (None, float('inf')))

    def test_overlapping_campuses_share_a_network(self):
        groups = fb.network_groups({
            'charles-river': [(42.3500, -71.1050)],
            'fenway': [(42.3430, -71.1000)],  # ~900 m away: padded areas overlap
            'far-away': [(42.4500, -71.0000)],
        })
        self.assertEqual(sorted(sorted(g[0]) for g in groups), [['charles-river', 'fenway'], ['far-away']])


class TimingTests(unittest.TestCase):
    midnight = datetime(2026, 9, 23)

    def test_ride_leaving_bu_departs_at_its_real_time(self):
        r = ride('2026-09-23 08:00:00', '2026-09-23 08:10:00', 'A', 'X')
        depart, speed = fb.ride_timing(2400, r, self.midnight, 'from', reached=True)
        self.assertEqual((depart, speed), (8 * 3600, 4.0))  # 2.4 km in its real 10 minutes

    def test_ride_reaching_bu_docks_at_its_real_time(self):
        r = ride('2026-09-23 08:00:00', '2026-09-23 08:10:00', 'X', 'A', kind='electric')
        depart, speed = fb.ride_timing(1060, r, self.midnight, 'to', reached=False)
        self.assertEqual(speed, fb.CRUISE['electric'])  # far end off the map: typical speed
        self.assertAlmostEqual(depart + 1060 / speed, 8 * 3600 + 600)

    def test_implausible_speeds_are_clamped(self):
        slow = ride('2026-09-23 08:00:00', '2026-09-23 10:00:00', 'A', 'X')  # 2 h for 1 km
        self.assertEqual(fb.ride_timing(1000, slow, self.midnight, 'from', reached=True)[1], fb.MIN_SPEED)

    def test_timestamps_follow_distance(self):
        points = [[-71.10, 42.35], [-71.10, 42.351], [-71.10, 42.353]]
        ts = fb.timestamps(points, 100, 5.0)
        self.assertEqual(ts[0], 100)
        self.assertAlmostEqual((ts[2] - ts[1]) / (ts[1] - ts[0]), 2, places=2)

    def test_simplify_keeps_corners_and_drops_straight_runs(self):
        line = [[-71.10, 42.35], [-71.0995, 42.35], [-71.099, 42.35], [-71.099, 42.351]]
        self.assertEqual(fb.simplify(line), [line[0], line[2], line[3]])
        self.assertEqual(fb.simplify(line[:2]), line[:2])


if __name__ == '__main__':
    unittest.main()
