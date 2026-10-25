import { useEffect, useState, type ReactNode } from 'react';
import { Map as MapIcon, MessagesSquare } from 'lucide-react';
import { crowdFor } from '@theme/tokens';
import { config } from '../../config';
import type { CampusGeo } from '../../data/types';
import type { SearchMode } from '../../ui';
import { Button, ListRow, SectionList, Tag } from '../../ui';
import { api } from '../../data/api';
import { isPersonalQuestion, routeQuestion, type AskOutcome } from '../../lib/askRouting';
import type { AgentAnswer, AgentError } from '@map/askClient';
import { agentAnswer, answerQuestion, EXAMPLE_QUESTIONS, searchCampus, type Answer, type CampusData } from './campusSearch';
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

  if (mode === 'ask') return <AskAnswer query={query} data={data} clear={clear} onAsk={onAsk} />;

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

/** Why an Ask answer came from this device, in plain words. */
function deviceNote(outcome: AskOutcome<AgentAnswer, AgentError>): string {
  if (outcome.source !== 'device') return '';
  if (outcome.reason === 'personal') return 'Answered on this device from your schedule. Your schedule isn’t sent anywhere.';
  const why: Partial<Record<AgentError['kind'], string>> = {
    notConfigured: 'the Ask server isn’t set up',
    rateLimited: 'too many questions to the Ask server just now',
    timeout: 'the Ask server took too long',
    warming: 'the Ask server is still simulating today',
  };
  return `Answered on this device: ${why[outcome.error.kind] ?? 'the Ask server isn’t reachable'}.`;
}

/**
 * Ask mode. Personal questions are answered here from the person's schedule; campus questions go to
 * the Ask server's agent, falling back to this device's sample forecasts with a label when it fails.
 */
function AskAnswer({ query, data, clear, onAsk }: { query: string; data: CampusData; clear: ReactNode; onAsk: (question: string) => void }) {
  const personal = isPersonalQuestion(query);
  const [state, setState] = useState<{ query: string; outcome: AskOutcome<AgentAnswer, AgentError> | null; status: string }>({ query, outcome: null, status: 'Asking…' });

  useEffect(() => {
    if (personal) return;
    const controller = new AbortController();
    setState({ query, outcome: null, status: 'Asking…' });
    // Started a tick later, so a mount that is immediately undone (React dev mode) sends nothing.
    const start = setTimeout(() => {
      routeQuestion(query, (q) => api.askCampus(q, new Date(), controller.signal, () => {
        if (!controller.signal.aborted) setState({ query, outcome: null, status: 'Simulating today…' });
      })).then((outcome) => {
        if (!controller.signal.aborted && outcome.source !== 'cancelled') setState({ query, outcome, status: '' });
      });
    }, 0);
    return () => {
      clearTimeout(start);
      controller.abort();
    };
  }, [query, personal]);

  const outcome: AskOutcome<AgentAnswer, AgentError> | null = personal ? { source: 'device', reason: 'personal' } : state.query === query ? state.outcome : null;
  const answer: Answer | null = !outcome
    ? null
    : outcome.source === 'agent'
      ? agentAnswer(outcome.answer, query)
      : { ...answerQuestion(query, data), device: deviceNote(outcome) };
  const mapLink = answer ? mapLinkFor(answer.focus, data.geo, answer.mapQuestion) : null;

  return (
    <div className={styles.wrap} aria-live="polite" aria-busy={!answer}>
      <div className={styles.head}>
        <span>You asked “{query}”</span>
        {clear}
      </div>
      {!answer ? (
        <p className={styles.answer}>{state.status || 'Asking…'}</p>
      ) : (
        <>
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
            <div>
              {answer.note && <p className={styles.note}>{answer.note}</p>}
              {answer.device && <p className={styles.note}>{answer.device}</p>}
            </div>
            <div className={styles.answerActions}>
              {mapLink && (
                <Button variant="ghost" size="sm" href={mapLink} icon={<MapIcon aria-hidden />}>
                  Show on map
                </Button>
              )}
              <Button variant="ghost" size="sm" to={`/ask?q=${encodeURIComponent(query)}`} icon={<MessagesSquare aria-hidden />}>
                Continue in chat
              </Button>
            </div>
          </div>
        </>
      )}
      <ExampleQuestions onAsk={onAsk} />
    </div>
  );
}
