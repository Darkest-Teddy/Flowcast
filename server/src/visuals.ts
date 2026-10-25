// Charts, tables and stats for a chat answer, built here from the tool results of the turn, never
// from the model's text. Also the answer's follow-up questions (from which tools ran, worded from
// tool output only) and its map link (only the map's existing URL parameters: at, speed, date,
// events, ask).

import type { BarVisual, LineVisual, StatsVisual, TableVisual, Visual } from '../../map-client/src/chatContract';
import { dateForWeekday, WEEKDAYS, type CampusData } from '../../map-client/src/data/campusData';

export const MAX_VISUALS = 4;
type Result = { tool: string; value: object };
type Out = Record<string, any>;

/** 13 → "1 PM", 0 → "12 AM". */
export const hourLabel = (h: number) => `${h % 12 || 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
const n = (x: number) => x.toLocaleString('en-US');
const intOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null);

/** "12:30 PM" → "12:30"; "9:05 AM" → "09:05". Null for anything else. */
export function clock24(text: unknown): string | null {
  const m = typeof text === 'string' ? text.match(/^(\d{1,2}):(\d{2}) (AM|PM)/) : null;
  if (!m) return null;
  const h = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** One visual per tool result that suits one, with a key for de-duplication. */
function visualFor(r: Result, index: number): { key: string; visual: Visual } | null {
  const o = r.value as Out;
  if ('error' in o || 'available' in o || 'ambiguous' in o) return null;
  const id = `v${index + 1}`;
  switch (r.tool) {
    case 'place_day': {
      const rows: any[][] = o.hours?.rows ?? [];
      if (rows.length < 2) return null;
      const anyPercent = rows.some((x) => typeof x[2] === 'number');
      const col = anyPercent ? 2 : 3;
      if (!anyPercent && !o.modeled) return null;
      // Closed hours carry no value: closed is not quiet.
      const values = rows.map((x) => (x[1] === 0 ? null : intOrNull(x[col])));
      const nowHour = Number(clock24(o.now?.time)?.slice(0, 2));
      const marker = rows.findIndex((x) => x[0] === nowHour);
      const v: LineVisual = {
        id, kind: 'line', title: `${o.place}, ${o.day}`, source: 'simulated',
        note: anyPercent ? 'Simulated students over stated capacity; gaps are closed or not modeled' : 'Simulated students; capacity isn’t comparable as a percentage',
        unit: anyPercent ? '% full' : 'students', x: rows.map((x) => hourLabel(x[0])), series: [{ name: 'Simulated', values }],
        marker: marker >= 0 ? { index: marker, label: o.now.time } : null,
      };
      return { key: `place_day:${o.place}:${o.day}`, visual: v };
    }
    case 'rank_places_by_crowd': {
      const places: Out[] = o.places ?? [];
      // hoursNotInData lists the places without percents or students: there is no ranking to draw.
      if (!places.length || o.hoursNotInData) return null;
      const detail = (p: Out) => (p.open === false ? 'Closed' : p.open === null && p.percent === null ? 'Hours not published'
        : !p.modeled ? 'Not modeled this day' : p.percent === null ? `${n(p.students)} students, capacity not comparable`
        : `${n(p.students)} students${typeof p.walkMinutes === 'number' ? ` · ${p.walkMinutes} min walk` : ''}`);
      const v: BarVisual = {
        id, kind: 'bar', title: `${o.mostCrowded !== undefined ? 'Most' : 'Least'} crowded at ${o.time}, ${o.day}`, source: 'simulated',
        note: 'Simulated students over stated capacity', unit: '% full',
        bars: places.slice(0, 12).map((p) => ({ label: p.name, value: intOrNull(p.percent), level: p.level ?? null, detail: detail(p) })),
      };
      return { key: `rank:${o.day}:${o.time}:${places.map((p) => p.id).join(',')}`, visual: v };
    }
    case 'campus_overview': {
      const s = o.simulated;
      if (!s) return null;
      const top = o.busiestByPercent?.[0];
      const v: StatsVisual = {
        id, kind: 'stats', title: `Campus at ${o.time}, ${o.day}`, source: 'simulated', note: `Simulated from ${n(o.enrollment.students)} enrolled students (${o.enrollment.period})`,
        items: [
          { label: 'Indoors on the map', value: n(s.indoorsOnMap), detail: 'simulated students' },
          { label: 'Walking', value: n(s.walking), detail: null },
          { label: 'Not on the map', value: n(s.notOnMap), detail: 'off campus or at home' },
          ...(top ? [{ label: 'Fullest place', value: `${top[1]}%`, detail: String(top[0]) }] : []),
        ],
      };
      return { key: `overview:${o.day}:${o.time}`, visual: v };
    }
    case 'published_counts': {
      if (o.hours?.rows?.length) {
        const rows: number[][] = o.hours.rows;
        const v: LineVisual = {
          id, kind: 'line', title: `FitRec entries${o.day ? `, ${o.day}` : ' per hour (average)'}`, source: 'published',
          note: `${o.source}, ${o.period}; entries, not occupancy`, unit: 'entries/h',
          x: rows.map((x) => hourLabel(x[0])), series: [{ name: 'Published entries', values: rows.map((x) => intOrNull(x[1])) }], marker: null,
        };
        return { key: `fitrec:${o.day ?? 'avg'}`, visual: v };
      }
      if (o.sites?.length) {
        const rows = (o.sites as Out[]).flatMap((s) => (s.counts as Out[]).map((c) => ({ site: s.name, time: c.time, pedestrians: intOrNull(c.pedestrians), observed: s.observed })));
        const v: TableVisual = {
          id, kind: 'table', title: 'Published pedestrian counts', source: 'published', note: 'Peak-hour crossings on sample days; not today',
          columns: [{ key: 'site', label: 'Crossing', align: 'left' }, { key: 'time', label: 'Hour from', align: 'left' }, { key: 'pedestrians', label: 'Pedestrians', align: 'right' }, { key: 'observed', label: 'Counted', align: 'left' }],
          rows: rows.slice(0, 25),
        };
        return { key: 'pedestrians', visual: v };
      }
      return null;
    }
    case 'free_rooms': {
      const rooms: Out[] = o.freeRooms ?? [];
      if (!rooms.length) return null;
      const v: TableVisual = {
        id, kind: 'table', title: `Rooms with no class at ${o.time}, ${o.building}`, source: 'published', note: 'Published class schedule; other uses and access are unknown',
        columns: [{ key: 'room', label: 'Room', align: 'left' }, { key: 'seats', label: 'Seats', align: 'right' }, { key: 'freeUntil', label: 'Free until', align: 'left' }],
        rows: rooms.slice(0, 25).map((x) => ({ room: x.room, seats: intOrNull(x.seats), freeUntil: x.freeUntil })),
      };
      return { key: `free:${o.building}:${o.day}:${o.time}`, visual: v };
    }
    case 'list_events': {
      const events: Out[] = o.events ?? [];
      if (!events.length) return null;
      const v: TableVisual = {
        id, kind: 'table', title: `Events, ${o.scope}`, source: 'published', note: 'Terrier Central; registrations are sign-ups, not attendance',
        columns: [{ key: 'event', label: 'Event', align: 'left' }, { key: 'when', label: 'When', align: 'left' }, { key: 'where', label: 'Where', align: 'left' }, { key: 'registrations', label: 'Registrations', align: 'right' }],
        rows: events.slice(0, 25).map((e) => ({ event: e.name, when: `${e.day} ${e.start}`, where: e.where, registrations: intOrNull(e.registrations) })),
      };
      return { key: `events:${o.scope}:${o.place ?? ''}`, visual: v };
    }
    case 'event_impact': {
      const f = o.focus;
      if (!f?.hours?.rows?.length) return null;
      const rows: (number | null)[][] = f.hours.rows;
      const percent = f.hours.columns[1] === 'normalPercent';
      const first = (o.simulatedEvents as Out[]).find((e) => e.place === f.place);
      const startHour = first ? Number(clock24(first.start)?.slice(0, 2)) : NaN;
      const marker = rows.findIndex((x) => x[0] === startHour);
      const v: LineVisual = {
        id, kind: 'line', title: `${f.place}, ${o.day} ${o.date}`, source: 'simulated',
        note: `Simulated hourly mean head count${percent ? ` over ${n(f.capacity)} capacity` : ''}; event attendance is an assumption`,
        unit: percent ? '% full' : 'students', x: rows.map((x) => hourLabel(Number(x[0]))),
        series: [{ name: 'Normal day', values: rows.map((x) => intOrNull(x[1])) }, { name: 'With events', values: rows.map((x) => intOrNull(x[2])) }],
        marker: marker >= 0 && first ? { index: marker, label: `${first.start} event` } : null,
      };
      return { key: `impact:${o.date}:${f.place}`, visual: v };
    }
    case 'bluebikes': {
      const rows: number[][] = o.hourly?.table?.rows ?? [];
      if (!rows.length) return null;
      const v: LineVisual = {
        id, kind: 'line', title: `Bluebikes, ${o.hourly.of}`, source: 'published', note: `Average rides per hour, ${o.period}; not live`, unit: 'rides/h',
        x: rows.map((x) => hourLabel(x[0])),
        series: [{ name: 'Docked (arrivals)', values: rows.map((x) => x[1]) }, { name: 'Undocked (departures)', values: rows.map((x) => x[2]) }], marker: null,
      };
      return { key: `bikes:${o.hourly.of}`, visual: v };
    }
    case 'transit_near': {
      const rows = (o.stops as Out[]).flatMap((s) => (s.routes as Out[]).map((r) => ({
        stop: s.stop, route: r.route, toward: r.toward, departures: intOrNull(r.departuresInHour), next: (r.next as string[]).join(', '),
      })));
      if (!rows.length) return null;
      const shuttle = (o.stops as Out[]).some((s) => s.kind === 'shuttle');
      const v: TableVisual = {
        id, kind: 'table', title: `Scheduled departures near ${o.from}, ${o.window}`, source: shuttle ? 'mixed' : 'published',
        note: shuttle ? 'MBTA timetable; BU Shuttle from its 2024–25 feed and recorded times. Not live' : 'Published MBTA timetable; not live arrivals',
        columns: [{ key: 'stop', label: 'Stop', align: 'left' }, { key: 'route', label: 'Route', align: 'left' }, { key: 'toward', label: 'Toward', align: 'left' }, { key: 'departures', label: 'In the hour', align: 'right' }, { key: 'next', label: 'Next', align: 'left' }],
        rows: rows.slice(0, 25),
      };
      return { key: `transit:${o.from}:${o.day}:${o.window}`, visual: v };
    }
    case 'housing': {
      const res: Out[] = o.residences ?? [];
      if (!res.length) return null;
      const v: BarVisual = {
        id, kind: 'bar', title: 'Residence beds', source: 'mixed', note: 'Beds are capacity, not occupied beds; low-confidence figures are estimates', unit: 'beds',
        bars: res.slice(0, 12).map((r) => ({ label: r.name, value: intOrNull(r.beds), level: null, detail: r.confidence === 'low' ? 'estimate, low confidence' : r.basis })),
      };
      return { key: 'housing', visual: v };
    }
    case 'population_summary': {
      const s = o.students;
      if (!s) return null;
      const v: StatsVisual = {
        id, kind: 'stats', title: 'BU population', source: 'published', note: `${s.period}; employees ${o.employees.period}`,
        items: [
          { label: 'Students', value: n(s.total), detail: 'enrolled, not on campus at once' },
          { label: 'Undergraduates', value: n(s.undergraduate), detail: null },
          { label: 'Graduate students', value: n(s.graduate), detail: null },
          { label: 'Employees', value: n(o.employees.total), detail: o.employees.scope },
        ],
      };
      return { key: 'population', visual: v };
    }
    case 'model_validation': {
      const scores: Out[] = o.scores ?? [];
      if (!scores.length) return null;
      const v: TableVisual = {
        id, kind: 'table', title: `Simulation vs published counts, ${o.day}`, source: 'mixed', note: `Precomputed ${o.computed}; several series were also used to tune the model`,
        columns: [{ key: 'metric', label: 'Comparison', align: 'left' }, { key: 'comparedWith', label: 'Published series', align: 'left' }, { key: 'target', label: 'Target', align: 'right' }, { key: 'simulated', label: 'Simulation', align: 'right' }],
        rows: scores.slice(0, 25).map((x) => ({ metric: x.metric, comparedWith: o.publishedSeries?.[x.against] ?? null, target: x.target, simulated: x.simulated })),
      };
      return { key: `validation:${o.day}`, visual: v };
    }
    case 'what_if_scenarios':
    case 'weather_effects': {
      const changes: Out[] = o.behaviourChanges ?? [];
      if (!changes.length) return null;
      const title = r.tool === 'weather_effects' ? `Behaviour in ${String(o.condition).replace('-', ' ')}${o.temperatureF !== null ? `, ${o.temperatureF}°F` : ''}` : `Scenario: ${o.label}`;
      const v: TableVisual = {
        id, kind: 'table', title, source: 'assumption', note: 'Stated model assumptions, not observed behaviour',
        columns: [{ key: 'rule', label: 'Assumption', align: 'left' }, { key: 'changes', label: 'Changes', align: 'left' }, { key: 'kind', label: 'Basis', align: 'left' }],
        rows: changes.slice(0, 25).map((c) => ({ rule: c.label, changes: (c.effects as string[]).join('; '), kind: c.kind })),
      };
      return { key: `conditions:${title}`, visual: v };
    }
    case 'emergency_info': {
      const units: Out[] = o.firstAlarm ?? [];
      if (!units.length) return null;
      const v: BarVisual = {
        id, kind: 'bar', title: `Modeled fire response to ${o.building}`, source: 'simulated', note: 'Modeled drive times from uncalibrated assumptions; not BFD response data', unit: 'min',
        bars: units.slice(0, 12).map((u) => ({ label: u.unit, value: u.modeledMinutesToArrive, level: null, detail: `from ${u.from}` })),
      };
      return { key: `fire:${o.building}`, visual: v };
    }
    case 'parking_lots': {
      const lots: Out[] = o.lots ?? [];
      if (!lots.length) return null;
      const v: BarVisual = {
        id, kind: 'bar', title: o.from ? `Parking near ${o.from}` : 'Parking spaces', source: 'mixed', note: 'Spaces are capacity, not how full a lot is', unit: 'spaces',
        bars: lots.slice(0, 12).map((l) => ({ label: l.name, value: intOrNull(l.spaces), level: null, detail: `${l.spacesBasis}${typeof l.metresStraightLine === 'number' ? ` · ${n(l.metresStraightLine)} m` : ''}` })),
      };
      return { key: `parking:${o.from ?? ''}`, visual: v };
    }
    case 'library_gate_counts': {
      const rows: any[][] = o.counts?.rows ?? [];
      if (rows.length < 2) return null;
      const v: LineVisual = {
        id, kind: 'line', title: `${o.library}, ${o.day}s`, source: 'published', note: `Historical counts, ${o.period}; counting method unknown`, unit: 'patrons',
        x: rows.map((x) => String(x[0])), series: [{ name: 'Patrons counted', values: rows.map((x) => intOrNull(x[1])) }], marker: null,
      };
      return { key: `library:${o.day}`, visual: v };
    }
    default:
      return null;
  }
}

const KIND_ORDER: Record<Visual['kind'], number> = { line: 0, bar: 1, table: 2, stats: 3 };

/**
 * The turn's visuals: one per suitable tool result, de-duplicated (a repeated subject keeps its
 * latest result), in call order, at most four (charts first when there are more).
 */
export function buildVisuals(results: Result[]): Visual[] {
  const byKey = new Map<string, { order: number; visual: Visual }>();
  results.forEach((r, i) => {
    const v = visualFor(r, i);
    if (!v) return;
    byKey.delete(v.key);
    byKey.set(v.key, { order: i, visual: v.visual });
  });
  let list = [...byKey.values()];
  if (list.length > MAX_VISUALS) {
    const keep = new Set([...list].sort((a, b) => KIND_ORDER[a.visual.kind] - KIND_ORDER[b.visual.kind] || b.order - a.order).slice(0, MAX_VISUALS));
    list = list.filter((x) => keep.has(x));
  }
  return list.sort((a, b) => a.order - b.order).map((x, i) => ({ ...x.visual, id: `v${i + 1}` }));
}

// ---------------------------------------------------------------- follow-ups

/** Suggestions per tool result, best first. Worded from tool output only, never from the model. */
function suggestionsFor(r: Result): string[] {
  const o = r.value as Out;
  if ('error' in o || 'available' in o || 'ambiguous' in o) return [];
  switch (r.tool) {
    case 'rank_places_by_crowd': {
      const top = o.leastCrowded ?? o.mostCrowded;
      return top ? [`How busy is ${top} over the day?`, `Why is ${top} ${o.leastCrowded ? 'quieter' : 'busier'} than the others?`] : ['Which places are open right now?'];
    }
    case 'place_day': return [`What drives the crowds at ${o.place}?`, `What are ${o.place}’s opening hours?`, `How do events change crowding at ${o.place}?`];
    case 'place_info': return [`How busy is ${o.place} over the day?`, `How long is the walk to ${o.place}?`];
    case 'campus_overview': return ['Which library is least crowded right now?', 'Which dining hall is busiest right now?'];
    case 'list_events': return ['How do these events change crowding?', 'Are there games or concerts that day?'];
    case 'free_rooms': return [`How busy is ${o.building} over the day?`, 'Which library is least crowded right now?'];
    case 'find_course': return o.next?.building ? [`Which rooms in ${o.next.building} are free now?`, `How busy is ${o.next.building} right now?`] : [];
    case 'walking_route': return [`How busy is ${o.to} right now?`, `Which transit stops are near ${o.to}?`];
    case 'model_basis': return ['How does the simulation compare with real counts?'];
    case 'published_counts': return ['How does the simulation compare with real counts?', 'How busy is FitRec in the simulation right now?'];
    case 'event_impact': return o.focus ? [`How busy is ${o.focus.place} on a normal day?`, 'How was event attendance modeled?'] : ['What events are on this week?'];
    case 'bluebikes': return o.from ? [`Which transit stops are near ${o.from}?`] : ['When is the next Green Line train near CAS?'];
    case 'transit_near': return [`Are there Bluebikes docks near ${o.from}?`, `Where can I park near ${o.from}?`];
    case 'housing': return ['What share of undergraduates live on campus?', 'How does the simulation place residents on campus?'];
    case 'population_summary': return ['How does the simulation turn enrollment into people on campus?', 'What share of undergraduates live on campus?'];
    case 'model_validation': return ['When is FitRec busiest according to its own counts?', 'Why is the simulation tuned to these counts?'];
    case 'what_if_scenarios': return o.label ? ['How does rain change campus behaviour?', 'What other what-if scenarios are there?'] : ['What does the snow day scenario change?'];
    case 'weather_effects': return ['What what-if scenarios can I try?', 'How does snow change campus behaviour?'];
    case 'emergency_info': return o.firstAlarm ? ['What emergency scenarios can the map run?', `How busy is ${o.building} right now?`] : ['Which fire companies would respond to a fire alarm at CDS?'];
    case 'academic_calendar': return ['When do final exams start?', 'What events are on this week?'];
    case 'parking_lots': return o.from ? [`Which transit stops are near ${o.from}?`] : ['Where can I park near Agganis Arena?'];
    case 'library_gate_counts': return ['Which library is least crowded right now?', 'How does the simulation compare with real counts?'];
    default: return [];
  }
}

/** Up to three follow-up questions: the latest tool's best suggestion first, then the others'. */
export function followUpsFor(results: Result[], asked: string[]): string[] {
  const lists = [...results].reverse().map(suggestionsFor).filter((l) => l.length);
  const seen = new Set(asked.map((q) => q.trim().toLowerCase()));
  const out: string[] = [];
  for (let round = 0; out.length < 3 && lists.some((l) => l.length > round); round++) {
    for (const l of lists) {
      const q = l[round];
      if (!q || q.length > 120 || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      out.push(q);
      if (out.length === 3) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- map link

/** The moment a result is about: weekday and HH:MM, or a date for event impact. */
function momentOf(r: Result): { weekday?: number; at: string | null; date?: string } | null {
  const o = r.value as Out;
  if ('error' in o || 'available' in o) return null;
  const weekday = WEEKDAYS.indexOf(o.day);
  const w = weekday >= 0 ? weekday : undefined;
  switch (r.tool) {
    case 'rank_places_by_crowd': case 'campus_overview': case 'free_rooms': return { weekday: w, at: clock24(o.time) };
    case 'place_day': return { weekday: w, at: clock24(o.now?.time) };
    case 'transit_near': return { weekday: w, at: clock24(String(o.window ?? '')) };
    case 'emergency_info': return o.firstAlarm ? { weekday: w, at: clock24(o.alarmAt) } : null;
    case 'event_impact': {
      if (!o.date || !o.simulatedEvents?.length) return null;
      const first = (o.simulatedEvents as Out[]).find((e) => e.place === o.focus?.place) ?? o.simulatedEvents[0];
      return { date: o.date, at: clock24(first.start) };
    }
    default: return null;
  }
}

/**
 * "/map?at=12:20&speed=1" for the map's default Wednesday, "/map?date=…&at=…&speed=1&events=0" for
 * another weekday of the representative week (no events, like the numbers in the answer), and
 * "/map?date=…&at=…&speed=1" for an event-impact date (events on). Null without a moment.
 */
export function mapLinkFor(results: Result[], ctx: { weekday: number; date: string | null; data?: CampusData }): string | null {
  for (const r of [...results].reverse()) {
    const m = momentOf(r);
    if (!m?.at) continue;
    if (m.date) return `/map?date=${m.date}&at=${m.at}&speed=1`;
    const w = m.weekday ?? ctx.weekday;
    // The map plays Wednesday by default; another day needs a date of that weekday.
    if (w === 2 && !ctx.date) return `/map?at=${m.at}&speed=1`;
    const sameDay = ctx.date && (new Date(`${ctx.date}T12:00:00Z`).getUTCDay() + 6) % 7 === w;
    const date = sameDay ? ctx.date : ctx.data ? dateForWeekday(ctx.data, w) : null;
    return date ? `/map?date=${date}&at=${m.at}&speed=1&events=0` : null;
  }
  return null;
}
