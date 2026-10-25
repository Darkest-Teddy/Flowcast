import type { ReactNode } from 'react';
import styles from './Policy.module.css';

export interface Clause {
  id: string;
  title: string;
  body: ReactNode;
}

/** A policy document on the Privacy & data page: title and date, a short summary, then each clause as a collapsible section. */
export function Policy({ id, title, effective, intro, summary, clauses }: {
  id: string;
  title: string;
  effective: string;
  intro?: ReactNode;
  summary: { title: string; body: string }[];
  clauses: Clause[];
}) {
  return (
    <section id={id} className={styles.terms} aria-labelledby={`${id}-title`}>
      <header className={styles.head}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>Effective {effective}</p>
      </header>
      {intro && <p className={styles.intro}>{intro}</p>}

      <ul className={styles.summary} aria-label={`${title} in short`}>
        {summary.map((s) => (
          <li key={s.title} className={styles.point}>
            <strong>{s.title}</strong>
            <span>{s.body}</span>
          </li>
        ))}
      </ul>

      <div className={styles.clauses}>
        {clauses.map((c, i) => (
          <details key={c.id} id={`${id}-${c.id}`} className={styles.clause}>
            <summary>
              <span className={styles.number}>{i + 1}</span>
              {c.title}
            </summary>
            <div className={styles.body}>{c.body}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
