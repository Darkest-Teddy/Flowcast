import type { CSSProperties } from 'react';
import { crowdFor } from '@theme/tokens';
import { formatHour, formatPercent } from '../../lib/format';
import styles from './CompareChart.module.css';

export interface CompareHour {
  hour: number;
  baseline: number; // share of capacity without events
  withEvents: number; // share with the date's events
}

/**
 * Two marks per hour: a pale "without events" column behind a crowd-coloured "with events" bar,
 * on the same axis. Event hours get a dot under the baseline. Hover or focus an hour for both
 * figures; every hour also has its numbers in words for screen readers.
 */
export function CompareChart({ hours, label, eventHours }: { hours: CompareHour[]; label: string; eventHours: Set<number> }) {
  const height = (share: number) => `${Math.max(2, Math.min(100, share * 100))}%`;
  const n = Math.max(1, hours.length);
  return (
    <figure className={styles.chart} style={{ '--n': n } as CSSProperties}>
      <div className={styles.plot}>
        <div className={styles.grid} aria-hidden>
          {[1, 0.5].map((g) => <span key={g} style={{ bottom: `${g * 100}%` }}><em>{formatPercent(g)}</em></span>)}
        </div>
        <ol className={styles.bars} aria-label={label}>
          {hours.map((h, i) => {
            const level = crowdFor(h.withEvents);
            const during = eventHours.has(h.hour);
            const diff = Math.round((h.withEvents - h.baseline) * 100);
            const text = `${formatHour(h.hour)}: ${formatPercent(h.baseline)} without events, ${formatPercent(h.withEvents)} ${level.label} with events`;
            const edge = i < n / 4 ? styles.left : i >= (n * 3) / 4 ? styles.right : '';
            return (
              <li key={h.hour} className={`${styles.col} ${during ? styles.during : ''}`} tabIndex={0}
                aria-label={during ? `During an event. ${text}` : text}
                style={{ '--c': level.color, '--bar': i } as CSSProperties}>
                <span className={styles.baseline} style={{ height: height(h.baseline) }} aria-hidden />
                <span className={styles.events} style={{ height: height(h.withEvents) }} aria-hidden />
                <span className={`${styles.tip} ${edge}`} aria-hidden>
                  <span className={styles.tipHead}>{formatHour(h.hour)}{during && ' · event'}</span>
                  <span className={styles.tipRow}><i style={{ background: level.color }} /><strong>{formatPercent(h.withEvents)}</strong> with events</span>
                  <span className={styles.tipRow}><i className={styles.tipBase} /><strong>{formatPercent(h.baseline)}</strong> without</span>
                  {diff !== 0 && <span className={styles.tipDiff}>{diff > 0 ? '+' : '−'}{Math.abs(diff)} pts</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className={styles.axis} aria-hidden>
        {hours.map((h, i) => <span key={h.hour}>{i % 3 === 0 ? formatHour(h.hour) : ''}</span>)}
      </div>
      <figcaption className={styles.legend}>
        <span><i className={styles.keyEvents} aria-hidden /> With events (colour shows crowd level)</span>
        <span><i className={styles.keyBaseline} aria-hidden /> Without events</span>
        <span><i className={styles.keyDuring} aria-hidden /> Event hours</span>
      </figcaption>
    </figure>
  );
}
