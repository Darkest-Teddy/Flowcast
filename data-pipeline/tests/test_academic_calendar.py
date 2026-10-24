from datetime import date
import unittest

from common import ScrapeError, Source
from scrape_academic_calendar import date_range, effective_intervals, parse_calendar


HTML = '''<h3>Fall 2026</h3><table>
<tr><th>September 2, 2026</th><td>Classes Begin</td></tr>
<tr><th>September 16, 2026</th><td>Last Day to Add Standard Courses</td></tr>
<tr><th>October 12, 2026</th><td>Holiday, Classes Suspended</td></tr>
<tr><th>October 13, 2026</th><td>Substitute Monday Schedule of Classes</td></tr>
<tr><th>November 25 – 29, 2026</th><td>Thanksgiving Recess</td></tr>
<tr><th>December 10, 2026</th><td>Last Day of Classes</td></tr>
<tr><th>December 11 – 13, 2026</th><td>Study Period</td></tr>
<tr><th>December 14, 2026</th><td>Final Exams Begin</td></tr>
<tr><th>December 18, 2026</th><td>Final Exams End</td></tr>
</table><h3>Fall 2025</h3><table><tr><th>Other year</th><td>Not imported</td></tr></table>'''


class AcademicCalendarTests(unittest.TestCase):
    def calendar(self, html=HTML):
        source = Source('https://www.bu.edu/reg/calendars/semester/', html.encode(), '2026-10-24T12:00:00Z')
        return parse_calendar(source, ('FALL 2026',))

    def meeting(self, **extra):
        return {'courseCode': 'CAS MA 123', 'term': 'FALL 2026', 'intervals': [
            {'weekday': 0, 'startSec': 32400, 'endSec': 36000},
            {'weekday': 1, 'startSec': 86400 + 39600, 'endSec': 86400 + 43200}], **extra}

    def test_collects_only_selected_term_and_schedule_events(self):
        calendar = self.calendar()
        term = calendar['terms'][0]
        self.assertEqual(term['classesStart'], '2026-09-02')
        self.assertEqual(term['classesEnd'], '2026-12-10')
        self.assertEqual(term['substitutions'], [{'date': '2026-10-13', 'scheduleWeekday': 0}])
        self.assertEqual(term['suspendedDates'], ['2026-10-12'] + [f'2026-11-{day}' for day in range(25, 30)])
        self.assertEqual(len(term['events']), 8)
        self.assertIn('LAW', calendar['excludedCoursePrefixes'])
        self.assertNotIn('LAW', calendar['applicableCoursePrefixes'])

    def test_remaps_monday_to_tuesday_without_also_running_tuesday_classes(self):
        result = effective_intervals(self.meeting(), date(2026, 10, 12), self.calendar())
        self.assertEqual(result, [{'weekday': 1, 'startSec': 86400 + 32400, 'endSec': 86400 + 36000}])

    def test_actual_attendance_date_controls_section_bounds(self):
        self.assertEqual(effective_intervals(self.meeting(validTo='2026-10-12'), '2026-10-12', self.calendar()), [])
        result = effective_intervals(self.meeting(validFrom='2026-10-13'), '2026-10-12', self.calendar())
        self.assertEqual(len(result), 1)

    def test_other_schools_and_uncollected_terms_are_not_rewritten(self):
        for code in ('LAW JD 101', 'MED MD 121', 'GMS AN 700', 'SDM RS 100', 'SPH PH 700', 'SSW HB 720', 'UNKNOWN 123'):
            meeting = self.meeting(courseCode=code)
            self.assertEqual(effective_intervals(meeting, '2026-10-12', self.calendar()), meeting['intervals'])
        meeting = self.meeting(term='FALL 2025')
        self.assertEqual(effective_intervals(meeting, '2026-10-12', self.calendar()), meeting['intervals'])

    def test_term_bounds_do_not_create_regular_classes_during_exams(self):
        for monday in ('2026-08-24', '2026-12-14', '2027-01-04'):
            self.assertEqual(effective_intervals(self.meeting(), monday, self.calendar()), [])

    def test_parses_cross_month_range_and_rejects_bad_or_incomplete_source(self):
        self.assertEqual([d.isoformat() for d in date_range('April 30 – May 2, 2027')], ['2027-04-30', '2027-05-01', '2027-05-02'])
        for value in ('February 30, 2026', 'November 29 – 25, 2026', 'TBD'):
            with self.assertRaises(ScrapeError):
                date_range(value)
        with self.assertRaises(ScrapeError):
            self.calendar(HTML.replace('Last Day of Classes', 'changed markup'))
        with self.assertRaises(ScrapeError):
            self.calendar(HTML.replace('Substitute Monday', 'Substitute Special'))
