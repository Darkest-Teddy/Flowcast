import unittest

from common import ScrapeError
from scrape_population import parse_enrollment, parse_fact_sheet, parse_housing


ENROLLMENT = """2025-2026
Total degree-seeking 7,083 10,340
Total Undergraduate Full-Time Students 7,253 10,565
Total degree-seeking 100 105
Total Undergraduate Part-Time Students 199 272
Graduate Students: Full-Time
Total Graduate Full-Time Students 4,226 6,305
Total Graduate Part-Time Students 3,672 4,485
Total all undergraduates 18,289
Total all graduate 18,688
GRAND TOTAL ALL STUDENTS 36,977
"""
HOUSING = """99% 57%
Percent who live off campus or commute 1% 43%
Percent who live in college-owned, -operated, or -affiliated housing
F1. Percentages of first-time, first-year degree-seeking students and degree-seeking undergraduates enrolled in Fall 2025
"""
FACT = """FACT SHEET 2025/2026
B. CHARLES RIVER CAMPUS, FTE ENROLLMENTS
TOTAL 27,185 26,187 -3.7
B. MEDICAL CAMPUS, FTE ENROLLMENTS
FALL OF: TOTAL 78,769 100.0 3,268 100.0 76,776 100.0 3,449 100.0
TOTAL 3,054 3,128 2.4
Residences - Total Capacity 12,351
A. TOTAL UNIVERSITY EMPLOYEES
TOTAL 7,871 3,269 0 11,140
"""


class PopulationTests(unittest.TestCase):
    def test_degree_seeking_housing_denominator_excludes_nondegree_students(self):
        students = parse_enrollment(ENROLLMENT)
        self.assertEqual(students["total"], 36977)
        self.assertEqual(students["degreeSeekingUndergraduate"], 17628)
        self.assertEqual([c["headcount"] for c in students["cohorts"]], [17818, 471, 10531, 8157])
        housing = parse_housing(HOUSING, students["degreeSeekingUndergraduate"])
        self.assertEqual(housing["estimatedUndergraduateResidents"], 10048)
        self.assertEqual(housing["degreeSeekingUndergraduateResidentPercent"], 57)
        self.assertIsNone(students["charlesRiverHeadcount"])
        self.assertIsNone(students["exclusivelyDistanceEducation"])

    def test_rejects_unreconciled_enrollment(self):
        with self.assertRaises(ScrapeError):
            parse_enrollment(ENROLLMENT.replace("36,977", "37,977"))

    def test_rejects_changed_housing_scope(self):
        with self.assertRaises(ScrapeError):
            parse_housing(HOUSING.replace("degree-seeking undergraduates", "all students"), 17628)
        with self.assertRaises(ScrapeError):
            parse_housing(HOUSING.replace("43%", "44%"), 17628)

    def test_fte_and_capacity_are_not_people(self):
        fact = parse_fact_sheet(FACT)
        self.assertEqual(fact["campusStudentFte"]["charlesRiver"], 26187)
        self.assertEqual(fact["campusStudentFte"]["medical"], 3128)
        self.assertEqual(fact["campusStudentFte"]["unit"], "full-time equivalents")
        self.assertEqual(fact["employees"]["charlesRiver"], 7871)
        self.assertEqual(fact["employees"]["total"], 11140)
        self.assertEqual(fact["residenceCapacity"], 12351)
        with self.assertRaises(ScrapeError):
            parse_fact_sheet(FACT.replace("11,140", "11,141"))


if __name__ == "__main__":
    unittest.main()
