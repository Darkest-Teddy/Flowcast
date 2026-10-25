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
  const lines = ['| Day | Metric | Target | Today’s model | Conditions engine | Loss before → after | Evidence basis | Calibration weight |', '|---|---|---|---|---|---|---|---|'];
  for (const score of current) {
    const before = legacy?.find(row => row.day === score.day);
    for (const metric of score.metrics) {
      const old = before?.metrics.find(row => row.id === metric.id);
      lines.push(`| ${score.day} | ${metric.label} | ${metric.target} | ${old ? fmt(old.value) : '—'} | ${fmt(metric.value)} | ${old ? fmt(old.loss) : '—'} → ${fmt(metric.loss)} | ${metric.basis ?? validate.metricBasis(metric.id)} | ${metric.weight || '0 (diagnostic)'} |`);
    }
    const scored = score.metrics.some(metric => metric.weight > 0);
    lines.push(`| ${score.day} | **Calibration objective** | ${scored ? 'lower is better' : 'not evaluated'} | | | ${scored ? `${before ? fmt(before.loss) : '—'} → **${fmt(score.loss)}**` : 'No comparable observed targets'} | | |`);
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
  'Synthetic enrollment, class attendance and commuter mode shares are model assumptions. Passing capacity and itinerary checks does not validate actual building occupancy.',
  'Transit and pedestrian comparison counts combine different years, populations and counting methods; expected student shares are assumed bands. The table reports current discrepancies without treating those bands as measured student counts.',
  'Weather and finals scenarios are checked for plausibility, not against date-matched observed outcomes. No independent empirical holdout is available in this validation run.',
];

export function sourceCoverage({ data, observations }) {
  const lines = ['## Observation coverage', '',
    `Simulation reference week starts ${data.referenceWeekStart}. Historical observations are not measurements of that simulated week.`, '',
    `FitRec snapshot: ${data.fitrecUsage?.periodStart ?? 'unavailable'} to ${data.fitrecUsage?.periodEnd ?? 'unavailable'}; ${data.fitrecUsage?.observations?.length ?? 0} observed hour cells. Entries include all pass holders, not student-only occupancy.`, '',
    `Library: ${data.libraryHistory?.name ?? 'unavailable'}; ${data.libraryHistory?.observationPeriod ?? 'unknown period'}. ${data.libraryHistory?.countingMethod ?? 'Unknown counting method.'}`, '',
    'Transit and pedestrian source periods in the saved bundle:', ''];
  for (const source of observations?.sources ?? []) {
    const series = [...observations.transit, ...observations.pedestrian].filter(row => row.source === source.id);
    if (!series.length) continue;
    lines.push(`- [${source.title}](${source.url}): ${source.period}; ${series.length} series, ${series.reduce((sum, row) => sum + row.bins.length, 0)} recorded bins.`);
  }
  lines.push('', 'Transit and crossing observations count all people; simulated students are a subset. Correlations are historical reference comparisons, not measured student shares. Sparse faregate-bin means have varying reporting-date denominators; their sum is not a measured daily total.', '', 'No date-matched rainy-day pedestrian series is provided. Rain multipliers are assumptions and are not fitted or validated by this report.');
  return lines.join('\n');
}

