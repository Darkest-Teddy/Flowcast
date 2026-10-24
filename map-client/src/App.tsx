import { useEffect, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { createBasemap, type Basemap, type LightPreset } from './map/basemap';
import { agentLayers, loadCharacterModels, type LoadedModels } from './layers/agents';
import { crowdLayers, crowdLevel } from './layers/crowd';
import { Playback, formatClock, loadDay, type Occupancy, type WalkingAgent } from './sim/playback';

const SPEEDS = [1, 30, 120, 600];

/** ?at=9:00 (24h clock) starts playback there; default is the run-up to the 9:05 class change. */
function startTimeFromUrl(): number {
  const at = new URLSearchParams(window.location.search).get('at');
  const match = at?.match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 : 8 * 3600 + 50 * 60;
}

const START_AT = startTimeFromUrl();
const START_SPEED = Number(new URLSearchParams(window.location.search).get('speed')) || SPEEDS[1];
const OCCUPANCY_REFRESH_MS = 500;

interface Hud {
  time: number;
  walking: number;
  occupancy: Occupancy[];
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const timeRef = useRef(START_AT);
  const speedRef = useRef(START_SPEED);
  const playingRef = useRef(true);
  const selectedRef = useRef<string | null>(null);

  const [status, setStatus] = useState('Loading campus…');
  const [mapKind, setMapKind] = useState<Basemap['kind'] | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 86400]);
  const [speed, setSpeed] = useState(START_SPEED);
  const [playing, setPlaying] = useState(true);
  const [light, setLight] = useState<LightPreset>('dusk');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let overlay: MapboxOverlay | null = null;

    (async () => {
      const [basemap, day, models] = await Promise.all([
        createBasemap(containerRef.current!, light),
        loadDay('/data/demo-day.json'),
        loadCharacterModels() as Promise<LoadedModels>,
      ]);
      if (cancelled) return basemap.remove();
      basemapRef.current = basemap;
      setMapKind(basemap.kind);

      const playback = new Playback(day);
      setRange([playback.startTime, playback.endTime]);

      overlay = new MapboxOverlay({
        interleaved: new URLSearchParams(window.location.search).get('interleaved') !== '0',
        _animate: true, // keeps the walk cycles ticking between data updates
        // Building footprints and labels both carry the building id; clicking empty map clears.
        onClick: ({ object }: PickingInfo) => {
          const id = object && !('bearing' in object) ? (object as { id: string }).id : null;
          selectedRef.current = id;
          setSelected(id);
        },
        getTooltip: ({ object }: PickingInfo) => {
          if (!object || !('bearing' in object)) return null;
          const agent = object as WalkingAgent;
          return `Student ${agent.id} → ${playback.locations.find((l) => l.id === agent.to)?.name}`;
        },
      });
      basemap.addControl(overlay);
      setStatus('');

      let last = performance.now();
      let lastOccupancy = 0;
      let occupancy = playback.occupancyAt(timeRef.current);
      const tick = (now: number) => {
        const dt = Math.min(now - last, 100) / 1000;
        last = now;
        if (playingRef.current) {
          timeRef.current += dt * speedRef.current;
          if (timeRef.current > playback.endTime) timeRef.current = playback.startTime;
        }
        const t = timeRef.current;
        const walking = playback.walkingAt(t);
        if (now - lastOccupancy > OCCUPANCY_REFRESH_MS) {
          occupancy = playback.occupancyAt(t);
          lastOccupancy = now;
          setHud({ time: t, walking: walking.length, occupancy });
        }
        overlay!.setProps({
          layers: [
            ...crowdLayers({
              footprints: day.buildings,
              buildings: playback.byBuilding(occupancy),
              trips: day.trips,
              time: t,
              speed: speedRef.current,
              selectedId: selectedRef.current,
              project: basemap.project,
            }),
            ...agentLayers(walking, models, t),
          ],
        });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })().catch((err) => setStatus(`Could not start the map: ${err.message}`));

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      basemapRef.current?.remove();
      basemapRef.current = null;
    };
    // The map is created once; light changes go through setLightPreset below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => basemapRef.current?.setLightPreset(light), [light]);

  const changeSpeed = (s: number) => {
    speedRef.current = s;
    setSpeed(s);
  };
  const togglePlaying = () => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };
  const scrub = (t: number) => {
    timeRef.current = t;
  };
  const select = (o: Occupancy) => {
    selectedRef.current = o.location.building;
    setSelected(o.location.building);
    basemapRef.current?.flyTo(o.location.position);
  };

  const ranked = hud ? [...hud.occupancy].sort((a, b) => b.share - a.share) : [];

  return (
    <div className="app">
      <div ref={containerRef} className="map" />

      <header className="panel title">
        <h1>Flowcast</h1>
        <p>
          BU campus · Wednesday {hud ? `· ${hud.walking} students walking` : ''}
        </p>
      </header>

      {status && <div className="panel status" role="status">{status}</div>}

      {hud && (
        <aside className="panel busiest" aria-label="Busiest places right now">
          <h2>Busiest right now</h2>
          <ol>
            {ranked.slice(0, 8).map((o) => {
              const level = crowdLevel(o.share);
              return (
                <li key={o.location.id}>
                  <button
                    className={o.location.building === selected ? 'row selected' : 'row'}
                    onClick={() => select(o)}
                    aria-pressed={o.location.building === selected}
                  >
                    <span className="name">{o.location.name}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, o.share * 100)}%`, background: `rgb(${level.glow.slice(0, 3).join(',')})` }} />
                    </span>
                    <span className="value">
                      {Math.round(o.share * 100)}% · {level.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      )}

      {hud && (
        <footer className="panel timeline">
          <button className="play" onClick={togglePlaying} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <output className="clock" aria-live="off">{formatClock(hud.time)}</output>
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={60}
            value={hud.time}
            onChange={(e) => scrub(Number(e.target.value))}
            aria-label="Time of day"
            aria-valuetext={formatClock(hud.time)}
          />
          <div className="speeds" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} onClick={() => changeSpeed(s)} aria-pressed={speed === s}>
                {s}×
              </button>
            ))}
          </div>
          {mapKind === 'mapbox' && (
            <select value={light} onChange={(e) => setLight(e.target.value as LightPreset)} aria-label="Lighting">
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          )}
        </footer>
      )}

      {mapKind === 'maplibre' && (
        <p className="panel note">
          Fallback map (no Mapbox token). Set <code>VITE_MAPBOX_TOKEN</code> for textured, lit buildings.
        </p>
      )}
    </div>
  );
}
