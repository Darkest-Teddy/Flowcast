/*
 * Log: the what-if form.
 *
 * Every scenario here covers an area rather than a building. A fire alarm empties
 * the building's neighbours, an earthquake does not stop at a property line, and
 * a sell-out crowd at Fenway arrives across a district. The old form asked for
 * one building from a dropdown of ninety, which both took longer and described
 * something that does not happen.
 *
 * So the form is a centre, a radius you drag on the map, and the list of
 * buildings that radius actually catches. The engine has always worked this way
 * for earthquakes and meteors (sim/disasters.ts hazardZone); the rest of the
 * scenarios now say so too.
 */

import type { IncidentKind } from '../sim/incidents';

/** The Red Sox game is not an incident: it is a crowd, and the engine models it
 *  through the venue-event calendar rather than through sim/incidents.ts. */
export type ScenarioKind = IncidentKind | 'red-sox';

export interface Scenario {
  id: ScenarioKind;
  label: string;
  hue: string;
  /** One line about what the simulation will do. */
  line: string;
  icon: string;
}

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/*
 * Seven scenarios in a 4 x 2 grid. The hues are the chrome's (styles.css) and
 * are chosen so no scenario wears a crowd colour: a scenario is a thing you are
 * asking for, not a measurement of how full somewhere is.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: 'fire-drill',
    label: 'Fire drill',
    hue: 'green',
    line: 'Occupants exit, gather outside, then return.',
    icon: icon('<path d="M13 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5"/><path d="M13 3 5 5v14l8 2z"/><circle cx="10.5" cy="12" r="1" fill="currentColor" stroke="none"/>'),
  },
  {
    id: 'fire-alarm',
    label: 'Fire alarm',
    hue: 'pink',
    line: 'Everyone evacuates; Boston Fire responds.',
    icon: icon('<path d="M12 3a6 6 0 0 1 6 6v4l1.5 3h-15L6 13V9a6 6 0 0 1 6-6z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/><path d="M3.5 6.5 5 5M20.5 6.5 19 5"/>'),
  },
  {
    id: 'building-closure',
    label: 'Closure',
    hue: 'neutral',
    line: 'Buildings closed; visits move elsewhere.',
    icon: icon('<circle cx="12" cy="12" r="8.5"/><path d="m6.5 6.5 11 11"/>'),
  },
  {
    id: 'fire',
    label: 'Fire',
    hue: 'orange',
    line: 'Evacuate; buildings stay closed today.',
    icon: icon('<path d="M12 21a6 6 0 0 0 6-6c0-4-3-5-3-9-2.5 1.5-3.5 3.5-3.5 5.5C11.5 9 10 8 9 6.5 7.5 8.5 6 11 6 15a6 6 0 0 0 6 6z"/>'),
  },
  {
    id: 'earthquake',
    label: 'Earthquake',
    hue: 'violet',
    line: '60 s of shaking, then evacuation in range.',
    icon: icon('<path d="M2 12h3l2.5-6 3 12 3-9 2 5 2.5-2H22"/>'),
  },
  {
    id: 'meteor',
    label: 'Meteor',
    hue: 'teal',
    line: 'Buildings inside the radius close.',
    icon: icon('<circle cx="15.5" cy="8.5" r="3.5"/><path d="M11 13 4 20M13.5 15.5 9 20M8.5 10.5 3 16"/>'),
  },
  {
    id: 'red-sox',
    label: 'Red Sox game',
    hue: 'pink',
    line: 'A sell-out crowd arrives and leaves through Kenmore. Buildings in range get busier.',
    icon: icon('<circle cx="12" cy="12" r="8.5"/><path d="M7 5.5c2 2.2 2.8 4.4 2.8 6.5S9 16.3 7 18.5"/><path d="M17 5.5c-2 2.2-2.8 4.4-2.8 6.5s.8 4.3 2.8 6.5"/>'),
  },
];

/** The duration chips, shown for everything but the Red Sox game. */
export const DURATIONS = [30, 60, 120];

/** Radius limits per scenario, in metres. */
export function radiusLimits(kind: ScenarioKind): { min: number; max: number; step: number } {
  // A ball game fills a district, not a corner; a drill is one block at most.
  return kind === 'red-sox' ? { min: 100, max: 1500, step: 10 } : { min: 25, max: 600, step: 10 };
}

export const defaultRadius = (kind: ScenarioKind) => (kind === 'red-sox' ? 500 : 250);

