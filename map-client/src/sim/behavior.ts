// Behaviour parameters for the day builder (sim/sourceDay.ts): every rate it uses has a base value
// (equal to the builder's own constants) plus modifiers keyed on the day's conditions (weather,
// academic period, weekday, time-of-day window, scenario, events). `paramsFor` composes them;
// `dayBehavior` adds per-student personas. Conditions only ever change timelines (who goes where,
// when, for how long); nothing here touches counts or capacities.
import type { OutdoorFile } from './outdoor';
import { conditionsKey, type AcademicPeriod, type DayConditions, type DayEvent, type TemperatureBand, type WeatherKind } from './conditions';

export type ProvenanceKind = 'measured' | 'published' | 'assumption' | 'fitted';
export interface Provenance {
  kind: ProvenanceKind;
  note: string;
  source?: string;
  /** Scores from the last validation run that accepted this value (scripts/calibrate-behavior.mjs). */
  validation?: Record<string, number>;
}

export const SCALAR_NAMES = [
  'classAttendance', 'arrivalLeadMinMinutes', 'arrivalLeadSpreadMinutes', 'homeBreakMinutes', 'commuterOffCampusGapMinutes',
  'offCampusMealShare', 'shoulderShare', 'walkSpeedFactor', 'walkSpeedSpread', 'postClassLingerMinutes', 'visitLengthSpread',
  'gapPlacement', 'commuterMinClasses', 'commuterActivityWindowMinutes', 'unmappedAcademicMinutes', 'offMapAcademicShare',
  'habitualTimeShare', 'favoriteVenueWeight', 'awayShareResidents', 'awayShareCommuters', 'eventAttendanceFactor', 'commuterOutdoorFactor',
] as const;
export type ScalarName = typeof SCALAR_NAMES[number];
export type Scalars = Record<ScalarName, number>;

export type ActivityKind = 'dining' | 'library' | 'gym' | 'off-campus-outing' | 'outdoor';
/** One optional free-time visit on a weekday menu. Hours are decimal (12.5 = 12:30). */
export interface ActivitySpec {
  id: string;
  kind: ActivityKind;
  /** Core window start; arrivals fall in [at, at + spread]. */
  at: number;
  spread: number;
  /** Broad-day window used by the `shoulderShare` of arrivals. */
  shoulder: readonly [number, number];
  minutes: number;
  probability: number;
  /** 0 = uniform arrivals over the core window (today's model), 1 = bell-shaped around its middle. */
  bell?: number;
  /** Outdoor visits: sitting on a lawn by the river, or walking/running the river path loop. */
  spot?: 'lawn' | 'loop';
}
export const ACTIVITY_FIELDS = ['probability', 'at', 'spread', 'minutes', 'bell', 'shoulderStart', 'shoulderEnd'] as const;
export type ActivityField = typeof ACTIVITY_FIELDS[number];

export interface ScalarSpec { base: number; min: number; max: number; unit: string; label: string; provenance: Provenance }
export interface MenuActivity extends ActivitySpec { label: string; provenance: Provenance }

export interface ModifierWhen {
  weather?: WeatherKind[];
  band?: TemperatureBand[];
  period?: AcademicPeriod[];
  weekday?: number[];
  scenario?: string[];
  /** True: only on days with a scheduled event. */
  events?: boolean;
}
export interface Effect {
  /** A scalar name, or `activity.<id | @kind | *>.<field>`. */
  target: string;
  op: 'mul' | 'add' | 'set';
  value: number;
  /** Search range for the local calibration (scripts/calibrate-behavior.mjs). */
  tune?: { min: number; max: number; step: number };
}
export interface Modifier {
  id: string;
  label: string;
  group: 'calibration' | 'conditions';
  when?: ModifierWhen;
  /** Hours [start, end): activity effects only touch activities whose core window overlaps it. */
  window?: [number, number];
  effects: Effect[];
  provenance: Provenance;
}

