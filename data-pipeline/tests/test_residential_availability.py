import unittest
from common import Source, ScrapeError
from scrape_residential_availability import parse_warren


class ResidentialAvailabilityTests(unittest.TestCase):
    def test_reopening_is_partial_not_nominal_complex_total(self):
        source = lambda text: Source('https://www.bu.edu/articles/2026/example/', f'<main>{text}</main>'.encode(), '2026-10-24')
        article = source('Tower A Reopens to Students. The newly renovated Tower A houses 600 students. The complex houses 1,800 students.')
        faq = source('For fall 2026, plans are to assign the 595 students from Warren Towers (B Tower) to the Fenway Campus.')
        project = source('Tower C completion fall semester of 2028')
        record = parse_warren(article, faq, project)
        next_week = parse_warren(article, faq, project, '2026-10-26')
        self.assertEqual(next_week['validFrom'], '2026-10-26')
        self.assertEqual(next_week['validTo'], '2026-11-01')
        self.assertEqual(next_week['value'], 600)
        self.assertEqual(next_week['components'][1]['relocatedStudents'], 595)
        for unsupported in ['2026-10-25', '2026-11-02', '2027-10-25']:
            with self.assertRaises(ScrapeError):
                parse_warren(article, faq, project, unsupported)
        self.assertEqual(record['value'], 600)
        self.assertEqual(record['coverage'], 'partial')
        self.assertEqual(record['components'][1]['capacity'], 0)
        self.assertIsNone(record['components'][2]['capacity'])
        with self.assertRaises(ScrapeError):
            parse_warren(article, source('Unverified relocation'), project)
