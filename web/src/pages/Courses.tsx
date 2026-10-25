import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { api, locationName, useResource } from '../data/api';
import type { CourseOffering, MyCourse, Weekday } from '../data/types';
import { expandOccurrences, parseIcs } from '../lib/ics';
import { formatClock } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, Segmented, SectionList, TextField, SelectField } from '../ui';
import styles from './Courses.module.css';

const MAX_BYTES = 2 * 1024 * 1024;
const CATALOG_RESULT_LIMIT = 40;
const ALL_DAYS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Tab = 'catalog' | 'ics';
type Occurrence = { title: string; location: string | null; start: string; end: string };
type Picked =
  | { state: 'ready'; fileName: string; occurrences: Occurrence[]; planned: Awaited<ReturnType<typeof api.previewCourseImport>> }
  | { state: 'invalid'; fileName: string; error: string };
type EditableFields = Pick<MyCourse, 'code' | 'title' | 'section' | 'instructor' | 'days' | 'startTime' | 'endTime' | 'locationId'>;

function meetingPattern(o: { days: Weekday[]; startTime: string; endTime: string }): string {
  return `${o.days.join('/')} · ${formatClock(o.startTime)}–${formatClock(o.endTime)}`;
}

function toFields(c: MyCourse): EditableFields {
  return { code: c.code, title: c.title, section: c.section, instructor: c.instructor, days: c.days, startTime: c.startTime, endTime: c.endTime, locationId: c.locationId };
}

/** Day-of-week multi-toggle: Segmented is single-select, and a course can meet on several days. */
function DayToggle({ value, onChange }: { value: Weekday[]; onChange: (days: Weekday[]) => void }) {
  return (
    <div className={styles.days} role="group" aria-label="Meeting days">
      {ALL_DAYS.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            className={on ? styles.dayOn : styles.day}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}
          >
            {d[0]}
          </button>
        );
      })}
    </div>
  );
}

