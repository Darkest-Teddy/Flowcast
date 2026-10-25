import io
import unittest
import zipfile
from scrape_transit_schedule import active_days, seconds, parse_gtfs, trim_to_geometry
from common import ScrapeError

class TransitScheduleTests(unittest.TestCase):
    def test_gtfs_after_midnight_is_not_wrapped(self):
        self.assertEqual(seconds('25:12:03'), 90723)
        for invalid in ['-1:00:00', '12:60:00', '12:00', '12:00:61']:
            with self.assertRaises((ScrapeError, ValueError)):
                seconds(invalid)

    def test_calendar_dates_override_weekly_service_including_prior_day(self):
        calendar = dict(service_id='s',start_date='20261001',end_date='20261031',
                        monday='1',tuesday='1',wednesday='1',thursday='1',friday='1',saturday='0',sunday='0')
        exceptions = [dict(service_id='s',date='20261019',exception_type='2'),
                      dict(service_id='s',date='20261018',exception_type='1'),
                      dict(service_id='s',date='20261024',exception_type='1')]
        self.assertEqual(active_days([calendar], exceptions, '2026-10-19')['s'], {-1,1,2,3,4,5})

    def fixture(self, feed_end='20261212'):
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:
            z.writestr('feed_info.txt',f'feed_start_date,feed_end_date,feed_version\n20261014,{feed_end},test\n')
            z.writestr('calendar.txt','service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,0,0,20261014,20261212\n')
            z.writestr('calendar_dates.txt','service_id,date,exception_type\ns,20261020,2\n')
            z.writestr('trips.txt','route_id,trip_id,service_id,direction_id\n57,t,s,0\n57,bad,s,0\nother,ignored,s,0\n')
            z.writestr('stop_times.txt','trip_id,stop_id,arrival_time,departure_time,stop_sequence\nt,a,25:00:00,25:01:00,1\nt,b,25:05:00,25:05:00,2\nbad,a,09:00:00,09:00:00,1\nbad,b,08:50:00,08:50:00,2\n')
            z.writestr('stops.txt','stop_id,stop_lon,stop_lat,parent_station\na,-71.1,42.35,\nb,-71.09,42.35,parent\n')
        return buf.getvalue()

    def test_extracts_published_times_and_rejects_nonmonotonic_trip(self):
        transit={'routes':[{'id':'57','kind':'bus'}], 'stops':[{'id':'parent','platforms':['b']}]}
        result=parse_gtfs(self.fixture(),transit, '2026-10-19')
        self.assertEqual(len(result['trips']),1)
        self.assertEqual(result['trips'][0]['stops'][0]['arrival'],90000)
        self.assertEqual(result['trips'][0]['weekdays'],[0,2,3,4])
        self.assertEqual(result['stops']['b']['mapStopId'],'parent')
        self.assertEqual(result['coverage']['rejectedTrips'],1)

    def test_target_week_recomputes_calendar_exceptions(self):
        transit={'routes':[{'id':'57','kind':'bus'}], 'stops':[]}
        result=parse_gtfs(self.fixture(),transit, '2026-10-26')
        self.assertEqual(result['dates'][0], '2026-10-26')
        self.assertEqual(result['trips'][0]['weekdays'],[0,1,2,3,4])

    def test_refuses_uncovered_week_instead_of_shifting_schedule(self):
        with self.assertRaises(ScrapeError):
            parse_gtfs(self.fixture('20261020'),{'routes':[],'stops':[]})

    def test_geometry_trim_keeps_exit_anchors_between_separate_visits(self):
        routes = [{'id': '57', 'paths': [{'direction': 0, 'path': [[-71.1,42.35],[-71.09,42.35]]}]}]
        stops = {str(i): {'position': position} for i, position in enumerate([
            [-72,42],[-72,42],[-71.1,42.35],[-71.09,42.35],[-72,42],[-72,42],
            [-72,42],[-71.1,42.35],[-71.09,42.35],[-72,42],[-72,42]])}
        trip = {'route': '57', 'direction': 0, 'stops': [{'stop': str(i)} for i in range(11)]}
        trips, kept_stops = trim_to_geometry([trip], stops, routes)
        self.assertEqual([r['stop'] for r in trips[0]['stops']], ['1','2','3','4','6','7','8','9'])
        self.assertEqual(set(kept_stops), {'1','2','3','4','6','7','8','9'})
