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
