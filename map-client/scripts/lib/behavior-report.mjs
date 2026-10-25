// The validation report (docs/behavior-validation.md) and the plain "audit" numbers behind it.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, validate } from './behavior-harness.mjs';

const fmt = (value) => Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(3);

/** Plain before/after numbers for the realism audit items. */
export function auditNumbers(day, base, scale = 1) {
  const kind = new Map(base.locations.map(location => [location.id, location.kind]));
  const at = (time, test) => day.stays.reduce((n, stay) => n + (test(stay.location) && stay.start <= time && time < stay.end ? 1 : 0), 0) / scale;
  const walkers = validate.walkersPerMinute(day);
  const access = day.trips.filter(trip => trip.from === 'off-campus' || trip.to === 'off-campus').length;
  const perCommuter = new Map();
  for (const trip of day.trips) if (trip.from === 'off-campus' || trip.to === 'off-campus') perCommuter.set(trip.agent, (perCommuter.get(trip.agent) ?? 0) + 1);
  const commuters = new Set(base.agents.filter(agent => agent.residency === 'commuter').map(agent => agent.id));
  const commuterCounts = [...perCommuter].filter(([id]) => commuters.has(id)).map(([, n]) => n);
  const fitrec = day.sourceActivities.filter(a => a.kind === 'gym' && a.locationId === 'fitrec').length / scale;
  let spike = { size: 0, minute: 0 };
  for (let minute = 1; minute < 1440; minute++) if (walkers[minute] - walkers[minute - 1] > spike.size) spike = { size: walkers[minute] - walkers[minute - 1], minute };
  const mugar = base.locations.find(location => location.id === 'mugar');
  return {
    'Dining halls, people at 12:00': at(12 * 3600, id => kind.get(id) === 'dining'),
    'Dining halls, people at 18:30': at(18.5 * 3600, id => kind.get(id) === 'dining'),
    'Mugar, people at 13:00': at(13 * 3600, id => id === 'mugar'),
    'Mugar, people at 21:00': at(21 * 3600, id => id === 'mugar'),
    'Mugar capacity (configured)': mugar?.capacity ?? 0,
    'Optional visits rejected': (day.sourceStats.unavailableActivities ?? 0) / scale,
    'Transit-stop walks (share of all walks)': access / Math.max(1, day.trips.length),
    'Commuters making 4+ stop walks (share)': commuterCounts.filter(n => n >= 4).length / Math.max(1, commuterCounts.length),
    'FitRec entries (day)': fitrec,
    'Largest one-minute rise in walkers': spike.size / scale,
    'Time of that rise (hour)': spike.minute / 60,
    'Peak walkers': Math.max(...walkers) / scale,
    'People by the river at 15:00': at(15 * 3600, id => id.startsWith('outdoor:')),
    'People by the river at 03:00': at(3 * 3600, id => id.startsWith('outdoor:')),
  };
}

export function scoreTable(legacy, current) {
  const lines = ['| Day | Metric | Target | Today’s model | Conditions engine | Loss before → after |', '|---|---|---|---|---|---|'];
  for (const score of current) {
    const before = legacy?.find(row => row.day === score.day);
    for (const metric of score.metrics) {
      const old = before?.metrics.find(row => row.id === metric.id);
      lines.push(`| ${score.day} | ${metric.label} | ${metric.target} | ${old ? fmt(old.value) : '—'} | ${fmt(metric.value)} | ${old ? fmt(old.loss) : '—'} → ${fmt(metric.loss)} |`);
    }
    lines.push(`| ${score.day} | **Weighted total loss** | lower is better | | | ${before ? fmt(before.loss) : '—'} → **${fmt(score.loss)}** |`);
  }
  return lines.join('\n');
}

/** Observed MBTA ridership and pedestrian counts, per series group: one column set per model. */
export function observationTable(columns) {
  const runs = columns.filter(([, built]) => built?.some(row => row.observed));
  if (!runs.length) return '';
  const cell = (value, digits = 2) => value === null || value === undefined ? '—' : Number(value).toFixed(digits);
  const lines = [];
  for (const day of runs[0][1].filter(row => row.observed)) {
    lines.push(`\n**${day.spec.label}**\n`);
    lines.push(`| Series group | n | ${runs.map(([name]) => `${name}: students r / peak h / ratio / overflow`).join(' | ')} |`);
    lines.push(`|---|---|${runs.map(() => '---').join('|')}|`);
    for (const group of day.observed.groups) {
      const parts = runs.map(([, built]) => {
        const g = built.find(row => row.spec.label === day.spec.label)?.observed?.groups.find(row => row.id === group.id);
        return g ? `${cell(g.shape)} / ${cell(g.peakHours, 1)} / ${cell(g.ratio)} / ${cell(g.overflow)}` : '—';
      });
      lines.push(`| ${group.label} | ${group.series} | ${parts.join(' | ')} |`);
    }
    const medians = runs.map(([name, built]) => {
      const o = built.find(row => row.spec.label === day.spec.label)?.observed;
      return o ? `${name}: students alone median r ${cell(o.studentsOnly.medianShape)}, median ratio ${cell(o.studentsOnly.medianRatio)}; students + public median r ${cell(o.everyone.medianShape)}, median ratio ${cell(o.everyone.medianRatio)} (${o.everyone.series} series); students through Kenmore's gates ${Math.round(o.kenmoreStudentEntries)}` : '';
    });
    lines.push('', ...medians.map(text => `- ${text}`));
  }
  return lines.join('\n');
}

