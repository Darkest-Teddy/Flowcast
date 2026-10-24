import type { CampusData } from './data/campusData';
import { formatClock, type CampusLocation } from './sim/playback';
import { gatheringExclusion, GATHERING_ATTENDANCE_PROBABILITY } from './sim/gatherings';
import type { SourceDay } from './sim/sourceDay';
import './events-panel.css';

const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = (date: string) => LONG_DATE.format(new Date(`${date}T12:00:00Z`));

/** The shown day's campus events: which ones change the map, how many simulated students attend, and why others don't. */
export function EventsPanel({ day, data, locations, eventsOn, onToggle, onPickDate, onShow }: {
  day: SourceDay | null;
  data: CampusData;
  locations: CampusLocation[];
  eventsOn: boolean;
  onToggle: (on: boolean) => void;
  onPickDate: (date: string) => void;
  onShow: (location: CampusLocation) => void;
}) {
  const date = day?.eventDate ?? null;
  const listed = date ? data.events.filter((event) => event.start.slice(0, 10) === date) : [];
  const offMap = listed.filter((event) => gatheringExclusion(event));
  const projected = day?.gatherings.some((g) => g.projected) ?? false;
  const eventDates = [...new Set(data.events.map((event) => event.start.slice(0, 10)))].sort();

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
            <p>No events at mapped places on this date.</p>
          )}
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