export interface BehaviorFile {
  schemaVersion: 1;
  description?: string;
  scalars: Record<ScalarName, ScalarSpec>;
  activities: { menus: Record<string, MenuActivity[]>; weekdayMenus: string[] };
  /** The day builder's stable personal habits (sourceDay.ts HABIT_TRAITS) by slot, plus any extra slots. */
  habits: Record<string, HabitSpec>;
  modifiers: Modifier[];
  validation?: unknown;
  search?: unknown;
}

export interface Persona {
  id: string;
  label: string;
  description: string;
  effects: Effect[];
  provenance: Provenance;
}
export interface PersonaFile {
  schemaVersion: 1;
  description?: string;
  /** Persona multipliers are rescaled per cohort so cohort averages stay at the day's values. */
  meanPreserving?: boolean;
  personas: Persona[];
  /** cohort → persona id → share; shares sum to 1 per cohort. */
  cohorts: Record<string, Record<string, number>>;
  provenance?: Provenance;
  /** Headcounts per cohort and students per persona in the roster the file was derived from. */
  roster?: { headcounts: Record<string, number>; assigned: Record<string, number> };
}

export interface BehaviorModel { behavior?: BehaviorFile; personas?: PersonaFile; outdoor?: OutdoorFile }

/** Values every day uses before modifiers; ActivitySpec arrays are indexed Monday=0 … Sunday=6. */
/** A habit slot: a `share` of students are regulars whose visit probability is multiplied by `high`;
 * everyone else gets the multiplier that keeps the population mean (sourceDay.ts habitMultiplier). */
export interface Habit { share: number; high: number }
export interface HabitSpec extends Habit { label: string; provenance: Provenance }
export interface ResolvedParams { scalars: Scalars; menus: ActivitySpec[][]; habits: Record<string, Habit> }

export interface ActiveModifier {
  id: string;
  label: string;
  group: Modifier['group'];
  provenance: Provenance;
  changes: { target: string; label: string; before: number; after: number; op: Effect['op']; value: number }[];
}

/** The builder's own constants (sourceDay.ts). With no behaviour file, nothing else applies. */
export interface LegacyBehavior { scalars: Scalars; menus: readonly (readonly ActivitySpec[])[]; habits: Record<string, Habit> }

// ---------------------------------------------------------------------------------------------

