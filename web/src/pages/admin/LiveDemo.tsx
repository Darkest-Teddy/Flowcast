import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Zap } from 'lucide-react';
import { api, locationName, useResource } from '../../data/api';
import type { SimEvent, SimulationSettings, Weather } from '../../data/types';
import { formatTime } from '../../lib/format';
import { Button, Loading, Page, PageHeader, SectionHeading, StatusBadge } from '../../ui';
import { BigButton } from './components/BigButton';
import { speedLabel, weatherLabel } from './components/simOptions';
import { StatusLine, useFlash } from './components/StatusLine';
import styles from './LiveDemo.module.css';

const jumps = [
  { label: 'Morning classes', clock: '08:45' },
  { label: 'Lunch rush', clock: '12:15' },
  { label: 'Afternoon lull', clock: '15:30' },
  { label: 'Evening events', clock: '19:00' },
];

const voteWeather: Weather[] = ['rain', 'snow', 'heatwave', 'clear'];
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;

type VoteOption = { id: string; label: string; apply: { weather: Weather } | { eventId: string } };
type VotePhase = 'setup' | 'open' | 'closed';

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
  const { data: sim, setData: setSim } = useResource(api.getSimulation);
  const { data: speeds } = useResource(api.getPlaybackSpeeds);
  const { data: locations } = useResource(api.getLocations);
  const [busy, setBusy] = useState(false);
  const message = useFlash(6000);

  const update = async (patch: Partial<SimulationSettings>, done: string) => {
    setBusy(true);
    setSim(await api.updateSimulation(patch));
    setBusy(false);
    message.show(done);
  };

  const reset = async () => {
    setBusy(true);
    setSim(await api.resetSimulation());
    setBusy(false);
    message.show('Reset to baseline: live clock, live weather, no events running.');
  };

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
      <AudienceVote sim={sim} place={place} onApply={update} disabled={busy} />
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

function AudienceVote({
  sim,
  place,
  onApply,
  disabled,
}: {
  sim: SimulationSettings;
  place: (e: SimEvent) => string;
  onApply: (patch: Partial<SimulationSettings>, done: string) => Promise<void>;
  disabled: boolean;
}) {
  const options: VoteOption[] = [
    ...voteWeather.map((w) => ({ id: `weather:${w}`, label: weatherLabel(w), apply: { weather: w } })),
    ...sim.events.map((e) => ({ id: `event:${e.id}`, label: `${e.title} at ${place(e)}`, apply: { eventId: e.id } })),
  ];
  const [picked, setPicked] = useState<string[]>(['weather:rain', 'weather:snow', 'event:fire-drill']);
  const [phase, setPhase] = useState<VotePhase>('setup');
  const [tally, setTally] = useState<Record<string, number>>({});
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(timer.current), []);

  const inVote = options.filter((o) => picked.includes(o.id));
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const winner = [...inVote].sort((a, b) => (tally[b.id] ?? 0) - (tally[a.id] ?? 0))[0];

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_OPTIONS ? [...p, id] : p));

  // Mock tally: votes trickle in with a different appetite per option, until a real audience page exists.
  const open = () => {
    const weights = Object.fromEntries(inVote.map((o) => [o.id, 0.4 + Math.random()]));
    setTally(Object.fromEntries(inVote.map((o) => [o.id, 0])));
    setPhase('open');
    timer.current = setInterval(() => {
      setTally((t) => {
        const next = { ...t };
        for (const o of inVote) if (Math.random() < weights[o.id] / 2) next[o.id] = (next[o.id] ?? 0) + 1 + Math.floor(Math.random() * 2);
        return next;
      });
    }, 700);
  };

  const close = async () => {
    clearInterval(timer.current);
    setPhase('closed');
    if (!winner) return;
    const votes = tally[winner.id] ?? 0;
    const done = `Vote closed. ${winner.label} won with ${votes} ${votes === 1 ? 'vote' : 'votes'} and is now on the map.`;
    if ('weather' in winner.apply) await onApply({ weather: winner.apply.weather }, done);
    else {
      const id = winner.apply.eventId;
      await onApply({ events: sim.events.map((e) => (e.id === id ? { ...e, enabled: true } : e)) }, done);
    }
  };

  const cancel = () => {
    clearInterval(timer.current);
    setTally({});
    setPhase('setup');
  };

  if (phase === 'setup') {
    return (
      <div className={styles.vote}>
        <fieldset className={styles.pick}>
          <legend className={styles.groupLabel}>
            Pick {MIN_OPTIONS} to {MAX_OPTIONS} options for the audience ({picked.length} picked)
          </legend>
          <div className={styles.pickGrid}>
            {options.map((o) => {
              const on = picked.includes(o.id);
              return (
                <label key={o.id} className={`${styles.pickOption} ${on ? styles.pickOn : ''}`}>
                  <input type="checkbox" checked={on} disabled={!on && picked.length >= MAX_OPTIONS} onChange={() => toggle(o.id)} />
                  <span>{o.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className={styles.buttons}>
          <BigButton tone="accent" title="Open vote" detail={`${picked.length} options`} onClick={open} disabled={picked.length < MIN_OPTIONS} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.vote}>
      <div className={styles.voteHead}>
        {phase === 'open' ? <StatusBadge tone="ok">Vote open</StatusBadge> : <StatusBadge tone="off">Vote closed</StatusBadge>}
        <span className={styles.total}>
          {total} {total === 1 ? 'vote' : 'votes'}
        </span>
        <span className={styles.mockNote}>Sample tally: votes are simulated until the audience page exists.</span>
      </div>
      <ol className={styles.tally} aria-label="Votes so far">
        {inVote.map((o) => {
          const n = tally[o.id] ?? 0;
          const share = total ? n / total : 0;
          const leading = winner?.id === o.id && n > 0;
          return (
            <li key={o.id} className={`${styles.tallyRow} ${leading ? styles.leading : ''}`}>
              <div className={styles.tallyText}>
                <span className={styles.tallyLabel}>
                  {o.label}
                  {leading && <span className={styles.leadTag}>{phase === 'closed' ? 'Winner' : 'Leading'}</span>}
                </span>
                <span className={styles.tallyCount}>
                  {n} ({Math.round(share * 100)}%)
                </span>
              </div>
              <span className={styles.track} aria-hidden>
                <b style={{ width: `${share * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      <div className={styles.buttons}>
        {phase === 'open' ? (
          <>
            <BigButton tone="accent" title="Close vote and apply winner" detail={winner && total ? `${winner.label} is leading` : 'No votes yet'} onClick={close} disabled={disabled || total === 0} />
            <BigButton title="Cancel vote" detail="Nothing changes on the map" onClick={cancel} />
          </>
        ) : (
          <BigButton title="Start a new vote" onClick={cancel} />
        )}
      </div>
    </div>
  );
}
