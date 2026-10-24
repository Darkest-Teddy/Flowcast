import copy
from datetime import date
import unittest

from build_map_data import build, catalog_course_coverage
from hackathon_catalog import course_code, intervals, merge


class CatalogImportTests(unittest.TestCase):
    def setUp(self):
        self.public = {"term": "FALL 2026", "courses": [{"courseCode": "CAS MA 123"}, {"courseCode": "CAS XX 999"}],
            "meetings": [{"courseCode": "CAS MA 123", "id": "old"}, {"courseCode": "CAS XX 999", "id": "retained"}],
            "excludedMeetings": [], "sources": [], "buildings": [],
            "classrooms": [{"buildingCode": "CAS", "roomCode": "100", "capacity": {"value": 30, "unit": "seats"}, "provenance": {"url": "https://example.com/room"}}]}
        self.payload = {"termCode": "2268", "retrievedAt": "2026-10-24T12:00:00Z", "datasetInfo": [],
            "courses": [{"course_key": "c", "subject": "CASMA", "catalog_number": "123", "display_code": "CASMA123",
                "term_code": "2268", "title": "Calculus", "description": "", "academic_career": "UGRD", "session_code": "1"}],
            "sections": [{"section_key": "s", "course_key": "c", "section": "A1", "section_type": "Lecture", "instruction_type": "In-Person", "start_date": "20261020", "end_date": "20261023"}],
            "meetings": [{"section_key": "s", "meeting_index": 1, "building_code": "CAS", "building": "Arts", "room": "100", "facility_code": "CAS 100", "day": "MWF", "start_time": "09.00.00.000000", "end_time": "10.00.00.000000"}]}

    def test_precedence_preserves_other_courses_capacity_and_inputs(self):
        before = copy.deepcopy(self.public)
        result = merge(self.public, self.payload)
        self.assertEqual(before, self.public)
        self.assertEqual([r['id'] for r in result['meetings'] if not r['id'].startswith('bu-db-')], ['retained'])
        row = result['meetings'][-1]
        self.assertEqual(row['roomCapacity']['value'], 30)
        self.assertEqual(row['validFrom'], '2026-10-20')
        self.assertEqual(row['validTo'], '2026-10-23')
        self.assertEqual(row['sourceSectionKey'], 's')
        self.assertIsNone(row['enrollment'])
        self.assertEqual(row['intervals'][1]['startSec'], 2 * 86400 + 32400)
        self.assertEqual(result['hackathonCoverage']['retainedPublicMeetings'], 1)

    def test_no_physical_meeting_still_replaces_stale_scraped_schedule(self):
        self.payload['meetings'][0]['building_code'] = ''
        result = merge(self.public, self.payload)
        self.assertEqual([r['id'] for r in result['meetings']], ['retained'])
        self.assertEqual(result['excludedMeetings'][0]['reason'], 'no_physical_location')

    def test_display_suffix_is_a_distinct_course(self):
        row = {**self.payload['courses'][0], 'display_code': 'CASMA123E'}
        self.assertEqual(course_code(row), 'CAS MA 123E')

    def test_rejects_other_terms_duplicate_ids_and_reversed_dates(self):
        for mutate in [lambda p: p.update(termCode='2271'),
                       lambda p: p['meetings'].append(p['meetings'][0]),
                       lambda p: p['sections'][0].update(end_date='20260101')]:
            payload = copy.deepcopy(self.payload)
            mutate(payload)
            with self.assertRaises(ValueError):
                merge(self.public, payload)

    def test_invalid_schedule_is_excluded(self):
        self.payload['meetings'][0]['end_time'] = '08.00.00.000000'
        result = merge(self.public, self.payload)
        self.assertEqual(result['excludedMeetings'][0]['reason'], 'invalid_schedule')

    def test_coverage_uses_session_dates(self):
        result = merge(self.public, self.payload)
        result['meetings'] = [result['meetings'][-1]]
        self.assertEqual(catalog_course_coverage(result, date(2026, 10, 19))['courseCodes'], ['CAS MA 123'])
        self.assertEqual(catalog_course_coverage(result, date(2026, 10, 26))['courseCodes'], [])

    def test_cannot_write_private_data_into_public_bundle(self):
        with self.assertRaisesRegex(ValueError, 'Restricted hackathon bundles'):
            build(hackathon_catalog='unused.json')
