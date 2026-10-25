import { fireResponseAt, FIRE_RESPONSE_LIMITATIONS, type FireResponse as DisasterFireResponse, type FireResponseUnavailable } from './sim/disasterFireResponse';
import { useState } from 'react';
import { formatClock, type CampusLocation } from './sim/playback';
import { ACTIVITY_DECISION_LIMITATIONS, INCIDENT_LIMITATIONS, type Incident, type IncidentKind, type IncidentParticipant, type IncidentResult, DISASTER_LIMITATIONS, DISASTER_ASSUMPTIONS, isDisasterKind } from './sim/incidents';
import { incidentProgress } from './sim/incidentProgress';
import { CASUALTY_LIMITATIONS, type CasualtyEvent } from './sim/casualties';
import { IncidentDecisions } from './IncidentDecisions';
import { FireResponsePanel } from './FireResponsePanel';
import type { FireResponse } from './sim/fireResponse';
import { FIRE_CROWD_LIMITATIONS, type FireCrowd, type FireDispersal } from './sim/fireCrowd';
import { GAME_MINUTES, OPPONENTS, type SimulatedGame } from './sim/simulatedGame';
import type { VenueEventEstimate } from './sim/eventAttendance';

const dispersalNames: Record<FireDispersal, string> = {
  'next-activity': 'Went on to their next class or activity',
  home: 'Went home',
  transit: 'Left campus by transit',
  relocated: 'Moved a meal, study or workout elsewhere',
  shelter: 'Sheltering elsewhere (home is closed)',
};

const names: Record<IncidentKind, string> = {
  'fire-drill': 'Fire drill', 'fire-alarm': 'Fire alarm', 'building-closure': 'Building closure',
  fire: 'Fire', earthquake: 'Earthquake', meteor: 'Meteor impact',
};
const descriptions: Record<IncidentKind, string> = {
  'fire-drill': 'Occupants evacuate and assemble before deciding what to do next.',
  'fire-alarm': 'Occupants evacuate and assemble while Boston Fire responds to an unplanned alarm.',
  'building-closure': 'Students decide whether to wait, move elsewhere, or abandon the visit.',
  fire: 'A fire prompts a faster evacuation. The damaged building stays closed for the rest of the day.',
  earthquake: 'Students in affected buildings shelter through the modeled shaking, then leave damaged buildings, which remain closed for the rest of the day.',
  meteor: 'A meteor arrives after 45 simulated seconds, then destroys nearby structures and sends survivors fleeing. The radius sets the affected area. Damaged buildings stay closed for the day.',
};

export interface IncidentRun {
  fireResponse?: DisasterFireResponse | null;
  /** Fire alarms only: Boston Fire apparatus (null while loading or unavailable). */
  response?: FireResponse | null;
  fireResponseUnavailable?: FireResponseUnavailable | 'no-road-data' | null;
  incident: Incident;
  hazard?: IncidentResult['hazard'];
  location: CampusLocation;
  assemblyLocation: CampusLocation | null;
  affectedAgents: number;
  assemblyClearanceMetres: number | null;
  endsAt: number;
  participants: IncidentParticipant[];
  /** Disaster casualty events (IncidentResult.casualties); the panel only counts those at or before `time`. */
  casualties?: CasualtyEvent[];
  /** Fire with an outdoor crowd: standing areas and each evacuee's spot. */
  crowd?: FireCrowd;
}