export function writeReport({ legacy, current, audits, timings, search, accepted, notes = [], observed = [], sourceInputs }) {
  const auditRows = Object.keys(audits.current).map(key => `| ${key} | ${fmt(audits.legacy[key])} | ${fmt(audits.current[key])} |`);
  const text = `# Behaviour validation

Generated on ${new Date().toISOString().slice(0, 10)} by \`npm run validate:behavior\` / \`npm run calibrate\` (map-client/scripts/validate-behavior.mjs, calibrate-behavior.mjs). Everything runs locally: the simulation is imported headlessly from \`map-client/src/sim\`, scored against measured BU data in the repo, and no network or AI service is used.

**Columns.** *Today’s model* is \`buildSourceDay\` with no conditions (the unconditioned planner from this checkout). *Conditions engine* is the same roster with \`behavior.json\` + \`personas.json\` + \`outdoor.json\` and the day's conditions, which is what the map runs. Both columns use the same implementation; they do not compare before and after a code change. Loss is ≥ 0 per metric (0 = on target); a proposal is accepted only if every existing metric remains present, no positively weighted non-assumption metric's loss rises by more than the tolerance, and the weighted total falls. Historical comparisons retain their original weights. Assumed sanity targets contribute soft penalties at 10% of their original weights, without individual regression vetoes. This factor is a modeling choice, not an empirical estimate. Indirect proxies, historical context with unknown comparability, and input reconstructions have zero weight. Rain/finals with no comparable observations are not evaluated for accuracy. Relative metric weights still encode modeling priorities; this total is not an accuracy percentage. Totals using these weights are not comparable with older reports.

## Measured series and targets

- **FitRec** hourly entries, Oct 17–23 2026 (BU FitRec peak/quiet hours report), same weekday: daily total ratio is diagnostic because measured entries include non-students; hourly correlation and busiest hour are diagnostic only because the planner samples arrival times from these same observations.
- **Library** historical patron/zone aggregates (School of Theology Library, 2019–20) vs simulated Theology Library entries. The source counting method is unknown, so this is context only; it is not verified gate-count or occupancy validation.
- **Bluebikes** dock arrivals + departures at Charles River BU docks, average September 2026 Wednesday, hourly, vs simulated walk departures (activity-timing proxy).
- **Dining**: 2017 published meal aggregates are historical context, not current occupancy targets. Meal-time and saturation checks are assumed sanity targets only.
- **Pedestrian counts**: simulated crossings at the surveyed locations and measured intervals, on the recorded weekdays. The Warren 2023 PM/AM ratio uses paired crossing bins at those same sites. Tuesday 2012 and Thursday 2018 surveys are evaluated on Tuesday and Thursday respectively, not Wednesday.
- **Sanity**: walkers at 3 am, one-minute walker spikes, median and long walks, commuter stop walks, people by the river at 3 am and in rain.

${sourceInputs ? sourceCoverage(sourceInputs) : ""}

## Scores

${scoreTable(legacy, current)}

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
${auditRows.join('\n')}

${observed.length ? `## Observed MBTA ridership and pedestrian counts

Scored with \`scoreObservations\` (src/sim/validate.ts) on the series in \`public/data/calibration-observations.json\` (see docs/calibration-observations.md). Students are the only people in university buildings; streets and the T also carry the public crowd (sim/publicCrowd.ts), which fills observed − students wherever students fall short, so students + public match by construction except where students alone exceed a count. The calibration therefore scores: the **timing of the students' own peaks** at BU-dominated places (B branch BU stops, ons and offs with both directions added; Comm Ave crosswalks, 2018 15-min and 2012 midday), as volume-weighted Pearson r and hours between busiest bins, with positive calibration weights; a direct count-excess term when simulated students exceed the historical all-person count in a bin. The displayed "overflow" relative to assumed student-share bands contributes a reduced-weight assumption penalty; students + public shape and level are shown as zero-weight reconstruction diagnostics, not evidence of predictive accuracy.
${observationTable(observed)}

## Build time` : '## Build time'}

${timings.map(row => `- ${row.label}: ${row.ms.toFixed(0)} ms`).join('\n')}

${search ? `## Recorded calibration search

This records the saved parameter search, not a new search performed by validation. Its losses may use earlier objective weights. Full-roster confirmation reuses calibration targets and is not an independent empirical holdout.

- Method: ${search.method}
- Seed: ${search.seed}; inner-loop roster: every ${search.step}th student (${search.sampleStudents.toLocaleString()} of ${search.totalStudents.toLocaleString()}, capacities scaled to match), days: ${search.days.join('; ')}
- Evaluations: ${search.evaluations} in ${(search.seconds / 60).toFixed(1)} min; tolerance ${search.tolerance} per metric
- Tuned parameters (start → result): ${search.parameters.map(row => `\`${row.target}\` ${fmt(row.start)} → ${fmt(row.value)}`).join(', ')}
- Inner-loop loss: ${fmt(search.startLoss)} → ${fmt(search.bestLoss)}
- Full-roster confirmation: ${accepted ? 'accepted (no metric worse beyond tolerance, total improved); values written to behavior.json with provenance `fitted`' : `rejected (${search.rejectedBecause ?? 'no improvement'}); behavior.json left unchanged`}
` : ''}
## Notes and limitations

${['The historical Theology Library counting method is unknown; the comparison is restricted to that library and excluded from calibration. Mugar’s 800-seat capacity is configured, not published.', 'Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.', 'FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.', 'Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.', 'Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.', 'The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.', ...OBSERVATION_FINDINGS, ...notes].map(line => `- ${line}`).join('\n')}
`;
  const path = resolve(ROOT, '..', 'docs', 'behavior-validation.md');
  writeFileSync(path, text);
  return path;
}
