import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CalendarDays, CircleCheck, Home as HomeIcon, Map as MapIcon, Sparkles, UtensilsCrossed, Users } from 'lucide-react';
import { useSession } from '../auth/session';
import { config } from '../config';
import { api, useResource } from '../data/api';
import type { SchedulePreview } from '../data/types';
import { formatClock } from '../lib/format';
import { Avatar, Button, Page, SelectField, TextField } from '../ui';
import { MapBackdrop } from '../layouts/MapBackdrop';
import styles from './Welcome.module.css';

/*
 * Get started: one short step at a time, each saving as it goes through the same endpoints as
 * Calendars, Profile and Clubs, and each skippable. The step lives in ?step= so a reload, or
 * coming back from Calendars, lands where you were.
 */
const STEPS = [
  { id: 'hello', label: 'Welcome', icon: Sparkles },
  { id: 'classes', label: 'Classes', icon: CalendarDays },
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'meals', label: 'Meals', icon: UtensilsCrossed },
  { id: 'clubs', label: 'Clubs', icon: Users },
  { id: 'done', label: 'Done', icon: CircleCheck },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const message = (e: unknown) => (e instanceof Error ? e.message : 'That didn’t save. Try again.');

export default function Welcome() {
  const { session, refreshSession } = useSession();
  const [params, setParams] = useSearchParams();
  const schedule = useResource(api.getScheduleImport);
  const profile = useResource(api.getProfile);
  const locations = useResource(api.getLocations);
  const clubs = useResource(api.getClubs);

  const requested = STEPS.findIndex((s) => s.id === params.get('step'));
  const index = requested < 0 ? 0 : requested;
  const step: StepId = STEPS[index].id;
  // Direction for the slide: forward steps come in from the right, back steps from the left.
  const [direction, setDirection] = useState<1 | -1>(1);
  const panel = useRef<HTMLDivElement>(null);
  const go = (next: number) => {
    setDirection(next >= index ? 1 : -1);
    setParams(next === 0 ? {} : { step: STEPS[next].id }, { replace: false });
  };
  const next = () => go(Math.min(index + 1, STEPS.length - 1));
  const back = () => go(Math.max(index - 1, 0));

  // Each new step takes focus on its heading, so keyboard and screen-reader users start at the top.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    panel.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [step]);

  const done = {
    classes: !!schedule.data?.items.length,
    home: !!profile.data?.homeLocationId,
    meals: !!profile.data?.lunchTime && !!profile.data?.dinnerTime,
    clubs: !!clubs.data?.some((c) => c.following),
  };
  const firstName = (profile.data?.name || session?.user.name || '').split(' ')[0];

  return (
    <Page>
      <MapBackdrop />
      <div className={styles.flow}>
        <nav className={styles.steps} aria-label="Setup steps">
          <div className={styles.track} aria-hidden>
            <span className={styles.fill} style={{ transform: `scaleX(${index / (STEPS.length - 1)})` }} />
          </div>
          <ol>
            {STEPS.map((s, i) => {
              const complete = s.id in done && done[s.id as keyof typeof done];
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => go(i)} aria-current={i === index ? 'step' : undefined}
                    className={`${styles.step} ${i === index ? styles.current : ''} ${complete ? styles.passed : i < index ? styles.visited : ''}`}>
                    <span className={styles.dot}>{complete ? <CircleCheck aria-hidden /> : <s.icon aria-hidden />}</span>
                    <span className={styles.stepLabel}>{s.label}{complete && <span className="visually-hidden"> (done)</span>}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div ref={panel} key={step} className={styles.panel} data-direction={direction}>
          {step === 'hello' && (
            <section className={styles.card}>
              <p className={styles.eyebrow}>Get started</p>
              <h1 tabIndex={-1}>Welcome{firstName ? `, ${firstName}` : ''}.</h1>
              <p className={styles.lede}>Flowcast shows how busy BU will be before you get there, from a simulation of the whole campus built on published schedules, hours and seat counts.</p>
              <ul className={styles.points}>
                <li><CalendarDays aria-hidden /><span><strong>Your day, planned.</strong> Leave-by times for every class, and what fits in the gaps.</span></li>
                <li><MapIcon aria-hidden /><span><strong>Crowds before you go.</strong> Hour-by-hour projections for libraries, dining halls and gyms.</span></li>
                <li><Users aria-hidden /><span><strong>Campus life.</strong> Events and clubs, and how they change where people go.</span></li>
              </ul>
              <p className={styles.note}>Crowd levels are model projections, not live head counts. Four quick steps, all optional.</p>
              <div className={styles.actions}>
                <Button variant="primary" size="lg" onClick={next}>Set up Flowcast</Button>
                <Button variant="ghost" to="/">Skip to the dashboard</Button>
              </div>
            </section>
          )}

          {step === 'classes' && <ClassesStep state={schedule} onNext={next} onBack={back} />}

          {step === 'home' && (
            <HomeStep
              value={profile.data?.homeLocationId ?? null}
              dorms={(locations.data ?? []).filter((l) => l.kind === 'dorm')}
              loading={!profile.data || !locations.data}
              error={profile.error ?? locations.error}
              onSave={async (homeLocationId) => {
                profile.setData(await api.updateProfile({ homeLocationId }));
                await refreshSession();
              }}
              onNext={next} onBack={back} />
          )}

          {step === 'meals' && (
            <MealsStep
              lunch={profile.data?.lunchTime ?? ''} dinner={profile.data?.dinnerTime ?? ''}
              loading={!profile.data} error={profile.error}
              onSave={async (lunchTime, dinnerTime) => { profile.setData(await api.updateProfile({ lunchTime, dinnerTime })); }}
              onNext={next} onBack={back} />
          )}

          {step === 'clubs' && (
            <ClubsStep clubs={clubs.data} error={clubs.error}
              onToggle={async (id, following) => { clubs.setData(await api.setFollowing(id, following)); }}
              onNext={next} onBack={back} />
          )}

          {step === 'done' && (
            <section className={styles.card}>
              <svg className={styles.doneMark} viewBox="0 0 52 52" aria-hidden>
                <circle cx="26" cy="26" r="23" pathLength={1} />
                <path d="m16 27 7 7 13-15" pathLength={1} />
              </svg>
              <p className={styles.eyebrow}>All set</p>
              <h1 tabIndex={-1}>You’re ready to go.</h1>
              <ul className={styles.summary}>
                {([
                  ['classes', done.classes ? `${schedule.data!.items.length} classes imported` : 'No classes imported', 1],
                  ['home', done.home ? `Home: ${locations.data?.find((l) => l.id === profile.data!.homeLocationId)?.name ?? 'saved'}` : 'No home dorm set', 2],
                  ['meals', done.meals ? `Lunch ${formatClock(profile.data!.lunchTime)}, dinner ${formatClock(profile.data!.dinnerTime)}` : 'No meal times set', 3],
                  ['clubs', done.clubs ? `Following ${clubs.data!.filter((c) => c.following).length} ${clubs.data!.filter((c) => c.following).length === 1 ? 'club' : 'clubs'}` : 'Not following any clubs', 4],
                ] as const).map(([key, text, at]) => (
                  <li key={key} className={done[key] ? styles.ok : undefined}>
                    <CircleCheck aria-hidden />
                    <span>{text}</span>
                    {!done[key] && <button type="button" className={styles.link} onClick={() => go(at)}>Set up</button>}
                  </li>
                ))}
              </ul>
              <div className={styles.actions}>
                <Button variant="primary" size="lg" to="/">Go to your dashboard</Button>
                <Button href={config.mapUrl}>Open the map</Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </Page>
  );
}

/** Back, and one way forward: Continue once there's something to keep, Skip for now until then. */
function StepNav({ onBack, onNext, nextLabel = 'Continue', busy = false, ready = true }: {
  onBack: () => void; onNext: () => void; nextLabel?: string; busy?: boolean; ready?: boolean;
}) {
  return (
    <div className={styles.nav}>
      <Button variant="ghost" onClick={onBack} disabled={busy}>Back</Button>
      <span className={styles.spacer} />
      <Button variant={ready ? 'primary' : 'secondary'} onClick={onNext} disabled={busy}>{ready ? nextLabel : 'Skip for now'}</Button>
    </div>
  );
}

function ClassesStep({ state, onNext, onBack }: {
  state: ReturnType<typeof useResource<Awaited<ReturnType<typeof api.getScheduleImport>>>>;
  onNext: () => void; onBack: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const saved = state.data?.items.length ?? 0;
  const mapped = preview?.items.filter((i) => i.locationId).length ?? 0;

  async function choose(f: File | undefined) {
    if (!f) return;
    setPreview(null);
    setError(null);
    if (!/\.ics$/i.test(f.name) || f.size > 1024 * 1024) { setError('Choose an .ics file no larger than 1 MB.'); return; }
    setBusy(true);
    try { setPreview(await api.previewSchedule(f.name, await f.text())); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  async function importAll() {
    if (!preview?.items.length) return;
    setBusy(true);
    setError(null);
    try {
      state.setData(await api.importSchedule(preview.fileName, preview.items));
      setPreview(null);
      onNext();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>Step 1 of 4</p>
      <h1 tabIndex={-1}>Bring in your classes</h1>
      <p className={styles.lede}>Export your schedule as an .ics file (from the BU Student Link, Google Calendar or Outlook) and drop it here. Flowcast uses it for leave-by times and to plan the gaps between classes.</p>

      {state.error && <p role="alert" className={styles.error}>{state.error.message} <button type="button" className={styles.link} onClick={state.reload}>Try again</button></p>}
      {saved > 0 && !preview && <p className={styles.status}><CircleCheck aria-hidden /> {saved} classes imported{state.data?.fileName ? ` from ${state.data.fileName}` : ''}.</p>}

      <button type="button" className={`${styles.drop} ${dragging ? styles.dragging : ''}`} disabled={busy} onClick={() => file.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void choose(e.dataTransfer.files[0]); }}>
        <CalendarDays aria-hidden />
        <span><strong>{saved ? 'Replace with a new file' : 'Choose your schedule file'}</strong><span>or drop it here · .ics up to 1 MB</span></span>
      </button>
      <input ref={file} hidden type="file" accept=".ics,text/calendar" aria-label="Schedule file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void choose(f); }} />

      {busy && <p role="status" className={styles.note}>Reading your schedule…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {preview && (
        <div className={styles.preview} role="status">
          {preview.items.length ? <>
            <p><strong>{preview.items.length} classes</strong> found in {preview.fileName}, {mapped} matched to campus buildings.</p>
            {mapped < preview.items.length && <p className={styles.note}>Unmatched rooms still import; you can match them later in <a href="/calendars">Calendars</a>.</p>}
            {saved > 0 && <p className={styles.note}>This replaces your {saved} imported classes.</p>}
          </> : <p>No classes found in this file’s date range.</p>}
        </div>
      )}

      {preview?.items.length
        ? <StepNav onBack={onBack} onNext={() => void importAll()} nextLabel={`Import ${preview.items.length} classes`} busy={busy} />
        : <StepNav onBack={onBack} onNext={onNext} busy={busy} ready={saved > 0} />}
    </section>
  );
}

function HomeStep({ value, dorms, loading, error, onSave, onNext, onBack }: {
  value: string | null; dorms: { id: string; name: string }[]; loading: boolean; error: Error | null;
  onSave: (id: string | null) => Promise<void>; onNext: () => void; onBack: () => void;
}) {
  const [draft, setDraft] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const chosen = draft === undefined ? value : draft;

  async function save() {
    if (chosen === value) { onNext(); return; }
    setBusy(true);
    setFailed(null);
    try { await onSave(chosen); onNext(); }
    catch (e) { setFailed(message(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>Step 2 of 4</p>
      <h1 tabIndex={-1}>Where do you live?</h1>
      <p className={styles.lede}>Your home dorm is where the day starts: walking times and leave-by times for your first class are measured from it.</p>
      {error && <p role="alert" className={styles.error}>{error.message}</p>}
      {loading ? <p role="status" className={styles.note}>Loading campus places…</p> : (
        <SelectField label="Home dorm" value={chosen ?? ''} disabled={busy} onChange={(e) => setDraft(e.target.value || null)}
          hint="Off campus? Leave it unset and pick a starting building when you plan.">
          <option value="">Not set</option>
          {dorms.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </SelectField>
      )}
      {failed && <p role="alert" className={styles.error}>{failed}</p>}
      <StepNav onBack={onBack} onNext={() => void save()} busy={busy || loading} ready={!!chosen} />
    </section>
  );
}

function MealsStep({ lunch, dinner, loading, error, onSave, onNext, onBack }: {
  lunch: string; dinner: string; loading: boolean; error: Error | null;
  onSave: (lunch: string, dinner: string) => Promise<void>; onNext: () => void; onBack: () => void;
}) {
  const [draft, setDraft] = useState<{ lunch: string; dinner: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const times = draft ?? { lunch, dinner };
  const invalid = (times.lunch && !TIME.test(times.lunch)) || (times.dinner && !TIME.test(times.dinner))
    ? 'Enter times like 12:15.'
    : times.lunch && times.dinner && times.lunch >= times.dinner ? 'Dinner needs to be later than lunch.' : null;

  async function save() {
    if (invalid) return;
    if (times.lunch === lunch && times.dinner === dinner) { onNext(); return; }
    setBusy(true);
    setFailed(null);
    try { await onSave(times.lunch, times.dinner); onNext(); }
    catch (e) { setFailed(message(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>Step 3 of 4</p>
      <h1 tabIndex={-1}>When do you usually eat?</h1>
      <p className={styles.lede}>Flowcast uses your meal times to suggest a dining hall that fits between classes, and to warn you about the rush.</p>
      {error && <p role="alert" className={styles.error}>{error.message}</p>}
      {loading ? <p role="status" className={styles.note}>Loading your profile…</p> : (
        <div className={styles.pair}>
          <TextField label="Lunch" type="time" value={times.lunch} disabled={busy} onChange={(e) => setDraft({ ...times, lunch: e.target.value })} />
          <TextField label="Dinner" type="time" value={times.dinner} disabled={busy} onChange={(e) => setDraft({ ...times, dinner: e.target.value })} error={invalid ?? undefined} />
        </div>
      )}
      {failed && <p role="alert" className={styles.error}>{failed}</p>}
      <StepNav onBack={onBack} onNext={() => void save()} busy={busy || loading || !!invalid} ready={!!(times.lunch || times.dinner)} />
    </section>
  );
}

function ClubsStep({ clubs, error, onToggle, onNext, onBack }: {
  clubs: { id: string; name: string; verified: boolean; following: boolean; description: string }[] | null;
  error: Error | null; onToggle: (id: string, following: boolean) => Promise<void>; onNext: () => void; onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = (clubs ?? [])
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .sort((a, b) => Number(b.following) - Number(a.following) || Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name))
    .slice(0, q ? 30 : 12);
  const count = clubs?.filter((c) => c.following).length ?? 0;

  async function toggle(id: string, following: boolean) {
    setPending(id);
    setFailed(null);
    try { await onToggle(id, following); }
    catch (e) { setFailed(message(e)); }
    finally { setPending(null); }
  }

  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>Step 4 of 4</p>
      <h1 tabIndex={-1}>Follow a few clubs</h1>
      <p className={styles.lede}>Their events show up on your dashboard. {count > 0 && <strong>Following {count}.</strong>}</p>
      {error && <p role="alert" className={styles.error}>{error.message}</p>}
      <TextField label="Search clubs" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Robotics, dance, debate…" />
      {!clubs ? <p role="status" className={styles.note}>Loading clubs…</p> : (
        <ul className={styles.clubs}>
          {shown.map((c, i) => (
            <li key={c.id} style={{ ['--i' as string]: i }}>
              <Avatar name={c.name} />
              <span className={styles.clubName}>{c.name}{c.verified && <span className={styles.badge}>Verified</span>}</span>
              <Button key={`${c.id}-${c.following}`} className={c.following ? styles.followed : undefined}
                size="sm" variant={c.following ? 'secondary' : 'primary'} disabled={pending === c.id}
                aria-pressed={c.following} onClick={() => void toggle(c.id, !c.following)}>
                {c.following ? 'Following' : 'Follow'}
              </Button>
            </li>
          ))}
          {!shown.length && <li className={styles.note}>No clubs match “{query}”.</li>}
        </ul>
      )}
      {failed && <p role="alert" className={styles.error}>{failed}</p>}
      <StepNav onBack={onBack} onNext={onNext} nextLabel="Finish" />
    </section>
  );
}
