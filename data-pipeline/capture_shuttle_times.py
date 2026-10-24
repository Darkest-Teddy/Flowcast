"""Record the BU Shuttle's current scheduled stop times from TransLoc.

TransLoc's public feed only exposes scheduled times for roughly the next one to three hours, so a
full service day needs repeated polls. Each poll appends to a dated snapshot under
snapshots/transloc/, keeping only the published schedule (route, stop, scheduled arrival and
departure) and the window the poll could see. Estimates, vehicle positions and passenger counts
are never stored. build_shuttle_schedule.py turns covered windows into timetable trips.

    python3 capture_shuttle_times.py              # one poll
    python3 capture_shuttle_times.py --watch      # poll every 30 minutes until stopped
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
import urllib.request
from zoneinfo import ZoneInfo


# Kept free of common.py's scraping dependencies so the watcher runs with a bare Python.
USER_AGENT = 'FlowcastResearch/1.0 (public aggregate campus data; cached requests)'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=1) + '\n')
    temp.replace(path)

HERE = Path(__file__).resolve().parent
SNAPSHOTS = HERE / 'snapshots' / 'transloc'
API = 'https://bu.transloc.com/Services/JSONPRelay.svc/GetStopArrivalTimes?timesPerStopString=500'
BOSTON = ZoneInfo('America/New_York')


def epoch(value):
    match = re.search(r'/Date\((\d+)', value or '')
    return int(match.group(1)) / 1000 if match else None


def poll():
    request = urllib.request.Request(API, headers={'User-Agent': USER_AGENT})
    polled = time.time()
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = json.load(response)
    calls = []
    for row in rows:
        for entry in row.get('Times') or []:
            arrival = epoch(entry.get('ScheduledArrivalTime'))
            departure = epoch(entry.get('ScheduledDepartureTime')) or arrival
            if arrival is None or not row.get('StopId'):
                continue
            calls.append({'route': row['RouteId'], 'routeStop': row['RouteStopId'], 'stop': row['StopId'],
                          'arrival': round(arrival), 'departure': round(departure)})
    # Horizon per route: the latest scheduled time this poll returned for it.
    horizons = {}
    for call in calls:
        horizons[str(call['route'])] = max(horizons.get(str(call['route']), 0), call['departure'])
    return {'polledAt': round(polled), 'horizons': horizons, 'calls': calls}


def append(snapshot):
    day = datetime.fromtimestamp(snapshot['polledAt'], BOSTON).date().isoformat()
    path = SNAPSHOTS / f'{day}.json'
    data = json.loads(path.read_text()) if path.exists() else {
        'schemaVersion': 1, 'source': API, 'timezone': 'America/New_York', 'date': day,
        'note': 'TransLoc scheduled stop times as published for BU Shuttle routes; estimates are not stored.',
        'polls': []}
    data['polls'].append(snapshot)
    write_json(path, data)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--watch', action='store_true', help='Keep polling until stopped')
    parser.add_argument('--interval', type=int, default=1800, help='Seconds between polls')
    args = parser.parse_args()
    while True:
        try:
            snapshot = poll()
            path = append(snapshot)
            print(f'{datetime.now(timezone.utc).isoformat()} {len(snapshot["calls"])} scheduled calls -> {path}', flush=True)
        except Exception as exc:  # keep watching through transient network failures
            print(f'{datetime.now(timezone.utc).isoformat()} poll failed: {exc}', flush=True)
            if not args.watch:
                raise
        if not args.watch:
            return
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
