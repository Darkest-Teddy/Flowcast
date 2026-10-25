// The tools only the chat (/api/chat) adds on top of the Ask tools in tools.ts: event impact by
// date, Bluebikes docks, scheduled transit near a place, housing, population aggregates, the
// simulation's validation against published counts, what-if scenarios, weather effects, the
// modeled fire response, the academic calendar, parking, and historical library gate counts.
//
// Same rules as tools.ts: every number comes from the bundled data or the simulation, outputs are
// small and carry no URLs or record ids, and each output says whether it is published, simulated
// or an assumption. Nothing here is about one person: no ride records, no schedules, no scores.

import { tool } from '@openai/agents';
import { z } from 'zod';
import { academicPeriodFor, conditionsFor, temperatureBand, weatherKind, weekdayOf, type DayConditions } from '../../map-client/src/sim/conditions';
import { targetLabel, type BehaviorFile, type Modifier, type ModifierWhen } from '../../map-client/src/sim/behavior';
import { FIRE_RESPONSE_ASSUMPTIONS, planFireResponse } from '../../map-client/src/sim/fireResponse';
import { DISASTER_ASSUMPTIONS } from '../../map-client/src/sim/disasters';
import { formatClock, type CampusLocation } from '../../map-client/src/sim/playback';
import { dateForWeekday, WEEKDAYS } from '../../map-client/src/data/campusData';
import { badTime, clockParam, createTools, dayDate, parseClock, placeParam, resolvePlace, weekdayParam, type MapEntry, type ToolLog } from './tools';
import { clip, dayContext, type ServerAskContext } from './facts';
import type { ChatFacts, Departure } from './chatData';

/** The chat's context: the Ask context plus the event date the page is showing, if any. */
export type ChatContext = ServerAskContext & { date: string | null };

export const WEATHER_CONDITIONS = ['clear', 'partly-cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'heavy-rain', 'snow', 'thunderstorm', 'heatwave'] as const;

/** Day types the validation scores were computed for (behavior.json validation), by a short key. */
export const VALIDATION_DAYS = { weekday: 'Wednesday, classes', saturday: 'Saturday', finals: 'Finals Wednesday', rain: 'Rainy Wednesday' } as const;

/** The published series the validation compares with, by a short key. */
export const VALIDATION_SERIES = {
  fitrec: 'FitRec hourly entries, Oct 17–23 2026',
  library: 'School of Theology Library gate counts, 2019–20 (shape only)',
  dining: 'BU Dining meal counts (BU Today, 2017)',
  bluebikes: 'Bluebikes BU docks, September 2026 Wednesdays',
  crossings2023: 'Warren Towers planning-notice crossing counts, 2023',
  greenB: 'MBTA Fall 2025 rail ridership by hour',
  commAve: 'BU planning-document crosswalk counts (2018, 2012)',
  all: 'Every MBTA and pedestrian series',
} as const;

/** Validation metrics compared with published series, worded as in docs/behavior-validation.md. */
export const VALIDATION_METRICS: Record<string, { label: string; target: string; series: keyof typeof VALIDATION_SERIES }> = {
  'fitrec-hourly-r': { label: 'FitRec entries by hour: correlation', target: 'r → 1', series: 'fitrec' },
  'fitrec-daily-ratio': { label: 'FitRec entries per day: simulated ÷ published', target: '1.0', series: 'fitrec' },
  'fitrec-peak-hour': { label: 'FitRec busiest hour: simulated − published (hours)', target: '0', series: 'fitrec' },
  'library-hourly-r': { label: 'Library entries by hour: correlation', target: 'r → 1', series: 'library' },
  'dining-lunch-ratio': { label: 'Main dining halls, lunches: simulated ÷ published', target: '1.0', series: 'dining' },
  'dining-dinner-ratio': { label: 'Main dining halls, dinners: simulated ÷ published', target: '1.0', series: 'dining' },
  'bluebikes-hourly-r': { label: 'Walk departures vs Bluebikes dock activity by hour: correlation', target: 'r → 1', series: 'bluebikes' },
  'pedestrian-pm-am': { label: 'Walkers 5–6 PM ÷ 8–9 AM, relative to published crossings', target: '1.0', series: 'crossings2023' },
  'obs-bu-b-line-shape': { label: 'Green Line B at BU stops: timing vs counts (r)', target: 'r → 1', series: 'greenB' },
  'obs-bu-b-line-peak': { label: 'Green Line B at BU stops: busiest hour vs counted (hours apart)', target: '0', series: 'greenB' },
  'obs-comm-ave-shape': { label: 'Comm Ave crossings: timing vs counts (r)', target: 'r → 1', series: 'commAve' },
  'obs-comm-ave-peak': { label: 'Comm Ave crossings: busiest hour vs counted (hours apart)', target: '0', series: 'commAve' },
  'obs-everyone-shape': { label: 'Students plus public crowd vs every count: median r', target: 'r → 1', series: 'all' },
  'obs-everyone-ratio': { label: 'Students plus public crowd vs every count: median total ratio', target: '0.85–1.15', series: 'all' },
};

const MAX_LIST = 8;
const dateParam = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe(what);
const pct = (count: number, capacity: number) => (capacity > 0 ? Math.round((count / capacity) * 100) : null);
const round1 = (x: number) => Math.round(x * 10) / 10;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Straight-line metres between two [lng, lat] points. */
export const metres = (a: [number, number], b: [number, number]) => {
  const ky = 111_320, kx = ky * Math.cos((a[1] * Math.PI) / 180);
  return Math.round(Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky));
};
const bostonDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
const bostonClock = (iso: string) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':').map(Number);
  return formatClock(h * 3600 + m * 60);
};
const realDate = (date: string) => !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;

