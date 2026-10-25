import { useEffect, useState } from 'react';
import { Pause, Play, RotateCcw, Zap } from 'lucide-react';
import { api, locationName, useResource } from '../../data/api';
import type { SimEvent, SimulationSettings } from '../../data/types';
import { formatTime } from '../../lib/format';
import { Button, Loading, Page, PageHeader, SectionHeading, StatusBadge } from '../../ui';
import { BigButton } from './components/BigButton';
import { speedLabel } from './components/simOptions';
import { StatusLine, useFlash } from './components/StatusLine';
import styles from './LiveDemo.module.css';

const jumps = [
  { label: 'Morning classes', clock: '08:45' },
  { label: 'Lunch rush', clock: '12:15' },
  { label: 'Afternoon lull', clock: '15:30' },
  { label: 'Evening events', clock: '19:00' },
];

const clockIso = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const toClock = (minutes: number) => {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export default function LiveDemo() {
  const { data: sim, setData: setSim, error: simError } = useResource(api.getSimulation);
  const { data: speeds, error: speedsError } = useResource(api.getPlaybackSpeeds);
  const { data: locations, error: locationsError } = useResource(api.getLocations);
  const [busy, setBusy] = useState(false);
  const message = useFlash(6000);

  const update = async (patch: Partial<SimulationSettings>, done: string) => {
    setBusy(true);
    try {
      setSim(await api.updateSimulation(patch));
      message.show(done);
    } catch (error) {
      message.show(error instanceof Error ? error.message : 'Simulation update failed.', 'bad', true);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      setSim(await api.resetSimulation());
      message.show('Reset to baseline: live clock, live weather, no events running.');
    } catch (error) {
      message.show(error instanceof Error ? error.message : 'Simulation reset failed.', 'bad', true);
    } finally {
      setBusy(false);
    }
  };

  const loadError = simError || speedsError;
  if (loadError) return <Page><PageHeader title="Live demo" /><p role="alert">{loadError.message}</p></Page>;

  if (!sim || !speeds) {
    return (
      <Page wide>
        <PageHeader title="Live demo" />
        <Loading label="Loading the shared map's state" />
      </Page>
    );
  }

  const instant = sim.events.filter((e) => e.kind === 'instant');
  const place = (e: SimEvent) => locationName(locations, e.locationId);

  return (
    <Page wide>
      <PageHeader
        title="Live demo"
        description="Presenter controls for judging. Every button changes the shared map straight away."
        actions={
          <Button variant="danger" size="lg" icon={<RotateCcw aria-hidden />} onClick={reset} disabled={busy}>
            Reset to baseline
          </Button>
        }
      />

      {locationsError && <p role="alert">Location names are unavailable: {locationsError.message}</p>}
      <StatusLine flash={message.flash} className={styles.message} />

      <SectionHeading>Clock</SectionHeading>
      <div className={styles.card}>
        <div className={styles.clockRow}>
          <SimClock sim={sim} />
          <BigButton
            tone="accent"
            icon={sim.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            title={sim.paused ? 'Play' : 'Pause'}
            detail={sim.paused ? 'Start the clock again' : 'Freeze every agent'}
            onClick={() => update({ paused: !sim.paused }, sim.paused ? 'Playing' : 'Paused')}
            disabled={busy}
          />
        </div>

        <div className={styles.group} role="group" aria-label="Playback speed">
          <span className={styles.groupLabel}>Speed</span>
          <div className={styles.buttons}>
            {speeds.map((n) => (
              <BigButton
                key={n}
                title={speedLabel(n)}
                pressed={sim.playbackSpeed === n}
                onClick={() => update({ playbackSpeed: n }, n === 1 ? 'Playing at the live clock' : `Playing at ${speedLabel(n)}`)}
                disabled={busy}
              />
            ))}
          </div>
        </div>

        <div className={styles.group} role="group" aria-label="Jump to a time">
          <span className={styles.groupLabel}>Jump to</span>
          <div className={styles.buttons}>
            {jumps.map((j) => (
              <BigButton
                key={j.clock}
                title={j.label}
                detail={formatTime(clockIso(j.clock))}
                pressed={sim.clock === j.clock}
                onClick={() => update({ clock: j.clock }, `Jumped to ${j.label.toLowerCase()}, ${formatTime(clockIso(j.clock))}`)}
                disabled={busy}
              />
            ))}
            {sim.clock && (
              <BigButton title="Real time" detail="Follow the real clock" onClick={() => update({ clock: undefined }, 'Following the real clock')} disabled={busy} />
            )}
          </div>
        </div>
      </div>

      <SectionHeading>Instant events</SectionHeading>
      <ul className={styles.events}>
        {instant.map((e) => (
          <li key={e.id} className={styles.event}>
            <div className={styles.eventText}>
              <span className={styles.eventTitle}>
                {e.title} at {place(e)}
              </span>
              {e.enabled ? <StatusBadge tone="warn">Happening now</StatusBadge> : <StatusBadge tone="off">Not running</StatusBadge>}
            </div>
            {e.enabled ? (
              <BigButton
                title="End it"
                onClick={() => update({ events: sim.events.map((x) => (x.id === e.id ? { ...x, enabled: false } : x)) }, `${e.title} ended`)}
                disabled={busy}
              />
            ) : (
              <BigButton
                tone="accent"
                icon={<Zap aria-hidden />}
                title="Trigger now"
                onClick={() => update({ events: sim.events.map((x) => (x.id === e.id ? { ...x, enabled: true } : x)) }, `${e.title} triggered at ${place(e)}`)}
                disabled={busy}
              />
            )}
          </li>
        ))}
      </ul>

      <SectionHeading>Audience vote</SectionHeading>
      <p role="status">Audience voting is unavailable. No audience voting service is connected.</p>
    </Page>
  );
}

/** The simulated time, ticking at the current speed between updates from the server. */
function SimClock({ sim }: { sim: SimulationSettings }) {
  const start = () => (sim.clock ? minutesOf(sim.clock) : new Date().getHours() * 60 + new Date().getMinutes());
  const [minutes, setMinutes] = useState(start);

  useEffect(() => {
    setMinutes(start());
    if (sim.paused) return;
    const id = setInterval(() => setMinutes((m) => m + sim.playbackSpeed / 60), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.clock, sim.paused, sim.playbackSpeed]);

  return (
    <div className={styles.clock}>
      <span className={styles.clockLabel}>Simulated time</span>
      <span className={styles.clockTime}>{formatTime(clockIso(toClock(minutes)))}</span>
      <StatusBadge tone={sim.paused ? 'off' : 'ok'}>
        {sim.paused ? 'Paused' : sim.playbackSpeed === 1 ? 'Playing at the live clock' : `Playing at ${speedLabel(sim.playbackSpeed)}`}
      </StatusBadge>
    </div>
  );
}
