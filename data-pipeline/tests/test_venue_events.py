import json
from datetime import date, datetime
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scrape_venue_events import (  # noqa: E402
    TZ, agganis_events, collect_campus, livenation_events, local_iso, merge_events, mlb_events,
    mlb_home_games, nuxt_payload, opponent_parts, parse_agganis_calendar, parse_clock, parse_livenation,
    parse_mlb_boxscore, parse_sidearm_boxscore, parse_sidearm_schedule, parse_sidearm_text, sidearm_events,
)


def devalue(value):
    """Minimal Nuxt devalue encoder (each value gets a slot; containers hold slot indices)."""
    table = []

    def put(v):
        index = len(table)
        table.append(None)
        if isinstance(v, dict):
            table[index] = {k: put(x) for k, x in v.items()}
        elif isinstance(v, list):
            table[index] = [put(x) for x in v]
        else:
            table[index] = v
        return index

    root = put({"pinia": None})
    table[root] = {"pinia": len(table)}
    table.append(["Reactive", len(table) + 1])
    put(value)
    return table


def nuxt_html(value):
    return ('<html><script type="application/json" id="__NUXT_DATA__" data-ssr="true">'
            + json.dumps(devalue(value)) + '</script></html>')


def game(**changes):
    g = {"id": 33108, "date": "2026-10-24T19:00:00", "time": "7 PM", "tbd": False, "location_indicator": "H",
         "type": "R", "location": "Boston, MA", "promotion": "Dog Bone Big Chain Giveaway", "noplay_text": "",
         "opponent": {"title": "#16 UConn", "prefix": "#16"}, "facility": {"title": "Agganis Arena"},
         "result": None, "ticket_link": {"url": "https://am.ticketmaster.com/agganis/buy"}, "event_name": None}
    g.update(changes)
    return g


class HelperTests(unittest.TestCase):
    def test_boston_offsets_follow_dst(self):
        self.assertEqual(local_iso(date(2026, 10, 31), parse_clock("6 PM")), "2026-10-31T18:00:00-04:00")
        self.assertEqual(local_iso(date(2026, 11, 7), parse_clock("7:15 p.m.")), "2026-11-07T19:15:00-05:00")
        self.assertIsNone(parse_clock("TBA"))
        self.assertEqual(parse_clock("12:00 AM").hour, 0)

    def test_opponent_parts(self):
        self.assertEqual(opponent_parts("#3/4 Michigan State"), ("Michigan State", 3, None))
        self.assertEqual(opponent_parts("(11) Vermont - Hockey East Opening Round"),
                         ("Vermont", None, "Hockey East Opening Round"))
        self.assertEqual(opponent_parts("RPI (exh.)"), ("RPI", None, "exhibition"))
        self.assertEqual(opponent_parts(" New Hampshire"), ("New Hampshire", None, None))
        self.assertEqual(opponent_parts("(4) #5 Northeastern - Hockey East Quarterfinal"),
                         ("Northeastern", 5, "Hockey East Quarterfinal"))
        self.assertEqual(opponent_parts("American — PL First Round"), ("American", None, "PL First Round"))


