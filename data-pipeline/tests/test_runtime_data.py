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
