import { crowdFor } from '@theme/tokens';
import { formatHour, formatPercent } from '../../lib/format';
import styles from './HourlyChart.module.css';

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
  const nowHour = new Date().getHours();
  return (
    <div className={`${styles.chart} ${tall ? styles.tall : ''}`}>
      <ol className={styles.bars} aria-label={label}>
        {hours.map((h) => {
          const level = crowdFor(h.share);
          const text = `${formatHour(h.hour)}, ${formatPercent(h.share)} ${level.label}`;
          return (
            <li key={h.hour} className={`${styles.bar} ${h.hour === nowHour ? styles.now : ''}`} title={text}>
              <span
                className={styles.fill}
                style={{ height: `${Math.max(3, Math.min(100, h.share * 100))}%`, background: level.color }}
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
