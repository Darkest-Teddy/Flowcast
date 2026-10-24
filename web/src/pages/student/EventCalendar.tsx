import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import styles from './EventCalendar.module.css';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const utc = (date: string) => new Date(`${date}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => { const d = utc(date); d.setUTCDate(d.getUTCDate() + days); return iso(d); };
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

export interface CalendarDay {
  events: number;
  /** Events that change crowding on the map. */
  simulated: number;
}

/**
 * Month grid of dates (Monday first). Dates are "YYYY-MM-DD" Boston calendar days. Arrow keys move
 * between days, Page Up/Down between months; each day says how many events it has, not just a dot.
 */
export function EventCalendar({ value, onChange, days, min, max }: {
  value: string;
  onChange: (date: string) => void;
  days: Record<string, CalendarDay>;
  min: string;
  max: string;
}) {
  const [month, setMonth] = useState(value.slice(0, 7));
  const [focus, setFocus] = useState(value);
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => { setMonth(value.slice(0, 7)); setFocus(value); }, [value]);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus();
  }, [focus]);

  const first = `${month}-01`;
  const start = addDays(first, -((utc(first).getUTCDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7)).filter((week) => week.some((d) => d.startsWith(month)));
  const shiftMonth = (delta: number) => {
    const d = utc(first);
    d.setUTCMonth(d.getUTCMonth() + delta);
    return iso(d).slice(0, 7);
  };
  const canPrev = shiftMonth(-1) >= min.slice(0, 7);
  const canNext = shiftMonth(1) <= max.slice(0, 7);
  const clamp = (date: string) => (date < min ? min : date > max ? max : date);

  const onKey = (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let next: string | null = step ? addDays(focus, step) : null;
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const d = utc(focus);
      d.setUTCMonth(d.getUTCMonth() + (event.key === 'PageUp' ? -1 : 1));
      next = iso(d);
    }
    if (event.key === 'Home') next = addDays(focus, -((utc(focus).getUTCDay() + 6) % 7));
    if (event.key === 'End') next = addDays(focus, 6 - ((utc(focus).getUTCDay() + 6) % 7));
    if (!next) return;
    event.preventDefault();
    next = clamp(next);
    moved.current = true;
    setFocus(next);
    setMonth(next.slice(0, 7));
  };

  return (
    <div className={styles.calendar}>
      <div className={styles.head}>
        <button type="button" className={styles.nav} onClick={() => setMonth(shiftMonth(-1))} disabled={!canPrev} aria-label="Previous month">
          <ChevronLeft aria-hidden />
        </button>
        <h2 className={styles.month} aria-live="polite">{monthLabel.format(utc(first))}</h2>
        <button type="button" className={styles.nav} onClick={() => setMonth(shiftMonth(1))} disabled={!canNext} aria-label="Next month">
          <ChevronRight aria-hidden />
        </button>
      </div>
      <div role="grid" aria-label="Pick a date" ref={grid} onKeyDown={onKey}>
        <div role="row" className={styles.row}>
          {WEEKDAYS.map((d) => <span role="columnheader" key={d} className={styles.weekday} aria-label={d}>{d.slice(0, 2)}</span>)}
        </div>
        {weeks.map((week) => (
          <div role="row" className={styles.row} key={week[0]}>
            {week.map((date) => {
              const inMonth = date.startsWith(month);
              const info = days[date];
              const disabled = date < min || date > max;
              const label = `${dayLabel.format(utc(date))}${info ? `, ${info.events} ${info.events === 1 ? 'event' : 'events'}${info.simulated ? `, ${info.simulated} on the map` : ''}` : ', no events'}`;
              return (
                <span role="gridcell" key={date} aria-selected={date === value}>
                  <button
                    type="button"
                    data-date={date}
                    className={[styles.day, inMonth ? '' : styles.outside, date === value ? styles.selected : '', info?.simulated ? styles.hasMapped : ''].join(' ')}
                    tabIndex={date === focus ? 0 : -1}
                    disabled={disabled}
                    aria-label={label}
                    aria-pressed={date === value}
                    onClick={() => { setFocus(date); onChange(date); }}
                  >
                    <span aria-hidden>{Number(date.slice(8))}</span>
                    {info && <span className={styles.count} aria-hidden>{info.events}</span>}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className={styles.key}>
        <span className={styles.keyMapped} aria-hidden>3</span> events that change crowds
        <span className={styles.keyOther} aria-hidden>1</span> events not on the map
      </p>
    </div>
  );
}
