import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, useResource } from '../../data/api';
import type { MeetingInput, OfficerMeeting, Perk } from '../../data/types';
import { errorText, PERK_KEYS, PERK_LABELS, perkSummary } from '../../lib/orgs';
import { Button, Loading, SelectField, Tag, TextArea, TextField } from '../../ui';
import { ConflictCheck } from '../meetings/PlanTools';
import styles from '../Meetings.module.css';

const bostonFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const whenFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dueFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
/** An instant as Boston "YYYY-MM-DD" and "HH:MM", for date and time inputs. */
export function bostonInputs(iso: string) {
  const p = Object.fromEntries(bostonFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** Boston date and time inputs as an ISO instant (EDT or EST, whichever reads back), or null. */
export function bostonIso(date: string, time: string): string | null {
  for (const offset of ['-04:00', '-05:00']) {
    const d = new Date(`${date}T${time}:00${offset}`);
    if (Number.isFinite(d.getTime()) && bostonInputs(d.toISOString()).time === time && bostonInputs(d.toISOString()).date === date) return d.toISOString();
  }
  return null;
}
const WARN_PERIODS = ['finals', 'reading-period', 'holiday', 'break', 'move-in'];

/** Post or change a meeting: place, time, a weekly repeat, perks, outdoors, and an automatic finals/holiday warning. */
export function MeetingForm({ locations, initial, submitLabel, allowRepeat, onSubmit }: {
  locations: { id: string; name: string }[]; initial?: OfficerMeeting; submitLabel: string; allowRepeat?: boolean;
  onSubmit: (input: MeetingInput, repeatUntil: string | null, scope: 'one' | 'series') => Promise<void>;
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
  const [perks, setPerks] = useState<Perk[]>(initial?.perks ?? []);
  const [perksNote, setPerksNote] = useState(initial?.perksNote ?? '');
  const [outdoor, setOutdoor] = useState(initial?.outdoor ?? false);
  const [repeat, setRepeat] = useState(false);
  const [until, setUntil] = useState('');
  const [scope, setScope] = useState<'one' | 'series'>('one');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<{ period: string; label: string } | null>(null);
  // Finals, the study period, holidays and breaks: warn as soon as the date is chosen.
  useEffect(() => {
    setPeriod(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let live = true;
    api.getConflicts(date, null).then((r) => { if (live) setPeriod(r.academic); }).catch(() => undefined);
    return () => { live = false; };
  }, [date]);
  const startIso = date ? bostonIso(date, from) : null, endIso = date ? bostonIso(date, to) : null;
  const problem = !title.trim() ? 'Give the meeting a title.' : !startIso || !endIso ? 'Choose a date and times.' : endIso <= startIso ? 'It has to end after it starts.'
    : repeat && (!until || until < date) ? 'Choose the last date to repeat until.' : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true); setError(null);
    try {
      await onSubmit({ title: title.trim(), locationId: locationId || null, room: room.trim(), start: startIso!, end: endIso!, notes: notes.trim(), perks, perksNote: perksNote.trim(), outdoor },
        repeat ? until : null, scope);
      if (!initial) { setTitle(''); setRoom(''); setNotes(''); setPerks([]); setPerksNote(''); setRepeat(false); }
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <form className={styles.meetingForm} onSubmit={submit} noValidate>
    <TextField label="Title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
    <SelectField label="Building" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
      <option value="">Not on the map</option>
      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </SelectField>
    <TextField label="Room or spot" maxLength={40} value={room} onChange={(e) => setRoom(e.target.value)} />
    <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
    <TextField label="Starts" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
    <TextField label="Ends" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
    <TextArea label="Notes (optional)" maxLength={500} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
    <fieldset className={styles.chips}>
      <legend>What’s offered <span className={styles.muted}>(shows on the listing, and in the Free food filter)</span></legend>
      {PERK_KEYS.map((p) => <label key={p}><input type="checkbox" checked={perks.includes(p)} onChange={(e) => setPerks((cur) => e.target.checked ? [...cur, p] : cur.filter((x) => x !== p))} />{PERK_LABELS[p]}</label>)}
      <TextField label="Details (optional)" placeholder="e.g. Pizza from Domino’s" maxLength={120} value={perksNote} onChange={(e) => setPerksNote(e.target.value)} />
    </fieldset>
    <div className={styles.inline}>
      <label className={styles.check}><input type="checkbox" checked={outdoor} onChange={(e) => setOutdoor(e.target.checked)} />Outdoors (show the weather forecast)</label>
      {allowRepeat && <label className={styles.check}><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Repeat weekly</label>}
      {allowRepeat && repeat && <TextField label="Until" type="date" min={date || undefined} value={until} onChange={(e) => setUntil(e.target.value)} />}
      {initial?.seriesId && <SelectField label="Apply to" value={scope} onChange={(e) => setScope(e.target.value as 'one' | 'series')}>
        <option value="one">This meeting only</option><option value="series">This and later weekly meetings</option>
      </SelectField>}
    </div>
    {period && WARN_PERIODS.includes(period.period) && <p className={styles.note} role="status"><Tag tone="warn">{period.label}</Tag> Turnout is usually lower; check whether members are around.</p>}
    <div className={styles.inline}>
      <Button type="submit" variant="primary" disabled={!!problem || busy}>{submitLabel}</Button>
      {problem && <span className={styles.muted} role="status">{problem}</span>}
      {error && <span role="alert"><Tag tone="bad">{error}</Tag></span>}
    </div>
    {date && <details><summary>Check {date} for other events</summary><ConflictCheck key={`${date}|${locationId}`} initialDate={date} near={locationId || null} /></details>}
  </form>;
}

/** One posted meeting with its tools: change, cancel, check-in code, checklist, co-host. */
export function PostedMeeting({ clubId, meeting, going, locations, clubs, onChanged }: {
  clubId: string; meeting: OfficerMeeting; going: number; locations: { id: string; name: string }[]; clubs: { id: string; name: string }[]; onChanged: () => void;
}) {
  const [open, setOpen] = useState<'edit' | 'checkin' | 'tasks' | 'cohost' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cancelling a whole series notifies every follower, so it asks first.
  const [confirmSeries, setConfirmSeries] = useState(false);
  const place = locations.find((l) => l.id === meeting.locationId)?.name;
  const host = meeting.clubId === clubId;
  const toggle = (k: NonNullable<typeof open>) => setOpen((v) => (v === k ? null : k));
  async function cancel(scope: 'one' | 'series') {
    setError(null); setConfirmSeries(false);
    try { await api.updateClubMeetingScope(clubId, meeting.id, { cancelled: !meeting.cancelled }, scope); onChanged(); } catch (e) { setError(errorText(e)); }
  }
  return <li className={styles.card}>
    <p className={styles.when}>{whenFormat.format(new Date(meeting.start))}{meeting.seriesId && <> · <Tag>Weekly</Tag></>}{meeting.cancelled && <> · <Tag tone="bad">Cancelled</Tag></>}{!host && <> · <Tag tone="accent">Co-hosting</Tag></>}</p>
    <h3>{meeting.title}</h3>
    <p className={styles.where}>{[meeting.room && `Room ${meeting.room}`, place].filter(Boolean).join(', ') || 'No place set'}
      {going > 0 && <Tag tone="ok">{going} going</Tag>}{perkSummary(meeting) && <Tag tone="accent">{perkSummary(meeting)}</Tag>}{meeting.outdoor && <Tag>Outdoors</Tag>}</p>
    {meeting.outdoor && <WeatherNote start={meeting.start} end={meeting.end} />}
    <div className={styles.actions}>
      {host && <Button size="sm" variant="ghost" onClick={() => toggle('edit')}>{open === 'edit' ? 'Close' : 'Change'}</Button>}
      {host && <Button size="sm" variant="ghost" onClick={() => void cancel('one')}>{meeting.cancelled ? (meeting.seriesId ? 'Restore this one' : 'Restore') : 'Cancel this one'}</Button>}
      {host && meeting.seriesId && (meeting.cancelled
        ? <Button size="sm" variant="ghost" onClick={() => void cancel('series')}>Restore this and later</Button>
        : confirmSeries
          ? <span className={styles.confirm} role="group" aria-label="Confirm cancelling the series">Cancel this and every later weekly meeting, and tell followers?
              <Button size="sm" variant="danger" onClick={() => void cancel('series')}>Yes, cancel them</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmSeries(false)}>Keep them</Button></span>
          : <Button size="sm" variant="ghost" onClick={() => setConfirmSeries(true)}>Cancel this and later…</Button>)}
      <Button size="sm" variant="ghost" onClick={() => toggle('checkin')}>Check-in code</Button>
      <Button size="sm" variant="ghost" onClick={() => toggle('tasks')}>Checklist</Button>
      {host && <Button size="sm" variant="ghost" onClick={() => toggle('cohost')}>Co-host</Button>}
      {going > 0 && <Button size="sm" variant="ghost" to={`/meetings?tab=plan&headcount=${going}`}>Find a room for {going}</Button>}
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {open === 'edit' && <MeetingForm locations={locations} initial={meeting} submitLabel="Save changes"
      onSubmit={async (input, _until, scope) => { await api.updateClubMeetingScope(clubId, meeting.id, input, scope); setOpen(null); onChanged(); }} />}
    {open === 'checkin' && <CheckinCodePanel clubId={clubId} meeting={meeting} />}
    {open === 'tasks' && <Checklist clubId={clubId} meeting={meeting} />}
    {open === 'cohost' && <CohostInvite clubId={clubId} meeting={meeting} clubs={clubs} />}
  </li>;
}

/** The QR code members scan at the door, with the live count. */
function CheckinCodePanel({ clubId, meeting }: { clubId: string; meeting: OfficerMeeting }) {
  const code = useResource(() => api.getCheckinCode(clubId, meeting.id), [clubId, meeting.id]);
  const [svg, setSvg] = useState('');
  const url = code.data ? `${window.location.origin}${code.data.path}` : '';
  useEffect(() => {
    if (!url) return;
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg).catch(() => setSvg(''));
  }, [url]);
  useEffect(() => {
    // Keep the count current while the code is on screen.
    const t = window.setInterval(() => code.reload(), 15_000);
    return () => window.clearInterval(t);
  }, [code.reload]);
  if (code.loading && !code.data) return <Loading label="Making the check-in code" />;
  if (code.error) return <p role="alert">{errorText(code.error)}</p>;
  const d = code.data!;
  return <div className={styles.checkin}>
    <div className={styles.qr} role="img" aria-label="QR code for checking in" dangerouslySetInnerHTML={{ __html: svg }} />
    <div>
      <p><strong>{d.count}</strong> checked in</p>
      <p className={styles.muted}>Show this at the door. Members scan it with their phone camera and sign in with BU Google. It works from {whenFormat.format(new Date(d.opensAt))} to {whenFormat.format(new Date(d.closesAt))}.</p>
      <p className={styles.muted}>Or share the link: <code>{url}</code></p>
    </div>
  </div>;
}

function Checklist({ clubId, meeting }: { clubId: string; meeting: OfficerMeeting }) {
  const tasks = useResource(() => api.getMeetingTasks(clubId, meeting.id), [clubId, meeting.id]);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => { setError(null); try { await work(); tasks.reload(); } catch (e) { setError(errorText(e)); } };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  return <div className={styles.conflicts}>
    {tasks.loading && !tasks.data ? <Loading label="Loading checklist" /> : !tasks.data?.length
      ? <p className={styles.muted}>No checklist yet. <Button size="sm" variant="ghost" onClick={() => void run(() => api.addMeetingTasks(clubId, meeting.id, { template: true }))}>Start from the event template</Button></p>
      : <ul className={styles.tasks}>{tasks.data.map((t) => <li key={t.id}>
        <label className={styles.check}><input type="checkbox" checked={t.done} onChange={(e) => void run(() => api.setTaskDone(clubId, t.id, e.target.checked))} />
          <span className={t.done ? styles.done : undefined}>{t.label}</span></label>
        <span className={styles.muted}>due {dueFormat.format(new Date(`${t.due}T12:00:00Z`))}</span>
        {!t.done && t.due < today && <Tag tone="bad">Overdue</Tag>}
        <Button size="sm" variant="ghost" onClick={() => void run(() => api.deleteTask(clubId, t.id))} aria-label={`Remove ${t.label}`}>Remove</Button>
      </li>)}</ul>}
    <form className={styles.inline} onSubmit={(e) => { e.preventDefault(); if (label.trim()) void run(async () => { await api.addMeetingTasks(clubId, meeting.id, { label: label.trim(), daysBefore: days }); setLabel(''); }); }}>
      <TextField label="Add a task" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />
      <TextField label="Days before" type="number" min={0} max={120} value={days} onChange={(e) => setDays(Math.max(0, Math.min(120, e.target.valueAsNumber || 0)))} />
      <Button type="submit" variant="secondary" disabled={!label.trim()}>Add</Button>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </div>;
}

function CohostInvite({ clubId, meeting, clubs }: { clubId: string; meeting: OfficerMeeting; clubs: { id: string; name: string }[] }) {
  const [other, setOther] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  async function invite(e: FormEvent) {
    e.preventDefault();
    try { await api.inviteCohost(clubId, meeting.id, other); setStatus('Invitation sent. It appears on their club page for an officer to accept.'); }
    catch (err) { setStatus(errorText(err)); }
  }
  return <form className={styles.inline} onSubmit={invite}>
    <SelectField label="Invite a club to co-host" value={other} onChange={(e) => setOther(e.target.value)}>
      <option value="">Choose a club</option>
      {clubs.filter((c) => c.id !== clubId && !meeting.cohosts.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </SelectField>
    <Button type="submit" variant="secondary" disabled={!other}>Invite</Button>
    {meeting.cohosts.length > 0 && <span className={styles.muted}>Co-hosting with {meeting.cohosts.map((c) => clubs.find((x) => x.id === c)?.name ?? c).join(', ')}.</span>}
    {status && <span role="status" className={styles.muted}>{status}</span>}
  </form>;
}

/** The forecast for an outdoor meeting, when it's within the next week. */
export function WeatherNote({ start, end }: { start: string; end: string }) {
  const weather = useResource(() => api.getMeetingWeather(start, end), [start, end]);
  if (!weather.data) return null;
  const w = weather.data;
  if (!w.available) return <p className={styles.muted}>Weather: {w.reason}</p>;
  const rain = Math.max(...w.periods.map((p) => p.rainChance ?? 0));
  const temps = w.periods.map((p) => p.temperatureF).filter((t): t is number => t !== null);
  const cold = temps.length ? Math.min(...temps) : null;
  return <p className={styles.note}>
    {(rain >= 40 || (cold !== null && cold < 45)) && <><Tag tone="warn">Weather heads-up</Tag> </>}
    {w.periods[0].summary}{cold !== null ? `, ${cold}°F` : ''}{rain ? `, ${rain}% chance of rain` : ''}. <span className={styles.muted}>National Weather Service forecast.</span>
  </p>;
}
