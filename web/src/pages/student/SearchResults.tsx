import { Button, ListRow, SectionList, Tag } from '../../ui';
import { EXAMPLE_QUESTIONS, searchCampus, type CampusData } from './campusSearch';
import styles from './SearchResults.module.css';

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

/** Campus search results; the Ask conversation stays mounted separately. */
export function SearchResults({
  query,
  data,
  onClear,
}: {
  query: string;
  data: CampusData;
  onClear: () => void;
}) {
  const clear = (
    <Button variant="ghost" size="sm" onClick={onClear}>
      Clear search
    </Button>
  );

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
