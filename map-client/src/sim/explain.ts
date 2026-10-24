// Plain-language explanation of what the behaviour engine is doing for the shown day, built
// from fixed templates (no API, no model): conditions, active modifiers and their effects,
// the persona mix, and where each number comes from.
import { clockLabel, type ActiveModifier, type Provenance } from './behavior';
import type { DayConditions } from './conditions';

export interface DayInfo {
  key: string;
  conditions: DayConditions;
  active: ActiveModifier[];
  personaMix: { id: string; label: string; students: number }[];
  students: number;
  /** behavior.json's last local validation (scripts/calibrate-behavior.mjs). */
  validation?: { generated?: string; totalLoss?: number; unconditionedLoss?: number; metrics?: Record<string, number> };
  buildMs: number;
  visits: Record<string, number>;
  outdoorPeak: { count: number; hour: number };
}

export interface Explanation {
  headline: string;
  conditions: string[];
  modifiers: { id: string; label: string; group: ActiveModifier['group']; effects: string[]; source: string }[];
  personas: string[];
  numbers: string[];
}

const PERIOD: Record<DayConditions['period'], string> = {
  classes: 'classes in session', holiday: 'a holiday (classes suspended)', break: 'a recess (classes suspended)', 'reading-period': 'the study period before finals',
  finals: 'final exams', 'move-in': 'move-in before classes start', unknown: 'outside the imported academic calendar',
};
const WEATHER: Record<DayConditions['weather']['kind'], string> = { dry: 'dry', rain: 'rain', storm: 'thunderstorms', snow: 'snow', heat: 'a heatwave' };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PROVENANCE: Record<Provenance['kind'], string> = { measured: 'measured', published: 'published', assumption: 'assumption', fitted: 'fitted locally to measured data' };

const pct = (ratio: number) => `${ratio >= 1 ? '+' : '−'}${Math.abs(Math.round((ratio - 1) * 100))}%`;
const number = (value: number) => Math.abs(value) >= 10 ? Math.round(value).toLocaleString('en-US') : String(+value.toFixed(2));

/** "library study: share who go +12%", "walking speed −15%", "earliest class arrival lead +3". */
export function effectText(change: ActiveModifier['changes'][number]): string {
  if (change.op === 'mul') return change.value === 0 ? `${change.label}: none` : `${change.label} ${pct(change.value)}`;
  if (change.op === 'add') return `${change.label} ${change.value >= 0 ? '+' : '−'}${number(Math.abs(change.value))}`;
  if (/start time|arrivals|arrival window/.test(change.label)) return `${change.label} set to ${clockLabel(change.after)}`;
  return `${change.label} set to ${number(change.after)}`;
}

export function provenanceText(provenance: Provenance): string {
  return `${PROVENANCE[provenance.kind] ?? provenance.kind}: ${provenance.note}${provenance.source ? ` (${provenance.source})` : ''}`;
}

export function explain(info: DayInfo): Explanation {
  const c = info.conditions;
  const temperature = c.weather.temperatureF === null ? '' : `, ${Math.round(c.weather.temperatureF)}°F`;
  const scenario = c.scenario && c.scenario !== 'live' ? ` Scenario: ${c.scenario.replace(/-/g, ' ')}.` : '';
  const headline = `${DAYS[c.weekday]} ${c.date}: ${PERIOD[c.period]}, ${WEATHER[c.weather.kind]}${temperature}.${scenario}`;
  const conditions = [
    `Academic calendar: ${c.periodLabel} (${PERIOD[c.period]}).`,
    `Weather: ${c.weather.condition === 'unknown' ? 'no reading yet, treated as dry' : `${c.weather.condition.replace(/-/g, ' ')}${temperature}`} (${c.weather.source === 'scenario' ? 'set by the scenario' : c.weather.source === 'none' ? 'no weather data' : `${c.weather.source} weather`}).`,
    `Daylight: sunrise ${clockLabel(c.daylight.sunrise)}, sunset ${clockLabel(c.daylight.sunset)}.`,
    ...c.events.map(event => `Event: ${event.label}, ${clockLabel(event.start / 3600)}–${clockLabel(event.end / 3600)}, about ${event.expectedStudents.toLocaleString('en-US')} students expected.`),
  ];
  const modifiers = info.active.map(modifier => ({
    id: modifier.id, label: modifier.label, group: modifier.group,
    effects: modifier.changes.map(effectText),
    source: provenanceText(modifier.provenance),
  }));
  const total = info.personaMix.reduce((sum, row) => sum + row.students, 0) || 1;
  const personas = info.personaMix.filter(row => row.students > 0).sort((a, b) => b.students - a.students)
    .map(row => `${row.label}: ${row.students.toLocaleString('en-US')} students (${Math.round(row.students / total * 100)}%)`);
  const v = info.validation;
  const numbers = [
    `${info.students.toLocaleString('en-US')} students simulated; ${Object.entries(info.visits).filter(([, n]) => n > 0).map(([kind, n]) => `${n.toLocaleString('en-US')} ${kind}`).join(', ')}.`,
    info.outdoorPeak.count > 0 ? `Most people by the river: about ${info.outdoorPeak.count.toLocaleString('en-US')} around ${clockLabel(info.outdoorPeak.hour)}.` : 'Nobody spends time by the river today.',
    v?.totalLoss !== undefined ? `Validated locally${v.generated ? ` on ${v.generated}` : ''} against FitRec hourly entries, historical library gate counts, Bluebikes dock activity, BU Dining's meal counts and Comm Ave pedestrian counts: total loss ${number(v.unconditionedLoss ?? NaN)} for the unconditioned model → ${number(v.totalLoss)} with these parameters (lower is better; see docs/behavior-validation.md).`
      : 'Not yet validated (run npm run calibrate).',
    `This day took ${Math.round(info.buildMs).toLocaleString('en-US')} ms to simulate, off the map's thread.`,
    'Conditions only change people’s timelines (who goes where, when, for how long); counts on the map are people, never scaled.',
  ];
  return { headline, conditions, modifiers, personas, numbers };
}
