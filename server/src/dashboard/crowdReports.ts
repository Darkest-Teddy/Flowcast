// "Was it busy?" crowd reports. Students say how busy a place was; the server keeps only anonymous
// counts per place, Boston date, Boston hour and answer. Nothing links a count to an account, a
// schedule or an exact time: the request's timestamp is rounded to the Boston hour before it is
// stored, and the per-account throttle lives only in memory as keyed hashes that expire within the hour.
// Reports are displayed beside the model's projections; they never feed the model.
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { bostonDate } from '../../../web/src/data/realData';
import type { CrowdAnswer, CrowdReportSummary, CrowdTally } from '../../../web/src/data/types';

export const CROWD_ANSWERS = ['quiet', 'ok', 'packed'] as const satisfies readonly CrowdAnswer[];
/** A report may describe a visit up to this long ago (the app asks within ~6 hours). */
export const REPORT_MAX_AGE_MS = 7 * 3600_000;
/** Read window: the last N Boston days (today included). */
export const READ_DAYS = { default: 7, max: 14 };
/** Hour buckets with fewer reports than this are left out of the read endpoint. */
export const MIN_BUCKET_REPORTS = 3;

export const crowdReportBody = z.object({
  locationId: z.string().min(1).max(160),
  answer: z.enum(CROWD_ANSWERS),
  /** When the student was there (ISO). Omitted means now. Only its Boston date and hour are kept. */
  at: z.iso.datetime({ offset: true }).optional(),
}).strict();
export const crowdReportQuery = z.object({ days: z.coerce.number().int().min(1).max(READ_DAYS.max).optional() }).strict();

interface Queryable { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

/** The bucket a report counts toward, or null when `at` is in the future or too old. */
export function reportBucket(at: Date, now: Date): { day: string; hour: number } | null {
  const age = now.getTime() - at.getTime();
  if (!Number.isFinite(age) || age < -5 * 60_000 || age > REPORT_MAX_AGE_MS) return null;
  const { day, hour } = bostonDate(at);
  return { day, hour };
}

/** Adds one to an aggregate count. The only write: no user, session or timestamp column exists. */
export async function addCrowdReport(db: Queryable, locationId: string, bucket: { day: string; hour: number }, answer: CrowdAnswer) {
  await db.query(`INSERT INTO dashboard_crowd_reports(location_id,day,hour,answer,count) VALUES($1,$2::date,$3,$4,1)
    ON CONFLICT (location_id,day,hour,answer) DO UPDATE SET count=dashboard_crowd_reports.count+1`, [locationId, bucket.day, bucket.hour, answer]);
}

const tally = (): CrowdTally => ({ quiet: 0, ok: 0, packed: 0, total: 0 });

/** Recent aggregates per place and Boston hour of day, summed over the last `days` Boston days. */
export async function readCrowdReports(db: Queryable, now: Date, days = READ_DAYS.default): Promise<CrowdReportSummary> {
  const today = bostonDate(now).day;
  const start = new Date(`${today}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - (days - 1));
  const since = start.toISOString().slice(0, 10);
  const result = await db.query(`SELECT location_id, hour, answer, SUM(count)::int AS count FROM dashboard_crowd_reports
    WHERE day >= $1::date AND day <= $2::date GROUP BY location_id, hour, answer`, [since, today]);
  const places = new Map<string, { all: CrowdTally; hours: Map<number, CrowdTally> }>();
  for (const row of result.rows) {
    const answer = row.answer as CrowdAnswer; const count = Number(row.count); const hour = Number(row.hour);
    if (!CROWD_ANSWERS.includes(answer) || !(count > 0)) continue;
    const place = places.get(String(row.location_id)) ?? { all: tally(), hours: new Map() };
    places.set(String(row.location_id), place);
    const bucket = place.hours.get(hour) ?? tally(); place.hours.set(hour, bucket);
    for (const t of [place.all, bucket]) { t[answer] += count; t.total += count; }
  }
  return {
    label: 'student reports', since, days, minReports: MIN_BUCKET_REPORTS,
    note: 'Anonymous counts of what students reported, separate from the model projection. Not live occupancy.',
    places: [...places].filter(([, p]) => p.all.total >= MIN_BUCKET_REPORTS).sort(([a], [b]) => a.localeCompare(b)).map(([locationId, p]) => ({
      locationId, ...p.all,
      hours: [...p.hours].filter(([, t]) => t.total >= MIN_BUCKET_REPORTS).sort(([a], [b]) => a - b).map(([hour, t]) => ({ hour, ...t })),
    })),
  };
}

/**
 * Per-account limits held only in this process: one report per place per hour, and a few per hour
 * overall. Keys are HMACs under a random per-process secret, so they cannot be matched to an account
 * (or to a stored count) and vanish on restart or expiry.
 */
export function createCrowdThrottle(options: { perPlaceMs?: number; maxPerWindow?: number; windowMs?: number; now?: () => number } = {}) {
  const perPlaceMs = options.perPlaceMs ?? 3600_000;
  const windowMs = options.windowMs ?? 3600_000;
  const maxPerWindow = options.maxPerWindow ?? 6;
  const clock = options.now ?? Date.now;
  const secret = randomBytes(32);
  const places = new Map<string, number>();
  const totals = new Map<string, number[]>();
  const key = (...parts: string[]) => createHmac('sha256', secret).update(parts.join('\u0000')).digest('base64url');
  function prune(now: number) {
    for (const [k, until] of places) if (until <= now) places.delete(k);
    for (const [k, times] of totals) { const kept = times.filter((t) => t > now - windowMs); if (kept.length) totals.set(k, kept); else totals.delete(k); }
  }
  return {
    /** True (and counted) when this account may report this place now. */
    take(accountId: string, locationId: string): boolean {
      const now = clock(); prune(now);
      const placeKey = key('place', accountId, locationId); const totalKey = key('total', accountId);
      const times = totals.get(totalKey) ?? [];
      if (places.has(placeKey) || times.length >= maxPerWindow) return false;
      places.set(placeKey, now + perPlaceMs); totals.set(totalKey, [...times, now]);
      return true;
    },
    /** For tests: how many keys are held, and whether any raw id appears in them. */
    inspect: () => [...places.keys(), ...totals.keys()],
  };
}
export type CrowdThrottle = ReturnType<typeof createCrowdThrottle>;
