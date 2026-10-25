import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Map as MapIcon } from 'lucide-react';
import type { AgentMessage } from '@map/askClient';
import { appendExchange } from '@map/askConversation';
import { api } from '../../data/api';
import { config } from '../../config';
import { buildPersonalSchedule } from '../../lib/personalSchedule';
import { isPersonalQuestion, routeQuestion } from '../../lib/askRouting';
import { answerMapLink, remoteAnswerPoints } from '../../lib/askMapLink';
import { Button, ListRow } from '../../ui';
import { agentAnswer, answerQuestion, type Answer, type CampusData } from './campusSearch';
import { ExampleQuestions } from './SearchResults';
import styles from './SearchResults.module.css';

interface Turn {
  id: number;
  question: string;
  at: string;
  answer?: Answer;
  source?: string;
  mapLink?: string | null;
  status: string;
}

export function AskChat({ data, visible, composer, scheduleAvailable = false }: { data: CampusData; scheduleAvailable?: boolean; visible: boolean; composer?: (ask: (question: string) => Promise<void>, pending: boolean, resetToken: number) => ReactNode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [resetToken, setResetToken] = useState(0);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const history = useRef<AgentMessage[]>([]);
  const afterDevice = useRef(false);
  const active = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    if (!visible || composer) return;
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, [visible, composer]);

  const newChat = () => {
    active.current?.abort();
    active.current = null;
    history.current = [];
    afterDevice.current = false;
    setTurns([]);
    setResetToken(token => token + 1);
    setDraft('');
    setPending(false);
    input.current?.focus();
  };

  const ask = async (question: string) => {
    question = question.trim();
    if (!question || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const id = ++nextId.current;
    const at = new Date();
    const update = (patch: Partial<Turn>) => {
      if (!controller.signal.aborted) setTurns((items) => items.map((turn) => turn.id === id ? { ...turn, ...patch } : turn));
    };
    setTurns((items) => [...items, { id, question, at: at.toISOString(), status: 'Asking…' }]);
    setDraft('');
    setPending(true);
    const homeName = data.locations.find((location) => location.id === data.homeLocationId)?.name ?? null;
    const personalSchedule = scheduleAvailable ? buildPersonalSchedule(data.schedule, at) : undefined;
    const outcome = await routeQuestion(question, (sanitized) => api.askCampus(
      sanitized, at, controller.signal, () => update({ status: 'Simulating today…' }), history.current, personalSchedule,
    ), homeName, {
      afterDevice: afterDevice.current,
      scheduleShared: !!personalSchedule,
      locationNames: data.locations.flatMap((location) => [location.name, location.short]),
    });
    if (controller.signal.aborted || active.current !== controller) return;
    if (outcome.source === 'agent') {
      history.current = appendExchange(history.current, outcome.question, outcome.answer.answer);
      afterDevice.current = false;
      update({ answer: agentAnswer(outcome.answer, outcome.question), source: personalSchedule ? 'Ask server · your schedule and campus data' : 'Ask server · campus simulation',
        mapLink: answerMapLink(config.mapUrl, remoteAnswerPoints(outcome.answer)), status: '' });
    } else if (outcome.source === 'device') {
      const privateTurn = outcome.reason !== 'failed';
      history.current = [];
      afterDevice.current = true;
      const answer: Answer = outcome.reason === 'privateFollowup'
        ? { text: 'Which building do you mean? Name the campus building in a new question. On-device answers are not shared with the Ask server.', rows: [], focus: [] }
        : !scheduleAvailable && isPersonalQuestion(question)
          ? { text: 'Your schedule could not be loaded. Try again or open Calendars.', rows: [], focus: [] }
          : answerQuestion(question, data, at);
      const source = privateTurn
        ? 'On this device · this answer stays here. Campus conversation context has been cleared.'
        : `On-device fallback · ${outcome.reason === 'failed' && outcome.error.kind === 'notConfigured' ? 'Ask server is not configured' : 'Ask server could not answer'}.`;
      update({ answer, source, status: '', mapLink: answerMapLink(config.mapUrl,
        answer.focus.flatMap((id) => data.geo.positions[id] ? [data.geo.positions[id]] : [])) });
    } else {
      update({ status: 'Cancelled. You can ask again.' });
    }
    active.current = null;
    setPending(false);
  };

  return (
    <>
    {composer?.(ask, pending, resetToken)}
    {visible && <p className={styles.note}>Ask shares your next two weeks of imported classes with the AI.</p>}
    <section hidden={!visible || (!!composer && turns.length === 0)} aria-label="Ask Flowcast conversation" className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.head}>
          <h2>Ask Flowcast</h2>
          <Button variant="ghost" size="sm" onClick={newChat}>New chat</Button>
        </div>
        {turns.length === 0 && <p className={styles.answer}>Ask about your classes or campus.</p>}
        {turns.length > 0 && <p className={styles.note}>Answers reflect when you asked and don’t refresh automatically.</p>}
        <div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
          {turns.map((turn) => (
            <article key={turn.id} className={styles.turn} aria-busy={!turn.answer && pending}>
              <h3 className={styles.question}>{turn.question}</h3>
              <p className={styles.note}>
                <time dateTime={turn.at}>{new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(turn.at))} Boston time</time>
              </p>
              <p className={styles.answer}>{turn.answer?.text ?? turn.status}</p>
              {turn.answer?.rows.map((row) => <ListRow key={row.id} title={row.title} detail={row.detail} />)}
              <div className={styles.answerFoot}>
                <div>
                  {turn.answer?.note && <p className={styles.note}>{turn.answer.note}</p>}
                  {turn.source && <p className={styles.note}>{turn.source}</p>}
                </div>
                <div className={styles.answerActions}>
                  {turn.mapLink && <Button variant="ghost" size="sm" href={turn.mapLink} icon={<MapIcon aria-hidden />}>Show on map</Button>}

                </div>
              </div>
            </article>
          ))}
        </div>
        {!composer && <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void ask(draft); }}>
          <label htmlFor="ask-followup">{turns.length ? 'Follow-up question' : 'Your question'}</label>
          <div className={styles.composerControls}>
            <input id="ask-followup" ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={300} placeholder="Ask about campus…" />
            <Button type="submit" disabled={pending || !draft.trim()}>{pending ? 'Asking…' : 'Send'}</Button>
          </div>
        </form>}
        {!pending && <ExampleQuestions onAsk={(question) => { void ask(question); }} />}
      </div>
    </section>
    </>
  );
}
