import { useMemo, useState, type FormEvent } from 'react';
import { api, useResource } from '../../data/api';
import type { ConflictReport, MemberAvailability } from '../../data/types';
import { errorText, hourLabel, turnoutPreview } from '../../lib/orgs';
import { Button, CrowdMeter, EmptyState, Loading, SectionHeading, SelectField, Tag, TextField } from '../../ui';
import styles from '../Meetings.module.css';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const bostonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

/**
 * Members' free time, for officers: how many of the members who chose to share are free each hour of
 * the next seven days. Counts only, and nothing until enough members share.
 */
export function MemberFreeTime({ officerOf, onPick, onUseHeadcount }: { officerOf: string[]; onPick: (weekday: number, hour: number) => void; onUseHeadcount: (n: number) => void }) {
  const clubs = useResource(api.getClubs);
  const [clubId, setClubId] = useState<string | null>(null);
  const [withClub, setWithClub] = useState('');
  const id = clubId ?? officerOf[0] ?? null;
  const availability = useResource(() => (id ? api.getMemberAvailabilityWith(id, withClub || null) : Promise.resolve(null)), [id, withClub]);
  const attendance = useResource(() => (id ? api.getAttendance(id) : Promise.resolve(null)), [id]);
  // Partners: other clubs this officer runs, and clubs that co-host with this one.
  const invites = useResource(() => (id ? api.getCohostInvites(id) : Promise.resolve([])), [id]);
  const partners = useMemo(() => {
    const set = new Set(officerOf.filter((c) => c !== id));
    for (const i of invites.data ?? []) if (i.status === 'accepted') for (const c of [i.meeting.clubId, ...i.meeting.cohosts]) if (c !== id) set.add(c);
    return [...set];
  }, [officerOf, id, invites.data]);
  if (!officerOf.length) return null;
  const name = (c: string) => clubs.data?.find((x) => x.id === c)?.name ?? c;
  return <section className={styles.panel} aria-labelledby="free-time">
    <SectionHeading><span id="free-time">When your members are free</span></SectionHeading>
    <p className={styles.muted}>Counts of members who chose to share their free time with your club, from their imported class schedules. You never see whose time is whose. Pick an hour to search rooms then.</p>
    <div className={styles.inline}>
      {officerOf.length > 1 && <SelectField label="Club" value={id ?? ''} onChange={(e) => { setClubId(e.target.value); setWithClub(''); }}>
        {officerOf.map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </SelectField>}
      {partners.length > 0 && <SelectField label="Plan together with" value={withClub} onChange={(e) => setWithClub(e.target.value)}>
        <option value="">Just this club</option>
        {partners.map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </SelectField>}
    </div>
    {attendance.data?.recentAverage != null && <p className={styles.note}>
      Last {attendance.data.basedOn} {attendance.data.basedOn === 1 ? 'meeting' : 'meetings'} with check-in averaged <strong>{attendance.data.recentAverage}</strong> people.
      {' '}<Button size="sm" variant="ghost" onClick={() => onUseHeadcount(attendance.data!.recentAverage!)}>Find rooms for {attendance.data.recentAverage}</Button>
    </p>}
    {availability.loading ? <Loading label="Loading members’ free time" />
      : availability.error ? <p role="alert">{errorText(availability.error)}</p>
      : availability.data && <FreeGrid data={availability.data} onPick={onPick} />}
  </section>;
}

function FreeGrid({ data, onPick }: { data: MemberAvailability; onPick: (weekday: number, hour: number) => void }) {
  if (!data.days) return <p className={styles.note}>{data.members} of the {data.minimum} members needed {data.members === 1 ? 'has' : 'have'} shared their free time. Ask members to open your club’s page and turn on “Share my free time”.</p>;
  const hours = data.days[0]?.hours.map((h) => h.hour) ?? [];
  return <div className={styles.gridWrap}>
    <table className={styles.freeGrid}>
      <caption className="visually-hidden">Members free each hour, out of {data.members}</caption>
      <thead><tr><th scope="col">Day</th>{hours.map((h) => <th key={h} scope="col">{hourLabel(h).replace(' ', '')}</th>)}</tr></thead>
      <tbody>{data.days.map((d) => <tr key={d.date}>
        <th scope="row">{dayFormat.format(new Date(`${d.date}T12:00:00Z`))}</th>
        {d.hours.map((h) => <td key={h.hour}>
          <button type="button" className={styles.freeCell} style={{ '--free': h.free / data.members } as React.CSSProperties}
            onClick={() => onPick(d.weekday, h.hour)} aria-label={`${DAYS[d.weekday]} ${hourLabel(h.hour)}: ${h.free} of ${data.members} free. Search rooms then.`}>
            {h.free}
          </button>
        </td>)}
      </tr>)}</tbody>
    </table>
    <p className={styles.muted}>Out of {data.members} sharing members. Imported schedules may be incomplete: someone shown as free may still be busy.</p>
  </div>;
}

/** What else is happening on a date: the academic calendar, games and concerts, and other clubs' events. */
export function ConflictCheck({ initialDate, near: initialNear }: { initialDate?: string; near?: string | null }) {
  const locations = useResource(api.getLocations);
  const [date, setDate] = useState(initialDate ?? bostonToday());
  const [near, setNear] = useState(initialNear ?? '');
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'error'; message: string } | { status: 'done'; report: ConflictReport }>({ status: 'idle' });
  async function check(e?: FormEvent) {
    e?.preventDefault();
    setState({ status: 'loading' });
    try { setState({ status: 'done', report: await api.getConflicts(date, near || null) }); }
    catch (error) { setState({ status: 'error', message: errorText(error, 'The conflict check didn’t answer.') }); }
  }
  return <section className={styles.panel} aria-labelledby="conflicts">
    <SectionHeading><span id="conflicts">Check a date for conflicts</span></SectionHeading>
    <form className={styles.inline} onSubmit={check}>
      <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <SelectField label="Near (optional)" value={near} onChange={(e) => setNear(e.target.value)}>
        <option value="">Anywhere</option>
        {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </SelectField>
      <Button type="submit" variant="secondary" disabled={!date || state.status === 'loading'}>Check</Button>
    </form>
    {state.status === 'loading' && <Loading label="Checking the date" />}
    {state.status === 'error' && <p role="alert">{state.message}</p>}
    {state.status === 'done' && <ConflictResult report={state.report} />}
  </section>;
}

function ConflictResult({ report }: { report: ConflictReport }) {
  const warn = ['finals', 'reading-period', 'holiday', 'break', 'move-in'].includes(report.academic.period);
  const outside = report.venueWindow && (report.date < report.venueWindow.from || report.date > report.venueWindow.to);
  return <div className={styles.conflicts}>
    <p><Tag tone={warn ? 'warn' : 'off'}>{report.academic.label}</Tag></p>
    <h3>Games and concerts</h3>
    {outside ? <p className={styles.muted}>Venue schedules only cover {report.venueWindow!.from} to {report.venueWindow!.to}.</p>
      : report.venueEvents.length === 0 ? <p className={styles.muted}>None published that day.</p>
      : <ul className={styles.plainList}>{report.venueEvents.map((e) => <li key={`${e.name}|${e.start}`}>
        {timeFormat.format(new Date(e.start))} · {e.name}, {e.venue}
        {e.nearby && <> <Tag tone="warn">Within 1 km{report.near ? ` of ${report.near}` : ''}</Tag></>}
      </li>)}</ul>}
    <h3>Other club events</h3>
    {report.clubEvents.length === 0 ? <p className={styles.muted}>None listed that day.</p>
      : <ul className={styles.plainList}>{report.clubEvents.map((e) => <li key={e.id}>
        {timeFormat.format(new Date(e.start))} · {e.title}{e.organizer ? ` (${e.organizer.replace(/\s+-\s+\d+$/, '')})` : ''}{e.venue ? `, ${e.venue}` : ''}
      </li>)}</ul>}
    <p className={styles.muted}>Exams, private bookings and events not published on Terrier Central or Flowcast aren’t included.</p>
  </div>;
}

/** "If 80 people come to GSU at 7 PM Thursday": attendees added to the place's modeled crowd. */
export function TurnoutPreview() {
  const impact = useResource(api.getEventImpact);
  const [placeId, setPlaceId] = useState('gsu');
  const [weekday, setWeekday] = useState(3);
  const [start, setStart] = useState('19:00');
  const [duration, setDuration] = useState(90);
  const [attendees, setAttendees] = useState(80);
  const places = useMemo(() => (impact.data?.places ?? []).filter((p) => p.capacity > 0).sort((a, b) => a.name.localeCompare(b.name)), [impact.data]);
  const [h, m] = start.split(':').map(Number);
  const rows = impact.data && Number.isFinite(h) ? turnoutPreview(impact.data, placeId, weekday, h * 3600 + (m || 0) * 60, duration, Math.max(0, attendees || 0)) : null;
  const shown = rows?.filter((r) => r.hour >= Math.max(0, h - 2) && r.hour <= Math.min(23, h + Math.ceil(duration / 60) + 1)) ?? [];
  return <section className={styles.panel} aria-labelledby="turnout">
    <SectionHeading><span id="turnout">Preview turnout</span></SectionHeading>
    <p className={styles.muted}>Your attendees added on top of the place’s modeled crowd on a typical week. It doesn’t re-run the simulation: where attendees come from, and people who’d stay away, aren’t modeled.</p>
    {impact.loading ? <Loading label="Loading crowd projections" /> : impact.error ? <p role="alert">{errorText(impact.error)}</p> : <>
      <div className={styles.inline}>
        <SelectField label="Place" value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <SelectField label="Day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </SelectField>
        <TextField label="Start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <SelectField label="Length" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          {[30, 60, 90, 120, 180].map((n) => <option key={n} value={n}>{n} minutes</option>)}
        </SelectField>
        <TextField label="Attendees" type="number" min={0} max={5000} value={Number.isFinite(attendees) ? attendees : ''} onChange={(e) => setAttendees(e.target.valueAsNumber)} />
      </div>
      {!rows ? <EmptyState title="No projection for this place" /> : <ul className={styles.turnout} aria-label="Projected crowd by hour">
        {shown.map((r) => <li key={r.hour}>
          <span className={styles.turnoutHour}>{hourLabel(r.hour)}</span>
          <span><span className={styles.muted}>Normally</span> <CrowdMeter share={r.normal / r.capacity} /></span>
          <span><span className={styles.muted}>With your event</span> <CrowdMeter share={r.withEvent / r.capacity} /></span>
        </li>)}
      </ul>}
      {rows && rows.some((r) => r.withEvent > r.capacity) && <p className={styles.note}><Tag tone="bad">Over capacity</Tag> At its busiest hour the place would hold more people than its stated capacity.</p>}
    </>}
  </section>;
}
