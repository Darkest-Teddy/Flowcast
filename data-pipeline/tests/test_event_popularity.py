from datetime import date
import math
import unittest

import event_popularity as ep


class FakeTrends:
    """Answers each request from fixed true search volumes, the way Trends does: every series is
    scaled so the request's single busiest value is 100, then rounded to whole points."""

    def __init__(self, volumes):
        self.volumes = volumes  # term -> list of true daily volumes
        self.requests = []
        self.live_requests = 0
        self.blocked = False

    def interest(self, terms, start, end):
        self.requests.append(list(terms))
        top = max(max(self.volumes[t]) for t in terms)
        series = {t: [round(100 * v / top) for v in self.volumes[t]] for t in terms}
        return {"terms": terms, "series": series, "dates": [start.isoformat(), end.isoformat()], "url": "u", "queriedAt": "q"}, "k", True


class NormaliseTests(unittest.TestCase):
    def test_scores_rescale_to_the_anchor(self):
        norm = ep.normalise({"TD Garden": [50, 50, 50, 50], "Tyla": [0, 2, 2, 0]}, "TD Garden")
        self.assertEqual(norm["TD Garden"]["score"], 100.0)
        self.assertAlmostEqual(norm["Tyla"]["score"], 2.0)
        self.assertEqual(norm["Tyla"]["peak"], 2)
        self.assertAlmostEqual(norm["Tyla"]["peakScore"], 4.0)

    def test_scores_compare_across_requests_through_the_anchor(self):
        # The same term in two requests with different peaks (so different 0-100 scales) scores
        # the same once each is divided by the shared anchor.
        a = ep.normalise({"TD Garden": [40, 40], "BU hockey": [4, 4]}, "TD Garden")
        b = ep.normalise({"TD Garden": [80, 80], "BU hockey": [8, 8], "Big act": [100, 100]}, "TD Garden")
        self.assertAlmostEqual(a["BU hockey"]["score"], b["BU hockey"]["score"])

    def test_anchor_without_data_gives_no_score(self):
        self.assertIsNone(ep.normalise({"A": [0, 0], "B": [3, 1]}, "A")["B"]["score"])

    def test_event_score_is_top_term_plus_half_the_rest(self):
        self.assertEqual(ep.event_score([3.0, 1.0, None]), 3.5)
        self.assertIsNone(ep.event_score([None]))

    def test_games_score_by_opponent_and_ambiguous_names_are_qualified(self):
        game = {"opponent": "Boston College", "trendsTerms": ["BU hockey", "Boston College hockey"]}
        records = [{"term": "BU hockey", "score": 12.0}, {"term": "Boston College hockey", "score": 6.7}]
        self.assertEqual(ep.scored_event(game, ep.event_terms(game), records), (6.7, "Boston College hockey"))
        unknown = [{"term": "BU hockey", "score": 12.0}, {"term": "Boston College hockey", "score": 0.0}]
        self.assertEqual(ep.scored_event(game, ep.event_terms(game), unknown)[0], ep.SCORE_FLOOR)
        self.assertEqual(ep.event_terms({"trendsTerms": ["FLO"]}), ["FLO girl group"])

    def test_window_is_ninety_days_before_the_event_or_today(self):
        today = date(2026, 10, 24)
        self.assertEqual(ep.window_for(date(2026, 11, 7), today), (date(2026, 7, 26), today))
        # A past event: to the Saturday before it, so the week's events share a request.
        self.assertEqual(ep.window_for(date(2026, 10, 10), today), (date(2026, 7, 5), date(2026, 10, 3)))
        self.assertEqual(ep.window_for(date(2026, 10, 9), today), (date(2026, 7, 5), date(2026, 10, 3)))
        self.assertEqual(ep.window_for(date(2026, 10, 4), today), (date(2026, 7, 5), date(2026, 10, 3)))


