import { formatClock } from './sim/playback';
import { FIRE_RESPONSE_LIMITATIONS, type ApparatusPlan, type FireResponse } from './sim/fireResponse';

const minutes = (seconds: number) => {
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return m ? `${m} min ${s.toString().padStart(2, '0')} s` : `${s} s`;
};

function status(unit: ApparatusPlan, time: number) {
  if (time < unit.depart) return `Turning out · leaves ${formatClock(unit.depart)}`;
  if (time < unit.arrive) return `Responding · on scene in ${minutes(unit.arrive - time)}`;
  if (time < unit.release) return `On scene since ${formatClock(unit.arrive)}${unit.hydrant ? ' · at a hydrant' : ''}`;
  if (time < unit.home) return 'Returning to quarters';
  return `In quarters since ${formatClock(unit.home)}`;
}

/** Boston Fire's first-alarm response to the scenario's fire alarm (Incidents tab). */
export function FireResponsePanel({ response, time, siren, onSiren, pending }: {
  response: FireResponse | null;
  time: number;
  siren: boolean;
  onSiren: (on: boolean) => void;
  pending?: boolean;
}) {
  return (
    <div className="fire-response" aria-label="Boston Fire Department response">
      <h3>Boston Fire response</h3>
      {!response ? <p className="model-note">{pending ? 'Dispatching the nearest companies…' : 'The fire response network could not be loaded, so no apparatus are shown.'}</p> : <>
        <p className="model-note">First-alarm assignment for a building fire alarm: the {response.units.length} nearest companies by modeled drive time, with lights and siren.</p>
        <ul className="fire-units">
          {response.units.map((unit) => (
            <li key={unit.id}>
              <strong>{unit.name}</strong> <span className="fire-unit-from">from {unit.station.address}</span>
              <div>{status(unit, time)}</div>
              <div className="model-note">{(unit.out.metres / 1000).toFixed(1)} km · on scene {minutes(unit.eta)} after the alarm</div>
            </li>
          ))}
        </ul>
      </>}
      <label className="fire-siren">
        <input type="checkbox" checked={siren} onChange={(event) => onSiren(event.target.checked)} />
        Siren sound (off by default; louder when responding apparatus are near the middle of the map)
      </label>
      <details className="model-note">
        <summary>Response assumptions</summary>
        {FIRE_RESPONSE_LIMITATIONS.map((note) => <p key={note}>{note}</p>)}
        {response?.source && <p>Sources: {response.source}.</p>}
      </details>
    </div>
  );
}
