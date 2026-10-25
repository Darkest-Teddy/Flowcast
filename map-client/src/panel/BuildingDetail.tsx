/*
 * One building, in full.
 *
 * Tapping a row, a tag or a marker replaces the list with this. It answers the
 * question the list only hints at: not "how full is it now" but "when should I
 * go", which is a shape over the day rather than a number. Fifteen bars from
 * 8 AM to 10 PM, each in its own level's colour, with the current hour outlined
 * and the hours already gone faded.
 *
 * The quietest hour still ahead is called out in the header of that card,
 * because it is the one fact somebody standing outside a full library wants.
 */

import { KIND_LABEL } from '../BuildingTags';
import type { CampusLocation } from '../sim/playback';

/*
 * One hour of the day, already reduced to what the bar needs.
 *
 * The level arrives as its icon and its CSS variables rather than as the level
 * object, because that is all the bar uses and it keeps the one crowd scale in
 * the caller where crowdLevelStyle already lives.
 */
export interface HourSample {
  /** Seconds into the day at the top of the hour. */
  sec: number;
  /** Short label, "8 AM". Only some are drawn, all are announced. */
  label: string;
  percent: number;
  /** The level's mark and its --lv variables (theme/crowd.ts). */
  icon: string;
  style: Record<string, string>;
  /** False when the model has no figure for this hour. */
  known: boolean;
  /** The level's word, for the spoken summary. */
  word: string;
}

/** The hours the handoff asks for: 8 AM through 10 PM inclusive. */
export const FIRST_HOUR = 8;
export const LAST_HOUR = 22;

/** The axis labels, the only hours written under the bars. */
const AXIS: Record<number, string> = { 8: '8 AM', 12: 'noon', 16: '4 PM', 20: '8 PM', 22: '10 PM' };

export function BuildingDetail({
  location,
  percent,
  level,
  known,
  hours,
  nowHour,
  event,
  onBack,
  onWalk,
  onSources,
  onOpenEvent,
  backLabel,
}: {
  location: CampusLocation;
  percent: number;
  /** The current level: its mark, its word and its --lv variables. */
  level: { icon: string; word: string; style: Record<string, string> };
  known: boolean;
  hours: HourSample[];
  /** The hour currently being simulated, 0-23, so one bar can be outlined. */
  nowHour: number;
  /** An event here today, if there is one. */
  event: { id: string; name: string; when: string; place: string; imageUrl?: string | null } | null;
  onBack: () => void;
  onWalk: () => void;
  onSources: () => void;
  onOpenEvent: (id: string) => void;
  backLabel: string;
}) {
  // The quietest hour still to come, which is the only one worth suggesting.
  const ahead = hours.filter((h) => h.known && h.sec > nowHour * 3600);
  const quietest = ahead.length ? ahead.reduce((a, b) => (b.percent < a.percent ? b : a)) : null;
  const next3 = hours.filter((h) => h.sec > nowHour * 3600).slice(0, 3);
  const tallest = Math.max(100, ...hours.map((h) => h.percent));

  return (
    <>
      <button type="button" className="pn-back" onClick={onBack}>
        ‹ {backLabel}
      </button>

      <div className="bd-head">
        <span className="bd-tile" style={level.style} dangerouslySetInnerHTML={{ __html: level.icon }} />
        <span className="bd-names">
          <span className="bd-name">{location.name}</span>
          <span className="bd-kind">
            {KIND_LABEL[location.kind]}
            {location.campus && ` · ${location.campus.replace('-', ' ')}`}
          </span>
        </span>
        {known && (
          <span className="bd-reading" style={level.style}>
            <b>{percent}%</b>
            <span>{level.word}</span>
          </span>
        )}
      </div>

      <div className="pn-card bd-today">
        <div className="pn-head bd-today-head">
          <p className="pn-label">Today</p>
          {quietest && (
            <span className="bd-quietest" style={quietest.style}>
              Quietest later: {quietest.label} · {quietest.percent}%
            </span>
          )}
        </div>

        {/*
          Bars, not a line. A line implies the hours in between were measured;
          these are hourly samples of a simulation and the bar says so. Height is
          the share of the busiest hour shown, so a quiet building is not drawn
          as a flat strip.
        */}
        <div className="bd-bars" role="img" aria-label={barsLabel(hours)}>
          {hours.map((h) => (
            <span
              key={h.sec}
              className="bd-bar"
              data-now={Math.floor(h.sec / 3600) === nowHour || undefined}
              data-past={h.sec < nowHour * 3600 || undefined}
              data-unknown={!h.known || undefined}
              style={{ ...h.style, height: `${Math.max(2, (h.percent / tallest) * 60)}px` }}
            />
          ))}
        </div>
        <div className="bd-axis" aria-hidden="true">
          {hours.map((h) => (
            <span key={h.sec}>{AXIS[Math.floor(h.sec / 3600)] ?? ''}</span>
          ))}
        </div>
      </div>

      {next3.length > 0 && (
        <div className="bd-next">
          {next3.map((h) => (
            <div key={h.sec} className="bd-next-tile" style={h.style}>
              <span className="bd-next-hour">{h.label}</span>
              <span className="bd-next-icon" dangerouslySetInnerHTML={{ __html: h.icon }} />
              <b>{h.known ? `${h.percent}%` : '—'}</b>
            </div>
          ))}
        </div>
      )}

      {event && (
        <button type="button" className="bd-event" onClick={() => onOpenEvent(event.id)}>
          {event.imageUrl
            ? <img className="bd-event-thumb" src={event.imageUrl} alt="" loading="lazy" decoding="async" />
            : <span className="bd-event-thumb is-placeholder" aria-hidden="true" />}
          <span className="bd-event-text">
            <span className="bd-event-name">{event.name}</span>
            <span className="bd-event-when">
              {event.when} · {event.place}
            </span>
          </span>
        </button>
      )}

      <div className="pn-actions">
        <button type="button" className="pn-primary" onClick={onWalk}>
          Walk here
        </button>
        <button type="button" className="pn-secondary" onClick={onSources}>
          Hours &amp; sources
        </button>
      </div>

    </>
  );
}

/** One sentence for a screen reader, since the bars themselves say nothing. */
function barsLabel(hours: HourSample[]): string {
  const known = hours.filter((h) => h.known);
  if (!known.length) return 'No hourly figures for today.';
  const busiest = known.reduce((a, b) => (b.percent > a.percent ? b : a));
  const quietest = known.reduce((a, b) => (b.percent < a.percent ? b : a));
  return `Hourly from 8 AM to 10 PM. Busiest ${busiest.label} at ${busiest.percent}%, quietest ${quietest.label} at ${quietest.percent}%.`;
}
