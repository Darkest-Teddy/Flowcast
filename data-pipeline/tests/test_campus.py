import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from common import ScrapeError, Source
from crawl_campus_catalog import ACADEMICS, checked_page, discover_classrooms, index_links, load_resume, run
from scrape_catalog import BUILDINGS_URL, discover_courses

ROOT = ACADEMICS + 'cas/courses/'


def source(url, html):
    return Source(url, html.encode(), '2026-10-24T00:00:00Z')


class CampusTests(unittest.TestCase):
    def test_actual_numeric_pagination_is_followed(self):
        class Fetcher:
            def get(self, url):
                return source(url, '<a href="'+ROOT+'2/">2</a><a href="'+ROOT+'cas-ma-123/">Course</a>')
        urls, provenance, warnings, errors = discover_courses(Fetcher(), [ROOT], 3)
        self.assertEqual(len(provenance), 2)
        self.assertEqual(urls, [ROOT+'cas-ma-123/'])
        self.assertFalse(errors)
        courses, pages, _ = index_links(Fetcher().get(ROOT), ROOT)
        self.assertEqual(pages, {2})
        self.assertEqual(courses, {ROOT+'cas-ma-123/'})

    def test_redirected_school_is_not_counted_as_coverage(self):
        class Fetcher:
            def get(self, url):
                return source(ACADEMICS+'com/courses/', '<h1>Courses</h1>')
        with self.assertRaisesRegex(ScrapeError, 'Unexpected redirect'):
            checked_page(Fetcher(), ACADEMICS+'fitrec/courses/')

    def test_external_redirect_with_same_path_is_not_coverage(self):
        class Fetcher:
            def get(self, url):
                return source('https://other.example/academics/cas/courses/', '<h1>Courses</h1>')
        with self.assertRaisesRegex(ScrapeError, 'Unexpected redirect'):
            checked_page(Fetcher(), ROOT)

    def test_directory_preserves_canonical_links_and_combined_rooms(self):
        url = 'https://www.bu.edu/classrooms/find-a-classroom/?cts_filter_submit=Search'
        html = '<div class="cts-results-list-details"><h4>ABG-101 (Bakst Auditorium)</h4><a href="/classrooms/classroom/bakst-auditorium/">View Details</a></div><div class="cts-results-list-details"><h4>ALB-107/108</h4><a href="/classrooms/classroom/alb-107-108/">View Details</a></div>'
        class Fetcher:
            def get(self, requested):
                return source(requested, html)
        directory, _ = discover_classrooms(Fetcher())
        self.assertEqual(directory[('ABG','101')], 'https://www.bu.edu/classrooms/classroom/bakst-auditorium/')
        self.assertIn(('ALB','107/108'),directory)
        self.assertNotIn(('ALB','107'),directory)

    def test_resume_does_not_drop_missing_excluded_records(self):
        course = {'url': ROOT+'cas-ma-123/', 'term':'FALL 2026', 'scheduleStatus':'published', 'meetingCount':0, 'excludedMeetingCount':1}
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'courses.jsonl').write_text(json.dumps(course)+'\n')
            self.assertEqual(load_resume(directory,'FALL 2026'), {})

    def test_failed_detail_retains_the_public_index_listing(self):
        pages = {
            ACADEMICS: '<h3><a href="/academics/cas/">CAS</a></h3>',
            ACADEMICS+'cas/': '<a href="/academics/cas/courses/">Courses</a>',
            ROOT: '<a href="'+ROOT+'cas-ma-123/">CAS MA 123: Calculus 1</a>',
            BUILDINGS_URL: '<table><tr><th>Code</th><th>Name</th><th>Street Address</th></tr><tr><td>STO</td><td>Stone</td><td>675 Commonwealth</td></tr></table>',
        }
        class Fetcher:
            def get(self, url):
                if url not in pages:
                    raise ScrapeError('HTTP 404 fetching '+url)
                return source(url, pages[url])
        with tempfile.TemporaryDirectory() as directory:
            result = run(Fetcher(), directory, workers=1)
        self.assertEqual(result['courses'][0]['courseCode'], 'CAS MA 123')
        self.assertEqual(result['courses'][0]['title'], 'Calculus 1')
        self.assertEqual(result['courses'][0]['scheduleStatus'], 'detail_source_failed')
        self.assertEqual(result['courses'][0]['provenance']['url'], ROOT)
        self.assertEqual(result['coverage']['counts']['coursePagesParsed'], 0)
        self.assertEqual(result['coverage']['counts']['coursesWithUnavailableDetails'], 1)
        self.assertEqual(result['status'], 'partial')

    def test_full_run_retains_courses_without_schedules_and_checksums(self):
        pages = {
            ACADEMICS: '<h3><a href="/academics/cas/">CAS</a></h3><h3><a href="https://www.bu.edu/summer/">Summer</a></h3>',
            ACADEMICS+'cas/': '<a href="/academics/cas/courses/">Courses</a>',
            ROOT: '<a href="'+ROOT+'cas-ma-123/">MA123</a><a href="'+ROOT+'2/">2</a>',
            ROOT+'2/': '<a href="'+ROOT+'cas-ma-124/">MA124</a>',
            ROOT+'cas-ma-123/': '<div id="col1"><h1>Calculus</h1><h2>CAS MA 123</h2><h4>FALL 2026 Schedule</h4><table><tr><th>Section</th><th>Location</th><th>Schedule</th></tr><tr><td>A1</td><td>STO B50</td><td>M 9:00 am-10:00 am</td></tr></table></div>',
            ROOT+'cas-ma-124/': '<div id="col1"><h1>Calculus 2</h1><h2>CAS MA 124</h2></div>',
            BUILDINGS_URL: '<table><tr><th>Code</th><th>Name</th><th>Street Address</th></tr><tr><td>STO</td><td>Stone</td><td>675 Commonwealth</td></tr></table>',
            'https://www.bu.edu/classrooms/classroom/sto-b50/': ''.join('<li><span class="meta-name">'+k+'</span><span class="meta-value">'+v+'</span></li>' for k,v in [('Capacity','220'),('Building Code','STO'),('Room Number','B50')]),
        }
        class Fetcher:
            def get(self, url):
                if url not in pages:
                    raise ScrapeError('Missing fixture '+url)
                return source(url, pages[url])
        with tempfile.TemporaryDirectory() as directory:
            result = run(Fetcher(), directory, workers=2)
            self.assertFalse(result['errors'])
            self.assertEqual(len(result['courses']), 2)
            self.assertEqual(result['coverage']['counts']['coursesWithoutTargetTermTables'], 1)
            self.assertEqual(result['meetings'][0]['roomCapacity']['value'],220)
            manifest = json.loads((Path(directory)/'manifest.json').read_text())
            for item in manifest['files']:
                self.assertEqual(hashlib.sha256((Path(directory)/item['path']).read_bytes()).hexdigest(),item['sha256'])
            self.assertEqual(result['coverage']['academicAreas'][1]['status'], 'external_academic_area_not_in_bulletin_crawl')
            class ResumeFetcher(Fetcher):
                def get(self, url):
                    if url.endswith('cas-ma-123/') or url.endswith('cas-ma-124/'):
                        raise AssertionError('Resume fetched a completed course detail')
                    return super().get(url)
            resumed = run(ResumeFetcher(),directory,workers=2,resume=True)
            self.assertEqual(resumed['coverage']['reusedParsedCourses'],2)
            self.assertEqual(len(resumed['meetings']),1)



if __name__=='__main__':
    unittest.main()
