import { useEffect, useId, useRef } from 'react';
import type { DataSource } from '../../../data/types';
import { Button, HealthBadge } from '../../../ui';
import styles from './SourceDetail.module.css';

export function SourceDetail({ source, onClose }: { source: DataSource; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => { panel.current?.focus(); }, [source.id]);

  return (
    <section ref={panel} tabIndex={-1} className={styles.panel} aria-labelledby={titleId} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <header className={styles.head}>
        <div>
          <h3 id={titleId} className={styles.title}>{source.name}</h3>
          <p className={styles.sub}><HealthBadge health={source.health} text={source.statusText} /></p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      <p className={styles.none}>Read-only source information. Configuration and connection testing are unavailable.</p>
      {source.settings.length > 0 && (
        <dl className={styles.fields}>
          {source.settings.map((setting) => (
            <div key={setting.key}>
              <dt>{setting.label}</dt>
              <dd>{setting.secret ? 'Secret values are not displayed' : setting.value || 'Not reported'}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
