import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CampusGeo, CampusLocation, ScheduleItem } from '../../data/types';
import { config } from '../../config';
import { answerMapLink } from '../../lib/askMapLink';
import { bostonDay, bostonDateTime, bostonTime, getDeparturePlan } from '../../lib/departure';
import { departureBasisLabel, exclusionLabel, type TransitPlan } from '../../lib/transitDeparture';
import { useCampusTransit, useLiveDepartures } from '../../lib/transitTimetables';
import { SelectField } from '../../ui';
import styles from './DepartureCard.module.css';

export function useDepartureClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return now;
}

export function DepartureCard({ items, locations, geo, homeLocationId, now, loading, compact = false }: {
  items: ScheduleItem[]; locations: CampusLocation[]; geo: CampusGeo;
  homeLocationId: string | null; now: number; loading: boolean; compact?: boolean;
}) {
  const [selection, setSelection] = useState<{ target: string; id: string } | null>(null);
  const [buffer, setBuffer] = useState(5);
  const transit = useCampusTransit();
  const defaults = getDeparturePlan({ items, locations, geo, now, homeLocationId, bufferMinutes: buffer });
  const input = { items, locations, geo, now, homeLocationId, bufferMinutes: buffer,
    fromLocationId: selection?.target === defaults.target?.id ? selection?.id : undefined };
  // Predictions are polled for the timetable plan's trip, so a live update cannot switch what is polled.
  const timetablePlan = getDeparturePlan({ ...input, transit: transit.context });
  const live = useLiveDepartures(timetablePlan.transit?.status === 'offered' ? timetablePlan.transit.option : null, now);
  const plan = live.length && transit.context ? getDeparturePlan({ ...input, transit: { ...transit.context, live } }) : timetablePlan;
  const target = plan.target;
  if (loading) return <section className={styles.card} aria-label="Next class">Loading your next class…</section>;
  if (!target) return <section className={styles.card} aria-label="Next class">
    <h2>No upcoming classes</h2><p><Link to="/calendars">Import or update your .ics schedule</Link></p>
  </section>;
  const destination = locations.find((location) => location.id === target.locationId);
  const points = [plan.fromLocationId ? geo.positions[plan.fromLocationId] : undefined, geo.positions[target.locationId]]
    .filter((point): point is [number, number] => !!point);
  const mapLink = plan.routeStatus === 'ready' ? answerMapLink(config.mapUrl, points) : null;
  const routeControls = <>
    <div className={styles.controls}>
      <SelectField label="From" value={plan.fromLocationId ?? ''} onChange={(event) => setSelection({ target: target.id, id: event.target.value })}>
        <option value="">Choose a building</option>
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
      </SelectField>
      <SelectField label="Arrival buffer" value={buffer} onChange={(event) => setBuffer(Number(event.target.value))}>
        {[0, 5, 10].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
      </SelectField>
    </div>
    {plan.originSource !== 'selected' && <p className={styles.muted}>{plan.originSource === 'schedule' ? 'Starting point from your schedule. Change it if needed.' : plan.originSource === 'home' ? 'Starting from your saved home.' : 'Choose a starting building for a departure estimate.'}</p>}
  </>;
  return <section className={styles.card} aria-label="Class departure">
    {plan.current && plan.next && <p className={styles.muted}>In progress: {plan.current.title} · until {bostonTime(plan.current.end)} Boston time</p>}
    {compact && plan.leaveBy !== null && <div className={styles.nextAction} aria-live="polite">
      <p className={styles.actionLabel}>Leave by</p>
      <time className={styles.actionTime} dateTime={new Date(plan.leaveBy).toISOString()}>{bostonTime(plan.leaveBy)}</time>
      {bostonDay(plan.leaveBy) !== bostonDay(now) && <p className={styles.muted}>{bostonDateTime(plan.leaveBy)}</p>}
    </div>}
    <p className={styles.muted}>{plan.next ? 'Next class' : 'Class in progress'} · {bostonDateTime(target.start)}–{bostonTime(target.end)}</p>
    <h2>{target.title}</h2>
    <p>{target.locationText || destination?.name || 'Building not mapped'}</p>
    {!compact && routeControls}
    {plan.leaveBy !== null ? <div aria-live="polite">
      {!compact && <p className={styles.departure}>Leave by {bostonDateTime(plan.leaveBy)}</p>}
      <p>{plan.walkMinutes} min walk · {buffer} min buffer{mapLink && <> · <a href={mapLink}>View route area</a></>}</p>
      {now >= plan.leaveBy && <p>{plan.lateMinutes ? `Leave now · arriving ${plan.lateMinutes} min after your ${bostonTime(plan.arrivalTarget!)} arrival target.` : 'Leave now'}</p>}
    </div> : <p>{plan.routeStatus === 'unmapped-destination' ? 'Departure unavailable: class building is not mapped.' : plan.routeStatus === 'no-route' ? 'No walking route between these buildings.' : null}</p>}
    <TransitOptionLine plan={plan.transit} walking={plan.leaveBy !== null} now={now} />
    {transit.failed.includes('mbta') && plan.routeStatus === 'no-route' && <p className={styles.muted}>MBTA timetable unavailable, so no transit option.</p>}
    {(plan.overlap || plan.ambiguousCurrent || (plan.connectionShortfallMinutes ?? 0) > 0) && <p role="alert" className={styles.warning}>
      {plan.overlap || plan.ambiguousCurrent ? 'Classes overlap. Confirm your starting building.' : `The previous class ends too late for this connection (${plan.connectionShortfallMinutes} min short, including buffer). Confirm your starting building.`}
    </p>}
    {compact && <details className={styles.adjustments} open={!plan.fromLocationId || undefined}>
      <summary>Adjust starting point & arrival buffer</summary>
      {routeControls}
    </details>}
  </section>;
}

/** The second way there: walk to a stop, a published trip, walk to class. Silent when walking is better. */
function TransitOptionLine({ plan, walking, now }: { plan: TransitPlan | null; walking: boolean; now: number }) {
  if (!plan) return null;
  const notes = plan.excluded.map(exclusionLabel);
  const option = plan.status === 'offered' ? plan.option : null;
  if (!option) {
    const reason = plan.status === 'no-trip' ? 'No published trip from nearby stops reaches this class in time.'
      : plan.status === 'not-covered' ? 'No published timetable covers this date.'
        : plan.status === 'no-stops' && !walking ? 'No mapped transit stop has a walking route to these buildings.' : null;
    return reason || (notes.length && !walking) ? <p className={styles.muted}>{[reason, ...(walking ? [] : notes)].filter(Boolean).join(' ')}</p> : null;
  }
  const versus = plan.reason === 'leave-later' && plan.versusWalkMinutes ? ` · leave ${plan.versusWalkMinutes} min later than walking`
    : plan.reason === 'less-walking' ? ` · ${option.walkToStopMinutes + option.walkFromStopMinutes} min on foot instead of the long walk` : '';
  return <div className={styles.option} aria-live="polite">
    <p className={styles.departure}>{walking ? 'Or by' : 'By'} {option.routeName}: leave by {bostonDateTime(option.leaveBy)}</p>
    <p>{option.walkToStopMinutes} min walk to {option.boardStop.name} · {option.routeName}{option.toward ? ` ${option.toward}` : ''} departs {bostonTime(option.departure)}
      {' '}· {option.rideMinutes} min to {option.alightStop.name} · {option.walkFromStopMinutes} min walk</p>
    <p>Arrive {bostonTime(option.atClass)}, {option.marginMinutes} min before class{versus}</p>
    {now >= option.leaveBy - 60_000 && <p>Leave now for this trip.</p>}
    <p className={styles.muted}>{departureBasisLabel(option)}.{notes.length ? ` ${notes.join(' ')}` : ''}</p>
  </div>;
}
