import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { api, useResource } from '../data/api';
import { findMeetings } from '../lib/clubMeetings';
import { errorText, officerMeetingEvents } from '../lib/orgs';
import { formatRelative } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, SectionHeading, Tag, TextArea, Toggle } from '../ui';
import { MeetingCard } from './Meetings';
import { ClubAdmin } from './club/ClubAdmin';
import { MeetingForm, PostedMeeting } from './club/MeetingTools';
import { useOrgState, type OrgState } from './meetings/useOrgState';
import styles from './Meetings.module.css';

const emptyGeo = { positions: {}, walkMeters: {} };
const clean = (name: string) => name.replace(/\s+-\s+\d+$/, '');

/** One club: its meetings (published and posted here), announcements, following and sharing choices; officers manage it. */
export default function ClubDetail() {
  // The router already decodes the path; club ids themselves contain %-escapes, so never decode twice.
  const clubId = useParams().clubId ?? '';
  const clubs = useResource(api.getClubs);
  const events = useResource(api.getCampusEvents);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const profiles = useResource(api.getClubProfiles);
  const extras = useResource(api.getMyClubExtras);
  const announcements = useResource(() => api.getClubAnnouncements(clubId), [clubId]);
  const org = useOrgState();
  const [now] = useState(Date.now);
  const [error, setError] = useState<string | null>(null);
  const club = clubs.data?.find((c) => c.id === clubId);
  const officer = org.me.data?.officerOf.includes(clubId) ?? false;
  const request = org.me.data?.requests.find((r) => r.clubId === clubId && r.status === 'pending');
  const sharing = org.me.data?.sharing.includes(clubId) ?? false;
  const nameVisible = extras.data?.visibleTo.includes(clubId) ?? false;
  const clubNames = useMemo(() => new Map((clubs.data ?? []).map((c) => [c.id, c.name])), [clubs.data]);
  const items = useMemo(() => findMeetings(
    [...officerMeetingEvents((org.meetings.data?.meetings ?? []).filter((m) => m.clubId === clubId || m.cohosts.includes(clubId)), clubNames),
      ...(events.data ?? []).filter((e) => e.clubId === clubId)],
    locations.data ?? [], geo.data ?? emptyGeo, { query: '', following: [], onlyFollowing: false, withinDays: null, now, home: profile.data?.homeLocationId ?? null },
  ), [org.meetings.data, clubNames, events.data, clubId, locations.data, geo.data, now, profile.data]);
  const tags = profiles.data?.[clubId];

  if (clubs.error) return <Page><EmptyState title="Clubs didn’t load" body={errorText(clubs.error)} action={<Button onClick={clubs.reload}>Try again</Button>} /></Page>;
  if (clubs.loading) return <Page><Loading label="Loading club" /></Page>;
  if (!club) return <Page><EmptyState title="Club not found" body="It may no longer appear in BU’s public event listings." action={<Button to="/clubs">All clubs</Button>} /></Page>;

  async function follow(on: boolean) {
    setError(null);
    try { clubs.setData(await api.setFollowing(clubId, on)); } catch (e) { setError(errorText(e, 'Your follow could not be saved.')); }
  }
  async function showName(on: boolean) {
    setError(null);
    try { await api.setNameVisible(clubId, on); extras.reload(); } catch (e) { setError(errorText(e)); }
  }
  const feed = api.clubCalendarUrl(clubId);
  return <Page>
    <PageHeader title={clean(club.name)} description={tags?.blurb || (officer ? 'You’re a verified officer of this club.' : 'Organizer from BU’s public event listings.')}
      actions={<Button variant={club.following ? 'ghost' : 'primary'} onClick={() => void follow(!club.following)}>{club.following ? 'Unfollow' : 'Follow'}</Button>} />
    {tags?.tags.length ? <p className={styles.tagRow}>{tags.tags.map((t) => <Tag key={t}>{t}</Tag>)}</p> : null}
    {(error || org.error) && <p role="alert" className={styles.error}>{error ?? org.error}</p>}
    <div className={styles.stack}>
      <section className={styles.panel} aria-label="Your membership">
        <Toggle checked={sharing} disabled={!org.me.data || org.pending === `share:${clubId}`} onChange={(on) => void org.setSharing(clubId, on)}
          label="Share my free time with this club’s officers"
          description="Officers see only how many members are free each hour, from imported class schedules, and only once at least three members share. Never your schedule or your name." />
        <Toggle checked={nameVisible} disabled={!extras.data} onChange={(on) => void showName(on)}
          label="Show my name to this club’s officers"
          description="Officers see a list of members who turned this on (your profile name only). Following, RSVPs and check-ins otherwise stay anonymous counts." />
        <p className={styles.muted}>
          Subscribe to this club’s meetings in your calendar app: <a href={feed.replace(/^https?:/, 'webcal:')}>add calendar</a> or copy <code>{feed}</code>.
        </p>
      </section>

      {officer && <OfficerMeetings clubId={clubId} org={org} locations={locations.data ?? []} clubs={clubs.data ?? []} onPosted={() => announcements.reload()} />}
      {officer && <ClubAdmin clubId={clubId} profile={tags} onProfile={profiles.reload} />}

      <section aria-labelledby="club-meetings">
        <SectionHeading><span id="club-meetings">Upcoming meetings</span></SectionHeading>
        {items.length === 0 ? <EmptyState title="No upcoming meetings listed" body={officer ? 'Post one above.' : 'Follow the club to hear when one is posted.'} />
          : <ul className={styles.list}>{items.map((item) => <MeetingCard key={item.event.id} item={item} geo={geo.data ?? emptyGeo} org={org} />)}</ul>}
      </section>

      <section aria-labelledby="club-news">
        <SectionHeading><span id="club-news">Announcements</span></SectionHeading>
        {announcements.loading ? <Loading label="Loading announcements" />
          : !announcements.data?.length ? <p className={styles.muted}>No announcements yet.</p>
          : <ul className={styles.updates}>{announcements.data.map((a) => <li key={a.id} className={styles.card}><p className={styles.when}>{formatRelative(a.at)}</p><p>{a.body}</p></li>)}</ul>}
      </section>

      {!officer && <p className={styles.muted}>
        {request ? <>Your request to manage this club is <Tag tone="warn">pending review</Tag>.</> : <>Run this club? <Button to={`/clubs/register?club=${encodeURIComponent(clubId)}`} size="sm" variant="ghost">Request officer access</Button></>}
      </p>}
    </div>
  </Page>;
}

