import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CampusGeo, CampusLocation, ScheduleItem } from '../../data/types';
import { config } from '../../config';
import { answerMapLink } from '../../lib/askMapLink';
import { bostonDateTime, bostonTime, getDeparturePlan } from '../../lib/departure';
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

export function DepartureCard({ items, locations, geo, homeLocationId, now, loading }: {
  items: ScheduleItem[]; locations: CampusLocation[]; geo: CampusGeo;
  homeLocationId: string | null; now: number; loading: boolean;
}) {
  const [selection, setSelection] = useState<{ target: string; id: string } | null>(null);
  const [buffer, setBuffer] = useState(5);
  const defaults = getDeparturePlan({ items, locations, geo, now, homeLocationId, bufferMinutes: buffer });
  const plan = getDeparturePlan({ items, locations, geo, now, homeLocationId, bufferMinutes: buffer,
    fromLocationId: selection?.target === defaults.target?.id ? selection?.id : undefined });
  const target = plan.target;
  if (loading) return <section className={styles.card} aria-label="Next class">Loading your next class…</section>;
  if (!target) return <section className={styles.card} aria-label="Next class">
    <h2>No upcoming classes</h2><p><Link to="/calendars">Import or update your .ics schedule</Link></p>
  </section>;
  const destination = locations.find((location) => location.id === target.locationId);
  const points = [plan.fromLocationId ? geo.positions[plan.fromLocationId] : undefined, geo.positions[target.locationId]]
    .filter((point): point is [number, number] => !!point);
  const mapLink = plan.routeStatus === 'ready' ? answerMapLink(config.mapUrl, points) : null;
  return <section className={styles.card} aria-label="Class departure">
    {plan.current && plan.next && <p className={styles.muted}>In progress: {plan.current.title} · until {bostonTime(plan.current.end)} Boston time</p>}
    <p className={styles.muted}>{plan.next ? 'Next class' : 'Class in progress'} · {bostonDateTime(target.start)}–{bostonTime(target.end)}</p>
    <h2>{target.title}</h2>
    <p>{target.locationText || destination?.name || 'Building not mapped'}</p>
    <div className={styles.controls}>
      <label>From
        <select aria-label="From" value={plan.fromLocationId ?? ''} onChange={(event) => setSelection({ target: target.id, id: event.target.value })}>
          <option value="">Choose a building</option>
          {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
      </label>
      <label>Arrival buffer
        <select aria-label="Arrival buffer" value={buffer} onChange={(event) => setBuffer(Number(event.target.value))}>
          {[0, 5, 10].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
        </select>
      </label>
    </div>
    <p className={styles.muted}>{plan.originSource === 'schedule' ? 'From your schedule; confirm where you are.' : plan.originSource === 'home' ? 'From your profile home; change if needed.' : plan.originSource === 'selected' ? 'Using your selected starting building.' : 'Choose your starting building to calculate a departure.'}</p>
    {plan.leaveBy !== null ? <div aria-live="polite">
      <p className={styles.departure}>Leave by {bostonDateTime(plan.leaveBy)}</p>
      <p>{plan.walkMinutes} min walk · {buffer} min buffer{mapLink && <> · <a href={mapLink}>View route area</a></>}</p>
      {now >= plan.leaveBy && <p>{plan.lateMinutes ? `Leave now · arriving ${plan.lateMinutes} min after your ${bostonTime(plan.arrivalTarget!)} arrival target.` : 'Leave now'}</p>}
    </div> : <p>{plan.routeStatus === 'unmapped-destination' ? 'Class building is not mapped. No departure estimate is available.' : plan.routeStatus === 'no-route' ? 'No saved walking route between these buildings. No departure estimate is available.' : 'No departure estimate until a starting building is selected.'}</p>}
    {(plan.overlap || plan.ambiguousCurrent || (plan.connectionShortfallMinutes ?? 0) > 0) && <p role="alert" className={styles.warning}>
      {plan.overlap || plan.ambiguousCurrent ? 'Classes overlap. Confirm your starting building.' : `The previous class ends too late for this connection (${plan.connectionShortfallMinutes} min short, including buffer). Confirm your starting building.`}
    </p>}
  </section>;
}
