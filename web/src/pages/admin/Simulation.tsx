import { useEffect, useId, useState } from 'react';
import { api, locationName, useResource } from '../../data/api';
import type { SimulationSettings } from '../../data/types';
import { Button, Loading, Page, PageHeader, Panel, Segmented, Toggle } from '../../ui';
import { ChoiceList } from './components/ChoiceList';
import { SettingRow } from './components/SettingRow';
import { lightingOptions, speedLabel, weatherOptions } from './components/simOptions';
import { StatusLine, useFlash } from './components/StatusLine';
import styles from './Simulation.module.css';

const AGENTS_MIN = 50;
const AGENTS_MAX = 3000;

// The parts of the settings this page edits. Agent brain settings live on their own page.
type Editable = Pick<SimulationSettings, 'playbackSpeed' | 'paused' | 'weather' | 'lighting' | 'layers' | 'population' | 'events'>;
const editable = (s: SimulationSettings): Editable => ({
  playbackSpeed: s.playbackSpeed,
  paused: s.paused,
  weather: s.weather,
  lighting: s.lighting,
  layers: s.layers,
  population: s.population,
  events: s.events,
});

function countChanges(a: Editable, b: Editable): number {
  const flat = (e: Editable) => [
    e.playbackSpeed,
    e.paused,
    e.weather,
    e.lighting,
    ...Object.values(e.layers),
    ...Object.values(e.population),
    ...e.events.map((ev) => ev.enabled),
  ];
  const fa = flat(a);
  const fb = flat(b);
  return fa.filter((v, i) => v !== fb[i]).length;
}

export default function Simulation() {
  const { data: saved, setData: setSaved } = useResource(api.getSimulation);
  const { data: speeds } = useResource(api.getPlaybackSpeeds);
  const { data: locations } = useResource(api.getLocations);
  const [draft, setDraft] = useState<Editable | null>(null);
  const [applying, setApplying] = useState(false);
  const [agentsText, setAgentsText] = useState('');
  const message = useFlash();
  const agentsId = useId();

  useEffect(() => {
    if (saved && !draft) {
      setDraft(editable(saved));
      setAgentsText(String(saved.population.agents));
    }
  }, [saved, draft]);

  if (!saved || !draft || !speeds) {
    return (
      <Page>
        <PageHeader title="Simulation" />
        <Loading label="Loading simulation settings" />
      </Page>
    );
  }

  const base = editable(saved);
  const changes = countChanges(base, draft);
  const agents = Number(agentsText);
  const agentsError =
    agentsText.trim() === '' || !Number.isInteger(agents) || agents < AGENTS_MIN || agents > AGENTS_MAX
      ? `Enter a whole number from ${AGENTS_MIN} to ${AGENTS_MAX.toLocaleString()}.`
      : undefined;

  const set = (patch: Partial<Editable>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setLayer = (key: keyof Editable['layers'], value: boolean) => set({ layers: { ...draft.layers, [key]: value } });
  const setPopulation = (patch: Partial<Editable['population']>) => set({ population: { ...draft.population, ...patch } });
  const setEvent = (id: string, enabled: boolean) => set({ events: draft.events.map((e) => (e.id === id ? { ...e, enabled } : e)) });

  const discard = () => {
    setDraft(base);
    setAgentsText(String(base.population.agents));
    message.show('Changes discarded', 'off');
  };

  const apply = async () => {
    setApplying(true);
    const updated = await api.updateSimulation(draft);
    setSaved(updated);
    setDraft(editable(updated));
    setApplying(false);
    message.show('Applied to the map');
  };

  const scheduled = draft.events.filter((e) => e.kind === 'scheduled');

  return (
    <Page>
      <PageHeader
        title="Simulation"
        description="Settings for the shared map. People on the map can only pick a day and a time; everything else is set here and reaches every screen when you apply it."
      />

      <StatusLine flash={changes === 0 ? message.flash : null} className={styles.message} />

      <div className={styles.columns}>
        <Panel title="Playback" description="How fast the simulated clock runs.">
          <SettingRow label="Speed">
            <Segmented label="Playback speed" value={draft.playbackSpeed} onChange={(v) => set({ playbackSpeed: v })} options={speeds.map((n) => ({ value: n, label: speedLabel(n) }))} />
          </SettingRow>
          <Toggle label="Paused" description="Freeze the clock. Agents stay where they are." checked={draft.paused} onChange={(v) => set({ paused: v })} />
        </Panel>

        <Panel title="Weather" description="Changes how agents behave, not just how the map looks.">
          <ChoiceList name="weather" label="Weather" options={weatherOptions} value={draft.weather} onChange={(v) => set({ weather: v })} />
        </Panel>

        <Panel title="Lighting" description="Time of day the map is drawn in. Doesn't change the clock.">
          <SettingRow label="Light">
            <Segmented label="Lighting" value={draft.lighting} onChange={(v) => set({ lighting: v })} options={lightingOptions} />
          </SettingRow>
        </Panel>

        <Panel title="Map layers" description="What's drawn on the shared map.">
          <Toggle label="MBTA and shuttles" description="Green Line trains, buses and BU shuttles." checked={draft.layers.transit} onChange={(v) => setLayer('transit', v)} />
          <Toggle label="Street traffic" description="Cars and buses on the streets around campus." checked={draft.layers.traffic} onChange={(v) => setLayer('traffic', v)} />
          <Toggle label="Performance monitor" description="Frame rate and memory in a corner of the map. For debugging." checked={draft.layers.perfMonitor} onChange={(v) => setLayer('perfMonitor', v)} />
        </Panel>

        <Panel title="Population" description="Who is being simulated.">
          <SettingRow label="Agents" labelFor={agentsId} description={agentsError ? <span className={styles.error}>{agentsError}</span> : `${AGENTS_MIN} to ${AGENTS_MAX.toLocaleString()}. More agents, slower map.`}>
            <input
              id={agentsId}
              className={styles.number}
              type="number"
              inputMode="numeric"
              min={AGENTS_MIN}
              max={AGENTS_MAX}
              step={50}
              value={agentsText}
              aria-invalid={Boolean(agentsError)}
              onChange={(e) => {
                setAgentsText(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= AGENTS_MIN && n <= AGENTS_MAX) setPopulation({ agents: n });
              }}
            />
          </SettingRow>
          <Toggle label="Include real calendars" description="Students who connected Google Calendar follow their real week." checked={draft.population.includeCalendars} onChange={(v) => setPopulation({ includeCalendars: v })} />
          <Toggle label="Include club events" description="Agents who follow a club go to its events." checked={draft.population.includeClubEvents} onChange={(v) => setPopulation({ includeClubEvents: v })} />
        </Panel>

        <Panel title="Scheduled campus events" description="Pull agents toward a place at a set time. Instant events are on the Live demo page.">
          {scheduled.map((e) => (
            <Toggle key={e.id} label={e.title} description={`${locationName(locations, e.locationId, false)}, ${e.when}`} checked={e.enabled} onChange={(v) => setEvent(e.id, v)} />
          ))}
        </Panel>
      </div>

      {changes > 0 && (
        <div className={styles.bar} role="region" aria-label="Unapplied changes">
          <p className={styles.barText}>
            {changes === 1 ? '1 change' : `${changes} changes`} not on the map yet.
          </p>
          <div className={styles.barActions}>
            <Button variant="ghost" onClick={discard} disabled={applying}>
              Discard
            </Button>
            <Button variant="accent" onClick={apply} disabled={applying || Boolean(agentsError)}>
              {applying ? 'Applying' : 'Apply to the map'}
            </Button>
          </div>
        </div>
      )}
    </Page>
  );
}
