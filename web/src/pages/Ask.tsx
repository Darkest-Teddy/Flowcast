import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Eraser } from 'lucide-react';
import { useSession } from '../auth/session';
import { api } from '../data/api';
import { bostonClock, isPersonalQuestion } from '../lib/askRouting';
import { plainText } from '../lib/chatMarkdown';
import {
  buildChatRequest,
  clockText,
  restoreConversation,
  serializeConversation,
  STORAGE_KEY,
  weekdayOfDate,
  type ChatContext,
  type ChatMessage,
} from '../lib/chatHistory';
import { parseChatBody, type ChatError, type DirectoryResult } from '../lib/chatParse';
import { config } from '../config';
import { Button, Page, PageHeader } from '../ui';
import { Composer, ContextControls, MessageItem, PendingItem, QuestionChips } from './ask/Chat';
import { Directory, StartServerHint } from './ask/Directory';
import { answerQuestion, type CampusData } from './student/campusSearch';
import styles from './Ask.module.css';

const parseStored = (body: unknown) => parseChatBody(body, config.mapUrl);

function loadStored(): ChatMessage[] {
  try {
    return restoreConversation(window.sessionStorage.getItem(STORAGE_KEY), parseStored);
  } catch {
    return [];
  }
}

function store(messages: ChatMessage[]) {
  try {
    if (messages.length) window.sessionStorage.setItem(STORAGE_KEY, serializeConversation(messages));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked or full: the conversation just won't survive a reload.
  }
}

function nowContext(campus: ChatContext['campus'] = 'charles-river'): ChatContext {
  const { weekday, time } = bostonClock(new Date());
  return { weekday, time: clockText(time), campus, date: null };
}

