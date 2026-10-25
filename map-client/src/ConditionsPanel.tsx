// The conditions engine in the Crowds tab: a scenario picker (live conditions by default), a
// paired comparison with an ordinary day, and a plain-language explanation of the model.
import { useState } from 'react';
import type { DayComparison } from './sim/compare';
import { explain, type DayInfo } from './sim/explain';
import type { Scenario } from './sim/scenarios';
import { LIVE } from './sim/scenarios';
import './conditions.css';

export type EngineStatus = 'starting' | 'building' | 'ready' | 'unavailable';

interface Props {
  scenarios: Scenario[];
  scenario: string;
  live: boolean;
  status: EngineStatus;
  error: string | null;
  info: DayInfo | null;
  outdoors: number | null;
  comparison: DayComparison | 'loading' | null;
  onScenario: (id: string) => void;
  onCompare: () => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

export function ConditionsPanel({ scenarios, scenario, live, status, error, info, outdoors, comparison, onScenario, onCompare }: Props) {
  const [showCompare, setShowCompare] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const current = scenarios.find(row => row.id === scenario);
  const statusText = status === 'building' ? 'Simulating the day… (the current day stays on the map until it is ready)'
    : status === 'starting' ? 'Starting the conditions engine…'
    : status === 'unavailable' ? `Conditions engine unavailable${error ? `: ${error}` : ''}; showing the unconditioned model.`
    : info ? explain(info).headline : '';
  const toggleCompare = () => { if (!showCompare) onCompare(); setShowCompare(!showCompare); };
  return (
    <section className="conditions" aria-labelledby="conditions-title">
      <h2 id="conditions-title">Conditions</h2>
      <label className="scenario-picker">
        <span>Scenario</span>
        <select value={scenario} onChange={(event) => { onScenario(event.target.value); if (showCompare) setShowCompare(false); }}>
          <option value={LIVE}>{live ? 'Live conditions (today, live weather)' : 'Shown day and weather'}</option>
          {scenarios.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select>
      </label>
      {current && <p className="muted scenario-description">{current.description}</p>}
      <p className="conditions-status" role="status" aria-live="polite">{statusText}</p>
      {outdoors !== null && <p className="muted">{fmt(outdoors)} people by the river right now (BU Beach, the Esplanade and the river path)</p>}
      <div className="conditions-actions">
        <button type="button" aria-expanded={showCompare} aria-controls="conditions-compare" onClick={toggleCompare} disabled={status === 'unavailable'}>
          Compare with an ordinary day
        </button>
        <button type="button" aria-expanded={showExplain} aria-controls="conditions-explain" onClick={() => setShowExplain(!showExplain)} disabled={!info}>
          Explain the model
        </button>
      </div>
      {showCompare && <div id="conditions-compare">{comparison === 'loading' || !comparison ? <p role="status">Simulating both days with the same students…</p> : <Comparison data={comparison} />}</div>}
      {showExplain && info && <Explain info={info} />}
    </section>
  );
}

const W = 288, H = 96, TOP = 6, BASE = 76;
// Line colours come from conditions.css: the ordinary day dashed in the accent, the scenario in the warning hue.

function Comparison({ data }: { data: DayComparison }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.hours.flatMap(row => [row.baseline, row.scenario]));
  const x = (hour: number) => ((hour + 0.5) / 24) * W;
  const y = (value: number) => BASE - (value / max) * (BASE - TOP);
  const line = (key: 'baseline' | 'scenario') => data.hours.map(row => `${x(row.hour).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ');
  const shown = data.hours[hover ?? data.hours.reduce((best, row) => Math.abs(row.scenario - row.baseline) > Math.abs(data.hours[best].scenario - data.hours[best].baseline) ? row.hour : best, 0)];
  return (
    <div className="compare">
      <h3>People walking, by hour</h3>
      <p className="compare-legend">
        <span><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="compare-baseline" strokeWidth="2" strokeDasharray="4 3" /></svg> Ordinary day</span>
        <span><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" className="compare-scenario" strokeWidth="2" /></svg> This scenario</span>
      </p>
      <p className="activity-readout">
        <span>{hourLabel(shown.hour)}: <strong>{fmt(shown.scenario)}</strong> vs {fmt(shown.baseline)} ({signed(shown.scenario - shown.baseline)})</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Average people walking each hour, scenario vs ordinary day. Biggest difference at ${hourLabel(shown.hour)}: ${fmt(shown.scenario)} vs ${fmt(shown.baseline)}.`}
        onPointerMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); setHover(Math.min(23, Math.max(0, Math.floor((event.clientX - box.left) / box.width * 24)))); }}
        onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={BASE} y2={BASE} className="compare-base" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={BASE} className="compare-hover" />}
        <polyline points={line('baseline')} fill="none" className="compare-baseline" strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
        <polyline points={line('scenario')} fill="none" className="compare-scenario" strokeWidth={2} strokeLinejoin="round" />
        {[6, 12, 18].map(h => <text key={h} x={x(h)} y={H - 4} textAnchor="middle" className="tick">{h === 12 ? 'noon' : hourLabel(h)}</text>)}
      </svg>
      <details>
        <summary>Hourly table</summary>
        <table className="compare-table">
          <thead><tr><th scope="col">Hour</th><th scope="col">Ordinary</th><th scope="col">Scenario</th><th scope="col">Change</th></tr></thead>
          <tbody>{data.hours.filter(row => row.baseline || row.scenario).map(row => (
            <tr key={row.hour}><th scope="row">{hourLabel(row.hour)}</th><td>{fmt(row.baseline)}</td><td>{fmt(row.scenario)}</td><td>{signed(row.scenario - row.baseline)}</td></tr>
          ))}</tbody>
        </table>
      </details>
      <h3>Places that change most</h3>
      <p className="muted">Person-hours spent there, 7 AM–midnight</p>
      {[['Busier', data.busier], ['Quieter', data.quieter]].map(([title, rows]) => (rows as DayComparison['busier']).length ? (
        <table key={title as string} className="compare-table">
          <caption>{title as string}</caption>
          <thead><tr><th scope="col">Place</th><th scope="col">Ordinary</th><th scope="col">Scenario</th><th scope="col">Change</th></tr></thead>
          <tbody>{(rows as DayComparison['busier']).map(row => (
            <tr key={row.id}><th scope="row">{row.name}</th><td>{fmt(row.baseline)}</td><td>{fmt(row.scenario)}</td>
              <td>{signed(row.delta)}{row.baseline > 0 ? ` (${signed((row.delta / row.baseline) * 100)}%)` : ''}</td></tr>
          ))}</tbody>
        </table>
      ) : null)}
      <h3>Whole day</h3>
      <table className="compare-table">
        <thead><tr><th scope="col">Visits</th><th scope="col">Ordinary</th><th scope="col">Scenario</th><th scope="col">Change</th></tr></thead>
        <tbody>{data.totals.map(row => (
          <tr key={row.id}><th scope="row">{row.label}</th><td>{fmt(row.baseline)}</td><td>{fmt(row.scenario)}</td><td>{signed(row.scenario - row.baseline)}</td></tr>
        ))}</tbody>
      </table>
      <p className="muted">Paired: the same students with the same random draws on both days, so differences come from the conditions alone.</p>
    </div>
  );
}

function Explain({ info }: { info: DayInfo }) {
  const text = explain(info);
  const groups: [string, typeof text.modifiers][] = [
    ['What the conditions change today', text.modifiers.filter(row => row.group === 'conditions')],
    ['Always on: calibration to measured data', text.modifiers.filter(row => row.group === 'calibration')],
  ];
  return (
    <div id="conditions-explain" className="explain">
      <h3>Today’s conditions</h3>
      <ul>{text.conditions.map(line => <li key={line}>{line}</li>)}</ul>
      {groups.map(([title, rows]) => (
        <div key={title}>
          <h3>{title}</h3>
          {rows.length ? (
            <ul className="explain-modifiers">{rows.map(row => (
              <li key={row.id}>
                <strong>{row.label}</strong>{row.effects.length ? `: ${row.effects.join('; ')}` : ''}
                <span className="explain-source">Source — {row.source}</span>
              </li>
            ))}</ul>
          ) : <p className="muted">None: an ordinary day for these rules.</p>}
        </div>
      ))}
      <h3>Who the students are</h3>
      <ul>{text.personas.map(line => <li key={line}>{line}</li>)}</ul>
      <h3>Where the numbers come from</h3>
      <ul>{text.numbers.map(line => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}
