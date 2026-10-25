import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useResource } from '../data/api';
import { formatDayLabel } from '../lib/format';
import { officerMeetingEvents, perkSummary } from '../lib/orgs';
import { Button, EmptyState, ExportMenu, Loading, Page, PageHeader, SectionList, Segmented, Tag } from '../ui';
import { download, exportName, toCsv, toIcs } from '../lib/exportData';
import { AgendaRow } from './student/AgendaRow';
import { groupByDay, isUpcoming } from './student/days';
import { eventDate, eventVenue, mapStatusText } from './student/events';
import { useOrgState } from './meetings/useOrgState';
import type { CampusEvent } from '../data/types';
import styles from './Events.module.css';

type Kind = 'all' | 'clubs' | 'games';
/** One row of the all-events list, whatever its source. */
interface AnyEvent extends CampusEvent { kind: 'listing' | 'club' | 'venue'; venueKind?: string }

const sinceDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const isoDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const SOURCE: Record<AnyEvent['kind'], string> = { listing: 'Terrier Central', club: 'Posted by the club', venue: 'Game or concert' };

/** Every event in one place: BU's public listings, meetings clubs post on Flowcast, and games and concerts nearby. */
export default function Events() {
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const [now] = useState(Date.now);
  const venue = useResource(() => api.getVenueEvents(isoDay(now), isoDay(now + 60 * 86_400_000)), [now]);
  const org = useOrgState();
  const [kind, setKind] = useState<Kind>('all');
  const [foodOnly, setFoodOnly] = useState(false);
  const [followingOnly, setFollowingOnly] = useState(false);
  const following = useMemo(() => new Set((clubs.data ?? []).filter((c) => c.following).map((c) => c.id)), [clubs.data]);
  const all = useMemo<AnyEvent[]>(() => {
    const names = new Map((clubs.data ?? []).map((c) => [c.id, c.name]));
    return [
      ...(events.data ?? []).map((e) => ({ ...e, kind: 'listing' as const })),
      ...officerMeetingEvents(org.meetings.data?.meetings ?? [], names).map((e) => ({ ...e, kind: 'club' as const })),
      ...(venue.data?.events ?? []).map((e) => ({ id: e.id, title: e.title, locationId: e.locationId, venue: e.venue, start: e.start, end: e.end, organizer: null, clubId: null,
        source: 'university' as const, mapStatus: 'location-unmapped' as const, kind: 'venue' as const, venueKind: e.kind })),
    ];
  }, [events.data, org.meetings.data, venue.data, clubs.data]);

  const header = <PageHeader title="Events" description="Everything on campus: BU’s public listings, meetings clubs post on Flowcast, and games and concerts nearby." />;
  if (events.error) return <Page>{header}<EmptyState title="Events didn't load" body={events.error.message} action={<Button onClick={events.reload}>Try again</Button>} /></Page>;
  if (!events.data) return <Page>{header}<Loading label="Loading events" /></Page>;

  // Multi-day listings stay visible while they're still running.
  const upcoming = all.filter((e) => isUpcoming(e.end ?? e.start));
  const visible = upcoming.filter((e) => (kind === 'all' || (kind === 'games') === (e.kind === 'venue'))
    && (!foodOnly || e.perks?.includes('food'))
    && (!followingOnly || (e.clubId && following.has(e.clubId))));
  const running = visible.filter((e) => !isUpcoming(e.start)).sort((a, b) => a.start.localeCompare(b.start));
  const groups = groupByDay(visible.filter((e) => isUpcoming(e.start)), (e) => e.start);
  const listed = [...running, ...groups.flatMap((g) => g.items)];
  const count = (k: Kind) => upcoming.filter((e) => k === 'all' || (k === 'games') === (e.kind === 'venue')).length;
  const exportOptions = [
    {
      label: 'Events (CSV)',
      detail: `The ${listed.length} events in this view`,
      run: () => download(exportName('events', 'csv'), toCsv(
        ['title', 'start', 'end', 'venue', 'organizer', 'source', 'offers', 'source_url'],
        listed.map((e) => [e.title, e.start, e.end ?? '', eventVenue(e), e.organizer ?? '', SOURCE[e.kind], perkSummary(e), e.sourceUrl ?? '']),
      ), 'text/csv'),
    },
    {
      label: 'Add to your calendar (.ics)',
      detail: 'Google, Apple or Outlook',
      run: () => download(exportName('events', 'ics'), toIcs('Flowcast campus events', listed.map((e) => ({
        uid: e.id, title: e.title, start: e.start, end: e.end, location: e.venue, url: e.sourceUrl,
        description: [e.organizer && `Hosted by ${e.organizer}`, perkSummary(e), SOURCE[e.kind]].filter(Boolean).join('. '),
      }))), 'text/calendar'),
    },
  ];
  const row = (e: AnyEvent, timeLabel?: string) => {
    const single = !e.end || eventDate(e) === e.end.slice(0, 10);
    const going = org.going.has(e.id);
    const n = org.rsvpCount(e.id);
    return <AgendaRow
      key={e.id}
      start={e.start}
      timeLabel={timeLabel}
      end={!timeLabel && e.end && single ? e.end : undefined}
      title={e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
      meta={<>{eventVenue(e)}{e.organizer ? <>, hosted by {e.clubId ? <Link to={`/clubs/${encodeURIComponent(e.clubId)}`}>{e.organizer.replace(/\s+-\s+\d+$/, '')}</Link> : e.organizer}</> : null}</>}
      note={<span className={styles.tags}>
        <Tag tone={e.kind === 'club' ? 'accent' : 'off'}>{SOURCE[e.kind]}</Tag>
        {perkSummary(e) && <Tag tone="ok">{perkSummary(e)}</Tag>}
        {n > 0 && <Tag>{n} going</Tag>}
        {e.kind === 'listing' && <span>{mapStatusText(e)}</span>}
      </span>}
      aside={<>
        {e.kind !== 'venue' && single && !timeLabel && <Button size="sm" variant={going ? 'secondary' : 'primary'} disabled={org.pending === e.id} onClick={() => void org.setRsvp(e.id, !going)}>{going ? 'Going ✓' : 'Going?'}</Button>}
        {e.mapStatus === 'simulated' && e.kind === 'listing' && <Button size="sm" variant="ghost" to={`/event-impact?date=${eventDate(e)}`}>Crowd impact</Button>}
      </>}
    />;
  };

  return (
    <Page>
      <PageHeader
        title="Events"
        description="Everything on campus: BU’s public listings, meetings clubs post on Flowcast, and games and concerts nearby."
        actions={<>{listed.length > 0 && <ExportMenu options={exportOptions} />}<Button to="/event-impact">See crowd impact by date</Button></>}
      />
      <div className={styles.filters}>
        <Segmented label="Show" value={kind} onChange={setKind} options={[
          { value: 'all', label: `All (${count('all')})` }, { value: 'clubs', label: `Clubs & campus (${count('clubs')})` }, { value: 'games', label: `Games & concerts (${count('games')})` },
        ]} />
        <label><input type="checkbox" checked={foodOnly} onChange={(e) => setFoodOnly(e.target.checked)} /> Free food</label>
        <label><input type="checkbox" checked={followingOnly} onChange={(e) => setFollowingOnly(e.target.checked)} disabled={!following.size} /> Clubs I follow</label>
      </div>
      {org.error && <p role="alert">{org.error}</p>}
      {venue.error && <p className={styles.note}>Games and concerts didn’t load.</p>}

      <div className={styles.days}>
        {running.length > 0 && (
          <SectionList title="Still running" count={running.length}>
            {running.map((e) => row(e, `Since ${sinceDate.format(new Date(e.start))}`))}
          </SectionList>
        )}
        {groups.length || running.length ? (
          groups.map((g) => (
            <SectionList key={g.key} title={formatDayLabel(g.start)} count={g.items.length}>
              {g.items.map((e) => row(e))}
            </SectionList>
          ))
        ) : (
          <EmptyState
            title="No upcoming events here"
            body={foodOnly ? 'No upcoming event lists free food yet. Club officers add it when they post a meeting.' : 'Try another filter.'}
            action={(kind !== 'all' || foodOnly || followingOnly) && <Button onClick={() => { setKind('all'); setFoodOnly(false); setFollowingOnly(false); }}>Show all events</Button>}
          />
        )}
      </div>
      <p className={styles.note}>Games and concerts come from published venue schedules (BU Athletics, Agganis Arena, Fenway Park, MGM Music Hall). “Going” counts are RSVPs on Flowcast, not attendance.</p>
    </Page>
  );
}
