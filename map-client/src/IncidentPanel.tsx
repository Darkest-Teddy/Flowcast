import { useState } from 'react';
import { formatClock, type CampusLocation } from './sim/playback';
import { ACTIVITY_DECISION_LIMITATIONS, INCIDENT_LIMITATIONS, type Incident, type IncidentKind, type IncidentParticipant } from './sim/incidents';
import { incidentProgress } from './sim/incidentProgress';
import { IncidentDecisions } from './IncidentDecisions';
import { FireResponsePanel } from './FireResponsePanel';
import type { FireResponse } from './sim/fireResponse';

export interface IncidentRun {
  incident: Incident;
  location: CampusLocation;
  assemblyLocation: CampusLocation | null;
  affectedAgents: number;
  assemblyClearanceMetres: number | null;
  endsAt: number;
  participants: IncidentParticipant[];
  /** Fire alarms only: the Boston Fire Department apparatus sent (null while loading or if unavailable). */
  response?: FireResponse | null;
}

const KIND_TITLE: Record<IncidentKind, string> = { 'fire-drill': 'Fire drill', 'fire-alarm': 'Fire alarm', 'building-closure': 'Building closure' };

export function IncidentPanel({ locations, time, run, onStart, onReset, onLocate, siren = false, onSiren, responsePending }: {
  locations: CampusLocation[];
  time: number;
  run: IncidentRun | null;
  onStart: (kind: IncidentKind, locationId: string, duration: number) => void;
  onReset: () => void;
  onLocate: (location: CampusLocation) => void;
  siren?: boolean;
  onSiren?: (on: boolean) => void;
  responsePending?: boolean;
}) {
  const [kind, setKind] = useState<IncidentKind>('fire-drill');
  const [locationId, setLocationId] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState('');
  const available = locations.filter((location) => location.kind !== 'off-campus' && location.kind !== 'outdoor').sort((a, b) => a.name.localeCompare(b.name));
  const target = available.find((location) => location.id === locationId) ?? available.find((location) => location.short === 'CDS') ?? available[0];
  const progress = run && incidentProgress(run, time);
  // Fire alarms evacuate exactly like drills (occupants, assembly, muster).
  const isDrill = (run?.incident.kind ?? kind) !== 'building-closure';
  const isAlarm = (run?.incident.kind ?? kind) === 'fire-alarm';

  return (
    <section id="panel-incidents" role="tabpanel" aria-labelledby="tab-incidents" className="incident-panel">
      <h2>Campus incidents</h2>
      <p className="model-note">Local what-if scenarios. These affect modeled students on this map, not real campus alerts.</p>
      {run && progress ? (
        <div className="incident-result">
          <h3>{KIND_TITLE[run.incident.kind]} · {progress.phase}</h3>
          <p>{run.location.name}</p>
          <dl>
            <dt>Access closed</dt><dd>{formatClock(run.incident.start)}–{formatClock(run.endsAt)}</dd>
            <dt>{isDrill ? 'Occupants at alarm' : 'Occupants at closure'}</dt><dd>{progress.occupantCount.toLocaleString()}</dd>
            {isDrill && run.assemblyLocation && <><dt>Outdoor assembly</dt><dd>{run.assemblyLocation.name}</dd>
            {run.assemblyClearanceMetres !== null && <><dt>Nearest building edge</dt><dd>{Math.floor(run.assemblyClearanceMetres)} m from assembly</dd></>}</>}
          </dl>
          {progress.phase !== 'Scheduled' && <dl className="incident-counts" aria-label="Incident progress">
            <div><dt>Still inside</dt><dd>{progress.inside.toLocaleString()}</dd></div>
            {isDrill && <><div><dt>Walking to assembly</dt><dd>{progress.evacuating.toLocaleString()}</dd></div>
            <div><dt>At assembly</dt><dd>{progress.assembled.toLocaleString()}</dd></div></>}
            <div><dt>Arrivals diverted so far</dt><dd>{progress.diverted.toLocaleString()}</dd></div>
            <div><dt>Chose another venue</dt><dd>{progress.relocated.toLocaleString()}</dd></div>
            {!isDrill && <><div><dt>Visits canceled so far</dt><dd>{progress.cancelled.toLocaleString()}</dd></div>
            <div><dt>Visits interrupted so far</dt><dd>{progress.interrupted.toLocaleString()}</dd></div></>}
            <div><dt>Rejoining schedule</dt><dd>{progress.recovering.toLocaleString()}</dd></div>
            <div><dt>Schedule resumed</dt><dd>{progress.resumed.toLocaleString()}</dd></div>
          </dl>}
          {isAlarm && <FireResponsePanel response={run.response ?? null} time={time} siren={siren} onSiren={(on) => onSiren?.(on)} pending={responsePending} />}
          <IncidentDecisions participants={run.participants} time={time} locations={locations} onLocate={onLocate} />
          {time >= run.incident.start && time < run.endsAt && <p role="status">Access reopens in {Math.ceil((run.endsAt - time) / 60)} simulated minutes.</p>}
          {time >= progress.clearedAt && progress.occupantCount > 0 && <p className="model-note">Modeled building clearance: {Math.ceil((progress.clearedAt - run.incident.start) / 60)} minutes, using an assumed exit flow of 2 people per second.</p>}
          {run.endsAt > run.incident.start + run.incident.duration && <p className="model-note">Closure extended to allow evacuation and assembly before reopening.</p>}
          {time >= run.endsAt && <p className="model-note">Access has reopened. Students resume from their actual positions; missed activities keep their original end times.</p>}
          {isDrill && <p className="model-note">The assembly marker is on a saved pedestrian route outside mapped buildings. It is a modeled holding point, not an official assembly area or a capacity estimate.</p>}
          <div className="incident-actions">
            <button type="button" onClick={() => onLocate(run.location)}>Show building</button>
            {isDrill && run.assemblyLocation && <button type="button" onClick={() => onLocate(run.assemblyLocation!)}>Show assembly</button>}
            <button type="button" onClick={() => { onReset(); setError(''); }}>Reset scenario</button>
          </div>
          <p className="model-note">Reset restores the original day at the current time. One incident per scenario; changing days also clears it.</p>
        </div>
      ) : (
        <form onSubmit={(event) => {
          event.preventDefault();
          setError('');
          if (!target) return;
          try { onStart(kind, target.id, minutes * 60); }
          catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start this incident.'); }
        }}>
          <label>Incident
            <select aria-label="Incident" value={kind} onChange={(event) => {
              const value = event.target.value as IncidentKind;
              setKind(value);
              setMinutes(value === 'building-closure' ? 120 : 30);
            }}>
              <option value="fire-drill">Fire drill (scheduled)</option>
              <option value="fire-alarm">Fire alarm (Boston Fire responds)</option>
              <option value="building-closure">Building closure</option>
            </select>
          </label>
          <label>Building
            <select aria-label="Building" value={target?.id ?? ''} onChange={(event) => setLocationId(event.target.value)}>
              {available.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </label>
          <label>Duration
            <select aria-label="Duration" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
              {[5, 15, 30, 60, 120].map((value) => <option key={value} value={value}>{value} simulated minutes</option>)}
            </select>
          </label>
          {kind === 'fire-drill' && <p className="model-note">A scheduled drill is run by building staff and announced to the fire department in advance, so no apparatus are sent. Choose Fire alarm for an unplanned alarm.</p>}
          {kind === 'fire-alarm' && <p className="model-note">An unplanned alarm or reported fire: occupants evacuate as in a drill, and Boston Fire sends the nearest engines, ladder trucks and a district chief by drive time, lights and siren on.</p>}
          <p className="model-note">Starts at {formatClock(time)}. {isDrill ? 'Occupants evacuate and assemble before deciding what to do next.' : 'Students decide whether to wait, move elsewhere, or abandon the visit.'} Classes stay tied to their scheduled location. Meals, studying, and exercise can move when a suitable venue and enough time are available.</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={!target}>{kind === 'fire-alarm' ? 'Sound fire alarm' : `Start ${kind === 'fire-drill' ? 'fire drill' : 'closure'}`}</button>
        </form>
      )}
      <p className="model-note">Restrictions apply to visits to this building. Through-traffic on saved paths is unchanged and may cross its mapped footprint.</p>
      <details className="model-note">
        <summary>Model assumptions</summary>
        {[...INCIDENT_LIMITATIONS, ...ACTIVITY_DECISION_LIMITATIONS].map((note) => <p key={note}>{note}</p>)}
      </details>
    </section>
  );
}
