// "Was it busy?": which suggested place to ask about, and how to describe what students reported.
// Pure: the prompt component keeps the state in localStorage and the server keeps only anonymous counts.
//
// Never nags by construction: the app asks about one suggestion at most, only the most recent one whose
// arrival time has passed in the last six hours, only on a later open than the one that suggested it,
// and only once (shown counts as handled, whatever the student taps or doesn't).
import type { CrowdAnswer, CrowdReportSummary, CrowdTally } from '../data/types';

export type SuggestionSource = 'gap' | 'study';
export interface CrowdSuggestion {
  id: string;
  locationId: string;
  /** When the student would have arrived (epoch ms). */
  at: number;
  source: SuggestionSource;
  /** The app open that made the suggestion; the prompt waits for a later one. */
  openId: string;
}
export interface CrowdPromptState { suggestions: CrowdSuggestion[]; handled: string[] }

export const CROWD_STORAGE_KEY = 'flowcast.crowdReports.v1';
/** Ask only about visits in this window... */
export const PROMPT_WINDOW_MS = 6 * 3600_000;
/** ...that started at least this long ago. */
export const PROMPT_MIN_AGE_MS = 10 * 60_000;
const MAX_SUGGESTIONS = 8;
const MAX_HANDLED = 20;

export const emptyPromptState = (): CrowdPromptState => ({ suggestions: [], handled: [] });

/** Reads stored state, dropping anything malformed. */
export function parsePromptState(raw: string | null): CrowdPromptState {
  try {
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return emptyPromptState();
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter((s: unknown): s is CrowdSuggestion => {
      const v = s as CrowdSuggestion;
      return !!v && typeof v.id === 'string' && typeof v.locationId === 'string' && Number.isFinite(v.at)
        && (v.source === 'gap' || v.source === 'study') && typeof v.openId === 'string';
    }) : [];
    const handled = Array.isArray(data.handled) ? data.handled.filter((h: unknown): h is string => typeof h === 'string') : [];
    return { suggestions, handled };
  } catch { return emptyPromptState(); }
}

/**
 * Remembers a suggestion. Within one open the same place (and source) is one suggestion whose arrival
 * time follows the latest render; old entries fall out of the window and the list stays short.
 */
export function addSuggestion(state: CrowdPromptState, input: Omit<CrowdSuggestion, 'id'>, now: number): CrowdPromptState {
  const same = state.suggestions.find((s) => s.openId === input.openId && s.locationId === input.locationId && s.source === input.source);
  const next: CrowdSuggestion = { ...input, id: same?.id ?? `${input.source}:${input.locationId}:${Math.round(input.at / 60_000)}` };
  const suggestions = [...state.suggestions.filter((s) => s !== same && s.at > now - PROMPT_WINDOW_MS), next]
    .sort((a, b) => a.at - b.at).slice(-MAX_SUGGESTIONS);
  const ids = new Set(suggestions.map((s) => s.id));
  return { suggestions, handled: state.handled.filter((h) => ids.has(h)).slice(-MAX_HANDLED) };
}

/** The one suggestion to ask about on this open, or null. */
export function pickPrompt(state: CrowdPromptState, now: number, openId: string): CrowdSuggestion | null {
  const past = state.suggestions.filter((s) => s.at <= now - PROMPT_MIN_AGE_MS && s.at >= now - PROMPT_WINDOW_MS);
  const latest = past.reduce<CrowdSuggestion | null>((a, b) => (!a || b.at > a.at ? b : a), null);
  if (!latest || latest.openId === openId || state.handled.includes(latest.id)) return null;
  return latest;
}

export const markHandled = (state: CrowdPromptState, id: string): CrowdPromptState =>
  state.handled.includes(id) ? state : { ...state, handled: [...state.handled, id].slice(-MAX_HANDLED) };

export const ANSWER_LABEL: Record<CrowdAnswer, string> = { quiet: 'Quiet', ok: 'OK', packed: 'Packed' };

/** The Boston hour of day for a time, to match the report buckets. */
export function bostonHour(at: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(at)) % 24;
}

/** "mostly Packed" when one answer has more than half the reports, else "mixed". */
export function mostly(t: CrowdTally): string {
  const [top, share] = (Object.keys(ANSWER_LABEL) as CrowdAnswer[]).map((a) => [a, t[a] / t.total] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
  return share > 0.5 ? `mostly ${ANSWER_LABEL[top]}` : 'mixed';
}

/**
 * "Students reported: mostly Packed around 12 PM (8 reports this week)", or null when there are too few.
 * Uses the hour's own reports when there are enough, otherwise the place's reports at any hour.
 */
export function reportSummary(summary: CrowdReportSummary | null | undefined, locationId: string, hour?: number, hourLabel?: string): string | null {
  const place = summary?.places.find((p) => p.locationId === locationId);
  if (!summary || !place || place.total < summary.minReports) return null;
  const span = summary.days === 7 ? 'this week' : `in the last ${summary.days} days`;
  const atHour = hour === undefined ? undefined : place.hours.find((h) => h.hour === hour);
  const t = atHour ?? place;
  const plural = `${t.total} ${t.total === 1 ? 'report' : 'reports'}`;
  return `Students reported: ${mostly(t)}${atHour && hourLabel ? ` around ${hourLabel}` : ''} (${plural} ${span})`;
}
