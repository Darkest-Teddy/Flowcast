import { useId, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { DataDomain } from '@map/chatContract';
import type { DirectoryResult } from '../../lib/chatParse';
import { Button } from '../../ui';
import { QuestionChips } from './Chat';
import { ProvenanceBadge } from './Visuals';
import styles from './Directory.module.css';

/** How to start the Ask server, for when nothing answers. */
export function StartServerHint() {
  return (
    <p className={styles.hint}>
      Start it from the repository with <code>cd server &amp;&amp; npm start</code>, then reload this page.
    </p>
  );
}

function DomainEntry({ domain, onAsk, busy }: { domain: DataDomain; onAsk: (q: string) => void; busy: boolean }) {
  return (
    <li className={styles.domain}>
      <h3 className={styles.domainTitle}>{domain.title}</h3>
      {domain.description && <p className={styles.description}>{domain.description}</p>}
      {domain.datasets.length > 0 && (
        <ul className={styles.datasets} aria-label={`${domain.title} datasets`}>
          {domain.datasets.map((d) => (
            <li key={d.name} className={styles.dataset}>
              <span className={styles.datasetHead}>
                <span className={styles.datasetName}>{d.name}</span>
                <ProvenanceBadge kind={d.kind} />
              </span>
              {(d.period || d.coverage || d.url) && (
                <span className={styles.datasetMeta}>
                  {[d.period, d.coverage].filter(Boolean).join(' · ')}
                  {d.url && (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className={styles.source}>
                      Source
                      <ExternalLink aria-hidden />
                      <span className="visually-hidden"> for {d.name} (opens in a new tab)</span>
                    </a>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <QuestionChips questions={domain.examples} onAsk={onAsk} label={`Example questions about ${domain.title}`} disabled={busy} />
    </li>
  );
}

/**
 * What the chat knows: every data domain, its datasets with provenance, and example questions.
 * A side column on wide screens; a collapsible section on narrow ones.
 */
export function Directory({ result, loading, onAsk, onReload, busy }: { result: DirectoryResult | null; loading: boolean; onAsk: (q: string) => void; onReload: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const count = result?.ok ? result.value.domains.length : null;

  return (
    <section className={styles.directory} aria-labelledby={`${bodyId}-title`}>
      <div className={styles.head}>
        <h2 id={`${bodyId}-title`} className={styles.title}>
          What Flowcast knows
        </h2>
        <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : `Show${count ? ` ${count} topics` : ''}`}
          <ChevronDown aria-hidden className={open ? styles.flip : undefined} />
        </button>
      </div>
      <div id={bodyId} className={`${styles.body} ${open ? styles.open : ''}`}>
        {loading && !result && <p className={styles.hint} role="status">Loading the directory…</p>}
        {result && !result.ok && (
          <div className={styles.notice}>
            <p>
              {result.error.kind === 'unreachable'
                ? 'The Ask server isn’t running, so the directory of data can’t load.'
                : result.error.message}
            </p>
            {result.error.kind === 'unreachable' && <StartServerHint />}
            <Button variant="secondary" size="sm" onClick={onReload}>
              Try again
            </Button>
          </div>
        )}
        {result?.ok && (
          <>
            <p className={styles.hint}>Every answer draws on these. Tap a question to ask it.</p>
            <ul className={styles.domains}>
              {result.value.domains.map((d) => (
                <DomainEntry key={d.id} domain={d} onAsk={onAsk} busy={busy} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