/** A simulated Red Sox game at Fenway: start one with a first pitch and opponent, follow its crowd, end it. */
function SimulatedGamePanel({ time, game, estimate, onGame }: {
  time: number;
  game: SimulatedGame | null;
  estimate: VenueEventEstimate | null;
  onGame: (game: SimulatedGame | null) => void;
}) {
  const [lead, setLead] = useState(60);
  const [opponent, setOpponent] = useState(OPPONENTS[0]);
  // First pitch on a whole five minutes, `lead` minutes from the shown time, within the day.
  const firstPitch = Math.min(23 * 3600, Math.ceil((time + lead * 60) / 300) * 300);
  if (game) {
    const phase = !estimate ? 'Not shown (turn on campus events)'
      : time < estimate.arrivalFrom ? 'Scheduled'
      : time < estimate.startSec ? 'Fans arriving'
      : time < estimate.departureFrom ? 'In progress'
      : time < estimate.departureTo ? 'Crowd leaving'
      : 'Over';
    return (
      <section className="incident-result" aria-label="Simulated Red Sox game">
        <h3>Red Sox vs. {game.opponent} · {phase}</h3>
        <p>Fenway Park (simulated, sold out)</p>
        <dl>
          <dt>First pitch</dt><dd>{formatClock(game.firstPitch)}</dd>
          <dt>Final out (about)</dt><dd>{formatClock(game.firstPitch + GAME_MINUTES * 60)}</dd>
          {estimate && <><dt>Attendance</dt><dd>{estimate.attendees.toLocaleString()}</dd>
          <dt>Fans walking on the map</dt><dd>{estimate.visitors.toLocaleString()} (plus {estimate.students.toLocaleString()} students)</dd>
          <dt>Fans arrive from</dt><dd>{formatClock(estimate.arrivalFrom)}</dd></>}
        </dl>
        <div className="incident-actions">
          <button type="button" onClick={() => onGame(null)}>End game</button>
        </div>
        <p className="model-note">Fans come from the T, the garages and rideshare drop-offs, as for a real game; any real game at Fenway that day is replaced.</p>
      </section>
    );
  }
  return (
    <form aria-label="Simulated Red Sox game" onSubmit={(event) => { event.preventDefault(); onGame({ firstPitch, opponent }); }}>
      <h3>Red Sox game</h3>
      <label>Opponent
        <select aria-label="Opponent" value={opponent} onChange={(event) => setOpponent(event.target.value)}>
          {OPPONENTS.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label>First pitch
        <select aria-label="First pitch" value={lead} onChange={(event) => setLead(Number(event.target.value))}>
          {[15, 30, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>In {minutes} simulated minutes</option>)}
        </select>
      </label>
      <p className="model-note">A sold-out game at Fenway Park with first pitch at {formatClock(firstPitch)}. Fans walk in from up to two hours before, fill the garages, and pour out around Kenmore after the final out.</p>
      <button type="submit">Start Red Sox game</button>
    </form>
  );
}

export function IncidentPanel({ locations, time, run, onStart, onReset, onLocate, siren = false, onSiren, responsePending, game = null, gameEstimate = null, onGame, landmarks = [] }: {
  locations: CampusLocation[];
  time: number;
  run: IncidentRun | null;
  onStart: (kind: IncidentKind, locationId: string, duration: number, radiusMetres?: number, outdoorCrowd?: boolean) => void;
  onReset: () => void;
  onLocate: (location: CampusLocation) => void;
  siren?: boolean;
  onSiren?: (on: boolean) => void;
  responsePending?: boolean;
  game?: SimulatedGame | null;
  gameEstimate?: VenueEventEstimate | null;
  onGame?: (game: SimulatedGame | null) => void;
  /** Off-campus targets for meteors and earthquakes (Fenway Park). */
  landmarks?: readonly CampusLocation[];
}) {
  const [kind, setKind] = useState<IncidentKind>('fire-drill');
  const [locationId, setLocationId] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState('');
  const [radius, setRadius] = useState(250);
  const [outdoorCrowd, setOutdoorCrowd] = useState(true);
  const areaKind = kind === 'earthquake' || kind === 'meteor';
  const buildings = locations.filter((location) => location.kind !== 'off-campus' && location.kind !== 'outdoor').sort((a, b) => a.name.localeCompare(b.name));
  // Meteors and earthquakes can also be aimed at landmarks off the simulated campus.
  const available = areaKind ? [...landmarks, ...buildings] : buildings;
  const target = available.find((location) => location.id === locationId) ?? available.find((location) => location.short === 'CDS') ?? available[0];
  const progress = run && incidentProgress(run, time);
  const trucks = run?.fireResponse ? fireResponseAt(run.fireResponse, time) : [];
  const responding = trucks.filter(truck => truck.phase === 'responding').length;
  const fighting = trucks.filter(truck => truck.phase === 'fighting').length;
  const staging = trucks.filter(truck => truck.phase === 'staging').length;
  const leaving = trucks.filter(truck => truck.phase === 'leaving').length;
  const stoppedAt = new Map((run?.casualties ?? []).map(event => [event.agentId, event.at]));
  const decisions = run?.participants.filter(person => !person.decision || person.decision.at < (stoppedAt.get(person.agentId) ?? Infinity)) ?? [];
  const isAlarm = (run?.incident.kind ?? kind) === 'fire-alarm';
  const isDrill = (run?.incident.kind ?? kind) === 'fire-drill' || isAlarm;
  const areaEvent = kind === 'earthquake' || kind === 'meteor';
  const showCasualties = !!run && isDisasterKind(run.incident.kind) && !!run.casualties;
  const minimumMinutes = isDisasterKind(kind) ? DISASTER_ASSUMPTIONS[kind].minDurationSeconds / 60 : 0;
  // Fire outdoor crowd: how people moved on so far (each choice is revealed when they leave the crowd or turn back).
  const dispersed = new Map<FireDispersal, [number, number]>();
  if (run?.crowd) for (const person of decisions) {
    if (!person.dispersal || !person.decision || person.decision.at > time) continue;
    const row = dispersed.get(person.dispersal) ?? [0, 0];
    row[person.role === 'occupant' ? 0 : 1]++;
    dispersed.set(person.dispersal, row);
  }

  return (
    <section id="panel-incidents" role="tabpanel" aria-labelledby="tab-incidents" className="incident-panel">
      <h2>Campus incidents</h2>
      <p className="model-note">Local what-if scenarios. These affect modeled students on this map, not real campus alerts.</p>
      {run && progress ? (
        <div className="incident-result">
          <h3>{names[run.incident.kind]} · {progress.phase}</h3>
          <p>{run.location.name}</p>
          <dl>
            {run.hazard && <><dt>Affected buildings</dt><dd>{run.hazard.affectedBuildingIds.length}</dd>
            {run.hazard.radiusMetres > 0 && <><dt>Scenario radius</dt><dd>{run.hazard.radiusMetres} m</dd></>}</>}
            {run.incident.kind === 'earthquake' && run.hazard && <><dt>Modeled shaking ends</dt><dd>{formatClock(run.hazard.responseStartsAt)}</dd></>}
            <dt>Access closed</dt><dd>{run.hazard ? 'Rest of the day' : `${formatClock(run.incident.start)}–${formatClock(run.endsAt)}`}</dd>
            {run.hazard && <><dt>Active effects until</dt><dd>{formatClock(run.hazard.activeUntil)}</dd></>}
            <dt>{isDrill ? 'Occupants at alarm' : 'Occupants at onset'}</dt><dd>{progress.occupantCount.toLocaleString()}</dd>
            {isDrill && run.assemblyLocation && <><dt>Outdoor assembly</dt><dd>{run.assemblyLocation.name}</dd>
            {run.assemblyClearanceMetres !== null && <><dt>Nearest building edge</dt><dd>{Math.floor(run.assemblyClearanceMetres)} m from assembly</dd></>}</>}
          </dl>
          {run.incident.kind === 'fire' && progress.phase !== 'Scheduled' && <section className="incident-response" aria-label="Firetruck response">
            <h4>Firetruck response</h4>
            {!run.fireResponse ? <p className="model-note">{run.fireResponseUnavailable === 'obstructed' ? 'Nearby buildings block the available hose paths.' : run.fireResponseUnavailable === 'out-of-reach' ? 'No saved road corridor is within hose reach of this building.' : 'Road data is unavailable for a firetruck response.'}</p>
              : trucks.length ? <dl className="incident-counts">
                <div><dt>En route</dt><dd>{responding}</dd></div>
                <div><dt>On scene</dt><dd>{staging + fighting}</dd></div>
                <div><dt>Applying water</dt><dd>{fighting}</dd></div>
                <div><dt>Departing</dt><dd>{leaving}</dd></div>
              </dl> : <p role="status">{run.hazard && time >= run.hazard.activeUntil ? 'Response complete.' : 'Dispatch pending.'}</p>}
            <p className="model-note">Modeled units follow saved road corridors. Firefighting effects do not change damage or casualty outcomes.</p>
          </section>}
          {showCasualties && progress.phase !== 'Scheduled' && <section className="incident-casualties" aria-label="Modeled casualties">
            <h4>Modeled casualties</h4>
            <dl className="incident-counts">
              <div><dt>Injured so far</dt><dd>{progress.injured.toLocaleString()}</dd></div>
              <div><dt>Fatalities so far</dt><dd>{progress.fatalities.toLocaleString()}</dd></div>
            </dl>
            <p className="model-note">Illustrative scenario, not a prediction. Injured agents remain incapacitated; treatment and rescue are not simulated. Map circles group injuries.</p>
          </section>}
          {progress.phase !== 'Scheduled' && <dl className="incident-counts" aria-label="Incident progress">
            <div><dt>{showCasualties ? 'Inside, able to evacuate' : 'Still inside'}</dt><dd>{progress.inside.toLocaleString()}</dd></div>
            {isDrill && <><div><dt>Walking to assembly</dt><dd>{progress.evacuating.toLocaleString()}</dd></div>
            <div><dt>At assembly</dt><dd>{progress.assembled.toLocaleString()}</dd></div></>}
            {run.crowd && <><div><dt>Walking out</dt><dd>{progress.evacuating.toLocaleString()}</dd></div>
            <div><dt>Evacuated, standing outside</dt><dd>{progress.assembled.toLocaleString()}</dd></div></>}
            <div><dt>Arrivals diverted so far</dt><dd>{progress.diverted.toLocaleString()}</dd></div>
            <div><dt>Chose another venue</dt><dd>{progress.relocated.toLocaleString()}</dd></div>
            {!isDrill && <><div><dt>Visits canceled so far</dt><dd>{progress.cancelled.toLocaleString()}</dd></div>
            <div><dt>Visits interrupted so far</dt><dd>{progress.interrupted.toLocaleString()}</dd></div></>}
            <div><dt>Rejoining schedule</dt><dd>{progress.recovering.toLocaleString()}</dd></div>
            <div><dt>Schedule resumed</dt><dd>{progress.resumed.toLocaleString()}</dd></div>
          </dl>}
          {run.crowd && progress.phase !== 'Scheduled' && <section className="incident-dispersal" aria-label="Where evacuees went">
            <h4>Where people went</h4>
            {dispersed.size ? <table>
              <thead><tr><th scope="col">Outcome</th><th scope="col">Evacuated</th><th scope="col">Turned back</th></tr></thead>
              <tbody>{(Object.keys(dispersalNames) as FireDispersal[]).filter((key) => dispersed.has(key)).map((key) => (
                <tr key={key}><th scope="row">{dispersalNames[key]}</th><td>{dispersed.get(key)![0].toLocaleString()}</td><td>{dispersed.get(key)![1].toLocaleString()}</td></tr>
              ))}</tbody>
            </table> : <p className="model-note">Evacuees are standing outside. Most move on 10 to 20 minutes after the alarm.</p>}
            <p className="model-note">The building counts 0 people while closed. People standing outside count as outdoors, never in a building.</p>
          </section>}
          {isAlarm && <FireResponsePanel response={run.response ?? null} time={time} siren={siren} onSiren={(on) => onSiren?.(on)} pending={responsePending} />}
          <IncidentDecisions participants={decisions} time={time} locations={locations} onLocate={onLocate} />
          {!run.hazard && time >= run.incident.start && time < run.endsAt && <p role="status">Access reopens in {Math.ceil((run.endsAt - time) / 60)} simulated minutes.</p>}
          {time >= progress.clearedAt && progress.occupantCount > 0 && <p className="model-note">{showCasualties ? 'Modeled evacuation response' : 'Modeled clearance'}: {Math.ceil((progress.clearedAt - run.incident.start) / 60)} minutes, using an assumed exit flow of 2 people per second per building.</p>}
          {!run.hazard && run.endsAt > run.incident.start + run.incident.duration && <p className="model-note">Closure extended to allow the modeled response before reopening.</p>}
          {!run.hazard && time >= run.endsAt && <p className="model-note">Access has reopened. Students resume from their actual positions; missed activities keep their original end times.</p>}
          {run.hazard && <p role="status">Damaged buildings stay closed for the rest of this simulated day. Reset the scenario to restore buildings and schedules.</p>}
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
          try { onStart(kind, target.id, minutes * 60, areaEvent ? radius : undefined, kind === 'fire' && outdoorCrowd); }
          catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start this incident.'); }
        }}>
          <label>Incident
            <select aria-label="Incident" value={kind} onChange={(event) => {
              const value = event.target.value as IncidentKind;
              setKind(value);
              setMinutes(value === 'fire-drill' || value === 'fire-alarm' ? 30 : 120);
              setRadius(value === 'meteor' ? 100 : 250);
            }}>
              <option value="fire-drill">Fire drill (scheduled)</option>
              <option value="fire-alarm">Fire alarm (Boston Fire responds)</option>
              <option value="building-closure">Building closure</option>
              <option value="fire">Fire</option>
              <option value="earthquake">Earthquake</option>
              <option value="meteor">Meteor impact</option>
            </select>
          </label>
          <label>Building
            <select aria-label="Building" value={target?.id ?? ''} onChange={(event) => setLocationId(event.target.value)}>
              {available.map((location) => <option key={location.id} value={location.id}>{location.kind === 'outdoor' ? `${location.name} (off campus)` : location.name}</option>)}
            </select>
          </label>
          {areaEvent && <label>Affected radius
            <select aria-label="Affected radius" value={radius} onChange={(event) => setRadius(Number(event.target.value))}>
              {[50, 100, 250, 500].map((value) => <option key={value} value={value}>{value} metres</option>)}
            </select>
          </label>}
          <label>{isDisasterKind(kind) ? 'Active effects duration' : 'Duration'}
            <select aria-label="Duration" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
              {[5, 15, 30, 60, 120, ...(isDisasterKind(kind) ? [240] : [])].filter(value => value >= minimumMinutes).map((value) => <option key={value} value={value}>{value} simulated minutes</option>)}
            </select>
          </label>
          {kind === 'fire-drill' && <p className="model-note">A scheduled drill is run by building staff and announced to the fire department in advance, so no apparatus are sent. Choose Fire alarm for an unplanned alarm.</p>}
          {kind === 'fire' && <>
            <label className="incident-option">
              <input type="checkbox" checked={outdoorCrowd} onChange={(event) => setOutdoorCrowd(event.target.checked)} />
              Evacuees gather outside first
            </label>
            <p className="model-note">{outdoorCrowd
              ? 'A real fire: everyone inside leaves by the nearest exits and spreads out along the sidewalks and plazas 30 to 80 m away, clear of the fire trucks. After 10 to 20 minutes most move on: to their next class or activity, home, or to their bus or train. Residents of a burning dorm shelter at an open dining hall, library or gym. People heading for the building turn back short of it.'
              : 'Occupants leave straight onto their next saved walk or wait at the nearest building outside the fire.'} The building stays closed for the rest of the day; the duration sets how long the fire burns.</p>
          </>}
          {kind === 'fire-alarm' && <p className="model-note">Boston Fire sends the nearest engines, ladder trucks and a district chief by drive time, with lights and optional siren.</p>}
          <p className="model-note">Starts at {formatClock(time)}. {descriptions[kind]} Classes stay tied to their scheduled location. Meals, studying, and exercise can move when a suitable venue and enough time are available.</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={!target}>{kind === 'fire-alarm' ? 'Sound fire alarm' : `Start ${kind === 'building-closure' ? 'closure' : names[kind].toLowerCase()}`}</button>
        </form>
      )}
      {onGame && <SimulatedGamePanel time={time} game={game} estimate={gameEstimate} onGame={onGame} />}
      <p className="model-note">Restrictions apply to visits to affected buildings. Through-traffic on saved paths may still cross the affected area. Disaster effects are illustrative; damage is stylized. Disaster casualties are uncalibrated scenario rules, and rescue and treatment are not simulated.</p>
      <details className="model-note">
        <summary>Model assumptions</summary>
        {[...INCIDENT_LIMITATIONS, ...ACTIVITY_DECISION_LIMITATIONS, ...DISASTER_LIMITATIONS, ...FIRE_CROWD_LIMITATIONS, ...CASUALTY_LIMITATIONS, ...FIRE_RESPONSE_LIMITATIONS].map((note) => <p key={note}>{note}</p>)}
      </details>
    </section>
  );
}
