// Headless simulation harness for the behaviour validator and the calibration search: imports
// the TypeScript sim modules directly (Node type stripping), like the tests do.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const load = (path) => import(pathToFileURL(`${ROOT}/src/${path}`));
const [{ buildPopulation }, { buildSourceDay }, { conditionsFor, weekdayOf }, { dateForWeekday }, validate, behavior, { createTransitService, mergeSchedules }] = await Promise.all([
  load('sim/population.ts'), load('sim/sourceDay.ts'), load('sim/conditions.ts'), load('data/campusData.ts'), load('sim/validate.ts'), load('sim/behavior.ts'),
  load('sim/transitService.ts'),
]);
export { buildSourceDay, conditionsFor, validate, behavior };

export const readData = (name) => JSON.parse(readFileSync(`${ROOT}/public/data/${name}.json`, 'utf8'));

export function loadInputs() {
  const data = readData('campus-data');
  const base = buildPopulation(readData('demo-day'), data, readData('population'));
  // As the map runs it: students ride published MBTA and BU Shuttle trips, and the day's campus events play.
  const transit = createTransitService(mergeSchedules(readData('transit-schedule'), readData('shuttle-schedule')));
  return { data, base, transit, bikes: readData('bikes'), outdoor: readData('outdoor') };
}

/** Representative days: two ordinary days compared with measured series, two sanity scenarios. */
export function representativeDays(data) {
  const wednesday = dateForWeekday(data, 2), saturday = dateForWeekday(data, 5);
  return [
    { label: 'Wednesday, classes, dry 62°F', weekday: 2, kind: 'normal', conditions: { date: wednesday, weather: { condition: 'clear', temperatureF: 62 } } },
    { label: 'Saturday, dry 62°F', weekday: 5, kind: 'normal', conditions: { date: saturday, weather: { condition: 'clear', temperatureF: 62 } } },
    { label: 'Finals Wednesday, dry 45°F', weekday: 2, kind: 'sanity', conditions: { date: '2026-12-16', weather: { condition: 'clear', temperatureF: 45 } } },
    { label: 'Rainy Wednesday, 50°F', weekday: 2, kind: 'sanity', rain: true, conditions: { date: wednesday, weather: { condition: 'rain', temperatureF: 50 } } },
  ];
}

/**
 * Simulate and score each day. `model` undefined = today's unconditioned model (no conditions at all).
 * Returns per-day scores plus the raw days (for reports).
 */
export function scoreModel({ base, data, bikes, transit }, model, { scale = 1, days = representativeDays(data) } = {}) {
  const scores = [], built = [];
  let dryOutdoor = null;
  for (const spec of days) {
    const conditions = model ? conditionsFor({ ...spec.conditions, weekday: spec.weekday, calendar: data.academicCalendar }) : undefined;
    const started = performance.now();
    const eventDate = weekdayOf(spec.conditions.date) === spec.weekday ? spec.conditions.date : dateForWeekday(data, spec.weekday);
    const day = buildSourceDay(base, data, spec.weekday, transit, { eventDate, conditions, model });
    const ms = performance.now() - started;
    const score = validate.scoreDay({ label: spec.label, day, base, data, weekday: spec.weekday, scale, bikes, kind: spec.kind });
    const outdoor15 = validate.outdoorAt(day, 15 * 3600) / scale;
    if (spec.weekday === 2 && !spec.rain && spec.kind === 'normal') dryOutdoor = outdoor15;
    if (spec.rain && model) {
      const share = dryOutdoor ? outdoor15 / dryOutdoor : 0;
      const metric = { id: 'outdoor-rain-share', label: 'People by the river at 15:00 in rain ÷ same day dry', value: share, loss: Math.max(0, share - 0.15) / 0.3, target: '≤ 15%', weight: 0.5 };
      score.metrics.push(metric); score.loss += metric.weight * metric.loss;
    }
    scores.push(score);
    built.push({ spec, day, ms, outdoor15 });
  }
  return { scores, built };
}
