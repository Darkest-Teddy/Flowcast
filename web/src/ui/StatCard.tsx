import { useId, useState, type PointerEvent } from 'react';
import styles from './StatCard.module.css';

/** A labelled number with an optional sparkline underneath. */
export function StatCard({
  label,
  value,
  detail,
  series,
  axis,
  highlightIndex,
  format,
}: {
  label: string;
  value: string;
  detail?: string;
  series?: number[];
  axis?: [string, string];
  highlightIndex?: number;
  /** Readout for the hovered point, e.g. "4 PM · 62%". Without it the sparkline has no hover. */
  format?: (value: number, index: number) => string;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {detail && <div className={styles.detail}>{detail}</div>}
      {series && series.length > 1 && (
        <div className={styles.chart}>
          <Sparkline series={series} highlightIndex={highlightIndex} format={format} />
          {axis && (
            <div className={styles.axis} aria-hidden>
              <span>{axis[0]}</span>
              <span>{axis[1]}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Points as 0–100 x, 0–100 y (y down), the max at the top with a little headroom. */
function points(series: number[]) {
  const max = Math.max(...series, 0) || 1;
  return series.map((v, i) => ({ x: (i / (series.length - 1)) * 100, y: 100 - (v / max) * 88 }));
}

/** A smooth path through the points: each segment a cubic with handles a third of the way along. */
function smooth(p: { x: number; y: number }[]) {
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] ?? p[i];
    const b = p[i];
    const c = p[i + 1];
    const e = p[i + 2] ?? c;
    const c1 = { x: b.x + (c.x - a.x) / 6, y: b.y + (c.y - a.y) / 6 };
    const c2 = { x: c.x - (e.x - b.x) / 6, y: c.y - (e.y - b.y) / 6 };
    d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${c.x} ${c.y}`;
  }
  return d;
}

/**
 * The trend: a 2px line over a 10% wash of the accent, the highlighted point as a ringed dot. On
 * hover a hairline crosshair snaps to the nearest point and reads it out. The SVG stretches to the
 * card, so the dots are HTML, positioned in percent, to stay round.
 */
function Sparkline({ series, highlightIndex, format }: { series: number[]; highlightIndex?: number; format?: StatCardFormat }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const p = points(series);
  const line = smooth(p);
  const hi = highlightIndex !== undefined ? p[highlightIndex] : undefined;
  const at = hover !== null ? p[hover] : undefined;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * 100;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round((x / 100) * (series.length - 1)))));
  };

  return (
    <div className={styles.spark} onPointerMove={format ? onMove : undefined} onPointerLeave={() => setHover(null)} aria-hidden>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`${id}-wash`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L 100 100 L 0 100 Z`} fill={`url(#${id}-wash)`} />
        <path d={line} className={styles.line} />
      </svg>
      {hi && hover === null && <i className={styles.dot} style={{ left: `${hi.x}%`, top: `${hi.y}%` }} />}
      {at && format && hover !== null && (
        <>
          <span className={styles.cross} style={{ left: `${at.x}%` }} />
          <i className={`${styles.dot} ${styles.live}`} style={{ left: `${at.x}%`, top: `${at.y}%` }} />
          <span className={`${styles.readout} ${at.x > 60 ? styles.readoutLeft : ''}`} style={{ left: `${at.x}%` }}>
            {format(series[hover], hover)}
          </span>
        </>
      )}
    </div>
  );
}

type StatCardFormat = (value: number, index: number) => string;