class SidearmTests(unittest.TestCase):
    def schedule(self, games):
        return nuxt_html({"schedule": {"schedules": {"schedules-mens-ice-hockey,2026-27": {"games": games}}}})

    def test_home_games_at_bu_facilities_only(self):
        games = parse_sidearm_schedule(self.schedule([
            game(),
            game(id=1, date="2026-10-22T19:00:00", location_indicator="A", facility=None),
            game(id=2, date="2027-02-01T00:00:00", time="TBA", tbd=True, location_indicator="N", facility=None,
                 opponent={"title": "Boston College"}),
            game(id=3, date="2027-01-03T16:00:00", time="4 PM", type="S", facility={"title": "Walter Brown Arena"},
                 opponent={"title": "McGill"}),
            game(id=4, date="2026-10-10T19:00:00", type="S", opponent={"title": "Brown"},
                 result={"status": "W", "boxscore": {"url": "/sports/mens-ice-hockey/stats/2026-27/brown/boxscore/33104"}}),
        ]))
        events = sidearm_events(games, "mens-ice-hockey", "https://goterriers.com/x", "2026-10-24T20:00:00+00:00")
        self.assertEqual([e["venueId"] for e in events], ["agganis", "walter-brown", "agganis"])
        uconn, mcgill, brown = events
        self.assertEqual(uconn["start"], "2026-10-24T19:00:00-04:00")
        self.assertEqual(uconn["name"], "BU Men's Ice Hockey vs. UConn")
        self.assertEqual((uconn["opponent"], uconn["opponentRank"]), ("UConn", 16))
        self.assertEqual(uconn["trendsTerms"], ["BU hockey", "UConn hockey"])
        self.assertEqual((uconn["kind"], uconn["setup"], uconn["status"]), ("bu-hockey", "hockey", "scheduled"))
        self.assertEqual(mcgill["start"], "2027-01-03T16:00:00-05:00")
        self.assertEqual(mcgill["gameNote"], "exhibition")
        self.assertEqual(brown["status"], "final")
        self.assertTrue(brown["boxscoreUrl"].startswith("https://goterriers.com/sports/"))

    def test_boxscore_attendance_and_times(self):
        payload = nuxt_html({"boxscore": {"boxscore": {"1": {"venue": {
            "date": "10/10/2026", "start": "07:00 PM", "end": "09:37 PM", "duration": "0",
            "attendance": "4951", "homeName": "Boston U."}}}}})
        info = parse_sidearm_boxscore(payload)
        self.assertEqual(info["attendance"], 4951)
        self.assertEqual(info["end"], "09:37 PM")
        html = ('<div><span class="s-text-paragraph-bold">Attendance: </span>'
                '<span class="s-text-paragraph">3,806</span></div>')
        self.assertEqual(parse_sidearm_boxscore(html)["attendance"], 3806)
        self.assertIsNone(parse_sidearm_boxscore("<p>no stats</p>")["attendance"])

    def test_boxscore_end_uses_duration_and_rejects_implausible_clock(self):
        from scrape_venue_events import apply_boxscore
        event = {"start": "2026-09-08T18:00:00-04:00", "end": None, "attendance": None}
        apply_boxscore(event, {"attendance": 457, "start": "06:00", "end": "08:08", "duration": "02:08"}, "u")
        self.assertEqual((event["end"], event["attendance"]), ("2026-09-08T20:08:00-04:00", 457))
        event = {"start": "2026-09-13T13:00:00-04:00", "end": None, "attendance": None}
        apply_boxscore(event, {"attendance": 219, "start": "1:00 PM", "end": "02:51 AM", "duration": ""}, "u")
        self.assertIsNone(event["end"])

    def test_text_view_fallback(self):
        html = """<table><tr><th>Date</th></tr>
        <tr><td>Oct 30 (Fri)</td><td>7 PM</td><td><span>Home</span></td><td>Maine</td>
            <td>Boston, MA (Agganis Arena)</td><td></td><td>-</td></tr>
        <tr><td>Jan 9 (Sat)</td><td>7 PM</td><td><span>Away</span></td><td>UMass</td>
            <td>Amherst, MA</td><td></td><td>-</td></tr></table>"""
        games = parse_sidearm_text(html, "2026-27")
        self.assertEqual([(g["date"], g["indicator"], g["facility"]) for g in games],
                         [(date(2026, 10, 30), "H", "Agganis Arena"), (date(2027, 1, 9), "A", None)])
        events = sidearm_events(games, "mens-ice-hockey", "u", "t")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["start"], "2026-10-30T19:00:00-04:00")


AGGANIS_HTML = """<ul id="events">
<li><div class="event-list-text"><div class="event-date-time"><span class="event-date">Friday, November 6</span>
 <span class="event-time"> | 8:00 PM</span></div><a href="?eid=322389"><h3 class="event-title">Platinum Entertainment
 Groups &amp; The Touring Co. Present: A Boogie Wit da Hoodie</h3></a><p class="event-sponsor">Platinum</p>
 <div class="buttons"><a class="buy-tickets button" href="https://www.ticketmaster.com/a-boogie-11-06-2026/event/1">Buy Tickets</a></div></div></li>
<li><div class="event-list-text"><div class="event-date-time"><span class="event-date">Sunday, January 3</span>
 <span class="event-time"> | 4:00 PM</span></div><a href="?eid=322374"><h3 class="event-title">BU Men&#039;s Hockey vs. McGill EXH. at Walter Brown</h3></a>
 <p class="event-sponsor">BU Men's Hockey</p><div class="buttons"><a class="buy-tickets button" href="https://am.ticketmaster.com/agganis">Buy Tickets</a></div></div></li>
<li><div class="event-list-text"><div class="event-date-time"><span class="event-date">Saturday, April 17</span>
 <span class="event-time"> | 12:00 AM</span></div><a href="?eid=322700"><h3 class="event-title">Boston Fleet vs. Toronto Sceptres GAME TIME TBA</h3></a>
 <p class="event-sponsor">PWHL</p><div class="buttons"><span>Sold Out</span></div></div></li>
<li><div class="event-list-text"><div class="event-date-time"><span class="event-date">Saturday, December 26</span>
 <span class="event-time"> | 12:00 PM</span></div><a href="?eid=1"><h3 class="event-title">Disney on Ice Presents Find Your Hero</h3></a>
 <p class="event-sponsor">Feld Entertainment</p></div></li>
</ul>"""