/** Same hash as sourceDay.ts, so per-student draws are stable across modules. */
export function unit(key: string): number {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

const ACTIVITY_LIMITS: Record<ActivityField, [number, number]> = {
  probability: [0, 1], at: [0, 23.99], spread: [0, 12], minutes: [10, 300], bell: [0, 1], shoulderStart: [0, 24], shoulderEnd: [0, 24],
};

function matchesWhen(when: ModifierWhen | undefined, conditions: DayConditions): boolean {
  if (!when) return true;
  if (when.weather && !when.weather.includes(conditions.weather.kind)) return false;
  if (when.band && !when.band.includes(conditions.weather.band)) return false;
  if (when.period && !when.period.includes(conditions.period)) return false;
  if (when.weekday && !when.weekday.includes(conditions.weekday)) return false;
  if (when.scenario && !when.scenario.includes(conditions.scenario ?? '')) return false;
  if (when.events !== undefined && when.events !== conditions.events.length > 0) return false;
  return true;
}

const apply = (current: number, effect: Effect) => effect.op === 'mul' ? current * effect.value : effect.op === 'add' ? current + effect.value : effect.value;
const clamp = (value: number, [min, max]: [number, number]) => Math.min(max, Math.max(min, value));

type Target = { scalar: ScalarName } | { habit: string; field: keyof Habit } | { selector: string; field: ActivityField };
function parseTarget(target: string): Target {
  if ((SCALAR_NAMES as readonly string[]).includes(target)) return { scalar: target as ScalarName };
  const habit = /^habit\.([^.]+)\.(share|high)$/.exec(target);
  if (habit) return { habit: habit[1], field: habit[2] as keyof Habit };
  const match = /^activity\.([^.]+)\.([A-Za-z]+)$/.exec(target);
  if (!match || !(ACTIVITY_FIELDS as readonly string[]).includes(match[2])) throw new Error(`Unknown behaviour target ${target}`);
  return { selector: match[1], field: match[2] as ActivityField };
}
const selects = (selector: string, activity: ActivitySpec) => selector === '*' || selector === activity.id || selector === `@${activity.kind}`;
const overlaps = (activity: ActivitySpec, window: [number, number] | undefined) => !window || (activity.at < window[1] && activity.at + activity.spread >= window[0]);

function readField(activity: ActivitySpec, field: ActivityField): number {
  if (field === 'shoulderStart') return activity.shoulder[0];
  if (field === 'shoulderEnd') return activity.shoulder[1];
  if (field === 'bell') return activity.bell ?? 0;
  return activity[field];
}
function writeField(activity: ActivitySpec, field: ActivityField, value: number): ActivitySpec {
  if (field === 'shoulderStart') return { ...activity, shoulder: [value, activity.shoulder[1]] };
  if (field === 'shoulderEnd') return { ...activity, shoulder: [activity.shoulder[0], value] };
  return { ...activity, [field]: value };
}

/** Human labels for the explanation ("library visits", "walking speed"). */
export function targetLabel(target: string, file?: BehaviorFile): string {
  const parsed = parseTarget(target);
  if ('scalar' in parsed) return file?.scalars[parsed.scalar]?.label ?? parsed.scalar;
  if ('habit' in parsed) return `${file?.habits?.[parsed.habit]?.label ?? parsed.habit}: ${parsed.field === 'share' ? 'share of regulars' : 'regulars’ boost'}`;
  const what = parsed.selector === '*' ? 'all free-time visits' : parsed.selector.startsWith('@')
    ? { '@dining': 'dining hall meals', '@library': 'library study', '@gym': 'gym visits', '@off-campus-outing': 'off-campus outings', '@outdoor': 'time outdoors by the river' }[parsed.selector] ?? parsed.selector
    : Object.values(file?.activities.menus ?? {}).flat().find(row => row.id === parsed.selector)?.label ?? parsed.selector;
  const field = { probability: 'share who go', at: 'start time', spread: 'arrival window', minutes: 'visit length', bell: 'arrival peak', shoulderStart: 'earliest arrivals', shoulderEnd: 'latest arrivals' }[parsed.field];
  return `${what}: ${field}`;
}

function baseFrom(model: BehaviorModel | undefined, legacy: LegacyBehavior): ResolvedParams {
  const file = model?.behavior;
  const legacyHabits = Object.fromEntries(Object.entries(legacy.habits).map(([slot, habit]) => [slot, { ...habit }]));
  if (!file) return { scalars: { ...legacy.scalars }, menus: legacy.menus.map(menu => menu.map(activity => ({ ...activity }))), habits: legacyHabits };
  const scalars = {} as Scalars;
  for (const name of SCALAR_NAMES) {
    const spec = file.scalars[name];
    if (!spec || !Number.isFinite(spec.base)) throw new Error(`behavior.json is missing scalar ${name}`);
    scalars[name] = spec.base;
  }
  if (file.activities.weekdayMenus.length !== 7) throw new Error('behavior.json needs seven weekday menus');
  const menus = file.activities.weekdayMenus.map(name => {
    const menu = file.activities.menus[name];
    if (!menu) throw new Error(`behavior.json has no menu ${name}`);
    return menu.map(({ id, kind, at, spread, shoulder, minutes, probability, bell, spot }): ActivitySpec =>
      ({ id, kind, at, spread, shoulder: [shoulder[0], shoulder[1]], minutes, probability, ...(bell ? { bell } : {}), ...(spot ? { spot } : {}) }));
  });
  const habits: Record<string, Habit> = legacyHabits;
  for (const [slot, spec] of Object.entries(file.habits ?? {})) habits[slot] = { share: spec.share, high: spec.high };
  return { scalars, menus, habits };
}

function scalarBounds(file: BehaviorFile | undefined, name: ScalarName): [number, number] {
  const spec = file?.scalars[name];
  return spec ? [spec.min, spec.max] : [-Infinity, Infinity];
}

/** Apply effects in order; return the changes (for the explanation). Clamping happens at the end. */
function applyEffects(params: ResolvedParams, effects: Effect[], window: [number, number] | undefined, file: BehaviorFile | undefined,
  weekday: number | undefined): ActiveModifier['changes'] {
  const changes: ActiveModifier['changes'] = [];
  for (const effect of effects) {
    const parsed = parseTarget(effect.target);
    if ('scalar' in parsed) {
      const before = params.scalars[parsed.scalar];
      params.scalars[parsed.scalar] = apply(before, effect);
      changes.push({ target: effect.target, label: targetLabel(effect.target, file), before, after: params.scalars[parsed.scalar], op: effect.op, value: effect.value });
      continue;
    }
    if ('habit' in parsed) {
      const current = params.habits[parsed.habit] ?? { share: 0, high: 1 };
      const before = current[parsed.field];
      params.habits = { ...params.habits, [parsed.habit]: { ...current, [parsed.field]: apply(before, effect) } };
      changes.push({ target: effect.target, label: targetLabel(effect.target, file), before, after: params.habits[parsed.habit][parsed.field], op: effect.op, value: effect.value });
      continue;
    }
    let first: { before: number; after: number } | undefined;
    params.menus = params.menus.map((menu, day) => menu.map(activity => {
      if (!selects(parsed.selector, activity) || !overlaps(activity, window)) return activity;
      const before = readField(activity, parsed.field);
      const after = apply(before, effect);
      if (!first || day === weekday) first = { before, after };
      return writeField(activity, parsed.field, after);
    }));
    if (first) changes.push({ target: effect.target, label: targetLabel(effect.target, file), ...first, op: effect.op, value: effect.value });
  }
  return changes;
}

function clampAll(params: ResolvedParams, file: BehaviorFile | undefined): ResolvedParams {
  const scalars = { ...params.scalars };
  for (const name of SCALAR_NAMES) scalars[name] = clamp(scalars[name], scalarBounds(file, name));
  const menus = params.menus.map(menu => menu.map(activity => {
    let next = activity;
    for (const field of ACTIVITY_FIELDS) next = writeField(next, field, clamp(readField(next, field), ACTIVITY_LIMITS[field]));
    if (next.shoulder[1] < next.shoulder[0]) next = { ...next, shoulder: [next.shoulder[0], next.shoulder[0]] };
    return next;
  }));
  // A regular's boost stays ≥ 1; everyone else's multiplier is floored at 0 where it is used.
  const habits = Object.fromEntries(Object.entries(params.habits).map(([slot, habit]) =>
    [slot, { high: Math.max(1, habit.high), share: clamp(habit.share, [0, 1]) }]));
  return { scalars, menus, habits };
}

/**
 * Compose base values and every modifier whose conditions hold, in file order (calibration first,
 * then conditions), multiplicative/additive/set, clamped to each parameter's bounds at the end.
 */
export function paramsFor(conditions: DayConditions, model: BehaviorModel | undefined, legacy: LegacyBehavior): { params: ResolvedParams; active: ActiveModifier[] } {
  const file = model?.behavior;
  let params = baseFrom(model, legacy);
  const active: ActiveModifier[] = [];
  const ordered = [...(file?.modifiers ?? [])].sort((a, b) => Number(a.group !== 'calibration') - Number(b.group !== 'calibration'));
  for (const modifier of ordered) {
    if (!matchesWhen(modifier.when, conditions)) continue;
    const changes = applyEffects(params, modifier.effects, modifier.window, file, conditions.weekday);
    active.push({ id: modifier.id, label: modifier.label, group: modifier.group, provenance: modifier.provenance, changes });
  }
  params = clampAll(params, file);
  const daylight = daylightLimits(params, conditions);
  if (daylight) active.push(daylight);
  return { params, active };
}

export function clockLabel(hours: number): string {
  const total = Math.round(hours * 60), h = Math.floor(total / 60) % 24, m = total % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const clock = clockLabel;
/** Outdoor visits happen in daylight: from half an hour after sunrise to a quarter hour after sunset. */
function daylightLimits(params: ResolvedParams, conditions: DayConditions): ActiveModifier | undefined {
  if (!conditions.daylight || !params.menus.some(menu => menu.some(activity => activity.kind === 'outdoor' && activity.probability > 0))) return undefined;
  const first = conditions.daylight.sunrise + 0.5, last = conditions.daylight.sunset + 0.25;
  const changes: ActiveModifier['changes'] = [];
  params.menus = params.menus.map(menu => menu.map(activity => {
    if (activity.kind !== 'outdoor') return activity;
    const hours = activity.minutes / 60;
    const shoulder: [number, number] = [Math.max(activity.shoulder[0], first), Math.min(activity.shoulder[1], last - hours)];
    const at = Math.max(activity.at, first);
    const spread = Math.max(0, Math.min(activity.spread, last - hours - at));
    if (shoulder[1] < shoulder[0] || at + hours > last) {
      if (activity.probability > 0) changes.push({ target: `activity.${activity.id}.probability`, label: `${activity.id}: share who go`, before: activity.probability, after: 0, op: 'set', value: 0 });
      return { ...activity, probability: 0 };
    }
    if (at !== activity.at || spread !== activity.spread || shoulder[1] !== activity.shoulder[1]) {
      changes.push({ target: `activity.${activity.id}.shoulderEnd`, label: `${activity.id}: latest arrivals`, before: activity.shoulder[1], after: shoulder[1], op: 'set', value: shoulder[1] });
    }
    return { ...activity, at, spread, shoulder };
  }));
  return { id: 'daylight', label: `Daylight: outdoors between ${clock(first)} and ${clock(last)} (sunset ${clock(conditions.daylight.sunset)})`, group: 'conditions', changes,
    provenance: { kind: 'measured', note: 'Sunrise and sunset at BU for the date (NOAA solar position equations); outdoor time is limited to daylight.', source: 'https://gml.noaa.gov/grad/solcalc/solareqns.PDF' } };
}

// ---------------------------------------------------------------------------------------------
// Personas

export interface StudentLike { id: string; studentLevel?: 'undergraduate' | 'graduate'; attendance?: 'full-time' | 'part-time'; residency?: 'resident' | 'commuter'; home?: string }

export function cohortOf(agent: StudentLike): string {
  const resident = agent.residency === 'resident' || (!agent.residency && agent.home !== undefined && agent.home !== 'off-campus');
  if (agent.studentLevel === 'undergraduate') return resident ? 'undergraduate-resident' : 'undergraduate-commuter';
  if (agent.studentLevel === 'graduate') return agent.attendance === 'part-time' ? 'graduate-part-time' : 'graduate-full-time';
  return 'other';
}

export function validatePersonas(file: PersonaFile): void {
  const ids = new Set(file.personas.map(persona => persona.id));
  if (ids.size !== file.personas.length) throw new Error('Duplicate persona id');
  for (const persona of file.personas) for (const effect of persona.effects) parseTarget(effect.target);
  for (const [cohort, shares] of Object.entries(file.cohorts)) {
    let total = 0;
    for (const [id, share] of Object.entries(shares)) {
      if (!ids.has(id)) throw new Error(`Cohort ${cohort} uses unknown persona ${id}`);
      if (!(share >= 0)) throw new Error(`Cohort ${cohort} has a negative share for ${id}`);
      total += share;
    }
    if (Math.abs(total - 1) > 1e-9) throw new Error(`Persona shares for ${cohort} sum to ${total}, not 1`);
  }
}

/** Deterministic: the same student always gets the same persona (hash of the id). */
export function personaFor(agent: StudentLike, file: PersonaFile | undefined): string | undefined {
  const shares = file?.cohorts[cohortOf(agent)];
  if (!shares) return undefined;
  let point = unit(`persona:${agent.id}`);
  const entries = Object.entries(shares).sort(([a], [b]) => a.localeCompare(b));
  for (const [id, share] of entries) { point -= share; if (point < 0) return id; }
  return entries.at(-1)?.[0];
}

/** Per-cohort rescaled persona effects: share-weighted mean multiplier 1, mean shift 0, per target. */
function cohortEffects(file: PersonaFile, cohort: string): Map<string, Effect[]> {
  const shares = file.cohorts[cohort] ?? {};
  const out = new Map(file.personas.map(persona => [persona.id, persona.effects.map(effect => ({ ...effect }))]));
  if (!file.meanPreserving) return out;
  const targets = new Set(file.personas.flatMap(persona => persona.effects.filter(effect => effect.op !== 'set').map(effect => `${effect.op}:${effect.target}`)));
  for (const key of targets) {
    const [op, target] = [key.slice(0, 3), key.slice(4)];
    let mean = 0;
    for (const persona of file.personas) {
      const value = persona.effects.filter(effect => effect.op === op && effect.target === target).reduce((sum, effect) => op === 'mul' ? sum * effect.value : sum + effect.value, op === 'mul' ? 1 : 0);
      mean += (shares[persona.id] ?? 0) * value;
    }
    if (op === 'mul' && mean <= 0) continue;
    for (const [id, effects] of out) {
      if (!(shares[id] > 0)) continue;
      const own = effects.filter(effect => effect.op === op && effect.target === target);
      if (own.length) for (const effect of own) effect.value = op === 'mul' ? effect.value / mean ** (1 / own.length) : effect.value - mean / own.length;
      else effects.push({ target, op: op as Effect['op'], value: op === 'mul' ? 1 / mean : -mean });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface DayBehavior {
  key: string;
  conditions: DayConditions;
  params: ResolvedParams;
  active: ActiveModifier[];
  events: DayEvent[];
  outdoor?: OutdoorFile;
  personaOf(agent: StudentLike): string | undefined;
  /** Day parameters with the student's persona applied (cached per cohort and persona). */
  paramsOf(agent: StudentLike): ResolvedParams;
}

const modelKeys = new WeakMap<object, string>();
function fingerprint(model: BehaviorModel | undefined): string {
  if (!model || (!model.behavior && !model.personas && !model.outdoor)) return 'legacy';
  let key = modelKeys.get(model);
  if (!key) { key = unit(JSON.stringify([model.behavior ?? null, model.personas ?? null, model.outdoor?.spots.map(spot => spot.id) ?? null])).toString(36).slice(2, 10); modelKeys.set(model, key); }
  return key;
}

export function dayBehavior(conditions: DayConditions, model: BehaviorModel | undefined, legacy: LegacyBehavior): DayBehavior {
  const { params, active } = paramsFor(conditions, model, legacy);
  const personas = model?.personas;
  if (personas) validatePersonas(personas);
  const byCohort = new Map<string, Map<string, Effect[]>>();
  const cache = new Map<string, ResolvedParams>();
  return {
    key: `${conditionsKey(conditions)}#${fingerprint(model)}`,
    conditions, params, active, events: conditions.events, outdoor: model?.outdoor,
    personaOf: agent => personaFor(agent, personas),
    paramsOf(agent) {
      const persona = personaFor(agent, personas);
      if (!persona || !personas) return params;
      const cohort = cohortOf(agent);
      let resolved = cache.get(`${cohort}:${persona}`);
      if (!resolved) {
        resolveCohort(cohort);
        resolved = cache.get(`${cohort}:${persona}`) ?? params;
      }
      return resolved;
    },
  };
  /** Every persona of a cohort at once, so visit probabilities can be held at the day's cohort
   * average even where a persona's multiplier hits the 0–1 bounds (mean-preserving files only). */
  function resolveCohort(cohort: string) {
    if (!personas) return;
    let effects = byCohort.get(cohort);
    if (!effects) { effects = cohortEffects(personas, cohort); byCohort.set(cohort, effects); }
    const shares = Object.entries(personas.cohorts[cohort] ?? {}).filter(([, share]) => share > 0);
    const resolved = new Map<string, ResolvedParams>();
    for (const persona of personas.personas) {
      const copy: ResolvedParams = { scalars: { ...params.scalars }, menus: params.menus, habits: params.habits };
      applyEffects(copy, effects.get(persona.id) ?? [], undefined, model?.behavior, undefined);
      resolved.set(persona.id, clampAll(copy, model?.behavior));
    }
    if (personas.meanPreserving && shares.length) {
      params.menus.forEach((menu, day) => menu.forEach((activity, index) => {
        const target = activity.probability;
        const values = shares.map(([id, share]) => ({ id, share, p: resolved.get(id)!.menus[day][index].probability }));
        let k = 1;
        for (let round = 0; round < 12; round++) {
          const mean = values.reduce((sum, row) => sum + row.share * Math.min(1, row.p * k), 0);
          if (!(mean > 0) || Math.abs(mean - target) < 1e-6) break;
          k *= target / mean;
        }
        if (k === 1) return;
        for (const row of values) {
          const persona = resolved.get(row.id)!;
          if (persona.menus === params.menus) persona.menus = params.menus.map(list => list.slice());
          persona.menus[day][index] = { ...persona.menus[day][index], probability: Math.min(1, row.p * k) };
        }
      }));
    }
    if (personas.meanPreserving && shares.length) {
      // Habit regulars (sourceDay.ts habits): personas that set a share keep it; the cohort's other
      // students share the remainder, so the cohort's share of regulars stays at the day's value.
      for (const slot of Object.keys(params.habits)) {
        const target = `habit.${slot}.share`;
        const explicit = shares.filter(([id]) => (effects!.get(id) ?? []).some(effect => effect.target === target));
        const implicit = shares.filter(([id]) => !explicit.some(([other]) => other === id));
        const implicitWeight = implicit.reduce((sum, [, share]) => sum + share, 0);
        if (!explicit.length || !(implicitWeight > 0)) continue;
        const day = params.habits[slot];
        const rest = (day.share - explicit.reduce((sum, [id, share]) => sum + share * resolved.get(id)!.habits[slot].share, 0)) / implicitWeight;
        for (const [id] of implicit) {
          const persona = resolved.get(id)!;
          persona.habits = { ...persona.habits, [slot]: { ...persona.habits[slot], share: Math.min(1, Math.max(0, rest)) } };
        }
      }
    }
    for (const [id, value] of resolved) cache.set(`${cohort}:${id}`, value);
  }
}

/** Load the behaviour and persona files (browser). Missing files mean today's behaviour. */
export async function loadBehaviorModel(base = '/data'): Promise<BehaviorModel> {
  const get = async <T,>(name: string): Promise<T | undefined> => {
    try {
      const response = await fetch(`${base}/${name}`);
      return response.ok ? await response.json() as T : undefined;
    } catch { return undefined; }
  };
  const [behavior, personas, outdoor] = await Promise.all([get<BehaviorFile>('behavior.json'), get<PersonaFile>('personas.json'), get<OutdoorFile>('outdoor.json')]);
  return { behavior, personas, outdoor };
}