function OfficerMeetings({ clubId, org, locations, clubs, onPosted }: { clubId: string; org: OrgState; locations: { id: string; name: string }[]; clubs: { id: string; name: string }[]; onPosted: () => void }) {
  const mine = (org.meetings.data?.meetings ?? []).filter((m) => (m.clubId === clubId || m.cohosts.includes(clubId)) && Date.parse(m.end) > Date.now());
  const [announcement, setAnnouncement] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = () => { org.meetings.reload(); onPosted(); };
  async function announce() {
    setStatus(null);
    try { await api.postClubAnnouncement(clubId, announcement.trim()); setAnnouncement(''); setStatus({ ok: true, text: 'Announcement sent.' }); onPosted(); }
    catch (e) { setStatus({ ok: false, text: errorText(e) }); }
  }
  return <section className={styles.panel} aria-labelledby="manage">
    <SectionHeading><span id="manage">Manage meetings</span></SectionHeading>
    <p className={styles.muted}>Meetings you post show up in Find meetings and All events right away. Followers with club updates on hear about new meetings, time and room changes, perks and cancellations.</p>
    <MeetingForm locations={locations} submitLabel="Post meeting" allowRepeat onSubmit={async (input, until) => {
      const r = await api.postClubSeries(clubId, input, until);
      setStatus({ ok: true, text: r.series ? `${r.series.length} weekly meetings posted.` : 'Meeting posted.' });
      changed();
    }} />
    {mine.length > 0 && <>
      <h3>Your upcoming meetings</h3>
      <ul className={styles.updates}>{mine.map((m) => <PostedMeeting key={m.id} clubId={clubId} meeting={m} going={org.rsvpCount(m.eventId)} locations={locations} clubs={clubs} onChanged={changed} />)}</ul>
    </>}
    <h3>Announce to followers</h3>
    <form className={styles.stackForm} onSubmit={(e) => { e.preventDefault(); void announce(); }}>
      <TextArea label="Announcement" maxLength={500} rows={2} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!announcement.trim()}>Send</Button>
    </form>
    <p className={styles.muted}><Button to="/meetings?tab=plan" size="sm" variant="ghost">See when members are free and find a room</Button></p>
    {status && <p role={status.ok ? 'status' : 'alert'}><Tag tone={status.ok ? 'ok' : 'bad'}>{status.text}</Tag></p>}
  </section>;
}
