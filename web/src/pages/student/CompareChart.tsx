import { crowdFor } from '@theme/tokens';
import { formatHour, formatPercent } from '../../lib/format';
import styles from './CompareChart.module.css';

export interface CompareHour {
  hour: number;
  baseline: number; // share of capacity without events
  withEvents: number; // share with the date's events
}

/** Two bars per hour: a grey "without events" bar behind a crowd-coloured "with events" bar. Every hour has its numbers in words. */
export function CompareChart({ hours, label, eventHours }: { hours: CompareHour[]; label: string; eventHours: Set<number> }) {
  const height = (share: number) => `${Math.max(2, Math.min(100, share * 100))}%`;
  return (
    <figure className={styles.chart}>
      <ol className={styles.bars} aria-label={label}>
        {hours.map((h) => {
          const level = crowdFor(h.withEvents);
          const text = `${formatHour(h.hour)}: ${formatPercent(h.baseline)} without events, ${formatPercent(h.withEvents)} ${level.label} with events`;
          return (
            <li key={h.hour} className={`${styles.bar} ${eventHours.has(h.hour) ? styles.during : ''}`} title={text}>
              <span className={styles.baseline} style={{ height: height(h.baseline) }} aria-hidden />
              <span className={styles.events} style={{ height: height(h.withEvents), background: level.color }} aria-hidden />
              <span className="visually-hidden">{eventHours.has(h.hour) ? `During an event. ${text}` : text}</span>
            </li>
          );
        })}
      </ol>
      <div className={styles.axis} aria-hidden>
        {hours.map((h, i) => <span key={h.hour}>{i % 3 === 0 ? formatHour(h.hour) : ''}</span>)}
      </div>
      <figcaption className={styles.legend}>
        <span><i className={styles.keyBaseline} aria-hidden /> Without events</span>
        <span><i className={styles.keyEvents} aria-hidden /> With events (colour shows crowd level)</span>
        <span><i className={styles.keyDuring} aria-hidden /> Event hours</span>
      </figcaption>
    </figure>
  );
}
