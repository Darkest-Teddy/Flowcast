import unittest

from make_signs import bearing_of, street_wall


class StreetWallTests(unittest.TestCase):
    # A 20 x 10 m block (counter-clockwise and clockwise), a street 15 m south of it.
    RING = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)]
    STREET = [[(-50.0, -15.0), (70.0, -15.0)]]

    def test_sign_goes_on_the_wall_facing_the_street_whichever_way_the_ring_winds(self):
        for ring in (self.RING, self.RING[::-1]):
            a, b, n, t = street_wall(ring, (6.0, 4.0), self.STREET, 4.0)
            self.assertAlmostEqual(a[1], 0.0)
            self.assertAlmostEqual(b[1], 0.0)
            self.assertAlmostEqual(n[1], -1.0)
            self.assertEqual(bearing_of(n), 180.0)
            # Centred on the place along the wall.
            self.assertAlmostEqual(a[0] + (b[0] - a[0]) * t, 6.0)

    def test_a_wall_too_short_for_the_sign_loses_to_one_that_fits(self):
        # The street runs past both the south and the east side; the place is nearest the short
        # east wall (10 m), but a 12 m sign only fits the 20 m south wall.
        streets = [[(-50.0, -15.0), (70.0, -15.0)], [(35.0, -50.0), (35.0, 60.0)]]
        _, _, n, _ = street_wall(self.RING, (18.0, 5.0), streets, 12.0)
        self.assertEqual(bearing_of(n), 180.0)
        _, _, n, _ = street_wall(self.RING, (18.0, 5.0), streets, 4.0)
        self.assertEqual(bearing_of(n), 90.0)

    def test_no_wall_facing_a_street_is_an_error(self):
        with self.assertRaises(ValueError):
            street_wall(self.RING, (5.0, 5.0), [[(-50.0, 500.0), (70.0, 500.0)]], 4.0)


if __name__ == "__main__":
    unittest.main()