/** Same test as the behaviour engine's (sim/behavior.ts matchesWhen). */
export function modifierApplies(when: ModifierWhen | undefined, c: DayConditions): boolean {
  if (!when) return true;
  if (when.weather && !when.weather.includes(c.weather.kind)) return false;
  if (when.band && !when.band.includes(c.weather.band)) return false;
  if (when.period && !when.period.includes(c.period)) return false;
  if (when.weekday && !when.weekday.includes(c.weekday)) return false;
  if (when.scenario && !when.scenario.includes(c.scenario ?? '')) return false;
  if (when.events !== undefined && when.events !== c.events.length > 0) return false;
  return true;
}

/** A modifier as a short row: label, provenance kind, note, and up to four effects in words. */
function describeModifier(m: Modifier, file: unknown) {
  const op = (o: string, v: number) => (o === 'mul' ? `× ${Math.round(v * 100) / 100}` : o === 'add' ? `${v >= 0 ? '+' : ''}${v}` : `set to ${v}`);
  return {
    label: m.label,
    kind: m.provenance.kind === 'fitted' ? 'fitted to published data' : m.provenance.kind,
    note: clip(m.provenance.note, 160),
    effects: m.effects.slice(0, 4).map((e) => `${targetLabel(e.target, file as BehaviorFile | undefined)} ${op(e.op, e.value)}`),
    ...(m.effects.length > 4 ? { moreEffects: m.effects.length - 4 } : {}),
  };
}