/** What the observed counts show that engine parameters cannot fix (for the day builder's owner). */
export const OBSERVATION_FINDINGS = [
  "Observed counts, findings for the day builder (not engine parameters): no student enters through Kenmore's gates or rides from the Fenway or Longwood stations, because the transit planner's campus stop set and weights (transitService.ts / sourceDay.ts commutes) never pick them.",
  "Students alone exceed the counts at Green Line C stops (Hawes Street: 150 student alightings a day toward Cleveland Circle vs 30 counted; Kent Street 144 vs 32) and at several Route 57 stops (e.g. stop 933: 250 student boardings vs 104 counted): the planner weights a commuter's stop by published weekly trips, which loads the C branch and the 57; the engine has no parameter for stop choice.",
  "Comm Ave crosswalks see 2–4× the counted crossings in the 12:00–12:15 class change (Granby 2,164 vs 543; Cummington 2,176 vs 447; St Mary's 1,696 vs 706): weekly enrollment spreads each student's classes across the campus, so most class changes cross Comm Ave. Attendance below 100% and longer minimum trips home help only a little; the fit kept attendance at 100% because lowering it also cut dining-hall meals below BU Dining's counts.",
  "On Saturdays almost no students ride (B branch BU stops 2% of counts): commuters only come in on class days and residents' outings walk to a gateway rather than board a published trip.",
];

export function writeReport({ legacy, current, audits, timings, search, accepted, notes = [], observed = [] }) {
  const auditRows = Object.keys(audits.current).map(key => `| ${key} | ${fmt(audits.legacy[key])} | ${fmt(audits.current[key])} |`);
  const text = `# Behaviour validation

Generated on ${new Date().toISOString().slice(0, 10)} by \`npm run validate:behavior\` / \`npm run calibrate\` (map-client/scripts/validate-behavior.mjs, calibrate-behavior.mjs). Everything runs locally: the simulation is imported headlessly from \`map-client/src/sim\`, scored against measured BU data in the repo, and no network or AI service is used.

**Columns.** *Today’s model* is \`buildSourceDay\` with no conditions (the unconditioned model, unchanged). *Conditions engine* is the same roster with \`behavior.json\` + \`personas.json\` + \`outdoor.json\` and the day's conditions, which is what the map runs. Loss is ≥ 0 per metric (0 = on target); a proposal is accepted only if no metric's loss rises by more than the tolerance and the weighted total falls.

## Measured series and targets

- **FitRec** hourly entries, Oct 17–23 2026 (BU FitRec peak/quiet hours report), same weekday: hourly correlation, daily total ratio, busiest hour.
- **Library** historical gate counts by hour (School of Theology Library, 2019–20; the only BU library series in the data, used for shape only) vs simulated library entries by hour; plus occupancy shape checks.
- **Bluebikes** dock arrivals + departures at Charles River BU docks, average September 2026 Wednesday, hourly, vs simulated walk departures (activity-timing proxy).
- **Dining**: BU Dining's published 5,000 lunches and 5,000 dinners a day at the three main halls (BU Today 2017), and occupancy at meal times.
- **Pedestrian counts**: Comm Ave / Bay State Road crossings 17–18h vs 08–09h (Warren Towers EPNF, 2023), as a ratio.
- **Sanity**: walkers at 3 am, one-minute walker spikes, median and long walks, commuter stop walks, people by the river at 3 am and in rain.

## Scores

${scoreTable(legacy, current)}

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
${auditRows.join('\n')}

${observed.length ? `## Observed MBTA ridership and pedestrian counts

Scored with \`scoreObservations\` (src/sim/validate.ts) on the series in \`public/data/calibration-observations.json\` (see docs/calibration-observations.md). Students are the only people in university buildings; streets and the T also carry the public crowd (sim/publicCrowd.ts), which fills observed − students wherever students fall short, so students + public match by construction except where students alone exceed a count. The calibration therefore scores: the **timing of the students' own peaks** at BU-dominated places (B branch BU stops, ons and offs with both directions added; Comm Ave crosswalks, 2018 15-min and 2012 midday), as volume-weighted Pearson r and hours between busiest bins, weighted like FitRec and the library; a **band penalty** where students exceed their plausible share of a count ("overflow": students above observed × the series' high expected student share, as a share of everyone counted); and students + public shape and level over all primary series (public fill per publicCrowd.ts's rule).
${observationTable(observed)}

## Build time` : '## Build time'}

${timings.map(row => `- ${row.label}: ${row.ms.toFixed(0)} ms`).join('\n')}

${search ? `## Calibration search

- Method: ${search.method}
- Seed: ${search.seed}; inner-loop roster: every ${search.step}th student (${search.sampleStudents.toLocaleString()} of ${search.totalStudents.toLocaleString()}, capacities scaled to match), days: ${search.days.join('; ')}
- Evaluations: ${search.evaluations} in ${(search.seconds / 60).toFixed(1)} min; tolerance ${search.tolerance} per metric
- Tuned parameters (start → result): ${search.parameters.map(row => `\`${row.target}\` ${fmt(row.start)} → ${fmt(row.value)}`).join(', ')}
- Inner-loop loss: ${fmt(search.startLoss)} → ${fmt(search.bestLoss)}
- Full-roster confirmation: ${accepted ? 'accepted (no metric worse beyond tolerance, total improved); values written to behavior.json with provenance `fitted`' : `rejected (${search.rejectedBecause ?? 'no improvement'}); behavior.json left unchanged`}
` : ''}
## Notes and limitations

${['Library gate counts are from a small theology library in 2019–20; only their hourly shape is used. Mugar’s 800-seat capacity is a configured model value, not published.', 'Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.', 'FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.', 'Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.', 'Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.', 'The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.', ...OBSERVATION_FINDINGS, ...notes].map(line => `- ${line}`).join('\n')}
`;
  const path = resolve(ROOT, '..', 'docs', 'behavior-validation.md');
  writeFileSync(path, text);
  return path;
}
