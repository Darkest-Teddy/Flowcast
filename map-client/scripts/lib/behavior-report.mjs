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

export function writeReport({ legacy, current, audits, timings, search, accepted, notes = [] }) {
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

## Build time

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

${['Library gate counts are from a small theology library in 2019–20; only their hourly shape is used. Mugar’s 800-seat capacity is a configured model value, not published.', 'Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.', 'FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.', 'Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.', 'Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.', 'The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.', ...notes].map(line => `- ${line}`).join('\n')}
`;
  const path = resolve(ROOT, '..', 'docs', 'behavior-validation.md');
  writeFileSync(path, text);
  return path;
}
