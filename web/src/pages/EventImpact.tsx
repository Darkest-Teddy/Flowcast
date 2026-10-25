import { Map as MapIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { crowdFor } from '@theme/tokens';
import { config } from '../config';
import { api, useResource } from '../data/api';
import type { CampusEvent, EventImpactData, ImpactPlace } from '../data/types';
import { formatHour, formatPercent, formatTime } from '../lib/format';
import { Button, CellStack, CrowdMeter, EmptyState, Loading, Page, PageHeader, SectionHeading, SectionList, ListRow, Table, Tag, type Column } from '../ui';
import { CompareChart, type CompareHour } from './student/CompareChart';
import { EventCalendar, type CalendarDay } from './student/EventCalendar';
import { eventDate, eventVenue, mapStatusText } from './student/events';
import styles from './EventImpact.module.css';

const FIRST_HOUR = 7;
const LAST_HOUR = 23;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);
/** A non-venue place gets its own chart when an hour changes by at least this many people and share of capacity. */
const MIN_CHANGE_PEOPLE = 10;
const MIN_CHANGE_SHARE = 0.05;
const bostonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const utc = (date: string) => new Date(`${date}T12:00:00Z`);
const weekdayOf = (date: string) => (utc(date).getUTCDay() + 6) % 7;
const addDays = (date: string, days: number) => { const d = utc(date); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const longDate = (date: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utc(date));
const shortDate = (date: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(utc(date));
const clock = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label}`;

interface PlaceImpact {
  place: ImpactPlace;
  hours: CompareHour[];
  baselinePeak: CompareHour;
  eventsPeak: CompareHour;
  /** Largest hourly increase in simulated people, and when. */
  added: number;
  addedHour: number;
}

function impactFor(data: EventImpactData, date: string): PlaceImpact[] {
  const baseline = data.baseline[String(weekdayOf(date))] ?? {};
  const changed = data.dates[date]?.occupancy ?? {};
  return data.places.map((place) => {
    const before = baseline[place.id] ?? [];
    const after = changed[place.id] ?? before;
    const share = (count = 0) => (place.capacity > 0 ? count / place.capacity : 0);
    const hours = HOURS.map((hour) => ({ hour, baseline: share(before[hour]), withEvents: share(after[hour]) }));
    const peak = (key: 'baseline' | 'withEvents') => hours.reduce((a, b) => (b[key] > a[key] ? b : a));
    let added = 0, addedHour = HOURS[0];
    for (const hour of HOURS) {
      const diff = (after[hour] ?? 0) - (before[hour] ?? 0);
      if (Math.abs(diff) > Math.abs(added)) { added = diff; addedHour = hour; }
    }
    return { place, hours, baselinePeak: peak('baseline'), eventsPeak: peak('withEvents'), added, addedHour };
  }).filter((row) => row.hours.some((h) => h.baseline > 0 || h.withEvents > 0));
}

export default function EventImpact() {
  const impact = useResource(api.getEventImpact);
  const events = useResource(api.getCampusEvents);
  const [params, setParams] = useSearchParams();

  const header = (
    <PageHeader
      title="Event impact"
      description="Pick a date to see BU’s events that day and how they change crowding at each place, compared with the same day without events."
    />
  );
  const error = impact.error ?? events.error;
  if (error) {
    return (
      <Page>
        {header}
        <EmptyState title="Event impact didn't load" body={error.message} action={<Button onClick={() => { impact.reload(); events.reload(); }}>Try again</Button>} />
      </Page>
    );
  }
  if (!impact.data || !events.data) {
    return (
      <Page>
        {header}
        <Loading label="Loading events and crowd forecasts" />
      </Page>
    );
  }

  const data = impact.data;
  const today = bostonToday();
  const simulatedDates = Object.keys(data.dates).filter((d) => d >= today).sort();
  const lastEvent = events.data.map(eventDate).sort().at(-1) ?? today;
  const max = lastEvent > today ? lastEvent : addDays(today, 60);
  const requested = params.get('date');
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= today && requested <= max
    ? requested : simulatedDates[0] ?? today;
  const pick = (next: string) => setParams({ date: next }, { replace: true });

  const calendarDays: Record<string, CalendarDay> = {};
  for (const e of events.data) {
    const d = eventDate(e);
    const row = (calendarDays[d] ??= { events: 0, simulated: 0 });
    row.events++;
    if (e.mapStatus === 'simulated') row.simulated++;
  }

  const day = data.dates[date];
  const dayEvents = events.data.filter((e) => eventDate(e) === date).sort((a, b) => a.start.localeCompare(b.start));
  const gatheringFor = (e: CampusEvent) => day?.gatherings.find((g) => g.eventId === e.id);
  const rows = impactFor(data, date);
  const venues = new Set(day?.gatherings.map((g) => g.locationId) ?? []);
  // Charts for event venues and places that change noticeably; smaller ripples stay in the table.
  const noticeable = (r: PlaceImpact) => venues.has(r.place.id) || Math.abs(r.added) >= Math.max(MIN_CHANGE_PEOPLE, r.place.capacity * MIN_CHANGE_SHARE);
  const changed = rows.filter((r) => r.added !== 0);
  const affected = changed.filter(noticeable).sort((a, b) => Number(venues.has(b.place.id)) - Number(venues.has(a.place.id)) || Math.abs(b.added) - Math.abs(a.added));
  const rippled = changed.length - affected.length;
  const table = [...rows].sort((a, b) => Math.abs(b.added) - Math.abs(a.added) || b.eventsPeak.withEvents - a.eventsPeak.withEvents);
  const weekEnd = addDays(data.referenceWeekStart, 6);
  const eventHours = (placeId: string) => new Set((day?.gatherings ?? []).filter((g) => g.locationId === placeId)
    .flatMap((g) => HOURS.filter((h) => h * 3600 < g.endSec && (h + 1) * 3600 > g.startSec)));
  const firstStart = day?.gatherings.length ? Math.min(...day.gatherings.map((g) => g.startSec)) : null;
  const mapLink = `${config.mapUrl}?date=${date}${firstStart !== null ? `&at=${clock(firstStart)}` : ''}`;
  const attendees = day?.gatherings.reduce((sum, g) => sum + g.attendees, 0) ?? 0;

  const columns: Column<PlaceImpact>[] = [
    { key: 'place', header: 'Place', render: (r) => <CellStack primary={r.place.name} secondary={`${r.place.kind}, ${r.place.capacity.toLocaleString()} capacity`} /> },
    { key: 'before', header: 'Busiest without events', render: (r) => <CellStack primary={<CrowdMeter share={r.baselinePeak.baseline} />} secondary={formatHour(r.baselinePeak.hour)} /> },
    { key: 'after', header: 'Busiest with events', render: (r) => <CellStack primary={<CrowdMeter share={r.eventsPeak.withEvents} />} secondary={formatHour(r.eventsPeak.hour)} /> },
    { key: 'change', header: 'Change', align: 'right', render: (r) => r.added === 0 ? <span className={styles.none}>No change</span>
      : <CellStack primary={<strong className={styles.change}>{r.added > 0 ? '+' : '−'}{Math.abs(r.added).toLocaleString()} people</strong>} secondary={`at ${formatHour(r.addedHour)}`} /> },
  ];

  return (
    <Page wide>
      {header}
      <div className={styles.layout}>
        <aside className={styles.picker}>
          <EventCalendar value={date} onChange={pick} days={calendarDays} min={today} max={max} />
          {simulatedDates.length > 0 && (
            <div className={styles.jump}>
              <span>Dates with events on the map</span>
              <div className={styles.chips}>
                {simulatedDates.slice(0, 8).map((d) => (
                  <button key={d} type="button" className={d === date ? styles.chipOn : styles.chip} aria-pressed={d === date} onClick={() => pick(d)}>{shortDate(d)}</button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div className={styles.detail}>
          <SectionHeading actions={day && <Button href={mapLink} icon={<MapIcon aria-hidden />}>See it on the map</Button>}>
            {longDate(date)}
          </SectionHeading>
          {day?.projected && (
            <p className={styles.note}>
              The simulation models one representative week ({shortDate(data.referenceWeekStart)} to {shortDate(weekEnd)}). This date’s events are placed on the same weekday and time of that week, with its classes and opening hours.
            </p>
          )}

          <SectionList title="Events" count={dayEvents.length} empty="No public BU events listed on this date.">
            {dayEvents.map((e) => {
              const g = gatheringFor(e);
              return (
                <ListRow
                  key={e.id}
                  title={e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                  subtitle={`${formatTime(e.start)}${e.end && e.end.slice(0, 10) === date ? `–${formatTime(e.end)}` : ''} · ${eventVenue(e)}`}
                  trailing={g ? <Tag tone="accent">{g.attendees.toLocaleString()} attending of {g.capacity.toLocaleString()}</Tag> : <Tag>{e.mapStatus === 'simulated' ? 'On the map' : 'Not on map'}</Tag>}
                />
              );
            })}
          </SectionList>
          {dayEvents.some((e) => e.mapStatus !== 'simulated') && (
            <ul className={styles.reasons}>
              {dayEvents.filter((e) => e.mapStatus !== 'simulated').map((e) => <li key={e.id}><strong>{e.title}:</strong> {mapStatusText(e)}.</li>)}
            </ul>
          )}

          <SectionHeading>Places changed by events</SectionHeading>
          {affected.length ? (
            <>
              <p className={styles.summary}>
                {attendees.toLocaleString()} simulated students attend {day!.gatherings.length} {day!.gatherings.length === 1 ? 'event' : 'events'} at {venues.size} {venues.size === 1 ? 'place' : 'places'}.
                {rippled > 0 && ` Attendees skip a meal, study or gym visit they’d otherwise make, so ${rippled} other ${rippled === 1 ? 'place changes' : 'places change'} slightly; see the table below.`}
              </p>
              <div className={styles.places}>
                {affected.map((r) => (
                  <section key={r.place.id} className={styles.place}>
                    <header className={styles.placeHead}>
                      <h3>{r.place.name}</h3>
                      <p>
                        <strong className={styles.change}>{r.added > 0 ? '+' : '−'}{Math.abs(r.added).toLocaleString()} people</strong> at {formatHour(r.addedHour)}
                        <span className={styles.sep}>Busiest {describe(r.eventsPeak.withEvents)} at {formatHour(r.eventsPeak.hour)} with events, {describe(r.baselinePeak.baseline)} without</span>
                      </p>
                    </header>
                    <CompareChart hours={r.hours} eventHours={eventHours(r.place.id)} label={`Hourly crowding at ${r.place.name}, without and with events`} />
                  </section>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              title="No change to crowding on this date"
              body={dayEvents.length ? 'None of this date’s events are at places on the map, so the forecast is the normal day.' : 'With no events, every place follows its normal forecast below.'}
            />
          )}

          <SectionHeading>Every place</SectionHeading>
          <p className={styles.summary}>Percentages are of the whole place’s modeled capacity, so an event in one room can add many people without changing a large building’s level.</p>
          <Table columns={columns} rows={table} rowKey={(r) => r.place.id} caption={`Busiest hour at each place on ${longDate(date)}, without and with events`} />

          <details className={styles.assumptions}>
            <summary>How this is estimated</summary>
            <p>{data.measure} Percentages are simulated head count divided by the place’s modeled capacity, between {formatHour(FIRST_HOUR)} and {formatHour(LAST_HOUR)}.</p>
            <ul>{data.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        </div>
      </div>
    </Page>
  );
}
