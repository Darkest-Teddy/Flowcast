import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useResource } from '../data/api';
import type { StudyAmenity } from '../data/studySpots';
import { findStudySpots } from '../lib/studyFinder';
import { bostonTime, getDeparturePlan } from '../lib/departure';
import { answerMapLink } from '../lib/askMapLink';
import { config } from '../config';
import { Button, EmptyState, Loading, Page, PageHeader, SelectField } from '../ui';
import { useDepartureClock } from './student/DepartureCard';
import styles from './Study.module.css';

const amenityLabels: Record<StudyAmenity, string> = { quiet: 'Silent study', group: 'Group work', outlets: 'Power outlets', whiteboard: 'Whiteboard', food: 'Food allowed' };
const amenityKeys = Object.keys(amenityLabels) as StudyAmenity[];
const emptyGeo = { positions: {}, walkMeters: {} };

export default function Study() {
  const spots = useResource(api.getStudySpots);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const hours = useResource(api.getStudyHours);
  const forecasts = useResource(api.getHourlyForecasts);
  const schedule = useResource(api.getSchedule);
  const profile = useResource(api.getProfile);
  const now = useDepartureClock();
  const [origin, setOrigin] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [amenities, setAmenities] = useState<StudyAmenity[]>([]);
  const [openOnly, setOpenOnly] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [maxWalk, setMaxWalk] = useState<number | null>(null);
  const [sort, setSort] = useState<'time' | 'walk' | 'crowd'>('time');
  const defaults = getDeparturePlan({ items: schedule.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo, now, homeLocationId: profile.data?.homeLocationId ?? null });
  const from = origin ?? defaults.fromLocationId ?? '';
  const results = useMemo(() => findStudySpots({ spots: spots.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo,
    hours: hours.data ?? {}, forecasts: forecasts.data ?? [], schedule: schedule.data ?? [], scheduleKnown: !!schedule.data && !schedule.error,
    now, from, minutes, amenities, openOnly, lateOnly, fitsOnly, maxWalk, sort }),
  [spots.data, locations.data, geo.data, hours.data, forecasts.data, schedule.data, schedule.error, now, from, minutes, amenities, openOnly, lateOnly, fitsOnly, maxWalk, sort]);
  function reset() { setAmenities([]); setOpenOnly(false); setLateOnly(false); setFitsOnly(false); setMaxWalk(null); }
  const resources = [spots, locations, geo, hours, forecasts, schedule, profile];
  const loading = resources.some(r => r.loading);

  return <Page>
    <PageHeader title="Find a study spot" description="Choose what you need, then see how much time you can spend there." />
    <section className={styles.filters} aria-label="Study preferences">
      <div className={styles.controls}>
        <SelectField label="Starting building" value={from} onChange={e => setOrigin(e.target.value)}>
          <option value="">Choose a building</option>
          {(locations.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </SelectField>
        <SelectField label="Study session" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
          {[15, 30, 45, 60, 90, 120, 180].map(n => <option key={n} value={n}>{n} minutes</option>)}
        </SelectField>
        <SelectField label="Maximum walk" value={maxWalk ?? ''} onChange={e => setMaxWalk(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any distance</option>{[5, 10, 15, 20].map(n => <option key={n} value={n}>{n} minutes</option>)}
        </SelectField>
      </div>
      <p className={styles.muted}>Confirm your starting building; this is not GPS. Walks use saved routes at 1.4 m/s, plus a five-minute buffer before class.</p>
      <fieldset className={styles.amenities}><legend>What do you need?</legend>
        {amenityKeys.map(key => <label key={key}><input type="checkbox" checked={amenities.includes(key)} onChange={e => setAmenities(current => e.target.checked ? [...current, key] : current.filter(a => a !== key))} />{amenityLabels[key]}</label>)}
      </fieldset>
      <div className={styles.checks}>
        <label><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />Library open at arrival</label>
        <label><input type="checkbox" checked={lateOnly} onChange={e => setLateOnly(e.target.checked)} />Library open at 10 PM today</label>
        <label><input type="checkbox" checked={fitsOnly} onChange={e => setFitsOnly(e.target.checked)} />Full session fits before class</label>
      </div>
      <p className={styles.muted}>Filters require published confirmation. Unlisted amenities are unknown. Library hours do not guarantee room access or a free seat.</p>
      {!schedule.loading && !schedule.error && !schedule.data?.length && <p><Link to="/calendars">Import your classes</Link> to check conflicts. Without an import, study time only accounts for walking and library hours.</p>}
      {defaults.current && <p role="status">Your schedule has a class in progress until {bostonTime(defaults.current.end)}. No study session is marked as fitting now.</p>}
    </section>
    {resources.filter(r => r.error).map((r, i) => <p role="alert" key={i}>{r.error?.message} <Button size="sm" variant="ghost" onClick={r.reload}>Try again</Button></p>)}
    <div className={styles.resultsHeader}>
      <p role="status">{loading ? 'Checking study spaces…' : `${results.length} ${results.length === 1 ? 'space' : 'spaces'} match`}</p>
      <SelectField label="Sort by" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
        <option value="time">Most usable study time</option><option value="walk">Shortest walk</option><option value="crowd">Lowest projected crowd</option>
      </SelectField>
      <Button variant="ghost" size="sm" onClick={reset}>Clear filters</Button>
    </div>
    {loading ? <Loading label="Loading study spaces" /> : results.length === 0 ? <EmptyState title="No confirmed matches" body="Try removing a filter. Missing information does not mean an amenity is unavailable, and unknown hours cannot confirm a session fits." action={<Button onClick={reset}>Clear filters</Button>} /> : <div className={styles.results}>
      {results.map(result => {
        const { spot } = result;
        const point = geo.data?.positions[spot.locationId];
        const mapLink = point ? answerMapLink(config.mapUrl, [point]) : null;
        const unknown = amenityKeys.filter(key => spot.amenities[key] === undefined);
        return <article key={spot.id} className={styles.spot}>
          <div className={styles.spotHeading}><div><h2>{spot.name}</h2><p className={styles.muted}>{spot.area}</p></div>
            <p className={styles.time}>{result.usable === null ? 'Time unconfirmed' : `${result.usable} min potential study time`}</p>
          </div>
          <p>{result.walk === null ? 'Walk time unavailable' : `${result.walk} min walk · arrive ${bostonTime(result.arrival)}`} · {result.open === null ? 'Library hours unconfirmed' : result.open ? `Library open ${result.walk === null ? 'now' : 'at arrival'}` : `Library closed ${result.walk === null ? 'now' : 'at arrival'}`}</p>
          {result.reason && <p className={styles.muted}>{result.reason}</p>}
          {result.leaveAt !== null && <p>Study until {bostonTime(result.leaveAt)}{result.next && <> · {result.onwardWalk} min walk to {result.next.title}, with 5 min to arrive early</>}.</p>}
          <ul className={styles.features}>{amenityKeys.filter(key => spot.amenities[key] === true).map(key => <li key={key}>{amenityLabels[key]}</li>)}</ul>
          <p>{spot.notes}</p>
          <p className={styles.muted}>{result.crowd === null ? 'No crowd projection for this arrival.' : `Building crowd projection at arrival: ${Math.round(result.crowd * 100)}% of modeled capacity. Not a room-level seat count.`}</p>
          <details><summary>Amenity evidence & limitations</summary>
            {unknown.length > 0 && <p>Not verified: {unknown.map(key => amenityLabels[key].toLowerCase()).join(', ')}.</p>}
            <p>Power availability at individual seats and current room bookings are not known. Hours come from the saved campus dataset and may not cover today. All times are Boston time.</p>
            <p><a href={spot.sourceUrl} target="_blank" rel="noreferrer">BU space details</a> · Checked {spot.checkedAt}</p>
          </details>
          <div className={styles.actions}><Button href={spot.sourceUrl} target="_blank" rel="noreferrer" size="sm">Details & booking</Button><Button href={spot.hoursUrl} target="_blank" rel="noreferrer" size="sm" variant="ghost">Check current hours</Button>{mapLink && <Button href={mapLink} size="sm" variant="ghost">View building on map</Button>}</div>
        </article>;
      })}
    </div>}
  </Page>;
}
