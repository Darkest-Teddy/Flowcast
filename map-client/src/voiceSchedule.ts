import { buildPersonalSchedule } from '../../web/src/lib/personalSchedule';
import type { ScheduleItem } from '../../web/src/data/types';

export interface VoiceIdentity { userId: string; accessToken: string }

/** Fetch afresh for each lookup; never reuse another account's calendar or a failed read. */
export async function loadVoiceSchedule(
  identity: () => Promise<VoiceIdentity | null>, signal: AbortSignal,
  request: typeof fetch = fetch, at = new Date(),
) {
  const before = await identity();
  signal.throwIfAborted();
  if (!before) return { userId: null, personalSchedule: undefined };
  const response = await request('/api/dashboard/schedule', {
    headers: { Authorization: `Bearer ${before.accessToken}`, Accept: 'application/json' },
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error('Your schedule could not be loaded. Try again or open Calendars.');
  const data = await response.json();
  const after = await identity();
  signal.throwIfAborted();
  if (after?.userId !== before.userId) throw new Error('Your account changed. End voice and start again.');
  if (!Array.isArray(data?.items) || !data.items.every((item: Partial<ScheduleItem> | null) =>
    item && typeof item.title === 'string' && typeof item.start === 'string' && typeof item.end === 'string'
    && typeof item.locationId === 'string' && (item.locationText == null || typeof item.locationText === 'string'))) {
    throw new Error('Your saved schedule could not be read. Try again or open Calendars.');
  }
  return { userId: before.userId, personalSchedule: buildPersonalSchedule(data.items, at) };
}
