import unittest
import json
from common import Source, ScrapeError
from scrape_opening_hours import parse_dining, fitrec_section, dated_label, parse_fenway_provider, format_windows
from bs4 import BeautifulSoup
from datetime import date


class OpeningHoursTests(unittest.TestCase):
    def source(self, html):
        return Source('https://www.bu.edu/dining/location/warren/', html.encode(), '2026-10-24T12:00:00+00:00')

    def test_dining_keeps_exact_dates_and_explicit_closures(self):
        source = self.source('''<div class="location-single-hours">
        <h4 class="location-single-hours-day">Saturday, October 24th</h4>
        <ol><li><span class="daygroup-times">7:00 AM - 11:00 AM</span></li><li><span class="daygroup-times">5:00 PM - 10:00 PM</span></li></ol>
        <h4 class="location-single-hours-day">Sunday, October 25th</h4><ol><li>Closed</li></ol></div>''')
        hours = parse_dining(source)
        self.assertEqual(hours[0]['date'], '2026-10-24')
        self.assertNotIn('weekday', hours[0])
        self.assertEqual(hours[0]['windows'], [[25200,39600],[61200,79200]])
        self.assertEqual(hours[1]['windows'], [])
        self.assertEqual(hours[1]['date'], '2026-10-25')

    def test_ambiguous_missing_and_unparsed_hours_fail_closed(self):
        self.assertEqual(parse_dining(self.source('<h1>External provider</h1>')), [])
        with self.assertRaises(ScrapeError):
            dated_label('Monday, October 24th', date(2026,10,24))
        with self.assertRaises(ScrapeError):
            parse_dining(self.source('<div class="location-single-hours"><h4 class="location-single-hours-day">Saturday, October 24th</h4><ol>By appointment</ol></div>'))
        self.assertEqual(dated_label('Friday, January 1st', date(2026,12,30)), '2027-01-01')

    def test_fitrec_preserves_season_and_holiday_override(self):
        html = '''<section><h1 class="effective-range-title">September 02, 2026 - December 10, 2026</h1>
        <li class="hoo-item"><span class="facility-event-label">Monday</span><time datetime="06:00">6 AM</time><time datetime="23:00">11 PM</time></li>
        <li class="calendar-item"><span class="facility-event-label">Thursday, November 26</span>Closed</li></section>'''
        rows = fitrec_section(self.source(html), BeautifulSoup(html,'html.parser'))
        self.assertEqual(rows[0]['weekday'], 0)
        self.assertEqual(rows[0]['validTo'], '2026-12-10')
        self.assertEqual(rows[0]['windows'], [[21600,82800]])
        self.assertEqual(rows[1]['date'], '2026-11-26')
        self.assertEqual(rows[1]['windows'], [])

    def test_fenway_uses_named_dining_hall_and_seasonal_closure(self):
        clock = lambda h, p: {'hour': str(h), 'minute': '00', 'period': p}
        regular = [{'days': [], 'hours': [{'allDay': False, 'startTime': clock(7, 'AM'), 'finishTime': clock(10, 'PM')}]}]
        location = {'slug': 'the-fenway-dining-hall', 'openingHours': {'standardHours': regular,
            'seasonalHours': [{'from': '2026-10-24T00:00:00Z', 'to': '2026-10-24T23:59:00Z',
                              'openingHours': [{'days': [], 'hours': [{'allDay': False, 'label': 'Closed'}]}]}]}}
        state = {'locations': [location, {'slug': 'campus-convenience', 'openingHours': {'standardHours': []}}]}
        source = self.source('<script>window.__PRELOADED_STATE__ = ' + json.dumps(state) + '</script>')
        rows = parse_fenway_provider(source)
        self.assertEqual(len(rows), 7)
        self.assertEqual(rows[0]['date'], '2026-10-19')
        self.assertEqual(rows[0]['windows'], [[25200, 79200]])
        self.assertEqual(rows[5]['windows'], [])
        self.assertEqual(format_windows([[41400, 68400]]), '11:30–19:00')
