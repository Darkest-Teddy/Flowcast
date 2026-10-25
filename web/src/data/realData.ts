import type { CampusLocation, Club, DashboardMe, DashboardPublic, EventImpactData, EventMapStatus, HourlyForecast, PlaceForecast } from './types';

export interface EventBundle extends EventImpactData {
  schemaVersion: number;
  events: { id: string; name: string; start: string; end: string | null; organizer: string | null;
    locationId: string | null; locationName: string | null; roomCode: string | null; sourceUrl: string; status: EventMapStatus }[];
}

export function locationsFromBundle(bundle: EventImpactData): CampusLocation[] {
  const kinds = new Set(['dorm', 'classroom', 'library', 'dining', 'gym', 'venue']);
  return bundle.places.filter((p) => kinds.has(p.kind)).map((p) => ({
    id: p.id, name: p.name, short: p.short, kind: p.kind as CampusLocation['kind'], capacity: p.capacity,
  }));
}

export const organizerId = (name: string) => `organizer:${encodeURIComponent(name)}`;

export function clubsFromBundle(bundle: EventBundle, followed: readonly string[] = []): Club[] {
  return [...new Set(bundle.events.map((e) => e.organizer?.trim()).filter((name): name is string => !!name))]
    .sort((a, b) => a.localeCompare(b)).map((name) => ({
      id: organizerId(name), name, verified: false, members: null, following: followed.includes(organizerId(name)),
      description: 'Organizer identified in published Terrier Central event listings. Membership and officer information are unavailable.',
    }));
}

export function bostonDate(at: Date): { day: string; weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return { day, weekday: (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7, hour: Number(part('hour')) };
}

/** Missing/zero model coverage is omitted, never presented as evidence that a place is quiet. */
export function forecastsFromBundle(bundle: EventImpactData, at: Date,
  open: (locationId: string, weekday: number, seconds: number) => boolean | null,
): { hourly: HourlyForecast[]; places: PlaceForecast[] } {
  const { day, weekday, hour } = bostonDate(at);
  const dated = bundle.dates[day];
  const basis = `Model-derived projection for ${day} (Boston time), using reference week ${bundle.referenceWeekStart}; ${dated ? 'includes bundled events for this date' : 'weekday baseline only; event coverage unavailable for this date'}. Not live occupancy. Missing or zero model coverage is omitted.`;
  const hourly: HourlyForecast[] = [];
  for (const place of bundle.places) {
    if (!(place.capacity > 0)) continue;
    const counts = dated?.occupancy[place.id] ?? bundle.baseline[String(weekday)]?.[place.id];
    if (!counts) continue;
    const hours = counts.flatMap((count, h) => {
      if (!Number.isFinite(count) || count <= 0 || h > 23) return [];
      const eventAccess = dated?.gatherings.some((g) => g.locationId === place.id && g.startSec < (h + 1) * 3600 && g.endSec > h * 3600);
      const state = open(place.id, weekday, h * 3600);
      if (!eventAccess && (state === false || (['library', 'dining', 'gym'].includes(place.kind) && state !== true))) return [];
      return [{ hour: h, share: count / place.capacity }];
    });
    if (hours.length) hourly.push({ locationId: place.id, day, hours, basis });
  }
  const places = hourly.flatMap((row) => {
    const current = row.hours.find((h) => h.hour === hour);
    return current ? [{ locationId: row.locationId, at: at.toISOString(), share: current.share, basis }] : [];
  });
  return { hourly, places };
}

/** Only in-flight reads are shared. Later reads always ask the server for current projections/state. */
export function createDashboardClient(fetcher: typeof fetch = (...args) => fetch(...args),
  authHeaders?: () => Promise<Record<string, string>>,
) {
  let generation = 0;
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const started = generation;
    const headers: Record<string, string> = { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    if (path !== '/public' && authHeaders) Object.assign(headers, await authHeaders());
    if (started !== generation) throw new Error('Account changed. Please retry.');
    const response = await fetcher(`/api/dashboard${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (path !== '/public' && started !== generation) throw new Error('Account changed. Please retry.');
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch {
      throw new Error(`Dashboard request failed (${response.status}): server returned a non-JSON response.`);
    }
    if (!response.ok) {
      const error = data as { message?: unknown; error?: unknown } | undefined;
      const detail = typeof error?.error === 'string' ? error.error
        : typeof error?.message === 'string' ? error.message
        : typeof error?.error === 'object' && error.error !== null && 'message' in error.error && typeof error.error.message === 'string' ? error.error.message
        : `HTTP ${response.status}`;
      throw new Error(`Dashboard request failed (${response.status}): ${detail}`);
    }
    if (data === undefined && response.status !== 204) throw new Error('Dashboard response was empty.');
    return data as T;
  }
  function share<T>(load: () => Promise<T>) {
    let pending: Promise<T> | undefined;
    return () => {
      if (!pending) {
        pending = load().finally(() => { pending = undefined; });
      }
      return pending;
    };
  }
  const getPublic = share(() => request<DashboardPublic>('/public'));
  let readMe = share(() => request<DashboardMe>('/me'));
  let mutations: Promise<unknown> = Promise.resolve();
  async function getMe(): Promise<DashboardMe> {
    const started = generation;
    const barrier = mutations;
    await barrier;
    if (started !== generation) throw new Error('Account changed. Please retry.');
    if (barrier !== mutations) return getMe();
    return readMe();
  }
  function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    const started = generation;
    const result = mutations.then(() => {
      if (started !== generation) throw new Error('Account changed. Please retry.');
      return request<T>(path, method, body);
    });
    mutations = result.then(() => undefined, () => undefined).then(() => {
      // Detach any pre-mutation read so it cannot supply a subsequent account refresh.
      readMe = share(() => request<DashboardMe>('/me'));
    });
    return result;
  }
  function reset() {
    generation++;
    readMe = share(() => request<DashboardMe>('/me'));
    mutations = Promise.resolve();
  }
  return { request, getPublic, getMe, mutate, reset };
}
