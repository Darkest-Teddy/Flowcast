import { useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { useSession } from '../../auth/session';
import { api, useResource } from '../../data/api';
import type { CalendarImport } from '../../data/types';
import { formatDateTime, formatDayLabel, formatRelative } from '../../lib/format';
import { Button, CellStack, EmptyState, ListRow, Loading, Page, PageHeader, SectionHeading, SectionList, StatusBadge, Table, type Column } from '../../ui';
import { parseIcs, type IcsEvent } from './ics';
import styles from './ClubCalendar.module.css';

const MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_LIMIT = 50;

type Picked =
  | { state: 'ready'; fileName: string; events: IcsEvent[] }
  | { state: 'invalid'; fileName: string; error: string };

const importColumns: Column<CalendarImport>[] = [
  { key: 'file', header: 'File', render: (r) => <CellStack primary={r.fileName} secondary={r.error ?? undefined} /> },
  { key: 'when', header: 'Imported', render: (r) => formatRelative(r.importedAt) },
  { key: 'events', header: 'Events', align: 'right', render: (r) => r.eventCount },
  {
    key: 'result',
    header: 'Result',
    render: (r) => (r.error ? <StatusBadge tone="bad">Failed</StatusBadge> : <StatusBadge tone="ok">Published</StatusBadge>),
  },
];

export default function ClubCalendar() {
  const { session } = useSession();
  const clubId = session?.officerOfClubId ?? '';
  const imports = useResource(() => api.getCalendarImports(clubId), [clubId]);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function read(file: File) {
    setResult(null);
    if (!/\.ics$/i.test(file.name) && file.type !== 'text/calendar') {
      setPicked({ state: 'invalid', fileName: file.name, error: 'This isn’t an .ics file. Export your calendar as .ics (iCalendar) and choose that file.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPicked({ state: 'invalid', fileName: file.name, error: 'This file is larger than 2 MB. Export only this semester’s events and try again.' });
      return;
    }
    const parsed = parseIcs(await file.text());
    setPicked(parsed.ok ? { state: 'ready', fileName: file.name, events: parsed.events } : { state: 'invalid', fileName: file.name, error: parsed.error });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) read(file);
  }

  function reset() {
    setPicked(null);
    if (input.current) input.current.value = '';
  }

  async function publish() {
    if (picked?.state !== 'ready') return;
    setPublishing(true);
    try {
      await api.uploadClubCalendar(clubId, picked.fileName, picked.events.length);
      const n = picked.events.length;
      setResult({ ok: true, text: `Published ${n} ${n === 1 ? 'event' : 'events'} from ${picked.fileName}. They’re in Flowcast now.` });
      reset();
      imports.reload();
    } catch {
      setResult({ ok: false, text: 'Your events weren’t published. Check your connection and try again.' });
    } finally {
      setPublishing(false);
    }
  }

  if (!clubId) {
    return (
      <Page>
        <PageHeader title="Upload calendar" />
        <EmptyState title="You’re not an officer of a verified club" body="Once the Flowcast team verifies your club, you can upload its calendar here." action={<Button to="/clubs/register">Register your club</Button>} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Upload calendar"
        description="Add your club’s events from an .ics file. They appear in Flowcast for every student, not in anyone’s Google Calendar."
      />

      {picked?.state !== 'ready' && (
        <div
          className={`${styles.drop} ${dragging ? styles.dragging : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload aria-hidden className={styles.dropIcon} />
          <p className={styles.dropTitle}>Drop an .ics file here</p>
          <p className={styles.dropHint}>In Google Calendar, open Settings, then Import and export, and export your club’s calendar.</p>
          <input
            ref={input}
            id="ics-file"
            type="file"
            accept=".ics,text/calendar"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) read(file);
            }}
          />
          <Button onClick={() => input.current?.click()} aria-describedby={picked?.state === 'invalid' ? 'ics-error' : undefined}>
            Choose a file
          </Button>
        </div>
      )}

      {picked?.state === 'invalid' && (
        <div className={styles.problem} role="alert" id="ics-error">
          <p className={styles.problemTitle}>{picked.fileName} can’t be published</p>
          <p>{picked.error}</p>
        </div>
      )}

      {result && (
        <p className={result.ok ? styles.ok : styles.error} role="status">
          {result.text}
        </p>
      )}

      {picked?.state === 'ready' && (
        <>
          <SectionList title={`Events in ${picked.fileName}`} count={picked.events.length}>
            {picked.events.slice(0, PREVIEW_LIMIT).map((ev) => (
              <ListRow
                key={`${ev.line}`}
                title={ev.title}
                subtitle={ev.location || undefined}
                detail={ev.allDay ? `${formatDayLabel(ev.start)}, all day` : formatDateTime(ev.start)}
              />
            ))}
          </SectionList>
          {picked.events.length > PREVIEW_LIMIT && (
            <p className={styles.more}>And {picked.events.length - PREVIEW_LIMIT} more events.</p>
          )}
          <div className={styles.publish}>
            <Button variant="accent" onClick={publish} disabled={publishing}>
              {publishing ? 'Publishing…' : 'Publish to Flowcast'}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={publishing}>
              Choose a different file
            </Button>
          </div>
        </>
      )}

      <SectionHeading>Past imports</SectionHeading>
      {imports.error ? (
        <p className={styles.error} role="alert">
          Past imports didn’t load. <Button variant="ghost" size="sm" onClick={imports.reload}>Try again</Button>
        </p>
      ) : !imports.data ? (
        <Loading label="Loading past imports" />
      ) : imports.data.length === 0 ? (
        <EmptyState title="No imports yet" body="Files you publish show up here, with any problems we found." />
      ) : (
        <Table caption="Past calendar imports" columns={importColumns} rows={imports.data} rowKey={(r) => r.id} />
      )}
    </Page>
  );
}
