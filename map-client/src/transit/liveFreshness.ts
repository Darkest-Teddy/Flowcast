// GPS observations older than 90 seconds no longer establish a vehicle's current location.
export const LIVE_VEHICLE_MAX_AGE_MS = 90_000;

export function parseObservationTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const microsoftDate = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  // In Microsoft's JSON date format the numeric component is already Unix milliseconds.
  const time = microsoftDate ? Number(microsoftDate[1]) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function isFreshObservation(observedAt: number | null | undefined, now = Date.now()): boolean {
  if (observedAt == null || !Number.isFinite(observedAt)) return false;
  const age = now - observedAt;
  return age >= 0 && age <= LIVE_VEHICLE_MAX_AGE_MS;
}

/** TransLoc sometimes supplies a future clock value. A changed source timestamp still
 * identifies a new report, but polling the same report must never renew its lifetime. */
export class ShuttleObservationClock {
  private readonly reports = new Map<string, { sourceTime: number; observedAt: number }>();

  observe(id: string, sourceTime: number | null, now = Date.now()): number | null {
    if (sourceTime == null || !Number.isFinite(sourceTime)) return null;
    const previous = this.reports.get(id);
    if (previous?.sourceTime === sourceTime) return previous.observedAt;
    const observedAt = sourceTime > now ? now : sourceTime;
    this.reports.set(id, { sourceTime, observedAt });
    return observedAt;
  }
}
