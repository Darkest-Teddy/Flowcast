import hashlib
from datetime import date
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build_map_data import (DATASETS, DEFAULT_INPUT, DEFAULT_MAP, build, build_bundle,
                            calendar_restricted, event_location, hour_windows, routable_ids, reference_week)


class MapDataTests(unittest.TestCase):
    def test_reference_week_uses_dated_coverage_without_projecting_hours(self):
        venues = {"dining": {"hoursStatus": "published", "hours": [
            {"date": "2026-10-24", "windows": [[36000, 72000]]},
            {"date": "2026-10-26", "windows": [[36000, 72000]]},
            {"date": "2026-10-27", "windows": []},
        ]}}
        self.assertEqual(reference_week(date(2026, 10, 24), venues), date(2026, 10, 26))
        self.assertEqual(reference_week(date(2026, 10, 24), {}), date(2026, 10, 19))

    @classmethod
    def setUpClass(cls):
        cls.datasets = {name: json.loads((DEFAULT_INPUT / f'{name}.json').read_text()) for name in DATASETS}
        cls.day = json.loads(DEFAULT_MAP.read_text())
        cls.bundle = build_bundle(cls.datasets, cls.day)

    def test_hours_audit_replaces_undated_snapshots_and_department_hours(self):
        datasets = copy.deepcopy(self.datasets)
        closed = {"date": "2026-10-24", "windows": [], "text": "Closed", "sourceUrl": "https://www.bu.edu/", "qualifier": None}
        datasets['opening_hours'] = {"locations": [
            {"locationId": "mugar", "status": "published", "hours": [closed]},
            {"locationId": "agganis", "status": "restricted", "hours": [], "reason": "Event-only access"},
        ]}
        result = build_bundle(datasets, self.day)
        self.assertEqual(result['locations']['mugar']['hours'], [closed])
        self.assertEqual(result['locations']['agganis']['hoursStatus'], 'restricted')

    def test_hours_audit_rejects_undated_unscoped_or_invalid_windows(self):
        for hours in [
            {"date": None, "windows": [[0, 3600]]},
            {"date": None, "weekday": 7, "windows": [[0, 3600]]},
            {"date": "2026-10-24", "windows": [[7200, 3600]]},
        ]:
            datasets = {**self.datasets, "opening_hours": {"locations": [{"locationId": "gsu", "status": "published", "hours": [hours]}]}}
            with self.assertRaises(ValueError):
                build_bundle(datasets, self.day)

    def test_every_source_meeting_is_mapped_or_reported_without_invented_locations(self):
        bundle = self.bundle
        mapped = [row for location in bundle['locations'].values() for row in location['meetings']]
        unknown = sum(row['meetingCount'] for row in bundle['coverage']['unmappedBuildings'])
        self.assertEqual(len(mapped) + unknown, len(self.datasets['catalog']['meetings']))
        self.assertEqual(bundle['coverage']['sourceMeetings'], 6944)
        self.assertEqual(bundle['coverage']['mappedMeetings'], len(mapped))
        self.assertEqual(set(bundle['locations']), {location['id'] for location in self.day['locations']})
        reachable = routable_ids(self.day)
        for location in bundle['locations'].values():
            if location['meetings']:
                self.assertIn(location['id'], reachable)
            self.assertNotIn('position', location)
            for row in location['meetings']:
                self.assertTrue(row['sourceUrl'].startswith('https://'))
                self.assertIn(row['buildingCode'], location['buildingCodes'])
                for interval in row['intervals']:
                    self.assertLess(interval['startSec'], interval['endSec'])
                    self.assertGreaterEqual(interval['startSec'], 0)
                    self.assertLessEqual(interval['endSec'], 604800)

    def test_registration_deadlines_are_not_teaching_date_restrictions(self):
        for notes in ['The last day to add a WR class is 9/9.',
                      'The deadline to add an RS language class is Thursday, Sept. 10.',
                      '3 seats are reserved for incoming transfers until September 2.',
                      'Students should reserve Thursdays 6:30-8:30 pm for exams throughout the term.']:
            with self.subTest(notes=notes):
                self.assertFalse(calendar_restricted(notes))
        for notes in ['Meets August 10-14.', 'Class session dates: 10/24-10/25.',
                      'Second half of the semester only.', 'Intensive seminar.', 'Class meets Nov. 5 only.']:
            with self.subTest(notes=notes):
                self.assertTrue(calendar_restricted(notes))

    def test_only_exact_shared_room_and_weekly_times_receive_a_shared_key(self):
        signatures = {}
        for location in self.bundle['locations'].values():
            for row in location['meetings']:
                if row['sharedKey']:
                    signature = (location['id'], row['roomCode'], json.dumps(row['intervals'],sort_keys=True))
                    if row['sharedKey'] in signatures:
                        self.assertEqual(signatures[row['sharedKey']], signature)
                    signatures[row['sharedKey']] = signature
        self.assertTrue(signatures)
        self.assertTrue(any(row['sharedKey'] is None for row in self.bundle['locations']['cas']['meetings']))

    def test_residential_complex_and_subsets_are_not_added_together(self):
        housing = self.datasets['housing']['measurements']
        tower_a = next(row for row in housing if row['entityKey'] == 'housing:warren-tower-a')
        west = next(row for row in housing if row['entityKey'] == 'housing:west-campus')
        all_local = [row for location in self.bundle['locations'].values() for row in location['evidence']]
        self.assertNotIn(tower_a['id'], [row['id'] for row in all_local])
        self.assertNotIn(west['id'], [row['id'] for row in all_local])
        warren = self.bundle['locations']['warren']['evidence']
        self.assertEqual(sorted(row['value'] for row in warren), [600, 1800])
        self.assertEqual(next(row for row in warren if row['value'] == 600)['basis'], 'dated_availability')
        self.assertTrue(any(row['id'] == west['id'] for row in self.bundle['signals']))
        self.assertEqual(self.bundle['locations']['stuvi']['evidence'][0]['value'], 802)

    def test_seats_throughput_and_historical_library_counts_remain_distinct(self):
        gsu = self.bundle['locations']['gsu']['evidence']
        self.assertTrue(any(row['value'] == 40000 and row['unit'] == 'customer-visits/week' for row in gsu))
        self.assertTrue(any(row['value'] == 840 and row['unit'] == 'seats' for row in self.bundle['locations']['west-dining']['evidence']))
        self.assertEqual(self.bundle['libraryHistory']['name'], 'School of Theology Library')
        self.assertEqual(self.bundle['libraryHistory']['sectionObservations'], 11220)
        self.assertEqual(self.bundle['libraryHistory']['observationPeriod'], '2019-06-18 to 2020-02-29')
        self.assertEqual(len(self.bundle['libraryHistory']['patronCounts']), 87)
        self.assertFalse(any('theology' in row['label'].lower() for row in self.bundle['locations']['mugar']['evidence']))

    def test_hours_preserve_dates_and_overnight_windows(self):
        self.assertEqual(hour_windows('7:00am – 2:00am'), [[25200,93600]])
        self.assertEqual(hour_windows('Closed'), [])
        self.assertEqual(hour_windows('Open 24 hours'), [[0,86400]])
        self.assertEqual(hour_windows('Hours unavailable'), [])
        self.assertEqual(self.bundle['referenceWeekStart'], '2026-10-26')
        self.assertTrue(any(row['date'] == '2026-10-19' for row in self.bundle['locations']['mugar']['hours']))
        dining = self.bundle['locations']['warren-dining']['hours']
        self.assertTrue(dining)
        self.assertTrue(all(row['date'] is not None or isinstance(row.get('weekday'), int) for row in dining))

    def test_hidden_and_conflicting_event_locations_stay_unmapped(self):
        events = {row['name']: row for row in self.bundle['events']}
        self.assertEqual(events['Bunkasai']['locationId'], 'gsu')
        self.assertIsNone(events['ISGC Fall Movie Night']['locationId'])
        self.assertIsNone(events['October Town Hall']['locationId'])
        self.assertIsNone(events['BU Film Society Weekly Meeting']['locationId'])
        self.assertEqual(self.bundle['coverage']['mappedEvents'], 4)
        self.assertIsNone(event_location({'locationStatus':'hidden','locationName':'GSU'}, self.bundle['locations'], []))

    def test_routes_allow_precomputed_cross_campus_and_reject_unknown_destinations(self):
        day = {'locations':[{'id':'a','campus':'one'},{'id':'b','campus':'two'}],
               'walkRoutes':{'a>b':{'path':[[0,0],[1,1]],'cumulative':[0,10]}}}
        self.assertEqual(routable_ids(day), {'a', 'b'})
        day['walkRoutes'] = {'a>missing': {'path':[[0,0],[1,1]],'cumulative':[0,10]}}
        with self.assertRaisesRegex(ValueError,'unknown location'):
            routable_ids(day)

    def test_builder_is_offline_deterministic_compact_and_checks_input_hashes(self):
        with tempfile.TemporaryDirectory() as directory, patch('socket.socket',side_effect=AssertionError('network attempted')):
            first = Path(directory)/'first.json'
            second = Path(directory)/'second.json'
            bundle, size = build(output=first)
            build(output=second)
            self.assertEqual(first.read_bytes(),second.read_bytes())
            self.assertLess(size,3_000_000)
            self.assertEqual(bundle['schemaVersion'],1)
            for item in bundle['inputFiles']:
                path = Path(__file__).resolve().parents[2]/item['path']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'catalog.json').write_text('{}')
            (root/'manifest.json').write_text(json.dumps({'datasets':[{'path':'catalog.json','sha256':'incorrect'}]}))
            with self.assertRaisesRegex(ValueError,'checksum'):
                build(root,DEFAULT_MAP,root/'out.json')


if __name__ == '__main__':
    unittest.main()
