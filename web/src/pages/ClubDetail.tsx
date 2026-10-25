import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, useResource } from '../data/api';
import type { OfficerMeeting } from '../data/types';
import { findMeetings } from '../lib/clubMeetings';
import { errorText, officerMeetingEvents } from '../lib/orgs';
import { formatRelative } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, SectionHeading, SelectField, Tag, TextArea, TextField, Toggle } from '../ui';
import { MeetingCard } from './Meetings';
import { ConflictCheck } from './meetings/PlanTools';
import { useOrgState, type OrgState } from './meetings/useOrgState';
import styles from './Meetings.module.css';

const emptyGeo = { positions: {}, walkMeters: {} };
const clean = (name: string) => name.replace(/\s+-\s+\d+$/, '');
const bostonFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** An instant as Boston "YYYY-MM-DD" and "HH:MM", for date and time inputs. */
function bostonInputs(iso: string) {
  const p = Object.fromEntries(bostonFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** Boston date and time inputs as an ISO instant (DST-aware: try both offsets, keep the one that reads back). */
function bostonIso(date: string, time: string): string | null {
  for (const offset of ['-04:00', '-05:00']) {
    const d = new Date(`${date}T${time}:00${offset}`);
    if (Number.isFinite(d.getTime()) && bostonInputs(d.toISOString()).time === time && bostonInputs(d.toISOString()).date === date) return d.toISOString();
  }
  return null;
}

/** One club: its meetings (published and posted here), announcements, following and free-time sharing; officers manage it. */
export default function ClubDetail() {
  // The router already decodes the path; club ids themselves contain %-escapes, so never decode twice.
  const clubId = useParams().clubId ?? '';
  const clubs = useResource(api.getClubs);
  const events = useResource(api.getCampusEvents);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const announcements = useResource(() => api.getClubAnnouncements(clubId), [clubId]);
  const org = useOrgState();
  const [now] = useState(Date.now);
  const [followError, setFollowError] = useState<string | null>(null);
  const club = clubs.data?.find((c) => c.id === clubId);
  const officer = org.me.data?.officerOf.includes(clubId) ?? false;
  const request = org.me.data?.requests.find((r) => r.clubId === clubId && r.status === 'pending');
  const sharing = org.me.data?.sharing.includes(clubId) ?? false;
  const clubNames = useMemo(() => new Map((clubs.data ?? []).map((c) => [c.id, c.name])), [clubs.data]);
  const items = useMemo(() => findMeetings(
    [...officerMeetingEvents(org.meetings.data?.meetings ?? [], clubNames), ...(events.data ?? [])].filter((e) => e.clubId === clubId),
    locations.data ?? [], geo.data ?? emptyGeo, { query: '', following: [], onlyFollowing: false, withinDays: null, now, home: profile.data?.homeLocationId ?? null },
  ), [org.meetings.data, clubNames, events.data, clubId, locations.data, geo.data, now, profile.data]);

  if (clubs.error) return <Page><EmptyState title="Clubs didn’t load" body={errorText(clubs.error)} action={<Button onClick={clubs.reload}>Try again</Button>} /></Page>;
  if (clubs.loading) return <Page><Loading label="Loading club" /></Page>;
  if (!club) return <Page><EmptyState title="Club not found" body="It may no longer appear in BU’s public event listings." action={<Button to="/clubs">All clubs</Button>} /></Page>;

  async function follow(on: boolean) {
    setFollowError(null);
    try { clubs.setData(await api.setFollowing(clubId, on)); } catch (e) { setFollowError(errorText(e, 'Your follow could not be saved.')); }
  }
  const feed = api.clubCalendarUrl(clubId);
  return <Page>
    <PageHeader title={clean(club.name)} description={officer ? 'You’re a verified officer of this club.' : 'Organizer from BU’s public event listings.'}
      actions={<Button variant={club.following ? 'ghost' : 'primary'} onClick={() => void follow(!club.following)}>{club.following ? 'Unfollow' : 'Follow'}</Button>} />
    {(followError || org.error) && <p role="alert" className={styles.error}>{followError ?? org.error}</p>}
    <div className={styles.stack}>
      <section className={styles.panel} aria-label="Your membership">
        <Toggle checked={sharing} disabled={!org.me.data || org.pending === `share:${clubId}`} onChange={(on) => void org.setSharing(clubId, on)}
          label="Share my free time with this club’s officers"
          description="Officers see only how many members are free each hour, from imported class schedules, and only once at least three members share. Never your schedule or your name. Turn it off any time." />
        <p className={styles.muted}>
          Subscribe to this club’s meetings in your calendar app: <a href={feed.replace(/^https?:/, 'webcal:')}>add calendar</a> or copy <code>{feed}</code>.
        </p>
      </section>

      {officer && <OfficerPanel clubId={clubId} org={org} locations={locations.data ?? []} onPosted={() => announcements.reload()} />}

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

function OfficerPanel({ clubId, org, locations, onPosted }: { clubId: string; org: OrgState; locations: { id: string; name: string }[]; onPosted: () => void }) {
  const mine = (org.meetings.data?.meetings ?? []).filter((m) => m.clubId === clubId && Date.parse(m.end) > Date.now());
  const [announcement, setAnnouncement] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(work: () => Promise<unknown>, done: string) {
    setStatus(null); setError(null);
    try { await work(); setStatus(done); org.meetings.reload(); onPosted(); } catch (e) { setError(errorText(e)); }
  }
  return <section className={styles.panel} aria-labelledby="manage">
    <SectionHeading><span id="manage">Manage meetings</span></SectionHeading>
    <p className={styles.muted}>Meetings you post show up in Find meetings right away. Followers with club updates on hear about new meetings, time and room changes, and cancellations.</p>
    <MeetingForm locations={locations} submitLabel="Post meeting" onSubmit={(input) => act(() => api.postClubMeeting(clubId, input), 'Meeting posted.')} />
    {mine.length > 0 && <>
      <h3>Your posted meetings</h3>
      <ul className={styles.updates}>{mine.map((m) => <PostedMeeting key={m.id} meeting={m} going={org.rsvpCount(m.eventId)} locations={locations}
        onSave={(patch) => act(() => api.updateClubMeeting(clubId, m.id, patch), 'Meeting updated.')} />)}</ul>
    </>}
    <h3>Announce to followers</h3>
    <form className={styles.stackForm} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.postClubAnnouncement(clubId, announcement.trim()); setAnnouncement(''); }, 'Announcement sent.'); }}>
      <TextArea label="Announcement" maxLength={500} rows={2} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!announcement.trim()}>Send</Button>
    </form>
    <p className={styles.muted}><Button to="/meetings?tab=plan" size="sm" variant="ghost">See when members are free and find a room</Button></p>
    {status && <p role="status"><Tag tone="ok">{status}</Tag></p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}

