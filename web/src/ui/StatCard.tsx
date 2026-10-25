import styles from './StatCard.module.css';

/** A labelled number with a tiny bar series underneath (Trov's Activity cards). */
export function StatCard({
  label,
  value,
  detail,
  series,
  axis,
  highlightIndex,
}: {
  label: string;
  value: string;
  detail?: string;
  series?: number[];
  axis?: [string, string];
  highlightIndex?: number;
}) {
  const max = Math.max(1, ...(series ?? []));
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {detail && <div className={styles.detail}>{detail}</div>}
      {series && (
        <div className={styles.chart}>
          <div className={styles.bars} aria-hidden>
            {series.map((v, i) => (
              <i key={i} className={i === highlightIndex ? styles.on : undefined} style={{ height: `${Math.max(6, (v / max) * 100)}%`, ['--bar' as string]: i }} />
            ))}
          </div>
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
