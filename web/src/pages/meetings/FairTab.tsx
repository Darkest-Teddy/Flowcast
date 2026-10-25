import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../auth/session';
import { api, useResource } from '../../data/api';
import { answerMapLink } from '../../lib/askMapLink';
import { config } from '../../config';
import { errorText, officerMeetingEvents } from '../../lib/orgs';
import { Button, EmptyState, Loading, SelectField, Tag, TextField } from '../../ui';
import type { OrgState } from './useOrgState';
import styles from '../Meetings.module.css';

const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
const nextFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clean = (name: string) => name.replace(/\s+-\s+\d+$/, '');

/** The activity fair: each listed club's table and next meeting, with Follow right there. */
export function FairTab({ org }: { org: OrgState }) {
  const { hasRole } = useSession();
  const fairs = useResource(api.getFairs);
  const clubs = useResource(api.getClubs);
  const events = useResource(api.getCampusEvents);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const [error, setError] = useState<string | null>(null);
  const clubNames = useMemo(() => new Map((clubs.data ?? []).map((c) => [c.id, c.name])), [clubs.data]);
  // The next single meeting per club, from listings and officer posts.
  const next = useMemo(() => {
    const now = Date.now();
    const all = [...officerMeetingEvents(org.meetings.data?.meetings ?? [], clubNames), ...(events.data ?? [])]
      .filter((e) => e.clubId && Date.parse(e.start) > now && (!e.end || e.end.slice(0, 10) === e.start.slice(0, 10)))
      .sort((a, b) => a.start.localeCompare(b.start));
    const map = new Map<string, (typeof all)[number]>();
    for (const e of all) if (!map.has(e.clubId!)) map.set(e.clubId!, e);
    return map;
  }, [org.meetings.data, clubNames, events.data]);

  async function follow(clubId: string, on: boolean) {
    setError(null);
    try { clubs.setData(await api.setFollowing(clubId, on)); } catch (e) { setError(errorText(e)); }
  }
  if (fairs.loading || clubs.loading) return <Loading label="Loading the fair" />;
  if (fairs.error) return <p role="alert">{errorText(fairs.error)}</p>;
  return <div className={styles.stack}>
    {hasRole('admin') && <CreateFair locations={locations.data ?? []} onCreated={fairs.reload} />}
    {!fairs.data?.length ? <EmptyState title="No activity fair coming up" body="When one is scheduled, clubs list their tables here with their next meeting." /> : fairs.data.map((f) => {
      const place = locations.data?.find((l) => l.id === f.locationId);
      const point = f.locationId ? geo.data?.positions[f.locationId] : undefined;
      const map = point ? answerMapLink(config.mapUrl, [point]) : null;
      const tables = [...f.tables].sort((a, b) => a.table.localeCompare(b.table, undefined, { numeric: true }));
      return <section key={f.id} className={styles.panel} aria-label={f.name}>
        <h2 className={styles.heading}>{f.name}</h2>
        <p>{dateFormat.format(new Date(`${f.date}T12:00:00Z`))}, {f.starts}–{f.ends}{place ? ` · ${place.name}` : ''} {map && <Button href={map} size="sm" variant="ghost">View on map</Button>}</p>
        {!tables.length ? <p className={styles.muted}>No clubs have listed a table yet. Officers list theirs on their club page.</p>
          : <ul className={styles.list}>{tables.map((t) => {
            const c = clubs.data?.find((x) => x.id === t.clubId);
            const n = next.get(t.clubId);
            return <li key={t.clubId} className={styles.card}>
              <p className={styles.when}>{t.table ? `Table ${t.table}` : 'Table to be announced'}</p>
              <h3><Link className={styles.organizer} to={`/clubs/${encodeURIComponent(t.clubId)}`}>{clean(c?.name ?? t.clubId)}</Link></h3>
              {t.note && <p>{t.note}</p>}
              <p className={styles.muted}>{n ? `Next meeting: ${n.title}, ${nextFormat.format(new Date(n.start))}` : 'No upcoming meeting listed'}</p>
              {c && <div className={styles.actions}><Button size="sm" variant={c.following ? 'ghost' : 'primary'} onClick={() => void follow(c.id, !c.following)}>{c.following ? 'Following ✓' : 'Follow'}</Button></div>}
            </li>;
          })}</ul>}
      </section>;
    })}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </div>;
}

function CreateFair({ locations, onCreated }: { locations: { id: string; name: string }[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [locationId, setLocationId] = useState('');
  const [starts, setStarts] = useState('11:00');
  const [ends, setEnds] = useState('15:00');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { await api.createFair({ name: name.trim(), date, locationId: locationId || null, starts, ends }); setMsg({ ok: true, text: 'Fair created.' }); setName(''); onCreated(); }
    catch (err) { setMsg({ ok: false, text: errorText(err) }); }
  }
  return <details className={styles.panel}><summary>Set up an activity fair (admins)</summary>
    <form className={styles.inline} onSubmit={create}>
      <TextField label="Name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <SelectField label="Where" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
        <option value="">Not on the map</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </SelectField>
      <TextField label="Starts" type="time" value={starts} onChange={(e) => setStarts(e.target.value)} />
      <TextField label="Ends" type="time" value={ends} onChange={(e) => setEnds(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!name.trim() || !date}>Create fair</Button>
      {msg && <span role={msg.ok ? 'status' : 'alert'}><Tag tone={msg.ok ? 'ok' : 'bad'}>{msg.text}</Tag></span>}
    </form>
  </details>;
}