class AgganisTests(unittest.TestCase):
    def test_calendar_rows_years_and_kinds(self):
        rows = parse_agganis_calendar(AGGANIS_HTML, date(2026, 10, 24))
        self.assertEqual([r["date"] for r in rows],
                         [date(2026, 11, 6), date(2027, 1, 3), date(2027, 4, 17), date(2027, 12, 26)])
        events = agganis_events(rows, "2026-10-24T20:00:00+00:00")
        concert, hockey, fleet, disney = events
        self.assertEqual((concert["kind"], concert["performers"], concert["trendsTerms"]),
                         ("concert", ["A Boogie Wit da Hoodie"], ["A Boogie Wit da Hoodie"]))
        self.assertEqual(concert["start"], "2026-11-06T20:00:00-05:00")
        self.assertEqual(concert["name"], "A Boogie Wit da Hoodie")
        self.assertIn("Present:", concert["listedTitle"])
        self.assertEqual(concert["id"], "agganisarena:322389")
        self.assertEqual((hockey["kind"], hockey["venueId"], hockey["opponent"]), ("bu-hockey", "walter-brown", "McGill"))
        self.assertEqual((fleet["kind"], fleet["timeTbd"], fleet["soldOut"], fleet["name"]),
                         ("pwhl", True, True, "Boston Fleet vs. Toronto Sceptres"))
        self.assertEqual(fleet["trendsTerms"], ["Boston Fleet"])
        self.assertEqual((disney["kind"], disney["trendsTerms"]), ("family", ["Disney on Ice"]))


LN_EVENT = {"event_data_type": "discovery", "discovery_id": "vvG17Z_1MZT4EK", "name": "Remi Wolf: The Mud Tour",
            "slug": "remi-wolf-the-mud-tour", "url": "https://www.ticketmaster.com/x/event/1", "type": "REGULAR",
            "start_date_local": "2027-03-02", "start_time_local": "20:00:00",
            "datetime_local": "2027-03-02T20:00:00-05:00", "status_code": "onsale", "genre": "Pop",
            "segment": "Music", "artists": [{"name": "Remi Wolf"}, {"name": "Emma Ogier"}]}


class LiveNationTests(unittest.TestCase):
    def test_flight_payload(self):
        comedy = dict(LN_EVENT, discovery_id="c1", name="Nikki Glaser: The Stunning Tour", genre="Comedy",
                      segment="Arts & Theatre", artists=[{"name": "Nikki Glaser"}],
                      datetime_local="2026-12-02T20:00:00-05:00")
        flight = "1d:" + json.dumps({"events": [LN_EVENT, comedy]})
        html = "<script>self.__next_f.push(" + json.dumps([1, flight]) + ")</script>"
        events = livenation_events(parse_livenation(html), "t")
        self.assertEqual([e["kind"] for e in events], ["concert", "comedy"])
        self.assertEqual(events[0]["performers"], ["Remi Wolf", "Emma Ogier"])
        self.assertEqual(events[0]["trendsTerms"], ["Remi Wolf"])
        self.assertEqual(events[0]["id"], "livenation:vvG17Z_1MZT4EK")
        self.assertEqual(events[0]["venueId"], "mgm-music-hall")

    def test_json_ld_fallback(self):
        ld = {"@type": "MusicEvent", "name": "Boyz II Men", "startDate": "2027-02-05T20:00:00-05:00",
              "eventStatus": "https://schema.org/EventScheduled", "performers": [{"name": "Boyz II Men"}],
              "url": "https://www.livenation.com/event/vvABC/boyz-ii-men"}
        html = '<script type="application/ld+json">' + json.dumps(ld) + "</script>"
        (event,) = livenation_events(parse_livenation(html), "t")
        self.assertEqual((event["id"], event["start"], event["trendsTerms"]),
                         ("livenation:vvABC", "2027-02-05T20:00:00-05:00", ["Boyz II Men"]))


