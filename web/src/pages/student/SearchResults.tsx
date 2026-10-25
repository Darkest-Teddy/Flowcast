import { EXAMPLE_QUESTIONS } from './campusSearch';
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
