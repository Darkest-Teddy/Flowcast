import copy
import unittest

from build_map_data import catalog_course_coverage


def row(code, section, start=36000, building='CAS', notes=None):
    return {'courseCode': code, 'section': section, 'buildingCode': building,
            'roomCode': '101', 'notes': notes,
            'intervals': [{'weekday': 0, 'startSec': start, 'endSec': start+3000}]}


class CatalogCoverageTests(unittest.TestCase):
    def test_components_and_repeated_rows_do_not_multiply_course_offerings(self):
        rows = [row('CAS CS 111', 'A1'), row('CAS CS 111', 'B1', 45000), row('CAS MA 123', 'A1')]
        first = catalog_course_coverage({'meetings': rows})
        repeated = catalog_course_coverage({'meetings': rows + copy.deepcopy(rows)})
        self.assertEqual(first, repeated)
        self.assertEqual(first['courseCodes'], ['CAS CS 111', 'CAS MA 123'])
        self.assertEqual(len(first['courseGroups']), 2)

    def test_only_complete_matching_timetables_are_grouped(self):
        rows = [row('CAS AA 400', 'A1'), row('GRS AA 600', 'X1'),
                row('CAS BB 400', 'A1'), row('CAS BB 400', 'B1', 45000)]
        groups = catalog_course_coverage({'meetings': rows})['courseGroups']
        self.assertEqual(groups, [['CAS AA 400', 'GRS AA 600'], ['CAS BB 400']])

    def test_unmapped_physical_courses_remain_and_date_restrictions_do_not(self):
        result = catalog_course_coverage({'meetings': [row('CAS MA 123', 'A1', building='STO'),
            row('CAS XX 100', 'A1', notes='Meets November 1 only.')], 'excludedMeetings': [{}]})
        self.assertEqual(result['courseCodes'], ['CAS MA 123'])
        self.assertEqual(result['excludedCalendarRestrictedRows'], 1)
        self.assertEqual(result['excludedUnscheduledOrNonphysicalRows'], 1)
