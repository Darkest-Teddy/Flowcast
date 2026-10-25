import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useResource } from '../data/api';
import type { StudyAmenity } from '../data/studySpots';
import { findStudySpots } from '../lib/studyFinder';
import { bostonTime, getDeparturePlan } from '../lib/departure';
import { answerMapLink } from '../lib/askMapLink';
import { config } from '../config';
import { Button, EmptyState, Loading, Page, PageHeader, Segmented, SelectField } from '../ui';
import { useDepartureClock } from './student/DepartureCard';
import { CrowdReportNow, rememberCrowdSuggestion } from './student/CrowdReport';
import { StudyExamSeason } from './StudyExamSeason';
import { ClassroomSearch } from './study/ClassroomSearch';
import styles from './Study.module.css';

const amenityLabels: Record<StudyAmenity, string> = { quiet: 'Silent study', group: 'Group work', outlets: 'Power outlets', whiteboard: 'Whiteboard', food: 'Food allowed' };
const amenityKeys = Object.keys(amenityLabels) as StudyAmenity[];
const emptyGeo = { positions: {}, walkMeters: {} };

type StudyMode = 'all' | 'exam' | 'late' | 'classrooms';
const modes: { value: StudyMode; label: string; description: string }[] = [
  { value: 'all', label: 'All spaces', description: 'Every study space, with the filters you choose.' },
  { value: 'exam', label: 'Exam', description: 'Silent spaces with power, open when you arrive, least crowded first, for a two-hour session that fits before your next class. Crowd projections are for a normal week, not finals.' },
  { value: 'late', label: 'Late night', description: 'Spaces still open at 10 PM tonight, closest first. The simulation doesn’t model crowds after midnight.' },
  { value: 'classrooms', label: 'Classrooms', description: 'Classrooms with no published class right now. Exams, events, office hours and building access aren’t in the data, so a room may still be in use or locked.' },
];

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
  const [mode, setMode] = useState<StudyMode>('all');
  const defaults = getDeparturePlan({ items: schedule.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo, now, homeLocationId: profile.data?.homeLocationId ?? null });
  const from = origin ?? defaults.fromLocationId ?? '';
  const results = useMemo(() => findStudySpots({ spots: spots.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo,
    hours: hours.data ?? {}, forecasts: forecasts.data ?? [], schedule: schedule.data ?? [], scheduleKnown: !!schedule.data && !schedule.error,
    now, from, minutes, amenities, openOnly, lateOnly, fitsOnly, maxWalk, sort }),
  [spots.data, locations.data, geo.data, hours.data, forecasts.data, schedule.data, schedule.error, now, from, minutes, amenities, openOnly, lateOnly, fitsOnly, maxWalk, sort]);
  function reset() { setAmenities([]); setOpenOnly(false); setLateOnly(false); setFitsOnly(false); setMaxWalk(null); setMode('all'); }
  const scheduleKnown = !!schedule.data && !schedule.error;
  /** Exam and Late night set the filters below; they stay editable afterwards. */
  function chooseMode(next: StudyMode) {
    setMode(next);
    if (next === 'exam') {
      setAmenities(['quiet', 'outlets']); setMinutes(120); setOpenOnly(!!from); setLateOnly(false);
      // Without a starting building or a known schedule no session can be confirmed to fit, so the check would hide everything.
      setFitsOnly(!!from && scheduleKnown); setSort('crowd');
    } else if (next === 'late') {
      setAmenities([]); setMinutes(60); setOpenOnly(!!from); setLateOnly(true); setFitsOnly(false); setSort('walk');
    } else if (next === 'all') {
      setAmenities([]); setOpenOnly(false); setLateOnly(false); setFitsOnly(false); setMaxWalk(null); setMinutes(60); setSort('time');
    }
  }
  const filterCount = amenities.length + Number(openOnly) + Number(lateOnly) + Number(fitsOnly) + Number(maxWalk !== null);
  const resources = [spots, locations, geo, hours, forecasts, schedule, profile];
  const loading = resources.some(r => r.loading);

  return <Page>
    <PageHeader title="Find a study spot" description="Choose a space for the time you have." />
    <StudyExamSeason now={now} from={from} locations={locations.data ?? []} geo={geo.data ?? emptyGeo} forecasts={forecasts.data ?? []} />
    <div className={styles.modes}>
      <Segmented label="Study mode" value={mode} onChange={chooseMode} options={modes.map(({ value, label }) => ({ value, label }))} />
      <p className={styles.muted}>{modes.find(m => m.value === mode)!.description}</p>
    </div>
    {mode === 'classrooms' ? <ClassroomSearch from={from} onFrom={setOrigin} locations={locations.data ?? []} geo={geo.data ?? emptyGeo} now={now} /> : <>
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
      <fieldset className={styles.amenities}><legend>What do you need?</legend>
        {amenityKeys.map(key => <label key={key}><input type="checkbox" checked={amenities.includes(key)} onChange={e => setAmenities(current => e.target.checked ? [...current, key] : current.filter(a => a !== key))} />{amenityLabels[key]}</label>)}
      </fieldset>
      <details className={styles.moreFilters}><summary>Hours & class conflicts{(openOnly || lateOnly || fitsOnly) && ` · ${Number(openOnly) + Number(lateOnly) + Number(fitsOnly)} selected`}</summary>
      <div className={styles.checks}>
        <label><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />Library open at arrival</label>
        <label><input type="checkbox" checked={lateOnly} onChange={e => setLateOnly(e.target.checked)} />Library open at 10 PM today</label>
        <label><input type="checkbox" checked={fitsOnly} onChange={e => setFitsOnly(e.target.checked)} />Full session fits before class</label>
      </div>
      </details>
      {!from && <p className={styles.muted}>Choose your starting building to compare walks and check how much study time fits.</p>}
      <details className={styles.muted}><summary>About these results</summary>
        <p>Only verified amenities match filters. Seats and room access aren’t guaranteed. Crowd projections describe the building, not available seats.</p>
        <p>Confirm your starting building. Walking estimates use saved routes at 1.4 m/s and allow five minutes before class. All times are Boston time.</p>
        <p>Hours are from a saved snapshot; check current hours before leaving. Individual seat power and current bookings are unknown.</p>
      </details>
      {!schedule.loading && !schedule.error && !schedule.data?.length && <p><Link to="/calendars">Import your classes</Link> to check for class conflicts.</p>}
      {defaults.current && <p role="status">In class until {bostonTime(defaults.current.end)}; no session fits now.</p>}
    </section>
    {resources.filter(r => r.error).map((r, i) => <p role="alert" key={i}>{r.error?.message} <Button size="sm" variant="ghost" onClick={r.reload}>Try again</Button></p>)}
    <div className={styles.resultsHeader}>
      <p role="status">{loading ? 'Checking study spaces…' : `${results.length} ${results.length === 1 ? 'space' : 'spaces'} match`}</p>
      <SelectField label="Sort by" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
        <option value="time">Most usable study time</option><option value="walk">Shortest walk</option><option value="crowd">Lowest projected crowd</option>
      </SelectField>
      {filterCount > 0 && <Button variant="ghost" size="sm" onClick={reset}>Clear filters ({filterCount})</Button>}
    </div>
    {loading ? <Loading label="Loading study spaces" /> : results.length === 0 ? <EmptyState title="No confirmed matches" body="Try fewer filters. Spaces with unverified amenities or hours may be excluded." action={<Button onClick={reset}>Clear filters</Button>} /> : <div className={styles.results}>
      {results.map(result => {
        const { spot } = result;
        const point = geo.data?.positions[spot.locationId];
        const mapLink = point ? answerMapLink(config.mapUrl, [point]) : null;
        const unknown = amenityKeys.filter(key => spot.amenities[key] === undefined);
        return <article key={spot.id} className={styles.spot}>
          <div className={styles.spotHeading}>
            <p className={styles.availability}>{result.open === null ? 'Hours unconfirmed' : result.open ? `Library open ${result.walk === null ? 'now' : 'at arrival'}` : `Library closed ${result.walk === null ? 'now' : 'at arrival'}`}</p>
            <h2>{spot.name}</h2><p className={styles.muted}>{spot.area}</p>
          </div>
          <dl className={styles.metrics}>
            <div><dt>Walk</dt><dd>{result.walk === null ? '—' : `${result.walk} min`}</dd></div>
            <div><dt>Study time</dt><dd>{result.usable === null ? '—' : `${result.usable} min`}</dd></div>
            <div><dt>Projected crowd</dt><dd>{result.crowd === null ? '—' : `${Math.round(result.crowd * 100)}%`}</dd></div>
          </dl>
          {result.reason && result.reason !== 'Closed at your estimated arrival.' && (from || !schedule.data || defaults.current) && <p className={styles.muted}>{result.reason}</p>}
          {result.leaveAt !== null && <p className={styles.session}>Arrive {bostonTime(result.arrival)} · Study until {bostonTime(result.leaveAt)}{result.next && <> · {result.onwardWalk} min walk to {result.next.title}, plus a 5 min buffer</>}.</p>}
          <ul className={styles.features}>{amenityKeys.filter(key => spot.amenities[key] === true).map(key => <li key={key}>{amenityLabels[key]}</li>)}</ul>
          <p>{spot.notes}</p>
          <details><summary>Space details & sources</summary>
            {result.crowd === null && <p>No crowd projection for this arrival.</p>}
            {unknown.length > 0 && <p>Not verified: {unknown.map(key => amenityLabels[key].toLowerCase()).join(', ')}.</p>}
            <p><a href={spot.sourceUrl} target="_blank" rel="noreferrer">BU space details</a> · Checked {spot.checkedAt}</p>
            <CrowdReportNow locationId={spot.locationId} name={spot.name} />
          </details>
          <div className={styles.actions}><Button href={spot.sourceUrl} target="_blank" rel="noreferrer" size="sm" onClick={() => rememberCrowdSuggestion(spot.locationId, result.arrival, 'study')}>Details & booking</Button><Button href={spot.hoursUrl} target="_blank" rel="noreferrer" size="sm" variant="ghost">Check current hours</Button>{mapLink && <Button href={mapLink} size="sm" variant="ghost" onClick={() => rememberCrowdSuggestion(spot.locationId, result.arrival, 'study')}>View on map</Button>}</div>
        </article>;
      })}
    </div>}
    </>}
  </Page>;
}