/** Shared editor for any course already on the schedule, whatever its source. */
function CourseEditForm({
  initial,
  locations,
  onSave,
  onCancel,
  saving,
  error,
}: {
  initial: EditableFields;
  locations: { id: string; name: string }[];
  onSave: (fields: EditableFields) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [fields, setFields] = useState(initial);
  const set = <K extends keyof EditableFields>(key: K, value: EditableFields[K]) => setFields((f) => ({ ...f, [key]: value }));

  return (
    <form
      className={styles.editForm}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(fields);
      }}
    >
      <div className={styles.editGrid}>
        <TextField label="Course code" value={fields.code} onChange={(e) => set('code', e.target.value)} required />
        <TextField label="Title" value={fields.title} onChange={(e) => set('title', e.target.value)} required />
        <TextField label="Section" value={fields.section ?? ''} onChange={(e) => set('section', e.target.value || undefined)} />
        <TextField label="Instructor" value={fields.instructor ?? ''} onChange={(e) => set('instructor', e.target.value || undefined)} />
        <TextField label="Start time" type="time" value={fields.startTime} onChange={(e) => set('startTime', e.target.value)} required />
        <TextField label="End time" type="time" value={fields.endTime} onChange={(e) => set('endTime', e.target.value)} required />
        <SelectField label="Location" value={fields.locationId} onChange={(e) => set('locationId', e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
      </div>
      <div className={styles.editDays}>
        <span className={styles.editDaysLabel}>Meeting days</span>
        <DayToggle value={fields.days} onChange={(days) => set('days', days)} />
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.publish}>
        <Button variant="accent" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function Courses() {
  const locations = useResource(api.getLocations);
  const catalog = useResource(api.getCourseCatalog);
  const myCourses = useResource(api.getMyCourses);
  const [tab, setTab] = useState<Tab>('catalog');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const add = (offeringId: string) => {
    setPending(offeringId);
    api.addCourse(offeringId).then((r) => myCourses.setData(r.myCourses)).finally(() => setPending(null));
  };
  const remove = (courseId: string) => {
    setPending(courseId);
    api.removeCourse(courseId).then((r) => myCourses.setData(r.myCourses)).finally(() => setPending(null));
  };
  const saveEdit = (courseId: string, fields: EditableFields) => {
    if (!fields.days.length) {
      setEditError('Pick at least one meeting day.');
      return;
    }
    setPending(courseId);
    setEditError(null);
    api
      .updateCourse(courseId, fields)
      .then((r) => {
        myCourses.setData(r.myCourses);
        setEditing(null);
      })
      .catch((e: unknown) => setEditError(e instanceof Error ? e.message : 'That change wasn’t saved. Try again.'))
      .finally(() => setPending(null));
  };

  const filtered = useMemo(() => {
    if (!catalog.data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog.data.filter((o: CourseOffering) => o.code.toLowerCase().includes(q) || o.title.toLowerCase().includes(q)).slice(0, CATALOG_RESULT_LIMIT);
  }, [catalog.data, query]);

  async function read(file: File) {
    setResult(null);
    if (!/\.ics$/i.test(file.name) && file.type !== 'text/calendar') {
      setPicked({ state: 'invalid', fileName: file.name, error: 'This isn’t an .ics file. Export your course calendar as .ics, then choose that file.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPicked({ state: 'invalid', fileName: file.name, error: 'This file is larger than 2 MB. Export just this semester’s schedule and try again.' });
      return;
    }
    const parsed = parseIcs(await file.text());
    if (!parsed.ok) {
      setPicked({ state: 'invalid', fileName: file.name, error: parsed.error });
      return;
    }
    const { start, end } = api.getCourseImportWindow();
    const occurrences = expandOccurrences(parsed.events, start, end);
    if (!occurrences.length) {
      setPicked({ state: 'invalid', fileName: file.name, error: 'No class meetings fall in the next two weeks. Check that the file covers the current term.' });
      return;
    }
    setPreviewing(true);
    const planned = await api.previewCourseImport(occurrences);
    setPreviewing(false);
    if (!planned.length) {
      setPicked({ state: 'invalid', fileName: file.name, error: 'Everything in this file looked like an exam block, so there’s nothing to add.' });
      return;
    }
    setPicked({ state: 'ready', fileName: file.name, occurrences, planned });
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

  async function commit() {
    if (picked?.state !== 'ready') return;
    setCommitting(true);
    try {
      const r = await api.addCoursesFromIcs(picked.occurrences);
      myCourses.setData(r.myCourses);
      setResult({ ok: true, text: `Added ${r.addedCount} ${r.addedCount === 1 ? 'course' : 'courses'} from ${picked.fileName} to your schedule.` });
      reset();
    } catch {
      setResult({ ok: false, text: 'Your courses weren’t added. Check your connection and try again.' });
    } finally {
      setCommitting(false);
    }
  }

  const header = (
    <PageHeader
      title="Courses"
      description="Add your classes so your agent on the map follows your real schedule. Pick them from the real BU course catalog, import your schedule, or edit anything afterward."
    />
  );

  return (
    <Page>
      {header}

      <SectionList
        title="My courses"
        count={myCourses.data?.length ?? undefined}
        empty="You haven’t added any courses yet. Browse the catalog or import your schedule below."
      >
        {myCourses.data?.map((c) =>
          editing === c.id ? (
            <CourseEditForm
              key={c.id}
              initial={toFields(c)}
              locations={locations.data ?? []}
              saving={pending === c.id}
              error={editError}
              onSave={(fields) => saveEdit(c.id, fields)}
              onCancel={() => {
                setEditing(null);
                setEditError(null);
              }}
            />
          ) : (
            <div key={c.id} className={styles.row}>
              <div className={styles.main}>
                <div className={styles.name}>
                  {c.code} {c.section && <span className={styles.section}>Sec {c.section}</span>}
                </div>
                {c.title !== c.code && <p className={styles.description}>{c.title}</p>}
                <p className={styles.meeting}>
                  {meetingPattern(c)} · {locationName(locations.data ?? null, c.locationId, false)}
                </p>
              </div>
              <div className={styles.trailing}>
                <span className={styles.via}>{c.source === 'ics' ? 'Imported' : 'Catalog'}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending === c.id}
                  onClick={() => {
                    setEditing(c.id);
                    setEditError(null);
                  }}
                >
                  Edit
                </Button>
                <Button variant="ghost" size="sm" disabled={pending === c.id} onClick={() => remove(c.id)} aria-label={`Remove ${c.code}`}>
                  Remove
                </Button>
              </div>
            </div>
          ),
        )}
      </SectionList>

      <Segmented
        label="How to add a course"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'catalog', label: 'Browse catalog' },
          { value: 'ics', label: 'Import a calendar' },
        ]}
      />

      {tab === 'catalog' ? (
        <div className={styles.catalog}>
          <TextField label="Search the BU course catalog" hint="By course code or title — start typing to search 6,900+ real sections" placeholder="CS 112, Calculus…" value={query} onChange={(e) => setQuery(e.target.value)} />

          {catalog.error ? (
            <p className={styles.error} role="alert">
              The catalog didn’t load. <Button variant="ghost" size="sm" onClick={catalog.reload}>Try again</Button>
            </p>
          ) : !catalog.data || !myCourses.data ? (
            <Loading label="Loading the course catalog" />
          ) : !query.trim() ? (
            <EmptyState title="Search for a course" body="Type a course code (like “CS 112”) or a title to search the real BU catalog." />
          ) : filtered.length === 0 ? (
            <EmptyState title="No courses match" body="Try a different course code or title." />
          ) : (
            <SectionList title="Catalog" count={filtered.length}>
              {filtered.map((o) => {
                const added = myCourses.data!.some((c) => c.id === o.id);
                return (
                  <div key={o.id} className={styles.row}>
                    <div className={styles.main}>
                      <div className={styles.name}>
                        {o.code} <span className={styles.section}>Sec {o.section}</span>
                      </div>
                      <p className={styles.description}>
                        {o.title}
                        {o.instructor ? ` · ${o.instructor}` : ''}
                      </p>
                      <p className={styles.meeting}>
                        {meetingPattern(o)} · {locationName(locations.data ?? null, o.locationId, false)}
                      </p>
                    </div>
                    <Button
                      variant={added ? 'ghost' : 'secondary'}
                      size="sm"
                      disabled={pending === o.id}
                      onClick={() => (added ? remove(o.id) : add(o.id))}
                      aria-label={`${added ? 'Remove' : 'Add'} ${o.code}`}
                    >
                      {added ? 'Remove' : 'Add'}
                    </Button>
                  </div>
                );
              })}
              {catalog.data.filter((o) => o.code.toLowerCase().includes(query.trim().toLowerCase()) || o.title.toLowerCase().includes(query.trim().toLowerCase())).length > CATALOG_RESULT_LIMIT && (
                <p className={styles.more}>Showing the first {CATALOG_RESULT_LIMIT} matches. Narrow your search to see more.</p>
              )}
            </SectionList>
          )}
        </div>
      ) : (
        <div className={styles.icsTab}>
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
              <p className={styles.dropTitle}>Drop a course calendar here</p>
              <p className={styles.dropHint}>An .ics export of your class schedule. Flowcast recognizes real BU courses automatically and fills in the official time, room and instructor when it finds a match; exam blocks are skipped.</p>
              <input
                ref={input}
                id="course-ics-file"
                type="file"
                accept=".ics,text/calendar"
                className="visually-hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) read(file);
                }}
              />
              <Button onClick={() => input.current?.click()} disabled={previewing} aria-describedby={picked?.state === 'invalid' ? 'course-ics-error' : undefined}>
                {previewing ? 'Reading…' : 'Choose a file'}
              </Button>
            </div>
          )}

          {picked?.state === 'invalid' && (
            <div className={styles.problem} role="alert" id="course-ics-error">
              <p className={styles.problemTitle}>{picked.fileName} can’t be added</p>
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
              <SectionList title={`Classes found in ${picked.fileName}`} count={picked.planned.length}>
                {picked.planned.map((p) => (
                  <div key={p.id} className={styles.row}>
                    <div className={styles.main}>
                      <div className={styles.name}>
                        {p.code} {p.section && <span className={styles.section}>Sec {p.section}</span>}
                      </div>
                      {p.title !== p.code && <p className={styles.description}>{p.title}</p>}
                      <p className={styles.meeting}>
                        {meetingPattern(p)} · {locationName(locations.data ?? null, p.locationId, false)}
                      </p>
                    </div>
                    <span className={styles.via}>{p.alreadyAdded ? 'Already added' : p.id.startsWith('ics:') ? 'Not in catalog' : 'Recognized'}</span>
                  </div>
                ))}
              </SectionList>
              <div className={styles.publish}>
                <Button variant="accent" onClick={commit} disabled={committing}>
                  {committing ? 'Adding…' : 'Add to my schedule'}
                </Button>
                <Button variant="ghost" onClick={reset} disabled={committing}>
                  Choose a different file
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
