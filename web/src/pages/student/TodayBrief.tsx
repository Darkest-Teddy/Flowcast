import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import type { CampusEvent, CampusGeo, CampusLocation, HourlyForecast, Profile, ScheduleItem } from '../../data/types';
import { bostonTime } from '../../lib/departure';
import { briefStartsOpen, composeBrief, weekdayName, type VenueCalendar, type VenueCrowd } from '../../lib/morningBrief';
import { bostonLocal } from '../../lib/placeHours';
import type { StudyHoursByLocation } from '../../lib/studyFinder';
import { departureBasisLabel, type TransitContext } from '../../lib/transitDeparture';
import styles from './TodayBrief.module.css';

const SEEN_KEY = 'flowcast.todayBrief.seenDay';
const MAX_CAMPUS_EVENTS = 3;
const readSeen = () => { try { return window.localStorage.getItem(SEEN_KEY); } catch { return null; } };
const writeSeen = (day: string) => { try { window.localStorage.setItem(SEEN_KEY, day); } catch { /* Storage may be disabled. */ } };
const count = new Intl.NumberFormat('en-US');
const dateLabel = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).format(at);

function venueLine(event: VenueCrowd): string {
  const where = event.area === 'kenmore' ? 'Kenmore and the Green Line' : 'the B line by BU West';
  const crowd = event.estimateBasis === 'published-attendance' ? `about ${count.format(event.estimate)} (published attendance)`
    : event.estimateBasis === 'typical-attendance' ? `about ${count.format(event.estimate)} (estimate: typical published attendance for these events)`
      : `up to ${count.format(event.estimate)} (estimate: venue capacity)`;
  const when = event.timeTbd ? 'time TBD' : bostonTime(event.start);
  return `${event.name} at ${event.venue}, ${when}: ${crowd}; expect crowds on ${where} before and after.`;
}

/** "Today at a glance": open on the first visit each Boston day, collapsed after that. */
export function TodayBrief({ schedule, locations, geo, hours, forecasts, profile, homeLocationId, campusEvents, venues, now, transit, loading }: {
  schedule: ScheduleItem[]; locations: CampusLocation[]; geo: CampusGeo; hours: StudyHoursByLocation; forecasts: HourlyForecast[];
  profile: Profile | null; homeLocationId: string | null; campusEvents: CampusEvent[]; venues: VenueCalendar | null;
  now: number; transit: TransitContext | undefined; loading: boolean;
}) {
  const today = bostonLocal(now).day;
  const [open, setOpen] = useState(() => briefStartsOpen(readSeen(), today));
  useEffect(() => { writeSeen(today); }, [today]);
  const minute = Math.floor(now / 60_000);
  const brief = useMemo(() => loading ? null : composeBrief({ schedule, locations, geo, hours, forecasts, profile, homeLocationId, campusEvents, venues, now: minute * 60_000, transit }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, schedule, locations, geo, hours, forecasts, profile, homeLocationId, campusEvents, venues, transit, minute]);
  if (!brief) return null;
  const name = (id: string | null) => locations.find((l) => l.id === id)?.name ?? 'your building';
  const first = brief.firstClass;
  const lunchLevel = brief.lunch ? crowdFor(brief.lunch.share) : null;
  const summary = [
    first ? `${first.label === 'first' ? 'First class' : 'Next'} ${bostonTime(first.item.start)}${first.leaveBy !== null ? `, leave by ${bostonTime(first.leaveBy)}` : ''}`
      : brief.classCount ? 'Classes done' : 'No classes',
    brief.lunch ? `lunch ${bostonTime(brief.lunch.start)}` : null,
    brief.venueEvents.length ? `${brief.venueEvents.length} venue ${brief.venueEvents.length === 1 ? 'event' : 'events'} nearby` : null,
  ].filter(Boolean).join(' · ');
  return (
    <details className={styles.card} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <span className={styles.title}>Today at a glance</span>
        <span className={styles.muted}>{dateLabel(now)} · {summary}</span>
      </summary>
      <ul className={styles.items}>
        <li>
          <span className={styles.label}>{first?.label === 'next' ? 'Next class' : 'First class'}</span>
          {first ? <span>
            <strong>{first.item.title}</strong> at {bostonTime(first.item.start)} in {first.item.locationText || name(first.item.locationId)}
            {first.leaveBy !== null ? <> · leave by <strong>{bostonTime(first.leaveBy)}</strong> ({first.walkMinutes} min walk from {name(first.from)}, 5 min buffer)</>
              : first.label === 'first' && !homeLocationId ? <> · <Link to="/profile">set your home building</Link> for a leave-by time</> : null}
            {first.transit && <span className={styles.detail}>Or {first.transit.routeName}: leave by {bostonTime(first.transit.leaveBy)}, departs {first.transit.boardStop.name} {bostonTime(first.transit.departure)} ({departureBasisLabel(first.transit)})</span>}
          </span> : <span>{brief.classCount ? 'No more classes today.' : schedule.length ? 'No imported classes today.' : <><Link to="/calendars">Import your .ics schedule</Link> to see your first class.</>}</span>}
        </li>
        <li>
          <span className={styles.label}>Lunch</span>
          {brief.lunch && lunchLevel ? <span>
            <strong>{name(brief.lunch.locationId)} at {bostonTime(brief.lunch.start)}</strong>
            {' '}· <i className={styles.dot} style={{ background: lunchLevel.color }} aria-hidden />projected {lunchLevel.label.toLowerCase()}, the quietest open hour near your {brief.lunch.lunchTime} lunch time
          </span> : <span>No dining hall with published hours and a crowd projection fits around your lunch time.</span>}
        </li>
        {brief.earlyClosings.length > 0 && <li>
          <span className={styles.label}>Libraries</span>
          <span>{brief.earlyClosings.map((closing, i) => <span key={closing.locationId} className={i ? styles.detail : undefined}>
            <strong>{name(closing.locationId)}</strong> {closing.closesAt === null ? 'is closed today' : <>closes <strong>{bostonTime(closing.closesAt)}</strong> today</>}
            {' '}(usually {bostonTime(closing.usualClosesAt)} on {weekdayName(brief.day)}s, published hours)
          </span>)}</span>
        </li>}
        <li>
          <span className={styles.label}>On campus</span>
          {brief.campusEvents.length ? <span>
            {brief.campusEvents.slice(0, MAX_CAMPUS_EVENTS).map((e) => `${e.title} ${bostonTime(e.start)}`).join(' · ')}
            {brief.campusEvents.length > MAX_CAMPUS_EVENTS && <> · <Link to="/events">{brief.campusEvents.length - MAX_CAMPUS_EVENTS} more</Link></>}
          </span> : <span>No campus events listed for the rest of today.</span>}
        </li>
        {brief.venueEvents.length > 0 && <li>
          <span className={styles.label}>Game & event day</span>
          <span>{brief.venueEvents.map((event, i) => <span key={event.id} className={i ? styles.detail : undefined}>{venueLine(event)}</span>)}</span>
        </li>}
      </ul>
      <p className={styles.note}>Crowd levels are model projections built from real day-to-day data (MBTA ridership, pedestrian and FitRec counts, published class schedules and hours), not live head counts. Hours are BU's published hours. Venue crowd sizes are estimates: the event's published box-score attendance, else the typical published attendance for that kind of event there, else the venue's capacity as an upper bound.</p>
    </details>
  );
}
