import { useState, type FormEvent } from 'react';
import { api, useResource } from '../../data/api';
import { formatDayLabel } from '../../lib/format';
import { DEFAULT_PLAN, MAX_NEAR, planProblem, slotRoom, type EventPlan, type EventSlotsResult } from '../../lib/eventSlots';
import { Button, CrowdMeter, EmptyState, ListRow, Loading, SectionHeading, SectionList, SelectField, TextField } from '../../ui';
import styles from './PlanEvent.module.css';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DURATIONS = [60, 90, 120, 180];
const CAMPUSES: { value: EventPlan['campus']; label: string }[] = [
  { value: 'charles-river', label: 'Charles River' },
  { value: 'medical', label: 'Medical' },
  { value: 'fenway', label: 'Fenway' },
];

type State = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; result: EventSlotsResult };

const day = (date: string) => formatDayLabel(`${date}T12:00:00`);

/**
 * Plan an event: rooms with enough published seats and evenings this week with no published class
 * in the room, no big venue event nearby, low modeled crowding nearby and parking close by. With the
 * places members come from, the rooms with the shortest average walk for them come first. It only
 * reads schedules and model figures; nothing is booked.
 */
export function PlanEvent({ title = 'Plan an event' }: { title?: string }) {
  const [plan, setPlan] = useState<EventPlan>(DEFAULT_PLAN);
  const locations = useResource(api.getLocations);
  // Members come from dorms and the buildings they have class in; libraries and dining are rarely a starting point.
  const places = (locations.data ?? []).filter((l) => l.kind === 'dorm' || l.kind === 'classroom').sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string) => places.find((l) => l.id === id)?.name ?? id;
  const [state, setState] = useState<State>({ status: 'idle' });
  const problem = planProblem(plan);
  const set = <K extends keyof EventPlan>(key: K, value: EventPlan[K]) => setPlan((p) => ({ ...p, [key]: value }));
  const toggleDay = (d: number) => set('days', plan.days.includes(d) ? plan.days.filter((x) => x !== d) : [...plan.days, d]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setState({ status: 'loading' });
    try {
      setState({ status: 'done', result: await api.getEventSlots(plan) });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'The event planner didn’t answer.' });
    }
  }

  return (
    <section className={styles.plan} aria-labelledby="plan-event">
      <SectionHeading><span id="plan-event">{title}</span></SectionHeading>
      <p className={styles.intro}>
        Find a room with enough seats and a time this week that fits your group, away from classes, big games and concerts.
        Add where your members live or have class, and the rooms that are the shortest walk for everyone come first.
        Flowcast only reads published schedules and model figures: it never books or holds a room.
      </p>
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField label="People" type="number" inputMode="numeric" min={1} max={2000} value={Number.isFinite(plan.headcount) ? plan.headcount : ''}
          onChange={(e) => set('headcount', e.target.valueAsNumber)} />
        <TextField label="Earliest start" type="time" value={plan.from} onChange={(e) => set('from', e.target.value)} />
        <TextField label="Latest end" type="time" value={plan.to} onChange={(e) => set('to', e.target.value)} />
        <SelectField label="Length" value={plan.durationMin} onChange={(e) => set('durationMin', Number(e.target.value))}>
          {DURATIONS.map((m) => <option key={m} value={m}>{m < 120 ? `${m} minutes` : `${m / 60} hours`}</option>)}
        </SelectField>
        <SelectField label="Campus" value={plan.campus} onChange={(e) => set('campus', e.target.value as EventPlan['campus'])}>
          {CAMPUSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </SelectField>
        <fieldset className={styles.near}>
          <legend>Where members come from <span className={styles.hint}>(optional, up to {MAX_NEAR} places)</span></legend>
          <SelectField label="Add a dorm or class building" value="" disabled={plan.near.length >= MAX_NEAR || !places.length}
            onChange={(e) => e.target.value && !plan.near.includes(e.target.value) && set('near', [...plan.near, e.target.value])}>
            <option value="">{locations.loading ? 'Loading places…' : 'Choose a place'}</option>
            {places.filter((l) => !plan.near.includes(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </SelectField>
          {plan.near.length > 0 && (
            <ul className={styles.nearList} aria-label="Members' places">
              {plan.near.map((id) => (
                <li key={id}>
                  <span>{nameOf(id)}</span>
                  <button type="button" onClick={() => set('near', plan.near.filter((x) => x !== id))} aria-label={`Remove ${nameOf(id)}`}>×</button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <fieldset className={styles.days}>
          <legend>Days <span className={styles.hint}>(none chosen: the whole week)</span></legend>
          {DAY_NAMES.map((name, d) => (
            <button key={name} type="button" className={styles.dayChip} aria-pressed={plan.days.includes(d)} onClick={() => toggleDay(d)}>{name}</button>
          ))}
        </fieldset>
        <div className={styles.submit}>
          <Button type="submit" variant="primary" disabled={!!problem || state.status === 'loading'}>Find rooms and evenings</Button>
          {problem && <p className={styles.problem} role="status">{problem}</p>}
        </div>
      </form>

      {state.status === 'loading' && <Loading label="Checking rooms and evenings" />}
      {state.status === 'error' && <p className={styles.error} role="alert">{state.message}</p>}
      {state.status === 'done' && <Results result={state.result} />}
    </section>
  );
}

function Results({ result }: { result: EventSlotsResult }) {
  const week = result.days.length ? `${day(result.days[0].date)} to ${day(result.days[result.days.length - 1].date)}` : '';
  return (
    <div className={styles.results}>
      <p className={styles.caveat} role="note">{result.caveat}</p>
      {result.slots.length === 0 ? (
        <EmptyState
          title="No room and time fits"
          body={result.largestRoom
            ? `No room with published seats holds ${result.headcount}. The largest is ${result.largestRoom.room}, ${result.largestRoom.building} (${result.largestRoom.seats} seats).`
            : 'Every room with enough seats has a class, a listed event or a big venue event nearby in that window. Try other days or times.'}
        />
      ) : (
        <SectionList title={`Rooms for ${result.headcount}, ${result.window.from} to ${result.window.to}${week ? `, ${week}` : ''}${result.near.length ? `, nearest to ${result.near.join(', ')}` : ''}`} count={result.slots.length}>
          {result.slots.map((s) => (
            <ListRow
              key={`${s.date}|${s.building}|${s.room}|${s.start}`}
              title={`${day(s.date)}, ${s.start}–${s.end}`}
              // Room, seats and walk first; the reasons below wrap under it (a row's detail column never wraps).
              subtitle={<>
                {`${slotRoom(s)} · ${s.seats} seats for ${result.headcount}${s.walk ? ` · ${s.walk.average} min average walk` : ''}`}
                <span className={styles.reasons}>{[
                ...(s.walk ? [`Longest walk ${s.walk.longest} min${s.walk.from ? `, from ${s.walk.from}` : ''}`] : []),
                s.nearbyCrowd ? `Busiest nearby: ${s.nearbyCrowd.place} (modeled)` : 'No modeled crowding nearby',
                s.parking.lots ? `${s.parking.spaces.toLocaleString()} parking spaces within 800 m${s.parking.nearest ? `, nearest ${s.parking.nearest.name}` : ''} (capacity, not availability)` : 'No mapped parking within 800 m',
                ...(s.venueEventsSameDay.length ? [`Same day nearby, not overlapping: ${s.venueEventsSameDay.join(', ')}`] : []),
              ].join(' · ')}</span>
              </>}
              trailing={s.nearbyCrowd ? <CrowdMeter share={s.nearbyCrowd.percent / 100} /> : undefined}
            />
          ))}
        </SectionList>
      )}
      {result.venueConflicts.length > 0 && (
        <p className={styles.note}>
          Ruled out near {result.venueConflicts.map((e) => `${e.name} (${e.venue}, ${day(e.date)} ${e.start})`).join('; ')}.
        </p>
      )}
      <details className={styles.method}>
        <summary>How these are chosen</summary>
        <p>{result.method}</p>
        <p>
          Checked {result.counts.checked.toLocaleString()} room and start-time pairs in {result.counts.roomsWithSeats.toLocaleString()} rooms with enough seats:
          {' '}{result.counts.withClass.toLocaleString()} had a published class, {result.counts.withListedEvent.toLocaleString()} a listed event and {result.counts.nearVenueEvent.toLocaleString()} a big venue event within 1 km.
        </p>
      </details>
    </div>
  );
}