function PostedMeeting({ meeting, going, locations, onSave }: { meeting: OfficerMeeting; going: number; locations: { id: string; name: string }[]; onSave: (patch: Parameters<typeof api.updateClubMeeting>[2]) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(meeting.start));
  const place = locations.find((l) => l.id === meeting.locationId)?.name;
  return <li className={styles.card}>
    <p className={styles.when}>{when}{meeting.cancelled && <> · <Tag tone="bad">Cancelled</Tag></>}</p>
    <h3>{meeting.title}</h3>
    <p className={styles.where}>{[meeting.room && `Room ${meeting.room}`, place].filter(Boolean).join(', ') || 'No place set'}{going > 0 && <Tag tone="ok">{going} going</Tag>}</p>
    <div className={styles.actions}>
      <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>{editing ? 'Close' : 'Change time or room'}</Button>
      <Button size="sm" variant="ghost" onClick={() => void onSave({ cancelled: !meeting.cancelled })}>{meeting.cancelled ? 'Restore' : 'Cancel meeting'}</Button>
      {going > 0 && <Button size="sm" variant="ghost" to={`/meetings?tab=plan&headcount=${going}`}>Find a room for {going}</Button>}
    </div>
    {editing && <MeetingForm locations={locations} initial={meeting} submitLabel="Save changes" onSubmit={async (input) => { await onSave(input); setEditing(false); }} />}
  </li>;
}

function MeetingForm({ locations, initial, submitLabel, onSubmit }: {
  locations: { id: string; name: string }[]; initial?: OfficerMeeting; submitLabel: string;
  onSubmit: (input: { title: string; locationId: string | null; room: string; start: string; end: string; notes: string }) => Promise<void>;
}) {
  const start = initial ? bostonInputs(initial.start) : null;
  const end = initial ? bostonInputs(initial.end) : null;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [locationId, setLocationId] = useState(initial?.locationId ?? '');
  const [room, setRoom] = useState(initial?.room ?? '');
  const [date, setDate] = useState(start?.date ?? '');
  const [from, setFrom] = useState(start?.time ?? '18:00');
  const [to, setTo] = useState(end?.time ?? '19:30');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const startIso = date ? bostonIso(date, from) : null, endIso = date ? bostonIso(date, to) : null;
  const problem = !title.trim() ? 'Give the meeting a title.' : !startIso || !endIso ? 'Choose a date and times.' : endIso <= startIso ? 'It has to end after it starts.' : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    try {
      await onSubmit({ title: title.trim(), locationId: locationId || null, room: room.trim(), start: startIso!, end: endIso!, notes: notes.trim() });
      if (!initial) { setTitle(''); setRoom(''); setNotes(''); }
    } finally { setBusy(false); }
  }
  return <form className={styles.meetingForm} onSubmit={submit} noValidate>
    <TextField label="Title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
    <SelectField label="Building" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
      <option value="">Not on the map</option>
      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </SelectField>
    <TextField label="Room" maxLength={40} value={room} onChange={(e) => setRoom(e.target.value)} />
    <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
    <TextField label="Starts" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
    <TextField label="Ends" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
    <TextArea label="Notes (optional)" maxLength={500} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    <div className={styles.inline}>
      <Button type="submit" variant="primary" disabled={!!problem || busy}>{submitLabel}</Button>
      {problem && <span className={styles.muted} role="status">{problem}</span>}
    </div>
    {date && <details><summary>Check {date} for conflicts</summary><ConflictCheck key={`${date}|${locationId}`} initialDate={date} near={locationId || null} /></details>}
  </form>;
}
