import unittest

from common import ScrapeError, Source
from scrape_dining import MARCIANO, VOLUMES, WARREN, parse_dining_hours, parse_dining_metrics, publication_date


def source(html, url=WARREN):
    return Source(url, html.encode(), "2026-10-24T12:00:00+00:00")


class DiningTests(unittest.TestCase):
    def test_overnight_window_and_missing_hours(self):
        result = parse_dining_hours(source('''<li class="dining-opennow-item"><a href="/dining/location/west/"><h3>West</h3></a><div class="dining-opennow-schedule" data-open="22:30" data-close="01:00"><strong>After Hours:</strong>10:30 PM - 1 AM</div><div class="dining-opennow-schedule" data-open="" data-close="">Unavailable</div></li>'''))
        self.assertTrue(result[0]["windows"][0]["crossesMidnight"])
        self.assertEqual(result[0]["windows"][0]["opensLocal"], "22:30")
        self.assertIsNone(result[0]["scheduleDate"])
        self.assertEqual(result[0]["windows"][1]["status"], "unavailable")
        self.assertIsNone(result[0]["locationId"])

    def test_changed_page_rejected(self):
        with self.assertRaises(ScrapeError):
            parse_dining_hours(source("<html>Loading...</html>"))

    def test_capacity_and_throughput_are_distinct(self):
        records = parse_dining_metrics(source('<main><p>Marciano Commons: this dining hall seats 920 (and serves around 5,000 meals every day).</p></main>', MARCIANO))
        self.assertEqual({r["metric"]: (r["value"], r["unit"]) for r in records}, {"capacity": (920, "seats"), "throughput": (5000, "meals/day")})
        self.assertEqual(records[0]["sourcePublishedDate"], "2012-07-26")

    def test_modified_date_not_published_date(self):
        s = source('<meta property="article:modified_time" content="2026-10-24"><div class="wp-prepress-component-metabar-date">September 15, 2026</div>')
        self.assertEqual(publication_date(s), "2026-09-15")

    def test_published_daily_meals_not_capacity(self):
        rows = parse_dining_metrics(source('<main><p>The dining hall serves about 3,850 meals a day.</p><p>It has 75 staff.</p></main>'))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["metric"], "throughput")
        self.assertEqual(rows[0]["value"], 3850)

    def test_meal_period_total_not_summed_with_halls(self):
        rows = parse_dining_metrics(source('<main><p>It takes 3,000 breakfasts, 5,000 lunches, and 5,000 dinners that BU manages in its three main dining halls each day. Add 40,000 customers served in the George Sherman Union Food Court every week.</p></main>', VOLUMES))
        self.assertEqual(len(rows), 4)
        self.assertEqual(len({row["id"] for row in rows}), 4)
        self.assertTrue(rows[0]["aggregate"])
        self.assertEqual(rows[-1]["unit"], "customer-visits/week")


if __name__ == "__main__":
    unittest.main()
