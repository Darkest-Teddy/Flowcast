import { useState, type FormEvent } from 'react';
import { api, useResource } from '../../data/api';
import type { ClubProfile } from '../../data/types';
import { errorText } from '../../lib/orgs';
import { formatRelative } from '../../lib/format';
import { Button, Loading, SectionHeading, Tag, TextArea, TextField } from '../../ui';
import styles from '../Meetings.module.css';

export const CLUB_TAGS = ['academic', 'arts', 'business', 'cultural', 'debate', 'faith', 'gaming', 'health', 'media', 'music', 'politics', 'service', 'social', 'sports', 'stem', 'theater'];
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });

/** Officers: co-host invitations, team, members, attendance, stats, tags and the fair. */
export function ClubAdmin({ clubId, profile, onProfile }: { clubId: string; profile: ClubProfile | undefined; onProfile: () => void }) {
  return <>
    <CohostInbox clubId={clubId} />
    <Team clubId={clubId} />
    <Members clubId={clubId} />
    <Attendance clubId={clubId} />
    <Stats clubId={clubId} />
    <ProfileEditor clubId={clubId} profile={profile} onSaved={onProfile} />
    <FairTable clubId={clubId} />
  </>;
}

function Panel({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section className={styles.panel} aria-labelledby={id}><SectionHeading><span id={id}>{title}</span></SectionHeading>{children}</section>;
}

function CohostInbox({ clubId }: { clubId: string }) {
  const invites = useResource(() => api.getCohostInvites(clubId), [clubId]);
  const [error, setError] = useState<string | null>(null);
  const pending = (invites.data ?? []).filter((i) => i.invited && i.status === 'pending');
  if (!pending.length) return null;
  return <Panel id="cohost-inbox" title="Co-host invitations">
    <ul className={styles.updates}>{pending.map((i) => <li key={i.id} className={styles.card}>
      <p className={styles.when}>{dayFormat.format(new Date(i.meeting.start))}</p>
      <p><strong>{i.hostClub.replace(/\s+-\s+\d+$/, '')}</strong> invited your club to co-host <strong>{i.meeting.title}</strong>. Accepting shares the event with your followers and lets both clubs combine members’ free-time counts.</p>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" onClick={() => void api.answerCohostInvite(i.id, true).then(invites.reload, (e) => setError(errorText(e)))}>Accept</Button>
        <Button size="sm" variant="ghost" onClick={() => void api.answerCohostInvite(i.id, false).then(invites.reload, (e) => setError(errorText(e)))}>Decline</Button>
      </div>
    </li>)}</ul>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </Panel>;
}

function Team({ clubId }: { clubId: string }) {
  const team = useResource(() => api.getClubOfficers(clubId), [clubId]);
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (work: () => Promise<unknown>, ok: string) => { setMsg(null); try { await work(); setMsg({ ok: true, text: ok }); team.reload(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } };
  async function add(e: FormEvent) {
    e.preventDefault();
    await run(async () => { await api.addClubOfficer(clubId, email.trim(), title.trim()); setEmail(''); setTitle(''); }, 'Officer added.');
  }
  return <Panel id="team" title="Officer team">
    {team.loading && !team.data ? <Loading label="Loading officers" /> : <ul className={styles.tasks}>{(team.data ?? []).map((o) => <li key={o.accountId}>
      <span><strong>{o.name}</strong> <span className={styles.muted}>{o.email}</span></span>
      <Tag tone="accent">{o.title}</Tag>
      <TitleEdit title={o.title} onSave={(t) => void run(() => api.setOfficerTitle(clubId, o.accountId, t), 'Title updated.')} />
      <Button size="sm" variant="ghost" onClick={() => void run(() => api.removeClubOfficer(clubId, o.accountId), 'Officer removed.')}>Remove</Button>
    </li>)}</ul>}
    <form className={styles.inline} onSubmit={add}>
      <TextField label="Add an officer by sign-in email" type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} hint="They need to have signed in to Flowcast once." />
      <TextField label="Title" placeholder="Treasurer" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!email.trim() || !title.trim()}>Add officer</Button>
    </form>
    {msg && <p role={msg.ok ? 'status' : 'alert'}><Tag tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Tag></p>}
  </Panel>;
}

