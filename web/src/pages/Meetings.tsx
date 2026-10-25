import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, useResource } from '../data/api';
import { findMeetings, meetingIcs, type MeetingItem } from '../lib/clubMeetings';
import { officerMeetingEvents, perkSummary } from '../lib/orgs';
import { WeatherNote } from './club/MeetingTools';
import { FairTab } from './meetings/FairTab';
import { answerMapLink } from '../lib/askMapLink';
import { config } from '../config';
import { Button, EmptyState, Loading, Page, PageHeader, Segmented, SelectField, Tag, TextField } from '../ui';
import { PlanEvent } from './club/PlanEvent';
import { ConflictCheck, MemberFreeTime, TurnoutPreview } from './meetings/PlanTools';
import { TablingSpots } from './meetings/TablingSpots';
import { Updates } from './meetings/Updates';
import { useOrgState, type OrgState } from './meetings/useOrgState';
import styles from './Meetings.module.css';

type Tab = 'find' | 'plan' | 'tabling' | 'fair' | 'updates';
const TABS: Tab[] = ['find', 'plan', 'tabling', 'fair', 'updates'];
const RANGES = [{ value: '7', label: 'Next 7 days' }, { value: '30', label: 'Next 30 days' }, { value: 'all', label: 'All upcoming' }];
const emptyGeo = { positions: {}, walkMeters: {} };

const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

export function meetingWhen(item: MeetingItem) {
  const start = new Date(item.event.start);
  const end = item.event.end ? new Date(item.event.end) : null;
  if (item.kind === 'series') return `Listed ${dateOnly.format(start)} – ${dateOnly.format(end!)}, ${timeOnly.format(start)}–${timeOnly.format(end!)}`;
  return `${dayTime.format(start)}${end ? `–${timeOnly.format(end)}` : ''}`;
}

export function downloadMeeting(item: MeetingItem) {
  const ics = meetingIcs(item);
  if (!ics) return;
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${item.event.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'meeting'}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Club meetings: find where clubs meet, plan your own, find tabling spots, and read updates from clubs you follow. */
export default function Meetings() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? params.get('tab') as Tab : 'find';
  const setTab = (next: Tab) => setParams(next === 'find' ? {} : { tab: next }, { replace: true });
  const org = useOrgState();
  const notes = useResource(api.getClubNotifications);
  const unread = notes.data?.items.filter((n) => n.unread).length ?? 0;
  // The planner starts from the address: a headcount from RSVPs, or a day and hour picked from members' free time.
  const initial = {
    ...(Number(params.get('headcount')) > 0 ? { headcount: Math.min(2000, Math.round(Number(params.get('headcount')))) } : {}),
    ...(/^[0-6]$/.test(params.get('day') ?? '') ? { days: [Number(params.get('day'))] } : {}),
    ...(/^\d{2}:\d{2}$/.test(params.get('from') ?? '') ? { from: params.get('from')!, to: `${String(Math.min(23, Number(params.get("from")!.slice(0, 2)) + 3)).padStart(2, "0")}:00` } : {}),
  };

  return <Page>
    <PageHeader title="Club meetings" description="Find where student organizations meet, plan your own meeting, find a spot to table, and keep up with clubs you follow." />
    <div className={styles.tabs}>
      <Segmented label="Club meetings" value={tab} onChange={setTab} options={[
        { value: 'find', label: 'Find meetings' }, { value: 'plan', label: 'Plan a meeting' }, { value: 'tabling', label: 'Tabling spots' }, { value: 'fair', label: 'Activity fair' },
        { value: 'updates', label: unread ? `Updates (${unread})` : 'Updates' },
      ]} />
    </div>
    {org.error && <p role="alert" className={styles.error}>{org.error}</p>}
    {tab === 'find' && <FindMeetings org={org} />}
    {tab === 'plan' && <div className={styles.stack}>
      <MemberFreeTime officerOf={org.me.data?.officerOf ?? []} onUseHeadcount={(n) => setParams({ tab: 'plan', headcount: String(n) }, { replace: true })} onPick={(day, hour) => setParams({ tab: 'plan', day: String(day), from: `${String(hour).padStart(2, '0')}:00` }, { replace: true })} />
      <PlanEvent key={params.toString()} title="Find a room for your meeting" initial={initial} />
      <ConflictCheck />
      <TurnoutPreview />
    </div>}
    {tab === 'tabling' && <TablingSpots />}
    {tab === 'fair' && <FairTab org={org} />}
    {tab === 'updates' && <Updates notes={notes} />}
  </Page>;
}

