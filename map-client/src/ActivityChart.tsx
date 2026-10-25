// A one-series area chart of a day in fixed-size bins, with the playback time marked and a
// hover readout. Used for the typical-weekday Bluebikes activity at a campus's docks. Colours come
// from styles.css (.activity-*): the series in the accent, the playback time in ink.
import { useState } from 'react';
import { formatClock } from './sim/playback';

const W = 288;
const H = 64;
const TOP = 4;
const BASE = 50; // y of the baseline; tick labels sit below it
const TICKS = [6, 12, 18].map((h) => ({ at: h * 3600, text: h === 12 ? 'noon' : h < 12 ? `${h} AM` : `${h - 12} PM` }));

interface Props {
  values: number[];
  binSeconds: number;
  time: number; // seconds since midnight
  unit: string;
  label: string;
}

export function ActivityChart({ values, binSeconds, time, unit, label }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (!values.length) return null;

  const max = Math.max(...values, 1);
  const x = (seconds: number) => (seconds / 86400) * W;
  const y = (v: number) => BASE - (v / max) * (BASE - TOP);
  const mid = (i: number) => x((i + 0.5) * binSeconds);
  const points = values.map((v, i) => `${mid(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${mid(0).toFixed(1)},${BASE} L${points.join(' L')} L${mid(values.length - 1).toFixed(1)},${BASE} Z`;

  const binAt = (seconds: number) => Math.min(values.length - 1, Math.max(0, Math.floor(seconds / binSeconds)));
  const nowBin = binAt(time);
  const peakBin = values.indexOf(max);
  const round = (v: number) => Math.round(v).toLocaleString();
  const shown = hover ?? nowBin;

  return (
    <figure className="activity">
      <p className="activity-readout">
        <span>
          {hover === null ? 'Now' : formatClock(hover * binSeconds)} <strong>{round(values[shown])}</strong> {unit}
        </span>
        <span className="muted">
          Peak {round(max)} at {formatClock(peakBin * binSeconds)}
        </span>
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}. Peak ${round(max)} ${unit} at ${formatClock(peakBin * binSeconds)}; ${round(values[nowBin])} ${unit} at ${formatClock(time)}.`}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(binAt(((e.clientX - box.left) / box.width) * 86400));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={0} x2={W} y1={BASE} y2={BASE} className="activity-base" strokeWidth={1} />
        <path d={area} className="activity-area" />
        <polyline points={points.join(' ')} className="activity-line" fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {TICKS.map((t) => (
          <text key={t.at} x={x(t.at)} y={H - 2} textAnchor="middle" className="tick">
            {t.text}
          </text>
        ))}
        {/* Playback time */}
        <line x1={x(time)} x2={x(time)} y1={TOP - 2} y2={BASE} className="activity-now" strokeWidth={2} />
        <circle cx={mid(nowBin)} cy={y(values[nowBin])} r={4} className="activity-now-dot" strokeWidth={2} />
        {hover !== null && (
          <>
            <line x1={mid(hover)} x2={mid(hover)} y1={TOP - 2} y2={BASE} className="activity-hover" strokeWidth={1} />
            <circle cx={mid(hover)} cy={y(values[hover])} r={4} className="activity-hover-dot" strokeWidth={2} />
          </>
        )}
        {/* A full-height hit area so hovering anywhere over the chart reads it. */}
        <rect x={0} y={0} width={W} height={H} fill="transparent" />
      </svg>
    </figure>
  );
}
