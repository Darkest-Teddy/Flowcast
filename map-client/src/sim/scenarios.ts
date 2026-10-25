// What-if presets (public/data/scenarios.json): each overrides parts of the day's conditions and
// runs through the same conditions engine as live conditions.
import type { ConditionsInput, DayEvent } from './conditions';
import type { Provenance } from './behavior';

export interface Scenario {
  id: string;
  label: string;
  description: string;
  overrides: {
    date?: string;
    weekday?: number;
    period?: ConditionsInput['period'];
    periodLabel?: string;
    weather?: ConditionsInput['weather'];
    events?: DayEvent[];
  };
  provenance?: Provenance;
}
export interface ScenarioFile { schemaVersion: 1; description?: string; scenarios: Scenario[] }

export const LIVE = 'live';
export const BASELINE = 'baseline';

/** The conditions input for a scenario, on top of the live/playback input. */
export function scenarioInput(input: ConditionsInput, scenario: Scenario | undefined): ConditionsInput {
  if (!scenario) return input;
  const o = scenario.overrides;
  return {
    ...input,
    ...(o.date ? { date: o.date } : {}),
    ...(o.weekday !== undefined ? { weekday: o.weekday } : {}),
    ...(o.period ? { period: o.period, periodLabel: o.periodLabel } : {}),
    ...(o.weather ? { weather: { ...o.weather, source: 'scenario' as const } } : {}),
    events: o.events ?? [],
    scenario: scenario.id,
  };
}

/** The paired baseline for a comparison: the same weekday as an ordinary day (same students, same seeds). */
export function baselineInput(input: ConditionsInput, file: ScenarioFile | undefined, referenceDate: string): ConditionsInput {
  const baseline = file?.scenarios.find(row => row.id === BASELINE);
  return scenarioInput({ ...input, date: referenceDate, events: [] }, baseline ?? { id: BASELINE, label: 'Ordinary day', description: '',
    overrides: { period: 'classes', periodLabel: 'Classes in session', weather: { condition: 'clear', temperatureF: 62 } } });
}

export async function loadScenarios(url = '/data/scenarios.json'): Promise<ScenarioFile | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const file = await response.json() as ScenarioFile;
    return file.schemaVersion === 1 && Array.isArray(file.scenarios) ? file : undefined;
  } catch { return undefined; }
}
