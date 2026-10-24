import type { SearchMode } from '../../ui';
import { Button, ListRow, SectionList, Tag } from '../../ui';
import { answerQuestion, searchCampus, type CampusData } from './campusSearch';
import styles from './SearchResults.module.css';

/** What the Home search bar found, or Flowcast's answer in Ask mode. */
export function SearchResults({
  query,
  mode,
  data,
  onClear,
}: {
  query: string;
  mode: SearchMode;
  data: CampusData;
  onClear: () => void;
}) {
  const clear = (
    <Button variant="ghost" size="sm" onClick={onClear}>
      Clear search
    </Button>
  );

  if (mode === 'ask') {
    return (
      <div className={styles.wrap} aria-live="polite">
        <div className={styles.head}>
          <span>You asked “{query}”</span>
          {clear}
        </div>
        <p className={styles.answer}>{answerQuestion(query, data)}</p>
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