export function createChatTools(ctx: ChatContext, log: ToolLog) {
  const base = createTools(ctx, log);
  const chat: ChatFacts | undefined = ctx.facts?.chat;
  const byId = new Map(ctx.locations.map((l) => [l.id, l]));
  const called = (name: string) => log.calls.push(name);
  const result = <T extends object>(value: T, map?: MapEntry): T => {
    log.outputs.push(JSON.stringify(value));
    log.results.push({ tool: log.calls[log.calls.length - 1] ?? '', value });
    if (map && !('error' in value) && !('available' in value)) log.map.push(map);
    return value;
  };
  const noData = (what: string) => result({ error: `${what} is not available on this server.` });
  const select = (name: string, loc: CampusLocation): MapEntry => ({ tool: name, show: { route: null, select: loc.id, points: [loc.position] }, rows: [] });
  const placeName = (id: string) => byId.get(id)?.name ?? chat?.eventImpact?.places.find((p) => p.id === id)?.name ?? id;

  const eventImpact = tool({
    name: 'event_impact',
    description:
      'How published campus events change simulated crowding on a date: the simulated events (place, time, simulated attendees capped by seats), the places that change most, ' +
      'and for one place an hourly table of normal day vs with events (% of capacity). Also lists big-venue games and concerts that date from published schedules (their crowds are not in this comparison). ' +
      'With date null and no event date in view, lists the dates that have simulated events. Simulated attendance is an assumption; registrations are never attendance.',
    parameters: z.object({
      date: dateParam('YYYY-MM-DD, or null for the event date in view (or a list of dates).'),
      place: z.string().max(80).nullable().describe('Place to chart, or null for the busiest event venue.'),
    }),
    execute: ({ date, place }) => {
      called('event_impact');
      const ei = chat?.eventImpact;
      if (!ei) return noData('Event impact');
      const d = date ?? ctx.date;
      const dates = Object.keys(ei.dates).sort();
      if (!d) {
        const upcoming = dates.filter((x) => x >= ei.referenceWeekStart).slice(0, 10);
        return result({
          kind: 'simulated',
          datesWithSimulatedEvents: upcoming.map((x) => ({ date: x, day: WEEKDAYS[weekdayOf(x)], events: ei.dates[x].gatherings.length })),
          ...(dates.length > upcoming.length ? { moreDates: dates.length - upcoming.length } : {}),
          note: 'Ask about one date to compare its crowding with a normal day.',
        });
      }
      if (!realDate(d)) return result({ error: `"${d}" is not a calendar date.` });
      const weekday = weekdayOf(d);
      const venueEvents = (chat?.venues?.events ?? []).filter((e) => bostonDate(e.start) === d).slice(0, 5).map((e) => {
        const venue = chat?.venues?.venues.find((v) => v.id === e.venueId);
        const seats = venue && e.setup ? venue.capacities[e.setup] ?? null : null;
        return { name: clip(e.name, 60), venue: venue?.name ?? e.venueId, start: bostonClock(e.start), kind: e.kind, ...(seats ? { publishedSeats: seats } : {}), ...(e.attendance !== null ? { publishedAttendance: e.attendance } : {}) };
      });
      const entry = ei.dates[d];
      if (!entry) {
        return result({
          kind: 'simulated', date: d, day: WEEKDAYS[weekday], simulatedCampusEvents: 0,
          note: `No published campus event with a mapped place and time is simulated on ${d}; crowding is a normal ${WEEKDAYS[weekday]}.`,
          venueEvents,
        });
      }
      const baseline = ei.baseline[String(entry.weekday)] ?? {};
      const places = new Map(ei.places.map((p) => [p.id, p]));
      const zero = Array(24).fill(0);
      const changes = Object.entries(entry.occupancy).map(([id, after]) => {
        const before = baseline[id] ?? zero;
        let diff = 0, at = 0;
        for (let h = 0; h < 24; h++) if (Math.abs((after[h] ?? 0) - (before[h] ?? 0)) > Math.abs(diff)) { diff = (after[h] ?? 0) - (before[h] ?? 0); at = h; }
        const cap = places.get(id)?.capacity ?? 0;
        return { id, diff, at, normalPeak: pct(Math.max(...before), cap), eventsPeak: pct(Math.max(...after), cap) };
      }).filter((c) => Math.round(c.diff) !== 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const gatherings = [...entry.gatherings].sort((a, b) => a.startSec - b.startSec);
      let focusId: string | undefined;
      if (place) {
        const p = resolvePlace(place, ctx);
        if ('error' in p) return result({ error: p.error });
        focusId = p.location.id;
      } else focusId = [...gatherings].sort((a, b) => b.attendees - a.attendees)[0]?.locationId ?? changes[0]?.id;
      const focus = focusId ? places.get(focusId) : undefined;
      const hours = Array.from({ length: 17 }, (_, i) => i + 7); // 7 AM–11 PM
      const focusRows = focus
        ? hours.map((h) => {
            const before = baseline[focus.id]?.[h] ?? 0, after = entry.occupancy[focus.id]?.[h] ?? before;
            return focus.capacity > 0 ? [h, pct(before, focus.capacity), pct(after, focus.capacity)] : [h, Math.round(before), Math.round(after)];
          })
        : [];
      const loc = focus ? byId.get(focus.id) : undefined;
      return result({
        kind: 'simulated',
        date: d, day: WEEKDAYS[weekday],
        projectedOntoReferenceWeek: entry.projected,
        measure: 'Hourly mean simulated head count; percent is of stated capacity. Not measured attendance.',
        attendanceRule: `${Math.round(ei.attendanceProbability * 100)}% of students free for the whole event, on that campus and able to walk there and back, are assumed to attend, capped by the room's seats.`,
        simulatedEvents: gatherings.slice(0, 6).map((g) => ({
          name: clip(g.name, 60), place: placeName(g.locationId), ...(g.roomCode ? { room: g.roomCode } : {}),
          start: formatClock(g.startSec), end: formatClock(g.endSec), ...(g.endEstimated ? { endEstimated: true } : {}),
          simulatedAttendees: g.attendees, seatLimit: g.capacity,
        })),
        ...(gatherings.length > 6 ? { moreEvents: gatherings.length - 6 } : {}),
        biggestChanges: changes.slice(0, 5).map((c) => ({ place: placeName(c.id), change: Math.round(c.diff), at: formatClock(c.at * 3600), normalPeakPercent: c.normalPeak, withEventsPeakPercent: c.eventsPeak })),
        ...(focus ? {
          focus: {
            place: focus.name, capacity: focus.capacity,
            hours: { columns: focus.capacity > 0 ? ['hour', 'normalPercent', 'withEventsPercent'] : ['hour', 'normalStudents', 'withEventsStudents'], rows: focusRows },
          },
        } : {}),
        venueEvents,
        note: 'Comparison with the same weekday without events, from the event-impact simulation build. Big-venue games and concerts are published schedules; their crowds are not part of this comparison.',
      }, loc ? select('event_impact', loc) : undefined);
    },
  });

  const bluebikes = tool({
    name: 'bluebikes',
    description:
      'Bluebikes docks near BU from the published trip history: dock count (capacity), average rides docked (arrivals) and undocked (departures) on a typical profiled weekday, busiest hour, ' +
      'and an hourly table for the nearest dock (or all BU-area docks). Published averages, not live and not today; individual rides are never shared.',
    parameters: z.object({ near: z.string().max(80).nullable().describe('Place name, id or course code to find docks near, or null for every BU-area dock.') }),
    execute: ({ near }) => {
      called('bluebikes');
      const bikes = chat?.bikes;
      if (!bikes?.docks.length) return noData('Bluebikes data');
      const from = near ? resolvePlace(near, ctx) : null;
      if (from && 'error' in from) return result({ error: from.error });
      const busiest = (a: number[], b: number[]) => { let best = 0; for (let h = 0; h < 24; h++) if (a[h] + b[h] > a[best] + b[best]) best = h; return formatClock(best * 3600); };
      let docks = bikes.docks.map((d) => ({ d, m: from ? metres(from.location.position, d.position) : null }));
      if (from) {
        docks.sort((a, b) => a.m! - b.m!);
        const close = docks.filter((x) => x.m! <= 800);
        docks = (close.length ? close : docks).slice(0, 4);
      } else docks.sort((a, b) => sum(b.d.arrivals) + sum(b.d.departures) - sum(a.d.arrivals) - sum(a.d.departures));
      const focusArr = from ? docks[0].d.arrivals : Array.from({ length: 24 }, (_, h) => sum(bikes.docks.map((d) => d.arrivals[h])));
      const focusDep = from ? docks[0].d.departures : Array.from({ length: 24 }, (_, h) => sum(bikes.docks.map((d) => d.departures[h])));
      const perDay = Object.values(bikes.ridesPerDay);
      return result({
        kind: 'published count',
        source: 'Bluebikes System Data (trip history)',
        period: `${bikes.weekday}s in ${bikes.month} (${bikes.profileDates.length} days averaged)`,
        sameWeekdayAsAsked: WEEKDAYS[ctx.weekday] === bikes.weekday,
        ...(from ? { from: from.label } : {}),
        ridesPerDayAtBuDocks: perDay.length ? Math.round(sum(perDay) / perDay.length) : null,
        docks: docks.slice(0, 8).map(({ d, m }) => ({
          name: d.name, campus: d.campus, docks: d.capacity, ...(m !== null ? { metresStraightLine: m } : {}),
          typicalDay: { arrivals: Math.round(sum(d.arrivals)), departures: Math.round(sum(d.departures)) }, busiestHour: busiest(d.arrivals, d.departures),
        })),
        ...(!from && docks.length > 8 ? { moreDocks: docks.length - 8 } : {}),
        hourly: {
          of: from ? docks[0].d.name : 'all BU-area docks',
          table: { columns: ['hour', 'arrivals', 'departures'], rows: Array.from({ length: 18 }, (_, i) => i + 6).map((h) => [h, round1(focusArr[h]), round1(focusDep[h])]) },
        },
        method: 'Average rides per hour on the profiled weekday; not live dock status and not today.',
      }, from ? select('bluebikes', from.location) : undefined);
    },
  });

  const transitNear = tool({
    name: 'transit_near',
    description:
      'Scheduled MBTA (Green Line, buses) and BU Shuttle departures from stops near a place in the hour after a time, from the published timetables: stop, route, direction, departures in that hour and the next times. ' +
      'Scheduled service, not live arrivals. Distances are straight-line.',
    parameters: z.object({
      place: placeParam,
      weekday: weekdayParam,
      time: clockParam('HH:MM, 24-hour, or null for the time shown.'),
      mode: z.enum(['all', 'mbta', 'shuttle']).nullable().describe('Which service, or null for all.'),
    }),
    execute: ({ place, weekday, time, mode }) => {
      called('transit_near');
      const transit = chat?.transit;
      if (!transit) return noData('Transit schedules');
      const at = parseClock(time, ctx.time);
      if (at === null) return result(badTime(time));
      const w = weekday ?? ctx.weekday;
      const date = ctx.date && (weekday == null || weekdayOf(ctx.date) === w)
        ? ctx.date : dayDate(ctx, w).date;
      if (!date || transit.dates[w] !== date) return result({
        kind: 'unavailable', date, availableDates: transit.dates,
        note: 'No collected timetable for this date. A matching weekday is not date-specific service evidence.',
      });
      const p = resolvePlace(place, ctx);
      if ('error' in p) return result({ error: p.error });
      const want = (kind: string) => !mode || mode === 'all' || (mode === 'shuttle' ? kind === 'shuttle' : kind !== 'shuttle');
      const end = at + 3600;
      const inWindow = (stop: string): Departure[] => {
        const days = transit.departures.get(stop) ?? Array.from({ length: 7 }, () => []);
        // Today's departures, plus the previous service day's ones past midnight.
        const prev = (w === 0 ? transit.priorDepartures.get(stop) ?? [] : days[w - 1]).filter(([t]) => t >= 86400).map(([t, r, d]): Departure => [t - 86400, r, d]);
        return [...prev, ...days[w]].filter(([t]) => t >= at && t < end).sort((a, b) => a[0] - b[0]);
      };
      // Stops with the same name and kind (the two sides of a street) are one stop here.
      const near = new Map<string, { name: string; kind: string; m: number; ids: string[] }>();
      for (const s of transit.stops) {
        if (!want(s.kind)) continue;
        const m = metres(p.location.position, s.position);
        if (m > 500) continue;
        const key = `${s.kind}:${s.name}`;
        const g = near.get(key);
        if (g) { g.ids.push(s.id); g.m = Math.min(g.m, m); } else near.set(key, { name: s.name, kind: s.kind, m, ids: [s.id] });
      }
      const withService: object[] = [];
      const quiet: string[] = [];
      for (const { name, kind, m, ids } of [...near.values()].sort((a, b) => a.m - b.m)) {
        const deps = ids.flatMap(inWindow).sort((a, b) => a[0] - b[0]);
        if (!deps.length) { if (quiet.length < 4) quiet.push(name); continue; }
        if (withService.length >= 5) continue;
        const groups = new Map<string, Departure[]>();
        for (const dep of deps) groups.set(`${dep[1]}:${dep[2]}`, [...(groups.get(`${dep[1]}:${dep[2]}`) ?? []), dep]);
        withService.push({
          stop: name, kind, metresStraightLine: m,
          routes: [...groups.values()].slice(0, 4).map((g) => {
            const r = transit.routes[g[0][1]];
            return { route: r.name, operator: r.operator === 'mbta' ? 'MBTA' : 'BU Shuttle', toward: r.directions?.[g[0][2]] ?? null, departuresInHour: g.length, next: g.slice(0, 3).map(([t]) => formatClock(t)) };
          }),
        });
      }
      const shuttleShown = withService.some((x) => (x as { kind: string }).kind === 'shuttle');
      return result({
        kind: 'published schedule',
        from: p.label, day: WEEKDAYS[w], date, window: `${formatClock(at)} to ${formatClock(end)}`,
        stops: withService,
        ...(quiet.length ? { stopsWithNoDepartureInWindow: quiet } : {}),
        ...(near.size === 0 ? { note: 'No mapped stop is within 500 m of this place.' } : {}),
        timetables: `MBTA GTFS (${clip(transit.mbtaFeed, 60)})${shuttleShown ? `; BU Shuttle (${clip(transit.shuttleFeed, 60)})` : ''}`,
        method: 'Scheduled departures, not live arrivals or crowding. Distances are straight-line. BU Shuttle historical baseline excluded unless feed coverage matches this week.',
      }, select('transit_near', p.location));
    },
  });

  const housing = tool({
    name: 'housing',
    description:
      'Residence halls and their bed counts with each figure’s basis (published, planning document or low-confidence estimate), the published resident share and estimated undergraduate residents, ' +
      'and published availability notes such as the Warren Towers renovation. With a residence: that hall’s beds, basis and simulated students there at the time. Beds are capacity, not occupied beds.',
    parameters: z.object({ residence: z.string().max(80).nullable().describe('A residence name or id, or null for all.'), time: clockParam('HH:MM, 24-hour, or null for the time shown.') }),
    execute: ({ residence, time }) => {
      called('housing');
      const pop = chat?.population;
      if (!pop || !ctx.facts) return noData('Housing data');
      const at = parseClock(time, ctx.time);
      if (at === null) return result(badTime(time));
      const basisOf = (id: string) => ctx.facts!.basis[id];
      const describe = (l: CampusLocation) => {
        const b = basisOf(l.id);
        return { name: l.name, campus: l.campus ?? 'charles-river', beds: l.capacity, basis: (b?.basis ?? l.capacityBasis ?? 'unknown').replace(/_/g, ' '), ...(b?.confidence ? { confidence: b.confidence } : {}) };
      };
      const dorms = ctx.locations.filter((l) => l.kind === 'dorm').sort((a, b) => b.capacity - a.capacity);
      let detail: object | undefined;
      let loc: CampusLocation | undefined;
      if (residence) {
        const r = resolvePlace(residence, ctx);
        if ('error' in r) return result({ error: r.error });
        if (r.location.kind !== 'dorm') return result({ error: `${r.location.name} is not a mapped residence. Call housing with residence null for the list.` });
        loc = r.location;
        const occ = ctx.occupancyAt(at).find((o) => o.location.id === loc!.id);
        detail = {
          ...describe(loc),
          ...(basisOf(loc.id)?.note ? { basisNote: basisOf(loc.id)!.note } : {}),
          ...(loc.estimatedHousingProfile ? { estimatedOccupancyRate: loc.estimatedHousingProfile.occupancyRate, estimateConfidence: 'low' } : {}),
          simulatedStudentsThere: { time: formatClock(at), day: WEEKDAYS[ctx.weekday], students: occ?.count ?? 0, kind: 'simulated' },
        };
      }
      return result({
        kind: 'published and estimated',
        ...(detail ? { residence: detail } : {}),
        totals: {
          residenceBeds: pop.housing.residenceCapacity,
          undergraduateResidentPercent: pop.housing.degreeSeekingUndergraduateResidentPercent,
          estimatedUndergraduateResidents: pop.housing.estimatedUndergraduateResidents,
          estimateBasis: clip(pop.housing.estimateBasis, 140),
        },
        ...(detail ? {} : { residences: dorms.slice(0, 10).map(describe), ...(dorms.length > 10 ? { moreResidences: dorms.length - 10 } : {}) }),
        availability: (pop.residentialAvailability ?? []).slice(0, 3).map((a) => ({
          residence: a.displayName, bedsCounted: a.value,
          components: (a.components ?? []).map((c) => ({ name: c.name, status: c.status.replace(/_/g, ' '), ...(c.relocatedStudents ? { relocatedStudents: c.relocatedStudents } : {}) })),
          note: clip(a.note, 260),
        })),
        relocations: (pop.campusResidentMinimums ?? []).slice(0, 3).map((r) => ({ campus: r.campus, students: r.students, note: clip(r.note, 160) })),
        method: 'Beds are capacity, not occupied beds. The resident count is estimated from a rounded published percentage.',
      }, loc ? select('housing', loc) : undefined);
    },
  });

  const populationSummary = tool({
    name: 'population_summary',
    description: 'Published BU population aggregates: students by level and attendance (Common Data Set census), employees by campus and campus student FTE (fact sheet), with their periods and limits. Aggregates only, nobody individual.',
    parameters: z.object({}),
    execute: () => {
      called('population_summary');
      const pop = chat?.population;
      if (!pop) return noData('Population data');
      return result({
        kind: 'published',
        students: { total: pop.students.total, undergraduate: pop.students.undergraduate, graduate: pop.students.graduate, period: pop.students.reportingPeriod },
        cohorts: pop.students.cohorts.map((c) => ({ level: c.level, attendance: c.attendance, headcount: c.headcount })),
        employees: { total: pop.employees.total, charlesRiver: pop.employees.charlesRiver, medical: pop.employees.medical, period: pop.employees.reportingPeriod, scope: clip(pop.employees.scope, 100) },
        campusStudentFte: { charlesRiver: pop.campusStudentFte.charlesRiver, medical: pop.campusStudentFte.medical, period: pop.campusStudentFte.reportingPeriod, note: 'Full-time equivalents measure enrollment intensity, not people.' },
        simulatedStudents: ctx.facts?.populationSummary.total ?? null,
        limits: pop.limitations.slice(0, 3).map((l) => clip(l, 160)),
      });
    },
  });

  const modelValidation = tool({
    name: 'model_validation',
    description:
      'How the simulation compares with published counts (FitRec entries, library gate counts, dining meal counts, Bluebikes, MBTA ridership, crosswalk counts): precomputed scores per day type ' +
      'with the target for each. Correlations near 1 and ratios near 1 mean the simulated timing or volume is close to the published series. Several of these series were also used to tune the model.',
    parameters: z.object({ day: z.enum(Object.keys(VALIDATION_DAYS) as [keyof typeof VALIDATION_DAYS]).nullable().describe('weekday (a Wednesday with classes, default), saturday, finals or rain.') }),
    execute: ({ day }) => {
      called('model_validation');
      const v = chat?.validation;
      if (!v) return noData('Validation scores');
      const prefix = VALIDATION_DAYS[day ?? 'weekday'];
      const rows = v.metrics.filter((m) => m.day.startsWith(prefix) && VALIDATION_METRICS[m.id]);
      const dayLabel = rows[0]?.day ?? prefix;
      return result({
        kind: 'simulated compared with published',
        day: dayLabel,
        computed: v.generated,
        scores: rows.slice(0, 14).map((m) => ({ metric: VALIDATION_METRICS[m.id].label, target: VALIDATION_METRICS[m.id].target, simulated: Math.round(m.value * 100) / 100, against: VALIDATION_METRICS[m.id].series })),
        publishedSeries: Object.fromEntries([...new Set(rows.map((m) => VALIDATION_METRICS[m.id].series))].map((k) => [k, VALIDATION_SERIES[k]])),
        ...(rows.length === 0 ? { note: 'No comparison with published counts was computed for this day type.' } : {}),
        observationSeries: { transit: v.transitSeries, pedestrian: v.pedestrianSeries },
        method: 'Scores from the calibration script on a sampled roster. Several series were also used to tune the model, so a close score shows fit, not independent confirmation.',
      });
    },
  });

  const scenarios = tool({
    name: 'what_if_scenarios',
    description:
      'The map’s what-if scenario presets (rainy exam week, snow day, heatwave, home hockey game, move-in day…): what each one changes (date, academic period, weather, events) and which behaviour assumptions it switches on. ' +
      'Their effect on crowd numbers is not precomputed; say they can be played on the map.',
    parameters: z.object({ scenario: z.string().max(40).nullable().describe('Scenario id or name, or null to list them.') }),
    execute: ({ scenario }) => {
      called('what_if_scenarios');
      const list = chat?.scenarios ?? [];
      if (!list.length) return noData('Scenarios');
      if (!scenario) return result({ kind: 'assumption', scenarios: list.map((s) => ({ id: s.id, label: s.label, description: clip(s.description, 140) })) });
      const q = scenario.toLowerCase();
      const s = list.find((x) => x.id === q || x.label.toLowerCase() === q) ?? list.find((x) => x.id.includes(q) || x.label.toLowerCase().includes(q));
      if (!s) return result({ error: `No scenario matches "${scenario}". Available: ${list.map((x) => x.id).join(', ')}.` });
      const o = s.overrides;
      if (!o.date && !ctx.data) return noData('Scenario dates');
      const date = o.date ?? dateForWeekday(ctx.data!, o.weekday ?? ctx.weekday);
      const conditions = conditionsFor({ date, weekday: o.weekday, calendar: chat?.calendar, weather: o.weather, period: o.period, periodLabel: o.periodLabel, events: o.events, scenario: s.id });
      const applied = (chat?.modifiers ?? []).filter((m) => m.group === 'conditions' && modifierApplies(m.when, conditions));
      return result({
        kind: 'assumption',
        id: s.id, label: s.label, description: clip(s.description, 160),
        date, day: WEEKDAYS[conditions.weekday], period: conditions.periodLabel,
        weather: o.weather ? { condition: o.weather.condition, temperatureF: o.weather.temperatureF ?? null } : null,
        events: (o.events ?? []).map((e) => ({ label: e.label, place: placeName(e.locationId), start: formatClock(e.start), end: formatClock(e.end), expectedStudents: e.expectedStudents, seats: e.capacity, basis: e.provenance?.kind ?? 'assumption', note: clip(e.provenance?.note, 160) })),
        ...(s.provenance ? { scenarioNote: clip(s.provenance.note, 160) } : {}),
        behaviourChanges: applied.slice(0, 6).map((m) => describeModifier(m, chat?.behaviorFile)),
        method: 'A scenario changes students’ timelines through these assumptions, never counts or capacities directly. Its crowd numbers are not precomputed here; it can be played on the map.',
      });
    },
  });

  const weatherEffects = tool({
    name: 'weather_effects',
    description: 'How the simulation changes student behaviour for a weather condition and temperature: which behaviour assumptions switch on (longer library stays in rain, slower walking in snow…) with their sizes. Assumptions, not observed behaviour.',
    parameters: z.object({ condition: z.enum(WEATHER_CONDITIONS), temperatureF: z.number().int().min(-20).max(120).nullable().describe('°F, or null for a mild day.') }),
    execute: ({ condition, temperatureF }) => {
      called('weather_effects');
      const mods = chat?.modifiers ?? [];
      if (!mods.length) return noData('Behaviour assumptions');
      const kind = weatherKind(condition, temperatureF);
      const band = temperatureBand(temperatureF);
      // Weather-only modifiers: those keyed on the academic period, a scenario or a weekday are left out.
      const applied = mods.filter((m) => m.group === 'conditions' && (m.when?.weather || m.when?.band) && !m.when.period && !m.when.scenario && !m.when.weekday
        && (!m.when.weather || m.when.weather.includes(kind)) && (!m.when.band || m.when.band.includes(band)));
      return result({
        kind: 'assumption',
        condition, temperatureF, weatherFamily: kind, temperatureBand: band,
        behaviourChanges: applied.slice(0, 6).map((m) => describeModifier(m, chat?.behaviorFile)),
        ...(applied.length === 0 ? { note: 'No weather assumption changes behaviour for this weather; it simulates as an ordinary day.' } : {}),
        method: 'Weather changes simulated students’ trips and visit lengths, never counts or capacities directly. Sizes are assumptions.',
      });
    },
  });

  const emergency = tool({
    name: 'emergency_info',
    description:
      'Emergency what-ifs. With a building: the modeled Boston Fire Department first-alarm response (which companies, from which firehouse, modeled minutes to arrive) and simulated students inside at the time. ' +
      'With place null: the incident scenarios the map can run (drill, alarm, closure, fire, earthquake, meteor) and what each does. Uncalibrated model assumptions, not BFD response data or a safety assessment.',
    parameters: z.object({ place: z.string().max(80).nullable().describe('Building name, id or course code, or null for the list of scenarios.'), time: clockParam('HH:MM, 24-hour, or null for the time shown.') }),
    execute: ({ place, time }) => {
      called('emergency_info');
      const at = parseClock(time, ctx.time);
      if (at === null) return result(badTime(time));
      const quake = DISASTER_ASSUMPTIONS.earthquake, meteor = DISASTER_ASSUMPTIONS.meteor;
      if (!place) {
        return result({
          kind: 'assumption',
          scenarios: [
            { kind: 'fire drill', does: 'Occupants leave, gather at a modeled assembly point and go back in.' },
            { kind: 'fire alarm', does: 'Occupants leave and Boston Fire Department companies are driven to the building on mapped streets.' },
            { kind: 'building closure', does: 'Visits are interrupted, delayed or moved to another open place until the building reopens.' },
            { kind: 'fire', does: 'The building closes for the rest of the day; occupants react faster than in a drill.' },
            { kind: 'earthquake', does: `Buildings within ${quake.defaultRadiusMetres} m (default) close after people shelter for ${quake.responseDelaySeconds} s.` },
            { kind: 'meteor', does: `Buildings within ${meteor.defaultRadiusMetres} m (default) close.` },
          ],
          firehouses: chat?.fire?.stations.length ?? 0,
          method: 'Illustrative, uncalibrated what-ifs run on the map’s Incidents tab; not an evacuation or structural assessment.',
        });
      }
      const p = resolvePlace(place, ctx);
      if ('error' in p) return result({ error: p.error });
      const fire = chat?.fire;
      if (!fire) return noData('The fire response network');
      const loc = p.location;
      const plan = planFireResponse(fire, { id: `chat:${loc.id}`, start: at, endsAt: at + 1800, targetName: loc.name, position: loc.position });
      const day = dayContext(ctx, null);
      const occ = 'available' in day ? null : day.ctx.occupancyAt(at).find((o) => o.location.id === loc.id);
      const A = FIRE_RESPONSE_ASSUMPTIONS;
      return result({
        kind: 'simulated from assumptions',
        building: loc.name, ...dayDate(ctx, ctx.weekday), alarmAt: formatClock(at),
        firstAlarm: plan.units.map((u) => ({ unit: u.label, kind: u.kind, from: u.station.name, modeledMinutesToArrive: round1(u.eta / 60) })),
        firstOnSceneMinutes: plan.units.length ? round1(Math.min(...plan.units.map((u) => u.eta)) / 60) : null,
        simulatedStudentsInside: occ ? { students: occ.count, modeled: occ.modeled !== false } : null,
        assumptions: `First alarm of ${A.assignment.engine} engines, ${A.assignment.ladder} ladders and a district chief; turnout ${A.turnoutMinSeconds}–${A.turnoutMaxSeconds} s; about 30–50 km/h on main roads; nearest companies by modeled drive time.`,
        limits: 'Ignores traffic, units already busy and mutual aid. Uncalibrated: not Boston Fire Department response data.',
      }, select('emergency_info', loc));
    },
  });

  const calendar = tool({
    name: 'academic_calendar',
    description: 'What BU’s published semester calendar says about a date: classes in session, a holiday, a recess, study period or final exams, with the term’s class dates and the next breaks.',
    parameters: z.object({ date: dateParam('YYYY-MM-DD, or null for the date in view (the reference-week date of the shown weekday).') }),
    execute: ({ date }) => {
      called('academic_calendar');
      const cal = chat?.calendar;
      if (!cal || !ctx.data) return noData('The academic calendar');
      const d = date ?? ctx.date ?? dateForWeekday(ctx.data, ctx.weekday);
      if (!realDate(d)) return result({ error: `"${d}" is not a calendar date.` });
      const { period, label } = academicPeriodFor(d, cal);
      const term = cal.terms.find((t) => d >= t.classesStart && d <= t.classesEnd) ?? cal.terms.find((t) => d < t.classesStart) ?? cal.terms.at(-1);
      return result({
        kind: 'published',
        date: d, day: WEEKDAYS[weekdayOf(d)], period, label,
        ...(term ? {
          term: term.term, classesStart: term.classesStart, classesEnd: term.classesEnd,
          next: term.events.filter((e) => e.end >= d && e.kind !== 'classes').sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4).map((e) => ({ label: clip(e.label, 60), kind: e.kind, start: e.start, end: e.end })),
        } : {}),
      });
    },
  });

  const parking = tool({
    name: 'parking_lots',
    description: 'Parking lots and garages near a place or across BU: kind, operator, spaces and the basis of that figure (published, OpenStreetMap tag or estimate), and whether events use it. Occupancy is not observed.',
    parameters: z.object({ near: z.string().max(80).nullable().describe('Place name, id or course code, or null for all.'), buOnly: z.boolean().nullable().describe('True for BU-operated lots only.') }),
    execute: ({ near, buOnly }) => {
      called('parking_lots');
      const lots = (chat?.parking ?? []).filter((l) => !buOnly || l.bu);
      if (!lots.length) return noData('Parking data');
      const from = near ? resolvePlace(near, ctx) : null;
      if (from && 'error' in from) return result({ error: from.error });
      const rows = lots.map((l) => ({ l, m: from ? metres(from.location.position, l.position) : null }))
        .sort((a, b) => (from ? a.m! - b.m! : (b.l.capacity ?? 0) - (a.l.capacity ?? 0)));
      return result({
        kind: 'published and estimated',
        ...(from ? { from: from.label } : {}),
        lots: rows.slice(0, MAX_LIST).map(({ l, m }) => ({
          name: l.name, kind: l.kind, operator: l.operator, bu: l.bu, spaces: l.capacity, spacesBasis: l.capacityBasis, eventParking: l.eventParking, ...(m !== null ? { metresStraightLine: m } : {}),
        })),
        ...(rows.length > MAX_LIST ? { more: rows.length - MAX_LIST } : {}),
        method: 'Spaces are capacity (published, an OpenStreetMap tag, or an estimate), not how full a lot is.',
      }, from ? select('parking_lots', from.location) : undefined);
    },
  });

  const libraryCounts = tool({
    name: 'library_gate_counts',
    description: 'Historical patron counts by time of day at the School of Theology Library (BU’s only published library count series, 2019–20; counting method unknown). Published counts from their own period, not today and not simulated.',
    parameters: z.object({ weekday: z.number().int().min(0).max(6).nullable().describe('0 = Monday … 6 = Sunday, or null for the day shown.') }),
    execute: ({ weekday }) => {
      called('library_gate_counts');
      const lh = chat?.libraryHistory;
      if (!lh?.patronCounts.length) return noData('Library gate counts');
      const w = weekday ?? ctx.weekday;
      const rows = lh.patronCounts.filter((c) => c.weekday === w).sort((a, b) => a.timeLocal.localeCompare(b.timeLocal));
      const best = rows.reduce<(typeof rows)[number] | null>((a, b) => (!a || b.value > a.value ? b : a), null);
      const toSec = (t: string) => Number(t.slice(0, 2)) * 3600 + Number(t.slice(3, 5)) * 60;
      return result({
        kind: 'published count',
        library: lh.name, period: lh.observationPeriod, day: WEEKDAYS[w],
        counts: { columns: ['time', 'patrons'], rows: rows.map((r) => [formatClock(toSec(r.timeLocal)), r.value]) },
        ...(rows.length === 0 ? { note: `No counts were published for ${WEEKDAYS[w]}s.` } : {}),
        busiest: best ? { time: formatClock(toSec(best.timeLocal)), patrons: best.value } : null,
        method: clip(lh.countingMethod, 140),
      });
    },
  });

  return [...base, eventImpact, bluebikes, transitNear, housing, populationSummary, modelValidation, scenarios, weatherEffects, emergency, calendar, parking, libraryCounts];
}

export const CHAT_TOOL_NAMES = ['event_impact', 'bluebikes', 'transit_near', 'housing', 'population_summary', 'model_validation', 'what_if_scenarios', 'weather_effects', 'emergency_info', 'academic_calendar', 'parking_lots', 'library_gate_counts'] as const;
