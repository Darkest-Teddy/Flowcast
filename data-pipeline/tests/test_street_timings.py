import copy
import json
import unittest

from fetch_street import BU_SHEETS, OUT, refresh_published_timings


class PublishedTimingTests(unittest.TestCase):
    def test_refresh_is_reproducible_and_preserves_geometry(self):
        data = json.loads(OUT.read_text())
        refreshed = refresh_published_timings(copy.deepcopy(data))
        self.assertEqual(refreshed, data)
        self.assertEqual(refreshed["signals"], data["signals"])

    def test_refresh_uses_published_input_not_existing_generated_plan(self):
        data = json.loads(OUT.read_text())
        intersection = next(item for item in data["intersections"] if item.get("node") == 2)
        intersection["plans"][0]["cycle"] = 999
        refreshed = refresh_published_timings(data)
        actual = next(item for item in refreshed["intersections"] if item.get("node") == 2)
        sheet = next(item for item in BU_SHEETS if item["node"] == 2)
        self.assertEqual(actual["plans"][0]["cycle"], sheet["AM"][0])
        self.assertEqual(actual["plans"][0]["offset"], sheet["AM"][1])