class MlbTests(unittest.TestCase):
    def test_home_games_at_fenway_with_tbd(self):
        def g(pk, venue, home, when, tbd=False, state="Final"):
            return {"gamePk": pk, "gameDate": when, "officialDate": when[:10], "venue": {"id": venue},
                    "teams": {"home": {"team": {"id": home}}, "away": {"team": {"name": "Chicago Cubs"}}},
                    "status": {"detailedState": state, "abstractGameState": state, "startTimeTBD": tbd},
                    "dayNight": "night", "gameType": "R", "doubleHeader": "N", "gameNumber": 1}
        payload = {"dates": [{"games": [g(1, 3, 111, "2026-09-25T21:35:00Z"), g(2, 12, 111, "2026-09-27T19:05:00Z"),
                                        g(3, 3, 147, "2026-09-28T19:05:00Z"),
                                        g(4, 3, 111, "2027-04-01T07:33:00Z", True, "Scheduled")]}]}
        events = mlb_events(mlb_home_games(payload), "u", "t")
        self.assertEqual([e["id"] for e in events], ["mlb:1", "mlb:4"])
        self.assertEqual(events[0]["start"], "2026-09-25T17:35:00-04:00")
        self.assertEqual((events[1]["start"], events[1]["timeTbd"]), ("2027-04-01T00:00:00-04:00", True))
        self.assertEqual(events[0]["trendsTerms"], ["Red Sox"])

    def test_boxscore_attendance(self):
        info = parse_mlb_boxscore({"info": [{"label": "First pitch", "value": "6:46 PM."},
                                            {"label": "T", "value": "3:23."}, {"label": "Att", "value": "35,758."}]})
        self.assertEqual(info["attendance"], 35758)
        self.assertEqual(info["duration"].seconds, 3 * 3600 + 23 * 60)


class MergeTests(unittest.TestCase):
    def test_goterriers_wins_for_sports_and_records_time_discrepancy(self):
        base = {"venueId": "agganis", "kind": "bu-hockey", "performers": [], "timeTbd": False, "soldOut": None,
                "priceFrom": None, "doors": None, "attendance": None, "attendanceSource": None, "end": None}
        go = dict(base, id="goterriers:mens-ice-hockey:2026-11-27", source="goterriers", sourceUrl="g",
                  start="2026-11-27T18:00:00-05:00", name="BU Men's Ice Hockey vs. Denver")
        ag = dict(base, id="agganisarena:320917", source="agganisarena", sourceUrl="a",
                  start="2026-11-27T15:00:00-05:00", name="BU Men's Hockey vs. Denver", ticketUrl="tm")
        notes = []
        (merged,) = merge_events([ag, go], notes)
        self.assertEqual(merged["source"], "goterriers")
        self.assertEqual(merged["alsoListedBy"][0]["id"], "agganisarena:320917")
        self.assertEqual(merged["ticketUrl"], "tm")
        self.assertEqual(len(notes), 1)

    def test_campus_events(self):
        data = {"collectedAt": "2026-10-24T20:00:00+00:00", "events": [
            {"id": "terriercentral:1", "name": "Ride the Cyclone", "start": "2026-12-03T20:00:00-05:00",
             "end": "2026-12-03T22:30:00-05:00", "locationId": "agganis", "organizer": "Stage Troupe"},
            {"id": "terriercentral:2", "name": "Elsewhere", "start": "2026-12-03T20:00:00-05:00", "locationId": "cas"}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "campus-data.json"
            path.write_text(json.dumps(data))
            report = {"sources": []}
            (event,) = collect_campus(path, (date(2026, 9, 1), date(2027, 4, 30)), report)
        self.assertEqual((event["kind"], event["campusEventId"], event["source"]),
                         ("campus", "terriercentral:1", "campus-data"))
        self.assertTrue(report["sources"][0]["ok"])


class NuxtTests(unittest.TestCase):
    def test_decodes_wrappers_and_shared_references(self):
        table = [{"a": 1, "b": 3}, ["ShallowReactive", 2], {"x": 4}, [4, 4], "same"]
        html = '<script id="__NUXT_DATA__" type="application/json">' + json.dumps(table) + "</script>"
        self.assertEqual(nuxt_payload(html), {"a": {"x": "same"}, "b": ["same", "same"]})


if __name__ == "__main__":
    unittest.main()