/** Only these three send people outside to assemble. */
export const gathers = (kind: ScenarioKind) => kind === 'fire-drill' || kind === 'fire-alarm' || kind === 'fire';

export function WhatIfForm({
  kind,
  onKind,
  centreName,
  radius,
  onRadius,
  affected,
  minutes,
  onMinutes,
  outside,
  onOutside,
  startLabel,
  onStart,
  canStart,
  onAssumptions,
}: {
  kind: ScenarioKind;
  onKind: (k: ScenarioKind) => void;
  /** The centre's name, or null until one is picked. */
  centreName: string | null;
  radius: number;
  onRadius: (metres: number) => void;
  /** The buildings the circle currently catches, by short name and level colour. */
  affected: { id: string; name: string; icon: string; style: Record<string, string> }[];
  minutes: number;
  onMinutes: (m: number) => void;
  outside: boolean;
  onOutside: (v: boolean) => void;
  startLabel: string;
  onStart: () => void;
  canStart: boolean;
  onAssumptions: () => void;
}) {
  const scenario = SCENARIOS.find((s) => s.id === kind)!;
  const limits = radiusLimits(kind);
  const fixedCentre = kind === 'red-sox';

  return (
    <>
      <p className="wi-note">
        <span dangerouslySetInnerHTML={{ __html: WARN }} />
        What-if on this map only. Not a real campus alert.
      </p>

      <p className="pn-label">Scenario</p>
      <div className="wi-grid" role="group" aria-label="Scenario">
        {SCENARIOS.map((s) => (
          <button key={s.id} type="button" data-hue={s.hue} aria-pressed={kind === s.id} onClick={() => onKind(s.id)}>
            <span className="wi-icon" dangerouslySetInnerHTML={{ __html: s.icon }} />
            {s.label}
          </button>
        ))}
      </div>
      <p className="wi-line">{scenario.line}</p>

      <p className="pn-label">Centre</p>
      <div className="wi-field">
        <span dangerouslySetInnerHTML={{ __html: PIN }} />
        <span className="wi-field-name">{centreName ?? 'No centre picked'}</span>
        <span className="wi-field-hint">{fixedCentre ? 'Fixed for this scenario' : 'Search above or tap the map'}</span>
      </div>

      <p className="pn-label">Radius</p>
      <div className="wi-field">
        <span dangerouslySetInnerHTML={{ __html: RING }} />
        <span className="wi-field-name">{radius >= 1000 ? `${(radius / 1000).toFixed(1)} km` : `${Math.round(radius)} m`}</span>
        <span className="wi-field-hint">Drag the handle on the map</span>
      </div>
      {/* The map handle is the control; this is the same value as a keyboard
          path, because a drag with no alternative is not reachable. */}
      <input
        className="wi-slider"
        type="range"
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={Math.round(radius)}
        onChange={(e) => onRadius(Number(e.currentTarget.value))}
        aria-label="Radius in metres"
      />

      <p className="pn-label">
        {affected.length > 0 ? `Affects ${affected.length} ${affected.length === 1 ? 'building' : 'buildings'}` : 'No campus buildings in range'}
      </p>
      {affected.length > 0 && (
        <div className="wi-chips">
          {affected.map((b) => (
            <span key={b.id} className="wi-chip" style={b.style}>
              <span dangerouslySetInnerHTML={{ __html: b.icon }} />
              {b.name}
            </span>
          ))}
        </div>
      )}

      {kind !== 'red-sox' && (
        <>
          <p className="pn-label">Duration</p>
          <div className="wi-chips">
            {DURATIONS.map((m) => (
              <button key={m} type="button" className="wi-duration" aria-pressed={minutes === m} onClick={() => onMinutes(m)}>
                {m} min
              </button>
            ))}
          </div>
        </>
      )}

      {gathers(kind) && (
        <label className="wi-switch">
          <input type="checkbox" checked={outside} onChange={(e) => onOutside(e.currentTarget.checked)} />
          <span className="wi-track" aria-hidden="true" />
          Gather outside first
        </label>
      )}

      <button type="button" className="pn-primary wi-start" onClick={onStart} disabled={!canStart}>
        {startLabel}
      </button>

      <button type="button" className="wi-assumptions" onClick={onAssumptions}>
        Model assumptions
      </button>
    </>
  );
}

const WARN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17.2v.1"/></svg>';

const PIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';

const RING =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>';
