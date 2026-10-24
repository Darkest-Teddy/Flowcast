import csv
from datetime import date
from io import BytesIO, StringIO
from pathlib import Path
import sys
import unittest
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scrape_bluebikes import aggregate, archive_rows, choose_archive, local_timestamp, month_bounds
from common import ScrapeError

BOXES = [('main', [42.34, -71.13, 42.36, -71.09]), ('other', [42.32, -71.08, 42.34, -71.06])]


def trip(identity='1', start='2026-09-01 09:00:00', end='2026-09-01 09:05:00', **changes):
    row = {'ride_id': identity, 'started_at': start, 'ended_at': end,
           'start_station_id': 'A', 'end_station_id': 'B',
           'start_station_name': 'Origin', 'end_station_name': 'Destination',
           'start_lat': '42.35', 'start_lng': '-71.12', 'end_lat': '42.351', 'end_lng': '-71.11'}
    return {**row, **changes}


class BluebikesTests(unittest.TestCase):
    def test_only_complete_months_and_zip_preferred(self):
        listing = b'''<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>202609-bluebikes-tripdata.csv</Key></Contents><Contents><Key>202609-bluebikes-tripdata.zip</Key></Contents><Contents><Key>202610-bluebikes-tripdata.zip</Key></Contents></ListBucketResult>'''
        self.assertEqual(choose_archive(listing, date(2026, 10, 24)), '202609-bluebikes-tripdata.zip')
        self.assertIsNone(choose_archive(listing, date(2026, 9, 30)))
        with self.assertRaises(ScrapeError):
            choose_archive(listing.replace(b'false', b'true'), date(2026, 10, 24))

    def test_zero_days_remain_in_denominator_and_duration_is_averaged(self):
        result = aggregate([trip(), trip('2', '2026-09-08 09:10:00', '2026-09-08 09:20:00')], '202609', BOXES)
        self.assertEqual(result['flows'], [{'from': 'A', 'to': 'B', 'weekday': 1, 'hour': 9, 'trips': 2, 'days': 5, 'meanDurationSec': 450.0}])
        self.assertEqual(result['coverage']['retainedTrips'], 2)
        self.assertEqual(month_bounds('202602'), (date(2026, 2, 1), date(2026, 2, 28)))

    def test_duplicates_invalid_and_outside_scope_do_not_inflate_flows(self):
        rows = [trip(), trip(), trip('same', end_station_id='A'), trip('outside', end_lat='43'),
                trip('bad', start_lat='nan'), trip('missing', end_station_id=''),
                trip('short', end='2026-09-01 09:00:10'), trip('old', '2026-08-31 09:00:00', '2026-08-31 09:05:00')]
        result = aggregate(rows, '202609', BOXES)
        self.assertEqual(result['coverage']['retainedTrips'], 1)
        self.assertEqual(result['coverage']['duplicateTrips'], 1)
        self.assertEqual(result['coverage']['sameStationTrips'], 1)
        self.assertEqual(result['coverage']['outsideCampusTrips'], 1)
        self.assertEqual(result['coverage']['invalidRows'], 1)
        self.assertEqual(result['coverage']['missingStations'], 1)
        self.assertEqual(result['coverage']['outsideDurationRange'], 1)
        self.assertEqual(result['coverage']['outsidePeriod'], 1)

    def test_boston_timezone_and_intercampus_endpoints(self):
        result = aggregate([trip(start='2026-09-02T01:00:00+00:00', end='2026-09-02T01:10:00+00:00', end_lat='42.33', end_lng='-71.07')], '202609', BOXES)
        self.assertEqual(result['flows'][0]['weekday'], 1)
        self.assertEqual(result['flows'][0]['hour'], 21)
        self.assertEqual(result['coverage']['interCampusTrips'], 1)
        self.assertEqual(local_timestamp('2026-09-01 09:00:00.123').microsecond, 123000)

    def test_station_id_with_distant_coordinates_does_not_splice_locations(self):
        result = aggregate([trip(), trip('2'), trip('moved', start_lat='42.355', start_lng='-71.125')], '202609', BOXES)
        self.assertEqual(result['coverage']['stationPositionConflicts'], 1)
        self.assertEqual(result['coverage']['retainedTrips'], 2)
        self.assertEqual(result['stations'][0]['position'], [-71.12, 42.35])

    def test_schema_drift_fails_and_output_omits_individual_identifiers(self):
        with self.assertRaises(ScrapeError):
            aggregate([{'ride_id': 'x'}], '202609', BOXES)
        result = aggregate([trip('private-ride-identifier')], '202609', BOXES)
        self.assertNotIn('private-ride-identifier', str(result))
        self.assertNotIn('ride_id', str(result))

    def test_csv_and_zip_readers_agree(self):
        text = StringIO(newline='')
        writer = csv.DictWriter(text, fieldnames=list(trip()))
        writer.writeheader()
        writer.writerow(trip())
        body = text.getvalue().encode()
        output = BytesIO()
        with ZipFile(output, 'w') as archive:
            archive.writestr('202609.csv', body)
            archive.writestr('__MACOSX/._202609.csv', b'junk')
        self.assertEqual(list(archive_rows(body, 'data.csv')), list(archive_rows(output.getvalue(), 'data.zip')))


if __name__ == '__main__':
    unittest.main()
