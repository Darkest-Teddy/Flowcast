import { useMemo } from 'react';
import { WEEKDAYS } from './data/campusData';
import { countText, type MobilityArc, type MobilityData, type MobilityMode, type MobilityPoint, type MobilityView } from './data/mobility';
import { formatClock } from './sim/playback';
import './mobility.css';

interface Props {
  data: MobilityData | null;
  view: MobilityView | null;
  mode: MobilityMode;
  weekday: number;
  selected: string | null;
  onMode: (mode: MobilityMode) => void;
  onSelect: (point: MobilityPoint | MobilityArc) => void;
  error: string | null;
}

const MODES: { id: MobilityMode; label: string }[] = [
  { id: 'roads', label: 'Roads' },
  { id: 'bikes', label: 'Bikes' },
  { id: 'pedestrians', label: 'Walking' },
  { id: 'off', label: 'Hide' },
];

function valueText(item: MobilityPoint | MobilityArc): string {
  if (item.mobilityKind === 'road') return `${countText(item.value)} vehicles/h · ${countText(item.bikes ?? 0)} bikes/h`;
  if (item.mobilityKind === 'pedestrian') return `${countText(item.value)} crossings/h`;
  return `${countText(item.value)} trips/h`;
}

function surveyPeriod(locations: { observedFrom: string; observedTo: string }[]): string {
  if (!locations.length) return 'No counts collected';
  const first = locations.map((location) => location.observedFrom).sort()[0];
  const last = locations.map((location) => location.observedTo).sort().at(-1)!;
  return first === last ? first : `${first} to ${last}`;
}

function availableTimes(data: MobilityData, mode: MobilityMode): string[] {
  const days = new Map<number, Set<number>>();
  const add = (weekday: number, hour: number) => {
    if (!days.has(weekday)) days.set(weekday, new Set());
    days.get(weekday)!.add(hour);
  };
  if (mode === 'roads') {
    data.roads.locations.forEach((location) => location.profiles.forEach((profile) => add(profile.weekday, profile.hour)));
  } else if (mode === 'pedestrians') {
    data.pedestrians.locations.forEach((location) => location.profiles.forEach((profile) => {
      if (profile.weekday === null) profile.weekdays?.forEach((weekday) => add(weekday, profile.hour));
      else add(profile.weekday, profile.hour);
    }));
  } else if (mode === 'bikes') {
    data.bluebikes.flows.forEach((flow) => add(flow.weekday, flow.hour));
  }
  return [...days].sort(([a], [b]) => a - b).map(([weekday, hours]) => {
    const sorted = [...hours].sort((a, b) => a - b);
    if (sorted.length > 6) return `${WEEKDAYS[weekday]}: ${formatClock(sorted[0] * 3600)} to ${formatClock((sorted.at(-1)! + 1) * 3600)}`;
    return `${WEEKDAYS[weekday]}: ${sorted.map((hour) => formatClock(hour * 3600)).join(', ')}`;
  });
}

export function MobilityPanel({ data, view, mode, weekday, selected, onMode, onSelect, error }: Props) {
  const availability = useMemo(() => data ? availableTimes(data, mode) : [], [data, mode]);
  const rows: (MobilityPoint | MobilityArc)[] = mode === 'bikes' ? view?.arcs ?? [] : view?.points ?? [];
  const chosen = rows.find((row) => row.id === selected) ?? view?.points.find((point) => point.id === selected);
  const hour = view?.hour ?? 0;
  return (
    <div className="mobility-panel">
      <h2>Traffic counts</h2>
      <div className="mobility-modes" role="group" aria-label="Traffic layer">
        {MODES.map(({ id, label }) => <button key={id} onClick={() => onMode(id)} aria-pressed={mode === id}>{label}</button>)}
      </div>
      {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading traffic counts…</p> : mode === 'off' ? <p className="mobility-caption">Traffic layers hidden.</p> : <>
        <p className="mobility-period">{WEEKDAYS[weekday]} · {formatClock(hour * 3600)} to {formatClock((hour + 1) * 3600)}</p>
        <p className="mobility-caption">{mode === 'bikes' ? 'Bluebikes trips · station pairs' : mode === 'pedestrians' ? 'Midweek crossing surveys' : 'Survey counts · hourly averages'}</p>
        {chosen && <section className="mobility-selection" aria-label="Selected traffic count">
          <h3>{chosen.name}</h3>
          <strong>{valueText(chosen)}</strong>
          {chosen.mobilityKind === 'flow' ? <p className="mobility-caption">{chosen.trips.toLocaleString()} trips across {chosen.days} {WEEKDAYS[weekday]}s · {countText(chosen.duration / 60)} min average</p> : <p className="mobility-breakdown">{chosen.details}</p>}
          <p className="mobility-caption">{chosen.period}</p>
          <a href={chosen.sourceUrl} target="_blank" rel="noreferrer">View source</a>
        </section>}
        {rows.length ? <>
          <h3>{mode === 'bikes' ? 'Station pairs' : 'Count locations'}</h3>
          <ul className="mobility-locations">
            {rows.slice(0, 30).map((row) => <li key={row.id}>
              <button onClick={() => onSelect(row)} aria-pressed={selected === row.id}>
                <span>{row.name}</span>
                <strong>{valueText(row)}</strong>
                {row.mobilityKind === 'flow' && <span className="mobility-caption">{row.trips.toLocaleString()} trips / {row.days} days</span>}
              </button>
            </li>)}
          </ul>
          {rows.length > 30 && <p className="mobility-caption">Showing the 30 busiest of {rows.length} station pairs.</p>}
        </> : <div className="mobility-empty">
          <p>No {WEEKDAYS[weekday]} {mode === 'bikes' ? 'trips' : 'counts'} for this hour in this campus area.</p>
          {availability.length > 0 && <details><summary>Available times across campuses</summary><ul>{availability.map((text) => <li key={text}>{text}</li>)}</ul></details>}
          <p className="mobility-caption">Use the day selector and timeline to explore another time.</p>
        </div>}
      </>}
      {data && <details className="mobility-sources">
        <summary>Sources</summary>
        <ul>
          <li><a href={data.roads.sourceUrl} target="_blank" rel="noreferrer">Boston road and bike counts</a><span>{surveyPeriod(data.roads.locations)}</span></li>
          <li><a href={data.bluebikes.sourceUrl} target="_blank" rel="noreferrer">Bluebikes trip history</a><span>{data.bluebikes.period.start} to {data.bluebikes.period.end}</span></li>
          <li><a href={data.pedestrians.sourceUrl} target="_blank" rel="noreferrer">Pedestrian crossing counts</a><span>{surveyPeriod(data.pedestrians.locations)}</span></li>
        </ul>
      </details>}
    </div>
  );
}
