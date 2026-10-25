import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Map as MapIcon, RotateCcw, Square } from 'lucide-react';
import { crowdFor } from '@theme/tokens';
import type { ChatResponse } from '@map/chatContract';
import { Button, Tag } from '../../ui';
import { parseMarkdown } from '../../lib/chatMarkdown';
import { CAMPUSES, MAX_QUESTION_CHARS, WEEKDAYS, type ChatContext, type ChatMessage } from '../../lib/chatHistory';
import type { ChatError } from '../../lib/chatParse';
import { VisualCard } from './Visuals';
import styles from './Chat.module.css';

/** The answer's markdown subset as React text nodes: nothing in it can become HTML. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className={styles.markdown}>
      {parseMarkdown(source).map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i}>{block.spans.map((s, j) => (s.bold ? <strong key={j}>{s.text}</strong> : <span key={j}>{s.text}</span>))}</p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item.map((s, k) => (s.bold ? <strong key={k}>{s.text}</strong> : <span key={k}>{s.text}</span>))}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** Tappable question chips (follow-ups, directory examples). */
export function QuestionChips({ questions, onAsk, label, disabled }: { questions: string[]; onAsk: (q: string) => void; label: string; disabled?: boolean }) {
  if (!questions.length) return null;
  return (
    <ul className={styles.chips} aria-label={label}>
      {questions.map((q) => (
        <li key={q}>
          <button type="button" className={styles.chip} onClick={() => onAsk(q)} disabled={disabled}>
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}

function errorText(error: ChatError): ReactNode {
  switch (error.kind) {
    case 'notConfigured':
      return 'Chat is unavailable right now. Please try again later.';
    case 'network':
      return 'Couldn’t connect. Please try again.';
    case 'warming':
      return 'The simulation for that day is still being built. Try again in a moment.';
    case 'rateLimited':
      return `${error.message}${error.retryAfter ? ` (about ${error.retryAfter} s)` : ''}`;
    case 'aborted':
      return 'Stopped. Nothing was answered.';
    default:
      return error.message;
  }
}

function AnswerBody({ response }: { response: ChatResponse }) {
  return (
    <>
      <Markdown source={response.answer} />
      {response.visuals.length > 0 && (
        <div className={styles.visuals}>
          {response.visuals.map((v) => (
            <VisualCard key={v.id} visual={v} />
          ))}
        </div>
      )}
      {response.mapLink && (
        <div className={styles.actions}>
          <Button variant="secondary" size="md" href={response.mapLink} icon={<MapIcon aria-hidden />}>
            Open on the map
          </Button>
        </div>
      )}
    </>
  );
}

/** One message in the conversation. */
export function MessageItem({ message, onRetry, busy }: { message: ChatMessage; onRetry: (id: string) => void; busy: boolean }) {
  if (message.role === 'user') {
    return (
      <li className={`${styles.message} ${styles.user}`} data-message-id={message.id}>
        <span className="visually-hidden">You asked: </span>
        <p className={styles.userBubble}>{message.text}</p>
      </li>
    );
  }
  return (
    <li className={`${styles.message} ${styles.assistant}`} data-message-id={message.id}>
      <span className="visually-hidden">Flowcast: </span>
      <div className={`${styles.assistantBubble} ${message.status === 'error' ? styles.errorBubble : ''}`}>
        {message.status === 'answer' && <AnswerBody response={message.response} />}
        {message.status === 'device' && (
          <>
            <p className={styles.deviceText}>{message.text}</p>
            {message.rows.length > 0 && (
              <ul className={styles.deviceRows}>
                {message.rows.map((r) => (
                  <li key={r.id}>
                    {r.share !== undefined && (
                      <i className={styles.crowdDot} style={{ background: r.share === null ? 'var(--color-off)' : crowdFor(r.share).color }} aria-hidden />
                    )}
                    <span className={styles.rowTitle}>{r.title}</span>
                    <span className={styles.rowDetail}>{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.meta}>{message.note}</p>
          </>
        )}
        {message.status === 'error' && (
          <div className={styles.error}>
            <p>{errorText(message.error)}</p>
            <Button variant="secondary" size="sm" icon={<RotateCcw aria-hidden />} onClick={() => onRetry(message.id)} disabled={busy}>
              Ask again
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** The thinking state while an answer is on its way. */
export function PendingItem({ status }: { status: string }) {
  return (
    <li className={`${styles.message} ${styles.assistant}`} aria-hidden>
      <div className={`${styles.assistantBubble} ${styles.pending}`}>
        <span className={styles.dots}>
          <i />
          <i />
          <i />
        </span>
        {status}
      </div>
    </li>
  );
}

/** Question box: Enter sends, Shift+Enter starts a new line, 300 characters at most. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  const left = MAX_QUESTION_CHARS - value.length;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && value.trim()) onSend();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && value.trim()) onSend();
    }
  };
  return (
    <form className={styles.composer} onSubmit={submit}>
      <label htmlFor={id} className="visually-hidden">
        Ask Flowcast a question
      </label>
      <textarea
        ref={textareaRef}
        id={id}
        className={styles.input}
        value={value}
        maxLength={MAX_QUESTION_CHARS}
        rows={1}
        placeholder="Ask about crowds, dining, events, transit…"
        aria-describedby={`${id}-count ${id}-hint`}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_QUESTION_CHARS))}
        onKeyDown={onKey}
      />
      <div className={styles.composerFoot}>
        <span id={`${id}-hint`} className={styles.hint}>
          Enter to send, Shift+Enter for a new line
        </span>
        <span id={`${id}-count`} className={`${styles.count} ${left <= 20 ? styles.countLow : ''}`} aria-live={left <= 20 ? 'polite' : 'off'}>
          {value.length}/{MAX_QUESTION_CHARS}
          <span className="visually-hidden"> characters</span>
        </span>
        {busy ? (
          <button type="button" className={styles.send} onClick={onStop} aria-label="Stop answering">
            <Square aria-hidden />
          </button>
        ) : (
          <button type="submit" className={styles.send} disabled={!value.trim()} aria-label="Send question">
            <ArrowUp aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
}

/** Day, time, campus and optional event date sent with every question. */
export function ContextControls({ context, onChange, onNow }: { context: ChatContext; onChange: (c: ChatContext) => void; onNow: () => void }) {
  const ids = { day: useId(), time: useId(), campus: useId(), date: useId() };
  const dateRef = useRef<HTMLInputElement>(null);
  return (
    <fieldset className={styles.context}>
      <legend className="visually-hidden">Question context</legend>
      <div className={styles.ctxField}>
        <label htmlFor={ids.day}>Day</label>
        <select id={ids.day} value={context.weekday} disabled={context.date !== null} onChange={(e) => onChange({ ...context, weekday: Number(e.target.value) })}>
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.ctxField}>
        <label htmlFor={ids.time}>Time</label>
        <input id={ids.time} type="time" value={context.time} step={300} onChange={(e) => e.target.value && onChange({ ...context, time: e.target.value })} />
      </div>
      <div className={styles.ctxField}>
        <label htmlFor={ids.campus}>Campus</label>
        <select id={ids.campus} value={context.campus} onChange={(e) => onChange({ ...context, campus: e.target.value as ChatContext['campus'] })}>
          {CAMPUSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.ctxField}>
        <label htmlFor={ids.date}>Event date <span className={styles.optional}>(optional)</span></label>
        <span className={styles.dateRow}>
          <input ref={dateRef} id={ids.date} type="date" value={context.date ?? ''} onChange={(e) => onChange({ ...context, date: e.target.value || null })} />
          {context.date && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                onChange({ ...context, date: null });
                dateRef.current?.focus();
              }}
            >
              Clear<span className="visually-hidden"> event date</span>
            </button>
          )}
        </span>
      </div>
      <button type="button" className={styles.linkButton} onClick={onNow}>
        Now in Boston
      </button>
    </fieldset>
  );
}
