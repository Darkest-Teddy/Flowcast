/*
 * Events: what is on, led by the photograph.
 *
 * Terrier Central puts a picture on every event and the scraper now keeps it
 * (data-pipeline/scrape_events.py), so the tab leads with one instead of with a
 * list of titles. A photograph answers "is this for me" faster than a name does,
 * which is the whole question someone scanning a campus calendar is asking.
 *
 * Snapshots built before the photo was collected have no `imageUrl`, so every
 * image falls back to a striped tile rather than a broken frame or a gap.
 */

import type { SourceEvent } from '../data/campusData';

export type EventWhen = 'today' | 'tomorrow' | 'week';

export const EVENT_DAYS: { id: EventWhen; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
];

/** Rows shown closed, and the ceiling once "Show all" is pressed. */
const CLOSED_ROWS = 2;
const OPEN_ROWS = 8;

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** Where an event is, in as few words as the row can hold. */
const place = (event: SourceEvent) => event.roomCode || event.locationName || 'Location to be announced';

export function EventsList({
  events,
  when,
  onWhen,
  expanded,
  onExpand,
  onOpen,
  /** Seconds into the simulated day, so "Happening now" means now on the map. */
  nowSec,
}: {
  events: SourceEvent[];
  when: EventWhen;
  onWhen: (w: EventWhen) => void;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  onOpen: (event: SourceEvent) => void;
  nowSec: number | null;
}) {
  const [featured, ...rest] = events;
  const shown = rest.slice(0, expanded ? OPEN_ROWS : CLOSED_ROWS);

  return (
    <>
      <div className="pn-sortrow">
        <div className="pn-sort" role="group" aria-label="When">
          {EVENT_DAYS.map((d) => (
            <button key={d.id} type="button" aria-pressed={when === d.id} onClick={() => onWhen(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        <span className="pn-now">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      {!featured && <p className="pn-empty">Nothing scheduled. Try another day.</p>}

      {featured && (
        <button type="button" className="pn-feature" onClick={() => onOpen(featured)}>
          <Photo event={featured} className="pn-feature-photo" />
          <span className="pn-badge">{happeningNow(featured, nowSec) ? 'Happening now' : dayLabel(featured.start)}</span>
          <span className="pn-feature-body">
            <span className="pn-feature-title">{featured.name}</span>
            <span className="pn-meta">
              <span dangerouslySetInnerHTML={{ __html: CLOCK }} />
              {time(featured.start)}
              <span dangerouslySetInnerHTML={{ __html: PIN }} />
              <span className="pn-meta-place">{place(featured)}</span>
            </span>
          </span>
        </button>
      )}

      {rest.length > 0 && (
        <>
          <p className="pn-label">Up next</p>
          <div className="pn-card">
            <ol className={expanded ? 'pn-rows is-open' : 'pn-rows'}>
              {shown.map((event) => (
                <li key={event.id}>
                  <button type="button" className="pn-row pn-row--event" onClick={() => onOpen(event)}>
                    <Photo event={event} className="pn-thumb" />
                    <span className="pn-name">{event.name}</span>
                    <span className="pn-when">
                      {time(event.start)} · {place(event)}
                    </span>
                    <span className="pn-chev" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {rest.length > CLOSED_ROWS && (
              <button type="button" className="pn-more" onClick={() => onExpand(!expanded)}>
                {expanded ? 'Show less' : `Show all ${Math.min(rest.length, OPEN_ROWS)}`}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function EventDetail({
  event,
  onBack,
  onShow,
  /** The mapped building this event adds people to, if its venue is one. */
  buildingName,
}: {
  event: SourceEvent;
  onBack: () => void;
  onShow: (event: SourceEvent) => void;
  buildingName: string | null;
}) {
  return (
    <>
      <button type="button" className="pn-back" onClick={onBack}>
        ‹ Events
      </button>

      <Photo event={event} className="pn-detail-photo" />

      <h3 className="pn-detail-title">{event.name}</h3>
      {event.organizer && <p className="pn-detail-org">{event.organizer}</p>}

      <div className="pn-card pn-split">
        <p>
          <span dangerouslySetInnerHTML={{ __html: CLOCK }} />
          {dayLabel(event.start)} · {time(event.start)}
          {event.end && ` to ${time(event.end)}`}
        </p>
        <p>
          <span dangerouslySetInnerHTML={{ __html: PIN }} />
          {place(event)}
        </p>
        <p className={buildingName ? 'pn-effect' : 'pn-effect is-off'}>
          <span dangerouslySetInnerHTML={{ __html: PEOPLE }} />
          {buildingName ? `Adds to the crowd at ${buildingName}` : 'Not on the map: the location is not a mapped building'}
        </p>
      </div>

      <div className="pn-actions">
        <button type="button" className="pn-primary" onClick={() => onShow(event)} disabled={!buildingName}>
          Show on map
        </button>
        <a className="pn-secondary" href={event.sourceUrl} target="_blank" rel="noreferrer">
          Terrier Central
          <span dangerouslySetInnerHTML={{ __html: EXTERNAL }} />
        </a>
      </div>
    </>
  );
}

/*
 * An event's picture, or the stripes that stand in for one.
 *
 * Lazy, because a week of events is a week of photographs and none of them is
 * needed until the tab is open. The placeholder is a tile rather than a grey box
 * so an event with no photo still reads as a card with a picture slot, which is
 * what keeps the list from changing shape halfway down.
 */
function Photo({ event, className }: { event: SourceEvent; className: string }) {
  if (!event.imageUrl) return <span className={`${className} is-placeholder`} aria-hidden="true" />;
  return <img className={className} src={event.imageUrl} alt="" loading="lazy" decoding="async" />;
}

function happeningNow(event: SourceEvent, nowSec: number | null): boolean {
  if (nowSec === null) return false;
  const start = new Date(event.start);
  const startSec = start.getHours() * 3600 + start.getMinutes() * 60;
  const endSec = event.end
    ? (() => {
        const e = new Date(event.end);
        return e.getHours() * 3600 + e.getMinutes() * 60;
      })()
    : startSec + 3600;
  return nowSec >= startSec && nowSec <= endSec;
}

const CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>';

const PIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';

const PEOPLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.4 5.4 0 0 0-2-4.2"/></svg>';

const EXTERNAL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