function FindMeetings({ org }: { org: OrgState }) {
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState('30');
  const [onlyFollowing, setOnlyFollowing] = useState(false);
  const [foodOnly, setFoodOnly] = useState(false);
  const [now] = useState(Date.now);
  const following = useMemo(() => (clubs.data ?? []).filter((c) => c.following).map((c) => c.id), [clubs.data]);
  const clubNames = useMemo(() => new Map((clubs.data ?? []).map((c) => [c.id, c.name])), [clubs.data]);
  const home = profile.data?.homeLocationId ?? null;
  const all = useMemo(() => [...officerMeetingEvents(org.meetings.data?.meetings ?? [], clubNames), ...(events.data ?? [])], [org.meetings.data, clubNames, events.data]);
  const items = useMemo(() => findMeetings(all, locations.data ?? [], geo.data ?? emptyGeo, {
    query, following, onlyFollowing, withinDays: range === 'all' ? null : Number(range), now, home,
  }), [all, locations.data, geo.data, query, following, onlyFollowing, range, now, home]);
  const shown = foodOnly ? items.filter((i) => i.event.perks?.includes('food')) : items;
  const once = shown.filter((i) => i.kind === 'once');
  const series = shown.filter((i) => i.kind === 'series');
  const homeName = home ? locations.data?.find((l) => l.id === home)?.name : null;

  if (events.error) return <EmptyState title="Meetings didn’t load" body={events.error.message} action={<Button onClick={events.reload}>Try again</Button>} />;
  if (events.loading) return <Loading label="Loading club meetings" />;

  const card = (item: MeetingItem) => <MeetingCard key={item.event.id} item={item} geo={geo.data ?? emptyGeo} org={org} />;
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
      <label className={styles.check}>
        <input type="checkbox" checked={foodOnly} onChange={(e) => setFoodOnly(e.target.checked)} />
        Free food
      </label>
      <p className={styles.muted}>
        {homeName ? `Walks are from ${homeName}, your home building.` : 'Set your home building in Profile to see walking times.'}
        {' '}Meetings come from BU’s public Terrier Central listings and from verified club officers on Flowcast. Some listings only show their room to signed-in BU students on Terrier Central.
      </p>
    </section>

    <p role="status" className={styles.count}>{shown.length} {shown.length === 1 ? 'listing' : 'listings'}</p>
    {shown.length === 0 ? <EmptyState title="No meetings match" body={foodOnly ? 'No upcoming meeting lists free food yet. Club officers add it when they post a meeting.' : 'Try another search, a longer time range, or all clubs.'} />
      : <>
        {once.length > 0 && <ul className={styles.list} aria-label="Upcoming meetings">{once.map(card)}</ul>}
        {series.length > 0 && <>
          <h2 className={styles.heading}>Recurring listings</h2>
          <p className={styles.muted}>These are published as one date range with a time. The listing doesn’t say which weekdays they meet: check it before you go.</p>
          <ul className={styles.list} aria-label="Recurring listings">{series.map(card)}</ul>
        </>}
      </>}
  </>;
}

export function MeetingCard({ item, geo, org }: { item: MeetingItem; geo: { positions: Record<string, [number, number]> }; org: OrgState }) {
  const { event } = item;
  const point = event.locationId ? geo.positions[event.locationId] : undefined;
  const mapLink = point ? answerMapLink(config.mapUrl, [point]) : null;
  const where = event.venue ? `${event.venue}${item.building && !event.venue.startsWith(item.building) ? ` · ${item.building}` : ''}` : item.building;
  const going = org.going.has(event.id);
  const count = org.rsvpCount(event.id);
  const canRsvp = item.kind === 'once';
  return <li className={styles.card}>
    <p className={styles.when}>{meetingWhen(item)}{event.source === 'manual' && <> · <Tag tone="accent">Posted by the club</Tag></>}{event.seriesId && <> · <Tag>Weekly</Tag></>}</p>
    <h3>{event.title}</h3>
    {event.organizer && (event.clubId
      ? <Link className={styles.organizer} to={`/clubs/${encodeURIComponent(event.clubId)}`}>{event.organizer.replace(/\s+-\s+\d+$/, '')}</Link>
      : <p className={styles.organizer}>{event.organizer.replace(/\s+-\s+\d+$/, '')}</p>)}
    <p className={styles.where}>
      {where ?? <span className={styles.muted}>Room shown to signed-in BU students on the listing</span>}
      {item.walk !== null && <Tag>{item.walk} min walk</Tag>}
      {canRsvp && count > 0 && <Tag tone="ok">{count} going</Tag>}
      {perkSummary(event) && <Tag tone="accent">{perkSummary(event)}</Tag>}
      {event.outdoor && <Tag>Outdoors</Tag>}
    </p>
    {event.outdoor && Date.parse(event.start) - Date.now() < 7 * 86_400_000 && <WeatherNote start={event.start} end={event.end ?? event.start} />}
    <div className={styles.actions}>
      {canRsvp && <Button size="sm" variant={going ? 'secondary' : 'primary'} disabled={org.pending === event.id} aria-pressed={going}
        onClick={() => void org.setRsvp(event.id, !going)}>{going ? 'Going ✓' : 'Going?'}</Button>}
      {event.sourceUrl && <Button href={event.sourceUrl} target="_blank" rel="noreferrer" size="sm" variant="ghost">Listing</Button>}
      {mapLink && <Button href={mapLink} size="sm" variant="ghost">View on map</Button>}
      {canRsvp && <Button size="sm" variant="ghost" onClick={() => downloadMeeting(item)}>Add to calendar</Button>}
    </div>
  </li>;
}
