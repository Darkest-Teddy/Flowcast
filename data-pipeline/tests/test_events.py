import json
import unittest

from common import ScrapeError, Source
from scrape_events import LISTING_URL, collect, parse_event, parse_listing


def source(html, url="https://terriercentral.bu.edu/web/rsvp_boot?id=375534"):
    return Source(url, html.encode(), "2026-10-24T12:00:00+00:00")


class EventTests(unittest.TestCase):
    def event(self, **changes):
        data = {"@type": "Event", "name": "Information Session", "startDate": "2026-09-08T18:30:00-04:00",
                "endDate": "2026-09-08T20:30:00-04:00", "location": {"name": "Questrom HAR 105"},
                "description": "No registration required."}
        data.update(changes)
        return source('<script type="application/ld+json">'+json.dumps(data)+'</script>'
                      '<div class="card"><h1 class="rsvp__event-name">Information Session</h1>'
                      '<p class="rsvp__event-org"><button>Alpha Kappa Psi</button></p>'
                      '<span class="number">12</span><div>Registered</div><p>358 spots left</p></div>')

    def test_counts_are_not_occupancy(self):
        row = parse_event(self.event())
        self.assertEqual(row["registrationCount"], 12)
        self.assertEqual(row["remainingRegistrationSpots"], 358)
        self.assertEqual(row["organizer"], "Alpha Kappa Psi")
        self.assertIsNone(row["roomCapacity"])
        self.assertIsNone(row["observedAttendance"])
        self.assertTrue(row["registrationOptional"])
        self.assertEqual(row["start"], "2026-09-08T18:30:00-04:00")

    def test_hidden_location_stays_unresolved(self):
        row = parse_event(self.event(location={"name": "Private Location (sign in to display)"}))
        self.assertIsNone(row["locationName"])
        self.assertEqual(row["locationStatus"], "hidden")

    def test_timezone_required(self):
        with self.assertRaises(ScrapeError):
            parse_event(self.event(startDate="2026-09-08T18:30:00"))

    def test_missing_start_is_error(self):
        with self.assertRaises(ScrapeError):
            parse_event(self.event(startDate=None))

    def test_missing_metadata_is_error(self):
        with self.assertRaises(ScrapeError):
            parse_event(source("<h1>Log in</h1>"))

    def test_listing_fields_not_fixed_column_offsets(self):
        payload = [{"fields": "eventName,eventId", "p0": "A", "p1": "123"},
                   {"fields": "date_text", "p0": "Tomorrow"}]
        self.assertEqual(parse_listing(source(json.dumps(payload))),
                         ["https://terriercentral.bu.edu/web/rsvp_boot?id=123"])


    def test_raw_newline_in_description_still_parses(self):
        html = ('<script type="application/ld+json">{"@type": "Event", "name": "Dogfight",'
                ' "startDate": "2026-11-19T20:00:00-05:00", "endDate": "2026-11-19T23:00:00-05:00",'
                ' "location": {"name": "Private Location (sign in to display)"},'
                ' "description": "Fall student theatre\nmusical about a \\&quot;dogfight,\\&quot; bet"}</script>')
        row = parse_event(source(html))
        self.assertEqual(row["name"], "Dogfight")
        self.assertEqual(row["locationStatus"], "hidden")

    def test_private_events_are_skipped_with_a_warning(self):
        public = self.event()
        class Fetcher:
            def get(self, url):
                if url == LISTING_URL:
                    return source('<a href="/web/rsvp_boot?id=375534">A</a><a href="/web/rsvp_boot?id=999">B</a>', url)
                if url.endswith("id=999"):
                    return source("<h1>Sign in</h1>", "https://terriercentral.bu.edu/otp_signup?module=event&event_id=999&private_event=1")
                return public
        result = collect(Fetcher())
        self.assertEqual([row["eventId"] for row in result["events"]], ["375534"])
        self.assertEqual(result["errors"], [])
        self.assertTrue(any("1 listed events are private" in warning for warning in result["warnings"]))

    def test_second_listing_failure_retains_discovered_events(self):
        detail = self.event()
        class Fetcher:
            def get(self, url):
                if url == LISTING_URL:
                    return source("/mobile_ws/v17/mobile_events_list", url)
                if "range=0&" in url:
                    return source(json.dumps([{"fields": "eventId", "p0": "375534"}]), url)
                if "range=40&" in url:
                    raise ScrapeError("temporary DNS failure")
                if url == detail.url:
                    return detail
                raise AssertionError(url)
        result = collect(Fetcher(), max_events=20)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["eventId"], "375534")
        self.assertEqual(len(result["sources"]), 3)
        self.assertEqual(result["errors"], ["Event listing page 2: temporary DNS failure"])


if __name__ == "__main__":
    unittest.main()
