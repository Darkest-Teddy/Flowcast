import { useMemo, useState } from 'react';
import { api, useResource } from '../../data/api';
import type { CampusGeo, CampusLocation } from '../../data/types';
import { bostonClock } from '../../lib/askRouting';
import { findFreeClassrooms } from '../../lib/freeClassrooms';
import { answerMapLink } from '../../lib/askMapLink';
import { config } from '../../config';
import { Button, EmptyState, Loading, SelectField, TextField } from '../../ui';
import styles from '../Study.module.css';

const SHOWN = 30;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "15:30" in seconds since midnight → "3:30 PM". */
function clockLabel(seconds: number) {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Classrooms with no published class right now, from the class schedule the map plays. */
export function ClassroomSearch({ from, onFrom, locations, geo, now }: {
  from: string;
  onFrom: (id: string) => void;
  locations: CampusLocation[];
  geo: CampusGeo;
  now: number;
}) {
  const meetings = useResource(api.getClassMeetings);
  const [minMinutes, setMinMinutes] = useState(30);
  const [maxWalk, setMaxWalk] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'walk' | 'free' | 'seats'>('walk');
  const [showAll, setShowAll] = useState(false);
  const { weekday, time } = bostonClock(new Date(now));
  // Shortest walk needs a starting building; without one the list is ordered by free time.
  const shownSort = sort === 'walk' && !from ? 'free' : sort;
  const found = useMemo(() => findFreeClassrooms({
    meetings: meetings.data ?? [], locations, geo, weekday, seconds: time, from, minMinutes, maxWalk, query, sort: shownSort,
  }), [meetings.data, locations, geo, weekday, time, from, minMinutes, maxWalk, query, shownSort]);
  const rooms = showAll ? found.rooms : found.rooms.slice(0, SHOWN);
  const filtered = maxWalk !== null || query.trim() !== '';

  return <>
    <section className={styles.filters} aria-label="Classroom search">
      <div className={styles.controls}>
        <SelectField label="Starting building" value={from} onChange={e => onFrom(e.target.value)}>
          <option value="">Choose a building</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </SelectField>
        <SelectField label="Free for at least" value={minMinutes} onChange={e => setMinMinutes(Number(e.target.value))}>
          {[15, 30, 60, 90, 120, 180].map(n => <option key={n} value={n}>{n} minutes</option>)}
        </SelectField>
        <SelectField label="Maximum walk" value={maxWalk ?? ''} onChange={e => setMaxWalk(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any distance</option>{[5, 10, 15, 20].map(n => <option key={n} value={n}>{n} minutes</option>)}
        </SelectField>
      </div>
      <TextField label="Building or room" placeholder="e.g. CAS, Questrom, 114" value={query} onChange={e => setQuery(e.target.value)} />
      {!from && <p className={styles.muted}>Choose your starting building to see walking times.</p>}
      <details className={styles.muted}><summary>About these results</summary>
        <p>Free means no published class is scheduled in the room on {WEEKDAYS[weekday]} at {clockLabel(time)}, using this term’s published class schedule. Only rooms that host a published class sometime in the week are listed, and only while their building is teaching: from its first class of the day to its last.</p>
        <p>Exams, events, office hours, reservations and building access aren’t in the data, so a free room may still be in use or locked. Seats are the room capacity BU publishes for its classes.</p>
      </details>
    </section>
    {meetings.error && <p role="alert">{meetings.error.message} <Button size="sm" variant="ghost" onClick={meetings.reload}>Try again</Button></p>}
    <div className={styles.resultsHeader}>
      <p role="status">{meetings.loading ? 'Checking classrooms…' : `${found.rooms.length} free ${found.rooms.length === 1 ? 'room' : 'rooms'} · ${found.busy} in class now`}</p>
      <SelectField label="Sort by" value={shownSort} onChange={e => setSort(e.target.value as typeof sort)}>
        <option value="walk" disabled={!from}>Shortest walk</option><option value="free">Free the longest</option><option value="seats">Most seats</option>
      </SelectField>
      {filtered && <Button variant="ghost" size="sm" onClick={() => { setMaxWalk(null); setQuery(''); }}>Clear search</Button>}
    </div>
    {meetings.loading ? <Loading label="Loading the class schedule" />
      : !found.classesToday ? <EmptyState title={`No classes are published for ${WEEKDAYS[weekday]}`} body="Classroom buildings may be locked when no classes run. Try a study space instead." />
      : found.rooms.length === 0 && found.busy === 0 ? <EmptyState
          title={found.nextStart !== null ? `Classes start at ${clockLabel(found.nextStart)}` : 'Classes are over for today'}
          body="Classroom buildings may be locked outside class hours. Try a study space instead." />
      : found.rooms.length === 0 ? <EmptyState title="No free classrooms match" body="Try a shorter free time, a longer walk, or a different building." action={filtered ? <Button onClick={() => { setMaxWalk(null); setQuery(''); }}>Clear search</Button> : undefined} />
      : <>
        <div className={styles.results}>
          {rooms.map(r => {
            const point = geo.positions[r.locationId];
            const mapLink = point ? answerMapLink(config.mapUrl, [point]) : null;
            return <article key={`${r.locationId}|${r.room}`} className={styles.spot}>
              <div className={styles.spotHeading}>
                <p className={styles.availability}>{r.freeUntil === null ? 'No more classes in this room today' : `No class until ${clockLabel(r.freeUntil)}`}</p>
                <h2>{r.building} {r.room}</h2>
              </div>
              <dl className={styles.metrics}>
                <div><dt>Walk</dt><dd>{r.walk === null ? '—' : `${r.walk} min`}</dd></div>
                <div><dt>Free for</dt><dd>{r.freeMinutes >= 60 ? `${Math.floor(r.freeMinutes / 60)} h ${r.freeMinutes % 60} min` : `${r.freeMinutes} min`}</dd></div>
                <div><dt>Seats</dt><dd>{r.seats ?? '—'}</dd></div>
              </dl>
              {mapLink && <div className={styles.actions}><Button href={mapLink} size="sm" variant="ghost">View on map</Button></div>}
            </article>;
          })}
        </div>
        {found.rooms.length > SHOWN && <p className={styles.more}><Button variant="secondary" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : `Show all ${found.rooms.length} rooms`}</Button></p>}
      </>}
  </>;
}
