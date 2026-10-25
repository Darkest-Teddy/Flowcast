import { useState, type FormEvent } from 'react';
import { api } from '../../data/api';
import { formatDayLabel } from '../../lib/format';
import { DEFAULT_PLAN, planProblem, slotRoom, type EventPlan, type EventSlotsResult } from '../../lib/eventSlots';
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
 * in the room, no big venue event nearby, low modeled crowding nearby and parking close by. It only
 * reads schedules and model figures; nothing is booked.
 */
export function PlanEvent() {
  const [plan, setPlan] = useState<EventPlan>(DEFAULT_PLAN);
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
      <SectionHeading><span id="plan-event">Plan an event</span></SectionHeading>
      <p className={styles.intro}>
        Find a room and an evening this week that fits your group, away from classes, big games and concerts, and the busiest modeled crowds.
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
        <SectionList title={`Rooms for ${result.headcount}, ${result.window.from} to ${result.window.to}${week ? `, ${week}` : ''}`} count={result.slots.length}>
          {result.slots.map((s) => (
            <ListRow
              key={`${s.date}|${s.building}|${s.room}|${s.start}`}
              title={`${day(s.date)}, ${s.start}–${s.end}`}
              subtitle={`${slotRoom(s)} · ${s.seats} published seats`}
              detail={[
                s.nearbyCrowd ? `Busiest nearby: ${s.nearbyCrowd.place} (modeled)` : 'No modeled crowding nearby',
                s.parking.lots ? `${s.parking.spaces.toLocaleString()} parking spaces within 800 m${s.parking.nearest ? `, nearest ${s.parking.nearest.name}` : ''} (capacity, not availability)` : 'No mapped parking within 800 m',
                ...(s.venueEventsSameDay.length ? [`Same day nearby, not overlapping: ${s.venueEventsSameDay.join(', ')}`] : []),
              ].join(' · ')}
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
