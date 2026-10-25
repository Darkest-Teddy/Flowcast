// Pick this term's classes from BU's published catalog.
//
// Search runs on the server against the committed snapshot, so the list only ever contains sections
// BU actually publishes a meeting pattern for. Choosing a section stores its key; the server expands
// it into dated meetings using the academic calendar. Anything imported from an .ics file is kept.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useResource } from '../data/api';
import type { Course, CourseMeetingSlot, CourseSearchResult, CourseSection } from '../data/types';
import { Button, EmptyState, Loading, Page, PageHeader, SectionList, StatusBadge, TextField } from '../ui';
import styles from './Courses.module.css';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clockOf(seconds: number) {
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, '0')}${suffix}`;
}

/** "Mon Wed 12:30pm–1:45pm · CAS 201", one line per distinct time, days merged. */
function describeSlots(slots: CourseMeetingSlot[]): string[] {
  const byTime = new Map<string, { days: number[]; slot: CourseMeetingSlot }>();
  for (const slot of slots) {
    const key = `${slot.startSec}-${slot.endSec}-${slot.buildingCode ?? ''}-${slot.roomCode ?? ''}`;
    const group = byTime.get(key);
    if (group) group.days.push(slot.weekday);
    else byTime.set(key, { days: [slot.weekday], slot });
  }
  return [...byTime.values()].map(({ days, slot }) => {
    const label = [...new Set(days)].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? '?').join(' ');
    const room = [slot.buildingCode, slot.roomCode].filter(Boolean).join(' ');
    return `${label} ${clockOf(slot.startSec)}–${clockOf(slot.endSec)}${room ? ` · ${room}` : ''}`;
  });
}

/** Weekly minutes of two sections that land on the same weekday and overlap in time. */
function clashes(a: CourseMeetingSlot[], b: CourseMeetingSlot[]): boolean {
  return a.some((x) => b.some((y) => x.weekday === y.weekday && x.startSec < y.endSec && y.startSec < x.endSec));
}

interface Chosen {
  key: string;
  courseCode: string;
  title: string;
  section: string;
  slots: CourseMeetingSlot[];
}

export default function Courses() {
  const saved = useResource(api.getScheduleImport);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CourseSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Map<string, Chosen>>(new Map());
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const latest = useRef(0);

  // What the account already holds, so reopening the picker shows the current selection.
  useEffect(() => {
    if (!saved.data || savedKeys !== null) return;
    setSavedKeys(saved.data.courseSections ?? []);
  }, [saved.data, savedKeys]);

  // Debounced search. Only the newest response is allowed to land.
  useEffect(() => {
    const run = ++latest.current;
    const timer = setTimeout(() => {
      setSearching(true);
      api.searchCourses(query)
        .then((data) => { if (run === latest.current) { setResults(data); setSearchError(null); } })
        .catch((error: unknown) => { if (run === latest.current) setSearchError(error instanceof Error ? error.message : 'Search failed.'); })
        .finally(() => { if (run === latest.current) setSearching(false); });
    }, query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  // Saved sections are almost never on the first page of the catalog, so fetch them by key rather
  // than waiting for a search to happen to contain them.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !savedKeys?.length) return;
    seeded.current = true;
    api.coursesByKey(savedKeys)
      .then((data) => setChosen((current) => {
        const next = new Map(current);
        for (const course of data.courses) {
          for (const section of course.sections) {
            next.set(section.key, { key: section.key, courseCode: course.courseCode, title: course.title, section: section.section, slots: section.slots });
          }
        }
        return next;
      }))
      .catch(() => { /* The picker still works; the saved list just starts empty. */ });
  }, [savedKeys]);

  const chosenList = useMemo(() => [...chosen.values()].sort((a, b) => a.courseCode.localeCompare(b.courseCode)), [chosen]);
  const conflicts = useMemo(() => {
    const pairs: string[] = [];
    for (let i = 0; i < chosenList.length; i++) {
      for (let j = i + 1; j < chosenList.length; j++) {
        if (clashes(chosenList[i].slots, chosenList[j].slots)) {
          pairs.push(`${chosenList[i].courseCode} ${chosenList[i].section} and ${chosenList[j].courseCode} ${chosenList[j].section}`);
        }
      }
    }
    return pairs;
  }, [chosenList]);

  const dirty = useMemo(() => {
    if (savedKeys === null) return false;
    const a = [...chosen.keys()].sort().join('|');
    return a !== [...savedKeys].sort().join('|');
  }, [chosen, savedKeys]);

  function toggle(course: Course, section: CourseSection) {
    setSavedCount(null);
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(section.key)) next.delete(section.key);
      else next.set(section.key, { key: section.key, courseCode: course.courseCode, title: course.title, section: section.section, slots: section.slots });
      return next;
    });
  }

  function remove(key: string) {
    setSavedCount(null);
    setChosen((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  function save() {
    setSaving(true);
    setSaveError(null);
    api.saveCourseSections([...chosen.keys()])
      .then((state) => {
        setSavedKeys(state.courseSections ?? []);
        setSavedCount(state.items.filter((item) => item.source === 'course').length);
        saved.setData(state);
      })
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : 'Could not save your classes.'))
      .finally(() => setSaving(false));
  }

  const header = (
    <PageHeader
      title="Add your classes"
      description={`Search BU's published ${results?.term ?? ''} schedule and pick the sections you are taking.`.replace('  ', ' ')}
      actions={<Button to="/schedule">View schedule</Button>}
    />
  );

  if (saved.error) {
    return <Page>{header}<EmptyState title="Your schedule didn't load" body={saved.error.message}
      action={<Button onClick={saved.reload}>Try again</Button>} /></Page>;
  }

  return (
    <Page>
      {header}

      <div className={styles.searchRow}>
        <TextField
          label="Search the catalog"
          placeholder="Course code or title, like CAS CS 112 or organic chemistry"
          value={query}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          hint={searchError ? undefined : results ? `${results.total} matching section${results.total === 1 ? '' : 's'}${results.total > results.courses.length ? `, showing ${results.courses.length} courses` : ''}.` : 'Published meeting patterns only.'}
          error={searchError ?? undefined}
        />
      </div>

      {chosenList.length > 0 && (
        <SectionList title="Your classes" count={chosenList.length} empty="">
          {chosenList.map((item) => (
            <div key={item.key} className={styles.chosenRow}>
              <div className={styles.chosenMain}>
                <strong>{item.courseCode} {item.section}</strong>
                <p className={styles.muted}>{item.title}</p>
                {describeSlots(item.slots).map((line) => <p key={line} className={styles.slot}>{line}</p>)}
              </div>
              <Button variant="ghost" size="sm" onClick={() => remove(item.key)}
                aria-label={`Remove ${item.courseCode} section ${item.section}`}>
                Remove
              </Button>
            </div>
          ))}
        </SectionList>
      )}

      {conflicts.length > 0 && (
        <div role="status" className={styles.conflicts}>
          <StatusBadge tone="warn">Overlapping times</StatusBadge>
          <ul>{conflicts.map((pair) => <li key={pair}>{pair} meet at the same time.</li>)}</ul>
          <p className={styles.muted}>You can still save these; Flowcast will show both.</p>
        </div>
      )}

      <div className={styles.saveRow}>
        <Button variant="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : chosenList.length ? `Save ${chosenList.length} class${chosenList.length === 1 ? '' : 'es'}` : 'Clear my classes'}
        </Button>
        {saveError && <p role="alert" className={styles.error}>{saveError}</p>}
        {!saveError && savedCount !== null && (
          <p className={styles.saved}>Saved. {savedCount} meeting{savedCount === 1 ? '' : 's'} added to your schedule for the next 120 days.</p>
        )}
        {!saveError && savedCount === null && !dirty && savedKeys?.length ? <p className={styles.muted}>These classes are saved.</p> : null}
      </div>

      {searching && !results && <Loading label="Searching the catalog" />}

      {results && (
        <SectionList
          title={query ? 'Search results' : 'Catalog'}
          count={results.courses.length}
          empty="No published course matches that search."
        >
          {results.courses.map((course) => (
            <div key={course.courseCode} className={styles.course}>
              <div className={styles.courseHead}>
                <strong>{course.courseCode}</strong>
                <span className={styles.muted}>{course.title}</span>
              </div>
              <ul className={styles.sections}>
                {course.sections.map((section) => {
                  const picked = chosen.has(section.key);
                  return (
                    <li key={section.key} className={styles.section}>
                      <label className={styles.sectionLabel}>
                        <input type="checkbox" checked={picked} onChange={() => toggle(course, section)} />
                        <span className={styles.sectionBody}>
                          <strong>Section {section.section}</strong>
                          {describeSlots(section.slots).map((line) => <span key={line} className={styles.slot}>{line}</span>)}
                        </span>
                      </label>
                      {section.sourceUrl && (
                        <a className={styles.source} href={section.sourceUrl} target="_blank" rel="noreferrer noopener">Source</a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </SectionList>
      )}
    </Page>
  );
}
