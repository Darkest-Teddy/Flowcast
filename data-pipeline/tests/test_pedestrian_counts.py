import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scrape_pedestrian_counts import map_warren, mpo_locations, street_intersection, OUTPUT, STREET_FILE


class PedestrianCountTests(unittest.TestCase):
    def test_exact_named_groups_only_and_ambiguous_intersections_stay_unmapped(self):
        signals = [{'group': 'g1', 'road': 'Main', 'position': [-71, 42]},
                   {'group': 'g1', 'road': 'Side', 'position': [-71.001, 42.001]}]
        point, group = street_intersection(signals, 'Main', 'Side')
        self.assertEqual(group, 'g1')
        self.assertAlmostEqual(point[0], -71.0005)
        self.assertIsNone(street_intersection(signals, 'Main', 'Other'))
        signals += [{**row, 'group': 'g2'} for row in signals]
        self.assertIsNone(street_intersection(signals, 'Main', 'Side'))

    def test_saved_counts_remain_one_observation_and_do_not_invent_a_weekday(self):
        rows = json.loads((OUTPUT / 'signals.json').read_text())['pedestrianCounts']
        signals = json.loads(STREET_FILE.read_text())['signals']
        locations, errors = map_warren(rows, signals)
        self.assertEqual(len(locations), 3)
        self.assertEqual(len({error['message'] for error in errors}), 4)
        values = {loc['name']: {p['hour']: p['pedestrians'] for p in loc['profiles']} for loc in locations}
        self.assertEqual(values['Commonwealth Avenue at Granby Street'], {8: 613, 17: 1995})
        self.assertEqual(values['Commonwealth Avenue at Cummington Mall'], {8: 548, 17: 1159})
        for loc in locations:
            for profile in loc['profiles']:
                self.assertIsNone(profile['weekday'])
                self.assertEqual(profile['weekdays'], [2, 3])
                self.assertEqual(profile['samples'], 1)

    def test_old_and_incomplete_mpo_counts_are_excluded(self):
        geometry = {'features': [{'properties': {'loc_id': 1, 'description': 'Example'}, 'geometry': {'coordinates': [-71.1, 42.35]}}]}
        campuses = {'charles-river': [42.3, -71.2, 42.4, -71.0]}
        old = dict(bp_loc_id='1', count_type='P', count_date='2001-08-15')
        rows, count = mpo_locations([old], geometry, campuses)
        self.assertEqual(rows, [])
        self.assertEqual(count, 1)
        row = {**old, 'count_date': '2023-10-18', 'count_id': 'a', 'from_st_name': 'A', 'to_st_name': 'A', 'from_st_dir': 'N', 'to_st_dir': 'S',
               'cnt_0800': '1', 'cnt_0815': '', 'cnt_0830': '2', 'cnt_0845': '3'}
        rows, _ = mpo_locations([row], geometry, campuses)
        self.assertEqual(rows, [])
        row['cnt_0815'] = '0'
        rows, _ = mpo_locations([row], geometry, campuses)
        self.assertEqual(rows[0]['profiles'], [{'weekday': 2, 'hour': 8, 'pedestrians': 6, 'samples': 1}])
        incomplete_other_direction = {**row, 'from_st_dir': 'S', 'to_st_dir': 'N', 'cnt_0815': ''}
        rows, _ = mpo_locations([row, incomplete_other_direction], geometry, campuses)
        self.assertEqual(rows, [])


if __name__ == '__main__':
    unittest.main()
