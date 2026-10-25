// The Parking section of the Transit tab (only while the toggle is on): each lot's spaces, how full
// it is and which way it's heading, and the day's events that bring cars, with their times.
// Rows use the same four-step scale as the Crowds tab (colour plus the words and numbers).
import { crowdLevelStyle } from './layers/crowd';
import { lotSummary } from './ParkingTags';
import { formatClock } from './sim/playback';
import type { LotState, ParkingData, ParkingState } from './sim/parking';

const TREND = { filling: '↑ filling', emptying: '↓ emptying', steady: '· steady' } as const;
const DAY_KIND = { weekday: 'Weekday', weekend: 'Weekend', holiday: 'BU holiday', break: 'BU break' } as const;

interface Props {
  data: ParkingData;
  state: ParkingState | null;
  onSelect: (lot: LotState) => void;
}

function LotRow({ s, onSelect }: { s: LotState; onSelect: (lot: LotState) => void }) {
  const { percent, word } = lotSummary(s);
  return (
    <li>
      <button className="row" onClick={() => onSelect(s)} style={crowdLevelStyle(s.full ? 1 : s.share)}
        aria-label={`${s.lot.name}: ${percent}% full, ${word}, ${s.free} of ${s.lot.capacity} spaces free, ${s.trend}. Estimate.`}>
        <span className="name">{s.lot.short}</span>
        <span className="value">
          <b>{percent}%</b> · {word} <span className="trend">{TREND[s.trend]}</span>
        </span>
        <span className="bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, percent)}%` }} />
        </span>
        <span className="muted" style={{ gridColumn: '1 / -1' }}>
          {s.cars.toLocaleString()} of {s.lot.capacity.toLocaleString()} spaces{s.lot.capacityBasis === 'estimate' ? ' (capacity estimated)' : ''}
          {s.event && s.eventCars >= 5 ? ` · ${s.eventCars.toLocaleString()} for ${s.event.name}` : ''}
        </span>
      </button>
    </li>
  );
}

export function ParkingPanel({ data, state, onSelect }: Props) {
  if (!state) return <p className="muted">Estimating parking…</p>;
  const bu = state.lots.filter((s) => s.lot.bu);
  const pub = state.lots.filter((s) => !s.lot.bu);
  const { totals } = state;
  return (
    <div className="parking-panel">
      <h2>
        Parking <span className="muted">· estimated · {DAY_KIND[state.day.kind]} {state.day.date} · {formatClock(state.time)}</span>
      </h2>
      <p className="bike-summary">
        <strong>{Math.round((totals.cars / Math.max(1, totals.capacity)) * 100)}%</strong> of {totals.capacity.toLocaleString()} spaces taken
        {totals.full ? ` · ${totals.full} lot${totals.full === 1 ? '' : 's'} FULL` : ''}
      </p>
      <h3>Today’s events affecting parking</h3>
      {state.events.filter((e) => e.event.cars >= 20).length === 0 ? (
        <p className="muted">No large events today: commuter and visitor parking only.</p>
      ) : (
        <ul className="parking-events">
          {state.events.filter((e) => e.event.cars >= 20).map((e) => {
            const now = e.ramp > 0;
            return (
              <li key={e.event.id} className={now ? 'is-now' : ''}>
                <span>
                  <b>{e.event.name}</b>
                  {e.event.sample && <> <span className="sample" title={e.event.source}>Sample</span></>}
                </span>
                <span className="when">{formatClock(e.event.start)}–{formatClock(e.event.end)}</span>
                <span className="meta">
                  {e.venue?.name ?? e.event.venue} · ~{e.event.cars.toLocaleString()} cars · lots fill from {formatClock(e.arriveFrom)}, clear by {formatClock(e.clearBy)}
                  {now ? ` · now ${e.parked.toLocaleString()} parked${e.unparked ? `, ${e.unparked.toLocaleString()} without a lot nearby` : ''}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <h3>BU lots and garages</h3>
      <ol className="rows">{bu.map((s) => <LotRow key={s.lot.id} s={s} onSelect={onSelect} />)}</ol>
      <h3>Public lots near Kenmore, Fenway and the Medical Campus</h3>
      <ol className="rows">{pub.map((s) => <LotRow key={s.lot.id} s={s} onSelect={onSelect} />)}</ol>
      <p className="muted source">
        Estimates, not counts: typical fill curves by kind of lot and day (BU holidays and breaks from the academic calendar), plus each
        event’s cars arriving over the 2 h before it starts and leaving over the hour after it ends, nearest lot first and spilling to the
        next as lots fill. Students in the simulation don’t drive; this layer doesn’t change them. {data.notes[0] ?? ''}
      </p>
    </div>
  );
}
