import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../data/api';
import type { CampusLocation, ScheduleImportState, ScheduleItem, SchedulePreview } from '../data/types';
import { firstClassDay, summarizeScheduleCheck, weekOfLabel } from '../lib/scheduleCheck';
import { Button, Page, PageHeader, Select } from '../ui';
import { runScheduleCheck, useScheduleCheckContext } from './student/ScheduleCheck';
import styles from './Calendars.module.css';

const PAGE_SIZE = 25;
const date = (value: string) => new Date(value).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const message = (error: unknown) => error instanceof Error ? error.message : 'The schedule could not be updated. Try again.';

export default function Calendars() {
  const [saved, setSaved] = useState<ScheduleImportState | null>(null);
  const [locations, setLocations] = useState<CampusLocation[]>([]);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mapping, setMapping] = useState<Map<string, string>>(new Map());
  const [page, setPage] = useState(0);
  const [roomPage, setRoomPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [imported, setImported] = useState<ScheduleItem[] | null>(null);
  const checkContext = useScheduleCheckContext();
  const revision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const version = ++revision.current;
    setError(null);
    Promise.all([api.getScheduleImport(), api.getLocations()]).then(([state, places]) => {
      if (version !== revision.current) return;
      setSaved(state);
      setLocations(places);
    }).catch((e: unknown) => { if (version === revision.current) setError(message(e)); });
    return () => { revision.current++; };
  }, [attempt]);

  // Computed in the browser from the classes just imported; never saved or sent.
  const check = imported && locations.length ? runScheduleCheck(imported, locations, checkContext, firstClassDay(imported, Date.now())) : null;
  const rooms = useMemo(() => [...new Set(preview?.items.map((item) => item.locationText ?? '') ?? [])], [preview]);
  const selectedItems = useMemo(() => preview?.items.filter((item) => selected.has(item.id)).map((item) => ({
    ...item, locationId: mapping.get(item.locationText ?? '') ?? item.locationId,
  })) ?? [], [preview, selected, mapping]);

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const version = ++revision.current;
    setPreview(null);
    setError(null);
    setStatus('');
    if (!/\.ics$/i.test(file.name) || file.size > 1024 * 1024) {
      setError('Choose an .ics file no larger than 1 MB.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.previewSchedule(file.name, await file.text());
      if (version !== revision.current) return;
      setPreview(result);
      setSelected(new Set(result.items.map((item) => item.id)));
      setMapping(new Map(result.items.map((item) => [item.locationText ?? '', item.locationId])));
      setPage(0);
      setRoomPage(0);
    } catch (e) {
      if (version === revision.current) setError(message(e));
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }

  async function save(clear = false) {
    if (!clear && (!preview || !selectedItems.length)) return;
    const version = ++revision.current;
    setBusy(true);
    setError(null);
    setStatus('');
    setImported(null);
    try {
      const result = clear ? await api.clearSchedule() : await api.importSchedule(preview!.fileName, selectedItems);
      if (version !== revision.current) return;
      setSaved(result);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = '';
      setStatus(clear ? 'Imported schedule removed.' : `${result.items.length} classes imported.`);
      if (!clear) setImported(result.items);
    } catch (e) {
      if (version === revision.current) setError(message(e));
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Calendars" description="Import your class schedule from an .ics file." />
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!saved && (error ? <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button> : <p role="status">Loading schedule…</p>)}
      {saved && <div className={styles.content}>
        <section className={styles.card} aria-label="Imported schedule">
          {saved.items.length > 0 ? <>
            <h2>{saved.items.length} imported classes</h2>
            <p className={styles.detail}>{saved.fileName}{saved.windowStart && saved.windowEnd && <> · {date(saved.windowStart)} – {date(saved.windowEnd)}</>}</p>
            {saved.importedAt && <p className={styles.detail}>Imported {date(saved.importedAt)} at {time(saved.importedAt)} Boston time</p>}
            <div className={styles.actions}>
              <Button to="/schedule">View schedule</Button>
              <Button variant="danger" disabled={busy} onClick={() => void save(true)}>Remove imported schedule</Button>
            </div>
          </> : <p>No schedule imported.</p>}
        </section>
        <div className={styles.file}>
          <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Choose schedule file</Button>
          <span className={styles.detail} id="schedule-file-hint">.ics file · Up to 1 MB</span>
          <input hidden aria-label="Schedule file" aria-describedby="schedule-file-hint" ref={fileInput} type="file" accept=".ics,text/calendar" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void chooseFile(file);
          }} />
        </div>
        {busy && <p role="status">Updating schedule…</p>}
        {status && <p role="status">{status}</p>}
        {imported && imported.length > 0 && <p className={styles.detail} role="status">
          Schedule check, week of {check ? weekOfLabel(check.days[0].day) : '…'}: {check ? summarizeScheduleCheck(check) : 'checking walks and meal breaks…'} <Link to="/schedule">Details on Schedule</Link>
        </p>}
        {preview && <section className={styles.card} aria-label="Schedule preview">
          <h2>Preview: {preview.fileName}</h2>
          <p className={styles.detail}>{date(preview.windowStart)} – {date(preview.windowEnd)} · Boston time</p>
          {preview.warnings.length > 0 && <details className={styles.warnings}>
            <summary>{preview.warnings.length} import warnings</summary>
            <ul>{preview.warnings.slice(0, 20).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            {preview.warnings.length > 20 && <p>{preview.warnings.length - 20} more warnings.</p>}
          </details>}
          {preview.items.length === 0 ? <p>No classes found in this import window.</p> : <>
            <div className={styles.actions}>
              <span>{selected.size} of {preview.items.length} classes selected</span>
              <Button size="sm" disabled={busy} onClick={() => setSelected(new Set(preview.items.map((item) => item.id)))}>Select all</Button>
              <Button size="sm" disabled={busy} onClick={() => setSelected(new Set())}>Exclude all</Button>
            </div>
            <ul className={styles.classes}>
              {preview.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => <li key={item.id}>
                <label className={styles.classRow}>
                  <input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; });
                  }} />
                  <span><strong>{item.title}</strong><span className={styles.detail}>{date(item.start)} · {time(item.start)} – {time(item.end)}{date(item.start) !== date(item.end) && ` (${date(item.end)})`}</span><span className={styles.detail}>{item.locationText || 'No location supplied'}</span></span>
                </label>
              </li>)}
            </ul>
            <Pagination page={page} count={preview.items.length} setPage={setPage} disabled={busy} label="Classes" />
            <h3>Campus locations</h3>
            <p className={styles.detail}>Match each room to a campus place. Unmapped classes stay in your schedule without leave-by times.</p>
            <div className={styles.rooms}>
              {rooms.slice(roomPage * PAGE_SIZE, (roomPage + 1) * PAGE_SIZE).map((room) => <div className={styles.room} key={room}>
                <span>{room || 'No location supplied'}</span>
                <Select aria-label={`Campus place for ${room || 'classes with no location'}`} value={mapping.get(room) ?? ''} disabled={busy} onChange={(event) => {
                  const value = event.target.value;
                  setMapping((current) => new Map(current).set(room, value));
                }}>
                  <option value="">Unmapped</option>
                  {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </Select>
              </div>)}
            </div>
            <Pagination page={roomPage} count={rooms.length} setPage={setRoomPage} disabled={busy} label="Locations" />
            {saved.items.length > 0 && <p className={styles.detail}>Replaces your {saved.items.length} imported classes.</p>}
            <Button variant="primary" disabled={busy || selectedItems.length === 0} onClick={() => void save()}>Import {selectedItems.length} classes</Button>
          </>}
        </section>}
      </div>}
    </Page>
  );
}

function Pagination({ page, count, setPage, disabled, label }: { page: number; count: number; setPage: (page: number) => void; disabled: boolean; label: string }) {
  if (count <= PAGE_SIZE) return null;
  const pages = Math.ceil(count / PAGE_SIZE);
  return <nav className={styles.actions} aria-label={`${label} pages`}>
    <Button size="sm" disabled={disabled || page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
    <span>{label}: page {page + 1} of {pages}</span>
    <Button size="sm" disabled={disabled || page + 1 === pages} onClick={() => setPage(page + 1)}>Next</Button>
  </nav>;
}