class LadderTests(unittest.TestCase):
    def setUp(self):
        days = 30
        self.volumes = {
            "Agganis Arena": [40] * days, "TD Garden": [1000] * days, "Red Sox": [20000] * days,
            "Tyla": [20] * days, "BU hockey": [35] * days, "Superstar": [3000] * days,
        }

    def test_small_terms_use_the_small_anchor_and_land_on_the_td_garden_scale(self):
        trends = FakeTrends(self.volumes)
        out = ep.score_terms(trends, ["Tyla", "BU hockey"], date(2026, 7, 26), date(2026, 10, 24), log=lambda *_: None)
        # True ratios: Tyla 20/1000 = 2.0, BU hockey 3.5 (TD Garden = 100).
        self.assertAlmostEqual(out["Tyla"]["score"], 2.0, delta=0.05)
        self.assertAlmostEqual(out["BU hockey"]["score"], 3.5, delta=0.05)
        self.assertEqual(out["Tyla"]["via"], "Agganis Arena")

    def test_a_big_term_moves_up_the_ladder(self):
        trends = FakeTrends(self.volumes)
        out = ep.score_terms(trends, ["Superstar"], date(2026, 7, 26), date(2026, 10, 24), log=lambda *_: None)
        self.assertEqual(out["Superstar"]["via"], "TD Garden")
        # TD Garden rounds to 33 of Superstar's 100: within Trends' whole-point rounding.
        self.assertAlmostEqual(out["Superstar"]["score"], 300.0, delta=5)

    def test_rate_limit_leaves_terms_unscored(self):
        class Blocked:
            live_requests = 0
            blocked = True

            def interest(self, *args):
                raise ep.RateLimited("429")

        self.assertEqual(ep.score_terms(Blocked(), ["Tyla"], date(2026, 7, 26), date(2026, 10, 24), log=lambda *_: None), {})


class CalibrationTests(unittest.TestCase):
    def test_fit_recovers_base_and_elasticity(self):
        base, e, ref = 0.8, 0.3, 4.0
        points = [(s, base * (s / ref) ** e) for s in (1, 2, 3, 5, 8)]
        fit = ep.fit_calibration(points, ref)
        self.assertAlmostEqual(fit["base"], base, places=3)
        self.assertAlmostEqual(fit["elasticity"], e, places=3)
        self.assertLess(fit["residualSd"], 1e-6)

    def test_sellouts_and_too_few_points_are_left_out(self):
        self.assertIsNone(ep.fit_calibration([(1, 1.0), (2, 0.99), (3, 0.5)], 2))

    def test_elasticity_is_bounded(self):
        points = [(s, min(0.97, 0.05 * s ** 2)) for s in (1, 1.5, 2, 3)]
        fit = ep.fit_calibration(points, 2)
        self.assertLessEqual(fit["elasticity"], ep.ELASTICITY_BOUNDS[1])
        self.assertTrue(math.isfinite(fit["base"]))


class BuildTests(unittest.TestCase):
    def test_events_without_scores_fall_back_to_priors(self):
        calendar = {"venues": [{"id": "agganis", "capacities": {"hockey": 6150}, "defaultSetup": "hockey"}], "events": [
            {"id": "a", "venueId": "agganis", "kind": "bu-hockey", "setup": "hockey", "start": "2026-11-07T19:00:00-05:00", "trendsTerms": ["BU hockey"]},
            {"id": "b", "venueId": "agganis", "kind": "campus", "setup": None, "start": "2026-11-12T19:00:00-05:00", "trendsTerms": []},
        ]}

        class Blocked:
            live_requests = 0
            blocked = True

            def interest(self, *args):
                raise ep.RateLimited("429")

        out = ep.build(calendar, Blocked(), date(2026, 10, 24), log=lambda *_: None)
        self.assertEqual(out["events"]["a"]["source"], "prior")
        self.assertEqual(out["events"]["b"]["reason"], "no search terms")
        self.assertEqual(out["counts"], {"trends": 0, "prior": 2})


if __name__ == "__main__":
    unittest.main()
