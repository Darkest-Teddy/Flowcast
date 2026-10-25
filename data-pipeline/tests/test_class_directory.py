import unittest

from build_class_directory import build_directory


class ClassDirectoryTests(unittest.TestCase):
    def test_keeps_mapped_buildings_and_published_instructors_only(self):
        catalog = {
            "buildings": [
                {"buildingCode": "CAS", "name": "College of Arts & Sciences", "address": "685-725 Commonwealth Avenue", "provenance": {"url": "https://example.test/codes"}},
                {"buildingCode": "ZZZ", "name": "Unmapped", "address": "1 Nowhere"},
            ],
            "meetings": [
                {"id": "m1", "instructor": " Neri, Wisco "},
                {"id": "m2", "instructor": None},
                {"id": "m3", "instructor": "Off map"},
            ],
        }
        campus = {"term": "FALL 2026", "locations": {"cas": {"meetings": [
            {"id": "m1", "buildingCode": "CAS"}, {"id": "m2", "buildingCode": "CAS"}]}}}
        directory = build_directory(catalog, campus)
        self.assertEqual(directory["buildings"], {"CAS": {"name": "College of Arts & Sciences", "address": "685-725 Commonwealth Avenue"}})
        self.assertEqual(directory["instructors"], {"m1": "Neri, Wisco"})
        self.assertEqual(directory["buildingsSourceUrl"], "https://example.test/codes")


if __name__ == "__main__":
    unittest.main()
