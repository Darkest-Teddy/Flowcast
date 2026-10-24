import unittest
from build_runtime_data import build_population


class RuntimeDataTests(unittest.TestCase):
    def test_only_residential_evidence_creates_beds(self):
        population = {"students": {"total": 10, "cohorts": [{"headcount": 10}]}}
        campuses = [{"locations": [
            {"id": "dorm", "kind": "dorm", "capacity": 1000},
            {"id": "unknown", "kind": "dorm", "capacity": 500},
            {"id": "closed", "kind": "dorm", "capacity": 1800},
            {"id": "dining", "kind": "dining", "capacity": 100}]}]
        evidence = lambda value, unit, basis="published": {"value": value, "unit": unit, "basis": basis, "sourceUrl": "https://www.bu.edu/"}
        sources = {"locations": {
            "dorm": {"evidence": [evidence(20, "bed-spaces")]},
            "unknown": {"evidence": [evidence(4000, "visits_per_day")]},
            "closed": {"evidence": [evidence(1800, "residential-spaces", "nominal_complex_total")]},
            "dining": {"evidence": [evidence(90, "seats"), evidence(4000, "meals/day")]}}}
        result = build_population(population, campuses, sources)
        self.assertEqual(result["residentialCapacities"], {"dorm": 20})
        self.assertEqual(result["locationCapacities"], {"dorm": 20, "unknown": 0, "closed": 0, "dining": 90})
        self.assertEqual(population, {"students": {"total": 10, "cohorts": [{"headcount": 10}]}})

    def test_configured_size_proxy_keeps_its_label(self):
        population = {"students": {"total": 1, "cohorts": [{"headcount": 1}]}}
        campuses = [{"locations": [{"id": "cafe", "kind": "dining", "capacity": 60, "capacityNote": "Configured size proxy"},
                                   {"id": "hall", "kind": "dining", "capacity": 500}]}]
        bases = build_population(population, campuses, {"locations": {}})["locationCapacityBasis"]
        self.assertEqual(bases["cafe"], {"basis": "configured_model_capacity", "unit": "people", "confidence": "low", "note": "Configured size proxy"})
        self.assertEqual(bases["hall"], {"basis": "configured_model_capacity", "unit": "people"})

    def test_rejects_inconsistent_roster(self):
        with self.assertRaises(ValueError):
            build_population({"students": {"total": 11, "cohorts": [{"headcount": 10}]}}, [], {"locations": {}})

    def test_dated_component_overrides_nominal_total_only_in_covered_week(self):
        population = {'students': {'total': 10, 'cohorts': [{'headcount': 10}]}}
        campuses = [{'locations': [{'id': 'renovated', 'kind': 'dorm', 'capacity': 1800}]}]
        source = {'referenceWeekStart': '2026-10-19', 'locations': {'renovated': {'evidence': [
            {'value': 1800, 'unit': 'residential-spaces', 'basis': 'nominal_complex_total'}]}}}
        availability = {'records': [{'locationId': 'renovated', 'value': 600, 'unit': 'bed-spaces',
            'basis': 'verified_reopened_component', 'sourceUrl': 'https://www.bu.edu/example',
            'sourceUrls': ['https://www.bu.edu/example'], 'coverage': 'partial', 'note': 'Tower A only',
            'validFrom': '2026-10-19', 'validTo': '2026-10-25'}]}
        actual = build_population(population, campuses, source, availability)
        self.assertEqual(actual['residentialCapacities'], {'renovated': 600})
        self.assertEqual(actual['locationCapacityBasis']['renovated']['coverage'], 'partial')
        source['referenceWeekStart'] = '2026-10-26'
        self.assertEqual(build_population(population, campuses, source, availability)['residentialCapacities'], {})

    def test_classrooms_deduplicate_room_seats_without_creating_residential_beds(self):
        population = {'students': {'total': 10, 'cohorts': [{'headcount': 10}]}}
        campuses = [{'locations': [{'id': 'mixed', 'kind': 'dorm', 'capacity': 0},
                                  {'id': 'class', 'kind': 'classroom', 'capacity': 900}]}]
        meeting = lambda room, seats: {'roomCode': room, 'roomCapacity': seats, 'calendarRestricted': False}
        source = {'locations': {'mixed': {'evidence': [], 'meetings': [meeting('114', None), meeting('114', 150), meeting('114', 150)]},
                               'class': {'evidence': [], 'meetings': [meeting('A', 100), meeting('A', 100), meeting('B', None)]}}}
        actual = build_population(population, campuses, source)
        self.assertEqual(actual['locationCapacities']['mixed'], 150)
        self.assertNotIn('mixed', actual['residentialCapacities'])
        self.assertEqual(actual['locationCapacities']['class'], 124)
        self.assertEqual(actual['academicCapacities']['mixed']['confidence'], 'published')
        self.assertEqual(actual['academicCapacities']['class']['modeledRooms'], 1)

    def test_same_room_number_in_distinct_buildings_is_not_merged(self):
        population = {'students': {'total': 1, 'cohorts': [{'headcount': 1}]}}
        campuses = [{'locations': [{'id': 'combined', 'kind': 'classroom', 'capacity': 900}]}]
        meetings = [{'buildingCode': code, 'roomCode': '101', 'roomCapacity': seats} for code, seats in [('A', 40), ('B', 60)]]
        source = {'locations': {'combined': {'buildingCodes': ['A', 'B'], 'evidence': [], 'meetings': meetings}}}
        actual = build_population(population, campuses, source)
        self.assertEqual(actual['locationCapacities']['combined'], 100)
        del meetings[0]['buildingCode']
        with self.assertRaisesRegex(ValueError, 'Ambiguous building code'):
            build_population(population, campuses, source)

    def test_activity_quota_does_not_replace_building_reference_and_estimates_expire(self):
        population = {'students': {'total': 1, 'cohorts': [{'headcount': 1}]}}
        campuses = [{'locations': [{'id': 'arena', 'kind': 'gym', 'capacity': 1500}]}]
        source = {'referenceWeekStart': '2026-10-19', 'locations': {'arena': {'evidence': [], 'meetings': []}}}
        profiles = {'referenceWeekStart': '2026-10-19', 'housing': [], 'activities': [
            {'locationId': 'arena', 'capacity': 120, 'confidence': 'low', 'note': 'Student practice quota', 'proxy': 'Configured size and purpose'}]}
        actual = build_population(population, campuses, source, estimates=profiles)
        self.assertEqual(actual['locationCapacities']['arena'], 1500)
        self.assertEqual(actual['locationEstimatedProfiles']['arena']['capacity'], 120)
        self.assertEqual(actual['locationCapacityBasis']['arena']['basis'], 'estimated_student_capacity')
        source['referenceWeekStart'] = '2026-10-26'
        with self.assertRaisesRegex(ValueError, 'require review'):
            build_population(population, campuses, source, estimates=profiles)