function TitleEdit({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  if (!editing) return <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change title</Button>;
  return <form className={styles.inline} onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onSave(value.trim()); setEditing(false); } }}>
    <TextField label="Title" maxLength={40} value={value} onChange={(e) => setValue(e.target.value)} />
    <Button type="submit" size="sm" variant="secondary">Save</Button>
    <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
  </form>;
}

function Members({ clubId }: { clubId: string }) {
  const m = useResource(() => api.getClubMembers(clubId), [clubId]);
  if (!m.data) return m.error ? <p role="alert">{errorText(m.error)}</p> : null;
  return <Panel id="members" title="Members">
    <p><strong>{m.data.followers}</strong> following · <strong>{m.data.sharingFreeTime}</strong> sharing free time · <strong>{m.data.visible.length}</strong> showing their name to officers</p>
    {m.data.visible.length ? <ul className={styles.nameList}>{m.data.visible.map((v, i) => <li key={i}>{v.name}</li>)}</ul>
      : <p className={styles.muted}>Names appear here only for members who turn on “Show my name to this club’s officers” on your club page.</p>}
  </Panel>;
}

function Attendance({ clubId }: { clubId: string }) {
  const a = useResource(() => api.getAttendance(clubId), [clubId]);
  if (!a.data) return a.error ? <p role="alert">{errorText(a.error)}</p> : null;
  const max = Math.max(1, ...a.data.meetings.map((x) => Math.max(x.checkins, x.rsvps)));
  return <Panel id="attendance" title="Attendance">
    {a.data.recentAverage !== null
      ? <p>Last {a.data.basedOn} {a.data.basedOn === 1 ? 'meeting' : 'meetings'} with check-in averaged <strong>{a.data.recentAverage}</strong> people. <Button size="sm" variant="ghost" to={`/meetings?tab=plan&headcount=${a.data.recentAverage}`}>Find rooms for {a.data.recentAverage}</Button></p>
      : <p className={styles.muted}>Use a meeting’s check-in code to start tracking attendance.</p>}
    {a.data.meetings.length > 0 && <ul className={styles.attendance}>{a.data.meetings.map((x) => <li key={x.id}>
      <span className={styles.muted}>{dayFormat.format(new Date(x.start))}</span><span>{x.title}</span>
      <span className={styles.barPair} aria-label={`${x.rsvps} RSVPs, ${x.tracked ? `${x.checkins} checked in` : 'no check-in'}`}>
        <span style={{ width: `${(x.rsvps / max) * 100}%` }} className={styles.rsvpBar} />
        <span style={{ width: `${(x.checkins / max) * 100}%` }} className={styles.checkinBar} />
      </span>
      <span className={styles.muted}>{x.rsvps} going · {x.tracked ? `${x.checkins} came` : 'no check-in'}</span>
    </li>)}</ul>}
  </Panel>;
}

