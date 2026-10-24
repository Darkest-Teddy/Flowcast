import type { ReactNode } from 'react';
import { formatTime } from '../../lib/format';
import styles from './AgendaRow.module.css';

/** One timed row on Schedule and Events: time, what, where, and tags or actions on the right. */
export function AgendaRow({
  start,
  end,
  title,
  meta,
  note,
  aside,
}: {
  start: string;
  end?: string;
  title: ReactNode;
  meta?: ReactNode;
  note?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.time}>
        <time dateTime={start}>{formatTime(start)}</time>
        {end && (
          <>
            <span className="visually-hidden"> to </span>
            <time dateTime={end} className={styles.end}>{formatTime(end)}</time>
          </>
        )}
      </div>
      <div className={styles.main}>
        <div className={styles.title}>{title}</div>
        {meta && <div className={styles.meta}>{meta}</div>}
        {note && <p className={styles.note}>{note}</p>}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
    </div>
  );
}
