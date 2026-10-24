import copy
import unittest

from build_map_data import build
from hackathon_dining import overlay


class HackathonDiningTests(unittest.TestCase):
    def setUp(self):
        self.snapshots = {"opening_hours": {"locations": [
            {"locationId": "warren-dining", "hours": [
                {"date": "2026-10-24", "windows": [[1, 2]]},
                {"date": "2026-10-25", "windows": [[3, 4]]}]},
            {"locationId": "gsu", "hours": [{"date": "2026-10-24", "windows": [[5, 6]]}]},
        ]}, "dining": {"measurements": [{"value": 900, "unit": "seats"}]}}
        self.menu = {"location": {"id": "warren"}, "date": "2026-10-24",
                     "fetched_at": "2026-10-24T12:00:00Z", "stale": False,
                     "schedules": [{"meal": "Breakfast", "opens_at": "09:00", "closes_at": "11:00"},
                                   {"meal": "Lunch", "opens_at": "11:00", "closes_at": "17:00"}]}

    def test_replaces_only_matching_date_and_retains_other_facts(self):
        before = copy.deepcopy(self.snapshots)
        result = overlay(self.snapshots, {"menus": [self.menu]})
        self.assertEqual(self.snapshots, before)
        self.assertEqual(result["dining"], before["dining"])
        self.assertEqual(result["opening_hours"]["locations"][1], before["opening_hours"]["locations"][1])
        hours = result["opening_hours"]["locations"][0]["hours"]
        self.assertEqual(hours[0], before["opening_hours"]["locations"][0]["hours"][1])
        self.assertEqual(hours[1]["windows"], [[32400, 61200]])
        self.assertIn("/api/v1/dining/", hours[1]["sourceUrl"])

    def test_empty_schedule_does_not_claim_closure(self):
        self.menu["schedules"] = []
        self.assertEqual(overlay(self.snapshots, {"menus": [self.menu]}), self.snapshots)

    def test_invalid_or_stale_data_fails(self):
        for field, value in [("stale", True), ("date", "bad"), ("schedules", [
            {"meal": "Dinner", "opens_at": "25:00", "closes_at": "26:00"}])]:
            menu = {**self.menu, field: value}
            with self.assertRaises(ValueError):
                overlay(self.snapshots, {"menus": [menu]})
        with self.assertRaises(ValueError):
            overlay(self.snapshots, {"menus": [self.menu, self.menu]})

    def test_overnight_hours(self):
        self.menu["schedules"] = [{"meal": "Late", "opens_at": "22:00", "closes_at": "02:00"}]
        result = overlay(self.snapshots, {"menus": [self.menu]})
        self.assertEqual(result["opening_hours"]["locations"][0]["hours"][-1]["windows"], [[79200, 93600]])

    def test_restricted_bundle_cannot_overwrite_public_output(self):
        with self.assertRaisesRegex(ValueError, "Restricted hackathon bundles"):
            build(hackathon_dining="unused.json")
