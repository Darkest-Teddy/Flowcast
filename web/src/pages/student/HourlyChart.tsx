import { crowdFor } from '@theme/tokens';
import { formatHour, formatPercent } from '../../lib/format';
import styles from './HourlyChart.module.css';

const bostonHourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const bostonHour = () => Number(bostonHourFormat.format(new Date()));

/** One bar per hour, coloured by crowd level. Each bar carries its number and word for screen readers and on hover. */
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
  return (
    <div className={`${styles.chart} ${tall ? styles.tall : ''}`}>
      <ol className={styles.bars} aria-label={label}>
        {hours.map((h, i) => {
          const level = crowdFor(h.share);
          const text = `${formatHour(h.hour)}, ${formatPercent(h.share)} ${level.label}`;
          return (
            <li key={h.hour} className={`${styles.bar} ${h.hour === nowHour ? styles.now : ''}`} title={text}>
              <span
                className={styles.fill}
                style={{ height: `${Math.max(3, Math.min(100, h.share * 100))}%`, background: level.color, ['--bar' as string]: i }}
                aria-hidden
              />
              <span className="visually-hidden">{h.hour === nowHour ? `Now, ${text}` : text}</span>
            </li>
          );
        })}
      </ol>
      <div className={styles.axis} aria-hidden>
        {hours.map((h, i) => (
          <span key={h.hour}>{h.hour === nowHour ? 'Now' : i % 3 === 0 ? formatHour(h.hour) : ''}</span>
        ))}
      </div>
    </div>
  );
}
