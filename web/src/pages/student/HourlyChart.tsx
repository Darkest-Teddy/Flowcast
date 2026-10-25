import type { CSSProperties } from 'react';
import { crowdFor } from '@theme/tokens';
import { formatHour, formatPercent } from '../../lib/format';
import styles from './HourlyChart.module.css';

const bostonHourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const bostonHour = () => Number(bostonHourFormat.format(new Date()));

/** Gridlines at half and full capacity: the two shares worth reading off the chart. */
const GRID = [1, 0.5];

/**
 * One column per hour, coloured by crowd level. Hovering or focusing a column dims the others and
 * shows its hour, share and level; the busiest hour carries its value, and "Now" is a hairline.
 * Every column also says its number and word to screen readers, so nothing depends on hover.
 */
export function HourlyChart({
  hours,
  label,
  tall = false,
}: {
  hours: { hour: number; share: number }[];
  label: string;
  tall?: boolean;
}) {
  // Forecast hours are Boston hours, so "Now" is Boston's hour wherever the reader is.
  const nowHour = bostonHour();
  const peak = hours.length ? hours.reduce((a, b) => (b.share > a.share ? b : a)) : null;
  const n = Math.max(1, hours.length);
  return (
    <figure className={`${styles.chart} ${tall ? styles.tall : ''}`} style={{ '--n': n } as CSSProperties}>
      <div className={styles.plot}>
        <div className={styles.grid} aria-hidden>
          {GRID.map((g) => (
            <span key={g} style={{ bottom: `${g * 100}%` }}><em>{formatPercent(g)}</em></span>
          ))}
        </div>
        <ol className={styles.bars} aria-label={label}>
          {hours.map((h, i) => {
            const level = crowdFor(h.share);
            const isNow = h.hour === nowHour;
            const height = `${Math.max(2, Math.min(100, h.share * 100))}%`;
            const text = `${formatHour(h.hour)}, ${formatPercent(h.share)} ${level.label}`;
            // Tooltips near the edges open inwards so they never leave the card.
            const edge = i < n / 4 ? styles.left : i >= (n * 3) / 4 ? styles.right : '';
            return (
              <li
                key={h.hour}
                className={`${styles.col} ${isNow ? styles.now : ''}`}
                tabIndex={0}
                aria-label={isNow ? `Now, ${text}` : text}
                style={{ '--c': level.color, '--bar': i } as CSSProperties}
              >
                <span className={styles.fill} style={{ height }} aria-hidden />
                {h === peak && h.share > 0 && <b className={styles.peak} style={{ bottom: height }} aria-hidden>{formatPercent(h.share)}</b>}
                {isNow && <span className={styles.nowTag} aria-hidden>Now</span>}
                <span className={`${styles.tip} ${edge}`} aria-hidden>
                  <strong>{formatPercent(h.share)}</strong>
                  <span><i style={{ background: level.color }} />{level.label} · {formatHour(h.hour)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className={styles.axis} aria-hidden>
        {hours.map((h, i) => (
          <span key={h.hour}>{i % 3 === 0 ? formatHour(h.hour) : ''}</span>
        ))}
      </div>
    </figure>
  );
}
