// Prints peak and mean fatigue for three reference days. Used by the fatigue-calibration skill.
// Run: node web/scripts/fatigue-sweep.ts
import { modelFatigue } from '../src/lib/fatigue.ts';
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';

const locations: CampusLocation[] = [
  { id: 'cas', name: 'College of Arts & Sciences', short: 'CAS', kind: 'classroom', capacity: 400 },
  { id: 'cds', name: 'Center for Computing & Data Sciences', short: 'CDS', kind: 'classroom', capacity: 300 },
  { id: 'mugar', name: 'Mugar Library', short: 'Mugar', kind: 'library', capacity: 600 },
  { id: 'warren', name: 'Warren Dining', short: 'Warren', kind: 'dining', capacity: 500 },
  { id: 'fitrec', name: 'FitRec', short: 'FitRec', kind: 'gym', capacity: 300 },
  { id: 'west', name: 'West Campus', short: 'West', kind: 'dorm', capacity: 1800 },
];

// Times are EDT (UTC-4) on Monday 26 October 2026.
const at = (hhmm: string) => `2026-10-26T${hhmm}:00-04:00`;
let n = 0;
const i = (loc: string, from: string, to: string): ScheduleItem => ({
  id: `i${n++}`, title: loc, locationId: loc, start: at(from), end: at(to), source: 'calendar',
});

const days: Record<string, ScheduleItem[]> = {
  rest: [i('warren', '10:00', '11:00'), i('west', '11:00', '15:00'), i('warren', '18:00', '19:00')],
  typical: [
    i('cas', '09:05', '10:20'), i('warren', '12:00', '12:45'), i('cds', '14:30', '15:45'),
    i('mugar', '16:00', '18:00'), i('warren', '18:30', '19:15'),
  ],
  packed: [
    i('cas', '08:00', '09:15'), i('cds', '09:25', '10:40'), i('cas', '10:45', '12:00'),
    i('cds', '12:05', '13:20'), i('mugar', '13:30', '17:30'), i('fitrec', '20:00', '21:30'),
    i('mugar', '21:45', '23:30'),
  ],
};

const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
console.log('day       mean   peak   peak at    rushes');
for (const [name, items] of Object.entries(days)) {
  const r = modelFatigue(items, locations, { wakeAt: at('07:30'), until: at('23:30'), utcOffsetHours: -4 });
  console.log(`${name.padEnd(9)} ${r.mean.toFixed(3)}  ${r.peak!.score.toFixed(3)}  ${fmt(r.peak!.at).padEnd(9)}  ${r.rushes}`);
}
