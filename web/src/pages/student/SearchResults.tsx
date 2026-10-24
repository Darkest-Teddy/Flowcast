import { Map as MapIcon } from 'lucide-react';
import { crowdFor } from '@theme/tokens';
import { config } from '../../config';
import type { CampusGeo } from '../../data/types';
import type { SearchMode } from '../../ui';
import { Button, ListRow, SectionList, Tag } from '../../ui';
import { answerQuestion, EXAMPLE_QUESTIONS, searchCampus, type CampusData } from './campusSearch';
import styles from './SearchResults.module.css';

/**
 * A /map link for an answer. With a map question, the map opens its Ask tab, answers it from the
 * simulation and draws the walk; otherwise it opens centred on the places. Null when nothing has a position.
 */
export function mapLinkFor(ids: string[], geo: CampusGeo, question?: string): string | null {
  if (question) return `${config.mapUrl}?ask=${encodeURIComponent(question)}&spin=0`;
  const points = ids.map((id) => geo.positions[id]).filter((p): p is [number, number] => Boolean(p));
  if (!points.length) return null;
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
  const zoom = span < 0.002 ? 17.6 : span < 0.006 ? 16.6 : 15.8;
  const lng = ((Math.min(...lngs) + Math.max(...lngs)) / 2).toFixed(5);
  const lat = ((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5);
  return `${config.mapUrl}?lng=${lng}&lat=${lat}&zoom=${zoom}`;
}

/** Questions to try in Ask mode; clicking one asks it. */
export function ExampleQuestions({ onAsk }: { onAsk: (question: string) => void }) {
  return (
    <div className={styles.examples}>
      <span>Try asking</span>
      {EXAMPLE_QUESTIONS.map((q) => (
        <button key={q} type="button" className={styles.example} onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}

/** What the Home search bar found, or Flowcast's answer in Ask mode. */
export function SearchResults({
  query,
  mode,
  data,
  onClear,
  onAsk,
}: {
  query: string;
  mode: SearchMode;
  data: CampusData;
  onClear: () => void;
  onAsk: (question: string) => void;
}) {
  const clear = (
    <Button variant="ghost" size="sm" onClick={onClear}>
      Clear search
    </Button>
  );

  if (mode === 'ask') {
    const answer = answerQuestion(query, data);
    const mapLink = mapLinkFor(answer.focus, data.geo, answer.mapQuestion);
    return (
      <div className={styles.wrap} aria-live="polite">
        <div className={styles.head}>
          <span>You asked “{query}”</span>
          {clear}
        </div>
        <p className={styles.answer}>{answer.text}</p>
        {answer.rows.length > 0 && (
          <div className={styles.rows}>
            {answer.rows.map((r) => (
              <ListRow
                key={r.id}
                leading={
                  r.share !== undefined ? (
                    <i className={styles.crowdDot} style={{ background: r.share === null ? 'var(--color-off)' : crowdFor(r.share).color }} aria-hidden />
                  ) : undefined
                }
                title={r.title}
                detail={r.detail}
              />
            ))}
          </div>
        )}
        <div className={styles.answerFoot}>
          {answer.note && <p className={styles.note}>{answer.note}</p>}
          {mapLink && (
            <Button variant="ghost" size="sm" href={mapLink} icon={<MapIcon aria-hidden />}>
              Show on map
            </Button>
          )}
        </div>
        <ExampleQuestions onAsk={onAsk} />
      </div>
    );
  }

  const results = searchCampus(query, data);
  return (
    <div className={styles.wrap} aria-live="polite">
      <SectionList
        title={`Results for “${query}”`}
        count={results.length}
        empty={`Nothing on campus matches “${query}”. Try a building, a class, an event or a club.`}
      >
        {results.slice(0, 8).map((r) => (
          <ListRow key={r.id} to={r.to} leading={<Tag>{r.kind}</Tag>} title={r.title} detail={r.detail} />
        ))}
      </SectionList>
      <div className={styles.foot}>{clear}</div>
    </div>
  );
}
