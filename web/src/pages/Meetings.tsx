import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, useResource } from '../data/api';
import { findMeetings, meetingIcs, type MeetingItem } from '../lib/clubMeetings';
import { answerMapLink } from '../lib/askMapLink';
import { config } from '../config';
import { Button, EmptyState, Loading, Page, PageHeader, Segmented, SelectField, Tag, TextField } from '../ui';
import { PlanEvent } from './club/PlanEvent';
import styles from './Meetings.module.css';

type Tab = 'find' | 'plan';
const RANGES = [{ value: '7', label: 'Next 7 days' }, { value: '30', label: 'Next 30 days' }, { value: 'all', label: 'All upcoming' }];
const emptyGeo = { positions: {}, walkMeters: {} };

const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

function when(item: MeetingItem) {
  const start = new Date(item.event.start);
  const end = item.event.end ? new Date(item.event.end) : null;
  if (item.kind === 'series') {
    return `Listed ${dateOnly.format(start)} – ${dateOnly.format(end!)}, ${timeOnly.format(start)}–${timeOnly.format(end!)}`;
  }
  return `${dayTime.format(start)}${end ? `–${timeOnly.format(end)}` : ''}`;
}

function download(item: MeetingItem) {
  const ics = meetingIcs(item);
  if (!ics) return;
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${item.event.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'meeting'}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Club meetings: find where clubs meet, or plan where your own club should meet. */
export default function Meetings() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'plan' ? 'plan' : 'find';
  const setTab = (next: Tab) => setParams(next === 'plan' ? { tab: 'plan' } : {}, { replace: true });

  return <Page>
    <PageHeader title="Club meetings" description="Find where student organizations meet, or find the best room and time for yours." />
    <div className={styles.tabs}>
      <Segmented label="Club meetings" value={tab} onChange={setTab} options={[{ value: 'find', label: 'Find meetings' }, { value: 'plan', label: 'Plan a meeting' }]} />
    </div>
    {tab === 'find' ? <FindMeetings /> : <PlanEvent title="Find a room for your meeting" />}
  </Page>;
}

function FindMeetings() {
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState('30');
  const [onlyFollowing, setOnlyFollowing] = useState(false);
  const [now] = useState(Date.now);
  const following = useMemo(() => (clubs.data ?? []).filter((c) => c.following).map((c) => c.id), [clubs.data]);
  const home = profile.data?.homeLocationId ?? null;
  const items = useMemo(() => findMeetings(events.data ?? [], locations.data ?? [], geo.data ?? emptyGeo, {
    query, following, onlyFollowing, withinDays: range === 'all' ? null : Number(range), now, home,
  }), [events.data, locations.data, geo.data, query, following, onlyFollowing, range, now, home]);
  const once = items.filter((i) => i.kind === 'once');
  const series = items.filter((i) => i.kind === 'series');
  const homeName = home ? locations.data?.find((l) => l.id === home)?.name : null;

  if (events.error) return <EmptyState title="Meetings didn’t load" body={events.error.message} action={<Button onClick={events.reload}>Try again</Button>} />;
  if (events.loading) return <Loading label="Loading club meetings" />;

  return <>
    <section className={styles.filters} aria-label="Find meetings">
      <div className={styles.controls}>
        <TextField label="Club, meeting or building" placeholder="e.g. debate, film, CAS" value={query} onChange={(e) => setQuery(e.target.value)} />
        <SelectField label="When" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </SelectField>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={onlyFollowing} onChange={(e) => setOnlyFollowing(e.target.checked)} disabled={!following.length} />
        Only clubs I follow{!following.length && ' (follow clubs on the Clubs page)'}
      </label>
      <p className={styles.muted}>
        {homeName ? `Walks are from ${homeName}, your home building.` : 'Set your home building in Profile to see walking times.'}
        {' '}Meetings come from BU’s public Terrier Central listings; some only show their room to signed-in BU students there.
      </p>
    </section>

    <p role="status" className={styles.count}>{items.length} {items.length === 1 ? 'listing' : 'listings'}</p>
    {items.length === 0 ? <EmptyState title="No meetings match" body="Try another search, a longer time range, or all clubs." />
      : <>
        {once.length > 0 && <ul className={styles.list} aria-label="Upcoming meetings">{once.map((item) => <MeetingCard key={item.event.id} item={item} geo={geo.data ?? emptyGeo} />)}</ul>}
        {series.length > 0 && <>
          <h2 className={styles.heading}>Recurring listings</h2>
          <p className={styles.muted}>These are published as one date range with a time. The listing doesn’t say which weekdays they meet: check it before you go.</p>
          <ul className={styles.list} aria-label="Recurring listings">{series.map((item) => <MeetingCard key={item.event.id} item={item} geo={geo.data ?? emptyGeo} />)}</ul>
        </>}
      </>}
  </>;
}

function MeetingCard({ item, geo }: { item: MeetingItem; geo: { positions: Record<string, [number, number]> } }) {
  const { event } = item;
  const point = event.locationId ? geo.positions[event.locationId] : undefined;
  const mapLink = point ? answerMapLink(config.mapUrl, [point]) : null;
  const where = event.venue ? `${event.venue}${item.building && !event.venue.startsWith(item.building) ? ` · ${item.building}` : ''}` : null;
  return <li className={styles.card}>
    <p className={styles.when}>{when(item)}</p>
    <h3>{event.title}</h3>
    {event.organizer && <p className={styles.organizer}>{event.organizer.replace(/\s+-\s+\d+$/, '')}</p>}
    <p className={styles.where}>
      {where ?? <span className={styles.muted}>Room shown to signed-in BU students on the listing</span>}
      {item.walk !== null && <Tag>{item.walk} min walk</Tag>}
    </p>
    <div className={styles.actions}>
      {event.sourceUrl && <Button href={event.sourceUrl} target="_blank" rel="noreferrer" size="sm">Listing</Button>}
      {mapLink && <Button href={mapLink} size="sm" variant="ghost">View on map</Button>}
      {item.kind === 'once' && <Button size="sm" variant="ghost" onClick={() => download(item)}>Add to calendar</Button>}
    </div>
  </li>;
}
