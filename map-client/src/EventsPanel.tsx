import type { CampusData } from './data/campusData';
import { formatClock, type CampusLocation } from './sim/playback';
import { gatheringExclusion, GATHERING_ATTENDANCE_PROBABILITY } from './sim/gatherings';
import type { SourceDay } from './sim/sourceDay';
import type { EventCalendarData, EventPopularityData } from './data/eventCalendar';
import { eventLoadAt, localSeconds, roundEstimate, type EventDay, type VenueEventEstimate } from './sim/eventAttendance';
import './events-panel.css';

const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = (date: string) => LONG_DATE.format(new Date(`${date}T12:00:00Z`));

/** The shown day's campus events: which ones change the map, how many simulated students attend, and why others don't. */
export function EventsPanel({ day, data, locations, eventsOn, onToggle, onPickDate, onShow, venueDay, calendar, popularity, time, onShowVenue, onJump }: {
  day: Pick<SourceDay, 'eventDate' | 'gatherings'> | null;
  data: CampusData;
  locations: CampusLocation[];
  eventsOn: boolean;
  onToggle: (on: boolean) => void;
  onPickDate: (date: string) => void;
  onShow: (location: CampusLocation) => void;
  /** Venue events (Agganis, Fenway...) on the shown date, with their visitor estimates. */
  venueDay?: EventDay;
  calendar?: EventCalendarData | null;
  popularity?: EventPopularityData | null;
  time?: number;
  onShowVenue?: (position: [number, number]) => void;
  /** Play a venue event's date from an hour before it starts. */
  onJump?: (date: string, startSec: number) => void;
}) {
  const date = day?.eventDate ?? null;
  const listed = date ? data.events.filter((event) => event.start.slice(0, 10) === date) : [];
  const offMap = listed.filter((event) => gatheringExclusion(event));
  const projected = day?.gatherings.some((g) => g.projected) ?? false;
  const eventDates = [...new Set([...data.events, ...(calendar?.events ?? [])].map((event) => event.start.slice(0, 10)))].sort();

  return (
    <section className="events-panel" aria-labelledby="events-panel-title">
      <div className="events-head">
        <h2 id="events-panel-title">Campus events</h2>
        <label className="events-toggle">
          <input type="checkbox" checked={eventsOn} onChange={(event) => onToggle(event.target.checked)} />
          Show event crowds
        </label>
      </div>
      <label className="events-date">
        Events from
        <input type="date" value={date ?? ''} min={eventDates[0]} max={eventDates.at(-1)}
          onChange={(event) => event.target.value && onPickDate(event.target.value)} aria-describedby="events-date-note" />
      </label>
      {!eventsOn ? (
        <p className="events-note" id="events-date-note">Events are off: the map shows the no-event baseline.</p>
      ) : (
        <>
          <p className="events-note" id="events-date-note">
            {date ? longDate(date) : 'No date'}
            {projected ? ' · projected onto this weekday of the simulated week' : ''}
          </p>
          {day && day.gatherings.length > 0 ? (
            <ul className="events-list">
              {day.gatherings.map((g) => {
                const venue = locations.find((location) => location.id === g.locationId);
                return (
                  <li key={g.id}>
                    <a href={g.sourceUrl} target="_blank" rel="noreferrer">{g.name}</a>
                    <span>{formatClock(g.startSec)}–{formatClock(g.endSec)}{g.endEstimated ? ' (end assumed)' : ''} · {venue?.short ?? g.locationId}{g.roomCode ? ` ${g.roomCode}` : ''}</span>
                    <span className="events-count">{g.attendees.toLocaleString()} simulated attendees of {g.capacity.toLocaleString()} {g.roomCode ? 'seats' : 'capacity'}</span>
                    {venue && <button onClick={() => onShow(venue)}>Show on map</button>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No campus events at mapped places on this date.</p>
          )}
          {venueDay && <VenueEvents day={venueDay} calendar={calendar ?? null} popularity={popularity ?? null} time={time ?? 0} onShowVenue={onShowVenue} onJump={onJump} />}
          {offMap.length > 0 && (
            <details>
              <summary>{offMap.length} more {offMap.length === 1 ? 'event' : 'events'} not on the map</summary>
              <ul className="events-list">
                {offMap.map((event) => (
                  <li key={event.id}>
                    <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.name}</a>
                    <span className="events-note">{gatheringExclusion(event) === 'multi-day' ? 'Multi-day listing' : event.locationName ? `${event.locationName} isn’t a mapped building` : 'Location not public'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="events-note">Model: {Math.round(GATHERING_ATTENDANCE_PROBABILITY * 100)}% of students free for the whole event attend, up to the room or venue capacity. Not measured attendance.</p>
        </>
      )}
    </section>
  );
}

const fmt = (n: number) => roundEstimate(n).toLocaleString('en-US');
const range = ([low, high]: [number, number]) => `${fmt(low)}–${fmt(high)}`;
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDate = (date: string) => SHORT_DATE.format(new Date(`${date}T12:00:00Z`));
/** Scores at the pipeline's floor (event_popularity.SCORE_FLOOR): too few searches for Trends to report. */
const TRENDS_FLOOR = 0.05;
/** Upcoming calendar events offered in the jump list. */
const UPCOMING = 40;

/** 90 daily Trends values as a small line (muted), with the last day marked; the numbers are in the text beside it. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 96, h = 22, pad = 2;
  const top = Math.max(1, ...values);
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - (v / top) * (h - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="events-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <title>{label}</title>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values.at(-1) ?? 0)} r="2.5" className="events-spark-end" />
    </svg>
  );
}

function PopularityLine({ e }: { e: VenueEventEstimate }) {
  const p = e.popularity;
  if (p.source === 'trends' && p.score !== null) {
    const term = p.scoreTerm ?? p.terms[0] ?? '';
    return (
      <span className="events-pop">
        {p.series && <Sparkline values={p.series} label={`Google searches for ${term} in the Boston area, ${p.window?.from ?? ''} to ${p.window?.to ?? ''}`} />}
        <span>Google Trends <b>{p.score <= TRENDS_FLOOR ? 'below threshold' : p.score.toFixed(2)}</b> <span className="events-muted">(TD Garden = 100){p.relative !== null ? ` · ${p.relative.toFixed(2)}× typical` : ''} · searches for “{term}”{e.event.opponent ? ' (opponent)' : ''}</span></span>
      </span>
    );
  }
  return <span className="events-pop events-muted">{p.source === 'published' ? 'Published attendance' : p.source === 'sold-out' ? 'Sold out' : `${e.model.label} prior (no Trends score)`}</span>;
}

function VenueEvents({ day, calendar, popularity, time, onShowVenue, onJump }: {
  day: EventDay; calendar: EventCalendarData | null; popularity: EventPopularityData | null; time: number;
  onShowVenue?: (position: [number, number]) => void; onJump?: (date: string, startSec: number) => void;
}) {
  if (!calendar) return <p className="events-note">Venue events unavailable: the event calendar didn’t load.</p>;
  const today = day.date ?? '';
  const upcoming = calendar.events.filter((e) => e.kind !== 'campus' && e.start.slice(0, 10) >= today).slice(0, UPCOMING);
  return (
    <div className="venue-events">
      <h3>Venue events</h3>
      {day.events.length ? (
        <ul className="events-list">
          {day.events.map((e) => {
            const load = eventLoadAt(day, e.venue.id, time);
            return (
              <li key={e.event.id}>
                <a href={e.event.sourceUrl} target="_blank" rel="noreferrer">{e.event.name}</a>
                <span>{formatClock(e.startSec)}–{formatClock(e.endSec)}{e.endEstimated ? ' (end assumed)' : ''} · {e.venue.name}</span>
                <span className="events-count">≈{fmt(e.attendees)} expected ({range(e.attendeesRange)}) of {e.capacity.toLocaleString('en-US')}</span>
                <span className="events-visitors">≈{fmt(e.visitors)} visitors ({range(e.visitorsRange)}) · ≈{fmt(e.students)} students</span>
                <PopularityLine e={e} />
                {load && <span className="events-now">Now: {load.phase === 'arriving' ? 'arriving' : load.phase === 'in' ? 'under way' : 'letting out'} · {fmt(load.attendees)} inside · ≈{fmt(load.visitorsWalking)} visitors walking</span>}
                <details>
                  <summary>How this is estimated</summary>
                  <ul className="events-provenance">{e.provenance.map((line) => <li key={line}>{line}</li>)}</ul>
                </details>
                {onShowVenue && <button onClick={() => onShowVenue(e.venue.position)}>Show on map</button>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="events-note">No ticketed events at Agganis, Walter Brown, Case Gym, Nickerson, Fenway Park or MGM Music Hall on this date.</p>
      )}
      {onJump && upcoming.length > 0 && (
        <label className="events-date">
          Jump to
          <select value="" onChange={(event) => {
            const picked = upcoming.find((e) => e.id === event.target.value);
            if (picked) onJump(picked.start.slice(0, 10), localSeconds(picked.start));
          }}>
            <option value="">an upcoming venue event…</option>
            {upcoming.map((e) => <option key={e.id} value={e.id}>{shortDate(e.start.slice(0, 10))} · {e.name}</option>)}
          </select>
        </label>
      )}
      <p className="events-note">
        Visitors are everyone at an event who isn’t a BU student: drawn walking from the T, garages and rideshare drop-offs, never counted in student figures or occupancy.
        {popularity
          ? ` Popularity: Google Trends, ${popularity.geoLabel}, ${popularity.windowDays} days before each event (built ${popularity.builtFor}; ${popularity.counts.trends} events scored, ${popularity.counts.prior} on priors).`
          : ' Popularity scores unavailable: every event uses its kind’s prior.'}
      </p>
    </div>
  );
}
