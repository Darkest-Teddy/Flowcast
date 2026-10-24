import unittest
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import ScrapeError
from scrape_catalog import clock_seconds, collect, discover_courses, flag_shared_meetings, parse_buildings, parse_classroom, parse_course, parse_schedule


def source(html):
    return SimpleNamespace(text=html, body=html.encode(), url="https://www.bu.edu/example/", provenance={"url": "https://www.bu.edu/example/", "fetchedAt": "2026-10-24T12:00:00Z"})


def course_html(code="CAS MA 123"):
    return f'''<div id="col1"><h1>Calculus 1</h1><h2>{code}</h2><div class="cf-course">
    <h4><strong>FALL 2026</strong> Schedule</h4><table>
    <tr><th>Section</th><th>Instructor</th><th>Location</th><th>Schedule</th><th>Notes</th></tr>
    <tr><td>A2</td><td>Kimura</td><td>NO ROOM</td><td>R 6:30 pm-8:30 pm</td><td>reserve Thursdays for exams</td></tr>
    <tr><td>A2</td><td>Kimura</td><td>STO B50</td><td>TR 2:00 pm-3:15 pm</td><td>reserve Thursdays for exams</td></tr>
    </table><h4>SPRING 2027 Schedule</h4><table>
    <tr><th>Section</th><th>Location</th><th>Schedule</th></tr>
    <tr><td>A3</td><td>CAS 216</td><td>M 9:00 am-10:00 am</td></tr></table></div></div>'''


class CatalogTests(unittest.TestCase):
    def test_course_terms_exam_reservations_and_week_seconds(self):
        result = parse_course(source(course_html()))
        self.assertEqual(len(result["meetings"]), 1)
        meeting = result["meetings"][0]
        self.assertEqual(meeting["section"], "A2")
        self.assertEqual(meeting["buildingCode"], "STO")
        self.assertEqual(meeting["intervals"], [
            {"weekday": 1, "startSec": 86400+14*3600, "endSec": 86400+15*3600+15*60},
            {"weekday": 3, "startSec": 3*86400+14*3600, "endSec": 3*86400+15*3600+15*60},
        ])
        self.assertIsNone(meeting["enrollment"])
        self.assertIsNone(meeting["locationId"])
        self.assertEqual(result["excludedMeetings"][0]["reason"], "exam_reservation")
        self.assertEqual(len(parse_course(source(course_html()), "SPRING 2027")["meetings"]), 1)

    def test_rejects_arranged_bad_times_and_does_not_fall_back_to_other_term(self):
        for value in ["ARR", "TR 3:00 pm-2:00 pm", "M 13:00 am-2:00 pm"]:
            with self.assertRaises(ValueError):
                parse_schedule(value)
        self.assertEqual(clock_seconds("12:00 am"), 0)
        self.assertEqual(clock_seconds("12:00 pm"), 43200)
        result = parse_course(source(course_html()), "FALL 2025")
        self.assertEqual(result["meetings"], [])
        self.assertIn("no term fallback", result["warnings"][0])

    def test_room_capacity_and_identity_validation(self):
        html = ''.join(f'<li><span class="meta-name">{key}</span><span class="meta-value">{value}</span></li>' for key, value in {
            "Building Code": "STO", "Room Number": "B50", "Capacity": "220", "Address": "675 Commonwealth Avenue"}.items())
        room = parse_classroom(source(html), "STO", "B50")
        self.assertEqual(room["capacity"]["value"], 220)
        self.assertEqual(room["capacity"]["measure"], "capacity")
        with self.assertRaises(ScrapeError):
            parse_classroom(source(html), "CAS", "B50")

    def test_building_table_first_cell_can_be_th(self):
        html = '<table><tr><th>Code</th><th>Full Name</th><th>Street Address</th></tr><tr><th>STO</th><td>Stone Science Building</td><td>675 Commonwealth Avenue</td></tr></table>'
        self.assertEqual(parse_buildings(source(html))[0]["buildingCode"], "STO")

    def test_combined_candidates_are_flagged_not_summed_or_deleted(self):
        first = parse_course(source(course_html()))["meetings"][0]
        second = parse_course(source(course_html("CAS MA 124")))["meetings"][0]
        meetings = [first, second]
        flag_shared_meetings(meetings)
        self.assertEqual(len(meetings), 2)
        self.assertEqual(first["possibleCombinedMeetingIds"], [second["id"]])
        self.assertIn("before_aggregation", first["countingStatus"])

    def test_collect_preserves_course_when_room_lookup_fails(self):
        class Fetcher:
            def get(self, url):
                if url.endswith("cas-ma-123/"):
                    return source(course_html())
                if url.endswith("building-codes/"):
                    return source('<table><tr><th>Code</th><th>Full Name</th><th>Street Address</th></tr><tr><th>STO</th><td>Stone</td><td>675 Commonwealth Avenue</td></tr></table>')
                raise ScrapeError("HTTP 404 fetching " + url)
        result = collect(Fetcher(), course_urls=["https://www.bu.edu/academics/cas/courses/cas-ma-123/"])
        self.assertEqual(len(result["meetings"]), 1)
        self.assertIsNone(result["meetings"][0]["roomCapacity"])
        self.assertEqual(result["meetings"][0]["address"], "675 Commonwealth Avenue")
        self.assertEqual(len(result["errors"]), 1)

    def test_index_discovery_bounded_and_does_not_crawl_external_links(self):
        class Fetcher:
            calls = []
            def get(self, url):
                self.calls.append(url)
                page = source('<a href="/academics/cas/courses/cas-ma-123/">MA123</a><a rel="next" href="/academics/cas/courses/page/2/">Next</a><a href="https://example.com/academics/cas/courses/cas-ma-123/">External</a>')
                page.url = url
                return page
        fetcher = Fetcher()
        urls, _, warnings, errors = discover_courses(fetcher, ["https://www.bu.edu/academics/cas/courses/"], 1)
        self.assertEqual(urls, ["https://www.bu.edu/academics/cas/courses/cas-ma-123/"])
        self.assertEqual(len(fetcher.calls), 1)
        self.assertTrue(warnings)
        self.assertEqual(errors, [])

    def test_failed_index_is_error_even_if_explicit_course_succeeds(self):
        class Fetcher:
            def get(self, url):
                if url.endswith("cas-ma-123/"):
                    return source(course_html())
                if url.endswith("building-codes/"):
                    return source('<table><tr><th>Code</th><th>Full Name</th><th>Street Address</th></tr><tr><th>STO</th><td>Stone</td><td>675 Commonwealth Avenue</td></tr></table>')
                raise ScrapeError("HTTP 503 fetching " + url)
        index_url = "https://www.bu.edu/academics/cas/courses/"
        result = collect(Fetcher(), course_urls=["https://www.bu.edu/academics/cas/courses/cas-ma-123/"], index_urls=[index_url])
        self.assertEqual(len(result["meetings"]), 1)
        self.assertEqual(len([error for error in result["errors"] if error.get("url") == index_url]), 1)

    def test_malformed_columns_are_preserved_as_structured_rejects(self):
        html = course_html().replace('<td>STO B50</td>', '')
        result = parse_course(source(html))
        rejected = next(record for record in result["excludedMeetings"] if record["reason"] == "malformed_columns")
        self.assertEqual(len(rejected["rawCells"]), 4)
        self.assertEqual(len(rejected["expectedColumns"]), 5)
        self.assertIn("provenance", rejected)


if __name__ == "__main__":
    unittest.main()
