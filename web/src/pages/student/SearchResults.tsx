import { Map as MapIcon } from 'lucide-react';
import { api, useResource } from '../../data/api';
import { config } from '../../config';
import { answerMapLink } from '../../lib/askMapLink';
import { FLOOR_NOTE } from '../../lib/classFinder';
import { Button, ListRow, SectionList, Tag } from '../../ui';
import { EXAMPLE_QUESTIONS, searchCampus, searchClasses, type CampusData } from './campusSearch';
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
  // The published class schedule is loaded here (once per page load), so class codes and titles
  // ("CS 112", "intro to CS") find where a course meets: building and floor.
  const classes = useResource(api.getClassFinder);
  const clear = (
    <Button variant="ghost" size="sm" onClick={onClear}>
      Clear search
    </Button>
  );

  const classResults = searchClasses(query, { ...data, classes: data.classes ?? classes.data });
  const results = searchCampus(query, data);
  const mapLink = (locationId: string) => {
    const point = data.geo.positions[locationId];
    return point ? answerMapLink(config.mapUrl, [point]) : null;
  };
  return (
    <div className={styles.wrap} aria-live="polite">
      {classResults && (
        <SectionList title={`Classes matching “${query}”`} count={classResults.results.length + classResults.moreSections}>
          {classResults.results.map((r) => {
            const link = r.locationId ? mapLink(r.locationId) : null;
            return (
              <ListRow key={r.id} leading={<Tag>{r.kind}</Tag>} title={r.title} subtitle={r.detail}
                trailing={link && <Button variant="ghost" size="sm" href={link} icon={<MapIcon aria-hidden />}>Show on map</Button>} />
            );
          })}
        </SectionList>
      )}
      {classResults && (
        <p className={styles.note}>
          {classResults.moreSections > 0 && `${classResults.moreSections} more ${classResults.moreSections === 1 ? 'section' : 'sections'} not shown; add a section like “A1” to narrow it. `}
          {FLOOR_NOTE}
        </p>
      )}
      <SectionList
        title={`Results for “${query}”`}
        count={results.length}
        empty={classResults ? 'No places, events or clubs match.' : `Nothing on campus matches “${query}”. Try a building, a class code like CS 112, an event or a club.`}
      >
        {results.slice(0, 8).map((r) => (
          <ListRow key={r.id} to={r.to} leading={<Tag>{r.kind}</Tag>} title={r.title} detail={r.detail} />
        ))}
      </SectionList>
      {classes.error && !classResults && <p className={styles.note}>Class search is unavailable: {classes.error.message}</p>}
      <div className={styles.foot}>{clear}</div>
    </div>
  );
}
