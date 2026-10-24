import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build_mobility_data import DATASETS, DEFAULT_INPUT, build, build_bundle


class MobilityBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = {name: json.loads((DEFAULT_INPUT / f'{name}.json').read_text()) for name in DATASETS}

    def test_real_snapshot_is_compact_preserves_counts_and_runs_offline(self):
        with tempfile.TemporaryDirectory() as directory, patch('socket.socket', side_effect=AssertionError('network')):
            first, second = Path(directory)/'first.json', Path(directory)/'second.json'
            result = build(output=first)
            build(output=second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertLess(first.stat().st_size, 2_000_000)
            self.assertEqual(len(result['roads']['locations']), 15)
            self.assertEqual(len(result['pedestrians']['locations']), 3)
            self.assertEqual(len(result['bluebikes']['flows']), len(self.inputs['bluebikes']['flows']))
            self.assertEqual(result['roads']['locations'][0]['profiles'], self.inputs['road_counts']['locations'][0]['profiles'])
            self.assertEqual(len(result['inputFiles']), 3)

    def test_bike_denominator_covers_all_calendar_weekdays_including_zero_trip_days(self):
        data = copy.deepcopy(self.inputs)
        row = data['bluebikes']['flows'][0]
        row['days'] = 1
        with self.assertRaisesRegex(ValueError, 'calendar occurrence'):
            build_bundle(data)

    def test_duplicate_count_profiles_and_missing_counts_cannot_be_summed_or_zero_filled(self):
        data = copy.deepcopy(self.inputs)
        profiles = data['road_counts']['locations'][0]['profiles']
        profiles.append(copy.deepcopy(profiles[0]))
        with self.assertRaisesRegex(ValueError, 'Duplicate count profile'):
            build_bundle(data)
        profiles.pop()
        profiles[0]['motorVehicles'] = None
        with self.assertRaisesRegex(ValueError, 'vehicles'):
            build_bundle(data)

    def test_pedestrian_collection_day_ambiguity_survives_bundle(self):
        data = build_bundle(self.inputs)
        profile = data['pedestrians']['locations'][0]['profiles'][0]
        self.assertIsNone(profile['weekday'])
        self.assertEqual(profile['weekdays'], [2, 3])

    def test_invalid_geography_partial_sources_and_unknown_bike_endpoints_fail(self):
        data = copy.deepcopy(self.inputs)
        data['road_counts']['locations'][0]['position'] = [0, 0]
        with self.assertRaisesRegex(ValueError, 'Greater Boston'): build_bundle(data)
        data = copy.deepcopy(self.inputs)
        data['bluebikes']['flows'][0]['from'] = 'absent'
        with self.assertRaisesRegex(ValueError, 'missing station'): build_bundle(data)
        data = copy.deepcopy(self.inputs)
        data['pedestrian_counts']['errors'] = ['Failed source']
        with self.assertRaisesRegex(ValueError, 'Incomplete'): build_bundle(data)


if __name__ == '__main__': unittest.main()