let nextId = 0;
const newId = () => `m${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Questions to start with when the directory can't load. */
const FALLBACK_EXAMPLES = ['Least crowded library right now', 'Quietest dining hall at 6 PM', 'When is GSU quiet?', 'Where is my next class?'];

const DEVICE_NOTE = 'Calculated from your schedule, without sending it to AI.';

function errorAnnouncement(error: ChatError): string {
  if (error.kind === 'notConfigured') return 'Answers need the Ask server’s OpenAI key.';
  if (error.kind === 'network') return 'Couldn’t reach the Ask server.';
  if (error.kind === 'aborted') return 'Stopped.';
  return error.message;
}

export default function Ask() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();

  const [messages, setMessages] = useState<ChatMessage[]>(loadStored);
  const [context, setContext] = useState<ChatContext>(() => nowContext());
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [directory, setDirectory] = useState<DirectoryResult | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(true);

  // Refs so send() always sees the latest values, whoever calls it (chips, Home's ?q=, retry).
  const messagesRef = useRef(messages);
  const contextRef = useRef(context);
  const pendingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTo = useRef<string | null>(null);
  contextRef.current = context;

  const commit = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    store(next);
  }, []);

  const loadDirectory = useCallback(() => {
    setDirectoryLoading(true);
    api.chatDirectory().then(setDirectory).finally(() => setDirectoryLoading(false));
  }, []);

  useEffect(loadDirectory, [loadDirectory]);

  // Bring the newest message into view after sending or answering (not when a stored conversation loads).
  useEffect(() => {
    const id = scrollTo.current;
    if (!id) return;
    scrollTo.current = null;
    const el = listRef.current?.querySelector(`[data-message-id="${id}"]`);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [messages, pending]);

  const finish = useCallback((message: ChatMessage, announce: string) => {
    commit([...messagesRef.current, message]);
    scrollTo.current = message.id;
    pendingRef.current = false;
    setPending(null);
    setAnnouncement(announce);
  }, [commit]);

  const send = useCallback(async (question: string) => {
    const q = question.trim().slice(0, 300);
    if (!q || pendingRef.current) return;
    pendingRef.current = true;
    const before = messagesRef.current;
    const user: ChatMessage = { id: newId(), role: 'user', text: q };
    commit([...before, user]);
    scrollTo.current = user.id;
    setDraft('');

    // Personal questions never leave the device (lib/askRouting): answered here from the schedule.
    if (isPersonalQuestion(q)) {
      setPending('Checking your schedule on this device…');
      setAnnouncement('Checking your schedule on this device.');
      try {
        const [locations, schedule, hourly, places, geo, events, clubs] = await Promise.all([
          api.getLocations(), api.getSchedule(), api.getHourlyForecasts(), api.getPlaceForecasts(), api.getCampusGeo(),
          api.getCampusEvents().catch(() => []), api.getClubs(),
        ]);
        const data: CampusData = { locations, schedule, hourly, places, geo, events, clubs, homeLocationId: session?.user.homeLocationId ?? null };
        const answer = answerQuestion(q, data);
        if (!messagesRef.current.some((m) => m.id === user.id)) return;
        finish(
          { id: newId(), role: 'assistant', status: 'device', text: answer.text, rows: answer.rows, note: [answer.note, DEVICE_NOTE].filter(Boolean).join(' ') },
          `Answered on this device. ${answer.text}`,
        );
      } catch {
        if (!messagesRef.current.some((m) => m.id === user.id)) return;
        const text = 'Your schedule could not be loaded. Try again or open Calendars.';
        finish({ id: newId(), role: 'assistant', status: 'device', text, rows: [], note: '' }, text);
      }
      return;
    }

    const ctrl = new AbortController();
    controller.current = ctrl;
    setPending('Thinking…');
    setAnnouncement('Thinking.');
    const request = buildChatRequest(before, q, contextRef.current);
    const result = await api.chat(request, ctrl.signal, (sec) => {
      if (ctrl.signal.aborted) return;
      setPending(`Warming up the simulation… asking again in ${sec} s`);
      setAnnouncement('Warming up the simulation. Asking again shortly.');
    });
    if (controller.current === ctrl) controller.current = null;
    // Cleared while it was on its way: drop the answer.
    if (!messagesRef.current.some((m) => m.id === user.id)) return;
    if (result.ok) {
      const r = result.value;
      const extras = r.visuals.length ? ` ${r.visuals.length} ${r.visuals.length === 1 ? 'visual' : 'visuals'} below.` : '';
      finish({ id: newId(), role: 'assistant', status: 'answer', response: r }, `Flowcast answered. ${plainText(r.answer).slice(0, 500)}${extras}`);
    } else {
      finish({ id: newId(), role: 'assistant', status: 'error', error: result.error, question: q }, errorAnnouncement(result.error));
    }
  }, [commit, finish, session]);

  const stop = () => controller.current?.abort();

  const clear = () => {
    controller.current?.abort();
    controller.current = null;
    pendingRef.current = false;
    setPending(null);
    commit([]);
    setAnnouncement('Conversation cleared.');
    textareaRef.current?.focus();
  };

  /** Ask a failed question again: the failed pair goes, and the question is sent fresh. */
  const retry = (errorId: string) => {
    const list = messagesRef.current;
    const at = list.findIndex((m) => m.id === errorId);
    const failed = list[at];
    if (!failed || failed.role !== 'assistant' || failed.status !== 'error') return;
    const prev = list[at - 1];
    const drop = prev?.role === 'user' && prev.text === failed.question ? at - 1 : at;
    commit([...list.slice(0, drop), ...list.slice(at + 1)]);
    void send(failed.question);
  };

  const ask = (q: string) => {
    void send(q);
    textareaRef.current?.focus();
  };

  // Home's "Continue in chat" arrives as /ask?q=…: ask it once, then drop it from the address.
  // Started a tick later so a mount React undoes at once (dev mode) sends nothing.
  useEffect(() => {
    const q = params.get('q');
    if (!q) return;
    const start = setTimeout(() => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.delete('q');
        return next;
      }, { replace: true });
      void send(q);
    }, 0);
    return () => clearTimeout(start);
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeContext = (next: ChatContext) => {
    const day = next.date ? weekdayOfDate(next.date) : null;
    setContext(day === null ? next : { ...next, weekday: day });
  };

  const busy = pending !== null;
  const domains = directory?.ok ? directory.value.domains : [];
  const chatOff = directory?.ok && !directory.value.chatAvailable;
  const unreachable = directory && !directory.ok && directory.error.kind === 'unreachable';

  return (
    <Page wide>
      <PageHeader
        title="Ask Flowcast"
        description="Ask about crowds, dining, events and getting around campus. Answers come from the simulation and published BU data, and say which is which."
        actions={
          <Button variant="secondary" icon={<Eraser aria-hidden />} onClick={clear} disabled={!messages.length && !busy}>
            Clear conversation
          </Button>
        }
      />

      {chatOff && (
        <div className={styles.banner} role="note">
          <strong>Answers need the Ask server’s OpenAI key.</strong>
          <span>The directory still works, and questions about your own schedule are answered on this device.</span>
        </div>
      )}
      {unreachable && (
        <div className={styles.banner} role="note">
          <strong>The Ask server isn’t running.</strong>
          <StartServerHint />
        </div>
      )}

      <div className={styles.layout}>
        <section className={styles.chat} aria-label="Conversation">
          <ContextControls context={context} onChange={changeContext} onNow={() => setContext(nowContext(context.campus))} />

          {messages.length === 0 && !busy ? (
            <div className={styles.intro}>
              <h2 className={styles.introTitle}>Ask about campus in your own words</h2>
              <p className={styles.introBody}>
                Flowcast answers with charts and tables from its tools and names every source. Crowd figures are simulated projections, not live counts.
                Questions about your own schedule stay on this device.
              </p>
              {domains.some((d) => d.examples.length) ? (
                <div className={styles.examples}>
                  {domains.filter((d) => d.examples.length).map((d) => (
                    <div key={d.id} className={styles.exampleGroup}>
                      <h3 className={styles.groupTitle}>{d.title}</h3>
                      <QuestionChips questions={d.examples} onAsk={ask} label={`Example questions about ${d.title}`} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.examples}>
                  <div className={styles.exampleGroup}>
                    <h3 className={styles.groupTitle}>Try asking</h3>
                    <QuestionChips questions={FALLBACK_EXAMPLES} onAsk={ask} label="Example questions" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <ol ref={listRef} className={styles.list} aria-label="Messages">
              {messages.map((m) => (
                <MessageItem key={m.id} message={m} onRetry={retry} busy={busy} />
              ))}
              {pending && <PendingItem status={pending} />}
            </ol>
          )}

          <div className={styles.dock}>
            <Composer value={draft} onChange={setDraft} onSend={() => void send(draft)} onStop={stop} busy={busy} textareaRef={textareaRef} />
          </div>
          <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        </section>

        <aside className={styles.aside} aria-label="Directory">
          <Directory result={directory} loading={directoryLoading} onAsk={ask} onReload={loadDirectory} busy={busy} />
        </aside>
      </div>
    </Page>
  );
}