function Stats({ clubId }: { clubId: string }) {
  const s = useResource(() => api.getClubStats(clubId), [clubId]);
  if (!s.data) return s.error ? <p role="alert">{errorText(s.error)}</p> : null;
  const series = s.data.followerSeries;
  const max = Math.max(1, ...series.map((p) => p.followers));
  const points = series.map((p, i) => `${(i / (series.length - 1)) * 300},${60 - (p.followers / max) * 56}`).join(' ');
  return <Panel id="stats" title="Club stats">
    <p><strong>{s.data.followers}</strong> followers{s.data.trackingSince ? <span className={styles.muted}> · follows tracked since {formatRelative(s.data.trackingSince)}</span> : null}</p>
    <svg viewBox="0 0 300 62" className={styles.spark} role="img" aria-label={`Followers over the last 60 days, from ${series[0].followers} to ${series.at(-1)!.followers}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
    {s.data.announcements.length > 0 && <><h3>Announcements</h3><ul className={styles.tasks}>{s.data.announcements.map((a, i) => <li key={i}>
      <span className={styles.muted}>{formatRelative(a.at)}</span><span>{a.body}</span>
      {a.rsvpsWithin48h !== null && <Tag tone={a.rsvpsWithin48h ? 'ok' : 'off'}>{a.rsvpsWithin48h} RSVPs in 48 h</Tag>}
    </li>)}</ul></>}
    <p className={styles.muted}>Counts only: who followed, RSVP’d or checked in is never shown here.</p>
  </Panel>;
}

function ProfileEditor({ clubId, profile, onSaved }: { clubId: string; profile: ClubProfile | undefined; onSaved: () => void }) {
  const [tags, setTags] = useState<string[]>(profile?.tags ?? []);
  const [blurb, setBlurb] = useState(profile?.blurb ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { await api.setClubProfile(clubId, { tags, blurb: blurb.trim() }); setMsg({ ok: true, text: 'Saved.' }); onSaved(); } catch (err) { setMsg({ ok: false, text: errorText(err) }); }
  }
  return <Panel id="profile" title="How students find you">
    <form className={styles.stackForm} onSubmit={save}>
      <fieldset className={styles.chips}><legend>Tags (up to 4)</legend>
        {CLUB_TAGS.map((t) => <label key={t}><input type="checkbox" checked={tags.includes(t)} disabled={!tags.includes(t) && tags.length >= 4}
          onChange={(e) => setTags((cur) => e.target.checked ? [...cur, t] : cur.filter((x) => x !== t))} />{t}</label>)}
      </fieldset>
      <TextArea label="One-line description" maxLength={280} rows={2} value={blurb} onChange={(e) => setBlurb(e.target.value)} />
      <Button type="submit" variant="secondary">Save</Button>
      {msg && <span role={msg.ok ? 'status' : 'alert'}><Tag tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Tag></span>}
    </form>
  </Panel>;
}

function FairTable({ clubId }: { clubId: string }) {
  const fairs = useResource(api.getFairs);
  const [msg, setMsg] = useState<string | null>(null);
  if (!fairs.data?.length) return null;
  return <Panel id="fair" title="Activity fair">
    {fairs.data.map((f) => {
      const mine = f.tables.find((t) => t.clubId === clubId);
      return <FairRow key={f.id} name={f.name} date={f.date} table={mine?.table ?? ''} note={mine?.note ?? ''}
        onSave={(table, note) => api.setFairTable(f.id, clubId, table, note).then(() => { setMsg('Your table is listed.'); fairs.reload(); }, (e) => setMsg(errorText(e)))} />;
    })}
    {msg && <p role="status" className={styles.muted}>{msg}</p>}
    <p className={styles.muted}>Listed tables appear on the fair tab of Club meetings with your next meeting, so students can follow you there.</p>
  </Panel>;
}

function FairRow({ name, date, table: t0, note: n0, onSave }: { name: string; date: string; table: string; note: string; onSave: (table: string, note: string) => void }) {
  const [table, setTable] = useState(t0);
  const [note, setNote] = useState(n0);
  return <form className={styles.inline} onSubmit={(e) => { e.preventDefault(); onSave(table.trim(), note.trim()); }}>
    <span><strong>{name}</strong> <span className={styles.muted}>{dayFormat.format(new Date(`${date}T16:00:00Z`))}</span></span>
    <TextField label="Your table" placeholder="B12" maxLength={20} value={table} onChange={(e) => setTable(e.target.value)} />
    <TextField label="Note" placeholder="Free stickers!" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
    <Button type="submit" variant="secondary">{t0 ? 'Update' : 'List our table'}</Button>
  </form>;
}
