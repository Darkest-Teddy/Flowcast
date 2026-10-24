import unittest
from unittest.mock import patch

from common import ScrapeError, Source
from scrape_housing import BEACON_PDF, STUVI1, STUVI2, WARREN, WEST, parse_article_baselines, parse_beacon_pdf, parse_housing_page


def source(html, url=STUVI1):
    return Source(url, html.encode(), "2026-10-24T12:00:00+00:00")


class HousingTests(unittest.TestCase):
    def test_apartment_inventory_is_derived_capacity(self):
        _, rows, _ = parse_housing_page(source('<main><h1>10 Buick Street</h1><p>StuVi-1 has 185 four-person apartments. There are also 31 two-person apartments.</p><p>Built in 1999.</p></main>'))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["value"], 802)
        self.assertEqual(rows[0]["basis"], "inventory_derived")
        self.assertFalse(rows[0]["currentOccupancy"])

    def test_only_residential_numbers_become_baselines(self):
        _, rows, _ = parse_housing_page(source('<main><h1>33 Harry Agganis Way</h1><p>StuVi-2 accommodates 960 residents in two high-rises. The 26-story north tower hosts juniors.</p></main>', STUVI2))
        self.assertEqual([r["value"] for r in rows], [960])

    def test_warren_subset_not_added_to_complex_total(self):
        rows = parse_article_baselines(source('<main><p>The complex, which houses 1,800 students per year, comprises three towers.</p><p>The newly renovated Tower A houses 600 students in single rooms.</p></main>', WARREN))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["partOf"], rows[0]["entityKey"])
        self.assertIn(rows[1]["entityKey"], rows[0]["includes"])

    def test_west_group_does_not_invent_per_building_split(self):
        rows = parse_article_baselines(source('<main><p>The three 13-story residential towers are home to approximately 1,800 students.</p></main>', WEST))
        self.assertEqual(rows[0]["value"], 1800)
        self.assertIsNone(rows[0]["perBuildingSplit"])
        self.assertEqual(len(rows[0]["includes"]), 3)

    def test_external_housing_links_not_followed(self):
        _, _, links = parse_housing_page(source('<main><a href="https://evil.example/housing/residence/fake/">Bad</a><a href="/housing/residence/warren-towers/">Warren</a></main>'))
        self.assertEqual(links, ['https://www.bu.edu/housing/residence/warren-towers/'])

    @patch('scrape_housing.PdfReader')
    def test_planning_pdf_uses_post_renovation_number(self, reader):
        reader.return_value.pages[33].extract_text.return_value = 'Myles Standish housed 760 students before renovation. The renovation maintained the structure to provide space for 730 students.'
        row = parse_beacon_pdf(source('', BEACON_PDF))
        self.assertEqual(row["value"], 730)
        self.assertEqual(row["pdfPage"], 34)
        self.assertEqual(row["sourcePublishedDate"], '2024-02')

    @patch('scrape_housing.PdfReader')
    def test_wrong_pdf_page_fails(self, reader):
        reader.return_value.pages[33].extract_text.return_value = 'Unrelated project with 730 students.'
        with self.assertRaises(ScrapeError):
            parse_beacon_pdf(source('', BEACON_PDF))


if __name__ == "__main__":
    unittest.main()
